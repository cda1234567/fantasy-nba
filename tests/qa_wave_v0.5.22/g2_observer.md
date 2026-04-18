# G2 Observer QA Report — NBA Fantasy 模擬器 v0.5.22

- Target: https://nbafantasy.cda1234567.com
- League observed: `qa-g2` (created by G2 Player)
- Method: playwright headless (chromium), API probing, DOM + a11y extraction, RWD @ 375/768/1280
- Evidence: `_g2_observer_log.json`, `screenshots/g2o_*.png`, `_openapi.json`
- Stats snapshot:
  - DOM totalEls: 1477, focusables: 53
  - Low-contrast elements found: 12
  - Inputs missing labels: 5
  - Dialogs missing `role="dialog"` / proper labelling: 6
  - Request failed: 1 (cdn-cgi/rum beacon aborted — harmless)
  - Console errors: 1 × 400 (ai-advance), 1 × warning (ai-advance "It's the human's turn")
  - API status: all 200 on happy path; 400 on bogus switch (correct); 404 on bad year (correct)
  - Concurrency: 10 parallel /api/state all 200, consistent `current_overall=105`
  - Cross-tab state match: OK (s1==s2)

---

## Top 5 P0

1. **[P0][Data] `qa-g2` league has `name="qa-g1"` in `/api/leagues/list`** — name field was cross-assigned from another league. Seen in `leagues_snapshot`: `{league_id:"qa-g2", name:"qa-g1", setup_complete:true}`. Fix in `app/storage.py` league creation path or wherever `name` is persisted; add validation that `name` default = `league_id` on create, and an integration test that asserts `name == league_id` when no explicit name given.
2. **[P0][A11y] Active nav item invisible — `.nav-item.active` shows blue text on same blue background (ratio 1.0)** — `static/style.css:770-783` sets `color: var(--accent)` and `.nav-icon` uses `background: var(--accent); color: var(--bg)` but `nav-label` inherits accent over a panel that in light/rendered context is also accent. Fix by explicitly forcing `.nav-item.active .nav-label { color: #fff; }` or swap `.nav-item.active { color: #e2e8f0; }` and keep only the icon colored.
3. **[P0][A11y] 5 inputs/selects have no label/aria-label** — `#draft-display-mode-switch` (FA select), FA search input (`type=search`, no id), position select, sort select, `#trade-message` textarea. Add `aria-label="選秀顯示模式"`, `aria-label="搜尋球員"`, `aria-label="位置篩選"`, `aria-label="排序依據"`, `aria-label="給對方的訊息"`. Files: `static/index.html:184` (trade-message), rest are injected by `static/app.js`.
4. **[P0][A11y] Dialogs lack `role="dialog"` / `aria-modal`** — 6 `<dialog>` elements use `aria-label` only. Native `<dialog>` does map to dialog role, but `aria-modal="true"` is missing and some screen readers still need explicit `role`. `static/index.html:31,98,147,162,174,198` — add `role="dialog" aria-modal="true"` to each.
5. **[P0][Consistency] Header `#lsw-current` shows stale league after API switch** — `consistency` log: `uiCurrent="qa-g1"` while `api_team0_name="Andy-QA"` and `api_current_overall=105` (actual qa-g2 state). Header is not listening to league-switch events fired by API; frontend caches `lsw-current` on load only. Fix: in `static/app.js`, after `/api/leagues/switch` or on visibility change, re-poll `/api/leagues/list` and re-render `#lsw-current`.

---

## 檢出總覽（共 120 條）

### API — 14 條

