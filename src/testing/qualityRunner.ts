/**
 * qualityRunner.ts
 *
 * Runs the full quality pipeline in one command:
 * 1) mutation testing (writes docs/mutation-report.json)
 * 2) lifecycle suite + consolidated HTML report (docs/lifecycle-report.html)
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

function main() {
  const args = process.argv.slice(2);
  const updateSnapshots = args.includes('--update-snapshots');

  const mutationCode = run('npm', ['run', 'test:mutation']);
  const lifecycleArgs = updateSnapshots
    ? ['run', 'test:lifecycle', '--', '--update-snapshots']
    : ['run', 'test:lifecycle'];
  const lifecycleCode = run('npm', lifecycleArgs);

  const finalCode = mutationCode !== 0 || lifecycleCode !== 0 ? 1 : 0;
  if (finalCode === 0) {
    console.log('\nQuality pipeline passed. Consolidated report: docs/lifecycle-report.html');
  } else {
    console.log('\nQuality pipeline has failures. Consolidated report still generated: docs/lifecycle-report.html');
  }
  process.exit(finalCode);
}

main();
