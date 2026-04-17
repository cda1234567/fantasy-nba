"""Season simulation engine: schedule, daily/weekly sim, playoffs."""
from __future__ import annotations

import random
from typing import TYPE_CHECKING, Optional

from .injuries import roll_daily_injuries, roll_preseason_injuries, tick_injuries
from .models import GameLog, Matchup, Player, SeasonState
from .scoring import compute_fppg
from .trades import TradeManager

if TYPE_CHECKING:
    from .draft import DraftState
    from .storage import Storage
    from .ai_gm import AIGM
    from .models import LeagueSettings
    from .trades import TradeProposal


DAYS_PER_WEEK = 7
REGULAR_WEEKS = 20          # default; overridden by LeagueSettings
PLAYOFF_WEEKS = 3           # 6-team bracket: round1 + semis + finals
TOTAL_WEEKS = REGULAR_WEEKS + PLAYOFF_WEEKS
LINEUP_SIZE = 10            # default starters; overridden by settings


# ---------------------------------------------------------------------------
# Schedule
# ---------------------------------------------------------------------------
def build_schedule(
    num_teams: int = 8,
    regular_season_weeks: int = REGULAR_WEEKS,
    playoff_teams: int = 6,
) -> list[Matchup]:
    """Round-robin: `num_teams` teams over `regular_season_weeks` regular weeks.
    Uses the circle method.  Playoff matchups are appended in sim_playoffs().
    """
    if num_teams % 2:
        raise ValueError("num_teams must be even")

    teams = list(range(num_teams))
    rounds: list[list[tuple[int, int]]] = []
    n = num_teams
    arr = teams[:]
    for _ in range(n - 1):
        pairs: list[tuple[int, int]] = []
        for i in range(n // 2):
            a, b = arr[i], arr[n - 1 - i]
            pairs.append((a, b))
        rounds.append(pairs)
        arr = [arr[0]] + [arr[-1]] + arr[1:-1]

    schedule: list[Matchup] = []
    for week in range(1, regular_season_weeks + 1):
        base = rounds[(week - 1) % len(rounds)]
        flip = (week - 1) // len(rounds) % 2 == 1
        for a, b in base:
            ta, tb = (b, a) if flip else (a, b)
            schedule.append(Matchup(week=week, team_a=ta, team_b=tb))
    return schedule


def init_standings(num_teams: int) -> dict[int, dict[str, float]]:
    return {
        tid: {"w": 0.0, "l": 0.0, "pf": 0.0, "pa": 0.0}
        for tid in range(num_teams)
    }


# ---------------------------------------------------------------------------
# Lineup
# ---------------------------------------------------------------------------
def default_lineup(
    roster_ids: list[int],
    players_by_id: dict[int, Player],
    lineup_size: int = LINEUP_SIZE,
    injured_out: set[int] | None = None,
) -> list[int]:
    """Heuristic starters: top-N by FPPG, skipping players who are 'out'."""
    injured_out = injured_out or set()
    roster = [
        players_by_id[pid]
        for pid in roster_ids
        if pid in players_by_id and pid not in injured_out
    ]
    roster.sort(key=lambda p: p.fppg, reverse=True)
    return [p.id for p in roster[:lineup_size]]


# ---------------------------------------------------------------------------
# Daily sim
# ---------------------------------------------------------------------------
def _sample_game(
    rng: random.Random,
    player: Player,
    day: int,
    week: int,
    team_id: int,
    weights: dict | None = None,
    injured: bool = False,
) -> GameLog:
    """Sample one game for one player. Non-playing (DNP) returns zeros."""
    if injured:
        return GameLog(
            day=day, week=week, player_id=player.id, team_id=team_id,
            played=False, pts=0, reb=0, ast=0, stl=0, blk=0, to=0, fp=0.0,
        )

    play_prob = 0.9 if player.fppg > 0 else 0.5
    played = rng.random() < play_prob

    if not played or player.fppg <= 0:
        return GameLog(
            day=day, week=week, player_id=player.id, team_id=team_id,
            played=False, pts=0, reb=0, ast=0, stl=0, blk=0, to=0, fp=0.0,
        )

    std = max(1.0, 0.35 * player.fppg)
    sampled_fp = rng.gauss(player.fppg, std)
    sampled_fp = max(0.0, sampled_fp)
    ratio = sampled_fp / player.fppg if player.fppg > 0 else 1.0

    pts = max(0.0, player.pts * ratio)
    reb = max(0.0, player.reb * ratio)
    ast = max(0.0, player.ast * ratio)
    stl = max(0.0, player.stl * ratio)
    blk = max(0.0, player.blk * ratio)
    to_v = max(0.0, player.to * ratio)

    dummy = Player(
        id=player.id, name=player.name, team=player.team, pos=player.pos,
        age=player.age, gp=player.gp, mpg=player.mpg,
        pts=pts, reb=reb, ast=ast, stl=stl, blk=blk, to=to_v, fppg=0.0,
    )
    fp = round(compute_fppg(dummy, weights), 2)

    return GameLog(
        day=day, week=week, player_id=player.id, team_id=team_id,
        played=True,
        pts=round(pts, 2), reb=round(reb, 2), ast=round(ast, 2),
        stl=round(stl, 2), blk=round(blk, 2), to=round(to_v, 2), fp=fp,
    )


# ---------------------------------------------------------------------------
# Settings helpers
# ---------------------------------------------------------------------------
def _regular_weeks(settings: Optional["LeagueSettings"]) -> int:
    return settings.regular_season_weeks if settings is not None else REGULAR_WEEKS


def _lineup_size(settings: Optional["LeagueSettings"]) -> int:
    return settings.starters_per_day if settings is not None else LINEUP_SIZE


def _scoring_weights(settings: Optional["LeagueSettings"]) -> dict | None:
    return settings.scoring_weights if settings is not None else None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def start_season(
    draft: "DraftState",
    storage: "Storage",
    settings: Optional["LeagueSettings"] = None,
) -> SeasonState:
    reg_weeks = _regular_weeks(settings)
    schedule = build_schedule(len(draft.teams), reg_weeks)
    state = SeasonState(
        started=True,
        current_day=0,
        current_week=1,
        schedule=schedule,
        game_logs=[],
        standings=init_standings(len(draft.teams)),
        is_playoffs=False,
        champion=None,
        lineups={},
        ai_calls_today=0,
    )
    # Preseason injury sweep: ~2% per player, short-term only
    preseason_rng = random.Random(hash((draft.seed, "preseason_injuries")) & 0xFFFFFFFF)
    roll_preseason_injuries(state, draft, preseason_rng)

    storage.save_season(state.model_dump())
    storage.append_log({
        "type": "season_start",
        "num_teams": len(draft.teams),
        "weeks": reg_weeks,
    })
    return state


def _week_for_day(day: int) -> int:
    """Days 1..7 -> week 1; 8..14 -> week 2; etc."""
    return (day - 1) // DAYS_PER_WEEK + 1


def _matchup_for_team(season: SeasonState, team_id: int, week: int) -> Optional[Matchup]:
    for m in season.schedule:
        if m.week == week and (m.team_a == team_id or m.team_b == team_id):
            return m
    return None


def _set_lineups(
    draft: "DraftState",
    season: SeasonState,
    storage: "Storage",
    ai_gm: Optional["AIGM"],
    use_ai: bool,
    settings: Optional["LeagueSettings"] = None,
) -> None:
    """Populate season.lineups for the current day, using AI when available."""
    lineup_sz = _lineup_size(settings)
    season.lineups = {}
    season.ai_calls_today = 0
    fa_top = _free_agents_top(draft, limit=20)

    # Build the set of players with status="out" for lineup filtering
    injured_out: set[int] = {
        pid for pid, inj in season.injuries.items() if inj.status == "out"
    }

    for team in draft.teams:
        if team.is_human:
            season.lineups[team.id] = default_lineup(
                team.roster, draft.players_by_id, lineup_sz, injured_out
            )
            continue

        if ai_gm and use_ai and season.ai_calls_today < ai_gm.daily_budget:
            roster_players = [draft.players_by_id[pid] for pid in team.roster]
            decision = ai_gm.decide_day(
                team=team,
                roster_players=roster_players,
                fa_top_20=fa_top,
                standings=season.standings,
                persona_key=team.gm_persona or "bpa",
                injured_out=injured_out,
            )
            if decision.get("used_api"):
                season.ai_calls_today += 1
            lineup = decision.get("lineup") or []
            roster_set = set(team.roster)
            lineup = [pid for pid in lineup if pid in roster_set and pid not in injured_out]
            if len(lineup) < lineup_sz:
                lineup = default_lineup(team.roster, draft.players_by_id, lineup_sz, injured_out)
            season.lineups[team.id] = lineup[:lineup_sz]
            storage.append_log({
                "type": "ai_decision",
                "team_id": team.id,
                "persona": team.gm_persona,
                "action": "lineup",
                "used_api": bool(decision.get("used_api")),
                "excerpt": (decision.get("excerpt") or "")[:300],
            })
        else:
            season.lineups[team.id] = default_lineup(
                team.roster, draft.players_by_id, lineup_sz, injured_out
            )


def _free_agents_top(draft: "DraftState", limit: int = 20) -> list[Player]:
    rostered: set[int] = set()
    for t in draft.teams:
        rostered.update(t.roster)
    pool = [p for p in draft.players if p.id not in rostered]
    pool.sort(key=lambda p: p.fppg, reverse=True)
    return pool[:limit]


def _run_trades_daily(
    draft: "DraftState",
    season: SeasonState,
    storage: "Storage",
    ai_gm: Optional["AIGM"],
    current_day: int,
    current_week: int,
    settings: Optional["LeagueSettings"] = None,
) -> None:
    """Process trade lifecycle: resolve expired/veto windows, then let AI
    propose / decide / vote on open trades.
    """
    reg_weeks = _regular_weeks(settings)
    mgr = TradeManager(storage, draft, season, settings=settings)

    # 1. Resolve pending trades whose windows have closed.
    resolved = mgr.daily_tick(current_day, current_week)
    for t in resolved:
        _log_trade_event(storage, t, current_day, current_week)

    # 2. Let each AI team attempt a heuristic proposal
    if ai_gm is not None:
        quota = mgr.quota_info(current_week)
        behind = int(quota.get("behind", 0))
        force_final = (
            current_week >= reg_weeks - 1
            and int(quota.get("executed", 0)) < 10
        )

        for team in draft.teams:
            if team.is_human:
                continue
            has_pending_from = any(
                p.from_team == team.id and p.status in ("pending_accept", "accepted")
                for p in mgr.pending()
            )
            if has_pending_from:
                continue
            quota_signal = behind if not force_final else 99
            proposal = ai_gm.propose_trade_heuristic(
                team=team,
                draft_state=draft,
                season_state=season,
                trade_quota_behind=quota_signal,
            )
            if not proposal:
                continue
            try:
                trade = mgr.propose(
                    from_team=team.id,
                    to_team=int(proposal["to_team"]),
                    send_ids=list(proposal["send"]),
                    receive_ids=list(proposal["receive"]),
                    current_day=current_day,
                    current_week=current_week,
                    reasoning=str(proposal.get("reasoning", ""))[:300],
                )
                storage.append_log({
                    "type": "trade_proposed",
                    "trade_id": trade.id,
                    "from_team": trade.from_team,
                    "to_team": trade.to_team,
                    "send": trade.send_player_ids,
                    "receive": trade.receive_player_ids,
                    "day": current_day,
                    "week": current_week,
                    "reasoning": trade.reasoning,
                })
            except ValueError:
                continue

    # 3. AI counterparty decisions on any pending_accept where to_team is AI.
    if ai_gm is not None:
        for trade in list(mgr.pending()):
            if trade.status != "pending_accept":
                continue
            cp = draft.teams[trade.to_team]
            if cp.is_human:
                continue
            accept, _ = ai_gm.decide_trade(trade, cp, draft, settings)
            try:
                mgr.decide(trade.id, cp.id, accept, current_day)
                storage.append_log({
                    "type": "trade_accepted" if accept else "trade_rejected",
                    "trade_id": trade.id,
                    "from_team": trade.from_team,
                    "to_team": trade.to_team,
                    "day": current_day,
                    "week": current_week,
                })
            except ValueError:
                continue

    # 4. AI veto votes on accepted trades still in review window.
    if ai_gm is not None:
        for trade in list(mgr.pending()):
            if trade.status != "accepted":
                continue
            for voter in draft.teams:
                if voter.is_human:
                    continue
                if voter.id in (trade.from_team, trade.to_team):
                    continue
                if voter.id in trade.veto_votes:
                    continue
                if ai_gm.vote_veto_multi_factor(trade, draft, voter.gm_persona or "bpa", settings):
                    try:
                        mgr.veto(trade.id, voter.id)
                        storage.append_log({
                            "type": "trade_veto_vote",
                            "trade_id": trade.id,
                            "voter": voter.id,
                            "total_votes": len(trade.veto_votes),
                            "day": current_day,
                        })
                    except ValueError:
                        continue


def _log_trade_event(
    storage: "Storage",
    trade: "TradeProposal",
    current_day: int,
    current_week: int,
) -> None:
    mapping = {
        "executed": "trade_executed",
        "vetoed": "trade_vetoed",
        "rejected": "trade_rejected",
        "expired": "trade_expired",
    }
    etype = mapping.get(trade.status)
    if not etype:
        return
    storage.append_log({
        "type": etype,
        "trade_id": trade.id,
        "from_team": trade.from_team,
        "to_team": trade.to_team,
        "send": trade.send_player_ids,
        "receive": trade.receive_player_ids,
        "veto_votes": list(trade.veto_votes),
        "day": current_day,
        "week": current_week,
    })


def advance_day(
    draft: "DraftState",
    season: SeasonState,
    storage: "Storage",
    ai_gm: Optional["AIGM"] = None,
    use_ai: bool = True,
    settings: Optional["LeagueSettings"] = None,
) -> SeasonState:
    """Advance one sim day. Every team plays (7 game days per week)."""
    if not season.started:
        raise ValueError("Season not started")
    if season.champion is not None:
        return season

    reg_weeks = _regular_weeks(settings)
    weights = _scoring_weights(settings)

    next_day = season.current_day + 1
    week = _week_for_day(next_day)

    if week > reg_weeks:
        return season

    _run_trades_daily(draft, season, storage, ai_gm, next_day, week, settings)

    # Heal players whose return_in_days hits 0
    tick_injuries(season, next_day)

    rng = random.Random(hash((draft.seed, next_day)) & 0xFFFFFFFF)
    _set_lineups(draft, season, storage, ai_gm, use_ai, settings)

    # Roll new injuries for starters (after lineups are set)
    roll_daily_injuries(season, draft, rng, next_day)

    lineup_sz = _lineup_size(settings)
    day_fp_by_team: dict[int, float] = {t.id: 0.0 for t in draft.teams}
    for team in draft.teams:
        starters = season.lineups.get(
            team.id, default_lineup(team.roster, draft.players_by_id, lineup_sz)
        )
        for pid in starters:
            player = draft.players_by_id.get(pid)
            if player is None:
                continue
            is_injured = pid in season.injuries and season.injuries[pid].status == "out"
            log = _sample_game(rng, player, next_day, week, team.id, weights, injured=is_injured)
            season.game_logs.append(log)
            day_fp_by_team[team.id] += log.fp

    season.current_day = next_day
    season.current_week = week

    if next_day % DAYS_PER_WEEK == 0:
        _resolve_week(draft, season, week, reg_weeks)

    storage.save_season(season.model_dump())
    storage.append_log({
        "type": "day_advance",
        "day": next_day,
        "week": week,
        "fp_by_team": {str(k): round(v, 2) for k, v in day_fp_by_team.items()},
    })
    return season


def _resolve_week(
    draft: "DraftState",
    season: SeasonState,
    week: int,
    regular_weeks: int = REGULAR_WEEKS,
) -> None:
    """Sum per-team fantasy points across the 7-day week for each matchup, set W/L."""
    week_logs = [g for g in season.game_logs if g.week == week]
    team_totals: dict[int, float] = {t.id: 0.0 for t in draft.teams}
    for g in week_logs:
        team_totals[g.team_id] = team_totals.get(g.team_id, 0.0) + g.fp

    for m in season.schedule:
        if m.week != week or m.complete:
            continue
        a = round(team_totals.get(m.team_a, 0.0), 2)
        b = round(team_totals.get(m.team_b, 0.0), 2)
        m.score_a = a
        m.score_b = b
        m.complete = True
        if a > b:
            m.winner = m.team_a
        elif b > a:
            m.winner = m.team_b
        else:
            m.winner = None

        if week <= regular_weeks:
            sa = season.standings.setdefault(m.team_a, {"w": 0, "l": 0, "pf": 0, "pa": 0})
            sb = season.standings.setdefault(m.team_b, {"w": 0, "l": 0, "pf": 0, "pa": 0})
            sa["pf"] += a
            sa["pa"] += b
            sb["pf"] += b
            sb["pa"] += a
            if m.winner == m.team_a:
                sa["w"] += 1
                sb["l"] += 1
            elif m.winner == m.team_b:
                sb["w"] += 1
                sa["l"] += 1


def advance_week(
    draft: "DraftState",
    season: SeasonState,
    storage: "Storage",
    ai_gm: Optional["AIGM"] = None,
    use_ai: bool = True,
    settings: Optional["LeagueSettings"] = None,
) -> SeasonState:
    for _ in range(DAYS_PER_WEEK):
        if season.champion is not None:
            break
        advance_day(draft, season, storage, ai_gm, use_ai, settings)
    return season


def sim_to_playoffs(
    draft: "DraftState",
    season: SeasonState,
    storage: "Storage",
    ai_gm: Optional["AIGM"] = None,
    use_ai: bool = True,
    settings: Optional["LeagueSettings"] = None,
) -> SeasonState:
    reg_weeks = _regular_weeks(settings)
    guard = 0
    while season.current_week < reg_weeks or season.current_day % DAYS_PER_WEEK != 0:
        if season.champion is not None:
            break
        advance_day(draft, season, storage, ai_gm, use_ai, settings)
        guard += 1
        if guard > reg_weeks * DAYS_PER_WEEK + 2:
            break
    return season


# ---------------------------------------------------------------------------
# Playoffs — 6-team bracket: top-2 bye, Round1 (seeds 3v6, 4v5),
#            Semis (seed1 v low-winner, seed2 v high-winner), Finals
# ---------------------------------------------------------------------------
def _top_seeds(season: SeasonState, n: int = 6) -> list[int]:
    rows = sorted(
        season.standings.items(),
        key=lambda kv: (kv[1].get("w", 0), kv[1].get("pf", 0)),
        reverse=True,
    )
    return [int(tid) for tid, _ in rows[:n]]


def _sim_playoff_week(
    draft: "DraftState",
    season: SeasonState,
    storage: "Storage",
    pairings: list[tuple[int, int]],
    week: int,
    ai_gm: Optional["AIGM"],
    use_ai: bool,
    settings: Optional["LeagueSettings"] = None,
) -> list[int]:
    """Create matchups, run 7 days, resolve, return winner ids in order."""
    lineup_sz = _lineup_size(settings)
    weights = _scoring_weights(settings)

    for a, b in pairings:
        season.schedule.append(Matchup(week=week, team_a=a, team_b=b))

    for _ in range(DAYS_PER_WEEK):
        next_day = season.current_day + 1
        rng = random.Random(hash((draft.seed, next_day, "po")) & 0xFFFFFFFF)
        tick_injuries(season, next_day)
        _set_lineups(draft, season, storage, ai_gm, use_ai, settings)
        roll_daily_injuries(season, draft, rng, next_day)

        active = {tid for pair in pairings for tid in pair}
        for team in draft.teams:
            if team.id not in active:
                continue
            starters = season.lineups.get(
                team.id, default_lineup(team.roster, draft.players_by_id, lineup_sz)
            )
            for pid in starters:
                player = draft.players_by_id.get(pid)
                if player is None:
                    continue
                is_injured = pid in season.injuries and season.injuries[pid].status == "out"
                log = _sample_game(rng, player, next_day, week, team.id, weights, injured=is_injured)
                season.game_logs.append(log)

        season.current_day = next_day
        season.current_week = week
        storage.save_season(season.model_dump())

    reg_weeks = _regular_weeks(settings)
    _resolve_week(draft, season, week, reg_weeks)
    winners: list[int] = []
    for a, b in pairings:
        for m in season.schedule:
            if m.week == week and m.team_a == a and m.team_b == b and m.complete:
                winners.append(m.winner if m.winner is not None else a)
                break
    return winners


def sim_playoffs(
    draft: "DraftState",
    season: SeasonState,
    storage: "Storage",
    ai_gm: Optional["AIGM"] = None,
    use_ai: bool = True,
    settings: Optional["LeagueSettings"] = None,
) -> SeasonState:
    if season.champion is not None:
        return season

    reg_weeks = _regular_weeks(settings)

    if season.current_week < reg_weeks or season.current_day % DAYS_PER_WEEK != 0:
        sim_to_playoffs(draft, season, storage, ai_gm, use_ai, settings)

    season.is_playoffs = True
    seeds = _top_seeds(season, 6)
    if len(seeds) < 6:
        # Fallback: fewer than 6 teams with standings — use whatever we have
        if len(seeds) < 4:
            return season
        # Run old 4-team bracket
        semis = [(seeds[0], seeds[3]), (seeds[1], seeds[2])]
        winners = _sim_playoff_week(
            draft, season, storage, semis, reg_weeks + 1, ai_gm, use_ai, settings
        )
        if len(winners) < 2:
            return season
        final_pair = [(winners[0], winners[1])]
        final_winners = _sim_playoff_week(
            draft, season, storage, final_pair, reg_weeks + 2, ai_gm, use_ai, settings
        )
        if final_winners:
            season.champion = final_winners[0]
    else:
        # 6-team bracket
        # Round 1 (reg+1): seed3 v seed6, seed4 v seed5 (seed1, seed2 have bye)
        seed1, seed2, seed3, seed4, seed5, seed6 = (
            seeds[0], seeds[1], seeds[2], seeds[3], seeds[4], seeds[5]
        )
        r1_pairings = [(seed3, seed6), (seed4, seed5)]
        r1_winners = _sim_playoff_week(
            draft, season, storage, r1_pairings, reg_weeks + 1, ai_gm, use_ai, settings
        )
        if len(r1_winners) < 2:
            return season

        # Round 2 (reg+2): seed1 v low-winner (winner of 4v5), seed2 v high-winner (winner of 3v6)
        low_winner = r1_winners[1]   # winner of seed4 v seed5
        high_winner = r1_winners[0]  # winner of seed3 v seed6
        r2_pairings = [(seed1, low_winner), (seed2, high_winner)]
        r2_winners = _sim_playoff_week(
            draft, season, storage, r2_pairings, reg_weeks + 2, ai_gm, use_ai, settings
        )
        if len(r2_winners) < 2:
            return season

        # Finals (reg+3)
        final_pair = [(r2_winners[0], r2_winners[1])]
        final_winners = _sim_playoff_week(
            draft, season, storage, final_pair, reg_weeks + 3, ai_gm, use_ai, settings
        )
        if final_winners:
            season.champion = final_winners[0]

    storage.save_season(season.model_dump())
    storage.append_log({
        "type": "champion",
        "team_id": season.champion,
    })
    return season