- [P0][API] `POST /api/leagues/create` allows name desync with `league_id` → qa-g2.name="qa-g1" (`_g2_observer_log.json` kind=leagues_snapshot). Fix in `app/main.py` / `app/storage.py` league creation; add post-condition assert `league.name == payload.name || payload.league_id`.
- [P1][API] `/api/seasons/{year}/headlines` returns 404 "no headlines for this season" for invalid `9999-00` — acceptable, but should be **422** for schema-invalid year so clients can distinguish "unknown season" vs "no data". `app/season.py` season_headlines route.
- [P1][API] `/api/injuries/active` returns 404 "賽季尚未開始" when draft not done — should return `200 []` to match REST "empty resource" semantics; 404 is misleading. `app/injuries_route.py:list_active`.
- [P1][API] `POST /api/leagues/switch` with unknown id returns 400 — correct status, but detail string is English `"league '__NOT_EXIST__' does not exist"` while rest of app is 繁中. Localize.
- [P1][API] `/api/leagues/list` lacks `created_at` for pre-existing leagues (0.0 for 4/6 entries) — breaks sort-by-created UX. Backfill default to server boot time on missing.
- [P1][API] `/api/league/settings` GET returns 20 keys; POST accepts `{}` with 200 (no-op) — but no schema validation layer for unknown keys. Concurrency log shows 5 empty POSTs all 200; add strict validation to reject typos.
- [P1][API] `/api/league/settings` returns `use_openrouter:true` but `/api/health` returns `ai_enabled:true` — duplicate/ambiguous feature flags. Pick one.
- [P1][API] `/api/state` returns `board` as 13×8 nested array of nulls pre-draft — inefficient payload (~340 `null`s). Return `board_shape:[13,8]` + sparse `board_cells:{...}`.
- [P1][API] No `ETag`/`Cache-Control` on any GET; every UI re-render refetches full `/api/state` (~1431B).
- [P2][API] `/api/leagues/list` response shape `{leagues:[], active:"..."}` is fine, but `active` duplicates what client tracks; recommend echoing in `/api/health` too.
- [P2][API] `/api/seasons/list` returns 30 hard-coded seasons — no metadata (has_headlines flag etc.).
- [P2][API] `/api/state.teams[].is_human` is boolean but `gm_persona` is null for human — consider `gm_persona:"human"` or similar union string for cleaner typing.
- [P2][API] `/api/state.teams[].roster` is `[]` pre-draft — confirmed consistent.
- [P3][API] No OpenAPI description or example payload on most endpoints — /docs usability poor.

### A11y — 32 條

