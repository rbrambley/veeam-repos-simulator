import { CalculateGfsSize, VeeamSimulator } from '../simulator/engine.ts';
import { BackupJob, BackupChain, Repository, SimulationState } from '../models/veeam.ts';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

type GfsSizingTestCategory =
  | 'modifier-boundary'
  | 'weekly-range'
  | 'monthly-range'
  | 'yearly-range'
  | 'extreme-case'
  | 'engine-integration';

interface GfsSizingCaseResult {
  id: string;
  category: GfsSizingTestCategory;
  status: 'pass' | 'fail';
  description: string;
  expected: string;
  actual: string;
}

interface GfsSizingReport {
  generatedAt: string;
  status: 'PASS' | 'FAIL';
  totalCases: number;
  passedCases: number;
  failedCases: number;
  cases: GfsSizingCaseResult[];
}

const results: GfsSizingCaseResult[] = [];

function resolveStableGeneratedAt(reportPath: string): string {
  const override = process.env.REPORT_GENERATED_AT?.trim();
  if (override) {
    return override;
  }

  if (existsSync(reportPath)) {
    try {
      const existing = JSON.parse(readFileSync(reportPath, 'utf8')) as Partial<GfsSizingReport>;
      if (typeof existing.generatedAt === 'string' && existing.generatedAt.length > 0) {
        return existing.generatedAt;
      }
    } catch {
      // Ignore stale or malformed report content and fall back to current time.
    }
  }

  return new Date().toISOString();
}

function recordNumericCase(
  id: string,
  category: GfsSizingTestCategory,
  description: string,
  expected: number,
  actual: number,
  tolerance = 1e-9
): void {
  const ok = Math.abs(actual - expected) <= tolerance;
  results.push({
    id,
    category,
    status: ok ? 'pass' : 'fail',
    description,
    expected: expected.toFixed(9),
    actual: actual.toFixed(9),
  });
}

function recordBooleanCase(
  id: string,
  category: GfsSizingTestCategory,
  description: string,
  expected: boolean,
  actual: boolean
): void {
  const ok = actual === expected;
  results.push({
    id,
    category,
    status: ok ? 'pass' : 'fail',
    description,
    expected: String(expected),
    actual: String(actual),
  });
}

function writeReportAndFailIfNeeded(): void {
  const passedCases = results.filter(r => r.status === 'pass').length;
  const failedCases = results.length - passedCases;
  const reportPath = join(process.cwd(), 'docs', 'gfs-sizing-report.json');
  const report: GfsSizingReport = {
    generatedAt: resolveStableGeneratedAt(reportPath),
    status: failedCases === 0 ? 'PASS' : 'FAIL',
    totalCases: results.length,
    passedCases,
    failedCases,
    cases: results,
  };

  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  if (failedCases > 0) {
    const firstFailure = results.find(r => r.status === 'fail');
    throw new Error(`GFS sizing validation failed (${failedCases}/${results.length} failed). First failure: ${firstFailure?.id} (${firstFailure?.description}) expected=${firstFailure?.expected} actual=${firstFailure?.actual}`);
  }
}

function runModifierBoundaryTests(): void {
  const base = 100;
  const rate = 0.1;

  const cases = [
    { age: 2, expectedModifier: 1 },
    { age: 14, expectedModifier: 1 },
    { age: 38, expectedModifier: 3 },
    { age: 100, expectedModifier: 5 },
    { age: 193, expectedModifier: 9 },
    { age: 286, expectedModifier: 12 },
    { age: 379, expectedModifier: 15 },
    { age: 1095, expectedModifier: 18 },
  ];

  for (const test of cases) {
    const expected = base * (1 + rate * test.expectedModifier);
    const actual = CalculateGfsSize(base, rate, test.age);
    recordNumericCase(
      `modifier-boundary-${test.age}`,
      'modifier-boundary',
      `Boundary age ${test.age} uses expected modifier ${test.expectedModifier}`,
      expected,
      actual
    );
  }
}

function runWeeklyRangeTests(): void {
  const base = 10;
  const rate = 0.05;

  recordNumericCase('weekly-age-7', 'weekly-range', 'Weekly range age 7', base * (1 + rate * 1), CalculateGfsSize(base, rate, 7));
  recordNumericCase('weekly-age-21', 'weekly-range', 'Weekly range age 21', base * (1 + rate * 3), CalculateGfsSize(base, rate, 21));
  recordNumericCase('weekly-age-28', 'weekly-range', 'Weekly range age 28', base * (1 + rate * 3), CalculateGfsSize(base, rate, 28));
}

function runMonthlyRangeTests(): void {
  const base = 10;
  const rate = 0.05;

  recordNumericCase('monthly-age-30', 'monthly-range', 'Monthly range age 30', base * (1 + rate * 3), CalculateGfsSize(base, rate, 30));
  recordNumericCase('monthly-age-60', 'monthly-range', 'Monthly range age 60', base * (1 + rate * 5), CalculateGfsSize(base, rate, 60));
  recordNumericCase('monthly-age-90', 'monthly-range', 'Monthly range age 90', base * (1 + rate * 5), CalculateGfsSize(base, rate, 90));
}

