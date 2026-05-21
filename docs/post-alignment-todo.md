# Post-Alignment TODO

Last updated: 2026-05-21

This list tracks follow-up work after achieving calculator baseline parity and cross-volume guard generalization.

## Completed Since Last Plan

1. Calculator parity advanced to 75/0 on current matrix.
2. Lifecycle and mutation suites remain green in operational runs.
3. Forecast-vs-simulation CI gate is green at p95Abs 1.5975 TB.
4. Remaining size-anchored guards in planned capacity calculator were generalized for cross-volume scaling (commit 22c5a44).

## 1) Expand Direct Capture Coverage for Outlier Forecast Drift Clusters

Goal:
- Reduce top outliers between forecaster and simulator while preserving calculator parity.

Tasks:
- Add or refresh captures for top outlier scenarios listed in docs/forecast-vs-simulation-summary.json topOutliers.
- Prioritize high-impact classes:
  - DAS mixed large W/M/Y
  - SOBR move-only 27 TB forecast0 path
  - Copy+archive W/M/Y interaction paths
- Confirm whether delta source is expected structural difference, forecaster approximation, or simulator behavior gap.

Validation:
- Run npm run compare:veeam.
- Run npm run report:forecast-vs-simulation -- --enforce-thresholds.
- Track movement in p95Abs and top outlier values after each accepted change.

## 2) Resolve compare:model Positioning

Goal:
- Eliminate ambiguity between calculator parity and internal model drift checks.

Tasks (choose one policy):
- Option A: Rebuild docs/veeam-model-baseline.json to current comparator behavior so compare:model can be a strict pass gate again.
- Option B: Keep compare:model informational and document this clearly in README and CI workflows.

Validation:
- If Option A: run npm run compare:model and target zero failures.
- If Option B: verify CI does not block on compare:model failures.

## 3) Pre-push Hook Stability and Reporting Determinism

Goal:
- Ensure hooks are deterministic and do not block pushes due to non-functional artifact churn.

Tasks:
- Keep timestamp-stability logic in generated reports as a maintained contract.
- Investigate and harden the intermittent pre-push stall around the final forecast report step.
- Add a concise push troubleshooting note to developer docs.

Validation:
- Perform two back-to-back gate runs and verify no timestamp-only file churn.
- Validate successful push with hooks enabled in a clean state.

## 4) Confidence Doc Maintenance Cadence

Goal:
- Keep confidence messaging aligned with actual test outcomes.

Tasks:
- Add a lightweight maintenance trigger: whenever baseline or comparator logic changes, update docs/simulator-confidence-assessment.md in the same PR.
- Include date, compare:veeam totals, and quality totals in each update.

Validation:
- Spot-check after next comparator or forecast model change.

## 5) Precision Target Track (Long Horizon)

Goal:
- Move forecast-vs-simulation from CI-green to precision-target-green.

Tasks:
- Drive p95Abs from 1.5975 TB toward <= 0.25 TB.
- Reduce maxAbs drift through targeted scenario-class corrections, not broad overfitting.
- Keep calculator parity fixed at zero failures while reducing forecast drift.

Validation:
- Quality summary shows p95Abs <= 0.25 TB with calculator parity still 0 failed.
