"""Round 3 Pair A - Autonomous QA for Fantasy NBA.

Scenario: Injury storm + empty-lineup edge cases.
Target: https://nbafantasy.cda1234567.com (v0.5.24)
League: round3-a

HARD RULE: All actions via UI. No API calls.
"""
from __future__ import annotations

import json
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout, Page

BASE = "https://nbafantasy.cda1234567.com"
LEAGUE_ID = "round3-a"
OUT = Path(r"D:\claude\fantasy nba\.qa\round3\a")
SHOTS = OUT / "screenshots"
SHOTS.mkdir(parents=True, exist_ok=True)

FINDINGS: list[dict] = []
TIMELINE: list[dict] = []


def stamp() -> str:
    return datetime.now().strftime("%H:%M:%S")


def log(msg: str) -> None:
    line = f"[{stamp()}] {msg}"
    print(line, flush=True)
    TIMELINE.append({"t": stamp(), "msg": msg})


def shot(page: Page, name: str) -> str:
    path = SHOTS / f"{name}.png"
    try:
        page.screenshot(path=str(path), full_page=False)
        log(f"screenshot -> {path.name}")
    except Exception as e:
        log(f"screenshot FAILED for {name}: {e}")
    return str(path)


def add_bug(severity: str, title: str, repro: list[str], screenshots: list[str]) -> None:
    FINDINGS.append({
        "severity": severity,
        "title": title,
        "repro": repro,
        "screenshots": screenshots,
    })
    log(f"BUG [{severity}] {title}")


def wait_ready(page: Page, timeout: int = 15000) -> None:
    page.wait_for_load_state("networkidle", timeout=timeout)


def click_if_visible(page: Page, selector: str, timeout: int = 3000) -> bool:
    try:
        loc = page.locator(selector).first
        loc.wait_for(state="visible", timeout=timeout)
        loc.click()
        return True
    except Exception:
        return False


def get_current_week(page: Page) -> int | None:
    """Parse hero region for current week number if present."""
    try:
        # hero-phase or similar - try aria/text patterns
        txt = page.locator(".hero-phase, .league-hero").first.inner_text(timeout=1500)
        import re
        m = re.search(r"第\s*(\d+)\s*週", txt)
        if m:
            return int(m.group(1))
    except Exception:
        pass
    # Fallback: look anywhere on page
    try:
        body = page.locator("body").inner_text(timeout=1500)
        import re
        m = re.search(r"第\s*(\d+)\s*週", body)
        if m:
            return int(m.group(1))
    except Exception:
        pass
    return None


def dismiss_any_dialog(page: Page) -> None:
    # Close open <dialog>s by pressing Escape
    try:
        page.keyboard.press("Escape")
        time.sleep(0.25)
    except Exception:
        pass


