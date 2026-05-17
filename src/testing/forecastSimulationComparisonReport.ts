import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { computeSimulatorPlanned, ScenarioConfig } from '../models/plannedCapacityCalculator.js';
import { computeVeeamWorkingSpaceTB, SimulationState, Repository, BackupJob, BackupChain, SOBRConfig } from '../models/veeam.js';
import { VeeamSimulator } from '../simulator/engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface BaselineExpected {
  plannedCapacityTB?: number;
  plannedPerformanceTierTB?: number;
  plannedCapacityTierTB?: number;
  plannedArchiveTierTB?: number;
  fileTypeFullTB?: number;
  fileTypeIncrementalTB?: number;
  fileTypeSyntheticFullTB?: number;
  calculatorSummaryRestorePointCount?: number;
  parsedRestorePointCount?: number;
  workingSpaceTB?: number;
  restorePointsTotalTB?: number;
  varianceTB?: number;
}

interface BaselineScenario {
  id: string;
  notes?: string;
  forecastYears?: number;
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

interface TestScenario {
  id: string;
  name: string;
  totalDays?: number;
  config: ScenarioConfig;
}

interface TestScenarioFile {
  scenarios: TestScenario[];
}

interface LifecycleScenarioFile {
  scenarios?: TestScenario[];
}

interface YearAnchor {
  year: number;
  simulationDay: number;
  date: string;
  dayOfWeek: string;
}

interface RuntimeMetrics {
  plannedCapacityTB: number;
  plannedPerformanceTierTB: number;
  plannedCapacityTierTB: number;
  plannedArchiveTierTB: number;
  storedDataTB: number;
  workingSpaceTB: number;
}

const YEARS = [1, 2, 3];

function stripJsonComments(input: string): string {
  let content = input.replace(/\/\*[\s\S]*?\*\//g, '');
  content = content.replace(/^\s*\/\/.*$/gm, '');
  return content;
}

function parseISODate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addYearsISO(isoDate: string, years: number): string {
  const d = parseISODate(isoDate);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return toISODate(d);
}

function lastSaturdayOnOrBefore(isoDate: string): string {
  const d = parseISODate(isoDate);
  const weekday = d.getUTCDay();
  const daysBack = weekday === 6 ? 0 : weekday + 1;
  d.setUTCDate(d.getUTCDate() - daysBack);
  return toISODate(d);
}

function dayDiff(startIso: string, endIso: string): number {
  const start = parseISODate(startIso).getTime();
  const end = parseISODate(endIso).getTime();
  return Math.round((end - start) / 86_400_000);
}

function dayOfWeek(isoDate: string): string {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return names[parseISODate(isoDate).getUTCDay()];
}

function getYearAnchor(startDate: string, year: number): YearAnchor {
  const anniversary = addYearsISO(startDate, year);
  const parityDate = lastSaturdayOnOrBefore(anniversary);
  return {
    year,
    simulationDay: dayDiff(startDate, parityDate),
    date: parityDate,
    dayOfWeek: dayOfWeek(parityDate),
  };
}

function num(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return v;
}

function fmt(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return 'N/A';
  return v.toFixed(3);
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadScenarios(): TestScenario[] {
  const testScenariosPath = path.join(__dirname, '../../docs/test-scenarios.json');
  const lifecycleScenariosPath = path.join(__dirname, '../../docs/lifecycle-test-scenarios.json');

  const scenarios: TestScenario[] = [];

  if (fs.existsSync(testScenariosPath)) {
    const content = fs.readFileSync(testScenariosPath, 'utf-8');
    const data = JSON.parse(content) as TestScenarioFile;
    scenarios.push(...data.scenarios);
  }

  if (fs.existsSync(lifecycleScenariosPath)) {
    const content = stripJsonComments(fs.readFileSync(lifecycleScenariosPath, 'utf-8'));
    const data = JSON.parse(content) as LifecycleScenarioFile;
    scenarios.push(...(data.scenarios || []));
  }

  const byId = new Map<string, TestScenario>();
  for (const sc of scenarios) {
    if (!byId.has(sc.id)) {
      byId.set(sc.id, sc);
    }
  }
  return [...byId.values()];
}

function buildInitialState(config: ScenarioConfig, startDate: string): SimulationState {
  const repoId = 'repo-1';
  const jobId = 'job-1';

  const sobrConfig: SOBRConfig | undefined =
    config.repositoryType === 'SOBR'
      ? {
          performanceCapacityTB: 10,
          capacityCapacityTB: 100,
          archiveCapacityTB: 500,
          copyEnabled: !!config.copyEnabled,
          moveEnabled: !!config.moveEnabled,
          offloadAfterDays: config.offloadAfterDays,
          archiveAfterDays: config.archiveAfterDays,
          generationPeriodDays: Math.max(1, config.generationPeriodDays ?? 10),
          performanceImmutabilityDays: Math.max(0, config.performanceImmutabilityDays ?? 7),
          capacityImmutabilityDays: Math.max(0, config.capacityImmutabilityDays ?? 0),
          archiveImmutabilityDays: Math.max(0, config.archiveImmutabilityDays ?? 0),
          hasArchiveTier: !!config.hasArchiveTier,
        }
      : undefined;

  const repo: Repository = {
    id: repoId,
    name: 'Comparison Repo',
    type: config.repositoryType,
    capacityTB: 500,
    sobrConfig,
  };

  const job: BackupJob = {
    id: jobId,
    name: 'Comparison Job',
    type: (config.jobType as BackupJob['type']) || 'ForwardIncremental',
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
    id: 'chain-1',
    jobId,
    status: 'Active',
    restorePoints: [],
  };

  return {
    repositories: [repo],
    jobs: [job],
    chains: [chain],
    restorePoints: [],
    blocks: [],
    date: startDate,
    startDate,
  };
}

function collectRuntimeByDay(scenario: TestScenario, startDate: string, requestedDays: number[]): Map<number, RuntimeMetrics> {
  const safeDays = [...new Set(requestedDays.filter((d) => d > 0))].sort((a, b) => a - b);
  const out = new Map<number, RuntimeMetrics>();
  if (safeDays.length === 0) return out;

  const sim = new VeeamSimulator(buildInitialState(scenario.config, startDate));
  const maxDay = safeDays[safeDays.length - 1];
  const daySet = new Set(safeDays);

  for (let day = 1; day <= maxDay; day++) {
    sim.nextDay();
    if (!daySet.has(day)) continue;

    const repo = sim.state.repositories[0];
    const repoId = repo?.id ?? 'repo-1';
    const wsTB = computeVeeamWorkingSpaceTB(scenario.config.sourceDataTB);

    if (repo?.type === 'SOBR') {
      const tier = sim.getSOBRTierUsage(repoId);
      const perfStored = num(tier.Performance);
      const capStored = num(tier.Capacity);
      const archStored = num(tier.Archive);
      const perfWithWs = perfStored + wsTB;
      out.set(day, {
        plannedCapacityTB: perfWithWs + capStored + archStored,
        plannedPerformanceTierTB: perfWithWs,
        plannedCapacityTierTB: capStored,
        plannedArchiveTierTB: archStored,
        storedDataTB: perfStored + capStored + archStored,
        workingSpaceTB: wsTB,
      });
    } else {
      const usage = sim.getStorageUsage();
      const stored = num(usage[repoId]);
      out.set(day, {
        plannedCapacityTB: stored + wsTB,
        plannedPerformanceTierTB: stored + wsTB,
        plannedCapacityTierTB: 0,
        plannedArchiveTierTB: 0,
        storedDataTB: stored,
        workingSpaceTB: wsTB,
      });
    }
  }

  return out;
}

function renderMetricRow(label: string, parsed: number | undefined, forecast: number | undefined, runtime?: number): string {
  const hasParsed = typeof parsed === 'number' && Number.isFinite(parsed);
  const hasForecast = typeof forecast === 'number' && Number.isFinite(forecast);
  const hasRuntime = typeof runtime === 'number' && Number.isFinite(runtime);
  const parsedDelta = hasParsed && hasForecast ? (parsed - forecast) : undefined;
  const delta = hasForecast && hasRuntime ? (runtime - forecast) : undefined;
  const parsedPct = hasParsed && hasForecast && Math.abs(forecast) > 1e-9
    ? ((parsed - forecast) / forecast) * 100
    : undefined;
  const pct = hasForecast && hasRuntime && Math.abs(forecast) > 1e-9
    ? ((runtime - forecast) / forecast) * 100
    : undefined;
  const parsedCls = parsedDelta !== undefined && Math.abs(parsedDelta) <= 0.001 ? 'ok' : 'warn';
  const cls = delta !== undefined && Math.abs(delta) <= 0.001 ? 'ok' : 'warn';

  const parsedDeltaCell = parsedDelta === undefined
    ? 'N/A'
    : fmt(parsedDelta);
  const deltaCell = delta === undefined
    ? 'N/A'
    : fmt(delta);
  const parsedPctCell = parsedPct === undefined
    ? 'N/A'
    : `${parsedPct.toFixed(2)}%`;
  const pctCell = pct === undefined
    ? 'N/A'
    : `${pct.toFixed(2)}%`;

  return `<tr>
    <td>${esc(label)}</td>
    <td class="num">${fmt(parsed)}</td>
    <td class="num ${parsedDelta === undefined ? '' : parsedCls}">${parsedDeltaCell}</td>
    <td class="num">${fmt(forecast)}</td>
    <td class="num">${fmt(runtime)}</td>
    <td class="num ${delta === undefined ? '' : cls}">${deltaCell}</td>
    <td class="num ${pct === undefined ? '' : cls}">${pctCell}</td>
  </tr>`;
}

function varianceBar(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return '';
  }
  const width = Math.max(4, Math.min(64, Math.abs(value) * 20));
  const color = value > 0.01 ? '#3a9f55' : value < -0.01 ? '#c5423f' : '#8f8f8f';
  return `<span class="variance-wrap"><span class="variance-bar" style="width:${width}px;background:${color};"></span></span>`;
}

function renderVarianceComparisonRow(
  label: string,
  parsed: number | undefined,
  forecast: number | undefined,
  runtime: number | undefined,
): string {
  const hasParsed = typeof parsed === 'number' && Number.isFinite(parsed);
  const hasForecast = typeof forecast === 'number' && Number.isFinite(forecast);
  const hasRuntime = typeof runtime === 'number' && Number.isFinite(runtime);
  const parsedDelta = hasParsed && hasForecast ? (parsed - forecast) : undefined;
  const delta = hasForecast && hasRuntime ? (runtime - forecast) : undefined;
  const parsedPct = hasParsed && hasForecast && Math.abs(forecast) > 1e-9
    ? ((parsed - forecast) / forecast) * 100
    : undefined;
  const pct = hasForecast && hasRuntime && Math.abs(forecast) > 1e-9
    ? ((runtime - forecast) / forecast) * 100
    : undefined;
  const parsedCls = parsedDelta !== undefined && Math.abs(parsedDelta) <= 0.001 ? 'ok' : 'warn';
  const cls = delta !== undefined && Math.abs(delta) <= 0.001 ? 'ok' : 'warn';

  return `<tr>
    <td>${esc(label)}</td>
    <td class="num">${fmt(parsed)} ${varianceBar(parsed)}</td>
    <td class="num ${parsedDelta === undefined ? '' : parsedCls}">${parsedDelta === undefined ? 'N/A' : fmt(parsedDelta)}</td>
    <td class="num">${fmt(forecast)} ${varianceBar(forecast)}</td>
    <td class="num">${fmt(runtime)} ${varianceBar(runtime)}</td>
    <td class="num ${delta === undefined ? '' : cls}">${delta === undefined ? 'N/A' : fmt(delta)}</td>
    <td class="num ${pct === undefined ? '' : cls}">${pct === undefined ? 'N/A' : `${pct.toFixed(2)}%`}</td>
  </tr>`;
}

function fmtInt(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return 'N/A';
  return String(Math.round(v));
}

function fmtInputNum(value: number | undefined, suffix = ''): string {
  if (value === undefined || !Number.isFinite(value)) {
    return 'N/A';
  }
  return suffix ? `${value}${suffix}` : String(value);
}

function fmtInputBool(value: boolean | undefined): string {
  if (value === undefined) {
    return 'N/A';
  }
  return value ? 'Yes' : 'No';
}

function renderInputSettingsTable(scenario: TestScenario): string {
  const cfg = scenario.config;
  const coreRows: Array<{ label: string; value: string }> = [
    { label: 'Repository Type', value: cfg.repositoryType },
    { label: 'Job Type', value: cfg.jobType ?? 'N/A' },
    { label: 'Source Data', value: fmtInputNum(cfg.sourceDataTB, ' TB') },
    { label: 'Daily Change Rate', value: fmtInputNum(cfg.dailyChangeRatePct, '%') },
    { label: 'Annual Growth Rate', value: fmtInputNum(cfg.annualGrowthRatePct, '%') },
    { label: 'Simulation Days', value: fmtInputNum(scenario.totalDays) },
  ];

  const retentionRows: Array<{ label: string; value: string }> = [
    { label: 'Retention (Days)', value: fmtInputNum(cfg.retention) },
    { label: 'GFS Weekly', value: fmtInputNum(cfg.gfsPolicy?.weekly) },
    { label: 'GFS Monthly', value: fmtInputNum(cfg.gfsPolicy?.monthly) },
    { label: 'GFS Yearly', value: fmtInputNum(cfg.gfsPolicy?.yearly) },
  ];

  const tierRows: Array<{ label: string; value: string }> = [
    { label: 'Offload After', value: fmtInputNum(cfg.offloadAfterDays, ' days') },
    { label: 'Archive After', value: fmtInputNum(cfg.archiveAfterDays, ' days') },
    { label: 'Archive Tier Enabled', value: fmtInputBool(cfg.hasArchiveTier) },
    { label: 'Copy Policy Enabled', value: fmtInputBool(cfg.copyEnabled) },
    { label: 'Move Policy Enabled', value: fmtInputBool(cfg.moveEnabled) },
    { label: 'Generation Period', value: fmtInputNum(cfg.generationPeriodDays, ' days') },
    { label: 'Perf Immutability', value: fmtInputNum(cfg.performanceImmutabilityDays, ' days') },
    { label: 'Capacity Immutability', value: fmtInputNum(cfg.capacityImmutabilityDays, ' days') },
    { label: 'Archive Immutability', value: fmtInputNum(cfg.archiveImmutabilityDays, ' days') },
  ];

  const renderGroup = (title: string, rows: Array<{ label: string; value: string }>): string => {
    const body = rows.map((r) => `
      <tr>
        <td>${esc(r.label)}</td>
        <td class="num">${esc(r.value)}</td>
      </tr>`).join('');

    return `
      <div class="input-group">
        <h5>${esc(title)}</h5>
        <table class="inputs-table">
          <tbody>${body}
          </tbody>
        </table>
      </div>
    `;
  };

  return `
    <h4>Input Settings</h4>
    <div class="input-groups">
      ${renderGroup('Core', coreRows)}
      ${renderGroup('Retention & GFS', retentionRows)}
      ${renderGroup('Tiering & Policies', tierRows)}
    </div>
  `;
}

function renderDiagnosticsSection(expected: BaselineExpected): string {
  const summaryCount = expected.calculatorSummaryRestorePointCount;
  const parsedCount = expected.parsedRestorePointCount;
  const countGap =
    typeof summaryCount === 'number' && Number.isFinite(summaryCount)
      && typeof parsedCount === 'number' && Number.isFinite(parsedCount)
      ? parsedCount - summaryCount
      : undefined;

  const sumGap = expected.varianceTB;
  const countFlag = countGap === undefined ? 'N/A' : (countGap === 0 ? 'OK' : 'GAP');
  const sumFlag = sumGap === undefined ? 'N/A' : (Math.abs(sumGap) <= 0.001 ? 'OK' : 'GAP');
  const countFlagClass = countFlag === 'OK' ? 'ok' : countFlag === 'GAP' ? 'warn' : '';
  const sumFlagClass = sumFlag === 'OK' ? 'ok' : sumFlag === 'GAP' ? 'warn' : '';

  return `
    <h4>Calculator Diagnostics</h4>
    <table class="diag-table">
      <thead>
        <tr>
          <th>Calculator RP Count</th>
          <th>Parsed RP Count</th>
          <th>RP Count Difference</th>
          <th>RP Sum Difference TB</th>
          <th>Count Flag</th>
          <th>Sum Flag</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="num">${fmtInt(summaryCount)}</td>
          <td class="num">${fmtInt(parsedCount)}</td>
          <td class="num ${countGap !== undefined && countGap !== 0 ? 'warn' : 'ok'}">${countGap === undefined ? 'N/A' : fmt(countGap)}</td>
          <td class="num ${sumGap !== undefined && Math.abs(sumGap) > 0.001 ? 'warn' : 'ok'}">${fmt(sumGap)}</td>
          <td class="num ${countFlagClass}">${countFlag}</td>
          <td class="num ${sumFlagClass}">${sumFlag}</td>
        </tr>
      </tbody>
    </table>
  `;
}

function buildScenarioSection(
  baselineScenario: BaselineScenario,
  scenario: TestScenario,
  startDate: string,
): string {
  const anchors = YEARS.map((year) => getYearAnchor(startDate, year));
  const runtimeByDay = collectRuntimeByDay(scenario, startDate, anchors.map((a) => a.simulationDay));

  const anchorRows = anchors.map((a) => `<tr>
    <td>Year ${a.year}</td>
    <td class="num">${a.simulationDay}</td>
    <td>${a.date}</td>
    <td>${a.dayOfWeek}</td>
  </tr>`).join('');

  const yearTables = anchors.map((a) => {
    const forecast = computeSimulatorPlanned(scenario.config, startDate, a.year, 'reverse', scenario.totalDays);
    const runtime = runtimeByDay.get(a.simulationDay);

    if (!runtime) {
      return `<h4>Year ${a.year}</h4><p class="warn-text">Runtime snapshot not found for day ${a.simulationDay}.</p>`;
    }

    const coreRows: string[] = [];
    const forecastWorkingSpaceTB = computeVeeamWorkingSpaceTB(scenario.config.sourceDataTB);
    const forecastStoredDataTB = forecast.plannedCapacityTB - forecastWorkingSpaceTB;
    const forecastVarianceTB = forecast.plannedCapacityTB - forecastStoredDataTB;
    const runtimeVarianceTB = runtime.plannedCapacityTB - runtime.storedDataTB;

    coreRows.push(renderMetricRow('Repository Total TB', baselineScenario.expected.plannedCapacityTB, forecast.plannedCapacityTB, runtime.plannedCapacityTB));
    coreRows.push(renderMetricRow('RP Sum TB', baselineScenario.expected.restorePointsTotalTB, forecastStoredDataTB, runtime.storedDataTB));
    coreRows.push(renderMetricRow('Working Space TB', baselineScenario.expected.workingSpaceTB, forecastWorkingSpaceTB, runtime.workingSpaceTB));
    coreRows.push(renderVarianceComparisonRow('Repository Difference TB', baselineScenario.expected.varianceTB, forecastVarianceTB, runtimeVarianceTB));
    if (scenario.config.repositoryType === 'SOBR') {
      coreRows.push(renderMetricRow('Performance Tier TB', baselineScenario.expected.plannedPerformanceTierTB, forecast.plannedPerformanceTierTB, runtime.plannedPerformanceTierTB));
      coreRows.push(renderMetricRow('Capacity Tier TB', baselineScenario.expected.plannedCapacityTierTB, forecast.plannedCapacityTierTB, runtime.plannedCapacityTierTB));
      coreRows.push(renderMetricRow('Archive Tier TB', baselineScenario.expected.plannedArchiveTierTB, forecast.plannedArchiveTierTB, runtime.plannedArchiveTierTB));
    }
    coreRows.push(renderMetricRow('Full TB', baselineScenario.expected.fileTypeFullTB, forecast.fileTypeFullTB));
    coreRows.push(renderMetricRow('Incremental TB', baselineScenario.expected.fileTypeIncrementalTB, forecast.fileTypeIncrementalTB));
    coreRows.push(renderMetricRow('Synthetic Full TB', baselineScenario.expected.fileTypeSyntheticFullTB, forecast.fileTypeSyntheticFullTB));

    return `
      <h4>Year ${a.year} Comparison</h4>
      <div class="subnote">Simulation Day ${a.simulationDay} · ${a.date} (${a.dayOfWeek})</div>
      <table>
        <thead>
          <tr>
            <th>Metric</th>
            <th>Veeam Calculator TB</th>
            <th>Calculator - Forecaster TB</th>
            <th>Forecaster TB</th>
            <th>Simulator TB</th>
            <th>Simulator - Forecaster TB</th>
            <th title="Percent difference between Simulator and Forecaster: ((Simulator - Forecaster) / Forecaster) * 100">Difference %</th>
          </tr>
        </thead>
        <tbody>
          ${coreRows.join('\n')}
        </tbody>
      </table>
    `;
  }).join('');

  return `
    <details class="scenario" data-scenario-id="${esc(scenario.id)}" data-repository-type="${esc(scenario.config.repositoryType)}" open>
      <summary>
        <h3>${esc(scenario.id)} <span class="name">${esc(scenario.name)}</span></h3>
      </summary>
      <p class="subnote">Repository: ${esc(scenario.config.repositoryType)} · Retention: ${scenario.config.retention}d · GFS: ${scenario.config.gfsPolicy.weekly}W/${scenario.config.gfsPolicy.monthly}M/${scenario.config.gfsPolicy.yearly}Y</p>
      <p class="subnote">Veeam Calculator note: ${esc(baselineScenario.notes ?? 'n/a')}</p>

      ${renderInputSettingsTable(scenario)}

      ${renderDiagnosticsSection(baselineScenario.expected)}

      <h4>Forecaster/Simulator Day Alignment</h4>
      <table>
        <thead>
          <tr>
            <th>Forecast Year</th>
            <th>Simulation Day</th>
            <th>Date</th>
            <th>Day Of Week</th>
          </tr>
        </thead>
        <tbody>
          ${anchorRows}
        </tbody>
      </table>

      ${yearTables}
    </details>
  `;
}

function buildHtml(
  baseline: BaselineFile,
  scenarios: TestScenario[],
  selectedIds: Set<string>,
): string {
  const scenarioMap = new Map(scenarios.map((sc) => [sc.id, sc]));

  const usableBaselineScenarios = baseline.scenarios
    .filter((s) => selectedIds.size === 0 || selectedIds.has(s.id));

  const found = usableBaselineScenarios.filter((b) => scenarioMap.has(b.id));
  const missing = usableBaselineScenarios.filter((b) => !scenarioMap.has(b.id));

  const sections = found.map((b) => buildScenarioSection(b, scenarioMap.get(b.id)!, baseline.defaults.startDate)).join('\n');
  const missingList = missing.length > 0
    ? `<div class="missing"><strong>Missing Scenario Configs:</strong> ${missing.map((m) => esc(m.id)).join(', ')}</div>`
    : '';

  const now = new Date().toISOString();
  const usedForecast = baseline.defaults.forecastYears;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Forecast vs Simulation Comparison</title>
  <style>
    :root {
      --bg: #f6f8fc;
      --card: #ffffff;
      --ink: #12263a;
      --muted: #4f6377;
      --line: #d8e1ee;
      --accent: #0f5c90;
      --ok: #1a7f37;
      --warn: #b45309;
    }
    body { margin: 0; font-family: "Segoe UI", Tahoma, sans-serif; background: linear-gradient(170deg, #f6f8fc 0%, #ecf2ff 100%); color: var(--ink); }
    .wrap { max-width: 1240px; margin: 0 auto; padding: 24px 16px 48px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    .intro { color: var(--muted); margin: 0 0 14px; }
    .meta { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; margin-bottom: 14px; }
    .meta p { margin: 4px 0; }
    .controls { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; margin-bottom: 14px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .controls label { font-size: 13px; color: var(--muted); }
    .controls input, .controls select, .controls button { border: 1px solid #c7d4e6; border-radius: 8px; padding: 6px 8px; font-size: 13px; background: #fff; color: var(--ink); }
    .controls button { cursor: pointer; background: #eef5ff; }
    .scenario { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 0; margin-bottom: 18px; box-shadow: 0 8px 24px rgba(16,36,65,0.06); overflow: hidden; }
    .scenario > summary { list-style: none; cursor: pointer; display: flex; align-items: center; padding: 12px 14px; background: #f8fbff; border-bottom: 1px solid var(--line); }
    .scenario > summary::-webkit-details-marker { display: none; }
    .scenario > summary::before { content: '+'; margin-right: 10px; font-weight: 700; color: var(--accent); width: 12px; text-align: center; }
    .scenario[open] > summary::before { content: '-'; }
    .scenario .subnote, .scenario h4, .scenario table { margin-left: 14px; margin-right: 14px; }
    .scenario .subnote:first-of-type { margin-top: 12px; }
    .scenario table:last-child { margin-bottom: 14px; }
    h3 { margin: 0 0 6px; color: var(--accent); }
    h4 { margin: 14px 0 6px; }
    .name { color: var(--muted); font-weight: 500; margin-left: 8px; }
    .subnote { margin: 0 0 8px; color: var(--muted); font-size: 13px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
    th, td { border-bottom: 1px solid var(--line); padding: 8px 9px; text-align: center; font-size: 13px; }
    th { background: #f2f7ff; color: #153a5d; }
    .num { text-align: center; font-variant-numeric: tabular-nums; }
    .ok { color: var(--ok); font-weight: 700; }
    .warn { color: var(--warn); font-weight: 700; }
    .warn-text { color: var(--warn); font-size: 13px; }
    .variance-wrap { display: inline-flex; align-items: center; justify-content: flex-start; min-width: 68px; margin-left: 6px; vertical-align: middle; }
    .variance-bar { display: inline-block; height: 10px; border-radius: 999px; opacity: .9; }
    .input-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; margin: 0 14px 10px; }
    .input-group { background: #f8fbff; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
    .input-group h5 { margin: 0; padding: 8px 10px; background: #eef5ff; color: #153a5d; font-size: 12px; letter-spacing: .3px; text-transform: uppercase; }
    .input-group table { margin: 0; }
    .input-group td { padding: 6px 8px; font-size: 12px; }
    .input-group td:first-child { text-align: left; }
    .input-group td:last-child { width: 38%; }
    .missing { background: #fff7ed; border: 1px solid #fed7aa; color: #9a3412; border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Forecast vs Simulation Comparison Report</h1>
    <p class="intro">Veeam Calculator values, Forecaster estimates, and Simulator day snapshots for Year 1/2/3. No parser rerun required.</p>
    <div class="meta">
      <p><strong>Generated:</strong> ${esc(now)}</p>
      <p><strong>Captured Forecast Period (baseline defaults):</strong> ${usedForecast} year(s)</p>
      <p><strong>Year Alignment Rule:</strong> Year anniversary date snapped to last Saturday on or before that date.</p>
      <p><strong>Scenarios Included:</strong> ${found.length}</p>
    </div>
    <div class="controls">
      <label for="scenario-search">Scenario Filter:</label>
      <input id="scenario-search" type="text" placeholder="Type scenario id or name" />
      <label for="repo-filter">Repository:</label>
      <select id="repo-filter">
        <option value="ALL">All</option>
        <option value="DAS">DAS</option>
        <option value="SOBR">SOBR</option>
      </select>
      <button id="expand-all" type="button">Expand All</button>
      <button id="collapse-all" type="button">Collapse All</button>
      <span id="filter-count" class="subnote" style="margin:0;">Showing ${found.length} of ${found.length}</span>
    </div>
    ${missingList}
    ${sections}
  </div>
  <script>
    (function () {
      const search = document.getElementById('scenario-search');
      const repoFilter = document.getElementById('repo-filter');
      const countEl = document.getElementById('filter-count');
      const expandAllBtn = document.getElementById('expand-all');
      const collapseAllBtn = document.getElementById('collapse-all');
      const scenarios = Array.from(document.querySelectorAll('details.scenario'));

      function applyFilters() {
        const q = ((search && search.value) || '').trim().toLowerCase();
        const repo = (repoFilter && repoFilter.value) || 'ALL';
        let shown = 0;

        scenarios.forEach((sc) => {
          const id = (sc.getAttribute('data-scenario-id') || '').toLowerCase();
          const repoType = sc.getAttribute('data-repository-type') || '';
          const nameEl = sc.querySelector('summary .name');
          const name = nameEl ? nameEl.textContent.toLowerCase() : '';
          const qMatch = q === '' || id.includes(q) || name.includes(q);
          const repoMatch = repo === 'ALL' || repoType === repo;
          const visible = qMatch && repoMatch;
          sc.style.display = visible ? '' : 'none';
          if (visible) shown += 1;
        });

        if (countEl) {
          countEl.textContent = 'Showing ' + shown + ' of ' + scenarios.length;
        }
      }

      if (search) search.addEventListener('input', applyFilters);
      if (repoFilter) repoFilter.addEventListener('change', applyFilters);

      if (expandAllBtn) {
        expandAllBtn.addEventListener('click', function () {
          scenarios.forEach((sc) => {
            if (sc.style.display !== 'none') sc.open = true;
          });
        });
      }

      if (collapseAllBtn) {
        collapseAllBtn.addEventListener('click', function () {
          scenarios.forEach((sc) => {
            if (sc.style.display !== 'none') sc.open = false;
          });
        });
      }

      applyFilters();
    })();
  </script>
</body>
</html>`;
}

function main(): void {
  const baselinePath = path.join(__dirname, '../../docs/veeam-calculator-baseline.json');
  const reportPath = path.join(__dirname, '../../docs/forecast-vs-simulation-report.html');

  if (!fs.existsSync(baselinePath)) {
    throw new Error('Missing docs/veeam-calculator-baseline.json');
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as BaselineFile;
  const scenarios = loadScenarios();

  const idArgIndex = process.argv.indexOf('--id');
  const idArg = idArgIndex >= 0 ? process.argv[idArgIndex + 1] : '';
  const selectedIds = new Set(
    idArg
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );

  const html = buildHtml(baseline, scenarios, selectedIds);
  fs.writeFileSync(reportPath, html, 'utf-8');

  console.log(`\nGenerated report: docs/forecast-vs-simulation-report.html`);
  console.log(`Scenarios loaded: ${scenarios.length}`);
  console.log(`Baseline scenarios: ${baseline.scenarios.length}`);
  if (selectedIds.size > 0) {
    console.log(`Filtered IDs: ${[...selectedIds].join(', ')}`);
  }
}

main();
