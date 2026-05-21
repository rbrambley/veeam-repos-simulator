# Simulator Confidence Scorecard

Date: May 21, 2026
Audience: Product and engineering decisions for simulator use
Assessment type: Evidence-based from current repo artifacts

---

## Overall Rating

Current run context: post-parity recovery and post cross-volume guard generalization.

| Dimension | Score | Rationale |
|---|---:|---|
| Health | 9/10 | Parity, lifecycle, mutation, and forecast CI threshold status are green in latest artifacts. |
| Calculator Parity Accuracy (validated matrix) | 10/10 | Baseline comparator currently reports 75 passed, 0 failed at 5% tolerance. |
| Forecaster vs Simulator Consistency | 8/10 | CI p95 absolute delta is 1.597 TB (green against <= 2.00 TB), still above long-term target 0.25 TB. |
| Behavioral Coverage Depth | 9/10 | Lifecycle oracle and mutation suites are both fully green on current scenario set. |
| Drift Risk (outside validated scope) | 7/10 | Controlled within covered matrix, but extrapolation risk remains for uncaptured scenario classes. |
| Production Readiness (within validated scope) | 9/10 | Strong readiness for covered scenarios with required gates passing. |

---

## Evidence Snapshot

1. Calculator parity
- Source: [docs/forecast-vs-simulation-summary.json](docs/forecast-vs-simulation-summary.json)
- Current result: 75 passed, 0 failed, available=true
- Interpretation: simulator-to-calculator parity is strong on the validated matrix.

2. Forecaster vs simulator quality envelope
- Source: [docs/forecast-vs-simulation-summary.json](docs/forecast-vs-simulation-summary.json)
- Current result: p95AbsDeltaTB = 1.5975 TB, maxAbsDeltaTB = 5.994 TB
- CI threshold status: PASS (<= 2.00 TB)
- Target status: not yet at long-term target (<= 0.25 TB).

3. Lifecycle validity
- Source: [docs/lifecycle-report.html](docs/lifecycle-report.html)
- Current operational status: 57 passed, 0 failed in recent gate runs.

4. Mutation robustness
- Source: [docs/mutation-report.json](docs/mutation-report.json)
- Current result: 5 mutations, 5 caught, 0 blind spots, status PASS.

5. Recent scaling hardening
- Source: [src/models/plannedCapacityCalculator.ts](src/models/plannedCapacityCalculator.ts)
- Latest update: remaining size-anchored shape guards were generalized to scale by policy/lifecycle conditions rather than fixed source volume anchors.
- Commit reference: 22c5a44 on main.

6. Forecast year normalization safeguard (new)
- Sources:
	- [src/models/forecast.ts](src/models/forecast.ts)
	- [src/testing/forecastYearNormalizationRunner.ts](src/testing/forecastYearNormalizationRunner.ts)
	- [docs/forecast-year-normalization-report.json](docs/forecast-year-normalization-report.json)
- Behavior correction: forecast input value `0` is now normalized to year `1` for applied planning/output calculations, removing user-facing Year 0 semantics.
- Regression coverage: automated normalization checks are now part of quick and push quality paths.
- Commit reference: 6bfe7d5 on main.

---

## Confidence Envelope

Within covered scenarios in [docs/veeam-calculator-baseline.json](docs/veeam-calculator-baseline.json):
- Calculator parity confidence: very high.
- Forecaster vs simulator confidence: high for CI-level decisioning, moderate for precision-critical planning where sub-TB drift matters.

Outside covered scenarios:
- Confidence is directional and should be treated as bounded, not guaranteed parity.

---

## Recommended Use Policy

1. Use directly for calculator-equivalent sizing in covered matrix scenarios.
2. Keep these gates mandatory for model changes:
- npm run compare:veeam
- npm run report:forecast-vs-simulation -- --enforce-thresholds
- npm run test:lifecycle
- npm run test:mutation
3. Require new calculator captures before claiming parity in new scenario classes.

---

## Current Guardrails

