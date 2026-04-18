/**
 * QA Round-2 Group-3 OBSERVER — Security / Input-Abuse (Defensive Audit)
 *
 * Target: https://nbafantasy.cda1234567.com  (expect v0.5.23)
 * Sandbox league: qa-r2-obs-g3 (isolated — does NOT touch qa-r2-g3 pair)
 *
 * Probes (all on-app, authorized):
 *   1. XSS in league name  (<script>window._xss=1</script>)
 *   2. XSS in team name    (<img src=x onerror=...>)
 *   3. XSS in trade message
 *   4. Path traversal in league_id
 *   5. Oversized payload (10000 chars)
 *   6. SQL-injection-like input in league_id
 *   7. Double-submit / idempotency on create
 *   8. CSRF-like cross-origin fetch probe
 *
 * Plus header / HSTS / CSP / cookie / path leakage audit.
 */
import { test, expect, Page, APIResponse } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const SITE = 'https://nbafantasy.cda1234567.com';
const SANDBOX = 'qa-r2-obs-g3';
const OUT_DIR = __dirname;
const SHOT_DIR = path.join(OUT_DIR, 'screenshots_g3o');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

type Finding = {
  id: string;
  title: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3' | 'INFO';
  status: 'PASS' | 'FAIL' | 'INFO';
  expected: string;
  actual: string;
  evidence?: any;
};

const findings: Finding[] = [];
const log = (f: Finding) => {
  findings.push(f);
  // eslint-disable-next-line no-console
  console.log(`[${f.status}] ${f.id} (${f.severity}) ${f.title}`);
};

async function ensureSandbox(page: Page) {
  // Always start on the sandbox league; never touch qa-r2-g3.
  const create = await page.request.post(`${SITE}/api/leagues/create`, {
    data: { league_id: SANDBOX, switch: true },
  });
  // 200 on create, or 400 if it already exists → then we must switch.
  if (!create.ok()) {
    await page.request.post(`${SITE}/api/leagues/switch`, {
      data: { league_id: SANDBOX },
    });
  }
}

async function restoreDefault(page: Page) {
  try {
    await page.request.post(`${SITE}/api/leagues/switch`, {
      data: { league_id: 'default' },
    });
  } catch {
    /* noop */
  }
}

