# Session Resume Checkpoint

Date: 2026-05-21
Purpose: Exact restart protocol with no ambiguity

## Canonical Git Checkpoint

- Branch: main
- HEAD: 22c5a44062dadb68a6b219b55890d9c1fa68c562

Recent commits:
1. 22c5a44 Generalize remaining size-anchored calculator guards across source volumes
2. 1c83942 Make generated test reports deterministic across reruns
3. 0363af6 Finalize generated GFS sizing report
4. e04da56 Capture post-gate generated report updates

## Verified State At Pause

- compare:veeam -> Passed 75 / Failed 0 / Pending 0
- test:lifecycle -> 57 passed / 0 failed
- test:mutation -> 5/5 caught
- report:forecast-vs-simulation -- --enforce-thresholds -> CI status PASS
  - Forecast vs simulator: pairs=210, avgAbs=0.4879 TB, p95Abs=1.5975 TB, maxAbs=5.994 TB

Interpretation:
- Calculator parity is green.
- Lifecycle and mutation safety gates are green.
- Quality pipeline is green at current CI thresholds.
- Precision target work remains open (p95Abs target 0.25 TB).

## Resume Protocol (Exact)

Run these commands in order:

1. git checkout main
2. git rev-parse HEAD
3. npm run compare:veeam
4. npm run test:lifecycle
5. npm run test:mutation
6. npm run report:forecast-vs-simulation -- --enforce-thresholds

Expected at resume start:
- HEAD equals 22c5a44062dadb68a6b219b55890d9c1fa68c562 (or a descendant if you intentionally advanced)
- compare:veeam remains 75/0/0
- lifecycle and mutation remain green
- forecast threshold remains green unless regressed

## Next Work Item (When Resuming)

Primary objective:
- Reduce forecast-vs-simulation p95Abs from 1.5975 TB toward <= 0.25 TB without regressing calculator parity (75/0).

Hard guardrails:
- Keep compare:veeam at zero failed scenarios.
- Keep lifecycle and mutation green.

## Resume Prompt To Paste

Use this exact prompt when you return:

"Resume from docs/session-resume-checkpoint.md. Treat that file as the source of truth. First re-run all listed resume commands and report any drift from expected values before making code changes. Do not change calculator parity from 75/0."
