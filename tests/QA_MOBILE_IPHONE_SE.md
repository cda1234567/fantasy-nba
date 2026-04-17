# QA Mobile Report — iPhone SE (375×667)

**Test file:** `tests/qa_mobile_3.py`
**Date:** 2026-04-17
**Viewport:** 375×667 px, device_scale_factor=2, is_mobile=True, has_touch=True
**UA:** iPhone iOS 15 / Mobile Safari
**App:** http://localhost:3410 — NBA Fantasy Simulator (繁中 UI)
**Headless Chromium via Playwright**

---

## Summary

| Checkpoint | Status | Key Finding |
|---|---|---|
| TC1 Landing | FAIL | P1 Horizontal overflow — page is 1008px wide |
| TC2 Draft page render | FAIL | P0 + P1 — pick buttons are entirely off-screen |
| TC2b Draft scroll | FAIL | Overflow persists through scroll |
| TC2c Human pick | FAIL | P0 — pick button at x=907px, viewport=375px |
| TC2d Draft advance (API) | PASS | API-driven; draft completed |
| TC3 Headlines banner | FAIL | P2 overflow; P3 toggle slightly under 44px |
| TC4a Settings modal | FAIL | P1 overflow inside modal |
| TC4b Week 1 league page | PASS | No overflow on league page |
| TC4c Season advance | PASS | Season ran (API endpoints located post-run) |
| TC5a Trades panel | PASS | No trade items active yet |
| TC5b Propose trade | WARN | No propose button found on teams page |
| TC6 Injuries | FAIL | P2 overflow; injury rows not found by selector |
| TC7 Standings | FAIL | 40 table cells wrap to multiple lines |

**Total: 13 tests | Passed: 4 | Failed: 8 | Warned: 1**

---

## Issues — Severity Ordered

### P0 — Showstopper

#### ISSUE-01: Draft is completely unusable on iPhone SE
- **Where:** `#draft` page, all states
- **Symptom:** The draft controls bar (`.clock-actions` / `.panel`) has `scrollWidth=994px` on a 375px viewport. The first available pick button renders at `x=907px` — 532px outside the right edge of the screen. No amount of scrolling reveals it because the pick button column is in a fixed-layout table that simply overflows off the right side.
- **Evidence:** `body.scrollWidth=1008px`, button `getBoundingClientRect().x=907`
- **Impact:** A real user on an iPhone SE (or any phone ≤~800px wide) **cannot draft at all**. The pick button is literally unreachable.
- **Screenshots:** `q3_10_draft.png`, `q3_12_pick.png`

---

### P1 — Major (breaks core flow)

#### ISSUE-02: Global horizontal overflow — entire app is 1008px wide
- **Where:** Landing page, draft, FA, injuries, settings modal
- **Symptom:** `document.documentElement.scrollWidth=1008px` on a 375px viewport. The page is 2.7× wider than the screen. Every page except the league/standings page triggers horizontal scroll.
- **Root cause:** Almost certainly a fixed-width container, a table with `min-width`, or a flex/grid layout not using `max-width: 100%` or `overflow-x: hidden`. The draft board's action column is the likely culprit propagating to the body.
- **Screenshots:** `q3_01_landing.png`, `q3_15_headlines.png`, `q3_40_injuries.png`

#### ISSUE-03: Settings modal has horizontal overflow
- **Where:** `dialog#dlg-settings` opened via hamburger
- **Symptom:** Modal itself is 302px wide (fits), but the page behind it still shows `scrollW=1008px`. Content inside the modal may also overflow if the dialog does not clip body scroll.
- **Screenshot:** `q3_60_settings_modal.png`

---

### P2 — Significant (degrades usability)

#### ISSUE-04: Pick button tap target 72×36px — below Apple 44×44 guideline
- **Where:** All `button[data-draft]` elements
- **Symptom:** Height is 36px. Apple HIG requires minimum 44×44px tap target.
- **Impact:** Even if the button were on-screen, it is too small to tap reliably with a finger.

#### ISSUE-05: Headlines toggle barely misses 44px height (43.5px)
- **Where:** `.headlines-toggle` button (349×43.5px)
- **Symptom:** Width is 349px (near-full-width, fine) but height is 43.5px — just 0.5px under the 44px threshold. Practically acceptable but technically non-compliant.
- **Screenshot:** `q3_15_headlines.png`

#### ISSUE-06: 40 table cells in standings wrap to multiple lines
- **Where:** `#league` standings table
- **Symptom:** `getBoundingClientRect().height > lineHeight * 1.5` for 40 cells. Numbers like team record (W/L), points for/against, and fantasy scores are wrapping onto two lines in their columns.
- **Impact:** Score columns become unreadable. A real user cannot skim standings quickly.
- **Screenshot:** `q3_50_standings.png`
- **Note:** The table itself fits within 375px (`scrollWidth=349px`) — the issue is column widths being too narrow, forcing number wrapping, not horizontal overflow.

#### ISSUE-07: Injuries page shows horizontal overflow with no injury UI found
- **Where:** `#fa` route (where injuries were expected)
- **Symptom:** Page overflow=True (`scrollW=1008px`) and injury-specific selectors (`.injury-row`, `.injury-item`) returned 0 elements. Injury data exists in the season state (1 injury noted), but the injury UI panel either uses different selectors or requires the season to be further along.
- **Screenshot:** `q3_40_injuries.png`

---

### P3 — Minor / Polish

#### ISSUE-08: Side nav visible on mobile
- **Where:** `.side-nav` — visible=False (actually PASS — this was correctly hidden)
- *Correct behaviour confirmed.*

