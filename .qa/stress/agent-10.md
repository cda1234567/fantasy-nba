# Security Probe Report — agent-10
**Date:** 2026-04-18  
**Server:** uvicorn 127.0.0.1:3509, DATA_DIR=`.qa/stress/data-10`  
**Dataset:** data-10 (copied from data-9; qa_p3_daily league used for season-dependent tests)

---

## Summary Table

| Check | Result |
|---|---|
| Invalid HTTP methods | PASS — all return 405 |
| Oversized body (5 MB) | PASS — 409 (business rule), not OOM |
| Path traversal | PASS — 404, no file content leaked |
| SQL-ish league name | PASS — 422 validation error |
| Unicode/emoji league name | NOTE — returns 400 "parse error" instead of 422 |
| Null/empty body on mutating endpoints | PASS — 422 or 409 |
| Very long strings (10 k chars) | PASS — 422 |
| Race condition (duplicate trade) | **FAIL — race bug confirmed** |
| CORS headers | NOTE — no CORS headers on OPTIONS |
| /api/health info disclosure | PASS — no paths/env vars/tokens |

---

## Findings

### RACE CONDITION BUG (Medium-High severity)

**Endpoint:** `POST /api/trades/propose`

Two concurrent requests with identical payloads (sent via `threading.Barrier`) both returned HTTP 200 with **distinct trade IDs**:
- `da9fa114ccc94a22a8a83fc4aa7816ff`
- `da126c2b3e7347f3a37c25c5e9dda9ac`

Only one trade survived in `trades.json` (last-writer-wins via `os.replace()`).

**Root cause:** `TradeManager.propose()` performs a read → deduplicate-check → append → write cycle with no mutex or file lock. `storage._atomic_write()` uses `os.replace()` which is safe for single-writer corruption but provides no mutual exclusion. Two concurrent requests both pass the dedup check (lines 191–198 in `trades.py`) on the same stale snapshot, generate unique IDs, and race to `os.replace()`. One trade is silently discarded despite the caller receiving 200.

**Impact:** A user double-clicking "Propose Trade" gets two different trade IDs returned; one disappears. The background `_finalize` task for the ghost trade then calls `_find()` → `None` → silently exits. No crash, but data integrity is broken and the user sees inconsistent state.

**Fix:** Add a `threading.Lock` (or `asyncio.Lock` if routes become async) around the trades read-modify-write in `propose()`, or use file-level advisory locking (e.g. `fcntl.flock` on Linux / `msvcrt.locking` on Windows).

---

### CORS — No Access-Control headers (Low severity / informational)

`OPTIONS /api/health` returns **405 Method Not Allowed** with no `Access-Control-Allow-Origin` header. The app does not register a CORS middleware (no `CORSMiddleware` in `main.py`). For a localhost-only deployment behind Cloudflare Tunnel this is acceptable, but if the API is ever called by a browser from a different origin it will fail CORS preflight.

Security headers present and correct: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`, `Content-Security-Policy`, `Referrer-Policy`.

---

### Unicode/emoji body parse error — 400 instead of 422 (Informational)

`POST /api/leagues/create` with `league_name: "🏀隊League🔥"` returns `{"detail":"There was an error parsing the body"}` with HTTP **400**, not 422. FastAPI/Pydantic normally returns 422 for validation failures. This is triggered by Pydantic's body parsing step rather than a validator, so it is not a crash, but the error message is opaque. Not a security issue.

---

## Items with No Issues

- **Invalid methods:** All POST-only endpoints return 405 on GET/DELETE/PUT/PATCH — correct.
- **5 MB body:** Returns 409 (season not started / business rule), no OOM, no timeout — processed within 1 s.
- **Path traversal:** `/api/seasons/%2e%2e/etc/passwd` and double-encoded variants all return 404. Response body contains only `{"detail":"Not Found"}` — no file paths or internal state leaked.
- **SQL-ish input (`"; DROP TABLE leagues; --`):** Returns 422 with a Pydantic validation error (missing required field `league_id`). Input is never executed or reflected unsafely.
- **Null / empty body:** `422` on endpoints requiring a body, `409` on endpoints that hit a business-rule check first — no 500.
- **10 k-char strings:** `422` from Pydantic — correctly rejected.
- **`/api/health`:** Returns `{"ok":true,"version":"0.5.39","league_id":"default","ai_enabled":false}` — no file paths, no env vars, no tokens.

---

## Recommendations

1. **[High] Add a write lock in `TradeManager.propose()`** — a module-level `threading.Lock` guards the read-modify-write. All FastAPI sync route handlers run in a threadpool, so a standard `threading.Lock` is correct here.
2. **[Low] Add `CORSMiddleware`** if the app will ever be accessed cross-origin from a browser, and configure an explicit `allow_origins` allowlist rather than `"*"`.
3. **[Info] Return 422 consistently** for emoji/unicode body parse errors (requires a custom exception handler for `RequestValidationError` vs `HTTPException`).
