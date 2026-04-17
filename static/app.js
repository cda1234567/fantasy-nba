// Fantasy NBA — vanilla JS SPA. Hash router, no build step, no framework.
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

// ---------------------------------------------------------------- formatters
const fmtStat = (n) => (typeof n === 'number' ? n.toFixed(1) : '-');
const fppg    = (n) => (typeof n === 'number' ? n.toFixed(1) : '-');

// ---------------------------------------------------------------- state
const state = {
  draft: null,
  personas: {},
  selectedTeamId: 0,
  season: null,
  standings: null,
  schedule: null,
  logs: [],
  draftFilter: { q: '', pos: '', sort: 'fppg' },
  faFilter: { q: '', pos: '', sort: 'fppg' },
  connected: false,
  logPollTimer: null,
  // Wave E — trades
  tradesPending: [],            // list of TradeProposal
  tradesRequireAttention: [],   // list of ids
  tradesHistory: [],            // list of TradeProposal
  tradesPollTimer: null,
  tradeHistoryOpen: false,
  expandedHistory: new Set(),   // trade ids whose history detail is expanded
  playerCache: new Map(),       // id → {id, name, pos, fppg, ...}
  proposeDraft: {               // state for propose-trade modal
    counterparty: null,
    send: new Set(),
    receive: new Set(),
    counterpartyRoster: [],
    humanRoster: [],
  },
};

const VALID_ROUTES = ['draft', 'teams', 'fa', 'league', 'schedule'];

// ---------------------------------------------------------------- api wrapper
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
  // Like api() but returns null on 4xx/5xx instead of throwing (for optional endpoints).
  try {
    return await api(path, opts);
  } catch (e) {
    return null;
  }
}

function setConnected(ok) {
  state.connected = ok;
  const dot  = $('#conn-dot');
  const text = $('#conn-text');
  if (!dot || !text) return;
  dot.classList.toggle('ok', ok);
  dot.classList.toggle('bad', !ok);
  text.textContent = ok ? 'Online' : 'Offline';
}

// ---------------------------------------------------------------- toast
function toast(message, kind = 'info', ms = 3000) {
  const stack = $('#toast-stack');
  if (!stack) return;
  const node = el('div', { class: `toast ${kind}`, role: 'status' }, message);
  stack.append(node);
  setTimeout(() => {
    node.classList.add('fade');
    setTimeout(() => node.remove(), 220);
  }, ms);
}

// ---------------------------------------------------------------- confirm modal
function confirmDialog(title, body, okLabel = 'OK') {
  return new Promise((resolve) => {
    const dlg = $('#dlg-confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-body').textContent  = body;
    const okBtn = $('#confirm-ok');
    okBtn.textContent = okLabel;
    const handler = (e) => {
      dlg.removeEventListener('close', handler);
      resolve(dlg.returnValue === 'ok');
    };
    dlg.addEventListener('close', handler);
    try { dlg.showModal(); } catch { resolve(window.confirm(body)); }
  });
}

// ---------------------------------------------------------------- state refresh
async function refreshState() {
  try {
    state.draft = await api('/api/state');
    setConnected(true);
  } catch (e) {
    setConnected(false);
    throw e;
  }
  // Best-effort season data; safe when Wave A isn't deployed.
  const [standings, schedule] = await Promise.all([
    apiSoft('/api/season/standings'),
    apiSoft('/api/season/schedule'),
  ]);
  state.standings = standings;
  state.schedule  = schedule;
  // Season is "live" only when the backend has populated standings rows.
  const rows = standings?.standings || [];
  state.season = rows.length ? { active: true } : null;
}

async function refreshLogs() {
  const payload = await apiSoft('/api/season/logs?limit=30');
  if (!payload) return;
  const logs = Array.isArray(payload) ? payload : (payload.logs || []);
  state.logs = logs;
  renderLogAside();
}

// ---------------------------------------------------------------- router
function currentRoute() {
  const hash = (location.hash || '').replace(/^#/, '').trim();
  return VALID_ROUTES.includes(hash) ? hash : 'draft';
}

function navigate(route) {
  if (location.hash !== `#${route}`) location.hash = route;
  else render();
}

function render() {
  const route = currentRoute();

  // Highlight active nav items.
  $$('.nav-item, .tab-btn').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === route);
  });

  // Swap main view.
  const main = $('#main-view');
  main.innerHTML = '';

  switch (route) {
    case 'draft':    renderDraftView(main);    break;
    case 'teams':    renderTeamsView(main);    break;
    case 'fa':       renderFaView(main);       break;
    case 'league':   renderLeagueView(main);   break;
    case 'schedule': renderScheduleView(main); break;
  }

  main.focus({ preventScroll: true });

  // Log polling: only active on League/Schedule views.
  if (route === 'league' || route === 'schedule') {
    startLogPolling();
  } else {
    stopLogPolling();
  }

  // Trade polling: only on League view.
  if (route === 'league') {
    startTradesPolling();
  } else {
    stopTradesPolling();
  }
}

function startLogPolling() {
  if (state.logPollTimer) return;
  refreshLogs();
  state.logPollTimer = setInterval(refreshLogs, 5000);
}
function stopLogPolling() {
  if (state.logPollTimer) clearInterval(state.logPollTimer);
  state.logPollTimer = null;
}

// ================================================================ DRAFT VIEW
function renderDraftView(root) {
  const d = state.draft;
  if (!d) {
    root.append(el('div', { class: 'empty-state' }, 'Loading draft state...'));
    return;
  }

  // Header summary
  const totalPicks = d.num_teams * d.total_rounds;
  const summary = d.is_complete
    ? `Draft complete — ${totalPicks}/${totalPicks} picks`
    : `Pick ${d.current_overall} / ${totalPicks} — R${d.current_round}.${d.current_pick_in_round}`;

  const clockPanel = buildClockPanel(d);
  const boardPanel = buildBoardPanel(d);
  const availablePanel = buildAvailablePanel(d);

  const grid = el('div', { class: 'draft-grid' },
    el('div', {},
      clockPanel,
      availablePanel,
    ),
    el('div', {},
      el('div', { class: 'panel' },
        el('div', { class: 'panel-head' },
          el('h2', {}, 'Summary'),
          el('span', { class: 'pill' }, summary),
        ),
      ),
      boardPanel,
    ),
  );

  root.append(grid);

  wireAvailableFilters();
  renderAvailableTable();
}

