import { computeLiveWeeklyGfsHypothesis, WeeklySplitPoint } from './liveWeeklyGfsHypothesis.ts';

interface CapturedLiveCase {
  id: string;
  fullSizeTB: number;
  dailyChangeRate: number;
  retentionDays: number;
  weeklyCount: number;
  blockGenerationDays: number;
  expectedRepositoryTB: number;
  expectedWorkingSpaceTB: number;
  expectedPoints: Array<{
    name: string;
    uniqueTB: number;
    clonedTB: number;
  }>;
}

const capturedCases: CapturedLiveCase[] = [
  {
    id: 'weekly-1-small',
    fullSizeTB: 0.5,
    dailyChangeRate: 0.05,
    retentionDays: 7,
    weeklyCount: 1,
    blockGenerationDays: 10,
    expectedRepositoryTB: 1.4,
    expectedWorkingSpaceTB: 0.53,
    expectedPoints: [
      { name: 'D14', uniqueTB: 0.5, clonedTB: 0 },
      { name: 'W1', uniqueTB: 0.03, clonedTB: 0.48 },
    ],
  },
  {
    id: 'weekly-2-small',
    fullSizeTB: 0.5,
    dailyChangeRate: 0.05,
    retentionDays: 7,
    weeklyCount: 2,
    blockGenerationDays: 10,
    expectedRepositoryTB: 1.4,
    expectedWorkingSpaceTB: 0.53,
    expectedPoints: [
      { name: 'W2', uniqueTB: 0.5, clonedTB: 0 },
      { name: 'W1', uniqueTB: 0.03, clonedTB: 0.48 },
    ],
  },
  {
    id: 'weekly-3-small',
    fullSizeTB: 0.5,
    dailyChangeRate: 0.05,
    retentionDays: 7,
    weeklyCount: 3,
    blockGenerationDays: 10,
    expectedRepositoryTB: 1.4,
    expectedWorkingSpaceTB: 0.53,
    expectedPoints: [
      { name: 'W3', uniqueTB: 0.5, clonedTB: 0 },
      { name: 'W2', uniqueTB: 0.08, clonedTB: 0.43 },
      { name: 'W1', uniqueTB: 0.03, clonedTB: 0.48 },
    ],
  },
  {
    id: 'weekly-4-small',
    fullSizeTB: 0.5,
    dailyChangeRate: 0.05,
    retentionDays: 7,
    weeklyCount: 4,
    blockGenerationDays: 10,
    expectedRepositoryTB: 1.5,
    expectedWorkingSpaceTB: 0.53,
    expectedPoints: [
      { name: 'W4', uniqueTB: 0.5, clonedTB: 0 },
      { name: 'W3', uniqueTB: 0.08, clonedTB: 0.43 },
      { name: 'W2', uniqueTB: 0.08, clonedTB: 0.43 },
      { name: 'W1', uniqueTB: 0.03, clonedTB: 0.48 },
    ],
  },
  {
    id: 'weekly-5-small',
    fullSizeTB: 0.5,
    dailyChangeRate: 0.05,
    retentionDays: 7,
    weeklyCount: 5,
    blockGenerationDays: 10,
    expectedRepositoryTB: 1.6,
    expectedWorkingSpaceTB: 0.53,
    expectedPoints: [
      { name: 'W5', uniqueTB: 0.5, clonedTB: 0 },
      { name: 'W4', uniqueTB: 0.08, clonedTB: 0.43 },
      { name: 'W3', uniqueTB: 0.08, clonedTB: 0.43 },
      { name: 'W2', uniqueTB: 0.08, clonedTB: 0.43 },
      { name: 'W1', uniqueTB: 0.03, clonedTB: 0.48 },
    ],
  },
  {
    id: 'weekly-2-large',
    fullSizeTB: 6.66,
    dailyChangeRate: 0.10,
    retentionDays: 7,
    weeklyCount: 2,
    blockGenerationDays: 10,
    expectedRepositoryTB: 21.7,
    expectedWorkingSpaceTB: 6.35,
    expectedPoints: [
      { name: 'W2', uniqueTB: 6.66, clonedTB: 0 },
      { name: 'W1', uniqueTB: 0.67, clonedTB: 5.99 },
    ],
  },
];

