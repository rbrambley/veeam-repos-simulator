# Post-Alignment TODO

Last updated: 2026-05-06

This list tracks follow-up work after achieving calculator baseline parity (compare:veeam 70/0).

## 1) Add Explicit Year 1 and Year 2 Calculator Baselines

Goal:
- Convert inferred confidence for Year 1 and Year 2 into directly measured confidence.

Tasks:
- Add year-specific entries to docs/veeam-calculator-baseline.json using forecastYears = 1 and forecastYears = 2.
- Prioritize representative coverage across:
  - DAS no-GFS
  - DAS mixed GFS (W+M+Y)
  - SOBR move-only no-GFS
  - SOBR copy+move
  - SOBR with archive and mixed GFS
- Keep Year 3 entries for continuity and trend checks.

Validation:
- Run npm run compare:veeam.
- Confirm pass/fail by year and by output section.
- Update docs/simulator-confidence-assessment.md with measured Year 1/2/3 confidence.

## 2) Resolve compare:model Positioning

Goal:
- Eliminate ambiguity between calculator parity and internal model drift checks.

Tasks (choose one policy):
- Option A: Rebuild docs/veeam-model-baseline.json to current comparator behavior so compare:model can be a strict pass gate again.
- Option B: Keep compare:model informational and document this clearly in README and CI workflows.

Validation:
- If Option A: run npm run compare:model and target zero failures.
- If Option B: verify CI does not block on compare:model failures.

## 3) CI and Reporting Cleanup

Goal:
- Ensure automated reporting reflects current strategy.

Tasks:
- Update CI docs and pipeline comments to emphasize:
  - Required: npm run compare:veeam, npm run verify:known-veeam-deltas, npm run test:quality
  - Informational: npm run compare:model
- Add a short job summary section that prints:
  - compare:veeam totals
  - quality suite status
  - mutation caught/blind-spot counts

Validation:
- Run pipeline once and confirm summary output is present and accurate.

## 4) Confidence Doc Maintenance Cadence

Goal:
- Keep confidence messaging aligned with actual test outcomes.

Tasks:
- Add a lightweight maintenance trigger: whenever baseline or comparator logic changes, update docs/simulator-confidence-assessment.md in the same PR.
- Include date, compare:veeam totals, and quality totals in each update.

Validation:
- Spot-check after next comparator change.
