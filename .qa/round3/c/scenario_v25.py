"""Round 3-C v0.5.25 verification - UI-only, fresh league round3-c2."""
import sys, io, time, json, re
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

URL = "https://nbafantasy.cda1234567.com"
OUT = "D:/claude/fantasy nba/.qa/round3/c"
LEAGUE = "round3-c2"

findings = []
console_errs = []
pick_log = []

def log(m):
    print(m, flush=True); findings.append(m)

def snap(page, name):
    try: page.screenshot(path=f"{OUT}/{name}.png", full_page=True)
    except Exception as e: log(f"  [snap fail] {name}: {e}")

def body(page):
    try: return page.locator("body").inner_text()
    except: return ""

def get_state(page):
    bd = body(page)
    m_completed = re.search(r"(\d+)\s*/\s*(\d+)\s*順位已完成", bd)
    m_round = re.search(r"第\s*(\d+)\s*輪\s*·\s*第\s*(\d+)\s*順", bd)
    who = "YOU" if "輪到你了" in bd else None
    if not who:
        m = re.search(r"輪到\s*([^\n]{1,30})", bd)
        if m: who = m.group(1).strip()
    first5 = []
    try:
        rows = page.locator("table tbody tr:has(button:has-text('選秀'))").all()[:5]
        for r in rows:
            tds = r.locator("td").all()
            if tds: first5.append(tds[0].inner_text().strip())
    except: pass
    return {
        "completed": f"{m_completed.group(1)}/{m_completed.group(2)}" if m_completed else None,
        "round_pick": f"R{m_round.group(1)}P{m_round.group(2)}" if m_round else None,
        "who": who, "first5": first5,
    }

def dismiss_overlays(page):
    # Close any modal/menu
    for _ in range(3):
        try:
            page.keyboard.press("Escape")
            time.sleep(0.25)
        except: pass

def nav_to(page, label):
    dismiss_overlays(page)
    try:
        # Top nav buttons
        candidates = page.locator(f"button:has-text('{label}'):visible").all()
        for b in candidates:
            try:
                t = b.inner_text().strip()
                if t == label or t.endswith(label) or label in t[:6]:
                    b.click(timeout=3000)
                    time.sleep(1.2)
                    return True
            except: pass
        # Fallback get_by_role
        page.get_by_role("button", name=label).first.click(timeout=3000)
        time.sleep(1.2)
        return True
    except Exception as e:
        log(f"  nav_to({label}) failed: {e}")
        return False

def open_league_dropdown(page):
    dismiss_overlays(page)
    page.locator("button:has-text('聯盟')").first.click()
    time.sleep(0.7)

def ensure_league(page, name):
    """Create league if missing, switch to it. Returns True on success."""
    open_league_dropdown(page)
    bd = body(page)
    if name not in bd:
        log(f"  league '{name}' not in dropdown - creating")
        try:
            page.locator("button:has-text('建立新聯盟')").first.click()
            time.sleep(0.7)
            inp = page.locator("input[placeholder*='season']").first
            inp.fill(name)
            time.sleep(0.2)
            page.locator("button:has-text('建立並切換')").click()
            time.sleep(3.5)
            log(f"  created league '{name}'")
            return True
        except Exception as e:
            log(f"  create failed: {e}")
            return False
    # Switch (dropdown should still be open)
    for b in page.locator("button:visible").all():
        try:
            al = b.get_attribute("aria-label") or ""
            if "刪除" in al: continue
            t = b.inner_text().strip()
            if name in t and "×" not in t and "建立" not in t:
                b.click(timeout=3000)
                time.sleep(2)
                log(f"  switched to '{name}'")
                return True
        except: pass
    return False

def click_first_draft(page):
    """Click 選秀 button in first row. Return (success, clicks, elapsed_ms, player)."""
    rows = page.locator("table tbody tr:has(button:has-text('選秀'))").all()
    if not rows:
        return False, 0, 0, None
    row = rows[0]
    try:
        tds = row.locator("td").all()
        player = tds[0].inner_text().strip() if tds else "?"
    except: player = "?"
    btn = row.locator("button:has-text('選秀')").first
    t0 = time.time()
    clicks = 0
    for attempt in range(5):
        clicks += 1
        try:
            btn.scroll_into_view_if_needed(timeout=2000)
            btn.click(timeout=3000)
        except Exception as e:
            log(f"    click #{attempt+1} err: {e}")
        time.sleep(0.8)
        try:
            still = page.locator(f"table tbody tr:has-text(\"{player}\") button:has-text('選秀')").count()
            if still == 0:
                return True, clicks, int((time.time()-t0)*1000), player
        except: pass
    return False, clicks, int((time.time()-t0)*1000), player

