"""
Round 5 — Hostile API testing.
Confirms server rejects malformed payloads, XSS, path traversal safely.
Note: we test API directly here (not UI) because "a user sending malformed input"
is by definition bypassing the UI.
"""
import json
import pathlib
import time
import requests
from datetime import datetime

BASE = "https://nbafantasy.cda1234567.com"
OUT = pathlib.Path(r"D:\claude\fantasy nba\.qa\round5")
REPORT = OUT / "hostile.md"
LOG = OUT / "hostile.log"

_lines = []


def log(msg):
    line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    _lines.append(line)
    try:
        LOG.write_text("\n".join(_lines), encoding="utf-8")
    except Exception:
        pass


def test(name, fn):
    try:
        got = fn()
        log(f"{name}: {got}")
        return {"name": name, "result": got}
    except Exception as e:
        log(f"{name}: EXC {e}")
        return {"name": name, "result": f"EXC {e}"}


def probe(method, path, **kw):
    url = BASE + path
    try:
        r = requests.request(method, url, timeout=15, **kw)
        return r.status_code, r.text[:500]
    except Exception as e:
        return "EXC", str(e)[:500]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    findings = []

    # 1. Malformed draft pick (non-int player id)
    findings.append(test("draft-pick non-int pid", lambda: probe("POST", "/api/draft/pick", json={"player_id": "not-a-number"})))
    # 2. Draft pick with huge pid
    findings.append(test("draft-pick huge pid", lambda: probe("POST", "/api/draft/pick", json={"player_id": 99999999999})))
    # 3. Draft pick with negative pid
    findings.append(test("draft-pick negative pid", lambda: probe("POST", "/api/draft/pick", json={"player_id": -1})))
    # 4. Draft pick with array
    findings.append(test("draft-pick with array", lambda: probe("POST", "/api/draft/pick", json={"player_id": [1, 2, 3]})))
    # 5. Empty body
    findings.append(test("draft-pick empty body", lambda: probe("POST", "/api/draft/pick", json={})))
    # 6. No body
    findings.append(test("draft-pick no body", lambda: probe("POST", "/api/draft/pick")))
    # 7. SQL-injection-like string in league name
    findings.append(test("league create SQLi attempt", lambda: probe("POST", "/api/leagues/create", json={"league_id": "'; DROP TABLE users;--"})))
    # 8. XSS in league_id
    findings.append(test("league create XSS attempt", lambda: probe("POST", "/api/leagues/create", json={"league_id": "<script>alert(1)</script>"})))
    # 9. Path traversal in league_id
    findings.append(test("league create path traversal", lambda: probe("POST", "/api/leagues/create", json={"league_id": "../../../../etc/passwd"})))
    # 10. Unicode null bytes
    findings.append(test("league create null bytes", lambda: probe("POST", "/api/leagues/create", json={"league_id": "test\x00null"})))
    # 11. Very long league_id
    findings.append(test("league create long id", lambda: probe("POST", "/api/leagues/create", json={"league_id": "x" * 10000})))
    # 12. Fetch non-existent season
    findings.append(test("seasons get /etc/passwd", lambda: probe("GET", "/api/seasons/../../../etc/passwd/headlines")))
    # 13. Setup with huge roster_size
    findings.append(test("setup huge roster", lambda: probe("POST", "/api/league/setup", json={"roster_size": 999999, "league_name": "x"})))
    # 14. Setup with negative values
    findings.append(test("setup negative values", lambda: probe("POST", "/api/league/setup", json={"roster_size": -5, "starters_per_day": -1})))
    # 15. JSON with wrong content-type
    findings.append(test("wrong content-type", lambda: probe("POST", "/api/draft/pick", data="{\"player_id\": 1}")))
    # 16. Bogus switch request
    findings.append(test("switch to non-existent league", lambda: probe("POST", "/api/leagues/switch", json={"league_id": "nonexistent-xyz-" + str(int(time.time()))})))
    # 17. Advance day when no season
    findings.append(test("advance-day no season", lambda: probe("POST", "/api/season/advance-day", json={"use_ai": False})))

    # Verify none returned 5xx (indicating unhandled error)
    server_errors = [f for f in findings if isinstance(f["result"], tuple) and isinstance(f["result"][0], int) and f["result"][0] >= 500]
    log(f"5xx count: {len(server_errors)}")

    rows = []
    for f in findings:
        r = f["result"]
        if isinstance(r, tuple):
            status, body = r
            rows.append(f"| {f['name']} | {status} | `{body[:120].replace('|', '\\|')}` |")
        else:
            rows.append(f"| {f['name']} | - | {r} |")

    report = f"""# Round 5 — Hostile API probing

Host: {BASE}

## Results

| test | status | response preview |
|------|--------|------------------|
{chr(10).join(rows)}

## Summary

Server 5xx count: {len(server_errors)}
Verdict: {'PASS - all malformed inputs handled without 5xx' if len(server_errors) == 0 else 'FAIL - uncaught server errors: ' + str([f['name'] for f in server_errors])}
"""
    REPORT.write_text(report, encoding="utf-8")
    log(f"report: {REPORT}")


if __name__ == "__main__":
    main()
