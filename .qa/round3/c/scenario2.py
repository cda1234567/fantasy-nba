"""Round 3-C scenario v2 - robust, assuming round3-c already exists from previous attempt."""
import sys, io, time, json, traceback, re
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
    try:
        page.screenshot(path=f"{OUT}/{name}.png", full_page=True)
    except Exception as e:
        log(f"  [snap fail] {name}: {e}")

def body(page):
    try: return page.locator("body").inner_text()
    except: return ""

def switch_league(page, name):
    page.locator("button:has-text('聯盟')").first.click()
    time.sleep(0.6)
    # The league row button contains name text. Look for div containing the name then the wrapper button
    # aria-label on delete = "刪除聯盟 <name>"; on switch = (none). We need the switch-button.
    # Click the clickable label that has name but not a × delete
    all_btns = page.locator("button:visible").all()
    ok = False
    for b in all_btns:
        try:
            al = b.get_attribute("aria-label") or ""
            if "刪除" in al: continue
            txt = b.inner_text().strip()
            # Match full name line
            if name in txt and "×" not in txt and "+" not in txt and "建立" not in txt:
                b.click(timeout=3000)
                ok = True
                break
        except: continue
    time.sleep(1.5)
    # Close dropdown if still open
    try: page.keyboard.press("Escape")
    except: pass
    time.sleep(0.5)
    return ok

def ensure_league_exists(page, name):
    """Switch to it. If not found, create it."""
    page.locator("button:has-text('聯盟')").first.click()
    time.sleep(0.6)
    bd = body(page)
    if name in bd:
        log(f"  league '{name}' exists in dropdown")
    else:
        log(f"  league '{name}' NOT in dropdown, creating")
        page.locator("button:has-text('建立新聯盟')").first.click()
        time.sleep(0.6)
        inp = page.locator("input[placeholder*='season2']")
        inp.fill(name)
        time.sleep(0.2)
        page.locator("button:has-text('建立並切換')").click()
        time.sleep(2.5)
        return True
    # Click to switch
    all_btns = page.locator("button:visible").all()
    for b in all_btns:
        try:
            al = b.get_attribute("aria-label") or ""
            if "刪除" in al: continue
            txt = b.inner_text().strip()
            if name in txt and "×" not in txt and "建立" not in txt:
                b.click(timeout=3000)
                time.sleep(2)
                return True
        except: pass
    return False

def nav_to(page, label):
    try:
        page.get_by_role("button", name=label).first.click()
        time.sleep(1.2)
        return True
    except Exception as e:
        log(f"  nav_to({label}) failed: {e}")
        return False

def extract_draft_state(page):
    bd = body(page)
    m_ord = re.search(r"#\s*(\d+)", bd)
    m_completed = re.search(r"(\d+)\s*/\s*(\d+)\s*順位已完成", bd)
    m_round = re.search(r"第\s*(\d+)\s*輪\s*·\s*第\s*(\d+)\s*順", bd)
    who = None
    if "輪到你了" in bd: who = "YOU"
    else:
        m = re.search(r"輪到\s*([^\n]{1,30})", bd)
        if m: who = m.group(1).strip()
    # First 5 available players (rows with 選秀 buttons) by row position in table
    first5 = []
    try:
        rows = page.locator("table tr:has(button:has-text('選秀'))").all()[:5]
        for r in rows:
            tds = r.locator("td").all()
            if tds: first5.append(tds[0].inner_text().strip())
    except: pass
    return {
        "ord_num": m_ord.group(1) if m_ord else None,
        "completed": f"{m_completed.group(1)}/{m_completed.group(2)}" if m_completed else None,
        "round_pick": f"R{m_round.group(1)}P{m_round.group(2)}" if m_round else None,
        "who": who, "first5": first5,
    }

def click_first_available_draft(page):
    """Click 選秀 in a player-table row (NOT nav 選秀). Return (success, clicks, player)."""
    # Player rows are inside <tr> in a table. Filter to tr>td button
    rows = page.locator("table tbody tr:has(button:has-text('選秀'))").all()
    if not rows:
        return False, 0, None
    row = rows[0]
    try:
        tds = row.locator("td").all()
        player = tds[0].inner_text().strip() if tds else "?"
    except: player = "?"
    btn = row.locator("button:has-text('選秀')").first
    clicks = 0
    for attempt in range(5):
        clicks += 1
        try:
            btn.scroll_into_view_if_needed(timeout=2000)
            btn.click(timeout=3000)
        except Exception as e:
            log(f"    click err #{attempt+1}: {e}")
        time.sleep(0.8)
        # Check if the row for that player no longer has a 選秀 button
        try:
            still = page.locator(f"table tbody tr:has-text('{player}') button:has-text('選秀')").count()
            if still == 0:
                return True, clicks, player
        except: pass
    return False, clicks, player

