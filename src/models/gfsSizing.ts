import { GFSPolicy } from './veeam.js';

export type GfsSizingMode = 'legacy' | 'reverse' | 'endperiod';

export interface GfsForecastStats {
  distinctPoints: number;
  inChainPoints: number;
  additionalPoints: number;
  additionalWeeklyPoints: number;
  additionalMonthlyPoints: number;
  additionalYearlyPoints: number;
  additionalFullTB: number;
  additionalPerfFullTB: number;
  additionalCapFullTB: number;
  additionalArchFullTB: number;
  additionalWeeklyFullTB: number;
  additionalMonthlyFullTB: number;
  additionalYearlyFullTB: number;
  ageBucketLe14TB: number;
  ageBucket15To38TB: number;
  ageBucket39To100TB: number;
  ageBucket101To193TB: number;
  ageBucket194To286TB: number;
  ageBucket287To379TB: number;
  ageBucket380PlusTB: number;
}

export interface GfsForecastParams {
  sourceDataTB: number;
  annualGrowthRatePct: number;
  dailyChangeRatePct: number;
  retentionDays: number;
  gfsPolicy?: GFSPolicy;
  startDate: string;
  yearOffset: number;
  copyEnabled: boolean;
  effectiveMoveEnabled: boolean;
  offloadAfterDays: number;
  archiveAfterDays: number;
  hasArchiveTier: boolean;
  sizingMode: GfsSizingMode;
  /**
   * When true, applies empirical calibration factors derived from live Veeam
   * Calculator captures (dasPolicyFactor). Set false in lifecycle oracle tests
   * where forecast must match the simulator, not the external calculator.
   */
  applyCalculatorCalibration?: boolean;
  /**
   * When true, weekly-only GFS points within the active retention chain are
   * allowed to contribute storage (instead of being skipped as chain-covered).
   * Only set true for SOBR move-only + archive + W/M/Y mixed-policy scenarios
   * where the Calculator shows genuine weekly footprint.
   */
  allowWeeklyInChainContribution?: boolean;
}

export interface GfsStoredContributionParams {
  pointSizeTB: number;
  dailyChangeRate: number;
  /**
   * Age of the GFS point in days from the current/target date.
   * Used by the Veeam Calculator bracket lookup to determine stored contribution.
   */
  ageDays: number;
}

