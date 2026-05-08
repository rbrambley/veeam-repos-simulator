import { spawnSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

const expectedFailingIds = new Set<string>([]);

function getCompareCommand(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm run compare:veeam:raw'],
    };
  }

  return {
    command: 'npm',
    args: ['run', 'compare:veeam:raw'],
  };
}

function extractFailedScenarioIds(output: string): string[] {
  const matches = output.matchAll(/^❌\s+([a-z0-9-]+):/gm);
  return Array.from(matches, (match) => match[1].trim());
}

function main(): void {
  const { command, args } = getCompareCommand();
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf-8',
  });

  if (result.error) {
    console.error('Failed to execute compare:veeam');
    console.error(result.error.message);
    process.exit(1);
  }

  const combinedOutput = `${result.stdout || ''}${result.stderr || ''}`;
  const actualFailingIds = new Set(extractFailedScenarioIds(combinedOutput));

  const unexpectedFailures = [...actualFailingIds].filter((id) => !expectedFailingIds.has(id));
  const missingFailures = [...expectedFailingIds].filter((id) => !actualFailingIds.has(id));

  console.log('Known Veeam Calculator Delta Verification');
  console.log('');
  if (expectedFailingIds.size === 0) {
    console.log('Expected calculator divergences: none');
  } else {
    console.log('Expected calculator divergences:');
    for (const id of expectedFailingIds) {
      console.log(`  - ${id}`);
    }
  }
  console.log('');

  if (result.stdout) {
    console.log(result.stdout.trimEnd());
    console.log('');
  }
  if (result.stderr) {
    console.error(result.stderr.trimEnd());
    console.error('');
  }

  if (unexpectedFailures.length === 0 && missingFailures.length === 0) {
    console.log('Known delta verification passed.');
    if (expectedFailingIds.size === 0) {
      console.log('Observed zero calculator divergences.');
    } else {
      console.log(`Observed only the expected ${expectedFailingIds.size} calculator divergences.`);
    }
    process.exit(0);
  }

  console.error('Known delta verification failed.');
  if (unexpectedFailures.length > 0) {
    console.error(`Unexpected failing scenarios: ${unexpectedFailures.join(', ')}`);
  }
  if (missingFailures.length > 0) {
    console.error(`Expected failing scenarios that no longer fail: ${missingFailures.join(', ')}`);
  }
  process.exit(1);
}

main();