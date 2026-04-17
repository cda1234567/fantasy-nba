# QA Mobile Report — iPhone 11 Pro Max (414×896)

**Date**: 2026-04-17  
**Agent**: Q4/4  
**Elapsed**: 102s  
**Result**: 31/40 passed (9 failed)

## Environment

- Device: iPhone 11 Pro Max simulation
- Viewport: 414×896, device_scale_factor=3
- User-Agent: iOS 16.0 Mobile Safari
- Mode: Headless Chromium (Playwright)
- App: http://localhost:3410 (Fantasy NBA Draft Simulator v0.3.0)
- AI: Disabled (heuristic-only)

## Checkpoint Summary

### CP1 Landing: PARTIAL (4/5)

- ✓ viewport width 414 — {'width': 414, 'height': 896}
- ✓ viewport height 896 — {'width': 414, 'height': 896}
- ✓ page title loaded — NBA Fantasy 模擬器
- ✓ body visible
- ✗ no horizontal overflow on landing

### CP2 Draft Setup: PARTIAL (1/3)

- ✓ draft view renders on mobile
- ✗ draft page no horizontal overflow
- ✗ landscape draft no overflow

### CP3 Season 1: PARTIAL (1/2)

- ✓ Season 1 has champion — champion=0
- ✗ Season 2 has champion — champion=None

### CP4 Wave J Trade Persuasion: PARTIAL (3/4)

- ✓ trade proposed with message — id=1a7e65d71b16418499e65b3377f742d9
- ✗ trade propose modal opened via UI — button not found or modal not opened
- ✓ trade propose screenshot captured
- ✓ Season 2 mid-season trade proposed

### CP5 Wave J Force-Execute: PARTIAL (3/4)

- ✓ force trade executed via API — status=executed, force_executed=True
- ✓ force_executed flag set in response — force_executed=True
- ✗ force checkbox UI test — modal not accessible
- ✓ force badge trades in history — found 1 force-executed trades

### CP6 Wave J Peer Commentary: PASS (9/9)

- ✓ peer commentary trades exist in history — found 1 trades with commentary
- ✓ peer commentary has entries — 3 entries
- ✓ peer commentary entry 1 has text — 看起來兩邊價值差距不小。
- ✓ peer commentary entry 1 has team info
- ✓ peer commentary entry 2 has text — 看起來兩邊價值差距不小。
- ✓ peer commentary entry 2 has team info
- ✓ peer commentary entry 3 has text — 看起來兩邊價值差距不小。
- ✓ peer commentary entry 3 has team info
- ✓ peer commentary section not visible in current view — no history items shown or commentary section not rendered

### CP7 Season 2: PARTIAL (4/5)

- ✓ Season 2 started — week=1
- ✓ Season 2 midseason advance — week=10
- ✓ Season 2 mid-season trade proposed
- ✗ Season 2 has champion — champion=None
- ✓ Trade history accumulated across seasons — 10 total trades in history

### CP8 Season 3: PASS (2/2)

- ✓ Season 3 started
- ✓ Season 3 completes successfully — champion=0

### CP9 Injuries: PARTIAL (3/5)

- ✓ injuries endpoint accessible — type=dict
- ✓ injuries data available — 4 injuries
- ✗ injury section found in league view
- ✗ injury indicators in teams view
- ✓ injury text no overflow

### CP10 Landscape: PARTIAL (1/2)

- ✗ landscape draft no overflow
- ✓ landscape league view no overflow

### CP11 Chinese Text: PASS (1/1)

- ✓ Chinese text overflow count acceptable — 0 overflowing elements

## Wave J Feature Assessment

### Trade Persuasion (proposer_message)
- ✓ trade proposed with message — id=1a7e65d71b16418499e65b3377f742d9

### Force-Execute
- ✓ force trade executed via API — status=executed, force_executed=True
- ✓ force_executed flag set in response — force_executed=True
- ✗ force checkbox UI test — modal not accessible
- ✓ force badge trades in history — found 1 force-executed trades

