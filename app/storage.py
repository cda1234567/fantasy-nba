"""File-backed JSON persistence for league state.

Layout:
    {data_dir}/leagues/{league_id}/
        draft.json      # draft picks, order, board
        season.json     # schedule, current week/day, game logs, standings
        settings.json   # league_id, team names, created_at
        log.json        # recent event log (ring buffer, last 500)

Atomic writes: write to .tmp then os.replace.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional


LOG_RING_MAX = 500


class Storage:
    def __init__(self, data_dir: Path, league_id: str = "default"):
        self.data_dir = Path(data_dir)
        self.league_id = league_id
        self.league_dir = self.data_dir / "leagues" / league_id
        self.league_dir.mkdir(parents=True, exist_ok=True)
        # Serialize log appends (read-modify-write needs a lock to avoid lost events).
        self._log_lock = threading.Lock()

    # ------------------------------------------------------------------ paths
    @property
    def draft_path(self) -> Path:
        return self.league_dir / "draft.json"

    @property
    def season_path(self) -> Path:
        return self.league_dir / "season.json"

    @property
    def settings_path(self) -> Path:
        return self.league_dir / "settings.json"

    @property
    def log_path(self) -> Path:
        return self.league_dir / "log.json"

    @property
    def trades_path(self) -> Path:
        return self.league_dir / "trades.json"

    # --------------------------------------------------------------- atomic IO
    def _atomic_write(self, path: Path, data: Any) -> None:
        # Use a unique tmp filename per write so concurrent writers to the same
        # target path don't race on a shared .tmp file (one writer's replace()
        # would otherwise see the file already consumed by another writer).
        tmp = path.with_suffix(path.suffix + f".{os.getpid()}.{uuid.uuid4().hex}.tmp")
        try:
            tmp.write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            os.replace(tmp, path)
        except Exception:
            # Best-effort cleanup of the orphan tmp file on failure.
            try:
                if tmp.exists():
                    tmp.unlink()
            except OSError:
                pass
            raise

    def _safe_read(self, path: Path) -> Optional[Any]:
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            # Preserve the corrupt file under a timestamped name so an
            # atomic save by a caller doesn't silently wipe real data.
            try:
                backup = path.with_suffix(
                    path.suffix + f".corrupt.{int(time.time())}"
                )
                path.rename(backup)
            except OSError:
                pass
            return None
        except OSError:
            return None

    # ----------------------------------------------------------------- draft
    def load_draft(self) -> Optional[dict]:
        data = self._safe_read(self.draft_path)
        return data if isinstance(data, dict) else None

    def save_draft(self, state: dict) -> None:
        self._atomic_write(self.draft_path, state)

    # ---------------------------------------------------------------- season
    def load_season(self) -> Optional[dict]:
        data = self._safe_read(self.season_path)
        return data if isinstance(data, dict) else None

    def save_season(self, state: dict) -> None:
        self._atomic_write(self.season_path, state)

    def clear_season(self) -> None:
        if self.season_path.exists():
            self.season_path.unlink()

    # ---------------------------------------------------------------- trades
    def load_trades(self) -> Optional[dict]:
        data = self._safe_read(self.trades_path)
        return data if isinstance(data, dict) else None

    def save_trades(self, state: dict) -> None:
        self._atomic_write(self.trades_path, state)

    def clear_trades(self) -> None:
        if self.trades_path.exists():
            self.trades_path.unlink()

    # -------------------------------------------------------------- settings
    def load_settings(self) -> dict:
        data = self._safe_read(self.settings_path)
        if isinstance(data, dict):
            return data
        # Initialize settings file lazily
        initial = {
            "league_id": self.league_id,
            "created_at": time.time(),
            "team_names": {},
        }
        self.save_settings(initial)
        return initial

    def save_settings(self, state: dict) -> None:
        self._atomic_write(self.settings_path, state)

    # --------------------------------------------------------- league settings
    @property
    def league_settings_path(self) -> Path:
        return self.league_dir / "league_settings.json"

    def load_league_settings(self) -> "LeagueSettings":
        from .models import LeagueSettings
        data = self._safe_read(self.league_settings_path)
        if isinstance(data, dict):
            try:
                return LeagueSettings(**data)
            except Exception:
                pass
        return LeagueSettings()

    def save_league_settings(self, settings: "LeagueSettings") -> None:
        self._atomic_write(self.league_settings_path, settings.model_dump())

    # ------------------------------------------------------------------- log
    def append_log(self, event: dict) -> None:
        if "ts" not in event:
            event = {"ts": time.time(), **event}
        with self._log_lock:
            entries = self._safe_read(self.log_path)
            if not isinstance(entries, list):
                entries = []
            entries.append(event)
            if len(entries) > LOG_RING_MAX:
                entries = entries[-LOG_RING_MAX:]
            self._atomic_write(self.log_path, entries)

    def load_log(self, limit: int = 50) -> list[dict]:
        entries = self._safe_read(self.log_path)
        if not isinstance(entries, list):
            return []
        return entries[-limit:]


def resolve_data_dir(env_value: Optional[str], default: Path) -> Path:
    """Resolve DATA_DIR env override; returns an absolute Path."""
    if env_value:
        return Path(env_value).expanduser().resolve()
    return default.resolve()


# ---------------------------------------------------------------------------
# Multi-league helpers (operate on the data_dir, not on a specific Storage)
# ---------------------------------------------------------------------------
def _leagues_root(data_dir: Path) -> Path:
    return Path(data_dir) / "leagues"


def _active_pointer_path(data_dir: Path) -> Path:
    return Path(data_dir) / "active_league.json"


def list_leagues(data_dir: Path) -> list[dict]:
    """Return a list of {league_id, name, created_at, setup_complete} for every league dir."""
    root = _leagues_root(data_dir)
    if not root.exists():
        return []
    out: list[dict] = []
    for sub in sorted(root.iterdir()):
        if not sub.is_dir():
            continue
        lid = sub.name
        # Read league_settings for display name
        name = lid
        setup_complete = False
        created_at = 0.0
        ls_path = sub / "league_settings.json"
        if ls_path.exists():
            try:
                data = json.loads(ls_path.read_text(encoding="utf-8"))
                name = data.get("league_name") or lid
                setup_complete = bool(data.get("setup_complete"))
            except Exception:
                pass
        settings_path = sub / "settings.json"
        if settings_path.exists():
            try:
                data = json.loads(settings_path.read_text(encoding="utf-8"))
                created_at = float(data.get("created_at") or 0.0)
            except Exception:
                pass
        out.append({
            "league_id": lid,
            "name": name,
            "created_at": created_at,
            "setup_complete": setup_complete,
        })
    out.sort(key=lambda d: d.get("created_at") or 0.0)
    return out


def _validate_league_id(league_id: str) -> str:
    """Validate and normalize a league_id. Raises ValueError on bad input.

    Enforces allowed character set and an escape-proof path:
    - non-empty, ≤ 64 chars
    - only letters/digits/'-'/'_'
    - resolved path must be inside leagues root (defense in depth)
    """
    lid = (league_id or "").strip()
    if not lid:
        raise ValueError("league_id required")
    if len(lid) > 64:
        raise ValueError("league_id too long (max 64 chars)")
    if not all(c.isalnum() or c in ("-", "_") for c in lid):
        raise ValueError("league_id may only contain letters, digits, '-', '_'")
    return lid


def create_league(data_dir: Path, league_id: str) -> None:
    """Create a league directory if it does not already exist.

    Pre-seeds ``league_settings.json`` with ``league_name=league_id`` so a freshly
    created league never inherits the previously-active league's name (fixes
    qa-g2 name pollution race where concurrent creators saw the wrong label).
    """
    lid = _validate_league_id(league_id)
    target = _leagues_root(data_dir) / lid
    if target.exists():
        raise ValueError(f"league '{lid}' already exists")
    target.mkdir(parents=True, exist_ok=False)
    from .models import LeagueSettings
    seeded = LeagueSettings(league_name=lid)
    tmp_path = target / "league_settings.json"
    tmp = tmp_path.with_suffix(tmp_path.suffix + f".{os.getpid()}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(
        json.dumps(seeded.model_dump(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(tmp, tmp_path)


def delete_league(data_dir: Path, league_id: str) -> None:
    """Delete a league directory and everything in it."""
    import shutil
    lid = _validate_league_id(league_id)
    root = _leagues_root(data_dir).resolve()
    target = (root / lid).resolve()
    # Defense in depth: refuse any target outside the leagues root
    if target == root or root not in target.parents:
        raise ValueError(f"invalid league path")
    if not target.exists():
        raise ValueError(f"league '{lid}' does not exist")
    shutil.rmtree(target)


def get_active_league(data_dir: Path, fallback: str = "default") -> str:
    """Return the active league id from the pointer file, or fallback."""
    path = _active_pointer_path(data_dir)
    if not path.exists():
        return fallback
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        lid = data.get("league_id")
        if isinstance(lid, str) and lid:
            return lid
    except Exception:
        pass
    return fallback


def set_active_league(data_dir: Path, league_id: str) -> None:
    """Write the active-league pointer."""
    path = _active_pointer_path(data_dir)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(
        json.dumps({"league_id": league_id}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(tmp, path)
