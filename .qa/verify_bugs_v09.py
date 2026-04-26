"""Smoke test for v26.04.24.09 bug fixes.

Covers:
  Bug 1  推進一天/一週 按鈕可見
  Bug 2  模擬到季後賽 按鈕可見
  Bug 3  交易提案送出按鈕可見
  Bug 4  選秀完成後沒有 /api/draft/ai-advance 409
"""
from __future__ import annotations

import json
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8766")


def main() -> int:
    result: dict = {
        "bug1_adv_day": None,
        "bug1_adv_week": None,
        "bug2_sim_to_playoffs": None,
        "bug3_submit_visible": None,
        "bug4_draft_done": None,
        "bug4_409_count": 0,
        "console_errors": [],
    }

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()

        def on_response(resp):
            if "/api/draft/ai-advance" in resp.url and resp.status == 409:
                result["bug4_409_count"] += 1

        def on_console(m):
            if m.type == "error":
                result["console_errors"].append(m.text[:300])

        page.on("response", on_response)
        page.on("console", on_console)
        page.on("pageerror", lambda e: result["console_errors"].append(str(e)[:300]))

        try:
            page.goto(f"{BASE}/v2#/draft", wait_until="domcontentloaded")
            page.wait_for_timeout(800)

            # Reset draft + run from scratch.
            page.evaluate(
                """async () => {
                    await fetch('/api/draft/reset', {
                        method: 'POST',
                        headers: {'Content-Type':'application/json'},
                        body: '{}',
                    });
                }"""
            )
            page.reload(wait_until="domcontentloaded")
            page.wait_for_timeout(1200)

            # Drive the draft to completion. Click sim-to-me when available,
            # otherwise pick the first eligible player (human turn).
            done = False
            for _ in range(250):
                state = page.evaluate(
                    "async () => (await fetch('/api/state')).json()"
                )
                if state and state.get("is_complete"):
                    done = True
                    break

                # Human turn? Pick first available.
                sim = page.query_selector('button:has-text("模擬到我")')
                if sim and not sim.is_disabled():
                    try:
                        sim.click(timeout=1500)
                    except Exception:
                        pass
                    page.wait_for_timeout(500)
                    continue

                pick = page.query_selector('button[data-draft]:not([disabled])')
                if pick:
                    try:
                        pick.click(timeout=1500)
                    except Exception:
                        pass
                    page.wait_for_timeout(400)
                else:
                    page.wait_for_timeout(800)
            result["bug4_draft_done"] = done

            # Let any stray timers fire.
            page.wait_for_timeout(3500)

            # Start season.
            page.evaluate(
                """async () => {
                    await fetch('/api/season/start', {
                        method: 'POST',
                        headers: {'Content-Type':'application/json'},
                        body: '{}',
                    });
                }"""
            )
            page.wait_for_timeout(500)

            # League view — global action bar.
            page.goto(f"{BASE}/v2#/league", wait_until="domcontentloaded")
            page.wait_for_timeout(1800)

            adv_day = page.query_selector('#league-actions button:has-text("推進一天")')
            result["bug1_adv_day"] = bool(
                adv_day and adv_day.is_visible() and not adv_day.is_disabled()
            )
            adv_week = page.query_selector(
                '#league-actions button:has-text("推進一週")'
            )
            result["bug1_adv_week"] = bool(
                adv_week and adv_week.is_visible() and not adv_week.is_disabled()
            )
            sim_to_po = page.query_selector(
                '#league-actions button:has-text("模擬到季後賽")'
            )
            result["bug2_sim_to_playoffs"] = bool(
                sim_to_po and sim_to_po.is_visible() and not sim_to_po.is_disabled()
            )

            # Management sub-tab: click "聯盟" tab inside league view tabs.
            mgmt_tab = page.query_selector('.lt2:has-text("聯盟")')
            if mgmt_tab:
                mgmt_tab.click()
                page.wait_for_timeout(600)
            mgmt_adv = page.query_selector(
                '.mgmt-controls button:has-text("推進一天")'
            )
            result["bug1_mgmt_adv_day"] = bool(
                mgmt_adv and mgmt_adv.is_visible() and not mgmt_adv.is_disabled()
            )
            mgmt_sim = page.query_selector(
                '.mgmt-controls button:has-text("模擬到季後賽")'
            )
            result["bug2_mgmt_sim"] = bool(
                mgmt_sim and mgmt_sim.is_visible() and not mgmt_sim.is_disabled()
            )

            # Bug 3 — Trade propose modal submit button.
            page.goto(f"{BASE}/v2#/trades", wait_until="domcontentloaded")
            page.wait_for_timeout(1500)
            open_btn = page.query_selector('button:has-text("＋ 發起新交易")')
            if open_btn:
                open_btn.click()
                page.wait_for_timeout(700)
                submit = page.query_selector("#btn-trade-propose-submit-v2")
                if submit:
                    vis = submit.is_visible()
                    box = submit.bounding_box()
                    result["bug3_submit_visible"] = {
                        "visible": vis,
                        "box": box,
                    }
                else:
                    result["bug3_submit_visible"] = {"error": "not in DOM"}
            else:
                result["bug3_submit_visible"] = {"error": "open button missing"}
        finally:
            browser.close()

    print("=== RESULT ===")
    print(json.dumps(result, indent=2, ensure_ascii=False))
    all_ok = (
        result["bug1_adv_day"]
        and result["bug1_adv_week"]
        and result["bug2_sim_to_playoffs"]
        and result["bug4_draft_done"]
        and result["bug4_409_count"] == 0
        and isinstance(result["bug3_submit_visible"], dict)
        and result["bug3_submit_visible"].get("visible") is True
    )
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
