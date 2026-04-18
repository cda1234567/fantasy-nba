"""
R3-C v0.5.25 retest (v2) — properly navigate setup -> draft, then stress click.
"""
import asyncio
import time
import pathlib
from datetime import datetime

from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda1234567.com"
OUT = pathlib.Path(r"D:\claude\fantasy nba\.qa\round3\c")
LEAGUE_ID = f"r3cv25-{int(time.time())%100000}"
LOG = OUT / "v25_retest2.log"
REPORT = OUT / "player-v25.md"

log_lines = []


def log(msg: str):
    line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    log_lines.append(line)
    try:
        LOG.write_text("\n".join(log_lines), encoding="utf-8")
    except Exception:
        pass


async def create_league(page, lid):
    await page.locator("#btn-league-switch").click()
    await page.wait_for_timeout(300)
    await page.locator("#btn-lsw-new").click()
    await page.wait_for_timeout(400)
    await page.locator("#new-league-id").fill(lid)
    await page.locator("#btn-new-league-create").click()
    await page.wait_for_load_state("networkidle", timeout=15000)
    log(f"created + switched to {lid}")


async def do_setup(page):
    """If setup form visible, submit with defaults."""
    await page.goto(f"{BASE}/#setup", wait_until="networkidle")
    await page.wait_for_timeout(800)
    submit = page.locator("#btn-setup-submit")
    if await submit.count() > 0 and await submit.is_visible():
        # Fill league name if empty
        name_input = page.locator("#league-name-input, input[name='league_name']").first
        try:
            if await name_input.count() > 0:
                val = await name_input.input_value()
                if not val:
                    await name_input.fill(LEAGUE_ID)
        except Exception:
            pass
        await submit.click()
        log("clicked 開始選秀 (setup submit)")
        await page.wait_for_load_state("networkidle", timeout=20000)
        await page.wait_for_timeout(1500)
        return True
    log("no setup form — league already setup or setup view not active")
    return False


async def ensure_human_turn(page, max_iters=12):
    for i in range(max_iters):
        await page.wait_for_timeout(500)
        body_text = await page.locator("body").inner_text()
        if "輪到你" in body_text:
            return True
        # AI's turn — click 推進 AI 一手 or 模擬到我
        for label in ["模擬到我", "推進 AI", "推進AI"]:
            btn = page.locator(f"button:has-text('{label}')").first
            try:
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click()
                    log(f"clicked '{label}' to advance AI")
                    await page.wait_for_timeout(1500)
                    break
            except Exception:
                continue
    return False


async def pick_once(page, attempt_num):
    btn = page.locator("#tbl-available button[data-draft]:not([disabled])").first
    try:
        await btn.wait_for(state="visible", timeout=5000)
    except Exception:
        log(f"pick#{attempt_num}: no 選秀 button visible")
        return {"n": attempt_num, "success": False, "clicks": 0, "reason": "no button"}
    pid_before = await btn.get_attribute("data-draft")
    t0 = time.time()
    await btn.click()
    # Wait for table re-render
    for _ in range(25):
        await page.wait_for_timeout(200)
        try:
            first = page.locator("#tbl-available button[data-draft]:not([disabled])").first
            if await first.count() == 0:
                # Maybe draft complete or transitioning — check
                body_text = await page.locator("body").inner_text()
                if "選秀完成" in body_text:
                    log(f"pick#{attempt_num}: draft complete after click")
                    return {"n": attempt_num, "success": True, "clicks": 1, "elapsed_ms": int((time.time() - t0) * 1000)}
                continue
            pid_after = await first.get_attribute("data-draft")
            if pid_after != pid_before:
                elapsed = int((time.time() - t0) * 1000)
                log(f"pick#{attempt_num}: SUCCESS 1-click pid {pid_before}->{pid_after} ({elapsed}ms)")
                return {"n": attempt_num, "success": True, "clicks": 1, "elapsed_ms": elapsed}
        except Exception:
            continue
    elapsed = int((time.time() - t0) * 1000)
    log(f"pick#{attempt_num}: FAILED — 1 click didn't advance table in {elapsed}ms")
    return {"n": attempt_num, "success": False, "clicks": 1, "elapsed_ms": elapsed}


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = {"version": None, "picks": [], "console_errors": [], "persistence": None}

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()
        page.on("console", lambda m: results["console_errors"].append({"type": m.type, "text": m.text}) if m.type == "error" else None)

        await page.goto(BASE, wait_until="networkidle")
        v = await page.locator("#app-version").inner_text()
        results["version"] = v
        log(f"version: {v}")
        assert "0.5.25" in v

        # Create fresh league
        await create_league(page, LEAGUE_ID)

        # Submit setup
        await do_setup(page)

        # Go to draft
        await page.goto(f"{BASE}/#draft", wait_until="networkidle")
        await page.wait_for_timeout(1500)

        # Attempt 5 picks
        for i in range(1, 6):
            got_turn = await ensure_human_turn(page, max_iters=15)
            if not got_turn:
                log(f"pick#{i}: could not reach human turn")
                results["picks"].append({"n": i, "success": False, "clicks": 0, "reason": "no human turn"})
                continue
            result = await pick_once(page, i)
            results["picks"].append(result)
            await page.wait_for_timeout(700)

        # Persistence check — close + reopen
        await page.screenshot(path=str(OUT / "v25_draft_state.png"))
        await ctx.close()
        ctx2 = await browser.new_context(viewport={"width": 1400, "height": 900})
        page2 = await ctx2.new_page()
        await page2.goto(f"{BASE}/#draft", wait_until="networkidle")
        await page2.wait_for_timeout(2000)
        label = await page2.locator("#lsw-current").inner_text()
        results["persistence"] = {"league_label": label}
        log(f"after reopen: label={label}")
        await page2.screenshot(path=str(OUT / "v25_after_reopen.png"))

        await browser.close()

    one_click = sum(1 for p in results["picks"] if p["success"] and p.get("clicks") == 1)
    total = len(results["picks"])
    rows = "\n".join(
        f"| {p['n']} | {p.get('clicks', '-')} | {p.get('elapsed_ms', '-')} | {'PASS' if p['success'] else 'FAIL'} | {p.get('reason', '')} |"
        for p in results["picks"]
    )
    report = f"""# R3-C Retest — v0.5.25 draft-click fix

**League:** `{LEAGUE_ID}` (fresh)
**Version on page:** {results["version"]}
**Host:** https://nbafantasy.cda1234567.com

## Draft click reliability

| pick | clicks | elapsed (ms) | result | note |
|------|--------|--------------|--------|------|
{rows}

**One-click success:** {one_click} / {total}

## Persistence after close+reopen

- League label: `{results["persistence"]["league_label"] if results["persistence"] else "n/a"}`

## Console errors

{('- ' + '\n- '.join(e['text'][:150] for e in results['console_errors'][:10])) if results['console_errors'] else '_none_'}

## Verdict

{'PASS — document-level delegation resolves the click bug' if one_click >= max(1, total - 1) else 'FAIL or PARTIAL — investigate further'}
"""
    REPORT.write_text(report, encoding="utf-8")
    log(f"report written to {REPORT}")


if __name__ == "__main__":
    asyncio.run(main())
