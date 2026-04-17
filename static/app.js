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

// Day 1 maps to a real date so the season has a calendar. Oct 22 is NBA tip-off.
const SEASON_EPOCH = new Date(2025, 9, 22); // 2025-10-22
function seasonDate(dayNum) {
  const d = new Date(SEASON_EPOCH);
  d.setDate(SEASON_EPOCH.getDate() + Math.max(0, (dayNum || 1) - 1));
  return d;
}
const WEEKDAYS_TW = ['週日','週一','週二','週三','週四','週五','週六'];
function formatSeasonDate(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS_TW[d.getDay()]}）`;
}

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
  // League setup
  leagueStatus: null,           // result of /api/league/status
  leagueSettings: null,         // result of /api/league/settings
  seasonsList: [],              // result of /api/seasons/list
  draftDisplayMode: 'prev_full',// cached from leagueSettings
  draftAutoTimer: null,         // setTimeout id for auto AI pick
  draftAutoBusy: false,         // lock to prevent overlapping auto picks
};

const VALID_ROUTES = ['draft', 'teams', 'fa', 'league', 'schedule', 'setup'];

// ---------------------------------------------------------------- defaults
const DEFAULT_TEAM_NAMES = [
  '我的隊伍', 'BPA 書呆子', '控制失誤', '巨星搭配飼料',
  '全能建造者', '年輕上檔', '老將求勝', '反主流',
];

const DEFAULT_SETTINGS = {
  league_name: '我的聯盟',
  season_year: '2025-26',
  player_team_index: 0,
  team_names: [...DEFAULT_TEAM_NAMES],
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
  veto_window_days: 2,
  ai_decision_mode: 'auto',
  draft_display_mode: 'prev_full',
  show_offseason_headlines: true,
  setup_complete: false,
};

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
  text.textContent = ok ? '已連線' : '連線中斷';
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
function confirmDialog(title, body, okLabel = '確定') {
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
  const prevChampion = state.standings?.champion;
  state.standings = standings;
  state.schedule  = schedule;
  // Season is "live" only when the backend has populated standings rows.
  const rows = standings?.standings || [];
  state.season = rows.length ? { active: true } : null;
  // Auto-pop summary when champion was just crowned this turn.
  const newChampion = standings?.champion;
  if (newChampion != null && prevChampion == null && !state.summaryShownFor) {
    state.summaryShownFor = newChampion;
    setTimeout(() => { onShowSummary().catch(() => {}); }, 500);
  }
  // Refresh activity ticker if panel is visible.
  renderActivityTicker();
  // Check for cleared lineup-override alerts and toast the user.
  const alertsPayload = await apiSoft('/api/season/lineup-alerts');
  if (alertsPayload?.alerts?.length) {
    toast('你的手動陣容已失效，已恢復自動', 'warn', 5000);
    apiSoft('/api/season/lineup-alerts', { method: 'DELETE' }).catch(() => {});
  }
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
  const hash = (location.hash || '').replace(/^#\/?/, '').trim();
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
    case 'setup':    renderSetupView(main);    break;
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

// ================================================================ SETUP VIEW

// In-memory form state for the setup form
let _setupForm = null;

function makeDefaultSetupForm(existing) {
  const s = existing || {};
  return {
    league_name: s.league_name ?? DEFAULT_SETTINGS.league_name,
    season_year: s.season_year ?? DEFAULT_SETTINGS.season_year,
    player_team_index: s.player_team_index ?? DEFAULT_SETTINGS.player_team_index,
    team_names: s.team_names ? [...s.team_names] : [...DEFAULT_SETTINGS.team_names],
    randomize_draft_order: s.randomize_draft_order ?? DEFAULT_SETTINGS.randomize_draft_order,
    roster_size: s.roster_size ?? DEFAULT_SETTINGS.roster_size,
    starters_per_day: s.starters_per_day ?? DEFAULT_SETTINGS.starters_per_day,
    il_slots: s.il_slots ?? DEFAULT_SETTINGS.il_slots,
    scoring_weights: Object.assign({}, DEFAULT_SETTINGS.scoring_weights, s.scoring_weights || {}),
    regular_season_weeks: s.regular_season_weeks ?? DEFAULT_SETTINGS.regular_season_weeks,
    trade_deadline_week: s.trade_deadline_week ?? DEFAULT_SETTINGS.trade_deadline_week,
    ai_trade_frequency: s.ai_trade_frequency ?? DEFAULT_SETTINGS.ai_trade_frequency,
    ai_trade_style: s.ai_trade_style ?? DEFAULT_SETTINGS.ai_trade_style,
    veto_threshold: s.veto_threshold ?? DEFAULT_SETTINGS.veto_threshold,
    veto_window_days: s.veto_window_days ?? DEFAULT_SETTINGS.veto_window_days,
    ai_decision_mode: s.ai_decision_mode ?? DEFAULT_SETTINGS.ai_decision_mode,
    draft_display_mode: s.draft_display_mode ?? DEFAULT_SETTINGS.draft_display_mode,
    show_offseason_headlines: s.show_offseason_headlines ?? DEFAULT_SETTINGS.show_offseason_headlines,
  };
}

function renderSetupView(root) {
  const status = state.leagueStatus;
  const isLocked = status && status.setup_complete;

  if (!_setupForm) {
    _setupForm = makeDefaultSetupForm(state.leagueSettings);
  }

  const form = _setupForm;

  // Build season year dropdown options
  const seasonOptions = (state.seasonsList.length ? state.seasonsList : [form.season_year])
    .map((y) => `<option value="${escapeHtml(y)}" ${y === form.season_year ? 'selected' : ''}>${escapeHtml(y)}</option>`)
    .join('');

  // Player team dropdown (live, built from team_names)
  function buildPlayerTeamOptions() {
    return form.team_names.map((name, i) =>
      `<option value="${i}" ${i === form.player_team_index ? 'selected' : ''}>${i}: ${escapeHtml(name)}</option>`
    ).join('');
  }

  const wrap = el('div', { class: 'setup-page' });

  // Lock warning
  if (isLocked) {
    wrap.append(el('div', { class: 'setup-lock-warn' },
      '聯盟已開賽，以下設定已鎖定。如需修改請前往聯盟頁面設定面板。',
    ));
  }

  const pageTitle = el('h1', { class: 'setup-title' }, '聯盟設定');
  wrap.append(pageTitle);

  // Helper: section wrapper
  function section(title, ...children) {
    return el('div', { class: 'setup-section' },
      el('div', { class: 'setup-section-title' }, title),
      ...children,
    );
  }

  // Helper: form row
  function row(label, control, hint) {
    const r = el('div', { class: 'setup-row' },
      el('label', { class: 'setup-label' }, label),
      el('div', { class: 'setup-control' }, control),
    );
    if (hint) r.append(el('div', { class: 'setup-hint' }, hint));
    return r;
  }

  // Helper: radio group
  function radioGroup(name, options, current, onChange) {
    const grp = el('div', { class: 'radio-group' });
    for (const [val, label] of options) {
      const id = `rg-${name}-${val}`;
      const inp = el('input', {
        type: 'radio',
        name,
        id,
        value: String(val),
        checked: String(val) === String(current) ? true : null,
        disabled: isLocked ? true : null,
        onchange: () => onChange(typeof current === 'number' ? Number(val) : val),
      });
      const lbl = el('label', { for: id }, String(label));
      grp.append(el('span', { class: 'radio-item' }, inp, lbl));
    }
    return grp;
  }

  // ---- Section: 聯盟基本
  const leagueNameInput = el('input', {
    type: 'text',
    value: form.league_name,
    disabled: isLocked ? true : null,
    id: 'setup-league-name',
    oninput: (e) => { form.league_name = e.target.value; },
  });

  const seasonSelect = el('select', {
    id: 'setup-season-year',
    disabled: isLocked ? true : null,
    html: seasonOptions,
    onchange: (e) => { form.season_year = e.target.value; },
  });

  const playerTeamSelect = el('select', {
    id: 'setup-player-team',
    html: buildPlayerTeamOptions(),
    onchange: (e) => { form.player_team_index = parseInt(e.target.value, 10); },
  });

  const randomizeCheck = el('input', {
    type: 'checkbox',
    id: 'setup-randomize',
    checked: form.randomize_draft_order ? true : null,
    disabled: isLocked ? true : null,
    onchange: (e) => { form.randomize_draft_order = e.target.checked; },
  });

  wrap.append(section('聯盟基本',
    row('聯盟名稱', leagueNameInput),
    row('賽季年份', seasonSelect),
    row('我的隊伍', playerTeamSelect),
    el('div', { class: 'setup-row' },
      el('label', { class: 'setup-label', for: 'setup-randomize' }, '隨機選秀順序'),
      el('div', { class: 'setup-control' }, randomizeCheck),
    ),
  ));

  // ---- Section: 隊伍名稱
  const teamNamesSection = el('div', { class: 'setup-section' },
    el('div', { class: 'setup-section-title' }, '隊伍名稱'),
    el('div', { class: 'setup-team-names', id: 'setup-team-names-grid' }),
  );
  function renderTeamNameInputs() {
    const grid = teamNamesSection.querySelector('#setup-team-names-grid');
    grid.innerHTML = '';
    form.team_names.forEach((name, i) => {
      const inp = el('input', {
        type: 'text',
        value: name,
        placeholder: `隊伍 ${i}`,
        'data-idx': String(i),
        id: `setup-team-${i}`,
        oninput: (e) => {
          form.team_names[i] = e.target.value;
          // Live-update player_team dropdown
          const sel = $('#setup-player-team');
          if (sel) {
            const opt = sel.options[i];
            if (opt) opt.textContent = `${i}: ${e.target.value}`;
          }
          clearError(`team-name-${i}`);
        },
      });
      const lbl = el('label', { for: `setup-team-${i}`, class: 'team-name-idx' }, String(i));
      grid.append(el('div', { class: 'team-name-row' }, lbl, inp));
    });
  }
  renderTeamNameInputs();
  wrap.append(teamNamesSection);

  // ---- Section: 名單
  wrap.append(section('名單',
    row('名單人數', radioGroup('roster_size', [[10,'10'],[13,'13'],[15,'15']], form.roster_size, (v) => { form.roster_size = v; })),
    row('每日先發', radioGroup('starters_per_day', [[8,'8'],[10,'10'],[12,'12']], form.starters_per_day, (v) => { form.starters_per_day = v; })),
    row('傷兵名單位置', radioGroup('il_slots', [[0,'0'],[1,'1'],[2,'2'],[3,'3 (預設)']], form.il_slots, (v) => { form.il_slots = v; })),
  ));

  // ---- Section: 計分權重
  const weights = form.scoring_weights;
  const weightCats = ['pts', 'reb', 'ast', 'stl', 'blk', 'to'];
  const weightLabels = { pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK', to: 'TO' };
  const weightRow = el('div', { class: 'weight-grid' });
  for (const cat of weightCats) {
    const inp = el('input', {
      type: 'number',
      step: '0.1',
      value: String(weights[cat]),
      id: `setup-weight-${cat}`,
      disabled: isLocked ? true : null,
      oninput: (e) => {
        weights[cat] = parseFloat(e.target.value);
        clearError(`weight-${cat}`);
      },
    });
    weightRow.append(
      el('div', { class: 'weight-item' },
        el('label', { for: `setup-weight-${cat}`, class: 'weight-label' }, weightLabels[cat]),
        inp,
      ),
    );
  }
  wrap.append(section('計分權重', weightRow));

  // ---- Section: 賽程
  const deadlineOptions = [
    ['', '無'],
    ['10', 'W10'],
    ['11', 'W11'],
    ['12', 'W12'],
  ].map(([v, l]) =>
    `<option value="${v}" ${String(form.trade_deadline_week ?? '') === v ? 'selected' : ''}>${l}</option>`
  ).join('');

  const deadlineSelect = el('select', {
    disabled: isLocked ? true : null,
    html: deadlineOptions,
    onchange: (e) => {
      form.trade_deadline_week = e.target.value === '' ? null : parseInt(e.target.value, 10);
    },
  });

  wrap.append(section('賽程',
    row('例行賽週數', radioGroup('regular_season_weeks',
      [[18,'18'],[19,'19'],[20,'20 (預設)'],[21,'21'],[22,'22']],
      form.regular_season_weeks,
      (v) => { form.regular_season_weeks = v; }
    )),
    row('交易截止週', deadlineSelect),
  ));

  // ---- Section: 交易 AI
  const freqOptions = [
    ['very_low','極少'],['low','少'],['normal','正常'],['high','多'],['very_high','極多'],
  ].map(([v,l]) => `<option value="${v}" ${form.ai_trade_frequency === v ? 'selected' : ''}>${l}</option>`).join('');

  const styleOptions = [
    ['conservative','保守'],['balanced','平衡'],['aggressive','激進'],
  ].map(([v,l]) => `<option value="${v}" ${form.ai_trade_style === v ? 'selected' : ''}>${l}</option>`).join('');

  wrap.append(section('交易 AI',
    row('交易頻率', el('select', {
      html: freqOptions,
      onchange: (e) => { form.ai_trade_frequency = e.target.value; },
    })),
    row('交易風格', el('select', {
      html: styleOptions,
      onchange: (e) => { form.ai_trade_style = e.target.value; },
    })),
    row('否決門檻（票數）', radioGroup('veto_threshold', [[2,'2'],[3,'3'],[4,'4']], form.veto_threshold, (v) => { form.veto_threshold = v; })),
    row('否決窗口（天）', radioGroup('veto_window_days', [[1,'1'],[2,'2'],[3,'3']], form.veto_window_days, (v) => { form.veto_window_days = v; })),
  ));

  // ---- Section: AI 行為
  const aiModeOptions = [
    ['auto','自動偵測'],['claude','Claude API'],['heuristic','純啟發式'],
  ].map(([v,l]) => `<option value="${v}" ${form.ai_decision_mode === v ? 'selected' : ''}>${l}</option>`).join('');

  wrap.append(section('AI 行為',
    row('AI 決策模式', el('select', {
      html: aiModeOptions,
      onchange: (e) => { form.ai_decision_mode = e.target.value; },
    })),
  ));

  // ---- Section: 顯示
  const draftDisplayOptions = [
    ['prev_full','上季完整（含 FPPG）'],
    ['prev_no_fppg','上季完整（不含 FPPG）'],
    ['current_full','本季完整（劇透）'],
  ].map(([v,l]) => `<option value="${v}" ${form.draft_display_mode === v ? 'selected' : ''}>${l}</option>`).join('');

  const headlinesCheck = el('input', {
    type: 'checkbox',
    id: 'setup-headlines',
    checked: form.show_offseason_headlines ? true : null,
    onchange: (e) => { form.show_offseason_headlines = e.target.checked; },
  });

  wrap.append(section('顯示',
    row('選秀顯示模式', el('select', {
      html: draftDisplayOptions,
      onchange: (e) => { form.draft_display_mode = e.target.value; },
    })),
    el('div', { class: 'setup-row' },
      el('label', { class: 'setup-label', for: 'setup-headlines' }, '顯示休賽期頭條'),
      el('div', { class: 'setup-control' }, headlinesCheck),
    ),
  ));

  // ---- Error container
  const errContainer = el('div', { class: 'setup-errors', id: 'setup-errors', hidden: true });
  wrap.append(errContainer);

  // ---- Buttons
  if (!isLocked) {
    const btnRow = el('div', { class: 'setup-btn-row' },
      el('button', { class: 'btn ghost', type: 'button', onclick: () => {
        _setupForm = makeDefaultSetupForm(null);
        renderSetupView(root);
        root.innerHTML = '';
        renderSetupView(root);
      }}, '使用預設值'),
      el('button', { class: 'btn', type: 'button', id: 'btn-setup-submit', onclick: () => onSubmitSetup(root) }, '開始選秀'),
    );
    wrap.append(btnRow);
  } else {
    wrap.append(
      el('div', { class: 'setup-btn-row' },
        el('a', { class: 'btn', href: '#league' }, '前往聯盟'),
      ),
    );
  }

  root.append(wrap);
}

function clearError(id) {
  const el2 = document.getElementById(`err-${id}`);
  if (el2) el2.remove();
}

function validateSetupForm(form) {
  const errors = [];
  for (let i = 0; i < form.team_names.length; i++) {
    if (!form.team_names[i].trim()) {
      errors.push(`隊伍 ${i} 名稱不可為空`);
    }
  }
  const w = form.scoring_weights;
  for (const cat of ['pts', 'reb', 'ast', 'stl', 'blk', 'to']) {
    if (isNaN(w[cat])) {
      errors.push(`計分權重「${cat.toUpperCase()}」必須是數字`);
    }
  }
  return errors;
}

async function onSubmitSetup(root) {
  const form = _setupForm;
  const errors = validateSetupForm(form);
  const errBox = $('#setup-errors');
  if (errors.length) {
    if (errBox) {
      errBox.hidden = false;
      errBox.innerHTML = errors.map((e) => `<div class="setup-error-item">${escapeHtml(e)}</div>`).join('');
    }
    return;
  }
  if (errBox) errBox.hidden = true;

  const btn = $('#btn-setup-submit');
  if (btn) { btn.disabled = true; btn.textContent = '設定中...'; }

  try {
    const payload = {
      league_name: form.league_name,
      season_year: form.season_year,
      player_team_index: form.player_team_index,
      team_names: form.team_names,
      randomize_draft_order: form.randomize_draft_order,
      num_teams: 8,
      roster_size: form.roster_size,
      starters_per_day: form.starters_per_day,
      il_slots: form.il_slots,
      scoring_weights: form.scoring_weights,
      regular_season_weeks: form.regular_season_weeks,
      playoff_teams: 6,
      trade_deadline_week: form.trade_deadline_week,
      ai_trade_frequency: form.ai_trade_frequency,
      ai_trade_style: form.ai_trade_style,
      veto_threshold: form.veto_threshold,
      veto_window_days: form.veto_window_days,
      ai_decision_mode: form.ai_decision_mode,
      draft_display_mode: form.draft_display_mode,
      show_offseason_headlines: form.show_offseason_headlines,
    };
    await api('/api/league/setup', { method: 'POST', body: JSON.stringify(payload) });

    // Reload settings and status, then navigate to draft
    const [status, settings] = await Promise.all([
      apiSoft('/api/league/status'),
      apiSoft('/api/league/settings'),
    ]);
    state.leagueStatus = status;
    state.leagueSettings = settings;
    if (settings) state.draftDisplayMode = settings.draft_display_mode || 'prev_full';
    _setupForm = null;

    // Reload draft state
    await refreshState().catch(() => {});

    toast('聯盟設定完成', 'success');
    navigate('draft');
  } catch (e) {
    toast(e.message || '設定失敗', 'error');
    if (btn) { btn.disabled = false; btn.textContent = '開始選秀'; }
  }
}

// ================================================================ IN-SEASON SETTINGS PANEL

async function openLeagueSettings() {
  const dlg = $('#dlg-league-settings');
  if (!dlg) return;

  // Fetch fresh settings
  const settings = await apiSoft('/api/league/settings');
  if (settings) {
    state.leagueSettings = settings;
    state.draftDisplayMode = settings.draft_display_mode || 'prev_full';
  }

  renderLeagueSettingsDialog(settings || state.leagueSettings || DEFAULT_SETTINGS);
  try { dlg.showModal(); } catch { /* fallback */ }
}

function renderLeagueSettingsDialog(s) {
  const body = $('#dlg-league-settings-body');
  if (!body) return;
  body.innerHTML = '';

  // team_names
  const teamSection = el('div', { class: 'setup-section' },
    el('div', { class: 'setup-section-title' }, '隊伍名稱'),
    el('div', { id: 'ls-team-names-grid', class: 'setup-team-names' }),
  );
  const grid = teamSection.querySelector('#ls-team-names-grid');
  const names = s.team_names || [...DEFAULT_TEAM_NAMES];
  names.forEach((name, i) => {
    const inp = el('input', { type: 'text', value: name, 'data-idx': String(i), id: `ls-team-${i}` });
    const lbl = el('label', { for: `ls-team-${i}`, class: 'team-name-idx' }, String(i));
    grid.append(el('div', { class: 'team-name-row' }, lbl, inp));
  });
  body.append(teamSection);

  function mkSelect(id, options, current) {
    const opts = options.map(([v,l]) =>
      `<option value="${v}" ${current === v ? 'selected' : ''}>${l}</option>`
    ).join('');
    return el('select', { id, html: opts });
  }

  const freqSel = mkSelect('ls-freq', [
    ['very_low','極少'],['low','少'],['normal','正常'],['high','多'],['very_high','極多'],
  ], s.ai_trade_frequency || 'normal');

  const styleSel = mkSelect('ls-style', [
    ['conservative','保守'],['balanced','平衡'],['aggressive','激進'],
  ], s.ai_trade_style || 'balanced');

  const modeSel = mkSelect('ls-mode', [
    ['auto','自動偵測'],['claude','Claude API'],['heuristic','純啟發式'],
  ], s.ai_decision_mode || 'auto');

  const draftModeSel = mkSelect('ls-draft-mode', [
    ['prev_full','上季完整（含 FPPG）'],
    ['prev_no_fppg','上季完整（不含 FPPG）'],
    ['current_full','本季完整（劇透）'],
  ], s.draft_display_mode || 'prev_full');

  const hlCheck = el('input', {
    type: 'checkbox',
    id: 'ls-headlines',
    checked: (s.show_offseason_headlines !== false) ? true : null,
  });

  const settingsBlock = el('div', { class: 'setup-section' },
    el('div', { class: 'setup-section-title' }, 'AI 與顯示'),
    el('div', { class: 'setup-row' },
      el('label', { class: 'setup-label' }, '交易頻率'),
      el('div', { class: 'setup-control' }, freqSel),
    ),
    el('div', { class: 'setup-row' },
      el('label', { class: 'setup-label' }, '交易風格'),
      el('div', { class: 'setup-control' }, styleSel),
    ),
    el('div', { class: 'setup-row' },
      el('label', { class: 'setup-label' }, 'AI 決策模式'),
      el('div', { class: 'setup-control' }, modeSel),
    ),
    el('div', { class: 'setup-row' },
      el('label', { class: 'setup-label' }, '選秀顯示模式'),
      el('div', { class: 'setup-control' }, draftModeSel),
    ),
    el('div', { class: 'setup-row' },
      el('label', { class: 'setup-label', for: 'ls-headlines' }, '顯示休賽期頭條'),
      el('div', { class: 'setup-control' }, hlCheck),
    ),
  );
  body.append(settingsBlock);
}

async function onSaveLeagueSettings() {
  const body = $('#dlg-league-settings-body');
  if (!body) return;

  const names = Array.from(body.querySelectorAll('#ls-team-names-grid input[data-idx]'))
    .sort((a, b) => parseInt(a.dataset.idx) - parseInt(b.dataset.idx))
    .map((i) => i.value);

  const freq  = body.querySelector('#ls-freq')?.value;
  const style = body.querySelector('#ls-style')?.value;
  const mode  = body.querySelector('#ls-mode')?.value;
  const dMode = body.querySelector('#ls-draft-mode')?.value;
  const hl    = body.querySelector('#ls-headlines')?.checked;

  const payload = {};
  if (names.length) payload.team_names = names;
  if (freq)  payload.ai_trade_frequency = freq;
  if (style) payload.ai_trade_style     = style;
  if (mode)  payload.ai_decision_mode   = mode;
  if (dMode) payload.draft_display_mode = dMode;
  if (hl !== undefined) payload.show_offseason_headlines = hl;

  try {
    await api('/api/league/settings', { method: 'POST', body: JSON.stringify(payload) });
    const updated = await apiSoft('/api/league/settings');
    if (updated) {
      state.leagueSettings = updated;
      state.draftDisplayMode = updated.draft_display_mode || 'prev_full';
    }
    toast('設定已儲存', 'success');
    $('#dlg-league-settings').close();
    // Re-render league view to pick up team name changes
    if (currentRoute() === 'league') render();
  } catch (e) {
    toast(e.message || '儲存失敗', 'error');
  }
}

// ================================================================ DRAFT VIEW
async function renderDraftView(root) {
  const d = state.draft;
  if (!d) {
    root.append(el('div', { class: 'empty-state' }, '載入選秀狀態中...'));
    return;
  }

  // Fetch display mode setting (best-effort)
  const displayMode = state.draftDisplayMode || 'prev_full';

  // Offseason headlines (async, shown if enabled)
  const showHeadlines = state.leagueSettings?.show_offseason_headlines !== false;
  const seasonYear = state.leagueSettings?.season_year || '';

  // Header summary
  const totalPicks = d.num_teams * d.total_rounds;
  const summary = d.is_complete
    ? `選秀完成 — ${totalPicks}/${totalPicks} 順位`
    : `順位 ${d.current_overall} / ${totalPicks} — 第${d.current_round}輪第${d.current_pick_in_round}順`;

  const clockPanel = buildClockPanel(d);
  const boardPanel = buildBoardPanel(d);
  const availablePanel = buildAvailablePanel(d, displayMode);

  const grid = el('div', { class: 'draft-grid' },
    el('div', {},
      clockPanel,
      availablePanel,
    ),
    el('div', {},
      el('div', { class: 'panel' },
        el('div', { class: 'panel-head' },
          el('h2', {}, '摘要'),
          el('span', { class: 'pill' }, summary),
        ),
      ),
      boardPanel,
    ),
  );

  // Headlines placeholder container
  const headlinesContainer = el('div', { id: 'headlines-container' });

  root.append(headlinesContainer, grid);

  wireAvailableFilters();
  renderAvailableTable(displayMode);

  // Load headlines async
  if (showHeadlines && seasonYear) {
    loadHeadlinesBanner(headlinesContainer, seasonYear);
  }

  scheduleDraftAutoAdvance();
}

// Auto-advance: if it's AI's turn during draft, automatically make the pick
// after a short delay. Clears cleanly when it's human's turn or draft complete.
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
    try {
      const r = await api('/api/draft/ai-advance', { method: 'POST' });
      state.draft = r.state;
      render();
    } catch (err) {
      console.warn('auto ai-advance failed', err);
    } finally {
      state.draftAutoBusy = false;
    }
  }, 1500);
}

async function loadHeadlinesBanner(container, seasonYear) {
  const data = await apiSoft(`/api/seasons/${encodeURIComponent(seasonYear)}/headlines`);
  if (!data || !data.headlines || !data.headlines.length) return;

  const headlines = data.headlines.slice(0, 10);
  const banner = el('div', { class: 'headlines-banner' });
  const head = el('button', {
    type: 'button',
    class: 'headlines-toggle',
    'aria-expanded': 'true',
    onclick: () => {
      const body = banner.querySelector('.headlines-body');
      const isOpen = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
      if (body) body.hidden = isOpen;
      chevron.textContent = isOpen ? '▸' : '▾';
    },
  });
  const chevron = el('span', { class: 'headlines-chevron' }, '▾');
  head.append(
    el('span', { class: 'headlines-heading' }, `${escapeHtml(seasonYear)} 休賽期頭條`),
    chevron,
  );

  const body = el('div', { class: 'headlines-body' });
  const ul = el('ul', { class: 'headlines-list' });
  for (const h of headlines) {
    ul.append(el('li', {}, typeof h === 'string' ? h : (h.text || h.headline || JSON.stringify(h))));
  }
  body.append(ul);
  banner.append(head, body);
  container.append(banner);
}

function buildClockPanel(d) {
  const panel = el('div', { class: 'panel' });
  const head  = el('div', { class: 'panel-head' },
    el('h2', {}, '輪到誰了'),
  );
  const body = el('div', { class: 'clock-card' });

  if (d.is_complete) {
    body.append(
      el('div', { class: 'who' }, '選秀完成'),
      el('div', { class: 'sub' }, '所有順位已完成。前往聯盟頁面開始賽季。'),
      el('div', { class: 'clock-actions' },
        el('a', { class: 'btn', href: '#league' }, '前往聯盟'),
      ),
    );
  } else {
    const team  = d.teams[d.current_team_id];
    const isYou = team.is_human;
    const persona = team.gm_persona ? state.personas[team.gm_persona] : null;
    const subline = isYou
      ? '請在下方選擇球員。'
      : (persona ? persona.desc : 'AI 思考中...');

    if (isYou) body.classList.add('you');
    body.append(
      el('div', { class: 'who' }, isYou ? '輪到你了' : `輪到 ${team.name}`),
      el('div', { class: 'sub' }, `第 ${d.current_round} 輪，第 ${d.current_pick_in_round} 順（總第 #${d.current_overall}）。${subline}`),
      el('div', { class: 'clock-actions' },
        el('button', { class: 'btn ghost', disabled: isYou, onclick: onAdvance }, '推進 AI'),
        el('button', { class: 'btn', disabled: isYou, onclick: onSimToMe }, '模擬到我'),
      ),
    );
  }

  panel.append(head, body);
  return panel;
}

