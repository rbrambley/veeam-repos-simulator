# GFS Forecast Model Redesign Specification

**Status:** Planned for future branch  
**Created:** May 20, 2026  
**Current Baseline:** p95Abs 1.535 TB, avgAbs 0.466 TB (207 forecast pairs)  
**Target State:** p95Abs ≤ 0.25 TB

## Executive Summary

The current forecast model achieves excellent parity with Veeam Calculator (74/74 scenarios within 5%) but has systematic underestimation in GFS scenarios, resulting in p95 absolute drift of 1.535 TB. This specification outlines a comprehensive redesign that replaces approximation-based dampening factors with behavior-based logic that mirrors the simulator's day-by-day execution.

## Problem Statement

### Current Model Architecture
- **Approach:** Simplified calendar math + scenario-specific dampening factors
- **Strengths:** Fast, compact, passes parity tests
- **Weaknesses:** 
  - GFS weekly-only points skipped when yearly policy exists (line 173 in gfsSizing.ts)
  - ~10 hardcoded dampening factors for specific scenario patterns
  - Cannot easily distinguish between "simulator correct" vs "forecast approximation"
  - Fragile to changes — broad fixes ripple across many scenarios

### Key Drift Patterns
1. **Weekly GFS Underestimation (4 of top 10 outliers)**
   - Scenario: `od-das-wmy-weekly-size-nonzero` (Y1-Y3)
   - Delta: 2.68–4.13 TB per year
   - Root cause: Weekly-only points skipped in W+M+Y policies
   
2. **Archive + Copy Underestimation (3-4 of top 10 outliers)**
   - Scenario: `ix-gfs-wmy-copy-archive` with/without immutability
   - Delta: 2.20–3.15 TB per year
   - Root cause: Tier residue handling doesn't account for copy+archive interaction
   
3. **Large Dataset Cases (1-2 of top 10 outliers)**
   - Scenario: `das-mixed-2w1m1y-large-r7` (5.994 TB excluded)
   - Root cause: Cumulative effect of multiple approximations on large source data

### Why Current Approach Fails
When attempted to broadly allow weekly-only points in W+M+Y scenarios:
- p95Abs worsened: 1.535 → 1.736 TB (20 bps regression)
- maxAbs worsened: 5.994 → 7.326 TB
- Some scenarios improved, others degraded due to tight calibration
- **Lesson:** The model is too tightly coupled; broad fixes create unintended ripple effects

## Proposed Redesign

### Phase 1: Refactor Core GFS Point Generation (Priority: HIGH)

**Objective:** Replace manual dampening factors with simulator-aligned logic

**Current Problem Code (gfsSizing.ts lines 150-180):**
```typescript
// Lines 173-174: Problematic skip condition
if (hasYearlyPolicy && hasWeekly && !hasMonthly && !hasYearly && !allowShortDasWeeklyAnchor && !allowSmallDasWeeklyYearlyPoints) {
  continue; // Skips weekly-only when yearly exists
}
```

**Redesign Approach:**
1. **Build explicit point cardinality model:**
   - Calculate exact number of weekly/monthly/yearly points that fall within retention window
   - Match simulator's `getPointDates()` logic day-by-day
   - Use same date filters as lifecycleOracle.ts

2. **Remove hardcoded skip conditions:**
   - Instead of skipping weekly-only points, calculate their exact contribution
   - Base decision on actual retention window overlap, not policy combinations
   - Document why points are/aren't included

3. **Validate against simulator:**
   - For each scenario, assert forecast point count = simulator point count
   - Add test suite: `src/testing/validateForecastPointCardinality.ts`
   - Update mutationRunner to catch regressions

**Effort Estimate:** 2-3 days

### Phase 2: Archive + Copy Tier Interaction (Priority: HIGH)

**Objective:** Account for copy+archive offloads in tier residue calculations

**Current Problem:**
- Primary tier residue calculation assumes offloads go to copy tier only
- Archive tier is treated as entirely separate bucket
- Copy+archive interaction ignored (when copy offload can itself be archived)

**Redesign Approach:**
1. **Extend `computeStoredContributionTB()` signature:**
   ```typescript
   interface TierResidueParams {
     hasCopy: boolean;
     hasArchive: boolean;
     archiveThresholdDays?: number;
     copyArchiveThresholdDays?: number;
   }
   ```

2. **Implement cascading offload logic:**
   - Primary → Copy (with offload threshold)
   - Copy → Archive (with archive threshold if enabled)
   - Calculate residue at each stage

3. **Validate against simulator:**
   - For copy+archive scenarios, assert forecast capacity = simulator exact calculation
   - Test: immutability window locks data in primary/copy before archive

**Effort Estimate:** 1-2 days

### Phase 3: Large Dataset Scaling (Priority: MEDIUM)

**Objective:** Ensure forecast scales correctly with large source data

**Current Problem:**
- `das-mixed-2w1m1y-large-r7` (1.5 TB source) underestimated by 5.994 TB in Year 1
- Possible causes: Growth calculation, multiple policy interaction, retention math at scale

