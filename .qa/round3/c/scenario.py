"""Full Round 3-C QA Scenario - Mid-draft interruption + reload + reset flows."""
import sys, io, time, json, traceback
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

URL = "https://nbafantasy.cda1234567.com"
OUT = "D:/claude/fantasy nba/.qa/round3/c"
LEAGUE = "round3-c"

findings = []
def log(msg):
    print(msg, flush=True)
    findings.append(msg)

def snap(page, name):
    path = f"{OUT}/{name}.png"
    try:
        page.screenshot(path=path, full_page=True)
        log(f"  [screenshot] {path}")
    except Exception as e:
        log(f"  [screenshot FAIL] {name}: {e}")

def get_body_text(page):
    try:
        return page.locator("body").inner_text()
    except: return ""

def switch_to_league(page, name):
    """Open dropdown, click league by name."""
    page.locator("button:has-text('聯盟')").first.click()
    time.sleep(0.6)
    # Click the league row (not the × delete). Use has-text but avoid aria-label.
    # The league button contains the name as text.
    btns = page.locator(f"button:has-text('{name}')").all()
    clicked = False
    for b in btns:
        al = b.get_attribute("aria-label") or ""
        if "刪除" in al: continue
        if not b.is_visible(): continue
        try:
            b.click()
            clicked = True
            break
        except: pass
    time.sleep(1)
    return clicked

def create_league(page, name):
    page.locator("button:has-text('聯盟')").first.click()
    time.sleep(0.5)
    page.locator("button:has-text('建立新聯盟')").first.click()
    time.sleep(0.6)
    inp = page.locator("input[placeholder*='season2']")
    inp.fill(name)
    time.sleep(0.2)
    page.locator("button:has-text('建立並切換')").click()
    time.sleep(2)

def go_to_draft(page):
    # Nav to draft
    draft_nav = page.locator("nav button:has-text('選秀'), button:has-text('選秀'):has-text('D')").first
    try:
        # Try nav link with "D" shortcut indicator
        page.get_by_role("button", name="選秀").first.click(timeout=3000)
    except:
        try: page.locator("text=選秀").first.click()
        except: pass
    time.sleep(1)

def get_current_picker_info(page):
    """Read the draft top-info card to extract current pick number + picker name."""
    body = get_body_text(page)
    # Snippet of first 1500 chars
    return body[:2000]

def count_draft_picks_on_page(page):
    """Count rows on draft board that have been picked."""
    # The draft page shows remaining players with 選秀 buttons, plus history of picks.
    # We'll use the 剩餘球員 vs picked count.
    try:
        # Count 選秀 buttons still present
        remaining = page.locator("button:has-text('選秀'):visible").count()
        return remaining
    except: return -1

def click_first_available_draft(page):
    """Click the first visible 選秀 button on the draft board.
    Returns (success, clicks_needed, player_name)."""
    # Find first 選秀 button that is enabled
    buttons = page.locator("button:has-text('選秀'):visible").all()
    for b in buttons:
        try:
            if not b.is_enabled(): continue
            # Skip nav buttons (shouldn't have 'D' text)
            txt = b.inner_text().strip()
            if txt != "選秀": continue
            # Try to find player name from parent row
            row = b.locator("xpath=ancestor::tr").first
            try: player_name = row.locator("td").first.inner_text().strip()
            except: player_name = "<unknown>"
            # Click and measure
            clicks = 0
            for attempt in range(5):
                clicks += 1
                try:
                    b.click(timeout=3000)
                except Exception as ce:
                    log(f"    click attempt {attempt+1} raised: {ce}")
                time.sleep(0.5)
                # Check if button disappeared (pick succeeded) or row gone
                try:
                    if not b.is_visible() or not b.is_enabled():
                        return True, clicks, player_name
                except:
                    return True, clicks, player_name
                # If still there, retry
            return False, clicks, player_name
        except Exception as e:
            log(f"   click_first err: {e}")
            continue
    return False, 0, None

