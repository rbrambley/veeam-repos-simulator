import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { computeSimulatorPlanned, ScenarioConfig } from '../models/plannedCapacityCalculator.ts';
import { computeVeeamWorkingSpaceTB } from '../models/veeam.ts';

type Status = 'pass' | 'fail';

interface GeneralizationCaseResult {
  id: string;
  status: Status;
  description: string;
  expected: string;
  actual: string;
}

interface GeneralizationReport {
  generatedAt: string;
  status: 'PASS' | 'FAIL';
  totalCases: number;
  passedCases: number;
  failedCases: number;
  cases: GeneralizationCaseResult[];
}

interface ScenarioShape {
  id: string;
  description: string;
  config: Omit<ScenarioConfig, 'sourceDataTB'>;
}

const START_DATE = '2026-05-21';
const SOURCE_VOLUMES_TB = [1, 5, 27, 211];
const FORECAST_YEARS = [0, 1, 3];
const PROPORTIONAL_TOLERANCE = 0.0005;

const results: GeneralizationCaseResult[] = [];

function resolveStableGeneratedAt(reportPath: string): string {
  const override = process.env.REPORT_GENERATED_AT?.trim();
  if (override) return override;

  if (existsSync(reportPath)) {
    try {
      const existing = JSON.parse(readFileSync(reportPath, 'utf8')) as Partial<GeneralizationReport>;
      if (typeof existing.generatedAt === 'string' && existing.generatedAt.length > 0) {
        return existing.generatedAt;
      }
    } catch {
      // fall through to new timestamp
    }
  }

  return new Date().toISOString();
}

function pushCase(
  id: string,
  description: string,
  expected: string,
  actual: string,
  ok: boolean
): void {
  results.push({
    id,
    status: ok ? 'pass' : 'fail',
    description,
    expected,
    actual,
  });
}

function assertProportional(
  id: string,
  description: string,
  baseValue: number,
  candidateValue: number,
  ratio: number
): void {
  const expected = baseValue * ratio;
  const delta = Math.abs(candidateValue - expected);
  const allowed = Math.max(Math.abs(expected), 1) * PROPORTIONAL_TOLERANCE;
  pushCase(
    id,
    description,
    `|actual - expected| <= ${allowed.toExponential(3)} (expected=${expected.toFixed(6)})`,
    `actual=${candidateValue.toFixed(6)} delta=${delta.toExponential(3)}`,
    delta <= allowed
  );
}

function runShapeChecks(shape: ScenarioShape): void {
  for (const forecastYears of FORECAST_YEARS) {
    const baseSourceTB = SOURCE_VOLUMES_TB[0];
    const baseConfig: ScenarioConfig = { ...shape.config, sourceDataTB: baseSourceTB };
    const baseResult = computeSimulatorPlanned(baseConfig, START_DATE, forecastYears, 'growth');
    const baseWs = computeVeeamWorkingSpaceTB(baseSourceTB);

    const baseStoredDas = baseResult.plannedCapacityTB - baseWs;
    const basePerfNoWs = baseResult.plannedPerformanceTierTB - baseWs;

    for (const sourceDataTB of SOURCE_VOLUMES_TB.slice(1)) {
      const config: ScenarioConfig = { ...shape.config, sourceDataTB };
      const candidate = computeSimulatorPlanned(config, START_DATE, forecastYears, 'growth');
      const ws = computeVeeamWorkingSpaceTB(sourceDataTB);
      const ratio = sourceDataTB / baseSourceTB;

      assertProportional(
        `${shape.id}-year${forecastYears}-src${sourceDataTB}-full`,
        `${shape.description}: full file size scales with source size`,
        baseResult.fileTypeFullTB,
        candidate.fileTypeFullTB,
        ratio
      );

      assertProportional(
        `${shape.id}-year${forecastYears}-src${sourceDataTB}-incr`,
        `${shape.description}: incremental file size scales with source size`,
        baseResult.fileTypeIncrementalTB,
        candidate.fileTypeIncrementalTB,
        ratio
      );

      assertProportional(
        `${shape.id}-year${forecastYears}-src${sourceDataTB}-synth`,
        `${shape.description}: synthetic full file size scales with source size`,
        baseResult.fileTypeSyntheticFullTB,
        candidate.fileTypeSyntheticFullTB,
        ratio
      );

      if (shape.config.repositoryType === 'DAS') {
        const storedDas = candidate.plannedCapacityTB - ws;
        assertProportional(
          `${shape.id}-year${forecastYears}-src${sourceDataTB}-das-stored`,
          `${shape.description}: DAS stored footprint (excluding WS) scales with source size`,
          baseStoredDas,
          storedDas,
          ratio
        );
      } else {
        const perfNoWs = candidate.plannedPerformanceTierTB - ws;
        assertProportional(
          `${shape.id}-year${forecastYears}-src${sourceDataTB}-sobr-perf-nows`,
          `${shape.description}: SOBR performance footprint (excluding WS) scales with source size`,
          basePerfNoWs,
          perfNoWs,
          ratio
        );

        assertProportional(
          `${shape.id}-year${forecastYears}-src${sourceDataTB}-sobr-cap`,
          `${shape.description}: SOBR capacity tier scales with source size`,
          baseResult.plannedCapacityTierTB,
          candidate.plannedCapacityTierTB,
          ratio
        );

        assertProportional(
          `${shape.id}-year${forecastYears}-src${sourceDataTB}-sobr-arch`,
          `${shape.description}: SOBR archive tier scales with source size`,
          baseResult.plannedArchiveTierTB,
          candidate.plannedArchiveTierTB,
          ratio
        );
      }
    }
  }
}

