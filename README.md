# Veeam Repos Simulator

Simulator for backup repository behavior, retention, tiering, and GFS lifecycle modeling.

## Quick Links

- Automated test runner guide: [docs/automated-test-runner.md](docs/automated-test-runner.md)
- Scenario definitions: [docs/test-scenarios.json](docs/test-scenarios.json)
- Verification reference scenarios: [docs/test-scenarios-verification.md](docs/test-scenarios-verification.md)

## Run The Project

```bash
npm install
npm run dev
```

## Run Regression Scenarios

```bash
npm test
```

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

- Use `npm run compare:veeam` when you want truth against live Veeam Calculator captures. This currently exposes 4 known SOBR divergences.
- Use `npm run verify:known-veeam-deltas` when you want CI-friendly validation that only those 4 known calculator divergences remain.
- Use `npm run compare:model` when you want validation against the simulator's internal lifecycle-aligned planning baseline.

For SOBR move-only planning, the simulator now assumes: sealed chains offload when the newest restore point reaches the move threshold, and Performance pruning waits until offload is complete, the oldest point reaches retention, and a newer chain exists.
