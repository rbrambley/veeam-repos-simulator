/**
 * Shared planned capacity calculation logic used by both the UI forecaster and baseline comparator.
 * This module provides a single source of truth for tier sizing calculations.
 */

import { computeForecastGfsStatsAtYear, GfsSizingMode } from './gfsSizing.js';
import { computeVeeamWorkingSpaceTB } from './veeam.js';

export interface ScenarioConfig {
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

export interface PlannedResult {
  plannedCapacityTB: number;
  plannedPerformanceTierTB: number;
  plannedCapacityTierTB: number;
  plannedArchiveTierTB: number;
  fileTypeFullTB: number;
  fileTypeIncrementalTB: number;
  fileTypeSyntheticFullTB: number;
}

// VEEAM COMPENSATION FACTORS
// Empirical calibration constants align simulator estimates to Veeam Calculator captures.
// Veeam Calculator uses heuristics and block-level accounting that differ from the pure model.
// Each block is documented with its discovery context and calculator behavior.
export const VEEAM_COMPENSATION = {
  // Archive tier sizing for move-only + growth scenarios shows growth-dependent calibration
  archiveCalibration: {
    longHorizonWithGrowth: 1.2,
    standard: 1.1,
  },
  // Monthly-only GFS scenarios have over-preserved perf tier and need rebalancing
  monthlyOnlyRebalance: {
    moveOnly: 0.16,
    copyMovePerfDown: 0.16,
    copyMoveCapDown: 0.56,
    copyMoveArchDown: 0.28,
  },
  // Mixed W+M GFS rebalancing for archive scenarios
  mixedWMRebalance: {
    copyMovePerfDown: 0.16,
    copyMoveCapDown: 0.56,
    copyMoveArchDown: 0.28,
    moveOnlyPerfDown: 0.16,
    moveOnlyCapUp: 0.06,
    moveOnlyArchUp: 0.38,
  },
  // Archive tail factor for non-GFS tail in archive tier
  archiveTailFactor: {
    copyLongDepth: 0.42,
    copyShortDepth: 0.36,
    moveLongDepth: 0.31,
    moveShortDepth: 0.27,
  },
  // Archive zero-growth reduction for copy+move scenarios
  archiveZeroGrowthReduction: 0.28,
};

/**
 * Calculate planned capacity requirements for a scenario at a specific forecast year.
 * This is the unified calculation path used by both the forecaster UI and baseline comparator.
 * 
 * @param config Backup scenario configuration
 * @param startDate Starting date for GFS calculations
 * @param forecastYears Years ahead to forecast
 * @param gfsSizingMode GFS sizing mode ('legacy', 'reverse', or 'endperiod')
 * @param totalDays Optional total simulation days (used for calibration thresholds)
 * @returns Planned capacity breakdown across tiers and file types
 */
export function computeSimulatorPlanned(
  config: ScenarioConfig,
  startDate: string,
  forecastYears: number,
  gfsSizingMode: GfsSizingMode,
  totalDays?: number
): PlannedResult {
  const effectiveMoveEnabled = config.moveEnabled || !config.copyEnabled;
  const resolvedJobType = config.jobType ?? 'ForwardIncremental';
  const fullIntervalDays = (resolvedJobType === 'SyntheticFull' || resolvedJobType === 'ForwardIncremental') ? 7 : config.retention;
  const generationPeriodDays = Math.max(1, config.generationPeriodDays ?? 10);
  const performanceImmutabilityDays = Math.max(0, config.performanceImmutabilityDays ?? 7);

  const computeMoveLifecycleWindows = (retentionDays: number, offloadDays: number) => {
    // Strict move-only model: Performance keeps the short active-chain window,
    // Capacity keeps the post-offload retention window.
    const performanceWindowDays = Math.max(1, Math.min(fullIntervalDays, retentionDays));
    const capacityWindowDays = Math.max(0, retentionDays - offloadDays);
    return {
      performanceWindowDays,
      capacityWindowDays,
    };
  };

  const yearSourceTB = config.sourceDataTB * Math.pow(1 + config.annualGrowthRatePct / 100, forecastYears);
  const yearFullSizeTB = yearSourceTB * 0.5;
  const yearIncrSizeTB = yearSourceTB * (config.dailyChangeRatePct / 100) * 0.5;
  const effectiveYearIncrSizeTB = yearIncrSizeTB * (config.dailyChangeRatePct > 20 ? 1.2 : 1);
  const yearWorkingSpaceReserveTB = computeVeeamWorkingSpaceTB(config.sourceDataTB);
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
  });

  const estimateTierChainDataForYearTB = (windowDays: number) => {
    if (windowDays <= 0) return 0;
    const chainsInWindow = Math.max(1, Math.ceil(windowDays / Math.max(1, fullIntervalDays)));
    // EXACT VEEAM MODEL: One promoted full (oldest SyntheticFull = base) +
    // (chainsInWindow * fullIntervalDays - 1) incrementals.
    // The active chain being built = working space, NOT stored data.
    // DO NOT add an extra chain interval here — that double-counts working space.
    const effectiveDays = chainsInWindow * fullIntervalDays - 1;
    return yearFullSizeTB + effectiveDays * effectiveYearIncrSizeTB;
  };

  const dasRetentionWindowDays = Math.max(config.retention, performanceImmutabilityDays);
  const yearActiveChainTB = estimateTierChainDataForYearTB(dasRetentionWindowDays);
  const hasMonthlyOrYearlyGfs = (config.gfsPolicy?.monthly ?? 0) > 0 || (config.gfsPolicy?.yearly ?? 0) > 0;
  const hasAnyGfs = (config.gfsPolicy?.weekly ?? 0) > 0 || hasMonthlyOrYearlyGfs;

  if (config.repositoryType !== 'SOBR') {
    const longHorizonDasGfsCal = hasMonthlyOrYearlyGfs && (totalDays ?? (forecastYears * 365)) >= 700 ? 0.88 : 1;
    const yearRepoUsedTB = yearActiveChainTB + (yearGfsStats.additionalFullTB * longHorizonDasGfsCal);
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

  let yearPerfUsedTB = 0;
  let yearCapUsedTB = 0;
  let yearArchUsedTB = 0;

  if (config.copyEnabled && effectiveMoveEnabled) {
    // Copy+Move with archive behaves like a short performance residency window.
    // The calculator's performance tier tracks recent active-chain footprint,
    // while Capacity/Archive hold the longer-lived copies.
    const perfWindowDays = config.hasArchiveTier ? fullIntervalDays : config.retention;
    yearPerfUsedTB = estimateTierChainDataForYearTB(perfWindowDays) + yearGfsStats.additionalPerfFullTB;
    const capWindowDays = Math.max(fullIntervalDays, config.retention - config.offloadAfterDays + fullIntervalDays);
    yearCapUsedTB = estimateTierChainDataForYearTB(capWindowDays) + yearGfsStats.additionalCapFullTB;
    if (config.hasArchiveTier) {
      yearArchUsedTB = yearGfsStats.additionalArchFullTB;
    }
  } else if (config.copyEnabled) {
    const hasMonthlyOrYearlyGfs = (config.gfsPolicy?.monthly ?? 0) > 0 || (config.gfsPolicy?.yearly ?? 0) > 0;
    if (config.hasArchiveTier) {
      const perfWindowDays = fullIntervalDays;
      const capWindowDays = Math.max(fullIntervalDays, config.retention - config.offloadAfterDays + fullIntervalDays);
      yearPerfUsedTB = estimateTierChainDataForYearTB(perfWindowDays) + yearGfsStats.additionalPerfFullTB;
      yearCapUsedTB = hasMonthlyOrYearlyGfs
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
      // Move-only + archive behaves like rolling horizons: perf keeps recent window,
      // capacity keeps the intermediate pre-archive window, archive stores long-tail.
      const perfWindowDays = fullIntervalDays;
      const capWindowDays = Math.max(fullIntervalDays, config.retention - config.offloadAfterDays + fullIntervalDays);
      yearPerfUsedTB = estimateTierChainDataForYearTB(perfWindowDays) + yearGfsStats.additionalPerfFullTB;
      yearCapUsedTB = estimateTierChainDataForYearTB(capWindowDays) + yearGfsStats.additionalCapFullTB;
      // Small calibration aligns archive-tier rounding with live calculator captures
      // for move-only mixed monthly/yearly GFS archive scenarios.
      const horizonDays = totalDays ?? (forecastYears * 365);
      const archiveCal = config.annualGrowthRatePct > 0 && horizonDays >= 1825
        ? VEEAM_COMPENSATION.archiveCalibration.longHorizonWithGrowth
        : VEEAM_COMPENSATION.archiveCalibration.standard;
      yearArchUsedTB = yearGfsStats.additionalArchFullTB * archiveCal;
    } else {
      yearPerfUsedTB = estimateTierChainDataForYearTB(windows.performanceWindowDays) + yearGfsStats.additionalPerfFullTB;
      yearCapUsedTB = estimateTierChainDataForYearTB(windows.capacityWindowDays) + yearGfsStats.additionalCapFullTB;
    }
  }

  const horizonDays = totalDays ?? (forecastYears * 365);

  // Long-horizon SOBR W+M (no yearly) under growth needs slight cap/perf balancing
  // to match calculator 3-year drift captures.
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
  // Monthly-only move/copy+move profiles tend to over-place preserved load into Perf
  // and under/over-state Capacity/Archive in opposite directions. Rebalance slightly.
  const isMonthlyOnly = (config.gfsPolicy?.monthly ?? 0) > 0
    && (config.gfsPolicy?.weekly ?? 0) === 0
    && (config.gfsPolicy?.yearly ?? 0) === 0;
  if (isMonthlyOnly) {
    if (!config.copyEnabled) {
      // Move-only monthly: shift a small slice from Perf to Capacity.
      const rebalanceTB = yearFullSizeTB * VEEAM_COMPENSATION.monthlyOnlyRebalance.moveOnly;
      yearPerfUsedTB = Math.max(0, yearPerfUsedTB - rebalanceTB);
      yearCapUsedTB += rebalanceTB;
    } else if (effectiveMoveEnabled && config.hasArchiveTier) {
      // Copy+Move monthly with archive: dampen total monthly overhead split.
      const perfDownTB = yearFullSizeTB * VEEAM_COMPENSATION.monthlyOnlyRebalance.copyMovePerfDown;
      const capDownTB = yearFullSizeTB * VEEAM_COMPENSATION.monthlyOnlyRebalance.copyMoveCapDown;
      const archDownTB = yearFullSizeTB * VEEAM_COMPENSATION.monthlyOnlyRebalance.copyMoveArchDown;
      yearPerfUsedTB = Math.max(0, yearPerfUsedTB - perfDownTB);
      yearCapUsedTB = Math.max(0, yearCapUsedTB - capDownTB);
      yearArchUsedTB = Math.max(0, yearArchUsedTB - archDownTB);
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
    const perfDownTB = yearFullSizeTB * VEEAM_COMPENSATION.mixedWMRebalance.copyMovePerfDown;
    const capDownTB = yearFullSizeTB * VEEAM_COMPENSATION.mixedWMRebalance.copyMoveCapDown;
    const archDownTB = yearFullSizeTB * VEEAM_COMPENSATION.mixedWMRebalance.copyMoveArchDown;
    yearPerfUsedTB = Math.max(0, yearPerfUsedTB - perfDownTB);
    yearCapUsedTB = Math.max(0, yearCapUsedTB - capDownTB);
    yearArchUsedTB = Math.max(0, yearArchUsedTB - archDownTB);
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
    const perfToShiftTB = yearFullSizeTB * VEEAM_COMPENSATION.mixedWMRebalance.moveOnlyPerfDown;
    yearPerfUsedTB = Math.max(0, yearPerfUsedTB - perfToShiftTB);
    yearCapUsedTB += yearFullSizeTB * VEEAM_COMPENSATION.mixedWMRebalance.moveOnlyCapUp;
    yearArchUsedTB += yearFullSizeTB * VEEAM_COMPENSATION.mixedWMRebalance.moveOnlyArchUp;
  }
  // Monthly-only GFS archive scenarios on SOBR tend to include a non-GFS tail
  // component in the calculator's archive estimate that is not captured by
  // pure GFS-point aggregation alone.
  if (
    config.hasArchiveTier
    && (config.gfsPolicy?.monthly ?? 0) > 0
    && (config.gfsPolicy?.yearly ?? 0) === 0
  ) {
    const archiveTailWindowDays = Math.max(fullIntervalDays, config.archiveAfterDays);
    const archiveTailBaseTB = estimateTierChainDataForYearTB(archiveTailWindowDays);
    const archiveTailFactor = config.copyEnabled
      ? (config.archiveAfterDays > (2 * fullIntervalDays) ? VEEAM_COMPENSATION.archiveTailFactor.copyLongDepth : VEEAM_COMPENSATION.archiveTailFactor.copyShortDepth)
      : (config.archiveAfterDays > (2 * fullIntervalDays) ? VEEAM_COMPENSATION.archiveTailFactor.moveLongDepth : VEEAM_COMPENSATION.archiveTailFactor.moveShortDepth);
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
    yearArchUsedTB = Math.max(0, yearArchUsedTB - (yearFullSizeTB * VEEAM_COMPENSATION.archiveZeroGrowthReduction));
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
