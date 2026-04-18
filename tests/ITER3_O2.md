# ITER3_O2 -- Deep Code Audit (Commits 8df34c3, e594193, fa63b46)

Observer O2 - Iteration 3 - 2026-04-18

---

## Top 3 Urgent Fixes

### 1. [CRITICAL] Counter-offer send/receive IDs are swapped -- every counter silently fails

**File:** `app/trades.py:396-400` + `app/ai_gm.py:599-602`

**Bug:** `maybe_counter()` returns `send_player_ids` and `receive_player_ids` from the
**original trade perspective** (send = original sender players, receive = AI players).
But `auto_decide_ai` calls `propose()` with `from_team=trade.to_team` (AI) and passes
`send_ids=counter_dict[send_player_ids]` -- which are the **original sender (Human) players**.

`propose()` validates `send_ids` against the new `from_team` (AI) roster at line 174-176.
Human player IDs will not exist on the AI roster, raising ValueError. The exception is
caught at line 407, logged to stderr, and swallowed. The original trade is already moved
to history as countered (line 391-393, **before** the try block), so the trade vanishes --
marked countered with no counter-offer ever created.

**Repro:** Any AI counter-offer attempt. The 30% trigger fires, original trade disappears,
no counter trade materializes.

**Fix:** Swap the IDs when calling `propose()`:

```python
counter_trade = self.propose(
    from_team=trade.to_team,
    to_team=trade.from_team,
    send_ids=counter_dict[receive_player_ids],   # AI players (now the sender)
    receive_ids=counter_dict[send_player_ids],    # Human players (now the receiver)
    ...
)
```

OR fix `maybe_counter()` to return IDs from the counter-proposer perspective.

---

### 2. [HIGH] Lineup override silently ignored when injured players reduce valid count -- no user notification

**File:** `app/season.py:309-316`

**Bug:** When `_set_lineups` applies the human override, it filters out injured/dropped
players. If `len(valid) < lineup_sz`, it falls back to `default_lineup` silently. The user
sees the manual-lineup badge but their override was not applied. There is no mechanism to:

- Notify the user their override was overridden
- Update `lineup_overrides` to reflect the fallback
- Show which players were dropped from the override

**Repro:** Set a 10-player override, then one starter gets injured, then advance day.
Lineup silently reverts to auto, but badge still shows manual because `lineup_overrides`
dict still has the stale entry.

**Fix:**

1. When fallback triggers, clear the override from `season.lineup_overrides` (or set a flag).
2. Return a `lineup_override_warning` field from the `/api/teams/{team_id}` response.
3. In `get_team()` (main.py:367-370), `has_override` is set to True based on the raw
   override existing -- not on whether it was actually applied.

---

### 3. [HIGH] Week-recap returns empty top_performers for older weeks due to game_logs trimming

**File:** `app/season.py:598-602` + `app/main.py:787-788`

**Bug:** `advance_day()` trims `game_logs` to keep only the last 3 weeks:

```python
keep_from_week = max(1, week - 2)
season.game_logs = [g for g in season.game_logs if g.week >= keep_from_week]
```

But `season_week_recap()` queries `game_logs` for any requested week:

```python
week_logs = [g for g in state.game_logs if g.week == week and g.played]
```

Requesting recap for week 1 when the season is at week 5 returns an empty
`top_performers` list. The endpoint returns 200 with hollow data.

**Repro:** Advance to week 5+ then call GET /api/season/week-recap?week=1.
`top_performers` is [].

**Fix:** Either:

- Store weekly recap snapshots at week resolution time, OR
- Add a guard: if week_logs is empty but week_matchups exist, return a note, OR
- Do not trim game_logs for completed weeks that have not been recapped yet.

---

## Top 5 Feature / UX Ideas (by impact)

1. **Override conflict notification** -- When a lineup override cannot be fully applied
   (injury/trade), surface a toast or badge warning so the user knows.

2. **Counter-offer accept/reject UI for human** -- Counter-offers land as pending_accept
   trades targeting the human, but the UI has no dedicated accept/reject flow for counters.

3. **Week recap history browser** -- Add prev/next arrows on the recap modal so users
   can revisit past week recaps. Currently only the just-completed week auto-shows.

4. **Lineup override per-day vs persistent** -- A lock-lineup-for-today-only option
   would add tactical depth versus the current persist-until-cleared behavior.

5. **Counter-offer chain visibility** -- Show the original trade alongside the counter
   in trade history with a visual link for negotiation tracing.

---

## Code Smells

| # | Smell | Location | Severity |
|---|-------|----------|----------|
| 1 | State mutation before try block -- trade moved to countered history before counter creation; if creation fails, trade is lost | trades.py:391-393 | HIGH |
| 2 | RNG seeded with id(trade) -- id() returns memory address, non-deterministic across runs | ai_gm.py:541-544 | MEDIUM |
| 3 | Duplicated import traceback/sys -- scattered across 8+ except blocks instead of top-level import | main.py, trades.py, season.py | LOW |
| 4 | _slotEligibility() duplicated in JS -- mirrors Python SLOT_ELIGIBILITY; if positions change, JS silently desyncs | app.js:1413-1424 | MEDIUM |
| 5 | except Exception still swallows in trades.py:127, 242, 249, 279 -- pre-existing | trades.py | LOW |
| 6 | lineup_overrides keyed by int but JSON serializes keys as strings -- .get(team.id) with int key may fail on reload | models.py:163, season.py:305 | MEDIUM |
| 7 | No feasibility validation that 10 starters can fill all 10 slots simultaneously | main.py:652-659 | MEDIUM |
| 8 | prevWeek captured outside mutate() from stale state | app.js:2939 | LOW |
| 9 | Recap overlay z-index (950) < modal overlay z-index (1000) -- overlap ordering wrong | style.css | LOW |

---

## Verdict

These three commits add substantial features (lineup override, counter-offers, weekly
recap) with generally solid structure and good validation patterns. The bare-except cleanup
in v0.5.6 is a welcome hygiene improvement.

However, **commit e594193 (v0.5.5) contains a critical logic bug**: the counter-offer
send_ids/receive_ids are passed from the original trade perspective but validated
against the counter-proposer roster, causing every counter-offer to silently fail. Worse,
the original trade is marked countered and moved to history *before* the counter creation
attempt, so when creation fails, the trade simply vanishes. This is a data-loss scenario --
the feature is effectively dead code that destroys trades 30% of the time an AI would reject.

Secondary concerns: lineup override badge shows stale state after injury fallback, and
week-recap returns hollow data for older weeks due to game_log trimming. Both are
wrong-result-no-error class bugs that erode user trust.

**Recommendation:** Fix #1 is blocking -- ship nothing further until the counter-offer
direction is corrected and the state mutation is moved after the try block succeeds.
