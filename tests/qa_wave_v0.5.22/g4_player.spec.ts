import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const LEAGUE_ID = 'qa-g4';
const BASE = 'https://nbafantasy.cda1234567.com';
const SHOT_DIR = path.join(__dirname, 'screenshots');
const findings: string[] = [];
let shotIdx = 0;

async function snap(page: Page, label: string) {
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const name = `g4p_${String(++shotIdx).padStart(2, '0')}_${label}.png`;
  await page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: true }).catch(() => {});
  return name;
}

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  findings.push(`[${ts}] ${msg}`);
  console.log(msg);
}

test('g4 player QA journey', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const consoleErr: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErr.push(m.text()); });
  page.on('pageerror', (e) => consoleErr.push('pageerror: ' + e.message));

  // === 1. Initial load ===
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await snap(page, 'loaded');
  const ver = await page.locator('text=/v0\\.\\d+\\.\\d+/').first().textContent().catch(() => '');
  log(`Initial load. Version text: ${ver || '(none found)'}. Console errors: ${consoleErr.length}`);

  // === 2. League switcher: open menu, create qa-g4 ===
  const switchBtn = page.locator('#btn-league-switch');
  await expect(switchBtn).toBeVisible({ timeout: 15_000 });
  await snap(page, 'switcher_closed');
  await switchBtn.click();
  await page.waitForTimeout(500);
  await snap(page, 'switcher_open');

  // Existing leagues listed?
  const menuItems = await page.locator('#league-switch-menu .lsw-item').count().catch(() => 0);
  log(`League switcher opened. Existing leagues: ${menuItems}`);

  // Check if qa-g4 already exists → delete first for clean slate (best-effort).
  const existing = page.locator(`#league-switch-menu [data-league="${LEAGUE_ID}"]`).first();
  if (await existing.count()) {
    log('qa-g4 already exists; will reuse.');
  }

  // Find "new league" trigger
  const newLeagueTrigger = page.locator('button, a').filter({ hasText: /建立新聯盟|新增聯盟|\+.*聯盟|新聯盟/ }).first();
  if (await newLeagueTrigger.count()) {
    await newLeagueTrigger.click();
  } else {
    // fallback: maybe opening the dialog directly
    await page.evaluate(() => { const d: any = document.getElementById('dlg-new-league'); if (d?.showModal) d.showModal(); });
  }
  await page.waitForTimeout(400);
  await snap(page, 'new_league_dialog');

  // Input league id
  const idInput = page.locator('#new-league-id');
  if (await idInput.count()) {
    await idInput.fill(LEAGUE_ID);
    await snap(page, 'new_league_filled');
    const createBtn = page.locator('#btn-new-league-create');
    await createBtn.click();
    log('Clicked 建立並切換');
    await page.waitForTimeout(2500);
    await snap(page, 'after_create');
  } else {
    log('P0: #new-league-id input not found. New-league dialog may be broken.');
  }

  // Confirm active league is qa-g4
  const activeLabel = await page.locator('#btn-league-switch .lsw-label').textContent().catch(() => '');
  log(`Active league label after create: "${activeLabel}"`);
  if (!activeLabel || !activeLabel.includes(LEAGUE_ID)) {
    log(`P1: Active league label does not reflect qa-g4 (got "${activeLabel}"). Check switcher refresh.`);
  }

  // === 3. League settings (setup) page ===
  await page.waitForTimeout(800);
  await snap(page, 'setup_or_draft');
  const onSetup = await page.locator('[data-route="setup"], #view-setup').first().count();
  log(`On setup-like view after create? ${onSetup > 0}`);

  // === 4. Navigate to draft ===
  await page.goto(BASE + '/#draft', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await snap(page, 'draft_entry');

  // Key draft UI checks
  const hero = page.locator('.draft-hero, #draft-hero-container');
  const heroVisible = await hero.isVisible().catch(() => false);
  log(`Draft hero visible: ${heroVisible}`);
  if (!heroVisible) log('P0: Draft hero not visible on #draft route.');

  const availTable = page.locator('#tbl-available');
  await availTable.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  const rowsCount = await availTable.locator('tbody tr').count().catch(() => 0);
  log(`Available players rows: ${rowsCount}`);

  // Filter bar / search present?
  const searchBox = page.locator('[data-filter="q"], input[placeholder*="搜尋"], input[type="search"]').first();
  const hasSearch = await searchBox.count();
  log(`Draft search box present: ${hasSearch > 0}`);

  // Position filter chips?
  const posChips = await page.locator('[data-filter="pos"], .filter-chip, button:has-text("PG"), button:has-text("SG")').count();
  log(`Position filter controls count: ${posChips}`);

  // Sort controls
  const sortCtrl = await page.locator('[data-filter="sort"], select[name*="sort"], th:has-text("FPPG")').count();
  log(`Sort controls count: ${sortCtrl}`);

  // === 5. Manual picks (5+) ===
  let successfulPicks = 0;
  for (let i = 0; i < 12; i++) {
    // Wait until human's turn (draft hero .you-turn) or timeout 20s
    const heroEl = page.locator('.draft-hero').first();
    const cls = await heroEl.getAttribute('class').catch(() => '');
    if (cls && cls.includes('ai-turn')) {
      // press sim-to-me if available
      const simBtn = page.locator('button:has-text("模擬到我"), button:has-text("Sim to me")').first();
      if (await simBtn.count() && !(await simBtn.isDisabled().catch(() => true))) {
        log('AI turn detected → clicking 模擬到我');
        await simBtn.click().catch(() => {});
        await page.waitForTimeout(3000);
      } else {
        // try advance one
        const adv = page.locator('button:has-text("推進 AI 一手")').first();
        if (await adv.count() && !(await adv.isDisabled().catch(() => true))) {
          await adv.click().catch(() => {});
          await page.waitForTimeout(1500);
        } else {
          await page.waitForTimeout(2000);
        }
      }
    }

    // Find first enabled 選秀 button
    const pickBtn = page.locator('#tbl-available button[data-draft]:not([disabled])').first();
    const hasPickable = await pickBtn.count();
    if (!hasPickable) {
      log(`Round iteration ${i}: no enabled draft button; waiting.`);
      await page.waitForTimeout(1500);
      continue;
    }

    // Note ergonomics: scroll needed?
    const bbox = await pickBtn.boundingBox().catch(() => null);
    if (!bbox) { await page.waitForTimeout(800); continue; }

    const beforeOverall = await page.locator('.dh-picker-num').first().textContent().catch(() => '');
    await pickBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const afterOverall = await page.locator('.dh-picker-num').first().textContent().catch(() => '');
    if (beforeOverall !== afterOverall) {
      successfulPicks++;
      log(`Manual pick #${successfulPicks}: ${beforeOverall} → ${afterOverall}`);
      if (successfulPicks <= 3) await snap(page, `after_pick_${successfulPicks}`);
    } else {
      log(`Pick click did not advance overall (${beforeOverall}).`);
    }
    if (successfulPicks >= 5) break;
  }
  log(`Total manual picks: ${successfulPicks}`);
  if (successfulPicks < 5) log('P1: Could not complete 5 manual picks within retry budget. UX flow issue or AI/locking stuck.');

  // === 6. Auto complete remaining with sim-to-end ===
  await snap(page, 'before_sim_rest');
  // repeatedly press sim-to-me (acts as fast forward when not your turn)
  for (let i = 0; i < 25; i++) {
    const complete = await page.locator('.draft-hero.complete').first().count();
    if (complete) break;
    const simBtn = page.locator('button:has-text("模擬到我")').first();
    if (await simBtn.count() && !(await simBtn.isDisabled().catch(() => true))) {
      await simBtn.click().catch(() => {});
      await page.waitForTimeout(2500);
    } else {
      // If it's our turn, pick first available to keep moving
      const pickBtn = page.locator('#tbl-available button[data-draft]:not([disabled])').first();
      if (await pickBtn.count()) {
        await pickBtn.click().catch(() => {});
        await page.waitForTimeout(1200);
      } else {
        await page.waitForTimeout(1500);
      }
    }
  }
  const draftDone = await page.locator('.draft-hero.complete').first().count();
  log(`Draft completed: ${draftDone > 0}`);
  await snap(page, 'draft_complete');

  // === 7. Start season → advance 5 days ===
  await page.goto(BASE + '/#league', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await snap(page, 'league_page');

  // Try to find advance-day button
  for (let d = 0; d < 7; d++) {
    const advDay = page.locator('button:has-text("推進一天")').first();
    if (!(await advDay.count())) {
      log(`Advance-day button missing at iter ${d}`);
      break;
    }
    if (await advDay.isDisabled().catch(() => true)) {
      log(`Advance-day disabled at iter ${d}`);
      break;
    }
    await advDay.click().catch(() => {});
    await page.waitForTimeout(1800);
  }
  await snap(page, 'after_advance_days');

  // === 8. Propose 1 trade (best-effort) ===
  await page.goto(BASE + '/#teams', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await snap(page, 'teams_page');

  const tradeBtn = page.locator('button:has-text("提議交易"), button:has-text("交易"), a:has-text("交易")').first();
  if (await tradeBtn.count()) {
    await tradeBtn.click().catch(() => {});
    await page.waitForTimeout(1500);
    await snap(page, 'trade_modal');
    log('Opened trade UI.');
  } else {
    log('P2: Could not find trade entry point on teams page.');
  }

  // Close any open dialog
  await page.keyboard.press('Escape').catch(() => {});

  // === 9. Advance to end of season ===
  await page.goto(BASE + '/#league', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  // look for advance-week or sim-to-playoffs
  const simPlayoffs = page.locator('#btn-sim-playoffs, button:has-text("模擬到季後賽"), button:has-text("Sim to Playoffs")').first();
  if (await simPlayoffs.count()) {
    await simPlayoffs.click({ timeout: 5000 }).catch(() => {});
    log('Clicked sim-to-playoffs');
    await page.waitForTimeout(5000);
  } else {
    // fallback: press advance-week 22 times
    for (let w = 0; w < 23; w++) {
      const advW = page.locator('button:has-text("推進一週")').first();
      if (!(await advW.count()) || await advW.isDisabled().catch(() => true)) break;
      await advW.click().catch(() => {});
      await page.waitForTimeout(2500);
    }
  }
  await snap(page, 'end_of_season');

  // === Final ===
  log(`Final console errors count: ${consoleErr.length}`);
  if (consoleErr.length) {
    log('First 3 console errors: ' + consoleErr.slice(0, 3).join(' | '));
  }
  fs.writeFileSync(path.join(SHOT_DIR, '..', 'g4_player_trace.log'), findings.join('\n'));
});
