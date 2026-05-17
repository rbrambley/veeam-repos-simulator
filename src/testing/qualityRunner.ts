/**
 * qualityRunner.ts
 *
 * Runs the full quality pipeline in one command:
 * 1) calculator parity comparison (writes docs/comparison-results-*.{json,csv,txt})
 * 2) forecast vs simulation report + consolidated summary guardrails
 * 3) mutation testing (writes docs/mutation-report.json)
 * 4) lifecycle suite + consolidated HTML report (docs/lifecycle-report.html)
 *
 * Optional: --update-snapshots to reseed phase-2 golden baseline.
 *
 * Exit code is non-zero if either phase fails.
 */

import { spawnSync } from 'child_process';

function run(command: string, args: string[]): number {
  const label = `${command} ${args.join(' ')}`.trim();
  console.log(`\n=== Running: ${label} ===`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: true });
  const code = result.status ?? 1;
  console.log(`=== Exit code: ${code} (${label}) ===`);
  return code;
}

function runWithEnv(command: string, args: string[], env: NodeJS.ProcessEnv): number {
  const label = `${command} ${args.join(' ')}`.trim();
  console.log(`\n=== Running: ${label} ===`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: true, env });
  const code = result.status ?? 1;
  console.log(`=== Exit code: ${code} (${label}) ===`);
  return code;
}

function main() {
  const args = process.argv.slice(2);
  const updateSnapshots = args.includes('--update-snapshots');

  const compareCode = run('npm', ['run', 'compare:veeam']);
  const reportEnv: NodeJS.ProcessEnv = {
    ...process.env,
    COMPARE_VEEAM_EXIT_CODE: String(compareCode),
  };
  const forecastReportCode = runWithEnv('npm', ['run', 'report:forecast-vs-simulation', '--', '--enforce-thresholds'], reportEnv);
  const gfsSizingCode = run('npm', ['run', 'test:gfs-sizing']);
  const mutationCode = run('npm', ['run', 'test:mutation']);
  const lifecycleArgs = updateSnapshots
    ? ['run', 'test:lifecycle', '--', '--update-snapshots']
    : ['run', 'test:lifecycle'];
  const lifecycleEnv: NodeJS.ProcessEnv = {
    ...process.env,
    COMPARE_VEEAM_EXIT_CODE: String(compareCode),
    FORECAST_REPORT_EXIT_CODE: String(forecastReportCode),
    GFS_SIZING_TEST_EXIT_CODE: String(gfsSizingCode),
    GFS_SIZING_TEST_RAN_AT: new Date().toISOString(),
  };
  const lifecycleCode = runWithEnv('npm', lifecycleArgs, lifecycleEnv);

  const finalCode = compareCode !== 0
    || forecastReportCode !== 0
    || gfsSizingCode !== 0
    || mutationCode !== 0
    || lifecycleCode !== 0
    ? 1
    : 0;
  if (finalCode === 0) {
    console.log('\nQuality pipeline passed. Consolidated report: docs/lifecycle-report.html');
  } else {
    console.log('\nQuality pipeline has failures. Consolidated report still generated: docs/lifecycle-report.html');
  }
  process.exit(finalCode);
}

main();
