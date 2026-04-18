"""
R3-C v0.5.25 retest: verify document-level draft button delegation works.
Runs against LIVE https://nbafantasy.cda1234567.com on a fresh league.
UI-only clicks (no /api/* calls).
"""
import asyncio
import json
import time
import pathlib
from datetime import datetime

from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda1234567.com"
OUT = pathlib.Path(r"D:\claude\fantasy nba\.qa\round3\c")
LEAGUE_ID = f"r3c-v25-{int(time.time())%100000}"
LOG = OUT / "v25_retest.log"
REPORT = OUT / "player-v25.md"

log_lines = []


def log(msg: str):
    line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    log_lines.append(line)
    LOG.write_text("\n".join(log_lines), encoding="utf-8")


async def open_settings(page):
    # Hamburger button
    btn = page.locator("button#btn-menu")
    await btn.click()
    await page.wait_for_timeout(300)


async def close_any_dialog(page):
    await page.keyboard.press("Escape")
    await page.wait_for_timeout(200)


async def create_league(page, lid):
    # Open league switcher
    await page.locator("#btn-league-switch").click()
    await page.wait_for_timeout(300)
    # Click "+ 建立新聯盟"
    await page.locator("#btn-lsw-new").click()
    await page.wait_for_timeout(400)
    # Fill ID + submit
    await page.locator("#new-league-id").fill(lid)
    await page.locator("#btn-new-league-create").click()
    # Page reloads after create
    await page.wait_for_load_state("networkidle", timeout=15000)
    log(f"created + switched to {lid}")


async def submit_setup_if_needed(page):
    # If /#setup is shown with 開始選秀 button, submit it
    try:
        btn = page.locator("#btn-setup-submit")
        if await btn.is_visible(timeout=2000):
            await btn.click()
            log("submitted setup with defaults")
            await page.wait_for_timeout(1500)
    except Exception:
        pass


async def goto_draft(page):
    await page.goto(f"{BASE}/#draft", wait_until="networkidle")
    await page.wait_for_timeout(500)


async def current_picker_text(page):
    try:
        # "輪到你了" vs "輪到 XXX"
        txt = await page.locator(".draft-hero, .dh-who").first.inner_text(timeout=1500)
        return txt
    except Exception:
        return ""


async def advance_until_human(page, max_iters=10):
    for _ in range(max_iters):
        txt = await current_picker_text(page)
        if "輪到你" in txt:
            return True
        # Try "⏭ 模擬到我" button
        try:
            sim_to_me = page.locator("button", has_text="模擬到我").first
            if await sim_to_me.is_visible(timeout=1000):
                await sim_to_me.click()
                await page.wait_for_timeout(1200)
                continue
        except Exception:
            pass
        await page.wait_for_timeout(1000)
    return False


async def pick_first_available(page, attempt_num):
    """Click the first enabled 選秀 button with a single click. Return (success, clicks, elapsed_ms)."""
    # Find buttons on #tbl-available
    btn = page.locator("#tbl-available button[data-draft]:not([disabled])").first
    try:
        await btn.wait_for(state="visible", timeout=5000)
    except Exception:
        log(f"pick#{attempt_num}: no enabled 選秀 button found")
        return (False, 0, 0)
    pid_before = await btn.get_attribute("data-draft")
    # Record overall pick count before
    try:
        overall_before = await page.locator(".draft-hero .dh-overall, .draft-hero .overall").first.inner_text(timeout=1000)
    except Exception:
        overall_before = ""
    t0 = time.time()
    await btn.click()
    # Wait for either a toast, or the table to re-render (button data-draft changes)
    for _ in range(30):
        await page.wait_for_timeout(200)
        try:
            first_btn = page.locator("#tbl-available button[data-draft]:not([disabled])").first
            pid_after = await first_btn.get_attribute("data-draft")
            if pid_after != pid_before:
                elapsed = int((time.time() - t0) * 1000)
                log(f"pick#{attempt_num}: SUCCESS 1-click, pid {pid_before}->{pid_after}, {elapsed}ms")
                return (True, 1, elapsed)
        except Exception:
            pass
    elapsed = int((time.time() - t0) * 1000)
    log(f"pick#{attempt_num}: FAILED 1 click didn't advance, {elapsed}ms")
    return (False, 1, elapsed)


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = {"version_check": None, "picks": [], "console_errors": [], "notes": []}

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()
        page.on("console", lambda m: results["console_errors"].append({"type": m.type, "text": m.text}) if m.type == "error" else None)

        # Phase 0 — version check
        await page.goto(BASE, wait_until="networkidle")
        version = await page.locator("#app-version").inner_text()
        results["version_check"] = version
        log(f"page version: {version}")
        assert "0.5.25" in version, f"Expected v0.5.25 live, got {version}"

        # Phase 1 — create fresh league
        await create_league(page, LEAGUE_ID)
        await submit_setup_if_needed(page)

        # Phase 2 — draft stress: 5 picks
        await goto_draft(page)
        await page.wait_for_timeout(800)

        for i in range(1, 6):
            # Ensure it's the human's turn
            is_human = await advance_until_human(page, max_iters=12)
            if not is_human:
                log(f"pick#{i}: could not reach human turn, skipping")
                results["picks"].append({"n": i, "success": False, "clicks": 0, "reason": "no human turn"})
                continue
            success, clicks, elapsed = await pick_first_available(page, i)
            results["picks"].append({"n": i, "success": success, "clicks": clicks, "elapsed_ms": elapsed})
            await page.wait_for_timeout(500)

        # Phase 3 — persistence: close + reopen
        await page.screenshot(path=str(OUT / "v25_before_close.png"), full_page=False)
        await ctx.close()
        ctx2 = await browser.new_context(viewport={"width": 1400, "height": 900})
        page2 = await ctx2.new_page()
        await page2.goto(f"{BASE}/#draft", wait_until="networkidle")
        await page2.wait_for_timeout(1500)
        # Verify we're still on the fresh league
        label = await page2.locator("#lsw-current").inner_text()
        log(f"after reopen: league label = {label}")
        results["persistence_label"] = label
        await page2.screenshot(path=str(OUT / "v25_after_reopen.png"), full_page=False)

        await browser.close()

    # Write report
    picks_table = "\n".join(
        f"| {p['n']} | {p.get('clicks', '-')} | {p.get('elapsed_ms', '-')} | {'✅' if p['success'] else '❌'} | {p.get('reason', '')} |"
        for p in results["picks"]
    )
    one_click_count = sum(1 for p in results["picks"] if p["success"] and p.get("clicks") == 1)
    report = f"""# R3-C Retest — v0.5.25 (document-level draft delegation)

**League:** `{LEAGUE_ID}` (fresh)
**Version on page:** {results["version_check"]}
**Host:** https://nbafantasy.cda1234567.com

## Draft click reliability (Phase 2)

| pick | clicks | elapsed (ms) | result | note |
|------|--------|--------------|--------|------|
{picks_table}

**One-click success rate:** {one_click_count}/{len(results["picks"])}

## Persistence (Phase 3)

- After close+reopen, league label: `{results.get("persistence_label", "n/a")}`

## Console errors captured

{('\n'.join('- ' + e['text'][:200] for e in results['console_errors'][:20])) or '_none_'}

## Verdict

{'✅ PASS — document-level delegation fires on first click' if one_click_count >= 4 else '❌ FAIL — draft clicks still unreliable, investigate further'}
"""
    REPORT.write_text(report, encoding="utf-8")
    log(f"REPORT written: {REPORT}")


if __name__ == "__main__":
    asyncio.run(main())
