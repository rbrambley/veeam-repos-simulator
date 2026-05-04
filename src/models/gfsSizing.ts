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

  const weeklySet = new Set(weeklyDates);
  const monthlySet = new Set(monthlyDates);
  const yearlySet = new Set(yearlyDates);
  const distinctDates = Array.from(new Set([...weeklyDates, ...monthlyDates, ...yearlyDates]));
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

    const storedContributionTB = computeStoredContributionTB(pointSizeTB, dailyChangeRate, hasWeekly, hasMonthly, hasYearly);

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
      additionalPerfFullTB += storedContributionTB;
      additionalCapFullTB += storedContributionTB;
      if (params.hasArchiveTier && ageDays >= (params.offloadAfterDays + params.archiveAfterDays)) {
        additionalArchFullTB += storedContributionTB;
        additionalCapFullTB = Math.max(0, additionalCapFullTB - storedContributionTB);
      }
    } else {
      if (ageDays < params.offloadAfterDays) {
        additionalPerfFullTB += storedContributionTB;
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

function computeStoredContributionTB(
  pointSizeTB: number,
  dailyChangeRate: number,
  hasWeekly: boolean,
  hasMonthly: boolean,
  hasYearly: boolean,
): number {
  // Mixed captures indicate weekly points are effectively anchor labels when
  // monthly/yearly retention exists; monthly/yearly drive net additional data.
  if (hasMonthly || hasYearly) {
    const monthlyContribution = hasMonthly
      ? Math.min(pointSizeTB, pointSizeTB * dailyChangeRate * 5)
      : 0;
    const yearlyContribution = hasYearly
      ? Math.min(pointSizeTB, pointSizeTB * dailyChangeRate * 18)
      : 0;
    return Math.max(monthlyContribution, yearlyContribution);
  }

  // Preserve weekly-only legacy behavior until dedicated weekly model capture.
  void hasWeekly;
  return pointSizeTB;
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
