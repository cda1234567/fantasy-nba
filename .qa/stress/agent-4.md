# Stress Test Report — agent-4 (Multi-League Lifecycle)
Date: 2026-04-18 | Server: uvicorn port 3503 | DATA_DIR: .qa/stress/data-4

---

## Summary

| Test | Result |
|------|--------|
| 3a Create 5 leagues | PASS |
| 3b List all 5 | PASS |
| 3c Switch to gamma + health check | PASS |
| 3d Restart persistence (active_league.json) | **PASS — no bug reproduced** |
| 3e Delta patch isolation from gamma | PASS (sequential) |
| 3f Delete alpha | PASS |
| 3g Switch to deleted league | PASS (400, graceful) |
| 4 Blank team names validation | PASS (400, validator fires) |
| 5 Concurrent switch+patch | **FAIL — 500s + settings leak** |

---

## Finding 1: active_league.json Persistence — NOT A BUG

The reported "refresh bounces back" bug **did not reproduce**.

After switching to gamma and restarting uvicorn with the same DATA_DIR:
- `active_league.json` on disk: `{"league_id": "gamma"}`
- `GET /api/health` after restart: `{"league_id": "gamma"}`

**Persistence is working correctly.** The user's reported issue may be environmental (different DATA_DIR between processes, Docker volume not mounted, or env var `LEAGUE_ID` overriding the pointer — see `main.py` line 64–68 where `LEAGUE_ID` env var takes priority over the file).

---

## Finding 2 (BUG): Settings Leak Across Leagues Under Concurrent Load

**Severity: High**

When concurrent threads interleave switch+patch operations, `storage` (module-global) is reassigned mid-flight by `_switch_league`. A thread calling `POST /api/league/settings` may load settings from league X, then write to storage pointing at league Y because another thread switched in between.

**Reproduction steps:**
1. Run 8 concurrent threads each doing: switch(league) → patch(team_names)
2. Observe on-disk league_settings.json files have wrong team_names

Observed outcome after 16 concurrent ops (2 rounds × 4 leagues):
- `gamma/league_settings.json` → first team name `E1` (epsilon's names written to gamma)
- `beta/league_settings.json` → first team name `G1` (gamma's names written to beta)

The window is: `_current_settings()` reads `storage.league_id=X`, then `_league_lock` switches storage to Y, then `storage.save_league_settings(updated)` writes to Y.

---

## Finding 3 (BUG): 500 PermissionError on Concurrent Patch

**Severity: Medium**

Two threads simultaneously writing `.tmp` → `os.replace()` to the same league's `league_settings.json` on Windows causes:

```
PermissionError: [WinError 5] Access is denied:
  '...leagues/delta/league_settings.json.<pid>.<uuid>.tmp'
  -> '...leagues/delta/league_settings.json'
PermissionError: [WinError 5] Access is denied:
  '...leagues/gamma/league_settings.json.<pid>.<uuid>.tmp'
  -> '...leagues/gamma/league_settings.json'
```

`os.replace()` on Windows fails if the target file is open by another process/thread. The atomic-rename pattern is not truly atomic on Windows when concurrent writers race to the same destination.

Occurred once out of 16 ops (6.25% rate).

---

## Finding 4: Blank Name Validation Returns 400 Not 422

**Behaviour:** `PATCH /api/league/settings` with `team_names=["", " ", "ok", ...]` returns HTTP 400, not 422.

The validator added in v0.5.37 fires correctly (rejects blank/whitespace names), but because the endpoint catches `ValueError` and re-raises as `HTTPException(400, ...)` rather than letting Pydantic's validation propagate as a 422, the status code is 400. Functionally correct; status code differs from spec expectation.

---

## No Crashes on Normal Operations

All sequential operations (create, list, switch, delete, switch-to-deleted) returned expected status codes with no 500s. Server remained stable throughout non-concurrent testing.

---

## Recommended Fixes

1. **Settings leak**: `patch_league_settings` should capture `storage` into a local variable at the top of the handler (before any await or lock contention), or use a per-request storage instance rather than the mutable global.
2. **Windows PermissionError on os.replace**: Add per-league file lock (e.g. `threading.Lock` keyed by league_id) in `Storage.save_league_settings` to serialize concurrent writers to the same file.
3. **"Refresh bounces back" report**: Investigate whether production container sets `LEAGUE_ID` env var (overrides pointer file) or uses a different DATA_DIR mount between restarts.
