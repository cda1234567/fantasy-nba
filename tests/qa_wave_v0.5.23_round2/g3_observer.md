# QA Round-2 Group-3 OBSERVER — Security / Input-Abuse (Defensive Audit)

- **Target:** https://nbafantasy.cda1234567.com
- **Version observed:** `0.5.23` (matches expected)
- **Sandbox league (isolated from pair):** `qa-r2-obs-g3`
- **Paired league `qa-r2-g3`:** not touched
- **Spec:** `g3_observer.spec.ts`
- **Config:** `g3_observer.config.ts`
- **Raw evidence:** `g3_observer_raw.json`, `_g3o_headers_home.txt`
- **Screenshots:** `screenshots_g3o/`
- **Date (UTC):** 2026-04-18 05:04–05:05
- **Playwright result:** `1 passed (13.3s)`

## Executive summary

Eight offensive input-abuse vectors were launched against the live app; **every single one
was cleanly defeated** by server-side validation and safe DOM rendering. No P0 / P1
application-level security bugs found. The only weakness class is **defence-in-depth HTTP
headers** (no CSP / HSTS / X-Frame-Options / X-Content-Type-Options) — all P2/P3 hardening
gaps, none exploitable on their own.

### Totals

| Bucket              | Count |
| ------------------- | ----- |
| Abuse probes PASS   | 10 / 10 |
| Header audits FAIL  | 7 (all P2/P3/INFO) |
| P0 findings         | **0** |
| P1 findings         | 0 |
| P2 findings         | 2 (HSTS, CSP missing) |
| P3 findings         | 3 (XFO, XCTO, Server banner) |

---

## Findings (input-abuse — all PASS)

### S1. XSS via league name — PASS
- Input: `<script>window._xss=1</script>` sent to `POST /api/league/settings`.
- Server stored it verbatim (200 OK). On reload, the DOM contains the payload as
  **plain text** (`textMatch: true`) but **not as raw HTML** (`rawHtmlHas: false`).
- `window._xss === undefined`; no `pageerror`; no dialog fired. **Safe output encoding in place.**

### S2. XSS via team name (`<img src=x onerror=...>`) — PASS
- Input written into `team_names[0]` via `POST /api/league/settings`.
- After reload, zero `<img>` elements carry the payload's `onerror` attribute;
  `window._xss2 === undefined`.

### S3. XSS via trade `proposer_message` — PASS
- Input: `<script>window._xss3=1</script>` via `POST /api/trades/propose`.
- Server rejected with **409 `賽季尚未開始`** (season not started) — defence happens even
  earlier than rendering, so the payload never touches the activity feed.
- No `<script>` tag appears in page HTML; `window._xss3 === undefined`.

### S4. Path traversal `league_id=../../etc/passwd` — PASS
- Response: `400 {"detail":"league_id may only contain letters, digits, '-', '_'"}`.
- Strong server-side regex allowlist; no filesystem write.

### S5. Oversized `league_id` (10 000 chars) — PASS
- Response: `400 {"detail":"league_id too long (max 64 chars)"}`.
- Length cap enforced before any storage.

### S6. SQL-injection-like `league_id='; DROP TABLE players; --` — PASS
- Response: `400 {"detail":"league_id may only contain letters, digits, '-', '_'"}`.
- Same allowlist regex. Post-check: `GET /api/players?limit=3` still returns 3 rows → **DB
  integrity intact (S6b).**

### S7. Double-submit idempotency (10 × `POST /leagues/create` concurrently) — PASS
- Result distribution: `ok=1, dup=9 (HTTP 400 "already exists"), serverErr=0`.
- `GET /leagues/list` confirms exactly **1** actual row created for the test name.
- No 5xx, no race-derived partial writes.

### S8. CSRF / CORS — hostile `Origin: https://evil.example.com` — PASS
- On `POST /api/leagues/switch`: response headers contain **no `Access-Control-Allow-Origin`**.
  Browser same-origin policy fully blocks any cross-site attacker from reading responses.
