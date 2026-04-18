// Pair R3-D QA: trade edge cases, force-execute, trade deadline
// UI-only via Playwright headless Chromium.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TARGET = 'https://nbafantasy.cda1234567.com';
const LEAGUE_ID = 'round3-d';
const REPORT_DIR = 'D:/claude/fantasy nba/.qa/round3/d';
const REPORT_PATH = path.join(REPORT_DIR, 'player.md');

const findings = {
  steps: [],
  xssExecuted: false,
  xssDialogText: null,
  startedAt: new Date().toISOString(),
  version: null,
  pairing: 'R3-D',
  target: TARGET,
  league: LEAGUE_ID,
  screenshots: [],
};

function log(msg, data) {
  const ts = new Date().toISOString();
  const line = data ? `[${ts}] ${msg} :: ${JSON.stringify(data)}` : `[${ts}] ${msg}`;
  console.log(line);
  findings.steps.push(line);
}

async function snap(page, name) {
  try {
    const f = path.join(REPORT_DIR, `snap_${name}.png`);
    await page.screenshot({ path: f, fullPage: false });
    findings.screenshots.push(f);
  } catch (e) { log('snap-fail', { name, err: String(e) }); }
}

async function dismissToasts(page) {
  try { await page.evaluate(() => {
    document.querySelectorAll('.toast, .toasts, .dialog.open').forEach(el => { /* noop */ });
  }); } catch {}
}

