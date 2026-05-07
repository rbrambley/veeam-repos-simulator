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
  hasWeekly: boolean;
  hasMonthly: boolean;
  hasYearly: boolean;
  weeklyPolicyCount: number;
  /** True when this is the oldest/outermost weekly GFS point (W_n where n = weekly policy count) */
  isOutermostWeekly?: boolean;
  /** True when this is the oldest/outermost monthly GFS point (M_n where n = monthly policy count) */
  isOutermostMonthly?: boolean;
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

  // Outermost = oldest surviving point in its class (last in the date-descending arrays).
  const outermostWeeklyDate  = filteredWeeklyDates.length  > 0 ? filteredWeeklyDates[filteredWeeklyDates.length - 1]   : null;
  const outermostMonthlyDate = filteredMonthlyDates.length > 0 ? filteredMonthlyDates[filteredMonthlyDates.length - 1] : null;
  const retentionWindowStart = addDaysUTC(targetDate, -(Math.max(1, params.retentionDays) - 1));
  const hasMonthlyOrYearlyPolicy = (params.gfsPolicy?.monthly ?? 0) > 0 || (params.gfsPolicy?.yearly ?? 0) > 0;

  const forecastSourceTB = params.sourceDataTB * Math.pow(annualGrowthFactor, params.yearOffset);
  const forecastFullTB = forecastSourceTB * 0.5;

  const getGfsPointSizeAtDate = (iso: string): number => {
    const pointDate = parseISODate(iso);
    const daysSinceStart = (pointDate.getTime() - baseDate.getTime()) / 86400000;
    const yearsElapsed = Math.max(0, daysSinceStart / 365);
    const sourceAtPoint = params.sourceDataTB * Math.pow(annualGrowthFactor, yearsElapsed);
    return sourceAtPoint * 0.5;
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

    // In mixed policies, weekly labels map to chain anchors already represented
    // by monthly/yearly preservation and should not add standalone storage.
    if (hasMonthlyOrYearlyPolicy && hasWeekly && !hasMonthly && !hasYearly) {
      continue;
    }

    const pointSizeTB = params.sizingMode === 'reverse'
      ? getGfsPointSizeAtDate(iso)
      : params.sizingMode === 'endperiod'
      ? forecastFullTB
      : params.sourceDataTB * 0.5;

    const storedContributionTB = computeStoredContributionTB(
      pointSizeTB,
      dailyChangeRate,
      hasWeekly,
      hasMonthly,
      hasYearly,
      params.gfsPolicy?.weekly ?? 0,
      iso === outermostWeeklyDate,
      iso === outermostMonthlyDate,
    );

    additionalFullTB += storedContributionTB;

    const ageDays = (targetDate.getTime() - pointDate.getTime()) / 86400000;

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

// Block-absorption multipliers reverse-engineered from live Veeam Calculator captures.
// Each GFS point absorbs the unique blocks from its covered period that no other
// surviving restore point holds. The outermost point of each GFS class carries the
// heaviest absorbed load because the chain segment it covers has no other reference.
//
// Multipliers (applied to fullSize × changeRate to get stored TB contribution):
//   Weekly inner  (W1 .. W(n-1), inside or near retention):  ×1
//   Weekly outer  (Wn, outermost):                            ×3
//   Monthly inner (M1 .. M(n-1)):                            ×5
//   Monthly outer (Mn, outermost):                           ×12
//   Yearly:        full backup size at point date             ×1 (no multiplier needed)
export function computeGfsStoredContributionTB(params: GfsStoredContributionParams): number {
  const {
    pointSizeTB,
    dailyChangeRate,
    hasWeekly,
    hasMonthly,
    hasYearly,
    weeklyPolicyCount,
    isOutermostWeekly = false,
    isOutermostMonthly = false,
  } = params;
  const normalizedRate = Math.max(0, Number.isFinite(dailyChangeRate) ? dailyChangeRate : 0);

  if (hasYearly) {
    // Yearly points hold the full backup — no factor needed.
    return pointSizeTB;
  }
  if (hasMonthly) {
    // Outermost monthly absorbs the full open-ended period before it (no older GFS).
    // Inner monthlies absorb only their own period slice.
    const factor = isOutermostMonthly ? 12 : 5;
    return pointSizeTB * Math.min(1, normalizedRate * factor);
  }
  if (hasWeekly) {
    if (weeklyPolicyCount >= 12) {
      // High weekly count — use inner factor regardless of position.
      return pointSizeTB * Math.min(1, normalizedRate * 3);
    }
    // Outermost weekly absorbs the chain segment beyond regular retention.
    // Inner weeklies sit inside (or near) retention and contribute ~1 incremental.
    const factor = isOutermostWeekly ? 3 : 1;
    return pointSizeTB * Math.min(1, normalizedRate * factor);
  }
  return pointSizeTB;
}

function computeStoredContributionTB(
  pointSizeTB: number,
  dailyChangeRate: number,
  hasWeekly: boolean,
  hasMonthly: boolean,
  hasYearly: boolean,
  weeklyPolicyCount: number,
  isOutermostWeekly = false,
  isOutermostMonthly = false,
): number {
  return computeGfsStoredContributionTB({
    pointSizeTB,
    dailyChangeRate,
    hasWeekly,
    hasMonthly,
    hasYearly,
    weeklyPolicyCount,
    isOutermostWeekly,
    isOutermostMonthly,
  });
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
