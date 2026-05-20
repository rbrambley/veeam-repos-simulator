Plan: Veeam Repos Simulator — Knowledge Base & Modular App Design

TL;DR:  
We will begin by establishing a comprehensive knowledge base about Veeam repository types, backup job types, and their behaviors. This will serve as the foundation for a modular, static web app that simulates day-by-day backup file creation, parses user input, and dynamically displays total TB, delta changes, backup file types, and daily explanations. The modular design will support easy, error-resistant iteration.

---

Steps

Behavior Model Rule:
- Treat simulator logic as two layers:
   - Global behaviors (must hold for all repositories and feature combinations)
   - Feature-specific behaviors (job type, GFS, SOBR tiering, repository capabilities)
- Feature-specific logic must never violate global invariants.

Current global behavior contract:
- Exactly one base full per job at any point in time.
- Base identity is oldest Full/SyntheticFull across all chains in the job storage set.
- Retention SLA is a minimum guarantee (count expiry cannot override SLA).
- Base SyntheticFull is full-sized; non-base SyntheticFull is incremental-sized.

Phase 1: Knowledge Base Research & Structuring
1. Research Veeam Repository Types
   - Document all repository types (e.g., Direct Attached Storage, Network Attached Storage, Deduplication Appliances, Object Storage, etc.).
   - Note relevant properties (performance, immutability, limitations).

2. Research Veeam Backup Job Types & File Behaviors
   - Catalog backup job types (Forward Incremental, Reverse Incremental, Synthetic Full, Active Full, GFS, etc.).
   - Document how each job type creates, chains, and manages backup files (VBK, VIB, VRB, etc.).
   - Note retention, merge, and deletion behaviors.

3. Summarize Key Behaviors
   - For each combination of repo and job type, summarize how files are created, changed, and deleted over time.
   - Explicitly mark each behavior as `Global` or `Feature-Specific`.

4. Design Data Structures
   - Propose modular, extensible data structures (e.g., TypeScript interfaces) to represent repositories, jobs, backup files, and daily simulation state.

---

Phase 2: Modular Static Web App Architecture
5. Define App Modules
   - Input parsing (user config, job schedule, repo selection)
   - Simulation engine (day-by-day logic, file creation/deletion, delta calculation)
   - State management (modular, isolated logic)
   - UI components (input forms, daily breakdown, charts/tables, explanations)

6. Select Tech Stack
   - Recommend a static web framework (e.g., React with Vite, Svelte, or plain TypeScript modules with minimal build tooling).
   - Justify choices for modularity and maintainability.

7. Outline Initial File/Folder Structure
   - Propose a clear, modular folder structure for code, data, and UI.

---

Relevant files
- /docs/veeam-knowledge-base.md — Knowledge base on repo types, job types, and behaviors
- /src/models/ — Data structures for repositories, jobs, files, simulation state
- /src/simulator/ — Simulation logic modules
- /src/components/ — UI components for input, output, and explanations
- /src/App.tsx or /src/main.ts — App entry point (depending on framework)

---

Verification
1. Review /docs/veeam-knowledge-base.md for completeness and accuracy.
2. Validate that data structures cover all required behaviors and are extensible.
3. Confirm that the proposed architecture supports modular, iterative development.
4. Ensure the plan includes clear boundaries for each module and how they interact.
5. Confirm global invariants are test-backed and cannot be bypassed by feature-specific branches.

---

Decisions
- Start with a static web app for simplicity and portability.
- Prioritize modularity to avoid syntax errors and support iterative changes.
- Build a robust knowledge base first to inform simulation logic and UI.

---

Further Considerations
1. Should the simulator support custom backup job types or only standard Veeam types? (Recommend: start with standard, add custom later)
2. What level of detail is needed for daily explanations (technical, user-friendly, both)?
3. Should the app support saving/loading user scenarios for future sessions?

---

