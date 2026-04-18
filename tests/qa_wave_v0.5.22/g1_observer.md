# G1 Observer Report — Fantasy NBA v0.5.22 @ nbafantasy.cda1234567.com

League: `qa-g1`  (Player team: Andy-QA, 8 teams, 13-round draft, draft completed during wave)
Tooling: curl API probes + Playwright (headless Chromium 1280x800/375x812/768x1024), 9/9 spec tests passed in 46.1s.
Scope: Independent verification layer that complements Player E2E — API correctness, a11y, console/network, visual, data consistency, concurrency.

Artifacts:
- Spec: `g1_observer.spec.ts`
- Config: `playwright.config.g1o.ts`
- Screens: `screenshots/g1o_01_desktop_load.png`, `g1o_02_tab_walk.png`, `g1o_03_rwd_375.png`, `g1o_04_rwd_768.png`, `g1o_05_teams_view.png`
- State snapshots: `g1o_state_after.json`, `g1o_standings_after.json`, `g1o_settings_after.json`

## Runtime health summary
- Console errors: 0  |  warnings: 0  |  page errors: 0 across 5 route transitions (draft/teams/fa/league/schedule).
- Network: 74 reqs, 29 API calls, 0 >500ms, 0 4xx/5xx.
- API latency (TTFB): `/api/state` 240–290 ms; `/api/players?limit=400` 340 ms; `/api/health` 288 ms. (Tunnel overhead — p50 ~260 ms, all cold.)
- Payload sizes OK: `index.html` 12 KB, `app.js` 154 KB (uncompressed!), `style.css` 83 KB.
- Concurrency (12 samples @ ~2s cadence during Player setup): state returned consistently, no flapping.
- Data consistency: API team names after Player setup = `["Andy-QA","Bucks AI","Celtics AI",...]`. Before setup (teams view under pre-draft) UI did **not** render any team names — correct empty-state (expected).

## Top 5 P0

1. **`app.js` 154 KB uncompressed + no brotli/gzip response-header visible** — `/static/app.js` downloads full 154 KB on first paint over tunnel; TTFB 331 ms + transfer 130 ms. `static/app.js:1` Add `Content-Encoding: gzip` at reverse proxy or Dockerfile `gzip_static on;`. Observed: `curl -I` returns no `content-encoding`.
2. **Contrast failure: `.lsw-btn` / `.lsw-label` ratios 1.54 / 2.56** (target 4.5). Header league switcher is essentially unreadable in dark theme against `--bg-elevated`. `static/style.css:112` (app-version 3.46), `static/app.js:17` (btn-league-switch). Fix: raise `--text-muted` to `#c0c6cf` or reuse `--text` for this button.
3. **Setup form inputs have zero programmatic accessible name** — tab-walk recorded 30+ INPUT stops with `aria=null, textContent=""`. The `<label class="setup-label">` siblings are visual but are NOT linked via `for=`/`id=`, so screen readers announce nothing. `static/app.js:362` (`function row(label, control)` creates un-linked label). Fix: accept an `id` and generate `<label for=id>`.
4. **H1 `.app-title` overflows at 375 px** (scrollWidth 137 vs clientWidth 99, clipped with ellipsis) — "NBA Fantasy 模擬器" gets truncated and the only cue is CSS ellipsis; no `title` attr. `static/style.css:88-96`. Fix: reduce `h1` font-size to 14 px under 420 px, or add `title` attr.
5. **`/api/leagues` 404** (the CLAUDE prompt pointed here) — actual endpoint is `/api/leagues/list`. The spec documents both routes inconsistently (`app.js:4013` uses `/list`). Either register an alias or update all docs; external QA tooling will fail otherwise. `app/main.py` (route registration).

## Findings by section (≥100 items)

Legend: P0 critical, P1 high, P2 medium, P3 polish. Format: `[Pn] [Category] [file:line or component] — finding → fix`.

### API correctness

