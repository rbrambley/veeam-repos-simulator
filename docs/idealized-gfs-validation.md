# Idealized GFS Validation

Date: 2026-05-04

## Scope

This report validates the reverse-engineered calculator model:

- Every preserved GFS restore point is treated as a synthetic full of size `F`.
- Unique portion is `F * (1 - (1 - C)^D)`.
- Cloned portion is `F - unique`.
- `unique + cloned = F` for every point.

The simulator was **not** changed as part of this validation.

## Test Inputs

- `F = 6.66 TB`
- `C = 0.10`
- Weekly spacing `D = 7`
- Monthly spacing `D = 30`
- Yearly spacing `D = 365`

## Expected Idealized Values

| Spacing | Unique (TB) | Cloned (TB) |
|---------|-------------|-------------|
| Weekly (7) | 3.474543 | 3.185457 |
| Monthly (30) | 6.377675 | 0.282325 |
| Yearly (365) | 6.660000 | 0.000000 |

The invariant `unique + cloned = 6.66 TB` passed for all matrix rows.

## Matrix Results

The validation script `npm run test:idealized-gfs` compares the idealized formula against two current application behaviors:

1. **Forecast/comparator behavior**
   - Current `InputForm.tsx` / `veeamBaselineComparator.ts` logic counts preserved GFS points as full-sized unique data.
2. **Engine behavior**
   - Current `engine.ts` creates GFS synthetic full points at one-day incremental size (`F * C`) with no clone split.

### Result Summary

- Idealized formula matches matrix expectation: `12/12`
- Current forecast/comparator matches idealized matrix: `4/12`
- Current engine sizing matches idealized matrix: `0/12`

### Mismatch Pattern

- Weekly rows: forecast too high, engine too low
- Monthly rows: forecast slightly high, engine far too low
- Yearly rows: forecast matches only because `(1 - C)^365` is effectively zero; engine still fails

## Additional Baseline Check

Existing baseline comparison remains:

- `npm test`: `7/7` scenarios passing
- `npm run compare:veeam`: `5/6` passing
- Known failure remains `sobr-gfs-archive`

The current captured Veeam baselines do **not** support replacing weekly GFS sizing with the idealized formula as-is.

For the existing weekly-only baseline scenarios:

- Current forecast model contribution per weekly GFS point at `F = 0.5 TB`, `C = 0.05`
  - `0.500000 TB`
- Idealized contribution per weekly GFS point with `D = 7`
  - `0.150831 TB`

This means:

- `das-gfs` would drop by about `0.698337 TB` if two weekly points used the idealized formula.
- `sobr-gfs-archive` would drop by about `1.396675 TB` if four weekly points used the idealized formula.

That would move both scenarios **away** from the currently captured calculator values, not toward them.

## Live Weekly Re-Capture (May 4, 2026)

Two fresh weekly-only cases were captured directly from the live calculator at `https://calculator.veeam.com` using the calculator detail view.

### Case 1 — Large Weekly Test

Inputs:

- Source data: `13.32 TB`
- Daily change rate: `10%`
- Retention: `7 dailies`
- GFS: `2 weeklies`
- Forecast period: `3 years`
- Growth rate: `0%`
- Compression: `50%`
- ReFS/XFS: `True`
- Capacity Tier: `False`

Observed live output:

- `Storage required = 21.7 TB`
- `Working space = 6.35 TB`
- Restore Points Simulation excerpt:
  - `W2 = 6.66 TB`
  - `W1 = 0.67 TB + 5.99 TB`

Control case with the same inputs but `0 weeklies` also produced:

- `Storage required = 21.7 TB`

Implication:

- The live calculator did **not** add a `3.474543 TB` unique portion per preserved weekly as predicted by the idealized formula.
- It also did **not** add a full `6.66 TB` per preserved weekly.
- The detail view instead shows a split weekly point where `W1` is decomposed into roughly one-day change (`0.67 TB`) plus cloned remainder (`5.99 TB`).

### Case 2 — Small Weekly Test

Inputs:

- Source data: `1.0 TB`
- Daily change rate: `5%`
- Retention: `7 dailies`
- GFS: `4 weeklies`
- Forecast period: `3 years`
- Growth rate: `0%`
- Compression: `50%`
- ReFS/XFS: `True`
- Capacity Tier: `False`

Observed live output:

