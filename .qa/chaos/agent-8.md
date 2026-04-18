# Agent 8 — Mobile Viewport Stress (iPhone 12 / 390x844)

Port 3418 | Playwright headless Chromium | iOS UA | deviceScaleFactor=3

## Layout Bugs

### BUG-1: Draft board table overflows 698px on every tab load
- **Affected routes**: #draft, home (draft is default tab)
- **Screenshot**: agent-8-01-home.png, agent-8-02-draft.png
- **Detail**: `TABLE.board` overflows viewport by 698px. The board has `min-width: 720px` (style.css:444) inside `.board-wrap { overflow-x: auto }` (style.css:432), but the outer `.main-view` has `overflow-x: hidden` at max-width 900px (style.css:159), clipping the wrapper's scrollbar. On mobile the board is completely inaccessible — user cannot scroll to see team columns 2-8.
- **Hypothesis**: style.css:159 `.main-view { overflow-x: hidden }` kills the `.board-wrap` scroll container. Fix: remove `overflow-x: hidden` from `.main-view` or set it only on non-board sections.

### BUG-2: `.week-cell` buttons extend below viewport on #schedule
- **Affected route**: #schedule
- **Screenshot**: agent-8-06-schedule.png
- **Detail**: Week 15 and 16 cells report `bottom: 868px` against `viewH: 844` — protruding 24px below the fold and behind the fixed bottom tab bar. The schedule grid has no `padding-bottom` accounting for `--tabbar-h`.
- **Hypothesis**: style.css:574-588 `.week-cell` / schedule grid container missing `padding-bottom: var(--tabbar-h)`. The `.layout` padding-bottom (style.css:145) may not cascade into the schedule scroll container.

### BUG-3: FA "Sign" button clipped under bottom tab bar
- **Affected route**: #fa
- **Screenshot**: agent-8-04-fa.png
- **Detail**: `.btn-sign` button `bottom: 827px` (viewH 844, tab bar ~60px) — last FA row sign button sits directly behind the tab bar overlay and cannot be tapped.
- **Hypothesis**: The FA list lacks `padding-bottom: calc(var(--tabbar-h) + 8px)` so the last row is hidden under the fixed `.bottom-tabs` (style.css:164-174).

## Tap Target Size Violations (< 44x44 per A11y)

### BUG-4: `.hh-dot-btn` dots — 8x8px (active: 11x11px)
- **Sections**: home, draft
- **Screenshot**: agent-8-01-home.png
- **Detail**: Headline carousel dots are 8px × 8px (style.css:2731-2740). The `::after` pseudo expands hitbox by `inset: -18px -4px` (style.css:2745) — but on mobile Playwright measures the element rect, not the pseudo hitbox. Visual tap area is still tiny.
- **Hypothesis**: style.css:2731 — set `width/height: 44px` on `.hh-dot-btn` and shrink the visual dot via `::before`, or use `padding: 18px` instead.

### BUG-5: `.btn.small` — 38x36px (lineup swap, sign buttons)
- **Sections**: teams, fa
- **Screenshot**: agent-8-03-teams.png
- **Detail**: `.btn.small` mobile override sets `min-height: 36px` (style.css:281) — still 8px short of 44px. Lineup swap buttons (`換`) report 38x36.
- **Hypothesis**: style.css:281 — raise `min-height` to 44px for `.btn.small` on mobile, adjust padding to `8px 12px`.

### BUG-6: `.league-tab` sub-tabs — 88x34px
- **Section**: #league
- **Screenshot**: agent-8-05-league.png
- **Detail**: The four league sub-tabs (對戰/戰績/聯盟/動態) are 88x34. No mobile height override exists for `.league-tab` (style.css:2213-2231).
- **Hypothesis**: style.css:2213 — add `@media (max-width: 767px) { .league-tab { min-height: 44px; } }`.

## Dialogs

- Settings and Trade dialogs not found via standard selectors — possible these are toggled via JS state not button text. No dialog overflow confirmed (cannot test).
- League settings sub-tab opened successfully (screenshot agent-8-09-league-settings-dialog.png); no overflow detected.

## No JS Errors

Zero pageerror events across all routes.

## Summary

5 confirmed bugs. Critical: BUG-1 (draft board completely inaccessible on mobile), BUG-3 (FA sign button hidden). High: BUG-2 (schedule cells behind tab bar), BUG-4/5/6 (sub-44px tap targets across multiple sections).
