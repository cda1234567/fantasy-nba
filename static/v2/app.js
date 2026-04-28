// Fantasy NBA v2 — hash router + draft view (ports v1 logic onto v2 shell)
'use strict';

// ---------------------------------------------------------------- dom helpers
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const fppg = (n) => (typeof n === 'number' ? n.toFixed(1) : '-');
const fmtStat = (n) => (typeof n === 'number' ? n.toFixed(1) : '-');

// ---------------------------------------------------------------- state
const state = {
  draft: null,
  personas: {},
  leagueStatus: null,
  leagueSettings: null,
  draftRecos: null,
  draftAutoTimer: null,
  draftAutoBusy: false,
  // M5: per-pick countdown for the human draft clock. Reset every render that
  // detects a new human turn; nulled when the timer fires or the user picks.
  draftClockSec: null,
  draftClockInterval: null,
  draftClockTurnKey: null, // `${current_overall}` so we don't reset mid-turn
  draftFilter: { q: '', pos: '', sort: 'fppg' },
  draftDisplayMode: 'prev_full',
  connected: false,
  _lastDraftWasHumanTurn: false,
  teamView: null,         // last /api/teams/{id} payload
  currentTeamId: null,    // selected team in #/teams
  faFilter: { q: '', pos: '', sort: 'fppg' },
  faQuota: null,
  playerCache: new Map(),
  // league view (Phase 5)
  leagueSubTab: 'matchup',       // matchup | standings | management | schedule | activity | trades
  standings: null,               // /api/season/standings payload
  schedule: null,                // /api/season/schedule payload
  matchupDetail: null,           // /api/season/matchup-detail cache, keyed on `${week}-${a}-${b}`
  matchupViewWeek: null,
  activityFeed: null,
  tradesPending: null,
  tradesHistory: null,
  advancing: false,              // guard for advance-day/advance-week buttons
  // Phase 6 schedule view
  scheduleOpenWeek: null,        // week num expanded inline on /schedule
  scheduleOpenMatch: null,       // `${week}-${a}-${b}` with detail expanded
  // Phase 7 trades view
  tradesTab: 'pending',          // pending | history | propose
  tradesOddsOpen: new Set(),     // trade ids with odds expanded
  tradesOddsCache: new Map(),    // trade_id -> /api/trades/{id}/category-odds
  tradesHistoryExpanded: new Set(), // history trade ids that are expanded
  proposeDraft: null,            // { counterparty, send:Set, receive:Set, humanRoster, counterpartyRoster }
  tradesPollTimer: null,
  // Phase 7.1 trade counter-offer modal
  counterDraft: null,            // { originalTradeId, counterparty, send:Set, receive:Set, fromRoster, toRoster }
  // Draft commentary feed (latest first, cap 10)
  draftCommentary: [],
  // league switcher + setup
  leagues: [],                   // [{league_id,name,setup_complete}, ...]
  activeLeague: 'default',
  setupForm: null,               // working copy for #setup
  setupStep: 1,                  // M3: setup wizard step (1/2/3)
  teamsScoutId: null,            // M8: opponent team id selected for scouting view
  // M15: render race-condition guard — every render() bumps this; async
  // sub-renderers compare against state.viewToken before appending DOM.
  viewToken: null,
  // M16: abort in-flight player searches when a new keystroke fires.
  activePlayerSearchAbort: null,
  activeFaSearchAbort: null,
  // M17/M20: abort in-flight team fetches when the user switches teams.
  activeTeamFetchAbort: null,
  // M19: track active EventSource so route changes / league switches close it.
  activeES: null,
};

const VALID_ROUTES = ['teams', 'fa', 'league', 'schedule', 'trades', 'draft', 'setup'];

// Defaults mirrored from v1 DEFAULT_SETTINGS (keep in sync w/ static/app.js).
const DEFAULT_TEAM_NAMES_V2 = [
  '我的隊伍', 'BPA 書呆子', '控制失誤', '巨星搭配飼料',
  '全能建造者', '年輕上檔', '老將求勝', '反主流',
];
const DEFAULT_SETTINGS_V2 = {
  league_name: '我的聯盟',
  season_year: '2025-26',
  player_team_index: 0,
  team_names: [...DEFAULT_TEAM_NAMES_V2],
  randomize_draft_order: false,
  num_teams: 8,
  roster_size: 13,
  starters_per_day: 10,
  il_slots: 3,
  scoring_weights: { pts: 1, reb: 1.2, ast: 1.5, stl: 2.5, blk: 2.5, to: -1 },
  regular_season_weeks: 20,
  playoff_teams: 6,
  trade_deadline_week: null,
  ai_trade_frequency: 'normal',
  ai_trade_style: 'balanced',
  veto_threshold: 3,
  veto_window_days: 1,
  ai_decision_mode: 'auto',
  draft_display_mode: 'prev_full',
  show_offseason_headlines: true,
  gm_personas: [],
};

// ---------------------------------------------------------------- cookies
function setCookie(name, value, days = 365) {
  const maxAge = days * 24 * 60 * 60;
  // path=/ so every API path can read it; SameSite=Lax matches backend.
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
}

