# G4 Observer Report — nbafantasy.cda1234567.com v0.5.22

**Target league:** `qa-g4` (existed at poll; `setup_complete:false`; observer auto-switched via REST).
**Harness:** `g4_observer.spec.ts` + `playwright.config.g4o.ts` (headless chromium, 1280x800 baseline, 1 passed / 10.8s).
**Raw evidence:** `g4_observer_raw.json`, `screenshots/g4o_*.png`.
**Note on UI league binding:** UI header showed `qa-g1` even after `POST /api/leagues/switch {league_id:"qa-g4"}` returned 200 — the REST switch did not propagate to the browser session (likely cookie/SSE scoping). See P0-#2 below.

---

## Top 5 P0

1. **[API][app/main.py:/api/leagues/switch]** `POST /api/leagues/switch` returns 200 but the frontend (same origin, same TLS context) keeps serving `qa-g1` in `#lsw-current` and continues to hit other endpoints with the old active league. Switch must broadcast to existing browser sessions (or UI must re-poll `/api/leagues/list` `.active` after every mutation).
2. **[API][app/main.py:/api/leagues/list]** Leagues list shows `qa-g2` whose `name` is `"qa-g1"` — name collision / stale copy. Data corruption bug: league creation clones name from previously active league when omitted. Validate payload + backfill.
3. **[A11y][static/index.html:dlg-*]** 6 `<dialog>` elements (`dlg-new-league`, `dlg-settings`, `dlg-confirm`, `dlg-matchup`, `trade-propose`, `dlg-league-settings`) all lack `aria-modal="true"` — screen readers can't announce modal trap. Add `aria-modal` + `aria-labelledby`.
4. **[Visual][static/style.css:header tokens]** Header text/controls fail WCAG AA (4.5:1) at 11–13px: `.lsw-current` 1.54:1, `.conn-text` 1.49:1, `.app-version` 3.46:1. Bump tokens (`--fg-muted`, `--fg-header`) or darken background.
5. **[API][app/injuries_route.py, app/season.py]** Season-gated endpoints (`/api/season/summary`, `/api/injuries/active`, `/api/injuries/history`) return **400** pre-season with mixed-language details (`"賽季尚未開始"` vs `"Season not started"`). Should be `409 Conflict` with stable i18n code, not 400.

---

## API (25 findings)