function buildAvailablePanel(d, displayMode) {
  const panel = el('div', { class: 'panel', id: 'panel-available' });
  const modeOpts = [
    ['prev_full',    '上季完整（含 FPPG）'],
    ['prev_no_fppg', '上季完整（不含 FPPG）'],
    ['current_full', '本季完整（劇透）'],
  ].map(([v,l]) => `<option value="${v}" ${displayMode === v ? 'selected' : ''}>${l}</option>`).join('');
  const modeSel = el('select', {
    id: 'draft-display-mode-switch',
    style: 'margin-left:8px; padding:4px 8px; border-radius:6px;',
    title: '即時切換選秀顯示模式（會儲存到聯盟設定）',
    html: modeOpts,
    onchange: onDraftDisplayModeChange,
  });
  panel.append(
    el('div', { class: 'panel-head' },
      el('h2', {}, '剩餘球員'),
      el('span', { class: 'mode-switch-label', style: 'margin-left:8px; font-size:12px; color:var(--muted);' }, '顯示：'),
      modeSel,
    ),
    el('div', { class: 'panel-body' },
      buildFilterBar('draftFilter', () => renderAvailableTable(state.draftDisplayMode || 'prev_full')),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'data players-table responsive', id: 'tbl-available' }),
      ),
    ),
  );
  return panel;
}

