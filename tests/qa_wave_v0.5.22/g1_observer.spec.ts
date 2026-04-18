import { test, expect, Page } from '@playwright/test';

const BASE = 'https://nbafantasy.cda1234567.com';
const LEAGUE = 'qa-g1';

type NetRec = { url: string; method: string; status: number; ms: number; size: number };

async function switchLeague(page: Page, leagueId: string) {
  // Call API to set active league (backend single-active model)
  const resp = await page.request.post(`${BASE}/api/leagues/switch`, { data: { league_id: leagueId } });
  if (!resp.ok()) {
    // older endpoint?
    await page.request.post(`${BASE}/api/leagues/${leagueId}/activate`);
  }
}

test.describe('G1 Observer — qa-g1', () => {
  test.setTimeout(180_000);
  const consoleMsgs: { type: string; text: string; url?: string }[] = [];
  const pageErrors: string[] = [];
  const net: NetRec[] = [];

  test.beforeEach(async ({ page }) => {
    page.on('console', (m) => consoleMsgs.push({ type: m.type(), text: m.text(), url: m.location()?.url }));
    page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
    page.on('requestfailed', (r) => net.push({ url: r.url(), method: r.method(), status: -1, ms: -1, size: 0 }));
    page.on('response', async (r) => {
      try {
        const req = r.request();
        const timing = r.request().timing?.();
        const t0 = timing?.requestStart ?? 0;
        const t1 = timing?.responseEnd ?? 0;
        const ms = t1 > 0 ? Math.max(0, t1 - t0) : 0;
        const headers = r.headers();
        const size = Number(headers['content-length'] || 0);
        net.push({ url: r.url(), method: req.method(), status: r.status(), ms, size });
      } catch {}
    });
  });

  test('01 api sanity', async ({ request }) => {
    const h = await request.get(`${BASE}/api/health`);
    expect(h.ok()).toBeTruthy();
    const hj = await h.json();
    expect(hj.ok).toBe(true);

    const ls = await request.get(`${BASE}/api/leagues/list`);
    expect(ls.ok()).toBeTruthy();
    const lsj = await ls.json();
    const found = (lsj.leagues || []).find((l: any) => l.league_id === LEAGUE);
    expect(found).toBeTruthy();
  });

  test('02 desktop load + a11y snapshot', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await switchLeague(page, LEAGUE);
    const t0 = Date.now();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const loadMs = Date.now() - t0;
    await page.screenshot({ path: 'screenshots/g1o_01_desktop_load.png', fullPage: true });

    // Collect all buttons and check aria-label coverage
    const buttons = await page.$$eval('button', (els) =>
      els.map((b) => ({
        text: (b.textContent || '').trim().slice(0, 50),
        ariaLabel: b.getAttribute('aria-label'),
        id: b.id,
        visible: !!(b.offsetWidth || b.offsetHeight),
      })),
    );
    const missingAria = buttons.filter((b) => b.visible && !b.ariaLabel && !b.text);
    console.log('BUTTONS_TOTAL', buttons.length, 'MISSING_ARIA_AND_TEXT', missingAria.length);
    console.log('BUTTONS_SAMPLE', JSON.stringify(buttons.slice(0, 20)));
    console.log('DESKTOP_LOAD_MS', loadMs);
  });

  test('03 tab keyboard walk', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await switchLeague(page, LEAGUE);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const stops: { tag: string; id: string; cls: string; aria: string | null; text: string }[] = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        if (!a) return null;
        return {
          tag: a.tagName,
          id: a.id || '',
          cls: a.className || '',
          aria: a.getAttribute('aria-label'),
          text: (a.textContent || '').trim().slice(0, 40),
        };
      });
      if (info) stops.push(info);
    }
    console.log('TAB_ORDER', JSON.stringify(stops, null, 0));
    await page.screenshot({ path: 'screenshots/g1o_02_tab_walk.png', fullPage: false });
  });

  test('04 rwd 375 mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await switchLeague(page, LEAGUE);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.screenshot({ path: 'screenshots/g1o_03_rwd_375.png', fullPage: true });

    // Check for horizontal scroll
    const hasHScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    console.log('MOBILE_375_HSCROLL', hasHScroll);

    // Check text overflow: elements whose scrollWidth > clientWidth within viewport
    const overflow = await page.evaluate(() => {
      const out: any[] = [];
      document.querySelectorAll('*').forEach((el: any) => {
        if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            out.push({
              tag: el.tagName,
              cls: (el.className || '').toString().slice(0, 40),
              sw: el.scrollWidth,
              cw: el.clientWidth,
              txt: (el.textContent || '').trim().slice(0, 30),
            });
          }
        }
      });
      return out.slice(0, 20);
    });
    console.log('MOBILE_OVERFLOW', JSON.stringify(overflow));
  });

  test('05 rwd 768 tablet', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await switchLeague(page, LEAGUE);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.screenshot({ path: 'screenshots/g1o_04_rwd_768.png', fullPage: true });
  });

  test('06 network & console audit', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await switchLeague(page, LEAGUE);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    // Navigate to all routes
    const routes = ['#draft', '#teams', '#fa', '#league', '#schedule'];
    for (const r of routes) {
      await page.evaluate((h) => { location.hash = h; }, r);
      await page.waitForTimeout(800);
    }
    // Summarize network
    const apiReqs = net.filter((n) => n.url.includes('/api/'));
    const slow = apiReqs.filter((n) => n.ms > 500);
    const errs = apiReqs.filter((n) => n.status >= 400);
    console.log('NET_TOTAL', net.length, 'API_CALLS', apiReqs.length, 'SLOW_500', slow.length, 'ERR_4xx5xx', errs.length);
    console.log('SLOW', JSON.stringify(slow.slice(0, 15)));
    console.log('ERR', JSON.stringify(errs.slice(0, 15)));

    console.log('CONSOLE_ALL', consoleMsgs.length);
    const consErrs = consoleMsgs.filter((m) => m.type === 'error');
    const consWarns = consoleMsgs.filter((m) => m.type === 'warning');
    console.log('CONSOLE_ERR', consErrs.length, JSON.stringify(consErrs.slice(0, 10)));
    console.log('CONSOLE_WARN', consWarns.length, JSON.stringify(consWarns.slice(0, 10)));
    console.log('PAGE_ERR', pageErrors.length, JSON.stringify(pageErrors.slice(0, 10)));
  });

  test('07 data consistency UI vs API', async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await switchLeague(page, LEAGUE);
    await page.goto(BASE, { waitUntil: 'networkidle' });

    const apiState = await (await request.get(`${BASE}/api/state`)).json();
    const apiNames: string[] = (apiState.teams || []).map((t: any) => t.name);

    // Try to find team names in UI (teams view)
    await page.evaluate(() => { location.hash = '#teams'; });
    await page.waitForTimeout(1500);
    const uiText = await page.evaluate(() => document.body.innerText);
    const missing = apiNames.filter((n) => !uiText.includes(n));
    console.log('API_TEAM_NAMES', JSON.stringify(apiNames));
    console.log('UI_MISSING_NAMES', JSON.stringify(missing));
    await page.screenshot({ path: 'screenshots/g1o_05_teams_view.png', fullPage: true });
  });

  test('08 concurrency read state during other activity', async ({ request }) => {
    // Snapshot state 10 times in quick succession; capture picks and current_overall progression.
    const samples: any[] = [];
    for (let i = 0; i < 12; i++) {
      const s = await (await request.get(`${BASE}/api/state`)).json();
      samples.push({
        t: Date.now(),
        picks: s.picks?.length || 0,
        overall: s.current_overall,
        team: s.current_team_id,
        avail: s.available_count,
        complete: s.is_complete,
      });
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log('CONCURRENT_SAMPLES', JSON.stringify(samples));
  });

  test('09 contrast spot check', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await switchLeague(page, LEAGUE);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const contrastHits = await page.evaluate(() => {
      function parseRgb(s: string): [number, number, number] | null {
        const m = s.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const parts = m[1].split(',').map((x) => parseFloat(x.trim()));
        return [parts[0], parts[1], parts[2]];
      }
      function lum([r, g, b]: [number, number, number]) {
        const a = [r, g, b].map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
      }
      function cr(fg: any, bg: any) {
        const l1 = lum(fg), l2 = lum(bg);
        const [a, b] = l1 > l2 ? [l1, l2] : [l2, l1];
        return (a + 0.05) / (b + 0.05);
      }
      const bad: any[] = [];
      const els = document.querySelectorAll('button, a, .setting-sub, .nav-label, .tab-lbl, .app-version, .conn-text, .setup-hint, small, .lsw-label, .hh-dot');
      els.forEach((el: any) => {
        const cs = getComputedStyle(el);
        const fg = parseRgb(cs.color);
        let bgEl: any = el;
        let bg: any = null;
        while (bgEl) {
          const b = parseRgb(getComputedStyle(bgEl).backgroundColor);
          if (b && getComputedStyle(bgEl).backgroundColor !== 'rgba(0, 0, 0, 0)') { bg = b; break; }
          bgEl = bgEl.parentElement;
        }
        if (!fg || !bg) return;
        const ratio = cr(fg, bg);
        if (ratio < 4.5) {
          const txt = (el.textContent || '').trim().slice(0, 30);
          if (txt) bad.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 30), ratio: Math.round(ratio * 100) / 100, txt });
        }
      });
      return bad.slice(0, 30);
    });
    console.log('CONTRAST_BAD', contrastHits.length, JSON.stringify(contrastHits));
  });
});
