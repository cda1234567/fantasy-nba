"""Smoke test for Iter3 E2: trade deadline drama — urgency multiplier.

Usage:
    uv run python tests/iter3_e2_deadline.py

Tests:
    1. Bottom-4 team, week within 2 of deadline  -> multiplier = 2.0
    2. Bottom-4 team, week NOT near deadline      -> multiplier = 1.0
    3. Top-4 team, week within 2 of deadline     -> multiplier = 1.0
    4. trade_deadline_week is None               -> multiplier = 1.0
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.trades import _urgency_multiplier  # noqa: E402


def _make_settings(deadline: int | None) -> SimpleNamespace:
    return SimpleNamespace(trade_deadline_week=deadline)


def _make_standings(bottom_4_ids: list[int], top_4_ids: list[int]) -> dict:
    """8-team standings where bottom_4_ids are losers and top_4_ids are winners."""
    standings = {}
    for tid in top_4_ids:
        standings[tid] = {"w": 10, "l": 2, "pf": 100.0, "pa": 80.0}
    for tid in bottom_4_ids:
        standings[tid] = {"w": 2, "l": 10, "pf": 70.0, "pa": 110.0}
    return standings


def run() -> None:
    deadline = 12
    top_ids = [0, 1, 2, 3]
    bottom_ids = [4, 5, 6, 7]
    standings = _make_standings(bottom_ids, top_ids)
    settings = _make_settings(deadline)

    # 1. Bottom-4 team, week within 2 of deadline (week 11 = deadline-1)
    m = _urgency_multiplier(team_id=4, current_week=11, standings=standings, settings=settings)
    print(f"[1] bottom-4 near deadline (week=11, deadline=12): multiplier={m}")
    assert m == 2.0, f"Expected 2.0, got {m}"

    # 2. Bottom-4 team, week NOT near deadline (week 8 = deadline-4)
    m = _urgency_multiplier(team_id=4, current_week=8, standings=standings, settings=settings)
    print(f"[2] bottom-4 far from deadline (week=8, deadline=12): multiplier={m}")
    assert m == 1.0, f"Expected 1.0, got {m}"

    # 3. Top-4 team, week within 2 of deadline
    m = _urgency_multiplier(team_id=0, current_week=11, standings=standings, settings=settings)
    print(f"[3] top-4 near deadline (week=11, deadline=12): multiplier={m}")
    assert m == 1.0, f"Expected 1.0, got {m}"

    # 4. trade_deadline_week is None
    m = _urgency_multiplier(team_id=4, current_week=11, standings=standings, settings=_make_settings(None))
    print(f"[4] deadline=None: multiplier={m}")
    assert m == 1.0, f"Expected 1.0, got {m}"

    # 5. Boundary: exactly 2 weeks before deadline (deadline-2 = 10)
    m = _urgency_multiplier(team_id=4, current_week=10, standings=standings, settings=settings)
    print(f"[5] bottom-4 at exact boundary (week=10, deadline=12): multiplier={m}")
    assert m == 2.0, f"Expected 2.0, got {m}"

    print("\nAll assertions passed.")


if __name__ == "__main__":
    run()
