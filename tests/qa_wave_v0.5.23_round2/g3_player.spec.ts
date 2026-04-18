import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';

const BASE = 'https://nbafantasy.cda1234567.com';
const LEAGUE_ID = 'qa-r2-g3';
const SHOT = (n: string) => `screenshots/g3p_${n}.png`;
const LOGFILE = 'screenshots/g3p_console.log';

type LogEntry = string;
const logs: LogEntry[] = [];
const pushLog = (s: string) => {
  const line = `[${new Date().toISOString()}] ${s}`;
  logs.push(line);
};
function flushLogs() {
  try { fs.writeFileSync(LOGFILE, logs.join('\n')); } catch {}
}

async function shoot(page: Page, name: string, full = true) {
  try { await page.screenshot({ path: SHOT(name), fullPage: full }); }
  catch (e) { pushLog(`[warn] shoot ${name} failed: ${String(e).slice(0, 200)}`); }
}

async function readState(page: Page): Promise<any> {
  return page.evaluate(async () => {
    try { return await (await fetch('/api/state')).json(); } catch { return null; }
  });
}
async function readTeam(page: Page, tid: number): Promise<any> {
  return page.evaluate(async (id) => {
    try { return await (await fetch(`/api/teams/${id}`)).json(); } catch { return null; }
  }, tid);
}
async function readTrades(page: Page): Promise<any> {
  return page.evaluate(async () => {
    try { return await (await fetch('/api/trades')).json(); } catch { return null; }
  });
}
async function readLogsFeed(page: Page): Promise<any> {
  return page.evaluate(async () => {
    try { return await (await fetch('/api/logs')).json(); } catch { return null; }
  });
}
async function readFaQuota(page: Page): Promise<any> {
  return page.evaluate(async () => {
    try { return await (await fetch('/api/fa/claim-status')).json(); } catch { return null; }
  });
}

async function clickTimed(page: Page, sel: string, label: string) {
  const t0 = Date.now();
  try {
    await page.locator(sel).first().click({ timeout: 10000 });
    pushLog(`[click ${Date.now() - t0}ms OK] ${label} (${sel})`);
    return true;
  } catch (e) {
    pushLog(`[click ${Date.now() - t0}ms FAIL] ${label} (${sel}): ${String(e).slice(0, 200)}`);
    return false;
  }
}

async function captureToasts(page: Page, tag: string) {
  try {
    const toasts = await page.locator('#toast-stack').innerText().catch(() => '');
    if (toasts) pushLog(`[toast ${tag}] ${toasts.replace(/\n/g, ' | ').slice(0, 500)}`);
  } catch {}
}

test.setTimeout(40 * 60 * 1000);

