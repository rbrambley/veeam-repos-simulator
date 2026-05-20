# Lifecycle Coverage Ledger

Maps every contract rule to the test IDs that exercise it, across all 4 layers of the lifecycle test matrix.

---

## Rule Catalogue

### R-RET — Retention Rules

| Rule | Description | Test IDs |
|------|-------------|----------|
| R-RET-01 | Chain deletion requires BOTH count expiry AND SLA days expiry (AND logic) | `lb-das-retention-count`, `lb-das-sla-overrides-count`, `ti-sobr-gfs-archive-5yr`, `ti-das-sla-minimum-5yr`, `ix-retention-variant-r7`, `ix-retention-variant-r60` |
| R-RET-02 | Chain must NOT be deleted on day (retentionCount-1); MUST be eligible by retentionCount | `lb-das-retention-count` |
| R-RET-03 | SLA minimum guarantee: no chain point dated within slaDays of today may be deleted | `lb-das-sla-overrides-count`, `ti-das-sla-minimum-5yr`, `ix-short-retention-long-gfs` |
| R-RET-04 | GFS tag extends chain survival beyond standard retention+SLA | `lb-das-gfs-preserves-chain`, `ix-short-retention-long-gfs` |

---

### R-GFS — GFS Tagging and Cardinality Rules

| Rule | Description | Test IDs |
|------|-------------|----------|
| R-GFS-01 | Weekly GFS count ≤ gfsPolicy.weekly at all times | `lb-das-gfs-preserves-chain`, `lb-gfs-expiry-order`, `ti-das-3yr-gfs-wmy`, `ti-sobr-move-3yr`, `ti-sobr-copy-3yr`, `ti-sobr-gfs-archive-5yr`, `ti-das-sla-minimum-5yr`, `ix-gfs-wmy-move-archive`, `ix-gfs-wmy-copy-archive`, `ix-gfs-wmy-copy-archive-immutability`, `ix-retention-variant-r7`, `ix-retention-variant-r60`, `od-weekly-gfs-cardinality-exact` |
| R-GFS-03 | GFS expiry removes oldest qualifying restore point first (FIFO) | `lb-gfs-expiry-order`, `od-weekly-gfs-cardinality-exact`, `od-monthly-yearly-cardinality-exact` |
| R-GFS-04 | Monthly GFS tag lands ONLY on the last Saturday of each calendar month | `lb-gfs-monthly-boundary`, `ti-das-3yr-gfs-wmy`, `ix-gfs-monthly-move-immutability`, `ix-retention-variant-r7`, `od-monthly-yearly-cardinality-exact` |
| R-GFS-05 | Yearly GFS tag lands ONLY on the last Saturday of December | `lb-gfs-yearly-boundary`, `ti-das-3yr-gfs-wmy`, `ix-short-retention-long-gfs`, `od-monthly-yearly-cardinality-exact` |
| R-GFS-06 | GFS tags must only be applied to Full or SyntheticFull restore points (never Incremental) | `lb-gfs-stacking`, `ti-das-3yr-gfs-wmy` |
| R-GFS-02 | GFS tag protects chain point from deletion for the full GFS retention window | `lb-das-gfs-preserves-chain`, `ix-short-retention-long-gfs` |

---

### R-OFFLOAD — SOBR Offload Rules

| Rule | Description | Test IDs |
|------|-------------|----------|
| R-OFFLOAD-01 | Chain offload (move) cannot fire before newest point age >= offloadAfterDays | `lb-sobr-offload-threshold`, `ti-sobr-move-3yr`, `ti-sobr-gfs-archive-5yr`, `ix-gfs-wmy-move-archive`, `ix-copy-move-combo`, `od-tier-residency-per-point`, `od-chain-phase-transitions` |

---

### R-ARCH — Archive Tier Rules

| Rule | Description | Test IDs |
|------|-------------|----------|
| R-ARCH-01 | Archive transition (move mode): capTierAgeDays must be >= archiveAfterDays | `lb-sobr-archive-threshold-move`, `ti-sobr-move-3yr`, `ix-gfs-wmy-move-archive`, `ix-copy-move-combo` |
| R-ARCH-02 | Archive transition (copy mode): pointAgeDays must be >= offloadAfterDays + archiveAfterDays | `lb-sobr-archive-threshold-copy`, `ti-sobr-copy-3yr`, `ix-gfs-wmy-copy-archive`, `ix-gfs-wmy-copy-archive-immutability`, `od-tier-residency-per-point`, `od-sobr-copy-full-lifecycle` |
| R-ARCH-03 | After GFS archive (copy mode): all non-GFS Capacity data in same chain must be cleared | `lb-sobr-capacity-residue-after-archive`, `ti-sobr-copy-3yr`, `ix-gfs-wmy-copy-archive`, `ix-gfs-wmy-copy-archive-immutability`, `od-sobr-copy-full-lifecycle` |
| R-ARCH-04 | Without GFS policy: Archive tier must remain empty | `ix-no-gfs-long-archive` |

