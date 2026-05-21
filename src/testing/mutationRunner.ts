/**
 * mutationRunner.ts
 *
 * Mutation testing: deliberately breaks one VeeamSimulator method at a time,
 * then verifies the oracle suite catches the break.  Any mutation that passes
 * ALL probe scenarios without triggering a violation is a BLIND SPOT — that
 * class of engine bug can ship undetected, and a new oracle assertion is needed.
 *
 * Usage:  npx tsx src/testing/mutationRunner.ts
 *         npm run test:mutation
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { VeeamSimulator } from '../simulator/engine.ts';
import type {
  BackupJob,
  GFSPolicy,
  Repository,
  RestorePoint,
  SimulationState,
} from '../models/veeam.ts';
import {
  type DailyAssertionConfig,
  type ViolationReport,
  runDailyChecks,
} from './lifecycleOracle.ts';

// ---------------------------------------------------------------------------
// Minimal scenario types (only what the mutation runner needs)
// ---------------------------------------------------------------------------

interface ScenarioAssertions {
  singleGlobalBasePerJobEveryDay?: boolean;
  gfsWeeklyCountNeverExceedsLimit?: boolean;
  gfsMonthlyCountNeverExceedsLimit?: boolean;
  gfsYearlyCountNeverExceedsLimit?: boolean;
  slaMinimumNeverViolated?: boolean;
  maxInactiveChainsAtAnyTime?: number;
  maxRestorePointsAtAnyTime?: number;
  [key: string]: unknown;
}

interface ScenarioConfig {
  repositoryType: 'DAS' | 'SOBR';
  sourceDataTB: number;
  dailyChangeRatePct: number;
  annualGrowthRatePct: number;
  retention: number;
  gfsPolicy: GFSPolicy;
  offloadAfterDays: number;
  archiveAfterDays: number;
  performanceImmutabilityDays?: number;
  capacityImmutabilityDays?: number;
  archiveImmutabilityDays?: number;
  generationPeriodDays?: number;
  hasArchiveTier: boolean;
  copyEnabled: boolean;
  moveEnabled: boolean;
}

interface ProbeScenario {
  id: string;
  config: ScenarioConfig;
  totalDays: number;
  assertions: ScenarioAssertions;
  knownEngineGaps?: string[];
}

// ---------------------------------------------------------------------------
// Mutation definition
// ---------------------------------------------------------------------------

interface Mutation {
  id: string;
  description: string;
  targetMethod: string;
  expectedCatchingRule: string;
  /**
   * Apply the mutation to the prototype. Returns a restore function that
   * must be called after the probe run to undo the patch.
   */
  apply(): () => void;
}

// ---------------------------------------------------------------------------
// Load and filter probe scenarios
// ---------------------------------------------------------------------------

const SCENARIOS_PATH = join(process.cwd(), 'docs', 'lifecycle-test-scenarios.json');

function loadProbeScenarios(): ProbeScenario[] {
  const raw = readFileSync(SCENARIOS_PATH, 'utf8');
  // Strip JS-style single-line comments before parsing
  const stripped = raw.replace(/\/\/[^\n]*/g, '');
  const parsed = JSON.parse(stripped);
  return (parsed.scenarios as ProbeScenario[]).filter(
    (s) => !s.knownEngineGaps || s.knownEngineGaps.length === 0
  );
}

// ---------------------------------------------------------------------------
// Simulation state builder (mirrors lifecycleRunner.ts)
// ---------------------------------------------------------------------------

const START_DATE = '2026-05-02';

