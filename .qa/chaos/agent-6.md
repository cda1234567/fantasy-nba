# Chaos Agent 6 — Mid-Season League Settings Test

**Date:** 2026-04-18  **Port:** 3416  **League:** chaos6

---

## Setup Notes

`/api/leagues/create` and `/api/league/setup` both crashed with `AttributeError: 'LeagueSettings' object has no attribute 'model_dump'`. Root cause: server was launched with system Python 3.13 + Pydantic **v1.10.26**, but the codebase uses Pydantic v2 API (`model_dump`, `model_copy`, `model_copy(update=...)`). The venv at `.venv/` has Pydantic **v2.13.1**. Workaround: restarted server with `.venv/Scripts/uvicorn.exe`; seeded `league_settings.json` manually with `setup_complete: true` since setup endpoint remained broken.

---

## Forbidden Field Enforcement (Backend)

| Field | Expected | Actual | Pass? |
|---|---|---|---|
| `roster_size` | 400 | `{"detail":"聯盟設定完成後無法變更欄位：['roster_size']"}` | PASS |
| `num_teams` | 400 | `{"detail":"聯盟設定完成後無法變更欄位：['num_teams']"}` | PASS |
| `regular_season_weeks` | 400 | `{"detail":"聯盟設定完成後無法變更欄位：['regular_season_weeks']"}` | PASS |
| mixed allowed+forbidden | 400 on forbidden | 400 returned correctly | PASS |

All `_MID_SEASON_ALLOWED` enforced correctly in `app/main.py:429`.

---

## Allowed Field Saves (Backend)

| Field | Expected | Actual | Pass? |
|---|---|---|---|
| `team_names` | 200 + saved | Saved correctly | PASS |
| `ai_trade_frequency` | 200 + saved | Saved correctly | PASS |
| `ai_trade_style` | 200 + saved | Saved correctly | PASS |
| `ai_decision_mode` | 200 + saved | Saved correctly | PASS |
| `draft_display_mode` | 200 + saved | Saved correctly | PASS |
| `show_offseason_headlines` | 200 + saved | Saved correctly | PASS |
| Unchanged settings re-POST | 200 no-op | Saved cleanly (no error) | PASS |

---

## Bug Found: Empty Team Names Accepted

**POST** `{"team_names":["","","","","","","",""]}` returns **200** and persists all-empty names. No validation rejects blank strings. The UI does not guard against this either — `onSaveLeagueSettings` maps raw `input.value` with no trim/non-empty check (`static/app.js:790-792`).

**Hypothesis:** Backend patch handler at `app/main.py:426-436` calls `settings.model_copy(update=body)` then saves without any field-level validation on `team_names` contents. A Pydantic validator on `LeagueSettings.team_names` (e.g. `@validator('team_names')` in `app/models.py:24`) could reject empty strings.

---

## UI Dialog Audit

`renderLeagueSettingsDialog` (`static/app.js:710-784`) exposes **only** the six allowed fields:
- `team_names`, `ai_trade_frequency`, `ai_trade_style`, `ai_decision_mode`, `draft_display_mode`, `show_offseason_headlines`

No forbidden fields (`roster_size`, `num_teams`, `regular_season_weeks`, `starters_per_day`, `il_slots`, `scoring_weights`, `playoff_teams`, `trade_deadline_week`) appear in the dialog. UI containment is correct.

`onSaveLeagueSettings` (`static/app.js:786-822`) sends only those six keys. No accidental forbidden-field leakage.

---

## Error Surfacing Quality

- Forbidden field errors: **Good** — HTTP 400 with Chinese message `"聯盟設定完成後無法變更欄位：[...]"` listing exact field names. UI catches via `catch(e)` and calls `toast(e.message, 'error')` (`static/app.js:819-821`), but the `api()` function must surface the `detail` string from the 400 body — needs verification that `api()` throws with `detail` as message.
- Empty team names: **Silent failure** — 200 returned, no user feedback that names were blank.
- Infrastructure error (`model_dump` crash): **500 Internal Server Error** with no user-facing message — bad DX during setup/create flow.

---

## Critical Bug (Infrastructure)

**File:** `app/storage.py:160`, `app/storage.py:274`, `app/main.py:342,422,468`  
All call `.model_dump()` / `.model_copy()` (Pydantic v2 API) but the system Python install has Pydantic v1. The venv is correct. Deployment/CI must ensure the venv Python is always used; the `run.ps1` or Dockerfile should be the canonical launch path, not bare `uvicorn`.

---

## Summary

- 0 forbidden fields exposed in UI dialog
- Backend correctly rejects all 3 forbidden structural fields with clear 400 errors
- **1 bug:** empty team names accepted silently — `app/models.py:24` needs a non-empty validator
- **1 infrastructure bug:** Pydantic v1/v2 mismatch crashes create/setup/GET-settings when server launched outside venv
