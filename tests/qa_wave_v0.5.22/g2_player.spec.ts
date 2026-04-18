import { test, expect, Page } from '@playwright/test';

const BASE = 'https://nbafantasy.cda1234567.com';
const LEAGUE_ID = 'qa-g2';
const SHOT = (n: string) => `screenshots/g2p_${n}.png`;

async function shoot(page: Page, name: string, full = true) {
  await page.screenshot({ path: SHOT(name), fullPage: full });
}

test.setTimeout(15 * 60 * 1000);

test('g2 player full flow', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  // 1. Open site
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await shoot(page, '01_home');

  // 2. Open league switcher and try create new league
  const switchBtn = page.locator('#btn-league-switch');
  if (await switchBtn.count()) {
    await switchBtn.click();
    await page.waitForTimeout(400);
    await shoot(page, '02_league_menu');

    const menuItems = page.locator('#league-switch-menu [role="menuitem"], #league-switch-menu button, #league-switch-menu a');
    const itemsCount = await menuItems.count();
    logs.push(`[debug] league menu items=${itemsCount}`);

    // Try find "create" button in menu
    const createTrigger = page.locator('#league-switch-menu').getByText(/建立|新增|create/i).first();
    if (await createTrigger.count()) {
      await createTrigger.click();
    } else {
      // Try scroll menu for item, else API fallback
      await page.keyboard.press('Escape');
      await page.evaluate(async (lid) => {
        await fetch('/api/leagues/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ league_id: lid }),
        });
      }, LEAGUE_ID);
      await page.reload();
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(500);

    // new-league dialog if present
    const newLeagueDlg = page.locator('#dlg-new-league');
    if (await newLeagueDlg.isVisible().catch(() => false)) {
      await page.locator('#new-league-id').fill(LEAGUE_ID);
      await shoot(page, '03_new_league_form');
      await page.locator('#btn-new-league-create').click();
      await page.waitForTimeout(1500);
    }
  }

  // Ensure we're on qa-g2 via API switch
  await page.evaluate(async (lid) => {
    await fetch('/api/leagues/switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ league_id: lid }),
    });
  }, LEAGUE_ID);
  await page.reload();
  await page.waitForTimeout(1500);
  await shoot(page, '04_after_switch');

  // 3. Check if setup needed; navigate to setup
  const setupBtn = page.locator('#btn-menu');
  await setupBtn.click();
  await page.waitForTimeout(400);
  await shoot(page, '05_settings_dialog');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Check league status
  const status = await page.evaluate(async () => {
    const r = await fetch('/api/league/status');
    return r.json();
  });
  logs.push(`[debug] league status=${JSON.stringify(status)}`);

  // If not setup, call setup API
  if (!status.setup_complete) {
    const setupRes = await page.evaluate(async () => {
      const r = await fetch('/api/league/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      return { status: r.status, body: await r.text().catch(() => '') };
    });
    logs.push(`[debug] setup res=${JSON.stringify(setupRes)}`);
    await page.reload();
    await page.waitForTimeout(1500);
  }

  // 4. Draft page — main focus
  await page.goto(`${BASE}/#draft`);
  await page.waitForTimeout(1500);
  await shoot(page, '10_draft_initial');

  // Inspect draft hero & table
  const heroTxt = await page.locator('#draft-hero-container, .draft-hero').first().innerText().catch(() => '');
  logs.push(`[debug] draft hero txt len=${heroTxt.length}`);

  // Grab available rows
  const availRows = page.locator('table tbody tr');
  const rowCount = await availRows.count();
  logs.push(`[debug] draft rows=${rowCount}`);

  // Try manual picks: click 5 draft buttons whenever it's human turn
  for (let i = 0; i < 60; i++) {
    const state = await page.evaluate(async () => {
      const r = await fetch('/api/state');
      return r.json();
    });
    if (state.is_complete) {
      logs.push(`[debug] draft complete at iter ${i}`);
      break;
    }
    const isHuman = state.current_team_id === state.human_team_id;
    if (isHuman) {
      // Click first draft button
      const btn = page.locator('button[data-draft]').first();
      if (await btn.count()) {
        await btn.click();
        await page.waitForTimeout(400);
        if (i < 5) await shoot(page, `11_pick_${i + 1}`);
      } else {
        // fallback API pick
        await page.evaluate(async () => {
          const s = await fetch('/api/state').then((r) => r.json());
          const avail = (s.available || []).slice(0, 1);
          if (avail.length) {
            await fetch('/api/draft/pick', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ player_id: avail[0].id }),
            });
          }
        });
      }
    } else {
      // AI turn: try ai-advance
      await page.evaluate(async () => {
        await fetch('/api/draft/ai-advance', { method: 'POST' });
      });
      await page.waitForTimeout(200);
    }
  }
  await shoot(page, '12_draft_midway');

  // Try "sim to me"
  const simToMe = await page.evaluate(async () => {
    const r = await fetch('/api/draft/sim-to-me', { method: 'POST' });
    return { status: r.status };
  });
  logs.push(`[debug] sim-to-me=${JSON.stringify(simToMe)}`);
  await page.reload();
  await page.waitForTimeout(1500);
  await shoot(page, '13_after_sim');

  // Finish the draft via repeated ai-advance
  for (let i = 0; i < 200; i++) {
    const s = await page.evaluate(async () => (await fetch('/api/state')).json());
    if (s.is_complete) break;
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
    await page.waitForTimeout(80);
  }
  await shoot(page, '14_draft_done');

  // 5. Start season
  const startRes = await page.evaluate(async () => {
    const r = await fetch('/api/season/start', { method: 'POST' });
    return { status: r.status, body: await r.text().catch(() => '') };
  });
  logs.push(`[debug] season start=${JSON.stringify(startRes).slice(0, 200)}`);
  await page.reload();
  await page.waitForTimeout(1500);
  await shoot(page, '20_season_start');

  // Advance 5 days
  for (let i = 0; i < 5; i++) {
    await page.evaluate(async () => {
      await fetch('/api/season/advance-day', { method: 'POST' });
    });
    await page.waitForTimeout(150);
  }
  await page.reload();
  await page.waitForTimeout(1000);
  await shoot(page, '21_after_5days');

  // 6. Propose trade
  await page.goto(`${BASE}/#teams`);
  await page.waitForTimeout(1200);
  await shoot(page, '30_teams');

  const tradeRes = await page.evaluate(async () => {
    const state = await (await fetch('/api/state')).json();
    const myId = state.human_team_id;
    // get another team
    const teams = state.teams || [];
    const other = teams.find((t: any) => t.id !== myId);
    if (!other) return { skipped: true };
    const myTeam = await (await fetch(`/api/teams/${myId}`)).json();
    const otherTeam = await (await fetch(`/api/teams/${other.id}`)).json();
    const myPick = (myTeam.roster || [])[0];
    const otherPick = (otherTeam.roster || [])[0];
    if (!myPick || !otherPick) return { skipped: true, reason: 'empty roster' };
    const r = await fetch('/api/trades/propose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from_team: myId,
        to_team: other.id,
        from_players: [myPick.id],
        to_players: [otherPick.id],
        force: false,
      }),
    });
    return { status: r.status, body: (await r.text()).slice(0, 300) };
  });
  logs.push(`[debug] trade=${JSON.stringify(tradeRes)}`);
  await page.reload();
  await page.waitForTimeout(1000);
  await shoot(page, '31_after_trade');

  // 7. Advance to end of season
  const simRes = await page.evaluate(async () => {
    const r = await fetch('/api/season/sim-to-playoffs', { method: 'POST' });
    return r.status;
  });
  logs.push(`[debug] sim-to-playoffs=${simRes}`);
  const pRes = await page.evaluate(async () => {
    const r = await fetch('/api/season/sim-playoffs', { method: 'POST' });
    return r.status;
  });
  logs.push(`[debug] sim-playoffs=${pRes}`);
  await page.reload();
  await page.waitForTimeout(1500);
  await shoot(page, '40_end_season');

  // schedule & league views
  await page.goto(`${BASE}/#schedule`);
  await page.waitForTimeout(1000);
  await shoot(page, '41_schedule');
  await page.goto(`${BASE}/#league`);
  await page.waitForTimeout(1000);
  await shoot(page, '42_league');
  await page.goto(`${BASE}/#fa`);
  await page.waitForTimeout(1000);
  await shoot(page, '43_fa');

  require('fs').writeFileSync('screenshots/g2p_console.log', logs.join('\n'));
});
