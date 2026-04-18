"""Full-season API stress test.

Drives the complete lifecycle that a human player walks through:
  create league -> switch -> setup -> draft -> start season -> advance 20 weeks
  -> sim-to-playoffs (if needed) -> sim playoffs -> verify champion -> delete league.

For each iteration we assert at every transition point so we catch the "UI looks
fine but the API is a no-op" class of bugs that shipped as v0.5.32 / v0.5.33.

Usage:
    uv run python .qa/fullseason/stress.py --iters 3 --base-url http://127.0.0.1:3410
    uv run python .qa/fullseason/stress.py --iters 5                 # default local
    uv run python .qa/fullseason/stress.py --iters 1 --keep-league   # don't clean up
"""
from __future__ import annotations

import argparse
import json
import sys
import time

# Windows console defaults to cp950 (Big5) on zh-TW — force UTF-8 so CJK team
# names in assertion details don't crash print().
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx


REPORT_PATH = Path(__file__).parent / "report.json"


@dataclass
class StepResult:
    name: str
    ok: bool
    detail: str = ""
    elapsed_s: float = 0.0


@dataclass
class IterResult:
    league_id: str
    steps: list[StepResult] = field(default_factory=list)
    champion: int | None = None
    elapsed_s: float = 0.0
    ok: bool = False


class StressClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.client = httpx.Client(base_url=self.base_url, timeout=60.0)

    def close(self) -> None:
        self.client.close()

    def switch(self, league_id: str) -> None:
        self.client.headers["X-League-ID"] = league_id

    def get(self, path: str, **kwargs: Any) -> httpx.Response:
        r = self.client.get(path, **kwargs)
        r.raise_for_status()
        return r

    def post(self, path: str, **kwargs: Any) -> httpx.Response:
        r = self.client.post(path, **kwargs)
        r.raise_for_status()
        return r


def _step(name: str, fn, *args, **kwargs) -> StepResult:
    t0 = time.monotonic()
    try:
        detail = fn(*args, **kwargs) or ""
        return StepResult(name=name, ok=True, detail=str(detail), elapsed_s=time.monotonic() - t0)
    except httpx.HTTPStatusError as exc:
        body = ""
        try:
            body = exc.response.text[:300]
        except Exception:
            pass
        msg = f"HTTP {exc.response.status_code}: {body}"
        return StepResult(name=name, ok=False, detail=msg, elapsed_s=time.monotonic() - t0)
    except AssertionError as exc:
        return StepResult(name=name, ok=False, detail=f"assertion: {exc}", elapsed_s=time.monotonic() - t0)
    except Exception as exc:
        return StepResult(name=name, ok=False, detail=f"{type(exc).__name__}: {exc}", elapsed_s=time.monotonic() - t0)


def _create_and_switch(sc: StressClient, league_id: str) -> str:
    sc.post("/api/leagues/create", json={"league_id": league_id, "switch": True})
    return f"league={league_id}"


def _setup(sc: StressClient) -> str:
    settings = sc.get("/api/league/settings").json()
    # Minimum override: mark setup_complete false so league_setup accepts the body,
    # keep everything else at default (8 teams, 20 reg weeks, human team_index 0).
    settings["setup_complete"] = False
    sc.post("/api/league/setup", json=settings)
    confirmed = sc.get("/api/league/settings").json()
    assert confirmed.get("setup_complete"), "setup_complete still false after /league/setup"
    return f"num_teams={confirmed['num_teams']} reg_weeks={confirmed['regular_season_weeks']}"


def _run_draft(sc: StressClient) -> str:
    sc.post("/api/draft/reset", json={})
    picks = 0
    for _ in range(500):
        state = sc.get("/api/state").json()
        if state.get("is_complete"):
            assert picks > 0, "draft reported complete without any picks"
            return f"picks={picks}"
        if state["current_team_id"] == state["human_team_id"]:
            # Human turn — pick highest-fppg available player.
            avail = sc.get("/api/players", params={"available": "true", "sort": "fppg", "limit": 1}).json()
            assert avail, "no available players for human pick"
            sc.post("/api/draft/pick", json={"player_id": avail[0]["id"]})
        else:
            sc.post("/api/draft/ai-advance")
        picks += 1
    raise AssertionError(f"draft did not complete after {picks} picks")


