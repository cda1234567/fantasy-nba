# ITER5_O1 — v0.5.12 Production Validation (2026-04-18)

Observer: O1 · Iteration 5 · Target: v0.5.12 (Iter4 fixes)
Production URL: https://nbafantasy.cda1234567.com
Server reports: `{"ok":true,"version":"0.5.12","league_id":"default","ai_enabled":true}`

---

## Executive Summary

**Verdict: BLOCKER — v0.5.12 frontend is NOT deployed.** Same stale-bundle failure mode as Iter3 O1.

| # | Test | Result | Key signal |
|---|------|--------|------------|
| 1 | advance-week < 10 s (E1 async) | **FAIL** | Season already past regular season; a fresh direct-`curl` advance-week against the live state took **25 s and returned 502**. Under a different pre-condition (stuck day 140) the endpoint returns 200 in 0.7 s but is a no-op silently. |
| 2 | Counter-offer UX (E2) | **PARTIAL — backend OK, UI missing** | Backend correctly produces `counter_of` on the pending trade (proof: trade `1a4589…` with `counter_of: 02164ec5…`). Frontend DOM shows NONE of `查看原提議`, `↩ 還價`, toast text. |
| 3 | Week-recap browser (E3) | **PARTIAL — API OK, UI missing** | `/api/season/week-recap?week=3` returns `logs_trimmed: true`; week 19 returns full payload. But `onShowWeekRecap` is `undefined` on `window` in the deployed bundle → overlay never renders. |
| 4 | Lineup override invalidation (E4) | **FAIL — endpoint 500s** | `POST /api/season/lineup` with a demonstrably valid 10-starter payload returns **500 Internal Server Error**. Cannot proceed to test invalidation flow. |

### Root cause (single blocker covering 3 of 4 findings)

Deployed `/static/app.js` is **89,516 bytes** while repo `static/app.js` is **129,851 bytes (3417 lines)**. grep on the deployed bundle for the v0.5.4–v0.5.12 feature strings yields:

| String | Deployed matches | Repo matches |
|---|---|---|
| `onShowWeekRecap` | **0** | 5 |
| `查看原提議` | **0** | 2 |
| `手動陣容已失效` | **0** | 1 |
| `logs_trimmed` | **0** | 1 |
| `counter_of` | **0** | many |
| `還價` | **0** | many |
| `recap` | **0** | many |
| `lineup_override` | **0** | many |

The container is serving a pre-v0.5.4 frontend bundle; the backend is v0.5.12. `docker_localserver.ps1` rebuild / image-push must be re-run on the server with the repo's `static/` copied in (same pattern as `project_setu_deployment` memo: changing `app.js` without re-bundling and re-deploying is invisible to users).

### Secondary bug discovered (NEW)

**`POST /api/season/lineup` returns 500 even when starters are valid.** Known-good payload: the 10 IDs that the `/api/teams/0` endpoint itself reports as the currently-assigned slot rows. This blocks the lineup-override feature entirely, regardless of the frontend issue.

### Season-state observation (side-effect)

Direct API calls show the season is **stuck at week 20 / day 140 / is_playoffs:false / champion:null**. `advance-day` and `sim-to-playoffs` both return 200 but are no-ops (see `app/season.py:604-605` — `if week > reg_weeks: return season`). Regular season finished at day 140 but the playoff-transition path never fires. Existing bug, surfaces now that the season data is persisted at this exact boundary.

---

## Test run log

Script: `tests/iter5_o1_run.py` (196 lines, Python + Playwright sync API)
Driver: Chromium headless, viewport 1400×900
Artifacts: `tests/iter5_artifacts/*.png`, `tests/iter5_artifacts/results.json`, `tests/iter5_artifacts/console.log`
Raw log: `tests/iter5_o1_run.log`

### Test 1 — Advance-week < 10 s

**Expected:** v0.5.12 E1 async fix (`6d962aa perf(v0.5.12): advance-week async + timeout`) should let one week of sim finish inside the Cloudflare gateway (~15 s) window, ideally < 10 s.

**Observed (two runs at different pre-conditions):**

Run A — before the test harness noticed the season was past regular-season:
```
POST /api/season/advance-week   status=502   total=25.277s
```
Week did advance (19 → 20) despite the 502 — backend completed after the gateway timed out. Same pattern as Iter3. The async/gather fix halved the work but still exceeded gateway timeout.

Run B — with season stuck at day 140 / week 20:
```
elapsed=0.69s status=200 pre_week=20 post_week=20 pre_day=140 post_day=140 advanced=false
```
Fast response because the advance_day loop short-circuits (`app/season.py:604` `if week > reg_weeks: return season`). Not a real success.

**Verdict:** E1 did not fully fix the >10 s gateway timeout. Also surfaced a secondary stuck-state bug where the season cannot progress into playoffs via `advance-week` / `advance-day` / `sim-to-playoffs`.

**Reproduction:**
```bash
curl -X POST https://nbafantasy.cda1234567.com/api/season/advance-week \
  -H 'Content-Type: application/json' -d '{}' --max-time 60
# When server has meaningful work: 502 around 25 s
# When season is stuck post-regular: 200 in <1 s, no state change
```

### Test 2 — Counter-offer UX

**Expected (per v0.5.12 E2):**
- (a) Blue info toast `AI 還價：<team>` fires when a pending trade arrives with `counter_of != null`.
- (b) Pending trade card shows `這是對你原始提議的還價` banner with `查看原提議 #xxxx` button.
- (c) Trade history shows bidirectional chips: `↩ 還價自 #xxxx` on counter, `→ 已被還價 #yyyy` on the original.

