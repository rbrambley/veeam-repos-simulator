import { VeeamSimulator } from '../simulator/engine.ts';
import { computeForecastGfsStatsAtYear } from '../models/gfsSizing.ts';
import { computeGfsStoredContributionTB } from '../models/gfsSizing.ts';
import { computeSimulatorPlanned } from '../models/plannedCapacityCalculator.ts';
import { computeVeeamWorkingSpaceTB } from '../models/veeam.ts';
import type { BackupChain, BackupJob, Repository, SimulationState, SOBRConfig } from '../models/veeam.ts';

type ScenarioConfig = {
  id: string;
  startDate: string;
  totalDays: number;
  sourceDataTB: number;
  dailyChangeRatePct: number;
  annualGrowthRatePct: number;
  retention: number;
  gfsPolicy: { weekly: number; monthly: number; yearly: number };
  offloadAfterDays: number;
  archiveAfterDays: number;
  hasArchiveTier: boolean;
  copyEnabled: boolean;
  moveEnabled: boolean;
  generationPeriodDays: number;
  performanceImmutabilityDays: number;
  capacityImmutabilityDays: number;
  archiveImmutabilityDays: number;
};

const TARGET_SCENARIOS: ScenarioConfig[] = [
  {
    id: 'ix-gfs-wmy-move-archive',
    startDate: '2026-05-02',
    totalDays: 1095,
    sourceDataTB: 1,
    dailyChangeRatePct: 5,
    annualGrowthRatePct: 0,
    retention: 60,
    gfsPolicy: { weekly: 4, monthly: 3, yearly: 2 },
    offloadAfterDays: 14,
    archiveAfterDays: 30,
    hasArchiveTier: true,
    copyEnabled: false,
    moveEnabled: true,
    generationPeriodDays: 10,
    performanceImmutabilityDays: 0,
    capacityImmutabilityDays: 0,
    archiveImmutabilityDays: 0,
  },
  {
    id: 'ix-retention-variant-r60',
    startDate: '2026-05-02',
    totalDays: 1095,
    sourceDataTB: 1,
    dailyChangeRatePct: 5,
    annualGrowthRatePct: 0,
    retention: 60,
    gfsPolicy: { weekly: 4, monthly: 3, yearly: 2 },
    offloadAfterDays: 14,
    archiveAfterDays: 30,
    hasArchiveTier: true,
    copyEnabled: false,
    moveEnabled: true,
    generationPeriodDays: 10,
    performanceImmutabilityDays: 7,
    capacityImmutabilityDays: 0,
    archiveImmutabilityDays: 0,
  },
];

function createInitialState(config: ScenarioConfig): SimulationState {
  const repoId = 'repo-1';
  const jobId = `job-${config.id}`;

  const sobrConfig: SOBRConfig = {
    performanceCapacityTB: 50,
    capacityCapacityTB: 200,
    archiveCapacityTB: 500,
    offloadAfterDays: config.offloadAfterDays,
    archiveAfterDays: config.archiveAfterDays,
    generationPeriodDays: config.generationPeriodDays,
    performanceImmutabilityDays: config.performanceImmutabilityDays,
    capacityImmutabilityDays: config.capacityImmutabilityDays,
    archiveImmutabilityDays: config.archiveImmutabilityDays,
    hasArchiveTier: config.hasArchiveTier,
    copyEnabled: config.copyEnabled,
    moveEnabled: config.moveEnabled,
  };

  const repository: Repository = {
    id: repoId,
    name: `Repo ${config.id}`,
    type: 'SOBR',
    capacityTB: 1000,
    sobrConfig,
  };

  const job: BackupJob = {
    id: jobId,
    name: `Job ${config.id}`,
    type: 'ForwardIncremental',
    repositoryId: repoId,
    sourceDataTB: config.sourceDataTB,
    dailyChangeRatePct: config.dailyChangeRatePct,
    annualGrowthRatePct: config.annualGrowthRatePct,
    forecastYears: 3,
    schedule: {
      frequency: 'Daily',
      timeOfDay: '02:00',
      syntheticFullDay: 6,
    },
    retention: {
      restorePoints: config.retention,
      slaDays: config.retention,
    },
    gfsPolicy: config.gfsPolicy,
  };

  const chain: BackupChain = {
    id: `chain-${config.id}`,
    jobId,
    status: 'Active',
    restorePoints: [],
  };

  return {
    repositories: [repository],
    jobs: [job],
    chains: [chain],
    generations: [],
    restorePoints: [],
    blocks: [],
    date: config.startDate,
    startDate: config.startDate,
  };
}

