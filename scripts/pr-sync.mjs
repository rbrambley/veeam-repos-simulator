#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = { draft: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--draft') {
      out.draft = true;
      continue;
    }
    if (arg.startsWith('--') && i + 1 < argv.length) {
      out[arg.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

function run(cmd, args, { allowFailure = false } = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFailure) {
      return null;
    }
    const stderr = err?.stderr?.toString?.() ?? '';
    const stdout = err?.stdout?.toString?.() ?? '';
    throw new Error(`${cmd} ${args.join(' ')} failed.\n${stderr || stdout}`.trim());
  }
}

function resolveGhBinary() {
  if (process.env.GH_PATH && existsSync(process.env.GH_PATH)) {
    return process.env.GH_PATH;
  }

  if (process.platform === 'win32') {
    const winCandidates = [
      'C:/Program Files/GitHub CLI/gh.exe',
      'C:/Program Files/GitHub CLI/bin/gh.exe',
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs/GitHub CLI/gh.exe'),
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs/GitHub CLI/bin/gh.exe'),
    ];
    for (const candidate of winCandidates) {
      if (candidate && existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return 'gh';
}

function discoverDefaultBaseBranch() {
  const ref = run('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { allowFailure: true });
  if (ref && ref.startsWith('refs/remotes/origin/')) {
    return ref.replace('refs/remotes/origin/', '');
  }
  return 'main';
}

function discoverBodyFile(cwd) {
  const docsDir = path.join(cwd, 'docs');
  if (!existsSync(docsDir)) {
    return null;
  }

  const matches = readdirSync(docsDir)
    .filter((f) => /^pr-summary-.*\.md$/i.test(f))
    .sort((a, b) => b.localeCompare(a));

  if (matches.length === 0) {
    return null;
  }

  return path.join('docs', matches[0]);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const gh = resolveGhBinary();
  const cwd = process.cwd();

  run('git', ['rev-parse', '--is-inside-work-tree']);

  const authStatus = run(gh, ['auth', 'status'], { allowFailure: true });
  if (!authStatus) {
    console.error('GitHub CLI is installed but not authenticated.');
    console.error(`Run: ${gh} auth login --hostname github.com --web --git-protocol https`);
    process.exit(1);
  }

  const head = args.head || run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const base = args.base || discoverDefaultBaseBranch();
  const title = args.title || run('git', ['log', '-1', '--pretty=%s']);
  const bodyFile = args['body-file'] || discoverBodyFile(cwd);

  const listRaw = run(gh, [
    'pr',
    'list',
    '--state',
    'open',
    '--head',
    head,
    '--base',
    base,
    '--json',
    'number,url,title',
    '--limit',
    '1',
  ]);

  const existing = JSON.parse(listRaw || '[]');

  if (existing.length > 0) {
    const number = String(existing[0].number);
    const editArgs = ['pr', 'edit', number, '--title', title];
    if (bodyFile) {
      editArgs.push('--body-file', bodyFile);
    }
    run(gh, editArgs);

    const view = run(gh, ['pr', 'view', number, '--json', 'url', '--jq', '.url']);
    console.log(`Updated PR #${number}: ${view}`);
    return;
  }

  const createArgs = ['pr', 'create', '--base', base, '--head', head, '--title', title];
  if (bodyFile) {
    createArgs.push('--body-file', bodyFile);
  } else {
    createArgs.push('--body', 'Automated PR created via scripts/pr-sync.mjs');
  }
  if (args.draft) {
    createArgs.push('--draft');
  }

  const url = run(gh, createArgs);
  const bodyInfo = bodyFile ? ` body=${bodyFile}` : ' body=<generated>';
  console.log(`Created PR for ${head} -> ${base}:${bodyInfo}`);
  console.log(url);

  if (bodyFile) {
    // Quick safety check that body file is readable and non-empty.
    const body = readFileSync(path.join(cwd, bodyFile), 'utf8').trim();
    if (!body) {
      console.warn(`Warning: ${bodyFile} is empty.`);
    }
  }
}

main();