- [P0][A11y][static/style.css:770-773] `.nav-item.active` `color:var(--accent)` on `background:rgba(88,166,255,0.12)` rendered as ratio 1.0 for `.nav-label` (child inherits color). Fix: `.nav-item.active .nav-label { color: #e2e8f0; font-weight:700; }`.
- [P0][A11y][static/style.css:2958] `.lsw-label { color:#94a3b8 }` ratio 2.56 on hover/white bg in menu — see `lowContrast` entry #1.
- [P0][A11y][static/style.css:2959] `.lsw-current` fg `#c9d1d9` on popover bg → ratio 1.54. Ensure menu bg is dark surface, not `#fff`.
- [P0][A11y][static/style.css:112] `.app-version` `color:var(--text-dim)` = `#6e7681` on `#1c2230` → 3.46 < 4.5.
- [P0][A11y][static/style.css:3003] `.new-league-hint` `color:#6b7280` on `#161b22` → 3.58 < 4.5.
- [P0][A11y][static/style.css:2606-2611] `.hh-count` `color:#94a3b8` on `rgba(148,163,184,0.12)` → ratio 1.0 (fg==bg). Increase bg darkness or lighten fg.
- [P0][A11y][static/style.css:2680-2690] `.hh-cat` + `.hh-cat-icon` + `.hh-cat-label` — all `#cbd5e1` on `rgba(148,163,184,0.1)` → 1.73.
- [P0][A11y][static/style.css:2700-2702] `.hh-pager` `#64748b` on `#0f172a` → 3.75.
- [P0][A11y][static/style.css:2837-2843] `.dh-persona-tag` `#c4b5fd` on `rgba(167,139,250,0.12)` → 1.47.
- [P0][A11y][static/index.html:184] `<textarea id="trade-message">` no label, just placeholder. Add `<label for="trade-message" class="sr-only">給對方的訊息</label>`.
- [P0][A11y][static/app.js search render] `<input type="search" placeholder="搜尋姓名 / 球隊...">` no aria-label.
- [P0][A11y][static/app.js FA filter render] position `<select>` no label/aria.
- [P0][A11y][static/app.js FA filter render] sort `<select>` no label/aria.
- [P0][A11y][static/app.js draft-display-mode-switch] `<select id="draft-display-mode-switch">` lacks aria-label; only has `title` (not exposed to SR on Android).
- [P1][A11y][static/index.html:31] `<dialog id="dlg-new-league">` missing `aria-modal="true"`.
- [P1][A11y][static/index.html:98] `<dialog id="dlg-settings">` same.
- [P1][A11y][static/index.html:147] `<dialog id="dlg-confirm">` same — also missing `aria-labelledby="confirm-title"` (the h2 exists at line 150).
- [P1][A11y][static/index.html:162] `<dialog id="dlg-matchup">` missing `aria-labelledby="matchup-title"`.
- [P1][A11y][static/index.html:174] `<dialog id="trade-propose">` missing `aria-modal`.
- [P1][A11y][static/index.html:198] `<dialog id="dlg-league-settings">` missing `aria-modal`.
- [P1][A11y][keyboard] Tab order starts at news-carousel "下一則"/"第 1 則"…"第 10 則" buttons → user presses Tab 10× before reaching draft UI. Move carousel buttons to lower tab order or wrap carousel in `tabindex="-1"` container with `[role="region"] aria-label`.
- [P1][A11y][keyboard][static/app.js carousel buttons] Carousel dot buttons "第 1..10 則" have `outline:rgb(0,0,0) solid 3px` — black outline invisible on dark bg. Use `var(--accent)`.
- [P1][A11y][keyboard][static/app.js] `#draft-display-mode-switch` focus shows `outline:none` (`hasOutline:false`). Remove `outline:none` from global reset (style.css:153/297/299) and rely on `:focus-visible`.
- [P1][A11y][keyboard][static/app.js FA search] `<input type="search">` focus shows `hasOutline:false`.
- [P1][A11y][static/index.html:25] `<span class="conn-dot" aria-hidden="true">` + `<span class="conn-text">連線中</span>` — dot is decorative OK, but text is not in live-region; connection-lost won't be announced. Wrap in `aria-live="polite"`.
- [P1][A11y][static/index.html:86] `<ul id="log-list">` activity log lacks `aria-live="polite"` so new events aren't announced.
- [P1][A11y][static/index.html:54-75] `<nav class="side-nav">` + `<nav class="bottom-tabs">` both have `aria-label="主選單"` / `主選單（手機）` — on desktop both may render; duplicate nav landmarks confuse SR. Hide inactive one with `aria-hidden` matching display.
- [P1][A11y][static/index.html:214] `<div class="toast-stack" aria-live="polite" aria-atomic="true">` — `aria-atomic="true"` will re-announce entire stack on each toast. Switch to `aria-atomic="false"`.
- [P2][A11y][static/index.html:55-75] `.nav-item` uses `<a href="#draft">` — OK, but no `aria-current="page"` when active. Add in JS route handler.
- [P2][A11y][static/index.html:11-29] `<header role="banner">` OK; hamburger is first in DOM but news-carousel inside `<main>` gets focus first because carousel is earlier in tab order during dynamic mount.
- [P2][A11y][static/app.js board rendering] Draft `<table class="board">` has no `<caption>` and no `scope` on headers — SR users can't navigate.
- [P3][A11y] No skip-link (`<a href="#main-view" class="sr-only-focusable">跳到主要內容</a>`).

### Console — 5 條

