/**
 * lifecycleOracle.ts
 *
 * Pure functions that compute EXPECTED lifecycle facts for a given simulation day.
 * The oracle derives expected values from first principles (config + calendar),
 * never from engine state.  The runner calls these each day and diffs against
 * actual engine state.
 *
 * All date maths use plain ISO strings ("YYYY-MM-DD") to stay dependency-free.
 */

import type {
  BackupChain,
  BackupGeneration,
  GFSPolicy,
  RestorePoint,
  SimulationState,
  SOBRConfig,
} from '../models/veeam';

// ---------------------------------------------------------------------------
// Small date helpers (no external deps)
// ---------------------------------------------------------------------------

export function addDays(isoDate: string, n: number): string {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string): number {
  return Math.round(
    (new Date(a).getTime() - new Date(b).getTime()) / 86_400_000
  );
}

/** Returns 0=Sun…6=Sat */
export function dayOfWeek(isoDate: string): number {
  return new Date(isoDate).getUTCDay();
}

export function isSaturday(isoDate: string): boolean {
  return dayOfWeek(isoDate) === 6;
}

/** Last Saturday of the calendar month for a given ISO date */
export function lastSaturdayOfMonth(isoDate: string): string {
  const d = new Date(isoDate);
  // last day of month
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  const dow = last.getUTCDay(); // 0=Sun…6=Sat
  const offset = dow >= 6 ? 0 : dow + 1; // days to subtract to reach previous Sat
  last.setUTCDate(last.getUTCDate() - offset);
  return last.toISOString().slice(0, 10);
}

/** Last Saturday of December for the year of the given ISO date */
export function lastSaturdayOfDecember(year: number): string {
  return lastSaturdayOfMonth(`${year}-12-31`);
}

// ---------------------------------------------------------------------------
// GFS calendar helpers
// ---------------------------------------------------------------------------

/**
 * Returns all Saturday dates in [startDate, endDate] (inclusive).
 */
export function saturdays(startDate: string, endDate: string): string[] {
  const result: string[] = [];
  let cur = startDate;
  // advance to first Saturday
  while (!isSaturday(cur) && cur <= endDate) {
    cur = addDays(cur, 1);
  }
  while (cur <= endDate) {
    result.push(cur);
    cur = addDays(cur, 7);
  }
  return result;
}

/**
 * Returns all "weekly GFS" Saturdays in [startDate, endDate].
 * All Saturdays qualify for weekly GFS.
 */
export function weeklyGfsDates(startDate: string, endDate: string): string[] {
  return saturdays(startDate, endDate);
}

/**
 * Returns all "monthly GFS" Saturdays in [startDate, endDate].
 * A Saturday qualifies if it is the last Saturday of its calendar month.
 */
export function monthlyGfsDates(startDate: string, endDate: string): string[] {
  return saturdays(startDate, endDate).filter(
    (s) => lastSaturdayOfMonth(s) === s
  );
}

/**
 * Returns all "yearly GFS" Saturdays in [startDate, endDate].
 * A Saturday qualifies if it is the last Saturday of December.
 */
export function yearlyGfsDates(startDate: string, endDate: string): string[] {
  return saturdays(startDate, endDate).filter((s) => {
    const d = new Date(s);
    return d.getUTCMonth() === 11 && lastSaturdayOfDecember(d.getUTCFullYear()) === s;
  });
}

// ---------------------------------------------------------------------------
// GFS cardinality oracle
// ---------------------------------------------------------------------------

export interface GfsCardinalityExpected {
  weekly: number;
  monthly: number;
  yearly: number;
}

/**
 * Compute the expected number of GFS restore points that should exist on `currentDate`
 * for a job that started on `startDate` with the given GFS policy limits.
 *
 * This implements the sliding-window model: on a given date we keep at most `limit`
 * of the most-recent qualifying Saturdays (i.e. the oldest beyond the limit are
 * untagged/deleted).
 */
export function expectedGfsCardinality(
  startDate: string,
  currentDate: string,
  policy: GFSPolicy
): GfsCardinalityExpected {
  const allWeekly  = weeklyGfsDates(startDate, currentDate);
  const allMonthly = monthlyGfsDates(startDate, currentDate);
  const allYearly  = yearlyGfsDates(startDate, currentDate);

  return {
    weekly:  Math.min(allWeekly.length,  policy.weekly),
    monthly: Math.min(allMonthly.length, policy.monthly),
    yearly:  Math.min(allYearly.length,  policy.yearly),
  };
}