function buildClockPanel(d) {
  const panel = el('div', { class: 'panel' });
  const head  = el('div', { class: 'panel-head' },
    el('h2', {}, 'On the clock'),
  );
  const body = el('div', { class: 'clock-card' });

  if (d.is_complete) {
    body.append(
      el('div', { class: 'who' }, 'Draft complete'),
      el('div', { class: 'sub' }, 'All picks made. Head to the League tab to start the season.'),
      el('div', { class: 'clock-actions' },
        el('a', { class: 'btn', href: '#league' }, 'Go to League'),
      ),
    );
  } else {
    const team  = d.teams[d.current_team_id];
    const isYou = team.is_human;
    const persona = team.gm_persona ? state.personas[team.gm_persona] : null;
    const subline = isYou
      ? 'Pick a player below to make your selection.'
      : (persona ? persona.desc : 'AI is thinking...');

    if (isYou) body.classList.add('you');
    body.append(
      el('div', { class: 'who' }, isYou ? 'You are on the clock' : `${team.name} on the clock`),
      el('div', { class: 'sub' }, `Round ${d.current_round}, Pick ${d.current_pick_in_round} (overall #${d.current_overall}). ${subline}`),
      el('div', { class: 'clock-actions' },
        el('button', { class: 'btn ghost', disabled: isYou, onclick: onAdvance }, 'Advance AI'),
        el('button', { class: 'btn', disabled: isYou, onclick: onSimToMe }, 'Sim to Me'),
      ),
    );
  }

  panel.append(head, body);
  return panel;
}

function buildAvailablePanel(d) {
  const panel = el('div', { class: 'panel', id: 'panel-available' });
  panel.append(
    el('div', { class: 'panel-head' },
      el('h2', {}, 'Available Players'),
    ),
    el('div', { class: 'panel-body' },
      buildFilterBar('draftFilter', renderAvailableTable),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'data players-table responsive', id: 'tbl-available' }),
      ),
    ),
  );
  return panel;
}

function buildBoardPanel(d) {
  const panel = el('div', { class: 'panel' },
    el('div', { class: 'panel-head' }, el('h2', {}, 'Snake Board')),
    el('div', { class: 'board-wrap' }, buildBoardTable(d)),
  );
  return panel;
}

function buildBoardTable(d) {
  const tbl = el('table', { class: 'board' });
  let html = '<thead><tr><th class="rnd">R</th>';
  for (const t of d.teams) {
    const mark = t.is_human ? ' *' : '';
    html += `<th>${escapeHtml(t.name)}${mark}</th>`;
  }
  html += '</tr></thead><tbody>';
  for (let r = 0; r < d.total_rounds; r++) {
    html += `<tr><td class="rnd">${r + 1}</td>`;
    for (let t = 0; t < d.num_teams; t++) {
      const cell = d.board[r][t];
      const isCurrent = !d.is_complete && d.current_round === r + 1 && d.current_team_id === t;
      const isYou = t === d.human_team_id;
      const cls = [
        cell ? '' : 'empty',
        isCurrent ? 'current' : '',
        isYou ? 'you-cell' : '',
      ].filter(Boolean).join(' ');
      if (cell) {
        html += `<td class="${cls}" title="${escapeHtml(cell.reason || '')}">
          <span class="pname">${escapeHtml(cell.player_name)}</span>
          <span class="psub">#${cell.overall} (R${cell.round}.${cell.pick_in_round})</span>
        </td>`;
      } else {
        html += `<td class="${cls}">${isCurrent ? 'On the clock' : '-'}</td>`;
      }
    }
    html += '</tr>';
  }
  html += '</tbody>';
  tbl.innerHTML = html;
  return tbl;
}

function buildFilterBar(filterKey, onChange) {
  const f = state[filterKey];
  const wrap = el('div', { class: 'filter-bar' },
    el('input', {
      type: 'search', placeholder: 'Search name / team...', value: f.q,
      oninput: (e) => { f.q = e.target.value; onChange(); },
    }),
    el('select', {
      onchange: (e) => { f.pos = e.target.value; onChange(); },
      html: `
        <option value="">All positions</option>
        <option value="PG">PG</option>
        <option value="SG">SG</option>
        <option value="SF">SF</option>
        <option value="PF">PF</option>
        <option value="C">C</option>`,
    }),
    el('select', {
      onchange: (e) => { f.sort = e.target.value; onChange(); },
      html: `
        <option value="fppg">Sort: FPPG</option>
        <option value="pts">PTS</option>
        <option value="reb">REB</option>
        <option value="ast">AST</option>
        <option value="stl">STL</option>
        <option value="blk">BLK</option>
        <option value="to">TO</option>
        <option value="age">Age</option>
        <option value="name">Name</option>`,
    }),
  );
  // Sync select values to current state.
  const [qInput, posSel, sortSel] = wrap.children;
  posSel.value  = f.pos;
  sortSel.value = f.sort;
  return wrap;
}

function wireAvailableFilters() { /* handled by buildFilterBar */ }

async function renderAvailableTable() {
  const tbl = $('#tbl-available');
  if (!tbl) return;
  const d = state.draft;
  if (!d) return;

  const params = new URLSearchParams({
    available: 'true',
    sort: state.draftFilter.sort,
    limit: '80',
  });
  if (state.draftFilter.q)   params.set('q', state.draftFilter.q);
  if (state.draftFilter.pos) params.set('pos', state.draftFilter.pos);

  let players;
  try {
    players = await api(`/api/players?${params.toString()}`);
  } catch (e) {
    tbl.innerHTML = `<tbody><tr><td class="empty-state">Failed to load: ${escapeHtml(e.message)}</td></tr></tbody>`;
    return;
  }

  const canDraft = !d.is_complete && d.current_team_id === d.human_team_id;
  tbl.innerHTML = renderPlayersTable(players, {
    withDraft: true,
    canDraft,
  });
  tbl.querySelectorAll('button[data-draft]').forEach((btn) => {
    btn.addEventListener('click', () => onDraftPlayer(parseInt(btn.dataset.draft, 10)));
  });
}

function renderPlayersTable(players, { withDraft = false, canDraft = false } = {}) {
  const head = `<thead><tr>
    <th>Player</th><th>Pos</th><th>Team</th>
    <th class="num">Age</th>
    <th class="num">FPPG</th>
    <th class="num">PTS</th><th class="num">REB</th>
    <th class="num">AST</th><th class="num">STL</th>
    <th class="num">BLK</th><th class="num">TO</th>
    <th class="num">GP</th>
    ${withDraft ? '<th></th>' : ''}
  </tr></thead>`;

  if (!players.length) {
    return head + `<tbody><tr><td colspan="${withDraft ? 13 : 12}" class="empty-state">No players match.</td></tr></tbody>`;
  }

  // Two rows for responsive: desktop uses full cells; mobile collapses via CSS grid-areas.
  const body = players.map((p) => {
    const actionCell = withDraft
      ? `<td class="act"><button class="btn small" data-draft="${p.id}" ${canDraft ? '' : 'disabled'}>Draft</button></td>`
      : '';
    return `<tr>
      <td class="name">${escapeHtml(p.name)}</td>
      <td class="hidden-m"><span class="pos-tag">${escapeHtml(p.pos)}</span></td>
      <td class="meta-row">${escapeHtml(p.pos)} · ${escapeHtml(p.team)} · Age ${p.age}</td>
      <td class="hidden-m num meta">${p.age}</td>
      <td class="num fppg hidden-m">${fppg(p.fppg)}</td>
      <td class="stats" colspan="1">
        <span class="s fppg"><b>${fppg(p.fppg)}</b>FPPG</span>
        <span class="s"><b>${fmtStat(p.pts)}</b>PTS</span>
        <span class="s"><b>${fmtStat(p.reb)}</b>REB</span>
        <span class="s"><b>${fmtStat(p.ast)}</b>AST</span>
      </td>
      <td class="num hidden-m">${fmtStat(p.reb)}</td>
      <td class="num hidden-m">${fmtStat(p.ast)}</td>
      <td class="num hidden-m">${fmtStat(p.stl)}</td>
      <td class="num hidden-m">${fmtStat(p.blk)}</td>
      <td class="num hidden-m">${fmtStat(p.to)}</td>
      <td class="num meta hidden-m">${p.gp ?? '-'}</td>
      ${actionCell}
    </tr>`;
  }).join('');

  return head + '<tbody>' + body + '</tbody>';
}

