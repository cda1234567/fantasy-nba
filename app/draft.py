"""DraftState: snake draft controller, persistent singleton."""
from __future__ import annotations

import json
import random
import unicodedata
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from .models import Injury, Player, Pick, SeasonState, Team
from .scoring import compute_fppg, GM_PERSONAS, GM_SCORERS

if TYPE_CHECKING:
    from .models import LeagueSettings


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


_NAME_POS_CACHE: dict[str, str] = {}


def _normalize_name(name: str) -> str:
    """Strip accents and lowercase so 'Jokić' matches 'Jokic'."""
    nfd = unicodedata.normalize("NFD", name)
    return "".join(c for c in nfd if unicodedata.category(c) != "Mn").lower().strip()


def _get_name_pos_map() -> dict[str, str]:
    """Lazy-load name→pos map from players.json (curated top-165)."""
    global _NAME_POS_CACHE
    if _NAME_POS_CACHE:
        return _NAME_POS_CACHE
    try:
        p = Path(__file__).resolve().parent / "data" / "players.json"
        raw = json.loads(p.read_text(encoding="utf-8"))
        _NAME_POS_CACHE = {
            _normalize_name(r["name"]): r["pos"]
            for r in raw if r.get("pos")
        }
    except Exception:
        _NAME_POS_CACHE = {"_fail": ""}  # sentinel to avoid re-tries
    return _NAME_POS_CACHE


def _infer_pos_from_stats(p: Player) -> str:
    """Fallback pos when name lookup misses — heuristic from stats.

    Aims for a reasonable distribution across 5 positions rather than SF-heavy.
    """
    reb = p.reb or 0.0
    ast = p.ast or 0.0
    blk = p.blk or 0.0
    # Big men: high blk or high reb
    if blk >= 1.0 or reb >= 7.5:
        return "C"
    # Power forwards: good rebounders with modest playmaking
    if reb >= 5.5 and ast < 3.5:
        return "PF"
    # Point guards: primary playmakers
    if ast >= 4.5:
        return "PG"
    # Shooting guards: secondary creators with guard profile
    if ast >= 2.5 and reb < 5.0:
        return "SG"
    # Forwards: mid-range rebounding
    if reb >= 4.0:
        return "SF"
    # Defaults — split by ast
    return "SG" if ast >= 2.0 else "SF"


