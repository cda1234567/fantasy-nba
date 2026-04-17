"""DraftState: snake draft controller, persistent singleton."""
from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Optional

from .models import Player, Pick, Team
from .scoring import compute_fppg, GM_PERSONAS, GM_SCORERS


NUM_TEAMS = 8
ROSTER_SIZE = 13
TOTAL_PICKS = NUM_TEAMS * ROSTER_SIZE  # 104

# Assigned GM personas for teams 1..7 (team 0 = human).
AI_PERSONA_ORDER = [
    "bpa",
    "punt_to",
    "stars_scrubs",
    "balanced",
    "youth",
    "vet",
    "contrarian",
]


def _load_players(path: Path) -> list[Player]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    players: list[Player] = []
    for row in raw:
        p = Player(**row)
        p.fppg = round(compute_fppg(p), 2)
        players.append(p)
    return players


def snake_team_for_pick(overall_pick: int, num_teams: int = NUM_TEAMS) -> tuple[int, int, int]:
    """Return (round, pick_in_round, team_id) for a 1-based overall pick."""
    idx = overall_pick - 1
    rnd = idx // num_teams + 1
    pos = idx % num_teams
    if rnd % 2 == 1:
        team_id = pos
    else:
        team_id = num_teams - 1 - pos
    return rnd, pos + 1, team_id


