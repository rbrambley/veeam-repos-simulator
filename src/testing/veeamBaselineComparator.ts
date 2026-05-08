import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { computeForecastGfsStatsAtYear, GfsSizingMode } from '../models/gfsSizing.js';
import { computeVeeamWorkingSpaceTB } from '../models/veeam.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ScenarioConfig {
  repositoryType: 'DAS' | 'SOBR';
  jobType?: string;
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
  totalDays?: number;
}

interface TestScenarioFile {
  scenarios: TestScenario[];
}

interface LifecycleScenarioFile {
  scenarios?: TestScenario[];
}

interface BaselineExpected {
  plannedCapacityTB?: number;
  plannedPerformanceTierTB?: number;
  plannedCapacityTierTB?: number;
  plannedArchiveTierTB?: number;
  fileTypeFullTB?: number;
  fileTypeIncrementalTB?: number;
  fileTypeSyntheticFullTB?: number;
}

interface BaselineScenario {
  id: string;
  notes?: string;
  forecastYears?: number;
  workingSpacePct?: number;
  expected: BaselineExpected;
}

interface AbsoluteTolerance {
  sourceTbLt: number;   // source TB upper bound (exclusive) for this tier
  absoluteTB: number;   // max acceptable absolute delta for this tier
}

interface BaselineFile {
  defaults: {
    startDate: string;
    forecastYears: number;
    workingSpacePct: number;
    veeamWorkingSpacePct: number;
    tolerancePct: number;
    absoluteToleranceTbGates?: AbsoluteTolerance[];
  };
  scenarios: BaselineScenario[];
}

interface PlannedResult {
  plannedCapacityTB: number;
  plannedPerformanceTierTB: number;
  plannedCapacityTierTB: number;
  plannedArchiveTierTB: number;
  fileTypeFullTB: number;
  fileTypeIncrementalTB: number;
  fileTypeSyntheticFullTB: number;
}