**Redesign Approach:**
1. **Audit growth calculation for large datasets:**
   - Verify annual growth is applied correctly to incrementals
   - Check retention math at scale (does 10+ years of 5% growth cause rounding errors?)

2. **Test cumulative effect of fixes from Phase 1 & 2:**
   - May be resolved once point cardinality and tier residue are fixed
   - If not, investigate specific scenario config

**Effort Estimate:** 1 day (if Phase 1/2 resolve it), 2-3 days if targeted fix needed

### Phase 4: Regression Prevention & Documentation (Priority: HIGH)

**Objective:** Ensure parity tests + drift tests prevent future regressions

**Actions:**
1. **Enhance test suite:**
   - Keep existing calculator parity tests (74 scenarios)
   - Add drift budget tests: scenarios should not regress more than 0.05 TB per year
   - Add point cardinality tests: forecast points must match simulator
   - Add archive tests: copy+archive scenarios validated

2. **Update documentation:**
   - Document forecast model assumptions vs simulator behavior
   - Explain remaining drift (if any) as inherent to approximation
   - Create decision tree: "Why is this scenario underestimated?"

3. **Retire dampening factors:**
   - As each factor is replaced with behavior-based logic, remove it
   - Delete: `DAS_WEEKLY_ZERO_MONTHLY_YEARLY_NO_GROWTH_DAMPENING`, etc.
   - Update comments to reference new logic instead

**Effort Estimate:** 1-2 days

## Expected Outcomes

| Metric | Current | Target | Improvement |
|--------|---------|--------|-------------|
| p95Abs (TB) | 1.535 | ≤0.25 | 6x better |
| avgAbs (TB) | 0.466 | ≤0.10 | 4.5x better |
| Calculator parity | 74/74 ✓ | 74/74 ✓ | No regression |
| Lifecycle tests | All ✓ | All ✓ | No regression |
| Mutation tests | 5/5 ✓ | 5/5 ✓ | No regression |
| Code complexity | ~10 hardcoded factors | Behavior-based logic | Improved maintainability |

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|-----------|
| Break calculator parity | Medium | Critical | Run parity tests after each phase |
| Introduce new drift | Medium | High | Run full drift report after Phase 1 & 2 |
| Increase model complexity | Low | Medium | Refactor for clarity, add comments |
| Extended timeline | Medium | Medium | Phase work independently, merge incrementally |

## Implementation Plan

### Branch Strategy
- **New branch:** `feature/forecast-model-redesign` (from `feature/forecast-drift-reduction`)
- **Merge strategy:** Phase-by-phase PRs to `feature/forecast-drift-reduction`
- **Final merge:** Only when p95Abs ≤ 0.25 TB and parity maintained

### Testing Gates
```bash
# After each phase:
npm run compare:veeam              # Must: 74/74 ✓
npm run report:forecast-vs-simulation --enforce-thresholds  # Target: p95 ≤ 0.25 TB
npm run test:quality              # Must: No regressions
```

### Commit Cadence
- Phase 1: 3-5 commits (core logic, validation, test updates)
- Phase 2: 2-3 commits (tier logic, archive tests)
- Phase 3: 1-2 commits (scaling fixes if needed)
- Phase 4: 1-2 commits (documentation, cleanup)

## Future Considerations

1. **Floating Point Precision:** Forecast uses TB granularity; verify rounding doesn't accumulate across years
2. **Leap Years:** Calendar math should account for leap years in date calculations
3. **Immutability Interaction:** How immutability affects GFS point retention needs validation
4. **Real-World Validation:** Consider testing forecast against actual customer data patterns
5. **Performance:** Ensure behavior-based logic doesn't slow forecast calculation significantly

## Success Criteria

✅ Phase 1 complete: Point cardinality matches simulator within 0.1% for all scenarios  
✅ Phase 2 complete: Archive+copy scenarios match simulator within 0.05 TB  
✅ Phase 3 complete: Large datasets (>1TB source) underestimate <0.5 TB/year  
✅ Phase 4 complete: All tests pass, p95Abs ≤ 0.25 TB achieved  
✅ Calculator parity maintained: 74/74 scenarios within 5% tolerance  

## Appendix: Related Code Files

| File | Purpose | Changes Needed |
|------|---------|-----------------|
| src/models/gfsSizing.ts | Core forecast logic | Refactor lines 150-180, remove dampening factors |
| src/simulator/engine.ts | Simulator reference behavior | Already correct; use as guide |
| src/testing/validateForecastPointCardinality.ts | New validation suite | Create new file |
| src/testing/forecastSimulationComparisonReport.ts | Drift report | Already correct; will show improvements |
| docs/forecast-ci-exclusions.json | Exclusion manifest | Retire entries as fixes land |
| docs/veeam-model-baseline.json | Parity test data | Keep; run parity tests frequently |

---

**Owner:** Feature work for future branch  
**Last Updated:** May 20, 2026  
**Next Review:** When starting `feature/forecast-model-redesign`
