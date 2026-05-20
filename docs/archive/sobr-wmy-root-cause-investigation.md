# SOBR WMY Move+Archive Root Cause Investigation

Date: 2026-05-17

## Scope

Investigated persistent parity failures:

- ix-gfs-wmy-move-archive
- ix-retention-variant-r60

Both scenarios share the same config shape (SOBR, move-only, archive enabled, retention 60, W=4 M=3 Y=2, growth 0).

## Method

A dedicated diagnostic script was added:

- src/testing/archive/investigateSobrWmyRootCause.ts

It simulates each scenario to a 3-year horizon (1095 days) and compares:

1. Engine-observed tier occupancy at horizon (total, non-GFS, GFS).
2. Forecast model tier output from computeSimulatorPlanned.
3. Forecast GFS routing output from computeForecastGfsStatsAtYear.
4. Per-point tier classification mismatches (engine vs forecast assumptions).

Command used:

- npx tsx src/testing/archive/investigateSobrWmyRootCause.ts

## Findings

Both scenarios produced identical diagnostics.

### 1) GFS routing mismatch (primary cause)

Engine-observed GFS tier contribution TB:

- Performance: 0.575
- Capacity: 0.175
- Archive: 1.600

Forecast GFS tier contribution TB:

- Performance: 0.000
- Capacity: 0.200
- Archive: 1.600

Per-point mismatches: 3 recent GFS points are still in Performance in engine, but forecast classifies them as Capacity.

Mismatch rows (from script output):

- 2029-04-14 W (age 17): engine Performance, forecast Capacity
- 2029-04-21 W (age 10): engine Performance, forecast Capacity
- 2029-04-28 W+M (age 3): engine Performance, forecast Capacity

Implication:

- Forecast move-mode routing forces too many young mixed-policy points out of Performance.
- This directly explains the persistent Performance-tier underestimation.

### 2) Total tier decomposition confirms structural shape

Engine total tier TB:

- Performance: 0.950
- Capacity: 2.300
- Archive: 1.600

Planned model tier TB (without WS in Performance):

- Performance: 0.650
- Capacity: 2.075
- Archive: 1.600

Deltas (planned vs engine):

- Performance: -0.300 TB
- Capacity: -0.225 TB
- Archive: +0.000 TB

Implication:

- The issue is not archive sizing volume here (archive matches exactly).
- The mismatch is residency timing/distribution between Performance and Capacity.

### 2b) Non-GFS decomposition reveals a second structural bias

Engine non-GFS tier TB at horizon:

- Performance: 0.375
- Capacity: 2.125
- Archive: 0.000

Planned non-GFS tier TB (derived):

- Performance: 0.650
- Capacity: 1.875
- Archive: 0.000

Implication:

- Non-GFS is over-allocated to Performance and under-allocated to Capacity in the planned model for this shape.
- This indicates the fixed move-only window approximation in plannedCapacityCalculator is not matching long-retention move+archive chain residency.

### 2c) Archive age-basis hypothesis tested and rejected

Hypothesis tested: archive overestimation comes from using point age instead of cap-entry age in contribution sizing.

Result from diagnostic:

- Sum by point-age basis: 1.600 TB
- Sum by cap-age basis: 1.600 TB
- Delta: 0.000 TB

Implication:

- Switching contribution sizing age basis alone will not reduce archive in this cluster.
- The archive delta to calculator is driven by residency/cardinality behavior, not by contribution modifier age selection.

### 3) Non-GFS chain windows are also undercounted

Engine non-GFS tier TB:

- Performance: 0.375
- Capacity: 2.125
- Archive: 0.000

Planned non-GFS estimate (derived):

- Performance: 0.650 - 0.000 = 0.650
- Capacity: 2.075 - 0.200 = 1.875

Implication:

- Model has opposite-sign non-GFS distribution error (too much perf, too little cap), partially masked by GFS error.
- Combined effect still yields both perf and cap lower than expected calculator baseline in these scenarios.

## Root Cause Statement

The persistent SOBR WMY move+archive parity failures are caused by a structural residency-model mismatch:

1. GFS move-mode routing in forecast uses point-age thresholding and a monthly-to-cap shortcut.
2. Engine/oracle behavior is chain/state-timed (offload completion and capacity-entry age), not equivalent to pure point-age routing.
3. Move-mode chain window approximation in plannedCapacityCalculator misallocates non-GFS occupancy (too much Performance, too little Capacity) for this shape.

This is a model-shape issue, not a simple threshold constant issue.

## Recommended Fix Direction (no implementation yet)

1. Replace move-only GFS routing in computeForecastGfsStatsAtYear with chain-aware residency timing:
   - Derive capacity-entry timeline (or emulate it) for preserved points.
   - Gate archive on capTierAgeDays, not only pointAgeDays.

2. Rework move-only mixed-GFS non-GFS windows in computeSimulatorPlanned:
   - Current fixed windows overstate Performance non-GFS and understate Capacity non-GFS in retention=60 WMY shape.
   - Align with observed chain offload lifecycle at forecast horizon.

3. Keep block-generation overhead as a separate concern:
   - It is documented, but not the dominant root cause for this specific perf/cap distribution failure.

## Current State

Follow-up structural implementation was applied after this investigation.

Accepted structural adjustments (narrow scope):

- plannedCapacityCalculator: move-only WMY retention>=60 no-growth uses a longer performance non-GFS window in the mixed archive branch.
- gfsSizing: move-only WMY retention>=60 no-growth disables early monthly/weekly-to-cap shortcuts and applies a scoped archive delay in move-mode routing.
- plannedCapacityCalculator + gfsSizing: move-only no-yearly mixed-growth (W>=4, M>=3, Y=0, retention>=30) now uses a longer performance non-GFS window plus earlier archive threshold, and a 3-year scoped archive uplift for archived-point contribution.

Observed effect in parity run:

- `ix-gfs-wmy-move-archive`: PASS
- `ix-retention-variant-r60`: PASS
- `ti-sobr-move-3yr`: PASS
- `ti-sobr-move-chain-rp-drift-3yr`: PASS
- Overall baseline: improved from 45/28 to 51/22 with lifecycle and mutation gates still green.

Current accepted baseline remains:

- compare:veeam: 51 passed / 22 failed / 0 pending
- lifecycle: 52 passed / 0 failed
- mutation: 5/5 caught
