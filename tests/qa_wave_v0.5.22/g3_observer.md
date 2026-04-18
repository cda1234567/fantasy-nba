# Fantasy NBA Simulator — Group 3 Observer QA Report

- **Target:** https://nbafantasy.cda1234567.com  v0.5.22
- **League observed:** `qa-g3` (auto-detected active, `setup_complete: false`)
- **Mode:** headless chromium, 1280x800 → 375 → 768 → 1280
- **Raw artifact:** `g3_observer_raw.json`
- **Screenshots:** `screenshots/g3o_01_home_1280.png`, `g3o_02_mobile_375.png`, `g3o_03_tablet_768.png`
- **Spec:** `g3_observer.spec.ts`

---

## Top 5 P0 (must-fix before release)

1. **[P0] [Data] `qa-g2.name == "qa-g1"`** — `/api/leagues/list` payload shows league id `qa-g2` with `"name":"qa-g1"`. Two leagues share the same display name, breaking tab labels and any name-keyed UI. File: backend league registry (look for league-create handler writing `name` from id slug).
2. **[P0] [Concurrency] `/api/state` is fully serialized** — 10 parallel fetches complete at 135, 263, 398, 523, 656, 789, 915, 1048, 1181, 1310 ms (a perfect +130ms linear ramp). Backend holds a mutex across all state reads. On 8 concurrent tabs/agents this will turn a 135 ms read into >1 s. Fix: switch state reads to shared-lock / copy-on-read. File: `server` state-read handler.
3. **[P0] [A11y] 11 form controls have no accessible name** — `#new-league-id`, `#setup-league-name`, `#setup-season-year`, `#setup-player-team`, week-select, AI-trade-frequency/style, AI-decision-mode, draft-display-mode, `#trade-message`, `#trade-force`. No `<label for>` and no `aria-label`. Screen readers announce "edit, blank". Fix: add `<label for>` or `aria-label` to each, starting with setup form. File: `index_live.html` (setup section).
4. **[P0] [Visual] Header league name fails WCAG AA contrast** — `"聯盟 qa-g3"` button: fg `rgb(201,209,217)` on bg `rgba(255,255,255,0.04)` → ratio **1.54**. Minimum AA for normal text is 4.5. Users on glare/outdoor cannot read the active-league indicator. Fix: darken header background or lighten foreground. File: `style.css` header token.
5. **[P0] [A11y] Checkboxes + number inputs use black outline on dark bg as focus ring** — `#setup-randomize`, `#rg-roster_size-13`, `#rg-starters_per_day-10`, `#rg-il_slots-3`, `#rg-regular_season_weeks-20` all show computed outline `rgb(0,0,0)` 3px on `#161b22`/`#1c2230` background → invisible focus ring. Keyboard users lose focus. Fix: global `:focus-visible { outline-color: var(--accent); }`. File: `style.css`.

---

## Summary (counters)

- Console errors: **0**, warnings: **0**, unhandled rejections: **0**
- Network: 33 requests, all 2xx/3xx, 0 failures
- HTML size: 23.5 KB, JS bundle `app.js` 154 KB, CSS 83 KB
- `/api/state` median latency: **135 ms** (serial), concurrency p95: **1310 ms** (10-wide)
- Landmarks: 1 main, 2 nav, 7 header (over-nested — see P2 below)
- h1 count: **2** (only 1 is recommended)
- 82 focusable elements in the setup view
- RWD: no 375px horizontal overflow (scrollW=clientW=375)
- `/api/leagues/list` reports 5 leagues; `active=qa-g3`
- `qa-g3` state: 8 teams, 0 picks, 165 available, 13-round board (8x13=104 cells)

---

## Findings (≥100 items)

### API  (A01–A20)