### Peer Commentary
- ✓ peer commentary trades exist in history — found 1 trades with commentary
- ✓ peer commentary has entries — 3 entries
- ✓ peer commentary entry 1 has text — 看起來兩邊價值差距不小。
- ✓ peer commentary entry 1 has team info
- ✓ peer commentary entry 2 has text — 看起來兩邊價值差距不小。
- ✓ peer commentary entry 2 has team info
- ✓ peer commentary entry 3 has text — 看起來兩邊價值差距不小。
- ✓ peer commentary entry 3 has team info
- ✓ peer commentary section not visible in current view — no history items shown or commentary section not rendered

## Landscape Findings

- ✗ landscape draft no overflow
- ✓ landscape league view no overflow

## Issues

### P2-01: Horizontal scroll on landing page at 414px width

### P2-02: Horizontal overflow on draft page at 414px

### P3-03: Horizontal overflow in landscape draft view

## Screenshots

- `q4_01_landing.png`
- `q4_10_draft.png`
- `q4_11_s1_w10.png`
- `q4_20_trade_propose.png`
- `q4_21_trade_result.png`
- `q4_22_force_ticked.png`
- `q4_23_force_executed.png`
- `q4_24_peer_mobile.png`
- `q4_30_s2_headlines.png`
- `q4_31_s2_mid.png`
- `q4_32_s2_end.png`
- `q4_33_s2_champ.png`
- `q4_40_s3_end.png`
- `q4_50_injuries.png`
- `q4_60_landscape_draft.png`
- `q4_61_landscape_trades.png`
- `q4_62_landscape_teams.png`

## All Test Cases

| # | Test | Status | Detail |
|---|------|--------|--------|
| 1 | viewport width 414 | PASS | {'width': 414, 'height': 896} |
| 2 | viewport height 896 | PASS | {'width': 414, 'height': 896} |
| 3 | page title loaded | PASS | NBA Fantasy 模擬器 |
| 4 | body visible | PASS |  |
| 5 | no horizontal overflow on landing | FAIL |  |
| 6 | draft view renders on mobile | PASS |  |
| 7 | draft page no horizontal overflow | FAIL |  |
| 8 | Season 1 has champion | PASS | champion=0 |
| 9 | trade proposed with message | PASS | id=1a7e65d71b16418499e65b3377f742d9 |
| 10 | trade propose modal opened via UI | FAIL | button not found or modal not opened |
| 11 | trade propose screenshot captured | PASS |  |
| 12 | force trade executed via API | PASS | status=executed, force_executed=True |
| 13 | force_executed flag set in response | PASS | force_executed=True |
| 14 | force checkbox UI test | FAIL | modal not accessible |
| 15 | force badge trades in history | PASS | found 1 force-executed trades |
| 16 | peer commentary trades exist in history | PASS | found 1 trades with commentary |
| 17 | peer commentary has entries | PASS | 3 entries |
| 18 | peer commentary entry 1 has text | PASS | 看起來兩邊價值差距不小。 |
| 19 | peer commentary entry 1 has team info | PASS |  |
| 20 | peer commentary entry 2 has text | PASS | 看起來兩邊價值差距不小。 |
| 21 | peer commentary entry 2 has team info | PASS |  |
| 22 | peer commentary entry 3 has text | PASS | 看起來兩邊價值差距不小。 |
| 23 | peer commentary entry 3 has team info | PASS |  |
| 24 | peer commentary section not visible in current view | PASS | no history items shown or commentary section not rendered |
| 25 | offseason headlines section rendered | FAIL |  |
| 26 | Season 2 started | PASS | week=1 |
| 27 | Season 2 midseason advance | PASS | week=10 |
| 28 | Season 2 mid-season trade proposed | PASS |  |
| 29 | Season 2 has champion | FAIL | champion=None |
| 30 | Trade history accumulated across seasons | PASS | 10 total trades in history |
| 31 | Season 3 started | PASS |  |
| 32 | Season 3 completes successfully | PASS | champion=0 |
| 33 | injuries endpoint accessible | PASS | type=dict |
| 34 | injuries data available | PASS | 4 injuries |
| 35 | injury section found in league view | FAIL |  |
| 36 | injury indicators in teams view | FAIL |  |
| 37 | injury text no overflow | PASS |  |
| 38 | landscape draft no overflow | FAIL |  |
| 39 | landscape league view no overflow | PASS |  |
| 40 | Chinese text overflow count acceptable | PASS | 0 overflowing elements |