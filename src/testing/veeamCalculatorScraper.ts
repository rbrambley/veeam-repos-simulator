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
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      // Use a viewport that matches typical calculator layout
      viewport: { width: 1920, height: 1080 },
    });

    console.log(`\n  Navigating to Veeam Calculator for scenario: ${scenario.id}`);
    await page.goto('https://www.veeam.com/calculators/simple/vbr/machines', { 
      waitUntil: 'domcontentloaded', 
      timeout: 60000 
    });

    // Wait for calculator to fully load and become interactive
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {
      // Timeout is ok, page might still be usable
    });
    await page.waitForTimeout(3000);

    // Fill in inputs - use flexible selector strategies
    console.log('  Filling input fields...');

      // Clear/reset the form before entering new inputs
      console.log('  Clearing previous inputs...');
    
      // Try to find and click a Reset/Clear button
      const resetButtonSelectors = [
        'button:has-text("Reset")',
        'button:has-text("Clear")',
        'button[type="reset"]',
        'button[name*="reset"], button[name*="clear"]',
        '[data-testid*="reset"] button, [data-testid*="clear"] button',
      ];

      let resetClicked = false;
      for (const selector of resetButtonSelectors) {
        try {
          const elem = page.locator(selector).first();
          if (await elem.isVisible().catch(() => false)) {
            await elem.click();
            console.log('  ✓ Reset button clicked');
            resetClicked = true;
            await page.waitForTimeout(1000);
            break;
          }
        } catch (e) {
          // Continue to next selector
        }
      }

      // If no reset button found, manually clear all input fields
      if (!resetClicked) {
        const inputSelectors = [
          'input[type="text"]',
          'input[type="number"]',
          'input:not([type="hidden"])',
          'select',
        ];

        for (const selector of inputSelectors) {
          try {
            const elements = await page.locator(selector).all();
            for (const elem of elements) {
              const isVisible = await elem.isVisible().catch(() => false);
              if (isVisible) {
                const tagName = await elem.evaluate((el: any) => el.tagName);
                if (tagName === 'SELECT') {
                  await elem.selectOption('').catch(() => {}); // Clear select
                } else {
                  await elem.clear({ force: true }).catch(() => {});
                  await elem.fill('');
                }
              }
            }
          } catch (e) {
            // Continue
          }
        }
        console.log('  ✓ All input fields cleared');
      }

      await page.waitForTimeout(1000);

    // Repository Type selector - try multiple strategies
    const repoTypeSelectors = [
      'select[name*="repo"], select[name*="type"]',
      '[data-testid*="repo"] select, [data-testid*="type"] select',
      'select#repositoryType, select.repository-type',
      'input[name*="repo"], input[name*="type"]',
    ];
    
    for (const selector of repoTypeSelectors) {
      try {
        const elem = page.locator(selector).first();
        if (await elem.isVisible().catch(() => false)) {
          const tagName = await elem.evaluate((el: any) => el.tagName);
          if (tagName === 'SELECT') {
            await page.selectOption(selector, scenario.config.repositoryType);
            console.log(`  ✓ Set Repository Type: ${scenario.config.repositoryType}`);
          } else {
            await elem.clear();
            await elem.fill(scenario.config.repositoryType);
            console.log(`  ✓ Set Repository Type: ${scenario.config.repositoryType}`);
          }
          await page.waitForTimeout(500);
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    // Source Data TB - try multiple strategies
    const sourceSelectors = [
      'input[name*="source"], input[name*="data"]',
      'input[placeholder*="Source"], input[placeholder*="Machines"]',
      '[data-testid*="source"] input, [data-testid*="machines"] input',
      'input#sourceData, input.source-data',
    ];
    
    for (const selector of sourceSelectors) {
      try {
        const elem = page.locator(selector).first();
        if (await elem.isVisible().catch(() => false)) {
          await elem.clear({ force: true });
          await elem.fill(scenario.config.sourceDataTB.toString());
          await page.keyboard.press('Tab'); // Trigger change event
          console.log(`  ✓ Set Source Data: ${scenario.config.sourceDataTB} TB`);
          await page.waitForTimeout(500);
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    // Daily Change Rate % - try multiple strategies
    const changeRateSelectors = [
      'input[name*="change"], input[name*="rate"]',
      'input[placeholder*="Change"], input[placeholder*="Rate"]',
      '[data-testid*="change"] input, [data-testid*="rate"] input',
      'input#changeRate, input.change-rate',
    ];
    
    for (const selector of changeRateSelectors) {
      try {
        const elem = page.locator(selector).first();
        if (await elem.isVisible().catch(() => false)) {
          await elem.clear({ force: true });
          await elem.fill(scenario.config.dailyChangeRatePct.toString());
          await page.keyboard.press('Tab');
          console.log(`  ✓ Set Daily Change Rate: ${scenario.config.dailyChangeRatePct}%`);
          await page.waitForTimeout(500);
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    // Retention (days) - try multiple strategies
    const retentionSelectors = [
      'input[name*="retention"]',
      'input[placeholder*="Retention"], input[placeholder*="days"]',
      '[data-testid*="retention"] input',
      'input#retention, input.retention',
    ];
    
    for (const selector of retentionSelectors) {
      try {
        const elem = page.locator(selector).first();
        if (await elem.isVisible().catch(() => false)) {
          await elem.clear({ force: true });
          await elem.fill(scenario.config.retention.toString());
          await page.keyboard.press('Tab');
          console.log(`  ✓ Set Retention: ${scenario.config.retention} days`);
          await page.waitForTimeout(500);
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

    // Click the Estimate button to trigger calculation
    console.log('  Clicking Estimate button...');
    const estimateButtonSelectors = [
      'button:has-text("Estimate")',
      'button:has-text("Calculate")',
      'button[type="submit"]',
      'button[name*="estimate"], button[name*="calculate"]',
      '[data-testid*="estimate"] button, [data-testid*="calculate"] button',
      'button#estimate, button.estimate, button.btn-estimate',
    ];

    let estimateClicked = false;
    for (const selector of estimateButtonSelectors) {
      try {
        const elem = page.locator(selector).first();
        if (await elem.isVisible().catch(() => false)) {
          await elem.click();
          console.log('  ✓ Estimate button clicked');
          estimateClicked = true;
          await page.waitForTimeout(2000); // Wait for calculation to start
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    if (!estimateClicked) {
      console.warn('  ⚠ Could not find Estimate button');
    }

    // Wait for results and then click Details link to view detailed breakdown
    console.log('  Waiting for results panel...');
    await page.waitForTimeout(2000);

    // Look for Details link in the right sidebar
    console.log('  Clicking Details link...');
    const detailsLinkSelectors = [
      'a:has-text("Details")',
      'a:has-text("View Details")',
      'a[href*="details"]',
      'button:has-text("Details")',
      '[data-testid*="details"] a, [data-testid*="details"] button',
      'a#details, a.details, a.btn-details',
    ];

    let detailsClicked = false;
    for (const selector of detailsLinkSelectors) {
      try {
        const elem = page.locator(selector).first();
        if (await elem.isVisible().catch(() => false)) {
          await elem.click();
          console.log('  ✓ Details link clicked');
          detailsClicked = true;
          await page.waitForTimeout(2000); // Wait for details panel to load
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    if (!detailsClicked) {
      console.warn('  ⚠ Could not find Details link, will extract from current view');
    }

    // Wait for calculation/results to appear
    console.log('  Extracting calculation results...');
    await page.waitForTimeout(2000);

    // Try multiple times to extract results (calculator may take time to compute)
    let results: Partial<BaselineExpected> = {};
    let resultFound = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (resultFound) break;
      
      console.log(`  Extraction attempt ${attempt}/3...`);

      // Get all text content from the page
      const pageText = await page.evaluate(() => document.body.innerText);
      
      // Look for result patterns in Details tab format
      // Common patterns in Veeam calculator Details:
      // "Storage required: 1.23 TB", "Total: 1.23 TB", "Backup Storage: 1.23 TB"
      // "Performance: 2.5 TB", "Capacity: 1.5 TB", "Archive: 0.5 TB"
      const mainCapacityPatterns = [
        /Storage required[:\s]+([0-9.,]+)\s*TB/gi,
        /Total capacity[:\s]+([0-9.,]+)\s*TB/gi,
        /Backup Storage[:\s]+([0-9.,]+)\s*TB/gi,
        /Total[:\s]+([0-9.,]+)\s*TB/gi,
      ];

      for (const pattern of mainCapacityPatterns) {
        const match = pattern.exec(pageText);
        if (match) {
          const value = parseFloat(match[1].replace(/,/g, ''));
          if (value > 0) {
            results.plannedCapacityTB = value;
            resultFound = true;
            console.log(`  ✓ Extracted Planned Capacity: ${value} TB`);
            break;
          }
        }
      }

      // For SOBR, look for tier breakdown in Details panel
      if (scenario.config.repositoryType === 'SOBR' && resultFound) {
        const tierPatterns = [
          { regex: /Performance[:\s]+([0-9.,]+)\s*TB/gi, field: 'plannedPerformanceTierTB', label: 'Performance Tier' },
          { regex: /Capacity Tier[:\s]+([0-9.,]+)\s*TB/gi, field: 'plannedCapacityTierTB', label: 'Capacity Tier' },
          { regex: /Archive[:\s]+([0-9.,]+)\s*TB/gi, field: 'plannedArchiveTierTB', label: 'Archive Tier' },
        ];

        for (const { regex, field, label } of tierPatterns) {
          const match = regex.exec(pageText);
          if (match) {
            const value = parseFloat(match[1].replace(/,/g, ''));
            (results as any)[field] = value;
            console.log(`  ✓ Extracted ${label}: ${value} TB`);
          }
        }
      }

      // Also try to extract file-type sizes if visible in Details
      const fileTypePatterns = [
        { regex: /Full backup[:\s]+([0-9.,]+)\s*TB/gi, field: 'fileTypeFullTB', label: 'Full Backup Size' },
        { regex: /Incremental backup[:\s]+([0-9.,]+)\s*TB/gi, field: 'fileTypeIncrementalTB', label: 'Incremental Size' },
        { regex: /Synthetic full[:\s]+([0-9.,]+)\s*TB/gi, field: 'fileTypeSyntheticFullTB', label: 'Synthetic Full Size' },
      ];

      for (const { regex, field, label } of fileTypePatterns) {
        const match = regex.exec(pageText);
        if (match) {
          const value = parseFloat(match[1].replace(/,/g, ''));
          (results as any)[field] = value;
          console.log(`  ✓ Extracted ${label}: ${value} TB`);
        }
      }

      if (!resultFound && attempt < 3) {
        console.log('  Results not found yet, waiting...');
        await page.waitForTimeout(2000);
      }
    }

    if (!resultFound) {
      console.warn(`  ⚠ Could not automatically extract results for ${scenario.id}`);
      console.log('  Manual capture may be needed. Falling back to interactive mode.');
      return null;
    }

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
      let content = fs.readFileSync(lifecycleScenariosPath, 'utf-8');
      // Strip JSON comments (// and /* */ style)
      content = content.replace(/\/\*[\s\S]*?\*\//g, ''); // Remove /* */ comments
      content = content.replace(/\/\/.*$/gm, ''); // Remove // comments
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