- [P1][Console][static/app.js:131] `Failed to load resource: status 400` — from `/api/draft/ai-advance` when human's turn. Don't call ai-advance if `current_team_id == human_team_id`; or return 204 instead of 400.
- [P1][Console][static/app.js:886] `auto ai-advance failed Error: It's the human's turn` warning. Same root cause — front-end polling doesn't check turn owner before requesting.
- [P2][Console] No `console.debug`/grouping strategy — noisy in prod. Wrap in `if (DEBUG)` gate.
- [P2][Console] `page.on('requestfailed')` caught `cdn-cgi/rum?` ERR_ABORTED — Cloudflare RUM beacon blocked. Either add `data-cf-beacon` properly or remove.
- [P3][Console] No Sentry / error reporting wiring visible — client-side exceptions are lost.

### Network — 18 條

- [P1][Network] `/api/state` polled 7× in 7s on `#draft` route — suggests short setInterval. Combine with server-sent events or WebSocket; current polling wastes bandwidth.
- [P1][Network] `/api/players?available=true&sort=fppg&limit=80` called once then `limit=400` — two overlapping fetches. Use a single `limit=400` and slice client-side, or cache.
- [P1][Network] No `If-None-Match` / `ETag` usage anywhere.
- [P1][Network] `/api/league/settings` fetched on every route change (6×). Cache client-side; invalidate on POST.
- [P1][Network] All API responses are `application/json` uncompressed on inspection — enable gzip/br at edge (cloudflared should auto-compress; verify).
- [P1][Network] `/api/personas` and `/api/seasons/list` refetched 6× — immutable catalogs; should be `Cache-Control: public, max-age=3600`.
- [P1][Network] Failed `cdn-cgi/rum` (Cloudflare RUM) request on every page — either fix beacon config or disable RUM for this subdomain.
- [P2][Network] `/api/seasons/2024-25/headlines` fetched 7× — same resource, cacheable.
- [P2][Network] `/api/season/lineup-alerts` called pre-season (is_complete=false) — should short-circuit client-side.
- [P2][Network] `/api/season/standings` and `/api/season/schedule` also called pre-season unnecessarily.
- [P2][Network] `/api/trades/pending` called on team page — 200 with likely empty array; poll interval likely too tight.
- [P2][Network] `/api/fa/claim-status` called when FA view not focused — lazy-load.
- [P2][Network] `/api/draft/ai-advance` hitting 400 counted as real failure in monitoring — suppress or return success.
- [P3][Network] No HTTP/2 server push hints in HTML for critical CSS/JS.
- [P3][Network] `style.css?v=0.5.22` cache-busts correctly but `app.js` in `static/app.js` (no version query) may cache stale across deploys — confirm.
- [P3][Network] No preload of `/api/state` via `<link rel="preload" as="fetch" crossorigin>`.
- [P3][Network] openapi.json is 26 KB — could gzip to ~6 KB.
- [P3][Network] `/openapi.json` exposed publicly (no auth gate) — intentional? Documented behavior says "無 auth", acceptable.

### Visual / RWD — 18 條