test('g3 player: trade + FA flood UI-only', async ({ page }) => {
  page.on('console', (m) => pushLog(`[console.${m.type()}] ${m.text().slice(0, 400)}`));
  page.on('pageerror', (e) => pushLog(`[pageerror] ${e.message.slice(0, 400)}`));
  page.on('requestfailed', (r) => {
    const url = r.url();
    if (!url.includes('cdn-cgi') && !url.includes('analytics')) {
      pushLog(`[requestfailed] ${r.method()} ${url} :: ${r.failure()?.errorText || ''}`);
    }
  });

  // =============================================================== 1. OPEN
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const ver = await page.locator('#app-version').innerText().catch(() => '');
  pushLog(`[debug] version chip text=${ver}`);
  expect(ver).toContain('0.5.23');
  await shoot(page, '01_home');

  // =============================================================== 2. LEAGUE CREATE (UI)
  // hamburger → in this build, the settings dialog has no "new league" button
  // but the league-switcher has a "+ 建立新聯盟" item in the menu.
  await clickTimed(page, '#btn-league-switch', 'open league switcher');
  await page.waitForTimeout(500);
  await shoot(page, '02_league_menu');
  const menu = page.locator('#league-switch-menu');
  const menuText = await menu.innerText().catch(() => '');
  pushLog(`[debug] switch menu text=${menuText.slice(0, 300)}`);

  const newLeagueTrigger = menu.locator('#btn-lsw-new, button:has-text("建立"), a:has-text("建立"), button:has-text("新增"), button:has-text("+")').first();
  let createdViaUI = false;
  if (await newLeagueTrigger.count()) {
    await newLeagueTrigger.click({ timeout: 8000 }).catch(() => null);
    await page.waitForTimeout(600);
    const dlg = page.locator('#dlg-new-league');
    if (await dlg.isVisible().catch(() => false)) {
      await page.locator('#new-league-id').fill(LEAGUE_ID);
      await shoot(page, '03_new_league_form');
      await clickTimed(page, '#btn-new-league-create', 'create league submit');
      await page.waitForTimeout(2500);
      await captureToasts(page, 'after-create');
      createdViaUI = true;
    }
  }
  pushLog(`[debug] league created via UI=${createdViaUI}`);

  // Attempt UI switch (click league in switch menu). If the league menu doesn't
  // list it (rare race), reload so the switcher refreshes; setup view will
  // appear automatically because the app auto-routes new leagues to #setup.
  await page.waitForTimeout(1000);
  await shoot(page, '04_after_create');

  // Verify switched (read-only fetch)
  const st0 = await page.evaluate(async () => {
    try { return (await (await fetch('/api/leagues/current')).json()); } catch { return null; }
  });
  pushLog(`[debug] current league=${JSON.stringify(st0).slice(0, 300)}`);

  // =============================================================== 3. SETUP
  // If we are not already on the setup view, the app will auto-redirect.
  await page.waitForTimeout(800);
  const routeNow = await page.evaluate(() => location.hash);
  pushLog(`[debug] route after create=${routeNow}`);
  if (!routeNow.includes('setup')) {
    // The league may already have been setup (if pre-existing); check status.
    const status = await page.evaluate(async () => {
      try { return await (await fetch('/api/league/status')).json(); } catch { return null; }
    });
    pushLog(`[debug] league status=${JSON.stringify(status).slice(0, 300)}`);
  }

  // Try to find setup submit button (only present when on setup view)
  const setupBtn = page.locator('#btn-setup-submit');
  if (await setupBtn.count()) {
    await shoot(page, '05_setup_page');
    await clickTimed(page, '#btn-setup-submit', 'submit setup (default values)');
    await page.waitForTimeout(3000);
    await captureToasts(page, 'after-setup');
    await shoot(page, '06_setup_done');
  } else {
    pushLog('[debug] no setup button — league likely already setup');
  }

  // =============================================================== 4. DRAFT (UI)
  await page.goto(`${BASE}/#draft`);
  await page.waitForTimeout(1500);
  await shoot(page, '10_draft_initial');

  const pickClickTimes: number[] = [];
  let humanClicks = 0;
  let simToMeClicks = 0;

  for (let iter = 0; iter < 600; iter++) {
    const s = await readState(page);
    if (!s) break;
    if (s.is_complete) {
      pushLog(`[debug] draft complete at iter=${iter} pickClicks=${humanClicks}`);
      break;
    }
    const myTurn = s.current_team_id === s.human_team_id;
    if (myTurn) {
      // Prefer UI button[data-draft] in the available table
      const btn = page.locator('button[data-draft]').first();
      if (await btn.count().catch(() => 0)) {
        const t0 = Date.now();
        try {
          await btn.scrollIntoViewIfNeeded({ timeout: 2000 });
          await btn.click({ timeout: 8000 });
          const took = Date.now() - t0;
          pickClickTimes.push(took);
          humanClicks++;
          if (humanClicks <= 3) await shoot(page, `11_pick_${humanClicks}`);
          pushLog(`[click ${took}ms] draft pick #${humanClicks}`);
          await page.waitForTimeout(350);
        } catch (e) {
          pushLog(`[warn] pick click err: ${String(e).slice(0, 160)}`);
          await page.waitForTimeout(500);
        }
      } else {
        pushLog('[warn] no data-draft btn on human turn');
        await page.waitForTimeout(500);
      }
    } else {
      // AI turn → click "⏭ 模擬到我" button if available
      const simBtn = page.locator('button.primary:has-text("模擬到我")').first();
      if (await simBtn.count().catch(() => 0) && await simBtn.isEnabled().catch(() => false)) {
        const ok = await simBtn.click({ timeout: 8000 }).then(() => true).catch(() => false);
        if (ok) {
          simToMeClicks++;
          pushLog(`[click] 模擬到我 #${simToMeClicks}`);
          await page.waitForTimeout(1200);
        } else {
          await page.waitForTimeout(400);
        }
      } else {
        // No sim-to-me visible (disabled or draft finished) — just wait a bit
        await page.waitForTimeout(400);
      }
    }
  }
  await page.reload();
  await page.waitForTimeout(1500);
  await shoot(page, '12_draft_done');
  pushLog(`[summary] draft: humanClicks=${humanClicks}, simToMeClicks=${simToMeClicks}, avgPickClickMs=${pickClickTimes.length ? Math.round(pickClickTimes.reduce((a, b) => a + b, 0) / pickClickTimes.length) : 0}`);

  // =============================================================== 5. START SEASON (UI)
  // Open hamburger → settings dialog → "開始" button
  await clickTimed(page, '#btn-menu', 'open settings dialog');
  await page.waitForTimeout(500);
  await shoot(page, '20_settings_open');
  await clickTimed(page, '#btn-season-start', 'click 開始賽季');
  await page.waitForTimeout(3500);
  await captureToasts(page, 'after-season-start');
  await shoot(page, '21_season_started');

  // =============================================================== 6. ADVANCE 3 WEEKS (UI)
  await page.goto(`${BASE}/#league`);
  await page.waitForTimeout(1800);
  await shoot(page, '22_league_view');
  for (let w = 1; w <= 3; w++) {
    const advBtn = page.locator('button:has-text("推進一週")').first();
    if (await advBtn.count()) {
      const t0 = Date.now();
      const ok = await advBtn.click({ timeout: 15000 }).then(() => true).catch((e) => {
        pushLog(`[warn] advance week ${w} err: ${String(e).slice(0, 160)}`);
        return false;
      });
      pushLog(`[click ${Date.now() - t0}ms] 推進一週 wk${w} ok=${ok}`);
      // The advance-week progress UI streams; give it time.
      await page.waitForTimeout(15000);
      await captureToasts(page, `after-wk${w}`);
      await shoot(page, `23_after_wk${w}`);
    } else {
      pushLog(`[warn] 推進一週 button missing at week ${w}`);
    }
  }

  // =============================================================== 7. TRADE FLOOD (UI)
  const stPreTrade = await readState(page);
  const humanId = stPreTrade?.human_team_id ?? 0;
  const aiTeams = (stPreTrade?.teams || []).filter((t: any) => t.id !== humanId);
  pushLog(`[debug] humanId=${humanId}, aiTeams=${aiTeams.length}`);

  const preHumanRoster = (await readTeam(page, humanId))?.players || [];
  pushLog(`[debug] pre-trade human roster size=${preHumanRoster.length}`);

  interface TradeAttempt {
    idx: number;
    counterpartyId: number | null;
    counterpartyName: string;
    sendNames: string[];
    receiveNames: string[];
    force: boolean;
    lopsided: boolean;
    submitClickMs: number;
    toastSeen: string;
    outcomeAfterMs: any;
  }
  const tradeAttempts: TradeAttempt[] = [];

  async function openProposeDialog(tag: string): Promise<boolean> {
    await page.goto(`${BASE}/#league`);
    await page.waitForTimeout(1500);
    // Navigate to trades sub-tab if needed
    const tradeTab = page.locator('.league-subtabs button:has-text("交易"), [data-subtab="trades"], a:has-text("交易")').first();
    if (await tradeTab.count().catch(() => 0)) {
      await tradeTab.click({ timeout: 6000 }).catch(() => null);
      await page.waitForTimeout(700);
    }
    const openBtn = page.locator('button:has-text("發起交易")').first();
    if (!(await openBtn.count().catch(() => 0))) {
      pushLog(`[warn] trade #${tag}: no 發起交易 button`);
      return false;
    }
    const ok = await openBtn.click({ timeout: 8000 }).then(() => true).catch((e) => {
      pushLog(`[warn] trade #${tag} open click err: ${String(e).slice(0, 160)}`);
      return false;
    });
    if (!ok) return false;
    await page.waitForTimeout(700);
    const visible = await page.locator('#trade-propose').isVisible().catch(() => false);
    if (!visible) { pushLog(`[warn] trade #${tag}: dialog not visible`); return false; }
    return true;
  }

  async function doTradeUI(
    idx: number,
    counterpartyIdx: number,
    opts: { force?: boolean; lopsided?: boolean } = {},
  ): Promise<TradeAttempt> {
    const counterparty = aiTeams[counterpartyIdx % Math.max(aiTeams.length, 1)];
    const attempt: TradeAttempt = {
      idx,
      counterpartyId: counterparty?.id ?? null,
      counterpartyName: counterparty?.name || '',
      sendNames: [],
      receiveNames: [],
      force: !!opts.force,
      lopsided: !!opts.lopsided,
      submitClickMs: 0,
      toastSeen: '',
      outcomeAfterMs: null,
    };
    if (!counterparty) { pushLog(`[trade${idx}] no counterparty`); return attempt; }

    const opened = await openProposeDialog(String(idx));
    if (!opened) return attempt;
    await shoot(page, `30_trade${idx}_open`);

    // Pick counterparty
    await page.locator('#cp-select').selectOption(String(counterparty.id)).catch(() => null);
    await page.waitForTimeout(1500); // fetch roster
    await shoot(page, `30_trade${idx}_cpselected`);

    // Pick 2 of OUR players: checkboxes in the 送出 side
    const sendSide = page.locator('.propose-sides .propose-side').first();
    const recvSide = page.locator('.propose-sides .propose-side').nth(1);

    const sendLabels = await sendSide.locator('.propose-player-list li label').all();
    const recvLabels = await recvSide.locator('.propose-player-list li label').all();
    pushLog(`[trade${idx}] sendCand=${sendLabels.length} recvCand=${recvLabels.length}`);

    // For lopsided: pick our LAST (worst) and their FIRST (best). Otherwise 2 mid picks.
    let sendPicks: number[];
    let recvPicks: number[];
    if (opts.lopsided) {
      sendPicks = [Math.max(0, sendLabels.length - 1)];
      recvPicks = [0];
    } else {
      // 2 from send, 2 from receive (mix)
      sendPicks = [1, 3].filter((i) => i < sendLabels.length).slice(0, 2);
      if (sendPicks.length < 2 && sendLabels.length >= 2) sendPicks = [0, 1];
      if (sendPicks.length === 0 && sendLabels.length >= 1) sendPicks = [0];
      recvPicks = [1, 3].filter((i) => i < recvLabels.length).slice(0, 2);
      if (recvPicks.length < 2 && recvLabels.length >= 2) recvPicks = [0, 1];
      if (recvPicks.length === 0 && recvLabels.length >= 1) recvPicks = [0];
    }

    for (const i of sendPicks) {
      const lb = sendLabels[i];
      const name = (await lb.locator('.pname').innerText().catch(() => '')) || `send[${i}]`;
      attempt.sendNames.push(name);
      await lb.locator('input[type="checkbox"]').check({ timeout: 4000 }).catch(() => null);
      await page.waitForTimeout(400);
    }
    // Re-query recv labels after send picks (re-render could happen)
    const recvLabels2 = await recvSide.locator('.propose-player-list li label').all();
    for (const i of recvPicks) {
      const lb = recvLabels2[i];
      if (!lb) continue;
      const name = (await lb.locator('.pname').innerText().catch(() => '')) || `recv[${i}]`;
      attempt.receiveNames.push(name);
      await lb.locator('input[type="checkbox"]').check({ timeout: 4000 }).catch(() => null);
      await page.waitForTimeout(400);
    }

    if (opts.force) {
      await page.locator('#trade-force').check({ timeout: 4000 }).catch(() => null);
      await page.waitForTimeout(200);
      const warnVisible = await page.locator('#trade-force-warn').isVisible().catch(() => false);
      pushLog(`[trade${idx}] force checkbox checked, warn visible=${warnVisible}`);
    }

    await shoot(page, `30_trade${idx}_ready`);

    // Submit
    const t0 = Date.now();
    const ok = await page.locator('#btn-trade-propose-submit').click({ timeout: 8000 }).then(() => true).catch((e) => {
      pushLog(`[trade${idx}] submit click err: ${String(e).slice(0, 160)}`);
      return false;
    });
    attempt.submitClickMs = Date.now() - t0;
    pushLog(`[trade${idx}] submit ok=${ok} ${attempt.submitClickMs}ms force=${attempt.force} lopsided=${attempt.lopsided}`);

    // Wait for toast
    await page.waitForTimeout(1500);
    const toastTxt = await page.locator('#toast-stack').innerText().catch(() => '');
    attempt.toastSeen = toastTxt.slice(0, 400);
    await shoot(page, `30_trade${idx}_submitted`);

    // Close dialog if still open
    if (await page.locator('#trade-propose').isVisible().catch(() => false)) {
      await page.keyboard.press('Escape').catch(() => null);
      await page.waitForTimeout(400);
    }

    // Wait for backend AI response ~12s
    await page.waitForTimeout(12000);
    const trades = await readTrades(page);
    const humanTeamNow = await readTeam(page, humanId);
    const rosterNow = (humanTeamNow?.players || []).map((p: any) => p.name);
    attempt.outcomeAfterMs = {
      tradesCount: Array.isArray(trades) ? trades.length : (trades?.items?.length ?? null),
      rosterSample: rosterNow.slice(0, 5),
      latestTrade: Array.isArray(trades)
        ? trades[trades.length - 1]
        : (trades?.items?.[trades.items.length - 1] ?? null),
    };
    pushLog(`[trade${idx}] outcome=${JSON.stringify(attempt.outcomeAfterMs).slice(0, 400)}`);
    await shoot(page, `30_trade${idx}_resolved`);
    return attempt;
  }

  // 5 regular trades with different AI counterparties
  for (let i = 1; i <= 5; i++) {
    const att = await doTradeUI(i, i - 1, {});
    tradeAttempts.push(att);
  }
  // Lopsided decline-test
  tradeAttempts.push(await doTradeUI(6, 0, { lopsided: true }));
  // Force-trade cheat mode
  tradeAttempts.push(await doTradeUI(7, 1, { force: true }));

  // =============================================================== 8. FA FLOOD (UI)
  await page.goto(`${BASE}/#fa`);
  await page.waitForTimeout(1800);
  await shoot(page, '40_fa_view');

  interface FaAttempt {
    idx: number;
    note: string;
    signClickMs: number;
    confirmClickMs: number;
    toastSeen: string;
    remainingAfter: any;
  }
  const faAttempts: FaAttempt[] = [];

  async function faSignOne(idx: number, note: string, injuredOnly = false): Promise<FaAttempt> {
    const a: FaAttempt = { idx, note, signClickMs: 0, confirmClickMs: 0, toastSeen: '', remainingAfter: null };
    await page.goto(`${BASE}/#fa`);
    await page.waitForTimeout(1500);

    // sort by fppg (default is already) — try to locate first btn-sign
    const rows = page.locator('#tbl-fa tbody tr');
    const nRows = await rows.count().catch(() => 0);
    pushLog(`[fa${idx}] rows=${nRows}`);
    if (nRows === 0) { pushLog(`[fa${idx}] no rows`); return a; }

    // If injuredOnly, walk rows to find status != healthy; otherwise first row.
    let chosenIdx = 0;
    if (injuredOnly) {
      let found = -1;
      for (let i = 0; i < Math.min(nRows, 50); i++) {
        const text = await rows.nth(i).innerText().catch(() => '');
        if (/out|doubtful|day-to-day|questionable|傷|DTD|O|GTD/i.test(text)) { found = i; break; }
      }
      if (found < 0) { pushLog(`[fa${idx}] no injured found in first 50`); a.note += ' (no injured-status player found)'; return a; }
      chosenIdx = found;
    }

    const row = rows.nth(chosenIdx);
    const btn = row.locator('button.btn-sign').first();
    if (!(await btn.count().catch(() => 0))) { pushLog(`[fa${idx}] no sign btn on row ${chosenIdx}`); return a; }

    const t0 = Date.now();
    await btn.click({ timeout: 6000 }).catch(() => null);
    a.signClickMs = Date.now() - t0;

    await page.waitForTimeout(800);
    // Pick-drop dialog → pick first radio (lowest fppg / bench)
    const radio = page.locator('#dlg-confirm input[name="drop-pid"]').first();
    if (await radio.count().catch(() => 0)) {
      await radio.check({ timeout: 4000 }).catch(() => null);
      await shoot(page, `40_fa${idx}_dropdlg`);
      const t1 = Date.now();
      await page.locator('#confirm-ok').click({ timeout: 6000 }).catch(() => null);
      a.confirmClickMs = Date.now() - t1;
    } else {
      pushLog(`[fa${idx}] no drop radio (bug? empty roster? closed?)`);
      // Cancel any open dialog
      await page.keyboard.press('Escape').catch(() => null);
    }

    await page.waitForTimeout(1800);
    a.toastSeen = (await page.locator('#toast-stack').innerText().catch(() => '')).slice(0, 300);
    a.remainingAfter = await readFaQuota(page);
    await shoot(page, `40_fa${idx}_done`);
    pushLog(`[fa${idx}] toast=${a.toastSeen.replace(/\n/g, ' | ')} remaining=${JSON.stringify(a.remainingAfter)}`);
    return a;
  }

  // Sign 5 FAs rapidly
  for (let i = 1; i <= 5; i++) {
    faAttempts.push(await faSignOne(i, `rapid-${i}`));
    await page.waitForTimeout(400); // rapid succession
  }

  // Injured player attempt
  faAttempts.push(await faSignOne(6, 'injured-status test', true));

  // "Roster full without drop-first" → pressing cancel on drop dialog should
  // not add. Simulate via UI by clicking sign then Escape.
  await page.goto(`${BASE}/#fa`);
  await page.waitForTimeout(1500);
  const rosterFullRow = page.locator('#tbl-fa tbody tr button.btn-sign').first();
  if (await rosterFullRow.count().catch(() => 0)) {
    await rosterFullRow.click({ timeout: 6000 }).catch(() => null);
    await page.waitForTimeout(800);
    await shoot(page, '40_fa_nodrop_dlg');
    await page.keyboard.press('Escape').catch(() => null);
    await page.waitForTimeout(500);
    const toast = (await page.locator('#toast-stack').innerText().catch(() => '')).slice(0, 300);
    pushLog(`[fa-nodrop] cancelled, toast=${toast.replace(/\n/g, ' | ')}`);
    faAttempts.push({ idx: 7, note: 'sign-then-cancel (no-drop)', signClickMs: 0, confirmClickMs: 0, toastSeen: toast, remainingAfter: await readFaQuota(page) });
  }

  // =============================================================== 9. REJECTED-CLAIM REPLAY
  // Attempt to sign a player that was just signed (now rostered / taken)
  await page.goto(`${BASE}/#fa`);
  await page.waitForTimeout(1200);

  // Use direct fetch for state read (allowed read-only) to locate a taken player id
  const takenInfo = await page.evaluate(async (hid) => {
    const r1 = await (await fetch(`/api/teams/${hid}`)).json().catch(() => null);
    const mine = r1?.players || [];
    if (!mine.length) return null;
    // Try to call /api/fa/claim with an already-rostered id via UI is not possible
    // (those players won't show on FA page). Instead, attempt to reuse a player
    // id that's on another team; the UI filter hides them too, but we can force
    // it by typing the exact name into the search then checking the empty result.
    return { name: mine[0]?.name || '', id: mine[0]?.id };
  }, humanId);
  pushLog(`[rejected-claim] taken player info=${JSON.stringify(takenInfo)}`);
  if (takenInfo?.name) {
    const searchBox = page.locator('.filter-bar input[type="search"]').first();
    if (await searchBox.count().catch(() => 0)) {
      await searchBox.fill(takenInfo.name);
      await page.waitForTimeout(1200);
      await shoot(page, '50_rejected_claim_search');
      const rowsAfter = await page.locator('#tbl-fa tbody tr').count().catch(() => 0);
      pushLog(`[rejected-claim] rows for rostered name '${takenInfo.name}' = ${rowsAfter} (expect 0 — UI should filter out)`);
      // Also ensure no crash
      const errsBefore = logs.filter((l) => l.includes('[pageerror]')).length;
      await page.waitForTimeout(1000);
      const errsAfter = logs.filter((l) => l.includes('[pageerror]')).length;
      pushLog(`[rejected-claim] pageerrors before=${errsBefore} after=${errsAfter}`);
    }
  }

  // =============================================================== 10. FINAL SNAPSHOTS + LOG DUMP
  await page.goto(`${BASE}/#league`);
  await page.waitForTimeout(1500);
  await shoot(page, '60_final_league');
  await page.goto(`${BASE}/#teams`);
  await page.waitForTimeout(1500);
  await shoot(page, '60_final_teams');
  await page.goto(`${BASE}/#fa`);
  await page.waitForTimeout(1000);
  await shoot(page, '60_final_fa');

  // Gather trade-log for accuracy check
  const allLogs = await readLogsFeed(page);
  const allTrades = await readTrades(page);
  const postHumanRoster = (await readTeam(page, humanId))?.players || [];
  fs.writeFileSync('screenshots/g3p_state_dump.json', JSON.stringify({
    humanId,
    preHumanRoster: preHumanRoster.map((p: any) => ({ id: p.id, name: p.name, pos: p.pos, fppg: p.fppg })),
    postHumanRoster: postHumanRoster.map((p: any) => ({ id: p.id, name: p.name, pos: p.pos, fppg: p.fppg })),
    tradeAttempts,
    faAttempts,
    tradesFeed: allTrades,
    logsFeed: (allLogs || []).slice(-50),
  }, null, 2));
  flushLogs();

  pushLog(`[DONE] tradeAttempts=${tradeAttempts.length} faAttempts=${faAttempts.length}`);
  flushLogs();
});