function getCookie(name) {
  const parts = document.cookie ? document.cookie.split('; ') : [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    const k = eq >= 0 ? part.slice(0, eq) : part;
    if (k === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

// Track whether we already toasted a 401 in the current second so a burst of
// concurrent writes doesn't spam the user.
let _last401ToastAt = 0;
function _maybeToast401() {
  const now = Date.now();
  if (now - _last401ToastAt < 1500) return;
  _last401ToastAt = now;
  try {
    toast('你不是這個聯盟的 manager，無法操作。請向 owner 索取分享連結（含 ?t=token）。', 'error', 5000);
  } catch {}
}

// ---------------------------------------------------------------- api
async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  const signals = [ctrl.signal, opts.signal].filter(Boolean);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      ...opts,
      signal,
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      try {
        const j = await res.json();
        msg = j.detail || j.message || JSON.stringify(j);
      } catch {
        try { msg = await res.text(); } catch { /* swallow */ }
      }
      const err = new Error(msg);
      err.status = res.status;
      if (res.status === 401) _maybeToast401();
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function apiSoft(path, opts) {
  try { return await api(path, opts); }
  catch (e) { return null; }
}

function setConnected(ok) {
  state.connected = ok;
  const dot = $('#conn-dot');
  if (!dot) return;
  dot.textContent = ok ? '已連線' : '連線中斷';
  dot.classList.toggle('good', ok);
  dot.classList.toggle('bad', !ok);
}

// One-shot fetch of server version on boot so the user can confirm the
// deploy reached them (no more guessing if a stale cache is being served).
async function fetchAndShowVersion() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    const d = await r.json();
    const el = $('#app-version');
    if (el && d.version) el.textContent = d.version;
  } catch {
    /* leave dash */
  }
}

// ---------------------------------------------------------------- toast
function toast(msg, kind = 'info', ms = 3000) {
  const stack = $('#toast-stack');
  if (!stack) return;
  const node = el('div', { class: `toast ${kind === 'error' ? 'error' : ''}` },
    el('span', { class: 't-ic' }, kind === 'error' ? '⚠' : '✓'),
    el('span', {}, msg),
  );
  stack.append(node);
  setTimeout(() => node.remove(), ms);
}

// ---------------------------------------------------------------- state refresh
async function refreshState() {
  try {
    state.draft = await api('/api/state');
    setConnected(true);
  } catch (e) {
    setConnected(false);
    return;
  }
  // Soft fetches — OK to fail
  const [personas, status, settings] = await Promise.all([
    apiSoft('/api/personas'),
    apiSoft('/api/league/status'),
    apiSoft('/api/league/settings'),
  ]);
  if (personas) state.personas = personas;
  if (status) {
    state.leagueStatus = status;
    const nm = $('#league-name-text');
    if (nm && status.league_name) nm.textContent = status.league_name;
  }
  if (settings) {
    state.leagueSettings = settings;
    state.draftDisplayMode = settings.draft_display_mode || 'prev_full';
  }
}

// ---------------------------------------------------------------- router
function currentRoute() {
  const hash = (location.hash || '').replace(/^#\/?/, '').trim();
  if (VALID_ROUTES.includes(hash)) return hash;
  // Default: if draft hasn't completed, send user to draft; otherwise teams.
  return state.draft && !state.draft.is_complete ? 'draft' : 'teams';
}

function navigate(route) {
  if (location.hash !== `#/${route}`) location.hash = `/${route}`;
  else render();
}

function render() {
  const route = currentRoute();
  // M15: bump view-token so any in-flight async sub-renderers know they are
  // stale and must drop their results instead of clobbering fresh DOM.
  state.viewToken = Symbol('view');
  // M19/M20/M21: tear down anything tied to the previous view before swapping.
  closeActiveES();
  abortActiveTeamFetch();
  abortActivePlayerSearch();
  abortActiveFaSearch();
  // Highlight active nav
  $$('.nav-item').forEach((a) => {
    const active = a.dataset.route === route;
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const main = $('#main');
  if (!main) return;
  main.innerHTML = '';
  // Snapshot the token so each branch can pass it to async helpers if needed.
  const tok = state.viewToken;
  main.dataset.viewToken = tok.description || '';
  switch (route) {
    case 'draft':    renderDraftView(main); break;
    case 'teams':    renderTeamsView(main); break;
    case 'fa':       renderFaView(main); break;
    case 'league':   renderLeagueView(main); break;
    case 'schedule': renderScheduleView(main); break;
    case 'trades':   renderTradesView(main); break;
    case 'setup':    renderSetupView(main); break;
  }
  // Start/stop trades polling based on route
  if (route === 'trades') startTradesPolling();
  else stopTradesPolling();
  try { main.focus({ preventScroll: true }); } catch {}
}

// M15 helper: async renderers call this after awaiting; if the view changed
// underneath them the result must be dropped.
function isViewStale(tok) {
  return tok !== state.viewToken;
}

// M19 helper: close the active EventSource (advance-week / sim streams) so a
// route change doesn't leave the connection ticking against the old view.
function closeActiveES() {
  if (state.activeES) {
    try { state.activeES.close(); } catch {}
    state.activeES = null;
  }
}

// M17/M20 helper: abort any in-flight /api/teams/{id} fetch.
function abortActiveTeamFetch() {
  if (state.activeTeamFetchAbort) {
    try { state.activeTeamFetchAbort.abort(); } catch {}
    state.activeTeamFetchAbort = null;
  }
}

// M16 helpers: abort player/FA search fetches.
function abortActivePlayerSearch() {
  if (state.activePlayerSearchAbort) {
    try { state.activePlayerSearchAbort.abort(); } catch {}
    state.activePlayerSearchAbort = null;
  }
}
function abortActiveFaSearch() {
  if (state.activeFaSearchAbort) {
    try { state.activeFaSearchAbort.abort(); } catch {}
    state.activeFaSearchAbort = null;
  }
}

function renderPlaceholder(root, title, note) {
  root.append(
    el('div', { class: 'view-head' },
      el('div', { class: 'view-title-block' },
        el('span', { class: 'eyebrow' }, 'Coming soon'),
        el('div', { class: 'view-title' }, title),
        el('div', { class: 'view-sub' }, note),
      ),
    ),
    el('div', { class: 'card card-pad' }, '尚未實作。本次 v2 port 只做「選秀」完整流程。'),
  );
}

// ================================================================ DRAFT VIEW
async function renderDraftView(root) {
  // M15: snapshot view-token; bail out if the user navigated away mid-await.
  const tok = state.viewToken;
  // Blank state: league created but setup not yet run.
  if (state.leagueStatus && state.leagueStatus.setup_complete === false) {
    root.append(
      el('div', { class: 'setup-blank' },
        el('h2', { style: 'margin:0 0 8px;' }, '尚未設定聯盟'),
        el('p', { style: 'color:var(--ink-3); margin:0 0 16px;' },
          '本聯盟 (' + escapeHtml(state.activeLeague || '') + ') 還沒完成設定，請先到「聯盟設定」填好隊名與規則。'),
        el('button', { class: 'btn', onclick: () => navigate('setup') }, '前往設定 →'),
      ),
    );
    return;
  }
  const d = state.draft;
  if (!d) {
    root.append(el('div', { class: 'card card-pad' }, '載入選秀狀態中…'));
    return;
  }

  // View head
  const head = el('div', { class: 'view-head' },
    el('div', { class: 'view-title-block' },
      el('span', { class: 'eyebrow' }, '選秀'),
      el('div', { class: 'view-title' }, d.is_complete ? '選秀完成' : `第 ${d.current_round} 輪 · 第 ${d.current_pick_in_round} 順`),
      el('div', { class: 'view-sub' }, `${d.num_teams} 隊 · ${d.total_rounds} 輪，共 ${d.num_teams * d.total_rounds} 順`),
    ),
    d.is_complete
      ? el('div', { class: 'view-actions' },
          el('button', { class: 'btn', onclick: onStartSeason }, '🏁 開始賽季'),
          el('button', { class: 'btn ghost', onclick: onResetDraft }, '重置選秀'))
      : el('div', { class: 'view-actions' },
          el('button', { class: 'btn ghost', onclick: onResetDraft }, '重置選秀'))
  );
  root.append(head);

  // M7: sticky draft sub-header with current team + persona summary so the
  // user always sees who's on the clock when scrolling the board.
  root.append(buildDraftStickyHeader(d));

  // Top: clock + commentary feed (replaces old recos panel)
  const clock = buildDraftClock(d);
  const top = el('div', { class: 'draft-top' }, clock, buildDraftCommentaryPanel());
  root.append(top);

  // M6: AI recommendation card on human turns (lazy-fetched).
  const isHumanTurn = !d.is_complete && d.current_team_id === d.human_team_id;
  if (isHumanTurn) {
    const recoHost = el('div', { id: 'draft-recos-host', style: 'margin-top: var(--s-4);' });
    root.append(recoHost);
    refreshDraftRecos().then(() => {
      const card = buildDraftRecosCard();
      if (card && tok === state.viewToken) {
        const host = $('#draft-recos-host');
        if (host) { host.innerHTML = ''; host.append(card); }
      }
    }).catch(() => {});
  }

  // Available players table (left) + board (right)
  const availPanel = buildAvailablePanel(d);
  const boardPanel = buildBoardPanel(d);

  const grid = el('div', { style: 'display:grid; grid-template-columns: 1.3fr 1fr; gap: var(--s-5); align-items: start;' },
    availPanel,
    boardPanel,
  );
  root.append(grid);

  // M7: recent picks scrolling feed below the board.
  root.append(buildRecentPicksFeed(d));

  // Kick off table render
  renderAvailableTable(state.draftDisplayMode || 'prev_full');

  // M5: start the per-pick countdown timer (human turn only).
  startDraftClockTimer(d);

  // Auto-advance AI turn
  scheduleDraftAutoAdvance();
}

// M7: sticky sub-header that names the team currently on the clock + persona.
function buildDraftStickyHeader(d) {
  const wrap = el('div', { class: 'draft-sticky-head' });
  if (d.is_complete) {
    wrap.append(el('span', { class: 'pill good' }, '✅ 完成'));
    return wrap;
  }
  const team = d.teams[d.current_team_id];
  const persona = team?.gm_persona ? state.personas?.[team.gm_persona] : null;
  const isYou = team?.is_human;
  wrap.append(
    el('span', { class: `pill ${isYou ? 'accent' : ''}` }, isYou ? '🎯 你' : '🤖 AI'),
    el('b', {}, team?.name || ''),
    persona && !isYou ? el('span', { class: 'sticky-persona' }, ` · ${persona.name || team.gm_persona}`) : null,
    el('span', { class: 'sticky-pickno' }, `第 ${d.current_round} 輪 · 第 ${d.current_pick_in_round} 順 · 總 #${d.current_overall}`),
  );
  return wrap;
}

// M7: recent 5 picks scrolling feed.
function buildRecentPicksFeed(d) {
  const card = el('div', { class: 'card', style: 'margin-top: var(--s-5);' });
  card.append(el('div', { class: 'card-header' },
    el('h3', {}, '最近 5 順'),
    el('span', { class: 'sub' }, `共 ${(d.picks || []).length} 順`),
  ));
  const body = el('div', { class: 'recent-picks-feed' });
  const recent = (d.picks || []).slice(-5).reverse();
  if (!recent.length) {
    body.append(el('div', { class: 'empty-state', style: 'padding: var(--s-4);' }, '尚未開始選秀。'));
  } else {
    for (const p of recent) {
      const team = d.teams[p.team_id];
      body.append(el('div', { class: 'rp-row' },
        el('span', { class: 'rp-num' }, `#${p.overall}`),
        el('span', { class: 'rp-name' }, p.player_name),
        el('span', { class: 'rp-team' }, team?.name || `T${p.team_id}`),
        el('span', { class: 'rp-rd' }, `R${p.round}`),
      ));
    }
  }
  card.append(body);
  return card;
}

function buildDraftCommentaryPanel() {
  const panel = el('div', { class: 'card', id: 'draft-chat-panel', style: 'margin-top: var(--s-5);' });
  const header = el('div', { class: 'card-header' },
    el('h3', {}, '聯盟聊天'),
    el('span', { class: 'sub' }, '最近 10 則 AI GM 評論'),
  );
  panel.append(header);
  const body = el('div', { id: 'draft-chat-body', style: 'padding: var(--s-3) var(--s-4); max-height: 240px; overflow-y: auto;' });
  renderDraftCommentaryBody(body);
  panel.append(body);
  return panel;
}

function renderDraftCommentaryBody(body) {
  body.innerHTML = '';
  const items = state.draftCommentary || [];
  if (!items.length) {
    body.append(el('div', { style: 'color: var(--ink-3); font-size: var(--fs-sm);' },
      '尚無評論。AI GM 會在選秀過程中隨機發表看法。'));
    return;
  }
  const list = el('ul', { style: 'list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap: var(--s-2);' });
  for (const c of items) {
    list.append(el('li', { style: 'font-size: var(--fs-sm); line-height: 1.5;' },
      el('b', { style: 'color: var(--accent);' }, `[${c.gm_team_name || `Team ${c.gm_team_id}`}]`),
      ' ',
      el('span', {}, c.text || ''),
    ));
  }
  body.append(list);
}

function buildDraftClock(d) {
  const card = el('div', { class: 'draft-clock' });
  if (d.is_complete) {
    card.append(
      el('div', { class: 'dc-eyebrow' },
        el('span', { class: 'pill good' }, '✅ 完成'),
        el('span', { class: 'pick-num' }, `${d.num_teams * d.total_rounds} 順位全部完成`),
      ),
      el('h2', {}, '選秀完成'),
      el('div', { class: 'dc-sub' }, '可以開始本季對戰了。'),
    );
    return card;
  }
  const team = d.teams[d.current_team_id];
  const isYou = team?.is_human;
  const persona = team?.gm_persona ? state.personas?.[team.gm_persona] : null;

  card.append(
    el('div', { class: 'dc-eyebrow' },
      el('span', { class: 'live' }, isYou ? '輪到你' : '進行中'),
      el('span', { class: 'pick-num' }, `總順位 #${d.current_overall} · 第 ${d.current_round} 輪`),
    ),
    el('h2', {}, isYou ? `🎯 ${team.name}（你）` : `🤖 ${team.name}`),
    persona && !isYou
      ? el('div', { class: 'dc-sub' },
          el('b', {}, persona.name || team.gm_persona),
          persona.desc ? ` — ${persona.desc}` : '')
      : el('div', { class: 'dc-sub' }, isYou ? '請在下方「剩餘球員」中點「選秀」。' : 'AI 選秀中…'),
    // M5: countdown placeholder. Filled by tickDraftClock(); only visible on
    // human turns. We render a slot even on AI turns so layout doesn't jump.
    isYou ? el('div', { class: 'dc-clock', id: 'draft-clock-readout', 'data-state': 'normal' }, '90s') : null,
    el('div', { style: 'display:flex; gap:8px; margin-top: var(--s-4); flex-wrap: wrap;' },
      el('button', { class: 'btn ghost sm', disabled: isYou, onclick: onAdvance }, '推進 AI 一手'),
      el('button', {
        class: `btn ghost sm ${state.draftPaused ? 'primary' : ''}`,
        disabled: isYou,
        onclick: onTogglePauseDraft,
        title: state.draftPaused ? '恢復自動推進' : '暫停 AI 自動推進',
      }, state.draftPaused ? '▶ 繼續' : '⏸ 暫停'),
      el('button', { class: 'btn sm', onclick: onSimToMe }, '⏭ 模擬到我'),
    ),
    state.draftPaused
      ? el('div', { style: 'margin-top: var(--s-3); color: var(--ink-3); font-size: var(--fs-xs);' }, '⏸ AI 自動推進已暫停')
      : null,
  );
  return card;
}

function onTogglePauseDraft() {
  state.draftPaused = !state.draftPaused;
  if (state.draftPaused) {
    cancelDraftAutoAdvance();
    toast('已暫停 AI 自動推進', 'info');
  } else {
    toast('已恢復 AI 自動推進', 'info');
    scheduleDraftAutoAdvance();
  }
  render();
}

function buildDraftRecosCard() {
  const data = state.draftRecos;
  if (!data || data.is_complete) return null;
  const recos = Array.isArray(data.recos) ? data.recos : [];
  if (!recos.length) return null;

  const card = el('div', { class: 'card card-pad' });
  card.append(
    el('div', { style: 'display:flex; justify-content:space-between; align-items:baseline; margin-bottom: var(--s-4);' },
      el('div', { class: 'eyebrow' }, 'AI 推薦'),
      el('div', { style: 'font-size: var(--fs-xs); color: var(--ink-3); font-family: var(--mono);' },
        `第 ${data.round} 輪 · 第 ${data.pick_overall} 順${data.on_clock ? ' · 你選' : ''}`),
    )
  );

  const list = el('div', { style: 'display:flex; flex-direction:column; gap: var(--s-2);' });
  for (const r of recos) {
    const reasonText = (Array.isArray(r.reasons) ? r.reasons : []).join(' · ');
    const row = el('div', {
      class: `reco-card ${r.top ? 'top' : ''}`,
      style: 'padding: var(--s-3) var(--s-4); gap: var(--s-2);',
    },
      el('div', { class: 'reco-player' },
        el('div', { style: 'font-family:var(--mono); color:var(--ink-3); font-size: var(--fs-xs); min-width: 24px;' }, `#${r.rank}`),
        el('div', { style: 'flex:1;' },
          el('div', { class: 'reco-name' }, r.name),
          el('div', { class: 'reco-meta' },
            el('span', { class: 'pos-tag', 'data-pos': r.pos || '' }, r.pos || ''),
            el('span', {}, r.team || ''),
            el('span', {}, `Fit ${r.fit} · FPPG ${r.fppg}`),
          ),
        ),
        el('button', { class: 'btn sm', onclick: () => onDraftPlayer(r.player_id) }, '選他'),
      ),
      reasonText ? el('div', { style: 'font-size: var(--fs-xs); color: var(--ink-2); line-height: 1.5;' }, reasonText) : null,
    );
    list.append(row);
  }
  card.append(list);
  return card;
}

async function refreshDraftRecos() {
  const payload = await apiSoft('/api/draft/recommendations?limit=4');
  state.draftRecos = payload || null;
  return state.draftRecos;
}

function buildAvailablePanel(d) {
  const panel = el('div', { class: 'card' });
  const modeOpts = [
    ['prev_full', '上季完整（含 FPPG）'],
    ['prev_no_fppg', '上季完整（不含 FPPG）'],
    ['current_full', '本季完整（劇透）'],
  ].map(([v, l]) => `<option value="${v}" ${state.draftDisplayMode === v ? 'selected' : ''}>${l}</option>`).join('');

  const f = state.draftFilter;
  const header = el('div', { class: 'card-header' },
    el('h3', {}, '剩餘球員'),
    el('select', {
      id: 'draft-display-mode',
      style: 'font-size: var(--fs-xs); padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface);',
      html: modeOpts,
      onchange: onDraftDisplayModeChange,
    }),
  );

  const filterBar = el('div', {
    style: 'display:flex; gap:8px; padding: var(--s-3) var(--s-4); border-bottom: 1px solid var(--line-soft); flex-wrap: wrap;',
  },
    el('input', {
      type: 'search', placeholder: '搜尋姓名 / 球隊…', value: f.q,
      style: 'flex:1; min-width: 160px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface);',
      oninput: (e) => { f.q = e.target.value; renderAvailableTable(state.draftDisplayMode); },
    }),
    el('select', {
      style: 'padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface);',
      onchange: (e) => { f.pos = e.target.value; renderAvailableTable(state.draftDisplayMode); },
      html: `
        <option value="" ${f.pos === '' ? 'selected' : ''}>所有位置</option>
        <option value="PG" ${f.pos === 'PG' ? 'selected' : ''}>PG</option>
        <option value="SG" ${f.pos === 'SG' ? 'selected' : ''}>SG</option>
        <option value="SF" ${f.pos === 'SF' ? 'selected' : ''}>SF</option>
        <option value="PF" ${f.pos === 'PF' ? 'selected' : ''}>PF</option>
        <option value="C" ${f.pos === 'C' ? 'selected' : ''}>C</option>`,
    }),
    el('select', {
      style: 'padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface);',
      onchange: (e) => { f.sort = e.target.value; renderAvailableTable(state.draftDisplayMode); },
      html: ['fppg', 'pts', 'reb', 'ast', 'stl', 'blk', 'to', 'age', 'name']
        .map((v) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>排序：${v.toUpperCase()}</option>`).join(''),
    }),
  );

  const tableWrap = el('div', { id: 'avail-table-wrap', style: 'max-height: 620px; overflow-y: auto;' });
  panel.append(header, filterBar, tableWrap);
  return panel;
}

async function onDraftDisplayModeChange(e) {
  const newMode = e.target.value;
  state.draftDisplayMode = newMode;
  renderAvailableTable(newMode);
  apiSoft('/api/league/settings', {
    method: 'POST',
    body: JSON.stringify({ draft_display_mode: newMode }),
  }).catch(() => {});
}

async function renderAvailableTable(displayMode) {
  const wrap = $('#avail-table-wrap');
  if (!wrap) return;
  const d = state.draft;
  if (!d) return;
  const mode = displayMode || state.draftDisplayMode || 'prev_full';
  const tok = state.viewToken;

  const params = new URLSearchParams({
    available: 'true',
    sort: state.draftFilter.sort,
    limit: '80',
  });
  if (state.draftFilter.q) params.set('q', state.draftFilter.q);
  if (state.draftFilter.pos) params.set('pos', state.draftFilter.pos);

  // M16: abort any prior in-flight player search so a slow earlier response
  // can't replace the freshly-typed query's results.
  abortActivePlayerSearch();
  const ctrl = new AbortController();
  state.activePlayerSearchAbort = ctrl;

  let players;
  try {
    players = await api(`/api/players?${params.toString()}`, { signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (isViewStale(tok)) return;
    wrap.innerHTML = `<div style="padding: var(--s-6); color: var(--bad);">載入失敗：${escapeHtml(e.message)}</div>`;
    return;
  } finally {
    if (state.activePlayerSearchAbort === ctrl) state.activePlayerSearchAbort = null;
  }
  if (isViewStale(tok)) return;

  const canDraft = !d.is_complete && d.current_team_id === d.human_team_id;
  wrap.innerHTML = buildAvailableTableHtml(players, mode, canDraft);
}

function buildAvailableTableHtml(players, mode, canDraft) {
  const isPrevFull = mode === 'prev_full';
  const isPrevNoFppg = mode === 'prev_no_fppg';

  let head;
  if (isPrevFull) {
    head = `<tr>
      <th>球員</th><th>位置</th><th>球隊</th>
      <th class="num">年齡</th><th class="num">上季FPPG</th><th class="num">出賽</th>
      <th></th></tr>`;
  } else if (isPrevNoFppg) {
    head = `<tr>
      <th>球員</th><th>位置</th><th>球隊</th>
      <th class="num">年齡</th><th class="num">PTS</th><th class="num">REB</th>
      <th class="num">AST</th><th class="num">STL</th><th class="num">BLK</th>
      <th class="num">TO</th><th></th></tr>`;
  } else {
    head = `<tr>
      <th>球員</th><th>位置</th><th>球隊</th>
      <th class="num">年齡</th><th class="num">FPPG</th>
      <th class="num">PTS</th><th class="num">REB</th><th class="num">AST</th>
      <th class="num">STL</th><th class="num">BLK</th><th class="num">TO</th>
      <th></th></tr>`;
  }

  if (!players.length) {
    return `<table class="standings-table"><thead>${head}</thead><tbody>
      <tr><td colspan="12" style="padding: var(--s-6); text-align:center; color: var(--ink-3);">找不到符合的球員</td></tr>
    </tbody></table>`;
  }

  const body = players.map((p) => {
    const injBadge = p.injury && p.injury.status !== 'healthy'
      ? ` <span class="pill bad" style="font-size: 12px; padding: 1px 6px;">${p.injury.status === 'out' ? 'OUT' : 'DTD'}</span>`
      : '';
    const action = `<td style="text-align:right;"><button class="btn sm" data-draft="${p.id}" ${canDraft ? '' : 'disabled'}>選秀</button></td>`;
    const nameCell = `<td><b>${escapeHtml(p.name)}</b>${injBadge}</td>`;
    const posCell = `<td><span class="pos-tag" data-pos="${escapeHtml(p.pos)}">${escapeHtml(p.pos)}</span></td>`;
    const teamCell = `<td style="color:var(--ink-3); font-family:var(--mono); font-size: var(--fs-xs);">${escapeHtml(p.team)}</td>`;
    const age = `<td class="num">${p.age}</td>`;

    if (isPrevFull) {
      const pv = p.prev_fppg != null ? p.prev_fppg : p.fppg;
      return `<tr>${nameCell}${posCell}${teamCell}${age}<td class="num"><b>${fppg(pv)}</b></td><td class="num">${p.gp ?? '-'}</td>${action}</tr>`;
    }
    if (isPrevNoFppg) {
      return `<tr>${nameCell}${posCell}${teamCell}${age}
        <td class="num">${fppg(p.pts)}</td><td class="num">${fppg(p.reb)}</td>
        <td class="num">${fppg(p.ast)}</td><td class="num">${fppg(p.stl)}</td>
        <td class="num">${fppg(p.blk)}</td><td class="num">${fppg(p.to)}</td>${action}</tr>`;
    }
    return `<tr>${nameCell}${posCell}${teamCell}${age}
      <td class="num"><b>${fppg(p.fppg)}</b></td>
      <td class="num">${fppg(p.pts)}</td><td class="num">${fppg(p.reb)}</td>
      <td class="num">${fppg(p.ast)}</td><td class="num">${fppg(p.stl)}</td>
      <td class="num">${fppg(p.blk)}</td><td class="num">${fppg(p.to)}</td>${action}</tr>`;
  }).join('');

  return `<table class="standings-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function buildBoardPanel(d) {
  const card = el('div', { class: 'card' });
  const head = el('div', { class: 'card-header' },
    el('h3', {}, '蛇形選秀板'),
    el('span', { class: 'sub' }, `${d.num_teams} × ${d.total_rounds}`),
  );

  const wrap = el('div', { style: 'overflow-x: auto; max-height: 620px; overflow-y: auto;' });
  wrap.innerHTML = buildBoardHtml(d);
  card.append(head, wrap);
  return card;
}

function buildBoardHtml(d) {
  let html = '<table class="standings-table" style="font-size: var(--fs-xs); min-width: 100%;">';
  html += '<thead><tr><th style="text-align:center;">輪</th>';
  for (const t of d.teams) {
    const mark = t.is_human ? ' *' : '';
    html += `<th style="text-align:center; min-width: 90px;">${escapeHtml(t.name)}${mark}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (let r = 0; r < d.total_rounds; r++) {
    html += `<tr><td style="text-align:center; font-family:var(--mono); color:var(--ink-3);">${r + 1}</td>`;
    for (let t = 0; t < d.num_teams; t++) {
      const cell = d.board[r][t];
      const isCurrent = !d.is_complete && d.current_round === r + 1 && d.current_team_id === t;
      const isYou = t === d.human_team_id;
      let style = 'text-align:center; padding: 6px 8px; font-size: 12px;';
      if (isCurrent) style += ' background: var(--accent-14); box-shadow: inset 0 0 0 1px var(--accent);';
      else if (isYou && !cell) style += ' background: var(--accent-08);';
      if (cell) {
        style += ' font-weight: 500;';
        html += `<td style="${style}" title="${escapeHtml(cell.reason || '')}">
          <div>${escapeHtml(cell.player_name)}</div>
          <div style="color:var(--ink-3); font-family:var(--mono); font-size: 12px;">#${cell.overall}</div>
        </td>`;
      } else {
        html += `<td style="${style}; color: var(--ink-4);">${isCurrent ? '選秀中' : '—'}</td>`;
      }
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

// ---------------------------------------------------------------- draft auto-advance
function cancelDraftAutoAdvance() {
  if (state.draftAutoTimer) {
    clearTimeout(state.draftAutoTimer);
    state.draftAutoTimer = null;
  }
  // M5: also stop the per-pick countdown so background ticks don't keep
  // running after the user picked / navigated away.
  cancelDraftClockTimer();
}

// M5 ---------------------------------------------------------------- draft clock
function cancelDraftClockTimer() {
  if (state.draftClockInterval) {
    clearInterval(state.draftClockInterval);
    state.draftClockInterval = null;
  }
  state.draftClockSec = null;
  state.draftClockTurnKey = null;
}

function startDraftClockTimer(d) {
  if (!d || d.is_complete) { cancelDraftClockTimer(); return; }
  // Only run for human turns; AI turns are paced by the auto-advance loop.
  if (d.current_team_id !== d.human_team_id) { cancelDraftClockTimer(); return; }
  const turnKey = String(d.current_overall);
  if (state.draftClockTurnKey === turnKey && state.draftClockInterval) {
    // Same turn re-render — keep existing countdown running.
    tickDraftClock();
    return;
  }
  cancelDraftClockTimer();
  state.draftClockTurnKey = turnKey;
  state.draftClockSec = 90;
  tickDraftClock();
  state.draftClockInterval = setInterval(() => {
    if (state.draftClockSec == null) return;
    state.draftClockSec -= 1;
    tickDraftClock();
    if (state.draftClockSec <= 0) {
      // Time's up — auto-pick best remaining recommendation, falling back to
      // the top fppg available player. Best-effort; failure just stops the
      // clock so the user can pick manually.
      const cur = state.draft;
      if (!cur || cur.is_complete || cur.current_team_id !== cur.human_team_id) {
        cancelDraftClockTimer();
        return;
      }
      cancelDraftClockTimer();
      autoPickOnTimeout().catch(() => {});
    }
  }, 1000);
}

function tickDraftClock() {
  const node = $('#draft-clock-readout');
  if (!node) return;
  const s = state.draftClockSec ?? 90;
  node.textContent = `${s}s`;
  let stt = 'normal';
  if (s <= 10) stt = 'critical';
  else if (s <= 30) stt = 'warn';
  node.dataset.state = stt;
}

async function autoPickOnTimeout() {
  // Prefer the top recommendation if available; otherwise grab the highest
  // fppg available player from the current draft state.
  let pid = null;
  try {
    const recos = state.draftRecos?.recos;
    if (Array.isArray(recos) && recos.length) pid = recos[0].player_id;
  } catch {}
  if (pid == null) {
    try {
      const r = await api('/api/players?available=true&sort=total_fp&limit=1');
      if (Array.isArray(r) && r.length) pid = r[0].id;
    } catch {}
  }
  if (pid == null) { toast('時間到，但找不到可選球員', 'error'); return; }
  toast('⏰ 時間到，自動選 BPA', 'info');
  await onDraftPlayer(pid);
}

function scheduleDraftAutoAdvance() {
  cancelDraftAutoAdvance();
  const d = state.draft;
  if (!d || d.is_complete) return;
  if (currentRoute() !== 'draft') return;
  if (d.current_team_id === d.human_team_id) return;
  if (state.draftAutoBusy) return;
  if (state.draftPaused) return;

  state.draftAutoTimer = setTimeout(async () => {
    state.draftAutoTimer = null;
    if (state.draftAutoBusy) return;
    const cur = state.draft;
    // Double-guard: don't fire if state flipped between schedule and timeout.
    if (!cur || cur.is_complete) return;
    if (currentRoute() !== 'draft') return;
    if (cur.current_team_id === cur.human_team_id) return;
    state.draftAutoBusy = true;
    let ok = false;
    try {
      const r = await api('/api/draft/ai-advance', { method: 'POST' });
      state.draft = r.state;
      appendDraftCommentary(r.commentary);
      ok = true;
      // If the server just completed the draft, stop the loop immediately.
      if (r.state?.is_complete) {
        cancelDraftAutoAdvance();
        maybeAutoStartSeason();
      }
    } catch (err) {
      // 409 = draft already complete on server (race with a parallel request).
      // Swallow silently; any other error: log for debugging.
      if (err?.status !== 409) console.warn('auto ai-advance failed', err);
      // Refresh state so we exit the loop next tick.
      try {
        const fresh = await api('/api/state');
        state.draft = fresh;
        if (fresh?.is_complete) cancelDraftAutoAdvance();
      } catch { /* ignore */ }
    } finally {
      state.draftAutoBusy = false;
    }
    if (ok) {
      render();
    } else {
      // Keep the loop alive even after a silent no-op or error so the draft
      // never gets stuck; render() path already re-schedules via renderDraftView.
      scheduleDraftAutoAdvance();
    }
  }, 1500);
}

// ---------------------------------------------------------------- actions
function appendDraftCommentary(commentary) {
  if (!Array.isArray(commentary) || !commentary.length) return;
  // Prepend (latest first), then trim to 10. Skip entries without text.
  const cleaned = commentary.filter((c) => c && c.text);
  if (!cleaned.length) return;
  state.draftCommentary = [...cleaned, ...(state.draftCommentary || [])].slice(0, 10);
}

async function onAdvance() {
  // M18: share the same busy flag as the auto-advance loop so the manual
  // "推進 AI 一手" button can't fire a second concurrent ai-advance request.
  if (state.draftAutoBusy) return;
  state.draftAutoBusy = true;
  try {
    const r = await api('/api/draft/ai-advance', { method: 'POST' });
    state.draft = r.state;
    appendDraftCommentary(r.commentary);
    render();
    maybeAutoStartSeason();
  } catch (e) {
    toast(e.message || '推進失敗', 'error');
  } finally {
    state.draftAutoBusy = false;
  }
}

async function onSimToMe() {
  try {
    const r = await api('/api/draft/sim-to-me', { method: 'POST' });
    state.draft = r.state;
    // sim-to-me can produce many picks — only pull commentary if backend sent any
    appendDraftCommentary(r.commentary);
    render();
    maybeAutoStartSeason();
  } catch (e) {
    toast(e.message || '模擬失敗', 'error');
  }
}

// Auto-start the season the moment the draft completes — saves the user one
// extra click. No-op if season already started (backend returns harmless error).
async function maybeAutoStartSeason() {
  if (!state.draft?.is_complete) return;
  try {
    await api('/api/season/start', { method: 'POST' });
    toast('🏁 選秀完成，賽季自動開始', 'info');
    setTimeout(() => navigate('league'), 600);
  } catch (e) {
    // already started or not allowed — silent
  }
}

async function onDraftPlayer(playerId) {
  try {
    const r = await api('/api/draft/pick', {
      method: 'POST',
      body: JSON.stringify({ player_id: playerId }),
    });
    state.draft = r.state;
    appendDraftCommentary(r.commentary);
    render();
    maybeAutoStartSeason();
  } catch (e) {
    toast(e.message || '選秀失敗', 'error');
  }
}

async function onResetDraft() {
  if (!confirm('重置選秀？所有順位將被清除。')) return;
  try {
    const r = await api('/api/draft/reset', {
      method: 'POST',
      body: JSON.stringify({ randomize_order: false }),
    });
    state.draft = r;
    toast('選秀已重置', 'info');
    render();
  } catch (e) {
    toast(e.message || '重置失敗', 'error');
  }
}

async function onStartSeason() {
  try {
    await api('/api/season/start', { method: 'POST' });
    toast('賽季已開始（Phase 3 才接賽季畫面）', 'info');
    navigate('league');
  } catch (e) {
    toast(e.message || '開始賽季失敗', 'error');
  }
}

// ================================================================ TEAMS VIEW
function injuryPillHtml(inj) {
  if (!inj || inj.status === 'healthy') return '';
  const kind = inj.status === 'out' ? 'bad' : 'warn';
  const label = inj.status === 'out' ? 'OUT' : 'DTD';
  const days = inj.return_in_days > 0 ? ` ${inj.return_in_days}d` : '';
  const title = `${label}${inj.return_in_days > 0 ? `，預計 ${inj.return_in_days} 天後復出` : ''}${inj.note ? '：' + inj.note : ''}`;
  return ` <span class="pill ${kind}" style="font-size: 12px; padding:1px 6px;" title="${escapeHtml(title)}">${label}${days}</span>`;
}

async function renderTeamsView(root) {
  // M15: guard view-token; renderTeamBody also re-checks per fetch.
  const tok = state.viewToken;
  const d = state.draft;
  if (!d || !Array.isArray(d.teams) || d.teams.length === 0) {
    root.append(el('div', { class: 'card card-pad' }, '載入隊伍資訊中…'));
    return;
  }
  if (isViewStale(tok)) return;

  // Pick default team: human team if available, else first team.
  if (state.currentTeamId == null || state.currentTeamId >= d.teams.length) {
    state.currentTeamId = (d.human_team_id != null) ? d.human_team_id : 0;
  }

  const teamSelect = el('select', {
    id: 'team-pick',
    style: 'padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); min-width: 180px;',
    onchange: (e) => {
      state.currentTeamId = parseInt(e.target.value, 10);
      // M8: clear scout if user selected same team as scout target
      if (state.teamsScoutId === state.currentTeamId) state.teamsScoutId = null;
      // Re-render whole view so scout dropdown options refresh
      root.innerHTML = '';
      renderTeamsView(root);
    },
    html: d.teams.map((t) =>
      `<option value="${t.id}" ${t.id === state.currentTeamId ? 'selected' : ''}>${escapeHtml(t.name)}${t.is_human ? ' (你)' : ''}</option>`
    ).join(''),
  });

  // M8: opponent scouting dropdown — exclude self
  const scoutOptions = ['<option value="">看對手 (不顯示)</option>']
    .concat(d.teams
      .filter((t) => t.id !== state.currentTeamId)
      .map((t) =>
        `<option value="${t.id}" ${t.id === state.teamsScoutId ? 'selected' : ''}>${escapeHtml(t.name)}${t.is_human ? ' (你)' : ''}</option>`)
    ).join('');
  const scoutSelect = el('select', {
    id: 'team-scout-pick',
    style: 'padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); min-width: 180px; margin-left: var(--s-2);',
    onchange: (e) => {
      const v = e.target.value;
      state.teamsScoutId = v === '' ? null : parseInt(v, 10);
      renderScoutBody();
    },
    html: scoutOptions,
  });

  const head = el('div', { class: 'view-head' },
    el('div', { class: 'view-title-block' },
      el('span', { class: 'eyebrow' }, '隊伍'),
      el('div', { class: 'view-title' }, '球員名單'),
      el('div', { class: 'view-sub' }, '切換隊伍檢視名單、先發與板凳'),
    ),
    el('div', { class: 'view-actions' }, teamSelect, scoutSelect),
  );
  root.append(head);
  root.append(el('div', { id: 'team-body' }));
  root.append(el('div', { id: 'team-scout-body' }));
  renderTeamBody();
  renderScoutBody();
}

// M8: render opponent scouting card. Shows roster + projected weekly FPPG
// (sum of starters_per_day FPPG, prorated to 7 days). Empty when no scout selected.
async function renderScoutBody() {
  const container = $('#team-scout-body');
  if (!container) return;
  const sid = state.teamsScoutId;
  if (sid == null) { container.innerHTML = ''; return; }
  const tok = state.viewToken;
  container.innerHTML = '<div class="card card-pad" aria-busy="true">載入對手中…</div>';
  let data;
  try {
    data = await api(`/api/teams/${sid}`);
  } catch (e) {
    if (isViewStale(tok) || state.teamsScoutId !== sid) return;
    container.innerHTML = `<div class="card card-pad" style="color:var(--bad);">對手載入失敗：${escapeHtml(e.message)}</div>`;
    return;
  }
  if (isViewStale(tok) || state.teamsScoutId !== sid) return;

  const { team, players, totals, lineup_slots, bench, injured_out, injuries, persona_desc } = data;
  const playerById = new Map(players.map((p) => [p.id, p]));
  const injSet = new Set(injured_out || []);
  const injuriesMap = injuries || {};

  // Projected weekly FPPG: starters total FPPG * 7 days (matches league semantic).
  // totals.fppg is daily starters total; we present both daily + weekly so users
  // can compare at a glance.
  const dailyFppg = (totals && typeof totals.fppg === 'number') ? totals.fppg : 0;
  const weeklyFppg = dailyFppg * 7;

  const seasonStarted = !!(state.draft && state.draft.is_complete);
  const slotsPopulated = Array.isArray(lineup_slots) && lineup_slots.some((s) => s && s.player_id != null);

  const card = el('div', { class: 'card', style: 'margin-top: var(--s-3);' });
  const gmName = team.gm_persona ? (state.personas?.[team.gm_persona]?.name || team.gm_persona) : null;
  const win = team.wins != null ? team.wins : (team.record?.wins ?? null);
  const loss = team.losses != null ? team.losses : (team.record?.losses ?? null);
  const recordStr = (win != null && loss != null) ? `${win}-${loss}` : null;

  const head = el('div', { class: 'card-header' },
    el('h3', {}, `對手偵察：${team.name}`),
    el('span', { class: 'sub' }, '預期下週總 FPPG = 先發每日 FPPG × 7'),
  );
  const summary = el('div', { class: 'card-pad' });
  summary.innerHTML = `
    <div style="display:flex; align-items:center; gap: var(--s-3); flex-wrap:wrap; margin-bottom: var(--s-3);">
      <span style="font-size: var(--fs-md); font-weight: 600;">${escapeHtml(team.name)}</span>
      ${gmName ? `<span style="color:var(--ink-3); font-size: var(--fs-sm);">GM：${escapeHtml(gmName)}</span>` : ''}
      ${recordStr ? `<span class="pill" style="font-size: 12px;">W-L ${recordStr}</span>` : ''}
    </div>
    ${persona_desc ? `<div style="color:var(--ink-2); font-size: var(--fs-sm); margin-bottom: var(--s-3);">${escapeHtml(persona_desc)}</div>` : ''}
    <div style="display:flex; gap: var(--s-5); flex-wrap:wrap; color:var(--ink-2); font-size: var(--fs-sm);">
      <span>先發每日 FPPG <b style="color:var(--ink);">${fppg(dailyFppg)}</b></span>
      <span>預期下週總 FPPG <b style="color:var(--good);">${fppg(weeklyFppg)}</b></span>
    </div>
  `;

  const rosterWrap = el('div', { id: 'scout-roster-wrap' });
  if (seasonStarted && slotsPopulated) {
    rosterWrap.innerHTML = buildYahooRosterHtml({
      lineup_slots: lineup_slots || [],
      bench: bench || [],
      playerById,
      injSet,
      injuriesMap,
      totals,
    });
  } else {
    rosterWrap.innerHTML = `<div style="padding: var(--s-5); color:var(--ink-3);">${seasonStarted ? '對手名單尚未排入先發。' : '選秀尚未完成。'}</div>`;
  }
  card.append(head, summary, rosterWrap);

  container.innerHTML = '';
  container.append(card);
}

async function renderTeamBody() {
  const container = $('#team-body');
  if (!container) return;
  const tid = state.currentTeamId;
  const tok = state.viewToken;
  container.innerHTML = '<div class="card card-pad" aria-busy="true">載入中…</div>';

  // M17: abort previous in-flight team fetch so its later response can't
  // overwrite the freshly-selected team's render.
  abortActiveTeamFetch();
  const ctrl = new AbortController();
  state.activeTeamFetchAbort = ctrl;

  let data;
  try {
    data = await api(`/api/teams/${tid}`, { signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (isViewStale(tok) || state.currentTeamId !== tid) return;
    container.innerHTML = `<div class="card card-pad" style="color:var(--bad);">載入失敗：${escapeHtml(e.message)}</div>`;
    return;
  } finally {
    if (state.activeTeamFetchAbort === ctrl) state.activeTeamFetchAbort = null;
  }
  // Drop stale response if the user already switched teams or routes.
  if (isViewStale(tok) || state.currentTeamId !== tid) return;
  state.teamView = data;

  const { team, players, totals, persona_desc, lineup_slots, bench, injured_out, injuries, has_lineup_override } = data;
  const isHuman = !!team.is_human;
  const playerById = new Map(players.map((p) => [p.id, p]));
  const injSet = new Set(injured_out || []);
  const injuriesMap = injuries || {};

  const seasonStarted = !!(state.draft && state.draft.is_complete);
  const slotsPopulated = Array.isArray(lineup_slots) && lineup_slots.some((s) => s && s.player_id != null);

  // Summary card
  const gmName = team.gm_persona ? (state.personas?.[team.gm_persona]?.name || team.gm_persona) : null;
  const win = team.wins != null ? team.wins : (team.record?.wins ?? null);
  const loss = team.losses != null ? team.losses : (team.record?.losses ?? null);
  const recordStr = (win != null && loss != null) ? `${win}-${loss}` : null;
  const overrideBadge = has_lineup_override
    ? '<span class="pill warn" style="font-size: 12px;" title="手動設定陣容">手動陣容</span>'
    : '<span class="pill" style="font-size: 12px;" title="自動最佳化">自動陣容</span>';

  const summary = el('div', { class: 'card card-pad' });
  summary.innerHTML = `
    <div style="display:flex; align-items:center; gap: var(--s-3); flex-wrap:wrap; margin-bottom: var(--s-3);">
      <span style="font-size: var(--fs-lg); font-weight: 600;">${escapeHtml(team.name)}</span>
      ${isHuman ? '<span class="pill accent" style="font-size: 12px;">你</span>' : ''}
      ${isHuman && seasonStarted ? overrideBadge : ''}
      ${gmName ? `<span style="color:var(--ink-3); font-size: var(--fs-sm);">GM：${escapeHtml(gmName)}</span>` : ''}
      ${recordStr ? `<span class="pill" style="font-size: 12px;">W-L ${recordStr}</span>` : ''}
    </div>
    ${persona_desc ? `<div style="color:var(--ink-2); font-size: var(--fs-sm); margin-bottom: var(--s-3);">${escapeHtml(persona_desc)}</div>` : ''}
    <div style="display:flex; gap: var(--s-5); flex-wrap:wrap; color:var(--ink-2); font-size: var(--fs-sm);">
      <span>FPPG 總計 <b style="color:var(--ink);">${fppg(totals?.fppg)}</b></span>
      <span>PTS <b style="color:var(--ink);">${fmtStat(totals?.pts)}</b></span>
      <span>REB <b style="color:var(--ink);">${fmtStat(totals?.reb)}</b></span>
      <span>AST <b style="color:var(--ink);">${fmtStat(totals?.ast)}</b></span>
    </div>
  `;

  const blocks = [summary];

  // Not-started hint
  if (!seasonStarted) {
    blocks.push(el('div', { class: 'card card-pad', style: 'color: var(--ink-3);' },
      '選秀尚未完成，等選秀結束後才能設定先發陣容。'
    ));
  }

  // Yahoo-style unified roster table: PG/SG/G/SF/PF/F/C/C/Util/Util/BN/BN/BN
  const rosterCard = el('div', { class: 'card' });
  const rosterHeader = el('div', { class: 'card-header' },
    el('h3', {}, '球員名單'),
    el('span', { class: 'sub' }, seasonStarted ? '先發 + 板凳（Yahoo 格式）' : '選秀完成後可用'),
  );
  const rosterWrap = el('div', { id: 'roster-wrap' });

  if (seasonStarted && slotsPopulated) {
    rosterWrap.innerHTML = buildYahooRosterHtml({
      lineup_slots: lineup_slots || [],
      bench: bench || [],
      playerById,
      injSet,
      injuriesMap,
      totals,
    });
  } else {
    rosterWrap.innerHTML = `<div style="padding: var(--s-5); color:var(--ink-3);">${seasonStarted ? '名單中沒有可排入的先發球員。' : '選秀尚未完成。'}</div>`;
  }

  // Lineup actions (human only, season started)
  if (isHuman && seasonStarted && slotsPopulated) {
    const actions = el('div', { style: 'display:flex; gap: var(--s-2); padding: var(--s-3) var(--s-4); border-top: 1px solid var(--line-soft); justify-content: flex-end;' });
    if (has_lineup_override) {
      actions.append(el('button', {
        class: 'btn ghost sm',
        onclick: async () => {
          try {
            await api(`/api/season/lineup/${team.id}`, { method: 'DELETE' });
            toast('已恢復自動陣容', 'info');
            renderTeamBody();
          } catch (e) { toast(e.message || '清除失敗', 'error'); }
        },
      }, '恢復自動陣容'));
    }
    actions.append(el('button', {
      class: 'btn sm',
      onclick: () => openLineupModal(data),
    }, '設定先發陣容'));
    rosterCard.append(rosterHeader, rosterWrap, actions);
  } else {
    rosterCard.append(rosterHeader, rosterWrap);
  }
  blocks.push(rosterCard);

  if (players.length === 0) {
    blocks.push(el('div', { class: 'card card-pad', style: 'color: var(--ink-3);' }, '尚未選入任何球員。'));
  }

  container.innerHTML = '';
  container.append(...blocks);
}

// Yahoo-style roster table: fixed 13-row slot layout (PG/SG/G/SF/PF/F/C/C/Util/Util/BN/BN/BN)
// with Pos | Players | Opp | Fan Pts | Rank | %Start | %Ros | PTS | REB | AST | ST | BLK | TO
function buildYahooRosterHtml({ lineup_slots, bench, playerById, injSet, injuriesMap, totals }) {
  // Canonical Yahoo slot order (13 rows). Desired: PG SG G SF PF F C C Util Util BN BN BN
  // Our backend emits LINEUP_SLOTS (10 starters). We re-label trailing slots to match the spec.
  const SLOT_ORDER = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'C', 'Util', 'Util'];

  // Map starters into the canonical order. Backend slots may use 'UTIL' — normalize.
  const normalized = (lineup_slots || []).map((s) => ({
    slot: (s.slot || '').toUpperCase() === 'UTIL' ? 'Util' : (s.slot || ''),
    player_id: s.player_id,
  }));

  // Produce rows in canonical order by greedy slot-match against the backend list
  const starterRows = [];
  const used = new Set();
  for (const want of SLOT_ORDER) {
    const idx = normalized.findIndex((s, i) =>
      !used.has(i) && s.slot.toUpperCase() === want.toUpperCase(),
    );
    if (idx >= 0) {
      used.add(idx);
      starterRows.push({ slot: want, player_id: normalized[idx].player_id });
    } else {
      starterRows.push({ slot: want, player_id: null });
    }
  }

  // Bench: 3 BN slots
  const benchPlayers = (bench || []).map((id) => playerById.get(id)).filter(Boolean);
  const benchRows = [];
  for (let i = 0; i < 3; i++) {
    benchRows.push({ slot: 'BN', player_id: benchPlayers[i] ? benchPlayers[i].id : null });
  }

  const allRows = [...starterRows, ...benchRows];

  const rowsHtml = allRows.map((r) => rowHtml(r, playerById, injSet, injuriesMap)).join('');

  // Totals row: starters only (Yahoo shows starter totals at bottom)
  const t = totals || {};
  const totalsHtml = `<tr class="yahoo-totals">
    <td colspan="2"><b>合計（先發）</b></td>
    <td class="yahoo-dash">-</td>
    <td class="num"><b>${fppg(t.fppg)}</b></td>
    <td class="yahoo-dash">-</td>
    <td class="yahoo-dash">-</td>
    <td class="yahoo-dash">-</td>
    <td class="num">${fmtStat(t.pts)}</td>
    <td class="num">${fmtStat(t.reb)}</td>
    <td class="num">${fmtStat(t.ast)}</td>
    <td class="num">${fmtStat(t.stl)}</td>
    <td class="num">${fmtStat(t.blk)}</td>
    <td class="num">${fmtStat(t.to)}</td>
  </tr>`;

  return `<div class="yahoo-roster-wrap"><table class="yahoo-roster-table">
    <thead><tr>
      <th>Pos</th><th>Players</th><th>Opp</th><th class="num">Fan Pts</th>
      <th class="num">Rank</th><th class="num">% Start</th><th class="num">% Ros</th>
      <th class="num">PTS</th><th class="num">REB</th><th class="num">AST</th>
      <th class="num">ST</th><th class="num">BLK</th><th class="num">TO</th>
    </tr></thead>
    <tbody>${rowsHtml}${totalsHtml}</tbody>
  </table></div>`;
}

function rowHtml(r, playerById, injSet, injuriesMap) {
  const p = r.player_id != null ? playerById.get(r.player_id) : null;
  const slotTag = `<span class="pos-tag" data-pos="${escapeHtml(r.slot)}">${escapeHtml(r.slot)}</span>`;
  if (!p) {
    return `<tr class="yahoo-empty">
      <td>${slotTag}</td>
      <td class="yahoo-empty-cell">(Empty)</td>
      <td class="yahoo-dash">-</td>
      <td class="yahoo-dash">-</td>
      <td class="yahoo-dash">-</td>
      <td class="yahoo-dash">-</td>
      <td class="yahoo-dash">-</td>
      <td class="yahoo-dash">-</td>
      <td class="yahoo-dash">-</td>
      <td class="yahoo-dash">-</td>
      <td class="yahoo-dash">-</td>
      <td class="yahoo-dash">-</td>
      <td class="yahoo-dash">-</td>
    </tr>`;
  }
  const injured = injSet.has(p.id);
  const injObj = injuriesMap[p.id];
  let injBadge = '';
  if (injObj) {
    const status = (injObj.status || 'INJ').toUpperCase();
    const days = (injObj.return_in_days != null && injObj.return_in_days > 0)
      ? `預計 ${injObj.return_in_days} 天回歸` : '回歸時間未定';
    const noteSuffix = injObj.note ? `，備註：${injObj.note}` : '';
    const tip = `狀態 ${status}，${days}${noteSuffix}`;
    injBadge = ` <span class="inj-badge" data-inj-tip="${escapeHtml(tip)}" title="${escapeHtml(tip)}" tabindex="0">${escapeHtml(status)}${injObj.return_in_days > 0 ? ` ${injObj.return_in_days}d` : ''}</span>`;
  }
  const posLabel = `${escapeHtml(p.team || '')} - ${escapeHtml(p.pos || '')}`;
  return `<tr class="${injured ? 'yahoo-injured' : ''}">
    <td>${slotTag}</td>
    <td class="yahoo-player-cell">
      <div class="yahoo-player-name"><b>${escapeHtml(p.name)}</b>${injBadge}</div>
      <div class="yahoo-player-meta">${posLabel}</div>
    </td>
    <td class="yahoo-dash">-</td>
    <td class="num"><b>${fppg(p.fppg)}</b></td>
    <td class="yahoo-dash">-</td>
    <td class="yahoo-dash">-</td>
    <td class="yahoo-dash">-</td>
    <td class="num">${fmtStat(p.pts)}</td>
    <td class="num">${fmtStat(p.reb)}</td>
    <td class="num">${fmtStat(p.ast)}</td>
    <td class="num">${fmtStat(p.stl)}</td>
    <td class="num">${fmtStat(p.blk)}</td>
    <td class="num">${fmtStat(p.to)}</td>
  </tr>`;
}

// Lineup override modal: tap-to-swap interaction (mobile-friendly).
// Two zones: 10 starter slots (PG/SG/G/SF/PF/F/C/C/UTIL/UTIL) + bench candidates.
// Tap one cell -> highlight; tap second cell -> swap player_ids between them.
// Backend (/api/season/lineup) re-runs assign_slots greedily, so the position
// of a starter in `starters[]` does not affect final slot assignment, but the
// swap UI lets the user move a bench player into the starting 10 in one tap.
function openLineupModal(data) {
  const { team, players, lineup_slots, bench, injured_out } = data;
  const injSet = new Set(injured_out || []);
  const STARTER_SLOTS = ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C', 'C', 'UTIL', 'UTIL'];
  const targetCount = (lineup_slots || []).length || STARTER_SLOTS.length;
  const playerById = new Map(players.map((p) => [p.id, p]));

  // Build starter rows in canonical SLOT order (greedy match against backend slots).
  const backendSlots = (lineup_slots || []).map((s) => ({
    slot: (s.slot || '').toUpperCase(),
    player_id: s.player_id,
  }));
  const starterRows = [];
  const usedIdx = new Set();
  for (const want of STARTER_SLOTS) {
    const idx = backendSlots.findIndex((s, i) => !usedIdx.has(i) && s.slot === want);
    if (idx >= 0) { usedIdx.add(idx); starterRows.push({ slot: want, player_id: backendSlots[idx].player_id }); }
    else { starterRows.push({ slot: want, player_id: null }); }
  }

  // Bench = roster pids not currently in any starter slot. Preserve backend `bench`
  // order if provided, otherwise derive from players.
  const starterIds = new Set(starterRows.map((r) => r.player_id).filter((id) => id != null));
  const benchIds = (bench && bench.length)
    ? bench.filter((id) => !starterIds.has(id))
    : players.map((p) => p.id).filter((id) => !starterIds.has(id));
  const benchRows = benchIds.map((id) => ({ slot: 'BN', player_id: id }));

  // Selection cursor: first tap stores {zone:'s'|'b', index}; second tap performs swap.
  let firstPick = null;

  const overlay = el('div', {
    id: 'lineup-overlay',
    style: 'position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:1000; display:flex; align-items:center; justify-content:center; padding: var(--s-5);',
  });
  overlay.innerHTML = `
    <div class="card" style="max-width: 720px; width:100%; max-height: 90vh; display:flex; flex-direction:column;">
      <div class="card-header">
        <h3>設定先發陣容（點兩個位置交換）</h3>
        <button class="btn ghost sm" id="btn-close-lineup">✕</button>
      </div>
      <div style="padding: var(--s-3) var(--s-4); color:var(--ink-2); font-size: var(--fs-sm); border-bottom: 1px solid var(--line-soft);">
        提示：點第 1 格 → 高亮；再點第 2 格 → 兩位球員互換。傷兵會以紅字標示。
      </div>
      <div style="overflow:auto; flex:1; padding: var(--s-3) var(--s-4);">
        <div class="lineup-section-title" style="font-weight:600; color:var(--ink-2); margin-bottom: var(--s-2);">先發（10 人）</div>
        <div id="lineup-starters" class="lineup-grid"></div>
        <div class="lineup-section-title" style="font-weight:600; color:var(--ink-2); margin: var(--s-4) 0 var(--s-2);">板凳</div>
        <div id="lineup-bench" class="lineup-grid"></div>
      </div>
      <div style="padding: var(--s-3) var(--s-4); display:flex; gap: var(--s-2); justify-content: flex-end; border-top: 1px solid var(--line-soft);">
        <button class="btn ghost sm" id="btn-auto-lineup">一鍵最佳</button>
        <button class="btn ghost sm" id="btn-cancel-lineup">取消</button>
        <button class="btn sm" id="btn-save-lineup">儲存先發</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  $('#btn-close-lineup').addEventListener('click', close);
  $('#btn-cancel-lineup').addEventListener('click', close);

  function cellHtml(zone, index, row) {
    const p = row.player_id != null ? playerById.get(row.player_id) : null;
    const injured = p && injSet.has(p.id);
    const slotLabel = row.slot === 'UTIL' ? 'Util' : row.slot;
    if (!p) {
      return `<button type="button" class="lineup-cell empty" data-zone="${zone}" data-idx="${index}">
        <span class="lc-slot"><span class="pos-tag" data-pos="${escapeHtml(slotLabel)}">${escapeHtml(slotLabel)}</span></span>
        <span class="lc-name" style="color:var(--ink-3);">(空)</span>
        <span class="lc-fppg">—</span>
      </button>`;
    }
    return `<button type="button" class="lineup-cell ${injured ? 'injured' : ''}" data-zone="${zone}" data-idx="${index}">
      <span class="lc-slot"><span class="pos-tag" data-pos="${escapeHtml(slotLabel)}">${escapeHtml(slotLabel)}</span></span>
      <span class="lc-name"><b style="${injured ? 'color:var(--danger);' : ''}">${escapeHtml(p.name)}</b>
        <span style="color:var(--ink-3); font-size: var(--fs-xs);"> ${escapeHtml(p.pos || '')} · ${escapeHtml(p.team || '')}</span></span>
      <span class="lc-fppg"><b>${fppg(p.fppg)}</b></span>
    </button>`;
  }

  function render() {
    const sWrap = $('#lineup-starters');
    const bWrap = $('#lineup-bench');
    if (sWrap) sWrap.innerHTML = starterRows.map((r, i) => cellHtml('s', i, r)).join('');
    if (bWrap) {
      bWrap.innerHTML = benchRows.length
        ? benchRows.map((r, i) => cellHtml('b', i, r)).join('')
        : '<div style="color:var(--ink-3); font-size: var(--fs-sm);">沒有板凳球員。</div>';
    }
    overlay.querySelectorAll('.lineup-cell').forEach((btn) => {
      btn.addEventListener('click', () => onCellClick(btn));
    });
    if (firstPick) {
      const sel = overlay.querySelector(`.lineup-cell[data-zone="${firstPick.zone}"][data-idx="${firstPick.index}"]`);
      if (sel) sel.classList.add('selected');
    }
  }

  function onCellClick(btn) {
    const zone = btn.dataset.zone;
    const index = Number(btn.dataset.idx);
    if (!firstPick) {
      firstPick = { zone, index };
      overlay.querySelectorAll('.lineup-cell.selected').forEach((el) => el.classList.remove('selected'));
      btn.classList.add('selected');
      return;
    }
    // Same cell tapped twice -> deselect.
    if (firstPick.zone === zone && firstPick.index === index) {
      firstPick = null;
      btn.classList.remove('selected');
      return;
    }
    // Perform swap of player_ids between the two cells.
    const a = firstPick.zone === 's' ? starterRows[firstPick.index] : benchRows[firstPick.index];
    const b = zone === 's' ? starterRows[index] : benchRows[index];
    const tmp = a.player_id;
    a.player_id = b.player_id;
    b.player_id = tmp;
    // If a bench slot ends up empty after a swap, drop it (keep bench compact).
    for (let i = benchRows.length - 1; i >= 0; i--) {
      if (benchRows[i].player_id == null) benchRows.splice(i, 1);
    }
    firstPick = null;
    render();
  }

  render();

  $('#btn-auto-lineup').addEventListener('click', () => {
    // FPPG-greedy: pick top targetCount healthy players, drop into starter rows in order.
    const candidates = players
      .filter((p) => !injSet.has(p.id))
      .sort((a, b) => (b.fppg || 0) - (a.fppg || 0));
    const top = candidates.slice(0, targetCount).map((p) => p.id);
    for (let i = 0; i < starterRows.length; i++) {
      starterRows[i].player_id = top[i] != null ? top[i] : null;
    }
    const topSet = new Set(top);
    const newBench = players.map((p) => p.id).filter((id) => !topSet.has(id));
    benchRows.length = 0;
    for (const id of newBench) benchRows.push({ slot: 'BN', player_id: id });
    firstPick = null;
    render();
    toast('已套用 FPPG 最佳陣容', 'info');
  });

  $('#btn-save-lineup').addEventListener('click', async () => {
    const starters = starterRows.map((r) => r.player_id).filter((id) => id != null);
    if (starters.length !== targetCount) {
      toast(`請選滿 ${targetCount} 名先發（目前 ${starters.length} 人）`, 'error');
      return;
    }
    try {
      await api('/api/season/lineup', {
        method: 'POST',
        body: JSON.stringify({ team_id: team.id, starters, today_only: false }),
      });
      toast('先發陣容已儲存', 'info');
      close();
      renderTeamBody();
    } catch (e) {
      toast(e.message || '儲存失敗', 'error');
    }
  });
}

// ================================================================ FREE AGENTS VIEW
async function renderFaView(root) {
  const d = state.draft;
  const seasonStarted = !!(d && d.is_complete);

  const head = el('div', { class: 'view-head' },
    el('div', { class: 'view-title-block' },
      el('span', { class: 'eyebrow' }, '自由球員'),
      el('div', { class: 'view-title' }, 'FA 名單'),
      el('div', { class: 'view-sub' }, '簽入想要的球員並釋出一位替換'),
    ),
    el('div', { class: 'view-actions' },
      el('div', { id: 'fa-quota-box', class: 'pill', style: 'font-size: 12px;' }, '—'),
    ),
  );
  root.append(head);

  if (!seasonStarted) {
    root.append(el('div', { class: 'card card-pad', style: 'color:var(--ink-3);' },
      '等賽季開始才能簽 FA。請先完成選秀並啟動賽季。'));
    return;
  }

  // Filter bar + table panel
  const f = state.faFilter;
  const filterBar = el('div', {
    style: 'display:flex; gap:8px; padding: var(--s-3) var(--s-4); border-bottom: 1px solid var(--line-soft); flex-wrap: wrap;',
  },
    el('input', {
      type: 'search', placeholder: '搜尋姓名 / 球隊…', value: f.q,
      style: 'flex:1; min-width: 160px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface);',
      oninput: (e) => { f.q = e.target.value; renderFaTable(); },
    }),
    el('select', {
      style: 'padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface);',
      onchange: (e) => { f.pos = e.target.value; renderFaTable(); },
      html: `
        <option value="" ${f.pos === '' ? 'selected' : ''}>所有位置</option>
        <option value="PG" ${f.pos === 'PG' ? 'selected' : ''}>PG</option>
        <option value="SG" ${f.pos === 'SG' ? 'selected' : ''}>SG</option>
        <option value="SF" ${f.pos === 'SF' ? 'selected' : ''}>SF</option>
        <option value="PF" ${f.pos === 'PF' ? 'selected' : ''}>PF</option>
        <option value="C" ${f.pos === 'C' ? 'selected' : ''}>C</option>`,
    }),
    el('select', {
      style: 'padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface);',
      onchange: (e) => { f.sort = e.target.value; renderFaTable(); },
      html: `
        <option value="fppg" ${f.sort === 'fppg' ? 'selected' : ''}>排序：FPPG</option>
        <option value="name" ${f.sort === 'name' ? 'selected' : ''}>排序：姓名</option>
        <option value="pos"  ${f.sort === 'pos'  ? 'selected' : ''}>排序：位置</option>`,
    }),
  );

  const panel = el('div', { class: 'card' });
  const header = el('div', { class: 'card-header' },
    el('h3', {}, '可簽球員'),
    el('span', { class: 'sub', id: 'fa-count' }, '載入中…'),
  );
  const tableWrap = el('div', { id: 'fa-table-wrap', style: 'max-height: 640px; overflow-y: auto;' });
  panel.append(header, filterBar, tableWrap);
  root.append(panel);

  refreshFaQuota();
  renderFaTable();
}

async function refreshFaQuota() {
  const box = $('#fa-quota-box');
  if (!box) return;
  try {
    const q = await api('/api/fa/claim-status');
    state.faQuota = q;
    const remaining = q.remaining ?? ((q.limit ?? 3) - (q.used_today ?? 0));
    box.textContent = `今日可簽 ${remaining} / ${q.limit ?? 3}`;
  } catch {
    box.textContent = '賽季尚未開始';
  }
}

async function renderFaTable() {
  const wrap = $('#fa-table-wrap');
  const countEl = $('#fa-count');
  if (!wrap) return;
  const f = state.faFilter;
  const tok = state.viewToken;

  // Note: we do NOT send `pos` query. Backend strict-matches, but UI needs
  // multi-position matching (e.g. "PG/SG" player should match PG filter).
  // We pull a wider pool and filter client-side.
  const params = new URLSearchParams({ available: 'true', limit: '400' });
  if (f.q) params.set('q', f.q);

  // M16: abort prior in-flight FA search so old responses don't paint over
  // the latest keystroke's results.
  abortActiveFaSearch();
  const ctrl = new AbortController();
  state.activeFaSearchAbort = ctrl;

  let players;
  try {
    players = await api(`/api/players?${params.toString()}`, { signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (isViewStale(tok)) return;
    wrap.innerHTML = `<div style="padding: var(--s-6); color:var(--bad);">載入失敗：${escapeHtml(e.message)}</div>`;
    return;
  } finally {
    if (state.activeFaSearchAbort === ctrl) state.activeFaSearchAbort = null;
  }
  if (isViewStale(tok)) return;

  // Client-side multi-position filter
  if (f.pos) {
    players = players.filter((p) => {
      const parts = String(p.pos || '').split('/').map((s) => s.trim()).filter(Boolean);
      return parts.includes(f.pos);
    });
  }

  // Client-side sort (fppg desc / name asc / pos asc)
  if (f.sort === 'name') {
    players.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  } else if (f.sort === 'pos') {
    players.sort((a, b) => String(a.pos || '').localeCompare(String(b.pos || '')) || (b.fppg || 0) - (a.fppg || 0));
  } else {
    players.sort((a, b) => (b.fppg || 0) - (a.fppg || 0));
  }

  // Cache for drop-select later
  for (const p of players) state.playerCache.set(p.id, p);

  if (countEl) countEl.textContent = `${players.length} 位`;

  if (!players.length) {
    wrap.innerHTML = `<div style="padding: var(--s-6); text-align:center; color:var(--ink-3);">找不到符合的球員</div>`;
    return;
  }

  const canSign = !!(state.draft && state.draft.is_complete);
  const body = players.map((p) => {
    const injBadge = p.injury && p.injury.status !== 'healthy'
      ? ` <span class="pill bad" style="font-size: 12px; padding:1px 6px;">${p.injury.status === 'out' ? 'OUT' : 'DTD'}</span>`
      : '';
    return `<tr>
      <td><b>${escapeHtml(p.name)}</b>${injBadge}</td>
      <td><span class="pos-tag" data-pos="${escapeHtml(p.pos)}">${escapeHtml(p.pos)}</span></td>
      <td style="color:var(--ink-3); font-family:var(--mono); font-size: var(--fs-xs);">${escapeHtml(p.team)}</td>
      <td class="num">${p.age ?? '-'}</td>
      <td class="num"><b>${fppg(p.fppg)}</b></td>
      <td class="num">${fppg(p.pts)}</td>
      <td class="num">${fppg(p.reb)}</td>
      <td class="num">${fppg(p.ast)}</td>
      <td style="text-align:right;"><button class="btn sm" data-fa-sign="${p.id}" ${canSign ? '' : 'disabled'}>簽約</button></td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `<table class="standings-table">
    <thead><tr>
      <th>球員</th><th>位置</th><th>球隊</th>
      <th class="num">年齡</th><th class="num">FPPG</th>
      <th class="num">PTS</th><th class="num">REB</th><th class="num">AST</th>
      <th></th>
    </tr></thead>
    <tbody>${body}</tbody></table>`;

  wrap.querySelectorAll('button[data-fa-sign]').forEach((btn) => {
    btn.addEventListener('click', () => onOpenSignDialog(Number(btn.dataset.faSign)));
  });
}

async function onOpenSignDialog(addPlayerId) {
  const d = state.draft;
  const humanId = d?.human_team_id;
  if (humanId == null) { toast('找不到你的隊伍', 'error'); return; }

  let teamData;
  try {
    teamData = await api(`/api/teams/${humanId}`);
  } catch {
    toast('無法載入你的陣容', 'error');
    return;
  }
  const addPlayer = state.playerCache.get(addPlayerId);
  if (!addPlayer) { toast('找不到此球員', 'error'); return; }

  const roster = Array.isArray(teamData.players) ? teamData.players : [];
  if (!roster.length) { toast('陣容是空的，無法交換', 'error'); return; }

  const picked = await pickDropDialog(addPlayer, roster);
  if (picked == null) return;

  try {
    const r = await api('/api/fa/claim', {
      method: 'POST',
      body: JSON.stringify({ add_player_id: addPlayerId, drop_player_id: picked }),
    });
    toast(`✅ 簽入 ${r.add ?? addPlayer.name}，釋出 ${r.drop ?? ''}${r.remaining != null ? `（今日剩餘 ${r.remaining}）` : ''}`, 'info');
    await refreshFaQuota();
    await renderFaTable();
  } catch (e) {
    toast(e.message || '簽約失敗', 'error');
  }
}

function pickDropDialog(addPlayer, roster) {
  return new Promise((resolve) => {
    const sorted = roster.slice().sort((a, b) => (a.fppg || 0) - (b.fppg || 0));
    const rowsHtml = sorted.map((p, i) => `
      <label style="display:flex; align-items:center; gap:8px; padding:8px 10px; border:1px solid var(--line-soft); border-radius:6px; margin-bottom:6px; cursor:pointer; ${i === 0 ? 'background:var(--accent-08);' : ''}">
        <input type="radio" name="fa-drop-pid" value="${p.id}" ${i === 0 ? 'checked' : ''}>
        <span style="flex:1;"><b>${escapeHtml(p.name)}</b> <span class="pos-tag" data-pos="${escapeHtml(p.pos || '')}" style="margin-left:6px;">${escapeHtml(p.pos || '')}</span></span>
        <span style="color:var(--ink-3); font-family:var(--mono); font-size: var(--fs-xs);">FPPG ${fppg(p.fppg)}</span>
        ${i === 0 ? '<span class="pill accent" style="font-size: 12px;">建議</span>' : ''}
      </label>
    `).join('');

    const overlay = el('div', {
      id: 'fa-sign-overlay',
      style: 'position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:1000; display:flex; align-items:center; justify-content:center; padding: var(--s-5);',
    });
    overlay.innerHTML = `
      <div class="card" style="max-width: 560px; width:100%; max-height: 85vh; display:flex; flex-direction:column;">
        <div class="card-header">
          <h3>簽約自由球員</h3>
          <button class="btn ghost sm" id="btn-close-fa">✕</button>
        </div>
        <div style="padding: var(--s-4); border-bottom: 1px solid var(--line-soft);">
          簽入：<b>${escapeHtml(addPlayer.name)}</b>
          <span class="pos-tag" data-pos="${escapeHtml(addPlayer.pos || '')}" style="margin-left:6px;">${escapeHtml(addPlayer.pos || '')}</span>
          <span style="color:var(--ink-3); margin-left:8px;">FPPG ${fppg(addPlayer.fppg)}</span>
        </div>
        <div style="padding: var(--s-3) var(--s-4); color:var(--ink-2); font-size: var(--fs-sm);">
          選擇一位要釋出的球員（已預選 FPPG 最低者）：
        </div>
        <div style="overflow:auto; flex:1; padding: 0 var(--s-4) var(--s-3);">
          ${rowsHtml}
        </div>
        <div style="padding: var(--s-3) var(--s-4); display:flex; gap: var(--s-2); justify-content: flex-end; border-top: 1px solid var(--line-soft);">
          <button class="btn ghost sm" id="btn-cancel-fa">取消</button>
          <button class="btn sm" id="btn-confirm-fa">確認簽約</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const done = (val) => { overlay.remove(); resolve(val); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    $('#btn-close-fa').addEventListener('click', () => done(null));
    $('#btn-cancel-fa').addEventListener('click', () => done(null));
    $('#btn-confirm-fa').addEventListener('click', () => {
      const picked = overlay.querySelector('input[name="fa-drop-pid"]:checked');
      done(picked ? Number(picked.value) : null);
    });
  });
}

// ================================================================ LEAGUE VIEW (Phase 5)
// Sub-tabs: matchup / standings / management / schedule / activity / trades
// Full ports Matchup + Standings + Management; others are light placeholders
// that point at the v1 page for now.

function teamNameOf(tid) {
  const t = (state.draft?.teams || []).find((x) => x.id === tid);
  return t ? t.name : `隊伍 ${tid}`;
}

function currentWeek() {
  return state.standings?.current_week || 1;
}

function regularWeeks() {
  return state.standings?.regular_weeks
      || state.leagueSettings?.regular_season_weeks
      || 14;
}

function matchupsForWeek(week) {
  const sched = state.schedule?.schedule || [];
  return sched.filter((m) => m.week === week);
}

async function refreshLeagueData() {
  const [standings, schedule] = await Promise.all([
    apiSoft('/api/season/standings'),
    apiSoft('/api/season/schedule'),
  ]);
  if (standings) state.standings = standings;
  if (schedule) state.schedule = schedule;
}

async function renderLeagueView(root) {
  // M15: snapshot view-token; abort post-await DOM writes if user navigated.
  const tok = state.viewToken;
  const d = state.draft;
  if (!d) {
    root.append(el('div', { class: 'card card-pad' }, '載入中…'));
    return;
  }
  if (isViewStale(tok)) return;

  // Selection gate: draft must be complete
  if (!d.is_complete) {
    root.append(
      el('div', { class: 'view-head' },
        el('div', { class: 'view-title-block' },
          el('span', { class: 'eyebrow' }, '聯盟'),
          el('div', { class: 'view-title' }, '請先完成選秀'),
          el('div', { class: 'view-sub' },
            `目前在第 ${d.current_overall} / ${d.num_teams * d.total_rounds} 順位。`),
        ),
        el('div', { class: 'view-actions' },
          el('a', { class: 'btn', href: '#/draft' }, '前往選秀'),
        ),
      ),
      el('div', { class: 'card card-pad' }, '選秀完成後才能開始賽季與對戰。'),
    );
    return;
  }

  // Top loader while we fetch standings/schedule
  root.append(
    el('div', { class: 'view-head' },
      el('div', { class: 'view-title-block' },
        el('span', { class: 'eyebrow' }, '聯盟'),
        el('div', { class: 'view-title', id: 'league-title' }, '載入中…'),
        el('div', { class: 'view-sub', id: 'league-sub' }, ' '),
      ),
      el('div', { class: 'view-actions', id: 'league-actions' }),
    ),
  );

  await refreshLeagueData();
  if (isViewStale(tok)) return;

  // Not-started gate: standings empty → offer 開始賽季
  const rows = state.standings?.standings || [];
  const seasonStarted = rows.some((r) => (r.w ?? 0) + (r.l ?? 0) > 0)
    || (state.standings?.current_week ?? 0) > 0
    || (state.standings?.current_day ?? 0) > 0;

  if (!seasonStarted) {
    const title = $('#league-title'); if (title) title.textContent = '賽季尚未開始';
    const sub = $('#league-sub'); if (sub) sub.textContent = '按下開始賽季以建立例行賽與季後賽。';
    root.append(
      el('div', { class: 'card card-pad' },
        el('button', { class: 'btn', onclick: onLeagueStartSeason }, '🏁 開始賽季'),
      ),
    );
    return;
  }

  // Head
  const st = state.standings || {};
  const wk = st.current_week || 1;
  const regWk = regularWeeks();
  const phase = st.champion != null
    ? '🏆 賽季結束'
    : st.is_playoffs ? `季後賽 · W${wk}` : `例行賽 · W${wk} / ${regWk}`;
  const title = $('#league-title'); if (title) title.textContent = phase;
  const sub = $('#league-sub'); if (sub) sub.textContent = `${rows.length} 隊 · Day ${st.current_day ?? 0}`;

  // Global action bar: always-visible advance + playoff buttons so the user
  // never has to hunt inside sub-tabs. Mirrors v1's league control bar.
  const actionsHost = $('#league-actions');
  if (actionsHost) {
    actionsHost.innerHTML = '';
    const champion = st.champion;
    const isPlayoffs = !!st.is_playoffs;
    const awaitingBracket = isPlayoffs && champion == null;
    const advDisabled = awaitingBracket || champion != null || state.advancing;
    const advTitle = awaitingBracket
      ? '例行賽已結束，請開打季後賽'
      : champion != null ? '賽季已結束' : null;
    actionsHost.append(
      el('button', {
        class: 'btn sm', disabled: advDisabled, title: advTitle,
        onclick: onLeagueAdvanceDay,
      }, '推進一天'),
      el('button', {
        class: 'btn sm', disabled: advDisabled, title: advTitle,
        onclick: onLeagueAdvanceWeek,
      }, '推進一週'),
    );
    if (champion == null) {
      if (awaitingBracket) {
        actionsHost.append(el('button', {
          class: 'btn sm primary', disabled: state.advancing,
          onclick: onLeagueSimPlayoffs,
        }, '🏆 模擬季後賽'));
      } else {
        actionsHost.append(el('button', {
          class: 'btn sm', disabled: state.advancing,
          onclick: onLeagueSimToPlayoffs,
        }, '模擬到季後賽'));
      }
    }
  }

  // Sub-tabs nav
  root.append(buildLeagueSubTabsV2());

  // Sub-content container (separate to re-render on tab switch without re-fetching)
  const sub2 = el('div', { id: 'league-sub-body' });
  root.append(sub2);
  renderLeagueSubBody(sub2);
}

function buildLeagueSubTabsV2() {
  const active = state.leagueSubTab || 'matchup';
  const tabs = [
    { id: 'matchup',    label: '對戰' },
    { id: 'standings',  label: '戰績' },
    { id: 'management', label: '聯盟' },
    { id: 'schedule',   label: '賽程', ghost: true },
    { id: 'activity',   label: '動態', ghost: true },
    { id: 'trades',     label: '交易', ghost: true },
  ];
  const wrap = el('div', { class: 'league-tabs-v2', role: 'tablist' });
  for (const t of tabs) {
    const btn = el('button', {
      type: 'button',
      class: `lt2 ${active === t.id ? 'active' : ''} ${t.ghost ? 'ghost' : ''}`,
      role: 'tab',
      'aria-selected': active === t.id ? 'true' : 'false',
      onclick: () => {
        state.leagueSubTab = t.id;
        // re-render sub body only
        const holder = $('#league-sub-body');
        const nav = wrap;
        if (holder) {
          holder.innerHTML = '';
          nav.querySelectorAll('.lt2').forEach((b) => {
            const is = b.textContent === t.label;
            b.classList.toggle('active', is);
            b.setAttribute('aria-selected', is ? 'true' : 'false');
          });
          renderLeagueSubBody(holder);
        }
      },
    }, t.label);
    wrap.append(btn);
  }
  return wrap;
}

function renderLeagueSubBody(container) {
  const tab = state.leagueSubTab || 'matchup';
  switch (tab) {
    case 'matchup':    return renderMatchupSubV2(container);
    case 'standings':  return renderStandingsSubV2(container);
    case 'management': return renderManagementSubV2(container);
    case 'schedule':   return renderSchedulePlaceholder(container);
    case 'activity':   return renderActivityPlaceholder(container);
    case 'trades':     return renderTradesPlaceholder(container);
    default:           return renderMatchupSubV2(container);
  }
}

// -------- Matchup sub-tab ----------------------------------------------------
function renderMatchupSubV2(container) {
  const wk = state.matchupViewWeek ?? currentWeek();
  state.matchupViewWeek = wk;
  const regWk = regularWeeks();
  const maxWk = Math.max(currentWeek(), regWk);
  const humanId = state.draft?.human_team_id;
  const all = matchupsForWeek(wk);
  const mine = all.find((m) => m.team_a === humanId || m.team_b === humanId);
  const others = all.filter((m) => m !== mine);

  // Week nav
  const nav = el('div', { class: 'panel league-week-nav' },
    el('div', { class: 'lwn-row' },
      el('button', {
        class: 'btn sm ghost', disabled: wk <= 1,
        onclick: () => { state.matchupViewWeek = wk - 1; rerenderLeagueSub(container); },
      }, '◀ 上週'),
      el('span', { class: 'lwn-label' },
        wk > regWk ? `季後賽 W${wk}` : `第 ${wk} 週`,
        wk === currentWeek() ? el('span', { class: 'pill good', style: 'margin-left:8px;' }, '本週') : null,
      ),
      el('button', {
        class: 'btn sm ghost', disabled: wk >= maxWk,
        onclick: () => { state.matchupViewWeek = wk + 1; rerenderLeagueSub(container); },
      }, '下週 ▶'),
    ),
  );
  container.append(nav);

  // Hero matchup (your matchup)
  if (mine) {
    container.append(buildMatchupHeroCard(mine, wk, humanId));
    // Fetch detailed player logs
    fetchAndRenderMatchupDetail(mine, wk, container);
  } else {
    container.append(
      el('div', { class: 'card card-pad' },
        el('div', { class: 'empty-state' }, '本週你沒有對戰資料。'),
      ),
    );
  }

  // Other matchups
  if (others.length) {
    const scoreboard = el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('h3', {}, '同週其他對戰')),
      el('div', { class: 'panel-body tight', id: 'league-scoreboard' }),
    );
    const body = scoreboard.querySelector('#league-scoreboard');
    for (const m of others) body.append(buildMiniMatchupCard(m));
    container.append(scoreboard);
  }
}

function rerenderLeagueSub(container) {
  container.innerHTML = '';
  renderLeagueSubBody(container);
}

function buildMatchupHeroCard(m, week, humanId) {
  const isAUser = m.team_a === humanId;
  const userTid = isAUser ? m.team_a : m.team_b;
  const oppTid = isAUser ? m.team_b : m.team_a;
  const userScore = isAUser ? m.score_a : m.score_b;
  const oppScore = isAUser ? m.score_b : m.score_a;
  const played = !!m.complete || (userScore != null && oppScore != null);
  let statusLabel = '本週進行中';
  let statusClass = 'upcoming';
  if (played) {
    if (m.winner === userTid) { statusLabel = '勝'; statusClass = 'won'; }
    else if (m.winner === oppTid) { statusLabel = '敗'; statusClass = 'lost'; }
    else { statusLabel = '平'; statusClass = 'tie'; }
  }
  // Yahoo-style: side-by-side with diff bar in the middle.
  const diff = (userScore != null && oppScore != null) ? (userScore - oppScore) : null;
  let diffLabel = '';
  if (diff != null) {
    if (diff > 0) diffLabel = `↑ 領先 ${diff.toFixed(1)}`;
    else if (diff < 0) diffLabel = `↓ 落後 ${(-diff).toFixed(1)}`;
    else diffLabel = '↔ 平手';
  }
  const userWinning = diff != null && diff > 0;
  const oppWinning = diff != null && diff < 0;
  return el('div', { class: `card card-pad matchup-hero status-${statusClass}` },
    el('div', { class: 'mh-head' },
      el('span', { class: 'mh-label' }, `第 ${week} 週 你的對戰`),
      el('span', { class: `mh-status status-${statusClass}` }, statusLabel),
    ),
    el('div', { class: 'mh-body' },
      el('div', { class: `mh-side user ${userWinning ? 'leading' : ''}` },
        el('div', { class: 'mh-tag' }, '你'),
        el('div', { class: 'mh-name' }, teamNameOf(userTid)),
        el('div', { class: 'mh-score' }, played ? fmtStat(userScore) : '—'),
      ),
      el('div', { class: 'mh-vs' },
        el('div', { class: 'mh-vs-text' }, 'VS'),
        diffLabel ? el('div', { class: 'mh-vs-diff' }, diffLabel) : null,
      ),
      el('div', { class: `mh-side opp ${oppWinning ? 'leading' : ''}` },
        el('div', { class: 'mh-tag' }, '對手'),
        el('div', { class: 'mh-name' }, teamNameOf(oppTid)),
        el('div', { class: 'mh-score' }, played ? fmtStat(oppScore) : '—'),
      ),
    ),
  );
}

function buildMiniMatchupCard(m) {
  const played = !!m.complete || (m.score_a != null && m.score_b != null);
  const winA = played && m.winner === m.team_a;
  const winB = played && m.winner === m.team_b;
  return el('div', { class: 'mini-matchup' },
    el('div', { class: `mm-side ${winA ? 'win' : ''}` },
      el('span', { class: 'mm-name' }, teamNameOf(m.team_a)),
      el('span', { class: 'mm-score' }, played ? fmtStat(m.score_a) : '—'),
    ),
    el('div', { class: 'mm-vs' }, 'vs'),
    el('div', { class: `mm-side ${winB ? 'win' : ''}` },
      el('span', { class: 'mm-name' }, teamNameOf(m.team_b)),
      el('span', { class: 'mm-score' }, played ? fmtStat(m.score_b) : '—'),
    ),
  );
}

async function fetchAndRenderMatchupDetail(m, week, container) {
  const slot = el('div', { class: 'card card-pad matchup-detail', id: 'matchup-detail-slot' },
    el('div', { class: 'empty-state' }, '載入雙方球員明細…'),
  );
  container.append(slot);
  try {
    const data = await api(`/api/season/matchup-detail?week=${week}&team_a=${m.team_a}&team_b=${m.team_b}`);
    slot.innerHTML = '';
    if (data.logs_trimmed) {
      slot.append(el('div', { class: 'empty-state' }, '此週較早，球員明細已不保留。'));
      return;
    }
    // Yahoo-style side-by-side roster (starters slot-aligned + bench).
    slot.append(buildYahooMatchupTable(data));
    // Daily 7-day FP trend tables (one per team) below.
    slot.append(buildMatchupDailyTable(data.players_a, data.team_a_name));
    slot.append(buildMatchupDailyTable(data.players_b, data.team_b_name));
  } catch (e) {
    slot.innerHTML = '';
    slot.append(el('div', { class: 'empty-state' }, `明細載入失敗：${escapeHtml(e.message || '')}`));
  }
}

// Aggregate raw daily logs into per-player weekly totals (pts/reb/ast/stl/blk/to)
// keyed by player_id. The backend's lineup rows only carry weekly_fp + days, so we
// recompute the box-score columns here so the matchup table can show them.
function aggregateMatchupStats(dailyLogs) {
  const out = {};
  for (const r of (dailyLogs || [])) {
    if (!r || !r.played) continue;
    const id = r.player_id;
    if (!out[id]) out[id] = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, to: 0, days: [] };
    const a = out[id];
    a.pts += Number(r.pts) || 0;
    a.reb += Number(r.reb) || 0;
    a.ast += Number(r.ast) || 0;
    a.stl += Number(r.stl) || 0;
    a.blk += Number(r.blk) || 0;
    a.to  += Number(r.to)  || 0;
    a.days.push(r);
  }
  return out;
}

// Aggregate per-player for either the whole week (dayFilter null) or a single
// day number (e.g. 3 for D3). Returns {[pid]: {fp, pts, reb, ast, stl, blk, to, played}}
function aggregatePerPlayer(dailyLogs, dayFilter) {
  const out = {};
  for (const r of (dailyLogs || [])) {
    if (!r || !r.played) continue;
    if (dayFilter != null && r.day !== dayFilter) continue;
    const id = r.player_id;
    if (!out[id]) out[id] = { fp: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, to: 0, played: 0 };
    const a = out[id];
    a.fp  += Number(r.fp)  || 0;
    a.pts += Number(r.pts) || 0;
    a.reb += Number(r.reb) || 0;
    a.ast += Number(r.ast) || 0;
    a.stl += Number(r.stl) || 0;
    a.blk += Number(r.blk) || 0;
    a.to  += Number(r.to)  || 0;
    a.played += 1;
  }
  return out;
}

// Yahoo-style matchup roster with Pos | Player | Fan Pts | PTS REB AST ST BLK TO
// columns per side, day-tab selector to switch between Totals and any single day.
// Mobile (< 768px) collapses to stacked-team layout via CSS.
function buildYahooMatchupTable(d) {
  // Determine which day numbers exist this week (e.g. days 1..7 for week 1).
  const allLogs = [...(d.players_a || []), ...(d.players_b || [])];
  const dayNums = Array.from(new Set(allLogs.map(r => r.day).filter(n => Number.isFinite(n)))).sort((x, y) => x - y);

  // Container holds day tabs + table. Re-renders the table only when day changes.
  const container = el('div', { class: 'yahoo-matchup-wrap' });
  let currentDay = null;  // null = totals; otherwise a specific day number

  function rerender() {
    container.innerHTML = '';
    container.append(buildDayTabs(), buildTable());
  }

  function buildDayTabs() {
    const tabs = el('div', { class: 'ymt-day-tabs' });
    const mkTab = (label, dayVal) => {
      const active = currentDay === dayVal;
      return el('button', {
        class: `ymt-day-tab ${active ? 'active' : ''}`,
        onclick: () => { currentDay = dayVal; rerender(); },
      }, label);
    };
    tabs.append(mkTab('合計', null));
    for (const dn of dayNums) tabs.append(mkTab(`D${dn}`, dn));
    return tabs;
  }

  function buildTable() {
    const lineupA = d.lineup_a || [];
    const lineupB = d.lineup_b || [];
    const benchA = d.bench_a || [];
    const benchB = d.bench_b || [];
    const statsA = aggregatePerPlayer(d.players_a, currentDay);
    const statsB = aggregatePerPlayer(d.players_b, currentDay);

    const fmt1 = (n) => (Number.isFinite(n) && n !== 0 ? n.toFixed(1) : (n === 0 ? '0.0' : '—'));
    // Box-score stats are integer counts in real basketball — round at display.
    const fmtBox = (n) => (Number.isFinite(n) ? String(Math.round(n)) : '—');
    const dash = '<td class="num ymt-dash">—</td>';

    // Render one player's stat cells: Fan Pts | PTS | REB | AST | ST | BLK | TO
    const statCells = (p, stats, sideClass) => {
      if (!p) return `<td class="num"><span class="ymt-empty-mark">—</span></td>${dash.repeat(6)}`;
      const s = stats[p.player_id];
      if (!s) return `<td class="num">0.0</td>${dash.repeat(6)}`;
      return `<td class="num ${sideClass}"><b>${fmt1(s.fp)}</b></td>
        <td class="num">${fmtBox(s.pts)}</td>
        <td class="num">${fmtBox(s.reb)}</td>
        <td class="num">${fmtBox(s.ast)}</td>
        <td class="num">${fmtBox(s.stl)}</td>
        <td class="num">${fmtBox(s.blk)}</td>
        <td class="num">${fmtBox(s.to)}</td>`;
    };
    const playerCell = (p) => {
      if (!p) return `<span class="ymt-empty">(空)</span>`;
      return `<div class="ymt-pname"><b>${escapeHtml(p.name)}</b></div>
        <div class="ymt-pmeta">${escapeHtml(p.pos || '')}</div>`;
    };

    // Build one side's full table (starters + bench) — Yahoo layout
    function buildSide(lineup, bench, stats, sideName, isA) {
      const slotCount = Math.max(lineup.length, 10);
      const rows = [];
      let totalFp = 0;
      for (let i = 0; i < slotCount; i++) {
        const r = lineup[i] || { slot: '-', player: null };
        const p = r.player;
        const s = p ? stats[p.player_id] : null;
        if (s) totalFp += s.fp;
        rows.push(`<tr>
          <td class="ymt-pos"><span class="pos-tag" data-pos="${escapeHtml(r.slot)}">${escapeHtml(r.slot)}</span></td>
          <td class="ymt-player">${playerCell(p)}</td>
          ${statCells(p, stats, isA ? 'a-fp' : 'b-fp')}
        </tr>`);
      }
      // Bench section
      const benchRows = [];
      for (const p of (bench || [])) {
        benchRows.push(`<tr class="ymt-bench-row">
          <td class="ymt-pos"><span class="pos-tag" data-pos="BN">BN</span></td>
          <td class="ymt-player">${playerCell(p)}</td>
          ${statCells(p, stats, '')}
        </tr>`);
      }
      const benchHead = benchRows.length
        ? `<tr class="ymt-section"><td colspan="9">板凳（不計入分數）</td></tr>`
        : '';
      const totalRow = `<tr class="ymt-totals">
        <td></td>
        <td class="ymt-player"><b>合計（先發）</b></td>
        <td class="num"><b>${fmt1(totalFp)}</b></td>
        ${dash.repeat(6)}
      </tr>`;
      return `<table class="yahoo-matchup-table">
        <thead>
          <tr class="ymt-team-head"><th colspan="9">${escapeHtml(sideName)}</th></tr>
          <tr>
            <th>Pos</th><th>Player</th>
            <th class="num">Fan Pts</th>
            <th class="num">PTS</th><th class="num">REB</th><th class="num">AST</th>
            <th class="num">ST</th><th class="num">BLK</th><th class="num">TO</th>
          </tr>
        </thead>
        <tbody>${rows.join('')}${totalRow}${benchHead}${benchRows.join('')}</tbody>
      </table>`;
    }

    const split = el('div', { class: 'ymt-split' });
    split.innerHTML = `<div class="ymt-side-wrap">${buildSide(lineupA, benchA, statsA, d.team_a_name || 'A', true)}</div>
      <div class="ymt-side-wrap">${buildSide(lineupB, benchB, statsB, d.team_b_name || 'B', false)}</div>`;
    return split;
  }

  rerender();
  return container;
}

function aggregateMatchupPlayers(rows) {
  // Backend returns per-day rows. Roll them up per player for the week.
  const byPid = new Map();
  for (const r of rows || []) {
    const k = r.player_id;
    if (!byPid.has(k)) {
      byPid.set(k, {
        player_id: k, name: r.player_name, pos: r.pos,
        days: 0, fp: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, to: 0,
      });
    }
    const e = byPid.get(k);
    if (r.played) e.days += 1;
    e.fp += r.fp || 0;
    e.pts += r.pts || 0;
    e.reb += r.reb || 0;
    e.ast += r.ast || 0;
    e.stl += r.stl || 0;
    e.blk += r.blk || 0;
    e.to  += r.to  || 0;
  }
  const out = Array.from(byPid.values());
  out.sort((a, b) => b.fp - a.fp);
  return out;
}

function buildMatchupPlayerTable(rows, title) {
  const head = `<tr>
      <th>球員</th><th>位</th><th class="num">出</th><th class="num">FP</th>
      <th class="num">PTS</th><th class="num">REB</th><th class="num">AST</th>
      <th class="num">STL</th><th class="num">BLK</th><th class="num">TO</th>
    </tr>`;
  const body = rows.length
    ? rows.map((p) => `<tr>
        <td><b>${escapeHtml(p.name)}</b></td>
        <td><span class="pos-tag" data-pos="${escapeHtml(p.pos || '')}">${escapeHtml(p.pos || '')}</span></td>
        <td class="num">${p.days}</td>
        <td class="num"><b>${fmtStat(p.fp)}</b></td>
        <td class="num">${fmtStat(p.pts)}</td>
        <td class="num">${fmtStat(p.reb)}</td>
        <td class="num">${fmtStat(p.ast)}</td>
        <td class="num">${fmtStat(p.stl)}</td>
        <td class="num">${fmtStat(p.blk)}</td>
        <td class="num">${fmtStat(p.to)}</td>
      </tr>`).join('')
    : `<tr><td colspan="10" style="text-align:center; color:var(--ink-3); padding: var(--s-5);">本週尚未產生球員明細</td></tr>`;

  const wrap = el('div', { class: 'md-col' });
  wrap.innerHTML = `
    <div class="md-col-head">${escapeHtml(title)}</div>
    <div class="table-wrap"><table class="standings-table md-tbl"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  return wrap;
}

// Daily breakdown: one row per player, columns Day1..Day7 + 週小計 (FP per day).
// Backend returns per-day rows; we pivot them into a per-player x day grid.
function buildMatchupDailyTable(rows, title) {
  const byPid = new Map();
  let maxDay = 0;
  for (const r of rows || []) {
    const d = Number(r.day) || 0;
    if (d > maxDay) maxDay = d;
    if (!byPid.has(r.player_id)) {
      byPid.set(r.player_id, {
        player_id: r.player_id, name: r.player_name, pos: r.pos,
        days: {}, total: 0,
      });
    }
    const e = byPid.get(r.player_id);
    e.days[d] = (e.days[d] || 0) + (r.fp || 0);
    if (r.played) e.total += r.fp || 0;
  }
  // Show at least 7 day columns; if backend has more (rare), expand.
  const dayCount = Math.max(7, maxDay);
  const players = Array.from(byPid.values());
  players.sort((a, b) => b.total - a.total);

  const dayHeads = Array.from({ length: dayCount }, (_, i) => `<th class="num">D${i + 1}</th>`).join('');
  const head = `<tr>
      <th>球員</th><th>位</th>${dayHeads}<th class="num">週小計</th>
    </tr>`;
  const body = players.length
    ? players.map((p) => {
        const cells = Array.from({ length: dayCount }, (_, i) => {
          const v = p.days[i + 1];
          return `<td class="num">${v == null ? '—' : fmtStat(v)}</td>`;
        }).join('');
        return `<tr>
          <td><b>${escapeHtml(p.name)}</b></td>
          <td><span class="pos-tag" data-pos="${escapeHtml(p.pos || '')}">${escapeHtml(p.pos || '')}</span></td>
          ${cells}
          <td class="num"><b>${fmtStat(p.total)}</b></td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="${dayCount + 3}" style="text-align:center; color:var(--ink-3); padding: var(--s-5);">無逐日資料</td></tr>`;

  const wrap = el('div', { class: 'md-col md-daily', style: 'margin-top: var(--s-3);' });
  wrap.innerHTML = `
    <div class="md-col-head">${escapeHtml(title)}・逐日明細</div>
    <div class="table-wrap"><table class="standings-table md-tbl md-daily-tbl"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  return wrap;
}

// -------- Standings sub-tab --------------------------------------------------
function renderStandingsSubV2(container) {
  const rows = state.standings?.standings || [];
  if (!rows.length) {
    container.append(el('div', { class: 'card card-pad' },
      el('div', { class: 'empty-state' }, '尚無戰績資料。')));
    return;
  }
  const humanId = state.draft?.human_team_id;
  // Backend already sorts by (w, pf) desc. Compute GB against leader.
  const leader = rows[0];
  const lw = leader.w ?? 0;
  const ll = leader.l ?? 0;

  const head = `<tr>
      <th>#</th><th>隊伍</th>
      <th class="num">勝-敗</th><th class="num">勝率</th><th class="num">GB</th>
      <th class="num">得分</th><th class="num">失分</th>
    </tr>`;

  const body = rows.map((r, i) => {
    const w = r.w ?? 0;
    const l = r.l ?? 0;
    const pct = (w + l) > 0 ? (w / (w + l)).toFixed(3).replace(/^0\./, '.') : '—';
    const gb = i === 0 ? '—' : (((lw - w) + (l - ll)) / 2).toFixed(1);
    const isYou = r.is_human || r.team_id === humanId;
    const rowCls = isYou ? 'you' : '';
    return `<tr class="${rowCls}">
      <td><span class="rank-pill ${i <= 2 ? 'top-' + (i + 1) : ''}">${i + 1}</span></td>
      <td class="name"><b>${escapeHtml(r.name)}</b>${isYou ? ' <span class="pill accent" style="font-size: 12px;">YOU</span>' : ''}</td>
      <td class="num"><b>${w}-${l}</b></td>
      <td class="num">${pct}</td>
      <td class="num">${gb}</td>
      <td class="num">${fmtStat(r.pf)}</td>
      <td class="num">${fmtStat(r.pa)}</td>
    </tr>`;
  }).join('');

  const card = el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('h3', {}, '戰績排名')),
    el('div', { class: 'table-wrap' }),
  );
  card.querySelector('.table-wrap').innerHTML =
    `<table class="standings-table standings-v2"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  container.append(card);

  // Playoff bracket visualization (only if we have at least 6 teams to seed
  // the 6-team bracket). Render whether or not playoffs have started — pre-
  // playoff it shows projected matchups based on current standings.
  if (rows.length >= 6) {
    container.append(buildPlayoffBracketV2(rows));
  }
}

function buildPlayoffBracketV2(rows) {
  const st = state.standings || {};
  const isPlayoffs = !!st.is_playoffs;
  const champion = st.champion;
  const seeds = rows.slice(0, 6).map((r, i) => ({
    seed: i + 1,
    team_id: r.team_id,
    name: r.name,
    record: `${r.w ?? 0}-${r.l ?? 0}`,
  }));
  const headerSub = champion != null ? '🏆 賽季結束'
    : isPlayoffs ? '季後賽進行中'
    : '依目前戰績預估';

  const card = el('div', { class: 'card', style: 'margin-top: var(--s-4);' });
  card.append(el('div', { class: 'card-header' },
    el('h3', {}, '季後賽 Bracket（6 隊）'),
    el('span', { class: 'sub' }, headerSub),
  ));

  // Helper to render one team box
  const teamBox = (s, opts) => {
    const isWinner = opts && opts.winner;
    const isChamp = opts && opts.champ;
    const isHuman = state.draft?.human_team_id === s.team_id;
    const cls = ['po-team'];
    if (isWinner) cls.push('winner');
    if (isChamp)  cls.push('champ');
    if (isHuman)  cls.push('you');
    return el('div', { class: cls.join(' '), style: `
      padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px;
      background: ${isChamp ? 'var(--accent-08, rgba(255,193,7,0.15))' : 'var(--surface)'};
      ${isWinner ? 'border-color: var(--accent); font-weight: 600;' : ''}
      ${isHuman ? 'box-shadow: inset 3px 0 0 var(--accent);' : ''}
      font-size: var(--fs-xs);
    ` },
      el('span', { style: 'font-family:var(--mono); color:var(--ink-3); margin-right: 6px;' }, `#${s.seed}`),
      el('span', {}, s.name),
      isHuman ? el('span', { class: 'pill accent', style: 'margin-left:6px; font-size: 12px;' }, 'YOU') : null,
      el('span', { style: 'margin-left:auto; color:var(--ink-3); font-family:var(--mono); font-size: 12px;' }, ` ${s.record}`),
    );
  };

  // 3-column grid: Round 1 / Semis / Final
  const grid = el('div', { style: `
    display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--s-4);
    padding: var(--s-4); align-items: center;
  ` });

  // Round 1: seed3 vs seed6, seed4 vs seed5 (seed1 + seed2 byes shown in semis)
  const r1 = el('div', { style: 'display:flex; flex-direction: column; gap: var(--s-3);' });
  r1.append(el('div', { class: 'po-round-label', style: 'font-size:var(--fs-xs); color:var(--ink-3); text-align:center; font-weight:600;' }, 'Round 1'));
  r1.append(el('div', { style: 'display:flex; flex-direction:column; gap:4px;' },
    teamBox(seeds[2]), teamBox(seeds[5]),
  ));
  r1.append(el('div', { style: 'display:flex; flex-direction:column; gap:4px; margin-top: var(--s-3);' },
    teamBox(seeds[3]), teamBox(seeds[4]),
  ));

  // Semis: seed1 vs (4-5 winner), seed2 vs (3-6 winner). Without ground truth,
  // show "TBD".
  const tbd = el('div', { class: 'po-team', style: 'padding:6px 10px; border:1px dashed var(--line); border-radius:6px; color:var(--ink-3); font-size:var(--fs-xs); text-align:center;' }, 'TBD');
  const tbd2 = tbd.cloneNode(true);
  const semis = el('div', { style: 'display:flex; flex-direction:column; gap: var(--s-3);' });
  semis.append(el('div', { class: 'po-round-label', style: 'font-size:var(--fs-xs); color:var(--ink-3); text-align:center; font-weight:600;' }, 'Semifinals'));
  semis.append(el('div', { style: 'display:flex; flex-direction:column; gap:4px;' },
    teamBox(seeds[0]), tbd,
  ));
  semis.append(el('div', { style: 'display:flex; flex-direction:column; gap:4px; margin-top: var(--s-3);' },
    teamBox(seeds[1]), tbd2,
  ));

  // Finals
  const finals = el('div', { style: 'display:flex; flex-direction:column; gap: var(--s-3); align-items: center;' });
  finals.append(el('div', { class: 'po-round-label', style: 'font-size:var(--fs-xs); color:var(--ink-3); text-align:center; font-weight:600;' }, 'Finals'));
  if (champion != null) {
    const champSeed = seeds.find((s) => s.team_id === champion) || {
      seed: '?', team_id: champion, name: teamNameOf(champion), record: '',
    };
    finals.append(teamBox(champSeed, { champ: true, winner: true }));
    finals.append(el('div', { style: 'font-size: 18px; color: var(--accent); margin-top: var(--s-2);' }, '🏆 冠軍'));
  } else {
    finals.append(el('div', { class: 'po-team', style: 'padding:6px 10px; border:1px dashed var(--line); border-radius:6px; color:var(--ink-3); font-size:var(--fs-xs); text-align:center; min-width: 100px;' }, 'TBD'));
    finals.append(el('div', { style: 'font-size: 14px; color: var(--ink-3); margin-top: var(--s-2);' }, '冠軍待定'));
  }

  grid.append(r1, semis, finals);
  card.append(grid);
  card.append(el('div', { style: 'padding: 0 var(--s-4) var(--s-4); color: var(--ink-3); font-size: var(--fs-xs);' },
    '※ 種子 1、2 首輪輪空（直接進入 Semifinals）。完整對戰結果以實際模擬為準。'));
  return card;
}

// -------- Management sub-tab -------------------------------------------------
function renderManagementSubV2(container) {
  const st = state.standings || {};
  const s = state.leagueSettings || {};
  const champion = st.champion;
  const isPlayoffs = !!st.is_playoffs;
  const awaitingBracket = isPlayoffs && champion == null;
  const disabled = awaitingBracket || champion != null || state.advancing;
  const disableTitle = awaitingBracket
    ? '例行賽已結束，請開打季後賽'
    : champion != null ? '賽季已結束' : null;

  // Controls panel — advance + playoff sims + reset
  const controlButtons = [
    el('button', {
      class: 'btn', disabled, title: disableTitle,
      onclick: onLeagueAdvanceDay,
    }, '推進一天'),
    el('button', {
      class: 'btn', disabled, title: disableTitle,
      onclick: onLeagueAdvanceWeek,
    }, '推進一週'),
  ];
  // Playoff transition buttons (only when relevant)
  if (champion == null) {
    if (awaitingBracket) {
      controlButtons.push(el('button', {
        class: 'btn primary', disabled: state.advancing,
        onclick: onLeagueSimPlayoffs,
      }, '🏆 模擬季後賽'));
    } else {
      controlButtons.push(el('button', {
        class: 'btn', disabled: state.advancing,
        onclick: onLeagueSimToPlayoffs,
      }, '模擬到季後賽'));
    }
  }
  controlButtons.push(el('button', {
    class: 'btn ghost',
    onclick: onLeagueResetSeason,
  }, '重置賽季'));

  const controls = el('div', { class: 'card card-pad' },
    el('div', { class: 'mgmt-controls' }, ...controlButtons),
    el('div', { class: 'mgmt-log', id: 'league-mgmt-log' },
      el('div', { class: 'empty-state' }, '操作訊息會顯示在這裡。'),
    ),
  );
  container.append(controls);

  // League info panel
  const tradeDeadline = s.trade_deadline_week ?? Math.max(1, (s.regular_season_weeks || 14) - 3);
  const infoPairs = [
    ['聯盟名稱', s.league_name || '我的聯盟'],
    ['賽季年度', s.season_year || '—'],
    ['隊伍數', `${s.num_teams || (state.draft?.num_teams ?? 8)}`],
    ['名單人數', `${s.roster_size || 13} 人`],
    ['每日先發', `${s.starters_per_day || 10} 人`],
    ['例行賽', `${s.regular_season_weeks || 14} 週`],
    ['季後賽隊伍', `${s.playoff_teams || 6} 隊`],
    ['交易截止', `第 ${tradeDeadline} 週`],
    ['目前週次', `W${st.current_week ?? '—'} · Day ${st.current_day ?? '—'}`],
    ['狀態',
      champion != null ? `🏆 冠軍：${teamNameOf(champion)}`
      : isPlayoffs ? '季後賽進行中' : '例行賽進行中'],
  ];
  const grid = el('div', { class: 'info-grid' });
  for (const [label, value] of infoPairs) {
    grid.append(el('div', { class: 'info-item' },
      el('div', { class: 'info-label' }, label),
      el('div', { class: 'info-value' }, value),
    ));
  }
  container.append(el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('h3', {}, '聯盟資訊')),
    el('div', { class: 'card-body' }, grid),
  ));

  // Mid-season editable settings — only fields in MID_SEASON_ALLOWED on the
  // backend (`team_names`, `ai_trade_frequency`, `ai_trade_style`,
  // `ai_decision_mode`, `draft_display_mode`, `show_offseason_headlines`).
  container.append(buildMidSeasonSettingsCardV2(s));
}

function buildMidSeasonSettingsCardV2(s) {
  const card = el('div', { class: 'card', style: 'margin-top: var(--s-4);' });
  card.append(el('div', { class: 'card-header' },
    el('h3', {}, '賽季設定（季中可調整）'),
    el('span', { class: 'sub' }, '其他項目鎖定'),
  ));

  const body = el('div', { class: 'card-body', style: 'display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-3); padding: var(--s-4);' });

  // Editable: ai_trade_frequency
  const freqVal = s.ai_trade_frequency || 'medium';
  const freqSel = el('select', {
    onchange: (e) => onMidSeasonPatchV2({ ai_trade_frequency: e.target.value }),
    html: ['off', 'low', 'medium', 'high'].map((v) =>
      `<option value="${v}" ${v === freqVal ? 'selected' : ''}>${v}</option>`).join(''),
    style: 'width: 100%; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface);',
  });
  body.append(midSettingRow('AI 交易頻率', freqSel));

  // Editable: ai_trade_style
  const styleVal = s.ai_trade_style || 'balanced';
  const styleSel = el('select', {
    onchange: (e) => onMidSeasonPatchV2({ ai_trade_style: e.target.value }),
    html: ['conservative', 'balanced', 'aggressive'].map((v) =>
      `<option value="${v}" ${v === styleVal ? 'selected' : ''}>${v}</option>`).join(''),
    style: 'width: 100%; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface);',
  });
  body.append(midSettingRow('AI 交易風格', styleSel));

  // Editable: ai_decision_mode
  const decisionVal = s.ai_decision_mode || 'llm';
  const decisionSel = el('select', {
    onchange: (e) => onMidSeasonPatchV2({ ai_decision_mode: e.target.value }),
    html: ['llm', 'heuristic', 'mixed'].map((v) =>
      `<option value="${v}" ${v === decisionVal ? 'selected' : ''}>${v}</option>`).join(''),
    style: 'width: 100%; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface);',
  });
  body.append(midSettingRow('AI 決策模式', decisionSel));

  // Editable: show_offseason_headlines
  const headlinesVal = !!s.show_offseason_headlines;
  const headlinesChk = el('input', {
    type: 'checkbox', checked: headlinesVal ? true : null,
    onchange: (e) => onMidSeasonPatchV2({ show_offseason_headlines: e.target.checked }),
  });
  body.append(midSettingRow('顯示季前頭條', headlinesChk));

  // Locked fields hint (read-only with tooltip)
  const lockedFields = [
    ['名單人數', `${s.roster_size || '—'} 人`],
    ['每日先發', `${s.starters_per_day || '—'} 人`],
    ['例行賽週數', `${s.regular_season_weeks || '—'} 週`],
    ['交易截止', s.trade_deadline_week ? `W${s.trade_deadline_week}` : '無截止'],
    ['否決門檻', `${s.veto_threshold ?? '—'} 票`],
    ['否決窗口', `${s.veto_window_days ?? '—'} 天`],
  ];
  for (const [label, val] of lockedFields) {
    const locked = el('div', {
      style: 'padding: 6px 10px; background: var(--bg-2, #f6f6f6); border: 1px dashed var(--line); border-radius: 6px; color: var(--ink-3); font-size: var(--fs-sm);',
      title: '🔒 賽季開始後此欄位已鎖定',
    },
      el('span', {}, val),
      el('span', { style: 'margin-left: 6px; color: var(--ink-4); font-size: var(--fs-xs);' }, '🔒'),
    );
    body.append(midSettingRow(label, locked));
  }

  card.append(body);
  return card;
}

function midSettingRow(label, control) {
  return el('div', { style: 'display: flex; flex-direction: column; gap: 4px;' },
    el('label', { style: 'font-size: var(--fs-xs); color: var(--ink-3); font-weight: 600;' }, label),
    control,
  );
}

async function onMidSeasonPatchV2(patch) {
  try {
    const updated = await api('/api/league/settings', {
      method: 'POST',
      body: JSON.stringify(patch),
    });
    state.leagueSettings = updated;
    toast('設定已更新', 'info');
  } catch (e) {
    toast(`更新失敗：${e.message || ''}`, 'error');
  }
}

// -------- Placeholders -------------------------------------------------------
function renderSchedulePlaceholder(container) {
  const sched = state.schedule?.schedule || [];
  if (!sched.length) {
    container.append(el('div', { class: 'card card-pad' },
      el('div', { class: 'empty-state' }, '尚無賽程資料。')));
    return;
  }
  // Group by week (light read-only list; full week grid is Phase 6)
  const byWeek = new Map();
  for (const m of sched) {
    if (!byWeek.has(m.week)) byWeek.set(m.week, []);
    byWeek.get(m.week).push(m);
  }
  const weeks = Array.from(byWeek.keys()).sort((a, b) => a - b);
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('h3', {}, '賽程總覽（Phase 6 擴充）'),
      el('span', { class: 'sub' }, `${weeks.length} 週`)),
    el('div', { class: 'sched-list' }),
  );
  const list = card.querySelector('.sched-list');
  for (const wk of weeks) {
    const matchups = byWeek.get(wk);
    const row = el('div', { class: 'sched-week' },
      el('div', { class: 'sched-week-head' }, `W${wk}`),
      el('div', { class: 'sched-week-body' }),
    );
    const body = row.querySelector('.sched-week-body');
    for (const m of matchups) body.append(buildMiniMatchupCard(m));
    list.append(row);
  }
  container.append(card);
}

async function renderActivityPlaceholder(container) {
  const loading = el('div', { class: 'card card-pad' },
    el('div', { class: 'empty-state' }, '載入動態中…'));
  container.append(loading);
  const data = await apiSoft('/api/season/activity?limit=50');
  loading.remove();
  const items = data?.activity || [];
  if (!items.length) {
    container.append(el('div', { class: 'card card-pad' },
      el('div', { class: 'empty-state' }, '暫無動態（賽季剛開始或尚未發生事件）。')));
    return;
  }
  const ICONS = {
    trade_accepted: '🤝', trade_executed: '✅', trade_rejected: '❌', trade_vetoed: '🛑',
    fa_claim: '🆓', injury_new: '🤕', injury_return: '💪',
    milestone_blowout: '💥', milestone_nailbiter: '😤',
    milestone_win_streak: '🔥', milestone_lose_streak: '❄️',
    milestone_top_performer: '⭐', champion: '🏆',
  };
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('h3', {}, '近期動態'),
      el('span', { class: 'sub' }, `${items.length} 則 · 由新到舊`),
    ),
    el('div', { class: 'activity-list' }),
  );
  const list = card.querySelector('.activity-list');
  for (const it of items) {
    const wk = it.week != null ? `W${it.week}` : '';
    const day = it.day != null ? `D${it.day}` : '';
    const when = [wk, day].filter(Boolean).join(' ') || '—';
    const icon = ICONS[it.type] || '•';
    list.append(el('div', { class: 'activity-row' },
      el('span', { class: 'activity-when', style: 'font-family:var(--mono); color:var(--ink-3); font-size:var(--fs-xs); min-width:64px;' }, when),
      el('span', { class: 'activity-icon', style: 'min-width:22px; text-align:center;' }, icon),
      el('span', { class: 'activity-summary' }, it.summary || it.type || '—'),
    ));
  }
  container.append(card);
}

