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

## Internal Troubleshooting Rule (Mandatory)

## Zero-Tolerance Policy (Enforced)

Tests in this project must pass with exact values. Accepting results "within X%" or "within Y TB" hides real math errors and is **not allowed**.

### What this means

- `tolerancePct` in `docs/veeam-calculator-baseline.json` and `docs/veeam-model-baseline.json` must stay at `0`.
- `gfsEffectiveToleranceTB` in `docs/test-scenarios.json` must not be set above `0`.
- If either value is increased, the test runner **blocks the run and exits with an error**.

### If you think you need a tolerance in the future

Before changing any tolerance value, you must:

1. **Explain in plain language** why the math cannot produce an exact match.
2. **Get explicit approval** before making the change.
3. **Document the reason** in the relevant baseline JSON file alongside the value.

This rule exists because we have been burned before by tolerances hiding real regressions that should have been caught immediately.

---

## Internal Troubleshooting Rule (Mandatory)

When investigating any sizing or retention anomaly (including 52-week scenarios), use this order:

1. **Internal lifecycle validation first**
2. **Internal model-baseline comparison second**
3. **External Veeam calculator comparison last**

Do **not** start by reverse-engineering Veeam Calculator behavior if internal checks already explain the result.

### Step 1: Lifecycle truth check (engine behavior)

Run the lifecycle suite:

```bash
npm run test:lifecycle
```

For a single scenario, run:

```bash
npm run test:lifecycle -- --id ix-gfs-only-policy
```

This validates chain lifecycle invariants and scenario assertions from `docs/lifecycle-test-scenarios.json`.

### Step 2: Forecast truth check (internal model drift)

Run model baseline comparison:

```bash
npm run compare:model
```

This compares current simulator forecast output to the repository's internal model baseline (`docs/veeam-model-baseline.json`) without relying on the external calculator.

### Step 2b: Visual diagnosis (sizing context at scale)

Open the quarterly comparison report in a browser:

```bash
npm run report:quarterly
# then open docs/quarterly-comparison-report.html
```

Use this when the raw numbers from Steps 1–2 pass but the sizing result looks wrong at a glance, or when investigating a large-source scenario (50TB+). The report shows:

- Simulator vs Forecast vs Calculator across 8 scenarios × 12 quarters
- Tier breakdown, GFS age buckets, Incr:Full ratio, and trend arrows per quarter
- Decision strip (Green/Amber/Red readiness) per scenario
- GFS zero assertions and cross-scenario comparison table at the top

Do **not** skip this step for any scenario where the source data is ≥50TB — % deltas at large scale mask purchase-decision errors that are only visible in the absolute TB columns.

### Step 3: External parity check (only when needed)

Only after Steps 1 and 2, run:

```bash
npm run compare:veeam
```

Use this for directional parity evidence or baseline-capture maintenance, not as the first debugging tool.

### Escalation rule

Escalate to calculator investigation only if one of these is true:

- lifecycle assertions fail,
- internal model comparison fails unexpectedly,
- or a planned baseline update specifically requires external parity refresh.

If Steps 1 and 2 pass, treat the issue as **internally resolved** unless external parity is explicitly in scope.

Script enforcement is active:

- `npm run compare:veeam` now runs a guard that executes Step 1 and Step 2 first.
- If either prerequisite fails, Veeam comparison is blocked.
- Raw comparator remains available as `npm run compare:veeam:raw` for controlled internal tooling.

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

The comparator now supports optional file-type size parity checks when present in the baseline:

- `expected.fileTypeFullTB`
- `expected.fileTypeIncrementalTB`
- `expected.fileTypeSyntheticFullTB`

If those values are filled for a scenario, `compare:veeam` will match simulator-vs-calculator file type sizes in addition to planned capacity metrics.

To verify CI-safe calculator drift expectations:

```bash
npm run verify:known-veeam-deltas
```

This verifies that `compare:veeam` only fails for the approved known divergence set.

To run capture, validation, and full quality checks as a single sequence (timeout-safe):

```bash
npm run validate:all
```

This runs sequentially:
1. `npm run capture:veeam` — Playwright scraper captures baseline
2. `npm run compare:veeam` — Compares simulator to captured values
3. `npm run verify:known-veeam-deltas` — Verifies only approved deltas exist
4. `npm run test:quality` — Full quality pipeline (lifecycle + mutations + GFS sizing)

The sequence stops at the first failure, preventing cascading errors. This is the recommended approach for end-to-end validation.

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

- `Passed: 76` (for `npm run compare:veeam`)
- `Passed: 23` (for `npm run compare:model`)
- `Failed: 0`

*(As of May 8, 2026, the captured calculator baseline suite contains 76 scenarios, and the internal model baseline suite contains 23 scenarios.)*

For lifecycle quality validation, you will see:

- mutation outcomes (`CAUGHT` or `BLIND SPOT`)
- lifecycle scenario results grouped by layer
- summary totals including `PASS`, `SKIP (known gaps)`, and `FAIL`
- generated report path: `docs/lifecycle-report.html`

Current expected lifecycle total (as of May 8, 2026):

- `51 passed, 0 skipped (known gaps), 0 failed`

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

## Veeam Baseline — Browser Automation (Recommended)

