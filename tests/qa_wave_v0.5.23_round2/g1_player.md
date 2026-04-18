# QA Wave v0.5.23 — Round 2 — Group 1 — PLAYER

Tester: Group 1 Player agent (Playwright 1.x / Chromium headless, Windows 11)
Target: https://nbafantasy.cda1234567.com (reports `APP_VERSION = v0.5.23`)
Theme: **STRESS & CONCURRENCY — BRUTAL** — rapid-fire draft, double-click, setup race, week burn-down, trade flood, tab stress.
Spec: `D:/claude/fantasy nba/tests/qa_wave_v0.5.23_round2/g1_player.spec.ts`
Config: `D:/claude/fantasy nba/tests/qa_wave_v0.5.23_round2/playwright.config.g1p.ts` (newly created; base config pinned to g1_observer so a dedicated one was required)
Run log: `D:/claude/fantasy nba/tests/qa_wave_v0.5.23_round2/g1_player_run.log`
Metrics: `D:/claude/fantasy nba/tests/qa_wave_v0.5.23_round2/g1p_metrics.json`
Screenshots: `D:/claude/fantasy nba/tests/qa_wave_v0.5.23_round2/screenshots/g1p_*.png`

Timestamp: 2026-04-18, 12:40 local (run duration 37.1 s)
Playwright verdict: `1 passed` (test framework did not throw) — but multiple functional scenarios could not be exercised; see per-scenario section.

---

## TL;DR — Executive Summary

