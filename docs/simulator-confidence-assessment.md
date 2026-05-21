# Simulator vs Veeam Calculator - Confidence Assessment

Audience: Veeam SEs evaluating simulator usage for calculator-aligned sizing
Last updated: 2026-05-21
Baseline source: [docs/veeam-calculator-baseline.json](docs/veeam-calculator-baseline.json)

## Current Validation Snapshot

- `npm run compare:veeam`: 75 passed, 0 failed, 0 pending
- `npm run test:lifecycle`: 53 passed, 0 failed
- `npm run test:mutation`: 5/5 mutations caught
- `npm run validate:forecast-ci-exclusions`: PASS (manifest governance checks)
- `npm run test:quality`: PASS
- `docs/forecast-vs-simulation-summary.json`: CI PASS, p95AbsDeltaTB = 1.5975 TB

Related quick scorecard:
- [docs/simulator-confidence-scorecard.md](docs/simulator-confidence-scorecard.md)

---

## TL;DR

Confidence is high for calculator-equivalent sizing within the captured scenario matrix because parity is 75/0 and safety gates are green. Confidence is also high for forecaster-vs-simulator CI decisioning (p95Abs 1.5975 TB <= 2.00 TB), but still below precision target levels (0.25 TB).

---

## Confidence by Gate

| Gate | Confidence Signal | Current State |
|---|---|---|
| Calculator parity (`compare:veeam`) | Direct calculator alignment | HIGH (75/0) |
| Lifecycle (`test:lifecycle`) | State machine and lifecycle invariants | HIGH (53/0) |
| Mutation (`test:mutation`) | Defect detection robustness | HIGH (5/5 caught) |
| Exclusion governance (`validate:forecast-ci-exclusions`) | Drift-exclusion transparency and review discipline | HIGH (validator passing) |
| Quality pipeline (`test:quality`) | Multi-metric CI envelope including forecast thresholds | HIGH (currently passing threshold) |
| Forecaster vs simulator drift (`forecast-vs-simulation-summary`) | Forecast agreement envelope | HIGH for CI threshold (1.5975 <= 2.00), MODERATE for target precision (1.5975 > 0.25) |

---

## Practical Guidance

- Use the simulator directly for scenario classes represented in [docs/veeam-calculator-baseline.json](docs/veeam-calculator-baseline.json).
- Use `npm run compare:veeam` as the primary calculator-parity regression gate.
- Use lifecycle and mutation suites as required safety gates for model changes.
- Keep forecast CI exclusions explicit and reviewable in [docs/forecast-ci-exclusions.json](docs/forecast-ci-exclusions.json).
- Track `test:quality` and forecast summary thresholds separately from direct calculator parity.
- Interpret confidence in two layers:
	- Calculator layer: very high within covered matrix.
	- Forecaster layer: high for CI-go/no-go, still improving for precision-grade planning.

---

## Known Follow-ups

1. Continue driving `forecast-vs-simulation` drift toward target guardrail levels (`p95Abs <= 0.25 TB`).
2. Continue replacing narrow shape guards with more general behavior where possible (latest cross-volume generalization landed in main).
3. Keep all confidence docs synchronized after each accepted parity checkpoint.
