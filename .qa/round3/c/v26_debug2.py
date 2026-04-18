"""
Better debug: poll /api/state directly after human pick to see draft state transitions.
"""
import asyncio
import json
import time
import pathlib
from datetime import datetime
from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda1234567.com"
OUT = pathlib.Path(r"D:\claude\fantasy nba\.qa\round3\c")
LEAGUE_ID = f"r3cv26x-{int(time.time())%100000}"
LOG = OUT / "v26_debug2.log"

_lines = []


def log(msg):
    line = f"[{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] {msg}"
    print(line, flush=True)
    _lines.append(line)
    LOG.write_text("\n".join(_lines), encoding="utf-8")


async def fetch_state(page):
    return await page.evaluate(f"""fetch('{BASE}/api/state', {{credentials:'same-origin'}}).then(r=>r.json())""")


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()

        page.on("request", lambda r: log(f"REQ {r.method} {r.url.split('?')[0]}") if "/api/draft/" in r.url else None)
        page.on("response", lambda r: log(f"RSP {r.status} {r.url.split('?')[0]}") if "/api/draft/" in r.url else None)

        await page.goto(BASE, wait_until="networkidle")

        # Create league
        await page.locator("#btn-league-switch").click()
        await page.wait_for_timeout(300)
        await page.locator("#btn-lsw-new").click()
        await page.wait_for_timeout(400)
        await page.locator("#new-league-id").fill(LEAGUE_ID)
        await page.locator("#btn-new-league-create").click()
        await page.wait_for_load_state("networkidle", timeout=20000)
        log(f"league {LEAGUE_ID} created")

        # Setup
        await page.goto(f"{BASE}/#setup", wait_until="networkidle")
        await page.locator("#btn-setup-submit").click()
        await page.locator("#tbl-available").wait_for(state="visible", timeout=20000)
        log("setup done, draft view visible")

        # Check initial state
        d = await fetch_state(page)
        log(f"initial draft: current={d.get('current_team_id')} human={d.get('human_team_id')} picks={len(d.get('picks') or [])} rnd={d.get('current_round')} pos={d.get('current_pick_in_round')}")

        # Is it human's turn?
        if d.get("current_team_id") == d.get("human_team_id"):
            log("HUMAN TURN confirmed - clicking draft")
        else:
            # Wait for auto-advance
            log("AI turn first - waiting for human turn via auto-advance")
            for i in range(30):
                await page.wait_for_timeout(1000)
                d = await fetch_state(page)
                log(f"poll#{i}: current={d.get('current_team_id')} human={d.get('human_team_id')} picks={len(d.get('picks') or [])}")
                if d.get("current_team_id") == d.get("human_team_id"):
                    log("HUMAN TURN reached")
                    break

        # Make a human pick
        btn = page.locator("#tbl-available button[data-draft]:not([disabled])").first
        await btn.wait_for(state="visible", timeout=8000)
        pid = await btn.get_attribute("data-draft")
        log(f"clicking human draft pid={pid}")
        await btn.click()

        # Poll state every 500ms for 30s to see evolution
        for i in range(60):
            await page.wait_for_timeout(500)
            try:
                d = await fetch_state(page)
                picks_count = len(d.get("picks") or [])
                log(f"poll-{i*0.5}s: current={d.get('current_team_id')} human={d.get('human_team_id')} picks={picks_count} complete={d.get('is_complete')} rnd={d.get('current_round')}/{d.get('current_pick_in_round')}")
                if d.get("current_team_id") == d.get("human_team_id") and not d.get("is_complete"):
                    log("HUMAN TURN RETURNED after AI cycle")
                    break
            except Exception as e:
                log(f"poll error: {e}")

        # Also check state.draftAutoBusy and draftAutoTimer
        inflight = await page.evaluate("""
(() => {
  // Find state by walking for variable — we can't access module-scoped const directly.
  // But we can monkey-patch scheduleDraftAutoAdvance to expose info
  return 'cannot read module-scoped state';
})()
""")
        log(f"inflight check: {inflight}")

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
