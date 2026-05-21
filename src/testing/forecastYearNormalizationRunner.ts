import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { normalizeForecastYears } from '../models/forecast.ts';
import { computeSimulatorPlanned, ScenarioConfig } from '../models/plannedCapacityCalculator.ts';

type Status = 'pass' | 'fail';

interface CaseResult {
  id: string;
  status: Status;
  description: string;
  expected: string;
  actual: string;
}

interface ForecastNormalizationReport {
  generatedAt: string;
  status: 'PASS' | 'FAIL';
  totalCases: number;
  passedCases: number;
  failedCases: number;
  cases: CaseResult[];
}

const START_DATE = '2026-05-21';
const EPSILON = 1e-9;
const results: CaseResult[] = [];

function resolveStableGeneratedAt(reportPath: string): string {
  const override = process.env.REPORT_GENERATED_AT?.trim();
  if (override) return override;

  if (existsSync(reportPath)) {
    try {
      const existing = JSON.parse(readFileSync(reportPath, 'utf8')) as Partial<ForecastNormalizationReport>;
      if (typeof existing.generatedAt === 'string' && existing.generatedAt.length > 0) {
        return existing.generatedAt;
      }
    } catch {
      // Fall through to a fresh timestamp.
    }
  }

  return new Date().toISOString();
}

function pushCase(id: string, description: string, expected: string, actual: string, ok: boolean): void {
  results.push({
    id,
    status: ok ? 'pass' : 'fail',
    description,
    expected,
    actual,
  });
}

function assertEqual(id: string, description: string, expected: number, actual: number): void {
  pushCase(id, description, `${expected}`, `${actual}`, expected === actual);
}

function assertAlmostEqual(id: string, description: string, expected: number, actual: number): void {
  const delta = Math.abs(expected - actual);
  pushCase(id, description, `delta <= ${EPSILON}`, `delta=${delta.toExponential(3)}`, delta <= EPSILON);
}

function assertDifferent(id: string, description: string, left: number, right: number): void {
  const delta = Math.abs(left - right);
  pushCase(id, description, `delta > ${EPSILON}`, `delta=${delta.toExponential(3)}`, delta > EPSILON);
}

function runNormalizationChecks(): void {
  assertEqual('normalize-undefined', 'Undefined forecast defaults to year 1', 1, normalizeForecastYears(undefined));
  assertEqual('normalize-null', 'Null forecast defaults to year 1', 1, normalizeForecastYears(null));
  assertEqual('normalize-zero', 'Year 0 normalizes to year 1', 1, normalizeForecastYears(0));
  assertEqual('normalize-negative', 'Negative forecast normalizes to year 1', 1, normalizeForecastYears(-3));
  assertEqual('normalize-decimal', 'Decimal forecast is floored after normalization', 2, normalizeForecastYears(2.9));
}

function runPlannerRegressionCheck(): void {
  const scenario: ScenarioConfig = {
    repositoryType: 'DAS',
    jobType: 'ForwardIncremental',
    sourceDataTB: 10,
    annualGrowthRatePct: 10,
    dailyChangeRatePct: 5,
    retention: 14,
    gfsPolicy: { weekly: 4, monthly: 3, yearly: 2 },
    offloadAfterDays: 14,
    archiveAfterDays: 90,
    generationPeriodDays: 10,
    performanceImmutabilityDays: 7,
    capacityImmutabilityDays: 0,
    archiveImmutabilityDays: 0,
    hasArchiveTier: false,
    copyEnabled: false,
    moveEnabled: false,
  };

  const normalizedForecast = normalizeForecastYears(0);
  const year0 = computeSimulatorPlanned(scenario, START_DATE, 0, 'reverse');
  const year1 = computeSimulatorPlanned(scenario, START_DATE, 1, 'reverse');
  const normalized = computeSimulatorPlanned(scenario, START_DATE, normalizedForecast, 'reverse');

  assertEqual('normalized-forecast-value', 'Forecast 0 normalizes to forecast year 1', 1, normalizedForecast);
  assertAlmostEqual(
    'normalized-matches-year1-total',
    'Normalized forecast produces the same planned total capacity as year 1',
    year1.plannedCapacityTB,
    normalized.plannedCapacityTB,
  );
  assertAlmostEqual(
    'normalized-matches-year1-gfs',
    'Normalized forecast produces the same GFS storage as year 1',
    year1.gfsStorageTB,
    normalized.gfsStorageTB,
  );
  assertDifferent(
    'year0-differs-year1-total',
    'Year 0 and year 1 planned total capacity remain distinct for this growth scenario',
    year0.plannedCapacityTB,
    year1.plannedCapacityTB,
  );
}

function writeReportAndExit(): void {
  const passedCases = results.filter((result) => result.status === 'pass').length;
  const failedCases = results.length - passedCases;
  const reportPath = join(process.cwd(), 'docs', 'forecast-year-normalization-report.json');
  const report: ForecastNormalizationReport = {
    generatedAt: resolveStableGeneratedAt(reportPath),
    status: failedCases === 0 ? 'PASS' : 'FAIL',
    totalCases: results.length,
    passedCases,
    failedCases,
    cases: results,
  };

  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  if (failedCases > 0) {
    const firstFailure = results.find((result) => result.status === 'fail');
    throw new Error(
      `Forecast normalization checks failed (${failedCases}/${results.length}). First failure: ${firstFailure?.id}`,
    );
  }
}

function main(): void {
  runNormalizationChecks();
  runPlannerRegressionCheck();
  writeReportAndExit();
  console.log('Forecast normalization regression checks passed.');
}

main();