"""
Stress-test for unbalanced N-for-M trade system (v0.5.39+).
Targets http://127.0.0.1:3500 (isolated QA server).

Steps:
  1. Setup league via /api/league/setup
  2. Auto-draft (flip team 0 to AI, draft, flip back)
  3. Start season, advance 30 days to build FPPG spread
  4. Submit 30+ trade proposals (1-for-1, 2-for-1, 1-for-2, 3-for-1, 2-for-3, 3-for-3)
     including fair, lopsided, edge cases (empty list, duplicate IDs, wrong roster)
  5. Advance days to trigger AI evaluation
  6. Verify roster integrity for executed trades
  7. Check /api/trades/history + /api/trades/pending consistency
  8. Write findings to .qa/stress/agent-1.md
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import requests

BASE = "http://127.0.0.1:3500"
OUT_DIR = Path(r"D:\claude\fantasy nba\.qa\stress")
OUT_DIR.mkdir(parents=True, exist_ok=True)

findings: list[str] = []
errors: list[str] = []
stats = {
    "submitted": 0,
    "accepted": 0,
    "rejected": 0,
    "countered": 0,
    "vetoed": 0,
    "expired": 0,
    "edge_400_ok": 0,
    "edge_unexpected": 0,
    "roster_violations": 0,
    "http_500s": 0,
    "fairness_issues": [],
}


def log(msg: str) -> None:
    ts = time.strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    findings.append(line)
    sys.stdout.buffer.write((line + "\n").encode("utf-8", errors="replace"))
    sys.stdout.buffer.flush()


def api(method: str, path: str, **kwargs) -> tuple[int, Any]:
    url = BASE + path
    try:
        resp = getattr(requests, method)(url, timeout=30, **kwargs)
        status = resp.status_code
        try:
            body = resp.json()
        except Exception:
            body = resp.text
        if status == 500:
            stats["http_500s"] += 1
            log(f"  ERROR 500: {method.upper()} {path} -> {str(body)[:300]}")
        return status, body
    except requests.exceptions.RequestException as exc:
        log(f"  CONN ERROR: {method.upper()} {path} -> {exc}")
        stats["http_500s"] += 1
        return 0, None


def wait_for_server(retries: int = 20) -> bool:
    for i in range(retries):
        try:
            resp = requests.get(BASE + "/api/health", timeout=3)
            if resp.status_code == 200:
                log(f"Server ready: {resp.json()}")
                return True
        except Exception:
            pass
        time.sleep(1)
    return False


def setup_league() -> None:
    log("=== Step 1: Setup league ===")
    status, body = api("post", "/api/league/setup", json={
        "league_name": "stress1",
        "season_year": "2025-26",
        "player_team_index": 0,
        "team_names": ["我的隊伍", "BPA Nerd", "Punt TO", "Stars & Scrubs",
                       "Balanced Builder", "Youth Upside", "Vet Win-Now", "Contrarian"],
        "randomize_draft_order": False,
        "num_teams": 8,
        "roster_size": 13,
        "starters_per_day": 10,
        "il_slots": 3,
        "scoring_weights": {"pts": 1.0, "reb": 1.2, "ast": 1.5, "stl": 2.5, "blk": 2.5, "to": -1.0},
        "regular_season_weeks": 20,
        "playoff_teams": 6,
        "trade_deadline_week": None,
        "ai_trade_frequency": "normal",
        "ai_trade_style": "balanced",
        "ai_decision_mode": "auto",
        "veto_threshold": 3,
        "veto_window_days": 2,
        "setup_complete": True,
        "use_openrouter": False,
    })
    log(f"  league/setup -> {status}")
    if status not in (200, 201):
        log(f"  WARN: setup body: {body}")


def auto_draft() -> None:
    log("=== Step 2: Auto-draft ===")
    # Reset with clean slate
    status, body = api("post", "/api/draft/reset", json={"randomize_order": False, "seed": 42})
    log(f"  draft/reset -> {status}")

    # Advance AI picks for all teams (team 0 is human, so sim-to-me first then ai-advance)
    # We'll just call sim-to-me repeatedly which handles full draft
    picks_done = 0
    for _ in range(200):  # 8 teams × 13 rounds = 104 picks max
        status, body = api("post", "/api/draft/state") if False else (None, None)
        # Check state
        s2, state = api("get", "/api/state")
        if s2 != 200 or state is None:
            break
        if state.get("is_complete"):
            break
        current_team = state.get("current_team_id")
        human_team = state.get("human_team_id")
        if current_team == human_team:
            # Use sim-to-me to skip human picks by advancing AI picks up to human
            # Actually we need to pick for human too — pick best available
            avail_status, avail = api("get", "/api/players?available=true&limit=1")
            if avail_status == 200 and avail:
                pid = avail[0]["id"]
                ps, pb = api("post", "/api/draft/pick", json={"player_id": pid})
                if ps == 200:
                    picks_done += 1
        else:
            s3, b3 = api("post", "/api/draft/ai-advance")
            if s3 == 200:
                picks_done += 1
            elif s3 == 409:
                # It's human's turn
                avail_status, avail = api("get", "/api/players?available=true&limit=1")
                if avail_status == 200 and avail:
                    pid = avail[0]["id"]
                    api("post", "/api/draft/pick", json={"player_id": pid})
                    picks_done += 1

    log(f"  draft done: {picks_done} picks processed")

    # Verify
    s2, state = api("get", "/api/state")
    log(f"  draft is_complete={state.get('is_complete') if state else '?'}")


def start_season() -> None:
    log("=== Step 3: Start season ===")
    # Clear any previous season
    api("post", "/api/season/reset")
    status, body = api("post", "/api/season/start")
    log(f"  season/start -> {status}")
    if status not in (200, 201):
        log(f"  body: {str(body)[:200]}")


def advance_days(n: int, use_ai: bool = False) -> None:
    log(f"=== Advancing {n} days (use_ai={use_ai}) ===")
    for i in range(n):
        status, body = api("post", "/api/season/advance-day", json={"use_ai": use_ai})
        if status != 200:
            log(f"  advance-day {i+1} -> {status}")
            break
        if (i + 1) % 7 == 0:
            state_info = body
            log(f"  day {state_info.get('current_day','?')} week {state_info.get('current_week','?')}")


def get_rosters() -> dict[int, list[int]]:
    """Returns {team_id: [player_ids]}"""
    rosters: dict[int, list[int]] = {}
    for tid in range(8):
        s, b = api("get", f"/api/teams/{tid}")
        if s == 200 and b:
            rosters[tid] = [p["id"] for p in b.get("players", [])]
    return rosters


def get_team_roster_sorted_by_fppg(team_id: int) -> list[dict]:
    """Returns players sorted by fppg descending."""
    s, b = api("get", f"/api/teams/{team_id}")
    if s != 200 or not b:
        return []
    players = b.get("players", [])
    return sorted(players, key=lambda p: p.get("fppg", 0), reverse=True)


def propose(from_team: int, to_team: int, send: list[int], receive: list[int],
            msg: str = "") -> tuple[int, Any]:
    stats["submitted"] += 1
    return api("post", "/api/trades/propose", json={
        "from_team": from_team,
        "to_team": to_team,
        "send": send,
        "receive": receive,
        "proposer_message": msg,
    })


def submit_trades() -> None:
    log("=== Step 4: Submitting trades ===")

    # Get current rosters
    rosters = get_rosters()
    log(f"  roster sizes: { {tid: len(r) for tid, r in rosters.items()} }")

    # Get FPPG-sorted rosters for each team
    team_data: dict[int, list[dict]] = {}
    for tid in range(8):
        team_data[tid] = get_team_roster_sorted_by_fppg(tid)
        log(f"  T{tid} top3: {[(p['name'], round(p.get('fppg',0),1)) for p in team_data[tid][:3]]}")

    human_id = 0  # team 0 is human

    def human_roster() -> list[dict]:
        return team_data[0]

    def ai_roster(tid: int) -> list[dict]:
        return team_data[tid]

    results: list[tuple[str, int, Any]] = []

    # ---- 1-for-1: fair (top star for comparable star with T1) ----
    h = human_roster()
    a1 = ai_roster(1)
    if h and a1:
        label = "1-for-1 fair (top swap)"
        s, b = propose(human_id, 1, [h[0]["id"]], [a1[0]["id"]], "Fair star swap")
        results.append((label, s, b))
        log(f"  [{label}] -> {s}")

    # ---- 1-for-1: lopsided (bench for star) ----
    if len(h) >= 13 and a1:
        label = "1-for-1 lopsided (bench for star)"
        s, b = propose(human_id, 1, [h[-1]["id"]], [a1[0]["id"]], "Giving bench for their star")
        results.append((label, s, b))
        log(f"  [{label}] -> {s}")

    # ---- 2-for-1: send 2 bench, get 1 star from T2 ----
    a2 = ai_roster(2)
    if len(h) >= 13 and len(a2) >= 1:
        label = "2-for-1 (2 bench for 1 star)"
        s, b = propose(human_id, 2, [h[-1]["id"], h[-2]["id"]], [a2[0]["id"]], "2 bench for their star")
        results.append((label, s, b))
        log(f"  [{label}] -> {s}")

    # ---- 1-for-2: send 1 star, get 2 from T3 ----
    a3 = ai_roster(3)
    if h and len(a3) >= 2:
        label = "1-for-2 (1 star for 2 mid)"
        s, b = propose(human_id, 3, [h[0]["id"]], [a3[4]["id"], a3[5]["id"]] if len(a3) > 5 else [a3[0]["id"], a3[1]["id"]])
        results.append((label, s, b))
        log(f"  [{label}] -> {s}")

    # ---- 3-for-1: send 3 bench, get 1 star from T4 ----
    a4 = ai_roster(4)
    if len(h) >= 13 and a4:
        label = "3-for-1 (3 bench for 1 star)"
        s, b = propose(human_id, 4, [h[-1]["id"], h[-2]["id"], h[-3]["id"]], [a4[0]["id"]])
        results.append((label, s, b))
        log(f"  [{label}] -> {s}")

    # ---- 2-for-3: send 2 mid, get 3 bench from T5 ----
    a5 = ai_roster(5)
    if len(h) >= 7 and len(a5) >= 13:
        label = "2-for-3 (2 mid for 3 bench)"
        s, b = propose(human_id, 5, [h[5]["id"], h[6]["id"]], [a5[-1]["id"], a5[-2]["id"], a5[-3]["id"]])
        results.append((label, s, b))
        log(f"  [{label}] -> {s}")

    # ---- 3-for-3: balanced mid-tier swap with T6 ----
    a6 = ai_roster(6)
    if len(h) >= 9 and len(a6) >= 9:
        label = "3-for-3 balanced"
        s, b = propose(human_id, 6, [h[3]["id"], h[4]["id"], h[5]["id"]], [a6[3]["id"], a6[4]["id"], a6[5]["id"]])
        results.append((label, s, b))
        log(f"  [{label}] -> {s}")

    # ---- 3-for-3: lopsided (3 bench for 3 starters) ----
    a7 = ai_roster(7)
    if len(h) >= 13 and len(a7) >= 3:
        label = "3-for-3 lopsided (bench vs starters)"
        s, b = propose(human_id, 7, [h[-1]["id"], h[-2]["id"], h[-3]["id"]], [a7[0]["id"], a7[1]["id"], a7[2]["id"]])
        results.append((label, s, b))
        log(f"  [{label}] -> {s}")

    # ---- Additional 1-for-1 fair proposals to different teams ----
    for tid in range(1, 8):
        at = ai_roster(tid)
        hr = human_roster()
        if len(hr) >= 6 and len(at) >= 6:
            # mid-tier swap
            label = f"1-for-1 mid T{tid}"
            s, b = propose(human_id, tid, [hr[5]["id"]], [at[5]["id"]])
            results.append((label, s, b))
            log(f"  [{label}] -> {s}")

    # ---- More 2-for-1 variants ----
    for tid in [1, 2, 3]:
        at = ai_roster(tid)
        hr = human_roster()
        if len(hr) >= 8 and len(at) >= 2:
            label = f"2-for-1 mid T{tid}"
            s, b = propose(human_id, tid, [hr[4]["id"], hr[5]["id"]], [at[1]["id"]])
            results.append((label, s, b))
            log(f"  [{label}] -> {s}")

    # ---- 1-for-2 more ----
    for tid in [4, 5]:
        at = ai_roster(tid)
        hr = human_roster()
        if len(hr) >= 3 and len(at) >= 8:
            label = f"1-for-2 star T{tid}"
            s, b = propose(human_id, tid, [hr[2]["id"]], [at[5]["id"], at[6]["id"]])
            results.append((label, s, b))
            log(f"  [{label}] -> {s}")

    # ---- 2-for-3 more ----
    for tid in [6, 7]:
        at = ai_roster(tid)
        hr = human_roster()
        if len(hr) >= 7 and len(at) >= 9:
            label = f"2-for-3 T{tid}"
            s, b = propose(human_id, tid, [hr[4]["id"], hr[5]["id"]], [at[6]["id"], at[7]["id"], at[8]["id"]])
            results.append((label, s, b))
            log(f"  [{label}] -> {s}")

    # ---- edge: empty send list ----
    log("  --- edge cases ---")
    stats["submitted"] -= 1  # don't count edge as valid proposal
    s, b = api("post", "/api/trades/propose", json={
        "from_team": 0, "to_team": 1, "send": [], "receive": [a1[0]["id"] if a1 else 999]
    })
    if s == 400:
        stats["edge_400_ok"] += 1
        log(f"  [edge: empty send] -> 400 OK (expected)")
    else:
        stats["edge_unexpected"] += 1
        log(f"  [edge: empty send] -> {s} UNEXPECTED")

    # ---- edge: empty receive list ----
    s, b = api("post", "/api/trades/propose", json={
        "from_team": 0, "to_team": 1, "send": [h[0]["id"] if h else 999], "receive": []
    })
    if s == 400:
        stats["edge_400_ok"] += 1
        log(f"  [edge: empty receive] -> 400 OK (expected)")
    else:
        stats["edge_unexpected"] += 1
        log(f"  [edge: empty receive] -> {s} UNEXPECTED")

    # ---- edge: duplicate IDs in send ----
    if h:
        pid = h[0]["id"]
        s, b = api("post", "/api/trades/propose", json={
            "from_team": 0, "to_team": 1, "send": [pid, pid], "receive": [a1[0]["id"] if a1 else 999]
        })
        if s == 400:
            stats["edge_400_ok"] += 1
            log(f"  [edge: duplicate send] -> 400 OK (expected)")
        else:
            stats["edge_unexpected"] += 1
            log(f"  [edge: duplicate send] -> {s} UNEXPECTED")

    # ---- edge: player not on roster (wrong team) ----
    if a1:
        wrong_pid = a1[0]["id"]  # a1's player, sending as if it's human's
        s, b = api("post", "/api/trades/propose", json={
            "from_team": 0, "to_team": 2, "send": [wrong_pid], "receive": [a2[0]["id"] if a2 else 999]
        })
        if s == 400:
            stats["edge_400_ok"] += 1
            log(f"  [edge: player not on proposer roster] -> 400 OK (expected)")
        else:
            stats["edge_unexpected"] += 1
            log(f"  [edge: player not on proposer roster] -> {s} UNEXPECTED")

    # ---- edge: same player on both sides ----
    if h and a1:
        pid = h[0]["id"]
        s, b = api("post", "/api/trades/propose", json={
            "from_team": 0, "to_team": 1,
            "send": [pid],
            "receive": [pid]  # same player
        })
        if s == 400:
            stats["edge_400_ok"] += 1
            log(f"  [edge: same player both sides] -> 400 OK (expected)")
        else:
            stats["edge_unexpected"] += 1
            log(f"  [edge: same player both sides] -> {s} UNEXPECTED")

    log(f"  Total submitted: {stats['submitted']}, edge 400s: {stats['edge_400_ok']}")
    return results


def wait_for_ai_decisions(max_wait_secs: int = 60) -> None:
    """Poll pending trades until all AI-counterparty trades are decided (or timeout)."""
    log(f"  Waiting up to {max_wait_secs}s for AI decisions...")
    deadline = time.time() + max_wait_secs
    while time.time() < deadline:
        s, body = api("get", "/api/trades/pending")
        if s != 200 or body is None:
            break
        pending = body.get("pending", [])
        # Count pending trades where counterparty is AI (not human=team 0)
        ai_pending = [t for t in pending if t.get("status") == "pending_accept" and t.get("to_team") != 0]
        if not ai_pending:
            log(f"  All AI decisions complete ({len(pending)} total pending remain)")
            break
        time.sleep(2)
    else:
        log(f"  Timeout waiting for AI decisions")


def advance_past_veto_window() -> None:
    """Advance 3 days to clear the 2-day veto window."""
    log("=== Step 5: Advancing 3 days past veto window ===")
    for i in range(3):
        status, body = api("post", "/api/season/advance-day", json={"use_ai": False})
        if status != 200:
            log(f"  advance-day failed: {status}")
            break
    log("  Done advancing past veto window")


def verify_roster_integrity() -> dict:
    log("=== Step 6: Verifying roster integrity ===")

    # Get history
    s, body = api("get", "/api/trades/history?limit=200")
    if s != 200 or body is None:
        log("  ERROR: cannot fetch trade history")
        return {}

    history = body.get("history", [])
    executed = [t for t in history if t.get("status") == "executed"]

    log(f"  executed trades to verify: {len(executed)}")

    # Get current rosters
    rosters = get_rosters()

    # Check no player on two rosters
    all_players: dict[int, int] = {}  # player_id -> team_id
    duplicates: list[tuple[int, int, int]] = []  # (player_id, team_a, team_b)
    for tid, roster in rosters.items():
        for pid in roster:
            if pid in all_players:
                duplicates.append((pid, all_players[pid], tid))
            else:
                all_players[pid] = tid

    if duplicates:
        stats["roster_violations"] += len(duplicates)
        for pid, ta, tb in duplicates:
            log(f"  VIOLATION: player {pid} on both T{ta} and T{tb}")

    # Check roster sizes = 13
    size_violations = []
    for tid, roster in rosters.items():
        if len(roster) != 13:
            size_violations.append((tid, len(roster)))
            stats["roster_violations"] += 1
            log(f"  VIOLATION: T{tid} has {len(roster)} players (expected 13)")

    # Check executed trades have '自動丟棄替補' in reasoning when N≠M
    drop_annotations = 0
    missing_drop_annotations = []
    for t in executed:
        n_send = len(t.get("send_player_ids", []))
        n_recv = len(t.get("receive_player_ids", []))
        if n_send != n_recv:
            reasoning = t.get("reasoning", "")
            if "自動丟棄替補" in reasoning:
                drop_annotations += 1
            else:
                missing_drop_annotations.append({
                    "id": t["id"][:8],
                    "n_send": n_send,
                    "n_recv": n_recv,
                    "reasoning": reasoning[:100],
                })

    log(f"  Roster size violations: {len(size_violations)}")
    log(f"  Duplicate player violations: {len(duplicates)}")
    log(f"  N≠M trades with 自動丟棄替補 annotation: {drop_annotations}")
    if missing_drop_annotations:
        log(f"  N≠M trades MISSING drop annotation: {len(missing_drop_annotations)}")
        for m in missing_drop_annotations[:5]:
            log(f"    {m}")

    return {
        "size_violations": size_violations,
        "duplicate_violations": duplicates,
        "drop_annotations": drop_annotations,
        "missing_drop_annotations": missing_drop_annotations,
    }


def tally_results() -> None:
    log("=== Step 7: Tallying trade results ===")

    s, body = api("get", "/api/trades/history?limit=200")
    if s != 200 or body is None:
        log("  ERROR: cannot fetch history")
        return

    history = body.get("history", [])

    s2, pending_body = api("get", "/api/trades/pending")
    if s2 != 200 or pending_body is None:
        log("  ERROR: cannot fetch pending")
        return

    pending = pending_body.get("pending", [])

    # Count statuses
    status_counts: dict[str, int] = {}
    for t in history:
        st = t.get("status", "unknown")
        status_counts[st] = status_counts.get(st, 0) + 1
    for t in pending:
        st = t.get("status", "unknown")
        status_counts[st] = status_counts.get(st, 0) + 1

    log(f"  Status breakdown: {status_counts}")

    stats["accepted"] = status_counts.get("accepted", 0) + status_counts.get("executed", 0)
    stats["rejected"] = status_counts.get("rejected", 0)
    stats["countered"] = status_counts.get("countered", 0)
    stats["vetoed"] = status_counts.get("vetoed", 0)
    stats["expired"] = status_counts.get("expired", 0)

    # Consistency check: all pending in /pending should not appear in /history
    pending_ids = {t["id"] for t in pending}
    history_ids = {t["id"] for t in history}
    overlap = pending_ids & history_ids
    if overlap:
        log(f"  CONSISTENCY VIOLATION: {len(overlap)} trades appear in both pending and history: {list(overlap)[:3]}")
        stats["roster_violations"] += len(overlap)
    else:
        log(f"  Pending/history consistency: OK (no overlap)")

    # Fairness audit: flag suspicious decisions
    for t in history:
        if t.get("status") not in ("executed", "accepted"):
            continue
        send_ids = t.get("send_player_ids", [])
        recv_ids = t.get("receive_player_ids", [])
        if len(send_ids) == 1 and len(recv_ids) == 1:
            # 1-for-1: check if reasoning hints at clearly unfair accepted trade
            reasoning = t.get("reasoning", "")
            if "penalty" in reasoning:
                import re
                m = re.search(r"penalty=(\d+\.\d+)", reasoning)
                if m and float(m.group(1)) > 0.35:
                    issue = f"Accepted 1-for-1 with penalty={m.group(1)}: {reasoning[:120]}"
                    stats["fairness_issues"].append(issue)
                    log(f"  FAIRNESS? {issue}")

    log(f"  Fairness issues flagged: {len(stats['fairness_issues'])}")


def write_report(integrity: dict) -> None:
    log("=== Writing report ===")

    lines = [
        "# Stress Test Report — v0.5.39 N-for-M Trade System",
        "",
        f"**Date**: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"**Target**: {BASE}  |  league: stress1",
        "",
        "## Summary",
        "",
        f"| Metric | Value |",
        f"|--------|-------|",
        f"| Trades submitted | {stats['submitted']} |",
        f"| Accepted/Executed | {stats['accepted']} |",
        f"| Rejected | {stats['rejected']} |",
        f"| Countered | {stats['countered']} |",
        f"| Vetoed | {stats['vetoed']} |",
        f"| Expired | {stats['expired']} |",
        f"| Edge cases → 400 (expected) | {stats['edge_400_ok']} |",
        f"| Edge cases → unexpected response | {stats['edge_unexpected']} |",
        f"| HTTP 500 errors | {stats['http_500s']} |",
        f"| Roster integrity violations | {stats['roster_violations']} |",
        "",
        "## Roster Integrity",
        "",
    ]

    size_viols = integrity.get("size_violations", [])
    dup_viols = integrity.get("duplicate_violations", [])
    missing_drops = integrity.get("missing_drop_annotations", [])

    if not size_viols and not dup_viols:
        lines.append("All rosters at exactly 13 players. No player appears on two rosters. **PASS**")
    else:
        if size_viols:
            lines.append(f"**FAIL** — {len(size_viols)} teams with wrong roster size:")
            for tid, sz in size_viols:
                lines.append(f"  - T{tid}: {sz} players")
        if dup_viols:
            lines.append(f"**FAIL** — {len(dup_viols)} duplicate player appearances:")
            for pid, ta, tb in dup_viols:
                lines.append(f"  - player {pid} on T{ta} and T{tb}")

    lines.append("")
    lines.append("## Drop Annotation (自動丟棄替補)")
    lines.append("")
    n_annotated = integrity.get("drop_annotations", 0)
    if missing_drops:
        lines.append(f"**WARN** — {len(missing_drops)} N≠M executed trades missing '自動丟棄替補' annotation:")
        for m in missing_drops[:10]:
            lines.append(f"  - id={m['id']} ({m['n_send']}→{m['n_recv']}): `{m['reasoning']}`")
    else:
        lines.append(f"All N≠M executed trades have '自動丟棄替補' annotation (count={n_annotated}). **PASS** (or no N≠M trades executed)")

    lines.append("")
    lines.append("## Edge Case Validation")
    lines.append("")
    lines.append(f"- Empty send/receive list → 400: {'PASS' if stats['edge_400_ok'] >= 2 else 'FAIL'}")
    lines.append(f"- Duplicate IDs → 400: {'PASS' if stats['edge_400_ok'] >= 3 else 'PARTIAL'}")
    lines.append(f"- Player not on roster → 400: {'PASS' if stats['edge_400_ok'] >= 4 else 'PARTIAL'}")
    lines.append(f"- Same player both sides → 400: {'PASS' if stats['edge_400_ok'] >= 5 else 'PARTIAL'}")

    lines.append("")
    lines.append("## Fairness Observations")
    lines.append("")
    if stats["fairness_issues"]:
        lines.append(f"**{len(stats['fairness_issues'])} possible fairness misjudgements:**")
        for issue in stats["fairness_issues"][:10]:
            lines.append(f"  - {issue}")
    else:
        lines.append("No obvious fairness misjudgements detected.")

    lines.append("")
    lines.append("## Crashes / 500 Errors")
    lines.append("")
    if stats["http_500s"] == 0:
        lines.append("No 500 errors. **PASS**")
    else:
        lines.append(f"**{stats['http_500s']} HTTP 500 errors encountered.**")

    lines.append("")
    lines.append("## Detailed Log")
    lines.append("")
    lines.append("```")
    lines.extend(findings)
    lines.append("```")

    report_path = OUT_DIR / "agent-1.md"
    report_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nReport written to: {report_path}")


def main() -> int:
    if not wait_for_server():
        print("ERROR: server not reachable at", BASE)
        return 1

    setup_league()
    auto_draft()
    start_season()
    advance_days(30, use_ai=False)  # advance 30 days for FPPG spread, no AI to save time

    submit_trades()

    # Wait for background AI decisions (server fires them in background tasks)
    wait_for_ai_decisions(max_wait_secs=90)

    # Advance past veto window to execute accepted trades
    advance_past_veto_window()

    # Give one more poll window
    time.sleep(3)

    tally_results()
    integrity = verify_roster_integrity()
    write_report(integrity)

    # Summary exit code
    if stats["roster_violations"] > 0 or stats["http_500s"] > 0 or stats["edge_unexpected"] > 0:
        log("OVERALL: FAIL (see violations above)")
        return 1

    log("OVERALL: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
