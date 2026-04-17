"""Claude API GM decisions with heuristic fallback.

Uses Anthropic's Haiku with prompt caching for the static system prompt
(persona + rules). Falls back to a simple heuristic when no API key is
configured or when the daily budget is exceeded / a response fails to parse.
"""
from __future__ import annotations

import json
import os
import random
from typing import TYPE_CHECKING, Any, Optional

from .models import Player, Team
from .scoring import GM_PERSONAS

if TYPE_CHECKING:
    from .draft import DraftState
    from .models import SeasonState


MODEL_ID = "claude-haiku-4-5-20251001"
DEFAULT_DAILY_BUDGET = 30
LINEUP_SIZE = 10
MAX_TOKENS = 600


SYSTEM_PROMPT_TEMPLATE = """You are an NBA fantasy-basketball GM in a season-long H2H points league.

League rules:
- 8 teams, 13-player rosters, 10 starters + 3 bench
- Scoring (per game): PTS x1.0, REB x1.2, AST x1.5, STL x2.5, BLK x2.5, TO x-1.0
- Daily lineups; weekly matchups (sum of 7 daily totals)

Your persona: {persona_name}
Persona strategy: {persona_desc}

You will receive a JSON payload with your roster (season averages + last-3-game fppg if available),
the top 20 free agents by FPPG, current standings, and your team record.

Return STRICTLY a single JSON object matching this schema and nothing else:
{{
  "lineup": [10 unique player_ids from your roster],
  "waiver_claim": null | {{"drop": <player_id from roster>, "add": <player_id from free agents>}},
  "trade_offer": null | {{"target_team": <team_id>, "send": [<player_ids>], "receive": [<player_ids>]}},
  "reasoning": "<one-sentence rationale>"
}}

Constraints:
- lineup MUST contain exactly 10 ids that are on YOUR roster
- Prefer starters that match your persona philosophy
- Only propose a waiver_claim if the add clearly upgrades the drop
- Only propose a trade_offer if it meaningfully helps your team

Return JSON ONLY. No prose before or after.
"""


