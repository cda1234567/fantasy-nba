"""Iter5 O1 — production Playwright validation for v0.5.12.

Tests:
  1. advance-week completes within 10s (E1 async fix)
  2. counter-offer UX (toast + banner + history)
  3. week-recap browser + trimmed notice
  4. lineup override invalidation toast

Prints pass/fail to stdout.
"""
from __future__ import annotations

import json
import re
import time
import traceback
from pathlib import Path

import httpx
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

BASE = "https://nbafantasy.cda1234567.com"
ARTIFACTS = Path(__file__).parent / "iter5_artifacts"
ARTIFACTS.mkdir(exist_ok=True)

results: dict[str, dict] = {}


def record(name: str, passed: bool, **info):
    results[name] = {"pass": passed, **info}
    try:
        msg = json.dumps(info, ensure_ascii=False, default=str)[:300]
    except Exception:
        msg = str(info)[:300]
    # Avoid Windows cp950 print errors
    safe = msg.encode("ascii", "replace").decode("ascii")
    print(f"[{'PASS' if passed else 'FAIL'}] {name}  {safe}")


def api_get(path: str, timeout: float = 20) -> dict | list:
    r = httpx.get(BASE + path, timeout=timeout)
    r.raise_for_status()
    return r.json()


def shoot(page, name: str):
    try:
        page.screenshot(path=str(ARTIFACTS / f"{name}.png"), full_page=False)
    except Exception:
        pass


def test_advance_week(page) -> None:
    """Time advance-week, expect <10s completion with state update."""
    name = "advance_week_under_10s"
    try:
        pre = api_get("/api/season/standings")
        pre_week = pre.get("current_week")
        pre_day = pre.get("current_day")
        if pre.get("is_playoffs") and pre_week and pre_week >= 23:
            record(name, False, reason="season already over", pre_week=pre_week)
            return
        if pre_week is None:
            record(name, False, reason="season not started", pre_week=pre_week)
            return
        t_req = time.time()
        try:
            resp = httpx.post(BASE + "/api/season/advance-week", json={}, timeout=60)
            status = resp.status_code
            elapsed = time.time() - t_req
        except httpx.ReadTimeout:
            elapsed = time.time() - t_req
            status = "TIMEOUT_60s"
        except httpx.HTTPStatusError as e:
            elapsed = time.time() - t_req
            status = e.response.status_code
        time.sleep(2)
        post = api_get("/api/season/standings")
        post_week = post.get("current_week")
        post_day = post.get("current_day")
        advanced = (post_week != pre_week) or (post_day != pre_day) or bool(post.get("is_playoffs"))
        ok = isinstance(status, int) and status == 200 and elapsed < 10 and advanced
        record(name, ok,
               elapsed_s=round(elapsed, 2),
               http_status=status,
               pre_week=pre_week,
               post_week=post_week,
               pre_day=pre_day,
               post_day=post_day,
               advanced=bool(advanced))
    except Exception as exc:
        record(name, False, error=str(exc), traceback=traceback.format_exc()[:300])


def _team_detail(team_id: int) -> dict:
    return api_get(f"/api/teams/{team_id}")


def propose_unreasonable_trade() -> dict | None:
    """Build an 'unreasonable' proposal: give bench, ask for star."""
    state = api_get("/api/state")
    human_id = state.get("human_team_id")
    num_teams = state.get("num_teams") or 8

    human = _team_detail(human_id)
    human_players = human.get("players", [])
    if not human_players:
        return None
    mine_sorted = sorted(human_players, key=lambda p: p.get("fppg", 0))
    # Pick a truly low-value one but not injured
    my_cheapest = mine_sorted[0]

    # Find a star in another team
    best_team_id = None
    best_star = None
    best_fppg = -1
    for tid in range(num_teams):
        if tid == human_id:
            continue
        try:
            td = _team_detail(tid)
        except Exception:
            continue
        for p in td.get("players", []):
            if p.get("fppg", 0) > best_fppg:
                best_fppg = p.get("fppg", 0)
                best_star = p
                best_team_id = tid

    if not best_star or best_team_id is None:
        return None

    body = {
        "from_team": int(human_id),
        "to_team": int(best_team_id),
        "send": [int(my_cheapest["id"])],
        "receive": [int(best_star["id"])],
        "note": "iter5_o1 unreasonable ask",
    }
    def _safe(s):
        return str(s).encode("ascii", "replace").decode("ascii")
    print(f"  propose: giving {_safe(my_cheapest.get('name'))} ({my_cheapest.get('fppg', 0):.1f}) "
          f"for {_safe(best_star.get('name'))} ({best_star.get('fppg', 0):.1f}) -> team {best_team_id}")
    try:
        r = httpx.post(BASE + "/api/trades/propose", json=body, timeout=20)
        if r.status_code != 200:
            print(f"  propose HTTP {r.status_code}: {r.text[:200]}")
            return None
        return r.json()
    except Exception as exc:
        print(f"  propose exception: {exc}")
        return None


