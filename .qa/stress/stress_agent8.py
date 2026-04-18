"""Stress-test script for Fantasy NBA week-recap + matchup-detail endpoints (agent-8)."""
import json
import pathlib
import sys
import time
import requests

BASE = "http://127.0.0.1:3507"
DATA_DIR = pathlib.Path("D:/claude/fantasy nba/.qa/stress/data-8")
FINDINGS = []
ERRORS = []


def log(msg):
    print(msg, flush=True)


def find(label, ok, detail=""):
    icon = "PASS" if ok else "FAIL"
    entry = f"[{icon}] {label}" + (f": {detail}" if detail else "")
    FINDINGS.append(entry)
    log(entry)


def post(path, body=None, timeout=120):
    t0 = time.time()
    r = requests.post(f"{BASE}{path}", json=body or {}, timeout=timeout)
    elapsed = time.time() - t0
    if elapsed > 60:
        ERRORS.append(f"SLOW ({elapsed:.1f}s): POST {path}")
    return r, elapsed


def get(path, timeout=30):
    t0 = time.time()
    r = requests.get(f"{BASE}{path}", timeout=timeout)
    elapsed = time.time() - t0
    return r, elapsed


def wait_ready(retries=30):
    for _ in range(retries):
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
    log("=== Fantasy NBA Stress Test (agent-8): week-recap + matchup-detail ===")

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
        "league_name": "stress8",
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
        write_report()
        sys.exit(1)

    # -------------------------------------------------------------------------
    # 2. Autodraft — handle human picks by picking best available player
    # -------------------------------------------------------------------------
    log("\n--- Phase 2: Autodraft ---")
    max_picks = 8 * 13 + 20
    for _ in range(max_picks):
        # Check current state to see whose turn it is
        rs, _ = get("/api/state")
        ds = rs.json()
        if ds.get("is_complete"):
            break
        current_team = ds.get("current_team_id")
        human_team = ds.get("human_team_id")
        if current_team == human_team:
            # Human's turn — pick best available player
            rp, _ = get("/api/players?available=true&limit=1")
            players = rp.json()
            if not players:
                break
            pid = players[0]["id"]
            r2, _ = post("/api/draft/pick", {"player_id": pid})
            if r2.status_code != 200:
                ERRORS.append(f"human pick failed: {r2.status_code} {r2.text[:100]}")
                break
        else:
            r, _ = post("/api/draft/ai-advance")
            if r.status_code not in (200, 409):
                ERRORS.append(f"ai-advance returned {r.status_code}: {r.text[:100]}")
                break
            data = r.json().get("state", {})
            if data.get("is_complete"):
                break
    rs, _ = get("/api/state")
    ds = rs.json()
    find("draft complete", ds.get("is_complete", False))
    if not ds.get("is_complete"):
        ERRORS.append("Draft not complete — aborting")
        write_report()
        sys.exit(1)

    # -------------------------------------------------------------------------
    # 3. Start season
    # -------------------------------------------------------------------------
    log("\n--- Phase 3: Start Season ---")
    r, _ = post("/api/season/start")
    find("season start 200", r.status_code == 200, f"status={r.status_code}")
    if r.status_code not in (200, 409):
        ERRORS.append(f"Season start failed: {r.text[:300]}")
        write_report()
        sys.exit(1)

    # -------------------------------------------------------------------------
    # 4. Advance full regular season via sim-to-playoffs
    # -------------------------------------------------------------------------
    log("\n--- Phase 4: sim-to-playoffs ---")
    r, elapsed = post("/api/season/sim-to-playoffs", {"use_ai": False}, timeout=300)
    find("sim-to-playoffs 200", r.status_code == 200,
         f"status={r.status_code} elapsed={elapsed:.1f}s")
    if r.status_code != 200:
        ERRORS.append(f"sim-to-playoffs failed: {r.text[:300]}")
        write_report()
        sys.exit(1)
    season_data = r.json()
    current_week = season_data.get("current_week", 0)
    log(f"  After sim-to-playoffs: week={current_week} is_playoffs={season_data.get('is_playoffs')}")

    # -------------------------------------------------------------------------
    # 5. Determine completed regular-season weeks from schedule
    # -------------------------------------------------------------------------
    log("\n--- Phase 5: Fetch schedule ---")
    r, _ = get("/api/season/schedule")
    schedule = r.json().get("schedule", [])
    completed_weeks = sorted(set(
        m["week"] for m in schedule if m.get("complete") and not _is_playoff_week(m, schedule)
    ))
    log(f"  Completed regular weeks: {completed_weeks}")
    find("at least 1 completed regular week", len(completed_weeks) > 0,
         f"count={len(completed_weeks)}")

    # Build matchup map: week -> list of (team_a, team_b, score_a, score_b)
    matchup_map: dict[int, list] = {}
    for m in schedule:
        if m.get("complete"):
            matchup_map.setdefault(m["week"], []).append(m)

    # -------------------------------------------------------------------------
    # 6. Per-week: week-recap + matchup-detail for every matchup
    # -------------------------------------------------------------------------
    log("\n--- Phase 6: week-recap + matchup-detail per week ---")
    recap_500s = []
    wrong_score = []
    wrong_trimmed = []
    empty_recent = []

    for week in completed_weeks:
        # 6a. week-recap
        r, _ = get(f"/api/season/week-recap?week={week}")
        if r.status_code == 500:
            recap_500s.append(week)
            ERRORS.append(f"week-recap week={week} returned 500: {r.text[:200]}")
            continue
        if r.status_code != 200:
            ERRORS.append(f"week-recap week={week} returned {r.status_code}")
            continue

        recap = r.json()

        # Verify matchups list non-empty
        recap_matchups = recap.get("matchups", [])
        find(f"week {week} recap matchups non-empty",
             len(recap_matchups) > 0, f"count={len(recap_matchups)}")

        # Verify top_performers 0..5
        tp = recap.get("top_performers", [])
        find(f"week {week} top_performers length 0-5",
             0 <= len(tp) <= 5, f"len={len(tp)}")

        # Verify logs_trimmed flag: True only when current_week - week > 2 AND
        # game_logs empty for that week. We check using season.json directly.
        logs_trimmed_api = recap.get("logs_trimmed", False)
        expected_trimmed = _check_expected_trimmed(week, current_week, DATA_DIR)
        if expected_trimmed is not None and logs_trimmed_api != expected_trimmed:
            msg = f"week={week} logs_trimmed={logs_trimmed_api} expected={expected_trimmed}"
            wrong_trimmed.append(msg)
            ERRORS.append(f"logs_trimmed wrong: {msg}")
        find(f"week {week} logs_trimmed flag correct",
             expected_trimmed is None or logs_trimmed_api == expected_trimmed,
             f"trimmed={logs_trimmed_api} expected={expected_trimmed}")

        # 6b. matchup-detail for each matchup
        week_schedule_matchups = matchup_map.get(week, [])
        for m in week_schedule_matchups:
            ta = m["team_a"]
            tb = m["team_b"]
            sched_score_a = round(float(m.get("score_a", 0)), 2)
            sched_score_b = round(float(m.get("score_b", 0)), 2)

            # Normal order
            r2, _ = get(f"/api/season/matchup-detail?week={week}&team_a={ta}&team_b={tb}")
            if r2.status_code != 200:
                ERRORS.append(f"matchup-detail week={week} {ta}v{tb} status={r2.status_code}")
                find(f"week {week} matchup {ta}v{tb} detail 200", False,
                     f"status={r2.status_code}")
                continue

            detail = r2.json()
            detail_score_a = round(float(detail.get("score_a", 0)), 2)
            detail_score_b = round(float(detail.get("score_b", 0)), 2)

            # Score sanity: must match schedule scores
            scores_match = (
                abs(detail_score_a - sched_score_a) < 0.1 and
                abs(detail_score_b - sched_score_b) < 0.1
            )
            if not scores_match:
                msg = (f"week={week} {ta}v{tb}: detail=({detail_score_a},{detail_score_b}) "
                       f"schedule=({sched_score_a},{sched_score_b})")
                wrong_score.append(msg)
                ERRORS.append(f"Score mismatch: {msg}")
            find(f"week {week} {ta}v{tb} scores match schedule", scores_match,
                 f"detail=({detail_score_a},{detail_score_b}) sched=({sched_score_a},{sched_score_b})")

            # If not trimmed, scores should not both be 0
            detail_trimmed = detail.get("logs_trimmed", False)
            if not detail_trimmed:
                both_zero = (detail_score_a == 0 and detail_score_b == 0)
                if both_zero:
                    ERRORS.append(f"Both scores 0 for non-trimmed week={week} {ta}v{tb}")
                find(f"week {week} {ta}v{tb} not 0-0 when not trimmed",
                     not both_zero)

            # players_a and players_b: if not trimmed, length should be ~0 or ~70
            players_a = detail.get("players_a", [])
            players_b = detail.get("players_b", [])
            if not detail_trimmed:
                pa_ok = len(players_a) == 0 or (40 <= len(players_a) <= 100)
                pb_ok = len(players_b) == 0 or (40 <= len(players_b) <= 100)
                find(f"week {week} {ta}v{tb} players_a length sane",
                     pa_ok, f"len={len(players_a)}")
                find(f"week {week} {ta}v{tb} players_b length sane",
                     pb_ok, f"len={len(players_b)}")
                # Recent weeks (last 3) should have non-empty players
                is_recent = (current_week - week) <= 2
                if is_recent:
                    if len(players_a) == 0 or len(players_b) == 0:
                        msg = f"week={week} {ta}v{tb} players_a={len(players_a)} players_b={len(players_b)}"
                        empty_recent.append(msg)
                        ERRORS.append(f"Empty players for recent week: {msg}")
                    find(f"week {week} {ta}v{tb} recent week has players",
                         len(players_a) > 0 and len(players_b) > 0,
                         f"pa={len(players_a)} pb={len(players_b)}")

            # 6c. Flip team_a and team_b — should still find matchup
            r3, _ = get(f"/api/season/matchup-detail?week={week}&team_a={tb}&team_b={ta}")
            find(f"week {week} {tb}v{ta} flipped also 200",
                 r3.status_code == 200, f"status={r3.status_code}")
            if r3.status_code == 200:
                flipped = r3.json()
                # Scores should match (possibly swapped fields)
                fa = round(float(flipped.get("score_a", 0)), 2)
                fb = round(float(flipped.get("score_b", 0)), 2)
                # score_a in flipped = score for team_b (original), etc.
                # The endpoint normalises by the query params so score_a -> queried team_a
                # Just verify both scores present and non-negative
                find(f"week {week} flipped scores present",
                     fa >= 0 and fb >= 0, f"score_a={fa} score_b={fb}")

    # -------------------------------------------------------------------------
    # 7. Summary finds for recap / detail issues
    # -------------------------------------------------------------------------
    find("no week-recap 500s", len(recap_500s) == 0,
         f"weeks with 500: {recap_500s}" if recap_500s else "OK")
    find("no matchup score mismatches", len(wrong_score) == 0,
         f"{len(wrong_score)} mismatches" if wrong_score else "OK")
    find("no logs_trimmed flag wrong", len(wrong_trimmed) == 0,
         f"{len(wrong_trimmed)} wrongs" if wrong_trimmed else "OK")
    find("no empty players for recent weeks", len(empty_recent) == 0,
         f"{len(empty_recent)} issues" if empty_recent else "OK")

    # -------------------------------------------------------------------------
    # 8. Spot-check: last played week → non-empty players
    # -------------------------------------------------------------------------
    log("\n--- Phase 7: Spot-checks ---")
    if completed_weeks:
        last_week = max(completed_weeks)
        r, _ = get(f"/api/season/week-recap?week={last_week}")
        if r.status_code == 200:
            rc = r.json()
            week_ms = matchup_map.get(last_week, [])
            if week_ms:
                m0 = week_ms[0]
                ta, tb = m0["team_a"], m0["team_b"]
                r2, _ = get(f"/api/season/matchup-detail?week={last_week}&team_a={ta}&team_b={tb}")
                if r2.status_code == 200:
                    d = r2.json()
                    trimmed = d.get("logs_trimmed", False)
                    pa = len(d.get("players_a", []))
                    pb = len(d.get("players_b", []))
                    find("last week matchup-detail: logs_trimmed=False", not trimmed,
                         f"trimmed={trimmed}")
                    find("last week matchup-detail: players_a non-empty", pa > 0, f"len={pa}")
                    find("last week matchup-detail: players_b non-empty", pb > 0, f"len={pb}")

        # Week 1 should be trimmed (current_week is 20+, so current_week - 1 > 2)
        if current_week > 3:
            r, _ = get("/api/season/week-recap?week=1")
            if r.status_code == 200:
                trimmed1 = r.json().get("logs_trimmed", False)
                find("week 1 logs_trimmed=True (oldest week)", trimmed1,
                     f"logs_trimmed={trimmed1} current_week={current_week}")
            else:
                find("week 1 recap accessible", r.status_code == 200,
                     f"status={r.status_code}")

    # -------------------------------------------------------------------------
    # 9. Bad inputs
    # -------------------------------------------------------------------------
    log("\n--- Phase 8: Bad inputs ---")

    # week=999 → 404
    r, _ = get("/api/season/week-recap?week=999")
    find("week-recap week=999 → 404", r.status_code == 404,
         f"status={r.status_code}")

    # week=0 → 422 (ge=1 validation)
    r, _ = get("/api/season/week-recap?week=0")
    find("week-recap week=0 → 422", r.status_code == 422,
         f"status={r.status_code}")

    # team_a=99 not in league → matchup-detail 404
    r, _ = get("/api/season/matchup-detail?week=1&team_a=99&team_b=0")
    find("matchup-detail team_a=99 not in league → 404", r.status_code == 404,
         f"status={r.status_code}")

    # team_a=team_b (same team) → 404
    r, _ = get("/api/season/matchup-detail?week=1&team_a=0&team_b=0")
    find("matchup-detail team_a=team_b → 404", r.status_code == 404,
         f"status={r.status_code}")

    # matchup-detail week=999 → 404
    r, _ = get("/api/season/matchup-detail?week=999&team_a=0&team_b=1")
    find("matchup-detail week=999 → 404", r.status_code == 404,
         f"status={r.status_code}")

    write_report()