function runYearlyRangeTests(): void {
  const base = 10;
  const rate = 0.05;

  recordNumericCase('yearly-age-365', 'yearly-range', 'Yearly range age 365', base * (1 + rate * 15), CalculateGfsSize(base, rate, 365));
}

function runExtremeCaseTests(): void {
  const base = 10;
  const rate = 0.05;

  recordNumericCase('extreme-age-1096', 'extreme-case', 'Extreme case age 1096 uses 1000 modifier tier', base * (1 + rate * 1000), CalculateGfsSize(base, rate, 1096));
}

function buildState(gfsPolicy: { weekly: number; monthly: number; yearly: number }): SimulationState {
  const repository: Repository = {
    id: 'repo-1',
    name: 'Repo',
    type: 'DAS',
    capacityTB: 500,
  };

  const job: BackupJob = {
    id: 'job-1',
    name: 'Job',
    type: 'ForwardIncremental',
    repositoryId: repository.id,
    sourceDataTB: 13.32,
    dailyChangeRatePct: 10,
    annualGrowthRatePct: 0,
    forecastYears: 1,
    schedule: {
      frequency: 'Daily',
      timeOfDay: '02:00',
      syntheticFullDay: 6,
    },
    retention: {
      restorePoints: 30,
      slaDays: 30,
    },
    gfsPolicy,
  };

  const chain: BackupChain = {
    id: 'chain-1',
    jobId: job.id,
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
    date: '2026-05-02',
    startDate: '2026-05-02',
  };
}

function runEngineIntegrationTests(): void {
  const weeklyDate = new Date('2026-05-09T00:00:00.000Z'); // Saturday
  const monthlyDate = new Date('2026-05-30T00:00:00.000Z'); // Last Saturday of month
  const yearlyDate = new Date('2026-12-26T00:00:00.000Z'); // Last Saturday of December

  {
    const sim = new VeeamSimulator(buildState({ weekly: 4, monthly: 0, yearly: 0 }));
    const job = sim.state.jobs[0];
    const rp = sim.createRestorePoint(job, weeklyDate, 'SyntheticFull');
    sim.tagGFSRestorePoint(job, rp, weeklyDate, []);
    recordBooleanCase('integration-weekly-flag', 'engine-integration', 'Weekly integration applies weekly GFS tag', true, !!rp.isWeeklyGFS);
    const expected = 6.66;
    recordNumericCase('integration-weekly-size', 'engine-integration', 'Weekly integration uses expected inflated size', expected, rp.sizeGB);
  }

  {
    const sim = new VeeamSimulator(buildState({ weekly: 0, monthly: 3, yearly: 0 }));
    const job = sim.state.jobs[0];
    const rp = sim.createRestorePoint(job, monthlyDate, 'SyntheticFull');
    sim.tagGFSRestorePoint(job, rp, monthlyDate, []);
    recordBooleanCase('integration-monthly-flag', 'engine-integration', 'Monthly integration applies monthly GFS tag', true, !!rp.isMonthlyGFS);
    const expected = 6.66; // Full backup size - tag doesn't reduce physical size
    recordNumericCase('integration-monthly-size', 'engine-integration', 'Monthly integration uses full backup size', expected, rp.sizeGB);
  }

  {
    const sim = new VeeamSimulator(buildState({ weekly: 0, monthly: 0, yearly: 2 }));
    const job = sim.state.jobs[0];
    const rp = sim.createRestorePoint(job, yearlyDate, 'SyntheticFull');
    sim.tagGFSRestorePoint(job, rp, yearlyDate, []);
    recordBooleanCase('integration-yearly-flag', 'engine-integration', 'Yearly integration applies yearly GFS tag', true, !!rp.isYearlyGFS);
    const expected = 6.66; // Full backup size - tag doesn't reduce physical size
    recordNumericCase('integration-yearly-size', 'engine-integration', 'Yearly integration uses full backup size', expected, rp.sizeGB);
  }

  {
    const sim = new VeeamSimulator(buildState({ weekly: 4, monthly: 0, yearly: 0 }));
    const job = sim.state.jobs[0];
    job.annualGrowthRatePct = 10;
    const laterWeeklyDate = new Date('2027-05-08T00:00:00.000Z'); // Saturday ~1 year later
    const rp = sim.createRestorePoint(job, laterWeeklyDate, 'SyntheticFull');
    sim.tagGFSRestorePoint(job, rp, laterWeeklyDate, []);
    const startDate = new Date(`${sim.state.startDate}T00:00:00.000Z`);
    const elapsedDays = (laterWeeklyDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
    const expected = 13.32 * Math.pow(1 + 0.1, elapsedDays / 365) * 0.5;
    recordNumericCase(
      'integration-weekly-size-growth',
      'engine-integration',
      'Weekly integration scales with annual growth at point date',
      expected,
      rp.sizeGB,
      1e-6,
    );
  }
}

function main(): void {
  runModifierBoundaryTests();
  runWeeklyRangeTests();
  runMonthlyRangeTests();
  runYearlyRangeTests();
  runExtremeCaseTests();
  runEngineIntegrationTests();

  writeReportAndFailIfNeeded();

  console.log('GFS sizing model validation passed.');
}

main();