function diffDays(laterIso: string, earlierIso: string): number {
  const later = new Date(`${laterIso}T00:00:00.000Z`).getTime();
  const earlier = new Date(`${earlierIso}T00:00:00.000Z`).getTime();
  return Math.floor((later - earlier) / 86400000);
}

function format(n: number): string {
  return n.toFixed(3);
}

function classifyForecastTier(params: {
  ageDays: number;
  hasWeekly: boolean;
  hasMonthly: boolean;
  hasYearly: boolean;
  offloadAfterDays: number;
  archiveAfterDays: number;
  weeklyPolicy: number;
  yearlyPolicy: number;
  hasArchiveTier: boolean;
}): 'Performance' | 'Capacity' | 'Archive' {
  const routeMonthlyToCap = params.hasArchiveTier && params.hasMonthly && params.yearlyPolicy > 0;
  const routeWeeklyOnlyArchiveToCap = params.hasArchiveTier
    && params.hasWeekly
    && !params.hasMonthly
    && !params.hasYearly
    && (params.offloadAfterDays >= 14 || params.weeklyPolicy <= 2);

  if (params.ageDays < params.offloadAfterDays) {
    return routeMonthlyToCap || routeWeeklyOnlyArchiveToCap ? 'Capacity' : 'Performance';
  }
  if (params.hasArchiveTier && params.ageDays >= (params.offloadAfterDays + params.archiveAfterDays)) {
    return 'Archive';
  }
  return 'Capacity';
}

