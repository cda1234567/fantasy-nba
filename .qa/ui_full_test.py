"""Full UI test for Fantasy NBA v2 — runs against Oracle"""
import asyncio, json, sys
from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda1234567.com"
V2 = f"{BASE}/v2"

ROUTES = ['home', 'matchup', 'roster', 'trade', 'standings', 'fa', 'schedule', 'news']

async def run():
    results = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(extra_http_headers={"User-Agent": "Mozilla/5.0 Chrome/120"})
        page = await ctx.new_page()

        js_errors = []
        page.on("console", lambda m: js_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: js_errors.append(str(e)))

        def ok(label):
            results.append(f"  OK  {label}")
        def fail(label):
            results.append(f"  FAIL {label}")

        # --- Load v2 home ---
        await page.goto(f"{V2}#/home", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(3000)  # let refreshData() settle

        title = await page.title()
        ok(f"Page loads: {title}") if "Fantasy" in title else fail(f"Bad title: {title}")

        # --- Check each route renders non-empty ---
        for route in ROUTES:
            await page.goto(f"{V2}#{route}", wait_until="networkidle", timeout=30000)
            await page.wait_for_timeout(1500)
            html = await page.inner_html("#main")
            if len(html.strip()) < 100:
                fail(f"Route /{route} renders empty")
            else:
                ok(f"Route /{route} has content ({len(html)} chars)")

        # --- Notifications button ---
        await page.goto(f"{V2}#/home", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2000)
        notif = await page.query_selector("#notifications-btn")
        if notif:
            await notif.click()
            await page.wait_for_timeout(800)
            open_ = await page.evaluate("() => document.getElementById('modal-bd')?.classList.contains('open')")
            ok("Notifications modal opens") if open_ else fail("Notifications modal doesn't open")
            close = await page.query_selector("#modal-close-btn")
            if close: await close.click()
        else:
            fail("notifications-btn not found")

        # --- Settings button ---
        settings = await page.query_selector("#settings-btn")
        if settings:
            await settings.click()
            await page.wait_for_timeout(800)
            open_ = await page.evaluate("() => document.getElementById('modal-bd')?.classList.contains('open')")
            ok("Settings modal opens") if open_ else fail("Settings modal doesn't open")
            close = await page.query_selector("#modal-close-btn")
            if close: await close.click()
        else:
            fail("settings-btn not found")

        # --- Matchup: advance-day button ---
        await page.goto(f"{V2}#/matchup", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2000)
        adv = await page.query_selector("#adv-day")
        if adv:
            ok("advance-day button present")
            await adv.click()
            await page.wait_for_timeout(2500)
            toast = await page.query_selector(".toast")
            ok("toast after advance-day") if toast else fail("no toast after advance-day")
        else:
            fail("advance-day button missing")

        # --- Roster: sortable table ---
        await page.goto(f"{V2}#/roster", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2000)
        sort_th = await page.query_selector("th[data-sort]")
        ok("Roster has sortable columns") if sort_th else fail("No sortable columns in roster")

        # --- FA: claim button ---
        await page.goto(f"{V2}#/fa", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2000)
        claim_btn = await page.query_selector("[data-fa-claim]")
        ok("FA claim button with data-attr") if claim_btn else fail("FA claim button missing data-fa-claim")

        # --- Trade: accept/reject buttons ---
        await page.goto(f"{V2}#/trade", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2000)
        trade_html = await page.inner_html("#main")
        has_accept = "data-trade-accept" in trade_html
        ok("Trade accept button has data-attr") if has_accept else fail("Trade accept button missing attr (may be no pending trades)")

        # --- Standings: correct league name ---
        await page.goto(f"{V2}#/standings", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2000)
        standings_html = await page.inner_html("#main")
        has_hardcode = "絕地爆米花盃" in standings_html
        fail("Standings still has hardcoded 絕地爆米花盃") if has_hardcode else ok("Standings league name is dynamic")

        # --- JS errors ---
        if js_errors:
            fail(f"JS console errors: {len(js_errors)}")
            for e in js_errors[:5]:
                results.append(f"       {e[:120]}")
        else:
            ok("No JS console errors")

        await browser.close()

    print("\n=== UI TEST RESULTS ===")
    for r in results:
        print(r)
    fails = [r for r in results if "FAIL" in r]
    print(f"\n{'ALL PASSED' if not fails else str(len(fails)) + ' FAILURES'} / {len(results)} checks")
    return fails

if __name__ == "__main__":
    fails = asyncio.run(run())
    sys.exit(1 if fails else 0)