Phase 3: Completed (as of April 30, 2026)
- [x] Core simulation engine (day-by-day, forward incremental, synthetic full, GFS tagging, retention)
- [x] Input form (repo name/type/capacity, job name/type, source data size, retention, GFS policy)
- [x] Output panel: current date, daily activity explanation, summary stats (restore points, storage used, active chains, GFS count)
- [x] Repository storage usage table with visual progress bar (red above 85%)
- [x] Backup inventory table (color-coded by type, GFS rows highlighted)
- [x] Advance simulation by 1, 7, or 30 days
- [x] Repository capacity and source data size are independent (fix for incorrect 100% usage)

---

Phase 3 Extensions: Completed (as of May 2, 2026)
- [x] Base full logic corrected: oldest Full/SyntheticFull across ALL chains per job (not chain-scoped)
- [x] Retention SLA fixed: AND logic — chain only deleted when ALL points older than retention AND no GFS
- [x] SOBR offload: Copy and Move modes, tier tracking per restore point, GFS orphan offload path
- [x] Activity Log: grouped by simulation date, collapsible, newest-to-oldest, categorised and color-coded events
- [x] Multi-day jump (+7/+30) preserves per-day event attribution via [YYYY-MM-DD] prefixes
- [x] Policy Insight card: state-based severity model (ok/warning/danger), distinct badge shapes (circle/triangle/octagon)
- [x] Policy Insight: infoNotes (italic grey, no severity impact) vs recommendations (bulleted, drive severity)
- [x] Policy Insight: GFS/Archive mismatch detection with correct escalation logic
- [x] Top row layout: two equal-width cards fill full page width (flex: 1 1 0); table stretches to card height
- [x] Automated test runner (scenarioRunner.ts): per-day base invariant, final base identity, synthetic sizing checks; 5/5 passing
- [x] Knowledge base updated with Section 6: Simulator UI Behaviour Contract

---

Phase 3 Bug Fixes & UI Polish: Completed (as of May 3, 2026)

### Engine Bug Fixes
- [x] **SOBR Copy-Only archive gating**: Copy-only mode was archiving GFS points after only `archiveAfterDays`, bypassing the offload window. Fixed to require `pointAgeDays >= offloadAfterDays + archiveAfterDays` (total age from backup date). Fixed in `engine.ts`, `InputForm.tsx`, and `veeamBaselineComparator.ts`.
- [x] **SOBR Copy-Only capacity residue**: After a GFS full moved to Archive in copy-only mode, non-GFS incrementals from the same chain were incorrectly remaining in Capacity tier. Fixed: when a chain's GFS full is archived, the non-GFS chain points are pruned from Capacity (they remain accessible via Performance until standard retention removes them).

### Regression Tests Added
- [x] New scenario `sobr-copyonly-archive-gating` in `docs/test-scenarios.json`: verifies that archive points only appear after `offloadAfterDays + archiveAfterDays` total age.
- [x] `scenarioRunner.ts` extended with `expectedArchivePointCountAtLeast`, `minArchivePointAgeDays`, and `capacityResidueInArchivedChains` assertions.
- [x] Test suite: **7/7 passing** after fixes.
- [x] Baseline comparator: **5/6 passing** (unchanged — `sobr-gfs-archive` Cap Tier -16.81% remains a known structural gap; see Known Issues).

### UI Improvements
- [x] "Configure Backup Scenario" and "Repository Storage Usage" redesigned: fieldsets replaced with styled `.form-card` components; `src/app.css` created and imported.
- [x] Apply button renamed to **Simulate**.
- [x] Repository Storage Usage table: header row upgraded to navy background with white text.
- [x] **Pruning UI hints**: tier contents show an "Pruned from Capacity" badge (orange) on points removed from Capacity after Archive preservation; activity log surfaces a "Prune" category; Selected Restore Point Path shows an explanatory note.
- [x] **Policy Insight**: warning note added when archive threshold is shorter than offload threshold in copy-only mode ("`Archive threshold (Xd) is shorter than the offload threshold (Yd). Archive will only begin after Z total age.`").

