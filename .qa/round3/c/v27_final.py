"""
R3-C v0.5.27 final verification — uses /api/state polls to track progress authoritatively.
Click purely via UI; verify picks via server state.
"""
import asyncio
import time
import pathlib
from datetime import datetime
from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda1234567.com"
OUT = pathlib.Path(r"D:\claude\fantasy nba\.qa\round3\c")
LEAGUE_ID = f"r3v27f-{int(time.time())%100000}"
LOG = OUT / "v27_final.log"
REPORT = OUT / "player-v27-final.md"

_lines = []


def log(msg):
    line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    _lines.append(line)
    LOG.write_text("\n".join(_lines), encoding="utf-8")


async def get_state(page):
    return await page.evaluate(f"fetch('{BASE}/api/state',{{credentials:'same-origin'}}).then(r=>r.json())")


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = {"version": None, "picks": []}

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()

        await page.goto(BASE, wait_until="networkidle")
        v = await page.locator("#app-version").inner_text()
        results["version"] = v
        log(f"version: {v}")

        # Create + setup
        await page.locator("#btn-league-switch").click()
        await page.wait_for_timeout(300)
        await page.locator("#btn-lsw-new").click()
        await page.wait_for_timeout(400)
        await page.locator("#new-league-id").fill(LEAGUE_ID)
        await page.locator("#btn-new-league-create").click()
        await page.wait_for_load_state("networkidle", timeout=20000)
        await page.goto(f"{BASE}/#setup", wait_until="networkidle")
        await page.locator("#btn-setup-submit").wait_for(state="visible", timeout=15000)
        await page.locator("#btn-setup-submit").click()
        await page.locator("#tbl-available").wait_for(state="visible", timeout=30000)
        log(f"league={LEAGUE_ID} setup done")

        for i in range(1, 6):
            # Wait for human turn via server state (not UI text — authoritative)
            deadline = time.time() + 60
            while time.time() < deadline:
                d = await get_state(page)
                if d.get("is_complete"):
                    log(f"pick#{i}: draft complete")
                    break
                if d.get("current_team_id") == d.get("human_team_id"):
                    break
                await page.wait_for_timeout(500)
            else:
                log(f"pick#{i}: TIMEOUT waiting human turn")
                results["picks"].append({"n": i, "success": False, "reason": "timeout human turn"})
                continue

            if d.get("is_complete"):
                break

            # Click first available draft button
            btn = page.locator("#tbl-available button[data-draft]:not([disabled])").first
            await btn.wait_for(state="visible", timeout=8000)
            pid = int(await btn.get_attribute("data-draft"))
            t0 = time.time()
            await btn.click()

            # Verify server-side: picks array contains our pid AND team_id == human
            deadline2 = time.time() + 10
            success = False
            while time.time() < deadline2:
                await page.wait_for_timeout(300)
                d2 = await get_state(page)
                hid = d2.get("human_team_id")
                for pick_obj in (d2.get("picks") or []):
                    if pick_obj.get("player_id") == pid and pick_obj.get("team_id") == hid:
                        success = True
                        break
                if success:
                    break
            elapsed = int((time.time() - t0) * 1000)
            log(f"pick#{i}: pid={pid} success={success} elapsed={elapsed}ms")
            results["picks"].append({"n": i, "success": success, "pid": pid, "elapsed_ms": elapsed})

        await browser.close()

    passed = sum(1 for p in results["picks"] if p.get("success"))
    total = len(results["picks"])
    rows = "\n".join(
        f"| {p['n']} | {p.get('pid','-')} | {'PASS' if p.get('success') else 'FAIL'} | {p.get('elapsed_ms','-')} | {p.get('reason','')} |"
        for p in results["picks"]
    )
    report = f"""# R3-C v0.5.27 Final Verification

Version: {results['version']}
League: {LEAGUE_ID}
One-click success: {passed}/{total}

| pick | pid | result | elapsed(ms) | note |
|------|-----|--------|-------------|------|
{rows}

Verdict: {'PASS' if passed == 5 else 'FAIL'}
"""
    REPORT.write_text(report, encoding="utf-8")
    log(f"report: {REPORT}")


if __name__ == "__main__":
    asyncio.run(main())