async function renderTradesPlaceholder(container) {
  const loading = el('div', { class: 'card card-pad' },
    el('div', { class: 'empty-state' }, '載入交易紀錄…'));
  container.append(loading);
  const data = await apiSoft('/api/trades/history');
  loading.remove();
  const hist = data?.history || [];
  if (!hist.length) {
    container.append(el('div', { class: 'card card-pad' },
      el('div', { class: 'empty-state' }, '尚無交易紀錄。')));
    return;
  }
  const rows = hist.slice(0, 20).map((t) => `<tr>
    <td>W${t.proposed_week ?? '?'}</td>
    <td>${escapeHtml(teamNameOf(t.from_team))}</td>
    <td>↔</td>
    <td>${escapeHtml(teamNameOf(t.to_team))}</td>
    <td><span class="pill" style="font-size: 12px;">${escapeHtml(t.status)}</span></td>
  </tr>`).join('');
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('h3', {}, `近期交易（${hist.length}）`)),
    el('div', { class: 'table-wrap' }),
  );
  card.querySelector('.table-wrap').innerHTML =
    `<table class="standings-table"><thead><tr><th>週</th><th>發起</th><th></th><th>收件</th><th>狀態</th></tr></thead><tbody>${rows}</tbody></table>`;
  container.append(card);
}

