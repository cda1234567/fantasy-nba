"""Full-season end-to-end stress test for Fantasy NBA (agent-9)."""
from __future__ import annotations

import json
import os
import random
import sys
import time
from pathlib import Path

import requests

BASE = "http://localhost:3508"
DATA_DIR = Path(r"D:\claude\fantasy nba\.qa\stress\data-9")
REPORT_PATH = Path(r"D:\claude\fantasy nba\.qa\stress\agent-9.md")

errors: list[str] = []
start_time = time.time()


def get(path: str, **kw) -> dict:
    r = requests.get(f"{BASE}{path}", **kw)
    if r.status_code >= 400:
        raise RuntimeError(f"GET {path} → {r.status_code}: {r.text[:200]}")
    return r.json()


def post(path: str, body: dict | None = None, **kw) -> dict:
    r = requests.post(f"{BASE}{path}", json=body or {}, **kw)
    if r.status_code >= 400:
        raise RuntimeError(f"POST {path} → {r.status_code}: {r.text[:200]}")
    return r.json()


# ── 0. Clear any prior state ─────────────────────────────────────────────────
print("[0] Clearing prior state...")
try:
    post("/api/season/reset")
    post("/api/draft/reset", {"randomize_order": False})
except Exception as e:
    print(f"    Pre-clear (non-fatal): {e}")

# ── 1. Setup league ─────────────────────────────────────────────────────────
print("[1] Setting up league...")
seasons = get("/api/seasons/list")["seasons"]
season_year = seasons[0] if seasons else "2024-25"
print(f"    Using season: {season_year}")

setup_payload = {
    "num_teams": 8,
    "player_team_index": 0,
    "team_names": [
        "StressTeam", "AITeam1", "AITeam2", "AITeam3",
        "AITeam4", "AITeam5", "AITeam6", "AITeam7",
    ],
    "season_year": season_year,
    "roster_size": 13,
    "starters_per_day": 10,
    "il_slots": 2,
    "regular_season_weeks": 20,
    "randomize_draft_order": True,
    "setup_complete": False,
    "ai_trade_frequency": "normal",
    "ai_trade_style": "balanced",
    "ai_decision_mode": "fast",
    "draft_display_mode": "auto",
    "show_offseason_headlines": False,
    "league_name": "StressLeague9",
}
result = post("/api/league/setup", setup_payload)
print(f"    Setup OK, draft is_complete={result.get('is_complete')}")

# ── 2. Autodraft ─────────────────────────────────────────────────────────────
print("[2] Auto-drafting all picks...")
draft_picks = 0
while True:
    state = get("/api/state")
    if state["is_complete"]:
        break
    team_id = state["current_team_id"]
    human_team_id = state["human_team_id"]
    if team_id == human_team_id:
        # Human pick: grab the top available player
        players = get("/api/players?available=true&limit=5")
        if not players:
            errors.append("No players available for human pick")
            break
        pid = players[0]["id"]
        post("/api/draft/pick", {"player_id": pid})
    else:
        post("/api/draft/ai-advance")
    draft_picks += 1
    if draft_picks > 200:
        errors.append("Draft exceeded 200 picks — aborting draft loop")
        break

print(f"    Draft complete: {draft_picks} picks")

# ── 3. Start season ──────────────────────────────────────────────────────────
print("[3] Starting season...")
season_state = post("/api/season/start")
print(f"    Season started, week={season_state.get('current_week')}, day={season_state.get('current_day')}")

# ── 4. Advance season with trades & FA claims ────────────────────────────────
print("[4] Advancing season (advance-week) + trades + FA claims...")

trades_done = 0
fa_done = 0
week = 0
max_weeks = 30  # safety cap

