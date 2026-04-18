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
  faFilter: { q: '', pos: '', sort: 'fppg', excludeInjured: true },
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
  leagueSubTab: 'matchup',      // Yahoo-style sub-tab: matchup | standings | management | activity
  activityFilter: 'all',        // all | trade | fa | injury | milestone
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
  // Errors/warnings need assertive announcement; extend display time so
  // screen-reader users and quick-glancing humans both have time to read.
  const isUrgent = (kind === 'error' || kind === 'warn');
  const role = isUrgent ? 'alert' : 'status';
  const ariaLive = isUrgent ? 'assertive' : 'polite';
  const effectiveMs = ms === 3000 && isUrgent ? 6000 : ms;
  const node = el('div', {
    class: `toast ${kind}`,
    role,
    'aria-live': ariaLive,
    'aria-atomic': 'true',
  }, message);
  stack.append(node);
  setTimeout(() => {
    node.classList.add('fade');
    setTimeout(() => node.remove(), 220);
  }, effectiveMs);
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

  const heroContainer = el('div', { id: 'draft-hero-container' }, buildDraftHero(d));
  const boardPanel = buildBoardPanel(d);
  const availablePanel = buildAvailablePanel(d, displayMode);

  const grid = el('div', { class: 'draft-grid' },
    el('div', {}, availablePanel),
    el('div', {}, boardPanel),
  );

  // Headlines placeholder container
  const headlinesContainer = el('div', { id: 'headlines-container' });

  // Stable DOM order to avoid layout-jumps when turn flips AI<->human.
  // Available panel is first during human turn so the 選秀 button is above
  // the fold; otherwise headlines-first since no action is needed.
  const isHumanTurn = !d.is_complete && d.current_team_id === d.human_team_id;
  if (isHumanTurn) {
    root.append(heroContainer, grid, headlinesContainer);
  } else {
    root.append(headlinesContainer, heroContainer, grid);
  }

  wireAvailableFilters();
  const wasHumanTurn = state._lastDraftWasHumanTurn === true;
  state._lastDraftWasHumanTurn = isHumanTurn;
  renderAvailableTable(displayMode).then(() => {
    // Only scroll when TRANSITIONING into human turn, not on every render —
    // otherwise the page jumps every ~1.5s as AI picks trigger re-renders.
    if (isHumanTurn && !wasHumanTurn) {
      const panel = document.getElementById('panel-available');
      if (panel && typeof panel.scrollIntoView === 'function') {
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  });

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

function categorizeHeadline(text) {
  const t = String(text || '');
  if (/新秀/.test(t))               return { key: 'rookie',   icon: '🎓', label: '新秀', tone: 'rookie' };
  if (/告別賽場|謝幕|退役/.test(t)) return { key: 'retire',   icon: '👋', label: '退役', tone: 'retire' };
  if (/續約/.test(t))               return { key: 'resign',   icon: '💼', label: '續約', tone: 'resign' };
  if (/冠軍|奪冠|MVP/.test(t))      return { key: 'award',    icon: '🏆', label: '榮耀', tone: 'award' };
  if (/震撼轉會|加盟|離開|交易|加入/.test(t))
                                    return { key: 'transfer', icon: '🔄', label: '轉隊', tone: 'transfer' };
  return                              { key: 'general',  icon: '📰', label: '頭條', tone: 'general' };
}

async function loadHeadlinesBanner(container, seasonYear) {
  const data = await apiSoft(`/api/seasons/${encodeURIComponent(seasonYear)}/headlines`);
  if (!data || !data.headlines || !data.headlines.length) return;

  const items = data.headlines.slice(0, 12).map((h) => {
    const text = typeof h === 'string' ? h : (h.text || h.headline || JSON.stringify(h));
    return { text, ...categorizeHeadline(text) };
  });

  const carousel = { idx: 0 };
  const hero = el('section', { class: 'headlines-hero' });

  const header = el('div', { class: 'hh-header' },
    el('div', { class: 'hh-title' },
      el('span', { class: 'hh-dot' }),
      el('span', { class: 'hh-season' }, escapeHtml(seasonYear)),
      el('span', { class: 'hh-label' }, '休賽期頭條'),
    ),
    el('div', { class: 'hh-count' }, `${items.length} 則`),
  );

  const stage = el('div', { class: 'hh-stage' });
  const prevBtn = el('button', { type: 'button', class: 'hh-nav prev', 'aria-label': '上一則',
    onclick: () => { carousel.idx = (carousel.idx - 1 + items.length) % items.length; redraw(); },
  }, '‹');
  const nextBtn = el('button', { type: 'button', class: 'hh-nav next', 'aria-label': '下一則',
    onclick: () => { carousel.idx = (carousel.idx + 1) % items.length; redraw(); },
  }, '›');
  const cardWrap = el('div', { class: 'hh-card-wrap' });
  stage.append(prevBtn, cardWrap, nextBtn);

  const dots = el('div', { class: 'hh-dots' });

  hero.append(header, stage, dots);
  container.append(hero);

  function redraw() {
    const it = items[carousel.idx];
    cardWrap.innerHTML = '';
    cardWrap.append(el('article', { class: `hh-card tone-${it.key}` },
      el('div', { class: 'hh-cat' },
        el('span', { class: 'hh-cat-icon' }, it.icon),
        el('span', { class: 'hh-cat-label' }, it.label),
      ),
      el('div', { class: 'hh-text' }, it.text),
      el('div', { class: 'hh-pager' }, `${carousel.idx + 1} / ${items.length}`),
    ));
    dots.innerHTML = '';
    for (let i = 0; i < items.length; i++) {
      dots.append(el('button', {
        type: 'button',
        class: `hh-dot-btn ${i === carousel.idx ? 'active' : ''}`,
        'aria-label': `第 ${i + 1} 則`,
        onclick: () => { carousel.idx = i; redraw(); },
      }, el('span', { class: 'hh-dot-inner' })));
    }
  }
  redraw();
}

function buildDraftHero(d) {
  const hero = el('section', { class: 'draft-hero' });
  const totalPicks = d.num_teams * d.total_rounds;
  const pct = Math.min(100, Math.max(0, ((d.current_overall - 1) / Math.max(1, totalPicks)) * 100));

  if (d.is_complete) {
    hero.classList.add('complete');
    hero.append(
      el('div', { class: 'dh-main' },
        el('div', { class: 'dh-badge' }, '✅ 選秀完成'),
        el('div', { class: 'dh-who' }, '所有順位已選完'),
        el('div', { class: 'dh-sub' }, `${totalPicks} 順位全部完成。前往聯盟頁面開始賽季。`),
        el('div', { class: 'dh-actions' },
          el('a', { class: 'btn primary', href: '#league' }, '🏁 前往聯盟'),
        ),
      ),
      el('div', { class: 'dh-progress' },
        el('div', { class: 'dh-progress-fill', style: 'width: 100%' }),
      ),
    );
    return hero;
  }

  const team  = d.teams[d.current_team_id];
  const isYou = team?.is_human;
  const persona = team?.gm_persona ? state.personas?.[team.gm_persona] : null;

  if (isYou) hero.classList.add('you-turn');
  else hero.classList.add('ai-turn');

  // Left: pick counter
  const picker = el('div', { class: 'dh-picker' },
    el('div', { class: 'dh-picker-label' }, '總順位'),
    el('div', { class: 'dh-picker-num' }, `#${d.current_overall}`),
    el('div', { class: 'dh-picker-sub' }, `第 ${d.current_round} 輪 · 第 ${d.current_pick_in_round} 順`),
  );

  // Center: on the clock
  const spotlight = el('div', { class: 'dh-main', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    el('div', { class: 'dh-badge' },
      el('span', { class: 'dh-live-dot' }),
      isYou ? '輪到你了' : '選秀進行中',
    ),
    el('div', { class: 'dh-who' }, isYou ? `🎯 ${team.name}（你）` : `🤖 ${team.name}`),
    persona && !isYou ? el('div', { class: 'dh-persona' },
      el('span', { class: 'dh-persona-tag' }, '👤 ' + (persona.name || team.gm_persona)),
      el('span', { class: 'dh-persona-desc' }, persona.desc || ''),
    ) : null,
    isYou ? el('div', { class: 'dh-prompt' }, '請在下方「剩餘球員」選擇球員。') : null,
    el('div', { class: 'dh-actions' },
      el('button', { class: 'btn ghost', disabled: isYou, onclick: onAdvance }, '推進 AI 一手'),
      el('button', { class: 'btn primary', disabled: isYou, onclick: onSimToMe }, '⏭ 模擬到我'),
    ),
  );

  hero.append(
    el('div', { class: 'dh-grid' }, picker, spotlight),
    el('div', { class: 'dh-progress' },
      el('div', { class: 'dh-progress-fill', style: `width: ${pct.toFixed(1)}%` }),
      el('div', { class: 'dh-progress-label' }, `${d.current_overall - 1} / ${totalPicks} 順位已完成`),
    ),
  );
  return hero;
}

function buildClockPanel(d) {
  // Kept for back-compat; new pages should use buildDraftHero instead.
  return buildDraftHero(d);
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
    'aria-label': '選秀顯示模式',
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
        el('table', { class: 'data players-table responsive', id: 'tbl-available', 'aria-label': '剩餘球員列表' }),
      ),
    ),
  );
  return panel;
}

async function onDraftDisplayModeChange(e) {
  const newMode = e.target.value;
  state.draftDisplayMode = newMode;
  renderAvailableTable(newMode);
  // Persist delta only — server rejects full payloads once setup_complete=true
  // because they contain immutable fields like roster_size/num_teams.
  try {
    await api('/api/league/settings', {
      method: 'POST',
      body: JSON.stringify({ draft_display_mode: newMode }),
    });
    if (state.leagueSettings) state.leagueSettings.draft_display_mode = newMode;
  } catch (err) {
    console.warn('save draft_display_mode failed', err);
  }
}

function buildBoardPanel(d) {
  const head = el('div', { class: 'panel-head' }, el('h2', {}, '蛇形選秀板'));
  if (!d.is_complete) {
    head.append(el('button', {
      type: 'button', class: 'btn ghost small', id: 'btn-jump-current-pick',
      onclick: jumpToCurrentPick,
    }, '跳到目前回合 ↓'));
    head.append(el('button', {
      type: 'button', class: 'btn ghost small', id: 'btn-jump-my-next',
      onclick: jumpToMyNextPick,
      title: '捲動到你隊伍下一個尚未選走的順位',
    }, '跳至我的下次 →'));
  }
  const panel = el('div', { class: 'panel' },
    head,
    el('div', { class: 'board-wrap' }, buildBoardTable(d)),
  );
  return panel;
}

