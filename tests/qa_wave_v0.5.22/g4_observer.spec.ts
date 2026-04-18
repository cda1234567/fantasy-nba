/**
 * Group 4 Observer Spec — nbafantasy.cda1234567.com v0.5.22
 * Headless. Observes qa-g4 league for API / A11y / Console / Network / Visual / Data / Concurrency.
 */
import { test, expect, Page, Request, Response, ConsoleMessage } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE = 'https://nbafantasy.cda1234567.com';
const LEAGUE = 'qa-g4';
const SHOTS = path.join(__dirname, 'screenshots');
const REPORT: Record<string, any> = { api: [], a11y: [], console: [], network: [], visual: [], data: [], concurrency: [] };

fs.mkdirSync(SHOTS, { recursive: true });

test.setTimeout(180_000);
test.use({ ignoreHTTPSErrors: true });

// -------- helpers --------
async function apiGet(page: Page, p: string) {
  const t0 = Date.now();
  const r = await page.request.get(BASE + p);
  const ms = Date.now() - t0;
  let body: any = null;
  try { body = await r.json(); } catch { body = await r.text().catch(()=>null); }
  return { status: r.status(), ms, body, headers: r.headers() };
}
async function apiPost(page: Page, p: string, data: any) {
  const t0 = Date.now();
  const r = await page.request.post(BASE + p, { data });
  const ms = Date.now() - t0;
  let body: any = null;
  try { body = await r.json(); } catch { body = await r.text().catch(()=>null); }
  return { status: r.status(), ms, body, headers: r.headers() };
}

async function ensureLeague(page: Page) {
  const list = await apiGet(page, '/api/leagues/list');
  const found = (list.body?.leagues||[]).find((l:any)=>l.league_id===LEAGUE);
  if (!found) {
    // create minimally so observer can still work
    const c = await apiPost(page, '/api/leagues/create', { league_id: LEAGUE, name: LEAGUE });
    REPORT.api.push({ note: 'fallback-created qa-g4', status: c.status });
  }
  const sw = await apiPost(page, '/api/leagues/switch', { league_id: LEAGUE });
  REPORT.api.push({ endpoint: '/api/leagues/switch', status: sw.status, ms: sw.ms });
}