class DraftState:
    def __init__(self, players_file: Path, seed: int = 42):
        self.players_file = players_file
        self.seed = seed
        self.players: list[Player] = _load_players(players_file)
        self.players_by_id: dict[int, Player] = {p.id: p for p in self.players}
        self._fppg_rank: dict[int, int] = {}
        self._recompute_fppg_rank()
        self.teams: list[Team] = []
        self.picks: list[Pick] = []
        self.drafted_ids: set[int] = set()
        self.rng = random.Random(seed)
        self.reset(randomize_order=False, seed=seed)

    # ------------------------------------------------------------------ state
    def _recompute_fppg_rank(self) -> None:
        ordered = sorted(self.players, key=lambda p: p.fppg, reverse=True)
        self._fppg_rank = {p.id: i + 1 for i, p in enumerate(ordered)}

    def reset(self, randomize_order: bool = False, seed: Optional[int] = None) -> None:
        if seed is not None:
            self.seed = seed
        self.rng = random.Random(self.seed)
        self.picks = []
        self.drafted_ids = set()

        personas = list(AI_PERSONA_ORDER)
        if randomize_order:
            self.rng.shuffle(personas)

        # Team 0 is always the human.
        self.teams = [
            Team(id=0, name="You", is_human=True, gm_persona=None, roster=[])
        ]
        for i, persona in enumerate(personas, start=1):
            self.teams.append(
                Team(
                    id=i,
                    name=f"{GM_PERSONAS[persona]['name']} (T{i+1})",
                    is_human=False,
                    gm_persona=persona,
                    roster=[],
                )
            )

    # --------------------------------------------------------------- pointers
    @property
    def current_overall(self) -> int:
        return len(self.picks) + 1

    @property
    def is_complete(self) -> bool:
        return len(self.picks) >= TOTAL_PICKS

    def current_pointers(self) -> tuple[int, int, Optional[int]]:
        """(round, pick_in_round, team_id) for the next pick, or (14, 0, None) if done."""
        if self.is_complete:
            return ROSTER_SIZE + 1, 0, None
        rnd, pos, team_id = snake_team_for_pick(self.current_overall, NUM_TEAMS)
        return rnd, pos, team_id

    # ----------------------------------------------------------------- picks
    def available_players(self) -> list[Player]:
        return [p for p in self.players if p.id not in self.drafted_ids]

    def make_pick(self, player_id: int, reason: Optional[str] = None) -> Pick:
        if self.is_complete:
            raise ValueError("Draft is complete")
        if player_id in self.drafted_ids:
            raise ValueError("Player already drafted")
        if player_id not in self.players_by_id:
            raise ValueError("Unknown player_id")

        rnd, pos, team_id = self.current_pointers()
        assert team_id is not None
        player = self.players_by_id[player_id]

        pick = Pick(
            overall=self.current_overall,
            round=rnd,
            pick_in_round=pos,
            team_id=team_id,
            player_id=player_id,
            player_name=player.name,
            reason=reason,
        )
        self.picks.append(pick)
        self.drafted_ids.add(player_id)
        self.teams[team_id].roster.append(player_id)
        return pick

    def human_pick(self, player_id: int) -> Pick:
        _, _, team_id = self.current_pointers()
        if team_id != 0:
            raise ValueError("It is not the human's turn")
        return self.make_pick(player_id, reason=None)

    # ------------------------------------------------------------------- AI
    def ai_pick(self) -> Optional[Pick]:
        if self.is_complete:
            return None
        rnd, pos, team_id = self.current_pointers()
        assert team_id is not None
        team = self.teams[team_id]
        if team.is_human:
            raise ValueError("It is the human's turn, not an AI's")

        persona = team.gm_persona or "bpa"
        scorer = GM_SCORERS[persona]
        available = self.available_players()
        if not available:
            return None

        ctx = {
            "round": rnd,
            "pick_overall": self.current_overall,
            "roster_player_ids": list(team.roster),
            "all_players": self.players_by_id,
            "available_ids": {p.id for p in available},
            "fppg_rank": self._fppg_rank,
        }

        # Score every available player; tiebreak with seeded random jitter.
        scored = []
        for p in available:
            s = scorer(p, ctx)
            jitter = self.rng.uniform(-0.05, 0.05)
            scored.append((s + jitter, p))
        scored.sort(key=lambda t: t[0], reverse=True)
        best_score, best_player = scored[0]

        persona_label = GM_PERSONAS[persona]["name"]
        reason = (
            f"{persona_label}: selected {best_player.name} "
            f"(FPPG {best_player.fppg}, age {best_player.age}, score {best_score:.1f})"
        )
        return self.make_pick(best_player.id, reason=reason)

    def sim_to_human(self, max_iters: int = TOTAL_PICKS + 1) -> list[Pick]:
        """Run AI picks until it's the human's turn or draft is complete."""
        made: list[Pick] = []
        for _ in range(max_iters):
            if self.is_complete:
                break
            _, _, team_id = self.current_pointers()
            if team_id == 0:
                break
            p = self.ai_pick()
            if p is None:
                break
            made.append(p)
        return made

    # --------------------------------------------------------------- queries
    def board(self) -> list[list[Optional[Pick]]]:
        """Return a rounds x teams grid. Cell[r][t] = pick made by team t in round r+1,
        respecting snake order visually (col = team_id)."""
        grid: list[list[Optional[Pick]]] = [
            [None for _ in range(NUM_TEAMS)] for _ in range(ROSTER_SIZE)
        ]
        for pick in self.picks:
            grid[pick.round - 1][pick.team_id] = pick
        return grid

    def team_totals(self, team_id: int) -> dict:
        team = self.teams[team_id]
        players = [self.players_by_id[pid] for pid in team.roster]
        totals = {
            "fppg": round(sum(p.fppg for p in players), 2),
            "pts": round(sum(p.pts for p in players), 2),
            "reb": round(sum(p.reb for p in players), 2),
            "ast": round(sum(p.ast for p in players), 2),
            "stl": round(sum(p.stl for p in players), 2),
            "blk": round(sum(p.blk for p in players), 2),
            "to": round(sum(p.to for p in players), 2),
        }
        return totals

    # ------------------------------------------------------------ persistence
    def snapshot(self) -> dict:
        """Serialize draft state to a dict suitable for JSON storage."""
        return {
            "seed": self.seed,
            "teams": [t.model_dump() for t in self.teams],
            "picks": [p.model_dump() for p in self.picks],
        }

    def restore(self, data: dict) -> None:
        """Restore state from a snapshot. Players list is re-loaded from disk."""
        self.seed = int(data.get("seed", self.seed))
        self.rng = random.Random(self.seed)
        self.teams = [Team(**t) for t in data.get("teams", [])]
        self.picks = [Pick(**p) for p in data.get("picks", [])]
        self.drafted_ids = {p.player_id for p in self.picks}
        # Ensure each team's roster matches the picks made
        # (snapshot persists roster lists directly; they're the source of truth)