// ================================================================ TEAMS VIEW
function renderTeamsView(root) {
  const d = state.draft;
  if (!d) {
    root.append(el('div', { class: 'empty-state' }, 'Loading...'));
    return;
  }

  const teamSelect = el('select', {
    id: 'team-pick',
    onchange: (e) => {
      state.selectedTeamId = parseInt(e.target.value, 10);
      renderTeamBody();
    },
    html: d.teams.map((t) =>
      `<option value="${t.id}" ${t.id === state.selectedTeamId ? 'selected' : ''}>${escapeHtml(t.name)}${t.is_human ? ' (you)' : ''}</option>`
    ).join(''),
  });

  const panel = el('div', { class: 'panel' },
    el('div', { class: 'panel-head' },
      el('h2', {}, 'Team roster'),
      teamSelect,
    ),
    el('div', { id: 'team-body' }),
  );
  root.append(panel);
  renderTeamBody();
}

async function renderTeamBody() {
  const container = $('#team-body');
  if (!container) return;
  const tid = state.selectedTeamId;
  container.innerHTML = '<div class="empty-state">Loading...</div>';

  let data;
  try {
    data = await api(`/api/teams/${tid}`);
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }
  const { team, players, totals, persona_desc } = data;

  const html = `
    <div class="team-summary">
      <div class="name-row">
        <span class="tname">${escapeHtml(team.name)}</span>
        ${team.is_human ? '<span class="pill success">You</span>' : ''}
        ${team.gm_persona ? `<span class="tmeta">Persona: ${escapeHtml(team.gm_persona)}</span>` : ''}
      </div>
      ${persona_desc ? `<div class="persona">${escapeHtml(persona_desc)}</div>` : ''}
      <div class="totals">
        <span class="stat">FPPG Total <b>${fppg(totals.fppg)}</b></span>
        <span class="stat">PTS <b>${fmtStat(totals.pts)}</b></span>
        <span class="stat">REB <b>${fmtStat(totals.reb)}</b></span>
        <span class="stat">AST <b>${fmtStat(totals.ast)}</b></span>
        <span class="stat">STL <b>${fmtStat(totals.stl)}</b></span>
        <span class="stat">BLK <b>${fmtStat(totals.blk)}</b></span>
        <span class="stat">TO <b>${fmtStat(totals.to)}</b></span>
      </div>
    </div>
    ${players.length === 0
      ? `<div class="empty-state"><p>No players drafted yet.</p></div>`
      : `<div class="table-wrap"><table class="data players-table responsive">${renderPlayersTable(players)}</table></div>`}
  `;
  container.innerHTML = html;
}

// ================================================================ FREE AGENTS
function renderFaView(root) {
  root.append(
    el('div', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', {}, 'Free Agents')),
      el('div', { class: 'panel-body' },
        buildFilterBar('faFilter', renderFaTable),
        el('div', { class: 'table-wrap' },
          el('table', { class: 'data players-table responsive', id: 'tbl-fa' }),
        ),
      ),
    ),
  );
  renderFaTable();
}

async function renderFaTable() {
  const tbl = $('#tbl-fa');
  if (!tbl) return;
  const params = new URLSearchParams({
    available: 'true',
    sort: state.faFilter.sort,
    limit: '400',
  });
  if (state.faFilter.q)   params.set('q', state.faFilter.q);
  if (state.faFilter.pos) params.set('pos', state.faFilter.pos);

  let players;
  try {
    players = await api(`/api/players?${params.toString()}`);
  } catch (e) {
    tbl.innerHTML = `<tbody><tr><td class="empty-state">Failed to load: ${escapeHtml(e.message)}</td></tr></tbody>`;
    return;
  }
  tbl.innerHTML = renderPlayersTable(players);
}

// ================================================================ LEAGUE VIEW
function renderLeagueView(root) {
  const d = state.draft;
  if (!d) { root.append(el('div', { class: 'empty-state' }, 'Loading...')); return; }

  if (!d.is_complete) {
    root.append(
      emptyState(
        'Draft not complete',
        `You are on pick ${d.current_overall} of ${d.num_teams * d.total_rounds}. Finish the draft before starting the season.`,
        el('a', { class: 'btn', href: '#draft' }, 'Go to Draft'),
      ),
    );
    return;
  }

  if (!state.standings) {
    root.append(
      el('div', { class: 'panel' },
        el('div', { class: 'panel-head' },
          el('h2', {}, 'Season'),
        ),
        emptyState(
          'Season not started',
          'Commit your draft to build a 14-week schedule. AI teams run on heuristics or Claude (if API key configured).',
          el('button', { class: 'btn', onclick: onSeasonStart }, 'Start Season'),
        ),
      ),
    );
    return;
  }

  // Standings + controls + matchups.
  const controls = el('div', { class: 'panel' },
    el('div', { class: 'panel-head' },
      el('h2', {}, 'Controls'),
      el('div', { class: 'actions' },
        el('button', { class: 'btn ghost', onclick: onAdvanceDay }, 'Advance 1 Day'),
        el('button', { class: 'btn ghost', onclick: onAdvanceWeek }, 'Advance Week'),
        el('button', { class: 'btn ghost', onclick: openProposeTradeDialog }, 'Propose Trade'),
        el('button', { class: 'btn', onclick: onSimToPlayoffs }, 'Sim to Playoffs'),
      ),
    ),
  );

  const tradesPanel = el('div', { class: 'panel', id: 'panel-trades' },
    el('div', { class: 'panel-head' },
      el('h2', {}, 'Pending Trades'),
      el('div', { id: 'trade-quota-badge', class: 'trade-quota-wrap' }),
    ),
    el('div', { class: 'panel-body', id: 'trade-pending-body' },
      el('div', { class: 'empty-state' }, 'Loading trades...'),
    ),
  );

  const historyPanel = el('div', { class: 'panel', id: 'panel-trade-history' },
    el('button', {
      type: 'button',
      class: 'panel-head collapsible-head',
      'aria-expanded': state.tradeHistoryOpen ? 'true' : 'false',
      onclick: onToggleTradeHistory,
    },
      el('h2', {}, 'Recent Trade Activity'),
      el('span', { class: 'chevron', id: 'trade-history-chevron' }, state.tradeHistoryOpen ? '▾' : '▸'),
    ),
    el('div', {
      class: 'panel-body',
      id: 'trade-history-body',
      hidden: !state.tradeHistoryOpen,
    }),
  );

  const grid = el('div', { class: 'league-grid' },
    buildStandingsPanel(),
    buildCurrentMatchupsPanel(),
  );

  root.append(controls, tradesPanel, historyPanel, grid);

  // Kick off trade data fetch + render.
  refreshTrades();
  if (state.tradeHistoryOpen) refreshTradeHistory();
}

