import { VeeamSimulator } from '../simulator/engine.ts';
import { computeGfsStoredContributionTB } from '../models/gfsSizing.ts';
import type { BackupChain, BackupJob, Repository, SimulationState, SOBRConfig } from '../models/veeam.ts';

type ScenarioConfig = {
  id: string;
  startDate: string;
  totalDays: number;
  sourceDataTB: number;
  dailyChangeRatePct: number;
  annualGrowthRatePct: number;
  retention: number;
  gfsPolicy: { weekly: number; monthly: number; yearly: number };
  offloadAfterDays: number;
  archiveAfterDays: number;
  hasArchiveTier: boolean;
  copyEnabled: boolean;
  moveEnabled: boolean;
  generationPeriodDays: number;
  performanceImmutabilityDays: number;
  capacityImmutabilityDays: number;
  archiveImmutabilityDays: number;
};

const TARGET_SCENARIOS: ScenarioConfig[] = [
  {
    id: 'ix-gfs-wmy-copy-archive',
    startDate: '2026-05-02',
    totalDays: 400,
    sourceDataTB: 1,
    dailyChangeRatePct: 5,
    annualGrowthRatePct: 0,
    retention: 60,
    gfsPolicy: { weekly: 4, monthly: 3, yearly: 2 },
    offloadAfterDays: 14,
    archiveAfterDays: 14,
    hasArchiveTier: true,
    copyEnabled: true,
    moveEnabled: false,
    generationPeriodDays: 10,
    performanceImmutabilityDays: 0,
    capacityImmutabilityDays: 0,
    archiveImmutabilityDays: 0,
  },
  {
    id: 'ix-gfs-wmy-copy-archive-immutability',
    startDate: '2026-05-02',
    totalDays: 500,
    sourceDataTB: 1,
    dailyChangeRatePct: 5,
    annualGrowthRatePct: 0,
    retention: 60,
    gfsPolicy: { weekly: 4, monthly: 3, yearly: 2 },
    offloadAfterDays: 14,
    archiveAfterDays: 14,
    hasArchiveTier: true,
    copyEnabled: true,
    moveEnabled: false,
    generationPeriodDays: 10,
    performanceImmutabilityDays: 7,
    capacityImmutabilityDays: 14,
    archiveImmutabilityDays: 21,
  },
];

function createInitialState(config: ScenarioConfig): SimulationState {
  const repoId = 'repo-1';
  const jobId = `job-${config.id}`;

  const sobrConfig: SOBRConfig = {
    performanceCapacityTB: 50,
    capacityCapacityTB: 200,
    archiveCapacityTB: 500,
    offloadAfterDays: config.offloadAfterDays,
    archiveAfterDays: config.archiveAfterDays,
    generationPeriodDays: config.generationPeriodDays,
    performanceImmutabilityDays: config.performanceImmutabilityDays,
    capacityImmutabilityDays: config.capacityImmutabilityDays,
    archiveImmutabilityDays: config.archiveImmutabilityDays,
    hasArchiveTier: config.hasArchiveTier,
    copyEnabled: config.copyEnabled,
    moveEnabled: config.moveEnabled,
  };

  const repository: Repository = {
    id: repoId,
    name: `Repo ${config.id}`,
    type: 'SOBR',
    capacityTB: 1000,
    sobrConfig,
  };

  const job: BackupJob = {
    id: jobId,
    name: `Job ${config.id}`,
    type: 'ForwardIncremental',
    repositoryId: repoId,
    sourceDataTB: config.sourceDataTB,
    dailyChangeRatePct: config.dailyChangeRatePct,
    annualGrowthRatePct: config.annualGrowthRatePct,
    forecastYears: 3,
    schedule: {
      frequency: 'Daily',
      timeOfDay: '02:00',
      syntheticFullDay: 6,
    },
    retention: {
      restorePoints: config.retention,
      slaDays: config.retention,
    },
    gfsPolicy: config.gfsPolicy,
  };

  const chain: BackupChain = {
    id: `chain-${config.id}`,
    jobId,
    status: 'Active',
    restorePoints: [],
  };

  return {
    repositories: [repository],
    jobs: [job],
    chains: [chain],
    generations: [],
    restorePoints: [],
    blocks: [],
    date: config.startDate,
    startDate: config.startDate,
  };
}

