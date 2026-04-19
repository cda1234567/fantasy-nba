// Phase 4 responsive verification: multi-viewport screenshot matrix + layout sanity
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = process.env.BASE || 'https://nbafantasy.cda1234567.com';
const OUT = path.resolve('shots-responsive');
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'iphone-se',   w: 375,  h: 667,  isMobile: true  },
  { name: 'iphone-14',   w: 390,  h: 844,  isMobile: true  },
  { name: 'pixel-7',     w: 412,  h: 915,  isMobile: true  },
  { name: 'tablet',      w: 768,  h: 1024, isMobile: false },
  { name: 'laptop',      w: 1024, h: 768,  isMobile: false },
  { name: 'desktop-std', w: 1280, h: 800,  isMobile: false },
  { name: 'desktop-hd',  w: 1440, h: 900,  isMobile: false },
  { name: 'desktop-4k',  w: 1920, h: 1080, isMobile: false },
];

const ROUTES = ['home', 'matchup', 'roster', 'trade', 'fa', 'standings', 'news'];

const results = [];
const record = (r) => { results.push(r); };

(async () => {
  const browser = await chromium.launch({ headless: true });
  const health = await (await fetch(`${BASE}/api/health`)).json();
  console.log(`BASE=${BASE}  version=${health.version}\n`);

  for (const vp of VIEWPORTS) {
    console.log(`\n=== ${vp.name} (${vp.w}×${vp.h}) ===`);
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();

    for (const route of ROUTES) {
      await page.goto(`${BASE}/v2#/${route}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);

      const shot = path.join(OUT, `${vp.name}_${route}.png`);
      await page.screenshot({ path: shot, fullPage: false });

      // Layout checks
      const layout = await page.evaluate((w) => {
        const scrollW = document.documentElement.scrollWidth;
        const clientW = document.documentElement.clientWidth;
        const header = document.querySelector('.shell-header');
        const nav = document.querySelector('#nav');
        const rail = document.querySelector('#rail');
        const tabbar = document.querySelector('#tabbar');
        const main = document.querySelector('#main');
        return {
          scrollW, clientW,
          overflow: scrollW > clientW + 2,
          headerH: header ? header.offsetHeight : 0,
          navVisible: nav ? getComputedStyle(nav).display !== 'none' : false,
          railVisible: rail ? getComputedStyle(rail).display !== 'none' : false,
          tabbarVisible: tabbar ? getComputedStyle(tabbar).display !== 'none' : false,
          mainChars: main ? main.innerText.length : 0,
          bodyBg: getComputedStyle(document.body).backgroundColor,
        };
      }, vp.w);

      const ok = !layout.overflow && layout.mainChars > 10;
      console.log(`  ${ok ? '✓' : '✗'} ${route}  mainChars=${layout.mainChars}  nav=${layout.navVisible?'Y':'N'} rail=${layout.railVisible?'Y':'N'} tab=${layout.tabbarVisible?'Y':'N'} ${layout.overflow?'OVERFLOW!':''}`);

      record({ viewport: vp.name, w: vp.w, route, ...layout, ok });
    }

    await ctx.close();
  }

  await browser.close();

  const failed = results.filter(r => !r.ok);
  const overflowed = results.filter(r => r.overflow);
  const pass = results.length - failed.length;
  console.log(`\n=== RESPONSIVE SUMMARY === pass=${pass}/${results.length}  overflow=${overflowed.length}`);
  if (failed.length > 0) {
    console.log('Failures:');
    failed.forEach(f => console.log(`  - ${f.viewport} ${f.route}: mainChars=${f.mainChars} overflow=${f.overflow}`));
  }
  fs.writeFileSync(path.join(OUT, '../responsive_results.json'), JSON.stringify({ version: health.version, results }, null, 2));
  if (failed.length > 0) process.exit(1);
})();
