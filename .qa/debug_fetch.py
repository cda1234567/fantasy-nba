import asyncio
import sys
import io
from playwright.async_api import async_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

BASE = "https://nbafantasy.cda.tw"


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        errors = []
        page.on("console", lambda m: errors.append(f"{m.type}: {m.text}"))
        page.on("pageerror", lambda e: errors.append(f"PAGEERROR: {e}"))
        page.on("request", lambda r: errors.append(f"REQ: {r.method} {r.url}"))

        # Intercept fetch to trace caller
        await page.add_init_script("""
          const origFetch = window.fetch;
          window.fetch = function(...args) {
            console.log('FETCH called with: ' + JSON.stringify(args[0]) + ' stack=' + new Error().stack.split('\\n').slice(1,4).join(' | '));
            return origFetch.apply(this, args);
          };
        """)

        await page.goto(f"{BASE}/v2#/matchup", wait_until="networkidle")
        await page.wait_for_timeout(3000)
        adv = await page.query_selector("#adv-day")
        if adv:
            await adv.click()
            await page.wait_for_timeout(3000)

        for e in errors[-40:]:
            print(e)

        await browser.close()


asyncio.run(main())
