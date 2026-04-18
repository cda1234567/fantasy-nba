# ITER1 O2 — Code Audit for UX+Gameplay (v0.5.2)

## 3 Most Urgent Fixes

1. **[CRITICAL] Cancel-vs-background-finalize race** (`app/main.py:862-885`)
   - `_finalize` didn't re-check `trade.status == "pending_accept"` before `auto_decide_ai`
   - Fix: added guard after `_find`; also re-load state before AI decision in case cancel happened during peer-commentary collection
   - STATUS: **FIXED in v0.5.3 (pending commit)**

2. **[CRITICAL] Silent swallow of draft persistence failure** (`app/trades.py:427-430`)
   - `_apply_swap` saves draft wrapped in bare `except: pass`; rosters mutate in memory but not on disk → permanent data drift on restart
   - Fix: log warning on save failure so operator sees it

3. **[HIGH] `trade_deadline_week` defined but not enforced** (`app/models.py:42`)
   - Setting exposed in UI but never checked by `TradeManager.propose()` or `_run_trades_daily()`
   - Fix: propose() rejects when `current_week > trade_deadline_week`; daily sim AI skips proposals past deadline

## Top 5 Feature Ideas (by impact)

1. **Counter-offers from AI GMs** — swap binary accept/reject for negotiation. Highest leverage for "real GM" feel.
2. **Trade deadline drama** — enforce deadline + losing-team urgency scaling in final 2 weeks.
3. **Weekly recap / narrative feed** — milestones exist in log.json but never surfaced in UI.
4. **Lineup management for human** — currently auto-set; drag-drop bench/start is core missing mechanic.
5. **Veto direction awareness** — `vote_veto_multi_factor` is symmetric; human overpaying gets vetoed for no reason.

## Code Smells

1. Bare `except: pass` in 8+ locations silently hides data-loss failures
2. `TradeManager` rebuilt per request with no locking → concurrent stale-read/lost-write
3. Global mutable `draft` singleton; FastAPI async workers can interleave mutations
4. `_prev_fppg_map` falls back to `0.0` → rookies/transfers undraftable by AI
5. `need_alignment` hardcoded `0.0` in veto formula → allocated 10% weight is dead code

## Verdict

Core loop works but season phase is passive. Top 3 fixes + features 1+3+4 would transform the game into something with decisions and consequences.
