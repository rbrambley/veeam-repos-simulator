# Test Suite Improvement Plan

Status: Implemented on May 5, 2026  
Current confidence posture: quality pipeline established with mutation testing, golden snapshots, and adversarial lifecycle scenarios.  
Delivery approach: three phases, now completed and integrated into the repo.

---

## Phase 1 — Mutation Testing

**Goal:** Prove the lifecycle suite catches real engine bugs, not just happy-path outputs.

**What it does:** Deliberately breaks one engine method at a time and verifies the oracle detects it.
A mutation that passes all probe scenarios is a **blind spot** — a bug of that class could ship undetected.

**Implemented mutations:**

| ID | Method patched | Bug injected | Expected catching rule |
|----|---------------|--------------|----------------------|
| M-01 | `applyRetentionAndGFS` | Return immediately — chains never deleted | R-DRIFT-01 (`maxInactiveChainsAtAnyTime`) |
| M-02 | `applyGFSRetention` | Return immediately — GFS tags never pruned | R-GFS-03 (`gfsWeeklyCountNeverExceedsLimit`) |
| M-03 | `tagGFSRestorePoint` | Return immediately — GFS never tagged | Drift/oracle checks catch resulting lifecycle accumulation |
| M-04 | `promoteChainBases` | Return immediately — no global base ever set | `singleGlobalBasePerJobEveryDay` |
| M-05 | `tagGFSRestorePoint` | Tag every restore point as weekly GFS (not just Sat/Full) | R-GFS-03 (`gfsWeeklyCountNeverExceedsLimit`) |

**Implemented files:** `src/testing/mutationRunner.ts`, `docs/mutation-report.json`  
**npm command:** `test:mutation`  
**Current outcome:** 5/5 mutations are caught. Caught mutations are treated as positive validation signals, not findings to fix.

---

## Phase 2 — Golden Snapshots

**Goal:** Remove reliance on hand-derived storage and restore-point formulas as the only long-run oracle.

**What it does:** On day 365 and day 730 of each long-run scenario, save a JSON snapshot of
`{chainCount, rpCount, gfsWeeklyCount, gfsMonthlyCount, gfsYearlyCount, storageTB}`. Subsequent runs diff
against the snapshot exactly. Any change — up or down — fails the test.

**Advantage over formula-only checks:** catches regressions that lower counts or storage too early,
such as missing GFS points or chains being pruned aggressively.

**Implemented files:** `src/testing/goldenSnapshots.ts`, `docs/golden-snapshots.json`  
**Update command:** `npm run test:quality:update-snapshots`  
**Current outcome:** long-run checkpoints are shown in the per-scenario report, summarized in the `Golden Snapshot Registry`, and counted in the dashboard `Quality Signals` block when they match.

---

## Phase 3 — Boundary and Adversarial Scenarios

**Goal:** Cover edge cases the original lifecycle suite did not exercise.

**Implemented additions:**

1. `ix-high-change-rate-drift-2yr` — high daily churn (40%)
2. `ix-short-retention-drift-3yr` — retention=3 cleanup stress
3. `ix-policy-change-mid-run` — retention change from 7 → 30 on day 180
4. `ix-gfs-only-policy` — weekly-only GFS retention dominance
5. `ix-two-jobs-one-repo` — two jobs sharing one repository safely

**Harness support added:**

- mid-run policy changes
- extra jobs writing to the same repository
- scenario anchors and linked report navigation

---

## Operational Result

The repo now has a consolidated quality workflow:

- `npm run test:mutation`
- `npm run test:lifecycle`
- `npm run test:quality`
- `npm run test:quality:update-snapshots`

The generated report is now `Veeam Simulator — Quality & Validation Report` and includes:

- findings dashboard
- quality signals summary
- mutation testing status
- golden snapshot registry
- linked scenario sections and rule coverage
