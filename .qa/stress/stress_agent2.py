"""Stress-test script for Fantasy NBA season-advance machinery (agent-2)."""
import json
import math
import sys
import time
import requests

# Fix Windows console encoding
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BASE = "http://127.0.0.1:3501"
FINDINGS = []
ERRORS = []


def log(msg):
    print(msg, flush=True)


def find(label, ok, detail=""):
    icon = "PASS" if ok else "FAIL"
    entry = f"[{icon}] {label}" + (f": {detail}" if detail else "")
    FINDINGS.append(entry)
    log(entry)


def post(path, body=None, timeout=60):
    t0 = time.time()
    r = requests.post(f"{BASE}{path}", json=body or {}, timeout=timeout)
    elapsed = time.time() - t0
    if elapsed > 30:
        ERRORS.append(f"SLOW ({elapsed:.1f}s): POST {path}")
    return r, elapsed


def get(path, timeout=30):
    t0 = time.time()
    r = requests.get(f"{BASE}{path}", timeout=timeout)
    elapsed = time.time() - t0
    if elapsed > 30:
        ERRORS.append(f"SLOW ({elapsed:.1f}s): GET {path}")
    return r, elapsed


def wait_ready(retries=30):
    for i in range(retries):
        try:
            r = requests.get(f"{BASE}/api/health", timeout=3)
            if r.status_code == 200:
                log("Server ready.")
                return True
        except Exception:
            pass
        time.sleep(1)
    return False