// -------- Management actions -------------------------------------------------
async function onLeagueStartSeason() {
  try {
    await api('/api/season/start', { method: 'POST' });
    toast('賽季已開始', 'info');
    // Refresh draft + league data then re-render
    await refreshState();
    render();
  } catch (e) {
    toast(e.message || '開始賽季失敗', 'error');
  }
}

async function onLeagueAdvanceDay() {
  if (state.advancing) return;
  state.advancing = true;
  _logMgmt('推進一天中…');
  try {
    await api('/api/season/advance-day', {
      method: 'POST',
      body: JSON.stringify({ use_ai: false }),  // heuristic = fast (LLM per team per day was 60+s)
    });
    await refreshLeagueData();
    const wk = state.standings?.current_week ?? '?';
    const dy = state.standings?.current_day ?? '?';
    _logMgmt(`✅ 已推進至 W${wk} D${dy}`);
    rerenderLeagueSubFromTabs();
    render();  // also refresh top action bar so the visible W/D counter updates
    toast(`✅ 推進到 W${wk} D${dy}`, 'info');
  } catch (e) {
    _logMgmt(`❌ 推進失敗：${e.message || ''}`);
    toast(e.message || '推進失敗', 'error');
  } finally {
    state.advancing = false;
  }
}

function onLeagueAdvanceWeek() {
  if (state.advancing) return;
  state.advancing = true;
  _logMgmt('🗓 推進一週（SSE 串流）…');
  // M19: register the EventSource on state so route/league switches can close
  // it via closeActiveES(); also close any prior stream still hanging around.
  closeActiveES();
  let es = null;
  const finish = () => {
    if (state.activeES === es) state.activeES = null;
    state.advancing = false;
  };
  try {
    es = new EventSource('/api/season/advance-week/stream');
    state.activeES = es;
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        if (payload.error) {
          _logMgmt(`❌ ${payload.error}`);
          toast(payload.error, 'error');
          es.close();
          finish();
          return;
        }
        if (payload.done) {
          _logMgmt(`✅ 本週推進完成（W${payload.week}）`);
          toast('推進一週完成', 'info');
          es.close();
          finish();
          refreshLeagueData().then(() => rerenderLeagueSubFromTabs());
          return;
        }
        _logMgmt(`· W${payload.week} D${payload.day} 完成`);
        toast(`W${payload.week} D${payload.day}`, 'info', 1200);
      } catch (err) {
        console.warn('SSE parse', err);
      }
    };
    es.onerror = () => {
      _logMgmt('⚠ SSE 連線中斷');
      es.close();
      finish();
      refreshLeagueData().then(() => rerenderLeagueSubFromTabs());
    };
  } catch (e) {
    _logMgmt(`❌ 串流失敗：${e.message || ''}`);
    toast(e.message || '推進一週失敗', 'error');
    state.advancing = false;
  }
}