def run() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900}, locale="zh-TW")
        page = ctx.new_page()
        page.set_default_timeout(10000)

        # Capture console + page errors for bug evidence
        console_lines: list[str] = []
        page.on("console", lambda m: console_lines.append(f"{m.type}: {m.text}"))
        page.on("pageerror", lambda e: console_lines.append(f"PAGEERROR: {e}"))

        try:
            log(f"GET {BASE}/")
            page.goto(BASE + "/", wait_until="domcontentloaded", timeout=30000)
            wait_ready(page, 20000)
            shot(page, "01-landing")

            version = None
            try:
                version = page.locator("#app-version").inner_text(timeout=3000)
                log(f"version banner: {version}")
            except Exception:
                log("version banner not found")

            # --- Step 3: Create new league via UI ---
            log("open league switcher")
            if not click_if_visible(page, "#btn-league-switch"):
                log("league switcher button not visible, retry via hamburger")
                click_if_visible(page, "#btn-menu")
                time.sleep(0.5)
                dismiss_any_dialog(page)
                click_if_visible(page, "#btn-league-switch")

            time.sleep(0.4)
            shot(page, "02-league-switcher-open")

            log("click + 建立新聯盟 in switcher menu")
            if not click_if_visible(page, "#btn-lsw-new", timeout=4000):
                # Try alternative: click button with matching text
                try:
                    page.get_by_text("建立新聯盟", exact=False).first.click(timeout=3000)
                except Exception as e:
                    add_bug("blocker", "Cannot open 建立新聯盟 dialog from league switcher",
                            ["click #btn-league-switch", "click #btn-lsw-new or 建立新聯盟 entry"],
                            [shot(page, "blocker-open-new-league")])
                    raise

            time.sleep(0.5)
            shot(page, "03-new-league-dialog")

            log(f"type league id '{LEAGUE_ID}'")
            page.locator("#new-league-id").fill(LEAGUE_ID)
            shot(page, "04-new-league-typed")

            log("click 建立並切換")
            page.locator("#btn-new-league-create").click()
            time.sleep(2.0)
            wait_ready(page, 15000)
            shot(page, "05-after-create-league")

            # Confirm league switched
            try:
                cur = page.locator("#lsw-current").inner_text(timeout=3000)
                log(f"current league label: {cur!r}")
                if LEAGUE_ID not in cur:
                    add_bug("major", f"League switch UI label did not update to {LEAGUE_ID} (shows {cur!r})",
                            ["create league round3-a via dialog", "observe #lsw-current"],
                            [shot(page, "major-lsw-mismatch")])
            except Exception:
                log("could not read #lsw-current")

            # --- Step 5: open draft ---
            log("navigate to 選秀 (draft)")
            page.goto(BASE + "/#draft", wait_until="domcontentloaded")
            time.sleep(1.5)
            wait_ready(page, 10000)
            shot(page, "06-draft-initial")

            # Check setup form vs active draft
            has_setup_submit = page.locator("#btn-setup-submit").count() > 0
            if has_setup_submit:
                log("draft setup form present, submit defaults")
                try:
                    page.locator("#btn-setup-submit").click()
                    time.sleep(2.5)
                    wait_ready(page, 12000)
                    shot(page, "07-after-setup-submit")
                except Exception as e:
                    add_bug("major", f"Clicking 開始選秀 failed: {e}",
                            ["go to #draft", "click #btn-setup-submit"],
                            [shot(page, "major-setup-click")])

            # Run the draft: repeatedly click "模擬到我" (sim until my turn),
            # and if it's my turn, pick the top available player.
            log("start drafting loop")
            draft_rounds = 0
            max_iters = 200
            for i in range(max_iters):
                draft_rounds += 1
                # If complete banner is visible, break
                try:
                    if page.locator(".draft-hero.complete").count() > 0:
                        log("draft complete banner detected")
                        break
                except Exception:
                    pass

                # See if it's the user's turn
                you_turn = page.locator(".draft-hero.you-turn").count() > 0
                if you_turn:
                    # Pick the first available player in the "剩餘球員" list.
                    # Look for any pick/draft button in the available pool.
                    log(f"[iter {i}] your turn -- attempting to pick first player")
                    picked = False
                    # Try common button selectors for picking
                    selectors = [
                        "button:has-text('選擇')",
                        "button:has-text('選這位')",
                        "button:has-text('選取')",
                        "button.btn:has-text('選')",
                        ".draft-pool button.btn",
                        ".pool-row button.btn",
                        "button[data-action='pick']",
                    ]
                    for sel in selectors:
                        try:
                            btns = page.locator(sel)
                            n = btns.count()
                            if n > 0:
                                btns.first.click(timeout=3000)
                                picked = True
                                log(f"picked via selector {sel}")
                                time.sleep(1.0)
                                break
                        except Exception:
                            continue
                    if not picked:
                        # fallback: click first "推進 AI 一手" -- but that's disabled when isYou.
                        # Try to click any row button on draft page
                        try:
                            page.locator("main#main-view button.btn").first.click(timeout=2000)
                            picked = True
                            log("picked via generic main button.btn fallback")
                            time.sleep(1.0)
                        except Exception:
                            add_bug("major", "Cannot find 選擇 button when it is user's turn in draft",
                                    ["create league", "open #draft", "when isYou, look for pick button"],
                                    [shot(page, f"major-no-pick-btn-iter{i}")])
                            # Try to auto-advance by clicking sim-to-me (will likely fail because disabled, but try)
                            click_if_visible(page, "button:has-text('模擬到我')", 1500)
                            time.sleep(1.0)
                else:
                    # AI turn -- click 模擬到我
                    clicked_sim = False
                    for sel in [
                        "button:has-text('模擬到我')",
                        "button:has-text('⏭ 模擬到我')",
                        "button:has-text('推進 AI 一手')",
                    ]:
                        try:
                            loc = page.locator(sel).first
                            if loc.is_enabled(timeout=800):
                                loc.click(timeout=2500)
                                clicked_sim = True
                                log(f"[iter {i}] clicked {sel}")
                                time.sleep(1.5)
                                break
                        except Exception:
                            continue
                    if not clicked_sim:
                        # might already be complete
                        if page.locator(".draft-hero.complete").count() > 0:
                            break
                        log(f"[iter {i}] no AI-advance button clickable, stopping draft loop")
                        break

                # Safety: check again for complete banner every few iters
                if i % 5 == 0:
                    try:
                        if page.locator(".draft-hero.complete").count() > 0:
                            log("draft complete (mid-loop check)")
                            break
                    except Exception:
                        pass

            shot(page, "08-draft-end")

            # --- Step 6: 開始賽季 via 設定 ---
            log("open settings dialog (hamburger)")
            click_if_visible(page, "#btn-menu", timeout=5000)
            time.sleep(0.5)
            shot(page, "09-settings-dialog")

            log("click 開始賽季")
            season_started = click_if_visible(page, "#btn-season-start", timeout=5000)
            if not season_started:
                add_bug("blocker", "Cannot click 開始賽季 button in settings",
                        ["open hamburger", "click #btn-season-start"],
                        [shot(page, "blocker-season-start")])
            time.sleep(1.5)

            # If a confirm dialog appears, click 確定
            try:
                if page.locator("#dlg-confirm[open]").count() > 0:
                    page.locator("#confirm-ok").click(timeout=3000)
                    log("confirmed season start")
                    time.sleep(1.5)
            except Exception:
                pass

            dismiss_any_dialog(page)
            time.sleep(1.5)
            wait_ready(page, 15000)
            shot(page, "10-season-started")

            # --- Step 7: advance weeks, observe injuries ---
            log("navigate to #league to drive the season")
            page.goto(BASE + "/#league", wait_until="domcontentloaded")
            time.sleep(2.0)
            wait_ready(page, 10000)

            week_numbers: list[int | None] = []
            injury_counts: list[int] = []

            for w in range(8):
                wk = get_current_week(page)
                week_numbers.append(wk)
                log(f"[wk loop {w}] current_week={wk}")

                # check injuries on teams page
                page.goto(BASE + "/#teams", wait_until="domcontentloaded")
                time.sleep(1.5)
                try:
                    body_txt = page.locator("main#main-view").inner_text(timeout=3000)
                    import re
                    injury_markers = len(re.findall(r"🤕|受傷|傷停|DAY-TO-DAY|OUT", body_txt))
                    injury_counts.append(injury_markers)
                    log(f"teams page injury-marker count approx={injury_markers}")
                except Exception:
                    injury_counts.append(-1)
                shot(page, f"11-teams-wk{w}")

                # back to league to advance
                page.goto(BASE + "/#league", wait_until="domcontentloaded")
                time.sleep(1.2)

                # click 推進一週
                clicked = False
                for sel in [
                    "button:has-text('推進一週')",
                    "button:has-text('進入下一週')",
                    "button:has-text('下一週')",
                ]:
                    try:
                        loc = page.locator(sel).first
                        if loc.count() > 0 and loc.is_enabled(timeout=800):
                            loc.click(timeout=3000)
                            clicked = True
                            log(f"[wk loop {w}] clicked advance via {sel}")
                            break
                    except Exception:
                        continue
                if not clicked:
                    log(f"[wk loop {w}] no advance button (maybe playoffs/end)")
                    break

                # wait for advance to complete
                time.sleep(3.5)
                wait_ready(page, 12000)

            shot(page, "12-after-weeks")

            # --- Step 8d: rage-click test (single-flight lock) ---
            log("rage-click 推進一週 x5 to test single-flight lock")
            page.goto(BASE + "/#league", wait_until="domcontentloaded")
            time.sleep(1.5)

            wk_before = get_current_week(page)
            log(f"week BEFORE rage-click: {wk_before}")
            shot(page, "13-rage-before")

            rage_errors = 0
            advance_sel = "button:has-text('推進一週')"
            try:
                btn = page.locator(advance_sel).first
                if btn.count() == 0:
                    log("advance button missing -- may have reached playoffs")
                else:
                    for k in range(5):
                        try:
                            btn.click(timeout=1500, no_wait_after=True)
                            log(f"rage click {k+1} sent")
                        except Exception as e:
                            rage_errors += 1
                            log(f"rage click {k+1} err: {e}")
            except Exception as e:
                log(f"rage setup err: {e}")

            # Wait for single advance to finish
            time.sleep(6.0)
            wait_ready(page, 15000)
            wk_after = get_current_week(page)
            log(f"week AFTER rage-click: {wk_after}")
            shot(page, "14-rage-after")

            if wk_before is not None and wk_after is not None:
                delta = wk_after - wk_before
                log(f"week delta = {delta}")
                if delta > 1:
                    add_bug("major",
                            f"Rage-click advance-week DOUBLE-advanced: before={wk_before} after={wk_after} (delta={delta})",
                            ["go to #league", "click 推進一週 5 times rapidly"],
                            [str(SHOTS / "13-rage-before.png"), str(SHOTS / "14-rage-after.png")])
                else:
                    log(f"single-flight lock appears to work (delta={delta})")
            else:
                log("could not compute week delta -- week parsing returned None")

            # --- Step 8a & 8c: injured drop + FA add ---
            log("navigate #teams to attempt drop on injured")
            page.goto(BASE + "/#teams", wait_until="domcontentloaded")
            time.sleep(2.0)
            shot(page, "15-teams-for-drop")

            injured_drop_attempted = False
            try:
                # Look for rows flagged with injury markers
                rows = page.locator(":is(tr,li,div):has-text('🤕')")
                nrows = rows.count()
                log(f"injured-marker elements on page: {nrows}")
                if nrows > 0:
                    # Try clicking a 釋出/drop/放棄 button near the first injured
                    for sel in [
                        ":is(tr,li,div):has-text('🤕') >> button:has-text('釋出')",
                        ":is(tr,li,div):has-text('🤕') >> button:has-text('丟棄')",
                        ":is(tr,li,div):has-text('🤕') >> button:has-text('放棄')",
                        "button:has-text('釋出')",
                    ]:
                        try:
                            b = page.locator(sel).first
                            if b.count() > 0 and b.is_visible():
                                b.click(timeout=2500)
                                injured_drop_attempted = True
                                log(f"drop attempted via {sel}")
                                time.sleep(1.0)
                                # confirm dialog if any
                                try:
                                    if page.locator("#dlg-confirm[open]").count() > 0:
                                        page.locator("#confirm-ok").click(timeout=2000)
                                        log("confirmed drop")
                                        time.sleep(1.0)
                                except Exception:
                                    pass
                                break
                        except Exception:
                            continue
                if not injured_drop_attempted:
                    log("no injured-player drop button found (either no injuries or UI hides control)")
            except Exception as e:
                log(f"injured-drop search err: {e}")

            shot(page, "16-after-drop-attempt")

            # FA add
            log("navigate #fa to attempt add free-agent")
            page.goto(BASE + "/#fa", wait_until="domcontentloaded")
            time.sleep(2.0)
            shot(page, "17-fa-page")

            fa_add_attempted = False
            for sel in [
                "button:has-text('簽約')",
                "button:has-text('簽下')",
                "button:has-text('加入')",
                "button:has-text('+ 加入')",
                "button:has-text('簽')",
            ]:
                try:
                    b = page.locator(sel).first
                    if b.count() > 0 and b.is_visible():
                        b.click(timeout=2500)
                        fa_add_attempted = True
                        log(f"FA add clicked via {sel}")
                        time.sleep(1.0)
                        # Handle drop-in-exchange dialog if any
                        try:
                            # The FA workflow may require picking a drop player
                            # Click primary button in dialog to proceed
                            page.locator("#dlg-confirm[open] #confirm-ok").click(timeout=2000)
                            log("confirmed FA sign")
                        except Exception:
                            try:
                                page.locator(".dialog[open] button.btn.primary").first.click(timeout=1500)
                            except Exception:
                                pass
                        time.sleep(1.0)
                        break
                except Exception:
                    continue
            if not fa_add_attempted:
                log("no FA sign button found on FA page")
            shot(page, "18-after-fa-add")

            # --- Step 8b: empty-lineup edge case ---
            # Try to advance week again after roster mutations
            log("attempt advance-week again after roster manipulation")
            page.goto(BASE + "/#league", wait_until="domcontentloaded")
            time.sleep(1.5)
            wk_pre = get_current_week(page)
            clicked = False
            for sel in [
                "button:has-text('推進一週')",
                "button:has-text('進入下一週')",
            ]:
                try:
                    loc = page.locator(sel).first
                    if loc.count() > 0 and loc.is_enabled(timeout=800):
                        loc.click(timeout=3000)
                        clicked = True
                        log(f"post-mutation advance via {sel}")
                        break
                except Exception:
                    continue
            time.sleep(4.0)
            wk_post = get_current_week(page)
            log(f"post-mutation week: pre={wk_pre} post={wk_post}")
            shot(page, "19-post-mutation")

            # record summary info
            SUMMARY = {
                "version_banner": version,
                "week_sequence": week_numbers,
                "injury_markers_per_iter": injury_counts,
                "rage_click_week_before": wk_before,
                "rage_click_week_after": wk_after,
                "rage_click_errors": rage_errors,
                "injured_drop_attempted": injured_drop_attempted,
                "fa_add_attempted": fa_add_attempted,
                "post_mutation_week_pre": wk_pre,
                "post_mutation_week_post": wk_post,
                "console_tail": console_lines[-40:],
            }
            (OUT / "summary.json").write_text(json.dumps(SUMMARY, ensure_ascii=False, indent=2), encoding="utf-8")
            log("wrote summary.json")

        except Exception as e:
            log(f"FATAL: {e}")
            log(traceback.format_exc())
            try:
                shot(page, "FATAL")
            except Exception:
                pass
            add_bug("blocker", f"Test run crashed: {e}",
                    ["see traceback in player.md"],
                    [str(SHOTS / "FATAL.png")])
        finally:
            # Write report
            try:
                write_report()
            except Exception as e:
                print(f"write_report fail: {e}", flush=True)
            try:
                browser.close()
            except Exception:
                pass


