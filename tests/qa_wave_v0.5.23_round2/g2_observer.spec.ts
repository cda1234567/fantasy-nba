import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE = 'https://nbafantasy.cda1234567.com';
const OBS_LEAGUE = 'qa-r2-obs-g2';
const PEER_LEAGUE = 'qa-r2-g2';
const SHOT_DIR = path.join(__dirname, 'screenshots');
const LOG_PATH = path.join(__dirname, '_g2_observer_log.json');

type LogEntry = { ts: number; kind: string; data: any };
const logs: LogEntry[] = [];
function log(kind: string, data: any) {
  logs.push({ ts: Date.now(), kind, data });
}

function attachHooks(page: Page, tag: string) {
  page.on('console', (m) => log('console', { tag, type: m.type(), text: m.text().slice(0, 500) }));
  page.on('pageerror', (e) => log('pageerror', { tag, msg: e.message, stack: (e.stack || '').slice(0, 500) }));
  page.on('requestfailed', (r) => log('requestfailed', { tag, url: r.url(), err: r.failure()?.errorText }));
}

test.beforeAll(() => {
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
});

test.afterAll(() => {
  fs.writeFileSync(LOG_PATH, JSON.stringify(logs, null, 2), 'utf-8');
});

// ----------------------------------------------------------------------------
// TC0: Ensure observer league exists and is reset to a fresh state for draft
// ----------------------------------------------------------------------------
test('TC0: create + seed observer league', async ({ request }) => {
  // Create league (idempotent if already exists)
  const cr = await request.post(`${BASE}/api/leagues/create`, {
    data: { league_id: OBS_LEAGUE, name: OBS_LEAGUE },
  });
  log('create_obs', { status: cr.status(), body: (await cr.text()).slice(0, 500) });

  // Activate
  const sw = await request.post(`${BASE}/api/leagues/switch`, {
    data: { league_id: OBS_LEAGUE },
  });
  log('switch_obs', { status: sw.status() });

  // Snapshot settings IMMEDIATELY after create -- verify name is NOT default "QA Test League"
  const settings = await (await request.get(`${BASE}/api/league/settings`)).json();
  log('obs_settings_after_create', { league_name: settings.league_name, season_year: settings.season_year });

  // Also probe settings with explicit league_id to the SAME endpoint -- does the ?league_id= actually scope?
  const sB = await (await request.get(`${BASE}/api/league/settings?league_id=default`)).json();
  log('settings_with_league_id_param_default', { league_name: sB.league_name });
  const sC = await (await request.get(`${BASE}/api/league/settings?league_id=${OBS_LEAGUE}`)).json();
  log('settings_with_league_id_param_obs', { league_name: sC.league_name });

  // list
  const lst = await (await request.get(`${BASE}/api/leagues/list`)).json();
  log('leagues_list_snapshot', lst);
});

