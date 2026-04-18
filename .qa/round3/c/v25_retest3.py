"""
R3-C v0.5.25 retest v3 — explicit setup, wait for submit button, force navigate.
"""
import asyncio
import time
import pathlib
from datetime import datetime
from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda1234567.com"
OUT = pathlib.Path(r"D:\claude\fantasy nba\.qa\round3\c")
LEAGUE_ID = f"r3cv25x-{int(time.time())%100000}"
LOG = OUT / "v25_retest3.log"
REPORT = OUT / "player-v25.md"

_logs = []


def log(msg):
    line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    _logs.append(line)
    try:
        LOG.write_text("\n".join(_logs), encoding="utf-8")
    except Exception:
        pass


async def create_and_switch(page, lid):
    await page.locator("#btn-league-switch").click()
    await page.wait_for_timeout(300)
    await page.locator("#btn-lsw-new").click()
    await page.wait_for_timeout(400)
    await page.locator("#new-league-id").fill(lid)
    await page.locator("#btn-new-league-create").click()
    await page.wait_for_load_state("networkidle", timeout=20000)
    log(f"created+switched to {lid}")


async def finish_setup(page):
    """Navigate to #setup and explicitly wait for submit button, then click it."""
    await page.goto(f"{BASE}/#setup", wait_until="networkidle")
    # Wait until setup view rendered
    try:
        await page.locator("#btn-setup-submit").wait_for(state="visible", timeout=15000)
    except Exception as e:
        log(f"setup submit not visible: {e}")
        return False
    await page.locator("#btn-setup-submit").click()
    log("clicked 開始選秀 (setup)")
    # After setup submit, the page should transition to draft view
    try:
        await page.locator("#tbl-available").wait_for(state="visible", timeout=20000)
        log("draft table visible")
        return True
    except Exception as e:
        log(f"draft table not visible after setup: {e}")
        return False


async def ensure_human_turn(page, max_iters=15):
    for i in range(max_iters):
        await page.wait_for_timeout(500)
        body_text = await page.locator("body").inner_text()
        if "輪到你" in body_text:
            return True
        # Try advance buttons
        for label in ["模擬到我", "推進 AI 一手", "推進 AI", "推進AI"]:
            try:
                btn = page.locator(f"button", has_text=label).first
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click()
                    log(f"clicked '{label}'")
                    await page.wait_for_timeout(1500)
                    break
            except Exception:
                pass
    return False


async def pick_once(page, n):
    btn = page.locator("#tbl-available button[data-draft]:not([disabled])").first
    try:
        await btn.wait_for(state="visible", timeout=5000)
    except Exception:
        return {"n": n, "success": False, "clicks": 0, "reason": "no button"}
    pid_before = await btn.get_attribute("data-draft")
    t0 = time.time()
    await btn.click()
    # Also track whether the roster grows
    for _ in range(30):
        await page.wait_for_timeout(200)
        try:
            first = page.locator("#tbl-available button[data-draft]:not([disabled])").first
            if await first.count() == 0:
                if "選秀完成" in (await page.locator("body").inner_text()):
                    return {"n": n, "success": True, "clicks": 1, "elapsed_ms": int((time.time() - t0) * 1000)}
                continue
            pid_after = await first.get_attribute("data-draft")
            if pid_after != pid_before:
                elapsed = int((time.time() - t0) * 1000)
                log(f"pick#{n}: OK 1-click {pid_before}->{pid_after} ({elapsed}ms)")
                return {"n": n, "success": True, "clicks": 1, "elapsed_ms": elapsed}
        except Exception:
            continue
    return {"n": n, "success": False, "clicks": 1, "elapsed_ms": int((time.time() - t0) * 1000)}


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = {"picks": [], "console_errors": [], "version": None}

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()
        page.on("console", lambda m: results["console_errors"].append({"type": m.type, "text": m.text}) if m.type == "error" else None)

        await page.goto(BASE, wait_until="networkidle")
        v = await page.locator("#app-version").inner_text()
        results["version"] = v
        log(f"version: {v}")

        await create_and_switch(page, LEAGUE_ID)
        ok_setup = await finish_setup(page)
        log(f"setup complete: {ok_setup}")

        if not ok_setup:
            REPORT.write_text(f"# R3-C v0.5.25 retest — SETUP FAILED\n\nVersion: {v}\nLeague: {LEAGUE_ID}\n\nSetup submission did not lead to draft view. See log.\n", encoding="utf-8")
            await browser.close()
            return

        # Now on draft page
        for i in range(1, 6):
            if not await ensure_human_turn(page, max_iters=20):
                log(f"pick#{i}: couldn't reach human turn")
                results["picks"].append({"n": i, "success": False, "clicks": 0, "reason": "no human turn"})
                continue
            r = await pick_once(page, i)
            results["picks"].append(r)
            await page.wait_for_timeout(700)

        # Persistence check
        await page.screenshot(path=str(OUT / "v25_mid_draft.png"))
        await ctx.close()
        ctx2 = await browser.new_context(viewport={"width": 1400, "height": 900})
        page2 = await ctx2.new_page()
        await page2.goto(f"{BASE}/#draft", wait_until="networkidle")
        await page2.wait_for_timeout(2500)
        label = await page2.locator("#lsw-current").inner_text()
        log(f"after reopen label={label}")
        await page2.screenshot(path=str(OUT / "v25_after_reopen2.png"))
        await browser.close()

    one_click = sum(1 for p in results["picks"] if p["success"] and p.get("clicks") == 1)
    total = len(results["picks"])
    rows = "\n".join(
        f"| {p['n']} | {p.get('clicks','-')} | {p.get('elapsed_ms','-')} | {'PASS' if p['success'] else 'FAIL'} | {p.get('reason','')} |"
        for p in results["picks"]
    )
    report = f"""# R3-C Retest — v0.5.25 (document-level draft delegation)

**League:** `{LEAGUE_ID}` (fresh)
**Version:** {results["version"]}

## Draft click reliability

| pick | clicks | elapsed(ms) | result | note |
|------|--------|-------------|--------|------|
{rows}

**One-click success:** {one_click} / {total}

## Verdict

{'PASS — doc-level delegation fixes the unreliable click.' if one_click >= max(1, total - 1) else 'FAIL — click still unreliable; needs deeper investigation.'}

## Console errors captured

{('- ' + chr(10).join('- ' + e['text'][:150] for e in results['console_errors'][:8])) if results['console_errors'] else '_none_'}
"""
    REPORT.write_text(report, encoding="utf-8")
    log(f"report written: {REPORT}")


if __name__ == "__main__":
    asyncio.run(main())
