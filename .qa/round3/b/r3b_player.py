"""
Round 3 Pair B player-agent QA script
Scenario: Free-agent depletion + rapid add/drop rage-clicking
Target: https://nbafantasy.cda1234567.com (v0.5.24)
UI-only — no direct /api/* calls except observational read-only state snapshots
"""
import asyncio
import json
import os
import re
import time
from pathlib import Path
from playwright.async_api import async_playwright, TimeoutError as PWTimeout

BASE = "https://nbafantasy.cda1234567.com"
LEAGUE_ID = "round3-b"
OUT_DIR = Path(r"D:\claude\fantasy nba\.qa\round3\b")
SHOT_DIR = OUT_DIR / "screenshots"
SHOT_DIR.mkdir(parents=True, exist_ok=True)

findings = []
shot_idx = 0


def log(msg):
    ts = time.strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    findings.append(line)
    print(line, flush=True)


async def snap(page, label):
    global shot_idx
    shot_idx += 1
    name = f"r3b_{shot_idx:02d}_{label}.png"
    try:
        await page.screenshot(path=str(SHOT_DIR / name), full_page=True)
    except Exception as e:
        log(f"screenshot fail {label}: {e}")
    return name


async def api_peek(page, path):
    """Observational read-only fetch — not an action, just a peek at server state."""
    return await page.evaluate(
        """async (p) => {
            try {
                const r = await fetch(p, {credentials:'include'});
                return {status: r.status, body: await r.text()};
            } catch (e) {
                return {status: 0, body: String(e)};
            }
        }""",
        path,
    )


async def safe_click(loc, label="btn", timeout=3000):
    try:
        await loc.click(timeout=timeout)
        return True
    except Exception as e:
        log(f"click fail [{label}]: {e}")
        return False


async def ensure_league(page):
    await page.goto(f"{BASE}/", wait_until="domcontentloaded")
    await page.wait_for_timeout(2500)
    await snap(page, "landing")

    # Click league switcher
    sw = page.locator("#btn-league-switch")
    await sw.wait_for(state="visible", timeout=15000)
    await sw.click()
    await page.wait_for_timeout(500)
    await snap(page, "lsw_menu")

    existing = page.locator(f'#league-switch-menu [data-league="{LEAGUE_ID}"]').first
    if await existing.count():
        log(f"league {LEAGUE_ID} already exists — switching")
        await existing.click()
        await page.wait_for_timeout(2500)
        return "reused"

    # Look for a "新增" / "建立" link in switcher menu
    new_link = page.locator("#league-switch-menu").locator(
        "button, a"
    ).filter(has_text=re.compile("新|建立|new", re.I)).first
    if await new_link.count():
        await new_link.click()
    else:
        # fallback: force-open dialog via DOM
        await page.evaluate(
            "() => { const d = document.getElementById('dlg-new-league'); if (d && d.showModal) d.showModal(); }"
        )
    await page.wait_for_timeout(500)
    await snap(page, "new_league_dialog")

    await page.locator("#new-league-id").fill(LEAGUE_ID)
    await page.locator("#btn-new-league-create").click()
    await page.wait_for_timeout(3500)
    await snap(page, "after_create")
    return "created"


async def complete_setup(page):
    # Navigate to setup view (route)
    # Setup may auto-appear on new league; try to find submit
    await page.wait_for_timeout(1500)
    await snap(page, "setup_default")
    submit = page.locator("#btn-setup-submit")
    if await submit.count():
        if await submit.is_disabled():
            log("setup submit disabled — setup already locked/complete")
            return False
        await submit.click()
        await page.wait_for_timeout(3500)
        await snap(page, "setup_submitted")
        log("setup submitted — proceeding to draft")
        return True
    log("no setup form visible — may already be past setup")
    return False


