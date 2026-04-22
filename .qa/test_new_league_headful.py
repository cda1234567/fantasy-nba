"""Headful Playwright test: create new league from header button + draft flow"""
import asyncio, json
from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda1234567.com"
V2 = f"{BASE}/v2"

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, slow_mo=400)
        ctx = await browser.new_context(
            extra_http_headers={"User-Agent": "Mozilla/5.0 Chrome/120"},
            viewport={"width": 1440, "height": 900},
        )
        page = await ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        print("=== 1. Load v2 home ===")
        await page.goto(f"{V2}#/home", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2500)

        print("=== 2. Click header + new-league-btn ===")
        btn = await page.query_selector("#new-league-btn")
        if not btn:
            print("FAIL: #new-league-btn not found in header")
            await browser.close()
            return
        await btn.click()
        await page.wait_for_timeout(800)

        modal_open = await page.evaluate("() => document.getElementById('modal-bd')?.classList.contains('open')")
        print(f"Modal open: {modal_open}")

        print("=== 3. Fill league name ===")
        await page.fill("#nl-name", "Playwright 測試聯盟")
        await page.wait_for_timeout(300)

        print("=== 4. Select season 2024-25 (default) ===")
        # Already defaulted, just verify
        season_val = await page.evaluate("() => document.querySelector('#nl-season-seg [aria-pressed=\"true\"]')?.dataset.val")
        print(f"Season: {season_val}")

        print("=== 5. Select 隨機 draft order ===")
        await page.click("#nl-draft-order-seg button[data-val='true']")
        await page.wait_for_timeout(300)

        print("=== 6. Submit new league ===")
        await page.click("#nl-submit")
        await page.wait_for_timeout(5000)

        # Should be on draft page now
        current_hash = await page.evaluate("() => location.hash")
        print(f"Current route after submit: {current_hash}")

        print("=== 7. Check draft view ===")
        main_html = await page.inner_html("#main")
        print(f"Draft view length: {len(main_html)}")
        has_draft = "選秀" in main_html or "draft" in main_html.lower() or "順位" in main_html
        print(f"Draft content present: {has_draft}")

        if errors:
            print(f"\nJS errors: {errors}")
        else:
            print("\nNo JS errors")

        print("\n=== Done. Keeping browser open 5s for you to see ===")
        await page.wait_for_timeout(5000)
        await browser.close()

asyncio.run(run())