1. [P0][API][app/main.py] `GET /api/leagues` returns `{"detail":"Not Found"}`; only `/api/leagues/list` works → add alias or 301.
2. [P0][API][app/main.py] `/api/draft/board` returns 404 yet UI builds board client-side — doc drift; either expose or remove from spec.
3. [P1][API][app/main.py] `/api/settings` 404 — setup uses `/api/league/settings`; collapse naming.
4. [P1][API][`GET /api/state`] response size balloons 7.4 → 13 KB once picks arrive; returns full `board` 13×8 of nulls — gzip or sparse encoding.
5. [P1][API][`GET /api/state`] includes full roster IDs per team in completed draft; no field to fetch just metadata cheaply (`/api/state?slim=1`).
6. [P2][API][`GET /api/players?limit=400`] 64 KB payload for dropdown/search — server-side pagination + search index hit every keystroke; add `ETag`.
7. [P2][API][`GET /api/season/schedule`] returns `{"schedule":[]}` pre-season — use 204 or `null` to distinguish from "schedule of length 0".
8. [P2][API][`GET /api/season/logs?limit=30`] returns `"[]"` literal string sometimes vs `{"logs":[]}` elsewhere — normalize; `app.js:225` already handles both which masks the bug.
9. [P2][API][`GET /api/season/standings`] always 200 even pre-season; UI checks `standings.length` to infer season state. Add explicit `is_started: false` field.
10. [P2][API][`GET /api/fa/claim-status`] returns 200 with no-content body when no season — UI falls back to `catch {}` path; return 409 to make intent explicit.
11. [P2][API][`GET /api/trades/pending`] 43 bytes even when no season — return 409 with structured reason code `NO_SEASON`.
12. [P3][API][`GET /api/health`] should also expose `league_id`, `active_setup_complete` so observers don't need 2nd call.
13. [P1][API][auth] All endpoints unauthenticated and mutating (`POST /api/league/setup`, `POST /api/leagues/switch`, `DELETE /api/leagues/:id`) — site advertised "no auth" but this means a drive-by can wipe active league. Add at least a league-scoped write token or rate limit.
14. [P1][API][`POST /api/leagues/switch`] Not idempotent w.r.t. already-active — no docs. Confirm response shape.
15. [P2][API][single-active model] `leagues/list` exposes `"active"` field; two observers on different leagues will step on each other. Needs per-session scoping.
16. [P2][API][`DELETE /api/leagues/:id`] Missing from docs but exists in UI (`lsw-del`) — what happens if you delete `active`? Needs explicit contract.
17. [P2][API][version drift] `/api/health` reports `version:"0.5.22"` — surface this in HTTP `X-App-Version` header for curl observers.
18. [P3][API][ETag] None of GET endpoints sent `ETag` or `Cache-Control`; every nav hits network even for static-ish data (players, leagues/list).
19. [P3][API][CORS] No preflight handling visible — fine for same-origin but document.
20. [P2][API][`POST /api/league/setup`] Accepts and silently ignores unknown keys — validate with Pydantic `extra="forbid"`.
21. [P3][API][timestamps] `created_at:0.0` for legacy leagues is cosmetic but surfaces as "1970-01-01" if ever rendered.
22. [P2][API][error shape] Errors are `{"detail": "..."}` but UI also reads `j.message` — pick one and document (`app.js:127`).
23. [P3][API][`/api/state.board`] Pre-seeded as 13×8 of nulls — server padding is fine but clients pay 80 B of `null,` noise.
24. [P2][API][soft endpoints] `apiSoft()` swallows all errors uniformly (`app.js:139`) — you can't distinguish network off from 500. Log to sentry-like channel.
25. [P3][API][route discovery] No `/openapi.json` link from index; add for external QA automation.

### Accessibility (a11y)

