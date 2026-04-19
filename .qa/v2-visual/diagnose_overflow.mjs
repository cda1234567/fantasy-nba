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
    const all = document.querySelectorAll('*');
    const offenders = [];
    all.forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.right > docW + 1 && r.width > 50) {
        const rect = {
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          cls: el.className || null,
          left: Math.round(r.left),
          right: Math.round(r.right),
          width: Math.round(r.width),
          overflow: Math.round(r.right - docW),
        };
        if (typeof rect.cls === 'string') rect.cls = rect.cls.slice(0, 60);
        offenders.push(rect);
      }
    });
    // Keep only top-level offenders (highest in tree)
    offenders.sort((a,b) => b.overflow - a.overflow);
    return { docW, offenders: offenders.slice(0, 15) };
  });

  console.log('docW=', diag.docW);
  diag.offenders.forEach(o => {
    console.log(`  ${o.tag}${o.id?'#'+o.id:''}${o.cls?'.'+String(o.cls).replace(/\s+/g,'.'):''}  left=${o.left} right=${o.right} width=${o.width} overflow=+${o.overflow}`);
  });

  await browser.close();
})();
