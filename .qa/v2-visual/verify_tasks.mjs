// Quick verification of Tasks B/C/D on live deploy.
import { chromium } from 'playwright';

const BASE = 'https://nbafantasy.cda.tw';
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const results = { v1: {}, draft: {}, errors: [] };
page.on('pageerror', (e) => results.errors.push(String(e)));

try {
  // 1. v1 league page — Task B (home brief + actions)
  await page.goto(`${BASE}/v1#league`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2500);
  const html = await page.content();
  results.v1.has_home_brief_card = html.includes('home-brief-card');
  results.v1.has_home_actions_card = html.includes('home-actions-card');
  results.v1.has_brief_text = (await page.locator('.home-brief-text').count()) > 0;
  results.v1.has_actions_panel_text = (await page.locator('.home-actions-card').count()) > 0;
  results.v1.title = await page.title();

  // 2. v1 draft page — Task C (AI 推薦)
  await page.goto(`${BASE}/v1#draft`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2500);
  const dHtml = await page.content();
  results.draft.has_recos_container = dHtml.includes('draft-recos-container');
  results.draft.recos_card_count = await page.locator('.draft-recos-card').count();
  results.draft.draft_complete_or_no_recos = dHtml.includes('選秀完成') || (await page.locator('.draft-recos-card').count()) === 0;

  // 3. v1 trade page — Task D (skip if no trades)
  await page.goto(`${BASE}/v1#league`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  const tradesTab = page.locator('.league-tab', { hasText: '交易' }).first();
  if (await tradesTab.count()) {
    await tradesTab.click();
    await page.waitForTimeout(1500);
    results.v1.trade_odds_toggles = await page.locator('.trade-odds-toggle').count();
  }

  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('VERIFY_FAIL', err.message);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
