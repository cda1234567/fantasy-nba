import { test, expect, Page, BrowserContext } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const LEAGUE_ID = 'qa-r2-g4';
const BASE = 'https://nbafantasy.cda1234567.com';
const SHOT_DIR = path.join(__dirname, 'screenshots_g4p');
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
  const line = `[${ts}] ${msg}`;
  findings.push(line);
  console.log(line);
}

async function apiGet(page: Page, url: string) {
  return await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    const t = await r.text();
    return { status: r.status, body: t };
  }, url);
}

async function ensureLeague(page: Page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await snap(page, 'landing');

  const switchBtn = page.locator('#btn-league-switch');
  await expect(switchBtn).toBeVisible({ timeout: 15_000 });
  await switchBtn.click();
  await page.waitForTimeout(500);
  await snap(page, 'switcher_open');

  const existing = page.locator(`#league-switch-menu [data-league="${LEAGUE_ID}"]`).first();
  if (await existing.count()) {
    log(`League ${LEAGUE_ID} already exists. Click to switch.`);
    await existing.click();
    await page.waitForTimeout(1500);
    return 'reused';
  }

  const newBtn = page.locator('#btn-lsw-new');
  if (await newBtn.count()) {
    await newBtn.click();
  } else {
    await page.evaluate(() => { const d: any = document.getElementById('dlg-new-league'); if (d?.showModal) d.showModal(); });
  }
  await page.waitForTimeout(400);
  await snap(page, 'new_league_dialog');

  const idInput = page.locator('#new-league-id');
  await idInput.fill(LEAGUE_ID);
  await snap(page, 'new_league_filled');
  await page.locator('#btn-new-league-create').click();
  await page.waitForTimeout(2500);
  await snap(page, 'after_create');
  return 'created';
}

async function completeSetupIfPresent(page: Page) {
  // Look for setup view and submit default settings
  const setupRoot = page.locator('#view-setup, [data-route="setup"]').first();
  if (await setupRoot.count()) {
    await snap(page, 'setup_view');
    const startBtn = page.locator('button:has-text("開始選秀"), button:has-text("建立聯盟"), button:has-text("下一步")').first();
    if (await startBtn.count()) {
      await startBtn.click().catch(() => {});
      await page.waitForTimeout(2500);
    }
  }
}

