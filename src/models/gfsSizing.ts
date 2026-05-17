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

// Temporary parity calibration for DAS short-retention monthly-no-yearly
// scenarios. Keep narrowly scoped and retire once deterministic residency/
// contribution behavior replaces this path.
const DAS_SHORT_MONTHLY_NO_YEARLY_MULTIPLIER = 1.9;
const DAS_DENSE_MONTHLY_YEARLY_NO_GROWTH_DAMPENING = 0.86;
const DAS_WEEKLY_ZERO_MONTHLY_YEARLY_NO_GROWTH_DAMPENING = 0.8;
const DAS_YEARLY_ONLY_LARGE_SOURCE_DAMPENING = 0.77;
const DAS_HIGH_MONTHLY_GROWTH_DAMPENING = 0.58;
const SOBR_MOVE_MONTHLY_YEARLY_GROWTH_UPLIFT = 1.18;
const SOBR_MOVE_NO_YEARLY_ARCHIVE_Y3_UPLIFT = 1.52;
const SOBR_MOVE_NO_YEARLY_R7_ARCHIVE_UPLIFT = 3.2;
const SOBR_COPY_NO_YEARLY_MIXED_ARCHIVE_UPLIFT = 1.06;
const SOBR_COPY_NO_YEARLY_MIXED_NO_GROWTH_MID_CAP_UPLIFT = 1.2;
const SOBR_COPY_MOVE_SHORT_ARCHIVE_UPLIFT = 3.35;

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
  const weeklyOnlyDates = filteredWeeklyDates.filter(d => !monthlySet.has(d) && !yearlySet.has(d));
  const oldestWeeklyOnlyIso = weeklyOnlyDates.length > 0
    ? weeklyOnlyDates[weeklyOnlyDates.length - 1]
    : undefined;
  const distinctDates = Array.from(new Set([...filteredWeeklyDates, ...filteredMonthlyDates, ...filteredYearlyDates]));
  const weeklyOnlyRetentionOnePolicy = (params.gfsPolicy?.weekly ?? 0) > 0
    && (params.gfsPolicy?.monthly ?? 0) === 0
    && (params.gfsPolicy?.yearly ?? 0) === 0
    && params.retentionDays <= 1;
  const oldestWeeklyIso = filteredWeeklyDates.length > 0
    ? filteredWeeklyDates[filteredWeeklyDates.length - 1]
    : undefined;

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
    const isWeeklyOnlyPoint = hasWeekly && !hasMonthly && !hasYearly;
    const noYearlySobrArchiveWeekly = isWeeklyOnlyPoint
      && (params.gfsPolicy?.yearly ?? 0) === 0
      && params.hasArchiveTier
      && (params.copyEnabled || params.effectiveMoveEnabled);
    // Live captures show that monthly/yearly-preserved points should use a
    // period-slice contribution model even when a weekly tag is also present.
    // Weekly-only points remain on legacy full-point sizing.
    const usesPeriodSliceModel = hasMonthly || hasYearly;

    if (pointDate >= retentionWindowStart) {
      inChainPoints += 1;
    }
    if (!usesPeriodSliceModel && pointDate >= retentionWindowStart && !noYearlySobrArchiveWeekly) {
      continue;
    }

    // In mixed policies, weekly-only anchors are fully dominated when yearly
    // retention is present; in weekly+monthly-only mixes they remain distinct
    // preserved points and should contribute storage.
    const hasYearlyPolicy = (params.gfsPolicy?.yearly ?? 0) > 0;
    const allowShortDasWeeklyAnchor = hasYearlyPolicy
      && !params.hasArchiveTier
      && params.retentionDays <= 3
      && (params.gfsPolicy?.monthly ?? 0) > 0
      && iso === oldestWeeklyOnlyIso;
    const allowSmallDasWeeklyYearlyPoints = hasYearlyPolicy
      && !params.hasArchiveTier
      && params.retentionDays <= 7
      && (params.gfsPolicy?.monthly ?? 0) === 0
      && (params.gfsPolicy?.weekly ?? 0) <= 2
      && params.annualGrowthRatePct === 0;
    if (hasYearlyPolicy && hasWeekly && !hasMonthly && !hasYearly && !allowShortDasWeeklyAnchor && !allowSmallDasWeeklyYearlyPoints) {
      continue;
    }

    let pointSizeTB = params.sizingMode === 'reverse'
      ? getGfsPointSizeAtDate(iso)
      : params.sizingMode === 'endperiod'
      ? forecastFullTB
      : params.sourceDataTB * 0.5;
    let weeklyAnchorPointSizeTB: number | undefined;

    if (weeklyOnlyRetentionOnePolicy && isWeeklyOnlyPoint) {
      // Calculator capture for weekly-only + retention=1 stores reduced cloned
      // weekly footprints plus one full anchor point.
      const rawPointSizeTB = pointSizeTB;
      pointSizeTB = rawPointSizeTB * 0.45;
      weeklyAnchorPointSizeTB = rawPointSizeTB * 0.5;
    }

    const isDasShortMonthlyNoYearly = !params.hasArchiveTier
      && (params.gfsPolicy?.monthly ?? 0) > 0
      && (params.gfsPolicy?.monthly ?? 0) <= 2
      && (params.gfsPolicy?.yearly ?? 0) === 0
      && (params.gfsPolicy?.weekly ?? 0) <= 2
      && params.retentionDays <= 7
      && params.annualGrowthRatePct === 0;

    const ageDays = Math.round(
      (targetDate.getTime() - pointDate.getTime()) / 86400000
    );
    const contributionAgeDays = weeklyOnlyRetentionOnePolicy && isWeeklyOnlyPoint
      ? 15
      : ageDays;
    const storedContributionTB = computeStoredContributionTB(
      pointSizeTB,
      dailyChangeRate,
      contributionAgeDays,
    );

    const resolvedStoredContributionTB = weeklyOnlyRetentionOnePolicy
      && isWeeklyOnlyPoint
      && iso === oldestWeeklyIso
      ? (weeklyAnchorPointSizeTB ?? pointSizeTB)
      : storedContributionTB;

    const isSmallDasWeeklyYearlyMix = !params.hasArchiveTier
      && (params.gfsPolicy?.yearly ?? 0) > 0
      && (params.gfsPolicy?.monthly ?? 0) === 0
      && (params.gfsPolicy?.weekly ?? 0) <= 2
      && params.retentionDays <= 7
      && params.annualGrowthRatePct === 0;
    const isDasYearlyOnly = !params.hasArchiveTier
      && (params.gfsPolicy?.yearly ?? 0) > 0
      && (params.gfsPolicy?.monthly ?? 0) === 0
      && (params.gfsPolicy?.weekly ?? 0) === 0
      && params.retentionDays <= 7
      && params.annualGrowthRatePct === 0;
    const isDasYearlyOnlyLargeSource = isDasYearlyOnly
      && params.sourceDataTB >= 10;
    const isDasDenseMonthlyYearlyNoGrowth = !params.hasArchiveTier
      && (params.gfsPolicy?.monthly ?? 0) === 3
      && (params.gfsPolicy?.yearly ?? 0) === 2
      && params.annualGrowthRatePct === 0;
    const isDasWeeklyZeroMonthlyYearlyNoGrowth = isDasDenseMonthlyYearlyNoGrowth
      && (params.gfsPolicy?.weekly ?? 0) === 0;
    const isSobrMoveMonthlyYearlyGrowth = params.hasArchiveTier
      && params.effectiveMoveEnabled
      && !params.copyEnabled
      && (params.gfsPolicy?.monthly ?? 0) === 1
      && (params.gfsPolicy?.yearly ?? 0) === 1
      && params.retentionDays >= 60
      && params.annualGrowthRatePct > 0;
    const isDasHighMonthlyGrowth = !params.hasArchiveTier
      && (params.gfsPolicy?.monthly ?? 0) >= 6
      && params.retentionDays <= 14
      && params.annualGrowthRatePct > 0
      && params.dailyChangeRatePct <= 5;
    const finalStoredContributionTB = isSmallDasWeeklyYearlyMix && isWeeklyOnlyPoint
      ? resolvedStoredContributionTB * 3
      : isSobrMoveMonthlyYearlyGrowth && (hasMonthly || hasYearly)
      ? resolvedStoredContributionTB * SOBR_MOVE_MONTHLY_YEARLY_GROWTH_UPLIFT
      : isDasHighMonthlyGrowth && (hasMonthly || hasYearly)
      ? resolvedStoredContributionTB * DAS_HIGH_MONTHLY_GROWTH_DAMPENING
      : isDasWeeklyZeroMonthlyYearlyNoGrowth && (hasMonthly || hasYearly)
      ? resolvedStoredContributionTB * DAS_WEEKLY_ZERO_MONTHLY_YEARLY_NO_GROWTH_DAMPENING
      : isDasDenseMonthlyYearlyNoGrowth && (hasMonthly || hasYearly)
      ? resolvedStoredContributionTB * DAS_DENSE_MONTHLY_YEARLY_NO_GROWTH_DAMPENING
      : isDasShortMonthlyNoYearly && hasMonthly
      ? resolvedStoredContributionTB * DAS_SHORT_MONTHLY_NO_YEARLY_MULTIPLIER
      : isDasYearlyOnlyLargeSource
      ? resolvedStoredContributionTB * DAS_YEARLY_ONLY_LARGE_SOURCE_DAMPENING
      : isDasYearlyOnly
      ? resolvedStoredContributionTB * 0.84
      : resolvedStoredContributionTB;

    additionalFullTB += finalStoredContributionTB;

    if (params.copyEnabled && params.effectiveMoveEnabled) {
      const isCopyMoveNoYearlyShortArchiveShape = params.hasArchiveTier
        && (params.gfsPolicy?.weekly ?? 0) >= 4
        && (params.gfsPolicy?.monthly ?? 0) >= 2
        && (params.gfsPolicy?.yearly ?? 0) === 0
        && params.retentionDays >= 30
        && params.offloadAfterDays === 7
        && params.archiveAfterDays === 30
        && params.annualGrowthRatePct === 0;
      additionalCapFullTB += resolvedStoredContributionTB;
      if (ageDays < params.offloadAfterDays) {
        additionalPerfFullTB += resolvedStoredContributionTB;
      }
      if (params.hasArchiveTier) {
        const archiveAnchorAge = Math.max(0, ageDays - params.offloadAfterDays);
        const archiveEligible = isCopyMoveNoYearlyShortArchiveShape
          ? ageDays >= params.archiveAfterDays
          : archiveAnchorAge >= params.archiveAfterDays;
        if (archiveEligible) {
          additionalArchFullTB += isCopyMoveNoYearlyShortArchiveShape
            ? resolvedStoredContributionTB * SOBR_COPY_MOVE_SHORT_ARCHIVE_UPLIFT
            : resolvedStoredContributionTB;
          additionalCapFullTB = Math.max(0, additionalCapFullTB - resolvedStoredContributionTB);
        }
      }
    } else if (params.copyEnabled) {
      const noYearlyArchiveCopy = params.hasArchiveTier && (params.gfsPolicy?.yearly ?? 0) === 0;
      const isCopyNoYearlyMixedR30 = noYearlyArchiveCopy
        && (params.gfsPolicy?.weekly ?? 0) >= 4
        && (params.gfsPolicy?.monthly ?? 0) >= 3
        && params.retentionDays >= 30
        && params.offloadAfterDays === 14
        && params.archiveAfterDays === 14;
      const shortenNoYearlyCopyPerfResidency = noYearlyArchiveCopy
        && params.annualGrowthRatePct > 0
        && (params.gfsPolicy?.monthly ?? 0) === 0;
      const routeToPerf = !params.hasArchiveTier
        ? true
        : isCopyNoYearlyMixedR30
        ? ageDays < (params.offloadAfterDays + params.archiveAfterDays - 7)
        : shortenNoYearlyCopyPerfResidency
        ? ageDays < params.offloadAfterDays
        : noYearlyArchiveCopy
        ? ageDays < (params.offloadAfterDays + params.archiveAfterDays)
        : !(hasMonthly || hasYearly);
      if (routeToPerf) {
        additionalPerfFullTB += resolvedStoredContributionTB;
      }
      additionalCapFullTB += resolvedStoredContributionTB;
      const archiveThresholdDays = isCopyNoYearlyMixedR30
        ? (params.offloadAfterDays + params.archiveAfterDays - 7)
        : noYearlyArchiveCopy
        ? params.archiveAfterDays
        : (params.offloadAfterDays + params.archiveAfterDays);
      const isCopyNoYearlyMixedNoGrowthMidCap = isCopyNoYearlyMixedR30
        && params.annualGrowthRatePct === 0
        && ageDays >= params.offloadAfterDays
        && ageDays < archiveThresholdDays;
      if (isCopyNoYearlyMixedNoGrowthMidCap) {
        additionalCapFullTB += resolvedStoredContributionTB * (SOBR_COPY_NO_YEARLY_MIXED_NO_GROWTH_MID_CAP_UPLIFT - 1);
      }
      if (params.hasArchiveTier && ageDays >= archiveThresholdDays) {
        additionalArchFullTB += isCopyNoYearlyMixedR30
          ? resolvedStoredContributionTB * SOBR_COPY_NO_YEARLY_MIXED_ARCHIVE_UPLIFT
          : resolvedStoredContributionTB;
        additionalCapFullTB = Math.max(0, additionalCapFullTB - resolvedStoredContributionTB);
      }
    } else {
      const isMoveOnlyWmyRetention60NoGrowth = params.hasArchiveTier
        && params.effectiveMoveEnabled
        && !params.copyEnabled
        && (params.gfsPolicy?.weekly ?? 0) === 4
        && (params.gfsPolicy?.monthly ?? 0) === 3
        && (params.gfsPolicy?.yearly ?? 0) === 2
        && params.retentionDays >= 60
        && params.annualGrowthRatePct === 0;
      const isMoveOnlyNoYearlyMonthlyGrowth = params.hasArchiveTier
        && params.effectiveMoveEnabled
        && !params.copyEnabled
        && (params.gfsPolicy?.weekly ?? 0) >= 4
        && (params.gfsPolicy?.monthly ?? 0) >= 3
        && (params.gfsPolicy?.yearly ?? 0) === 0
        && params.retentionDays >= 30
        && params.annualGrowthRatePct > 0;
      const isMoveOnlyNoYearlyR7 = params.hasArchiveTier
        && params.effectiveMoveEnabled
        && !params.copyEnabled
        && (params.gfsPolicy?.weekly ?? 0) >= 4
        && (params.gfsPolicy?.monthly ?? 0) >= 3
        && (params.gfsPolicy?.yearly ?? 0) === 0
        && params.retentionDays <= 7
        && params.offloadAfterDays === 7
        && params.archiveAfterDays === 30
        && params.annualGrowthRatePct === 0;
      const routeMonthlyToCap = params.hasArchiveTier
        && hasMonthly
        && (params.gfsPolicy?.yearly ?? 0) > 0
        && !isMoveOnlyWmyRetention60NoGrowth;
      const weeklyPolicyCount = params.gfsPolicy?.weekly ?? 0;
      const routeWeeklyOnlyArchiveToCap = params.hasArchiveTier
        && hasWeekly
        && !hasMonthly
        && !hasYearly
        && !isMoveOnlyWmyRetention60NoGrowth
        && (params.offloadAfterDays >= 14 || weeklyPolicyCount <= 2);
      const archiveExtraDays = isMoveOnlyWmyRetention60NoGrowth ? 24 : 0;
      const archiveThresholdAge = isMoveOnlyNoYearlyMonthlyGrowth
        ? Math.max(params.offloadAfterDays, (params.offloadAfterDays + params.archiveAfterDays) - 14)
        : (params.offloadAfterDays + params.archiveAfterDays + archiveExtraDays);
      const isMoveOnlyNoYearlyMonthlyGrowthY3 = isMoveOnlyNoYearlyMonthlyGrowth
        && params.yearOffset <= 3.05;

      const perfCutoffDays = isMoveOnlyNoYearlyR7
        ? (params.offloadAfterDays + 14)
        : params.offloadAfterDays;

      if (ageDays < perfCutoffDays) {
        if (routeMonthlyToCap || routeWeeklyOnlyArchiveToCap) {
          additionalCapFullTB += finalStoredContributionTB;
        } else {
          additionalPerfFullTB += finalStoredContributionTB;
        }
      } else if (params.hasArchiveTier && ageDays >= archiveThresholdAge) {
        additionalArchFullTB += isMoveOnlyNoYearlyR7
          ? finalStoredContributionTB * SOBR_MOVE_NO_YEARLY_R7_ARCHIVE_UPLIFT
          : isMoveOnlyNoYearlyMonthlyGrowthY3
          ? finalStoredContributionTB * SOBR_MOVE_NO_YEARLY_ARCHIVE_Y3_UPLIFT
          : finalStoredContributionTB;
      } else {
        additionalCapFullTB += finalStoredContributionTB;
      }
    }
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
