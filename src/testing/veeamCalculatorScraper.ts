import { chromium } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

interface CalcScenario {
  id: string;
  config: {
    repositoryType: string;
    sourceDataTB: number;
    dailyChangeRatePct: number;
    annualGrowthRatePct?: number;
    retention: number;
    gfsPolicy?: { weekly?: number; monthly?: number; yearly?: number };
    offloadAfterDays?: number;
    archiveAfterDays?: number;
    hasArchiveTier?: boolean;
    copyEnabled?: boolean;
    moveEnabled?: boolean;
  };
}

interface BaselineExpected {
  plannedCapacityTB?: number;
  plannedPerformanceTierTB?: number;
  plannedCapacityTierTB?: number;
  plannedArchiveTierTB?: number;
  fileTypeFullTB?: number;
  fileTypeIncrementalTB?: number;
  fileTypeSyntheticFullTB?: number;
}

interface BaselineEntry {
  id: string;
  notes: string;
  expected: BaselineExpected;
}

interface BaselineFile {
  defaults: {
    startDate: string;
    forecastYears: number;
    workingSpacePct: number;
    veeamWorkingSpacePct: number;
    tolerancePct: number;
  };
  scenarios: BaselineEntry[];
}

interface TestScenarioFile {
  scenarios: CalcScenario[];
}

