# Calculator Integration Handoff

This document is the handoff package for integrating the app with the real Veeam Calculator implementation.

## Goal

Replace the current forecast emulation logic with real calculator logic while preserving simulator behavior, UI contracts, and quality gates.

## Integration Targets

1. Replace GFS sizing logic in src/models/gfsSizing.ts
2. Replace planned capacity aggregation logic in src/models/plannedCapacityCalculator.ts

Current integration seam is already isolated to these two functions:

1. computeForecastGfsStatsAtYear(...) in src/models/gfsSizing.ts
2. computeSimulatorPlanned(...) in src/models/plannedCapacityCalculator.ts

## Contract To Preserve

Input contract (do not break shape):

1. ScenarioConfig in src/models/plannedCapacityCalculator.ts

Output contract (do not break shape):

1. PlannedResult in src/models/plannedCapacityCalculator.ts

Downstream consumers depending on this contract:

1. UI report and planning surfaces in src/components/OutputPanel.tsx
2. Comparator and test harness in src/testing/veeamBaselineComparator.ts and other src/testing/* runners

## Pre-Integration Baseline Checklist

Run these before changing logic and save results:

1. npm run gate:quick
2. npm run compare:veeam
3. npm run gate:push

Expected baseline:

1. Calculator parity: 75 passed / 0 failed
2. Lifecycle: 57 passed / 0 failed
3. Mutation: 5 caught / 5
4. Forecast CI: PASS (p95Abs <= 2.00 TB)

## Integration Workflow For Coworker

1. Create a feature branch from main.
2. Implement real calculator calls only inside src/models/gfsSizing.ts and src/models/plannedCapacityCalculator.ts.
3. Keep ScenarioConfig and PlannedResult interfaces stable.
4. If additional calculator inputs are needed, extend ScenarioConfig in a backward-compatible way (optional fields with defaults).
5. Keep all non-model simulator logic unchanged in src/simulator/engine.ts.
6. Run quick checks after each model change: npm run gate:quick.
7. Validate parity and lifecycle before PR: npm run gate:push.
8. If parity drift appears, run targeted captures and comparator analysis:
   - npm run capture:veeam:manual
   - npm run capture:veeam -- --id <scenario-id>
   - npm run compare:veeam

## Data Source And Capture Notes

Baseline files:

1. docs/veeam-calculator-baseline.json (live capture baseline)
2. docs/veeam-model-baseline.json (internal simulator-aligned baseline)

Capture guide:

1. src/testing/veeamCaptureGuide.ts

Important:

1. compare:veeam is the primary calculator parity gate.
2. compare:model is directional only.

## Definition Of Done

Integration is ready when all are true:

1. Contract unchanged for ScenarioConfig and PlannedResult, or backward-compatible extension only.
2. npm run gate:push passes.
3. No new regression in docs/forecast-vs-simulation-summary.json CI thresholds.
4. New/updated logic documented in PR summary and linked to exact changed functions.

## Suggested PR Template Notes

Include these in the PR body:

1. Which calculator behaviors were integrated.
2. Which assumptions were removed from emulation.
3. Before/after metrics for compare:veeam and report:forecast-vs-simulation.
4. Any known residual parity deltas and why.
