/**
 * triWayReport.ts
 *
 * Generates an HTML report comparing three data sources at every 3-month
 * (90-day) interval over a 3-year (1080-day) forecast period:
 *
 *   1. Simulator  — actual engine output (VeeamSimulator run day-by-day)
 *   2. Forecast   — mathematical prediction (computeSimulatorPlanned)
 *   3. Veeam Calc — captured calculator value at Year 3 (reference point)
 *
 * Five diverse scenarios are included to cover the main model dimensions:
 *   das-basic                     — DAS, no GFS, small
 *   das-monthly-2-small-r7        — DAS, monthly GFS, small
 *   das-yearly-2-large-r7         — DAS, yearly GFS, large
 *   sobr-moveonly                 — SOBR move-only, no GFS
 *   sobr-mixed-2w1m1y-small-r60   — SOBR move+archive, full W+M+Y GFS
 *
 * Usage:  npx tsx src/testing/triWayReport.ts
 * Output: docs/quarterly-comparison-report.html
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { VeeamSimulator } from '../simulator/engine.ts';
import type {
  BackupJob,
  Repository,
  SimulationState,
} from '../models/veeam.ts';
import { computeVeeamWorkingSpaceTB } from '../models/veeam.ts';
import { computeForecastGfsStatsAtYear } from '../models/gfsSizing.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const START_DATE = '2026-05-02';
const TOTAL_DAYS = 1080; // 12 quarters × 90 days
const QUARTER_DAYS = 90;
const QUARTERS = 12;

interface BaselineExpected {
  plannedCapacityTB?: number;
  plannedPerformanceTierTB?: number;
  plannedCapacityTierTB?: number;
  plannedArchiveTierTB?: number;
  veeamWorkingSpaceTB?: number;
  fileTypeFullTB?: number;
  fileTypeIncrementalTB?: number;
  fileTypeSyntheticFullTB?: number;
  gfsWeeklyTB?: number;
  gfsMonthlyTB?: number;
  gfsYearlyTB?: number;
}

interface BaselineFile {
  scenarios: Array<{ id: string; notes?: string; expected: BaselineExpected }>;
}

interface BaselineScenarioData {
  expected: BaselineExpected;
  notes?: string;
}

interface CalcDataQuality {
  parsedFields: number;
  expectedFields: number;
  missingFields: string[];
  quality: 'high' | 'medium' | 'low';
  note?: string;
  capturedDate?: string;
}

type AgeBucketKey =
  | 'ageLe14TB'
  | 'age15To38TB'
  | 'age39To100TB'
  | 'age101To193TB'
  | 'age194To286TB'
  | 'age287To379TB'
  | 'age380PlusTB';

const AGE_BUCKETS: Array<{ key: AgeBucketKey; label: string }> = [
  { key: 'ageLe14TB', label: '<=14d' },
  { key: 'age15To38TB', label: '15-38d' },
  { key: 'age39To100TB', label: '39-100d' },
  { key: 'age101To193TB', label: '101-193d' },
  { key: 'age194To286TB', label: '194-286d' },
  { key: 'age287To379TB', label: '287-379d' },
  { key: 'age380PlusTB', label: '380+d' },
];

function loadCalculatorBaselineMap(): Map<string, BaselineScenarioData> {
  const baselinePath = path.join(__dirname, '../../docs/veeam-calculator-baseline.json');
  try {
    const raw = fs.readFileSync(baselinePath, 'utf8');
    const parsed = JSON.parse(raw) as BaselineFile;
    return new Map(parsed.scenarios.map((s) => [s.id, { expected: s.expected ?? {}, notes: s.notes }]));
  } catch {
    return new Map();
  }
}

const CALC_BASELINE_MAP = loadCalculatorBaselineMap();

// ---------------------------------------------------------------------------
// Scenario definitions (configs + Veeam Calculator Year-3 reference values)
// ---------------------------------------------------------------------------

interface ScenarioConfig {
  repositoryType: 'DAS' | 'SOBR';
  sourceDataTB: number;
  annualGrowthRatePct: number;
  dailyChangeRatePct: number;
  retention: number;
  gfsPolicy: { weekly: number; monthly: number; yearly: number };
  offloadAfterDays: number;
  archiveAfterDays: number;
  hasArchiveTier: boolean;
  copyEnabled: boolean;
  moveEnabled: boolean;
  generationPeriodDays?: number;
}

interface VeeamCalcRef {
  totalTB: number;
  perfTB?: number;
  capTB?: number;
  archTB?: number;
  wsTB?: number;
  fileTypeFullTB?: number;
  fileTypeIncrTB?: number;
  fileTypeSyntheticFullTB?: number;
  gfsWeeklyTB?: number;
  gfsMonthlyTB?: number;
  gfsYearlyTB?: number;
}

interface ReportScenario {
  id: string;
  name: string;
  config: ScenarioConfig;
  veeamCalcY3: VeeamCalcRef;
  calcDataQuality?: CalcDataQuality;
}

const REPORT_SCENARIOS: ReportScenario[] = [
  {
    id: 'das-basic',
    name: 'DAS Basic — 1TB, 7d retention, no GFS',
    config: {
      repositoryType: 'DAS',
      sourceDataTB: 1,
      annualGrowthRatePct: 10,
      dailyChangeRatePct: 5,
      retention: 7,
      gfsPolicy: { weekly: 0, monthly: 0, yearly: 0 },
      offloadAfterDays: 7,
      archiveAfterDays: 14,
      hasArchiveTier: false,
      copyEnabled: false,
      moveEnabled: false,
    },
    veeamCalcY3: { totalTB: 1.6 },
  },
  {
    id: 'das-monthly-2-small-r7',
    name: 'DAS Monthly GFS — 1TB, 7d retention, 2 monthly',
    config: {
      repositoryType: 'DAS',
      sourceDataTB: 1,
      annualGrowthRatePct: 0,
      dailyChangeRatePct: 5,
      retention: 7,
      gfsPolicy: { weekly: 0, monthly: 2, yearly: 0 },
      offloadAfterDays: 7,
      archiveAfterDays: 14,
      hasArchiveTier: false,
      copyEnabled: false,
      moveEnabled: false,
    },
    veeamCalcY3: { totalTB: 1.6 },
  },
  {
    id: 'das-yearly-2-large-r7',
    name: 'DAS Yearly GFS — 13.32TB, 7d retention, 2 yearly',
    config: {
      repositoryType: 'DAS',
      sourceDataTB: 13.32,
      annualGrowthRatePct: 0,
      dailyChangeRatePct: 10,
      retention: 7,
      gfsPolicy: { weekly: 0, monthly: 0, yearly: 2 },
      offloadAfterDays: 7,
      archiveAfterDays: 14,
      hasArchiveTier: false,
      copyEnabled: false,
      moveEnabled: false,
    },
    veeamCalcY3: { totalTB: 35 },
  },
  {
    id: 'sobr-moveonly',
    name: 'SOBR Move-Only — 1TB, 14d retention, no GFS',
    config: {
      repositoryType: 'SOBR',
      sourceDataTB: 1,
      annualGrowthRatePct: 10,
      dailyChangeRatePct: 5,
      retention: 14,
      gfsPolicy: { weekly: 0, monthly: 0, yearly: 0 },
      offloadAfterDays: 7,
      archiveAfterDays: 14,
      hasArchiveTier: false,
      copyEnabled: false,
      moveEnabled: true,
    },
    veeamCalcY3: { totalTB: 1.6, perfTB: 1.6, capTB: 1.3, archTB: 0 },
  },
  {
    id: 'sobr-mixed-2w1m1y-small-r60',
    name: 'SOBR Mixed GFS — 1TB, 60d retention, 2W+1M+1Y, archive tier',
    config: {
      repositoryType: 'SOBR',
      sourceDataTB: 1,
      annualGrowthRatePct: 10,
      dailyChangeRatePct: 5,
      retention: 60,
      gfsPolicy: { weekly: 2, monthly: 1, yearly: 1 },
      offloadAfterDays: 14,
      archiveAfterDays: 30,
      hasArchiveTier: true,
      copyEnabled: false,
      moveEnabled: true,
    },
    veeamCalcY3: { totalTB: 1.6, perfTB: 1.6, capTB: 3.0, archTB: 0.7 },
  },
];

function withBaselineCalcRef(sc: ReportScenario): ReportScenario {
  const baseline = CALC_BASELINE_MAP.get(sc.id);
  if (!baseline) {
    return {
      ...sc,
      calcDataQuality: {
        parsedFields: 0,
        expectedFields: sc.config.repositoryType === 'SOBR' ? 11 : 8,
        missingFields: ['baseline-entry-missing'],
        quality: 'low',
      },
    };
  }

  const expected = baseline.expected;
  const requiredFields = [
    'plannedCapacityTB',
    'veeamWorkingSpaceTB',
    'fileTypeFullTB',
    'fileTypeIncrementalTB',
    'fileTypeSyntheticFullTB',
    'gfsWeeklyTB',
    'gfsMonthlyTB',
    'gfsYearlyTB',
    ...(sc.config.repositoryType === 'SOBR' ? ['plannedPerformanceTierTB', 'plannedCapacityTierTB', 'plannedArchiveTierTB'] : []),
  ] as const;
  const missingFields = requiredFields.filter((k) => (expected as Record<string, unknown>)[k] === undefined || (expected as Record<string, unknown>)[k] === null);
  const parsedFields = requiredFields.length - missingFields.length;
  const quality: CalcDataQuality['quality'] =
    parsedFields === requiredFields.length ? 'high' : parsedFields >= Math.max(1, requiredFields.length - 2) ? 'medium' : 'low';
  const capturedDate = baseline.notes?.match(/(\d{4}-\d{2}-\d{2})/)?.[1];

  return {
    ...sc,
    calcDataQuality: {
      parsedFields,
      expectedFields: requiredFields.length,
      missingFields,
      quality,
      note: baseline.notes,
      capturedDate,
    },
    veeamCalcY3: {
      totalTB: expected.plannedCapacityTB ?? sc.veeamCalcY3.totalTB,
      perfTB: expected.plannedPerformanceTierTB ?? sc.veeamCalcY3.perfTB,
      capTB: expected.plannedCapacityTierTB ?? sc.veeamCalcY3.capTB,
      archTB: expected.plannedArchiveTierTB ?? sc.veeamCalcY3.archTB,
      wsTB: expected.veeamWorkingSpaceTB ?? computeVeeamWorkingSpaceTB(sc.config.sourceDataTB),
      fileTypeFullTB: expected.fileTypeFullTB,
      fileTypeIncrTB: expected.fileTypeIncrementalTB,
      fileTypeSyntheticFullTB: expected.fileTypeSyntheticFullTB,
      gfsWeeklyTB: expected.gfsWeeklyTB ?? (sc.config.gfsPolicy.weekly === 0 ? 0 : undefined),
      gfsMonthlyTB: expected.gfsMonthlyTB ?? (sc.config.gfsPolicy.monthly === 0 ? 0 : undefined),
      gfsYearlyTB: expected.gfsYearlyTB ?? (sc.config.gfsPolicy.yearly === 0 ? 0 : undefined),
    },
  };
}

// ---------------------------------------------------------------------------
// State builder
// ---------------------------------------------------------------------------

function buildSimulationState(sc: ReportScenario): SimulationState {
  const cfg = sc.config;
  const jobId = `job-${sc.id}`;
  const repoId = `repo-${sc.id}`;

  const repository: Repository = {
    id: repoId,
    name: `Repo-${sc.id}`,
    type: cfg.repositoryType,
    capacityTB: 99999,
    sobrConfig:
      cfg.repositoryType === 'SOBR'
        ? {
            performanceCapacityTB: 99999,
            capacityCapacityTB: 99999,
            archiveCapacityTB: 99999,
            offloadAfterDays: cfg.offloadAfterDays,
            archiveAfterDays: cfg.archiveAfterDays,
            generationPeriodDays: cfg.generationPeriodDays ?? 10,
            performanceImmutabilityDays: 0,
            capacityImmutabilityDays: 0,
            archiveImmutabilityDays: 0,
            hasArchiveTier: cfg.hasArchiveTier,
            copyEnabled: cfg.copyEnabled,
            moveEnabled: cfg.moveEnabled,
          }
        : undefined,
  };

  const job: BackupJob = {
    id: jobId,
    name: `Job-${sc.id}`,
    type: 'SyntheticFull',
    repositoryId: repoId,
    sourceDataTB: cfg.sourceDataTB,
    dailyChangeRatePct: cfg.dailyChangeRatePct,
    annualGrowthRatePct: cfg.annualGrowthRatePct,
    forecastYears: 4,
    schedule: { frequency: 'Daily', timeOfDay: '02:00', syntheticFullDay: 6 },
    retention: {
      restorePoints: cfg.retention,
      slaDays: cfg.retention,
    },
    gfsPolicy:
      cfg.gfsPolicy.weekly + cfg.gfsPolicy.monthly + cfg.gfsPolicy.yearly > 0
        ? cfg.gfsPolicy
        : undefined,
  };

  return {
    repositories: [repository],
    jobs: [job],
    chains: [],
    generations: [],
    restorePoints: [],
    blocks: [],
    date: START_DATE,
    startDate: START_DATE,
  };
}

// ---------------------------------------------------------------------------
// Forecast model (mirrors veeamBaselineComparator.computeSimulatorPlanned)
// ---------------------------------------------------------------------------

interface ForecastResult {
  totalTB: number;
  perfTB: number;
  capTB: number;
  archTB: number;
  // Sub-components
  chainDataTB: number;   // active chain storage (full + retention incrementals)
  gfsTB: number;         // total GFS contribution
  wsTB: number;          // working space reserve
  fileTypeFullTB: number;    // size of one full backup at this year offset
  fileTypeIncrTB: number;    // size of one incremental at this year offset
  fileTypeSyntheticFullTB: number;
  gfsWeeklyTB: number;
  gfsMonthlyTB: number;
  gfsYearlyTB: number;
  gfsWeeklyCount: number;
  gfsMonthlyCount: number;
  gfsYearlyCount: number;
  ageLe14TB: number;
  age15To38TB: number;
  age39To100TB: number;
  age101To193TB: number;
  age194To286TB: number;
  age287To379TB: number;
  age380PlusTB: number;
}

function computeForecast(cfg: ScenarioConfig, yearOffset: number, totalDaysElapsed: number): ForecastResult {
  const fullIntervalDays = 7; // SyntheticFull weekly
  const effectiveMoveEnabled = cfg.moveEnabled || !cfg.copyEnabled;

  const yearSourceTB = cfg.sourceDataTB * Math.pow(1 + cfg.annualGrowthRatePct / 100, yearOffset);
  const yearFullSizeTB = yearSourceTB * 0.5;
  const yearIncrSizeTB = yearSourceTB * (cfg.dailyChangeRatePct / 100) * 0.5;
  const effectiveYearIncrSizeTB = yearIncrSizeTB * (cfg.dailyChangeRatePct > 20 ? 1.2 : 1);

  // WS input is raw sourceDataTB (confirmed from calculator source)
  const wsInputTB = cfg.sourceDataTB;
  const yearWorkingSpaceReserveTB = computeVeeamWorkingSpaceTB(wsInputTB);

  const yearGfsStats = computeForecastGfsStatsAtYear({
    sourceDataTB: cfg.sourceDataTB,
    annualGrowthRatePct: cfg.annualGrowthRatePct,
    dailyChangeRatePct: cfg.dailyChangeRatePct,
    retentionDays: cfg.retention,
    gfsPolicy: cfg.gfsPolicy,
    startDate: START_DATE,
    yearOffset,
    copyEnabled: cfg.copyEnabled,
    effectiveMoveEnabled,
    offloadAfterDays: cfg.offloadAfterDays,
    archiveAfterDays: cfg.archiveAfterDays,
    hasArchiveTier: cfg.hasArchiveTier,
    sizingMode: 'reverse',
  });

  const estimateTierChainDataTB = (windowDays: number) => {
    if (windowDays <= 0) return 0;
    const chainsInWindow = Math.max(1, Math.ceil(windowDays / Math.max(1, fullIntervalDays)));
    const effectiveDays = chainsInWindow * fullIntervalDays - 1;
    return yearFullSizeTB + effectiveDays * effectiveYearIncrSizeTB;
  };

  const yearActiveChainTB = estimateTierChainDataTB(cfg.retention);
  const hasMonthlyOrYearlyGfs =
    (cfg.gfsPolicy?.monthly ?? 0) > 0 || (cfg.gfsPolicy?.yearly ?? 0) > 0;

  if (cfg.repositoryType !== 'SOBR') {
    const longHorizonFactor = hasMonthlyOrYearlyGfs && totalDaysElapsed >= 700 ? 0.88 : 1;
    const gfsTB = yearGfsStats.additionalFullTB * longHorizonFactor;
    const yearRepoUsedTB = yearActiveChainTB + gfsTB;
    const totalTB = yearRepoUsedTB + yearWorkingSpaceReserveTB;
    return {
      totalTB, perfTB: 0, capTB: 0, archTB: 0,
      chainDataTB: yearActiveChainTB,
      gfsTB,
      wsTB: yearWorkingSpaceReserveTB,
      fileTypeFullTB: yearFullSizeTB,
      fileTypeIncrTB: yearIncrSizeTB,
      fileTypeSyntheticFullTB: yearIncrSizeTB,
      gfsWeeklyTB: yearGfsStats.additionalWeeklyFullTB * longHorizonFactor,
      gfsMonthlyTB: yearGfsStats.additionalMonthlyFullTB * longHorizonFactor,
      gfsYearlyTB: yearGfsStats.additionalYearlyFullTB * longHorizonFactor,
      gfsWeeklyCount: yearGfsStats.additionalWeeklyPoints,
      gfsMonthlyCount: yearGfsStats.additionalMonthlyPoints,
      gfsYearlyCount: yearGfsStats.additionalYearlyPoints,
      ageLe14TB: yearGfsStats.ageBucketLe14TB * longHorizonFactor,
      age15To38TB: yearGfsStats.ageBucket15To38TB * longHorizonFactor,
      age39To100TB: yearGfsStats.ageBucket39To100TB * longHorizonFactor,
      age101To193TB: yearGfsStats.ageBucket101To193TB * longHorizonFactor,
      age194To286TB: yearGfsStats.ageBucket194To286TB * longHorizonFactor,
      age287To379TB: yearGfsStats.ageBucket287To379TB * longHorizonFactor,
      age380PlusTB: yearGfsStats.ageBucket380PlusTB * longHorizonFactor,
    };
  }

  // SOBR move-only
  let yearPerfUsedTB = 0;
  let yearCapUsedTB = 0;
  let yearArchUsedTB = 0;

  // Move-only (the only SOBR modes in our 5 scenarios)
  const perfWindowDays = Math.max(1, Math.min(cfg.offloadAfterDays + fullIntervalDays, cfg.retention));
  const capWindowDays = Math.max(fullIntervalDays, cfg.retention - cfg.offloadAfterDays + fullIntervalDays);
  yearPerfUsedTB = estimateTierChainDataTB(perfWindowDays) + yearGfsStats.additionalPerfFullTB;
  yearCapUsedTB = estimateTierChainDataTB(capWindowDays) + yearGfsStats.additionalCapFullTB;
  if (cfg.hasArchiveTier) {
    yearArchUsedTB = yearGfsStats.additionalArchFullTB;
  }

  const perfTotal = yearPerfUsedTB + yearWorkingSpaceReserveTB;
  const capTotal = yearCapUsedTB;
  const archTotal = yearArchUsedTB;
  const gfsTotalSobr = yearGfsStats.additionalPerfFullTB + yearGfsStats.additionalCapFullTB + yearGfsStats.additionalArchFullTB;
  const chainDataSobr = estimateTierChainDataTB(cfg.retention);
  return {
    totalTB: perfTotal + capTotal + archTotal,
    perfTB: perfTotal,
    capTB: capTotal,
    archTB: archTotal,
    chainDataTB: chainDataSobr,
    gfsTB: gfsTotalSobr,
    wsTB: yearWorkingSpaceReserveTB,
    fileTypeFullTB: yearFullSizeTB,
    fileTypeIncrTB: yearIncrSizeTB,
    fileTypeSyntheticFullTB: yearIncrSizeTB,
    gfsWeeklyTB: yearGfsStats.additionalWeeklyFullTB,
    gfsMonthlyTB: yearGfsStats.additionalMonthlyFullTB,
    gfsYearlyTB: yearGfsStats.additionalYearlyFullTB,
    gfsWeeklyCount: yearGfsStats.additionalWeeklyPoints,
    gfsMonthlyCount: yearGfsStats.additionalMonthlyPoints,
    gfsYearlyCount: yearGfsStats.additionalYearlyPoints,
    ageLe14TB: yearGfsStats.ageBucketLe14TB,
    age15To38TB: yearGfsStats.ageBucket15To38TB,
    age39To100TB: yearGfsStats.ageBucket39To100TB,
    age101To193TB: yearGfsStats.ageBucket101To193TB,
    age194To286TB: yearGfsStats.ageBucket194To286TB,
    age287To379TB: yearGfsStats.ageBucket287To379TB,
    age380PlusTB: yearGfsStats.ageBucket380PlusTB,
  };
}

// ---------------------------------------------------------------------------
// Quarterly data point
// ---------------------------------------------------------------------------

interface QuarterPoint {
  quarter: number;
  day: number;
  date: string;
  // Simulator values
  simTotalTB: number;
  simPerfTB: number;
  simCapTB: number;
  simArchTB: number;
  // Forecast values
  fcastTotalTB: number;
  fcastPerfTB: number;
  fcastCapTB: number;
  fcastArchTB: number;
  // Forecast sub-components
  fcastChainTB: number;
  fcastGfsTB: number;
  fcastWsTB: number;
  fcastFileFullTB: number;
  fcastFileIncrTB: number;
  fcastFileSyntheticFullTB: number;
  // Simulator sub-components (from restore point inspection)
  simChainTB: number;
  simGfsTB: number;
  simWsTB: number;     // formula (same input as forecast)
  simWeeklyGfsTB: number;
  simMonthlyGfsTB: number;
  simYearlyGfsTB: number;
  fcastWeeklyGfsTB: number;
  fcastMonthlyGfsTB: number;
  fcastYearlyGfsTB: number;
  simGfsCount: number;
  simWeeklyGfsCount: number;
  simMonthlyGfsCount: number;
  simYearlyGfsCount: number;
  fcastGfsCount: number;
  fcastWeeklyGfsCount: number;
  fcastMonthlyGfsCount: number;
  fcastYearlyGfsCount: number;
  simAgeLe14TB: number;
  simAge15To38TB: number;
  simAge39To100TB: number;
  simAge101To193TB: number;
  simAge194To286TB: number;
  simAge287To379TB: number;
  simAge380PlusTB: number;
  fcastAgeLe14TB: number;
  fcastAge15To38TB: number;
  fcastAge39To100TB: number;
  fcastAge101To193TB: number;
  fcastAge194To286TB: number;
  fcastAge287To379TB: number;
  fcastAge380PlusTB: number;
  simChainPointCount: number;
  simOldestChainAgeDays: number;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00.000Z`).getTime();
  const to = new Date(`${toIso}T00:00:00.000Z`).getTime();
  return Math.max(0, Math.round((to - from) / 86400000));
}

function bucketForAge(ageDays: number): AgeBucketKey {
  if (ageDays <= 14) return 'ageLe14TB';
  if (ageDays <= 38) return 'age15To38TB';
  if (ageDays <= 100) return 'age39To100TB';
  if (ageDays <= 193) return 'age101To193TB';
  if (ageDays <= 286) return 'age194To286TB';
  if (ageDays <= 379) return 'age287To379TB';
  return 'age380PlusTB';
}

function runScenarioReport(sc: ReportScenario): QuarterPoint[] {
  const state = buildSimulationState(sc);
  const sim = new VeeamSimulator(state);
  const repoId = `repo-${sc.id}`;
  const isSobr = sc.config.repositoryType === 'SOBR';
  const points: QuarterPoint[] = [];

  let currentDay = 0;

  for (let q = 1; q <= QUARTERS; q++) {
    const targetDay = q * QUARTER_DAYS;

    // Advance simulator to target day
    while (currentDay < targetDay) {
      sim.nextDay();
      currentDay++;
    }

    // Capture simulator storage
    let simPerfTB = 0, simCapTB = 0, simArchTB = 0;
    if (isSobr) {
      const tier = sim.getSOBRTierUsage(repoId);
      simPerfTB = tier.Performance ?? 0;
      simCapTB = tier.Capacity ?? 0;
      simArchTB = tier.Archive ?? 0;
    } else {
      const usage = sim.getStorageUsage();
      simPerfTB = usage[repoId] ?? 0;
    }

    const simTotalTB = simPerfTB + simCapTB + simArchTB;
    const yearOffset = targetDay / 365;

    // Compute forecast
    const fcast = computeForecast(sc.config, yearOffset, targetDay);

    // Compute simulator GFS vs chain breakdown using public API
    const wsTB = computeVeeamWorkingSpaceTB(sc.config.sourceDataTB);
    let simChainTB = 0;
    let simGfsTB = 0;
    let simWeeklyGfsTB = 0;
    let simMonthlyGfsTB = 0;
    let simYearlyGfsTB = 0;
    let simGfsCount = 0;
    let simWeeklyGfsCount = 0;
    let simMonthlyGfsCount = 0;
    let simYearlyGfsCount = 0;
    let simChainPointCount = 0;
    let simOldestChainAgeDays = 0;
    const simAgeBuckets: Record<AgeBucketKey, number> = {
      ageLe14TB: 0,
      age15To38TB: 0,
      age39To100TB: 0,
      age101To193TB: 0,
      age194To286TB: 0,
      age287To379TB: 0,
      age380PlusTB: 0,
    };
    const rps = sim.getCurrentRestorePoints();
    const targetDateIso = addDays(START_DATE, targetDay);
    for (const rp of rps) {
      // Guard each tier with the hasTierData flag (mirrors getStorageUsage() behaviour)
      // Mirror engine's hasTierData() fallback: when all three flags are undefined,
      // fall back to sobrTier (DAS points use this legacy path).
      const allUndefined = rp.hasPerformanceData === undefined && rp.hasCapacityData === undefined && rp.hasArchiveData === undefined;
      const legacyTier = rp.sobrTier ?? 'Performance';
      const hasPerf = allUndefined ? legacyTier === 'Performance' : !!rp.hasPerformanceData;
      const hasCap  = allUndefined ? legacyTier === 'Capacity'    : !!rp.hasCapacityData;
      const hasArch = allUndefined ? legacyTier === 'Archive'     : !!rp.hasArchiveData;
      const rpSize =
        (hasPerf ? sim.getRestorePointSizeForTier(rp.id, 'Performance') : 0) +
        (hasCap  ? sim.getRestorePointSizeForTier(rp.id, 'Capacity')    : 0) +
        (hasArch ? sim.getRestorePointSizeForTier(rp.id, 'Archive')     : 0);
      if (rp.isGFS) {
        simGfsCount += 1;
        simGfsTB += rpSize;
        const ageBucket = bucketForAge(daysBetween(rp.date, targetDateIso));
        simAgeBuckets[ageBucket] += rpSize;
        if (rp.isYearlyGFS) {
          simYearlyGfsCount += 1;
          simYearlyGfsTB += rpSize;
        } else if (rp.isMonthlyGFS) {
          simMonthlyGfsCount += 1;
          simMonthlyGfsTB += rpSize;
        } else if (rp.isWeeklyGFS) {
          simWeeklyGfsCount += 1;
          simWeeklyGfsTB += rpSize;
        }
      } else {
        simChainTB += rpSize;
        simChainPointCount += 1;
        const chainAgeDays = daysBetween(rp.date, targetDateIso);
        if (chainAgeDays > simOldestChainAgeDays) {
          simOldestChainAgeDays = chainAgeDays;
        }
      }
    }

    points.push({
      quarter: q,
      day: targetDay,
      date: addDays(START_DATE, targetDay),
      simTotalTB,
      simPerfTB,
      simCapTB,
      simArchTB,
      simChainTB,
      simGfsTB,
      simWsTB: wsTB,
      simWeeklyGfsTB,
      simMonthlyGfsTB,
      simYearlyGfsTB,
      fcastTotalTB: fcast.totalTB,
      fcastPerfTB: fcast.perfTB,
      fcastCapTB: fcast.capTB,
      fcastArchTB: fcast.archTB,
      fcastChainTB: fcast.chainDataTB,
      fcastGfsTB: fcast.gfsTB,
      fcastWsTB: fcast.wsTB,
      fcastFileFullTB: fcast.fileTypeFullTB,
      fcastFileIncrTB: fcast.fileTypeIncrTB,
      fcastFileSyntheticFullTB: fcast.fileTypeSyntheticFullTB,
      fcastWeeklyGfsTB: fcast.gfsWeeklyTB,
      fcastMonthlyGfsTB: fcast.gfsMonthlyTB,
      fcastYearlyGfsTB: fcast.gfsYearlyTB,
      simGfsCount,
      simWeeklyGfsCount,
      simMonthlyGfsCount,
      simYearlyGfsCount,
      fcastGfsCount: fcast.gfsWeeklyCount + fcast.gfsMonthlyCount + fcast.gfsYearlyCount,
      fcastWeeklyGfsCount: fcast.gfsWeeklyCount,
      fcastMonthlyGfsCount: fcast.gfsMonthlyCount,
      fcastYearlyGfsCount: fcast.gfsYearlyCount,
      simAgeLe14TB: simAgeBuckets.ageLe14TB,
      simAge15To38TB: simAgeBuckets.age15To38TB,
      simAge39To100TB: simAgeBuckets.age39To100TB,
      simAge101To193TB: simAgeBuckets.age101To193TB,
      simAge194To286TB: simAgeBuckets.age194To286TB,
      simAge287To379TB: simAgeBuckets.age287To379TB,
      simAge380PlusTB: simAgeBuckets.age380PlusTB,
      fcastAgeLe14TB: fcast.ageLe14TB,
      fcastAge15To38TB: fcast.age15To38TB,
      fcastAge39To100TB: fcast.age39To100TB,
      fcastAge101To193TB: fcast.age101To193TB,
      fcastAge194To286TB: fcast.age194To286TB,
      fcastAge287To379TB: fcast.age287To379TB,
      fcastAge380PlusTB: fcast.age380PlusTB,
      simChainPointCount,
      simOldestChainAgeDays,
    });
  }

  return points;
}

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

function fmt(v: number): string {
  return v.toFixed(3);
}

function fmtSigned(v: number): string {
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(3)}`;
}

function delta(a: number, b: number): string {
  if (b === 0) return '—';
  const pct = ((a - b) / b) * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function deltaClass(a: number, b: number): string {
  if (b === 0) return '';
  const pct = Math.abs(((a - b) / b) * 100);
  if (pct <= 2) return 'delta-ok';
  if (pct <= 10) return 'delta-warn';
  return 'delta-bad';
}

function qualityClass(q?: CalcDataQuality['quality']): string {
  if (q === 'high') return 'delta-ok';
  if (q === 'medium') return 'delta-warn';
  return 'delta-bad';
}

function absPctDelta(a: number, b: number): number | null {
  if (b === 0) return null;
  return Math.abs(((a - b) / b) * 100);
}

function verdictLabel(a: number, b: number): 'PASS' | 'WARN' | 'FAIL' | 'NA' {
  const pct = absPctDelta(a, b);
  if (pct === null) return 'NA';
  if (pct <= 2) return 'PASS';
  if (pct <= 10) return 'WARN';
  return 'FAIL';
}

function verdictClass(a: number, b: number): string {
  const v = verdictLabel(a, b);
  if (v === 'PASS') return 'delta-ok';
  if (v === 'WARN') return 'delta-warn';
  if (v === 'FAIL') return 'delta-bad';
  return '';
}

function topDriverLabel(pt: QuarterPoint): string {
  const components = [
    { name: 'Chain', value: Math.abs(pt.simChainTB - pt.fcastChainTB) },
    { name: 'GFS', value: Math.abs(pt.simGfsTB - pt.fcastGfsTB) },
    { name: 'WS', value: Math.abs(pt.simWsTB - pt.fcastWsTB) },
    { name: 'Perf', value: Math.abs(pt.simPerfTB - pt.fcastPerfTB) },
    { name: 'Cap', value: Math.abs(pt.simCapTB - pt.fcastCapTB) },
    { name: 'Arch', value: Math.abs(pt.simArchTB - pt.fcastArchTB) },
  ];
  const best = components.reduce((acc, cur) => (cur.value > acc.value ? cur : acc), components[0]);
  return `${best.name} (${best.value.toFixed(3)} TB)`;
}

function buildScenarioSection(sc: ReportScenario, points: QuarterPoint[]): string {
  const isSobr = sc.config.repositoryType === 'SOBR';
  const calcRef = sc.veeamCalcY3;

  const cfg = sc.config;
  const cfgLines = [
    `Repository: ${cfg.repositoryType}`,
    `Source: ${cfg.sourceDataTB} TB`,
    `Growth: ${cfg.annualGrowthRatePct}% / yr`,
    `Change: ${cfg.dailyChangeRatePct}% / day`,
    `Retention: ${cfg.retention} days`,
    `GFS: W${cfg.gfsPolicy.weekly}/M${cfg.gfsPolicy.monthly}/Y${cfg.gfsPolicy.yearly}`,
    ...(isSobr
      ? [
          `Mode: ${cfg.copyEnabled ? 'Copy' : 'Move'}`,
          `Offload: ${cfg.offloadAfterDays}d`,
          ...(cfg.hasArchiveTier ? [`Archive: after ${cfg.archiveAfterDays}d`] : []),
        ]
      : []),
  ];

  const calcCell = (isY3: boolean, value?: number): string => {
    if (!isY3 || value === undefined) return '—';
    return fmt(value);
  };

  const y3 = points.find((p) => p.quarter === QUARTERS) ?? points[points.length - 1];
  const calcQuality = sc.calcDataQuality;
  const qualityText = calcQuality
    ? `${calcQuality.parsedFields}/${calcQuality.expectedFields} parsed`
    : '0/0 parsed';

  const decompositionRows = points
    .map((pt) => {
      const isY3 = pt.quarter === QUARTERS;
      return `
        <tr${isY3 ? ' class="year3-row"' : ''}>
          <td>Q${pt.quarter}</td>
          <td>${pt.day}</td>
          <td>${pt.date}</td>
          <td class="delta-col ${deltaClass(pt.simTotalTB, pt.fcastTotalTB)}">${fmtSigned(pt.simTotalTB - pt.fcastTotalTB)}</td>
          <td class="delta-col ${deltaClass(pt.simChainTB, pt.fcastChainTB)}">${fmtSigned(pt.simChainTB - pt.fcastChainTB)}</td>
          <td class="delta-col ${deltaClass(pt.simGfsTB, pt.fcastGfsTB)}">${fmtSigned(pt.simGfsTB - pt.fcastGfsTB)}</td>
          <td class="delta-col ${deltaClass(pt.simWsTB, pt.fcastWsTB)}">${fmtSigned(pt.simWsTB - pt.fcastWsTB)}</td>
          <td class="delta-col ${deltaClass(pt.simPerfTB, pt.fcastPerfTB)}">${fmtSigned(pt.simPerfTB - pt.fcastPerfTB)}</td>
          <td class="delta-col ${deltaClass(pt.simCapTB, pt.fcastCapTB)}">${fmtSigned(pt.simCapTB - pt.fcastCapTB)}</td>
          <td class="delta-col ${deltaClass(pt.simArchTB, pt.fcastArchTB)}">${fmtSigned(pt.simArchTB - pt.fcastArchTB)}</td>
          <td class="delta-col">${topDriverLabel(pt)}</td>
          <td class="delta-col">${isY3 ? fmtSigned(pt.simTotalTB - calcRef.totalTB) : '—'}</td>
        </tr>`;
    })
    .join('');

  const gfsCountRows = points
    .map((pt) => {
      const isY3 = pt.quarter === QUARTERS;
      return `
        <tr${isY3 ? ' class="year3-row"' : ''}>
          <td>Q${pt.quarter}</td>
          <td>${pt.day}</td>
          <td>${pt.date}</td>
          <td class="sim-col">${pt.simGfsCount}</td>
          <td class="sim-col">${pt.simWeeklyGfsCount}</td>
          <td class="sim-col">${pt.simMonthlyGfsCount}</td>
          <td class="sim-col">${pt.simYearlyGfsCount}</td>
          <td class="fcast-col">${pt.fcastGfsCount}</td>
          <td class="fcast-col">${pt.fcastWeeklyGfsCount}</td>
          <td class="fcast-col">${pt.fcastMonthlyGfsCount}</td>
          <td class="fcast-col">${pt.fcastYearlyGfsCount}</td>
          <td class="delta-col">${pt.simGfsCount - pt.fcastGfsCount}</td>
        </tr>`;
    })
    .join('');

  const ageBucketRows = points
    .map((pt) => {
      const isY3 = pt.quarter === QUARTERS;
      const simBucketValues = [pt.simAgeLe14TB, pt.simAge15To38TB, pt.simAge39To100TB, pt.simAge101To193TB, pt.simAge194To286TB, pt.simAge287To379TB, pt.simAge380PlusTB];
      const fcastBucketValues = [pt.fcastAgeLe14TB, pt.fcastAge15To38TB, pt.fcastAge39To100TB, pt.fcastAge101To193TB, pt.fcastAge194To286TB, pt.fcastAge287To379TB, pt.fcastAge380PlusTB];
      const simCells = simBucketValues.map((v) => `<td class="sim-col">${fmt(v)}</td>`).join('');
      const fcastCells = fcastBucketValues.map((v) => `<td class="fcast-col">${fmt(v)}</td>`).join('');
      return `
        <tr${isY3 ? ' class="year3-row"' : ''}>
          <td>Q${pt.quarter}</td>
          <td>${pt.day}</td>
          <td>${pt.date}</td>
          ${simCells}
          ${fcastCells}
        </tr>`;
    })
    .join('');

  const policyRows = points
    .map((pt) => {
      const isY3 = pt.quarter === QUARTERS;
      const retentionGap = pt.simOldestChainAgeDays - cfg.retention;
      const capExpected = isSobr ? pt.day >= cfg.offloadAfterDays : false;
      const capObserved = pt.simCapTB > 0;
      const archExpected = isSobr && cfg.hasArchiveTier ? pt.day >= (cfg.offloadAfterDays + cfg.archiveAfterDays) : false;
      const archObserved = pt.simArchTB > 0;
      return `
        <tr${isY3 ? ' class="year3-row"' : ''}>
          <td>Q${pt.quarter}</td>
          <td>${pt.day}</td>
          <td>${pt.date}</td>
          <td class="sim-col">${pt.simOldestChainAgeDays}</td>
          <td class="sim-col">${cfg.retention}</td>
          <td class="delta-col ${Math.abs(retentionGap) <= 3 ? 'delta-ok' : 'delta-warn'}">${retentionGap >= 0 ? '+' : ''}${retentionGap}d</td>
          <td class="sim-col">${pt.simChainPointCount}</td>
          <td class="sim-col">${capExpected ? 'Y' : 'N'}</td>
          <td class="sim-col ${capExpected === capObserved ? 'delta-ok' : 'delta-warn'}">${capObserved ? 'Y' : 'N'}</td>
          <td class="sim-col">${archExpected ? 'Y' : 'N'}</td>
          <td class="sim-col ${archExpected === archObserved ? 'delta-ok' : 'delta-warn'}">${archObserved ? 'Y' : 'N'}</td>
        </tr>`;
    })
    .join('');

  const flowRows = points
    .map((pt, idx) => {
      const isY3 = pt.quarter === QUARTERS;
      if (idx === 0) {
        return `
        <tr${isY3 ? ' class="year3-row"' : ''}>
          <td>Q${pt.quarter}</td>
          <td>${pt.day}</td>
          <td>${pt.date}</td>
          <td colspan="10" class="delta-col">—</td>
        </tr>`;
      }
      const prev = points[idx - 1];
      const simPerfDrop = Math.max(0, prev.simPerfTB - pt.simPerfTB);
      const simCapRise = Math.max(0, pt.simCapTB - prev.simCapTB);
      const simArchRise = Math.max(0, pt.simArchTB - prev.simArchTB);
      const simCapDrop = Math.max(0, prev.simCapTB - pt.simCapTB);
      const fPerfDrop = Math.max(0, prev.fcastPerfTB - pt.fcastPerfTB);
      const fCapRise = Math.max(0, pt.fcastCapTB - prev.fcastCapTB);
      const fArchRise = Math.max(0, pt.fcastArchTB - prev.fcastArchTB);
      const fCapDrop = Math.max(0, prev.fcastCapTB - pt.fcastCapTB);
      const simPtoC = Math.min(simPerfDrop, simCapRise);
      const simCtoA = Math.min(simCapDrop, simArchRise);
      const fPtoC = Math.min(fPerfDrop, fCapRise);
      const fCtoA = Math.min(fCapDrop, fArchRise);
      return `
        <tr${isY3 ? ' class="year3-row"' : ''}>
          <td>Q${pt.quarter}</td>
          <td>${pt.day}</td>
          <td>${pt.date}</td>
          <td class="sim-col">${fmtSigned(pt.simPerfTB - prev.simPerfTB)}</td>
          <td class="sim-col">${fmtSigned(pt.simCapTB - prev.simCapTB)}</td>
          <td class="sim-col">${fmtSigned(pt.simArchTB - prev.simArchTB)}</td>
          <td class="sim-col">${fmt(simPtoC)}</td>
          <td class="sim-col">${fmt(simCtoA)}</td>
          <td class="fcast-col">${fmtSigned(pt.fcastPerfTB - prev.fcastPerfTB)}</td>
          <td class="fcast-col">${fmtSigned(pt.fcastCapTB - prev.fcastCapTB)}</td>
          <td class="fcast-col">${fmtSigned(pt.fcastArchTB - prev.fcastArchTB)}</td>
          <td class="fcast-col">${fmt(fPtoC)}</td>
          <td class="fcast-col">${fmt(fCtoA)}</td>
        </tr>`;
    })
    .join('');

  const verdictRows = points
    .map((pt) => {
      const isY3 = pt.quarter === QUARTERS;
      const cells = [
        { a: pt.simTotalTB, b: pt.fcastTotalTB },
        { a: pt.simChainTB, b: pt.fcastChainTB },
        { a: pt.simGfsTB, b: pt.fcastGfsTB },
        { a: pt.simWsTB, b: pt.fcastWsTB },
        { a: pt.simPerfTB, b: pt.fcastPerfTB },
        { a: pt.simCapTB, b: pt.fcastCapTB },
        { a: pt.simArchTB, b: pt.fcastArchTB },
      ];
      return `
        <tr${isY3 ? ' class="year3-row"' : ''}>
          <td>Q${pt.quarter}</td>
          <td>${pt.day}</td>
          <td>${pt.date}</td>
          ${cells.map((c) => `<td class="delta-col ${verdictClass(c.a, c.b)}">${verdictLabel(c.a, c.b)}</td>`).join('')}
        </tr>`;
    })
    .join('');

  const totalsRows = points
    .map((pt, idx) => {
      const isY3 = pt.quarter === QUARTERS;
      const prevSim = idx > 0 ? points[idx - 1].simTotalTB : null;
      const trendArrow = prevSim === null ? '—'
        : pt.simTotalTB > prevSim * 1.001 ? '↑'
        : pt.simTotalTB < prevSim * 0.999 ? '↓'
        : '→';
      const trendClass = trendArrow === '↑' ? 'trend-up' : trendArrow === '↓' ? 'trend-down' : 'trend-flat';
      const sFCls = deltaClass(pt.simTotalTB, pt.fcastTotalTB);
      const sCCls = isY3 ? deltaClass(pt.simTotalTB, calcRef.totalTB) : '';
      const fCCls = isY3 ? deltaClass(pt.fcastTotalTB, calcRef.totalTB) : '';
      return `
        <tr${isY3 ? ' class="year3-row"' : ''}>
          <td>Q${pt.quarter}</td>
          <td>${pt.day}</td>
          <td>${pt.date}</td>
          <td class="sim-col">${fmt(pt.simTotalTB)}</td>
          <td class="${trendClass}">${trendArrow}</td>
          <td class="fcast-col">${fmt(pt.fcastTotalTB)}</td>
          <td class="calc-col${isY3 ? ' ref-val' : ''}">${calcCell(isY3, calcRef.totalTB)}</td>
          <td class="delta-col ${sFCls}">${delta(pt.simTotalTB, pt.fcastTotalTB)}</td>
          <td class="delta-col ${sCCls}">${isY3 ? delta(pt.simTotalTB, calcRef.totalTB) : '—'}</td>
          <td class="delta-col ${fCCls}">${isY3 ? delta(pt.fcastTotalTB, calcRef.totalTB) : '—'}</td>
        </tr>`;
    })
    .join('');

  const tierRows = points
    .map((pt) => {
      const isY3 = pt.quarter === QUARTERS;
      const simPerf = isSobr ? pt.simPerfTB : pt.simTotalTB;
      const simCap = isSobr ? pt.simCapTB : 0;
      const simArch = isSobr ? pt.simArchTB : 0;
      const fPerf = isSobr ? pt.fcastPerfTB : pt.fcastTotalTB;
      const fCap = isSobr ? pt.fcastCapTB : 0;
      const fArch = isSobr ? pt.fcastArchTB : 0;
      const calcPerf = isSobr ? calcRef.perfTB : calcRef.totalTB;
      const calcCap = isSobr ? calcRef.capTB : 0;
      const calcArch = isSobr ? calcRef.archTB : 0;

      return `
        <tr${isY3 ? ' class="year3-row"' : ''}>
          <td>Q${pt.quarter}</td>
          <td>${pt.day}</td>
          <td>${pt.date}</td>
          <td class="sim-col">${fmt(simPerf)}</td>
          <td class="sim-col">${fmt(simCap)}</td>
          <td class="sim-col">${fmt(simArch)}</td>
          <td class="fcast-col">${fmt(fPerf)}</td>
          <td class="fcast-col">${fmt(fCap)}</td>
          <td class="fcast-col">${fmt(fArch)}</td>
          <td class="calc-col${isY3 ? ' ref-val' : ''}">${calcCell(isY3, calcPerf)}</td>
          <td class="calc-col${isY3 ? ' ref-val' : ''}">${calcCell(isY3, calcCap)}</td>
          <td class="calc-col${isY3 ? ' ref-val' : ''}">${calcCell(isY3, calcArch)}</td>
        </tr>`;
    })
    .join('');

  const compositionRows = points
    .map((pt) => {
      const isY3 = pt.quarter === QUARTERS;
      return `
        <tr${isY3 ? ' class="year3-row"' : ''}>
          <td>Q${pt.quarter}</td>
          <td>${pt.day}</td>
          <td>${pt.date}</td>
          <td class="sim-col">${fmt(pt.simChainTB)}</td>
          <td class="sim-col">${fmt(pt.simGfsTB)}</td>
          <td class="sim-col">${fmt(pt.simWeeklyGfsTB)}</td>
          <td class="sim-col">${fmt(pt.simMonthlyGfsTB)}</td>
          <td class="sim-col">${fmt(pt.simYearlyGfsTB)}</td>
          <td class="fcast-col">${fmt(pt.fcastChainTB)}</td>
          <td class="fcast-col">${fmt(pt.fcastGfsTB)}</td>
          <td class="fcast-col">${fmt(pt.fcastWeeklyGfsTB)}</td>
          <td class="fcast-col">${fmt(pt.fcastMonthlyGfsTB)}</td>
          <td class="fcast-col">${fmt(pt.fcastYearlyGfsTB)}</td>
          <td class="calc-col${isY3 ? ' ref-val' : ''}">${calcCell(isY3, calcRef.gfsWeeklyTB)}</td>
          <td class="calc-col${isY3 ? ' ref-val' : ''}">${calcCell(isY3, calcRef.gfsMonthlyTB)}</td>
          <td class="calc-col${isY3 ? ' ref-val' : ''}">${calcCell(isY3, calcRef.gfsYearlyTB)}</td>
          <td class="delta-col ${deltaClass(pt.simChainTB, pt.fcastChainTB)}">${delta(pt.simChainTB, pt.fcastChainTB)}</td>
          <td class="delta-col ${deltaClass(pt.simGfsTB, pt.fcastGfsTB)}">${delta(pt.simGfsTB, pt.fcastGfsTB)}</td>
        </tr>`;
    })
    .join('');

  const fileWsRows = points
    .map((pt) => {
      const isY3 = pt.quarter === QUARTERS;
      const incrFullRatio = pt.fcastFileFullTB > 0 ? pt.fcastFileIncrTB / pt.fcastFileFullTB : 0;
      return `
        <tr${isY3 ? ' class="year3-row"' : ''}>
          <td>Q${pt.quarter}</td>
          <td>${pt.day}</td>
          <td>${pt.date}</td>
          <td class="sim-col">${fmt(pt.simWsTB)}</td>
          <td class="fcast-col">${fmt(pt.fcastWsTB)}</td>
          <td class="fcast-col">${fmt(pt.fcastFileFullTB)}</td>
          <td class="fcast-col">${fmt(pt.fcastFileSyntheticFullTB)}</td>
          <td class="fcast-col">${fmt(pt.fcastFileIncrTB)}</td>
          <td class="fcast-col">${incrFullRatio.toFixed(3)}x</td>
          <td class="calc-col${isY3 ? ' ref-val' : ''}">${calcCell(isY3, calcRef.wsTB)}</td>
          <td class="calc-col${isY3 ? ' ref-val' : ''}">${calcCell(isY3, calcRef.fileTypeFullTB)}</td>
          <td class="calc-col${isY3 ? ' ref-val' : ''}">${calcCell(isY3, calcRef.fileTypeIncrTB)}</td>
          <td class="calc-col${isY3 ? ' ref-val' : ''}">${calcCell(isY3, calcRef.fileTypeSyntheticFullTB)}</td>
          <td class="delta-col ${deltaClass(pt.simWsTB, pt.fcastWsTB)}">${delta(pt.simWsTB, pt.fcastWsTB)}</td>
        </tr>`;
    })
    .join('');

  const gfsAssertRows = [
    { type: 'Weekly',  policyCount: cfg.gfsPolicy.weekly,  simTB: y3.simWeeklyGfsTB,  fcastTB: y3.fcastWeeklyGfsTB,  calcTB: calcRef.gfsWeeklyTB },
    { type: 'Monthly', policyCount: cfg.gfsPolicy.monthly, simTB: y3.simMonthlyGfsTB, fcastTB: y3.fcastMonthlyGfsTB, calcTB: calcRef.gfsMonthlyTB },
    { type: 'Yearly',  policyCount: cfg.gfsPolicy.yearly,  simTB: y3.simYearlyGfsTB,  fcastTB: y3.fcastYearlyGfsTB,  calcTB: calcRef.gfsYearlyTB },
  ].map((row) => {
    const shouldBeZero = row.policyCount === 0;
    const simOk = shouldBeZero ? row.simTB < 0.001 : row.simTB > 0.001;
    const fcastOk = shouldBeZero ? row.fcastTB < 0.001 : row.fcastTB > 0.001;
    return `
      <tr>
        <td>${row.type}</td>
        <td>${row.policyCount}</td>
        <td>${shouldBeZero ? 'zero' : 'nonzero'}</td>
        <td class="sim-col">${fmt(row.simTB)}</td>
        <td class="fcast-col">${fmt(row.fcastTB)}</td>
        <td class="calc-col">${row.calcTB !== undefined ? fmt(row.calcTB) : '—'}</td>
        <td class="delta-col ${simOk ? 'delta-ok' : 'delta-bad'}">${simOk ? 'PASS' : 'FAIL'}</td>
        <td class="delta-col ${fcastOk ? 'delta-ok' : 'delta-bad'}">${fcastOk ? 'PASS' : 'FAIL'}</td>
      </tr>`;
  }).join('');

  const verdictComps = [
    { name: 'Total', a: y3.simTotalTB, b: y3.fcastTotalTB },
    { name: 'Chain', a: y3.simChainTB, b: y3.fcastChainTB },
    { name: 'GFS',   a: y3.simGfsTB,   b: y3.fcastGfsTB },
    { name: 'WS',    a: y3.simWsTB,    b: y3.fcastWsTB },
    { name: 'Perf',  a: y3.simPerfTB,  b: y3.fcastPerfTB },
    { name: 'Cap',   a: y3.simCapTB,   b: y3.fcastCapTB },
    { name: 'Arch',  a: y3.simArchTB,  b: y3.fcastArchTB },
  ];
  const y3FailCount = verdictComps.filter((c) => verdictLabel(c.a, c.b) === 'FAIL').length;
  const y3WarnCount = verdictComps.filter((c) => verdictLabel(c.a, c.b) === 'WARN').length;
  const worstComp = verdictComps.find((c) => verdictLabel(c.a, c.b) === 'FAIL')?.name
    ?? verdictComps.find((c) => verdictLabel(c.a, c.b) === 'WARN')?.name
    ?? 'none';
  const readinessText = y3FailCount > 0
    ? `Red — ${y3FailCount} FAIL, ${y3WarnCount} WARN at Y3`
    : y3WarnCount > 0
    ? `Amber — ${y3WarnCount} WARN, no failures at Y3`
    : 'Green — all components ≤2% at Y3';
  const readinessClass = y3FailCount > 0 ? 'delta-bad' : y3WarnCount > 0 ? 'delta-warn' : 'delta-ok';
  const y3DeltaPct = y3.fcastTotalTB > 0 ? ((y3.simTotalTB - y3.fcastTotalTB) / y3.fcastTotalTB * 100) : 0;
  const decisionStripHtml = `
    <div class="decision-strip ${readinessClass}">
      <span><strong>Readiness:</strong> ${readinessText}</span>
      <span><strong>Y3 Δ S/F:</strong> ${y3DeltaPct >= 0 ? '+' : ''}${y3DeltaPct.toFixed(1)}% (${fmtSigned(y3.simTotalTB - y3.fcastTotalTB)} TB)</span>
      <span><strong>Top Driver (Y3):</strong> ${topDriverLabel(y3)}</span>
      <span><strong>Worst Component:</strong> ${worstComp}</span>
    </div>`;

  return `
  <section class="scenario">
    <h2>${sc.id}</h2>
    <p class="scenario-name">${sc.name}</p>
    <div class="config-badge">
      ${cfgLines.map(l => `<span>${l}</span>`).join('')}
    </div>
    ${decisionStripHtml}
    <div class="quality-panel ${qualityClass(calcQuality?.quality)}">
      <span><strong>Calculator data quality:</strong> ${qualityText}</span>
      <span><strong>Capture date:</strong> ${calcQuality?.capturedDate ?? 'unknown'}</span>
      <span><strong>Y3 total delta (S-F):</strong> ${fmtSigned(y3.simTotalTB - y3.fcastTotalTB)} TB</span>
      <span><strong>Y3 missing calc fields:</strong> ${calcQuality?.missingFields.length ? calcQuality.missingFields.join(', ') : 'none'}</span>
    </div>

    <details class="table-group" open>
      <summary>Totals (Simulator vs Forecast vs Calculator)</summary>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th rowspan="2">Qtr</th>
              <th rowspan="2">Day</th>
              <th rowspan="2">Date</th>
              <th class="sim-col">Simulator</th>
              <th rowspan="2">Trend</th>
              <th class="fcast-col">Forecast</th>
              <th class="calc-col">Calculator Y3</th>
              <th class="delta-col">Δ S/F</th>
              <th class="delta-col">Δ S/C</th>
              <th class="delta-col">Δ F/C</th>
            </tr>
            <tr>
              <th class="sim-col sub">Total TB</th>
              <th class="fcast-col sub">Total TB</th>
              <th class="calc-col sub">Total TB</th>
              <th class="delta-col sub">all quarters</th>
              <th class="delta-col sub">Y3 only</th>
              <th class="delta-col sub">Y3 only</th>
            </tr>
          </thead>
          <tbody>${totalsRows}</tbody>
        </table>
      </div>
    </details>

    <details class="table-group">
      <summary>Tier Breakdown (Perf / Cap / Arch)</summary>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th rowspan="2">Qtr</th>
              <th rowspan="2">Day</th>
              <th rowspan="2">Date</th>
              <th colspan="3" class="sim-col">Simulator</th>
              <th colspan="3" class="fcast-col">Forecast</th>
              <th colspan="3" class="calc-col">Calculator Y3</th>
            </tr>
            <tr>
              <th class="sim-col sub">Perf</th>
              <th class="sim-col sub">Cap</th>
              <th class="sim-col sub">Arch</th>
              <th class="fcast-col sub">Perf</th>
              <th class="fcast-col sub">Cap</th>
              <th class="fcast-col sub">Arch</th>
              <th class="calc-col sub">Perf</th>
              <th class="calc-col sub">Cap</th>
              <th class="calc-col sub">Arch</th>
            </tr>
          </thead>
          <tbody>${tierRows}</tbody>
        </table>
      </div>
    </details>

    <details class="table-group">
      <summary>Data Composition (Chain / GFS)</summary>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th rowspan="2">Qtr</th>
              <th rowspan="2">Day</th>
              <th rowspan="2">Date</th>
              <th colspan="5" class="sim-col">Simulator</th>
              <th colspan="5" class="fcast-col">Forecast</th>
              <th colspan="3" class="calc-col">Calculator Y3</th>
              <th class="delta-col">Δ Chain</th>
              <th class="delta-col">Δ GFS</th>
            </tr>
            <tr>
              <th class="sim-col sub">Chain</th>
              <th class="sim-col sub">GFS</th>
              <th class="sim-col sub">W</th>
              <th class="sim-col sub">M</th>
              <th class="sim-col sub">Y</th>
              <th class="fcast-col sub">Chain</th>
              <th class="fcast-col sub">GFS</th>
              <th class="fcast-col sub">W</th>
              <th class="fcast-col sub">M</th>
              <th class="fcast-col sub">Y</th>
              <th class="calc-col sub">W</th>
              <th class="calc-col sub">M</th>
              <th class="calc-col sub">Y</th>
              <th class="delta-col sub">S vs F</th>
              <th class="delta-col sub">S vs F</th>
            </tr>
          </thead>
          <tbody>${compositionRows}</tbody>
        </table>
      </div>
    </details>

    <details class="table-group">
      <summary>File And Working Space (Full / Incr / WS)</summary>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th rowspan="2">Qtr</th>
              <th rowspan="2">Day</th>
              <th rowspan="2">Date</th>
              <th class="sim-col">Simulator</th>
              <th class="fcast-col">Forecast</th>
              <th class="fcast-col">Forecast</th>
              <th class="fcast-col">Forecast</th>
              <th class="fcast-col">Forecast</th>
              <th class="fcast-col">Forecast</th>
              <th class="calc-col">Calculator Y3</th>
              <th class="calc-col">Calculator Y3</th>
              <th class="calc-col">Calculator Y3</th>
              <th class="calc-col">Calculator Y3</th>
              <th class="delta-col">Δ WS</th>
            </tr>
            <tr>
              <th class="sim-col sub">WS</th>
              <th class="fcast-col sub">WS</th>
              <th class="fcast-col sub">1 Full</th>
              <th class="fcast-col sub">1 Incr</th>
              <th class="fcast-col sub">1 Synth</th>
              <th class="fcast-col sub">Incr:Full</th>
              <th class="calc-col sub">WS</th>
              <th class="calc-col sub">1 Full</th>
              <th class="calc-col sub">1 Incr</th>
              <th class="calc-col sub">1 Synth</th>
              <th class="delta-col sub">S vs F</th>
            </tr>
          </thead>
          <tbody>${fileWsRows}</tbody>
        </table>
      </div>
    </details>

    <details class="table-group">
      <summary>Delta Decomposition (TB)</summary>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Qtr</th>
              <th>Day</th>
              <th>Date</th>
              <th>Δ Total S-F</th>
              <th>Δ Chain S-F</th>
              <th>Δ GFS S-F</th>
              <th>Δ WS S-F</th>
              <th>Δ Perf S-F</th>
              <th>Δ Cap S-F</th>
              <th>Δ Arch S-F</th>
              <th>Top Driver</th>
              <th>Δ Total S-C (Y3)</th>
            </tr>
          </thead>
          <tbody>${decompositionRows}</tbody>
        </table>
      </div>
    </details>

    <details class="table-group">
      <summary>GFS Point Counts (W / M / Y)</summary>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th rowspan="2">Qtr</th>
              <th rowspan="2">Day</th>
              <th rowspan="2">Date</th>
              <th colspan="4" class="sim-col">Simulator Count</th>
              <th colspan="4" class="fcast-col">Forecast Count</th>
              <th rowspan="2" class="delta-col">Δ Count S-F</th>
            </tr>
            <tr>
              <th class="sim-col sub">Total</th>
              <th class="sim-col sub">W</th>
              <th class="sim-col sub">M</th>
              <th class="sim-col sub">Y</th>
              <th class="fcast-col sub">Total</th>
              <th class="fcast-col sub">W</th>
              <th class="fcast-col sub">M</th>
              <th class="fcast-col sub">Y</th>
            </tr>
          </thead>
          <tbody>${gfsCountRows}</tbody>
        </table>
      </div>
    </details>

    <details class="table-group">
      <summary>GFS Age Buckets (TB)</summary>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th rowspan="2">Qtr</th>
              <th rowspan="2">Day</th>
              <th rowspan="2">Date</th>
              <th colspan="7" class="sim-col">Simulator</th>
              <th colspan="7" class="fcast-col">Forecast</th>
            </tr>
            <tr>
              ${AGE_BUCKETS.map((b) => `<th class="sim-col sub">${b.label}</th>`).join('')}
              ${AGE_BUCKETS.map((b) => `<th class="fcast-col sub">${b.label}</th>`).join('')}
            </tr>
          </thead>
          <tbody>${ageBucketRows}</tbody>
        </table>
      </div>
    </details>

    <details class="table-group">
      <summary>Effective Policy Realization</summary>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Qtr</th>
              <th>Day</th>
              <th>Date</th>
              <th>Observed Chain Age</th>
              <th>Configured Retention</th>
              <th>Age Gap</th>
              <th>Chain Points</th>
              <th>Cap Expected</th>
              <th>Cap Observed</th>
              <th>Arch Expected</th>
              <th>Arch Observed</th>
            </tr>
          </thead>
          <tbody>${policyRows}</tbody>
        </table>
      </div>
    </details>

    <details class="table-group">
      <summary>Tier Transfer Flow (Quarter Over Quarter)</summary>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th rowspan="2">Qtr</th>
              <th rowspan="2">Day</th>
              <th rowspan="2">Date</th>
              <th colspan="5" class="sim-col">Simulator</th>
              <th colspan="5" class="fcast-col">Forecast</th>
            </tr>
            <tr>
              <th class="sim-col sub">dPerf</th>
              <th class="sim-col sub">dCap</th>
              <th class="sim-col sub">dArch</th>
              <th class="sim-col sub">Implied P->C</th>
              <th class="sim-col sub">Implied C->A</th>
              <th class="fcast-col sub">dPerf</th>
              <th class="fcast-col sub">dCap</th>
              <th class="fcast-col sub">dArch</th>
              <th class="fcast-col sub">Implied P->C</th>
              <th class="fcast-col sub">Implied C->A</th>
            </tr>
          </thead>
          <tbody>${flowRows}</tbody>
        </table>
      </div>
    </details>

    <details class="table-group">
      <summary>Component Verdicts (S vs F)</summary>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Qtr</th>
              <th>Day</th>
              <th>Date</th>
              <th>Total</th>
              <th>Chain</th>
              <th>GFS</th>
              <th>WS</th>
              <th>Perf</th>
              <th>Cap</th>
              <th>Arch</th>
            </tr>
          </thead>
          <tbody>${verdictRows}</tbody>
        </table>
      </div>
    </details>

    <details class="table-group">
      <summary>GFS Zero Assertions (Policy vs Observed at Y3)</summary>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>GFS Type</th>
              <th>Policy Count</th>
              <th>Expected</th>
              <th class="sim-col">Sim Y3 TB</th>
              <th class="fcast-col">Fcast Y3 TB</th>
              <th class="calc-col">Calc Y3 TB</th>
              <th class="delta-col">Sim Assert</th>
              <th class="delta-col">Fcast Assert</th>
            </tr>
          </thead>
          <tbody>${gfsAssertRows}</tbody>
        </table>
      </div>
    </details>

    <p class="legend">
      <strong>Chain</strong> = base full + retention incrementals &nbsp;
      <strong>GFS</strong> = GFS-tagged point storage (bracket-table sized) &nbsp;
      <strong>WS</strong> = Veeam working-space reserve (formula, not stored data) &nbsp;
      <strong>1 Full / 1 Incr / 1 Synth</strong> = forecast or parsed calculator file sizes at that year offset &nbsp;
      <strong>W / M / Y</strong> = weekly/monthly/yearly GFS contribution split &nbsp;
      <strong>Δ S/F</strong> = Simulator vs Forecast &nbsp;
      <strong>Δ S/C</strong> = Simulator vs Veeam Calc (Y3 only) &nbsp;
      <strong>Δ F/C</strong> = Forecast vs Veeam Calc (Y3 only) &nbsp;
      <span class="delta-ok-key">≤2% ●</span>
      <span class="delta-warn-key">≤10% ●</span>
      <span class="delta-bad-key">&gt;10% ●</span>
    </p>
  </section>`;
}

// ---------------------------------------------------------------------------
// Cross-scenario summary table
// ---------------------------------------------------------------------------

function buildCrossScenarioTable(data: Array<{ sc: ReportScenario; points: QuarterPoint[] }>): string {
  const rows = data
    .map(({ sc, points }) => {
      const y3 = points.find((p) => p.quarter === QUARTERS) ?? points[points.length - 1];
      const calcRef = sc.veeamCalcY3;
      const vdcts = [
        verdictLabel(y3.simTotalTB, y3.fcastTotalTB),
        verdictLabel(y3.simChainTB, y3.fcastChainTB),
        verdictLabel(y3.simGfsTB,   y3.fcastGfsTB),
        verdictLabel(y3.simWsTB,    y3.fcastWsTB),
      ];
      const worstV = vdcts.includes('FAIL') ? 'FAIL' : vdcts.includes('WARN') ? 'WARN' : vdcts.every((v) => v === 'NA') ? 'NA' : 'PASS';
      const worstClass = worstV === 'FAIL' ? 'delta-bad' : worstV === 'WARN' ? 'delta-warn' : worstV === 'PASS' ? 'delta-ok' : '';
      const sfPct = y3.fcastTotalTB > 0 ? ((y3.simTotalTB - y3.fcastTotalTB) / y3.fcastTotalTB * 100) : 0;
      const scPct = calcRef.totalTB > 0 ? ((y3.simTotalTB - calcRef.totalTB) / calcRef.totalTB * 100) : null;
      return `
        <tr>
          <td style="text-align:left;font-family:monospace;font-size:12px">${sc.id}</td>
          <td class="sim-col">${fmt(y3.simTotalTB)}</td>
          <td class="fcast-col">${fmt(y3.fcastTotalTB)}</td>
          <td class="calc-col">${fmt(calcRef.totalTB)}</td>
          <td class="delta-col ${deltaClass(y3.simTotalTB, y3.fcastTotalTB)}">${sfPct >= 0 ? '+' : ''}${sfPct.toFixed(1)}%</td>
          <td class="delta-col ${scPct !== null ? deltaClass(y3.simTotalTB, calcRef.totalTB) : ''}">${scPct !== null ? `${scPct >= 0 ? '+' : ''}${scPct.toFixed(1)}%` : '—'}</td>
          <td class="delta-col ${worstClass}">${worstV}</td>
        </tr>`;
    })
    .join('');
  return `
  <section class="cross-comparison">
    <h2 style="font-size:1.0rem;margin:0 0 8px">Cross-Scenario Comparison (Y3 / Q12)</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th style="text-align:left">Scenario</th>
            <th class="sim-col">Sim Q12 TB</th>
            <th class="fcast-col">Fcast Q12 TB</th>
            <th class="calc-col">Calc Y3 TB</th>
            <th class="delta-col">Δ S/F</th>
            <th class="delta-col">Δ S/C</th>
            <th class="delta-col">Worst Verdict</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

function generateHtml(sections: string, crossScenarioHtml: string): string {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Veeam Simulator — Tri-Way Quarterly Comparison</title>
  <style>
    :root {
      --col-sim:   #1e4d7b;
      --col-fcast: #2d6a3f;
      --col-calc:  #7b3f00;
      --col-ok:    #1a7f37;
      --col-warn:  #b45309;
      --col-bad:   #b91c1c;
    }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px;
      background: #f8fafc;
      color: #1e293b;
      margin: 0;
      padding: 20px 32px;
    }
    h1 { font-size: 1.5rem; margin-bottom: 4px; }
    .subtitle { color: #64748b; margin-bottom: 32px; font-size: 0.9rem; }
    .scenario { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px 24px; margin-bottom: 36px; }
    h2 { font-size: 1.1rem; font-family: monospace; color: #0f172a; margin: 0 0 2px; }
    .scenario-name { color: #475569; font-size: 0.85rem; margin: 0 0 12px; }
    .config-badge {
      display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px;
    }
    .config-badge span {
      background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 4px;
      padding: 2px 8px; font-size: 0.78rem; color: #334155;
    }
    .quality-panel {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 6px;
      margin-bottom: 12px;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 0.78rem;
      background: #f8fafc;
    }
    .quality-panel span { color: #334155; }
    .table-group {
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      margin: 10px 0;
      background: #ffffff;
    }
    .table-group summary {
      cursor: pointer;
      font-weight: 600;
      font-size: 0.86rem;
      color: #0f172a;
      padding: 10px 12px;
      background: #f8fafc;
      border-bottom: 1px solid #e2e8f0;
      user-select: none;
    }
    .table-group[open] summary {
      background: #eef2ff;
    }
    .table-wrap { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; }
    th, td {
      border: 1px solid #e2e8f0;
      padding: 5px 10px;
      text-align: right;
      white-space: nowrap;
    }
    th { background: #f1f5f9; font-weight: 600; text-align: center; position: sticky; top: 0; z-index: 1; }
    tr:hover td { background: #f0f4f8; }
    th.sub, td.sub { font-size: 11px; color: #64748b; }
    th.sub { font-style: italic; }
    .year3-row td { background: #fefce8; font-weight: 600; }
    .year3-row:hover td { background: #fef9c3; }
    .sim-col   { color: var(--col-sim); }
    .fcast-col { color: var(--col-fcast); }
    .calc-col  { color: var(--col-calc); }
    .delta-col { font-size: 11px; }
    .ref-val   { font-weight: 700; }
    .delta-ok  { color: var(--col-ok);   background: #f0fdf4 !important; }
    .delta-warn{ color: var(--col-warn); background: #fffbeb !important; }
    .delta-bad { color: var(--col-bad);  background: #fef2f2 !important; }
    .legend {
      margin-top: 10px; font-size: 0.75rem; color: #64748b;
      border-top: 1px dashed #e2e8f0; padding-top: 8px;
    }
    .delta-ok-key  { color: var(--col-ok);   font-weight: 600; }
    .delta-warn-key{ color: var(--col-warn);  font-weight: 600; }
    .delta-bad-key { color: var(--col-bad);   font-weight: 600; }
    .decision-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 6px; margin-bottom: 12px;
      border-radius: 8px; padding: 8px 12px;
      font-size: 0.82rem; border-left: 4px solid currentColor;
    }
    .trend-up   { color: var(--col-ok);  font-weight: 700; text-align: center; }
    .trend-down { color: var(--col-bad); font-weight: 700; text-align: center; }
    .trend-flat { color: #94a3b8;        font-weight: 700; text-align: center; }
    .cross-comparison { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px 24px; margin-bottom: 36px; }
  </style>
</head>
<body>
  <h1>Veeam Simulator — Tri-Way Quarterly Comparison</h1>
  <p class="subtitle">
    Generated ${now} UTC &nbsp;|&nbsp;
    Start date: ${START_DATE} &nbsp;|&nbsp;
    Horizon: ${QUARTERS} quarters (${TOTAL_DAYS} days) &nbsp;|&nbsp;
    5 diverse scenarios
  </p>
  ${crossScenarioHtml}
  ${sections}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('Tri-Way Quarterly Report');
console.log('='.repeat(50));

const sectionHtmlParts: string[] = [];
const allScenarioData: Array<{ sc: ReportScenario; points: QuarterPoint[] }> = [];

for (const rawScenario of REPORT_SCENARIOS) {
  const sc = withBaselineCalcRef(rawScenario);
  process.stdout.write(`  Running: ${sc.id} ...`);
  const points = runScenarioReport(sc);
  allScenarioData.push({ sc, points });
  sectionHtmlParts.push(buildScenarioSection(sc, points));
  console.log(` done (${points.length} quarters)`);
}

const crossScenarioHtml = buildCrossScenarioTable(allScenarioData);
const html = generateHtml(sectionHtmlParts.join('\n'), crossScenarioHtml);
const outPath = path.join(__dirname, '../../docs/quarterly-comparison-report.html');
fs.writeFileSync(outPath, html, 'utf8');

console.log(`\nReport written to: docs/quarterly-comparison-report.html`);