- `Storage required = 1.5 TB`
- `Working space = 0.53 TB`
- Restore Points Simulation excerpt:
  - `W4 = 0.50 TB`
  - `W3 = 0.08 TB + 0.43 TB`
  - `W2 = 0.08 TB + 0.43 TB`
  - `W1 = 0.03 TB + 0.48 TB`

Control case with the same inputs but `0 weeklies` produced:

- `Storage required = 1.4 TB`

Implication:

- The live calculator again did **not** behave like the idealized formula, which would predict a much larger weekly delta.
- The live calculator detail view shows preserved weeklies as split points with explicit unique and cloned portions, but those portions are not explained by the simple compound-spacing formula from the synthetic matrix.

### Live Capture Conclusion

The live calculator evidence rejects the current idealized weekly hypothesis.

What the live captures show instead:

- The calculator does model preserved weekly points as split objects with unique and cloned portions.
- The split is **not** simply `F * (1 - (1 - C)^7)` for every weekly point.
- The split is also **not** the simulator's current rule of `F * C` for every preserved weekly point.
- The oldest preserved weekly in the visible chain can appear as a full-sized point, while other weeklies carry smaller unique portions plus cloned remainder.

This means the calculator is using a more specific restore-point simulation model than the reverse-engineered idealized formula described above.

## Working Weekly Hypothesis (Validated Against Live Captures)

After additional live captures (`1W`, `2W`, `3W`, `4W`, `5W` for the `1 TB / 5% / 7d` case, plus the earlier large `2W` case), a weekly-only hypothesis now matches all recorded live observations.

Prototype files:

- `src/testing/liveWeeklyGfsHypothesis.ts`
- `src/testing/validateLiveWeeklyGfsHypothesis.ts`
- Run with: `npm run test:live-weekly-gfs`

### Hypothesis

Let:

- `F` = compressed full size
- `C` = daily change rate
- `R` = standard retention in days
- `B` = block generation period in days (live calculator showed `10`)
- `W` = number of preserved weeklies

Then for the weekly-only cases captured so far:

1. Daily unique slice is linear, not compound:

  `daily_unique = F * C`

2. The newest preserved weekly (`W1`) is always:

  `unique = daily_unique`

  `cloned = F - unique`

3. Intermediate preserved weeklies (`W2..W[n-1]`) use:

  `unique = F * C * (B - R)`

  `cloned = F - unique`

  For the captured weekly-only cases, `B = 10` and `R = 7`, so intermediate weeklies use `3` daily slices.

4. The oldest preserved weekly (`Wn`) becomes the full chain anchor when `W >= 2`:

  `unique = F`

  `cloned = 0`

5. The `1W` edge case is special:

  - the weekly point itself remains split like `W1`
  - the full anchor remains as the older non-GFS full (`D14` in the captured case)

### Evidence Summary

The prototype validator currently matches all recorded live weekly captures:

- `weekly-1-small`
- `weekly-2-small`
- `weekly-3-small`
- `weekly-4-small`
- `weekly-5-small`
- `weekly-2-large`

This is enough to say the live calculator's weekly behavior is **better explained by a block-generation-aware positional rule** than by the earlier compound-spacing formula.

## Live Monthly And Yearly Re-Capture (May 4, 2026)

Equivalent monthly-only and yearly-only live captures were taken with the same small baseline case:

- Source data: `1.0 TB`
- Daily change rate: `5%`
- Retention: `7 dailies`
- Forecast period: `3 years`
- Growth rate: `0%`
- Compression: `50%`
- ReFS/XFS: `True`
- Capacity Tier: `False`

### Monthly-only cases

#### `1M`

- Storage required: `1.5 TB`
- Working space: `0.53 TB`
- Restore Points Simulation excerpt:
  - `M1 = 0.50 TB`
  - `D14 = 0.13 TB + 0.38 TB`
  - `D7 = 0.03 TB + 0.48 TB`

#### `2M`

- Storage required: `1.6 TB`
- Working space: `0.53 TB`
- Restore Points Simulation excerpt:
  - `M2 = 0.50 TB`
  - `M1 = 0.13 TB + 0.38 TB`
  - `D14 = 0.13 TB + 0.38 TB`
  - `D7 = 0.03 TB + 0.48 TB`

#### `3M`

- Storage required: `1.7 TB`
- Working space: `0.53 TB`
- Restore Points Simulation excerpt:
  - `M3 = 0.50 TB`
  - `M2 = 0.13 TB + 0.38 TB`
  - `M1 = 0.13 TB + 0.38 TB`
  - `D14 = 0.13 TB + 0.38 TB`
  - `D7 = 0.03 TB + 0.48 TB`

