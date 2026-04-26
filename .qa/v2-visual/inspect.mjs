// Deep inspection of what's actually in the DOM per route
import { chromium } from 'playwright';
const BASE = 'https://nbafantasy.cda1234567.com';
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const routes = ['home', 'matchup', 'roster', 'draft', 'trade', 'fa', 'schedule', 'standings', 'news'];
  for (const r of routes) {
    await page.evaluate((rr) => { location.hash = '#/' + rr; }, r);
    await page.waitForTimeout(1500);
    const dump = await page.evaluate(() => {
      const main = document.querySelector('#main');
      if (!main) return { chars: 0 };
      // First-level child tags
      const direct = [...main.children].map(c => `${c.tagName.toLowerCase()}.${(c.className||'').toString().slice(0,50).replace(/\s+/g,'.')}`);
      // Buttons inside
      const btns = [...main.querySelectorAll('button')].map(b => b.innerText.trim().slice(0,20)).slice(0, 20);
      return {
        chars: main.innerText.length,
        direct,
        btnCount: main.querySelectorAll('button').length,
        btns,
        inputCount: main.querySelectorAll('input, select').length,
        linkCount: main.querySelectorAll('a').length,
        text: main.innerText.slice(0, 300).replace(/\s+/g,' '),
      };
    });
    console.log(`\n=== /${r} ===`);
    console.log(`chars=${dump.chars} btns=${dump.btnCount} inputs=${dump.inputCount} links=${dump.linkCount}`);
    console.log(`direct: ${(dump.direct||[]).slice(0,5).join('  ')}`);
    console.log(`btns: ${(dump.btns||[]).join(' | ')}`);
    console.log(`text: ${dump.text}`);
  }
  await browser.close();
})();
