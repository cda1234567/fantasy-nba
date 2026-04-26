"""Debug why #nl-season-sel is not found"""
import asyncio
from playwright.async_api import async_playwright

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, slow_mo=300)
        ctx = await browser.new_context(
            extra_http_headers={"User-Agent": "Mozilla/5.0 Chrome/120"},
            viewport={'width': 1440, 'height': 900}
        )
        page = await ctx.new_page()

        js_errors = []
        page.on('pageerror', lambda e: js_errors.append(str(e)))

        await page.goto('https://nbafantasy.cda1234567.com/v2#/home', wait_until='networkidle', timeout=30000)
        await page.wait_for_timeout(3000)

        await page.click('#new-league-btn')
        await page.wait_for_timeout(1500)

        info = await page.evaluate("""() => {
          const bd = document.getElementById('modal-bd');
          const card = document.getElementById('modal-card');
          const sel = document.getElementById('nl-season-sel');
          return {
            bd_open: bd?.classList.contains('open'),
            card_len: card?.innerHTML?.length,
            card_preview: card?.innerHTML?.slice(0, 200),
            has_sel: !!sel,
            has_submit: !!document.getElementById('nl-submit'),
          };
        }""")
        print('Modal info:', info)

        if js_errors:
            print('JS errors:', js_errors)

        await page.wait_for_timeout(5000)
        await browser.close()

asyncio.run(run())
