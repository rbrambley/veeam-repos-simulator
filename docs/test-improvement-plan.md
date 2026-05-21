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

---

## Phase 4 - Forecast Drift Reduction Campaign (Current)

Goal: push forecast-vs-simulation p95 abs delta from 1.597 TB toward the long-term target 0.25 TB while preserving parity and lifecycle quality gates.

Reference baseline:
- [docs/forecast-vs-simulation-summary.json](docs/forecast-vs-simulation-summary.json)
- Current p95 abs delta: 1.597 TB
- Current max abs delta: 5.994 TB

### Top-5 remediation classes

1. DAS mixed GFS large-profile residue
- Representative scenario: `das-mixed-2w1m1y-large-r7`
- Signal: 5.994 TB abs delta (year 1)
- Action: align forecast residue carryover with runtime lifecycle survival rules for mixed W/M/Y points.

2. DAS weekly-heavy W+M+Y long horizon
- Representative scenario: `od-das-wmy-weekly-size-nonzero`
- Signal: 2.680-4.127 TB abs deltas across year 1-3
- Action: synchronize weekly cardinality/pruning order assumptions between forecast and runtime.

3. SOBR move-only high-volume class
- Representative scenario: `sobr-moveonly-27tb-forecast0`
- Signal: ~4.05 TB abs delta in years 1 and 2
- Action: recalibrate move-only capacity-tier residency using year-anchor runtime snapshots.

4. SOBR copy+archive W/M/Y interaction
- Representative scenarios: `ix-gfs-wmy-copy-archive`, `ix-gfs-wmy-copy-archive-immutability`
- Signal: up to 3.15 TB abs delta in year 3
- Action: model copy+archive+GFS interaction explicitly in forecast, with immutability-aware checks.

5. Year-anchor accumulation consistency (cross-cutting)
- Scope: classes 1-4
- Signal: persistent high-tail drift despite CI pass
- Action: add anchor-consistency regression checks against lifecycle snapshots for year 1/2/3.

### Execution protocol

1. Implement classes 1-2 and rerun:
- `npm run report:forecast-vs-simulation -- --enforce-thresholds`
- `npm run compare:veeam`

2. If p95 remains > 1.20 TB, implement class 3 and rerun full quality:
- `npm run test:quality`

3. Implement classes 4-5 and rerun full gates:
- `npm run gate:push`

### Wave acceptance criteria

1. Parity remains 75 passed / 0 failed.
2. Lifecycle and mutation remain green.
3. Forecast p95 abs delta <= 1.00 TB (wave target).
4. No increase in CI exclusions.

### Expected confidence lift

If classes 1-5 are addressed without regressions, expected confidence movement is:
1. Forecaster vs Simulator Consistency: 8/10 -> 8.5-9/10
2. Drift Risk (outside validated scope): 7/10 -> 7.5-8/10
3. Production Readiness (within validated scope): 9/10 -> 9/10 (unchanged, but with tighter forecast envelope)