async function draftAllViaUI(page: Page) {
  await page.goto(BASE + '/#draft', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await snap(page, 'draft_entry');

  const hero = page.locator('.draft-hero, #draft-hero-container').first();
  if (!(await hero.isVisible().catch(() => false))) {
    log('P0: draft hero not visible');
  }

  // Loop: while draft not complete, if my turn pick first available; else sim-to-me.
  for (let i = 0; i < 200; i++) {
    const complete = await page.locator('.draft-hero.complete').first().count();
    if (complete) break;

    const pickBtn = page.locator('#tbl-available button[data-draft]:not([disabled])').first();
    if (await pickBtn.count()) {
      await pickBtn.click().catch(() => {});
      await page.waitForTimeout(900);
      continue;
    }

    const sim = page.locator('button:has-text("模擬到我")').first();
    if (await sim.count() && !(await sim.isDisabled().catch(() => true))) {
      await sim.click().catch(() => {});
      await page.waitForTimeout(2500);
      continue;
    }
    const adv = page.locator('button:has-text("推進 AI 一手")').first();
    if (await adv.count() && !(await adv.isDisabled().catch(() => true))) {
      await adv.click().catch(() => {});
      await page.waitForTimeout(1200);
      continue;
    }
    await page.waitForTimeout(1500);
  }
  await snap(page, 'draft_done');
  const done = await page.locator('.draft-hero.complete').first().count();
  log(`Draft complete: ${done > 0}`);
  return done > 0;
}

async function startSeason(page: Page) {
  await page.goto(BASE + '/#league', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await snap(page, 'league_before_start');
  const startBtn = page.locator('button:has-text("開始賽季")').first();
  if (await startBtn.count()) {
    await startBtn.click().catch(() => {});
    await page.waitForTimeout(2500);
    // confirm dialog
    const confirm = page.locator('button:has-text("確認"), button:has-text("開始"), button:has-text("是")').last();
    if (await confirm.count()) {
      await confirm.click().catch(() => {});
      await page.waitForTimeout(2500);
    }
    await snap(page, 'season_started');
    log('Season started');
    return true;
  }
  log('P1: 開始賽季 button missing on league page');
  return false;
}

async function advanceWeek(page: Page) {
  await page.goto(BASE + '/#league', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const w = page.locator('button:has-text("推進一週")').first();
  if (await w.count() && !(await w.isDisabled().catch(() => true))) {
    await w.click().catch(() => {});
    await page.waitForTimeout(3500);
    await snap(page, 'after_week');
    return true;
  }
  return false;
}

async function advanceDay(page: Page) {
  await page.goto(BASE + '/#league', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const d = page.locator('button:has-text("推進一天")').first();
  if (await d.count() && !(await d.isDisabled().catch(() => true))) {
    await d.click().catch(() => {});
    await page.waitForTimeout(2200);
    return true;
  }
  return false;
}

test('g4 player: lineup editor + injury edge cases', async ({ page, context }) => {
  test.setTimeout(22 * 60_000);
  const consoleErr: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErr.push(m.text()); });
  page.on('pageerror', (e) => consoleErr.push('pageerror: ' + e.message));

  // Navigate to base first so fetch/evaluate has a document origin
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

  // === Part A: injuries API pre-season ===
  const preInj = await apiGet(page, BASE + '/api/injuries/active');
  log(`[pre-season] GET /api/injuries/active → status=${preInj.status} body=${preInj.body.slice(0, 120)}`);

  // === 1. Create / select league ===
  const state = await ensureLeague(page);
  log(`League ${LEAGUE_ID}: ${state}`);

  const activeLabel = await page.locator('#btn-league-switch .lsw-label').textContent().catch(() => '');
  log(`Active league label: "${activeLabel}"`);

  // === 2. Setup (if applicable) ===
  await completeSetupIfPresent(page);

  // === 3. Draft 13 rounds via UI ===
  const drafted = await draftAllViaUI(page);
  if (!drafted) log('P0: draft did not complete.');

  // === EDGE: press 開始賽季 — should work once. Press again → verify disabled/error.
  const started = await startSeason(page);
  if (!started) log('P0: could not start season.');
  // Try again — should error or be disabled
  await page.goto(BASE + '/#league', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const startBtn2 = page.locator('button:has-text("開始賽季")').first();
  const startBtn2Count = await startBtn2.count();
  const startBtn2Disabled = startBtn2Count ? await startBtn2.isDisabled().catch(() => false) : false;
  log(`After start: 開始賽季 button count=${startBtn2Count} disabled=${startBtn2Disabled}`);
  if (startBtn2Count && !startBtn2Disabled) {
    log('P1: 開始賽季 button still clickable after season started.');
    await startBtn2.click().catch(() => {});
    await page.waitForTimeout(1500);
    await snap(page, 'start_season_second_time');
  } else {
    await snap(page, 'start_season_disabled');
  }

  // === Part B: injuries API post-season ===
  const postInj = await apiGet(page, BASE + '/api/injuries/active');
  log(`[post-season] GET /api/injuries/active → status=${postInj.status} body(0..200)=${postInj.body.slice(0, 200)}`);

  // === 4. Advance 1 week ===
  const wk = await advanceWeek(page);
  log(`Advanced 1 week: ${wk}`);

  // === 5. Open lineup editor for my team → verify slot order ===
  await page.goto(BASE + '/#team', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await snap(page, 'team_view');

  const slotBadges = await page.locator('table.lineup-slots .slot-badge').allTextContents().catch(() => [] as string[]);
  log(`Lineup slot order observed: [${slotBadges.join(', ')}]`);
  const EXPECTED = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'C', 'UTIL', 'UTIL'];
  const orderOK = JSON.stringify(slotBadges) === JSON.stringify(EXPECTED);
  log(`Slot order matches expected ${JSON.stringify(EXPECTED)}: ${orderOK}`);
  if (!orderOK) log(`P0: Lineup slot order mismatch. expected=${EXPECTED.join(',')} got=${slotBadges.join(',')}`);

  // Verify bench present
  const benchRows = await page.locator('.bench-row, tr.bench, .bench-list tr').count().catch(() => 0);
  log(`Bench rows count: ${benchRows}`);
  await snap(page, 'lineup_slots_rendered');

  // === G-vs-UTIL preference: open G slot swap, pick a PG/SG player who is currently in UTIL ===
  // (approximation: change first UTIL slot → pick a PG player; then try G slot, confirm same PG is flagged as 先發中)
  const changeButtons = await page.locator('.lineup-change-btn').count();
  log(`Change buttons in lineup: ${changeButtons}`);

  // Gather lineup slot info via API
  const teamInfo = await page.evaluate(async () => {
    const res = await fetch('/api/state', { credentials: 'include' });
    const s = await res.json();
    const humanId = s.teams?.find((t: any) => t.is_human)?.id ?? 0;
    const td = await fetch(`/api/teams/${humanId}`, { credentials: 'include' }).then(r => r.json());
    return td;
  });
  const players: any[] = teamInfo.players || [];
  const gEligible = players.filter(p => /PG|SG/.test(p.pos || ''));
  const cEligible = players.filter(p => /\bC\b/.test(p.pos || ''));
  log(`Roster snapshot — total=${players.length} G-eligible=${gEligible.length} C-eligible=${cEligible.length} injured_out=${(teamInfo.injured_out||[]).length}`);
  log(`Slot snapshot (from API): ${JSON.stringify((teamInfo.lineup_slots || []).map((s: any) => ({ slot: s.slot, pid: s.player_id })))}`);

  // Verify which player currently occupies G slot vs UTIL slot
  const slots: any[] = teamInfo.lineup_slots || [];
  const gSlot = slots.find(s => s.slot === 'G');
  const utilSlots = slots.filter(s => s.slot === 'UTIL');
  log(`G-slot current player_id=${gSlot?.player_id} ; UTIL player_ids=${utilSlots.map(s => s.player_id).join(',')}`);

  // UI: click G swap; record candidates, pick the highest-fppg G candidate who is not currently in G
  const gChangeBtn = page.locator('.lineup-change-btn[data-slot="G"]').first();
  if (await gChangeBtn.count()) {
    await gChangeBtn.click();
    await page.waitForTimeout(600);
    await snap(page, 'g_slot_swap_modal');
    const candidates = await page.locator('#lineup-swap-modal table.players-table tbody tr').count();
    log(`G-slot swap modal candidate rows: ${candidates}`);
    // close
    await page.locator('#close-swap-modal').click().catch(() => {});
    await page.waitForTimeout(300);
  } else {
    log('G-slot change button not found.');
  }

  // C slot: verify only C-eligible appears
  const cChangeBtn = page.locator('.lineup-change-btn[data-slot="C"]').first();
  if (await cChangeBtn.count()) {
    await cChangeBtn.click();
    await page.waitForTimeout(600);
    await snap(page, 'c_slot_swap_modal');
    const posTags = await page.locator('#lineup-swap-modal .pos-tag').allTextContents().catch(() => [] as string[]);
    const allHaveC = posTags.every(t => /C/.test(t));
    log(`C-slot candidates positions: ${posTags.join(' | ')} — all include C: ${allHaveC}`);
    if (!allHaveC) log('P0: C-slot swap modal contained non-C candidates.');
    await page.locator('#close-swap-modal').click().catch(() => {});
    await page.waitForTimeout(300);
  }

  // UTIL slot: verify candidates include multi-position (all 5)
  const utilChangeBtn = page.locator('.lineup-change-btn[data-slot="UTIL"]').first();
  if (await utilChangeBtn.count()) {
    await utilChangeBtn.click();
    await page.waitForTimeout(600);
    await snap(page, 'util_slot_swap_modal');
    const utilCandidates = await page.locator('#lineup-swap-modal table.players-table tbody tr').count();
    log(`UTIL-slot swap modal candidate rows: ${utilCandidates}`);
    await page.locator('#close-swap-modal').click().catch(() => {});
    await page.waitForTimeout(300);
  }

  // === 6. INJURY DURING LINEUP — advance to find injured players ===
  let injuredPlayers: any[] = [];
  for (let tries = 0; tries < 3; tries++) {
    const td = await page.evaluate(async () => {
      const res = await fetch('/api/state', { credentials: 'include' });
      const s = await res.json();
      const humanId = s.teams?.find((t: any) => t.is_human)?.id ?? 0;
      return await fetch(`/api/teams/${humanId}`, { credentials: 'include' }).then(r => r.json());
    });
    const injIds: number[] = td.injured_out || [];
    if (injIds.length) {
      injuredPlayers = (td.players || []).filter((p: any) => injIds.includes(p.id));
      log(`Injured players on roster: ${injuredPlayers.map(p => `${p.name}(${p.pos})`).join(', ')}`);
      break;
    }
    log(`No injuries yet; advancing a week (try ${tries + 1})`);
    const ok = await advanceWeek(page);
    if (!ok) break;
  }
  if (!injuredPlayers.length) {
    log('P2: no injured players surfaced within 3 week advances. Skipping injury-block test.');
  } else {
    // Try to put injured player into a starting slot via full lineup modal
    await page.goto(BASE + '/#team', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const setLineupBtn = page.locator('#btn-set-lineup').first();
    if (await setLineupBtn.count()) {
      await setLineupBtn.click();
      await page.waitForTimeout(600);
      await snap(page, 'lineup_full_modal');
      const injPid = injuredPlayers[0].id;
      const injRowExists = await page.locator(`#lineup-full-tbl input.lineup-check[data-pid="${injPid}"]`).count();
      log(`Injured player (pid=${injPid}) appears in full-lineup modal: ${injRowExists > 0}`);
      if (injRowExists > 0) log('P1: Injured player was shown in the "選 N 人" modal (UI should hide per code: filter !injSet.has).');
      else log('Injury filter OK: injured player hidden from full-lineup modal.');
      // Close
      await page.locator('#close-lineup-modal').click().catch(() => {});
      await page.waitForTimeout(300);
    }

    // Try swap modal for slot compatible with injured position
    const injPos = injuredPlayers[0].pos?.split('/')[0] || 'PG';
    const swapBtn = page.locator(`.lineup-change-btn[data-slot="${injPos}"]`).first();
    if (await swapBtn.count()) {
      await swapBtn.click();
      await page.waitForTimeout(500);
      await snap(page, 'swap_modal_injury_check');
      const injPidInSwap = await page.locator(`#lineup-swap-modal .slot-pick-btn[data-pid="${injuredPlayers[0].id}"]`).count();
      log(`Injured pid=${injuredPlayers[0].id} available in swap modal for slot ${injPos}: ${injPidInSwap > 0}`);
      if (injPidInSwap > 0) log('P1: Swap modal allowed selecting an injured player.');
      await page.locator('#close-swap-modal').click().catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  // === 7. LINEUP OVERRIDE — 僅今日鎖定 vs persistent ===
  // (A) 僅今日鎖定 → check next day reverts
  await page.goto(BASE + '/#team', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const setBtn = page.locator('#btn-set-lineup').first();
  if (await setBtn.count()) {
    await setBtn.click();
    await page.waitForTimeout(600);

    // Select first N available checkboxes up to targetCount (they default to current starters).
    // Instead, untoggle one then toggle it back to force the override save.
    const checks = page.locator('#lineup-full-tbl input.lineup-check');
    const checksCount = await checks.count();
    let toggledOne = false;
    for (let i = 0; i < checksCount; i++) {
      const cb = checks.nth(i);
      const wasChecked = await cb.isChecked();
      if (wasChecked) {
        await cb.uncheck().catch(() => {});
        await page.waitForTimeout(200);
        await cb.check().catch(() => {});
        toggledOne = true;
        break;
      }
    }
    await page.locator('#chk-today-only').check().catch(() => {});
    await snap(page, 'today_only_checked');
    await page.locator('#btn-save-lineup').click().catch(() => {});
    await page.waitForTimeout(2000);
    log(`Saved 僅今日鎖定 override (toggled=${toggledOne}).`);
    await snap(page, 'after_today_only_save');

    // Check override badge present
    const overrideBadge = await page.locator('.pill.warn:has-text("手動陣容")').count();
    log(`Manual-lineup badge after 僅今日鎖定 save: ${overrideBadge > 0}`);

    // Advance a day → badge should disappear (expires)
    const daily = await advanceDay(page);
    log(`Advanced one day: ${daily}`);
    await page.goto(BASE + '/#team', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    const badgeAfter = await page.locator('.pill.warn:has-text("手動陣容")').count();
    log(`Manual-lineup badge after 1 day advance: ${badgeAfter > 0}`);
    await snap(page, 'after_one_day_revert');
    if (badgeAfter > 0) log('P1: 僅今日鎖定 override did not clear after advancing one day.');
  } else {
    log('P1: 設定先發陣容 button missing on team page.');
  }

  // (B) Persistent override (固定陣容) → set without today_only, advance 3 days, verify still sticky
  const setBtn2 = page.locator('#btn-set-lineup').first();
  if (await setBtn2.count()) {
    await setBtn2.click();
    await page.waitForTimeout(600);
    const checks = page.locator('#lineup-full-tbl input.lineup-check');
    const count = await checks.count();
    for (let i = 0; i < count; i++) {
      const cb = checks.nth(i);
      if (await cb.isChecked()) {
        await cb.uncheck().catch(() => {});
        await page.waitForTimeout(150);
        await cb.check().catch(() => {});
        break;
      }
    }
    // today-only unchecked → persistent
    const today = page.locator('#chk-today-only');
    if (await today.isChecked().catch(() => false)) await today.uncheck().catch(() => {});
    await snap(page, 'persistent_about_to_save');
    await page.locator('#btn-save-lineup').click().catch(() => {});
    await page.waitForTimeout(2000);
    await snap(page, 'persistent_saved');

    // Advance 3 days, check badge persists
    let daysAdvanced = 0;
    for (let d = 0; d < 3; d++) {
      const ok = await advanceDay(page);
      if (!ok) break;
      daysAdvanced++;
    }
    await page.goto(BASE + '/#team', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    const badgeStill = await page.locator('.pill.warn:has-text("手動陣容")').count();
    log(`After ${daysAdvanced} days, persistent override badge still present: ${badgeStill > 0}`);
    if (!badgeStill) log('P1: Persistent 固定陣容 override disappeared within 3 days.');
    await snap(page, 'persistent_after_3_days');
  }

  // === 8. CONCURRENT LINEUP EDIT (2 tabs, same team) ===
  const page2: Page = await context.newPage();
  page2.on('pageerror', (e) => consoleErr.push('page2 pageerror: ' + e.message));
  await page2.goto(BASE + '/#team', { waitUntil: 'domcontentloaded' });
  await page2.waitForTimeout(2500);
  await snap(page, 'tab1_team_view');
  await page2.screenshot({ path: path.join(SHOT_DIR, `g4p_${String(++shotIdx).padStart(2,'0')}_tab2_team_view.png`), fullPage: true }).catch(() => {});

  // tab1: open modal, toggle one starter to a different player via swap
  const p1Swap = page.locator('.lineup-change-btn').first();
  const p2Swap = page2.locator('.lineup-change-btn').first();
  const openBoth = async () => {
    if (await p1Swap.count()) await p1Swap.click().catch(() => {});
    if (await p2Swap.count()) await p2Swap.click().catch(() => {});
    await page.waitForTimeout(600);
    await page2.waitForTimeout(600);
  };
  await openBoth();
  const pick1 = page.locator('#lineup-swap-modal .slot-pick-btn:not([disabled])').first();
  const pick2 = page2.locator('#lineup-swap-modal .slot-pick-btn:not([disabled])').last();
  // Capture target pids for observability
  const pid1 = await pick1.getAttribute('data-pid').catch(() => null);
  const pid2 = await pick2.getAttribute('data-pid').catch(() => null);
  log(`Concurrent pick — tab1 → pid=${pid1}, tab2 → pid=${pid2}`);
  if (await pick1.count()) await pick1.click().catch(() => {});
  // small stagger to test last-write-wins
  await page.waitForTimeout(350);
  if (await pick2.count()) await pick2.click().catch(() => {});
  await page.waitForTimeout(2500);
  await page2.waitForTimeout(2500);
  await snap(page, 'after_concurrent_tab1');
  await page2.screenshot({ path: path.join(SHOT_DIR, `g4p_${String(++shotIdx).padStart(2,'0')}_after_concurrent_tab2.png`), fullPage: true }).catch(() => {});

  // Read server truth
  const finalLineup = await page.evaluate(async () => {
    const s = await fetch('/api/state', { credentials: 'include' }).then(r => r.json());
    const humanId = s.teams?.find((t: any) => t.is_human)?.id;
    return await fetch(`/api/teams/${humanId}`, { credentials: 'include' }).then(r => r.json());
  });
  const finalStarters = (finalLineup.lineup_slots || []).map((s: any) => s.player_id);
  log(`Post-concurrent server starters: [${finalStarters.join(', ')}]`);
  const containsPid2 = pid2 != null && finalStarters.includes(Number(pid2));
  const containsPid1 = pid1 != null && finalStarters.includes(Number(pid1));
  log(`Final contains tab1 pid=${pid1}: ${containsPid1}; tab2 pid=${pid2}: ${containsPid2} → last-write-wins=${containsPid2 && !containsPid1}`);

  await page2.close();

  // === 9. 重置選秀 after season started ===
  await page.goto(BASE + '/#draft', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await snap(page, 'draft_after_season_started');
  const resetBtn = page.locator('button:has-text("重置選秀")').first();
  if (await resetBtn.count()) {
    const disabled = await resetBtn.isDisabled().catch(() => false);
    log(`重置選秀 button present after season start. Disabled=${disabled}`);
    if (!disabled) {
      // open confirm prompt, then cancel (avoid actually nuking state mid-test)
      await resetBtn.click().catch(() => {});
      await page.waitForTimeout(800);
      await snap(page, 'draft_reset_prompt');
      // cancel
      const cancel = page.locator('button:has-text("取消"), button:has-text("關閉"), button:has-text("Cancel")').last();
      if (await cancel.count()) await cancel.click().catch(() => {});
      else await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
  } else {
    log('重置選秀 button absent after season start (as expected).');
  }

  // === 10. League switch during draft: since draft is done, simulate by going to #draft then switching league ===
  await page.goto(BASE + '/#draft', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await snap(page, 'before_league_switch');
  const switcher = page.locator('#btn-league-switch');
  if (await switcher.count()) {
    await switcher.click().catch(() => {});
    await page.waitForTimeout(500);
    await snap(page, 'league_switch_menu');
    // Pick a different existing league if any
    const otherLeague = page.locator('#league-switch-menu .lsw-item').filter({ hasNotText: LEAGUE_ID }).first();
    if (await otherLeague.count()) {
      await otherLeague.click().catch(() => {});
      await page.waitForTimeout(2500);
      await snap(page, 'after_switch_other');
      log('Switched to another league during draft view.');
      // Switch back
      await page.locator('#btn-league-switch').click().catch(() => {});
      await page.waitForTimeout(400);
      const back = page.locator(`#league-switch-menu [data-league="${LEAGUE_ID}"]`).first();
      if (await back.count()) {
        await back.click();
        await page.waitForTimeout(2000);
      }
    } else {
      log('Only one league exists — cannot test switch preservation.');
      await page.keyboard.press('Escape');
    }
  }

  // === Final ===
  log(`Final console errors count: ${consoleErr.length}`);
  if (consoleErr.length) log('First 3 console errors: ' + consoleErr.slice(0, 3).join(' | '));

  fs.writeFileSync(path.join(__dirname, 'g4_player_trace.log'), findings.join('\n'));
  fs.writeFileSync(path.join(__dirname, 'g4_player_findings.json'), JSON.stringify(findings, null, 2));
});
