"""Playwright UI test: can the user actually submit a trade proposal?

Uses the chaos-5 dataset (week 5, mid-season) — already past setup+draft so we
can go straight to the Propose-Trade dialog.
"""
from __future__ import annotations
import asyncio
import os
import sys
import subprocess
import time
from pathlib import Path
from playwright.async_api import async_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(r"D:\claude\fantasy nba")
PORT = 3421
DATA = str(ROOT / ".qa" / "chaos" / "data-5")


async def main():
    env = {**os.environ, "DATA_DIR": DATA, "LEAGUE_ID": "chaos5"}
    proc = subprocess.Popen(
        ["uv", "run", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=str(ROOT), env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        # Wait for server.
        import httpx
        for _ in range(40):
            try:
                httpx.get(f"http://127.0.0.1:{PORT}/api/health", timeout=1).raise_for_status()
                break
            except Exception:
                time.sleep(0.5)
        else:
            raise RuntimeError("server did not come up")

        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            # iPhone-ish
            ctx = await browser.new_context(
                viewport={"width": 390, "height": 844},
                device_scale_factor=3,
                is_mobile=True,
                has_touch=True,
                user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
            )
            page = await ctx.new_page()

            console_logs = []
            page.on("console", lambda msg: console_logs.append(f"[{msg.type}] {msg.text}"))
            page.on("pageerror", lambda err: console_logs.append(f"[pageerror] {err}"))

            await page.goto(f"http://127.0.0.1:{PORT}/")
            await page.wait_for_load_state("networkidle")

            # Go to league tab which has 發起交易 button
            await page.goto(f"http://127.0.0.1:{PORT}/#league")
            await page.wait_for_timeout(800)

            # Find 發起交易 button
            propose_btns = await page.locator("button", has_text="發起交易").all()
            print(f"發起交易 buttons found: {len(propose_btns)}")
            if not propose_btns:
                # Try from schedule/teams tab
                await page.goto(f"http://127.0.0.1:{PORT}/#teams")
                await page.wait_for_timeout(500)
                propose_btns = await page.locator("button", has_text="發起交易").all()
                print(f"after #teams retry: {len(propose_btns)}")

            if propose_btns:
                await propose_btns[0].click()
                await page.wait_for_timeout(500)
                dialog_open = await page.locator("#trade-propose[open]").count()
                print(f"trade-propose dialog open: {dialog_open}")

                # Pick first counterparty
                select = page.locator("#cp-select")
                opts = await select.locator("option").all()
                print(f"counterparty options: {len(opts)}")
                if len(opts) > 1:
                    val = await opts[1].get_attribute("value")
                    await select.select_option(val)
                    await page.wait_for_timeout(800)

                    # Tick first player on each side
                    send_checkboxes = page.locator(".propose-sides .propose-side").nth(0).locator("input[type=checkbox]")
                    recv_checkboxes = page.locator(".propose-sides .propose-side").nth(1).locator("input[type=checkbox]")
                    send_count = await send_checkboxes.count()
                    recv_count = await recv_checkboxes.count()
                    print(f"send players: {send_count}, recv players: {recv_count}")
                    if send_count and recv_count:
                        # tap the label (checkbox on mobile is tiny) — wrapping label catches tap
                        send_labels = page.locator(".propose-sides .propose-side").nth(0).locator("label")
                        recv_labels = page.locator(".propose-sides .propose-side").nth(1).locator("label")
                        await send_labels.nth(0).tap()
                        await page.wait_for_timeout(300)
                        await recv_labels.nth(0).tap()
                        await page.wait_for_timeout(300)

                        # Click 送出提案
                        print("--- clicking 送出提案 ---")
                        logs_before = len(console_logs)
                        submit = page.locator("#btn-trade-propose-submit")
                        is_visible = await submit.is_visible()
                        is_enabled = await submit.is_enabled()
                        print(f"submit button visible={is_visible}, enabled={is_enabled}")
                        # Use tap on mobile
                        await submit.tap()
                        await page.wait_for_timeout(2500)

                        # Check outcome
                        new_logs = console_logs[logs_before:]
                        for log in new_logs:
                            print(f"  CONSOLE: {log}")

                        dialog_still_open = await page.locator("#trade-propose[open]").count()
                        print(f"dialog still open after click: {dialog_still_open}")
                        # Any toast?
                        toast_count = await page.locator(".toast").count()
                        if toast_count:
                            toast_text = await page.locator(".toast").all_inner_texts()
                            print(f"toasts: {toast_text}")
                        else:
                            print("NO TOAST SHOWN")

            print("\n=== ALL CONSOLE LOGS ===")
            for log in console_logs[-20:]:
                print(log)

            await browser.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


asyncio.run(main())
