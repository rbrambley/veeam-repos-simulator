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

type Bucket = {
  label: string;
  min: number;
  max: number;
};

const BUCKETS: Bucket[] = [
  { label: '00-13', min: 0, max: 13 },
  { label: '14-20', min: 14, max: 20 },
  { label: '21-27', min: 21, max: 27 },
  { label: '28+', min: 28, max: Number.MAX_SAFE_INTEGER },
];

const TARGET_SCENARIOS: ScenarioConfig[] = [
  {
    id: 'ti-sobr-copy-3yr',
    startDate: '2026-05-02',
    totalDays: 1095,
    sourceDataTB: 1,
    dailyChangeRatePct: 5,
    annualGrowthRatePct: 5,
    retention: 30,
    gfsPolicy: { weekly: 4, monthly: 3, yearly: 0 },
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
    id: 'od-sobr-copy-full-lifecycle',
    startDate: '2026-05-02',
    totalDays: 150,
    sourceDataTB: 1,
    dailyChangeRatePct: 5,
    annualGrowthRatePct: 0,
    retention: 30,
    gfsPolicy: { weekly: 4, monthly: 3, yearly: 0 },
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

function classifyForecastCurrent(config: ScenarioConfig, ageDays: number): {
  perf: boolean;
  cap: boolean;
  arch: boolean;
} {
  const noYearlyArchiveCopy = config.hasArchiveTier && config.gfsPolicy.yearly === 0;
  const routeToPerf = noYearlyArchiveCopy
    ? ageDays < (config.offloadAfterDays + config.archiveAfterDays)
    : true;
  const archiveThresholdDays = noYearlyArchiveCopy
    ? config.archiveAfterDays
    : (config.offloadAfterDays + config.archiveAfterDays);

  const perf = routeToPerf;
  const arch = config.hasArchiveTier && ageDays >= archiveThresholdDays;
  const cap = !arch;

  return { perf, cap, arch };
}

function classifyForecastCandidate(config: ScenarioConfig, ageDays: number): {
  perf: boolean;
  cap: boolean;
  arch: boolean;
} {
  // Candidate rule tested in next attempt: align mixed W4/M3/Y0 copy shape to 7-day bucket boundaries.
  const perf = ageDays < (config.offloadAfterDays + 7);
  const arch = config.hasArchiveTier && ageDays >= (config.offloadAfterDays + 7);
  const cap = !arch;
  return { perf, cap, arch };
}

function formatTB(value: number): string {
  return value.toFixed(3);
}

function investigateScenario(config: ScenarioConfig): void {
  const sim = new VeeamSimulator(createInitialState(config));
  for (let day = 0; day < config.totalDays; day += 1) {
    sim.nextDay();
  }

  const horizonDate = sim.state.date;
  const dailyRate = Math.max(0, config.dailyChangeRatePct / 100);

  const bucketTotals = new Map<string, {
    points: number;
    contribTB: number;
    enginePerfTB: number;
    engineCapTB: number;
    engineArchTB: number;
    forecastPerfCurrentTB: number;
    forecastCapCurrentTB: number;
    forecastArchCurrentTB: number;
    forecastPerfCandidateTB: number;
    forecastCapCandidateTB: number;
    forecastArchCandidateTB: number;
  }>();

  for (const bucket of BUCKETS) {
    bucketTotals.set(bucket.label, {
      points: 0,
      contribTB: 0,
      enginePerfTB: 0,
      engineCapTB: 0,
      engineArchTB: 0,
      forecastPerfCurrentTB: 0,
      forecastCapCurrentTB: 0,
      forecastArchCurrentTB: 0,
      forecastPerfCandidateTB: 0,
      forecastCapCandidateTB: 0,
      forecastArchCandidateTB: 0,
    });
  }

  let enginePerfTB = 0;
  let engineCapTB = 0;
  let engineArchTB = 0;
  let forecastPerfCurrentTB = 0;
  let forecastCapCurrentTB = 0;
  let forecastArchCurrentTB = 0;
  let forecastPerfCandidateTB = 0;
  let forecastCapCandidateTB = 0;
  let forecastArchCandidateTB = 0;

  const gfsPoints = sim.state.restorePoints.filter((rp) => !!rp.isGFS);

  for (const rp of gfsPoints) {
    const ageDays = diffDays(horizonDate, rp.date);
    const pointSizeTB = pointSizeAtDateTB(config, rp.date);
    const contributionTB = computeGfsStoredContributionTB({
      pointSizeTB,
      dailyChangeRate: dailyRate,
      ageDays,
    });

    const bucket = BUCKETS.find((b) => ageDays >= b.min && ageDays <= b.max);
    if (!bucket) {
      continue;
    }

    const row = bucketTotals.get(bucket.label)!;
    row.points += 1;
    row.contribTB += contributionTB;

    if (rp.hasPerformanceData) {
      const v = sim.getRestorePointSizeForTier(rp.id, 'Performance');
      enginePerfTB += v;
      row.enginePerfTB += v;
    }
    if (rp.hasCapacityData) {
      const v = sim.getRestorePointSizeForTier(rp.id, 'Capacity');
      engineCapTB += v;
      row.engineCapTB += v;
    }
    if (rp.hasArchiveData) {
      const v = sim.getRestorePointSizeForTier(rp.id, 'Archive');
      engineArchTB += v;
      row.engineArchTB += v;
    }

    const current = classifyForecastCurrent(config, ageDays);
    if (current.perf) {
      forecastPerfCurrentTB += contributionTB;
      row.forecastPerfCurrentTB += contributionTB;
    }
    if (current.cap) {
      forecastCapCurrentTB += contributionTB;
      row.forecastCapCurrentTB += contributionTB;
    }
    if (current.arch) {
      forecastArchCurrentTB += contributionTB;
      row.forecastArchCurrentTB += contributionTB;
    }

    const candidate = classifyForecastCandidate(config, ageDays);
    if (candidate.perf) {
      forecastPerfCandidateTB += contributionTB;
      row.forecastPerfCandidateTB += contributionTB;
    }
    if (candidate.cap) {
      forecastCapCandidateTB += contributionTB;
      row.forecastCapCandidateTB += contributionTB;
    }
    if (candidate.arch) {
      forecastArchCandidateTB += contributionTB;
      row.forecastArchCandidateTB += contributionTB;
    }
  }

  console.log('============================================================');
  console.log(`Scenario: ${config.id}`);
  console.log(`Horizon date: ${horizonDate}`);
  console.log('------------------------------------------------------------');
  console.log(`Engine tiers (GFS only): Perf=${formatTB(enginePerfTB)} Cap=${formatTB(engineCapTB)} Arch=${formatTB(engineArchTB)}`);
  console.log(`Forecast current model (GFS only): Perf=${formatTB(forecastPerfCurrentTB)} Cap=${formatTB(forecastCapCurrentTB)} Arch=${formatTB(forecastArchCurrentTB)}`);
  console.log(`Forecast candidate 21d split (GFS only): Perf=${formatTB(forecastPerfCandidateTB)} Cap=${formatTB(forecastCapCandidateTB)} Arch=${formatTB(forecastArchCandidateTB)}`);
  console.log('------------------------------------------------------------');
  console.log('Bucket details (GFS contributions TB):');

  for (const bucket of BUCKETS) {
    const row = bucketTotals.get(bucket.label)!;
    console.log(
      `${bucket.label} points=${row.points} contrib=${formatTB(row.contribTB)} | `
      + `engine P/C/A=${formatTB(row.enginePerfTB)}/${formatTB(row.engineCapTB)}/${formatTB(row.engineArchTB)} | `
      + `current P/C/A=${formatTB(row.forecastPerfCurrentTB)}/${formatTB(row.forecastCapCurrentTB)}/${formatTB(row.forecastArchCurrentTB)} | `
      + `candidate P/C/A=${formatTB(row.forecastPerfCandidateTB)}/${formatTB(row.forecastCapCandidateTB)}/${formatTB(row.forecastArchCandidateTB)}`
    );
  }

  console.log('============================================================');
  console.log('');
}

for (const scenario of TARGET_SCENARIOS) {
  investigateScenario(scenario);
}
