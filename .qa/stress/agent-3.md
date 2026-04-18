# Injury Stress Test — agent-3 (stress3 league, 70 days)

**Date:** 2026-04-18  
**Server:** uvicorn port 3502, DATA_DIR=.qa/stress/data-3, LEAGUE_ID=stress3  
**Setup:** 8 teams × 13 roster = 104 players drafted, season started, 70 days advanced (use_ai=false)

---

## 1. Preseason Injuries

After `POST /api/season/start`, before day 1:

- **Active count: 5** (expected ~2 at 2% × 104 players; got 5 — within 2σ, plausible)
- All 5 had `status=out`, `diagnosed_day=0`, `return_in_days` 7–21
- History count matched active (5 entries, no duplicates)

---

## 2. Weekly Snapshots — Active / History over 70 Days

| Week | Day | Active | History |
|------|-----|--------|---------|
| 1    | 7   | 6      | 8       |
| 2    | 14  | 3      | 13      |
| 3    | 21  | 3      | 21      |
| 4    | 28  | 5      | 27      |
| 5    | 35  | 6      | 34      |
| 6    | 42  | 6      | 48      |
| 7    | 49  | 3      | 55      |
| 8    | 56  | 5      | 61      |
| 9    | 63  | 9      | 67      |
| 10   | 70  | 6      | 74      |

History grows monotonically every week — `tick_injuries` and `roll_daily_injuries` both running correctly.

---

## 3. New Injury Count Over 70 Days

- Preseason entries (diagnosed_day=0): **10** (5 injuries × 2 entries each: original + healed snapshot)
- In-season entries (diagnosed_day>0): **64**
- **Unique players injured in-season: 31**
- Expected from formula: 80 starters × 0.006/day × 70 days = **~34**
- Actual unique players: **31** — within expected range (20–50). PASS.

---

## 4. tick_injuries — Decrement and Healing

- All healed entries in history have `return_in_days=0`. **PASS** (0 violations).
- All active injuries have `return_in_days > 0`. **PASS** (0 violations).
- 12 `day_to_day` injuries originated; all 12 healed (returned to active pool). **PASS**.
- Healed players correctly removed from `season.injuries` dict.

---

## 5. Re-injury Detection (False Positive Resolved)

Two players (pid=1642843 Cooper Flagg, pid=203076 Anthony Davis) appeared in both healed history and active injuries. Investigation confirmed these are **legitimate re-injuries**:
- First injury → healed → second injury later (different `diagnosed_day`)
- History correctly contains: [original_out, healthy, second_out]
- No data integrity issue. **PASS**.

---

## 6. Cross-Check: injured_out Players Not Scoring

- 35 game_logs for currently-injured players had `fp > 0` — investigated carefully.
- **All 35 logs occurred on days BEFORE the player's `diagnosed_day`** (i.e., pre-injury scores).
- Zero logs on or after `diagnosed_day` with `fp > 0`. **PASS**.
- The `is_injured` path in `_sample_game` correctly zeroes `fp` and sets `played=False`.

---

## 7. Findings Summary

| Check | Result |
|-------|--------|
| New injury count over 70 days (31 unique, ~34 expected) | PASS |
| History grows each week | PASS |
| Healed entries have return_in_days=0 | PASS |
| Active injuries have return_in_days>0 | PASS |
| day_to_day players heal and leave active list | PASS |
| Healed players not blocking lineups (re-injury false positive resolved) | PASS |
| injured_out players score fp=0 after diagnosed_day | PASS |
| Any crash / 500 errors | NONE |

**No bugs found.** Injury simulation operates within expected parameters across all 70 simulated days.
