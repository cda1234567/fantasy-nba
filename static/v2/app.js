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
};

const VALID_ROUTES = ['draft', 'teams', 'fa', 'league', 'schedule', 'trades'];

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
    case 'teams':    renderPlaceholder(main, '隊伍', 'Phase 3 會接上名單與陣容'); break;
    case 'fa':       renderPlaceholder(main, '自由球員', 'Phase 3 才做'); break;
    case 'league':   renderPlaceholder(main, '聯盟', 'Phase 3 才做'); break;
    case 'schedule': renderPlaceholder(main, '賽程', 'Phase 3 才做'); break;
    case 'trades':   renderPlaceholder(main, '交易', 'Phase 4 才做'); break;
  }
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
function scheduleDraftAutoAdvance() {
  if (state.draftAutoTimer) {
    clearTimeout(state.draftAutoTimer);
    state.draftAutoTimer = null;
  }
  const d = state.draft;
  if (!d || d.is_complete) return;
  if (currentRoute() !== 'draft') return;
  if (d.current_team_id === d.human_team_id) return;
  if (state.draftAutoBusy) return;

  state.draftAutoTimer = setTimeout(async () => {
    state.draftAutoTimer = null;
    if (state.draftAutoBusy) return;
    const cur = state.draft;
    if (!cur || cur.is_complete) return;
    if (currentRoute() !== 'draft') return;
    if (cur.current_team_id === cur.human_team_id) return;
    state.draftAutoBusy = true;
    let ok = false;
    try {
      const r = await api('/api/draft/ai-advance', { method: 'POST' });
      state.draft = r.state;
      ok = true;
    } catch (err) {
      console.warn('auto ai-advance failed', err);
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

// ---------------------------------------------------------------- global delegation
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-draft]');
  if (btn && !btn.disabled) {
    const id = parseInt(btn.getAttribute('data-draft'), 10);
    if (!Number.isNaN(id)) onDraftPlayer(id);
  }
});

// ---------------------------------------------------------------- boot
window.addEventListener('hashchange', render);

(async function boot() {
  if (!location.hash) location.hash = '/draft';
  await refreshState();
  render();
})();
