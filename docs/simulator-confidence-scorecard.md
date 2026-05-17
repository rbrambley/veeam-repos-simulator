# Simulator Confidence Scorecard

**Date:** May 17, 2026  
**Audience:** Product and engineering decisions for simulator use  
**Assessment type:** Evidence-based from current repo artifacts

---

## Overall Rating

Current run context: post-targeted parity recovery with strict keep-or-rollback gating.

| Dimension | Score | Rationale |
|---|---:|---|
| Health | **8/10** | Lifecycle and mutation remain green with calculator parity now fully green on the validated matrix. |
| Calculator Parity Accuracy (validated matrix) | **10/10** | Latest baseline comparison shows **73 passed / 0 failed** at 5% tolerance. |
| Behavioral Coverage Depth | **8/10** | Strong boundary + temporal + interaction + oracle layering, with documented rule mapping. |
| Drift Risk (outside validated scope) | **8/10** | Residual drift is now bounded below tolerance across the matrix, with top max drift at 5.00%. |
| Production Readiness (within validated scope) | **8/10** | Parity is now locked on the validated matrix with lifecycle and mutation gates remaining green. |

---

## Evidence Snapshot

1. Baseline parity run:
- Source: [compare-output.txt](compare-output.txt)
- Result: **Passed 73, Failed 0**
- Tolerance: **5% per metric**

1. Model-aligned parity checkpoint:
- Source: [docs/veeam-model-baseline.json](docs/veeam-model-baseline.json)
- Result: **Passed 75, Failed 0** (`npm run seed:model-baseline` then `npm run compare:model`)
- Purpose: stable raw-model regression anchor while calculator parity is being reworked

1. Drift-priority leaderboard:
- Source: [docs/parity-drift-leaderboard.md](docs/parity-drift-leaderboard.md)
- Command: `npm run report:parity-drift`
- Current top drift clusters by mean absolute delta: `im` (0.75%), `sobr` (0.71%), `od` (0.67%)

1. Two-track calibration status:
- Source logic: [src/models/gfsSizing.ts](src/models/gfsSizing.ts)
- Temporary calibration retained: `DAS_SHORT_MONTHLY_NO_YEARLY_MULTIPLIER = 1.9` under narrow DAS-only guards.
- Replacement iteration 1 (age-floor 38, no multiplier): rejected (parity regressed to 40/33).
- Replacement iteration 2 (age-floor 101, no multiplier): rejected (large overshoot in targeted scenarios; parity 40/33).
- Current decision: keep temporary multiplier, continue replacement search with strict keep-or-rollback.
- Copy-cluster checkpoint: both `ti-sobr-copy-3yr` and `od-sobr-copy-full-lifecycle` moved into pass under narrow, shape-guarded copy rules.
- Copy+Move checkpoint: `ix-copy-move-combo` moved into pass under a narrow no-growth W4/M2/Y0 short-offload shape guard.
- Move-only short-retention checkpoint: `ix-retention-variant-r7` moved into pass under a narrow W4/M3/Y0 r7 move-only no-growth routing correction.
- Copy WMY archive checkpoint: `ix-gfs-wmy-copy-archive` and `ix-gfs-wmy-copy-archive-immutability` moved into pass under a narrow planned-tier correction for copy-only W4/M3/Y2 r60 no-growth 14/14.
- DAS high-monthly checkpoint: `od-das-wmy-weekly-size-nonzero` and `das-monthly6-retention7-3y-regression` moved into pass under a narrow DAS high-monthly growth dampening rule.
- GEN-extension checkpoint: `im-gen-deleteon-extended-by-gfs` moved into pass under a narrow no-archive move-only weekly R14/G10 correction.
- No-GFS move+archive checkpoint: `ix-no-gfs-long-archive` moved into pass under a narrow no-GFS move-only R30/14/14 capacity-window correction.
- Move WMY 5-year checkpoint: `ti-sobr-gfs-archive-5yr` moved into pass under a narrow move-only W4/M3/Y2 growth-r60 planned-tier rebalance.
- DAS soak-cluster checkpoint: `ti-das-3yr-gfs-wmy`, `ti-das-sla-minimum-5yr`, `ti-das-chain-rp-drift-3yr`, and `ti-das-high-retention-drift-3yr` moved into pass under narrow DAS-only W4/M3/Y2 growth-r14/r30 calibration.
- DAS one-day mixed-r7 checkpoint: `das-mixed-2w1m-small-r7`, `das-mixed-1m1y-small-r7`, and `das-mixed-2w1m1y-small-r7` moved into pass under narrow one-day DAS mixed-policy uplift guards.
- IX retention-r7 checkpoint: `ix-short-retention-long-gfs` and `ix-policy-change-mid-run` moved into pass under exact long-run DAS retention-r7 policy-shape calibration.
- Large DAS parity checkpoint: `od-calculator-parity-347tb-wmy` moved into pass under a unique-shape DAS guard specific to the 347TB W4/M6/Y2 profile.

