import asyncio
import sys
import io
from playwright.async_api import async_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

BASE = "https://nbafantasy.cda.tw"


async def test():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()

        errors = []
        console_logs = []

        def on_console(msg):
            text = f"CONSOLE {msg.type}: {msg.text}"
            console_logs.append(text)
            if msg.type == "error":
                errors.append(text)

        page.on("console", on_console)
        page.on("pageerror", lambda exc: errors.append(f"PAGEERROR: {exc}"))

        # Home page
        await page.goto(f"{BASE}/v2#/home", wait_until="networkidle")
        await page.wait_for_timeout(2500)
        title = await page.title()
        print(f"Title: {title}")

        league_name = await page.evaluate(
            "() => document.querySelector('.brand-name, #header-league-name, .league-name')?.textContent"
        )
        print(f"League name area: {league_name!r}")

        # Each route
        for route in ["home", "matchup", "roster", "trade", "standings", "fa", "schedule"]:
            await page.goto(f"{BASE}/v2#/{route}", wait_until="networkidle")
            await page.wait_for_timeout(1500)
            main_html = await page.inner_html("#main")
            empty = len(main_html.strip()) < 50
            print(f"Route /{route}: {'EMPTY' if empty else 'OK'} ({len(main_html)} chars)")
            if empty:
                errors.append(f"Route {route} renders empty")

        # Notifications
        await page.goto(f"{BASE}/v2#/home", wait_until="networkidle")
        await page.wait_for_timeout(1500)
        notif_btn = await page.query_selector("#notifications-btn")
        if notif_btn:
            await notif_btn.click()
            await page.wait_for_timeout(600)
            modal_open = await page.evaluate(
                "() => document.getElementById('modal-bd')?.classList.contains('open')"
            )
            print(f"Notifications modal opens: {modal_open}")
            if not modal_open:
                errors.append("Notifications button doesn't open modal")
            close = await page.query_selector("#modal-close-btn")
            if close:
                await close.click()
                await page.wait_for_timeout(300)
        else:
            errors.append("#notifications-btn missing")

        # Settings
        settings_btn = await page.query_selector("#settings-btn")
        if settings_btn:
            await settings_btn.click()
            await page.wait_for_timeout(600)
            modal_open = await page.evaluate(
                "() => document.getElementById('modal-bd')?.classList.contains('open')"
            )
            print(f"Settings modal opens: {modal_open}")
            if not modal_open:
                errors.append("Settings button doesn't open modal")
            close = await page.query_selector("#modal-close-btn")
            if close:
                await close.click()
                await page.wait_for_timeout(300)
        else:
            errors.append("#settings-btn missing")

        # Advance day
        await page.goto(f"{BASE}/v2#/matchup", wait_until="networkidle")
        await page.wait_for_timeout(1500)
        adv_day = await page.query_selector("#adv-day")
        print(f"Advance day button present: {adv_day is not None}")
        if adv_day:
            await adv_day.click()
            await page.wait_for_timeout(2500)
            toast = await page.query_selector(".toast")
            print(f"Toast appeared after advance: {toast is not None}")

        # Final error report
        if errors:
            print(f"\n=== ERRORS ({len(errors)}) ===")
            for e in errors:
                print(f"  - {e}")
        else:
            print("\n=== ALL TESTS PASSED ===")

        # Also print most recent console logs for diagnostics
        if console_logs:
            print(f"\n=== CONSOLE LOG (last 30) ===")
            for l in console_logs[-30:]:
                print(f"  {l}")

        await browser.close()


asyncio.run(test())