function investigateScenario(config: ScenarioConfig): void {
  const sim = new VeeamSimulator(createInitialState(config));

  for (let day = 0; day < config.totalDays; day += 1) {
    sim.nextDay();
  }

  const horizonDate = sim.state.date;
  const horizonOffsetYears = diffDays(horizonDate, config.startDate) / 365;

  const forecastStats = computeForecastGfsStatsAtYear({
    sourceDataTB: config.sourceDataTB,
    annualGrowthRatePct: config.annualGrowthRatePct,
    dailyChangeRatePct: config.dailyChangeRatePct,
    retentionDays: config.retention,
    gfsPolicy: config.gfsPolicy,
    startDate: config.startDate,
    yearOffset: horizonOffsetYears,
    copyEnabled: config.copyEnabled,
    effectiveMoveEnabled: config.moveEnabled || !config.copyEnabled,
    offloadAfterDays: config.offloadAfterDays,
    archiveAfterDays: config.archiveAfterDays,
    hasArchiveTier: config.hasArchiveTier,
    sizingMode: 'reverse',
  });

  const gfsPoints = sim.state.restorePoints
    .filter((rp) => !!rp.isGFS)
    .sort((a, b) => a.date.localeCompare(b.date));
  const nonGfsPoints = sim.state.restorePoints
    .filter((rp) => !rp.isGFS)
    .sort((a, b) => a.date.localeCompare(b.date));

  let enginePerfTB = 0;
  let engineCapTB = 0;
  let engineArchTB = 0;
  let enginePerfTotalTB = 0;
  let engineCapTotalTB = 0;
  let engineArchTotalTB = 0;

  let forecastPerfClassified = 0;
  let forecastCapClassified = 0;
  let forecastArchClassified = 0;

  const mismatches: Array<{
    id: string;
    date: string;
    tags: string;
    ageDays: number;
    capEntry: string;
    capAgeDays: number;
    engineTier: string;
    forecastTier: string;
  }> = [];
  const archiveAgeBasisRows: Array<{
    id: string;
    date: string;
    pointAge: number;
    capAge: number;
    byPointAgeTB: number;
    byCapAgeTB: number;
  }> = [];

  for (const rp of gfsPoints) {
    if (rp.hasPerformanceData) {
      enginePerfTB += sim.getRestorePointSizeForTier(rp.id, 'Performance');
    }
    if (rp.hasCapacityData) {
      engineCapTB += sim.getRestorePointSizeForTier(rp.id, 'Capacity');
    }
    if (rp.hasArchiveData) {
      engineArchTB += sim.getRestorePointSizeForTier(rp.id, 'Archive');
    }

    const ageDays = diffDays(horizonDate, rp.date);
    const forecastTier = classifyForecastTier({
      ageDays,
      hasWeekly: !!rp.isWeeklyGFS,
      hasMonthly: !!rp.isMonthlyGFS,
      hasYearly: !!rp.isYearlyGFS,
      offloadAfterDays: config.offloadAfterDays,
      archiveAfterDays: config.archiveAfterDays,
      weeklyPolicy: config.gfsPolicy.weekly,
      yearlyPolicy: config.gfsPolicy.yearly,
      hasArchiveTier: config.hasArchiveTier,
    });

    if (forecastTier === 'Performance') forecastPerfClassified += 1;
    if (forecastTier === 'Capacity') forecastCapClassified += 1;
    if (forecastTier === 'Archive') forecastArchClassified += 1;

    const engineTier = rp.hasArchiveData
      ? 'Archive'
      : rp.hasCapacityData
      ? 'Capacity'
      : rp.hasPerformanceData
      ? 'Performance'
      : 'None';

    if (engineTier !== forecastTier) {
      const capEntry = rp.capacityMoveFinalizedAt ?? rp.capacityCopyCreatedAt ?? '-';
      const capAgeDays = capEntry === '-' ? -1 : diffDays(horizonDate, capEntry);
      const tags = [rp.isWeeklyGFS ? 'W' : '', rp.isMonthlyGFS ? 'M' : '', rp.isYearlyGFS ? 'Y' : '']
        .filter(Boolean)
        .join('+');
      mismatches.push({
        id: rp.id,
        date: rp.date,
        tags,
        ageDays,
        capEntry,
        capAgeDays,
        engineTier,
        forecastTier,
      });
    }

    if (rp.hasArchiveData) {
      const capEntry = rp.capacityMoveFinalizedAt ?? rp.capacityCopyCreatedAt;
      const capAge = capEntry ? diffDays(horizonDate, capEntry) : ageDays;
      const pointSizeTB = config.sourceDataTB * Math.pow(1 + config.annualGrowthRatePct / 100, Math.max(0, diffDays(rp.date, config.startDate)) / 365);
      const dailyRate = Math.max(0, config.dailyChangeRatePct / 100);
      const byPointAgeTB = computeGfsStoredContributionTB({
        pointSizeTB,
        dailyChangeRate: dailyRate,
        ageDays,
      });
      const byCapAgeTB = computeGfsStoredContributionTB({
        pointSizeTB,
        dailyChangeRate: dailyRate,
        ageDays: Math.max(0, capAge),
      });
      archiveAgeBasisRows.push({
        id: rp.id,
        date: rp.date,
        pointAge: ageDays,
        capAge,
        byPointAgeTB,
        byCapAgeTB,
      });
    }
  }

  for (const rp of sim.state.restorePoints) {
    if (rp.hasPerformanceData) {
      enginePerfTotalTB += sim.getRestorePointSizeForTier(rp.id, 'Performance');
    }
    if (rp.hasCapacityData) {
      engineCapTotalTB += sim.getRestorePointSizeForTier(rp.id, 'Capacity');
    }
    if (rp.hasArchiveData) {
      engineArchTotalTB += sim.getRestorePointSizeForTier(rp.id, 'Archive');
    }
  }

  let enginePerfNonGfsTB = 0;
  let engineCapNonGfsTB = 0;
  let engineArchNonGfsTB = 0;
  for (const rp of nonGfsPoints) {
    if (rp.hasPerformanceData) {
      enginePerfNonGfsTB += sim.getRestorePointSizeForTier(rp.id, 'Performance');
    }
    if (rp.hasCapacityData) {
      engineCapNonGfsTB += sim.getRestorePointSizeForTier(rp.id, 'Capacity');
    }
    if (rp.hasArchiveData) {
      engineArchNonGfsTB += sim.getRestorePointSizeForTier(rp.id, 'Archive');
    }
  }

  const planned = computeSimulatorPlanned(
    {
      repositoryType: 'SOBR',
      sourceDataTB: config.sourceDataTB,
      annualGrowthRatePct: config.annualGrowthRatePct,
      dailyChangeRatePct: config.dailyChangeRatePct,
      retention: config.retention,
      gfsPolicy: config.gfsPolicy,
      offloadAfterDays: config.offloadAfterDays,
      archiveAfterDays: config.archiveAfterDays,
      generationPeriodDays: config.generationPeriodDays,
      performanceImmutabilityDays: config.performanceImmutabilityDays,
      capacityImmutabilityDays: config.capacityImmutabilityDays,
      archiveImmutabilityDays: config.archiveImmutabilityDays,
      hasArchiveTier: config.hasArchiveTier,
      copyEnabled: config.copyEnabled,
      moveEnabled: config.moveEnabled,
    },
    config.startDate,
    3,
    'reverse',
    config.totalDays,
  );
  const wsTB = computeVeeamWorkingSpaceTB(config.sourceDataTB);
  const plannedPerfWithoutWsTB = Math.max(0, planned.plannedPerformanceTierTB - wsTB);

  console.log('============================================================');
  console.log(`Scenario: ${config.id}`);
  console.log(`Horizon date: ${horizonDate} (${diffDays(horizonDate, config.startDate)} days from start)`);
  console.log(`GFS points observed: ${gfsPoints.length}`);
  console.log('');

  console.log('Engine-observed TOTAL tier contribution TB at horizon:');
  console.log(`  Performance: ${format(enginePerfTotalTB)}`);
  console.log(`  Capacity:    ${format(engineCapTotalTB)}`);
  console.log(`  Archive:     ${format(engineArchTotalTB)}`);

  console.log('');
  console.log('Engine-observed NON-GFS tier contribution TB at horizon:');
  console.log(`  Performance: ${format(enginePerfNonGfsTB)}`);
  console.log(`  Capacity:    ${format(engineCapNonGfsTB)}`);
  console.log(`  Archive:     ${format(engineArchNonGfsTB)}`);

  console.log('');
  console.log('Planned model tier TB (same scenario config):');
  console.log(`  Performance (w/o WS): ${format(plannedPerfWithoutWsTB)}  (WS=${format(wsTB)})`);
  console.log(`  Capacity:             ${format(planned.plannedCapacityTierTB)}`);
  console.log(`  Archive:              ${format(planned.plannedArchiveTierTB)}`);

  console.log('');

  console.log('Engine-observed GFS tier contribution TB at horizon:');
  console.log(`  Performance: ${format(enginePerfTB)}`);
  console.log(`  Capacity:    ${format(engineCapTB)}`);
  console.log(`  Archive:     ${format(engineArchTB)}`);

  console.log('');
  console.log('Forecast model additional tier contribution TB (computeForecastGfsStatsAtYear):');
  console.log(`  Performance: ${format(forecastStats.additionalPerfFullTB)}`);
  console.log(`  Capacity:    ${format(forecastStats.additionalCapFullTB)}`);
  console.log(`  Archive:     ${format(forecastStats.additionalArchFullTB)}`);

  console.log('');
  console.log('Forecast point-classification counts (by current routing assumptions):');
  console.log(`  Performance: ${forecastPerfClassified}`);
  console.log(`  Capacity:    ${forecastCapClassified}`);
  console.log(`  Archive:     ${forecastArchClassified}`);

  console.log('');
  console.log(`Engine-vs-forecast tier classification mismatches: ${mismatches.length}`);
  for (const row of mismatches.slice(-12)) {
    const capAgeDisplay = row.capAgeDays < 0 ? '-' : String(row.capAgeDays);
    console.log(
      `  ${row.date} ${row.tags.padEnd(5)} age=${String(row.ageDays).padStart(4)} ` +
      `capEntry=${row.capEntry} capAge=${capAgeDisplay.padStart(4)} engine=${row.engineTier.padEnd(11)} forecast=${row.forecastTier}`
    );
  }

  if (mismatches.length > 12) {
    console.log(`  ... (${mismatches.length - 12} additional mismatches omitted)`);
  }

  console.log('');
  console.log('Archive points: contribution basis sensitivity (point age vs cap-entry age):');
  let sumPointAgeTB = 0;
  let sumCapAgeTB = 0;
  for (const row of archiveAgeBasisRows) {
    sumPointAgeTB += row.byPointAgeTB;
    sumCapAgeTB += row.byCapAgeTB;
    console.log(
      `  ${row.date} pointAge=${String(row.pointAge).padStart(4)} capAge=${String(row.capAge).padStart(4)} ` +
      `pointBasis=${format(row.byPointAgeTB)} capBasis=${format(row.byCapAgeTB)}`
    );
  }
  console.log(`  Sum point-age basis: ${format(sumPointAgeTB)} TB`);
  console.log(`  Sum cap-age basis:   ${format(sumCapAgeTB)} TB`);
  console.log(`  Delta (cap - point): ${format(sumCapAgeTB - sumPointAgeTB)} TB`);

  console.log('');
  console.log('Note: forecast move+archive routing uses point age thresholds; engine/archive oracle use capacity-entry age.');
  console.log('============================================================');
  console.log('');
}

for (const scenario of TARGET_SCENARIOS) {
  investigateScenario(scenario);
}
