"""FastAPI entry point: static file mount + draft & season APIs."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
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
from .storage import Storage, resolve_data_dir
from .trades import TradeManager


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR.parent / "static"
PLAYERS_FILE = BASE_DIR / "data" / "players.json"
DEFAULT_DATA_DIR = BASE_DIR.parent / "data"
APP_VERSION = "0.2.0"

LEAGUE_ID = os.getenv("LEAGUE_ID", "default")
DATA_DIR = resolve_data_dir(os.getenv("DATA_DIR"), DEFAULT_DATA_DIR)

app = FastAPI(title="Fantasy NBA Draft Sim", version=APP_VERSION)

storage = Storage(DATA_DIR, league_id=LEAGUE_ID)
import time as _time
draft = DraftState(PLAYERS_FILE, seed=int(_time.time()) & 0xFFFFFFFF)
ai_gm = AIGM(api_key=os.getenv("ANTHROPIC_API_KEY"))

# Restore draft from disk if present
_initial_draft = storage.load_draft()
if _initial_draft:
    try:
        draft.restore(_initial_draft)
    except Exception:
        # Corrupt snapshot: keep fresh state
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
def _state_snapshot() -> DraftStateOut:
    rnd, pos, team_id = draft.current_pointers()
    return DraftStateOut(
        teams=draft.teams,
        picks=draft.picks,
        board=draft.board(),
        current_overall=draft.current_overall if not draft.is_complete else NUM_TEAMS * ROSTER_SIZE + 1,
        current_round=rnd,
        current_pick_in_round=pos,
        current_team_id=team_id,
        is_complete=draft.is_complete,
        available_count=len(draft.available_players()),
        total_rounds=ROSTER_SIZE,
        num_teams=NUM_TEAMS,
        human_team_id=0,
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
        # Pydantic re-serializes dict keys as strings; normalize back to ints
        state.standings = {int(k): v for k, v in state.standings.items()}
        state.lineups = {int(k): v for k, v in state.lineups.items()}
        return state
    except Exception:
        return None


def _require_season() -> SeasonState:
    state = _load_or_init_season()
    if state is None or not state.started:
        raise HTTPException(400, "Season has not started")
    return state


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

    reverse = sort != "name" and sort != "to"  # ascending for name and TO
    pool.sort(key=lambda p: getattr(p, sort), reverse=reverse)
    return [p.model_dump() for p in pool[:limit]]


@app.get("/api/teams/{team_id}")
def get_team(team_id: int):
    if team_id < 0 or team_id >= NUM_TEAMS:
        raise HTTPException(404, "Unknown team_id")
    team = draft.teams[team_id]
    players = [draft.players_by_id[pid].model_dump() for pid in team.roster]
    return {
        "team": team.model_dump(),
        "players": players,
        "totals": draft.team_totals(team_id),
        "persona_desc": GM_PERSONAS[team.gm_persona]["desc"] if team.gm_persona else None,
    }


@app.post("/api/draft/pick")
def human_pick(req: PickRequest):
    try:
        pick = draft.human_pick(req.player_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    _persist_draft()
    return {"pick": pick.model_dump(), "state": _state_snapshot().model_dump()}


@app.post("/api/draft/ai-advance")
def ai_advance():
    if draft.is_complete:
        return {"pick": None, "state": _state_snapshot().model_dump()}
    _, _, team_id = draft.current_pointers()
    if team_id == 0:
        raise HTTPException(400, "It's the human's turn")
    pick = draft.ai_pick()
    _persist_draft()
    return {
        "pick": pick.model_dump() if pick else None,
        "state": _state_snapshot().model_dump(),
    }


@app.post("/api/draft/sim-to-me")
def sim_to_me():
    made = draft.sim_to_human()
    _persist_draft()
    return {
        "picks": [p.model_dump() for p in made],
        "state": _state_snapshot().model_dump(),
    }


@app.post("/api/draft/reset")
def reset_draft(req: ResetRequest = ResetRequest()):
    seed = req.seed if req.seed is not None else (int(_time.time() * 1000) & 0xFFFFFFFF)
    draft.reset(randomize_order=req.randomize_order, seed=seed)
    _persist_draft()
    # Clearing a draft also invalidates the season and trade state
    storage.clear_season()
    storage.clear_trades()
    return _state_snapshot()


# ---------------------------------------------------------------------------
# Season API
# ---------------------------------------------------------------------------
@app.post("/api/season/start")
def season_start_endpoint(_req: StartSeasonRequest = StartSeasonRequest()):
    if not draft.is_complete:
        raise HTTPException(400, "Draft is not complete")
    state = season_start(draft, storage)
    return state.model_dump()


@app.post("/api/season/advance-day")
def season_advance_day_endpoint(req: AdvanceRequest = AdvanceRequest()):
    state = _require_season()
    state = season_advance_day(draft, state, storage, ai_gm=ai_gm, use_ai=req.use_ai)
    return state.model_dump()


@app.post("/api/season/advance-week")
def season_advance_week_endpoint(req: AdvanceRequest = AdvanceRequest()):
    state = _require_season()
    state = season_advance_week(draft, state, storage, ai_gm=ai_gm, use_ai=req.use_ai)
    return state.model_dump()


@app.post("/api/season/sim-to-playoffs")
def season_sim_to_playoffs_endpoint(req: AdvanceRequest = AdvanceRequest()):
    state = _require_season()
    state = season_sim_to_playoffs(draft, state, storage, ai_gm=ai_gm, use_ai=req.use_ai)
    return state.model_dump()


@app.post("/api/season/sim-playoffs")
def season_sim_playoffs_endpoint(req: AdvanceRequest = AdvanceRequest()):
    state = _require_season()
    state = season_sim_playoffs(draft, state, storage, ai_gm=ai_gm, use_ai=req.use_ai)
    return state.model_dump()


@app.get("/api/season/standings")
def season_standings():
    state = _require_season()
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
    mgr = TradeManager(storage, draft, state)
    return {
        "standings": rows,
        "current_week": state.current_week,
        "current_day": state.current_day,
        "is_playoffs": state.is_playoffs,
        "champion": state.champion,
        "regular_weeks": REGULAR_WEEKS,
        "trade_quota": mgr.quota_info(state.current_week),
        "pending_count": len(mgr.pending()),
    }


@app.get("/api/season/schedule")
def season_schedule():
    state = _require_season()
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


@app.post("/api/season/reset")
def season_reset():
    storage.clear_season()
    storage.clear_trades()
    storage.append_log({"type": "season_reset"})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Trades API
# ---------------------------------------------------------------------------
def _trade_manager() -> TradeManager:
    """Build a fresh TradeManager using current draft + season state."""
    season = _load_or_init_season() or SeasonState()
    return TradeManager(storage, draft, season)


class TradeProposeRequest(BaseModel):
    from_team: int
    to_team: int
    send: list[int]
    receive: list[int]


class TradeVetoRequest(BaseModel):
    team_id: int


@app.get("/api/trades/pending")
def trades_pending():
    mgr = _trade_manager()
    pending = [t.model_dump() for t in mgr.pending()]
    attention = mgr.require_human_attention(human_team_id=0)
    return {"pending": pending, "require_human_attention": attention}


@app.get("/api/trades/history")
def trades_history(limit: int = Query(50, ge=1, le=500)):
    mgr = _trade_manager()
    return {"history": [t.model_dump() for t in mgr.history(limit=limit)]}


@app.post("/api/trades/propose")
def trades_propose(req: TradeProposeRequest):
    if req.from_team != 0:
        raise HTTPException(400, "Only the human (team 0) may propose via this endpoint")
    season = _require_season()
    mgr = TradeManager(storage, draft, season)
    try:
        trade = mgr.propose(
            from_team=req.from_team,
            to_team=req.to_team,
            send_ids=req.send,
            receive_ids=req.receive,
            current_day=season.current_day,
            current_week=season.current_week,
            reasoning="human",
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
    return trade.model_dump()


@app.post("/api/trades/{trade_id}/accept")
def trades_accept(trade_id: str):
    season = _require_season()
    mgr = TradeManager(storage, draft, season)
    trade = mgr._find(trade_id)
    if trade is None:
        raise HTTPException(404, "Unknown trade_id")
    # Only the counterparty may accept; the human hitting this endpoint must
    # be the counterparty (to_team=0 for human-targeted trades).
    try:
        result = mgr.decide(trade_id, trade.to_team, True, season.current_day)
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
    mgr = TradeManager(storage, draft, season)
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
    mgr = TradeManager(storage, draft, season)
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
    mgr = TradeManager(storage, draft, season)
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
