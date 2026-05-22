import React, { useState } from 'react';
import { computeForecastGfsStatsAtYear } from '../models/gfsSizing';
import { normalizeForecastYears } from '../models/forecast';
import { SimulationState, BackupJobType, RepositoryType, computeVeeamWorkingSpaceTB } from '../models/veeam';
import { computeSimulatorPlanned, ScenarioConfig } from '../models/plannedCapacityCalculator';

interface InputFormProps {
  simState: SimulationState;
  onScenarioChange: (newState: SimulationState) => void;
  onReset?: () => void;
}

export const InputForm: React.FC<InputFormProps> = ({ simState, onScenarioChange, onReset }) => {
  const normalizeNonNegativeInt = (value: number): number => {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return 0;
    return Math.max(0, Math.floor(numericValue));
  };

  const syncForecastWithGfs = (
    candidateForecastYears: number,
    weekly: number,
    monthly: number,
    yearly: number,
  ): number => {
    const maxGfsSetting = Math.max(
      normalizeNonNegativeInt(weekly),
      normalizeNonNegativeInt(monthly),
      normalizeNonNegativeInt(yearly),
    );
    const minForecastFromGfs = maxGfsSetting > 0 ? maxGfsSetting + 1 : 1;
    return Math.max(normalizeForecastYears(candidateForecastYears), minForecastFromGfs);
  };

  const [repoName, setRepoName] = useState(simState.repositories[0]?.name || 'Main Repo');
  const [repoType, setRepoType] = useState<RepositoryType>(simState.repositories[0]?.type || 'DAS');
  const [isObjectStorage, setIsObjectStorage] = useState(simState.repositories[0]?.isObjectStorage ?? false);
  const [jobName, setJobName] = useState(simState.jobs[0]?.name || 'Daily Backup');
  const [jobType, setJobType] = useState<BackupJobType>(simState.jobs[0]?.type || 'ForwardIncremental');
  const [sourceDataTB, setSourceDataTB] = useState(simState.jobs[0]?.sourceDataTB || 1);
  const [dailyChangeRate, setDailyChangeRate] = useState(simState.jobs[0]?.dailyChangeRatePct ?? 5);
  const [annualGrowthRate, setAnnualGrowthRate] = useState(simState.jobs[0]?.annualGrowthRatePct ?? 0);
  const [forecastYears, setForecastYears] = useState(
    syncForecastWithGfs(
      simState.jobs[0]?.forecastYears ?? 1,
      simState.jobs[0]?.gfsPolicy?.weekly ?? 0,
      simState.jobs[0]?.gfsPolicy?.monthly ?? 0,
      simState.jobs[0]?.gfsPolicy?.yearly ?? 0,
    )
  );
  const [retention, setRetention] = useState(simState.jobs[0]?.retention.restorePoints || 14);
  const [gfsWeekly, setGfsWeekly] = useState(simState.jobs[0]?.gfsPolicy?.weekly || 0);
  const [gfsMonthly, setGfsMonthly] = useState(simState.jobs[0]?.gfsPolicy?.monthly || 0);
  const [gfsYearly, setGfsYearly] = useState(simState.jobs[0]?.gfsPolicy?.yearly || 0);
  const [startDate, setStartDate] = useState(simState.date);
  // SOBR config (policy inputs only — capacity is calculated)
  const existingRepo = simState.repositories[0];
  const existingSobr = existingRepo?.sobrConfig;
  const [sobrOffloadDays, setSobrOffloadDays] = useState(existingSobr?.offloadAfterDays ?? 14);
  const [sobrArchiveDays, setSobrArchiveDays] = useState(existingSobr?.archiveAfterDays ?? 90);
  const [sobrGenerationPeriodDays, setSobrGenerationPeriodDays] = useState(existingSobr?.generationPeriodDays ?? 10);
  const [sobrPerformanceImmutabilityDays, setSobrPerformanceImmutabilityDays] = useState(existingSobr?.performanceImmutabilityDays ?? existingRepo?.immutabilityDays ?? 0);
  const [sobrCapacityImmutabilityDays, setSobrCapacityImmutabilityDays] = useState(existingSobr?.capacityImmutabilityDays ?? 0);
  const [sobrArchiveImmutabilityDays, setSobrArchiveImmutabilityDays] = useState(existingSobr?.archiveImmutabilityDays ?? 0);
  const [sobrHasArchive, setSobrHasArchive] = useState(existingSobr?.hasArchiveTier ?? false);
  const [sobrCopyEnabled, setSobrCopyEnabled] = useState(existingSobr?.copyEnabled ?? false);
  const [sobrMoveEnabled, setSobrMoveEnabled] = useState(existingSobr?.moveEnabled ?? true);
  const effectiveCopyEnabled = sobrCopyEnabled;
  const effectiveMoveEnabled = sobrMoveEnabled || !sobrCopyEnabled;
  const supportsTieredImmutability = repoType === 'SOBR';
  const supportsArchiveImmutability = repoType === 'SOBR' && sobrHasArchive && isObjectStorage;

  const computeGfsStatsAtYear = (yearOffset: number) => {
    const stats = computeForecastGfsStatsAtYear({
      sourceDataTB,
      annualGrowthRatePct: annualGrowthRate,
      dailyChangeRatePct: dailyChangeRate,
      retentionDays: retention,
      gfsPolicy: {
        weekly: gfsWeekly,
        monthly: gfsMonthly,
        yearly: gfsYearly,
      },
      startDate,
      yearOffset,
      copyEnabled: effectiveCopyEnabled,
      effectiveMoveEnabled,
      offloadAfterDays: sobrOffloadDays,
      archiveAfterDays: sobrArchiveDays,
      hasArchiveTier: sobrHasArchive,
      // Use point-date sizing so forecast mirrors simulator restore-point growth.
      sizingMode: 'reverse',
    });

    return stats;
  };

  const computeMoveLifecycleWindows = (retentionDays: number, offloadDays: number) => {
    // Strict move-only model: Performance keeps the short active-chain window,
    // Capacity keeps the post-offload retention window.
    const performanceWindowDays = Math.max(1, Math.min(fullIntervalDays, retentionDays));
    const capacityAccumulationDays = Math.max(0, retentionDays - offloadDays);
    return {
      performanceWindowDays,
      capacityAccumulationDays,
    };
  };

  // ── Calculated capacity requirements (derived from scenario inputs) ───────────
  const appliedForecastYear = normalizeForecastYears(forecastYears);
  const peakSourceTB = sourceDataTB * Math.pow(1 + annualGrowthRate / 100, appliedForecastYear);
  const fullSizeTB = peakSourceTB * 0.5;               // ~50% compression ratio
  const incrSizeTB = peakSourceTB * (dailyChangeRate / 100) * 0.5;
  const fullIntervalDays = jobType === 'ForwardIncremental' ? 7 : retention;
  const gfsForecastStats = computeGfsStatsAtYear(appliedForecastYear);

  const estimateTierChainDataTB = (windowDays: number) => {
    if (windowDays <= 0) return 0;
    const chainsInWindow = Math.max(1, Math.ceil(windowDays / Math.max(1, fullIntervalDays)));
    // EXACT VEEAM MODEL: One promoted full (oldest SyntheticFull = base) +
    // (chainsInWindow * fullIntervalDays - 1) incrementals.
    // The active chain being built = working space, NOT stored data.
    // DO NOT add an extra chain interval here — that double-counts working space.
    const effectiveDays = chainsInWindow * fullIntervalDays - 1;
    return fullSizeTB + effectiveDays * incrSizeTB;
  };

  let calcRepoCapTB = 0;
  let calcPerfTB = 0;
  let calcCapTB = 0;
  let calcArchTB = 0;

  const yearColumns: number[] = appliedForecastYear > 5
      ? [1, 2, 3, 4, appliedForecastYear]
      : Array.from({ length: Math.min(5, Math.max(3, appliedForecastYear)) }, (_, i) => i + 1);
  const displayedYearCount = yearColumns.length;

  const computeYearlyRequirements = (year: number) => {
    const yearSourceTB = sourceDataTB * Math.pow(1 + annualGrowthRate / 100, year);
    const yearFullSizeTB = yearSourceTB * 0.5;
    const yearIncrSizeTB = yearSourceTB * (dailyChangeRate / 100) * 0.5;
    // Working space uses initial sourceDataTB (no growth) — matches Veeam Calculator behaviour
    const yearWorkingSpaceReserveTB = computeVeeamWorkingSpaceTB(sourceDataTB);

    // Build scenario config for shared calculator
    const config: ScenarioConfig = {
      repositoryType: repoType === 'SOBR' ? 'SOBR' : 'DAS',
      jobType: jobType as string,
      sourceDataTB,
      annualGrowthRatePct: annualGrowthRate,
      dailyChangeRatePct: dailyChangeRate,
      retention,
      gfsPolicy: {
        weekly: gfsWeekly,
        monthly: gfsMonthly,
        yearly: gfsYearly,
      },
      offloadAfterDays: sobrOffloadDays,
      archiveAfterDays: sobrArchiveDays,
      generationPeriodDays: sobrGenerationPeriodDays,
      performanceImmutabilityDays: sobrPerformanceImmutabilityDays,
      capacityImmutabilityDays: sobrCapacityImmutabilityDays,
      archiveImmutabilityDays: sobrArchiveImmutabilityDays,
      hasArchiveTier: sobrHasArchive,
      copyEnabled: effectiveCopyEnabled,
      moveEnabled: effectiveMoveEnabled,
    };

    // Call shared calculator
    const planned = computeSimulatorPlanned(config, startDate, year, 'reverse');

    if (repoType !== 'SOBR') {
      return {
        peakSourceTB: yearSourceTB,
        fullBackupTB: planned.fileTypeFullTB,
        incrementalTB: planned.fileTypeIncrementalTB,
        workingSpaceNeededTB: yearWorkingSpaceReserveTB,
        workingSpaceAdditionalTB: yearWorkingSpaceReserveTB,
        gfsTB: planned.gfsStorageTB,
        repoUsedTB: planned.plannedCapacityTB - yearWorkingSpaceReserveTB,
        repoTotalTB: planned.plannedCapacityTB,
        perfTB: 0,
        capTB: 0,
        archTB: 0,
        sobrUsedTB: 0,
        sobrTotalTB: 0,
      };
    }

    // SOBR case: extract tier breakdowns
    return {
      peakSourceTB: yearSourceTB,
      fullBackupTB: planned.fileTypeFullTB,
      incrementalTB: planned.fileTypeIncrementalTB,
      workingSpaceNeededTB: yearWorkingSpaceReserveTB,
      workingSpaceAdditionalTB: yearWorkingSpaceReserveTB,
      gfsTB: planned.gfsStorageTB,
      repoUsedTB: 0,
      repoTotalTB: 0,
      perfTB: planned.plannedPerformanceTierTB,
      capTB: planned.plannedCapacityTierTB,
      archTB: sobrHasArchive ? planned.plannedArchiveTierTB : 0,
      sobrUsedTB: planned.plannedCapacityTB - yearWorkingSpaceReserveTB,
      sobrTotalTB: planned.plannedCapacityTB,
    };
  };

  const yearlyRequirements = yearColumns.map(y => ({ year: y, ...computeYearlyRequirements(y) }));
  const appliedRequirements = computeYearlyRequirements(appliedForecastYear);

  if (repoType !== 'SOBR') {
    calcRepoCapTB = appliedRequirements.repoTotalTB;
  } else {
    calcPerfTB = appliedRequirements.perfTB;
    calcCapTB = appliedRequirements.capTB;
    calcArchTB = sobrHasArchive ? appliedRequirements.archTB : 0;
    calcRepoCapTB = appliedRequirements.sobrTotalTB;
  }

  function fmtTB(v: number) {
    return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TB';
  }

  const handleApply = () => {
    const repoId = 'repo1';
    const jobId = 'job1';
    const newState: SimulationState = {
      repositories: [
        {
          id: repoId,
          name: repoName,
          type: repoType,
          isObjectStorage: isObjectStorage || undefined,
          capacityTB: calcRepoCapTB,
          immutabilityDays: repoType === 'SOBR' ? undefined : Math.max(0, sobrPerformanceImmutabilityDays),
          isImmutable: repoType === 'SOBR' ? undefined : sobrPerformanceImmutabilityDays > 0,
          sobrConfig: repoType === 'SOBR' ? {
            performanceCapacityTB: calcPerfTB,
            capacityCapacityTB: calcCapTB,
            archiveCapacityTB: calcArchTB,
            offloadAfterDays: sobrOffloadDays,
            archiveAfterDays: sobrArchiveDays,
            generationPeriodDays: sobrGenerationPeriodDays,
            performanceImmutabilityDays: sobrPerformanceImmutabilityDays,
            capacityImmutabilityDays: sobrCapacityImmutabilityDays,
            archiveImmutabilityDays: sobrArchiveImmutabilityDays,
            hasArchiveTier: sobrHasArchive,
            copyEnabled: effectiveCopyEnabled,
            moveEnabled: effectiveMoveEnabled,
          } : undefined,
        },
      ],
      jobs: [
        {
          id: jobId,
          name: jobName,
          type: jobType,
          repositoryId: repoId,
          sourceDataTB,
          dailyChangeRatePct: dailyChangeRate,
          annualGrowthRatePct: annualGrowthRate,
          forecastYears: appliedForecastYear,
          schedule: { frequency: 'Daily', timeOfDay: '02:00' },
          retention: { restorePoints: retention, slaDays: retention },
          gfsPolicy: (gfsWeekly || gfsMonthly || gfsYearly)
            ? { weekly: gfsWeekly, monthly: gfsMonthly, yearly: gfsYearly }
            : undefined,
        },
      ],
      chains: [],
      restorePoints: [],
      blocks: [],
      date: startDate,
      startDate,
    };
    onScenarioChange(newState);
  };

  return (
    <div>
      <h2 className="scenario-config-title">
        <span className="scenario-config-title-accent" />
        Configure Backup Scenario
      </h2>
      <div className="scenario-layout">
        {/* ── Left column: inputs ── */}
        <form
          onSubmit={e => { e.preventDefault(); handleApply(); }}
          className="scenario-column"
        >
          <div className="form-card">
            <div className="form-card-header">Simulation Settings</div>
            <div className="form-card-body two-col">
            <label>
              Start Date:
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="input-date-compact" />
            </label>
            <label>
              Forecast (y):
              <input
                type="number"
                value={forecastYears}
                min={1}
                max={10}
                step={1}
                onChange={e => {
                  const nextForecast = normalizeForecastYears(Number(e.target.value));
                  setForecastYears(syncForecastWithGfs(nextForecast, gfsWeekly, gfsMonthly, gfsYearly));
                }}
                className="input-number-compact"
              />
            </label>
            <label>
              Daily Change (%):
              <input type="number" value={dailyChangeRate} min={0.1} max={100} step={0.1} onChange={e => setDailyChangeRate(Number(e.target.value))} className="input-number-compact" />
            </label>
            <label>
              Annual Growth (%):
              <input type="number" value={annualGrowthRate} min={0} max={100} step={1} onChange={e => setAnnualGrowthRate(Number(e.target.value))} className="input-number-compact" />
            </label>
            </div>
          </div>
          <div className="form-card">
            <div className="form-card-header">Backup Job</div>
            <div className="form-card-body two-col">
            <div className="card-split full-row">
              <div className="card-split-col">
                <label>
                  Name:
                  <input value={jobName} onChange={e => setJobName(e.target.value)} />
                </label>
                <label>
                  Type:
                  <select value={jobType} onChange={e => setJobType(e.target.value as BackupJobType)}>
                    <option value="ForwardIncremental">Forward Incr w/ Synth Full</option>
                  </select>
                </label>
                <label>
                  Source (TB):
                  <input type="number" value={sourceDataTB} min={0.1} step={0.1} onChange={e => setSourceDataTB(Number(e.target.value))} className="input-number-compact" />
                </label>
                <label>
                  Retention (d):
                  <input type="number" value={retention} min={1} onChange={e => setRetention(Number(e.target.value))} className="input-number-compact" />
                </label>
              </div>
              <div className="card-split-col">
                <div className="card-split-col-header">
                  GFS Policy (optional)
                </div>
                <label>
                  Weekly:
                  <input
                    type="number"
                    value={gfsWeekly}
                    min={0}
                    onChange={e => {
                      const nextWeekly = normalizeNonNegativeInt(Number(e.target.value));
                      setGfsWeekly(nextWeekly);
                      setForecastYears(prev => syncForecastWithGfs(prev, nextWeekly, gfsMonthly, gfsYearly));
                    }}
                    className="input-number-compact"
                  />
                </label>
                <label>
                  Monthly:
                  <input
                    type="number"
                    value={gfsMonthly}
                    min={0}
                    onChange={e => {
                      const nextMonthly = normalizeNonNegativeInt(Number(e.target.value));
                      setGfsMonthly(nextMonthly);
                      setForecastYears(prev => syncForecastWithGfs(prev, gfsWeekly, nextMonthly, gfsYearly));
                    }}
                    className="input-number-compact"
                  />
                </label>
                <label>
                  Yearly:
                  <input
                    type="number"
                    value={gfsYearly}
                    min={0}
                    onChange={e => {
                      const nextYearly = normalizeNonNegativeInt(Number(e.target.value));
                      setGfsYearly(nextYearly);
                      setForecastYears(prev => syncForecastWithGfs(prev, gfsWeekly, gfsMonthly, nextYearly));
                    }}
                    className="input-number-compact"
                  />
                </label>
              </div>
            </div>
            </div>
          </div>
          <div className="form-card">
            <div className="form-card-header">Repository</div>
            <div className="form-card-body two-col">
            <div className="card-split full-row">
              <div className="card-split-col">
                <label>
                  Name:
                  <input value={repoName} onChange={e => setRepoName(e.target.value)} />
                </label>
                <label>
                  Type:
                  <select value={repoType} onChange={e => setRepoType(e.target.value as RepositoryType)}>
                    <option value="DAS">DAS</option>
                    <option value="SOBR">SOBR</option>
                  </select>
                </label>
                <div className="repo-object-row">
                  <label className="inline-checkbox-label">
                    Use Object Storage
                    <input
                      type="checkbox"
                      checked={isObjectStorage}
                      onChange={e => setIsObjectStorage(e.target.checked)}
                    />
                  </label>
                </div>
              </div>
              <div className="card-split-col">
                <div className="card-split-col-header">
                  Immutability Policy
                </div>
                <label>
                  Primary / Performance immutability (d):
                  <input
                    type="number"
                    value={sobrPerformanceImmutabilityDays}
                    min={0}
                    onChange={e => setSobrPerformanceImmutabilityDays(Number(e.target.value))}
                    className="input-number-compact"
                  />
                </label>
                <label>
                  Capacity immutability (d):
                  <input
                    type="number"
                    value={sobrCapacityImmutabilityDays}
                    min={0}
                    disabled={!supportsTieredImmutability}
                    onChange={e => setSobrCapacityImmutabilityDays(Number(e.target.value))}
                    className={`input-number-compact${supportsTieredImmutability ? '' : ' is-disabled'}`}
                  />
                </label>
                <label>
                  Archive immutability (d):
                  <input
                    type="number"
                    value={sobrArchiveImmutabilityDays}
                    min={0}
                    disabled={!supportsArchiveImmutability}
                    onChange={e => setSobrArchiveImmutabilityDays(Number(e.target.value))}
                    className={`input-number-compact${supportsArchiveImmutability ? '' : ' is-disabled'}`}
                  />
                </label>
                <div className="form-muted-note">
                  {repoType === 'SOBR'
                    ? 'SOBR selected: all tier immutability controls are available based on enabled tiers.'
                    : `${repoType} selected: primary immutability applies; Capacity/Archive controls are disabled.`}
                </div>
                <div className="help-badge-row">
                  <span
                    className="help-badge"
                    title="Primary/Performance immutability delays generation delete eligibility. Capacity and Archive immutability are only applicable when using SOBR tiers."
                    aria-label="Immutability policy notes"
                  >
                    ?
                  </span>
                </div>
              </div>
            </div>
            </div>
          </div>
          {repoType === 'SOBR' && (
            <div className="form-card">
              <div className="form-card-header">SOBR Tier Policy</div>
              <div className="form-card-body two-col">
              <div className="full-row sobr-mode-row">
                <label className="inline-checkbox-label">
                  <input
                    type="checkbox"
                    checked={sobrCopyEnabled}
                    onChange={e => {
                      const checked = e.target.checked;
                      setSobrCopyEnabled(checked);
                      if (!checked && !sobrMoveEnabled) setSobrMoveEnabled(true);
                    }}
                  />
                  Capacity Tier Copy
                </label>
                <label className="inline-checkbox-label">
                  <input
                    type="checkbox"
                    checked={effectiveMoveEnabled}
                    onChange={e => {
                      const checked = e.target.checked;
                      if (!checked && !sobrCopyEnabled) return;
                      setSobrMoveEnabled(checked);
                    }}
                  />
                  Capacity Tier Move
                </label>
              </div>
              <div className="full-row form-muted-note mode-row-note">
                Mode: {effectiveCopyEnabled && effectiveMoveEnabled ? 'Copy + Move' : effectiveCopyEnabled ? 'Copy only' : 'Move only'}
              </div>
              <label>Offload after (d):
                <input type="number" value={sobrOffloadDays} min={1} onChange={e => setSobrOffloadDays(Number(e.target.value))} className="input-number-compact" />
              </label>
              <label>GEN period (d):
                <input type="number" value={sobrGenerationPeriodDays} min={1} onChange={e => setSobrGenerationPeriodDays(Number(e.target.value))} className="input-number-compact" />
              </label>
              <label className="full-row inline-checkbox-label">
                <input type="checkbox" checked={sobrHasArchive} onChange={e => setSobrHasArchive(e.target.checked)} />
                Enable Archive Tier
              </label>
              {sobrHasArchive && (
                <>
                  <label>Archive after (d):
                    <input type="number" value={sobrArchiveDays} min={1} onChange={e => setSobrArchiveDays(Number(e.target.value))} className="input-number-compact" />
                  </label>
                </>
              )}
              <div className="full-row help-badge-row">
                <span
                  className="help-badge"
                  title="GEN period defines fixed object-generation windows (default 10 days). Performance immutability delays move/prune eligibility for sealed chains. Capacity and Archive immutability extend how long a GEN must stay before delete is allowed after DeleteOn is reached."
                  aria-label="GEN timing notes"
                >
                  ?
                </span>
              </div>
              </div>
            </div>
          )}
          <div className="scenario-actions-row">
            <button type="submit" className="apply-btn">Simulate</button>
            <button
              type="button"
              className="reset-btn"
              onClick={onReset}
              title="Reset all inputs and simulation to defaults"
            >
              Reset
            </button>
          </div>
        </form>

        {/* ── Right column: calculated capacity requirements ── */}
        <div className="scenario-column requirements-panel">
          <div className="requirements-title-row">
            📐 Calculated Capacity Requirements
            <span
              className="help-badge"
              title={`Annual view with ${annualGrowthRate}% growth. Working space uses the Veeam tiered scale on initial source size. ${appliedForecastYear > 5 ? `Years 1-4 plus year ${appliedForecastYear} are shown.` : `Years 1-${displayedYearCount} are shown.`} ★ marks the applied forecast year.`}
              aria-label="Capacity assumptions"
            >
              ?
            </span>
          </div>

          <div className="requirements-table-wrap">
            <table className="requirements-table">
              <thead>
                <tr>
                  <th className="req-th req-th-metric">Metric</th>
                  {yearColumns.map(year => (
                    <th key={`year-col-${year}`} className={`req-th req-th-year${year === appliedForecastYear ? ' applied' : ''}`}>
                      Year {year}{year === appliedForecastYear ? ' ★' : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="req-td req-label">Peak Source Data</td>
                  {yearlyRequirements.map(row => (
                    <td key={`peak-${row.year}`} className="req-td req-value req-value-primary">{fmtTB(row.peakSourceTB)}</td>
                  ))}
                </tr>
                <tr>
                  <td className="req-td req-label">Full Backup Size</td>
                  {yearlyRequirements.map(row => (
                    <td key={`full-${row.year}`} className="req-td req-value req-value-primary">{fmtTB(row.fullBackupTB)}</td>
                  ))}
                </tr>
                <tr>
                  <td className="req-td req-label">Daily Incremental</td>
                  {yearlyRequirements.map(row => (
                    <td key={`incr-${row.year}`} className="req-td req-value req-value-primary">{fmtTB(row.incrementalTB)}</td>
                  ))}
                </tr>
                <tr>
                  <td className="req-td req-label">
                    Working Space (tiered){' '}
                    <span
                      className="help-badge"
                      title="Working Space uses the Veeam progressive tiered scale on initial source TB (<10 x1.05, 10-20 x0.66, 20-100 x0.40, 100-500 x0.25, >500 x0.10, then x50% compression). Planned Capacity includes working space. SOBR tier rows are planning recommendations, not live utilization."
                      aria-label="Working-space details"
                    >
                      ?
                    </span>
                  </td>
                  {yearlyRequirements.map(row => (
                    <td key={`working-space-needed-${row.year}`} className="req-td req-value req-value-primary">{fmtTB(row.workingSpaceNeededTB)}</td>
                  ))}
                </tr>
                {gfsForecastStats.distinctPoints > 0 && (
                  <tr>
                    <td className="req-td req-label">
                      GFS Total Storage ({gfsForecastStats.distinctPoints} pts)
                    </td>
                    {yearlyRequirements.map(row => (
                      <td key={`gfs-${row.year}`} className="req-td req-value req-value-primary">{fmtTB(row.gfsTB)}</td>
                    ))}
                  </tr>
                )}
                {repoType !== 'SOBR' ? (
                  <>
                    <tr>
                      <td className="req-td req-label req-label-strong">Projected Used (No Working Space)</td>
                      {yearlyRequirements.map(row => (
                        <td key={`repo-used-${row.year}`} className="req-td req-value req-value-strong">{fmtTB(row.repoUsedTB)}</td>
                      ))}
                    </tr>
                    <tr>
                      <td className="req-td req-label req-label-strong req-last-row">Planned Capacity (Includes Working Space)</td>
                      {yearlyRequirements.map(row => (
                        <td key={`repo-total-${row.year}`} className="req-td req-value req-value-total req-last-row">{fmtTB(row.repoTotalTB)}</td>
                      ))}
                    </tr>
                  </>
                ) : (
                  <>
                    <tr>
                      <td className="req-td req-label req-label-strong">Projected SOBR Used (No Working Space)</td>
                      {yearlyRequirements.map(row => (
                        <td key={`sobr-used-${row.year}`} className="req-td req-value req-value-strong">{fmtTB(row.sobrUsedTB)}</td>
                      ))}
                    </tr>
                    <tr>
                      <td className="req-td req-label req-tier-performance">Planned Performance Tier Capacity</td>
                      {yearlyRequirements.map(row => (
                        <td key={`perf-${row.year}`} className="req-td req-value req-tier-performance">{fmtTB(row.perfTB)}</td>
                      ))}
                    </tr>
                    <tr>
                      <td className="req-td req-label req-tier-capacity">Planned Capacity Tier Capacity</td>
                      {yearlyRequirements.map(row => (
                        <td key={`cap-${row.year}`} className="req-td req-value req-tier-capacity">{fmtTB(row.capTB)}</td>
                      ))}
                    </tr>
                    {sobrHasArchive && (
                      <tr>
                        <td className="req-td req-label req-tier-archive">Planned Archive Tier Capacity</td>
                        {yearlyRequirements.map(row => (
                          <td key={`arch-${row.year}`} className="req-td req-value req-tier-archive">{fmtTB(row.archTB)}</td>
                        ))}
                      </tr>
                    )}
                    <tr>
                      <td className="req-td req-label req-label-strong req-last-row">Planned SOBR Capacity (Includes Working Space)</td>
                      {yearlyRequirements.map(row => (
                        <td key={`sobr-total-${row.year}`} className="req-td req-value req-value-total req-last-row">{fmtTB(row.sobrTotalTB)}</td>
                      ))}
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          </div>

          {repoType === 'SOBR' && !effectiveCopyEnabled && effectiveMoveEnabled && (
            <div className="move-only-note-row">
              <span
                className="help-badge move-only"
                title="Move-only lifecycle assumption: sealed chains offload when newest point age reaches the offload threshold, then remain in Capacity until a newer chain exists and the oldest point reaches retention. This increases planned Capacity versus the older simplified window model."
                aria-label="Move-only lifecycle note"
              >
                ?
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