async function waitUi(page, ms = 500) { await page.waitForTimeout(ms); }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // XSS detector — grab any native alert/confirm/prompt.
  page.on('dialog', async (d) => {
    findings.xssExecuted = true;
    findings.xssDialogText = `${d.type()}: ${d.message()}`;
    log('NATIVE DIALOG FIRED', { type: d.type(), message: d.message() });
    try { await d.dismiss(); } catch {}
  });

  page.on('pageerror', (e) => log('pageerror', { msg: e.message }));
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('XSS') || t.includes('alert') || t.includes('ReferenceError')) log('console', { type: m.type(), text: t.slice(0, 200) });
  });

  try {
    log('step-1 open target');
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await waitUi(page, 800);
    findings.version = await page.$eval('#app-version', el => el.textContent.trim()).catch(() => null);
    log('version', { v: findings.version });
    await snap(page, '01_loaded');

    // ---- Step 2: create league round3-d and switch to it
    log('step-2 open league switcher and create new league');
    await page.click('#btn-league-switch');
    await waitUi(page, 400);
    // Check if league already exists; if yes, switch. Else create.
    const existingPick = await page.$(`.lsw-pick[data-league="${LEAGUE_ID}"]`);
    if (existingPick) {
      log('league already exists, switching');
      const disabled = await existingPick.isDisabled();
      if (!disabled) {
        await existingPick.click();
        await page.waitForLoadState('domcontentloaded');
        await waitUi(page, 1500);
      } else {
        log('already active');
        await page.click('#btn-league-switch'); // close
      }
    } else {
      await page.click('#btn-lsw-new');
      await waitUi(page, 400);
      await page.fill('#new-league-id', LEAGUE_ID);
      await page.click('#btn-new-league-create');
      await waitUi(page, 2500);
      // page reloads
      await page.waitForLoadState('domcontentloaded');
      await waitUi(page, 1500);
    }
    await snap(page, '02_league_created');

    // Verify active league
    const activeLabel = await page.$eval('#lsw-current', el => el.textContent.trim()).catch(() => '');
    log('active-league', { label: activeLabel });

    // ---- Step 3: Setup -> run draft -> start season
    log('step-3 running setup + draft + season start');
    // If redirected to setup, finish setup with defaults by clicking "建立聯盟" / save button.
    const url = page.url();
    log('url', { url });

    // Look for the setup submit button. The setup page likely has a submit button like "建立" or similar.
    // We'll try common selectors.
    const setupSubmit = await page.locator('button:has-text("建立聯盟"), button:has-text("確認並建立"), button:has-text("建立並進入選秀"), button:has-text("開始選秀"), button:has-text("儲存並開始")').first();
    if (await setupSubmit.count() > 0) {
      log('setup-submit clicking');
      await setupSubmit.click().catch(e => log('setup-click-err', { e: String(e) }));
      await waitUi(page, 2500);
    } else {
      log('no-setup-submit-found (might already be past setup)');
    }
    await snap(page, '03_after_setup');

    // Go to draft route
    await page.goto(TARGET + '/#draft', { waitUntil: 'domcontentloaded' });
    await waitUi(page, 1500);
    await snap(page, '04_draft_view');

    // Try auto-draft: look for "自動選秀" / "模擬到我" / "推進 AI" / "自動完成" / "一鍵完成" type buttons
    log('attempting auto-draft');
    for (let i = 0; i < 30; i++) {
      const btnAuto = page.locator('button:has-text("自動完成選秀"), button:has-text("一鍵自動選秀"), button:has-text("全部自動"), button:has-text("模擬到我"), button:has-text("AI 自動選完"), button:has-text("自動選秀"), button:has-text("跳過到結束")').first();
      if (await btnAuto.count() > 0 && await btnAuto.isEnabled().catch(() => false)) {
        await btnAuto.click().catch(() => {});
        await waitUi(page, 1500);
      } else {
        const advance = page.locator('button:has-text("推進 AI 一手")').first();
        if (await advance.count() > 0 && await advance.isEnabled().catch(() => false)) {
          await advance.click().catch(() => {});
          await waitUi(page, 400);
        } else {
          break;
        }
      }
      // Break when draft complete (btn-start-season appears or 已完成 text)
      const done = await page.locator('button:has-text("開始賽季")').count();
      if (done > 0) { log('draft done detected'); break; }
    }
    await snap(page, '05_draft_done');

    // If human team still needs to pick, we must pick for them.
    // Try to detect "你上場" or "該你選" indicator and click first available player
    for (let i = 0; i < 16; i++) {
      const needPick = await page.locator('text=/你.*選|該.*你|輪到你/').count();
      if (needPick === 0) break;
      // pick first player in draft list
      const firstPick = page.locator('[data-draft]').first();
      if (await firstPick.count() > 0) {
        await firstPick.click().catch(() => {});
        await waitUi(page, 400);
        // confirm
        const confirm = page.locator('#confirm-ok, button:has-text("確定"), button:has-text("選他")').first();
        if (await confirm.count() > 0) { await confirm.click().catch(() => {}); }
        await waitUi(page, 600);
      } else {
        break;
      }
      // continue auto for AI
      const advance = page.locator('button:has-text("模擬到我"), button:has-text("推進 AI 一手")').first();
      if (await advance.count() > 0) { await advance.click().catch(() => {}); await waitUi(page, 600); }
    }

    // Start season
    const startSeason = page.locator('button:has-text("開始賽季")').first();
    if (await startSeason.count() > 0) {
      log('start-season click');
      await startSeason.click().catch(() => {});
      await waitUi(page, 2000);
    } else {
      log('start-season button not found');
    }
    await snap(page, '06_season_started');

    // ---- Step 4: open 發起交易 dialog
    log('step-4 open propose trade dialog');
    await page.goto(TARGET + '/#teams', { waitUntil: 'domcontentloaded' });
    await waitUi(page, 1500);
    // Find and click the propose trade button
    const btnPropose = page.locator('#btn-propose-trade').first();
    if (await btnPropose.count() === 0) {
      // fallback
      const btn2 = page.locator('button:has-text("發起交易")').first();
      if (await btn2.count() > 0) await btn2.click(); else log('no-propose-button-found');
    } else {
      await btnPropose.click();
    }
    await waitUi(page, 1200);
    await snap(page, '07_trade_dialog');

    // ==== 5a: Empty proposal submit attempt ====
    log('step-5a empty proposal');
    const emptyResult = { submitted: false, toastShown: null };
    // Select a counterparty first (need a selected team), to reach empty-picks state
    const cpSelect = page.locator('#cp-select');
    if (await cpSelect.count() > 0) {
      const opts = await page.$$eval('#cp-select option', os => os.map(o => ({ v: o.value, t: o.textContent })));
      log('cp-options', { opts: opts.slice(0, 10) });
      // pick first non-empty option
      const firstOpt = opts.find(o => o.v && o.v !== '');
      if (firstOpt) {
        await cpSelect.selectOption(firstOpt.v);
        await waitUi(page, 1200);
      }
    }
    // Click submit with zero players on either side
    await page.click('#btn-trade-propose-submit').catch(() => {});
    await waitUi(page, 800);
    // Check if toast appeared
    const toast1 = await page.locator('.toast, .toasts, [class*="toast"]').last().innerText().catch(() => '');
    emptyResult.toastShown = toast1;
    emptyResult.submitted = !!(toast1 && /至少|請/.test(toast1));
    // Verify dialog still open
    const dlgOpen1 = await page.locator('#trade-propose[open]').count();
    emptyResult.stillOpen = dlgOpen1 > 0;
    log('5a-result', emptyResult);
    await snap(page, '08_empty_proposal');

    // Helper to pick players in propose dialog.
    async function pickSide(which, n) {
      // which = 'send' or 'receive'; side order: first is send (your), second is receive (theirs)
      const col = which === 'send' ? 0 : 1;
      const sides = page.locator('.propose-side');
      const count = await sides.count();
      if (count < 2) { log('pickSide: sides not found', { count }); return 0; }
      const checks = sides.nth(col).locator('input[type="checkbox"]');
      const total = await checks.count();
      const want = Math.min(n, total);
      let picked = 0;
      for (let i = 0; i < total && picked < want; i++) {
        const cb = checks.nth(i);
        if (!(await cb.isChecked())) {
          await cb.click().catch(() => {});
          await waitUi(page, 150);
          picked++;
        }
      }
      return picked;
    }

    async function clearAll() {
      const sides = page.locator('.propose-side');
      const count = await sides.count();
      for (let s = 0; s < count; s++) {
        const checks = sides.nth(s).locator('input[type="checkbox"]:checked');
        const c = await checks.count();
        for (let i = c - 1; i >= 0; i--) {
          await checks.nth(i).click().catch(() => {});
          await waitUi(page, 80);
        }
      }
    }

    // ==== 5b: 1-for-3 and 3-for-1 lopsided ====
    log('step-5b 1-for-3 lopsided');
    await clearAll();
    const p1 = await pickSide('send', 1);
    const p3 = await pickSide('receive', 3);
    log('picks 1-for-3', { send: p1, receive: p3 });
    // Read balance ratio if displayed
    const bal = await page.locator('.propose-balance').innerText().catch(() => '');
    log('balance-1v3', { bal });
    // Submit (do NOT force), should go through AI
    await page.click('#btn-trade-propose-submit').catch(() => {});
    await waitUi(page, 2000);
    // Check toast
    const toast_1v3 = await page.locator('.toast').last().innerText().catch(() => '');
    log('5b-1v3 toast', { toast: toast_1v3 });
    // Re-open dialog for 3v1
    await waitUi(page, 500);
    // Dialog closes after submit on success; reopen
    const stillOpenAfter1v3 = await page.locator('#trade-propose[open]').count();
    log('dialog-after-1v3', { open: stillOpenAfter1v3 });
    if (!stillOpenAfter1v3) {
      await page.locator('#btn-propose-trade').click().catch(() => {});
      await waitUi(page, 1000);
      const opts2 = await page.$$eval('#cp-select option', os => os.map(o => o.value));
      const v2 = opts2.find(v => v && v !== '');
      if (v2) { await page.selectOption('#cp-select', v2); await waitUi(page, 1000); }
    }

    log('step-5b 3-for-1 lopsided');
    await clearAll();
    const p3b = await pickSide('send', 3);
    const p1b = await pickSide('receive', 1);
    log('picks 3-for-1', { send: p3b, receive: p1b });
    const bal2 = await page.locator('.propose-balance').innerText().catch(() => '');
    log('balance-3v1', { bal: bal2 });
    await page.click('#btn-trade-propose-submit').catch(() => {});
    await waitUi(page, 2000);
    const toast_3v1 = await page.locator('.toast').last().innerText().catch(() => '');
    log('5b-3v1 toast', { toast: toast_3v1 });
    await snap(page, '09_lopsided');

    // ==== 5c: force-execute checkbox ====
    log('step-5c force-execute');
    const reopen1 = await page.locator('#trade-propose[open]').count();
    if (!reopen1) {
      await page.locator('#btn-propose-trade').click().catch(() => {});
      await waitUi(page, 1000);
      const opts3 = await page.$$eval('#cp-select option', os => os.map(o => o.value));
      const v3 = opts3.find(v => v && v !== '');
      if (v3) { await page.selectOption('#cp-select', v3); await waitUi(page, 1000); }
    }
    await clearAll();
    await pickSide('send', 1);
    await pickSide('receive', 1);
    // tick force
    await page.check('#trade-force').catch(() => {});
    const warnVisible = await page.locator('#trade-force-warn').isVisible().catch(() => false);
    log('force-warn visible', { warnVisible });
    await snap(page, '10_force_checked');
    await page.click('#btn-trade-propose-submit').catch(() => {});
    await waitUi(page, 2500);
    const toast_force = await page.locator('.toast').last().innerText().catch(() => '');
    log('5c-force toast', { toast: toast_force });
    // Check pending & history panels for "強制執行" badge or executed result
    await waitUi(page, 1500);
    await snap(page, '11_after_force');

    // ==== 5d: pending trades / activity log check ====
    log('step-5d pending + activity log');
    // Go to matchup or teams view to see pending trades panel
    await page.goto(TARGET + '/#teams', { waitUntil: 'domcontentloaded' });
    await waitUi(page, 1500);
    const pendingBody = await page.locator('#trade-pending-body').innerText().catch(() => '');
    log('pending-body-snippet', { body: pendingBody.slice(0, 400) });
    // Open trade history panel
    await page.locator('#panel-trade-history .panel-head, #panel-trade-history [role="button"], #panel-trade-history h2').first().click().catch(() => {});
    await waitUi(page, 1200);
    const historyBody = await page.locator('#trade-history-body').innerText().catch(() => '');
    log('history-body-snippet', { body: historyBody.slice(0, 500) });
    await snap(page, '12_pending_and_history');

    // Activity log
    const logList = await page.locator('#log-list').innerText().catch(() => '');
    log('activity-log-snippet', { body: logList.slice(0, 800) });

    // ==== 5e: 300-char cap ====
    log('step-5e 300-char cap');
    // Reopen dialog
    const open5e = await page.locator('#trade-propose[open]').count();
    if (!open5e) {
      await page.locator('#btn-propose-trade').click().catch(() => {});
      await waitUi(page, 1000);
      const opts5 = await page.$$eval('#cp-select option', os => os.map(o => o.value));
      const v5 = opts5.find(v => v && v !== '');
      if (v5) { await page.selectOption('#cp-select', v5); await waitUi(page, 1000); }
    }
    const msg400 = 'A'.repeat(400);
    // Use keyboard paste: set value directly via fill (should be clipped to 300 by maxlength)
    await page.fill('#trade-message', msg400).catch(() => {});
    const actualLen = await page.$eval('#trade-message', el => el.value.length).catch(() => -1);
    const maxAttr = await page.$eval('#trade-message', el => el.getAttribute('maxlength')).catch(() => null);
    log('5e-length-after-fill', { actualLen, maxAttr });
    // Try bypass via evaluate (simulating paste that could sneak through)
    await page.evaluate(() => {
      const t = document.getElementById('trade-message');
      if (t) {
        // Try direct value set with oversize string
        t.value = 'B'.repeat(400);
        t.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    const bypassLen = await page.$eval('#trade-message', el => el.value.length).catch(() => -1);
    log('5e-length-after-js-set', { bypassLen });

    // ==== 5f: XSS-ish message ====
    log('step-5f XSS test');
    const xssPayload = '<img src=x onerror=alert(1)>';
    await page.fill('#trade-message', xssPayload);
    // Ensure a valid 1-for-1 so we can actually submit
    await clearAll();
    await pickSide('send', 1);
    await pickSide('receive', 1);
    // Tick force so it executes immediately and flows into history/log
    await page.check('#trade-force').catch(() => {});
    await snap(page, '13_xss_prepared');
    await page.click('#btn-trade-propose-submit').catch(() => {});
    await waitUi(page, 3000);

    // Check pending/history for the payload render
    await page.goto(TARGET + '/#teams', { waitUntil: 'domcontentloaded' });
    await waitUi(page, 1500);
    // Open history panel
    await page.locator('#panel-trade-history h2, #panel-trade-history .panel-head').first().click().catch(() => {});
    await waitUi(page, 1500);
    // Look for an img src=x in the rendered DOM
    const domHasImgX = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs.some(img => {
        const s = img.getAttribute('src') || '';
        return s === 'x' || s.includes('x') && img.hasAttribute('onerror');
      });
    });
    const rawTextPresent = await page.evaluate((payload) => {
      return document.body.innerText.includes(payload);
    }, xssPayload);
    log('5f-xss-check', { domHasImgX, rawTextPresent, nativeDialog: findings.xssExecuted });
    await snap(page, '14_xss_after');

    // ==== Step 6: advance to past trade deadline ====
    log('step-6 advance weeks to past trade deadline');
    await page.goto(TARGET + '/#league', { waitUntil: 'domcontentloaded' });
    await waitUi(page, 1200);
    // Read trade deadline setting
    const deadlineText = await page.locator('text=/交易截止/').first().innerText().catch(() => '');
    log('deadline-setting', { deadlineText });
    // Use sim-to-playoffs or press "推進一週" until past deadline
    await page.goto(TARGET + '/#schedule', { waitUntil: 'domcontentloaded' });
    await waitUi(page, 1200);

    // Try sim-to-playoffs button (fast)
    const simPO = page.locator('button:has-text("模擬到季後賽")').first();
    if (await simPO.count() > 0 && await simPO.isEnabled().catch(() => false)) {
      log('clicking 模擬到季後賽');
      await simPO.click().catch(() => {});
      await waitUi(page, 1000);
      // confirm
      const confirmOk = page.locator('#confirm-ok, button:has-text("執行")').first();
      if (await confirmOk.count() > 0) { await confirmOk.click().catch(() => {}); }
      // Wait for simulation, it can take a while
      for (let i = 0; i < 45; i++) {
        await waitUi(page, 2000);
        const busy = await page.locator('.toast:has-text("推進中")').count();
        if (busy === 0) break;
      }
    } else {
      log('no sim-to-playoffs, pressing 推進一週 x 12');
      for (let i = 0; i < 12; i++) {
        const adv = page.locator('button:has-text("推進一週")').first();
        if (await adv.count() === 0) break;
        await adv.click().catch(() => {});
        await waitUi(page, 2500);
      }
    }
    await snap(page, '15_after_advance');

    // Check current week
    const weekText = await page.locator('text=/第.*週|Week/').first().innerText().catch(() => '');
    log('current-week', { weekText });

    // Step 6b: try proposing a new trade now
    log('step-6b trying propose after deadline');
    await page.goto(TARGET + '/#teams', { waitUntil: 'domcontentloaded' });
    await waitUi(page, 1500);
    await page.locator('#btn-propose-trade').click().catch(() => {});
    await waitUi(page, 1200);
    const dlgOpen = await page.locator('#trade-propose[open]').count();
    log('propose-dialog-opens-after-deadline', { open: dlgOpen });
    // Attempt submit
    if (dlgOpen > 0) {
      const opts6 = await page.$$eval('#cp-select option', os => os.map(o => o.value));
      const v6 = opts6.find(v => v && v !== '');
      if (v6) { await page.selectOption('#cp-select', v6); await waitUi(page, 1000); }
      await pickSide('send', 1);
      await pickSide('receive', 1);
      await page.click('#btn-trade-propose-submit').catch(() => {});
      await waitUi(page, 2500);
      const deadToast = await page.locator('.toast').last().innerText().catch(() => '');
      log('deadline-toast', { toast: deadToast });
      await snap(page, '16_deadline_attempt');
    }

    // Step 7: activity log check
    log('step-7 activity log final');
    await page.goto(TARGET + '/#teams', { waitUntil: 'domcontentloaded' });
    await waitUi(page, 1200);
    const finalLog = await page.locator('#log-list').innerText().catch(() => '');
    log('final-activity-log', { body: finalLog.slice(0, 1500) });
    await snap(page, '17_final_log');

    // Export findings
    fs.writeFileSync(path.join(REPORT_DIR, 'findings.json'), JSON.stringify(findings, null, 2));
    log('DONE');
  } catch (e) {
    log('FATAL', { err: String(e), stack: e.stack });
  } finally {
    fs.writeFileSync(path.join(REPORT_DIR, 'findings.json'), JSON.stringify(findings, null, 2));
    await browser.close();
  }
})();
