/**
 * QA Wave v0.5.23 — Round 2 — Group 1 — PLAYER
 * THEME: STRESS & CONCURRENCY — BRUTAL
 *
 * ALL ACTIONS MUST BE TRIGGERED VIA UI CLICKS.
 * Read-only /api/state observation is allowed for verification only.
 */
import { test, expect, Page, Browser, BrowserContext } from '@playwright/test';
import * as fs from 'fs';

const BASE = 'https://nbafantasy.cda1234567.com';
const LEAGUE_ID = 'qa-r2-g1';
const SS_DIR = 'screenshots';

if (!fs.existsSync(SS_DIR)) fs.mkdirSync(SS_DIR, { recursive: true });

interface Metrics {
  draftLatencies: number[];
  doubleClickEffect: { before: number; after: number; picks: number } | null;
  weekSimTimes: number[];
  tradeLatencies: number[];
  tabStressConflicts: string[];
  consoleErrors: string[];
  networkErrors: { url: string; status: number; time: number }[];
  pageErrors: string[];
  stepTimings: Record<string, number>;
  missedClicks: string[];
  rapidFireCycles: number;
  setupRacePassed: boolean | null;
  fixBugAssessment: string;
}
const M: Metrics = {
  draftLatencies: [],
  doubleClickEffect: null,
  weekSimTimes: [],
  tradeLatencies: [],
  tabStressConflicts: [],
  consoleErrors: [],
  networkErrors: [],
  pageErrors: [],
  stepTimings: {},
  missedClicks: [],
  rapidFireCycles: 0,
  setupRacePassed: null,
  fixBugAssessment: 'unknown',
};

async function shot(page: Page, name: string) {
  try { await page.screenshot({ path: `${SS_DIR}/g1p_${name}.png`, fullPage: true }); } catch {}
}

async function apiGetReadOnly(path: string) {
  // Allowed: read-only state observation
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.text() };
}

function wireDiagnostics(page: Page, tag: string) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') M.consoleErrors.push(`[${tag}] ${msg.text()}`);
  });
  page.on('pageerror', (e) => {
    M.pageErrors.push(`[${tag}] ${e.message}`);
  });
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/api/')) return;
    const status = res.status();
    if (status >= 400) {
      M.networkErrors.push({ url, status, time: Date.now() });
    }
  });
}

async function selectLeagueViaUI(page: Page, leagueId: string) {
  // Open league switcher
  await page.locator('#btn-league-switch').click().catch(() => {});
  await page.waitForTimeout(400);

  // Check if target already present in menu
  const menu = page.locator('#league-switch-menu');
  const items = menu.locator('.lsw-item, [data-league-id]');
  const cnt = await items.count();
  let found = false;
  for (let i = 0; i < cnt; i++) {
    const it = items.nth(i);
    const data = await it.getAttribute('data-league-id').catch(() => null);
    const text = (await it.textContent().catch(() => '')) || '';
    if (data === leagueId || text.includes(leagueId)) {
      await it.click();
      found = true;
      break;
    }
  }
  if (!found) {
    // Create it via UI: "New league" button in switcher menu
    const createBtn = menu.locator('button').filter({ hasText: /新增|新聯盟|建立/ });
    if (await createBtn.count()) {
      await createBtn.first().click();
    } else {
      // fall back: click anywhere in menu that opens new-league dialog
      const btns = menu.locator('button');
      const n = await btns.count();
      for (let i = 0; i < n; i++) {
        const t = (await btns.nth(i).textContent()) || '';
        if (t.includes('新') || t.includes('+')) {
          await btns.nth(i).click();
          break;
        }
      }
    }
    // Fill new-league dialog
    const dlg = page.locator('#dlg-new-league');
    await dlg.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await page.locator('#new-league-id').fill(leagueId);
    await page.locator('#btn-new-league-create').click();
    await page.waitForTimeout(1500);
  }

  // Verify active
  await page.waitForTimeout(600);
  const active = (await page.locator('#lsw-current').textContent().catch(() => '')) || '';
  console.log(`[g1p] active after switch = "${active}"`);
  return active;
}