function buildStandingsPanel() {
  const panel = el('div', { class: 'panel' },
    el('div', { class: 'panel-head' }, el('h2', {}, 'Standings')),
    el('div', { class: 'table-wrap' }),
  );
  const wrap = panel.querySelector('.table-wrap');

  const rows = Array.isArray(state.standings) ? state.standings : (state.standings?.standings || []);
  if (!rows.length) {
    wrap.append(el('div', { class: 'empty-state' }, 'No standings yet.'));
    return panel;
  }

  const tbl = el('table', { class: 'data' });
  tbl.innerHTML = `
    <thead><tr>
      <th>#</th><th>Team</th>
      <th class="num">W-L</th>
      <th class="num">PF</th>
      <th class="num">PA</th>
    </tr></thead>
    <tbody>${rows.map((r, i) => {
      const isYou = r.is_human || r.human || r.team_id === state.draft?.human_team_id;
      const wins   = r.w ?? r.wins ?? 0;
      const losses = r.l ?? r.losses ?? 0;
      const pf     = r.pf ?? r.points_for ?? 0;
      const pa     = r.pa ?? r.points_against ?? 0;
      return `<tr class="standings-row ${isYou ? 'you' : ''}">
        <td class="rank">${r.rank ?? (i + 1)}</td>
        <td class="name">${escapeHtml(r.name || r.team_name || `Team ${r.team_id}`)}</td>
        <td class="num record">${wins}-${losses}</td>
        <td class="num">${fmtStat(pf)}</td>
        <td class="num">${fmtStat(pa)}</td>
      </tr>`;
    }).join('')}</tbody>
  `;
  wrap.append(tbl);
  return panel;
}

function buildCurrentMatchupsPanel() {
  const panel = el('div', { class: 'panel' });
  const week = currentWeekNumber();
  panel.append(
    el('div', { class: 'panel-head' },
      el('h2', {}, `Week ${week} Matchups`),
    ),
  );
  const body = el('div', { class: 'panel-body tight' });
  panel.append(body);

  const matchups = matchupsForWeek(week);
  if (!matchups.length) {
    body.append(el('div', { class: 'empty-state' }, 'No matchups for this week yet.'));
    return panel;
  }

  for (const m of matchups) {
    body.append(buildMatchupCard(m));
  }
  return panel;
}

function currentWeekNumber() {
  return state.standings?.current_week
      || state.schedule?.current_week
      || 1;
}

function scheduleList() {
  // Schedule endpoint returns { schedule: [ {week, team_a, team_b, score_a, score_b, winner, complete}, ... ] }
  // Also tolerates { weeks: [...] } or plain array.
  const s = state.schedule;
  if (!s) return [];
  if (Array.isArray(s)) return s;
  if (Array.isArray(s.schedule)) return s.schedule;
  if (Array.isArray(s.weeks))    return s.weeks.flatMap((w) => w.matchups || []);
  return [];
}

function matchupsForWeek(weekNum) {
  return scheduleList().filter((m) => (m.week ?? m.number) === weekNum);
}

function groupedByWeek() {
  const out = new Map();
  for (const m of scheduleList()) {
    const w = m.week ?? m.number;
    if (w == null) continue;
    if (!out.has(w)) out.set(w, []);
    out.get(w).push(m);
  }
  return out;
}

function buildMatchupCard(m) {
  const scoreA   = m.score_a ?? m.home_score ?? m.home_points;
  const scoreB   = m.score_b ?? m.away_score ?? m.away_points;
  const teamA    = m.team_a ?? m.home_team_id;
  const teamB    = m.team_b ?? m.away_team_id;
  const played   = m.complete || m.played || m.final || (scoreA != null && scoreB != null);
  const winner   = played && scoreA != null && scoreB != null
    ? (scoreA > scoreB ? 'left' : 'right')
    : null;
  const week     = m.week ?? m.number;
  return el('div', { class: `matchup-card ${winner ? 'winner-' + winner : ''}`, onclick: () => openMatchupDialog(week, m) },
    el('div', { class: 'side left' },
      el('span', { class: 'tm' }, teamName(teamA) || `Team ${teamA}`),
      el('span', { class: 'sc' }, played ? fmtStat(scoreA) : '-'),
    ),
    el('span', { class: 'vs' }, 'VS'),
    el('div', { class: 'side right' },
      el('span', { class: 'tm' }, teamName(teamB) || `Team ${teamB}`),
      el('span', { class: 'sc' }, played ? fmtStat(scoreB) : '-'),
    ),
  );
}

function teamName(tid) {
  if (tid == null || !state.draft) return null;
  return state.draft.teams[tid]?.name;
}

// ================================================================ SCHEDULE
function renderScheduleView(root) {
  const d = state.draft;
  if (!d) { root.append(el('div', { class: 'empty-state' }, 'Loading...')); return; }

  const byWeek = groupedByWeek();
  if (byWeek.size === 0) {
    root.append(
      el('div', { class: 'panel' },
        el('div', { class: 'panel-head' }, el('h2', {}, 'Schedule')),
        emptyState(
          'Season not started',
          'The schedule will be generated when the season begins.',
          el('a', { class: 'btn', href: '#league' }, 'Go to League'),
        ),
      ),
    );
    return;
  }

  const currentWeek = currentWeekNumber();
  const regularWeeks = state.standings?.regular_weeks || 14;
  const grid = el('div', { class: 'schedule-grid' });

  const weekNums = Array.from(byWeek.keys()).sort((a, b) => a - b);
  for (const wkNum of weekNums) {
    const matchups = byWeek.get(wkNum) || [];
    const isPlayoff = wkNum > regularWeeks;
    const played    = matchups.length > 0 && matchups.every((m) => m.complete || m.played);
    const isCurrent = wkNum === currentWeek;
    const classes = ['week-cell'];
    if (isCurrent) classes.push('current');
    if (played)    classes.push('played');
    if (isPlayoff) classes.push('playoff');

    const cell = el('button', { class: classes.join(' '), type: 'button', onclick: () => openWeekDialog(wkNum, matchups, isPlayoff) },
      el('span', { class: 'wk-num' }, isPlayoff ? `Playoffs W${wkNum}` : `Week ${wkNum}`),
      el('span', { class: 'wk-title' }, played ? 'Final' : isCurrent ? 'Current' : 'Upcoming'),
      el('span', { class: 'wk-sub' }, `${matchups.length} matchup${matchups.length === 1 ? '' : 's'}`),
    );
    grid.append(cell);
  }

  root.append(
    el('div', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', {}, 'Schedule')),
      el('div', { class: 'panel-body' }, grid),
    ),
  );
}

