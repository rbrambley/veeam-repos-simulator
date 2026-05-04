import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { VeeamSimulator } from '../simulator/engine.ts';
import { SimulationState, Repository, BackupJob, BackupChain, SOBRConfig } from '../models/veeam.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TestScenario {
  id: string;
  name: string;
  description: string;
  config: {
    repositoryType: 'DAS' | 'SOBR';
    jobType: string;
    sourceDataTB: number;
    annualGrowthRatePct: number;
    dailyChangeRatePct: number;
    retention: number;
    gfsPolicy: { weekly: number; monthly: number; yearly: number };
    offloadAfterDays: number;
    archiveAfterDays: number;
    generationPeriodDays?: number;
    performanceImmutabilityDays?: number;
    capacityImmutabilityDays?: number;
    archiveImmutabilityDays?: number;
    hasArchiveTier: boolean;
    copyEnabled: boolean;
    moveEnabled: boolean;
  };
  totalDays: number;
  checkpoints: Array<{
    day: number;
    description?: string;
  }>;
  finalState: {
    expectedRPCount?: number;
    expectedArchivePointCountAtLeast?: number;
    minArchivePointAgeDays?: number;
    noCapacityResidueInArchivedChains?: boolean;
  };
}

function getSortedDates(points: Array<{ date: string }>): string[] {
  return points.map((p) => p.date).sort();
}

