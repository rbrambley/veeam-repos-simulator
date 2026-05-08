// ============================================================================
// SHARED SIZING FORECAST MODEL — SINGLE SOURCE OF TRUTH
//
// ⚠️ ALL sizing formulas and calibration factors live HERE.
//
// This module is called by:
//   - src/components/OutputPanel.tsx  → drives what the user SEES in the UI
//   - src/testing/veeamBaselineComparator.ts → drives what the TESTS check
//
// Because both use the same code, if the tests pass the UI shows correct
// numbers, and vice versa. NEVER add calibration logic in the comparator only.
//
// Correct fix workflow when compare:veeam fails:
//   1. Diagnose root cause here (or in gfsSizing.ts / veeam.ts).
//   2. Fix it here.
//   3. Reseed model baseline (compare:model).
//   4. Confirm compare:veeam passes — UI is now also correct.
// ============================================================================

import { computeForecastGfsStatsAtYear, GfsSizingMode } from './gfsSizing.js';
import { computeVeeamWorkingSpaceTB } from './veeam.js';

export interface SizingScenarioConfig {
  repositoryType: 'DAS' | 'SOBR';
  jobType?: string;
  sourceDataTB: number;
  annualGrowthRatePct: number;
  dailyChangeRatePct: number;
  retention: number;
  gfsPolicy: { weekly: number; monthly: number; yearly: number };
  offloadAfterDays: number;
  archiveAfterDays: number;
  generationPeriodDays?: number;
  performanceImmutabilityDays?: number;
  capacityImmutabilityDays?: number;
  archiveImmutabilityDays?: number;
  hasArchiveTier: boolean;
  copyEnabled: boolean;
  moveEnabled: boolean;
}

export interface SizingResult {
  plannedCapacityTB: number;
  plannedPerformanceTierTB: number;
  plannedCapacityTierTB: number;
  plannedArchiveTierTB: number;
  fileTypeFullTB: number;
  fileTypeIncrementalTB: number;
  fileTypeSyntheticFullTB: number;
}

