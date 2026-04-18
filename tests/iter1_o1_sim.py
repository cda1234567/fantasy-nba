"""ITER1 O1: API-driven full lifecycle simulation + validation.

Drives the production-like Fantasy NBA server at http://127.0.0.1:3410 through:
- draft reset
- draft all 104 picks via ai-advance / human picks
- start season
- advance ~10 days and inspect Chinese logs
- sim-to-playoffs and check position diversity on leaders
- sim-playoffs and verify champion appears
- season summary (MVP, top games, standings)
- FA claim (drop lowest-FPPG, add highest-FPPG FA)
- light 4xx/5xx probing
"""
from __future__ import annotations

import json
import sys
import time
from typing import Any

import requests

import os
BASE = os.environ.get("FNBA_BASE", "https://nbafantasy.cda1234567.com")
S = requests.Session()


def _url(p: str) -> str:
    return BASE.rstrip("/") + p


def log(msg: str) -> None:
    try:
        print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)
    except UnicodeEncodeError:
        # stdout cp950 fallback
        safe = msg.encode("utf-8", errors="replace").decode("ascii", errors="replace")
        print(f"[{time.strftime('%H:%M:%S')}] {safe}", flush=True)


def _with_retry(fn, *args, retries: int = 5, **kw) -> requests.Response:
    last_exc = None
    for i in range(retries):
        try:
            r = fn(*args, **kw)
            if r.status_code in (502, 503, 504):
                last_exc = requests.HTTPError(f"{r.status_code}")
                time.sleep(2 + i)
                continue
            return r
        except (requests.ReadTimeout, requests.ConnectionError) as e:
            last_exc = e
            time.sleep(2 + i)
    raise last_exc or RuntimeError("retry exhausted")


def get(path: str, timeout: float = 60, **kw: Any) -> requests.Response:
    return _with_retry(S.get, _url(path), timeout=timeout, **kw)


def post(path: str, timeout: float = 60, **kw: Any) -> requests.Response:
    return _with_retry(S.post, _url(path), timeout=timeout, **kw)


def expect_ok(r: requests.Response, ctx: str) -> dict:
    if r.status_code >= 400:
        log(f"!! {ctx} -> HTTP {r.status_code}: {r.text[:300]}")
        r.raise_for_status()
    try:
        return r.json()
    except Exception:
        return {"raw": r.text}


def safe_get(path: str, ctx: str, retries: int = 5, timeout: float = 60, **kw):
    last = None
    for i in range(retries):
        try:
            r = S.get(_url(path), timeout=timeout, **kw)
            if r.status_code == 502 or r.status_code >= 500:
                last = r
                time.sleep(2 + i)
                continue
            return expect_ok(r, ctx)
        except Exception as e:
            last = e
            time.sleep(2 + i)
    if isinstance(last, requests.Response):
        return expect_ok(last, ctx)
    raise last  # type: ignore


def safe_post(path: str, ctx: str, retries: int = 5, timeout: float = 60, **kw):
    last = None
    for i in range(retries):
        try:
            r = S.post(_url(path), timeout=timeout, **kw)
            if r.status_code == 502 or r.status_code >= 500:
                last = r
                time.sleep(2 + i)
                continue
            return expect_ok(r, ctx)
        except Exception as e:
            last = e
            time.sleep(2 + i)
    if isinstance(last, requests.Response):
        return expect_ok(last, ctx)
    raise last  # type: ignore


report: dict[str, Any] = {"issues": [], "checks": {}, "timings": {}}


def issue(kind: str, detail: str) -> None:
    report["issues"].append({"kind": kind, "detail": detail})
    log(f"ISSUE[{kind}]: {detail}")


def check(name: str, ok: bool, detail: str = "") -> None:
    report["checks"][name] = {"ok": bool(ok), "detail": detail}
    log(f"{'PASS' if ok else 'FAIL'} {name}: {detail}")