async function onLeagueResetSeason() {
  if (!confirm('確定重置整個賽季？所有戰績與動態會被清除（選秀保留）。')) return;
  try {
    await api('/api/season/reset', { method: 'POST' });
    toast('賽季已重置', 'info');
    await refreshLeagueData();
    render();
  } catch (e) {
    toast(e.message || '重置失敗', 'error');
  }
}

async function onLeagueSimToPlayoffs() {
  if (state.advancing) return;
  if (!confirm('模擬到季後賽？將逐週推進剩餘例行賽（每週 20-40 秒，共 20 週），可以在日誌看進度。')) return;
  state.advancing = true;
  _logMgmt('⏩ 模擬剩餘例行賽中…');

  // Loop weekly streams (each stream is below Cloudflare's 60s timeout) until
  // we either enter the playoffs or champion is set. Use heuristic (use_ai=false)
  // so each week finishes in seconds rather than minutes.
  // M19: each per-week stream is registered on state.activeES so a route /
  // league change can close it via closeActiveES().
  const streamOneWeek = () => new Promise((resolve, reject) => {
    closeActiveES();
    const es = new EventSource('/api/season/advance-week/stream?use_ai=false');
    state.activeES = es;
    const cleanup = () => { try { es.close(); } catch {} if (state.activeES === es) state.activeES = null; };
    es.onmessage = (ev) => {
      try {
        const p = JSON.parse(ev.data);
        if (p.error) { cleanup(); reject(new Error(p.error)); return; }
        if (p.done) { cleanup(); resolve(p); return; }
        _logMgmt(`· W${p.week} D${p.day}`);
      } catch (err) { /* ignore parse errors */ }
    };
    es.onerror = () => { cleanup(); reject(new Error('SSE 中斷')); };
  });

  try {
    for (let guard = 0; guard < 30; guard++) {
      await streamOneWeek();
      await refreshLeagueData();
      const st = state.standings || {};
      if (st.is_playoffs || st.champion) break;
      if (st.current_week >= (st.regular_weeks || 20)) break;
    }
    // After last regular week, POST sim-to-playoffs once to flip the flag if needed
    const st = state.standings || {};
    if (!st.is_playoffs && !st.champion) {
      await api('/api/season/sim-to-playoffs', {
        method: 'POST',
        body: JSON.stringify({ use_ai: false }),
      });
      await refreshLeagueData();
    }
    _logMgmt('✅ 例行賽模擬完成，準備進入季後賽');
    rerenderLeagueSubFromTabs();
    toast('例行賽模擬完成', 'info');
  } catch (e) {
    _logMgmt(`❌ 模擬失敗：${e.message || ''}`);
    toast(e.message || '模擬失敗', 'error');
  } finally {
    state.advancing = false;
  }
}

async function onLeagueSimPlayoffs() {
  if (state.advancing) return;
  if (!confirm('模擬季後賽淘汰賽？將跑完整個 bracket（約 10-20 秒）。')) return;
  state.advancing = true;
  _logMgmt('🏆 模擬季後賽 bracket 中…');
  try {
    await api('/api/season/sim-playoffs', {
      method: 'POST',
      body: JSON.stringify({ use_ai: false }),
    });
    await refreshLeagueData();
    const champ = state.standings?.champion;
    _logMgmt(champ != null ? `🏆 冠軍：${teamNameOf(champ)}` : '✅ 季後賽模擬完成');
    rerenderLeagueSubFromTabs();
    toast('季後賽模擬完成', 'info');
  } catch (e) {
    _logMgmt(`❌ 模擬失敗：${e.message || ''}`);
    toast(e.message || '季後賽模擬失敗', 'error');
  } finally {
    state.advancing = false;
  }
}

function _logMgmt(line) {
  const box = $('#league-mgmt-log');
  if (!box) return;
  if (box.querySelector('.empty-state')) box.innerHTML = '';
  const row = el('div', { class: 'mgmt-log-row' },
    el('span', { class: 'mgmt-log-time' }, new Date().toLocaleTimeString()),
    el('span', { class: 'mgmt-log-text' }, line),
  );
  box.append(row);
  box.scrollTop = box.scrollHeight;
}

function rerenderLeagueSubFromTabs() {
  const holder = $('#league-sub-body');
  if (holder) {
    holder.innerHTML = '';
    renderLeagueSubBody(holder);
  }
}

// ================================================================ SCHEDULE VIEW (Phase 6)
async function renderScheduleView(root) {
  const d = state.draft;
  if (!d) {
    root.append(el('div', { class: 'card card-pad' }, '載入中…'));
    return;
  }
  if (!d.is_complete) {
    root.append(
      el('div', { class: 'view-head' },
        el('div', { class: 'view-title-block' },
          el('span', { class: 'eyebrow' }, '賽程'),
          el('div', { class: 'view-title' }, '請先完成選秀'),
          el('div', { class: 'view-sub' }, '賽程將在賽季開始後生成。'),
        ),
        el('div', { class: 'view-actions' },
          el('a', { class: 'btn', href: '#/draft' }, '前往選秀'),
        ),
      ),
    );
    return;
  }

  // Head
  root.append(
    el('div', { class: 'view-head' },
      el('div', { class: 'view-title-block' },
        el('span', { class: 'eyebrow' }, '賽程'),
        el('div', { class: 'view-title', id: 'schedule-title' }, '載入中…'),
        el('div', { class: 'view-sub', id: 'schedule-sub' }, ' '),
      ),
    ),
  );

  await refreshLeagueData();

  const sched = state.schedule?.schedule || [];
  if (!sched.length) {
    const title = $('#schedule-title'); if (title) title.textContent = '賽季尚未開始';
    const sub = $('#schedule-sub'); if (sub) sub.textContent = '賽程將在賽季開始後生成。';
    root.append(
      el('div', { class: 'card card-pad' },
        el('div', { class: 'empty-state' }, '尚無賽程資料，請先開始賽季。'),
        el('a', { class: 'btn', href: '#/league', style: 'margin-top:12px;' }, '前往聯盟'),
      ),
    );
    return;
  }

  const curWk = currentWeek();
  const regWk = regularWeeks();
  const title = $('#schedule-title');
  if (title) title.textContent = `第 ${curWk} 週 · ${sched.length} 場`;
  const sub = $('#schedule-sub');
  if (sub) sub.textContent = `例行賽 ${regWk} 週 · 季後賽隨後`;

  // Build week grid
  const byWeek = new Map();
  for (const m of sched) {
    if (!byWeek.has(m.week)) byWeek.set(m.week, []);
    byWeek.get(m.week).push(m);
  }
  const weeks = Array.from(byWeek.keys()).sort((a, b) => a - b);

  const grid = el('div', { class: 'schedule-grid-v2' });
  for (const wk of weeks) {
    const matchups = byWeek.get(wk) || [];
    const isPlayoff = wk > regWk;
    const played = matchups.length && matchups.every((m) => m.complete);
    const isCurrent = wk === curWk;
    const cls = ['week-cell-v2'];
    if (isCurrent) cls.push('current');
    if (played)    cls.push('played');
    if (isPlayoff) cls.push('playoff');

    const cell = el('button', {
      class: cls.join(' '),
      type: 'button',
      onclick: () => {
        state.scheduleOpenWeek = (state.scheduleOpenWeek === wk) ? null : wk;
        state.scheduleOpenMatch = null;
        rerenderScheduleBody(root);
      },
    },
      el('span', { class: 'wk-num' }, isPlayoff ? `季後賽 W${wk}` : `第 ${wk} 週`),
      el('span', { class: 'wk-title' }, played ? '已結束' : isCurrent ? '進行中' : '未開始'),
      el('span', { class: 'wk-sub' }, `${matchups.length} 場對戰`),
    );
    grid.append(cell);
  }

  const card = el('div', { class: 'card', id: 'schedule-card' },
    el('div', { class: 'card-header' }, el('h3', {}, '週次網格')),
    el('div', { class: 'card-body' }, grid),
  );
  root.append(card);

  // Details panel (inline expansion)
  const detailSlot = el('div', { id: 'schedule-detail-slot' });
  root.append(detailSlot);
  renderScheduleDetail(detailSlot, byWeek);
}