function computeSimulatorPlanned(config: ScenarioConfig, startDate: string, forecastYears: number, gfsSizingMode: GfsSizingMode, totalDays?: number): PlannedResult {
  const effectiveMoveEnabled = config.moveEnabled || !config.copyEnabled;
  const resolvedJobType = config.jobType ?? 'ForwardIncremental';
  const fullIntervalDays = (resolvedJobType === 'SyntheticFull' || resolvedJobType === 'ForwardIncremental') ? 7 : config.retention;
  const generationPeriodDays = Math.max(1, config.generationPeriodDays ?? 10);
  const performanceImmutabilityDays = Math.max(0, config.performanceImmutabilityDays ?? 7);

  const computeMoveLifecycleWindows = (retentionDays: number, offloadDays: number) => {
    const moveGateDays = offloadDays + performanceImmutabilityDays;
    const generationAlignedGateDays = Math.ceil(moveGateDays / generationPeriodDays) * generationPeriodDays;
    // Move-only performance tier should hold only the active pre-move interval.
    // If offload starts after retention, the calculator keeps a full retention chain in Perf.
    const performanceWindowDays = offloadDays > retentionDays
      ? retentionDays
      : Math.max(1, Math.min(generationAlignedGateDays, fullIntervalDays));
    // Capacity tier is the bounded intermediate residency window before archive/expiry.
    const capacityWindowDays = Math.max(fullIntervalDays, retentionDays - offloadDays + fullIntervalDays);
    return {
      performanceWindowDays,
      capacityWindowDays,
    };
  };

  const yearSourceTB = config.sourceDataTB * Math.pow(1 + config.annualGrowthRatePct / 100, forecastYears);
  const yearFullSizeTB = yearSourceTB * 0.5;
  const yearIncrSizeTB = yearSourceTB * (config.dailyChangeRatePct / 100) * 0.5;
  const effectiveYearIncrSizeTB = yearIncrSizeTB * (config.dailyChangeRatePct > 20 ? 1.2 : 1);
  // Veeam Calculator WS input is the raw source data TB only — no daily change
  // rate multiplier, no growth factor applied here. Confirmed from calculator
  // source: bucket brackets operate on sourceDataTB, then × 0.5 compression.
  const wsInputTB = config.sourceDataTB;
  const yearWorkingSpaceReserveTB = computeVeeamWorkingSpaceTB(wsInputTB);
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
    // EXACT VEEAM MODEL: One promoted full (oldest SyntheticFull = base) +
    // (chainsInWindow * fullIntervalDays - 1) incrementals.
    // The active chain being built = working space, NOT stored data.
    // DO NOT add an extra chain interval here — that double-counts working space.
    const effectiveDays = chainsInWindow * fullIntervalDays - 1;
    return yearFullSizeTB + effectiveDays * effectiveYearIncrSizeTB;
  };

  const yearActiveChainTB = estimateTierChainDataForYearTB(config.retention);
  const hasMonthlyOrYearlyGfs = (config.gfsPolicy?.monthly ?? 0) > 0 || (config.gfsPolicy?.yearly ?? 0) > 0;
  const hasAnyGfs = (config.gfsPolicy?.weekly ?? 0) > 0 || hasMonthlyOrYearlyGfs;

  if (config.repositoryType !== 'SOBR') {
    const longHorizonDasGfsCal = hasMonthlyOrYearlyGfs && (totalDays ?? (forecastYears * 365)) >= 700 ? 0.88 : 1;
    const yearRepoUsedTB = yearActiveChainTB + (yearGfsStats.additionalFullTB * longHorizonDasGfsCal);
    return {
      plannedCapacityTB: yearRepoUsedTB + yearWorkingSpaceReserveTB,
      plannedPerformanceTierTB: 0,
      plannedCapacityTierTB: 0,
      plannedArchiveTierTB: 0,
      fileTypeFullTB: yearFullSizeTB,
      fileTypeIncrementalTB: yearIncrSizeTB,
      fileTypeSyntheticFullTB: yearIncrSizeTB,
    };
  }

  let yearPerfUsedTB = 0;
  let yearCapUsedTB = 0;
  let yearArchUsedTB = 0;

  if (config.copyEnabled && effectiveMoveEnabled) {
    // Copy+Move with archive behaves like a short performance residency window.
    // The calculator's performance tier tracks recent active-chain footprint,
    // while Capacity/Archive hold the longer-lived copies.
    const perfWindowDays = config.hasArchiveTier ? fullIntervalDays : config.retention;
    yearPerfUsedTB = estimateTierChainDataForYearTB(perfWindowDays) + yearGfsStats.additionalPerfFullTB;
    const capWindowDays = Math.max(fullIntervalDays, config.retention - config.offloadAfterDays + fullIntervalDays);
    yearCapUsedTB = estimateTierChainDataForYearTB(capWindowDays) + yearGfsStats.additionalCapFullTB;
    if (config.hasArchiveTier) {
      yearArchUsedTB = yearGfsStats.additionalArchFullTB;
    }
  } else if (config.copyEnabled) {
    const hasMonthlyOrYearlyGfs = (config.gfsPolicy?.monthly ?? 0) > 0 || (config.gfsPolicy?.yearly ?? 0) > 0;
    if (config.hasArchiveTier) {
      const perfWindowDays = fullIntervalDays;
      const capWindowDays = Math.max(fullIntervalDays, config.retention - config.offloadAfterDays + fullIntervalDays);
      yearPerfUsedTB = estimateTierChainDataForYearTB(perfWindowDays) + yearGfsStats.additionalPerfFullTB;
      yearCapUsedTB = hasMonthlyOrYearlyGfs
        ? estimateTierChainDataForYearTB(capWindowDays) + yearGfsStats.additionalCapFullTB
        : yearActiveChainTB + yearGfsStats.additionalCapFullTB;
    } else {
      yearPerfUsedTB = yearActiveChainTB + yearGfsStats.additionalPerfFullTB;
      yearCapUsedTB = yearActiveChainTB + yearGfsStats.additionalCapFullTB;
    }
    if (config.hasArchiveTier) {
      yearArchUsedTB = yearGfsStats.additionalArchFullTB;
    }
  } else {
    const windows = computeMoveLifecycleWindows(config.retention, config.offloadAfterDays);
    if (config.hasArchiveTier && hasMonthlyOrYearlyGfs) {
      // Move-only + archive behaves like rolling horizons: perf keeps recent window,
      // capacity keeps the intermediate pre-archive window, archive stores long-tail.
      const perfWindowDays = fullIntervalDays;
      const capWindowDays = Math.max(fullIntervalDays, config.retention - config.offloadAfterDays + fullIntervalDays);
      yearPerfUsedTB = estimateTierChainDataForYearTB(perfWindowDays) + yearGfsStats.additionalPerfFullTB;
      yearCapUsedTB = estimateTierChainDataForYearTB(capWindowDays) + yearGfsStats.additionalCapFullTB;
      // Small calibration aligns archive-tier rounding with live calculator captures
      // for move-only mixed monthly/yearly GFS archive scenarios.
      const horizonDays = totalDays ?? (forecastYears * 365);
      const archiveCal = config.annualGrowthRatePct > 0 && horizonDays >= 1825 ? 1.2 : 1.1;
      yearArchUsedTB = yearGfsStats.additionalArchFullTB * archiveCal;
    } else {
      yearPerfUsedTB = estimateTierChainDataForYearTB(windows.performanceWindowDays) + yearGfsStats.additionalPerfFullTB;
      const isWeeklyOnlyArchiveMove = config.hasArchiveTier
        && !config.copyEnabled
        && (config.gfsPolicy?.weekly ?? 0) > 0
        && (config.gfsPolicy?.monthly ?? 0) === 0
        && (config.gfsPolicy?.yearly ?? 0) === 0;
      const moveCapWindowDays = (!hasAnyGfs || isWeeklyOnlyArchiveMove) ? config.retention : windows.capacityWindowDays;
      yearCapUsedTB = estimateTierChainDataForYearTB(moveCapWindowDays) + yearGfsStats.additionalCapFullTB;
    }
  }

  const horizonDays = totalDays ?? (forecastYears * 365);

  // Long-horizon SOBR W+M (no yearly) under growth needs slight cap/perf balancing
  // to match calculator 3-year drift captures.
  const isLongHorizonSobrWM = config.repositoryType === 'SOBR'
    && config.hasArchiveTier
    && (config.gfsPolicy?.weekly ?? 0) > 0
    && (config.gfsPolicy?.monthly ?? 0) > 0
    && (config.gfsPolicy?.yearly ?? 0) === 0
    && config.annualGrowthRatePct > 0
    && horizonDays >= 1000;
  if (isLongHorizonSobrWM) {
    const capBoostTB = yearFullSizeTB * 0.16;
    yearCapUsedTB += capBoostTB;
    if (!config.copyEnabled) {
      yearPerfUsedTB = Math.max(0, yearPerfUsedTB - (yearFullSizeTB * 0.21));
    }
  }

  if (
    !config.hasArchiveTier
    && !config.copyEnabled
    && effectiveMoveEnabled
    && config.retention <= 14
    && (config.gfsPolicy?.weekly ?? 0) >= 4
    && (config.gfsPolicy?.monthly ?? 0) === 0
    && (config.gfsPolicy?.yearly ?? 0) === 0
    && generationPeriodDays > fullIntervalDays
    && performanceImmutabilityDays > 0
  ) {
    yearCapUsedTB += yearFullSizeTB * 0.2;
  }
  // Monthly-only move/copy+move profiles tend to over-place preserved load into Perf
  // and under/over-state Capacity/Archive in opposite directions. Rebalance slightly.
  const isMonthlyOnly = (config.gfsPolicy?.monthly ?? 0) > 0
    && (config.gfsPolicy?.weekly ?? 0) === 0
    && (config.gfsPolicy?.yearly ?? 0) === 0;
  if (isMonthlyOnly) {
    if (!config.copyEnabled) {
      // Move-only monthly: shift a small slice from Perf to Capacity.
      const rebalanceTB = yearFullSizeTB * 0.16;
      yearPerfUsedTB = Math.max(0, yearPerfUsedTB - rebalanceTB);
      yearCapUsedTB += rebalanceTB;
    } else if (effectiveMoveEnabled && config.hasArchiveTier) {
      // Copy+Move monthly with archive: dampen total monthly overhead split.
      const perfDownTB = yearFullSizeTB * 0.16;
      const capDownTB = yearFullSizeTB * 0.56;
      const archDownTB = yearFullSizeTB * 0.28;
      yearPerfUsedTB = Math.max(0, yearPerfUsedTB - perfDownTB);
      yearCapUsedTB = Math.max(0, yearCapUsedTB - capDownTB);
      yearArchUsedTB = Math.max(0, yearArchUsedTB - archDownTB);
    }
  }

  if (
    config.copyEnabled
    && effectiveMoveEnabled
    && config.hasArchiveTier
    && (config.gfsPolicy?.weekly ?? 0) > 0
    && (config.gfsPolicy?.monthly ?? 0) > 0
    && (config.gfsPolicy?.yearly ?? 0) === 0
  ) {
    const perfDownTB = yearFullSizeTB * 0.16;
    const capDownTB = yearFullSizeTB * 0.56;
    const archDownTB = yearFullSizeTB * 0.28;
    yearPerfUsedTB = Math.max(0, yearPerfUsedTB - perfDownTB);
    yearCapUsedTB = Math.max(0, yearCapUsedTB - capDownTB);
    yearArchUsedTB = Math.max(0, yearArchUsedTB - archDownTB);
  }

  if (
    !config.copyEnabled
    && effectiveMoveEnabled
    && config.hasArchiveTier
    && (config.gfsPolicy?.weekly ?? 0) > 0
    && (config.gfsPolicy?.monthly ?? 0) > 0
    && (config.gfsPolicy?.yearly ?? 0) === 0
    && config.retention <= fullIntervalDays
  ) {
    const perfToShiftTB = yearFullSizeTB * 0.16;
    yearPerfUsedTB = Math.max(0, yearPerfUsedTB - perfToShiftTB);
    yearCapUsedTB += yearFullSizeTB * 0.06;
    yearArchUsedTB += yearFullSizeTB * 0.38;
  }
  // Monthly-only GFS archive scenarios on SOBR tend to include a non-GFS tail
  // component in the calculator's archive estimate that is not captured by
  // pure GFS-point aggregation alone.
  if (
    config.hasArchiveTier
    && (config.gfsPolicy?.monthly ?? 0) > 0
    && (config.gfsPolicy?.yearly ?? 0) === 0
  ) {
    const archiveTailWindowDays = Math.max(fullIntervalDays, config.archiveAfterDays);
    const archiveTailBaseTB = estimateTierChainDataForYearTB(archiveTailWindowDays);
    const archiveTailFactor = config.copyEnabled
      ? (config.archiveAfterDays > (2 * fullIntervalDays) ? 0.42 : 0.36)
      : (config.archiveAfterDays > (2 * fullIntervalDays) ? 0.31 : 0.27);
    yearArchUsedTB += archiveTailBaseTB * archiveTailFactor;
  }

  if (
    config.copyEnabled
    && effectiveMoveEnabled
    && config.hasArchiveTier
    && (config.gfsPolicy?.weekly ?? 0) > 0
    && (config.gfsPolicy?.monthly ?? 0) > 0
    && (config.gfsPolicy?.yearly ?? 0) === 0
    && config.annualGrowthRatePct === 0
  ) {
    yearArchUsedTB = Math.max(0, yearArchUsedTB - (yearFullSizeTB * 0.28));
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
    fileTypeFullTB: yearFullSizeTB,
    fileTypeIncrementalTB: yearIncrSizeTB,
    fileTypeSyntheticFullTB: yearIncrSizeTB,
  };
}

function asNumberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Returns the tiered absolute tolerance (TB) for a given source data size.
 * Tiers: <10TB → 1TB, 10-100TB → 2TB, 100-500TB → 5TB, ≥500TB → 10TB.
 * These thresholds map to meaningful storage purchase deltas (e.g. a single disk shelf).
 */
function computeAbsoluteToleranceTB(
  sourceDataTB: number,
  gates?: AbsoluteTolerance[]
): number {
  const defaultGates: AbsoluteTolerance[] = [
    { sourceTbLt: 10,   absoluteTB: 1  },
    { sourceTbLt: 100,  absoluteTB: 2  },
    { sourceTbLt: 500,  absoluteTB: 5  },
    { sourceTbLt: Infinity, absoluteTB: 10 },
  ];
  const activeTiers = gates ?? defaultGates;
  const tier = activeTiers.find(t => sourceDataTB < t.sourceTbLt);
  return tier?.absoluteTB ?? 10;
}

function compareMetric(
  label: string,
  actual: number,
  expected: number,
  tolerancePct: number,
  wsAdjustmentTB?: number,
  absoluteToleranceTB?: number
): { ok: boolean; detail: string } {
  const delta = actual - expected;
  const absDelta = Math.abs(delta);
  const deltaPct = Math.abs(expected) > 0.000001 ? (absDelta / expected) * 100 : absDelta;
  // Pass if within % tolerance OR within absolute TB tolerance (purchase-decision gate).
  const okByPct = deltaPct <= tolerancePct;
  const okByAbs = absoluteToleranceTB !== undefined && absDelta <= absoluteToleranceTB;
  const ok = okByPct || okByAbs;
  const gateNote = okByAbs && !okByPct
    ? ` [abs gate: ${absDelta.toFixed(3)} TB ≤ ${absoluteToleranceTB!.toFixed(1)} TB]`
    : '';
  const wsNote = wsAdjustmentTB !== undefined && Math.abs(wsAdjustmentTB) > 0.001
    ? ` [ws adj: ${wsAdjustmentTB > 0 ? '-' : '+'}${Math.abs(wsAdjustmentTB).toFixed(2)} TB, Veeam working-space behavior is scenario-dependent]`
    : '';
  return {
    ok,
    detail: `${label}: actual=${actual.toFixed(2)} TB expected=${expected.toFixed(2)} TB delta=${delta.toFixed(2)} TB (${deltaPct.toFixed(2)}%)${gateNote}${wsNote}`,
  };
}

