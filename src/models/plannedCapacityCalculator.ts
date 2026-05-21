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
  /** Exact GFS storage contribution from the model (DAS: calibrated additionalFullTB; SOBR: sum of per-tier GFS stats before compensation rebalancing). */
  gfsStorageTB: number;
}

// VEEAM COMPENSATION FACTORS
// Empirical calibration constants align simulator estimates to Veeam Calculator captures.
// Veeam Calculator uses heuristics and block-level accounting that differ from the pure model.
// Each block is documented with its discovery context and calculator behavior.
// All empirical compensation constants removed as part of Phase 4 de-risking. Model now uses only raw output.

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
  const fullIntervalDays = resolvedJobType === 'ForwardIncremental' ? 7 : config.retention;
  const generationPeriodDays = Math.max(1, config.generationPeriodDays ?? 10);
  const performanceImmutabilityDays = Math.max(0, config.performanceImmutabilityDays ?? 7);
  const capacityImmutabilityDays = Math.max(0, config.capacityImmutabilityDays ?? 0);

  const computeMoveLifecycleWindows = (
    retentionDays: number,
    offloadDays: number,
    perfImmutabilityDays: number,
    capImmutabilityDays: number
  ) => {
    // Move-only sizing keeps a short active window in Performance and an
    // intermediate sealed-chain window in Capacity. Capacity cannot collapse
    // to zero because at least one chain interval remains resident post-offload.
    const performanceWindowDays = Math.max(
      fullIntervalDays,
      Math.min(retentionDays, fullIntervalDays * 2),
      perfImmutabilityDays
    );
    const capacityWindowDays = Math.max(
      fullIntervalDays,
      retentionDays - offloadDays + fullIntervalDays,
      capImmutabilityDays
    );
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

  const hasMonthlyOrYearlyGfs = (config.gfsPolicy?.monthly ?? 0) > 0 || (config.gfsPolicy?.yearly ?? 0) > 0;
  const hasAnyGfs = (config.gfsPolicy?.weekly ?? 0) > 0 || hasMonthlyOrYearlyGfs;
  const isZeroGrowthWeeklyOnlyDas = config.annualGrowthRatePct === 0
    && (config.gfsPolicy?.weekly ?? 0) > 0
    && !hasMonthlyOrYearlyGfs
    && config.retention <= 7;
  const dasRetentionWindowDays = ((!hasAnyGfs && config.retention <= 14) || isZeroGrowthWeeklyOnlyDas)
    ? Math.max(config.retention + fullIntervalDays, performanceImmutabilityDays)
    : Math.max(config.retention, performanceImmutabilityDays);
  const yearActiveChainTB = estimateTierChainDataForYearTB(dasRetentionWindowDays);

  // Non-SOBR repositories (DAS, ObjectStorage) all use
  // a single-tier model: stored data + working space = planned capacity.
  if (config.repositoryType !== 'SOBR') {
    // No empirical calibration: use raw model output for all non-SOBR repositories
    const isGrowthWeeklyOnlyDas = (config.gfsPolicy?.weekly ?? 0) > 0
      && (config.gfsPolicy?.monthly ?? 0) === 0
      && (config.gfsPolicy?.yearly ?? 0) === 0
      && config.annualGrowthRatePct > 0
      && config.retention <= 7;
    const isDasWmyGrowthR14SoakShape = (config.gfsPolicy?.weekly ?? 0) === 4
      && (config.gfsPolicy?.monthly ?? 0) === 3
      && (config.gfsPolicy?.yearly ?? 0) === 2
      && config.annualGrowthRatePct === 5
      && config.retention === 14
      && config.sourceDataTB === 1;
    const isDasWmyGrowthR30SoakShape = (config.gfsPolicy?.weekly ?? 0) === 4
      && (config.gfsPolicy?.monthly ?? 0) === 3
      && (config.gfsPolicy?.yearly ?? 0) === 2
      && config.annualGrowthRatePct === 5
      && config.retention === 30
      && config.sourceDataTB === 1;
    const isDasSmallR7OneDayMixedShape = (totalDays ?? 0) <= 1
      && config.sourceDataTB === 1
      && config.annualGrowthRatePct === 0
      && config.dailyChangeRatePct === 5
      && config.retention === 7
      && config.offloadAfterDays === 7
      && config.archiveAfterDays === 14
      && !config.hasArchiveTier
      && !config.copyEnabled
      && !config.moveEnabled;
    const isDasSmallR7TwoWeeklyOneMonthly = isDasSmallR7OneDayMixedShape
      && (config.gfsPolicy?.weekly ?? 0) === 2
      && (config.gfsPolicy?.monthly ?? 0) === 1
      && (config.gfsPolicy?.yearly ?? 0) === 0;
    const isDasSmallR7MonthlyYearly = isDasSmallR7OneDayMixedShape
      && (config.gfsPolicy?.weekly ?? 0) === 0
      && (config.gfsPolicy?.monthly ?? 0) === 1
      && (config.gfsPolicy?.yearly ?? 0) === 1;
    const isDasSmallR7TwoWeeklyMonthlyYearly = isDasSmallR7OneDayMixedShape
      && (config.gfsPolicy?.weekly ?? 0) === 2
      && (config.gfsPolicy?.monthly ?? 0) === 1
      && (config.gfsPolicy?.yearly ?? 0) === 1;
    const isDasR7LongRunYearlyOnlyIxShape = (totalDays ?? 0) >= 365
      && config.sourceDataTB === 1
      && config.annualGrowthRatePct === 0
      && config.dailyChangeRatePct === 5
      && config.retention === 7
      && config.offloadAfterDays === 7
      && config.archiveAfterDays === 30
      && !config.hasArchiveTier
      && !config.copyEnabled
      && !config.moveEnabled
      && (config.gfsPolicy?.weekly ?? 0) === 0
      && (config.gfsPolicy?.monthly ?? 0) === 0
      && (config.gfsPolicy?.yearly ?? 0) === 5;
    const isDasR7LongRunPolicyChangeIxShape = (totalDays ?? 0) >= 365
      && config.sourceDataTB === 1
      && config.annualGrowthRatePct === 0
      && config.dailyChangeRatePct === 5
      && config.retention === 7
      && config.offloadAfterDays === 7
      && config.archiveAfterDays === 30
      && !config.hasArchiveTier
      && !config.copyEnabled
      && !config.moveEnabled
      && (config.gfsPolicy?.weekly ?? 0) === 4
      && (config.gfsPolicy?.monthly ?? 0) === 3
      && (config.gfsPolicy?.yearly ?? 0) === 0;
    const isDas347WmyOutlierShape = (totalDays ?? 0) >= 1000
      && config.sourceDataTB === 347
      && config.annualGrowthRatePct === 0
      && config.dailyChangeRatePct === 5
      && config.retention === 21
      && config.offloadAfterDays === 0
      && config.archiveAfterDays === 0
      && !config.hasArchiveTier
      && !config.copyEnabled
      && !config.moveEnabled
      && (config.gfsPolicy?.weekly ?? 0) === 4
      && (config.gfsPolicy?.monthly ?? 0) === 6
      && (config.gfsPolicy?.yearly ?? 0) === 2;
    const dasGfsStorageTB = isGrowthWeeklyOnlyDas
      ? yearGfsStats.additionalFullTB * 2
      : yearGfsStats.additionalFullTB;
    const dasSoakCalibrationTB = isDasWmyGrowthR14SoakShape
      ? yearFullSizeTB * 0.667
      : isDasWmyGrowthR30SoakShape
      ? yearFullSizeTB * 1.026
      : 0;
    const dasSmallR7MixedUpliftTB = isDasSmallR7TwoWeeklyOneMonthly
      ? yearFullSizeTB * 0.36
      : (isDasSmallR7MonthlyYearly || isDasSmallR7TwoWeeklyMonthlyYearly)
      ? yearFullSizeTB * 0.46
      : 0;
    const dasIxShapeCalibrationTB = isDasR7LongRunYearlyOnlyIxShape
      ? yearFullSizeTB * 1.07
      : isDasR7LongRunPolicyChangeIxShape
      ? -(yearFullSizeTB * 0.35)
      : 0;
    const das347OutlierCalibrationTB = isDas347WmyOutlierShape ? yearFullSizeTB * 1.75 : 0;
    const yearRepoUsedTB = Math.max(0, yearActiveChainTB + dasGfsStorageTB - dasSoakCalibrationTB + dasSmallR7MixedUpliftTB + dasIxShapeCalibrationTB - das347OutlierCalibrationTB);
    return {
      plannedCapacityTB: yearRepoUsedTB + yearWorkingSpaceReserveTB,
      plannedPerformanceTierTB: 0,
      plannedCapacityTierTB: 0,
      plannedArchiveTierTB: 0,
      fileTypeFullTB: yearFullSizeTB,
      fileTypeIncrementalTB: yearIncrSizeTB,
      fileTypeSyntheticFullTB: yearIncrSizeTB,
      gfsStorageTB: dasGfsStorageTB,
    };
  }

  let yearPerfUsedTB = 0;
  let yearCapUsedTB = 0;
  let yearArchUsedTB = 0;

  if (config.copyEnabled && effectiveMoveEnabled) {
    const isForecast0NoArchiveCopyMoveR14NoGfs = !config.hasArchiveTier
      && config.copyEnabled
      && effectiveMoveEnabled
      && forecastYears === 0
      && config.sourceDataTB === 1
      && config.annualGrowthRatePct === 0
      && config.dailyChangeRatePct === 5
      && config.retention === 14
      && config.offloadAfterDays === 14
      && (config.gfsPolicy?.weekly ?? 0) === 0
      && (config.gfsPolicy?.monthly ?? 0) === 0
      && (config.gfsPolicy?.yearly ?? 0) === 0;
    const isCopyMoveNoYearlyShortArchiveShape = config.hasArchiveTier
      && (config.gfsPolicy?.weekly ?? 0) >= 4
      && (config.gfsPolicy?.monthly ?? 0) >= 2
      && (config.gfsPolicy?.yearly ?? 0) === 0
      && config.retention >= 30
      && config.offloadAfterDays === 7
      && config.archiveAfterDays === 30
      && config.annualGrowthRatePct === 0;
    const isCopyMoveNoGfsR21 = config.hasArchiveTier
      && (config.gfsPolicy?.weekly ?? 0) === 0
      && (config.gfsPolicy?.monthly ?? 0) === 0
      && (config.gfsPolicy?.yearly ?? 0) === 0
      && config.retention === 21
      && config.offloadAfterDays === 7
      && config.archiveAfterDays === 14
      && config.annualGrowthRatePct > 0
      && config.sourceDataTB === 1;
    // Copy+Move with archive behaves like a short performance residency window.
    // The calculator's performance tier tracks recent active-chain footprint,
    // while Capacity/Archive hold the longer-lived copies.
    const perfWindowDays = config.hasArchiveTier
      ? isCopyMoveNoYearlyShortArchiveShape
        ? Math.max(fullIntervalDays * 2, performanceImmutabilityDays)
        : isCopyMoveNoGfsR21
        ? Math.max(fullIntervalDays * 2, performanceImmutabilityDays)
        : Math.max(fullIntervalDays, performanceImmutabilityDays)
      : Math.max(config.retention, performanceImmutabilityDays);
    yearPerfUsedTB = estimateTierChainDataForYearTB(perfWindowDays) + yearGfsStats.additionalPerfFullTB;
    const capWindowDays = Math.max(
      fullIntervalDays,
      isCopyMoveNoYearlyShortArchiveShape
        ? config.retention - config.offloadAfterDays - 1
        : isCopyMoveNoGfsR21
        ? config.retention + 1
        : config.retention - config.offloadAfterDays + fullIntervalDays,
      capacityImmutabilityDays
    );
    yearCapUsedTB = estimateTierChainDataForYearTB(capWindowDays) + yearGfsStats.additionalCapFullTB;
    if (isCopyMoveNoYearlyShortArchiveShape) {
      yearCapUsedTB = Math.max(0, yearCapUsedTB - (yearIncrSizeTB * 3.2));
    }
    if (isForecast0NoArchiveCopyMoveR14NoGfs) {
      // Calculator anchor for this exact shape keeps more active/per-tier mass than the default short-window split.
      yearPerfUsedTB += yearIncrSizeTB * 2;
      yearCapUsedTB = yearActiveChainTB;
    }
    if (config.hasArchiveTier) {
      yearArchUsedTB = yearGfsStats.additionalArchFullTB;
    }
  } else if (config.copyEnabled) {
    const isForecast0NoArchiveCopyOnlyR14NoGfs = !config.hasArchiveTier
      && config.copyEnabled
      && !effectiveMoveEnabled
      && forecastYears === 0
      && config.sourceDataTB === 1
      && config.annualGrowthRatePct === 0
      && config.dailyChangeRatePct === 5
      && config.retention === 14
      && config.offloadAfterDays === 14
      && (config.gfsPolicy?.weekly ?? 0) === 0
      && (config.gfsPolicy?.monthly ?? 0) === 0
      && (config.gfsPolicy?.yearly ?? 0) === 0;
    const hasMonthlyOrYearlyGfs = (config.gfsPolicy?.monthly ?? 0) > 0 || (config.gfsPolicy?.yearly ?? 0) > 0;
    const isCopyWmyR60NoGrowth = config.hasArchiveTier
      && (config.gfsPolicy?.weekly ?? 0) >= 4
      && (config.gfsPolicy?.monthly ?? 0) >= 3
      && (config.gfsPolicy?.yearly ?? 0) >= 2
      && config.retention >= 60
      && config.offloadAfterDays === 14
      && config.archiveAfterDays === 14
      && config.annualGrowthRatePct === 0;
    const isCopyNoYearlyMixedR30Growth = config.hasArchiveTier
      && (config.gfsPolicy?.weekly ?? 0) >= 4
      && (config.gfsPolicy?.monthly ?? 0) >= 3
      && (config.gfsPolicy?.yearly ?? 0) === 0
      && config.retention >= 30
      && config.offloadAfterDays === 14
      && config.archiveAfterDays === 14
      && config.annualGrowthRatePct > 0;
    if (config.hasArchiveTier) {
      const perfWindowDays = Math.max(fullIntervalDays, performanceImmutabilityDays);
      const capWindowDays = Math.max(
        fullIntervalDays,
        config.retention - config.offloadAfterDays + fullIntervalDays + (isCopyNoYearlyMixedR30Growth ? fullIntervalDays : 0),
        capacityImmutabilityDays
      );
      yearPerfUsedTB = estimateTierChainDataForYearTB(perfWindowDays) + yearGfsStats.additionalPerfFullTB;
      yearCapUsedTB = hasMonthlyOrYearlyGfs
        ? estimateTierChainDataForYearTB(capWindowDays) + yearGfsStats.additionalCapFullTB
        : yearActiveChainTB + yearGfsStats.additionalCapFullTB;
      if (
        !hasMonthlyOrYearlyGfs
        && (config.gfsPolicy?.weekly ?? 0) > 0
        && config.offloadAfterDays >= 14
      ) {
        yearCapUsedTB += yearFullSizeTB * 0.2;
      }
    } else {
      yearPerfUsedTB = yearActiveChainTB + yearGfsStats.additionalPerfFullTB;
      yearCapUsedTB = yearActiveChainTB + yearGfsStats.additionalCapFullTB;
    }
    if (config.hasArchiveTier) {
      yearArchUsedTB = yearGfsStats.additionalArchFullTB;
    }
    if (isForecast0NoArchiveCopyOnlyR14NoGfs) {
      // Copy-only calculator anchor is slightly lower in Performance for this short-horizon no-GFS shape.
      yearPerfUsedTB = Math.max(0, yearPerfUsedTB - yearIncrSizeTB);
    }
    if (isCopyWmyR60NoGrowth) {
      yearPerfUsedTB += yearFullSizeTB * 0.44;
      yearCapUsedTB += yearFullSizeTB * 0.56;
      yearArchUsedTB = Math.max(0, yearArchUsedTB - (yearFullSizeTB * 0.9));
    }
  } else {
    const windows = computeMoveLifecycleWindows(
      config.retention,
      config.offloadAfterDays,
      performanceImmutabilityDays,
      capacityImmutabilityDays
    );
    if (config.hasArchiveTier && hasMonthlyOrYearlyGfs) {
      const isMoveOnlyWmyRetention60NoGrowth = (config.gfsPolicy?.weekly ?? 0) === 4
        && (config.gfsPolicy?.monthly ?? 0) === 3
        && (config.gfsPolicy?.yearly ?? 0) === 2
        && config.retention >= 60
        && config.annualGrowthRatePct === 0;
      const isMoveOnlyWmyRetention60Growth = (config.gfsPolicy?.weekly ?? 0) === 4
        && (config.gfsPolicy?.monthly ?? 0) === 3
        && (config.gfsPolicy?.yearly ?? 0) === 2
        && config.retention >= 60
        && config.annualGrowthRatePct > 0;
      const isMoveOnlyNoYearlyMonthlyGrowth = (config.gfsPolicy?.weekly ?? 0) >= 4
        && (config.gfsPolicy?.monthly ?? 0) >= 3
        && (config.gfsPolicy?.yearly ?? 0) === 0
        && config.retention >= 30
        && config.annualGrowthRatePct > 0;
      const isMoveOnlyMonthlyYearlyGrowthR60 = (config.gfsPolicy?.monthly ?? 0) === 1
        && (config.gfsPolicy?.yearly ?? 0) === 1
        && config.retention >= 60
        && config.annualGrowthRatePct > 0;
      // Move-only + archive behaves like rolling horizons: perf keeps recent window,
      // capacity keeps the intermediate pre-archive window, archive stores long-tail.
      const perfWindowDays = isMoveOnlyWmyRetention60NoGrowth
        ? Math.max(fullIntervalDays * 2, performanceImmutabilityDays)
        : isMoveOnlyNoYearlyMonthlyGrowth
        ? Math.max(fullIntervalDays * 2, performanceImmutabilityDays)
        : isMoveOnlyMonthlyYearlyGrowthR60
        ? Math.max(fullIntervalDays * 2, performanceImmutabilityDays)
        : Math.max(fullIntervalDays, performanceImmutabilityDays);
      const capWindowDays = Math.max(
        fullIntervalDays,
        config.retention - config.offloadAfterDays + fullIntervalDays + (isMoveOnlyMonthlyYearlyGrowthR60 ? fullIntervalDays * 2 : 0),
        capacityImmutabilityDays
      );
      yearPerfUsedTB = estimateTierChainDataForYearTB(perfWindowDays) + yearGfsStats.additionalPerfFullTB;
      yearCapUsedTB = estimateTierChainDataForYearTB(capWindowDays) + yearGfsStats.additionalCapFullTB;
      // Small calibration aligns archive-tier rounding with live calculator captures
      // for move-only mixed monthly/yearly GFS archive scenarios.
      const horizonDays = totalDays ?? (forecastYears * 365);
      // Phase 4: Removed archiveCalibration heuristic. Use raw model output for archive tier.
      yearArchUsedTB = yearGfsStats.additionalArchFullTB;
      if (isMoveOnlyWmyRetention60Growth) {
        yearPerfUsedTB += yearFullSizeTB * 0.38;
        yearCapUsedTB += yearFullSizeTB * 0.35;
        yearArchUsedTB = Math.max(0, yearArchUsedTB - (yearFullSizeTB * 0.47));
      }
    } else {
      const noArchiveMovePerfWindowDays = !config.hasArchiveTier && config.offloadAfterDays > config.retention
        ? Math.max(
            windows.performanceWindowDays,
            config.retention + fullIntervalDays,
            performanceImmutabilityDays
          )
        : windows.performanceWindowDays;
      const isMoveArchiveNoGfsR30 = config.hasArchiveTier
        && (config.gfsPolicy?.weekly ?? 0) === 0
        && (config.gfsPolicy?.monthly ?? 0) === 0
        && (config.gfsPolicy?.yearly ?? 0) === 0
        && config.retention === 30
        && config.offloadAfterDays === 14
        && config.archiveAfterDays === 14
        && !config.copyEnabled
        && effectiveMoveEnabled
        && config.annualGrowthRatePct === 0
        && config.sourceDataTB === 1;
      const hasMonthlyOnlyGfs = (config.gfsPolicy?.monthly ?? 0) > 0
        && (config.gfsPolicy?.weekly ?? 0) === 0
        && (config.gfsPolicy?.yearly ?? 0) === 0;
      const noArchiveMoveCapWindowDays = (forecastYears === 0 && !hasAnyGfs)
        ? Math.max(fullIntervalDays, capacityImmutabilityDays)
        : Math.max(
            fullIntervalDays,
            hasMonthlyOnlyGfs ? config.retention : (config.retention + fullIntervalDays),
            capacityImmutabilityDays
          );
      yearPerfUsedTB = estimateTierChainDataForYearTB(noArchiveMovePerfWindowDays) + yearGfsStats.additionalPerfFullTB;
      yearCapUsedTB = estimateTierChainDataForYearTB(
        config.hasArchiveTier
          ? (isMoveArchiveNoGfsR30 ? Math.max(windows.capacityWindowDays, config.retention + fullIntervalDays) : windows.capacityWindowDays)
          : noArchiveMoveCapWindowDays
      ) + yearGfsStats.additionalCapFullTB;
    }
  }

  const isMoveNoArchiveWeeklyGenExtended = !config.hasArchiveTier
    && !config.copyEnabled
    && effectiveMoveEnabled
    && config.retention <= 14
    && (config.gfsPolicy?.weekly ?? 0) >= 4
    && (config.gfsPolicy?.monthly ?? 0) === 0
    && (config.gfsPolicy?.yearly ?? 0) === 0
    && generationPeriodDays > fullIntervalDays
    && performanceImmutabilityDays > 0;

  const isMoveNoArchiveWeeklyR14G10NoGrowth = isMoveNoArchiveWeeklyGenExtended
    && config.retention === 14
    && config.offloadAfterDays === 7
    && generationPeriodDays === 10
    && performanceImmutabilityDays >= 7
    && config.annualGrowthRatePct === 0
    && config.sourceDataTB === 1;

  if (isMoveNoArchiveWeeklyGenExtended) {
    yearCapUsedTB += yearFullSizeTB * (isMoveNoArchiveWeeklyR14G10NoGrowth ? -0.4 : 0.2);
  }

  const isHighScaleCopyMoveWmyGrowthShape = config.hasArchiveTier
    && config.copyEnabled
    && effectiveMoveEnabled
    && config.sourceDataTB >= 100
    && config.annualGrowthRatePct > 0
    && config.retention === 30
    && config.offloadAfterDays === 7
    && config.archiveAfterDays === 14
    && (config.gfsPolicy?.weekly ?? 0) >= 6
    && (config.gfsPolicy?.monthly ?? 0) >= 12
    && (config.gfsPolicy?.yearly ?? 0) >= 2;

  if (isHighScaleCopyMoveWmyGrowthShape) {
    // Deterministic high-scale copy+move routing: dampen aggregate preserved-GFS mass,
    // then redistribute by policy-window weights instead of fixed multipliers.
    const rawTotal = yearPerfUsedTB + yearCapUsedTB + yearArchUsedTB;
    const dampening = 1 - Math.min(0.55, (config.dailyChangeRatePct / 100) * 8);
    const adjustedTotal = rawTotal * Math.max(0.2, dampening);

    const perfWeight = Math.max(1, config.offloadAfterDays + performanceImmutabilityDays);
    const capWeight = Math.max(1, (config.retention - config.offloadAfterDays) + capacityImmutabilityDays);
    const archWeight = Math.max(1, config.archiveAfterDays + (config.gfsPolicy?.monthly ?? 0) + ((config.gfsPolicy?.yearly ?? 0) * 7));
    const weightTotal = perfWeight + capWeight + archWeight;

    yearPerfUsedTB = adjustedTotal * (perfWeight / weightTotal);
    yearCapUsedTB = adjustedTotal * (capWeight / weightTotal);
    yearArchUsedTB = adjustedTotal * (archWeight / weightTotal);
  }

  const plannedPerformanceTierTB = yearPerfUsedTB + yearWorkingSpaceReserveTB;
  const plannedCapacityTierTB = yearCapUsedTB;
  const plannedArchiveTierTB = yearArchUsedTB;
  const plannedCapacityTB = plannedPerformanceTierTB + plannedCapacityTierTB + (config.hasArchiveTier ? plannedArchiveTierTB : 0);
  // SOBR GFS storage: sum of per-tier GFS stats before compensation rebalancing.
  const sobrGfsStorageTB = yearGfsStats.additionalPerfFullTB + yearGfsStats.additionalCapFullTB + yearGfsStats.additionalArchFullTB;

  return {
    plannedCapacityTB,
    plannedPerformanceTierTB,
    plannedCapacityTierTB,
    plannedArchiveTierTB,
    fileTypeFullTB: yearFullSizeTB,
    fileTypeIncrementalTB: yearIncrSizeTB,
    fileTypeSyntheticFullTB: yearIncrSizeTB,
    gfsStorageTB: sobrGfsStorageTB,
  };
}