def _is_playoff_week(matchup: dict, all_matchups: list) -> bool:
    """Heuristic: a week is a playoff week if any matchup that week has a bye
    (not all 8 teams playing). For 8 teams, every regular week has exactly 4 matchups."""
    week = matchup["week"]
    week_matchups = [m for m in all_matchups if m["week"] == week]
    return len(week_matchups) < 4


def _check_expected_trimmed(week: int, current_week: int, data_dir: pathlib.Path) -> bool | None:
    """Read season.json to determine if game_logs for `week` are empty.
    Returns True/False for expected trimmed, or None if we can't determine."""
    # Find season.json
    for league_dir in (data_dir / "leagues").iterdir():
        season_file = league_dir / "season.json"
        if season_file.exists():
            try:
                with open(season_file, encoding="utf-8") as f:
                    saved = json.load(f)
                week_logs = [g for g in saved.get("game_logs", []) if g.get("week") == week]
                logs_empty = len(week_logs) == 0
                return logs_empty and (current_week - week > 2)
            except Exception:
                return None
    return None


def write_report():
    lines = [
        "# Stress Test Report — agent-8",
        "",
        f"Run at: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "## Endpoints Tested",
        "- GET /api/season/week-recap?week=N",
        "- GET /api/season/matchup-detail?week=N&team_a=A&team_b=B",
        "",
    ]

    # Separate issues
    recap_500_lines = [e for e in ERRORS if "500" in e and "week-recap" in e]
    score_mismatch_lines = [e for e in ERRORS if "Score mismatch" in e or "score mismatch" in e.lower()]
    trimmed_wrong_lines = [e for e in ERRORS if "logs_trimmed wrong" in e]
    empty_player_lines = [e for e in ERRORS if "Empty players" in e]

    lines.append("## Issues Found")
    if recap_500_lines:
        lines.append("### Recap returning 500")
        for e in recap_500_lines:
            lines.append(f"- {e}")
    else:
        lines.append("- No recap 500s")

    if score_mismatch_lines:
        lines.append("### Matchup-detail score mismatch vs schedule")
        for e in score_mismatch_lines:
            lines.append(f"- {e}")
    else:
        lines.append("- No score mismatches")

    if trimmed_wrong_lines:
        lines.append("### logs_trimmed flag wrong")
        for e in trimmed_wrong_lines:
            lines.append(f"- {e}")
    else:
        lines.append("- No logs_trimmed flag errors")

    if empty_player_lines:
        lines.append("### Empty players for recent weeks")
        for e in empty_player_lines:
            lines.append(f"- {e}")
    else:
        lines.append("- No empty-players issues for recent weeks")

    other_errors = [e for e in ERRORS
                    if e not in recap_500_lines + score_mismatch_lines
                    + trimmed_wrong_lines + empty_player_lines]
    if other_errors:
        lines.append("### Other errors")
        for e in other_errors:
            lines.append(f"- {e}")

    lines.append("")
    lines.append("## All Findings")
    for f in FINDINGS:
        lines.append(f"- {f}")

    pass_count = sum(1 for f in FINDINGS if f.startswith("[PASS]"))
    fail_count = sum(1 for f in FINDINGS if f.startswith("[FAIL]"))
    lines.append("")
    lines.append(f"## Summary: {pass_count} passed, {fail_count} failed")

    out = pathlib.Path("D:/claude/fantasy nba/.qa/stress/agent-8.md")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    log(f"\nReport written to {out}")
    log(f"TOTAL: {pass_count} PASS, {fail_count} FAIL")


if __name__ == "__main__":
    main()
