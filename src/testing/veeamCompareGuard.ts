import { spawnSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

function runNpmScript(script: string, extraArgs: string[] = []): number {
  const result = process.platform === 'win32'
    ? spawnSync(
        'cmd.exe',
        [
          '/d',
          '/s',
          '/c',
          `npm run ${script}${extraArgs.length > 0 ? ` -- ${extraArgs.map((arg) => `"${arg.replace(/"/g, '\\"')}"`).join(' ')}` : ''}`,
        ],
        {
          cwd: projectRoot,
          stdio: 'inherit',
          env: process.env,
        }
      )
    : spawnSync('npm', ['run', script, ...(extraArgs.length > 0 ? ['--', ...extraArgs] : [])], {
        cwd: projectRoot,
        stdio: 'inherit',
        env: process.env,
      });

  if (result.error) {
    console.error(`Failed to run npm script: ${script}`);
    console.error(result.error.message);
    return 1;
  }

  return result.status ?? 1;
}

function main(): void {
  const passthroughArgs = process.argv.slice(2);

  console.log('');
  console.log('Enforcement gate: internal-first troubleshooting policy');
  console.log('Step 1/3: npm run test:lifecycle');
  const lifecycleCode = runNpmScript('test:lifecycle');
  if (lifecycleCode !== 0) {
    console.error('Blocked: compare:veeam requires test:lifecycle to pass first.');
    process.exit(lifecycleCode);
  }

  console.log('');
  console.log('Step 2/3: npm run compare:model');
  const modelCode = runNpmScript('compare:model');
  if (modelCode !== 0) {
    console.error('Blocked: compare:veeam requires compare:model to pass first.');
    process.exit(modelCode);
  }

  console.log('');
  console.log('Step 3/3: npm run compare:veeam:raw');
  const veeamCode = runNpmScript('compare:veeam:raw', passthroughArgs);
  process.exit(veeamCode);
}

main();
