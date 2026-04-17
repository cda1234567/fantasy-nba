"""Injury simulation: sampling, daily tick, lineup integration."""
from __future__ import annotations

import random
from typing import TYPE_CHECKING

from .models import Injury, SeasonState

if TYPE_CHECKING:
    from .draft import DraftState


# Per-starter per-day probability of a new injury.
# Tuned so ~3-6 active injuries league-wide on any given day.
BASE_INJURY_PROB = 0.006

# (weight, min_days, max_days, template)
SEVERITY_TABLE = [
    (50, 1,  3,  "輕微拉傷，預計 {d} 天"),
    (25, 4,  10, "腳踝扭傷，預計 {d} 天"),
    (12, 11, 21, "肌肉拉傷，預計 {w} 週"),
    (8,  22, 42, "肩/膝傷勢，預計 {w}-{w2} 週"),
    (4,  43, 90, "大傷，可能賽季報銷"),
    (1, 120, 200, "韌帶撕裂，賽季報銷"),
]

_WEIGHTS = [row[0] for row in SEVERITY_TABLE]
_TOTAL_WEIGHT = sum(_WEIGHTS)


def _severity_status(min_days: int) -> str:
    if min_days <= 3:
        return "day_to_day"
    return "out"


def _format_note(template: str, days: int) -> str:
    weeks = round(days / 7)
    weeks2 = weeks + 1
    return template.format(d=days, w=weeks, w2=weeks2)


def sample_new_injury(player_id: int, rng: random.Random, current_day: int) -> Injury:
    """Weighted pick from SEVERITY_TABLE; return a new Injury object."""
    r = rng.uniform(0, _TOTAL_WEIGHT)
    cum = 0.0
    chosen = SEVERITY_TABLE[-1]
    for row in SEVERITY_TABLE:
        cum += row[0]
        if r <= cum:
            chosen = row
            break

    _, min_d, max_d, template = chosen
    days = rng.randint(min_d, max_d)
    status = _severity_status(min_d)
    note = _format_note(template, days)

    return Injury(
        player_id=player_id,
        status=status,
        return_in_days=days,
        note=note,
        diagnosed_day=current_day,
    )


def tick_injuries(season: SeasonState, current_day: int) -> None:
    """Decrement return_in_days; move healed players to history."""
    healed: list[int] = []
    for pid, inj in season.injuries.items():
        if inj.return_in_days <= 1:
            # Mark healthy and move to history
            healed_inj = inj.model_copy(update={"status": "healthy", "return_in_days": 0})
            season.injury_history.append(healed_inj)
            healed.append(pid)
        else:
            inj.return_in_days -= 1

    for pid in healed:
        del season.injuries[pid]


def roll_daily_injuries(
    season: SeasonState,
    draft_state: "DraftState",
    rng: random.Random,
    current_day: int,
) -> None:
    """Roll injury chance for each player currently in any team lineup."""
    # Collect all starters across all lineups
    all_starters: set[int] = set()
    for lineup in season.lineups.values():
        all_starters.update(lineup)

    for pid in all_starters:
        # Skip if already injured
        if pid in season.injuries:
            continue
        if rng.random() < BASE_INJURY_PROB:
            inj = sample_new_injury(pid, rng, current_day)
            season.injuries[pid] = inj
            season.injury_history.append(inj.model_copy())


def roll_preseason_injuries(
    season: SeasonState,
    draft_state: "DraftState",
    rng: random.Random,
) -> None:
    """~2% chance per player of entering season with a short-term injury (1-3 weeks).
    No season-enders. Called once after draft, before day 1.
    """
    for team in draft_state.teams:
        for pid in team.roster:
            if rng.random() < 0.02:
                days = rng.randint(7, 21)
                status = "day_to_day" if days <= 3 else "out"
                weeks = round(days / 7)
                note = f"季前傷勢，預計 {weeks} 週"
                inj = Injury(
                    player_id=pid,
                    status=status,
                    return_in_days=days,
                    note=note,
                    diagnosed_day=0,
                )
                season.injuries[pid] = inj
                season.injury_history.append(inj.model_copy())


def injury_score_penalty(player_id: int, season: SeasonState) -> float:
    """Return a score penalty for draft-time injury visibility.
    Used by ai_pick() to penalize pre-season injured players.
    Severity-weighted: day_to_day -> -3, out (short) -> -10, out (long) -> -20.
    """
    inj = season.injuries.get(player_id)
    if inj is None:
        return 0.0
    if inj.status == "day_to_day":
        return -3.0
    # out: scale by return_in_days
    if inj.return_in_days <= 21:
        return -10.0
    return -20.0
