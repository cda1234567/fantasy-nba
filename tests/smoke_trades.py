"""Smoke test for Wave D trade system.

Usage:
    uv run python tests/smoke_trades.py

Steps:
    1. Reset draft + auto-draft (AI picks only)
    2. Start season
    3. Advance 14 weeks
    4. Assert season_executed_count >= 10
    5. Assert at least one vetoed OR rejected trade exists in history
    6. Print summary
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Ensure repo root on sys.path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Force an isolated data dir so the smoke run doesn't clobber real state
SMOKE_DATA = ROOT / "data_smoke"
os.environ["DATA_DIR"] = str(SMOKE_DATA)
os.environ["LEAGUE_ID"] = "smoke"

from app.ai_gm import AIGM  # noqa: E402
from app.draft import DraftState, NUM_TEAMS, ROSTER_SIZE  # noqa: E402
from app.models import SeasonState  # noqa: E402
from app.season import (  # noqa: E402
    REGULAR_WEEKS,
    advance_week,
    start_season,
)
from app.storage import Storage, resolve_data_dir  # noqa: E402
from app.trades import TradeManager  # noqa: E402


def main() -> int:
    data_dir = resolve_data_dir(os.environ["DATA_DIR"], ROOT / "data_smoke")
    storage = Storage(data_dir, league_id="smoke")

    # Clean slate for the smoke run
    storage.clear_season()
    storage.clear_trades()
    if storage.draft_path.exists():
        storage.draft_path.unlink()
    if storage.log_path.exists():
        storage.log_path.unlink()

    players_file = ROOT / "app" / "data" / "players.json"
    draft = DraftState(players_file, seed=42)
    draft.reset(randomize_order=False, seed=42)

    # Force team 0 to be a non-human AI for smoke (so full auto-draft works)
    # — we keep the is_human flag but use AI picks for everyone via ai_pick
    # on a cloned team. Simplest: flip the human flag off.
    draft.teams[0].is_human = False
    draft.teams[0].gm_persona = "bpa"

    # 1. Auto-draft (every team AI picks, snake order)
    print(f"[smoke] auto-drafting {NUM_TEAMS * ROSTER_SIZE} picks ...")
    while not draft.is_complete:
        pick = draft.ai_pick()
        if pick is None:
            break

    storage.save_draft(draft.snapshot())
    print(f"[smoke] draft complete: {len(draft.picks)} picks")

    # Flip team 0 back to human for season semantics
    draft.teams[0].is_human = True
    draft.teams[0].gm_persona = None
    storage.save_draft(draft.snapshot())

    # 2. Start season
    ai_gm = AIGM(api_key=None)  # heuristic-only, no API calls
    season = start_season(draft, storage)

    # 3. Advance 14 weeks
    print(f"[smoke] simulating {REGULAR_WEEKS} regular weeks ...")
    for week in range(REGULAR_WEEKS):
        season = advance_week(draft, season, storage, ai_gm=ai_gm, use_ai=True)

    # Tick one more day so any final accepted trades resolve past their veto window.
    # (advance_day would roll past REGULAR_WEEKS and no-op; instead run a manual
    # TradeManager tick with the current day + window padding.)
    mgr = TradeManager(storage, draft, season)
    mgr.daily_tick(season.current_day + 5, season.current_week)

    # 4. Assertions
    total_executed = mgr.state.season_executed_count
    history = mgr.state.history
    n_vetoed = sum(1 for t in history if t.status == "vetoed")
    n_rejected = sum(1 for t in history if t.status == "rejected")
    n_expired = sum(1 for t in history if t.status == "expired")
    n_executed_in_hist = sum(1 for t in history if t.status == "executed")

    print("\n=== trade summary ===")
    print(f"  season_executed_count: {total_executed}")
    print(f"  history total: {len(history)}")
    print(f"    executed: {n_executed_in_hist}")
    print(f"    vetoed:   {n_vetoed}")
    print(f"    rejected: {n_rejected}")
    print(f"    expired:  {n_expired}")
    print(f"  pending (unresolved): {len(mgr.pending())}")
    print(f"  final week: {season.current_week}, day: {season.current_day}")

    failures = []
    if total_executed < 10:
        failures.append(f"executed count {total_executed} < 10")
    if n_vetoed == 0 and n_rejected == 0:
        failures.append("no vetoed or rejected trades found")

    if failures:
        print("\n[smoke] FAILED:")
        for f in failures:
            print(f"  - {f}")
        return 1

    print("\n[smoke] PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
