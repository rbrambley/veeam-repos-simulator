import { computeSimulatorPlanned, type ScenarioConfig } from '../models/plannedCapacityCalculator.ts';
import { computeVeeamWorkingSpaceTB } from '../models/veeam.ts';

const START_DATE = '2026-05-02';
const FORECAST_YEARS = 3;

const scenarios: Array<{ id: string; expected: number; config: ScenarioConfig }> = [
  {
    id: 'ti-das-3yr-gfs-wmy',
    expected: 3.10,
    config: {
      repositoryType: 'DAS',
      sourceDataTB: 1,
      annualGrowthRatePct: 5,
      dailyChangeRatePct: 5,
      retention: 14,
      gfsPolicy: { weekly: 4, monthly: 3, yearly: 2 },
      offloadAfterDays: 14,
      archiveAfterDays: 30,
      hasArchiveTier: false,
      copyEnabled: false,
      moveEnabled: false,
    },
  },
  {
    id: 'ti-das-sla-minimum-5yr',
    expected: 3.10,
    config: {
      repositoryType: 'DAS',
      sourceDataTB: 1,
      annualGrowthRatePct: 5,
      dailyChangeRatePct: 5,
      retention: 14,
      gfsPolicy: { weekly: 4, monthly: 3, yearly: 2 },
      offloadAfterDays: 14,
      archiveAfterDays: 30,
      hasArchiveTier: false,
      copyEnabled: false,
      moveEnabled: false,
    },
  },
  {
    id: 'ti-das-chain-rp-drift-3yr',
    expected: 3.10,
    config: {
      repositoryType: 'DAS',
      sourceDataTB: 1,
      annualGrowthRatePct: 5,
      dailyChangeRatePct: 5,
      retention: 14,
      gfsPolicy: { weekly: 4, monthly: 3, yearly: 2 },
      offloadAfterDays: 14,
      archiveAfterDays: 30,
      hasArchiveTier: false,
      copyEnabled: false,
      moveEnabled: false,
    },
  },
  {
    id: 'ti-das-high-retention-drift-3yr',
    expected: 3.50,
    config: {
      repositoryType: 'DAS',
      sourceDataTB: 1,
      annualGrowthRatePct: 5,
      dailyChangeRatePct: 5,
      retention: 30,
      gfsPolicy: { weekly: 4, monthly: 3, yearly: 2 },
      offloadAfterDays: 14,
      archiveAfterDays: 30,
      hasArchiveTier: false,
      copyEnabled: false,
      moveEnabled: false,
    },
  },
];

function fmt(n: number): string {
  return n.toFixed(3);
}

for (const s of scenarios) {
  const r = computeSimulatorPlanned(s.config, START_DATE, FORECAST_YEARS, 'reverse');
  const ws = computeVeeamWorkingSpaceTB(s.config.sourceDataTB);
  const chainOnly = r.plannedCapacityTB - ws - r.gfsStorageTB;
  const delta = r.plannedCapacityTB - s.expected;
  console.log('============================================================');
  console.log(`Scenario: ${s.id}`);
  console.log(`Actual=${fmt(r.plannedCapacityTB)} Expected=${fmt(s.expected)} Delta=${fmt(delta)}`);
  console.log(`Components: WS=${fmt(ws)} Chain=${fmt(chainOnly)} GFS=${fmt(r.gfsStorageTB)}`);
}
