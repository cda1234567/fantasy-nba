import { test, expect, Page, Request, Response } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE = 'https://nbafantasy.cda1234567.com';
const LEAGUE_ID = 'qa-g2';
const SHOT_DIR = path.join(__dirname, 'screenshots');
const LOG_PATH = path.join(__dirname, '_g2_observer_log.json');

type LogEntry = {
  ts: number;
  kind: string;
  data: any;
};

const logs: LogEntry[] = [];
function log(kind: string, data: any) {
  logs.push({ ts: Date.now(), kind, data });
}

function attachHooks(page: Page, tag: string) {
  page.on('console', (msg) => {
    log('console', { tag, type: msg.type(), text: msg.text().slice(0, 500) });
  });
  page.on('pageerror', (err) => {
    log('pageerror', { tag, msg: err.message });
  });
  page.on('requestfailed', (req) => {
    log('requestfailed', { tag, url: req.url(), err: req.failure()?.errorText });
  });
  page.on('response', async (resp: Response) => {
    const url = resp.url();
    if (!url.includes('/api/')) return;
    const req: Request = resp.request();
    const timing = resp.request().timing();
    log('api', {
      tag,
      url,
      method: req.method(),
      status: resp.status(),
      duration_ms: Math.round((timing.responseEnd - timing.startTime) || 0),
    });
  });
}

test.beforeAll(() => {
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
});

test.afterAll(() => {
  fs.writeFileSync(LOG_PATH, JSON.stringify(logs, null, 2), 'utf-8');
});

test('G2 Observer: wait for qa-g2 league', async ({ request }) => {
  const start = Date.now();
  const deadline = start + 5 * 60 * 1000;
  let found = false;
  while (Date.now() < deadline) {
    const r = await request.get(`${BASE}/api/leagues/list`);
    const j = await r.json();
    const names: string[] = (j.leagues || []).map((l: any) => l.league_id);
    log('poll', { t: Date.now() - start, names });
    if (names.includes(LEAGUE_ID)) {
      found = true;
      break;
    }
    await new Promise((res) => setTimeout(res, 15_000));
  }
  log('poll_done', { found, elapsed: Date.now() - start });
  // Don't fail if missing — observer still inspects whatever is there.
});

test('G2 Observer: API correctness & schema', async ({ request }) => {
  const endpoints = [
    '/api/health',
    '/api/leagues/list',
    '/api/league/status',
    '/api/league/settings',
    '/api/state',
    '/api/seasons/list',
  ];
  for (const ep of endpoints) {
    const t0 = Date.now();
    const r = await request.get(`${BASE}${ep}`);
    const ms = Date.now() - t0;
    let body: any = null;
    try {
      body = await r.json();
    } catch {
      body = await r.text();
    }
    log('api_probe', {
      ep,
      status: r.status(),
      ms,
      bytes: JSON.stringify(body).length,
      keys: body && typeof body === 'object' ? Object.keys(body).slice(0, 20) : null,
    });
  }

  // Probe active league switch to qa-g2 if present
  const list = await (await request.get(`${BASE}/api/leagues/list`)).json();
  log('leagues_snapshot', list);

  if ((list.leagues || []).some((l: any) => l.league_id === LEAGUE_ID)) {
    const sw = await request.post(`${BASE}/api/leagues/switch`, {
      data: { league_id: LEAGUE_ID },
    });
    log('switch_g2', { status: sw.status(), body: await sw.text() });
    const st = await (await request.get(`${BASE}/api/state`)).json();
    log('state_after_switch', {
      teams: st.teams?.length,
      total_rounds: st.total_rounds,
      num_teams: st.num_teams,
      current_overall: st.current_overall,
      is_complete: st.is_complete,
      available_count: st.available_count,
    });
  }

  // Error-path probes
  const bogus = await request.post(`${BASE}/api/leagues/switch`, {
    data: { league_id: '__NOT_EXIST__' },
  });
  log('switch_bogus', { status: bogus.status(), body: (await bogus.text()).slice(0, 300) });

  const badHead = await request.get(`${BASE}/api/seasons/9999-00/headlines`);
  log('headlines_bad_year', { status: badHead.status(), body: (await badHead.text()).slice(0, 300) });
});

