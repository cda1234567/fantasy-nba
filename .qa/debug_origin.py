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
        requests = []
        page.on("request", lambda r: requests.append(f"{r.method} {r.url}"))

        errors = []
        page.on("console", lambda m: errors.append(f"{m.type}: {m.text}"))
        page.on("pageerror", lambda e: errors.append(f"PAGEERROR: {e}"))

        await page.goto(f"{BASE}/v2#/matchup", wait_until="networkidle")
        await page.wait_for_timeout(2500)

        origin = await page.evaluate("() => location.origin + ' | href=' + location.href")
        print(f"Origin: {origin}")
        adv = await page.query_selector("#adv-day")
        if adv:
            await adv.click()
            await page.wait_for_timeout(2500)

        print("=== REQUESTS ===")
        for r in requests[-30:]:
            print(r)
        print("=== ERRORS ===")
        for e in errors[-15:]:
            print(e)

        await browser.close()


asyncio.run(main())