def sim_to_me(page):
    try:
        b = page.locator("button:has-text('模擬到我'):visible").first
        if b.count() > 0:
            b.click()
            time.sleep(5)
            return True
    except Exception as e:
        log(f"  sim err: {e}")
    return False

def open_hamburger(page):
    dismiss_overlays(page)
    time.sleep(0.3)
    # Sometimes it's hidden if a modal is open; try force
    btn = page.locator("button[aria-label='開啟設定']").first
    try:
        btn.click(timeout=5000)
    except Exception as e:
        log(f"  hamburger click failed, retry force: {e}")
        dismiss_overlays(page)
        time.sleep(0.5)
        btn.click(timeout=5000, force=True)
    time.sleep(0.8)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    # ---- PHASE 1: fresh league + open draft ----
    log("=== PHASE 1: create/switch to round3-c2, enter draft ===")
    ctx_a = browser.new_context(viewport={"width": 1400, "height": 900})
    page = ctx_a.new_page()
    page.on("console", lambda m: console_errs.append(f"{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errs.append(f"pageerror(A): {e}"))

    page.goto(URL, wait_until="networkidle", timeout=30000)
    time.sleep(2)
    snap(page, "v25_p1_01_loaded")

    ensure_league(page, LEAGUE)
    time.sleep(1.5)
    snap(page, "v25_p1_02_after_switch")
    bd = body(page)
    log(f"  body top: {bd[:400]!r}")

    # Settings form if present
    if "聯盟設定" in bd and "開始選秀" in bd:
        log("  On settings page - clicking 送出/開始選秀")
        # Try to submit defaults then start
        for t in ["送出", "儲存", "開始選秀"]:
            try:
                b = page.locator(f"button:has-text('{t}'):visible").first
                if b.count() > 0:
                    b.click()
                    log(f"  clicked {t}")
                    time.sleep(2.5)
                    break
            except: pass
    elif "開始選秀" in bd:
        try:
            page.locator("button:has-text('開始選秀'):visible").first.click()
            time.sleep(2.5)
            log("  clicked 開始選秀")
        except Exception as e:
            log(f"  start draft err: {e}")

    nav_to(page, "選秀")
    time.sleep(1.5)
    snap(page, "v25_p1_03_draft_page")

    # ---- PHASE 2: draft click reliability ----
    log("\n=== PHASE 2: 5 picks, exactly 1 click each ===")
    for i in range(5):
        st = get_state(page)
        log(f"  Pick {i+1} state: {st}")
        if st['who'] != "YOU":
            log(f"    not my turn, simulating...")
            ok = sim_to_me(page)
            time.sleep(2)
            st = get_state(page)
            log(f"    after sim: {st}")
        if st['who'] != "YOU":
            log(f"    STILL not my turn, skip")
            pick_log.append({"phase": 2, "pick": i+1, "clicks": 0, "elapsed_ms": 0, "success": False, "player": None, "note": "not my turn"})
            continue
        success, clicks, elapsed_ms, player = click_first_draft(page)
        st_after = get_state(page)
        log(f"    -> success={success} clicks={clicks} elapsed={elapsed_ms}ms player={player!r} completed={st['completed']}->{st_after['completed']}")
        pick_log.append({"phase": 2, "pick": i+1, "clicks": clicks, "elapsed_ms": elapsed_ms, "success": success, "player": player,
                         "completed_before": st['completed'], "completed_after": st_after['completed']})
        time.sleep(1)

    snap(page, "v25_p2_01_after_5_picks")
    state_p2 = get_state(page)
    log(f"  End-of-phase-2 state: {state_p2}")

    # ---- PHASE 3: persistence across context reopen ----
    log("\n=== PHASE 3: close ctx, reopen, verify persistence ===")
    saved = dict(state_p2)
    ctx_a.close()
    log("  ctx A closed")

    ctx_b = browser.new_context(viewport={"width": 1400, "height": 900})
    page2 = ctx_b.new_page()
    page2.on("console", lambda m: console_errs.append(f"{m.type}(B): {m.text}") if m.type == "error" else None)
    page2.on("pageerror", lambda e: console_errs.append(f"pageerror(B): {e}"))
    page2.goto(URL, wait_until="networkidle", timeout=30000)
    time.sleep(2)
    snap(page2, "v25_p3_01_reopen")

    # Switch to round3-c2
    open_league_dropdown(page2)
    for b in page2.locator("button:visible").all():
        try:
            al = b.get_attribute("aria-label") or ""
            if "刪除" in al: continue
            t = b.inner_text().strip()
            if LEAGUE in t and "×" not in t and "建立" not in t:
                b.click(timeout=3000)
                time.sleep(2)
                log(f"  switched to {LEAGUE} in ctx B")
                break
        except: pass
    dismiss_overlays(page2)

    nav_to(page2, "選秀")
    time.sleep(2)
    snap(page2, "v25_p3_02_reload_draft")
    state_reload = get_state(page2)
    log(f"  reload state: {state_reload}")
    log(f"  saved state:  {saved}")
    persist_completed = state_reload['completed'] == saved['completed']
    log(f"  PERSIST completed match: {persist_completed}")

    # Continue drafting to completion (auto)
    log("\n  continue draft to completion via sim + click...")
    t_start = time.time()
    max_s = 180
    extra_picks = 0
    last_completed = state_reload['completed']
    stall_count = 0
    while time.time() - t_start < max_s:
        bd = body(page2)
        if "選秀完成" in bd or "所有順位已選完" in bd:
            log(f"  Draft complete after extra_picks={extra_picks} elapsed={time.time()-t_start:.0f}s")
            break
        st = get_state(page2)
        if st['completed'] == last_completed:
            stall_count += 1
        else:
            stall_count = 0
            last_completed = st['completed']
        if stall_count > 8:
            log(f"  stall detected at {st}")
            break
        if st['who'] == "YOU":
            ok, c, ms, pl = click_first_draft(page2)
            if ok:
                extra_picks += 1
                pick_log.append({"phase": 3, "pick": extra_picks, "clicks": c, "elapsed_ms": ms, "success": True, "player": pl,
                                 "completed_before": st['completed'], "completed_after": get_state(page2)['completed']})
        else:
            if not sim_to_me(page2):
                # Try 推進 AI 一手
                try:
                    b = page2.locator("button:has-text('推進 AI'):visible").first
                    if b.count() > 0: b.click(); time.sleep(1.5)
                except: pass
                time.sleep(1)
    snap(page2, "v25_p3_03_draft_done")
    final_state = get_state(page2)
    log(f"  final draft state: {final_state}")

    # ---- PHASE 4: 開始賽季 → advance → 重置賽季 → 重置選秀 ----
    log("\n=== PHASE 4: season + reset flow ===")

    def _on_dialog(d):
        log(f"  dialog: type={d.type} msg={d.message!r}")
        try: d.accept()
        except: pass
    page2.on("dialog", _on_dialog)

    # Maybe landed on "前往聯盟"
    try:
        b = page2.locator("button:has-text('前往聯盟'):visible").first
        if b.count() > 0:
            b.click(); time.sleep(2); log("  clicked 前往聯盟")
    except: pass

    nav_to(page2, "聯盟")
    time.sleep(1.5)
    snap(page2, "v25_p4_01_league")
    bd = body(page2)
    log(f"  league body (900): {bd[:900]!r}")

    # Start season
    started = False
    for t in ["開始賽季", "啟動賽季", "啟動"]:
        try:
            b = page2.locator(f"button:has-text('{t}'):visible").first
            if b.count() > 0:
                b.click(); time.sleep(3.5); log(f"  clicked {t}"); started = True; break
        except: pass
    snap(page2, "v25_p4_02_season_started")
    bd = body(page2)
    m_week = re.search(r"(?:第|Week)\s*(\d+)\s*週", bd)
    init_week = m_week.group(1) if m_week else None
    log(f"  started={started} init_week={init_week}")

    # Advance 1 week
    advanced = False
    for t in ["下一週", "推進一週", "前進一週", "推進", "下週"]:
        try:
            b = page2.locator(f"button:has-text('{t}'):visible").first
            if b.count() > 0:
                b.click(); time.sleep(6); log(f"  advanced via {t}"); advanced = True; break
        except: pass
    snap(page2, "v25_p4_03_after_advance")
    bd = body(page2)
    m_week = re.search(r"(?:第|Week)\s*(\d+)\s*週", bd)
    after_adv_week = m_week.group(1) if m_week else None
    log(f"  advanced={advanced} after_adv_week={after_adv_week}")

    # 重置賽季 via hamburger
    reset_season_ok = False
    try:
        dismiss_overlays(page2)
        open_hamburger(page2)
        snap(page2, "v25_p4_04_hamburger1")
        hb = body(page2)
        log(f"  hamburger body 1500: {hb[:1500]!r}")
        try:
            page2.locator("button:has-text('重置賽季'):visible").first.click(timeout=5000)
            log("  clicked 重置賽季")
            time.sleep(3)
            reset_season_ok = True
        except Exception as e:
            log(f"  reset season err: {e}")
        dismiss_overlays(page2)
    except Exception as e:
        log(f"  hamburger1 err: {e}")
        snap(page2, "v25_p4_04b_err")

    nav_to(page2, "聯盟")
    time.sleep(1.5)
    snap(page2, "v25_p4_05_after_reset_season")
    bd = body(page2)
    m_week = re.search(r"(?:第|Week)\s*(\d+)\s*週", bd)
    after_reset_week = m_week.group(1) if m_week else None
    log(f"  reset_season_click_ok={reset_season_ok} after_reset_week={after_reset_week}")

    # 重置選秀 via hamburger
    reset_draft_ok = False
    try:
        dismiss_overlays(page2)
        open_hamburger(page2)
        snap(page2, "v25_p4_06_hamburger2")
        try:
            page2.locator("button:has-text('重置選秀'):visible").first.click(timeout=5000)
            log("  clicked 重置選秀")
            time.sleep(4)
            reset_draft_ok = True
        except Exception as e:
            log(f"  reset draft err: {e}")
        dismiss_overlays(page2)
    except Exception as e:
        log(f"  hamburger2 err: {e}")
        snap(page2, "v25_p4_06b_err")

    nav_to(page2, "選秀")
    time.sleep(1.5)
    snap(page2, "v25_p4_07_draft_after_reset")
    st_after_reset = get_state(page2)
    log(f"  draft state after reset: {st_after_reset}")

    nav_to(page2, "隊伍")
    time.sleep(1.5)
    snap(page2, "v25_p4_08_teams_after_reset")
    tb = body(page2)
    log(f"  teams body 1000 after reset: {tb[:1000]!r}")

    # ---- Output ----
    log("\n=== CONSOLE ERRORS ===")
    for e in console_errs[:40]:
        log(f"  {e}")

    summary = {
        "version_confirmed": "0.5.25",
        "phase2_picks": [p for p in pick_log if p['phase'] == 2],
        "phase3_extra_picks_count": len([p for p in pick_log if p['phase'] == 3]),
        "saved_state_before_close": saved,
        "state_after_reload": state_reload,
        "persist_completed_match": state_reload['completed'] == saved['completed'],
        "final_draft_state": final_state,
        "started": started, "init_week": init_week,
        "advanced": advanced, "after_adv_week": after_adv_week,
        "reset_season_clicked": reset_season_ok, "after_reset_week": after_reset_week,
        "reset_draft_clicked": reset_draft_ok, "draft_state_after_reset": st_after_reset,
        "console_err_count": len(console_errs),
    }
    log("\n=== SUMMARY ===")
    log(json.dumps(summary, ensure_ascii=False, indent=2))

    with open(f"{OUT}/raw_findings_v25.json", "w", encoding="utf-8") as f:
        json.dump({"findings": findings, "pick_log": pick_log, "console_errs": console_errs, "summary": summary}, f, ensure_ascii=False, indent=2)

    browser.close()
log("\n=== DONE ===")