async def draft_all(page):
    await page.goto(f"{BASE}/#draft", wait_until="domcontentloaded")
    await page.wait_for_timeout(2500)
    await snap(page, "draft_start")

    for i in range(250):
        complete = await page.locator(".draft-hero.complete").count()
        if complete:
            log(f"draft complete at iter {i}")
            break

        sim = page.locator('button:has-text("模擬到我")').first
        if await sim.count() and not await sim.is_disabled():
            await safe_click(sim, "模擬到我")
            await page.wait_for_timeout(3000)
            continue

        # My turn — pick first available
        pick = page.locator('#tbl-available button[data-draft]:not([disabled])').first
        if not await pick.count():
            pick = page.locator('button[data-draft]:not([disabled])').first
        if await pick.count():
            await safe_click(pick, "pick")
            await page.wait_for_timeout(1000)
            continue

        adv = page.locator('button:has-text("推進 AI 一手")').first
        if await adv.count() and not await adv.is_disabled():
            await safe_click(adv, "推進AI")
            await page.wait_for_timeout(1500)
            continue

        await page.wait_for_timeout(1000)

    await snap(page, "draft_final")
    done = await page.locator(".draft-hero.complete").count()
    log(f"draft_done={done > 0}")
    return done > 0


async def start_season(page):
    # Open settings dialog via hamburger
    await page.goto(f"{BASE}/#league", wait_until="domcontentloaded")
    await page.wait_for_timeout(1500)
    # First try the 開始賽季 button on league empty-state
    btn = page.locator('button:has-text("開始賽季")').first
    if await btn.count():
        await btn.click()
        await page.wait_for_timeout(1500)
        # confirm
        confirm = page.locator('#confirm-ok, button:has-text("確定"), button:has-text("開始")').last
        if await confirm.count():
            await safe_click(confirm, "confirm_start")
            await page.wait_for_timeout(4000)
        await snap(page, "season_started_via_league")
        log("season started via #league button")
        return True

    # Fallback: settings dialog
    await page.locator("#btn-menu").click()
    await page.wait_for_timeout(500)
    await snap(page, "settings_dialog")
    start_btn = page.locator("#btn-season-start")
    if await start_btn.count():
        await start_btn.click()
        await page.wait_for_timeout(1500)
        confirm = page.locator('#confirm-ok').first
        if await confirm.count():
            await confirm.click()
            await page.wait_for_timeout(4000)
        await snap(page, "season_started_via_settings")
        log("season started via settings dialog")
        return True
    log("P0: cannot find start-season button")
    return False


async def goto_fa(page):
    await page.goto(f"{BASE}/#fa", wait_until="domcontentloaded")
    await page.wait_for_timeout(2500)


async def goto_teams(page):
    await page.goto(f"{BASE}/#teams", wait_until="domcontentloaded")
    await page.wait_for_timeout(2000)


async def get_my_roster_snapshot(page):
    return await page.evaluate(
        """async () => {
            const st = await fetch('/api/state',{credentials:'include'}).then(r=>r.json());
            const hid = st.teams?.find(t => t.is_human)?.id ?? 0;
            const td = await fetch('/api/teams/'+hid,{credentials:'include'}).then(r=>r.json());
            return { human_id: hid, roster: td.players||[], slots: td.lineup_slots||[], bench: td.bench||[], totals: td.totals||{} };
        }"""
    )


async def count_fa_in_ui(page):
    return await page.locator("#tbl-fa tbody tr").count()


