"""Trade workflow: propose → accept/reject → veto window → execute.

Yahoo-style veto: any N non-party managers voting veto during the review
window cancels an accepted trade. Persisted via Storage.load_trades()/save_trades().

Lifecycle:
    1. propose()  -> status "pending_accept"
    2. decide(accept=True)  -> status "accepted" (veto window opens)
       - AI veto votes collected immediately on accept
       - If votes >= veto_threshold, status -> "vetoed" immediately
       - Otherwise veto_deadline_day = current_day + veto_window_days
    3. decide(accept=False) -> status "rejected" (final)
    4. During veto window, veto() records votes; threshold+ non-party -> "vetoed"
    5. daily_tick() resolves expired veto-windows -> execute/veto
"""
from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any, Literal, Optional

from pydantic import BaseModel, Field

if TYPE_CHECKING:
    from .draft import DraftState
    from .models import LeagueSettings, SeasonState
    from .storage import Storage


TradeStatus = Literal[
    "pending_accept", "accepted", "rejected", "vetoed", "executed", "expired"
]

# Defaults; overridden by LeagueSettings when passed in
VETO_WINDOW_DAYS = 2
VETO_THRESHOLD = 3


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class TradeProposal(BaseModel):
    id: str
    proposed_week: int
    proposed_day: int
    from_team: int
    to_team: int
    send_player_ids: list[int]
    receive_player_ids: list[int]
    status: TradeStatus = "pending_accept"
    counterparty_decided_day: Optional[int] = None
    veto_votes: list[int] = Field(default_factory=list)
    veto_deadline_day: Optional[int] = None
    reasoning: str = ""
    executed_day: Optional[int] = None
    proposer_message: str = ""
    force: bool = False
    peer_commentary: list[dict] = Field(default_factory=list)
    force_executed: bool = False


class TradesState(BaseModel):
    pending: list[TradeProposal] = Field(default_factory=list)
    history: list[TradeProposal] = Field(default_factory=list)
    season_executed_count: int = 0