---

### R-PRUNE — Performance Prune Rules

| Rule | Description | Test IDs |
|------|-------------|----------|
| R-PRUNE-01 | Performance prune requires: offloadComplete=true AND countExpired AND newerChainExists AND all GEN performanceImmutableUntil expired | `lb-perf-prune-ordering`, `ti-sobr-move-3yr`, `ti-sobr-gfs-archive-5yr`, `im-perf-immutability-blocks-prune`, `im-all-tiers-immutability`, `od-chain-phase-transitions` |
| R-PRUNE-02 | No hasPerformanceData=true on any point in a pruned chain | `lb-perf-prune-ordering`, `ti-sobr-move-3yr` |

---

### R-CHAIN — Chain Lifecycle Rules

| Rule | Description | Test IDs |
|------|-------------|----------|
| R-CHAIN-01 | Active chains must never be offloadComplete | `ti-sobr-move-3yr`, `ti-sobr-gfs-archive-5yr`, `ix-retention-variant-r60`, `od-chain-phase-transitions`, `od-sobr-copy-full-lifecycle` |

---

### R-BASE — Global Base Rules

| Rule | Description | Test IDs |
|------|-------------|----------|
| R-BASE-01 | Exactly one isGlobalBase=true restore point per job at all times | `ti-das-3yr-gfs-wmy`, `ti-sobr-move-3yr`, `ti-sobr-copy-3yr`, `ti-sobr-gfs-archive-5yr`, `ti-das-sla-minimum-5yr`, `ix-gfs-wmy-move-archive`, `ix-gfs-wmy-copy-archive`, `ix-copy-move-combo`, `ix-retention-variant-r60` |

---

### R-GEN — Generation Lifecycle Rules

| Rule | Description | Test IDs |
|------|-------------|----------|
| R-GEN-01 | GEN windowStartDate aligns to generationPeriodDays boundaries from startDate | `im-gen-window-boundary`, `ix-high-gen-period` |
| R-GEN-02 | GEN deleteOn = windowEnd + slaDays (for non-GFS GENs) | `im-gen-window-boundary`, `ix-high-gen-period` |
| R-GEN-03 | GEN deleteOn is extended when any point in the window has a GFS tag | `im-gen-deleteon-extended-by-gfs`, `ix-gfs-monthly-move-immutability`, `ix-high-gen-period`, `od-gen-lifecycle-states` |
| R-GEN-04 | GEN lifecycle state is monotonic: DeleteOn Pending → Waiting Immutability → Deletable | `im-gen-state-transitions`, `od-gen-lifecycle-states` |

---

### R-OBJ — Object Mode Activation Rules

| Rule | Description | Test IDs |
|------|-------------|----------|
| R-OBJ-01 | Object-storage mode must activate generation lifecycle | `ix-mode-das-objectstorage-gen`, `ix-mode-sobr-nonobject-gen`, `ix-mode-sobr-objectstorage-gen` |
| R-OBJ-02 | Non-object DAS mode must not activate generation lifecycle | `ix-mode-das-nonobject-baseline` |

---

### R-IMM — Immutability Lock Rules

| Rule | Description | Test IDs |
|------|-------------|----------|
| R-IMM-01 | Performance prune must not fire while any GEN in that chain has performanceImmutableUntil in the future | `im-perf-immutability-blocks-prune`, `im-all-tiers-immutability`, `ix-gfs-monthly-move-immutability`, `ix-gfs-wmy-copy-archive-immutability` |
| R-IMM-02 | Chain deletion must not fire while any GEN has capacityImmutableUntil in the future | `im-cap-immutability-blocks-deletion`, `im-all-tiers-immutability`, `ix-gfs-wmy-copy-archive-immutability`, `od-gen-lifecycle-states` |
| R-IMM-03 | Chain deletion must not fire while any GEN has archiveImmutableUntil in the future | `im-arch-immutability-blocks-deletion`, `im-all-tiers-immutability`, `ix-gfs-wmy-copy-archive-immutability` |

---

## Test Matrix Summary

| Layer | Count | Focus |
|-------|-------|-------|
| 1 — Boundary | 12 | Exact day before/on/after each threshold |
| 2 — Temporal invariants | 8 | Daily scanning over 3–5 year runs |
| 3 — Interaction matrix | 29 | Pairwise + 3-way cross-feature combos, including mode activation checks |
| 4 — Oracle diff | 8 | Per-day expected vs actual state diff |
| **Total** | **57** | |

---

## Layer-by-Layer Test ID Index