### Yearly-only cases

#### `1Y`

- Storage required: `1.8 TB`
- Working space: `0.53 TB`
- Restore Points Simulation excerpt:
  - `Y1 = 0.50 TB`
  - `D14 = 0.45 TB + 0.05 TB`
  - `D7 = 0.03 TB + 0.48 TB`

#### `2Y`

- Storage required: `2.3 TB`
- Working space: `0.53 TB`
- Restore Points Simulation excerpt:
  - `Y2 = 0.50 TB`
  - `Y1 = 0.45 TB + 0.05 TB`
  - `D14 = 0.45 TB + 0.05 TB`
  - `D7 = 0.03 TB + 0.48 TB`

#### `3Y`

- Storage required: `2.7 TB`
- Working space: `0.53 TB`
- Restore Points Simulation excerpt:
  - `Y3 = 0.50 TB`
  - `Y2 = 0.45 TB + 0.05 TB`
  - `Y1 = 0.45 TB + 0.05 TB`
  - `D14 = 0.45 TB + 0.05 TB`
  - `D7 = 0.03 TB + 0.48 TB`

### Extended Conclusion

The same **broad positional structure** does extend beyond weekly GFS:

1. The oldest preserved point in the period set is a full anchor.
2. The newest edge point near the active retention boundary remains a one-day split (`D7 = daily_unique + cloned_remainder` in these captures).
3. Intermediate preserved points use a fixed linear unique slice plus cloned remainder.

However, the **exact weekly coefficient does not generalize unchanged**.

For the captured `1 TB / 5% / 7d` cases:

- Daily unique slice = `0.025 TB` (displayed as `0.03 TB`)
- Weekly intermediate unique = `0.075 TB` (displayed as `0.08 TB`) = `3 × daily_unique`
- Monthly intermediate unique = `0.125 TB` (displayed as `0.13 TB`) = `5 × daily_unique`
- Yearly intermediate unique = `0.450 TB` (displayed as `0.45 TB`) = `18 × daily_unique`

So the evidence currently supports a **general positional linear-slice model** rather than the earlier compound-spacing model, but with **period-specific coefficients** that still need to be reverse-engineered.

At this point the safe conclusion is:

- the idealized formula is rejected,
- the weekly rule is partially reverse-engineered,
- the monthly/yearly behavior appears related but is not yet explained by one confirmed general formula.

## Larger Monthly/Yearly Scaling Check (May 4, 2026)

To test whether the monthly/yearly coefficients scale consistently, the same monthly-only and yearly-only captures were repeated with the larger case:

- Source data: `13.32 TB`
- Daily change rate: `10%`
- Retention: `7 dailies`
- Forecast period: `3 years`
- Growth rate: `0%`
- Compression: `50%`
- ReFS/XFS: `True`
- Capacity Tier: `False`

This gives:

- `F = 6.66 TB`
- `daily_unique = 0.666 TB` (displayed as `0.67 TB`)

### Large monthly-only cases

- `1M`
  - Storage required: `25.0 TB`
  - `M1 = 6.66 TB`
  - `D14 = 3.33 TB + 3.33 TB`
  - `D7 = 0.67 TB + 5.99 TB`

- `2M`
  - Storage required: `28.3 TB`
  - `M2 = 6.66 TB`
  - `M1 = 3.33 TB + 3.33 TB`
  - `D14 = 3.33 TB + 3.33 TB`

- `3M`
  - Storage required: `31.7 TB`
  - `M3 = 6.66 TB`
  - `M2 = 3.33 TB + 3.33 TB`
  - `M1 = 3.33 TB + 3.33 TB`
  - `D14 = 3.33 TB + 3.33 TB`

### Large yearly-only cases

- `1Y`
  - Storage required: `28.3 TB`
  - `Y1 = 6.66 TB`
  - `D14 = 6.66 TB`
  - `D7 = 0.67 TB + 5.99 TB`

- `2Y`
  - Storage required: `35.0 TB`
  - `Y2 = 6.66 TB`
  - `Y1 = 6.66 TB`
  - `D14 = 6.66 TB`

- `3Y`
  - Storage required: `41.6 TB`
  - `Y3 = 6.66 TB`
  - `Y2 = 6.66 TB`
  - `Y1 = 6.66 TB`
  - `D14 = 6.66 TB`

### What the larger cases confirm

These larger captures strengthen the period-specific coefficient model.

Monthly:

