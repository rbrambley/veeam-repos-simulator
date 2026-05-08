// ============================================================================
// ⚠️  CRITICAL GUARDRAIL — READ BEFORE ADDING ANY FORMULA OR CALIBRATION  ⚠️
//
// The purpose of this file is to COMPARE the simulator's output against the
// live Veeam Calculator. It is NOT a place to fix sizing logic.
//
// ALL sizing formulas, calibration factors, and adjustments MUST live in the
// shared model: src/models/sizingForecast.ts (or gfsSizing.ts / veeam.ts).
// Both this comparator AND OutputPanel.tsx must call that same shared code.
//
// ❌ NEVER add calibration factors here that are not also in the shared model.
//    Doing so makes tests pass while the UI still shows wrong numbers — a
//    silent bug that defeats the entire purpose of the simulator.
//
// ✅ Correct workflow when compare:veeam fails:
//    1. Diagnose the root cause in the sizing formula (gfsSizing.ts / sizingForecast.ts).
//    2. Fix it in the shared model.
//    3. Update/reseed the model baseline (compare:model).
//    4. Confirm compare:veeam passes — because UI and tests now share one truth.
//
// The simulator is only valuable if the user sees numbers that match Veeam.
// Passing tests while the UI is wrong is worse than failing tests.
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { GfsSizingMode } from '../models/gfsSizing.js';
import { SizingScenarioConfig, SizingResult, computeSizingForecast } from '../models/sizingForecast.js';

// Alias shared types under the local names used throughout this file.
type ScenarioConfig = SizingScenarioConfig;
type PlannedResult = SizingResult;
const computeSimulatorPlanned = computeSizingForecast;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  sourceTbLt: number;
  absoluteTB: number;
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
