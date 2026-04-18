// R3-B Watcher: UI-only observation of round3-b league
// Hard rules: headless, UI only, NO /api/* calls
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TARGET = 'https://nbafantasy.cda1234567.com';
const LEAGUE = 'round3-b';
const REPORT = 'D:/claude/fantasy nba/.qa/round3/b/watcher.md';
const MAX_MINUTES = 25;
const START = Date.now();

const observations = [];
const consoleErrors = [];
const networkErrors = [];
const issues = [];

function ts() {
  return new Date().toISOString();
}

function elapsed() {
  return Math.round((Date.now() - START) / 1000);
}

function log(msg) {
  const line = `[${ts()}] (+${elapsed()}s) ${msg}`;
  console.log(line);
  return line;
}

function writeReport(status) {
  const lines = [];
  lines.push('# R3-B Watcher Report');
  lines.push('');
  lines.push(`Status: ${status}`);
  lines.push(`Start: ${new Date(START).toISOString()}`);
  lines.push(`Last update: ${ts()}`);
  lines.push(`Elapsed: ${elapsed()}s`);
  lines.push(`Target: ${TARGET}`);
  lines.push(`League: ${LEAGUE}`);
  lines.push('');
  lines.push('## Timestamped Observations');
  lines.push('');
  if (observations.length === 0) {
    lines.push('_none yet_');
  } else {
    for (const o of observations) lines.push(`- ${o}`);
  }
  lines.push('');
  lines.push('## Console Errors');
  lines.push('');
  if (consoleErrors.length === 0) {
    lines.push('_none_');
  } else {
    for (const e of consoleErrors) lines.push(`- ${e}`);
  }
  lines.push('');
  lines.push('## Network non-2xx');
  lines.push('');
  if (networkErrors.length === 0) {
    lines.push('_none_');
  } else {
    for (const e of networkErrors) lines.push(`- ${e}`);
  }
  lines.push('');
  lines.push('## UI / UX / A11y Issues');
  lines.push('');
  if (issues.length === 0) {
    lines.push('_none_');
  } else {
    for (const i of issues) lines.push(`- ${i}`);
  }
  lines.push('');
  fs.writeFileSync(REPORT, lines.join('\n'));
}