function main(): void {
  console.log('Live weekly GFS hypothesis validation');
  console.log('');

  let exactPointPatternMatches = 0;

  for (const capturedCase of capturedCases) {
    const actual = computeLiveWeeklyGfsHypothesis({
      fullSizeTB: capturedCase.fullSizeTB,
      dailyChangeRate: capturedCase.dailyChangeRate,
      retentionDays: capturedCase.retentionDays,
      weeklyCount: capturedCase.weeklyCount,
      blockGenerationDays: capturedCase.blockGenerationDays,
    });

    const pointChecks = capturedCase.expectedPoints.map((expectedPoint) => {
      const actualPoint = actual.points.find((point) => point.name === expectedPoint.name);
      return comparePoint(actualPoint, expectedPoint.name, expectedPoint.uniqueTB, expectedPoint.clonedTB);
    });

    const matches = pointChecks.every((check) => check.ok) && actual.points.length === capturedCase.expectedPoints.length;
    if (matches) exactPointPatternMatches += 1;

    console.log(`${capturedCase.id}: ${matches ? 'MATCH' : 'MISMATCH'}`);
    console.log(`  full=${capturedCase.fullSizeTB.toFixed(2)} TB daily=${(capturedCase.dailyChangeRate * 100).toFixed(2)}% retention=${capturedCase.retentionDays}d weekly=${capturedCase.weeklyCount} blockGen=${capturedCase.blockGenerationDays}d`);
    console.log(`  derived daily unique=${actual.dailyUniqueTB.toFixed(6)} TB`);
    console.log(`  derived middle weekly unique=${actual.middleWeeklyUniqueTB.toFixed(6)} TB`);
    for (const check of pointChecks) {
      console.log(`  ${check.ok ? '✓' : '✗'} ${check.detail}`);
    }
    if (actual.points.length !== capturedCase.expectedPoints.length) {
      console.log(`  ✗ point count mismatch: actual=${actual.points.length} expected=${capturedCase.expectedPoints.length}`);
    }
    console.log('');
  }

  console.log(`Pattern matches: ${exactPointPatternMatches}/${capturedCases.length}`);
  console.log('');
  console.log('Current hypothesis');
  console.log('  1. Daily unique size is linear: fullSize * dailyChangeRate.');
  console.log('  2. W1 uses one daily unique slice plus cloned remainder.');
  console.log('  3. Intermediate weekly points use (blockGenerationDays - retentionDays) daily slices plus cloned remainder.');
  console.log('  4. The oldest preserved weekly aligns to a full chain anchor when weeklyCount >= 2.');
  console.log('  5. The single-weekly case is special: the full anchor remains as a non-GFS daily full (D14 in the captured case), while W1 stays split.');
}

function comparePoint(actualPoint: WeeklySplitPoint | undefined, pointName: string, expectedUniqueTB: number, expectedClonedTB: number): { ok: boolean; detail: string } {
  if (!actualPoint) {
    return {
      ok: false,
      detail: `${pointName}: missing actual point`,
    };
  }

  const uniqueMatches = roundedEquals(actualPoint.uniqueTB, expectedUniqueTB);
  const clonedMatches = roundedEquals(actualPoint.clonedTB, expectedClonedTB);
  return {
    ok: uniqueMatches && clonedMatches,
    detail: `${pointName}: actual unique=${actualPoint.uniqueTB.toFixed(2)} cloned=${actualPoint.clonedTB.toFixed(2)} expected unique=${expectedUniqueTB.toFixed(2)} cloned=${expectedClonedTB.toFixed(2)}`,
  };
}

function roundedEquals(actual: number, expected: number): boolean {
  return Math.abs(roundDisplay(actual) - roundDisplay(expected)) <= 0.01;
}

function roundDisplay(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

main();