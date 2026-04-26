import { chromium } from 'playwright';
const BASE = 'https://nbafantasy.cda1234567.com';
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/v2#/home`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => {
    const app = document.querySelector('.app');
    const main = document.querySelector('#main');
    const header = document.querySelector('.shell-header');
    const nav = document.querySelector('#nav');
    const tabbar = document.querySelector('#tabbar');
    const leagueSwitch = document.querySelector('.league-switch');
    const gc = (el) => el ? getComputedStyle(el) : null;
    return {
      appCols: gc(app)?.gridTemplateColumns,
      appRows: gc(app)?.gridTemplateRows,
      appAreas: gc(app)?.gridTemplateAreas,
      mainW: main?.offsetWidth,
      mainL: main?.getBoundingClientRect().left,
      mainR: main?.getBoundingClientRect().right,
      headerW: header?.offsetWidth,
      navDisplay: gc(nav)?.display,
      tabbarDisplay: gc(tabbar)?.display,
      leagueDisplay: gc(leagueSwitch)?.display,
      bodyW: document.body.offsetWidth,
      docCW: document.documentElement.clientWidth,
      viewportW: window.innerWidth,
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();
