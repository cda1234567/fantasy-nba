"""Injury report API endpoints."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/injuries")


def _get_season_and_draft():
    """Import here to avoid circular imports at module load time."""
    from .main import _load_or_init_season, _get_draft
    return _load_or_init_season, _get_draft()


@router.get("/active")
def list_active():
    _load_or_init_season, draft = _get_season_and_draft()
    season = _load_or_init_season()
    if season is None or not season.started:
        raise HTTPException(409, "賽季尚未開始")

    active = []
    for pid, inj in season.injuries.items():
        if inj.status != "healthy":
            entry = inj.model_dump()
            player = draft.players_by_id.get(pid)
            if player:
                entry["player_name"] = player.name
                entry["nba_team"] = player.team
            # Find owning fantasy team
            entry["fantasy_team_id"] = None
            entry["fantasy_team_name"] = None
            for team in draft.teams:
                if pid in team.roster:
                    entry["fantasy_team_id"] = team.id
                    entry["fantasy_team_name"] = team.name
                    break
            active.append(entry)

    active.sort(key=lambda e: e.get("return_in_days", 0), reverse=True)
    return {"active": active, "count": len(active)}


@router.get("/history")
def injury_history(limit: int = 100):
    _load_or_init_season, draft = _get_season_and_draft()
    season = _load_or_init_season()
    if season is None or not season.started:
        raise HTTPException(409, "賽季尚未開始")

    history = []
    for inj in season.injury_history[-limit:]:
        entry = inj.model_dump()
        player = draft.players_by_id.get(inj.player_id)
        if player:
            entry["player_name"] = player.name
            entry["nba_team"] = player.team
        history.append(entry)

    return {"history": history, "count": len(history)}