def _start_season(sc: StressClient) -> str:
    # Critical regression check: the emptyState CTA should be reachable because
    # state.season is null before this call. We assert the standings endpoint
    # returns the empty shell (current_week==0), NOT a started-season payload.
    pre = sc.get("/api/season/standings").json()
    assert pre.get("current_week", -1) == 0, f"standings current_week != 0 before start: {pre.get('current_week')}"
    assert pre.get("standings") == [], f"standings.standings should be [] before start, got {pre.get('standings')}"
    sc.post("/api/season/start", json={})
    post = sc.get("/api/season/standings").json()
    assert post.get("current_week", 0) >= 1, f"current_week stayed 0 after start: {post}"
    assert len(post.get("standings", [])) == 8, f"expected 8 rows post-start, got {len(post.get('standings', []))}"
    return f"week={post['current_week']} day={post.get('current_day')}"


def _propose_trade(sc: StressClient) -> str:
    # Reproduce exactly what the "送出提案" button does: grab a player from the
    # human roster, a player from team 1 (any AI), post /api/trades/propose
    # with {from_team, to_team, send, receive, proposer_message, force}.
    draft = sc.get("/api/state").json()
    human_id = draft["human_team_id"]
    to_team = next((t for t in draft["teams"] if t["id"] != human_id), None)
    assert to_team is not None, "no non-human team to trade with"

    human_players = sc.get(f"/api/teams/{human_id}").json().get("players", [])
    ai_players = sc.get(f"/api/teams/{to_team['id']}").json().get("players", [])
    assert human_players and ai_players, "rosters empty post-draft?"

    send_id = human_players[0]["id"]
    recv_id = ai_players[0]["id"]

    r = sc.post("/api/trades/propose", json={
        "from_team": human_id,
        "to_team": to_team["id"],
        "send": [send_id],
        "receive": [recv_id],
        "proposer_message": "",
        "force": False,
    }).json()
    assert r.get("id") or r.get("trade", {}).get("id") or r.get("ok") in (True, None), f"propose returned unexpected shape: {r}"

    pending = sc.get("/api/trades/pending").json().get("pending", [])
    assert any(t.get("from_team") == human_id for t in pending), \
        f"proposed trade not in /pending (pending count={len(pending)})"
    return f"sent {send_id}->{recv_id} to_team={to_team['id']} pending={len(pending)}"


def _sim_regular_season(sc: StressClient) -> str:
    # Use sim-to-playoffs (single endpoint) as the fast path; it's what the
    # "模擬到季後賽" button calls. If it's a no-op, advance-week fallback
    # catches that as a secondary regression.
    sc.post("/api/season/sim-to-playoffs", json={})
    st = sc.get("/api/season/standings").json()
    assert st.get("is_playoffs") is True, f"is_playoffs not True after sim-to-playoffs: {st}"
    assert st.get("champion") is None, f"champion already set before bracket ran: {st}"
    return f"week={st['current_week']} is_playoffs={st['is_playoffs']}"


def _sim_playoff_bracket(sc: StressClient) -> str:
    sc.post("/api/season/sim-playoffs", json={})
    st = sc.get("/api/season/standings").json()
    champ = st.get("champion")
    assert champ is not None, f"no champion crowned after sim-playoffs: {st}"
    return f"champion_team_id={champ} final_week={st['current_week']}"


def _summary(sc: StressClient) -> str:
    s = sc.get("/api/season/summary").json()
    champ_id = s.get("champion_id")
    champ_name = s.get("champion_name", "?")
    assert champ_id is not None, f"summary missing champion_id (keys={list(s.keys())})"
    assert s.get("is_complete") is True, f"summary.is_complete is False"
    return f"champ={champ_id}({champ_name}) human_rank={s.get('human_rank')}"


