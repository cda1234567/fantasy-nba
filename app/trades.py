"""Trade workflow: propose → accept/reject → veto window → execute.

Yahoo-style veto: any 3 non-party managers voting veto during the review
window cancels an accepted trade. Persisted via Storage.load_trades()/save_trades().

Lifecycle:
    1. propose()  -> status "pending_accept" (2-day decide window)
    2. decide(accept=True)  -> status "accepted" (2-day veto window)
    3. decide(accept=False) -> status "rejected" (final)
    4. During veto window, veto() records votes; 3+ non-party votes -> "vetoed"
    5. daily_tick() resolves expired propose-windows, expired veto-windows,
       and finalizes execute/veto.
"""
from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any, Literal, Optional

from pydantic import BaseModel, Field

if TYPE_CHECKING:
    from .draft import DraftState
    from .models import SeasonState
    from .storage import Storage


TradeStatus = Literal[
    "pending_accept", "accepted", "rejected", "vetoed", "executed", "expired"
]

PROPOSE_WINDOW_DAYS = 2   # counterparty must decide within this many days
VETO_WINDOW_DAYS = 2      # review window after acceptance
VETO_THRESHOLD = 3        # non-party votes needed to kill an accepted trade


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
    ):
        self.storage = storage
        self.draft = draft_state
        self.season = season_state
        self.state = self._load()

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
        # Replace in history if already there; else append.
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
    ) -> TradeProposal:
        if from_team == to_team:
            raise ValueError("Cannot trade with self")
        if not send_ids or not receive_ids:
            raise ValueError("Both sides must include at least one player")

        # Validate ownership
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

        # Don't allow duplicate pending trades between same pair with same players
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
        )
        self.state.pending.append(trade)
        self._save()
        return trade

    def decide(
        self,
        trade_id: str,
        counterparty_id: int,
        accept: bool,
        current_day: int,
    ) -> TradeProposal:
        trade = self._find(trade_id)
        if trade is None:
            raise ValueError("Unknown trade_id")
        if trade.status != "pending_accept":
            raise ValueError(f"Trade is not pending_accept (status={trade.status})")
        if counterparty_id != trade.to_team:
            raise ValueError("Only the counterparty can accept or reject")

        trade.counterparty_decided_day = current_day
        if accept:
            trade.status = "accepted"
            trade.veto_deadline_day = current_day + VETO_WINDOW_DAYS
        else:
            trade.status = "rejected"
            self._move_to_history(trade)
        self._save()
        return trade

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
    def daily_tick(self, current_day: int, current_week: int) -> list[TradeProposal]:
        """Resolve pending/accepted trades whose windows have closed.

        Returns a list of trades whose status flipped this tick (for logging).
        """
        resolved: list[TradeProposal] = []

        # Iterate over a snapshot because we mutate self.state.pending.
        for trade in list(self.state.pending):
            # Expire pending_accept past 2-day window (from proposed day, inclusive)
            if trade.status == "pending_accept":
                if current_day >= trade.proposed_day + PROPOSE_WINDOW_DAYS:
                    trade.status = "expired"
                    self._move_to_history(trade)
                    resolved.append(trade)
                continue

            # Resolve accepted trades past veto deadline
            if trade.status == "accepted":
                if (
                    trade.veto_deadline_day is not None
                    and current_day >= trade.veto_deadline_day
                ):
                    if len(trade.veto_votes) >= VETO_THRESHOLD:
                        trade.status = "vetoed"
                    else:
                        trade.status = "executed"
                        trade.executed_day = current_day
                        self._apply_swap(trade)
                        self.state.season_executed_count += 1
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

        # Remove sent players from sender; add received players to sender.
        sender.roster = [pid for pid in sender.roster if pid not in send_set]
        sender.roster.extend(trade.receive_player_ids)

        # Remove received-from players from receiver; add received-by-receiver.
        receiver.roster = [pid for pid in receiver.roster if pid not in recv_set]
        receiver.roster.extend(trade.send_player_ids)

        # Persist the draft snapshot so the new rosters survive a restart.
        try:
            self.storage.save_draft(self.draft.snapshot())
        except Exception:
            pass

    # ------------------------------------------------------------------ info
    def quota_info(self, current_week: int) -> dict:
        import math
        target = max(0, math.ceil(current_week * 10 / 14))
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