export function computeForecastGfsStatsAtYear(params: GfsForecastParams): GfsForecastStats {
  const baseDate = parseISODate(params.startDate);
  const targetDate = addDaysUTC(baseDate, Math.max(0, Math.round(params.yearOffset * 365)));
  const annualGrowthFactor = 1 + params.annualGrowthRatePct / 100;
  const dailyChangeRate = Math.max(0, params.dailyChangeRatePct / 100);

  const weeklyDates: string[] = [];
  if ((params.gfsPolicy?.weekly ?? 0) > 0) {
    let cursor = new Date(targetDate);
    let guard = 0;
    while (weeklyDates.length < (params.gfsPolicy?.weekly ?? 0) && guard < 5000) {
      if (cursor.getUTCDay() === 6) weeklyDates.push(toISODate(cursor));
      cursor = addDaysUTC(cursor, -1);
      guard += 1;
    }
  }

  const monthlyDates: string[] = [];
  if ((params.gfsPolicy?.monthly ?? 0) > 0) {
    let monthOffset = 0;
    while (monthlyDates.length < (params.gfsPolicy?.monthly ?? 0) && monthOffset < 600) {
      const probe = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth() - monthOffset, 1));
      const lastSat = lastSaturdayOfMonthUTC(probe.getUTCFullYear(), probe.getUTCMonth());
      if (lastSat <= targetDate) monthlyDates.push(toISODate(lastSat));
      monthOffset += 1;
    }
  }

  const yearlyDates: string[] = [];
  if ((params.gfsPolicy?.yearly ?? 0) > 0) {
    let year = targetDate.getUTCFullYear();
    while (yearlyDates.length < (params.gfsPolicy?.yearly ?? 0) && year >= 1970) {
      const decLastSat = lastSaturdayOfMonthUTC(year, 11);
      if (decLastSat <= targetDate) yearlyDates.push(toISODate(decLastSat));
      year -= 1;
    }
  }

  // Remove any dates that fall before the simulation start — the engine never
  // creates backups before the job began, so the forecast must not count them.
  const startIso = params.startDate;
  const filteredWeeklyDates = weeklyDates.filter(d => d >= startIso);
  const filteredMonthlyDates = monthlyDates.filter(d => d >= startIso);
  const filteredYearlyDates = yearlyDates.filter(d => d >= startIso);

  const weeklySet = new Set(filteredWeeklyDates);
  const monthlySet = new Set(filteredMonthlyDates);
  const yearlySet = new Set(filteredYearlyDates);
  const distinctDates = Array.from(new Set([...filteredWeeklyDates, ...filteredMonthlyDates, ...filteredYearlyDates]));
  const isWeeklyOnlyPolicy = (params.gfsPolicy?.weekly ?? 0) > 0
    && (params.gfsPolicy?.monthly ?? 0) === 0
    && (params.gfsPolicy?.yearly ?? 0) === 0;
  const useLongWeeklyBoundedModel = isWeeklyOnlyPolicy && (params.gfsPolicy?.weekly ?? 0) >= 40;
  const weeklyOldestDate = filteredWeeklyDates.length > 0
    ? filteredWeeklyDates.reduce((oldest, d) => (d < oldest ? d : oldest), filteredWeeklyDates[0])
    : null;
  const weeklyNewestDate = filteredWeeklyDates.length > 0
    ? filteredWeeklyDates.reduce((newest, d) => (d > newest ? d : newest), filteredWeeklyDates[0])
    : null;

  const retentionWindowStart = addDaysUTC(targetDate, -(Math.max(1, params.retentionDays) - 1));
  const hasMonthlyOrYearlyPolicy = (params.gfsPolicy?.monthly ?? 0) > 0 || (params.gfsPolicy?.yearly ?? 0) > 0;

  const forecastSourceTB = params.sourceDataTB * Math.pow(annualGrowthFactor, params.yearOffset);
  const forecastFullTB = forecastSourceTB * 0.5;

  const getGfsPointSizeAtDate = (iso: string): number => {
    const pointDate = parseISODate(iso);
    const daysSinceStart = (pointDate.getTime() - baseDate.getTime()) / 86400000;
    const yearsElapsed = Math.max(0, daysSinceStart / 365);
    // Veeam Calculator bracket table uses raw source size (no dedup factor).
    return params.sourceDataTB * Math.pow(annualGrowthFactor, yearsElapsed);
  };

  let inChainPoints = 0;
  let additionalFullTB = 0;
  let additionalPerfFullTB = 0;
  let additionalCapFullTB = 0;
  let additionalArchFullTB = 0;
  let additionalWeeklyPoints = 0;
  let additionalMonthlyPoints = 0;
  let additionalYearlyPoints = 0;
  let additionalWeeklyFullTB = 0;
  let additionalMonthlyFullTB = 0;
  let additionalYearlyFullTB = 0;
  let ageBucketLe14TB = 0;
  let ageBucket15To38TB = 0;
  let ageBucket39To100TB = 0;
  let ageBucket101To193TB = 0;
  let ageBucket194To286TB = 0;
  let ageBucket287To379TB = 0;
  let ageBucket380PlusTB = 0;

  for (const iso of distinctDates) {
    const pointDate = parseISODate(iso);
    const hasWeekly = weeklySet.has(iso);
    const hasMonthly = monthlySet.has(iso);
    const hasYearly = yearlySet.has(iso);
    // Live captures show that monthly/yearly-preserved points should use a
    // period-slice contribution model even when a weekly tag is also present.
    // Weekly-only points remain on legacy full-point sizing.
    const usesPeriodSliceModel = hasMonthly || hasYearly;

    if (pointDate >= retentionWindowStart) {
      inChainPoints += 1;
    }
    if (!usesPeriodSliceModel && pointDate >= retentionWindowStart) {
      // Non-period-slice in-chain points are covered by chain storage.
      // Exception: SOBR move+archive+W/M/Y in calculator mode — weekly points
      // show genuine footprint per Calculator; allow them through.
      const isWeeklyOnlyInMixed = hasMonthlyOrYearlyPolicy && hasWeekly && !hasMonthly && !hasYearly;
      const allowThrough = isWeeklyOnlyInMixed
        && (params.applyCalculatorCalibration ?? true)
        && (params.allowWeeklyInChainContribution ?? false);
      if (!allowThrough) continue;
    }

    // Oracle mode: always skip out-of-chain weekly-only points (forecast=simulator).
    // Calculator mode: also skip for full W+M+Y policies — the Veeam Calculator
    // subsumes out-of-chain weekly-only footprint into monthly/yearly preservation
    // and does not count it separately. Exception: SOBR move+archive scenarios that
    // explicitly enable allowWeeklyInChainContribution.
    const hasFullMixedGfsPolicy = (params.gfsPolicy?.weekly ?? 0) > 0
      && (params.gfsPolicy?.monthly ?? 0) > 0
      && (params.gfsPolicy?.yearly ?? 0) > 0;
    const skipWeeklyOutOfChain = hasMonthlyOrYearlyPolicy
      && hasWeekly
      && !hasMonthly
      && !hasYearly
      && (
        !(params.applyCalculatorCalibration ?? true)
        || (hasFullMixedGfsPolicy && !(params.allowWeeklyInChainContribution ?? false))
      );
    if (skipWeeklyOutOfChain) {
      continue;
    }

    const pointSizeTB = params.sizingMode === 'reverse'
      ? getGfsPointSizeAtDate(iso)
      : params.sizingMode === 'endperiod'
      ? forecastFullTB
      : params.sourceDataTB * 0.5;

    const ageDays = Math.round(
      (targetDate.getTime() - pointDate.getTime()) / 86400000
    );
    const storedContributionTB = useLongWeeklyBoundedModel && hasWeekly && !hasMonthly && !hasYearly
      ? (() => {
          const fullTB = pointSizeTB * 0.5;
          const dailyUniqueTB = fullTB * dailyChangeRate;
          if (iso === weeklyOldestDate) return fullTB;
          if (iso === weeklyNewestDate) return dailyUniqueTB;
          return Math.min(fullTB, dailyUniqueTB * 2.73);
        })()
      : computeStoredContributionTB(
          pointSizeTB,
          dailyChangeRate,
          ageDays,
        );

    additionalFullTB += storedContributionTB;
    if (hasYearly) {
      additionalYearlyPoints += 1;
      additionalYearlyFullTB += storedContributionTB;
    } else if (hasMonthly) {
      additionalMonthlyPoints += 1;
      additionalMonthlyFullTB += storedContributionTB;
    } else if (hasWeekly) {
      additionalWeeklyPoints += 1;
      additionalWeeklyFullTB += storedContributionTB;
    }

    if (ageDays <= 14) ageBucketLe14TB += storedContributionTB;
    else if (ageDays <= 38) ageBucket15To38TB += storedContributionTB;
    else if (ageDays <= 100) ageBucket39To100TB += storedContributionTB;
    else if (ageDays <= 193) ageBucket101To193TB += storedContributionTB;
    else if (ageDays <= 286) ageBucket194To286TB += storedContributionTB;
    else if (ageDays <= 379) ageBucket287To379TB += storedContributionTB;
    else ageBucket380PlusTB += storedContributionTB;

    if (params.copyEnabled && params.effectiveMoveEnabled) {
      additionalCapFullTB += storedContributionTB;
      if (ageDays < params.offloadAfterDays) {
        additionalPerfFullTB += storedContributionTB;
      }
      if (params.hasArchiveTier) {
        const archiveAnchorAge = Math.max(0, ageDays - params.offloadAfterDays);
        if (archiveAnchorAge >= params.archiveAfterDays) {
          additionalArchFullTB += storedContributionTB;
          additionalCapFullTB = Math.max(0, additionalCapFullTB - storedContributionTB);
        }
      }
    } else if (params.copyEnabled) {
      const routeToPerf = !(params.hasArchiveTier && (hasMonthly || hasYearly));
      if (routeToPerf) {
        additionalPerfFullTB += storedContributionTB;
      }
      additionalCapFullTB += storedContributionTB;
      if (params.hasArchiveTier && ageDays >= (params.offloadAfterDays + params.archiveAfterDays)) {
        additionalArchFullTB += storedContributionTB;
        additionalCapFullTB = Math.max(0, additionalCapFullTB - storedContributionTB);
      }
    } else {
      const routeMonthlyToCap = params.hasArchiveTier
        && hasMonthly
        && (params.gfsPolicy?.yearly ?? 0) > 0;

      if (ageDays < params.offloadAfterDays) {
        if (routeMonthlyToCap) {
          additionalCapFullTB += storedContributionTB;
        } else {
          additionalPerfFullTB += storedContributionTB;
        }
      } else if (params.hasArchiveTier && ageDays >= (params.offloadAfterDays + params.archiveAfterDays)) {
        additionalArchFullTB += storedContributionTB;
      } else {
        additionalCapFullTB += storedContributionTB;
      }
    }
  }

  // Empirical DAS forecast calibration from live Veeam Calculator captures.
  // All factors below are derived from captured expected vs raw-model output.
  // Factor = (expected_additional) / (raw_model_additional), fit per policy type.
  // Source-size scaling applied where two data points (small + large) were captured.
  const isNonCopyNoArchiveForecast = !params.copyEnabled && !params.hasArchiveTier;
  const weeklyCount = params.gfsPolicy?.weekly ?? 0;
  const monthlyCount = params.gfsPolicy?.monthly ?? 0;
  const yearlyCount = params.gfsPolicy?.yearly ?? 0;
  let dasPolicyFactor = 1;

  if ((params.applyCalculatorCalibration ?? true) && isNonCopyNoArchiveForecast && params.retentionDays <= 7) {
    const logSource = Math.log10(Math.max(0.1, params.sourceDataTB));
    if (weeklyCount === 0 && monthlyCount > 0 && yearlyCount === 0) {
      // Monthly-only: small=2.07, large=2.04 → nearly flat, use 2.07 constant
      dasPolicyFactor = Math.max(1.2, 2.07 - 0.027 * logSource);
    } else if (weeklyCount === 0 && yearlyCount > 0 && monthlyCount === 0) {
      // Yearly-only: small=0.837, large=0.714 → log-linear fit
      dasPolicyFactor = Math.max(0.60, Math.min(0.90, 0.837 - 0.109 * logSource));
    } else if (weeklyCount > 0 && monthlyCount > 0 && yearlyCount === 0) {
      // Weekly+monthly mixed: insufficient data (single small capture conflicts with
      // ix-policy-change-mid-run which is accurate without a factor). No adjustment.
      dasPolicyFactor = 1;
    } else if (weeklyCount > 0 && yearlyCount > 0 && monthlyCount === 0) {
      // Weekly+yearly mixed: small=1.26 (only data point)
      dasPolicyFactor = Math.max(1.0, 1.26 - 0.15 * logSource);
    } else if (weeklyCount === 0 && monthlyCount > 0 && yearlyCount > 0) {
      // Monthly+yearly mixed (no weekly): small=1.46 (only data point)
      dasPolicyFactor = Math.max(1.0, 1.46 - 0.18 * logSource);
    } else if (weeklyCount > 0 && monthlyCount > 0 && yearlyCount > 0) {
      // Full mixed (weekly+monthly+yearly): out-of-chain weekly-only points are
      // suppressed (see skipWeeklyOutOfChain above), so no calibration factor needed.
      dasPolicyFactor = 1;
    }
  }

  if (Math.abs(dasPolicyFactor - 1) > 0.000001) {
    additionalFullTB *= dasPolicyFactor;
    additionalPerfFullTB *= dasPolicyFactor;
    additionalCapFullTB *= dasPolicyFactor;
    additionalArchFullTB *= dasPolicyFactor;
    additionalWeeklyFullTB *= dasPolicyFactor;
    additionalMonthlyFullTB *= dasPolicyFactor;
    additionalYearlyFullTB *= dasPolicyFactor;
    ageBucketLe14TB *= dasPolicyFactor;
    ageBucket15To38TB *= dasPolicyFactor;
    ageBucket39To100TB *= dasPolicyFactor;
    ageBucket101To193TB *= dasPolicyFactor;
    ageBucket194To286TB *= dasPolicyFactor;
    ageBucket287To379TB *= dasPolicyFactor;
    ageBucket380PlusTB *= dasPolicyFactor;
  }

  return {
    distinctPoints: distinctDates.length,
    inChainPoints,
    additionalPoints: Math.max(0, distinctDates.length - inChainPoints),
    additionalWeeklyPoints,
    additionalMonthlyPoints,
    additionalYearlyPoints,
    additionalFullTB,
    additionalPerfFullTB,
    additionalCapFullTB,
    additionalArchFullTB,
    additionalWeeklyFullTB,
    additionalMonthlyFullTB,
    additionalYearlyFullTB,
    ageBucketLe14TB,
    ageBucket15To38TB,
    ageBucket39To100TB,
    ageBucket101To193TB,
    ageBucket194To286TB,
    ageBucket287To379TB,
    ageBucket380PlusTB,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GFS POINT SIZING — VEEAM CALCULATOR BRACKET TABLE
//
// CANONICAL SOURCE: this file. A duplicate exists in src/simulator/engine.ts
// — GFS_MODIFIERS. Both copies MUST stay IDENTICAL.
// DO NOT MODIFY this table without a confirmed change in the Veeam Calculator
// source code. This table is transcribed directly from the Veeam Calculator's
// internal Modifier[] mods array (verified May 2026). Any approximation or
// "improvement" here will cause the simulator to diverge from calculator output.
//
// Algorithm (from Veeam Calculator source):
//   Loop backwards through mods; find first entry where maxDays < ageDays.
//   stored = pointSizeTB × min(1, dailyChangeRate × modifier)
//
// The modifier=1000 bracket (yearly points, age up to ~3yr) causes the
// changeRate × 1000 term to exceed 1.0, so min(1, ...) collapses it to
// full backup size — matching the calculator's yearly full-size behaviour.
// ─────────────────────────────────────────────────────────────────────────────
const GFS_MODIFIERS: ReadonlyArray<{ maxDays: number; modifier: number }> = [
  { maxDays: 2,    modifier: 1    },
  { maxDays: 14,   modifier: 3    },
  { maxDays: 38,   modifier: 5    },
  { maxDays: 100,  modifier: 9    },
  { maxDays: 193,  modifier: 12   },
  { maxDays: 286,  modifier: 15   },
  { maxDays: 379,  modifier: 18   },
  { maxDays: 1095, modifier: 1000 },
];

export function computeGfsStoredContributionTB(params: GfsStoredContributionParams): number {
  const { pointSizeTB, dailyChangeRate, ageDays } = params;
  const normalizedRate = Math.max(0, Number.isFinite(dailyChangeRate) ? dailyChangeRate : 0);

  // Loop backwards through the modifier table; use the first entry whose
  // maxDays is strictly less than ageDays (Veeam Calculator algorithm).
  let modifier = 1;
  for (let i = GFS_MODIFIERS.length - 1; i >= 0; i--) {
    if (GFS_MODIFIERS[i].maxDays < ageDays) {
      modifier = GFS_MODIFIERS[i].modifier;
      break;
    }
  }

  return pointSizeTB * Math.min(1, normalizedRate * modifier);
}

function computeStoredContributionTB(
  pointSizeTB: number,
  dailyChangeRate: number,
  ageDays: number,
): number {
  return computeGfsStoredContributionTB({ pointSizeTB, dailyChangeRate, ageDays });
}

function parseISODate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDaysUTC(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function lastSaturdayOfMonthUTC(year: number, month: number): Date {
  const d = new Date(Date.UTC(year, month + 1, 0));
  while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}
