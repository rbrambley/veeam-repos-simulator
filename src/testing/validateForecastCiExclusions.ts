import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ForecastCiExclusionEntry {
  id: string;
  reason: string;
  owner: string;
  reviewBy: string;
}

interface ForecastCiExclusionFile {
  exclusions?: ForecastCiExclusionEntry[];
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime());
}

function main() {
  const configPath = path.join(__dirname, '../../docs/forecast-ci-exclusions.json');
  if (!fs.existsSync(configPath)) {
    console.error('Missing docs/forecast-ci-exclusions.json');
    process.exit(1);
  }

  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ForecastCiExclusionFile;
  const exclusions = parsed.exclusions ?? [];
  const seen = new Set<string>();

  for (const entry of exclusions) {
    const id = (entry.id || '').trim();
    const reason = (entry.reason || '').trim();
    const owner = (entry.owner || '').trim();
    const reviewBy = (entry.reviewBy || '').trim();

    if (!id || !reason || !owner || !reviewBy) {
      console.error(`Invalid exclusion entry (missing required field): ${JSON.stringify(entry)}`);
      process.exit(1);
    }
    if (!isIsoDate(reviewBy)) {
      console.error(`Invalid reviewBy date for ${id}: ${reviewBy}. Expected YYYY-MM-DD.`);
      process.exit(1);
    }
    if (seen.has(id)) {
      console.error(`Duplicate exclusion id found: ${id}`);
      process.exit(1);
    }
    seen.add(id);
  }

  console.log(`Forecast CI exclusions validated: ${exclusions.length} entries`);
}

main();