def test_counter_offer(page) -> None:
    name = "counter_offer_ux"
    try:
        trade = propose_unreasonable_trade()
        if not trade:
            record(name, False, reason="could not propose trade")
            return
        trade_id = trade.get("id") or (trade.get("trade") or {}).get("id")
        print(f"  proposed trade id={trade_id}")

        counter_seen = None
        deadline = time.time() + 45
        while time.time() < deadline:
            pending = api_get("/api/trades/pending")
            pending_list = pending.get("pending", []) if isinstance(pending, dict) else (pending or [])
            for p in pending_list:
                if p.get("counter_of"):
                    counter_seen = p
                    break
            if counter_seen:
                break
            time.sleep(2)

        if not counter_seen:
            hist_now = api_get("/api/trades/history")
            hist_list = hist_now if isinstance(hist_now, list) else hist_now.get("history", [])
            orig = next((t for t in hist_list if t.get("id") == trade_id), None)
            record(name, False, reason="no counter-offer within 45s",
                   orig_status=(orig or {}).get("status"),
                   total_history_len=len(hist_list))
            return

        page.goto(BASE + "/#trades", wait_until="networkidle", timeout=25000)
        page.wait_for_timeout(2000)
        shoot(page, "02_counter_pending")

        body_text = page.evaluate("document.body.innerText")
        banner_seen = "查看原提議" in body_text
        history_chip_seen = ("還價自" in body_text) or ("已被還價" in body_text) or ("↩ 還價" in body_text)
        pending_card_has_counter = "這是對你原始提議的還價" in body_text or banner_seen

        ok = banner_seen and history_chip_seen
        record(name, ok,
               counter_trade_id=counter_seen.get("id"),
               counter_of=counter_seen.get("counter_of"),
               banner_seen=banner_seen,
               history_chip_seen=history_chip_seen,
               pending_card_counter=pending_card_has_counter)
    except Exception as exc:
        record(name, False, error=str(exc), traceback=traceback.format_exc()[:400])


def test_week_recap_browser(page) -> None:
    name = "week_recap_browser"
    try:
        standings = api_get("/api/season/standings")
        cur_week = standings.get("current_week") or 1
        target_week = max(2, (cur_week or 2) - 1)

        page.goto(BASE + "/#season", wait_until="networkidle", timeout=25000)
        page.wait_for_timeout(1500)

        has_fn = page.evaluate("typeof onShowWeekRecap")
        clicked = False
        try:
            btn = page.get_by_role("button", name=re.compile("週報"))
            if btn and btn.count() > 0:
                btn.first.click()
                clicked = True
        except Exception:
            pass
        if not clicked:
            # Fall back to calling the function in page context
            page.evaluate(f"(async()=>{{try{{await onShowWeekRecap({target_week});}}catch(e){{console.log('recap-err',e.message);}}}})()")
        for _ in range(40):
            if page.query_selector("#recap-overlay"):
                break
            page.wait_for_timeout(300)

        overlay = page.query_selector("#recap-overlay")
        if not overlay:
            r = httpx.get(BASE + f"/api/season/week-recap?week={target_week}", timeout=15)
            record(name, False, reason="overlay did not render",
                   onShowWeekRecap_type=has_fn,
                   api_status=r.status_code,
                   target_week=target_week)
            return
        shoot(page, "03_recap_open")
        title_text = page.evaluate(
            "document.querySelector('#recap-overlay .recap-head h2')?.innerText"
            " || document.querySelector('#recap-overlay h2')?.innerText"
        )

        # Walk backward through prev arrow until disabled or trimmed notice appears
        prev_clicks = 0
        trimmed_seen = False
        for _ in range(max(target_week - 1, 0)):
            prev = page.query_selector("#recap-overlay .recap-nav-btn:first-of-type")
            if not prev:
                break
            disabled = prev.get_attribute("disabled") is not None
            if disabled:
                break
            prev.click()
            prev_clicks += 1
            page.wait_for_timeout(500)
            body_txt = page.evaluate("document.body.innerText")
            if "舊週資料已清理" in body_txt:
                trimmed_seen = True
                break

        # Try next arrow forward
        next_clicks = 0
        next_btn = page.query_selector("#recap-overlay .recap-nav-btn:last-of-type")
        if next_btn and next_btn.get_attribute("disabled") is None:
            next_btn.click()
            next_clicks = 1
            page.wait_for_timeout(500)
        shoot(page, "03_recap_after_nav")

        ok = bool(title_text) and (prev_clicks > 0 or next_clicks > 0)
        record(name, ok,
               target_week=target_week,
               overlay_title=title_text,
               prev_clicks=prev_clicks,
               next_clicks=next_clicks,
               trimmed_notice_seen=trimmed_seen)
    except Exception as exc:
        record(name, False, error=str(exc), traceback=traceback.format_exc()[:400])