def main():
    log("=== Fantasy NBA Stress Test (agent-2) ===")

    # -------------------------------------------------------------------------
    # 0. Wait for server
    # -------------------------------------------------------------------------
    if not wait_ready():
        ERRORS.append("Server never became ready")
        write_report()
        sys.exit(1)

    # -------------------------------------------------------------------------
    # 1. Setup league
    # -------------------------------------------------------------------------
    log("\n--- Phase 1: Setup ---")
    setup_body = {
        "league_name": "stress2",
        "season_year": "2025-26",
        "player_team_index": 0,
        "team_names": [
            "HumanTeam", "AITeam1", "AITeam2", "AITeam3",
            "AITeam4", "AITeam5", "AITeam6", "AITeam7"
        ],
        "num_teams": 8,
        "roster_size": 13,
        "starters_per_day": 10,
        "il_slots": 3,
        "regular_season_weeks": 20,
        "playoff_teams": 6,
        "randomize_draft_order": False,
        "setup_complete": True,
        "use_openrouter": False,
    }
    r, _ = post("/api/league/setup", setup_body)
    find("setup 200", r.status_code == 200, f"status={r.status_code}")
    if r.status_code != 200:
        ERRORS.append(f"Setup failed: {r.text[:300]}")

    # -------------------------------------------------------------------------
    # 2. Autodraft (sim entire draft)
    # -------------------------------------------------------------------------
    log("\n--- Phase 2: Autodraft ---")
    max_picks = 8 * 13 + 10
    for i in range(max_picks):
        # Check current state
        r_state, _ = get("/api/state")
        ds = r_state.json()
        if ds.get("is_complete"):
            break
        current_team = ds.get("current_team_id")
        human_team = ds.get("human_team_id")
        if current_team == human_team:
            # Human turn: pick the top available player
            r_players, _ = get("/api/players?available=true&limit=1")
            players = r_players.json()
            if not players:
                break
            pid = players[0]["id"]
            r, _ = post("/api/draft/pick", {"player_id": pid})
            if r.status_code != 200:
                ERRORS.append(f"Human pick failed: {r.status_code} {r.text[:100]}")
                break
        else:
            r, _ = post("/api/draft/ai-advance")
            if r.status_code not in (200, 409):
                ERRORS.append(f"ai-advance failed: {r.status_code} {r.text[:100]}")
                break
            state = r.json().get("state", {})
            if state.get("is_complete"):
                break
    # Verify draft complete
    r, _ = get("/api/state")
    ds = r.json()
    find("draft complete", ds.get("is_complete", False), f"is_complete={ds.get('is_complete')}")

    # -------------------------------------------------------------------------
    # 3. Start season
    # -------------------------------------------------------------------------
    log("\n--- Phase 3: Start Season ---")
    r, _ = post("/api/season/start")
    find("season start 200", r.status_code == 200, f"status={r.status_code} {r.text[:100]}")
    if r.status_code not in (200, 409):
        ERRORS.append(f"Season start failed: {r.text[:300]}")

    # -------------------------------------------------------------------------
    # 4. Advance-day x20 — verify current_day increments by exactly 1
    # -------------------------------------------------------------------------
    log("\n--- Phase 4: 20 sequential advance-day ---")
    r, _ = get("/api/season/standings")
    prev_day = r.json().get("current_day", 0)
    day_mismatch = False
    week_mismatch = False
    for i in range(20):
        r, elapsed = post("/api/season/advance-day", {"use_ai": False})
        if r.status_code == 409:
            log(f"  advance-day {i+1}: 409 (champion set or season ended)")
            break
        if r.status_code != 200:
            ERRORS.append(f"advance-day {i+1} returned {r.status_code}: {r.text[:200]}")
            break
        data = r.json()
        cur_day = data.get("current_day", -1)
        cur_week = data.get("current_week", -1)
        expected_day = prev_day + 1
        expected_week = math.ceil(cur_day / 7)
        if cur_day != expected_day:
            day_mismatch = True
            ERRORS.append(f"Day mismatch: expected {expected_day} got {cur_day}")
        if cur_week != expected_week:
            week_mismatch = True
            ERRORS.append(f"Week mismatch: day={cur_day} expected_week={expected_week} got={cur_week}")
        prev_day = cur_day
    find("advance-day increments by 1", not day_mismatch)
    find("current_week = ceil(day/7)", not week_mismatch)

    # -------------------------------------------------------------------------
    # 5. Advance to mid-season (week 10) then advance-week x5
    # -------------------------------------------------------------------------
    log("\n--- Phase 5: Advance to mid-season (week 10) ---")
    r, _ = get("/api/season/standings")
    cur_week = r.json().get("current_week", 1)
    cur_day = r.json().get("current_day", 0)

    # Advance days until we reach week 10 boundary
    target_day = 10 * 7  # end of week 10
    guarded = 0
    while cur_day < target_day and guarded < 200:
        r, _ = post("/api/season/advance-day", {"use_ai": False})
        if r.status_code != 200:
            break
        data = r.json()
        cur_day = data.get("current_day", cur_day)
        cur_week = data.get("current_week", cur_week)
        guarded += 1
    find(f"reached mid-season (day~{target_day})", cur_day >= target_day or cur_week >= 10,
         f"day={cur_day} week={cur_week}")

    log("\n--- Phase 5b: advance-week x5 ---")
    week_500s = 0
    for i in range(5):
        r, elapsed = post("/api/season/advance-week", {"use_ai": False})
        if r.status_code == 500:
            week_500s += 1
            ERRORS.append(f"advance-week {i+1} returned 500: {r.text[:300]}")
        elif r.status_code not in (200, 409):
            ERRORS.append(f"advance-week {i+1} returned {r.status_code}")
        else:
            d = r.json()
            log(f"  week {i+1}: day={d.get('current_day')} week={d.get('current_week')} champion={d.get('champion')}")
    find("advance-week x5 no 500s", week_500s == 0, f"{week_500s} 500s")

    # -------------------------------------------------------------------------
    # 6. sim-to-playoffs
    # -------------------------------------------------------------------------
    log("\n--- Phase 6: sim-to-playoffs ---")
    r, elapsed = post("/api/season/sim-to-playoffs", {"use_ai": False}, timeout=120)
    find("sim-to-playoffs 200", r.status_code == 200, f"status={r.status_code} elapsed={elapsed:.1f}s")
    if r.status_code == 200:
        d = r.json()
        find("is_playoffs=True after sim-to-playoffs", d.get("is_playoffs") is True,
             f"is_playoffs={d.get('is_playoffs')} week={d.get('current_week')}")
        find("no champion yet after sim-to-playoffs", d.get("champion") is None,
             f"champion={d.get('champion')}")
    elif r.status_code != 200:
        ERRORS.append(f"sim-to-playoffs: {r.text[:300]}")

    # -------------------------------------------------------------------------
    # 7. Verify schedule completeness for past weeks
    # -------------------------------------------------------------------------
    log("\n--- Phase 7: Schedule integrity check ---")
    r, _ = get("/api/season/schedule")
    schedule = r.json().get("schedule", [])
    r2, _ = get("/api/season/standings")
    sd = r2.json()
    cur_week_now = sd.get("current_week", 0)
    cur_day_now = sd.get("current_day", 0)

    # Only check weeks that should be complete (full 7-day weeks elapsed)
    completed_weeks = cur_day_now // 7
    past_matchups = [m for m in schedule if m["week"] <= completed_weeks]
    incomplete = [m for m in past_matchups if not m.get("complete")]
    find("all past matchups complete", len(incomplete) == 0,
         f"{len(incomplete)} incomplete in weeks 1..{completed_weeks}")

    # -------------------------------------------------------------------------
    # 8. Standings math check: w+l sum = games played per team
    # -------------------------------------------------------------------------
    log("\n--- Phase 8: Standings math check ---")
    standings = sd.get("standings", [])
    math_errors = []
    for row in standings:
        w = row.get("w", 0)
        l = row.get("l", 0)
        # Each team plays 1 game per week; regular season only tracks reg weeks
        total = w + l
        # total should equal completed_weeks (or close, allowing playoffs don't add)
        if total != completed_weeks and completed_weeks <= 20:
            math_errors.append(
                f"Team {row['name']}: w={w}+l={l}={total} but completed_weeks={completed_weeks}"
            )
    find("standings w+l = completed weeks", len(math_errors) == 0,
         "; ".join(math_errors[:3]) if math_errors else "OK")

    # -------------------------------------------------------------------------
    # 9. sim-playoffs
    # -------------------------------------------------------------------------
    log("\n--- Phase 9: sim-playoffs ---")
    r, elapsed = post("/api/season/sim-playoffs", {"use_ai": False}, timeout=180)
    find("sim-playoffs 200", r.status_code == 200, f"status={r.status_code} elapsed={elapsed:.1f}s")
    champion_id = None
    if r.status_code == 200:
        d = r.json()
        champion_id = d.get("champion")
        find("champion is non-null after sim-playoffs", champion_id is not None,
             f"champion={champion_id}")
    else:
        ERRORS.append(f"sim-playoffs: {r.text[:300]}")

    # -------------------------------------------------------------------------
    # 10. game_logs trimming
    # -------------------------------------------------------------------------
    log("\n--- Phase 10: game_logs trimming check ---")
    r, _ = get("/api/season/standings")
    # We can't directly access game_logs via API; check summary works
    # As a proxy, load the saved state file
    import pathlib, json as _json
    data_path = pathlib.Path("D:/claude/fantasy nba/.qa/stress/data-2/leagues/stress2/season.json")
    trimming_ok = True
    game_logs_len = None
    if data_path.exists():
        with open(data_path, encoding="utf-8") as f:
            saved = _json.load(f)
        game_logs_len = len(saved.get("game_logs", []))
        # 14 days * 8 teams * 10 starters = 1120 max after trimming
        limit = 14 * 8 * 10
        trimming_ok = game_logs_len <= limit
        find("game_logs bounded <=14*num_teams*10", trimming_ok,
             f"len={game_logs_len} limit={limit}")
    else:
        find("game_logs check (file found)", False, "season.json not at expected path")

    # -------------------------------------------------------------------------
    # 11. /api/season/summary
    # -------------------------------------------------------------------------
    log("\n--- Phase 11: season/summary ---")
    r, elapsed = get("/api/season/summary", timeout=30)
    find("summary 200", r.status_code == 200, f"status={r.status_code} elapsed={elapsed:.1f}s")
    if r.status_code == 200:
        s = r.json()
        find("summary.mvp populated", s.get("mvp") is not None, str(s.get("mvp", "None"))[:80])
        find("summary.top_games populated", len(s.get("top_games", [])) > 0,
             f"count={len(s.get('top_games', []))}")
        human_id = s.get("human_team_id")
        human_rank = s.get("human_rank")
        find("summary.human_rank populated", human_rank is not None,
             f"human_id={human_id} rank={human_rank}")
        find("summary.champion_id matches", s.get("champion_id") == champion_id,
             f"summary={s.get('champion_id')} sim={champion_id}")
    else:
        ERRORS.append(f"summary: {r.text[:200]}")

    # -------------------------------------------------------------------------
    # 12. advance-day after champion — should 409 or no-op
    # -------------------------------------------------------------------------
    log("\n--- Phase 12: advance-day after champion ---")
    r, _ = post("/api/season/advance-day", {"use_ai": False})
    find("advance-day after champion: 409 or no-op",
         r.status_code in (200, 409),
         f"status={r.status_code}")
    if r.status_code == 200:
        d2 = r.json()
        # Champion should still be set (no-op means day didn't change meaningfully)
        find("advance-day after champion: champion preserved",
             d2.get("champion") == champion_id,
             f"champion={d2.get('champion')}")
    if r.status_code == 500:
        ERRORS.append(f"advance-day after champion returned 500: {r.text[:300]}")

    write_report()


def write_report():
    lines = ["# Stress Test Report — agent-2", "", f"Run at: {time.strftime('%Y-%m-%d %H:%M:%S')}", ""]
    lines.append("## Results")
    for f in FINDINGS:
        lines.append(f"- {f}")
    if ERRORS:
        lines.append("")
        lines.append("## Errors / Warnings")
        for e in ERRORS:
            lines.append(f"- {e}")
    pass_count = sum(1 for f in FINDINGS if f.startswith("[PASS]"))
    fail_count = sum(1 for f in FINDINGS if f.startswith("[FAIL]"))
    lines.append("")
    lines.append(f"## Summary: {pass_count} passed, {fail_count} failed")

    import pathlib
    out = pathlib.Path("D:/claude/fantasy nba/.qa/stress/agent-2.md")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    log(f"\nReport written to {out}")
    log(f"TOTAL: {pass_count} PASS, {fail_count} FAIL")


if __name__ == "__main__":
    main()
