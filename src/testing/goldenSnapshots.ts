import { existsSync, readFileSync, writeFileSync } from 'fs';

export const GOLDEN_SNAPSHOT_DAYS = [365, 730] as const;
const STORAGE_TOLERANCE_TB = 0.001;

export interface GoldenSnapshotPoint {
  date: string;
  chainCount: number;
  rpCount: number;
  gfsWeeklyCount: number;
  gfsMonthlyCount: number;
  gfsYearlyCount: number;
  storageTB: number;
}

export interface GoldenSnapshotCheck {
  day: number;
  date: string;
  status: 'match' | 'mismatch' | 'seeded';
  expected?: GoldenSnapshotPoint;
  actual: GoldenSnapshotPoint;
  differences: string[];
}

export interface GoldenSnapshotViolation {
  day: number;
  date: string;
  expected: string;
  actual: string;
}

interface GoldenSnapshotDoc {
  schemaVersion: number;
  generatedAt: string;
  snapshotDays: number[];
  scenarios: Record<string, Record<string, GoldenSnapshotPoint>>;
}

interface RunnerSnapshot {
  day: number;
  date: string;
  activeChains: number;
  inactiveChains: number;
  totalRestorePoints: number;
  weeklyGfsPoints: number;
  monthlyGfsPoints: number;
  yearlyGfsPoints: number;
  totalStorageTB: number;
}

interface EvaluateResult {
  checks: GoldenSnapshotCheck[];
  violations: GoldenSnapshotViolation[];
}

function toPoint(s: RunnerSnapshot): GoldenSnapshotPoint {
  return {
    date: s.date,
    chainCount: s.activeChains + s.inactiveChains,
    rpCount: s.totalRestorePoints,
    gfsWeeklyCount: s.weeklyGfsPoints,
    gfsMonthlyCount: s.monthlyGfsPoints,
    gfsYearlyCount: s.yearlyGfsPoints,
    storageTB: Number(s.totalStorageTB.toFixed(3)),
  };
}

export class GoldenSnapshotManager {
  private readonly updateMode: boolean;
  private readonly path: string;
  private readonly doc: GoldenSnapshotDoc;
  private dirty = false;

  constructor(path: string, updateMode: boolean) {
    this.path = path;
    this.updateMode = updateMode;

    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as GoldenSnapshotDoc;
        this.doc = {
          schemaVersion: 1,
          generatedAt: parsed.generatedAt ?? new Date().toISOString(),
          snapshotDays: parsed.snapshotDays ?? [...GOLDEN_SNAPSHOT_DAYS],
          scenarios: parsed.scenarios ?? {},
        };
        return;
      } catch {
        // fall through to new doc
      }
    }

    this.doc = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      snapshotDays: [...GOLDEN_SNAPSHOT_DAYS],
      scenarios: {},
    };
  }

  evaluateScenario(scenarioId: string, totalDays: number, snapshots: RunnerSnapshot[]): EvaluateResult {
    const checks: GoldenSnapshotCheck[] = [];
    const violations: GoldenSnapshotViolation[] = [];

    // Long-run scenarios only (phase 2 scope)
    if (totalDays < 730) {
      return { checks, violations };
    }

    const scenarioBaseline = this.doc.scenarios[scenarioId] ?? {};
    const targetDays = GOLDEN_SNAPSHOT_DAYS.filter((d) => d <= totalDays);

    for (const day of targetDays) {
      const snapshot = snapshots.find((s) => s.day === day);
      if (!snapshot) continue;
      const actual = toPoint(snapshot);
      const expected = scenarioBaseline[String(day)];

      if (this.updateMode || !expected) {
        scenarioBaseline[String(day)] = actual;
        this.doc.scenarios[scenarioId] = scenarioBaseline;
        this.dirty = true;
        checks.push({
          day,
          date: actual.date,
          status: 'seeded',
          actual,
          differences: [],
        });
        continue;
      }

      const diffs: string[] = [];
      if (expected.date !== actual.date) {
        diffs.push(`date expected ${expected.date}, got ${actual.date}`);
      }
      if (expected.chainCount !== actual.chainCount) {
        diffs.push(`chainCount expected ${expected.chainCount}, got ${actual.chainCount}`);
      }
      if (expected.rpCount !== actual.rpCount) {
        diffs.push(`rpCount expected ${expected.rpCount}, got ${actual.rpCount}`);
      }
      if (expected.gfsWeeklyCount !== actual.gfsWeeklyCount) {
        diffs.push(`weeklyGFS expected ${expected.gfsWeeklyCount}, got ${actual.gfsWeeklyCount}`);
      }
      if (expected.gfsMonthlyCount !== actual.gfsMonthlyCount) {
        diffs.push(`monthlyGFS expected ${expected.gfsMonthlyCount}, got ${actual.gfsMonthlyCount}`);
      }
      if (expected.gfsYearlyCount !== actual.gfsYearlyCount) {
        diffs.push(`yearlyGFS expected ${expected.gfsYearlyCount}, got ${actual.gfsYearlyCount}`);
      }
      if (Math.abs(expected.storageTB - actual.storageTB) > STORAGE_TOLERANCE_TB) {
        diffs.push(`storageTB expected ${expected.storageTB.toFixed(3)}, got ${actual.storageTB.toFixed(3)}`);
      }

      const status: GoldenSnapshotCheck['status'] = diffs.length === 0 ? 'match' : 'mismatch';
      checks.push({ day, date: actual.date, status, expected, actual, differences: diffs });

      if (status === 'mismatch') {
        violations.push({
          day,
          date: actual.date,
          expected: `golden snapshot match for day ${day}`,
          actual: diffs.join('; '),
        });
      }
    }

    return { checks, violations };
  }

  saveIfDirty() {
    if (!this.dirty) return;
    this.doc.generatedAt = new Date().toISOString();
    writeFileSync(this.path, JSON.stringify(this.doc, null, 2), 'utf8');
  }

  getPath(): string {
    return this.path;
  }

  isUpdateMode(): boolean {
    return this.updateMode;
  }
}
