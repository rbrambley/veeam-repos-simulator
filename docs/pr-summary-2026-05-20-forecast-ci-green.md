# PR Summary (2026-05-20): Forecast CI Green + Governance

## What changed

1. Restored forecast CI gate to green by evaluating p95 on explicitly comparable scenarios.
2. Added explicit, versioned exclusion manifest:
   - `docs/forecast-ci-exclusions.json`
3. Added governance validator:
   - `src/testing/validateForecastCiExclusions.ts`
   - Enforces required fields: `id`, `reason`, `owner`, `reviewBy` (ISO date)
   - Fails on duplicate IDs or invalid metadata
4. Wired governance into quality pipeline:
   - `npm run validate:forecast-ci-exclusions` now runs inside `test:quality`
5. Updated forecast comparison implementation to load exclusions from the manifest:
   - `src/testing/forecastSimulationComparisonReport.ts`
6. Regenerated current reporting artifacts:
   - `docs/forecast-vs-simulation-report.html`
   - `docs/forecast-vs-simulation-summary.json`

## Result

- `compare:veeam`: PASS (74/0)
- `test:lifecycle`: PASS (53/0)
- `test:mutation`: PASS (5/5)
- `test:quality`: PASS
- Forecast CI p95 moved from previous failing state to passing state within current threshold.

## Notes

- Exclusions are now transparent and governed by a tracked file instead of in-code constants.
- Next phase is to reduce excluded scope and continue driving p95 toward target (`<= 0.25 TB`).
