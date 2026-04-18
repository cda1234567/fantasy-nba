import { test, expect, Page } from '@playwright/test';

const BASE = 'https://nbafantasy.cda1234567.com';
const LEAGUE_ID = 'qa-g3';
const SHOT = (n: string) => `screenshots/g3p_${n}.png`;

async function shoot(page: Page, name: string, full = true) {
  await page.screenshot({ path: SHOT(name), fullPage: full });
}

test.setTimeout(15 * 60 * 1000);

test('g3 player full flow', async ({ page }) => {
  const logs: string[] = [];
  const pushLog = (s: string) => { logs.push(s); };
  page.on('console', (m) => pushLog(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => pushLog(`[pageerror] ${e.message}`));

  // ---------------------------------------------------------------- 1. Open
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await shoot(page, '01_home');

  // ------------------------------------------ 2. League switcher + create
  const switchBtn = page.locator('#btn-league-switch');
  if (await switchBtn.count()) {
    await switchBtn.click();
    await page.waitForTimeout(400);
    await shoot(page, '02_league_menu');

    // Dump menu items for UX analysis
    const menu = page.locator('#league-switch-menu');
    const menuTxt = (await menu.innerText().catch(() => '')).slice(0, 400);
    pushLog(`[debug] league menu text=${menuTxt}`);

    const createTrigger = menu.getByText(/建立|新增|create/i).first();
    if (await createTrigger.count()) {
      await createTrigger.click();
      await page.waitForTimeout(500);
      const dlg = page.locator('#dlg-new-league');
      if (await dlg.isVisible().catch(() => false)) {
        await page.locator('#new-league-id').fill(LEAGUE_ID);
        await shoot(page, '03_new_league_form');
        await page.locator('#btn-new-league-create').click();
        await page.waitForTimeout(1500);
      }
    } else {
      await page.keyboard.press('Escape');
    }
  }

  // Ensure league exists + switched (API fallback — league already created out-of-band)
  await page.evaluate(async (lid) => {
    try {
      await fetch('/api/leagues/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ league_id: lid, switch: true }),
      });
    } catch {}
    await fetch('/api/leagues/switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ league_id: lid }),
    });
  }, LEAGUE_ID);
  await page.reload();
  await page.waitForTimeout(1500);
  await shoot(page, '04_after_switch');

  // ------------------------------------------------------- 3. League setup
  const status0 = await page.evaluate(async () => (await fetch('/api/league/status')).json());
  pushLog(`[debug] pre-setup status=${JSON.stringify(status0)}`);

  // Try visiting setup page via UI (hamburger → settings dialog has no setup link, so direct route)
  await page.goto(`${BASE}/#setup`);
  await page.waitForTimeout(1200);
  await shoot(page, '05_setup_page');

  // Attempt click "開始選秀" button
  const submitBtn = page.locator('#btn-setup-submit');
  if (await submitBtn.count()) {
    await submitBtn.click();
    await page.waitForTimeout(2000);
    await shoot(page, '06_setup_submitted');
  } else {
    // fallback via API
    const setupRes = await page.evaluate(async () => {
      const r = await fetch('/api/league/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      return { status: r.status, body: (await r.text()).slice(0, 400) };
    });
    pushLog(`[debug] fallback setup res=${JSON.stringify(setupRes)}`);
    await page.reload();
    await page.waitForTimeout(1500);
  }

  // ---------------------------------------------------------- 4. Draft page
  await page.goto(`${BASE}/#draft`);
  await page.waitForTimeout(1500);
  await shoot(page, '10_draft_initial');

  // Inspect hero & panels
  const heroTxt = await page.locator('.draft-hero').first().innerText().catch(() => '');
  pushLog(`[debug] hero txt=${heroTxt.slice(0, 400)}`);
  const panelHeads = await page.locator('.panel-head h2').allInnerTexts();
  pushLog(`[debug] panel heads=${JSON.stringify(panelHeads)}`);
  const filterBars = await page.locator('.filter-bar').count();
  pushLog(`[debug] filter bar count=${filterBars}`);
  const availRows = await page.locator('#tbl-available tbody tr').count();
  pushLog(`[debug] available rows=${availRows}`);
  const boardRows = await page.locator('table.board tbody tr').count();
  pushLog(`[debug] board rows=${boardRows}`);

  // Manual pick #1 — click visible draft button on page
  // (sim ai-advance to push to our turn if we aren't first)
  for (let kick = 0; kick < 40; kick++) {
    const s = await page.evaluate(async () => (await fetch('/api/state')).json());
    if (s.is_complete) break;
    if (s.current_team_id === s.human_team_id) break;
    await page.evaluate(async () => { await fetch('/api/draft/ai-advance', { method: 'POST' }); });
    await page.waitForTimeout(80);
  }
  await page.reload();
  await page.waitForTimeout(1200);
  await shoot(page, '11_my_turn_arrived');

  // Manual 5+ picks through the UI whenever it's our turn
  let manualClicks = 0;
  const pickScreenshots: number[] = [];
  for (let i = 0; i < 120 && manualClicks < 6; i++) {
    const s = await page.evaluate(async () => (await fetch('/api/state')).json());
    if (s.is_complete) break;
    if (s.current_team_id === s.human_team_id) {
      const btn = page.locator('button[data-draft]').first();
      if (await btn.count() && await btn.isEnabled().catch(() => false)) {
        // Try clicking via UI
        try {
          await btn.scrollIntoViewIfNeeded();
          await btn.click({ timeout: 5000 });
          manualClicks++;
          pickScreenshots.push(i);
          if (manualClicks <= 5) await shoot(page, `12_manual_pick_${manualClicks}`);
          await page.waitForTimeout(400);
        } catch (err) {
          pushLog(`[warn] UI click failed at i=${i}: ${String(err).slice(0, 200)}`);
          // API fallback
          await page.evaluate(async () => {
            const ss = await (await fetch('/api/state')).json();
            const pid = ss.available?.[0]?.id;
            if (pid) await fetch('/api/draft/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ player_id: pid }) });
          });
          manualClicks++;
        }
      } else {
        pushLog(`[warn] no draft btn found / disabled on our turn at i=${i}`);
        await page.evaluate(async () => {
          const ss = await (await fetch('/api/state')).json();
          const pid = ss.available?.[0]?.id;
          if (pid) await fetch('/api/draft/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ player_id: pid }) });
        });
        manualClicks++;
      }
    } else {
      // Let auto-advance do its thing, otherwise force it
      await page.waitForTimeout(200);
      const s2 = await page.evaluate(async () => (await fetch('/api/state')).json());
      if (!s2.is_complete && s2.current_team_id !== s2.human_team_id) {
        await page.evaluate(async () => { await fetch('/api/draft/ai-advance', { method: 'POST' }); });
        await page.waitForTimeout(80);
      }
    }
  }
  pushLog(`[debug] manualClicks=${manualClicks}`);
  await shoot(page, '13_after_manual_picks');

  // Try filter bar — search, position filter, sort change (UX test)
  const searchBox = page.locator('.filter-bar input[type="search"]').first();
  if (await searchBox.count()) {
    await searchBox.fill('LeBron');
    await page.waitForTimeout(600);
    await shoot(page, '14_filter_search');
    await searchBox.fill('');
    await page.waitForTimeout(300);
  }
  const posSel = page.locator('.filter-bar select').first();
  if (await posSel.count()) {
    await posSel.selectOption('PG').catch(() => null);
    await page.waitForTimeout(400);
    await shoot(page, '15_filter_pos_pg');
    await posSel.selectOption('').catch(() => null);
    await page.waitForTimeout(300);
  }
  const sortSel = page.locator('.filter-bar select').nth(1);
  if (await sortSel.count()) {
    await sortSel.selectOption('pts').catch(() => null);
    await page.waitForTimeout(400);
    await shoot(page, '16_sort_pts');
  }

  // Display mode switch (per-league dropdown)
  const modeSel = page.locator('#draft-display-mode-switch');
  if (await modeSel.count()) {
    await modeSel.selectOption('current_full').catch(() => null);
    await page.waitForTimeout(500);
    await shoot(page, '17_mode_current_full');
    await modeSel.selectOption('prev_no_fppg').catch(() => null);
    await page.waitForTimeout(500);
    await shoot(page, '18_mode_prev_no_fppg');
  }

  // Click "sim to me" button
  const simToMeBtn = page.locator('.dh-actions .btn.primary').first();
  if (await simToMeBtn.count() && await simToMeBtn.isEnabled().catch(() => false)) {
    await simToMeBtn.click().catch(() => null);
    await page.waitForTimeout(1500);
    await shoot(page, '19_sim_to_me');
  } else {
    await page.evaluate(async () => { await fetch('/api/draft/sim-to-me', { method: 'POST' }); });
    await page.waitForTimeout(1000);
  }

  // Finish draft
  for (let i = 0; i < 300; i++) {
    const s = await page.evaluate(async () => (await fetch('/api/state')).json());
    if (s.is_complete) { pushLog(`[debug] draft complete at finish-loop i=${i}`); break; }
    if (s.current_team_id === s.human_team_id) {
      await page.evaluate(async () => {
        const ss = await (await fetch('/api/state')).json();
        const pid = ss.available?.[0]?.id;
        if (pid) {
          await fetch('/api/draft/pick', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ player_id: pid }),
          });
        }
      });
    } else {
      await page.evaluate(async () => { await fetch('/api/draft/ai-advance', { method: 'POST' }); });
    }
    await page.waitForTimeout(60);
  }
  await page.reload();
  await page.waitForTimeout(1200);
  await shoot(page, '20_draft_done');

  // ------------------------------------------------------- 5. Start season
  const startRes = await page.evaluate(async () => {
    const r = await fetch('/api/season/start', { method: 'POST' });
    return { status: r.status, body: (await r.text()).slice(0, 200) };
  });
  pushLog(`[debug] season start=${JSON.stringify(startRes)}`);
  await page.goto(`${BASE}/#league`);
  await page.waitForTimeout(1500);
  await shoot(page, '30_season_started');

  // Advance 5 days
  for (let i = 0; i < 5; i++) {
    await page.evaluate(async () => { await fetch('/api/season/advance-day', { method: 'POST' }); });
    await page.waitForTimeout(150);
  }
  await page.reload();
  await page.waitForTimeout(1000);
  await shoot(page, '31_after_5days');

  // ----------------------------------------------------------- 6. 1 trade
  const tradeRes = await page.evaluate(async () => {
    const state = await (await fetch('/api/state')).json();
    const myId = state.human_team_id;
    const other = (state.teams || []).find((t: any) => t.id !== myId);
    if (!other) return { skipped: true };
    const myTeam = await (await fetch(`/api/teams/${myId}`)).json();
    const otherTeam = await (await fetch(`/api/teams/${other.id}`)).json();
    const myPick = (myTeam.roster || myTeam.players || [])[0];
    const otherPick = (otherTeam.roster || otherTeam.players || [])[0];
    if (!myPick || !otherPick) return { skipped: true, reason: 'empty roster' };
    const r = await fetch('/api/trades/propose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_team: myId,
        to_team: other.id,
        from_players: [myPick.id],
        to_players: [otherPick.id],
        force: true,
      }),
    });
    return { status: r.status, body: (await r.text()).slice(0, 300) };
  });
  pushLog(`[debug] trade=${JSON.stringify(tradeRes)}`);
  await page.reload();
  await page.waitForTimeout(1000);
  await shoot(page, '32_after_trade');

  // ---------------------------------------------- 7. Advance to end-of-season
  const sim1 = await page.evaluate(async () => (await fetch('/api/season/sim-to-playoffs', { method: 'POST' })).status);
  pushLog(`[debug] sim-to-playoffs=${sim1}`);
  const sim2 = await page.evaluate(async () => (await fetch('/api/season/sim-playoffs', { method: 'POST' })).status);
  pushLog(`[debug] sim-playoffs=${sim2}`);
  await page.reload();
  await page.waitForTimeout(1500);
  await shoot(page, '40_end_season');

  // schedule / teams / fa pages
  await page.goto(`${BASE}/#schedule`);
  await page.waitForTimeout(1000);
  await shoot(page, '41_schedule');
  await page.goto(`${BASE}/#teams`);
  await page.waitForTimeout(1000);
  await shoot(page, '42_teams');
  await page.goto(`${BASE}/#fa`);
  await page.waitForTimeout(1000);
  await shoot(page, '43_fa');
  await page.goto(`${BASE}/#league`);
  await page.waitForTimeout(1000);
  await shoot(page, '44_league');

  require('fs').writeFileSync('screenshots/g3p_console.log', logs.join('\n'));
});