class AIGM:
    def __init__(self, api_key: Optional[str] = None, daily_budget: int = DEFAULT_DAILY_BUDGET):
        self.api_key = api_key or os.getenv("ANTHROPIC_API_KEY")
        self.daily_budget = daily_budget
        self._client = None
        if self.api_key:
            try:
                import anthropic  # type: ignore
                self._client = anthropic.Anthropic(api_key=self.api_key)
            except Exception:
                self._client = None

    @property
    def enabled(self) -> bool:
        return self._client is not None

    # ---------------------------------------------------------------- public
    def decide_day(
        self,
        team: Team,
        roster_players: list[Player],
        fa_top_20: list[Player],
        standings: dict[int, dict[str, float]],
        persona_key: str,
    ) -> dict[str, Any]:
        """Return {"lineup", "waiver_claim", "trade_offer", "used_api", "excerpt"}."""
        if not self.enabled:
            return self._heuristic(team, roster_players)

        try:
            result = self._call_api(team, roster_players, fa_top_20, standings, persona_key)
            if result is None:
                return self._heuristic(team, roster_players)
            # Validate lineup
            roster_ids = {p.id for p in roster_players}
            lineup = [pid for pid in result.get("lineup", []) if pid in roster_ids]
            if len(lineup) < LINEUP_SIZE:
                fallback = self._heuristic(team, roster_players)
                lineup = fallback["lineup"]
            return {
                "lineup": lineup[:LINEUP_SIZE],
                "waiver_claim": result.get("waiver_claim"),
                "trade_offer": result.get("trade_offer"),
                "used_api": True,
                "excerpt": (result.get("reasoning") or "")[:300],
            }
        except Exception as e:
            fallback = self._heuristic(team, roster_players)
            fallback["excerpt"] = f"fallback after error: {type(e).__name__}"
            return fallback

    # ------------------------------------------------------------- internals
    def _heuristic(self, team: Team, roster_players: list[Player]) -> dict[str, Any]:
        ordered = sorted(roster_players, key=lambda p: p.fppg, reverse=True)
        lineup = [p.id for p in ordered[:LINEUP_SIZE]]
        return {
            "lineup": lineup,
            "waiver_claim": None,
            "trade_offer": None,
            "used_api": False,
            "excerpt": "heuristic: top-10 FPPG",
        }

    def _call_api(
        self,
        team: Team,
        roster_players: list[Player],
        fa_top_20: list[Player],
        standings: dict[int, dict[str, float]],
        persona_key: str,
    ) -> Optional[dict[str, Any]]:
        assert self._client is not None
        persona_meta = GM_PERSONAS.get(persona_key, GM_PERSONAS["bpa"])
        system_text = SYSTEM_PROMPT_TEMPLATE.format(
            persona_name=persona_meta["name"],
            persona_desc=persona_meta["desc"],
        )

        payload = {
            "team": {"id": team.id, "name": team.name},
            "roster": [
                {
                    "id": p.id, "name": p.name, "pos": p.pos, "age": p.age,
                    "fppg": p.fppg, "pts": p.pts, "reb": p.reb, "ast": p.ast,
                    "stl": p.stl, "blk": p.blk, "to": p.to, "mpg": p.mpg,
                }
                for p in roster_players
            ],
            "free_agents_top_20": [
                {"id": p.id, "name": p.name, "pos": p.pos, "fppg": p.fppg}
                for p in fa_top_20
            ],
            "standings": {str(k): v for k, v in standings.items()},
        }
        user_text = (
            "Make your daily decision for the payload below.\n\n"
            + json.dumps(payload, ensure_ascii=False)
        )

        resp = self._client.messages.create(
            model=MODEL_ID,
            max_tokens=MAX_TOKENS,
            system=[
                {
                    "type": "text",
                    "text": system_text,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            messages=[{"role": "user", "content": user_text}],
        )

        # Extract the first text block
        text = ""
        for block in resp.content:
            btype = getattr(block, "type", None)
            if btype == "text":
                text = getattr(block, "text", "") or ""
                break
        if not text:
            return None

        return _extract_json(text)

    # ---------------------------------------------------------------- trades
    def propose_trade_heuristic(
        self,
        team: Team,
        draft_state: "DraftState",
        season_state: "SeasonState",
        trade_quota_behind: int = 0,
    ) -> Optional[dict[str, Any]]:
        """Return a trade proposal dict or None. Pure heuristic, no API call.

        Probability:
            base 15% per week + 10% per week behind schedule, cap 60%.
            In the final 2 regular weeks, if season_executed < 8, force-propose.
        Counterparty picked weighted by complementary weakness (different
        top-fppg profile).
        Players: pick a mid-tier from each side with FPPG within 15% of each other.
        Contrarian: picks higher-variance profile.
        """
        rng = random.Random(
            hash((draft_state.seed, team.id, season_state.current_day, "propose"))
            & 0xFFFFFFFF
        )
        persona = team.gm_persona or "bpa"

        # Escalation formula. Spec probabilities are WEEKLY, called daily,
        # so divide by 7 to get per-day probability.
        # base weekly: 20%, +10% per trade behind (cap 70%).
        base_weekly = 0.20
        weekly = base_weekly + 0.10 * max(0, trade_quota_behind)
        weekly = min(0.70, weekly)
        p = weekly / 7.0
        force = False
        # Caller signals force-propose (final weeks, behind quota) via
        # trade_quota_behind >= 99.
        if trade_quota_behind >= 99:
            force = True
            p = 1.0

        if not force and rng.random() >= p:
            return None

        my_roster = [
            draft_state.players_by_id[pid]
            for pid in team.roster
            if pid in draft_state.players_by_id
        ]
        if len(my_roster) < 3:
            return None

        # Pick a mid-tier player to send (rank 4-9 on own roster by fppg)
        my_roster_sorted = sorted(my_roster, key=lambda p: p.fppg, reverse=True)
        mid_start = min(3, len(my_roster_sorted) - 1)
        mid_end = min(9, len(my_roster_sorted))
        my_candidates = my_roster_sorted[mid_start:mid_end]
        if not my_candidates:
            my_candidates = my_roster_sorted[-3:]

        # Build target list: other teams (not self, not human unless AI picks human)
        other_teams = [t for t in draft_state.teams if t.id != team.id]
        if not other_teams:
            return None

        # Weight counterparties: prefer those whose top-FPPG profile is different.
        # Simple weight: inverse of persona similarity (unique non-human teams).
        weights: list[float] = []
        for t in other_teams:
            w = 1.0
            # Same persona penalty (diversify partners)
            if t.gm_persona == persona:
                w *= 0.6
            # Human team gets baseline; contrarians love trading with humans
            if t.is_human and persona == "contrarian":
                w *= 1.4
            weights.append(w)

        # Weighted random choice
        total_w = sum(weights)
        if total_w <= 0:
            target = rng.choice(other_teams)
        else:
            r = rng.uniform(0, total_w)
            cum = 0.0
            target = other_teams[-1]
            for tt, ww in zip(other_teams, weights):
                cum += ww
                if r <= cum:
                    target = tt
                    break

        # Pick a mid-tier from target roster
        target_roster = [
            draft_state.players_by_id[pid]
            for pid in target.roster
            if pid in draft_state.players_by_id
        ]
        if len(target_roster) < 3:
            return None
        target_sorted = sorted(target_roster, key=lambda p: p.fppg, reverse=True)
        t_start = min(3, len(target_sorted) - 1)
        t_end = min(9, len(target_sorted))
        target_candidates = target_sorted[t_start:t_end]
        if not target_candidates:
            target_candidates = target_sorted[-3:]

        # Contrarian: prefer highest-variance profile in target pool (use blk+stl as proxy)
        if persona == "contrarian":
            target_candidates = sorted(
                target_candidates,
                key=lambda p: p.stl + p.blk,
                reverse=True,
            )

        # Pick player pairs within 15% FPPG tolerance
        my_pick: Optional[Player] = None
        target_pick: Optional[Player] = None
        # Try up to 6 random attempts to find a balanced pair
        for _ in range(6):
            a = rng.choice(my_candidates)
            b = rng.choice(target_candidates)
            a_fp = max(0.1, a.fppg)
            b_fp = max(0.1, b.fppg)
            ratio = max(a_fp, b_fp) / min(a_fp, b_fp)
            if ratio <= 1.15:
                my_pick = a
                target_pick = b
                break
        if my_pick is None or target_pick is None:
            return None

        reasoning = (
            f"{GM_PERSONAS[persona]['name']}: swap {my_pick.name} "
            f"({my_pick.fppg:.1f}) for {target_pick.name} ({target_pick.fppg:.1f})"
        )
        return {
            "to_team": target.id,
            "send": [my_pick.id],
            "receive": [target_pick.id],
            "reasoning": reasoning,
        }

    def decide_on_proposal_heuristic(
        self,
        trade: Any,
        team: Team,
        draft_state: "DraftState",
    ) -> bool:
        """Accept iff receive_fppg / send_fppg >= threshold.

        Base threshold 0.92; balanced persona stricter at 0.95.
        """
        persona = team.gm_persona or "bpa"
        threshold = 0.95 if persona == "balanced" else 0.92

        # For the counterparty, "send" means what leaves their roster
        # (= trade.receive_player_ids from proposer's POV) and "receive" means
        # what comes in (= trade.send_player_ids).
        cp_send_ids = list(trade.receive_player_ids)
        cp_recv_ids = list(trade.send_player_ids)

        send_fp = _side_fppg(cp_send_ids, draft_state)
        recv_fp = _side_fppg(cp_recv_ids, draft_state)
        if send_fp <= 0.01:
            return True  # giving nothing of value, accept
        return (recv_fp / send_fp) >= threshold

    def vote_veto_heuristic(
        self,
        trade: Any,
        team: Team,
        draft_state: "DraftState",
    ) -> bool:
        """Return True if the team wants to cast a veto vote.

        Default: vote if max/min FPPG ratio >= 1.30.
        Balanced persona: stricter 1.20.
        Contrarian persona: never vote veto.
        Parties to the trade never vote (caller guard too).
        """
        persona = team.gm_persona or "bpa"
        if persona == "contrarian":
            return False
        if team.id in (trade.from_team, trade.to_team):
            return False

        # Balanced GMs are strict (1.05); others use 1.07. These are calibrated
        # against the propose() heuristic (pairs within 15% FPPG) AND the
        # acceptance threshold (~0.92): executed trades always have ratio in
        # [1.00, 1.09]. Choose thresholds so the most-lopsided accepted trades
        # each season accumulate enough veto votes to trigger VETO_THRESHOLD=3.
        threshold = 1.05 if persona == "balanced" else 1.07
        a = _side_fppg(trade.send_player_ids, draft_state)
        b = _side_fppg(trade.receive_player_ids, draft_state)
        lo = min(a, b)
        hi = max(a, b)
        if lo <= 0.01:
            return True  # one side worthless, blatantly unfair
        return (hi / lo) >= threshold


def _side_fppg(player_ids: list[int], draft_state: "DraftState") -> float:
    total = 0.0
    for pid in player_ids:
        p = draft_state.players_by_id.get(pid)
        if p is not None:
            total += p.fppg
    return total


def _extract_json(text: str) -> Optional[dict[str, Any]]:
    """Pull the first JSON object out of the model's text response."""
    text = text.strip()
    # Handle ```json fenced responses
    if text.startswith("```"):
        # Strip leading/trailing fence
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()

    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    chunk = text[start : end + 1]
    try:
        data = json.loads(chunk)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None
