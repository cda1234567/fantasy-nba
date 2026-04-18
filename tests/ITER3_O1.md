# ITER3_O1 — Black-box Full-season Shakedown (2026-04-18)

Observer O1 · Iteration 3 · Target: v0.5.6 · Actual deployed: v0.5.10 (mid-test redeploy)

Production URL: https://nbafantasy.cda1234567.com

---

## Executive Summary

1. **DEPLOYMENT BLOCKER** — The deployed `/static/app.js` is **86,647 bytes (stale)** while the repo's current `static/app.js` is **123,330 bytes (3332 lines)** and contains all three v0.5.6 features. The container is serving an old frontend bundle even though `/api/health` reports `v0.5.10`.
2. All three v0.5.6 features are **completely absent at runtime**: no weekly-recap modal fires on `推進一週`, no `手動陣容` / `設定先發陣容` UI on team view, no `↩ 還價` badge in trade history. These features exist in the source but not in what users see.
3. `/api/season/advance-week` consistently **504 Gateway Timeouts** when a pending trade queue is large, and the week advance silently fails. The simulator is effectively unusable for a full 16-week run today.

**Verdict: BLOCKERS — not ship-ready until the frontend bundle is actually redeployed and the advance-week hang is fixed.**

---

## 0. Version confirmation

| Check | Result |
|-------|--------|
| `/api/health` version at test start | `0.5.6` |
| `/api/health` version mid-test | `0.5.10` (container hot-swapped during shakedown) |
| Deployed `/static/app.js` size | 86,647 bytes |
| Repo `static/app.js` size | 123,330 bytes (3332 lines) |
| `recap` matches in deployed app.js | **0** |
| `戰報` / `週戰報` in deployed app.js | **0** |
| `手動陣容` / `設定先發` in deployed app.js | **0** |
| `還價` / `counter_offer` in deployed app.js | **0** |
| Same strings in repo's `static/app.js` | **present on lines 1340, 1346, 2299, 2302, 2304, 3028, 3069, 3234, etc.** |

→ The deployed JS bundle has not been refreshed to match the source. This is the exact "setu_deployment" bundle-merge issue from CLAUDE.md memory — frontend asset is stale on the server.

---

## 1. Weekly recap modal (v0.5.6 flagship) — **BROKEN (not shipped to prod)**

**Expected:** On each `推進一週` click, a modal with
- `第 N 週戰報` title
- Top 5 performers list
- Matchup list with scores
- Biggest blowout / closest game cards

**Observed (black-box):**
- Clicked `推進一週` 5+ times across multiple sessions.
- **No modal ever rendered**, no `戰報` string ever appeared in DOM, no `position: fixed` overlay >300×200 with z-index >10 at recap time.
- `MutationObserver` on `document.body` during the click captured zero modal/recap/overlay node insertions.
- Probed recap endpoints `/api/season/recap`, `/api/season/weekly-recap`, `/api/season/recap/1`, `/api/recap`, `/api/weekly_recap` — **all 404**.
- `/api/season/standings` returns `current_week` but no recap payload.

**Root cause signal:** deployed bundle has zero `recap` occurrences (grep returned 0); repo has 3 `戰報` occurrences on lines 3028/3069/3234 inside a clearly-formed recap render path. The JS that would open the modal is not on the server.

**Status:** **Broken in prod. Source code exists (fa63b46) but not deployed.**

---

## 2. Lineup override (v0.5.4) — **BROKEN (not shipped to prod)**

**Expected:**
- `手動陣容` badge on my team when a manual lineup is set.
- `設定先發陣容` button.
- Per-slot `換` button to swap starters.

**Observed (black-box) on `#teams → 我的隊伍`:**
- No `手動陣容` badge. No `設定先發陣容` button. No per-slot `換` button. DOM scan of `tr.slot-row` shows only position label / name / pos-tag / FPPG / team — **no swap button in cell**.
- Probed lineup endpoints `/api/lineup`, `/api/lineup_override`, `/api/set_lineup`, `/api/teams/0/lineup`, `/api/roster/0` — all 404.
- `/api/state` roster for `team_id=0` returns keys `[id, name, is_human, gm_persona, roster]` — no `lineup_override` / `manual_lineup` flag.

**Root cause signal:** deployed app.js has zero `手動陣容` / `設定先發` strings; repo has them on lines 1340, 1346, 1386, 1540. Same stale-bundle problem.

**Corroborating O2 finding:** Even once deployed, `app/season.py:309-316` silently falls back to auto-lineup when injuries reduce valid starter count, and does NOT clear `season.lineup_overrides`, so the badge would lie. (Fix needed per O2 report.)

**Status:** **UI entirely absent in prod. Backend present (v0.5.4) but has the O2 silent-fallback bug.**

---

## 3. AI counter-offer `↩ 還價` badge (v0.5.5) — **BROKEN (feature silently fails even when deployed)**

**Expected:** Trades in the pending list or history show a `↩ 還價` badge when they are AI counter-offers, with status `countered` / `已還價`.

**Observed (black-box):**
- 20+ trades accumulated in `近期交易紀錄`. Every entry labelled either `已完成`, `已拒絕`, or `已過期`. **No `已還價` / `↩ 還價` anywhere in DOM.**
- Expanded full history — scanned text for `還價` / `↩` — zero matches.

**Root cause signal:** deployed app.js has zero `還價` / `counter` occurrences; repo has the render logic on lines 2299-2304 (`'countered': '已還價'`, `↩ 還價` template literal) and 2446.

