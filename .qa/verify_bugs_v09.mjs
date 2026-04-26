// Smoke test for v26.04.24.09 bug fixes.
// 1) Draft completes without any 409 from /api/draft/ai-advance
// 2) League Management tab has visible advance/sim buttons
// 3) Trade propose modal submit button is visible
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8766';
const out = { bug1: null, bug2: null, bug3: null, bug4: null, console_409: 0, errors: [] };

function log(k, v) { out[k] = v; console.log(`[${k}] ${JSON.stringify(v)}`); }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  // Count 409 from ai-advance + other console errors
  page.on('response', (resp) => {
    if (resp.url().includes('/api/draft/ai-advance') && resp.status() === 409) {
      out.console_409 += 1;
    }
  });
  page.on('pageerror', (e) => out.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') out.errors.push(m.text()); });

  try {
    // Reset league to have a clean start.
    await page.goto(`${BASE}/v2#/draft`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    // Reset draft via API to force fresh run.
    await page.evaluate(async () => {
      await fetch('/api/draft/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    // Draft: spam sim-to-me until complete, then watch for 409.
    // Use the 模擬到我 button if human turn, otherwise wait for AI auto-advance.
    const maxRounds = 200;
    let done = false;
    for (let i = 0; i < maxRounds && !done; i++) {
      // If human turn, pick top available or use sim-to-me
      const simToMe = await page.$('button:has-text("模擬到我")');
      if (simToMe && !(await simToMe.isDisabled())) {
        await simToMe.click().catch(() => {});
        await page.waitForTimeout(700);
      }
      // On human turn, pick the first player in available table
      const pickBtn = await page.$('button[data-draft]:not([disabled])');
      if (pickBtn) {
        await pickBtn.click().catch(() => {});
        await page.waitForTimeout(500);
      } else {
        await page.waitForTimeout(800);
      }
      const d = await page.evaluate(async () => {
        const r = await fetch('/api/state'); return r.json();
      });
      if (d?.is_complete) { done = true; break; }
    }
    log('bug4_draft_complete', done);

    // After draft completes, wait 3s to let any stray timers fire.
    await page.waitForTimeout(3500);
    log('bug4_409_count', out.console_409);

    // Start season
    await page.evaluate(async () => {
      await fetch('/api/season/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    });
    await page.waitForTimeout(400);

    // Go to league view; the global action bar should have visible advance buttons.
    await page.goto(`${BASE}/v2#/league`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    // Bug 1: advance-day button in league view actions bar must be visible+enabled.
    const advBtn = await page.$('#league-actions button:has-text("推進一天")');
    const advVis = advBtn ? await advBtn.isVisible() : false;
    const advEnabled = advBtn ? !(await advBtn.isDisabled()) : false;
    log('bug1_advance_day_visible', advVis && advEnabled);

    const advWeekBtn = await page.$('#league-actions button:has-text("推進一週")');
    const advWeekVis = advWeekBtn ? await advWeekBtn.isVisible() : false;
    log('bug1_advance_week_visible', advWeekVis);

    // Bug 2: sim-to-playoffs should be visible when there is no champion yet.
    const simBtn = await page.$('#league-actions button:has-text("模擬到季後賽")');
    const simVis = simBtn ? await simBtn.isVisible() : false;
    log('bug2_sim_to_playoffs_visible', simVis);

    // Also check Management sub-tab has these buttons
    await page.click('.lt2:has-text("聯盟")').catch(() => {});
    await page.waitForTimeout(700);
    const mgmtAdv = await page.$('.mgmt-controls button:has-text("推進一天")');
    log('bug1_mgmt_advance_day', mgmtAdv ? await mgmtAdv.isVisible() : false);
    const mgmtSim = await page.$('.mgmt-controls button:has-text("模擬到季後賽")');
    log('bug2_mgmt_sim_to_playoffs', mgmtSim ? await mgmtSim.isVisible() : false);

    // Bug 3: Trade propose modal submit button visibility
    await page.goto(`${BASE}/v2#/trades`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    // Open modal via the 發起新交易 button
    const openBtn = await page.$('button:has-text("＋ 發起新交易")');
    if (openBtn) {
      await openBtn.click();
      await page.waitForTimeout(700);
      const submit = await page.$('#btn-trade-propose-submit-v2');
      if (submit) {
        const vis = await submit.isVisible();
        const box = await submit.boundingBox();
        log('bug3_submit_visible', { visible: vis, box });
      } else {
        log('bug3_submit_visible', { error: 'button not in DOM' });
      }
    } else {
      log('bug3_submit_visible', { error: 'open button missing' });
    }

    log('errors', out.errors);
  } finally {
    await browser.close();
  }
  console.log('=== SUMMARY ===');
  console.log(JSON.stringify(out, null, 2));
  // Exit code: 0 if all pass
  const ok = out.bug1_advance_day_visible && out.bug1_advance_week_visible
    && out.bug2_sim_to_playoffs_visible && out.bug3_submit_visible?.visible
    && out.bug4_draft_complete && out.bug4_409_count === 0;
  process.exit(ok ? 0 : 1);
})();
