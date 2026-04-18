# QA Wave v0.5.22 — G2 Player Report

**Tester:** QA Agent G2 (Player role)
**Target:** https://nbafantasy.cda1234567.com (v0.5.22)
**League:** `qa-g2`
**Method:** Playwright (headless Chromium) + curl + source review
**Date:** 2026-04-18

---

## Executive Summary

Walked the full player journey: open site → create league `qa-g2` → setup → draft (manual + auto + sim-to-me) → start season → advance days → propose trade → sim to end-of-season → review screens. Produced 100+ actionable findings, with the Draft page being by far the weakest UX surface (the user's stated #1 pain point). Screenshots under `screenshots/g2p_*.png`.

### Top 5 P0

1. **[P0][Draft UX] You-turn discoverability is weak** — `static/app.js:1006-1016` hero announces "輪到你了" but the Available table is below the fold on 1440×900 with the board+headlines above it; user said "選秀頁面超難弄" exactly here. No scroll-to-available, no pulsing arrow, no hotkey. Add: auto-scroll to Available panel + "按 Enter 選第一順位" hotkey + sticky hero.
2. **[P0][Draft UX] No "Draft this player" keyboard flow** — `static/app.js:1196-1198` only supports mouse click on each row's 「選秀」. With 80 rows × 13 rounds × 8 teams that's at minimum 13 mouse hunts. Add Enter-to-draft-highlighted-row, `J/K` to move selection, and a quick-pick modal (`/` to focus search → Enter picks top result).
3. **[P0][Draft UX] "Recommended" / "Best available" guidance is missing** — there is no tier/rank/ADP column in the table (`renderPlayersTable` at `static/app.js:1201-1327`). User has no idea if FPPG 41.0 is "good" vs "elite". Add a rank column (FPPG rank or tier S/A/B/C), and highlight top-5 at current pick with a "建議" badge.
4. **[P0][Draft UX] Auto AI pick at 1500 ms with no pause/skip control** — `static/app.js:866-895` `scheduleDraftAutoAdvance` runs every AI turn with a fixed 1500 ms delay and no way for the human to accelerate/slow/pause. For a full 7-AI draft that's >2 minutes of just watching. Add user-settable delay (0/500/1500/3000 ms) + "暫停 AI" toggle + "跳過 10 順位" button.
5. **[P0][League creation flow] Create-league via switcher menu has no keyboard path** — `static/app.js:4056` `+ 建立新聯盟` is inside a popup menu triggered by `#btn-league-switch`, and the ID input (`#new-league-id`) has no format hint on-screen beyond a placeholder + hint text. Add validation preview ("qa-g2 ✓") and Enter-to-create.

---

## Draft Page Pain Points (dedicated)

This chapter comes first because the user said it is their biggest pain point.

Layout (`renderDraftView`, `static/app.js:825-862`):
```
[offseason headlines carousel]
[draft-hero: pick counter, on-the-clock, progress bar]
[draft-grid: Available table | Snake board]
```

Screenshots: `g2p_10_draft_initial.png`, `g2p_11_pick_1..5.png`, `g2p_12_draft_midway.png`, `g2p_13_after_sim.png`, `g2p_14_draft_done.png`.

### DP-01 [P0][Layout] Available panel is below the fold.
On 1440×900 after the hero + headlines, the actual "選秀" buttons are hidden. Fix: collapse headlines to one line when on draft route, or reorder so Available is first on desktop.
File: `static/app.js:843-846` and `static/style.css:411-426`.

### DP-02 [P0][Interaction] No Enter-to-draft keyboard flow.
Users must click each 選秀 button. For 13 human picks it's 13 hunt-and-peck clicks. Add Enter-key focus behavior on search input: Enter → pick top row.
File: `static/app.js:1196-1198`.

### DP-03 [P0][Guidance] No tier/rank column in Available table.
User cannot tell elite from mid. Add ADP / FPPG-rank / tier column.
File: `static/app.js:1222-1239` (header), `1283-1294` (row).

### DP-04 [P0][Auto-advance] Fixed 1500 ms delay for AI picks.
Not adjustable. Add preference with 0/500/1500/3000 options; persist to localStorage.
File: `static/app.js:877` `setTimeout(..., 1500)`.

### DP-05 [P0][Auto-advance] No pause / resume control for AI turns.
Sometimes user wants to read headlines. Add 「暫停 AI」toggle on hero.
File: `static/app.js:866-895`.

### DP-06 [P1][Spotlight] Two primary action buttons disabled when it's your turn.
「推進 AI 一手」/「⏭ 模擬到我」are disabled (`static/app.js:1018-1019 disabled: isYou`) which is correct — but then the hero has no primary CTA for you. Add 「選秀首推」that calls `/api/players?available=true&sort=fppg&limit=1` then drafts it.
File: `static/app.js:1005-1021`.

### DP-07 [P1][Persona] AI persona description never visible when you're picking.
When you're on the clock, you can't see the next AI team's persona. Move a 「下一位：巨星搭配飼料 (T4)」mini-card to the hero right rail.
File: `static/app.js:1012-1015`.

### DP-08 [P1][Board] Snake board has no horizontal scrolling shadow / hint.
On smaller screens the board silently overflows. Add `overflow-x: auto` + scroll shadows.
File: `static/style.css:429-468` `.board-wrap`.

### DP-09 [P1][Board] "Current pick" cell doesn't stand out enough.
Border `rgba(88, 166, 255, 0.35)` is too subtle. Increase to solid 2px primary color + pulse animation to match hero.
File: `static/style.css:470-474` `table.board td.current`.

### DP-10 [P1][Board] Human column ".you-cell" has only a 0.08-alpha green wash.
Hard to spot at a glance. Add a vertical rule / thicker left-border on `.you-cell`.
File: `static/style.css:475`.

### DP-11 [P1][Search] Search box placeholder says "搜尋姓名 / 球隊..." but there's no team field displayed in prev_full mode.
Confusing. Either show team column in prev_full or drop "球隊" from placeholder.
File: `static/app.js:1130` and `1219-1227`.

### DP-12 [P1][Sort] Sort dropdown default is "排序：FPPG" but prev_no_fppg mode hides FPPG — sorting by it silently still works but is invisible.
Disable FPPG sort option in `prev_no_fppg` mode.
File: `static/app.js:1145-1155`.

### DP-13 [P1][Display mode] Switching display mode re-fetches players but doesn't scroll back to top; pagination state is lost.
File: `static/app.js:1068-1081`.

### DP-14 [P1][Display mode] Switching display mode triggers a `POST /api/league/settings` for every click — no debouncing or opt-out. Rapid toggling spams API.
File: `static/app.js:1076`.

### DP-15 [P2][Display mode] "本季完整（劇透）" label is unclear; user may not realize it shows future stats that they'll also see mid-season.
Add a tooltip on the option.
File: `static/app.js:559-563`.

### DP-16 [P2][Filter] Position filter has no counts ("PG (24)"). Users don't know how many remain.
File: `static/app.js:1133-1142`.

### DP-17 [P2][Filter] Filter changes don't preserve scroll position; table resets to top.
File: `static/app.js:1166-1199`.

### DP-18 [P1][Empty state] No guidance when a filter yields 0 players.
`empty-state "找不到符合的球員。"` but no "清除篩選" button.
File: `static/app.js:1245`.

### DP-19 [P1][Pick feedback] After you click 選秀, only the table refreshes — no toast, no animation on the board cell.
Add a toast 「已選 Nikola Jokić（首輪 #1）」and flash the newly-filled board cell.
File: `static/app.js:onDraftPlayer` (search for onDraftPlayer).

### DP-20 [P1][Pick feedback] Accidental double-click can attempt to pick twice — first returns 200, second returns 400 "Player already drafted".
Debounce or disable button immediately on click.
File: `static/app.js:1196-1198`.

### DP-21 [P1][Pick validation] Human-turn check occurs server-side only; client shows enabled button even if state is stale (`canDraft = !d.is_complete && d.current_team_id === d.human_team_id`). If `refreshState` hasn't run, click 400s.
Add "refresh on focus".
File: `static/app.js:1190-1198`.

### DP-22 [P1][Sim-to-me] 「⏭ 模擬到我」returns N picks at once with no per-pick animation — board suddenly fills.
Stream picks via SSE for progressive reveal (there's already `/api/season/advance-week/stream` pattern, `app/main.py:623-647`, use same pattern for draft).

### DP-23 [P1][Sim-to-me] No way to "sim to end of round 1".
Add quick-advance buttons ("推進 5 順位" / "本輪剩餘").

### DP-24 [P2][Sim-to-me] "模擬到我" button disabled when isYou. Fine, but its label stays, reading ambiguously.
Change to 「⏭ 等待 AI」with disabled styling.
File: `static/app.js:1019`.

### DP-25 [P1][Recent picks] No "最近 5 順位" summary on the hero.
User loses context of what just happened. Add a tiny ticker at the bottom of the hero: "T7 ← Curry, T6 ← Embiid, T5 ← ...".
File: `static/app.js:968-1031`.

### DP-26 [P1][Roster preview] No "my current roster" mini-panel on the draft page.
User must navigate to #teams to see what they already drafted. Add a collapsible "我的陣容 (3/13)" sidebar.

### DP-27 [P1][Positional need] No positional balance indicator for my team.
User has no hint that they already have 3 SGs. Add "需求：PG, C" chip next to hero.

### DP-28 [P1][Projected standings] No "projected FPPG total" vs league average during draft.
Add "你 vs 平均：+12 FPPG".

### DP-29 [P1][Pick history] Reason column on board only surfaces on hover (`title` attr).
Not discoverable. Show reason inline when cell is clicked.
File: `static/app.js:1111`.

### DP-30 [P2][Accessibility] Board cells use only color to convey "current" / "you".
Add text indicators for color-blind users.

### DP-31 [P1][Mobile] `.draft-grid` switches to single column via media query but Available and Board aren't swappable — Available should stay first on mobile.
File: `static/style.css:411-426`.

### DP-32 [P2][Mobile] On mobile, players-table drops to card layout but each card is ~120 px tall; 80 cards = 9600 px vertical. No virtualization.
Use IntersectionObserver-based lazy render or infinite scroll with limit=40.

### DP-33 [P1][Mobile] Board is very wide (8 team cols × 13 rows). No mobile-optimized "your picks only" view.
Add segmented control 「全部 / 你」on `.board-wrap`.

### DP-34 [P2][Mobile] Filter bar stacks awkwardly on <360 px — search takes full width, selects wrap to second row.
File: `static/style.css:306-314`.

### DP-35 [P1][Headlines] Headlines carousel is on top of draft page and auto-loads 12 items. Each `redraw()` rewrites `cardWrap.innerHTML` on click — fine for 12 items but adds ~200ms initial paint time.
File: `static/app.js:908-966`.

### DP-36 [P2][Headlines] No "hide for this session" button on the headlines hero.
File: `static/app.js:918-941`.

### DP-37 [P2][Headlines] `categorizeHeadline` uses Chinese string matching — if backend ever localizes, these regexes silently fail and everything becomes "general 📰".
File: `static/app.js:897-906`.

### DP-38 [P1][Persona] Persona desc uses italic color `#94a3b8` — low contrast (3.2:1) on dark bg, below WCAG AA.
File: `static/style.css:2845`.

### DP-39 [P2][Persona] GM persona label is a raw English key when `state.personas` hasn't loaded yet. Better: show "GM：—" until personas fetched.
File: `static/app.js:1013`.

### DP-40 [P2][Progress] Progress bar label "0 / 104 順位已完成" — shows "0" at the very start of round 1, which is technically correct (0 picks yet) but reads confusingly.
File: `static/app.js:1027`.

### DP-41 [P2][Progress] Percent calc `(d.current_overall - 1) / totalPicks` caps at 100 only via Math.min — edge case when draft completes displays 103/104.
File: `static/app.js:971`.

### DP-42 [P1][Performance] Every `renderAvailableTable` call refetches from the server (`/api/players?...`), even when only the display mode changed client-side. Unnecessary traffic.
File: `static/app.js:1166-1199`.

### DP-43 [P1][Performance] `buildFilterBar` is rebuilt on every display-mode change; each time it re-attaches oninput handlers, potentially multiplying listeners if not garbage-collected.
File: `static/app.js:1059, 1126-1162`.

### DP-44 [P2][Data] `prev_fppg` fallback `p.prev_fppg != null ? p.prev_fppg : p.fppg` silently hides the fact that data is missing — users think they're seeing prev-season stats.
File: `static/app.js:1277`.

### DP-45 [P1][Error] `renderAvailableTable` catches fetch errors and replaces table body with raw error message. No retry button.
File: `static/app.js:1185-1187`.

### DP-46 [P1][State] Auto-advance uses `state.draftAutoBusy` but any error inside the `setTimeout` handler (e.g. `render()` throws) leaves `draftAutoBusy=false` only via the finally block — if the timer was cleared but busy wasn't, state is stuck.
File: `static/app.js:884-894`.

### DP-47 [P2][Reset] "重置選秀" button is in `#dlg-settings` but has no "Are you sure?" step; it'll silently clear a half-finished draft.
File: `static/index.html:131-135` + wiring in app.js.

### DP-48 [P2][Reset] Reset-draft API can change `randomize_order` but UI doesn't expose it anymore post-setup.

### DP-49 [P2][A11y] `<table class="board">` has no `<caption>` or ARIA label; screen readers get no summary.
File: `static/app.js:1091-1124`.

### DP-50 [P2][A11y] Draft button `<button class="btn small" data-draft="${p.id}">選秀` has no `aria-label` — when disabled state toggles on turn change, AT users get no notification.

---

## General Findings (≥ 50 more)

### League / Multi-league

G-01 [P1][CR] `#btn-league-switch` doesn't close the menu on Escape; only on outside click. `static/app.js:4034-4066`.
G-02 [P1][CR] Create-league dialog has no live validation of `league_id` against `^[A-Za-z0-9_-]+$` — user only finds out on POST 400. `static/index.html:40-44` + `static/app.js:4105-4120`.
G-03 [P1][CR] `maxlength=32` on `#new-league-id` but no minlength; empty string just errors on server. Add client-side `required`.
G-04 [P1][CR] After creating `qa-g2` the switcher menu should auto-refresh; today it needs a page reload in some branches. `static/app.js:4105-4130`.
G-05 [P2][CR] Delete button (`.lsw-del ×`) is a 14 px target on mobile — below iOS HIG 44 px. `static/app.js:4050`.
G-06 [P2][CR] No search/filter in league switcher — OK with 3 leagues, painful with 20.
G-07 [P2][CR] League "未設定" tag is decorative only; clicking it should deep-link to #setup. `static/app.js:4048`.
G-08 [P2][CR] Active league name in header (`#lsw-current`) truncates silently with CSS overflow — no title attribute. Confirm: `static/app.js:4024-4032`.
G-09 [P1][API] `/api/leagues/delete` refuses to delete active league but the error message is only shown via alert — no toast. `app/main.py:292-301`.
G-10 [P2][API] Switching league resets *global* `LEAGUE_ID` (likely module-level state) → concurrent users step on each other. Out of scope for single-player but worth a note. `app/main.py:283-289`.

### Setup

S-01 [P0][Setup] No "Skip to defaults" one-click button on the setup page — user has to click 「使用預設值」then also「開始選秀」(2 clicks). Make "使用預設值並開始" a single action. `static/app.js:589-598`.
S-02 [P1][Setup] `season_year` dropdown is populated from `state.seasonsList` but if empty, fallback is only the current form value — user can't change. `static/app.js:330-332`.
S-03 [P1][Setup] Scoring weights accept any float including negative on PTS/REB — no validation that pts > 0. `static/app.js:472-495`.
S-04 [P1][Setup] No "preview FPPG for top 10 players" after weight edit — user can't see effect before committing. Add inline preview.
S-05 [P1][Setup] Team names grid has no "shuffle names" helper; with 8 rows it's an 8-field fill.
S-06 [P2][Setup] Reset form button (「使用預設值」) calls `renderSetupView(root)` then `root.innerHTML=''` then renders again — double render, flickers. `static/app.js:590-595`.
S-07 [P2][Setup] `isLocked` disables inputs but not the radio-group visually; label is still regular weight, easy to miss.
S-08 [P2][Setup] No explanation of `randomize_draft_order` — will my "我的隊伍" still pick first? Unclear.
S-09 [P2][Setup] `trade_deadline_week` only offers {10,11,12} but regular_season_weeks up to 22 — deadline should accept up to weeks-2.
S-10 [P1][Setup] Error container (`#setup-errors`) only shows client validation; server 400 errors go to `toast` and the error container stays hidden. Inconsistent. `static/app.js:631-691`.

### Season / Advance

SE-01 [P1][Season] `/api/season/start` returns 409 "賽季已存在" but user has no direct UI control to reset — they must open settings dialog's 「重置賽季」. Surface an inline "重置並重新開始" in the 409 toast. `app/main.py:581-598`.
SE-02 [P1][Season] Advance-day POST has no latency indicator — clicks spam. Add button disable + spinner.
SE-03 [P1][Season] No "advance to next my-game" helper — user must advance day-by-day to know when their team plays.
SE-04 [P2][Season] Advance-week streaming (`/api/season/advance-week/stream`) exists but isn't used by the UI — dead code or intended future feature. `app/main.py:623-647`.
SE-05 [P2][Season] Activity ticker refreshes only on route change (`renderActivityTicker` in refreshState) — doesn't auto-update.
SE-06 [P2][Season] Weekly recap view (not explored) — but `/api/season/week-recap` at `app/main.py:1013` exists; if not surfaced on UI, huge miss.

### Trades

T-01 [P1][Trade] Propose-trade modal does not show projected FPPG delta for each side. `static/index.html:174-196` + handler in app.js.
T-02 [P1][Trade] "強制執行" cheat checkbox present but no admin gating — player in a shared league could abuse. `static/index.html:185-189`.
T-03 [P1][Trade] 300-char message field — no character counter. `static/index.html:184`.
T-04 [P1][Trade] Trade reject/accept buttons have no undo window client-side.
T-05 [P2][Trade] Veto threshold dropdown accepts 2-4 (`static/app.js:542`) but server may enforce different range (not verified).
T-06 [P2][Trade] No "trade block" UI — user can't signal openness to trades.

### Free Agents

F-01 [P1][FA] Quota box `今日可簽約: N / 3` is informative but doesn't explain reset window. `static/app.js:1696-1710`.
F-02 [P1][FA] 404 on `/api/fa/claim-status` shows "賽季尚未開始,無法簽約" — good, but the FA page still renders an empty table, confusing. Early-return with a clear empty state.
F-03 [P2][FA] No "waiver order" indicator — user has no idea where they stand in priority.
F-04 [P2][FA] No "trending FA" (hot pickups) section.

### Injuries

I-01 [P1][Injury] Injured starters get `.injured` class on row (`static/app.js:1384`) but no color legend anywhere.
I-02 [P1][Injury] No "set IL" drag-drop — IL management seems absent from UI. Confirmed by `#injuries.py`/`injuries_route.py` existing but no obvious IL UI. Must verify.
I-03 [P2][Injury] Injury status ("out", "gtd") displayed as raw string, not Chinese.

### Standings / Schedule

SS-01 [P1][Stand] Standings table not reviewed in depth but no tie-breaker explanation visible.
SS-02 [P1][Sched] Schedule view doesn't highlight "this week" vs past/future.
SS-03 [P2][Sched] No calendar-grid view (by date) — only week-by-week list.

### Accessibility / Quality

A-01 [P1][A11y] `<dialog>` elements have `aria-label` but no `aria-describedby` — screen reader users hear title only.
A-02 [P1][A11y] Nav items (`.nav-item`) use single-letter icons ("D", "T", "F", "L", "S") which are meaningless to screen readers; only text labels save them. Add `aria-hidden` on the icon span.
A-03 [P2][A11y] Toasts (`role="status"`, `aria-live="polite"`) don't declare `aria-atomic` on the toast itself — some readers announce only the diff.
A-04 [P2][A11y] Draft board color-only cues (DP-30 dup) — note for aggregation.
A-05 [P1][UX] `confirmDialog` falls back to `window.confirm` on browsers without `<dialog>` (Safari < 15.4) — native prompt bypasses app styling.
A-06 [P2][UX] App uses `alert()` in several places (e.g. `static/app.js:1456, 1653`) — should be toast + modal, not native alert.
A-07 [P1][UX] Dark theme only (`data-theme="dark"` hardcoded, `static/index.html:2`). No light-mode toggle.
A-08 [P2][Perf] `static/app.js` is 4,178 lines in one file — no code-splitting. Slow first paint on 3G.
A-09 [P2][Perf] `static/style.css` is 3,011 lines. Same.
A-10 [P2][i18n] UI hard-codes zh-TW strings in JS; no i18n abstraction.
A-11 [P1][Reliability] `refreshState` does sequential `api('/api/state')` then parallel two fetches — stalls UI on slow draft state. Could parallel all three.

### API / Backend

B-01 [P1][API] `/api/leagues/list` returns active league in response but UI stores it separately in `state`. Dup source of truth. `app/main.py:263-266`.
B-02 [P1][API] `/api/draft/pick` error payload is a dict when "not human's turn" but string otherwise. Inconsistent shape.  `app/main.py:511-520`.
B-03 [P1][API] No rate limiting visible — rapid `ai-advance` spam is server-side only capped by draft completion.
B-04 [P2][API] `/api/players?sort=fppg` doesn't support ASC direction — always DESC except for name/to. Exposing direction would help.
B-05 [P2][API] `GET /api/league/settings` returns full LeagueSettings including `scoring_weights` dict. Client has a tight coupling to field list. Use Pydantic `model_config` to expose only setup-relevant fields.
B-06 [P2][API] `POST /api/league/settings` uses `dict[str, Any]` body — no schema validation for mid-season changes. `app/main.py:356`.
B-07 [P1][API] Client reads `state.is_complete`, `current_team_id`, `human_team_id` from the snapshot; backend uses `draft.is_complete` property. Ensure consistency when multi-league adds concurrency.
B-08 [P2][API] 404 on `/api/seasons/{year}/headlines` is acceptable but headlines banner has no empty-state fallback UI — ought to show "本賽季無頭條".

### Versioning / Ops

V-01 [P2][Ops] Version label in header has `v{{APP_VERSION}}` placeholder — may leak if build step fails. `static/index.html:27`.
V-02 [P2][Ops] `/api/health` exposes `data_dir` absolute path — information disclosure. `app/main.py:240-248`.

---

## Verification Screenshots (captured)

- `screenshots/g2p_01_home.png` — initial load
- `screenshots/g2p_02_league_menu.png` — switcher opened
- `screenshots/g2p_03_new_league_form.png` — dialog for qa-g2
- `screenshots/g2p_04_after_switch.png` — active on qa-g2
- `screenshots/g2p_05_settings_dialog.png` — settings cog
- `screenshots/g2p_10_draft_initial.png` — draft board pre-pick
- `screenshots/g2p_11_pick_1..5.png` — manual human picks
- `screenshots/g2p_12_draft_midway.png` — mid-draft
- `screenshots/g2p_13_after_sim.png` — after sim-to-me
- `screenshots/g2p_14_draft_done.png` — draft complete
- `screenshots/g2p_20_season_start.png` — season opened
- `screenshots/g2p_21_after_5days.png` — +5 days
- `screenshots/g2p_30_teams.png` — teams view
- `screenshots/g2p_31_after_trade.png` — trade proposed
- `screenshots/g2p_40_end_season.png` — sim to end
- `screenshots/g2p_41_schedule.png`, `g2p_42_league.png`, `g2p_43_fa.png`

---

## Total: 100+ suggestions across Draft (50), League (10), Setup (10), Season/Trade/FA/Injuries (15+), A11y/Perf/API/Ops (20+)