def write_report() -> None:
    report_path = OUT / "player.md"
    blocker = sum(1 for b in FINDINGS if b["severity"] == "blocker")
    major = sum(1 for b in FINDINGS if b["severity"] == "major")
    minor = sum(1 for b in FINDINGS if b["severity"] == "minor")
    overall = "PASS" if (blocker == 0 and major == 0) else "FAIL"

    summary_obj = {}
    sp = OUT / "summary.json"
    if sp.exists():
        try:
            summary_obj = json.loads(sp.read_text(encoding="utf-8"))
        except Exception:
            pass

    lines: list[str] = []
    lines.append("# Round 3 - Pair A - Player Report")
    lines.append("")
    lines.append(f"- **Target**: {BASE}")
    lines.append(f"- **Scenario**: Injury storm + empty-lineup edge cases")
    lines.append(f"- **League ID**: `{LEAGUE_ID}`")
    lines.append(f"- **Run at**: {datetime.now().isoformat(timespec='seconds')}")
    lines.append(f"- **Overall status**: **{overall}**  (blocker={blocker}, major={major}, minor={minor})")
    if summary_obj.get("version_banner"):
        lines.append(f"- **Version banner**: {summary_obj['version_banner']}")
    lines.append("")
    lines.append("## Steps executed (UI-only)")
    lines.append("")
    for t in TIMELINE:
        lines.append(f"- `{t['t']}` {t['msg']}")
    lines.append("")

    lines.append("## Bugs found")
    lines.append("")
    if not FINDINGS:
        lines.append("_No bugs surfaced under this scenario._")
    else:
        for i, b in enumerate(FINDINGS, 1):
            lines.append(f"### {i}. [{b['severity'].upper()}] {b['title']}")
            lines.append("")
            lines.append("**Reproduction:**")
            for r in b["repro"]:
                lines.append(f"- {r}")
            if b["screenshots"]:
                lines.append("")
                lines.append("**Screenshots:**")
                for s in b["screenshots"]:
                    lines.append(f"- `{s}`")
            lines.append("")

    lines.append("## UX friction items")
    lines.append("")
    friction_lines: list[str] = []
    # Always log rage-click evidence
    if summary_obj:
        before = summary_obj.get("rage_click_week_before")
        after = summary_obj.get("rage_click_week_after")
        delta = None
        if isinstance(before, int) and isinstance(after, int):
            delta = after - before
        friction_lines.append(f"- Rage-click single-flight evidence: week before=`{before}` after=`{after}` delta=`{delta}` (5 rapid clicks on 推進一週)")
        friction_lines.append(f"- Week sequence observed: {summary_obj.get('week_sequence')}")
        friction_lines.append(f"- Injury marker counts per iter (🤕/受傷/OUT approx): {summary_obj.get('injury_markers_per_iter')}")
        friction_lines.append(f"- Injured-drop button found in UI: {summary_obj.get('injured_drop_attempted')}")
        friction_lines.append(f"- Free-agent add attempted: {summary_obj.get('fa_add_attempted')}")
    if not friction_lines:
        friction_lines.append("_no UX friction data captured_")
    lines.extend(friction_lines)
    lines.append("")

    lines.append("## Did rage-click advance-week double-advance?")
    lines.append("")
    if summary_obj:
        before = summary_obj.get("rage_click_week_before")
        after = summary_obj.get("rage_click_week_after")
        if isinstance(before, int) and isinstance(after, int):
            delta = after - before
            if delta <= 1:
                lines.append(f"**NO** - single-flight lock held. before={before}, after={after}, delta={delta}.")
            else:
                lines.append(f"**YES (BUG)** - before={before}, after={after}, delta={delta}.")
        else:
            lines.append(f"**UNDETERMINED** - could not parse current week (before={before}, after={after}).")
    else:
        lines.append("**UNDETERMINED** - no summary recorded.")
    lines.append("")

    lines.append("## Artifact paths")
    lines.append("")
    lines.append(f"- Screenshots: `{SHOTS}`")
    lines.append(f"- Raw summary: `{sp}`")

    report_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"report written -> {report_path}", flush=True)


if __name__ == "__main__":
    run()