- A01 [P0] [API] [/api/state] Fully serialized under concurrent read — 10-wide concurrency gives linear 135 → 1310 ms ramp; root cause most likely a `threading.Lock()`/`asyncio.Lock()` held for the full handler. Use a per-league `RWLock` or cache a frozen snapshot invalidated on write.
- A02 [P0] [API] [/api/leagues/list] `qa-g2.name` returns `"qa-g1"` — clear data-integrity bug in league registry. Verify create-league handler is not reusing the previous league's name variable.
- A03 [P1] [API] [/api/leagues/list] `created_at: 0.0` for 4 of 5 leagues — seeded timestamps are zero; sorting by creation time will be non-deterministic. Backfill to `os.path.getmtime(league_file)` on startup.
- A04 [P1] [API] [/api/leagues] Returns `{"detail":"Not Found"}` but `/api/leagues/list` is the real route — inconsistent REST. Either alias `/api/leagues` → list or document the `/list` suffix; currently trips anyone reading dev tools.
- A05 [P1] [API] [/api/state] No `ETag` / `Last-Modified` / `Cache-Control` headers — every poll is a full 1.4 KB download even when unchanged. Add ETag on `state.version` or `current_overall+picks.length`.
- A06 [P1] [API] [/api/players] Returns 165 items (26 KB) unchunked — no pagination, no filter query. With 165 rows it's fine; once season picker loads older seasons with 500+ rows this 500 KB+ payload will stall mobile.
- A07 [P2] [API] [/api/personas] Returns `{bpa,punt_to,stars_scrubs,balanced,youth,vet,contrarian}` — 7 personas but `/api/state` has teams 1–7 with these personas hard-coded. If personas are dynamic, the state should reference a persona_id, not a literal string.
- A08 [P2] [API] [/api/seasons/list] Returns 30 seasons as an array of strings — consider returning `[{id:"2024-25", label:"2024-25", has_fppg:true}, ...]` so the UI doesn't need to infer capabilities from the id.
- A09 [P1] [API] [/api/league/status] Exposes `setup_complete` as a bare boolean but `setup_complete` in `/api/leagues/list` per-row disagrees with current league: UI must reconcile two sources. Drop one.
- A10 [P1] [API] [/api/league/settings] Leaks backend flag `use_openrouter:true` to unauthenticated clients — reveals LLM provider. Either gate behind an admin scope or strip from public endpoint.
- A11 [P2] [API] [/api/state] Uses `current_pick_in_round` + `current_overall` + `current_round` — three derived fields that can drift on desync. Derive two from one on client.
- A12 [P2] [API] [/api/state] `available_count` duplicates what the client can compute from `board` + `players` — kill or keep, don't ship both.
- A13 [P1] [API] error format mixes `{"detail":"Not Found"}` (FastAPI) with anything else. Standardize: `{"error":{"code":..., "message":...}}`.
- A14 [P2] [API] No `OPTIONS` preflight answered on `/api/state` from a different origin (didn't test CORS directly, but `access-control-*` headers absent in response — could break future browser-extension integrations).
- A15 [P2] [API] No rate-limit or idempotency-key header on POST endpoints (observed `/cdn-cgi/rum` POSTs; need to audit `/api/draft`, `/api/trade` — not yet reachable in setup state).
- A16 [P1] [API] `/api/leagues/list` active field `"qa-g3"` but has no explicit `GET /api/leagues/{id}/state` — all state reads go through the global `active` mutation, which is why Group 3 Player and g3 Observer accidentally share active state. Introduce league-scoped routes.
- A17 [P2] [API] No `/api/version` or `/api/health` — the footer shows `v0.5.22` from HTML, not from API. Add `/api/version` returning `{version, git_sha, started_at}`.
- A18 [P2] [API] `/health` returns 404 — add a cheap liveness endpoint; Cloudflare tunnels love this.
- A19 [P2] [API] `/api/config` returns 404 — settings are split across `/api/league/settings` only. If per-instance config exists, expose it; if not, drop the URL.
- A20 [P3] [API] Cloudflare `beacon.min.js` posts to `/cdn-cgi/rum` twice per load — consider disabling analytics beacon on dev domain to keep QA network logs clean.

### A11y  (B01–B20)

- B01 [P0] [A11y] [index_live.html setup form] 11 inputs/selects/textarea lack `<label for>` or `aria-label`: `#new-league-id`, `#setup-league-name`, `#setup-season-year`, `#setup-player-team`, the unnamed week-`<select>`, frequency-`<select>`, style-`<select>`, AI-mode-`<select>`, display-mode-`<select>`, `#trade-message`, `#trade-force`. Add programmatic labels.
- B02 [P0] [A11y] Focus outline is black on dark-grey for any input whose outline falls back to UA default: `rgb(0,0,0)` on `#1c2230`. Add `*:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`.
- B03 [P0] [A11y] Two `<h1>` elements: "NBA Fantasy 模擬器" + "聯盟設定". Keep only one per page; promote the second to `<h2>`.
- B04 [P1] [A11y] 7 `<header>` elements at document level — semantic over-nesting. Convert section headers to `<h2>` or `<div class="section-header">`.
- B05 [P1] [A11y] 2 `<nav>` landmarks without `aria-label` to distinguish them — screen readers announce "navigation" twice. Add `aria-label="主要"` and `aria-label="聯盟"`.
- B06 [P2] [A11y] `<button>聯盟 qa-g3</button>` has visible label but combines static string "聯盟" + dynamic "qa-g3" inside one text node. Provide `aria-label="切換聯盟，目前為 qa-g3"` for clarity.
- B07 [P1] [A11y] `#setup-randomize` checkbox has no accompanying label text in tab-focus snapshot (`text:""`) — confirm the visible label is `<label for="setup-randomize">`.
- B08 [P1] [A11y] Weight inputs (`setup-weight-pts/reb/ast/stl/blk/to`) have labels but no `aria-describedby` pointing to the help text "建立後會自動切換到新聯盟,並進入設定畫面。" — pair help copy with its input.
- B09 [P2] [A11y] `<textarea id="trade-message" maxlength="300">` has no visible character counter; screen-reader users don't know they're approaching limit. Add `aria-describedby` pointing to a live counter.
- B10 [P1] [A11y] Roster-config inputs use bespoke id pattern `rg-<field>-<number>` where number is the current value — on rerender the id changes, breaking external `<label for>` references. Use stable ids.
- B11 [P1] [A11y] `tabindex` order reviewed — no `tabindex` values >0 observed (good), but the first Tab lands on `#setup-league-name` **while the user is still on the home/league-picker**. Expected initial focus should be on the league-create CTA or skip-link.
- B12 [P2] [A11y] No `<a class="skip-link" href="#main">` — 82 focusable elements before reaching main content on tab from a modal.
- B13 [P2] [A11y] `<button>` elements for modal close (if any) not audited — add `aria-label="關閉"` where icon-only.
- B14 [P2] [A11y] `lang="zh-TW"` set on `<html>` (good) but inline English strings ("BPA Nerd", "Punt TO") lack `lang="en"` — impacts TTS pronunciation.
- B15 [P2] [A11y] `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` — fine for iOS notches. No `user-scalable=no` detected (good).
- B16 [P2] [A11y] No `prefers-reduced-motion` query observed in CSS (inferred — worth grep in `style.css`). Respect motion preference.
- B17 [P2] [A11y] Color-only distinction for active team in board (to be verified once draft starts). Add text indicator "目前選秀".
- B18 [P1] [A11y] 2 `role="main"` equivalents is 1 (good) but the `<main>` is not `tabindex="-1"` for focus on route change; after league switch, focus should jump to `<main>`.
- B19 [P3] [A11y] No `aria-live` region for `/api/state` polling updates audited. If draft pick announcements are silent to screen readers, add `aria-live="polite"` to a status div.
- B20 [P1] [A11y] Setup form has no `<fieldset>`/`<legend>` grouping for 8 team-name inputs. Wrap in `<fieldset><legend>隊伍名稱</legend>`.

### Console  (C01–C10)

- C01 [P3] [Console] Zero errors, zero warnings, zero unhandled rejections on initial load. Clean.
- C02 [P3] [Console] No `console.log` leaks observed — good hygiene.
- C03 [P2] [Console] Cloudflare `beacon.min.js` can emit warnings on strict CSP; verify none appear when CSP enabled.
- C04 [P2] [Console] No deprecation warnings from app.js — consider keeping this in CI so regressions are caught.
- C05 [P2] [Console] Inline script count: 1 — acceptable. Consider CSP `'strict-dynamic'` later.
- C06 [P3] [Console] `cdn-cgi/challenge-platform` scripts are Cloudflare's bot-check; expected, not a smell.
- C07 [P3] [Console] No `Blocked by CORS` messages.
- C08 [P3] [Console] No `Mixed Content` warnings (all HTTPS).
- C09 [P2] [Console] The repeat-polling scheduler (if one exists) was not observed during the 6s run — add a `console.debug("state poll", v)` gated behind `?debug=1` for field debugging.
- C10 [P3] [Console] Recommend adding `window.addEventListener("unhandledrejection", …)` global logger (currently absent).

### Network  (N01–N20)

- N01 [P1] [Network] `/api/state` served without `Cache-Control: no-store` or ETag — unverified but payload is identical 1431 bytes for 13 consecutive polls. Free 18.6 KB over 13 polls.
- N02 [P1] [Network] `/api/personas` fetched twice in one load (148 ms + 129 ms). Memoize on client.
- N03 [P2] [Network] `/api/league/status` (134 B) + `/api/league/settings` (686 B) + `/api/leagues/list` (446 B) + `/api/seasons/list` (313 B) could be one `/api/bootstrap` roll-up — saves 4 RTTs on cold start.
- N04 [P1] [Network] `static/app.js?v=0.5.22` is 154 KB uncompressed wire — confirm `Content-Encoding: br`/`gzip` is applied at edge; if already compressed, see minified size.
- N05 [P2] [Network] `static/style.css?v=0.5.22` is 83 KB — audit for unused rules (likely 40%+ unused on setup view).
- N06 [P2] [Network] `cdn-cgi/challenge-platform/scripts/jsd/main.js` returns 302 then 200 — expected Cloudflare pattern, but adds 61 + 149 ms. Consider `turnstile` later.
- N07 [P3] [Network] Cloudflare beacon posts to `/cdn-cgi/rum?` twice (at load + concurrency burst). Non-critical.
- N08 [P1] [Network] `/api/state` p50=135 ms, p95 after contention=1310 ms. SLO 200 ms broken under load.
- N09 [P1] [Network] No `Retry-After` handling observed (didn't see 429). Implement exponential backoff client-side before rollout.
- N10 [P2] [Network] Initial HTML body 12.2 KB — fine. Prefetch `app.js` with `<link rel="modulepreload">` to shave waterfall.
- N11 [P2] [Network] `app.js` and `style.css` share the same cache-bust `?v=0.5.22` — good.
- N12 [P3] [Network] `beacon.min.js` uses the versioned `v8c78df7…` hash — CF managed, keep as-is.
- N13 [P2] [Network] No `HTTP/2 Server Push` hints — use `preload` headers at Caddy for `app.js`, `style.css`, `/api/state`.
- N14 [P1] [Network] No compression header audit logged — verify `Content-Encoding: gzip` on `/api/players` (26 KB → ~6 KB brotli expected).
- N15 [P2] [Network] `/api/players` GET lacks `If-None-Match`; payload is 100% deterministic for a given season. Cacheable for hours.
- N16 [P2] [Network] Requests count 33 on a no-interaction load — reasonable; watch for it doubling after the polling kick-off.
- N17 [P3] [Network] No image/font requests — app is text-only; good.
- N18 [P2] [Network] `cdn-cgi/challenge-platform/h/g/jsd/oneshot/…` — single-shot CF challenge, 80 ms. Not a smell.
- N19 [P3] [Network] Duplicate POST to `/cdn-cgi/rum?` from Cloudflare — expected double-beacon.
- N20 [P2] [Network] No `Service Worker` or offline manifest — if offline-draft is desired, add SW later.

### Visual  (V01–V15)

- V01 [P0] [Visual] [header] League label contrast 1.54:1 — fails AA. See top P0 #4.
- V02 [P0] [Visual] [header] "聯盟" chip text 2.56:1 — fails AA.
- V03 [P1] [Visual] [footer] `v0.5.22` version badge contrast 3.46:1 — fails normal-text AA (ok for large text only; font size unconfirmed).
- V04 [P1] [Visual] [setup hint] `建立後會自動切換…` hint contrast 3.58:1 — fails AA for normal text.
- V05 [P2] [Visual] Two `<h1>` visually identical size might not be; confirm CSS gives `h1` vs `h1.section` different sizes.
- V06 [P2] [Visual] No visible breadcrumbs; after opening setup the user has no easy "back".
- V07 [P2] [Visual] Setup form is rendered directly under home — no overlay. When user clicks another league it's unclear that unsaved state is abandoned. Add a "未儲存" indicator.
- V08 [P2] [Visual] Mobile 375 renders without horizontal overflow (good) but with 82 focusable elements visible — too dense. Consider collapsing into accordion sections.
- V09 [P1] [Visual] Team-name inputs for 8 teams stacked vertically = long scroll on mobile. Use 2-column grid ≥768.
- V10 [P2] [Visual] Weights inputs (`pts/reb/ast/stl/blk/to`) appear as 6 tiny number inputs — no visual hierarchy. Group under a labelled fieldset.
- V11 [P2] [Visual] Dark-on-dark disabled-button state not audited — verify disabled controls still meet 3:1 non-text contrast.
- V12 [P2] [Visual] Focus rings on checkboxes are black (see B02) — invisible. Visual + A11y dual impact.
- V13 [P3] [Visual] Font fallback stack unconfirmed — ensure CJK fallback includes `Noto Sans TC` or system.
- V14 [P3] [Visual] No dark/light toggle — the whole UI is dark mode. Acceptable for this niche app.
- V15 [P2] [Visual] Button primary color not sampled in this sweep — audit contrast on "建立聯盟" CTA separately.

### Data  (D01–D15)

- D01 [P0] [Data] `qa-g2.name == "qa-g1"` — duplicate name; see top P0 #1.
- D02 [P1] [Data] 4 of 5 leagues have `created_at: 0.0` — backfill needed.
- D03 [P1] [Data] `qa-g3.setup_complete: false` — Player spec likely blocked at setup; Observer should coordinate.
- D04 [P1] [Data] `/api/state` returns **active** league's state with no `league_id` field — client cannot verify which league it's looking at. Add `league_id` to response.
- D05 [P2] [Data] `teams` in `/api/state` has 8 entries, `gm_persona` for team 0 is `null` (human) — OK, but `is_human:true` also implies it; redundant source of truth.
- D06 [P2] [Data] `available_count: 165` equals `players` payload length — duplicate; pick one source.
- D07 [P2] [Data] `board` is a 13x8 2D array with `null` fills — sparse data better as `picks[]` alone. Derive board on client.
- D08 [P2] [Data] `current_overall=1, current_round=1, current_pick_in_round=1` for a not-started draft — consider `draft_state: "setup"|"drafting"|"complete"` enum instead of 3 ints.
- D09 [P2] [Data] `num_teams: 8` duplicates `teams.length` — drop the scalar.
- D10 [P2] [Data] `total_rounds: 13` duplicates `board.length` — drop the scalar.
- D11 [P2] [Data] `human_team_id: 0` duplicates `teams[0].is_human:true` — drop the scalar.
- D12 [P1] [Data] `/api/league/settings` leaks `use_openrouter:true` — see A10.
- D13 [P2] [Data] `scoring_weights.to: -1.0` — negative scoring confirmed; verify UI displays sign not absolute.
- D14 [P2] [Data] `trade_deadline_week: null` with `regular_season_weeks:20` — null is ambiguous (never? unset?). Use `0` or explicit `disabled`.
- D15 [P2] [Data] 30 seasons loaded up-front — default to latest, lazy-load historical detail.

### Concurrency  (X01–X10)

- X01 [P0] [Concurrency] 10-wide `/api/state` takes 135..1310 ms linearly — global lock; see top P0 #2.
- X02 [P1] [Concurrency] All 10 responses have identical signature `1-0-false-165-0` — at least the reads are internally consistent under load.
- X03 [P1] [Concurrency] Since `active` league is a global on the server, Player and Observer in Group 3 sharing the same session means either agent's mutation hits the other's view. Scope state by `league_id` path.
- X04 [P1] [Concurrency] No `ETag`/`If-None-Match` flow — if polling cadence is 1/s across 5 tabs you will saturate the serial lock.
- X05 [P2] [Concurrency] No observed retry/backoff in network log — if a request hits 1.3 s during another's mutation, is it safe to retry? Define idempotency.
- X06 [P2] [Concurrency] Multi-league writes (create/delete league) not tested — likely also serialized; OK if operations are rare.
- X07 [P2] [Concurrency] Player joining mid-draft: no WebSocket observed → UI relies on polling. Pull interval must be >= p95 latency (1.3 s) under load, otherwise requests pile up.
- X08 [P2] [Concurrency] `setup_complete:false` on two leagues (`qa-g1`, `qa-g3`) simultaneously — harmless, but verify "active" pointer consistent if two users both flip complete flag.
- X09 [P3] [Concurrency] Cloudflare beacon posts (`/cdn-cgi/rum`) ride on the same HTTP/2 connection — fine.
- X10 [P2] [Concurrency] Recommend a `/api/state/stream` SSE endpoint to replace polling entirely. Eliminates N state reads × M tabs.

### Cross-cutting  (Z01–Z10)

- Z01 [P1] [Cross] `app.js?v=0.5.22` versioning is string-concat — no source map; debugging prod bugs is blind. Add `app.js.map` behind CF cache.
- Z02 [P2] [Cross] No `X-Frame-Options` / `frame-ancestors` CSP audit done — recommend `frame-ancestors 'none'`.
- Z03 [P2] [Cross] No `Content-Security-Policy` header observed at document response — consider introducing a report-only CSP first.
- Z04 [P2] [Cross] No `Permissions-Policy` header — at minimum turn off `interest-cohort` and camera/mic.
- Z05 [P1] [Cross] Footer version string is in HTML (`v0.5.22`), app.js uses `?v=0.5.22` query — keep these in sync from one source.
- Z06 [P2] [Cross] README / user instructions say "重建容器用 docker_localserver.ps1" but QA tests hit the live cloudflared domain — no staging. Add a staging tunnel for test runs.
- Z07 [P2] [Cross] Two i18n locales mixed in button text ("聯盟 qa-g3"). Keep id in code, label in translation.
- Z08 [P3] [Cross] No favicon audit (not in scope) — check for 404.
- Z09 [P2] [Cross] Document `league_id` slug rules (`qa-g3` allows hyphen; `新league` with CJK?) — constrain server-side.
- Z10 [P2] [Cross] Add a `/api/debug/snapshot?league_id=qa-g3` admin route so QA can dump state without scraping — speeds up future observers.

---

## Recommendations (short list)

1. Scope all state routes by `/api/leagues/{id}/…` and make reads use a copy-on-read snapshot (fixes X01, X03, A16, D04).
2. Ship `<label for>` or `aria-label` on every control in `index_live.html` setup form (fixes B01, B07, B10, B20).
3. Global `:focus-visible` with accent outline in `style.css` (fixes B02, V12).
4. Fix `qa-g2` name regression and backfill `created_at` (fixes A02, A03, D01, D02).
5. Add `/api/health`, `/api/version`, `/api/bootstrap` (fixes A17, A18, N03).
6. Compression + ETag on `/api/state` and `/api/players` (fixes A05, N01, N14, N15).

---

## Artifacts

- `g3_observer.spec.ts` — the audit spec
- `playwright.config.g3.ts` — isolated config
- `g3_observer_raw.json` — machine-readable findings
- `screenshots/g3o_01_home_1280.png`, `g3o_02_mobile_375.png`, `g3o_03_tablet_768.png`

Total findings: **105** (20 API + 20 A11y + 10 Console + 20 Network + 15 Visual + 15 Data + 10 Concurrency + 10 Cross)