function jumpToMyNextPick() {
  const cells = document.querySelectorAll('table.board td.you-cell.empty');
  if (!cells.length) {
    toast('你已無剩餘選秀順位', 'info');
    return;
  }
  const target = cells[0];
  target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  target.classList.add('pulse-highlight');
  setTimeout(() => target.classList.remove('pulse-highlight'), 1500);
}

function jumpToCurrentPick() {
  const cur = document.querySelector('table.board td.current');
  if (!cur) return;
  cur.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  cur.classList.add('pulse-highlight');
  setTimeout(() => cur.classList.remove('pulse-highlight'), 1500);
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
      'aria-label': '搜尋球員姓名或球隊',
      oninput: (e) => { f.q = e.target.value; onChange(); },
    }),
    el('select', {
      'aria-label': '依位置篩選',
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
      'aria-label': '排序欄位',
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
  // Note: draft button clicks handled by document-level delegation in
  // bindGlobalUI(). Do not attach a per-table listener here to avoid
  // double-firing onDraftPlayer.
}

function injuryBadgeHtml(inj) {
  if (!inj || inj.status === 'healthy') return '';
  const cls = inj.status === 'out' ? 'inj-out' : 'inj-dtd';
  const label = inj.status === 'out' ? 'OUT' : 'DTD';
  const desc = inj.status === 'out' ? '傷停（無法上場）' : 'Day-to-Day 每日觀察';
  const days = inj.return_in_days > 0 ? ` ${inj.return_in_days}d` : '';
  const daysText = inj.return_in_days > 0 ? `，預計 ${inj.return_in_days} 天後復出` : '';
  const note = inj.note ? `：${inj.note}` : '';
  const title = `${label} ${desc}${daysText}${note}`.trim();
  return ` <span class="inj-badge ${cls}" title="${escapeHtml(title)}">🏥 ${label}${days}</span>`;
}

function renderPlayersTable(players, { withDraft = false, canDraft = false, withSign = false, displayMode = 'current_full', injuries = null } = {}) {
  const isPrevFull   = displayMode === 'prev_full';
  const isPrevNoFppg = displayMode === 'prev_no_fppg';
  const showAction   = withDraft || withSign;
  const pInj = (p) => (injuries ? injuries[p.id] : null) || p.injury || null;
  // current_full: show everything as before

  let head;
  if (isPrevNoFppg) {
    // Hide FPPG only — raw counting stats remain visible.
    head = `<thead><tr>
      <th>球員</th><th>位置</th><th>球隊</th>
      <th class="num">年齡</th>
      <th class="num" title="每場得分 Points">PTS</th><th class="num" title="每場籃板 Rebounds">REB</th>
      <th class="num" title="每場助攻 Assists">AST</th><th class="num" title="每場抄截 Steals">STL</th>
      <th class="num" title="每場阻攻 Blocks">BLK</th><th class="num" title="每場失誤 Turnovers">TO</th>
      <th class="num" title="出賽場次 Games Played">出賽</th>
      ${showAction ? '<th></th>' : ''}
    </tr></thead>`;
  } else if (isPrevFull) {
    // Show prev_fppg (labeled 上季FPPG) instead of live stats
    head = `<thead><tr>
      <th>球員</th><th>位置</th><th>球隊</th>
      <th class="num">年齡</th>
      <th class="num" title="上季每場幻想分數（加權綜合指標）">上季FPPG</th>
      <th class="num" title="上季出賽場次">出賽</th>
      ${showAction ? '<th></th>' : ''}
    </tr></thead>`;
  } else {
    // current_full: original columns
    head = `<thead><tr>
      <th>球員</th><th>位置</th><th>球隊</th>
      <th class="num">年齡</th>
      <th class="num" title="Fantasy Points Per Game：每場幻想分數，綜合 PTS+REB+AST+STL+BLK 加權扣除 TO">FPPG</th>
      <th class="num" title="每場得分 Points">PTS</th><th class="num" title="每場籃板 Rebounds">REB</th>
      <th class="num" title="每場助攻 Assists">AST</th><th class="num" title="每場抄截 Steals">STL</th>
      <th class="num" title="每場阻攻 Blocks">BLK</th><th class="num" title="每場失誤 Turnovers">TO</th>
      <th class="num" title="出賽場次 Games Played">出賽</th>
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
        <td class="name">${escapeHtml(p.name)}${injuryBadgeHtml(pInj(p))}</td>
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
        <td class="name">${escapeHtml(p.name)}${injuryBadgeHtml(pInj(p))}</td>
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
        <td class="name">${escapeHtml(p.name)}${injuryBadgeHtml(pInj(p))}</td>
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
  const { team, players, totals, persona_desc, lineup_slots, bench, injured_out, injuries, has_lineup_override } = data;
  const playerById = new Map(players.map((p) => [p.id, p]));
  const injSet = new Set(injured_out || []);
  const injuriesMap = injuries || {};
  const isHuman = !!team.is_human;

  const slotRows = (lineup_slots || []).map((s, idx) => {
    const p = s.player_id != null ? playerById.get(s.player_id) : null;
    const injured = p && injSet.has(p.id);
    const injBadge = p ? injuryBadgeHtml(injuriesMap[p.id]) : '';
    const changeBtn = isHuman
      ? `<td class="slot-change"><button class="btn small ghost lineup-change-btn" data-slot-idx="${idx}" data-slot="${s.slot}" data-current="${s.player_id ?? ''}">換</button></td>`
      : '';
    return `<tr class="slot-row${injured ? ' injured' : ''}">
      <td class="slot-label"><span class="slot-badge slot-${s.slot}">${s.slot}</span></td>
      ${p
        ? `<td class="slot-name">${escapeHtml(p.name)}${injBadge}</td>
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
         <div class="table-wrap"><table class="data players-table responsive">${renderPlayersTable(benchPlayers, { injuries: injuriesMap })}</table></div>`
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
        el('label', { class: 'today-only-label', style: 'display:flex;align-items:center;gap:6px;font-size:0.85rem;' },
          el('input', { type: 'checkbox', id: 'chk-today-only' }),
          '僅今日鎖定',
        ),
        el('button', { class: 'btn ghost', id: 'btn-auto-lineup', title: '依 FPPG 自動挑選健康球員' }, '一鍵最佳'),
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

  $('#btn-auto-lineup').addEventListener('click', () => {
    const healthy = players
      .filter(p => !injSet.has(p.id))
      .sort((a, b) => (b.fppg || 0) - (a.fppg || 0))
      .slice(0, targetCount)
      .map(p => p.id);
    selected = new Set(healthy);
    const tbody = modal.querySelector('#lineup-full-tbl tbody');
    if (tbody) tbody.innerHTML = renderRows();
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
    refreshCount();
    toast(`已套用 FPPG 最佳陣容（${selected.size} 人）`, 'success');
  });

  $('#btn-save-lineup').addEventListener('click', async () => {
    if (selected.size !== targetCount) {
      alert(`請選滿 ${targetCount} 名先發球員（目前 ${selected.size} 人）`);
      return;
    }
    const todayOnly = !!document.getElementById('chk-today-only')?.checked;
    modal.remove();
    await _saveLineupOverride(team.id, [...selected], todayOnly);
  });
}

async function _saveLineupOverride(teamId, starters, todayOnly = false) {
  try {
    await api('/api/season/lineup', {
      method: 'POST',
      body: JSON.stringify({ team_id: teamId, starters, today_only: todayOnly }),
    });
    renderTeamBody();
  } catch (e) {
    const msg = e.message || '儲存失敗';
    toast(msg.includes('無法填滿') ? msg : '陣容儲存失敗：' + msg, 'error', 6000);
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
        el('div', { class: 'fa-toggles' },
          el('label', { class: 'fa-toggle-item' },
            el('input', {
              type: 'checkbox',
              checked: state.faFilter.excludeInjured ? true : null,
              onchange: (e) => {
                state.faFilter.excludeInjured = !!e.target.checked;
                renderFaTable();
              },
            }),
            el('span', {}, '隱藏傷兵（OUT/DTD）'),
          ),
        ),
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
  // Default to hiding injured FAs so typical pickup search stays clean.
  if (state.faFilter.excludeInjured) params.set('exclude_injured', 'true');

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
    .map((p, i) => `<label class="drop-row${i === 0 ? ' suggested' : ''}"><input type="radio" name="drop-pid" value="${p.id}"${i === 0 ? ' checked' : ''}> <span class="pn">${escapeHtml(p.name)}</span> <span class="ppos">${escapeHtml(p.pos || '')}</span> <span class="pfp muted">FPPG ${(p.fppg ?? 0).toFixed(1)}</span>${i === 0 ? ' <span class="drop-suggest-tag">建議</span>' : ''}</label>`)
    .join('');

  const body = `
    <div class="sign-dialog-body">
      <div class="sign-add">簽入：<strong>${escapeHtml(addPlayer.name)}</strong> <span class="muted">${escapeHtml(addPlayer.pos || '')} · FPPG ${(addPlayer.fppg ?? 0).toFixed(1)}</span></div>
      <div class="sign-hint">選擇一名要釋出的球員（已預選 FPPG 最低者）：</div>
      <div class="sign-drop-list">${rows}</div>
    </div>
  `;
  const dropId = await pickDropDialog(body);
  if (dropId == null) return;

  await once(`fa-claim:${addPlayerId}`, () => mutate(async () => {
    const r = await api('/api/fa/claim', {
      method: 'POST',
      body: JSON.stringify({ add_player_id: addPlayerId, drop_player_id: dropId }),
    });
    toast(`✅ 簽入 ${r.add},釋出 ${r.drop}（今日剩餘 ${r.remaining}）`, 'success');
    await refreshState();
    await refreshFaQuota();
    await renderFaTable();
  }));
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

  // state.season is null when /api/season/standings returns the default shell
  // (no rows) — i.e. the backend has no started season yet. state.standings is
  // always an object, so checking !state.standings never fires.
  if (!state.season) {
    root.append(
      el('div', { class: 'panel' },
        el('div', { class: 'panel-head' },
          el('h2', {}, '賽季'),
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
          '確認選秀後將建立例行賽 + 季後賽。AI 隊伍使用啟發式策略或 Claude（需設定 API 金鑰）。',
          el('button', { class: 'btn primary', onclick: onSeasonStart }, '開始賽季'),
        ),
      ),
    );
    return;
  }

  // Yahoo-style structure: hero banner + control bar + sub-tabs + sub-content.
  root.append(buildLeagueHero());
  root.append(buildLeagueControlBar());
  root.append(buildLeagueSubTabs());

  const sub = el('div', { class: 'league-subcontent' });
  root.append(sub);
  renderLeagueSubContent(sub);
}

function buildLeagueHero() {
  const st = state.standings || {};
  const settings = state.leagueSettings || DEFAULT_SETTINGS;
  const leagueName = settings.league_name || '我的聯盟';
  const seasonYear = settings.season_year || '';
  const currentWeek = st.current_week || 1;
  const regWeeks = st.regular_weeks || settings.regular_season_weeks || 20;
  const isPlayoffs = !!st.is_playoffs;
  const champion = st.champion;

  // Find user standing
  const rows = Array.isArray(st.standings) ? st.standings : [];
  const humanId = state.draft?.human_team_id;
  const userIdx = rows.findIndex((r) => r.is_human || r.team_id === humanId);
  const userRow = userIdx >= 0 ? rows[userIdx] : null;

  const phaseLabel = champion != null
    ? '🏆 賽季結束'
    : isPlayoffs
      ? `季後賽 · 第 ${currentWeek} 週`
      : `例行賽 · 第 ${currentWeek} / ${regWeeks} 週`;

  const userBlock = userRow
    ? el('div', { class: 'hero-user' },
        el('span', { class: 'hero-user-label' }, '你的排名'),
        el('span', { class: `hero-user-rank rank-${userIdx + 1}` }, `#${userIdx + 1}`),
        el('span', { class: 'hero-user-record' }, `${userRow.w ?? 0}-${userRow.l ?? 0}`),
      )
    : null;

  return el('div', { class: 'league-hero' },
    el('div', { class: 'hero-main' },
      el('div', { class: 'hero-title-wrap' },
        el('div', { class: 'hero-league-name' }, leagueName),
        el('div', { class: 'hero-sub' },
          seasonYear ? el('span', { class: 'hero-year' }, seasonYear) : null,
          el('span', { class: 'hero-phase' }, phaseLabel),
        ),
      ),
      userBlock,
    ),
  );
}

function buildLeagueControlBar() {
  const pendingCount = state.standings?.pending_count ?? 0;
  const champion = state.standings?.champion;
  const isPlayoffs = !!state.standings?.is_playoffs;
  // Regular season finished but playoff bracket not yet played. Daily/weekly
  // advance endpoints are no-ops here, so we must redirect the user to the
  // bracket sim instead of leaving them stranded on dead buttons.
  const awaitingBracket = isPlayoffs && champion == null;
  const deadTitle = awaitingBracket ? '例行賽已結束，請開打季後賽' : null;
  return el('div', { class: 'panel league-controls' },
    el('div', { class: 'panel-head' },
      el('div', { class: 'actions' },
        el('button', { class: 'btn ghost', onclick: onAdvanceDay, disabled: awaitingBracket || champion != null, title: deadTitle }, '推進一天'),
        el('button', { class: 'btn ghost', onclick: onAdvanceWeek, disabled: awaitingBracket || champion != null, title: deadTitle }, '推進一週'),
        el('button', { class: 'btn ghost', onclick: () => { const w = completedWeekNumber(); if (w >= 1) onShowWeekRecap(w); else toast('尚無已完成週次', 'info'); } }, '📅 週報'),
        el('button', {
          id: 'btn-propose-trade',
          class: 'btn ghost',
          onclick: openProposeTradeDialog,
        }, pendingCount
          ? ['發起交易', el('span', { class: 'btn-badge' }, String(pendingCount))]
          : '發起交易'),
        awaitingBracket
          ? el('button', { class: 'btn primary', onclick: onSimPlayoffs }, '🏆 開打季後賽')
          : (champion == null
              ? el('button', { class: 'btn', onclick: onSimToPlayoffs }, '模擬到季後賽')
              : null),
        champion != null
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
}

function buildLeagueSubTabs() {
  const pendingCount = state.standings?.pending_count ?? 0;
  const humanId = state.draft?.human_team_id ?? 0;
  const myPendingTrades = (state.tradesHistory || []).filter(
    (t) => (t.from_team === humanId || t.to_team === humanId) &&
      (t.status === 'pending_accept' || t.status === 'accepted')
  ).length;
  const active = state.leagueSubTab || 'matchup';
  const tabs = [
    { id: 'matchup',    label: '對戰', badge: pendingCount > 0 ? pendingCount : null },
    { id: 'standings',  label: '戰績' },
    { id: 'management', label: '聯盟' },
    { id: 'trades',     label: '交易', badge: myPendingTrades > 0 ? myPendingTrades : null },
    { id: 'activity',   label: '動態' },
  ];
  const wrap = el('div', { class: 'league-tabs', role: 'tablist' });
  for (const t of tabs) {
    const btn = el('button', {
      type: 'button',
      class: `league-tab ${active === t.id ? 'active' : ''}`,
      role: 'tab',
      'aria-selected': active === t.id ? 'true' : 'false',
      onclick: () => { state.leagueSubTab = t.id; render(); },
    },
      el('span', { class: 'lt-label' }, t.label),
      t.badge ? el('span', { class: 'lt-badge' }, String(t.badge)) : null,
    );
    wrap.append(btn);
  }
  return wrap;
}

function renderLeagueSubContent(container) {
  const tab = state.leagueSubTab || 'matchup';
  switch (tab) {
    case 'matchup':    renderMatchupSubtab(container); break;
    case 'standings':  renderStandingsSubtab(container); break;
    case 'management': renderManagementSubtab(container); break;
    case 'trades':     renderTradesSubtab(container); break;
    case 'activity':   renderActivitySubtab(container); break;
    default:           renderMatchupSubtab(container);
  }
}

// -------- Sub-tab: 交易 --------
function renderTradesSubtab(container) {
  const humanId = state.draft?.human_team_id ?? 0;
  const filter = state.tradesSubtabFilter || 'all';

  const head = el('div', { class: 'panel-head' },
    el('h2', {}, '我的交易'),
    el('button', {
      type: 'button',
      class: 'btn primary small',
      onclick: () => openProposeTradeModal(),
    }, '發起交易'),
  );

  const chipDefs = [
    { id: 'all',     label: '全部' },
    { id: 'pending', label: '待處理' },
    { id: 'done',    label: '已完成' },
    { id: 'other',   label: '拒絕/過期' },
  ];
  const chips = el('div', { class: 'trade-filter-chips' });
  for (const c of chipDefs) {
    chips.append(el('button', {
      type: 'button',
      class: `chip ${filter === c.id ? 'active' : ''}`,
      onclick: () => { state.tradesSubtabFilter = c.id; render(); },
    }, c.label));
  }

  const body = el('div', { class: 'panel-body', id: 'my-trades-body' },
    el('div', { class: 'empty-state' }, '載入中...'),
  );

  const panel = el('div', { class: 'panel', id: 'panel-my-trades' }, head, chips, body);
  container.append(panel);

  // Kick off history fetch; render filtered list on completion.
  (async () => {
    try {
      await refreshTradeHistoryRaw();
    } catch (_) {}
    renderMyTradesBody(body);
  })();
}

function renderMyTradesBody(body) {
  const humanId = state.draft?.human_team_id ?? 0;
  const filter = state.tradesSubtabFilter || 'all';
  let mine = (state.tradesHistory || []).filter(
    (t) => t.from_team === humanId || t.to_team === humanId,
  );
  if (filter === 'pending') {
    mine = mine.filter((t) => t.status === 'pending_accept' || t.status === 'accepted');
  } else if (filter === 'done') {
    mine = mine.filter((t) => t.status === 'executed');
  } else if (filter === 'other') {
    mine = mine.filter((t) =>
      ['rejected','vetoed','expired','countered'].includes(t.status),
    );
  }
  body.innerHTML = '';
  if (!mine.length) {
    body.append(el('div', { class: 'empty-state' },
      filter === 'all' ? '你還沒有交易紀錄。點上方「發起交易」開始。' : '此分類目前為空。'));
    return;
  }
  const list = el('div', { class: 'my-trades-list' });
  for (const t of mine) {
    list.append(buildMyTradeCard(t, humanId));
  }
  body.append(list);
}

function buildMyTradeCard(trade, humanId) {
  const fromName = teamName(trade.from_team) || `隊伍 ${trade.from_team}`;
  const toName = teamName(trade.to_team) || `隊伍 ${trade.to_team}`;
  const outgoing = trade.from_team === humanId;
  const direction = outgoing ? `→ ${toName}` : `← ${fromName}`;
  const week = trade.proposed_week ?? '?';
  const day = trade.executed_day ?? trade.proposed_day ?? '?';
  const sendPlayers = (trade.send_player_ids || []).map((id) => state.playerCache.get(id)).filter(Boolean);
  const recvPlayers = (trade.receive_player_ids || []).map((id) => state.playerCache.get(id)).filter(Boolean);
  const statusMap = {
    'pending_accept': '等待回應',
    'accepted': '否決期',
    'vetoed': '已否決',
    'executed': '已完成',
    'rejected': '已拒絕',
    'expired': '已過期',
    'countered': '已還價',
  };
  const statusLabel = statusMap[trade.status] || trade.status;

  const card = el('div', { class: `my-trade-card status-${trade.status}` });
  card.append(el('div', { class: 'mt-head' },
    el('span', { class: 'mt-when' }, `W${week} D${day}`),
    el('span', { class: 'mt-direction' }, outgoing ? `你 ${direction}` : `${direction} 給你`),
    el('span', { class: `trade-status trade-status-${trade.status}` }, statusLabel),
  ));

  const cols = el('div', { class: 'mt-cols' },
    el('div', { class: 'mt-col' },
      el('div', { class: 'mt-col-head' }, `${fromName} 送出`),
      el('ul', { class: 'mt-players' }, ...sendPlayers.map((p) =>
        el('li', {}, `${p.name} (${fppg(p.fppg)})`))),
    ),
    el('div', { class: 'mt-col' },
      el('div', { class: 'mt-col-head' }, `${toName} 送出`),
      el('ul', { class: 'mt-players' }, ...recvPlayers.map((p) =>
        el('li', {}, `${p.name} (${fppg(p.fppg)})`))),
    ),
  );
  card.append(cols);

  if (trade.reasoning && trade.reasoning !== 'human') {
    const reason = String(trade.reasoning).replace(/^human\s*｜\s*/, '');
    card.append(el('div', { class: 'trade-reasoning hist' }, reason));
  }

  const thread = buildTradeThread(trade);
  if (thread) card.append(thread);

  const actions = buildTradeActions(trade);
  if (actions) card.append(actions);

  return card;
}

// Non-DOM-mutating version of refreshTradeHistory used by the trades sub-tab
// (the existing one targets #trade-history-body which only exists on 動態).
async function refreshTradeHistoryRaw() {
  try {
    const res = await fetch('/api/trades/history');
    if (!res.ok) return;
    const d = await res.json();
    const hist = d.history || [];
    hist.sort((a, b) => {
      const weekA = a.proposed_week ?? 0;
      const weekB = b.proposed_week ?? 0;
      const dayA  = a.executed_day ?? a.proposed_day ?? 0;
      const dayB  = b.executed_day ?? b.proposed_day ?? 0;
      return (weekB * 1000 + dayB) - (weekA * 1000 + dayA);
    });
    state.tradesHistory = hist;
  } catch (_) {}
}

function openProposeTradeModal() {
  const btn = document.querySelector('#btn-propose-trade')
    || Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent.trim() === '發起交易');
  if (btn) btn.click();
}

// -------- Sub-tab: 對戰 --------
function rerenderMatchupSubtab(container) {
  container.innerHTML = '';
  renderMatchupSubtab(container);
}

function renderMatchupSubtab(container) {
  container.append(buildCalendarPanel(state.standings));

  const currentWk = currentWeekNumber() || 1;
  // Remember which week the user chose so switching tabs / refreshes retain it.
  if (state.matchupViewWeek == null) state.matchupViewWeek = currentWk;
  const week = Math.max(1, state.matchupViewWeek);
  const regularWeeks = state.standings?.regular_weeks || 14;
  const maxWeek = Math.max(currentWk, regularWeeks);
  const allMatchups = matchupsForWeek(week);
  const humanId = state.draft?.human_team_id;
  const userMatchup = allMatchups.find(
    (m) => (m.team_a ?? m.home_team_id) === humanId
        || (m.team_b ?? m.away_team_id) === humanId,
  );
  const otherMatchups = allMatchups.filter((m) => m !== userMatchup);

  // Week navigation header — prev / current-jump / next.
  const weekLabel = week > regularWeeks ? `季後賽 W${week}` : `第 ${week} 週`;
  const navPanel = el('div', { class: 'panel matchup-week-nav' },
    el('div', { class: 'mwn-row' },
      el('button', {
        type: 'button', class: 'btn small ghost',
        disabled: week <= 1,
        onclick: () => { state.matchupViewWeek = week - 1; rerenderMatchupSubtab(container); },
      }, '◀ 上週'),
      el('span', { class: 'mwn-label' },
        weekLabel,
        week === currentWk ? el('span', { class: 'pill success' }, '本週') : null,
      ),
      el('button', {
        type: 'button', class: 'btn small ghost',
        disabled: week >= maxWeek,
        onclick: () => { state.matchupViewWeek = week + 1; rerenderMatchupSubtab(container); },
      }, '下週 ▶'),
    ),
    week !== currentWk
      ? el('button', {
          type: 'button', class: 'btn small link-btn',
          onclick: () => { state.matchupViewWeek = currentWk; rerenderMatchupSubtab(container); },
        }, `回到本週（第 ${currentWk} 週）`)
      : null,
  );
  container.append(navPanel);

  if (userMatchup) {
    container.append(buildHeroMatchupCard(userMatchup, week, humanId));
  }

  if (otherMatchups.length) {
    const scoreboard = el('div', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', {}, '同週其他對戰')),
      el('div', { class: 'panel-body tight' }),
    );
    const body = scoreboard.querySelector('.panel-body');
    for (const m of otherMatchups) body.append(buildMatchupCard(m));
    container.append(scoreboard);
  } else if (!userMatchup) {
    container.append(
      el('div', { class: 'panel' },
        el('div', { class: 'panel-head' }, el('h2', {}, `${weekLabel}對戰`)),
        el('div', { class: 'panel-body' }, el('div', { class: 'empty-state' }, '本週尚無對戰資料。')),
      ),
    );
  }

  // Pending trades (high-visibility on matchup tab)
  const tradesPanel = el('div', { class: 'panel', id: 'panel-trades' },
    el('div', { class: 'panel-head' },
      el('h2', {}, '待處理交易'),
      el('div', { id: 'trade-quota-badge', class: 'trade-quota-wrap' }),
    ),
    el('div', { class: 'panel-body', id: 'trade-pending-body' },
      el('div', { class: 'empty-state' }, '載入交易中...'),
    ),
  );
  container.append(tradesPanel);
  refreshTrades();
}

function buildHeroMatchupCard(m, week, humanId) {
  const teamA = m.team_a ?? m.home_team_id;
  const teamB = m.team_b ?? m.away_team_id;
  const scoreA = m.score_a ?? m.home_score ?? m.home_points;
  const scoreB = m.score_b ?? m.away_score ?? m.away_points;
  const played = m.complete || m.played || m.final || (scoreA != null && scoreB != null);
  const winnerId = m.winner;

  const isAUser = teamA === humanId;
  const userTid = isAUser ? teamA : teamB;
  const oppTid = isAUser ? teamB : teamA;
  const userScore = isAUser ? scoreA : scoreB;
  const oppScore = isAUser ? scoreB : scoreA;
  const userName = teamName(userTid) || `隊伍 ${userTid}`;
  const oppName = teamName(oppTid) || `隊伍 ${oppTid}`;

  let statusLabel;
  let statusClass = 'upcoming';
  if (played) {
    if (winnerId === userTid) { statusLabel = '勝'; statusClass = 'won'; }
    else if (winnerId === oppTid) { statusLabel = '敗'; statusClass = 'lost'; }
    else { statusLabel = '平'; statusClass = 'tie'; }
  } else {
    statusLabel = '本週進行中';
  }

  return el('div', { class: `panel hero-matchup-panel status-${statusClass}`, onclick: () => openMatchupDialog(week, m) },
    el('div', { class: 'hero-matchup-head' },
      el('span', { class: 'hmh-label' }, `第 ${week} 週 你的對戰`),
      el('span', { class: `hmh-status status-${statusClass}` }, statusLabel),
    ),
    el('div', { class: 'hero-matchup-body' },
      el('div', { class: 'hm-side user' },
        el('div', { class: 'hm-tag' }, '你'),
        el('div', { class: 'hm-name' }, userName),
        el('div', { class: 'hm-score' }, played ? fmtStat(userScore) : '—'),
      ),
      el('div', { class: 'hm-vs' }, 'VS'),
      el('div', { class: 'hm-side opp' },
        el('div', { class: 'hm-tag' }, '對手'),
        el('div', { class: 'hm-name' }, oppName),
        el('div', { class: 'hm-score' }, played ? fmtStat(oppScore) : '—'),
      ),
    ),
  );
}

// -------- Sub-tab: 戰績 --------
function renderStandingsSubtab(container) {
  container.append(buildEnhancedStandingsPanel());
}

// -------- Sub-tab: 聯盟 (Management) --------
function renderManagementSubtab(container) {
  container.append(buildLeagueInfoPanel());
  container.append(buildScoringWeightsPanel());
  container.append(buildInjuryReportPanel());
  container.append(buildMilestonesPanel());
  container.append(buildTeamsOverviewPanel());
  container.append(buildTradeSettingsPanel());
}

function buildInjuryReportPanel() {
  const panel = el('div', { class: 'panel', id: 'panel-injuries' },
    el('div', { class: 'panel-head' },
      el('h2', {}, '🏥 傷兵名單'),
      el('span', { class: 'badge', id: 'injury-count-badge' }, '—'),
    ),
    el('div', { class: 'panel-body', id: 'injury-report-body' },
      el('div', { class: 'empty-state' }, '載入中…'),
    ),
  );
  // Fire & forget; will repaint when data arrives.
  loadInjuryReport(panel).catch(() => {
    const body = panel.querySelector('#injury-report-body');
    if (body) { body.innerHTML = ''; body.append(el('div', { class: 'empty-state' }, '讀取傷兵資料失敗')); }
  });
  return panel;
}

async function loadInjuryReport(panel) {
  const body = panel.querySelector('#injury-report-body');
  const badge = panel.querySelector('#injury-count-badge');
  const [active, history] = await Promise.all([
    apiSoft('/api/injuries/active'),
    apiSoft('/api/injuries/history?limit=30'),
  ]);
  body.innerHTML = '';

  const actList = (active && active.active) || [];
  const hist    = (history && history.history) || [];
  badge.textContent = actList.length ? `${actList.length} 人` : '0';

  if (!actList.length) {
    body.append(el('div', { class: 'empty-state' }, '目前沒有傷兵'));
  } else {
    const tbl = el('table', { class: 'data injury-table' });
    tbl.innerHTML = `
      <thead><tr>
        <th>球員</th><th>NBA</th><th>隊伍</th><th>狀態</th>
        <th class="num">返場</th><th>說明</th>
      </tr></thead>
      <tbody>${actList.map((i) => {
        const status = i.status === 'out' ? '<span class="pill danger" title="傷停，無法上場">🏥 OUT</span>'
                    : i.status === 'day_to_day' ? '<span class="pill warn" title="Day-to-Day 每日觀察">🤕 DTD</span>'
                    : '<span class="pill">?</span>';
        return `<tr>
          <td>${escapeHtml(i.player_name || `#${i.player_id}`)}</td>
          <td>${escapeHtml(i.nba_team || '')}</td>
          <td>${escapeHtml(i.fantasy_team_name || '自由球員')}</td>
          <td>${status}</td>
          <td class="num">${i.return_in_days} 天</td>
          <td>${escapeHtml(i.note || '')}</td>
        </tr>`;
      }).join('')}</tbody>`;
    body.append(tbl);
  }

  if (hist.length) {
    const recent = hist.slice().reverse().slice(0, 10);
    body.append(el('div', { class: 'injury-history-head' }, `近期傷病紀錄（共 ${hist.length} 筆）`));
    const hl = el('ul', { class: 'injury-history-list' });
    for (const h of recent) {
      const tag = h.status === 'healthy' ? '💪 康復' : (h.status === 'out' ? '🏥 傷退' : '🤕 DTD');
      hl.append(el('li', {},
        el('span', { class: 'ih-tag' }, tag),
        el('span', { class: 'ih-name' }, ` ${h.player_name || '#' + h.player_id} `),
        el('span', { class: 'ih-note muted' }, h.note || ''),
      ));
    }
    body.append(hl);
  }
}

function buildScoringWeightsPanel() {
  const s = state.leagueSettings || DEFAULT_SETTINGS;
  const w = s.scoring_weights || { pts: 1.0, reb: 1.2, ast: 1.5, stl: 2.5, blk: 2.5, to: -1.0 };
  const items = [
    ['得分 PTS',  w.pts, 'pos'],
    ['籃板 REB',  w.reb, 'pos'],
    ['助攻 AST',  w.ast, 'pos'],
    ['抄截 STL',  w.stl, 'pos'],
    ['阻攻 BLK',  w.blk, 'pos'],
    ['失誤 TO',   w.to,  (w.to < 0 ? 'neg' : 'pos')],
  ];
  const grid = el('div', { class: 'info-grid scoring-weights-grid' });
  for (const [label, val, tone] of items) {
    grid.append(el('div', { class: `info-item weight-${tone}` },
      el('div', { class: 'info-label' }, label),
      el('div', { class: 'info-value' }, (val >= 0 ? '+' : '') + Number(val).toFixed(1)),
    ));
  }
  return el('div', { class: 'panel' },
    el('div', { class: 'panel-head' },
      el('h2', {}, '計分權重'),
      el('button', {
        type: 'button',
        class: 'btn ghost small',
        onclick: openLeagueSettings,
      }, '調整'),
    ),
    el('div', { class: 'panel-body' }, grid),
  );
}

// -------- Sub-tab: 動態 --------
function renderActivitySubtab(container) {
  const FILTERS = [
    ['all', '全部'],
    ['trade', '🔄 交易'],
    ['fa', '📝 自由市場'],
    ['injury', '🏥 傷病'],
    ['milestone', '🌟 里程碑'],
  ];
  const chips = el('div', { class: 'activity-filter-chips', role: 'tablist', 'aria-label': '動態類別篩選' });
  for (const [key, label] of FILTERS) {
    chips.append(el('button', {
      type: 'button',
      class: `chip ${state.activityFilter === key ? 'active' : ''}`,
      role: 'tab',
      'aria-selected': state.activityFilter === key ? 'true' : 'false',
      onclick: () => {
        state.activityFilter = key;
        chips.querySelectorAll('.chip').forEach((b) => {
          const isActive = b.dataset.key === key;
          b.classList.toggle('active', isActive);
          b.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        renderActivityTicker();
      },
      'data-key': key,
    }, label));
  }
  const activityPanel = el('div', { class: 'panel activity-ticker', id: 'panel-activity' },
    el('div', { class: 'panel-head' },
      el('h2', {}, '📋 動態消息'),
      chips,
    ),
    el('div', { class: 'activity-ticker-body', id: 'activity-ticker-body' },
      el('div', { class: 'empty-state' }, '載入中...'),
    ),
  );
  container.append(activityPanel);

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
  container.append(historyPanel);

  renderActivityTicker();
  if (state.tradeHistoryOpen) refreshTradeHistory();
}

// -------- Streak / last-5 computation (client-side) --------
function computeTeamRecords() {
  const out = new Map();
  const tids = (state.draft?.teams || []).map((t) => t.id);
  for (const tid of tids) out.set(tid, { results: [], streak: null, last5: { w: 0, l: 0 } });

  const games = scheduleList()
    .filter((m) => (m.complete || m.played || m.final) && m.winner != null)
    .sort((a, b) => (a.week ?? 0) - (b.week ?? 0));

  for (const m of games) {
    const tA = m.team_a ?? m.home_team_id;
    const tB = m.team_b ?? m.away_team_id;
    const wkA = m.winner === tA;
    const wkB = m.winner === tB;
    if (out.has(tA)) out.get(tA).results.push(wkA ? 'W' : 'L');
    if (out.has(tB)) out.get(tB).results.push(wkB ? 'W' : 'L');
  }

  for (const [, rec] of out) {
    const r = rec.results;
    if (r.length) {
      const last = r[r.length - 1];
      let count = 0;
      for (let i = r.length - 1; i >= 0 && r[i] === last; i--) count++;
      rec.streak = `${last}${count}`;
    }
    const tail = r.slice(-5);
    rec.last5 = { w: tail.filter((x) => x === 'W').length, l: tail.filter((x) => x === 'L').length };
  }
  return out;
}

// -------- Enhanced Yahoo-style standings --------
function buildEnhancedStandingsPanel() {
  const settings = state.leagueSettings || DEFAULT_SETTINGS;
  const playoffTeams = settings.playoff_teams || 6;
  const panel = el('div', { class: 'panel' },
    el('div', { class: 'panel-head' }, el('h2', {}, '戰績排名')),
    el('div', { class: 'table-wrap' }),
  );
  const wrap = panel.querySelector('.table-wrap');

  const rows = Array.isArray(state.standings) ? state.standings : (state.standings?.standings || []);
  if (!rows.length) {
    wrap.append(el('div', { class: 'empty-state' }, '尚無戰績。'));
    return panel;
  }

  const records = computeTeamRecords();
  const leader = rows[0];
  const leaderDiff = (r) => {
    const lw = leader.w ?? 0; const ll = leader.l ?? 0;
    const rw = r.w ?? 0; const rl = r.l ?? 0;
    const gb = ((lw - rw) + (rl - ll)) / 2;
    return gb;
  };

  const tbl = el('table', { class: 'data standings-enhanced' });
  const humanId = state.draft?.human_team_id;
  tbl.innerHTML = `
    <thead><tr>
      <th>#</th><th>隊伍</th>
      <th class="num">勝-敗</th>
      <th class="num">勝率</th>
      <th class="num">GB</th>
      <th>連勝</th>
      <th>近5</th>
      <th class="num">得分</th>
      <th class="num">失分</th>
    </tr></thead>
    <tbody>${rows.map((r, i) => {
      const isYou = r.is_human || r.team_id === humanId;
      const w = r.w ?? 0;
      const l = r.l ?? 0;
      const pct = (w + l) > 0 ? (w / (w + l)).toFixed(3).replace(/^0\./, '.') : '—';
      const gb = i === 0 ? '—' : leaderDiff(r).toFixed(1);
      const rec = records.get(r.team_id);
      let streakHtml = '—';
      if (rec?.streak) {
        const kind = rec.streak.startsWith('W') ? 'win' : 'lose';
        const arrow = kind === 'win' ? '↑' : '↓';
        streakHtml = `<span class="streak-badge ${kind}" title="${kind === 'win' ? '連勝' : '連敗'} ${rec.streak.slice(1)} 場">${arrow} ${rec.streak}</span>`;
      }
      const last5 = rec ? `${rec.last5.w}-${rec.last5.l}` : '—';
      const rank = r.rank ?? (i + 1);
      const rankCls = rank <= 3 ? `rank-pill top-${rank}` : 'rank-pill';
      const rowCls = ['standings-row'];
      if (isYou) rowCls.push('you');
      if (i + 1 === playoffTeams) rowCls.push('playoff-cutoff');
      return `<tr class="${rowCls.join(' ')}">
        <td><span class="${rankCls}">${rank}</span></td>
        <td class="name">${escapeHtml(r.name || `隊伍 ${r.team_id}`)}${isYou ? ' <span class="you-tag">YOU</span>' : ''}</td>
        <td class="num record">${w}-${l}</td>
        <td class="num">${pct}</td>
        <td class="num">${gb}</td>
        <td>${streakHtml}</td>
        <td class="num">${last5}</td>
        <td class="num">${fmtStat(r.pf ?? 0)}</td>
        <td class="num">${fmtStat(r.pa ?? 0)}</td>
      </tr>`;
    }).join('')}</tbody>
  `;
  wrap.append(tbl);

  // Playoff line explanation
  wrap.append(el('div', { class: 'playoff-legend' },
    el('span', { class: 'po-dot' }),
    el('span', {}, `前 ${playoffTeams} 名晉級季後賽`),
  ));

  return panel;
}

// -------- League info panel --------
function buildLeagueInfoPanel() {
  const s = state.leagueSettings || DEFAULT_SETTINGS;
  const teams = state.draft?.teams || [];
  const myTeam = teams[s.player_team_index ?? 0];
  const tradeDeadline = s.trade_deadline_week ?? Math.max(1, (s.regular_season_weeks || 20) - 3);
  const DRAFT_MODE_LABELS = {
    prev_full: '上季完整（含 FPPG）',
    prev_no_fppg: '上季完整（不含 FPPG）',
    current_full: '本季完整（劇透）',
  };
  const infoPairs = [
    ['聯盟名稱',    s.league_name || '我的聯盟'],
    ['賽季年度',    s.season_year || '—'],
    ['你的隊伍',    myTeam ? myTeam.name : `#${s.player_team_index ?? 0}`],
    ['隊伍數',      `${s.num_teams || 8}`],
    ['名單人數',    `${s.roster_size || 13} 人`],
    ['每日先發',    `${s.starters_per_day || 10} 人`],
    ['傷兵名額',    `${s.il_slots ?? 3} 格`],
    ['例行賽',      `${s.regular_season_weeks || 20} 週`],
    ['季後賽隊伍',   `${s.playoff_teams || 6} 隊`],
    ['交易截止',    `第 ${tradeDeadline} 週`],
    ['選秀順序',    s.randomize_draft_order ? '隨機排列' : '依隊伍索引'],
    ['選秀顯示',    DRAFT_MODE_LABELS[s.draft_display_mode] || s.draft_display_mode || '—'],
    ['休賽期頭條',   (s.show_offseason_headlines !== false) ? '顯示' : '隱藏'],
    ['LLM 路由',    s.use_openrouter ? 'OpenRouter（多模型）' : 'Anthropic 原生'],
  ];

  const grid = el('div', { class: 'info-grid' });
  for (const [label, value] of infoPairs) {
    grid.append(el('div', { class: 'info-item' },
      el('div', { class: 'info-label' }, label),
      el('div', { class: 'info-value' }, value),
    ));
  }

  return el('div', { class: 'panel' },
    el('div', { class: 'panel-head' },
      el('h2', {}, '聯盟資訊'),
      el('button', {
        type: 'button',
        class: 'icon-btn league-settings-btn',
        'aria-label': '聯盟設定',
        title: '編輯設定',
        onclick: openLeagueSettings,
      }, '⚙'),
    ),
    el('div', { class: 'panel-body' }, grid),
  );
}

// -------- Milestones panel --------
function buildMilestonesPanel() {
  const s = state.leagueSettings || DEFAULT_SETTINGS;
  const st = state.standings || {};
  const currentWeek = st.current_week || 1;
  const regWeeks = st.regular_weeks || s.regular_season_weeks || 20;
  const tradeDeadline = s.trade_deadline_week || Math.max(1, regWeeks - 3);
  const playoffStart = regWeeks + 1;
  const finalWeek = regWeeks + 2;

  const weeksToDeadline = tradeDeadline - currentWeek;
  const weeksToPlayoff = playoffStart - currentWeek;

  const items = [
    {
      icon: '🎯',
      label: '交易截止週',
      value: `第 ${tradeDeadline} 週`,
      sub: st.is_playoffs ? '已截止' : weeksToDeadline > 0 ? `還有 ${weeksToDeadline} 週` : weeksToDeadline === 0 ? '本週截止！' : '已截止',
      status: !st.is_playoffs && weeksToDeadline >= 0 && weeksToDeadline <= 3 ? 'warn' : (weeksToDeadline < 0 || st.is_playoffs ? 'past' : 'normal'),
    },
    {
      icon: '🏁',
      label: '例行賽結束',
      value: `第 ${regWeeks} 週`,
      sub: currentWeek > regWeeks ? '已結束' : `還有 ${regWeeks - currentWeek + 1} 週`,
      status: currentWeek > regWeeks ? 'past' : 'normal',
    },
    {
      icon: '🏆',
      label: '季後賽開始',
      value: `第 ${playoffStart} 週`,
      sub: st.is_playoffs ? '進行中' : weeksToPlayoff > 0 ? `還有 ${weeksToPlayoff} 週` : '',
      status: st.is_playoffs ? 'active' : 'normal',
    },
    {
      icon: '👑',
      label: '冠軍週',
      value: `第 ${finalWeek} 週`,
      sub: st.champion != null ? `冠軍：${teamName(st.champion) || `隊伍 ${st.champion}`}` : '',
      status: st.champion != null ? 'active' : 'normal',
    },
  ];

  const grid = el('div', { class: 'milestones-grid' });
  for (const it of items) {
    grid.append(el('div', { class: `milestone-card status-${it.status}` },
      el('div', { class: 'ms-icon' }, it.icon),
      el('div', { class: 'ms-body' },
        el('div', { class: 'ms-label' }, it.label),
        el('div', { class: 'ms-value' }, it.value),
        it.sub ? el('div', { class: 'ms-sub' }, it.sub) : null,
      ),
    ));
  }

  return el('div', { class: 'panel' },
    el('div', { class: 'panel-head' }, el('h2', {}, '賽季里程碑')),
    el('div', { class: 'panel-body' }, grid),
  );
}

// -------- Teams overview panel --------
function buildTeamsOverviewPanel() {
  const teams = state.draft?.teams || [];
  const rows = Array.isArray(state.standings) ? state.standings : (state.standings?.standings || []);
  const rankMap = new Map(rows.map((r, i) => [r.team_id, { rank: i + 1, w: r.w ?? 0, l: r.l ?? 0 }]));
  const settings = state.leagueSettings || DEFAULT_SETTINGS;
  const playoffTeams = settings.playoff_teams || 6;
  const personas = state.personas || {};

  const tbl = el('table', { class: 'data mgmt-teams' });
  const body = teams.map((t) => {
    const r = rankMap.get(t.id) || { rank: '—', w: 0, l: 0 };
    const gmType = t.is_human ? '<span class="gm-tag human">你</span>' : '<span class="gm-tag ai">AI</span>';
    const personaKey = t.gm_persona;
    const personaName = personas[personaKey]?.name || personaKey || '—';
    const inPlayoff = r.rank !== '—' && r.rank <= playoffTeams;
    const rosterCount = (t.roster || []).length;
    const statusBadge = inPlayoff
      ? '<span class="status-badge po">季後賽</span>'
      : '<span class="status-badge out">淘汰</span>';
    return `<tr class="${t.is_human ? 'you' : ''}">
      <td class="num">#${r.rank}</td>
      <td class="name">${escapeHtml(t.name)}</td>
      <td>${gmType}</td>
      <td class="persona">${escapeHtml(t.is_human ? '—' : personaName)}</td>
      <td class="num">${r.w}-${r.l}</td>
      <td class="num">${rosterCount}</td>
      <td>${statusBadge}</td>
    </tr>`;
  }).join('');
  tbl.innerHTML = `
    <thead><tr>
      <th>排名</th><th>隊伍</th><th>GM</th><th>風格</th>
      <th class="num">戰績</th><th class="num">名單</th><th>晉級</th>
    </tr></thead>
    <tbody>${body}</tbody>
  `;

  return el('div', { class: 'panel' },
    el('div', { class: 'panel-head' }, el('h2', {}, '隊伍總覽')),
    el('div', { class: 'table-wrap' }, tbl),
  );
}

// -------- Trade settings panel --------
function buildTradeSettingsPanel() {
  const s = state.leagueSettings || DEFAULT_SETTINGS;
  const st = state.standings || {};
  const quota = st.trade_quota || { executed: 0, target: 0, behind: 0 };

  const FREQ_LABELS = { very_low: '極少', low: '少', normal: '正常', high: '多', very_high: '極多' };
  const STYLE_LABELS = { conservative: '保守', balanced: '平衡', aggressive: '激進' };
  const MODE_LABELS = { auto: '自動偵測', claude: 'Claude API', heuristic: '純啟發式' };

  const pairs = [
    ['已完成交易',      `${quota.executed || 0} 筆`],
    ['本季目標',        `${quota.target || 0} 筆`],
    ['AI 交易頻率',     FREQ_LABELS[s.ai_trade_frequency] || s.ai_trade_frequency || '正常'],
    ['AI 交易風格',     STYLE_LABELS[s.ai_trade_style] || s.ai_trade_style || '平衡'],
    ['AI 決策模式',     MODE_LABELS[s.ai_decision_mode] || s.ai_decision_mode || '自動'],
    ['否決門檻',        `${s.veto_threshold ?? 3} 票`],
    ['否決窗口',        `${s.veto_window_days ?? 2} 天`],
  ];

  const grid = el('div', { class: 'info-grid' });
  for (const [label, value] of pairs) {
    grid.append(el('div', { class: 'info-item' },
      el('div', { class: 'info-label' }, label),
      el('div', { class: 'info-value' }, value),
    ));
  }

  return el('div', { class: 'panel' },
    el('div', { class: 'panel-head' },
      el('h2', {}, '交易設定'),
      el('button', {
        type: 'button',
        class: 'btn ghost small',
        onclick: openLeagueSettings,
      }, '調整'),
    ),
    el('div', { class: 'panel-body' }, grid),
  );
}

function _activityCategory(type) {
  if (!type) return 'other';
  if (type.startsWith('trade_')) return 'trade';
  if (type.startsWith('fa_')) return 'fa';
  if (type.startsWith('injury_')) return 'injury';
  if (type.startsWith('milestone_') || type === 'champion') return 'milestone';
  return 'other';
}

async function renderActivityTicker() {
  const body = document.getElementById('activity-ticker-body');
  if (!body) return;
  try {
    const data = await apiSoft('/api/season/activity?limit=50');
    let items = data?.activity || [];
    const flt = state.activityFilter || 'all';
    if (flt !== 'all') {
      items = items.filter((it) => _activityCategory(it.type) === flt);
    }
    items = items.slice(0, 20);
    if (!items.length) {
      const msg = flt === 'all' ? '暫無動態。' : '此類別暫無動態。';
      body.innerHTML = `<div class="empty-state">${msg}</div>`;
      return;
    }
    const EMOJI = {
      trade_accepted: '🔄', trade_executed: '🔄', trade_rejected: '❌',
      trade_vetoed: '🚫', fa_claim: '📝', milestone_blowout: '💥',
      milestone_nailbiter: '😅', milestone_win_streak: '🔥',
      milestone_lose_streak: '📉', milestone_top_performer: '🌟',
      injury_new: '🏥', injury_return: '💪', champion: '🏆',
    };
    const currentDay = state.standings?.current_day || 0;
    body.innerHTML = '';
    for (const item of items) {
      const emoji = EMOJI[item.type] || '•';
      const w = item.week;
      const d = item.day;
      let relText = '';
      if (typeof d === 'number' && currentDay) {
        const diff = currentDay - d;
        if (diff <= 0) relText = '剛剛';
        else if (diff === 1) relText = '昨天';
        else if (diff < 7) relText = `${diff} 天前`;
        else relText = `${Math.floor(diff / 7)} 週前`;
      } else if (w) {
        relText = `W${w}`;
      }
      const row = el('div', { class: 'activity-row' },
        el('span', { class: 'activity-emoji', 'aria-hidden': 'true' }, emoji),
        el('span', { class: 'activity-summary' }, item.summary),
        relText ? el('span', { class: 'activity-time', title: w ? `W${w} D${d ?? '-'}` : '' }, relText) : null,
      );
      body.append(row);
    }
  } catch (_) {
    // silently ignore if season not started
  }
}

function currentWeekNumber() {
  return state.standings?.current_week
      || state.schedule?.current_week
      || 1;
}

// Highest fully-completed week (day % 7 == 0 means week just finished).
// Backend keeps current_week pinned to the in-progress week even AFTER the
// week finishes, so we derive "completed" from current_day instead.
function completedWeekNumber() {
  const day = state.standings?.current_day || 0;
  return Math.floor(day / 7);
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
      body.append(buildMatchupDetail(m, { allowDrill: true }));
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
  body.append(buildMatchupDetail(m, { allowDrill: true }));
  try { dlg.showModal(); } catch { /* dialog unsupported */ }
}

function buildMatchupDetail(m, opts = {}) {
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
  if (played && opts.allowDrill && m.week != null && teamA != null && teamB != null) {
    const breakdown = el('div', { class: 'matchup-breakdown', id: `mb-${m.week}-${teamA}-${teamB}` },
      el('div', { class: 'mb-loading' }, '載入逐日數據中…'),
    );
    wrap.append(breakdown);
    loadMatchupBreakdown(m.week, teamA, teamB, breakdown).catch(() => {
      breakdown.innerHTML = '';
      breakdown.append(el('div', { class: 'empty-state' }, '讀取逐日數據失敗'));
    });
  }
  return wrap;
}

async function loadMatchupBreakdown(week, teamA, teamB, container) {
  const data = await apiSoft(`/api/season/matchup-detail?week=${week}&team_a=${teamA}&team_b=${teamB}`);
  container.innerHTML = '';
  if (!data) {
    container.append(el('div', { class: 'empty-state' }, '無法取得對戰數據'));
    return;
  }
  if (data.logs_trimmed || ((data.players_a || []).length === 0 && (data.players_b || []).length === 0)) {
    container.append(el('div', { class: 'mb-notice' }, '舊週逐日資料已清理，僅保留比分'));
    return;
  }
  container.append(buildMatchupDaysTable(data));
}

function buildMatchupDaysTable(data) {
  // Group logs by day; each day shows players from both sides with FP.
  const byDay = new Map(); // day -> { a:[], b:[] }
  for (const g of (data.players_a || [])) {
    if (!byDay.has(g.day)) byDay.set(g.day, { a: [], b: [] });
    byDay.get(g.day).a.push(g);
  }
  for (const g of (data.players_b || [])) {
    if (!byDay.has(g.day)) byDay.set(g.day, { a: [], b: [] });
    byDay.get(g.day).b.push(g);
  }
  const days = Array.from(byDay.keys()).sort((x, y) => x - y);

  const wrap = el('div', { class: 'mb-wrap' });
  const header = el('div', { class: 'mb-header' },
    el('span', { class: 'mb-team' }, escapeHtml(data.team_a_name)),
    el('span', { class: 'mb-vs' }, 'vs'),
    el('span', { class: 'mb-team' }, escapeHtml(data.team_b_name)),
  );
  wrap.append(header);

  for (const day of days) {
    const group = byDay.get(day);
    const dayFpA = group.a.reduce((s, g) => s + (g.fp || 0), 0);
    const dayFpB = group.b.reduce((s, g) => s + (g.fp || 0), 0);
    const dayBox = el('div', { class: 'mb-day' },
      el('div', { class: 'mb-day-head' },
        el('span', { class: 'mb-day-label' }, `Day ${day}`),
        el('span', { class: 'mb-day-totals' },
          `${fmtStat(dayFpA)}  —  ${fmtStat(dayFpB)}`),
      ),
      el('div', { class: 'mb-day-body' },
        buildMbSide(group.a),
        buildMbSide(group.b),
      ),
    );
    wrap.append(dayBox);
  }
  return wrap;
}

function buildMbSide(rows) {
  const side = el('div', { class: 'mb-side' });
  if (!rows.length) {
    side.append(el('div', { class: 'mb-empty' }, '—'));
    return side;
  }
  rows.sort((a, b) => (b.fp || 0) - (a.fp || 0));
  const table = el('table', { class: 'mb-statbox' });
  table.innerHTML = `
    <thead><tr>
      <th class="mb-sb-name">球員</th>
      <th>PTS</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TO</th>
      <th class="mb-sb-fp">FP</th>
    </tr></thead>
  `;
  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr', { class: r.played ? '' : 'mb-dnp' });
    if (r.played) {
      tr.innerHTML = `
        <td class="mb-sb-name">${escapeHtml(r.player_name)}</td>
        <td>${fmtStat(r.pts)}</td>
        <td>${fmtStat(r.reb)}</td>
        <td>${fmtStat(r.ast)}</td>
        <td>${fmtStat(r.stl)}</td>
        <td>${fmtStat(r.blk)}</td>
        <td>${fmtStat(r.to)}</td>
        <td class="mb-sb-fp">${fmtStat(r.fp)}</td>
      `;
    } else {
      tr.innerHTML = `
        <td class="mb-sb-name">${escapeHtml(r.player_name)}</td>
        <td colspan="7" class="mb-sb-dnp">未出賽</td>
      `;
    }
    tbody.append(tr);
  }
  table.append(tbody);
  side.append(table);
  return side;
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
    parts.push(el('div', {
      class: 'veto-vote-count',
      title: 'Veto（否決）：其他 GM 投票表決，達 3 票即撤銷交易。窗口 2 天內。',
    }, `否決票：${votes} / 3`));
  }

  // Chat thread (pending trades: both parties can negotiate)
  const thread = buildTradeThread(trade);
  if (thread) parts.push(thread);

  // Action buttons
  const actions = buildTradeActions(trade);
  if (actions) parts.push(actions);

  card.append(...parts);
  return card;
}

function buildTradeThread(trade) {
  const msgs = Array.isArray(trade.messages) ? trade.messages : [];
  const humanId = state.draft?.human_team_id ?? 0;
  const isParty = trade.from_team === humanId || trade.to_team === humanId;
  // Chat remains usable as long as the trade isn't fully finalized —
  // rejected/countered/expired trades still accept follow-up questions so
  // the user can ask "why?" or counter-propose verbally.
  const chatOpen = !['executed', 'accepted', 'vetoed'].includes(trade.status);
  if (!msgs.length && !(isParty && chatOpen)) return null;
  const wrap = el('div', { class: 'trade-thread' });
  if (msgs.length) {
    wrap.append(el('div', { class: 'tt-head' }, '訊息'));
    const list = el('div', { class: 'tt-list' });
    for (const m of msgs) {
      const mine = m.from_team === humanId;
      const name = teamName(m.from_team) || `#${m.from_team}`;
      list.append(el('div', { class: `tt-msg ${mine ? 'mine' : 'other'} ${m.kind || 'user'}` },
        el('div', { class: 'tt-meta' }, name),
        el('div', { class: 'tt-body' }, m.body || ''),
      ));
    }
    wrap.append(list);
  }
  if (isParty && chatOpen) {
    const placeholder = trade.status === 'pending_accept'
      ? '跟對方聊兩句…'
      : '追問 AI 為什麼，或提議新條件…';
    const input = el('input', {
      type: 'text', class: 'tt-input',
      placeholder,
      maxlength: 300,
    });
    const send = el('button', {
      type: 'button', class: 'btn small',
      onclick: () => onSendTradeMessage(trade.id, input),
    }, '送出');
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); send.click(); }
    });
    wrap.append(el('div', { class: 'tt-input-row' }, input, send));
  }
  return wrap;
}

async function onSendTradeMessage(tradeId, input) {
  const body = (input.value || '').trim();
  if (!body) return;
  input.disabled = true;
  try {
    const data = await apiSoft(`/api/trades/${tradeId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (data) {
      input.value = '';
      refreshTrades();
    }
  } finally {
    input.disabled = false;
  }
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
  const fromName = teamName(trade.from_team) || `隊伍 ${trade.from_team}`;
  const toName   = teamName(trade.to_team)   || `隊伍 ${trade.to_team}`;
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
  // Inline one-line preview of the latest rejection reason / AI reply / user message
  // so the user doesn't have to expand to know what happened.
  if (!expanded) {
    let preview = '';
    let fullText = '';
    if (trade.status === 'rejected' && trade.reasoning && trade.reasoning !== 'human') {
      fullText = String(trade.reasoning)
        .replace(/^human\s*｜\s*/, '')
        .replace(/^拒絕原因：/, '');
      preview = `拒絕：${fullText}`;
    } else if (Array.isArray(trade.messages) && trade.messages.length) {
      const last = trade.messages[trade.messages.length - 1];
      const name = teamName(last.from_team) || `#${last.from_team}`;
      fullText = last.body || '';
      preview = `${name}：${fullText}`;
    }
    if (preview) {
      row.append(el('div', { class: 'trade-hist-preview', title: fullText }, preview));
    }
  }
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
  const thread = buildTradeThread(trade);
  if (thread) detail.append(thread);
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
  return once(`trade-accept:${id}`, () => mutate(async () => {
    await api(`/api/trades/${id}/accept`, { method: 'POST' });
    await afterTradeMutation();
  }, '交易已接受'));
}
async function onRejectTrade(id) {
  return once(`trade-reject:${id}`, () => mutate(async () => {
    await api(`/api/trades/${id}/reject`, { method: 'POST' });
    await afterTradeMutation();
  }, '交易已拒絕'));
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
  // Trace: if a user reports "nothing happens", this console line confirms
  // the click handler actually fired. If it's missing in devtools, the
  // #btn-trade-propose-submit binding never ran.
  console.info('[trade-propose] submit clicked',
    { counterparty: state.proposeDraft?.counterparty,
      send: state.proposeDraft?.send?.size,
      receive: state.proposeDraft?.receive?.size });
  return once('trade-propose', async () => {
    const humanId = state.draft?.human_team_id ?? 0;
    const { counterparty, send, receive } = state.proposeDraft;
    if (counterparty == null) { toast('請選擇交易對象', 'warn'); return; }
    if (!send.size || !receive.size) { toast('每方至少選一名球員', 'warn'); return; }

    const proposerMessage = ($('#trade-message')?.value || '').trim();
    const force = !!$('#trade-force')?.checked;
    const submitBtn = $('#btn-trade-propose-submit');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '發送中...'; }

    try {
      const created = await api('/api/trades/propose', {
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
      const newId = created && created.id;
      if (newId) {
        state.tradeHistoryOpen = true;
        state.expandedHistory.add(newId);
      }
      // Auto-navigate to 交易 sub-tab so user immediately sees the new proposal
      // at the top of the list (sort-newest-first ensures visibility).
      state.leagueSubTab = 'trades';
      state.tradesSubtabFilter = 'all';
      render();
      await afterTradeMutation();
      if (newId) scrollToHistoryTrade(newId).catch(() => {});
      const reportDecision = (tr) => {
        if (!tr) return;
        if (tr.status === 'rejected' && tr.reasoning && tr.reasoning !== 'human') {
          const reason = String(tr.reasoning).replace(/^human\s*｜\s*/, '').replace(/^拒絕原因：/, '');
          toast(`AI 拒絕：${reason.slice(0, 80)}`, 'warn');
        } else if (tr.status === 'accepted') {
          toast('AI 接受 — 進入否決期', 'success');
        } else if (tr.status === 'countered') {
          toast('AI 提出還價，請查看', 'info');
        }
      };
      const pollDecision = async () => {
        await afterTradeMutation();
        if (!newId) return;
        const tr = (state.tradesHistory || []).find((t) => t.id === newId);
        if (tr && tr.status !== 'pending_accept') reportDecision(tr);
      };
      setTimeout(() => { pollDecision().catch(() => {}); }, 1200);
      setTimeout(() => { pollDecision().catch(() => {}); }, 3500);
      setTimeout(() => { pollDecision().catch(() => {}); }, 10000);
    } catch (e) {
      console.warn('[trade-propose] failed', e);
      toast(e.message || '提案失敗', 'error');
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '送出提案'; }
    }
  });
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
  // excerpt suppressed — raw LLM English text not shown in activity log
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

// Re-entrancy guard for button handlers. Rage-clicks on advance-day /
// sim-playoffs / trade-propose fire N requests; file-lock makes most idempotent
// but UX is sloppy (trade propose even creates N duplicate pending trades).
// Usage: `once('advance-day', () => doWork())`.
const _inflight = new Set();
async function once(key, fn) {
  if (_inflight.has(key)) {
    toast('處理中,請稍候...', 'warn', 1500);
    return;
  }
  _inflight.add(key);
  try { return await fn(); }
  finally { _inflight.delete(key); }
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
    // Draft reset also invalidates season/standings/rosters; pull a fresh
    // snapshot so the UI doesn't show stale teams on a blank draft.
    state.summaryShownFor = null;
    await refreshState();
    navigate('draft');
    render();
  }, '選秀已重置');
}

async function onResetSeason() {
  const ok = await confirmDialog('重置賽季？', '所有賽季結果與賽程將被清除，選秀資料保留。', '重置');
  if (!ok) return;
  await mutate(async () => {
    await api('/api/season/reset', { method: 'POST' });
    // Clear auto-summary flag so the next completed season fires it again.
    state.summaryShownFor = null;
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
  return once('advance-day', () => mutate(async () => {
    const r = await api('/api/season/advance-day', { method: 'POST' });
    await refreshState();
    refreshLogs();
    render();
    const summary = r?.summary || r?.message || '已推進一天';
    toast(summary, 'success');
  }));
}

async function onAdvanceWeek() {
  // Single-flight guard: rage-clicks would otherwise open multiple EventSource
  // streams in parallel, either no-op'ing or racing each other. Reject extra
  // clicks until the current advance completes (see g2p round-2 finding).
  if (state.advanceWeekInFlight) {
    toast('推進中,請稍候...', 'warn', 1500);
    return;
  }
  state.advanceWeekInFlight = true;
  const prevWeek = state.standings?.current_week || state.schedule?.current_week || 1;

  // Show progress indicator
  const progressId = 'advance-week-progress';
  let progressEl = document.getElementById(progressId);
  if (!progressEl) {
    progressEl = document.createElement('div');
    progressEl.id = progressId;
    progressEl.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1e293b;color:#e2e8f0;padding:10px 20px;border-radius:8px;z-index:9999;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.4)';
    document.body.appendChild(progressEl);
  }
  progressEl.textContent = '推進中... 準備中';

  return new Promise((resolve) => {
    const es = new EventSource('/api/season/advance-week/stream');

    es.onmessage = async (e) => {
      const data = JSON.parse(e.data);
      if (data.error) {
        es.close();
        progressEl.remove();
        state.advanceWeekInFlight = false;
        toast('推進失敗: ' + data.error, 'error');
        resolve();
      } else if (data.done) {
        es.close();
        progressEl.remove();
        state.advanceWeekInFlight = false;
        await refreshState();
        refreshLogs();
        render();
        toast('已推進一週', 'success');
        setTimeout(() => onShowWeekRecap(prevWeek), 400);
        resolve();
      } else {
        progressEl.textContent = `推進中... 第 ${data.day % 7 || 7} 天 / 7 天`;
      }
    };

    es.onerror = async () => {
      es.close();
      progressEl.remove();
      state.advanceWeekInFlight = false;
      toast('推進週次時連線中斷', 'error');
      resolve();
    };
  });
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
  // maxWeek = highest fully-completed week. `current_week - 1` is wrong because
  // when day=35, current_week=5 but week 5 has fully ended (resolve_week fired).
  const maxWeek = completedWeekNumber();
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
  return once('sim-to-playoffs', () => mutate(async () => {
    const busy = showBusyOverlay('正在模擬剩餘例行賽，這可能需要 10–30 秒...');
    try {
      await api('/api/season/sim-to-playoffs', { method: 'POST' });
      await refreshState();
      refreshLogs();
      render();
    } finally {
      busy.remove();
    }
  }, '例行賽模擬完成'));
}

function showBusyOverlay(message) {
  const existing = document.querySelector('.busy-overlay');
  if (existing) existing.remove();
  const node = el('div', { class: 'busy-overlay', role: 'status', 'aria-live': 'polite' },
    el('div', { class: 'busy-box' },
      el('div', { class: 'busy-spinner' }),
      el('div', { class: 'busy-msg' }, message),
    ),
  );
  document.body.appendChild(node);
  return node;
}

async function onSimPlayoffs() {
  const ok = await confirmDialog('模擬季後賽淘汰賽？', '前 4 強進行準決賽 + 決賽（第 15–16 週）。', '執行');
  if (!ok) return;
  return once('sim-playoffs', () => mutate(async () => {
    await api('/api/season/sim-playoffs', { method: 'POST' });
    await refreshState();
    refreshLogs();
    render();
  }, '季後賽模擬完成'));
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

  // Safety net: document-level delegation for draft buttons. Survives any
  // DOM rebuild inside #main-view; complements the per-table handler so a
  // human click always fires even during mid-render races.
  document.addEventListener('click', (ev) => {
    const btn = ev.target && ev.target.closest && ev.target.closest('button[data-draft]');
    if (!btn || btn.disabled) return;
    ev.preventDefault();
    ev.stopPropagation();
    const pid = parseInt(btn.dataset.draft, 10);
    if (Number.isFinite(pid)) onDraftPlayer(pid);
  });

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

  // League switcher
  const lswBtn = $('#btn-league-switch');
  const lswMenu = $('#league-switch-menu');
  if (lswBtn && lswMenu) {
    lswBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const hidden = lswMenu.hidden;
      if (hidden) openLeagueSwitchMenu();
      else closeLeagueSwitchMenu();
    });
    document.addEventListener('click', (e) => {
      if (!lswMenu.hidden && !lswMenu.contains(e.target) && e.target !== lswBtn && !lswBtn.contains(e.target)) {
        closeLeagueSwitchMenu();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !lswMenu.hidden) closeLeagueSwitchMenu();
    });
  }

  const newLeagueBtn = $('#btn-new-league-create');
  if (newLeagueBtn) newLeagueBtn.addEventListener('click', onCreateLeague);
  // Enter in the league-ID field submits "建立並切換" instead of the form's
  // default action (which would just close the dialog via method="dialog").
  const newLeagueInput = $('#new-league-id');
  if (newLeagueInput) {
    newLeagueInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onCreateLeague();
      }
    });
  }
}

