# Automated Test Runner Guide

This project now has two layers of automated validation:

- the original scenario runner for sizing and baseline comparisons
- the lifecycle quality pipeline for contract, mutation, and snapshot validation

## Best File Location

The best location for this guide is:

- `docs/automated-test-runner.md`

Reason:

- This project already stores verification assets in `docs/` (`test-scenarios.json`, `test-scenarios-verification.md`), so keeping the usage guide there keeps all test documentation in one place.

## What It Runs

### Baseline scenario runner

The test runner executes all scenarios defined in:

- `docs/test-scenarios.json`

It uses:

- `src/testing/scenarioRunner.ts`

The runner uses a fixed simulation start date (`2026-05-02`) so results are deterministic across different days and machines.

### Lifecycle quality pipeline

The lifecycle quality pipeline executes the contract-validation suite defined in:

- `docs/lifecycle-test-scenarios.json`

It uses:

- `src/testing/lifecycleRunner.ts`
- `src/testing/mutationRunner.ts`
- `src/testing/qualityRunner.ts`
- `src/testing/goldenSnapshots.ts`

The lifecycle runner also uses the fixed simulation start date `2026-05-02` for deterministic output.

## How To Run

From the project root:

```bash
npm test
```

This runs:

- `tsx src/testing/scenarioRunner.ts`

For full simulator quality validation:

```bash
npm run test:quality
```

This runs:

- `tsx src/testing/qualityRunner.ts`
- `npm run test:mutation`
- `npm run test:lifecycle`

To run phases individually:

```bash
npm run test:mutation
npm run test:lifecycle
```

To update the locked golden baselines after an intentional model change:

```bash
npm run test:quality:update-snapshots
```

To compare against stored Veeam Calculator baselines:

```bash
npm run compare:veeam
```

This runs:

- `tsx src/testing/veeamBaselineComparator.ts`
- Baseline file: `docs/veeam-calculator-baseline.json`

To verify CI-safe calculator drift expectations:

```bash
npm run verify:known-veeam-deltas
```

This verifies that `compare:veeam` only fails for the approved known divergence set.

To auto-create initial baseline values from current simulator logic:

```bash
npx tsx src/testing/veeamBaselineComparator.ts --seed
```

## Expected Output

You will see:

- Each scenario name and ID
- Checkpoint progress lines
- Final state checks
- Summary with passed/failed totals

If all scenarios pass, the summary ends with:

- `Passed: 7`
- `Failed: 0`

*(As of May 3, 2026, the baseline suite contains 7 scenarios: 5 original + 2 new regression scenarios.)*

For lifecycle quality validation, you will see:

- mutation outcomes (`CAUGHT` or `BLIND SPOT`)
- lifecycle scenario results grouped by layer
- summary totals including `PASS`, `SKIP (known gaps)`, and `FAIL`
- generated report path: `docs/lifecycle-report.html`

The HTML report includes:

- a sticky section nav
- a findings dashboard for things that need investigation
- a separate `Quality Signals` block for positive evidence such as caught mutations and matching golden checkpoints
- a golden snapshot registry with links back to individual scenarios

For baseline comparison, you will see:

- Per-scenario capacity metric comparisons
- Delta and delta percentage per compared metric
- Summary with Passed / Failed / Pending (missing expected values)

`compare:veeam` may be non-zero by design when known structural gaps are tracked. Use `verify:known-veeam-deltas` to enforce that only approved known deltas remain.

## Veeam Baseline — Guided Capture (Recommended)

Use the interactive capture guide to walk through each scenario step by step.
It shows exactly what inputs to set in the Veeam Calculator and prompts you for the result.

```bash
npm run capture:veeam
```

- Opens a step-by-step prompt for each scenario.
- Shows the URL, and all input values to set in the Veeam Calculator.
- Prompts for Total Capacity (and tier breakdown for SOBR scenarios).
- Saves directly to `docs/veeam-calculator-baseline.json`.
- Press ENTER to skip any value you do not have yet.
- Type `exit` at any prompt to skip to the next scenario.
- Uses `ReFS/XFS = ON` as the current comparison assumption.

To paste raw Veeam Input/Result text and auto-parse fields:

```bash
npm run capture:veeam -- --paste
```

- Paste one scenario block at a time.
- Type `END` on its own line to finish each pasted block.
- The guide auto-parses `Storage required` and `Working space` when found.
- It also performs basic input mismatch checks (source data, change rate, growth, forecast period, retention days).

To capture a single scenario only:

```bash
npx tsx src/testing/veeamCaptureGuide.ts --id das-basic
```

## Advanced Scenario Assertions

Some scenarios support extended assertions beyond the standard checks. These are defined in `docs/test-scenarios.json` and evaluated in `src/testing/scenarioRunner.ts`.

| Assertion key | Description |
|---|---|
| `expectedRestorePointCount` | Final count of all restore points in state |
| `expectedArchivePointCountAtLeast` | Minimum number of archive-tier points at end of run |
| `minArchivePointAgeDays` | All archive points must be at least this many days old |
| `capacityResidueInArchivedChains` | Expected count of non-GFS Capacity points in chains that have archived GFS fulls (should be `0` after fix) |