def _load_prev_fppg(path: Path) -> dict[int, float]:
    """Return {player_id: prev_fppg} from the season JSON. Missing/null -> 0.0."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    result: dict[int, float] = {}
    for row in raw:
        pid = row.get("id")
        pf = row.get("prev_fppg")
        if pid is not None and pf is not None:
            result[int(pid)] = float(pf)
    return result


def _load_players(path: Path, weights: dict | None = None) -> list[Player]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    name_pos = _get_name_pos_map()
    players: list[Player] = []
    for row in raw:
        # season files may have prev_fppg; drop it so Player() doesn't choke
        row_clean = {k: v for k, v in row.items() if k != "prev_fppg"}
        p = Player(**row_clean)
        # Backfill missing pos: prefer curated name map, fallback to stat inference.
        if not p.pos:
            p.pos = name_pos.get(_normalize_name(p.name)) or _infer_pos_from_stats(p)
        p.fppg = round(compute_fppg(p, weights), 2)
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
    def __init__(
        self,
        players_file: Path,
        seed: int = 42,
        settings: Optional["LeagueSettings"] = None,
    ):
        self.players_file = players_file
        self.seed = seed
        self._settings = settings

        # Resolve the actual players file: if settings has a season_year,
        # look for the season JSON; fall back to the given players_file.
        effective_file = self._resolve_players_file(players_file, settings)
        weights = settings.scoring_weights if settings is not None else None
        self.players: list[Player] = _load_players(effective_file, weights)
        self.players_by_id: dict[int, Player] = {p.id: p for p in self.players}
        self._fppg_rank: dict[int, int] = {}
        self._recompute_fppg_rank()
        self._prev_fppg_map: dict[int, float] = _load_prev_fppg(effective_file)
        # Optional reference to preseason SeasonState (for injury penalties at draft time)
        self._preseason_state: Optional[SeasonState] = None
        self.teams: list[Team] = []
        self.picks: list[Pick] = []
        self.drafted_ids: set[int] = set()
        self.rng = random.Random(seed)
        self.reset(randomize_order=False, seed=seed)

    # -------------------------------------------------------------- helpers
    @staticmethod
    def _resolve_players_file(
        default_file: Path, settings: Optional["LeagueSettings"]
    ) -> Path:
        if settings is None:
            return default_file
        seasons_dir = default_file.parent / "seasons"
        candidate = seasons_dir / f"{settings.season_year}.json"
        if candidate.exists():
            return candidate
        return default_file

    # ------------------------------------------------------------------ state
    def _recompute_fppg_rank(self) -> None:
        ordered = sorted(self.players, key=lambda p: p.fppg, reverse=True)
        self._fppg_rank = {p.id: i + 1 for i, p in enumerate(ordered)}

    def reset(
        self,
        randomize_order: bool = False,
        seed: Optional[int] = None,
        settings: Optional["LeagueSettings"] = None,
    ) -> None:
        if settings is not None:
            self._settings = settings
            # Reload players if the season or weights changed
            effective_file = self._resolve_players_file(self.players_file, settings)
            self.players = _load_players(effective_file, settings.scoring_weights)
            self.players_by_id = {p.id: p for p in self.players}
            self._recompute_fppg_rank()
            self._prev_fppg_map = _load_prev_fppg(effective_file)

        s = self._settings
        num_teams = s.num_teams if s is not None else NUM_TEAMS
        roster_size = s.roster_size if s is not None else ROSTER_SIZE
        human_idx = s.player_team_index if s is not None else 0
        team_names = s.team_names if s is not None else None
        do_randomize = randomize_order or (s.randomize_draft_order if s is not None else False)

        if seed is not None:
            self.seed = seed
        self.rng = random.Random(self.seed)
        self.picks = []
        self.drafted_ids = set()

        # Cache resolved sizes so properties don't need to re-read settings
        self._num_teams = num_teams
        self._roster_size = roster_size

        personas = list(AI_PERSONA_ORDER)
        if do_randomize:
            self.rng.shuffle(personas)
        # Loop/truncate personas for non-8 team counts
        ai_personas: list[str] = []
        for i in range(num_teams - 1):
            ai_personas.append(personas[i % len(personas)])

        self.teams = []
        ai_cursor = 0
        for i in range(num_teams):
            if i == human_idx:
                name = team_names[i] if (team_names and i < len(team_names)) else "You"
                self.teams.append(
                    Team(id=i, name=name, is_human=True, gm_persona=None, roster=[])
                )
            else:
                persona = ai_personas[ai_cursor]
                ai_cursor += 1
                if team_names and i < len(team_names):
                    name = team_names[i]
                else:
                    name = f"{GM_PERSONAS[persona]['name']} (T{i+1})"
                self.teams.append(
                    Team(id=i, name=name, is_human=False, gm_persona=persona, roster=[])
                )

        if do_randomize:
            self.rng.shuffle(self.teams)

        # snake_team_for_pick returns a draft-position index, and the rest of
        # the draft code uses that value to index self.teams directly.
        for i, team in enumerate(self.teams):
            team.id = i

        self._human_team_id = next(
            (i for i, team in enumerate(self.teams) if team.is_human),
            human_idx,
        )

    # --------------------------------------------------------------- pointers
    @property
    def _total_picks(self) -> int:
        return self._num_teams * self._roster_size

    @property
    def current_overall(self) -> int:
        return len(self.picks) + 1

    @property
    def is_complete(self) -> bool:
        return len(self.picks) >= self._total_picks

    @property
    def human_team_id(self) -> int:
        return self._human_team_id

    @property
    def human_draft_position(self) -> int:
        return self._human_team_id + 1

    def current_pointers(self) -> tuple[int, int, Optional[int]]:
        """(round, pick_in_round, team_id) for the next pick, or (roster_size+1, 0, None) if done."""
        if self.is_complete:
            return self._roster_size + 1, 0, None
        rnd, pos, team_id = snake_team_for_pick(self.current_overall, self._num_teams)
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
        if team_id != self._human_team_id:
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

        # Determine display mode for AI fppg source
        draft_display_mode = (
            self._settings.draft_display_mode if self._settings else "prev_full"
        )
        allow_fppg = draft_display_mode == "current_full"

        # Preseason injury map for draft-time penalty
        preseason_injuries: dict = (
            self._preseason_state.injuries if self._preseason_state else {}
        )

        ctx = {
            "round": rnd,
            "pick_overall": self.current_overall,
            "roster_player_ids": list(team.roster),
            "all_players": self.players_by_id,
            "available_ids": {p.id for p in available},
            "fppg_rank": self._fppg_rank,
            "allow_fppg": allow_fppg,
        }

        # Positional need: count how many of each base position (PG/SG/SF/PF/C)
        # the team already rosters. Dual-eligible players count toward all their
        # positions. Used below to nudge AI away from stacking the same slot.
        from .season import _player_positions as _parse_pos
        pos_counts = {"PG": 0, "SG": 0, "SF": 0, "PF": 0, "C": 0}
        for pid in team.roster:
            existing = self.players_by_id.get(pid)
            if not existing:
                continue
            for ps in _parse_pos(existing.pos):
                if ps in pos_counts:
                    pos_counts[ps] += 1

        # Score every available player; tiebreak with seeded random jitter.
        scored = []
        for p in available:
            if allow_fppg:
                ctx["eval_fppg"] = p.fppg          # 本季實際（天眼模式）
            else:
                ctx["eval_fppg"] = self._prev_fppg_map.get(p.id, p.fppg * 0.85)  # 上賽季

            s = scorer(p, ctx)

            # Positional need bonus (skip for BPA — it's the ignore-position persona)
            if persona != "bpa":
                cand_pos = _parse_pos(p.pos) or set()
                if cand_pos:
                    # Use the weakest slot the player can fill so dual-eligible
                    # players score against their scarcest position.
                    min_count = min(pos_counts.get(ps, 0) for ps in cand_pos)
                    if min_count == 0:
                        s += 3.0
                    elif min_count == 1:
                        s += 1.0
                    elif min_count >= 3:
                        s -= 2.0

            # --- AI judgment adjustments ---
            # Age regression
            if p.age >= 33:
                s -= 2 * (p.age - 32)
            # Durability bonus/penalty
            if p.gp >= 70:
                s += 2.0
            elif p.gp < 50:
                s -= 4.0
            # Preseason injury penalty
            inj = preseason_injuries.get(p.id)
            if inj is not None and getattr(inj, "status", None) != "healthy":
                from .injuries import injury_score_penalty
                s += injury_score_penalty(p.id, self._preseason_state)
            # Breakout bonus for youth persona
            if persona == "youth" and p.age <= 23 and p.mpg >= 28 and ctx["eval_fppg"] >= 25:
                s += 4.0

            # Modest jitter so close picks can swap; large enough to feel human
            jitter = self.rng.uniform(-1.5, 1.5)
            scored.append((s + jitter, p))
        scored.sort(key=lambda t: t[0], reverse=True)

        # Persona-driven reach: in rounds 2-6, each AI has a chance to bypass
        # the top-scored player and "reach" for someone lower on the board who
        # fits their narrative. This adds unpredictability and storylines.
        reach_prob = {
            "stars_scrubs": 0.20,   # most reachy — chasing upside
            "contrarian":   0.22,   # loves picking what others ignore
            "youth":        0.18,   # reaches for young breakouts
            "vet":          0.10,   # mostly plays it safe
            "balanced":     0.08,
            "defensive":    0.12,
            "bpa":          0.05,
        }.get(persona, 0.10)

        best_score, best_player = scored[0]
        reached = False
        if 2 <= rnd <= 6 and len(scored) >= 3 and self.rng.random() < reach_prob:
            # Pick from top 2-5 based on persona tilt
            pool_size = 4 if persona in ("stars_scrubs", "contrarian") else 3
            pool = scored[1:1 + pool_size]
            # Persona-specific preference among the reach pool
            def reach_key(item):
                _, pl = item
                bonus = 0.0
                if persona == "youth" and pl.age <= 23:
                    bonus += 5.0
                if persona == "stars_scrubs" and ctx.get("eval_fppg", 0) >= 38:
                    bonus += 5.0
                if persona == "contrarian":
                    # Contrarian likes defensive specialists (STL+BLK)
                    bonus += (pl.stl + pl.blk) * 2.0
                if persona == "defensive":
                    bonus += (pl.stl + pl.blk) * 1.5
                return bonus + self.rng.uniform(-0.5, 0.5)
            pool.sort(key=reach_key, reverse=True)
            best_score, best_player = pool[0]
            reached = True

        persona_label = GM_PERSONAS[persona]["name"]
        reach_note = " (reach)" if reached else ""
        metric_note = f"FPPG {best_player.fppg}, " if allow_fppg else ""
        reason = (
            f"{persona_label}{reach_note}: selected {best_player.name} "
            f"({metric_note}age {best_player.age}, MPG {best_player.mpg}, score {best_score:.1f})"
        )
        return self.make_pick(best_player.id, reason=reason)

    def sim_to_human(self, max_iters: int | None = None) -> list[Pick]:
        """Run AI picks until it's the human's turn or draft is complete."""
        if max_iters is None:
            max_iters = self._total_picks + 1
        made: list[Pick] = []
        for _ in range(max_iters):
            if self.is_complete:
                break
            _, _, team_id = self.current_pointers()
            if team_id == self._human_team_id:
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
            [None for _ in range(self._num_teams)] for _ in range(self._roster_size)
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
        # Rosters are the source of truth — FA claims add to roster without
        # creating picks, so rebuilding from picks alone loses those claims.
        roster_ids: set[int] = set()
        for t in self.teams:
            roster_ids.update(t.roster)
        self.drafted_ids = roster_ids | {p.player_id for p in self.picks}
        for i, team in enumerate(self.teams):
            team.id = i
        # Sync cached size values from restored teams
        self._num_teams = len(self.teams) if self.teams else NUM_TEAMS
        self._roster_size = (
            self._settings.roster_size if self._settings else ROSTER_SIZE
        )
        self._human_team_id = next(
            (i for i, t in enumerate(self.teams) if t.is_human),
            self._settings.player_team_index if self._settings else 0,
        )
        # Ensure each team's roster matches the picks made
        # (snapshot persists roster lists directly; they're the source of truth)
