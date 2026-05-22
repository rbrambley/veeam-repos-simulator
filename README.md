# Veeam Repos Simulator

Simulator for backup repository behavior, retention, tiering, and GFS lifecycle modeling.

## Architecture

The project has three layers:

| Layer | Location | Purpose |
|---|---|---|
| **Forecaster** | `src/models/gfsSizing.ts`, `src/models/plannedCapacityCalculator.ts` | Calculates planned storage requirements by year for the UI and comparator. Currently an emulation of the Veeam Calculator model. |
| **Simulator engine** | `src/simulator/engine.ts` | Day-by-day lifecycle simulation of backup chains, retention, GFS expiry, and SOBR tiering. Treated as the canonical runtime reference. |
| **Test harness** | `src/testing/` | Comparator, lifecycle oracle, mutation runner, and forecast-vs-simulation drift report. Validates both layers independently and jointly. |

### Integration seam (for Calculator developer)

When the real Veeam Calculator engine source is available, two functions are the replacement targets:

- `computeForecastGfsStatsAtYear(...)` in `src/models/gfsSizing.ts` — GFS point contribution math
- `computeSimulatorPlanned(...)` in `src/models/plannedCapacityCalculator.ts` — full tier sizing output

Both are annotated with `INTEGRATION SEAM` / `EMULATION CALIBRATION CONSTANTS` comments explaining what to replace and why. The `ScenarioConfig` input shape and `PlannedResult` output shape in `plannedCapacityCalculator.ts` define the integration contract.

### Verifying nothing is broken

Run the full gate suite before and after any model change:

```bash
npm run gate:push
```

Expected: calculator parity 75/75, lifecycle 57/57, mutation 5/5, forecast CI PASS (p95Abs ≤ 2.00 TB).

---

## Quick Links

- Automated test runner guide: [docs/automated-test-runner.md](docs/automated-test-runner.md)
- Calculator integration handoff: [docs/calculator-integration-handoff.md](docs/calculator-integration-handoff.md)
- Scenario definitions: [docs/test-scenarios.json](docs/test-scenarios.json)
- Verification reference scenarios: [docs/test-scenarios-verification.md](docs/test-scenarios-verification.md)
- Quality improvement plan: [docs/test-improvement-plan.md](docs/test-improvement-plan.md)

## Coworker Handoff Readiness

For integration with the real Veeam Calculator implementation, use:

- [docs/calculator-integration-handoff.md](docs/calculator-integration-handoff.md)

Recommended sequence for your coworker:

```bash
npm install
npm run gate:quick
npm run compare:veeam
npm run gate:push
```

Integration scope is intentionally limited to:

- `src/models/gfsSizing.ts`
- `src/models/plannedCapacityCalculator.ts`

All other simulator/runtime logic should remain unchanged unless a validated contract update is required.

## Run The Project

```bash
npm install
npm run dev
```

## Run Regression Scenarios

```bash
npm test
```

## Run Quality Validation

```bash
npm run test:mutation
npm run test:lifecycle
npm run test:quality
```

- `test:mutation` injects deliberate engine defects and verifies the suite catches them.
- `test:lifecycle` runs the full lifecycle contract suite and generates the HTML report.
- `test:quality` runs mutation testing first, then lifecycle validation, and writes the consolidated report.

To reseed long-run golden baselines:

```bash
npm run test:quality:update-snapshots
```

Generated artifacts:

- `docs/lifecycle-report.html` — `Veeam Simulator — Quality & Validation Report`
- `docs/mutation-report.json` — mutation outcomes and blind-spot status
- `docs/golden-snapshots.json` — fixed day-365/day-730 baselines for long-run scenarios

## Run Move/Retention Matrix Checks

```bash
npm run test:matrix
```

## Baseline Comparisons

```bash
npm run compare:veeam
npm run compare:model
npm run verify:known-veeam-deltas
```

`compare:veeam` uses the live-captured calculator baseline in [docs/veeam-calculator-baseline.json](docs/veeam-calculator-baseline.json).
`compare:model` uses the lifecycle-aligned internal baseline in [docs/veeam-model-baseline.json](docs/veeam-model-baseline.json).

## PR Automation (Create or Update)

One-time GitHub CLI auth:

```bash
"C:/Program Files/GitHub CLI/gh.exe" auth login --hostname github.com --web --git-protocol https
```

Create or update the current branch PR (same branch/base pair):

```bash
npm run pr:sync
```

Create as draft when no PR exists yet:

```bash
npm run pr:sync:draft
```

Notes:

- Uses the latest `docs/pr-summary-*.md` as PR body when present.
- Uses the latest commit subject as the default PR title.
- Auto-detects base branch from `origin/HEAD` (falls back to `main`).

## Result Summary

- Use `npm run compare:veeam` as the primary calculator-parity gate. This is the source-of-truth comparison against live-captured Veeam calculator values.
- Use `npm run verify:known-veeam-deltas` as the CI enforcement check for calculator comparison drift (currently zero expected deltas).
- Use `npm run compare:model` as an internal directional check against the simulator-aligned baseline, not as the calculator-equivalence gate.
- Use `npm run test:quality` as the primary simulator behavior-confidence gate before pushing engine changes.

Recommended CI policy:

- Required pass: `npm test`, `npm run compare:veeam`, `npm run verify:known-veeam-deltas`, `npm run test:quality`
- Informational: `npm run compare:model`

For SOBR move-only planning, the simulator now assumes: sealed chains offload when the newest restore point reaches the move threshold, and Performance pruning waits until offload is complete, the oldest point reaches retention, and a newer chain exists.