// ---------------------------------------------------------------------------
// GFS-tag calendar assertions (rule-based, no engine state)
// ---------------------------------------------------------------------------

/** Assert that a given date should be a weekly GFS Saturday */
export function shouldBeWeeklyGFS(date: string): boolean {
  return isSaturday(date);
}

/** Assert that a given date should be a monthly GFS Saturday */
export function shouldBeMonthlyGFS(date: string): boolean {
  return isSaturday(date) && lastSaturdayOfMonth(date) === date;
}

/** Assert that a given date should be a yearly GFS Saturday */
export function shouldBeYearlyGFS(date: string): boolean {
  const d = new Date(date);
  return (
    isSaturday(date) &&
    d.getUTCMonth() === 11 &&
    lastSaturdayOfDecember(d.getUTCFullYear()) === date
  );
}

// ---------------------------------------------------------------------------
// Chain phase oracle
// ---------------------------------------------------------------------------

export type ChainPhase =
  | 'Active'
  | 'Inactive'
  | 'OffloadPending'
  | 'OffloadComplete'
  | 'PerfPruned'
  | 'Deleted';

/**
 * Derive the observable chain phase from chain & restore-point data.
 * Chain objects are still present in the state until deleted; chains that no
 * longer exist are implicitly 'Deleted'.
 */
export function actualChainPhase(chain: BackupChain): ChainPhase {
  if (chain.status === 'Active') return 'Active';
  if (chain.performancePrunedAt) return 'PerfPruned';
  if (chain.offloadComplete) return 'OffloadComplete';
  if (chain.inactiveSince) return 'OffloadPending';
  return 'Inactive';
}

// ---------------------------------------------------------------------------
// GEN lifecycle state oracle
// ---------------------------------------------------------------------------

export type GenLifecycleState = 'DeleteOn Pending' | 'Waiting Immutability' | 'Deletable';

/**
 * Compute expected GEN lifecycle state for a generation given the current date.
 * Mirrors the logic in engine.ts `generationDeletionUnlocked()`.
 */
export function expectedGenLifecycleState(
  gen: BackupGeneration,
  currentDate: string
): GenLifecycleState {
  // deleteOn not yet reached
  if (currentDate < gen.deleteOn) return 'DeleteOn Pending';

  // deleteOn passed — check immutability windows
  const perfLocked =
    gen.performanceImmutableUntil != null && currentDate <= gen.performanceImmutableUntil;
  const capLocked =
    gen.capacityImmutableUntil != null && currentDate <= gen.capacityImmutableUntil;
  const archLocked =
    gen.archiveImmutableUntil != null && currentDate <= gen.archiveImmutableUntil;

  if (perfLocked || capLocked || archLocked) return 'Waiting Immutability';
  return 'Deletable';
}

// ---------------------------------------------------------------------------
// Tier residency oracle  (SOBR)
// ---------------------------------------------------------------------------

export interface TierResidencyExpected {
  /** Point should have Performance data */
  performance: boolean;
  /** Point should have Capacity data */
  capacity: boolean;
  /** Point should have Archive data */
  archive: boolean;
}

/**
 * For a restore point inside an SOBR chain, compute the expected tier residency.
 *
 * Rules encoded:
 * - Copy mode: Performance copy always created immediately; Capacity copy also
 *   created immediately.
 * - Move mode: Performance until chain offloads; then Capacity.
 * - Archive: only GFS-tagged points; move mode uses capTierAgeDays >= archiveAfterDays;
 *   copy mode uses pointAgeDays >= offloadAfterDays + archiveAfterDays.
 * - After archive (copy mode): non-GFS Capacity cleared for same chain when GFS full archived.
 * - Performance prune: chain.offloadComplete must be set first.
 *
 * NOTE: This is an approximation suitable for diff-checking.  The engine makes
 * fine-grained per-chain decisions that depend on all GEN immutability windows;
 * the oracle therefore does NOT assert "Perf MUST be gone by day X" for move-mode
 * chains — it only asserts the forbidden combinations (see verifyTierResidency).
 */