function diffDays(laterIso: string, earlierIso: string): number {
  const later = new Date(`${laterIso}T00:00:00.000Z`).getTime();
  const earlier = new Date(`${earlierIso}T00:00:00.000Z`).getTime();
  return Math.floor((later - earlier) / 86400000);
}

function pointSizeAtDateTB(config: ScenarioConfig, rpDateIso: string): number {
  const daysSinceStart = diffDays(rpDateIso, config.startDate);
  const yearsElapsed = Math.max(0, daysSinceStart / 365);
  return config.sourceDataTB * Math.pow(1 + config.annualGrowthRatePct / 100, yearsElapsed);
}

function formatTB(n: number): string {
  return n.toFixed(3);
}

function runScenario(config: ScenarioConfig): void {
  const sim = new VeeamSimulator(createInitialState(config));
  for (let day = 0; day < config.totalDays; day += 1) {
    sim.nextDay();
  }

  const horizonDate = sim.state.date;
  const dailyRate = Math.max(0, config.dailyChangeRatePct / 100);

  let enginePerfTB = 0;
  let engineCapTB = 0;
  let engineArchTB = 0;

  let modelPerfTB = 0;
  let modelCapTB = 0;
  let modelArchTB = 0;

  let candidatePerfTB = 0;
  let candidateCapTB = 0;
  let candidateArchTB = 0;

  for (const rp of sim.state.restorePoints.filter((p) => !!p.isGFS)) {
    if (rp.hasPerformanceData) enginePerfTB += sim.getRestorePointSizeForTier(rp.id, 'Performance');
    if (rp.hasCapacityData) engineCapTB += sim.getRestorePointSizeForTier(rp.id, 'Capacity');
    if (rp.hasArchiveData) engineArchTB += sim.getRestorePointSizeForTier(rp.id, 'Archive');

    const ageDays = diffDays(horizonDate, rp.date);
    const contributionTB = computeGfsStoredContributionTB({
      pointSizeTB: pointSizeAtDateTB(config, rp.date),
      dailyChangeRate: dailyRate,
      ageDays,
    });

    // Current copy+yearly route
    if (ageDays < 14) {
      modelPerfTB += contributionTB;
    }
    modelCapTB += contributionTB;
    if (ageDays >= 28) {
      modelArchTB += contributionTB;
      modelCapTB -= contributionTB;
    }

    // Candidate route tested conceptually: keep perf to 21, archive from 42
    if (ageDays < 21) {
      candidatePerfTB += contributionTB;
    }
    candidateCapTB += contributionTB;
    if (ageDays >= 42) {
      candidateArchTB += contributionTB;
      candidateCapTB -= contributionTB;
    }
  }

  console.log('============================================================');
  console.log(`Scenario: ${config.id}`);
  console.log(`Horizon date: ${horizonDate}`);
  console.log(`Engine GFS tiers:    P=${formatTB(enginePerfTB)} C=${formatTB(engineCapTB)} A=${formatTB(engineArchTB)}`);
  console.log(`Model GFS tiers:     P=${formatTB(modelPerfTB)} C=${formatTB(modelCapTB)} A=${formatTB(modelArchTB)}`);
  console.log(`Candidate GFS tiers: P=${formatTB(candidatePerfTB)} C=${formatTB(candidateCapTB)} A=${formatTB(candidateArchTB)}`);
  console.log('============================================================');
  console.log('');
}

for (const scenario of TARGET_SCENARIOS) {
  runScenario(scenario);
}