function buildStateSignature(sim: VeeamSimulator): string {
  const chains = sim.state.chains
    .map((chain) => ({
      id: chain.id,
      jobId: chain.jobId,
      status: chain.status,
      inactiveSince: chain.inactiveSince,
      offloadComplete: !!chain.offloadComplete,
      offloadCompletedAt: chain.offloadCompletedAt,
      performancePrunedAt: chain.performancePrunedAt,
      restorePointIds: chain.restorePoints.map((rp) => rp.id).sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const restorePoints = sim.state.restorePoints
    .map((rp) => ({
      id: rp.id,
      chainId: rp.chainId,
      date: rp.date,
      type: rp.type,
      isGFS: !!rp.isGFS,
      isGlobalBase: !!rp.isGlobalBase,
      hasPerformanceData: !!rp.hasPerformanceData,
      hasCapacityData: !!rp.hasCapacityData,
      hasArchiveData: !!rp.hasArchiveData,
      sobrTier: rp.sobrTier,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return JSON.stringify({
    date: sim.state.date,
    chains,
    restorePoints,
  });
}

function assertDailyLifecycleInvariants(sim: VeeamSimulator, scenario: TestScenario, day: number): void {
  for (const chain of sim.state.chains) {
    if (chain.status === 'Active' && chain.offloadComplete) {
      throw new Error(`Day ${day}: active chain ${chain.id} is marked offloadComplete`);
    }

    if (chain.performancePrunedAt) {
      if (!chain.offloadComplete) {
        throw new Error(`Day ${day}: chain ${chain.id} was pruned before offload completed`);
      }
      if (chain.offloadCompletedAt && chain.performancePrunedAt < chain.offloadCompletedAt) {
        throw new Error(`Day ${day}: chain ${chain.id} was pruned before its offload completion date`);
      }

      const perfResidue = chain.restorePoints.filter((rp) => !!rp.hasPerformanceData || rp.sobrTier === 'Performance');
      if (perfResidue.length > 0) {
        throw new Error(`Day ${day}: chain ${chain.id} still has ${perfResidue.length} Performance point(s) after pruning`);
      }
    }
  }

  if (scenario.config.repositoryType === 'SOBR' && scenario.config.moveEnabled) {
    const activeChains = sim.state.chains.filter((chain) => chain.status === 'Active');
    for (const chain of activeChains) {
      const capacityOnlyPoints = chain.restorePoints.filter((rp) => !rp.hasPerformanceData && !!rp.hasCapacityData);
      if (capacityOnlyPoints.length > 0) {
        throw new Error(`Day ${day}: active chain ${chain.id} has ${capacityOnlyPoints.length} Capacity-only point(s)`);
      }
    }
  }
}

function simulateScenario(scenario: TestScenario): VeeamSimulator {
  const initialState = createInitialState(scenario.config);
  const sim = new VeeamSimulator(initialState);

  for (let day = 1; day <= scenario.totalDays; day++) {
    sim.nextDay();

    for (const job of sim.state.jobs) {
      const jobChainIds = new Set(
        sim.state.chains.filter((c) => c.jobId === job.id).map((c) => c.id)
      );
      const baseCount = sim.state.restorePoints.filter(
        (rp) => jobChainIds.has(rp.chainId) && rp.isGlobalBase
      ).length;
      if (baseCount > 1) {
        throw new Error(
          `Day ${day}: Job "${job.id}" has ${baseCount} base fulls (expected at most 1)`
        );
      }
    }

    assertDailyLifecycleInvariants(sim, scenario, day);
  }

  return sim;
}

// Keep scenario execution deterministic across machines and calendar days.
const DEFAULT_SCENARIO_START_DATE = '2026-05-02';

function createInitialState(config: TestScenario['config']): SimulationState {
  const repoId = 'repo-1';
  const jobId = 'job-1';

  const sobrConfig: SOBRConfig | undefined =
    config.repositoryType === 'SOBR'
      ? {
          performanceCapacityTB: 10,
          capacityCapacityTB: 100,
          archiveCapacityTB: 500,
          copyEnabled: config.copyEnabled,
          moveEnabled: config.moveEnabled,
          offloadAfterDays: config.offloadAfterDays,
          archiveAfterDays: config.archiveAfterDays,
          generationPeriodDays: config.generationPeriodDays ?? 10,
          performanceImmutabilityDays: config.performanceImmutabilityDays ?? 7,
          capacityImmutabilityDays: config.capacityImmutabilityDays ?? 0,
          archiveImmutabilityDays: config.archiveImmutabilityDays ?? 0,
          hasArchiveTier: config.hasArchiveTier,
        }
      : undefined;

  const repository: Repository = {
    id: repoId,
    name: 'Test Repository',
    type: config.repositoryType,
    capacityTB: 500,
    sobrConfig,
  };

  const job: BackupJob = {
    id: jobId,
    name: 'Test Job',
    type: 'ForwardIncremental',
    repositoryId: repoId,
    sourceDataTB: config.sourceDataTB,
    dailyChangeRatePct: config.dailyChangeRatePct,
    annualGrowthRatePct: config.annualGrowthRatePct,
    forecastYears: 1,
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
    id: 'chain-1',
    jobId,
    status: 'Active',
    restorePoints: [],
  };

  const startDate = DEFAULT_SCENARIO_START_DATE;

  return {
    repositories: [repository],
    jobs: [job],
    chains: [chain],
    restorePoints: [],
    blocks: [],
    date: startDate,
    startDate,
  };
}

async function runScenario(scenario: TestScenario): Promise<boolean> {
  console.log(`\n📋 ${scenario.name}`);
  console.log(`   ID: ${scenario.id}`);
  console.log(`   Days: ${scenario.totalDays}\n`);

  try {
    const sim = simulateScenario(scenario);

    for (const checkpoint of scenario.checkpoints) {
      console.log(`   Day ${checkpoint.day}: ${checkpoint.description || 'checkpoint'}`);
      console.log(`      ✓ Checkpoint passed`);
    }

    const replaySim = simulateScenario(scenario);
    const firstSignature = buildStateSignature(sim);
    const replaySignature = buildStateSignature(replaySim);
    if (firstSignature !== replaySignature) {
      throw new Error('Determinism check failed: identical scenario produced a different final state on replay');
    }

    const sortedChainDates = getSortedDates(sim.state.restorePoints);
    if (sortedChainDates.length === 0) {
      throw new Error('Scenario produced no restore points');
    }

    // Final state verification
    const finalRpCount = sim.state.restorePoints.length;
    const baseInvariantCount = sim.state.restorePoints.filter(
      (rp) => !!rp.isGlobalBase
    ).length;
    const startDate = new Date(`${sim.state.startDate}T00:00:00.000Z`);
    const growth = (scenario.config.annualGrowthRatePct ?? 10) / 100;
    const changeRate = (scenario.config.dailyChangeRatePct ?? 5) / 100;
    const nonBaseSyntheticFulls = sim.state.restorePoints.filter(
      (rp) => rp.type === 'SyntheticFull' && !rp.isGlobalBase
    );

    const syntheticMismatches = nonBaseSyntheticFulls.filter((rp) => {
      const pointDate = new Date(`${rp.date}T00:00:00.000Z`);
      const elapsedDays = (pointDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
      const effectiveSourceTB = scenario.config.sourceDataTB * Math.pow(1 + growth, elapsedDays / 365);
      const expectedIncrementalTB = effectiveSourceTB * changeRate * 0.5;
      return Math.abs(rp.sizeGB - expectedIncrementalTB) > 0.0001;
    });

    // Verify the base is the oldest Full/SyntheticFull across ALL chains (not just the active one)
    const allJobChainIds = new Set(
      sim.state.chains
        .filter((c) => sim.state.jobs.some((j) => j.id === c.jobId))
        .map((c) => c.id)
    );
    const allFullPoints = sim.state.restorePoints
      .filter((rp) => allJobChainIds.has(rp.chainId) && (rp.type === 'Full' || rp.type === 'SyntheticFull'))
      .sort((a, b) => new Date(`${a.date}T00:00:00.000Z`).getTime() - new Date(`${b.date}T00:00:00.000Z`).getTime());
    const actualBase = sim.state.restorePoints.find((rp) => rp.isGlobalBase);
    const expectedBase = allFullPoints[0];
    const baseIsOldest = actualBase?.id === expectedBase?.id;

    console.log(`\n   Final State:`);
    const archivedPoints = sim.state.restorePoints.filter((rp) => !!rp.hasArchiveData || rp.sobrTier === 'Archive');
    const archivedPointAges = archivedPoints.map((rp) => {
      const pointDate = new Date(`${rp.date}T00:00:00.000Z`);
      const nowDate = new Date(`${sim.state.date}T00:00:00.000Z`);
      return Math.floor((nowDate.getTime() - pointDate.getTime()) / 86400000);
    });
    const archivedChainIds = new Set(archivedPoints.map((rp) => rp.chainId));
    const capacityResiduePoints = sim.state.restorePoints.filter((rp) =>
      archivedChainIds.has(rp.chainId) &&
      (!!rp.hasCapacityData || rp.sobrTier === 'Capacity') &&
      !rp.isGFS
    );

    console.log(`      RP count: ${finalRpCount}${scenario.finalState.expectedRPCount !== undefined ? ` (expected ${scenario.finalState.expectedRPCount})` : ''}`);
    console.log(`      Base invariant count: ${baseInvariantCount} (expected 1)`);
    console.log(`      Determinism replay: matched`);
    console.log(`      Base is oldest full across all chains: ${baseIsOldest ? 'yes' : `NO — base=${actualBase?.id} oldest=${expectedBase?.id}`}`);
    console.log(
      `      Non-base SyntheticFull incremental-size check: ${nonBaseSyntheticFulls.length - syntheticMismatches.length}/${nonBaseSyntheticFulls.length} passed`
    );
    if (scenario.finalState.expectedArchivePointCountAtLeast !== undefined) {
      console.log(`      Archive points: ${archivedPoints.length} (expected at least ${scenario.finalState.expectedArchivePointCountAtLeast})`);
    }
    if (scenario.finalState.minArchivePointAgeDays !== undefined) {
      const youngestArchiveAge = archivedPointAges.length > 0 ? Math.min(...archivedPointAges) : -1;
      console.log(`      Youngest archive age: ${youngestArchiveAge}d (expected >= ${scenario.finalState.minArchivePointAgeDays}d)`);
    }
    if (scenario.finalState.noCapacityResidueInArchivedChains) {
      console.log(`      Capacity residue in archived chains: ${capacityResiduePoints.length} point(s) (expected 0)`);
    }

    if (scenario.finalState.expectedRPCount !== undefined && finalRpCount !== scenario.finalState.expectedRPCount) {
      throw new Error(
        `Final RP count mismatch: expected ${scenario.finalState.expectedRPCount}, got ${finalRpCount}`
      );
    }

    if (baseInvariantCount !== 1) {
      throw new Error(
        `Base invariant mismatch: expected exactly 1 base full, got ${baseInvariantCount}`
      );
    }

    if (!baseIsOldest) {
      throw new Error(
        `Base selection wrong: base is ${actualBase?.id} (${actualBase?.date}) but oldest full across all chains is ${expectedBase?.id} (${expectedBase?.date})`
      );
    }

    if (syntheticMismatches.length > 0) {
      const first = syntheticMismatches[0];
      throw new Error(
        `Non-base SyntheticFull sizing mismatch: ${syntheticMismatches.length} point(s) failed; first=${first.id} size=${first.sizeGB.toFixed(4)} TB`
      );
    }

    if (
      scenario.finalState.expectedArchivePointCountAtLeast !== undefined &&
      archivedPoints.length < scenario.finalState.expectedArchivePointCountAtLeast
    ) {
      throw new Error(
        `Archive point count mismatch: expected at least ${scenario.finalState.expectedArchivePointCountAtLeast}, got ${archivedPoints.length}`
      );
    }

    if (scenario.finalState.minArchivePointAgeDays !== undefined) {
      const tooYoungArchive = archivedPoints.find((rp) => {
        const pointDate = new Date(`${rp.date}T00:00:00.000Z`);
        const nowDate = new Date(`${sim.state.date}T00:00:00.000Z`);
        const ageDays = Math.floor((nowDate.getTime() - pointDate.getTime()) / 86400000);
        return ageDays < scenario.finalState.minArchivePointAgeDays!;
      });

      if (tooYoungArchive) {
        throw new Error(
          `Archive timing mismatch: point ${tooYoungArchive.id} reached Archive before ${scenario.finalState.minArchivePointAgeDays}d of age`
        );
      }
    }

    if (scenario.finalState.noCapacityResidueInArchivedChains && capacityResiduePoints.length > 0) {
      throw new Error(
        `Capacity residue mismatch: archived chain still has non-GFS Capacity points (first=${capacityResiduePoints[0].id})`
      );
    }

    console.log(`✅ ${scenario.id}: All checks passed`);
    return true;
  } catch (error) {
    console.error(`❌ ${scenario.id}: ${error}`);
    return false;
  }
}

async function runAllScenarios(): Promise<void> {
  const scenariosPath = path.join(__dirname, '../../docs/test-scenarios.json');
  const scenariosData = JSON.parse(fs.readFileSync(scenariosPath, 'utf-8'));
  const idArgIndex = process.argv.indexOf('--id');
  const prefixArgIndex = process.argv.indexOf('--id-prefix');
  const scenarioId = idArgIndex >= 0 ? process.argv[idArgIndex + 1] : undefined;
  const scenarioPrefix = prefixArgIndex >= 0 ? process.argv[prefixArgIndex + 1] : undefined;
  let scenarios: TestScenario[] = scenariosData.scenarios;

  if (scenarioId) {
    scenarios = scenarios.filter((scenario) => scenario.id === scenarioId);
  }

  if (scenarioPrefix) {
    scenarios = scenarios.filter((scenario) => scenario.id.startsWith(scenarioPrefix));
  }

  if (scenarios.length === 0) {
    console.error('No scenarios matched the provided filter.');
    process.exit(1);
  }

  console.log(`\n🧪 Running ${scenarios.length} test scenarios...\n`);

  let passed = 0;
  let failed = 0;

  for (const scenario of scenarios) {
    const result = await runScenario(scenario);
    if (result) {
      passed++;
    } else {
      failed++;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 Test Summary`);
  console.log(`${'='.repeat(60)}`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`${'='.repeat(60)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

// Run tests
runAllScenarios().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
