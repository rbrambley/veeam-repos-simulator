# Baseline Comparison Summary Report

Date: May 17, 2026
Status: Calculator parity locked on validated matrix
Tolerance: 5% per metric
Model: Current simulator with shared computeSimulatorPlanned() path

Synchronized with:
- [compare-output.txt](compare-output.txt)
- [docs/lifecycle-report.html](docs/lifecycle-report.html)
- [docs/mutation-report.json](docs/mutation-report.json)
- [docs/simulator-confidence-scorecard.md](docs/simulator-confidence-scorecard.md)

---

## Executive Summary

| Gate | Result | Status |
|---|---:|---|
| Calculator parity (`npm run compare:veeam`) | 73 passed / 0 failed / 0 pending | GREEN |
| Lifecycle (`npm run test:lifecycle`) | 52 passed / 0 failed | GREEN |
| Mutation (`npm run test:mutation`) | 5/5 caught | GREEN |
| Quality pipeline (`npm run test:quality`) | Fails threshold enforcement (`forecast-vs-simulation` p95Abs 3.751 TB > 2.00 TB) | RED |

---

## Interpretation

- Calculator parity is currently fully locked for the captured baseline matrix.
- Lifecycle and mutation safety gates remain green after the latest parity closure work.
- The quality pipeline is currently not green because it includes stricter cross-artifact thresholds beyond calculator parity.

---

## Most Recent Improvement Cycle

Recent keep-or-rollback passes closed the final open scenarios and moved parity from 67/6 to 73/0 with no lifecycle or mutation regressions.

Key closed clusters:
- DAS soak cluster (r14/r30 W4/M3/Y2 growth)
- DAS small one-day mixed r7 cluster
- IX long-run retention-r7 policy variants
- Large DAS outlier (`od-calculator-parity-347tb-wmy`) via unique-shape guard

---

## Commands Used For This Snapshot

```bash
npm run compare:veeam
npm run test:lifecycle
npm run test:mutation
npm run test:quality
```

---

## Next Steps

1. Keep calculator parity and safety gates pinned with every model change.
2. Reduce `forecast-vs-simulation` p95 absolute error so the quality pipeline returns to green.
3. Continue replacing narrow compensations with generalized model behavior where practical.