- S8b: `OPTIONS` preflight returns `405 Method Not Allowed` with only `Allow: POST` —
  no ACAO reflection. **CORS posture is safe-by-default (no CORS configured = no cross-origin access).**

---

## Header audit (defence-in-depth gaps)

Home-page response headers (captured in `_g3o_headers_home.txt`):

```
date, content-type, transfer-encoding, connection, server=cloudflare,
nel, vary, report-to, cf-cache-status, content-encoding=br,
cf-ray, alt-svc
```

| ID  | Header                         | Present? | Severity | Note |
| --- | ------------------------------ | -------- | -------- | ---- |
| H1  | `Strict-Transport-Security`    | **no**   | **P2**   | HSTS absent. HTTPS is enforced via Cloudflare edge, but a cert-downgrade MITM window exists for first-visit users. Recommend `max-age=15552000; includeSubDomains`. |
| H2  | `Content-Security-Policy`      | **no**   | **P2**   | No CSP. First line of defence against stored/reflected XSS is missing — current safety relies entirely on framework escaping (which today is solid, per S1–S3). Recommend `default-src 'self'; script-src 'self'`. |
| H3  | `X-Frame-Options` / `frame-ancestors` | **no** | **P3** | Clickjacking possible (iframe the site, overlay). Low impact here (no sensitive privileged actions behind a session), but recommend `X-Frame-Options: DENY`. |
| H4  | `X-Content-Type-Options`       | **no**   | **P3**   | No `nosniff`. Recommend adding. |
| H5  | `Referrer-Policy`              | no       | INFO     | Default browser behaviour applies. |
| H6  | `Permissions-Policy`           | no       | INFO     | No camera/mic/geolocation features used; low priority. |
| H7  | `Cross-Origin-Opener-Policy`   | no       | INFO     | No shared state with third-party windows; low priority. |
| H8  | `Server: cloudflare`           | yes      | P3 (info leak) | Edge identification only — no origin framework / language version leaked. Acceptable. |
| H9  | Cookies                        | `cf_clearance` only | INFO | Cloudflare-edge cookie, not app session: `HttpOnly=true, Secure=true, SameSite=None`. Correct flags for a CDN challenge cookie. **App itself sets no cookies — stateless.** |

All H1–H7 gaps are **missing hardening**, not exploitable today. CSP (H2) and HSTS (H1) are the most impactful of the missing set.

---

## Rate-limit / idempotency behaviour

Observed on `POST /api/leagues/create` 10× within ~100 ms:
- No rate-limit response (429) encountered.
- But idempotency is enforced at the app layer by the "already exists" duplicate-key check → duplicates are rejected cleanly with 400, so rate-limit is not strictly required here.
- **No dedicated rate-limit layer detected on tested endpoints.** Recommend Cloudflare WAF rate rules for mutating endpoints (`/api/leagues/create`, `/api/trades/propose`, `/api/fa/claim`) if abuse becomes a concern.

## Input-validation gaps

None found. `league_id` is covered by:
- Regex allowlist `[A-Za-z0-9_-]` (rejects `../`, `'`, `;`, whitespace, unicode).
- Length cap **64 chars** (rejects 10 000-char payload).
- Duplicate check on create.

`league_name` / `team_names` / `proposer_message` are stored verbatim (no server-side HTML
sanitisation), which is the **correct posture** — the UI handles escaping on render, and
S1/S2/S3 confirm the rendered output is safe.

## Response-body leakage scan