async def rage_click_fa_pickup(page, rounds=10):
    """Scenario 5: pick up / drop rapidly. Double-click single 加入 button per player."""
    dup_events = []
    for r in range(rounds):
        await goto_fa(page)
        # Try first available sign button
        sign_btn = page.locator("button.btn-sign").first
        if not await sign_btn.count():
            log(f"round {r}: no sign button available")
            break
        pid = await sign_btn.get_attribute("data-player-id")
        # Rage click: click 3 times rapidly before dialog can appear
        try:
            await sign_btn.click(click_count=1)
            await sign_btn.click(click_count=1, timeout=500)
            await sign_btn.click(click_count=1, timeout=500)
        except Exception:
            pass
        await page.wait_for_timeout(400)

        # Count open confirm dialogs (should be 1, not 3)
        open_dialogs = await page.locator('#dlg-confirm[open]').count()
        log(f"round {r} pid={pid} — open_dialog_count={open_dialogs}")
        if open_dialogs > 1:
            dup_events.append({"round": r, "pid": pid, "open_dialogs": open_dialogs})

        # Select first drop radio if dialog open
        dlg = page.locator("#dlg-confirm")
        if await dlg.get_attribute("open") is not None or await page.locator("#dlg-confirm input[name='drop-pid']").count():
            radio = page.locator("#dlg-confirm input[name='drop-pid']").first
            if await radio.count():
                await radio.check()
                await snap(page, f"sign_dlg_r{r}")
                ok = page.locator("#confirm-ok")
                # Rage: double-click confirm to test double-submit
                try:
                    await ok.click()
                    await ok.click(timeout=300)
                except Exception:
                    pass
                await page.wait_for_timeout(2500)

        # Check quota
        quota_txt = await page.locator("#fa-quota-box").text_content()
        log(f"round {r} quota: {(quota_txt or '').strip()}")
        # If quota exhausted, stop
        if "0 / 3" in (quota_txt or "") or "0 /" in (quota_txt or ""):
            log(f"quota exhausted at round {r}")
            break

    return dup_events


async def drop_all_starters_via_fa(page):
    """
    Scenario 6: Make my team drop its starters.
    Drop = sign a scrub FA while selecting a starter to release.
    UI forces add+drop bundling, so we can simulate "dropping all starters"
    by claiming 10 cheap FAs while releasing 10 starters (within quota limits).
    """
    snap_before = await get_my_roster_snapshot(page)
    starters_before = [s["player_id"] for s in snap_before["slots"] if s.get("player_id")]
    log(f"starters_before_drop({len(starters_before)}): {starters_before}")

    await snap(page, "roster_before_scrub_swap")

    # Claim sequence to swap as many starters as quota allows.
    # We'll try 5 claims; quota is 3/day per findings so expect quota gate on 4th.
    claims_attempted = 0
    claims_successful = 0
    quota_gate_observed = False
    for i in range(6):
        await goto_fa(page)
        # find lowest-fppg FA (scrub) — filter sort desc, take last page bottom
        # Easier: just click first available sign button (default sort)
        sign_btn = page.locator("button.btn-sign").first
        if not await sign_btn.count():
            log(f"no FA to claim at iter {i}")
            break
        pid = await sign_btn.get_attribute("data-player-id")
        await sign_btn.click()
        await page.wait_for_timeout(700)
        # Pick the FIRST radio (lowest-fppg starter typically)
        radios = page.locator("#dlg-confirm input[name='drop-pid']")
        if not await radios.count():
            log(f"iter {i}: no drop radios shown")
            await page.keyboard.press("Escape")
            continue
        await radios.first.check()
        drop_pid = await radios.first.get_attribute("value")
        claims_attempted += 1
        log(f"claim {i}: add_pid={pid} drop_pid={drop_pid}")
        await page.locator("#confirm-ok").click()
        await page.wait_for_timeout(3000)

        # Peek at quota toast / remaining
        quota_txt = (await page.locator("#fa-quota-box").text_content() or "").strip()
        log(f"iter {i} quota_after={quota_txt}")
        # look for error toast
        toasts = await page.locator(".toast-stack .toast, #toast-stack .toast, [role='alert']").all_text_contents()
        for t in toasts:
            if t.strip():
                log(f"iter {i} toast: {t.strip()[:120]}")
        if any("配額" in t or "用完" in t or "已達" in t or "limit" in t.lower() for t in toasts):
            quota_gate_observed = True
            log(f"QUOTA GATE hit at iter {i}")
            break
        claims_successful += 1

    await snap(page, "roster_after_scrub_swap")
    snap_after = await get_my_roster_snapshot(page)
    starters_after = [s["player_id"] for s in snap_after["slots"] if s.get("player_id")]
    log(f"starters_after({len(starters_after)}): {starters_after}")
    log(f"claims_attempted={claims_attempted} successful={claims_successful} quota_gate={quota_gate_observed}")

    # Does lineup still fill 10 slots?
    filled = sum(1 for s in snap_after["slots"] if s.get("player_id"))
    total = len(snap_after["slots"])
    log(f"lineup fill after scrub swap: {filled} / {total}")
    return {
        "claims_attempted": claims_attempted,
        "claims_successful": claims_successful,
        "quota_gate": quota_gate_observed,
        "filled": filled,
        "total": total,
    }


