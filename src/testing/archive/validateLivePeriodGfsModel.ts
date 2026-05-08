import { computeForecastGfsStatsAtYear } from '../../models/gfsSizing.js';

interface LiveCase {
  id: string;
  sourceDataTB: number;
  dailyChangeRatePct: number;
  retentionDays: number;
  weekly: number;
  monthly: number;
  yearly: number;
  expectedStoredGfsTB: number;
}

const liveCases: LiveCase[] = [
  { id: 'monthly-1-small-r7', sourceDataTB: 1, dailyChangeRatePct: 5, retentionDays: 7, weekly: 0, monthly: 1, yearly: 0, expectedStoredGfsTB: 0.125 },
  { id: 'monthly-2-small-r7', sourceDataTB: 1, dailyChangeRatePct: 5, retentionDays: 7, weekly: 0, monthly: 2, yearly: 0, expectedStoredGfsTB: 0.25 },
  { id: 'monthly-3-small-r7', sourceDataTB: 1, dailyChangeRatePct: 5, retentionDays: 7, weekly: 0, monthly: 3, yearly: 0, expectedStoredGfsTB: 0.375 },
  { id: 'yearly-1-small-r7', sourceDataTB: 1, dailyChangeRatePct: 5, retentionDays: 7, weekly: 0, monthly: 0, yearly: 1, expectedStoredGfsTB: 0.45 },
  { id: 'yearly-2-small-r7', sourceDataTB: 1, dailyChangeRatePct: 5, retentionDays: 7, weekly: 0, monthly: 0, yearly: 2, expectedStoredGfsTB: 0.9 },
  { id: 'yearly-3-small-r7', sourceDataTB: 1, dailyChangeRatePct: 5, retentionDays: 7, weekly: 0, monthly: 0, yearly: 3, expectedStoredGfsTB: 1.35 },
  { id: 'monthly-1-large-r7', sourceDataTB: 13.32, dailyChangeRatePct: 10, retentionDays: 7, weekly: 0, monthly: 1, yearly: 0, expectedStoredGfsTB: 3.33 },
  { id: 'monthly-2-large-r7', sourceDataTB: 13.32, dailyChangeRatePct: 10, retentionDays: 7, weekly: 0, monthly: 2, yearly: 0, expectedStoredGfsTB: 6.66 },
  { id: 'monthly-3-large-r7', sourceDataTB: 13.32, dailyChangeRatePct: 10, retentionDays: 7, weekly: 0, monthly: 3, yearly: 0, expectedStoredGfsTB: 9.99 },
  { id: 'yearly-1-large-r7', sourceDataTB: 13.32, dailyChangeRatePct: 10, retentionDays: 7, weekly: 0, monthly: 0, yearly: 1, expectedStoredGfsTB: 6.66 },
  { id: 'yearly-2-large-r7', sourceDataTB: 13.32, dailyChangeRatePct: 10, retentionDays: 7, weekly: 0, monthly: 0, yearly: 2, expectedStoredGfsTB: 13.32 },
  { id: 'yearly-3-large-r7', sourceDataTB: 13.32, dailyChangeRatePct: 10, retentionDays: 7, weekly: 0, monthly: 0, yearly: 3, expectedStoredGfsTB: 19.98 },
  { id: 'monthly-2-small-r14', sourceDataTB: 1, dailyChangeRatePct: 5, retentionDays: 14, weekly: 0, monthly: 2, yearly: 0, expectedStoredGfsTB: 0.25 },
  { id: 'yearly-2-small-r14', sourceDataTB: 1, dailyChangeRatePct: 5, retentionDays: 14, weekly: 0, monthly: 0, yearly: 2, expectedStoredGfsTB: 0.9 },
  { id: 'monthly-2-large-r14', sourceDataTB: 13.32, dailyChangeRatePct: 10, retentionDays: 14, weekly: 0, monthly: 2, yearly: 0, expectedStoredGfsTB: 6.66 },
  { id: 'yearly-2-large-r14', sourceDataTB: 13.32, dailyChangeRatePct: 10, retentionDays: 14, weekly: 0, monthly: 0, yearly: 2, expectedStoredGfsTB: 13.32 },
];

function main(): void {
  let matches = 0;
  console.log('Live monthly/yearly GFS model validation');
  console.log('');

  for (const liveCase of liveCases) {
    const actual = computeForecastGfsStatsAtYear({
      sourceDataTB: liveCase.sourceDataTB,
      annualGrowthRatePct: 0,
      dailyChangeRatePct: liveCase.dailyChangeRatePct,
      retentionDays: liveCase.retentionDays,
      gfsPolicy: {
        weekly: liveCase.weekly,
        monthly: liveCase.monthly,
        yearly: liveCase.yearly,
      },
      startDate: '2026-05-02',
      yearOffset: 3,
      copyEnabled: false,
      effectiveMoveEnabled: true,
      offloadAfterDays: 14,
      archiveAfterDays: 30,
      hasArchiveTier: false,
      sizingMode: 'legacy',
    });

    const ok = roundedEquals(actual.additionalFullTB, liveCase.expectedStoredGfsTB);
    if (ok) matches += 1;

    console.log(`${liveCase.id}: ${ok ? 'MATCH' : 'MISMATCH'}`);
    console.log(`  actual=${actual.additionalFullTB.toFixed(2)} TB expected=${liveCase.expectedStoredGfsTB.toFixed(2)} TB`);
  }

  console.log('');
  console.log(`Matches: ${matches}/${liveCases.length}`);
}

function roundedEquals(actual: number, expected: number): boolean {
  return Math.abs(round2(actual) - round2(expected)) <= 0.01;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

main();