while True:
    standings = get("/api/season/standings")
    current_week = standings["current_week"]
    is_playoffs = standings["is_playoffs"]
    champion = standings["champion"]

    if champion is not None:
        print(f"    Champion found at week {current_week}!")
        break

    if week >= max_weeks:
        errors.append(f"Exceeded {max_weeks} advance-week calls without champion")
        break

    # Inject 3-5 trades + 5 FA claims at random points during regular season
    if not is_playoffs and current_week > 0:
        # FA claim: drop last roster player, add random FA
        if fa_done < 5 and current_week % 3 == 0 and current_week > 0:
            try:
                teams_raw = get("/api/season/standings")["standings"]
                human_team = next((t for t in teams_raw if t.get("team_id") == 0), None)
                if human_team:
                    team_detail = get(f"/api/teams/0")
                    roster = team_detail["team"]["roster"]
                    fa_players = get("/api/players?available=true&limit=20")
                    # find a FA not on any roster
                    if roster and fa_players:
                        drop_id = roster[-1]  # drop last player
                        add_id = fa_players[0]["id"]
                        r = post("/api/fa/claim", {"drop_player_id": drop_id, "add_player_id": add_id})
                        fa_done += 1
                        print(f"    FA claim #{fa_done}: drop={r.get('drop')} add={r.get('add')}")
            except Exception as e:
                errors.append(f"FA claim failed at week {current_week}: {e}")

        # Trade: propose from human (team 0) to team 1
        if trades_done < 5 and current_week % 4 == 1:
            try:
                my_detail = get("/api/teams/0")
                their_detail = get("/api/teams/1")
                my_roster = my_detail["team"]["roster"]
                their_roster = their_detail["team"]["roster"]
                if len(my_roster) >= 2 and len(their_roster) >= 2:
                    send_id = my_roster[0]
                    recv_id = their_roster[0]
                    trade_r = post("/api/trades/propose", {
                        "from_team": 0,
                        "to_team": 1,
                        "send": [send_id],
                        "receive": [recv_id],
                        "proposer_message": "stress test trade",
                        "force": True,
                    })
                    trades_done += 1
                    print(f"    Trade #{trades_done} proposed: status={trade_r.get('status', trade_r.get('ok'))}")
            except Exception as e:
                errors.append(f"Trade propose failed at week {current_week}: {e}")

    # Advance one week
    try:
        result = post("/api/season/advance-week", {"use_ai": False})
        week += 1
        new_week = result.get("current_week", "?")
        champ = result.get("champion")
        print(f"    Week {new_week} done | playoffs={result.get('is_playoffs')} | champion={champ}")
        if champ is not None:
            break
    except Exception as e:
        errors.append(f"advance-week failed at week {current_week}: {e}")
        break

print(f"    Trades proposed: {trades_done}, FA claims: {fa_done}")

# ── 5. Validation ────────────────────────────────────────────────────────────
print("[5] Validating season summary...")
summary = get("/api/season/summary")

# 5a. Check summary fields
missing_fields = []
for field in ["mvp", "season_leaders", "top_games"]:
    if field not in summary or summary[field] is None:
        missing_fields.append(field)
if len(summary.get("season_leaders", [])) < 10:
    missing_fields.append(f"season_leaders only {len(summary.get('season_leaders', []))} entries (expected 10)")
if len(summary.get("top_games", [])) < 5:
    missing_fields.append(f"top_games only {len(summary.get('top_games', []))} entries (expected 5)")

# Human record
human_record = None
for row in summary.get("final_standings", []):
    if row.get("is_human"):
        human_record = f"{row['w']}-{row['l']}"
        break

print(f"    MVP: {summary.get('mvp', {}).get('name') if summary.get('mvp') else 'MISSING'}")
print(f"    Season leaders: {len(summary.get('season_leaders', []))}")
print(f"    Top games: {len(summary.get('top_games', []))}")
print(f"    Human record: {human_record}")
print(f"    Champion: {summary.get('champion_name')}")

# 5b. W+L sanity check for all teams (regular season only: 14 weeks, 7 opponents each team plays twice = 14 matchups)
# With 8 teams and 14 regular weeks, each team plays 14 games
print("[5b] Checking W+L totals...")
standings = get("/api/season/standings")
settings_data = get("/api/league/settings")
reg_weeks = settings_data.get("regular_season_weeks", 14)
wl_issues = []
for row in summary.get("final_standings", []):
    total = row["w"] + row["l"]
    if total != reg_weeks:
        wl_issues.append(f"Team {row['name']}: W={row['w']} L={row['l']} total={total} (expected {reg_weeks})")

# 5c. Playoff bracket check
print("[5c] Checking playoff champion is in playoff bracket...")
champion_id = summary.get("champion_id")
if champion_id is None:
    errors.append("No champion found after full season!")
else:
    # Champion must have been top-6 at end of regular season
    # Sort by W,PF for top 6
    all_standings = summary.get("final_standings", [])
    top6 = [r["team_id"] for r in all_standings[:6]]
    if champion_id not in top6:
        errors.append(f"Champion team_id={champion_id} is NOT in top-6 standings: {top6}")
    else:
        print(f"    Champion team_id={champion_id} is in top-6 ✓")

# 5d. game_logs bounded
state_raw = None
season_file = DATA_DIR / "leagues" / "default" / "season.json"
game_logs_count = 0
injury_history_count = 0
if season_file.exists():
    raw = json.loads(season_file.read_text(encoding="utf-8"))
    game_logs_count = len(raw.get("game_logs", []))
    injury_history_count = len(raw.get("injury_history", []))
    print(f"    game_logs length: {game_logs_count}")
    print(f"    injury_history length: {injury_history_count}")
    if game_logs_count > 5000:
        errors.append(f"game_logs too large: {game_logs_count} entries (expected trimmed)")
    if not (15 <= injury_history_count <= 80):
        errors.append(f"injury_history count {injury_history_count} out of expected range 15-80")
