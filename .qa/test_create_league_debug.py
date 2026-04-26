"""Debug: capture exact error when creating new league"""
import asyncio
from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda1234567.com"
V2 = f"{BASE}/v2"

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, slow_mo=500)
        ctx = await browser.new_context(
            extra_http_headers={"User-Agent": "Mozilla/5.0 Chrome/120"},
            viewport={"width": 1440, "height": 900},
        )
        page = await ctx.new_page()

        network_errors = []
        api_responses = []

        async def on_response(resp):
            if '/api/' in resp.url:
                try:
                    body = await resp.text()
                    api_responses.append(f"{resp.status} {resp.url.split('/api/')[-1]}: {body[:200]}")
                except:
                    pass

        page.on("response", on_response)
        page.on("pageerror", lambda e: network_errors.append(str(e)))

        print("1. Loading v2...")
        await page.goto(f"{V2}#/home", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(3000)

        print("2. Opening new league modal...")
        await page.click("#new-league-btn")
        await page.wait_for_timeout(1000)

        print("3. Filling form...")
        await page.fill("#nl-name", "Debug 聯盟")

        print("4. Submitting...")
        api_responses.clear()
        await page.click("#nl-submit")
        await page.wait_for_timeout(5000)

        print("\n=== API responses during submit ===")
        for r in api_responses:
            print(r)

        # Check for toast error
        toasts = await page.query_selector_all(".toast")
        for t in toasts:
            text = await t.inner_text()
            print(f"Toast: {text}")

        current_hash = await page.evaluate("() => location.hash")
        print(f"Route: {current_hash}")

        if network_errors:
            print(f"JS errors: {network_errors}")

        print("\nWaiting 8s so you can see...")
        await page.wait_for_timeout(8000)
        await browser.close()

asyncio.run(run())