async function loadLeagues() {
  try {
    const data = await api('/api/leagues/list');
    state.leagues = data.leagues || [];
    state.activeLeague = data.active || 'default';
  } catch (e) {
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
    const idChip = l.name && l.name !== l.league_id ? `<span class="lsw-id">${escapeHtml(l.league_id)}</span>` : '';
    return `
      <div class="lsw-item ${isActive ? 'active' : ''}" role="menuitem">
        <button type="button" class="lsw-pick" data-league="${escapeHtml(l.league_id)}" ${isActive ? 'disabled' : ''}>
          <span class="lsw-check" aria-hidden="true">${isActive ? '✓' : ''}</span>
          <span class="lsw-name">${displayName}</span>
          ${idChip}
          ${l.setup_complete ? '' : '<span class="lsw-tag">未設定</span>'}
        </button>
        ${isActive ? '' : `<button type="button" class="lsw-del" data-league="${escapeHtml(l.league_id)}" aria-label="刪除聯盟 ${displayName}" title="刪除">×</button>`}
      </div>`;
  }).join('');
  menu.innerHTML = `
    <div class="lsw-list">${items || '<div class="lsw-empty">尚無其他聯盟</div>'}</div>
    <div class="lsw-foot">
      <button type="button" class="lsw-new" id="btn-lsw-new">+ 建立新聯盟</button>
    </div>
  `;
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');

  menu.querySelectorAll('.lsw-pick').forEach((b) => {
    b.addEventListener('click', (e) => {
      const lid = e.currentTarget.dataset.league;
      if (lid) onSwitchLeague(lid);
    });
  });
  menu.querySelectorAll('.lsw-del').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const lid = e.currentTarget.dataset.league;
      if (lid) onDeleteLeague(lid);
    });
  });
  const newBtn = $('#btn-lsw-new');
  if (newBtn) newBtn.addEventListener('click', () => {
    closeLeagueSwitchMenu();
    const dlg = $('#dlg-new-league');
    const inp = $('#new-league-id');
    if (inp) inp.value = '';
    try { dlg.showModal(); setTimeout(() => inp && inp.focus(), 50); } catch {}
  });
}

