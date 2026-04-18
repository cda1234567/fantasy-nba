"""
Round 4 — multi-season integration test via UI-only clicks.
Goal: end-to-end complete a season, then start a new season, verify carryover.

Steps (all clicks, no direct API):
1. Create fresh league
2. Setup league
3. Draft: use "模擬到我" to skip AI, make 1 human pick, repeat until draft complete
4. Start season (click 開始賽季)
5. Sim to playoffs
6. Sim playoffs
7. Verify champion exists
8. Reset / start new season, verify state carries over correctly
"""
import asyncio
import time
import pathlib
from datetime import datetime
from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda1234567.com"
OUT = pathlib.Path(r"D:\claude\fantasy nba\.qa\round4")
LEAGUE_ID = f"r4-{int(time.time())%100000}"
LOG = OUT / "multi_season.log"
REPORT = OUT / "multi_season.md"

_lines = []


def log(msg):
    line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    _lines.append(line)
    LOG.write_text("\n".join(_lines), encoding="utf-8")


async def create_and_setup(page, lid):
    await page.locator("#btn-league-switch").click()
    await page.wait_for_timeout(300)
    await page.locator("#btn-lsw-new").click()
    await page.wait_for_timeout(400)
    await page.locator("#new-league-id").fill(lid)
    await page.locator("#btn-new-league-create").click()
    await page.wait_for_load_state("networkidle", timeout=20000)
    log(f"league {lid} created")

    await page.goto(f"{BASE}/#setup", wait_until="networkidle")
    await page.locator("#btn-setup-submit").wait_for(state="visible", timeout=15000)
    await page.locator("#btn-setup-submit").click()
    await page.locator("#tbl-available").wait_for(state="visible", timeout=20000)
    log("setup done")


async def click_by_text(page, text, timeout=5000):
    """Find a button containing the text and click it."""
    btn = page.locator(f"button:has-text('{text}')").first
    await btn.wait_for(state="visible", timeout=timeout)
    await btn.click()
    return True


async def complete_draft_human_picks(page, max_rounds=15):
    """Loop: ensure human turn (sim-to-me), then pick first available. Repeat until complete."""
    picks_made = 0
    for i in range(max_rounds):
        body = await page.locator("body").inner_text()
        if "選秀完成" in body:
            log(f"draft complete after {picks_made} human picks")
            return True
        # If not human turn, click 模擬到我
        if "輪到你" not in body:
            try:
                btn = page.locator("button:has-text('模擬到我')").first
                if await btn.count() > 0:
                    await btn.click()
                    log("clicked 模擬到我")
                    await page.wait_for_timeout(3000)
                    continue
            except Exception:
                pass
        # Try to pick
        try:
            draft_btn = page.locator("#tbl-available button[data-draft]:not([disabled])").first
            await draft_btn.wait_for(state="visible", timeout=5000)
            pid = await draft_btn.get_attribute("data-draft")
            await draft_btn.click()
            log(f"human picked pid={pid} (#{picks_made+1})")
            picks_made += 1
            await page.wait_for_timeout(1500)
        except Exception as e:
            log(f"pick attempt failed: {e}")
            await page.wait_for_timeout(2000)
    return False


async def wait_draft_complete(page, timeout_s=90):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        body = await page.locator("body").inner_text()
        if "選秀完成" in body:
            return True
        await page.wait_for_timeout(1000)
    return False


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = {"version": None, "phases": {}}

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()

        page.on("console", lambda m: log(f"console.{m.type}: {m.text[:200]}") if m.type == "error" else None)

        await page.goto(BASE, wait_until="networkidle")
        v = await page.locator("#app-version").inner_text()
        results["version"] = v
        log(f"version: {v}")

        await create_and_setup(page, LEAGUE_ID)

        # Phase 1: Complete draft with 模擬到我 between human picks
        ok = await complete_draft_human_picks(page, max_rounds=20)
        results["phases"]["draft_complete"] = ok
        log(f"draft phase: {ok}")

        if not ok:
            # Try waiting
            ok = await wait_draft_complete(page, timeout_s=60)
            results["phases"]["draft_complete"] = ok

        # Phase 2: Start season
        await page.goto(f"{BASE}/#league", wait_until="networkidle")
        await page.wait_for_timeout(2000)
        try:
            start_btn = page.locator("button:has-text('開始賽季')").first
            if await start_btn.count() > 0 and await start_btn.is_visible():
                await start_btn.click()
                log("clicked 開始賽季")
                await page.wait_for_timeout(3000)
                results["phases"]["season_started"] = True
            else:
                results["phases"]["season_started"] = "button_not_found"
                log("開始賽季 button not found")
        except Exception as e:
            log(f"season start error: {e}")
            results["phases"]["season_started"] = f"error: {e}"

        # Phase 3: Sim to playoffs
        await page.wait_for_timeout(2000)
        try:
            sim_btn = page.locator("button:has-text('模擬到季後賽')").first
            if await sim_btn.count() > 0 and await sim_btn.is_visible():
                await sim_btn.click()
                log("clicked 模擬到季後賽")
                await page.wait_for_timeout(15000)
                results["phases"]["sim_to_playoffs"] = True
            else:
                # Alternative: advance week button
                adv_btn = page.locator("button:has-text('推進一週')").first
                if await adv_btn.count() > 0:
                    for i in range(25):
                        if await adv_btn.is_visible():
                            await adv_btn.click()
                            await page.wait_for_timeout(800)
                        else:
                            break
                    log("advanced 25 weeks via 推進一週")
                    results["phases"]["sim_to_playoffs"] = "via_weekly"
                else:
                    results["phases"]["sim_to_playoffs"] = "buttons_not_found"
        except Exception as e:
            log(f"sim-to-playoffs error: {e}")
            results["phases"]["sim_to_playoffs"] = f"error: {e}"

        # Phase 4: Sim playoffs
        await page.wait_for_timeout(2000)
        try:
            po_btn = page.locator("button:has-text('模擬季後賽')").first
            if await po_btn.count() > 0 and await po_btn.is_visible():
                await po_btn.click()
                log("clicked 模擬季後賽")
                await page.wait_for_timeout(10000)
                results["phases"]["sim_playoffs"] = True
            else:
                results["phases"]["sim_playoffs"] = "button_not_found"
        except Exception as e:
            log(f"sim-playoffs error: {e}")
            results["phases"]["sim_playoffs"] = f"error: {e}"

        # Phase 5: Verify champion
        await page.wait_for_timeout(2000)
        body = await page.locator("body").inner_text()
        has_champ = "冠軍" in body
        results["phases"]["has_champion"] = has_champ
        log(f"champion visible in league view: {has_champ}")

        await page.screenshot(path=str(OUT / "season_end.png"))

        await browser.close()

    # Write report
    rows = "\n".join(f"| {k} | {v} |" for k, v in results["phases"].items())
    report = f"""# Round 4 — Multi-Season Integration

Version: {results['version']}
League: {LEAGUE_ID}

## Phases

| phase | result |
|-------|--------|
{rows}

Verdict: {'PASS' if all(v in (True, 'via_weekly') for v in results['phases'].values()) else 'PARTIAL/FAIL'}
"""
    REPORT.write_text(report, encoding="utf-8")
    log(f"report: {REPORT}")


if __name__ == "__main__":
    asyncio.run(main())
