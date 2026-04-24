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
  // league switcher + setup
  leagues: [],                   // [{league_id,name,setup_complete}, ...]
  activeLeague: 'default',
  setupForm: null,               // working copy for #setup
};

const VALID_ROUTES = ['draft', 'teams', 'fa', 'league', 'schedule', 'trades', 'setup'];

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

// ---------------------------------------------------------------- api
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
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
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
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
  return VALID_ROUTES.includes(hash) ? hash : 'draft';
}

function navigate(route) {
  if (location.hash !== `#/${route}`) location.hash = `/${route}`;
  else render();
}

function render() {
  const route = currentRoute();
  // Highlight active nav
  $$('.nav-item').forEach((a) => {
    const active = a.dataset.route === route;
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const main = $('#main');
  if (!main) return;
  main.innerHTML = '';
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

  // Top: clock + recos (human turn) OR clock-only (AI turn)
  const isHumanTurn = !d.is_complete && d.current_team_id === d.human_team_id;
  const clock = buildDraftClock(d);
  const recosContainer = el('div', { id: 'draft-recos-slot' });
  const top = el('div', { class: 'draft-top' }, clock, recosContainer);
  root.append(top);

  if (isHumanTurn) {
    recosContainer.append(el('div', { class: 'card card-pad', 'aria-busy': 'true' }, '載入 AI 推薦中…'));
    refreshDraftRecos().then(() => {
      const fresh = buildDraftRecosCard();
      recosContainer.innerHTML = '';
      if (fresh) recosContainer.append(fresh);
    });
  } else if (!d.is_complete) {
    recosContainer.append(
      el('div', { class: 'card card-pad' },
        el('div', { class: 'eyebrow', style: 'margin-bottom:8px;' }, 'AI 選秀中'),
        el('div', { style: 'color:var(--ink-3);' }, '輪到你時，會顯示四位 AI 推薦球員。'),
      )
    );
  }

  // Available players table (left) + board (right)
  const availPanel = buildAvailablePanel(d);
  const boardPanel = buildBoardPanel(d);

  const grid = el('div', { style: 'display:grid; grid-template-columns: 1.3fr 1fr; gap: var(--s-5); align-items: start;' },
    availPanel,
    boardPanel,
  );
  root.append(grid);

  // Kick off table render
  renderAvailableTable(state.draftDisplayMode || 'prev_full');

  // Auto-advance AI turn
  scheduleDraftAutoAdvance();
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
    el('div', { style: 'display:flex; gap:8px; margin-top: var(--s-4);' },
      el('button', { class: 'btn ghost sm', disabled: isYou, onclick: onAdvance }, '推進 AI 一手'),
      el('button', { class: 'btn sm', disabled: isYou, onclick: onSimToMe }, '⏭ 模擬到我'),
    ),
  );
  return card;
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

  const params = new URLSearchParams({
    available: 'true',
    sort: state.draftFilter.sort,
    limit: '80',
  });
  if (state.draftFilter.q) params.set('q', state.draftFilter.q);
  if (state.draftFilter.pos) params.set('pos', state.draftFilter.pos);

  let players;
  try {
    players = await api(`/api/players?${params.toString()}`);
  } catch (e) {
    wrap.innerHTML = `<div style="padding: var(--s-6); color: var(--bad);">載入失敗：${escapeHtml(e.message)}</div>`;
    return;
  }

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
      ? ` <span class="pill bad" style="font-size:9px; padding: 1px 6px;">${p.injury.status === 'out' ? 'OUT' : 'DTD'}</span>`
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
      let style = 'text-align:center; padding: 6px 8px; font-size: 10px;';
      if (isCurrent) style += ' background: var(--accent-14); box-shadow: inset 0 0 0 1px var(--accent);';
      else if (isYou && !cell) style += ' background: var(--accent-08);';
      if (cell) {
        style += ' font-weight: 500;';
        html += `<td style="${style}" title="${escapeHtml(cell.reason || '')}">
          <div>${escapeHtml(cell.player_name)}</div>
          <div style="color:var(--ink-3); font-family:var(--mono); font-size: 9px;">#${cell.overall}</div>
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
}

function scheduleDraftAutoAdvance() {
  cancelDraftAutoAdvance();
  const d = state.draft;
  if (!d || d.is_complete) return;
  if (currentRoute() !== 'draft') return;
  if (d.current_team_id === d.human_team_id) return;
  if (state.draftAutoBusy) return;

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
      ok = true;
      // If the server just completed the draft, stop the loop immediately.
      if (r.state?.is_complete) cancelDraftAutoAdvance();
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
    if (ok) render();
  }, 1500);
}

// ---------------------------------------------------------------- actions
async function onAdvance() {
  try {
    const r = await api('/api/draft/ai-advance', { method: 'POST' });
    state.draft = r.state;
    render();
  } catch (e) {
    toast(e.message || '推進失敗', 'error');
  }
}

async function onSimToMe() {
  try {
    const r = await api('/api/draft/sim-to-me', { method: 'POST' });
    state.draft = r.state;
    render();
  } catch (e) {
    toast(e.message || '模擬失敗', 'error');
  }
}

async function onDraftPlayer(playerId) {
  try {
    const r = await api('/api/draft/pick', {
      method: 'POST',
      body: JSON.stringify({ player_id: playerId }),
    });
    state.draft = r.state;
    render();
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
  return ` <span class="pill ${kind}" style="font-size:9px; padding:1px 6px;" title="${escapeHtml(title)}">${label}${days}</span>`;
}

async function renderTeamsView(root) {
  const d = state.draft;
  if (!d || !Array.isArray(d.teams) || d.teams.length === 0) {
    root.append(el('div', { class: 'card card-pad' }, '載入隊伍資訊中…'));
    return;
  }

  // Pick default team: human team if available, else first team.
  if (state.currentTeamId == null || state.currentTeamId >= d.teams.length) {
    state.currentTeamId = (d.human_team_id != null) ? d.human_team_id : 0;
  }

  const teamSelect = el('select', {
    id: 'team-pick',
    style: 'padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); min-width: 180px;',
    onchange: (e) => {
      state.currentTeamId = parseInt(e.target.value, 10);
      renderTeamBody();
    },
    html: d.teams.map((t) =>
      `<option value="${t.id}" ${t.id === state.currentTeamId ? 'selected' : ''}>${escapeHtml(t.name)}${t.is_human ? ' (你)' : ''}</option>`
    ).join(''),
  });

  const head = el('div', { class: 'view-head' },
    el('div', { class: 'view-title-block' },
      el('span', { class: 'eyebrow' }, '隊伍'),
      el('div', { class: 'view-title' }, '球員名單'),
      el('div', { class: 'view-sub' }, '切換隊伍檢視名單、先發與板凳'),
    ),
    el('div', { class: 'view-actions' }, teamSelect),
  );
  root.append(head);
  root.append(el('div', { id: 'team-body' }));
  renderTeamBody();
}

async function renderTeamBody() {
  const container = $('#team-body');
  if (!container) return;
  const tid = state.currentTeamId;
  container.innerHTML = '<div class="card card-pad" aria-busy="true">載入中…</div>';

  let data;
  try {
    data = await api(`/api/teams/${tid}`);
  } catch (e) {
    container.innerHTML = `<div class="card card-pad" style="color:var(--bad);">載入失敗：${escapeHtml(e.message)}</div>`;
    return;
  }
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
    ? '<span class="pill warn" style="font-size:10px;" title="手動設定陣容">手動陣容</span>'
    : '<span class="pill" style="font-size:10px;" title="自動最佳化">自動陣容</span>';

  const summary = el('div', { class: 'card card-pad' });
  summary.innerHTML = `
    <div style="display:flex; align-items:center; gap: var(--s-3); flex-wrap:wrap; margin-bottom: var(--s-3);">
      <span style="font-size: var(--fs-lg); font-weight: 600;">${escapeHtml(team.name)}</span>
      ${isHuman ? '<span class="pill accent" style="font-size:10px;">你</span>' : ''}
      ${isHuman && seasonStarted ? overrideBadge : ''}
      ${gmName ? `<span style="color:var(--ink-3); font-size: var(--fs-sm);">GM：${escapeHtml(gmName)}</span>` : ''}
      ${recordStr ? `<span class="pill" style="font-size:10px;">W-L ${recordStr}</span>` : ''}
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

  // Starters card
  const startersCard = el('div', { class: 'card' });
  const startersHeader = el('div', { class: 'card-header' },
    el('h3', {}, '先發陣容'),
    el('span', { class: 'sub' }, seasonStarted ? `${(lineup_slots || []).length} 位` : '選秀完成後可用'),
  );
  const startersWrap = el('div', { id: 'starters-wrap' });

  if (seasonStarted && slotsPopulated) {
    const rows = (lineup_slots || []).map((s) => {
      const p = (s.player_id != null) ? playerById.get(s.player_id) : null;
      const injured = p && injSet.has(p.id);
      const injBadge = p ? injuryPillHtml(injuriesMap[p.id]) : '';
      if (!p) {
        return `<tr>
          <td><span class="pos-tag" data-pos="${escapeHtml(s.slot)}">${escapeHtml(s.slot)}</span></td>
          <td colspan="4" style="color:var(--ink-4);">—</td>
        </tr>`;
      }
      return `<tr ${injured ? 'style="opacity:0.6;"' : ''}>
        <td><span class="pos-tag" data-pos="${escapeHtml(s.slot)}">${escapeHtml(s.slot)}</span></td>
        <td><b>${escapeHtml(p.name)}</b>${injBadge}</td>
        <td><span class="pos-tag" data-pos="${escapeHtml(p.pos)}">${escapeHtml(p.pos)}</span></td>
        <td class="num"><b>${fppg(p.fppg)}</b></td>
        <td style="color:var(--ink-3); font-family:var(--mono); font-size: var(--fs-xs);">${escapeHtml(p.team)}</td>
      </tr>`;
    }).join('');
    startersWrap.innerHTML = `<table class="standings-table">
      <thead><tr><th>位置</th><th>球員</th><th>定位</th><th class="num">FPPG</th><th>球隊</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  } else {
    startersWrap.innerHTML = `<div style="padding: var(--s-5); color:var(--ink-3);">${seasonStarted ? '名單中沒有可排入的先發球員。' : '選秀尚未完成。'}</div>`;
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
    startersCard.append(startersHeader, startersWrap, actions);
  } else {
    startersCard.append(startersHeader, startersWrap);
  }
  blocks.push(startersCard);

  // Bench card
  const benchPlayers = (bench || []).map((id) => playerById.get(id)).filter(Boolean);
  if (benchPlayers.length > 0) {
    const benchCard = el('div', { class: 'card' });
    const benchHeader = el('div', { class: 'card-header' },
      el('h3', {}, '板凳'),
      el('span', { class: 'sub' }, `${benchPlayers.length} 位`),
    );
    const benchWrap = el('div');
    const rows = benchPlayers.map((p) => {
      const injBadge = injuryPillHtml(injuriesMap[p.id]);
      const injured = injSet.has(p.id);
      return `<tr ${injured ? 'style="opacity:0.6;"' : ''}>
        <td><b>${escapeHtml(p.name)}</b>${injBadge}</td>
        <td><span class="pos-tag" data-pos="${escapeHtml(p.pos)}">${escapeHtml(p.pos)}</span></td>
        <td style="color:var(--ink-3); font-family:var(--mono); font-size: var(--fs-xs);">${escapeHtml(p.team)}</td>
        <td class="num">${p.age ?? '-'}</td>
        <td class="num"><b>${fppg(p.fppg)}</b></td>
        <td class="num">${fmtStat(p.pts)}</td>
        <td class="num">${fmtStat(p.reb)}</td>
        <td class="num">${fmtStat(p.ast)}</td>
      </tr>`;
    }).join('');
    benchWrap.innerHTML = `<table class="standings-table">
      <thead><tr><th>球員</th><th>位置</th><th>球隊</th>
        <th class="num">年齡</th><th class="num">FPPG</th>
        <th class="num">PTS</th><th class="num">REB</th><th class="num">AST</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    benchCard.append(benchHeader, benchWrap);
    blocks.push(benchCard);
  } else if (players.length === 0) {
    blocks.push(el('div', { class: 'card card-pad', style: 'color: var(--ink-3);' }, '尚未選入任何球員。'));
  }

  container.innerHTML = '';
  container.append(...blocks);
}

// Simple lineup override modal (v2 has no modal system, built inline)
function openLineupModal(data) {
  const { team, players, lineup_slots, injured_out } = data;
  const injSet = new Set(injured_out || []);
  const targetCount = (lineup_slots || []).length || 10;
  let selected = new Set((lineup_slots || []).map((s) => s.player_id).filter((id) => id != null));

  const candidates = players
    .filter((p) => !injSet.has(p.id))
    .sort((a, b) => (b.fppg || 0) - (a.fppg || 0));

  function rowsHtml() {
    return candidates.map((p) => {
      const checked = selected.has(p.id);
      return `<tr ${checked ? 'style="background:var(--accent-08);"' : ''}>
        <td><input type="checkbox" class="lineup-check" data-pid="${p.id}" ${checked ? 'checked' : ''}></td>
        <td><b>${escapeHtml(p.name)}</b></td>
        <td><span class="pos-tag" data-pos="${escapeHtml(p.pos)}">${escapeHtml(p.pos)}</span></td>
        <td class="num"><b>${fppg(p.fppg)}</b></td>
        <td style="color:var(--ink-3); font-family:var(--mono); font-size: var(--fs-xs);">${escapeHtml(p.team)}</td>
      </tr>`;
    }).join('');
  }

  const overlay = el('div', {
    id: 'lineup-overlay',
    style: 'position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:1000; display:flex; align-items:center; justify-content:center; padding: var(--s-5);',
  });
  overlay.innerHTML = `
    <div class="card" style="max-width: 720px; width:100%; max-height: 85vh; display:flex; flex-direction:column;">
      <div class="card-header">
        <h3>設定先發陣容（選 ${targetCount} 人）</h3>
        <button class="btn ghost sm" id="btn-close-lineup">✕</button>
      </div>
      <div style="padding: var(--s-3) var(--s-4); color:var(--ink-2); font-size: var(--fs-sm); border-bottom: 1px solid var(--line-soft);">
        已選：<b id="lineup-count">${selected.size}</b> / ${targetCount}
      </div>
      <div style="overflow:auto; flex:1;">
        <table class="standings-table" id="lineup-tbl">
          <thead><tr><th></th><th>球員</th><th>位置</th><th class="num">FPPG</th><th>球隊</th></tr></thead>
          <tbody>${rowsHtml()}</tbody>
        </table>
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

  function refreshCount() {
    const n = $('#lineup-count'); if (n) n.textContent = String(selected.size);
  }
  function wireCheckboxes() {
    overlay.querySelectorAll('.lineup-check').forEach((cb) => {
      cb.addEventListener('change', () => {
        const pid = Number(cb.dataset.pid);
        if (cb.checked) {
          if (selected.size >= targetCount) { cb.checked = false; return; }
          selected.add(pid);
        } else {
          selected.delete(pid);
        }
        const tr = cb.closest('tr');
        if (tr) tr.style.background = cb.checked ? 'var(--accent-08)' : '';
        refreshCount();
      });
    });
  }
  wireCheckboxes();

  $('#btn-auto-lineup').addEventListener('click', () => {
    selected = new Set(candidates.slice(0, targetCount).map((p) => p.id));
    const tbody = overlay.querySelector('#lineup-tbl tbody');
    if (tbody) tbody.innerHTML = rowsHtml();
    wireCheckboxes();
    refreshCount();
    toast(`已套用 FPPG 最佳陣容（${selected.size} 人）`, 'info');
  });

  $('#btn-save-lineup').addEventListener('click', async () => {
    if (selected.size !== targetCount) {
      toast(`請選滿 ${targetCount} 名先發（目前 ${selected.size} 人）`, 'error');
      return;
    }
    try {
      await api('/api/season/lineup', {
        method: 'POST',
        body: JSON.stringify({ team_id: team.id, starters: [...selected], today_only: false }),
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
      el('div', { id: 'fa-quota-box', class: 'pill', style: 'font-size:11px;' }, '—'),
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

  // Note: we do NOT send `pos` query. Backend strict-matches, but UI needs
  // multi-position matching (e.g. "PG/SG" player should match PG filter).
  // We pull a wider pool and filter client-side.
  const params = new URLSearchParams({ available: 'true', limit: '400' });
  if (f.q) params.set('q', f.q);

  let players;
  try {
    players = await api(`/api/players?${params.toString()}`);
  } catch (e) {
    wrap.innerHTML = `<div style="padding: var(--s-6); color:var(--bad);">載入失敗：${escapeHtml(e.message)}</div>`;
    return;
  }

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
      ? ` <span class="pill bad" style="font-size:9px; padding:1px 6px;">${p.injury.status === 'out' ? 'OUT' : 'DTD'}</span>`
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
        ${i === 0 ? '<span class="pill accent" style="font-size:9px;">建議</span>' : ''}
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
  const d = state.draft;
  if (!d) {
    root.append(el('div', { class: 'card card-pad' }, '載入中…'));
    return;
  }

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
  return el('div', { class: `card card-pad matchup-hero status-${statusClass}` },
    el('div', { class: 'mh-head' },
      el('span', { class: 'mh-label' }, `第 ${week} 週 你的對戰`),
      el('span', { class: `mh-status status-${statusClass}` }, statusLabel),
    ),
    el('div', { class: 'mh-body' },
      el('div', { class: 'mh-side user' },
        el('div', { class: 'mh-tag' }, '你'),
        el('div', { class: 'mh-name' }, teamNameOf(userTid)),
        el('div', { class: 'mh-score' }, played ? fmtStat(userScore) : '—'),
      ),
      el('div', { class: 'mh-vs' }, 'VS'),
      el('div', { class: 'mh-side opp' },
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
    // Aggregate per-player rows
    const aggA = aggregateMatchupPlayers(data.players_a);
    const aggB = aggregateMatchupPlayers(data.players_b);
    slot.append(el('div', { class: 'md-head' },
      el('div', {}, `${data.team_a_name} ${fmtStat(data.score_a)} - ${fmtStat(data.score_b)} ${data.team_b_name}`),
    ));
    slot.append(el('div', { class: 'md-grid' },
      buildMatchupPlayerTable(aggA, data.team_a_name),
      buildMatchupPlayerTable(aggB, data.team_b_name),
    ));
  } catch (e) {
    slot.innerHTML = '';
    slot.append(el('div', { class: 'empty-state' }, `明細載入失敗：${escapeHtml(e.message || '')}`));
  }
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
      <td class="name"><b>${escapeHtml(r.name)}</b>${isYou ? ' <span class="pill accent" style="font-size:10px;">YOU</span>' : ''}</td>
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
  const data = await apiSoft('/api/season/activity?limit=30');
  loading.remove();
  const items = data?.activity || [];
  if (!items.length) {
    container.append(el('div', { class: 'card card-pad' },
      el('div', { class: 'empty-state' }, '暫無動態（或賽季剛開始）。Phase 5.5 會加分類。')));
    return;
  }
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-header' }, el('h3', {}, '近期動態')),
    el('div', { class: 'activity-list' }),
  );
  const list = card.querySelector('.activity-list');
  for (const it of items) {
    list.append(el('div', { class: 'activity-row' },
      el('span', { class: 'activity-summary' }, it.summary || it.type || '—'),
    ));
  }
  container.append(card);
}

async function renderTradesPlaceholder(container) {
  container.append(el('div', { class: 'card card-pad' },
    el('div', { class: 'empty-state' }, '交易清單將於 Phase 7 完整實作（發起交易、接受、否決）。')));

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
    <td><span class="pill" style="font-size:10px;">${escapeHtml(t.status)}</span></td>
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
      body: JSON.stringify({ use_ai: true }),
    });
    await refreshLeagueData();
    _logMgmt(`✅ 已推進至 W${state.standings?.current_week ?? '?'} D${state.standings?.current_day ?? '?'}`);
    rerenderLeagueSubFromTabs();
    toast('推進一天完成', 'info');
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
  try {
    const es = new EventSource('/api/season/advance-week/stream');
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        if (payload.error) {
          _logMgmt(`❌ ${payload.error}`);
          toast(payload.error, 'error');
          es.close();
          state.advancing = false;
          return;
        }
        if (payload.done) {
          _logMgmt(`✅ 本週推進完成（W${payload.week}）`);
          toast('推進一週完成', 'info');
          es.close();
          state.advancing = false;
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
      state.advancing = false;
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
  if (!confirm('模擬到季後賽？執行所有剩餘例行賽週次，可能需要 10-30 秒。')) return;
  state.advancing = true;
  _logMgmt('⏩ 模擬剩餘例行賽中…');
  try {
    await api('/api/season/sim-to-playoffs', {
      method: 'POST',
      body: JSON.stringify({ use_ai: false }),
    });
    await refreshLeagueData();
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
      el('div', { class: 'view-actions' },
        el('button', { class: 'btn', onclick: openProposeTradeDialogV2 }, '＋ 發起新交易'),
      ),
    ),
  );

  // Tabs
  root.append(buildTradesTabsV2());

  // Body container
  const body = el('div', { id: 'trades-sub-body' });
  root.append(body);

  // Propose modal (hidden by default; reused)
  root.append(buildProposeModalV2());

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
  if (state.tradesPollTimer) return;
  state.tradesPollTimer = setInterval(async () => {
    if (currentRoute() !== 'trades') return;
    await refreshTradesV2();
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

  // Category-odds (pending only)
  if (pending) {
    card.append(buildTradeOddsSectionV2(trade));
  }

  // Actions (pending only)
  if (pending) {
    const actions = buildTradeActionsV2(trade);
    if (actions) card.append(actions);
  }

  return card;
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
    );
    return actions;
  }
  if (status === 'pending_accept' && trade.from_team === humanId) {
    actions.append(
      el('button', { class: 'btn sm ghost', onclick: () => onCancelTradeV2(trade.id) }, '取消'),
    );
    return actions;
  }
  return null;
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
  if (state.proposeDraft.counterparty != null) {
    try {
      const data = await api(`/api/teams/${state.proposeDraft.counterparty}`);
      state.proposeDraft.counterpartyRoster = data.players || [];
      for (const p of state.proposeDraft.counterpartyRoster) state.playerCache.set(p.id, p);
    } catch { state.proposeDraft.counterpartyRoster = []; }
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
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '送出提案'; }
  }
}

// ---------------------------------------------------------------- global delegation
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-draft]');
  if (btn && !btn.disabled) {
    const id = parseInt(btn.getAttribute('data-draft'), 10);
    if (!Number.isNaN(id)) onDraftPlayer(id);
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
  const inp = $('#new-league-id-v2');
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

async function onCreateLeague() {
  const inp = $('#new-league-id-v2');
  const lid = (inp && inp.value || '').trim();
  if (!lid) { toast('請輸入聯盟 ID', 'info'); return; }
  try {
    await api('/api/leagues/create', { method: 'POST', body: JSON.stringify({ league_id: lid, switch: true }) });
    const dlg = $('#dlg-new-league-v2');
    if (dlg) dlg.close();
    toast(`已建立聯盟 ${lid}，請完成設定`);
    // After reload, boot() will auto-redirect to #/setup because setup_complete=false.
    setTimeout(() => { location.hash = '#/setup'; window.location.reload(); }, 200);
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

function renderSetupView(root) {
  const status = state.leagueStatus;
  const isLocked = status && status.setup_complete;
  if (!state.setupForm) state.setupForm = makeDefaultSetupFormV2(state.leagueSettings);
  const form = state.setupForm;
  const wrap = el('div', { class: 'setup-v2' });

  wrap.append(el('div', { class: 'view-head' },
    el('div', { class: 'view-title-block' },
      el('span', { class: 'eyebrow' }, '聯盟設定'),
      el('div', { class: 'view-title' }, '建立新聯盟 / 設定聯盟'),
      el('div', { class: 'view-sub' }, '完成後會進入選秀階段。'),
    ),
  ));

  if (isLocked) {
    wrap.append(el('div', { class: 'setup-lock-warn' },
      '聯盟已開賽，以下設定已鎖定；如需重新設定請先刪除聯盟或建立新聯盟。'));
  }

  function section(title, ...children) {
    return el('div', { class: 'setup-section' },
      el('div', { class: 'setup-section-title' }, title),
      ...children,
    );
  }
  function row(label, control, hint) {
    const r = el('div', { class: 'setup-row' },
      el('div', { class: 'setup-label' }, label),
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
        onchange: () => onChange(typeof current === 'number' ? Number(val) : val),
      });
      grp.append(el('span', { class: 'radio-item' }, inp, el('label', { for: id }, String(label))));
    }
    return grp;
  }

  // Team count select (8/10/12)
  const numTeamsSelect = el('select', {
    disabled: isLocked ? true : null,
    onchange: (e) => {
      const n = parseInt(e.target.value, 10);
      form.num_teams = n;
      // Resize team_names array (pad w/ defaults or truncate)
      const base = DEFAULT_TEAM_NAMES_V2;
      const next = form.team_names.slice(0, n);
      while (next.length < n) next.push(base[next.length] || `隊伍${next.length}`);
      form.team_names = next;
      if (form.player_team_index >= n) form.player_team_index = 0;
      // Rerender just this view
      root.innerHTML = '';
      renderSetupView(root);
    },
    html: [8, 10, 12].map((n) =>
      `<option value="${n}" ${n === form.num_teams ? 'selected' : ''}>${n} 隊</option>`).join(''),
  });

  const leagueNameInput = el('input', {
    type: 'text', value: form.league_name, disabled: isLocked ? true : null,
    oninput: (e) => { form.league_name = e.target.value; },
  });

  const seasonInput = el('input', {
    type: 'text', value: form.season_year, disabled: isLocked ? true : null,
    oninput: (e) => { form.season_year = e.target.value; },
  });

  const playerTeamSelect = el('select', {
    disabled: isLocked ? true : null,
    onchange: (e) => { form.player_team_index = parseInt(e.target.value, 10); },
    html: form.team_names.map((n, i) =>
      `<option value="${i}" ${i === form.player_team_index ? 'selected' : ''}>${i}: ${escapeHtml(n)}</option>`).join(''),
  });

  const randomizeCheck = el('input', {
    type: 'checkbox', checked: form.randomize_draft_order ? true : null,
    disabled: isLocked ? true : null,
    onchange: (e) => { form.randomize_draft_order = e.target.checked; },
  });

  wrap.append(section('聯盟基本',
    row('聯盟名稱', leagueNameInput),
    row('賽季年份', seasonInput, '例如 2025-26（需要 data/seasons/ 有對應檔）'),
    row('隊伍數', numTeamsSelect),
    row('我的隊伍', playerTeamSelect),
    row('隨機選秀順序', randomizeCheck),
  ));

  // Team names grid
  const namesGrid = el('div', { class: 'setup-team-names' });
  form.team_names.forEach((name, i) => {
    const inp = el('input', {
      type: 'text', value: name,
      placeholder: `隊伍 ${i}`,
      disabled: isLocked ? true : null,
      oninput: (e) => {
        form.team_names[i] = e.target.value;
        const opt = playerTeamSelect.options[i];
        if (opt) opt.textContent = `${i}: ${e.target.value}`;
      },
    });
    namesGrid.append(el('div', { class: 'team-name-row' },
      el('label', {}, String(i)), inp));
  });
  wrap.append(section('隊伍名稱', namesGrid));

  // Personas (optional — only show if /api/personas returned keys)
  const personaIds = Object.keys(state.personas || {});
  if (personaIds.length) {
    const personaGrid = el('div', { class: 'setup-team-names' });
    // Ensure gm_personas length matches num_teams
    while (form.gm_personas.length < form.num_teams) form.gm_personas.push('');
    form.gm_personas = form.gm_personas.slice(0, form.num_teams);
    for (let i = 0; i < form.num_teams; i++) {
      if (i === form.player_team_index) continue; // Human team has no persona
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
        el('label', {}, `${i}: ${escapeHtml(form.team_names[i])}`), sel));
    }
    if (personaGrid.childElementCount) {
      wrap.append(section('GM Persona（可選）', personaGrid));
    }
  }

  // Scoring weights
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
  wrap.append(section('計分權重', weightGrid));

  // Roster / schedule
  wrap.append(section('名單 & 賽程',
    row('名單人數', radioGroup('roster_size', [[10,'10'],[13,'13'],[15,'15']], form.roster_size, (v)=>{form.roster_size=v;})),
    row('每日先發', radioGroup('starters_per_day', [[8,'8'],[10,'10'],[12,'12']], form.starters_per_day, (v)=>{form.starters_per_day=v;})),
    row('傷兵位置', radioGroup('il_slots', [[0,'0'],[1,'1'],[2,'2'],[3,'3 (預設)']], form.il_slots, (v)=>{form.il_slots=v;})),
    row('例行賽週數', radioGroup('regular_season_weeks', [[18,'18'],[19,'19'],[20,'20'],[21,'21'],[22,'22']], form.regular_season_weeks, (v)=>{form.regular_season_weeks=v;})),
  ));

  // Errors
  const errBox = el('div', { id: 'setup-errors-v2', class: 'setup-errors', hidden: true });
  wrap.append(errBox);

  // Submit
  if (!isLocked) {
    wrap.append(el('div', { class: 'setup-btn-row' },
      el('button', { class: 'btn ghost', type: 'button', onclick: () => {
        state.setupForm = makeDefaultSetupFormV2(null);
        root.innerHTML = ''; renderSetupView(root);
      }}, '使用預設值'),
      el('button', { class: 'btn', type: 'button', id: 'btn-setup-submit-v2',
        onclick: () => onSubmitSetupV2(root) }, '開始選秀 →'),
    ));
  } else {
    wrap.append(el('div', { class: 'setup-btn-row' },
      el('button', { class: 'btn', type: 'button', onclick: () => navigate('draft') }, '前往選秀')));
  }

  root.append(wrap);
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
}

// ---------------------------------------------------------------- boot
window.addEventListener('hashchange', render);

(async function boot() {
  if (!location.hash) location.hash = '/draft';
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
