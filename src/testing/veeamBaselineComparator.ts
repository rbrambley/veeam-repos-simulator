import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { computeForecastGfsStatsAtYear, GfsSizingMode } from '../models/gfsSizing.js';
import { computeVeeamWorkingSpaceTB } from '../models/veeam.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ScenarioConfig {
  repositoryType: 'DAS' | 'SOBR';
  jobType: string;
  sourceDataTB: number;
  annualGrowthRatePct: number;
  dailyChangeRatePct: number;
  retention: number;
  gfsPolicy: { weekly: number; monthly: number; yearly: number };
  offloadAfterDays: number;
  archiveAfterDays: number;
  generationPeriodDays?: number;
  performanceImmutabilityDays?: number;
  capacityImmutabilityDays?: number;
  archiveImmutabilityDays?: number;
  hasArchiveTier: boolean;
  copyEnabled: boolean;
  moveEnabled: boolean;
}

interface TestScenario {
  id: string;
  name: string;
  config: ScenarioConfig;
}

interface BaselineExpected {
  plannedCapacityTB?: number;
  plannedPerformanceTierTB?: number;
  plannedCapacityTierTB?: number;
  plannedArchiveTierTB?: number;
}

interface BaselineScenario {
  id: string;
  notes?: string;
  forecastYears?: number;
  workingSpacePct?: number;
  expected: BaselineExpected;
}

interface BaselineFile {
  defaults: {
    startDate: string;
    forecastYears: number;
    workingSpacePct: number;
    veeamWorkingSpacePct: number;
    tolerancePct: number;
  };
  scenarios: BaselineScenario[];
}

interface PlannedResult {
  plannedCapacityTB: number;
  plannedPerformanceTierTB: number;
  plannedCapacityTierTB: number;
  plannedArchiveTierTB: number;
}

function computeSimulatorPlanned(config: ScenarioConfig, startDate: string, forecastYears: number, gfsSizingMode: GfsSizingMode): PlannedResult {
  const effectiveMoveEnabled = config.moveEnabled || !config.copyEnabled;
  const fullIntervalDays = (config.jobType === 'SyntheticFull' || config.jobType === 'ForwardIncremental') ? 7 : config.retention;
  const generationPeriodDays = Math.max(1, config.generationPeriodDays ?? 10);
  const performanceImmutabilityDays = Math.max(0, config.performanceImmutabilityDays ?? 7);

  const computeMoveLifecycleWindows = (elapsedDays: number, retentionDays: number, offloadDays: number) => {
    const moveGateDays = offloadDays + performanceImmutabilityDays;
    const generationAlignedGateDays = Math.ceil(moveGateDays / generationPeriodDays) * generationPeriodDays;
    const performanceWindowDays = Math.max(fullIntervalDays, generationAlignedGateDays + fullIntervalDays);
    const capacityAccumulationDays = Math.max(0, elapsedDays - generationAlignedGateDays + 1);
    return {
      performanceWindowDays,
      capacityAccumulationDays,
    };
  };

  const yearSourceTB = config.sourceDataTB * Math.pow(1 + config.annualGrowthRatePct / 100, forecastYears);
  const yearFullSizeTB = yearSourceTB * 0.5;
  const yearIncrSizeTB = yearSourceTB * (config.dailyChangeRatePct / 100) * 0.5;
  const yearWorkingSpaceReserveTB = computeVeeamWorkingSpaceTB(config.sourceDataTB);
  const yearGfsStats = computeForecastGfsStatsAtYear({
    sourceDataTB: config.sourceDataTB,
    annualGrowthRatePct: config.annualGrowthRatePct,
    dailyChangeRatePct: config.dailyChangeRatePct,
    retentionDays: config.retention,
    gfsPolicy: config.gfsPolicy,
    startDate,
    yearOffset: forecastYears,
    copyEnabled: config.copyEnabled,
    effectiveMoveEnabled,
    offloadAfterDays: config.offloadAfterDays,
    archiveAfterDays: config.archiveAfterDays,
    hasArchiveTier: config.hasArchiveTier,
    sizingMode: gfsSizingMode,
  });

  const estimateTierChainDataForYearTB = (windowDays: number) => {
    if (windowDays <= 0) return 0;
    const chainsInWindow = Math.max(1, Math.ceil(windowDays / Math.max(1, fullIntervalDays)));
    // Synthetic fulls are incremental-sized on DAS/ReFS. The base full persists
    // until the next chain completes, adding one extra chain interval.
    const effectiveDays = (chainsInWindow + 1) * fullIntervalDays - 1;
    return yearFullSizeTB + effectiveDays * yearIncrSizeTB;
  };

  const yearActiveChainTB = estimateTierChainDataForYearTB(config.retention);

  if (config.repositoryType !== 'SOBR') {
    const yearRepoUsedTB = yearActiveChainTB + yearGfsStats.additionalFullTB;
    return {
      plannedCapacityTB: yearRepoUsedTB + yearWorkingSpaceReserveTB,
      plannedPerformanceTierTB: 0,
      plannedCapacityTierTB: 0,
      plannedArchiveTierTB: 0,
    };
  }

  let yearPerfUsedTB = 0;
  let yearCapUsedTB = 0;
  let yearArchUsedTB = 0;

  if (config.copyEnabled && effectiveMoveEnabled) {
    // Copy+Move: data lives in Perf until explicitly moved, so size for full retention window.
    yearPerfUsedTB = estimateTierChainDataForYearTB(config.retention) + yearGfsStats.additionalPerfFullTB;
    yearCapUsedTB = yearActiveChainTB + yearGfsStats.additionalCapFullTB;
    if (config.hasArchiveTier) {
      yearArchUsedTB = yearGfsStats.additionalArchFullTB;
    }
  } else if (config.copyEnabled) {
    yearPerfUsedTB = yearActiveChainTB + yearGfsStats.additionalPerfFullTB;
    yearCapUsedTB = yearActiveChainTB + yearGfsStats.additionalCapFullTB;
    if (config.hasArchiveTier) {
      yearArchUsedTB = yearGfsStats.additionalArchFullTB;
    }
  } else {
    const elapsedDays = forecastYears * 365;
    const windows = computeMoveLifecycleWindows(elapsedDays, config.retention, config.offloadAfterDays);
    yearPerfUsedTB = estimateTierChainDataForYearTB(windows.performanceWindowDays) + yearGfsStats.additionalPerfFullTB;
    yearCapUsedTB = estimateTierChainDataForYearTB(windows.capacityAccumulationDays) + yearGfsStats.additionalCapFullTB;

    if (config.hasArchiveTier) {
      yearArchUsedTB = yearGfsStats.additionalArchFullTB;
    }
  }

  const plannedPerformanceTierTB = yearPerfUsedTB + yearWorkingSpaceReserveTB;
  const plannedCapacityTierTB = yearCapUsedTB;
  const plannedArchiveTierTB = yearArchUsedTB;
  const plannedCapacityTB = plannedPerformanceTierTB + plannedCapacityTierTB + (config.hasArchiveTier ? plannedArchiveTierTB : 0);

  return {
    plannedCapacityTB,
    plannedPerformanceTierTB,
    plannedCapacityTierTB,
    plannedArchiveTierTB,
  };
}

function asNumberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function compareMetric(label: string, actual: number, expected: number, tolerancePct: number, wsAdjustmentTB?: number): { ok: boolean; detail: string } {
  const delta = actual - expected;
  const deltaPct = Math.abs(expected) > 0.000001 ? Math.abs(delta / expected) * 100 : Math.abs(delta);
  const ok = deltaPct <= tolerancePct;
  const wsNote = wsAdjustmentTB !== undefined && Math.abs(wsAdjustmentTB) > 0.001
    ? ` [ws adj: ${wsAdjustmentTB > 0 ? '-' : '+'}${Math.abs(wsAdjustmentTB).toFixed(2)} TB, Veeam working-space behavior is scenario-dependent]`
    : '';
  return {
    ok,
    detail: `${label}: actual=${actual.toFixed(2)} TB expected=${expected.toFixed(2)} TB delta=${delta.toFixed(2)} TB (${deltaPct.toFixed(2)}%)${wsNote}`,
  };
}

async function run(): Promise<void> {
  const seedMode = process.argv.includes('--seed');
  const gfsReverseMode = process.argv.includes('--gfs-reverse');
  const gfsEndperiodMode = process.argv.includes('--gfs-endperiod');
  const baselineArgIndex = process.argv.indexOf('--baseline');
  const baselineName = baselineArgIndex >= 0 ? process.argv[baselineArgIndex + 1] : 'calculator';
  const gfsSizingMode: GfsSizingMode = gfsEndperiodMode ? 'endperiod' : (gfsReverseMode ? 'reverse' : 'legacy');
  const scenariosPath = path.join(__dirname, '../../docs/test-scenarios.json');
  const baselineFileName = baselineName === 'model'
    ? 'veeam-model-baseline.json'
    : 'veeam-calculator-baseline.json';
  const baselinePath = path.join(__dirname, `../../docs/${baselineFileName}`);

  if (!fs.existsSync(baselinePath)) {
    console.error(`Baseline file not found: docs/${baselineFileName}`);
    process.exit(1);
  }

  const scenariosData = JSON.parse(fs.readFileSync(scenariosPath, 'utf-8')) as { scenarios: TestScenario[] };
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as BaselineFile;

  const scenarioById = new Map(scenariosData.scenarios.map(s => [s.id, s]));
  const tolerancePct = Math.max(0, baseline.defaults?.tolerancePct ?? 5);
  const defaultForecastYears = Math.max(1, Math.floor(baseline.defaults?.forecastYears ?? 3));
  const startDate = baseline.defaults?.startDate || '2026-05-02';

  if (seedMode) {
    const seededScenarios = baseline.scenarios.map((entry) => {
      const scenario = scenarioById.get(entry.id);
      if (!scenario) return entry;

      const forecastYears = Math.max(1, Math.floor(entry.forecastYears ?? defaultForecastYears));
      const actual = computeSimulatorPlanned(scenario.config, startDate, forecastYears, gfsSizingMode);

      const expected: BaselineExpected = {
        plannedCapacityTB: Number(actual.plannedCapacityTB.toFixed(4)),
      };

      if (scenario.config.repositoryType === 'SOBR') {
        expected.plannedPerformanceTierTB = Number(actual.plannedPerformanceTierTB.toFixed(4));
        expected.plannedCapacityTierTB = Number(actual.plannedCapacityTierTB.toFixed(4));
        expected.plannedArchiveTierTB = Number(actual.plannedArchiveTierTB.toFixed(4));
      }

      return {
        ...entry,
        notes: entry.notes
          ? `${entry.notes} [seeded-from-simulator]`
          : 'seeded-from-simulator',
        expected,
      };
    });

    const seededBaseline: BaselineFile = {
      ...baseline,
      scenarios: seededScenarios,
    };

    fs.writeFileSync(baselinePath, JSON.stringify(seededBaseline, null, 2) + '\n', 'utf-8');
    console.log('✅ Baseline file seeded from current simulator calculations.');
    console.log(`   File: docs/${baselineFileName}`);
    process.exit(0);
  }

  let pass = 0;
  let fail = 0;
  let pending = 0;

  console.log(`\n🔍 Comparing simulator vs ${baselineName === 'model' ? 'model-aligned' : 'Veeam calculator'} baseline (tolerance ${tolerancePct}%)`);
  console.log(`\n  ⚠  Known structural differences — deltas are expected:`);
  console.log(`     • Veeam block generation period (10 days default) adds overhead to SOBR Cap/Archive Tiers — not modeled yet`);
  console.log(`     • Simulator and Veeam Calculator now use the same progressive tiered WS scale — no WS adjustment applied`);
  console.log(`     • GFS sizing mode: ${
    gfsSizingMode === 'endperiod' 
      ? 'end-of-period (all GFS at forecast year-end source size)' 
      : gfsSizingMode === 'reverse'
      ? 'growth-based (each GFS at its historical forecast-period date)'
      : 'legacy (all GFS at initial source size)'
  }`);
  console.log(`     • This comparison is directional (ballpark alignment), not an exact equivalence`);
  console.log('');

  for (const entry of baseline.scenarios) {
    const scenario = scenarioById.get(entry.id);
    if (!scenario) {
      fail += 1;
      console.log(`❌ ${entry.id}: scenario id not found in docs/test-scenarios.json`);
      continue;
    }

    const forecastYears = Math.max(1, Math.floor(entry.forecastYears ?? defaultForecastYears));
  const actual = computeSimulatorPlanned(scenario.config, startDate, forecastYears, gfsSizingMode);
    const isSobr = scenario.config.repositoryType === 'SOBR';

    // Both simulator and Veeam now use the same progressive tiered WS formula on initial sourceDataTB,
    // so no delta adjustment is needed — compare raw actual vs raw expected directly.
    const checks: Array<{ label: string; actual: number; expected?: number }> = [
      { label: 'Planned Capacity', actual: actual.plannedCapacityTB, expected: asNumberOrUndefined(entry.expected.plannedCapacityTB) },
      { label: 'Planned Performance Tier', actual: actual.plannedPerformanceTierTB, expected: asNumberOrUndefined(entry.expected.plannedPerformanceTierTB) },
      { label: 'Planned Capacity Tier', actual: actual.plannedCapacityTierTB, expected: asNumberOrUndefined(entry.expected.plannedCapacityTierTB) },
      { label: 'Planned Archive Tier', actual: actual.plannedArchiveTierTB, expected: asNumberOrUndefined(entry.expected.plannedArchiveTierTB) },
    ];
    void isSobr; // used for potential future tier-specific notes

    const activeChecks = checks.filter(c => c.expected !== undefined) as Array<{ label: string; actual: number; expected: number }>;
    if (activeChecks.length === 0) {
      pending += 1;
      console.log(`⏳ ${entry.id}: no expected baseline values filled yet`);
      continue;
    }

    const details = activeChecks.map(c => compareMetric(c.label, c.actual, c.expected, tolerancePct, undefined));
    const ok = details.every(d => d.ok);

    if (ok) {
      pass += 1;
      console.log(`✅ ${entry.id}: all compared metrics within tolerance`);
    } else {
      fail += 1;
      console.log(`❌ ${entry.id}: one or more metrics outside tolerance`);
    }

    for (const d of details) {
      console.log(`   ${d.ok ? '✓' : '✗'} ${d.detail}`);
    }
  }

  console.log(`\n============================================================`);
  console.log(`📊 Baseline Comparison Summary`);
  console.log(`============================================================`);
  console.log(`✅ Passed: ${pass}`);
  console.log(`❌ Failed: ${fail}`);
  console.log(`⏳ Pending (missing expected values): ${pending}`);
  console.log(`============================================================\n`);

  process.exit(fail > 0 ? 1 : 0);
}

run().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
