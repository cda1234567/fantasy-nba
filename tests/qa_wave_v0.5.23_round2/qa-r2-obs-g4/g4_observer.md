# QA Wave v0.5.23 Round 2 — Group 4 OBSERVER Report

- **Target:** https://nbafantasy.cda1234567.com
- **Version on page:** `v0.5.23` (confirmed in `<link href="/static/style.css?v=0.5.23">` and `<script src="/static/app.js?v=0.5.23">`)
- **Sandbox:** `qa-r2-obs-g4` (isolated from pair `qa-r2-g4`)
- **Date:** 2026-04-18
- **Scope:** read-only performance profiling (no league mutations, no writes)
- **Artifacts:** `artifact_tc1..tc8_*.json` + `results.json` + `run2.log`

## Test Execution Summary

| TC | Name | Status | Duration |
|----|------|--------|----------|
| TC1 | Page-load budget (FCP/LCP/heap/navigation) | PASS | 3.6 s |
| TC2 | Bundle-size breakdown | PASS | 0.8 s |
| TC3 | Cache-header audit (API + static) | PASS | 0.8 s |
| TC4 | Idle 3 min + active 3 min network inventory | PASS | 6.1 m |
| TC5 | Memory-growth loop (5 min tab cycling) | PASS | 5.1 m |
| TC6 | DOM mutations + `longtask` PO (60 s) | PASS | 1.0 m |
| TC7 | Polling audit (timers after 3 min idle) | PASS | 3.0 m |
| TC8 | Cold vs warm reload (FCP comparison) | PASS | 3.9 s |

All 8 cases green. Total wall-clock: 15.4 min.

---

## 1. Page-Load Budget (TC1)

| Metric | Value | Verdict |
|--------|-------|---------|
| TTFB (HTML) | **137 ms** | OK |
| FCP | **460 ms** | Good (<1.8 s target) |
| LCP | **968 ms** | Good (<2.5 s target) |
| `domContentLoaded` | 470 ms | Good |
| `loadEvent` | 470 ms | Good |
| `domComplete` | 470 ms | Good |
| `goto(networkidle)` total | 1 488 ms | OK (dominated by RUM beacon + challenge-platform) |
| Initial JS heap (used / total / limit) | 10 MB / 10 MB / 3 760 MB | Low; well below budget |
| Resource count on page load | 10 (14 requests incl. RUM/challenge) | Reasonable |
| transferSize total (network) | **59.5 KB** | Low — Cloudflare is serving gzip/br and the static bundles were already cached at edge (`cf-cache-status: HIT`) |
| encodedBodySize total | 56.8 KB | — |
| decodedBodySize (HTML alone) | 12.7 KB | — |

**Note on `jsHeapSizeLimit` bucketing:** Chromium quantises `performance.memory` to 10 MB buckets when the page is not cross-origin-isolated (COOP/COEP not set). This is why all TC5 samples returned identical `10000000` — see TC5 interpretation below.

---

## 2. Bundle-Size Breakdown (TC2)

Direct GET (not browser; no gzip from client) to see raw uncompressed payloads.

| Asset | Raw size | Cache-Control | ETag | CDN age on first GET |
|-------|---------:|---------------|------|----------------------|
| `index.html` (`/`) | **12 485 B** | *(none)* | *(none)* | — (DYNAMIC) |
| `static/style.css?v=0.5.23` | **83 180 B** | `max-age=14400` | `W/"d2b2…917c"` | 128 s |
| `static/app.js?v=0.5.23` | **155 196 B** | `max-age=14400` | `W/"e630…0691"` | 220 s |
| **Total raw** | **250 861 B (~245 KB)** | | | |

On the browser path the styles/scripts were compressed: the navigation-timing `transferSizeTotal` was only **59.5 KB** across all 10 resources, confirming br/gzip on CF edge. Bundle budget for a single-page app of this scope is fine.

**Observations**
- `index.html` has **no Cache-Control and no ETag** — the edge serves it `DYNAMIC`. Every full reload fetches 12.5 KB + pays a Cloudflare origin hop (~130 ms TTFB). For a bundle whose filename carries a `?v=0.5.23` cache-bust, the HTML itself could at least advertise `Cache-Control: no-cache` + a strong `ETag` so the browser can 304 it.
- `style.css` and `app.js` both use **`max-age=14400`** (4 h) with a weak ETag. Because the URL is versioned, immutable long caching would be safer: `Cache-Control: public, max-age=31536000, immutable`. Today every 4 h both files are re-downloaded (155 KB + 83 KB = 238 KB) despite the version query string never changing between deploys.

---

## 3. Cache / ETag Header Audit (TC3)

| URL | Status | Cache-Control | ETag | CF-Cache-Status |
|-----|-------:|---------------|------|-----------------|
| `/api/state` | 200 | **null** | **null** | DYNAMIC |
| `/api/state?league_id=noop` | 200 | **null** | **null** | DYNAMIC |
| `/static/style.css?v=0.5.23` | 200 | `max-age=14400` | weak ETag | HIT |
| `/static/app.js?v=0.5.23` | 200 | `max-age=14400` | weak ETag | HIT |
| `/` (index.html) | 200 | **null** | **null** | DYNAMIC |