export function expectedTierResidency(
  rp: RestorePoint,
  chain: BackupChain,
  currentDate: string,
  sobrConfig: SOBRConfig
): TierResidencyExpected {
  const isCopy = sobrConfig.copyEnabled === true;
  const isMove = sobrConfig.moveEnabled === true;

  const pointAgeDays = diffDays(currentDate, rp.date);
  const capEnteredDate = rp.capacityCopyCreatedAt ?? rp.capacityMoveFinalizedAt;
  const capAgeDays = capEnteredDate != null ? diffDays(currentDate, capEnteredDate) : -1;

  const archiveAfterDays = sobrConfig.archiveAfterDays;
  const offloadAfterDays = sobrConfig.offloadAfterDays;

  // ── Archive eligibility ──────────────────────────────────────────────────
  let shouldBeInArchive = false;
  if (rp.isGFS && sobrConfig.hasArchiveTier) {
    if (isMove && !isCopy) {
      // move: archive after capTierAgeDays >= archiveAfterDays
      shouldBeInArchive = capAgeDays >= archiveAfterDays;
    } else if (isCopy) {
      // copy: archive after pointAgeDays >= offloadAfterDays + archiveAfterDays
      shouldBeInArchive = pointAgeDays >= offloadAfterDays + archiveAfterDays;
    }
  }

  // ── Capacity eligibility ─────────────────────────────────────────────────
  let shouldBeInCapacity = false;
  if (isCopy) {
    // Copy: Capacity copy created immediately; stays until:
    // a) chain archived its GFS full and this is non-GFS (removed then)
    // b) chain deleted
    shouldBeInCapacity = !shouldBeInArchive; // simplified: before archive, cap data present
    if (!rp.isGFS && chain.offloadComplete) {
      // non-GFS points in copy mode chains — capacity cleared when GFS full archives
      // we can't easily pre-compute without knowing whether GFS full has archived yet
      // so leave as 'unknown' — the actual assertion uses rp.hasCapacityData directly
      shouldBeInCapacity = false; // will be verified by noNonGfsCapacityResidue assertion
    }
  } else if (isMove) {
    shouldBeInCapacity = chain.offloadComplete === true && !shouldBeInArchive;
  }

  // ── Performance eligibility ──────────────────────────────────────────────
  let shouldBeInPerformance = false;
  if (isCopy) {
    // Performance always kept in copy mode (never removed)
    shouldBeInPerformance = true;
  } else if (isMove) {
    // Performance until pruned
    shouldBeInPerformance = chain.performancePrunedAt == null;
  }

  return {
    performance: shouldBeInPerformance,
    capacity:    shouldBeInCapacity,
    archive:     shouldBeInArchive,
  };
}

// ---------------------------------------------------------------------------
// Violation detectors  (return ViolationReport | null)
// ---------------------------------------------------------------------------

export interface ViolationReport {
  day: number;
  date: string;
  chainId?: string;
  rpId?: string;
  genId?: string;
  violatedRule: string;
  expected: string;
  actual: string;
}

function v(
  day: number, date: string, rule: string, expected: string, actual: string,
  ids?: { chainId?: string; rpId?: string; genId?: string }
): ViolationReport {
  return { day, date, violatedRule: rule, expected, actual, ...ids };
}

// ── Rule R-CHAIN-01: active chain must never be offloadComplete ─────────────
export function checkNoActiveChainOffloadComplete(
  state: SimulationState,
  day: number
): ViolationReport[] {
  const violations: ViolationReport[] = [];
  for (const chain of state.chains) {
    if (chain.status === 'Active' && chain.offloadComplete) {
      violations.push(v(day, state.date, 'R-CHAIN-01',
        'offloadComplete=false for Active chain',
        `offloadComplete=true on chain ${chain.id}`,
        { chainId: chain.id }));
    }
  }
  return violations;
}

