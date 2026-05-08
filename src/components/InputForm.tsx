import React, { useState } from 'react';
import { computeForecastGfsStatsAtYear } from '../models/gfsSizing';
import { SimulationState, BackupJobType, RepositoryType, computeVeeamWorkingSpaceTB } from '../models/veeam';

interface InputFormProps {
  simState: SimulationState;
  onScenarioChange: (newState: SimulationState) => void;
}

export const InputForm: React.FC<InputFormProps> = ({ simState, onScenarioChange }) => {
  const [repoName, setRepoName] = useState(simState.repositories[0]?.name || 'Main Repo');
  const [repoType, setRepoType] = useState<RepositoryType>(simState.repositories[0]?.type || 'DAS');
  const [jobName, setJobName] = useState(simState.jobs[0]?.name || 'Daily Backup');
  const [jobType, setJobType] = useState<BackupJobType>(simState.jobs[0]?.type || 'ForwardIncremental');
  const [sourceDataTB, setSourceDataTB] = useState(simState.jobs[0]?.sourceDataTB || 2);
  const [dailyChangeRate, setDailyChangeRate] = useState(simState.jobs[0]?.dailyChangeRatePct ?? 5);
  const [annualGrowthRate, setAnnualGrowthRate] = useState(simState.jobs[0]?.annualGrowthRatePct ?? 10);
  const [forecastYears, setForecastYears] = useState(simState.jobs[0]?.forecastYears ?? 3);
  const [retention, setRetention] = useState(simState.jobs[0]?.retention.restorePoints || 30);
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
  const [sobrPerformanceImmutabilityDays, setSobrPerformanceImmutabilityDays] = useState(existingSobr?.performanceImmutabilityDays ?? existingRepo?.immutabilityDays ?? 7);
  const [sobrCapacityImmutabilityDays, setSobrCapacityImmutabilityDays] = useState(existingSobr?.capacityImmutabilityDays ?? 0);
  const [sobrArchiveImmutabilityDays, setSobrArchiveImmutabilityDays] = useState(existingSobr?.archiveImmutabilityDays ?? 0);
  const [sobrHasArchive, setSobrHasArchive] = useState(existingSobr?.hasArchiveTier ?? false);
  const [sobrCopyEnabled, setSobrCopyEnabled] = useState(existingSobr?.copyEnabled ?? false);
  const [sobrMoveEnabled, setSobrMoveEnabled] = useState(existingSobr?.moveEnabled ?? true);
  const effectiveCopyEnabled = sobrCopyEnabled;
  const effectiveMoveEnabled = sobrMoveEnabled || !sobrCopyEnabled;
  const supportsTieredImmutability = repoType === 'SOBR';
  const supportsArchiveImmutability = repoType === 'SOBR' && sobrHasArchive;

  const compactNumberInputStyle: React.CSSProperties = {
    width: '84px',
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
  };

  const tooltipHintStyle: React.CSSProperties = {
    cursor: 'help',
    borderBottom: '1px dotted #607d8b',
    color: '#455a64',
    fontSize: '0.74rem',
  };

  const tooltipBadgeStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    borderRadius: '50%',
    background: '#e3f2fd',
    border: '1px solid #90caf9',
    color: '#1565c0',
    fontSize: '0.7rem',
    fontWeight: 700,
    lineHeight: 1,
    cursor: 'help',
  };

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

  const computeMoveLifecycleWindows = (elapsedDays: number, retentionDays: number, offloadDays: number) => {
    const moveGateDays = offloadDays + sobrPerformanceImmutabilityDays;
    const generationAlignedGateDays = Math.ceil(moveGateDays / Math.max(1, sobrGenerationPeriodDays)) * sobrGenerationPeriodDays;
    // Performance pruning can only happen after move gate and next-chain sequencing.
    const performanceWindowDays = Math.max(fullIntervalDays, generationAlignedGateDays + fullIntervalDays);
    // Capacity accumulates GENs that passed move gate but are still before DeleteOn.
    const capacityAccumulationDays = Math.max(0, elapsedDays - generationAlignedGateDays + 1);
    return {
      performanceWindowDays,
      capacityAccumulationDays,
    };
  };

  // ── Calculated capacity requirements (derived from scenario inputs) ───────────
  const peakSourceTB = sourceDataTB * Math.pow(1 + annualGrowthRate / 100, forecastYears);
  const fullSizeTB = peakSourceTB * 0.5;               // ~50% compression ratio
  const incrSizeTB = peakSourceTB * (dailyChangeRate / 100) * 0.5;
  const fullIntervalDays = (jobType === 'SyntheticFull' || jobType === 'ForwardIncremental') ? 7 : retention;
  const gfsForecastStats = computeGfsStatsAtYear(Math.max(0, forecastYears));

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

  const clampedForecast = Math.max(1, Math.floor(forecastYears || 1));
  // Always show min 3, max 5 columns. When forecast > 5, the last column is the actual
  // forecast year so the totals always match what Apply will set.
  const visibleYears = Math.min(5, Math.max(3, clampedForecast));
  const yearColumns: number[] = clampedForecast > 5
    ? [1, 2, 3, 4, clampedForecast]
    : Array.from({ length: visibleYears }, (_, i) => i + 1);

  const computeYearlyRequirements = (year: number) => {
    const yearSourceTB = sourceDataTB * Math.pow(1 + annualGrowthRate / 100, year);
    const yearFullSizeTB = yearSourceTB * 0.5;
    const yearIncrSizeTB = yearSourceTB * (dailyChangeRate / 100) * 0.5;
    // Working space uses the Veeam progressive bracket scale on raw source data only.
    // No daily change rate or growth factor — confirmed from Veeam Calculator source.
    const wsInputTB = sourceDataTB;
    const yearWorkingSpaceReserveTB = computeVeeamWorkingSpaceTB(wsInputTB);
    const yearGfsStats = computeGfsStatsAtYear(year);

    const estimateTierChainDataForYearTB = (windowDays: number) => {
      if (windowDays <= 0) return 0;
      const chainsInWindow = Math.max(1, Math.ceil(windowDays / Math.max(1, fullIntervalDays)));
      // EXACT VEEAM MODEL: One promoted full (oldest SyntheticFull = base) +
      // (chainsInWindow * fullIntervalDays - 1) incrementals.
      // The active chain being built = working space, NOT stored data.
      // DO NOT add an extra chain interval here — that double-counts working space.
      const effectiveDays = chainsInWindow * fullIntervalDays - 1;
      return yearFullSizeTB + effectiveDays * yearIncrSizeTB;
    };

    const yearGfsTB = yearGfsStats.additionalFullTB;
    const yearActiveChainTB = estimateTierChainDataForYearTB(retention);

    if (repoType !== 'SOBR') {
      const yearRepoUsedTB = yearActiveChainTB + yearGfsTB;
      const yearRepoTB = yearRepoUsedTB + yearWorkingSpaceReserveTB;
      return {
        peakSourceTB: yearSourceTB,
        fullBackupTB: yearFullSizeTB,
        incrementalTB: yearIncrSizeTB,
        workingSpaceNeededTB: yearWorkingSpaceReserveTB,
        workingSpaceAdditionalTB: yearWorkingSpaceReserveTB,
        gfsTB: yearGfsTB,
        repoUsedTB: yearRepoUsedTB,
        repoTotalTB: yearRepoTB,
        perfTB: 0,
        capTB: 0,
        archTB: 0,
        sobrUsedTB: 0,
        sobrTotalTB: 0,
      };
    }

    let yearPerfUsedTB = 0;
    let yearCapUsedTB = 0;
    let yearArchUsedTB = 0;

    if (effectiveCopyEnabled && effectiveMoveEnabled) {
      // Copy+Move: data lives in Perf until explicitly moved, so size for full retention window.
      yearPerfUsedTB = estimateTierChainDataForYearTB(retention) + yearGfsStats.additionalPerfFullTB;
      yearCapUsedTB = yearActiveChainTB + yearGfsStats.additionalCapFullTB;
      if (sobrHasArchive) {
        yearArchUsedTB = yearGfsStats.additionalArchFullTB;
      }
    } else if (effectiveCopyEnabled) {
      yearPerfUsedTB = yearActiveChainTB + yearGfsStats.additionalPerfFullTB;
      yearCapUsedTB = yearActiveChainTB + yearGfsStats.additionalCapFullTB;
      if (sobrHasArchive) {
        yearArchUsedTB = yearGfsStats.additionalArchFullTB;
      }
    } else {
      const elapsedDays = year * 365;
      const windows = computeMoveLifecycleWindows(elapsedDays, retention, sobrOffloadDays);
      yearPerfUsedTB = estimateTierChainDataForYearTB(windows.performanceWindowDays) + yearGfsStats.additionalPerfFullTB;
      yearCapUsedTB = estimateTierChainDataForYearTB(windows.capacityAccumulationDays) + yearGfsStats.additionalCapFullTB;

      if (sobrHasArchive) {
        yearArchUsedTB = yearGfsStats.additionalArchFullTB;
      }
    }

    const yearPerfTB = yearPerfUsedTB + yearWorkingSpaceReserveTB;
    const yearCapTB = yearCapUsedTB;
    const yearArchTB = yearArchUsedTB;
    const yearSobrUsedTB = yearPerfUsedTB + yearCapUsedTB + (sobrHasArchive ? yearArchUsedTB : 0);

    return {
      peakSourceTB: yearSourceTB,
      fullBackupTB: yearFullSizeTB,
      incrementalTB: yearIncrSizeTB,
      workingSpaceNeededTB: yearWorkingSpaceReserveTB,
      workingSpaceAdditionalTB: yearWorkingSpaceReserveTB,
      gfsTB: yearGfsTB,
      repoUsedTB: 0,
      repoTotalTB: 0,
      perfTB: yearPerfTB,
      capTB: yearCapTB,
      archTB: yearArchTB,
      sobrUsedTB: yearSobrUsedTB,
      sobrTotalTB: yearSobrUsedTB + yearWorkingSpaceReserveTB,
    };
  };

  const yearlyRequirements = yearColumns.map(y => ({ year: y, ...computeYearlyRequirements(y) }));
  const appliedRequirements = computeYearlyRequirements(clampedForecast);

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
          forecastYears,
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
      <h2 style={{ margin: '0 0 1rem 0', fontSize: '1.15rem', fontWeight: 700, color: '#1a237e', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <span style={{ display: 'inline-block', width: '4px', height: '20px', background: '#1a237e', borderRadius: '2px', flexShrink: 0 }} />
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
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ width: '150px' }} />
            </label>
            <label>
              Forecast (y):
              <input type="number" value={forecastYears} min={1} max={10} step={1} onChange={e => setForecastYears(Number(e.target.value))} style={compactNumberInputStyle} />
            </label>
            <label>
              Daily Change (%):
              <input type="number" value={dailyChangeRate} min={0.1} max={100} step={0.1} onChange={e => setDailyChangeRate(Number(e.target.value))} style={compactNumberInputStyle} />
            </label>
            <label>
              Annual Growth (%):
              <input type="number" value={annualGrowthRate} min={0} max={100} step={1} onChange={e => setAnnualGrowthRate(Number(e.target.value))} style={compactNumberInputStyle} />
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
                    <option value="ForwardIncremental">Forward Incremental</option>
                    <option value="ReverseIncremental">Reverse Incremental</option>
                    <option value="SyntheticFull">Synthetic Full</option>
                    <option value="ActiveFull">Active Full</option>
                    <option value="GFS">GFS</option>
                  </select>
                </label>
                <label>
                  Source (TB):
                  <input type="number" value={sourceDataTB} min={0.1} step={0.1} onChange={e => setSourceDataTB(Number(e.target.value))} style={compactNumberInputStyle} />
                </label>
                <label>
                  Retention (d):
                  <input type="number" value={retention} min={1} onChange={e => setRetention(Number(e.target.value))} style={compactNumberInputStyle} />
                </label>
              </div>
              <div className="card-split-col">
                <div className="card-split-col-header">
                  GFS Policy (optional)
                </div>
                <label>
                  Weekly:
                  <input type="number" value={gfsWeekly} min={0} onChange={e => setGfsWeekly(Number(e.target.value))} style={compactNumberInputStyle} />
                </label>
                <label>
                  Monthly:
                  <input type="number" value={gfsMonthly} min={0} onChange={e => setGfsMonthly(Number(e.target.value))} style={compactNumberInputStyle} />
                </label>
                <label>
                  Yearly:
                  <input type="number" value={gfsYearly} min={0} onChange={e => setGfsYearly(Number(e.target.value))} style={compactNumberInputStyle} />
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
                    <option value="NAS">NAS</option>
                    <option value="DedupAppliance">Dedup Appliance</option>
                    <option value="ObjectStorage">Object Storage</option>
                    <option value="Tape">Tape</option>
                    <option value="SOBR">SOBR</option>
                  </select>
                </label>
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
                    style={compactNumberInputStyle}
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
                    style={{ ...compactNumberInputStyle, opacity: supportsTieredImmutability ? 1 : 0.55 }}
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
                    style={{ ...compactNumberInputStyle, opacity: supportsArchiveImmutability ? 1 : 0.55 }}
                  />
                </label>
                <div style={{ fontSize: '0.76rem', color: '#666', marginTop: '0.45rem' }}>
                  {repoType === 'SOBR'
                    ? 'SOBR selected: all tier immutability controls are available based on enabled tiers.'
                    : `${repoType} selected: primary immutability applies; Capacity/Archive controls are disabled.`}
                </div>
                <div style={{ marginTop: '0.45rem' }}>
                  <span
                    style={tooltipBadgeStyle}
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
              <div className="full-row" style={{ display: 'flex', gap: '1rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
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
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
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
              <div className="full-row" style={{ fontSize: '0.76rem', color: '#666', marginBottom: '0.55rem' }}>
                Mode: {effectiveCopyEnabled && effectiveMoveEnabled ? 'Copy + Move' : effectiveCopyEnabled ? 'Copy only' : 'Move only'}
              </div>
              <label>Offload after (d):
                <input type="number" value={sobrOffloadDays} min={1} onChange={e => setSobrOffloadDays(Number(e.target.value))} style={compactNumberInputStyle} />
              </label>
              <label>GEN period (d):
                <input type="number" value={sobrGenerationPeriodDays} min={1} onChange={e => setSobrGenerationPeriodDays(Number(e.target.value))} style={compactNumberInputStyle} />
              </label>
              <label className="full-row" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'flex-start' }}>
                <input type="checkbox" checked={sobrHasArchive} onChange={e => setSobrHasArchive(e.target.checked)} />
                Enable Archive Tier
              </label>
              {sobrHasArchive && (
                <>
                  <label>Archive after (d):
                    <input type="number" value={sobrArchiveDays} min={1} onChange={e => setSobrArchiveDays(Number(e.target.value))} style={compactNumberInputStyle} />
                  </label>
                </>
              )}
              <div className="full-row" style={{ marginTop: '0.55rem' }}>
                <span
                  style={tooltipBadgeStyle}
                  title="GEN period defines fixed object-generation windows (default 10 days). Performance immutability delays move/prune eligibility for sealed chains. Capacity and Archive immutability extend how long a GEN must stay before delete is allowed after DeleteOn is reached."
                  aria-label="GEN timing notes"
                >
                  ?
                </span>
              </div>
              </div>
            </div>
          )}
          <button type="submit" className="apply-btn">Simulate</button>
        </form>

        {/* ── Right column: calculated capacity requirements ── */}
        <div className="scenario-column" style={{
          background: '#f0f4ff', border: '1px solid #c5cae9',
          borderRadius: '6px', padding: '1rem',
          alignSelf: 'flex-start', position: 'sticky', top: '1rem',
        }}>
          <div style={{ fontWeight: 'bold', fontSize: '0.95rem', marginBottom: '0.6rem', color: '#1a237e', display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
            📐 Calculated Capacity Requirements
            <span
              style={tooltipBadgeStyle}
              title={`Annual view with ${annualGrowthRate}% growth. Working space uses the Veeam progressive bracket scale on WS input = grown source x (1 + daily change) (<10 x1.05, 10-20 x0.66, 20-100 x0.40, 100-500 x0.25, >500 x0.10, then x50% compression). ${clampedForecast > 5 ? `Years 1-4 plus year ${clampedForecast} are shown.` : `Years 1-${visibleYears} are shown.`} ★ marks the applied forecast year.`}
              aria-label="Capacity assumptions"
            >
              ?
            </span>
          </div>

          <div style={{ overflowX: 'auto', paddingBottom: '0.2rem' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: `${160 + (visibleYears * 115)}px`, fontSize: '0.82rem' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #c5cae9', color: '#1a237e' }}>Metric</th>
                  {yearColumns.map(year => (
                    <th key={`year-col-${year}`} style={{ textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid #c5cae9', color: year === clampedForecast ? '#b71c1c' : '#1a237e', whiteSpace: 'nowrap', fontWeight: year === clampedForecast ? 'bold' : undefined }}>
                      Year {year}{year === clampedForecast ? ' ★' : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid #e8eaf6', color: '#555' }}>Peak Source Data</td>
                  {yearlyRequirements.map(row => (
                    <td key={`peak-${row.year}`} style={{ padding: '6px 8px', borderBottom: '1px solid #e8eaf6', textAlign: 'right', fontFamily: 'monospace', color: '#1a237e', fontWeight: 'bold' }}>{fmtTB(row.peakSourceTB)}</td>
                  ))}
                </tr>
                <tr>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid #e8eaf6', color: '#555' }}>Full Backup Size</td>
                  {yearlyRequirements.map(row => (
                    <td key={`full-${row.year}`} style={{ padding: '6px 8px', borderBottom: '1px solid #e8eaf6', textAlign: 'right', fontFamily: 'monospace', color: '#1a237e', fontWeight: 'bold' }}>{fmtTB(row.fullBackupTB)}</td>
                  ))}
                </tr>
                <tr>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid #e8eaf6', color: '#555' }}>Daily Incremental</td>
                  {yearlyRequirements.map(row => (
                    <td key={`incr-${row.year}`} style={{ padding: '6px 8px', borderBottom: '1px solid #e8eaf6', textAlign: 'right', fontFamily: 'monospace', color: '#1a237e', fontWeight: 'bold' }}>{fmtTB(row.incrementalTB)}</td>
                  ))}
                </tr>
                <tr>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid #e8eaf6', color: '#555' }}>
                    Working Space (tiered){' '}
                    <span
                      style={tooltipBadgeStyle}
                      title="Working Space uses the Veeam progressive bracket scale on WS input = grown source x (1 + daily change) (<10 x1.05, 10-20 x0.66, 20-100 x0.40, 100-500 x0.25, >500 x0.10, then x50% compression). Planned Capacity includes working space. SOBR tier rows are planning recommendations, not live utilization."
                      aria-label="Working-space details"
                    >
                      ?
                    </span>
                  </td>
                  {yearlyRequirements.map(row => (
                    <td key={`working-space-needed-${row.year}`} style={{ padding: '6px 8px', borderBottom: '1px solid #e8eaf6', textAlign: 'right', fontFamily: 'monospace', color: '#1a237e', fontWeight: 'bold' }}>{fmtTB(row.workingSpaceNeededTB)}</td>
                  ))}
                </tr>
                {gfsForecastStats.distinctPoints > 0 && (
                  <tr>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid #e8eaf6', color: '#555' }}>
                      GFS Total Storage ({gfsForecastStats.distinctPoints} pts)
                    </td>
                    {yearlyRequirements.map(row => (
                      <td key={`gfs-${row.year}`} style={{ padding: '6px 8px', borderBottom: '1px solid #e8eaf6', textAlign: 'right', fontFamily: 'monospace', color: '#1a237e', fontWeight: 'bold' }}>{fmtTB(row.gfsTB)}</td>
                    ))}
                  </tr>
                )}
                {repoType !== 'SOBR' ? (
                  <>
                    <tr>
                      <td style={{ padding: '7px 8px', borderBottom: '1px solid #e8eaf6', color: '#555', fontWeight: 'bold' }}>Projected Used (No Working Space)</td>
                      {yearlyRequirements.map(row => (
                        <td key={`repo-used-${row.year}`} style={{ padding: '7px 8px', borderBottom: '1px solid #e8eaf6', textAlign: 'right', fontFamily: 'monospace', color: '#555', fontWeight: 'bold' }}>{fmtTB(row.repoUsedTB)}</td>
                      ))}
                    </tr>
                    <tr>
                      <td style={{ padding: '7px 8px', borderBottom: '1px solid #c5cae9', color: '#555', fontWeight: 'bold' }}>Planned Capacity (Includes Working Space)</td>
                      {yearlyRequirements.map(row => (
                        <td key={`repo-total-${row.year}`} style={{ padding: '7px 8px', borderBottom: '1px solid #c5cae9', textAlign: 'right', fontFamily: 'monospace', color: '#b71c1c', fontWeight: 'bold' }}>{fmtTB(row.repoTotalTB)}</td>
                      ))}
                    </tr>
                  </>
                ) : (
                  <>
                    <tr>
                      <td style={{ padding: '7px 8px', borderBottom: '1px solid #e8eaf6', color: '#555', fontWeight: 'bold' }}>Projected SOBR Used (No Working Space)</td>
                      {yearlyRequirements.map(row => (
                        <td key={`sobr-used-${row.year}`} style={{ padding: '7px 8px', borderBottom: '1px solid #e8eaf6', textAlign: 'right', fontFamily: 'monospace', color: '#555', fontWeight: 'bold' }}>{fmtTB(row.sobrUsedTB)}</td>
                      ))}
                    </tr>
                    <tr>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #e8eaf6', color: '#1976d2' }}>Planned Performance Tier Capacity</td>
                      {yearlyRequirements.map(row => (
                        <td key={`perf-${row.year}`} style={{ padding: '6px 8px', borderBottom: '1px solid #e8eaf6', textAlign: 'right', fontFamily: 'monospace', color: '#1976d2', fontWeight: 'bold' }}>{fmtTB(row.perfTB)}</td>
                      ))}
                    </tr>
                    <tr>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #e8eaf6', color: '#388e3c' }}>Planned Capacity Tier Capacity</td>
                      {yearlyRequirements.map(row => (
                        <td key={`cap-${row.year}`} style={{ padding: '6px 8px', borderBottom: '1px solid #e8eaf6', textAlign: 'right', fontFamily: 'monospace', color: '#388e3c', fontWeight: 'bold' }}>{fmtTB(row.capTB)}</td>
                      ))}
                    </tr>
                    {sobrHasArchive && (
                      <tr>
                        <td style={{ padding: '6px 8px', borderBottom: '1px solid #e8eaf6', color: '#7b1fa2' }}>Planned Archive Tier Capacity</td>
                        {yearlyRequirements.map(row => (
                          <td key={`arch-${row.year}`} style={{ padding: '6px 8px', borderBottom: '1px solid #e8eaf6', textAlign: 'right', fontFamily: 'monospace', color: '#7b1fa2', fontWeight: 'bold' }}>{fmtTB(row.archTB)}</td>
                        ))}
                      </tr>
                    )}
                    <tr>
                      <td style={{ padding: '7px 8px', borderBottom: '1px solid #c5cae9', color: '#555', fontWeight: 'bold' }}>Planned SOBR Capacity (Includes Working Space)</td>
                      {yearlyRequirements.map(row => (
                        <td key={`sobr-total-${row.year}`} style={{ padding: '7px 8px', borderBottom: '1px solid #c5cae9', textAlign: 'right', fontFamily: 'monospace', color: '#b71c1c', fontWeight: 'bold' }}>{fmtTB(row.sobrTotalTB)}</td>
                      ))}
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          </div>

          {repoType === 'SOBR' && !effectiveCopyEnabled && effectiveMoveEnabled && (
            <div style={{ marginTop: '0.55rem' }}>
              <span
                style={{ ...tooltipBadgeStyle, background: '#fff3e0', border: '1px solid #ffcc80', color: '#5d4037' }}
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