**Corroborating O2 finding:** Even if deployed, `app/trades.py:396-400` + `app/ai_gm.py:599-602` swap send/receive IDs, so every counter attempt raises `ValueError` inside `propose()` and is swallowed by the bare-except at `trades.py:407`. The original trade is already moved to history as `countered` before the try block, so the trade disappears with no counter materializing. (Fix needed per O2 report.)

**Status:** **Badge missing in prod AND backend is buggy.** Double failure.

---

## 4. Console errors captured

All from `static/app.js:127` (generic `api()` throw path):

| Time | Error | Origin | Severity |
|------|-------|--------|----------|
| 00:05:35 | `Error: 504` | `onAdvanceWeek` at 2426 | **CRITICAL** |
| 00:27:17 | `Error: It's the human's turn` | `onAdvance` at 2353 | expected (mis-clicked advance during draft) |
| 00:29:57 | `Error: 502` | `onAdvanceWeek` at 2426 | **CRITICAL** (during mid-test redeploy) |
| 00:31:19 | `Error: 504` | `onAdvanceWeek` at 2426 | **CRITICAL** |
| 00:34:00 | `Error: 504` | `onAdvanceWeek` at 2426 | **CRITICAL** |
| 00:34:45–47 | 4× `Error: Unknown trade_id` | `onRejectTrade` at 2072 | **HIGH** (stale trade IDs after reload) |
| 00:34:58 | `Error: 504` | `onAdvanceWeek` at 2426 | **CRITICAL** |

### 504/502 Gateway Timeout on `POST /api/season/advance-week`

- The endpoint does not return within the Cloudflare/Caddy gateway timeout when many pending trades / day-advances queue up.
- Reproduction: accumulate 6+ pending trades, click `推進一週`, wait. Server never responds; renderer freezes mid-fetch.
- When AbortController aborts at 15s, the request is killed client-side but server likely keeps processing — subsequent state reads show week jumped by multiple weeks (e.g. 9 → 19 after what should have been a 1-week advance), indicating the work did complete server-side but too slowly for HTTP.

### `Unknown trade_id` on reject

- After a full-page reload with a trade loaded from an earlier in-memory state, clicking `拒絕` hits `/api/trades/{trade_id}/reject` with a trade_id the server no longer recognizes. Frontend should re-fetch pending trades on load before offering action buttons.

---

## 5. UX friction points

- **Advance-week feels broken.** User clicks `推進一週`, button spinner, then 15–45 s later a toast appears with `Error: 504`. The week sometimes *did* advance (inconsistent), sometimes didn't. No user-visible signal what actually happened.
- **Pending trades drown the league view.** With AI proposing 4–6 trades per day, the `待處理交易` block pushes standings / matchups below the fold. No "reject all" button; user has to reject one at a time with ~500 ms between clicks or hit stale-ID errors.
- **`模擬到季後賽` does not reach the playoffs.** Clicked it once, week moved 17 → 19 (2 weeks) in 25 s — not the 20-week regular season target. No progress indicator. User cannot tell if the button is paused, hung, or finished.
- **Draft column mapping confusing.** The draft board shows my team in a middle column during snake draft (e.g. "Vet Win-Now" visible), but on the post-draft team page I'm column 1 (`我的隊伍 (你)`). The `*` next to `我的隊伍` is only explanation; easy to mis-read as "star team" rather than "you".
- **No season summary observed.** Never reached the end of the season to verify the `v0.5.1` 冠軍賽季總結 overlay, due to advance-week failures.
- **Mid-test container hot-swap.** `/api/health` version flipped from 0.5.6 → 0.5.10 at ~00:29, and the in-memory season state reset back from Week 14 → Week 9 on reload. Simulator is not durable across redeploys; there should be a "season resumed from disk" banner or a warning.

---

## 6. Verdict

**Status: BLOCKERS — Do not ship v0.5.6+ claiming these features.**

### Blockers (must fix before user testing)

1. **Deploy the real frontend bundle.** Deployed `/static/app.js` is 86 kB; repo is 123 kB. None of the v0.5.4, v0.5.5, v0.5.6 UI code is reaching the browser. This is the "setu_deployment" bundle-merge pattern — the static asset needs to be rebuilt/copied into the container image.
2. **Fix `POST /api/season/advance-week` timeouts.** The endpoint routinely exceeds the gateway's ~15 s budget. Either: (a) run the week in the background and poll, (b) stream progress via SSE, or (c) chunk into daily advances client-side. The current sync loop is not production-viable.
3. **Fix counter-offer ID swap** (O2 #1). Even once deployed, every AI counter silently disappears because of the send/receive ID bug in `app/trades.py:396-400`.

### Needs polish (after blockers)

4. Lineup-override silent fallback (O2 #2) — clear `lineup_overrides` and surface `lineup_override_warning` when injuries force auto.
5. Week-recap top_performers empty for older weeks (O2 #3) — game_logs trimmed before recap can fetch.
6. `Unknown trade_id` on reject after reload — re-fetch pending trades on mount before enabling action buttons.
7. Add a "Reject all" button for pending trades when AI proposal volume is high.
8. Progress indicator for `模擬到季後賽` and a durable season banner after container restart.

### What I could NOT test (blocked by above)

- Full 16-week shakedown — advance-week hangs prevented completion.
- Season summary overlay at season end.
- Weekly recap content accuracy (Top 5 / blowout / closest game) — UI never rendered.
- Lineup override behaviour under injuries — UI absent.
- Counter-offer visual badge + negotiation loop — UI + backend both broken.
