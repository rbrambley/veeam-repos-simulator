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

**Rule**: Generation ownership depends on archive mode.

**Standard Archive Mode (Performance -> Capacity -> Archive)**
- Capacity is the GEN root.
- GEN is created when data first enters Capacity tier.
- Archive does not create a new GEN; it inherits GEN membership from Capacity.
- Capacity -> Archive transition preserves generation id, deleteOn, and generation lifecycle semantics.

**Standalone Archive Mode (direct-to-Archive / direct-to-object variants)**
- Archive is the GEN root.
- GEN is created when data first enters Archive tier.
- Capacity is bypassed and does not participate in GEN ownership.

**Current simulator support**
- Standard Archive Mode only.
- Standalone Archive Mode is not implemented yet.

**Semantics**:
- Generation window: 10 days (default; configurable via repo.sobrConfig.generationPeriodDays)
- Immutability gates:
  - Performance: pre-Capacity immutability gate for offload eligibility
  - Capacity: generation immutability lock while generation is in Capacity
  - Archive: generation immutability lock while generation is in Archive
- Generation deleteOn boundary: MAX(job.retention baseline, latest-GFS-flag-expiry-date)
  - Base: if no GFS, deleteOn = generation.windowEndDate + job.retention days
  - GFS extension: if GFS flags present, deleteOn = latest-date(rp.date + gfs-period-days) where gfs-period-days comes from the GFS policy
  - Atomic deletion: when deleteOn is reached, the entire generation and all its restore points are deleted together

**Invariant**:
- In standard mode, no generation exists before Capacity entry.
- Archive does not mint independent generations in standard mode.
- A generation cannot be deleted until deleteOn is reached AND active tier immutability periods have expired.
- Generation deletion is atomic: once deleteOn is reached, all RPs in the generation are marked for deletion synchronously.

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
- **Performance → Capacity**: offload when oldest active chain is ≥ offloadAfterDays old AND all candidate points passed Performance immutability
  - Default offloadAfterDays = 30 days
  - In standard mode, this is a pre-Capacity gate (no GEN exists yet)
  - Immutability blocks offload: if any candidate point in Performance is still within Performance immutability, offload is deferred
- **Capacity → Archive**: offload when oldest active chain is ≥ capacityOffloadDays old AND no generation is capacity-immutable AND all RPs in generation past capacity immutability
  - Default capacityOffloadDays = 60 days
  - Similar immutability blocking
- **Tier transitions**: restore points move atomically as part of their generation; if a generation straddles two tiers, only the newest RPs move
  - In standard mode, GEN ownership is minted at first Capacity entry and preserved into Archive
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

This branch completed the original task list. Remaining intentional gaps are tracked under Optional Improvements and the Contradictions Checklist.

### Completed (May 2026)
- GEN delete timing aligned to active cardinality state (no fixed calendar multiplier extension path).
- GFS cardinality enforcement is explicit and evaluated before generation deleteOn recomputation.
- Canonical invariants are now documented and represented by lifecycle assertions/checklist controls.

### Remaining non-blocking work
- Block-generation overhead parity with Veeam Calculator (capacity sizing delta).
- Standalone Archive Mode (direct-to-Archive GEN root) when feature is introduced.

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
1. ✅ All lifecycle oracle scenarios pass (current suite: 50 scenarios)
2. ✅ All 76+ calculator parity scenarios pass (single das-monthly6-retention7-3y-regression is addressed or documented)
3. ✅ GEN delete timing refactored to cardinality-based model
4. ✅ GFS protection semantics isolated and verified
5. ✅ Forecast/shared sizing logic kept centralized and consistent across UI and validation paths
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
- Working space model: [src/models/veeam.ts](src/models/veeam.ts)
- Lifecycle test scenarios: [docs/lifecycle-test-scenarios.json](docs/lifecycle-test-scenarios.json)
- Calculator baseline: [docs/veeam-calculator-baseline.json](docs/veeam-calculator-baseline.json)

---

## Contradictions Checklist

Use this checklist as a merge gate for any PR that touches `engine.ts`, `InputForm.tsx`, `OutputPanel.tsx`, lifecycle scenarios, or canonical docs.

