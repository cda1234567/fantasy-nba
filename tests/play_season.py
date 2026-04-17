"""
Playwright-based season runner for Fantasy NBA.

Plays N full seasons (draft -> regular season -> playoffs) acting as the human
team.  Uses a hybrid approach:
  - Playwright for browser navigation and weekly screenshots
  - httpx for all API calls (faster, more reliable than UI automation)

Usage:
    uv run python tests/play_season.py --seasons 3 --base-url http://127.0.0.1:3410
    uv run python tests/play_season.py --seasons 3 --headless
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import shutil
import time
from pathlib import Path
from typing import Any

import httpx
from playwright.async_api import Page, async_playwright

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
DEFAULT_BASE = "http://127.0.0.1:3410"
SCREENSHOTS_DIR = Path(__file__).parent / "screenshots"
REPORT_PATH = Path(__file__).parent / "run_report.json"

PACE_MIN_MS = 150
PACE_MAX_MS = 400


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def pace(min_ms: int = PACE_MIN_MS, max_ms: int = PACE_MAX_MS) -> None:
    await asyncio.sleep(random.uniform(min_ms, max_ms) / 1000)


async def api(client: httpx.AsyncClient, method: str, path: str, **kwargs: Any) -> Any:
    """Call the API and return parsed JSON.  Raises on HTTP errors."""
    resp = await client.request(method, path, **kwargs)
    resp.raise_for_status()
    return resp.json()


async def api_safe(
    client: httpx.AsyncClient, method: str, path: str, **kwargs: Any
) -> Any | None:
    """Like api() but returns None instead of raising on HTTP error."""
    try:
        return await api(client, method, path, **kwargs)
    except httpx.HTTPStatusError as exc:
        body = ""
        try:
            body = exc.response.text[:300]
        except Exception:
            pass
        print(f"  [warn] {method} {path} -> HTTP {exc.response.status_code}: {body}")
        return None
    except Exception as exc:
        print(f"  [warn] {method} {path} -> {exc}")
        return None


# ---------------------------------------------------------------------------
# Player FPPG cache (for trade value computation)
# ---------------------------------------------------------------------------

_PLAYER_FPPG: dict[int, float] = {}
_PLAYER_NAME: dict[int, str] = {}


async def load_player_index(client: httpx.AsyncClient) -> None:
    """Populate id -> fppg / name map from /api/players (full pool)."""
    global _PLAYER_FPPG, _PLAYER_NAME
    # `available=false` returns the full pool including drafted players
    data = await api(client, "GET", "/api/players?available=false&limit=600&sort=fppg")
    _PLAYER_FPPG = {int(p["id"]): float(p.get("fppg", 0.0)) for p in data}
    _PLAYER_NAME = {int(p["id"]): str(p.get("name", "?")) for p in data}


def _side_value(player_ids: list[int]) -> float:
    return sum(_PLAYER_FPPG.get(int(pid), 0.0) for pid in player_ids)


# ---------------------------------------------------------------------------
# Draft (API-driven for speed and reliability)
# ---------------------------------------------------------------------------

async def run_draft(client: httpx.AsyncClient) -> None:
    """Reset the draft and complete it: human always picks best available."""
    print("  [draft] resetting ...")
    # NOTE: endpoint expects a JSON body (even if empty).
    await api(client, "POST", "/api/draft/reset", json={})

    for attempt in range(400):
        state = await api(client, "GET", "/api/state")
        if state["is_complete"]:
            print(f"  [draft] complete after {attempt} iters")
            return

        current_team = state["current_team_id"]
        human_team = state["human_team_id"]

        if current_team == human_team:
            players = await api(
                client, "GET", "/api/players?available=true&sort=fppg&limit=1"
            )
            if not players:
                print("  [draft] no available players - stopping")
                return
            player_id = players[0]["id"]
            await api(client, "POST", "/api/draft/pick", json={"player_id": player_id})
            await asyncio.sleep(0.02)
        else:
            await api(client, "POST", "/api/draft/ai-advance")

    print("  [draft] WARNING: hit iteration limit without completing draft")


# ---------------------------------------------------------------------------
# Trade heuristics (computed from FPPG since API doesn't expose send/receive values)
# ---------------------------------------------------------------------------

def heuristic_accept(trade: dict[str, Any]) -> bool:
    """Accept if receive >= 0.85 * send (human is slightly more lenient)."""
    sv = _side_value(trade.get("send_player_ids", []))
    rv = _side_value(trade.get("receive_player_ids", []))
    if sv <= 0.01:
        return True
    return rv >= 0.85 * sv


def should_veto(trade: dict[str, Any]) -> bool:
    """Veto AI-to-AI trades with FPPG ratio >= 1.08 (human plays hawkish commissioner).

    Tuned to the backend: AI proposer accepts within ~0.92 of value (ratio ~1.09)
    so a 1.08 threshold catches the more lopsided accepted trades a couple times
    per season without vetoing every pairing.
    """
    sv = _side_value(trade.get("send_player_ids", []))
    rv = _side_value(trade.get("receive_player_ids", []))
    lo, hi = min(sv, rv), max(sv, rv)
    if lo <= 0.01:
        return True
    return (hi / lo) >= 1.07


def _trade_repr(trade: dict[str, Any]) -> str:
    send_names = ", ".join(
        _PLAYER_NAME.get(int(pid), f"#{pid}") for pid in trade.get("send_player_ids", [])
    )
    recv_names = ", ".join(
        _PLAYER_NAME.get(int(pid), f"#{pid}") for pid in trade.get("receive_player_ids", [])
    )
    sv = _side_value(trade.get("send_player_ids", []))
    rv = _side_value(trade.get("receive_player_ids", []))
    return f"[{send_names} ({sv:.1f}) <-> {recv_names} ({rv:.1f})]"


# ---------------------------------------------------------------------------
# Trade processing
# ---------------------------------------------------------------------------

async def process_pending_trades(
    client: httpx.AsyncClient,
    report: dict[str, Any],
    season_num: int,
    day: int,
    seen_vetoes: set[str],
    seen_decisions: set[str],
) -> None:
    """Check for pending trades and action them as the human commissioner.

    Caller passes per-season sets to dedupe log lines (the backend is
    idempotent but the /pending endpoint may surface a trade several times
    before the next daily tick clears it).
    """
    result = await api_safe(client, "GET", "/api/trades/pending")
    if result is None:
        return

    pending = result.get("pending", [])
    for trade in pending:
        trade_id = trade.get("id")
        if trade_id is None:
            continue

        status = trade.get("status", "")
        from_team = trade.get("from_team", -1)
        to_team = trade.get("to_team", -1)

        if status == "pending_accept" and to_team == 0:
            if trade_id in seen_decisions:
                continue
            decision = heuristic_accept(trade)
            action = "accept" if decision else "reject"
            result2 = await api_safe(
                client, "POST", f"/api/trades/{trade_id}/{action}"
            )
            if result2 is not None:
                seen_decisions.add(trade_id)
                label = "accepted" if decision else "rejected"
                print(
                    f"  [trade] s{season_num} d{day}: {label} offer from team "
                    f"{from_team} {_trade_repr(trade)}"
                )
            await pace(80, 180)

        elif status == "accepted" and from_team != 0 and to_team != 0:
            if trade_id in seen_vetoes:
                continue
            veto_votes = trade.get("veto_votes", []) or []
            if 0 not in veto_votes and should_veto(trade):
                result2 = await api_safe(
                    client,
                    "POST",
                    f"/api/trades/{trade_id}/veto",
                    json={"team_id": 0},
                )
                if result2 is not None:
                    seen_vetoes.add(trade_id)
                    print(
                        f"  [trade] s{season_num} d{day}: human vetoed lopsided "
                        f"trade {from_team}<->{to_team} {_trade_repr(trade)}"
                    )
            await pace(60, 140)


# ---------------------------------------------------------------------------
# Season tallying from trade history
# ---------------------------------------------------------------------------

async def tally_trades(
    client: httpx.AsyncClient,
    report: dict[str, Any],
    history_offset: int,
) -> int:
    """Pull trade history delta since last offset and fill report counters.

    Returns the new total history length so the next season can slice correctly.
    """
    result = await api_safe(client, "GET", "/api/trades/history?limit=500")
    if result is None:
        report["issues"].append("trade history endpoint unavailable")
        return history_offset

    full_history = result.get("history", [])
    # Newest records are at the end of history; per-season delta = trailing slice
    season_slice = full_history[history_offset:]

    trade_details: list[dict[str, Any]] = []
    for t in season_slice:
        status = t.get("status", "")
        from_team = t.get("from_team", -1)
        to_team = t.get("to_team", -1)

        detail = {
            "id": t.get("id"),
            "status": status,
            "from_team": from_team,
            "to_team": to_team,
            "send": [
                _PLAYER_NAME.get(int(pid), f"#{pid}")
                for pid in t.get("send_player_ids", [])
            ],
            "receive": [
                _PLAYER_NAME.get(int(pid), f"#{pid}")
                for pid in t.get("receive_player_ids", [])
            ],
            "veto_votes": list(t.get("veto_votes", []) or []),
            "proposed_week": t.get("proposed_week"),
            "proposed_day": t.get("proposed_day"),
            "executed_day": t.get("executed_day"),
            "reasoning": t.get("reasoning", ""),
        }
        trade_details.append(detail)

        if status == "executed":
            report["trades_executed"] += 1
            if from_team == 0 or to_team == 0:
                report["human_trades"] += 1
            else:
                report["ai_to_ai_trades"] += 1
        elif status == "vetoed":
            report["trades_vetoed"] += 1
        elif status == "rejected":
            report["trades_rejected"] += 1
        elif status == "expired":
            report["trades_expired"] += 1

    report["trades"] = trade_details
    return len(full_history)


# ---------------------------------------------------------------------------
# Weekly standings capture
# ---------------------------------------------------------------------------

async def capture_weekly_standings(
    client: httpx.AsyncClient,
    report: dict[str, Any],
    week: int,
) -> None:
    data = await api_safe(client, "GET", "/api/season/standings")
    if data is None:
        return
    snapshot = []
    for row in data.get("standings", []):
        snapshot.append({
            "team_id": row.get("team_id"),
            "name": row.get("name"),
            "w": row.get("w"),
            "l": row.get("l"),
            "pf": row.get("pf"),
        })
    report["weekly_standings"].append({"week": week, "standings": snapshot})


# ---------------------------------------------------------------------------
# Core season loop
# ---------------------------------------------------------------------------

async def play_season(
    page: Page,
    client: httpx.AsyncClient,
    season_num: int,
    history_offset: int,
) -> tuple[dict[str, Any], int]:
    """Play one full season. Returns (report, new_history_offset)."""
    print(f"\n{'=' * 60}")
    print(f"  SEASON {season_num}")
    print(f"{'=' * 60}")
    t0 = time.monotonic()

    report: dict[str, Any] = {
        "season": season_num,
        "trades_executed": 0,
        "trades_vetoed": 0,
        "trades_rejected": 0,
        "trades_expired": 0,
        "ai_to_ai_trades": 0,
        "human_trades": 0,
        "champion": None,
        "champion_name": None,
        "weekly_standings": [],
        "final_standings": [],
        "trades": [],
        "issues": [],
        "wall_clock_seconds": 0.0,
    }

    # --- Draft phase ---
    await run_draft(client)

    # Refresh player index once draft is populated (cheap).
    if not _PLAYER_FPPG:
        await load_player_index(client)

    await page.goto(f"{client.base_url}/#league")
    await pace(400, 700)

    # --- Start season ---
    print(f"  [season] starting season {season_num} ...")
    result = await api_safe(
        client, "POST", "/api/season/start", json={}
    )
    if result is None:
        report["issues"].append("season/start failed")
        return report, history_offset

    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    await page.screenshot(
        path=str(SCREENSHOTS_DIR / f"s{season_num}_start.png"),
        full_page=False,
    )

    # --- Regular season day loop ---
    print("  [season] running regular season ...")
    prev_week = 0
    loop_guard = 0
    seen_vetoes: set[str] = set()
    seen_decisions: set[str] = set()
    while True:
        loop_guard += 1
        if loop_guard > 400:
            report["issues"].append("regular-season loop guard exceeded")
            break

        standings_data = await api_safe(client, "GET", "/api/season/standings")
        if standings_data is None:
            # Rare transient 400/500: one retry after a short pause.
            await asyncio.sleep(0.15)
            standings_data = await api_safe(client, "GET", "/api/season/standings")
        if standings_data is None:
            report["issues"].append("standings endpoint failed during regular season")
            break

        current_week = standings_data.get("current_week", 0)
        current_day = standings_data.get("current_day", 0)
        is_playoffs = standings_data.get("is_playoffs", False)
        champion = standings_data.get("champion")
        regular_weeks = standings_data.get("regular_weeks", 14)

        if champion is not None:
            report["champion"] = champion
            break
        if is_playoffs:
            break
        # `current_week` increments AFTER a day's sim; when the full regular
        # season (weeks 1..regular_weeks) is done we stop and hand off to sim_playoffs.
        if current_week > regular_weeks:
            break
        # Special case: we've completed week regular_weeks and it's a week-boundary day.
        if current_week == regular_weeks and current_day >= regular_weeks * 7:
            break

        # Human trade actions
        await process_pending_trades(
            client, report, season_num, current_day, seen_vetoes, seen_decisions
        )

        # Advance 1 day via API (UI button path kept as fallback for smoke-tests)
        advanced_via_ui = False
        try:
            btn = page.locator(
                "button:has-text('Advance 1 Day'), "
                "button:has-text('Advance Day'), "
                "button:has-text('Next Day')"
            ).first
            count = await btn.count()
            if count > 0 and await btn.is_visible():
                await btn.click()
                advanced_via_ui = True
                await pace(80, 200)
        except Exception:
            pass

        if not advanced_via_ui:
            adv = await api_safe(
                client, "POST", "/api/season/advance-day", json={"use_ai": False}
            )
            if adv is None:
                report["issues"].append(f"advance-day failed at day {current_day}")
                break
            await pace(30, 80)

        # Weekly screenshot + log
        if current_week != prev_week and current_week > 0:
            prev_week = current_week
            await capture_weekly_standings(client, report, current_week)
            print(
                f"  [season] s{season_num} week {current_week}/{regular_weeks} "
                f"(day {current_day})"
            )
            try:
                await page.screenshot(
                    path=str(SCREENSHOTS_DIR / f"s{season_num}_w{current_week:02d}.png"),
                    full_page=False,
                )
            except Exception:
                pass

    # --- Playoffs ---
    print(f"  [season] simulating playoffs for season {season_num} ...")
    playoff_result = await api_safe(
        client, "POST", "/api/season/sim-playoffs", json={"use_ai": False}
    )
    if playoff_result is not None:
        champ_id = playoff_result.get("champion")
        if champ_id is not None:
            report["champion"] = champ_id

    # Champion name from standings (authoritative post-playoffs)
    final_standings = await api_safe(client, "GET", "/api/season/standings")
    if final_standings:
        if report["champion"] is None:
            report["champion"] = final_standings.get("champion")
        rows = final_standings.get("standings", [])
        report["final_standings"] = [
            {
                "team_id": r.get("team_id"),
                "name": r.get("name"),
                "w": r.get("w"),
                "l": r.get("l"),
                "pf": r.get("pf"),
                "pa": r.get("pa"),
            }
            for r in rows
        ]
        if report["champion"] is not None:
            for r in rows:
                if r.get("team_id") == report["champion"]:
                    report["champion_name"] = r.get("name")
                    break

    # Screenshot: season end
    try:
        await page.goto(f"{client.base_url}/#league")
        await pace(300, 600)
        await page.screenshot(
            path=str(SCREENSHOTS_DIR / f"s{season_num}_end.png"),
            full_page=False,
        )
    except Exception:
        pass

    # --- Trade tallying ---
    new_offset = await tally_trades(client, report, history_offset)

    report["wall_clock_seconds"] = round(time.monotonic() - t0, 2)
    print(
        f"  [done] Season {season_num}: "
        f"champion={report['champion_name']} (id={report['champion']}), "
        f"exec={report['trades_executed']}, "
        f"human={report['human_trades']}, "
        f"ai_to_ai={report['ai_to_ai_trades']}, "
        f"vetoed={report['trades_vetoed']}, "
        f"rejected={report['trades_rejected']}, "
        f"expired={report['trades_expired']}, "
        f"time={report['wall_clock_seconds']}s"
    )
    return report, new_offset


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def main(seasons: int, base_url: str, headless: bool) -> None:
    reports: list[dict[str, Any]] = []

    # Wipe screenshots between runs
    if SCREENSHOTS_DIR.exists():
        shutil.rmtree(SCREENSHOTS_DIR, ignore_errors=True)
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=headless, slow_mo=25)
        context = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await context.new_page()

        async with httpx.AsyncClient(base_url=base_url, timeout=60.0) as client:
            try:
                health = await api(client, "GET", "/api/health")
                print(f"[health] {health}")
            except Exception as exc:
                print(f"[warn] Health check failed: {exc} - proceeding anyway")

            try:
                await page.goto(base_url)
                await pace(400, 700)
            except Exception as exc:
                print(f"[warn] Initial navigation failed: {exc}")

            history_offset = 0
            # Reset trade history tracking between runs by priming offset now
            # (the /draft/reset call in season 1 clears trade state).
            for s in range(1, seasons + 1):
                try:
                    r, history_offset = await play_season(page, client, s, history_offset)
                    reports.append(r)
                except Exception as exc:
                    import traceback
                    tb = traceback.format_exc()
                    print(f"[FATAL] season {s} crashed: {exc}\n{tb}")
                    reports.append({
                        "season": s,
                        "fatal": str(exc),
                        "traceback": tb,
                        "issues": ["fatal exception"],
                    })
                    break

                # Between seasons, the draft gets reset at the top of play_season
                # which also clears season + trades in the backend (verified in main.py).
                # history_offset resets to 0 naturally since history is cleared.
                history_offset = 0

        await browser.close()

    REPORT_PATH.write_text(json.dumps({"runs": reports}, indent=2))
    print(f"\n[report] Written to {REPORT_PATH}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(
        description="Play N full Fantasy NBA seasons and report metrics."
    )
    ap.add_argument("--seasons", type=int, default=3)
    ap.add_argument("--base-url", default=DEFAULT_BASE)
    ap.add_argument("--headless", action="store_true", help="Run without showing browser")
    args = ap.parse_args()
    asyncio.run(main(args.seasons, args.base_url, args.headless))