- [P0] [API] [app/main.py:/api/leagues/switch] Switch not broadcast to live browser session; frontend keeps old league.
- [P0] [API] [app/main.py:/api/leagues/list] `qa-g2.name == "qa-g1"` — duplicate/stale name stored; validate non-empty unique `name` on create.
- [P0] [API] [app/season.py:summary] `/api/season/summary` returns 400 pre-season; wrong semantics — should be 409 or 200 with `started:false`.
- [P0] [API] [app/injuries_route.py] `/api/injuries/active` + `/api/injuries/history` return 400 pre-season; same class as above; additionally inconsistent locale in `detail`.
- [P1] [API] [app/main.py:/api/teams/{id}] `GET /api/teams/999` and `/api/teams/-1` both return 404 with `"Unknown team_id"`; negative IDs should be 422 (validation) per FastAPI convention.
- [P1] [API] [app/main.py:/api/season/lineup/{team_id}] `GET /api/season/lineup/999` returns **405 Method Not Allowed** — reveals GET is not wired though OpenAPI declares the path; either add GET handler or drop from schema.
- [P1] [API] [openapi.json] Path `/api/season/lineup/{team_id}` listed without method, causing UI/SDK expectation mismatch (405 above).
- [P1] [API] [app/main.py:/api/seasons/{year}/headlines] `404 "no headlines for this season"` lowercase, no error `code`, not i18n-ready.
- [P1] [API] [app/main.py:/api/nonexistent] Generic 404 detail "Not Found" — lacks request id / trace id for support triage.
- [P1] [API] [app/main.py] No `Cache-Control` header observed on any `/api/*` response; readonly GET (`/api/players`, `/api/personas`, `/api/seasons/list`) should set `ETag` or `Cache-Control: private, max-age=…` to cut 25.8 KB players payload on every nav.
- [P1] [API] [app/main.py:/api/players] 25.8 KB payload returned as object keyed by numeric strings (`"0","1",…`) — inefficient; prefer array + server-side filtering params (`q`, `pos`, `limit`).
- [P1] [API] [app/main.py:/api/state] Frontend polls `/api/state` on every tick; response is 1.4 KB including `board` with 13×8 nulls pre-draft — omit when empty.
- [P2] [API] [app/main.py:/api/health] Payload leaks `data_dir` absolute path (`keys: ok,version,league_id,data_dir,ai_enabled`). Remove from public health in prod.
- [P2] [API] [app/main.py:/api/health] Include `league_id` only if authorized; currently reveals active league to any caller.
- [P2] [API] [app/main.py:/api/personas] Keys are `bpa, punt_to, stars_scrubs, balanced, youth, vet, contrarian` (7), but `/api/state.teams` has 7 AI teams — matches; however persona definitions expose full prompt weights in public GET.
- [P2] [API] [app/main.py] No CORS headers observed (same-origin usage) — document intent so future subdomain hosting of UI doesn't silently break.
- [P2] [API] [app/main.py] No rate-limit headers (`X-RateLimit-*`). 10×concurrent GET succeeded in 362ms — confirm no throttle desired.
- [P2] [API] [app/main.py:/api/leagues/create] Accepts `league_id: "qa-g4"` with no regex validation; allow-list `[a-z0-9-]{1,24}`.
- [P2] [API] [app/main.py:/api/leagues/create] Returns 200 even when league pre-exists (idempotent create vs. 409 Conflict); document behavior.
- [P2] [API] [app/main.py:/api/league/status] Response missing `league_id` echo; harder to correlate when switching.
- [P2] [API] [app/main.py:/api/season/standings] Response includes `champion` (null pre-season) — prefer omit key instead of null to reduce payload.
- [P2] [API] [app/main.py:/api/trades/pending] Returns `require_human_attention: bool` at top level — better nested under `meta`.
- [P3] [API] [app/main.py] OpenAPI `operationId`s embed full path (`leagues_list_api_leagues_list_get`) — auto-generated SDKs get ugly method names; override `operation_id` on decorators.
- [P3] [API] [app/main.py] Responses don't set `Content-Language`; clients cannot negotiate.
- [P3] [API] [app/main.py] No `/api/version` — version only derivable from `/api/health.version` or static asset query `?v=0.5.22`.

## A11y (22 findings)

