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
