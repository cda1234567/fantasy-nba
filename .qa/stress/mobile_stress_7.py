"""
Mobile stress-test: agent-7
iPhone 12 viewport (390x844), full UX walkthrough.
"""
from __future__ import annotations
import asyncio
import os
import sys
import subprocess
import time
import json
from pathlib import Path
from playwright.async_api import async_playwright, Page

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT   = Path(r"D:\claude\fantasy nba")
PORT   = 3506
DATA   = str(ROOT / ".qa" / "stress" / "data-7")
SS_DIR = ROOT / ".qa" / "stress"

IPHONE12 = dict(
    viewport={"width": 390, "height": 844},
    device_scale_factor=3,
    is_mobile=True,
    has_touch=True,
    user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
)

findings = {
    "cut_off": [],
    "small_tap_targets": [],
    "console_errors": [],
    "overflow_issues": [],
    "screenshots": [],
}


async def screenshot(page: Page, name: str) -> str:
    path = SS_DIR / f"agent-7-{name}.png"
    await page.screenshot(path=str(path), full_page=False)
    findings["screenshots"].append(path.name)
    print(f"  [ss] {path.name}")
    return str(path)


async def check_hscroll(page: Page, label: str):
    """Detect horizontal scroll (scrollWidth > clientWidth on body)."""
    overflow = await page.evaluate(
        "() => document.body.scrollWidth > document.body.clientWidth + 4"
    )
    if overflow:
        sw = await page.evaluate("() => document.body.scrollWidth")
        cw = await page.evaluate("() => document.body.clientWidth")
        msg = f"Horizontal scroll on {label}: scrollWidth={sw} clientWidth={cw}"
        findings["cut_off"].append(msg)
        print(f"  [WARN] {msg}")
    else:
        print(f"  [ok] no h-scroll on {label}")


async def check_tap_targets(page: Page, label: str):
    """Find interactive elements with bounding box < 44x44."""
    tiny = await page.evaluate("""() => {
        const els = document.querySelectorAll('button, a, [role=button], input[type=checkbox], input[type=radio], select');
        const bad = [];
        for (const el of els) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44)) {
                const text = (el.textContent || el.getAttribute('aria-label') || el.type || '').trim().slice(0, 40);
                bad.push({tag: el.tagName, text, w: Math.round(r.width), h: Math.round(r.height)});
            }
        }
        return bad.slice(0, 20);
    }""")
    if tiny:
        for t in tiny:
            msg = f"{label}: <{t['tag']}> '{t['text']}' {t['w']}x{t['h']}px"
            findings["small_tap_targets"].append(msg)
            print(f"  [TAP] {msg}")
    else:
        print(f"  [ok] tap targets ok on {label}")


async def check_overflow_els(page: Page, label: str):
    """Find elements that overflow their container."""
    overflows = await page.evaluate("""() => {
        const bad = [];
        const els = document.querySelectorAll('*');
        for (const el of els) {
            const r = el.getBoundingClientRect();
            if (r.right > window.innerWidth + 4 && r.width > 10) {
                const text = (el.className || el.tagName || '').toString().slice(0,50);
                bad.push({cls: text, right: Math.round(r.right), w: Math.round(r.width)});
            }
        }
        return bad.slice(0,10);
    }""")
    if overflows:
        for o in overflows:
            msg = f"{label}: .{o['cls']} right={o['right']} w={o['w']} (viewport=390)"
            findings["overflow_issues"].append(msg)
            print(f"  [OVF] {msg}")
    else:
        print(f"  [ok] no overflow on {label}")


async def wait_server(url: str, retries=40, delay=0.5):
    import httpx
    for _ in range(retries):
        try:
            httpx.get(url, timeout=1).raise_for_status()
            return True
        except Exception:
            time.sleep(delay)
    return False