test('G2 Observer: DOM a11y, console, network, visual @ desktop', async ({ page }) => {
  attachHooks(page, 'desk');

  const nav = await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  log('nav', { status: nav?.status() });

  await page.screenshot({ path: path.join(SHOT_DIR, 'g2o_01_home_1280.png'), fullPage: true });

  // ---- A11y / DOM extraction in-browser ----
  const a11y = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll<HTMLElement>('*'));
    const buttons = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input, select, textarea'));

    const btnWithoutLabel = buttons.filter((b) => {
      const lbl = b.getAttribute('aria-label') || b.getAttribute('aria-labelledby') || b.textContent?.trim();
      return !lbl || lbl.length === 0;
    }).map((b) => ({ id: b.id, cls: b.className, outer: b.outerHTML.slice(0, 200) }));

    const inputsNoLabel = inputs.filter((i) => {
      const id = i.id;
      const label = id ? document.querySelector(`label[for="${id}"]`) : null;
      const aria = i.getAttribute('aria-label') || i.getAttribute('aria-labelledby');
      const wrapped = i.closest('label');
      return !label && !aria && !wrapped;
    }).map((i) => ({ id: i.id, name: i.name, type: i.type, outer: i.outerHTML.slice(0, 200) }));

    // Contrast probe: collect foreground/background colors on small text
    function parseRgb(s: string): [number, number, number, number] | null {
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1].split(',').map((x) => parseFloat(x.trim()));
      return [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts[3] == null ? 1 : parts[3]];
    }
    function lum(rgb: [number, number, number]): number {
      const [r, g, b] = rgb.map((v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    function contrast(a: [number, number, number], b: [number, number, number]): number {
      const L1 = lum(a), L2 = lum(b);
      const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
      return (hi + 0.05) / (lo + 0.05);
    }
    function bgOf(el: HTMLElement): [number, number, number] {
      let cur: HTMLElement | null = el;
      while (cur) {
        const c = getComputedStyle(cur).backgroundColor;
        const p = parseRgb(c);
        if (p && p[3] > 0.01) return [p[0], p[1], p[2]];
        cur = cur.parentElement;
      }
      return [13, 17, 23]; // page theme-color fallback
    }

    const lowContrast: any[] = [];
    const textNodes = all.filter((el) => {
      if (!el.textContent) return false;
      const txt = el.textContent.trim();
      if (!txt || txt.length > 80) return false;
      // leaf-ish
      return Array.from(el.childNodes).every((n) => n.nodeType === Node.TEXT_NODE || (n as HTMLElement).tagName === 'SPAN');
    }).slice(0, 300);
    for (const el of textNodes) {
      const cs = getComputedStyle(el);
      const fg = parseRgb(cs.color);
      if (!fg) continue;
      const bg = bgOf(el);
      const ratio = contrast([fg[0], fg[1], fg[2]], bg);
      const fs = parseFloat(cs.fontSize);
      if (ratio < 4.5 && fs < 18) {
        lowContrast.push({
          tag: el.tagName,
          id: el.id,
          cls: el.className?.toString?.().slice(0, 80),
          text: el.textContent?.trim().slice(0, 60),
          fg: cs.color,
          bg: `rgb(${bg.join(',')})`,
          ratio: Math.round(ratio * 100) / 100,
          fontSize: fs,
        });
      }
    }

    // Role/landmark audit
    const landmarks = {
      header: !!document.querySelector('[role="banner"], header'),
      nav: document.querySelectorAll('[role="navigation"], nav').length,
      main: !!document.querySelector('main, [role="main"]'),
      complementary: !!document.querySelector('aside, [role="complementary"]'),
    };

    // Dialogs
    const dialogs = Array.from(document.querySelectorAll('dialog')).map((d) => ({
      id: d.id,
      ariaLabel: d.getAttribute('aria-label'),
      ariaLabelledby: d.getAttribute('aria-labelledby'),
      role: d.getAttribute('role'),
    }));

    // Focusable count
    const focusables = document.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input:not([disabled]), select, textarea');

    return {
      totalEls: all.length,
      btnWithoutLabel,
      inputsNoLabel,
      lowContrast: lowContrast.slice(0, 40),
      lowContrastCount: lowContrast.length,
      landmarks,
      dialogs,
      focusables: focusables.length,
      title: document.title,
      lang: document.documentElement.lang,
    };
  });
  log('a11y_desktop', a11y);

  // ---- Keyboard nav test ----
  await page.keyboard.press('Tab');
  const firstFocus = await page.evaluate(() => {
    const e = document.activeElement as HTMLElement;
    return { tag: e?.tagName, id: e?.id, text: e?.textContent?.trim().slice(0, 50) };
  });
  log('focus_first', firstFocus);

  // Tab through 15 stops, record
  const stops: any[] = [];
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
    const cur = await page.evaluate(() => {
      const e = document.activeElement as HTMLElement | null;
      if (!e) return null;
      const r = e.getBoundingClientRect();
      const hasOutline = getComputedStyle(e).outlineStyle !== 'none' && getComputedStyle(e).outlineWidth !== '0px';
      return {
        tag: e.tagName,
        id: e.id,
        role: e.getAttribute('role'),
        aria: e.getAttribute('aria-label'),
        visible: r.width > 0 && r.height > 0,
        outline: getComputedStyle(e).outline,
        hasOutline,
      };
    });
    stops.push(cur);
  }
  log('keyboard_tab_stops', stops);

  // ---- Switch to qa-g2 via UI if present ----
  // Open menu
  try {
    const lswBtn = page.locator('#btn-league-switch');
    await lswBtn.click({ timeout: 3000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOT_DIR, 'g2o_02_league_menu.png') });
    const items = await page.locator('#league-switch-menu [role="menuitem"], #league-switch-menu button').allTextContents();
    log('league_menu_items', items);
  } catch (e: any) {
    log('league_menu_err', { msg: e.message });
  }

  // Navigate routes
  for (const route of ['#draft', '#teams', '#fa', '#league', '#schedule']) {
    await page.goto(BASE + '/' + route, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(600);
    const shot = `g2o_route_${route.replace('#', '')}.png`;
    await page.screenshot({ path: path.join(SHOT_DIR, shot), fullPage: true });
    const main = await page.locator('#main-view').innerText().catch(() => '');
    log('route_snapshot', { route, text: main.slice(0, 400) });
  }
});

