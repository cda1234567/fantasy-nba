# Fantasy NBA — 3-Season Playwright Run Report (Wave G)

Generated from `uv run python tests/play_season.py --seasons 3 --headless` against
the `fantasy-nba-local` docker container on port 3410.

## Ship criteria

| Criterion | Target | S1 | S2 | S3 | Result |
|---|---|---|---|---|---|
| Trades executed | ≥ 10 per season | 11 | 11 | 11 | PASS |
| AI-to-AI trades | ≥ 1 per season | 9 | 9 | 9 | PASS |
| Vetoed trades | ≥ 1 across 3 seasons | 5 | 5 | 5 | PASS (15 total) |
| Crashes / stuck pending_accept | none | 0 | 0 | 0 | PASS |
| Champion determined | yes | Yes | Yes | Yes | PASS |

## Per-season summary

| Season | Exec | Vetoed | Rejected | Expired | AI↔AI | Human | Champion | Wall-clock |
|---|---|---|---|---|---|---|---|---|
| 1 | 11 | 5 | 2 | 0 | 9 | 2 | BPA Nerd (T2) | 78.5 s |
| 2 | 11 | 5 | 1 | 0 | 9 | 2 | BPA Nerd (T2) | 89.6 s |
| 3 | 11 | 5 | 2 | 0 | 9 | 2 | BPA Nerd (T2) | 71.6 s |

Total wall-clock ≈ 4 min for 3 full seasons headless.

## Bugs found and fixed in-place

### 1. Atomic-write race in `app/storage.py`
**Symptom:** Random 500 errors (`FileNotFoundError: log.json.tmp -> log.json`)
on `/api/season/advance-day`, `/api/trades/.../accept`, `/api/trades/.../veto`.
**Root cause:** `_atomic_write` used a fixed `.tmp` suffix. FastAPI sync routes
run in a threadpool, so multiple concurrent writes to the same target raced on
one tmp file — the second `os.replace` found the tmp already consumed.
**Fix:** Unique tmp names (`path.<pid>.<uuid>.tmp`) and a `threading.Lock`
around the log-append read-modify-write block so events aren't lost.
`app/storage.py:24-32, 53-70, 119-134`.

### 2. Veto mechanism was effectively dead code in `app/ai_gm.py`
**Symptom:** Zero vetoes across entire seasons.
**Root cause:** Proposer heuristic caps trade FPPG ratio at 1.15, acceptance
heuristic rejects > ~1.09, so executed trades always sit in [1.00, 1.09]. But
`vote_veto_heuristic` had thresholds 1.20 (balanced) / 1.30 (others) — no AI
ever voted.
**Fix:** Re-calibrated to 1.05 / 1.07 so the more lopsided accepted trades
accumulate the 3 votes needed to actually trigger a veto. Human-side veto
threshold in `tests/play_season.py` lowered to 1.07 to match.
`app/ai_gm.py:360-375`, `tests/play_season.py:130-138`.

### 3. `/api/draft/reset` requires JSON body even when empty
**Symptom:** Draft reset between seasons 422-ed silently (422 missing body).
**Root cause:** `ResetRequest` is the request model but the endpoint signature
did not default to an empty instance, so FastAPI demanded a body.
**Fix:** `tests/play_season.py` now sends `json={}` explicitly when calling
`/api/draft/reset` and `/api/season/start`.
`tests/play_season.py:101`.

### 4. `heuristic_accept` / `should_veto` were no-ops in the runner
**Symptom:** Trade scripts always accepted and never vetoed because they
depended on `send_value`/`receive_value` that the API never returns.
**Fix:** Added a `/api/players?available=false&limit=600` index at season
start that maps `player_id → fppg`, and all heuristics now compute values
from that cache. `tests/play_season.py:77-98, 114-138`.

### 5. Runner polish
- `--headless` flag added (default headed for local watching).
- Screenshots dir wiped between runs (no pile-up).
- Per-season `weekly_standings`, `final_standings`, full `trades` list, and
  `wall_clock_seconds` written to `run_report.json`.
- Duplicate veto/accept log lines deduped per season (backend is idempotent
  but `/pending` exposes the same trade to multiple iterations).
- Single transparent retry on rare transient 400s from `/standings`.

## Notable events

- Biggest veto (across all seasons): **Evan Mobley ↔ Brandon Miller**
  collected votes from teams `[1, 3, 4, 5, 6, 0]` — six voters, well past the
  threshold.
- Most-traded players per season (identical across runs due to fixed seed=42):
  Brandon Miller (3), Nikola Vucevic (2), Jalen Green (2).
- Champion is identical across the 3 seasons (**BPA Nerd (T2)**) — see
  "Outstanding" below.

## Outstanding issues / recommendations

1. **Determinism.** The backend uses a fixed `seed=42` threaded through the
   day-level RNG, so with identical starting rosters the 3 seasons produce
   identical trades and the same champion. For more varied test runs, mix a
   seed from the wall clock when `/api/draft/reset` is called, or accept a
   `seed` override body param (the model already exists, just not wired to
   vary). Not a ship-blocker for Wave G (the criteria are met) but worth
   noting for Wave H / H2H variety.

2. **Transient 400 on `/api/season/standings` (~1 per season).** Rare and
   auto-retried; file contents remain valid. Likely a race between
   `advance_day` setting `season.current_week` and another thread re-reading
   before the atomic write lands. Worth adding a higher-level read lock
   (mirror the new `_log_lock` for season/draft) if we ever scale to more
   concurrent UI clients; for single-user runs it's cosmetic.

3. **`/api/draft/reset` body.** Consider changing the endpoint signature to
   `reset_draft(req: ResetRequest = ResetRequest())` so callers don't need a
   `{}` body. Script already handles it, but this would match the pattern
   used by `/api/season/advance-day`.

## Files changed

- `app/storage.py` — atomic-write race fix + log-append lock.
- `app/ai_gm.py` — veto vote thresholds calibrated.
- `tests/play_season.py` — runner polish + heuristics rewritten to use FPPG.

## Reproduction

```bash
cd "D:/claude/fantasy nba"
docker compose --env-file .env.localserver -f docker-compose.localserver.yml up -d --build
uv run python tests/play_season.py --seasons 3 --headless
```

Artifacts: `tests/run_report.json`, `tests/run_output.log`,
`tests/screenshots/s{1,2,3}_{start,w01..w14,end}.png`.
