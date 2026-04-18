# Stress-test: LeagueSettings PATCH Validation — Agent 6

Date: 2026-04-18  
Server: uvicorn port 3505, DATA_DIR=`.qa/stress/data-6`  
Setup-complete: NO (pre-setup state)

## Results Table

| # | Field | Bad Value | Expected Status | Actual Status | Bug? |
|---|-------|-----------|-----------------|---------------|------|
| a | team_names | `["", "B",…]` (blank) | 422 | **400** | No logic bug — rejected. Status is 400 not 422 (FastAPI detail) |
| b | team_names | `[" ", "  ",…]` (whitespace) | 422 | **400** | No logic bug — rejected correctly |
| c | team_names | 7 entries (wrong length for 8-team) | 422 | **200** | **BUG** — silently accepted; no length validation |
| d | num_teams | `0` | 422 | **200** | **BUG** — silently accepted |
| d | num_teams | `100` | 422 | **200** | **BUG** — silently accepted |
| e | roster_size | `0` | 422 | **200** | **BUG** — silently accepted |
| e | roster_size | `999` | 422 | **200** | **BUG** — silently accepted |
| f | starters_per_day | `-5` | 422 | **200** | **BUG** — silently accepted |
| g | scoring_weights | `{"pts": "not a number"}` | 422 | **400** | No logic bug — Pydantic type coercion rejects non-numeric |
| h | regular_season_weeks | `0` | 422 | **200** | **BUG** — silently accepted |
| h | regular_season_weeks | `999` | 422 | **200** | **BUG** — silently accepted |
| i | playoff_teams | `0` | 422 | **200** | **BUG** — silently accepted |
| i | playoff_teams | `99` | 422 | **200** | **BUG** — silently accepted |
| j | trade_deadline_week | `0` | 422 | **200** | **BUG** — silently accepted |
| j | trade_deadline_week | `-1` | 422 | **200** | **BUG** — silently accepted |
| j | trade_deadline_week | `999` | 422 | **200** | **BUG** — silently accepted |
| k | veto_threshold | `-1` | 422 | **200** | **BUG** — silently accepted |
| k | veto_threshold | `9999` | 422 | **200** | **BUG** — silently accepted |
| l | ai_trade_style | `"nonexistent_style"` | 422 | **200** | **BUG** — silently accepted; no enum validation |
| m | ai_trade_frequency | `"always_always"` | 422 | **200** | **BUG** — silently accepted; no enum validation |

## State Corruption Check

After all bad PATCHes, GET /api/league/settings confirmed corruption:

- `num_teams` → 100 (from test d)
- `roster_size` → 999 (from test e)
- `starters_per_day` → -5 (from test f)
- `regular_season_weeks` → 999 (from test h)
- `playoff_teams` → 99 (from test i)
- `trade_deadline_week` → 999 (from test j)
- `veto_threshold` → 9999 (from test k)
- `ai_trade_style` → "nonexistent_style" (from test l)
- `ai_trade_frequency` → "always_always" (from test m)
- `team_names` → 7 entries ["A","B","C","D","E","F","G"] (from test c)

**Verdict: All invalid numeric and string-enum values are persisted to disk with no guard.**

## Happy Path

Valid PATCH with `roster_size=15, starters_per_day=12, veto_threshold=4, ai_trade_style=aggressive, team_names=["Alpha"…]` returned **200**. Subsequent GET confirmed all values persisted correctly.

## Root Cause

`LeagueSettings` model has:
- `@field_validator("team_names")` — guards blank/whitespace only
- Pydantic type coercion — catches `str` where `float` expected
- **No `Field(ge=1)` / `Field(le=...)` constraints** on any integer fields
- **No `Literal` or validator** for `ai_trade_style`, `ai_trade_frequency`

## Recommended Fixes

1. Add `Field(ge=1, le=30)` (or appropriate bounds) to `num_teams`, `roster_size`, `starters_per_day`, `regular_season_weeks`, `playoff_teams`, `veto_threshold`, `veto_window_days`.
2. Add `Field(ge=0)` or `Optional[int] = Field(None, ge=1, le=30)` to `trade_deadline_week`.
3. Change `ai_trade_style` and `ai_trade_frequency` to `Literal[...]` types with allowed values.
4. Add `@field_validator("team_names")` length check: `len(v) == num_teams`.
5. The PATCH endpoint raises `HTTPException(400,...)` — consider 422 for consistency with FastAPI validation errors, though 400 is acceptable.
