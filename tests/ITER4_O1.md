# ITER4 O1: Performance Deep-Analysis -- advance-week / sim-to-playoffs

## Call Graph

advance_week (season.py:746)
  advance_day x7  (season.py:538)
    _run_trades_daily  (season.py:369)
      mgr.daily_tick -- pure heuristic, fast
      for each AI team (up to 6):
        ai_gm.propose_trade_heuristic -- pure heuristic, NO LLM
      for each pending_accept trade (counterparty is AI):
        mgr.collect_peer_commentary_sync  (trades.py:259)
          for commentator in [:3]:  <-- SERIAL LOOP
            ai_gm.peer_commentary  (ai_gm.py:479)
              call_llm  (llm.py:29) <-- 6s timeout each
        ai_gm.decide_trade  (ai_gm.py:343)
          _decide_trade_llm  (ai_gm.py:414)
            call_llm  (llm.py:29) <-- 6s timeout
      for each accepted trade, for each voter (up to 5):
        ai_gm.vote_veto_multi_factor -- pure heuristic, NO LLM
    tick_injuries -- pure, fast
    _set_lineups  (season.py:285)
      for each AI team (up to 7):  <-- SERIAL LOOP
        ai_gm.decide_day  (ai_gm.py:72)
          _call_api  (ai_gm.py:151)
            call_llm  (llm.py:29) <-- 6s timeout
    roll_daily_injuries -- pure, fast
    _sample_game per starter -- pure math, fast
    _resolve_week (day 7 only) -- pure, fast
    _detect_milestones (day 7 only) -- pure, fast
    storage.save_season -- disk I/O, ~ms

## LLM Call Count Per Week (worst case)

| Phase | Calls/day | Days | Total |
|-------|-----------|------|-------|
| _set_lineups -- decide_day per AI team | 7 | 7 | **49** |
| _run_trades_daily -- peer_commentary (up to 3/trade) | 0-3 | 7 | **0-21** |
| _run_trades_daily -- decide_trade LLM (1/trade) | 0-1 | 7 | **0-7** |
| **TOTAL per week** | | | **49-77** |

Each call_llm has a **6-second timeout** (llm.py:22, _TIMEOUT = 6.0). All calls are **synchronous and serial**.

**Worst-case wall-clock per week:**
- Lineup calls: 49 x ~2s avg = ~98s
- Trade commentary: up to 21 x ~2s = ~42s
- Trade decisions: up to 7 x ~2s = ~14s
- **Total: ~100-154 seconds per week**

**sim-to-playoffs** with 20 regular weeks = 20 x 100s = **~33 minutes** worst case.

## Top 3 Hotspots

### Hotspot 1: Serial lineup LLM calls in _set_lineups (HIGHEST IMPACT)

**File:** app/season.py:304-357
**Why slow:** Iterates for team in draft.teams serially. Each AI team decide_day blocks on synchronous call_llm (6s timeout). 7 AI teams = 7 sequential HTTP calls/day = 49/week.
**Fix:** Replace serial loop with concurrent.futures.ThreadPoolExecutor(max_workers=7). Note: decide_day_async (ai_gm.py:116) exists but is DEAD CODE -- never called.
**Speedup:** 7x on lineup phase. ~98s becomes ~14s per week.
**Effort:** ~20 LOC. **Risk:** Low -- decide_day is stateless per team.

### Hotspot 2: Serial peer commentary in collect_peer_commentary_sync (MEDIUM IMPACT)

**File:** app/trades.py:259-287
**Why slow:** Loops over up to 3 commentators calling ai_gm.peer_commentary (call_llm) serially. 2-6s each. An async version (collect_peer_commentary_async, trades.py:207) exists with asyncio.gather but is NEVER CALLED from season.py.
**Fix:** Refactor collect_peer_commentary_sync to use ThreadPoolExecutor(max_workers=3) internally.
**Speedup:** 3x on commentary phase. ~6-18s becomes ~2-6s per trade.
**Effort:** ~10 LOC. **Risk:** Low -- each call is independent.

### Hotspot 3: Per-call httpx.Client in _call_openrouter (LOW-MEDIUM IMPACT)

**File:** app/llm.py:143-144
**Why slow:** Creates new httpx.Client() per call = fresh TCP+TLS handshake every time. 49-77 calls/week x ~100-300ms overhead.
**Fix:** Module-level persistent httpx.Client with connection pooling. Also cache anthropic.Anthropic() client (llm.py:84) the same way.
**Speedup:** 5-23s saved per week.
**Effort:** ~10 LOC. **Risk:** Very low -- standard pattern.

## Fix Priority Order

| Priority | Hotspot | Effort | Speedup | Risk |
|----------|---------|--------|---------|------|
| **1** | Serial _set_lineups -> ThreadPool | ~20 LOC | **7x on 60-70% of total time** | Low |
| **2** | Serial collect_peer_commentary_sync -> ThreadPool | ~10 LOC | **3x on commentary phase** | Low |
| **3** | Per-call httpx.Client -> persistent client | ~10 LOC | **5-23s per week** | Very low |

**Combined effect:** Hotspot 1 alone reduces ~100s/week to ~30s. All three: ~15-20s/week.

## Concurrency Risks

### Safe to parallelize:
- decide_day across teams: stateless per team, independent result dicts. Safe.
- peer_commentary across commentators: read-only on trade/draft_state. Safe.
- httpx connection pool: thread-safe by design.

### Race conditions to watch:
1. **season.ai_calls_today** (season.py:339): += 1 in parallel threads is a race. Fix: count successful results AFTER futures complete in main thread.
2. **storage.append_log** (season.py:346-353): concurrent file writes corrupt log. Fix: collect log entries in results, append after parallel block.
3. **_run_trades_daily trade mutations** (season.py:450-507): trade.status/veto_votes modifications. Keep serial -- trades have ordering dependencies.

### NOT a bottleneck (confirmed fast):
- _resolve_week -- pure dict arithmetic
- _detect_milestones -- pure list scanning, no I/O
- _sample_game -- pure RNG math
- vote_veto_multi_factor (ai_gm.py:663) -- pure heuristic, no LLM
- propose_trade_heuristic (ai_gm.py:204) -- pure heuristic, no LLM
- Game log trimming (season.py:604) -- list comprehension, <1ms

## Additional Observations

1. Route handlers are sync (main.py:492 def season_advance_week_endpoint), blocking FastAPI worker. For sim-to-playoffs (140 days), background task + progress polling needed long-term.
2. decide_day_async (ai_gm.py:116-130) is dead code. Wraps decide_day in asyncio.to_thread but never called.
3. Anthropic SDK path (llm.py:84) creates new anthropic.Anthropic() per call. Same connection reuse opportunity.