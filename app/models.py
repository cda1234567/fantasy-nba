"""Pydantic models for the draft simulator."""
from __future__ import annotations

import re
from typing import Any, Literal, Optional
from pydantic import BaseModel, Field, field_validator, model_validator


DEFAULT_TEAM_NAMES = [
    "我的隊伍",
    "BPA Nerd",
    "Punt TO",
    "Stars & Scrubs",
    "Balanced Builder",
    "Youth Upside",
    "Vet Win-Now",
    "Contrarian",
    "Sleeper Pick",
    "Playoff Push",
    "Glass Cannon",
    "The Rebuild",
]


class LeagueSettings(BaseModel):
    league_name: str = Field("我的聯盟", min_length=1, max_length=60)
    season_year: str = Field("2025-26", min_length=4, max_length=20)
    player_team_index: int = Field(0, ge=0, le=31)
    team_names: list[str] = Field(default_factory=lambda: list(DEFAULT_TEAM_NAMES))
    randomize_draft_order: bool = False
    num_teams: int = Field(8, ge=8, le=12)
    roster_size: int = Field(13, ge=8, le=20)
    starters_per_day: int = Field(10, ge=1, le=15)
    il_slots: int = Field(3, ge=0, le=5)
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
    regular_season_weeks: int = Field(20, ge=2, le=40)
    playoff_teams: int = Field(6, ge=0, le=16)
    trade_deadline_week: Optional[int] = Field(15, ge=1, le=40)
    ai_trade_frequency: Literal["off", "low", "normal", "high"] = "normal"
    ai_trade_style: Literal["conservative", "balanced", "aggressive"] = "balanced"
    veto_threshold: int = Field(3, ge=0, le=16)
    veto_window_days: int = Field(2, ge=0, le=7)
    ai_decision_mode: Literal["auto", "manual"] = "auto"
    draft_display_mode: Literal["prev_full", "prev_round", "none"] = "prev_full"
    show_offseason_headlines: bool = True
    setup_complete: bool = False
    use_openrouter: bool = True
    # Per-league manager token. Whoever holds this token (via cookie /
    # share-link) can mutate league state. Read endpoints stay public so
    # friends can spectate. Generated on league creation; rotating it
    # immediately revokes all stale share-links.
    manager_token: str = Field(default_factory=lambda: __import__("uuid").uuid4().hex)

    @field_validator("team_names")
    @classmethod
    def _reject_blank_team_names(cls, v: list[str]) -> list[str]:
        # Chaos agent 6 found the PATCH endpoint accepted ["","",...] silently.
        # Empty strings break the UI (blank league header, empty dropdown
        # options), so guard at the model boundary.
        for i, name in enumerate(v):
            if not isinstance(name, str) or not name.strip():
                raise ValueError(f"隊名不可為空白（第 {i + 1} 個）")
        return [s.strip() for s in v]

    @field_validator("season_year")
    @classmethod
    def _validate_season_year(cls, v: str) -> str:
        # Path-traversal defense: season_year is later concatenated into
        # filesystem paths (data/seasons/{year}.json). Restrict to YYYY-YY.
        if not re.match(r"^\d{4}-\d{2}$", v):
            raise ValueError("season_year 格式必須為 YYYY-YY")
        return v

    @model_validator(mode="after")
    def _check_consistency(self) -> "LeagueSettings":
        # player_team_index must reference a real team slot.
        if self.player_team_index >= self.num_teams:
            raise ValueError(
                f"player_team_index ({self.player_team_index}) 必須小於 num_teams ({self.num_teams})"
            )
        # team_names list must cover every team slot. Pad-or-trim happens at
        # /api/league/setup time; a direct PATCH here must already be sized.
        if len(self.team_names) < self.num_teams:
            raise ValueError(
                f"team_names 長度 ({len(self.team_names)}) 不可小於 num_teams ({self.num_teams})"
            )
        return self


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
    human_draft_position: int


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
    # Human lineup overrides: team_id -> [player_id x10]
    lineup_overrides: dict[int, list[int]] = Field(default_factory=dict)
    # One-shot overrides: team_id -> True means auto-clear after next _set_lineups
    lineup_override_today_only: dict[int, bool] = Field(default_factory=dict)
    # Pending alerts for the UI: cleared-override notifications
    lineup_override_alerts: list[dict] = Field(default_factory=list)
    # FAAB waiver budget per team (team_id -> $ remaining). Default $100/team/season.
    waiver_budgets: dict[int, int] = Field(default_factory=dict)


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

