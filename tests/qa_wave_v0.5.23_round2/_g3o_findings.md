# QA Round-2 Group-3 OBSERVER — Security / Input Abuse

- Target: https://nbafantasy.cda1234567.com
- Version observed: **0.5.23** (expected 0.5.23)
- Sandbox league: **qa-r2-obs-g3** (paired league qa-r2-g3 untouched)
- Date: 2026-04-18T05:05:04.210Z

## Totals
- PASS: 13 | FAIL: 7 | INFO: 2
- P0: 0 | P1: 0 | P2: 2 | P3: 3

## Findings
### V0 — version check
- Status: **PASS**  Severity: **INFO**
- Expected: 0.5.23
- Actual: 0.5.23

### H1 — HSTS header
- Status: **FAIL**  Severity: **P2**
- Expected: Strict-Transport-Security: max-age>=15552000
- Actual: (missing)

### H2 — Content-Security-Policy
- Status: **FAIL**  Severity: **P2**
- Expected: CSP header present (script-src restrictions)
- Actual: (missing)

### H3 — X-Frame-Options / frame-ancestors
- Status: **FAIL**  Severity: **P3**
- Expected: DENY or SAMEORIGIN (clickjacking)
- Actual: (missing)

### H4 — X-Content-Type-Options
- Status: **FAIL**  Severity: **P3**
- Expected: nosniff
- Actual: (missing)

### H5 — Referrer-Policy
- Status: **FAIL**  Severity: **INFO**
- Expected: strict-origin-when-cross-origin (recommended)
- Actual: (missing)

### H6 — Permissions-Policy
- Status: **FAIL**  Severity: **INFO**
- Expected: restrict camera/mic/geolocation
- Actual: (missing)

### H7 — Cross-Origin-Opener-Policy
- Status: **FAIL**  Severity: **INFO**
- Expected: same-origin
- Actual: (missing)

### H8 — Server / framework info disclosure
- Status: **INFO**  Severity: **P3**
- Expected: minimal / no version string
- Actual: server=cloudflare

### H9 — Cookie flags (HttpOnly/Secure/SameSite)
- Status: **INFO**  Severity: **INFO**
- Expected: any session cookie must be HttpOnly+Secure+SameSite
- Actual: [{"name":"cf_clearance","httpOnly":true,"secure":true,"sameSite":"None"}]

### S1 — XSS via league name (<script>)
- Status: **PASS**  Severity: **INFO**
- Expected: payload escaped, window._xss remains undefined
- Actual: window._xss=undefined; server patch status=200

### S2 — XSS via team name (<img onerror>)
- Status: **PASS**  Severity: **INFO**
- Expected: no <img onerror> injected; window._xss2 undefined
- Actual: window._xss2=undefined; img-with-payload-onerror=false; patch=200

### S3 — XSS via trade proposer_message
- Status: **PASS**  Severity: **INFO**
- Expected: payload escaped / stored safely / rejected; window._xss3 undefined
- Actual: window._xss3=undefined; rawHtmlHasScriptTag=false; propose status=409

### S4 — Path traversal in league_id
- Status: **PASS**  Severity: **INFO**
- Expected: 400/422 with validator error; no disk write
- Actual: status=400 body={"detail":"league_id may only contain letters, digits, '-', '_'"}

### S5 — Oversized league_id (10k chars)
- Status: **PASS**  Severity: **INFO**
- Expected: 400/422 with length-limit error
- Actual: status=400 body={"detail":"league_id too long (max 64 chars)"}

### S6 — SQL-injection-like league_id
- Status: **PASS**  Severity: **INFO**
- Expected: rejected; players endpoint still returns data
- Actual: status=400 body={"detail":"league_id may only contain letters, digits, '-', '_'"}

### S6b — DB integrity after SQLi attempt
- Status: **PASS**  Severity: **INFO**
- Expected: players list still returns ≥1 item
- Actual: status=200 count=3

### S7 — Double-submit idempotency (10x /leagues/create)
- Status: **PASS**  Severity: **INFO**
- Expected: 1 created; duplicates rejected cleanly (no 5xx)
- Actual: ok=1 dup=9 serverErr=0 actualCreated=1

### S8 — CSRF / CORS — hostile Origin on state-changing POST
- Status: **PASS**  Severity: **INFO**
- Expected: no ACAO for foreign origin (browser same-origin policy blocks the cross-site attacker)
- Actual: ACAO=(none) ACAC=(none) status=200 body={"ok":true,"active":"qa-r2-obs-g3"}

### S8b — CORS preflight from evil origin
- Status: **PASS**  Severity: **INFO**
- Expected: preflight does not whitelist attacker origin
- Actual: status=405 ACAO=(none)

### L1 — Absolute-path / secret leakage in response bodies
- Status: **PASS**  Severity: **INFO**
- Expected: no C:\, /home/, data_dir, API keys, or stack traces
- Actual: (none)

### X1 — No runtime XSS markers fired during full sweep
- Status: **PASS**  Severity: **INFO**
- Expected: no alert() dialogs, no _xss* globals set, no pageerror from XSS
- Actual: dialogs=0 pageErrors=0 consoleErrors=13
