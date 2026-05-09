# Canonical Veeam Backup Retention Model Specification

**Branch**: `feature/canonical-model-adoption`
**Version**: 1.0 (Draft)
**Status**: Foundational specification for refactoring

---

## Overview

This document formalizes the **canonical behavior model** that governs the Veeam Repos Simulator engine. The simulator implements a day-by-day lifecycle decision tree for backup retention, GFS (Grandfather-Father-Son) policies, generation (immutable copy) lifecycle, and SOBR (Scale-Out Backup Repository) tiering. This spec defines the non-negotiable invariants that the engine must satisfy.

---

## The 6-Point Canonical Specification

### 1. **Retention as Cardinality + SLA Time**

**Rule**: Backup jobs retain restore points based on two independent mechanisms:
- **Cardinality**: Keep the N most recent full chains (where N = job.retention.restorePoints, default 7)
- **SLA Duration**: Keep all restore points within the last S days (where S = job.retention.slaDays, default 30)

**Semantics**:
- A restore point is deletable IFF it is older than BOTH the cardinality threshold AND the SLA threshold
- Cardinality threshold = (most-recent-full date - (N-1) × average-chain-interval)
- SLA threshold = (current-date - S days)
- Deletion occurs when both conditions are satisfied AND no other gating mechanism blocks it

**Invariant**: When retention fires on a restore point, all older points in the same chain are also candidates for deletion.

**Test Coverage**: `lb-das-retention-count`, `lb-das-sla-overrides-count`, layer-1 scenarios

---

### 2. **GFS as Cardinality-Driven Protection**

**Rule**: GFS policies create tagged restore points that receive extended retention through cardinality, independent of the base job retention.

**Semantics**:
- Weekly GFS: Tag every Saturday; keep the W most recent weekly-tagged points across all time
- Monthly GFS: Tag last Saturday of the month; keep the M most recent monthly-tagged points across all time
- Yearly GFS: Tag last Saturday of December; keep the Y most recent yearly-tagged points across all time
- GFS-tagged points cannot be deleted until they lose all their GFS tags (i.e., they fall outside the keep-cardinality window)
- Tags stack: a single restore point can be (weekly + monthly + yearly) simultaneously

**Invariant**:
- GFS tagging is deterministic: date alone determines whether a point receives a tag
- GFS expiry is cardinality-based: once the point is no longer in the top-W/M/Y by tag type, all GFS tags expire
- GFS tags do NOT extend the deletion delete-on date for generations; they only preserve the point itself

**Test Coverage**: `lb-gfs-expiry-order`, `lb-gfs-monthly-boundary`, `lb-gfs-yearly-boundary`, `lb-gfs-stacking`, `od-weekly-gfs-cardinality-exact`, `od-monthly-yearly-cardinality-exact`

---

### 3. **Generations as Atomic, Immutable Copy Lifespans**

**Rule**: Generations (immutable copies on SOBR object tiers) are created as atomic windows of restore points. Each generation has a fixed lifecycle with three immutability periods (one per tier) and a unified deletion boundary.

**Semantics**:
- Generation window: 10 days (default; configurable via repo.sobrConfig.generationPeriodDays)
- Each restore point registered to a generation; multiple RPs can map to one generation window
- Immutability gates:
  - **Performance tier**: 2 days (default; must be on Performance before offload to Capacity)
  - **Capacity tier**: 30 days (default; must be on Capacity before offload to Archive)
  - **Archive tier**: 365 days (default; Archive is always immutable, but locked period is explicit)
- Generation deleteOn boundary: MAX(job.retention baseline, latest-GFS-flag-expiry-date)
  - Base: if no GFS, deleteOn = generation.windowEndDate + job.retention days
  - GFS extension: if GFS flags present, deleteOn = latest-date(rp.date + gfs-period-days) where gfs-period-days comes from the GFS policy
  - Atomic deletion: when deleteOn is reached, the entire generation and all its restore points are deleted together

**Invariant**:
- A generation cannot leave Performance until its immutability period expires
- A generation cannot leave Capacity until its immutability period expires
- A generation cannot be deleted until deleteOn is reached AND all tier immutability periods have expired
- Generation deletion is atomic: once deleteOn is reached, all RPs in the generation are marked for deletion synchronously

**Test Coverage**: `im-gen-window-boundary`, `im-gen-state-transitions`, `im-gen-deleteon-extended-by-gfs`, `im-all-tiers-immutability`, `ix-short-retention-long-gfs`, `od-gen-lifecycle-states`

