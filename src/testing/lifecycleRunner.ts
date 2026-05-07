/**
 * lifecycleRunner.ts
 *
 * Runs every scenario in docs/lifecycle-test-scenarios.json through a full
 * day-by-day simulation and applies the oracle checks from lifecycleOracle.ts
 * on every tick.
 *
 * Usage:  npx tsx src/testing/lifecycleRunner.ts
 *         npx tsx src/testing/lifecycleRunner.ts <scenario-id>   (run one)
 *         npx tsx src/testing/lifecycleRunner.ts --update-snapshots
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { VeeamSimulator } from '../simulator/engine.ts';
import type {
  BackupChain,
  BackupJob,
  GFSPolicy,
  Repository,
  SimulationState,
} from '../models/veeam.ts';
import { computeVeeamWorkingSpaceTB } from '../models/veeam.ts';
import { computeForecastGfsStatsAtYear } from '../models/gfsSizing.ts';
import {
  type DailyAssertionConfig,
  type ViolationReport,
  runDailyChecks,
  checkChainDeletionRequiresAllGensUnlocked as _unused,
  expectedGenLifecycleState,
  type GenLifecycleState,
  expectedGfsCardinality,
  weeklyGfsDates,
  monthlyGfsDates,
  yearlyGfsDates,
} from './lifecycleOracle.ts';
import {
  GoldenSnapshotManager,
  type GoldenSnapshotCheck,
} from './goldenSnapshots.ts';

// ---------------------------------------------------------------------------
// Scenario JSON types
// ---------------------------------------------------------------------------

interface ScenarioAssertions extends DailyAssertionConfig {
  oracleDiff?: boolean;
  oracleChecks?: string[];
  genWindowBoundaryCorrect?: boolean;
  genDeleteOnEqualsWindowEndPlusSla?: boolean;
  genDeleteOnExtendedByGfs?: boolean;
  genStateTransitionsMonotonic?: boolean;
  noDeletionWhileCapImmutable?: boolean;
  noDeletionWhileArchImmutable?: boolean;
  // Point-in-time assertions
  chainMustExistOnDay?: number;
  chainMustBeGoneByDay?: number;
  chainSealedOnDay?: number;
  gfsCardinalityMatchesCalendar?: boolean;
  weeklyGfsCountAtDays?: Array<{ day: number; expectedCount: number }>;
  weeklyGfsExpiryOrderCorrect?: boolean;
  monthlyGfsOnlyOnLastSaturdayOfMonth?: boolean;
  yearlyGfsOnlyOnLastSaturdayOfDecember?: boolean;
  gfsTagsStackOnSameSaturday?: boolean;
  noSeparatePointForEachGfsClass?: boolean;
  chainOffloadNotBefore?: number;
  chainOffloadBy?: number;
  noArchiveWithoutCapacity?: boolean;
  // Storage assertions
  /** Total repo storage used at end of run must not exceed this TB value */
  maxFinalStorageTB?: number;
  /** Total repo storage used at end of run must be at least this TB value */
  minFinalStorageTB?: number;
  /** (used + working space reserve) / capacityTB must not exceed this fraction (0–1) */
  maxUtilizationFraction?: number;
  /**
   * If true: simulator final stored data must exactly equal the forecast stored data.
   * Uses identical GFS bracket-table code and same start/end dates — zero tolerance.
   * A difference is a bug. DO NOT change to a numeric tolerance to make tests pass.
   */
  forecastMustMatchSimulator?: boolean;
  /**
   * Known Veeam Calculator total repository size (TB) for this exact scenario.
   * Enforces: simulator stored data + Veeam working space reserve = this value exactly.
   * Zero tolerance. A difference is a bug in the GFS model or chain formula.
   * DO NOT add a tolerance field — the formulas must be correct, not approximated.
   */
  veeamCalculatorReferenceTB?: number;
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

interface LifecycleScenario {
  id: string;
  layer: number;
  name: string;
  description: string;
  rules: string[];
  config: ScenarioConfig;
  totalDays: number;
  assertions: ScenarioAssertions;
  /** If set, violations for the listed rules are treated as SKIP (known engine gap) */
  knownEngineGaps?: string[];
  /** Mid-run policy changes: applied to the job before sim.nextDay() on the given day */
  policyChanges?: Array<{ onDay: number; newRetention: number }>;
  /** Additional jobs that write to the same repository as the primary job */
  extraJobs?: ScenarioConfig[];
}

// ---------------------------------------------------------------------------
// Build initial SimulationState from scenario config
// ---------------------------------------------------------------------------

const START_DATE = '2026-05-02'; // fixed for determinism

function buildInitialState(sc: LifecycleScenario): SimulationState {
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
      slaDays: cfg.retention, // mirror retention as SLA for simplicity
    },
    gfsPolicy: (cfg.gfsPolicy.weekly + cfg.gfsPolicy.monthly + cfg.gfsPolicy.yearly) > 0
      ? cfg.gfsPolicy
      : undefined,
  };

  const extraJobObjects: BackupJob[] = (sc.extraJobs ?? []).map((ej, idx) => ({
    id: `job${idx + 2}-${sc.id}`,
    name: `Job${idx + 2}-${sc.id}`,
    type: 'SyntheticFull',
    repositoryId: repoId,
    sourceDataTB: ej.sourceDataTB,
    dailyChangeRatePct: ej.dailyChangeRatePct,
    annualGrowthRatePct: ej.annualGrowthRatePct,
    forecastYears: Math.ceil(sc.totalDays / 365) + 1,
    schedule: { frequency: 'Daily', timeOfDay: '03:00', syntheticFullDay: 6 },
    retention: {
      restorePoints: ej.retention,
      slaDays: ej.retention,
    },
    gfsPolicy: (ej.gfsPolicy.weekly + ej.gfsPolicy.monthly + ej.gfsPolicy.yearly) > 0
      ? ej.gfsPolicy
      : undefined,
  }));

  return {
    repositories: [repository],
    jobs: [job, ...extraJobObjects],
    chains: [],
    generations: [],
    restorePoints: [],
    blocks: [],
    date: START_DATE,
    startDate: START_DATE,
  };
}

// ---------------------------------------------------------------------------
// Per-scenario runner
// ---------------------------------------------------------------------------

interface RunResult {
  id: string;
  name: string;
  passed: boolean;
  skipped: boolean;
  skippedRules?: string[];
  violations: ViolationReport[];
  days: number;
  durationMs: number;
  expectedLifecycle: ExpectedLifecycle;
  actualLifecycle: ActualLifecycle;
  goldenSnapshotChecks: GoldenSnapshotCheck[];
}