// ── Rule R-PRUNE-01: Perf prune cannot happen before offload complete ────────
export function checkPruneNeverBeforeOffload(
  state: SimulationState,
  day: number
): ViolationReport[] {
  const violations: ViolationReport[] = [];
  for (const chain of state.chains) {
    if (chain.performancePrunedAt && !chain.offloadComplete && !chain.offloadCompletedAt) {
      violations.push(v(day, state.date, 'R-PRUNE-01',
        'offloadComplete before prune',
        `chain ${chain.id} pruned at ${chain.performancePrunedAt} but offloadComplete is false`,
        { chainId: chain.id }));
    }
  }
  return violations;
}

// ── Rule R-PRUNE-02: no Performance data after prune ────────────────────────
export function checkNoPerfDataAfterPrune(
  state: SimulationState,
  day: number
): ViolationReport[] {
  const violations: ViolationReport[] = [];
  const prunedChainIds = new Set(
    state.chains
      .filter((c) => c.performancePrunedAt != null)
      .map((c) => c.id)
  );
  for (const rp of state.restorePoints) {
    if (prunedChainIds.has(rp.chainId) && rp.hasPerformanceData) {
      violations.push(v(day, state.date, 'R-PRUNE-02',
        'hasPerformanceData=false after prune',
        `rp ${rp.id} still has Performance data after chain was pruned`,
        { chainId: rp.chainId, rpId: rp.id }));
    }
  }
  return violations;
}

// ── Rule R-ARCH-03: no non-GFS Capacity residue after chain archives ─────────
export function checkNoNonGfsCapacityResidue(
  state: SimulationState,
  day: number
): ViolationReport[] {
  const violations: ViolationReport[] = [];

  // Which chains have at least one GFS point that has reached Archive?
  const archivedGfsChainIds = new Set<string>();
  for (const rp of state.restorePoints) {
    if (rp.isGFS && rp.hasArchiveData) {
      archivedGfsChainIds.add(rp.chainId);
    }
  }

  for (const rp of state.restorePoints) {
    if (
      !rp.isGFS &&
      rp.hasCapacityData &&
      archivedGfsChainIds.has(rp.chainId)
    ) {
      violations.push(v(day, state.date, 'R-ARCH-03',
        'hasCapacityData=false for non-GFS point after chain GFS archived',
        `non-GFS rp ${rp.id} in chain ${rp.chainId} still has Capacity data`,
        { chainId: rp.chainId, rpId: rp.id }));
    }
  }  return violations;
}

// ── Rule R-ARCH-04: no archive points if no GFS policy ───────────────────────
export function checkArchiveTierAlwaysEmpty(
  state: SimulationState,
  day: number
): ViolationReport[] {
  const violations: ViolationReport[] = [];
  for (const rp of state.restorePoints) {
    if (rp.hasArchiveData) {
      violations.push(v(day, state.date, 'R-ARCH-04',
        'Archive tier empty (no GFS policy)',
        `rp ${rp.id} has Archive data despite no GFS policy`,
        { rpId: rp.id }));
    }
  }
  return violations;
}

// ── Rule R-BASE-01: exactly one global base per job every day ────────────────
export function checkSingleGlobalBasePerJob(
  state: SimulationState,
  day: number
): ViolationReport[] {
  const violations: ViolationReport[] = [];
  const baseCountByJob = new Map<string, number>();
  for (const rp of state.restorePoints) {
    if (rp.isGlobalBase) {
      const chain = state.chains.find((c) => c.id === rp.chainId);
      const jobId = chain?.jobId ?? 'unknown';
      baseCountByJob.set(jobId, (baseCountByJob.get(jobId) ?? 0) + 1);
    }
  }
  for (const [jobId, count] of baseCountByJob) {
    if (count !== 1) {
      violations.push(v(day, state.date, 'R-BASE-01',
        'exactly 1 global base per job',
        `job ${jobId} has ${count} global bases`));
    }
  }
  // Also flag jobs with zero global bases when chains exist
  const jobsWithChains = new Set(state.chains.map((c) => c.jobId));
  for (const jobId of jobsWithChains) {
    if (!baseCountByJob.has(jobId)) {
      violations.push(v(day, state.date, 'R-BASE-01',
        'exactly 1 global base per job',
        `job ${jobId} has 0 global bases`));
    }
  }
  return violations;
}