async def advance_days_until_quota_refresh(page, max_days=3):
    """Advance enough time for FA quota to refresh to allow more claims."""
    await page.goto(f"{BASE}/#league", wait_until="domcontentloaded")
    await page.wait_for_timeout(1500)
    for i in range(max_days):
        d = page.locator('button:has-text("推進一天")').first
        if await d.count() and not await d.is_disabled():
            await d.click()
            await page.wait_for_timeout(4000)
            log(f"advanced day {i+1}")


async def try_fa_exhaustion_check(page):
    """Scenario 7: keep peeking at FA count; note pool size."""
    # Can't truly exhaust (500+ players usually) but we can check count
    await goto_fa(page)
    count = await count_fa_in_ui(page)
    log(f"visible FA rows in UI table: {count}")
    # API peek (observational only)
    peek = await api_peek(page, "/api/players?available=true&limit=1000")
    body = peek["body"] or ""
    try:
        arr = json.loads(body)
        total_fa = len(arr)
    except Exception:
        total_fa = -1
    log(f"FA pool size (peek): {total_fa} — UI shows {count} (limit=400)")
    return total_fa


async def advance_weeks(page, n=3):
    await page.goto(f"{BASE}/#league", wait_until="domcontentloaded")
    await page.wait_for_timeout(1500)
    advanced = 0
    for i in range(n):
        w = page.locator('button:has-text("推進一週")').first
        if not await w.count() or await w.is_disabled():
            log(f"cannot advance week at iter {i}")
            break
        await w.click()
        await page.wait_for_timeout(6000)
        await snap(page, f"after_week_{i+1}")
        advanced += 1
    return advanced