- Small case middle monthly unique: `0.125 TB` (displayed `0.13 TB`)
- Large case middle monthly unique: `3.33 TB`
- `3.33 / 0.666 = 5`

So monthly continues to behave like:

- `monthly_middle_unique = min(F, daily_unique * 5)`

Yearly:

- Small case middle yearly unique: `0.45 TB`
- `0.45 / 0.025 = 18`
- Large case expected linear slice from the same rule would be:
  - `0.666 * 18 = 11.988 TB`
- Live calculator shows `6.66 TB`, i.e. capped at the full size.

So yearly currently appears consistent with:

- `yearly_middle_unique = min(F, daily_unique * 18)`

This means the current best-fit live model is now stronger than before:

- Weekly middle unique: `min(F, daily_unique * 3)`
- Monthly middle unique: `min(F, daily_unique * 5)`
- Yearly middle unique: `min(F, daily_unique * 18)`
- Edge point near active retention boundary: `daily_unique`
- Oldest preserved point in the period set: full anchor `F`

What is still unknown:

- why the coefficients are specifically `3`, `5`, and `18`
- whether those values remain stable when retention changes away from `7`
- whether mixed W+M+Y stacks follow the same composition rules when all three are present in one chain

## Retention Sensitivity Check (May 4, 2026)

To test whether the current coefficients are fixed constants or derived from retention, equivalent live captures were repeated with `retention = 14 dailies`.

### Small `1 TB / 5%` captures with `14 dailies`

#### Weekly `3W`

- Storage required: `1.5 TB`
- Restore Points Simulation excerpt:
  - `W3 = 0.50 TB`
  - `W2 = 0.03 TB + 0.48 TB`
  - `W1 = 0.03 TB + 0.48 TB`
  - no `0.08 + 0.43` middle-weekly points appear

#### Monthly `2M`

- Storage required: `1.8 TB`
- Restore Points Simulation excerpt:
  - `M2 = 0.50 TB`
  - `M1 = 0.13 TB + 0.38 TB`
  - `D21 = 0.13 TB + 0.38 TB`
  - `D14 = 0.03 TB + 0.48 TB`
  - `D7 = 0.03 TB + 0.48 TB`

#### Yearly `2Y`

- Storage required: `2.4 TB`
- Restore Points Simulation excerpt:
  - `Y2 = 0.50 TB`
  - `Y1 = 0.45 TB + 0.05 TB`
  - `D21 = 0.45 TB + 0.05 TB`
  - `D14 = 0.03 TB + 0.48 TB`
  - `D7 = 0.03 TB + 0.48 TB`

### Large `13.32 TB / 10%` captures with `14 dailies`

#### Weekly `3W`

- Storage required: `26.3 TB`
- Restore Points Simulation excerpt:
  - `W3 = 6.66 TB`
  - `W2 = 0.67 TB + 5.99 TB`
  - `W1 = 0.67 TB + 5.99 TB`

#### Monthly `2M`

- Storage required: `33.0 TB`
- Restore Points Simulation excerpt:
  - `M2 = 6.66 TB`
  - `M1 = 3.33 TB + 3.33 TB`
  - `D21 = 3.33 TB + 3.33 TB`
  - `D14 = 0.67 TB + 5.99 TB`
  - `D7 = 0.67 TB + 5.99 TB`

#### Yearly `2Y`

- Storage required: `39.6 TB`
- Restore Points Simulation excerpt:
  - `Y2 = 6.66 TB`
  - `Y1 = 6.66 TB`
  - `D21 = 6.66 TB`
  - `D14 = 0.67 TB + 5.99 TB`
  - `D7 = 0.67 TB + 5.99 TB`

### Retention findings

These captures split the current conclusions into two parts:

#### Weekly is retention-sensitive

The earlier weekly middle coefficient (`3 × daily_unique`) does **not** survive when retention increases from `7` to `14`.

With `14 dailies`:

- the oldest preserved weekly is still a full anchor
- the remaining preserved weeklies fall back to edge-style one-day splits
- no intermediate weekly `3 × daily_unique` points remain in the captured `3W` case

So the weekly coefficient is **not a fixed period constant**. It depends on retention placement relative to the preserved weeklies.

#### Monthly and yearly currently look retention-stable

For the captured `7`-day and `14`-day retention cases so far:

- monthly middle points still match `min(F, daily_unique * 5)`
- yearly middle points still match `min(F, daily_unique * 18)`
- additional daily edge splits appear at each active-retention boundary (`D14`, `D7`), but the monthly/yearly preserved-point coefficients themselves did not change in the recorded cases

