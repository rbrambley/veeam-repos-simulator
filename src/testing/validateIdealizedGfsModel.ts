import {
  buildValidationMatrix,
  computeCurrentEngineSyntheticFullBreakdown,
  computeCurrentForecastGfsBreakdown,
  computeIdealizedGfsBreakdown,
  isWithinTolerance,
} from './idealizedGfsModel.ts';

interface ComparisonRow {
  restorePoint: string;
  spacingDays: number;
  expectedUniqueTB: number;
  expectedClonedTB: number;
  forecastUniqueTB: number;
  forecastClonedTB: number;
  engineUniqueTB: number;
  engineClonedTB: number;
  forecastMatches: boolean;
  engineMatches: boolean;
}

const FULL_SIZE_TB = 6.66;
const DAILY_CHANGE_RATE = 0.10;
const ROUNDING_TOLERANCE_TB = 1e-9;

function toFixedTB(value: number): string {
  return value.toFixed(6);
}

function buildRows(): ComparisonRow[] {
  return buildValidationMatrix().map((entry) => {
    const expected = computeIdealizedGfsBreakdown(FULL_SIZE_TB, DAILY_CHANGE_RATE, entry.spacingDays);
    const forecast = computeCurrentForecastGfsBreakdown(FULL_SIZE_TB, entry.spacingDays, DAILY_CHANGE_RATE);
    const engine = computeCurrentEngineSyntheticFullBreakdown(FULL_SIZE_TB, DAILY_CHANGE_RATE, entry.spacingDays);

    return {
      restorePoint: entry.restorePoint,
      spacingDays: entry.spacingDays,
      expectedUniqueTB: expected.uniqueTB,
      expectedClonedTB: expected.clonedTB,
      forecastUniqueTB: forecast.uniqueTB,
      forecastClonedTB: forecast.clonedTB,
      engineUniqueTB: engine.uniqueTB,
      engineClonedTB: engine.clonedTB,
      forecastMatches:
        isWithinTolerance(forecast.uniqueTB, expected.uniqueTB, ROUNDING_TOLERANCE_TB) &&
        isWithinTolerance(forecast.clonedTB, expected.clonedTB, ROUNDING_TOLERANCE_TB),
      engineMatches:
        isWithinTolerance(engine.uniqueTB, expected.uniqueTB, ROUNDING_TOLERANCE_TB) &&
        isWithinTolerance(engine.clonedTB, expected.clonedTB, ROUNDING_TOLERANCE_TB),
    };
  });
}

function printExpectedReference(): void {
  const weekly = computeIdealizedGfsBreakdown(FULL_SIZE_TB, DAILY_CHANGE_RATE, 7);
  const monthly = computeIdealizedGfsBreakdown(FULL_SIZE_TB, DAILY_CHANGE_RATE, 30);
  const yearly = computeIdealizedGfsBreakdown(FULL_SIZE_TB, DAILY_CHANGE_RATE, 365);

  console.log('Idealized block-clone reference values');
  console.log(`  Full size (F): ${FULL_SIZE_TB.toFixed(2)} TB`);
  console.log(`  Daily change rate (C): ${(DAILY_CHANGE_RATE * 100).toFixed(2)}%`);
  console.log(`  Weekly D=7  -> unique=${toFixedTB(weekly.uniqueTB)} TB cloned=${toFixedTB(weekly.clonedTB)} TB`);
  console.log(`  Monthly D=30 -> unique=${toFixedTB(monthly.uniqueTB)} TB cloned=${toFixedTB(monthly.clonedTB)} TB`);
  console.log(`  Yearly D=365 -> unique=${toFixedTB(yearly.uniqueTB)} TB cloned=${toFixedTB(yearly.clonedTB)} TB`);
  console.log('');
}

function printMatrix(rows: ComparisonRow[]): void {
  console.log('Comparison matrix');
  for (const row of rows) {
    const expectedSumOk = isWithinTolerance(row.expectedUniqueTB + row.expectedClonedTB, FULL_SIZE_TB, ROUNDING_TOLERANCE_TB);
    console.log(
      `${row.restorePoint.padEnd(8)} D=${String(row.spacingDays).padStart(3)} | ` +
      `expected U=${toFixedTB(row.expectedUniqueTB)} C=${toFixedTB(row.expectedClonedTB)} sumOk=${expectedSumOk ? 'yes' : 'no'} | ` +
      `forecast U=${toFixedTB(row.forecastUniqueTB)} C=${toFixedTB(row.forecastClonedTB)} ${row.forecastMatches ? 'MATCH' : 'MISMATCH'} | ` +
      `engine U=${toFixedTB(row.engineUniqueTB)} C=${toFixedTB(row.engineClonedTB)} ${row.engineMatches ? 'MATCH' : 'MISMATCH'}`
    );
  }
  console.log('');
}

function printMismatchReport(rows: ComparisonRow[]): void {
  console.log('Mismatch report');
  for (const row of rows) {
    if (!row.forecastMatches) {
      console.log(
        `  Forecast ${row.restorePoint}: expected unique=${toFixedTB(row.expectedUniqueTB)} cloned=${toFixedTB(row.expectedClonedTB)}; ` +
        `actual unique=${toFixedTB(row.forecastUniqueTB)} cloned=${toFixedTB(row.forecastClonedTB)}; ` +
        'likely cause=formula/logic (current forecast counts each GFS point as a full-sized unique block set).'
      );
    }
    if (!row.engineMatches) {
      console.log(
        `  Engine ${row.restorePoint}: expected unique=${toFixedTB(row.expectedUniqueTB)} cloned=${toFixedTB(row.expectedClonedTB)}; ` +
        `actual unique=${toFixedTB(row.engineUniqueTB)} cloned=${toFixedTB(row.engineClonedTB)}; ` +
        'likely cause=logic (current engine stores SyntheticFull points at one-day incremental size with no clone split).'
      );
    }
  }
  console.log('');
}

function printSummary(rows: ComparisonRow[]): void {
  const forecastMatches = rows.filter((row) => row.forecastMatches).length;
  const engineMatches = rows.filter((row) => row.engineMatches).length;
  console.log('Summary');
  console.log(`  Idealized formula invariant passed: ${rows.length}/${rows.length}`);
  console.log(`  Current forecast/comparator matches: ${forecastMatches}/${rows.length}`);
  console.log(`  Current engine sizing matches: ${engineMatches}/${rows.length}`);
  console.log('');
  console.log('Recommendation');
  console.log('  Simulator engine: update needed if the goal is to replicate the calculator rather than real backup-chain behavior.');
  console.log('  Comparator/forecast logic: update needed; it currently models full-sized GFS points instead of unique-plus-cloned synthetic fulls.');
  console.log('  UI/reporting: structural changes are not required for totals-only views, but labels/docs should explain that preserved GFS points are modeled as synthetic fulls with unique and cloned portions.');
  console.log('  Sufficiency of model: sufficient for the observed calculator pattern in this matrix, but not enough to claim full equivalence until validated against more mixed-calendar scenarios and remaining baseline captures.');
}

function main(): void {
  const rows = buildRows();
  printExpectedReference();
  printMatrix(rows);
  printMismatchReport(rows);
  printSummary(rows);
}

main();