#### ISSUE-09: Settings modal buttons — some under 44px
- **Where:** `dialog button, .settings-dialog button`
- **Symptom:** At least 3 buttons reported under 44×44px tap target in settings modal.
- **Impact:** Tapping wrong button in a small modal on a phone is frustrating.

---

## Page-by-Page Detail

### Landing (`/`)
- Bottom tabs (.bottom-tabs): **visible** — correct mobile nav behaviour
- Side nav (.side-nav): **hidden** — correct
- Horizontal overflow: **YES** — 1008px body width
- Screenshot: `q3_01_landing.png`

### Draft (`/#draft`)
- Player table rendered: **YES** (93 name cells)
- Pick buttons found: **80**
- First button x position: **907px** (off-screen)
- Controls bar scrollWidth: **994px**
- Player name cells wrapping: **0** — names display on one line
- Screenshot: `q3_10_draft.png`, `q3_11_draft_scroll.png`, `q3_12_pick.png`

### Headlines
- Toggle found: **YES** (349×43.5px)
- Headline items rendered: **10** — correct count
- Banner height: **46px** — does NOT block main content
- Overflow: **YES** (same global 1008px issue)
- Screenshot: `q3_15_headlines.png`

### Settings Modal (`#btn-menu`)
- Opened successfully: **YES**
- Modal width: **302px** — fits in 375px viewport
- Modal height: within viewport
- Overflow: **YES** — underlying page still 1008px
- Screenshot: `q3_60_settings_modal.png`

### Season / League (`/#league`)
- Week 1: **no overflow** — only page that renders cleanly
- Standings table scrollWidth: **349px** — fits viewport
- Cell wrapping: **40 cells** wrap to multiple lines
- Screenshots: `q3_20_w01.png`, `q3_21_w10.png`, `q3_22_w20_end.png`, `q3_23_playoffs.png`, `q3_24_champion.png`

### Teams (`/#teams`)
- No horizontal overflow detected
- Trade items: **0** (season at week 0 — no AI trades generated yet)
- Propose button: **not found** — may require a team to be selected first
- Screenshots: `q3_30_trades.png`, `q3_31_trade_detail.png`, `q3_32_propose_mobile.png`

### FA / Injuries (`/#fa`)
- Injury panel selectors returned **0 rows** — UI selector mismatch
- Page overflow: **YES** (1008px)
- Font size on page: **15px** — acceptable
- Screenshot: `q3_40_injuries.png`

### Standings (`/#league`)
- Table fits viewport width: **YES** (349px)
- Cell wrapping: **40 cells** — major readability issue
- Font size: **14px** — acceptable minimum
- Screenshot: `q3_50_standings.png`

---

## What Would Frustrate a Real iPhone User

1. **Cannot draft.** Opening the app on an iPhone SE to do the draft is a dead end — the Pick button is invisible, off the right edge. Even knowing to scroll right, it would require scrolling per-row and the entire experience is broken.
2. **Constant accidental horizontal scroll.** Every page except the league standings causes the viewport to shift right when swiped. The user would constantly see half-content and have to scroll back.
3. **Standings are a blur.** With 40 cells wrapping, the standings table looks broken — scores appear on their own lines, team rows have inconsistent heights.
4. **Injuries hard to find.** The injury panel did not surface with standard CSS selectors on `#fa` — a real user hunting for their injured player's return date would struggle to find it.
5. **Settings buttons too small.** The gear modal has sub-44px buttons — on a phone this means repeated mis-taps on the wrong season action (e.g., accidentally resetting the draft instead of advancing).

---

## Screenshots

| File | Description |
|---|---|
| `q3_01_landing.png` | Landing page — shows overflow |
| `q3_10_draft.png` | Draft page — pick buttons off-screen right |
| `q3_11_draft_scroll.png` | Draft scrolled mid-list |
| `q3_12_pick.png` | After JS-forced pick (button not visually reachable) |
| `q3_13_mid_draft.png` | Mid-draft round 5 state |
| `q3_14_draft_end.png` | Draft complete state |
| `q3_15_headlines.png` | Headlines banner expanded |
| `q3_20_w01.png` | League page week 1 |
| `q3_21_w10.png` | League page week 10 |
| `q3_22_w20_end.png` | End of regular season |
| `q3_23_playoffs.png` | Playoffs view |
| `q3_24_champion.png` | Champion view |
| `q3_30_trades.png` | Teams/trades panel |
| `q3_31_trade_detail.png` | Trade detail (no active trades) |
| `q3_32_propose_mobile.png` | Propose trade — no modal found |
| `q3_33_propose_filled.png` | Propose filled state |
| `q3_40_injuries.png` | Injuries view (FA page) |
| `q3_50_standings.png` | Standings — cell wrap issue |
| `q3_60_settings_modal.png` | Settings modal mid-season |

---

## Fix Recommendations (for dev reference — not in QA scope)

| Issue | Likely Fix |
|---|---|
| ISSUE-01/02 global overflow | Add `overflow-x: hidden` to `body`/`.layout`; audit all fixed-width containers; make draft board table responsive (`table-layout: auto`, use `min-width` sparingly) |
| ISSUE-01 pick button off-screen | The `.panel` / `.clock-actions` draft action bar needs `flex-wrap: wrap` or a mobile card layout where the Pick button is above the player row |
| ISSUE-04 tap target | Add `min-height: 44px; min-width: 44px` to all draft pick buttons |
| ISSUE-06 standings wrapping | Reduce columns on mobile (hide non-essential stats), or use smaller font + `white-space: nowrap` on numeric cells |