function closeLeagueSwitchMenu() {
  const menu = $('#league-switch-menu');
  const btn = $('#btn-league-switch');
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

async function onSwitchLeague(leagueId) {
  closeLeagueSwitchMenu();
  try {
    await api('/api/leagues/switch', { method: 'POST', body: JSON.stringify({ league_id: leagueId }) });
    toast(`已切換到聯盟 ${leagueId}`, 'success', 2000);
    // Full reload keeps rendering logic simple — every panel will re-fetch.
    setTimeout(() => window.location.reload(), 150);
  } catch (e) {
    toast(`切換失敗：${e.message}`, 'error', 4000);
  }
}

async function onCreateLeague() {
  const inp = $('#new-league-id');
  const lid = (inp && inp.value || '').trim();
  if (!lid) { toast('請輸入聯盟 ID', 'warn', 2500); return; }
  try {
    await api('/api/leagues/create', { method: 'POST', body: JSON.stringify({ league_id: lid, switch: true }) });
    const dlg = $('#dlg-new-league');
    if (dlg) dlg.close();
    toast(`已建立並切換到聯盟 ${lid}`, 'success', 2000);
    setTimeout(() => window.location.reload(), 200);
  } catch (e) {
    toast(`建立失敗：${e.message}`, 'error', 4000);
  }
}

async function onDeleteLeague(leagueId) {
  const confirmed = await confirmDialog('刪除聯盟', `確定刪除聯盟「${leagueId}」?此操作無法還原。`, '刪除');
  if (!confirmed) return;
  try {
    await api('/api/leagues/delete', { method: 'POST', body: JSON.stringify({ league_id: leagueId }) });
    toast(`已刪除聯盟 ${leagueId}`, 'success', 2000);
    await loadLeagues();
    // Refresh menu if open
    const menu = $('#league-switch-menu');
    if (menu && !menu.hidden) openLeagueSwitchMenu();
  } catch (e) {
    toast(`刪除失敗：${e.message}`, 'error', 4000);
  }
}

async function init() {
  bindGlobalUI();
  try {
    state.personas = await api('/api/personas');
  } catch {
    state.personas = {};
  }

  // Load league status + settings + seasons list + leagues (best-effort)
  const [leagueStatus, leagueSettings, seasonsList] = await Promise.all([
    apiSoft('/api/league/status'),
    apiSoft('/api/league/settings'),
    apiSoft('/api/seasons/list'),
  ]);
  await loadLeagues();
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
