"""
QA Mobile Test - iPhone SE viewport 375x667
Fantasy NBA Draft Simulator - Full season end-to-end on mobile

Run:
    uv run python tests/qa_mobile_3.py
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx
from playwright.async_api import Page, BrowserContext, async_playwright

BASE_URL = "http://localhost:3410"
SCREENSHOTS = Path(__file__).parent / "screenshots"
SCREENSHOTS.mkdir(exist_ok=True)

# Force UTF-8 output on Windows to avoid cp950 crash when printing player names
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

IPHONE_SE = {
    "viewport": {"width": 375, "height": 667},
    "device_scale_factor": 2,
    "is_mobile": True,
    "has_touch": True,
    "user_agent": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1"
    ),
}

results: list[dict] = []


def safe(text: str) -> str:
    return text.encode("ascii", errors="replace").decode("ascii")


def record(name: str, status: str, notes: str = "", issues: list[str] | None = None):
    results.append({"name": name, "status": status, "notes": notes, "issues": issues or []})
    icon = "PASS" if status == "PASS" else "FAIL" if status == "FAIL" else "WARN"
    print(f"  [{icon}] {name}: {safe(notes)}")
    for iss in issues or []:
        print(f"         issue: {safe(iss)}")


# ── Helpers ───────────────────────────────────────────────────────────────────

async def ss(page: Page, name: str) -> Path:
    path = SCREENSHOTS / name
    await page.screenshot(path=str(path), full_page=False)
    print(f"  [SS]  {name}")
    return path


async def api_safe(method: str, path: str, **kw):
    try:
        async with httpx.AsyncClient(base_url=BASE_URL, timeout=30) as c:
            r = await c.request(method, path, **kw)
            r.raise_for_status()
            return r.json()
    except Exception as e:
        print(f"  [api] {method} {path} -> {safe(str(e))[:120]}")
        return None


async def measure_overflow(page: Page) -> dict:
    return await page.evaluate(
        "(() => ({ scrollW: document.documentElement.scrollWidth, "
        "clientW: document.documentElement.clientWidth, "
        "overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }))()"
    )


async def js_click(page: Page, selector: str) -> bool:
    try:
        result = await page.evaluate(
            f"(() => {{ const el = document.querySelector({json.dumps(selector)}); "
            f"if (!el) return false; el.click(); return true; }})()"
        )
        return bool(result)
    except Exception as e:
        print(f"  [js_click] {selector[:40]} failed: {safe(str(e))[:80]}")
        return False


async def check_tap_targets(page: Page, selector: str) -> list[str]:
    return await page.evaluate(
        f"(() => {{ const els = document.querySelectorAll({json.dumps(selector)}); "
        f"const out = []; "
        f"els.forEach((el, i) => {{ const r = el.getBoundingClientRect(); "
        f"if (r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44)) "
        f"out.push('[' + i + '] ' + el.tagName + '.' + (el.className||'').split(' ')[0] + ' = ' + r.width.toFixed(0) + 'x' + r.height.toFixed(0) + 'px'); }}); "
        f"return out.slice(0, 10); }})()"
    )


# ── TC1: Landing ─────────────────────────────────────────────────────────────

async def tc1_landing(page: Page):
    print("\n[TC1] Landing state")
    await page.goto(BASE_URL, wait_until="networkidle")
    await page.wait_for_timeout(800)

    ov = await measure_overflow(page)
    await ss(page, "q3_01_landing.png")

    issues = []
    if ov["overflow"]:
        issues.append(f"P1: Horizontal scroll on landing — scrollW={ov['scrollW']}px vs clientW={ov['clientW']}px")

    bottom_tabs = await page.locator(".bottom-tabs").is_visible()
    side_nav_vis = await page.locator(".side-nav").is_visible()
    header_vis = await page.locator(".app-header").is_visible()

    if not bottom_tabs:
        issues.append("P2: Bottom tabs (.bottom-tabs) not visible on 375px viewport")
    if side_nav_vis:
        issues.append("P3: Side nav (.side-nav) visible on mobile — should be hidden")
    if not header_vis:
        issues.append("P2: App header not visible")

    record("TC1 Landing viewport render", "FAIL" if issues else "PASS",
           f"overflow={ov['overflow']} scrollW={ov['scrollW']} bottom_tabs={bottom_tabs} side_nav={side_nav_vis}",
           issues)


# ── TC2: Draft page ───────────────────────────────────────────────────────────

async def tc2_draft(page: Page):
    print("\n[TC2] Draft page")
    await page.goto(f"{BASE_URL}/#draft", wait_until="networkidle")
    await page.wait_for_timeout(1000)

    ov = await measure_overflow(page)
    await ss(page, "q3_10_draft.png")

    issues = []
    if ov["overflow"]:
        issues.append(f"P1: Horizontal scroll on draft page — scrollW={ov['scrollW']}px vs 375px viewport")

    has_players = await page.locator("tr, .player-row, .player-card, [data-draft]").count() > 0
    if not has_players:
        issues.append("P1: No player rows/buttons found on draft page")

    # Check controls bar width
    clock_info = await page.evaluate(
        "(() => { const el = document.querySelector('.clock-actions, .draft-controls, .draft-actions, .panel'); "
        "if (!el) return null; "
        "return {cls: el.className, scrollW: el.scrollWidth, offsetW: el.offsetWidth}; })()"
    )
    if clock_info and clock_info.get("scrollW", 0) > 375:
        issues.append(
            f"P1: Draft controls bar scrollW={clock_info['scrollW']}px overflows 375px — "
            f"pick buttons are off-screen on real iPhone"
        )

    record("TC2 Draft page render", "FAIL" if issues else "PASS",
           f"overflow={ov['overflow']} scrollW={ov['scrollW']} has_players={has_players}", issues)


async def tc2b_draft_scroll(page: Page):
    print("\n[TC2b] Draft scroll")
    await page.evaluate("window.scrollTo(0, 500)")
    await page.wait_for_timeout(500)
    await ss(page, "q3_11_draft_scroll.png")

    ov = await measure_overflow(page)
    issues = []
    if ov["overflow"]:
        issues.append(f"P2: Overflow persists when scrolled — scrollW={ov['scrollW']}px")

    name_info = await page.evaluate(
        "(() => { const cells = document.querySelectorAll('td.name, td:first-child, .player-name'); "
        "let wrapped = 0; "
        "cells.forEach(c => { if (c.scrollHeight > c.clientHeight + 4) wrapped++; }); "
        "return {total: cells.length, wrapped}; })()"
    )
    record("TC2b Draft scroll", "FAIL" if issues else "PASS",
           f"overflow={ov['overflow']} name_cells={name_info.get('total',0)} wrapped={name_info.get('wrapped',0)}",
           issues)


async def tc2c_human_pick(page: Page):
    print("\n[TC2c] Human pick")
    await page.goto(f"{BASE_URL}/#draft", wait_until="networkidle")
    await page.wait_for_timeout(800)

    issues = []

    btn_info = await page.evaluate(
        "(() => { const btns = document.querySelectorAll('button[data-draft], .act button, .pick-btn'); "
        "if (!btns.length) return {count: 0}; "
        "const first = btns[0]; const r = first.getBoundingClientRect(); "
        "return {count: btns.length, firstX: r.x, firstY: r.y, firstW: r.width, firstH: r.height, "
        "offscreen: r.x > 375 || r.x < 0}; })()"
    )
    count = btn_info.get("count", 0)
    print(f"  pick buttons: {count}, firstX={btn_info.get('firstX','?')}, offscreen={btn_info.get('offscreen','?')}")

    if count == 0:
        issues.append("P1: No pick buttons found on draft page")
    else:
        if btn_info.get("offscreen"):
            issues.append(
                f"P0: Pick button at x={btn_info.get('firstX',0):.0f}px is OFF-SCREEN "
                f"(viewport=375px) — unreachable on real iPhone SE. Draft is UNUSABLE on mobile."
            )
        fw, fh = btn_info.get("firstW", 99), btn_info.get("firstH", 99)
        if fw < 44 or fh < 44:
            issues.append(f"P2: Pick button {fw:.0f}x{fh:.0f}px < 44x44px Apple guideline")

    # JS click to bypass off-screen
    clicked = await js_click(page, "button[data-draft]")
    if not clicked:
        clicked = await js_click(page, ".act button")
    await page.wait_for_timeout(800)
    print(f"  JS click succeeded: {clicked}")

    await ss(page, "q3_12_pick.png")

    modal_visible = await page.locator("dialog[open], .modal, .pick-modal").count() > 0
    ov = await measure_overflow(page)
    if ov["overflow"]:
        issues.append(f"P2: Overflow after pick scrollW={ov['scrollW']}px")

    record("TC2c Human pick", "FAIL" if issues else "PASS",
           f"count={count} offscreen={btn_info.get('offscreen')} clicked={clicked} modal={modal_visible}", issues)

    await js_click(page, "dialog[open] button[value='close']")
    await js_click(page, "dialog[open] button[type='submit']")
    await page.wait_for_timeout(300)


async def tc2d_advance_draft(page: Page):
    print("\n[TC2d] Advance draft to completion via API")
    issues = []
    picks_made = 0
    round5_shot = False

    for _ in range(300):
        state = await api_safe("GET", "/api/state")
        if not state:
            issues.append("P1: /api/state failed during draft advance")
            break
        if state.get("is_complete"):
            break

        curr_team = state.get("current_team_id")
        human_id = state.get("human_team_id", 0)

        if curr_team == human_id:
            players = await api_safe("GET", "/api/players?limit=1")
            if not players:
                break
            pid = players[0].get("id") if isinstance(players, list) and players else None
            if pid is None:
                break
            res = await api_safe("POST", "/api/draft/pick", json={"player_id": pid})
            if not res:
                break
        else:
            res = await api_safe("POST", "/api/draft/ai-pick")
            if not res:
                break

        picks_made += 1

        if not round5_shot:
            st2 = await api_safe("GET", "/api/state")
            if st2 and st2.get("current_round", 0) >= 5:
                await page.goto(f"{BASE_URL}/#draft", wait_until="networkidle")
                await page.wait_for_timeout(500)
                await ss(page, "q3_13_mid_draft.png")
                round5_shot = True

    await page.goto(f"{BASE_URL}/#draft", wait_until="networkidle")
    await page.wait_for_timeout(800)
    await ss(page, "q3_14_draft_end.png")

    if not round5_shot:
        await ss(page, "q3_13_mid_draft.png")

    final = await api_safe("GET", "/api/state")
    complete = final.get("is_complete", False) if final else False
    if not complete:
        issues.append("P1: Draft did not complete")

    record("TC2d Draft advance to completion", "FAIL" if issues else "PASS",
           f"picks_made={picks_made} complete={complete}", issues)


# ── TC3: Headlines banner ─────────────────────────────────────────────────────

async def tc3_headlines(page: Page):
    print("\n[TC3] Headlines banner")
    await page.goto(BASE_URL, wait_until="networkidle")
    await page.wait_for_timeout(800)

    issues = []

    toggle_info = await page.evaluate(
        "(() => { "
        "const sel = '.headlines-toggle, #btn-headlines, [data-action=\"headlines\"], "
        "button[aria-label*=\"\u65b0\u805e\"], button[aria-label*=\"\u982d\u689d\"]'; "
        "const el = document.querySelector(sel); "
        "if (!el) return {found: false}; "
        "const r = el.getBoundingClientRect(); "
        "return {found: true, w: r.width, h: r.height}; })()"
    )
    print(f"  headline toggle: {toggle_info}")

    if toggle_info.get("found"):
        w, h = toggle_info.get("w", 0), toggle_info.get("h", 0)
        if w < 44 or h < 44:
            issues.append(f"P3: Headlines toggle {w:.0f}x{h:.0f}px < 44x44")
        await js_click(page, ".headlines-toggle, #btn-headlines")
        await page.wait_for_timeout(600)
    else:
        print("  no dedicated headlines toggle found")

    await ss(page, "q3_15_headlines.png")

    ov = await measure_overflow(page)
    if ov["overflow"]:
        issues.append(f"P2: Horizontal overflow with headlines scrollW={ov['scrollW']}px")

    hl_count = await page.evaluate(
        "(() => document.querySelectorAll('.headline-item, .news-item, [class*=\"headline\"] li').length)()"
    )

    banner_h = await page.evaluate(
        "(() => { const el = document.querySelector('.headlines, .news-panel, .headline-list, [class*=\"headline\"]'); "
        "return el ? el.getBoundingClientRect().height : 0; })()"
    )
    if banner_h > 300:
        issues.append(f"P2: Headlines panel {banner_h:.0f}px tall — may block main content on 667px screen")

    record("TC3 Headlines banner", "FAIL" if issues else "PASS",
           f"toggle={toggle_info.get('found')} hl_count={hl_count} banner_h={banner_h:.0f}", issues)


# ── TC4: Season ───────────────────────────────────────────────────────────────

async def tc4_settings_modal(page: Page):
    print("\n[TC4a] Settings modal")
    await page.goto(BASE_URL, wait_until="networkidle")
    await page.wait_for_timeout(600)
    issues = []

    ham_info = await page.evaluate(
        "(() => { const el = document.querySelector('#btn-menu, .hamburger'); "
        "if (!el) return {found: false}; "
        "const r = el.getBoundingClientRect(); "
        "return {found: true, w: r.width, h: r.height}; })()"
    )
    if not ham_info.get("found"):
        issues.append("P1: Hamburger/settings button not found")
    else:
        w, h = ham_info.get("w", 0), ham_info.get("h", 0)
        if w < 44 or h < 44:
            issues.append(f"P2: Hamburger {w:.0f}x{h:.0f}px < 44x44px")

    await js_click(page, "#btn-menu")
    await page.wait_for_timeout(600)

    await ss(page, "q3_60_settings_modal.png")

    modal_info = await page.evaluate(
        "(() => { const el = document.querySelector('dialog[open], #dlg-settings'); "
        "if (!el) return {found: false}; "
        "const r = el.getBoundingClientRect(); "
        "return {found: true, w: r.width, h: r.height, isOpen: el.open}; })()"
    )
    if not modal_info.get("found") or not modal_info.get("isOpen"):
        issues.append("P2: Settings modal did not open")
    else:
        mw, mh = modal_info.get("w", 0), modal_info.get("h", 0)
        if mw > 375:
            issues.append(f"P1: Settings modal {mw:.0f}px wide > 375px viewport")
        if mh > 667:
            issues.append(f"P2: Settings modal {mh:.0f}px tall > 667px screen — not fully visible")

    ov = await measure_overflow(page)
    if ov["overflow"]:
        issues.append(f"P1: Horizontal overflow in settings modal scrollW={ov['scrollW']}px")

    tap_issues = await check_tap_targets(page, "dialog button, .settings-dialog button")
    for ti in tap_issues[:3]:
        issues.append(f"P3: Tap target: {ti}")

    record("TC4a Settings modal", "FAIL" if issues else "PASS",
           f"opened={modal_info.get('isOpen')} mw={modal_info.get('w',0):.0f} overflow={ov['overflow']}", issues)

    await js_click(page, "dialog[open] button[value='close']")
    await page.wait_for_timeout(400)


async def tc4_start_season(page: Page):
    print("\n[TC4b] Start season")
    issues = []

    res = await api_safe("POST", "/api/season/start")
    if res is None:
        res = await api_safe("POST", "/api/start-season")
    print(f"  season start: {res}")

    await page.goto(f"{BASE_URL}/#league", wait_until="networkidle")
    await page.wait_for_timeout(800)
    await ss(page, "q3_20_w01.png")

    ov = await measure_overflow(page)
    if ov["overflow"]:
        issues.append(f"P2: Horizontal overflow on league/week-1 page scrollW={ov['scrollW']}px")

    record("TC4b Week 1 league page", "FAIL" if issues else "PASS",
           f"season_started={res is not None} overflow={ov['overflow']}", issues)


async def tc4_advance_season(page: Page):
    print("\n[TC4c] Advance season weeks")
    issues = []
    week = 0
    w10_done = False

    for _ in range(22):
        res = await api_safe("POST", "/api/week/advance")
        if res is None:
            res = await api_safe("POST", "/api/advance-week")
        if res is None:
            print(f"  week advance failed at week {week}")
            break
        week += 1
        if week % 5 == 0:
            print(f"  week {week}")

        if week == 10 and not w10_done:
            await page.goto(f"{BASE_URL}/#league", wait_until="networkidle")
            await page.wait_for_timeout(600)
            await ss(page, "q3_21_w10.png")
            w10_done = True

    await page.goto(f"{BASE_URL}/#league", wait_until="networkidle")
    await page.wait_for_timeout(600)
    await ss(page, "q3_22_w20_end.png")

    if not w10_done:
        await ss(page, "q3_21_w10.png")

    # Playoffs
    po = await api_safe("POST", "/api/playoffs/start")
    if po is None:
        po = await api_safe("POST", "/api/sim-playoffs")
    print(f"  playoffs start: {po}")

    await page.goto(f"{BASE_URL}/#league", wait_until="networkidle")
    await page.wait_for_timeout(800)
    await ss(page, "q3_23_playoffs.png")

    for _ in range(3):
        adv = await api_safe("POST", "/api/playoffs/advance")
        if adv is None:
            adv = await api_safe("POST", "/api/week/advance")
        if adv:
            print(f"  playoff advance ok")

    await page.goto(f"{BASE_URL}/#league", wait_until="networkidle")
    await page.wait_for_timeout(800)
    await ss(page, "q3_24_champion.png")

    record("TC4c Season advance", "PASS", f"weeks_advanced={week}", issues)


# ── TC5: Trades ───────────────────────────────────────────────────────────────

async def tc5_trades(page: Page):
    print("\n[TC5] Trades panel")
    issues = []

    await page.goto(f"{BASE_URL}/#teams", wait_until="networkidle")
    await page.wait_for_timeout(800)

    await ss(page, "q3_30_trades.png")
    ov = await measure_overflow(page)
    if ov["overflow"]:
        issues.append(f"P2: Horizontal overflow on teams page scrollW={ov['scrollW']}px")

    # Look for trade items
    trade_count = await page.locator(".trade-item, .trade-row, .trade-card, .trade").count()
    print(f"  trade items: {trade_count}")

    if trade_count > 0:
        await js_click(page, ".trade-item, .trade-row, .trade-card")
        await page.wait_for_timeout(500)

    await ss(page, "q3_31_trade_detail.png")

    modal_info = await page.evaluate(
        "(() => { const el = document.querySelector('dialog[open]'); "
        "if (!el) return {found: false}; "
        "const r = el.getBoundingClientRect(); "
        "return {found: true, w: r.width, h: r.height}; })()"
    )
    if modal_info.get("found") and modal_info.get("w", 0) > 375:
        issues.append(f"P1: Trade detail modal {modal_info['w']:.0f}px wide > 375px viewport")

    record("TC5a Trades panel", "FAIL" if issues else "PASS",
           f"overflow={ov['overflow']} trade_items={trade_count}", issues)

    await js_click(page, "dialog[open] button[value='close']")
    await page.evaluate("(() => { const d = document.querySelector('dialog[open]'); if (d) d.close(); })()")
    await page.wait_for_timeout(300)


async def tc5b_propose_trade(page: Page):
    print("\n[TC5b] Propose trade flow")
    issues = []

    await page.goto(f"{BASE_URL}/#teams", wait_until="networkidle")
    await page.wait_for_timeout(600)

    # Find propose button (Chinese: 提議, 交易, 提出)
    propose_info = await page.evaluate(
        "(() => { "
        "const keywords = ['\u63d0\u8b70', '\u63d0\u51fa', 'Propose']; "
        "const btns = Array.from(document.querySelectorAll('button')); "
        "const found = btns.find(b => keywords.some(k => b.textContent.includes(k))); "
        "if (!found) return {found: false}; "
        "const r = found.getBoundingClientRect(); "
        "return {found: true, w: r.width, h: r.height}; })()"
    )
    print(f"  propose btn: {propose_info}")

    if not propose_info.get("found"):
        await ss(page, "q3_32_propose_mobile.png")
        await ss(page, "q3_33_propose_filled.png")
        record("TC5b Propose trade", "WARN", "No propose button found on teams page")
        return

    w, h = propose_info.get("w", 0), propose_info.get("h", 0)
    if w < 44 or h < 44:
        issues.append(f"P2: Propose button {w:.0f}x{h:.0f}px < 44x44px")

    # Click propose button via JS
    await page.evaluate(
        "(() => { "
        "const keywords = ['\u63d0\u8b70', '\u63d0\u51fa', 'Propose']; "
        "const btns = Array.from(document.querySelectorAll('button')); "
        "const found = btns.find(b => keywords.some(k => b.textContent.includes(k))); "
        "if (found) found.click(); })()"
    )
    await page.wait_for_timeout(600)
    await ss(page, "q3_32_propose_mobile.png")

    ov = await measure_overflow(page)
    if ov["overflow"]:
        issues.append(f"P1: Horizontal overflow in propose trade modal scrollW={ov['scrollW']}px — worst mobile case")

    modal_info = await page.evaluate(
        "(() => { const el = document.querySelector('dialog[open]'); "
        "if (!el) return {found: false}; "
        "const r = el.getBoundingClientRect(); "
        "return {found: true, w: r.width, h: r.height}; })()"
    )
    if modal_info.get("found") and modal_info.get("w", 0) > 375:
        issues.append(f"P1: Propose modal {modal_info['w']:.0f}px wide > 375px viewport")

    # Try select dropdown in modal
    sel_count = await page.locator("dialog[open] select, .trade-form select").count()
    if sel_count > 0:
        try:
            await page.locator("dialog[open] select").first.select_option(index=1)
            await page.wait_for_timeout(400)
        except Exception as e:
            print(f"  select failed: {safe(str(e))[:80]}")

    await ss(page, "q3_33_propose_filled.png")
    ov2 = await measure_overflow(page)
    if ov2["overflow"] and not ov["overflow"]:
        issues.append(f"P1: Overflow after filling propose form scrollW={ov2['scrollW']}px")

    record("TC5b Propose trade mobile", "FAIL" if issues else "PASS",
           f"propose_found=True modal={modal_info.get('found')} overflow={ov['overflow']}", issues)

    await js_click(page, "dialog[open] button[value='close']")
    await page.evaluate("(() => { const d = document.querySelector('dialog[open]'); if (d) d.close(); })()")
    await page.wait_for_timeout(300)


# ── TC6: Injuries ─────────────────────────────────────────────────────────────

async def tc6_injuries(page: Page):
    print("\n[TC6] Injuries panel")
    issues = []

    # Try FA page first, then others
    for route in ["#fa", "#teams", "#league", ""]:
        await page.goto(f"{BASE_URL}/{route}", wait_until="networkidle")
        await page.wait_for_timeout(400)
        inj = await page.locator(".injury, .injuries, [class*='injur'], .status-injured").count()
        if inj > 0:
            print(f"  injuries on route /{route}: {inj}")
            break

    await ss(page, "q3_40_injuries.png")

    ov = await measure_overflow(page)
    if ov["overflow"]:
        issues.append(f"P2: Horizontal overflow on injury page scrollW={ov['scrollW']}px")

    wrap_info = await page.evaluate(
        "(() => { const rows = document.querySelectorAll('.injury-row, .injury-item, [class*=\"injur\"]'); "
        "let clipped = 0; "
        "rows.forEach(r => { if (r.scrollWidth > r.clientWidth + 2) clipped++; }); "
        "return {total: rows.length, clipped}; })()"
    )
    if wrap_info.get("clipped", 0) > 0:
        issues.append(f"P3: {wrap_info['clipped']} injury rows overflow their container")

    font_sz = await page.evaluate(
        "(() => { const el = document.querySelector('.injury-row, .injury-item, td'); "
        "return el ? parseFloat(getComputedStyle(el).fontSize) : null; })()"
    )
    if font_sz and font_sz < 12:
        issues.append(f"P2: Injury text font {font_sz}px below 12px minimum")

    record("TC6 Injuries panel", "FAIL" if issues else "PASS",
           f"overflow={ov['overflow']} inj_rows={wrap_info.get('total',0)} clipped={wrap_info.get('clipped',0)} font={font_sz}px",
           issues)


# ── TC7: Standings ────────────────────────────────────────────────────────────

async def tc7_standings(page: Page):
    print("\n[TC7] Standings table")
    issues = []

    await page.goto(f"{BASE_URL}/#league", wait_until="networkidle")
    await page.wait_for_timeout(800)

    ov = await measure_overflow(page)
    await ss(page, "q3_50_standings.png")

    if ov["overflow"]:
        issues.append(f"P1: Horizontal scroll on standings page scrollW={ov['scrollW']}px — table breaks mobile layout")

    table_info = await page.evaluate(
        "(() => { const t = document.querySelector('table, .standings-table, .league-table'); "
        "if (!t) return {found: false}; "
        "const r = t.getBoundingClientRect(); "
        "return {found: true, w: r.width, scrollW: t.scrollWidth}; })()"
    )
    if table_info.get("found") and table_info.get("scrollW", 0) > 375:
        issues.append(
            f"P1: Standings table scrollWidth={table_info['scrollW']}px > 375px — "
            f"columns cut off or require horizontal scroll"
        )

    font_sz = await page.evaluate(
        "(() => { const el = document.querySelector('td, .standings-row, .team-row'); "
        "return el ? parseFloat(getComputedStyle(el).fontSize) : null; })()"
    )
    if font_sz and font_sz < 12:
        issues.append(f"P2: Standings font {font_sz}px below readable threshold")

    wrap_info = await page.evaluate(
        "(() => { const cells = document.querySelectorAll('td'); "
        "let wrapped = 0; "
        "cells.forEach(c => { "
        "const lh = parseFloat(getComputedStyle(c).lineHeight) || 20; "
        "if (c.getBoundingClientRect().height > lh * 1.5) wrapped++; "
        "}); "
        "return {total: cells.length, wrapped}; })()"
    )
    if wrap_info.get("wrapped", 0) > 0:
        issues.append(f"P2: {wrap_info['wrapped']} table cells wrap to multiple lines")

    record("TC7 Standings table", "FAIL" if issues else "PASS",
           f"overflow={ov['overflow']} table_scrollW={table_info.get('scrollW','n/a')} font={font_sz}px wraps={wrap_info.get('wrapped',0)}",
           issues)


# ── Main ──────────────────────────────────────────────────────────────────────

async def run_all():
    print("=" * 60)
    print("QA Mobile Test - iPhone SE 375x667")
    print(f"Target: {BASE_URL}")
    print("=" * 60)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        ctx = await browser.new_context(**IPHONE_SE)
        page = await ctx.new_page()
        page.set_default_timeout(15000)

        try:
            await tc1_landing(page)
            await tc2_draft(page)
            await tc2b_draft_scroll(page)
            await tc2c_human_pick(page)
            await tc2d_advance_draft(page)
            await tc3_headlines(page)
            await tc4_settings_modal(page)
            await tc4_start_season(page)
            await tc4_advance_season(page)
            await tc5_trades(page)
            await tc5b_propose_trade(page)
            await tc6_injuries(page)
            await tc7_standings(page)
        except Exception as e:
            import traceback
            tb = safe(traceback.format_exc())
            print(f"\n[FATAL] {safe(str(e))}")
            print(tb)
            record("FATAL ERROR", "FAIL", safe(str(e)))
        finally:
            await ctx.close()
            await browser.close()

    print("\n" + "=" * 60)
    print("RESULTS SUMMARY")
    print("=" * 60)
    passed = sum(1 for r in results if r["status"] == "PASS")
    failed = sum(1 for r in results if r["status"] == "FAIL")
    warned = sum(1 for r in results if r["status"] == "WARN")
    for r in results:
        icon = "PASS" if r["status"] == "PASS" else "FAIL" if r["status"] == "FAIL" else "WARN"
        print(f"  [{icon}] {r['name']}")
        for iss in r.get("issues", []):
            print(f"        {safe(iss)}")
    print(f"\nTotal: {len(results)} | Passed: {passed} | Failed: {failed} | Warned: {warned}")
    print("=" * 60)
    return results


if __name__ == "__main__":
    asyncio.run(run_all())