### Layer 1 — Boundary Tests
- `lb-das-retention-count` — R-RET-01, R-RET-02
- `lb-das-sla-overrides-count` — R-RET-01, R-RET-03
- `lb-das-gfs-preserves-chain` — R-GFS-01, R-GFS-02, R-RET-04
- `lb-gfs-expiry-order` — R-GFS-03
- `lb-gfs-monthly-boundary` — R-GFS-04
- `lb-gfs-yearly-boundary` — R-GFS-05
- `lb-gfs-stacking` — R-GFS-06
- `lb-sobr-offload-threshold` — R-OFFLOAD-01
- `lb-sobr-archive-threshold-move` — R-ARCH-01
- `lb-sobr-archive-threshold-copy` — R-ARCH-02
- `lb-sobr-capacity-residue-after-archive` — R-ARCH-03
- `lb-perf-prune-ordering` — R-PRUNE-01, R-PRUNE-02

### Layer 2 — Temporal Invariant Soak Tests
- `ti-das-3yr-gfs-wmy` — R-GFS-01/03/04/05/06, R-BASE-01
- `ti-sobr-move-3yr` — R-OFFLOAD-01, R-PRUNE-01, R-CHAIN-01
- `ti-sobr-copy-3yr` — R-ARCH-02, R-ARCH-03
- `ti-sobr-gfs-archive-5yr` — R-RET-01/02/03, R-GFS-01/03, R-OFFLOAD-01, R-PRUNE-01, R-BASE-01, R-CHAIN-01
- `ti-das-sla-minimum-5yr` — R-RET-01, R-RET-03
- `ti-das-chain-rp-drift-3yr` — R-RET-01, R-BASE-01
- `ti-sobr-move-chain-rp-drift-3yr` — R-DRIFT-01, R-RET-01, R-CHAIN-01
- `ti-das-high-retention-drift-3yr` — R-RET-01, R-BASE-01

### Layer 3 — Interaction Matrix
- `im-perf-immutability-blocks-prune` — R-IMM-01
- `im-cap-immutability-blocks-deletion` — R-IMM-02
- `im-arch-immutability-blocks-deletion` — R-IMM-03
- `im-gen-window-boundary` — R-GEN-01, R-GEN-02
- `im-gen-deleteon-extended-by-gfs` — R-GEN-03
- `im-gen-state-transitions` — R-GEN-04
- `im-all-tiers-immutability` — R-IMM-01, R-IMM-02, R-IMM-03
- `ix-gfs-wmy-move-archive` — R-GFS-01/03, R-ARCH-01, R-OFFLOAD-01
- `ix-gfs-wmy-copy-archive` — R-GFS-01, R-ARCH-02, R-ARCH-03
- `ix-gfs-wmy-copy-archive-immutability` — R-GFS-01, R-ARCH-02/03, R-IMM-01/02/03, R-GEN-03
- `ix-gfs-monthly-move-immutability` — R-GEN-03, R-IMM-01, R-GFS-04
- `ix-short-retention-long-gfs` — R-RET-04, R-GFS-02
- `ix-high-gen-period` — R-GEN-01, R-GEN-02, R-GEN-03
- `ix-copy-move-combo` — R-OFFLOAD-01, R-ARCH-01, R-GFS-01
- `ix-no-gfs-long-archive` — R-ARCH-04
- `ix-retention-variant-r7` — R-RET-01, R-GFS-01/04
- `ix-retention-variant-r60` — R-RET-01, R-BASE-01, R-GFS-01
- `ix-mode-das-nonobject-baseline` — R-OBJ-02
- `ix-mode-das-objectstorage-gen` — R-OBJ-01
- `ix-mode-sobr-nonobject-gen` — R-OBJ-01
- `ix-mode-sobr-objectstorage-gen` — R-OBJ-01

### Layer 4 — Oracle Diff Tests
- `od-weekly-gfs-cardinality-exact` — R-GFS-01, R-GFS-03
- `od-monthly-yearly-cardinality-exact` — R-GFS-04, R-GFS-05
- `od-tier-residency-per-point` — R-OFFLOAD-01, R-ARCH-01/02/03
- `od-gen-lifecycle-states` — R-GEN-01/02/03/04, R-IMM-01/02
- `od-chain-phase-transitions` — R-CHAIN-01, R-OFFLOAD-01, R-PRUNE-01, R-RET-01
- `od-sobr-copy-full-lifecycle` — R-ARCH-02/03, R-CHAIN-01
- `od-das-wmy-weekly-size-nonzero` — R-DRIFT-01
- `od-calculator-parity-347tb-wmy` — R-DRIFT-01

---

## Known Gaps

| Rule | Coverage Status | Notes |
|------|----------------|-------|
| R-BASE-02 (global base = oldest Full/SyntheticFull across ALL chains) | Indirect via R-BASE-01 | Not yet explicitly checked that base identity is the OLDEST full |
| R-BASE-03 (non-base SyntheticFull is incremental-sized) | Not covered | Requires size oracle; out of scope for lifecycle runner |
| R-GFS-06 (GFS stacking on same Saturday) | Checked in `lb-gfs-stacking` | Only verifies weekly+monthly+yearly co-existence; no oracle for exact count on the day |
| Block generation period (10 days) not modeled | Known engine gap | Documented in `docs/test-scenarios-verification.md`; SOBR Cap Tier baseline delta approved |
