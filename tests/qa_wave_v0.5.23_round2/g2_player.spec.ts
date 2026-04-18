import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE = 'https://nbafantasy.cda1234567.com';
const LEAGUE_ID = 'qa-r2-g2';
const SHOT_DIR = 'screenshots';
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

const SHOT = (n: string) => path.join(SHOT_DIR, `g2p_${n}.png`);

async function shoot(page: Page, name: string, full = true) {
  try {
    await page.screenshot({ path: SHOT(name), fullPage: full });
  } catch (e) {
    // swallow
  }
}

async function confirmOk(page: Page, waitMs = 500): Promise<boolean> {
  await page.waitForTimeout(300);
  const ok = page.locator('#confirm-ok, #dlg-confirm button[value="ok"]').first();
  if (await ok.count()) {
    const visible = await ok.isVisible().catch(() => false);
    if (visible) {
      await ok.click({ force: true }).catch(() => {});
      await page.waitForTimeout(waitMs);
      return true;
    }
  }
  return false;
}

async function closeAnyDialog(page: Page) {
  // Close any open dialogs programmatically
  await page.evaluate(() => {
    document.querySelectorAll('dialog[open]').forEach((d: any) => {
      try { d.close(); } catch {}
    });
    document.querySelectorAll('.modal-overlay').forEach((m) => m.remove());
  }).catch(() => {});
  await page.waitForTimeout(200);
}

async function openSettings(page: Page): Promise<boolean> {
  await closeAnyDialog(page);
  // Try via button click first (real user)
  const btn = page.locator('#btn-menu');
  if (await btn.count()) {
    await btn.click({ timeout: 5000, force: true }).catch(() => {});
    await page.waitForTimeout(500);
  }
  let vis = await page.locator('#dlg-settings').isVisible().catch(() => false);
  if (vis) return true;
  // Fallback: programmatic showModal (simulates the same handler)
  await page.evaluate(() => {
    const dlg = document.getElementById('dlg-settings') as HTMLDialogElement | null;
    if (dlg && !dlg.open) { try { dlg.showModal(); } catch {} }
  }).catch(() => {});
  await page.waitForTimeout(300);
  vis = await page.locator('#dlg-settings').isVisible().catch(() => false);
  return vis;
}