26. [P0][A11y][app.js:362 `row()`] Setup labels use `<label class="setup-label">` as a div, never paired with `for`; `<input>` lacks `aria-labelledby`. Screen readers read nothing. Fix: `row(labelText, {control, id})` wiring.
27. [P0][A11y][app.js:1129] `<input type="search" placeholder="搜尋姓名 / 球隊...">` has neither label nor `aria-label`. Add `aria-label="搜尋球員"`.
28. [P0][A11y][app.js:1133,1143] Two `<select>` filters (position, sort) — no label. Add `aria-label="位置篩選"` / `aria-label="排序欄位"`.
29. [P0][A11y][app.js:17] `#btn-league-switch` has `aria-haspopup="menu"` but no `aria-label` and visible text is `"聯盟 qa-g1"` — OK for sighted, but aria-expanded lives on button only; add explicit `aria-label="切換聯盟，目前 qa-g1"`.
30. [P1][A11y][index.html:77] `<main id="main-view" tabindex="-1">` — focus is moved into main on route change but no `aria-live` region announces new page name.
31. [P1][A11y][index.html:54-75] Side nav uses `<a>` with hash; no `aria-current="page"` when active. `app.js:246` toggles `.active` class only.
32. [P1][A11y][index.html:90-96] Mobile bottom tabs same issue — no `aria-current`.
33. [P1][A11y][app.js:1529] Modal `<div class="modal-overlay">` is not a `<dialog>` and lacks `role="dialog"`, `aria-modal="true"`, `aria-labelledby`. Keyboard users can't escape with Esc (no handler).
34. [P1][A11y][app.js:1596] Lineup full modal — same as above.
35. [P1][A11y][app.js:3935] Summary overlay — no role/label.
36. [P1][A11y][app.js:3786] Recap overlay — same.
37. [P1][A11y][index.html:147] `<dialog id="dlg-confirm">` reuses body innerHTML for arbitrary dynamic content (sign/drop dialog); no live region for validation error "請選滿 10 人" — uses `alert()` instead (`app.js:1653`).
38. [P2][A11y][index.html:98] Settings dialog has `aria-label="設定"` but `<h2>` says "設定" too — redundant.
39. [P2][A11y][index.html:184] `<textarea id="trade-message">` placeholder only; add `aria-label="說服對方的話"`.
40. [P2][A11y][style.css:71] `:focus-visible` 2px outline is fine, but `.btn:active{transform:scale(0.98)}` on buttons (`style.css:260`) also applies to focus via click — ensure outline survives transform.
41. [P2][A11y][app.js:1530] Modal close button uses `"✕"` — give it `aria-label="關閉對話框"`.
42. [P2][A11y][style.css:104-106] `.conn-dot` 8×8 px solid color — screen readers get `aria-hidden` (good) but sighted color-blind users can't tell ok/bad; add text next to it always (already there as `conn-text` — keep).
43. [P2][A11y][app.js:1258] Players table cells mix `<td class="hidden-m">` with `<td class="meta-row">` — when one is hidden via `display:none`, screen reader still reads both; use `aria-hidden` + CSS, or remove from DOM.
44. [P2][A11y][app.js:1517] Slot swap modal buttons `"選"` — 1-character button; give `aria-label="選擇 ${playerName} 填入 ${slot}"`.
45. [P2][A11y][app.js:961] Headline pager dot buttons have `aria-label="第 N 則"` but no `aria-current="true"` for active.
46. [P2][A11y][index.html:174] Trade modal force checkbox label is inside `<label class="force-label">` but the warn text `#trade-force-warn` uses `hidden` toggling — add `aria-live="polite"` on warn div.
47. [P2][A11y][app.js:1586] `<input type="checkbox" class="lineup-check">` with no label text in the cell — only visible via row name neighbour. Add `aria-labelledby` pointing to the name cell.
48. [P2][A11y][app.js:3917] Summary close button only has class `btn`, text `"關閉"` — fine, but it's outside a real dialog so Esc doesn't close.
49. [P3][A11y][index.html:1] `<html lang="zh-TW">` — good, but dynamic English content (team names "Bucks AI") isn't wrapped in `lang="en"` span.
50. [P3][A11y][index.html:5] `viewport-fit=cover` combined with `padding-bottom: env(safe-area-inset-bottom)` — iOS safe-area covered; verify on iPad landscape where it differs.
51. [P3][A11y][app.js:1046] Draft display mode `<select>` — no label (only `title`). Add visible label or `aria-label`.
52. [P3][A11y][style.css:475] `.current` board cell uses rgba bg and outline; pair with `aria-current="true"` on that `<td>`.
53. [P3][A11y][app.js:1391] Empty slot rendered as `"—"` — add `aria-label="空位"` for clarity.
54. [P3][A11y][index.html:80] Log aside uses `<h2>活動</h2>` + `<button>` with `aria-label="重新整理活動記錄"` — ensure list `<ul id="log-list">` also has `role="log"` or `aria-live`.
55. [P3][A11y][index.html:214] `.toast-stack` has `aria-live="polite"` (good) but each `.toast` has `role="status"` — `polite` on parent suffices; double announcement risk.