**Observed:**

Proposed unreasonable trade:
```
giving Ty Jerome (33.3 FPPG) for Luka Dončić (56.4 FPPG) → team 4 (Balanced Builder)
proposed trade id: 02164ec5ab2547898d1e6e77047ee741
```

Polling `/api/trades/pending` picked up a counter within ~10 s:
```json
{
  "id": "1a4589144ea94248969d8a662ed721a4",
  "counter_of": "02164ec5ab2547898d1e6e77047ee741",
  ...
}
```

**Backend: PASS** — `counter_of` is populated correctly. The Iter3-era bug (send/receive ID swap + swallow) is fixed.

**Frontend: FAIL** — Navigating to `/#trades` and scanning `document.body.innerText`:
- `查看原提議`: **not present**
- `還價` / `↩ 還價` / `還價自`: **not present**
- `這是對你原始提議的還價`: **not present**

Reason: deployed `/static/app.js` contains **zero** occurrences of any of those strings (grep count = 0). Repo bundle has them on lines 2270, 2274, 2336, 2486, 2568, etc.

### Test 3 — Week-recap browser

**Expected:** Click `📅 週報`, overlay opens with prev/next arrows; navigating to older weeks shows `舊週資料已清理，僅保留比分與對戰記錄` notice when `logs_trimmed=true`.

**Observed:**

Backend API verified working:
```bash
curl "…/api/season/week-recap?week=19" → logs_trimmed:false, top_performers: 5 entries
curl "…/api/season/week-recap?week=3"  → logs_trimmed:TRUE  (older week)
```

Frontend: `typeof onShowWeekRecap` on both `/` and `/#season` returns **"undefined"**. The `📅 週報` button is not in the rendered DOM (body text scan shows draft-phase UI with `選秀完成` — see Test 4 note about season-stuck state). Calling `onShowWeekRecap(19)` via page-context evaluate throws; overlay never renders.

Also confirmed `onAdvanceWeek`, `render`, `state`, `api`, `refreshState` ARE defined on window — so it's not a script-load failure; it's specifically the v0.5.6+ block that's missing from the deployed bundle.

### Test 4 — Lineup override invalidation

**Expected:** Set override → inject injuries that break feasibility → see toast `你的手動陣容已失效，已恢復自動`.

**Observed:**

Could not set override. Known-good payload (the same 10 IDs `/api/teams/0` returns as `lineup_slots`):
```bash
curl -X POST https://nbafantasy.cda1234567.com/api/season/lineup \
  -H 'Content-Type: application/json' \
  -d '{"team_id":0,"starters":[1630178,1627759,202695,1628374,203999,1642270,201939,1630166,1629645,202710],"today_only":false}'

→ HTTP 500  "Internal Server Error"
```

Roster & slot assignment verified feasible (10 unique IDs, matching the server's own slot rows, positions PG/SG/SF/PF/C/C/G/F/UTIL/UTIL). No response body beyond the bare 500; no validation error returned. This is a separate server-side bug that was **not** present when the Iter4 fix was authored.

Additionally `onShowWeekRecap`-style strings (`手動陣容已失效`) are absent from the deployed frontend → even if the 500 were fixed, the user-facing toast cannot fire.

---

## Timings

| Phase | Elapsed |
|---|---|
| Full script wall-clock | 42.4 s |
| Direct curl advance-week (live backend work) | 25.3 s → 502 |
| Direct curl advance-week (stuck state) | 0.7 s → 200 no-op |
| Counter-offer round-trip (propose → counter detected in pending) | ~10 s |

---

## Recommended fixes (priority order)

1. **[BLOCKER] Rebuild container image and redeploy.** `static/app.js` in the container image must match the repo (129,851 bytes, 3417 lines). Follow the same `docker_localserver.ps1` pattern noted in CLAUDE.md memory; do not hand-edit the running container's file system. Confirm with:
   ```bash
   curl -s https://nbafantasy.cda1234567.com/static/app.js | wc -c   # expect 129851
   curl -s https://nbafantasy.cda1234567.com/static/app.js | grep -c onShowWeekRecap   # expect >=1
   ```
2. **[P0] Fix `POST /api/season/lineup` 500** when payload is valid. Needs a server log stack trace — likely a KeyError or assertion in `set_lineup_override` at `app/main.py:627` when running against the persisted day-140 state. Repro above.
3. **[P0] Fix stuck post-regular-season state.** When `season.current_day % DAYS_PER_WEEK == 0` and `season.current_week == reg_weeks`, `advance_day` silently returns (`season.py:604`). Need to kick off playoffs automatically, or let `sim_to_playoffs` / `sim_playoffs` take over (currently also returns in 0.6 s as no-op from the same guard).
4. **[P1] E1 async fix did not eliminate gateway timeouts.** A single advance-week still exceeds 25 s under realistic data (502 observed). Consider: chunking the 7-day loop server-side into 2 HTTP calls; stream progress via SSE; or run advance-week in a BackgroundTasks with status polling (same pattern as `/api/trades/propose` at `main.py:1109`).

---

## Files touched

- `tests/iter5_o1_run.py` — playwright harness (NEW, 196 lines)
- `tests/iter5_o1_debug.py` — DOM probe script (NEW, ~35 lines)
- `tests/iter5_o1_run.log` — raw stdout from harness runs
- `tests/iter5_artifacts/` — screenshots + console log + results.json

No application source files were modified.
