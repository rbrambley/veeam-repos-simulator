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
  calculatorSummaryRestorePointCount?: number;
  parsedRestorePointCount?: number;
  workingSpaceTB?: number;
  restorePointsTotalTB?: number; // Sum of all restore point sizes (raw, no block cloning)
  varianceTB?: number; // plannedCapacityTB - restorePointsTotalTB
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

async function scrapeCalculator(scenario: CalcScenario, forecastYears: number): Promise<Partial<BaselineExpected> | null> {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

    console.log(`\n  Navigating to Veeam Calculator for scenario: ${scenario.id}`);
    await page.goto('https://www.veeam.com/calculators/simple/vbr/machines', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);

    // Label-based input filler (TreeWalker: immune to DOM reordering from SOBR toggle expansions)
    const fillInputByLabel = async (labelText: string, value: number, nth = 1): Promise<boolean> =>
      page.evaluate(({ text, val, occNth }: { text: string; val: number; occNth: number }) => {
        let found = 0;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if ((node.textContent || '').trim() === text) {
            found++;
            if (found === occNth) {
              let el: HTMLElement | null = (node as Text).parentElement;
              for (let i = 0; i < 8 && el; i++) {
                const input = el.querySelector('input') as HTMLInputElement | null;
                if (input && input.type !== 'checkbox') {
                  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                  if (setter) {
                    setter.call(input, String(val));
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                  }
                  return true;
                }
                el = el.parentElement;
              }
            }
          }
        }
        return false;
      }, { text: labelText, val: value, occNth: nth });

    // Toggle expansion via evaluate (checkboxes are tabindex=-1, not directly clickable)
    const expandToggle = async (labelContainsText: string, enable: boolean): Promise<boolean> => {
      return page.evaluate(({ text, shouldEnable }: { text: string; shouldEnable: boolean }) => {
        const allLabels = Array.from(document.querySelectorAll('label'));
        for (const label of allLabels) {
          if ((label.textContent || '').trim().includes(text)) {
            const cb = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
            if (cb) {
              if (cb.checked !== shouldEnable) {
                cb.click();
              }
              return true;
            }
          }
        }
        // Fallback: look for toggle near span/div text node
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node: Text | null;
        while ((node = walker.nextNode() as Text | null)) {
          if ((node.textContent || '').trim() === text) {
            const parent = node.parentElement;
            if (!parent) continue;
            let el: HTMLElement | null = parent;
            for (let i = 0; i < 4 && el; i++) {
              const cb = el.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
              if (cb) {
                if (cb.checked !== shouldEnable) cb.click();
                return true;
              }
              el = el.parentElement;
            }
          }
        }
        return false;
      }, { text: labelContainsText, shouldEnable: enable });
    };

    console.log('  Expanding required input sections...');
    // Expand Advanced first so Growth rate + Forecast period inputs appear
    const advExpanded = await expandToggle('Advanced', true);
    if (advExpanded) {
      await page.waitForTimeout(400);
    }

    // Expand SOBR policy sections. Always expand Move policy? if copy or move is enabled
    // because the Capacity Tier "Move period" field is shared by both policies.
    if (scenario.config.repositoryType === 'SOBR') {
      await expandToggle('Capacity Tier?', true);
      await page.waitForTimeout(250);
      if (scenario.config.copyEnabled) await expandToggle('Copy policy?', true);
      if (scenario.config.copyEnabled || scenario.config.moveEnabled) await expandToggle('Move policy?', true);
      if (scenario.config.hasArchiveTier) await expandToggle('Archive tier?', true);
      await page.waitForTimeout(250);
    }

    const weekly = scenario.config.gfsPolicy?.weekly ?? 0;
    const monthly = scenario.config.gfsPolicy?.monthly ?? 0;
    const yearly = scenario.config.gfsPolicy?.yearly ?? 0;

    const totalInputs = await page.locator('input.rz-numeric-input').count();
    console.log(`  Total visible numeric inputs after expansion: ${totalInputs}`);

    console.log('  Filling input fields by label...');
    await fillInputByLabel('Source data', scenario.config.sourceDataTB);
    await fillInputByLabel('Daily change rate', scenario.config.dailyChangeRatePct);
    // Backup window – leave at default 8 hours
    await fillInputByLabel('Days', scenario.config.retention);
    await fillInputByLabel('Weeks', weekly);
    await fillInputByLabel('Months', monthly);
    await fillInputByLabel('Years', yearly);
    await fillInputByLabel('Growth rate', scenario.config.annualGrowthRatePct ?? 0);

    // Forecast period uses a non-rz-numeric-input – set via proximity evaluate
    const forecastSet = await page.evaluate((years: number) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if ((node.textContent || '').trim() === 'Forecast period') {
          let el: HTMLElement | null = (node as Text).parentElement;
          for (let i = 0; i < 8 && el; i++) {
            const input = el.querySelector('input') as HTMLInputElement | null;
            if (input && input.type !== 'checkbox') {
              const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
              if (nativeSetter) {
                nativeSetter.call(input, String(years));
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
              }
              return true;
            }
            el = el.parentElement;
          }
        }
      }
      return false;
    }, forecastYears);
    if (!forecastSet) {
      console.warn('  ⚠ Could not set Forecast period via evaluate; using calculator default');
    }

    // SOBR period fields: "Move period" appears twice — 1st = Capacity Tier, 2nd = Archive Tier
    if (scenario.config.repositoryType === 'SOBR') {
      if ((scenario.config.copyEnabled || scenario.config.moveEnabled) && typeof scenario.config.offloadAfterDays === 'number') {
        const ok = await fillInputByLabel('Move period', scenario.config.offloadAfterDays, 1);
        if (!ok) console.warn(`  ⚠ Could not set Move period (capacity tier) (${scenario.config.offloadAfterDays})`);
      }
      if (scenario.config.hasArchiveTier && typeof scenario.config.archiveAfterDays === 'number') {
        const ok = await fillInputByLabel('Move period', scenario.config.archiveAfterDays, 2);
        if (!ok) console.warn(`  ⚠ Could not set Move period (archive tier) (${scenario.config.archiveAfterDays})`);
      }
      await page.waitForTimeout(150);
    }

    await page.keyboard.press('Tab').catch(() => {});
    await page.waitForTimeout(300);

    // Read back key values to verify binding succeeded
    const readLabelVal = async (text: string): Promise<string> => {
      return page.evaluate((t: string) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if ((node.textContent || '').trim() === t) {
            let el: HTMLElement | null = (node as Text).parentElement;
            for (let i = 0; i < 8 && el; i++) {
              const input = el.querySelector('input') as HTMLInputElement | null;
              if (input && input.type !== 'checkbox') return input.value;
              el = el.parentElement;
            }
          }
        }
        return '?';
      }, text);
    };
    const applied = {
      source: await readLabelVal('Source data'),
      dailyChange: await readLabelVal('Daily change rate'),
      retention: await readLabelVal('Days'),
      weeks: await readLabelVal('Weeks'),
      months: await readLabelVal('Months'),
      years: await readLabelVal('Years'),
      growth: await readLabelVal('Growth rate'),
    };
    console.log(`  ✓ Inputs applied: source=${applied.source}, change=${applied.dailyChange}, days=${applied.retention}, gfs=${applied.weeks}/${applied.months}/${applied.years}, growth=${applied.growth}, forecastSet=${forecastSet}`);

    // Sequence step 1: click Estimate
    const estimateButton = page.locator('button:has-text("ESTIMATE")').first();
    if (!(await estimateButton.isVisible().catch(() => false))) {
      throw new Error('Estimate button not found');
    }
    console.log('  Clicking Estimate button...');
    await estimateButton.click();
    await page.waitForTimeout(2000);

    // Sequence step 2: click Details in right results sidebar
    const detailsButton = page.locator('button:has-text("[Details]")').first();
    if (!(await detailsButton.isVisible().catch(() => false))) {
      throw new Error('Details button not found after estimate');
    }
    console.log('  Clicking Details link...');
    await detailsButton.click();

    // Sequence step 3: extract from details dialog only
    const detailsDialog = page.locator('div[role="dialog"]').first();
    await detailsDialog.waitFor({ state: 'visible', timeout: 15000 });

    // ── TOP HALF: capture immediately before any scrolling ──────────────────
    const topHalfText = await detailsDialog.innerText();
    console.log('  ── Top-Half Details (raw) ─────────────────────────────');
    console.log(topHalfText.slice(0, 2000)); // Print up to 2000 chars of top-half
    console.log('  ───────────────────────────────────────────────────────');

    // ── BOTTOM HALF: scroll through dialog to expose Restore Points rows ─────
    const capturedChunks = new Set<string>([topHalfText]);
    for (let step = 1; step <= 12; step++) {
      await detailsDialog.evaluate((dialog: Element, s: number) => {
        const nodes = Array.from(dialog.querySelectorAll('*')) as HTMLElement[];
        const scrollables = nodes.filter((n) => n.scrollHeight > n.clientHeight + 8);
        for (const el of scrollables) {
          const target = Math.min(el.scrollHeight, (s / 12) * el.scrollHeight);
          el.scrollTop = target;
        }
      }, step);
      await page.waitForTimeout(120);
      const chunk = await detailsDialog.innerText();
      capturedChunks.add(chunk);
    }
    // Full combined text covers both top and scrolled-in restore point rows
    const detailsText = Array.from(capturedChunks).join('\n');

    const extractNumberFrom = (sourceText: string, pattern: RegExp): number | undefined => {
      const match = sourceText.match(pattern);
      if (!match) {
        return undefined;
      }
      const parsed = parseFloat(match[1].replace(/,/g, ''));
      return Number.isFinite(parsed) ? parsed : undefined;
    };

    const extractTextFrom = (sourceText: string, pattern: RegExp): string | undefined => {
      const match = sourceText.match(pattern);
      return match ? match[1].trim() : undefined;
    };

    const results: Partial<BaselineExpected> = {};
    const storageMatch = topHalfText.match(/Storage required\s*\n\s*([0-9.,]+)\s*TB/i)
      ?? detailsText.match(/Storage required\s*\n\s*([0-9.,]+)\s*TB/i);
    if (!storageMatch) {
      throw new Error('Could not parse Storage required value from Details dialog');
    }
    results.plannedCapacityTB = parseFloat(storageMatch[1].replace(/,/g, ''));
    console.log(`  ✓ Extracted Planned Capacity: ${results.plannedCapacityTB} TB`);

    // Only parse restore points from below the "Restore Points Simulation" header
    // to avoid matching Y1/D14 etc from the top-half tier-summary section.
    const rpSectionIdx = detailsText.search(/Restore Points Simulation/i);
    const rpText = rpSectionIdx >= 0 ? detailsText.slice(rpSectionIdx) : '';

    const rpLines = rpText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const restorePoints: Array<{ tier: string; point: string; sizeTB: number }> = [];
    const tierByHeading: Record<string, string> = {
      'Performance Tier': 'Performance',
      'Capacity Tier': 'Capacity',
      'Archive Tier': 'Archive',
    };

    let currentTier = 'Unknown';
    const pointToken = /^(LATEST|D\d+|W\d+|M\d+|Y\d+)$/i;
    const sizeToken = /^([0-9]+(?:\.[0-9]+)?)\s*TB$/i;

    for (let i = 0; i < rpLines.length; i++) {
      const line = rpLines[i];

      if (line in tierByHeading) {
        currentTier = tierByHeading[line];
        continue;
      }

      if (/^Summary$/i.test(line)) {
        break;
      }

      const pointMatch = line.match(pointToken);
      if (!pointMatch) {
        continue;
      }

      let sizeTB: number | undefined;
      for (let j = i + 1; j < Math.min(i + 5, rpLines.length); j++) {
        const nextLine = rpLines[j];
        if (nextLine in tierByHeading || pointToken.test(nextLine) || /^Summary$/i.test(nextLine)) {
          break;
        }
        const sizeMatch = nextLine.match(sizeToken);
        if (sizeMatch) {
          const parsed = parseFloat(sizeMatch[1]);
          if (Number.isFinite(parsed)) {
            sizeTB = parsed;
          }
          break;
        }
      }

      if (sizeTB !== undefined) {
        restorePoints.push({ tier: currentTier, point: pointMatch[1].toUpperCase(), sizeTB });
      }
    }

    // De-duplicate by tier + point to handle repeated text snapshots from scroll capture.
    const uniquePointMap = new Map<string, { tier: string; point: string; sizeTB: number }>();
    for (const rp of restorePoints) {
      const key = `${rp.tier}:${rp.point}`;
      if (!uniquePointMap.has(key)) {
        uniquePointMap.set(key, rp);
      }
    }
    const uniqueRestorePoints = Array.from(uniquePointMap.values());

    const summaryRestorePointCount = extractNumberFrom(rpText, /Summary\s*\n\s*([0-9.,]+)\s*restore\s*points/i);

    // Sum of all restore point sizes (raw, no block cloning)
    const restorePointsTotalTB = uniqueRestorePoints.reduce((sum, rp) => sum + rp.sizeTB, 0);
    results.calculatorSummaryRestorePointCount = summaryRestorePointCount;
    results.parsedRestorePointCount = uniqueRestorePoints.length;
    results.restorePointsTotalTB = restorePointsTotalTB;
    results.workingSpaceTB = extractNumberFrom(topHalfText, /Working space\s*\n\s*([0-9.,]+)\s*TB/i);
    // Variance: plannedCapacityTB - restorePointsTotalTB
    if (typeof results.plannedCapacityTB === 'number') {
      results.varianceTB = results.plannedCapacityTB - restorePointsTotalTB;
    }

    const restorePointCounts = {
      total: uniqueRestorePoints.length,
      daily: uniqueRestorePoints.filter((x) => x.point.startsWith('D')).length,
      weekly: uniqueRestorePoints.filter((x) => x.point.startsWith('W')).length,
      monthly: uniqueRestorePoints.filter((x) => x.point.startsWith('M')).length,
      yearly: uniqueRestorePoints.filter((x) => x.point.startsWith('Y')).length,
      latest: uniqueRestorePoints.filter((x) => x.point === 'LATEST').length,
    };

    const scrapedPayload: Record<string, string | number | boolean | undefined> = {
      scenarioId: scenario.id,
      repositoryType: scenario.config.repositoryType,
      storageRequiredTB: results.plannedCapacityTB,

      sourceDataTB: extractNumberFrom(topHalfText, /Source data\s*\n\s*([0-9.,]+)\s*TB/i),
      dailyChangeRatePct: extractNumberFrom(topHalfText, /Daily change rate\s*\n\s*([0-9.,]+)\s*%/i),
      backupWindowHours: extractNumberFrom(topHalfText, /Backup window\s*\n\s*([0-9.,]+)\s*hours/i),

      retentionDays: extractTextFrom(topHalfText, /Days\s*\n\s*([^\n]+)/i),
      retentionWeeks: extractTextFrom(topHalfText, /Weeks\s*\n\s*([^\n]+)/i),
      retentionMonths: extractTextFrom(topHalfText, /Months\s*\n\s*([^\n]+)/i),
      retentionYears: extractTextFrom(topHalfText, /Years\s*\n\s*([^\n]+)/i),

      refsXfsEnabled: extractTextFrom(topHalfText, /ReFS\/XFS\?\s*\n\s*([^\n]+)/i),
      perfTierImmutable: extractTextFrom(topHalfText, /Performance tier immutable\?\s*\n\s*([^\n]+)/i),
      compressionPct: extractNumberFrom(topHalfText, /Compress by\s*\n\s*([0-9.,]+)\s*%/i),
      blockGenerationPeriodDays: extractNumberFrom(topHalfText, /Block generation period\s*\n\s*([0-9.,]+)\s*days/i),
      growthRatePct: extractNumberFrom(topHalfText, /Growth rate\s*\n\s*([0-9.,]+)\s*%/i),
      forecastYears: extractNumberFrom(topHalfText, /Forecast period\s*\n\s*([0-9.,]+)\s*years/i),

      proxyCores: extractNumberFrom(topHalfText, /Proxy\s*[\s\S]*?Cores required\s*\n\s*([0-9.,]+)/i),
      proxyRamGB: extractNumberFrom(topHalfText, /Proxy\s*[\s\S]*?RAM required\s*\n\s*([0-9.,]+)\s*GB/i),
      repoGatewayCores: extractNumberFrom(topHalfText, /Repository\/Gateway\s*[\s\S]*?Cores required\s*\n\s*([0-9.,]+)/i),
      repoGatewayRamGB: extractNumberFrom(topHalfText, /Repository\/Gateway\s*[\s\S]*?RAM required\s*\n\s*([0-9.,]+)\s*GB/i),

      // Tier capacities: prefer explicit top-half tier-storage labels.
      // Fallback to Y1 timeline capture only if storage labels are unavailable.
      performanceTierY1TB:
        extractNumberFrom(topHalfText, /Performance tier\s*[\s\S]*?Storage required\s*\n\s*([0-9.,]+)\s*TB/i)
        ?? extractNumberFrom(topHalfText, /Performance Tier[\s\S]*?Y1\s*\n\s*([0-9.,]+)\s*TB/i),
      capacityTierY1TB:
        extractNumberFrom(topHalfText, /Capacity tier\s*[\s\S]*?Capacity tier storage\s*\n\s*([0-9.,]+)\s*TB/i)
        ?? extractNumberFrom(topHalfText, /Capacity Tier[\s\S]*?Y1\s*\n\s*([0-9.,]+)\s*TB/i),
      archiveTierY1TB:
        extractNumberFrom(topHalfText, /Archive tier\s*[\s\S]*?Archive tier storage\s*\n\s*([0-9.,]+)\s*TB/i)
        ?? extractNumberFrom(topHalfText, /Archive Tier[\s\S]*?Y1\s*\n\s*([0-9.,]+)\s*TB/i),
      workingSpaceTB: results.workingSpaceTB,

      fullBackupTB: extractNumberFrom(topHalfText, /Full backup\s*\n\s*([0-9.,]+)\s*TB/i),
      incrementalBackupTB: extractNumberFrom(topHalfText, /Incremental backup\s*\n\s*([0-9.,]+)\s*TB/i),
      syntheticFullBackupTB: extractNumberFrom(topHalfText, /Synthetic full backup\s*\n\s*([0-9.,]+)\s*TB/i),
      restorePointCountTotal: restorePointCounts.total,
      restorePointCountDaily: restorePointCounts.daily,
      restorePointCountWeekly: restorePointCounts.weekly,
      restorePointCountMonthly: restorePointCounts.monthly,
      restorePointCountYearly: restorePointCounts.yearly,
      restorePointCountLatest: restorePointCounts.latest,
      calculatorSummaryRestorePointCount: summaryRestorePointCount,
      parsedRestorePointCount: uniqueRestorePoints.length,
      restorePointsTotalTB,
      varianceTB: results.varianceTB,
    };

    const fullMatch = detailsText.match(/Full backup\s*\n\s*([0-9.,]+)\s*TB/i);
    if (fullMatch) {
      results.fileTypeFullTB = parseFloat(fullMatch[1].replace(/,/g, ''));
    }
    const incMatch = detailsText.match(/Incremental backup\s*\n\s*([0-9.,]+)\s*TB/i);
    if (incMatch) {
      results.fileTypeIncrementalTB = parseFloat(incMatch[1].replace(/,/g, ''));
    }
    const synthMatch = detailsText.match(/Synthetic full backup\s*\n\s*([0-9.,]+)\s*TB/i);
    if (synthMatch) {
      results.fileTypeSyntheticFullTB = parseFloat(synthMatch[1].replace(/,/g, ''));
    }

    if (typeof scrapedPayload.performanceTierY1TB === 'number') {
      results.plannedPerformanceTierTB = scrapedPayload.performanceTierY1TB;
    }
    if (typeof scrapedPayload.capacityTierY1TB === 'number') {
      results.plannedCapacityTierTB = scrapedPayload.capacityTierY1TB;
    }
    if (typeof scrapedPayload.archiveTierY1TB === 'number') {
      results.plannedArchiveTierTB = scrapedPayload.archiveTierY1TB;
    }

    console.log('  Scraped Details Payload:');
    console.log(JSON.stringify(scrapedPayload, null, 2));
    if (uniqueRestorePoints.length > 0) {
      console.log('  Restore Points Snapshot (tier:point:sizeTB):');
      console.log(uniqueRestorePoints.map((x) => `${x.tier}:${x.point}:${x.sizeTB}`).join(', '));
    } else {
      console.log('  Restore Points Snapshot: none parsed from details text');
    }

    // Sequence step 4: close details window
    console.log('  Closing Details window...');
    let closed = false;

    // Primary close path: Escape often dismisses this dialog immediately.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
    closed = !(await detailsDialog.isVisible().catch(() => false));

    if (!closed) {
      // Fallback: click a close-like button from DOM regardless of transient visibility state.
      const clickedByDom = await page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"]');
        if (!dialog) {
          return false;
        }
        const buttons = Array.from(dialog.querySelectorAll('button')) as HTMLButtonElement[];
        const candidate = buttons.find((b) => {
          const text = (b.textContent || '').toLowerCase();
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          const title = (b.getAttribute('title') || '').toLowerCase();
          return text.includes('close') || aria.includes('close') || title.includes('close');
        }) || buttons[0];
        if (!candidate) {
          return false;
        }
        candidate.click();
        return true;
      });
      if (clickedByDom) {
        await page.waitForTimeout(300);
        closed = !(await detailsDialog.isVisible().catch(() => false));
      }
    }

    if (!closed) {
      // Do not fail capture solely on dialog-close detection; continue to reset attempt.
      console.warn('  ⚠ Could not confidently confirm dialog close; continuing to reset.');
    } else {
      console.log('  ✓ Details window closed');
    }

    // Sequence step 5: click Reset fields after reading result
    console.log('  Clicking Reset fields...');
    const resetClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
      const reset = buttons.find((b) => (b.textContent || '').includes('[Reset fields]'));
      if (!reset) {
        return false;
      }
      reset.click();
      return true;
    });
    if (!resetClicked) {
      // Secondary reset path via Playwright locator for cases where text is wrapped differently.
      const resetButton = page.locator('button:has-text("[Reset fields]")').first();
      if (await resetButton.isVisible().catch(() => false)) {
        await resetButton.click().catch(() => {});
      }
    }
    await page.waitForTimeout(800);
    console.log('  ✓ Reset complete');

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
  const idArgIndex = process.argv.indexOf('--id');
  const idFilterArg = idArgIndex >= 0 ? process.argv[idArgIndex + 1] : undefined;
  const idFilterSet = new Set(
    (idFilterArg ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

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

  const baselineForecastYears = baseline.defaults?.forecastYears ?? 3;

  // Load scenarios
  const allScenarios = await loadBaselineScenarios();
  const scenarios = idFilterSet.size > 0
    ? allScenarios.filter((s) => idFilterSet.has(s.id))
    : allScenarios;
  console.log(`\n📊 Veeam Calculator Scraper`);
  console.log(`Loaded ${scenarios.length} scenarios for capture${idFilterSet.size > 0 ? ` (filtered from ${allScenarios.length})` : ''}.\n`);

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
    let results = await scrapeCalculator(scenario, baselineForecastYears);

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