function rerenderScheduleBody(root) {
  // Rebuild just the grid + detail slot based on open state
  const sched = state.schedule?.schedule || [];
  const byWeek = new Map();
  for (const m of sched) {
    if (!byWeek.has(m.week)) byWeek.set(m.week, []);
    byWeek.get(m.week).push(m);
  }
  // Refresh cell highlight
  const grid = root.querySelector('.schedule-grid-v2');
  if (grid) {
    const curWk = currentWeek();
    const regWk = regularWeeks();
    const weeks = Array.from(byWeek.keys()).sort((a, b) => a - b);
    grid.innerHTML = '';
    for (const wk of weeks) {
      const matchups = byWeek.get(wk) || [];
      const isPlayoff = wk > regWk;
      const played = matchups.length && matchups.every((m) => m.complete);
      const isCurrent = wk === curWk;
      const isOpen = state.scheduleOpenWeek === wk;
      const cls = ['week-cell-v2'];
      if (isCurrent) cls.push('current');
      if (played)    cls.push('played');
      if (isPlayoff) cls.push('playoff');
      if (isOpen)    cls.push('open');
      const cell = el('button', {
        class: cls.join(' '),
        type: 'button',
        onclick: () => {
          state.scheduleOpenWeek = (state.scheduleOpenWeek === wk) ? null : wk;
          state.scheduleOpenMatch = null;
          rerenderScheduleBody(root);
        },
      },
        el('span', { class: 'wk-num' }, isPlayoff ? `季後賽 W${wk}` : `第 ${wk} 週`),
        el('span', { class: 'wk-title' }, played ? '已結束' : isCurrent ? '進行中' : '未開始'),
        el('span', { class: 'wk-sub' }, `${matchups.length} 場對戰`),
      );
      grid.append(cell);
    }
  }
  const slot = root.querySelector('#schedule-detail-slot');
  if (slot) {
    slot.innerHTML = '';
    renderScheduleDetail(slot, byWeek);
  }
}

function renderScheduleDetail(slot, byWeek) {
  const wk = state.scheduleOpenWeek;
  if (wk == null) return;
  const matchups = byWeek.get(wk) || [];
  const regWk = regularWeeks();
  const isPlayoff = wk > regWk;

  const card = el('div', { class: 'card schedule-detail-card' },
    el('div', { class: 'card-header' },
      el('h3', {}, (isPlayoff ? '季後賽 ' : '') + `第 ${wk} 週 · ${matchups.length} 場對戰`),
      el('button', { class: 'btn sm ghost', onclick: () => {
        state.scheduleOpenWeek = null;
        state.scheduleOpenMatch = null;
        rerenderScheduleBody(slot.parentElement || slot);
      } }, '關閉'),
    ),
    el('div', { class: 'card-body' }),
  );
  const body = card.querySelector('.card-body');
  if (!matchups.length) {
    body.append(el('div', { class: 'empty-state' }, '本週無對戰。'));
  } else {
    for (const m of matchups) {
      body.append(buildScheduleMatchupRow(m, wk));
    }
  }
  slot.append(card);
}

function buildScheduleMatchupRow(m, week) {
  const key = `${week}-${m.team_a}-${m.team_b}`;
  const played = !!m.complete || (m.score_a != null && m.score_b != null);
  const winA = played && m.winner === m.team_a;
  const winB = played && m.winner === m.team_b;
  const expanded = state.scheduleOpenMatch === key;

  const head = el('button', {
    type: 'button',
    class: 'sched-match-head',
    onclick: () => {
      state.scheduleOpenMatch = expanded ? null : key;
      rerenderScheduleBody(document.querySelector('#main'));
    },
  },
    el('div', { class: `mm-side ${winA ? 'win' : ''}` },
      el('span', { class: 'mm-name' }, teamNameOf(m.team_a)),
      el('span', { class: 'mm-score' }, played ? fmtStat(m.score_a) : '—'),
    ),
    el('div', { class: 'mm-vs' }, played ? 'vs' : '—'),
    el('div', { class: `mm-side ${winB ? 'win' : ''}` },
      el('span', { class: 'mm-name' }, teamNameOf(m.team_b)),
      el('span', { class: 'mm-score' }, played ? fmtStat(m.score_b) : '—'),
    ),
    el('span', { class: 'chevron' }, expanded ? '▾' : '▸'),
  );

  const wrap = el('div', { class: 'sched-match-row' }, head);
  if (expanded) {
    const detail = el('div', { class: 'sched-match-detail' },
      el('div', { class: 'empty-state' }, '載入逐日數據中…'),
    );
    wrap.append(detail);
    loadScheduleMatchupDetail(week, m.team_a, m.team_b, detail);
  }
  return wrap;
}

async function loadScheduleMatchupDetail(week, teamA, teamB, container) {
  try {
    const data = await api(`/api/season/matchup-detail?week=${week}&team_a=${teamA}&team_b=${teamB}`);
    container.innerHTML = '';
    if (data.logs_trimmed || ((data.players_a || []).length === 0 && (data.players_b || []).length === 0)) {
      container.append(el('div', { class: 'empty-state' }, '舊週逐日資料已清理或尚未開打，僅顯示比分。'));
      return;
    }
    const aggA = aggregateMatchupPlayers(data.players_a);
    const aggB = aggregateMatchupPlayers(data.players_b);
    container.append(
      el('div', { class: 'md-head' },
        el('div', {}, `${data.team_a_name} ${fmtStat(data.score_a)} - ${fmtStat(data.score_b)} ${data.team_b_name}`),
      ),
      el('div', { class: 'md-grid' },
        buildMatchupPlayerTable(aggA, data.team_a_name),
        buildMatchupPlayerTable(aggB, data.team_b_name),
      ),
      buildMatchupDailyTable(data.players_a, data.team_a_name),
      buildMatchupDailyTable(data.players_b, data.team_b_name),
    );
  } catch (e) {
    container.innerHTML = '';
    container.append(el('div', { class: 'empty-state' }, `載入失敗：${escapeHtml(e.message || '')}`));
  }
}

// ================================================================ TRADES VIEW (Phase 7)
async function renderTradesView(root) {
  const d = state.draft;
  if (!d) {
    root.append(el('div', { class: 'card card-pad' }, '載入中…'));
    return;
  }
  if (!d.is_complete) {
    root.append(
      el('div', { class: 'view-head' },
        el('div', { class: 'view-title-block' },
          el('span', { class: 'eyebrow' }, '交易'),
          el('div', { class: 'view-title' }, '請先完成選秀'),
          el('div', { class: 'view-sub' }, '交易功能將在賽季開始後啟用。'),
        ),
        el('div', { class: 'view-actions' },
          el('a', { class: 'btn', href: '#/draft' }, '前往選秀'),
        ),
      ),
    );
    return;
  }

  // Head
  root.append(
    el('div', { class: 'view-head' },
      el('div', { class: 'view-title-block' },
        el('span', { class: 'eyebrow' }, '交易'),
        el('div', { class: 'view-title', id: 'trades-title' }, '交易中心'),
        el('div', { class: 'view-sub', id: 'trades-sub' }, ' '),
      ),
      el('div', { class: 'view-actions' }),
    ),
  );

  // Tabs
  root.append(buildTradesTabsV2());

  // Body container
  const body = el('div', { id: 'trades-sub-body' });
  root.append(body);

  // Propose modal (hidden by default; reused)
  root.append(buildProposeModalV2());
  // Counter-offer modal (hidden by default; reused for rejected trades)
  root.append(buildCounterModalV2());

  await refreshLeagueData();   // for team names
  await refreshTradesV2();
  renderTradesSubBody(body);
}

function buildTradesTabsV2() {
  const active = state.tradesTab || 'pending';
  const tabs = [
    { id: 'pending',  label: '待處理' },
    { id: 'history',  label: '歷史' },
    { id: 'propose',  label: '發起' },
  ];
  const wrap = el('div', { class: 'league-tabs-v2', role: 'tablist' });
  for (const t of tabs) {
    const btn = el('button', {
      type: 'button',
      class: `lt2 ${active === t.id ? 'active' : ''}`,
      role: 'tab',
      'aria-selected': active === t.id ? 'true' : 'false',
      onclick: () => {
        state.tradesTab = t.id;
        const holder = $('#trades-sub-body');
        if (holder) {
          wrap.querySelectorAll('.lt2').forEach((b) => {
            const is = b.textContent === t.label;
            b.classList.toggle('active', is);
            b.setAttribute('aria-selected', is ? 'true' : 'false');
          });
          holder.innerHTML = '';
          renderTradesSubBody(holder);
        }
      },
    }, t.label);
    wrap.append(btn);
  }
  return wrap;
}

function renderTradesSubBody(container) {
  const tab = state.tradesTab || 'pending';
  if (tab === 'pending')  return renderTradesPendingSub(container);
  if (tab === 'history')  return renderTradesHistorySub(container);
  if (tab === 'propose')  return renderTradesProposeSub(container);
}

async function refreshTradesV2() {
  const [pendingPayload, historyPayload] = await Promise.all([
    apiSoft('/api/trades/pending'),
    apiSoft('/api/trades/history?limit=50'),
  ]);
  // Normalize pending
  let pending = [];
  if (Array.isArray(pendingPayload)) pending = pendingPayload;
  else if (pendingPayload && Array.isArray(pendingPayload.pending)) pending = pendingPayload.pending;
  state.tradesPending = pending;

  // Normalize history
  let hist = [];
  if (Array.isArray(historyPayload)) hist = historyPayload;
  else if (historyPayload && Array.isArray(historyPayload.history)) hist = historyPayload.history;
  hist = hist.slice().sort((a, b) => {
    const wA = a.proposed_week ?? 0, wB = b.proposed_week ?? 0;
    const dA = a.executed_day ?? a.proposed_day ?? 0;
    const dB = b.executed_day ?? b.proposed_day ?? 0;
    return (wB * 1000 + dB) - (wA * 1000 + dA);
  });
  state.tradesHistory = hist;

  // Pre-cache involved players
  const ids = new Set();
  for (const t of pending) {
    for (const pid of (t.send_player_ids || [])) ids.add(pid);
    for (const pid of (t.receive_player_ids || [])) ids.add(pid);
  }
  for (const t of hist) {
    for (const pid of (t.send_player_ids || [])) ids.add(pid);
    for (const pid of (t.receive_player_ids || [])) ids.add(pid);
  }
  await ensurePlayersCachedV2(Array.from(ids));

  // Update subtitle
  const sub = $('#trades-sub');
  if (sub) {
    sub.textContent = `${pending.length} 待處理 · ${hist.length} 歷史`;
  }
}

async function ensurePlayersCachedV2(ids) {
  const need = ids.filter((id) => !state.playerCache.has(id));
  if (!need.length) return;
  try {
    const all = await api('/api/players?limit=600&available=false');
    for (const p of all) state.playerCache.set(p.id, p);
  } catch { /* ignore */ }
}

function startTradesPolling() {
  // M21: stale tick guard — capture viewToken at schedule time so a tick
  // landing after a route change can detect it and skip the DOM write.
  if (state.tradesPollTimer) return;
  const tok = state.viewToken;
  state.tradesPollTimer = setInterval(async () => {
    // Bail out if user navigated away (and clear ourselves so we don't keep
    // ticking even though render() is supposed to call stopTradesPolling).
    if (currentRoute() !== 'trades' || isViewStale(tok)) {
      stopTradesPolling();
      return;
    }
    await refreshTradesV2();
    if (currentRoute() !== 'trades' || isViewStale(tok)) return;
    const body = $('#trades-sub-body');
    if (body && (state.tradesTab === 'pending' || state.tradesTab === 'history')) {
      body.innerHTML = '';
      renderTradesSubBody(body);
    }
  }, 8000);
}

function stopTradesPolling() {
  if (state.tradesPollTimer) {
    clearInterval(state.tradesPollTimer);
    state.tradesPollTimer = null;
  }
}

// -------- Pending sub-tab ----------------------------------------------------
function renderTradesPendingSub(container) {
  const list = state.tradesPending || [];
  if (!list.length) {
    container.append(el('div', { class: 'card card-pad' },
      el('div', { class: 'empty-state' }, '目前沒有待處理交易。')));
    return;
  }
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('h3', {}, `待處理（${list.length}）`)),
    el('div', { class: 'card-body trade-list' }),
  );
  const body = card.querySelector('.card-body');
  for (const t of list) body.append(buildTradeCardV2(t, { pending: true }));
  container.append(card);
}

// -------- History sub-tab ----------------------------------------------------
function renderTradesHistorySub(container) {
  const list = state.tradesHistory || [];
  if (!list.length) {
    container.append(el('div', { class: 'card card-pad' },
      el('div', { class: 'empty-state' }, '尚無交易紀錄。')));
    return;
  }
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('h3', {}, `歷史（${list.length}）`)),
    el('div', { class: 'card-body trade-list' }),
  );
  const body = card.querySelector('.card-body');
  for (const t of list) body.append(buildTradeCardV2(t, { pending: false }));
  container.append(card);
}

function buildTradeCardV2(trade, opts) {
  const pending = !!opts.pending;
  const card = el('div', { class: `trade-card-v2 status-${trade.status}` });
  const fromName = teamNameOf(trade.from_team);
  const toName   = teamNameOf(trade.to_team);

  const sendPlayers = (trade.send_player_ids || []).map((id) => state.playerCache.get(id)).filter(Boolean);
  const recvPlayers = (trade.receive_player_ids || []).map((id) => state.playerCache.get(id)).filter(Boolean);
  const sendSum = sendPlayers.reduce((s, p) => s + (p.fppg || 0), 0);
  const recvSum = recvPlayers.reduce((s, p) => s + (p.fppg || 0), 0);

  // Head: teams + status
  const statusMap = {
    'pending_accept': '等待回應', 'accepted': '已接受（否決期）', 'vetoed': '已否決',
    'executed': '已完成', 'rejected': '已拒絕', 'expired': '已過期', 'countered': '已還價',
  };
  const statusLabel = statusMap[trade.status] || trade.status;
  const wkDay = `W${trade.proposed_week ?? '?'} D${trade.executed_day ?? trade.proposed_day ?? '?'}`;

  card.append(
    el('div', { class: 'trade-head-v2' },
      el('div', { class: 'trade-teams' },
        el('span', { class: 'tm from' }, fromName),
        el('span', { class: 'arrow' }, '→'),
        el('span', { class: 'tm to' }, toName),
      ),
      el('span', { class: `trade-status-v2 status-${trade.status}` }, statusLabel),
      el('span', { class: 'trade-when' }, wkDay),
    ),
  );

  // Sides
  card.append(el('div', { class: 'trade-sides-v2' },
    buildTradeSideV2(`${fromName} 送出`, sendPlayers, sendSum),
    buildTradeSideV2(`${toName} 送出`, recvPlayers, recvSum),
  ));

  // Reasoning / message / proposer_message
  if (trade.reasoning && trade.reasoning !== 'human') {
    card.append(el('div', { class: 'trade-reasoning-v2' }, trade.reasoning));
  }
  if (trade.proposer_message) {
    card.append(el('div', { class: 'trade-proposer-msg-v2' },
      el('span', { class: 'lbl' }, '提案者留言：'),
      el('span', {}, trade.proposer_message),
    ));
  }

  // Counter-offer chain: walk back via counter_of through history + pending so
  // user can see "原始提案 → 還價 1 → 還價 2 → 此提案".
  if (trade.counter_of) {
    const chain = buildCounterChainV2(trade);
    if (chain) card.append(chain);
  }

  // Category-odds (pending only)
  if (pending) {
    card.append(buildTradeOddsSectionV2(trade));
  }

  // Actions: pending → accept/reject/cancel + incoming counter; accepted →
  // veto window for non-trader humans; history rejected w/ human proposer →
  // counter-offer.
  const humanId = state.draft?.human_team_id ?? 0;
  const canCounter = !pending && trade.status === 'rejected' && trade.from_team === humanId;
  const canVeto = pending && trade.status === 'accepted'
    && trade.from_team !== humanId && trade.to_team !== humanId;
  if (pending || canCounter || canVeto) {
    const actions = buildTradeActionsV2(trade);
    if (actions) card.append(actions);
  }

  return card;
}

function buildCounterChainV2(trade) {
  // Walk back through counter_of pointers using cached pending+history lists.
  const lookup = new Map();
  for (const t of (state.tradesPending || [])) lookup.set(t.id, t);
  for (const t of (state.tradesHistory || [])) lookup.set(t.id, t);

  const chain = [];
  let cur = trade.counter_of ? lookup.get(trade.counter_of) : null;
  let guard = 0;
  while (cur && guard < 8) {
    chain.unshift(cur);
    cur = cur.counter_of ? lookup.get(cur.counter_of) : null;
    guard += 1;
  }
  if (!chain.length) {
    // We know there was a counter_of but couldn't resolve the parent — show a
    // stub so the user at least knows this is a counter.
    return el('div', { class: 'trade-counter-chain-v2', style: 'padding: var(--s-2) var(--s-4); color: var(--ink-3); font-size: var(--fs-xs); border-top: 1px dashed var(--line-soft);' },
      `↩ 此為還價（原始提案 ${trade.counter_of.slice(0, 6)}… 已不在快取中）`);
  }
  const wrap = el('div', { class: 'trade-counter-chain-v2', style: 'padding: var(--s-2) var(--s-4); border-top: 1px dashed var(--line-soft);' });
  wrap.append(el('div', { style: 'font-size: var(--fs-xs); color: var(--ink-3); margin-bottom: 4px;' }, '🔗 還價鏈'));
  for (let i = 0; i < chain.length; i++) {
    const t = chain[i];
    const indent = '　'.repeat(i);
    const arrow = i === 0 ? '原始' : `第 ${i} 次還價`;
    wrap.append(el('div', { style: 'font-size: var(--fs-xs); color: var(--ink-2); line-height: 1.6;' },
      `${indent}${i > 0 ? '↳ ' : ''}${arrow}：${escapeHtml(teamNameOf(t.from_team))} → ${escapeHtml(teamNameOf(t.to_team))} · 狀態 ${t.status}`));
  }
  wrap.append(el('div', { style: 'font-size: var(--fs-xs); color: var(--accent); line-height: 1.6;' },
    `${'　'.repeat(chain.length)}↳ 第 ${chain.length} 次還價（此提案）`));
  return wrap;
}

function buildTradeSideV2(title, players, sum) {
  const wrap = el('div', { class: 'trade-side-v2' },
    el('div', { class: 'trade-side-title' }, title),
  );
  const list = el('ul', { class: 'trade-player-list-v2' });
  if (!players.length) {
    list.append(el('li', { class: 'empty' }, '（無）'));
  } else {
    for (const p of players) {
      list.append(el('li', {},
        el('span', { class: 'pname' }, p.name || `#${p.id}`),
        el('span', { class: 'pmeta' }, `${p.pos || ''} · ${fppg(p.fppg)}`),
      ));
    }
  }
  wrap.append(list);
  wrap.append(el('div', { class: 'trade-side-sum' }, `Σ ${fppg(sum)} FPPG`));
  return wrap;
}

function buildTradeOddsSectionV2(trade) {
  const open = state.tradesOddsOpen.has(trade.id);
  const wrap = el('div', { class: 'trade-odds-section-v2' });
  const toggle = el('button', {
    type: 'button',
    class: 'btn sm ghost trade-odds-toggle-v2',
    onclick: () => onToggleTradeOddsV2(trade.id),
  },
    el('span', {}, (open ? '▾' : '▸') + ' 勝率分析（各統計類別）'),
  );
  wrap.append(toggle);
  if (open) {
    const body = el('div', { class: 'trade-odds-body-v2' },
      el('div', { class: 'empty-state' }, '載入中…'),
    );
    wrap.append(body);
    const cached = state.tradesOddsCache.get(trade.id);
    if (cached) {
      body.innerHTML = '';
      body.append(buildTradeOddsTableV2(cached));
    } else {
      apiSoft(`/api/trades/${trade.id}/category-odds`).then((payload) => {
        if (!payload) {
          body.innerHTML = '';
          body.append(el('div', { class: 'empty-state' }, '無法載入勝率分析'));
          return;
        }
        state.tradesOddsCache.set(trade.id, payload);
        body.innerHTML = '';
        body.append(buildTradeOddsTableV2(payload));
      });
    }
  }
  return wrap;
}

async function onToggleTradeOddsV2(tradeId) {
  if (state.tradesOddsOpen.has(tradeId)) state.tradesOddsOpen.delete(tradeId);
  else state.tradesOddsOpen.add(tradeId);
  const body = $('#trades-sub-body');
  if (body) { body.innerHTML = ''; renderTradesSubBody(body); }
}