The **preferred method** for capturing Veeam Calculator values is using Playwright browser automation.
It automatically fills inputs, runs calculations, and extracts results with minimal manual intervention.

```bash
npm run capture:veeam
```

This runs the Playwright scraper, which for each scenario:
1. Navigates to https://www.veeam.com/calculators/simple/vbr/machines
2. Automatically fills in all input fields (source data, change rate, retention, GFS settings, repo type, SOBR settings)
3. Clicks the **Estimate** button to trigger the calculator
4. Clicks the **Details** link in the results sidebar to view the detailed breakdown
5. Extracts planned capacity and tier values from the Details panel
6. Retries extraction up to 3 times to handle computation delays
7. Falls back to interactive prompts if extraction fails (useful for calculator UI changes)
8. Saves results directly to `docs/veeam-calculator-baseline.json`
9. Uses `ReFS/XFS = ON` as the current comparison assumption

The scraper is non-destructive: it preserves existing baseline values and merges new captures incrementally.

### Manual Capture (Fallback)

If you need to manually enter values (calculator UI changed, network issues, etc.):

```bash
npm run capture:veeam:manual
```

This opens the step-by-step interactive guide:
- Shows exactly what inputs to set in the Veeam Calculator.
- Prompts for Total Capacity (and tier breakdown for SOBR scenarios).
- Press ENTER to skip any value you do not have yet.
- Type `exit` at any prompt to skip to the next scenario.

To paste raw Veeam Input/Result text and auto-parse fields:

```bash
npm run capture:veeam:manual -- --paste
```

- Paste one scenario block at a time.
- Type `END` on its own line to finish each pasted block.
- The guide auto-parses `Storage required` and `Working space` when found.
- The guide also attempts to parse file-type sizes (`Full backup`, `Incremental backup`, `Synthetic full backup`) when present in pasted Details output.

To capture a single scenario manually:

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

## Timeout-Safe Execution Pattern

To reduce risk of long command sessions timing out in interactive environments, run the primary workflow as separate commands:

```bash
npm test
npm run compare:veeam
npm run verify:known-veeam-deltas
npm run test:quality
```

If any model behavior fix is approved and applied, restart this sequence from step 1 (scenario 1) to avoid iterative regression drift.

## Archived vs Active Tests

Active gates (required for workflow confidence):

- `npm test`
- `npm run compare:veeam`
- `npm run verify:known-veeam-deltas`
- `npm run test:quality`

Visual investigation tools (regenerate after model or scenario changes):

- `npm run report:quarterly` → `docs/quarterly-comparison-report.html`
  - Regenerate whenever: new scenarios are added, GFS/tier logic changes, or a large-source sizing investigation is in progress.
  - The committed HTML file should always reflect the current scenario set — stale HTML is a sign the report was not regenerated after a change.
- `npm run test:quality` already regenerates `docs/lifecycle-report.html` as a side effect.

Archived/exploratory tests (kept for research, not CI-gating):

- `npm run archive:test:idealized-gfs`
- `npm run archive:test:live-weekly-gfs`
- `npm run archive:test:live-period-gfs`

## Scope Caveat — Known Structural Limitations

This simulator does not yet model **Direct-to-Object (Object Repos) repository type**.

For scenarios using Veeam Calculator baseline comparison:
- DAS and SOBR scenarios: Baseline comparison is reliable for validation
- Direct-to-Object scenarios: Baseline comparison should be treated as directional until the repo type is implemented

### About Playwright automation

The scraper uses [Playwright](https://playwright.dev) for browser automation because the [Veeam Calculator](https://www.veeam.com/calculators/simple/vbr/machines) is a browser-based SPA with no public API.

The automation fills in source data, change rate, retention, and GFS settings, then extracts the computed planned capacity and tier breakdown values. It uses flexible selectors and retry logic to handle DOM variations and computation delays.

**Potential risks to be aware of:**
- **UI changes**: Veeam can update their calculator UI at any time, which may require updating input selectors in the scraper
- **Network dependencies**: Requires network access to `calculator.veeam.com` during capture
- **CI/CD considerations**: Headless browser in CI environments may need additional OS-level setup (handled automatically by Playwright in most cases)

**Fallback strategy:**
If the scraper encounters selector mismatches or extraction failures, it automatically falls back to interactive mode where you manually enter values from the calculator. This prevents capture runs from silently failing.

## When To Run It

Run after any change to:

- `src/simulator/engine.ts`
- `src/components/InputForm.tsx`
- `src/components/OutputPanel.tsx`
- Retention, GFS, tiering, base-promotion, or sizing logic
- Working space sizing logic (progressive bucket/bracket scale planned-capacity calculations)

Also regenerate `docs/quarterly-comparison-report.html` (`npm run report:quarterly`) after any of the above **and** after adding new scenarios or updating `REPORT_SCENARIOS` in `src/testing/triWayReport.ts`. The committed HTML should never be stale relative to the scenario list.

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
5. If the failure involves sizing at scale (any scenario ≥50TB source), run `npm run report:quarterly` and open `docs/quarterly-comparison-report.html` to diagnose visually.
6. Fix logic or update expectations.
7. Rerun until all required checks pass.
8. If you added scenarios or changed GFS/tier logic, regenerate both HTML reports before committing.

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
