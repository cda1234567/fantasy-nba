"""Smoke test for v26.04.24.12 changes: season dropdown, draft commentary feed,
single propose button, counter-offer modal.

Runs headless Playwright against http://127.0.0.1:8766 and prints a summary.
"""
from __future__ import annotations

import sys
from playwright.sync_api import sync_playwright


BASE = "http://127.0.0.1:8766"


def main() -> int:
    results: list[tuple[str, bool, str]] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            ctx = browser.new_context()
            page = ctx.new_page()

            # 1) Setup page: season dropdown exists with ~30 options.
            page.goto(f"{BASE}/v2#/setup", wait_until="networkidle", timeout=15000)
            page.wait_for_timeout(1200)
            # Grab every <select> after "賽季年份" label. We just scan all selects
            # and look for one that contains both 1996-97 and 2025-26 options.
            selects = page.query_selector_all("select")
            found_season_select = False
            option_count = 0
            for s in selects:
                opts = s.query_selector_all("option")
                values = [o.get_attribute("value") or "" for o in opts]
                if "1996-97" in values and "2025-26" in values:
                    found_season_select = True
                    option_count = len(values)
                    break
            results.append((
                "A: season <select> with 30 options",
                found_season_select and option_count == 30,
                f"found={found_season_select} options={option_count}",
            ))

            # 2) Trades page: count propose buttons. Need draft_complete to see.
            # Draft should already be complete from prior usage (based on state
            # dump during smoke). If not, skip.
            page.goto(f"{BASE}/v2#/trades", wait_until="networkidle", timeout=15000)
            page.wait_for_timeout(1500)
            # Count buttons whose text contains "發起" (propose trade entry points
            # in the trades view). Human may see 1 (propose tab only) after fix.
            buttons = page.query_selector_all("button")
            propose_btns = []
            for b in buttons:
                text = (b.inner_text() or "").strip()
                if "發起" in text and "交易" in text:
                    propose_btns.append(text)
            # The propose sub-tab has "＋ 建立提案" (no 發起). The view-head one
            # (now removed) was "＋ 發起新交易". So after the fix, there should
            # be ZERO buttons matching 發起+交易.
            results.append((
                "C: zero '發起…交易' buttons in trades view",
                len(propose_btns) == 0,
                f"count={len(propose_btns)} texts={propose_btns}",
            ))
            # Sanity: there should still be the '＋ 建立提案' in propose tab.
            page.evaluate("""
              () => {
                const tabs = [...document.querySelectorAll('button.lt2')];
                const propose = tabs.find(b => b.textContent.trim() === '發起');
                if (propose) propose.click();
              }
            """)
            page.wait_for_timeout(700)
            build_btn = None
            for b in page.query_selector_all("button"):
                t = (b.inner_text() or "").strip()
                if "建立提案" in t:
                    build_btn = t
                    break
            results.append((
                "C: '建立提案' in propose sub-tab preserved",
                build_btn is not None,
                f"text={build_btn}",
            ))

            # 3) Draft page: chat panel present.
            page.goto(f"{BASE}/v2#/draft", wait_until="networkidle", timeout=15000)
            page.wait_for_timeout(1200)
            chat = page.query_selector("#draft-chat-panel")
            results.append((
                "B: draft chat panel rendered",
                chat is not None,
                f"found={chat is not None}",
            ))

            # 4) Counter-offer modal exists in DOM on trades view
            page.goto(f"{BASE}/v2#/trades", wait_until="networkidle", timeout=15000)
            page.wait_for_timeout(1200)
            counter_dlg = page.query_selector("#trade-counter-v2")
            results.append((
                "D: counter-offer dialog present in DOM",
                counter_dlg is not None,
                f"found={counter_dlg is not None}",
            ))
        finally:
            browser.close()

    print("=" * 60)
    all_pass = True
    for name, ok, detail in results:
        mark = "PASS" if ok else "FAIL"
        if not ok:
            all_pass = False
        print(f"[{mark}] {name}  ({detail})")
    print("=" * 60)
    return 0 if all_pass else 1


if __name__ == "__main__":
    sys.exit(main())