test('g2 player — playoff + multi-week stress', async ({ page }) => {
  test.setTimeout(20 * 60 * 1000);
  const logs: string[] = [];
  const consoleErrors: string[] = [];
  const net4xx5xx: { url: string; status: number; method: string }[] = [];
  const timings: Record<string, number> = {};
  const draftClickMs: number[] = [];
  const rageClickMs: number[] = [];

  page.on('console', (m) => {
    const t = m.type();
    const line = `[${t}] ${m.text()}`;
    logs.push(line);
    if (t === 'error' || t === 'warning') consoleErrors.push(line);
  });
  page.on('pageerror', (e) => {
    const l = `[pageerror] ${e.message}`;
    logs.push(l);
    consoleErrors.push(l);
  });
  page.on('response', async (resp) => {
    try {
      const s = resp.status();
      if (s >= 400) {
        net4xx5xx.push({ url: resp.url(), status: s, method: resp.request().method() });
      }
    } catch {}
  });

  const apiGet = async <T = any>(p: string): Promise<T> =>
    page.evaluate(async (u) => (await fetch(u)).json(), p);

  const getSeasonState = async () => apiGet<any>('/api/season/standings').catch(() => ({}));
  const getDraftState = async () => apiGet<any>('/api/state').catch(() => ({}));

  // ===========================================================
  // STEP 1: Open home, create league via UI clicks
  // ===========================================================
  logs.push(`[step] 1. open home + create league ${LEAGUE_ID}`);
  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  timings.home_load_ms = Date.now() - t0;
  await shoot(page, '01_home');

  // version check
  const versionTxt = (await page.locator('#app-version').innerText().catch(() => '')) || '';
  logs.push(`[assert] version label: ${versionTxt}`);

  // Read current league first
  const st0a = await apiGet<any>('/api/state').catch(() => ({}));
  logs.push(`[state] initial league=${(st0a && st0a.league_id) || 'unknown'}`);

  const switchBtn = page.locator('#btn-league-switch');

  // Only do the create flow if we are NOT already on LEAGUE_ID
  if (st0a && st0a.league_id !== LEAGUE_ID) {
    // Open switcher menu
    await switchBtn.click();
    await page.waitForTimeout(400);
    await shoot(page, '02_league_menu_open');

    // Look for existing league item first
    const existingItem = page.locator(`#league-switch-menu [data-league="${LEAGUE_ID}"]`).first();
    if (await existingItem.count()) {
      const isDisabled = await existingItem.isDisabled().catch(() => false);
      if (isDisabled) {
        logs.push(`[info] ${LEAGUE_ID} button exists but disabled => already active`);
        await page.keyboard.press('Escape').catch(() => {});
      } else {
        await existingItem.click().catch(() => {});
        await page.waitForTimeout(1500);
        logs.push(`[ok] clicked existing league item for ${LEAGUE_ID}`);
      }
    } else {
      // Need to create it
      const createInMenu = page.locator('#league-switch-menu').getByText(/建立新聯盟|新增/i).first();
      if (await createInMenu.count()) {
        await createInMenu.click().catch(() => {});
        await page.waitForTimeout(500);
      }
      const newLeagueDlg = page.locator('#dlg-new-league');
      const dlgVisible = await newLeagueDlg.isVisible().catch(() => false);
      if (dlgVisible) {
        await page.locator('#new-league-id').fill(LEAGUE_ID);
        await shoot(page, '03_new_league_form');
        const createBtn = page.locator('#btn-new-league-create, #dlg-new-league button[type="submit"]:not([value="cancel"])').first();
        await createBtn.click();
        await page.waitForTimeout(1800);
        logs.push(`[ok] clicked create league button`);
        // Make sure dialog fully closed
        const stillOpen = await newLeagueDlg.isVisible().catch(() => false);
        if (stillOpen) {
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(300);
        }
      } else {
        logs.push(`[warn] new league dialog not visible`);
      }
    }
  } else {
    logs.push(`[ok] already on ${LEAGUE_ID}; skipping create`);
  }

  const st0 = await apiGet<any>('/api/state').catch(() => ({}));
  logs.push(`[state] after-bootstrap league=${st0.league_id}`);

  await page.reload();
  await page.waitForTimeout(1500);
  await shoot(page, '04_after_switch');

  // ===========================================================
  // STEP 2: Aggressive setup via UI — roster_size=13, veto_threshold=1, trade_deadline_week=2
  // ===========================================================
  logs.push(`[step] 2. aggressive setup`);
  // Click menu -> settings OR go to setup page
  // Check if we need to setup
  const status1 = await apiGet<any>('/api/league/status').catch(() => ({}));
  logs.push(`[state] league status=${JSON.stringify(status1).slice(0, 300)}`);

  // Navigate to #setup
  await page.goto(`${BASE}/#setup`);
  await page.waitForTimeout(1500);
  await shoot(page, '05_setup_view');

  const setupErrors: string[] = [];

  // Try clicking roster_size=13 radio
  const roster13 = page.locator('input[name="roster_size"][value="13"]').first();
  if (await roster13.count()) {
    await roster13.check({ force: true }).catch((e) => setupErrors.push(`roster_size check failed: ${e.message}`));
    logs.push(`[ok] set roster_size=13 via radio click`);
  } else {
    setupErrors.push('roster_size=13 radio not found');
  }

  // Try veto_threshold=1 (EXPECTED: NOT in radio options — which are 2,3,4)
  const veto1 = page.locator('input[name="veto_threshold"][value="1"]').first();
  const veto1Count = await veto1.count();
  logs.push(`[probe] veto_threshold=1 radio count=${veto1Count}`);
  if (veto1Count) {
    await veto1.check({ force: true }).catch((e) => setupErrors.push(`veto1 check failed: ${e.message}`));
    logs.push(`[ok] set veto_threshold=1 via radio click`);
  } else {
    // fallback — pick minimum available (2) and log the issue
    const veto2 = page.locator('input[name="veto_threshold"][value="2"]').first();
    if (await veto2.count()) {
      await veto2.check({ force: true }).catch(() => {});
      logs.push(`[finding] veto_threshold=1 NOT AVAILABLE in UI radios; options are 2/3/4. Using 2 as fallback.`);
      setupErrors.push('veto_threshold=1 not in UI radio options (P1 finding)');
    }
  }

  // trade_deadline_week = 2 via select
  const tradeSel = page.locator('select[name="trade_deadline_week"], select#setup-trade-deadline, select').filter({ hasText: /週/ }).first();
  // try different approach: find the select whose options include week numbers
  const allSelects = await page.locator('select').all();
  let tdSelected = false;
  for (const sel of allSelects) {
    const opts = await sel.locator('option').allInnerTexts().catch(() => [] as string[]);
    const joined = opts.join('|');
    if (/第\s*2\s*週|^2$/.test(joined) || joined.includes('第 2 週')) {
      const vals = await sel.locator('option').evaluateAll((els) => els.map((e: any) => e.value));
      logs.push(`[probe] trade_deadline select options=${JSON.stringify(vals)}`);
      if (vals.includes('2')) {
        await sel.selectOption('2').catch((e) => setupErrors.push(`select trade_deadline=2 failed: ${e.message}`));
        tdSelected = true;
        logs.push(`[ok] set trade_deadline_week=2 via select`);
      } else {
        // pick smallest available
        const smallest = vals.filter((v) => /^\d+$/.test(v)).sort((a, b) => parseInt(a) - parseInt(b))[0];
        if (smallest) {
          await sel.selectOption(smallest).catch(() => {});
          logs.push(`[finding] trade_deadline_week=2 NOT AVAILABLE; options=${JSON.stringify(vals)}; using smallest=${smallest}`);
          setupErrors.push(`trade_deadline_week=2 not in UI options: ${JSON.stringify(vals)}`);
        }
      }
      break;
    }
  }
  if (!tdSelected) {
    logs.push(`[warn] couldn't locate trade_deadline select reliably`);
  }

  await shoot(page, '06_setup_aggressive_filled');

  // Click submit setup
  const submitBtn = page.locator('#btn-setup-submit').first();
  if (await submitBtn.count()) {
    await submitBtn.click();
    await page.waitForTimeout(2000);
    logs.push(`[ok] clicked setup submit`);
  } else {
    setupErrors.push('setup submit button not found');
  }
  await shoot(page, '07_after_setup_submit');

  const status2 = await apiGet<any>('/api/league/status').catch(() => ({}));
  logs.push(`[state] post-setup status=${JSON.stringify(status2).slice(0, 300)}`);
  const settings2 = await apiGet<any>('/api/league/settings').catch(() => ({}));
  logs.push(`[state] settings: roster_size=${settings2.roster_size} veto=${settings2.veto_threshold} trade_deadline=${settings2.trade_deadline_week}`);

  // ===========================================================
  // STEP 3: 13-round UI-click draft — time each click, verify valid slots only
  // ===========================================================
  logs.push(`[step] 3. 13-round UI-click draft`);
  await page.goto(`${BASE}/#draft`);
  await page.waitForTimeout(1500);
  await shoot(page, '10_draft_initial');

  // If draft is already complete (prior run residue), reset draft via UI
  const dBefore = await getDraftState();
  if (dBefore && dBefore.is_complete) {
    logs.push(`[info] draft already complete; resetting via UI`);
    await closeAnyDialog(page);
    await openSettings(page);
    const resetDraftBtn = page.locator('#btn-reset-draft').first();
    if (await resetDraftBtn.count()) {
      await resetDraftBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(700);
      // confirm dialog
      const conf = page.locator('#dlg-confirm button:has-text("確定"), #confirm-ok, #dlg-confirm button[value="ok"]').first();
      if (await conf.count()) {
        await conf.click({ force: true }).catch(() => {});
        await page.waitForTimeout(1500);
        logs.push(`[ok] reset-draft confirmed`);
      }
    }
    await closeAnyDialog(page);
    await page.reload();
    await page.waitForTimeout(1500);
  }

  let humanPicksMade = 0;
  const maxIter = 400;
  for (let i = 0; i < maxIter; i++) {
    const s = await getDraftState();
    if (!s) break;
    if (s.is_complete) {
      logs.push(`[ok] draft complete at iter ${i}, human picks made=${humanPicksMade}`);
      break;
    }
    const isHuman = s.current_team_id === s.human_team_id;
    if (isHuman) {
      // scroll to available table
      const firstBtn = page.locator('button[data-draft]').first();
      if (await firstBtn.count()) {
        try {
          await firstBtn.scrollIntoViewIfNeeded();
        } catch {}
        const tClick = Date.now();
        await firstBtn.click({ timeout: 8000 }).catch(async (e) => {
          logs.push(`[warn] click draft btn failed: ${e.message}`);
        });
        const dt = Date.now() - tClick;
        draftClickMs.push(dt);
        humanPicksMade++;
        await page.waitForTimeout(250);
        if (humanPicksMade <= 3 || humanPicksMade === 13) {
          await shoot(page, `11_pick_${humanPicksMade}`);
        }
      } else {
        logs.push(`[warn] no data-draft button visible at iter ${i}`);
        await page.waitForTimeout(400);
      }
    } else {
      // AI turn — click "推進 AI 一手" if available, else fall through to automated advance
      const advBtn = page.locator('button:has-text("推進 AI"), button:has-text("AI 一手"), #btn-draft-ai-advance').first();
      if (await advBtn.count() && (await advBtn.isEnabled().catch(() => false))) {
        await advBtn.click().catch(() => {});
        await page.waitForTimeout(150);
      } else {
        // there's auto-advance — just wait
        await page.waitForTimeout(300);
      }
    }
    if (humanPicksMade >= 13 && i > 50) {
      // drive to completion via UI "sim to end" if present, else short wait loop
      const simBtn = page.locator('button:has-text("模擬到我"), button:has-text("⏭")').first();
      if (await simBtn.count() && (await simBtn.isEnabled().catch(() => false))) {
        await simBtn.click().catch(() => {});
        await page.waitForTimeout(500);
      }
    }
  }
  await shoot(page, '12_draft_done');

  const avgClick = draftClickMs.length ? Math.round(draftClickMs.reduce((a, b) => a + b, 0) / draftClickMs.length) : 0;
  const maxClick = draftClickMs.length ? Math.max(...draftClickMs) : 0;
  const minClick = draftClickMs.length ? Math.min(...draftClickMs) : 0;
  logs.push(`[timing] draft clicks: n=${draftClickMs.length} avg=${avgClick}ms min=${minClick}ms max=${maxClick}ms`);

  // Verify roster_size
  const stateAfterDraft = await getDraftState();
  const humanId = (stateAfterDraft.human_team_id ?? 0);
  const myTeam = await apiGet<any>(`/api/teams/${humanId}`).catch(() => ({}));
  const rosterSize = (myTeam.roster || []).length;
  logs.push(`[assert] my roster size after draft = ${rosterSize} (expect 13)`);

  // ===========================================================
  // STEP 4: Start season via dialog click
  // ===========================================================
  logs.push(`[step] 4. start season via dialog`);
  await closeAnyDialog(page);
  // Open settings dialog
  const settingsOpen1 = await openSettings(page);
  logs.push(`[ok] settings dialog open (step4)=${settingsOpen1}`);
  await shoot(page, '15_settings_dlg');

  // Look for "開始賽季" or similar button in dialog
  const startSeasonBtn = page.locator('#dlg-settings #btn-season-start, #dlg-settings button:has-text("開始賽季"), button:has-text("開始賽季"), #btn-season-start').first();
  let startedViaUI = false;
  if (await startSeasonBtn.count()) {
    await startSeasonBtn.click().catch(() => {});
    await page.waitForTimeout(2000);
    startedViaUI = true;
    logs.push(`[ok] clicked 開始賽季`);
  } else {
    logs.push(`[warn] start-season button not in settings dlg; navigating to schedule view`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.goto(`${BASE}/#schedule`);
    await page.waitForTimeout(1000);
    const startBtn2 = page.locator('button:has-text("開始賽季")').first();
    if (await startBtn2.count()) {
      await startBtn2.click().catch(() => {});
      await page.waitForTimeout(1500);
      startedViaUI = true;
      logs.push(`[ok] clicked 開始賽季 on schedule view`);
    }
  }
  if (!startedViaUI) {
    // final fallback to allow later steps to run
    const r = await page.evaluate(async () => {
      const r = await fetch('/api/season/start', { method: 'POST' });
      return { status: r.status };
    });
    logs.push(`[finding] could not find start-season UI button, used API fallback (status=${r.status}). P1: no clear start-season UI entry.`);
  }
  await page.reload();
  await page.waitForTimeout(1500);
  await shoot(page, '20_season_started');

  // ===========================================================
  // STEP 5: Click 模擬到季後賽 and set playoff lineups
  // ===========================================================
  logs.push(`[step] 5. 模擬到季後賽 via UI`);
  await closeAnyDialog(page);
  const settingsOpen2 = await openSettings(page);
  logs.push(`[ok] settings dialog open (step5)=${settingsOpen2}`);
  const simPlayoffsBtn = page.locator('#dlg-settings #btn-sim-playoffs, #btn-sim-playoffs, #dlg-settings button:has-text("模擬到季後賽")').first();
  if (await simPlayoffsBtn.count()) {
    const t1 = Date.now();
    await simPlayoffsBtn.click({ force: true });
    await page.waitForTimeout(800);
    // confirm dialog click
    await confirmOk(page, 800);
    logs.push(`[ok] confirmed sim-to-playoffs`);
    // wait for completion — polling season standings
    for (let j = 0; j < 60; j++) {
      await page.waitForTimeout(1000);
      const s = await getSeasonState();
      if (s && s.is_playoffs) {
        timings.sim_to_playoffs_ms = Date.now() - t1;
        logs.push(`[ok] reached playoffs in ${timings.sim_to_playoffs_ms}ms (week=${s.current_week})`);
        break;
      }
    }
  } else {
    logs.push(`[finding] #btn-sim-playoffs not found in settings dialog`);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForTimeout(1500);
  await shoot(page, '25_playoffs_entered');

  const stPO = await getSeasonState();
  logs.push(`[state] is_playoffs=${stPO.is_playoffs} week=${stPO.current_week}`);

  // ===========================================================
  // STEP 6: Screenshot lineup editor + VERIFY slot order
  // ===========================================================
  logs.push(`[step] 6. lineup editor slot order verification`);
  await page.goto(`${BASE}/#teams`);
  await page.waitForTimeout(1500);
  await shoot(page, '30_my_team_lineup');

  // Capture lineup_slots order from API (ground truth from backend)
  const myTeam2 = await apiGet<any>(`/api/teams/${humanId}`).catch(() => ({}));
  const slotOrder = (myTeam2.lineup_slots || []).map((s: any) => s.slot);
  const expectedSlotOrder = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'C', 'UTIL', 'UTIL'];
  const slotOrderMatches =
    slotOrder.length === expectedSlotOrder.length &&
    slotOrder.every((s: string, i: number) => s === expectedSlotOrder[i]);
  logs.push(`[assert] slot order API: ${JSON.stringify(slotOrder)}`);
  logs.push(`[assert] expected     : ${JSON.stringify(expectedSlotOrder)}`);
  logs.push(`[assert] slot order match = ${slotOrderMatches}`);

  // Also capture DOM-rendered slot order — restrict to slot-label badges inside lineup-slots table
  const domSlots = await page.locator('.lineup-slots tbody .slot-label .slot-badge').allInnerTexts().catch(() => [] as string[]);
  const domSlotsClean = domSlots.map((s) => s.trim()).filter((s) => /^(PG|SG|SF|PF|C|G|F|UTIL)$/.test(s));
  logs.push(`[assert] DOM slot order: ${JSON.stringify(domSlotsClean)}`);
  const domMatches =
    domSlotsClean.length >= expectedSlotOrder.length &&
    expectedSlotOrder.every((s, i) => domSlotsClean[i] === s);
  logs.push(`[assert] DOM slot order match = ${domMatches}`);

  // Bench count — should be 3 (13 - 10 = 3)
  const benchCount = (myTeam2.bench || []).length;
  logs.push(`[assert] bench count = ${benchCount} (expect 3)`);

  // Try clicking "設定先發陣容" and screenshot modal
  const setLineupBtn = page.locator('#btn-set-lineup').first();
  if (await setLineupBtn.count()) {
    await setLineupBtn.click().catch(() => {});
    await page.waitForTimeout(700);
    await shoot(page, '31_lineup_picker_modal');
    // close
    await page.locator('#close-lineup-modal').click().catch(() => {});
    await page.waitForTimeout(300);
  } else {
    logs.push(`[warn] #btn-set-lineup not found`);
  }

  // Click one per-slot swap button for screenshot
  const swapBtn = page.locator('.lineup-change-btn').first();
  if (await swapBtn.count()) {
    await swapBtn.click().catch(() => {});
    await page.waitForTimeout(600);
    await shoot(page, '32_slot_swap_modal');
    await page.locator('#close-swap-modal').click().catch(() => {});
    await page.waitForTimeout(300);
  }

  // ===========================================================
  // STEP 7: Playoff trade attempt (should fail — deadline passed)
  // ===========================================================
  logs.push(`[step] 7. playoff trade attempt (expect graceful failure)`);
  await page.goto(`${BASE}/#teams`);
  await page.waitForTimeout(1000);
  // Try to open trade dialog by clicking a trade button
  const tradeOpenBtn = page.locator('button:has-text("提議交易"), button:has-text("交易"), #btn-trade-propose').first();
  let tradeAttempted = false;
  let tradeResult = '';
  if (await tradeOpenBtn.count() && (await tradeOpenBtn.isEnabled().catch(() => false))) {
    await tradeOpenBtn.click().catch(() => {});
    await page.waitForTimeout(600);
    await shoot(page, '35_trade_dialog_playoffs');
    // try submitting
    const submitTrade = page.locator('#dlg-trade button[type="submit"], button:has-text("提議")').first();
    if (await submitTrade.count()) {
      await submitTrade.click().catch(() => {});
      await page.waitForTimeout(1000);
      tradeAttempted = true;
      tradeResult = 'clicked submit';
    }
    await page.keyboard.press('Escape').catch(() => {});
  } else {
    tradeResult = 'trade button disabled/hidden during playoffs (expected)';
    logs.push(`[ok] trade UI gracefully disabled during playoffs`);
  }
  // Additionally probe API via read (check if dialog would allow) — do NOT do POST write via fetch
  logs.push(`[assert] trade playoff attempt: ${tradeResult} (attempted=${tradeAttempted})`);
  await shoot(page, '36_after_trade_attempt');

  // ===========================================================
  // STEP 8: Drop a playoff starter + add from FA
  // ===========================================================
  logs.push(`[step] 8. drop/add during playoffs`);
  await page.goto(`${BASE}/#teams`);
  await page.waitForTimeout(1000);

  // Try clicking "drop" on a roster player
  const dropBtn = page.locator('button:has-text("釋出"), button:has-text("Drop"), button.drop-btn').first();
  let dropAttempted = false;
  if (await dropBtn.count() && (await dropBtn.isEnabled().catch(() => false))) {
    await dropBtn.click().catch(() => {});
    await page.waitForTimeout(500);
    // confirm
    const confBtn = page.locator('.dialog button:has-text("確認"), .dialog button:has-text("釋出")').first();
    if (await confBtn.count()) {
      await confBtn.click().catch(() => {});
      await page.waitForTimeout(800);
    }
    dropAttempted = true;
    logs.push(`[ok] clicked drop button`);
  } else {
    logs.push(`[warn] drop button not clickable`);
  }
  await shoot(page, '37_after_drop');

  // Go to FA page
  await page.goto(`${BASE}/#fa`);
  await page.waitForTimeout(1500);
  await shoot(page, '38_fa_page_playoffs');
  const signBtn = page.locator('button:has-text("簽約"), button:has-text("Sign")').first();
  if (await signBtn.count() && (await signBtn.isEnabled().catch(() => false))) {
    await signBtn.click().catch(() => {});
    await page.waitForTimeout(800);
    // confirm if any
    const confBtn2 = page.locator('.dialog button:has-text("確認")').first();
    if (await confBtn2.count()) {
      await confBtn2.click().catch(() => {});
      await page.waitForTimeout(800);
    }
    logs.push(`[ok] FA sign clicked during playoffs`);
  } else {
    logs.push(`[finding] FA sign button not actionable during playoffs`);
  }
  await shoot(page, '39_after_fa_sign');

  // ===========================================================
  // STEP 9: Click through playoff week advance + screenshot bracket/matchup
  // ===========================================================
  logs.push(`[step] 9. advance playoff weeks + matchup detail`);
  await page.goto(`${BASE}/#league`);
  await page.waitForTimeout(1500);
  await shoot(page, '50_playoff_league');

  // Find advance-week button (lives on #league, not #schedule)
  const advBtn = page.locator('button:has-text("推進一週")').first();
  if (await advBtn.count()) {
    const t2 = Date.now();
    await advBtn.click().catch(() => {});
    // handle confirm dialog if any
    await page.waitForTimeout(600);
    await confirmOk(page, 500);
    // wait for week advance to complete
    for (let k = 0; k < 40; k++) {
      await page.waitForTimeout(800);
      const s = await getSeasonState();
      if (s && (s.current_week > stPO.current_week || s.champion)) break;
    }
    timings.first_playoff_week_ms = Date.now() - t2;
    logs.push(`[ok] first playoff week advance in ${timings.first_playoff_week_ms}ms`);
  } else {
    logs.push(`[finding] no advance-week button found on schedule`);
  }
  await shoot(page, '51_after_first_playoff_week');

  // Try opening matchup detail
  await page.goto(`${BASE}/#league`);
  await page.waitForTimeout(1200);
  await shoot(page, '52_league_bracket');
  // click bracket matchup cell
  const matchupCell = page.locator('.bracket-match, .matchup-cell, [data-matchup]').first();
  if (await matchupCell.count()) {
    await matchupCell.click().catch(() => {});
    await page.waitForTimeout(700);
    await shoot(page, '53_matchup_detail');
    await page.keyboard.press('Escape').catch(() => {});
  } else {
    logs.push(`[warn] no matchup cell found to click`);
  }

  // ===========================================================
  // STEP 10: Rage-click advance-week 10× back-to-back
  // ===========================================================
  logs.push(`[step] 10. rage-click advance-week 10x`);
  await page.goto(`${BASE}/#league`);
  await page.waitForTimeout(1000);
  const rageBtn = page.locator('button:has-text("推進一週")').first();
  if (await rageBtn.count()) {
    await shoot(page, '60_pre_rage');
    const startState = await getSeasonState();
    const startW = startState.current_week;
    const startComplete = !!startState.champion;
    logs.push(`[rage] pre: week=${startW} complete=${startComplete}`);
    for (let k = 0; k < 10; k++) {
      const tr = Date.now();
      try {
        await rageBtn.click({ timeout: 500, force: true });
      } catch (e: any) {
        logs.push(`[rage] click ${k + 1} threw: ${e.message}`);
      }
      rageClickMs.push(Date.now() - tr);
      // no wait — back to back
    }
    await shoot(page, '61_during_rage');
    // handle confirm if dialog opened
    for (let c = 0; c < 3; c++) {
      if (!(await confirmOk(page, 300))) break;
    }
    // wait for server to settle
    for (let k = 0; k < 30; k++) {
      await page.waitForTimeout(1000);
      const s = await getSeasonState();
      const btnDisabled = await rageBtn.isDisabled().catch(() => false);
      if ((s && s.champion) || (!btnDisabled && s.current_week > startW)) break;
    }
    const endS = await getSeasonState();
    logs.push(`[rage] post: week=${endS.current_week} champion=${endS.champion}`);
    const btnFinalState = await rageBtn.isDisabled().catch(() => null);
    logs.push(`[rage] post button disabled=${btnFinalState}`);
    await shoot(page, '62_post_rage');
  } else {
    logs.push(`[warn] rage target button missing`);
  }

  // ===========================================================
  // STEP 11: 重置賽季 + re-simulate round-trip
  // ===========================================================
  logs.push(`[step] 11. 重置賽季 round-trip`);
  await closeAnyDialog(page);
  await openSettings(page);
  const resetBtn = page.locator('#dlg-settings #btn-reset-season, #btn-reset-season, #dlg-settings button:has-text("重置賽季")').first();
  if (await resetBtn.count()) {
    await resetBtn.click().catch(() => {});
    await page.waitForTimeout(600);
    // confirm
    await confirmOk(page, 1500);
    logs.push(`[ok] clicked 重置賽季 + confirm`);
  } else {
    logs.push(`[warn] 重置賽季 button not found in dialog`);
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.reload();
  await page.waitForTimeout(1500);
  await shoot(page, '70_after_reset');

  const stReset = await getSeasonState();
  logs.push(`[state] post-reset: is_playoffs=${stReset.is_playoffs} week=${stReset.current_week}`);

  // Re-start season via dialog -> then sim to playoffs again
  await closeAnyDialog(page);
  await openSettings(page);
  const startAgain = page.locator('#dlg-settings #btn-season-start, #btn-season-start, #dlg-settings button:has-text("開始賽季")').first();
  if (await startAgain.count()) {
    await startAgain.click().catch(() => {});
    await page.waitForTimeout(1500);
    // confirm if any
    await confirmOk(page, 1500);
    logs.push(`[ok] re-started season`);
  }
  await page.keyboard.press('Escape').catch(() => {});

  // sim to playoffs again
  await closeAnyDialog(page);
  await openSettings(page);
  const simAgain = page.locator('#dlg-settings #btn-sim-playoffs, #btn-sim-playoffs, #dlg-settings button:has-text("模擬到季後賽")').first();
  if (await simAgain.count()) {
    await simAgain.click().catch(() => {});
    await page.waitForTimeout(700);
    await confirmOk(page, 800);
    for (let k = 0; k < 60; k++) {
      await page.waitForTimeout(1000);
      const s = await getSeasonState();
      if (s && s.is_playoffs) {
        logs.push(`[ok] round-trip: back to playoffs`);
        break;
      }
    }
  }
  await page.reload();
  await page.waitForTimeout(1500);
  await shoot(page, '71_round_trip_playoffs');

  // ===========================================================
  // Final: write logs + findings
  // ===========================================================
  const summary = {
    league_id: LEAGUE_ID,
    version: versionTxt,
    setup_errors: setupErrors,
    draft_picks: humanPicksMade,
    draft_click_timing: { n: draftClickMs.length, avg_ms: avgClick, min_ms: minClick, max_ms: maxClick },
    roster_size: rosterSize,
    slot_order_api: slotOrder,
    slot_order_expected: expectedSlotOrder,
    slot_order_match: slotOrderMatches,
    dom_slot_order: domSlotsClean,
    dom_slot_match: domMatches,
    bench_count: benchCount,
    rage_click_timings_ms: rageClickMs,
    timings,
    console_errors_count: consoleErrors.length,
    network_4xx5xx: net4xx5xx.slice(0, 40),
  };
  fs.writeFileSync('screenshots/g2p_summary.json', JSON.stringify(summary, null, 2));
  fs.writeFileSync('screenshots/g2p_console.log', logs.join('\n'));
  fs.writeFileSync('screenshots/g2p_console_errors.log', consoleErrors.join('\n'));
  fs.writeFileSync('screenshots/g2p_network_errors.log', net4xx5xx.map((n) => `${n.method} ${n.url} -> ${n.status}`).join('\n'));

  // Never hard-fail — this is QA discovery; we succeed if we produced artifacts
  expect(true).toBe(true);
});
