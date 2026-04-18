# ITER5_O2 -- Deep Code Audit (Commits 6d962aa, 06f76c7, 126974e, f25d9ce)

Observer O2 - Iteration 5 - 2026-04-18

---

## Top 3 Urgent Fixes

### 1. [CRITICAL] asyncio.run() inside uvicorn event loop -- every advance-day/week call will crash

**File:** `app/season.py:386`

**Bug:** `_set_lineups()` calls `asyncio.run(_gather_decisions())` at line 386. This
function is invoked from `advance_day()` (line 613), which is called from the sync
FastAPI endpoint `season_advance_day_endpoint` (`main.py:485`) and
`season_advance_week_endpoint` (`main.py:496`). The app runs under **uvicorn** (ASGI),
which already has a running asyncio event loop.

`asyncio.run()` raises `RuntimeError` when called from within a running event loop:

```
RuntimeError: asyncio.run() cannot be called from a running event loop
```

This means **every advance-day and advance-week call with AI enabled will crash** as
soon as there is at least one AI team to process. The feature is completely broken in
production.

**Repro:** Start a season with AI enabled, advance one day. Server returns 500.

**Fix:** Replace `asyncio.run()` with `concurrent.futures.ThreadPoolExecutor` directly,
since `decide_day` is synchronous and the only goal is parallelism across threads:

```python
from concurrent.futures import ThreadPoolExecutor, as_completed

with ThreadPoolExecutor(max_workers=len(ai_teams)) as pool:
    futures = {
        pool.submit(ai_gm.decide_day, t, ...): t
        for t in ai_teams
    }
    decisions = [(futures[f], f.result()) for f in as_completed(futures)]
```

Alternative: make `_set_lineups` and `advance_day` async and use `await` all the way
up, but that cascades changes to the endpoints. ThreadPoolExecutor avoids this entirely.

---

### 2. [HIGH] Anthropic SDK path ignores _TIMEOUT=6.0 -- timeout reduction only applies to OpenRouter

**File:** `app/llm.py:84-96`

**Bug:** The `_TIMEOUT` was reduced from 20s to 6s in commit 6d962aa, but the
`_call_anthropic()` path constructs `anthropic.Anthropic(api_key=api_key)` at line 84
without passing a `timeout` parameter. The Anthropic SDK default timeout is **600
seconds** (10 minutes). Only the OpenRouter path uses `_TIMEOUT` via
`httpx.Client(timeout=_TIMEOUT)` at line 144.

When `ANTHROPIC_API_KEY` is set and `FORCE_OPENROUTER` is not `1`, all Claude model
calls go through the Anthropic SDK path with a 600s timeout. The commit message says
reduce LLM timeout from 20s to 6s but this only applies to the OpenRouter path.

Since the `asyncio.run()` bug in Fix #1 will crash before reaching the LLM call
anyway, this is currently masked. Once Fix #1 is resolved, a hung Anthropic API call
will block for up to 10 minutes per thread.

**Repro:** Set `ANTHROPIC_API_KEY`, unset `FORCE_OPENROUTER`, simulate a slow API
response. The 6s timeout does not fire.

**Fix:** Pass the timeout to the Anthropic client constructor:

```python
client = anthropic.Anthropic(
    api_key=api_key,
    timeout=_TIMEOUT,
)
```

---

### 3. [MEDIUM] lineup_override_alerts list is never bounded -- grows forever across season

**File:** `app/models.py:169` + `app/season.py:348-352`

**Bug:** Every time `_set_lineups` detects an invalid override for the human team, it
appends a dict to `season.lineup_override_alerts` (line 348-352). The list is only
cleared when the UI calls `DELETE /api/season/lineup-alerts` (`main.py:700`). If the
user never opens the UI, or the UI fetch fails silently, or the user has repeated
injury churn on their starters, the list grows without bound.

Over a 98-day season with daily injury rolls, a user who ignores alerts could
accumulate many entries. Each dict is small (~3 fields), so this is not a memory
crisis, but it bloats the JSON save file and the alerts endpoint returns stale
historical alerts that are no longer actionable.

**Repro:** Set a 10-player override, then advance 20+ days without opening the UI.
Inspect season.json -- `lineup_override_alerts` may have many entries.

**Fix:** Cap the list to the last N entries (e.g., 10) when appending:

```python
season.lineup_override_alerts.append({...})
season.lineup_override_alerts = season.lineup_override_alerts[-10:]
```

Or clear after the first successful UI fetch (already implemented via DELETE, but
add a server-side cap as a safety net).

---

## Top 5 Feature / UX Ideas (by impact)

1. **ThreadPoolExecutor progress indicator** -- Once Fix #1 lands, the parallel AI
   decisions could report per-team completion progress to the frontend via SSE or a
   polling status endpoint, so the user sees 5/7 AI teams decided instead of a spinner.

2. **Recap snapshot persistence** -- Store a week-recap summary object at week
   resolution time (in `_resolve_week`) so that older recaps retain full top-performer
   data even after `game_logs` are trimmed. The current `logs_trimmed` notice is a band-aid.

3. **Counter-offer chain visualization** -- The counter-offer UX links work well for
   single counter-offers. Add a visual thread/chain view for multi-round negotiations
   (counter of a counter) so the user can follow the full negotiation arc.

4. **Recap history keyboard navigation** -- The prev/next week buttons in the recap
   overlay could respond to left/right arrow keys for faster browsing.

5. **Lineup override conflict detail** -- The current toast says the override was
   invalidated but does not say which player caused the invalidation (e.g.,
   LeBron James is now OUT). Include the injured player name in the alert dict.

---

## Code Smells