### Revised best-fit live model

The current best-fit model should now be stated more carefully:

- Edge points at active retention boundaries behave like one-day splits: `daily_unique`
- Oldest preserved point in a period set is a full anchor `F`
- Monthly middle points currently fit `min(F, daily_unique * 5)`
- Yearly middle points currently fit `min(F, daily_unique * 18)`
- Weekly middle behavior is **not yet generalized**; the earlier `3 × daily_unique` fit appears to be specific to the `7-day` retention captures

## Conclusions

### 1. Is the reverse-engineered formula internally valid?

Yes, for the supplied synthetic matrix. The formula is deterministic, consistent, and produces the expected weekly/monthly/yearly progression.

However, the fresh live weekly captures show that this formula does **not** describe the live calculator's weekly GFS point simulation.

### 2. Does the current simulator implement it?

No.

- `src/simulator/engine.ts`
  - GFS synthetic full points are stored at one-day incremental size.
  - No unique/cloned split is modeled.

### 3. Does the current forecast/comparator implement the validated monthly/yearly model?

**Yes, as of May 4, 2026** — see Incremental Implementation Status below.

- `src/components/InputForm.tsx` and `src/testing/veeamBaselineComparator.ts` now both call `computeForecastGfsStatsAtYear(...)` from the shared helper `src/models/gfsSizing.ts`.
- Monthly-only GFS points use `min(F, daily_unique * 5)`.
- Yearly-only GFS points use `min(F, daily_unique * 18)`.
- Weekly and mixed W/M/Y points remain on the legacy full-point assumption until the weekly coefficient is confirmed stable.

### 4. Is the model sufficient to fully replicate the calculator?

Not yet.

The monthly/yearly model is now validated and implemented. Weekly sizing remains unresolved. Mixed W+M+Y stacks have not been captured.

## Affected Modules

- `src/simulator/engine.ts` — no change; engine GFS sizing is intentionally separate from forecast sizing.
- `src/components/InputForm.tsx` — updated to use shared helper.
- `src/testing/veeamBaselineComparator.ts` — updated to use shared helper.
- `src/models/gfsSizing.ts` — new shared helper implementing the validated model.
- `docs/veeam-calculator-baseline.json` — four new monthly/yearly scenarios added.

## Recommendation

The monthly/yearly incremental implementation is complete and passing. Recommended next steps:

1. **Weekly sizing** — the weekly coefficient (`3 × daily_unique` at `retention=7`) is not confirmed stable at other retention values. Do not generalize it until more captures are taken across a range of retentions.
2. **Mixed W+M+Y stacks** — no live captures yet for scenarios where weekly, monthly, and yearly GFS are all enabled simultaneously. The current code falls back to full-point sizing for those cases, which will overcount.
3. **Block generation period** — the `sobr-gfs-archive` scenario still fails because the SOBR Capacity Tier receives a 10-day block-generation-period overhead per chain that is not modeled.

## Incremental Implementation Status (May 4, 2026)

### What was implemented

A shared helper `src/models/gfsSizing.ts` was created with the function `computeForecastGfsStatsAtYear(params)`. Both `InputForm.tsx` and `veeamBaselineComparator.ts` were rewired to call this helper, replacing their previously duplicated local GFS sizing logic.

The helper applies the validated monthly/yearly live-capture model:

| GFS class | Stored unique per preserved point |
|-----------|-----------------------------------|
| Monthly only | `min(F, daily_unique × 5)` |
| Yearly only | `min(F, daily_unique × 18)` |
| Weekly | full point size `F` (unresolved) |
| Mixed W/M/Y | full point size `F` (unresolved) |

An important nuance: monthly/yearly preserved points must contribute their period slice regardless of whether the newest preserved point falls inside the active retention window. Filtering strictly to out-of-retention points undercounts monthly storage. The helper handles this correctly.

### Validation results (May 4, 2026)

| Command | Result |
|---------|--------|
| `npm run test:live-period-gfs` | 16/16 matches (small and large cases, retention=7 and retention=14) |
| `npm run compare:veeam` | 9/10 — all four new monthly/yearly scenarios pass; only `sobr-gfs-archive` fails (pre-existing block-generation-period gap) |

### New npm script

`npm run test:live-period-gfs` — runs `src/testing/validateLivePeriodGfsModel.ts`, which validates the shared helper against the 16 monthly/yearly live-capture cases recorded in this document.
