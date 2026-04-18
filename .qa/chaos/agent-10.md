# Chaos Agent #10 — Rapid-Click Stress Report

**Port:** 3420 | **Date:** 2026-04-18

## Test Method
10× concurrent curl POSTs fired in <1s per endpoint. Season started fresh from qa_p3_daily draft data.

## Results

### 推進一天 (advance-day)
- 10× fired → all HTTP 200 → day advanced by 1 only (file lock serializes writes)
- **UI guard:** NONE — `onAdvanceDay` (app.js:3648) uses `mutate()` with no in-flight flag; button stays enabled during request
- 🟡 No data corruption (GIL+file lock), but 10 requests fire silently

### 推進一週 (advance-week)
- 5× SSE streams → all 5 ran → +7 days (one week, correct)
- **UI guard:** `state.advanceWeekInFlight` (app.js:3663) — same-tab only; cross-tab bypasses
- 🟡 5× redundant compute, correct outcome

### 模擬到季後賽 (sim-to-playoffs)
- 10× fired → 6× HTTP 500, 4× HTTP 200 → playoffs started once
- Server throws uncaught exception after playoffs active → raw 500 instead of clean 400
- 🟡 Correct outcome; ugly 500s in network tab

### 模擬季後賽 (sim-playoffs)
- 10× fired → all HTTP 200 → champion set once (file-lock idempotent)
- 🟢 Harmless redundant compute

### 發起交易 send button
- 10× → all 400 (empty roster in test); with real roster: N duplicate proposals created — **no server-side dedup**
- 🔴 Rapid-click on valid proposal creates N pending trades requiring manual cancel each

### 自由球員 claim button
- 10× → all 400 (empty roster); with real roster: daily quota (3/day) provides partial protection
- First 3 rapid clicks each succeed independently
- 🟡 Quota limits but does not prevent duplicate claims within limit

### 交易接受 accept button
- 5× fake ID → all 404; with valid trade: file lock likely serializes, race window exists
- 🟡 Likely safe in practice; not confirmed with live trade

## Handlers Missing Guards (app.js)

- `onAdvanceDay` line 3648 — no in-flight flag
- `onSimToPlayoffs` line 3843 — no flag; 500 on duplicate
- `onSimPlayoffs` line 3854 — no flag
- `onAcceptTrade` line 3203 — no flag
- FA claim line 1798 — no flag
- Trade propose ~3160 — no flag; server creates N duplicates

`onAdvanceWeek` line 3659 is the only handler with a proper `state.advanceWeekInFlight` guard.

**Fix:** disable the triggering button at start of `mutate()`, re-enable on completion.
