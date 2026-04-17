"""One-shot fetch of 1995-96..2025-26 per-game stats from stats.nba.com.

Writes app/data/seasons/{YYYY-YY}.json with EVERY player who appeared in
that season (gp >= 1), sorted by fantasy FPPG
(PTS*1 + REB*1.2 + AST*1.5 + STL*2.5 + BLK*2.5 - TOV).

Players who were traded mid-season and have a "TOT" row plus individual
team rows are deduplicated — we keep whichever row has the highest GP
(usually the TOT row, which aggregates their full season production).

Second pass joins each player's prev-season FPPG into the current season file
so the draft UI can display last-year numbers without spoiling the current
season's results.

Usage:
    pip install nba_api
    python tools/fetch_seasons.py           # fetch missing seasons only
    python tools/fetch_seasons.py --force   # overwrite
    python tools/fetch_seasons.py --join    # only re-run the prev_fppg join
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "app" / "data" / "seasons"
START_YEAR = 1995  # season starting year (1995 = 1995-96)
END_YEAR = 2025    # inclusive (2025 = 2025-26)
MIN_GP = 1         # include every player who played at least 1 game
REQUEST_DELAY_SEC = 1.5


def fppg(pts: float, reb: float, ast: float, stl: float, blk: float, tov: float) -> float:
    return pts * 1.0 + reb * 1.2 + ast * 1.5 + stl * 2.5 + blk * 2.5 - tov * 1.0


def season_label(start_year: int) -> str:
    return f"{start_year}-{str(start_year + 1)[-2:]}"


def fetch_season(start_year: int) -> list[dict[str, Any]]:
    from nba_api.stats.endpoints import LeagueDashPlayerStats  # type: ignore

    season = season_label(start_year)
    ep = LeagueDashPlayerStats(
        season=season,
        per_mode_detailed="PerGame",
        season_type_all_star="Regular Season",
    )
    result = ep.get_dict()["resultSets"][0]
    headers = result["headers"]
    rows = result["rowSet"]
    H = {h: i for i, h in enumerate(headers)}

    # dedupe by player_id, keeping whichever row has max GP
    # (traded players have a TOT row + one row per team; TOT row wins)
    best: dict[int, dict[str, Any]] = {}
    for r in rows:
        gp = int(r[H["GP"]] or 0)
        if gp < MIN_GP:
            continue
        pid = int(r[H["PLAYER_ID"]])
        pts = float(r[H["PTS"]] or 0)
        reb = float(r[H["REB"]] or 0)
        ast = float(r[H["AST"]] or 0)
        stl = float(r[H["STL"]] or 0)
        blk = float(r[H["BLK"]] or 0)
        tov = float(r[H["TOV"]] or 0)
        rec = {
            "id": pid,
            "name": r[H["PLAYER_NAME"]],
            "team": r[H["TEAM_ABBREVIATION"]] or "",
            "pos": "",
            "age": int(r[H["AGE"]] or 0),
            "gp": gp,
            "mpg": round(float(r[H["MIN"]] or 0), 1),
            "pts": round(pts, 1),
            "reb": round(reb, 1),
            "ast": round(ast, 1),
            "stl": round(stl, 1),
            "blk": round(blk, 1),
            "to": round(tov, 1),
            "_fppg": fppg(pts, reb, ast, stl, blk, tov),
        }
        cur = best.get(pid)
        if cur is None or rec["gp"] > cur["gp"]:
            best[pid] = rec

    players = sorted(best.values(), key=lambda p: p["_fppg"], reverse=True)
    for p in players:
        p.pop("_fppg", None)
    return players


def cmd_fetch(args: argparse.Namespace) -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for start in range(START_YEAR, END_YEAR + 1):
        label = season_label(start)
        out = OUT_DIR / f"{label}.json"
        if out.exists() and not args.force:
            print(f"[skip] {label}")
            continue
        print(f"[fetch] {label} ...", flush=True)
        try:
            players = fetch_season(start)
        except Exception as e:
            print(f"  ERROR {label}: {e}")
            time.sleep(REQUEST_DELAY_SEC * 3)
            continue
        out.write_text(
            json.dumps(players, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        print(f"  saved {len(players)} players")
        time.sleep(REQUEST_DELAY_SEC)
    return 0


def cmd_join(_args: argparse.Namespace) -> int:
    """Fill prev_fppg on each season file from the preceding season's data."""
    files = sorted(OUT_DIR.glob("*.json"))
    if not files:
        print("no season files found")
        return 1

    prev: dict[int, float] = {}
    for path in files:
        data = json.loads(path.read_text(encoding="utf-8"))
        for p in data:
            pts, reb, ast, stl, blk, tov = p["pts"], p["reb"], p["ast"], p["stl"], p["blk"], p["to"]
            cur_fppg = round(fppg(pts, reb, ast, stl, blk, tov), 2)
            p["fppg"] = cur_fppg
            p["prev_fppg"] = prev.get(p["id"], None)
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        prev = {
            p["id"]: round(fppg(p["pts"], p["reb"], p["ast"], p["stl"], p["blk"], p["to"]), 2)
            for p in data
        }
        print(f"[join] {path.name} ({len(data)} players)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="overwrite existing season files")
    ap.add_argument("--join", action="store_true", help="only run the prev_fppg join pass")
    args = ap.parse_args()
    if args.join:
        return cmd_join(args)
    rc = cmd_fetch(args)
    if rc == 0:
        cmd_join(args)
    return rc


if __name__ == "__main__":
    sys.exit(main())
