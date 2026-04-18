"""FastAPI entry point: static file mount + draft & season APIs."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
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
    check_lineup_feasibility,
    sim_playoffs as season_sim_playoffs,
    sim_to_playoffs as season_sim_to_playoffs,
    start_season as season_start,
)
from .injuries_route import router as injuries_router
from .storage import (
    Storage,
    resolve_data_dir,
    list_leagues as storage_list_leagues,
    create_league as storage_create_league,
    delete_league as storage_delete_league,
    get_active_league,
    set_active_league,
    _validate_league_id,
)
from .trades import TradeManager


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR.parent / "static"
PLAYERS_FILE = BASE_DIR / "data" / "players.json"
SEASONS_DIR = BASE_DIR / "data" / "seasons"
DEFAULT_DATA_DIR = BASE_DIR.parent / "data"
APP_VERSION = "0.5.39"

DATA_DIR = resolve_data_dir(os.getenv("DATA_DIR"), DEFAULT_DATA_DIR)
# LEAGUE_ID resolution priority: env LEAGUE_ID > active-league pointer > "default"
_env_league = os.getenv("LEAGUE_ID")
if _env_league:
    LEAGUE_ID = _env_league
else:
    LEAGUE_ID = get_active_league(DATA_DIR, fallback="default")

app = FastAPI(title="Fantasy NBA Draft Sim", version=APP_VERSION)
app.include_router(injuries_router)


@app.middleware("http")
async def _security_and_cache_headers(request, call_next):
    """Round-2 hardening: CSP/HSTS/XFO/XCTO + per-route cache hints.

    - Security headers sent on every response (defense-in-depth; origin behind
      Cloudflare but these travel end-to-end).
    - Light caching for read-only /api/* endpoints to reduce polling cost. Only
      GETs are cached; any query string (e.g. league_id) is part of the URL so
      no manual Vary needed beyond the defaults.
    """
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
    )
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com https://ajax.cloudflare.com; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; "
        "connect-src 'self' https://cloudflareinsights.com; "
        "base-uri 'self'; "
        "frame-ancestors 'none'",
    )
    if request.method == "GET":
        path = request.url.path
        # Only /api/personas is truly static. /api/players is NOT cacheable
        # because available-filtered pool changes on every pick; caching it
        # left just-drafted players visible in the pick list (v0.5.27 bug).
        CACHEABLE = ("/api/personas",)
        if any(path == p or path.startswith(p + "/") or path.startswith(p + "?") for p in CACHEABLE):
            response.headers.setdefault("Cache-Control", "private, max-age=60")
        elif path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
    return response

# Lock guarding module-global reassignment during /api/leagues/switch.
import threading as _threading
_league_lock = _threading.Lock()

storage = Storage(DATA_DIR, league_id=LEAGUE_ID)

# ---------------------------------------------------------------------------
# Startup: respect saved league settings if setup_complete=True
# ---------------------------------------------------------------------------
import time as _time


def _build_draft_for(storage_obj: Storage) -> DraftState:
    """Construct + restore a DraftState for a given storage (league)."""
    settings = storage_obj.load_league_settings()
    if settings.setup_complete:
        d = DraftState(PLAYERS_FILE, seed=int(_time.time()) & 0xFFFFFFFF, settings=settings)
    else:
        d = DraftState(PLAYERS_FILE, seed=int(_time.time()) & 0xFFFFFFFF)
    snap = storage_obj.load_draft()
    if snap:
        try:
            d.restore(snap)
        except Exception as _exc:
            import traceback as _tb, sys as _sys
            print(f"[startup] draft.restore failed for league={storage_obj.league_id}: {_exc!r}", file=_sys.stderr)
            _tb.print_exc()
    return d


draft = _build_draft_for(storage)
ai_gm = AIGM(api_key=os.getenv("ANTHROPIC_API_KEY"))


def _repair_legacy_league_names() -> None:
    """One-time migration for pre-v0.5.23 leagues where league_settings.json
    was never pre-seeded. If a league's stored ``league_name`` differs from
    its directory name AND matches the default "我的聯盟", assume the name
    was never customised and overwrite with the directory name. Legacy rows
    that carry a deliberately chosen display name are left alone.
    """
    try:
        leagues_root = (DATA_DIR / "leagues")
        if not leagues_root.exists():
            return
        for sub in leagues_root.iterdir():
            if not sub.is_dir():
                continue
            lid = sub.name
            s = Storage(DATA_DIR, league_id=lid)
            ls = s.load_league_settings()
            if ls.league_name in ("我的聯盟", "", None) or (
                ls.league_name != lid and not ls.setup_complete
            ):
                ls.league_name = lid
                s.save_league_settings(ls)
    except Exception as _exc:
        import sys as _sys
        print(f"[startup] legacy league-name repair failed: {_exc!r}", file=_sys.stderr)


_repair_legacy_league_names()


def _switch_league(new_league_id: str) -> None:
    """Reassign module-level storage + draft for the given league.

    Safe under threadpool concurrency via _league_lock. After switching, the
    active-league pointer is persisted so subsequent restarts default here.
    """
    global storage, draft, LEAGUE_ID
    new_league_id = _validate_league_id(new_league_id)
    leagues_root = (DATA_DIR / "leagues").resolve()
    target = (leagues_root / new_league_id).resolve()
    # Defense in depth: refuse anything that escapes leagues_root
    if target == leagues_root or leagues_root not in target.parents:
        raise ValueError("invalid league path")
    if not target.is_dir():
        raise ValueError(f"league '{new_league_id}' does not exist")
    with _league_lock:
        new_storage = Storage(DATA_DIR, league_id=new_league_id)
        new_draft = _build_draft_for(new_storage)
        storage = new_storage
        draft = new_draft
        LEAGUE_ID = new_league_id
    try:
        set_active_league(DATA_DIR, new_league_id)
    except Exception as _exc:
        import sys as _sys
        print(f"[switch] set_active_league failed: {_exc!r}", file=_sys.stderr)


# ---------------------------------------------------------------------------
# Static files
# ---------------------------------------------------------------------------
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", include_in_schema=False)
def index():
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    html = html.replace('/static/app.js', f'/static/app.js?v={APP_VERSION}')
    html = html.replace('/static/style.css', f'/static/style.css?v={APP_VERSION}')
    html = html.replace('{{APP_VERSION}}', APP_VERSION)
    return HTMLResponse(html)


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
    except Exception as exc:
        import traceback, sys
        print(f"[persist] save_draft failed: {exc!r}", file=sys.stderr)
        traceback.print_exc()


def _load_or_init_season() -> Optional[SeasonState]:
    raw = storage.load_season()
    if not raw:
        return None
    try:
        state = SeasonState(**raw)
        state.standings = {int(k): v for k, v in state.standings.items()}
        state.lineups = {int(k): v for k, v in state.lineups.items()}
        state.injuries = {int(k): v for k, v in state.injuries.items()}
        state.lineup_overrides = {int(k): v for k, v in state.lineup_overrides.items()}
        state.lineup_override_today_only = {int(k): v for k, v in state.lineup_override_today_only.items()}
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
            except Exception as exc:
                import traceback, sys
                print(f"[season] save after model remap failed: {exc!r}", file=sys.stderr)
                traceback.print_exc()
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
        raise HTTPException(409, "賽季尚未開始")
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
        "ai_enabled": ai_gm.enabled,
    }


# ---------------------------------------------------------------------------
# League management (multi-league)
# ---------------------------------------------------------------------------
class CreateLeagueRequest(BaseModel):
    league_id: str
    switch: bool = True  # immediately make this the active league


class SwitchLeagueRequest(BaseModel):
    league_id: str


@app.get("/api/leagues/list")
def leagues_list():
    items = storage_list_leagues(DATA_DIR)
    return {"leagues": items, "active": LEAGUE_ID}


@app.post("/api/leagues/create")
def leagues_create(req: CreateLeagueRequest):
    try:
        storage_create_league(DATA_DIR, req.league_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if req.switch:
        try:
            _switch_league(req.league_id)
        except ValueError as e:
            raise HTTPException(400, str(e))
    return {"ok": True, "active": LEAGUE_ID}


@app.post("/api/leagues/switch")
def leagues_switch(req: SwitchLeagueRequest):
    try:
        _switch_league(req.league_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "active": LEAGUE_ID}


@app.post("/api/leagues/delete")
def leagues_delete(req: SwitchLeagueRequest):
    # Refuse to delete the currently-active league (prevents orphaning globals)
    if req.league_id == LEAGUE_ID:
        raise HTTPException(400, "無法刪除當前使用中的聯盟,請先切換到其他聯盟")
    try:
        storage_delete_league(DATA_DIR, req.league_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


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
                f"聯盟設定完成後無法變更欄位：{sorted(forbidden)}",
            )
    # model_copy(update=...) skips field_validators, so chaos agent 6 found
    # that empty team_names slipped through. Re-validate by round-tripping
    # through model_validate, which fires @field_validator.
    try:
        updated = LeagueSettings.model_validate({**settings.model_dump(), **body})
    except ValueError as e:
        raise HTTPException(400, str(e))
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
    prev_map = getattr(draft, "_prev_fppg_map", {}) or {}
    out = []
    for p in pool[:limit]:
        row = p.model_dump()
        pf = prev_map.get(p.id)
        row["prev_fppg"] = pf if pf is not None else None
        out.append(row)
    return out


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

    # Check for human lineup override
    lineup_override: list[int] | None = None
    has_override = False
    if season is not None and team.is_human:
        lineup_override = season.lineup_overrides.get(team.id)
        if lineup_override:
            has_override = True

    if lineup_override:
        # Build slot_rows from the override order (assign_slots greedily from overridden starters)
        valid_override = [pid for pid in lineup_override if pid in draft.players_by_id and pid not in injured_out]
        slot_rows = _assign_slots(valid_override, draft.players_by_id, LINEUP_SLOTS[:LINEUP_SIZE])
        assigned_ids = {s["player_id"] for s in slot_rows if s["player_id"] is not None}
    else:
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
        "has_lineup_override": has_override,
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
        raise HTTPException(409, "目前是玩家的回合")
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
    # Refuse to silently wipe an existing season. Callers that want a fresh
    # start must hit /api/season/reset first (explicit, Chinese-labelled in UI).
    existing = _load_or_init_season()
    if existing is not None and (
        existing.champion is not None or int(existing.current_day or 0) > 0
    ):
        raise HTTPException(
            409,
            "賽季已存在，請先使用「重置賽季」清除後再開始。",
        )
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


@app.get("/api/season/advance-week/stream")
def season_advance_week_stream():
    _require_setup()
    state = _require_season()
    settings = _current_settings()

    def event_stream():
        nonlocal state
        try:
            for _ in range(7):
                if state.champion is not None:
                    break
                state = season_advance_day(
                    draft, state, storage, ai_gm=ai_gm, use_ai=True, settings=settings
                )
                yield f"data: {json.dumps({'day': state.current_day, 'week': state.current_week})}\n\n"
                if state.current_day % 7 == 0:
                    break
            yield f"data: {json.dumps({'done': True, 'week': state.current_week})}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


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

    # Execute swap (keep drafted_ids in sync so dropped player returns to FA pool
    # and claimed player disappears from FA pool)
    human.roster = [p for p in human.roster if p != req.drop_player_id]
    human.roster.append(req.add_player_id)
    draft.drafted_ids.discard(req.drop_player_id)
    draft.drafted_ids.add(req.add_player_id)

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
    except Exception as exc:
        import traceback, sys
        print(f"[waiver] save_draft failed: {exc!r}", file=sys.stderr)
        traceback.print_exc()
    try:
        storage.save_season(state.model_dump())
    except Exception as exc:
        import traceback, sys
        print(f"[waiver] save_season failed: {exc!r}", file=sys.stderr)
        traceback.print_exc()

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


class LineupOverrideRequest(BaseModel):
    team_id: int
    starters: list[int]  # exactly 10 player_ids
    today_only: bool = False  # if True, auto-clear after the next sim day


@app.post("/api/season/lineup")
def set_lineup_override(req: LineupOverrideRequest):
    """Human user manually sets their 10 starters. Persists until cleared (or one-shot if today_only)."""
    state = _require_season()
    human = next((t for t in draft.teams if t.is_human), None)
    if human is None:
        raise HTTPException(400, "找不到人類隊伍")
    if req.team_id != human.id:
        raise HTTPException(403, "只能修改自己的陣容")

    from .season import SLOT_ELIGIBILITY, _player_positions, LINEUP_SIZE
    lineup_sz = LINEUP_SIZE
    settings = storage.load_league_settings()
    if settings is not None:
        lineup_sz = settings.starters_per_day

    if len(req.starters) != lineup_sz:
        raise HTTPException(400, f"必須選滿 {lineup_sz} 名先發球員")
    if len(set(req.starters)) != lineup_sz:
        raise HTTPException(400, "先發球員不可重複")

    roster_set = set(human.roster)
    for pid in req.starters:
        if pid not in roster_set:
            raise HTTPException(400, f"球員 {pid} 不在你的名單中")
        player = draft.players_by_id.get(pid)
        if player is None:
            raise HTTPException(400, f"找不到球員 {pid}")
        # Check player can fill at least one slot
        player_pos = _player_positions(player.pos)
        eligible_for_any = any(
            player_pos & eligible_pos
            for eligible_pos in SLOT_ELIGIBILITY.values()
        )
        if not eligible_for_any:
            raise HTTPException(400, f"球員 {player.name} 無法填入任何位置")

    # Feasibility check: ensure all 10 slots can be filled
    unfilled = check_lineup_feasibility(list(req.starters), draft.players_by_id)
    if unfilled:
        slots_str = '/'.join(unfilled)
        raise HTTPException(400, f'這 10 位球員無法填滿全部先發位置 (缺:{slots_str})')

    state.lineup_overrides[human.id] = list(req.starters)
    if req.today_only:
        state.lineup_override_today_only[human.id] = True
    else:
        state.lineup_override_today_only.pop(human.id, None)
    storage.save_season(state.model_dump())
    storage.append_log({
        "type": "lineup_override_set",
        "team_id": human.id,
        "starters": req.starters,
        "today_only": req.today_only,
    })
    return {"ok": True, "starters": req.starters, "today_only": req.today_only}


@app.delete("/api/season/lineup/{team_id}")
def clear_lineup_override(team_id: int):
    """Reset human lineup override back to auto."""
    state = _require_season()
    human = next((t for t in draft.teams if t.is_human), None)
    if human is None:
        raise HTTPException(400, "找不到人類隊伍")
    if team_id != human.id:
        raise HTTPException(403, "只能修改自己的陣容")

    state.lineup_overrides.pop(human.id, None)
    state.lineup_override_today_only.pop(human.id, None)
    storage.save_season(state.model_dump())
    storage.append_log({"type": "lineup_override_cleared", "team_id": human.id})
    return {"ok": True}


@app.get("/api/season/lineup-alerts")
def get_lineup_override_alerts():
    """Return pending lineup_override_alerts (cleared-override notifications for the UI)."""
    state = _load_or_init_season()
    if state is None or not state.started:
        return {"alerts": []}
    return {"alerts": state.lineup_override_alerts}


@app.delete("/api/season/lineup-alerts")
def clear_lineup_override_alerts():
    """Clear the pending lineup_override_alerts list (called by UI after showing toasts)."""
    state = _require_season()
    state.lineup_override_alerts = []
    storage.save_season(state.model_dump())
    return {"ok": True}


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


@app.get("/api/season/activity")
def season_activity(limit: int = Query(20, ge=1, le=100)):
    """Return up to `limit` notable activity feed entries, newest first."""
    teams_by_id: dict[int, str] = {t.id: t.name for t in draft.teams}

    def _team(tid) -> str:
        return teams_by_id.get(tid, f"隊伍{tid}")

    NOTABLE = {
        "trade_accepted", "trade_executed", "trade_rejected", "trade_vetoed",
        "fa_claim", "milestone_blowout", "milestone_nailbiter",
        "milestone_win_streak", "milestone_lose_streak", "milestone_top_performer",
        "injury_new", "injury_return", "champion",
    }

    def _summary(e: dict) -> str:
        t = e.get("type", "")
        w = e.get("week") or e.get("day", "?")
        d = e.get("day", "")
        prefix = f"W{e['week']} D{d}" if e.get("week") and d else (f"W{w}" if e.get("week") else f"D{d}" if d else "")

        if t == "trade_accepted":
            return f"{prefix} {_team(e.get('from_team','?'))} ↔ {_team(e.get('to_team','?'))} 交易接受"
        if t == "trade_executed":
            return f"{prefix} {_team(e.get('from_team','?'))} ↔ {_team(e.get('to_team','?'))} 交易完成"
        if t == "trade_rejected":
            return f"{prefix} {_team(e.get('to_team','?'))} 拒絕 {_team(e.get('from_team','?'))} 的交易"
        if t == "trade_vetoed":
            return f"{prefix} {_team(e.get('from_team','?'))} ↔ {_team(e.get('to_team','?'))} 交易被否決"
        if t == "fa_claim":
            return f"{prefix} {_team(e.get('team_id','?'))} 簽下 {e.get('add_name','?')} / 放走 {e.get('drop_name','?')}"
        if t == "milestone_blowout":
            return f"W{e.get('week','?')} {_team(e.get('winner','?'))} 大勝 {_team(e.get('loser','?'))} (+{e.get('diff','?')})"
        if t == "milestone_nailbiter":
            return f"W{e.get('week','?')} {_team(e.get('winner','?'))} 驚險勝出 (差距 {e.get('diff','?')})"
        if t == "milestone_win_streak":
            return f"W{e.get('week','?')} {_team(e.get('team_id','?'))} 連勝 {e.get('streak',3)} 週"
        if t == "milestone_lose_streak":
            return f"W{e.get('week','?')} {_team(e.get('team_id','?'))} 連敗 {e.get('streak',3)} 週"
        if t == "milestone_top_performer":
            return f"W{e.get('week','?')} {e.get('player_name','?')} 單週得 {e.get('fp','?')} 分 ({_team(e.get('team_id','?'))})"
        if t == "injury_new":
            return f"{prefix} {e.get('player_name', e.get('player_id','?'))} 受傷 ({_team(e.get('team_id','?'))})"
        if t == "injury_return":
            return f"{prefix} {e.get('player_name', e.get('player_id','?'))} 復出 ({_team(e.get('team_id','?'))})"
        if t == "champion":
            return f"🏆 {_team(e.get('team_id','?'))} 奪冠！"
        return t

    raw = storage.load_log(limit=50)
    notable = [e for e in raw if e.get("type") in NOTABLE]
    notable = list(reversed(notable))[:limit]

    result = []
    for e in notable:
        result.append({
            "day": e.get("day"),
            "week": e.get("week"),
            "type": e.get("type"),
            "summary": _summary(e),
            "team_names": [
                _team(e[k]) for k in ("from_team", "to_team", "team_id", "winner", "loser")
                if k in e and e[k] is not None
            ],
        })
    return {"activity": result}


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


@app.get("/api/season/week-recap")
def season_week_recap(week: int = Query(..., ge=1)):
    """Weekly recap: matchup scores, top 5 single-game performances that week,
    biggest blowout, closest game, human matchup highlight."""
    state = _load_or_init_season()
    if state is None or not state.started:
        raise HTTPException(409, "賽季尚未開始")

    week_matchups = [m for m in state.schedule if m.week == week and m.complete]
    if not week_matchups:
        raise HTTPException(404, f"Week {week} has no resolved matchups yet")

    players_by_id = {p.id: p for p in draft.players}
    teams_by_id = {t.id: t for t in draft.teams}
    human_id = draft.human_team_id

    def _team_name(tid: int) -> str:
        t = teams_by_id.get(tid)
        return t.name if t else f"T{tid}"

    # Top 5 single-game performances this week.
    # Note: game_logs are trimmed to the last 3 weeks by advance_day, so requesting
    # an older recap returns empty performers — flag it so the UI can show a notice.
    week_logs = [g for g in state.game_logs if g.week == week and g.played]
    logs_trimmed = (not week_logs) and (state.current_week - week > 2)
    week_logs_sorted = sorted(week_logs, key=lambda g: g.fp, reverse=True)
    top_performers = []
    for g in week_logs_sorted[:5]:
        p = players_by_id.get(g.player_id)
        top_performers.append({
            "player_id": g.player_id,
            "player_name": p.name if p else f"#{g.player_id}",
            "team_id": g.team_id,
            "team_name": _team_name(g.team_id),
            "day": g.day,
            "fp": round(float(g.fp), 1),
            "pts": round(float(g.pts), 1),
            "reb": round(float(g.reb), 1),
            "ast": round(float(g.ast), 1),
            "stl": round(float(g.stl), 1),
            "blk": round(float(g.blk), 1),
        })

    # Matchups + diff
    matchups_out = []
    biggest_blowout = None
    closest_game = None
    human_matchup = None
    for m in week_matchups:
        diff = abs(float(m.score_a) - float(m.score_b))
        entry = {
            "team_a": m.team_a,
            "team_a_name": _team_name(m.team_a),
            "team_b": m.team_b,
            "team_b_name": _team_name(m.team_b),
            "score_a": round(float(m.score_a), 2),
            "score_b": round(float(m.score_b), 2),
            "winner": m.winner,
            "winner_name": _team_name(m.winner) if m.winner else None,
            "diff": round(diff, 2),
        }
        matchups_out.append(entry)
        if biggest_blowout is None or diff > biggest_blowout["diff"]:
            biggest_blowout = entry
        if closest_game is None or diff < closest_game["diff"]:
            closest_game = entry
        if m.team_a == human_id or m.team_b == human_id:
            human_matchup = entry

    # Human team top scorer this week (if human has a roster)
    human_top = None
    if human_id is not None:
        human_logs = [g for g in week_logs if g.team_id == human_id]
        if human_logs:
            g = max(human_logs, key=lambda x: x.fp)
            p = players_by_id.get(g.player_id)
            human_top = {
                "player_id": g.player_id,
                "player_name": p.name if p else f"#{g.player_id}",
                "day": g.day,
                "fp": round(float(g.fp), 1),
            }

    return {
        "week": week,
        "matchups": matchups_out,
        "top_performers": top_performers,
        "biggest_blowout": biggest_blowout,
        "closest_game": closest_game,
        "human_matchup": human_matchup,
        "human_top_performer": human_top,
        "logs_trimmed": logs_trimmed,
    }


@app.get("/api/season/matchup-detail")
def season_matchup_detail(week: int = Query(..., ge=1), team_a: int = Query(...), team_b: int = Query(...)):
    """Per-player per-day logs for a single matchup. Used by the matchup-detail
    dialog to show 'day X: player Y scored Z FP'. Only covers weeks still in
    game_logs (last ~3 weeks); older matchups return empty players with
    logs_trimmed=True and the UI falls back to the final score only.
    """
    state = _load_or_init_season()
    if state is None or not state.started:
        raise HTTPException(409, "賽季尚未開始")

    players_by_id = {p.id: p for p in draft.players}
    teams_by_id = {t.id: t for t in draft.teams}
    matchup = next(
        (m for m in state.schedule
         if m.week == week and {m.team_a, m.team_b} == {team_a, team_b}),
        None,
    )
    if matchup is None:
        raise HTTPException(404, f"Week {week} {team_a}-vs-{team_b} not found")

    def _player_rows(tid: int):
        rows = [g for g in state.game_logs if g.week == week and g.team_id == tid]
        rows.sort(key=lambda g: (g.day, -g.fp))
        out = []
        for g in rows:
            p = players_by_id.get(g.player_id)
            out.append({
                "day": g.day,
                "player_id": g.player_id,
                "player_name": p.name if p else f"#{g.player_id}",
                "pos": p.pos if p else "",
                "played": bool(g.played),
                "fp": round(float(g.fp), 1),
                "pts": round(float(g.pts), 1),
                "reb": round(float(g.reb), 1),
                "ast": round(float(g.ast), 1),
                "stl": round(float(g.stl), 1),
                "blk": round(float(g.blk), 1),
                "to": round(float(g.to), 1),
            })
        return out

    rows_a = _player_rows(team_a)
    rows_b = _player_rows(team_b)
    logs_trimmed = (not rows_a and not rows_b) and (state.current_week - week > 2)

    def _tname(tid: int) -> str:
        t = teams_by_id.get(tid)
        return t.name if t else f"T{tid}"

    return {
        "week": week,
        "team_a": team_a,
        "team_a_name": _tname(team_a),
        "team_b": team_b,
        "team_b_name": _tname(team_b),
        "score_a": round(float(matchup.score_a), 2),
        "score_b": round(float(matchup.score_b), 2),
        "winner": matchup.winner,
        "complete": bool(matchup.complete),
        "players_a": rows_a,
        "players_b": rows_b,
        "logs_trimmed": logs_trimmed,
    }


@app.get("/api/season/summary")
def season_summary():
    """Championship summary: final standings, MVP (highest season fp),
    top 5 single-game performances, human record, persona callouts."""
    state = _load_or_init_season()
    if state is None or not state.started:
        raise HTTPException(409, "賽季尚未開始")
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
            except Exception as exc:
                import traceback, sys
                print(f"[finalize] peer_commentary failed: {exc!r}", file=sys.stderr)
                traceback.print_exc()
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
                except Exception as exc:
                    import traceback, sys
                    print(f"[finalize] auto_decide_ai failed: {exc!r}", file=sys.stderr)
                    traceback.print_exc()
        except Exception as exc:
            import traceback, sys
            print(f"[finalize] outer failure: {exc!r}", file=sys.stderr)
            traceback.print_exc()

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