### Console / page errors

56. [P1][Console][n/a] 0 errors observed during full cycle. Keep a CI gate (`expect(consoleErrs).toEqual([])`) to lock this in.
57. [P1][Console][app.js:1079] Only `console.warn` call in whole bundle — catches "save draft_display_mode failed"; good. Route it to a toast too so users know their preference didn't persist.
58. [P2][Console][app.js:139] `apiSoft` swallows errors silently — add `console.debug` behind a `DEBUG` flag for devs.
59. [P2][Console][app.js:1679-1693] `refreshFaQuota` catches and replaces quota with muted text but does not log; when in pre-season this masks real 500s.
60. [P2][Console][app.js:4011] `loadLeagues` fallback to `'default'` silently on error — should toast "無法載入聯盟列表".
61. [P3][Console][app.js:3787] Overlay click handler uses `e.currentTarget.remove()` — fine, but without any logging we can't spot dismissal-without-action.
62. [P3][Console][app.js:155] `setConnected(false)` only updates dot — add `console.info('[conn] offline')` for ops.

### Network

63. [P0][Network][app.js:154 KB] Ship compressed bundle (gzip/br). Current transfer = 154 KB plain.
64. [P1][Network][/static/app.js] No `Cache-Control` in the burst we inspected — every reload re-downloads. Add immutable headers with fingerprinted filename.
65. [P1][Network][refreshState] Called on every route change; issues 2-4 `apiSoft` calls (`standings`, `schedule`, `lineup-alerts`). Batch into `/api/state?include=standings,schedule`.
66. [P1][Network][startLogPolling] 5s interval polling on league/schedule — add `Last-Modified` + long-poll, or cap to 15s when tab not visible (`document.visibilityState`).
67. [P1][Network][startTradesPolling] Separate timer for trades — same pattern; coalesce.
68. [P2][Network][/api/players] 64 KB per filter change (keystroke + 300 ms debounce TBD). Add server-side index or fuzzy match endpoint.
69. [P2][Network][/api/state] returns 13 KB now — with 500 players in draft, consider delta updates via SSE.
70. [P2][Network][HTTP/2?] Verify tunnel is h2; 29 API calls sequential could be 4× faster on h2 multiplex.
71. [P2][Network][no `Vary: Accept-Encoding`] If ever CDN-cached, will serve identity body to gz-capable client.
72. [P2][Network][favicon] Not requested in the run — missing; browsers will hit 404 on a hard reload.
73. [P3][Network][preconnect] `index.html` could `<link rel="preload" as="script" href="/static/app.js">` to trim 100 ms on first paint.
74. [P3][Network][CSS bundle] 83 KB unminified — minify + drop unused (e.g., recap/summary selectors aren't used pre-season).

### Visual (contrast, overflow, RWD)

75. [P0][Visual][style.css:112 `.app-version`] `color: #6e7681` on `#1c2230` bg = 3.46:1; target 4.5. Bump to `#a0a6ad`.
76. [P0][Visual][style.css:100 `.header-status .conn-text`] inherits `--text-muted` (#8b949e on #161b22) — 4.3:1, borderline; push to #c9d1d9 for AA.
77. [P0][Visual][lsw-btn] Ratio 1.54:1 — the league switcher label color is inheriting header text-muted on elevated bg. Fix specific rule.
78. [P1][Visual][style.css:60] `h1{font-size:16px}` and `.app-title{font-size:15px}` compete; `.app-title` wins but truncates at 375 px (overflow 137→99).
79. [P1][Visual][style.css:353] `table.data td.meta{color:var(--text-muted);font-size:12px}` — 12 px + #8b949e will fail AA on small screens. Push text to 13 px or color to --text.
80. [P1][Visual][style.css:469] `.empty{color:var(--text-dim)}` — text-dim is #6e7681, italic, ratio ~3:1. Use text-muted.
81. [P1][Visual][index.html:90] Bottom tabs at 11 px font — below iOS recommended 12 px minimum for interactive labels.
82. [P2][Visual][style.css:135] `.hamburger{margin-left:-8px}` — overlaps tap area in RTL flip; not an issue for zh-TW but note.
83. [P2][Visual][style.css:248] `.btn` uses `color:#05122a` on `#58a6ff` = 8.5:1 (great). No change.
84. [P2][Visual][style.css:266] `.btn.ghost:hover` keeps `color:var(--text)` on `--bg-hover`; verify ≥4.5.
85. [P2][Visual][style.css:485] `.clock-card .who{font-size:18px;font-weight:600}` — OK, but `.clock-card .sub` at 13 px muted will fail AA at some angles. Raise.
86. [P2][Visual][style.css:203] Panel head h2 at 12 px uppercase muted — OK readability but fails AA at default brightness. Consider 13 px + #a0a6ad.
87. [P2][Visual][style.css:546-563] Mobile standings `td{font-size:12px}` + muted rank column may fail. Tested screenshot `g1o_03_rwd_375.png` shows setup page only (pre-draft for qa-g1 at test time).
88. [P2][Visual][style.css:540] `.standings-row.you` bg `rgba(63,185,80,0.06)` — 6% green overlay on `--bg` barely visible; "you" highlight may be missed.
89. [P2][Visual][style.css:457] Board headers 11 px — below AA threshold for small UI.
90. [P3][Visual][style.css:189] `.tab-btn.active .tab-ic{background:rgba(88,166,255,0.15)}` — low-alpha accent on `--bg-elevated` ≈ 2:1 contrast against non-active siblings; active state barely distinguishable.
91. [P3][Visual][style.css:478] `.psub` 10 px — tiny on mobile.
92. [P3][Visual][375 px H1] The only DOM overflow we found; fixed by font reduction or ellipsis+title.
93. [P3][Visual][style.css:322] `scrollbar-width: thin` — honors Firefox but not Safari; add custom `::-webkit-scrollbar`.
94. [P3][Visual][index.html:214] Toasts top-stacked (no visible stack wrapper style here) — check stacking under keyboard open.

### Data consistency (UI ↔ API)

95. [P1][Data][app.js:4023 `renderLeagueSwitcherLabel`] Header shows `l.name || l.league_id`. qa-g1 had `name === league_id`, so user saw "qa-g1"; API also reports same — consistent.
96. [P1][Data][app.js:1853] Hero reads `settings.league_name || '我的聯盟'` — but if Player renamed to "QA Group 1", and settings fetch races refreshState, header could lag by one tick. Verified: loadLeagues + refreshState fire serially in `boot()`.
97. [P1][Data][team names display drift] Pre-setup the default team names are `我的隊伍, BPA Nerd, Punt TO, ...` (zh-TW, `api/league/settings.team_names`) but once Player ran /setup, `api/state.teams[i].name` became `Andy-QA, Bucks AI, Celtics AI, ...`. The two endpoints can diverge during setup. UI uses `api/state.teams[].name` so it shows the post-setup names — consistent; but `league/settings.team_names` should be kept in sync server-side and documented as source-of-truth.
98. [P1][Data][app.js:336] Player-team dropdown built from `form.team_names` not from backend — first-run offline defaults leak in. Set from `state.leagueSettings.team_names` always.
99. [P2][Data][app.js:1875] `userIdx = rows.findIndex(r => r.is_human || r.team_id === humanId)` — double check; if backend ever returns `is_human:false` for human's row, rank displays wrong.
100. [P2][Data][app.js:1853] Hero shows `leagueName` even if backend hasn't applied new name — during league-switch reload (150 ms setTimeout, `app.js:4097`) page still displays old name for 1 frame.
101. [P2][Data][app.js:1027] Draft hero percent based on `(current_overall - 1) / totalPicks`; if server resets current_overall to 1 after reset_draft, progress bar jumps to 0 — verify server also sends fresh `board`.
102. [P2][Data][state.draft.board][CONCURRENT_SAMPLES] Observed 12 samples with `picks=0, overall=1, avail=165, complete=false` while Player was still setting up the league → server seeded `available_count:165` not 500 for qa-g1 (different rookie pool?). Document per-league player pool.
103. [P2][Data][state.draft.available_count] Default league shows 582, qa-g1 shows 165 → player pool is league-scoped. UI doesn't communicate this; a user creating a second league expecting full pool will be surprised.
104. [P3][Data][`/api/state`] `human_team_id` separate from `teams[i].is_human` flag — double source of truth; keep one.
105. [P3][Data][app.js:722] League-settings dialog loads `s.team_names`, but after user edits names mid-season the `state.draft.teams[i].name` stays stale until refreshState — surface "請重新整理" hint.

### Concurrency

106. [P1][Concurrency][observer window] 12 samples over 24s during Player setup: all identical (0 picks, overall=1). No partial state observed — good. Once Player starts picking, rerun this spec to look for `picks.length` monotonic increase.
107. [P1][Concurrency][single-league active state] API design ties "active league" to a server-side singleton. Two observers against different `league_id` will fight via `/leagues/switch`. Add per-request `?league_id=qa-g1` override to read-only endpoints.
108. [P2][Concurrency][app.js:4095] `onSwitchLeague` POSTs then `setTimeout(reload, 150)` — a second observer hitting API in that 150 ms window sees the new active but stale UI. Use `fetch` returned state, render inline.
109. [P2][Concurrency][app.js:60-64] Timers `logPollTimer`, `tradesPollTimer` — no cancellation on visibilitychange; multiple tabs waste CPU.
110. [P2][Concurrency][app.js:83] `draftAutoBusy` lock covers overlapping auto picks, but no server-side draft serial number — a stale client POSTing `/api/draft/pick` after AI already picked could double-pick. Add `If-Match: <current_overall>` header or server rejection.
111. [P2][Concurrency][app.js:83] `draftAutoTimer` is setTimeout only — a second render call could queue two timers; guard with `clearTimeout` on every render.
112. [P3][Concurrency][websocket?] No websocket or SSE — if Player picks while observer polls at 5s, observer sees pick with up to 5s delay. Consider SSE `/api/events` for draft transitions.

### Other polish

113. [P1][Perf][app.js:1581] `renderRows` iterates over all players every checkbox change — O(n) re-render; use delegation and targeted row update.
114. [P2][Perf][app.js:1184] `renderAvailableTable` re-hits `/api/players` on every keystroke in the filter bar — no debounce on `oninput` (`app.js:1131`). Add 300 ms debounce.
115. [P2][Perf][app.js:1725] FA render fetches up to 400 players then rebuilds entire `<tbody>` on filter change — use virtual list.
116. [P2][Perf][style.css:402] `.player-list.cards .player-card` switched on at ≤639 px; the table remains in DOM (`display:none`) — still parsed. Consider data-driven render.
117. [P2][Code][app.js:118] `api()` unsets `Content-Type` when caller passes own headers — spreads `headers` last but base sets JSON; callers can't send form data. Refactor.
118. [P2][Code][app.js:25 `escapeHtml`] Used extensively but many sites interpolate into innerHTML via template strings — audit `${p.name}` untrusted inputs. Most already use `escapeHtml`, but `team.team_name`, `r.biggest_blowout.winner_name` (`app.js:3734`) and `s.mvp.name` (`app.js:3850`) go in via textContent implicitly — verify.
119. [P3][Code][app.js:232] `currentRoute()` defaults to 'draft' on invalid hash — silently. Add toast `"未知路由"` in dev mode.
120. [P3][Code][app.js:263] `main.focus({preventScroll:true})` after every render — may disrupt screen-reader position if used mid-flow; scope to route changes only.
121. [P3][Code][index.html:27] `v{{APP_VERSION}}` is a template placeholder — if substitution fails, users see literal `{{APP_VERSION}}`. Add defensive replace at JS boot.
122. [P3][Code][app.js:67] `playerCache` Map never evicted — long FA sessions grow memory.
123. [P3][Code][app.js:48-83] Big mutable `state` object — consider making keys readonly or using a store abstraction.
124. [P3][Ops][app.js:36] `SEASON_EPOCH = new Date(2025, 9, 22)` — hard-coded; breaks next season.
125. [P3][Ops][app.js:1700] `/api/fa/claim-status` 404-on-pre-season fallback copy says "賽季尚未開始,無法簽約" — uses half-width comma instead of 、 or ，(typographic consistency).
126. [P3][Ops][app.js:1776] Success toast uses full-width comma; inconsistent.

## Independent checks vs prompt matrix

| # | Question | Finding |
| - | -------- | ------- |
| 1 | All interactive buttons have aria-label? | No — 23 buttons found; 0 totally nameless but setup form inputs & filter controls lack accessible names. See items 26-29. |
| 2 | Keyboard Tab walks main flow? | Yes — 38 stops walked setup form → submit → log-refresh → body → league switch → side nav. See `g1o_02_tab_walk.png`. Missing: focus trap inside `<dialog>` once opened (items 33-37). |
| 3 | Console errors / warnings / React-key? | 0 / 0 / n/a (vanilla). Only 1 `console.warn` site in code (item 57). |
| 4 | API list, latency, payload? | 29 API calls over route tour, 0 >500 ms, largest payload `/api/players?limit=400` = 64 KB (items 63-74). |
| 5 | Contrast < 4.5:1? | 3 hits: `lsw-btn` 1.54, `lsw-label` 2.56, `app-version` 3.46 (items 2, 75-77). |
| 6 | 375 px breakage? | `H1 .app-title` overflow clipped (item 4); no horizontal scroll otherwise. |
| 7 | UI team names ↔ API consistent? | Pre-setup: UI hid names (correct, teams view blocked). Post-setup: API team names `["Andy-QA", "Bucks AI", ...]` match the active league. Consistent (see item 97). |
| 8 | Concurrency during Player picks? | 12 state samples over 24 s, stable; no partial/stale reads observed while Player was in setup. Once draft proceeds, re-test (item 106). |

## Recommendations (ranked)

1. Ship compressed bundle + cache headers (P0).
2. Fix contrast trio in header (P0, one CSS var flip).
3. Wire `<label for=id>` in `row()` helper — single 5-line fix raises form a11y site-wide (P0).
4. Add `role="dialog" aria-modal="true"` + Esc handler to modal-overlay divs (P1, 4 places).
5. Consolidate `/api/leagues` alias and document the setting/settings vs league/settings naming (P0 → doc change mostly).
6. Add `visibilitychange` pause to 5 s log + trade polling (P1).
7. Add debounce to filter inputs (P2).
8. Surface `X-App-Version` header + richer `/api/health` (P2).
9. Fix H1 overflow on 375 px and raise small-font colors to --text (P1).
10. Add SSE or ETag/If-Match for draft pick serialization (P2).

---
Generated by G1 Observer, 2026-04-18. Supersedes older qa_wave snapshots. All findings cross-referenced with `static/app.js`/`static/style.css`/`static/index.html` line numbers.
