import { chromium } from 'playwright';
const BASE = 'https://nbafantasy.cda1234567.com';
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/v2#/home`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const diag = await page.evaluate(() => {
    const docW = document.documentElement.clientWidth;
    const scrollW = document.documentElement.scrollWidth;
    const bodyW = document.body.scrollWidth;
    const all = document.querySelectorAll('*');
    const offenders = [];
    all.forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.right > docW + 1) {
        offenders.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          cls: (el.className || '').toString().slice(0, 80),
          left: Math.round(r.left),
          right: Math.round(r.right),
          width: Math.round(r.width),
          overflow: Math.round(r.right - docW),
        });
      }
    });
    offenders.sort((a,b) => b.overflow - a.overflow);
    return { docW, scrollW, bodyW, offenders: offenders.slice(0, 30) };
  });
  console.log('docW=', diag.docW, 'scrollW=', diag.scrollW, 'bodyW=', diag.bodyW);
  diag.offenders.forEach(o => {
    console.log(`  ${o.tag}${o.id?'#'+o.id:''}${o.cls?'.'+String(o.cls).replace(/\s+/g,'.'):''}  L=${o.left} R=${o.right} W=${o.width} over=+${o.overflow}`);
  });
  await browser.close();
})();
