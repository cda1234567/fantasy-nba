"""
R3-C v0.5.26 patient retest — wait long enough for AI cycle to return human turn.
Auto-advance is 1.5s per AI; 7 AIs = 10.5s minimum. Poll up to 30s.
"""
import asyncio
import time
import pathlib
from datetime import datetime
from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda1234567.com"
OUT = pathlib.Path(r"D:\claude\fantasy nba\.qa\round3\c")
LEAGUE_ID = f"r3cv26p-{int(time.time())%100000}"
LOG = OUT / "v26_patient.log"
REPORT = OUT / "player-v26-patient.md"

_logs = []
_api_calls = []


def log(msg):
    line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    _logs.append(line)
    try:
        LOG.write_text("\n".join(_logs), encoding="utf-8")
    except Exception:
        pass


async def create_and_setup(page, lid):
    await page.locator("#btn-league-switch").click()
    await page.wait_for_timeout(300)
    await page.locator("#btn-lsw-new").click()
    await page.wait_for_timeout(400)
    await page.locator("#new-league-id").fill(lid)
    await page.locator("#btn-new-league-create").click()
    await page.wait_for_load_state("networkidle", timeout=20000)
    log(f"created+switched to {lid}")

    await page.goto(f"{BASE}/#setup", wait_until="networkidle")
    await page.locator("#btn-setup-submit").wait_for(state="visible", timeout=15000)
    await page.locator("#btn-setup-submit").click()
    log("setup submitted")
    await page.locator("#tbl-available").wait_for(state="visible", timeout=20000)


async def wait_human_turn(page, timeout_s=45):
    """Poll status/body text until it's human's turn OR draft complete."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        body = await page.locator("body").inner_text()
        if "選秀完成" in body:
            return "complete"
        if "輪到你" in body:
            return "human"
        await page.wait_for_timeout(500)
    return "timeout"


async def pick_once(page, n):
    btn = page.locator("#tbl-available button[data-draft]:not([disabled])").first
    try:
        await btn.wait_for(state="visible", timeout=8000)
    except Exception:
        return {"n": n, "success": False, "reason": "no button visible"}
    pid_before = await btn.get_attribute("data-draft")
    t0 = time.time()
    await btn.click()
    # Wait for state transition: either table shifts OR status changes to AI turn
    for _ in range(40):  # 8s max
        await page.wait_for_timeout(200)
        try:
            # If draft complete
            body = await page.locator("body").inner_text()
            if "選秀完成" in body:
                return {"n": n, "success": True, "elapsed_ms": int((time.time() - t0)*1000), "note": "draft complete"}
            # If the first enabled pid changed, the pick advanced table
            first = page.locator("#tbl-available button[data-draft]:not([disabled])").first
            cnt = await first.count()
            if cnt == 0:
                # All buttons disabled = AI turn or transitioning
                if "輪到你" not in body:
                    return {"n": n, "success": True, "elapsed_ms": int((time.time() - t0)*1000), "note": "AI turn"}
                continue
            pid_after = await first.get_attribute("data-draft")
            if pid_after != pid_before:
                return {"n": n, "success": True, "pid": pid_before, "elapsed_ms": int((time.time() - t0)*1000)}
        except Exception:
            continue
    return {"n": n, "success": False, "elapsed_ms": int((time.time() - t0)*1000), "reason": "no advance"}


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = {"picks": [], "version": None, "ai_advance_calls": 0, "pick_calls": 0}

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()

        def on_request(req):
            u = req.url
            if "/api/draft/ai-advance" in u:
                results["ai_advance_calls"] += 1
                _api_calls.append(("ai-advance", time.time()))
            elif "/api/draft/pick" in u:
                results["pick_calls"] += 1
                _api_calls.append(("pick", time.time()))

        page.on("request", on_request)

        await page.goto(BASE, wait_until="networkidle")
        v = await page.locator("#app-version").inner_text()
        results["version"] = v
        log(f"version: {v}")

        await create_and_setup(page, LEAGUE_ID)

        for i in range(1, 6):
            log(f"pick#{i}: waiting for human turn...")
            status = await wait_human_turn(page, timeout_s=45)
            if status == "complete":
                log(f"pick#{i}: draft complete before pick")
                results["picks"].append({"n": i, "success": False, "reason": "draft already complete"})
                break
            if status == "timeout":
                log(f"pick#{i}: TIMEOUT waiting for human turn (45s)")
                results["picks"].append({"n": i, "success": False, "reason": "timeout waiting for human turn"})
                # Capture state for debugging
                await page.screenshot(path=str(OUT / f"v26p_stuck_pick{i}.png"))
                body = await page.locator("body").inner_text()
                status_text = body[:500]
                log(f"page body preview: {status_text}")
                continue
            log(f"pick#{i}: human turn reached")
            r = await pick_once(page, i)
            log(f"pick#{i}: {r}")
            results["picks"].append(r)

        await browser.close()

    success = sum(1 for p in results["picks"] if p.get("success"))
    total = len(results["picks"])
    rows = "\n".join(
        f"| {p['n']} | {'PASS' if p.get('success') else 'FAIL'} | {p.get('elapsed_ms','-')} | {p.get('reason', p.get('note',''))} |"
        for p in results["picks"]
    )
    report = f"""# R3-C v0.5.26 Patient Retest

Version: {results['version']}
League: {LEAGUE_ID} (fresh)
Total /api/draft/pick calls: {results['pick_calls']}
Total /api/draft/ai-advance calls: {results['ai_advance_calls']}

## Per-pick results

| pick | result | elapsed(ms) | note |
|------|--------|-------------|------|
{rows}

## Success: {success}/{total}

Verdict: {'PASS' if success == total and total == 5 else 'FAIL'}
"""
    REPORT.write_text(report, encoding="utf-8")
    log(f"report: {REPORT}")


if __name__ == "__main__":
    asyncio.run(main())