---

Phase 4: Planned Next Steps (priority order)

1. Reset button
   - Add a "Reset Simulation" button that restarts to the initial configured state without a full page refresh.
   - Should re-initialize VeeamSimulator from the current InputForm settings.

2. Realistic job type behaviors
   - Currently all job types use the same logic. Implement proper per-type behavior:
     - ForwardIncremental: full on first run, incrementals daily, synthetic full when retention is reached (already partially done)
     - ReverseIncremental (VBK+VRB): always rewrites the VBK nightly by merging the latest incremental; no synthetic full needed
     - ActiveFull: creates a brand-new full from source every N days (configurable); no synthetic full
     - SyntheticFull: already partially done — refine chain close/open logic
     - GFS: overlay on any job type; tag qualifying fulls as weekly/monthly/yearly GFS

3. Multiple jobs support
   - Allow configuring 2–3 jobs, each with its own repo, type, source size, and retention.

4. Form UX improvements
   - Preset policies (e.g., "Standard 30-day", "Compliance GFS")
   - Collapsible form sections (accordion)
   - Basic/Advanced mode toggle
   - Display each job's chains and restore points grouped/labeled in the inventory table.
   - Storage usage should aggregate across all jobs per repository.

5. ~~Visual chain timeline~~ **Completed**
   - SVG horizontal bar chart with one row per backup chain, implemented in `src/components/ChainTimeline.tsx`.
   - Restore points plotted as shaped markers (diamonds for Fulls/SyntheticFulls, circles for Incrementals).
   - Types color-coded (Full=blue, Incremental=green, SyntheticFull=purple; GFS: Yearly=red, Monthly=purple, Weekly=blue).
   - SOBR tier bands (Performance/Capacity/Archive) shown as background strips.
   - Hover tooltips, immutability segments, and generation snapshot overlays included.

6. SOBR (Scale-Out Backup Repository) simulation
   - SOBR tiering is implemented and requires continued hardening/expansion.
   - Simulate Performance Tier → Capacity Tier (object storage) offload after N days (configurable).
   - Show which restore points/chains have been offloaded vs. remain on performance tier.
   - Support both Copy mode and Move mode offload.
   - Add stronger scenario coverage for SLA boundaries and tier transitions.

---

Known Issues / Remaining Gaps (as of May 3, 2026)

1. **Block generation window not modeled (SOBR Cap/Archive)**
   - In real Veeam, when a new synthetic full is created for a SOBR Capacity tier chain, Veeam deduplicates incrementals into the new full over approximately 10 days before the old chain is fully offloaded. The simulator immediately offloads without this staging window.
   - **Impact**: `sobr-gfs-archive` Capacity Tier is -16.81% vs Veeam Calculator baseline. This is the root cause of the one remaining comparator failure.
   - **Status**: Deferred (accepted structural gap).

2. **Immutability windows not modeled**
   - No `immutabilityDays` parameter exists for any tier in `SOBRConfig`. The simulator deletes and offloads points based solely on age and retention count.
   - In real Veeam, hardened repositories and S3 Object Lock prevent deletion until per-tier immutability expires.
   - **Impact**: For scenarios without immutability configured, results match. Hardened SOBR scenarios will diverge.
   - **Status**: Not yet planned (Phase 4 candidate).

3. **Copy mode stamped synchronously**
   - The Capacity copy is stamped at backup creation time, not after a simulated background copy window.
   - Real Veeam copies asynchronously (potentially hours after job completion).
   - **Impact**: Negligible at day-resolution simulation granularity.
   - **Status**: Accepted simplification.

4. **Activity log grouped copy events**
   - Copy events are aggregated per chain (`"Chain X: N restore point(s) copied"`) rather than one log entry per restore point.
   - Move and archive events are one log per chain.
   - **Impact**: Minor cosmetic inconsistency; no calculation impact.
   - **Status**: Low priority.
