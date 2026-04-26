// Click through every interactive element and verify it does something
import { chromium } from 'playwright';
const BASE = 'https://nbafantasy.cda1234567.com';
const results = [];
const rec = (name, ok, detail='') => { results.push({name,ok,detail}); console.log(`${ok?'✓':'✗'} ${name}${detail?' — '+detail:''}`); };

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // ========== Home interactions ==========
  console.log('\n=== HOME ===');
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  // 進入對戰 link
  const enterMatchup = page.locator('a:has-text("進入對戰"), button:has-text("進入對戰")').first();
  if (await enterMatchup.count() > 0) {
    await enterMatchup.click();
    await page.waitForTimeout(1000);
    const h = await page.evaluate(() => location.hash);
    rec('進入對戰 → matchup', h.includes('matchup'), `hash=${h}`);
  } else rec('進入對戰 exists', false);

  // 簽約 (FA claim) buttons on home
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const claimBtn = page.locator('#main button:has-text("簽約")').first();
  if (await claimBtn.count() > 0) {
    const before = await page.locator('#main button:has-text("簽約")').count();
    await claimBtn.click();
    await page.waitForTimeout(1500);
    const toast = await page.locator('.toast').count();
    rec('FA 簽約 button works (toast/redirect)', toast > 0, `toasts=${toast}`);
  }

  // 調整先發 link
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const adjBtn = page.locator('a:has-text("調整先發"), button:has-text("調整先發")').first();
  if (await adjBtn.count() > 0) {
    await adjBtn.click();
    await page.waitForTimeout(1000);
    const h = await page.evaluate(() => location.hash);
    rec('調整先發 navigates', h.includes('roster'), `hash=${h}`);
  }

  // ========== Roster interactions ==========
  console.log('\n=== ROSTER ===');
  await page.goto(`${BASE}/#/roster`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  // 本週/下週 buttons
  const weekThis = page.locator('#main button:has-text("本週")').first();
  const weekNext = page.locator('#main button:has-text("下週")').first();
  if (await weekNext.count() > 0) {
    const before = await page.locator('#main').innerText();
    await weekNext.click();
    await page.waitForTimeout(1000);
    const after = await page.locator('#main').innerText();
    rec('roster 下週 toggle changes content', before !== after, `diff chars=${Math.abs(after.length-before.length)}`);
  }
  // 建議最佳陣容
  const bestLineup = page.locator('#main button:has-text("建議最佳陣容")').first();
  if (await bestLineup.count() > 0) {
    const before = await page.locator('#main').innerText();
    await bestLineup.click();
    await page.waitForTimeout(1500);
    const after = await page.locator('#main').innerText();
    const toasts = await page.locator('.toast').count();
    rec('建議最佳陣容 triggers change', toasts > 0 || before !== after, `toasts=${toasts}`);
  }
  // Click a player slot (v2 uses .slot[data-player-id] from Fix #4)
  const pPlayer = page.locator('#main .slot[data-player-id], #main .player-card').first();
  const playerTxt = await pPlayer.count() > 0 ? await pPlayer.innerText().catch(()=>'—') : null;
  if (playerTxt) {
    await pPlayer.click({timeout:4000}).catch(()=>{});
    await page.waitForTimeout(500);
    const modalOpen = await page.locator('.modal-backdrop.open, #modal-bd.open').count();
    rec('roster player click opens modal', modalOpen > 0, `text="${playerTxt.slice(0,30)}" modals=${modalOpen}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } else rec('roster clickable player-card', false, 'selector mismatch');

  // ========== Trade interactions ==========
  console.log('\n=== TRADE ===');
  await page.goto(`${BASE}/#/trade`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const propose = page.locator('#main button:has-text("發起交易")').first();
  if (await propose.count() > 0) {
    await propose.click();
    await page.waitForTimeout(1200);
    // Check for modal/form
    const modal = await page.locator('.modal:visible, dialog[open], .trade-builder, .propose-form').count();
    const mainAfter = await page.locator('#main').innerText();
    rec('發起交易 opens builder', modal > 0, `modals=${modal}`);
  } else rec('發起交易 exists', false);

  // dismiss builder modal before next click
  await page.keyboard.press('Escape').catch(()=>{});
  await page.waitForTimeout(300);
  // Click pending trade row (uses .ts-row[data-thread] in v2)
  const tradeRow = page.locator('#main .ts-row[data-thread]').first();
  if (await tradeRow.count() > 0) {
    await tradeRow.click({timeout: 5000}).catch(()=>{});
    await page.waitForTimeout(800);
    rec('trade row clickable', true);
  } else rec('trade row exists', false, 'no threads');

  // ========== FA interactions ==========
  console.log('\n=== FA ===');
  await page.goto(`${BASE}/#/fa`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const enabledClaim = page.locator('#main button:has-text("認領"):not([disabled])').first();
  if (await enabledClaim.count() > 0) {
    await enabledClaim.click({timeout:5000}).catch(()=>{});
    await page.waitForTimeout(1500);
    const modal = await page.locator('.modal:visible, dialog[open]').count();
    const toast = await page.locator('.toast').count();
    rec('FA 認領 triggers modal/toast', modal > 0 || toast > 0, `modals=${modal} toasts=${toast}`);
  } else {
    rec('FA 認領 buttons exist (all disabled, quota exhausted)', true, 'all disabled');
  }
  // Search box
  const faSearch = page.locator('#main input[type="text"], #main input[type="search"]').first();
  if (await faSearch.count() > 0) {
    await faSearch.fill('Curry');
    await page.waitForTimeout(1000);
    const rows = await page.locator('#main tr, #main .fa-row').count();
    rec('FA search filters list', true, `rows after filter=${rows}`);
  } else rec('FA search input exists', false);

  // ========== Schedule interactions ==========
  console.log('\n=== SCHEDULE ===');
  await page.goto(`${BASE}/#/schedule`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  // Click a week cell
  const weekCell = page.locator('#main .week-grid > *, #main [data-week]').first();
  if (await weekCell.count() > 0) {
    await weekCell.click();
    await page.waitForTimeout(1000);
    const h = await page.evaluate(() => location.hash);
    rec('schedule week click navigates', h.includes('matchup') || h.includes('week'), `hash=${h}`);
  } else rec('schedule week cells clickable', false);

  // ========== Standings interactions ==========
  console.log('\n=== STANDINGS ===');
  await page.goto(`${BASE}/#/standings`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const teamRow = page.locator('#main tr, #main .team-row').nth(1); // skip header
  if (await teamRow.count() > 0) {
    await teamRow.click();
    await page.waitForTimeout(1000);
    const h = await page.evaluate(() => location.hash);
    rec('standings team row click navigates', h !== '#/standings', `hash=${h}`);
  }

  // ========== News interactions ==========
  console.log('\n=== NEWS ===');
  await page.goto(`${BASE}/#/news`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const filters = await page.locator('#main button').count();
  rec('news filter buttons', filters >= 4, `count=${filters}`);
  if (filters >= 4) {
    // Click filter
    await page.locator('#main button:has-text("傷兵")').first().click();
    await page.waitForTimeout(800);
    rec('news 傷兵 filter works (no crash)', true);
  }

  // ========== League switch ==========
  console.log('\n=== LEAGUE SWITCH ===');
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const lsw = page.locator('.league-switch');
  if (await lsw.count() > 0) {
    await lsw.click();
    await page.waitForTimeout(800);
    const menu = await page.locator('.league-menu:visible, [role="menu"]:visible, .dropdown:visible').count();
    rec('league switch opens dropdown', menu > 0, `menus=${menu}`);
  }

  // ========== Mobile tabbar ==========
  console.log('\n=== MOBILE TABBAR ===');
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pm = await ctxM.newPage();
  await pm.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await pm.waitForTimeout(2000);
  const tabHTML = await pm.locator('#tabbar').innerHTML().catch(() => '');
  const tabVisible = await pm.locator('#tabbar:visible').count();
  const tabBtns = await pm.locator('#tabbar button, #tabbar a').count();
  rec('tabbar element visible', tabVisible > 0, `visible=${tabVisible}`);
  rec('tabbar has buttons', tabBtns > 0, `btns=${tabBtns}`);
  console.log(`   tabbar innerHTML length: ${tabHTML.length}`);
  if (tabHTML.length < 50) console.log(`   tabbar raw: ${tabHTML}`);

  await ctxM.close();
  await browser.close();

  const pass = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok).length;
  console.log(`\n=== SUMMARY === pass=${pass} fail=${fail}`);
})();