async def main():
    env = {**os.environ, "DATA_DIR": DATA, "LEAGUE_ID": "chaos7"}
    proc = subprocess.Popen(
        ["uv", "run", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=str(ROOT), env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    try:
        print(f"Waiting for server on port {PORT}...")
        ok = await wait_server(f"http://127.0.0.1:{PORT}/api/health")
        if not ok:
            raise RuntimeError("Server did not start in time")
        print("Server up.")

        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            ctx = await browser.new_context(**IPHONE12)
            page = await ctx.new_page()

            console_logs = []
            page.on("console", lambda msg: console_logs.append(f"[{msg.type}] {msg.text}"))
            page.on("pageerror", lambda err: console_logs.append(f"[pageerror] {str(err)}"))

            base = f"http://127.0.0.1:{PORT}"

            # ── a. Landing screen ─────────────────────────────────────────
            print("\n=== a. Landing screen ===")
            await page.goto(base + "/")
            await page.wait_for_load_state("networkidle")
            await screenshot(page, "01-landing")
            await check_hscroll(page, "landing")
            await check_tap_targets(page, "landing")
            # Verify CTA buttons visible
            cta_count = await page.locator("button").count()
            print(f"  buttons on landing: {cta_count}")
            if cta_count == 0:
                findings["cut_off"].append("Landing: no CTA buttons found")

            # ── b. Setup wizard ───────────────────────────────────────────
            print("\n=== b. Setup wizard ===")
            # Check if we're already past setup (season phase)
            setup_visible = await page.locator("text=開始設定, text=建立聯盟, text=Setup").count()
            print(f"  setup wizard elements: {setup_visible}")
            await screenshot(page, "02-setup-or-home")

            # Navigate to see current state
            await page.goto(base + "/#draft")
            await page.wait_for_timeout(800)
            phase_text = await page.locator("body").inner_text()
            if "選秀" in phase_text or "draft" in phase_text.lower():
                print("  In draft phase")
            else:
                print("  Past draft phase (season mode)")

            # ── c. Draft screen ───────────────────────────────────────────
            print("\n=== c. Draft screen ===")
            await page.goto(base + "/#draft")
            await page.wait_for_timeout(1000)
            await screenshot(page, "03-draft")
            await check_hscroll(page, "draft")
            await check_tap_targets(page, "draft")
            await check_overflow_els(page, "draft")

            # Try scrolling draft board
            draft_board = page.locator(".draft-board, #draft-board, .draft-table, table").first
            db_count = await draft_board.count()
            print(f"  draft board element found: {db_count}")
            if db_count:
                await draft_board.scroll_into_view_if_needed()
                await page.evaluate("window.scrollBy(0, 300)")
                await page.wait_for_timeout(400)
                # Try tapping a pick
                pick_btns = await page.locator(".draft-pick, .pick-btn, button[data-player]").all()
                if not pick_btns:
                    pick_btns = await page.locator("td button:not([disabled]), .player-row button:not([disabled])").all()
                print(f"  draft pick buttons: {len(pick_btns)}")
                tapped = False
                for pb in pick_btns[:5]:
                    try:
                        disabled = await pb.get_attribute("disabled")
                        if disabled is not None:
                            continue
                        await pb.tap(timeout=3000)
                        tapped = True
                        break
                    except Exception:
                        continue
                if tapped:
                    await page.wait_for_timeout(500)
                    modal_open = await page.locator(".modal[open], dialog[open], .modal.active, [role=dialog]").count()
                    print(f"  modal open after pick tap: {modal_open}")
                    if modal_open:
                        await screenshot(page, "03b-draft-modal")
                        # Close by tapping outside
                        await page.tap("body", position={"x": 10, "y": 10})
                        await page.wait_for_timeout(400)
                        modal_after = await page.locator(".modal[open], dialog[open], .modal.active, [role=dialog]").count()
                        print(f"  modal after tap-outside: {modal_after}")
                        if modal_after > 0:
                            findings["overflow_issues"].append("Draft modal did not close on tap-outside")
                else:
                    print("  [INFO] no enabled draft pick button found (draft may be complete)")

            # ── d. Season tab – advance day ───────────────────────────────
            print("\n=== d. Season tab – advance day ===")
            await page.goto(base + "/#season")
            await page.wait_for_timeout(800)
            await screenshot(page, "04-season")
            await check_hscroll(page, "season")

            advance_btn = page.locator("button", has_text="下一天").or_(
                page.locator("button", has_text="Advance")
            ).or_(page.locator("button", has_text="模擬"))
            adv_count = await advance_btn.count()
            print(f"  advance-day buttons: {adv_count}")
            for i in range(3):
                if adv_count:
                    try:
                        await advance_btn.first.tap(timeout=5000, force=True)
                        await page.wait_for_timeout(800)
                        print(f"  tapped advance day #{i+1}")
                    except Exception as e:
                        print(f"  [WARN] advance-day tap failed: {e!s:.120}")
                        break
                else:
                    print(f"  [WARN] no advance-day button found (try #{i+1})")
                    break
            await screenshot(page, "04b-season-after-advance")

            # ── e. League tab – sub-tabs ──────────────────────────────────
            print("\n=== e. League tab – sub-tabs ===")
            await page.goto(base + "/#league")
            await page.wait_for_timeout(800)
            await screenshot(page, "05-league")
            await check_hscroll(page, "league")
            await check_tap_targets(page, "league")

            sub_tabs = ["對戰", "戰績", "聯盟", "動態"]
            for i, tab_text in enumerate(sub_tabs):
                tab = page.get_by_text(tab_text, exact=True).first
                tc = await tab.count()
                if tc:
                    try:
                        await tab.tap(timeout=5000, force=True)
                        await page.wait_for_timeout(500)
                        await screenshot(page, f"05{chr(97+i)}-league-{tab_text}")
                        await check_hscroll(page, f"league/{tab_text}")
                        print(f"  tapped sub-tab: {tab_text}")
                    except Exception as e:
                        print(f"  [WARN] sub-tab tap failed ({tab_text}): {e!s:.100}")
                        findings["cut_off"].append(f"League sub-tab tap failed: {tab_text}")
                else:
                    print(f"  [WARN] sub-tab not found: {tab_text}")
                    findings["cut_off"].append(f"League sub-tab not found: {tab_text}")

            # ── f. Trade propose dialog ───────────────────────────────────
            print("\n=== f. Trade propose dialog ===")
            await page.goto(base + "/#league")
            await page.wait_for_timeout(800)

            propose_btns = await page.locator("button", has_text="發起交易").all()
            if not propose_btns:
                await page.goto(base + "/#teams")
                await page.wait_for_timeout(500)
                propose_btns = await page.locator("button", has_text="發起交易").all()
            print(f"  發起交易 buttons: {len(propose_btns)}")

            if propose_btns:
                try:
                    await propose_btns[0].tap(timeout=5000, force=True)
                    await page.wait_for_timeout(600)
                    await screenshot(page, "06-trade-dialog")
                    await check_overflow_els(page, "trade-dialog")
                    await check_hscroll(page, "trade-dialog")

                    select = page.locator("#cp-select")
                    opts = await select.locator("option").all()
                    print(f"  counterparty options: {len(opts)}")
                    if len(opts) > 1:
                        val = await opts[1].get_attribute("value")
                        await select.select_option(val)
                        await page.wait_for_timeout(800)
                        await screenshot(page, "06b-trade-counterparty")

                        # Tap 2 players on each side (unbalanced 2-for-1)
                        send_labels = page.locator(".propose-sides .propose-side").nth(0).locator("label")
                        recv_labels = page.locator(".propose-sides .propose-side").nth(1).locator("label")
                        send_count = await send_labels.count()
                        recv_count = await recv_labels.count()
                        print(f"  send labels: {send_count}, recv labels: {recv_count}")

                        # Tap 2 on send side, 1 on recv side (2-for-1 unbalanced)
                        for idx in range(min(2, send_count)):
                            try:
                                await send_labels.nth(idx).tap(timeout=3000)
                            except Exception:
                                pass
                            await page.wait_for_timeout(300)
                        for idx in range(min(1, recv_count)):
                            try:
                                await recv_labels.nth(idx).tap(timeout=3000)
                            except Exception:
                                pass
                            await page.wait_for_timeout(300)

                        await screenshot(page, "06c-trade-selected")
                        submit = page.locator("#btn-trade-propose-submit")
                        is_vis = await submit.is_visible()
                        is_ena = await submit.is_enabled()
                        print(f"  submit visible={is_vis}, enabled={is_ena}")
                        if is_vis:
                            try:
                                await submit.tap(timeout=5000)
                            except Exception as e:
                                print(f"  [WARN] submit tap failed: {e!s:.100}")
                            await page.wait_for_timeout(2000)
                            await screenshot(page, "06d-trade-after-submit")
                            dialog_open = await page.locator("#trade-propose[open]").count()
                            print(f"  dialog open after submit: {dialog_open}")
                            toast = await page.locator(".toast, .alert, .notification").all_inner_texts()
                            if toast:
                                print(f"  toast: {toast}")
                except Exception as e:
                    print(f"  [WARN] trade propose flow error: {e!s:.150}")
                    findings["cut_off"].append(f"Trade propose flow error: {e!s:.100}")
            else:
                findings["cut_off"].append("Trade propose button not found")

            # ── g. Matchup breakdown panel (v0.5.38) ─────────────────────
            print("\n=== g. Matchup breakdown panel ===")
            await page.goto(base + "/#schedule")
            await page.wait_for_timeout(800)
            await screenshot(page, "07-schedule")
            await check_hscroll(page, "schedule")

            # Try to open a completed matchup
            matchup_links = await page.locator("a[href*='matchup'], .matchup-link, .matchup-card, button.matchup").all()
            if not matchup_links:
                matchup_links = await page.locator(".card, .matchup").all()
            print(f"  matchup elements: {len(matchup_links)}")
            if matchup_links:
                try:
                    await matchup_links[0].tap(timeout=5000)
                except Exception as e:
                    print(f"  [WARN] matchup tap failed: {e!s:.100}")
                await page.wait_for_timeout(800)
                await screenshot(page, "07b-matchup-detail")
                await check_overflow_els(page, "matchup-detail")
                await check_hscroll(page, "matchup-detail")
                # Check per-day breakdown panel
                breakdown = await page.locator(".day-breakdown, .per-day, .daily-stats, [class*='breakdown']").count()
                print(f"  per-day breakdown panels: {breakdown}")
                if breakdown == 0:
                    print("  [INFO] no per-day breakdown found (may not be completed matchup)")

            # ── h. 傷兵名單 panel ─────────────────────────────────────────
            print("\n=== h. 傷兵名單 panel ===")
            await page.goto(base + "/#league")
            await page.wait_for_timeout(800)

            # Try to find management sub-tab
            mgmt_tab = page.get_by_text("管理", exact=True).or_(
                page.get_by_text("傷兵", exact=True)
            ).or_(page.get_by_text("Management", exact=True)).first
            mgmt_count = await mgmt_tab.count()
            if mgmt_count:
                try:
                    await mgmt_tab.tap(timeout=5000)
                except Exception:
                    pass
                await page.wait_for_timeout(500)

            injury_panel = page.locator("#injury-list, .injury-panel, [data-panel='injury']").or_(
                page.get_by_text("傷兵名單", exact=True)
            ).first
            inj_count = await injury_panel.count()
            print(f"  injury panel elements: {inj_count}")
            if inj_count:
                await injury_panel.scroll_into_view_if_needed()
                await page.wait_for_timeout(400)
                await screenshot(page, "08-injury-panel")
                await check_overflow_els(page, "injury-panel")
                rows = await page.locator(".injury-row, .injured-player, tr.injured").count()
                print(f"  injury rows: {rows}")
                if rows == 0:
                    findings["cut_off"].append("Injury panel: no rows visible")
            else:
                print("  [INFO] injury panel not found via primary selector, trying button")
                inj_btn = page.locator("button", has_text="傷兵").or_(page.get_by_text("🏥")).first
                if await inj_btn.count():
                    try:
                        await inj_btn.tap(timeout=5000)
                    except Exception:
                        pass
                    await page.wait_for_timeout(500)
                    await screenshot(page, "08b-injury-after-tap")
                    await check_overflow_els(page, "injury-after-tap")
                else:
                    findings["cut_off"].append("傷兵名單 panel/button not found")

            # ── i. Landscape resize ───────────────────────────────────────
            print("\n=== i. Landscape resize ===")
            await page.set_viewport_size({"width": 844, "height": 390})
            await page.wait_for_timeout(600)
            await screenshot(page, "09-landscape")
            await check_hscroll(page, "landscape")
            await check_tap_targets(page, "landscape-tabbar")

            # Check tab bar still accessible
            tab_bar = await page.locator(".tab-bar, nav, .bottom-nav, .tabs").count()
            print(f"  tab bar elements in landscape: {tab_bar}")
            if tab_bar == 0:
                findings["cut_off"].append("Tab bar not found in landscape orientation")

            await browser.close()

        # ── Console log snapshot ──────────────────────────────────────────
        print("\n=== Console log snapshot ===")
        errors = [l for l in console_logs if "[error]" in l.lower() or "[pageerror]" in l.lower()]
        warnings = [l for l in console_logs if "[warning]" in l.lower() or "[warn]" in l.lower()]
        for e in errors:
            findings["console_errors"].append(e)
        print(f"  Total logs: {len(console_logs)}, Errors: {len(errors)}, Warnings: {len(warnings)}")
        for l in console_logs[-30:]:
            print(f"  {l}")

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        print("\nServer stopped.")

    # ── Write findings ────────────────────────────────────────────────────
    report_path = ROOT / ".qa" / "stress" / "agent-7.md"
    lines = ["# Agent-7 Mobile Stress Test Findings\n",
             f"Date: 2026-04-18  Port: {PORT}  Data: stress/data-7  Viewport: 390×844 iPhone12\n\n"]

    def section(title, items, empty_msg="None found."):
        s = f"## {title}\n"
        s += "\n".join(f"- {i}" for i in items) if items else f"- {empty_msg}"
        return s + "\n\n"

    lines.append(section("Elements cut off / missing at screen edge", findings["cut_off"]))
    lines.append(section("Tap targets < 44px", findings["small_tap_targets"]))
    lines.append(section("Console errors / unhandled rejections", findings["console_errors"]))
    lines.append(section("Overflow issues (dialogs / panels)", findings["overflow_issues"]))
    lines.append(section("Screenshots captured", findings["screenshots"]))

    report_path.write_text("".join(lines), encoding="utf-8")
    print(f"\nFindings written to {report_path}")
    print(f"Screenshots: {len(findings['screenshots'])}")


asyncio.run(main())