function writeReportAndExit(): void {
  const passedCases = results.filter((r) => r.status === 'pass').length;
  const failedCases = results.length - passedCases;
  const reportPath = join(process.cwd(), 'docs', 'generalization-report.json');
  const report: GeneralizationReport = {
    generatedAt: resolveStableGeneratedAt(reportPath),
    status: failedCases === 0 ? 'PASS' : 'FAIL',
    totalCases: results.length,
    passedCases,
    failedCases,
    cases: results,
  };

  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  if (failedCases > 0) {
    const firstFailure = results.find((r) => r.status === 'fail');
    throw new Error(
      `Generalization checks failed (${failedCases}/${results.length}). First failure: ${firstFailure?.id}`
    );
  }
}

function main(): void {
  const shapes: ScenarioShape[] = [
    {
      id: 'das-wmy-growth-r14',
      description: 'DAS W+M+Y growth retention14',
      config: {
        repositoryType: 'DAS',
        jobType: 'ForwardIncremental',
        annualGrowthRatePct: 5,
        dailyChangeRatePct: 5,
        retention: 14,
        gfsPolicy: { weekly: 4, monthly: 3, yearly: 2 },
        offloadAfterDays: 14,
        archiveAfterDays: 14,
        generationPeriodDays: 10,
        performanceImmutabilityDays: 7,
        capacityImmutabilityDays: 0,
        archiveImmutabilityDays: 0,
        hasArchiveTier: false,
        copyEnabled: false,
        moveEnabled: false,
      },
    },
    {
      id: 'sobr-moveonly-nogfs-r30',
      description: 'SOBR move-only no-GFS retention30',
      config: {
        repositoryType: 'SOBR',
        jobType: 'ForwardIncremental',
        annualGrowthRatePct: 0,
        dailyChangeRatePct: 5,
        retention: 30,
        gfsPolicy: { weekly: 0, monthly: 0, yearly: 0 },
        offloadAfterDays: 14,
        archiveAfterDays: 14,
        generationPeriodDays: 10,
        performanceImmutabilityDays: 7,
        capacityImmutabilityDays: 0,
        archiveImmutabilityDays: 0,
        hasArchiveTier: true,
        copyEnabled: false,
        moveEnabled: true,
      },
    },
    {
      id: 'sobr-copymove-nogfs-r21-growth',
      description: 'SOBR copy+move no-GFS retention21 growth',
      config: {
        repositoryType: 'SOBR',
        jobType: 'ForwardIncremental',
        annualGrowthRatePct: 5,
        dailyChangeRatePct: 5,
        retention: 21,
        gfsPolicy: { weekly: 0, monthly: 0, yearly: 0 },
        offloadAfterDays: 7,
        archiveAfterDays: 14,
        generationPeriodDays: 10,
        performanceImmutabilityDays: 7,
        capacityImmutabilityDays: 0,
        archiveImmutabilityDays: 0,
        hasArchiveTier: true,
        copyEnabled: true,
        moveEnabled: true,
      },
    },
    {
      id: 'sobr-copyonly-wmy-r60',
      description: 'SOBR copy-only W+M+Y retention60',
      config: {
        repositoryType: 'SOBR',
        jobType: 'ForwardIncremental',
        annualGrowthRatePct: 0,
        dailyChangeRatePct: 5,
        retention: 60,
        gfsPolicy: { weekly: 4, monthly: 3, yearly: 2 },
        offloadAfterDays: 14,
        archiveAfterDays: 14,
        generationPeriodDays: 10,
        performanceImmutabilityDays: 7,
        capacityImmutabilityDays: 0,
        archiveImmutabilityDays: 0,
        hasArchiveTier: true,
        copyEnabled: true,
        moveEnabled: false,
      },
    },
  ];

  for (const shape of shapes) {
    runShapeChecks(shape);
  }

  writeReportAndExit();
  console.log('Generalization behavior checks passed.');
}

main();