These extended assertions were added for the `sobr-copyonly-archive-gating` regression scenario (May 3, 2026).

## Veeam Baseline Setup (Manual / One-Time)

1. Open `docs/veeam-calculator-baseline.json`.
2. For each scenario id, enter expected values copied from Veeam Calculator.
3. Keep `null` for any metric not yet captured (reported as Pending).
4. Run `npm run compare:veeam`.

Notes:

- `compare:veeam` does **not** call Veeam website during test runs.
- It compares simulator outputs to your stored baseline values only.
- It is best treated as directional/informational, not a hard pass/fail gate by itself.
- `--seed` writes baseline values from the simulator as a starting point.

## Veeam Baseline — Future Option: Playwright Automation

> **Not implemented.** Documented here for reference if the team wants to revisit.

The [Veeam Calculator](https://calculator.veeam.com) is a browser-based SPA with no public API.
Values can theoretically be captured automatically using [Playwright](https://playwright.dev),
a browser automation library.

### How it would work

1. Install Playwright as a dev dependency: `npm install --save-dev @playwright/test`
2. A script (`src/testing/veeamCalculatorScraper.ts`) would:
   - Launch a headless Chromium browser
   - Navigate to `https://calculator.veeam.com`
   - For each scenario, fill in all input fields (source data, growth rate, change rate, retention, repo type, SOBR settings, GFS)
   - Wait for the results panel to update
   - Scrape the capacity values from the result DOM
   - Write them to `docs/veeam-calculator-baseline.json`
3. An npm script `capture:veeam:auto` would run this automatically.

### Why it was not implemented

| Risk | Detail |
|---|---|
| **Brittleness** | Veeam can change their UI at any time with no notice, silently breaking the scraper |
| **Input mapping** | Veeam's input labels may not map exactly to this simulator's field names; requires manual verification |
| **Large dependency** | Playwright + Chromium adds ~300 MB to dev dependencies |
| **CI/CD complexity** | Headless browser needs OS-level dependencies in CI environments |
| **Maintenance cost** | Any Veeam Calculator update may require updating both field selectors and value mappings |

### Scope caveat to keep in mind

- Veeam's `Block generation period` is tied to cloud object storage behavior.
- This simulator does not yet model that behavior (and does not yet model Direct-to-Object repo type).
- Until those features are implemented, baseline comparison should be treated as directional for affected scenarios.

### When to revisit

- If manual capture becomes a recurring friction point (many scenarios, frequent updates)
- If Veeam publishes a public API or embeddable calculator with a stable interface
- If the team adopts Playwright for other UI testing and the dependency cost is already paid

## When To Run It

Run after any change to:

- `src/simulator/engine.ts`
- `src/components/InputForm.tsx`
- `src/components/OutputPanel.tsx`
- Retention, GFS, tiering, base-promotion, or sizing logic
- Working space sizing logic (largest-full based planned-capacity calculations)

## How To Add/Change Scenarios

Edit:

- `docs/test-scenarios.json`

Each scenario contains:

- `config`: repository + policy settings
- `totalDays`: simulation length
- `checkpoints`: milestone days to report
- `finalState.expectedRPCount`: final restore-point count assertion

## Understanding Failures

If a scenario fails, the output shows:

- Scenario ID
- Actual vs expected value

Example:

- `Final RP count mismatch: expected X, got Y`

Typical next steps:

1. Confirm the change in behavior is intentional.
2. If intentional, update the scenario expectation.
3. If not intentional, fix the simulator logic and rerun `npm test`.

## Fast Validation Workflow

1. Make your code change.
2. Run `npm test` for the baseline comparison suite.
3. Run `npm run test:quality` for engine, lifecycle, retention, GFS, tiering, or report changes.
4. If failures occur, inspect the CLI output and `docs/lifecycle-report.html`.
5. Fix logic or update expectations.
6. Rerun until all required checks pass.

## Notes

- The runner validates checkpoint flow, final restore-point counts, and key global invariants.
- It is a regression safety net; keep scenario expectations aligned with intended engine behavior.

## Global Invariant Checklist

The simulator behavior model depends on these invariants. Keep them stable across all features.

1. Single base full per job
	- At most one restore point per job can have base status on any simulation day.

2. Base identity is global to the job storage set
	- The base is the oldest Full or SyntheticFull across all chains for a job.
	- Active/inactive chain status does not change this identity rule.

3. SyntheticFull sizing normalization
	- Base SyntheticFull is full-sized.
	- Non-base SyntheticFull is incremental-sized.

4. Retention SLA minimum guarantee
	- Inactive chains are deleted only when both count window and SLA window are expired.

## Current Automated Assertions

The runner currently checks:

- Per-day base uniqueness (fails if a job has more than one base on any day)
- Final restore point count per scenario
- Final base count equals exactly one
- Final base identity equals oldest Full/SyntheticFull across all chains
- Non-base SyntheticFull incremental-size behavior

If you add new global behaviors, extend `src/testing/scenarioRunner.ts` with direct assertions before relying on scenario counts alone.
