# Chaos Agent 5 — Schedule / Week Recap / Matchup Dialog

**Port:** 3415 | **League:** chaos5 | **Weeks advanced:** 5

---

## Setup

- Created league `chaos5`, completed 13-round snake draft (human team picked first each round, AI sim-to-me for remaining picks).
- Started season, advanced 5 weeks. Final state: `current_week=5`, `current_day=35`.

---

## Schedule View — Week Navigation (Weeks 1–20)

All 20 week cards render without error.

| Weeks | Status | Dialog |
|-------|--------|--------|
| 1–5   | 已結束 (completed) | Opens, shows all 4 matchups with final scores and winner badges |
| 6–20  | 未開始 (not started) | Opens, shows team pairings with 0.0 scores — correct |
| Week 20 | Far future | Renders 0.0 scores — correct |

**Rapid-click test:** Clicked all 20 week buttons in rapid succession (50 ms interval). Page stayed stable, final dialog (week 20) remained open. No console errors.

**ESC key bug (suspected):** Pressing Escape while a matchup dialog was open triggered navigation to port 3414 (a different tab/instance). The dialog closed but the URL changed. This may be caused by a keyboard shortcut listener for `F` (free agents) firing after the dialog closes. Not definitively reproduced — may be a cross-tab shortcut capture artifact.

---

## Week Recap (聯盟 → 📅 週報)

Tested clicking 週報 button and navigating all available weeks.

| Week | Accessible | Top 5 Performers | Matchup Scores | `logs_trimmed` |
|------|-----------|-----------------|---------------|----------------|
| 1    | Yes | No (missing) | Yes | True |
| 2    | Yes | No (missing) | Yes | True |
| 3    | Yes | Yes (5 players) | Yes | False |
| 4    | Yes | Yes (5 players) | Yes | False |
| 5    | **No — UI bug** | Yes (5 players, API confirmed) | Yes (API confirmed) | False |

**BUG: Week 5 recap unreachable in UI.**

- `static/app.js:3736`: `const maxWeek = (currentWeek ?? currentWeekNumber()) - 1;`
- `static/app.js:3749`: `disabled: week >= maxWeek`
- `static/app.js:1938`: 週報 button opens `currentWeekNumber() - 1`

When `current_week=5` (day 35, week 5 just completed), `maxWeek=4`. The recap navigator's "下週▶" is disabled at week 4, making week 5 unreachable even though `/api/season/week-recap?week=5` returns full data (5 top performers, 4 matchups, `logs_trimmed=false`).

**Fix suggestion:** Change `maxWeek` to `currentWeek` (inclusive) if `current_day % 7 === 0` (i.e. week boundary), or use `current_week` from standings rather than subtracting 1.

**Older weeks (1–2) missing Top 5:** Expected behavior — `logs_trimmed=True` for weeks older than ~2 weeks. UI shows "舊週資料已清理，僅保留比分與對戰記錄" notice correctly.

**Week 0 edge case:** "◀ 上週" correctly disabled (`disabled=true`) at week 1 — no underflow.

**Rapid recap navigation:** 10 cycles of alternating prev/next clicks, no errors, no crashes.

---

## Console Errors

None captured across all tested interactions.

---

## Summary

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | Medium | Week 5 recap unreachable via UI navigator despite valid API data | `app.js:3736` — `maxWeek = currentWeek - 1` off-by-one |
| 2 | Low | Escape key while dialog open may navigate to a different port/tab | Dialog close handler / keyboard shortcut listener interaction |
| 3 | Info | Weeks 1–2 missing Top 5 in recap (expected: game_logs trimmed) | Backend trim policy, UI notice correct |