function buildInitialState(sc: ProbeScenario): SimulationState {
  const cfg = sc.config;
  const jobId  = `job-${sc.id}`;
  const repoId = `repo-${sc.id}`;

  const repository: Repository = {
    id: repoId,
    name: `Repo-${sc.id}`,
    type: cfg.repositoryType,
    capacityTB: 999,
    sobrConfig: cfg.repositoryType === 'SOBR'
      ? {
          performanceCapacityTB: 999,
          capacityCapacityTB: 999,
          archiveCapacityTB: 999,
          offloadAfterDays: cfg.offloadAfterDays,
          archiveAfterDays: cfg.archiveAfterDays,
          generationPeriodDays: cfg.generationPeriodDays ?? 10,
          performanceImmutabilityDays: cfg.performanceImmutabilityDays ?? 0,
          capacityImmutabilityDays: cfg.capacityImmutabilityDays ?? 0,
          archiveImmutabilityDays: cfg.archiveImmutabilityDays ?? 0,
          hasArchiveTier: cfg.hasArchiveTier,
          copyEnabled: cfg.copyEnabled,
          moveEnabled: cfg.moveEnabled,
        }
      : undefined,
  };

  const job: BackupJob = {
    id: jobId,
    name: `Job-${sc.id}`,
    type: 'SyntheticFull',
    repositoryId: repoId,
    sourceDataTB: cfg.sourceDataTB,
    dailyChangeRatePct: cfg.dailyChangeRatePct,
    annualGrowthRatePct: cfg.annualGrowthRatePct,
    forecastYears: Math.ceil(sc.totalDays / 365) + 1,
    schedule: { frequency: 'Daily', timeOfDay: '02:00', syntheticFullDay: 6 },
    retention: {
      restorePoints: cfg.retention,
      slaDays: cfg.retention,
    },
    gfsPolicy: (cfg.gfsPolicy.weekly + cfg.gfsPolicy.monthly + cfg.gfsPolicy.yearly) > 0
      ? cfg.gfsPolicy
      : undefined,
  };

  return {
    repositories: [repository],
    jobs: [job],
    chains: [],
    generations: [],
    restorePoints: [],
    blocks: [],
    date: START_DATE,
    startDate: START_DATE,
  };
}

// ---------------------------------------------------------------------------
// Run one scenario with current (possibly mutated) prototype
// Returns the first day a violation is detected, or null if none.
// ---------------------------------------------------------------------------

interface CatchResult {
  scenarioId: string;
  day: number;
  date: string;
  rule: string;
  message: string;
}

interface MutationOutcome {
  id: string;
  description: string;
  targetMethod: string;
  expectedCatchingRule: string;
  caught: boolean;
  catchResult: CatchResult | null;
}

interface MutationReport {
  generatedAt: string;
  probeScenarioCount: number;
  mutationCount: number;
  caughtCount: number;
  blindSpotCount: number;
  status: 'PASS' | 'FAIL';
  outcomes: MutationOutcome[];
}

function resolveStableGeneratedAt(reportPath: string): string {
  const override = process.env.REPORT_GENERATED_AT?.trim();
  if (override) {
    return override;
  }

  if (existsSync(reportPath)) {
    try {
      const existing = JSON.parse(readFileSync(reportPath, 'utf8')) as Partial<MutationReport>;
      if (typeof existing.generatedAt === 'string' && existing.generatedAt.length > 0) {
        return existing.generatedAt;
      }
    } catch {
      // Ignore stale or malformed report content and fall back to current time.
    }
  }

  return new Date().toISOString();
}