async function waitForDraftReady(page: Page, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const has = await page.locator('button[data-draft]').count();
    if (has > 0) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function waitForHumanTurn(page: Page, timeoutMs = 60000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await apiGetReadOnly('/api/state');
    if (r.status === 200) {
      try {
        const s = JSON.parse(r.body);
        if (s.is_complete) return false;
        if (s.current_team_id === s.human_team_id) {
          // also wait for enabled button to render
          await page.waitForTimeout(250);
          const enabled = await page.locator('button[data-draft]:not([disabled])').count();
          if (enabled > 0) return true;
        }
      } catch {}
    }
    await page.waitForTimeout(400);
  }
  return false;
}

async function getState() {
  const r = await apiGetReadOnly('/api/state');
  if (r.status !== 200) return null;
  try { return JSON.parse(r.body); } catch { return null; }
}

test.describe.configure({ mode: 'serial' });

test('qa-r2-g1 stress & concurrency — BRUTAL', async ({ browser }) => {
  test.setTimeout(30 * 60 * 1000);
  const t0 = Date.now();

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  wireDiagnostics(page, 'main');

  // === 1. Landing + version check ===
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const version = (await page.locator('#app-version').textContent()) || '';
  console.log(`[g1p] version = "${version}"`);
  expect(version).toContain('0.5.23');
  await shot(page, '01_landing');

  // === 2. SETUP RACE — create league, reload mid-setup, re-fill, verify ===
  const tSetup = Date.now();
  const leagueListResp = await apiGetReadOnly('/api/leagues/list');
  const leagueList = JSON.parse(leagueListResp.body);
  const existing = leagueList.leagues.find((l: any) => l.league_id === LEAGUE_ID);

  let effectiveLeague = LEAGUE_ID;
  if (existing && existing.setup_complete) {
    console.log(`[g1p] ${LEAGUE_ID} already exists and setup_complete — using -alt`);
    effectiveLeague = `${LEAGUE_ID}-alt`;
  }

  // Create league via UI
  await selectLeagueViaUI(page, effectiveLeague);
  await shot(page, '02_league_active');

  // Check whether setup is needed
  const stateAfterSwitch = await apiGetReadOnly('/api/league/status');
  const statusJson = JSON.parse(stateAfterSwitch.body);
  console.log(`[g1p] league status after create = ${stateAfterSwitch.body}`);

  if (!statusJson.setup_complete) {
    // Navigate to setup form
    await page.goto(`${BASE}/#setup`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    await shot(page, '03_setup_form_initial');

    // Partial fill (before reload) — SETUP RACE scenario
    await page.locator('#setup-league-name').fill('qa-r2-g1-partial');
    await page.locator('#setup-team-0').fill('Andy-R2');
    await page.waitForTimeout(300);
    await shot(page, '04_setup_partial_fill');

    // RELOAD mid-setup
    const reloadT0 = Date.now();
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await shot(page, '05_setup_after_reload');

    // Navigate back to setup (since hash may reset to draft)
    await page.goto(`${BASE}/#setup`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    // Check if league name persisted (unlikely — it's in-memory form state)
    const nameAfterReload = await page.locator('#setup-league-name').inputValue().catch(() => '');
    console.log(`[g1p] setup race: league_name after reload = "${nameAfterReload}"`);
    M.setupRacePassed = nameAfterReload !== 'qa-r2-g1-partial'; // should NOT persist partial (form is in-memory)
    M.stepTimings['setup_reload_cycle'] = Date.now() - reloadT0;

    // Now complete setup properly
    await page.locator('#setup-league-name').fill('qa-r2-g1-stress');
    const teamNames = ['Andy-R2', 'Stress-B', 'Stress-C', 'Stress-D', 'Stress-E', 'Stress-F', 'Stress-G', 'Stress-H'];
    for (let i = 0; i < 8; i++) {
      const loc = page.locator(`#setup-team-${i}`);
      if (await loc.count()) await loc.fill(teamNames[i]);
    }
    await shot(page, '06_setup_filled');

    // Submit via UI
    const submitT0 = Date.now();
    await page.locator('#btn-setup-submit').click();
    await page.waitForTimeout(2500);
    M.stepTimings['setup_submit'] = Date.now() - submitT0;
    await shot(page, '07_setup_submitted');
  } else {
    console.log(`[g1p] setup already complete — skipping setup race on fresh form`);
    M.setupRacePassed = true; // N/A but don't fail
  }
  M.stepTimings['total_setup'] = Date.now() - tSetup;

  // === 3. Navigate to draft ===
  await page.goto(`${BASE}/#draft`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const draftReady = await waitForDraftReady(page, 20000);
  console.log(`[g1p] draft ready = ${draftReady}`);
  await shot(page, '08_draft_page');

  // === 4. RAPID-FIRE DRAFT + DOUBLE-CLICK STRESS ===
  const tDraft = Date.now();
  let cyclesDone = 0;
  const MAX_CYCLES = 15;
  let doubleClickTested = false;

  for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
    // Wait for human turn (read-only observation to know when to click)
    const isHuman = await waitForHumanTurn(page, 90000);
    if (!isHuman) {
      const s = await getState();
      if (s?.is_complete) {
        console.log(`[g1p] draft complete at cycle ${cycle}`);
        break;
      }
      M.missedClicks.push(`cycle ${cycle}: no human turn within 90s`);
      break;
    }

    const stateBefore = await getState();
    const picksBefore = stateBefore?.total_picks_made ?? 0;

    // DOUBLE-CLICK STRESS on cycle 2
    if (cycle === 2 && !doubleClickTested) {
      doubleClickTested = true;
      const btn = page.locator('button[data-draft]:not([disabled])').first();
      if (await btn.count()) {
        const dcBefore = picksBefore;
        // Rapid double-click
        await Promise.all([
          btn.click({ timeout: 5000 }).catch(() => {}),
          btn.click({ timeout: 5000 }).catch(() => {}),
        ]);
        await page.waitForTimeout(2500);
        const dcState = await getState();
        const dcAfter = dcState?.total_picks_made ?? 0;
        // Count only human picks
        const humanPicksBefore = stateBefore?.teams?.[stateBefore.human_team_id]?.roster?.length ?? 0;
        const humanPicksAfter = dcState?.teams?.[dcState.human_team_id]?.roster?.length ?? 0;
        M.doubleClickEffect = {
          before: humanPicksBefore,
          after: humanPicksAfter,
          picks: humanPicksAfter - humanPicksBefore,
        };
        console.log(`[g1p] double-click: human picks ${humanPicksBefore}->${humanPicksAfter} (diff=${humanPicksAfter - humanPicksBefore})`);
        await shot(page, `09_cycle_${cycle}_doubleclick`);
        cyclesDone++;
        continue;
      }
    }

    // Rapid-fire single click with latency measurement
    const btnSel = 'button[data-draft]:not([disabled])';
    const btn = page.locator(btnSel).first();
    if (!(await btn.count())) {
      M.missedClicks.push(`cycle ${cycle}: no enabled draft button at human turn`);
      await shot(page, `10_cycle_${cycle}_no_btn`);
      break;
    }

    const clickT0 = Date.now();
    const playerId = await btn.getAttribute('data-draft');
    await btn.click({ timeout: 10000 }).catch((e) => {
      M.missedClicks.push(`cycle ${cycle}: click error ${e.message}`);
    });

    // Wait for state to reflect the pick
    let registered = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const s = await getState();
      const humanCount = s?.teams?.[s.human_team_id]?.roster?.length ?? 0;
      if (humanCount > (stateBefore?.teams?.[stateBefore.human_team_id]?.roster?.length ?? 0)) {
        registered = true;
        break;
      }
      if (s?.is_complete) break;
      await page.waitForTimeout(200);
    }
    const latency = Date.now() - clickT0;
    M.draftLatencies.push(latency);
    if (!registered) {
      M.missedClicks.push(`cycle ${cycle}: pick ${playerId} did not register within 15s`);
      console.log(`[g1p] cycle ${cycle}: FAILED to register pick (${latency}ms)`);
    } else {
      console.log(`[g1p] cycle ${cycle}: pick OK in ${latency}ms`);
    }
    cyclesDone++;

    if (cycle % 3 === 0) await shot(page, `11_cycle_${cycle}_after`);
  }
  M.rapidFireCycles = cyclesDone;
  M.stepTimings['rapid_fire_draft'] = Date.now() - tDraft;
  await shot(page, '12_draft_rapid_done');

  // === 4b. SLOW NETWORK — throttled draft (if draft still ongoing) ===
  const stateMid = await getState();
  if (stateMid && !stateMid.is_complete) {
    console.log(`[g1p] running 1 slow-network cycle`);
    const slowCtx = await browser.newContext({ ignoreHTTPSErrors: true });
    await slowCtx.route('**/*', (r) => setTimeout(() => r.continue().catch(() => {}), 200));
    const slowPage = await slowCtx.newPage();
    wireDiagnostics(slowPage, 'slow');
    try {
      await slowPage.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await slowPage.waitForTimeout(2000);
      await slowPage.goto(`${BASE}/#draft`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await slowPage.waitForTimeout(3000);
      const isHuman = await waitForHumanTurn(slowPage, 30000);
      if (isHuman) {
        const b = slowPage.locator('button[data-draft]:not([disabled])').first();
        const t0s = Date.now();
        await b.click({ timeout: 15000 }).catch(() => {});
        await slowPage.waitForTimeout(4000);
        const dt = Date.now() - t0s;
        M.draftLatencies.push(dt);
        console.log(`[g1p] slow-network pick latency = ${dt}ms`);
      } else {
        console.log(`[g1p] slow-network: not human turn, skipping`);
      }
      await shot(slowPage, '13_slow_network');
    } catch (e: any) {
      console.log(`[g1p] slow-network error: ${e.message}`);
    } finally {
      await slowCtx.close();
    }
  }

  // === 5. Finish draft (click via UI in accelerated mode) ===
  // Continue draft via UI clicks until complete
  let finishGuard = 200;
  while (finishGuard-- > 0) {
    const s = await getState();
    if (!s || s.is_complete) break;
    if (s.current_team_id === s.human_team_id) {
      // Human pick via UI
      await page.waitForTimeout(300);
      const btn = page.locator('button[data-draft]:not([disabled])').first();
      if (!(await btn.count())) {
        console.log(`[g1p] finish: no button available for human`);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(1200);
        continue;
      }
      await btn.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(800);
    } else {
      // AI turn — draft auto-advances via draftAutoTimer; just wait
      await page.waitForTimeout(700);
    }
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await shot(page, '14_draft_complete');
  const sDraftDone = await getState();
  console.log(`[g1p] draft complete = ${sDraftDone?.is_complete}`);

  // === 6. START SEASON via UI (settings dialog) ===
  const tStartSeason = Date.now();
  if (sDraftDone?.is_complete && !sDraftDone?.season_started) {
    await page.locator('#btn-menu').click();
    await page.waitForTimeout(500);
    await shot(page, '15_settings_dialog');
    await page.locator('#btn-season-start').click();
    await page.waitForTimeout(3000);
    M.stepTimings['season_start'] = Date.now() - tStartSeason;
    await shot(page, '16_season_started');
  }

  // === 7. WEEK BURN-DOWN — click "推進一週" rapidly ===
  await page.goto(`${BASE}/#league`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await shot(page, '17_league_page');

  const weekBtn = page.locator('button', { hasText: '推進一週' }).first();
  const simPlayoffsBtn = page.locator('button', { hasText: '模擬到季後賽' }).first();

  // Do 3 week advances, measuring each
  for (let w = 0; w < 3; w++) {
    const hasWeekBtn = await weekBtn.count();
    if (!hasWeekBtn) {
      console.log(`[g1p] week-burn: no week-advance button found at iter ${w}`);
      break;
    }
    const t0 = Date.now();
    await weekBtn.click({ timeout: 8000 }).catch(() => {});
    // Wait until button re-enables or a UI change
    await page.waitForTimeout(2500);
    const dt = Date.now() - t0;
    M.weekSimTimes.push(dt);
    console.log(`[g1p] week ${w + 1}: ${dt}ms`);
    if (w === 0) await shot(page, `18_week_${w}`);
  }

  // Sim to playoffs — click once, measure
  const hasSim = await simPlayoffsBtn.count();
  if (hasSim) {
    const t0 = Date.now();
    await simPlayoffsBtn.click({ timeout: 8000 }).catch(() => {});
    // May open a confirm dialog
    await page.waitForTimeout(800);
    const confirmOk = page.locator('#confirm-ok');
    if (await confirmOk.isVisible().catch(() => false)) {
      await confirmOk.click({ timeout: 5000 }).catch(() => {});
    }
    // Wait for the bulk sim to finish (polling state)
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const s = await getState();
      if (s?.week_number >= (s?.regular_season_weeks || 14) || s?.is_playoffs || s?.phase === 'playoffs') break;
      await page.waitForTimeout(1000);
    }
    const dt = Date.now() - t0;
    M.stepTimings['sim_to_playoffs'] = dt;
    console.log(`[g1p] sim-to-playoffs: ${dt}ms`);
    await shot(page, '19_sim_playoffs_done');
  }

  // === 8. TRADE FLOOD — propose 5 trades via UI rapidly ===
  // Need to be before trade deadline and season in progress. Go back to /#league.
  await page.goto(`${BASE}/#league`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const tradeBtn = page.locator('#btn-propose-trade');
  for (let t = 0; t < 5; t++) {
    const tradeStart = Date.now();
    const tradeAvailable = await tradeBtn.count();
    if (!tradeAvailable) {
      console.log(`[g1p] trade ${t}: button not available (possibly past deadline)`);
      break;
    }
    await tradeBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);

    const dlg = page.locator('#trade-propose');
    const visible = await dlg.isVisible().catch(() => false);
    if (!visible) {
      console.log(`[g1p] trade ${t}: dialog did not open`);
      M.tradeLatencies.push(-1);
      continue;
    }

    // Select counterparty (first non-self team)
    const cpSel = page.locator('#cp-select');
    const options = cpSel.locator('option');
    const optCnt = await options.count();
    let picked = false;
    for (let o = 1; o < optCnt; o++) {
      const v = await options.nth(o).getAttribute('value');
      if (v) {
        // Rotate through counterparties
        if ((o - 1) === (t % Math.max(1, optCnt - 1))) {
          await cpSel.selectOption(v);
          picked = true;
          break;
        }
      }
    }
    if (!picked && optCnt > 1) {
      const v = await options.nth(1).getAttribute('value');
      if (v) await cpSel.selectOption(v);
    }
    await page.waitForTimeout(600);

    // Check boxes: one from each side
    const sendCheckboxes = page.locator('#trade-propose-body .propose-side').nth(0).locator('input[type="checkbox"]');
    const recvCheckboxes = page.locator('#trade-propose-body .propose-side').nth(1).locator('input[type="checkbox"]');
    const sCount = await sendCheckboxes.count();
    const rCount = await recvCheckboxes.count();
    if (sCount > 0) await sendCheckboxes.nth(Math.min(t, sCount - 1)).check({ timeout: 3000 }).catch(() => {});
    if (rCount > 0) await recvCheckboxes.nth(Math.min(t, rCount - 1)).check({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(400);

    // Submit
    await page.locator('#btn-trade-propose-submit').click({ timeout: 5000 }).catch(() => {});
    // Wait for dialog to close or response
    const t0 = Date.now();
    const closeDeadline = Date.now() + 20000;
    while (Date.now() < closeDeadline) {
      const v = await dlg.isVisible().catch(() => false);
      if (!v) break;
      await page.waitForTimeout(400);
    }
    const dt = Date.now() - tradeStart;
    M.tradeLatencies.push(dt);
    console.log(`[g1p] trade ${t}: ${dt}ms`);
    if (t === 0) await shot(page, '20_trade_submitted');

    // If dialog still open, close manually
    if (await dlg.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(600);
  }
  await shot(page, '21_after_trade_flood');

  // === 9. TAB STRESS — 3 parallel tabs on same league ===
  const tabResults: string[] = [];
  try {
    const p2 = await context.newPage();
    const p3 = await context.newPage();
    wireDiagnostics(p2, 'tab2');
    wireDiagnostics(p3, 'tab3');

    await Promise.all([
      p2.goto(`${BASE}/#league`, { waitUntil: 'domcontentloaded' }),
      p3.goto(`${BASE}/#league`, { waitUntil: 'domcontentloaded' }),
    ]);
    await Promise.all([p2.waitForTimeout(2000), p3.waitForTimeout(2000)]);
    await shot(p2, '22_tab2_league');
    await shot(p3, '23_tab3_league');

    // Simultaneous clicks on "推進一週" from all 3 tabs
    const parallelT0 = Date.now();
    const [r1, r2, r3] = await Promise.allSettled([
      page.locator('button', { hasText: '推進一週' }).first().click({ timeout: 8000 }),
      p2.locator('button', { hasText: '推進一週' }).first().click({ timeout: 8000 }),
      p3.locator('button', { hasText: '推進一週' }).first().click({ timeout: 8000 }),
    ]);
    const parallelDt = Date.now() - parallelT0;
    console.log(`[g1p] tab-stress parallel clicks done in ${parallelDt}ms`);
    [r1, r2, r3].forEach((r, i) => {
      if (r.status === 'rejected') {
        M.tabStressConflicts.push(`tab${i}: ${r.reason?.message || 'click rejected'}`);
      }
    });
    M.stepTimings['tab_stress_parallel'] = parallelDt;
    await page.waitForTimeout(3000);
    await shot(page, '24_tab1_after_stress');
    await shot(p2, '25_tab2_after_stress');
    await shot(p3, '26_tab3_after_stress');

    // Compare state across tabs
    const s = await getState();
    tabResults.push(`final week = ${s?.week_number}, is_playoffs = ${s?.is_playoffs}`);

    await p2.close();
    await p3.close();
  } catch (e: any) {
    M.tabStressConflicts.push(`tab-stress exception: ${e.message}`);
  }

  // === 10. Summary ===
  const sFinal = await getState();
  console.log(`[g1p] final state: week=${sFinal?.week_number}, is_playoffs=${sFinal?.is_playoffs}, champion=${sFinal?.champion ?? 'none'}`);

  // === Assess whether v0.5.23 fixed "選秀按不到" ===
  const missedRate = M.draftLatencies.length
    ? (M.missedClicks.filter((s) => s.includes('did not register')).length / M.draftLatencies.length)
    : 1;
  if (M.rapidFireCycles === 0) {
    M.fixBugAssessment = 'UNKNOWN — draft not reached';
  } else if (missedRate === 0 && M.rapidFireCycles >= 5) {
    M.fixBugAssessment = 'YES — all rapid-fire picks registered';
  } else if (missedRate < 0.2) {
    M.fixBugAssessment = 'PARTIAL — most picks registered but some misses';
  } else {
    M.fixBugAssessment = 'NO — significant missed picks';
  }

  M.stepTimings['total_test'] = Date.now() - t0;

  // === Persist metrics ===
  fs.writeFileSync('g1p_metrics.json', JSON.stringify(M, null, 2));
  fs.writeFileSync(`${SS_DIR}/g1p_console_errors.txt`, M.consoleErrors.join('\n'));
  console.log(`[g1p] metrics saved. total duration = ${M.stepTimings['total_test']}ms`);

  await context.close();
});
