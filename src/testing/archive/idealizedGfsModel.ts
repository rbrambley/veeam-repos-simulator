export interface GfsPointBreakdown {
  fullSizeTB: number;
  spacingDays: number;
  dailyChangeRate: number;
  uniqueTB: number;
  clonedTB: number;
}

export interface GfsValidationCase {
  restorePoint: string;
  spacingDays: number;
}

export function computeIdealizedGfsBreakdown(fullSizeTB: number, dailyChangeRate: number, spacingDays: number): GfsPointBreakdown {
  const safeFullSizeTB = Math.max(0, fullSizeTB);
  const safeDailyChangeRate = clampRate(dailyChangeRate);
  const safeSpacingDays = Math.max(0, spacingDays);
  const uniqueTB = safeFullSizeTB * (1 - Math.pow(1 - safeDailyChangeRate, safeSpacingDays));
  const clonedTB = safeFullSizeTB - uniqueTB;

  return {
    fullSizeTB: safeFullSizeTB,
    spacingDays: safeSpacingDays,
    dailyChangeRate: safeDailyChangeRate,
    uniqueTB,
    clonedTB,
  };
}

export function computeCurrentForecastGfsBreakdown(fullSizeTB: number, spacingDays: number, dailyChangeRate: number): GfsPointBreakdown {
  const safeFullSizeTB = Math.max(0, fullSizeTB);
  return {
    fullSizeTB: safeFullSizeTB,
    spacingDays: Math.max(0, spacingDays),
    dailyChangeRate: clampRate(dailyChangeRate),
    uniqueTB: safeFullSizeTB,
    clonedTB: 0,
  };
}

export function computeCurrentEngineSyntheticFullBreakdown(fullSizeTB: number, dailyChangeRate: number, spacingDays: number): GfsPointBreakdown {
  const safeFullSizeTB = Math.max(0, fullSizeTB);
  const safeDailyChangeRate = clampRate(dailyChangeRate);
  return {
    fullSizeTB: safeFullSizeTB,
    spacingDays: Math.max(0, spacingDays),
    dailyChangeRate: safeDailyChangeRate,
    uniqueTB: safeFullSizeTB * safeDailyChangeRate,
    clonedTB: 0,
  };
}

export function isWithinTolerance(actual: number, expected: number, tolerance = 1e-9): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

export function buildValidationMatrix(): GfsValidationCase[] {
  return [
    { restorePoint: 'W1', spacingDays: 7 },
    { restorePoint: 'W2', spacingDays: 7 },
    { restorePoint: 'W3', spacingDays: 7 },
    { restorePoint: 'M1', spacingDays: 30 },
    { restorePoint: 'M2', spacingDays: 30 },
    { restorePoint: 'M3', spacingDays: 30 },
    { restorePoint: 'Y1', spacingDays: 365 },
    { restorePoint: 'Y2', spacingDays: 365 },
    { restorePoint: 'Y3', spacingDays: 365 },
    { restorePoint: 'W5', spacingDays: 7 },
    { restorePoint: 'M1-mixed', spacingDays: 30 },
    { restorePoint: 'Y1-mixed', spacingDays: 365 },
  ];
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 0;
  if (rate < 0) return 0;
  if (rate > 1) return 1;
  return rate;
}