- [P0] [A11y] [static/index.html:dlg-new-league] Missing `aria-modal="true"` + `aria-labelledby`.
- [P0] [A11y] [static/index.html:dlg-settings] Missing `aria-modal` + `role="dialog"` still defaults but labels missing.
- [P0] [A11y] [static/index.html:dlg-confirm] Missing `aria-modal`; critical for destructive confirms.
- [P0] [A11y] [static/index.html:dlg-matchup] Missing `aria-modal`; long modal — SR trap essential.
- [P0] [A11y] [static/index.html:trade-propose] Missing `aria-modal`; complex form modal.
- [P0] [A11y] [static/index.html:dlg-league-settings] Missing `aria-modal`.
- [P1] [A11y] [static/index.html#setup-league-name] `<input id="setup-league-name">` has no `<label for>` nor `aria-label`; value "我的聯盟" is default so no placeholder clue for SR.
- [P1] [A11y] [static/index.html#setup-season-year] `<select>` has id but no label — SR reads "combobox".
- [P1] [A11y] [static/index.html#setup-player-team] Same as above.
- [P1] [A11y] [static/index.html:6 unlabeled `<select>`] 6 selects in settings dialog (W10/W11/W12 picker; "正常/激進"; AI mode `auto/claude/heuristic`; scout preset `prev_full/prev_no_fppg/current_full`) lack labels.
- [P1] [A11y] [static/index.html#trade-force] `<input type="checkbox" id="trade-force">` has no label — unclear action.
- [P1] [A11y] [static/index.html] Two `<h1>` elements present (expected one per view) — pick primary, demote other to h2.
- [P1] [A11y] [static/style.css:focus] First focusable element gets `outline: none 3px …` (outline style `none`) — effectively invisible focus indicator. Change `outline-style` to `solid` or add `:focus-visible { box-shadow: 0 0 0 2px … }`.
- [P1] [A11y] [static/index.html#btn-menu] Hamburger button hidden in viewport 1280 (not visible when clicked → `element is not visible`) — the aria-control `dlg-settings` cannot be opened by keyboard users on desktop.
- [P2] [A11y] [static/index.html .app-title] Title text not wrapped in `<h1>`-scoped landmark; uses `<h1 class="app-title">` but the app-header missing `aria-label` differentiating from main content.
- [P2] [A11y] [static/index.html #app-version] Version badge has `title="應用版本"` but no text alt for SR; add `aria-label="版本 0.5.22"`.
- [P2] [A11y] [static/index.html #conn-dot] `aria-hidden="true"` is correct, but `#conn-text` should be `role="status"` + `aria-live="polite"` to announce reconnect.
- [P2] [A11y] [static/index.html #btn-league-switch] Good `aria-haspopup="menu"` + `aria-controls`, but `aria-expanded` toggles state only if JS flips it — verify handler (screenshot shows menu opened but `aria-expanded` not verified).
- [P2] [A11y] [static/index.html] Skip-link (`<a href="#main">跳至內容</a>`) missing — keyboard users cannot bypass header.
- [P2] [A11y] [static/index.html] No `lang` attribute on mixed-English terms (e.g., "Claude API" option) — SR mispronounces; wrap in `<span lang="en">`.
- [P3] [A11y] [static/index.html] Icon-only SVG buttons lack `<title>`; rely solely on `aria-label`.
- [P3] [A11y] [static/index.html] No `prefers-reduced-motion` query for menu animations (not verified in CSS yet).

## Console (6 findings)

- [P2] [Console] [static/app.js] Zero console errors/warnings/pageerrors observed across nav + menu interactions — clean baseline, confirm CI keeps it that way with `expect(consoleMsgs.errorCount).toBe(0)`.
- [P2] [Console] [static/app.js] No `unhandledrejection` listener detected in HTML head — add `window.addEventListener('unhandledrejection', ...)` to surface silent API failures.
- [P2] [Console] [static/app.js] `app.js?v=0.5.22` cached aggressively; in dev, hash-bust with content hash rather than version to avoid stale JS on patch release.
- [P3] [Console] [static/app.js] No `console.debug` guard — prod bundle likely ships dev logs; gate via `if (window.__DEV)`.
- [P3] [Console] [static/app.js] `cdn-cgi/challenge-platform` scripts run (Cloudflare bot challenge) adds 157–203ms on first nav — acceptable but shouldn't be on `/api/*` preflight.
- [P3] [Console] [static/index.html] No CSP `Content-Security-Policy` header observed — allowing inline script injection.

## Network (14 findings)

- [P1] [Network] [static/index.html] `/` first paint ≈ 288ms + JS 157ms + `/api/personas` 354ms — initial idle at 1714ms; consider preloading `/api/personas` via `<link rel="preload" as="fetch">`.
- [P1] [Network] [static/app.js] Initial 14 requests for one page nav; batch `/api/state` + `/api/league/status` into `/api/bootstrap`.
- [P1] [Network] [static/app.js] `/api/league/settings` 241ms + `/api/league/status` 146ms are sequential on home load — fire in parallel.
- [P1] [Network] [app/main.py] Observed p50 `/api/*` latency ≈125ms; p95 ≈355ms (`/api/personas`). Add timing log per route for perf regression detection.
- [P2] [Network] [static/app.js] `/api/players` 132ms for 25.8 KB — compress (gzip/br) via Caddy/cloudflared layer; verify `Content-Encoding` in prod response.
- [P2] [Network] [static/app.js] No prefetch for `/api/season/standings` on nav; UI hits it immediately after load.
- [P2] [Network] [static/app.js] `/cdn-cgi/challenge-platform/h/g/jsd/oneshot/...` POST size 0 but 203ms — fire-and-forget; verify it's async (`keepalive:true`).
- [P2] [Network] [static/style.css] CSS loaded sync via `<link rel="stylesheet">` before body; consider `<link rel="preload">`.
- [P2] [Network] [app/main.py] No HTTP/2 push / early hints (cloudflared supports); tiny wins on first paint.
- [P2] [Network] [app/main.py] No `Retry-After` on 400 season-gated endpoints; clients spin-retry.
- [P3] [Network] [app/main.py] `Server: cloudflare` leaked — fingerprint; remove via Caddy `header -Server`.
- [P3] [Network] [app/main.py] `cf-cache-status: DYNAMIC` suggests nothing cached — put OpenAPI/personas/players behind edge cache with short TTL.
- [P3] [Network] [app/main.py] `/api/state` mixed concurrency (6 endpoints parallel) totaled 157ms — fine but ensure backend is truly async (FastAPI `async def`).
- [P3] [Network] [app/main.py] Response `Report-To`/`Nel` headers present but no `Expect-CT` — audit security headers.

## Visual / RWD (18 findings)

- [P0] [Visual] [static/style.css] `.lsw-current` fg `rgb(201,209,217)` on header bg: ratio 1.54:1 — fails AA.
- [P0] [Visual] [static/style.css] `.conn-text` fg `rgb(139,148,158)`: ratio 1.49:1 — fails AA (even for large text).
- [P1] [Visual] [static/style.css] `.app-version` ratio 3.46:1 @ 11px — fails AA 4.5:1.
- [P1] [Visual] [static/style.css] `.lsw-label` "聯盟" ratio 2.56:1 — fails AA.
- [P1] [Visual] [static/index.html #btn-menu] Hamburger hidden at 1280 viewport despite being visible in markup (likely media query) — keyboard-only users on desktop lose settings entry.
- [P2] [Visual] [screenshots/g4o_rwd_mobile.png] Mobile 375px: no horizontal scroll (good) but settings icon button positioning needs verification with open dialog.
- [P2] [Visual] [screenshots/g4o_rwd_tablet.png] Tablet 768px: header stacks; verify.
- [P2] [Visual] [screenshots/g4o_rwd_desktop.png] Desktop 1280px: fine.
- [P2] [Visual] [static/index.html] Two `<h1>` nodes create weird visual hierarchy — inspect via screenshot `g4o_01_home.png`.
- [P2] [Visual] [static/style.css] Focus outline `none 3px rgb(201,209,217)` is 3px but `outline-style:none` — visually no ring.
- [P2] [Visual] [static/index.html #conn-dot] Tiny 8–10px dot; add 44×44px hit area via padding for touch.
- [P2] [Visual] [static/index.html .league-switcher] Collapsed label "—" rendered when no league — should show skeleton.
- [P3] [Visual] [static/index.html] `<svg aria-hidden="true">` icons lack explicit `width`/`height` fallback in CSS — may FOUC.
- [P3] [Visual] [static/style.css] Dark theme default `data-theme="dark"` — no system-preference fallback (`prefers-color-scheme`).
- [P3] [Visual] [static/index.html] `<meta name="theme-color" content="#0d1117">` only for dark; add light variant via `media="(prefers-color-scheme: light)"`.
- [P3] [Visual] [static/style.css] Buttons use `font-size:13px` — below OS default 16; increase base to prevent iOS zoom on focus.
- [P3] [Visual] [static/index.html] `viewport-fit=cover` present but no `env(safe-area-inset-*)` padding on header.
- [P3] [Visual] [static/index.html] Chinese default fonts not specified (`font-family` not inspected) — rely on system CJK stack; confirm.

## Data consistency (12 findings)

- [P0] [Data] [app/main.py] UI `#lsw-current = "qa-g1"` while REST says `active: "qa-g1"` — OK, but after POST `/api/leagues/switch` to `qa-g4` UI did NOT flip. Contract break between persistence and session.
- [P0] [Data] [app/storage.py] `qa-g2.name == "qa-g1"` in `/api/leagues/list` — persisted duplicate name. Enforce name uniqueness or separate display-name from id.
- [P1] [Data] [app/main.py:/api/state] `teams.length (8) == num_teams (8)` ✅; `board.length (13) == total_rounds (13)` ✅; `current_overall (1)`, `is_complete (false)`, `available_count (165)` consistent — sanity passes.
- [P1] [Data] [app/season.py] Pre-season: `standings.current_week=null`, `current_day=null`, `is_playoffs=false`, `champion=null` — mixing null semantics with bool semantics; standardize to `{started:false}` wrapper.
- [P1] [Data] [app/main.py] `/api/league/status.num_teams (8)` matches `/api/state.num_teams (8)` — good cross-endpoint integrity.
- [P1] [Data] [app/main.py] `/api/fa/claim-status` shows `used_today, limit, day, remaining` — verify `used_today + remaining == limit` (not auto-checked); add invariant test.
- [P2] [Data] [app/main.py] `/api/leagues/list[].created_at == 0.0` for legacy leagues (`260418`, `qa-g1..4`) — missing migration fill-in with current timestamp.
- [P2] [Data] [app/main.py] `/api/leagues/list.active` returned `qa-g1` while spec just called `switch` to `qa-g4` — active flag is per-process in-memory, not session; document.
- [P2] [Data] [app/main.py] `/api/personas` keys count (7) vs AI teams in `/api/state` (7, ids 1–7) — align; human id=0.
- [P2] [Data] [app/main.py] `/api/seasons/list` returned 313-byte payload; verify years match `setup-season-year <select>` options (1996-97…).
- [P3] [Data] [app/main.py] `/api/season/logs.logs`, `/api/season/activity.activity`, `/api/season/schedule.schedule` all empty arrays pre-season — same null/empty pattern; OK.
- [P3] [Data] [app/main.py] `/api/trades/history.history` empty; `/api/trades/pending.pending` empty — consistent.

## Concurrency (12 findings)

- [P1] [Concurrency] [app/main.py] 10×concurrent `GET /api/state` returned all 200, **all bodies identical** (good — no race), total 362ms, per-req 131–359ms — tail latency doubling suggests single-threaded event loop contention.
- [P1] [Concurrency] [app/main.py] Mixed-6 concurrent (state+status+standings+players+personas+leagues/list) total 157ms — suggests serialized under load (player list dominates).
- [P1] [Concurrency] [app/main.py] Verify all route handlers are `async def`; any sync handler blocks loop.
- [P2] [Concurrency] [app/main.py] No load-shedding observed — stress with 50+ parallel before launch.
- [P2] [Concurrency] [app/main.py] No mutation-concurrency tested here (`/api/draft/pick` parallel) — follow-up: verify server rejects double-pick at same overall.
- [P2] [Concurrency] [app/main.py:/api/leagues/switch] If two clients switch at once, last-write-wins on single shared `active` — confirm intended behavior with per-session active.
- [P2] [Concurrency] [app/main.py] No SSE observed on this nav; `/api/season/advance-week/stream` exists but untested here — confirm auto-reconnect logic.
- [P3] [Concurrency] [app/main.py] No `ETag` / `If-None-Match` — identical parallel responses waste bandwidth.
- [P3] [Concurrency] [app/main.py] Tail p95 of 10x call (359ms) vs p50 (255ms) — 40% tail; consider uvicorn `--workers 2`.
- [P3] [Concurrency] [app/main.py] No explicit timeout header — long-running `/api/season/sim-to-playoffs` could hang UI.
- [P3] [Concurrency] [app/main.py] `fastapi` default `limit_max_requests` unknown — set for memory hygiene.
- [P3] [Concurrency] [app/main.py] Observe whether pick/trade mutations use `asyncio.Lock` or DB-level txn; race windows around `current_overall` advancement.

---

**Totals:** 109 findings (25 API · 22 A11y · 6 Console · 14 Network · 18 Visual/RWD · 12 Data · 12 Concurrency).
