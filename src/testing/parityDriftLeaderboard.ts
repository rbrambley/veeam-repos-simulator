import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { GfsSizingMode } from '../models/gfsSizing.js';
import { computeSimulatorPlanned, ScenarioConfig } from '../models/plannedCapacityCalculator.js';

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
  forecastYears?: number;
  expected: BaselineExpected;
}

interface BaselineFile {
  defaults: {
    startDate: string;
    forecastYears: number;
    tolerancePct: number;
  };
  scenarios: BaselineScenario[];
}

interface MetricDrift {
  label: string;
  actualTB: number;
  expectedTB: number;
  deltaTB: number;
  deltaPct: number;
}

interface ScenarioDrift {
  id: string;
  repositoryType: 'DAS' | 'SOBR';
  metricCount: number;
  meanAbsDeltaPct: number;
  maxAbsDeltaPct: number;
  worstMetric: MetricDrift;
  metrics: MetricDrift[];
}

interface ClusterDrift {
  cluster: string;
  scenarioCount: number;
  meanAbsDeltaPct: number;
  maxAbsDeltaPct: number;
}

function asNumberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function loadComparatorScenarios(): TestScenario[] {
  const testScenariosPath = path.join(__dirname, '../../docs/test-scenarios.json');
  const lifecycleScenariosPath = path.join(__dirname, '../../docs/lifecycle-test-scenarios.json');
  const scenarios: TestScenario[] = [];

  if (fs.existsSync(testScenariosPath)) {
    const content = fs.readFileSync(testScenariosPath, 'utf-8');
    const data = JSON.parse(content) as TestScenarioFile;
    scenarios.push(...data.scenarios);
  }

  if (fs.existsSync(lifecycleScenariosPath)) {
    let content = fs.readFileSync(lifecycleScenariosPath, 'utf-8');
    content = content.replace(/\/\*[\s\S]*?\*\//g, '');
    content = content.replace(/\/\/.*$/gm, '');
    const data = JSON.parse(content) as LifecycleScenarioFile;
    scenarios.push(...(data.scenarios || []));
  }

  const seen = new Set<string>();
  return scenarios.filter((scenario) => {
    if (seen.has(scenario.id)) return false;
    seen.add(scenario.id);
    return true;
  });
}

function safePct(actual: number, expected: number): number {
  const delta = actual - expected;
  if (Math.abs(expected) <= 0.000001) return Math.abs(delta);
  return Math.abs(delta / expected) * 100;
}

function metricDrift(label: string, actual: number, expected: number): MetricDrift {
  const deltaTB = actual - expected;
  return {
    label,
    actualTB: Number(actual.toFixed(4)),
    expectedTB: Number(expected.toFixed(4)),
    deltaTB: Number(deltaTB.toFixed(4)),
    deltaPct: Number(safePct(actual, expected).toFixed(4)),
  };
}

function scenarioCluster(id: string): string {
  const firstDash = id.indexOf('-');
  if (firstDash <= 0) return id;
  return id.slice(0, firstDash);
}

function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function main() {
  const baselinePath = path.join(__dirname, '../../docs/veeam-calculator-baseline.json');
  const outJsonPath = path.join(__dirname, '../../docs/parity-drift-leaderboard.json');
  const outMdPath = path.join(__dirname, '../../docs/parity-drift-leaderboard.md');

  if (!fs.existsSync(baselinePath)) {
    throw new Error('Calculator baseline file not found.');
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as BaselineFile;
  const scenarios = loadComparatorScenarios();
  const scenarioById = new Map(scenarios.map((s) => [s.id, s]));

  const gfsSizingMode: GfsSizingMode = 'reverse';
  const startDate = baseline.defaults?.startDate || '2026-05-02';
  const defaultForecastYears = Math.max(1, Math.floor(baseline.defaults?.forecastYears ?? 3));

  const scenarioDrifts: ScenarioDrift[] = [];

  for (const entry of baseline.scenarios) {
    const scenario = scenarioById.get(entry.id);
    if (!scenario) continue;

    const forecastYears = Math.max(1, Math.floor(entry.forecastYears ?? defaultForecastYears));
    const actual = computeSimulatorPlanned(scenario.config, startDate, forecastYears, gfsSizingMode, scenario.totalDays);
    const isSobr = scenario.config.repositoryType === 'SOBR';

    const metrics: MetricDrift[] = [];

    const plannedCapacityExpected = asNumberOrUndefined(entry.expected.plannedCapacityTB);
    if (!isSobr && plannedCapacityExpected !== undefined) {
      metrics.push(metricDrift('Planned Capacity', actual.plannedCapacityTB, plannedCapacityExpected));
    }

    const perfExpected = asNumberOrUndefined(entry.expected.plannedPerformanceTierTB);
    if (isSobr && perfExpected !== undefined) {
      metrics.push(metricDrift('Planned Performance Tier', actual.plannedPerformanceTierTB, perfExpected));
    }

    const capExpected = asNumberOrUndefined(entry.expected.plannedCapacityTierTB);
    if (capExpected !== undefined) {
      metrics.push(metricDrift('Planned Capacity Tier', actual.plannedCapacityTierTB, capExpected));
    }

    const archExpected = asNumberOrUndefined(entry.expected.plannedArchiveTierTB);
    if (archExpected !== undefined) {
      metrics.push(metricDrift('Planned Archive Tier', actual.plannedArchiveTierTB, archExpected));
    }

    const fullExpected = asNumberOrUndefined(entry.expected.fileTypeFullTB);
    if (fullExpected !== undefined) {
      metrics.push(metricDrift('File Type Size - Full', actual.fileTypeFullTB, fullExpected));
    }

    const incrExpected = asNumberOrUndefined(entry.expected.fileTypeIncrementalTB);
    if (incrExpected !== undefined) {
      metrics.push(metricDrift('File Type Size - Incremental', actual.fileTypeIncrementalTB, incrExpected));
    }

    const synthExpected = asNumberOrUndefined(entry.expected.fileTypeSyntheticFullTB);
    if (synthExpected !== undefined) {
      metrics.push(metricDrift('File Type Size - SyntheticFull', actual.fileTypeSyntheticFullTB, synthExpected));
    }

    if (metrics.length === 0) continue;

    const absPcts = metrics.map((m) => Math.abs(m.deltaPct));
    const worstMetric = metrics.reduce((worst, m) => (Math.abs(m.deltaPct) > Math.abs(worst.deltaPct) ? m : worst), metrics[0]);

    scenarioDrifts.push({
      id: entry.id,
      repositoryType: scenario.config.repositoryType,
      metricCount: metrics.length,
      meanAbsDeltaPct: Number(mean(absPcts).toFixed(4)),
      maxAbsDeltaPct: Number(Math.max(...absPcts).toFixed(4)),
      worstMetric,
      metrics,
    });
  }

  scenarioDrifts.sort((a, b) => b.maxAbsDeltaPct - a.maxAbsDeltaPct);

  const clusterMap = new Map<string, ScenarioDrift[]>();
  for (const s of scenarioDrifts) {
    const key = scenarioCluster(s.id);
    const arr = clusterMap.get(key) || [];
    arr.push(s);
    clusterMap.set(key, arr);
  }

  const clusterDrifts: ClusterDrift[] = [...clusterMap.entries()].map(([cluster, arr]) => {
    const meanAbs = mean(arr.map((x) => x.meanAbsDeltaPct));
    const maxAbs = Math.max(...arr.map((x) => x.maxAbsDeltaPct));
    return {
      cluster,
      scenarioCount: arr.length,
      meanAbsDeltaPct: Number(meanAbs.toFixed(4)),
      maxAbsDeltaPct: Number(maxAbs.toFixed(4)),
    };
  }).sort((a, b) => b.meanAbsDeltaPct - a.meanAbsDeltaPct);

  const output = {
    generatedAt: new Date().toISOString(),
    baseline: 'veeam-calculator-baseline',
    gfsSizingMode,
    scenarioCount: scenarioDrifts.length,
    topScenariosByMaxAbsDeltaPct: scenarioDrifts.slice(0, 15),
    clustersByMeanAbsDeltaPct: clusterDrifts,
  };

  fs.writeFileSync(outJsonPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');

  const topRows = output.topScenariosByMaxAbsDeltaPct
    .map((s) => `| ${s.id} | ${s.repositoryType} | ${s.maxAbsDeltaPct.toFixed(2)} | ${s.worstMetric.label} | ${s.worstMetric.deltaTB.toFixed(2)} |`)
    .join('\n');

  const clusterRows = output.clustersByMeanAbsDeltaPct
    .map((c) => `| ${c.cluster} | ${c.scenarioCount} | ${c.meanAbsDeltaPct.toFixed(2)} | ${c.maxAbsDeltaPct.toFixed(2)} |`)
    .join('\n');

  const markdown = `# Parity Drift Leaderboard\n\nGenerated: ${output.generatedAt}\n\n## Top Scenario Drift (by max abs delta %)\n\n| Scenario | Repo | Max Abs Delta % | Worst Metric | Delta TB |\n|---|---:|---:|---|---:|\n${topRows}\n\n## Cluster Drift (by mean abs delta %)\n\n| Cluster | Scenarios | Mean Abs Delta % | Max Abs Delta % |\n|---|---:|---:|---:|\n${clusterRows}\n`;

  fs.writeFileSync(outMdPath, markdown, 'utf-8');

  console.log('Generated drift reports:');
  console.log(' - docs/parity-drift-leaderboard.json');
  console.log(' - docs/parity-drift-leaderboard.md');
  console.log(`Scenarios analyzed: ${output.scenarioCount}`);
}

main();
