# Simulator vs Veeam Calculator - Confidence Assessment

Audience: Veeam SEs evaluating simulator usage for calculator-aligned sizing
Last updated: 2026-05-20
Baseline source: [docs/veeam-calculator-baseline.json](docs/veeam-calculator-baseline.json)

## Current Validation Snapshot

- `npm run compare:veeam`: 74 passed, 0 failed, 0 pending
- `npm run test:lifecycle`: 53 passed, 0 failed
- `npm run test:mutation`: 5/5 mutations caught
- `npm run test:quality`: FAIL (threshold enforcement in forecast-vs-simulation stage)

Related quick scorecard:
- [docs/simulator-confidence-scorecard.md](docs/simulator-confidence-scorecard.md)

---

## TL;DR

Confidence is high for calculator-equivalent sizing within the captured scenario matrix because parity is 74/0 and safety gates are green. Do not treat `test:quality` as equivalent to calculator parity; it currently includes stricter forecast-threshold checks that remain red.

---

## Confidence by Gate

| Gate | Confidence Signal | Current State |
|---|---|---|
| Calculator parity (`compare:veeam`) | Direct calculator alignment | HIGH (74/0) |
| Lifecycle (`test:lifecycle`) | State machine and lifecycle invariants | HIGH (53/0) |
| Mutation (`test:mutation`) | Defect detection robustness | HIGH (5/5 caught) |
| Quality pipeline (`test:quality`) | Multi-metric CI envelope including forecast thresholds | PARTIAL (currently failing threshold) |

---

## Practical Guidance

- Use the simulator directly for scenario classes represented in [docs/veeam-calculator-baseline.json](docs/veeam-calculator-baseline.json).
- Use `npm run compare:veeam` as the primary calculator-parity regression gate.
- Use lifecycle and mutation suites as required safety gates for model changes.
- Track `test:quality` separately as a broader CI objective, not as a direct parity indicator.

---

## Known Follow-ups

1. Bring `forecast-vs-simulation` threshold metrics back into green (`p95Abs <= 2.00 TB`).
2. Continue replacing narrow shape guards with more general behavior where possible.
3. Keep all confidence docs synchronized after each accepted parity checkpoint.
