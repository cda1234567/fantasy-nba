"""Pydantic models for the draft simulator."""
from __future__ import annotations

from typing import Any, Literal, Optional
from pydantic import BaseModel, Field


DEFAULT_TEAM_NAMES = [
    "我的隊伍",
    "BPA Nerd",
    "Punt TO",
    "Stars & Scrubs",
    "Balanced Builder",
    "Youth Upside",
    "Vet Win-Now",
    "Contrarian",
]


class LeagueSettings(BaseModel):
    league_name: str = "我的聯盟"
    season_year: str = "2025-26"
    player_team_index: int = 0
    team_names: list[str] = Field(default_factory=lambda: list(DEFAULT_TEAM_NAMES))
    randomize_draft_order: bool = False
    num_teams: int = 8
    roster_size: int = 13
    starters_per_day: int = 10
    il_slots: int = 3
    scoring_weights: dict[str, float] = Field(
        default_factory=lambda: {
            "pts": 1.0,
            "reb": 1.2,
            "ast": 1.5,
            "stl": 2.5,
            "blk": 2.5,
            "to": -1.0,
        }
    )
    regular_season_weeks: int = 20
    playoff_teams: int = 6
    trade_deadline_week: Optional[int] = None
    ai_trade_frequency: str = "normal"
    ai_trade_style: str = "balanced"
    veto_threshold: int = 3
    veto_window_days: int = 2
    ai_decision_mode: str = "auto"
    draft_display_mode: str = "prev_full"
    show_offseason_headlines: bool = True
    setup_complete: bool = False
    use_openrouter: bool = True


class Player(BaseModel):
    id: int
    name: str
    team: str          # NBA team abbr, e.g. "DEN"
    pos: str           # primary position, e.g. "PG", "C", "SF"
    age: int
    gp: int            # games played 2025-26
    mpg: float         # minutes per game
    pts: float
    reb: float
    ast: float
    stl: float
    blk: float
    to: float          # turnovers per game
    fppg: float = 0.0  # fantasy points per game (computed on load)


class Pick(BaseModel):
    overall: int       # 1..104
    round: int         # 1..13
    pick_in_round: int # 1..8
    team_id: int       # 0..7
    player_id: int
    player_name: str
    reason: Optional[str] = None  # AI GM rationale, if applicable


class Team(BaseModel):
    id: int
    name: str
    is_human: bool = False
    gm_persona: Optional[str] = None  # key into GM_PERSONAS
    roster: list[int] = Field(default_factory=list)  # list of player_ids


class DraftStateOut(BaseModel):
    teams: list[Team]
    picks: list[Pick]
    board: list[list[Optional[Pick]]]  # rows=rounds, cols=teams (serpentine aware)
    current_overall: int      # 1..104 (or 105 when done)
    current_round: int
    current_pick_in_round: int
    current_team_id: Optional[int]
    is_complete: bool
    available_count: int
    total_rounds: int
    num_teams: int
    human_team_id: int


class PickRequest(BaseModel):
    player_id: int


class ResetRequest(BaseModel):
    randomize_order: bool = False
    seed: Optional[int] = None


# ---------------------------------------------------------------------------
# Season models
# ---------------------------------------------------------------------------


class GameLog(BaseModel):
    day: int            # 1..N sim days (7 per week)
    week: int           # 1..16 (14 reg + 2 playoff)
    player_id: int
    team_id: int        # owning fantasy team
    played: bool
    pts: float
    reb: float
    ast: float
    stl: float
    blk: float
    to: float
    fp: float           # fantasy points for this game


class Matchup(BaseModel):
    week: int
    team_a: int
    team_b: int
    score_a: float = 0.0
    score_b: float = 0.0
    winner: Optional[int] = None  # team_id or None if not resolved
    complete: bool = False


class SeasonState(BaseModel):
    started: bool = False
    current_day: int = 0          # last completed day; 0 = not started
    current_week: int = 1         # 1..16
    schedule: list[Matchup] = Field(default_factory=list)
    game_logs: list[GameLog] = Field(default_factory=list)
    standings: dict[int, dict[str, float]] = Field(default_factory=dict)  # team_id -> {w,l,pf,pa}
    is_playoffs: bool = False
    champion: Optional[int] = None
    # Active lineups per team for the current day; team_id -> [player_ids x10]
    lineups: dict[int, list[int]] = Field(default_factory=dict)
    # Per-team daily API call counter (resets each new sim-day)
    ai_calls_today: int = 0
    # Injury tracking: player_id -> current Injury (only non-healthy entries)
    injuries: dict[int, Injury] = Field(default_factory=dict)
    # All historical injuries including healed ones
    injury_history: list[Injury] = Field(default_factory=list)
    # team_id -> model_id assigned at season start
    ai_models: dict[int, str] = Field(default_factory=dict)
    # Human free-agent pickups: [{day, drop, add, ts}]
    human_claims: list[dict] = Field(default_factory=list)


class Injury(BaseModel):
    player_id: int
    status: Literal["healthy", "day_to_day", "out"]
    return_in_days: int = 0
    note: str = ""
    diagnosed_day: int = 0


class StartSeasonRequest(BaseModel):
    league_id: Optional[str] = None


class AdvanceRequest(BaseModel):
    use_ai: bool = True  # let AI GMs set lineups / make moves