test('G2 Observer: responsive 375/768', async ({ browser }) => {
  for (const [w, h, tag] of [[375, 812, 'mobile'], [768, 1024, 'tablet']] as const) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    attachHooks(page, tag);
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(SHOT_DIR, `g2o_rwd_${tag}.png`), fullPage: true });
    const overflow = await page.evaluate(() => {
      const docW = document.documentElement.scrollWidth;
      const winW = window.innerWidth;
      const offenders: any[] = [];
      document.querySelectorAll<HTMLElement>('*').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.right > winW + 2) offenders.push({ tag: el.tagName, id: el.id, cls: el.className?.toString?.().slice(0, 60), right: Math.round(r.right) });
      });
      return { docW, winW, hOverflow: docW > winW, offenders: offenders.slice(0, 15) };
    });
    log('rwd', { tag, overflow });
    const bottomTabsVisible = await page.locator('#bottom-tabs').isVisible().catch(() => false);
    const sideNavVisible = await page.locator('#side-nav').isVisible().catch(() => false);
    log('rwd_nav', { tag, bottomTabsVisible, sideNavVisible });
    await ctx.close();
  }
});

test('G2 Observer: UI vs /api/state consistency + concurrency', async ({ page, request, browser }) => {
  attachHooks(page, 'consistency');
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });

  // Try to switch to qa-g2 if it exists
  const list = await (await request.get(`${BASE}/api/leagues/list`)).json();
  const hasG2 = (list.leagues || []).some((l: any) => l.league_id === LEAGUE_ID);
  if (hasG2) {
    await request.post(`${BASE}/api/leagues/switch`, { data: { league_id: LEAGUE_ID } });
    await page.reload({ waitUntil: 'networkidle' });
  }

  const apiState = await (await request.get(`${BASE}/api/state`)).json();
  const uiCurrent = await page.locator('#lsw-current').innerText().catch(() => '');
  const uiVersion = await page.locator('#app-version').innerText().catch(() => '');
  log('consistency', {
    hasG2,
    uiCurrent,
    uiVersion,
    api_num_teams: apiState.num_teams,
    api_current_overall: apiState.current_overall,
    api_team0_name: apiState.teams?.[0]?.name,
    api_is_complete: apiState.is_complete,
  });

  // Concurrency: 10 parallel /api/state while UI is also polling
  const ts = Date.now();
  const settled = await Promise.all(
    Array.from({ length: 10 }).map(async (_, i) => {
      const t0 = Date.now();
      const r = await request.get(`${BASE}/api/state`);
      const j = await r.json();
      return {
        i,
        status: r.status(),
        ms: Date.now() - t0,
        overall: j.current_overall,
        team0: j.teams?.[0]?.name,
      };
    }),
  );
  log('concurrency_state', { duration_ms: Date.now() - ts, settled });

  // Concurrency: same league settings POST (no-op) while reading
  const writeTs = Date.now();
  const writeResults = await Promise.all(
    Array.from({ length: 5 }).map(async (_, i) => {
      const r = await request.post(`${BASE}/api/league/settings`, { data: {} });
      return { i, status: r.status() };
    }),
  );
  log('concurrency_settings_noop', { duration_ms: Date.now() - writeTs, writeResults });

  // Cross-tab observer: open a second context while reading state
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  attachHooks(p2, 'tab2');
  await p2.goto(BASE + '/', { waitUntil: 'networkidle' });
  const [s1, s2] = await Promise.all([
    request.get(`${BASE}/api/state`).then((r) => r.json()),
    p2.evaluate(async () => (await fetch('/api/state')).json()),
  ]);
  log('cross_tab_state', {
    s1_overall: s1.current_overall,
    s2_overall: s2.current_overall,
    match: s1.current_overall === s2.current_overall,
  });
  await ctx2.close();
});
