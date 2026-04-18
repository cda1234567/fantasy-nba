import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';

const BASE = 'https://nbafantasy.cda1234567.com';
const LEAGUE_ID = 'qa-g1';
const SS_DIR = 'screenshots';

if (!fs.existsSync(SS_DIR)) fs.mkdirSync(SS_DIR, { recursive: true });

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SS_DIR}/g1p_${name}.png`, fullPage: true });
}

async function apiPost(path: string, body: any) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}
async function apiGet(path: string) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.text() };
}

test.describe.configure({ mode: 'serial' });

test('qa-g1 end-to-end flow', async ({ page }) => {
  test.setTimeout(15 * 60 * 1000);

  // Capture console errors for the report
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  // -------- 0. Ensure league exists & is active (API side) --------
  await apiPost('/api/leagues/create', { league_id: LEAGUE_ID });
  await apiPost('/api/leagues/switch', { league_id: LEAGUE_ID });

  // -------- 1. Open site --------
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await shot(page, '01_landing');

  // Read header
  const title = await page.locator('.app-title').textContent();
  const version = await page.locator('#app-version').textContent();
  console.log('[QA] title=', title, 'version=', version);

  // -------- 2. League switcher: create qa-g1 (or verify it exists) --------
  await page.locator('#btn-league-switch').click().catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, '02_lsw_menu');

  // The switcher may already show qa-g1 since we created it via API
  const activeText = await page.locator('#lsw-current').textContent();
  console.log('[QA] active league =', activeText);

  // Close menu
  await page.keyboard.press('Escape').catch(() => {});

  // -------- 3. Complete league setup if needed --------
  const status = await apiGet('/api/league/status');
  const statusJson = JSON.parse(status.body);
  console.log('[QA] league status =', status.body);

  if (!statusJson.setup_complete) {
    // Use API to setup fully (UI setup is slow + we'll screenshot the UI instead)
    const setupBody = {
      league_name: 'qa-g1',
      season_year: '2024-25',
      num_teams: 8,
      player_team_index: 0,
      team_names: ['Andy-QA', 'Bucks AI', 'Celtics AI', 'Nuggets AI', 'Warriors AI', 'Heat AI', 'Suns AI', 'Mavs AI'],
      roster_size: 13,
      starters_per_day: 10,
      il_slots: 3,
      regular_season_weeks: 20,
      randomize_draft_order: false,
      draft_display_mode: 'prev_full',
      scoring_weights: {},
      setup_complete: false,
    };
    const setupRes = await apiPost('/api/league/setup', setupBody);
    console.log('[QA] setup res =', setupRes.status, setupRes.body.slice(0, 200));
  }

  // -------- 4. Draft page ---------
  await page.goto(`${BASE}/#draft`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot(page, '03_draft_initial');

  // Inspect DOM for draft UI elements
  const heroExists = await page.locator('.draft-hero').count();
  const boardExists = await page.locator('.draft-grid').count();
  const tableExists = await page.locator('table').count();
  console.log('[QA] draft hero=', heroExists, 'board=', boardExists, 'tables=', tableExists);

  // Try picking 5 players manually
  for (let i = 0; i < 5; i++) {
    const stateRes = await apiGet('/api/state');
    const state = JSON.parse(stateRes.body);
    if (state.is_complete) break;

    if (state.current_team_id !== state.human_team_id) {
      // Sim to me
      await apiPost('/api/draft/sim-to-me', {});
      continue;
    }

    // Wait for draft buttons
    await page.waitForTimeout(400);
    const draftBtns = page.locator('button[data-draft]:not([disabled])');
    const cnt = await draftBtns.count();
    if (cnt === 0) {
      await page.waitForTimeout(1500);
      continue;
    }
    await draftBtns.first().click().catch(() => {});
    await page.waitForTimeout(900);
    await shot(page, `04_draft_pick_${i}`);
  }

  // Try auto-pick once
  const aiRes = await apiPost('/api/draft/ai-advance', {});
  console.log('[QA] ai-advance =', aiRes.status, aiRes.body.slice(0, 150));
  await page.waitForTimeout(600);
  await shot(page, '05_after_ai_advance');

  // Sim to end of draft
  let guard = 200;
  while (guard-- > 0) {
    const s = JSON.parse((await apiGet('/api/state')).body);
    if (s.is_complete) break;
    if (s.current_team_id === s.human_team_id) {
      // auto pick top available for human
      const pool = JSON.parse((await apiGet('/api/players?limit=1')).body);
      if (pool.length === 0) break;
      await apiPost('/api/draft/pick', { player_id: pool[0].id });
    } else {
      await apiPost('/api/draft/sim-to-me', {});
    }
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await shot(page, '06_draft_complete');

  // -------- 5. Start season --------
  const startRes = await apiPost('/api/season/start', {});
  console.log('[QA] season start =', startRes.status, startRes.body.slice(0, 200));
  await page.goto(`${BASE}/#schedule`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await shot(page, '07_season_schedule');

  // Advance 5 days
  for (let i = 0; i < 5; i++) {
    const r = await apiPost('/api/season/advance-day', {});
    if (r.status !== 200) break;
  }
  await page.reload({ waitUntil: 'networkidle' });
  await shot(page, '08_after_5_days');

  // -------- 6. Propose a trade --------
  const stateAfter = JSON.parse((await apiGet('/api/state')).body);
  const humanId = stateAfter.human_team_id;
  const humanRoster = stateAfter.teams[humanId].roster;
  const otherTeamId = (humanId + 1) % stateAfter.num_teams;
  const otherRoster = stateAfter.teams[otherTeamId].roster;
  if (humanRoster.length && otherRoster.length) {
    const tradeRes = await apiPost('/api/trades/propose', {
      from_team: humanId,
      to_team: otherTeamId,
      send: [humanRoster[humanRoster.length - 1]],
      receive: [otherRoster[0]],
      proposer_message: 'QA test trade',
    });
    console.log('[QA] trade propose =', tradeRes.status, tradeRes.body.slice(0, 300));
  }
  await page.goto(`${BASE}/#teams`, { waitUntil: 'networkidle' });
  await shot(page, '09_teams_view');

  // -------- 7. Sim to playoffs + playoffs --------
  const spRes = await apiPost('/api/season/sim-to-playoffs', {});
  console.log('[QA] sim-to-playoffs =', spRes.status);
  const ppRes = await apiPost('/api/season/sim-playoffs', {});
  console.log('[QA] sim-playoffs =', ppRes.status);
  await page.goto(`${BASE}/#league`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await shot(page, '10_league_final');

  // Capture console errors
  fs.writeFileSync(`${SS_DIR}/g1p_console_errors.txt`, consoleErrors.join('\n'));
  console.log('[QA] total console errors =', consoleErrors.length);
});
