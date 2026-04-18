# Stress Test Report — v0.5.39 N-for-M Trade System

**Date**: 2026-04-18 23:00:11
**Target**: http://127.0.0.1:3500  |  league: stress1

## Summary

| Metric | Value |
|--------|-------|
| Trades submitted | 21 |
| Accepted/Executed | 1 |
| Rejected | 3 |
| Countered | 4 |
| Vetoed | 0 |
| Expired | 0 |
| Edge cases → 400 (expected) | 5 |
| Edge cases → unexpected response | 0 |
| HTTP 500 errors | 2 |
| Roster integrity violations | 0 |

## Roster Integrity

All rosters at exactly 13 players. No player appears on two rosters. **PASS**

## Drop Annotation (自動丟棄替補)

All N≠M executed trades have '自動丟棄替補' annotation (count=0). **PASS** (or no N≠M trades executed)

## Edge Case Validation

- Empty send/receive list → 400: PASS
- Duplicate IDs → 400: PASS
- Player not on roster → 400: PASS
- Same player both sides → 400: PASS

## Fairness Observations

No obvious fairness misjudgements detected.

## Crashes / 500 Errors

**2 HTTP 500 errors encountered.**

## Detailed Log

```
[22:59:59] Server ready: {'ok': True, 'version': '0.5.39', 'league_id': 'stress1', 'ai_enabled': False}
[22:59:59] === Step 1: Setup league ===
[22:59:59]   league/setup -> 200
[22:59:59] === Step 2: Auto-draft ===
[22:59:59]   draft/reset -> 200
[23:00:03]   draft done: 104 picks processed
[23:00:03]   draft is_complete=True
[23:00:03] === Step 3: Start season ===
[23:00:03]   season/start -> 200
[23:00:03] === Advancing 30 days (use_ai=False) ===
[23:00:04]   day 7 week 1
[23:00:04]   day 14 week 2
[23:00:05]   day 21 week 3
[23:00:06]   day 28 week 4
[23:00:06] === Step 4: Submitting trades ===
[23:00:06]   roster sizes: {0: 13, 1: 13, 2: 13, 3: 13, 4: 13, 5: 13, 6: 13, 7: 13}
[23:00:06]   T0 top3: [('Nikola Jokić', 61.0), ('Jalen Johnson', 47.3), ('Kawhi Leonard', 44.7)]
[23:00:06]   T1 top3: [('Shai Gilgeous-Alexander', 49.5), ('Cade Cunningham', 47.1), ('Paolo Banchero', 40.2)]
[23:00:06]   T2 top3: [('Victor Wembanyama', 51.3), ('Tyrese Maxey', 47.5), ('Jayson Tatum', 43.4)]
[23:00:06]   T3 top3: [('Giannis Antetokounmpo', 48.3), ('Anthony Edwards', 43.0), ('Jamal Murray', 42.3)]
[23:00:06]   T4 top3: [('Luka Dončić', 56.4), ('Scottie Barnes', 40.6), ('Bam Adebayo', 40.0)]
[23:00:06]   T5 top3: [('Alperen Sengun', 42.9), ('Cooper Flagg', 38.7), ('Keyonte George', 37.6)]
[23:00:06]   T6 top3: [('James Harden', 41.6), ('Jalen Brunson', 40.0), ('Karl-Anthony Towns', 39.9)]
[23:00:06]   T7 top3: [('Donovan Mitchell', 43.5), ('Anthony Davis', 42.8), ('Amen Thompson', 38.5)]
[23:00:07]   [1-for-1 fair (top swap)] -> 200
[23:00:07]   [1-for-1 lopsided (bench for star)] -> 200
[23:00:07]   [2-for-1 (2 bench for 1 star)] -> 200
[23:00:07]   [1-for-2 (1 star for 2 mid)] -> 200
[23:00:07]   [3-for-1 (3 bench for 1 star)] -> 200
[23:00:07]   ERROR 500: POST /api/trades/propose -> Internal Server Error
[23:00:07]   [2-for-3 (2 mid for 3 bench)] -> 500
[23:00:07]   [3-for-3 balanced] -> 200
[23:00:07]   [3-for-3 lopsided (bench vs starters)] -> 200
[23:00:07]   [1-for-1 mid T1] -> 200
[23:00:07]   [1-for-1 mid T2] -> 200
[23:00:07]   [1-for-1 mid T3] -> 200
[23:00:07]   [1-for-1 mid T4] -> 200
[23:00:07]   [1-for-1 mid T5] -> 200
[23:00:07]   [1-for-1 mid T6] -> 200
[23:00:07]   [1-for-1 mid T7] -> 200
[23:00:07]   [2-for-1 mid T1] -> 200
[23:00:07]   ERROR 500: POST /api/trades/propose -> Internal Server Error
[23:00:07]   [2-for-1 mid T2] -> 500
[23:00:07]   [2-for-1 mid T3] -> 200
[23:00:07]   [1-for-2 star T4] -> 200
[23:00:07]   [1-for-2 star T5] -> 200
[23:00:07]   [2-for-3 T6] -> 200
[23:00:08]   [2-for-3 T7] -> 200
[23:00:08]   --- edge cases ---
[23:00:08]   [edge: empty send] -> 400 OK (expected)
[23:00:08]   [edge: empty receive] -> 400 OK (expected)
[23:00:08]   [edge: duplicate send] -> 400 OK (expected)
[23:00:08]   [edge: player not on proposer roster] -> 400 OK (expected)
[23:00:08]   [edge: same player both sides] -> 400 OK (expected)
[23:00:08]   Total submitted: 21, edge 400s: 5
[23:00:08]   Waiting up to 90s for AI decisions...
[23:00:08]   All AI decisions complete (7 total pending remain)
[23:00:08] === Step 5: Advancing 3 days past veto window ===
[23:00:08]   Done advancing past veto window
[23:00:11] === Step 7: Tallying trade results ===
[23:00:11]   Status breakdown: {'rejected': 3, 'countered': 4, 'executed': 1, 'pending_accept': 6}
[23:00:11]   Pending/history consistency: OK (no overlap)
[23:00:11]   Fairness issues flagged: 0
[23:00:11] === Step 6: Verifying roster integrity ===
[23:00:11]   executed trades to verify: 1
[23:00:11]   Roster size violations: 0
[23:00:11]   Duplicate player violations: 0
[23:00:11]   N≠M trades with 自動丟棄替補 annotation: 0
[23:00:11] === Writing report ===
```