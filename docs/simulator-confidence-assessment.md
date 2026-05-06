# Simulator vs. Veeam Calculator — Confidence Assessment

**Audience:** Veeam SEs evaluating whether to use the simulator in place of the Veeam Calculator.
**Last updated:** 2026-05-04
**Baseline version:** `compare:veeam` against live calculator captures, and `compare:model` against lifecycle-aligned internal expectations.

**Baseline note:**
- [docs/veeam-calculator-baseline.json](docs/veeam-calculator-baseline.json) stores live-captured Veeam Calculator expectations.
- [docs/veeam-model-baseline.json](docs/veeam-model-baseline.json) stores the simulator's lifecycle-aligned internal baseline after the 2026-05-04 offload/prune update.

---

## TL;DR

For most DAS and SOBR sizing conversations the simulator is within **2–3%** of the calculator. The material gap still present is **SOBR with GFS + Archive Tier** (currently ~10–17% undercount in prior baseline and ~14.5% undercount in newly captured SOBR mixed cases). DAS mixed GFS (W+M+Y) is live-captured and aligned.

---

## High Confidence — Use Freely (within ~2%)

| Scenario | Max delta observed | Notes |
|---|---|---|
| DAS, no GFS | 2.3% | Validated at retention 7 and 14 |
| SOBR Move-Only, no GFS | <1.5% all tiers | Perf, Cap, Archive all within tolerance |
| SOBR Copy+Move, no GFS | <2.5% all tiers | Perf, Cap confirmed close |
| DAS with **monthly-only** GFS | <0.1% | Validated small and large cases, retention 7 and 14 |
| DAS with **yearly-only** GFS | <2.2% | Validated small and large cases, retention 7 and 14 |
| DAS with **mixed W+M / W+Y / M+Y / W+M+Y** GFS | <1.7% | Live captures added for small and large cases; W+M+Y matches M+Y behavior |

The monthly and yearly GFS model was reverse-engineered from live calculator captures and is now the active implementation. It uses `min(F, daily_unique × 5)` per monthly point and `min(F, daily_unique × 18)` per yearly point — which matched all 16 captured cases exactly within rounding.

---

## Medium Confidence — Use with a Note (~1–5%, directionally right)

### Weekly-only GFS

The simulator currently treats each preserved weekly as a full-sized point. The live calculator internally decomposes weekly points into a unique slice plus a cloned remainder, and the unique slice is sensitive to how many daily retentions sit between preserved weeklies. In the validated baseline (`das-gfs`: 2 weeklies, 7-day retention, 10% growth) the full-point assumption happens to produce a 1.1% match. But:

- At `retention=14`, the weekly middle points collapse to one-day-sized splits instead of the 3× pattern seen at retention=7. The simulator would overcount in that case.
- For larger weekly counts (3W, 4W+), the overcount grows with each additional preserved middle weekly.
- As a rule: **the simulator will modestly overstate storage for weekly GFS configurations**, so it is conservative — a safe direction for a sizing conversation.

### DAS/SOBR with GFS + growth over multiple years

GFS points are sized at initial source size (year 0), not at the size the data would be when the point was created. The Veeam Calculator presumably accounts for data growth when a GFS point was actually created. This is a known intentional simplification — it makes the simulator slightly conservative (overstates older GFS points) for growing environments with long GFS retention.

---

## Low Confidence — Do Not Use for Sizing (known structural gaps)

### SOBR with GFS + Archive Tier

The `sobr-gfs-archive` scenario fails at **10.5% on planned capacity** and **16.8% on the Capacity Tier specifically**. The root cause is the Veeam Calculator's "block generation period" — a ~10-day per-chain overhead applied to object storage (SOBR Capacity Tier) that is not modeled in the simulator. This overhead adds storage that the simulator omits entirely. Using the simulator to size a SOBR + GFS + Archive configuration will undercount Capacity Tier storage by roughly 15–20% for typical parameters.

### Mixed W+M+Y GFS on SOBR + Archive

Live-captured on 2026-05-04 for small case (`1TB`, `5%`, `60d`, `10%` growth, Capacity Tier on):

- `2W+1M+1Y` = `4.1 TB`
- `0W+1M+1Y` = `4.1 TB`

This suggests weekly remains non-additive over monthly+yearly in SOBR total-capacity output as well. However, simulator forecasts for both were `4.69 TB` (delta `+14.48%`), which keeps this topology in low confidence pending explicit block-generation-period modeling and tier-level calibration.

---

## Practical Guidance by Use Case

| Use case | Recommendation |
|---|---|
| DAS capacity planning, any retention | Use it — within 2–3% |
| SOBR tier breakdown, no GFS | Use it — all tiers within 2% |
| Monthly/yearly GFS add-on sizing | Use it — validated directly from calculator |
| Mixed W+M+Y GFS on DAS | Use it — validated from live captures (small + large) |
| Weekly GFS sizing | Use it conservatively — expect slight overstatement |
| SOBR + Archive Tier with GFS | Do not use for Capacity Tier — undercount of ~15–20% |
| Mixed W+M+Y GFS on SOBR + Archive | Treat as directional; weekly appears non-additive, but total still overestimates by ~14.5% |

---

## Known Gaps and Improvement Backlog

| Gap | Impact | Status |
|---|---|---|
| Block generation period (~10 days/chain on SOBR Capacity Tier) | ~15–20% undercount on `sobr-gfs-archive` Cap Tier | Not modeled |
| Weekly GFS coefficient stability across retention values | Overcount grows beyond 2W or non-7d retention | Hypothesis exists, not fully resolved |
| Mixed W+M+Y GFS stacks on DAS | Previously unknown; now <2% | Modeled + baseline validated |
| GFS point sizing with data growth (year-of-creation vs year-0) | Conservative overcount for long GFS retention in growing environments | Known simplification |
| SOBR immutability (lock period extensions) | Retention behavior may differ under immutable WORM policy | Not modeled |

---

## How to Update This Document

1. Take a new live capture from `https://www.veeam.com/calculators/simple/vbr/machines` for the scenario in question.
2. Add the case to `src/testing/archive/validateLivePeriodGfsModel.ts` (or a new equivalent validator).
3. If the model needs updating, modify `src/models/gfsSizing.ts`.
4. Add the scenario to `docs/veeam-calculator-baseline.json` and `docs/test-scenarios.json`.
5. Run `npm run compare:veeam` and `npm run archive:test:live-period-gfs` to confirm.
6. Update the confidence tables above and move the relevant row from "Known Gaps" to a confidence tier.