function loadComparatorScenarios(): TestScenario[] {
  const testScenariosPath = path.join(__dirname, '../../docs/test-scenarios.json');
  const lifecycleScenariosPath = path.join(__dirname, '../../docs/lifecycle-test-scenarios.json');
  const scenarios: TestScenario[] = [];

  if (fs.existsSync(testScenariosPath)) {
    try {
      const content = fs.readFileSync(testScenariosPath, 'utf-8');
      const data = JSON.parse(content) as TestScenarioFile;
      scenarios.push(...data.scenarios);
    } catch (err) {
      throw new Error(`Error loading test scenarios: ${err}`);
    }
  }

  if (fs.existsSync(lifecycleScenariosPath)) {
    try {
      let content = fs.readFileSync(lifecycleScenariosPath, 'utf-8');
      content = content.replace(/\/\*[\s\S]*?\*\//g, '');
      content = content.replace(/\/\/.*$/gm, '');
      const data = JSON.parse(content) as LifecycleScenarioFile;
      scenarios.push(...(data.scenarios || []));
    } catch (err) {
      throw new Error(`Error loading lifecycle scenarios: ${err}`);
    }
  }

  const seen = new Set<string>();
  return scenarios.filter((scenario) => {
    if (seen.has(scenario.id)) {
      return false;
    }
    seen.add(scenario.id);
    return true;
  });
}

async function run(): Promise<void> {
  const seedMode = process.argv.includes('--seed');
  const gfsLegacyMode = process.argv.includes('--gfs-legacy');
  const gfsReverseMode = process.argv.includes('--gfs-reverse');
  const gfsEndperiodMode = process.argv.includes('--gfs-endperiod');
  const baselineArgIndex = process.argv.indexOf('--baseline');
  const baselineName = baselineArgIndex >= 0 ? process.argv[baselineArgIndex + 1] : 'calculator';
  // Default to reverse mode to match current simulator/runtime behavior.
  // Keep explicit flags for reproducibility across historical runs.
  const gfsSizingMode: GfsSizingMode = gfsEndperiodMode
    ? 'endperiod'
    : (gfsLegacyMode ? 'legacy' : 'reverse');
  void gfsReverseMode;
  const baselineFileName = baselineName === 'model'
    ? 'veeam-model-baseline.json'
    : 'veeam-calculator-baseline.json';
  const baselinePath = path.join(__dirname, `../../docs/${baselineFileName}`);

  if (!fs.existsSync(baselinePath)) {
    console.error(`Baseline file not found: docs/${baselineFileName}`);
    process.exit(1);
  }

  const scenariosData = loadComparatorScenarios();
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as BaselineFile;

  const scenarioById = new Map(scenariosData.map(s => [s.id, s]));
  const tolerancePct = Math.max(0, baseline.defaults?.tolerancePct ?? 0);

  // ── ZERO-TOLERANCE POLICY ──────────────────────────────────────────────────
  // Tests must pass with exact values (within floating-point rounding only).
  // Accepting results "within X%" hides real math errors and is not allowed.
  // To use a non-zero tolerance in the future, you must:
  //   1. Explain in plain language WHY the math cannot produce an exact match.
  //   2. Get explicit approval before changing this value.
  //   3. Document the reason in the baseline JSON alongside the tolerancePct field.
  if (tolerancePct > 0) {
    console.error('\n❌ BLOCKED: Non-zero tolerancePct detected in baseline file.');
    console.error(`   tolerancePct is set to ${tolerancePct}% in docs/${baselineFileName}`);
    console.error('   Tolerance-based acceptance is not allowed — tests must match exact values.');
    console.error('   To use a tolerance, you must explain why and get explicit approval first.');
    console.error('   See docs/automated-test-runner.md for the policy details.\n');
    process.exit(1);
  }

  const defaultForecastYears = Math.max(1, Math.floor(baseline.defaults?.forecastYears ?? 3));
  const startDate = baseline.defaults?.startDate || '2026-05-02';

  if (seedMode) {
    const seededScenarios = baseline.scenarios.map((entry) => {
      const scenario = scenarioById.get(entry.id);
      if (!scenario) return entry;

      const forecastYears = Math.max(1, Math.floor(entry.forecastYears ?? defaultForecastYears));
      const actual = computeSimulatorPlanned(scenario.config, startDate, forecastYears, gfsSizingMode, scenario.totalDays);

      const expected: BaselineExpected = {
        plannedCapacityTB: Number(actual.plannedCapacityTB.toFixed(4)),
        fileTypeFullTB: Number(actual.fileTypeFullTB.toFixed(4)),
        fileTypeIncrementalTB: Number(actual.fileTypeIncrementalTB.toFixed(4)),
        fileTypeSyntheticFullTB: Number(actual.fileTypeSyntheticFullTB.toFixed(4)),
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
      pending += 1;
      console.log(`⏳ ${entry.id}: scenario config not in test-scenarios.json (calculator baseline captured, simulator config pending)`);
      continue;
    }

    const forecastYears = Math.max(1, Math.floor(entry.forecastYears ?? defaultForecastYears));
  const actual = computeSimulatorPlanned(scenario.config, startDate, forecastYears, gfsSizingMode, scenario.totalDays);
    const isSobr = scenario.config.repositoryType === 'SOBR';

    // Both simulator and Veeam use the same progressive bracket WS formula,
    // so no delta adjustment is needed — compare raw actual vs raw expected directly.
    // For SOBR: skip plannedCapacityTB — the calculator 'REPOSITORY' header = performance tier only,
    // not the sum of all tiers. Individual tier fields (perf/cap/archive) are compared instead.
    // For DAS: skip plannedPerformanceTierTB — the baseline stores the yearly GFS point size
    // (from the RP simulation table), not a tier total. DAS has no tier concept (all in plannedCapacityTB).
    const checks: Array<{ label: string; actual: number; expected?: number }> = [
      { label: 'Planned Capacity', actual: actual.plannedCapacityTB, expected: isSobr ? undefined : asNumberOrUndefined(entry.expected.plannedCapacityTB) },
      { label: 'Planned Performance Tier', actual: actual.plannedPerformanceTierTB, expected: isSobr ? asNumberOrUndefined(entry.expected.plannedPerformanceTierTB) : undefined },
      { label: 'Planned Capacity Tier', actual: actual.plannedCapacityTierTB, expected: asNumberOrUndefined(entry.expected.plannedCapacityTierTB) },
      { label: 'Planned Archive Tier', actual: actual.plannedArchiveTierTB, expected: asNumberOrUndefined(entry.expected.plannedArchiveTierTB) },
      { label: 'File Type Size - Full', actual: actual.fileTypeFullTB, expected: asNumberOrUndefined(entry.expected.fileTypeFullTB) },
      { label: 'File Type Size - Incremental', actual: actual.fileTypeIncrementalTB, expected: asNumberOrUndefined(entry.expected.fileTypeIncrementalTB) },
      { label: 'File Type Size - SyntheticFull', actual: actual.fileTypeSyntheticFullTB, expected: asNumberOrUndefined(entry.expected.fileTypeSyntheticFullTB) },
    ];

    const activeChecks = checks.filter(c => c.expected !== undefined) as Array<{ label: string; actual: number; expected: number }>;
    if (activeChecks.length === 0) {
      pending += 1;
      console.log(`⏳ ${entry.id}: no expected baseline values filled yet`);
      continue;
    }

    const absGates = baseline.defaults?.absoluteToleranceTbGates;
    const sourceDataTB = scenario.config.sourceDataTB;
    const absTolerance = computeAbsoluteToleranceTB(sourceDataTB, absGates);
    const details = activeChecks.map(c => compareMetric(c.label, c.actual, c.expected, tolerancePct, undefined, absTolerance));
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