function issue(msg) {
  const line = `[${ts()}] ${msg}`;
  issues.push(line);
  console.log('ISSUE:', line);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      const text = msg.text();
      const line = `[${ts()}] [${type}] ${text.substring(0, 500)}`;
      consoleErrors.push(line);
    }
  });

  page.on('pageerror', (err) => {
    consoleErrors.push(`[${ts()}] [pageerror] ${err.message}`);
  });

  page.on('response', async (resp) => {
    try {
      const status = resp.status();
      const url = resp.url();
      if (status >= 400) {
        networkErrors.push(`[${ts()}] ${status} ${resp.request().method()} ${url}`);
      }
    } catch (e) {}
  });

  observations.push(log('Navigating to target'));
  try {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    observations.push(log(`Navigation failed: ${e.message}`));
    writeReport('FAILED');
    await browser.close();
    return;
  }

  await page.waitForTimeout(2000);
  observations.push(log(`Title: ${await page.title()}`));
  writeReport('RUNNING');

  // Wait 60s before first poll so the player has time to create the league
  observations.push(log('Initial 60s wait before polling for round3-b'));
  writeReport('RUNNING');
  await page.waitForTimeout(60000);

  // Poll up to 5 min looking for round3-b in switcher
  let foundLeague = false;
  const pollDeadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < pollDeadline) {
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);
    } catch (e) {
      observations.push(log(`Reload error: ${e.message}`));
    }

    // Look for league selector - try common patterns
    let found = false;
    try {
      // Try select element first
      const selects = await page.locator('select').all();
      for (const sel of selects) {
        const options = await sel.locator('option').allTextContents();
        if (options.some((o) => o && o.toLowerCase().includes('round3-b'))) {
          found = true;
          try {
            await sel.selectOption({ label: options.find((o) => o.toLowerCase().includes('round3-b')) });
          } catch (e) {
            // try by value
            const vals = await sel.locator('option').evaluateAll((opts) =>
              opts.map((o) => ({ value: o.value, text: o.textContent }))
            );
            const match = vals.find((v) => (v.text || '').toLowerCase().includes('round3-b'));
            if (match) await sel.selectOption(match.value);
          }
          break;
        }
      }
      // Fallback: any element containing round3-b text we can click
      if (!found) {
        const byText = page.locator('text=round3-b').first();
        if ((await byText.count()) > 0) {
          found = true;
          try {
            await byText.click({ timeout: 3000 });
          } catch (e) {}
        }
      }
    } catch (e) {
      observations.push(log(`Switcher search error: ${e.message}`));
    }

    if (found) {
      foundLeague = true;
      observations.push(log('Found round3-b in switcher, switched'));
      break;
    }
    observations.push(log('round3-b not yet visible, waiting 20s'));
    writeReport('RUNNING');
    await page.waitForTimeout(20000);
  }

  if (!foundLeague) {
    observations.push(log('Timed out waiting for round3-b; continuing with whatever is active'));
  }

  await page.waitForTimeout(3000);

  // Snapshot 自由球員 every 60s until total runtime approaches MAX_MINUTES
  const faCounts = [];
  let iter = 0;
  while (elapsed() < MAX_MINUTES * 60 - 90) {
    iter++;
    try {
      // Navigate / click FA tab
      const faTab = page.locator('text=自由球員').first();
      if ((await faTab.count()) > 0) {
        try {
          await faTab.click({ timeout: 5000 });
          await page.waitForTimeout(1500);
        } catch (e) {
          observations.push(log(`FA tab click failed: ${e.message}`));
        }
      }

      // Count FA rows - try several selectors
      let faCount = 0;
      const candidates = [
        'table tbody tr',
        '[data-testid*="player"]',
        '.player-row',
        '[role="row"]',
        'li.player',
      ];
      for (const sel of candidates) {
        try {
          const c = await page.locator(sel).count();
          if (c > faCount) faCount = c;
        } catch (e) {}
      }

      // Look for a header count like "自由球員 (123)"
      let headerCount = null;
      try {
        const bodyText = await page.locator('body').innerText();
        const m = bodyText.match(/自由球員[^0-9]{0,20}(\d{1,4})/);
        if (m) headerCount = parseInt(m[1], 10);
      } catch (e) {}

      faCounts.push({ t: elapsed(), rows: faCount, header: headerCount });
      observations.push(log(`FA snapshot #${iter}: rows=${faCount}, header=${headerCount}`));

      // Check duplicates in visible list
      try {
        const names = await page.locator('table tbody tr td:first-child').allInnerTexts();
        const seen = new Map();
        for (const n of names) {
          const k = (n || '').trim();
          if (!k) continue;
          seen.set(k, (seen.get(k) || 0) + 1);
        }
        const dups = [...seen.entries()].filter(([, v]) => v > 1);
        if (dups.length > 0) {
          issue(`FA duplicate rows detected: ${dups.slice(0, 5).map(([n, c]) => `${n}x${c}`).join(', ')}`);
        }
      } catch (e) {}

      // Check header vs rows mismatch
      if (headerCount !== null && faCount > 0 && Math.abs(headerCount - faCount) > 5 && faCount > 1) {
        issue(`FA header (${headerCount}) vs visible rows (${faCount}) mismatch`);
      }

      // Every 3rd iteration, visit 聯盟 and 賽程 tabs
      if (iter % 3 === 0) {
        for (const tabName of ['聯盟', '賽程']) {
          try {
            const tab = page.locator(`text=${tabName}`).first();
            if ((await tab.count()) > 0) {
              await tab.click({ timeout: 5000 });
              await page.waitForTimeout(2000);
              const bodyText = await page.locator('body').innerText();
              const snippet = bodyText.substring(0, 300).replace(/\s+/g, ' ');
              observations.push(log(`${tabName} tab snapshot: ${snippet}`));
            }
          } catch (e) {
            observations.push(log(`${tabName} tab error: ${e.message}`));
          }
        }
        // Return to FA
        try {
          const faTab2 = page.locator('text=自由球員').first();
          if ((await faTab2.count()) > 0) await faTab2.click({ timeout: 3000 });
        } catch (e) {}
      }

      // On iter 2, try the settings dialog for a11y check
      if (iter === 2) {
        try {
          const settingsBtn = page.locator('button:has-text("設定"), button[aria-label*="setting" i], button[title*="setting" i]').first();
          if ((await settingsBtn.count()) > 0) {
            const prevFocus = await page.evaluate(() => document.activeElement?.tagName);
            await settingsBtn.click({ timeout: 3000 });
            await page.waitForTimeout(1000);
            const dialog = page.locator('[role="dialog"], .modal, .dialog').first();
            const hasDialog = (await dialog.count()) > 0;
            if (hasDialog) {
              const activeInDialog = await page.evaluate(() => {
                const dlg = document.querySelector('[role="dialog"], .modal, .dialog');
                return dlg && dlg.contains(document.activeElement);
              });
              const role = await dialog.getAttribute('role');
              const ariaLabel = await dialog.getAttribute('aria-label');
              const ariaLabelledBy = await dialog.getAttribute('aria-labelledby');
              observations.push(log(`Settings dialog opened: role=${role}, aria-label=${ariaLabel}, aria-labelledby=${ariaLabelledBy}, focus-in-dialog=${activeInDialog}, prevFocus=${prevFocus}`));
              if (!activeInDialog) issue('Settings dialog: focus NOT moved into dialog (a11y issue)');
              if (!role) issue('Settings dialog: missing role="dialog" (a11y issue)');
              if (!ariaLabel && !ariaLabelledBy) issue('Settings dialog: missing aria-label/aria-labelledby (a11y issue)');

              // Try ESC to close
              await page.keyboard.press('Escape');
              await page.waitForTimeout(800);
              const stillOpen = (await dialog.count()) > 0 && (await dialog.isVisible().catch(() => false));
              if (stillOpen) issue('Settings dialog does not close on Escape');
              else observations.push(log('Settings dialog closes on Escape OK'));
            } else {
              observations.push(log('Settings button clicked but no dialog element detected'));
            }
          } else {
            observations.push(log('No settings button found'));
          }
        } catch (e) {
          observations.push(log(`Settings dialog test error: ${e.message}`));
        }
      }
    } catch (e) {
      observations.push(log(`Iteration ${iter} error: ${e.message}`));
    }

    writeReport('RUNNING');
    await page.waitForTimeout(60000);
  }

  // Final trend analysis
  if (faCounts.length >= 2) {
    const first = faCounts[0];
    const last = faCounts[faCounts.length - 1];
    observations.push(log(`FA trend: start rows=${first.rows} header=${first.header} -> end rows=${last.rows} header=${last.header}`));
    // Look for non-monotonic jumps
    for (let i = 1; i < faCounts.length; i++) {
      const prev = faCounts[i - 1];
      const cur = faCounts[i];
      if (prev.rows > 0 && cur.rows > prev.rows + 3) {
        issue(`FA row count jumped UP unexpectedly at t+${cur.t}s: ${prev.rows} -> ${cur.rows}`);
      }
    }
  }

  writeReport('DONE');
  await browser.close();
})().catch((e) => {
  console.error('FATAL:', e);
  observations.push(`[${ts()}] FATAL: ${e.message}`);
  writeReport('FAILED');
});