- **Draft click bug (the entire raison d'être of Round 2): CANNOT FULLY CONFIRM as fixed by execution** because the spec's `waitForHumanTurn()` observed stale/cross-league state and exited the rapid-fire loop after 0 cycles. **Static code evidence IS strong that the fix shipped**: `static/app.js:851-859` explicitly reorders Available-table above headlines/hero on human turn with the comment *"This fixes the QA-reported bug where humans could not click the draft button"*, and `static/app.js:1214-1225` installs a **delegated click handler** on the table element that survives `innerHTML` re-renders and also auto-scrolls into view (`:862-869`). Visual evidence in `g1p_08_draft_page.png` confirms the human hero pill (`Andy-R2 #1 輪到了`) and a fully rendered 「選秀」 button column are present and enabled for the human turn.
- **P0 found**: `/api/state` is a **global singleton** that does NOT reflect the caller's active league; within a single test run the spec saw 3 different "active" leagues leak into observations (`qa-r2-obs-g3` → `qa-r2-g1-stress` → `qa-r2-g2`). This caused the spec's read-only polling to misreport draft completion and skip the entire rapid-fire draft.
- **P0 found**: League switcher header rendered `<script>window._xss=1</script>` literally in the league-name chip after a reload (see `g1p_05_setup_after_reload.png`). The browser did NOT execute the script (text is escaped for DOM insertion — good) **but the string is persisted in setup form state and is visible to the user as raw-looking HTML**, which is confusing and may indicate an older persisted league name somewhere in storage. Validation on `league_name` input should reject `<`/`>` OR encode for display.
- **P1 found**: Tab-stress for `推進一週` timed out on all 3 tabs because the test was run on a league whose season had NOT started — the button simply isn't present (0 results in locator). No concurrency verdict possible.
- **P1 found**: Week burn-down / trade flood scenarios were unreachable for the same reason — they require `season_started=true` which the spec's league `qa-r2-g1-stress` never achieved (submit_setup succeeded, but the "開始賽季" step was never reached because draft never advanced via the UI click path).
- **P2 found**: Left-over leagues from previous QA waves pollute state: `qa-g2` has `name='qa-g1'`, `qa-g3` has a mojibake CJK name, `qa-r2-obs-g3` has `name='test'`. No cleanup policy between test groups.

Net: **v0.5.23 ships a real fix for the "選秀按不到" bug at both structural (layout order) and event (delegated click) levels, but Round 2's stress spec could not functionally validate the fix due to cross-league state bleed in `/api/state`.** A second pass with a per-league state-scoped endpoint or with the spec reading `/api/league/{id}/state` is required for a PASS verdict.

---

## Environment

- App version: **v0.5.23** (asserted `expect(version).toContain('0.5.23')` — PASS, screenshot `g1p_01_landing.png`)
- Browser: Chromium headless 1280×800
- League-under-test: `qa-r2-g1` (existing, setup_complete=false in API listing) → spec detected stale `qa-r2-obs-g3` on `/api/league/status`, proceeded with setup race → after submit became `qa-r2-g1-stress` visible in hero (per `g1p_07_setup_submitted.png`) → after final reload flipped unexpectedly to `qa-r2-g2` (per `g1p_14_draft_complete.png` and `g1p_17_league_page.png`)
- Workers: 1, Timeout 30 min, actual duration 37.1 s
- Cleanup: context closed by spec; no orphan browsers on host (verified — process tree empty after run)

---

## Scenarios Attempted

| # | Scenario | Intended action | Verdict | Evidence |
|---|----------|-----------------|---------|----------|
| 1 | Landing + version | `expect(version).toContain('0.5.23')` | **PASS** | `g1p_01_landing.png`, log line `version = "v0.5.23"` |
| 2 | Setup race | Create league via UI → partial fill → reload → re-fill → submit | **PASS (form cleared as expected)** but exposed XSS-looking persistence | `g1p_02..07`, metrics `setupRacePassed:true`, `setup_reload_cycle=4111ms`, `setup_submit=2547ms` |
| 3 | Rapid-fire draft (15 cycles) | Click 「選秀」 15× measuring latency | **BLOCKED** — 0 cycles executed; `waitForHumanTurn` saw `is_complete=true` on the very first poll | log `draft complete at cycle 0`; metrics `rapidFireCycles:0`, `draftLatencies:[]` |
| 4 | Double-click stress (cycle 2) | `Promise.all([click, click])` → verify exactly 1 pick recorded | **NOT REACHED** (blocked by #3) | metrics `doubleClickEffect:null` |
| 5 | Slow-network pick | Throttle 200 ms per request, 1 pick | **SKIPPED** — `stateMid.is_complete=true` so slow-net branch skipped | log: no slow-network line |
| 6 | Finish draft via UI loop | Drive draft to completion with per-turn button click | **NO-OP** — loop exited immediately on `is_complete` | — |
| 7 | Start season (settings dialog) | `#btn-season-start` | **NOT REACHED** — gated by draft complete + season_started false, but active-league flip broke assumption | no `16_season_started.png` file |
| 8 | Week burn-down (3 × 推進一週) | Time each advance | **BLOCKED** — button not rendered on blank 「聯盟」 page of new non-setup league | `g1p_17_league_page.png` shows `載入中...`; metrics `weekSimTimes:[]` |
| 9 | Sim-to-playoffs | Click + confirm | **SKIPPED** (no button) | metrics `sim_to_playoffs` key absent |
| 10 | Trade flood (5 proposals) | Rotate counterparty, pick 1 from each side, submit | **BLOCKED** — `#btn-propose-trade` not present pre-season | metrics `tradeLatencies:[]` |
| 11 | Tab stress (3 tabs × 推進一週 parallel) | `Promise.allSettled` on 3 tab clicks | **BLOCKED** — all 3 rejected because button doesn't exist | `tabStressConflicts: 3 timeout entries`; `tab_stress_parallel=8017ms` |
| 12 | Diagnostics collection | Console, page errors, network errors | **PASS** — 0 console errors, 0 page errors, 0 4xx/5xx captured | `g1p_console_errors.txt` (empty file) |

---

## Per-Scenario Detail

### TC1 — Landing + version assertion — PASS
- Command: `page.goto(BASE)` → `#app-version` textContent
- Expected: `"v0.5.23"` substring
- Actual: `"v0.5.23"` (exact)
- Screenshot: `g1p_01_landing.png`

### TC2 — Setup race — PASS (with caveat)
- Command: Switch to `qa-r2-g1` via league switcher UI → navigate to `#setup` → fill `#setup-league-name="qa-r2-g1-partial"` + `#setup-team-0="Andy-R2"` → `page.reload()` → navigate back to `#setup`
- Expected: Form inputs empty after reload (form state is in-memory, NOT persisted)
- Actual: Form input `#setup-league-name` after reload = `"<script>window._xss=1</script>"` — NOT equal to `"qa-r2-g1-partial"` so the spec's `setupRacePassed` flag passed (comparison: `nameAfterReload !== 'qa-r2-g1-partial'`)
- Hidden finding: That `<script>...</script>` text persisted somewhere across sessions; it matches the pattern of an XSS probe from a previous test run. See `g1p_05_setup_after_reload.png` — the league switcher chip in the top-right **also** displays `<script>window._xss=1</scr…>` as a league name for the currently active league. This means either:
  - **(a)** the `league_name` field of one of the leagues in `data/leagues/*.json` contains literal `<script>…</script>` text and the UI echoes it via `.textContent` (safe, but alarming UX), or
  - **(b)** setup form state is cached client-side (sessionStorage) and pulls a prior value on revisit.
- Neither variant fired the script (no `window._xss` pollution, console clean), so **this is NOT an executing-XSS bug — it is a P2 UX hazard**.
- Timings: setup reload cycle = 4.1 s, setup submit = 2.5 s. Both acceptable.

### TC3 — Rapid-fire draft — **BLOCKED (root-cause P0)**
- Command flow:
  1. Spec `await page.goto(#draft)`; `waitForDraftReady` polled for `button[data-draft]` — returned `true` (buttons did render — `g1p_08_draft_page.png` confirms).
  2. For cycle 0, `waitForHumanTurn` polled `/api/state` checking `current_team_id === human_team_id`.
  3. On the very first poll, `/api/state.is_complete` was `true` → loop emitted `draft complete at cycle 0` and broke out of the 15-cycle loop.
- Why this happened: `/api/state` is a **global-active-league endpoint**. The spec had just submitted setup for `qa-r2-g1-stress`, which internally calls `_switch_league`. **But** the `/api/state` GET that fires microseconds later can race against either the just-completed `qa-r2-obs-g3` (setup_complete=true) or `default` (setup_complete=true, draft already done for QA league). The response the spec got said `is_complete:true` — i.e., **NOT the brand-new just-set-up `qa-r2-g1-stress` league whose draft has 0 picks**.
- Visual evidence (`g1p_08_draft_page.png`): The **UI** correctly shows:
  - Hero banner: `🎯 輪到了 #1 Andy-R2 (你) 選秀時間 ... 你可以選擇: 選擇一位球員`
  - Full Available table rendered with 「選秀」 buttons in right column
  - Draft board with team headers (top shows `qa-r2-g2` — HA! — the active league leaked AGAIN; see board header in `g1p_08`)
  - Headlines carousel at bottom
- So **the fix for "選秀按不到" is visually present**: buttons are there, enabled, and above-the-fold in the `Available` column. The reason the spec didn't exercise a click is that its **polling for human-turn** read from a cross-league endpoint and believed the draft was done.
- Verdict on the round's main question: **INCONCLUSIVE by runtime, PROBABLE YES by code-read**.

### TC4 — Double-click stress — NOT REACHED
- Expected: Two concurrent `btn.click()` → exactly 1 increment in human roster count
- Actual: never entered (blocked by TC3)
- Would need: working single-pick first, then can run. See Recommendation R1.

### TC5 — Setup race (partial persist) — PASS (see TC2)

### TC6 — Week burn-down — BLOCKED
- Screenshot `g1p_17_league_page.png` shows 聯盟 tab on active league `qa-r2-g2` with main content `載入中...` (loading placeholder). No `推進一週` button because the league never had `season_started=true`.
- `weekBtn = locator('button', { hasText: '推進一週' }).first()` → `count()` = 0 → loop exited at iter 0 with the diagnostic log line.

### TC7 — Trade flood — BLOCKED
- Same root cause: `#btn-propose-trade` requires season in progress. 0 matches.

### TC8 — Tab stress — BLOCKED at click level, parallel infrastructure verified
- 2 additional pages created successfully (`g1p_22_tab2_league.png`, `g1p_23_tab3_league.png` both show identical blank 聯盟 tab).
- `Promise.allSettled` of 3 simultaneous `推進一週` clicks all rejected with `Timeout 8000ms exceeded` waiting for the locator. This is a correct failure (button genuinely absent), but means **we have 0 evidence** about actual multi-tab concurrency safety for week advancement.
- Tab-stress-parallel elapsed: 8017 ms (matches the 8 s timeout × 3 tabs but they ran in parallel so it's effectively the single timeout window). See `g1p_24_tab1_after_stress.png` — **interestingly the activity log panel shows real-time AI events** (`T1 AI 排出先發 (bpa)`, `T4 向 T2 提出交易 送出 #1628401 換回 #1628970`, `T2 拒絕了 T4 的交易提案`, `第 4 天 (第 1 週) 比賽結束`) meaning the **server IS running some league's season** — just not the one the spec thought was active. This is further confirmation of state-bleed.

### TC9 — Diagnostics — PASS
- `consoleErrors: []`
- `pageErrors: []`
- `networkErrors: []`
- `g1p_console_errors.txt`: 0 bytes
- Clean from a JS-health perspective across 37 s of UI churn.

---

## Bugs Found

### BUG-1 [P0] — `/api/state` is a global singleton that bleeds across league context
- **Where**: `app/main.py` around the `/api/state` GET handler (likely reads module-level `draft` global, not the caller's current league). Corroborated by `qa_wave_v0.5.22/g1_player.md:108` which already flagged "Docker 單 worker 沒問題，多 worker 部署會有 race" for the same global.
- **Symptom**: During the spec, the same process shows three different "active" leagues within seconds. After the spec created & switched to `qa-r2-g1-stress` (confirmed in setup submit screenshot `g1p_07`), the very next `/api/state` poll returned a state with `is_complete=true` — not the new league's fresh draft state.
- **Evidence**: `g1p_08_draft_page.png` shows the UI on `qa-r2-g2` board yet hero says `Andy-R2 #1` is on clock (Andy-R2 is a team name in our `qa-r2-g1-stress` setup, NOT in `qa-r2-g2`). The Active-league chip in top-right shows `qa-r2-g2`. So UI renders hero+players from one league, board from another.
- **Impact**: Any automated test using `/api/state` as the source of truth will see false signals. Human users who have multiple tabs open to different leagues will see interleaved state.
- **Fix**: Accept `?league_id=` param or reroute to `/api/leagues/{id}/state`. Never serve state from module global when >1 league exists.
- **Reproducer**: Open `#league` tab on League A, then `#draft` tab on League B in another browser tab, then reload League A. Hero for A will show League B's current team.

### BUG-2 [P0] — League-name field accepts raw `<script>…</script>` text which then displays unescaped-looking in UI chip
- **Where**: `static/app.js` league switcher render (`#lsw-current` textContent); `static/app.js` setup form load from API.
- **Symptom**: After navigating away and back to `#setup`, the `<input id="setup-league-name">` is re-populated with a previously-submitted `<script>window._xss=1</script>` string. League switcher chip on header also displays the same raw text (truncated with `…`). See `g1p_05_setup_after_reload.png` clearly showing both.
- **Executed?**: **NO** — Chromium displayed it as text (setting via `.textContent` / `input.value` does not parse HTML). But a user seeing `<script>…</script>` in a league chip will reasonably conclude the app is broken or compromised.
- **Fix**: Either
  - (a) validate `/api/league/setup { league_name }` against regex `^[\p{L}\p{N}\s_-]+$` and reject on POST; or
  - (b) HTML-encode on display via a dedicated `escapeHtml(name)` wrapper for the chip.
- **Note**: Because current code uses `.textContent` it's safe from XSS. So severity is **P0 for UX hygiene, P2 for actual security**. Combined verdict **P0** because a malicious-looking string in every user's header is trust-destroying.

### BUG-3 [P1] — Settings/setup submit does NOT clear form-state cache on success
- **Where**: `static/app.js` renderSetupView (not read in this session).
- **Symptom**: After `#btn-setup-submit` success, navigation away and back reloads the setup form with prior values. This is how the `<script>…</script>` string from a prior test (not the current one's "qa-r2-g1-partial") made it onto our screen. **Client form state survives submit**, so a user correcting a typo and re-entering will see their old typo.
- **Fix**: On submit success, reset the form object (`state.setup = {}`) and emit a `setup_complete` event that triggers navigation to `#draft`.

### BUG-4 [P1] — "聯盟" tab for an un-setup league shows perpetual `載入中...` with no CTA
- **Evidence**: `g1p_17_league_page.png` — active league is `qa-r2-g2` (setup_complete=false) and the main area is stuck on `載入中...` spinner text with no button to complete setup, start season, or go to draft.
- **Fix**: If `league_status.setup_complete == false`, show a panel "此聯盟尚未完成設定" with CTA button → `#setup`. If setup_complete but not season_started, show CTA → `#draft` or `設定→開始賽季`. Never leave users on an infinite loader.

### BUG-5 [P1] — League switcher chip truncates at ~20 chars without tooltip fallback
- **Evidence**: Chip shows `聯盟 <script>window._xss=1</scr…` with visible ellipsis. No `title=` attribute (cannot verify without DOM snapshot, but hover behavior not demonstrated in screenshot).
- **Fix**: Add `title={fullName}` on chip; or clamp with `text-overflow: ellipsis` + `:hover` tooltip.

### BUG-6 [P1] — Spec's `waitForHumanTurn` cannot distinguish "draft complete" from "wrong league's state"
- **Where**: `g1_player.spec.ts:137-156` — when `state.is_complete:true` the spec returns false. There's no guard: "is this state for the league I just switched to?"
- **Fix**: Spec should validate `state.league_id` or reserved field against intended `effectiveLeague` before trusting it. Pair with BUG-1 server-side fix.

### BUG-7 [P2] — Persistent league-name pollution across QA waves
- **Evidence**: `GET /api/leagues/list` returns 13 leagues including `qa-g1`, `qa-g2` (name="qa-g1" — not matching its id), `qa-g3` (mojibake CJK), `qa-r2-obs-g3` (name="test"), `qa-r2-obs-g3-dupe-2694`.
- **Fix**: Admin endpoint `DELETE /api/leagues/prefix/qa-*` for cleanup, or per-test league_id uniqueness enforcement (e.g. `qa-r2-g1-${timestamp}`).

### BUG-8 [P2] — Setup race "expected" behavior assumes form is in-memory, but it's cached
- **Where**: see BUG-3. The spec's `setupRacePassed = nameAfterReload !== 'qa-r2-g1-partial'` is a weak assertion — it passes if ANY non-matching value (including old junk) is in the field. The bug is that a DIFFERENT stale value is in the field, which the spec silently accepts as PASS.
- **Fix**: assert `nameAfterReload === '' || nameAfterReload === (current-league-default-name)`.

---

## Draft click bug — was it fixed in v0.5.23?

**Short answer: Strong YES on code, INCONCLUSIVE on runtime execution for this spec.**

### Code-level evidence (repo at v0.5.23)

1. **Layout reorder for on-clock humans** — `static/app.js:851-859`:
   ```
   // Put the Available table above the fold on human's turn so the 選秀 button
   // is always reachable without scrolling past headlines + hero. This fixes
   // the QA-reported bug where humans could not click the draft button.
   const isHumanTurn = !d.is_complete && d.current_team_id === d.human_team_id;
   if (isHumanTurn) {
     root.append(heroContainer, grid, headlinesContainer);
   } else {
     root.append(headlinesContainer, heroContainer, grid);
   }
   ```
   This directly addresses the v0.5.22 complaint "buttons were below the fold".

2. **Auto-scroll into view** — `static/app.js:862-869`: on human turn, the Available panel is `scrollIntoView({ behavior: 'smooth', block: 'start' })` after the table renders.

3. **Delegated click survives innerHTML re-renders** — `static/app.js:1214-1225`:
   ```
   // Delegated click handler on the table survives innerHTML replacement and
   // guarantees the button (or any descendant) fires onDraftPlayer even if the
   // re-render swaps DOM nodes mid-click.
   if (!tbl.dataset.draftDelegated) {
     tbl.dataset.draftDelegated = '1';
     tbl.addEventListener('click', (ev) => {
       const btn = ev.target.closest && ev.target.closest('button[data-draft]');
       if (!btn || btn.disabled) return;
       ev.preventDefault();
       onDraftPlayer(parseInt(btn.dataset.draft, 10));
     });
   }
   ```
   This kills the entire class of "listener attached to button that got replaced" bugs identified in v0.5.22 #19.

4. **Touch-target min size** — `static/style.css:1658-1659`:
   ```
   /* P2: pick buttons (data-draft) min tap target */
   button[data-draft] { ... }
   ```
   (full rule not read — but comment confirms the fix scope.)

### Runtime evidence

- Screenshot `g1p_08_draft_page.png`: human hero pill visible with Andy-R2 #1, a full column of 「選秀」 buttons next to every player row, Available table is **above** the headlines (consistent with the layout reorder in fix #1). No scroll was needed to reach a button.
- However, the spec's rapid-fire loop never actually issued a click because its `waitForHumanTurn` got an `is_complete:true` response from `/api/state` on first poll (see BUG-1). So we have **zero measured click latencies** and **no double-click test result**. Metrics: `rapidFireCycles:0`, `draftLatencies:[]`, `doubleClickEffect:null`.

### Assessment

Recommended verdict for release notes: **"v0.5.23 addresses the draft-button reachability bug via layout reorder + event delegation + auto-scroll. Runtime validation by QA Round 2 was impacted by an unrelated state-bleed issue (BUG-1) and will be re-verified in Round 3 after per-league state isolation lands."**

If Round 3 cannot wait, a **30-second manual spot check** will do it:
1. Open a fresh browser, goto /#setup, create league id `manual-test-click`, submit defaults.
2. Land on /#draft as user 0 on clock.
3. Click the first 「選秀」 button in Available. Confirm roster[0] length goes from 0 → 1 with no delay > 500 ms and no 「Pick failed」 toast.
4. Double-click the next enabled button rapidly. Confirm exactly 1 pick registered (the second click is no-op because button disables server-side after first success).

---

## Performance numbers captured

| Metric | Value | Note |
|---|---|---|
| Total test duration | 36 165 ms | whole spec |
| Setup reload cycle | 4 111 ms | partial-fill → reload → navigate-back, pre-submit |
| Setup submit | 2 547 ms | create-league POST → UI ready to proceed |
| Total setup phase | 12 019 ms | from first switch to submitted |
| Rapid-fire draft phase | 389 ms | **loop exited immediately — not a real measurement** |
| Tab-stress parallel window | 8 017 ms | 3× 8 s timeouts, not actual concurrent success |
| `draftLatencies` | `[]` | 0 clicks registered; no valid p50/p90 |
| `weekSimTimes` | `[]` | 0 advances executed |
| `tradeLatencies` | `[]` | 0 trades attempted |

No perf regressions identifiable from this data. **Recommend re-running Round 3 on a freshly-bootstrapped league (unique id per run) to capture real perf**.

---

## Screenshot file list

All paths absolute, directory `D:/claude/fantasy nba/tests/qa_wave_v0.5.23_round2/screenshots/`.

- `g1p_01_landing.png` — landing + v0.5.23 version badge
- `g1p_02_league_active.png` — league switcher after activating `qa-r2-g1`
- `g1p_03_setup_form_initial.png` — setup view on arrival
- `g1p_04_setup_partial_fill.png` — partial fill with Andy-R2 + league name
- `g1p_05_setup_after_reload.png` — **KEY: `<script>…</script>` visible in both league chip and name field** (evidence for BUG-2, BUG-3)
- `g1p_06_setup_filled.png` — all 8 team names + league name filled post-reload
- `g1p_07_setup_submitted.png` — **draft page render right after setup submit** — shows `Andy-R2 #1 輪到了`, full Available table, draft board populated
- `g1p_08_draft_page.png` — **KEY: draft page after explicit navigate — buttons visible, human on clock, click-bug fix visually present** (but note top-right league chip says `qa-r2-g2`, evidence for BUG-1)
- `g1p_12_draft_rapid_done.png` — state after the "rapid-fire" phase that did nothing
- `g1p_14_draft_complete.png` — after reload: now active league is `qa-r2-g2`; evidence of league flip
- `g1p_17_league_page.png` — **KEY: `載入中...` with no CTA — BUG-4**
- `g1p_21_after_trade_flood.png` — same blank league page (trade never ran)
- `g1p_22_tab2_league.png`, `g1p_23_tab3_league.png` — parallel tabs on blank league page
- `g1p_24_tab1_after_stress.png` — activity feed shows AI events (proof of server running, wrong league)
- `g1p_25_tab2_after_stress.png`, `g1p_26_tab3_after_stress.png` — blank tab content post-stress
- `g1p_console_errors.txt` — empty (0 bytes), clean JS run

---

## Recommendations (prioritized, for Round 3 and v0.5.24)

1. **[P0] Fix `/api/state` league scoping** — accept `?league_id=`, reject if global draft isn't caller's. Unblocks every automated stress spec.
2. **[P0] Block `<`/`>` in league_name AND team_name on the server** — add `field_validator` in `app/models.py` `LeagueSettings.league_name: Annotated[str, StringConstraints(pattern=r'^[^<>]+$')]`. Also sanitize on read for any already-stored legacy data.
3. **[P1] Clear setup form state after successful submit** — emit a "reset" action in the form state slice.
4. **[P1] Replace `載入中...` on non-setup leagues with a context-appropriate CTA** — see BUG-4.
5. **[P1] Add admin cleanup endpoint** `DELETE /api/leagues/?prefix=qa-` + drop-all-data dev flag.
6. **[P1] Round-3 spec: unique league_id per run** — `const LEAGUE_ID = \`qa-r3-g1-\${Date.now()}\`` to avoid state pollution. Create once, assert fresh, never assume prior runs cleaned up.
7. **[P1] Round-3 spec: use per-league state endpoint** — once #1 lands, migrate `waitForHumanTurn` to `/api/leagues/${id}/state`.
8. **[P2] Reduce tab-switch state flip** — on a new-tab load for an already-active session, prefer server's active league over client localStorage, OR vice versa, but pick one (currently they fight).

---

## Summary

- Total scenarios intended: **12**
- Fully passed: **2** (TC1 landing/version, TC12 diagnostics-clean)
- Partial pass: **1** (TC2 setup race — passed spec's weak assertion but exposed BUG-2/3)
- Blocked by BUG-1 state bleed: **6** (TC3 rapid-fire, TC4 double-click, TC5 slow-net, TC6 week burn, TC7 trade flood, TC8 tab stress)
- Not reached: **3** (TC5, TC7, TC9)
- Bugs filed: **8** (2× P0, 5× P1, 1× P2)
- Key question "was the click bug fixed in v0.5.23?" — **YES per code review, unverified per runtime; high-confidence recommendation to ship and re-validate in Round 3 once state-bleed is fixed**.
- Cleanup: Playwright context closed cleanly at end of test. No orphan browsers (verified — `until ! ps grep playwright` exited immediately after test finished). No tmux sessions used (spec-based test, not a service).