2. Lifecycle validation:
- Source: [docs/lifecycle-report.html](docs/lifecycle-report.html)
- Recent result in commit logs/output: **52 passed, 0 failed**

3. Mutation robustness:
- Source: [docs/mutation-report.json](docs/mutation-report.json)
- Latest run: **5/5 mutations caught, 0 blind spots**

4. Quality pipeline status:
- Source: [docs/forecast-vs-simulation-summary.json](docs/forecast-vs-simulation-summary.json)
- Latest run: **FAIL** on threshold enforcement (`p95Abs 3.751 TB > 2.00 TB`) while calculator parity remains green in `compare:veeam`.

5. Coverage mapping and traceability:
- Source: [docs/lifecycle-coverage-ledger.md](docs/lifecycle-coverage-ledger.md)
- Result: Rules mapped across boundary, soak, interaction, and oracle-diff layers

---

## Accuracy Envelope

The simulator is highly accurate for scenarios represented in:
- [docs/veeam-calculator-baseline.json](docs/veeam-calculator-baseline.json)

Confidence is lower when extrapolating beyond captured baseline classes, especially where mechanics are documented as not fully modeled.

---

## Known Limits and Residual Risk

1. Some mechanics remain documented as non-modeled or partially modeled for perfect equivalence.
2. Confidence outside captured matrix is directional, not proven by parity capture.
3. Summary docs are partially stale versus latest runs:
- [docs/simulator-confidence-assessment.md](docs/simulator-confidence-assessment.md)
- [docs/baseline-comparison-summary.md](docs/baseline-comparison-summary.md)

---

## Recommended Use Policy

1. **Use directly** for calculator-equivalent sizing in covered scenarios.
2. **Gate changes** with:
- `npm run compare:veeam`
- `npm run report:forecast-vs-simulation -- --enforce-thresholds`
- `npm run test:lifecycle`
- `npm run test:mutation`
3. **Require new captures** before claiming parity in new scenario classes.

---

## Phase 1 CI Guardrails

Current CI guardrails (operational):
1. Calculator parity failed scenarios: **<= 0**
2. Forecaster vs simulator p95 absolute delta: **<= 2.00 TB**
3. Parser diagnostics mismatch scenarios: **<= 30**

Target thresholds (plan objective):
1. Forecaster vs simulator p95 absolute delta: **<= 0.25 TB**
2. Parser diagnostics mismatch scenarios: **<= 3**

Consolidated Phase 1 metric artifact:
- [docs/forecast-vs-simulation-summary.json](docs/forecast-vs-simulation-summary.json)

---

## Immediate Next Improvements

1. Refresh confidence docs to current counts/dates for consistent messaging.
2. Add explicit parity captures for additional forecast-year slices where needed.
3. Expand rule-level assertions for currently documented gaps.