// -------- main spec --------
test('G4 Observer', async ({ browser }) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  const consoleMsgs: {type:string,text:string,location?:string}[] = [];
  const pageErrors: string[] = [];
  const netEvents: {url:string,status:number,ms:number,method:string,size:number}[] = [];
  const reqStart: Map<string, number> = new Map();

  page.on('console', (m: ConsoleMessage) => {
    consoleMsgs.push({ type: m.type(), text: m.text(), location: JSON.stringify(m.location()) });
  });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('request', (r: Request) => reqStart.set(r.url()+r.method(), Date.now()));
  page.on('response', async (r: Response) => {
    const key = r.url() + r.request().method();
    const ms = Date.now() - (reqStart.get(key) || Date.now());
    let size = 0; try { const b = await r.body(); size = b.length; } catch {}
    netEvents.push({ url: r.url(), status: r.status(), ms, method: r.request().method(), size });
  });

  await ensureLeague(page);

  // ===== Navigate =====
  const navStart = Date.now();
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  const navMs = Date.now() - navStart;
  REPORT.network.push({ nav: '/', ms: navMs });
  await page.screenshot({ path: path.join(SHOTS, 'g4o_01_home.png'), fullPage: true });

  // ===== A11y pass =====
  const a11y = await page.evaluate(() => {
    const out: any[] = [];
    // buttons missing accessible names
    document.querySelectorAll('button, [role="button"]').forEach((el, i) => {
      const al = el.getAttribute('aria-label');
      const txt = (el as HTMLElement).innerText?.trim();
      const title = el.getAttribute('title');
      if (!al && !txt && !title) out.push({ kind:'btn-no-name', idx:i, html: (el as HTMLElement).outerHTML.slice(0,180) });
    });
    // inputs missing labels
    document.querySelectorAll('input, select, textarea').forEach((el, i) => {
      const id = el.getAttribute('id');
      const al = el.getAttribute('aria-label');
      const lbl = id ? document.querySelector(`label[for="${id}"]`) : null;
      if (!al && !lbl && !el.getAttribute('placeholder')) out.push({ kind:'input-no-label', idx:i, html: (el as HTMLElement).outerHTML.slice(0,180) });
    });
    // images without alt
    document.querySelectorAll('img').forEach((el, i) => {
      if (!el.hasAttribute('alt')) out.push({ kind:'img-no-alt', idx:i, src: (el as HTMLImageElement).src });
    });
    // h1 count
    const h1s = document.querySelectorAll('h1').length;
    // tabindex>0 (anti-pattern)
    document.querySelectorAll('[tabindex]').forEach((el) => {
      const t = parseInt(el.getAttribute('tabindex')||'0', 10);
      if (t > 0) out.push({ kind:'tabindex-gt-0', tabindex: t, html: (el as HTMLElement).outerHTML.slice(0,160) });
    });
    // dialogs w/o aria-modal
    document.querySelectorAll('dialog').forEach((el, i) => {
      if (!el.hasAttribute('aria-modal')) out.push({ kind:'dialog-no-aria-modal', idx:i, id: el.id });
    });
    return { findings: out, h1Count: h1s, lang: document.documentElement.lang };
  });
  REPORT.a11y.push(a11y);

  // focus ring check on first button
  try {
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      const cs = window.getComputedStyle(el);
      return { tag: el.tagName, id: el.id, outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor, boxShadow: cs.boxShadow };
    });
    REPORT.a11y.push({ focusAfterTab: active });
  } catch (e) { REPORT.a11y.push({ focusErr: String(e) }); }

  // contrast sample
  const contrast = await page.evaluate(() => {
    function lum(rgb: number[]) {
      const [r,g,b] = rgb.map(v => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
      return 0.2126*r + 0.7152*g + 0.0722*b;
    }
    function parse(c: string): number[] { const m = c.match(/\d+/g); return m ? m.slice(0,3).map(Number) : [0,0,0]; }
    const samples: any[] = [];
    const nodes = Array.from(document.querySelectorAll('button, a, h1, h2, .app-title, .conn-text, label, span')).slice(0, 50);
    for (const n of nodes) {
      const cs = getComputedStyle(n as Element);
      const fg = parse(cs.color);
      // walk up to find non-transparent bg
      let bgEl: Element | null = n as Element; let bg: number[] = [13,17,23];
      while (bgEl) {
        const b = getComputedStyle(bgEl).backgroundColor;
        if (b && !b.includes('rgba(0, 0, 0, 0)') && !b.includes('transparent')) { bg = parse(b); break; }
        bgEl = bgEl.parentElement;
      }
      const l1 = lum(fg), l2 = lum(bg);
      const ratio = (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);
      if (ratio < 4.5) samples.push({ tag: (n as HTMLElement).tagName, text: (n as HTMLElement).innerText?.slice(0,30), ratio: +ratio.toFixed(2), fg: cs.color, fontSize: cs.fontSize });
    }
    return samples.slice(0, 20);
  });
  REPORT.visual.push({ lowContrast: contrast });

  // ===== RWD =====
  for (const vp of [{w:375,h:812,name:'mobile'},{w:768,h:1024,name:'tablet'},{w:1280,h:800,name:'desktop'}]) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => ({
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    }));
    REPORT.visual.push({ viewport: vp.name, ...overflow });
    await page.screenshot({ path: path.join(SHOTS, `g4o_rwd_${vp.name}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // ===== API correctness =====
  const endpoints = [
    '/api/health', '/api/state', '/api/league/status', '/api/league/settings',
    '/api/leagues/list', '/api/personas', '/api/players',
    '/api/season/standings', '/api/season/schedule', '/api/season/logs',
    '/api/season/lineup-alerts', '/api/season/summary', '/api/season/activity',
    '/api/injuries/active', '/api/injuries/history',
    '/api/fa/claim-status', '/api/trades/pending', '/api/trades/history',
    '/api/seasons/list',
  ];
  for (const ep of endpoints) {
    const r = await apiGet(page, ep);
    REPORT.api.push({ endpoint: ep, status: r.status, ms: r.ms, keys: r.body && typeof r.body === 'object' ? Object.keys(r.body).slice(0,10) : null, bodySize: JSON.stringify(r.body||'').length });
  }

  // invalid params / 404 surfaces
  for (const bad of ['/api/teams/999', '/api/teams/-1', '/api/season/lineup/999', '/api/seasons/9999/headlines', '/api/nonexistent']) {
    const r = await apiGet(page, bad);
    REPORT.api.push({ bad, status: r.status, ms: r.ms, body: typeof r.body === 'string' ? r.body.slice(0,120) : r.body });
  }

  // ===== Data consistency UI vs /api/state =====
  const state = (await apiGet(page, '/api/state')).body;
  const uiTitle = await page.locator('.app-title').innerText().catch(()=>null);
  const uiVer = await page.locator('#app-version').innerText().catch(()=>null);
  const uiLeague = await page.locator('#lsw-current').innerText().catch(()=>null);
  REPORT.data.push({
    uiTitle, uiVer, uiLeague,
    stateNumTeams: state?.num_teams, stateTotalRounds: state?.total_rounds,
    stateCurrentOverall: state?.current_overall, stateIsComplete: state?.is_complete,
    teamsLen: state?.teams?.length, boardRows: state?.board?.length,
    consistencyIssue: state?.teams?.length !== state?.num_teams ? 'teams.length != num_teams' : null,
  });

  // ===== Concurrency =====
  const concStart = Date.now();
  const results = await Promise.all(Array.from({length: 10}, () => apiGet(page, '/api/state')));
  const concMs = Date.now() - concStart;
  const statuses = results.map(r=>r.status);
  const bodies = results.map(r=>JSON.stringify(r.body));
  const allSame = bodies.every(b=>b===bodies[0]);
  REPORT.concurrency.push({ kind: '10xGET /api/state', totalMs: concMs, statuses, allIdentical: allSame, perReqMs: results.map(r=>r.ms) });

  // Mixed concurrency across endpoints
  const mixStart = Date.now();
  const mix = await Promise.all([
    apiGet(page,'/api/state'),
    apiGet(page,'/api/league/status'),
    apiGet(page,'/api/season/standings'),
    apiGet(page,'/api/players'),
    apiGet(page,'/api/personas'),
    apiGet(page,'/api/leagues/list'),
  ]);
  REPORT.concurrency.push({ kind: 'mixed-6', totalMs: Date.now()-mixStart, perReq: mix.map((r,i)=>({i, status:r.status, ms:r.ms})) });

  // ===== UI interactions =====
  try {
    await page.click('#btn-menu', { timeout: 2000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, 'g4o_02_settings_open.png') });
    // escape
    await page.keyboard.press('Escape');
  } catch (e) { REPORT.a11y.push({ settingsOpenErr: String(e) }); }

  try {
    await page.click('#btn-league-switch', { timeout: 2000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, 'g4o_03_league_menu.png') });
    await page.keyboard.press('Escape');
  } catch (e) { REPORT.a11y.push({ leagueSwitchErr: String(e) }); }

  // ===== finalize =====
  REPORT.console = { msgs: consoleMsgs, errors: pageErrors, errorCount: consoleMsgs.filter(m=>m.type==='error').length, warnCount: consoleMsgs.filter(m=>m.type==='warning').length, pageErrorCount: pageErrors.length };
  REPORT.network.push({ totalRequests: netEvents.length, failed: netEvents.filter(n=>n.status>=400).map(n=>({url:n.url,status:n.status})), slowest: netEvents.sort((a,b)=>b.ms-a.ms).slice(0,10) });

  fs.writeFileSync(path.join(__dirname, 'g4_observer_raw.json'), JSON.stringify(REPORT, null, 2));
  await page.screenshot({ path: path.join(SHOTS, 'g4o_99_final.png'), fullPage: true });

  // Sanity expect — never fail the run, just evidence
  expect(state).toBeTruthy();
});