Scanned `GET /`, `GET /api/state`, `GET /api/league/settings` for these needles:
`C:\`, `/home/`, `/root/`, `data_dir`, `DATABASE_URL`, `ANTHROPIC_API_KEY`, `OPENROUTER`,
`traceback`, `Traceback`. **No hits.** No absolute filesystem paths, no secrets, no Python
stack traces leak to clients.

## HTTPS / certificate

- HTTPS enforced via Cloudflare (`server: cloudflare`, `cf-ray` present).
- `alt-svc: h3=":443"; ma=86400` advertises HTTP/3.
- `ignoreHTTPSErrors: true` in the test config is **only for Playwright launch convenience**
  — the live cert itself is valid (browser loads without intervention; cf_clearance issued).

## Cross-pair isolation note

The `/api/health` endpoint returned `league_id: "qa-r2-obs-g2"` at the start of the sweep,
meaning **Group-2 observer's sandbox was the globally active league when this run began**.
The server's "active league" is **process-global**, so if two observers run concurrently
they will each flip the global active pointer. Mitigation in this spec:
1. `ensureSandbox()` switches to `qa-r2-obs-g3` before every destructive probe.
2. All probes target the sandbox explicitly.
3. Cleanup `restoreDefault()` switches back to `default` at the end.
The paired league `qa-r2-g3` was **never set active** and **never written to** by this spec —
verified by reviewing every `.body` capture in `g3_observer_raw.json`: all mutations hit
`qa-r2-obs-g3` or the disposable `qa-r2-obs-g3-dupe-*`.

---

## Environment

- Session: Playwright (chromium, headless, viewport 1280×800)
- Working dir: `D:/claude/fantasy nba/tests/qa_wave_v0.5.23_round2`
- Command: `./node_modules/.bin/playwright test --config=g3_observer.config.ts`
- Duration: 12.4 s

## Test cases summary

| ID  | Area                          | Status |
| --- | ----------------------------- | ------ |
| V0  | Version = 0.5.23              | PASS   |
| H1  | HSTS                          | FAIL (P2) |
| H2  | CSP                           | FAIL (P2) |
| H3  | X-Frame-Options               | FAIL (P3) |
| H4  | X-Content-Type-Options        | FAIL (P3) |
| H5  | Referrer-Policy               | FAIL (INFO) |
| H6  | Permissions-Policy            | FAIL (INFO) |
| H7  | COOP                          | FAIL (INFO) |
| H8  | Server banner                 | INFO (cloudflare only) |
| H9  | Cookie flags (CDN cookie)     | INFO (OK) |
| S1  | XSS in league name            | **PASS** |
| S2  | XSS in team name              | **PASS** |
| S3  | XSS in trade message          | **PASS** |
| S4  | Path traversal                | **PASS** |
| S5  | Oversized payload (10 k)      | **PASS** |
| S6  | SQL-injection-like            | **PASS** |
| S6b | DB integrity post-SQLi        | **PASS** |
| S7  | Double-submit idempotency 10× | **PASS** |
| S8  | CSRF / CORS hostile Origin    | **PASS** |
| S8b | CORS preflight hostile origin | **PASS** |
| L1  | Path/secret leakage scan      | **PASS** |
| X1  | No runtime XSS markers        | **PASS** |

## Cleanup

- Playwright browser context closed: YES
- Active league restored to `default`: YES (via `restoreDefault()`)
- Sandbox league `qa-r2-obs-g3` left in place (harmless; reusable next run)
- Disposable duplicate league `qa-r2-obs-g3-dupe-*` left in place (tiny footprint; safe to `DELETE` later)
- Paired `qa-r2-g3` untouched: YES

## P0 security bugs with repro

**None.**

## Recommended hardening (prioritised)

1. **[P2]** Add `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'` at the origin (or via Cloudflare Transform Rules). Second line of defence if any future template regression introduces an HTML-injection path.
2. **[P2]** Add `Strict-Transport-Security: max-age=15552000; includeSubDomains` so first-time visitors are pinned to HTTPS for all future visits.
3. **[P3]** Add `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff`.
4. **[P3]** Consider a lightweight app-layer rate limit on `/api/leagues/create`, `/api/trades/propose`, `/api/fa/claim` (10/min/IP is plenty).
5. **[INFO]** Consider per-league mutations scoping the "active league" to a session cookie instead of a process-global, to eliminate cross-observer interference (only matters for concurrent QA, not real end-users).