def test_lineup_override(page) -> None:
    name = "lineup_override_invalidation"
    try:
        state = api_get("/api/state")
        human_id = state.get("human_team_id")
        human = _team_detail(human_id)
        players = human.get("players", [])
        if not players:
            record(name, False, reason="no human roster players")
            return
        # Use the current slot_rows assignment (already feasible) as the override
        # so the endpoint accepts it. The point is to have any override set so we
        # can observe invalidation when injuries break feasibility later.
        slot_rows = human.get("lineup_slots", [])
        lineup_ids = [int(s["player_id"]) for s in slot_rows if s.get("player_id") is not None]
        if len(lineup_ids) < 10:
            # Pad with bench by fppg until feasible
            bench_ids = [int(p["id"]) for p in sorted(players, key=lambda p: -p.get("fppg", 0))
                          if int(p["id"]) not in lineup_ids][: 10 - len(lineup_ids)]
            lineup_ids.extend(bench_ids)
        body = {"team_id": int(human_id), "starters": lineup_ids[:10]}
        r = httpx.post(BASE + "/api/season/lineup", json=body, timeout=15)
        if r.status_code != 200:
            # Try a position-conscious lineup: use the slot positions returned by team-detail
            # Use first 10 by fppg anyway as fallback, else abort
            record(name, False, reason="could not set lineup override",
                   status=r.status_code, detail=r.text[:200])
            return

        # Confirm override badge
        team_after = _team_detail(human_id)
        has_override = team_after.get("has_lineup_override")

        # Advance days and poll alerts for 'lineup_invalid' type event
        invalidation = None
        alerts_seen = []
        for i in range(14):  # up to 14 days
            try:
                httpx.post(BASE + "/api/season/advance-day", json={}, timeout=25)
            except Exception as exc:
                print(f"  advance-day {i} error: {exc}")
            try:
                alerts = api_get("/api/season/lineup-alerts")
            except Exception:
                alerts = None
            lst = alerts if isinstance(alerts, list) else (alerts or {}).get("alerts", [])
            if lst:
                alerts_seen.extend(lst)
                for a in lst:
                    if a.get("team_id") == human_id or a.get("type", "").startswith("lineup"):
                        invalidation = a
                        break
            if invalidation:
                break

        # Load UI to see the toast the frontend fires when it polls alerts
        page.goto(BASE + "/#season", wait_until="networkidle", timeout=25000)
        page.wait_for_timeout(2500)
        body_text = page.evaluate("document.body.innerText")
        toast_in_dom = ("手動陣容已失效" in body_text) or ("已恢復自動" in body_text)
        shoot(page, "04_lineup_override")

        ok = bool(invalidation) or toast_in_dom
        record(name, ok,
               had_override=has_override,
               invalidation=invalidation,
               alerts_count=len(alerts_seen),
               ui_text_contains_invalid_toast=toast_in_dom)
    except Exception as exc:
        record(name, False, error=str(exc), traceback=traceback.format_exc()[:400])


def main():
    t_all = time.time()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()
        console_msgs: list[str] = []
        page.on("console", lambda msg: console_msgs.append(f"[{msg.type}] {msg.text}"[:240]))

        try:
            page.goto(BASE, wait_until="networkidle", timeout=25000)
        except Exception as exc:
            print("warmup nav error:", exc)

        test_advance_week(page)
        test_counter_offer(page)
        test_week_recap_browser(page)
        test_lineup_override(page)

        (ARTIFACTS / "console.log").write_text("\n".join(console_msgs), encoding="utf-8")
        browser.close()

    total = time.time() - t_all
    summary = {"total_s": round(total, 1), "results": results}
    (ARTIFACTS / "results.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print("\n=== SUMMARY ===")
    for n, r in results.items():
        print(f" {n}: {'PASS' if r.get('pass') else 'FAIL'}")
    print(f"Total: {total:.1f}s")


if __name__ == "__main__":
    main()