function openWeekDialog(weekNum, matchups, isPlayoff) {
  const dlg = $('#dlg-matchup');
  $('#matchup-title').textContent = (isPlayoff ? 'Playoffs ' : '') + `Week ${weekNum}`;
  const body = $('#matchup-body');
  body.innerHTML = '';
  if (!matchups.length) {
    body.append(el('div', { class: 'empty-state' }, 'No matchups.'));
  } else {
    for (const m of matchups) {
      body.append(buildMatchupDetail(m));
    }
  }
  try { dlg.showModal(); } catch { /* dialog unsupported */ }
}

function openMatchupDialog(week, m) {
  const dlg = $('#dlg-matchup');
  const a = teamName(m.team_a ?? m.home_team_id) || 'Home';
  const b = teamName(m.team_b ?? m.away_team_id) || 'Away';
  $('#matchup-title').textContent = `Week ${week} — ${a} vs ${b}`;
  const body = $('#matchup-body');
  body.innerHTML = '';
  body.append(buildMatchupDetail(m));
  try { dlg.showModal(); } catch { /* dialog unsupported */ }
}

function buildMatchupDetail(m) {
  const scoreA = m.score_a ?? m.home_score ?? m.home_points;
  const scoreB = m.score_b ?? m.away_score ?? m.away_points;
  const teamA  = m.team_a ?? m.home_team_id;
  const teamB  = m.team_b ?? m.away_team_id;
  const played = m.complete || m.played || m.final || (scoreA != null && scoreB != null);
  const winnerId = m.winner;

  const nameA = teamName(teamA) || `Team ${teamA}`;
  const nameB = teamName(teamB) || `Team ${teamB}`;

  const wrap = el('div', { class: 'matchup-detail' });
  wrap.innerHTML = `
    <div class="matchup-side">
      <div class="tname">${escapeHtml(nameA)}${played && winnerId === teamA ? ' <span class="pill success">W</span>' : ''}</div>
      <div class="score">${played ? fmtStat(scoreA) : '-'}</div>
    </div>
    <div class="matchup-side">
      <div class="tname">${escapeHtml(nameB)}${played && winnerId === teamB ? ' <span class="pill success">W</span>' : ''}</div>
      <div class="score">${played ? fmtStat(scoreB) : '-'}</div>
    </div>
  `;
  return wrap;
}

// ================================================================ TRADES (Wave E)