else:
    errors.append(f"season.json not found at {season_file}")

# 5f. Trades history
print("[5f] Checking trades history...")
trades_hist = get("/api/trades/history")
trade_entries = trades_hist.get("trades", trades_hist.get("history", []))
print(f"    Trade history entries: {len(trade_entries)}")

# 5g. Seasons list
print("[5g] Checking seasons list...")
seasons_list = get("/api/seasons/list")
print(f"    Seasons available: {seasons_list.get('seasons', [])}")

# ── 6. File sizes ────────────────────────────────────────────────────────────
print("[6] Checking file sizes...")
league_dir = DATA_DIR / "leagues" / "default"
season_json = league_dir / "season.json"
draft_json = league_dir / "draft.json"

season_size_mb = season_json.stat().st_size / 1_000_000 if season_json.exists() else 0
draft_size_mb = draft_json.stat().st_size / 1_000_000 if draft_json.exists() else 0

print(f"    season.json: {season_size_mb:.3f} MB")
print(f"    draft.json:  {draft_size_mb:.3f} MB")

if season_size_mb > 5:
    errors.append(f"season.json too large: {season_size_mb:.2f} MB > 5MB")
if draft_size_mb > 5:
    errors.append(f"draft.json too large: {draft_size_mb:.2f} MB > 5MB")

# ── 7. Season reset ──────────────────────────────────────────────────────────
print("[7] Testing season reset...")
reset_r = post("/api/season/reset")
print(f"    Reset response: {reset_r}")

# After reset, season should be gone but draft should remain
try:
    season_after = get("/api/season/standings")
    # standings endpoint returns empty data when no season, not 409
    if season_after.get("current_week", 0) == 0 and season_after.get("champion") is None:
        print("    Season cleared ✓")
    else:
        errors.append(f"Season not cleared after reset: champion={season_after.get('champion')}")
except Exception as e:
    # 409 is also acceptable - means season was cleared
    if "409" in str(e) or "賽季尚未" in str(e):
        print("    Season cleared (409 as expected) ✓")
    else:
        errors.append(f"Unexpected error after reset: {e}")

draft_after = get("/api/state")
if draft_after.get("is_complete"):
    print("    Draft still intact after reset ✓")
else:
    errors.append("Draft not intact after season reset!")

# ── 8. Write report ──────────────────────────────────────────────────────────
elapsed = time.time() - start_time
print(f"\n[Report] Writing to {REPORT_PATH} (elapsed: {elapsed:.1f}s)")

champ_name = summary.get("champion_name", "UNKNOWN")
mvp_name = summary.get("mvp", {}).get("name", "N/A") if summary.get("mvp") else "N/A"

wl_summary = "ALL OK" if not wl_issues else "\n  - " + "\n  - ".join(wl_issues)
errors_summary = "None" if not errors else "\n  - " + "\n  - ".join(errors)
missing_summary = "None" if not missing_fields else ", ".join(missing_fields)

report = f"""# Fantasy NBA Full-Season Stress Test — Agent 9

**Run date:** {time.strftime('%Y-%m-%d %H:%M:%S')}
**Total run time:** {elapsed:.1f}s

## Final Standings Sanity (W+L)
Regular-season weeks configured: {reg_weeks}
W+L issues: {wl_summary}

## Championship Correctness
Champion: **{champ_name}** (team_id={champion_id})
MVP: {mvp_name}
Champion in top-6 playoff seeds: {"YES" if champion_id is not None and champion_id in [r["team_id"] for r in summary.get("final_standings", [])[:6]] else "NO/UNKNOWN"}

## Summary Completeness
Missing fields: {missing_summary}
season_leaders count: {len(summary.get("season_leaders", []))} (expected 10)
top_games count: {len(summary.get("top_games", []))} (expected 5)
Human record: {human_record}

## game_logs & injury_history
game_logs entries: {game_logs_count} (trimmed={game_logs_count <= 5000})
injury_history entries: {injury_history_count} (expected 15-80)

## Trade History
Trades proposed during season: {trades_done}
FA claims: {fa_done}
Trade history entries: {len(trade_entries)}

## Seasons List
{seasons_list.get("seasons", [])}

## File Sizes
- season.json: {season_size_mb:.3f} MB {"⚠️ >5MB!" if season_size_mb > 5 else "✓"}
- draft.json: {draft_size_mb:.3f} MB {"⚠️ >5MB!" if draft_size_mb > 5 else "✓"}

## Season Reset
Draft intact after reset: {"YES" if draft_after.get("is_complete") else "NO"}

## Exceptions / Errors
{errors_summary}
"""

REPORT_PATH.write_text(report, encoding="utf-8")
print(report)
print(f"\n{'='*60}")
print(f"STRESS TEST COMPLETE in {elapsed:.1f}s — errors: {len(errors)}")
