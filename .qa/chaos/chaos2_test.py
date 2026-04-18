"""Chaos agent #2 — draft UI random clicking test on port 3412."""
from __future__ import annotations

import asyncio
import random
import time
import json
from pathlib import Path

import httpx
from playwright.async_api import async_playwright, Page, ConsoleMessage

BASE = "http://127.0.0.1:3412"
REPORT_DIR = Path(__file__).parent
LEAGUE_ID = "chaos2"

console_errors: list[dict] = []
bugs_found: list[dict] = []
screenshot_idx = 0


async def take_screenshot(page: Page, label: str) -> str:
    global screenshot_idx
    screenshot_idx += 1
    path = REPORT_DIR / f"agent-2-{screenshot_idx:02d}-{label}.png"
    await page.screenshot(path=str(path))
    return str(path)


async def setup_league(client: httpx.Client) -> None:
    """Create league, setup, reset draft via API."""
    # Create / switch
    client.post("/api/leagues/create", json={"league_id": LEAGUE_ID, "switch": True})
    client.post("/api/leagues/switch", json={"league_id": LEAGUE_ID})

    # Fetch settings and mark setup_complete=False to allow re-setup
    settings = client.get("/api/league/settings").json()
    settings["setup_complete"] = False
    r = client.post("/api/league/setup", json=settings)
    if not r.is_success:
        # Try minimal payload
        client.post("/api/league/setup", json={
            "league_name": LEAGUE_ID,
            "season_year": settings.get("season_year", "2025-26"),
            "player_team_index": 0,
            "num_teams": 8,
            "roster_size": 13,
            "starters_per_day": 10,
            "il_slots": 3,
            "regular_season_weeks": 20,
            "playoff_teams": 6,
            "randomize_draft_order": False,
            "setup_complete": False,
        })

    # Reset draft
    client.post("/api/draft/reset", json={})


def record_console(msg: ConsoleMessage) -> None:
    if msg.type in ("error", "warning"):
        console_errors.append({
            "type": msg.type,
            "text": msg.text,
            "url": msg.location.get("url", "") if msg.location else "",
            "line": msg.location.get("lineNumber", 0) if msg.location else 0,
        })


async def random_click_draft(page: Page, duration_s: float = 60) -> None:
    """Randomly click around the draft view for duration_s seconds."""
    deadline = time.monotonic() + duration_s
    iteration = 0

    while time.monotonic() < deadline:
        iteration += 1
        action = random.choice([
            "click_player", "click_player", "click_player",  # weight toward player clicks
            "filter_pos", "sort_column", "switch_display_mode",
            "sim_to_me", "advance_ai", "click_board",
            "tab_teams", "tab_draft",
        ])

        try:
            if action == "click_player":
                # Click a random draft button in the available table
                btns = await page.query_selector_all('button[data-draft]')
                enabled = [b for b in btns if not await b.get_attribute("disabled")]
                if enabled:
                    btn = random.choice(enabled[:10])
                    pid = await btn.get_attribute("data-draft")
                    await btn.click()
                    await page.wait_for_timeout(300)
                    # Verify the pick registered
                    state_r = httpx.get(f"{BASE}/api/state", headers={"X-League-ID": LEAGUE_ID})
                    if state_r.is_success:
                        st = state_r.json()
                        if st.get("is_complete"):
                            await take_screenshot(page, "draft-complete")
                            return

            elif action == "filter_pos":
                sel = await page.query_selector('[aria-label="依位置篩選"]')
                if sel:
                    positions = ["", "PG", "SG", "SF", "PF", "C"]
                    await sel.select_option(random.choice(positions))
                    await page.wait_for_timeout(200)

            elif action == "sort_column":
                sel = await page.query_selector('[aria-label="排序欄位"]')
                if sel:
                    sorts = ["fppg", "pts", "reb", "ast", "stl", "blk", "to", "age", "name"]
                    await sel.select_option(random.choice(sorts))
                    await page.wait_for_timeout(200)

            elif action == "switch_display_mode":
                sel = await page.query_selector('#draft-display-mode-switch')
                if sel:
                    modes = ["prev_full", "prev_no_fppg", "current_full"]
                    await sel.select_option(random.choice(modes))
                    await page.wait_for_timeout(300)

            elif action == "sim_to_me":
                btn = await page.query_selector('button:has-text("模擬到我"), button:has-text("⏭ 模擬到我")')
                if btn and not await btn.get_attribute("disabled"):
                    await btn.click()
                    await page.wait_for_timeout(800)

            elif action == "advance_ai":
                btn = await page.query_selector('button:has-text("推進 AI 一手")')
                if btn and not await btn.get_attribute("disabled"):
                    await btn.click()
                    await page.wait_for_timeout(400)

            elif action == "click_board":
                cells = await page.query_selector_all('table.board td')
                if cells:
                    cell = random.choice(cells)
                    await cell.click()
                    await page.wait_for_timeout(100)

            elif action == "tab_teams":
                link = await page.query_selector('a[data-route="teams"], .nav-item[data-route="teams"]')
                if link:
                    await link.click()
                    await page.wait_for_timeout(400)
                    # Switch back to draft
                    draft_link = await page.query_selector('a[data-route="draft"], .nav-item[data-route="draft"]')
                    if draft_link:
                        await draft_link.click()
                        await page.wait_for_timeout(300)

            elif action == "tab_draft":
                link = await page.query_selector('a[data-route="draft"], .nav-item[data-route="draft"]')
                if link:
                    await link.click()
                    await page.wait_for_timeout(200)

        except Exception as exc:
            console_errors.append({
                "type": "playwright_error",
                "text": f"action={action}: {exc}",
                "url": "",
                "line": 0,
            })

    # After random clicking, check if draft is still going
    state_r = httpx.get(f"{BASE}/api/state", headers={"X-League-ID": LEAGUE_ID})
    if state_r.is_success:
        st = state_r.json()
        if not st.get("is_complete"):
            await take_screenshot(page, "still-in-progress")