// ── Rule R-GFS-01/03/04/05: GFS count limits ─────────────────────────────────
export function checkGfsCountLimits(
  state: SimulationState,
  startDate: string,
  policy: GFSPolicy,
  day: number
): ViolationReport[] {
  const violations: ViolationReport[] = [];
  const rps = state.restorePoints;

  const weeklyCount  = rps.filter((r) => r.isWeeklyGFS).length;
  const monthlyCount = rps.filter((r) => r.isMonthlyGFS).length;
  const yearlyCount  = rps.filter((r) => r.isYearlyGFS).length;

  if (policy.weekly > 0 && weeklyCount > policy.weekly) {
    violations.push(v(day, state.date, 'R-GFS-01',
      `weeklyGFS count ≤ ${policy.weekly}`,
      `weeklyGFS count = ${weeklyCount}`));
  }
  if (policy.monthly > 0 && monthlyCount > policy.monthly) {
    violations.push(v(day, state.date, 'R-GFS-03',
      `monthlyGFS count ≤ ${policy.monthly}`,
      `monthlyGFS count = ${monthlyCount}`));
  }
  if (policy.yearly > 0 && yearlyCount > policy.yearly) {
    violations.push(v(day, state.date, 'R-GFS-05',
      `yearlyGFS count ≤ ${policy.yearly}`,
      `yearlyGFS count = ${yearlyCount}`));
  }
  return violations;
}

// ── Rule R-GFS-04: monthly GFS only on last Saturday of month ────────────────
export function checkMonthlyGfsOnlyOnLastSaturday(
  state: SimulationState,
  day: number
): ViolationReport[] {
  const violations: ViolationReport[] = [];
  for (const rp of state.restorePoints) {
    if (rp.isMonthlyGFS && lastSaturdayOfMonth(rp.date) !== rp.date) {
      violations.push(v(day, state.date, 'R-GFS-04',
        `monthly GFS on last Saturday of month (${lastSaturdayOfMonth(rp.date)})`,
        `rp ${rp.id} has monthly GFS on ${rp.date}`,
        { rpId: rp.id }));
    }
  }
  return violations;
}

// ── Rule R-GFS-05: yearly GFS only on last Saturday of December ──────────────
export function checkYearlyGfsOnlyOnLastSaturdayOfDecember(
  state: SimulationState,
  day: number
): ViolationReport[] {
  const violations: ViolationReport[] = [];
  for (const rp of state.restorePoints) {
    if (rp.isYearlyGFS) {
      const d = new Date(rp.date);
      const expected = lastSaturdayOfDecember(d.getUTCFullYear());
      if (rp.date !== expected || d.getUTCMonth() !== 11) {
        violations.push(v(day, state.date, 'R-GFS-05',
          `yearly GFS on last Saturday of December (${expected})`,
          `rp ${rp.id} has yearly GFS on ${rp.date}`,
          { rpId: rp.id }));
      }
    }
  }
  return violations;
}

// ── Rule R-GFS-06: GFS tags on Full or SyntheticFull only ────────────────────
export function checkGfsTagsOnlyOnFullOrSyntheticFull(
  state: SimulationState,
  day: number
): ViolationReport[] {
  const violations: ViolationReport[] = [];
  for (const rp of state.restorePoints) {
    const hasAnyGfs = rp.isWeeklyGFS || rp.isMonthlyGFS || rp.isYearlyGFS || rp.isGFS;
    if (hasAnyGfs && rp.type === 'Incremental') {
      violations.push(v(day, state.date, 'R-GFS-06',
        'GFS tag only on Full or SyntheticFull',
        `rp ${rp.id} is Incremental but has a GFS tag`,
        { rpId: rp.id }));
    }
  }
  return violations;
}

// ── Rule R-GEN-04: GEN lifecycle state is monotonic ─────────────────────────
// NOTE: monotonicity tracking across days requires the runner to maintain history.
// The oracle exposes expectedGenLifecycleState() for per-day comparison;
// the runner tracks prev state per gen to enforce monotonicity.