interface MutationCatchResult {
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
  catchResult: MutationCatchResult | null;
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

interface GfsSizingTestStatus {
  status: 'pass' | 'fail' | 'unknown';
  exitCode?: number;
  ranAt?: string;
}

interface GfsSizingCaseResult {
  id: string;
  category: string;
  status: 'pass' | 'fail';
  description: string;
  expected: string;
  actual: string;
}

interface GfsSizingReport {
  generatedAt: string;
  status: 'PASS' | 'FAIL';
  totalCases: number;
  passedCases: number;
  failedCases: number;
  cases: GfsSizingCaseResult[];
}

interface ExpectedLifecycle {
  milestoneNarrative: string[];
  expectedPath: string;
  expectedFinalGfs: { weekly: number; monthly: number; yearly: number };
  expectedGfsDates: {
    weekly: string[];
    monthly: string[];
    yearly: string[];
  };
  // Storage estimates
  expectedStorageSummary: string[];
  expectedMaxStorageTB: number;
  workingSpaceReserveTB: number;
  // The last Saturday on or before the run end — the reference date for all
  // storage comparisons (forecast, simulator, Veeam Calculator all target this
  // completed-chain boundary).
  parityDate: string;
}

interface DailySnapshot {
  day: number;
  date: string;
  activeChains: number;
  inactiveChains: number;
  totalRestorePoints: number;
  fullPoints: number;
  incrementalPoints: number;
  syntheticFullPoints: number;
  weeklyGfsPoints: number;
  monthlyGfsPoints: number;
  yearlyGfsPoints: number;
  perfPoints: number;
  capPoints: number;
  archPoints: number;
  // Storage usage (TB)
  totalStorageTB: number;
  perfStorageTB: number;
  capStorageTB: number;
  archStorageTB: number;
}

interface ActualLifecycle {
  actualPath: string;
  milestones: Array<{ day: number; date: string; text: string }>;
  sampledSnapshots: DailySnapshot[];
  finalSnapshot: DailySnapshot;
}

function buildExpectedPath(cfg: ScenarioConfig): string {
  if (cfg.repositoryType === 'DAS') {
    return 'Active → Inactive → Deleted';
  }
  if (cfg.moveEnabled && cfg.hasArchiveTier) {
    return 'Active → OffloadPending → OffloadComplete → PerfPruned → ArchiveResidency → Deleted';
  }
  if (cfg.moveEnabled) {
    return 'Active → OffloadPending → OffloadComplete → PerfPruned → Deleted';
  }
  if (cfg.copyEnabled && cfg.hasArchiveTier) {
    return 'Active → Inactive (copy to Capacity) → ArchiveResidency (GFS only) → Deleted';
  }
  return 'Active → Inactive (copy to Capacity) → Deleted';
}

function buildExpectedLifecycle(sc: LifecycleScenario): ExpectedLifecycle {
  // Use the last Saturday on or before the run end as the reference date.
  // The Veeam Calculator models the completed-chain state (a Saturday, after
  // the new SyntheticFull is created). Forecast and simulator must target the
  // same moment for the comparison to be structurally valid.
  const runEndDate = addDaysSimple(START_DATE, sc.totalDays);
  const parityDate = lastSaturdayOnOrBefore(runEndDate);
  const endDate = parityDate;
  const firstBackupDate = addDaysSimple(START_DATE, 1);
  const gfs = expectedGfsCardinality(firstBackupDate, endDate, sc.config.gfsPolicy);
  const weeklyDates = weeklyGfsDates(firstBackupDate, endDate).slice(-5);
  const monthlyDates = monthlyGfsDates(firstBackupDate, endDate).slice(-5);
  const yearlyDates = yearlyGfsDates(firstBackupDate, endDate).slice(-5);

  const milestones: string[] = [];
  milestones.push(`Full backup chain starts on ${START_DATE}.`);
  milestones.push(`Retention target keeps ${sc.config.retention} restore points (SLA mirrored to ${sc.config.retention}d in test harness).`);

  const g = sc.config.gfsPolicy;
  if ((g.weekly + g.monthly + g.yearly) > 0) {
    milestones.push(`GFS policy keeps up to ${g.weekly} weekly, ${g.monthly} monthly, and ${g.yearly} yearly points.`);
  }

  if (sc.config.repositoryType === 'SOBR') {
    milestones.push(`SOBR mode is ${sc.config.copyEnabled ? 'Copy' : 'Move'} with offload threshold ${sc.config.offloadAfterDays}d.`);
    if (sc.config.hasArchiveTier) {
      milestones.push(`Archive tier enabled with archive threshold ${sc.config.archiveAfterDays}d.`);
    }
    if ((sc.config.performanceImmutabilityDays ?? 0) > 0 || (sc.config.capacityImmutabilityDays ?? 0) > 0 || (sc.config.archiveImmutabilityDays ?? 0) > 0) {
      milestones.push(
        `Immutability windows: Performance ${sc.config.performanceImmutabilityDays ?? 0}d, Capacity ${sc.config.capacityImmutabilityDays ?? 0}d, Archive ${sc.config.archiveImmutabilityDays ?? 0}d.`
      );
    }
  }

  // ── Storage estimate ─────────────────────────────────────────────────────
  // Engine uses: Full = sourceTB × 0.5, SyntheticFull = same as Incremental until promoted as base.
  // promoteChainBases() runs every day and inflates the OLDEST SyntheticFull (the global base)
  // to full size. All other SyntheticFulls stay at incremental size.
  //
  // Steady-state peak (SLA overlap window, both chains coexist):
  //   Inactive chain (holds the global base full):   fullSizeTB + (retention-1) × incrSizeTB
  //   Active chain at peak (SF not yet base, so SF = incrSizeTB):  retention × incrSizeTB
  const cfg = sc.config;
  const compression = 0.5;
  const changeRate = (cfg.dailyChangeRatePct ?? 5) / 100;
  const sourceTB = cfg.sourceDataTB ?? 1;
  const fullSizeTB = sourceTB * compression;
  const incrSizeTB = sourceTB * changeRate * compression;
  // Inactive chain: SF promoted to base full size + (retention-1) incrementals
  // EXACT VEEAM MODEL: Steady-state stored chain data = one completed chain:
  // one promoted full (the base SyntheticFull) + (retention-1) incrementals.
  // The active chain being built is WORKING SPACE — not stored data.
  // DO NOT add an activeChainPeak term here; that double-counts working space.
  const inactiveChainTB = fullSizeTB + (cfg.retention - 1) * incrSizeTB;
  const gfsPointCount = gfs.weekly + gfs.monthly + gfs.yearly;
  // Copy mode keeps active/inactive chain data in both perf and capacity tiers.
  const tierMultiplier = cfg.copyEnabled ? 2 : 1;
  const parityStartDate = new Date(`${START_DATE}T00:00:00.000Z`);
  const parityEndDate = new Date(`${parityDate}T00:00:00.000Z`);
  const parityDays = Math.round((parityEndDate.getTime() - parityStartDate.getTime()) / 86400000);
  const gfsForecastStats = computeForecastGfsStatsAtYear({
    sourceDataTB: sourceTB,
    annualGrowthRatePct: cfg.annualGrowthRatePct ?? 0,
    dailyChangeRatePct: cfg.dailyChangeRatePct ?? 0,
    retentionDays: cfg.retention,
    gfsPolicy: gfs,
    startDate: START_DATE,
    yearOffset: Math.max(0, parityDays / 365),
    copyEnabled: cfg.copyEnabled,
    effectiveMoveEnabled: cfg.moveEnabled || !cfg.copyEnabled,
    offloadAfterDays: cfg.offloadAfterDays,
    archiveAfterDays: cfg.archiveAfterDays,
    hasArchiveTier: cfg.hasArchiveTier,
    sizingMode: 'reverse',
  });
  const gfsTotalTB = cfg.repositoryType === 'SOBR'
    ? (gfsForecastStats.additionalPerfFullTB + gfsForecastStats.additionalCapFullTB + gfsForecastStats.additionalArchFullTB)
    : gfsForecastStats.additionalFullTB;
  const expectedMaxStorageTB = (inactiveChainTB * tierMultiplier) + gfsTotalTB;
  const workingSpaceReserveTB = computeVeeamWorkingSpaceTB(sourceTB);

  const storageSummary: string[] = [];
  storageSummary.push(`Source data: ${sourceTB} TB → compressed full backup ≈ ${fullSizeTB.toFixed(3)} TB`);
  storageSummary.push(`Incremental size ≈ ${incrSizeTB.toFixed(3)} TB (${cfg.dailyChangeRatePct}% daily change)`);
  storageSummary.push(`Stored chain data ≈ ${inactiveChainTB.toFixed(3)} TB (1 promoted full ${fullSizeTB.toFixed(3)} TB + ${cfg.retention - 1} incrementals @ ${incrSizeTB.toFixed(3)} TB each)`);
  storageSummary.push(`Working space (active chain being built) ≈ ${workingSpaceReserveTB.toFixed(3)} TB — reserved free space, not stored data`);
  if (gfsPointCount > 0) {
    storageSummary.push(`GFS estimate (${gfsPointCount} points): ${gfsTotalTB.toFixed(3)} TB`);
    if (cfg.repositoryType === 'SOBR') {
      storageSummary.push(`  Perf ${gfsForecastStats.additionalPerfFullTB.toFixed(3)} TB · Cap ${gfsForecastStats.additionalCapFullTB.toFixed(3)} TB · Arch ${gfsForecastStats.additionalArchFullTB.toFixed(3)} TB`);
    }
  }
  if (cfg.copyEnabled) storageSummary.push(`Copy mode: active/inactive chain data occupies both Performance and Capacity tiers (×2)`);
  storageSummary.push(`Estimated max total storage ≈ ${expectedMaxStorageTB.toFixed(3)} TB`);
  storageSummary.push(`Veeam working space reserve ≈ ${workingSpaceReserveTB.toFixed(3)} TB`);

  return {
    milestoneNarrative: milestones,
    expectedPath: buildExpectedPath(sc.config),
    expectedFinalGfs: gfs,
    expectedGfsDates: {
      weekly: weeklyDates,
      monthly: monthlyDates,
      yearly: yearlyDates,
    },
    expectedStorageSummary: storageSummary,
    expectedMaxStorageTB,
    workingSpaceReserveTB,
    parityDate,
  };
}

function snapshotFromState(day: number, date: string, state: SimulationState, sim: VeeamSimulator): DailySnapshot {
  const restorePoints = state.restorePoints;
  const repoId = state.repositories[0]?.id ?? '';
  const isSobr = state.repositories[0]?.type === 'SOBR';
  let perfStorageTB = 0, capStorageTB = 0, archStorageTB = 0;
  if (isSobr) {
    const tier = sim.getSOBRTierUsage(repoId);
    perfStorageTB = tier.Performance ?? 0;
    capStorageTB  = tier.Capacity  ?? 0;
    archStorageTB = tier.Archive   ?? 0;
  } else {
    const usage = sim.getStorageUsage();
    perfStorageTB = usage[repoId] ?? 0;
  }
  return {
    day,
    date,
    activeChains: state.chains.filter((c) => c.status === 'Active').length,
    inactiveChains: state.chains.filter((c) => c.status === 'Inactive').length,
    totalRestorePoints: restorePoints.length,
    fullPoints: restorePoints.filter((r) => r.type === 'Full').length,
    incrementalPoints: restorePoints.filter((r) => r.type === 'Incremental').length,
    syntheticFullPoints: restorePoints.filter((r) => r.type === 'SyntheticFull').length,
    weeklyGfsPoints: restorePoints.filter((r) => !!r.isWeeklyGFS).length,
    monthlyGfsPoints: restorePoints.filter((r) => !!r.isMonthlyGFS).length,
    yearlyGfsPoints: restorePoints.filter((r) => !!r.isYearlyGFS).length,
    perfPoints: restorePoints.filter((r) => !!r.hasPerformanceData).length,
    capPoints: restorePoints.filter((r) => !!r.hasCapacityData).length,
    archPoints: restorePoints.filter((r) => !!r.hasArchiveData).length,
    totalStorageTB: perfStorageTB + capStorageTB + archStorageTB,
    perfStorageTB,
    capStorageTB,
    archStorageTB,
  };
}

function buildActualPath(finalSnapshot: DailySnapshot, cfg: ScenarioConfig): string {
  const hasArchive = finalSnapshot.archPoints > 0;
  const hasCapacity = finalSnapshot.capPoints > 0;
  const hasPerf = finalSnapshot.perfPoints > 0;

  if (cfg.repositoryType === 'DAS') {
    return finalSnapshot.inactiveChains > 0 ? 'Active → Inactive' : 'Active';
  }

  if (hasArchive && hasCapacity && hasPerf) return 'Active → Capacity/Archive co-residency with Performance present';
  if (hasArchive && hasCapacity) return 'Active → Capacity/Archive co-residency';
  if (hasArchive) return 'Active → Archive-resident chain(s)';
  if (hasCapacity && hasPerf) return 'Active → Capacity with Performance still present';
  if (hasCapacity) return 'Active → Capacity-resident chain(s)';
  return 'Active (no offload observed)';
}

function runScenario(sc: LifecycleScenario, goldenSnapshots: GoldenSnapshotManager): RunResult {
  const startMs = Date.now();
  const violations: ViolationReport[] = [];
  const cfg = sc.config;
  const assertions = sc.assertions;
  const expectedLifecycle = buildExpectedLifecycle(sc);

  const state = buildInitialState(sc);
  const sim = new VeeamSimulator(state);
  const allSnapshots: DailySnapshot[] = [];
  const milestones: Array<{ day: number; date: string; text: string }> = [];

  // Track per-scenario mutable state for cross-day checks
  const prevChainIds = new Set<string>(sim.state.chains.map((c) => c.id));
  // For GEN monotonicity: genId → last known state
  const genStateHistory = new Map<string, GenLifecycleState>();
  // For deletion checks: chainId → newestPointDate at time of deletion
  const deletedChainNewestPointDates = new Map<string, string>();

  const gfsPolicy: GFSPolicy = cfg.gfsPolicy;

  // Assemble the daily assertion config from the assertions block
  const dailyCfg: DailyAssertionConfig = {
    noActiveChainOffloadComplete: assertions.noActiveChainOffloadComplete,
    pruneNeverBeforeOffload: assertions.pruneNeverBeforeOffload,
    noPerfDataAfterPrune: assertions.noPerfDataAfterPrune,
    noNonGfsCapacityResidue: assertions.noNonGfsCapacityResidue,
    archiveTierAlwaysEmpty: assertions.archiveTierAlwaysEmpty,
    singleGlobalBasePerJobEveryDay: assertions.singleGlobalBasePerJobEveryDay,
    gfsWeeklyCountNeverExceedsLimit: assertions.gfsWeeklyCountNeverExceedsLimit,
    gfsMonthlyCountNeverExceedsLimit: assertions.gfsMonthlyCountNeverExceedsLimit,
    gfsYearlyCountNeverExceedsLimit: assertions.gfsYearlyCountNeverExceedsLimit,
    gfsTagsOnlyOnFullOrSyntheticFull: assertions.gfsTagsOnlyOnFullOrSyntheticFull,
    monthlyGfsOnlyOnLastSaturdayOfMonth: assertions.monthlyGfsOnlyOnLastSaturdayOfMonth,
    yearlyGfsOnlyOnLastSaturdayOfDecember: assertions.yearlyGfsOnlyOnLastSaturdayOfDecember,
    noPruneWhilePerfImmutable: assertions.noPruneWhilePerfImmutable,
    noArchivePointBeforePointAge: assertions.noArchivePointBeforePointAge,
    noArchivePointBeforeCapTierAge: assertions.noArchivePointBeforeCapTierAge,
    slaMinimumNeverViolated: assertions.slaMinimumNeverViolated,
  };

  // Remove undefined keys so checks don't trigger unintentionally
  for (const k of Object.keys(dailyCfg) as (keyof DailyAssertionConfig)[]) {
    if (dailyCfg[k] === undefined) delete dailyCfg[k];
  }

  for (let day = 1; day <= sc.totalDays; day++) {
    // Apply any mid-run policy changes before this tick
    if (sc.policyChanges) {
      for (const pc of sc.policyChanges) {
        if (day === pc.onDay) {
          const job = sim.state.jobs.find((j) => j.id === `job-${sc.id}`);
          if (job) {
            job.retention.restorePoints = pc.newRetention;
            job.retention.slaDays = pc.newRetention;
            milestones.push({
              day,
              date: addDaysSimple(START_DATE, day),
              text: `Policy change applied: retention changed to ${pc.newRetention} restore points on day ${day}`,
            });
          }
        }
      }
    }

    // Detect chains deleted this tick (before advancing)
    const prevChainMap = new Map(
      sim.state.chains.map((c) => [c.id, c])
    );
    const prevRestorePoints = new Map(
      sim.state.restorePoints.map((r) => [r.id, r])
    );

    // Advance simulation
    sim.nextDay();
    const currentDate = sim.state.date;

    const dailyExplanation = sim.getDailyExplanation();
    if (dailyExplanation && /(GFS|offload|Archive|pruned|deleted|SyntheticFull|Full restore point)/i.test(dailyExplanation)) {
      milestones.push({ day, date: currentDate, text: dailyExplanation });
    }

    allSnapshots.push(snapshotFromState(day, currentDate, sim.state, sim));

    // Detect deletions (chains present before but gone now)
    const deletedChainIds = new Set<string>();
    for (const [id] of prevChainMap) {
      if (!sim.state.chains.find((c) => c.id === id)) {
        deletedChainIds.add(id);
        // record newest point date from previous snapshot
        const prevChainPoints = [...prevRestorePoints.values()].filter(
          (r) => r.chainId === id
        );
        if (prevChainPoints.length > 0) {
          const newest = prevChainPoints
            .map((r) => r.date)
            .sort()
            .at(-1)!;
          deletedChainNewestPointDates.set(id, newest);
        }
      }
    }

    // Run standard daily checks
    violations.push(
      ...runDailyChecks(
        sim.state,
        day,
        START_DATE,
        gfsPolicy,
        cfg.retention,
        dailyCfg,
        deletedChainIds,
        deletedChainNewestPointDates
      )
    );

    // ── R-GEN-04: GEN lifecycle state monotonicity ─────────────────────────
    if (assertions.genStateTransitionsMonotonic) {
      for (const gen of sim.state.generations ?? []) {
        const actual = expectedGenLifecycleState(gen, currentDate);
        const prev = genStateHistory.get(gen.id);
        if (prev) {
          const order = ['DeleteOn Pending', 'Waiting Immutability', 'Deletable'];
          const prevIdx = order.indexOf(prev);
          const curIdx = order.indexOf(actual);
          if (curIdx < prevIdx) {
            violations.push({
              day,
              date: currentDate,
              genId: gen.id,
              violatedRule: 'R-GEN-04',
              expected: `state ≥ ${prev} (monotonic)`,
              actual,
            });
          }
        }
        genStateHistory.set(gen.id, actual);
      }
    }

    // ── R-IMM-02: no deletion while Capacity immutable ────────────────────
    if (assertions.noDeletionWhileCapImmutable) {
      for (const chainId of deletedChainIds) {
        // find gens that were still cap-immutable at deletion time
        const deletedGens = (sim.state.generations ?? []).filter(
          (g) => g.chainId === chainId
        );
        // also check the previous state's gens (chain may be gone but gens stay?)
        // In Veeam sim, gens persist in state.generations until all points gone.
        // We scan what remains.
        for (const gen of sim.state.generations ?? []) {
          if (
            gen.chainId === chainId &&
            gen.capacityImmutableUntil &&
            currentDate <= gen.capacityImmutableUntil
          ) {
            violations.push({
              day,
              date: currentDate,
              chainId,
              genId: gen.id,
              violatedRule: 'R-IMM-02',
              expected: `chain deletion after capacityImmutableUntil (${gen.capacityImmutableUntil})`,
              actual: `chain ${chainId} deleted while gen ${gen.id} still cap-immutable`,
            });
          }
        }
      }
    }

    // ── R-IMM-03: no deletion while Archive immutable ─────────────────────
    if (assertions.noDeletionWhileArchImmutable) {
      for (const chainId of deletedChainIds) {
        for (const gen of sim.state.generations ?? []) {
          if (
            gen.chainId === chainId &&
            gen.archiveImmutableUntil &&
            currentDate <= gen.archiveImmutableUntil
          ) {
            violations.push({
              day,
              date: currentDate,
              chainId,
              genId: gen.id,
              violatedRule: 'R-IMM-03',
              expected: `chain deletion after archiveImmutableUntil (${gen.archiveImmutableUntil})`,
              actual: `chain ${chainId} deleted while gen ${gen.id} still archive-immutable`,
            });
          }
        }
      }
    }

    // ── R-RET-01 / chainDeletionRequiresAllGensUnlocked ───────────────────
    if (assertions.chainDeletionRequiresAllGensUnlocked) {
      for (const chainId of deletedChainIds) {
        // Build the set of gens that existed for this chain before deletion.
        // After deletion the chain's gens should still be in state.generations
        // (gens outlive chains in the engine).
        const chainGens = (sim.state.generations ?? []).filter(
          (g) => g.chainId === chainId
        );
        for (const gen of chainGens) {
          const state = expectedGenLifecycleState(gen, currentDate);
          if (state !== 'Deletable') {
            violations.push({
              day,
              date: currentDate,
              chainId,
              genId: gen.id,
              violatedRule: 'R-RET-01',
              expected: `gen state = Deletable before chain deletion`,
              actual: `gen ${gen.id} in state '${state}' when chain ${chainId} was deleted`,
            });
          }
        }
      }
    }

    // ── Point-in-time: weeklyGfsCountAtDays ──────────────────────────────
    if (assertions.weeklyGfsCountAtDays) {
      for (const spec of assertions.weeklyGfsCountAtDays) {
        if (day === spec.day) {
          const actual = sim.state.restorePoints.filter((r) => r.isWeeklyGFS).length;
          if (actual !== spec.expectedCount) {
            violations.push({
              day,
              date: currentDate,
              violatedRule: 'R-GFS-01 (point-in-time count)',
              expected: `weekly GFS count = ${spec.expectedCount} on day ${day}`,
              actual: `weekly GFS count = ${actual}`,
            });
          }
        }
      }
    }

    // ── Daily exact cardinality: expected calendar W/M/Y counts ──────────
    if (assertions.gfsCardinalityMatchesCalendar) {
      const firstBackupDate = addDaysSimple(START_DATE, 1);
      const expected = expectedGfsCardinality(firstBackupDate, currentDate, cfg.gfsPolicy);
      const actualWeekly = sim.state.restorePoints.filter((r) => r.isWeeklyGFS).length;
      const actualMonthly = sim.state.restorePoints.filter((r) => r.isMonthlyGFS).length;
      const actualYearly = sim.state.restorePoints.filter((r) => r.isYearlyGFS).length;

      if (actualWeekly !== expected.weekly) {
        violations.push({
          day,
          date: currentDate,
          violatedRule: 'R-GFS-01',
          expected: `weekly GFS count = ${expected.weekly} on ${currentDate}`,
          actual: `weekly GFS count = ${actualWeekly}`,
        });
      }
      if (actualMonthly !== expected.monthly) {
        violations.push({
          day,
          date: currentDate,
          violatedRule: 'R-GFS-03',
          expected: `monthly GFS count = ${expected.monthly} on ${currentDate}`,
          actual: `monthly GFS count = ${actualMonthly}`,
        });
      }
      if (actualYearly !== expected.yearly) {
        violations.push({
          day,
          date: currentDate,
          violatedRule: 'R-GFS-05',
          expected: `yearly GFS count = ${expected.yearly} on ${currentDate}`,
          actual: `yearly GFS count = ${actualYearly}`,
        });
      }
    }

    // ── R-GEN-01/02: GEN window boundary correct ─────────────────────────
    if (assertions.genWindowBoundaryCorrect) {
      const genPeriod = cfg.generationPeriodDays ?? 10;
      for (const gen of sim.state.generations ?? []) {
        const startOffset = Math.round(
          (new Date(gen.windowStartDate).getTime() - new Date(START_DATE).getTime()) / 86_400_000
        );
        const expectedWindowIndex = Math.floor(startOffset / genPeriod);
        const expectedStart = addDaysSimple(START_DATE, expectedWindowIndex * genPeriod);
        if (gen.windowStartDate !== expectedStart) {
          violations.push({
            day,
            date: currentDate,
            genId: gen.id,
            violatedRule: 'R-GEN-01',
            expected: `windowStartDate = ${expectedStart}`,
            actual: `windowStartDate = ${gen.windowStartDate}`,
          });
        }
      }
    }

    // ── R-GEN-02: deleteOn = windowEnd + slaDays ────────────────────────
    if (assertions.genDeleteOnEqualsWindowEndPlusSla) {
      for (const gen of sim.state.generations ?? []) {
        // Only check GENs without GFS points (they get extended)
        const genRps = sim.state.restorePoints.filter(
          (r) => r.generationId === gen.id && r.isGFS
        );
        if (genRps.length > 0) continue; // skip GFS-extended gens
        const expectedDeleteOn = addDaysSimple(gen.windowEndDate, cfg.retention);
        if (gen.deleteOn !== expectedDeleteOn) {
          violations.push({
            day,
            date: currentDate,
            genId: gen.id,
            violatedRule: 'R-GEN-02',
            expected: `deleteOn = ${expectedDeleteOn} (windowEnd + slaDays)`,
            actual: `deleteOn = ${gen.deleteOn}`,
          });
        }
      }
    }

    prevChainIds.clear();
    for (const c of sim.state.chains) prevChainIds.add(c.id);
  }

  const sampleDays = new Set<number>([1, 7, 14, 30, 60, 90, 180, 365, sc.totalDays]);
  const sampledSnapshots = allSnapshots.filter(
    (s) => sampleDays.has(s.day) || s.day % 30 === 0
  );
  const finalSnapshot = allSnapshots[allSnapshots.length - 1] ?? snapshotFromState(0, START_DATE, sim.state, sim);

  const goldenResult = goldenSnapshots.evaluateScenario(sc.id, sc.totalDays, allSnapshots);
  for (const gv of goldenResult.violations) {
    violations.push({
      day: gv.day,
      date: gv.date,
      violatedRule: 'R-SNAP-01',
      expected: gv.expected,
      actual: gv.actual,
    });
  }

  // ── Storage assertions (end-of-run) ──────────────────────────────────────
  //
  // ZERO TOLERANCE POLICY — DO NOT ADD TOLERANCE TO ANY ASSERTION BELOW.
  //
  // The forecast, simulator, and Veeam Calculator use identical formulas.
  // Any numeric difference between them is a BUG TO FIX, not a tolerance to widen.
  // Tolerance hides real model errors. If a test fails, find and fix the root cause.
  // The only legitimate exception is sub-GB floating-point rounding (< 0.001 TB).
  //
  // PARITY DATE: all three are compared at the last Saturday on or before the
  // run end — the completed-chain boundary. This is what the Veeam Calculator
  // models. Mid-week snapshots have a partially-built active chain which will
  // always differ from the completed-chain forecast. DO NOT change this.
  //
  const paritySnapshot = allSnapshots.find(s => s.date === expectedLifecycle.parityDate)
    ?? finalSnapshot;
  const finalStorageTB = finalSnapshot.totalStorageTB;
  const parityStorageTB = paritySnapshot.totalStorageTB;
  if (assertions.maxFinalStorageTB !== undefined) {
    if (finalStorageTB > assertions.maxFinalStorageTB + 0.001) {
      violations.push({
        day: sc.totalDays,
        date: finalSnapshot.date,
        violatedRule: 'R-STOR-01',
        expected: `total storage ≤ ${assertions.maxFinalStorageTB.toFixed(3)} TB`,
        actual: `total storage = ${finalStorageTB.toFixed(3)} TB`,
      });
    }
  }
  if (assertions.minFinalStorageTB !== undefined) {
    if (finalStorageTB < assertions.minFinalStorageTB - 0.001) {
      violations.push({
        day: sc.totalDays,
        date: finalSnapshot.date,
        violatedRule: 'R-STOR-01',
        expected: `total storage ≥ ${assertions.minFinalStorageTB.toFixed(3)} TB (block-absorption model parity)`,
        actual: `total storage = ${finalStorageTB.toFixed(3)} TB`,
      });
    }
  }
  if (assertions.maxUtilizationFraction !== undefined) {
    const repoId = sim.state.repositories[0]?.id ?? '';
    const capacityTB = sim.state.repositories[0]?.capacityTB ?? 999;
    const workingSpace = computeVeeamWorkingSpaceTB(sc.config.sourceDataTB ?? 1);
    const combinedTB = finalStorageTB + workingSpace;
    const utilFraction = capacityTB > 0 ? combinedTB / capacityTB : 0;
    if (utilFraction > assertions.maxUtilizationFraction + 0.001) {
      violations.push({
        day: sc.totalDays,
        date: finalSnapshot.date,
        violatedRule: 'R-STOR-02',
        expected: `utilization (used + working space) ≤ ${(assertions.maxUtilizationFraction * 100).toFixed(0)}% of ${capacityTB} TB`,
        actual: `utilization = ${(utilFraction * 100).toFixed(1)}% (${combinedTB.toFixed(3)} TB / ${capacityTB} TB)`,
      });
    }
  }
  if (assertions.forecastMustMatchSimulator) {
    // Forecast and simulator use identical GFS bracket-table code and the same dates.
    // Both are evaluated at parityDate (last Saturday of run) — the completed-chain
    // boundary. Any difference is a bug in the formulas. DO NOT add tolerance.
    const forecastTB = expectedLifecycle.expectedMaxStorageTB;
    if (Math.abs(parityStorageTB - forecastTB) > 0.001) {
      violations.push({
        day: paritySnapshot.day,
        date: paritySnapshot.date,
        violatedRule: 'R-STOR-03',
        expected: `simulator = forecast exactly (${forecastTB.toFixed(3)} TB) at parity date ${expectedLifecycle.parityDate}`,
        actual: `simulator = ${parityStorageTB.toFixed(3)} TB [perf=${paritySnapshot.perfStorageTB.toFixed(3)} cap=${paritySnapshot.capStorageTB.toFixed(3)} arch=${paritySnapshot.archStorageTB.toFixed(3)}] (delta ${(parityStorageTB - forecastTB).toFixed(3)} TB)`,
      });
    }
  }
  if (assertions.veeamCalculatorReferenceTB !== undefined) {
    // Simulator stored data + Veeam working space reserve must equal the Veeam Calculator's
    // repository size figure exactly. Both evaluated at parityDate (last Saturday of run).
    // The calculator includes working space in its total.
    // Any difference is a bug in the GFS bracket table or chain storage formula. DO NOT add tolerance.
    const refTB = assertions.veeamCalculatorReferenceTB;
    const workingSpaceReserveTB = expectedLifecycle.workingSpaceReserveTB;
    const totalWithWorkingSpace = parityStorageTB + workingSpaceReserveTB;
    if (Math.abs(totalWithWorkingSpace - refTB) > 0.001) {
      violations.push({
        day: paritySnapshot.day,
        date: paritySnapshot.date,
        violatedRule: 'R-STOR-04',
        expected: `simulator + working space = Veeam Calculator exactly (${refTB.toFixed(1)} TB) at parity date ${expectedLifecycle.parityDate}`,
        actual: `simulator ${parityStorageTB.toFixed(3)} TB + working space ${workingSpaceReserveTB.toFixed(3)} TB = ${totalWithWorkingSpace.toFixed(3)} TB`,
      });
    }
  }
  const actualLifecycle: ActualLifecycle = {
    actualPath: buildActualPath(finalSnapshot, sc.config),
    milestones: milestones.slice(0, 30),
    sampledSnapshots,
    finalSnapshot,
  };

  // Partition violations: known gaps vs real failures
  const knownGapRules = new Set(sc.knownEngineGaps ?? []);
  const realViolations = violations.filter(
    (v) => !v.violatedRule || !knownGapRules.has(v.violatedRule)
  );
  const skippedViolations = violations.filter(
    (v) => v.violatedRule && knownGapRules.has(v.violatedRule)
  );
  const isSkipped = skippedViolations.length > 0 && realViolations.length === 0;

  return {
    id: sc.id,
    name: sc.name,
    passed: realViolations.length === 0,
    skipped: isSkipped,
    skippedRules: isSkipped ? [...knownGapRules] : undefined,
    violations: realViolations,
    days: sc.totalDays,
    durationMs: Date.now() - startMs,
    expectedLifecycle,
    actualLifecycle,
    goldenSnapshotChecks: goldenResult.checks,
  };
}

// Minimal date helper for runner (avoids circular import)
function addDaysSimple(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Returns the ISO date of the last Saturday on or before the given date. */
function lastSaturdayOnOrBefore(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  // getUTCDay(): 0=Sun … 6=Sat
  const daysBack = d.getUTCDay() === 6 ? 0 : (d.getUTCDay() + 1);
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// HTML report
// ---------------------------------------------------------------------------

const RULE_DESCRIPTIONS: Record<string, string> = {
  'R-DRIFT-01': 'Inactive chain count remains bounded in long-run steady state',
  'R-DRIFT-02': 'Total restore-point count remains bounded in long-run steady state',
  'R-RET-01': 'Chain deletion only after all GENs are unlocked',
  'R-RET-02': 'SLA window extends chain lifetime past retention count',
  'R-RET-03': 'GFS tags extend chain lifetime indefinitely',
  'R-RET-04': 'Oldest chain deleted first when retention exceeded',
  'R-GFS-01': 'Weekly GFS count never exceeds configured limit',
  'R-GFS-02': 'Monthly GFS count never exceeds configured limit',
  'R-GFS-03': 'Yearly GFS count never exceeds configured limit',
  'R-GFS-04': 'Monthly GFS only on last Saturday of month',
  'R-GFS-05': 'Yearly GFS only on last Saturday of December',
  'R-GFS-06': 'GFS tags stack on the same point (W+M+Y)',
  'R-OFFLOAD-01': 'SOBR offload not before configured threshold days',
  'R-ARCH-01': 'Archive offload not before configured threshold days',
  'R-ARCH-02': 'Only GFS points eligible for archive in copy mode',
  'R-ARCH-03': 'Non-GFS Capacity data cleared after chain GFS archives (KNOWN GAP)',
  'R-ARCH-04': 'Archive points meet minimum age before moving',
  'R-PRUNE-01': 'No prune while Performance tier immutable',
  'R-PRUNE-02': 'Prune does not occur before offload completes',
  'R-CHAIN-01': 'Exactly one global base full per job at all times',
  'R-BASE-01': 'Base is always the oldest full across all chains',
  'R-GEN-01': 'GEN window boundaries align to generation period',
  'R-GEN-02': 'GEN deleteOn = windowEnd + SLA days',
  'R-GEN-03': 'GEN deleteOn extended when GFS points present',
  'R-GEN-04': 'GEN lifecycle state transitions are monotonic',
  'R-IMM-01': 'No Performance data deleted while Performance tier immutable',
  'R-IMM-02': 'No chain deleted while Capacity tier immutable',
  'R-IMM-03': 'No chain deleted while Archive tier immutable',
  'R-SNAP-01': 'Golden snapshot state (day 365/730) matches approved baseline',
  // ── Unified Decision Tree rule codes (canonical tree, adopted May 2026) ──
  // Row 4: MOVE gated by chain sealing (Inactive status), NOT by GEN state.
  'R-MOVE-01': 'MOVE requires sealed chain (status=Inactive); open/active chain must not be offloaded',
  // Row 5: MOVE blocked by Performance immutability.
  'R-MOVE-04': 'MOVE cannot occur while Performance tier immutability is active',
  // Row 6: MOVE age gate.
  'R-MOVE-05': 'MOVE age gate — chain newest point must be >= offloadAfterDays old before offload',
  // Row 11 (critical correction): GFS does NOT block MOVE; GFS only blocks deletion.
  'R-MOVE-03': 'GFS tags do NOT block MOVE — GFS points offload normally with their chain',
  // Row 14 (critical correction): Open GEN blocks deletion ONLY, not COPY or MOVE.
  'R-DT-14': 'Open GEN blocks deletion but NOT COPY or MOVE (GEN is a Capacity-tier construct)',
  // Row 16: GEN is the atomic deletion unit in SOBR and Direct-to-Object.
  'R-DT-16': 'GEN is the atomic deletion unit — entire GEN deleted when all RPs expired and non-immutable',
};

const LAYER_INFO: Record<number, { name: string; description: string }> = {
  1: { name: 'Layer 1 — Boundary Conditions',
       description: 'Each rule exercised in isolation with the minimal scenario needed to trigger it.' },
  2: { name: 'Layer 2 — Temporal Endurance',
       description: 'Same rules held across 1–5 year simulations to detect drift and accumulation errors.' },
  3: { name: 'Layer 3 — Interaction & Immutability',
       description: 'Two or more rules interacting simultaneously, with immutability constraints applied.' },
  4: { name: 'Layer 4 — Oracle Diff',
       description: 'Full structural oracle: exact GFS cardinality, tier residency per point, GEN state machine, chain phase transitions.' },
};

function getAssertionLabels(a: ScenarioAssertions): string[] {
  const out: string[] = [];
  if (a.noActiveChainOffloadComplete)          out.push('Active chain offload never complete');
  if (a.pruneNeverBeforeOffload)               out.push('Prune never precedes offload');
  if (a.noPerfDataAfterPrune)                  out.push('No Performance data after prune');
  if (a.noNonGfsCapacityResidue)               out.push('Non-GFS Capacity cleared after archive');
  if (a.archiveTierAlwaysEmpty)                out.push('Archive tier always empty');
  if (a.singleGlobalBasePerJobEveryDay)        out.push('Single global base per job every day');
  if (a.gfsWeeklyCountNeverExceedsLimit)       out.push('Weekly GFS count ≤ limit');
  if (a.gfsMonthlyCountNeverExceedsLimit)      out.push('Monthly GFS count ≤ limit');
  if (a.gfsYearlyCountNeverExceedsLimit)       out.push('Yearly GFS count ≤ limit');
  if (a.gfsCardinalityMatchesCalendar)         out.push('GFS cardinality matches calendar-derived exact counts daily');
  if (a.gfsTagsOnlyOnFullOrSyntheticFull)      out.push('GFS tags on Full/SyntheticFull only');
  if (a.monthlyGfsOnlyOnLastSaturdayOfMonth)   out.push('Monthly GFS on last Saturday of month');
  if (a.yearlyGfsOnlyOnLastSaturdayOfDecember) out.push('Yearly GFS on last Saturday of December');
  if (a.noPruneWhilePerfImmutable)             out.push('No prune while Performance immutable');
  if (a.noArchivePointBeforePointAge)          out.push('No archive before minimum point age');
  if (a.noArchivePointBeforeCapTierAge)        out.push('No archive before minimum Capacity age');
  if (a.slaMinimumNeverViolated)               out.push('SLA minimum always satisfied');
  if (a.chainDeletionRequiresAllGensUnlocked)  out.push('Chain deletion requires all GENs unlocked');
  if (a.genStateTransitionsMonotonic)          out.push('GEN state transitions monotonic');
  if (a.noDeletionWhileCapImmutable)           out.push('No deletion while Capacity immutable');
  if (a.noDeletionWhileArchImmutable)          out.push('No deletion while Archive immutable');
  if (a.genWindowBoundaryCorrect)              out.push('GEN window boundaries correct');
  if (a.genDeleteOnEqualsWindowEndPlusSla)     out.push('GEN deleteOn = windowEnd + SLA');
  if (a.weeklyGfsCountAtDays?.length)
    out.push(`Weekly GFS count point-in-time (day ${a.weeklyGfsCountAtDays.map((x) => x.day).join(', ')})`);
  return out;
}

function cfgSummary(cfg: ScenarioConfig): string {
  const parts: string[] = [cfg.repositoryType];
  parts.push(`Ret:${cfg.retention}`);
  const { weekly = 0, monthly = 0, yearly = 0 } = cfg.gfsPolicy;
  if (weekly + monthly + yearly > 0) parts.push(`GFS:${weekly}W/${monthly}M/${yearly}Y`);
  if (cfg.repositoryType === 'SOBR') {
    parts.push(cfg.copyEnabled ? 'Copy' : 'Move');
    parts.push(`Offload:${cfg.offloadAfterDays}d`);
    if (cfg.hasArchiveTier) parts.push(`Archive:${cfg.archiveAfterDays}d`);
  }
  if ((cfg.performanceImmutabilityDays ?? 0) > 0) parts.push(`PerfImm:${cfg.performanceImmutabilityDays}d`);
  if ((cfg.capacityImmutabilityDays ?? 0) > 0)    parts.push(`CapImm:${cfg.capacityImmutabilityDays}d`);
  if ((cfg.archiveImmutabilityDays ?? 0) > 0)     parts.push(`ArchImm:${cfg.archiveImmutabilityDays}d`);
  return parts.join(' · ');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function readMutationReport(): MutationReport | null {
  const path = join(process.cwd(), 'docs', 'mutation-report.json');
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as MutationReport;
  } catch {
    return null;
  }
}

function readGfsSizingTestStatusFromEnv(): GfsSizingTestStatus {
  const rawExitCode = process.env.GFS_SIZING_TEST_EXIT_CODE;
  const ranAt = process.env.GFS_SIZING_TEST_RAN_AT;
  if (rawExitCode === undefined) {
    return { status: 'unknown' };
  }

  const exitCode = Number(rawExitCode);
  if (!Number.isFinite(exitCode)) {
    return { status: 'unknown', ranAt };
  }

  return {
    status: exitCode === 0 ? 'pass' : 'fail',
    exitCode,
    ranAt,
  };
}

function readGfsSizingReport(): GfsSizingReport | null {
  const path = join(process.cwd(), 'docs', 'gfs-sizing-report.json');
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as GfsSizingReport;
  } catch {
    return null;
  }
}

function writeHtmlReport(
  scenarios: LifecycleScenario[],
  results: RunResult[],
  outputPath: string,
  mutationReport: MutationReport | null,
  gfsSizingTestStatus: GfsSizingTestStatus,
  gfsSizingReport: GfsSizingReport | null
): void {
  const timestamp = new Date().toLocaleString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  const passed  = results.filter((r) => r.passed && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed  = results.filter((r) => !r.passed).length;
  const totalDaysSimulated = scenarios.reduce((s, sc) => s + sc.totalDays, 0);
  const totalDurationMs    = results.reduce((s, r) => s + r.durationMs, 0);

  const confidence      = failed === 0 ? 'HIGH' : failed <= 2 ? 'MEDIUM' : 'LOW';
  const confColor       = failed === 0 ? '#1a7f37' : failed <= 2 ? '#b45309' : '#b91c1c';
  const confBg          = failed === 0 ? '#dcfce7' : failed <= 2 ? '#fef3c7' : '#fee2e2';
  const confDescription = failed === 0
    ? 'All contract rules validated. The simulator\'s behavioral model can be trusted for the tested scenarios.'
    : failed <= 2
    ? 'Most contract rules validated. Review failures before trusting simulator output.'
    : 'Significant failures detected. Simulator output should not be relied upon until failures are resolved.';

  const mutationSection = mutationReport
    ? `<details id="section-mutations" class="coverage-section" style="margin-bottom:20px;">
  <summary style="padding:12px 20px;cursor:pointer;font-size:13px;font-weight:600;color:#1e3a5f;list-style:none;display:flex;align-items:center;gap:8px;"><span style="font-size:10px">&#9654;</span>&nbsp;Mutation Testing Status</summary>
  <div style="padding:0 20px 12px">
  <p style="margin:12px 0 4px;">
    Generated ${esc(new Date(mutationReport.generatedAt).toLocaleString('en-US'))} ·
    Probes: <strong>${mutationReport.probeScenarioCount}</strong> ·
    Mutations: <strong>${mutationReport.mutationCount}</strong> ·
    Caught: <strong>${mutationReport.caughtCount}</strong> ·
    Blind spots: <strong>${mutationReport.blindSpotCount}</strong>
  </p>
  <table class="ctable" style="margin-top:12px;">
    <thead><tr><th>ID</th><th>Target</th><th>Description</th><th>Expected Catch</th><th>Observed</th><th>Status</th></tr></thead>
    <tbody>
      ${mutationReport.outcomes.map((o) => {
        const status = o.caught ? 'CAUGHT' : 'BLIND SPOT';
        const statusColor = o.caught ? '#1a7f37' : '#b91c1c';
        const observed = o.catchResult
          ? `${o.catchResult.scenarioId} · day ${o.catchResult.day} · ${o.catchResult.rule}`
          : 'No violation observed';
        return `<tr>
          <td class="mono">${esc(o.id)}</td>
          <td class="mono">${esc(o.targetMethod)}</td>
          <td>${esc(o.description)}</td>
          <td>${esc(o.expectedCatchingRule)}</td>
          <td>${esc(observed)}</td>
          <td><span class="status-badge small" style="background:${statusColor}">${status}</span></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
  </div>
</details>`
    : `<details id="section-mutations" class="coverage-section" style="margin-bottom:20px;">
  <summary style="padding:12px 20px;cursor:pointer;font-size:13px;font-weight:600;color:#1e3a5f;list-style:none;display:flex;align-items:center;gap:8px;"><span style="font-size:10px">&#9654;</span>&nbsp;Mutation Testing Status</summary>
  <div style="padding:0 20px 12px;">
  <p>No mutation report found at <span class="mono">docs/mutation-report.json</span>. Run <span class="mono">npm run test:mutation</span> (or <span class="mono">npm run test:quality</span>) before generating this report.</p>
  </div>
</details>`;

  const gfsSizingColor = gfsSizingTestStatus.status === 'pass'
    ? '#1a7f37'
    : gfsSizingTestStatus.status === 'fail'
    ? '#b91c1c'
    : '#6b7280';
  const gfsSizingLabel = gfsSizingTestStatus.status === 'pass'
    ? 'PASS'
    : gfsSizingTestStatus.status === 'fail'
    ? 'FAIL'
    : 'UNKNOWN';
  const gfsSizingDetail = gfsSizingTestStatus.status === 'pass'
    ? 'Standalone GFS sizing boundary and integration tests passed in this quality run.'
    : gfsSizingTestStatus.status === 'fail'
    ? `Standalone GFS sizing test failed (exit code ${gfsSizingTestStatus.exitCode ?? 'n/a'}).`
    : 'Standalone GFS sizing test status not available in this run. Use npm run test:quality for full pipeline reporting.';
  const gfsSizingWhen = gfsSizingTestStatus.ranAt
    ? `Ran at ${esc(new Date(gfsSizingTestStatus.ranAt).toLocaleString('en-US'))}.`
    : '';

  const gfsCasePassCount = gfsSizingReport?.passedCases ?? 0;
  const gfsCaseTotalCount = gfsSizingReport?.totalCases ?? 0;
  const gfsCategorySummary = gfsSizingReport
    ? Array.from(
        gfsSizingReport.cases.reduce((m, c) => {
          const cur = m.get(c.category) ?? { pass: 0, total: 0 };
          cur.total += 1;
          if (c.status === 'pass') cur.pass += 1;
          m.set(c.category, cur);
          return m;
        }, new Map<string, { pass: number; total: number }>())
      )
        .map(([category, stats]) => `${category}: ${stats.pass}/${stats.total}`)
        .join(' · ')
    : '';

  const gfsSizingRows = gfsSizingReport
    ? gfsSizingReport.cases.map((c) => {
        const color = c.status === 'pass' ? '#1a7f37' : '#b91c1c';
        const label = c.status === 'pass' ? 'PASS' : 'FAIL';
        return `<tr>
          <td class="mono">${esc(c.id)}</td>
          <td>${esc(c.category)}</td>
          <td>${esc(c.description)}</td>
          <td class="mono">${esc(c.expected)}</td>
          <td class="mono">${esc(c.actual)}</td>
          <td><span class="status-badge small" style="background:${color}">${label}</span></td>
        </tr>`;
      }).join('')
    : '';

  const gfsSizingSection = `<details id="section-gfs-sizing" class="coverage-section" style="margin-bottom:20px;">
  <summary style="padding:12px 20px;cursor:pointer;font-size:13px;font-weight:600;color:#1e3a5f;list-style:none;display:flex;align-items:center;gap:8px;"><span style="font-size:10px">&#9654;</span>&nbsp;GFS Sizing Test Status</summary>
  <div style="padding:0 20px 12px;">
  <p style="margin:12px 0 4px;">
    Standalone validation script: <span class="mono">npm run test:gfs-sizing</span>
    &nbsp;·&nbsp;
    Status: <span class="status-badge small" style="background:${gfsSizingColor}">${gfsSizingLabel}</span>
  </p>
  <p style="margin:4px 0;">${esc(gfsSizingDetail)}${gfsSizingWhen ? ` ${gfsSizingWhen}` : ''}</p>
  ${gfsSizingReport
    ? `<p style="margin:12px 0 4px;">
      Case summary: <strong>${gfsCasePassCount}/${gfsCaseTotalCount}</strong> checks passed.
      ${gfsCategorySummary ? `Categories: ${esc(gfsCategorySummary)}.` : ''}
    </p>
    <table class="ctable" style="margin-top:8px;">
      <thead><tr><th>Case ID</th><th>Category</th><th>Description</th><th>Expected</th><th>Actual</th><th>Status</th></tr></thead>
      <tbody>${gfsSizingRows}</tbody>
    </table>`
    : `<p style="margin:12px 0 0;">No detailed GFS sizing report found at <span class="mono">docs/gfs-sizing-report.json</span>. Run <span class="mono">npm run test:gfs-sizing</span> (or <span class="mono">npm run test:quality</span>) to populate case-level details.</p>`}
  </div>
</details>`;

  const resultMap = new Map(results.map((r) => [r.id, r]));

  // Rule → scenario IDs
  const ruleCoverage = new Map<string, string[]>();
  for (const sc of scenarios) {
    for (const rule of sc.rules) {
      if (!ruleCoverage.has(rule)) ruleCoverage.set(rule, []);
      ruleCoverage.get(rule)!.push(sc.id);
    }
  }

  // Layer stats
  const layerStats = [1, 2, 3, 4].map((l) => {
    const ls = scenarios.filter((s) => s.layer === l);
    const lr = ls.map((s) => resultMap.get(s.id)!).filter(Boolean);
    return {
      layer: l,
      total: ls.length,
      pass:  lr.filter((r) => r.passed && !r.skipped).length,
      skip:  lr.filter((r) => r.skipped).length,
      fail:  lr.filter((r) => !r.passed).length,
    };
  });

  // ── Scenario cards ──────────────────────────────────────────────────────
  function scenarioCard(sc: LifecycleScenario): string {
    const result = resultMap.get(sc.id);
    if (!result) return '';
    const status = !result.passed ? 'FAIL' : result.skipped ? 'SKIP' : 'PASS';
    const sc_color  = status === 'PASS' ? '#1a7f37' : status === 'SKIP' ? '#b45309' : '#b91c1c';
    const sc_bg     = status === 'PASS' ? '#f0fdf4' : status === 'SKIP' ? '#fffbeb' : '#fef2f2';
    const labels    = getAssertionLabels(sc.assertions);

    let detail = '';
    if (status === 'SKIP') {
      const gapRules = (result.skippedRules ?? []).map((r) => `${r}: ${RULE_DESCRIPTIONS[r] ?? r}`).join('; ');
      detail = `<div class="gap-notice">⚠ Known Engine Gap — ${esc(gapRules)}.<br>This scenario is tracked but not counted as a failure. Remove <code>knownEngineGaps</code> from the scenario JSON once the engine is fixed to automatically promote it to PASS.</div>`;
    } else if (status === 'FAIL') {
      const rows = result.violations.slice(0, 10).map((v) =>
        `<tr><td>${v.day}</td><td>${v.date}</td><td class="mono">${esc(v.violatedRule ?? '?')}</td><td>${esc(v.expected)}</td><td>${esc(v.actual)}</td></tr>`
      ).join('');
      const more = result.violations.length > 10
        ? `<tr class="more-row"><td colspan="5">… and ${result.violations.length - 10} more violation(s)</td></tr>` : '';
      detail = `<div class="violations"><strong>${result.violations.length} violation(s) detected:</strong><table class="vtable"><thead><tr><th>Day</th><th>Date</th><th>Rule</th><th>Expected</th><th>Actual</th></tr></thead><tbody>${rows}${more}</tbody></table></div>`;
    }

    const rulesHtml  = sc.rules.map((r) => `<span class="tag rule-tag" title="${esc(RULE_DESCRIPTIONS[r] ?? '')}">${r}</span>`).join(' ');
    const labelsHtml = labels.map((l) => `<span class="tag check-tag">${esc(l)}</span>`).join(' ');

    const exp = result.expectedLifecycle;
    const act = result.actualLifecycle;
    const expectedMilestones = exp.milestoneNarrative
      .map((m) => `<li>${esc(m)}</li>`)
      .join('');
    const actualMilestones = act.milestones.length > 0
      ? act.milestones.slice(0, 12).map((m) => `<li><span class="mono">D${m.day} ${m.date}</span> — ${esc(m.text)}</li>`).join('')
      : '<li>No lifecycle milestone events were emitted by engine explanations.</li>';

    const snapshotRows = act.sampledSnapshots.slice(0, 20).map((s) =>
      `<tr>
        <td>${s.day}</td>
        <td class="mono">${s.date}</td>
        <td>${s.activeChains}/${s.inactiveChains}</td>
        <td>${s.totalRestorePoints}</td>
        <td>${s.fullPoints}/${s.incrementalPoints}/${s.syntheticFullPoints}</td>
        <td>${s.weeklyGfsPoints}/${s.monthlyGfsPoints}/${s.yearlyGfsPoints}</td>
        <td>${s.perfPoints}/${s.capPoints}/${s.archPoints}</td>
        <td>${s.totalStorageTB.toFixed(3)}</td>
      </tr>`
    ).join('');

    const finalGfsActual = `${act.finalSnapshot.weeklyGfsPoints}/${act.finalSnapshot.monthlyGfsPoints}/${act.finalSnapshot.yearlyGfsPoints}`;
    const finalGfsExpected = `${exp.expectedFinalGfs.weekly}/${exp.expectedFinalGfs.monthly}/${exp.expectedFinalGfs.yearly}`;
    const gfsMatch = finalGfsActual === finalGfsExpected;

    // Storage compare
    const finalStorageTB = act.finalSnapshot.totalStorageTB;
    const storageColor = finalStorageTB <= exp.expectedMaxStorageTB + 0.001 ? '#15803d' : '#b91c1c';
    const storageMatch = finalStorageTB <= exp.expectedMaxStorageTB + 0.001;
    const isSobr = sc.config.repositoryType === 'SOBR';
    const storageActualDetail = isSobr
      ? `P: ${act.finalSnapshot.perfStorageTB.toFixed(3)} TB · C: ${act.finalSnapshot.capStorageTB.toFixed(3)} TB · A: ${act.finalSnapshot.archStorageTB.toFixed(3)} TB`
      : `${act.finalSnapshot.perfStorageTB.toFixed(3)} TB (DAS)`;
    const expectedStorageLines = exp.expectedStorageSummary.map((l) => `<li>${esc(l)}</li>`).join('');

    const expectedDateBlocks = [
      { label: 'Weekly', dates: exp.expectedGfsDates.weekly },
      { label: 'Monthly', dates: exp.expectedGfsDates.monthly },
      { label: 'Yearly', dates: exp.expectedGfsDates.yearly },
    ].map((b) => {
      const v = b.dates.length > 0 ? b.dates.map((d) => `<span class="mono small">${d}</span>`).join(' ') : '<em>none</em>';
      return `<div><span class="tag-label">${b.label} expected dates (latest):</span> ${v}</div>`;
    }).join('');

    const searchText = `${sc.id} ${sc.name} layer ${sc.layer} ${sc.rules.join(' ')} ${labels.join(' ')}`.toLowerCase();

    const goldenRows = result.goldenSnapshotChecks.map((chk) => {
      const color = chk.status === 'match' ? '#166534' : chk.status === 'seeded' ? '#1d4ed8' : '#991b1b';
      const label = chk.status === 'match' ? 'MATCH' : chk.status === 'seeded' ? 'SEEDED' : 'MISMATCH';
      const baseline = chk.expected
        ? `chain=${chk.expected.chainCount}, rp=${chk.expected.rpCount}, gfs=${chk.expected.gfsWeeklyCount}/${chk.expected.gfsMonthlyCount}/${chk.expected.gfsYearlyCount}, storage=${chk.expected.storageTB.toFixed(3)} TB`
        : 'new baseline captured';
      const actual = `chain=${chk.actual.chainCount}, rp=${chk.actual.rpCount}, gfs=${chk.actual.gfsWeeklyCount}/${chk.actual.gfsMonthlyCount}/${chk.actual.gfsYearlyCount}, storage=${chk.actual.storageTB.toFixed(3)} TB`;
      const diff = chk.differences.length > 0 ? chk.differences.join('; ') : 'none';
      return `<tr>
        <td>${chk.day}</td>
        <td class="mono">${esc(chk.date)}</td>
        <td><span class="status-badge small" style="background:${color}">${label}</span></td>
        <td>${esc(baseline)}</td>
        <td>${esc(actual)}</td>
        <td>${esc(diff)}</td>
      </tr>`;
    }).join('');

    const goldenSection = result.goldenSnapshotChecks.length > 0
      ? `<div class="timeline-block">
          <h3>Golden Snapshots (Phase 2)</h3>
          <table class="snap-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Date</th>
                <th>Status</th>
                <th>Baseline</th>
                <th>Actual</th>
                <th>Diff</th>
              </tr>
            </thead>
            <tbody>${goldenRows}</tbody>
          </table>
        </div>`
      : '';

    return `<details id="sc-${esc(sc.id)}" class="sc-card" data-status="${status.toLowerCase()}" data-layer="${sc.layer}" data-id="${esc(sc.id)}" data-rules="${esc(sc.rules.join(' '))}" data-search="${esc(searchText)}" style="border-left:4px solid ${sc_color};background:${sc_bg}">
      <summary class="sc-head">
        <span class="sc-caret">▶</span>
        <span class="status-badge" style="background:${sc_color}">${status}</span>
        <span class="sc-id mono">${esc(sc.id)}</span>
        <span class="sc-name">${esc(sc.name)}</span>
        <span class="sc-meta">${sc.totalDays}d &nbsp;·&nbsp; ${result.durationMs}ms &nbsp;·&nbsp; ${esc(cfgSummary(sc.config))}</span>
      </summary>
      <div class="sc-body">
        <p class="sc-desc">${esc(sc.description)}</p>
        <div class="sc-tags"><span class="tag-label">Rules:</span> ${rulesHtml}</div>
        ${labels.length > 0 ? `<div class="sc-tags"><span class="tag-label">Checks:</span> ${labelsHtml}</div>` : ''}

        <div class="compare-grid">
          <div class="compare-col expected-col">
            <h3>Expected Lifecycle</h3>
            <div class="path-line"><strong>Path:</strong> ${esc(exp.expectedPath)}</div>
            <div class="path-line"><strong>Final GFS count (W/M/Y):</strong> ${finalGfsExpected}</div>
            <ul class="milestone-list">${expectedMilestones}</ul>
            <div class="expected-dates">${expectedDateBlocks}</div>
          </div>
          <div class="compare-col actual-col">
            <h3>Actual Lifecycle</h3>
            <div class="path-line"><strong>Observed path:</strong> ${esc(act.actualPath)}</div>
            <div class="path-line"><strong>Final GFS count (W/M/Y):</strong> <span style="font-weight:700;color:${gfsMatch ? '#15803d' : '#b91c1c'}">${finalGfsActual}</span>${gfsMatch ? ' (matches expected)' : ` (expected ${finalGfsExpected})`}</div>
            <ul class="milestone-list">${actualMilestones}</ul>
          </div>
        </div>

        <div class="compare-grid">
          <div class="compare-col expected-col">
            <h3>Expected Storage</h3>
            <ul class="milestone-list">${expectedStorageLines}</ul>
          </div>
          <div class="compare-col actual-col">
            <h3>Actual Storage</h3>
            <div class="path-line"><strong>Final total used:</strong> <span style="font-weight:700;color:${storageColor}">${finalStorageTB.toFixed(3)} TB</span>${storageMatch ? ' ≤ estimate' : ` (exceeds estimate of ${exp.expectedMaxStorageTB.toFixed(3)} TB)`}</div>
            <div class="path-line">${isSobr ? '<strong>By tier:</strong> ' + storageActualDetail : storageActualDetail}</div>
            <div class="path-line"><strong>Working space reserve:</strong> ${exp.workingSpaceReserveTB.toFixed(3)} TB</div>
            <div class="path-line"><strong>Total incl. reserve:</strong> ${(finalStorageTB + exp.workingSpaceReserveTB).toFixed(3)} TB</div>
          </div>
        </div>

        <div class="timeline-block">
          <h3>Lifecycle Timeline Samples</h3>
          <table class="snap-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Date</th>
                <th>Chains A/I</th>
                <th>RP Count</th>
                <th>Types F/I/SF</th>
                <th>GFS W/M/Y</th>
                <th>Tiers P/C/A</th>
                <th>Size (TB)</th>
              </tr>
            </thead>
            <tbody>${snapshotRows}</tbody>
          </table>
        </div>

        ${goldenSection}

        ${detail}
      </div>
    </details>`;
  }

  // ── Group scenarios by layer ─────────────────────────────────────────────
  const layerSections = [1, 2, 3, 4].map((l) => {
    const info    = LAYER_INFO[l];
    const lStats  = layerStats.find((s) => s.layer === l)!;
    const cards   = scenarios.filter((s) => s.layer === l).map(scenarioCard).join('\n');
    const lColor  = lStats.fail > 0 ? '#b91c1c' : lStats.skip > 0 ? '#b45309' : '#1a7f37';
    return `<section id="section-layer-${l}" class="layer-section">
      <div class="layer-header" style="border-left:5px solid ${lColor}">
        <div>
          <h2>${esc(info.name)}</h2>
          <p class="layer-desc">${esc(info.description)}</p>
        </div>
        <div class="layer-stats">
          <span class="lst pass">${lStats.pass} PASS</span>
          ${lStats.skip > 0 ? `<span class="lst skip">${lStats.skip} SKIP</span>` : ''}
          ${lStats.fail > 0 ? `<span class="lst fail">${lStats.fail} FAIL</span>` : ''}
        </div>
      </div>
      ${cards}
    </section>`;
  }).join('\n');

  // ── Rule coverage table ─────────────────────────────────────────────────
  const allRules = Object.keys(RULE_DESCRIPTIONS);
  const coverageRows = allRules.map((rule) => {
    const ids    = ruleCoverage.get(rule) ?? [];
    const isGap  = (RULE_DESCRIPTIONS[rule] ?? '').includes('KNOWN GAP');
    const status = ids.length === 0 ? 'Uncovered' : isGap ? 'Known Gap' : 'Covered';
    const sc_color  = status === 'Covered' ? '#1a7f37' : status === 'Known Gap' ? '#b45309' : '#6b7280';
    const sc_bg     = status === 'Covered' ? '#f0fdf4' : status === 'Known Gap' ? '#fffbeb' : '#f9fafb';
    const idList = ids.length > 0
      ? ids.map((id) => `<span class="mono small">${esc(id)}</span>`).join(' ')
      : '<em>none</em>';
    return `<tr style="background:${sc_bg}">
      <td class="mono" style="color:${sc_color};font-weight:600">${rule}</td>
      <td>${esc(RULE_DESCRIPTIONS[rule] ?? '')}</td>
      <td>${idList}</td>
      <td><span class="status-badge small" style="background:${sc_color}">${status}</span></td>
    </tr>`;
  }).join('\n');

  const coveredKnownRuleCount = allRules.filter((rule) => (ruleCoverage.get(rule)?.length ?? 0) > 0).length;
  const uncoveredKnownRuleCount = allRules.length - coveredKnownRuleCount;

  // ── Full HTML ────────────────────────────────────────────────────────────
  // ── Findings dashboard computation ───────────────────────────────────────
  type ActionItem = { severity: 'error' | 'warning' | 'info'; category: string; label: string; href: string; detail: string };
  const actionItems: ActionItem[] = [];

  for (const r of results.filter((r) => !r.passed)) {
    actionItems.push({ severity: 'error', category: 'Test Failure', label: r.id, href: `#sc-${r.id}`, detail: `${r.violations.length} violation(s)` });
  }
  if (gfsSizingTestStatus.status === 'fail') {
    actionItems.push({
      severity: 'error',
      category: 'Standalone Test Failure',
      label: 'test:gfs-sizing',
      href: '#section-gfs-sizing',
      detail: `exit code ${gfsSizingTestStatus.exitCode ?? 'n/a'}`,
    });
  }
  for (const r of results) {
    for (const chk of r.goldenSnapshotChecks.filter((c) => c.status === 'mismatch')) {
      actionItems.push({ severity: 'error', category: 'Snapshot Mismatch', label: `${r.id} · day ${chk.day}`, href: `#sc-${r.id}`, detail: chk.differences.join('; ') });
    }
  }
  if (mutationReport) {
    for (const o of mutationReport.outcomes.filter((o) => !o.caught)) {
      actionItems.push({ severity: 'error', category: 'Mutation Blind Spot', label: o.id, href: '#section-mutations', detail: o.description });
    }
  }
  for (const r of results.filter((r) => r.skipped)) {
    actionItems.push({ severity: 'warning', category: 'Known Engine Gap', label: r.id, href: `#sc-${r.id}`, detail: (r.skippedRules ?? []).map((rule) => `${rule}: ${RULE_DESCRIPTIONS[rule] ?? rule}`).join(' · ') });
  }
  for (const rule of allRules.filter((rule) => (ruleCoverage.get(rule)?.length ?? 0) === 0)) {
    actionItems.push({ severity: 'info', category: 'Uncovered Rule', label: rule, href: '#section-rule-coverage', detail: RULE_DESCRIPTIONS[rule] ?? '' });
  }

  const renderFindingGroup = (items: ActionItem[], title: string, color: string, bg: string, icon: string): string => {
    if (items.length === 0) return '';
    const rows = items.map((item) => `<tr>
          <td><span class="finding-cat" style="background:${bg};color:${color}">${esc(item.category)}</span></td>
          <td><a class="finding-link" href="${item.href}">${esc(item.label)}</a></td>
          <td class="finding-detail">${esc(item.detail)}</td>
        </tr>`).join('');
    return `<div class="finding-group" style="border-left:4px solid ${color};background:${bg}">
      <div class="finding-group-title">${icon}&nbsp;<strong>${esc(title)}</strong><span class="finding-count" style="background:${color}">${items.length}</span></div>
      <table class="finding-table"><tbody>${rows}</tbody></table>
    </div>`;
  };

  const errorItems = actionItems.filter((i) => i.severity === 'error');
  const warnItems  = actionItems.filter((i) => i.severity === 'warning');
  const infoItems  = actionItems.filter((i) => i.severity === 'info');

  const matchedSnapshotCount = results.reduce((sum, r) => sum + r.goldenSnapshotChecks.filter((chk) => chk.status === 'match').length, 0);
  const seededSnapshotCount = results.reduce((sum, r) => sum + r.goldenSnapshotChecks.filter((chk) => chk.status === 'seeded').length, 0);
  const caughtMutationCount = mutationReport?.outcomes.filter((o) => o.caught).length ?? 0;
  const qualitySignalItems = [
    mutationReport
      ? `<tr>
          <td><span class="finding-cat" style="background:#ecfdf5;color:#166534">Mutation Coverage</span></td>
          <td><a class="finding-link" href="#section-mutations">${caughtMutationCount}/${mutationReport.mutationCount} mutations caught</a></td>
          <td class="finding-detail">Injected defects were detected by the current test and oracle suite.</td>
        </tr>`
      : '',
    matchedSnapshotCount > 0
      ? `<tr>
          <td><span class="finding-cat" style="background:#ecfdf5;color:#166534">Golden Snapshots</span></td>
          <td><a class="finding-link" href="#section-golden">${matchedSnapshotCount} checkpoint matches</a></td>
          <td class="finding-detail">Stored long-run baselines matched the current engine output exactly.</td>
        </tr>`
      : '',
    seededSnapshotCount > 0
      ? `<tr>
          <td><span class="finding-cat" style="background:#eff6ff;color:#1d4ed8">Snapshot Baseline</span></td>
          <td><a class="finding-link" href="#section-golden">${seededSnapshotCount} checkpoints seeded</a></td>
          <td class="finding-detail">New baseline checkpoints were captured during this run.</td>
        </tr>`
      : '',
    `<tr>
      <td><span class="finding-cat" style="background:${
        gfsSizingTestStatus.status === 'pass' ? '#ecfdf5;color:#166534' :
        gfsSizingTestStatus.status === 'fail' ? '#fff5f5;color:#991b1b' :
        '#f9fafb;color:#374151'
      }">GFS Sizing Test</span></td>
      <td><a class="finding-link" href="#section-gfs-sizing">${gfsSizingLabel}${gfsSizingReport ? ` (${gfsCasePassCount}/${gfsCaseTotalCount})` : ''}</a></td>
      <td class="finding-detail">${esc(gfsSizingDetail)}${gfsSizingReport ? ` Case-level results are listed in the GFS section.` : ''}</td>
    </tr>`
  ].filter(Boolean).join('');

  const qualitySignalsHtml = qualitySignalItems
    ? `<div class="signal-group">
      <div class="finding-group-title"><span>&#10003;</span><strong>Quality Signals</strong></div>
      <table class="finding-table"><tbody>${qualitySignalItems}</tbody></table>
    </div>`
    : '';

  const dashboardHtml = actionItems.length === 0
    ? `${qualitySignalsHtml}<div class="all-clear">&#10003;&nbsp;No findings &mdash; all scenarios passed, all snapshots match, all mutations caught, and the standalone GFS sizing test passed. Simulator output can be trusted for the tested configuration space.</div>`
    : `${qualitySignalsHtml}
       ${renderFindingGroup(errorItems, 'Must Fix', '#991b1b', '#fff5f5', '&#128308;')}
       ${renderFindingGroup(warnItems,  'Known Engine Gaps (tracked, not counted as failures)', '#92400e', '#fffbeb', '&#9888;')}
       ${renderFindingGroup(infoItems,  'Coverage Gaps (informational)', '#374151', '#f9fafb', '&#8505;')}`;

  // ── Golden snapshot overview ──────────────────────────────────────────────
  const goldenOverviewRows = results
    .filter((r) => r.goldenSnapshotChecks.length > 0)
    .map((r) => {
      const checksHtml = r.goldenSnapshotChecks.map((chk) => {
        const color = chk.status === 'match' ? '#166534' : chk.status === 'seeded' ? '#1d4ed8' : '#991b1b';
        const label = chk.status === 'match' ? 'MATCH' : chk.status === 'seeded' ? 'SEEDED' : 'MISMATCH';
        const diff = chk.differences.length > 0 ? ` · ${chk.differences.join(', ')}` : '';
        return `<span class="status-badge small" style="background:${color}" title="Day ${chk.day}${esc(diff)}">${label}&nbsp;d${chk.day}</span>`;
      }).join('&nbsp; ');
      return `<tr>
        <td><a href="#sc-${esc(r.id)}" class="mono" style="font-size:12px">${esc(r.id)}</a></td>
        <td style="color:#374151;font-size:12px">${esc(r.name)}</td>
        <td>${checksHtml}</td>
      </tr>`;
    }).join('');

  const goldenOverviewHtml = goldenOverviewRows
    ? `<details id="section-golden" class="coverage-section" style="margin-bottom:20px;">
  <summary style="padding:12px 20px;cursor:pointer;font-size:13px;font-weight:600;color:#1e3a5f;list-style:none;display:flex;align-items:center;gap:8px;"><span style="font-size:10px">&#9654;</span>&nbsp;Golden Snapshot Registry</summary>
  <div style="padding:0 20px 12px;">
  <p style="margin:12px 0 4px;font-size:12px;color:#6b7280;">Approved baseline state at fixed checkpoints (day 365 &amp; 730) for long-running scenarios. A MISMATCH appears in the Findings Dashboard above and must be reviewed &mdash; either re-seed the baseline (<span class="mono">npm run test:quality:update-snapshots</span>) or investigate a regression.</p>
  <table class="ctable" style="margin-top:12px;">
    <thead><tr><th>Scenario ID</th><th>Name</th><th>Checkpoint Status</th></tr></thead>
    <tbody>${goldenOverviewRows}</tbody>
  </table>
  </div>
</details>`
    : '';

  // ── Full HTML ────────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Veeam Simulator — Quality &amp; Validation Report</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; color: #111827; background: #f3f4f6; margin: 0; padding: 0; }
    a { color: #2563eb; }
    h1 { margin: 0 0 4px; font-size: 22px; }
    h2 { margin: 0 0 4px; font-size: 16px; }
    .mono { font-family: 'Cascadia Code', 'Consolas', monospace; font-size: 12px; }
    .small { font-size: 11px; }

    /* Header */
    .report-header { background: #1e3a5f; color: #fff; padding: 24px 32px 20px; }
    .report-header h1 { color: #fff; font-size: 24px; }
    .run-meta { color: #93c5fd; font-size: 12px; margin-bottom: 16px; }
    .summary-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .count-badge { padding: 4px 12px; border-radius: 20px; font-size: 13px; font-weight: 700; }
    .conf-block { margin-left: auto; background: rgba(255,255,255,0.1); border-radius: 8px; padding: 10px 16px; text-align: right; }
    .conf-label { font-size: 11px; color: #93c5fd; text-transform: uppercase; letter-spacing: 1px; }
    .conf-value { font-size: 22px; font-weight: 800; }
    .conf-desc { font-size: 11px; color: #bfdbfe; max-width: 320px; margin-top: 2px; }

    /* Metrics bar */
    .metrics-bar { background: #fff; border-bottom: 1px solid #e5e7eb; padding: 10px 32px; display: flex; gap: 32px; flex-wrap: wrap; }
    .metric { display: flex; flex-direction: column; }
    .metric-value { font-size: 20px; font-weight: 700; color: #1e3a5f; }
    .metric-label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }

    /* Layer section */
    .content { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }
    .report-controls { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); padding: 12px 14px; margin-bottom: 16px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .ctl-btn { border: 1px solid #cbd5e1; background: #f8fafc; color: #0f172a; border-radius: 6px; padding: 6px 10px; font-size: 12px; font-weight: 600; cursor: pointer; }
    .ctl-btn:hover { background: #eef2ff; border-color: #94a3b8; }
    .ctl-search { flex: 1 1 280px; min-width: 260px; border: 1px solid #cbd5e1; border-radius: 6px; padding: 7px 10px; font-size: 12px; }
    .ctl-hint { font-size: 11px; color: #6b7280; }
    .ctl-count { margin-left: auto; font-size: 12px; color: #334155; font-weight: 600; }
    .ctl-chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .chip { border: 1px solid #cbd5e1; background: #f8fafc; color: #475569; border-radius: 20px; padding: 4px 10px; font-size: 11px; font-weight: 700; cursor: pointer; text-transform: uppercase; letter-spacing: .4px; transition: background .15s, border-color .15s, color .15s; }
    .chip:hover { background: #e2e8f0; border-color: #94a3b8; }
    .chip.active[data-filter-status="pass"] { background: #dcfce7; border-color: #22c55e; color: #166534; }
    .chip.active[data-filter-status="skip"] { background: #fef9c3; border-color: #ca8a04; color: #713f12; }
    .chip.active[data-filter-status="fail"] { background: #fee2e2; border-color: #ef4444; color: #991b1b; }
    .chip.active[data-filter-layer] { background: #dbeafe; border-color: #3b82f6; color: #1e3a8a; }
    .layer-section { margin-bottom: 32px; }
    .layer-header { background: #fff; border-radius: 8px 8px 0 0; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .layer-desc { color: #6b7280; font-size: 12px; margin: 2px 0 0; }
    .layer-stats { display: flex; gap: 8px; }
    .lst { padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
    .lst.pass { background: #dcfce7; color: #1a7f37; }
    .lst.skip { background: #fef3c7; color: #b45309; }
    .lst.fail { background: #fee2e2; color: #b91c1c; }

    /* Scenario card */
    .sc-card { background: #fff; border-radius: 0; padding: 0; margin-bottom: 2px; box-shadow: 0 1px 2px rgba(0,0,0,.06); overflow: hidden; }
    .sc-card:last-child { border-radius: 0 0 8px 8px; }
    .sc-card summary { list-style: none; }
    .sc-card summary::-webkit-details-marker { display: none; }
    .sc-head { padding: 10px 16px; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; border-bottom: 1px solid transparent; cursor: pointer; }
    .sc-card[open] .sc-head { border-bottom-color: #f1f5f9; }
    .sc-caret { font-size: 11px; color: #6b7280; margin-right: 2px; transform-origin: center; transition: transform 120ms ease; }
    .sc-card[open] .sc-caret { transform: rotate(90deg); }
    .sc-id { color: #374151; }
    .sc-name { font-weight: 600; color: #111827; }
    .sc-meta { margin-left: auto; font-size: 11px; color: #9ca3af; }
    .sc-body { padding: 10px 16px 12px; }
    .sc-desc { margin: 0 0 8px; color: #374151; }
    .sc-body h3 { margin: 8px 0 6px; font-size: 13px; color: #1f2937; }
    .sc-tags { margin-bottom: 4px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
    .tag-label { font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-right: 2px; }
    .tag { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; font-weight: 500; }
    .rule-tag { background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; }
    .check-tag { background: #f8fafc; color: #475569; border: 1px solid #e2e8f0; }
    .status-badge { color: #fff; padding: 2px 9px; border-radius: 10px; font-size: 11px; font-weight: 700; letter-spacing: 0.5px; white-space: nowrap; }
    .status-badge.small { padding: 1px 7px; font-size: 10px; }

    /* Expected vs Actual */
    .compare-grid { margin-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .compare-col { border: 1px solid #dbeafe; border-radius: 8px; padding: 10px; background: #f8fbff; }
    .actual-col { border-color: #d1fae5; background: #f7fefb; }
    .path-line { font-size: 12px; color: #374151; margin-bottom: 4px; }
    .milestone-list { margin: 6px 0 0 16px; padding: 0; }
    .milestone-list li { margin-bottom: 4px; font-size: 12px; color: #1f2937; }
    .expected-dates { margin-top: 8px; font-size: 12px; color: #4b5563; display: grid; gap: 5px; }

    .timeline-block { margin-top: 10px; }
    .snap-table { width: 100%; border-collapse: collapse; margin-top: 5px; font-size: 11px; }
    .snap-table th { background: #eff6ff; color: #1e40af; text-align: left; padding: 5px 8px; border-bottom: 2px solid #bfdbfe; }
    .snap-table td { padding: 4px 8px; border-bottom: 1px solid #dbeafe; }

    /* Gap notice */
    .gap-notice { margin-top: 8px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px; padding: 8px 12px; font-size: 12px; color: #78350f; }
    .gap-notice code { background: #fef3c7; padding: 1px 4px; border-radius: 3px; font-size: 11px; }

    /* Violations table */
    .violations { margin-top: 10px; }
    .violations strong { font-size: 12px; color: #b91c1c; }
    .vtable { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 11px; }
    .vtable th { background: #fef2f2; color: #7f1d1d; text-align: left; padding: 5px 8px; border-bottom: 2px solid #fecaca; }
    .vtable td { padding: 4px 8px; border-bottom: 1px solid #fee2e2; vertical-align: top; }
    .vtable tr.more-row td { text-align: center; color: #9ca3af; font-style: italic; }

    /* Rule coverage */
    .coverage-section { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); overflow: hidden; margin-bottom: 32px; }
    .coverage-section h2 { padding: 16px 20px 0; }
    .coverage-section p { padding: 4px 20px 12px; color: #6b7280; font-size: 12px; margin: 0; }
    .ctable { width: 100%; border-collapse: collapse; font-size: 12px; }
    .ctable th { background: #f8fafc; color: #374151; text-align: left; padding: 8px 12px; border-bottom: 2px solid #e5e7eb; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
    .ctable td { padding: 7px 12px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    .ctable tr:last-child td { border-bottom: none; }

    /* Footer */
    .report-footer { text-align: center; padding: 20px; color: #9ca3af; font-size: 11px; }

    @media (max-width: 900px) {
      .compare-grid { grid-template-columns: 1fr; }
    }

    /* Sticky navigation bar */
    .report-nav { background: #1e3a5f; padding: 0 32px; display: flex; gap: 0; flex-wrap: nowrap; position: sticky; top: 0; z-index: 100; box-shadow: 0 2px 6px rgba(0,0,0,0.2); overflow-x: auto; }
    .report-nav a { color: #93c5fd; text-decoration: none; font-size: 12px; font-weight: 600; white-space: nowrap; padding: 10px 14px; border-bottom: 3px solid transparent; display: block; }
    .report-nav a:hover { color: #fff; border-bottom-color: #60a5fa; }
    .report-nav .nav-sep { color: #334d6e; padding: 10px 4px; font-size: 14px; user-select: none; }

    /* Findings dashboard */
    .dashboard-panel { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); padding: 16px 20px; margin-bottom: 20px; }
    .dashboard-panel > h2 { margin: 0 0 14px; font-size: 16px; color: #1e3a5f; }
    .all-clear { background: #dcfce7; color: #166534; border-radius: 6px; padding: 12px 16px; font-size: 13px; font-weight: 600; border: 1px solid #86efac; }
    .signal-group { background: #f0fdf4; border: 1px solid #86efac; border-left: 4px solid #15803d; border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; }
    .finding-group { border-radius: 6px; padding: 10px 12px; margin-bottom: 10px; }
    .finding-group:last-child { margin-bottom: 0; }
    .finding-group-title { font-size: 13px; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
    .finding-count { border-radius: 10px; padding: 1px 8px; font-size: 11px; font-weight: 700; color: #fff; }
    .finding-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .finding-table td { padding: 5px 8px; border-bottom: 1px solid rgba(0,0,0,0.06); vertical-align: top; }
    .finding-table tr:last-child td { border-bottom: none; }
    .finding-cat { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; opacity: 0.9; }
    .finding-link { font-weight: 600; font-family: 'Cascadia Code', monospace; font-size: 11px; color: #2563eb; }
    .finding-detail { color: #6b7280; font-size: 11px; max-width: 500px; }
  </style>
</head>
<body>

<div class="report-header">
  <h1>Veeam Simulator — Quality &amp; Validation Report</h1>
  <div class="run-meta">Generated ${timestamp} &nbsp;·&nbsp; Start date: 2026-05-02 (fixed for determinism)</div>
  <div class="summary-row">
    <span class="count-badge" style="background:#166534;color:#fff">${passed} PASS</span>
    <span class="count-badge" style="background:#92400e;color:#fff">${skipped} SKIP (known gaps)</span>
    <span class="count-badge" style="background:${failed > 0 ? '#991b1b' : '#374151'};color:#fff">${failed} FAIL</span>
    <div class="conf-block">
      <div class="conf-label">Confidence Level</div>
      <div class="conf-value" style="color:${confColor.replace('#', '#').replace('b91c1c', 'fca5a5').replace('1a7f37', '86efac').replace('b45309', 'fde68a')}">${confidence}</div>
      <div class="conf-desc">${esc(confDescription)}</div>
    </div>
  </div>
</div>

<div class="metrics-bar">
  <div class="metric"><span class="metric-value">${results.length}</span><span class="metric-label">Scenarios</span></div>
  <div class="metric"><span class="metric-value">${totalDaysSimulated.toLocaleString()}</span><span class="metric-label">Days Simulated</span></div>
  <div class="metric"><span class="metric-value">${(totalDurationMs / 1000).toFixed(1)}s</span><span class="metric-label">Total Duration</span></div>
  <div class="metric"><span class="metric-value">${coveredKnownRuleCount}</span><span class="metric-label">Rules Covered</span></div>
  <div class="metric"><span class="metric-value">${uncoveredKnownRuleCount}</span><span class="metric-label">Rules Uncovered</span></div>
</div>

</div>

<nav class="report-nav">
  <a href="#top">&uarr;&nbsp;Top</a>
  <span class="nav-sep">|</span>
  <a href="#section-dashboard">&#128202;&nbsp;Findings Dashboard</a>
  <span class="nav-sep">|</span>
  <a href="#section-workflow">Workflow Scope</a>
  <span class="nav-sep">|</span>
  <a href="#section-gfs-sizing">GFS Sizing Test</a>
  <span class="nav-sep">|</span>
  <a href="#section-mutations">Mutation Tests</a>
  <span class="nav-sep">|</span>
  <a href="#section-golden">Golden Snapshots</a>
  <span class="nav-sep">|</span>
  <a href="#section-scenarios">Scenarios</a>
  <span class="nav-sep">|</span>
  <a href="#section-rule-coverage">Rule Coverage</a>
</nav>

<div class="content" id="top">

<div id="section-dashboard" class="dashboard-panel">
  <h2>Findings Dashboard</h2>
  ${dashboardHtml}
</div>

<div id="section-guide" style="background:#f0fdf4;border-left:4px solid #1a7f37;border-radius:6px;padding:16px 20px;margin-bottom:20px;">
  <h2 style="margin:0 0 12px;font-size:15px;color:#166534;">How To Read This Report</h2>
  <div style="font-size:12px;color:#374151;line-height:1.6;">
    <p style="margin:0 0 8px;">
      This report presents simulator quality evidence across multiple dimensions, each collapsible for easy navigation:
    </p>
    <ul style="margin:8px 0;padding-left:20px;">
      <li><strong>Findings Dashboard</strong> (above): High-level signal showing must-fix errors, known gaps, and coverage gaps with direct links.</li>
      <li><strong>GFS Sizing Test Status</strong>: Standalone validation results with case-level boundary and integration checks across modifier boundaries, weekly/monthly/yearly ranges, and engine integration.</li>
      <li><strong>Mutation Testing Status</strong>: Shows which logic mutations are caught by scenarios; blind spots indicate missing test coverage.</li>
      <li><strong>Golden Snapshot Registry</strong>: Baseline state checkpoints (day 365 &amp; 730) for long-running scenarios; mismatches appear in the dashboard.</li>
      <li><strong>Contract Rule Coverage</strong>: Lists all contract rules with which scenarios cover each; uncovered rules appear in the dashboard.</li>
      <li><strong>Scenario Validation</strong> (organized by layer 1–4): Scenario-by-scenario validation with expected vs. actual lifecycle, plus timeline samples. Use the toolbar to expand/collapse all, search by scenario ID or rule, and filter by status or layer. For each scenario, read left-to-right: <strong>Expected Lifecycle</strong> defines what should happen, <strong>Actual Lifecycle</strong> shows engine behavior, <strong>Lifecycle Timeline Samples</strong> provides day-index checkpoints.</li>
    </ul>
    <p style="margin:8px 0 0;">
      All sections expand on demand. Known engine gaps are explicitly labeled and excluded from failures.
    </p>
  </div>
</div>

<div id="section-workflow" style="background:#fff;border:1px solid #e5e7eb;border-left:4px solid #1d4ed8;border-radius:6px;padding:16px 20px;margin-bottom:20px;">
  <h2 style="margin:0 0 12px;font-size:15px;color:#1e3a8a;">Workflow Scope</h2>
  <div style="font-size:12px;color:#374151;line-height:1.6;">
    <p style="margin:0 0 8px;">Primary validation workflow (active gates):</p>
    <ul style="margin:8px 0;padding-left:20px;">
      <li><strong>npm test</strong> &mdash; deterministic scenario validation and core invariants.</li>
      <li><strong>npm run compare:veeam</strong> &mdash; oracle comparison against captured Veeam Calculator Details values, including optional file-type size matching when baseline values are present.</li>
      <li><strong>npm run verify:known-veeam-deltas</strong> &mdash; validates only approved calculator deltas remain.</li>
      <li><strong>npm run test:quality</strong> &mdash; consolidated quality pipeline (GFS sizing, mutation testing, lifecycle contracts, and golden snapshots).</li>
    </ul>
    <p style="margin:8px 0;">Archived/exploratory tests (kept for research, not required CI gates):</p>
    <ul style="margin:8px 0;padding-left:20px;">
      <li><strong>archive:test:idealized-gfs</strong> &mdash; idealized clone-theory exploration.</li>
      <li><strong>archive:test:live-weekly-gfs</strong> &mdash; historical weekly live-capture hypothesis exploration.</li>
      <li><strong>archive:test:live-period-gfs</strong> &mdash; historical monthly/yearly live-capture hypothesis exploration.</li>
    </ul>
    <p style="margin:8px 0 0;">Timeout note: run these gates as separate commands to keep each execution bounded and resilient. If any approved behavior fix is applied, restart the workflow from scenario 1 and rerun all active gates.</p>
  </div>
</div>

${gfsSizingSection}

${mutationSection}

${goldenOverviewHtml}

<details id="section-scenarios" class="coverage-section" style="margin-bottom:20px;">
  <summary style="padding:12px 20px;cursor:pointer;font-size:13px;font-weight:600;color:#1e3a5f;list-style:none;display:flex;align-items:center;gap:8px;"><span style="font-size:10px">&#9654;</span>&nbsp;Scenario Validation</summary>
  <div style="padding:0 20px 12px;">
  <div class="report-controls" style="margin-bottom:16px;">
    <button type="button" class="ctl-btn" id="expandAllBtn">Expand All</button>
    <button type="button" class="ctl-btn" id="collapseAllBtn">Collapse All</button>
    <input id="scenarioSearch" class="ctl-search" type="search" placeholder="Search scenarios (id, layer, rule e.g. R-ARCH-03, layer 2, od-sobr...)" />
    <div class="ctl-chips">
      <button class="chip" data-filter-status="pass">PASS</button>
      <button class="chip" data-filter-status="skip">SKIP</button>
      <button class="chip" data-filter-status="fail">FAIL</button>
      <button class="chip" data-filter-layer="1">Layer 1</button>
      <button class="chip" data-filter-layer="2">Layer 2</button>
      <button class="chip" data-filter-layer="3">Layer 3</button>
      <button class="chip" data-filter-layer="4">Layer 4</button>
    </div>
    <span class="ctl-hint">Tip: search by rule ID, scenario ID, or layer.</span>
    <span class="ctl-count" id="scenarioCount"></span>
  </div>

  ${layerSections}
  </div>
</details>

<details id="section-rule-coverage" class="coverage-section" style="margin-bottom:20px;">
  <summary style="padding:12px 20px;cursor:pointer;font-size:13px;font-weight:600;color:#1e3a5f;list-style:none;display:flex;align-items:center;gap:8px;"><span style="font-size:10px">&#9654;</span>&nbsp;Contract Rule Coverage</summary>
  <div style="padding:0 20px 12px;">
  <p style="margin:12px 0 4px;font-size:12px;color:#6b7280;">Each rule in the contract is listed below with which scenarios cover it. Hover over a rule tag in any scenario card to see the rule description.</p>
  <table class="ctable" style="margin-top:12px;">
    <thead><tr><th>Rule</th><th>Description</th><th>Covered by</th><th>Status</th></tr></thead>
    <tbody>
${coverageRows}
    </tbody>
  </table>
  </div>
</details>

</div>

<div class="report-footer">
  Veeam Repos Simulator &nbsp;·&nbsp; Quality &amp; Validation Report &nbsp;·&nbsp; ${results.length} scenarios &nbsp;·&nbsp; ${totalDaysSimulated.toLocaleString()} simulation-days
</div>

<script>
  (function () {
    const cards = Array.from(document.querySelectorAll('.sc-card'));
    const layerSections = Array.from(document.querySelectorAll('.layer-section'));
    const expandAllBtn = document.getElementById('expandAllBtn');
    const collapseAllBtn = document.getElementById('collapseAllBtn');
    const searchInput = document.getElementById('scenarioSearch');
    const scenarioCount = document.getElementById('scenarioCount');
    const chips = Array.from(document.querySelectorAll('.chip'));

    // Default: all collapsed, except non-pass scenarios are expanded for visibility.
    cards.forEach((card) => {
      const status = (card.getAttribute('data-status') || '').toLowerCase();
      card.open = status === 'fail' || status === 'skip';
    });

    function activeStatusChips() {
      return chips.filter((c) => c.classList.contains('active') && c.hasAttribute('data-filter-status'))
                  .map((c) => c.getAttribute('data-filter-status'));
    }

    function activeLayerChips() {
      return chips.filter((c) => c.classList.contains('active') && c.hasAttribute('data-filter-layer'))
                  .map((c) => c.getAttribute('data-filter-layer'));
    }

    function visibleCards() {
      return cards.filter((c) => c.style.display !== 'none');
    }

    function refreshLayerVisibility() {
      layerSections.forEach((section) => {
        const sectionCards = Array.from(section.querySelectorAll('.sc-card'));
        const anyVisible = sectionCards.some((c) => c.style.display !== 'none');
        section.style.display = anyVisible ? '' : 'none';
      });
    }

    function updateCount() {
      if (!scenarioCount) return;
      const count = visibleCards().length;
      scenarioCount.textContent = count + ' scenario' + (count === 1 ? '' : 's') + ' visible';
    }

    function applyFilter() {
      const raw = searchInput ? searchInput.value : '';
      const q = (raw || '').trim().toLowerCase();
      const statusFilters = activeStatusChips();
      const layerFilters = activeLayerChips();
      cards.forEach((card) => {
        const haystack = (card.getAttribute('data-search') || '').toLowerCase();
        const cardStatus = (card.getAttribute('data-status') || '').toLowerCase();
        const cardLayer = card.getAttribute('data-layer') || '';
        const textMatch = !q || haystack.includes(q);
        const statusMatch = statusFilters.length === 0 || statusFilters.includes(cardStatus);
        const layerMatch = layerFilters.length === 0 || layerFilters.includes(cardLayer);
        card.style.display = (textMatch && statusMatch && layerMatch) ? '' : 'none';
      });
      refreshLayerVisibility();
      updateCount();
    }

    chips.forEach((chip) => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('active');
        applyFilter();
      });
    });

    if (searchInput) {
      searchInput.addEventListener('input', () => { applyFilter(); });
    }

    if (expandAllBtn) {
      expandAllBtn.addEventListener('click', () => {
        visibleCards().forEach((card) => { card.open = true; });
      });
    }

    if (collapseAllBtn) {
      collapseAllBtn.addEventListener('click', () => {
        visibleCards().forEach((card) => { card.open = false; });
      });
    }

    applyFilter();
  })();
</script>

</body>
</html>`;

  writeFileSync(outputPath, html, 'utf-8');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const scenariosPath = join(
    process.cwd(),
    'docs',
    'lifecycle-test-scenarios.json'
  );

  let raw: string;
  try {
    raw = readFileSync(scenariosPath, 'utf-8');
  } catch (err) {
    console.error(`Cannot read scenarios file: ${scenariosPath}`);
    process.exit(1);
  }

  // Strip JS-style // comments before parsing (the JSON file uses them)
  const stripped = raw.replace(/\/\/[^\n]*/g, '');
  const data = JSON.parse(stripped) as { scenarios: LifecycleScenario[] };

  const args = process.argv.slice(2);
  const updateSnapshots = args.includes('--update-snapshots');
  const filterById = args.find((a) => !a.startsWith('--'));
  const scenarios = filterById
    ? data.scenarios.filter((s) => s.id === filterById)
    : data.scenarios;

  if (scenarios.length === 0) {
    console.error(`No scenarios found${filterById ? ` with id '${filterById}'` : ''}.`);
    process.exit(1);
  }

  console.log(`\n=== Lifecycle Test Runner ===`);
  if (updateSnapshots) {
    console.log(`Golden snapshot mode: UPDATE`);
  }
  console.log(`Running ${scenarios.length} scenario(s)...\n`);

  const goldenSnapshots = new GoldenSnapshotManager(
    join(process.cwd(), 'docs', 'golden-snapshots.json'),
    updateSnapshots
  );

  const results: RunResult[] = [];
  for (const sc of scenarios) {
    process.stdout.write(`  [${sc.layer}] ${sc.id.padEnd(48)} `);
    const result = runScenario(sc, goldenSnapshots);
    results.push(result);
    if (result.passed && !result.skipped) {
      console.log(`PASS  (${result.days}d, ${result.durationMs}ms)`);
    } else if (result.skipped) {
      console.log(`SKIP  known-gap: ${result.skippedRules?.join(', ')}`);
    } else {
      console.log(`FAIL  (${result.violations.length} violation(s))`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const passed  = results.filter((r) => r.passed && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed  = results.filter((r) => !r.passed).length;

  console.log(`\n─────────────────────────────────────────────────────`);
  console.log(`Results: ${passed} passed, ${skipped} skipped (known gaps), ${failed} failed`);

  goldenSnapshots.saveIfDirty();
  if (updateSnapshots) {
    console.log(`Golden snapshots updated: docs/golden-snapshots.json`);
  }

  // Write HTML report
  const reportPath = join(process.cwd(), 'docs', 'lifecycle-report.html');
  const mutationReport = readMutationReport();
  const gfsSizingTestStatus = readGfsSizingTestStatusFromEnv();
  const gfsSizingReport = readGfsSizingReport();
  writeHtmlReport(scenarios, results, reportPath, mutationReport, gfsSizingTestStatus, gfsSizingReport);
  console.log(`\nReport: docs/lifecycle-report.html`);

  if (failed > 0) {
    console.log(`\n=== Failures ===\n`);
    for (const result of results.filter((r) => !r.passed)) {
      const hasSnapshotViolations = result.violations.some((v) => v.violatedRule === 'R-SNAP-01');
      const snapshotOnlyFailure = hasSnapshotViolations && result.violations.every((v) => v.violatedRule === 'R-SNAP-01');

      console.log(`SCENARIO: ${result.id} — ${result.name}`);
      if (snapshotOnlyFailure) {
        console.log(`  diagnosis: snapshot baseline drift only (R-SNAP-01).`);
        console.log(`             If behavior change is intentional, run: npm run test:lifecycle -- --update-snapshots`);
      } else if (hasSnapshotViolations) {
        console.log(`  diagnosis: mixed failure (snapshot drift + logic assertions).`);
      } else {
        console.log(`  diagnosis: logic regression (non-snapshot assertions).`);
      }
      for (const v of result.violations.slice(0, 20)) {
        console.log(
          `  day ${String(v.day).padStart(4)} | ${v.date} | ${v.chainId ?? v.rpId ?? v.genId ?? '-'} | rule ${v.violatedRule}`
        );
        console.log(`          expected: ${v.expected}`);
        console.log(`          actual:   ${v.actual}`);
      }
      if (result.violations.length > 20) {
        console.log(`  ... and ${result.violations.length - 20} more violation(s)`);
      }
      console.log();
    }
    process.exit(1);
  }
}

main();