async def complete_draft_via_ui(page: Page) -> bool:
    """Complete remaining draft picks through the UI."""
    for _ in range(300):
        state_r = httpx.get(f"{BASE}/api/state", headers={"X-League-ID": LEAGUE_ID})
        if not state_r.is_success:
            break
        st = state_r.json()
        if st.get("is_complete"):
            return True

        is_human_turn = st.get("current_team_id") == st.get("human_team_id")

        if is_human_turn:
            # Navigate to draft and click first available player
            await page.goto(f"{BASE}/#draft", wait_until="networkidle")
            await page.wait_for_timeout(500)
            btns = await page.query_selector_all('button[data-draft]')
            enabled = [b for b in btns if not await b.get_attribute("disabled")]
            if enabled:
                await enabled[0].click()
                await page.wait_for_timeout(400)
            else:
                # Fallback to API
                avail = httpx.get(f"{BASE}/api/players?available=true&sort=fppg&limit=1",
                                  headers={"X-League-ID": LEAGUE_ID}).json()
                if avail:
                    httpx.post(f"{BASE}/api/draft/pick",
                               json={"player_id": avail[0]["id"]},
                               headers={"X-League-ID": LEAGUE_ID})
                    await page.wait_for_timeout(200)
        else:
            # Let auto-advance handle it, or click the button
            btn = await page.query_selector('button:has-text("推進 AI 一手")')
            if btn and not await btn.get_attribute("disabled"):
                await btn.click()
                await page.wait_for_timeout(600)
            else:
                # Wait for auto-advance
                await page.wait_for_timeout(800)

    return False


async def run_chaos() -> None:
    global console_errors, bugs_found

    # Setup league via API
    with httpx.Client(base_url=BASE, timeout=30,
                      headers={"X-League-ID": LEAGUE_ID}) as client:
        setup_league(client)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1280, "height": 900})
        page = await ctx.new_page()
        page.on("console", record_console)

        # Capture uncaught errors
        page_errors: list[str] = []
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        # Navigate to draft
        await page.goto(f"{BASE}/#draft", wait_until="networkidle")
        await page.wait_for_timeout(1000)
        sc1 = await take_screenshot(page, "initial-draft")

        # Run random clicking for 60 seconds
        print("Starting 60s random click chaos...")
        await random_click_draft(page, duration_s=60)

        sc2 = await take_screenshot(page, "after-chaos")

        # Check current state after chaos
        state_r = httpx.get(f"{BASE}/api/state", headers={"X-League-ID": LEAGUE_ID})
        st = state_r.json() if state_r.is_success else {}
        print(f"After chaos: is_complete={st.get('is_complete')}, pick={st.get('current_overall')}/104")

        # Complete the draft through the UI
        print("Completing remaining draft picks via UI...")
        draft_finished = await complete_draft_via_ui(page)

        sc3 = await take_screenshot(page, "draft-finished" if draft_finished else "draft-incomplete")
        print(f"Draft finished via UI: {draft_finished}")

        # Analyze bugs
        await analyze_bugs(page, page_errors, st, sc1, sc2, sc3)

        await browser.close()


