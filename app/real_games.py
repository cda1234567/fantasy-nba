"""Real NBA per-player per-game stat lookup.

Backed by `data/nba_db/player_games.sqlite` (Kaggle eoinamoore historical box
scores; ~1.66M player-game rows from 1946-2025). Used by the season simulator
to override gauss-sampled stats with real history when available.
"""
from __future__ import annotations

import sqlite3
import threading
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "nba_db" / "player_games.sqlite"
_lock = threading.Lock()
_conn: sqlite3.Connection | None = None
_season_start_cache: dict[int, date] = {}


def _connect() -> sqlite3.Connection | None:
    """Lazy-open the SQLite connection. Returns None if the DB file is absent
    so the simulator can fall back to gauss sampling cleanly."""
    global _conn
    if _conn is not None:
        return _conn
    if not _DB_PATH.exists():
        return None
    with _lock:
        if _conn is None:
            _conn = sqlite3.connect(str(_DB_PATH), check_same_thread=False)
    return _conn


def _season_year_int(season_str: str | None) -> int | None:
    """'2018-19' -> 2018. None / malformed -> None."""
    if not season_str:
        return None
    try:
        return int(season_str.split("-")[0])
    except (ValueError, IndexError):
        return None


def _season_start(season_year: int) -> date | None:
    """First real-world game date of the given NBA season. Cached."""
    if season_year in _season_start_cache:
        return _season_start_cache[season_year]
    conn = _connect()
    if conn is None:
        return None
    row = conn.execute(
        "SELECT MIN(game_date) FROM player_games WHERE season_year = ?",
        (season_year,),
    ).fetchone()
    if not row or not row[0]:
        return None
    d = date.fromisoformat(row[0])
    _season_start_cache[season_year] = d
    return d


def real_game_for(person_id: int, season_str: str | None, fantasy_day: int) -> dict | None:
    """Return real box-score for `person_id` on the calendar day mapped from
    `fantasy_day` (1-indexed). Returns None if no game / DB missing / not played.

    Mapping: fantasy day 1 = season's first game date; day N = + (N-1) days.
    Choose the highest-minute game that day if the player played twice (rare).
    """
    if fantasy_day < 1:
        return None
    season_year = _season_year_int(season_str)
    if season_year is None:
        return None
    conn = _connect()
    if conn is None:
        return None
    start = _season_start(season_year)
    if start is None:
        return None
    target = (start + timedelta(days=fantasy_day - 1)).isoformat()
    row = conn.execute(
        """SELECT pts, reb, ast, stl, blk, tov, minutes
           FROM player_games
           WHERE person_id = ? AND game_date = ? AND season_year = ?
           ORDER BY minutes DESC LIMIT 1""",
        (person_id, target, season_year),
    ).fetchone()
    if not row:
        return None
    return {
        "pts": int(row[0] or 0),
        "reb": int(row[1] or 0),
        "ast": int(row[2] or 0),
        "stl": int(row[3] or 0),
        "blk": int(row[4] or 0),
        "tov": int(row[5] or 0),
        "minutes": float(row[6] or 0),
    }
