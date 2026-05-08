import { GFSPolicy } from './veeam.js';

export type GfsSizingMode = 'legacy' | 'reverse' | 'endperiod';

export interface GfsForecastStats {
  distinctPoints: number;
  inChainPoints: number;
  additionalPoints: number;
  additionalFullTB: number;
  additionalPerfFullTB: number;
  additionalCapFullTB: number;
  additionalArchFullTB: number;
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
      continue;
    }

    // In mixed policies, weekly-only points within the active retention chain are
    // already represented by chain storage — skip them.
    // Out-of-retention weekly-only points are genuine GFS-preserved snapshots
    // that must contribute their own footprint (when calculator calibration is on).
    // Lifecycle oracle mode uses old behavior (always skip) to maintain forecast=simulator.
    const skipWeeklyOutOfChain = (params.applyCalculatorCalibration ?? true)
      ? (hasMonthlyOrYearlyPolicy && hasWeekly && !hasMonthly && !hasYearly && pointDate >= retentionWindowStart)
      : (hasMonthlyOrYearlyPolicy && hasWeekly && !hasMonthly && !hasYearly);
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
      // Full mixed (weekly+monthly+yearly): small=1.31, large=1.015 → log-linear fit
      dasPolicyFactor = Math.max(1.0, 1.31 - 0.262 * logSource);
    }
  }

  if (Math.abs(dasPolicyFactor - 1) > 0.000001) {
    additionalFullTB *= dasPolicyFactor;
    additionalPerfFullTB *= dasPolicyFactor;
    additionalCapFullTB *= dasPolicyFactor;
    additionalArchFullTB *= dasPolicyFactor;
  }

  return {
    distinctPoints: distinctDates.length,
    inChainPoints,
    additionalPoints: Math.max(0, distinctDates.length - inChainPoints),
    additionalFullTB,
    additionalPerfFullTB,
    additionalCapFullTB,
    additionalArchFullTB,
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
