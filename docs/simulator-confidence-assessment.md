# Simulator vs. Veeam Calculator — Confidence Assessment

**Audience:** Veeam SEs evaluating whether to use the simulator in place of the Veeam Calculator.
**Last updated:** 2026-05-06
**Baseline version:** `compare:veeam` against live calculator captures.

**Current validation snapshot (2026-05-06):**
- `npm run compare:veeam` -> **70 passed, 0 failed**
- `npm run test:lifecycle` -> **48 passed, 0 failed**
- `npm run test:mutation` -> **5 caught, 0 blind spots**
- `npm run test:quality` -> **pass**

**Baseline note:**
- [docs/veeam-calculator-baseline.json](docs/veeam-calculator-baseline.json) stores live-captured Veeam Calculator expectations and is the source-of-truth comparator.
- [docs/veeam-model-baseline.json](docs/veeam-model-baseline.json) is currently a secondary, internal directional baseline.

---

## TL;DR

The simulator is currently in a **high-confidence state** for the captured calculator matrix. All baseline scenarios are within tolerance (70/0). Use it as calculator-aligned for the validated scenario space.

---

## High Confidence — Calculator-Aligned

| Area | Current status | Notes |
|---|---|---|
| DAS core sizing | High | Within tolerance in calculator baseline run |
| SOBR no-GFS tiering | High | Within tolerance across matrix cases |
| DAS and SOBR mixed GFS combinations in baseline | High | All captured baseline scenarios pass tolerance |
| Lifecycle behavior correctness | High | 48/48 lifecycle contract scenarios pass |
| Fault-detection depth | High | Mutation suite catches 5/5 seeded defects |

---

## Boundaries and Interpretation

- Confidence is strongest for scenarios represented in [docs/veeam-calculator-baseline.json](docs/veeam-calculator-baseline.json).
- The current calculator baseline defaults to `forecastYears = 3`. Year 1 and Year 2 confidence is high directionally, but not yet backed by dedicated per-year capture entries.
- `compare:model` can still show drift versus its internal baseline and should not be treated as the calculator truth gate.

---

## Practical Guidance by Use Case

| Use case | Recommendation |
|---|---|
| Calculator-equivalent sizing for captured scenario classes | Use directly |
| Regression gate for calculator parity | Use `npm run compare:veeam` |
| Behavioral safety gate for engine changes | Use `npm run test:quality` |
| Internal model drift tracking | Use `npm run compare:model` as informational |

---

## Known Remaining Follow-ups

| Item | Why it matters | Current status |
|---|---|---|
| Add Year 1 and Year 2 calculator captures | Converts inferred per-year confidence into measured confidence | Pending |
| Reconcile or refresh model baseline policy | Avoids confusion between calculator and internal baseline gates | Pending |
| Keep confidence tables synchronized with latest compare results | Prevents stale risk messaging | Updated in this revision |

---

## How to Keep This Current

1. Capture calculator values for newly added scenarios.
2. Update [docs/veeam-calculator-baseline.json](docs/veeam-calculator-baseline.json).
3. Run `npm run compare:veeam` and verify zero-fail status.
4. Run `npm run test:quality` and verify pass.
5. Update this document with the latest totals and date.
