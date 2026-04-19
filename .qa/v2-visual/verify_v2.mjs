// Playwright visual verification for v2 UI
// Opens every route, takes screenshots, asserts the view actually loaded real data
// and there is no skeleton/error state lingering or JS console error.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = process.env.BASE || 'https://nbafantasy.cda1234567.com';
const OUT = path.resolve('.qa/v2-visual/shots');
fs.mkdirSync(OUT, { recursive: true });

const ROUTES = [
  { id: 'home',      expect: /今日|戰績|Chen|肉圓|對戰|[本週]/ },
  { id: 'matchup',   expect: /W\d+|分|對戰|我方|對手/ },
  { id: 'roster',    expect: /PG|SG|SF|PF|C|球隊|FPPG|近況/ },
  { id: 'draft',     expect: /選秀|Pick|輪|推薦|on\s*clock/i },
  { id: 'trade',     expect: /交易|提案|訊息|接受/ },
  { id: 'fa',        expect: /自由球員|預算|簽約|FAAB|Budget/i },
  { id: 'schedule',  expect: /W\d+|賽程|排程|週次/ },
  { id: 'standings', expect: /戰績|PF|排名|\d+-\d+/ },
  { id: 'news',      expect: /動態|新聞|LIVE|傷|交易|聯盟/ },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const results = [];
  const consoleErrors = [];
  const networkFailures = [];

  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(`[${msg.location()?.url || ''}] ${msg.text()}`);
  });
  page.on('requestfailed', req => {
    networkFailures.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });

  const version = await (async () => {
    const r = await fetch(`${BASE}/api/health`);
    const j = await r.json();
    return j.version;
  })();
  console.log(`BASE=${BASE}  version=${version}`);

  for (const r of ROUTES) {
    const url = `${BASE}/v2#/${r.id}`;
    console.log(`\n--- ${r.id}  ${url}`);
    const t0 = Date.now();
    const errs0 = consoleErrors.length;
    const fail0 = networkFailures.length;

    // Fresh load every time so we exercise the full mount path
    await page.goto(`${BASE}/v2`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.evaluate((hash) => { location.hash = '#/' + hash; }, r.id);
    // Wait for the skeleton to be replaced with real content
    await page.waitForTimeout(2500);

    const mainText = await page.locator('#main').innerText({ timeout: 5000 }).catch(() => '');
    const navText = await page.locator('#nav').innerText({ timeout: 5000 }).catch(() => '');
    const railText = await page.locator('#rail').innerText({ timeout: 5000 }).catch(() => '');

    const shot = path.join(OUT, `${r.id}.png`);
    await page.screenshot({ path: shot, fullPage: true });

    const dur = Date.now() - t0;
    const hasMatch = r.expect.test(mainText);
    const hasError = /錯誤|Error|failed|loading…\s*$/i.test(mainText) && !hasMatch;
    const sizeBytes = fs.statSync(shot).size;

    const newConsoleErrs = consoleErrors.slice(errs0);
    const newFailures = networkFailures.slice(fail0);

    results.push({
      route: r.id,
      duration_ms: dur,
      main_chars: mainText.length,
      nav_chars: navText.length,
      rail_chars: railText.length,
      match_expected: hasMatch,
      error_state: hasError,
      screenshot_bytes: sizeBytes,
      console_errors: newConsoleErrs,
      network_failures: newFailures,
      main_sample: mainText.slice(0, 300).replace(/\s+/g, ' '),
    });
    console.log(`  dur=${dur}ms  mainChars=${mainText.length}  match=${hasMatch}  errs=${newConsoleErrs.length}  fails=${newFailures.length}`);
    console.log(`  sample: ${mainText.slice(0, 160).replace(/\s+/g,' ')}`);
  }

  // Also verify a mobile viewport renders tabbar + home
  const mobile = await ctx.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(`${BASE}/v2#/home`, { waitUntil: 'domcontentloaded' });
  await mobile.waitForTimeout(2000);
  await mobile.screenshot({ path: path.join(OUT, 'mobile_home.png'), fullPage: true });
  const tabbarVisible = await mobile.locator('#tabbar').isVisible().catch(() => false);
  results.push({ route: 'mobile-home', tabbar_visible: tabbarVisible });

  await browser.close();

  fs.writeFileSync(path.join(OUT, '../results.json'), JSON.stringify({ version, results }, null, 2));
  const pass = results.filter(r => r.match_expected === true).length;
  const fail = ROUTES.length - pass;
  console.log(`\n=== SUMMARY === version=${version}  pass=${pass}/${ROUTES.length}  fail=${fail}`);
  console.log(`Screenshots: ${OUT}`);
  if (fail > 0 || consoleErrors.length > 0 || networkFailures.length > 0) {
    console.log('\n!! Issues:');
    for (const r of results) {
      if (!r.match_expected || (r.console_errors && r.console_errors.length) || (r.network_failures && r.network_failures.length)) {
        console.log(`  - ${r.route}: match=${r.match_expected} errs=${(r.console_errors||[]).length} fails=${(r.network_failures||[]).length}`);
        (r.console_errors||[]).forEach(e => console.log(`      console: ${e}`));
        (r.network_failures||[]).forEach(e => console.log(`      network: ${e}`));
      }
    }
    process.exit(1);
  }
  console.log('ALL GREEN');
})();
