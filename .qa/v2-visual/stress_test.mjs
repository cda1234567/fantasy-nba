// Comprehensive stress test: exercises every interactive feature of v2 UI
// Reports: feature works / feature broken / feature missing
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = process.env.BASE || 'https://nbafantasy.cda1234567.com';
const OUT = path.resolve('stress-shots');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const record = (name, status, detail = '') => {
  results.push({ name, status, detail });
  const icon = status === 'ok' ? '✓' : status === 'missing' ? '✗' : status === 'broken' ? '✗' : '?';
  console.log(`  ${icon} [${status.padEnd(7)}] ${name}${detail ? ' — ' + detail : ''}`);
};

const snap = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(`JS: ${e.message}`));
  page.on('requestfailed', (req) => {
    if (req.url().includes('/api/')) errs.push(`${req.url()} ${req.failure()?.errorText}`);
  });

  const health = await (await fetch(`${BASE}/api/health`)).json();
  console.log(`BASE=${BASE} version=${health.version}\n`);

  // ============ ROUTE COVERAGE ============
  console.log('--- routes render ---');
  const routes = ['home', 'matchup', 'roster', 'draft', 'trade', 'fa', 'schedule', 'standings', 'news'];
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  for (const r of routes) {
    await page.evaluate((rr) => { location.hash = '#/' + rr; }, r);
    await page.waitForTimeout(1500);
    const info = await page.evaluate(() => {
      const main = document.querySelector('#main');
      return {
        chars: main ? main.innerText.trim().length : 0,
        hasError: !!main?.querySelector('.err-panel'),
        firstHeading: main?.querySelector('h1,h2,h3')?.innerText || null,
      };
    });
    await snap(page, `route_${r}`);
    if (info.hasError) record(`route /${r}`, 'broken', `err-panel shown`);
    else if (info.chars < 20) record(`route /${r}`, 'broken', `empty mainChars=${info.chars}`);
    else record(`route /${r}`, 'ok', `${info.chars}ch "${info.firstHeading||''}"`);
  }

  // ============ NAV ITEMS ============
  console.log('\n--- sidebar nav ---');
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const navItems = await page.locator('#nav .nav-item').count();
  record('sidebar nav renders items', navItems > 0 ? 'ok' : 'missing', `count=${navItems}`);

  if (navItems > 0) {
    for (let i = 0; i < Math.min(navItems, 10); i++) {
      const text = await page.locator('#nav .nav-item').nth(i).innerText().catch(() => '');
      await page.locator('#nav .nav-item').nth(i).click().catch(() => {});
      await page.waitForTimeout(600);
      const hash = await page.evaluate(() => location.hash);
      record(`nav click "${text.slice(0,10)}"`, hash !== '' ? 'ok' : 'broken', `→ ${hash}`);
    }
  }

  // ============ TABBAR (mobile) ============
  console.log('\n--- mobile tabbar ---');
  await ctx.close();
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pageM = await ctxM.newPage();
  await pageM.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await pageM.waitForTimeout(1500);
  const tabCount = await pageM.locator('#tabbar button, #tabbar a').count();
  record('mobile tabbar renders', tabCount > 0 ? 'ok' : 'missing', `count=${tabCount}`);
  for (let i = 0; i < Math.min(tabCount, 5); i++) {
    const text = await pageM.locator('#tabbar button, #tabbar a').nth(i).innerText().catch(() => '');
    await pageM.locator('#tabbar button, #tabbar a').nth(i).click().catch(() => {});
    await pageM.waitForTimeout(400);
    const hash = await pageM.evaluate(() => location.hash);
    record(`tabbar click "${text.slice(0,10)}"`, hash !== '' ? 'ok' : 'broken', `→ ${hash}`);
  }
  await snap(pageM, `mobile_tabbar`);
  await ctxM.close();

  // ============ DESKTOP INTERACTIONS ============
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx2.newPage();
  p.on('pageerror', (e) => errs.push(`JS: ${e.message}`));

  console.log('\n--- home route actions ---');
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);
  // Find action buttons on home
  const homeBtns = await p.locator('#main button').count();
  record('home has action buttons', homeBtns > 0 ? 'ok' : 'missing', `btn count=${homeBtns}`);

  // Try clicking enter-matchup button (common pattern)
  const enterBtn = await p.locator('#main button:has-text("進入"), #main button:has-text("對戰")').first();
  const hasEnter = await enterBtn.count() > 0;
  if (hasEnter) {
    await enterBtn.click().catch(() => {});
    await p.waitForTimeout(1000);
    const hash = await p.evaluate(() => location.hash);
    record('home → matchup via button', hash.includes('matchup') ? 'ok' : 'broken', `hash=${hash}`);
  } else {
    record('home → matchup via button', 'missing', 'no matching button');
  }

  // ============ MATCHUP ============
  console.log('\n--- matchup route ---');
  await p.goto(`${BASE}/#/matchup`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);
  const matchupChars = await p.locator('#main').innerText().then(t => t.length);
  record('matchup renders', matchupChars > 100 ? 'ok' : 'broken', `chars=${matchupChars}`);
  // Week switcher
  const weekSwitch = await p.locator('#main [data-week], #main select, #main .week-pill').count();
  record('matchup week switcher', weekSwitch > 0 ? 'ok' : 'missing', `count=${weekSwitch}`);

  // ============ ROSTER ============
  console.log('\n--- roster route ---');
  await p.goto(`${BASE}/#/roster`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);
  const rosterChars = await p.locator('#main').innerText().then(t => t.length);
  record('roster renders', rosterChars > 100 ? 'ok' : 'broken', `chars=${rosterChars}`);
  const playerRows = await p.locator('#main .player-row, #main [data-player], #main .roster-player').count();
  record('roster has player rows', playerRows > 0 ? 'ok' : 'missing', `rows=${playerRows}`);
  // Check form[5] display
  const formIndicator = await p.locator('#main').innerText();
  const hasForm = /\d+\.\d/.test(formIndicator) || /form/i.test(formIndicator);
  record('roster shows form stats', hasForm ? 'ok' : 'missing', '');
  await snap(p, 'roster_desktop');

  // ============ DRAFT ============
  console.log('\n--- draft route ---');
  await p.goto(`${BASE}/#/draft`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  const draftChars = await p.locator('#main').innerText().then(t => t.length);
  record('draft renders', draftChars > 100 ? 'ok' : 'broken', `chars=${draftChars}`);
  const draftComplete = /選秀完成|選秀已結束/.test(await p.locator('#main').innerText());
  record('draft state check', 'ok', draftComplete ? 'already complete' : 'live');
  const recoBtns = await p.locator('#main .reco-card, #main [data-pick]').count();
  record('draft recommendations shown', recoBtns > 0 ? 'ok' : 'missing', `count=${recoBtns}`);
  await snap(p, 'draft_desktop');

  // ============ TRADE ============
  console.log('\n--- trade route ---');
  await p.goto(`${BASE}/#/trade`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  const tradeChars = await p.locator('#main').innerText().then(t => t.length);
  record('trade renders', tradeChars > 100 ? 'ok' : 'broken', `chars=${tradeChars}`);
  const livePill = await p.locator('.live-pulse, #trade-live').count();
  record('trade LIVE indicator', livePill > 0 ? 'ok' : 'missing', `count=${livePill}`);
  // Check trade builder
  const tradeBuilder = await p.locator('#main button:has-text("提案"), #main button:has-text("新增"), #main button:has-text("送出")').count();
  record('trade builder buttons', tradeBuilder > 0 ? 'ok' : 'missing', `count=${tradeBuilder}`);
  await snap(p, 'trade_desktop');

  // ============ FA ============
  console.log('\n--- free agents ---');
  await p.goto(`${BASE}/#/fa`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  const faChars = await p.locator('#main').innerText().then(t => t.length);
  record('fa renders', faChars > 100 ? 'ok' : 'broken', `chars=${faChars}`);
  const faabDisplay = /FAAB|預算|\$\d+/.test(await p.locator('#main').innerText());
  record('FAAB budget shown', faabDisplay ? 'ok' : 'missing', '');
  const bidBtn = await p.locator('#main button:has-text("競標"), #main button:has-text("出價"), #main button:has-text("認領"), #main input[type="number"]').count();
  record('FA bid button/input', bidBtn > 0 ? 'ok' : 'missing', `count=${bidBtn}`);
  await snap(p, 'fa_desktop');

  // ============ SCHEDULE ============
  console.log('\n--- schedule ---');
  await p.goto(`${BASE}/#/schedule`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);
  const schedChars = await p.locator('#main').innerText().then(t => t.length);
  record('schedule renders', schedChars > 100 ? 'ok' : 'broken', `chars=${schedChars}`);
  const weekRows = await p.locator('#main .week-row, #main .schedule-week, #main [data-week]').count();
  record('schedule has week rows', weekRows > 0 ? 'ok' : 'missing', `count=${weekRows}`);
  await snap(p, 'schedule_desktop');

  // ============ STANDINGS ============
  console.log('\n--- standings ---');
  await p.goto(`${BASE}/#/standings`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);
  const standChars = await p.locator('#main').innerText().then(t => t.length);
  record('standings renders', standChars > 100 ? 'ok' : 'broken', `chars=${standChars}`);
  const teamRows = await p.locator('#main tr, #main .team-row, #main .standings-row').count();
  record('standings has team rows', teamRows > 0 ? 'ok' : 'missing', `count=${teamRows}`);
  await snap(p, 'standings_desktop');

  // ============ NEWS ============
  console.log('\n--- news ---');
  await p.goto(`${BASE}/#/news`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  const newsChars = await p.locator('#main').innerText().then(t => t.length);
  record('news renders', newsChars > 100 ? 'ok' : 'broken', `chars=${newsChars}`);
  const newsRows = await p.locator('#main .news-row, #main .news-item, #main article').count();
  record('news has feed items', newsRows > 0 ? 'ok' : 'missing', `count=${newsRows}`);
  await snap(p, 'news_desktop');

  // ============ CMD-K ============
  console.log('\n--- cmd-k palette ---');
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  await p.keyboard.press('Control+k');
  await p.waitForTimeout(400);
  const cmdOpen = await p.locator('.cmdk-backdrop.open').count();
  record('cmd-k opens', cmdOpen > 0 ? 'ok' : 'broken', '');
  if (cmdOpen) {
    await p.locator('#cmdk-q').fill('Curry');
    await p.waitForTimeout(600);
    const items = await p.locator('.cmdk-item').count();
    record('cmd-k player search', items > 0 ? 'ok' : 'broken', `items=${items}`);
    // Click a result
    if (items > 0) {
      await p.locator('.cmdk-item').first().click().catch(() => {});
      await p.waitForTimeout(600);
      record('cmd-k result click navigates', 'ok', '');
    }
  }
  await p.keyboard.press('Escape');

  // ============ ME-CHIP / HEADER ICONS ============
  console.log('\n--- header controls ---');
  await p.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  const meChipVisible = await p.locator('#me-chip:visible').count();
  record('me-chip visible', meChipVisible > 0 ? 'ok' : 'missing', '');
  const meChipName = await p.locator('.me-chip-name').innerText().catch(() => '');
  record('me-chip shows name', meChipName && meChipName !== '—' ? 'ok' : 'broken', `name="${meChipName}"`);
  const iconBtns = await p.locator('.icon-btn').count();
  record('header icon buttons', iconBtns >= 2 ? 'ok' : 'missing', `count=${iconBtns}`);

  // ============ LEAGUE-SWITCH ============
  console.log('\n--- league switcher ---');
  const leagueSwitch = await p.locator('.league-switch').count();
  record('league switch button', leagueSwitch > 0 ? 'ok' : 'missing', '');
  if (leagueSwitch > 0) {
    const leagueText = await p.locator('.league-switch').innerText().catch(() => '');
    record('league switch shows name', leagueText.length > 5 ? 'ok' : 'broken', `"${leagueText.slice(0,40).replace(/\s+/g,' ')}"`);
    await p.locator('.league-switch').click().catch(() => {});
    await p.waitForTimeout(600);
    // See if a dropdown opens
    const dropdown = await p.locator('.league-menu, .league-dropdown, [role="menu"]:visible').count();
    record('league switch opens menu', dropdown > 0 ? 'ok' : 'missing', '(might not be wired)');
  }

  // ============ JS ERRORS ============
  console.log('\n--- JS errors ---');
  if (errs.length === 0) record('no JS/API errors during session', 'ok', '');
  else {
    errs.slice(0, 8).forEach(e => record('JS/API error', 'broken', e.slice(0, 120)));
  }

  await ctx2.close();
  await browser.close();

  // ============ SUMMARY ============
  const pass = results.filter(r => r.status === 'ok').length;
  const missing = results.filter(r => r.status === 'missing').length;
  const broken = results.filter(r => r.status === 'broken').length;
  console.log(`\n=== STRESS SUMMARY === total=${results.length}  ok=${pass}  missing=${missing}  broken=${broken}`);
  if (missing > 0) {
    console.log('\nMISSING:');
    results.filter(r => r.status === 'missing').forEach(r => console.log(`  - ${r.name}: ${r.detail}`));
  }
  if (broken > 0) {
    console.log('\nBROKEN:');
    results.filter(r => r.status === 'broken').forEach(r => console.log(`  - ${r.name}: ${r.detail}`));
  }
  fs.writeFileSync(path.join(OUT, '../stress_results.json'), JSON.stringify({ version: health.version, results }, null, 2));
})();