# ---------------------------------------------------------------------------
# TradeManager
# ---------------------------------------------------------------------------
class TradeManager:
    def __init__(
        self,
        storage: "Storage",
        draft_state: "DraftState",
        season_state: "SeasonState",
        settings: Optional["LeagueSettings"] = None,
    ):
        self.storage = storage
        self.draft = draft_state
        self.season = season_state  # kept as reference for ai_models lookup
        self._settings = settings
        self.state = self._load()

    # -------------------------------------------------------------- settings
    @property
    def _veto_threshold(self) -> int:
        return self._settings.veto_threshold if self._settings is not None else VETO_THRESHOLD

    @property
    def _veto_window_days(self) -> int:
        return self._settings.veto_window_days if self._settings is not None else VETO_WINDOW_DAYS

    # -------------------------------------------------------------- persistence
    def _load(self) -> TradesState:
        raw = self.storage.load_trades()
        if raw is None:
            return TradesState()
        try:
            return TradesState(**raw)
        except Exception:
            return TradesState()

    def _save(self) -> None:
        self.storage.save_trades(self.state.model_dump())

    # -------------------------------------------------------------- lookup helpers
    def _find(self, trade_id: str) -> Optional[TradeProposal]:
        for t in self.state.pending:
            if t.id == trade_id:
                return t
        for t in self.state.history:
            if t.id == trade_id:
                return t
        return None

    def _move_to_history(self, trade: TradeProposal) -> None:
        self.state.pending = [t for t in self.state.pending if t.id != trade.id]
        self.state.history = [t for t in self.state.history if t.id != trade.id]
        self.state.history.append(trade)

    # ---------------------------------------------------------------- actions
    def propose(
        self,
        from_team: int,
        to_team: int,
        send_ids: list[int],
        receive_ids: list[int],
        current_day: int,
        current_week: int,
        reasoning: str = "human",
        proposer_message: str = "",
        force: bool = False,
    ) -> TradeProposal:
        if from_team == to_team:
            raise ValueError("Cannot trade with self")
        if not send_ids or not receive_ids:
            raise ValueError("Both sides must include at least one player")
        # Enforce trade deadline if configured
        deadline = getattr(self._settings, "trade_deadline_week", None) if self._settings is not None else None
        if deadline is not None and current_week > int(deadline):
            raise ValueError(f"交易截止日已過（第 {deadline} 週），無法提交新交易")

        sender = self.draft.teams[from_team]
        receiver = self.draft.teams[to_team]
        sender_roster = set(sender.roster)
        receiver_roster = set(receiver.roster)
        for pid in send_ids:
            if pid not in sender_roster:
                raise ValueError(f"Player {pid} not on proposer roster")
        for pid in receive_ids:
            if pid not in receiver_roster:
                raise ValueError(f"Player {pid} not on counterparty roster")

        for existing in self.state.pending:
            if (
                existing.from_team == from_team
                and existing.to_team == to_team
                and set(existing.send_player_ids) == set(send_ids)
                and set(existing.receive_player_ids) == set(receive_ids)
            ):
                return existing

        trade = TradeProposal(
            id=uuid.uuid4().hex,
            proposed_week=current_week,
            proposed_day=current_day,
            from_team=from_team,
            to_team=to_team,
            send_player_ids=list(send_ids),
            receive_player_ids=list(receive_ids),
            status="pending_accept",
            reasoning=reasoning or "",
            proposer_message=proposer_message[:300] if proposer_message else "",
            force=force,
        )
        self.state.pending.append(trade)
        self._save()
        return trade

    async def collect_peer_commentary_async(
        self,
        trade: TradeProposal,
        ai_gm: Any,
    ) -> None:
        """Collect commentary from up to 3 AI teams (not proposer, not receiver).
        Fires calls via asyncio.gather if possible, else sequentially. Mutates trade in place.
        """
        import asyncio

        commentators = [
            t for t in self.draft.teams
            if t.id not in (trade.from_team, trade.to_team) and not t.is_human
        ]
        commentators = sorted(commentators, key=lambda t: t.id)[:3]
        if not commentators:
            return

        model_map: dict[int, str] = getattr(self.season, "ai_models", {}) or {}

        async def get_one(team: Any) -> dict:
            model_id = model_map.get(team.id, "anthropic/claude-haiku-4.5")
            text = await asyncio.to_thread(
                ai_gm.peer_commentary, trade, self.draft, team, model_id
            )
            return {
                "team_id": team.id,
                "team_name": team.name,
                "model": model_id,
                "text": text,
            }

        try:
            results = await asyncio.gather(*[get_one(t) for t in commentators])
            trade.peer_commentary = list(results)
        except Exception:
            # Sequential fallback
            trade.peer_commentary = []
            for team in commentators:
                model_id = model_map.get(team.id, "anthropic/claude-haiku-4.5")
                try:
                    text = ai_gm.peer_commentary(trade, self.draft, team, model_id)
                except Exception:
                    text = "挺有趣的交易提案。"
                trade.peer_commentary.append({
                    "team_id": team.id,
                    "team_name": team.name,
                    "model": model_id,
                    "text": text,
                })
        self._save()

    def collect_peer_commentary_sync(
        self,
        trade: TradeProposal,
        ai_gm: Any,
    ) -> None:
        """Synchronous version: collect peer commentary sequentially."""
        commentators = [
            t for t in self.draft.teams
            if t.id not in (trade.from_team, trade.to_team) and not t.is_human
        ]
        commentators = sorted(commentators, key=lambda t: t.id)[:3]
        if not commentators:
            return

        model_map: dict[int, str] = getattr(self.season, "ai_models", {}) or {}
        trade.peer_commentary = []
        for team in commentators:
            model_id = model_map.get(team.id, "anthropic/claude-haiku-4.5")
            try:
                text = ai_gm.peer_commentary(trade, self.draft, team, model_id)
            except Exception:
                text = "挺有趣的交易提案。"
            trade.peer_commentary.append({
                "team_id": team.id,
                "team_name": team.name,
                "model": model_id,
                "text": text,
            })
        self._save()

    def decide(
        self,
        trade_id: str,
        counterparty_id: int,
        accept: bool,
        current_day: int,
        ai_gm: Optional[Any] = None,
    ) -> TradeProposal:
        """Accept or reject a pending_accept trade.

        When accepted and ai_gm is provided, immediately collect AI veto votes
        from all non-party AI teams. If votes >= threshold the trade is vetoed
        immediately; otherwise the veto window opens.
        """
        trade = self._find(trade_id)
        if trade is None:
            raise ValueError("Unknown trade_id")
        if trade.status != "pending_accept":
            raise ValueError(f"Trade is not pending_accept (status={trade.status})")
        if counterparty_id != trade.to_team:
            raise ValueError("Only the counterparty can accept or reject")

        trade.counterparty_decided_day = current_day
        if not accept:
            trade.status = "rejected"
            self._move_to_history(trade)
            self._save()
            return trade

        # Force flag: skip veto window entirely — execute immediately
        if trade.force:
            trade.status = "executed"
            trade.executed_day = current_day
            trade.force_executed = True
            trade.reasoning = (trade.reasoning + " 強制執行,跳過否決").strip()
            self._apply_swap(trade)
            self.state.season_executed_count += 1
            self._move_to_history(trade)
            self._save()
            return trade

        # Accepted — collect immediate AI veto votes if ai_gm available
        trade.status = "accepted"
        trade.veto_deadline_day = current_day + self._veto_window_days

        if ai_gm is not None:
            for voter in self.draft.teams:
                if voter.is_human:
                    continue
                if voter.id in (trade.from_team, trade.to_team):
                    continue
                if voter.id in trade.veto_votes:
                    continue
                if ai_gm.vote_veto_multi_factor(
                    trade, self.draft, voter.gm_persona or "bpa", self._settings
                ):
                    trade.veto_votes.append(voter.id)

            # Immediate veto if threshold already met
            if len(trade.veto_votes) >= self._veto_threshold:
                trade.status = "vetoed"
                self._move_to_history(trade)
                self._save()
                return trade

        self._save()
        return trade

    def auto_decide_ai(
        self,
        ai_gm: Any,
        current_day: int,
    ) -> list[TradeProposal]:
        """Iterate pending trades where to_team is AI and status=pending_accept.
        Call ai_gm.decide_trade and set status accordingly.
        Returns list of decided trades.
        """
        decided: list[TradeProposal] = []
        for trade in list(self.state.pending):
            if trade.status != "pending_accept":
                continue
            cp = self.draft.teams[trade.to_team]
            if cp.is_human:
                continue
            # Force flag: skip AI decide entirely
            if trade.force:
                self.decide(trade.id, cp.id, True, current_day, ai_gm=None)
            else:
                accept, _ = ai_gm.decide_trade(trade, cp, self.draft, self._settings)
                self.decide(trade.id, cp.id, accept, current_day, ai_gm=ai_gm)
            decided.append(trade)
        return decided

    def veto(self, trade_id: str, voter_team_id: int) -> TradeProposal:
        trade = self._find(trade_id)
        if trade is None:
            raise ValueError("Unknown trade_id")
        if trade.status != "accepted":
            raise ValueError(f"Trade is not in veto window (status={trade.status})")
        if voter_team_id in (trade.from_team, trade.to_team):
            raise ValueError("Trade parties cannot cast veto votes")
        if voter_team_id in trade.veto_votes:
            return trade  # idempotent
        trade.veto_votes.append(voter_team_id)
        # Immediately veto if threshold met
        if len(trade.veto_votes) >= self._veto_threshold:
            trade.status = "vetoed"
            self._move_to_history(trade)
        self._save()
        return trade

    def cancel(self, trade_id: str, by_team_id: int) -> TradeProposal:
        trade = self._find(trade_id)
        if trade is None:
            raise ValueError("Unknown trade_id")
        if trade.status != "pending_accept":
            raise ValueError("Only pending_accept trades can be cancelled")
        if by_team_id != trade.from_team:
            raise ValueError("Only the proposer can cancel")
        trade.status = "expired"
        self._move_to_history(trade)
        self._save()
        return trade

    # ----------------------------------------------------------------- daily
    # Pending human-counterparty trades auto-expire after this many sim days.
    PENDING_ACCEPT_TTL_DAYS: int = 7

    def daily_tick(self, current_day: int, current_week: int) -> list[TradeProposal]:
        """Resolve accepted trades whose veto windows have closed. Also auto-
        expire pending_accept trades targeting a human counterparty once they
        have sat unread for more than PENDING_ACCEPT_TTL_DAYS sim days — so a
        neglected offer doesn't linger forever.
        Returns list of trades whose status flipped this tick (for logging).
        """
        resolved: list[TradeProposal] = []

        for trade in list(self.state.pending):
            # Resolve accepted trades past veto deadline
            if trade.status == "accepted":
                if (
                    trade.veto_deadline_day is not None
                    and current_day >= trade.veto_deadline_day
                ):
                    if len(trade.veto_votes) >= self._veto_threshold:
                        trade.status = "vetoed"
                    else:
                        trade.status = "executed"
                        trade.executed_day = current_day
                        self._apply_swap(trade)
                        self.state.season_executed_count += 1
                    self._move_to_history(trade)
                    resolved.append(trade)
            # Auto-expire pending_accept trades that have sat too long
            elif trade.status == "pending_accept":
                age = current_day - int(trade.proposed_day or current_day)
                if age >= self.PENDING_ACCEPT_TTL_DAYS:
                    trade.status = "expired"
                    self._move_to_history(trade)
                    resolved.append(trade)

        if resolved:
            self._save()
        return resolved

    def _apply_swap(self, trade: TradeProposal) -> None:
        """Swap players between rosters in the draft state and persist the draft."""
        sender = self.draft.teams[trade.from_team]
        receiver = self.draft.teams[trade.to_team]

        send_set = set(trade.send_player_ids)
        recv_set = set(trade.receive_player_ids)

        sender.roster = [pid for pid in sender.roster if pid not in send_set]
        sender.roster.extend(trade.receive_player_ids)

        receiver.roster = [pid for pid in receiver.roster if pid not in recv_set]
        receiver.roster.extend(trade.send_player_ids)

        try:
            self.storage.save_draft(self.draft.snapshot())
        except Exception as e:
            # Roster mutation already happened in-memory; surface this so
            # we know the on-disk state may diverge. Without logging, a silent
            # failure leaves the league in a split-brain state after restart.
            import sys, traceback
            print(f"[trades] save_draft failed after trade swap: {e!r}", file=sys.stderr)
            traceback.print_exc()

    # ------------------------------------------------------------------ info
    def quota_info(self, current_week: int) -> dict:
        import math
        from .season import REGULAR_WEEKS as _DEFAULT_REG
        reg_weeks = (
            self._settings.regular_season_weeks
            if self._settings is not None
            else _DEFAULT_REG
        )
        target = max(0, math.ceil(current_week * 10 / reg_weeks))
        executed = int(self.state.season_executed_count)
        behind = max(0, target - executed)
        return {"executed": executed, "target": target, "behind": behind}

    def pending(self) -> list[TradeProposal]:
        return list(self.state.pending)

    def history(self, limit: int = 50) -> list[TradeProposal]:
        if limit <= 0:
            return []
        return list(self.state.history[-limit:])

    def require_human_attention(self, human_team_id: int = 0) -> list[str]:
        """Trade ids where the human is counterparty on pending_accept."""
        ids: list[str] = []
        for t in self.state.pending:
            if t.status == "pending_accept" and t.to_team == human_team_id:
                ids.append(t.id)
        return ids
