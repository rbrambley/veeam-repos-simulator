/**
 * Veeam Calculator Capture Guide
 *
 * Interactive CLI that walks you through each scenario, shows exactly what inputs
 * to enter in the Veeam Calculator (https://calculator.veeam.com) using Veeam's own
 * field names, then prompts you to enter the results. Saves them to
 * docs/veeam-calculator-baseline.json.
 *
 * Usage:
 *   npm run capture:veeam              -- guide for all scenarios
 *   npm run capture:veeam -- --id das-basic   -- guide for one scenario only
 *   npm run capture:veeam -- --paste          -- paste Veeam text blocks to auto-parse
 *
 * Known structural differences between Veeam Calculator and this simulator:
 *   - Veeam "Block generation period" (10 days by default) is a cloud object
 *     storage behavior that is not modeled yet in this simulator.
 *   - The simulator currently uses its own chain/full cadence logic.
 *   - The model-aligned baseline is stored separately in docs/veeam-model-baseline.json.
 *   - "Working space" can be captured for reference, but its definition may not
 *     be one-to-one with the simulator's planned-capacity working space.
 *   - These comparisons are directional, not exact equivalents.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const PROJECT_ROOT = path.resolve(process.cwd());
const SCENARIOS_FILE = path.join(PROJECT_ROOT, 'docs', 'test-scenarios.json');
const BASELINE_FILE  = path.join(PROJECT_ROOT, 'docs', 'veeam-calculator-baseline.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ScenarioConfig {
  repositoryType: string;
  jobType: string;
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
}

interface Scenario {
  id: string;
  name: string;
  description: string;
  config: ScenarioConfig;
}

interface BaselineEntry {
  id: string;
  notes?: string;
  expected: {
    plannedCapacityTB?: number | null;
    plannedPerformanceTierTB?: number | null;
    plannedCapacityTierTB?: number | null;
    plannedArchiveTierTB?: number | null;
    veeamWorkingSpaceTB?: number | null;
  };
}

interface BaselineFile {
  defaults: Record<string, unknown>;
  scenarios: BaselineEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function loadJSON<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function saveBaseline(baseline: BaselineFile): void {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2), 'utf-8');
}

function rl(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(iface: readline.Interface, prompt: string): Promise<string> {
  return new Promise(resolve => iface.question(prompt, answer => resolve(answer.trim())));
}

function parseOptionalFloat(input: string): number | null {
  if (!input || input.toLowerCase() === 'skip' || input === '') return null;
  const v = parseFloat(input);
  return isNaN(v) ? null : v;
}

function hr(char = '─', width = 72): string {
  return char.repeat(width);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractNumberNearLabel(text: string, labels: string[], unitPattern = '(?:TB|%)', window = 80): number | null {
  for (const label of labels) {
    const regex = new RegExp(`${escapeRegExp(label)}[\\s\\S]{0,${window}}?(-?\\d+(?:\\.\\d+)?)\\s*${unitPattern}`, 'i');
    const match = text.match(regex);
    if (match) {
      const parsed = parseFloat(match[1]);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

function extractNumberAfterLabel(text: string, labels: string[], window = 40): number | null {
  for (const label of labels) {
    const regex = new RegExp(`${escapeRegExp(label)}[\\s\\S]{0,${window}}?(-?\\d+(?:\\.\\d+)?)`, 'i');
    const match = text.match(regex);
    if (match) {
      const parsed = parseFloat(match[1]);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

interface ParsedVeeamCapture {
  storageRequiredTB: number | null;
  workingSpaceTB: number | null;
  sourceDataTB: number | null;
  dailyChangeRatePct: number | null;
  growthRatePct: number | null;
  forecastPeriodYears: number | null;
  retentionDays: number | null;
}

function parseVeeamCaptureText(raw: string): ParsedVeeamCapture {
  const normalized = raw.replace(/\r/g, '\n');
  return {
    storageRequiredTB: extractNumberNearLabel(normalized, ['Storage required', 'Repository'], '(?:TB)', 120),
    workingSpaceTB: extractNumberNearLabel(normalized, ['Working space'], '(?:TB)', 80),
    sourceDataTB: extractNumberNearLabel(normalized, ['Source data'], '(?:TB)', 60),
    dailyChangeRatePct: extractNumberNearLabel(normalized, ['Daily change rate'], '(?:%)', 60),
    growthRatePct: extractNumberNearLabel(normalized, ['Growth rate'], '(?:%)', 60),
    forecastPeriodYears: extractNumberAfterLabel(normalized, ['Forecast period'], 40),
    retentionDays: extractNumberAfterLabel(normalized, ['Days'], 40),
  };
}

function maybeWarnMismatch(label: string, expected: number, actual: number | null, tolerance = 0.01): string | null {
  if (actual === null) return null;
  if (Math.abs(expected - actual) <= tolerance) return null;
  return `  ⚠ ${label} mismatch: scenario=${expected}, pasted=${actual}`;
}

async function askMultiline(iface: readline.Interface, intro: string): Promise<string | null> {
  console.log(intro);
  console.log('  Paste lines now. Type END on a new line when done, or type exit to skip.');
  const lines: string[] = [];

  while (true) {
    const line = await ask(iface, '  > ');
    if (line.toLowerCase() === 'exit') return null;
    if (line === 'END') break;
    lines.push(line);
  }

  return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Cheat-sheet builder
// Shows Veeam Calculator's own field names and values for each scenario.
// Every scenario always shows the full input table — nothing is omitted or
// referenced from a previous scenario.
// ---------------------------------------------------------------------------
function buildCheatSheet(scenario: Scenario): string[] {
  const c = scenario.config;
  const isSobr = c.repositoryType === 'SOBR';

  // Veeam Calculator always uses Forward Incremental with weekly Synthetic Fulls.
  // There is no job type selector — it is fixed.

  const lines: string[] = [
    '',
    hr('═'),
    `  Scenario : ${scenario.name}`,
    `  ID       : ${scenario.id}`,
    hr('═'),
    '',
    '  Open: https://calculator.veeam.com  (VM Backup tab)',
    '  Enter the fields below using Veeam Calculator\'s own labels.',
    '',
    hr(),
    '  VEEAM CALCULATOR INPUT FIELDS',
    hr(),
    `  Source data              : ${c.sourceDataTB} TB`,
    `  Daily change rate        : ${c.dailyChangeRatePct} %`,
    '',
    '  ── Policy ──────────────────────────────────────────────────────────',
    '  Backup window            : 8 hours         [Veeam default — leave as-is]',
    '  Direct to object storage?: OFF',
    '  ReFS/XFS?                : ON              [assumed ON for current simulator comparison]',
    `  Capacity Tier?           : ${isSobr ? 'ON ' : 'OFF'}             ${isSobr ? '← enables SOBR capacity tier' : '← DAS: no capacity tier'}`,
    '  Enable immutability?     : OFF',
    '',
    '  ── Retention ───────────────────────────────────────────────────────',
    `  Days                     : ${c.retention}`,
    `  GFS — Weeks              : ${c.gfsPolicy.weekly}`,
    `  GFS — Months             : ${c.gfsPolicy.monthly}`,
    `  GFS — Years              : ${c.gfsPolicy.yearly}`,
    '',
    '  ── Advanced ────────────────────────────────────────────────────────',
    `  Forecast period          : 3 years`,
    `  Growth rate              : ${c.annualGrowthRatePct} %`,
    '  Compress by              : 50 %            [Veeam default — leave as-is]',
  ];

  if (isSobr) {
    lines.push('');
    lines.push('  ── Capacity Tier settings (shown when Capacity Tier? is ON) ────────');
    lines.push('  Note: Veeam\'s field names here may differ from the labels below.');
    lines.push('  Match the intent as closely as possible.');
    lines.push(`  Offload after            : ${c.offloadAfterDays} days`);
    if (c.hasArchiveTier) {
      lines.push(`  Archive after            : ${c.archiveAfterDays} days`);
      lines.push('  Archive tier             : ON  (if a separate archive toggle is shown)');
    } else {
      lines.push('  Archive tier             : OFF (if a separate archive toggle is shown)');
    }
    if (c.copyEnabled && c.moveEnabled) {
      lines.push('  Copy/Move mode           : Copy + Move  (keep copy in perf tier AND move older)');
    } else if (c.moveEnabled) {
      lines.push('  Copy/Move mode           : Move-Only    (move to capacity tier, no copy kept)');
    }
  }

  lines.push('');
  lines.push(hr());
  lines.push('  VEEAM CALCULATOR OUTPUT — VALUES TO CAPTURE');
  lines.push('  (From the "Result detail" or "Restore Points Simulation" panel)');
  lines.push(hr());
  lines.push('  "Storage required"       → top-level TB value shown in results panel');
  if (isSobr) {
    lines.push('  Performance Tier (TB)    → performance tier size shown in tier breakdown');
    lines.push('                             (skip with ENTER if Veeam does not show tier detail)');
    lines.push('  Capacity Tier (TB)       → capacity tier size shown in tier breakdown');
    lines.push('                             (skip with ENTER if Veeam does not show tier detail)');
    lines.push('  Archive Tier (TB)        → archive tier size, or 0 if disabled');
  }
  lines.push('  "Working space"          → shown at the bottom of Restore Points Simulation');
  lines.push('                             (capture for reference; definition may differ from simulator)');
  lines.push('');
  lines.push('  ── Known differences from this simulator ───────────────────────────');
  lines.push('  Veeam block generation period (10 days default) is a cloud-object feature');
  lines.push('  not modeled yet in this simulator. Deltas are expected and directional.');
  lines.push('  ReFS/XFS is assumed ON for current comparison runs.');
  lines.push('');

  return lines;
}

function buildQuickChecklist(scenario: Scenario): string[] {
  const c = scenario.config;
  const lines = [
    `  QUICK CHECKLIST (${scenario.id})`,
    `  Source data=${c.sourceDataTB}TB, Change=${c.dailyChangeRatePct}%, Retention=${c.retention}d, Growth=${c.annualGrowthRatePct}%`,
    `  GFS: W=${c.gfsPolicy.weekly}, M=${c.gfsPolicy.monthly}, Y=${c.gfsPolicy.yearly}`,
    `  Capacity Tier=${c.repositoryType === 'SOBR' ? 'ON' : 'OFF'}, ReFS/XFS=ON, Forecast=3y, Compress=50%`,
  ];

  if (c.repositoryType === 'SOBR') {
    lines.push(`  SOBR: Offload=${c.offloadAfterDays}d, Archive=${c.hasArchiveTier ? `${c.archiveAfterDays}d` : 'OFF'}, Mode=${c.copyEnabled && c.moveEnabled ? 'Copy+Move' : c.moveEnabled ? 'Move-Only' : 'Copy-Only'}`);
  }

  lines.push('  Capture from Veeam output: Storage required (TB) + Working space (TB)');
  return lines;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const idFlagIdx = args.indexOf('--id');
  const filterId = idFlagIdx >= 0 ? args[idFlagIdx + 1] : null;
  const pasteMode = args.includes('--paste');

  const { scenarios } = loadJSON<{ scenarios: Scenario[] }>(SCENARIOS_FILE);
  const baseline = loadJSON<BaselineFile>(BASELINE_FILE);

  const targets = filterId
    ? scenarios.filter(s => s.id === filterId)
    : scenarios;

  if (targets.length === 0) {
    console.error(`No scenario found with id "${filterId}". Check test-scenarios.json.`);
    process.exit(1);
  }

  console.log('');
  console.log('  Veeam Calculator Capture Guide');
  console.log('  ─────────────────────────────────────────────────────────────────────');
  console.log('  This guide walks you through each scenario using Veeam\'s own field');
  console.log('  names. Open the Veeam Calculator, set the inputs shown, then enter');
  console.log('  the values from the results panel.');
  console.log('  Values are saved to docs/veeam-calculator-baseline.json.');
  console.log('  Press ENTER to skip a value (it stays null / unchanged).');
  console.log('  Type "exit" at any prompt to skip to the next scenario.');
  if (pasteMode) {
    console.log('  Paste mode enabled: paste Veeam inputs/results text and values will be parsed automatically.');
  }
  console.log('');

  const iface = rl();
  let changesMade = false;

  for (const scenario of targets) {
    const cheatSheet = buildCheatSheet(scenario);
    cheatSheet.forEach(l => console.log(l));

    const isSobr = scenario.config.repositoryType === 'SOBR';

    // Find or create the baseline entry for this scenario
    let entry = baseline.scenarios.find(e => e.id === scenario.id);
    if (!entry) {
      entry = { id: scenario.id, notes: '', expected: {} };
      baseline.scenarios.push(entry);
    }

    if (pasteMode) {
      console.log('');
      buildQuickChecklist(scenario).forEach(l => console.log(l));
      console.log('');
      const pasted = await askMultiline(
        iface,
        '  Paste Veeam text for this scenario (you can include both Inputs and Result detail sections).',
      );
      if (pasted === null) {
        console.log('  Skipping this scenario.');
        continue;
      }

      const parsed = parseVeeamCaptureText(pasted);

      const inputWarnings = [
        maybeWarnMismatch('Source data (TB)', scenario.config.sourceDataTB, parsed.sourceDataTB),
        maybeWarnMismatch('Daily change rate (%)', scenario.config.dailyChangeRatePct, parsed.dailyChangeRatePct),
        maybeWarnMismatch('Growth rate (%)', scenario.config.annualGrowthRatePct, parsed.growthRatePct),
        maybeWarnMismatch('Forecast period (years)', 3, parsed.forecastPeriodYears),
        maybeWarnMismatch('Retention days', scenario.config.retention, parsed.retentionDays),
      ].filter((v): v is string => Boolean(v));

      if (inputWarnings.length > 0) {
        console.log('  Input mismatch checks:');
        inputWarnings.forEach(msg => console.log(msg));
      }

      if (parsed.storageRequiredTB !== null) {
        entry.expected.plannedCapacityTB = parsed.storageRequiredTB;
        changesMade = true;
        console.log(`  ✓ Parsed Storage required: ${parsed.storageRequiredTB} TB`);
      } else {
        console.log('  ⚠ Could not parse "Storage required" from pasted text.');
      }

      if (parsed.workingSpaceTB !== null) {
        entry.expected.veeamWorkingSpaceTB = parsed.workingSpaceTB;
        changesMade = true;
        console.log(`  ✓ Parsed Working space: ${parsed.workingSpaceTB} TB`);
      } else {
        console.log('  ⚠ Could not parse "Working space" from pasted text.');
      }
    }

    // ── Storage required (total) fallback/manual ───────────────────────────
    if (entry.expected.plannedCapacityTB === undefined || entry.expected.plannedCapacityTB === null) {
      const existingTotal = entry.expected.plannedCapacityTB ?? null;
      const totalHint = existingTotal !== null ? ` [current: ${existingTotal} TB]` : '';
      const totalRaw = await ask(iface, `  Storage required (TB) — "Repository" value at top of results${totalHint}: `);
      if (totalRaw.toLowerCase() === 'exit') {
        console.log('  Skipping this scenario.');
        continue;
      }
      const totalVal = parseOptionalFloat(totalRaw);
      if (totalVal !== null) {
        entry.expected.plannedCapacityTB = totalVal;
        changesMade = true;
      }
    }

    if (isSobr) {
      // ── Performance tier ──────────────────────────────────────────────────
      const existingPerf = entry.expected.plannedPerformanceTierTB ?? null;
      const perfHint = existingPerf !== null ? ` [current: ${existingPerf} TB]` : '';
      const perfRaw = await ask(iface, `  Performance Tier (TB) — from tier breakdown (ENTER to skip)${perfHint}: `);
      if (perfRaw.toLowerCase() === 'exit') { console.log('  Skipping this scenario.'); continue; }
      const perfVal = parseOptionalFloat(perfRaw);
      if (perfVal !== null) { entry.expected.plannedPerformanceTierTB = perfVal; changesMade = true; }

      // ── Capacity tier ──────────────────────────────────────────────────────
      const existingCap = entry.expected.plannedCapacityTierTB ?? null;
      const capHint = existingCap !== null ? ` [current: ${existingCap} TB]` : '';
      const capRaw = await ask(iface, `  Capacity Tier (TB)    — from tier breakdown (ENTER to skip)${capHint}: `);
      if (capRaw.toLowerCase() === 'exit') { console.log('  Skipping this scenario.'); continue; }
      const capVal = parseOptionalFloat(capRaw);
      if (capVal !== null) { entry.expected.plannedCapacityTierTB = capVal; changesMade = true; }

      // ── Archive tier ──────────────────────────────────────────────────────
      const existingArch = entry.expected.plannedArchiveTierTB ?? null;
      const archHint = existingArch !== null ? ` [current: ${existingArch} TB]` : '';
      const archRaw = await ask(iface, `  Archive Tier (TB)     — enter 0 if disabled (ENTER to skip)${archHint}: `);
      if (archRaw.toLowerCase() === 'exit') { console.log('  Skipping this scenario.'); continue; }
      const archVal = parseOptionalFloat(archRaw);
      if (archVal !== null) { entry.expected.plannedArchiveTierTB = archVal; changesMade = true; }
    }

    // ── Veeam working space ────────────────────────────────────────────────
    if (entry.expected.veeamWorkingSpaceTB === undefined || entry.expected.veeamWorkingSpaceTB === null) {
      const existingWs = entry.expected.veeamWorkingSpaceTB ?? null;
      const wsHint = existingWs !== null ? ` [current: ${existingWs} TB]` : '';
      const wsRaw = await ask(iface, `  "Working space" (TB)  — bottom of Restore Points Simulation (ENTER to skip)${wsHint}: `);
      if (wsRaw.toLowerCase() === 'exit') { console.log('  Skipping this scenario.'); continue; }
      const wsVal = parseOptionalFloat(wsRaw);
      if (wsVal !== null) { entry.expected.veeamWorkingSpaceTB = wsVal; changesMade = true; }
    }

    // ── Optional note ──────────────────────────────────────────────────────
    const noteRaw = await ask(iface, '  Optional note (e.g. captured 2026-05-02, ENTER to skip): ');
    if (noteRaw && noteRaw.toLowerCase() !== 'exit') {
      entry.notes = noteRaw;
      changesMade = true;
    }

    console.log('  ✓ Values recorded for', scenario.id);
    console.log('');
  }

  iface.close();

  if (changesMade) {
    saveBaseline(baseline);
    console.log('  Saved to docs/veeam-calculator-baseline.json');
    console.log('  Run "npm run compare:veeam" to see how the simulator compares.');
  } else {
    console.log('  No changes made.');
  }

  console.log('');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
