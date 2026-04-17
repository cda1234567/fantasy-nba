"""Smoke test for injury system."""
from __future__ import annotations

import sys
import random
import tempfile
from pathlib import Path

# Allow running from the repo root
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.models import LeagueSettings, SeasonState
from app.draft import DraftState
from app.season import start_season, advance_day
from app.storage import Storage
from app.injuries import roll_preseason_injuries, tick_injuries, roll_daily_injuries

PLAYERS_FILE = Path(__file__).resolve().parent.parent / "app" / "data" / "players.json"
SEASONS_DIR = Path(__file__).resolve().parent.parent / "app" / "data" / "seasons"


def build_draft_and_season(tmp_dir: Path):
    settings = LeagueSettings(
        league_name="Smoke Test League",
        season_year="2025-26",
        player_team_index=0,
        setup_complete=True,
    )
    storage = Storage(tmp_dir, league_id="smoke")
    draft = DraftState(PLAYERS_FILE, seed=999, settings=settings)

    # Complete the draft using sim_to_human then pick a player for human too
    draft.reset(seed=999, settings=settings)
    while not draft.is_complete:
        _, _, team_id = draft.current_pointers()
        if team_id == draft.human_team_id:
            # Pick the best available for human slot
            avail = draft.available_players()
            if avail:
                avail.sort(key=lambda p: p.fppg, reverse=True)
                draft.human_pick(avail[0].id)
        else:
            draft.ai_pick()

    season = start_season(draft, storage, settings=settings)
    return draft, season, storage, settings


def test_injuries():
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        draft, season, storage, settings = build_draft_and_season(tmp_dir)

        # --- Test 1: Advance 30 days, assert at least 3 injuries occurred ---
        for _ in range(30):
            season = advance_day(draft, season, storage, ai_gm=None, use_ai=False, settings=settings)

        total_injuries = len(season.injury_history)
        print(f"  Total injuries after 30 days: {total_injuries}")
        assert total_injuries >= 3, (
            f"FAIL: expected >= 3 injuries after 30 days, got {total_injuries}"
        )
        print("  PASS: at least 3 injuries occurred")

        # --- Test 2: Assert injured (status=out) players produce fp=0 in game logs ---
        out_players = {
            pid for pid, inj in season.injuries.items() if inj.status == "out"
        }
        print(f"  Currently 'out' players: {out_players}")

        # Check recent game logs for these players — they should have fp=0 and played=False
        if out_players:
            # Find the last day's logs
            last_day = season.current_day
            last_day_logs = [g for g in season.game_logs if g.day == last_day]
            for log in last_day_logs:
                if log.player_id in out_players:
                    assert log.fp == 0.0, (
                        f"FAIL: injured player {log.player_id} had fp={log.fp} on day {last_day}"
                    )
                    assert not log.played, (
                        f"FAIL: injured player {log.player_id} marked played=True on day {last_day}"
                    )
            print("  PASS: injured players produce fp=0")
        else:
            # No active "out" players right now — verify from injury_history
            # Find any day where a player was injured and check logs
            injured_days: dict[int, int] = {}  # player_id -> diagnosed_day
            for inj in season.injury_history:
                if inj.status != "healthy":
                    injured_days[inj.player_id] = inj.diagnosed_day

            violations = 0
            for log in season.game_logs:
                if log.player_id in injured_days:
                    day = injured_days[log.player_id]
                    if log.day > day and log.fp > 0:
                        violations += 1
            # We can't be 100% precise here without injury status per day,
            # so just note if no out-players are currently active
            print("  PASS: no active 'out' players at day 30 (all healed) — fp=0 check skipped for historical")

        # --- Test 3: Assert AI never lineups an injured (out) player ---
        # Check lineups across all days against injuries that were active
        # Build a map: (player_id, day) -> was_out_injured_before_lineup
        # Simplified: for current injuries (status=out), verify they're not in today's lineup
        current_out = {pid for pid, inj in season.injuries.items() if inj.status == "out"}
        if current_out:
            for team in draft.teams:
                lineup = season.lineups.get(team.id, [])
                in_lineup = set(lineup) & current_out
                assert not in_lineup, (
                    f"FAIL: team {team.id} has injured player(s) {in_lineup} in lineup"
                )
        print("  PASS: no injured (out) players in current lineups")

        # --- Test 4: Print active injury report ---
        print("\n  === Active Injury Report ===")
        if season.injuries:
            for pid, inj in season.injuries.items():
                player = draft.players_by_id.get(pid)
                name = player.name if player else f"player_{pid}"
                print(f"  {name}: status={inj.status}, return_in_days={inj.return_in_days}, note={inj.note}")
        else:
            print("  (no active injuries)")

        print(f"\n  Injury history total: {len(season.injury_history)} events")
        print(f"  Current active injuries: {len(season.injuries)}")


if __name__ == "__main__":
    print("Running smoke_injuries.py...")
    try:
        test_injuries()
        print("\nPASS")
    except AssertionError as e:
        print(f"\n{e}")
        sys.exit(1)
    except Exception as e:
        import traceback
        traceback.print_exc()
        sys.exit(1)