function runProbeScenario(sc: ProbeScenario): CatchResult | null {
  const cfg = sc.config;
  const a   = sc.assertions;

  const dailyCfg: DailyAssertionConfig = {};
  if (a.singleGlobalBasePerJobEveryDay)  dailyCfg.singleGlobalBasePerJobEveryDay = true;
  if (a.gfsWeeklyCountNeverExceedsLimit) dailyCfg.gfsWeeklyCountNeverExceedsLimit = true;
  if (a.gfsMonthlyCountNeverExceedsLimit) dailyCfg.gfsMonthlyCountNeverExceedsLimit = true;
  if (a.gfsYearlyCountNeverExceedsLimit)  dailyCfg.gfsYearlyCountNeverExceedsLimit = true;
  if (a.slaMinimumNeverViolated)          dailyCfg.slaMinimumNeverViolated = true;
  if (typeof a.maxInactiveChainsAtAnyTime === 'number') dailyCfg.maxInactiveChainsAtAnyTime = a.maxInactiveChainsAtAnyTime;
  if (typeof a.maxRestorePointsAtAnyTime === 'number')  dailyCfg.maxRestorePointsAtAnyTime  = a.maxRestorePointsAtAnyTime;

  const gfsPolicy: GFSPolicy = cfg.gfsPolicy;
  const state = buildInitialState(sc);
  const sim   = new VeeamSimulator(state);

  const deletedChainNewestPointDates = new Map<string, string>();

  for (let day = 1; day <= sc.totalDays; day++) {
    // Track deletions for SLA check
    const prevChainIds = new Set(sim.state.chains.map((c) => c.id));
    const prevPoints   = new Map(sim.state.restorePoints.map((r) => [r.id, r]));

    try {
      sim.nextDay();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Mutations may now be caught by engine-level canonical invariants before
      // lifecycle oracle checks execute. Treat that as a successful catch.
      if (message.includes('[CANONICAL_INVARIANT]')) {
        const rule = message.match(/\[CANONICAL_INVARIANT\]\s*([^:]+)/)?.[1]?.trim() || 'CANONICAL_INVARIANT';
        return {
          scenarioId: sc.id,
          day,
          date: sim.state.date,
          rule,
          message,
        };
      }
      throw error;
    }

    const deletedThisTick = new Set<string>();
    for (const id of prevChainIds) {
      if (!sim.state.chains.find((c) => c.id === id)) {
        deletedThisTick.add(id);
        const pts = [...prevPoints.values()].filter((r) => r.chainId === id);
        if (pts.length > 0) {
          const newest = pts.map((r) => r.date).sort().at(-1)!;
          deletedChainNewestPointDates.set(id, newest);
        }
      }
    }

    const violations = runDailyChecks(
      sim.state, day, START_DATE, gfsPolicy, cfg.retention,
      dailyCfg, deletedThisTick, deletedChainNewestPointDates
    );

    if (violations.length > 0) {
      const v = violations[0];
      return {
        scenarioId: sc.id,
        day,
        date: v.date,
        rule: v.violatedRule,
        message: `expected: ${v.expected} | actual: ${v.actual}`,
      };
    }
  }

  return null; // no violation found — mutation not caught by this scenario
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

// Save originals before any patching
const proto = VeeamSimulator.prototype;

const mutations: Mutation[] = [
  {
    id: 'M-01',
    description: 'Skip chain deletion — applyRetentionAndGFS is a no-op; chains accumulate forever',
    targetMethod: 'applyRetentionAndGFS',
    expectedCatchingRule: 'R-DRIFT-01 (maxInactiveChainsAtAnyTime)',
    apply() {
      const original = (proto as any).applyRetentionAndGFS;
      (proto as any).applyRetentionAndGFS = function() { return []; };
      return () => { (proto as any).applyRetentionAndGFS = original; };
    },
  },
  {
    id: 'M-02',
    description: 'Skip GFS retention pruning — applyGFSRetention is a no-op; GFS tags accumulate',
    targetMethod: 'applyGFSRetention',
    expectedCatchingRule: 'R-GFS-03 (gfsWeeklyCountNeverExceedsLimit)',
    apply() {
      const original = (proto as any).applyGFSRetention;
      (proto as any).applyGFSRetention = function() { return; };
      return () => { (proto as any).applyGFSRetention = original; };
    },
  },
  {
    id: 'M-03',
    description: 'Skip GFS tagging — tagGFSRestorePoint is a no-op; no GFS points ever created',
    targetMethod: 'tagGFSRestorePoint',
    expectedCatchingRule: 'PREDICTED BLIND SPOT (no minimum GFS count assertion)',
    apply() {
      const original = (proto as any).tagGFSRestorePoint;
      (proto as any).tagGFSRestorePoint = function() { return; };
      return () => { (proto as any).tagGFSRestorePoint = original; };
    },
  },
  {
    id: 'M-04',
    description: 'Skip base promotion — promoteChainBases is a no-op; no isGlobalBase ever set',
    targetMethod: 'promoteChainBases',
    expectedCatchingRule: 'singleGlobalBasePerJobEveryDay',
    apply() {
      const original = (proto as any).promoteChainBases;
      (proto as any).promoteChainBases = function() { return []; };
      return () => { (proto as any).promoteChainBases = original; };
    },
  },
  {
    id: 'M-05',
    description: 'Tag every restore point as weekly GFS (ignore day-of-week and type guards)',
    targetMethod: 'tagGFSRestorePoint',
    expectedCatchingRule: 'R-GFS-03 (gfsWeeklyCountNeverExceedsLimit)',
    apply() {
      const original = (proto as any).tagGFSRestorePoint;
      (proto as any).tagGFSRestorePoint = function(
        job: BackupJob, rp: RestorePoint, _date: Date, actions: string[]
      ) {
        if (!job.gfsPolicy?.weekly) return;
        (rp as any).isWeeklyGFS = true;
        (rp as any).isGFS = true;
        actions.push(`[M-05] ${rp.date} force-tagged as weekly GFS`);
      };
      return () => { (proto as any).tagGFSRestorePoint = original; };
    },
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const probes = loadProbeScenarios();
  console.log(`\nMutation Testing — ${mutations.length} mutations × ${probes.length} probe scenarios`);
  console.log('═'.repeat(72));

  let blindSpots = 0;
  const outcomes: MutationOutcome[] = [];

  for (const mutation of mutations) {
    const restore = mutation.apply();

    // Run every probe scenario; stop as soon as one catches the mutation
    let catchResult: CatchResult | null = null;
    for (const sc of probes) {
      const result = runProbeScenario(sc);
      if (result) {
        catchResult = result;
        break; // mutation caught — no need to continue
      }
    }

    restore(); // always restore before reporting

    const tag = catchResult ? '✓ CAUGHT' : '✗ MISSED (BLIND SPOT)';
    console.log(`\n[${mutation.id}] ${tag}`);
    console.log(`  Bug:      ${mutation.description}`);
    console.log(`  Expected: ${mutation.expectedCatchingRule}`);
    if (catchResult) {
      console.log(`  Caught:   scenario=${catchResult.scenarioId}  day=${catchResult.day}  rule=${catchResult.rule}`);
      console.log(`  Detail:   ${catchResult.message}`);
    } else {
      blindSpots++;
      console.log(`  ⚠️  No probe scenario detected this mutation. Add an oracle assertion to close this gap.`);
    }

    outcomes.push({
      id: mutation.id,
      description: mutation.description,
      targetMethod: mutation.targetMethod,
      expectedCatchingRule: mutation.expectedCatchingRule,
      caught: !!catchResult,
      catchResult,
    });
  }

  console.log('\n' + '═'.repeat(72));
  const caught = mutations.length - blindSpots;
  const reportPath = join(process.cwd(), 'docs', 'mutation-report.json');
  const report: MutationReport = {
    generatedAt: resolveStableGeneratedAt(reportPath),
    probeScenarioCount: probes.length,
    mutationCount: mutations.length,
    caughtCount: caught,
    blindSpotCount: blindSpots,
    status: blindSpots > 0 ? 'FAIL' : 'PASS',
    outcomes,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`Results: ${caught}/${mutations.length} mutations caught`);
  console.log(`Report: docs/mutation-report.json`);
  if (blindSpots > 0) {
    console.log(`\n⚠️  ${blindSpots} BLIND SPOT(S) found — see docs/test-improvement-plan.md for remediation.`);
    process.exit(1);
  } else {
    console.log('\n✓ All mutations caught — oracle coverage is verified.');
  }
}

main();
