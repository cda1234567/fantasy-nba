import { test, expect, Page, Request, Response } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const SITE = 'https://nbafantasy.cda1234567.com';
const SHOT_DIR = path.resolve(__dirname, 'screenshots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

type NetEntry = {
  url: string;
  method: string;
  status: number;
  ms: number;
  bytes: number;
  type: string;
  failure?: string;
};

const capture = {
  consoleErrors: [] as string[],
  consoleWarnings: [] as string[],
  pageErrors: [] as string[],
  network: [] as NetEntry[],
  apiStateSnapshots: [] as any[],
};

async function attachObservers(page: Page) {
  page.on('console', (msg) => {
    const type = msg.type();
    const text = `[${type}] ${msg.text()}`;
    if (type === 'error') capture.consoleErrors.push(text);
    else if (type === 'warning') capture.consoleWarnings.push(text);
  });
  page.on('pageerror', (err) => {
    capture.pageErrors.push(`${err.name}: ${err.message}`);
  });
  const reqStart = new Map<Request, number>();
  page.on('request', (req) => reqStart.set(req, Date.now()));
  page.on('requestfailed', (req) => {
    capture.network.push({
      url: req.url(),
      method: req.method(),
      status: 0,
      ms: Date.now() - (reqStart.get(req) || Date.now()),
      bytes: 0,
      type: req.resourceType(),
      failure: req.failure()?.errorText || 'failed',
    });
  });
  page.on('response', async (res: Response) => {
    const req = res.request();
    const start = reqStart.get(req) || Date.now();
    let bytes = 0;
    try {
      const buf = await res.body();
      bytes = buf.length;
    } catch {}
    capture.network.push({
      url: res.url(),
      method: req.method(),
      status: res.status(),
      ms: Date.now() - start,
      bytes,
      type: req.resourceType(),
    });
  });
}

test.describe('g3 observer - nbafantasy QA', () => {
  test.setTimeout(180_000);

  test('full audit sweep', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await attachObservers(page);

    // --- 1. Load + baseline
    const t0 = Date.now();
    const resp = await page.goto(SITE, { waitUntil: 'networkidle' });
    const loadMs = Date.now() - t0;
    expect(resp?.status(), 'home 200').toBe(200);
    await page.screenshot({ path: path.join(SHOT_DIR, 'g3o_01_home_1280.png'), fullPage: true });

    // --- 2. Direct API audit
    const apiState1 = await page.evaluate(async () => {
      const r = await fetch('/api/state');
      return { status: r.status, json: await r.json() };
    });
    const apiPlayers = await page.evaluate(async () => {
      const r = await fetch('/api/players');
      return { status: r.status, count: (await r.json()).length };
    });
    const apiPersonas = await page.evaluate(async () => {
      const r = await fetch('/api/personas');
      const j = await r.json();
      return { status: r.status, keys: Object.keys(j) };
    });
    capture.apiStateSnapshots.push(apiState1.json);

    // --- 3. A11y baseline
    const a11y = await page.evaluate(() => {
      const out: any = {
        imgNoAlt: [] as string[],
        buttonsNoLabel: [] as string[],
        inputsNoLabel: [] as string[],
        linksNoText: [] as string[],
        lowContrast: [] as string[],
        missingLang: !document.documentElement.lang,
        missingTitle: !document.title,
        h1Count: document.querySelectorAll('h1').length,
        landmarks: {
          main: document.querySelectorAll('main,[role="main"]').length,
          nav: document.querySelectorAll('nav,[role="navigation"]').length,
          header: document.querySelectorAll('header,[role="banner"]').length,
        },
        ariaInvalidRoles: [] as string[],
        focusableCount: document.querySelectorAll('a,button,input,select,textarea,[tabindex]').length,
      };
      document.querySelectorAll('img').forEach((el, i) => {
        if (!el.getAttribute('alt') && el.getAttribute('alt') !== '')
          out.imgNoAlt.push(`img#${i} ${(el as HTMLImageElement).src.slice(0, 80)}`);
      });
      document.querySelectorAll('button').forEach((el, i) => {
        const t = (el.textContent || '').trim();
        const al = el.getAttribute('aria-label');
        const albb = el.getAttribute('aria-labelledby');
        if (!t && !al && !albb) out.buttonsNoLabel.push(`btn#${i} ${el.outerHTML.slice(0, 120)}`);
      });
      document.querySelectorAll('input,select,textarea').forEach((el, i) => {
        const id = el.getAttribute('id');
        const hasLabel = id && document.querySelector(`label[for="${id}"]`);
        const al = el.getAttribute('aria-label');
        const albb = el.getAttribute('aria-labelledby');
        if (!hasLabel && !al && !albb)
          out.inputsNoLabel.push(`${el.tagName.toLowerCase()}#${i} ${el.outerHTML.slice(0, 120)}`);
      });
      document.querySelectorAll('a').forEach((el, i) => {
        const t = (el.textContent || '').trim();
        const al = el.getAttribute('aria-label');
        if (!t && !al) out.linksNoText.push(`a#${i} ${(el as HTMLAnchorElement).href}`);
      });

      // contrast check — sample buttons + key text
      const rgb = (s: string) => {
        const m = s.match(/\d+/g);
        return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
      };
      const lum = ([r, g, b]: number[]) => {
        const f = (c: number) => {
          c = c / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (a: number[], b: number[]) => {
        const la = lum(a), lb = lum(b);
        const [hi, lo] = la > lb ? [la, lb] : [lb, la];
        return (hi + 0.05) / (lo + 0.05);
      };
      const sample = Array.from(document.querySelectorAll('button,a,span,div,td,th,p,label')).slice(0, 200);
      sample.forEach((el, i) => {
        const cs = getComputedStyle(el as Element);
        const fg = rgb(cs.color);
        let bgEl: Element | null = el as Element;
        let bg = rgb(cs.backgroundColor);
        let bgStr = cs.backgroundColor;
        while (bgEl && (bgStr === 'rgba(0, 0, 0, 0)' || bgStr === 'transparent')) {
          bgEl = bgEl.parentElement;
          if (!bgEl) break;
          bgStr = getComputedStyle(bgEl).backgroundColor;
          bg = rgb(bgStr);
        }
        const text = (el.textContent || '').trim().slice(0, 30);
        if (!text) return;
        const r = ratio(fg, bg);
        if (r < 4.5) {
          out.lowContrast.push(
            `${el.tagName.toLowerCase()}#${i} ratio=${r.toFixed(2)} fg=${cs.color} bg=${bgStr} txt="${text}"`,
          );
        }
      });
      return out;
    });

    // --- 4. Keyboard tab focus order
    const tabOrder: string[] = [];
    await page.keyboard.press('Tab');
    for (let i = 0; i < 25; i++) {
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 40),
          id: el.id || null,
          outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor,
          boxShadow: cs.boxShadow,
        };
      });
      if (info) tabOrder.push(JSON.stringify(info));
      await page.keyboard.press('Tab');
    }

    // --- 5. RWD screenshots
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOT_DIR, 'g3o_02_mobile_375.png'), fullPage: true });
    const mobileOverflow = await page.evaluate(() => {
      const de = document.documentElement;
      return { scrollW: de.scrollWidth, clientW: de.clientWidth, overflowX: de.scrollWidth > de.clientWidth };
    });
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOT_DIR, 'g3o_03_tablet_768.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);

    // --- 6. Perf timing for /api/state
    const apiTimings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await page.evaluate(async () => {
        const t = performance.now();
        const res = await fetch('/api/state');
        await res.json();
        return performance.now() - t;
      });
      apiTimings.push(r);
    }

    // --- 7. Concurrency: 10 parallel /api/state reads
    const concurrency = await page.evaluate(async () => {
      const t = performance.now();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => fetch('/api/state').then((r) => r.json())),
      );
      const signature = (s: any) =>
        `${s.current_overall}-${s.current_team_id}-${s.is_complete}-${s.available_count}-${s.picks.length}`;
      const sigs = new Set(results.map(signature));
      return { ms: performance.now() - t, uniqueSignatures: [...sigs], count: results.length };
    });

    // --- 8. Data consistency: UI roster count vs /api/state roster count
    // Try to find a draft button; if the user is team 0 and on the clock.
    const uiVsState = await page.evaluate(async () => {
      const state = await fetch('/api/state').then((r) => r.json());
      const rostersInUi = Array.from(document.querySelectorAll('[data-team-id],[class*="team"],[class*="roster"]')).length;
      return {
        stateTeamCount: state.teams.length,
        stateRosterSizes: state.teams.map((t: any) => t.roster.length),
        uiTeamLikeEls: rostersInUi,
        stateAvailable: state.available_count,
        statePicks: state.picks.length,
        stateBoardCells: state.board.flat().length,
      };
    });

    // --- 9. HTML / semantic snapshot
    const htmlMeta = await page.evaluate(() => ({
      title: document.title,
      lang: document.documentElement.lang,
      viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') || null,
      charset: document.characterSet,
      h1: Array.from(document.querySelectorAll('h1')).map((h) => h.textContent?.trim()),
      h2Count: document.querySelectorAll('h2').length,
      scriptsInline: Array.from(document.querySelectorAll('script:not([src])')).length,
      scriptsExternal: Array.from(document.querySelectorAll('script[src]')).map((s) => (s as HTMLScriptElement).src),
      stylesheets: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((s) => (s as HTMLLinkElement).href),
      bodyBytes: document.documentElement.outerHTML.length,
    }));

    // --- Write raw artifact
    const artifact = {
      siteLoadMs: loadMs,
      apiState: { status: apiState1.status, teams: apiState1.json.teams.length, picks: apiState1.json.picks.length },
      apiPlayersCount: apiPlayers.count,
      apiPersonas,
      a11y,
      tabOrder,
      mobileOverflow,
      apiTimingsMs: apiTimings,
      concurrency,
      uiVsState,
      htmlMeta,
      consoleErrors: capture.consoleErrors,
      consoleWarnings: capture.consoleWarnings,
      pageErrors: capture.pageErrors,
      network: capture.network,
    };
    fs.writeFileSync(path.join(__dirname, 'g3_observer_raw.json'), JSON.stringify(artifact, null, 2));

    // Soft expectations (don't fail test — we need the report)
    expect(apiState1.status).toBe(200);
    expect(apiPlayers.count).toBeGreaterThan(0);

    await ctx.close();
  });
});