function startTradesPolling() {
  if (state.tradesPollTimer) return;
  refreshTrades();
  state.tradesPollTimer = setInterval(() => {
    if (location.hash.replace(/^#/, '') !== 'league') return;
    refreshTrades();
  }, 5000);
}

function stopTradesPolling() {
  if (state.tradesPollTimer) clearInterval(state.tradesPollTimer);
  state.tradesPollTimer = null;
}

async function refreshTrades() {
  const body = $('#trade-pending-body');
  const quotaEl = $('#trade-quota-badge');
  const pending = await apiSoft('/api/trades/pending');
  if (!body) return;

  // Accept either {pending:[...], require_human_attention:[...]} or a flat list.
  let list = [];
  let requireAttention = [];
  if (Array.isArray(pending)) {
    list = pending;
  } else if (pending && Array.isArray(pending.pending)) {
    list = pending.pending;
    requireAttention = Array.isArray(pending.require_human_attention)
      ? pending.require_human_attention : [];
  }
  state.tradesPending = list;
  state.tradesRequireAttention = requireAttention;

  // Preload all involved players so cards can render names/fppg.
  const ids = new Set();
  for (const t of list) {
    for (const pid of (t.send_player_ids || [])) ids.add(pid);
    for (const pid of (t.receive_player_ids || [])) ids.add(pid);
  }
  await ensurePlayersCached(Array.from(ids));

  renderTradeQuota(quotaEl);
  renderPendingTrades(body);
}

function renderTradeQuota(wrap) {
  if (!wrap) return;
  const q = state.standings?.trade_quota;
  const pendingCount = state.standings?.pending_count ?? state.tradesPending.length;
  if (!q) { wrap.innerHTML = ''; return; }
  const behind = q.behind ?? 0;
  let cls = 'ok';
  if (behind >= 3) cls = 'bad';
  else if (behind >= 1) cls = 'warn';
  wrap.innerHTML = `
    <span class="trade-quota-badge ${cls}">
      Trades this season: <b>${q.executed}</b> / ${q.target}
      ${behind > 0 ? ` · ${behind} behind` : ' · on pace'}
    </span>
    ${pendingCount ? `<span class="pill warn">${pendingCount} pending</span>` : ''}
  `;
}

function renderPendingTrades(body) {
  body.innerHTML = '';
  if (!state.tradesPending.length) {
    body.append(el('div', { class: 'empty-state' }, 'No pending trades'));
    return;
  }
  for (const t of state.tradesPending) {
    body.append(buildTradeCard(t));
  }
}

function buildTradeCard(trade) {
  const card = el('div', { class: `trade-card status-${trade.status}` });

  const fromName = teamName(trade.from_team) || `Team ${trade.from_team}`;
  const toName   = teamName(trade.to_team)   || `Team ${trade.to_team}`;

  const sendPlayers = (trade.send_player_ids || []).map((id) => state.playerCache.get(id)).filter(Boolean);
  const recvPlayers = (trade.receive_player_ids || []).map((id) => state.playerCache.get(id)).filter(Boolean);

  const sendSum = sendPlayers.reduce((s, p) => s + (p.fppg || 0), 0);
  const recvSum = recvPlayers.reduce((s, p) => s + (p.fppg || 0), 0);
  const ratio = Math.max(sendSum, recvSum) / Math.max(Math.min(sendSum, recvSum), 0.001);
  let ratioCls = 'ok';
  if (ratio > 1.30) ratioCls = 'bad';
  else if (ratio > 1.15) ratioCls = 'warn';

  // Header: teams + status
  const head = el('div', { class: 'trade-head' },
    el('div', { class: 'trade-teams' },
      el('span', { class: 'tm from' }, fromName),
      el('span', { class: 'arrow' }, '→'),
      el('span', { class: 'tm to' }, toName),
    ),
    buildTradeStatusBadge(trade),
  );

  // Player columns
  const sides = el('div', { class: 'trade-sides' },
    buildTradeSide(`${fromName} sends`, sendPlayers, sendSum),
    buildTradeSide(`${toName} sends`, recvPlayers, recvSum),
  );

  // Balance
  const balance = el('div', { class: 'trade-balance' },
    el('span', {}, `Σ ${fppg(sendSum)} FPPG`),
    el('span', { class: `trade-ratio-badge ${ratioCls}` }, `ratio ${ratio.toFixed(2)}x`),
    el('span', {}, `Σ ${fppg(recvSum)} FPPG`),
  );

  // Reasoning (if present + not just "human")
  const parts = [head, sides, balance];
  if (trade.reasoning && trade.reasoning !== 'human') {
    parts.push(el('div', { class: 'trade-reasoning' }, trade.reasoning));
  }

  // Veto vote count (for accepted trades)
  if (trade.status === 'accepted') {
    const votes = (trade.veto_votes || []).length;
    parts.push(el('div', { class: 'veto-vote-count' }, `Veto votes: ${votes} / 3`));
  }

  // Action buttons
  const actions = buildTradeActions(trade);
  if (actions) parts.push(actions);

  card.append(...parts);
  return card;
}

function buildTradeStatusBadge(trade) {
  const label = trade.status.replace(/_/g, ' ');
  if (trade.status === 'accepted' && trade.veto_deadline_day != null) {
    return el('span', { class: `trade-status trade-status-${trade.status}` },
      `accepted · veto window closes day ${trade.veto_deadline_day}`);
  }
  return el('span', { class: `trade-status trade-status-${trade.status}` }, label);
}

function buildTradeSide(title, players, sum) {
  const wrap = el('div', { class: 'trade-side' },
    el('div', { class: 'trade-side-title' }, title),
  );
  const list = el('ul', { class: 'trade-player-list' });
  if (!players.length) {
    list.append(el('li', { class: 'empty' }, '(none)'));
  } else {
    for (const p of players) {
      list.append(el('li', {},
        el('span', { class: 'pname' }, p.name || `#${p.id}`),
        el('span', { class: 'pfppg' }, fppg(p.fppg)),
      ));
    }
  }
  wrap.append(list);
  wrap.append(el('div', { class: 'trade-side-sum' }, `Σ ${fppg(sum)}`));
  return wrap;
}

function buildTradeActions(trade) {
  const humanId = state.draft?.human_team_id ?? 0;
  const status  = trade.status;
  const actions = el('div', { class: 'trade-actions' });

  if (status === 'pending_accept' && trade.to_team === humanId) {
    actions.append(
      el('button', { class: 'btn small', onclick: () => onAcceptTrade(trade.id) }, 'Accept'),
      el('button', { class: 'btn small ghost', onclick: () => onRejectTrade(trade.id) }, 'Reject'),
    );
    return actions;
  }
  if (status === 'pending_accept' && trade.from_team === humanId) {
    actions.append(
      el('button', { class: 'btn small ghost', onclick: () => onCancelTrade(trade.id) }, 'Cancel'),
    );
    return actions;
  }
  if (status === 'accepted'
      && trade.from_team !== humanId
      && trade.to_team !== humanId
      && !(trade.veto_votes || []).includes(humanId)) {
    actions.append(
      el('button', { class: 'btn small danger', onclick: () => onVetoTrade(trade.id) }, 'Cast Veto'),
    );
    return actions;
  }
  return null;
}

async function ensurePlayersCached(ids) {
  const need = ids.filter((id) => !state.playerCache.has(id));
  if (!need.length) return;
  // Fetch all players (drafted + free agents) once; index by id.
  try {
    const all = await api('/api/players?limit=600&available=false');
    for (const p of all) state.playerCache.set(p.id, p);
  } catch {
    // Fall back: fetch each teams/{id} until we find them (rare).
  }
}

async function onToggleTradeHistory() {
  state.tradeHistoryOpen = !state.tradeHistoryOpen;
  const body = $('#trade-history-body');
  const chev = $('#trade-history-chevron');
  const head = $('#panel-trade-history .collapsible-head');
  if (body) body.hidden = !state.tradeHistoryOpen;
  if (chev) chev.textContent = state.tradeHistoryOpen ? '▾' : '▸';
  if (head) head.setAttribute('aria-expanded', state.tradeHistoryOpen ? 'true' : 'false');
  if (state.tradeHistoryOpen) await refreshTradeHistory();
}

async function refreshTradeHistory() {
  const body = $('#trade-history-body');
  if (!body) return;
  body.innerHTML = '<div class="empty-state">Loading...</div>';
  const payload = await apiSoft('/api/trades/history?limit=20');
  let hist = [];
  if (Array.isArray(payload)) hist = payload;
  else if (payload && Array.isArray(payload.history)) hist = payload.history;
  state.tradesHistory = hist;

  // Preload involved players.
  const ids = new Set();
  for (const t of hist) {
    for (const pid of (t.send_player_ids || [])) ids.add(pid);
    for (const pid of (t.receive_player_ids || [])) ids.add(pid);
  }
  await ensurePlayersCached(Array.from(ids));

  renderTradeHistoryBody(body);
}

function renderTradeHistoryBody(body) {
  body.innerHTML = '';
  if (!state.tradesHistory.length) {
    body.append(el('div', { class: 'empty-state' }, 'No trade history yet.'));
    return;
  }
  const list = el('ul', { class: 'trade-history-list' });
  for (const t of state.tradesHistory) {
    list.append(buildTradeHistoryRow(t));
  }
  body.append(list);
}

function buildTradeHistoryRow(trade) {
  const fromName = teamName(trade.from_team) || `T${trade.from_team}`;
  const toName   = teamName(trade.to_team)   || `T${trade.to_team}`;
  const week     = trade.proposed_week ?? '?';
  const day      = trade.executed_day ?? trade.proposed_day ?? '?';
  const nSend    = (trade.send_player_ids || []).length;
  const nRecv    = (trade.receive_player_ids || []).length;
  const expanded = state.expandedHistory.has(trade.id);

  const row = el('li', { class: 'trade-hist-row' });
  const header = el('button', { type: 'button', class: 'trade-hist-head', onclick: () => onToggleHistRow(trade.id) },
    el('span', { class: 'wk' }, `W${week} D${day}`),
    el('span', { class: 'teams' }, `${fromName} → ${toName}`),
    el('span', { class: 'counts' }, `${nSend}→${nRecv} players`),
    el('span', { class: `trade-status trade-status-${trade.status}` }, trade.status),
    el('span', { class: 'chevron' }, expanded ? '▾' : '▸'),
  );
  row.append(header);
  if (expanded) {
    row.append(buildTradeHistoryDetail(trade));
  }
  return row;
}

function onToggleHistRow(id) {
  if (state.expandedHistory.has(id)) state.expandedHistory.delete(id);
  else state.expandedHistory.add(id);
  const body = $('#trade-history-body');
  if (body) renderTradeHistoryBody(body);
}

function buildTradeHistoryDetail(trade) {
  const sendPlayers = (trade.send_player_ids || []).map((id) => state.playerCache.get(id)).filter(Boolean);
  const recvPlayers = (trade.receive_player_ids || []).map((id) => state.playerCache.get(id)).filter(Boolean);
  const detail = el('div', { class: 'trade-hist-detail' });
  const ul1 = el('ul', { class: 'trade-hist-players' });
  for (const p of sendPlayers) ul1.append(el('li', {}, `${p.name} (${fppg(p.fppg)})`));
  const ul2 = el('ul', { class: 'trade-hist-players' });
  for (const p of recvPlayers) ul2.append(el('li', {}, `${p.name} (${fppg(p.fppg)})`));
  detail.append(
    el('div', { class: 'trade-hist-col' },
      el('div', { class: 'trade-hist-col-head' }, `${teamName(trade.from_team) || 'From'} sent`),
      ul1,
    ),
    el('div', { class: 'trade-hist-col' },
      el('div', { class: 'trade-hist-col-head' }, `${teamName(trade.to_team) || 'To'} sent`),
      ul2,
    ),
  );
  if (trade.reasoning && trade.reasoning !== 'human') {
    detail.append(el('div', { class: 'trade-reasoning hist' }, trade.reasoning));
  }
  return detail;
}

// Trade action handlers
async function onAcceptTrade(id) {
  await mutate(async () => {
    await api(`/api/trades/${id}/accept`, { method: 'POST' });
    await afterTradeMutation();
  }, 'Trade accepted');
}
async function onRejectTrade(id) {
  await mutate(async () => {
    await api(`/api/trades/${id}/reject`, { method: 'POST' });
    await afterTradeMutation();
  }, 'Trade rejected');
}
async function onCancelTrade(id) {
  const ok = await confirmDialog('Cancel trade?', 'Withdraw your proposal. This cannot be undone.', 'Cancel');
  if (!ok) return;
  await mutate(async () => {
    await api(`/api/trades/${id}/cancel`, { method: 'POST' });
    await afterTradeMutation();
  }, 'Trade cancelled');
}
async function onVetoTrade(id) {
  const ok = await confirmDialog('Cast veto?', 'Your team will vote to veto this trade. 3 vetoes cancels it.', 'Veto');
  if (!ok) return;
  await mutate(async () => {
    const humanId = state.draft?.human_team_id ?? 0;
    await api(`/api/trades/${id}/veto`, {
      method: 'POST',
      body: JSON.stringify({ team_id: humanId }),
    });
    await afterTradeMutation();
  }, 'Veto cast');
}

async function afterTradeMutation() {
  await refreshState();
  await refreshTrades();
  if (state.tradeHistoryOpen) await refreshTradeHistory();
}

// ---------------------------------------------------------------- propose trade modal

async function openProposeTradeDialog() {
  const dlg = $('#trade-propose');
  if (!dlg) return;
  const humanId = state.draft?.human_team_id ?? 0;
  state.proposeDraft = {
    counterparty: null,
    send: new Set(),
    receive: new Set(),
    counterpartyRoster: [],
    humanRoster: [],
  };

  // Preload human roster.
  try {
    const data = await api(`/api/teams/${humanId}`);
    state.proposeDraft.humanRoster = data.players || [];
    for (const p of state.proposeDraft.humanRoster) state.playerCache.set(p.id, p);
  } catch {
    state.proposeDraft.humanRoster = [];
  }

  renderProposeBody();
  try { dlg.showModal(); } catch { /* dialog unsupported */ }
}

async function onCounterpartyChange(e) {
  const id = parseInt(e.target.value, 10);
  state.proposeDraft.counterparty = Number.isFinite(id) ? id : null;
  state.proposeDraft.receive = new Set();
  if (state.proposeDraft.counterparty != null) {
    try {
      const data = await api(`/api/teams/${state.proposeDraft.counterparty}`);
      state.proposeDraft.counterpartyRoster = data.players || [];
      for (const p of state.proposeDraft.counterpartyRoster) state.playerCache.set(p.id, p);
    } catch {
      state.proposeDraft.counterpartyRoster = [];
    }
  } else {
    state.proposeDraft.counterpartyRoster = [];
  }
  renderProposeBody();
}

function renderProposeBody() {
  const body = $('#trade-propose-body');
  if (!body) return;
  body.innerHTML = '';
  const humanId = state.draft?.human_team_id ?? 0;

  // Counterparty dropdown
  const options = [el('option', { value: '' }, '— pick a team —')];
  for (const t of (state.draft?.teams || [])) {
    if (t.id === humanId) continue;
    options.push(el('option', { value: String(t.id) }, t.name));
  }
  const select = el('select', { id: 'cp-select', onchange: onCounterpartyChange }, ...options);
  if (state.proposeDraft.counterparty != null) select.value = String(state.proposeDraft.counterparty);

  body.append(
    el('div', { class: 'propose-row' },
      el('label', { for: 'cp-select' }, 'Counterparty'),
      select,
    ),
  );

  if (state.proposeDraft.counterparty == null) {
    body.append(el('div', { class: 'empty-state' }, 'Pick a team to see rosters.'));
    return;
  }

  // Side-by-side rosters
  const sides = el('div', { class: 'propose-sides' },
    buildProposeSide('Send (your roster)', state.proposeDraft.humanRoster, state.proposeDraft.send, 'send'),
    buildProposeSide('Receive (their roster)', state.proposeDraft.counterpartyRoster, state.proposeDraft.receive, 'receive'),
  );
  body.append(sides);

  // Balance display
  const sendSum = Array.from(state.proposeDraft.send).reduce((s, id) => {
    const p = state.playerCache.get(id); return s + (p?.fppg || 0);
  }, 0);
  const recvSum = Array.from(state.proposeDraft.receive).reduce((s, id) => {
    const p = state.playerCache.get(id); return s + (p?.fppg || 0);
  }, 0);
  const ratio = sendSum > 0 && recvSum > 0
    ? Math.max(sendSum, recvSum) / Math.min(sendSum, recvSum)
    : 0;
  let ratioCls = 'ok';
  if (ratio > 1.30) ratioCls = 'bad';
  else if (ratio > 1.15) ratioCls = 'warn';

  body.append(
    el('div', { class: 'propose-balance' },
      el('span', {}, `Send Σ ${fppg(sendSum)}`),
      ratio ? el('span', { class: `trade-ratio-badge ${ratioCls}` }, `ratio ${ratio.toFixed(2)}x`) : el('span', {}, '—'),
      el('span', {}, `Receive Σ ${fppg(recvSum)}`),
    ),
  );
}

function buildProposeSide(title, players, selectedSet, which) {
  const wrap = el('div', { class: 'propose-side' },
    el('div', { class: 'propose-side-title' }, title),
  );
  const list = el('ul', { class: 'propose-player-list' });
  for (const p of players.slice().sort((a, b) => (b.fppg || 0) - (a.fppg || 0))) {
    const checked = selectedSet.has(p.id);
    const li = el('li', { class: checked ? 'selected' : '' },
      el('label', {},
        el('input', {
          type: 'checkbox',
          checked: checked ? true : null,
          onchange: (e) => togglePickPlayer(which, p.id, e.target.checked),
        }),
        el('span', { class: 'pname' }, p.name),
        el('span', { class: 'pmeta' }, `${p.pos} · ${fppg(p.fppg)}`),
      ),
    );
    list.append(li);
  }
  if (!players.length) {
    list.append(el('li', { class: 'empty' }, '(no players)'));
  }
  wrap.append(list);
  return wrap;
}

function togglePickPlayer(which, id, checked) {
  const set = state.proposeDraft[which];
  if (checked) {
    if (set.size >= 3) {
      toast('Max 3 players per side', 'warn');
      renderProposeBody();
      return;
    }
    set.add(id);
  } else {
    set.delete(id);
  }
  renderProposeBody();
}

async function onSubmitProposeTrade() {
  const humanId = state.draft?.human_team_id ?? 0;
  const { counterparty, send, receive } = state.proposeDraft;
  if (counterparty == null) { toast('Pick a counterparty', 'warn'); return; }
  if (!send.size || !receive.size) { toast('Pick at least one player on each side', 'warn'); return; }

  try {
    await api('/api/trades/propose', {
      method: 'POST',
      body: JSON.stringify({
        from_team: humanId,
        to_team: counterparty,
        send: Array.from(send),
        receive: Array.from(receive),
      }),
    });
    toast('Trade proposed', 'success');
    $('#trade-propose').close();
    await afterTradeMutation();
  } catch (e) {
    toast(e.message || 'Proposal failed', 'error');
  }
}

// ================================================================ log aside
function renderLogAside() {
  const list = $('#log-list');
  if (!list) return;
  if (!state.logs.length) {
    list.innerHTML = `<li class="empty">No activity yet.</li>`;
    return;
  }
  // Newest first; backend appends in order so reverse.
  list.innerHTML = state.logs.slice().reverse().slice(0, 30).map((e) => {
    const tsNum = typeof e.ts === 'number' ? e.ts : (typeof e.timestamp === 'number' ? e.timestamp : null);
    const ts = tsNum ? new Date(tsNum * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : (e.ts || '');
    const msg = formatLogEntry(e);
    return `<li><span class="ts">${escapeHtml(ts)}</span><span class="msg">${escapeHtml(msg)}</span></li>`;
  }).join('');
}

function formatLogEntry(e) {
  if (e.message) return e.message;
  if (e.msg)     return e.msg;
  if (e.text)    return e.text;
  const team = e.team_id != null ? teamName(e.team_id) || `T${e.team_id}` : null;
  const parts = [];
  if (e.type)     parts.push(e.type);
  if (team)       parts.push(team);
  if (e.action)   parts.push(e.action);
  if (e.persona)  parts.push(`(${e.persona})`);
  if (e.excerpt)  parts.push('- ' + e.excerpt);
  return parts.length ? parts.join(' ') : JSON.stringify(e);
}

// ================================================================ empty state helper
function emptyState(title, message, action) {
  const wrap = el('div', { class: 'empty-state' },
    el('h3', {}, title),
    el('p', {}, message),
  );
  if (action) wrap.append(el('div', { style: 'margin-top: 16px' }, action));
  return wrap;
}

// ================================================================ ACTIONS
async function mutate(fn, okLabel) {
  try {
    const result = await fn();
    if (okLabel) toast(okLabel, 'success');
    return result;
  } catch (e) {
    toast(e.message || 'Request failed', 'error');
    throw e;
  }
}

async function onAdvance() {
  await mutate(async () => {
    const r = await api('/api/draft/ai-advance', { method: 'POST' });
    state.draft = r.state;
    render();
  });
}

async function onSimToMe() {
  await mutate(async () => {
    const r = await api('/api/draft/sim-to-me', { method: 'POST' });
    state.draft = r.state;
    render();
  });
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
    toast(e.message || 'Pick failed', 'error');
  }
}

async function onResetDraft() {
  const ok = await confirmDialog('Reset draft?', 'All picks will be cleared. This cannot be undone.', 'Reset');
  if (!ok) return;
  await mutate(async () => {
    const r = await api('/api/draft/reset', {
      method: 'POST',
      body: JSON.stringify({ randomize_order: false }),
    });
    state.draft = r;
    navigate('draft');
    render();
  }, 'Draft reset');
}

async function onResetSeason() {
  const ok = await confirmDialog('Reset season?', 'All season results and schedules will be cleared. Draft is preserved.', 'Reset');
  if (!ok) return;
  await mutate(async () => {
    await api('/api/season/reset', { method: 'POST' });
    await refreshState();
    render();
  }, 'Season reset');
}

async function onSeasonStart() {
  await mutate(async () => {
    await api('/api/season/start', { method: 'POST' });
    await refreshState();
    render();
  }, 'Season started');
}

async function onAdvanceDay() {
  await mutate(async () => {
    const r = await api('/api/season/advance-day', { method: 'POST' });
    await refreshState();
    refreshLogs();
    render();
    const summary = r?.summary || r?.message || 'Day advanced';
    toast(summary, 'success');
  });
}

async function onAdvanceWeek() {
  await mutate(async () => {
    const r = await api('/api/season/advance-week', { method: 'POST' });
    await refreshState();
    refreshLogs();
    render();
    const summary = r?.summary || r?.message || 'Week advanced';
    toast(summary, 'success');
  });
}

async function onSimToPlayoffs() {
  const ok = await confirmDialog('Sim to Playoffs?', 'Run through all remaining regular-season weeks. This may take a moment.', 'Run');
  if (!ok) return;
  await mutate(async () => {
    await api('/api/season/sim-to-playoffs', { method: 'POST' });
    await refreshState();
    refreshLogs();
    render();
  }, 'Regular season simulated');
}

async function onSimPlayoffs() {
  const ok = await confirmDialog('Sim playoff bracket?', 'Top 4 seeds play semis + final (weeks 15-16).', 'Run');
  if (!ok) return;
  await mutate(async () => {
    await api('/api/season/sim-playoffs', { method: 'POST' });
    await refreshState();
    refreshLogs();
    render();
  }, 'Playoffs simulated');
}

// ================================================================ wiring
function bindGlobalUI() {
  // Nav + tabs: use href hash natively. Just render on hashchange.
  window.addEventListener('hashchange', render);

  // Hamburger → settings.
  $('#btn-menu').addEventListener('click', () => {
    const dlg = $('#dlg-settings');
    try { dlg.showModal(); } catch { /* fallback: do nothing */ }
  });

  // Settings buttons.
  $('#btn-season-start').addEventListener('click', () => { $('#dlg-settings').close(); onSeasonStart(); });
  $('#btn-sim-playoffs').addEventListener('click', () => { $('#dlg-settings').close(); onSimToPlayoffs(); });
  $('#btn-sim-playoffs-bracket').addEventListener('click', () => { $('#dlg-settings').close(); onSimPlayoffs(); });
  $('#btn-reset-draft').addEventListener('click', () => { $('#dlg-settings').close(); onResetDraft(); });
  $('#btn-reset-season').addEventListener('click', () => { $('#dlg-settings').close(); onResetSeason(); });

  // Log refresh button.
  $('#btn-log-refresh').addEventListener('click', () => refreshLogs());

  // Trade propose modal: submit + cancel.
  const submitBtn = $('#btn-trade-propose-submit');
  if (submitBtn) submitBtn.addEventListener('click', (e) => { e.preventDefault(); onSubmitProposeTrade(); });
}

async function init() {
  bindGlobalUI();
  try {
    state.personas = await api('/api/personas');
  } catch {
    state.personas = {};
  }
  try {
    await refreshState();
  } catch (e) {
    toast(`Failed to load state: ${e.message}`, 'error', 6000);
    return;
  }
  render();
}

init().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="color:#f87171;padding:20px;font-family:monospace;">${escapeHtml(e.stack || e.message)}</pre>`;
});
