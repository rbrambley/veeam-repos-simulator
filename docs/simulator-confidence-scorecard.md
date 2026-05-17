# Simulator Confidence Scorecard

**Date:** May 17, 2026  
**Audience:** Product and engineering decisions for simulator use  
**Assessment type:** Evidence-based from current repo artifacts

---

## Overall Rating

| Dimension | Score | Rationale |
|---|---:|---|
| Health | **9/10** | Quality pipeline is active and passing across comparator, lifecycle, and mutation checks. |
| Calculator Parity Accuracy (validated matrix) | **9/10** | Latest baseline comparison shows **70 passed / 0 failed** at 5% tolerance. |
| Behavioral Coverage Depth | **8/10** | Strong boundary + temporal + interaction + oracle layering, with documented rule mapping. |
| Drift Risk (outside validated scope) | **6/10** | Risk increases for uncaptured scenarios and known non-modeled mechanics. |
| Production Readiness (within validated scope) | **8.5/10** | Suitable for calculator-aligned sizing and regression gating in covered scenario space. |

---

## Evidence Snapshot

1. Baseline parity run:
- Source: [compare-output.txt](compare-output.txt)
- Result: **Passed 70, Failed 0**
- Tolerance: **5% per metric**

2. Lifecycle validation:
- Source: [docs/lifecycle-report.html](docs/lifecycle-report.html)
- Recent result in commit logs/output: **50 passed, 0 failed**

3. Mutation robustness:
- Source: [docs/mutation-report.json](docs/mutation-report.json)
- Result: **5 caught, 0 blind spots**

4. Coverage mapping and traceability:
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
- `npm run test:lifecycle`
- `npm run test:mutation`
3. **Require new captures** before claiming parity in new scenario classes.

---

## Immediate Next Improvements

1. Refresh confidence docs to current counts/dates for consistent messaging.
2. Add explicit parity captures for additional forecast-year slices where needed.
3. Expand rule-level assertions for currently documented gaps.