async function onDraftDisplayModeChange(e) {
  const newMode = e.target.value;
  state.draftDisplayMode = newMode;
  renderAvailableTable(newMode);
  // Persist to league settings (best-effort; ignore errors so UI stays snappy)
  try {
    const cur = state.leagueSettings || {};
    const payload = { ...cur, draft_display_mode: newMode };
    await api('/api/league/settings', { method: 'POST', body: JSON.stringify(payload) });
    if (state.leagueSettings) state.leagueSettings.draft_display_mode = newMode;
  } catch (err) {
    console.warn('save draft_display_mode failed', err);
  }
}

function buildBoardPanel(d) {
  const panel = el('div', { class: 'panel' },
    el('div', { class: 'panel-head' }, el('h2', {}, '蛇形選秀板')),
    el('div', { class: 'board-wrap' }, buildBoardTable(d)),
  );
  return panel;
}

function buildBoardTable(d) {
  const tbl = el('table', { class: 'board' });
  let html = '<thead><tr><th class="rnd">輪</th>';
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
          <span class="psub">#${cell.overall} (第${cell.round}輪.${cell.pick_in_round})</span>
        </td>`;
      } else {
        html += `<td class="${cls}">${isCurrent ? '輪到了' : '-'}</td>`;
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
      type: 'search', placeholder: '搜尋姓名 / 球隊...', value: f.q,
      oninput: (e) => { f.q = e.target.value; onChange(); },
    }),
    el('select', {
      onchange: (e) => { f.pos = e.target.value; onChange(); },
      html: `
        <option value="">所有位置</option>
        <option value="PG">PG</option>
        <option value="SG">SG</option>
        <option value="SF">SF</option>
        <option value="PF">PF</option>
        <option value="C">C</option>`,
    }),
    el('select', {
      onchange: (e) => { f.sort = e.target.value; onChange(); },
      html: `
        <option value="fppg">排序：FPPG</option>
        <option value="pts">PTS</option>
        <option value="reb">REB</option>
        <option value="ast">AST</option>
        <option value="stl">STL</option>
        <option value="blk">BLK</option>
        <option value="to">TO</option>
        <option value="age">年齡</option>
        <option value="name">姓名</option>`,
    }),
  );
  // Sync select values to current state.
  const [qInput, posSel, sortSel] = wrap.children;
  posSel.value  = f.pos;
  sortSel.value = f.sort;
  return wrap;
}

function wireAvailableFilters() { /* handled by buildFilterBar */ }

async function renderAvailableTable(displayMode) {
  const tbl = $('#tbl-available');
  if (!tbl) return;
  const d = state.draft;
  if (!d) return;

  const mode = displayMode || state.draftDisplayMode || 'prev_full';

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
    tbl.innerHTML = `<tbody><tr><td class="empty-state">載入失敗：${escapeHtml(e.message)}</td></tr></tbody>`;
    return;
  }

  const canDraft = !d.is_complete && d.current_team_id === d.human_team_id;
  tbl.innerHTML = renderPlayersTable(players, {
    withDraft: true,
    canDraft,
    displayMode: mode,
  });
  tbl.querySelectorAll('button[data-draft]').forEach((btn) => {
    btn.addEventListener('click', () => onDraftPlayer(parseInt(btn.dataset.draft, 10)));
  });
}

function renderPlayersTable(players, { withDraft = false, canDraft = false, withSign = false, displayMode = 'current_full' } = {}) {
  const isPrevFull   = displayMode === 'prev_full';
  const isPrevNoFppg = displayMode === 'prev_no_fppg';
  const showAction   = withDraft || withSign;
  // current_full: show everything as before

  let head;
  if (isPrevNoFppg) {
    // Hide FPPG only — raw counting stats remain visible.
    head = `<thead><tr>
      <th>球員</th><th>位置</th><th>球隊</th>
      <th class="num">年齡</th>
      <th class="num">PTS</th><th class="num">REB</th>
      <th class="num">AST</th><th class="num">STL</th>
      <th class="num">BLK</th><th class="num">TO</th>
      <th class="num">出賽</th>
      ${showAction ? '<th></th>' : ''}
    </tr></thead>`;
  } else if (isPrevFull) {
    // Show prev_fppg (labeled 上季FPPG) instead of live stats
    head = `<thead><tr>
      <th>球員</th><th>位置</th><th>球隊</th>
      <th class="num">年齡</th>
      <th class="num">上季FPPG</th>
      <th class="num">出賽</th>
      ${showAction ? '<th></th>' : ''}
    </tr></thead>`;
  } else {
    // current_full: original columns
    head = `<thead><tr>
      <th>球員</th><th>位置</th><th>球隊</th>
      <th class="num">年齡</th>
      <th class="num">FPPG</th>
      <th class="num">PTS</th><th class="num">REB</th>
      <th class="num">AST</th><th class="num">STL</th>
      <th class="num">BLK</th><th class="num">TO</th>
      <th class="num">出賽</th>
      ${showAction ? '<th></th>' : ''}
    </tr></thead>`;
  }

  const colCount = isPrevNoFppg ? (showAction ? 12 : 11) : isPrevFull ? (showAction ? 7 : 6) : (showAction ? 13 : 12);

  if (!players.length) {
    return head + `<tbody><tr><td colspan="${colCount}" class="empty-state">找不到符合的球員。</td></tr></tbody>`;
  }

  let body;
  if (isPrevNoFppg) {
    body = players.map((p) => {
      const actionCell = withDraft
        ? `<td class="act"><button class="btn small" data-draft="${p.id}" ${canDraft ? '' : 'disabled'}>選秀</button></td>`
        : withSign
        ? `<td class="act"><button class="btn small btn-sign" data-player-id="${p.id}">簽入</button></td>`
        : '';
      return `<tr>
        <td class="name">${escapeHtml(p.name)}</td>
        <td class="hidden-m"><span class="pos-tag">${escapeHtml(p.pos)}</span></td>
        <td class="meta-row">${escapeHtml(p.pos)} · ${escapeHtml(p.team)} · ${p.age} 歲</td>
        <td class="num hidden-m meta">${p.age}</td>
        <td class="stats" colspan="1">
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
  } else if (isPrevFull) {
    body = players.map((p) => {
      const prevFppgVal = p.prev_fppg != null ? p.prev_fppg : p.fppg;
      const actionCell = withDraft
        ? `<td class="act"><button class="btn small" data-draft="${p.id}" ${canDraft ? '' : 'disabled'}>選秀</button></td>`
        : withSign
        ? `<td class="act"><button class="btn small btn-sign" data-player-id="${p.id}">簽入</button></td>`
        : '';
      return `<tr>
        <td class="name">${escapeHtml(p.name)}</td>
        <td class="hidden-m"><span class="pos-tag">${escapeHtml(p.pos)}</span></td>
        <td class="meta-row">${escapeHtml(p.pos)} · ${escapeHtml(p.team)} · ${p.age} 歲</td>
        <td class="num hidden-m meta">${p.age}</td>
        <td class="num fppg hidden-m">${fppg(prevFppgVal)}</td>
        <td class="stats" colspan="1">
          <span class="s fppg"><b>${fppg(prevFppgVal)}</b>上季FPPG</span>
        </td>
        <td class="num hidden-m">${p.gp ?? '-'}</td>
        ${actionCell}
      </tr>`;
    }).join('');
  } else {
    // current_full — original rendering
    body = players.map((p) => {
      const actionCell = withDraft
        ? `<td class="act"><button class="btn small" data-draft="${p.id}" ${canDraft ? '' : 'disabled'}>選秀</button></td>`
        : withSign
        ? `<td class="act"><button class="btn small btn-sign" data-player-id="${p.id}">簽入</button></td>`
        : '';
      return `<tr>
        <td class="name">${escapeHtml(p.name)}</td>
        <td class="hidden-m"><span class="pos-tag">${escapeHtml(p.pos)}</span></td>
        <td class="meta-row">${escapeHtml(p.pos)} · ${escapeHtml(p.team)} · ${p.age} 歲</td>
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
  }

  return head + '<tbody>' + body + '</tbody>';
}

// ================================================================ TEAMS VIEW
function renderTeamsView(root) {
  const d = state.draft;
  if (!d) {
    root.append(el('div', { class: 'empty-state' }, '載入中...'));
    return;
  }

  const teamSelect = el('select', {
    id: 'team-pick',
    onchange: (e) => {
      state.selectedTeamId = parseInt(e.target.value, 10);
      renderTeamBody();
    },
    html: d.teams.map((t) =>
      `<option value="${t.id}" ${t.id === state.selectedTeamId ? 'selected' : ''}>${escapeHtml(t.name)}${t.is_human ? ' (你)' : ''}</option>`
    ).join(''),
  });

  const panel = el('div', { class: 'panel' },
    el('div', { class: 'panel-head' },
      el('h2', {}, '球員名單'),
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
  container.innerHTML = '<div class="empty-state">載入中...</div>';

  let data;
  try {
    data = await api(`/api/teams/${tid}`);
  } catch (e) {
    container.innerHTML = `<div class="empty-state"><h3>錯誤</h3><p>${escapeHtml(e.message)}</p></div>`;
    return;
  }
  const { team, players, totals, persona_desc, lineup_slots, bench, injured_out, has_lineup_override } = data;
  const playerById = new Map(players.map((p) => [p.id, p]));
  const injSet = new Set(injured_out || []);
  const isHuman = !!team.is_human;

  const slotRows = (lineup_slots || []).map((s, idx) => {
    const p = s.player_id != null ? playerById.get(s.player_id) : null;
    const injured = p && injSet.has(p.id);
    const changeBtn = isHuman
      ? `<td class="slot-change"><button class="btn small ghost lineup-change-btn" data-slot-idx="${idx}" data-slot="${s.slot}" data-current="${s.player_id ?? ''}">換</button></td>`
      : '';
    return `<tr class="slot-row${injured ? ' injured' : ''}">
      <td class="slot-label"><span class="slot-badge slot-${s.slot}">${s.slot}</span></td>
      ${p
        ? `<td class="slot-name">${escapeHtml(p.name)}</td>
           <td class="slot-pos hidden-m"><span class="pos-tag">${escapeHtml(p.pos)}</span></td>
           <td class="num slot-fppg">${fppg(p.fppg)}</td>
           <td class="slot-team hidden-m">${escapeHtml(p.team)}</td>`
        : `<td class="slot-name empty" colspan="4">—</td>`}
      ${changeBtn}
    </tr>`;
  }).join('');

  const benchPlayers = (bench || []).map((id) => playerById.get(id)).filter(Boolean);

  const overrideBadge = has_lineup_override
    ? `<span class="pill warn" title="手動設定陣容">手動陣容</span>`
    : `<span class="pill" title="自動最佳化">自動陣容</span>`;

  const lineupActions = isHuman ? `
    <div class="lineup-actions">
      ${has_lineup_override ? `<button class="btn small ghost" id="btn-clear-override">恢復自動陣容</button>` : ''}
      <button class="btn small" id="btn-set-lineup">設定先發陣容</button>
    </div>` : '';

  const slotHeader = isHuman
    ? `<thead><tr><th>位置</th><th>球員</th><th class="hidden-m">定位</th><th class="num">FPPG</th><th class="hidden-m">球隊</th><th></th></tr></thead>`
    : `<thead><tr><th>位置</th><th>球員</th><th class="hidden-m">定位</th><th class="num">FPPG</th><th class="hidden-m">球隊</th></tr></thead>`;

  const html = `
    <div class="team-summary">
      <div class="name-row">
        <span class="tname">${escapeHtml(team.name)}</span>
        ${team.is_human ? '<span class="pill success">你</span>' : ''}
        ${isHuman ? overrideBadge : ''}
        ${team.gm_persona ? `<span class="tmeta">風格：${escapeHtml(team.gm_persona)}</span>` : ''}
      </div>
      ${persona_desc ? `<div class="persona">${escapeHtml(persona_desc)}</div>` : ''}
      <div class="totals">
        <span class="stat">FPPG 總計 <b>${fppg(totals.fppg)}</b></span>
        <span class="stat">PTS <b>${fmtStat(totals.pts)}</b></span>
        <span class="stat">REB <b>${fmtStat(totals.reb)}</b></span>
        <span class="stat">AST <b>${fmtStat(totals.ast)}</b></span>
      </div>
      ${lineupActions}
    </div>
    ${slotRows
      ? `<div class="table-wrap slot-wrap"><table class="data lineup-slots">
          ${slotHeader}
          <tbody>${slotRows}</tbody>
        </table></div>`
      : ''}
    ${benchPlayers.length
      ? `<div class="panel-head bench-head"><h2>板凳 (${benchPlayers.length})</h2></div>
         <div class="table-wrap"><table class="data players-table responsive">${renderPlayersTable(benchPlayers)}</table></div>`
      : players.length === 0
        ? `<div class="empty-state"><p>尚未選入任何球員。</p></div>`
        : ''}
  `;
  container.innerHTML = html;

  if (isHuman) {
    // "設定先發陣容" button — opens full lineup picker modal
    const btnSet = $('#btn-set-lineup');
    if (btnSet) btnSet.addEventListener('click', () => openLineupModal(data));

    // "恢復自動陣容" button
    const btnClear = $('#btn-clear-override');
    if (btnClear) btnClear.addEventListener('click', async () => {
      try {
        await api(`/api/season/lineup/${team.id}`, { method: 'DELETE' });
        renderTeamBody();
      } catch (e) {
        alert('清除失敗：' + e.message);
      }
    });

    // Per-slot "換" buttons — open single-slot swap picker
    container.querySelectorAll('.lineup-change-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const slotName = btn.dataset.slot;
        const currentId = btn.dataset.current ? Number(btn.dataset.current) : null;
        openSlotSwapModal(data, slotName, currentId);
      });
    });
  }
}

// ---------------------------------------------------------------- Lineup modal helpers

function _slotEligibility() {
  // Mirror of Python SLOT_ELIGIBILITY
  return {
    PG:   new Set(['PG']),
    SG:   new Set(['SG']),
    SF:   new Set(['SF']),
    PF:   new Set(['PF']),
    C:    new Set(['C']),
    G:    new Set(['PG', 'SG']),
    F:    new Set(['SF', 'PF']),
    UTIL: new Set(['PG', 'SG', 'SF', 'PF', 'C']),
  };
}

function _playerPositions(pos) {
  if (!pos) return new Set();
  return new Set(pos.replace(',', '/').split('/').map(p => p.trim().toUpperCase()).filter(Boolean));
}

function _canFillSlot(player, slotName) {
  const eligibility = _slotEligibility();
  const eligible = eligibility[slotName] || new Set();
  const ppos = _playerPositions(player.pos);
  for (const p of ppos) { if (eligible.has(p)) return true; }
  return false;
}

function openSlotSwapModal(data, slotName, currentPlayerId) {
  const { team, players, lineup_slots, bench, injured_out } = data;
  const playerById = new Map(players.map((p) => [p.id, p]));
  const injSet = new Set(injured_out || []);

  // Current starters
  const currentStarters = (lineup_slots || []).map(s => s.player_id).filter(id => id != null);

  // Candidates: all roster players eligible for this slot, not injured out
  const candidates = players.filter(p =>
    !injSet.has(p.id) && _canFillSlot(p, slotName)
  ).sort((a, b) => b.fppg - a.fppg);

  const rows = candidates.map(p => {
    const isCurrent = p.id === currentPlayerId;
    const isStarter = currentStarters.includes(p.id) && !isCurrent;
    return `<tr class="${isCurrent ? 'row-current' : ''}">
      <td>${escapeHtml(p.name)}</td>
      <td><span class="pos-tag">${escapeHtml(p.pos)}</span></td>
      <td class="num">${fppg(p.fppg)}</td>
      <td>${isStarter ? '<span class="pill">先發中</span>' : isCurrent ? '<span class="pill success">目前</span>' : ''}</td>
      <td><button class="btn small slot-pick-btn" data-pid="${p.id}" ${isCurrent ? 'disabled' : ''}>選</button></td>
    </tr>`;
  }).join('');

  const modal = el('div', { class: 'modal-overlay', id: 'lineup-swap-modal' },
    el('div', { class: 'modal-box' },
      el('div', { class: 'modal-head' },
        el('h3', {}, `替換 ${slotName} 位置`),
        el('button', { class: 'modal-close', id: 'close-swap-modal' }, '✕'),
      ),
      el('div', { class: 'modal-body' },
        el('div', { class: 'table-wrap' },
          el('table', { class: 'data players-table' },
            el('thead', {},
              el('tr', {},
                el('th', {}, '球員'), el('th', {}, '位置'), el('th', { class: 'num' }, 'FPPG'),
                el('th', {}, ''), el('th', {}, ''),
              ),
            ),
            el('tbody', { innerHTML: rows }),
          ),
        ),
      ),
    ),
  );
  document.body.appendChild(modal);

  $('#close-swap-modal').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  modal.querySelectorAll('.slot-pick-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const newPid = Number(btn.dataset.pid);
      // Build new starters: replace currentPlayerId with newPid (or add if slot was empty)
      let newStarters = [...currentStarters];
      if (currentPlayerId != null) {
        const idx = newStarters.indexOf(currentPlayerId);
        if (idx !== -1) newStarters[idx] = newPid;
        else newStarters.push(newPid);
      } else {
        newStarters.push(newPid);
      }
      // Remove newPid from another slot if it was already a starter
      newStarters = newStarters.filter((id, i) => id !== newPid || i === newStarters.lastIndexOf(newPid));
      modal.remove();
      await _saveLineupOverride(team.id, newStarters);
    });
  });
}

function openLineupModal(data) {
  const { team, players, lineup_slots, injured_out } = data;
  const injSet = new Set(injured_out || []);
  const playerById = new Map(players.map((p) => [p.id, p]));

  // Start from current slot assignment
  let selected = new Set((lineup_slots || []).map(s => s.player_id).filter(id => id != null));

  function renderRows() {
    return players
      .filter(p => !injSet.has(p.id))
      .sort((a, b) => b.fppg - a.fppg)
      .map(p => {
        const checked = selected.has(p.id);
        return `<tr class="${checked ? 'row-selected' : ''}">
          <td><input type="checkbox" class="lineup-check" data-pid="${p.id}" ${checked ? 'checked' : ''}></td>
          <td>${escapeHtml(p.name)}</td>
          <td><span class="pos-tag">${escapeHtml(p.pos)}</span></td>
          <td class="num">${fppg(p.fppg)}</td>
          <td>${escapeHtml(p.team)}</td>
        </tr>`;
      }).join('');
  }

  const targetCount = (lineup_slots || []).length || 10;
  const modal = el('div', { class: 'modal-overlay', id: 'lineup-full-modal' },
    el('div', { class: 'modal-box modal-wide' },
      el('div', { class: 'modal-head' },
        el('h3', {}, `設定先發陣容（選 ${targetCount} 人）`),
        el('button', { class: 'modal-close', id: 'close-lineup-modal' }, '✕'),
      ),
      el('div', { class: 'modal-body' },
        el('p', { class: 'muted', id: 'lineup-count-msg' }, `已選：${selected.size} / ${targetCount}`),
        el('div', { class: 'table-wrap' },
          el('table', { class: 'data players-table', id: 'lineup-full-tbl' },
            el('thead', {},
              el('tr', {},
                el('th', {}, ''), el('th', {}, '球員'), el('th', {}, '位置'),
                el('th', { class: 'num' }, 'FPPG'), el('th', {}, '球隊'),
              ),
            ),
            el('tbody', { innerHTML: renderRows() }),
          ),
        ),
      ),
      el('div', { class: 'modal-foot' },
        el('button', { class: 'btn', id: 'btn-save-lineup' }, '儲存先發'),
        el('button', { class: 'btn ghost', id: 'btn-cancel-lineup' }, '取消'),
      ),
    ),
  );
  document.body.appendChild(modal);

  function refreshCount() {
    const msg = $('#lineup-count-msg');
    if (msg) msg.textContent = `已選：${selected.size} / ${targetCount}`;
  }

  modal.querySelectorAll('.lineup-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      const pid = Number(cb.dataset.pid);
      if (cb.checked) {
        if (selected.size >= targetCount) { cb.checked = false; return; }
        selected.add(pid);
      } else {
        selected.delete(pid);
      }
      cb.closest('tr').classList.toggle('row-selected', cb.checked);
      refreshCount();
    });
  });

  $('#close-lineup-modal').addEventListener('click', () => modal.remove());
  $('#btn-cancel-lineup').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  $('#btn-save-lineup').addEventListener('click', async () => {
    if (selected.size !== targetCount) {
      alert(`請選滿 ${targetCount} 名先發球員（目前 ${selected.size} 人）`);
      return;
    }
    modal.remove();
    await _saveLineupOverride(team.id, [...selected]);
  });
}

async function _saveLineupOverride(teamId, starters) {
  try {
    await api('/api/season/lineup', {
      method: 'POST',
      body: JSON.stringify({ team_id: teamId, starters }),
    });
    renderTeamBody();
  } catch (e) {
    alert('儲存失敗：' + e.message);
  }
}

// ================================================================ FREE AGENTS
async function renderFaView(root) {
  const quotaBox = el('div', { class: 'fa-quota-box', id: 'fa-quota-box' }, '簽約配額載入中...');
  root.append(
    el('div', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('h2', {}, '自由球員'),
        quotaBox,
      ),
      el('div', { class: 'panel-body' },
        buildFilterBar('faFilter', renderFaTable),
        el('div', { class: 'table-wrap' },
          el('table', { class: 'data players-table responsive', id: 'tbl-fa' }),
        ),
      ),
    ),
  );
  refreshFaQuota();
  renderFaTable();
}

async function refreshFaQuota() {
  const box = $('#fa-quota-box');
  if (!box) return;
  try {
    const q = await api('/api/fa/claim-status');
    const used = q.used_today ?? 0;
    const limit = q.limit ?? 3;
    const remaining = q.remaining ?? (limit - used);
    box.innerHTML = `<span class="fa-quota-label">今日可簽約：<strong>${remaining} / ${limit}</strong></span>`;
    box.dataset.remaining = String(remaining);
  } catch {
    box.innerHTML = '<span class="muted">賽季尚未開始,無法簽約</span>';
    box.dataset.remaining = '0';
  }
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
    tbl.innerHTML = `<tbody><tr><td class="empty-state">載入失敗：${escapeHtml(e.message)}</td></tr></tbody>`;
    return;
  }
  // Cache for drop-select later
  for (const p of players) state.playerCache.set(p.id, p);
  tbl.innerHTML = renderPlayersTable(players, { withSign: true });
  // Wire sign buttons
  tbl.querySelectorAll('button.btn-sign').forEach((btn) => {
    btn.addEventListener('click', () => onOpenSignDialog(Number(btn.dataset.playerId)));
  });
}

async function onOpenSignDialog(addPlayerId) {
  // Need a fresh roster snapshot
  const humanId = state.draft?.human_team_id ?? 0;
  let teamData;
  try {
    teamData = await api(`/api/teams/${humanId}`);
  } catch (e) {
    toast('無法載入你的陣容', 'error');
    return;
  }
  const addPlayer = state.playerCache.get(addPlayerId);
  if (!addPlayer) { toast('找不到此球員', 'error'); return; }

  const roster = teamData.players || [];
  if (!roster.length) { toast('陣容是空的,無法交換', 'error'); return; }

  const rows = roster
    .slice()
    .sort((a, b) => (a.fppg || 0) - (b.fppg || 0))
    .map((p) => `<label class="drop-row"><input type="radio" name="drop-pid" value="${p.id}"> <span class="pn">${escapeHtml(p.name)}</span> <span class="ppos">${escapeHtml(p.pos || '')}</span> <span class="pfp muted">FPPG ${(p.fppg ?? 0).toFixed(1)}</span></label>`)
    .join('');

  const body = `
    <div class="sign-dialog-body">
      <div class="sign-add">簽入：<strong>${escapeHtml(addPlayer.name)}</strong> <span class="muted">${escapeHtml(addPlayer.pos || '')} · FPPG ${(addPlayer.fppg ?? 0).toFixed(1)}</span></div>
      <div class="sign-hint">選擇一名要釋出的球員：</div>
      <div class="sign-drop-list">${rows}</div>
    </div>
  `;
  const dropId = await pickDropDialog(body);
  if (dropId == null) return;

  await mutate(async () => {
    const r = await api('/api/fa/claim', {
      method: 'POST',
      body: JSON.stringify({ add_player_id: addPlayerId, drop_player_id: dropId }),
    });
    toast(`✅ 簽入 ${r.add},釋出 ${r.drop}（今日剩餘 ${r.remaining}）`, 'success');
    await refreshState();
    await refreshFaQuota();
    await renderFaTable();
  });
}

function pickDropDialog(bodyHtml) {
  return new Promise((resolve) => {
    const dlg = $('#dlg-confirm');
    $('#confirm-title').textContent = '簽約自由球員';
    $('#confirm-body').innerHTML = bodyHtml;
    const okBtn = $('#confirm-ok');
    okBtn.textContent = '確認簽約';
    const handler = () => {
      dlg.removeEventListener('close', handler);
      if (dlg.returnValue !== 'ok') { resolve(null); return; }
      const picked = dlg.querySelector('input[name="drop-pid"]:checked');
      resolve(picked ? Number(picked.value) : null);
    };
    dlg.addEventListener('close', handler);
    try { dlg.showModal(); } catch { resolve(null); }
  });
}

// ================================================================ LEAGUE VIEW
function renderLeagueView(root) {
  const d = state.draft;
  if (!d) { root.append(el('div', { class: 'empty-state' }, '載入中...')); return; }

  if (!d.is_complete) {
    root.append(
      emptyState(
        '選秀尚未完成',
        `目前在第 ${d.current_overall} / ${d.num_teams * d.total_rounds} 順位。請先完成選秀再開始賽季。`,
        el('a', { class: 'btn', href: '#draft' }, '前往選秀'),
      ),
    );
    return;
  }

  if (!state.standings) {
    root.append(
      el('div', { class: 'panel' },
        el('div', { class: 'panel-head' },
          el('h2', {}, '賽季'),
          // Gear icon for settings
          el('button', {
            type: 'button',
            class: 'icon-btn league-settings-btn',
            'aria-label': '聯盟設定',
            title: '聯盟設定',
            onclick: openLeagueSettings,
          }, '⚙'),
        ),
        emptyState(
          '賽季尚未開始',
          '確認選秀後將建立 14 週賽程。AI 隊伍使用啟發式策略或 Claude（需設定 API 金鑰）。',
          el('button', { class: 'btn', onclick: onSeasonStart }, '開始賽季'),
        ),
      ),
    );
    return;
  }

  // Calendar strip — today + current-week visualisation.
  const calendarPanel = buildCalendarPanel(state.standings);

  // Standings + controls + matchups.
  const controls = el('div', { class: 'panel' },
    el('div', { class: 'panel-head' },
      el('h2', {}, '操作'),
      el('div', { class: 'actions' },
        el('button', { class: 'btn ghost', onclick: onAdvanceDay }, '推進一天'),
        el('button', { class: 'btn ghost', onclick: onAdvanceWeek }, '推進一週'),
        el('button', { class: 'btn ghost', onclick: () => { const w = currentWeekNumber() - 1; if (w >= 1) onShowWeekRecap(w); else toast('尚無已完成週次', 'info'); } }, '📅 週報'),
        el('button', { id: 'btn-propose-trade', class: 'btn ghost', onclick: openProposeTradeDialog }, '發起交易'),
        el('button', { class: 'btn', onclick: onSimToPlayoffs }, '模擬到季後賽'),
        state.standings && state.standings.champion != null
          ? el('button', { class: 'btn primary', onclick: onShowSummary }, '🏆 賽季總結')
          : null,
        el('button', {
          type: 'button',
          class: 'icon-btn league-settings-btn',
          'aria-label': '聯盟設定',
          title: '聯盟設定',
          onclick: openLeagueSettings,
        }, '⚙'),
      ),
    ),
  );

  const tradesPanel = el('div', { class: 'panel', id: 'panel-trades' },
    el('div', { class: 'panel-head' },
      el('h2', {}, '待處理交易'),
      el('div', { id: 'trade-quota-badge', class: 'trade-quota-wrap' }),
    ),
    el('div', { class: 'panel-body', id: 'trade-pending-body' },
      el('div', { class: 'empty-state' }, '載入交易中...'),
    ),
  );

  const historyPanel = el('div', { class: 'panel', id: 'panel-trade-history' },
    el('button', {
      type: 'button',
      class: 'panel-head collapsible-head',
      'aria-expanded': state.tradeHistoryOpen ? 'true' : 'false',
      onclick: onToggleTradeHistory,
    },
      el('h2', {}, '近期交易紀錄'),
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

  const activityPanel = el('div', { class: 'panel activity-ticker', id: 'panel-activity' },
    el('div', { class: 'panel-head' }, el('h2', {}, '📋 動態消息')),
    el('div', { class: 'activity-ticker-body', id: 'activity-ticker-body' },
      el('div', { class: 'empty-state' }, '載入中...'),
    ),
  );

  root.append(calendarPanel, controls, tradesPanel, historyPanel, grid, activityPanel);

  // Kick off trade data fetch + render.
  refreshTrades();
  if (state.tradeHistoryOpen) refreshTradeHistory();
  renderActivityTicker();
}

async function renderActivityTicker() {
  const body = document.getElementById('activity-ticker-body');
  if (!body) return;
  try {
    const data = await apiSoft('/api/season/activity?limit=20');
    const items = data?.activity || [];
    if (!items.length) {
      body.innerHTML = '<div class="empty-state">暫無動態。</div>';
      return;
    }
    const EMOJI = {
      trade_accepted: '🔄', trade_executed: '🔄', trade_rejected: '❌',
      trade_vetoed: '🚫', fa_claim: '📝', milestone_blowout: '💥',
      milestone_nailbiter: '😅', milestone_win_streak: '🔥',
      milestone_lose_streak: '📉', milestone_top_performer: '🌟',
      injury_new: '🏥', injury_return: '💪', champion: '🏆',
    };
    body.innerHTML = '';
    for (const item of items) {
      const emoji = EMOJI[item.type] || '•';
      const row = el('div', { class: 'activity-row' },
        el('span', { class: 'activity-emoji' }, emoji),
        el('span', { class: 'activity-summary' }, item.summary),
      );
      body.append(row);
    }
  } catch (_) {
    // silently ignore if season not started
  }
}

function buildStandingsPanel() {
  const panel = el('div', { class: 'panel' },
    el('div', { class: 'panel-head' }, el('h2', {}, '戰績')),
    el('div', { class: 'table-wrap' }),
  );
  const wrap = panel.querySelector('.table-wrap');

  const rows = Array.isArray(state.standings) ? state.standings : (state.standings?.standings || []);
  if (!rows.length) {
    wrap.append(el('div', { class: 'empty-state' }, '尚無戰績。'));
    return panel;
  }

  const tbl = el('table', { class: 'data' });
  tbl.innerHTML = `
    <thead><tr>
      <th>#</th><th>隊伍</th>
      <th class="num">勝-敗</th>
      <th class="num">得分</th>
      <th class="num">失分</th>
    </tr></thead>
    <tbody>${rows.map((r, i) => {
      const isYou = r.is_human || r.human || r.team_id === state.draft?.human_team_id;
      const wins   = r.w ?? r.wins ?? 0;
      const losses = r.l ?? r.losses ?? 0;
      const pf     = r.pf ?? r.points_for ?? 0;
      const pa     = r.pa ?? r.points_against ?? 0;
      return `<tr class="standings-row ${isYou ? 'you' : ''}">
        <td class="rank">${r.rank ?? (i + 1)}</td>
        <td class="name">${escapeHtml(r.name || r.team_name || `隊伍 ${r.team_id}`)}</td>
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
      el('h2', {}, `第 ${week} 週對戰`),
    ),
  );
  const body = el('div', { class: 'panel-body tight' });
  panel.append(body);

  const matchups = matchupsForWeek(week);
  if (!matchups.length) {
    body.append(el('div', { class: 'empty-state' }, '本週尚無對戰資料。'));
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
      el('span', { class: 'tm' }, teamName(teamA) || `隊伍 ${teamA}`),
      el('span', { class: 'sc' }, played ? fmtStat(scoreA) : '-'),
    ),
    el('span', { class: 'vs' }, 'VS'),
    el('div', { class: 'side right' },
      el('span', { class: 'tm' }, teamName(teamB) || `隊伍 ${teamB}`),
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
  if (!d) { root.append(el('div', { class: 'empty-state' }, '載入中...')); return; }

  const byWeek = groupedByWeek();
  if (byWeek.size === 0) {
    root.append(
      el('div', { class: 'panel' },
        el('div', { class: 'panel-head' }, el('h2', {}, '賽程')),
        emptyState(
          '賽季尚未開始',
          '賽程將在賽季開始後生成。',
          el('a', { class: 'btn', href: '#league' }, '前往聯盟'),
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
      el('span', { class: 'wk-num' }, isPlayoff ? `季後賽 W${wkNum}` : `第 ${wkNum} 週`),
      el('span', { class: 'wk-title' }, played ? '已結束' : isCurrent ? '進行中' : '未開始'),
      el('span', { class: 'wk-sub' }, `${matchups.length} 場對戰`),
    );
    grid.append(cell);
  }

  root.append(
    el('div', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', {}, '賽程')),
      el('div', { class: 'panel-body' }, grid),
    ),
  );
}

function openWeekDialog(weekNum, matchups, isPlayoff) {
  const dlg = $('#dlg-matchup');
  $('#matchup-title').textContent = (isPlayoff ? '季後賽 ' : '') + `第 ${weekNum} 週`;
  const body = $('#matchup-body');
  body.innerHTML = '';
  if (!matchups.length) {
    body.append(el('div', { class: 'empty-state' }, '本週無對戰。'));
  } else {
    for (const m of matchups) {
      body.append(buildMatchupDetail(m));
    }
  }
  try { dlg.showModal(); } catch { /* dialog unsupported */ }
}

function openMatchupDialog(week, m) {
  const dlg = $('#dlg-matchup');
  const a = teamName(m.team_a ?? m.home_team_id) || '主場';
  const b = teamName(m.team_b ?? m.away_team_id) || '客場';
  $('#matchup-title').textContent = `第 ${week} 週 — ${a} vs ${b}`;
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

  const nameA = teamName(teamA) || `隊伍 ${teamA}`;
  const nameB = teamName(teamB) || `隊伍 ${teamB}`;

  const wrap = el('div', { class: 'matchup-detail' });
  wrap.innerHTML = `
    <div class="matchup-side">
      <div class="tname">${escapeHtml(nameA)}${played && winnerId === teamA ? ' <span class="pill success">勝</span>' : ''}</div>
      <div class="score">${played ? fmtStat(scoreA) : '-'}</div>
    </div>
    <div class="matchup-side">
      <div class="tname">${escapeHtml(nameB)}${played && winnerId === teamB ? ' <span class="pill success">勝</span>' : ''}</div>
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
  // Detect newly arrived counter-offers directed at the human and toast.
  const humanId = state.draft?.human_team_id ?? 0;
  const prevIds = new Set((state.tradesPending || []).map((t) => t.id));
  for (const t of list) {
    if (t.counter_of != null && t.to_team === humanId && !prevIds.has(t.id)) {
      const fromName = teamName(t.from_team) || `隊伍 ${t.from_team}`;
      toast(`AI 還價：${fromName}`, 'info', 6000);
    }
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

function buildCalendarPanel(st) {
  const currentDay = (st && st.current_day) || 0;
  const currentWeek = (st && st.current_week) || 1;
  const today = seasonDate(currentDay || 1);
  const dayInWeek = currentDay ? ((currentDay - 1) % 7) : 0;
  const weekStartDay = currentDay ? currentDay - dayInWeek : 1;

  const cells = [];
  for (let i = 0; i < 7; i++) {
    const d = weekStartDay + i;
    const date = seasonDate(d);
    const played = currentDay > 0 && d < currentDay;
    const isToday = d === currentDay;
    const isFuture = d > currentDay;
    const cls = ['cal-cell'];
    if (played)   cls.push('played');
    if (isToday)  cls.push('today');
    if (isFuture) cls.push('future');
    cells.push(el('div', { class: cls.join(' ') },
      el('span', { class: 'cal-dow' }, WEEKDAYS_TW[date.getDay()]),
      el('span', { class: 'cal-md' }, `${date.getMonth() + 1}/${date.getDate()}`),
      el('span', { class: 'cal-status' }, played ? '已結束' : isToday ? '今日' : '—'),
    ));
  }

  const todayLabel = currentDay > 0
    ? `今日 · ${formatSeasonDate(today)}`
    : `賽季即將開打 · ${formatSeasonDate(seasonDate(1))}`;

  return el('div', { class: 'panel cal-panel' },
    el('div', { class: 'panel-head' },
      el('h2', {}, todayLabel),
      el('span', { class: 'pill muted' }, `第 ${currentWeek} 週`),
    ),
    el('div', { class: 'panel-body cal-strip' }, ...cells),
  );
}

function renderTradeQuota(wrap) {
  if (!wrap) return;
  const pendingCount = state.standings?.pending_count ?? state.tradesPending.length;
  wrap.innerHTML = pendingCount
    ? `<span class="pill warn">${pendingCount} 待處理</span>`
    : '';
}

function renderPendingTrades(body) {
  body.innerHTML = '';
  if (!state.tradesPending.length) {
    body.append(el('div', { class: 'empty-state' }, '沒有待處理交易'));
    return;
  }
  for (const t of state.tradesPending) {
    body.append(buildTradeCard(t));
  }
}

function buildTradeCard(trade) {
  const card = el('div', { class: `trade-card status-${trade.status}` });

  const fromName = teamName(trade.from_team) || `隊伍 ${trade.from_team}`;
  const toName   = teamName(trade.to_team)   || `隊伍 ${trade.to_team}`;

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
  const sides = el('l', { class: 'trade-sides' },
    buildTradeSide(`${fromName} 送出`, sendPlayers, sendSum),
    buildTradeSide(`${toName} 送出`, recvPlayers, recvSum),
  );

  // Balance
  const balance = el('div', { class: 'trade-balance' },
    el('span', {}, `Σ ${fppg(sendSum)} FPPG`),
    el('span', { class: `trade-ratio-badge ${ratioCls}` }, `比值 ${ratio.toFixed(2)}x`),
    el('span', {}, `Σ ${fppg(recvSum)} FPPG`),
  );

  // Counter-offer banner
  const parts = [];
  if (trade.counter_of != null) {
    const origShort = String(trade.counter_of).slice(0, 8);
    const banner = el('div', { class: 'trade-counter-banner' },
      el('span', {}, '📩 這是對你原始提議的還價 — 原始提議已作廢'),
      el('button', {
        type: 'button',
        class: 'trade-counter-orig-link',
        onclick: () => scrollToHistoryTrade(trade.counter_of),
      }, `查看原提議 #${origShort}`),
    );
    parts.push(banner);
  }
  parts.push(head, sides, balance);

  // Reasoning (if present + not just "human")
  if (trade.reasoning && trade.reasoning !== 'human') {
    parts.push(el('div', { class: 'trade-reasoning' }, trade.reasoning));
  }
  if (trade.proposer_message) {
    parts.push(
      el('div', { class: 'trade-proposer-msg' },
        el('span', { class: 'trade-msg-label' }, '提案者留言：'),
        el('span', { class: 'trade-msg-text' }, trade.proposer_message),
      ),
    );
  }
  if (trade.force_executed) {
    parts.push(el('span', { class: 'trade-force-badge' }, '強制執行'));
  }
  if (trade.peer_commentary && trade.peer_commentary.length) {
    const commentList = el('ul', { class: 'trade-peer-commentary' });
    for (const c of trade.peer_commentary) {
      commentList.append(el('li', {}, `${c.team_name}（${modelShortName(c.model)}）：${c.text}`));
    }
    parts.push(
      el('div', { class: 'trade-commentary-section' },
        el('div', { class: 'trade-commentary-head' }, '其他 GM 看法'),
        commentList,
      ),
    );
  }

  // Veto vote count (for accepted trades)
  if (trade.status === 'accepted') {
    const votes = (trade.veto_votes || []).length;
    parts.push(el('div', { class: 'veto-vote-count' }, `否決票：${votes} / 3`));
  }

  // Action buttons
  const actions = buildTradeActions(trade);
  if (actions) parts.push(actions);

  card.append(...parts);
  return card;
}

function buildTradeStatusBadge(trade) {
  const statusMap = {
    'pending_accept': '等待回應',
    'accepted': '已接受（否決期）',
    'vetoed': '已否決',
    'executed': '已完成',
    'rejected': '已拒絕',
    'expired': '已過期',
    'countered': '已還價',
  };
  const label = statusMap[trade.status] || trade.status.replace(/_/g, ' ');
  if (trade.counter_of) {
    return el('span', { class: `trade-status trade-status-${trade.status}` },
      `↩ 還價 · ${label}`);
  }
  if (trade.status === 'accepted' && trade.veto_deadline_day != null) {
    return el('span', { class: `trade-status trade-status-${trade.status}` },
      `已接受（否決期） · 否決截止日 ${trade.veto_deadline_day}`);
  }
  return el('span', { class: `trade-status trade-status-${trade.status}` }, label);
}

function buildTradeSide(title, players, sum) {
  const wrap = el('div', { class: 'trade-side' },
    el('div', { class: 'trade-side-title' }, title),
  );
  const list = el('ul', { class: 'trade-player-list' });
  if (!players.length) {
    list.append(el('li', { class: 'empty' }, '（無）'));
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
      el('button', { class: 'btn small', onclick: () => onAcceptTrade(trade.id) }, '接受'),
      el('button', { class: 'btn small ghost', onclick: () => onRejectTrade(trade.id) }, '拒絕'),
    );
    return actions;
  }
  if (status === 'pending_accept' && trade.from_team === humanId) {
    actions.append(
      el('button', { class: 'btn small ghost', onclick: () => onCancelTrade(trade.id) }, '取消'),
    );
    return actions;
  }
  if (status === 'accepted'
      && trade.from_team !== humanId
      && trade.to_team !== humanId
      && !(trade.veto_votes || []).includes(humanId)) {
    actions.append(
      el('button', { class: 'btn small danger', onclick: () => onVetoTrade(trade.id) }, '投下否決票'),
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
  body.innerHTML = '<div class="empty-state">載入中...</div>';
  const payload = await apiSoft('/api/trades/history?limit=50');
  let hist = [];
  if (Array.isArray(payload)) hist = payload;
  else if (payload && Array.isArray(payload.history)) hist = payload.history;
  // P2: sort by most recent first — use executed_day/proposed_day + week as sort key
  hist = hist.slice().sort((a, b) => {
    const weekA = a.proposed_week ?? 0;
    const weekB = b.proposed_week ?? 0;
    const dayA  = a.executed_day ?? a.proposed_day ?? 0;
    const dayB  = b.executed_day ?? b.proposed_day ?? 0;
    const sortA = weekA * 1000 + dayA;
    const sortB = weekB * 1000 + dayB;
    return sortB - sortA;
  });
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
    body.append(el('div', { class: 'empty-state' }, '尚無交易紀錄。'));
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

  const statusMap = {
    'pending_accept': '等待回應',
    'accepted': '已接受（否決期）',
    'vetoed': '已否決',
    'executed': '已完成',
    'rejected': '已拒絕',
    'expired': '已過期',
    'countered': '已還價',
  };
  const statusLabel = statusMap[trade.status] || trade.status;

  // Build counter linkage suffix for status label in history row.
  let histStatusLabel = statusLabel;
  if (trade.counter_of) {
    const origShort = String(trade.counter_of).slice(0, 8);
    histStatusLabel = `↩ 還價自 #${origShort}`;
  } else if (trade.status === 'countered') {
    // Find the counter trade in history to get its id.
    const counterTrade = state.tradesHistory.find((t) => t.counter_of === trade.id);
    if (counterTrade) {
      const counterShort = String(counterTrade.id).slice(0, 8);
      histStatusLabel = `${statusLabel} → 已被還價 #${counterShort}`;
    }
  }

  // Determine counter-pair group id for visual connector.
  const pairId = trade.counter_of
    ? trade.counter_of
    : (trade.status === 'countered' ? trade.id : null);
  const rowAttrs = { class: 'trade-hist-row', 'data-trade-id': trade.id };
  if (pairId) rowAttrs['data-counter-pair'] = pairId;
  if (trade.counter_of) rowAttrs['data-is-counter'] = '1';

  const row = el('li', rowAttrs);
  const header = el('button', { type: 'button', class: 'trade-hist-head', onclick: () => onToggleHistRow(trade.id) },
    el('span', { class: 'wk' }, `W${week} D${day}`),
    el('span', { class: 'teams' }, `${fromName} → ${toName}`),
    el('span', { class: 'counts' }, `${nSend}→${nRecv} 名球員`),
    el('span', { class: `trade-status trade-status-${trade.status}` }, histStatusLabel),
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
  if (body) { renderTradeHistoryBody(body); applyCounterPairHighlights(body); }
}

function applyCounterPairHighlights(body) {
  // Remove previous highlights.
  body.querySelectorAll('.trade-pair-highlight').forEach((el) => el.classList.remove('trade-pair-highlight'));
  // For each expanded row that has a counter-pair, highlight the partner row.
  body.querySelectorAll('.trade-hist-row[data-counter-pair]').forEach((row) => {
    const pairId = row.dataset.counterPair;
    const tradeId = row.dataset.tradeId;
    const isExpanded = state.expandedHistory.has(tradeId);
    // Find partner: a row with the same pair-id that is NOT this row.
    const partner = body.querySelector(`.trade-hist-row[data-counter-pair="${pairId}"]:not([data-trade-id="${tradeId}"])`);
    if (isExpanded && partner) partner.classList.add('trade-pair-highlight');
  });
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
      el('div', { class: 'trade-hist-col-head' }, `${teamName(trade.from_team) || '送出方'} 送出`),
      ul1,
    ),
    el('div', { class: 'trade-hist-col' },
      el('div', { class: 'trade-hist-col-head' }, `${teamName(trade.to_team) || '接收方'} 送出`),
      ul2,
    ),
  );
  // Counter-offer linkage in detail.
  if (trade.counter_of) {
    const origShort = String(trade.counter_of).slice(0, 8);
    detail.append(
      el('div', { class: 'trade-hist-counter-link' },
        el('span', {}, `↩ 還價自 #${origShort}`),
        el('button', {
          type: 'button',
          class: 'trade-counter-orig-link',
          onclick: () => scrollToHistoryTrade(trade.counter_of),
        }, '查看原提議'),
      ),
    );
  } else if (trade.status === 'countered') {
    const counterTrade = state.tradesHistory.find((t) => t.counter_of === trade.id);
    if (counterTrade) {
      const counterShort = String(counterTrade.id).slice(0, 8);
      detail.append(
        el('div', { class: 'trade-hist-counter-link' },
          el('span', {}, `→ 已被還價 #${counterShort}`),
          el('button', {
            type: 'button',
            class: 'trade-counter-orig-link',
            onclick: () => scrollToHistoryTrade(counterTrade.id),
          }, '查看還價'),
        ),
      );
    }
  }

  if (trade.reasoning && trade.reasoning !== 'human') {
    detail.append(el('div', { class: 'trade-reasoning hist' }, trade.reasoning));
  }
  if (trade.proposer_message) {
    detail.append(
      el('div', { class: 'trade-proposer-msg' },
        el('span', { class: 'trade-msg-label' }, '提案者留言：'),
        el('span', { class: 'trade-msg-text' }, trade.proposer_message),
      ),
    );
  }
  if (trade.force_executed) {
    detail.append(el('span', { class: 'trade-force-badge' }, '強制執行'));
  }
  if (trade.peer_commentary && trade.peer_commentary.length) {
    const commentList = el('ul', { class: 'trade-peer-commentary' });
    for (const c of trade.peer_commentary) {
      const short = modelShortName(c.model);
      commentList.append(
        el('li', {}, `${c.team_name}（${short}）：${c.text}`),
      );
    }
    detail.append(
      el('div', { class: 'trade-commentary-section' },
        el('div', { class: 'trade-commentary-head' }, '其他 GM 看法'),
        commentList,
      ),
    );
  }
  return detail;
}

// Scroll to (and expand) a trade in the history panel by id.
async function scrollToHistoryTrade(id) {
  // Open history panel if closed.
  if (!state.tradeHistoryOpen) {
    await onToggleTradeHistory();
  }
  // Ensure the target row is expanded.
  state.expandedHistory.add(id);
  const body = $('#trade-history-body');
  if (body) renderTradeHistoryBody(body);
  // Scroll the row into view.
  const row = document.querySelector(`[data-trade-id="${id}"]`);
  if (row) row.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Trade action handlers
async function onAcceptTrade(id) {
  await mutate(async () => {
    await api(`/api/trades/${id}/accept`, { method: 'POST' });
    await afterTradeMutation();
  }, '交易已接受');
}
async function onRejectTrade(id) {
  await mutate(async () => {
    await api(`/api/trades/${id}/reject`, { method: 'POST' });
    await afterTradeMutation();
  }, '交易已拒絕');
}
async function onCancelTrade(id) {
  const ok = await confirmDialog('取消交易？', '撤回你的提案，此操作無法復原。', '取消');
  if (!ok) return;
  await mutate(async () => {
    await api(`/api/trades/${id}/cancel`, { method: 'POST' });
    await afterTradeMutation();
  }, '交易已取消');
}
async function onVetoTrade(id) {
  const ok = await confirmDialog('投下否決票？', '你的隊伍將投票否決此交易。累計 3 票後交易取消。', '否決');
  if (!ok) return;
  await mutate(async () => {
    const humanId = state.draft?.human_team_id ?? 0;
    await api(`/api/trades/${id}/veto`, {
      method: 'POST',
      body: JSON.stringify({ team_id: humanId }),
    });
    await afterTradeMutation();
  }, '否決票已投出');
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
  const options = [el('option', { value: '' }, '— 選擇對象隊伍 —')];
  for (const t of (state.draft?.teams || [])) {
    if (t.id === humanId) continue;
    options.push(el('option', { value: String(t.id) }, t.name));
  }
  const select = el('select', { id: 'cp-select', onchange: onCounterpartyChange }, ...options);
  if (state.proposeDraft.counterparty != null) select.value = String(state.proposeDraft.counterparty);

  body.append(
    el('div', { class: 'propose-row' },
      el('label', { for: 'cp-select' }, '交易對象'),
      select,
    ),
  );

  if (state.proposeDraft.counterparty == null) {
    body.append(el('div', { class: 'empty-state' }, '選擇隊伍後顯示名單。'));
    return;
  }

  // Side-by-side rosters
  const sides = el('div', { class: 'propose-sides' },
    buildProposeSide('送出（你的名單）', state.proposeDraft.humanRoster, state.proposeDraft.send, 'send'),
    buildProposeSide('收到（對方名單）', state.proposeDraft.counterpartyRoster, state.proposeDraft.receive, 'receive'),
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
      el('span', {}, `送出 Σ ${fppg(sendSum)}`),
      ratio ? el('span', { class: `trade-ratio-badge ${ratioCls}` }, `比值 ${ratio.toFixed(2)}x`) : el('span', {}, '—'),
      el('span', {}, `收到 Σ ${fppg(recvSum)}`),
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
    list.append(el('li', { class: 'empty' }, '（無球員）'));
  }
  wrap.append(list);
  return wrap;
}

function togglePickPlayer(which, id, checked) {
  const set = state.proposeDraft[which];
  if (checked) {
    if (set.size >= 3) {
      toast('每方最多 3 名球員', 'warn');
      renderProposeBody();
      return;
    }
    set.add(id);
  } else {
    set.delete(id);
  }
  renderProposeBody();
}

function modelShortName(modelId) {
  if (!modelId) return '';
  if (modelId.includes('claude-haiku')) return 'Claude Haiku';
  if (modelId.includes('claude-3.5-sonnet') || modelId.includes('claude-3-5-sonnet')) return 'Claude Sonnet';
  if (modelId.includes('claude')) return 'Claude';
  if (modelId.includes('gpt-4o-mini')) return 'GPT-4o-mini';
  if (modelId.includes('gpt-4.1-mini')) return 'GPT-4.1-mini';
  if (modelId.includes('gpt-4o')) return 'GPT-4o';
  if (modelId.includes('gemini-flash')) return 'Gemini Flash';
  if (modelId.includes('gemini')) return 'Gemini';
  if (modelId.includes('llama')) return 'Llama';
  if (modelId.includes('mistral')) return 'Mistral';
  if (modelId.includes('deepseek')) return 'DeepSeek';
  if (modelId.includes('qwen')) return 'Qwen';
  if (modelId.includes('grok')) return 'Grok';
  return modelId.split('/').pop() || modelId;
}

async function onSubmitProposeTrade() {
  const humanId = state.draft?.human_team_id ?? 0;
  const { counterparty, send, receive } = state.proposeDraft;
  if (counterparty == null) { toast('請選擇交易對象', 'warn'); return; }
  if (!send.size || !receive.size) { toast('每方至少選一名球員', 'warn'); return; }

  const proposerMessage = ($('#trade-message')?.value || '').trim();
  const force = !!$('#trade-force')?.checked;

  try {
    await api('/api/trades/propose', {
      method: 'POST',
      body: JSON.stringify({
        from_team: humanId,
        to_team: counterparty,
        send: Array.from(send),
        receive: Array.from(receive),
        proposer_message: proposerMessage,
        force,
      }),
    });
    toast(force ? '交易已強制執行' : '交易已發起,等 AI 回覆中...', 'success');
    $('#trade-propose').close();
    await afterTradeMutation();
    // AI peer commentary + counterparty decision run in backend background task.
    // Poll a couple of times so UI picks up the response without manual refresh.
    setTimeout(() => { afterTradeMutation().catch(() => {}); }, 3000);
    setTimeout(() => { afterTradeMutation().catch(() => {}); }, 10000);
  } catch (e) {
    toast(e.message || '提案失敗', 'error');
  }
}

// ================================================================ log aside
function renderLogAside() {
  const list = $('#log-list');
  if (!list) return;
  if (!state.logs.length) {
    list.innerHTML = `<li class="empty">尚無活動記錄。</li>`;
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

  const tn = (id) => (id == null ? null : (teamName(id) || `T${id}`));
  const pnames = (ids) => (Array.isArray(ids) ? ids.map(id => playerName(id)).filter(Boolean).join('、') : '');

  switch (e.type) {
    case 'season_start':
      return `球季開打（${e.num_teams ?? '?'} 隊、${e.weeks ?? '?'} 週）`;
    case 'season_reset':
      return '球季已重置';
    case 'day_advance':
      return `第 ${e.day} 天（第 ${e.week} 週）比賽結束`;
    case 'champion': {
      const champ = tn(e.champion ?? e.team_id);
      return champ ? `🏆 ${champ} 奪下總冠軍！` : '🏆 賽季結束，冠軍誕生';
    }
    case 'ai_decision': {
      const team = tn(e.team_id);
      const action = e.action === 'lineup' ? '排出先發' : (e.action || '決策');
      return team ? `${team} AI ${action}${e.persona ? `（${e.persona}）` : ''}` : `AI ${action}`;
    }
    case 'trade_proposed': {
      const from = tn(e.from_team), to = tn(e.to_team);
      const give = pnames(e.send), get = pnames(e.receive);
      const who = e.reasoning === 'human' ? '（你）' : '';
      return `${from}${who} 向 ${to} 提出交易：送出 ${give || '—'}，換回 ${get || '—'}`;
    }
    case 'trade_accepted': {
      const from = tn(e.from_team), to = tn(e.to_team);
      return `${to} 同意了與 ${from} 的交易`;
    }
    case 'trade_rejected': {
      const from = tn(e.from_team), to = tn(e.to_team);
      return `${to} 拒絕了 ${from} 的交易提案`;
    }
    case 'trade_executed': {
      const from = tn(e.from_team), to = tn(e.to_team);
      const give = pnames(e.send), get = pnames(e.receive);
      return `✅ 交易生效：${from} 送出 ${give || '—'} ⇄ ${to} 送出 ${get || '—'}`;
    }
    case 'trade_vetoed': {
      const from = tn(e.from_team), to = tn(e.to_team);
      return `🚫 ${from} ⇄ ${to} 的交易遭聯盟否決`;
    }
    case 'trade_expired': {
      const from = tn(e.from_team), to = tn(e.to_team);
      return `${from} ⇄ ${to} 的交易已過期`;
    }
    case 'trade_veto_vote': {
      const voter = tn(e.voter);
      return `${voter || '某隊'} 投下否決票（已 ${e.total_votes ?? '?'} 票）`;
    }
    case 'trade_cancelled': {
      const from = tn(e.from_team);
      return `${from || '提案方'} 撤回了交易提案`;
    }
    case 'fa_claim': {
      const team = tn(e.team_id);
      const dropName = e.drop_name || playerName(e.drop);
      const addName = e.add_name || playerName(e.add);
      return `${team || '你'} 釋出 ${dropName},簽入自由球員 ${addName}`;
    }
    case 'milestone_blowout': {
      const w = tn(e.winner), l = tn(e.loser);
      return `💥 大屠殺！${w} 以 ${e.diff} 分血洗 ${l}`;
    }
    case 'milestone_nailbiter': {
      const w = tn(e.winner);
      const a = tn(e.team_a), b = tn(e.team_b);
      return `⚡ 最後一刻！${w} 僅 ${e.diff} 分擊敗 ${w === a ? b : a}`;
    }
    case 'milestone_win_streak': {
      const t = tn(e.team_id);
      return `🔥 ${t} 三連勝!`;
    }
    case 'milestone_lose_streak': {
      const t = tn(e.team_id);
      return `💀 ${t} 陷入三連敗`;
    }
    case 'milestone_top_performer': {
      const team = tn(e.team_id);
      return `🌟 ${e.player_name} 單場爆發 ${e.fp} FP（${team}）`;
    }
  }

  // Fallback with readable field names
  const team = tn(e.team_id);
  const parts = [];
  if (e.type)     parts.push(String(e.type));
  if (team)       parts.push(team);
  if (e.action)   parts.push(String(e.action));
  if (e.persona)  parts.push(`（${e.persona}）`);
  if (e.excerpt)  parts.push('— ' + e.excerpt);
  return parts.length ? parts.join(' ') : JSON.stringify(e);
}

function playerName(id) {
  if (id == null) return '';
  const cached = state.playerCache?.get?.(id);
  if (cached && cached.name) return cached.name;
  const byId = state.draft?.players_by_id;
  if (byId && byId[id]?.name) return byId[id].name;
  return `#${id}`;
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
    toast(e.message || '請求失敗', 'error');
    throw e;
  }
}

async function onAdvance() {
  await mutate(async () => {
    const r = await api('/api/draft/ai-advance', { method: 'POST' });
    state.draft = r.state;
    // Also pull a fresh authoritative snapshot to make sure nothing is stale
    await refreshState();
    render();
  });
}

async function onSimToMe() {
  await mutate(async () => {
    const r = await api('/api/draft/sim-to-me', { method: 'POST' });
    state.draft = r.state;
    await refreshState();
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
    toast(e.message || '選秀失敗', 'error');
  }
}

async function onResetDraft() {
  const ok = await confirmDialog('重置選秀？', '所有選秀順位將被清除，此操作無法復原。', '重置');
  if (!ok) return;
  await mutate(async () => {
    const r = await api('/api/draft/reset', {
      method: 'POST',
      body: JSON.stringify({ randomize_order: false }),
    });
    state.draft = r;
    navigate('draft');
    render();
  }, '選秀已重置');
}

async function onResetSeason() {
  const ok = await confirmDialog('重置賽季？', '所有賽季結果與賽程將被清除，選秀資料保留。', '重置');
  if (!ok) return;
  await mutate(async () => {
    await api('/api/season/reset', { method: 'POST' });
    await refreshState();
    render();
  }, '賽季已重置');
}

async function onSeasonStart() {
  await mutate(async () => {
    await api('/api/season/start', { method: 'POST' });
    await refreshState();
    render();
  }, '賽季已開始');
}

async function onAdvanceDay() {
  await mutate(async () => {
    const r = await api('/api/season/advance-day', { method: 'POST' });
    await refreshState();
    refreshLogs();
    render();
    const summary = r?.summary || r?.message || '已推進一天';
    toast(summary, 'success');
  });
}

async function onAdvanceWeek() {
  const prevWeek = state.standings?.current_week || state.schedule?.current_week || 1;
  await mutate(async () => {
    const r = await api('/api/season/advance-week', { method: 'POST' });
    await refreshState();
    refreshLogs();
    render();
    const summary = r?.summary || r?.message || '已推進一週';
    toast(summary, 'success');
  });
  // Auto-show recap for the week we just completed
  setTimeout(() => onShowWeekRecap(prevWeek), 400);
}

async function onShowWeekRecap(week) {
  if (!week) return;
  try {
    const data = await api(`/api/season/week-recap?week=${week}`);
    const currentWeek = currentWeekNumber();
    renderWeekRecapOverlay(data, week, currentWeek);
  } catch (err) {
    // 404 = week not resolved yet (e.g. first week of playoffs) — silent
    if (!String(err?.message || err).includes('404')) {
      toast('讀取週報失敗: ' + (err?.message || err), 'error');
    }
  }
}

function renderWeekRecapOverlay(r, browsingWeek, currentWeek) {
  const existing = document.getElementById('recap-overlay');
  if (existing) existing.remove();

  const week = r.week ?? browsingWeek ?? 1;
  const maxWeek = (currentWeek ?? currentWeekNumber()) - 1;
  const isHistory = week < (currentWeek ?? currentWeekNumber());

  const humanId = state.draft?.human_team_id;
  const closeBtn = el('button', { class: 'btn small ghost', onclick: () => document.getElementById('recap-overlay')?.remove() }, '關閉');

  const prevBtn = el('button', {
    class: 'recap-nav-btn',
    disabled: week <= 1,
    onclick: () => { document.getElementById('recap-overlay')?.remove(); onShowWeekRecap(week - 1); },
  }, '◀ 上週');
  const nextBtn = el('button', {
    class: 'recap-nav-btn',
    disabled: week >= maxWeek,
    onclick: () => { document.getElementById('recap-overlay')?.remove(); onShowWeekRecap(week + 1); },
  }, '下週 ▶');

  const trimmedNotice = r.logs_trimmed
    ? el('div', { class: 'recap-trimmed-notice' }, '舊週資料已清理，僅保留比分與對戰記錄')
    : null;

  const matchupList = el('ul', { class: 'recap-matchups' });
  for (const m of (r.matchups || [])) {
    const aWin = m.winner === m.team_a;
    const bWin = m.winner === m.team_b;
    const human = m.team_a === humanId || m.team_b === humanId;
    matchupList.append(el('li', { class: human ? 'recap-matchup human-row' : 'recap-matchup' },
      el('span', { class: aWin ? 'team win' : 'team' }, m.team_a_name),
      el('span', { class: 'score' }, `${m.score_a.toFixed(1)}`),
      el('span', { class: 'vs' }, 'vs'),
      el('span', { class: 'score' }, `${m.score_b.toFixed(1)}`),
      el('span', { class: bWin ? 'team win' : 'team' }, m.team_b_name),
    ));
  }

  const perfList = el('ol', { class: 'recap-top-performers' });
  for (const p of (r.top_performers || [])) {
    perfList.append(el('li', {},
      el('span', { class: 'pname' }, p.player_name),
      el('span', { class: 'pteam' }, p.team_name),
      el('span', { class: 'pfp' }, `${p.fp.toFixed(1)} FP`),
      el('span', { class: 'pline' }, `${p.pts}p / ${p.reb}r / ${p.ast}a`),
    ));
  }

  const blowoutCard = r.biggest_blowout
    ? el('div', { class: 'recap-card' },
        el('div', { class: 'recap-card-label' }, '💥 最懸殊比賽'),
        el('div', { class: 'recap-card-body' },
          `${r.biggest_blowout.winner_name || '平手'} 以 ${r.biggest_blowout.diff.toFixed(1)} 分差擊敗對手`,
        ))
    : null;

  const closeCard = r.closest_game
    ? el('div', { class: 'recap-card' },
        el('div', { class: 'recap-card-label' }, '⚔️ 最膠著比賽'),
        el('div', { class: 'recap-card-body' },
          `${r.closest_game.team_a_name} vs ${r.closest_game.team_b_name}，僅差 ${r.closest_game.diff.toFixed(1)} 分`,
        ))
    : null;

  const humanCard = r.human_matchup
    ? el('div', { class: 'recap-card recap-human' },
        el('div', { class: 'recap-card-label' },
          r.human_matchup.winner === humanId ? '✅ 你贏了' :
          r.human_matchup.winner == null ? '🤝 平手' : '❌ 你輸了'),
        el('div', { class: 'recap-card-body' },
          `${r.human_matchup.team_a_name} ${r.human_matchup.score_a.toFixed(1)} — ${r.human_matchup.score_b.toFixed(1)} ${r.human_matchup.team_b_name}`,
          r.human_top_performer
            ? el('div', { class: 'recap-human-top' },
                `本週MVP：${r.human_top_performer.player_name} (${r.human_top_performer.fp.toFixed(1)} FP)`)
            : null,
        ))
    : null;

  const titleText = `第 ${week} 週戰報` + (isHistory ? ' (歷史)' : '');
  const titleEl = isHistory
    ? el('h2', {}, el('span', { class: 'recap-history-flag' }, titleText))
    : el('h2', {}, titleText);

  const dialog = el('div', { class: 'recap-dialog' },
    el('div', { class: 'recap-head' },
      el('div', { class: 'recap-nav' }, prevBtn, titleEl, nextBtn),
      closeBtn,
    ),
    trimmedNotice,
    el('div', { class: 'recap-grid' },
      humanCard,
      blowoutCard,
      closeCard,
    ),
    el('section', { class: 'recap-section' },
      el('h3', {}, '🔥 本週 Top 5 表現'),
      perfList,
    ),
    el('section', { class: 'recap-section' },
      el('h3', {}, '📋 所有比賽'),
      matchupList,
    ),
  );

  const overlay = el('div', { class: 'recap-overlay', id: 'recap-overlay', onclick: (e) => {
    if (e.target.id === 'recap-overlay') e.currentTarget.remove();
  }}, dialog);
  document.body.append(overlay);
}

async function onSimToPlayoffs() {
  const ok = await confirmDialog('模擬到季後賽？', '執行所有剩餘例行賽週次，可能需要一點時間。', '執行');
  if (!ok) return;
  await mutate(async () => {
    await api('/api/season/sim-to-playoffs', { method: 'POST' });
    await refreshState();
    refreshLogs();
    render();
  }, '例行賽模擬完成');
}

async function onSimPlayoffs() {
  const ok = await confirmDialog('模擬季後賽淘汰賽？', '前 4 強進行準決賽 + 決賽（第 15–16 週）。', '執行');
  if (!ok) return;
  await mutate(async () => {
    await api('/api/season/sim-playoffs', { method: 'POST' });
    await refreshState();
    refreshLogs();
    render();
  }, '季後賽模擬完成');
}

async function onShowSummary() {
  try {
    const data = await api('/api/season/summary');
    renderSummaryOverlay(data);
  } catch (err) {
    toast('讀取總結失敗: ' + (err?.message || err), 'error');
  }
}

function renderSummaryOverlay(s) {
  const existing = document.getElementById('summary-overlay');
  if (existing) existing.remove();

  const tn = (id) => {
    const t = state.draft?.teams?.find(t => t.id === id);
    return t ? t.name : `#${id}`;
  };

  const champBanner = s.champion_id != null
    ? el('div', { class: 'summary-champion' },
        el('div', { class: 'summary-trophy' }, '🏆'),
        el('div', { class: 'summary-champ-name' }, `${s.champion_name} 奪冠！`),
      )
    : el('div', { class: 'summary-champion' },
        el('div', { class: 'summary-champ-name muted' }, '賽季總結（尚未封王）'),
      );

  const humanLine = s.human_rank != null
    ? el('div', { class: 'summary-sub' }, `你排名第 ${s.human_rank} / ${s.num_teams} 名`)
    : null;

  const mvpPanel = s.mvp
    ? el('div', { class: 'summary-card' },
        el('div', { class: 'summary-card-title' }, '🌟 賽季 MVP'),
        el('div', { class: 'summary-mvp-name' }, s.mvp.name),
        el('div', { class: 'summary-mvp-sub' },
          `${s.mvp.team_name} · ${s.mvp.pos}`),
        el('div', { class: 'summary-mvp-stats' },
          `${fppg(s.mvp.fppg)} FP/場 · ${s.mvp.gp} 場 · 總 FP ${fppg(s.mvp.fp_total)}`),
      )
    : null;

  const topGamesPanel = el('div', { class: 'summary-card' },
    el('div', { class: 'summary-card-title' }, '🔥 賽季五大神表現'),
    el('ol', { class: 'summary-top-games' },
      ...(s.top_games || []).map(g =>
        el('li', {},
          el('span', { class: 'tg-player' }, g.player),
          el('span', { class: 'tg-team' }, ` (${g.team})`),
          el('span', { class: 'tg-fp' }, ` — ${fppg(g.fp)} FP`),
          el('span', { class: 'tg-meta' },
            ` · W${g.week}D${((g.day - 1) % 7) + 1} · ${fmtStat(g.pts)}分/${fmtStat(g.reb)}籃/${fmtStat(g.ast)}助`),
        ),
      ),
    ),
  );

  const standingsPanel = el('div', { class: 'summary-card' },
    el('div', { class: 'summary-card-title' }, '📊 最終戰績'),
    el('table', { class: 'summary-standings' },
      el('thead', {}, el('tr', {},
        el('th', {}, '#'), el('th', {}, '隊伍'),
        el('th', {}, '戰績'), el('th', {}, '得分'),
      )),
      el('tbody', {},
        ...s.final_standings.map((row, i) =>
          el('tr', { class: row.is_human ? 'human-row' : '' },
            el('td', {}, i + 1),
            el('td', {},
              row.team_id === s.champion_id ? '👑 ' : '',
              row.name,
              row.is_human ? ' (你)' : '',
            ),
            el('td', {}, `${row.w}-${row.l}`),
            el('td', {}, fppg(row.pf)),
          ),
        ),
      ),
    ),
  );

  const leadersPanel = el('div', { class: 'summary-card' },
    el('div', { class: 'summary-card-title' }, '🏀 場均領袖 Top 10'),
    el('table', { class: 'summary-leaders' },
      el('thead', {}, el('tr', {},
        el('th', {}, '#'), el('th', {}, '球員'),
        el('th', {}, '隊伍'), el('th', {}, 'FPPG'), el('th', {}, '場次'),
      )),
      el('tbody', {},
        ...(s.season_leaders || []).map((p, i) =>
          el('tr', {},
            el('td', {}, i + 1),
            el('td', {}, `${p.name} (${p.pos})`),
            el('td', {}, p.team_name),
            el('td', {}, fppg(p.fppg)),
            el('td', {}, p.gp),
          ),
        ),
      ),
    ),
  );

  const closeBtn = el('button', {
    class: 'btn', onclick: () => document.getElementById('summary-overlay')?.remove(),
  }, '關閉');

  const shareBtn = el('button', {
    class: 'btn ghost',
    onclick: () => {
      const text = [
        `🏆 ${s.champion_name || '—'} 奪冠！`,
        `MVP: ${s.mvp?.name || '—'} (${fppg(s.mvp?.fppg || 0)} FPPG)`,
        `我排名第 ${s.human_rank || '—'} / ${s.num_teams}`,
      ].join('\n');
      navigator.clipboard?.writeText(text).then(
        () => toast('已複製到剪貼簿'),
        () => toast('複製失敗', 'error'),
      );
    },
  }, '📋 複製戰報');

  const overlay = el('div', {
    id: 'summary-overlay', class: 'summary-overlay',
    onclick: (e) => { if (e.target.id === 'summary-overlay') e.currentTarget.remove(); },
  },
    el('div', { class: 'summary-dialog' },
      champBanner, humanLine,
      el('div', { class: 'summary-grid' },
        mvpPanel, topGamesPanel, standingsPanel, leadersPanel,
      ),
      el('div', { class: 'summary-actions' }, shareBtn, closeBtn),
    ),
  );
  document.body.append(overlay);
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

  // Trade propose modal: submit + cancel + force checkbox warning.
  const submitBtn = $('#btn-trade-propose-submit');
  if (submitBtn) submitBtn.addEventListener('click', (e) => { e.preventDefault(); onSubmitProposeTrade(); });

  const forceChk = $('#trade-force');
  const forceWarn = $('#trade-force-warn');
  if (forceChk && forceWarn) {
    forceChk.addEventListener('change', () => {
      forceWarn.hidden = !forceChk.checked;
    });
  }

  // League settings dialog save button.
  const lsSaveBtn = $('#btn-league-settings-save');
  if (lsSaveBtn) lsSaveBtn.addEventListener('click', onSaveLeagueSettings);
}

async function init() {
  bindGlobalUI();
  try {
    state.personas = await api('/api/personas');
  } catch {
    state.personas = {};
  }

  // Load league status + settings + seasons list (best-effort)
  const [leagueStatus, leagueSettings, seasonsList] = await Promise.all([
    apiSoft('/api/league/status'),
    apiSoft('/api/league/settings'),
    apiSoft('/api/seasons/list'),
  ]);
  state.leagueStatus   = leagueStatus;
  state.leagueSettings = leagueSettings;
  state.seasonsList    = seasonsList?.seasons || [];
  if (leagueSettings) {
    state.draftDisplayMode = leagueSettings.draft_display_mode || 'prev_full';
  }

  // If setup not complete, redirect to #setup regardless of current hash
  if (leagueStatus && !leagueStatus.setup_complete) {
    _setupForm = makeDefaultSetupForm(leagueSettings);
    if (currentRoute() !== 'setup') {
      location.hash = 'setup';
      // hashchange will trigger render()
      return;
    }
  }

  try {
    await refreshState();
  } catch (e) {
    toast(`載入狀態失敗：${e.message}`, 'error', 6000);
    // Still render (setup page doesn't need draft state)
  }
  render();
}

init().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="color:#f87171;padding:20px;font-family:monospace;">${escapeHtml(e.stack || e.message)}</pre>`;
});
