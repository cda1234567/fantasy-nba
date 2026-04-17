"""Smoke test for Wave I — LeagueSettings, DraftState refactor, TradeManager.

Usage:
    uv run python tests/smoke_settings.py

Steps:
    1. Assert LeagueSettings() defaults are correct (no server needed)
    2. Construct DraftState with custom settings and assert structure
    3. Run 3 fake trade scenarios through TradeManager
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Isolated data dir so we don't clobber real state
SMOKE_DATA = ROOT / "data_smoke_settings"
os.environ["DATA_DIR"] = str(SMOKE_DATA)
os.environ["LEAGUE_ID"] = "smoke_settings"

from app.ai_gm import AIGM
from app.draft import DraftState
from app.models import LeagueSettings, SeasonState
from app.storage import Storage, resolve_data_dir
from app.trades import TradeManager


RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    RESULTS.append((name, condition, detail))
    status = "PASS" if condition else "FAIL"
    print(f"  [{status}] {name}" + (f": {detail}" if detail else ""))


# ---------------------------------------------------------------------------
# Test 1: LeagueSettings defaults
# ---------------------------------------------------------------------------
print("\n=== Test 1: LeagueSettings defaults ===")
s = LeagueSettings()
check("league_name default", s.league_name == "我的聯盟")
check("season_year default", s.season_year == "2025-26")
check("player_team_index default", s.player_team_index == 0)
check("team_names length", len(s.team_names) == 8)
check("team_names[0]", s.team_names[0] == "我的隊伍")
check("roster_size default", s.roster_size == 13)
check("starters_per_day default", s.starters_per_day == 10)
check("il_slots default", s.il_slots == 3)
check("scoring_weights pts", s.scoring_weights["pts"] == 1.0)
check("scoring_weights to", s.scoring_weights["to"] == -1.0)
check("regular_season_weeks default", s.regular_season_weeks == 20)
check("playoff_teams default", s.playoff_teams == 6)
check("veto_threshold default", s.veto_threshold == 3)
check("veto_window_days default", s.veto_window_days == 2)
check("setup_complete default False", s.setup_complete is False)
check("ai_trade_style default", s.ai_trade_style == "balanced")
check("randomize_draft_order default", s.randomize_draft_order is False)

# ---------------------------------------------------------------------------
# Test 2: DraftState with custom settings
# ---------------------------------------------------------------------------
print("\n=== Test 2: DraftState with custom LeagueSettings ===")
PLAYERS_FILE = ROOT / "app" / "data" / "players.json"
custom_settings = LeagueSettings(
    season_year="2000-01",
    roster_size=15,
    player_team_index=3,
    scoring_weights={"pts": 1.5, "reb": 1.2, "ast": 1.5, "stl": 2.5, "blk": 2.5, "to": -1.0},
)
draft = DraftState(PLAYERS_FILE, seed=42, settings=custom_settings)

check("num_teams == 8", len(draft.teams) == 8, f"got {len(draft.teams)}")
check("teams[3].is_human == True", draft.teams[3].is_human is True)
check("human_team_id == 3", draft.human_team_id == 3)
check(
    "other teams are not human",
    all(not t.is_human for t in draft.teams if t.id != 3),
)
check("players > 400", len(draft.players) > 400, f"got {len(draft.players)}")
check(
    "roster_size cached",
    draft._roster_size == 15,
    f"got {draft._roster_size}",
)
check(
    "fppg recomputed with custom weights (pts=1.5 vs default 1.0)",
    draft.players[0].fppg != 0.0,
)

# Spot-check: compute fppg manually for first player and compare
from app.scoring import compute_fppg
p0 = draft.players[0]
expected_fppg = round(compute_fppg(p0, custom_settings.scoring_weights), 2)
check(
    "fppg applied with custom weights",
    abs(p0.fppg - expected_fppg) < 0.01,
    f"got {p0.fppg}, expected {expected_fppg}",
)

# AI personas assigned to non-human teams
ai_teams = [t for t in draft.teams if not t.is_human]
check("7 AI teams", len(ai_teams) == 7, f"got {len(ai_teams)}")
check("all AI teams have persona", all(t.gm_persona is not None for t in ai_teams))

# total_picks respects roster_size=15
check("_total_picks == 120", draft._total_picks == 120, f"got {draft._total_picks}")

# ---------------------------------------------------------------------------
# Test 3: Trade scenarios
# ---------------------------------------------------------------------------
print("\n=== Test 3: Trade scenarios ===")

# Setup: auto-draft with default settings so rosters are populated
from app.draft import DraftState as DS
default_draft = DS(PLAYERS_FILE, seed=99)
# flip team 0 to AI so full auto-draft works
default_draft.teams[0].is_human = False
default_draft.teams[0].gm_persona = "bpa"
while not default_draft.is_complete:
    p = default_draft.ai_pick()
    if p is None:
        break
default_draft.teams[0].is_human = True
default_draft.teams[0].gm_persona = None

data_dir = resolve_data_dir(os.environ["DATA_DIR"], ROOT / "data_smoke_settings")
storage = Storage(data_dir, league_id="smoke_settings")
storage.clear_trades()
season = SeasonState(started=True, current_day=5, current_week=1)
ai_gm = AIGM(api_key=None)

# ---------- 3a: AI→AI fair trade — expect accepted, then executed after window ----------
team_a_id = 1  # AI
team_b_id = 2  # AI

roster_a = list(default_draft.teams[team_a_id].roster[:3])
roster_b = list(default_draft.teams[team_b_id].roster[:3])

# Use a 1-for-1 of similar FPPG to ensure fairness
def find_fair_pair(ta_id: int, tb_id: int) -> tuple[int, int] | None:
    a_players = sorted(
        [default_draft.players_by_id[pid] for pid in default_draft.teams[ta_id].roster],
        key=lambda p: p.fppg, reverse=True
    )
    b_players = sorted(
        [default_draft.players_by_id[pid] for pid in default_draft.teams[tb_id].roster],
        key=lambda p: p.fppg, reverse=True
    )
    for a in a_players[3:8]:
        for b in b_players[3:8]:
            a_fp = max(a.fppg, 0.1)
            b_fp = max(b.fppg, 0.1)
            ratio = max(a_fp, b_fp) / min(a_fp, b_fp)
            if ratio <= 1.08:
                return a.id, b.id
    return None

fair_pair = find_fair_pair(team_a_id, team_b_id)
if fair_pair is None:
    # fallback: just use mid-roster
    fair_pair = (
        default_draft.teams[team_a_id].roster[5],
        default_draft.teams[team_b_id].roster[5],
    )

settings_3a = LeagueSettings(veto_threshold=3, veto_window_days=2)
mgr3a = TradeManager(storage, default_draft, season, settings=settings_3a)

trade3a = mgr3a.propose(
    from_team=team_a_id,
    to_team=team_b_id,
    send_ids=[fair_pair[0]],
    receive_ids=[fair_pair[1]],
    current_day=5,
    current_week=1,
    reasoning="ai_fair_test",
)
check("3a: trade proposed", trade3a.status == "pending_accept", f"status={trade3a.status}")

# AI accept (team_b is AI)
accept, reason = ai_gm.decide_trade(trade3a, default_draft.teams[team_b_id], default_draft, settings_3a)
check("3a: AI accepts fair trade", accept is True, f"accept={accept} reason={reason}")
if accept:
    result3a = mgr3a.decide(trade3a.id, team_b_id, True, current_day=5, ai_gm=ai_gm)
    check("3a: after accept, status accepted or vetoed", result3a.status in ("accepted", "vetoed"), f"status={result3a.status}")
    # Advance past veto window
    resolved = mgr3a.daily_tick(current_day=8, current_week=2)
    final3a = mgr3a._find(trade3a.id)
    check("3a: fair trade eventually executed", final3a is not None and final3a.status == "executed", f"status={final3a.status if final3a else 'not found'}")

# ---------- 3b: AI→AI very unfair trade — expect immediate veto ----------
storage.clear_trades()
team_c_id = 3
team_d_id = 4

# Pick most-valuable from team_c, least-valuable from team_d (very unfair)
sorted_c = sorted(default_draft.teams[team_c_id].roster, key=lambda pid: default_draft.players_by_id[pid].fppg, reverse=True)
sorted_d = sorted(default_draft.teams[team_d_id].roster, key=lambda pid: default_draft.players_by_id[pid].fppg, reverse=False)
star_id = sorted_c[0]      # best player on team_c
scrub_id = sorted_d[0]     # worst player on team_d

star_fp = default_draft.players_by_id[star_id].fppg
scrub_fp = default_draft.players_by_id[scrub_id].fppg
print(f"  [info] unfair pair: star={star_fp:.1f} scrub={scrub_fp:.1f} ratio={star_fp/max(scrub_fp,0.1):.2f}")

settings_3b = LeagueSettings(veto_threshold=3, veto_window_days=2)
mgr3b = TradeManager(storage, default_draft, season, settings=settings_3b)

trade3b = mgr3b.propose(
    from_team=team_c_id,
    to_team=team_d_id,
    send_ids=[star_id],
    receive_ids=[scrub_id],
    current_day=5,
    current_week=1,
    reasoning="unfair_test",
)
check("3b: unfair trade proposed", trade3b.status == "pending_accept")

# Force accept (bypass AI decide — we just want to test veto logic)
result3b = mgr3b.decide(trade3b.id, team_d_id, True, current_day=5, ai_gm=ai_gm)
check(
    "3b: very unfair trade vetoed immediately or in veto-window",
    result3b.status in ("vetoed", "accepted"),
    f"status={result3b.status}, veto_votes={result3b.veto_votes}",
)
# If still in window, check veto_votes accumulated
if result3b.status == "accepted":
    print(f"  [info] veto_votes accumulated: {result3b.veto_votes}")
    check(
        "3b: veto votes > 0 on unfair trade",
        len(result3b.veto_votes) > 0,
        f"votes={result3b.veto_votes}",
    )
else:
    check("3b: unfair trade vetoed immediately", result3b.status == "vetoed", f"status={result3b.status}")

# ---------- 3c: Human→AI fair trade — AI auto-accepts, enters veto window ----------
storage.clear_trades()
human_team_id = 0  # default human
ai_target_id = 1

fair_pair_hum = find_fair_pair(human_team_id, ai_target_id)
if fair_pair_hum is None:
    fair_pair_hum = (
        default_draft.teams[human_team_id].roster[5],
        default_draft.teams[ai_target_id].roster[5],
    )
h_send, h_recv = fair_pair_hum
h_send_fp = default_draft.players_by_id[h_send].fppg
h_recv_fp = default_draft.players_by_id[h_recv].fppg
print(f"  [info] human→AI fair pair: send={h_send_fp:.1f} recv={h_recv_fp:.1f}")

settings_3c = LeagueSettings(veto_threshold=3, veto_window_days=2)
mgr3c = TradeManager(storage, default_draft, season, settings=settings_3c)

trade3c = mgr3c.propose(
    from_team=human_team_id,
    to_team=ai_target_id,
    send_ids=[h_send],
    receive_ids=[h_recv],
    current_day=10,
    current_week=2,
    reasoning="human_test",
)
check("3c: human→AI trade proposed", trade3c.status == "pending_accept")

# AI auto-decides
decided = mgr3c.auto_decide_ai(ai_gm, current_day=10)
check("3c: auto_decide_ai ran", len(decided) >= 1, f"decided {len(decided)} trade(s)")

trade3c_after = mgr3c._find(trade3c.id)
check(
    "3c: fair trade accepted or in veto window",
    trade3c_after is not None and trade3c_after.status in ("accepted", "vetoed", "executed"),
    f"status={trade3c_after.status if trade3c_after else 'not found'}",
)
if trade3c_after and trade3c_after.status == "accepted":
    check(
        "3c: veto_deadline_day set",
        trade3c_after.veto_deadline_day is not None,
        f"deadline={trade3c_after.veto_deadline_day}",
    )

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print("\n=== Summary ===")
passed = sum(1 for _, ok, _ in RESULTS if ok)
failed = sum(1 for _, ok, _ in RESULTS if not ok)
print(f"  Passed: {passed}")
print(f"  Failed: {failed}")

if failed:
    print("\n  FAILED checks:")
    for name, ok, detail in RESULTS:
        if not ok:
            print(f"    - {name}: {detail}")
    print("\nFAIL")
    sys.exit(1)
else:
    print("\nPASS")
    sys.exit(0)