---

### 4. **Working Space as Static Additive Overhead**

**Rule**: Working space represents the storage overhead for synthetic full roll-up operations during backup execution. It is calculated as a percentage of the performance tier size and is independent of retention, GFS, or generation logic.

**Semantics**:
- Working space = performance tier size × tiered-multiplier
- Multiplier tiers (by performance size):
  - < 10 TB: 1.05 (5% overhead)
  - 10–20 TB: 0.66 (−34% discount)
  - 20–100 TB: 0.40 (−60% discount)
  - 100–500 TB: 0.25 (−75% discount)
  - > 500 TB: 0.10 (−90% discount)
- Working space is added to the total capacity forecast but does not interact with lifecycle or tiering logic

**Invariant**:
- Working space is purely additive; it never reduces total capacity
- Working space is a static function of performance tier size; it does not vary with retention depth, GFS policy, or generation count
- Working space multiplier is monotonically decreasing (economies of scale)

**Test Coverage**: Calculator parity baseline (working space deltas are expected and documented)

---

### 5. **SOBR Tiering as Progressive Stage Transitions**

**Rule**: SOBR (Scale-Out Backup Repository) consists of three tiers (Performance, Capacity, Archive) with time-based or size-based progression rules and generation lifecycle gating.

**Semantics**:
- **Performance → Capacity**: offload when oldest active chain is ≥ offloadAfterDays old AND no generation is performance-immutable
  - Default offloadAfterDays = 30 days
  - Immutability blocks offload: if any generation on Performance has not yet exited immutability, offload is deferred
- **Capacity → Archive**: offload when oldest active chain is ≥ capacityOffloadDays old AND no generation is capacity-immutable AND all RPs in generation past capacity immutability
  - Default capacityOffloadDays = 60 days
  - Similar immutability blocking
- **Tier transitions**: restore points move atomically as part of their generation; if a generation straddles two tiers, only the newest RPs move
- **Move vs Copy**: 
  - Move: RPs removed from source tier after transition
  - Copy: RPs retained in source tier; copy appears in destination tier
- **Non-GFS capacity residue**: restore points that are not GFS-tagged and have aged out of Performance but fall below the Capacity size threshold are deleted (pruned), not archived

**Invariant**:
- A restore point can only be in one tier at a time (for Move mode)
- A restore point can be in multiple tiers simultaneously (for Copy mode)
- Generation immutability gates take precedence over time-based offload thresholds
- Archive tier is immutable-always; once a point enters Archive, it stays until deleteOn and archive-immutability-period both expire

**Test Coverage**: `lb-sobr-offload-threshold`, `lb-sobr-archive-threshold-move`, `lb-sobr-archive-threshold-copy`, `lb-sobr-capacity-residue-after-archive`, `ix-gfs-wmy-move-archive`, `ix-gfs-wmy-copy-archive`

---

### 6. **Calculator Purpose and Parity Boundaries**

**Rule**: The Veeam Calculator is a capacity forecasting tool that projects end-state storage at a fixed horizon (default 3 years). The simulator matches the calculator's semantics for retention, GFS, and tiering logic, but there are documented structural differences.

**Semantics**:
- **Forecast horizon**: fixed 3-year window (1,095 days) from simulation start
- **GFS sizing mode**: each GFS point is sized at its historical date's expected size (growth-based, "reverse mode")
  - This differs from legacy mode (all GFS at initial size) or end-period mode (all at year-3 size)
- **Calculator block-generation overhead**: Veeam Calculator adds 10-day block-generation period overhead to SOBR Capacity/Archive tiers; simulator does not model this yet
- **Parity tolerance**:
  - Planned Capacity: absolute gates by source tier (< 10 TB: ±1 TB, 10–100 TB: ±2 TB, 100–500 TB: ±5 TB, > 500 TB: ±10 TB)
  - Percentage tolerance: 0% (zero-tolerance; deltas reflect structural differences, not rounding)
- **Working space**: both simulator and calculator use the same tiered-multiplier formula as of this spec update

**Known gaps**:
- Block generation period: Veeam adds ~10 days of block-level versioning overhead; simulator treats this as informational only
- Direct-to-Object lifecycle: not yet modeled (deferred to optional improvements)
- Immutability overhead: calculator may account for immutable copy replication overhead; simulator does not

**Invariant**:
- Simulator and calculator use the same GFS bracket table (8-row lookup table with maxDays and modifiers)
- Forecast should derive from first-principles retention/GFS/tiering; empirical calibration factors indicate formula gaps
- If 76/77 scenarios pass, the one failure indicates either a formula bug or an undocumented calculator behavior

