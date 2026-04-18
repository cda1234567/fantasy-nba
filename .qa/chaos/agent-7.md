# Chaos Agent #7 — Multi-Season Report

**Port:** 3417  
**Date:** 2026-04-18  
**Result: MULTI-SEASON WORKS (with correct API sequence)**

---

## Season 1 (2023-24)

- League `chaos7` created and switched to
- `/api/league/setup` with `season_year=2023-24` — OK
- Draft: 10 rounds, 8 teams, completed cleanly
- `/api/season/start` → started
- `/api/season/sim-to-playoffs` → week 18
- `/api/season/sim-playoffs` → **Champion: Team 4 (AI-4)**

## Season 2 (2024-25)

- **New-season flow discovered:** Re-call `/api/league/setup` with new `season_year`
  - This resets the draft, clears the season, and updates `season_year` even though `setup_complete=True`
  - `/api/league/settings PATCH` with `season_year` is **blocked** (not in `_MID_SEASON_ALLOWED`)
  - `/api/draft/reset` with `season_year` override resets draft but does NOT update stored `season_year` in league_settings
  - Only re-calling `/api/league/setup` fully transitions to a new season year
- Draft: 10 rounds, 8 teams, all new 2024-25 players — completed cleanly
- Standings verified reset (empty before season start)
- Rosters: fresh draft, all 8 teams had 10 players each
- `/api/season/start` → started
- `/api/season/sim-to-playoffs` → week 18
- `/api/season/sim-playoffs` → **Champion: Team 0 (My Team, human)**
- Season 2 final standings: 8 teams with valid W/L records (Team 0: 16W-2L)

---

## Specific Issues Found

1. **No dedicated "new season" endpoint exists.** There is no `/api/season/new`, `/api/offseason/start`, or UI button flow (`賽季總結 → 開始下個賽季`) that explicitly resets for a next season. The workaround is re-calling `/api/league/setup`.

2. **`season_year` is locked by `_MID_SEASON_ALLOWED`** in `PATCH /api/league/settings` once `setup_complete=True`. This means the intended mid-season patch path cannot change the season year.

3. **`/api/draft/reset` season_year override is incomplete:** It resets the draft with the new season's player pool but does NOT persist the new `season_year` to `league_settings.json`. After a `draft/reset` with `season_year=2024-25`, `GET /api/league/settings` still returns `season_year=2023-24`. This is a state inconsistency bug.

4. **Standings `w`/`l` field naming:** API returns `w`/`l` but some consumers may expect `wins`/`losses` — minor documentation issue.

---

## Suggested Fixes

1. **Add a dedicated `/api/season/new` endpoint** (or `/api/offseason/next-season`) that accepts `season_year`, clears season+trades, resets the draft with the new player pool, persists the new `season_year` to league_settings, and keeps `setup_complete=True` (since league structure doesn't change). This gives a clean, explicit multi-season contract.

2. **Add `season_year` to `_MID_SEASON_ALLOWED`** (or create a separate post-champion allowed set) so that once a champion is crowned, the season year can be patched directly.

3. **Fix `/api/draft/reset` season_year override** to also persist the new `season_year` to league_settings when provided, ensuring settings stay consistent with the active draft pool.
