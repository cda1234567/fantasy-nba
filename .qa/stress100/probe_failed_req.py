"""Open the site once and print every failedRequest URL + failure reason."""
import asyncio
from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda1234567.com"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()

        failed = []
        page.on("requestfailed", lambda r: failed.append((r.method, r.url, r.failure)))
        page.on("response", lambda r: print(f"RESP {r.status} {r.url}") if r.status >= 400 else None)

        await page.goto(BASE, wait_until="networkidle", timeout=30000)
        await asyncio.sleep(2)

        print("\n=== FAILED REQUESTS ===")
        for m, u, f in failed:
            print(f"{m} {u}  -> {f}")
        if not failed:
            print("(none)")

        await b.close()


asyncio.run(main())
