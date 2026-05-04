export interface WeeklySplitPoint {
  name: string;
  uniqueTB: number;
  clonedTB: number;
  totalTB: number;
  kind: 'anchor-full' | 'weekly-edge' | 'weekly-middle' | 'daily';
}

export interface WeeklyHypothesisInput {
  fullSizeTB: number;
  dailyChangeRate: number;
  retentionDays: number;
  weeklyCount: number;
  blockGenerationDays: number;
}

export interface WeeklyHypothesisResult {
  dailyUniqueTB: number;
  middleWeeklyUniqueTB: number;
  points: WeeklySplitPoint[];
}

export function computeLiveWeeklyGfsHypothesis(input: WeeklyHypothesisInput): WeeklyHypothesisResult {
  const fullSizeTB = Math.max(0, input.fullSizeTB);
  const dailyChangeRate = clampRate(input.dailyChangeRate);
  const retentionDays = Math.max(1, Math.floor(input.retentionDays));
  const weeklyCount = Math.max(0, Math.floor(input.weeklyCount));
  const blockGenerationDays = Math.max(1, Math.floor(input.blockGenerationDays));

  const dailyUniqueTB = fullSizeTB * dailyChangeRate;
  const middleWeeklyFactorDays = Math.max(1, blockGenerationDays - retentionDays);
  const middleWeeklyUniqueTB = Math.min(fullSizeTB, dailyUniqueTB * middleWeeklyFactorDays);

  const points: WeeklySplitPoint[] = [];

  if (weeklyCount === 0) {
    points.push(buildFullPoint(`D${retentionDays + 7}`.replace('.',''), fullSizeTB, 'anchor-full'));
  } else if (weeklyCount === 1) {
    points.push(buildFullPoint(`D${retentionDays + 7}`, fullSizeTB, 'anchor-full'));
    points.push(buildSplitPoint('W1', dailyUniqueTB, fullSizeTB, 'weekly-edge'));
  } else {
    points.push(buildFullPoint(`W${weeklyCount}`, fullSizeTB, 'anchor-full'));
    for (let weeklyIndex = weeklyCount - 1; weeklyIndex >= 2; weeklyIndex -= 1) {
      points.push(buildSplitPoint(`W${weeklyIndex}`, middleWeeklyUniqueTB, fullSizeTB, 'weekly-middle'));
    }
    points.push(buildSplitPoint('W1', dailyUniqueTB, fullSizeTB, 'weekly-edge'));
  }

  return {
    dailyUniqueTB,
    middleWeeklyUniqueTB,
    points,
  };
}

function buildFullPoint(name: string, fullSizeTB: number, kind: WeeklySplitPoint['kind']): WeeklySplitPoint {
  return {
    name,
    uniqueTB: roundCalculatorDisplay(fullSizeTB),
    clonedTB: 0,
    totalTB: roundCalculatorDisplay(fullSizeTB),
    kind,
  };
}

function buildSplitPoint(name: string, uniqueTB: number, fullSizeTB: number, kind: WeeklySplitPoint['kind']): WeeklySplitPoint {
  const boundedUniqueTB = Math.min(Math.max(0, uniqueTB), fullSizeTB);
  const roundedUniqueTB = roundCalculatorDisplay(boundedUniqueTB);
  const roundedClonedTB = roundCalculatorDisplay(Math.max(0, fullSizeTB - boundedUniqueTB));
  return {
    name,
    uniqueTB: roundedUniqueTB,
    clonedTB: roundedClonedTB,
    totalTB: roundCalculatorDisplay(fullSizeTB),
    kind,
  };
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 0;
  if (rate < 0) return 0;
  if (rate > 1) return 1;
  return rate;
}

function roundCalculatorDisplay(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}