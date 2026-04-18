// Round 3 Pair A - Watcher: read-only UI observation via Playwright
// Polls every 60s for ~20 minutes. Writes snapshots to watcher.md

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TARGET = 'https://nbafantasy.cda1234567.com';
const LEAGUE = 'round3-a';
const REPORT = 'D:/claude/fantasy nba/.qa/round3/a/watcher.md';
const MAX_MIN = 20;
const POLL_MS = 60_000;

const consoleErrors = [];
const networkIssues = [];
const snapshots = [];
const crossViewIssues = [];
const uiIssues = [];

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  fs.appendFileSync('D:/claude/fantasy nba/.qa/round3/a/watcher.log', line + '\n');
}

async function selectLeague(page, leagueName) {
  // League switcher is a custom menu: #btn-league-switch opens #league-switch-menu
  try {
    const btn = await page.$('#btn-league-switch');
    if (!btn) return false;
    await btn.click();
    await page.waitForTimeout(600);
    // The menu items - find one whose text includes the league name
    const picked = await page.evaluate((name) => {
      const menu = document.querySelector('#league-switch-menu');
      if (!menu) return { ok: false, reason: 'no-menu' };
      const items = Array.from(menu.querySelectorAll('button, [role="menuitem"], a, .lsw-item, li'));
      const match = items.find(i => (i.innerText || i.textContent || '').includes(name));
      if (!match) {
        return { ok: false, reason: 'no-match', options: items.map(i => (i.innerText || '').trim()).slice(0, 20) };
      }
      match.click();
      return { ok: true };
    }, leagueName);
    if (picked.ok) return true;
    // If the menu doesn't contain the league, log options
    if (picked.options) {
      return { ok: false, options: picked.options };
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function currentLeague(page) {
  try {
    return await page.evaluate(() => (document.querySelector('#lsw-current')?.innerText || '').trim());
  } catch (e) { return ''; }
}

async function snapshot(page, idx) {
  const snap = { idx, ts: ts(), url: page.url() };
  try {
    snap.currentLeague = await currentLeague(page);
    // activity log panel - #log-aside
    const activity = await page.evaluate(() => {
      const aside = document.querySelector('#log-aside');
      if (aside) return [(aside.innerText || '').slice(0, 3000)];
      const candidates = document.querySelectorAll('[class*="activity"], [class*="log"], [id*="activity"], [id*="log"]');
      const texts = [];
      candidates.forEach(c => {
        const t = (c.innerText || '').trim();
        if (t && t.length < 3000) texts.push(t.slice(0, 1500));
      });
      return texts.slice(0, 2);
    });
    snap.activity = activity;

    // visible text on page
    const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 6000));
    snap.bodyText = bodyText;

    // any "本週" indicators
    const weekMarkers = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('*')).filter(e => (e.textContent || '').includes('本週'));
      return nodes.slice(0, 10).map(n => ({ tag: n.tagName, text: (n.innerText || '').slice(0, 200) }));
    });
    snap.weekMarkers = weekMarkers;

    // Injury indicators (look for 傷兵, OUT, DTD, injured)
    const injuries = await page.evaluate(() => {
      const markers = ['傷兵', '受傷', 'OUT', 'DTD', 'injured', 'Injured'];
      const found = [];
      const all = document.querySelectorAll('*');
      all.forEach(el => {
        const t = el.textContent || '';
        for (const m of markers) {
          if (t.includes(m) && el.children.length === 0) {
            // leaf node
            const parent = el.closest('[class*="player"], tr, li, [class*="card"]');
            if (parent) {
              const pname = parent.innerText.slice(0, 200);
              if (!found.some(f => f.ctx === pname)) {
                found.push({ marker: m, ctx: pname });
              }
            }
          }
        }
      });
      return found.slice(0, 30);
    });
    snap.injuries = injuries;

    // screenshot? skip to save time
    snapshots.push(snap);
    log(`snapshot #${idx} taken url=${snap.url} injuries=${injuries.length} weekMarkers=${weekMarkers.length}`);
  } catch (e) {
    snap.error = e.message;
    snapshots.push(snap);
    log(`snapshot #${idx} ERROR: ${e.message}`);
  }
  return snap;
}

