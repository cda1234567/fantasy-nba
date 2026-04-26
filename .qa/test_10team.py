"""Test 10-team league creation with season dropdown"""
import asyncio
from playwright.async_api import async_playwright

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, slow_mo=400)
        page = await browser.new_page(viewport={'width': 1440, 'height': 900})
        await page.goto('https://nbafantasy.cda1234567.com/v2#/home', wait_until='networkidle', timeout=30000)
        await page.wait_for_timeout(2000)
        await page.click('#new-league-btn')
        await page.wait_for_timeout(800)

        # Check season dropdown
        opts = await page.evaluate("""() => {
          const sel = document.querySelector('#nl-season-sel');
          if (!sel) return ['NOT FOUND'];
          const all = Array.from(sel.options).map(o => o.value);
          return all.slice(0,4).concat(['...']).concat(all.slice(-3));
        }""")
        print('Season options (first4+last3):', opts)

        # Select 10 teams
        await page.click('#nl-teams-seg button[data-val="10"]')
        await page.wait_for_timeout(300)

        # Select 1996-97 season
        await page.select_option('#nl-season-sel', '1996-97')
        await page.wait_for_timeout(300)

        sel_val = await page.evaluate("() => document.querySelector('#nl-season-sel').value")
        teams_sel = await page.evaluate("() => document.querySelector('#nl-teams-seg [aria-pressed=\"true\"]')?.dataset?.val")
        print(f'Selected season: {sel_val}, teams: {teams_sel}')

        # Fill name and submit
        api_resp = []
        async def on_resp(r):
            if '/api/' in r.url:
                try:
                    body = await r.text()
                    api_resp.append(f'{r.status} {r.url.split("/api/")[-1]}: {body[:150]}')
                except:
                    pass
        page.on('response', on_resp)

        await page.fill('#nl-name', 'Test 10隊 1996-97')
        await page.click('#nl-submit')
        await page.wait_for_timeout(5000)

        print('\nAPI responses:')
        for r in api_resp:
            print(' ', r)
        h = await page.evaluate('() => location.hash')
        print('Route:', h)

        await page.wait_for_timeout(4000)
        await browser.close()

asyncio.run(run())