Operational guardrails:
1. Calculator failed scenarios <= 0
2. Forecaster vs simulator p95 absolute delta <= 2.00 TB
3. Parser mismatch scenarios <= 3

Long-term targets:
1. Forecaster vs simulator p95 absolute delta <= 0.25 TB
2. Parser mismatch scenarios <= 3

---

## Next Improvements

1. Keep replacing narrow shape-specific logic with generalized, formula-driven behavior when parity is retained.
2. Add targeted captures for remaining top outlier classes in forecast-vs-simulation summary.
3. Continue reducing p95 absolute drift toward 0.25 TB target.

---

## Top-5 Drift Reduction Plan (May 21, 2026)

Goal: reduce forecast-vs-simulation p95 abs delta from 1.597 TB toward 0.25 TB without regressing calculator parity (75/0) or lifecycle quality (57/0).

Prioritization source: [docs/forecast-vs-simulation-summary.json](docs/forecast-vs-simulation-summary.json) top outlier set and CI aggregate metrics.

| Priority | Drift Class | Representative Scenarios | Current Signal | Primary Hypothesis | Planned Fix Pattern | Expected Confidence Lift |
|---|---|---|---|---|---|---|
| P1 | DAS mixed GFS large-profile residue | `das-mixed-2w1m1y-large-r7` | max abs delta 5.994 TB (Year 1) | Forecast underestimates GFS residue carryover for large source volumes under mixed W/M/Y cadence. | Reconcile mixed-GFS retention residue accounting to use lifecycle-consistent per-point survival at year anchors. | p95 likely improves by ~0.20-0.35 TB; max outlier band reduced materially. |
| P2 | DAS weekly-heavy W+M+Y long horizon | `od-das-wmy-weekly-size-nonzero` | abs deltas 2.680-4.127 TB (Y1-Y3) | Weekly GFS contribution and long-horizon accumulation shape differ between forecast and runtime pruning order. | Align weekly-cardinality and pruning-order assumptions with oracle lifecycle ordering used in runtime. | p95 likely improves by ~0.10-0.20 TB and narrows year-over-year spread. |
| P3 | SOBR move-only high-volume forecast0 class | `sobr-moveonly-27tb-forecast0` | abs delta ~4.05 TB (Y1/Y2) | Capacity-tier residency and move threshold interactions are still forecast-biased at high volume despite class generalization. | Apply class-level recalibration for move-only capacity residency using year-anchor state snapshots from runtime. | p95 likely improves by ~0.10-0.20 TB; reduces persistent multi-year bias. |
| P4 | SOBR copy+archive W/M/Y interaction | `ix-gfs-wmy-copy-archive`, `ix-gfs-wmy-copy-archive-immutability` | abs deltas up to 3.15 TB (Y3) | Forecast misses compounded effect of copy + archive gating + GFS retention at later years. | Add explicit interaction term in forecast logic for copy-archive residue under W/M/Y (including immutability-on/off parity checks). | p95 likely improves by ~0.08-0.15 TB; lowers high-tail variance in Y2/Y3. |
| P5 | Year-anchor accumulation consistency in long-horizon classes | Cross-cutting over P1-P4 | p95 1.597 TB remains far above target 0.25 TB | Even with class fixes, anchor-date accumulation drift can remain if yearly aggregation shortcuts diverge from day-level lifecycle state. | Introduce anchor-consistency regression checks against lifecycle snapshots for year 1/2/3 on top drift classes. | p95 likely improves by ~0.05-0.10 TB and prevents recurrence. |

Delivery sequence:
1. Implement P1 and P2 first and rerun `npm run report:forecast-vs-simulation -- --enforce-thresholds`.
2. If p95 remains > 1.20 TB, implement P3.
3. Implement P4 and P5 together and rerun full gate stack.

Success criteria for this wave:
1. Calculator parity stays at 75 passed / 0 failed.
2. Lifecycle and mutation gates remain green.
3. Forecast p95 abs delta reaches <= 1.00 TB (wave target) with no new CI exclusions.
4. Post-wave target remains <= 0.25 TB via additional follow-on refinement.