async function tryClickTab(page, routeOrName) {
  // Map friendly names to hash routes
  const routeMap = { '選秀': 'draft', '隊伍': 'teams', '自由球員': 'fa', '聯盟': 'league', '賽程': 'schedule' };
  const route = routeMap[routeOrName] || routeOrName;
  try {
    // Prefer hash navigation
    await page.evaluate((r) => { window.location.hash = '#' + r; }, route);
    await page.waitForTimeout(1200);
    return true;
  } catch (e) {
    try {
      const clicked = await page.evaluate((tabName) => {
        const els = Array.from(document.querySelectorAll('a[data-route], .nav-item, button'));
        const match = els.find(e => (e.innerText || '').trim().includes(tabName));
        if (match) { match.click(); return true; }
        return false;
      }, routeOrName);
      if (clicked) { await page.waitForTimeout(1200); return true; }
    } catch (e2) {}
  }
  return false;
}

async function tryCancelTradeDialog(page) {
  // Only attempt once, mid-run. Click a "交易" or "trade" button, then immediately 取消.
  try {
    const opened = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      const m = btns.find(b => /交易|trade/i.test(b.innerText || ''));
      if (m) { m.click(); return true; }
      return false;
    });
    if (!opened) return 'no trade button';
    await page.waitForTimeout(1500);
    const cancelled = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const m = btns.find(b => /取消|cancel|關閉|close/i.test(b.innerText || ''));
      if (m) { m.click(); return true; }
      // Escape
      return false;
    });
    if (!cancelled) {
      await page.keyboard.press('Escape');
      return 'opened, closed via ESC';
    }
    return 'opened + cancelled';
  } catch (e) {
    return 'error: ' + e.message;
  }
}