// ----------------------------------------------------------------------------
// TC1: Header badge shows v0.5.23 and has acceptable contrast
// ----------------------------------------------------------------------------
test('TC1: app-version badge v0.5.23 with contrast', async ({ page }) => {
  attachHooks(page, 'badge');
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });

  const versionProbe = await page.evaluate(() => {
    const el = document.getElementById('app-version') as HTMLElement | null;
    if (!el) return { found: false };
    const cs = getComputedStyle(el);
    const parent = el.parentElement;
    const pcs = parent ? getComputedStyle(parent) : null;
    function rgb(s: string): [number, number, number, number] | null {
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(',').map((x) => parseFloat(x.trim()));
      return [p[0] || 0, p[1] || 0, p[2] || 0, p[3] == null ? 1 : p[3]];
    }
    function lum(v: [number, number, number]) {
      const [r, g, b] = v.map((x) => {
        const n = x / 255;
        return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    const fg = rgb(cs.color);
    let bg = rgb(cs.backgroundColor);
    if (!bg || bg[3] < 0.01) {
      let cur: HTMLElement | null = el.parentElement;
      while (cur) {
        const c = rgb(getComputedStyle(cur).backgroundColor);
        if (c && c[3] > 0.01) {
          bg = c;
          break;
        }
        cur = cur.parentElement;
      }
    }
    if (!bg) bg = [13, 17, 23, 1];
    let ratio: number | null = null;
    if (fg) {
      const L1 = lum([fg[0], fg[1], fg[2]]);
      const L2 = lum([bg[0], bg[1], bg[2]]);
      const hi = Math.max(L1, L2),
        lo = Math.min(L1, L2);
      ratio = (hi + 0.05) / (lo + 0.05);
    }
    return {
      found: true,
      text: el.textContent?.trim(),
      fg: cs.color,
      bg: cs.backgroundColor,
      resolvedBg: `rgb(${bg[0]},${bg[1]},${bg[2]})`,
      fontSize: cs.fontSize,
      padding: cs.padding,
      contrast: ratio,
      title: el.getAttribute('title'),
    };
  });
  log('version_badge', versionProbe);
  await page.screenshot({ path: path.join(SHOT_DIR, 'tc1_header.png'), clip: { x: 0, y: 0, width: 1280, height: 120 } });
});

// ----------------------------------------------------------------------------
// TC2: Create a NEW league via UI and verify header name is NOT stale
// ----------------------------------------------------------------------------
test('TC2: name pollution regression via /api/leagues/create', async ({ page, request }) => {
  attachHooks(page, 'namepol');
  const freshId = 'qa-r2-obs-g2-n' + Math.floor(Date.now() / 1000) % 100000;
  // Create via API (mimics UI POST)
  const cr = await request.post(`${BASE}/api/leagues/create`, {
    data: { league_id: freshId, name: freshId },
  });
  log('tc2_create', { status: cr.status(), body: await cr.text() });

  // Probe BEFORE switch: what does /api/league/settings return?
  const sBefore = await (await request.get(`${BASE}/api/league/settings`)).json();
  log('tc2_settings_before_switch', { league_name: sBefore.league_name });
  const sQuery = await (await request.get(`${BASE}/api/league/settings?league_id=${freshId}`)).json();
  log('tc2_settings_via_query', { league_name: sQuery.league_name });

  // Switch via UI: just POST then reload page -- check header text
  await request.post(`${BASE}/api/leagues/switch`, { data: { league_id: freshId } });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  const headerName = await page.evaluate(() => {
    const n = document.querySelector('[data-league-name], .league-name, #league-name, header .name');
    return n ? (n as HTMLElement).textContent?.trim() : null;
  });
  const allHeaderText = await page.locator('header').first().innerText().catch(() => '');
  log('tc2_header_text', { headerName, allHeaderText: allHeaderText.slice(0, 500), freshId });

  // Clean up: delete if endpoint exists (soft, ignore failure)
  try {
    await request.post(`${BASE}/api/leagues/delete`, { data: { league_id: freshId } });
  } catch (e) {}
});

// ----------------------------------------------------------------------------
// TC3: Draft page — delegation fires on first human-turn click
// ----------------------------------------------------------------------------
test('TC3: event delegation click works on draft', async ({ page, request }) => {
  attachHooks(page, 'tc3');

  // Ensure active = observer league and it has a draft state
  await request.post(`${BASE}/api/leagues/switch`, { data: { league_id: OBS_LEAGUE } });
  // Force start / reset draft (idempotent -- if setup not complete, setup default)
  // Try common setup endpoints
  const setupRes = await request.post(`${BASE}/api/league/setup`, {
    data: {
      league_id: OBS_LEAGUE,
      league_name: OBS_LEAGUE,
      season_year: '2025-26',
      num_teams: 8,
      roster_size: 13,
      starters_per_day: 10,
      il_slots: 3,
      player_team_index: 0,
      team_names: ['我的隊伍', 'BPA', 'PuntTO', 'S&S', 'Balanced', 'Youth', 'VetWin', 'Contrarian'],
      randomize_draft_order: false,
      scoring_weights: { pts: 1, reb: 1.2, ast: 1.5, stl: 2.5, blk: 2.5, to: -1 },
      regular_season_weeks: 20,
      playoff_teams: 6,
      ai_trade_frequency: 'normal',
      ai_trade_style: 'balanced',
    },
  });
  log('tc3_setup_resp', { status: setupRes.status(), body: (await setupRes.text()).slice(0, 300) });

  // Reset draft to a clean slate (draft auto-starts after setup)
  const resetRes = await request.post(`${BASE}/api/draft/reset`, { data: {} });
  log('tc3_draft_reset', { status: resetRes.status(), body: (await resetRes.text()).slice(0, 300) });

  // Navigate to draft page
  await page.goto(BASE + '/#/draft', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // Advance AIs until human-turn
  for (let i = 0; i < 20; i++) {
    const st = await (await request.get(`${BASE}/api/state`)).json();
    log('tc3_poll_state', {
      iter: i,
      current_team_id: st.current_team_id,
      human_team_id: st.human_team_id,
      is_complete: st.is_complete,
      current_overall: st.current_overall,
    });
    if (st.is_complete) break;
    if (st.current_team_id === st.human_team_id) break;
    const adv = await request.post(`${BASE}/api/draft/ai-advance`, { data: {} });
    log('tc3_ai_adv', { iter: i, status: adv.status() });
    await page.waitForTimeout(150);
  }

  // Reload draft page at human turn
  await page.goto(BASE + '/#/draft', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Check delegation marker
  const delegationProbe = await page.evaluate(() => {
    const tbl = document.querySelector('#tbl-available') as HTMLElement | null;
    if (!tbl) return { tblFound: false };
    return {
      tblFound: true,
      delegated: tbl.dataset.draftDelegated,
      buttonCount: tbl.querySelectorAll('button[data-draft]').length,
      disabledButtons: tbl.querySelectorAll('button[data-draft][disabled]').length,
    };
  });
  log('tc3_delegation_marker', delegationProbe);

  await page.screenshot({ path: path.join(SHOT_DIR, 'tc3_draft_human_turn.png'), fullPage: true });

  // Attempt first click via locator
  const firstBtn = page.locator('#tbl-available button[data-draft]:not([disabled])').first();
  const countAvail = await page.locator('#tbl-available button[data-draft]').count();
  log('tc3_button_count', { totalAvail: countAvail });

  if (countAvail > 0) {
    const pidBefore = await firstBtn.getAttribute('data-draft');
    log('tc3_about_to_click', { pidBefore });

    // capture pre-click state.current_overall
    const stBefore = await (await request.get(`${BASE}/api/state`)).json();
    log('tc3_state_before_click', {
      current_overall: stBefore.current_overall,
      current_team_id: stBefore.current_team_id,
      human_team_id: stBefore.human_team_id,
    });

    await firstBtn.click({ timeout: 5000 });
    await page.waitForTimeout(1500);

    const stAfter = await (await request.get(`${BASE}/api/state`)).json();
    log('tc3_state_after_click', {
      current_overall: stAfter.current_overall,
      current_team_id: stAfter.current_team_id,
      last_pick: stAfter.recent_picks?.slice(-1)?.[0],
    });
    const clickRegistered = stAfter.current_overall > stBefore.current_overall;
    log('tc3_click_registered', { registered: clickRegistered });
  } else {
    log('tc3_no_buttons', {});
  }
});

// ----------------------------------------------------------------------------
// TC4: Delegation survives AI rounds -- click again on next human turn
// ----------------------------------------------------------------------------
test('TC4: delegation still fires after 7 AI turns', async ({ page, request }) => {
  attachHooks(page, 'tc4');
  await request.post(`${BASE}/api/leagues/switch`, { data: { league_id: OBS_LEAGUE } });
  await page.goto(BASE + '/#/draft', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Advance via server API until human turn again
  for (let i = 0; i < 20; i++) {
    const st = await (await request.get(`${BASE}/api/state`)).json();
    if (st.is_complete) break;
    if (st.current_team_id === st.human_team_id) break;
    await request.post(`${BASE}/api/draft/ai-advance`, { data: {} });
    await page.waitForTimeout(120);
  }
  await page.goto(BASE + '/#/draft', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const delegationProbe2 = await page.evaluate(() => {
    const tbl = document.querySelector('#tbl-available') as HTMLElement | null;
    if (!tbl) return { tblFound: false };
    // Also check: only one listener attached (delegated marker is '1')?
    return {
      tblFound: true,
      delegated: tbl.dataset.draftDelegated,
      btnCount: tbl.querySelectorAll('button[data-draft]').length,
    };
  });
  log('tc4_delegation_marker_after_ai_turns', delegationProbe2);

  const btn = page.locator('#tbl-available button[data-draft]:not([disabled])').first();
  const count = await page.locator('#tbl-available button[data-draft]').count();
  if (count > 0) {
    const stBefore = await (await request.get(`${BASE}/api/state`)).json();
    await btn.click({ timeout: 5000 });
    await page.waitForTimeout(1500);
    const stAfter = await (await request.get(`${BASE}/api/state`)).json();
    log('tc4_after_click', {
      before: stBefore.current_overall,
      after: stAfter.current_overall,
      registered: stAfter.current_overall > stBefore.current_overall,
    });
  }
});

// ----------------------------------------------------------------------------
// TC5: Force re-render via display-mode select, click immediately
// ----------------------------------------------------------------------------
test('TC5: delegation survives display-mode re-render', async ({ page, request }) => {
  attachHooks(page, 'tc5');
  await request.post(`${BASE}/api/leagues/switch`, { data: { league_id: OBS_LEAGUE } });

  // Need human turn again
  for (let i = 0; i < 20; i++) {
    const st = await (await request.get(`${BASE}/api/state`)).json();
    if (st.is_complete) break;
    if (st.current_team_id === st.human_team_id) break;
    await request.post(`${BASE}/api/draft/ai-advance`, { data: {} });
    await page.waitForTimeout(120);
  }
  await page.goto(BASE + '/#/draft', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // Find display-mode select (there is a select with prev_full / current_full options)
  const selectExists = await page.locator('select').filter({ hasText: '上季' }).count();
  log('tc5_select_count', { selectExists });

  // Try toggling any select that has prev_full option
  const toggled = await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll('select')) as HTMLSelectElement[];
    const target = selects.find((s) => Array.from(s.options).some((o) => o.value === 'prev_full'));
    if (!target) return { switched: false };
    const before = target.value;
    const currentIdx = Array.from(target.options).findIndex((o) => o.value === before);
    const otherIdx = Array.from(target.options).findIndex((o) => o.value !== before && /prev_full|current_full/.test(o.value));
    if (otherIdx < 0) return { switched: false, before };
    target.selectedIndex = otherIdx;
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { switched: true, before, after: target.value };
  });
  log('tc5_select_toggled', toggled);
  await page.waitForTimeout(600);

  const delegationProbe3 = await page.evaluate(() => {
    const tbl = document.querySelector('#tbl-available') as HTMLElement | null;
    if (!tbl) return { tblFound: false };
    return {
      tblFound: true,
      delegated: tbl.dataset.draftDelegated,
      btnCount: tbl.querySelectorAll('button[data-draft]').length,
    };
  });
  log('tc5_delegation_after_rerender', delegationProbe3);

  const btn = page.locator('#tbl-available button[data-draft]:not([disabled])').first();
  const count = await page.locator('#tbl-available button[data-draft]').count();
  if (count > 0) {
    const stBefore = await (await request.get(`${BASE}/api/state`)).json();
    await btn.click({ timeout: 5000, force: true });
    await page.waitForTimeout(1500);
    const stAfter = await (await request.get(`${BASE}/api/state`)).json();
    log('tc5_click_after_rerender', {
      before: stBefore.current_overall,
      after: stAfter.current_overall,
      registered: stAfter.current_overall > stBefore.current_overall,
    });
  }
});

// ----------------------------------------------------------------------------
// TC6: Keyboard navigation -- Tab + Enter should activate button
// ----------------------------------------------------------------------------
test('TC6: keyboard activation of draft button', async ({ page, request }) => {
  attachHooks(page, 'tc6');
  await request.post(`${BASE}/api/leagues/switch`, { data: { league_id: OBS_LEAGUE } });

  // Force human turn
  for (let i = 0; i < 20; i++) {
    const st = await (await request.get(`${BASE}/api/state`)).json();
    if (st.is_complete) break;
    if (st.current_team_id === st.human_team_id) break;
    await request.post(`${BASE}/api/draft/ai-advance`, { data: {} });
    await page.waitForTimeout(120);
  }
  await page.goto(BASE + '/#/draft', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const kbResult = await page.evaluate(() => {
    const btn = document.querySelector('#tbl-available button[data-draft]:not([disabled])') as HTMLButtonElement | null;
    if (!btn) return { found: false };
    btn.focus();
    const focused = document.activeElement === btn;
    return { found: true, focused, pid: btn.getAttribute('data-draft') };
  });
  log('tc6_focus_result', kbResult);

  if (kbResult.found && kbResult.focused) {
    const stBefore = await (await request.get(`${BASE}/api/state`)).json();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    const stAfter = await (await request.get(`${BASE}/api/state`)).json();
    log('tc6_enter_result', {
      before: stBefore.current_overall,
      after: stAfter.current_overall,
      registered: stAfter.current_overall > stBefore.current_overall,
    });
  }
});

// ----------------------------------------------------------------------------
// TC7: Disabled-during-AI-turn check -- button should be disabled on AI turn
// ----------------------------------------------------------------------------
test('TC7: buttons disabled on AI turn', async ({ page, request }) => {
  attachHooks(page, 'tc7');
  await request.post(`${BASE}/api/leagues/switch`, { data: { league_id: OBS_LEAGUE } });

  // Ensure we're on an AI turn -- pick until AI turn
  let onAiTurn = false;
  for (let i = 0; i < 30; i++) {
    const st = await (await request.get(`${BASE}/api/state`)).json();
    if (st.is_complete) break;
    if (st.current_team_id !== st.human_team_id) {
      onAiTurn = true;
      break;
    }
    // need to make human do a pick to move to AI -- do a server-side auto-pick
    // fallback: advance one step manually via /api/draft/pick for human
    const avail = (st.available || []).slice(0, 1);
    if (avail.length) {
      await request.post(`${BASE}/api/draft/pick`, { data: { player_id: avail[0].id } });
    } else break;
  }
  log('tc7_state', { onAiTurn });

  await page.goto(BASE + '/#/draft', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const probe = await page.evaluate(() => {
    const tbl = document.querySelector('#tbl-available');
    if (!tbl) return { tblFound: false };
    const all = Array.from(tbl.querySelectorAll('button[data-draft]')) as HTMLButtonElement[];
    const disabledCount = all.filter((b) => b.disabled).length;
    return { tblFound: true, total: all.length, disabledCount };
  });
  log('tc7_button_disabled_on_ai', probe);
});

// ----------------------------------------------------------------------------
// TC8: Lineup slot order check via team details API (read ground truth)
// ----------------------------------------------------------------------------
test('TC8: lineup slot order PG/SG/G/SF/PF/F/C/C/UTIL/UTIL', async ({ request }) => {
  // Use any completed league for slot inspection. Try peer first, then default.
  for (const lid of [PEER_LEAGUE, 'default', 'qa-g2']) {
    const sw = await request.post(`${BASE}/api/leagues/switch`, { data: { league_id: lid } });
    if (sw.status() !== 200) continue;
    for (let tid = 0; tid < 8; tid++) {
      try {
        const r = await request.get(`${BASE}/api/teams/${tid}`);
        if (r.status() !== 200) continue;
        const d = await r.json();
        const slots = (d.lineup_slots || []).map((s: any) => s.slot);
        log('tc8_slots', { lid, tid, slots });
        if (slots.length > 0) {
          const expected = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'C', 'UTIL', 'UTIL'];
          const match = JSON.stringify(slots) === JSON.stringify(expected);
          log('tc8_slot_match', { lid, tid, match, expected, actual: slots });
          return; // recorded once
        }
      } catch (e) {}
    }
  }
  log('tc8_no_slots_found', {});
});

// ----------------------------------------------------------------------------
// TC9: Edge cases -- rapid clicks, scroll-bottom click, last-round click
// ----------------------------------------------------------------------------
test('TC9: rapid double-click should not double-submit', async ({ page, request }) => {
  attachHooks(page, 'tc9');
  await request.post(`${BASE}/api/leagues/switch`, { data: { league_id: OBS_LEAGUE } });

  for (let i = 0; i < 20; i++) {
    const st = await (await request.get(`${BASE}/api/state`)).json();
    if (st.is_complete) break;
    if (st.current_team_id === st.human_team_id) break;
    await request.post(`${BASE}/api/draft/ai-advance`, { data: {} });
    await page.waitForTimeout(120);
  }
  await page.goto(BASE + '/#/draft', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const stBefore = await (await request.get(`${BASE}/api/state`)).json();
  // Rapid clicks on same button
  const btn = page.locator('#tbl-available button[data-draft]:not([disabled])').first();
  const count = await page.locator('#tbl-available button[data-draft]').count();
  log('tc9_count', { count, onHumanTurn: stBefore.current_team_id === stBefore.human_team_id });

  if (count > 0 && stBefore.current_team_id === stBefore.human_team_id) {
    // Fire 5 rapid clicks
    await Promise.all([
      btn.click({ timeout: 5000, force: true, noWaitAfter: true }).catch((e) => log('tc9_c1', { e: String(e) })),
      btn.click({ timeout: 5000, force: true, noWaitAfter: true }).catch((e) => log('tc9_c2', { e: String(e) })),
      btn.click({ timeout: 5000, force: true, noWaitAfter: true }).catch((e) => log('tc9_c3', { e: String(e) })),
    ]);
    await page.waitForTimeout(2500);
    const stAfter = await (await request.get(`${BASE}/api/state`)).json();
    const delta = stAfter.current_overall - stBefore.current_overall;
    log('tc9_rapid_click_result', { before: stBefore.current_overall, after: stAfter.current_overall, delta });
    // delta should be 1 (our pick) + maybe AI auto-advances, but NOT multiple human picks
  }
});
