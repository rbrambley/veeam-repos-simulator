# Test Suite Improvement Plan

Current confidence: ~70%  
Target: ≥90%  
Approach: Three phases, delivered in order of impact.

---

## Phase 1 — Mutation Testing (highest priority)

**Goal:** Prove the existing 38 tests actually catch real engine bugs.

**What it does:** Deliberately breaks one engine method at a time and verifies the oracle detects it.
A mutation that *passes* all scenarios is a **blind spot** — a bug of that class could ship undetected.

**Five mutations to inject:**

| ID | Method patched | Bug injected | Expected catching rule |
|----|---------------|--------------|----------------------|
| M-01 | `applyRetentionAndGFS` | Return immediately — chains never deleted | R-DRIFT-01 (`maxInactiveChainsAtAnyTime`) |
| M-02 | `applyGFSRetention` | Return immediately — GFS tags never pruned | R-GFS-03 (`gfsWeeklyCountNeverExceedsLimit`) |
| M-03 | `tagGFSRestorePoint` | Return immediately — GFS never tagged | **Predicted blind spot** (no minimum GFS count assertion exists) |
| M-04 | `promoteChainBases` | Return immediately — no global base ever set | `singleGlobalBasePerJobEveryDay` |
| M-05 | `tagGFSRestorePoint` | Tag every restore point as weekly GFS (not just Sat/Full) | R-GFS-03 (`gfsWeeklyCountNeverExceedsLimit`) |

**Files to create:** `src/testing/mutationRunner.ts`
**npm command:** `test:mutation`
**Expected outcome:** M-03 is a blind spot → add minimum GFS count assertion to oracle to close it.

---

## Phase 2 — Golden Snapshots (eliminates formula risk)

**Goal:** Remove reliance on hand-derived storage/RP formulas as oracles.
Replace with captured engine state that becomes the reference on first passing run.

**What it does:** On day 365 and day 730 of each long-run scenario, save a JSON snapshot of
`{chainCount, rpCount, gfsWeeklyCount, gfsMonthlyCount, storageTB}`. Subsequent runs diff
against the snapshot exactly. Any change — up or down — fails the test.

**Advantage over current formula:** Catches regressions that *lower* counts/storage (e.g. GFS
points disappearing too soon, chains getting pruned too aggressively). The current R-STOR-01
upper-bound check misses this direction entirely.

**Files to create:** `src/testing/goldenSnapshots.ts`, `docs/golden-snapshots.json`
**Process:** Run once with `--update-snapshots` flag to seed the baseline, then lock.
**Risk:** Snapshot seeded from a buggy baseline is wrong forever. Mitigate by seeding
immediately after mutation suite confirms the engine is correct.

---

## Phase 3 — Boundary and Adversarial Scenarios

**Goal:** Cover edge cases that current scenarios miss.

**Scenario gaps to fill (in priority order):**

1. **High change rate** (40% daily) — stresses storage formula boundary; `incrSizeTB` dominates
2. **Short retention** (3 days) — chain pruning runs almost every day; tests frequency edge
3. **Mid-run retention change** (7 → 30 on day 180) — currently zero coverage of policy changes
4. **GFS-only policy** (weekly=52, no daily retention) — unusual but valid Veeam configuration
5. **Two jobs, one repo** — tests inter-job storage accounting and GFS cardinality per-job

**Notes:**
- Scenarios 1–2 are pure additions to `docs/lifecycle-test-scenarios.json` (Layer 1/2).
- Scenario 3 requires harness support for mid-run config patching (small runner change).
- Scenarios 4–5 are new Layer 3 entries.

---

## What each phase adds to confidence

| Phase | Confidence gain | Why |
|-------|----------------|-----|
| Mutation testing | +10% | Proves tests catch real bugs; surfaces M-03 blind spot |
| Close M-03 gap (add min GFS assertion) | +5% | Removes known blind spot found in Phase 1 |
| Golden snapshots | +8% | Eliminates formula error risk; catches regression in both directions |
| Boundary scenarios | +7% | Covers edge cases not exercised by current scenario cluster |
| **Total** | **+30% → ~90%** | |