| # | Smell | Location | Severity |
|---|-------|----------|----------|
| 1 | `asyncio.run()` inside ASGI event loop -- will crash at runtime; see Fix #1 | season.py:386 | CRITICAL |
| 2 | Anthropic SDK timeout not set -- `_TIMEOUT` only affects OpenRouter path | llm.py:84 | HIGH |
| 3 | `decide_day_async` wraps sync `decide_day` in `asyncio.to_thread` but never called from working async context | ai_gm.py:116-130 | MEDIUM |
| 4 | `lineup_override_alerts` unbounded append with no server-side cap | season.py:348, models.py:169 | MEDIUM |
| 5 | Counter-offer toast fires for all existing counters on first page load -- `state.tradesPending` undefined on init | app.js:2153-2160 | MEDIUM |
| 6 | `scrollToHistoryTrade` silently no-ops if `refreshTradeHistory` API call fails | app.js:2626-2636 | LOW |
| 7 | `state.tradesHistory.find()` in `buildTradeHistoryRow` is O(n) per row = O(n^2) total | app.js:2493, 2549 | LOW |
| 8 | `_gather_decisions` closure defined inside `_set_lineups` on every call | season.py:371 | LOW |
| 9 | Recap nav edge case: `currentWeekNumber()` returns 1 on week 1 making `maxWeek=0`, both buttons disabled | app.js:3140-3141 | LOW |

---

## Focus Area Analysis

### 1. Race conditions in asyncio.gather loop

**Verdict: Moot due to asyncio.run() crash (Fix #1), but if fixed:**

The `asyncio.to_thread` approach runs each `decide_day` in a separate OS thread.
The shared state passed to each thread includes:

- `fa_top_20` (list): read-only, safe.
- `season.standings` (dict): read-only during lineup phase, safe.
- `injured_out` (set): built before the loop, read-only, safe.
- `draft.players_by_id` (dict): read-only, safe.
- `team.roster` (list): each team has its own roster, safe.

The `_heuristic` method uses `sorted()` (no shared RNG). The `_call_api` path creates
new `httpx.Client` or `anthropic.Anthropic` instances per call, so no shared HTTP state.

**No race condition in the data paths.** Each `decide_day` reads shared state but only
writes to a returned dict. Thread-safe.

### 2. LLM timeout fallback correctness

When `_TIMEOUT=6.0` fires on the **OpenRouter path**, `httpx.TimeoutException` is
caught at `llm.py:155-156` and re-raised as `LLMError`. In `ai_gm.py:107`,
`LLMError` is caught and falls back to `_heuristic()`. This chain is correct --
timeout gracefully falls to heuristic with no swallowed exception.

On the **Anthropic SDK path**, there is no timeout configured (see Fix #2). A hung
call will block indefinitely. If the SDK eventually raises, the generic `except
Exception` at `llm.py:101` converts it to `LLMError`, which triggers the heuristic
fallback. But a truly hung call blocks the thread.

### 3. lineup_override_alerts unbounded

Confirmed. See Fix #3. Bounded by ~98 days x 1 human team = 98 max entries in the
worst case. Not a crisis but poor hygiene.

### 4. scrollToHistoryTrade with async history panel

The implementation is correct in the happy path: `await onToggleTradeHistory()` waits
for `refreshTradeHistory()` to complete (which fetches and renders history), then
`renderTradeHistoryBody(body)` re-renders with the target expanded, then
`querySelector` finds the row. The `await` properly sequences the operations.

**Edge case:** If the API call in `refreshTradeHistory` fails, `apiSoft` returns null,
`hist` becomes `[]`, and the target row will not exist. The `if (row)` guard at
line 2636 prevents a crash, but the user gets no feedback.

### 5. Recap history browser boundary checks

- **week=0:** The recap button guards with `if (w >= 1)`. The prev button disables at
  `week <= 1`. The server validates `ge=1` (main.py:869). **Safe.**
- **week > max:** The next button disables at `week >= maxWeek`. The server returns 404
  for unresolved weeks. **Safe.**
- **week = currentWeek (in progress):** `maxWeek = currentWeek - 1` prevents
  navigating to the current unresolved week. **Correct.**

### 6. Int-key migration in _load_or_init_season

The migration at `main.py:139-148` now covers all int-keyed dicts:
- `standings` (line 139)
- `lineups` (line 140)
- `injuries` (line 141)
- `lineup_overrides` (line 142)
- `lineup_override_today_only` (line 143)
- `ai_models` (line 148)

This is comprehensive. Old saves with string keys (from JSON serialization) will be
correctly converted to int keys on load. The migration is idempotent. **Correctly
implemented.** This resolves O2 Code Smell #6 from ITER3.

---

## Verdict

The v0.5.12 commits add well-structured features: parallel AI decisions, counter-offer
UX with toast notifications and history linkage, week recap browsing with trimmed-data
notices, and lineup override alerts with proper int-key persistence fixes.

However, **commit 6d962aa contains a critical runtime crash**: `asyncio.run()` cannot
be called from within uvicorn's already-running event loop. This means the entire
advance-day and advance-week flow is broken when AI teams are present -- the most
common production scenario. The feature was likely tested in a standalone script or
unit test context but not under the actual uvicorn ASGI server.

Secondary concern: the `_TIMEOUT=6.0` reduction only applies to the OpenRouter HTTP
path; the Anthropic SDK path retains a 600-second default timeout, undermining the
stated goal of faster fallback to heuristic.

**Recommendation:** Fix #1 is a **hard blocker** -- replace `asyncio.run()` with
`concurrent.futures.ThreadPoolExecutor` before any deployment. Fix #2 should ship
alongside it to ensure the timeout behavior matches the commit intent. Fix #3 is
a minor hygiene improvement that can ship in a follow-up.
