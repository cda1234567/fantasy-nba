# Chaos Agent #9 — Settings Dialog Buttons QA Report

**Port:** 3419 | **League:** chaos9 | **Date:** 2026-04-18

## Setup
- Data dir copied to `.qa/chaos/data-9/data`
- Server started via `uv run uvicorn` (NOTE: bare `uvicorn` on PATH uses system Python 3.13 without project deps — `model_dump()` AttributeError on `create_league`. Must use `uv run uvicorn`.)
- League chaos9 created, switched, setup, draft completed (13 rounds, human picked manually per round)

## Button Results

### 開始賽季 (Start Season) — PASS
- `POST /api/season/start` → `{"started":true,"current_week":1}`
- `/api/season/standings` within 1s: 8 teams populated, all W=0/L=0/PF=0
- Observable: YES

### 模擬到季後賽 (Sim to Playoffs) — PASS
- `POST /api/season/sim-to-playoffs` → `current_week:20, is_playoffs:true`
- `/api/season/standings` within 1s: `"is_playoffs":true`
- Observable: YES

### 模擬季後賽 (Sim Playoffs) — PASS
- `POST /api/season/sim-playoffs` → `champion:0` (human team won)
- `/api/season/standings` within 1s: `"champion":0, "is_playoffs":true`
- Observable: YES

### 重置賽季 (Reset Season) — PASS (backend), STALE STATE BUG (frontend)
- `POST /api/season/reset` → `{"ok":true}`
- `/api/season/standings` within 1s: `standings:[], week:0, is_playoffs:false, champion:null`
- Backend observable: YES
- Frontend: `onResetSeason()` calls `refreshState()` then `render()` — correctly clears `state.season=null`
- **Minor bug**: `state.summaryShownFor` is never cleared on season reset. If a new season is played to completion, the champion auto-summary dialog will NOT fire (condition `!state.summaryShownFor` is false). Requires page reload to restore.

### 重置選秀 (Reset Draft) — PASS (backend), STALE STATE BUG (frontend)
- `POST /api/draft/reset` → empty rosters, `is_complete:false, current_overall:1`
- `/api/season/standings` after draft reset: backend correctly returns empty shell
- Backend observable: YES
- **BUG (`app.js:3624`)**: `onResetDraft()` sets `state.draft = r` and calls `render()` but does NOT call `refreshState()`. As a result:
  - `state.standings` retains old season data (teams with W/L/PF scores)
  - `state.season` remains `{ active: true }` instead of `null`
  - The standings/season UI panel continues to display active season results after draft reset
  - User sees a live season on a blank-roster draft — misleading until page reload

## Summary

| Button | API Response | /api/season/standings ≤2s | UI Cache Cleared |
|--------|-------------|--------------------------|-----------------|
| 開始賽季 | OK | YES | YES |
| 模擬到季後賽 | OK | YES | YES |
| 模擬季後賽 | OK | YES | YES |
| 重置賽季 | OK | YES | YES (but `summaryShownFor` leaks) |
| 重置選秀 | OK | YES (backend) | **NO — missing `refreshState()` call** |

## Bugs Found
1. **[HIGH] `app.js:3624` `onResetDraft()` missing `refreshState()`** — stale standings visible after draft reset
2. **[LOW] `state.summaryShownFor` not cleared in `onResetSeason()`** — champion auto-summary suppressed in subsequent season

## Server
- PID 20380 killed via `taskkill //F //PID 20380`
