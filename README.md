# Veeam Repos Simulator

Simulator for backup repository behavior, retention, tiering, and GFS lifecycle modeling.

## Quick Links

- Automated test runner guide: [docs/automated-test-runner.md](docs/automated-test-runner.md)
- Scenario definitions: [docs/test-scenarios.json](docs/test-scenarios.json)
- Verification reference scenarios: [docs/test-scenarios-verification.md](docs/test-scenarios-verification.md)
- Quality improvement plan: [docs/test-improvement-plan.md](docs/test-improvement-plan.md)

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

## Result Summary

- Use `npm run compare:veeam` as the primary calculator-parity gate. This is the source-of-truth comparison against live-captured Veeam calculator values.
- Use `npm run verify:known-veeam-deltas` as the CI enforcement check for calculator comparison drift (currently zero expected deltas).
- Use `npm run compare:model` as an internal directional check against the simulator-aligned baseline, not as the calculator-equivalence gate.
- Use `npm run test:quality` as the primary simulator behavior-confidence gate before pushing engine changes.

Recommended CI policy:

- Required pass: `npm test`, `npm run compare:veeam`, `npm run verify:known-veeam-deltas`, `npm run test:quality`
- Informational: `npm run compare:model`

For SOBR move-only planning, the simulator now assumes: sealed chains offload when the newest restore point reaches the move threshold, and Performance pruning waits until offload is complete, the oldest point reaches retention, and a newer chain exists.