| Rule | Source of truth (spec / code / tests) | Status |
|---|---|---|
| Standard mode GEN root is Capacity (not Performance) | Spec: Section 3 (Standard Archive Mode). Code: `registerPointInGeneration(...)` invoked on Capacity-entry paths in `src/simulator/engine.ts`. Tests: `od-gen-lifecycle-states`. | Aligned |
| Performance immutability is pre-Capacity gate (point-level) | Spec: Section 5 Performance -> Capacity semantics. Code: `performancePointImmutabilityExpired(...)` and offload deferral in `applySOBROffload()` in `src/simulator/engine.ts`. Tests: `lb-sobr-offload-threshold`, `im-perf-immutability-blocks-prune`. | Aligned |
| Capacity -> Archive inherits GEN identity (no new Archive GEN in standard mode) | Spec: Section 3 + Section 5 transition notes. Code: Archive move updates tier state but preserves existing `generationId` in `src/simulator/engine.ts`. Tests: `im-gen-state-transitions`, `ix-gfs-wmy-move-archive`, `od-gen-lifecycle-states`. | Aligned |
| DAS primary immutability gates deletion | Spec: Section 1 deletion gating + Section 3/5 immutability intent (non-SOBR primary lock behavior). Code: `primaryPointImmutabilityExpired(...)` check in `applyRetentionAndGFS()` in `src/simulator/engine.ts`. Tests: lifecycle suite pass with updated snapshots; DAS retention scenarios. | Aligned |
| Standalone Archive Mode is documented but not implemented | Spec: Section 3 Current simulator support. Code: `usesGenerationLifecycle(...)` currently SOBR-only standard flow in `src/simulator/engine.ts`. Tests: none (feature not implemented). | Aligned (Not Implemented by Design) |
| GFS cardinality semantics vs generation `deleteOn` timing | Spec: Section 2 (cardinality-driven protection) + Section 3 (`deleteOn` extension intent). Code: `validateGFSCardinality(...)` runs before `recomputeGenerationDeleteOn(...)`, and active tags keep `deleteOn` rolling in `src/simulator/engine.ts`. Tests: `lb-gfs-expiry-order`, `od-weekly-gfs-cardinality-exact`, `od-monthly-yearly-cardinality-exact`. | Aligned |
| Archive eligibility remains GFS-only in standard mode | Spec: Section 5 Non-GFS capacity residue rule. Code: archive candidate filters in `applySOBROffload()` (`isGFS === true`) in `src/simulator/engine.ts`. Tests: `lb-sobr-capacity-residue-after-archive`, `ix-gfs-wmy-move-archive`, `ix-gfs-wmy-copy-archive`. | Aligned |
| Copy vs Move residency invariants are preserved | Spec: Section 5 invariants (single-tier in Move, multi-tier allowed in Copy). Code: `hasPerformanceData`/`hasCapacityData`/`hasArchiveData` updates in `applySOBROffload()` in `src/simulator/engine.ts`. Tests: `od-tier-residency-per-point`, `od-sobr-copy-full-lifecycle`. | Aligned |
| GEN-point integrity for object tiers | Spec: Section 3 generation atomicity + ownership. Code: Capacity-entry GEN mint via `registerPointInGeneration(...)`; lifecycle views in `getCurrentGenerations(...)` in `src/simulator/engine.ts`. Tests: `od-gen-lifecycle-states`, `im-gen-window-boundary`. | Aligned |
| UI semantics match repo type (no SOBR-tier framing for non-SOBR) | Spec: Section 5 scoped to SOBR tiering. Code: non-SOBR primary storage labeling and tier panel selection in `src/components/OutputPanel.tsx`. Tests: manual UI verification (no automated UI scenario yet). | Aligned |
| Shared sizing model consistency (no comparator-only calibration) | Spec: Section 6 and repo guardrails. Code: shared working-space function `computeVeeamWorkingSpaceTB(...)` used by Input/UI/tests in `src/models/veeam.ts`, `src/components/InputForm.tsx`, `src/components/OutputPanel.tsx`, `src/testing/veeamBaselineComparator.ts`. Tests: `compare:veeam` + lifecycle quality runs. | Aligned |
| Snapshot governance for intentional behavior changes | Spec: Merge gate + checklist process. Code/process: lifecycle runner snapshot mode and `docs/golden-snapshots.json` updates. Tests: `npm run test:lifecycle` then `npm run test:lifecycle -- --update-snapshots` only when canonical behavior intentionally changed. | Aligned (Process Control) |

### Merge rule
- All rows must be `Aligned` before merge.
- If any row is `Drift`, PR must include either:
  - a code/spec/test fix that restores alignment, or
  - an explicit approved exception note with follow-up issue.

