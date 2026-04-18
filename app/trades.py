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

import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import TYPE_CHECKING, Any, Literal, Optional


# Module-level lock serializes read-modify-write on trades.json.
# Without this, two concurrent proposals both read the same prior state,
# each appends only its own trade, and the second write silently drops
# the first (confirmed by stress agents 1 and 10).
_TRADES_WRITE_LOCK = threading.Lock()

from pydantic import BaseModel, Field

if TYPE_CHECKING:
    from .draft import DraftState
    from .models import LeagueSettings, SeasonState
    from .storage import Storage


TradeStatus = Literal[
    "pending_accept", "accepted", "rejected", "vetoed", "executed", "expired", "countered"
]

# Defaults; overridden by LeagueSettings when passed in
VETO_WINDOW_DAYS = 2
VETO_THRESHOLD = 3


def _urgency_multiplier(
    team_id: int,
    current_week: int,
    standings: "dict[int, dict[str, float]]",
    settings: Any,
) -> float:
    """Return 2.0 if team is bottom-4 by W-L AND within 2 weeks of trade deadline.
    Otherwise return 1.0. Returns 1.0 if trade_deadline_week is None/unset.
    """
    deadline = None
    if settings is not None:
        deadline = getattr(settings, "trade_deadline_week", None)
    if deadline is None:
        return 1.0
    if current_week < int(deadline) - 2:
        return 1.0

    # Sort teams by wins descending, losses ascending
    ranked = sorted(
        standings.items(),
        key=lambda kv: (-kv[1].get("w", 0), kv[1].get("l", 0)),
    )
    bottom_4 = {tid for tid, _ in ranked[-4:]}
    return 2.0 if team_id in bottom_4 else 1.0


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class TradeMessage(BaseModel):
    from_team: int          # team_id of sender, or -1 for system/AI narrator
    body: str
    ts: float = 0.0
    kind: Literal["user", "ai_reason", "system"] = "user"


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
    counter_of: Optional[str] = None
    messages: list[TradeMessage] = Field(default_factory=list)


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
        # Unbalanced trades (2-for-1, 1-for-2, etc.) are allowed — AI GM
        # evaluates them with roster-slot accounting in decide_trade. Human
        # proposers should not be blocked at the proposal gate.
        if len(set(send_ids)) != len(send_ids):
            raise ValueError("Duplicate player id in send side")
        if len(set(receive_ids)) != len(receive_ids):
            raise ValueError("Duplicate player id in receive side")
        if set(send_ids) & set(receive_ids):
            raise ValueError("Same player cannot appear on both sides")
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

        # Re-load under lock and re-check dedup so concurrent proposals do
        # not clobber each other. Without the re-load, the `self.state` seen
        # by this TradeManager instance may be stale relative to a racing
        # proposer's write that already landed.
        with _TRADES_WRITE_LOCK:
            self.state = self._load()
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
            # Seed the chat thread with the proposer's opening message so the
            # counter-party can reply into the same conversation.
            opening = (proposer_message or "").strip()
            if opening:
                trade.messages.append(TradeMessage(
                    from_team=from_team, body=opening[:300],
                    ts=time.time(), kind="user",
                ))
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
        """Synchronous version: collect peer commentary in parallel via threadpool."""
        commentators = [
            t for t in self.draft.teams
            if t.id not in (trade.from_team, trade.to_team) and not t.is_human
        ]
        commentators = sorted(commentators, key=lambda t: t.id)[:3]
        if not commentators:
            return

        model_map: dict[int, str] = getattr(self.season, "ai_models", {}) or {}

        def _call_one(team: Any) -> dict:
            model_id = model_map.get(team.id, "anthropic/claude-haiku-4.5")
            try:
                text = ai_gm.peer_commentary(trade, self.draft, team, model_id)
            except Exception:
                text = "挺有趣的交易提案。"
            return {
                "team_id": team.id,
                "team_name": team.name,
                "model": model_id,
                "text": text,
            }

        results: dict[int, dict] = {}
        with ThreadPoolExecutor(max_workers=min(6, len(commentators))) as pool:
            futures = {pool.submit(_call_one, team): team.id for team in commentators}
            for future in as_completed(futures):
                tid = futures[future]
                results[tid] = future.result()

        # Preserve original sorted order
        trade.peer_commentary = [results[t.id] for t in commentators if t.id in results]
        self._save()

    def decide(
        self,
        trade_id: str,
        counterparty_id: int,
        accept: bool,
        current_day: int,
        ai_gm: Optional[Any] = None,
        reason: Optional[str] = None,
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
            if reason:
                clean = reason.strip()[:200]
                if clean:
                    prior = (trade.reasoning or "").strip()
                    trade.reasoning = f"{prior} ｜ 拒絕原因：{clean}" if prior else f"拒絕原因：{clean}"
                    trade.messages.append(TradeMessage(
                        from_team=counterparty_id, body=clean,
                        ts=time.time(), kind="ai_reason",
                    ))
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

    def add_message(
        self,
        trade_id: str,
        from_team: int,
        body: str,
        ai_gm: Optional[Any] = None,
    ) -> TradeProposal:
        """Append a chat message to an open trade thread.

        Allowed on pending_accept trades only. If the counterparty is an AI
        team and ai_gm is provided, the AI generates a short reply using the
        full message thread as context. The reply is appended as a second
        message; the trade stays pending_accept — this is negotiation, not
        a decision.
        """
        body_clean = (body or "").strip()
        if not body_clean:
            raise ValueError("訊息不可為空")
        with _TRADES_WRITE_LOCK:
            self.state = self._load()
            trade = self._find(trade_id)
            if trade is None:
                raise ValueError("Unknown trade_id")
            # Post-executed trash-talk mode: after a trade is done, both parties
            # can keep chatting (閒聊 / 慶祝 / 嘴砲). No renegotiation is
            # possible — the backend treats these messages as conversational
            # only. Accepted trades (waiting in veto window) also stay open so
            # parties can defend their deal.
            # Only truly-vetoed trades silence the thread (the trade was undone;
            # there's no reason to stay engaged there).
            if trade.status == "vetoed":
                raise ValueError(f"Trade is not open for messaging (status={trade.status})")
            if from_team not in (trade.from_team, trade.to_team):
                raise ValueError("Only the two trade parties can send messages")
            trade.messages.append(TradeMessage(
                from_team=from_team, body=body_clean[:300],
                ts=time.time(), kind="user",
            ))
            self._save()
            target_team = trade.to_team if from_team == trade.from_team else trade.from_team
            target_is_ai = not self.draft.teams[target_team].is_human

        # AI reply happens outside the lock — LLM call is slow and we don't
        # want to block other trade mutations while waiting on the network.
        if target_is_ai and ai_gm is not None:
            try:
                reply = ai_gm.chat_on_trade(
                    trade, self.draft, target_team, self._settings,
                    trade_status=trade.status,
                )
            except Exception as exc:
                import traceback, sys
                print(f"[trades] chat_on_trade failed: {exc!r}", file=sys.stderr)
                traceback.print_exc()
                reply = None
            if reply:
                with _TRADES_WRITE_LOCK:
                    self.state = self._load()
                    fresh = self._find(trade_id)
                    # Only vetoed silences the AI reply; post-executed 嘴砲 is OK.
                    if fresh is not None and fresh.status != "vetoed":
                        fresh.messages.append(TradeMessage(
                            from_team=target_team, body=str(reply)[:300],
                            ts=time.time(), kind="user",
                        ))
                        self._save()
                        trade = fresh
        return trade

    def auto_decide_ai(
        self,
        ai_gm: Any,
        current_day: int,
    ) -> list[TradeProposal]:
        """Iterate pending trades where to_team is AI and status=pending_accept.
        Call ai_gm.decide_trade and set status accordingly.
        If rejected, give the AI a 30% chance to counter-propose instead.
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
                # Skip counter-offer chains: only allow one counter per original
                already_counter = trade.counter_of is not None
                standings = getattr(self.season, "standings", {}) or {}
                _cur_week = getattr(self.season, "current_week", 0)
                accept, ai_reason = ai_gm.decide_trade(
                    trade, cp, self.draft, self._settings,
                    current_week=_cur_week,
                    standings=standings,
                )
                if not accept and not already_counter:
                    counter_dict = ai_gm.maybe_counter(trade, cp, self.draft, self._settings)
                    if counter_dict is not None:
                        # Create the counter-offer FIRST; only mark original as countered
                        # after successful creation to avoid data loss on failure.
                        # maybe_counter returns IDs from the ORIGINAL trade perspective;
                        # when AI becomes the proposer, swap the sides.
                        try:
                            counter_trade = self.propose(
                                from_team=trade.to_team,
                                to_team=trade.from_team,
                                send_ids=counter_dict["receive_player_ids"],
                                receive_ids=counter_dict["send_player_ids"],
                                current_day=current_day,
                                current_week=trade.proposed_week,
                                reasoning=f"還價：{cp.name}",
                            )
                            counter_trade.counter_of = trade.id
                            # Original trade is now superseded; move to history
                            trade.status = "countered"
                            self._move_to_history(trade)
                            self._save()
                            decided.append(trade)
                            continue
                        except Exception as exc:
                            import traceback, sys
                            print(f"[trades] counter-offer creation failed: {exc!r}", file=sys.stderr)
                            traceback.print_exc()
                            # Fall through to normal reject — original trade stays intact
                self.decide(trade.id, cp.id, accept, current_day, ai_gm=ai_gm, reason=ai_reason)
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
                        # _apply_swap may flip status back to "expired" if a
                        # player has since moved — don't count those.
                        if trade.status == "executed":
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
        """Swap players between rosters in the draft state and persist the draft.

        Re-validates ownership at execute time: a trade accepted earlier may
        have referenced players that have since moved (e.g. a second trade
        already shipped them out). Executing blindly here used to leave one
        player on two rosters and another team with 14 players.
        """
        sender = self.draft.teams[trade.from_team]
        receiver = self.draft.teams[trade.to_team]

        send_set = set(trade.send_player_ids)
        recv_set = set(trade.receive_player_ids)

        sender_roster_set = set(sender.roster)
        receiver_roster_set = set(receiver.roster)
        missing_on_sender = send_set - sender_roster_set
        missing_on_receiver = recv_set - receiver_roster_set
        if missing_on_sender or missing_on_receiver:
            trade.status = "expired"
            trade.reasoning = (
                (trade.reasoning or "")
                + f" [自動撤銷：球員已不在隊伍名單中 {sorted(missing_on_sender | missing_on_receiver)}]"
            )
            return

        sender.roster = [pid for pid in sender.roster if pid not in send_set]
        sender.roster.extend(trade.receive_player_ids)

        receiver.roster = [pid for pid in receiver.roster if pid not in recv_set]
        receiver.roster.extend(trade.send_player_ids)

        # Enforce roster cap for N-for-M trades: if either side exceeds
        # roster_size, drop the lowest-FPPG bench player(s) to fit. The AI
        # fairness check in decide_trade already priced this in with a
        # replacement-level penalty.
        roster_cap = self._settings.roster_size if self._settings is not None else 13
        dropped: list[tuple[int, int]] = []  # (team_id, player_id)
        for team in (sender, receiver):
            while len(team.roster) > roster_cap:
                worst_pid = min(
                    team.roster,
                    key=lambda pid: getattr(
                        self.draft.players_by_id.get(pid), "fppg", 0.0
                    ),
                )
                team.roster = [pid for pid in team.roster if pid != worst_pid]
                dropped.append((team.id, worst_pid))
        if dropped:
            names = []
            for tid, pid in dropped:
                p = self.draft.players_by_id.get(pid)
                names.append(f"T{tid}:{p.name if p else pid}")
            trade.reasoning = (trade.reasoning or "") + f" [自動丟棄替補以符合名單上限: {', '.join(names)}]"

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
