"""FastAPI entry point: static file mount + draft & season APIs."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv()
except Exception:
    pass

from .ai_gm import AIGM
from .draft import DraftState, NUM_TEAMS, ROSTER_SIZE
from .models import (
    AdvanceRequest,
    DraftStateOut,
    LeagueSettings,
    PickRequest,
    ResetRequest,
    SeasonState,
    StartSeasonRequest,
)
from .scoring import GM_PERSONAS
from .season import (
    REGULAR_WEEKS,
    advance_day as season_advance_day,
    advance_week as season_advance_week,
    sim_playoffs as season_sim_playoffs,
    sim_to_playoffs as season_sim_to_playoffs,
    start_season as season_start,
)
from .injuries_route import router as injuries_router
from .storage import Storage, resolve_data_dir
from .trades import TradeManager


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR.parent / "static"
PLAYERS_FILE = BASE_DIR / "data" / "players.json"
SEASONS_DIR = BASE_DIR / "data" / "seasons"
DEFAULT_DATA_DIR = BASE_DIR.parent / "data"
APP_VERSION = "0.5.3"

LEAGUE_ID = os.getenv("LEAGUE_ID", "default")
DATA_DIR = resolve_data_dir(os.getenv("DATA_DIR"), DEFAULT_DATA_DIR)

app = FastAPI(title="Fantasy NBA Draft Sim", version=APP_VERSION)
app.include_router(injuries_router)

storage = Storage(DATA_DIR, league_id=LEAGUE_ID)

# ---------------------------------------------------------------------------
# Startup: respect saved league settings if setup_complete=True
# ---------------------------------------------------------------------------
import time as _time

_saved_settings = storage.load_league_settings()
if _saved_settings.setup_complete:
    draft = DraftState(PLAYERS_FILE, seed=int(_time.time()) & 0xFFFFFFFF, settings=_saved_settings)
else:
    draft = DraftState(PLAYERS_FILE, seed=int(_time.time()) & 0xFFFFFFFF)

ai_gm = AIGM(api_key=os.getenv("ANTHROPIC_API_KEY"))

# Restore draft from disk if present
_initial_draft = storage.load_draft()
if _initial_draft:
    try:
        draft.restore(_initial_draft)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Static files
# ---------------------------------------------------------------------------
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(str(STATIC_DIR / "index.html"))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _current_settings() -> LeagueSettings:
    return storage.load_league_settings()


def _state_snapshot() -> DraftStateOut:
    settings = _current_settings()
    num_teams = draft._num_teams
    roster_size = draft._roster_size
    rnd, pos, team_id = draft.current_pointers()
    return DraftStateOut(
        teams=draft.teams,
        picks=draft.picks,
        board=draft.board(),
        current_overall=draft.current_overall if not draft.is_complete else num_teams * roster_size + 1,
        current_round=rnd,
        current_pick_in_round=pos,
        current_team_id=team_id,
        is_complete=draft.is_complete,
        available_count=len(draft.available_players()),
        total_rounds=roster_size,
        num_teams=num_teams,
        human_team_id=draft.human_team_id,
    )


def _persist_draft() -> None:
    try:
        storage.save_draft(draft.snapshot())
    except Exception:
        pass


def _load_or_init_season() -> Optional[SeasonState]:
    raw = storage.load_season()
    if not raw:
        return None
    try:
        state = SeasonState(**raw)
        state.standings = {int(k): v for k, v in state.standings.items()}
        state.lineups = {int(k): v for k, v in state.lineups.items()}
        state.injuries = {int(k): v for k, v in state.injuries.items()}
        # Sanitize obsolete model IDs (e.g. retired gemini-flash-1.5 endpoint)
        from .llm import OPENROUTER_MODELS, DEFAULT_MODEL_ID
        valid = set(OPENROUTER_MODELS)
        remapped = False
        state.ai_models = {int(k): v for k, v in state.ai_models.items()}
        for tid, mid in list(state.ai_models.items()):
            if mid not in valid:
                state.ai_models[tid] = DEFAULT_MODEL_ID
                remapped = True
        if remapped:
            try:
                storage.save_season(state.model_dump())
            except Exception:
                pass
        return state
    except Exception as e:
        # Don't silently vanish season data — surface the failure so we can debug.
        import traceback, sys
        print(f"[season] _load_or_init_season failed: {e!r}", file=sys.stderr)
        traceback.print_exc()
        return None


def _require_season() -> SeasonState:
    state = _load_or_init_season()
    if state is None or not state.started:
        raise HTTPException(400, "賽季尚未開始")
    return state


def _require_setup() -> None:
    """Raise 409 if league is not yet configured."""
    settings = _current_settings()
    if not settings.setup_complete:
        raise HTTPException(409, "聯盟尚未設定,請先完成設定")


# ---------------------------------------------------------------------------
# Health / meta
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health():
    return {
        "ok": True,
        "version": APP_VERSION,
        "league_id": LEAGUE_ID,
        "data_dir": str(DATA_DIR),
        "ai_enabled": ai_gm.enabled,
    }


# ---------------------------------------------------------------------------
# Seasons list
# ---------------------------------------------------------------------------
@app.get("/api/seasons/list")
def seasons_list():
    if not SEASONS_DIR.exists():
        return {"seasons": []}
    names = sorted(
        p.stem for p in SEASONS_DIR.glob("*.json")
    )
    return {"seasons": names}


# ---------------------------------------------------------------------------
# Offseason headlines
# ---------------------------------------------------------------------------
OFFSEASON_DIR = BASE_DIR / "data" / "offseason"


@app.get("/api/seasons/{year}/headlines")
def season_headlines(year: str):
    path = OFFSEASON_DIR / f"{year}.json"
    if not path.exists():
        raise HTTPException(404, "no headlines for this season")
    return json.loads(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# League settings & setup
# ---------------------------------------------------------------------------

# Fields that may be changed mid-season (after setup_complete=True)
_MID_SEASON_ALLOWED = {
    "team_names",
    "ai_trade_frequency",
    "ai_trade_style",
    "ai_decision_mode",
    "draft_display_mode",
    "show_offseason_headlines",
}

_VALID_ROSTER_SIZES = {10, 13, 15}
_VALID_STARTERS = {8, 10, 12}
_VALID_REG_WEEKS = set(range(18, 23))


@app.get("/api/league/settings")
def get_league_settings():
    return _current_settings().model_dump()


@app.post("/api/league/settings")
def patch_league_settings(body: dict[str, Any]):
    settings = _current_settings()
    if settings.setup_complete:
        forbidden = set(body.keys()) - _MID_SEASON_ALLOWED
        if forbidden:
            raise HTTPException(
                400,
                f"Cannot change {sorted(forbidden)} after league setup is complete",
            )
    updated = settings.model_copy(update=body)
    storage.save_league_settings(updated)
    return updated.model_dump()


@app.post("/api/league/setup")
def league_setup(body: LeagueSettings):
    """Validate and save full settings; reset draft to the chosen season."""
    errors: list[str] = []

    if body.num_teams != 8:
        errors.append("num_teams must be 8")
    if not (0 <= body.player_team_index < body.num_teams):
        errors.append(f"player_team_index must be 0..{body.num_teams - 1}")
    if len(body.team_names) != body.num_teams:
        errors.append(f"team_names must have {body.num_teams} entries")
    season_file = SEASONS_DIR / f"{body.season_year}.json"
    if not season_file.exists():
        errors.append(f"season_year '{body.season_year}' not found in seasons data")
    if body.roster_size not in _VALID_ROSTER_SIZES:
        errors.append(f"roster_size must be one of {sorted(_VALID_ROSTER_SIZES)}")
    if body.starters_per_day not in _VALID_STARTERS:
        errors.append(f"starters_per_day must be one of {sorted(_VALID_STARTERS)}")
    if not (0 <= body.il_slots <= 3):
        errors.append("il_slots must be 0..3")
    if body.regular_season_weeks not in _VALID_REG_WEEKS:
        errors.append(f"regular_season_weeks must be 18..22")

    if errors:
        raise HTTPException(400, {"errors": errors})

    # Mark complete and persist
    body.setup_complete = True
    storage.save_league_settings(body)

    # Re-initialize draft with new settings
    draft.reset(
        randomize_order=body.randomize_draft_order,
        seed=int(_time.time() * 1000) & 0xFFFFFFFF,
        settings=body,
    )
    _persist_draft()
    storage.clear_season()
    storage.clear_trades()

    return _state_snapshot().model_dump()


@app.get("/api/league/status")
def league_status():
    settings = _current_settings()
    return {
        "setup_complete": settings.setup_complete,
        "league_name": settings.league_name,
        "season_year": settings.season_year,
        "num_teams": settings.num_teams,
        "roster_size": settings.roster_size,
        "regular_season_weeks": settings.regular_season_weeks,
    }


# ---------------------------------------------------------------------------
# Draft API (existing, now persisted)
# ---------------------------------------------------------------------------
@app.get("/api/state", response_model=DraftStateOut)
def get_state():
    return _state_snapshot()


@app.get("/api/personas")
def get_personas():
    return GM_PERSONAS


@app.get("/api/players")
def list_players(
    available: bool = True,
    sort: str = Query("fppg", pattern="^(fppg|pts|reb|ast|stl|blk|to|name|age|mpg)$"),
    limit: int = 200,
    q: Optional[str] = None,
    pos: Optional[str] = None,
):
    pool = draft.available_players() if available else list(draft.players)
    if q:
        ql = q.lower()
        pool = [p for p in pool if ql in p.name.lower() or ql in p.team.lower()]
    if pos:
        pool = [p for p in pool if p.pos.upper() == pos.upper()]

    reverse = sort != "name" and sort != "to"
    pool.sort(key=lambda p: getattr(p, sort), reverse=reverse)
    return [p.model_dump() for p in pool[:limit]]


@app.get("/api/teams/{team_id}")
def get_team(team_id: int):
    if team_id < 0 or team_id >= draft._num_teams:
        raise HTTPException(404, "Unknown team_id")
    team = draft.teams[team_id]
    players = [draft.players_by_id[pid].model_dump() for pid in team.roster]

    # Attach injury status + compute slot assignment for the 10 starters.
    season = _load_or_init_season()
    injured_out: set[int] = set()
    if season is not None:
        injured_out = {pid for pid, inj in season.injuries.items() if inj.status == "out"}

    from .season import assign_slots as _assign_slots, LINEUP_SLOTS, LINEUP_SIZE
    healthy = [pid for pid in team.roster if pid not in injured_out]
    slot_rows = _assign_slots(healthy, draft.players_by_id, LINEUP_SLOTS[:LINEUP_SIZE])
    assigned_ids = {s["player_id"] for s in slot_rows if s["player_id"] is not None}
    bench = [pid for pid in team.roster if pid not in assigned_ids and pid not in injured_out]

    return {
        "team": team.model_dump(),
        "players": players,
        "totals": draft.team_totals(team_id),
        "persona_desc": GM_PERSONAS[team.gm_persona]["desc"] if team.gm_persona else None,
        "lineup_slots": slot_rows,   # [{slot, player_id|None}, ...]
        "bench": bench,              # roster ids not in any slot
        "injured_out": sorted(injured_out & set(team.roster)),
    }


@app.post("/api/draft/pick")
def human_pick(req: PickRequest):
    _require_setup()
    try:
        pick = draft.human_pick(req.player_id)
    except ValueError as e:
        msg = str(e)
        if "not the human's turn" in msg:
            _, _, next_team = draft.current_pointers()
            raise HTTPException(400, {
                "detail": "human_slot_already_consumed",
                "next_picker": next_team,
                "is_complete": draft.is_complete,
            })
        raise HTTPException(400, msg)
    _persist_draft()
    return {"pick": pick.model_dump(), "state": _state_snapshot().model_dump()}


@app.post("/api/draft/ai-advance")
def ai_advance():
    _require_setup()
    if draft.is_complete:
        return {"pick": None, "state": _state_snapshot().model_dump()}
    _, _, team_id = draft.current_pointers()
    if team_id == draft.human_team_id:
        raise HTTPException(400, "It's the human's turn")
    pick = draft.ai_pick()
    _persist_draft()
    return {
        "pick": pick.model_dump() if pick else None,
        "state": _state_snapshot().model_dump(),
    }


@app.post("/api/draft/sim-to-me")
def sim_to_me():
    _require_setup()
    made = draft.sim_to_human()
    _persist_draft()
    return {
        "picks": [p.model_dump() for p in made],
        "state": _state_snapshot().model_dump(),
    }


class ResetRequestV2(BaseModel):
    randomize_order: bool = False
    seed: Optional[int] = None
    season_year: Optional[str] = None  # override season for this reset


@app.post("/api/draft/reset")
def reset_draft(req: ResetRequestV2 = ResetRequestV2()):
    seed = req.seed if req.seed is not None else (int(_time.time() * 1000) & 0xFFFFFFFF)
    settings = _current_settings()
    if req.season_year is not None:
        season_file = SEASONS_DIR / f"{req.season_year}.json"
        if not season_file.exists():
            raise HTTPException(400, f"season_year '{req.season_year}' not found")
        settings = settings.model_copy(update={"season_year": req.season_year})
    draft.reset(
        randomize_order=req.randomize_order,
        seed=seed,
        settings=settings if settings.setup_complete or req.season_year else None,
    )
    _persist_draft()
    storage.clear_season()
    storage.clear_trades()
    return _state_snapshot()


# ---------------------------------------------------------------------------
# Season API
# ---------------------------------------------------------------------------
@app.post("/api/season/start")
def season_start_endpoint(_req: StartSeasonRequest = StartSeasonRequest()):
    _require_setup()
    if not draft.is_complete:
        raise HTTPException(400, "Draft is not complete")
    settings = _current_settings()
    state = season_start(draft, storage, settings=settings)
    return state.model_dump()


@app.post("/api/season/advance-day")
def season_advance_day_endpoint(req: AdvanceRequest = AdvanceRequest()):
    _require_setup()
    state = _require_season()
    settings = _current_settings()
    state = season_advance_day(
        draft, state, storage, ai_gm=ai_gm, use_ai=req.use_ai, settings=settings
    )
    return state.model_dump()


@app.post("/api/season/advance-week")
def season_advance_week_endpoint(req: AdvanceRequest = AdvanceRequest()):
    _require_setup()
    state = _require_season()
    settings = _current_settings()
    state = season_advance_week(
        draft, state, storage, ai_gm=ai_gm, use_ai=req.use_ai, settings=settings
    )
    return state.model_dump()


@app.post("/api/season/sim-to-playoffs")
def season_sim_to_playoffs_endpoint(req: AdvanceRequest = AdvanceRequest()):
    _require_setup()
    state = _require_season()
    settings = _current_settings()
    state = season_sim_to_playoffs(
        draft, state, storage, ai_gm=ai_gm, use_ai=req.use_ai, settings=settings
    )
    return state.model_dump()


@app.post("/api/season/sim-playoffs")
def season_sim_playoffs_endpoint(req: AdvanceRequest = AdvanceRequest()):
    _require_setup()
    state = _require_season()
    settings = _current_settings()
    state = season_sim_playoffs(
        draft, state, storage, ai_gm=ai_gm, use_ai=req.use_ai, settings=settings
    )
    return state.model_dump()


class FAClaimRequest(BaseModel):
    drop_player_id: int
    add_player_id: int


HUMAN_DAILY_CLAIM_LIMIT = 3


@app.get("/api/fa/claim-status")
def fa_claim_status():
    """Return how many claims the human team has used today and the limit."""
    state = _load_or_init_season()
    if state is None or not state.started:
        return {"used_today": 0, "limit": HUMAN_DAILY_CLAIM_LIMIT, "day": 0, "remaining": HUMAN_DAILY_CLAIM_LIMIT}
    today = state.current_day
    used = sum(1 for c in state.human_claims if int(c.get("day", -1)) == today)
    return {
        "used_today": used,
        "limit": HUMAN_DAILY_CLAIM_LIMIT,
        "day": today,
        "remaining": max(0, HUMAN_DAILY_CLAIM_LIMIT - used),
    }


@app.post("/api/fa/claim")
def fa_claim(req: FAClaimRequest):
    state = _require_season()
    # Find the human team
    human = next((t for t in draft.teams if t.is_human), None)
    if human is None:
        raise HTTPException(400, "此聯盟沒有玩家隊伍")

    # Validate drop
    if req.drop_player_id not in human.roster:
        raise HTTPException(400, "釋出的球員不在你的陣容中")
    # Validate add: must exist and not on any roster
    if req.add_player_id not in draft.players_by_id:
        raise HTTPException(400, "找不到此球員")
    on_any_roster = {pid for t in draft.teams for pid in t.roster}
    if req.add_player_id in on_any_roster:
        raise HTTPException(400, "此球員已被其他隊伍簽走")

    # Daily limit
    today = state.current_day
    used = sum(1 for c in state.human_claims if int(c.get("day", -1)) == today)
    if used >= HUMAN_DAILY_CLAIM_LIMIT:
        raise HTTPException(400, f"今日已用完 {HUMAN_DAILY_CLAIM_LIMIT} 次自由球員簽約配額")

    # Execute swap
    human.roster = [p for p in human.roster if p != req.drop_player_id]
    human.roster.append(req.add_player_id)

    import time as _t
    state.human_claims.append({
        "day": today,
        "drop": req.drop_player_id,
        "add": req.add_player_id,
        "ts": int(_t.time()),
    })

    # Persist
    try:
        storage.save_draft(draft.snapshot())
    except Exception:
        pass
    try:
        storage.save_season(state.model_dump())
    except Exception:
        pass

    drop_name = draft.players_by_id[req.drop_player_id].name
    add_name = draft.players_by_id[req.add_player_id].name
    storage.append_log({
        "type": "fa_claim",
        "team_id": human.id,
        "drop": req.drop_player_id,
        "add": req.add_player_id,
        "drop_name": drop_name,
        "add_name": add_name,
        "day": today,
    })

    return {
        "ok": True,
        "drop": drop_name,
        "add": add_name,
        "remaining": HUMAN_DAILY_CLAIM_LIMIT - (used + 1),
    }


@app.get("/api/season/standings")
def season_standings():
    state = _load_or_init_season()
    if state is None or not state.started:
        return {"standings": [], "current_week": 0, "current_day": 0,
                "is_playoffs": False, "champion": None, "regular_weeks": REGULAR_WEEKS,
                "trade_quota": {"executed": 0, "target": 0, "behind": 0}, "pending_count": 0}
    state = _require_season()
    settings = _current_settings()
    reg_weeks = settings.regular_season_weeks if settings.setup_complete else REGULAR_WEEKS
    rows = []
    for team in draft.teams:
        s = state.standings.get(team.id, {"w": 0, "l": 0, "pf": 0, "pa": 0})
        rows.append({
            "team_id": team.id,
            "name": team.name,
            "is_human": team.is_human,
            "persona": team.gm_persona,
            "w": int(s.get("w", 0)),
            "l": int(s.get("l", 0)),
            "pf": round(float(s.get("pf", 0.0)), 2),
            "pa": round(float(s.get("pa", 0.0)), 2),
        })
    rows.sort(key=lambda r: (r["w"], r["pf"]), reverse=True)
    mgr = TradeManager(storage, draft, state, settings=settings if settings.setup_complete else None)
    return {
        "standings": rows,
        "current_week": state.current_week,
        "current_day": state.current_day,
        "is_playoffs": state.is_playoffs,
        "champion": state.champion,
        "regular_weeks": reg_weeks,
        "trade_quota": mgr.quota_info(state.current_week),
        "pending_count": len(mgr.pending()),
    }


@app.get("/api/season/schedule")
def season_schedule():
    state = _load_or_init_season()
    if state is None or not state.started:
        return {"schedule": []}
    return {"schedule": [m.model_dump() for m in state.schedule]}


@app.get("/api/season/matchup")
def season_matchup(week: int = Query(..., ge=1)):
    state = _require_season()
    matches = [m.model_dump() for m in state.schedule if m.week == week]
    if not matches:
        raise HTTPException(404, f"No matchups for week {week}")
    return {"week": week, "matchups": matches}


@app.get("/api/season/logs")
def season_logs(limit: int = Query(50, ge=1, le=500)):
    return {"logs": storage.load_log(limit=limit)}


@app.get("/api/season/ai-models")
def season_ai_models():
    state = _require_season()
    result: dict[str, dict] = {}
    for team in draft.teams:
        if team.is_human:
            continue
        model_id = state.ai_models.get(team.id, "anthropic/claude-haiku-4.5")
        result[str(team.id)] = {"name": team.name, "model": model_id}
    return result


@app.post("/api/season/reset")
def season_reset():
    storage.clear_season()
    storage.clear_trades()
    storage.append_log({"type": "season_reset"})
    return {"ok": True}


@app.get("/api/season/summary")
def season_summary():
    """Championship summary: final standings, MVP (highest season fp),
    top 5 single-game performances, human record, persona callouts."""
    state = _load_or_init_season()
    if state is None or not state.started:
        raise HTTPException(400, "Season not started")
    players_by_id = {p.id: p for p in draft.players}
    teams_by_id = {t.id: t for t in draft.teams}

    # aggregate player totals from game_logs
    totals: dict[int, dict] = {}
    for g in state.game_logs:
        if not g.played:
            continue
        e = totals.setdefault(g.player_id, {
            "player_id": g.player_id, "team_id": g.team_id,
            "gp": 0, "fp": 0.0, "pts": 0.0, "reb": 0.0,
            "ast": 0.0, "stl": 0.0, "blk": 0.0, "to": 0.0,
        })
        e["gp"] += 1
        e["fp"] += float(g.fp)
        e["pts"] += float(g.pts)
        e["reb"] += float(g.reb)
        e["ast"] += float(g.ast)
        e["stl"] += float(g.stl)
        e["blk"] += float(g.blk)
        e["to"] += float(g.to)

    def _stamp(entry):
        p = players_by_id.get(entry["player_id"])
        t = teams_by_id.get(entry["team_id"])
        gp = max(1, entry["gp"])
        return {
            **entry,
            "name": p.name if p else f"#{entry['player_id']}",
            "pos": p.pos if p else "",
            "team_name": t.name if t else "FA",
            "fppg": round(entry["fp"] / gp, 2),
            "fp_total": round(entry["fp"], 2),
        }

    mvp = None
    season_leaders = sorted(totals.values(), key=lambda e: e["fp"], reverse=True)[:10]
    season_leaders = [_stamp(e) for e in season_leaders]
    if season_leaders:
        mvp = season_leaders[0]

    # top 5 single-game performances
    top_games = sorted(
        [g for g in state.game_logs if g.played],
        key=lambda g: g.fp, reverse=True,
    )[:5]
    top_games_out = []
    for g in top_games:
        p = players_by_id.get(g.player_id)
        t = teams_by_id.get(g.team_id)
        top_games_out.append({
            "player": p.name if p else f"#{g.player_id}",
            "team": t.name if t else "",
            "week": g.week,
            "day": g.day,
            "fp": round(g.fp, 2),
            "pts": round(g.pts, 1), "reb": round(g.reb, 1),
            "ast": round(g.ast, 1), "stl": round(g.stl, 1),
            "blk": round(g.blk, 1), "to": round(g.to, 1),
        })

    # final standings sorted
    settings = _current_settings()
    reg_weeks = settings.regular_season_weeks if settings.setup_complete else REGULAR_WEEKS
    final_standings = []
    for team in draft.teams:
        s = state.standings.get(team.id, {"w": 0, "l": 0, "pf": 0, "pa": 0})
        final_standings.append({
            "team_id": team.id, "name": team.name,
            "is_human": team.is_human, "persona": team.gm_persona,
            "w": int(s.get("w", 0)), "l": int(s.get("l", 0)),
            "pf": round(float(s.get("pf", 0.0)), 2),
            "pa": round(float(s.get("pa", 0.0)), 2),
        })
    final_standings.sort(key=lambda r: (r["w"], r["pf"]), reverse=True)

    human_team = next((t for t in draft.teams if t.is_human), None)
    human_id = human_team.id if human_team else None
    human_rank = None
    if human_id is not None:
        for i, row in enumerate(final_standings):
            if row["team_id"] == human_id:
                human_rank = i + 1
                break

    champ_name = None
    if state.champion is not None:
        ct = teams_by_id.get(state.champion)
        champ_name = ct.name if ct else None

    return {
        "is_complete": state.champion is not None,
        "champion_id": state.champion,
        "champion_name": champ_name,
        "human_team_id": human_id,
        "human_rank": human_rank,
        "num_teams": len(draft.teams),
        "regular_weeks": reg_weeks,
        "final_standings": final_standings,
        "mvp": mvp,
        "season_leaders": season_leaders,
        "top_games": top_games_out,
    }


# ---------------------------------------------------------------------------
# Trades API
# ---------------------------------------------------------------------------
def _trade_manager() -> TradeManager:
    """Build a fresh TradeManager using current draft + season state."""
    season = _load_or_init_season() or SeasonState()
    settings = _current_settings()
    return TradeManager(
        storage, draft, season,
        settings=settings if settings.setup_complete else None,
    )


class TradeProposeRequest(BaseModel):
    from_team: int
    to_team: int
    send: list[int]
    receive: list[int]
    proposer_message: str = ""
    force: bool = False


class TradeVetoRequest(BaseModel):
    team_id: int


@app.get("/api/trades/pending")
def trades_pending():
    mgr = _trade_manager()
    pending = [t.model_dump() for t in mgr.pending()]
    attention = mgr.require_human_attention(human_team_id=draft.human_team_id)
    return {"pending": pending, "require_human_attention": attention}


@app.get("/api/trades/history")
def trades_history(limit: int = Query(50, ge=1, le=500)):
    mgr = _trade_manager()
    return {"history": [t.model_dump() for t in mgr.history(limit=limit)]}


@app.post("/api/trades/propose")
def trades_propose(req: TradeProposeRequest, background: BackgroundTasks):
    if req.from_team != draft.human_team_id:
        raise HTTPException(400, "只有玩家隊伍可透過此端點發起交易")
    season = _require_season()
    settings = _current_settings()
    mgr = TradeManager(
        storage, draft, season,
        settings=settings if settings.setup_complete else None,
    )
    try:
        trade = mgr.propose(
            from_team=req.from_team,
            to_team=req.to_team,
            send_ids=req.send,
            receive_ids=req.receive,
            current_day=season.current_day,
            current_week=season.current_week,
            reasoning="human",
            proposer_message=req.proposer_message,
            force=req.force,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    storage.append_log({
        "type": "trade_proposed",
        "trade_id": trade.id,
        "from_team": trade.from_team,
        "to_team": trade.to_team,
        "send": trade.send_player_ids,
        "receive": trade.receive_player_ids,
        "day": season.current_day,
        "week": season.current_week,
        "reasoning": "human",
    })

    # Defer LLM calls (peer commentary + counterparty auto-decide) to background
    # so the POST returns immediately. Frontend polls /api/trades/pending to
    # pick up commentary and the eventual decision.
    def _finalize(trade_id: str, to_team: int, current_day: int) -> None:
        try:
            fresh_season = _load_or_init_season()
            if fresh_season is None:
                return
            bg_mgr = TradeManager(
                storage, draft, fresh_season,
                settings=settings if settings.setup_complete else None,
            )
            bg_trade = bg_mgr._find(trade_id)
            if bg_trade is None or bg_trade.status != "pending_accept":
                return
            try:
                bg_mgr.collect_peer_commentary_sync(bg_trade, ai_gm)
            except Exception:
                pass
            cp = draft.teams[to_team]
            if not cp.is_human:
                # Re-read state right before AI decision: the human may have
                # cancelled while we were collecting peer commentary.
                fresh2 = _load_or_init_season()
                if fresh2 is None:
                    return
                bg_mgr2 = TradeManager(
                    storage, draft, fresh2,
                    settings=settings if settings.setup_complete else None,
                )
                bg_trade2 = bg_mgr2._find(trade_id)
                if bg_trade2 is None or bg_trade2.status != "pending_accept":
                    return
                try:
                    bg_mgr2.auto_decide_ai(ai_gm, current_day)
                except Exception:
                    pass
        except Exception:
            pass

    background.add_task(_finalize, trade.id, req.to_team, season.current_day)
    return trade.model_dump()


@app.post("/api/trades/{trade_id}/accept")
def trades_accept(trade_id: str):
    season = _require_season()
    settings = _current_settings()
    mgr = TradeManager(
        storage, draft, season,
        settings=settings if settings.setup_complete else None,
    )
    trade = mgr._find(trade_id)
    if trade is None:
        raise HTTPException(404, "Unknown trade_id")
    try:
        result = mgr.decide(
            trade_id, trade.to_team, True, season.current_day, ai_gm=ai_gm
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    storage.append_log({
        "type": "trade_accepted",
        "trade_id": result.id,
        "from_team": result.from_team,
        "to_team": result.to_team,
        "day": season.current_day,
        "week": season.current_week,
    })
    return result.model_dump()


@app.post("/api/trades/{trade_id}/reject")
def trades_reject(trade_id: str):
    season = _require_season()
    settings = _current_settings()
    mgr = TradeManager(
        storage, draft, season,
        settings=settings if settings.setup_complete else None,
    )
    trade = mgr._find(trade_id)
    if trade is None:
        raise HTTPException(404, "Unknown trade_id")
    try:
        result = mgr.decide(trade_id, trade.to_team, False, season.current_day)
    except ValueError as e:
        raise HTTPException(400, str(e))
    storage.append_log({
        "type": "trade_rejected",
        "trade_id": result.id,
        "from_team": result.from_team,
        "to_team": result.to_team,
        "day": season.current_day,
        "week": season.current_week,
    })
    return result.model_dump()


@app.post("/api/trades/{trade_id}/veto")
def trades_veto(trade_id: str, req: TradeVetoRequest):
    season = _require_season()
    settings = _current_settings()
    mgr = TradeManager(
        storage, draft, season,
        settings=settings if settings.setup_complete else None,
    )
    try:
        result = mgr.veto(trade_id, req.team_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    storage.append_log({
        "type": "trade_veto_vote",
        "trade_id": result.id,
        "voter": req.team_id,
        "total_votes": len(result.veto_votes),
        "day": season.current_day,
    })
    return result.model_dump()


@app.post("/api/trades/{trade_id}/cancel")
def trades_cancel(trade_id: str):
    season = _require_season()
    settings = _current_settings()
    mgr = TradeManager(
        storage, draft, season,
        settings=settings if settings.setup_complete else None,
    )
    trade = mgr._find(trade_id)
    if trade is None:
        raise HTTPException(404, "Unknown trade_id")
    try:
        result = mgr.cancel(trade_id, trade.from_team)
    except ValueError as e:
        raise HTTPException(400, str(e))
    storage.append_log({
        "type": "trade_cancelled",
        "trade_id": result.id,
        "from_team": result.from_team,
        "day": season.current_day,
    })
    return result.model_dump()