def extract_draft_state(page):
    """Extract pick count, current picker, and a snapshot of first 5 available players."""
    body = get_body_text(page)
    # Find pick number like "第 N 順位"
    import re
    m_pick = re.search(r"第\s*(\d+)\s*順位", body)
    m_total = re.search(r"(\d+)\s*/\s*(\d+)", body)
    pick_num = m_pick.group(1) if m_pick else None
    # Find current picker - often shown as "現在輪到 TEAM"
    m_who = re.search(r"(?:輪到|現在|當前選秀)[^\n]{0,50}", body)
    who = m_who.group(0) if m_who else None
    # First 5 available players (rows with 選秀 buttons)
    rows = page.locator("tr:has(button:has-text('選秀'))").all()[:5]
    first5 = []
    for r in rows:
        try:
            tds = r.locator("td").all()
            nm = tds[0].inner_text().strip() if tds else ""
            first5.append(nm)
        except: pass
    return {"pick_num": pick_num, "who": who, "first5": first5, "body_snippet": body[:800]}

def open_hamburger(page):
    btn = page.locator("button[aria-label='開啟設定']").first
    btn.click()
    time.sleep(0.8)

def find_and_click_button(page, text, timeout=3000):
    """Find visible button by text contains; try click."""
    btn = page.locator(f"button:has-text('{text}'):visible").first
    btn.click(timeout=timeout)
    time.sleep(0.6)

def accept_dialog(page):
    """Accept the next dialog."""
    page.once("dialog", lambda d: d.accept())