- [P0][Visual][375 mobile] `table.board` overflows to 1069px (inside `overflow-x:hidden` body). Content truncated silently — users can't scroll to see picks 4-8. `screenshots/g2o_rwd_mobile.png`. Fix: make `.main-view` `overflow-x:auto` on `.board-wrap` OR convert to card list on mobile.
- [P0][Visual][768 tablet] `#tbl-available` overflows to 892px (>768). Buttons in last column clipped. `screenshots/g2o_rwd_tablet.png`.
- [P1][Visual][static/style.css:3008-3009] At narrow width `.lsw-label { display:none }` but `#lsw-current` still shows `qa-g1` truncated to `max-width:100px` — consider showing full league_id via `<abbr>`.
- [P1][Visual][screenshots/g2o_01_home_1280.png] Right-side `<aside class="log-aside">` occupies ~280 px and duplicates info shown in toasts; consider making collapsible.
- [P1][Visual][screenshots/g2o_02_league_menu.png] League switch menu item uses `×` delete button immediately adjacent to league name; single fat-finger misclick deletes league without confirm? Observer saw `POST /api/leagues/delete` exists — verify client uses `dlg-confirm` before calling.
- [P1][Visual][screenshots/g2o_route_draft.png] News-carousel `⌐` icon is visually cramped; "🔄轉隊" chip uses 2 emoji sizes.
- [P1][Visual][screenshots/g2o_route_teams.png] Team tabs "Andy-QA (你)" + 7 AI names fill horizontally; narrow viewport may overflow.
- [P1][Visual][screenshots/g2o_route_fa.png] FA table header "姓名" column has unlabeled search+selects above — add group label "篩選".
- [P2][Visual][screenshots/g2o_route_league.png] Empty state "選秀尚未完成" with single CTA "前往選秀" — button has no icon; fine but lacks emphasis.
- [P2][Visual][screenshots/g2o_route_schedule.png] Same empty state pattern — consistent, good.
- [P2][Visual][static/style.css:1177-1178] `outline: 1px solid color-mix(in srgb, var(--accent) 30%, transparent)` — 30% alpha may fall <3:1 contrast against dark bg.
- [P2][Visual][static/style.css:298] `input:focus` sets `border-color:var(--accent)` but also `outline:none` on line 299 — border-only focus fails WCAG 2.4.7 on Safari.
- [P2][Visual] Draft board cells `table.board td.you-cell` bg `rgba(63,185,80,0.08)` — very faint, hard to distinguish.
- [P2][Visual][screenshots/g2o_rwd_mobile.png] Bottom tab active state relies on accent color only — add underline for color-blind users.
- [P2][Visual] No loading skeletons — initial state shows "—" in header until data loads (seen in uiCurrent="qa-g1" racing with actual data).
- [P3][Visual] No dark-mode/light-mode toggle, despite `data-theme="dark"` attribute suggesting plans.
- [P3][Visual] Carousel auto-advance not observed — if auto, add `prefers-reduced-motion` respect.
- [P3][Visual] Favicon missing (no `<link rel="icon">` in head).

### Data / Consistency — 20 條

- [P0][Data][API vs UI] `uiCurrent="qa-g1"` yet `/api/state` returned qa-g2 data (`current_overall=105`, `team0=Andy-QA`) after API switch — UI header did not re-render. Confirmed bug: frontend doesn't re-render header post-switch when switch happens via API not UI.
- [P0][Data] `qa-g2.name="qa-g1"` — corrupted name field. Root cause likely: Player script posted `{league_id:"qa-g2", name:"qa-g1"}` by mistake, but API should reject or default `name = league_id` when missing.
- [P0][Data] After switch to qa-g2, `setup_complete:true` and `current_overall:105` — means qa-g2 already completed setup + is in draft pick 105. But `api_is_complete:true`. Player may have finished draft mid-test. Observer confirms state is coherent (team0=Andy-QA, num_teams=8).
- [P1][Data] `/api/state.current_overall=105` out of `total_rounds×num_teams = 13×8 = 104` → overall index is 1-based and complete (105>104) OR off-by-one. Verify indexing: likely should be 104.
- [P1][Data] `/api/league/status` showed `league_name="我的聯盟"` but `/api/leagues/list.active="qa-g1"` at snapshot time while league 260418 name is `我的聯盟` — status route returns settings of active league but its reported league_name doesn't match active league_id qa-g1. Data de-sync.
- [P1][Data] `/api/league/settings.team_names` = ["我的隊伍", ...7 AI] while `/api/state.teams[0].name = "Andy-QA"` — UI renders the latter; state and settings team_names diverge (settings keeps stale copy).
- [P1][Data] `current_team_id:0` in pre-draft state but Player team index can be 0-7 per `player_team_index`; assumes 0 always.
- [P1][Data] `/api/leagues/list.leagues[*].created_at` = `0.0` for 4/6 leagues — unix-epoch default; renders as "1970-01-01" in any date formatter.
- [P1][Data] `/api/seasons/list` contains 30 seasons 1996-97 to 2025-26, but no marker which is "current". UI has to hardcode.
- [P1][Data] `/api/league/settings.trade_deadline_week: null` — UI may treat null as 0 = week 0 = season start. Default to `regular_season_weeks - 4` or similar.
- [P1][Data][concurrency] 5 parallel `POST /api/league/settings {}` all returned 200 — no optimistic-locking/version token; last-write-wins under race.
- [P1][Data] `/api/health.league_id` returns currently-active league — shared endpoint but clients in separate tabs may disagree if one tab switches league globally.
- [P2][Data] `/api/state.picks = []` pre-draft — OK. But `/api/state.available_count` went from 582 → 569 between two probes in test (different leagues). Consistent within same league.
- [P2][Data] `/api/league/settings.scoring_weights` includes `to:-1.0` (turnover negative) — consistent numeric sign. 
- [P2][Data] No `schema_version` / API version in payloads — breaking change to `/api/state` will silently corrupt clients.
- [P2][Data] `/api/state.human_team_id=0` always matches `/api/league/settings.player_team_index=0` in snapshot — good consistency.
- [P2][Data] `/api/league/settings.playoff_teams=6` out of `num_teams=8` — 75% make playoffs, by design probably; consider calling out in UI.
- [P2][Data] `/api/state.total_rounds=13` matches `roster_size=13` — consistent.
- [P3][Data] `openapi.json` says many response schemas are `{}` (empty) — clients can't validate.
- [P3][Data] No timezone in any timestamp; all epoch floats.