**Test Coverage**: `od-calculator-parity-347tb-wmy`, `od-calculator-parity-347tb-wmy-sobr-move`, 77-scenario baseline comparator (76/77 passing as of this branch creation)

---

## Required Changes (Blocking)

These changes must be completed to fully adopt this canonical spec:

### Task 1: Tighten GEN Delete Timing in engine.ts
- **Current**: `recomputeGenerationDeleteOn()` uses calendar math (weekly × 7, monthly × 30, yearly × 365)
- **Target**: deleteOn = MAX(retention baseline, latest-GFS-flag-expiry-date) where expiry is cardinality-based, not calendar-based
- **Rationale**: GFS cardinality is the correct driver; calendar multipliers are approximations
- **Files**: [src/simulator/engine.ts](src/simulator/engine.ts) lines 225–248
- **Test impact**: all 51 lifecycle scenarios should still pass

### Task 2: Formalize GFS Protection Semantics
- **Current**: GFS tags are applied via `tagGFSRestorePoint()` but expiry logic is intertwined with retention
- **Target**: isolate GFS cardinality checks into a dedicated method; make tag expiry independent of retention checks
- **Rationale**: clearer code; easier to verify against spec
- **Files**: [src/simulator/engine.ts](src/simulator/engine.ts), `applyRetentionAndGFS()` method
- **Test impact**: all 51 lifecycle scenarios should still pass

### Task 3: Reduce Forecast Calibration Factors
- **Current**: 5–6 empirical `dasPolicyFactor` values scattered across `sizingForecast.ts` (monthly-only: 2.07 small / 2.04 large, etc.)
- **Target**: derive end-state from canonical retention/GFS/tiering primitives; remove or parameterize empirical factors
- **Rationale**: factors mask formula gaps; canonical adoption requires transparent, first-principles derivation
- **Files**: [src/models/sizingForecast.ts](src/models/sizingForecast.ts) lines ~350–400
- **Test impact**: 76 calculator scenarios should show new baseline; may shift slightly if formula is corrected

### Task 4: Document Canonical Spec in Code
- **Current**: decision tree is commented in engine.ts but not formally specified
- **Target**: add top-of-file spec document (or link to this file); add inline assertions that enforce the 6 invariants
- **Rationale**: long-term maintainability; future contributors understand non-negotiables
- **Files**: [src/simulator/engine.ts](src/simulator/engine.ts) top-of-file comments, `lifecycleRunner.ts` assertions
- **Test impact**: no logic change; pure documentation

---

## Optional Improvements (Nice-to-Have)

These can be deferred to a future refactoring cycle:

- **Direct-to-Object lifecycle**: model archive → direct-to-object transition (requires new tier type)
- **Block generation overhead**: add 10-day SOBR block-generation period to Capacity/Archive sizing
- **Immutability cost accounting**: track and display immutable copy replication overhead
- **Split test suites by intent**: separate lifecycle oracle (semantics) from calculator parity (sizing) into distinct test files
- **Comparator strictness**: decide whether to remove absolute TB gates and enforce percentage tolerance only

---

## Success Criteria

This branch is complete when:
1. ✅ All 51 lifecycle oracle scenarios pass
2. ✅ All 76+ calculator parity scenarios pass (single das-monthly6-retention7-3y-regression is addressed or documented)
3. ✅ GEN delete timing refactored to cardinality-based model
4. ✅ GFS protection semantics isolated and verified
5. ✅ Forecast calibration factors reduced or eliminated
6. ✅ Canonical spec formalized in code comments and test assertions

---

## Merge Strategy

Once complete:
1. All test suites pass (lifecycle + calculator)
2. Squash and merge to `main` with commit message: `feat: adopt canonical model specification (6-point invariants, GEN cardinality timing, reduced calibration)`
3. Tag as `v1.0-canonical-adopted`

---

## References

- Current engine implementation: [src/simulator/engine.ts](src/simulator/engine.ts)
- GFS sizing model: [src/models/gfsSizing.ts](src/models/gfsSizing.ts)
- Forecast model: [src/models/sizingForecast.ts](src/models/sizingForecast.ts)
- Lifecycle test scenarios: [docs/lifecycle-test-scenarios.json](docs/lifecycle-test-scenarios.json)
- Calculator baseline: [docs/veeam-calculator-baseline.json](docs/veeam-calculator-baseline.json)