def main() -> int:
    t0 = time.time()

    # --- 1. Health and reset ----------------------------------------------
    h = expect_ok(get("/api/health"), "health")
    check("health_ok", h.get("ok") is True or h.get("status") == "ok", str(h)[:120])

    # reset draft
    t = time.time()
    st = expect_ok(post("/api/draft/reset", json={"randomize_order": False}), "reset")
    report["timings"]["reset_ms"] = int((time.time() - t) * 1000)
    check(
        "reset_empty",
        st.get("current_overall") == 1 and all(p is None for row in st["board"] for p in row),
        f"pick={st.get('current_overall')} teams={st.get('num_teams')}",
    )
    num_teams = st["num_teams"]
    total_rounds = st["total_rounds"]
    total_picks = num_teams * total_rounds
    check(
        "expected_104_picks",
        total_picks == 104,
        f"{num_teams}x{total_rounds} = {total_picks}",
    )

    # --- 2. Draft all picks -----------------------------------------------
    t = time.time()
    iters = 0
    while not st.get("is_complete"):
        iters += 1
        if iters > 500:
            issue("DRAFT_INFINITE", "Draft did not complete in 500 iterations")
            break
        if st.get("current_team_id") == st.get("human_team_id"):
            # Pick BPA (first available high-ranked player) for human via sim-to-me won't work
            # as human is about to pick. Instead, fetch available and pick highest rank.
            players = expect_ok(get("/api/players", params={"available": "true", "limit": 5}), "players")
            lst = players if isinstance(players, list) else players.get("players", [])
            if not lst:
                issue("DRAFT_NO_PLAYERS", "no available players for human pick")
                break
            pid = lst[0]["id"]
            expect_ok(post("/api/draft/pick", json={"player_id": pid}), f"pick {pid}")
        else:
            expect_ok(post("/api/draft/ai-advance"), "ai-advance")
        st = expect_ok(get("/api/state"), "state")
    report["timings"]["draft_ms"] = int((time.time() - t) * 1000)
    check(
        "draft_complete",
        st.get("is_complete") is True,
        f"picks={len(st.get('picks', []))}",
    )
    check(
        "draft_picks_104",
        len(st.get("picks", [])) == total_picks,
        f"{len(st.get('picks', []))}",
    )

    # Position backfill check: every drafted player has pos (v0.5.2)
    players_all = expect_ok(get("/api/players", params={"limit": 1000}), "players-all")
    plist = players_all if isinstance(players_all, list) else players_all.get("players", [])
    drafted_ids = {p["player_id"] for p in st["picks"]}
    missing_pos = [p for p in plist if p["id"] in drafted_ids and not (p.get("pos") or "").strip()]
    check(
        "v052_pos_backfill",
        len(missing_pos) == 0,
        f"{len(missing_pos)} drafted players missing pos",
    )
    if missing_pos:
        issue("POS_MISSING", f"{len(missing_pos)} missing pos after draft, e.g. {missing_pos[0]['name']}")

    # Position diversity on drafted players
    pos_counts: dict[str, int] = {}
    for p in plist:
        if p["id"] in drafted_ids:
            pos_counts[p.get("pos", "")] = pos_counts.get(p.get("pos", ""), 0) + 1
    check("draft_pos_diversity", len(pos_counts) >= 3, json.dumps(pos_counts, ensure_ascii=False))

    # --- 3. Start season --------------------------------------------------
    t = time.time()
    season = expect_ok(post("/api/season/start", json={}), "season-start")
    report["timings"]["season_start_ms"] = int((time.time() - t) * 1000)
    check("season_started", season.get("started") is True, f"week={season.get('current_week')}")

    # --- 4. Advance ~10 days ---------------------------------------------
    t = time.time()
    for i in range(10):
        expect_ok(post("/api/season/advance-day", json={"use_ai": False}), f"adv-day-{i+1}")
    report["timings"]["adv10d_ms"] = int((time.time() - t) * 1000)
    logs = expect_ok(get("/api/season/logs", params={"limit": 30}), "logs")
    log_items = logs.get("logs", [])
    check("logs_present", len(log_items) > 0, f"{len(log_items)} log entries")

    # Chinese content check: at least some logs should contain CJK
    def has_cjk(s: str) -> bool:
        return any("\u4e00" <= ch <= "\u9fff" for ch in s)

    text_blob = " ".join(
        (li.get("text") or li.get("message") or li.get("summary") or json.dumps(li, ensure_ascii=False))
        for li in log_items
    )
    check("logs_cjk", has_cjk(text_blob), f"cjk_found={has_cjk(text_blob)} sample={text_blob[:120]}")
    if not has_cjk(text_blob):
        issue("LOGS_NOT_CHINESE", f"activity log lacks Chinese: {text_blob[:200]}")

    # --- 5. Sim to playoffs ------------------------------------------------
    # advance-week repeatedly (safer than one huge sim-to-playoffs call which
    # hits 60s proxy timeout for the full regular season).
    t = time.time()
    st2 = season
    guard = 0
    while not st2.get("is_playoffs") and st2.get("current_week", 0) <= 25 and guard < 25:
        guard += 1
        try:
            st2 = expect_ok(
                post("/api/season/advance-week", json={"use_ai": False}, timeout=180),
                f"adv-week-{guard}",
            )
        except Exception as e:
            issue("ADV_WEEK_FAIL", f"iter {guard}: {e!r}")
            break
    report["timings"]["sim_to_playoffs_ms"] = int((time.time() - t) * 1000)
    check(
        "reached_playoffs",
        st2.get("is_playoffs") is True or st2.get("current_week", 0) > 20,
        f"week={st2.get('current_week')} is_playoffs={st2.get('is_playoffs')}",
    )

    # Top-10 leaders position diversity (must not be all SF)
    # Use season summary endpoint for leaders.
    summary = expect_ok(get("/api/season/summary"), "summary-pre-playoffs")
    leaders = summary.get("season_leaders", [])[:10]
    lead_pos = [lp.get("pos", "") for lp in leaders]
    pos_set = {p for p in lead_pos if p}
    check(
        "leaders_pos_real",
        len(pos_set) >= 2 and lead_pos.count("SF") < len(lead_pos),
        f"positions={lead_pos}",
    )
    if lead_pos and all(p == "SF" for p in lead_pos if p):
        issue("LEADERS_ALL_SF", f"All top leaders labelled SF: {lead_pos}")

    # --- 6. Sim playoffs --------------------------------------------------
    t = time.time()
    st3 = expect_ok(post("/api/season/sim-playoffs", json={"use_ai": False}, timeout=300), "sim-playoffs")
    report["timings"]["sim_playoffs_ms"] = int((time.time() - t) * 1000)
    check(
        "has_champion",
        st3.get("champion") is not None,
        f"champion={st3.get('champion')}",
    )

    # --- 7. Season summary (MVP, top5, standings) ------------------------
    summary2 = expect_ok(get("/api/season/summary"), "summary-final")
    check("summary_is_complete", summary2.get("is_complete") is True, str(summary2.get("champion_name")))
    check("summary_has_mvp", summary2.get("mvp") is not None, str((summary2.get("mvp") or {}).get("name")))
    check(
        "summary_top5_games",
        len(summary2.get("top_games", [])) >= 5,
        f"{len(summary2.get('top_games', []))}",
    )
    check(
        "summary_standings_full",
        len(summary2.get("final_standings", [])) == num_teams,
        f"{len(summary2.get('final_standings', []))}",
    )

    # --- 8. FA claim ------------------------------------------------------
    # after playoffs, season is usually still queryable. Attempt FA.
    cs = expect_ok(get("/api/fa/claim-status"), "claim-status")
    check("fa_status_shape", "limit" in cs and "used_today" in cs, json.dumps(cs, ensure_ascii=False))

    # Build drop + add candidates
    human_team_id = st.get("human_team_id", 0)
    roster_resp = expect_ok(get(f"/api/teams/{human_team_id}"), "team-roster")
    roster = roster_resp.get("roster") or roster_resp.get("players") or []
    # Compute FPPG for roster using summary.season_leaders if available
    leader_map = {lp["player_id"]: lp.get("fppg", 0) for lp in summary2.get("season_leaders", [])}
    if roster:
        # pick lowest-fppg roster player for drop
        roster_with_fppg = [(p.get("id") or p.get("player_id"), leader_map.get(p.get("id") or p.get("player_id"), 0), p.get("name", "?")) for p in roster]
        roster_with_fppg.sort(key=lambda x: x[1])
        drop_id, drop_fppg, drop_name = roster_with_fppg[0]

        # find best FA (available, not on any roster)
        fa_resp = expect_ok(get("/api/players", params={"available": "true", "limit": 10}), "fa")
        fas = fa_resp if isinstance(fa_resp, list) else fa_resp.get("players", [])
        if fas:
            add = fas[0]
            add_id = add["id"]
            add_name = add["name"]
            try:
                claim = post("/api/fa/claim", json={"drop_player_id": drop_id, "add_player_id": add_id})
                if claim.status_code < 400:
                    body = claim.json()
                    check("fa_claim_ok", body.get("ok") is True, f"{drop_name}->{add_name} remaining={body.get('remaining')}")
                else:
                    body_txt = claim.text
                    # in playoffs, claims may be locked; record as informational
                    check("fa_claim_ok", False, f"HTTP {claim.status_code} {body_txt[:200]}")
                    if claim.status_code == 400 and "playoff" in body_txt.lower():
                        log("(FA blocked during playoffs is expected)")
                    else:
                        issue("FA_CLAIM_FAIL", f"HTTP {claim.status_code}: {body_txt[:200]}")
            except Exception as e:
                issue("FA_CLAIM_EXC", repr(e))
        else:
            issue("FA_NO_FAS", "no free agents returned")
    else:
        issue("FA_NO_ROSTER", "human roster empty post-draft")

    # --- 9. 4xx/5xx probes -----------------------------------------------
    bad = S.get(_url("/api/season/matchup"), params={"week": 999}, timeout=30)
    check("matchup_404_on_bad_week", bad.status_code in (404, 422), f"status={bad.status_code}")

    bad_fa = S.post(
        _url("/api/fa/claim"),
        json={"drop_player_id": 99999999, "add_player_id": 1},
        timeout=30,
    )
    check("fa_claim_bad_request", bad_fa.status_code >= 400, f"status={bad_fa.status_code}")

    report["total_ms"] = int((time.time() - t0) * 1000)
    report["summary"] = {
        "pass": sum(1 for c in report["checks"].values() if c["ok"]),
        "fail": sum(1 for c in report["checks"].values() if not c["ok"]),
        "issues": len(report["issues"]),
    }

    with open("D:/claude/fantasy nba/tests/iter1_o1_result.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    log(f"\n=== DONE: pass={report['summary']['pass']} fail={report['summary']['fail']} issues={len(report['issues'])} in {report['total_ms']}ms ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