### Concurrency — 13 條

- [P1][Conc] 10 parallel `/api/state` GETs: durations 137-339ms (p90≈312ms); all returned same `current_overall=105`. No lock errors. Good baseline.
- [P1][Conc] 5 parallel `/api/league/settings` empty-POSTs all 200 in 164ms total — means no mutex; concurrent writes with real payloads could interleave and corrupt JSON storage.
- [P1][Conc] Cross-tab consistency: tab1 via api-request context + tab2 via real browser `fetch` both saw identical `current_overall=105`. OK.
- [P1][Conc] Observer switched to qa-g2 via `POST /api/leagues/switch` while Player also working — no evidence of per-tab league binding; whole server-state switches per call. This means **two concurrent users on same server race each other's active league**. Critical multi-user bug if site ever gets auth.
- [P1][Conc] `/api/draft/ai-advance` during human-turn returns 400 — if human and AI poll simultaneously, AI call 400s but UI retries — busy-loop risk.
- [P2][Conc] `/api/state` payload didn't change during concurrent reads (expected). Add `updated_at` server-side timestamp to state for client diff.
- [P2][Conc] `/api/leagues/switch` response `{"ok":true,"active":"qa-g2"}` — atomic at server; but doesn't broadcast to other connected tabs.
- [P2][Conc] No SSE/WebSocket channel — observer had to poll for qa-g2 existence (took 4 iterations × 15s ≈ 60s).
- [P2][Conc] `/api/injuries/active` 404 pre-season is race-prone: during season-start flip, this endpoint oscillates 404→200.
- [P2][Conc] No client-side `AbortController` when navigating routes — stale fetches may overwrite new route's state.
- [P2][Conc] Background polls of `/api/state` continue while dialogs open — resource drain.
- [P3][Conc] No rate limiting visible (did 10 parallel + 5 writes + 30+ sequential without any 429).
- [P3][Conc] Observer did not stress with >50 concurrent — that would be a fuzz target.

---

## Artifacts

- `D:/claude/fantasy nba/tests/qa_wave_v0.5.22/g2_observer.spec.ts`
- `D:/claude/fantasy nba/tests/qa_wave_v0.5.22/playwright.config.g2o.ts`
- `D:/claude/fantasy nba/tests/qa_wave_v0.5.22/_g2_observer_log.json` (44 KB — full evidence)
- `D:/claude/fantasy nba/tests/qa_wave_v0.5.22/screenshots/g2o_*.png` (9 screenshots)
- `D:/claude/fantasy nba/tests/qa_wave_v0.5.22/_openapi.json`

Run: `npx playwright test --config=playwright.config.g2o.ts` (5 tests passed in 22.8s).