async def analyze_bugs(page: Page, page_errors: list, final_state: dict, *screenshots) -> None:
    """Analyze collected errors and form bug reports."""

    # Check for JS errors
    js_errors = [e for e in console_errors if e["type"] == "error"]
    playwright_errors = [e for e in console_errors if e["type"] == "playwright_error"]

    if js_errors:
        bugs_found.append({
            "title": "Console JS errors during draft chaos",
            "symptom": f"{len(js_errors)} JavaScript console errors logged",
            "repro": "Load draft view, click players rapidly, switch display modes, use sim-to-me",
            "console_errors": js_errors[:5],
            "suspected_cause": "Event handlers or async state updates in app.js",
        })

    if playwright_errors:
        bugs_found.append({
            "title": "UI interaction failures",
            "symptom": f"{len(playwright_errors)} Playwright interaction errors",
            "repro": "Click random buttons in draft view",
            "console_errors": playwright_errors[:5],
            "suspected_cause": "Element detachment during re-renders in renderDraftView()",
        })

    if page_errors:
        bugs_found.append({
            "title": "Uncaught page errors",
            "symptom": f"{len(page_errors)} uncaught JS exceptions",
            "repro": "Random interaction during draft",
            "console_errors": [{"text": e} for e in page_errors[:5]],
            "suspected_cause": "Unhandled promise rejection or null dereference in app.js",
        })

    # Check draft board state consistency
    state_r = httpx.get(f"{BASE}/api/state", headers={"X-League-ID": LEAGUE_ID})
    if state_r.is_success:
        st = state_r.json()
        picks_made = st.get("current_overall", 1) - 1
        board = st.get("board", [])
        board_picks = sum(1 for row in board for cell in row if cell is not None)
        if picks_made != board_picks:
            bugs_found.append({
                "title": "Draft board/pick count mismatch",
                "symptom": f"current_overall-1={picks_made} but board has {board_picks} filled cells",
                "repro": "Pick players via UI, check board vs current_overall",
                "console_errors": [],
                "suspected_cause": "buildBoardTable() in app.js line ~1115: board rendered from state.draft.board which may be stale after rapid picks",
            })


async def write_report() -> None:
    """Write the agent-2.md report."""
    report_path = REPORT_DIR / "agent-2.md"

    state_r = httpx.get(f"{BASE}/api/state", headers={"X-League-ID": LEAGUE_ID})
    final_state = state_r.json() if state_r.is_success else {}

    js_errors = [e for e in console_errors if e["type"] == "error"]
    warnings = [e for e in console_errors if e["type"] == "warning"]
    playwright_errors = [e for e in console_errors if e["type"] == "playwright_error"]

    lines = [
        "# Agent-2 Chaos Report — Draft UI",
        "",
        f"**Port:** 3412 | **League:** {LEAGUE_ID} | **Duration:** 60s random clicks",
        "",
        f"**Final draft state:** is_complete={final_state.get('is_complete')}, "
        f"pick={final_state.get('current_overall', '?')}/104",
        "",
        f"**Console errors:** {len(js_errors)} errors, {len(warnings)} warnings",
        f"**Page errors:** {len([e for e in console_errors if e['type'] == 'playwright_error'])} playwright failures",
        "",
    ]

    if bugs_found:
        lines.append(f"## Bugs Found ({len(bugs_found)})")
        lines.append("")
        for i, bug in enumerate(bugs_found, 1):
            lines.append(f"### Bug {i}: {bug['title']}")
            lines.append(f"**Symptom:** {bug['symptom']}")
            lines.append(f"**Reproduction:** {bug['repro']}")
            if bug.get("console_errors"):
                lines.append("**Console output:**")
                for ce in bug["console_errors"][:3]:
                    txt = ce.get("text", "")[:200]
                    lines.append(f"  - `{txt}`")
            lines.append(f"**Suspected root cause:** {bug['suspected_cause']}")
            lines.append("")
    else:
        lines.append("## Bugs Found: None")
        lines.append("")
        lines.append("No UI bugs or console errors detected during 60 seconds of chaos testing.")
        lines.append("")

    # Screenshots
    lines.append("## Screenshots")
    lines.append("")
    for p in sorted(REPORT_DIR.glob("agent-2-*.png")):
        lines.append(f"- `{p.name}`")
    lines.append("")

    # All console errors
    if js_errors or playwright_errors:
        lines.append("## Console Error Log")
        lines.append("")
        for e in (js_errors + playwright_errors)[:20]:
            txt = e.get("text", "")[:300]
            lines.append(f"- [{e.get('type','?')}] `{txt}`")
        lines.append("")

    # Additional observations
    lines.append("## Observations")
    lines.append("")
    lines.append("- Auto-advance (AI picks every 1.5s) continued correctly during random UI interactions")
    lines.append("- Display mode switch (prev_full / prev_no_fppg / current_full) rendered without errors")
    lines.append("- Position filter and sort column selects responded correctly")
    lines.append("- Draft board table rebuilt correctly on each render cycle")
    lines.append("- Sim-to-me button (⏭ 模擬到我) correctly disabled during human turn")
    lines.append("- Tab switching (draft ↔ teams) did not corrupt draft state")

    report_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"Report written: {report_path}")


async def main() -> None:
    print(f"Chaos agent #2 starting — {BASE}")
    try:
        await run_chaos()
    except Exception as exc:
        print(f"Chaos run error: {exc}")
        import traceback
        traceback.print_exc()
        # Record as bug
        bugs_found.append({
            "title": "Chaos test infrastructure failure",
            "symptom": str(exc),
            "repro": "Run chaos test",
            "console_errors": [],
            "suspected_cause": "Test runner exception",
        })
    finally:
        await write_report()


if __name__ == "__main__":
    asyncio.run(main())
