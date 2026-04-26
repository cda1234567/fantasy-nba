"""
Full UI mouse-only smoke test — completes entire draft then tests all views.
No direct API calls. Everything via mouse clicks only.
"""
import asyncio
from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda.tw/v2"

def log(msg):
    print(msg, flush=True)

async def safe_click(page, selector, label, timeout=8000):
    try:
        el = page.locator(selector).first
        await el.wait_for(state="visible", timeout=timeout)
        await el.click()
        log(f"  OK {label}")
        await page.wait_for_timeout(300)
        return True
    except Exception as e:
        log(f"  FAIL {label} -- {str(e)[:100]}")
        return False

async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, slow_mo=100)
        ctx = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            extra_http_headers={"User-Agent": "Mozilla/5.0 Chrome/120"},
        )
        page = await ctx.new_page()
        js_errors = []
        page.on("pageerror", lambda e: js_errors.append(str(e)))

        # ================================================================
        log("=== STEP 1: Load home, check version ===")
        await page.goto(f"{BASE}#/home", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2000)
        try:
            ver = await page.locator(".brand-name .sub").first.inner_text(timeout=3000)
            log(f"  Version: {ver}")
        except:
            log("  Version: not found")

        # ================================================================
        log("\n=== STEP 2: Header buttons (modal open/close) ===")
        await safe_click(page, "#notifications-btn", "notifications btn")
        await page.wait_for_timeout(500)
        try:
            open1 = await page.locator("#modal-bd").evaluate("el => el.classList.contains('open')")
            log(f"  Notifications modal open: {open1}")
        except:
            log("  Notifications modal: check failed")
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(400)
        try:
            closed = not await page.locator("#modal-bd").evaluate("el => el.classList.contains('open')")
            log(f"  ESC closed modal: {closed}")
        except:
            log("  ESC close check: failed")

        await safe_click(page, "#settings-btn", "settings btn")
        await page.wait_for_timeout(500)
        # Close by clicking backdrop
        try:
            await page.locator("#modal-bd").click(position={"x": 10, "y": 10})
            await page.wait_for_timeout(400)
            closed2 = not await page.locator("#modal-bd").evaluate("el => el.classList.contains('open')")
            log(f"  Click-outside closed settings modal: {closed2}")
        except Exception as e:
            log(f"  Click-outside check: {e}")

        # ================================================================
        log("\n=== STEP 3: Create new league — historical year 2015-16 ===")
        await safe_click(page, "#new-league-btn", "new-league btn")
        await page.wait_for_timeout(1000)
        try:
            modal_open = await page.locator("#modal-bd").evaluate("el => el.classList.contains('open')")
            log(f"  Modal open: {modal_open}")
        except:
            modal_open = False
            log("  Modal open check failed")

        if modal_open:
            try:
                await page.fill("#nl-name", "歷史測試聯盟2015")
                log("  OK filled league name")
            except Exception as e:
                log(f"  FAIL fill name: {e}")

            try:
                await page.wait_for_selector("#nl-season-sel", timeout=3000)
                await page.select_option("#nl-season-sel", "2015-16")
                val = await page.locator("#nl-season-sel").evaluate("el => el.value")
                log(f"  OK season selected: {val}")
            except Exception as e:
                log(f"  FAIL season: {e}")

            try:
                await page.locator("#nl-teams-seg button").filter(has_text="8").click()
                log("  OK 8 teams selected")
                await page.wait_for_timeout(300)
            except Exception as e:
                log(f"  FAIL team count: {e}")

            await safe_click(page, "#nl-submit", "submit new league", timeout=10000)
            await page.wait_for_timeout(3000)

            url_hash = await page.evaluate("() => location.hash")
            log(f"  After submit hash: {url_hash}")
            if js_errors:
                log(f"  JS errors: {js_errors}")
                js_errors.clear()
        else:
            log("  SKIP: modal not open")

        # ================================================================
        log("\n=== STEP 4: Pre-draft view guards ===")
        for route, label, bad_marker in [
            ("#/roster",   "陣容",  "roster-tbody"),
            ("#/matchup",  "對戰",  "matchup-score"),
        ]:
            await page.goto(f"{BASE}{route}", wait_until="domcontentloaded", timeout=10000)
            await page.wait_for_timeout(800)
            html = await page.locator("#main").inner_html(timeout=3000)
            has_bad = bad_marker in html
            has_placeholder = "選秀尚未完成" in html
            log(f"  {label}: bad_data={has_bad}  placeholder={has_placeholder}  {'OK' if not has_bad and has_placeholder else 'CHECK'}")
            if js_errors:
                log(f"    JS error: {js_errors.pop()}")

        # ================================================================
        log("\n=== STEP 5: Draft — complete entire draft ===")
        await page.goto(f"{BASE}#/draft", wait_until="networkidle", timeout=15000)
        await page.wait_for_timeout(2000)

        # Set to fast speed
        try:
            await page.locator("#draft-speed-seg button").filter(has_text="快").click()
            log("  OK set speed to 快")
            await page.wait_for_timeout(300)
        except Exception as e:
            log(f"  FAIL set speed: {e}")

        pick_count = 0
        max_picks = 13  # 8-team league, human picks 13 rounds

        draft_done = False
        for attempt in range(200):  # up to ~200s total
            await page.wait_for_timeout(1000)

            # Check if draft recap appeared
            try:
                main_text = await page.locator("#main").inner_text(timeout=800)
                if "選秀回顧" in main_text or "你的選秀陣容" in main_text or "已結束" in main_text:
                    log(f"  Draft complete after {pick_count} picks! (attempt {attempt+1})")
                    draft_done = True
                    break
            except:
                pass

            # Try skip button first (jumps all AI picks to next human turn)
            try:
                skip = page.locator("#draft-skip-to-me")
                if await skip.is_visible(timeout=300):
                    await skip.click()
                    log(f"    [a{attempt+1}] skip -> human turn")
                    await page.wait_for_timeout(1500)
                    continue
            except:
                pass

            # Try pick button (human's turn)
            try:
                pick_btn = page.locator("button[data-draft-pick]").first
                if await pick_btn.is_visible(timeout=300):
                    await pick_btn.click()
                    pick_count += 1
                    log(f"    [a{attempt+1}] Pick #{pick_count}")
                    await page.wait_for_timeout(1500)
                    continue
            except:
                pass

        if not draft_done:
            log("  WARN: draft never completed in 200 attempts")

        # ================================================================
        log("\n=== STEP 6: Post-draft views ===")
        views_post = [
            ("#/home",      "首頁",   "#main",          200),
            ("#/roster",    "陣容",   "#roster-tbody",  10),
            ("#/matchup",   "對戰",   "#main",          200),
            ("#/standings", "排名",   "#standings-tbody", 5),
            ("#/trade",     "交易",   "#main",          100),
        ]
        for route, label, sel, min_len in views_post:
            await page.goto(f"{BASE}{route}", wait_until="domcontentloaded", timeout=10000)
            await page.wait_for_timeout(1000)
            try:
                content = await page.locator(sel).inner_html(timeout=3000)
                ok = len(content) >= min_len
                log(f"  {'OK' if ok else 'FAIL'} {label}: {len(content)} chars (min {min_len})")
            except Exception as e:
                log(f"  FAIL {label}: {e}")
            if js_errors:
                log(f"    JS error: {js_errors.pop()}")

        # ================================================================
        log("\n=== STEP 7: Roster sort (all columns) ===")
        await page.goto(f"{BASE}#/roster", wait_until="domcontentloaded", timeout=10000)
        await page.wait_for_timeout(1000)
        for col_key in ["proj", "mpg", "pts", "reb", "ast", "stl", "blk", "to"]:
            try:
                th = page.locator(f"th[data-table='roster'][data-sort='{col_key}']")
                if await th.is_visible(timeout=2000):
                    await th.click()
                    await page.wait_for_timeout(300)
                    log(f"  OK roster sort: {col_key}")
                else:
                    log(f"  FAIL roster sort not found: {col_key}")
            except Exception as e:
                log(f"  FAIL roster sort {col_key}: {e}")

        # ================================================================
        log("\n=== STEP 8: Standings sort ===")
        await page.goto(f"{BASE}#/standings", wait_until="domcontentloaded", timeout=10000)
        await page.wait_for_timeout(1000)
        for col_key in ["r", "w", "pf"]:
            try:
                th = page.locator(f"th[data-table='standings'][data-sort='{col_key}']")
                if await th.is_visible(timeout=2000):
                    await th.click()
                    await page.wait_for_timeout(300)
                    log(f"  OK standings sort: {col_key}")
                else:
                    log(f"  FAIL standings sort: {col_key}")
            except Exception as e:
                log(f"  FAIL standings sort {col_key}: {e}")

        # ================================================================
        log("\n=== STEP 9: Matchup — category Δ column ===")
        await page.goto(f"{BASE}#/matchup", wait_until="domcontentloaded", timeout=10000)
        await page.wait_for_timeout(1000)
        try:
            delta_count = await page.locator("th:has-text('Δ')").count()
            log(f"  Δ column count: {delta_count}  {'OK' if delta_count > 0 else 'FAIL'}")
        except Exception as e:
            log(f"  FAIL Δ column: {e}")

        cat_tables = await page.locator(".standings-table").count()
        log(f"  Tables on matchup view: {cat_tables}")

        if js_errors:
            log(f"  JS errors: {js_errors}")

        # ================================================================
        log("\n=== FINAL SUMMARY ===")
        remaining = js_errors
        if remaining:
            log(f"Uncaught JS errors: {remaining}")
        else:
            log("No uncaught JS errors")

        await page.wait_for_timeout(3000)
        await browser.close()

asyncio.run(run())