async def read_activity_log(page):
    items = await page.locator("#log-list li").all_text_contents()
    log(f"activity log has {len(items)} entries")
    for i, it in enumerate(items[:15]):
        log(f"  log[{i}]: {it.strip()[:140]}")
    return items


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(
            viewport={"width": 1400, "height": 900},
            ignore_https_errors=True,
        )
        page = await ctx.new_page()
        console_errs = []
        page.on("console", lambda m: console_errs.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errs.append(f"pageerror: {e}"))

        results = {}

        try:
            state = await ensure_league(page)
            log(f"ensure_league: {state}")
            await complete_setup(page)
            drafted = await draft_all(page)
            results["drafted"] = drafted

            if not drafted:
                log("CRITICAL: draft incomplete — downstream tests may be meaningless")

            started = await start_season(page)
            results["season_started"] = started

            # Navigate to FA — pre-scenario snapshot
            await goto_fa(page)
            await snap(page, "fa_landing")
            init_fa_count = await count_fa_in_ui(page)
            init_quota = (await page.locator("#fa-quota-box").text_content() or "").strip()
            log(f"initial FA rows={init_fa_count}  quota={init_quota}")
            results["init_fa_count"] = init_fa_count
            results["init_quota"] = init_quota

            # Scenario 5 — rage-click 加入 (dup pickup check)
            dup = await rage_click_fa_pickup(page, rounds=5)
            results["rage_click_dups"] = dup
            log(f"RAGE_CLICK duplicate-dialog events: {len(dup)}")

            # Scenario 6 — drop all starters / scrub-fill
            scrub_report = await drop_all_starters_via_fa(page)
            results["scrub_swap"] = scrub_report

            # Advance days to refill quota
            await advance_days_until_quota_refresh(page, max_days=2)
            await goto_fa(page)
            q2 = (await page.locator("#fa-quota-box").text_content() or "").strip()
            log(f"quota after day advance: {q2}")

            # Another round of rage-click for double-submit coverage
            dup2 = await rage_click_fa_pickup(page, rounds=3)
            results["rage_click_dups_2"] = dup2

            # Scenario 7 — FA pool exhaustion check (can't truly exhaust)
            fa_total = await try_fa_exhaustion_check(page)
            results["fa_pool_total"] = fa_total

            # Scenario 8 — double-submit (already covered in rage-click,
            # but do a focused test: single click→confirm→confirm twice)
            await goto_fa(page)
            sign_btn = page.locator("button.btn-sign").first
            double_submit_dup = False
            if await sign_btn.count():
                pid_ds = await sign_btn.get_attribute("data-player-id")
                await sign_btn.click()
                await page.wait_for_timeout(600)
                radios = page.locator("#dlg-confirm input[name='drop-pid']")
                if await radios.count():
                    await radios.first.check()
                    drop_pid_ds = await radios.first.get_attribute("value")
                    # Snapshot roster right before
                    pre_snap = await get_my_roster_snapshot(page)
                    pre_count = len(pre_snap["roster"])
                    # fire 2 confirm clicks
                    ok = page.locator("#confirm-ok")
                    try:
                        await ok.click()
                        await ok.click(timeout=200)
                    except Exception:
                        pass
                    await page.wait_for_timeout(3000)
                    post_snap = await get_my_roster_snapshot(page)
                    post_count = len(post_snap["roster"])
                    log(f"double-submit: pre_roster={pre_count} post_roster={post_count}")
                    if post_count > pre_count:
                        double_submit_dup = True
                        log(f"P0: double-submit created duplicate roster entry (pre={pre_count} post={post_count})")
                    # also check if added player appears twice
                    pids = [p["id"] for p in post_snap["roster"]]
                    dups = [pid for pid in set(pids) if pids.count(pid) > 1]
                    if dups:
                        double_submit_dup = True
                        log(f"P0: duplicate player IDs on roster: {dups}")
                    results["double_submit_pid"] = pid_ds
            results["double_submit_dup"] = double_submit_dup

            # Scenario 9 — advance 3 weeks
            weeks = await advance_weeks(page, n=3)
            results["weeks_advanced"] = weeks

            # Scenario 10 — activity log
            await page.goto(f"{BASE}/#league", wait_until="domcontentloaded")
            await page.wait_for_timeout(2000)
            log_items = await read_activity_log(page)
            # Look for FA-related entries
            fa_log_hits = [i for i in log_items if ("簽入" in i or "釋出" in i or "自由球員" in i or "加入" in i)]
            log(f"FA-related activity log entries: {len(fa_log_hits)}")
            results["fa_log_hits"] = len(fa_log_hits)
            results["log_total"] = len(log_items)
            await snap(page, "final_activity_log")

            # Standings peek
            await page.goto(f"{BASE}/#league", wait_until="domcontentloaded")
            await page.wait_for_timeout(2000)
            await snap(page, "final_league_view")

        except Exception as e:
            log(f"EXCEPTION: {e}")
            await snap(page, "exception")

        results["console_errors"] = console_errs[:10]
        results["console_error_count"] = len(console_errs)

        # Persist findings
        (OUT_DIR / "trace.log").write_text("\n".join(findings), encoding="utf-8")
        (OUT_DIR / "results.json").write_text(
            json.dumps(results, ensure_ascii=False, indent=2, default=str),
            encoding="utf-8",
        )
        log(f"console_errors: {len(console_errs)}")
        for ce in console_errs[:5]:
            log(f"  err: {ce[:160]}")

        await browser.close()
        return results


if __name__ == "__main__":
    r = asyncio.run(main())
    print("\n=== RESULTS SUMMARY ===")
    print(json.dumps(r, ensure_ascii=False, indent=2, default=str))