def open_hamburger(page):
    btn = page.locator("button[aria-label='開啟設定']").first
    # may be hidden by other modal; try Escape first
    try: page.keyboard.press("Escape")
    except: pass
    time.sleep(0.3)
    btn.click(timeout=5000)
    time.sleep(0.8)

# ---------- MAIN ----------
pick_log = []
console_errs = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    # =============== PHASE 1 ================
    log("=== PHASE 1: load + use/create round3-c + start draft + 3 picks ===")
    ctx_a = browser.new_context(viewport={"width": 1400, "height": 900})
    page = ctx_a.new_page()
    page.on("console", lambda m: console_errs.append(f"{m.type}: {m.text}") if m.type in ("error",) else None)
    page.on("pageerror", lambda e: console_errs.append(f"pageerror: {e}"))

    page.goto(URL, wait_until="networkidle", timeout=30000)
    time.sleep(2)

    ensure_league_exists(page, LEAGUE)
    time.sleep(1)
    snap(page, "s2_p1_01_on_league")
    bd = body(page)
    log(f"  After switch body top: {bd[:250]!r}")
    if f"聯盟\n{LEAGUE}" in bd or f"round3-c" in bd.split("\n")[0:8].__str__():
        log(f"  PASS: switched to {LEAGUE}")

    # Check if in settings (new league) or already drafting
    if "聯盟設定" in bd or "開始選秀" in bd:
        log("  On settings page, clicking 開始選秀")
        try:
            page.locator("button:has-text('開始選秀'):visible").first.click()
            time.sleep(2)
        except Exception as e:
            log(f"  開始選秀 click failed: {e}")

    # Might redirect to draft page. Or nav there manually.
    nav_to(page, "選秀")
    time.sleep(1.5)
    snap(page, "s2_p1_02_draft_page")
    bd = body(page)
    log(f"  Draft page body (600): {bd[:600]!r}")

    state0 = extract_draft_state(page)
    log(f"  Initial state: {state0}")

    # If it's not human's turn yet, click "推進 AI 一手" or "⏭ 模擬到我" to get to human turn
    # Try to make 3 picks total (human turn)
    for attempt in range(3):
        st_before = extract_draft_state(page)
        who = st_before['who']
        log(f"  Pick {attempt+1} state_before: {st_before}")
        if who != "YOU":
            # try simulate-to-me
            try:
                sim_btn = page.locator("button:has-text('模擬到我'):visible").first
                if sim_btn.count() > 0:
                    sim_btn.click()
                    log("    clicked ⏭ 模擬到我")
                    time.sleep(5)
            except Exception as e:
                log(f"    sim_btn err: {e}")
        st_before = extract_draft_state(page)
        log(f"  Pick {attempt+1} state after sim: {st_before}")
        # Now try to click first available
        t0 = time.time()
        success, clicks, player = click_first_available_draft(page)
        elapsed = time.time() - t0
        st_after = extract_draft_state(page)
        log(f"    -> success={success} clicks={clicks} player={player!r} elapsed={elapsed:.1f}s after={st_after}")
        pick_log.append({"phase": 1, "attempt": attempt+1, "success": success, "clicks_needed": clicks,
                         "player": player, "who_before": who,
                         "completed_before": st_before['completed'], "completed_after": st_after['completed']})
        time.sleep(1)

    snap(page, "s2_p1_03_after_3_picks")
    state_p1 = extract_draft_state(page)
    log(f"  End of phase 1: {state_p1}")

    # =============== PHASE 2: close ctx, reopen ================
    log("\n=== PHASE 2: close ctx + reopen, verify persistence ===")
    saved = dict(state_p1)
    ctx_a.close()
    log("  Closed ctx A")

    ctx_b = browser.new_context(viewport={"width": 1400, "height": 900})
    page2 = ctx_b.new_page()
    page2.on("pageerror", lambda e: console_errs.append(f"pageerror(B): {e}"))
    page2.goto(URL, wait_until="networkidle", timeout=30000)
    time.sleep(2)
    snap(page2, "s2_p2_01_reopen")
    switch_league(page2, LEAGUE)
    snap(page2, "s2_p2_02_switched")
    nav_to(page2, "選秀")
    time.sleep(1.5)
    snap(page2, "s2_p2_03_draft_after_reload")
    state_reload = extract_draft_state(page2)
    log(f"  Reload state: {state_reload}")
    log(f"  Saved state:  {saved}")
    persist_completed = state_reload['completed'] == saved['completed']
    persist_first5 = state_reload['first5'] == saved['first5']
    log(f"  PERSIST completed match: {persist_completed} | first5 match: {persist_first5}")

    # =============== PHASE 3: 3 more picks ================
    log("\n=== PHASE 3: continue 3 picks ===")
    for attempt in range(3):
        st_before = extract_draft_state(page2)
        who = st_before['who']
        if who != "YOU":
            try:
                sim_btn = page2.locator("button:has-text('模擬到我'):visible").first
                if sim_btn.count() > 0:
                    sim_btn.click()
                    log(f"    clicked sim-to-me (before pick {attempt+1})")
                    time.sleep(5)
            except: pass
        st_before = extract_draft_state(page2)
        t0 = time.time()
        success, clicks, player = click_first_available_draft(page2)
        elapsed = time.time() - t0
        st_after = extract_draft_state(page2)
        log(f"  cont pick {attempt+1}: success={success} clicks={clicks} player={player} elapsed={elapsed:.1f}s before_compl={st_before['completed']} after_compl={st_after['completed']}")
        pick_log.append({"phase": 3, "attempt": attempt+1, "success": success, "clicks_needed": clicks,
                         "player": player, "who_before": who,
                         "completed_before": st_before['completed'], "completed_after": st_after['completed']})
        time.sleep(1)
    snap(page2, "s2_p3_01_after_continued")

    # =============== PHASE 4: 重置選秀 ================
    log("\n=== PHASE 4: 重置選秀 ===")
    # Accept dialogs
    def _accept_dialog(d):
        log(f"  dialog: {d.type} msg={d.message!r}")
        d.accept()
    page2.on("dialog", _accept_dialog)

    try:
        # Escape any modal first
        try: page2.keyboard.press("Escape")
        except: pass
        time.sleep(0.5)
        open_hamburger(page2)
        snap(page2, "s2_p4_01_hamburger")
        hbody = body(page2)
        log(f"  Hamburger body 1500: {hbody[:1500]!r}")
        # Find 重置選秀 button
        btn = page2.locator("button:has-text('重置選秀'):visible").first
        btn.click(timeout=5000)
        log("  clicked 重置選秀")
        time.sleep(3)
        snap(page2, "s2_p4_02_after_click")
        # Close dialog if open
        try: page2.keyboard.press("Escape")
        except: pass
        time.sleep(0.5)
    except Exception as e:
        log(f"  Phase 4 err: {type(e).__name__}: {e}")
        snap(page2, "s2_p4_err")

    # Nav to draft, check state
    nav_to(page2, "選秀")
    time.sleep(1.5)
    snap(page2, "s2_p4_03_draft_after_reset")
    reset_state = extract_draft_state(page2)
    log(f"  After reset state: {reset_state}")
    # Teams
    nav_to(page2, "隊伍")
    time.sleep(1.5)
    snap(page2, "s2_p4_04_teams_after_reset")
    tb = body(page2)
    log(f"  Teams body 1200: {tb[:1200]!r}")

    # =============== PHASE 5: Re-run with auto ================
    log("\n=== PHASE 5: re-run draft with auto ===")
    nav_to(page2, "選秀")
    time.sleep(1.5)
    snap(page2, "s2_p5_01_draft_start")
    bd = body(page2)
    log(f"  Draft body 600: {bd[:600]!r}")
    # Try find "開始選秀" or auto-pick-all
    auto_pressed = False
    for t in ["自動選秀全部", "全部自動", "一鍵選秀", "自動選秀到底", "自動填完", "自動完成"]:
        try:
            b = page2.locator(f"button:has-text('{t}'):visible").first
            if b.count() > 0:
                b.click()
                log(f"  clicked auto button: {t}")
                auto_pressed = True
                time.sleep(5)
                break
        except: pass
    if not auto_pressed:
        log("  no auto-all button; will loop 模擬到我 + click")
    # Drive to completion: repeat sim-to-me + pick
    t_start = time.time()
    max_s = 180
    picks_made = 0
    while time.time() - t_start < max_s:
        bd = body(page2)
        if "選秀完成" in bd or "所有順位已選完" in bd:
            log(f"  Draft complete after {picks_made} UI interventions, elapsed={time.time()-t_start:.0f}s")
            break
        # Check if my turn
        st = extract_draft_state(page2)
        if st['who'] == "YOU":
            ok, clicks, pl = click_first_available_draft(page2)
            if ok:
                picks_made += 1
                pick_log.append({"phase": 5, "attempt": picks_made, "success": True, "clicks_needed": clicks,
                                 "player": pl, "who_before": "YOU",
                                 "completed_before": st['completed'], "completed_after": extract_draft_state(page2)['completed']})
        else:
            # Not my turn - click simulate
            try:
                sim = page2.locator("button:has-text('模擬到我'):visible").first
                if sim.count() > 0:
                    sim.click()
                    time.sleep(6)
                else:
                    # Try 推進 AI 一手
                    ad = page2.locator("button:has-text('推進 AI'):visible").first
                    if ad.count() > 0: ad.click(); time.sleep(1.5)
            except: pass
    snap(page2, "s2_p5_02_draft_filled")
    log(f"  Fresh picks made by me: {picks_made}")

    # =============== PHASE 6: start season + advance 1 week ================
    log("\n=== PHASE 6: start season + advance ===")
    # click "前往聯盟" if present
    try:
        b = page2.locator("button:has-text('前往聯盟'):visible").first
        if b.count() > 0: b.click(); time.sleep(2); log("  clicked 前往聯盟")
    except: pass
    nav_to(page2, "聯盟")
    time.sleep(1.5)
    snap(page2, "s2_p6_01_league")
    bd = body(page2)
    log(f"  League body 1500: {bd[:1500]!r}")
    # Find start season
    started = False
    for t in ["開始賽季", "啟動賽季", "啟動"]:
        try:
            b = page2.locator(f"button:has-text('{t}'):visible").first
            if b.count() > 0:
                b.click(); time.sleep(3); log(f"  clicked {t}"); started = True; break
        except: pass
    snap(page2, "s2_p6_02_season_started")
    bd = body(page2)
    # find current_week text
    m_week = re.search(r"(?:第|Week)\s*(\d+)\s*週", bd)
    init_week = m_week.group(1) if m_week else None
    log(f"  initial_week text: {init_week} | body 1500: {bd[:1500]!r}")

    # advance
    advanced = False
    for t in ["下一週", "推進一週", "前進一週", "推進", "下週"]:
        try:
            b = page2.locator(f"button:has-text('{t}'):visible").first
            if b.count() > 0:
                b.click(); time.sleep(5); log(f"  clicked advance: {t}"); advanced = True; break
        except: pass
    snap(page2, "s2_p6_03_after_advance")
    bd = body(page2)
    m_week = re.search(r"(?:第|Week)\s*(\d+)\s*週", bd)
    after_adv_week = m_week.group(1) if m_week else None
    log(f"  after_advance week: {after_adv_week}")

    # =============== PHASE 7: 重置賽季 ================
    log("\n=== PHASE 7: 重置賽季 ===")
    try:
        open_hamburger(page2)
        snap(page2, "s2_p7_01_hamburger")
        hb = body(page2)
        log(f"  Hamburger body 2000: {hb[:2000]!r}")
        try:
            btn = page2.locator("button:has-text('重置賽季'):visible").first
            btn.click(timeout=5000)
            log("  clicked 重置賽季")
            time.sleep(3)
        except Exception as e:
            log(f"  reset-season click err: {e}")
        snap(page2, "s2_p7_02_after_click")
        try: page2.keyboard.press("Escape")
        except: pass
        time.sleep(0.5)
    except Exception as e:
        log(f"  Phase 7 err: {e}")
        snap(page2, "s2_p7_err")

    nav_to(page2, "聯盟")
    time.sleep(1.5)
    snap(page2, "s2_p7_03_league_after_reset")
    bd = body(page2)
    m_week = re.search(r"(?:第|Week)\s*(\d+)\s*週", bd)
    after_reset_week = m_week.group(1) if m_week else None
    log(f"  after_reset_season week_text: {after_reset_week} | body 2000: {bd[:2000]!r}")

    nav_to(page2, "隊伍")
    time.sleep(1.5)
    snap(page2, "s2_p7_04_teams_after_reset")
    tb = body(page2)
    log(f"  Teams after 重置賽季 (1500): {tb[:1500]!r}")

    # Console errors
    log("\n=== CONSOLE ERRORS ===")
    for e in console_errs[:40]:
        log(f"  {e}")

    log("\n=== PICK LOG ===")
    for p_ in pick_log:
        log(f"  {p_}")

    with open(f"{OUT}/raw_findings_v2.json","w",encoding="utf-8") as f:
        json.dump({"findings": findings, "pick_log": pick_log, "console_errs": console_errs}, f, ensure_ascii=False, indent=2)

    browser.close()
log("\n=== DONE ===")