function buildTradeOddsTableV2(payload) {
  const labelMap = { pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK', to: 'TO' };
  const cats = payload.categories || {};
  const list = el('ul', { class: 'trade-odds-list-v2' });
  for (const key of ['pts', 'reb', 'ast', 'stl', 'blk', 'to']) {
    const c = cats[key];
    if (!c) continue;
    const sign = c.delta > 0 ? '+' : '';
    const cls = c.favorable ? 'odds-pos' : (c.delta === 0 ? 'odds-zero' : 'odds-neg');
    list.append(el('li', { class: 'trade-odds-row-v2' },
      el('span', { class: 'trade-odds-label' }, labelMap[key] || key),
      el('span', { class: `trade-odds-delta ${cls}` }, `${sign}${c.delta}`),
      el('span', { class: 'trade-odds-detail' }, `送 ${c.send} → 收 ${c.receive}`),
    ));
  }
  const fp = payload.fp_delta_per_game;
  const fpCls = fp > 0 ? 'odds-pos' : (fp === 0 ? 'odds-zero' : 'odds-neg');
  const fpSign = fp > 0 ? '+' : '';
  return el('div', {},
    list,
    el('div', { class: 'trade-odds-fp-v2' },
      el('span', {}, '加權 FP/場 變化'),
      el('span', { class: `trade-odds-delta ${fpCls}` }, `${fpSign}${fp}`),
    ),
  );
}

function buildTradeActionsV2(trade) {
  const humanId = state.draft?.human_team_id ?? 0;
  const status = trade.status;
  const actions = el('div', { class: 'trade-actions-v2' });

  if (status === 'pending_accept' && trade.to_team === humanId) {
    actions.append(
      el('button', { class: 'btn sm', onclick: () => onAcceptTradeV2(trade.id) }, '接受'),
      el('button', { class: 'btn sm ghost', onclick: () => onRejectTradeV2(trade.id) }, '拒絕'),
      el('button', { class: 'btn sm ghost', onclick: () => openCounterTradeDialogV2(trade, { incoming: true }) }, '還價'),
    );
    return actions;
  }
  if (status === 'pending_accept' && trade.from_team === humanId) {
    actions.append(
      el('button', { class: 'btn sm ghost', onclick: () => onCancelTradeV2(trade.id) }, '取消'),
    );
    return actions;
  }
  // Veto window: trade is accepted but not yet executed. Anyone except the
  // two trade parties may cast a veto vote. Show count + button (or "已投票"
  // pill if the human already voted).
  if (status === 'accepted' && trade.from_team !== humanId && trade.to_team !== humanId) {
    const settings = state.leagueSettings || {};
    const threshold = settings.veto_threshold ?? 3;
    const voted = Array.isArray(trade.veto_votes) && trade.veto_votes.includes(humanId);
    const total = Array.isArray(trade.veto_votes) ? trade.veto_votes.length : 0;
    actions.append(
      el('span', { class: 'pill', style: 'font-size: 12px;' },
        `否決票 ${total} / ${threshold}`),
      voted
        ? el('span', { class: 'pill warn', style: 'font-size: 12px;' }, '✓ 你已投票')
        : el('button', { class: 'btn sm ghost', onclick: () => onVetoTradeV2(trade.id) }, '否決'),
    );
    return actions;
  }
  // Counter-offer entry point on trades that were rejected while the human was
  // the proposer. Only the proposer side gets to counter (the rejector has
  // already spoken — they can re-propose via the normal flow if they want).
  if (status === 'rejected' && trade.from_team === humanId) {
    actions.append(
      el('button', { class: 'btn sm', onclick: () => openCounterTradeDialogV2(trade) }, '還價'),
    );
    return actions;
  }
  return null;
}

async function onVetoTradeV2(id) {
  const humanId = state.draft?.human_team_id ?? 0;
  if (!confirm('確定對此交易投下否決票？達到門檻後交易將被否決。')) return;
  try {
    await api(`/api/trades/${id}/veto`, {
      method: 'POST',
      body: JSON.stringify({ team_id: humanId }),
    });
    toast('已投否決票', 'info');
    await afterTradeMutationV2();
  } catch (e) { toast(e.message || '否決失敗', 'error'); }
}

async function onAcceptTradeV2(id) {
  try {
    await api(`/api/trades/${id}/accept`, { method: 'POST' });
    toast('交易已接受', 'info');
    await afterTradeMutationV2();
  } catch (e) { toast(e.message || '接受失敗', 'error'); }
}

async function onRejectTradeV2(id) {
  try {
    await api(`/api/trades/${id}/reject`, { method: 'POST' });
    toast('交易已拒絕', 'info');
    await afterTradeMutationV2();
  } catch (e) { toast(e.message || '拒絕失敗', 'error'); }
}

async function onCancelTradeV2(id) {
  if (!confirm('取消你的交易提案？此操作無法復原。')) return;
  try {
    await api(`/api/trades/${id}/cancel`, { method: 'POST' });
    toast('交易已取消', 'info');
    await afterTradeMutationV2();
  } catch (e) { toast(e.message || '取消失敗', 'error'); }
}

async function afterTradeMutationV2() {
  await refreshTradesV2();
  const body = $('#trades-sub-body');
  if (body) { body.innerHTML = ''; renderTradesSubBody(body); }
}

// -------- Propose sub-tab (info + button) ----------------------------------
function renderTradesProposeSub(container) {
  container.append(
    el('div', { class: 'card card-pad' },
      el('h3', {}, '發起新交易'),
      el('p', { style: 'color:var(--ink-3); font-size:var(--fs-sm); margin:12px 0;' },
        '選擇一支隊伍，從雙方名單勾選球員後送出提案。AI GM 會在幾秒內回覆（接受／拒絕／還價）。'),
      el('button', { class: 'btn', onclick: openProposeTradeDialogV2 }, '＋ 建立提案'),
    ),
  );

  // Show human's pending outgoing trades here as convenience
  const humanId = state.draft?.human_team_id ?? 0;
  const outgoing = (state.tradesPending || []).filter((t) => t.from_team === humanId);
  if (outgoing.length) {
    const card = el('div', { class: 'card' },
      el('div', { class: 'card-header' }, el('h3', {}, `你的待回覆提案（${outgoing.length}）`)),
      el('div', { class: 'card-body trade-list' }),
    );
    const body = card.querySelector('.card-body');
    for (const t of outgoing) body.append(buildTradeCardV2(t, { pending: true }));
    container.append(card);
  }
}

// -------- Propose modal -----------------------------------------------------
function buildProposeModalV2() {
  const dlg = el('dialog', { class: 'trade-propose-dlg-v2', id: 'trade-propose-v2' },
    el('form', { method: 'dialog', class: 'dialog-inner' },
      el('div', { class: 'dlg-head' },
        el('h2', {}, '發起新交易'),
        el('button', { type: 'button', class: 'icon-btn', onclick: () => $('#trade-propose-v2').close() }, '×'),
      ),
      el('div', { class: 'dlg-body', id: 'trade-propose-body-v2' }),
      el('div', { class: 'dlg-foot' },
        el('label', { class: 'propose-force-label' },
          el('input', { type: 'checkbox', id: 'trade-force-v2' }),
          ' 強制執行（跳過 AI 審核）',
        ),
        el('textarea', {
          id: 'trade-message-v2',
          placeholder: '給對方 GM 的留言（可選）…',
          maxlength: '300',
          rows: '2',
          style: 'width:100%; margin-top:8px;',
        }),
        el('div', { class: 'dlg-actions' },
          el('button', { type: 'button', class: 'btn ghost', onclick: () => $('#trade-propose-v2').close() }, '取消'),
          el('button', { type: 'button', class: 'btn', id: 'btn-trade-propose-submit-v2', onclick: onSubmitProposeTradeV2 }, '送出提案'),
        ),
      ),
    ),
  );
  return dlg;
}

async function openProposeTradeDialogV2() {
  const dlg = $('#trade-propose-v2');
  if (!dlg) return;
  const humanId = state.draft?.human_team_id ?? 0;
  state.proposeDraft = {
    counterparty: null,
    send: new Set(),
    receive: new Set(),
    humanRoster: [],
    counterpartyRoster: [],
  };
  // Reset DOM-side controls too — state.proposeDraft only covers the in-memory
  // model; the message textarea + force checkbox live on the form and
  // previously kept their values from the last submission.
  const msgEl = $('#trade-message-v2');
  if (msgEl) msgEl.value = '';
  const forceEl = $('#trade-force-v2');
  if (forceEl) forceEl.checked = false;
  try {
    const data = await api(`/api/teams/${humanId}`);
    state.proposeDraft.humanRoster = data.players || [];
    for (const p of state.proposeDraft.humanRoster) state.playerCache.set(p.id, p);
  } catch { state.proposeDraft.humanRoster = []; }
  renderProposeBodyV2();
  try { dlg.showModal(); } catch {}
}

async function onCounterpartyChangeV2(e) {
  const id = parseInt(e.target.value, 10);
  state.proposeDraft.counterparty = Number.isFinite(id) ? id : null;
  state.proposeDraft.receive = new Set();
  // M20: abort any prior counterparty roster fetch so a slow earlier response
  // can't overwrite the freshly-picked team's roster (rapid dropdown changes).
  abortActiveTeamFetch();
  if (state.proposeDraft.counterparty != null) {
    const targetId = state.proposeDraft.counterparty;
    const ctrl = new AbortController();
    state.activeTeamFetchAbort = ctrl;
    try {
      const data = await api(`/api/teams/${targetId}`, { signal: ctrl.signal });
      // Drop stale response if user changed counterparty mid-flight.
      if (state.proposeDraft.counterparty !== targetId) return;
      state.proposeDraft.counterpartyRoster = data.players || [];
      for (const p of state.proposeDraft.counterpartyRoster) state.playerCache.set(p.id, p);
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (state.proposeDraft.counterparty !== targetId) return;
      state.proposeDraft.counterpartyRoster = [];
    } finally {
      if (state.activeTeamFetchAbort === ctrl) state.activeTeamFetchAbort = null;
    }
  } else {
    state.proposeDraft.counterpartyRoster = [];
  }
  renderProposeBodyV2();
}

function renderProposeBodyV2() {
  const body = $('#trade-propose-body-v2');
  if (!body) return;
  body.innerHTML = '';
  const humanId = state.draft?.human_team_id ?? 0;

  // Counterparty dropdown
  const opts = [el('option', { value: '' }, '— 選擇對象隊伍 —')];
  for (const t of (state.draft?.teams || [])) {
    if (t.id === humanId) continue;
    opts.push(el('option', { value: String(t.id) }, t.name));
  }
  const select = el('select', { id: 'cp-select-v2', onchange: onCounterpartyChangeV2 }, ...opts);
  if (state.proposeDraft.counterparty != null) select.value = String(state.proposeDraft.counterparty);

  body.append(
    el('div', { class: 'propose-row-v2' },
      el('label', { for: 'cp-select-v2' }, '交易對象'),
      select,
    ),
  );

  if (state.proposeDraft.counterparty == null) {
    body.append(el('div', { class: 'empty-state' }, '選擇隊伍後顯示名單。'));
    return;
  }

  body.append(el('div', { class: 'propose-sides-v2' },
    buildProposeSideV2('送出（你的名單）', state.proposeDraft.humanRoster, state.proposeDraft.send, 'send'),
    buildProposeSideV2('收到（對方名單）', state.proposeDraft.counterpartyRoster, state.proposeDraft.receive, 'receive'),
  ));

  const sendSum = Array.from(state.proposeDraft.send).reduce((s, id) => {
    const p = state.playerCache.get(id); return s + (p?.fppg || 0);
  }, 0);
  const recvSum = Array.from(state.proposeDraft.receive).reduce((s, id) => {
    const p = state.playerCache.get(id); return s + (p?.fppg || 0);
  }, 0);
  const ratio = sendSum > 0 && recvSum > 0
    ? Math.max(sendSum, recvSum) / Math.min(sendSum, recvSum) : 0;
  let ratioCls = 'ok';
  if (ratio > 1.30) ratioCls = 'bad';
  else if (ratio > 1.15) ratioCls = 'warn';

  body.append(
    el('div', { class: 'propose-balance-v2' },
      el('span', {}, `送出 Σ ${fppg(sendSum)}`),
      ratio ? el('span', { class: `trade-ratio-badge ${ratioCls}` }, `比值 ${ratio.toFixed(2)}x`) : el('span', {}, '—'),
      el('span', {}, `收到 Σ ${fppg(recvSum)}`),
    ),
  );
}

function buildProposeSideV2(title, players, selectedSet, which) {
  const wrap = el('div', { class: 'propose-side-v2' },
    el('div', { class: 'propose-side-title' }, title),
  );
  const list = el('ul', { class: 'propose-player-list-v2' });
  const sorted = players.slice().sort((a, b) => (b.fppg || 0) - (a.fppg || 0));
  if (!sorted.length) {
    list.append(el('li', { class: 'empty' }, '（無球員）'));
  } else {
    for (const p of sorted) {
      const checked = selectedSet.has(p.id);
      const li = el('li', { class: checked ? 'selected' : '' },
        el('label', {},
          el('input', {
            type: 'checkbox',
            checked: checked ? true : null,
            onchange: (e) => togglePickPlayerV2(which, p.id, e.target.checked),
          }),
          el('span', { class: 'pname' }, p.name || `#${p.id}`),
          el('span', { class: 'pmeta' }, `${p.pos || ''} · ${fppg(p.fppg)}`),
        ),
      );
      list.append(li);
    }
  }
  wrap.append(list);
  return wrap;
}

function togglePickPlayerV2(which, id, checked) {
  const set = state.proposeDraft[which];
  if (checked) {
    if (set.size >= 3) {
      toast('每方最多 3 名球員', 'info');
      renderProposeBodyV2();
      return;
    }
    set.add(id);
  } else {
    set.delete(id);
  }
  renderProposeBodyV2();
}

async function onSubmitProposeTradeV2() {
  const humanId = state.draft?.human_team_id ?? 0;
  const d = state.proposeDraft;
  if (!d) return;
  if (d.counterparty == null) { toast('請選擇交易對象', 'info'); return; }
  if (!d.send.size || !d.receive.size) { toast('每方至少選一名球員', 'info'); return; }
  const proposerMessage = ($('#trade-message-v2')?.value || '').trim();
  const force = !!$('#trade-force-v2')?.checked;
  const btn = $('#btn-trade-propose-submit-v2');
  if (btn) { btn.disabled = true; btn.textContent = '發送中…'; }
  try {
    await api('/api/trades/propose', {
      method: 'POST',
      body: JSON.stringify({
        from_team: humanId,
        to_team: d.counterparty,
        send: Array.from(d.send),
        receive: Array.from(d.receive),
        proposer_message: proposerMessage,
        force,
      }),
    });
    $('#trade-propose-v2').close();
    toast(force ? '交易已強制執行' : '交易已發起，等 AI 回覆…', 'info');
    state.tradesTab = 'pending';
    await afterTradeMutationV2();
    // Force re-render of the whole view so tabs update
    render();
  } catch (e) {
    toast(e.message || '送出失敗', 'error');
    $('#trade-propose-v2').close();
    const msgEl = $('#trade-message-v2');
    if (msgEl) msgEl.value = '';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '送出提案'; }
  }
}

// -------- Counter-offer modal ----------------------------------------------
function buildCounterModalV2() {
  const dlg = el('dialog', { class: 'trade-propose-dlg-v2', id: 'trade-counter-v2' },
    el('form', { method: 'dialog', class: 'dialog-inner' },
      el('div', { class: 'dlg-head' },
        el('h2', {}, '還價交易'),
        el('button', { type: 'button', class: 'icon-btn', onclick: () => $('#trade-counter-v2').close() }, '×'),
      ),
      el('div', { class: 'dlg-body', id: 'trade-counter-body-v2' }),
      el('div', { class: 'dlg-foot' },
        el('textarea', {
          id: 'trade-counter-message-v2',
          placeholder: '給對方 GM 的留言（可選）…',
          maxlength: '300',
          rows: '2',
          style: 'width:100%; margin-top:8px;',
        }),
        el('div', { class: 'dlg-actions' },
          el('button', { type: 'button', class: 'btn ghost', onclick: () => $('#trade-counter-v2').close() }, '取消'),
          el('button', { type: 'button', class: 'btn', id: 'btn-trade-counter-submit-v2', onclick: onSubmitCounterTradeV2 }, '送出還價'),
        ),
      ),
    ),
  );
  return dlg;
}

async function openCounterTradeDialogV2(originalTrade, opts) {
  const dlg = $('#trade-counter-v2');
  if (!dlg) return;
  const humanId = state.draft?.human_team_id ?? 0;
  const incoming = !!(opts && opts.incoming);
  // For incoming trades (AI proposed to human), flip direction: human sends what
  // they were offered to receive, receives what was being sent to them. For
  // outgoing counter (rejected human proposal), keep same direction.
  const counterparty = incoming ? originalTrade.from_team : originalTrade.to_team;
  const prefillSend = incoming
    ? new Set(originalTrade.receive_player_ids || [])
    : new Set(originalTrade.send_player_ids || []);
  const prefillReceive = incoming
    ? new Set(originalTrade.send_player_ids || [])
    : new Set(originalTrade.receive_player_ids || []);
  state.counterDraft = {
    originalTradeId: originalTrade.id,
    counterparty,
    send: prefillSend,
    receive: prefillReceive,
    fromRoster: [],
    toRoster: [],
  };
  try {
    const [me, them] = await Promise.all([
      api(`/api/teams/${humanId}`),
      api(`/api/teams/${counterparty}`),
    ]);
    state.counterDraft.fromRoster = me.players || [];
    state.counterDraft.toRoster = them.players || [];
    for (const p of state.counterDraft.fromRoster) state.playerCache.set(p.id, p);
    for (const p of state.counterDraft.toRoster) state.playerCache.set(p.id, p);
  } catch {
    state.counterDraft.fromRoster = [];
    state.counterDraft.toRoster = [];
  }
  // Pre-fill message field with placeholder hint
  const msgEl = $('#trade-counter-message-v2');
  if (msgEl) msgEl.value = '';
  renderCounterBodyV2();
  try { dlg.showModal(); } catch {}
}

function renderCounterBodyV2() {
  const body = $('#trade-counter-body-v2');
  if (!body) return;
  body.innerHTML = '';
  const d = state.counterDraft;
  if (!d) return;
  const cpName = teamNameOf(d.counterparty);
  body.append(
    el('div', { style: 'padding: 8px 0 4px; font-size: var(--fs-sm); color: var(--ink-3);' },
      `向 `, el('b', {}, cpName), ` 提出還價。可修改下列雙方球員勾選。`,
    ),
  );

  body.append(el('div', { class: 'propose-sides-v2' },
    buildCounterSideV2('送出（你的名單）', d.fromRoster, d.send, 'send'),
    buildCounterSideV2('收到（對方名單）', d.toRoster, d.receive, 'receive'),
  ));

  const sendSum = Array.from(d.send).reduce((s, id) => {
    const p = state.playerCache.get(id); return s + (p?.fppg || 0);
  }, 0);
  const recvSum = Array.from(d.receive).reduce((s, id) => {
    const p = state.playerCache.get(id); return s + (p?.fppg || 0);
  }, 0);
  const ratio = sendSum > 0 && recvSum > 0
    ? Math.max(sendSum, recvSum) / Math.min(sendSum, recvSum) : 0;
  let ratioCls = 'ok';
  if (ratio > 1.30) ratioCls = 'bad';
  else if (ratio > 1.15) ratioCls = 'warn';

  body.append(
    el('div', { class: 'propose-balance-v2' },
      el('span', {}, `送出 Σ ${fppg(sendSum)}`),
      ratio ? el('span', { class: `trade-ratio-badge ${ratioCls}` }, `比值 ${ratio.toFixed(2)}x`) : el('span', {}, '—'),
      el('span', {}, `收到 Σ ${fppg(recvSum)}`),
    ),
  );
}

function buildCounterSideV2(title, players, selectedSet, which) {
  const wrap = el('div', { class: 'propose-side-v2' },
    el('div', { class: 'propose-side-title' }, title),
  );
  const list = el('ul', { class: 'propose-player-list-v2' });
  const sorted = players.slice().sort((a, b) => (b.fppg || 0) - (a.fppg || 0));
  if (!sorted.length) {
    list.append(el('li', { class: 'empty' }, '（無球員）'));
  } else {
    for (const p of sorted) {
      const checked = selectedSet.has(p.id);
      const li = el('li', { class: checked ? 'selected' : '' },
        el('label', {},
          el('input', {
            type: 'checkbox',
            checked: checked ? true : null,
            onchange: (e) => toggleCounterPlayerV2(which, p.id, e.target.checked),
          }),
          el('span', { class: 'pname' }, p.name || `#${p.id}`),
          el('span', { class: 'pmeta' }, `${p.pos || ''} · ${fppg(p.fppg)}`),
        ),
      );
      list.append(li);
    }
  }
  wrap.append(list);
  return wrap;
}

function toggleCounterPlayerV2(which, id, checked) {
  const set = state.counterDraft[which];
  if (checked) {
    if (set.size >= 3) {
      toast('每方最多 3 名球員', 'info');
      renderCounterBodyV2();
      return;
    }
    set.add(id);
  } else {
    set.delete(id);
  }
  renderCounterBodyV2();
}

async function onSubmitCounterTradeV2() {
  const humanId = state.draft?.human_team_id ?? 0;
  const d = state.counterDraft;
  if (!d) return;
  if (!d.send.size || !d.receive.size) { toast('每方至少選一名球員', 'info'); return; }
  const proposerMessage = ($('#trade-counter-message-v2')?.value || '').trim();
  const btn = $('#btn-trade-counter-submit-v2');
  if (btn) { btn.disabled = true; btn.textContent = '發送中…'; }
  try {
    // Counter-offer posted as a fresh proposal. Backend does not yet accept
    // `counter_of` on this endpoint — when it does, pass it here too.
    await api('/api/trades/propose', {
      method: 'POST',
      body: JSON.stringify({
        from_team: humanId,
        to_team: d.counterparty,
        send: Array.from(d.send),
        receive: Array.from(d.receive),
        proposer_message: proposerMessage,
        counter_of: d.originalTradeId,
        force: false,
      }),
    });
    $('#trade-counter-v2').close();
    toast('還價已送出', 'info');
    state.tradesTab = 'pending';
    await afterTradeMutationV2();
    render();
  } catch (e) {
    toast(e.message || '送出失敗', 'error');
    $('#trade-counter-v2').close();
    const msgEl = $('#trade-counter-message-v2');
    if (msgEl) msgEl.value = '';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '送出還價'; }
  }
}

// ---------------------------------------------------------------- global delegation
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-draft]');
  if (btn && !btn.disabled) {
    const id = parseInt(btn.getAttribute('data-draft'), 10);
    if (!Number.isNaN(id)) onDraftPlayer(id);
  }
  // Injury badge tap → mobile-friendly toast (desktop still gets native title tooltip)
  const inj = e.target.closest('[data-inj-tip]');
  if (inj) {
    const tip = inj.getAttribute('data-inj-tip');
    if (tip) toast(tip, 'info', 4000);
  }
});

// ================================================================ LEAGUE SWITCHER
async function loadLeagues() {
  try {
    const data = await api('/api/leagues/list');
    state.leagues = data.leagues || [];
    state.activeLeague = data.active || 'default';
  } catch {
    state.leagues = [];
    state.activeLeague = 'default';
  }
  renderLeagueSwitcherLabel();
}

function renderLeagueSwitcherLabel() {
  const cur = $('#lsw-current');
  if (!cur) return;
  const active = (state.leagues || []).find((l) => l.league_id === state.activeLeague);
  const label = active ? (active.name || active.league_id) : (state.activeLeague || '—');
  cur.textContent = label;
  cur.title = state.activeLeague || '';
}

function openLeagueSwitchMenu() {
  const menu = $('#league-switch-menu');
  const btn = $('#btn-league-switch');
  if (!menu || !btn) return;
  const leagues = state.leagues || [];
  const active = state.activeLeague;
  const items = leagues.map((l) => {
    const isActive = l.league_id === active;
    const displayName = escapeHtml(l.name || l.league_id);
    const idChip = l.name && l.name !== l.league_id
      ? `<span class="lsw-id-v2">${escapeHtml(l.league_id)}</span>` : '';
    return `
      <div class="lsw-item-v2" role="menuitem">
        <button type="button" class="lsw-pick-v2" data-league="${escapeHtml(l.league_id)}" ${isActive ? 'disabled' : ''}>
          <span class="lsw-check-v2" aria-hidden="true">${isActive ? '✓' : ''}</span>
          <span class="lsw-name-v2">${displayName}</span>
          ${idChip}
          ${l.setup_complete ? '' : '<span class="lsw-tag-v2">未設定</span>'}
        </button>
        ${isActive ? '' : `<button type="button" class="lsw-del-v2" data-league="${escapeHtml(l.league_id)}" title="刪除">×</button>`}
      </div>`;
  }).join('');
  menu.innerHTML = `
    <div class="lsw-list-v2">${items || '<div class="lsw-empty-v2">尚無其他聯盟</div>'}</div>
    <div class="lsw-foot-v2">
      <button type="button" class="lsw-new-v2" id="btn-lsw-new-v2">+ 建立新聯盟</button>
    </div>
  `;
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');

  menu.querySelectorAll('.lsw-pick-v2').forEach((b) => {
    b.addEventListener('click', (e) => {
      const lid = e.currentTarget.dataset.league;
      if (lid) onSwitchLeague(lid);
    });
  });
  menu.querySelectorAll('.lsw-del-v2').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const lid = e.currentTarget.dataset.league;
      if (lid) onDeleteLeague(lid);
    });
  });
  const newBtn = $('#btn-lsw-new-v2');
  if (newBtn) newBtn.addEventListener('click', () => {
    closeLeagueSwitchMenu();
    openNewLeagueModal();
  });
}

function closeLeagueSwitchMenu() {
  const menu = $('#league-switch-menu');
  const btn = $('#btn-league-switch');
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function openNewLeagueModal() {
  const dlg = $('#dlg-new-league-v2');
  // Modal input was renamed from id-v2 to name-v2 in v.38; this opener
  // missed the update and was clearing/focusing nothing, leaving the input
  // unfocused (still worked) but more importantly nobody verified the new
  // selector path before deploy.
  const inp = $('#new-league-name-v2');
  if (!dlg) return;
  if (inp) inp.value = '';
  try { dlg.showModal(); setTimeout(() => inp && inp.focus(), 50); } catch {}
}

async function onSwitchLeague(leagueId) {
  closeLeagueSwitchMenu();
  try {
    await api('/api/leagues/switch', { method: 'POST', body: JSON.stringify({ league_id: leagueId }) });
    toast(`已切換到聯盟 ${leagueId}`);
    setTimeout(() => window.location.reload(), 150);
  } catch (e) {
    toast(`切換失敗：${e.message}`, 'error');
  }
}

// A: share-link button. Calls /api/leagues/share-link (manager-only) and
// shows the URL in a small modal so the owner can copy + send to friends.
async function onShareLeague() {
  let info;
  try {
    info = await api('/api/leagues/share-link');
  } catch (e) {
    if (e.status !== 401) toast(e.message || '無法取得分享連結', 'error');
    return;  // 401 already toasted via _maybeToast401
  }
  const baseUrl = location.origin + location.pathname;
  const fullUrl = baseUrl + (info.qs || '');
  // Try the native clipboard first; fall back to a prompt() so the user can
  // copy manually on browsers that block writeText without user activation.
  let copied = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(fullUrl);
      copied = true;
    }
  } catch {}
  if (copied) {
    toast(`已複製分享連結：${info.league_id}`, 'info', 4000);
  } else {
    // window.prompt lets the user select+copy by hand without us touching the DOM.
    try { window.prompt('複製此分享連結（含 manager token）：', fullUrl); } catch {}
  }
}

async function onCreateLeague() {
  // BUG: input used to be the league_id (folder name) which only allows
  // ASCII alnum/-/_, blocking Chinese names. Split now: user types the
  // display name (any unicode), client mints a short slug for league_id.
  const inp = $('#new-league-name-v2');
  const name = (inp && inp.value || '').trim();
  if (!name) { toast('請輸入聯盟名稱', 'info'); return; }
  // Slug: random 8 hex chars prefixed with timestamp seconds — short, unique,
  // safe for filesystem. The display name is sent separately so the league
  // page can show "我的傳奇聯盟" while disk uses "26-04-28-3f9a1".
  const ts = Math.floor(Date.now() / 1000).toString(36);
  const rnd = Math.random().toString(36).slice(2, 6);
  const lid = `lg-${ts}-${rnd}`;
  try {
    // A: backend now mints a manager_token and returns it in the response.
    // The Set-Cookie header is httponly=False so the browser will adopt it
    // automatically, but we also persist explicitly via setCookie() in case
    // the cookie path/sameSite combo is dropped in some edge case.
    const resp = await api('/api/leagues/create', { method: 'POST', body: JSON.stringify({ league_id: lid, league_name: name, switch: true }) });
    if (resp && resp.manager_token) {
      setCookie('manager_token', resp.manager_token);
    }
    const dlg = $('#dlg-new-league-v2');
    if (dlg) dlg.close();
    toast(`已建立聯盟「${name}」，請完成設定`);
    await loadLeagues();
    await refreshState();
    state.setupForm = makeDefaultSetupFormV2(state.leagueSettings);
    state.setupStep = 1;
    location.hash = '/setup';
    render();
  } catch (e) {
    toast(`建立失敗：${e.message}`, 'error');
  }
}

function confirmDialogV2(title, body) {
  return new Promise((resolve) => {
    const dlg = $('#dlg-confirm-v2');
    if (!dlg) { resolve(window.confirm(`${title}\n\n${body}`)); return; }
    const titleEl = $('#dlg-confirm-title-v2');
    const bodyEl = $('#dlg-confirm-body-v2');
    if (titleEl) titleEl.textContent = title;
    if (bodyEl) bodyEl.textContent = body;
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'ok');
    };
    dlg.addEventListener('close', onClose);
    try { dlg.showModal(); } catch { resolve(window.confirm(`${title}\n\n${body}`)); }
  });
}

async function onDeleteLeague(leagueId) {
  const ok = await confirmDialogV2('刪除聯盟', `確定刪除聯盟「${leagueId}」? 此操作無法還原。`);
  if (!ok) return;
  try {
    await api('/api/leagues/delete', { method: 'POST', body: JSON.stringify({ league_id: leagueId }) });
    toast(`已刪除聯盟 ${leagueId}`);
    await loadLeagues();
    const menu = $('#league-switch-menu');
    if (menu && !menu.hidden) openLeagueSwitchMenu();
  } catch (e) {
    toast(`刪除失敗：${e.message}`, 'error');
  }
}