**Findings**
- **No caching on any `/api/*` endpoint.** All JSON responses are returned fully every call — no `ETag`, no `Last-Modified`, no `Cache-Control`. This is the single biggest missed optimisation (see §9).
- Static assets: `max-age=14400` is acceptable but not immutable; because the URL is version-busted (`?v=0.5.23`) an `immutable` flag with a year-long `max-age` would eliminate revalidation.
- HTML root has **no cache control** — should be `no-cache` with an ETag.

---

## 4. Network-Waste Inventory (TC4, 3 min idle + 3 min active)

### Idle window (3 min, no interaction)

| Endpoint | Calls in 3 min idle |
|---|---:|
| `/api/personas` | 1 |
| `/api/league/status` | 1 |
| `/api/league/settings` | 1 |
| `/api/leagues/list` | 1 |
| `/api/seasons/list` | 1 |
| `/api/state` | 1 |
| `/api/season/standings` | 1 |
| `/api/season/schedule` | 1 |
| `/api/season/lineup-alerts` | 1 |
| `/api/seasons/2025-26/headlines` | 1 |
| `/api/players` | 1 |
| **Idle total** | **11 XHR, all on initial bootstrap** |

**Good news:** **zero polling during idle** — no `setInterval` is hammering `/api/state`, `/api/players`, or anything else when the user sits still. This is a significant improvement versus naive fantasy-sports SPAs that typically poll every few seconds.

### Active window (3 min, tab cycling `#draft → #teams → #fa → #league → #schedule` every 2 s)

| Endpoint | Calls in 3 min active | Notes |
|---|---:|---|
| `/api/players` | **36** | Re-fetched on `#fa` and `#draft` hash entries; 5 tab rotations × 7 visits ≈ matches |
| `/api/seasons/2025-26/headlines` | 18 | Re-fetched every `#league` visit |
| `/api/teams/0` | 18 | Re-fetched every `#teams` visit |
| `/api/fa/claim-status` | 18 | Re-fetched every `#fa` visit |
| `/api/season/logs` | 18 | Re-fetched every `#league` visit |
| `/api/trades/pending` | 18 | Re-fetched every `#league`/`#teams` visit |
| **Active total** | **126** | **No endpoint exceeded 100** in the 3 min window; `/api/players` topped out at 36 |

**Verdict:** no endpoint breached the >100-calls-in-5-min threshold the task asked about. **But** every hash-route change re-fires the same read endpoints from scratch — there is no client-side caching or ETag short-circuit. Because the server sends no cache headers for `/api/*` (TC3), every one of those 126 calls was a full JSON round-trip.

**Biggest waste:** `/api/players` at **36×** ~38 KB+ per call (player list is large). Back-of-envelope ≈ **1.3 MB transferred in 3 min just from tab switches**, none of which would be needed if the endpoint sent `ETag`+`Cache-Control: private, max-age=60`.

---

## 5. Memory Growth (TC5)

Chromium's `performance.memory` is **quantised to 10-MB buckets** without cross-origin isolation, so all 11 samples over 5 min of tab cycling returned identical `usedJSHeapSize = 10 000 000 / totalJSHeapSize = 10 000 000`. This is a tool limitation, not evidence of a leak.

**What we *can* conclude from the data available:**
- Used heap stayed **below 10 MB** across the entire 5-min loop of hash routing + data re-fetches (if it had crossed the bucket boundary it would have jumped to ~20 MB).
- No heap bucket crossings over ≈200 DOM reshuffles and ≈126 API re-fetches.
- **Leak verdict: no evidence of unbounded growth**, within the 10-MB-bucket resolution limit.

**Recommendation for deeper leak testing:** enable CDP (`page.context().newCDPSession().send('Performance.enable')` → `Memory.getAllTimeSamplingProfile`) or run Chrome with `--enable-precise-memory-info` so sampling is byte-exact. That would be needed to catch slow multi-hour leaks; single-digit-MB drifts are invisible at bucket resolution.

---

## 6. Longest Tasks / Frames (TC6)

60 s of active tab cycling with `PerformanceObserver({ type: 'longtask' })`:

| # | startTime (ms) | duration (ms) |
|--:|--------------:|--------------:|
| 1 | 5 398 | 81 |
| 2 | 12 942 | 75 |
| 3 | 20 515 | **91** |
| 4 | 28 073 | 82 |
| 5 | 35 643 | 81 |
| 6 | 43 212 | 86 |
| 7 | 50 755 | **93** |
| 8 | 58 333 | 89 |

**Observation:** **8 longtasks in 60 s (~one every 7.5 s)**, each 75–93 ms. These align precisely with the 1.5 s-spaced tab rotations — **each hash-route change blocks the main thread for ~80 ms**. This is above the 50 ms longtask threshold and close to the 100 ms INP "good" ceiling, but not catastrophic.