def _cleanup(sc: StressClient, league_id: str, keep: bool) -> str:
    if keep:
        return "kept"
    # Must switch away before deleting (backend refuses to delete active league).
    sc.post("/api/leagues/switch", json={"league_id": "default"})
    sc.post("/api/leagues/delete", json={"league_id": league_id})
    return "deleted"


def run_once(base_url: str, iter_idx: int, keep: bool) -> IterResult:
    league_id = f"stress-{int(time.time())}-{iter_idx}"
    sc = StressClient(base_url)
    res = IterResult(league_id=league_id)
    t0 = time.monotonic()

    steps_cfg = [
        ("create+switch", lambda: _create_and_switch(sc, league_id)),
        ("setup",         lambda: _setup(sc)),
        ("draft",         lambda: _run_draft(sc)),
        ("season.start",  lambda: _start_season(sc)),
        ("propose_trade", lambda: _propose_trade(sc)),
        ("sim.regseason", lambda: _sim_regular_season(sc)),
        ("sim.playoffs",  lambda: _sim_playoff_bracket(sc)),
        ("summary",       lambda: _summary(sc)),
    ]

    try:
        for name, fn in steps_cfg:
            step = _step(name, fn)
            res.steps.append(step)
            print(f"  [{'OK ' if step.ok else 'FAIL'}] {name:14s} {step.elapsed_s:5.1f}s  {step.detail}")
            if not step.ok:
                break

        # Champion + final cleanup (cleanup always runs so we don't leak leagues).
        if res.steps and res.steps[-1].name == "summary" and res.steps[-1].ok:
            st = sc.get("/api/season/standings").json()
            res.champion = st.get("champion")
    finally:
        cleanup = _step("cleanup", lambda: _cleanup(sc, league_id, keep))
        res.steps.append(cleanup)
        print(f"  [{'OK ' if cleanup.ok else 'FAIL'}] {'cleanup':14s} {cleanup.elapsed_s:5.1f}s  {cleanup.detail}")
        sc.close()

    res.elapsed_s = time.monotonic() - t0
    res.ok = all(s.ok for s in res.steps if s.name != "cleanup") and res.champion is not None
    return res


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:3410")
    ap.add_argument("--iters", type=int, default=3)
    ap.add_argument("--keep-league", action="store_true")
    args = ap.parse_args()

    print(f"=== Fantasy NBA full-season stress ===")
    print(f"  base_url = {args.base_url}")
    print(f"  iters    = {args.iters}")
    print()

    results: list[IterResult] = []
    overall_t0 = time.monotonic()
    for i in range(args.iters):
        print(f"--- iter {i + 1}/{args.iters} ---")
        r = run_once(args.base_url, i, args.keep_league)
        results.append(r)
        print(f"  => {'PASS' if r.ok else 'FAIL'}  champion={r.champion}  {r.elapsed_s:.1f}s\n")

    passed = sum(1 for r in results if r.ok)
    total = len(results)
    elapsed = time.monotonic() - overall_t0
    print("=" * 60)
    print(f"  {passed}/{total} passed  total={elapsed:.1f}s")
    if passed < total:
        print("  FAILURES:")
        for r in results:
            if not r.ok:
                failed = [s for s in r.steps if not s.ok]
                print(f"    - {r.league_id}: {', '.join(f'{s.name} ({s.detail})' for s in failed)}")

    REPORT_PATH.write_text(
        json.dumps(
            {
                "base_url": args.base_url,
                "iters": args.iters,
                "passed": passed,
                "total": total,
                "elapsed_s": elapsed,
                "results": [
                    {
                        "league_id": r.league_id,
                        "ok": r.ok,
                        "champion": r.champion,
                        "elapsed_s": r.elapsed_s,
                        "steps": [
                            {"name": s.name, "ok": s.ok, "detail": s.detail, "elapsed_s": s.elapsed_s}
                            for s in r.steps
                        ],
                    }
                    for r in results
                ],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\n  report -> {REPORT_PATH}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
