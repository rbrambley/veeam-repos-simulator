import { computeSimulatorPlanned, type ScenarioConfig } from '../models/plannedCapacityCalculator.ts';
import { computeVeeamWorkingSpaceTB } from '../models/veeam.ts';

const START_DATE = '2026-05-02';
const FORECAST_YEARS = 3;

const scenarios: Array<{ id: string; config: ScenarioConfig; expectedPlannedCapacityTB: number }> = [
  {
    id: 'od-das-wmy-weekly-size-nonzero',
    config: {
      repositoryType: 'DAS',
      sourceDataTB: 2,
      annualGrowthRatePct: 10,
      dailyChangeRatePct: 5,
      retention: 14,
      gfsPolicy: { weekly: 4, monthly: 8, yearly: 2 },
      offloadAfterDays: 0,
      archiveAfterDays: 0,
      hasArchiveTier: false,
      copyEnabled: false,
      moveEnabled: false,
    },
    expectedPlannedCapacityTB: 8.4,
  },
  {
    id: 'das-monthly6-retention7-3y-regression',
    config: {
      repositoryType: 'DAS',
      jobType: 'ForwardIncremental',
      sourceDataTB: 2,
      annualGrowthRatePct: 10,
      dailyChangeRatePct: 5,
      retention: 7,
      gfsPolicy: { weekly: 0, monthly: 6, yearly: 0 },
      offloadAfterDays: 7,
      archiveAfterDays: 14,
      hasArchiveTier: false,
      copyEnabled: false,
      moveEnabled: false,
    },
    expectedPlannedCapacityTB: 5.2,
  },
];

function fmt(n: number): string {
  return n.toFixed(3);
}

for (const s of scenarios) {
  const result = computeSimulatorPlanned(s.config, START_DATE, FORECAST_YEARS, 'reverse');
  const ws = computeVeeamWorkingSpaceTB(s.config.sourceDataTB);
  const chainOnly = result.plannedCapacityTB - ws - result.gfsStorageTB;
  const delta = result.plannedCapacityTB - s.expectedPlannedCapacityTB;
  const pct = Math.abs(s.expectedPlannedCapacityTB) > 1e-6 ? Math.abs(delta / s.expectedPlannedCapacityTB) * 100 : Math.abs(delta);

  console.log('============================================================');
  console.log(`Scenario: ${s.id}`);
  console.log(`Expected planned capacity: ${fmt(s.expectedPlannedCapacityTB)} TB`);
  console.log(`Actual planned capacity:   ${fmt(result.plannedCapacityTB)} TB`);
  console.log(`Delta:                    ${fmt(delta)} TB (${fmt(pct)}%)`);
  console.log(`Components:`);
  console.log(`  Working Space:          ${fmt(ws)} TB`);
  console.log(`  Active Chain (derived): ${fmt(chainOnly)} TB`);
  console.log(`  GFS Storage:            ${fmt(result.gfsStorageTB)} TB`);
  console.log('');
}