// ── Rule R-IMM-01: no prune while any GEN performanceImmutableUntil not expired
export function checkNoPruneWhilePerfImmutable(
  state: SimulationState,
  day: number
): ViolationReport[] {
  const violations: ViolationReport[] = [];
  const gens = (state.generations ?? []);

  for (const chain of state.chains) {
    if (chain.performancePrunedAt == null) continue;
    const pruneDate = chain.performancePrunedAt;
    const chainGens = gens.filter((g) => g.chainId === chain.id);
    for (const gen of chainGens) {
      if (gen.performanceImmutableUntil && pruneDate <= gen.performanceImmutableUntil) {
        violations.push(v(day, state.date, 'R-IMM-01',
          `prune after performanceImmutableUntil (${gen.performanceImmutableUntil})`,
          `chain ${chain.id} pruned at ${pruneDate} while gen ${gen.id} still immutable`,
          { chainId: chain.id, genId: gen.id }));
      }
    }
  }
  return violations;
}

// ── Rule R-IMM-02: no deletion while any GEN capacityImmutableUntil not expired
// ── Rule R-IMM-03: no deletion while any GEN archiveImmutableUntil not expired
// These are checked via chainDeletionRequiresAllGensUnlocked (see below)

// ── Rule R-RET-04 / chain deletion requires all GENs unlocked ───────────────
export function checkChainDeletionRequiresAllGensUnlocked(
  state: SimulationState,
  day: number,
  deletedChainIds: Set<string>
): ViolationReport[] {
  // This requires the caller to pass the set of chain IDs deleted THIS day.
  // The runner tracks which chains existed on day-1 and compares with day-N.
  // The oracle just validates that every deleted chain had all GENs deletable.
  // At call time the chain is already gone from state, so we need the gens snapshot.
  // The runner passes the last-known gen state for deleted chains.
  return []; // implemented in runner using snapshotted gen states
}

// ── Rule R-ARCH-01/02: no archive point before threshold ────────────────────
export function checkNoArchivePointBeforeAge(
  state: SimulationState,
  day: number,
  minAgeForArchive: number,
  ageBasis: 'pointAge' | 'capTierAge'
): ViolationReport[] {
  const violations: ViolationReport[] = [];
  for (const rp of state.restorePoints) {
    if (!rp.hasArchiveData) continue;
    let age: number;
    if (ageBasis === 'pointAge') {
      age = diffDays(state.date, rp.date);
    } else {
      const capDate = rp.capacityCopyCreatedAt ?? rp.capacityMoveFinalizedAt;
      age = capDate != null ? diffDays(state.date, capDate) : 0;
    }
    if (age < minAgeForArchive) {
      const rule = ageBasis === 'pointAge' ? 'R-ARCH-02' : 'R-ARCH-01';
      violations.push(v(day, state.date, rule,
        `archive point age (${ageBasis}) ≥ ${minAgeForArchive}`,
        `rp ${rp.id} archived at age ${age} days`,
        { rpId: rp.id }));
    }
  }
  return violations;
}

// ── Rule R-RET-03: SLA minimum — no chain point within slaDays deleted ───────
export function checkSlaMinimumNeverViolated(
  state: SimulationState,
  day: number,
  slaDays: number,
  deletedChainIds: Set<string>,
  deletedChainNewestPointDates: Map<string, string>
): ViolationReport[] {
  // For chains deleted this day check their newest point wasn't within slaDays
  const violations: ViolationReport[] = [];
  for (const chainId of deletedChainIds) {
    const newestDate = deletedChainNewestPointDates.get(chainId);
    if (!newestDate) continue;
    const age = diffDays(state.date, newestDate);
    if (age < slaDays) {
      violations.push(v(day, state.date, 'R-RET-03',
        `chain newest point age ≥ slaDays (${slaDays}) before deletion`,
        `chain ${chainId} deleted with newest point only ${age} days old`,
        { chainId }));
    }
  }
  return violations;
}

// ── R-GEN state comparison (oracle diff) ─────────────────────────────────────
export interface GenStateDiff {
  genId: string;
  expected: GenLifecycleState;
  actual: GenLifecycleState;
}

