# Test Scenarios & Verification Framework

This document defines scenario expectations and verification rules for the current simulator behavior model.

## Canonical Source of Truth

When narrative examples conflict with runtime behavior, treat these as canonical:

1. Global behavior contract in this file
2. Automated assertions in `src/testing/scenarioRunner.ts`
3. Scenario inputs/outputs in `docs/test-scenarios.json`

---

## Global Behavior Contract (Current)

These rules are global and must remain stable across DAS/SOBR and policy combinations.

1. Exactly one base full per job at any time
2. Base identity is the oldest Full/SyntheticFull across all chains for the job
3. Retention SLA is a minimum guarantee (count expiry never overrides SLA)
4. Base SyntheticFull is full-sized; non-base SyntheticFull is incremental-sized
5. Working space is included only in planned capacity values, and is calculated as a percentage of the largest full backup size for that year
6. In SOBR Copy mode, all restore points receive a Capacity copy at creation time (synchronous at day resolution)
7. In SOBR Move mode, only sealed (Inactive) chains are eligible for offload; entire chain offloads as a unit
8. In SOBR Copy mode, archive requires `pointAgeDays >= offloadAfterDays + archiveAfterDays` (total age from backup date)
9. In SOBR Move mode, archive requires `capTierAgeDays >= archiveAfterDays` (time since Capacity arrival)
10. In SOBR Copy mode, when a chain's GFS full is archived, non-GFS chain points are pruned from Capacity (still accessible via Performance)

---

## Scenario Matrix (Automated)

### Scenario 1: das-basic

**Intent:** Validate baseline DAS behavior with retention and chain rollover.

**Key expectations:**
- Final restore point count = 10
- Base invariants hold (single base, oldest full/synthetic full)
- Non-base SyntheticFull sizing invariant holds

### Scenario 2: sobr-moveonly

**Intent:** Validate SOBR Move mode offload path without GFS.

**Key expectations:**
- Final restore point count = 17
- Base invariants hold while points move tiers
- Non-base SyntheticFull sizing invariant holds

### Scenario 3: sobr-copymove

**Intent:** Validate SOBR Copy+Move behavior with Archive enabled.

**Key expectations:**
- Final restore point count = 25
- Base invariants hold with copy and move transitions
- Non-base SyntheticFull sizing invariant holds

### Scenario 4: das-gfs

**Intent:** Validate DAS retention behavior with Weekly GFS preservation.

**Key expectations:**
- Final restore point count = 9
- Base invariants hold with GFS-preserved points
- Non-base SyntheticFull sizing invariant holds

### Scenario 5: sobr-gfs-archive

**Intent:** Validate full SOBR flow with Move, GFS, and Archive.

**Key expectations:**
- Final restore point count = 64
- Base invariants hold under long-run retention/offload/archive transitions
- Non-base SyntheticFull sizing invariant holds

### Scenario 6: sobr-copyonly-archive-gating *(added May 3, 2026)*

**Intent:** Validate that copy-only mode does not archive GFS points before `offloadAfterDays + archiveAfterDays` total age has elapsed.

**Key expectations:**
- At least 1 archive point exists after the simulation period
- All archive points are at least `offloadAfterDays + archiveAfterDays` days old (21 days in this scenario)
- No non-GFS chain points remain in Capacity after their chain's GFS full is archived (`capacityResidueInArchivedChains = 0`)

---

## What The Runner Verifies

Automated checks currently include:

1. Per-day base uniqueness (fails immediately if any job has more than one base on a day)
2. Final restore point count per scenario
3. Final base count equals exactly one
4. Final base identity equals oldest Full/SyntheticFull across all chains
5. Non-base SyntheticFull incremental-size behavior
6. `expectedArchivePointCountAtLeast` — minimum archive point count at end of simulation *(scenario 6)*
7. `minArchivePointAgeDays` — all archive points must be at least this many days old *(scenario 6)*
8. `capacityResidueInArchivedChains` — expected count of non-GFS Capacity points in chains that have archived GFS fulls *(scenario 6)*

---

## Post-Change Verification Workflow

1. Run `npm test`
2. If a scenario fails, determine whether behavior change is intentional
3. If intentional, update `docs/test-scenarios.json` and this matrix
4. If not intentional, fix engine logic and rerun until all scenarios pass

---

## Known Affected Logic

These components are high-risk and should trigger a test run after changes:

1. Retention/GFS deletion (`applyRetentionAndGFS`)
2. Base promotion (`promoteChainBases`, `normalizeRepoTierBases`)
3. SOBR tier moves (`applySOBROffload`)
4. Capacity sizing (`InputForm`, `computeYearlyRequirements`)
5. Activity logging (`getDailyExplanation`)
6. Policy insight recommendations (`policyInsight`)

---

## Common Issues To Watch

- Base identity drift after retention or chain transitions
- Accidental per-chain base logic replacing per-job base logic
- SLA boundary regressions (off-by-one day deletions)
- SyntheticFull sizing regressions (non-base points becoming full-sized)
- Archive/offload ordering issues causing tier residency mismatches

---

## Known Issues / Remaining Gaps (as of May 3, 2026)

| # | Issue | Impact | Status |
|---|-------|--------|--------|
| 1 | **Block generation window not modeled** — Real Veeam stages synthetic full creation over ~10 days in SOBR Capacity tier before old chain is fully removed. Simulator offloads immediately. | `sobr-gfs-archive` Cap Tier is -16.81% vs Veeam Calculator baseline (1/6 comparator failure). | Deferred — accepted structural gap. |
| 2 | **Immutability windows not modeled** — No per-tier immutability window enforced. Points are deleted/offloaded based on age and count only. | Hardened SOBR scenarios (S3 Object Lock, hardened repo) will diverge from real Veeam. | Not yet planned. |
| 3 | **Copy mode stamped synchronously** — Capacity copy is written at backup creation, not after a background copy window. | Negligible at day-resolution granularity. | Accepted simplification. |
| 4 | **Activity log grouped copy events** — Copy events are aggregated per chain, not per restore point. | Minor cosmetic inconsistency; no calculation impact. | Low priority. |

### Comparator Baseline Summary (as of May 3, 2026)

| Scenario | Status | Notes |
|----------|--------|-------|
| das-retention-14 | PASS | |
| sobr-moveonly | PASS | |
| sobr-copy-noarchive | PASS | |
| sobr-gfs-basic | PASS | |
| sobr-gfs-archive | **FAIL** | Cap Tier -16.81% — block generation window gap |
| das-gfs-sla | PASS | |