# ---------- MAIN ----------
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    # --------- Phase 1: context A, create league, start draft, make 2-3 picks ---------
    log("=== PHASE 1: create league + start draft + 2-3 picks ===")
    ctx_a = browser.new_context(viewport={"width": 1400, "height": 900})
    page = ctx_a.new_page()

    # Capture console errors
    console_errs = []
    page.on("console", lambda m: console_errs.append(f"{m.type}: {m.text}") if m.type in ("error","warning") else None)
    page.on("pageerror", lambda e: console_errs.append(f"pageerror: {e}"))

    page.goto(URL, wait_until="networkidle", timeout=30000)
    time.sleep(2)

    try:
        create_league(page, LEAGUE)
        snap(page, "p1_01_league_created")
        body = get_body_text(page)
        log(f"After create, top of body: {body[:400]!r}")
        if LEAGUE in body:
            log(f"PASS: League '{LEAGUE}' created and visible in UI")
        else:
            log(f"FAIL: League name not visible after create")
    except Exception as e:
        log(f"FAIL create_league: {e}\n{traceback.format_exc()}")
        snap(page, "p1_err_create")

    # Navigate to draft page
    try:
        page.get_by_role("button", name="選秀").first.click()
        time.sleep(1.5)
        snap(page, "p1_02_draft_page")
    except Exception as e:
        log(f"Nav to draft failed: {e}")

    # Start draft: look for button
    body = get_body_text(page)
    log(f"Draft page body first 500: {body[:500]!r}")
    # Potential start buttons
    for start_txt in ["開始選秀", "開始", "Start Draft", "啟動選秀"]:
        try:
            b = page.locator(f"button:has-text('{start_txt}'):visible").first
            if b.count() > 0 and b.is_visible():
                b.click()
                log(f"  clicked start button: {start_txt}")
                time.sleep(2)
                break
        except: pass
    snap(page, "p1_03_draft_started")

    # Extract initial state
    state0 = extract_draft_state(page)
    log(f"Initial draft state: pick={state0['pick_num']} who={state0['who']} first5={state0['first5']}")

    # Make 2-3 picks. For each, measure click reliability.
    pick_log = []  # list of (pick_num_before, player, clicks_used, success)
    for i in range(3):
        state_before = extract_draft_state(page)
        log(f"--- Pick attempt {i+1}, state.pick_num={state_before['pick_num']}, who={state_before['who']}")
        # If current picker is not human, AI auto-picks and we just wait.
        # Check if any 選秀 button in player table is enabled
        t0 = time.time()
        success, clicks, player = click_first_available_draft(page)
        elapsed = time.time() - t0
        state_after = extract_draft_state(page)
        log(f"   -> success={success} clicks={clicks} player={player} elapsed={elapsed:.1f}s pick_after={state_after['pick_num']}")
        pick_log.append({"round": i+1, "success": success, "clicks": clicks, "player": player,
                          "pick_before": state_before['pick_num'], "pick_after": state_after['pick_num']})
        time.sleep(1)
        # If AI turn, wait a bit and let AI pick
        if not success:
            log("   pick button didn't engage; waiting 3s in case AI turn")
            time.sleep(3)

    snap(page, "p1_04_after_3_picks")
    picks_state = extract_draft_state(page)
    log(f"State after 3 picks: pick={picks_state['pick_num']} first5={picks_state['first5']}")

    # --------- Phase 2: CLOSE context A, open context B, verify persistence ---------
    log("\n=== PHASE 2: close context + reload in new context ===")
    saved_pick = picks_state['pick_num']
    saved_first5 = picks_state['first5']

    ctx_a.close()
    log("  Closed context A")

    ctx_b = browser.new_context(viewport={"width": 1400, "height": 900})
    page2 = ctx_b.new_page()
    page2.on("pageerror", lambda e: console_errs.append(f"pageerror(ctxB): {e}"))
    page2.goto(URL, wait_until="networkidle", timeout=30000)
    time.sleep(2)
    snap(page2, "p2_01_reopen")

    # Switch to round3-c
    clicked = switch_to_league(page2, LEAGUE)
    log(f"  switched to league: {clicked}")
    time.sleep(2)
    snap(page2, "p2_02_switched")

    # Nav to draft
    try:
        page2.get_by_role("button", name="選秀").first.click()
        time.sleep(1.5)
    except: pass
    snap(page2, "p2_03_draft_after_reload")

    state_reload = extract_draft_state(page2)
    log(f"Reloaded state: pick={state_reload['pick_num']} who={state_reload['who']} first5={state_reload['first5']}")
    # Compare
    persist_ok = True
    if state_reload['pick_num'] != saved_pick:
        log(f"  PERSIST FAIL: pick_num before close={saved_pick}, after reload={state_reload['pick_num']}")
        persist_ok = False
    else:
        log(f"  PERSIST OK: pick_num={saved_pick}")
    if state_reload['first5'] != saved_first5:
        log(f"  PERSIST WARN/FAIL: first5 before={saved_first5}, after={state_reload['first5']}")
        # this might be OK if AI picked between close/reopen, check overlap
    else:
        log(f"  PERSIST OK: first5 list matches")

    # --------- Phase 3: continue drafting 3 more picks ---------
    log("\n=== PHASE 3: continue drafting 3 more picks ===")
    for i in range(3):
        state_before = extract_draft_state(page2)
        success, clicks, player = click_first_available_draft(page2)
        state_after = extract_draft_state(page2)
        log(f"  continued pick {i+1}: success={success} clicks={clicks} player={player} before={state_before['pick_num']} after={state_after['pick_num']}")
        pick_log.append({"round": f"cont-{i+1}", "success": success, "clicks": clicks, "player": player,
                         "pick_before": state_before['pick_num'], "pick_after": state_after['pick_num']})
        time.sleep(1)
    snap(page2, "p3_01_after_continued_picks")

    # --------- Phase 4: 重置選秀 via hamburger ---------
    log("\n=== PHASE 4: 重置選秀 via hamburger ===")
    page2.on("dialog", lambda d: (log(f"  dialog: {d.type} {d.message!r}"), d.accept()))
    try:
        open_hamburger(page2)
        snap(page2, "p4_01_hamburger_open")
        hbody = get_body_text(page2)
        log(f"Hamburger body (1500 chars): {hbody[:1500]!r}")
        # Find 重置選秀 button
        try:
            btn = page2.locator("button:has-text('重置選秀'):visible").first
            btn.click()
            log("  clicked 重置選秀")
            time.sleep(2)
        except Exception as e:
            log(f"  FAIL finding 重置選秀: {e}")
        snap(page2, "p4_02_after_reset_draft")
    except Exception as e:
        log(f"  Phase 4 err: {e}")

    # Navigate to draft page to verify cleared
    try:
        # Close hamburger first if still open
        try: page2.keyboard.press("Escape")
        except: pass
        time.sleep(0.5)
        page2.get_by_role("button", name="選秀").first.click()
        time.sleep(1.5)
    except: pass
    reset_state = extract_draft_state(page2)
    log(f"After reset: pick={reset_state['pick_num']} first5={reset_state['first5']}")
    # Check teams empty - navigate to teams tab
    try:
        page2.get_by_role("button", name="隊伍").first.click()
        time.sleep(1.5)
        snap(page2, "p4_03_teams_after_reset")
        teams_body = get_body_text(page2)
        log(f"Teams after reset (first 1200): {teams_body[:1200]!r}")
    except Exception as e:
        log(f"  Teams nav err: {e}")

    # --------- Phase 5: Re-run draft fresh with auto-pick ---------
    log("\n=== PHASE 5: Re-run draft + auto-pick ===")
    try:
        page2.get_by_role("button", name="選秀").first.click()
        time.sleep(1.5)
    except: pass
    snap(page2, "p5_01_draft_fresh")
    body = get_body_text(page2)
    log(f"Draft-fresh body first 600: {body[:600]!r}")
    # Find auto-pick all button
    auto_clicked = False
    for t in ["自動選秀全部", "全部自動", "全部選秀", "一鍵完成", "自動完成", "自動選秀到底", "自動選秀"]:
        try:
            btn = page2.locator(f"button:has-text('{t}'):visible").first
            if btn.count() > 0:
                btn.click()
                log(f"  clicked auto-pick button: {t}")
                auto_clicked = True
                time.sleep(5)
                break
        except: pass
    if not auto_clicked:
        log("  No obvious auto-pick-all button; looking at all visible buttons in header area")
        # Search all visible buttons
        for b in page2.locator("button:visible").all()[:50]:
            try:
                txt = b.inner_text().strip()
                if "自動" in txt or "一鍵" in txt:
                    log(f"   candidate: {txt!r}")
            except: pass
    snap(page2, "p5_02_after_auto_attempt")

    # Keep clicking 選秀 on available buttons until draft complete OR hit time limit
    t_start = time.time()
    max_seconds = 180
    picks_made = 0
    while time.time() - t_start < max_seconds:
        body = get_body_text(page2)
        if "選秀完成" in body or "所有順位已選完" in body:
            log(f"  Draft complete after {picks_made} UI picks")
            break
        # Try click
        success, clicks, player = click_first_available_draft(page2)
        if success:
            picks_made += 1
            if picks_made % 10 == 0:
                log(f"  picked {picks_made} players so far, elapsed {time.time()-t_start:.0f}s")
        else:
            # Maybe AI turn - wait
            time.sleep(2)
    snap(page2, "p5_03_draft_filled")
    log(f"  Fresh draft picks made: {picks_made}")

    # --------- Phase 6: Start season, verify, advance 1 week ---------
    log("\n=== PHASE 6: Start season + advance week ===")
    # Look for 前往聯盟 or 開始賽季 button
    try:
        b = page2.locator("button:has-text('前往聯盟'):visible").first
        if b.count() > 0:
            b.click()
            time.sleep(1.5)
            log("  clicked 前往聯盟")
    except: pass
    try:
        page2.get_by_role("button", name="聯盟").first.click()
        time.sleep(1.5)
    except: pass
    snap(page2, "p6_01_league_page")
    body = get_body_text(page2)
    log(f"League page first 1000: {body[:1000]!r}")

    # Find 開始賽季 or similar
    for t in ["開始賽季", "啟動賽季", "開始季度"]:
        try:
            b = page2.locator(f"button:has-text('{t}'):visible").first
            if b.count() > 0 and b.is_visible():
                b.click()
                log(f"  clicked {t}")
                time.sleep(2)
                break
        except: pass
    snap(page2, "p6_02_season_started")

    # Record initial week
    body = get_body_text(page2)
    import re
    m = re.search(r"(?:第|Week|賽程週|週)\s*(\d+)\s*週?", body)
    initial_week = m.group(1) if m else None
    log(f"  initial_week text match: {initial_week}")
    # Look for "current_week" value in detail
    log(f"League page after season start (first 1500): {body[:1500]!r}")

    # Advance 1 week
    for t in ["下一週", "推進一週", "前進一週", "推進", "Next Week", "下週", "進入下一週"]:
        try:
            b = page2.locator(f"button:has-text('{t}'):visible").first
            if b.count() > 0 and b.is_visible():
                b.click()
                log(f"  clicked advance button: {t}")
                time.sleep(3)
                break
        except: pass
    snap(page2, "p6_03_advanced_1_week")
    body = get_body_text(page2)
    m = re.search(r"(?:第|Week|賽程週|週)\s*(\d+)\s*週?", body)
    after_advance_week = m.group(1) if m else None
    log(f"  after_advance week: {after_advance_week}")
    log(f"League page after advance (first 1500): {body[:1500]!r}")

    # --------- Phase 7: 重置賽季 via hamburger ---------
    log("\n=== PHASE 7: 重置賽季 ===")
    try:
        open_hamburger(page2)
        snap(page2, "p7_01_hamburger_open")
        hbody = get_body_text(page2)
        log(f"Hamburger body (2000 chars): {hbody[:2000]!r}")
        try:
            btn = page2.locator("button:has-text('重置賽季'):visible").first
            btn.click()
            log("  clicked 重置賽季")
            time.sleep(3)
        except Exception as e:
            log(f"  FAIL finding 重置賽季: {e}")
        snap(page2, "p7_02_after_reset_season")
    except Exception as e:
        log(f"  Phase 7 err: {e}")

    try: page2.keyboard.press("Escape")
    except: pass
    time.sleep(0.5)

    # Check current_week display
    try:
        page2.get_by_role("button", name="聯盟").first.click()
        time.sleep(1.5)
    except: pass
    snap(page2, "p7_03_league_after_reset")
    body = get_body_text(page2)
    m = re.search(r"(?:第|Week|賽程週|週)\s*(\d+)\s*週?", body)
    after_reset_week = m.group(1) if m else None
    log(f"  after_reset week text: {after_reset_week}")
    log(f"League page after reset season (first 2000): {body[:2000]!r}")

    # Check if rosters preserved
    try:
        page2.get_by_role("button", name="隊伍").first.click()
        time.sleep(1.5)
        snap(page2, "p7_04_teams_after_reset_season")
        tb = get_body_text(page2)
        log(f"Teams after 重置賽季 (first 1500): {tb[:1500]!r}")
    except Exception as e:
        log(f"  teams nav err: {e}")

    # Dump console errors
    log("\n=== CONSOLE ERRORS ===")
    for e in console_errs[:50]:
        log(f"  {e}")

    # Dump pick log
    log("\n=== PICK LOG ===")
    for p_ in pick_log:
        log(f"  {p_}")

    # Save JSON
    with open(f"{OUT}/raw_findings.json", "w", encoding="utf-8") as f:
        json.dump({"findings": findings, "pick_log": pick_log, "console_errs": console_errs}, f, ensure_ascii=False, indent=2)

    browser.close()

log("\n=== DONE ===")