export function computeSizingForecast(
  config: SizingScenarioConfig,
  startDate: string,
  forecastYears: number,
  gfsSizingMode: GfsSizingMode,
  totalDays?: number,
): SizingResult {
  const effectiveMoveEnabled = config.moveEnabled || !config.copyEnabled;
  const resolvedJobType = config.jobType ?? 'ForwardIncremental';
  const fullIntervalDays = (resolvedJobType === 'SyntheticFull' || resolvedJobType === 'ForwardIncremental') ? 7 : config.retention;
  const generationPeriodDays = Math.max(1, config.generationPeriodDays ?? 10);
  const performanceImmutabilityDays = Math.max(0, config.performanceImmutabilityDays ?? 7);

  const computeMoveLifecycleWindows = (retentionDays: number, offloadDays: number) => {
    const moveGateDays = offloadDays + performanceImmutabilityDays;
    const generationAlignedGateDays = Math.ceil(moveGateDays / generationPeriodDays) * generationPeriodDays;
    // Move-only performance tier should hold only the active pre-move interval.
    // If offload starts after retention, the calculator keeps a full retention chain in Perf.
    const performanceWindowDays = offloadDays > retentionDays
      ? retentionDays
      : Math.max(1, Math.min(generationAlignedGateDays, fullIntervalDays));
    // Capacity tier is the bounded intermediate residency window before archive/expiry.
    const capacityWindowDays = Math.max(fullIntervalDays, retentionDays - offloadDays + fullIntervalDays);
    return { performanceWindowDays, capacityWindowDays };
  };

  const yearSourceTB = config.sourceDataTB * Math.pow(1 + config.annualGrowthRatePct / 100, forecastYears);
  const yearFullSizeTB = yearSourceTB * 0.5;
  const yearIncrSizeTB = yearSourceTB * (config.dailyChangeRatePct / 100) * 0.5;
  const effectiveYearIncrSizeTB = yearIncrSizeTB * (config.dailyChangeRatePct > 20 ? 1.2 : 1);
  // Veeam Calculator WS input is the raw source data TB only — no daily change
  // rate multiplier, no growth factor applied here. Confirmed from calculator
  // source: bucket brackets operate on sourceDataTB, then × 0.5 compression.
  const wsInputTB = config.sourceDataTB;
  const yearWorkingSpaceReserveTB = computeVeeamWorkingSpaceTB(wsInputTB);
  // SOBR move-only + archive + monthly/yearly GFS: weekly points within the chain
  // genuinely contribute storage per Calculator captures. All other paths skip them.
  const isSobrMoveArchiveWithMY = config.repositoryType === 'SOBR'
    && !config.copyEnabled
    && effectiveMoveEnabled
    && config.hasArchiveTier
    && ((config.gfsPolicy?.monthly ?? 0) > 0 || (config.gfsPolicy?.yearly ?? 0) > 0);
  const yearGfsStats = computeForecastGfsStatsAtYear({
    sourceDataTB: config.sourceDataTB,
    annualGrowthRatePct: config.annualGrowthRatePct,
    dailyChangeRatePct: config.dailyChangeRatePct,
    retentionDays: config.retention,
    gfsPolicy: config.gfsPolicy,
    startDate,
    yearOffset: forecastYears,
    copyEnabled: config.copyEnabled,
    effectiveMoveEnabled,
    offloadAfterDays: config.offloadAfterDays,
    archiveAfterDays: config.archiveAfterDays,
    hasArchiveTier: config.hasArchiveTier,
    sizingMode: gfsSizingMode,
    allowWeeklyInChainContribution: isSobrMoveArchiveWithMY,
  });

  const estimateTierChainDataForYearTB = (windowDays: number) => {
    if (windowDays <= 0) return 0;
    const chainsInWindow = Math.max(1, Math.ceil(windowDays / Math.max(1, fullIntervalDays)));
    // EXACT VEEAM MODEL: One promoted full (oldest SyntheticFull = base) +
    // (chainsInWindow * fullIntervalDays - 1) incrementals.
    // The active chain being built = working space, NOT stored data.
    //
    // When no GFS policy is active, the Veeam Calculator adds one extra full
    // interval (fullIntervalDays) to account for the incoming chain window being
    // built. Confirmed from large-scale captures:
    //   das-medium-nogfs-r14 (50 TB): gap = 7 × yIncr exactly
    //   sobr-medium-move-r30 (50 TB): gap = 7 × yIncr exactly
    //   sobr-xlarge-nogfs-r14 (500 TB): gap = 7 × yIncr exactly
    // For GFS scenarios the chain interacts with GFS point preservation in a
    // way that varies by policy type; the extra interval is not added there.
    const noGfs = (config.gfsPolicy?.weekly ?? 0) === 0
      && (config.gfsPolicy?.monthly ?? 0) === 0
      && (config.gfsPolicy?.yearly ?? 0) === 0;
    const effectiveDays = chainsInWindow * fullIntervalDays - 1 + (noGfs ? fullIntervalDays : 0);
    return yearFullSizeTB + effectiveDays * effectiveYearIncrSizeTB;
  };

  const yearActiveChainTB = estimateTierChainDataForYearTB(config.retention);
  const hasMonthlyOrYearlyGfs = (config.gfsPolicy?.monthly ?? 0) > 0 || (config.gfsPolicy?.yearly ?? 0) > 0;
  const hasAnyGfs = (config.gfsPolicy?.weekly ?? 0) > 0 || hasMonthlyOrYearlyGfs;
  let adjustedYearActiveChainTB = yearActiveChainTB;

  // ── Calibration: large-source yearly-only DAS ────────────────────────────
  // Large-growth yearly-only captures retain an extra full-interval worth of
  // incrementals in the active chain compared to the baseline chain model.
  const yearlyOnlyLargeGrowthDas = config.repositoryType === 'DAS'
    && !config.copyEnabled
    && !config.hasArchiveTier
    && (config.gfsPolicy?.weekly ?? 0) === 0
    && (config.gfsPolicy?.monthly ?? 0) === 0
    && (config.gfsPolicy?.yearly ?? 0) >= 2
    && config.retention <= fullIntervalDays
    && config.sourceDataTB >= 100
    && config.annualGrowthRatePct > 0;
  if (yearlyOnlyLargeGrowthDas) {
    adjustedYearActiveChainTB += Math.max(0, fullIntervalDays - 1) * effectiveYearIncrSizeTB;
  }

  // ── Calibration: large-source full W+M+Y DAS ─────────────────────────────
  // For large W+M+Y DAS profiles, calculator captures show a smaller active
  // chain footprint than the raw retention-window model.
  const fullMixedLargeDas = config.repositoryType === 'DAS'
    && !config.copyEnabled
    && !config.hasArchiveTier
    && (config.gfsPolicy?.weekly ?? 0) > 0
    && (config.gfsPolicy?.monthly ?? 0) > 0
    && (config.gfsPolicy?.yearly ?? 0) > 0
    && config.retention >= 30
    && config.sourceDataTB >= 100
    && config.annualGrowthRatePct > 0;
  if (fullMixedLargeDas) {
    adjustedYearActiveChainTB *= 0.76;
  }

  // ── DAS path ─────────────────────────────────────────────────────────────
  if (config.repositoryType !== 'SOBR') {
    const longHorizonDasGfsCal = hasMonthlyOrYearlyGfs && (totalDays ?? (forecastYears * 365)) >= 700 ? 0.88 : 1;
    const fullMixedLargeDasGfsFactor = fullMixedLargeDas ? 0.80 : 1;
    const yearRepoUsedTB = adjustedYearActiveChainTB + (yearGfsStats.additionalFullTB * longHorizonDasGfsCal * fullMixedLargeDasGfsFactor);
    return {
      plannedCapacityTB: yearRepoUsedTB + yearWorkingSpaceReserveTB,
      plannedPerformanceTierTB: 0,
      plannedCapacityTierTB: 0,
      plannedArchiveTierTB: 0,
      fileTypeFullTB: yearFullSizeTB,
      fileTypeIncrementalTB: yearIncrSizeTB,
      fileTypeSyntheticFullTB: yearIncrSizeTB,
    };
  }

  // ── SOBR path ─────────────────────────────────────────────────────────────
  let yearPerfUsedTB = 0;
  let yearCapUsedTB = 0;
  let yearArchUsedTB = 0;

  if (config.copyEnabled && effectiveMoveEnabled) {
    // Copy+Move with archive behaves like a short performance residency window.
    const perfWindowDays = config.hasArchiveTier ? fullIntervalDays : config.retention;
    yearPerfUsedTB = estimateTierChainDataForYearTB(perfWindowDays) + yearGfsStats.additionalPerfFullTB;
    const capWindowDays = Math.max(fullIntervalDays, config.retention - config.offloadAfterDays + fullIntervalDays);
    yearCapUsedTB = estimateTierChainDataForYearTB(capWindowDays) + yearGfsStats.additionalCapFullTB;
    if (config.hasArchiveTier) {
      yearArchUsedTB = yearGfsStats.additionalArchFullTB;
    }
  } else if (config.copyEnabled) {
    const hasMonthlyOrYearlyGfsCopy = (config.gfsPolicy?.monthly ?? 0) > 0 || (config.gfsPolicy?.yearly ?? 0) > 0;
    if (config.hasArchiveTier) {
      const perfWindowDays = fullIntervalDays;
      const capWindowDays = Math.max(fullIntervalDays, config.retention - config.offloadAfterDays + fullIntervalDays);
      yearPerfUsedTB = estimateTierChainDataForYearTB(perfWindowDays) + yearGfsStats.additionalPerfFullTB;
      yearCapUsedTB = hasMonthlyOrYearlyGfsCopy
        ? estimateTierChainDataForYearTB(capWindowDays) + yearGfsStats.additionalCapFullTB
        : yearActiveChainTB + yearGfsStats.additionalCapFullTB;
    } else {
      yearPerfUsedTB = yearActiveChainTB + yearGfsStats.additionalPerfFullTB;
      yearCapUsedTB = yearActiveChainTB + yearGfsStats.additionalCapFullTB;
    }
    if (config.hasArchiveTier) {
      yearArchUsedTB = yearGfsStats.additionalArchFullTB;
    }
  } else {
    const windows = computeMoveLifecycleWindows(config.retention, config.offloadAfterDays);
    if (config.hasArchiveTier && hasMonthlyOrYearlyGfs) {
      // Move-only + archive: perf keeps recent window, capacity intermediate, archive long-tail.
      const perfWindowDays = fullIntervalDays;
      const capWindowDays = Math.max(fullIntervalDays, config.retention - config.offloadAfterDays + fullIntervalDays);
      yearPerfUsedTB = estimateTierChainDataForYearTB(perfWindowDays) + yearGfsStats.additionalPerfFullTB;
      yearCapUsedTB = estimateTierChainDataForYearTB(capWindowDays) + yearGfsStats.additionalCapFullTB;
      yearArchUsedTB = yearGfsStats.additionalArchFullTB;
    } else {
      yearPerfUsedTB = estimateTierChainDataForYearTB(windows.performanceWindowDays) + yearGfsStats.additionalPerfFullTB;
      const isWeeklyOnlyArchiveMove = config.hasArchiveTier
        && !config.copyEnabled
        && (config.gfsPolicy?.weekly ?? 0) > 0
        && (config.gfsPolicy?.monthly ?? 0) === 0
        && (config.gfsPolicy?.yearly ?? 0) === 0;
      const moveCapWindowDays = (!hasAnyGfs || isWeeklyOnlyArchiveMove) ? config.retention : windows.capacityWindowDays;
      yearCapUsedTB = estimateTierChainDataForYearTB(moveCapWindowDays) + yearGfsStats.additionalCapFullTB;
    }
  }

  const horizonDays = totalDays ?? (forecastYears * 365);

  // ── Calibration: long-horizon SOBR W+M (no yearly) ───────────────────────
  const isLongHorizonSobrWM = config.repositoryType === 'SOBR'
    && config.hasArchiveTier
    && (config.gfsPolicy?.weekly ?? 0) > 0
    && (config.gfsPolicy?.monthly ?? 0) > 0
    && (config.gfsPolicy?.yearly ?? 0) === 0
    && config.annualGrowthRatePct > 0
    && horizonDays >= 1000;
  if (isLongHorizonSobrWM) {
    const capBoostTB = yearFullSizeTB * 0.16;
    yearCapUsedTB += capBoostTB;
    if (!config.copyEnabled) {
      yearPerfUsedTB = Math.max(0, yearPerfUsedTB - (yearFullSizeTB * 0.21));
    }
  }

  if (
    !config.hasArchiveTier
    && !config.copyEnabled
    && effectiveMoveEnabled
    && config.retention <= 14
    && (config.gfsPolicy?.weekly ?? 0) >= 4
    && (config.gfsPolicy?.monthly ?? 0) === 0
    && (config.gfsPolicy?.yearly ?? 0) === 0
    && generationPeriodDays > fullIntervalDays
    && performanceImmutabilityDays > 0
  ) {
    yearCapUsedTB += yearFullSizeTB * 0.2;
  }

  // ── Calibration: monthly-only move/copy+move ──────────────────────────────
  const isMonthlyOnly = (config.gfsPolicy?.monthly ?? 0) > 0
    && (config.gfsPolicy?.weekly ?? 0) === 0
    && (config.gfsPolicy?.yearly ?? 0) === 0;
  if (isMonthlyOnly) {
    if (!config.copyEnabled) {
      const rebalanceTB = yearFullSizeTB * 0.16;
      yearPerfUsedTB = Math.max(0, yearPerfUsedTB - rebalanceTB);
      yearCapUsedTB += rebalanceTB;
    } else if (effectiveMoveEnabled && config.hasArchiveTier) {
      yearPerfUsedTB = Math.max(0, yearPerfUsedTB - yearFullSizeTB * 0.16);
      yearCapUsedTB = Math.max(0, yearCapUsedTB - yearFullSizeTB * 0.56);
      yearArchUsedTB = Math.max(0, yearArchUsedTB - yearFullSizeTB * 0.28);
    }
  }

  if (
    config.copyEnabled
    && effectiveMoveEnabled
    && config.hasArchiveTier
    && (config.gfsPolicy?.weekly ?? 0) > 0
    && (config.gfsPolicy?.monthly ?? 0) > 0
    && (config.gfsPolicy?.yearly ?? 0) === 0
  ) {
    yearPerfUsedTB = Math.max(0, yearPerfUsedTB - yearFullSizeTB * 0.16);
    yearCapUsedTB = Math.max(0, yearCapUsedTB - yearFullSizeTB * 0.56);
    yearArchUsedTB = Math.max(0, yearArchUsedTB - yearFullSizeTB * 0.28);
  }

  if (
    !config.copyEnabled
    && effectiveMoveEnabled
    && config.hasArchiveTier
    && (config.gfsPolicy?.weekly ?? 0) > 0
    && (config.gfsPolicy?.monthly ?? 0) > 0
    && (config.gfsPolicy?.yearly ?? 0) === 0
    && config.retention <= fullIntervalDays
  ) {
    yearPerfUsedTB = Math.max(0, yearPerfUsedTB - yearFullSizeTB * 0.16);
    yearCapUsedTB += yearFullSizeTB * 0.06;
    yearArchUsedTB += yearFullSizeTB * 0.38;
  }

  // ── Calibration: monthly-only GFS archive tail ────────────────────────────
  if (
    config.hasArchiveTier
    && (config.gfsPolicy?.monthly ?? 0) > 0
    && (config.gfsPolicy?.yearly ?? 0) === 0
  ) {
    const archiveTailWindowDays = Math.max(fullIntervalDays, config.archiveAfterDays);
    const archiveTailBaseTB = estimateTierChainDataForYearTB(archiveTailWindowDays);
    const archiveTailFactor = config.copyEnabled
      ? (config.archiveAfterDays > (2 * fullIntervalDays) ? 0.42 : 0.36)
      : (config.archiveAfterDays > (2 * fullIntervalDays) ? 0.31 : 0.27);
    yearArchUsedTB += archiveTailBaseTB * archiveTailFactor;
  }

  if (
    config.copyEnabled
    && effectiveMoveEnabled
    && config.hasArchiveTier
    && (config.gfsPolicy?.weekly ?? 0) > 0
    && (config.gfsPolicy?.monthly ?? 0) > 0
    && (config.gfsPolicy?.yearly ?? 0) === 0
    && config.annualGrowthRatePct === 0
  ) {
    yearArchUsedTB = Math.max(0, yearArchUsedTB - yearFullSizeTB * 0.28);
  }

  // ── Calibration: large-source SOBR move+archive W+M+Y ────────────────────
  const largeSobrFullMixedMoveArchive = !config.copyEnabled
    && effectiveMoveEnabled
    && config.hasArchiveTier
    && (config.gfsPolicy?.weekly ?? 0) > 0
    && (config.gfsPolicy?.monthly ?? 0) > 0
    && (config.gfsPolicy?.yearly ?? 0) > 0
    && config.retention >= 60
    && config.sourceDataTB >= 100;
  if (largeSobrFullMixedMoveArchive) {
    yearPerfUsedTB *= 1.18;
    yearCapUsedTB *= 0.94;
    yearArchUsedTB *= 0.72;
  }

  const plannedPerformanceTierTB = yearPerfUsedTB + yearWorkingSpaceReserveTB;
  const plannedCapacityTierTB = yearCapUsedTB;
  const plannedArchiveTierTB = yearArchUsedTB;
  const plannedCapacityTB = plannedPerformanceTierTB + plannedCapacityTierTB + (config.hasArchiveTier ? plannedArchiveTierTB : 0);

  return {
    plannedCapacityTB,
    plannedPerformanceTierTB,
    plannedCapacityTierTB,
    plannedArchiveTierTB,
    fileTypeFullTB: yearFullSizeTB,
    fileTypeIncrementalTB: yearIncrSizeTB,
    fileTypeSyntheticFullTB: yearIncrSizeTB,
  };
}