test.describe('g3 observer — security / input abuse', () => {
  test.setTimeout(9 * 60 * 1000);

  test('full security audit sweep', async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
    });
    const page = await ctx.newPage();

    // Capture JS / console signals globally — any XSS that fires shows up here.
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const dialogs: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
    page.on('dialog', async (d) => {
      dialogs.push(`${d.type()}:${d.message()}`);
      await d.dismiss().catch(() => {});
    });

    // ---------- Baseline: version + sandbox ----------
    const health = await (await page.request.get(`${SITE}/api/health`)).json();
    log({
      id: 'V0',
      title: 'version check',
      severity: 'INFO',
      status: health?.version === '0.5.23' ? 'PASS' : 'FAIL',
      expected: '0.5.23',
      actual: String(health?.version),
      evidence: health,
    });

    await page.goto(SITE, { waitUntil: 'networkidle' });
    await ensureSandbox(page);
    // Reload so UI reflects sandbox league
    await page.goto(SITE, { waitUntil: 'networkidle' });

    // ---------- H1: Security response headers ----------
    const homeResp = await page.request.get(SITE);
    const headers = homeResp.headers();
    const hdrList = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
    fs.writeFileSync(path.join(OUT_DIR, '_g3o_headers_home.txt'), hdrList.join('\n'));

    const hsts = headers['strict-transport-security'];
    const csp = headers['content-security-policy'];
    const xfo = headers['x-frame-options'];
    const xcto = headers['x-content-type-options'];
    const referrer = headers['referrer-policy'];
    const permissions = headers['permissions-policy'];
    const coop = headers['cross-origin-opener-policy'];
    const server = headers['server'];

    log({
      id: 'H1',
      title: 'HSTS header',
      severity: hsts ? 'INFO' : 'P2',
      status: hsts ? 'PASS' : 'FAIL',
      expected: 'Strict-Transport-Security: max-age>=15552000',
      actual: hsts || '(missing)',
    });
    log({
      id: 'H2',
      title: 'Content-Security-Policy',
      severity: csp ? 'INFO' : 'P2',
      status: csp ? 'PASS' : 'FAIL',
      expected: 'CSP header present (script-src restrictions)',
      actual: csp || '(missing)',
    });
    log({
      id: 'H3',
      title: 'X-Frame-Options / frame-ancestors',
      severity: xfo ? 'INFO' : 'P3',
      status: xfo ? 'PASS' : 'FAIL',
      expected: 'DENY or SAMEORIGIN (clickjacking)',
      actual: xfo || '(missing)',
    });
    log({
      id: 'H4',
      title: 'X-Content-Type-Options',
      severity: xcto ? 'INFO' : 'P3',
      status: xcto === 'nosniff' ? 'PASS' : 'FAIL',
      expected: 'nosniff',
      actual: xcto || '(missing)',
    });
    log({
      id: 'H5',
      title: 'Referrer-Policy',
      severity: 'INFO',
      status: referrer ? 'PASS' : 'FAIL',
      expected: 'strict-origin-when-cross-origin (recommended)',
      actual: referrer || '(missing)',
    });
    log({
      id: 'H6',
      title: 'Permissions-Policy',
      severity: 'INFO',
      status: permissions ? 'PASS' : 'FAIL',
      expected: 'restrict camera/mic/geolocation',
      actual: permissions || '(missing)',
    });
    log({
      id: 'H7',
      title: 'Cross-Origin-Opener-Policy',
      severity: 'INFO',
      status: coop ? 'PASS' : 'FAIL',
      expected: 'same-origin',
      actual: coop || '(missing)',
    });
    log({
      id: 'H8',
      title: 'Server / framework info disclosure',
      severity: server && /cloudflare|nginx/i.test(server) ? 'P3' : 'INFO',
      status: 'INFO',
      expected: 'minimal / no version string',
      actual: `server=${server || '(none)'}`,
    });

    // Cookie audit
    const cookies = await ctx.cookies(SITE);
    log({
      id: 'H9',
      title: 'Cookie flags (HttpOnly/Secure/SameSite)',
      severity: 'INFO',
      status: 'INFO',
      expected: 'any session cookie must be HttpOnly+Secure+SameSite',
      actual:
        cookies.length === 0
          ? '(no cookies set — stateless/no-session model)'
          : JSON.stringify(
              cookies.map((c) => ({
                name: c.name,
                httpOnly: c.httpOnly,
                secure: c.secure,
                sameSite: c.sameSite,
              })),
            ),
      evidence: cookies,
    });

    // ---------- S1–S3: XSS payloads (UI-driven) ----------
    // Marker globals: window._xss / _xss2 / _xss3 — must remain undefined.
    const XSS1_PAYLOAD = '<script>window._xss=1</script>';
    const XSS2_PAYLOAD = '<img src=x onerror="window._xss2=1">';
    const XSS3_PAYLOAD = '<script>window._xss3=1</script>';

    // S1. League-name XSS via settings / setup route.
    // We patch league settings on the sandbox league (UI may expose it via setup;
    // we use page.evaluate → fetch to simulate the same endpoint the UI calls).
    const patchResp = await page.evaluate(
      async ({ name }) => {
        const r = await fetch('/api/league/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ league_name: name }),
        });
        return { status: r.status, body: await r.text() };
      },
      { name: XSS1_PAYLOAD },
    );
    // Render any UI element that shows league name — hit list endpoint and check DOM.
    await page.goto(SITE, { waitUntil: 'networkidle' });
    // Give the UI a moment to hydrate
    await page.waitForTimeout(800);
    const xssExecuted = await page.evaluate(() => ({
      xss1: (window as any)._xss,
      xss2: (window as any)._xss2,
      xss3: (window as any)._xss3,
    }));
    // Look for the literal string rendered as text (safe) anywhere in the DOM
    const leagueNameInDom = await page.evaluate((needle) => {
      const hay = document.body.innerText;
      return {
        textMatch: hay.includes(needle),
        rawHtmlHas: document.documentElement.innerHTML.includes(needle),
      };
    }, XSS1_PAYLOAD);
    await page.screenshot({ path: path.join(SHOT_DIR, 's1_xss_league_name.png'), fullPage: false });

    log({
      id: 'S1',
      title: 'XSS via league name (<script>)',
      severity: xssExecuted.xss1 ? 'P0' : 'INFO',
      status: xssExecuted.xss1 ? 'FAIL' : 'PASS',
      expected: 'payload escaped, window._xss remains undefined',
      actual: `window._xss=${xssExecuted.xss1}; server patch status=${patchResp.status}`,
      evidence: { patchResp, leagueNameInDom },
    });

    // S2. Team-name XSS via /api/league/setup (sandbox league only, setup_complete may reset draft)
    // Patch settings is safer (doesn't touch draft): use team_names array via /api/league/settings
    const teamPatch = await page.evaluate(
      async ({ payload }) => {
        const r = await fetch('/api/league/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            team_names: [
              payload,
              'T1',
              'T2',
              'T3',
              'T4',
              'T5',
              'T6',
              'T7',
            ],
          }),
        });
        return { status: r.status, body: await r.text() };
      },
      { payload: XSS2_PAYLOAD },
    );
    await page.goto(SITE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const xssExecuted2 = await page.evaluate(() => ({
      xss1: (window as any)._xss,
      xss2: (window as any)._xss2,
    }));
    const hasImgOnerror = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('img')).some((i) =>
        (i.getAttribute('onerror') || '').includes('_xss2'),
      );
    });
    await page.screenshot({ path: path.join(SHOT_DIR, 's2_xss_team_name.png'), fullPage: false });

    log({
      id: 'S2',
      title: 'XSS via team name (<img onerror>)',
      severity: xssExecuted2.xss2 || hasImgOnerror ? 'P0' : 'INFO',
      status: xssExecuted2.xss2 || hasImgOnerror ? 'FAIL' : 'PASS',
      expected: 'no <img onerror> injected; window._xss2 undefined',
      actual: `window._xss2=${xssExecuted2.xss2}; img-with-payload-onerror=${hasImgOnerror}; patch=${teamPatch.status}`,
      evidence: { teamPatch },
    });

    // S3. XSS via trade proposer_message. We can't actually run a trade without a
    // fully drafted season, but we can still send the proposal and observe how
    // the server responds (validation error vs. stored) — and then render the
    // activity feed / trades endpoints to see if the payload is echoed unsafely.
    const tradeAttempt = await page.evaluate(
      async ({ payload }) => {
        const r = await fetch('/api/trades/propose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from_team: 0,
            to_team: 1,
            send: [],
            receive: [],
            proposer_message: payload,
            force: false,
          }),
        });
        return { status: r.status, body: await r.text() };
      },
      { payload: XSS3_PAYLOAD },
    );
    // Regardless of accept/reject, hit activity + pending feeds and reload page
    await page.evaluate(async () => {
      await fetch('/api/trades/pending');
      await fetch('/api/trades/history');
      await fetch('/api/season/activity?limit=50');
    });
    await page.goto(SITE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const xssExecuted3 = await page.evaluate(() => ({
      xss3: (window as any)._xss3,
    }));
    const bodyHasRawScript = await page.evaluate(
      (needle) => document.documentElement.innerHTML.includes(needle),
      '<script>window._xss3=1</script>',
    );

    log({
      id: 'S3',
      title: 'XSS via trade proposer_message',
      severity: xssExecuted3.xss3 || bodyHasRawScript ? 'P0' : 'INFO',
      status: xssExecuted3.xss3 || bodyHasRawScript ? 'FAIL' : 'PASS',
      expected: 'payload escaped / stored safely / rejected; window._xss3 undefined',
      actual: `window._xss3=${xssExecuted3.xss3}; rawHtmlHasScriptTag=${bodyHasRawScript}; propose status=${tradeAttempt.status}`,
      evidence: { tradeAttempt },
    });

    // ---------- S4: Path traversal ----------
    const trav = await page.evaluate(async () => {
      const r = await fetch('/api/leagues/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ league_id: '../../etc/passwd' }),
      });
      return { status: r.status, body: await r.text() };
    });
    log({
      id: 'S4',
      title: 'Path traversal in league_id',
      severity: trav.status === 400 || trav.status === 422 ? 'INFO' : 'P0',
      status: trav.status === 400 || trav.status === 422 ? 'PASS' : 'FAIL',
      expected: '400/422 with validator error; no disk write',
      actual: `status=${trav.status} body=${trav.body.slice(0, 200)}`,
      evidence: trav,
    });

    // ---------- S5: Oversized payload ----------
    const long = 'A'.repeat(10000);
    const big = await page.evaluate(async (payload) => {
      const r = await fetch('/api/leagues/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ league_id: payload }),
      });
      return { status: r.status, body: await r.text() };
    }, long);
    log({
      id: 'S5',
      title: 'Oversized league_id (10k chars)',
      severity: big.status === 400 || big.status === 422 ? 'INFO' : 'P1',
      status: big.status === 400 || big.status === 422 ? 'PASS' : 'FAIL',
      expected: '400/422 with length-limit error',
      actual: `status=${big.status} body=${big.body.slice(0, 200)}`,
      evidence: big,
    });

    // ---------- S6: SQL-injection-like ----------
    const sqli = await page.evaluate(async () => {
      const r = await fetch('/api/leagues/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // eslint-disable-next-line quotes
        body: JSON.stringify({ league_id: "'; DROP TABLE players; --" }),
      });
      return { status: r.status, body: await r.text() };
    });
    log({
      id: 'S6',
      title: 'SQL-injection-like league_id',
      severity: sqli.status === 400 || sqli.status === 422 ? 'INFO' : 'P0',
      status: sqli.status === 400 || sqli.status === 422 ? 'PASS' : 'FAIL',
      expected: 'rejected; players endpoint still returns data',
      actual: `status=${sqli.status} body=${sqli.body.slice(0, 200)}`,
      evidence: sqli,
    });
    // Post-check: /api/players still works (DB integrity)
    const players = await page.evaluate(async () => {
      const r = await fetch('/api/players?limit=3');
      const j = await r.json();
      return { status: r.status, count: Array.isArray(j) ? j.length : -1 };
    });
    log({
      id: 'S6b',
      title: 'DB integrity after SQLi attempt',
      severity: players.count > 0 ? 'INFO' : 'P0',
      status: players.count > 0 ? 'PASS' : 'FAIL',
      expected: 'players list still returns ≥1 item',
      actual: `status=${players.status} count=${players.count}`,
    });

    // ---------- S7: Double-submit idempotency (10x in <500ms) ----------
    const dupName = `qa-r2-obs-g3-dupe-${Date.now() % 100000}`;
    const dupRes = await page.evaluate(async (id) => {
      const promises = Array.from({ length: 10 }, () =>
        fetch('/api/leagues/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ league_id: id, switch: false }),
        }).then(async (r) => ({ status: r.status, body: await r.text() })),
      );
      return Promise.all(promises);
    }, dupName);
    // Count unique successes
    const ok = dupRes.filter((r) => r.status === 200).length;
    const dup = dupRes.filter((r) => r.status === 400 || r.status === 409).length;
    const other = dupRes.filter((r) => r.status >= 500).length;
    // Count actual leagues created
    const listAfter = await (await page.request.get(`${SITE}/api/leagues/list`)).json();
    const createdCount = (listAfter.leagues || []).filter(
      (l: any) => l.league_id === dupName,
    ).length;
    log({
      id: 'S7',
      title: 'Double-submit idempotency (10x /leagues/create)',
      severity: createdCount === 1 && other === 0 ? 'INFO' : 'P1',
      status: createdCount === 1 && other === 0 ? 'PASS' : 'FAIL',
      expected: '1 created; duplicates rejected cleanly (no 5xx)',
      actual: `ok=${ok} dup=${dup} serverErr=${other} actualCreated=${createdCount}`,
      evidence: dupRes,
    });

    // ---------- S8: CSRF-like / CORS from foreign origin ----------
    // Simulate a cross-origin attempt by setting Origin header via request.fetch.
    const csrfProbe = await page.request.post(`${SITE}/api/leagues/switch`, {
      headers: { Origin: 'https://evil.example.com', 'Content-Type': 'application/json' },
      data: { league_id: SANDBOX },
    });
    const csrfHdrs = csrfProbe.headers();
    const acao = csrfHdrs['access-control-allow-origin'];
    const acac = csrfHdrs['access-control-allow-credentials'];
    // The actual cross-origin threat: does the server reflect the Origin or set ACAO:*?
    const csrfBody = await csrfProbe.text();
    log({
      id: 'S8',
      title: 'CSRF / CORS — hostile Origin on state-changing POST',
      severity:
        acao === '*' || acao === 'https://evil.example.com' ? 'P1' : 'INFO',
      status:
        acao === '*' || acao === 'https://evil.example.com'
          ? 'FAIL'
          : 'PASS',
      expected:
        'no ACAO for foreign origin (browser same-origin policy blocks the cross-site attacker)',
      actual: `ACAO=${acao || '(none)'} ACAC=${acac || '(none)'} status=${csrfProbe.status()} body=${csrfBody.slice(0, 120)}`,
      evidence: { headers: csrfHdrs },
    });
    // Preflight probe — OPTIONS
    const preflight = await page.request.fetch(`${SITE}/api/leagues/create`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    const pfAcao = preflight.headers()['access-control-allow-origin'];
    log({
      id: 'S8b',
      title: 'CORS preflight from evil origin',
      severity: pfAcao === '*' || pfAcao === 'https://evil.example.com' ? 'P1' : 'INFO',
      status: pfAcao === '*' || pfAcao === 'https://evil.example.com' ? 'FAIL' : 'PASS',
      expected: 'preflight does not whitelist attacker origin',
      actual: `status=${preflight.status()} ACAO=${pfAcao || '(none)'}`,
      evidence: preflight.headers(),
    });

    // ---------- Absolute-path / secret leakage scan ----------
    const homeBody = await page.request.get(SITE).then((r) => r.text());
    const stateBody = await page.request.get(`${SITE}/api/state`).then((r) => r.text());
    const settingsBody = await page.request
      .get(`${SITE}/api/league/settings`)
      .then((r) => r.text());
    const leakNeedles = [
      'C:\\',
      '/home/',
      '/root/',
      'data_dir',
      'DATABASE_URL',
      'ANTHROPIC_API_KEY',
      'OPENROUTER',
      'traceback',
      'Traceback',
    ];
    const leakHits: Array<{ where: string; needle: string; sample: string }> = [];
    const scan = (where: string, body: string) => {
      for (const n of leakNeedles) {
        const idx = body.indexOf(n);
        if (idx !== -1) {
          leakHits.push({
            where,
            needle: n,
            sample: body.slice(Math.max(0, idx - 40), idx + 80),
          });
        }
      }
    };
    scan('GET /', homeBody);
    scan('GET /api/state', stateBody);
    scan('GET /api/league/settings', settingsBody);
    log({
      id: 'L1',
      title: 'Absolute-path / secret leakage in response bodies',
      severity: leakHits.length ? 'P1' : 'INFO',
      status: leakHits.length ? 'FAIL' : 'PASS',
      expected: 'no C:\\, /home/, data_dir, API keys, or stack traces',
      actual: leakHits.length ? JSON.stringify(leakHits).slice(0, 400) : '(none)',
      evidence: leakHits,
    });

    // ---------- Wrap-up: no runtime XSS fired anywhere ----------
    log({
      id: 'X1',
      title: 'No runtime XSS markers fired during full sweep',
      severity: 'INFO',
      status:
        dialogs.length === 0 &&
        !(await page.evaluate(() => (window as any)._xss || (window as any)._xss2 || (window as any)._xss3))
          ? 'PASS'
          : 'FAIL',
      expected: 'no alert() dialogs, no _xss* globals set, no pageerror from XSS',
      actual: `dialogs=${dialogs.length} pageErrors=${pageErrors.length} consoleErrors=${consoleErrors.length}`,
      evidence: { dialogs, pageErrors: pageErrors.slice(0, 10), consoleErrors: consoleErrors.slice(0, 10) },
    });

    // ---------- Cleanup ----------
    await restoreDefault(page);
    await page.screenshot({ path: path.join(SHOT_DIR, 'z_final.png'), fullPage: false });
    await ctx.close();

    // ---------- Write raw JSON + markdown summary ----------
    fs.writeFileSync(
      path.join(OUT_DIR, 'g3_observer_raw.json'),
      JSON.stringify({ version: health?.version, findings }, null, 2),
    );

    // Build markdown report
    const totals = findings.reduce(
      (a, f) => {
        a[f.status] = (a[f.status] || 0) + 1;
        return a;
      },
      {} as Record<string, number>,
    );
    const bySev = findings.reduce(
      (a, f) => {
        a[f.severity] = (a[f.severity] || 0) + 1;
        return a;
      },
      {} as Record<string, number>,
    );

    const md: string[] = [];
    md.push('# QA Round-2 Group-3 OBSERVER — Security / Input Abuse');
    md.push('');
    md.push(`- Target: ${SITE}`);
    md.push(`- Version observed: **${health?.version}** (expected 0.5.23)`);
    md.push(`- Sandbox league: **${SANDBOX}** (paired league qa-r2-g3 untouched)`);
    md.push(`- Date: ${new Date().toISOString()}`);
    md.push('');
    md.push('## Totals');
    md.push(
      `- PASS: ${totals.PASS || 0} | FAIL: ${totals.FAIL || 0} | INFO: ${totals.INFO || 0}`,
    );
    md.push(
      `- P0: ${bySev.P0 || 0} | P1: ${bySev.P1 || 0} | P2: ${bySev.P2 || 0} | P3: ${bySev.P3 || 0}`,
    );
    md.push('');
    md.push('## Findings');
    for (const f of findings) {
      md.push(`### ${f.id} — ${f.title}`);
      md.push(`- Status: **${f.status}**  Severity: **${f.severity}**`);
      md.push(`- Expected: ${f.expected}`);
      md.push(`- Actual: ${f.actual}`);
      md.push('');
    }
    fs.writeFileSync(path.join(OUT_DIR, '_g3o_findings.md'), md.join('\n'));

    // Assertions: no P0 FAIL allowed
    const p0Fail = findings.filter((f) => f.status === 'FAIL' && f.severity === 'P0');
    expect.soft(p0Fail, `P0 failures: ${JSON.stringify(p0Fail)}`).toHaveLength(0);

    // Version MUST be 0.5.23
    expect(health?.version, 'version mismatch').toBe('0.5.23');
  });
});
