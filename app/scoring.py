"""Fantasy scoring + GM persona scoring functions.

Scoring weights (points league):
    PTS x1.0, REB x1.2, AST x1.5, STL x2.5, BLK x2.5, TO x-1.0
"""
from __future__ import annotations

from typing import Callable
from .models import Player


SCORING_WEIGHTS = {
    "pts": 1.0,
    "reb": 1.2,
    "ast": 1.5,
    "stl": 2.5,
    "blk": 2.5,
    "to": -1.0,
}


def compute_fppg(p: Player, weights: dict | None = None) -> float:
    w = weights if weights is not None else SCORING_WEIGHTS
    return (
        p.pts * w.get("pts", SCORING_WEIGHTS["pts"])
        + p.reb * w.get("reb", SCORING_WEIGHTS["reb"])
        + p.ast * w.get("ast", SCORING_WEIGHTS["ast"])
        + p.stl * w.get("stl", SCORING_WEIGHTS["stl"])
        + p.blk * w.get("blk", SCORING_WEIGHTS["blk"])
        + p.to * w.get("to", SCORING_WEIGHTS["to"])
    )


# ---------------------------------------------------------------------------
# GM persona scoring functions. Each takes (player, context) -> score (float).
# Higher score = more wanted. The persona with highest score picks.
# `context` carries: round, pick_overall, roster_player_ids, all_players (by id),
#   available_ids (set), fppg_rank (id -> 1-based rank).
# ---------------------------------------------------------------------------

GM_PERSONAS: dict[str, dict] = {
    "bpa": {
        "name": "BPA Nerd",
        "desc": "Best player available by FPPG, every round.",
    },
    "punt_to": {
        "name": "Punt TO",
        "desc": "Heavily penalizes turnovers; avoids high-usage ball handlers.",
    },
    "stars_scrubs": {
        "name": "Stars & Scrubs",
        "desc": "Top-20 FPPG only early; high-variance young upside late.",
    },
    "balanced": {
        "name": "Balanced Builder",
        "desc": "Rewards well-rounded lines; penalizes one-trick scorers.",
    },
    "youth": {
        "name": "Youth Upside",
        "desc": "Weights players under 25; willing to reach on upside.",
    },
    "vet": {
        "name": "Vet Win-Now",
        "desc": "Proven veterans (27+) with high floor; discounts rookies.",
    },
    "contrarian": {
        "name": "Contrarian",
        "desc": "Fades consensus; targets unique stat profiles (pure STL/BLK).",
    },
}


def _bpa_score(p: Player, ctx: dict) -> float:
    return ctx.get("eval_fppg", p.fppg)


def _punt_to_score(p: Player, ctx: dict) -> float:
    # Extra -2.5 per TO on top of the base -1.0 already in fppg.
    return ctx.get("eval_fppg", p.fppg) - (p.to * 2.5)


def _stars_scrubs_score(p: Player, ctx: dict) -> float:
    rnd = ctx["round"]
    rank = ctx["fppg_rank"].get(p.id, 999)
    eval_fppg = ctx.get("eval_fppg", p.fppg)
    if rnd <= 3:
        # Only want elite (top 20). Heavy penalty otherwise.
        if rank <= 20:
            return eval_fppg + 10.0
        return eval_fppg - 50.0
    # Mid-late: love young high-variance
    bonus = 0.0
    if p.age <= 24:
        bonus += 5.0
    if p.mpg >= 28 and p.age <= 23:
        bonus += 4.0
    return eval_fppg + bonus


def _balanced_score(p: Player, ctx: dict) -> float:
    eval_fppg = ctx.get("eval_fppg", p.fppg)
    # Penalize any zero / near-zero category; reward filling all six.
    cats = [p.pts, p.reb, p.ast, p.stl, p.blk]
    penalty = 0.0
    for c in cats:
        if c < 0.5:
            penalty += 6.0
    # Bonus for being decent across the board (each cat above a threshold)
    bonus = 0.0
    if p.pts >= 12 and p.reb >= 4 and p.ast >= 3 and p.stl >= 0.8 and p.blk >= 0.4:
        bonus += 6.0
    # Mild TO penalty on top of fppg
    return eval_fppg + bonus - penalty - (p.to * 0.5)


def _youth_score(p: Player, ctx: dict) -> float:
    eval_fppg = ctx.get("eval_fppg", p.fppg)
    bonus = 0.0
    if p.age <= 22:
        bonus += 8.0
    elif p.age <= 24:
        bonus += 4.0
    elif p.age >= 32:
        bonus -= 3.0
    # Reach on upside = overweight young players with high MPG
    if p.age <= 24 and p.mpg >= 30:
        bonus += 3.0
    return eval_fppg + bonus


def _vet_score(p: Player, ctx: dict) -> float:
    eval_fppg = ctx.get("eval_fppg", p.fppg)
    bonus = 0.0
    if p.age >= 27:
        bonus += 5.0
    if p.age <= 22:
        bonus -= 6.0
    # High floor proxy: GP and MPG
    if p.gp >= 65:
        bonus += 2.0
    if p.mpg >= 30:
        bonus += 1.5
    return eval_fppg + bonus


def _contrarian_score(p: Player, ctx: dict) -> float:
    eval_fppg = ctx.get("eval_fppg", p.fppg)
    rank = ctx["fppg_rank"].get(p.id, 999)
    # Fade consensus: reach 5-10 slots "later" = penalize the very top a bit,
    # prefer players a bit below the top available.
    available_ranks = sorted(ctx["fppg_rank"][pid] for pid in ctx["available_ids"])
    top_rank = available_ranks[0] if available_ranks else 1
    slot_bonus = 0.0
    # Prefer 6-12 slots below the current BPA
    delta = rank - top_rank
    if 5 <= delta <= 12:
        slot_bonus += 4.0
    elif delta < 5:
        slot_bonus -= 1.5
    # Unique stat profile bonus: pure STL or BLK specialists
    if p.stl >= 1.5:
        slot_bonus += 3.5
    if p.blk >= 1.8:
        slot_bonus += 3.5
    # Slight penalty for generic scorers
    if p.pts >= 20 and p.stl < 0.9 and p.blk < 0.5:
        slot_bonus -= 2.0
    return eval_fppg + slot_bonus


GM_SCORERS: dict[str, Callable[[Player, dict], float]] = {
    "bpa": _bpa_score,
    "punt_to": _punt_to_score,
    "stars_scrubs": _stars_scrubs_score,
    "balanced": _balanced_score,
    "youth": _youth_score,
    "vet": _vet_score,
    "contrarian": _contrarian_score,
}