interface LifecycleScenarioFile {
  scenarios: CalcScenario[];
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

async function scrapeCalculator(scenario: CalcScenario): Promise<Partial<BaselineExpected> | null> {
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.createContext({
      // Use a viewport that matches typical calculator layout
      viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();

    console.log(`\n  Navigating to Veeam Calculator for scenario: ${scenario.id}`);
    await page.goto('https://calculator.veeam.com', { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for calculator to be interactive
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Fill in inputs - look for common calculator field patterns
    console.log('  Filling input fields...');

    // Repository Type selector
    const repoTypeSelector = 'select[name*="repo"], select[name*="type"], [data-testid*="repo"], [data-testid*="type"]';
    const repoTypeOptions = await page.locator(repoTypeSelector).first().isVisible().catch(() => false);
    if (repoTypeOptions) {
      await page.selectOption(repoTypeSelector, scenario.config.repositoryType);
    }

    // Source Data TB
    const sourceInputSelectors = [
      'input[name*="source"], input[name*="data"], input[placeholder*="Source"], input[placeholder*="TB"]',
      '[data-testid*="source"] input',
      'input[aria-label*="Source"]',
    ];
    
    for (const selector of sourceInputSelectors) {
      try {
        const elem = page.locator(selector).first();
        if (await elem.isVisible()) {
          await elem.clear();
          await elem.fill(scenario.config.sourceDataTB.toString());
          console.log(`  ✓ Set Source Data: ${scenario.config.sourceDataTB} TB`);
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    // Daily Change Rate %
    const changeRateSelectors = [
      'input[name*="change"], input[placeholder*="Change"], input[placeholder*="%"]',
      '[data-testid*="change"] input',
      'input[aria-label*="Change"]',
    ];
    
    for (const selector of changeRateSelectors) {
      try {
        const elem = page.locator(selector).first();
        if (await elem.isVisible()) {
          await elem.clear();
          await elem.fill(scenario.config.dailyChangeRatePct.toString());
          console.log(`  ✓ Set Daily Change Rate: ${scenario.config.dailyChangeRatePct}%`);
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    // Retention (days)
    const retentionSelectors = [
      'input[name*="retention"], input[placeholder*="Retention"], input[placeholder*="days"]',
      '[data-testid*="retention"] input',
      'input[aria-label*="Retention"]',
    ];
    
    for (const selector of retentionSelectors) {
      try {
        const elem = page.locator(selector).first();
        if (await elem.isVisible()) {
          await elem.clear();
          await elem.fill(scenario.config.retention.toString());
          console.log(`  ✓ Set Retention: ${scenario.config.retention} days`);
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    // GFS settings (if present)
    if (scenario.config.gfsPolicy) {
      const { weekly = 0, monthly = 0, yearly = 0 } = scenario.config.gfsPolicy;

      if (weekly > 0) {
        const weeklySelectors = ['input[name*="gfs-weekly"], input[placeholder*="Weekly"]', '[data-testid*="gfs-weekly"] input'];
        for (const selector of weeklySelectors) {
          try {
            const elem = page.locator(selector).first();
            if (await elem.isVisible()) {
              await elem.clear();
              await elem.fill(weekly.toString());
              console.log(`  ✓ Set GFS Weekly: ${weekly}`);
              break;
            }
          } catch (e) {
            // Continue
          }
        }
      }

      if (monthly > 0) {
        const monthlySelectors = ['input[name*="gfs-monthly"], input[placeholder*="Monthly"]', '[data-testid*="gfs-monthly"] input'];
        for (const selector of monthlySelectors) {
          try {
            const elem = page.locator(selector).first();
            if (await elem.isVisible()) {
              await elem.clear();
              await elem.fill(monthly.toString());
              console.log(`  ✓ Set GFS Monthly: ${monthly}`);
              break;
            }
          } catch (e) {
            // Continue
          }
        }
      }

      if (yearly > 0) {
        const yearlySelectors = ['input[name*="gfs-yearly"], input[placeholder*="Yearly"]', '[data-testid*="gfs-yearly"] input'];
        for (const selector of yearlySelectors) {
          try {
            const elem = page.locator(selector).first();
            if (await elem.isVisible()) {
              await elem.clear();
              await elem.fill(yearly.toString());
              console.log(`  ✓ Set GFS Yearly: ${yearly}`);
              break;
            }
          } catch (e) {
            // Continue
          }
        }
      }
    }

    // Wait for calculation/results to appear
    console.log('  Waiting for results to calculate...');
    await page.waitForTimeout(2000);

    // Try to find and extract results from the DOM
    // Look for common result panel patterns
    const resultSelectors = [
      'text=/Storage required|Planned capacity|Total capacity/',
      '[data-testid*="result"]',
      '.result',
      '.summary',
      '[class*="result"]',
    ];

    let results: Partial<BaselineExpected> = {};
    let resultFound = false;

    for (const selector of resultSelectors) {
      try {
        const elem = page.locator(selector).first();
        if (await elem.isVisible()) {
          const text = await elem.innerText();
          console.log(`  Found results: ${text.substring(0, 100)}...`);

          // Parse common patterns from result text
          // Look for patterns like "1.234 TB", "2,345 TB", etc.
          const tbMatches = text.match(/[\d,.]+ TB/g);
          if (tbMatches && tbMatches.length > 0) {
            const plannedCapacity = parseFloat(tbMatches[0].replace(/,/g, ''));
            results.plannedCapacityTB = plannedCapacity;
            resultFound = true;
            console.log(`  ✓ Extracted Planned Capacity: ${plannedCapacity} TB`);

            // Try to extract tier values if SOBR
            if (scenario.config.repositoryType === 'SOBR' && tbMatches.length > 1) {
              const perfTier = parseFloat(tbMatches[1].replace(/,/g, ''));
              results.plannedPerformanceTierTB = perfTier;
              console.log(`  ✓ Extracted Performance Tier: ${perfTier} TB`);

              if (tbMatches.length > 2) {
                const capTier = parseFloat(tbMatches[2].replace(/,/g, ''));
                results.plannedCapacityTierTB = capTier;
                console.log(`  ✓ Extracted Capacity Tier: ${capTier} TB`);
              }

              if (tbMatches.length > 3) {
                const archiveTier = parseFloat(tbMatches[3].replace(/,/g, ''));
                results.plannedArchiveTierTB = archiveTier;
                console.log(`  ✓ Extracted Archive Tier: ${archiveTier} TB`);
              }
            }
            break;
          }
        }
      } catch (e) {
        // Continue
      }
    }

    if (!resultFound) {
      console.warn(`  ⚠ Could not automatically extract results for ${scenario.id}`);
      console.log('  Manual capture may be needed. Falling back to interactive mode.');
      return null;
    }

    await context.close();
    await browser.close();
    return results;
  } catch (err) {
    console.error(`  ✗ Error scraping calculator: ${err}`);
    if (browser) {
      await browser.close();
    }
    return null;
  }
}

async function interactiveCapture(scenario: CalcScenario): Promise<Partial<BaselineExpected>> {
  console.log('\n┌─ Interactive Capture ─────────────────────────────────────┐');
  console.log(`│ Scenario: ${scenario.id}`);
  console.log('│');
  console.log(`│ Repository Type: ${scenario.config.repositoryType}`);
  console.log(`│ Source Data: ${scenario.config.sourceDataTB} TB`);
  console.log(`│ Daily Change Rate: ${scenario.config.dailyChangeRatePct}%`);
  console.log(`│ Retention: ${scenario.config.retention} days`);

  if (scenario.config.gfsPolicy && (scenario.config.gfsPolicy.weekly || scenario.config.gfsPolicy.monthly || scenario.config.gfsPolicy.yearly)) {
    console.log(`│ GFS: Weekly=${scenario.config.gfsPolicy.weekly || 0}, Monthly=${scenario.config.gfsPolicy.monthly || 0}, Yearly=${scenario.config.gfsPolicy.yearly || 0}`);
  }

  console.log('│');
  console.log('│ Visit: https://calculator.veeam.com');
  console.log('│ Set the above values, then paste results below.');
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  const plannedCapacityStr = await prompt('  Planned Capacity (TB) [or press ENTER to skip]: ');
  if (!plannedCapacityStr.trim()) {
    return {};
  }

  const results: Partial<BaselineExpected> = {
    plannedCapacityTB: parseFloat(plannedCapacityStr),
  };

  if (scenario.config.repositoryType === 'SOBR') {
    const perfTierStr = await prompt('  Performance Tier (TB) [or press ENTER to skip]: ');
    if (perfTierStr.trim()) {
      results.plannedPerformanceTierTB = parseFloat(perfTierStr);
    }

    const capTierStr = await prompt('  Capacity Tier (TB) [or press ENTER to skip]: ');
    if (capTierStr.trim()) {
      results.plannedCapacityTierTB = parseFloat(capTierStr);
    }

    const archiveTierStr = await prompt('  Archive Tier (TB) [or press ENTER to skip]: ');
    if (archiveTierStr.trim()) {
      results.plannedArchiveTierTB = parseFloat(archiveTierStr);
    }
  }

  return results;
}

async function loadBaselineScenarios(): Promise<CalcScenario[]> {
  const testScenariosPath = path.join(process.cwd(), 'docs', 'test-scenarios.json');
  const lifecycleScenariosPath = path.join(process.cwd(), 'docs', 'lifecycle-test-scenarios.json');

  const scenarios: CalcScenario[] = [];

  if (fs.existsSync(testScenariosPath)) {
    try {
      const content = fs.readFileSync(testScenariosPath, 'utf-8');
      const data = JSON.parse(content) as TestScenarioFile;
      scenarios.push(...data.scenarios);
    } catch (err) {
      console.error(`Error loading test scenarios: ${err}`);
    }
  }

  if (fs.existsSync(lifecycleScenariosPath)) {
    try {
      const content = fs.readFileSync(lifecycleScenariosPath, 'utf-8');
      const data = JSON.parse(content) as LifecycleScenarioFile;
      scenarios.push(...(data.scenarios || []));
    } catch (err) {
      console.error(`Error loading lifecycle scenarios: ${err}`);
    }
  }

  // Remove duplicates by id
  const seen = new Set<string>();
  return scenarios.filter((s) => {
    if (seen.has(s.id)) {
      return false;
    }
    seen.add(s.id);
    return true;
  });
}

async function main() {
  const baselinePath = path.join(process.cwd(), 'docs', 'veeam-calculator-baseline.json');
  
  // Load existing baseline
  let baseline: BaselineFile;
  if (fs.existsSync(baselinePath)) {
    try {
      const content = fs.readFileSync(baselinePath, 'utf-8');
      baseline = JSON.parse(content);
    } catch (err) {
      console.error(`Error loading baseline: ${err}`);
      process.exit(1);
    }
  } else {
    baseline = {
      defaults: {
        startDate: '2026-05-02',
        forecastYears: 3,
        workingSpacePct: 20,
        veeamWorkingSpacePct: 80,
        tolerancePct: 5,
      },
      scenarios: [],
    };
  }

  // Load scenarios
  const scenarios = await loadBaselineScenarios();
  console.log(`\n📊 Veeam Calculator Scraper`);
  console.log(`Loaded ${scenarios.length} scenarios for capture.\n`);

  let capturedCount = 0;
  let skippedCount = 0;

  for (const scenario of scenarios) {
    // Find or create baseline entry
    let entry = baseline.scenarios.find((s) => s.id === scenario.id);
    if (!entry) {
      entry = {
        id: scenario.id,
        notes: `captured-from-playwright-scraper-${new Date().toISOString().split('T')[0]}`,
        expected: {},
      };
      baseline.scenarios.push(entry);
    }

    console.log(`\n▶ Processing: ${scenario.id}`);

    // Try automatic scraping first
    let results = await scrapeCalculator(scenario);

    // If scraping failed or returned null, fall back to interactive capture
    if (!results) {
      console.log('  Falling back to interactive capture...');
      results = await interactiveCapture(scenario);
    }

    if (Object.keys(results).length > 0) {
      // Merge results into baseline entry
      entry.expected = { ...entry.expected, ...results };
      entry.notes = `captured-from-playwright-${new Date().toISOString().split('T')[0]}`;
      capturedCount++;
      console.log(`  ✓ Saved to baseline`);
    } else {
      skippedCount++;
      console.log(`  ⊘ Skipped`);
    }

    // Write baseline after each scenario to avoid data loss
    fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
  }

  rl.close();
  console.log(`\n\n📈 Summary`);
  console.log(`Captured: ${capturedCount}`);
  console.log(`Skipped: ${skippedCount}`);
  console.log(`Total: ${scenarios.length}`);
  console.log(`\nBaseline saved to: ${baselinePath}\n`);
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