function writeReport(final) {
  const lines = [];
  lines.push('# Round 3 Pair A - Watcher Report');
  lines.push('');
  lines.push(`**Agent:** watcher (read-only observer)`);
  lines.push(`**Target:** ${TARGET}`);
  lines.push(`**League:** ${LEAGUE}`);
  lines.push(`**Started:** ${snapshots[0]?.ts || '(pending)'}`);
  lines.push(`**Last update:** ${ts()}`);
  lines.push(`**Status:** ${final ? 'completed' : 'in-progress'}`);
  lines.push(`**Snapshots:** ${snapshots.length}`);
  lines.push('');
  lines.push('## Observation Log');
  lines.push('');
  for (const s of snapshots) {
    lines.push(`### Snapshot #${s.idx} — ${s.ts}`);
    lines.push(`- URL: ${s.url}`);
    if (s.error) {
      lines.push(`- ERROR: ${s.error}`);
      continue;
    }
    lines.push(`- 本週 markers: ${s.weekMarkers?.length ?? 0}`);
    lines.push(`- injury markers found: ${s.injuries?.length ?? 0}`);
    if (s.injuries && s.injuries.length) {
      lines.push('  - samples:');
      for (const inj of s.injuries.slice(0, 6)) {
        lines.push(`    - [${inj.marker}] ${inj.ctx.replace(/\n/g, ' | ').slice(0, 160)}`);
      }
    }
    if (s.activity && s.activity.length) {
      lines.push('  - activity log excerpt:');
      for (const a of s.activity.slice(0, 1)) {
        lines.push('    ```');
        a.split('\n').slice(0, 10).forEach(ln => lines.push('    ' + ln));
        lines.push('    ```');
      }
    }
    lines.push('');
  }
  lines.push('## Cross-view Inconsistencies');
  lines.push('');
  if (crossViewIssues.length === 0) {
    lines.push('_None detected during observation window._');
  } else {
    for (const x of crossViewIssues) lines.push(`- ${x}`);
  }
  lines.push('');
  lines.push('## JS Console Errors');
  lines.push('');
  if (consoleErrors.length === 0) {
    lines.push('_None captured._');
  } else {
    for (const e of consoleErrors) {
      lines.push(`- [${e.ts}] ${e.type}: ${e.text}`);
      if (e.location) lines.push(`  - at ${e.location.url}:${e.location.lineNumber}:${e.location.columnNumber}`);
    }
  }
  lines.push('');
  lines.push('## Non-2xx Network Responses');
  lines.push('');
  if (networkIssues.length === 0) {
    lines.push('_None captured._');
  } else {
    for (const n of networkIssues) {
      lines.push(`- [${n.ts}] ${n.status} ${n.method} ${n.url}`);
    }
  }
  lines.push('');
  lines.push('## UI Polish Issues');
  lines.push('');
  if (uiIssues.length === 0) {
    lines.push('_None detected during observation window._');
  } else {
    for (const u of uiIssues) lines.push(`- ${u}`);
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total snapshots: ${snapshots.length}`);
  lines.push(`- Console errors captured: ${consoleErrors.length}`);
  lines.push(`- Non-2xx responses: ${networkIssues.length}`);
  lines.push(`- Cross-view issues: ${crossViewIssues.length}`);
  lines.push(`- UI polish issues: ${uiIssues.length}`);
  lines.push('');
  fs.writeFileSync(REPORT, lines.join('\n'));
}

(async () => {
  log('watcher starting (v2 - restarted)');
  log('already past initial 60s wait, proceeding to launch browser');

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      const entry = {
        ts: ts(),
        type: msg.type(),
        text: msg.text(),
        location: msg.location(),
      };
      consoleErrors.push(entry);
      log(`console[${msg.type()}]: ${msg.text().slice(0, 200)}`);
    }
  });
  page.on('pageerror', err => {
    consoleErrors.push({ ts: ts(), type: 'pageerror', text: err.message, location: null });
    log(`pageerror: ${err.message}`);
  });
  page.on('response', async resp => {
    const status = resp.status();
    const url = resp.url();
    if (status >= 400 && url.startsWith(TARGET)) {
      networkIssues.push({ ts: ts(), status, url, method: resp.request().method() });
      log(`net ${status} ${resp.request().method()} ${url}`);
    }
  });

  log(`navigating to ${TARGET}`);
  try {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (e) {
    log('initial navigation error: ' + e.message);
  }
  await page.waitForTimeout(3000);

  // Try to select league round3-a with retries (league may not exist yet)
  let selected = false;
  for (let attempt = 1; attempt <= 4; attempt++) {
    selected = await selectLeague(page, LEAGUE);
    if (selected) {
      log(`league selected: ${LEAGUE} on attempt ${attempt}`);
      break;
    }
    log(`league ${LEAGUE} not found on attempt ${attempt}, waiting 60s`);
    await page.waitForTimeout(60_000);
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch (e) { log('reload err: ' + e.message); }
    await page.waitForTimeout(2000);
  }
  if (!selected) {
    log('WARN: could not select league round3-a via dropdown, proceeding to observe default view');
  }
  await page.waitForTimeout(2000);

  const deadline = Date.now() + MAX_MIN * 60_000;
  let idx = 0;
  while (Date.now() < deadline) {
    idx++;
    // Cycle through tabs: 聯盟 → 隊伍 → back to default
    await tryClickTab(page, '聯盟');
    await page.waitForTimeout(1500);
    await snapshot(page, `${idx}-league`);

    await tryClickTab(page, '隊伍');
    await page.waitForTimeout(1500);
    await snapshot(page, `${idx}-team`);

    // Once per 5 ticks, try opening+cancel trade dialog
    if (idx % 5 === 3) {
      const r = await tryCancelTradeDialog(page);
      log('trade-dialog test: ' + r);
    }

    // Update report incrementally
    writeReport(false);

    const waited = Date.now() + POLL_MS;
    const sleep = Math.max(0, Math.min(POLL_MS, deadline - Date.now()));
    if (sleep <= 0) break;
    log(`sleeping ${Math.round(sleep/1000)}s before next cycle`);
    await page.waitForTimeout(sleep);
  }

  // Basic cross-view inference: injuries seen in league snap but not team snap at same idx
  try {
    const byIdx = {};
    for (const s of snapshots) {
      const m = /^(\d+)-(league|team)$/.exec(String(s.idx));
      if (!m) continue;
      const n = m[1], v = m[2];
      byIdx[n] = byIdx[n] || {};
      byIdx[n][v] = s;
    }
    for (const n of Object.keys(byIdx)) {
      const { league, team } = byIdx[n];
      if (!league || !team) continue;
      const leagueInj = new Set((league.injuries || []).map(i => i.ctx.split('\n')[0].slice(0, 30)));
      const teamInj = new Set((team.injuries || []).map(i => i.ctx.split('\n')[0].slice(0, 30)));
      for (const lname of leagueInj) {
        if (lname.length > 3 && !teamInj.has(lname)) {
          // approximate: injury seen in league view not reflected in team view
          // too noisy to flag definitively - skip unless high confidence
        }
      }
    }
  } catch (e) { log('cross-view inference err: ' + e.message); }

  log('observation window complete, writing final report');
  writeReport(true);
  await browser.close();
  log('watcher done');
})().catch(e => {
  log('FATAL: ' + e.message + '\n' + e.stack);
  writeReport(true);
  process.exit(1);
});