// ================================================================ SETUP VIEW
function makeDefaultSetupFormV2(existing) {
  const s = existing || {};
  return {
    league_name: s.league_name ?? DEFAULT_SETTINGS_V2.league_name,
    season_year: s.season_year ?? DEFAULT_SETTINGS_V2.season_year,
    player_team_index: s.player_team_index ?? DEFAULT_SETTINGS_V2.player_team_index,
    team_names: s.team_names ? [...s.team_names] : [...DEFAULT_SETTINGS_V2.team_names],
    randomize_draft_order: s.randomize_draft_order ?? DEFAULT_SETTINGS_V2.randomize_draft_order,
    num_teams: s.num_teams ?? DEFAULT_SETTINGS_V2.num_teams,
    roster_size: s.roster_size ?? DEFAULT_SETTINGS_V2.roster_size,
    starters_per_day: s.starters_per_day ?? DEFAULT_SETTINGS_V2.starters_per_day,
    il_slots: s.il_slots ?? DEFAULT_SETTINGS_V2.il_slots,
    scoring_weights: Object.assign({}, DEFAULT_SETTINGS_V2.scoring_weights, s.scoring_weights || {}),
    regular_season_weeks: s.regular_season_weeks ?? DEFAULT_SETTINGS_V2.regular_season_weeks,
    playoff_teams: s.playoff_teams ?? DEFAULT_SETTINGS_V2.playoff_teams,
    trade_deadline_week: s.trade_deadline_week ?? DEFAULT_SETTINGS_V2.trade_deadline_week,
    ai_trade_frequency: s.ai_trade_frequency ?? DEFAULT_SETTINGS_V2.ai_trade_frequency,
    ai_trade_style: s.ai_trade_style ?? DEFAULT_SETTINGS_V2.ai_trade_style,
    veto_threshold: s.veto_threshold ?? DEFAULT_SETTINGS_V2.veto_threshold,
    veto_window_days: s.veto_window_days ?? DEFAULT_SETTINGS_V2.veto_window_days,
    ai_decision_mode: s.ai_decision_mode ?? DEFAULT_SETTINGS_V2.ai_decision_mode,
    draft_display_mode: s.draft_display_mode ?? DEFAULT_SETTINGS_V2.draft_display_mode,
    show_offseason_headlines: s.show_offseason_headlines ?? DEFAULT_SETTINGS_V2.show_offseason_headlines,
    gm_personas: s.gm_personas ? [...s.gm_personas] : [],
  };
}

// m2 tooltips: short helper text per field. Rendered as a `?` chip with title.
const SETUP_TOOLTIPS_V2 = {
  league_name: '聯盟顯示名稱，僅供識別。',
  season_year: '使用哪個球季的球員資料。需要 data/seasons/ 有對應檔。',
  num_teams: '隊伍數：4-12 之間，越多越難搶到大牌。',
  player_team_index: '人類隊位置：你選秀順位（蛇形）。',
  randomize_draft_order: '勾選後選秀順序會在開始前隨機重排。',
  team_names: '每隊顯示名稱。',
  roster_size: '每隊總人數（含先發 + 板凳）。',
  starters_per_day: '每天先發人數，計算當日總分用。',
  il_slots: '傷兵保留位置：受傷球員可暫存於此不佔正式名單。',
  scoring_weights: '計分權重：每項統計加權後加總成 FPPG。',
  regular_season_weeks: '例行賽長度（週數）。',
  trade_deadline_week: '第 N 週後不能交易；留空表示整季皆可。',
  playoff_teams: '季後賽隊伍數，由例行賽戰績前 N 名晉級。',
  gm_persona: '每隊 AI GM 風格，影響選秀偏好與交易行為。',
};

// m1 presets: single-click chips that mutate setupForm.
const TEAM_COUNT_PRESETS_V2 = [
  { label: '8 隊小聯盟', n: 8 },
  { label: '10 隊標準', n: 10 },
  { label: '12 隊大聯盟', n: 12 },
];
const SEASON_LEN_PRESETS_V2 = [
  { label: '14 週短賽季', w: 14 },
  { label: '20 週標準', w: 20 },
  { label: '22 週長賽季', w: 22 },
];

function setupSummaryText(form) {
  const n = form.num_teams || 8;
  const r = form.roster_size || 13;
  const picks = n * r;
  const w = form.regular_season_weeks || 20;
  const dl = form.trade_deadline_week ? `季中 W${form.trade_deadline_week} 截止交易` : '整季皆可交易';
  return `${n} 隊 × ${r} 輪 = ${picks} picks · 例行賽 ${w} 週 · ${dl}`;
}

function renderSetupView(root) {
  const status = state.leagueStatus;
  const isLocked = status && status.setup_complete;
  if (!state.setupForm) state.setupForm = makeDefaultSetupFormV2(state.leagueSettings);
  const form = state.setupForm;
  if (!state.setupStep || state.setupStep < 1 || state.setupStep > 3) state.setupStep = 1;
  const step = state.setupStep;
  const wrap = el('div', { class: 'setup-v2' });

  // If personas weren't loaded yet (boot may have failed softly), fetch once here.
  if (!state.personas || !Object.keys(state.personas).length) {
    apiSoft('/api/personas').then((p) => {
      if (p && Object.keys(p).length) {
        state.personas = p;
        root.innerHTML = '';
        renderSetupView(root);
      }
    }).catch(() => {});
  }

  wrap.append(el('div', { class: 'view-head' },
    el('div', { class: 'view-title-block' },
      el('span', { class: 'eyebrow' }, '聯盟設定'),
      el('div', { class: 'view-title' }, '建立新聯盟 / 設定聯盟'),
      el('div', { class: 'view-sub' }, '完成後會進入選秀階段。'),
    ),
  ));

  // M4: sticky summary chip — updates on rerender
  const summaryChip = el('div', { class: 'setup-summary-chip', id: 'setup-summary-chip-v2' },
    setupSummaryText(form));
  wrap.append(summaryChip);

  if (isLocked) {
    wrap.append(el('div', { class: 'setup-lock-warn' },
      '聯盟已開賽，以下設定已鎖定；如需重新設定請先刪除聯盟或建立新聯盟。'));
  }

  // M3: 3-step stepper indicator
  const STEP_LABELS = ['基本', '規則', '賽程 + Persona'];
  const stepper = el('div', { class: 'setup-stepper' });
  STEP_LABELS.forEach((label, i) => {
    const stepNum = i + 1;
    const cls = stepNum === step ? 'setup-step active' : (stepNum < step ? 'setup-step done' : 'setup-step');
    stepper.append(el('div', { class: cls,
      onclick: isLocked ? null : (() => {
        // Allow click-to-jump only if validation passes for steps before
        if (stepNum < step) { state.setupStep = stepNum; root.innerHTML=''; renderSetupView(root); }
        else if (stepNum === step) { /* noop */ }
        else {
          if (validateSetupStepV2(form, step).length === 0) {
            state.setupStep = stepNum; root.innerHTML=''; renderSetupView(root);
          }
        }
      }),
    },
      el('span', { class: 'setup-step-num' }, String(stepNum)),
      el('span', { class: 'setup-step-label' }, label),
    ));
  });
  wrap.append(stepper);

  // Re-render helper used after any input that changes derived UI (chip, etc.)
  function rerender() { root.innerHTML = ''; renderSetupView(root); }

  function tipChip(key) {
    const text = SETUP_TOOLTIPS_V2[key];
    if (!text) return null;
    return el('span', { class: 'setup-tip', title: text, 'aria-label': text, tabindex: '0' }, '?');
  }
  function section(title, ...children) {
    return el('div', { class: 'setup-section' },
      el('div', { class: 'setup-section-title' }, title),
      ...children,
    );
  }
  function row(label, control, hint, tipKey) {
    const labelNode = el('div', { class: 'setup-label' }, label);
    if (tipKey) {
      const t = tipChip(tipKey);
      if (t) labelNode.append(' ', t);
    }
    const r = el('div', { class: 'setup-row' },
      labelNode,
      el('div', { class: 'setup-control' }, control),
    );
    if (hint) r.append(el('div', { class: 'setup-hint' }, hint));
    return r;
  }
  function radioGroup(name, options, current, onChange) {
    const grp = el('div', { class: 'radio-group' });
    for (const [val, label] of options) {
      const id = `rgv2-${name}-${val}`;
      const inp = el('input', {
        type: 'radio', name, id, value: String(val),
        checked: String(val) === String(current) ? true : null,
        disabled: isLocked ? true : null,
        onchange: () => { onChange(typeof current === 'number' ? Number(val) : val); rerender(); },
      });
      grp.append(el('span', { class: 'radio-item' }, inp, el('label', { for: id }, String(label))));
    }
    return grp;
  }

  // ---------------- Step 1: 基本 ----------------
  function buildStep1() {
    // m1 presets row
    const presetRow = el('div', { class: 'setup-presets' },
      el('span', { class: 'setup-preset-label' }, '快速設定：'),
      ...TEAM_COUNT_PRESETS_V2.map((p) =>
        el('button', { class: 'chip preset-chip', type: 'button', disabled: isLocked ? true : null,
          onclick: () => {
            form.num_teams = p.n;
            const base = DEFAULT_TEAM_NAMES_V2;
            const next = form.team_names.slice(0, p.n);
            while (next.length < p.n) next.push(base[next.length] || `隊伍${next.length}`);
            form.team_names = next;
            if (form.player_team_index >= p.n) form.player_team_index = 0;
            rerender();
          }
        }, p.label)),
    );

    // Team count select (8/10/12)
    const numTeamsSelect = el('select', {
      disabled: isLocked ? true : null,
      onchange: (e) => {
        const n = parseInt(e.target.value, 10);
        form.num_teams = n;
        const base = DEFAULT_TEAM_NAMES_V2;
        const next = form.team_names.slice(0, n);
        while (next.length < n) next.push(base[next.length] || `隊伍${next.length}`);
        form.team_names = next;
        if (form.player_team_index >= n) form.player_team_index = 0;
        rerender();
      },
      html: [8, 10, 12].map((n) =>
        `<option value="${n}" ${n === form.num_teams ? 'selected' : ''}>${n} 隊</option>`).join(''),
    });

    const leagueNameInput = el('input', {
      type: 'text', value: form.league_name, disabled: isLocked ? true : null,
      oninput: (e) => { form.league_name = e.target.value; },
    });

    const SEASON_OPTIONS = (() => {
      const out = [];
      for (let y = 1996; y <= 2025; y++) {
        const next = String((y + 1) % 100).padStart(2, '0');
        out.push(`${y}-${next}`);
      }
      return out;
    })();
    const seasonInput = el('select', {
      disabled: isLocked ? true : null,
      onchange: (e) => { form.season_year = e.target.value; },
      html: SEASON_OPTIONS.map((s) =>
        `<option value="${s}" ${s === form.season_year ? 'selected' : ''}>${s}</option>`).join(''),
    });

    const playerTeamSelect = el('select', {
      disabled: isLocked ? true : null,
      onchange: (e) => { form.player_team_index = parseInt(e.target.value, 10); },
      // Display labels are 1-indexed for humans; option value stays 0-indexed
      // because backend / draft order is 0-based throughout.
      html: form.team_names.slice(0, form.num_teams).map((n, i) =>
        `<option value="${i}" ${i === form.player_team_index ? 'selected' : ''}>${i + 1}. ${escapeHtml(n)}</option>`).join(''),
    });

    const randomizeCheck = el('input', {
      type: 'checkbox', checked: form.randomize_draft_order ? true : null,
      disabled: isLocked ? true : null,
      onchange: (e) => { form.randomize_draft_order = e.target.checked; },
    });

    wrap.append(section('聯盟基本',
      presetRow,
      row('聯盟名稱', leagueNameInput, null, 'league_name'),
      row('賽季年份', seasonInput, '例如 2025-26（需要 data/seasons/ 有對應檔）', 'season_year'),
      row('隊伍數', numTeamsSelect, null, 'num_teams'),
      row('我的隊伍', playerTeamSelect, null, 'player_team_index'),
      row('隨機選秀順序', randomizeCheck, null, 'randomize_draft_order'),
    ));

    // Team names grid — only show first num_teams entries (was rendering all
    // 12 default names even when num_teams was 8). Labels are 1-indexed.
    const namesGrid = el('div', { class: 'setup-team-names' });
    form.team_names.slice(0, form.num_teams).forEach((name, i) => {
      const inp = el('input', {
        type: 'text', value: name,
        placeholder: `隊伍 ${i + 1}`,
        disabled: isLocked ? true : null,
        oninput: (e) => {
          form.team_names[i] = e.target.value;
          const opt = playerTeamSelect.options[i];
          if (opt) opt.textContent = `${i + 1}. ${e.target.value}`;
        },
      });
      namesGrid.append(el('div', { class: 'team-name-row' },
        el('label', {}, String(i + 1)), inp));
    });
    // Team names section (m2: tooltip surfaced via section title)
    const namesTitle = el('div', { class: 'setup-section-title' }, '隊伍名稱 ');
    const tn = tipChip('team_names'); if (tn) namesTitle.append(tn);
    wrap.append(el('div', { class: 'setup-section' }, namesTitle, namesGrid));
  }

  // ---------------- Step 2: 規則 ----------------
  function buildStep2() {
    const weights = form.scoring_weights;
    const weightCats = ['pts', 'reb', 'ast', 'stl', 'blk', 'to'];
    const weightGrid = el('div', { class: 'setup-team-names' });
    for (const cat of weightCats) {
      const inp = el('input', {
        type: 'number', step: '0.1', value: String(weights[cat]),
        disabled: isLocked ? true : null,
        oninput: (e) => { weights[cat] = parseFloat(e.target.value); },
      });
      weightGrid.append(el('div', { class: 'team-name-row' },
        el('label', {}, cat.toUpperCase()), inp));
    }

    wrap.append(section('名單規則',
      row('名單人數', radioGroup('roster_size', [[10,'10'],[13,'13'],[15,'15']], form.roster_size, (v)=>{form.roster_size=v;}), null, 'roster_size'),
      row('每日先發', radioGroup('starters_per_day', [[8,'8'],[10,'10'],[12,'12']], form.starters_per_day, (v)=>{form.starters_per_day=v;}), null, 'starters_per_day'),
      row('傷兵位置', radioGroup('il_slots', [[0,'0'],[1,'1'],[2,'2'],[3,'3 (預設)']], form.il_slots, (v)=>{form.il_slots=v;}), null, 'il_slots'),
    ));

    const scoringTitle = el('div', { class: 'setup-section-title' }, '計分權重 ');
    const tw = tipChip('scoring_weights'); if (tw) scoringTitle.append(tw);
    const scoringSec = el('div', { class: 'setup-section' }, scoringTitle, weightGrid);
    wrap.append(scoringSec);
  }

  // ---------------- Step 3: 賽程 + persona ----------------
  function buildStep3() {
    // Season-length presets (m1)
    const presetRow = el('div', { class: 'setup-presets' },
      el('span', { class: 'setup-preset-label' }, '快速設定：'),
      ...SEASON_LEN_PRESETS_V2.map((p) =>
        el('button', { class: 'chip preset-chip', type: 'button', disabled: isLocked ? true : null,
          onclick: () => {
            form.regular_season_weeks = p.w;
            if (form.trade_deadline_week && form.trade_deadline_week > p.w) form.trade_deadline_week = null;
            rerender();
          }
        }, p.label)),
    );

    // Trade deadline select — options: 無截止 + weeks 1..regular_season_weeks
    const weeksN = form.regular_season_weeks || 20;
    const deadlineOptionsHtml = ['<option value="">無截止</option>']
      .concat(
        Array.from({ length: weeksN }, (_, i) => i + 1).map((w) =>
          `<option value="${w}" ${String(form.trade_deadline_week ?? '') === String(w) ? 'selected' : ''}>W${w}</option>`
        )
      ).join('');
    const deadlineSelect = el('select', {
      disabled: isLocked ? true : null,
      html: deadlineOptionsHtml,
      onchange: (e) => {
        form.trade_deadline_week = e.target.value === '' ? null : parseInt(e.target.value, 10);
        rerender();
      },
    });

    const playoffSelect = el('select', {
      disabled: isLocked ? true : null,
      onchange: (e) => { form.playoff_teams = parseInt(e.target.value, 10); rerender(); },
      html: [2, 4, 6, 8].map((n) =>
        `<option value="${n}" ${n === form.playoff_teams ? 'selected' : ''}>${n} 隊</option>`).join(''),
    });

    wrap.append(section('賽程 & 季後賽',
      presetRow,
      row('例行賽週數', radioGroup('regular_season_weeks', [[14,'14'],[18,'18'],[20,'20'],[22,'22']], form.regular_season_weeks, (v)=>{
        form.regular_season_weeks=v;
        if (form.trade_deadline_week && form.trade_deadline_week > v) form.trade_deadline_week = null;
      }), null, 'regular_season_weeks'),
      row('交易截止週', deadlineSelect, '例行賽中的哪一週為交易截止；留空表示整季皆可交易', 'trade_deadline_week'),
      row('季後賽隊伍數', playoffSelect, null, 'playoff_teams'),
    ));

    // Personas (optional — only show if /api/personas returned keys)
    const personaIds = Object.keys(state.personas || {});
    if (personaIds.length) {
      const personaGrid = el('div', { class: 'setup-team-names' });
      while (form.gm_personas.length < form.num_teams) form.gm_personas.push('');
      form.gm_personas = form.gm_personas.slice(0, form.num_teams);
      for (let i = 0; i < form.num_teams; i++) {
        if (i === form.player_team_index) continue;
        const sel = el('select', {
          disabled: isLocked ? true : null,
          html: '<option value="">(系統預設)</option>' +
            personaIds.map((pid) => {
              const p = state.personas[pid];
              const nm = p && p.name ? `${pid} · ${p.name}` : pid;
              return `<option value="${escapeHtml(pid)}" ${form.gm_personas[i] === pid ? 'selected' : ''}>${escapeHtml(nm)}</option>`;
            }).join(''),
          onchange: (e) => { form.gm_personas[i] = e.target.value; },
        });
        personaGrid.append(el('div', { class: 'persona-row team-name-row' },
          el('label', {}, `${i + 1}. ${escapeHtml(form.team_names[i])}`), sel));
      }
      if (personaGrid.childElementCount) {
        const helperRow = el('div', { class: 'setup-btn-row', style: 'justify-content: flex-start; padding: 0 0 var(--s-2) 0;' },
          el('button', { class: 'btn ghost', type: 'button', disabled: isLocked ? true : null,
            onclick: () => {
              for (let i = 0; i < form.num_teams; i++) {
                if (i === form.player_team_index) continue;
                form.gm_personas[i] = '';
              }
              rerender();
            }
          }, '全部設為預設'),
          el('button', { class: 'btn ghost', type: 'button', disabled: isLocked ? true : null,
            onclick: () => {
              const pool = [...personaIds];
              for (let i = 0; i < form.num_teams; i++) {
                if (i === form.player_team_index) continue;
                form.gm_personas[i] = pool[Math.floor(Math.random() * pool.length)] || '';
              }
              rerender();
            }
          }, '全部隨機指派'),
        );
        const sectTitle = el('div', { class: 'setup-section-title' }, 'GM Persona（可選） ');
        const tp = tipChip('gm_persona'); if (tp) sectTitle.append(tp);
        wrap.append(el('div', { class: 'setup-section' }, sectTitle, helperRow, personaGrid));
      }
    }
  }

  if (step === 1) buildStep1();
  else if (step === 2) buildStep2();
  else buildStep3();

  // Errors
  const errBox = el('div', { id: 'setup-errors-v2', class: 'setup-errors', hidden: true });
  wrap.append(errBox);

  // Wizard nav buttons
  if (!isLocked) {
    const navRow = el('div', { class: 'setup-btn-row' });
    // Reset (always)
    navRow.append(el('button', { class: 'btn ghost', type: 'button', onclick: () => {
      state.setupForm = makeDefaultSetupFormV2(null);
      state.setupStep = 1;
      rerender();
    }}, '使用預設值'));
    if (step > 1) {
      navRow.append(el('button', { class: 'btn ghost', type: 'button', onclick: () => {
        state.setupStep = step - 1; rerender();
      }}, '← 上一步'));
    }
    if (step < 3) {
      navRow.append(el('button', { class: 'btn', type: 'button', onclick: () => {
        const errors = validateSetupStepV2(form, step);
        const eb = $('#setup-errors-v2');
        if (errors.length) {
          if (eb) {
            eb.hidden = false;
            eb.innerHTML = errors.map((e) => `<div>• ${escapeHtml(e)}</div>`).join('');
          }
          return;
        }
        if (eb) eb.hidden = true;
        state.setupStep = step + 1; rerender();
      }}, '下一步 →'));
    } else {
      navRow.append(el('button', { class: 'btn', type: 'button', id: 'btn-setup-submit-v2',
        onclick: () => onSubmitSetupV2(root) }, '開始選秀 →'));
    }
    wrap.append(navRow);
  } else {
    wrap.append(el('div', { class: 'setup-btn-row' },
      el('button', { class: 'btn', type: 'button', onclick: () => navigate('draft') }, '前往選秀')));
  }

  root.append(wrap);
}

// M3: per-step validation. Step 1: names + basics; Step 2: weights; Step 3: ok.
function validateSetupStepV2(form, step) {
  const errors = [];
  if (step === 1) {
    if (!String(form.league_name || '').trim()) errors.push('聯盟名稱不可為空');
    for (let i = 0; i < form.team_names.length; i++) {
      if (!String(form.team_names[i] || '').trim()) errors.push(`隊伍 ${i} 名稱不可為空`);
    }
  } else if (step === 2) {
    for (const cat of ['pts','reb','ast','stl','blk','to']) {
      if (isNaN(form.scoring_weights[cat])) errors.push(`權重「${cat.toUpperCase()}」必須是數字`);
    }
  }
  return errors;
}

function validateSetupFormV2(form) {
  const errors = [];
  for (let i = 0; i < form.team_names.length; i++) {
    if (!String(form.team_names[i] || '').trim()) errors.push(`隊伍 ${i} 名稱不可為空`);
  }
  for (const cat of ['pts','reb','ast','stl','blk','to']) {
    if (isNaN(form.scoring_weights[cat])) errors.push(`權重「${cat.toUpperCase()}」必須是數字`);
  }
  return errors;
}

async function onSubmitSetupV2(root) {
  const form = state.setupForm;
  const errors = validateSetupFormV2(form);
  const errBox = $('#setup-errors-v2');
  if (errors.length) {
    if (errBox) {
      errBox.hidden = false;
      errBox.innerHTML = errors.map((e) => `<div>• ${escapeHtml(e)}</div>`).join('');
    }
    return;
  }
  if (errBox) errBox.hidden = true;

  const btn = $('#btn-setup-submit-v2');
  if (btn) { btn.disabled = true; btn.textContent = '設定中…'; }
  try {
    const payload = {
      league_name: form.league_name,
      season_year: form.season_year,
      player_team_index: form.player_team_index,
      team_names: form.team_names,
      randomize_draft_order: form.randomize_draft_order,
      num_teams: form.num_teams,
      roster_size: form.roster_size,
      starters_per_day: form.starters_per_day,
      il_slots: form.il_slots,
      scoring_weights: form.scoring_weights,
      regular_season_weeks: form.regular_season_weeks,
      playoff_teams: form.playoff_teams,
      trade_deadline_week: form.trade_deadline_week,
      ai_trade_frequency: form.ai_trade_frequency,
      ai_trade_style: form.ai_trade_style,
      veto_threshold: form.veto_threshold,
      veto_window_days: form.veto_window_days,
      ai_decision_mode: form.ai_decision_mode,
      draft_display_mode: form.draft_display_mode,
      show_offseason_headlines: form.show_offseason_headlines,
      gm_personas: form.gm_personas,
    };
    await api('/api/league/setup', { method: 'POST', body: JSON.stringify(payload) });
    const [status, settings] = await Promise.all([
      apiSoft('/api/league/status'),
      apiSoft('/api/league/settings'),
    ]);
    state.leagueStatus = status;
    state.leagueSettings = settings;
    state.setupForm = null;
    state.setupStep = 1;
    await refreshState().catch(() => {});
    toast('聯盟設定完成');
    navigate('draft');
  } catch (e) {
    toast(e.message || '設定失敗', 'error');
    if (btn) { btn.disabled = false; btn.textContent = '開始選秀 →'; }
  }
}

// ================================================================ GLOBAL BINDINGS
function bindLeagueSwitcherV2() {
  const btn = $('#btn-league-switch');
  const menu = $('#league-switch-menu');
  if (btn && menu) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu.hidden) openLeagueSwitchMenu(); else closeLeagueSwitchMenu();
    });
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) closeLeagueSwitchMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.hidden) closeLeagueSwitchMenu();
    });
  }
  const createBtn = $('#btn-new-league-create-v2');
  if (createBtn) createBtn.addEventListener('click', onCreateLeague);
  const createInp = $('#new-league-id-v2');
  if (createInp) {
    createInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onCreateLeague(); }
    });
  }
  const resetBtn = $('#btn-reset-draft');
  if (resetBtn) resetBtn.addEventListener('click', onResetDraft);
  // A: share-link button (manager-only). 401 will trigger the global toast.
  const shareBtn = $('#btn-share-league');
  if (shareBtn) shareBtn.addEventListener('click', onShareLeague);
}

// ---------------------------------------------------------------- boot
window.addEventListener('hashchange', render);

(async function boot() {
  // Show server version pill in header (one-shot, fire-and-forget).
  fetchAndShowVersion();

  // A: parse share-link query params (?league=foo&t=<token>). When both are
  // present we (1) write the token to the manager_token cookie so writes
  // work, and (2) ask the backend to switch to the named league. ?t alone
  // (no league switch) still gets persisted so refreshes keep working.
  try {
    const qs = new URLSearchParams(location.search);
    const qLeague = (qs.get('league') || '').trim();
    const qToken = (qs.get('t') || '').trim();
    if (qToken) setCookie('manager_token', qToken);
    if (qLeague) {
      // Pass ?t through to backend; backend validates and sets cookie too.
      const path = qToken
        ? `/api/leagues/switch?t=${encodeURIComponent(qToken)}`
        : '/api/leagues/switch';
      try {
        await api(path, { method: 'POST', body: JSON.stringify({ league_id: qLeague }) });
      } catch (err) {
        console.warn('share-link switch failed', err);
      }
      // Strip the params from the URL so a refresh won't repeatedly switch.
      try {
        const cleanUrl = location.pathname + (location.hash || '');
        history.replaceState(null, '', cleanUrl);
      } catch {}
    }
  } catch (err) {
    console.warn('share-link parse failed', err);
  }

  // Default landing: draft if draft pending, teams otherwise. We finalise
  // this after state refresh below; the initial hash just avoids a blank
  // flicker during boot.
  if (!location.hash) location.hash = '/teams';
  bindLeagueSwitcherV2();
  // Load personas + leagues in parallel (soft)
  const [personas, _] = await Promise.all([
    apiSoft('/api/personas').then((p) => p || {}),
    loadLeagues(),
  ]);
  state.personas = personas;
  await refreshState();
  // If league not set up yet, redirect to #/setup regardless of current hash.
  if (state.leagueStatus && state.leagueStatus.setup_complete === false) {
    state.setupForm = makeDefaultSetupFormV2(state.leagueSettings);
    if (currentRoute() !== 'setup') {
      location.hash = '/setup';
      return; // hashchange will fire render()
    }
  }
  render();
})();