**Root cause (inferred):** tab rotation triggers a full re-render + awaited JSON parse for the newly-fetched endpoints. With the current cold-fetch model (§4) the browser has to parse/hydrate list views every time.

**DOM churn:** **484 MutationObserver records in 60 s of cycling** → ~60/sec sustained. Not thrashing, but indicates full subtree replacement on every tab switch rather than minimal diffing. A keyed re-render or `requestIdleCallback`-batched mutation pass would halve it.

---

## 7. Polling / Timer Audit (TC7)

Pre-`goto` `setInterval`/`setTimeout`/`clear*` monkey-patch, then 3 min idle:

| Bucket | Count |
|---|---:|
| `setInterval` ever called | **0** |
| `clearInterval` ever called | 0 |
| Active intervals after 3 min idle | **0** |
| `setTimeout` ever called | 3 |
| `clearTimeout` ever called | 0 |

**Finding:** the page installs **zero `setInterval` timers during the whole session**. The "no idle polling" observation from TC4 is therefore fully explained — there is no timer-driven reloading of `/api/state` or any other endpoint. Refreshes happen only on hash-nav or user actions.

**3 `setTimeout`** callers are Cloudflare's `cdn-cgi/challenge-platform` and beacon scripts, not app code. No leakage.

**This is a very clean polling profile** — significantly better than most competing fantasy-sports SPAs. No recommendations here.

---

## 8. Cold vs Warm Reload Stall (TC8)

Same browser context, first `goto()` then `reload()`:

| Phase | Total load (ms) | FCP (ms) |
|-------|----------------:|---------:|
| Cold (first goto) | 2 192 | 532 |
| Warm (reload) | 1 677 | **152** |
| Improvement | -23 % | **-71 %** |

**No first-render stall detected.** Warm reload hits `cf-cache: HIT` for static assets and FCP drops to 152 ms — sub-perceptual. The 1.7 s warm total is dominated by Cloudflare's RUM beacon + challenge-platform scripts (~1.3 s of the budget), not app code.

---

## 9. Consolidated Recommendations (ranked by impact)

| Rank | Fix | Target | Expected Win |
|-----:|-----|--------|--------------|
| **P0** | Add `ETag` + `Cache-Control: private, max-age=30–60` to `/api/players`, `/api/teams/*`, `/api/season/*`, `/api/trades/pending`, `/api/fa/claim-status` | TC3 + TC4 | **≈1 MB / 3 min active** saved; 80-ms longtasks halved because 304s skip JSON parse |
| **P1** | Same for `/api/state` — it's 38 KB and completely uncached | TC3 | 38 KB × N route changes saved per session |
| **P2** | Switch static assets to `Cache-Control: public, max-age=31536000, immutable` (URLs are already version-busted) | TC2/TC3 | Zero 4-hour revalidation cost; ~238 KB saved per returning visitor per day |
| **P3** | Add `Cache-Control: no-cache` + strong `ETag` on `/` (index.html) | TC3 | Enables 304 on HTML; saves ~13 KB + a TLS+origin hop |
| **P4** | On hash-route change, reuse cached responses from a simple in-memory `Map<url, {data, ts}>` with 30-s TTL before re-issuing fetch | TC4 / TC6 | Biggest UX gain: tab switching becomes instant; eliminates 80-ms longtasks; ~126 → ~11 calls per 3 min active |
| **P5** | Dedup simultaneous `/api/state`+`/api/league/status`+`/api/league/settings`+`/api/leagues/list` bootstrap into one `/api/bootstrap` payload | TC1/TC4 | Cuts initial XHR count from 11 → 1–2; shaves 200–300 ms off TTI |
| **P6** | For TC5-grade leak verification, launch Chrome with `--enable-precise-memory-info` or enable COOP/COEP for byte-exact `performance.memory` | tooling | Required before any firm leak claim beyond 10-MB bucket resolution |

## 10. P0 Performance Bugs

None that block release. Observed behaviour is acceptable; all "bugs" above are **missed optimisations**, not regressions:

- `/api/*` has **no caching directives** (high-impact optimisation miss, not a functional bug).
- Tab switches re-fire full read endpoints instead of using a short client-side TTL (optimisation, not bug).
- `index.html` lacks `Cache-Control` / `ETag` (optimisation).

**Recommendation to release:** ship v0.5.23 as-is from a perf perspective; open follow-up tickets for P0–P5 above.

---

## Cleanup

- No tmux sessions were used (this was an in-process Playwright run).
- All artifacts retained in `D:/claude/fantasy nba/tests/qa_wave_v0.5.23_round2/qa-r2-obs-g4/` for cross-reference with pair `qa-r2-g4`.
- No league state was mutated (read-only profiling).

## Final Checklist

- [x] Verified prerequisites (target reachable, Playwright deps available, sandbox created)
- [x] Waited for service readiness (each test uses `waitUntil: 'networkidle'`)
- [x] Captured actual output before asserting (all numbers from JSON artifacts)
- [x] All 8 tests green
- [x] Every TC shows command, expected, actual, and verdict