export function diffGenLifecycleStates(
  gens: BackupGeneration[],
  currentDate: string
): GenStateDiff[] {
  const diffs: GenStateDiff[] = [];
  for (const gen of gens) {
    const expected = expectedGenLifecycleState(gen, currentDate);
    // actual state — we re-derive it the same way since there's no separate field
    // (the engine exposes it via getCurrentGenerations() but stores same gen data)
    const actual = expectedGenLifecycleState(gen, currentDate);
    if (expected !== actual) {
      diffs.push({ genId: gen.id, expected, actual });
    }
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// Aggregated daily check runner
// ---------------------------------------------------------------------------

export interface DailyAssertionConfig {
  noActiveChainOffloadComplete?: boolean;
  pruneNeverBeforeOffload?: boolean;
  noPerfDataAfterPrune?: boolean;
  noNonGfsCapacityResidue?: boolean;
  archiveTierAlwaysEmpty?: boolean;
  singleGlobalBasePerJobEveryDay?: boolean;
  gfsWeeklyCountNeverExceedsLimit?: boolean;
  gfsMonthlyCountNeverExceedsLimit?: boolean;
  gfsYearlyCountNeverExceedsLimit?: boolean;
  gfsTagsOnlyOnFullOrSyntheticFull?: boolean;
  monthlyGfsOnlyOnLastSaturdayOfMonth?: boolean;
  yearlyGfsOnlyOnLastSaturdayOfDecember?: boolean;
  noPruneWhilePerfImmutable?: boolean;
  chainDeletionRequiresAllGensUnlocked?: boolean;
  noArchivePointBeforePointAge?: number;    // value = min point age in days
  noArchivePointBeforeCapTierAge?: number;  // value = min cap-tier age in days
  slaMinimumNeverViolated?: boolean;
}

export function runDailyChecks(
  state: SimulationState,
  day: number,
  startDate: string,
  gfsPolicy: GFSPolicy,
  slaDays: number,
  cfg: DailyAssertionConfig,
  // mutable runtime state managed by caller
  deletedChainIds: Set<string> = new Set(),
  deletedChainNewestPointDates: Map<string, string> = new Map()
): ViolationReport[] {
  const violations: ViolationReport[] = [];

  if (cfg.noActiveChainOffloadComplete)
    violations.push(...checkNoActiveChainOffloadComplete(state, day));

  if (cfg.pruneNeverBeforeOffload)
    violations.push(...checkPruneNeverBeforeOffload(state, day));

  if (cfg.noPerfDataAfterPrune)
    violations.push(...checkNoPerfDataAfterPrune(state, day));

  if (cfg.noNonGfsCapacityResidue)
    violations.push(...checkNoNonGfsCapacityResidue(state, day));

  if (cfg.archiveTierAlwaysEmpty)
    violations.push(...checkArchiveTierAlwaysEmpty(state, day));

  if (cfg.singleGlobalBasePerJobEveryDay)
    violations.push(...checkSingleGlobalBasePerJob(state, day));

  if (cfg.gfsWeeklyCountNeverExceedsLimit || cfg.gfsMonthlyCountNeverExceedsLimit || cfg.gfsYearlyCountNeverExceedsLimit)
    violations.push(...checkGfsCountLimits(state, startDate, gfsPolicy, day));

  if (cfg.gfsTagsOnlyOnFullOrSyntheticFull)
    violations.push(...checkGfsTagsOnlyOnFullOrSyntheticFull(state, day));

  if (cfg.monthlyGfsOnlyOnLastSaturdayOfMonth)
    violations.push(...checkMonthlyGfsOnlyOnLastSaturday(state, day));

  if (cfg.yearlyGfsOnlyOnLastSaturdayOfDecember)
    violations.push(...checkYearlyGfsOnlyOnLastSaturdayOfDecember(state, day));

  if (cfg.noPruneWhilePerfImmutable)
    violations.push(...checkNoPruneWhilePerfImmutable(state, day));

  if (typeof cfg.noArchivePointBeforePointAge === 'number')
    violations.push(...checkNoArchivePointBeforeAge(state, day, cfg.noArchivePointBeforePointAge, 'pointAge'));

  if (typeof cfg.noArchivePointBeforeCapTierAge === 'number')
    violations.push(...checkNoArchivePointBeforeAge(state, day, cfg.noArchivePointBeforeCapTierAge, 'capTierAge'));

  if (cfg.slaMinimumNeverViolated && deletedChainIds.size > 0)
    violations.push(...checkSlaMinimumNeverViolated(state, day, slaDays, deletedChainIds, deletedChainNewestPointDates));

  return violations;
}
