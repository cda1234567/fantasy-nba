/* Fantasy NBA v2 — app.js
 * Hash router, nav, views. All views rendered as innerHTML strings.
 */
(() => {
  const VERSION = '0.6.21';
  const D = {};  // replaces window.DATA - will be populated from API
  const API = '';

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(await res.text());
    return res.status === 204 ? null : res.json();
  }

  async function refreshData() {
    try {
      const [leagueStatus, draftState, pendingTradesTop] = await Promise.all([
        api('/api/league/status').catch(() => null),
        api('/api/state').catch(() => null),
        api('/api/trades/pending').catch(() => null),
      ]);
      // Always sync tradeThreads from real API (clears mock data even in draft phase)
      if (pendingTradesTop) {
        D.tradeThreads = pendingTradesTop.pending?.length > 0
          ? pendingTradesTop.pending.map(t => ({
              id: t.id, with: t.from_team_name || `Team ${t.from_team}`,
              team: t.from_team_name || `T${t.from_team}`,
              persona: t.persona || 'AI', fit: t.fit || 50,
              unread: t.status === 'pending', grad: 1, status: t.status,
              msgs: [{ type: 'proposal', id: t.id, from: t.from_team_name || `T${t.from_team}`,
                theirs: (t.their_players || []).map(p => ({ n: p.name || `#${p}`, p: p.pos || 'F' })),
                mine: (t.my_players || []).map(p => ({ n: p.name || `#${p}`, p: p.pos || 'F' })),
              }],
              time: t.created_at ? new Date(t.created_at).toLocaleString('zh-TW') : '',
            }))
          : [];
      }

      // Populate league-level data
      if (leagueStatus) {
        D.league = D.league || {};
        D.league.name = leagueStatus.league_name || D.league.name || '我的聯盟';
      }

      // Sync draft state and available players
      if (draftState) {
        D.draftState = D.draftState || {};
        D.draftState.round = draftState.current_round || 1;
        D.draftState.pickOverall = draftState.current_overall || 1;
        D.draftState.pickInRound = draftState.current_pick_in_round || 1;
        D.draftState.currentTeamId = draftState.current_team_id;
        D.draftState.humanTeamId = draftState.human_team_id;
        D.draftState.numTeams = draftState.num_teams || 8;
        D.draftState.totalRounds = draftState.total_rounds || 13;
        D.draftState.teams = draftState.teams || [];
        D.draftState.picks = draftState.picks || [];
        D.draftState.isMyTurn = draftState.current_team_id === draftState.human_team_id;
        D.league.draftDone = draftState.is_complete ?? false;
      }
      if (!D.league?.draftDone) {
        const playersRaw = await api('/api/players?available=true&limit=500').catch(() => null);
        if (playersRaw) {
          D.draftPlayers = playersRaw.map((p, i) => ({
            id: p.id, name: p.name, pos: p.pos, team: p.team,
            fppg: p.fppg || 0, rank: i + 1,
          }));
        }
        const recoData = await api('/api/draft/recommendations').catch(() => null);
        if (recoData && !recoData.is_complete) {
          D.draftState = D.draftState || {};
          D.draftState.needs = recoData.needs || [];
        }
      }

      // Only fetch season data if draft is done
      if (D.league?.draftDone) {
        const [standings, meData, faStatus, actionsData] = await Promise.all([
          api('/api/season/standings').catch(() => null),
          api('/api/me').catch(() => null),
          api('/api/fa/claim-status').catch(() => null),
          api('/api/home/actions').catch(() => null),
        ]);
        if (actionsData) D.actions = actionsData;

        if (meData?.team_id != null) {
          const [teamData] = await Promise.all([
            api(`/api/teams/${meData.team_id}`).catch(() => null),
          ]);

          if (teamData) {
            const slotMap = {};
            (teamData.lineup_slots || []).forEach(s => { if (s.player_id != null) slotMap[s.player_id] = s.slot; });
            D.roster = (teamData.players || []).map(p => ({
              id: p.id, playerId: p.id,
              slot: slotMap[p.id] || 'BN',
              name: p.name, pos: p.pos, team: p.team,
              grad: p.grad || ((p.id % 8) + 1),
              form: p.form?.length ? p.form : [0,0,0,0,0],
              status: p.status || 'healthy',
              proj: Number((p.fppg || 0).toFixed(1)),
              mpg: Number(p.mpg || 0),
              avg: { pts: p.pts||0, reb: p.reb||0, ast: p.ast||0, stl: p.stl||0, blk: p.blk||0, to: p.to||0 },
            }));
          }

          D._myTeamId = meData.team_id;

          if (faStatus) {
            D.faab = { budget: faStatus.budget || 100, spent: faStatus.budget - (faStatus.remaining || faStatus.budget) };
          }

          if (standings) {
            D.league.week = standings.current_week || 0;
            D.league.day = standings.current_day || 0;
            // Update standings data
            D.standings = (standings.standings || []).map(s => ({
              rank: s.rank, name: s.team_name, owner: s.owner_name || '',
              w: s.wins || 0, l: s.losses || 0, pf: s.points_for || 0,
              streak: s.streak || '—', waiver: s.waiver_priority || s.faab_remaining || 0,
            }));
          }

          // Fetch matchup if in season
          if (standings?.current_week > 0) {
            const matchupRaw = await api(`/api/season/matchup?week=${standings.current_week}`).catch(() => null);
            if (matchupRaw?.matchups) {
              const myId = meData.team_id;
              const m = matchupRaw.matchups.find(x => x.team_a === myId || x.team_b === myId);
              if (m) {
                const youAreA = m.team_a === myId;
                D.matchup = D.matchup || {};
                D.matchup.week = matchupRaw.week;
                D.matchup.you = { ...(D.matchup.you || {}), score: youAreA ? m.score_a : m.score_b };
                D.matchup.them = { ...(D.matchup.them || {}), score: youAreA ? m.score_b : m.score_a };
                const oppId = youAreA ? m.team_b : m.team_a;
                const humanTeamObj = (D.draftState?.teams || []).find(t => t.id === myId);
                const opponentTeamObj = (D.draftState?.teams || []).find(t => t.id === oppId);
                if (humanTeamObj) D.matchup.you.team = humanTeamObj.name;
                if (opponentTeamObj) D.matchup.them.team = opponentTeamObj.name;
              }
            }
          }
        }

        // Load FA list
        const faPlayers = await api('/api/players?available=true&sort=fppg&limit=100').catch(() => null);
        if (Array.isArray(faPlayers)) {
          D.freeAgents = faPlayers.map(p => ({
            id: p.id, playerId: p.id,
            name: p.name, pos: p.pos, team: p.team,
            grad: p.grad || ((p.id % 8) + 1),
            owned: 0, trend: 'flat',
            form: p.form || [0,0,0,0,0],
            note: '',
          }));
        }
        const newsFeed = await api('/api/news/feed').catch(() => null);
        if (newsFeed?.feed?.length) D.news = newsFeed.feed;
        const schedRaw = await api('/api/season/schedule').catch(() => null);
        if (schedRaw?.schedule?.length) {
          const curWeek = standings?.current_week || 0;
          const teams = D.draftState?.teams || [];
          D.schedule = schedRaw.schedule
            .filter(m => m.team_a === meData.team_id || m.team_b === meData.team_id)
            .map(m => {
              const iAmA = m.team_a === meData.team_id;
              const myScore = iAmA ? m.score_a : m.score_b;
              const oppId = iAmA ? m.team_b : m.team_a;
              const oppTeam = teams.find(t => t.id === oppId);
              let result = 'future';
              if (m.complete) result = m.winner === meData.team_id ? 'W' : 'L';
              else if (m.week === curWeek) result = 'current';
              return { w: m.week, result, score: m.complete ? myScore.toFixed(1) : '—',
                       opp: { team: oppTeam?.name || `T${oppId}`, owner: '' } };
            });
        }
      }

      // Update header league name
      const headerEl = document.getElementById('header-league-name');
      if (headerEl && D.league?.name) {
        const size = D.standings?.length || D.league.size || '';
        headerEl.textContent = size ? `${D.league.name} · ${size}人` : D.league.name;
      }
    } catch (e) {
      console.warn('refreshData error:', e);
    }
  }

  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];
  const h = (tag, attrs={}, ...kids) => {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([k,v]) => {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    });
    kids.flat().forEach(k => el.append(k instanceof Node ? k : document.createTextNode(k)));
    return el;
  };

  // ---------- SVG icon helpers ----------
  const ic = (paths, s=16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const I = {
    home:    ic('<path d="m3 11 9-7 9 7v9a2 2 0 0 1-2 2h-4v-7h-6v7H5a2 2 0 0 1-2-2z"/>'),
    roster:  ic('<circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><circle cx="17" cy="7" r="3"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/>'),
    match:   ic('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
    trade:   ic('<path d="M7 7h14l-3-3"/><path d="M17 17H3l3 3"/><path d="M17 17V7"/><path d="M7 7v10"/>'),
    league:  ic('<path d="M4 20h16"/><path d="M6 16h3v4H6z"/><path d="M10.5 12h3v8h-3z"/><path d="M15 8h3v12h-3z"/>'),
    fa:      ic('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M11 8v6"/><path d="M8 11h6"/>'),
    draft:   ic('<path d="m9 11 3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11"/>'),
    history: ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    schedule:ic('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
    chat:    ic('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    settings:ic('<circle cx="12" cy="12" r="3"/><path d="M12 1v6M12 17v6M4.2 4.2l4.2 4.2M15.6 15.6l4.2 4.2M1 12h6M17 12h6M4.2 19.8l4.2-4.2M15.6 8.4l4.2-4.2"/>'),
    plus:    ic('<path d="M12 5v14M5 12h14"/>'),
    arrow:   ic('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
    alert:   ic('<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>'),
    check:   ic('<path d="M20 6 9 17l-5-5"/>'),
    syringe: ic('<path d="m18 2 4 4"/><path d="m17 7 3-3"/><path d="M19 9 8.7 19.3a1 1 0 0 1-1.4 0l-2.6-2.6a1 1 0 0 1 0-1.4L15 5"/><path d="m9 11 4 4"/>'),
    waiver:  ic('<path d="M12 2v20"/><path d="m5 9 7-7 7 7"/><path d="m5 15 7 7 7-7"/>'),
    sparkle: ic('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>'),
    send:    ic('<path d="m22 2-7 20-4-9-9-4 20-7z"/>'),
  };

  // ========================================================
  // NAV
  // ========================================================
  function renderNav() {
    const phase = D.league.phase; // regular
    const draftDone = D.league.draftDone;

    const items = [
      { group:'主要' },
      { id:'home',     label:'今日',     icon:I.home, shortcut:'G H' },
      { id:'matchup',  label:'對戰',     icon:I.match, shortcut:'G M' },
      { id:'roster',   label:'球隊',     icon:I.roster, shortcut:'G R' },

      { group:'賽事' },
      { id:'draft',    label:'選秀廳',   icon:I.draft, dot:!draftDone, demoted:draftDone },
      { id:'trade',    label:'交易',     icon:I.trade, badge: D.tradeThreads.filter(t=>t.unread).length || null },
      { id:'fa',       label:'自由球員', icon:I.fa },
      { id:'schedule', label:'排程',     icon:I.schedule },

      { group:'聯盟' },
      { id:'standings',label:'排名',     icon:I.league },
      { id:'news',     label:'動態',     icon:I.chat },
    ];

    const route = currentRoute();
    const nav = $('#nav');
    nav.innerHTML = '';
    items.forEach(it => {
      if (it.group) { nav.append(h('div', {class:'nav-group-label'}, it.group)); return; }
      const a = h('a', {
        class: 'nav-item' + (it.demoted ? ' demoted' : ''),
        href: '#/' + it.id,
        'data-phase': it.id === 'draft' && it.dot ? 'draft' : '',
        'aria-current': route === it.id ? 'page' : null,
      });
      a.innerHTML = `<span class="ni-ic">${it.icon}</span><span>${it.label}</span>`;
      if (it.badge) a.innerHTML += `<span class="ni-badge">${it.badge}</span>`;
      else if (it.dot) a.innerHTML += `<span class="ni-dot"></span>`;
      else if (it.shortcut) a.innerHTML += `<span class="ni-shortcut">${it.shortcut}</span>`;
      nav.append(a);
    });

    // Season progress card
    const pct = Math.round(D.league.week / D.league.totalWeeks * 100);
    const season = h('div', {class:'nav-season'});
    season.innerHTML = `
      <div class="nav-season-label">本季進度</div>
      <div class="nav-season-name">2024-25 · 例行賽</div>
      <div class="nav-season-track"><div class="nav-season-fill" style="width:${pct}%"></div></div>
      <div class="nav-season-meta"><span>W${D.league.week} / ${D.league.totalWeeks}</span><span>${pct}%</span></div>`;
    nav.append(season);

    // Mobile tabbar (5 items)
    const tabbar = $('#tabbar');
    const tabs = ['home','matchup','roster','trade','standings'];
    const labels = {home:'今日',matchup:'對戰',roster:'球隊',trade:'交易',standings:'排名'};
    tabbar.innerHTML = '';
    tabs.forEach(t => {
      const btn = h('a', {class:'tab-btn', href:'#/'+t, 'aria-current': route===t?'page':null});
      btn.innerHTML = `${I[t] || I.home}<span>${labels[t]}</span>`;
      tabbar.append(btn);
    });
  }

  // ========================================================
  // RIGHT RAIL — differs by route
  // ========================================================
  function renderRail() {
    const route = currentRoute();
    const rail = $('#rail');
    if (['home','standings','schedule','news'].includes(route)) {
      rail.innerHTML = renderNewsFeed();
      return;
    }
    if (route === 'roster' || route === 'matchup') {
      rail.innerHTML = renderMatchupMini();
      return;
    }
    if (route === 'trade') {
      rail.innerHTML = renderTradeSidebar();
      return;
    }
    if (route === 'draft') {
      rail.innerHTML = renderDraftBoard();
      return;
    }
    if (route === 'fa') {
      rail.innerHTML = renderWaiverBudget();
      return;
    }
    rail.innerHTML = renderNewsFeed();
  }

  function renderNewsFeed() {
    const kindIcon = {
      injury:'🩹', heat:'🔥', league:'📎', quote:'"', milestone:'★', matchup:'⚔'
    };
    const items = D.news.map(n => {
      if (n.kind === 'quote') {
        return `<div class="news-item ${n.flash?'flash':''}">
          <div class="news-dot" data-kind="${n.kind}">${kindIcon[n.kind]}</div>
          <div class="news-body">
            <div class="news-quote">${n.quote}</div>
            <div class="news-attrib">— ${n.attrib}</div>
            <div class="news-meta">${n.meta}</div>
          </div></div>`;
      }
      return `<div class="news-item ${n.flash?'flash':''}">
        <div class="news-dot" data-kind="${n.kind}">${kindIcon[n.kind]}</div>
        <div class="news-body">
          <div class="news-title">${n.title}</div>
          <div class="news-meta">${n.meta}</div>
        </div></div>`;
    }).join('');
    return `<div class="rail-section">
      <div class="rail-head"><span class="live-lamp">LIVE</span><span>聯盟動態</span></div>
      <div class="news-feed">${items}</div>
    </div>`;
  }

  function renderMatchupMini() {
    const m = D.matchup;
    const youPct = m.you.score / (m.you.score + m.them.score) * 100;
    return `<div class="rail-section">
      <div class="rail-head"><span>本週對戰</span><span class="mono" style="margin-left:auto;color:var(--ink-3)">W${m.week}</span></div>
      <div class="card card-pad">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px">
          <div>
            <div class="mono" style="font-size:11px;color:var(--ink-3);text-transform:uppercase">你</div>
            <div style="font-size:var(--fs-md);font-weight:600;margin-top:2px">${m.you.team}</div>
          </div>
          <div class="mono" style="font-size:var(--fs-2xl);font-weight:700;color:var(--good);letter-spacing:-0.02em">${m.you.score}</div>
        </div>
        <div class="matchup-progress-track"><div class="mpt-you" style="width:${youPct}%"></div><div class="mpt-them" style="width:${100-youPct}%"></div></div>
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:12px">
          <div>
            <div class="mono" style="font-size:11px;color:var(--ink-3);text-transform:uppercase">對手 · ${m.them.owner}</div>
            <div style="font-size:var(--fs-md);font-weight:600;margin-top:2px">${m.them.team}</div>
          </div>
          <div class="mono" style="font-size:var(--fs-2xl);font-weight:700;color:var(--ink-2);letter-spacing:-0.02em">${m.them.score}</div>
        </div>
        <div style="border-top:1px solid var(--line-soft);margin-top:var(--s-4);padding-top:var(--s-3);display:flex;justify-content:space-between;font-size:var(--fs-xs);color:var(--ink-3)">
          <span>已打 ${m.you.played}/${m.you.total} 場</span>
          <span>預估終局 <b class="mono" style="color:var(--good)">${m.you.proj}</b></span>
        </div>
      </div>
    </div>
    <div class="rail-section">
      <div class="rail-head"><span>本週建議</span></div>
      <div class="card card-pad" style="font-size:var(--fs-sm);line-height:1.6;color:var(--ink-2)">
        ${(D.actions || []).filter(a => a.urgency !== 'done').slice(0,3).map(a => `· ${a.title}${a.sub ? `<br/><span style="color:var(--ink-3);font-size:10px">${a.sub}</span>` : ''}`).join('<br/>') || '目前一切就緒'}
      </div>
    </div>`;
  }

  function renderTradeSidebar() {
    const verdict = `
      <div class="tl-verdict">
        <div class="tl-verdict-head">AI 判決 · <b>建議接受</b></div>
        <div>Siakam 多類別產能穩定，補你 PF 空缺；Quickley 上場時間本月爆衝。Porziņģis 健康風險你本來就難承受。</div>
      </div>`;
    const bars = [
      ['得分', 0.42, 0.58],
      ['籃板', 0.38, 0.62],
      ['助攻', 0.55, 0.45],
      ['阻攻', 0.48, 0.52],
      ['效率', 0.44, 0.56],
    ].map(([label, mine, theirs]) => `
      <div class="tl-bar">
        <div class="l">${(mine*100).toFixed(0)}</div>
        <div class="tl-bar-track">
          <div class="tl-bar-mine" style="width:${mine*100}%"></div>
          <div class="tl-bar-theirs" style="width:${theirs*100}%"></div>
        </div>
        <div class="r">${(theirs*100).toFixed(0)}</div>
      </div>
      <div style="font-size:10px;color:var(--ink-3);margin:-4px 0 8px;text-align:center;font-family:var(--mono);text-transform:uppercase;letter-spacing:0.06em">${label}</div>
    `).join('');

    return `<div class="rail-section">
      <div class="rail-head"><span>AI 交易分析</span><span class="pill accent" style="margin-left:auto">#2041</span></div>
      ${verdict}
    </div>
    <div class="rail-section">
      <div class="rail-head"><span>五類別勝率預測</span></div>
      <div class="card card-pad">
        <div style="display:flex;justify-content:space-between;font-size:10px;font-family:var(--mono);text-transform:uppercase;color:var(--ink-3);margin-bottom:8px"><span style="color:var(--bad)">我方</span><span style="color:var(--good)">對方</span></div>
        ${bars}
      </div>
    </div>`;
  }

  function renderDraftBoard() {
    const ds = D.draftState || {};
    const teams = ds.teams || [];
    const picks = ds.picks || [];

    const rows = teams.length
      ? teams.map((team, i) => {
          const teamPicks = picks.filter(p => p.team_id === team.id);
          const pick = teamPicks.sort((a, b) => (b.overall ?? b.round) - (a.overall ?? a.round))[0];
          const pickedPlayer = pick?.player_id != null
            ? (D.draftPlayers || []).find(p => p.id === pick.player_id)
            : null;
          const isHuman = team.id === ds.humanTeamId;
          const isCurrent = team.id === ds.currentTeamId;
          const pickName = pickedPlayer?.name || pick?.player_name || (pick?.player_id != null ? `#${pick.player_id}` : null);

          return `
          <div style="display:grid;grid-template-columns:24px 1fr 1fr;gap:8px;padding:6px 8px;border-radius:6px;${isHuman?'background:var(--accent-14)':''}">
            <span class="mono" style="color:var(--ink-3);font-size:11px">${i + 1}</span>
            <span style="${isHuman?'color:var(--accent-hi);font-weight:600':''}">${team.name}</span>
            <span class="mono" style="font-size:11px;color:${pickName?'var(--ink-2)':'var(--ink-4)'};text-align:right">${pickName || (isCurrent?'選擇中…':'—')}</span>
          </div>`;
        }).join('')
      : '<div style="padding:6px 8px;color:var(--ink-3);font-size:var(--fs-sm)">載入中…</div>';

    return `<div class="rail-section">
      <div class="rail-head"><span>選秀順位 · 第 ${ds.round || 1} 輪</span></div>
      <div class="card card-pad" style="font-size:var(--fs-sm);display:flex;flex-direction:column;gap:4px">
        ${rows}
      </div>
    </div>`;
  }

  function renderWaiverBudget() {
    const remaining = D.faab.budget - D.faab.spent;
    const pct = remaining / D.faab.budget * 100;
    return `<div class="rail-section">
      <div class="rail-head"><span>本季 FAAB 預算</span></div>
      <div class="card card-pad">
        <div style="font-family:var(--mono);font-size:var(--fs-2xl);font-weight:700;letter-spacing:-0.02em">$${remaining} <span style="font-size:var(--fs-sm);color:var(--ink-3);font-weight:400">/ $${D.faab.budget}</span></div>
        <div style="height:4px;background:var(--line);border-radius:999px;overflow:hidden;margin-top:10px"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--accent),var(--accent-hi));border-radius:999px"></div></div>
        <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:var(--fs-xs);color:var(--ink-3);font-family:var(--mono)"><span>已用 $${D.faab.spent}</span></div>
      </div>
    </div>
    `;
  }

  // ========================================================
  // AVATAR HELPER
  // ========================================================
  const initials = (name) => {
    if (!name) return '';
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0,2).toUpperCase();
    return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
  };
  const av = (name, grad, sizeCls='') =>
    `<div class="av ${sizeCls}" data-grad="${grad}">${initials(name)}</div>`;

  // ========================================================
  // VIEWS
  // ========================================================
  const views = {};

  // ---------- HOME ----------
  views.home = () => {
    const { you, them, week } = D.matchup;
    const leadPct = Math.min(100, (you.score / (you.score + them.score)) * 100);
    const leading = you.score > them.score;

    const actions = D.actions.map(a => {
      const iconMap = {syringe:I.syringe, trade:I.trade, waiver:I.waiver, schedule:I.schedule, check:I.check};
      return `<div class="action-item" data-urgency="${a.urgency}" data-action="${a.id}">
        <div class="ai-ic">${iconMap[a.ic] || I.sparkle}</div>
        <div>
          <div class="ai-title">${a.title}</div>
          <div class="ai-sub">${a.sub}</div>
        </div>
        <div class="ai-cta">
          ${a.time ? `<span class="ai-time">${a.time}</span>` : ''}
          ${a.urgency !== 'done' ? `<button class="btn sm ghost">${a.cta} ${I.arrow}</button>` : `<span class="pill good"><span class="dot"></span>完成</span>`}
        </div>
      </div>`;
    }).join('');

    return `
      <div class="home-head">
        <div>
          <div class="home-greet">早安 Chen W. <span class="muted">— 第 ${week} 週，你有 4 件事可以做。</span></div>
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <div class="home-date mono">WED · 03.12 · 例行賽第 14 週</div>
        </div>
      </div>

      <section class="sitrep">
        <div class="sitrep-primary">
          <div class="sitrep-eyebrow">
            <span class="phase-ribbon">第 14 週 · 例行賽</span>
            <span class="week">距離季後賽 4 週</span>
          </div>
          <div class="sitrep-headline">你本週<span class="em"> 領先 26 分</span>，但還有<br/>3 場比賽會改變結局。</div>
          <div class="sitrep-sub">Jokić 今晚出戰 LAL，Luka 對位 Booker 是關鍵對決。Eric 手上還有 Brunson 沒打，他會在週末追上——如果你的先發陣容沒調整。</div>
          <div class="sitrep-ctas">
            <a href="#/matchup" class="btn">進入對戰 ${I.arrow}</a>
            <a href="#/roster" class="btn ghost">調整先發</a>
          </div>
        </div>

        <div class="sitrep-aside">
          <div class="metric-card">
            <div class="mc-label">本季戰績</div>
            <div class="mc-value">9–4 <span class="mc-unit">· 第 3 名</span></div>
            <div class="mc-delta">▲ W3 連勝中</div>
          </div>
          <div class="metric-card">
            <div class="mc-label">本週預估終局</div>
            <div class="mc-value">${you.proj} <span class="mc-unit">vs ${them.proj}</span></div>
            <div class="mc-delta">領先 ${(you.proj - them.proj).toFixed(0)} · 勝率 72%</div>
          </div>
          <div class="metric-card">
            <div class="mc-label">排名軌跡</div>
            <div class="mc-value">→ 第 2</div>
            <div class="mc-delta neutral">目前第 3、若本週贏將擠下 Ben</div>
          </div>
          <div class="metric-card">
            <div class="mc-label">類別優勢</div>
            <div class="mc-value" style="font-size:var(--fs-md);line-height:1.5">${(() => {
              const cb = D.matchup.catBreakdown;
              const wins = cb.filter(r => r.cat === 'TO' ? r.you < r.them : r.you > r.them);
              const tags = cb.map(r => {
                const win = r.cat === 'TO' ? r.you < r.them : r.you > r.them;
                return `<span style="color:${win ? 'var(--good)' : 'var(--ink-3)'};font-family:var(--mono);font-size:var(--fs-xs)">${r.cat}${win ? '✓' : '✗'}</span>`;
              }).join(' ');
              return tags + `<div style="margin-top:4px;font-family:var(--mono);font-size:var(--fs-sm);font-weight:700">${wins.length}/6 領先</div>`;
            })()}</div>
          </div>
        </div>
      </section>

      <section class="action-queue">
        <h2>今日該做什麼 <span class="count">${D.actions.filter(a=>a.urgency!=='done').length} 項待辦</span></h2>
        <div class="action-list">${actions}</div>
      </section>

      <section class="home-split">
        <div class="matchup-card">
          <div class="matchup-head">
            <h3>本週對戰</h3>
            <span class="wk">已打 ${you.played}/${you.total} 場</span>
          </div>
          <div class="matchup-body">
            <div class="matchup-side you ${leading?'winning':'losing'}">
              <div class="matchup-team">${av(D.me.name, you.grad, 'sm')}<span>肉圓幫 · 你</span></div>
              <div class="matchup-score mono">${you.score}</div>
              <div class="matchup-projection mono">proj · ${you.proj}</div>
            </div>
            <div class="matchup-vs mono">VS</div>
            <div class="matchup-side them ${leading?'losing':'winning'}">
              <div class="matchup-team"><span>${them.team} · Eric</span>${av('Eric', them.grad, 'sm')}</div>
              <div class="matchup-score mono">${them.score}</div>
              <div class="matchup-projection mono">proj · ${them.proj}</div>
            </div>
          </div>
          <div class="matchup-progress">
            <div class="matchup-progress-track">
              <div class="mpt-you" style="width:${leadPct}%"></div>
              <div class="mpt-them" style="width:${100-leadPct}%"></div>
            </div>
            <div class="matchup-progress-meta"><span>${leadPct.toFixed(0)}%</span><span>差距 ${Math.abs(you.score-them.score).toFixed(1)}</span><span>${(100-leadPct).toFixed(0)}%</span></div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h3>本週關鍵球員</h3>
            <span class="sub">你隊上表現最強的三位</span>
          </div>
          <div style="display:flex;flex-direction:column">
            ${D.roster.filter(p=>p.status==='hot').slice(0,3).map(p => `
              <div style="display:grid;grid-template-columns:40px 1fr auto;gap:12px;align-items:center;padding:14px 20px;border-bottom:1px solid var(--line-soft)">
                ${av(p.name, p.grad)}
                <div>
                  <div style="font-weight:500;font-size:var(--fs-sm)">${p.name}</div>
                  <div style="font-size:11px;color:var(--ink-3);font-family:var(--mono);margin-top:2px">${p.team} · ${p.game || ''}</div>
                </div>
                <div style="text-align:right">
                  <div class="mono" style="font-weight:700;color:var(--good)">${p.proj}</div>
                  <div style="font-size:10px;color:var(--ink-3);font-family:var(--mono);text-transform:uppercase">預估</div>
                </div>
              </div>`).join('')}
          </div>
        </div>
      </section>
    `;
  };

  // ---------- ROSTER ----------
  const SLOT_ORDER = ['PG','SG','G','SF','PF','F','C','C','UTIL','UTIL','BN','IR'];
  let rosterSort = { key: 'slot', dir: 'asc' };
  let standingsSort = { key: 'r', dir: 'asc' };
  let draftSpeed = 800;
  let draftAutoTimer = null;
  const DAY_LABELS = ['一','二','三','四','五','六','日'];

  views.roster = () => {
    if (!D.league?.draftDone) return `
      <div class="view-head"><div class="view-title-block"><span class="eyebrow">球隊管理</span><div class="view-title">選秀尚未完成</div></div></div>
      <div class="card" style="padding:48px;text-align:center;color:var(--ink-3);font-size:var(--fs-sm)">完成選秀後才能查看陣容</div>`;
    const sorted = [...(D.roster || [])].sort((a, b) => {
      const av2 = (p) => {
        if (rosterSort.key === 'slot') { const i = SLOT_ORDER.indexOf(p.slot); return i === -1 ? 99 : i; }
        if (rosterSort.key === 'proj') return p.proj || 0;
        if (rosterSort.key === 'mpg') return p.mpg || 0;
        return (p.avg && p.avg[rosterSort.key] != null) ? p.avg[rosterSort.key] : -Infinity;
      };
      return rosterSort.dir === 'desc' ? av2(b) - av2(a) : av2(a) - av2(b);
    });

    const statCols = ['proj','mpg','pts','reb','ast','stl','blk','to'];
    const statLabel = { proj:'PROJ', mpg:'MPG', pts:'PTS', reb:'REB', ast:'AST', stl:'STL', blk:'BLK', to:'TO' };

    const thStyle = 'padding:8px 10px;font-family:var(--mono);font-size:10px;font-weight:700;text-transform:uppercase;color:var(--ink-3);text-align:right;white-space:nowrap;cursor:pointer;user-select:none;';
    const thActive = 'color:var(--accent-hi);';

    const headers = statCols.map(k => {
      const active = rosterSort.key === k;
      const arrow = active ? (rosterSort.dir === 'desc' ? ' ↓' : ' ↑') : '';
      return `<th data-table="roster" data-sort="${k}" style="${thStyle}${active ? thActive : ''}">${statLabel[k]}${arrow}</th>`;
    }).join('');

    const dayHeader = DAY_LABELS.map(d =>
      `<th style="${thStyle}text-align:center;">${d}</th>`
    ).join('');

    const rows = sorted.map(p => {
      const zoneTag = p.slot === 'BN' ? 'BN' : p.slot === 'IR' ? 'IR' : '';
      const slotBg = p.slot === 'IR' ? 'background:var(--bad-bg);' : p.slot === 'BN' ? 'background:var(--surface-2);' : '';
      const statCells = statCols.map(k => {
        if (k === 'proj') {
          return `<td style="text-align:right;font-family:var(--mono);font-weight:700;font-size:var(--fs-sm);color:var(--ink)">${p.proj || '—'}</td>`;
        }
        if (k === 'mpg') {
          const mpg = Number(p.mpg);
          return `<td style="text-align:right;font-family:var(--mono);font-size:var(--fs-xs);color:var(--ink-2)">${Number.isFinite(mpg) ? mpg.toFixed(1) : '—'}</td>`;
        }
        const val = p.avg ? p.avg[k] : null;
        return `<td style="text-align:right;font-family:var(--mono);font-size:var(--fs-xs);color:var(--ink-2)">${val != null ? val.toFixed(1) : '—'}</td>`;
      }).join('');
      const injuryBadge = p.status === 'out'
        ? '<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:var(--bad-bg);color:var(--bad);margin-left:4px;font-family:var(--mono)">OUT</span>'
        : p.status === 'day_to_day'
          ? '<span style="font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:var(--warn-bg);color:var(--warn);margin-left:4px;font-family:var(--mono)">DTD</span>'
          : '';
      const dayCells = DAY_LABELS.map((_, i) => {
        const on = p.days && p.days[i];
        return `<td style="text-align:center;padding:8px 4px;">
          <span style="display:inline-block;width:18px;height:18px;border-radius:4px;font-family:var(--mono);font-size:9px;font-weight:700;line-height:18px;${on ? 'background:var(--accent);color:var(--accent-ink);' : 'background:var(--surface-2);color:var(--ink-4);'}">${DAY_LABELS[i]}</span>
        </td>`;
      }).join('');
      return `<tr draggable="true" data-player-id="${p.id}" data-slot="${p.slot}" style="${slotBg}cursor:grab;">
        <td style="padding:10px 10px;white-space:nowrap;">
          <span style="font-family:var(--mono);font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;background:var(--surface-2);color:var(--ink-2);margin-right:6px">${p.slot}</span>
        </td>
        <td style="padding:10px 6px;">
          <div style="display:flex;align-items:center;gap:8px;">
            ${av(p.name, p.grad, 'sm')}
            <div>
              <div style="display:flex;align-items:center;">
                <div style="font-weight:500;font-size:var(--fs-sm)">${p.name}</div>
                ${injuryBadge}
              </div>
              <div style="font-size:10px;color:var(--ink-3);font-family:var(--mono)">${p.team} · ${p.game || '休'}</div>
            </div>
          </div>
        </td>
        <td style="padding:8px 10px;">
          <div class="slot-form">${p.form.map(f => `<div class="spark ${f===1?'hot':f===0?'warm':'cold'}"></div>`).join('')}</div>
        </td>
        ${dayCells}
        ${statCells}
      </tr>`;
    }).join('');

    return `
      <div class="view-head">
        <div class="view-title-block">
          <span class="eyebrow">球隊管理</span>
          <div class="view-title">肉圓幫 · 陣容</div>
          <div class="view-sub">12 人名單 · 5 傷兵位 · 調整截止於 週三 03:00</div>
        </div>
        <div class="view-actions">
          <div class="segmented"><button aria-pressed="true">本週</button><button>下週</button></div>
          <button class="btn ghost">建議最佳陣容 ${I.sparkle}</button>
        </div>
      </div>

      <div class="card" style="overflow-x:auto;">
        <table class="standings-table" style="min-width:900px;">
          <thead>
            <tr>
              <th style="padding:8px 10px;font-family:var(--mono);font-size:10px;font-weight:700;text-transform:uppercase;color:var(--ink-3);">位置</th>
              <th style="padding:8px 10px;font-family:var(--mono);font-size:10px;font-weight:700;text-transform:uppercase;color:var(--ink-3);">球員</th>
              <th style="padding:8px 10px;font-family:var(--mono);font-size:10px;font-weight:700;text-transform:uppercase;color:var(--ink-3);">近況</th>
              ${dayHeader}
              ${headers}
            </tr>
          </thead>
          <tbody id="roster-tbody">${rows}</tbody>
        </table>
      </div>
    `;
  };

  function renderCategoryBreakdown(cb, youName, themName) {
    return `
        <table class="standings-table">
          <thead><tr>
            <th>類別</th>
            <th class="num" style="color:var(--accent-hi)">你·${youName}</th>
            <th class="num">Δ</th>
            <th class="num">對手·${themName}</th>
          </tr></thead>
          <tbody>
            ${(cb || []).map(r => {
              const delta = r.cat === 'TO' ? r.them - r.you : r.you - r.them;
              const deltaColor = delta > 0 ? 'var(--good)' : delta < 0 ? 'var(--bad)' : 'var(--ink-3)';
              const deltaText = `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`;
              // For TO, lower is better
              const youWins = r.cat === 'TO' ? r.you < r.them : r.you > r.them;
              const themWins = r.cat === 'TO' ? r.them < r.you : r.them > r.you;
              return `<tr>
                <td><span style="font-family:var(--mono);font-weight:700;font-size:var(--fs-xs);padding:2px 8px;border-radius:4px;background:var(--surface-2);color:var(--ink-2)">${r.cat}</span></td>
                <td class="num" style="font-family:var(--mono);font-weight:700;${youWins ? 'color:var(--good)' : 'color:var(--ink-2)'}">${r.you.toFixed(1)}</td>
                <td class="num" style="font-family:var(--mono);font-weight:700;color:${deltaColor}">${deltaText}</td>
                <td class="num" style="font-family:var(--mono);${themWins ? 'color:var(--good)' : 'color:var(--ink-2)'}">${r.them.toFixed(1)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
  }

  // ---------- MATCHUP ----------
  views.matchup = () => {
    if (!D.league?.draftDone) return `
      <div class="view-head"><div class="view-title-block"><span class="eyebrow">對戰</span><div class="view-title">選秀尚未完成</div></div></div>
      <div class="card" style="padding:48px;text-align:center;color:var(--ink-3);font-size:var(--fs-sm)">完成選秀後才能查看對戰資訊</div>`;
    const { you, them } = D.matchup || {};
    const stars = (D.roster || []).filter(p => ['PG','SG','SF','PF','C','G','F','UTIL'].includes(p.slot));
    return `
      <div class="view-head">
        <div class="view-title-block">
          <span class="eyebrow">第 ${D.matchup?.week || D.league?.week || '?'} 週 · 例行賽</span>
          <div class="view-title">${you?.team || '我的隊伍'} vs ${them?.team || '對手'}</div>
          <div class="view-sub">已打 5/8 場 · 週日 18:30 結算</div>
        </div>
        <div class="view-actions">
          <button class="btn ghost" id="adv-day">推進一天</button>
          <button class="btn" id="adv-week">推進一週</button>
        </div>
      </div>

      <div class="card" style="margin-bottom:var(--s-5)">
        <div class="matchup-body" style="padding:var(--s-7) var(--s-8)">
          <div class="matchup-side you winning">
            <div class="matchup-team">${av(you?.team || '我', you?.grad || 1, 'lg')}<span style="font-size:var(--fs-lg);font-weight:600;margin-top:6px">${you?.team || '我的隊伍'}</span></div>
            <div class="matchup-score mono" style="color:var(--good);font-size:var(--fs-4xl)">${you.score}</div>
          </div>
          <div class="matchup-vs mono" style="font-size:var(--fs-xl)">VS</div>
          <div class="matchup-side them losing">
            <div class="matchup-team">${av(them?.team || '對', them?.grad || 2, 'lg')}<span style="font-size:var(--fs-lg);font-weight:600;margin-top:6px">${them?.team || '對手'}</span></div>
            <div class="matchup-score mono" style="font-size:var(--fs-4xl)">${them.score}</div>
          </div>
        </div>
        <div class="matchup-progress" style="padding:0 var(--s-8) var(--s-6)">
          <div class="matchup-progress-track"><div class="mpt-you" style="width:${(you.score/(you.score+them.score)*100).toFixed(1)}%"></div><div class="mpt-them" style="width:${(them.score/(you.score+them.score)*100).toFixed(1)}%"></div></div>
          <div class="matchup-progress-meta">
            <span>已打 ${you.played}/${you.total} · 預估 ${you.proj}</span>
            <span>領先 ${(you.score-them.score).toFixed(1)} · 勝率 72%</span>
            <span>對手預估 ${them.proj}</span>
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:var(--s-5);">
        <div class="card-header"><h3>類別分項</h3><span class="sub">本週累計 · 贏的那方亮色</span></div>
        ${renderCategoryBreakdown(D.matchup?.catBreakdown || [], you?.team || '我', them?.team || '對')}
      </div>

      <div class="card">
        <div class="card-header"><h3>本週球員貢獻</h3><span class="sub">依出場數排序</span></div>
        <div>${stars.map((p,i) => `
          <div style="display:grid;grid-template-columns:36px 40px 1fr auto auto;gap:16px;align-items:center;padding:14px 20px;${i<stars.length-1?'border-bottom:1px solid var(--line-soft)':''}">
            <span class="pos-tag" data-pos="${p.slot}">${p.slot}</span>
            ${av(p.name, p.grad)}
            <div>
              <div style="font-weight:500;font-size:var(--fs-sm)">${p.name}</div>
              <div style="font-size:11px;color:var(--ink-3);font-family:var(--mono);margin-top:2px">${p.team} · ${p.game || '—'}</div>
            </div>
            <div class="slot-form">${p.form.map(f => `<div class="spark ${f===1?'hot':f===0?'warm':'cold'}"></div>`).join('')}</div>
            <div class="mono" style="font-weight:700;min-width:48px;text-align:right;color:var(--ink)">${p.proj}</div>
          </div>`).join('')}
        </div>
      </div>
    `;
  };

  function standingsRank(s) {
    return s.r ?? s.rank;
  }

  function standingsTeam(s) {
    return s.team ?? s.name;
  }

  function standingsSortValue(s, key) {
    if (key === 'r') return Number(standingsRank(s) ?? Infinity);
    if (key === 'w') return Number(s.w ?? 0);
    if (key === 'pf') return Number(s.pf ?? 0);
    return 0;
  }

  function sortedStandings() {
    return [...(D.standings || [])].sort((a, b) => {
      const av = standingsSortValue(a, standingsSort.key);
      const bv = standingsSortValue(b, standingsSort.key);
      if (av !== bv) return standingsSort.dir === 'desc' ? bv - av : av - bv;
      return standingsSortValue(a, 'r') - standingsSortValue(b, 'r');
    });
  }

  function renderStandingsRows() {
    return sortedStandings().map(s => {
      const rank = standingsRank(s);
      const rankNum = Number(rank);
      const hasRank = Number.isFinite(rankNum);
      const team = standingsTeam(s) || '';
      const streak = s.streak || '—';
      return `
          <tr class="${s.you?'you':''} ${hasRank && rankNum<=6?'playoff':''}">
            <td><span class="rank-medal" data-rank="${rank}">${rank}</span></td>
            <td><div style="display:flex;align-items:center;gap:10px">${av(team, hasRank ? ((rankNum-1)%8)+1 : 1, 'sm')}<div><div style="font-weight:500">${team}${s.you?' <span class="pill accent" style="margin-left:6px">你</span>':''}</div><div style="font-size:11px;color:var(--ink-3);font-family:var(--mono)">${s.owner}</div></div></div></td>
            <td class="num"><b>${s.w}–${s.l}</b></td>
            <td class="num">${s.pf}</td>
            <td class="num"><span class="streak ${streak[0].toLowerCase()}">${streak}</span></td>
            <td class="num" style="color:var(--ink-3)">${hasRank && rankNum <= 3 ? '▲' : hasRank && rankNum >= 10 ? '▼' : '—'}</td>
          </tr>`;
    }).join('');
  }

  function renderStandingsSortHeader(key, label, cls='') {
    const active = standingsSort.key === key;
    const arrow = active ? (standingsSort.dir === 'desc' ? ' ↓' : ' ↑') : '';
    const classAttr = cls ? ` class="${cls}"` : '';
    return `<th data-table="standings" data-sort="${key}" data-label="${label}"${classAttr} style="cursor:pointer;user-select:none;${active ? 'color:var(--accent-hi);' : ''}">${label}${arrow}</th>`;
  }

  function syncSortHeaders(table) {
    const sortState = table === 'standings' ? standingsSort : rosterSort;
    $$(`th[data-table="${table}"][data-sort]`).forEach(th => {
      const active = sortState.key === th.dataset.sort;
      const label = th.dataset.label || th.textContent.replace(/\s*[↓↑]\s*$/, '');
      th.textContent = `${label}${active ? (sortState.dir === 'desc' ? ' ↓' : ' ↑') : ''}`;
      th.style.color = active ? 'var(--accent-hi)' : '';
    });
  }

  // ---------- STANDINGS ----------
  views.standings = () => `
    <div class="view-head">
      <div class="view-title-block">
        <span class="eyebrow">聯盟</span>
        <div class="view-title">排名 · ${D.league?.name || '我的聯盟'}</div>
        <div class="view-sub">第 14 週 · 前 6 名進季後賽 · 後 2 名直接抽下季選秀籤</div>
      </div>
      <div class="view-actions">
        <div class="segmented"><button aria-pressed="true">整體</button><button>東區</button><button>西區</button></div>
      </div>
    </div>
    <div class="card">
      <table class="standings-table">
        <thead><tr>${renderStandingsSortHeader('r', '名次')}<th>隊伍</th>${renderStandingsSortHeader('w', '戰績', 'num')}${renderStandingsSortHeader('pf', '總得分', 'num')}<th class="num">連勝</th><th class="num">趨勢</th></tr></thead>
        <tbody id="standings-tbody">${renderStandingsRows()}</tbody>
      </table>
    </div>`;

  async function draftAiStep() {
    if (D.league?.draftDone || D.draftState?.isMyTurn) {
      stopDraftAutoAdvance();
      await refreshData();
      mount();
      return;
    }
    try {
      const res = await api('/api/draft/ai-advance');
      if (res?.state) {
        D.draftState = D.draftState || {};
        D.draftState.round = res.state.current_round || 1;
        D.draftState.teams = res.state.teams || [];
        D.draftState.picks = res.state.picks || [];
        D.draftState.isMyTurn = res.state.current_team_id === res.state.human_team_id;
        D.draftState.humanTeamId = res.state.human_team_id;
        D.draftState.currentTeamId = res.state.current_team_id;
        D.league.draftDone = res.state.is_complete ?? false;
      }
      if (res?.pick?.player_id != null) {
        D.draftPlayers = (D.draftPlayers || []).filter(p => p.id !== res.pick.player_id);
      }
      const rail = document.querySelector('.rail');
      if (rail) rail.innerHTML = renderDraftBoard();
      const tbody = document.getElementById('draft-player-tbody');
      if (tbody) tbody.innerHTML = renderDraftPlayerRows(D.draftPlayers || [], D.draftState?.isMyTurn);
      const statusEl = document.getElementById('draft-auto-status');
      if (statusEl) statusEl.textContent = D.draftState?.isMyTurn ? '輪到你了！' : 'AI 正在選秀…';
      if (D.league?.draftDone || D.draftState?.isMyTurn) {
        stopDraftAutoAdvance();
        await refreshData();
        mount();
      }
    } catch (e) {
      stopDraftAutoAdvance();
      await refreshData();
      mount();
    }
  }

  function startDraftAutoAdvance() {
    if (draftAutoTimer) return;
    if (D.league?.draftDone || D.draftState?.isMyTurn) return;
    draftAutoTimer = setInterval(draftAiStep, draftSpeed);
  }

  function stopDraftAutoAdvance() {
    if (draftAutoTimer) { clearInterval(draftAutoTimer); draftAutoTimer = null; }
  }

  // ---------- DRAFT ----------
  function renderDraftRecap() {
    const picks = D.draftState && D.draftState.picks;
    if (picks && picks.length) {
      const rows = picks.map(p => `
        <tr>
          <td class="num">${p.overall}</td>
          <td class="num">${p.round}</td>
          <td>${p.teamName}</td>
          <td>${p.playerName}</td>
          <td><span class="pos-tag" data-pos="${p.pos}">${p.pos}</span></td>
        </tr>`).join('');
      return `
        <div class="view-head">
          <div class="view-title-block">
            <span class="eyebrow">選秀廳 · 已結束</span>
            <div class="view-title">選秀回顧</div>
          </div>
        </div>
        <div class="card">
          <table class="standings-table">
            <thead><tr><th>順位</th><th>輪次</th><th>球隊</th><th>球員</th><th>位置</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }
    // fallback: show user's own roster
    const myPicks = D.roster.map((p, i) => `
      <tr>
        <td class="num">${i + 1}</td>
        <td>${p.name}</td>
        <td><span class="pos-tag" data-pos="${p.pos}">${p.pos}</span></td>
        <td>${p.team}</td>
      </tr>`).join('');
    return `
      <div class="view-head">
        <div class="view-title-block">
          <span class="eyebrow">選秀廳 · 已結束</span>
          <div class="view-title">你的選秀陣容</div>
        </div>
      </div>
      <div class="card">
        <table class="standings-table">
          <thead><tr><th>#</th><th>球員</th><th>位置</th><th>球隊</th></tr></thead>
          <tbody>${myPicks}</tbody>
        </table>
      </div>`;
  }

  function renderDraftPlayerRows(players, isMyTurn, filterPos, filterQ) {
    let list = players;
    if (filterQ) { const q = filterQ.toLowerCase(); list = list.filter(p => p.name.toLowerCase().includes(q) || p.team.toLowerCase().includes(q)); }
    if (filterPos) list = list.filter(p => p.pos === filterPos);
    list = list.slice(0, 100);
    if (!list.length) return '<tr><td colspan="6" style="text-align:center;color:var(--ink-3);padding:20px">沒有符合的球員</td></tr>';
    return list.map((p, i) => `
      <tr>
        <td><span class="mono" style="color:var(--ink-3);font-size:11px">${p.rank}</span></td>
        <td><div style="display:flex;align-items:center;gap:8px">${av(p.name, (p.id % 8) + 1, 'sm')}<span>${p.name}</span></div></td>
        <td><span class="pos-tag" data-pos="${p.pos}">${p.pos || '—'}</span></td>
        <td style="color:var(--ink-3);font-size:var(--fs-sm)">${p.team}</td>
        <td class="num">${p.fppg.toFixed(1)}</td>
        <td>${isMyTurn ? `<button class="btn sm ghost" data-draft-pick="${p.id}">選</button>` : ''}</td>
      </tr>`).join('');
  }

  views.draft = () => {
    if (D.league.draftDone) return renderDraftRecap();
    const ds = D.draftState;
    const needs = (ds.needs || []).map(n => `
      <div class="need-cell ${n.need==='high'?'short':''}">
        <div class="np">${n.pos}</div>
        <div class="nc">${n.filled}/${n.target}</div>
      </div>`).join('');

    return `
      <div class="view-head">
        <div class="view-title-block">
          <span class="eyebrow">選秀廳 · 第 ${ds.round} 輪</span>
          <div class="view-title">你的第 ${ds.pickOverall} 順位</div>
          <div id="draft-auto-status" style="font-size:var(--fs-sm);color:${ds.isMyTurn ? 'var(--good)' : 'var(--ink-3)'};margin-top:4px;font-family:var(--mono)">${ds.isMyTurn ? '輪到你了！' : 'AI 正在選秀…'}</div>
        </div>
        <div class="view-actions" style="align-items:center;gap:12px">
          <div class="segmented" id="draft-speed-seg">
            <button data-speed="1500">慢</button>
            <button data-speed="800" aria-pressed="true">正常</button>
            <button data-speed="200">快</button>
          </div>
          ${!ds.isMyTurn ? '<button class="btn ghost" id="draft-skip-to-me">跳到我的回合</button>' : ''}
        </div>
      </div>

      <div class="draft-top">
        <div class="draft-clock">
          <div class="dc-eyebrow">
            <span class="live">LIVE · 第 ${ds.round} 輪 第 ${ds.pickInRound} 順位</span>
            <span class="pick-num">你的第 1 支籤</span>
          </div>
          <h2>剩 ${ds.timeLeft} 秒</h2>
        </div>
        <div class="needs-strip">
          <div class="needs-head">目前陣容缺口</div>
          <div class="needs-grid">${needs}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <h3>可選球員 (${D.draftPlayers?.length || 0})</h3>
          <span class="sub">依 FPPG 排序</span>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <input type="text" id="draft-search" placeholder="搜尋球員或球隊…" style="flex:1;min-width:160px;background:var(--surface);border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:6px 10px;font-size:var(--fs-sm);font-family:var(--sans)"/>
          <div class="segmented" id="draft-pos-seg" style="flex-shrink:0">
            <button data-val="" aria-pressed="true">全部</button>
            <button data-val="PG">PG</button>
            <button data-val="SG">SG</button>
            <button data-val="SF">SF</button>
            <button data-val="PF">PF</button>
            <button data-val="C">C</button>
          </div>
        </div>
        <table class="standings-table" id="draft-player-table">
          <thead><tr>
            <th style="width:36px">#</th>
            <th>球員</th>
            <th>位置</th>
            <th>球隊</th>
            <th class="num">FPPG</th>
            <th></th>
          </tr></thead>
          <tbody id="draft-player-tbody">${renderDraftPlayerRows(D.draftPlayers || [], D.draftState?.isMyTurn)}</tbody>
        </table>
      </div>
    `;
  };

  // ---------- TRADE ----------
  let activeThread = 't1';
  views.trade = () => {
    if (!D.tradeThreads.length) {
      return `
    <div class="view-head">
      <div class="view-title-block">
        <span class="eyebrow">交易中心</span>
        <div class="view-title">交易對話</div>
        <div class="view-sub">目前沒有進行中的交易</div>
      </div>
      <div class="view-actions"><button class="btn" id="new-trade-btn">發起交易 ${I.plus}</button></div>
    </div>
    <div class="empty-state" style="margin-top:40px">
      <div style="font-size:32px;margin-bottom:12px">🤝</div>
      <div>目前沒有交易提案</div>
      <div style="margin-top:8px;font-size:12px;color:var(--ink-3)">AI GM 會主動發起交易，或你也可以發起</div>
      <div style="margin-top:4px;font-size:12px;color:var(--ink-3)">⚠️ 本聯盟不支援選秀權交易，僅限球員交換</div>
    </div>`;
    }
    const thread = D.tradeThreads.find(t => t.id === activeThread) || D.tradeThreads[0];

    const threadList = D.tradeThreads.map(t => `
      <div class="ts-row ${t.id===activeThread?'active':''}" data-thread="${t.id}">
        ${av(t.with, t.grad)}
        <div>
          <div class="ts-name">${t.with} · ${t.team}</div>
          <div class="ts-preview">${t.preview}</div>
          <div class="ts-fit ${t.fit==='mid'?'mid':t.fit==='low'?'low':''}">Fit · ${t.fit}</div>
        </div>
        <div class="ts-time">${t.time}</div>
      </div>`).join('');

    const msgs = thread.msgs.map(m => {
      if (m.type === 'proposal') {
        return `<div class="proposal">
          <div class="proposal-head"><span>交易提案 <span class="proposal-id">${m.id}</span></span><span>${m.from} 提出</span></div>
          <div class="prop-sides">
            <div class="prop-side">
              <div class="prop-side-head">他給你</div>
              <ul>${m.theirs.map(p => `<li><span class="pn">${p.n}</span><span class="pos-tag" data-pos="${p.p}">${p.p}</span></li>`).join('')}</ul>
            </div>
            <div class="prop-arrow">${I.arrow}</div>
            <div class="prop-side mine">
              <div class="prop-side-head">你給他</div>
              <ul>${m.mine.map(p => `<li><span class="pn">${p.n}</span><span class="pos-tag" data-pos="${p.p}">${p.p}</span></li>`).join('')}</ul>
            </div>
          </div>
          <div style="display:flex;gap:8px;justify-content:center;margin-top:6px"><button class="btn sm" data-trade-accept="${m.id}">接受</button><button class="btn sm ghost">還價</button><button class="btn sm subtle" data-trade-reject="${m.id}">拒絕</button></div>
        </div>`;
      }
      if (m.type === 'system') {
        return `<div class="bubble-system" style="text-align:center;font-size:11px;color:var(--ink-3);padding:8px 0;font-family:var(--mono)">${m.text}</div>`;
      }
      return `<div class="bubble-row ${m.from}">
        <div class="bubble ${m.from}">${m.text}</div>
        <div class="bubble-meta">${m.time}</div>
      </div>`;
    }).join('');

    return `
      <div class="view-head">
        <div class="view-title-block">
          <span class="eyebrow">交易中心</span>
          <div class="view-title">你與 ${thread.with} 的對話</div>
          <div class="view-sub">${D.tradeThreads.filter(t=>t.unread).length} 則未讀 · 截止 本週四 23:59</div>
        </div>
        <div class="view-actions"><button class="btn" id="new-trade-btn">發起交易 ${I.plus}</button></div>
      </div>

      <div class="trade-grid">
        <div class="trade-sidebar">
          <div class="ts-head"><h3>對話列表</h3></div>
          <div class="ts-list">${threadList}</div>
        </div>

        <div class="trade-chat">
          <div class="tc-head">
            ${av(thread.with, thread.grad)}
            <div>
              <div style="font-weight:600;font-size:var(--fs-sm)">${thread.with} · ${thread.team}</div>
              <div style="font-size:11px;color:var(--ink-3);font-family:var(--mono);text-transform:uppercase;letter-spacing:0.05em">Persona · ${thread.persona}</div>
            </div>
            <span class="pill accent" style="margin-left:auto">Fit · ${thread.fit}</span>
          </div>
          <div class="tc-body" id="chat-body">${msgs}</div>
          <div class="tc-composer">
            <input type="text" placeholder="輸入訊息…（AI 會模擬 ${thread.with} 回覆）" id="chat-input"/>
            <button class="btn" id="chat-send">${I.send}</button>
          </div>
        </div>

        <div class="trade-ledger">
          <div class="tl-head"><h3>AI 交易分析</h3></div>
          <div class="tl-body">
            <div class="tl-verdict"><div class="tl-verdict-head">結論 · <b>建議接受</b></div>
            <div>Siakam 穩定的多類別產能會補你 PF 的空缺；他一週出賽 4 場、你下週表格只有 2 場空。</div></div>
            <div class="tl-section">
              <h4>五類別勝率</h4>
              ${[['得分',0.42,0.58],['籃板',0.38,0.62],['助攻',0.55,0.45],['阻攻',0.48,0.52],['效率',0.44,0.56]]
                .map(([l,a,b]) => `
                  <div class="tl-bar"><div class="l">${(a*100).toFixed(0)}</div><div class="tl-bar-track"><div class="tl-bar-mine" style="width:${a*100}%"></div><div class="tl-bar-theirs" style="width:${b*100}%"></div></div><div class="r">${(b*100).toFixed(0)}</div></div>
                  <div style="font-size:10px;color:var(--ink-3);margin:-4px 0 8px;text-align:center;font-family:var(--mono);text-transform:uppercase">${l}</div>`).join('')}
            </div>
            <div class="tl-section">
              <h4>風險</h4>
              <div class="tl-verdict risk"><div class="tl-verdict-head">注意 · <b>KP 健康</b></div><div>你把傷兵 Porziņģis 送出的時機得抓好——他下週若復出會影響交易觀感。</div></div>
            </div>
          </div>
        </div>
      </div>
    `;
  };

  // ---------- FA ----------
  views.fa = () => `
    <div class="view-head">
      <div class="view-title-block">
        <span class="eyebrow">自由球員 · Waivers</span>
        <div class="view-title">自由球員市場</div>
        <div class="view-sub">週三 03:00 處理認領 · 你剩 $${D.faab.budget - D.faab.spent} FAAB 預算（本季固定 $${D.faab.budget}）</div>
      </div>
      <div class="view-actions"><div class="segmented"><button aria-pressed="true">熱門</button><button>全部</button><button>本週多賽</button></div></div>
    </div>

    <div class="fa-search-bar">
      ${I.fa}
      <input type="text" placeholder="搜尋球員、隊伍、位置…"/>
      <span class="kbd">⌘K</span>
    </div>

    <div class="card">
      <table class="standings-table">
        <thead><tr><th>球員</th><th>位置</th><th>近況</th><th class="num">持有率</th><th class="num">趨勢</th><th>備註</th><th></th></tr></thead>
        <tbody>${D.freeAgents.map(p => `
          <tr>
            <td><div style="display:flex;align-items:center;gap:10px">${av(p.name, p.grad, 'sm')}<div><div style="font-weight:500">${p.name}</div><div style="font-size:11px;color:var(--ink-3);font-family:var(--mono)">${p.team}</div></div></div></td>
            <td><span class="pos-tag" data-pos="${p.pos}">${p.pos}</span></td>
            <td><div class="slot-form">${p.form.map(f => `<div class="spark ${f===1?'hot':f===0?'warm':'cold'}"></div>`).join('')}</div></td>
            <td class="num">${p.owned}%</td>
            <td class="num"><span class="pill ${p.trend==='up'?'good':p.trend==='down'?'bad':''}">${p.trend==='up'?'↑':p.trend==='down'?'↓':'→'}</span></td>
            <td style="color:var(--ink-2);font-size:var(--fs-xs)">${p.note}</td>
            <td><button class="btn sm" data-fa-claim="${p.playerId ?? p.id}">認領</button></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;

  // ---------- SCHEDULE ----------
  views.schedule = () => {
    const schedData = D.schedule || [];
    return `
    <div class="view-head">
      <div class="view-title-block">
        <span class="eyebrow">整季排程</span>
        <div class="view-title">2024-25 · 21 週</div>
        <div class="view-sub">13 場已打、3 場待打、4 場季後賽</div>
      </div>
    </div>
    <div class="week-grid">${schedData.map(w => {
      const cls = w.result === 'W' ? 'won' : w.result === 'L' ? 'lost'
        : w.result === 'current' ? 'current' : w.result === 'playoff' ? 'playoff' : 'future';
      return `<div class="week-cell ${cls}">
        <div class="wn">W${w.w}</div>
        <div class="wscore">${w.score}</div>
        <div style="font-size:11px;font-weight:500;margin-top:4px">${w.opp.team}</div>
        <div style="font-size:10px;color:var(--ink-3);font-family:var(--mono)">${w.opp.owner}</div>
      </div>`;
    }).join('')}</div>

    <div style="margin-top:var(--s-7)" class="card card-pad">
      <div style="display:flex;gap:var(--s-5);flex-wrap:wrap;align-items:center;font-size:var(--fs-xs);color:var(--ink-3)">
        <span style="display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:3px;box-shadow:inset 0 0 0 1px rgba(74,222,128,0.3)"></span>勝</span>
        <span style="display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:3px;box-shadow:inset 0 0 0 1px rgba(248,113,113,0.2)"></span>敗</span>
        <span style="display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:3px;background:var(--accent-14);box-shadow:inset 0 0 0 1px var(--accent)"></span>本週</span>
        <span style="display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:3px;border:1px dashed var(--pg)"></span>季後賽</span>
      </div>
    </div>`;
  };

  // ---------- NEWS ----------
  views.news = () => {
    const kindLabel = {injury:'傷兵',heat:'熱議',league:'聯盟',quote:'引言',milestone:'里程碑',matchup:'對戰'};
    return `
      <div class="view-head">
        <div class="view-title-block">
          <span class="eyebrow">聯盟動態</span>
          <div class="view-title">News Feed</div>
          <div class="view-sub">球員即時消息 + 聯盟內部對話</div>
        </div>
        <div class="view-actions">
          <div class="segmented"><button aria-pressed="true">全部</button><button>傷兵</button><button>熱議</button><button>引言</button></div>
        </div>
      </div>
      <div class="card">
        ${D.news.concat(D.news).map((n,i) => `
          <div style="display:grid;grid-template-columns:32px 80px 1fr;gap:var(--s-4);padding:var(--s-4) var(--s-5);${i<15?'border-bottom:1px solid var(--line-soft)':''}">
            <div class="news-dot" data-kind="${n.kind}">${({injury:'🩹',heat:'🔥',league:'📎',quote:'"',milestone:'★',matchup:'⚔'})[n.kind]}</div>
            <div style="font-size:11px;color:var(--ink-3);font-family:var(--mono);text-transform:uppercase;letter-spacing:0.06em;padding-top:6px">${kindLabel[n.kind]}</div>
            <div>
              ${n.kind === 'quote'
                ? `<div class="news-quote" style="font-size:var(--fs-md)">${n.quote}</div><div class="news-attrib">— ${n.attrib}</div>`
                : `<div style="font-size:var(--fs-md);font-weight:500">${n.title}</div>`}
              <div class="news-meta" style="margin-top:6px">${n.meta}</div>
            </div>
          </div>`).join('')}
      </div>`;
  };

  // ========================================================
  // ROUTER
  // ========================================================
  function currentRoute() {
    const h = (location.hash || '#/home').replace(/^#\/?/, '');
    return h || 'home';
  }

  function mount() {
    stopDraftAutoAdvance();
    const r = currentRoute();
    const view = views[r] || views.home;
    const main = $('#main');
    main.innerHTML = view();
    main.scrollTop = 0;
    window.scrollTo(0, 0);
    renderNav();
    renderRail();
    bindViewEvents();
  }

  function bindViewEvents() {
    // Sortable tables — scope by data-table to avoid cross-view collisions
    $$('th[data-table][data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const table = th.dataset.table;
        const key = th.dataset.sort;
        const sortState = table === 'standings' ? standingsSort : rosterSort;
        if (sortState.key === key) {
          sortState.dir = sortState.dir === 'desc' ? 'asc' : 'desc';
        } else {
          sortState.key = key;
          sortState.dir = 'desc';
        }

        if (table === 'standings') {
          const tbody = document.getElementById('standings-tbody');
          if (!tbody) return;
          tbody.innerHTML = renderStandingsRows();
          syncSortHeaders('standings');
          return;
        }

        // Re-render only the tbody to avoid full mount()
        const tbody = document.getElementById('roster-tbody');
        if (!tbody) return;
        // Re-run the roster view and extract its tbody content
        const tmp = document.createElement('div');
        tmp.innerHTML = views.roster();
        const newTbody = tmp.querySelector('#roster-tbody');
        if (newTbody) tbody.innerHTML = newTbody.innerHTML;
        // Refresh headers
        const newTable = tmp.querySelector('table');
        const oldTable = tbody.closest('table');
        if (newTable && oldTable) {
          const oldThead = oldTable.querySelector('thead');
          const newThead = newTable.querySelector('thead');
          if (oldThead && newThead) oldThead.innerHTML = newThead.innerHTML;
        }
        bindViewEvents();
      });
    });

    // Roster drag-and-drop
    const rosterTbody = document.getElementById('roster-tbody');
    if (rosterTbody) {
      let dragId = null;
      const STARTER_SLOTS = new Set(['PG','SG','G','SF','PF','F','C','UTIL']);
      rosterTbody.addEventListener('dragstart', e => {
        const row = e.target.closest('tr[data-player-id]');
        if (!row) return;
        dragId = parseInt(row.dataset.playerId);
        row.style.opacity = '0.4';
        e.dataTransfer.effectAllowed = 'move';
      });
      rosterTbody.addEventListener('dragend', () => {
        rosterTbody.querySelectorAll('tr').forEach(r => { r.style.opacity = ''; r.style.outline = ''; });
      });
      rosterTbody.addEventListener('dragover', e => {
        e.preventDefault();
        const row = e.target.closest('tr[data-player-id]');
        rosterTbody.querySelectorAll('tr').forEach(r => r.style.outline = '');
        if (row) row.style.outline = '2px solid var(--accent)';
      });
      rosterTbody.addEventListener('drop', async e => {
        e.preventDefault();
        rosterTbody.querySelectorAll('tr').forEach(r => { r.style.outline = ''; r.style.opacity = ''; });
        const row = e.target.closest('tr[data-player-id]');
        if (!row || !dragId) return;
        const targetId = parseInt(row.dataset.playerId);
        if (targetId === dragId) return;
        const roster = D.roster || [];
        const starters = roster.filter(p => STARTER_SLOTS.has(p.slot)).map(p => p.id);
        const draggedP = roster.find(p => p.id === dragId);
        const targetP = roster.find(p => p.id === targetId);
        const dragIsStarter = draggedP && STARTER_SLOTS.has(draggedP.slot);
        const targetIsStarter = targetP && STARTER_SLOTS.has(targetP.slot);
        let newStarters;
        if (dragIsStarter && targetIsStarter) {
          newStarters = starters; // same set, backend re-assigns slots
        } else if (!dragIsStarter && targetIsStarter) {
          newStarters = starters.map(id => id === targetId ? dragId : id);
        } else if (dragIsStarter && !targetIsStarter) {
          newStarters = starters.filter(id => id !== dragId);
          if (targetP && targetP.slot !== 'IR') newStarters.push(targetId);
        } else {
          return;
        }
        try {
          await api('/api/season/lineup', { method: 'POST', body: JSON.stringify({ starters: newStarters, today_only: false }) });
          await refreshData(); mount();
        } catch (err) { toast('調整失敗：' + err.message, 'error'); }
      });
    }

    // Trade thread clicks
    $$('.ts-row[data-thread]').forEach(row => {
      row.addEventListener('click', () => {
        activeThread = row.dataset.thread;
        mount();
      });
    });
    document.getElementById('new-trade-btn')?.addEventListener('click', () => {
      toast('功能開發中：AI GM 會主動發起交易提案', 'info');
    });
    // Action item: go to relevant page
    $$('.action-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.action;
        if (id === 'a1') location.hash = '#/roster';
        else if (id === 'a2') { activeThread = 't1'; location.hash = '#/trade'; }
        else if (id === 'a3') location.hash = '#/fa';
        else if (id === 'a4') location.hash = '#/schedule';
      });
    });
    // Advance day / week
    const advDay = $('#adv-day');
    if (advDay) {
      advDay.addEventListener('click', async () => {
        advDay.disabled = true;
        try {
          const res = await fetch('/api/season/advance-day', { method: 'POST' });
          if (res.ok) {
            toast('已推進一天', 'success');
            await refreshData();
            mount();
          }
          else toast('推進失敗：' + res.status, 'error');
        } catch (e) {
          toast('推進失敗：' + e.message, 'error');
        } finally {
          advDay.disabled = false;
        }
      });
    }
    const advWeek = $('#adv-week');
    if (advWeek) {
      advWeek.addEventListener('click', async () => {
        advWeek.disabled = true;
        try {
          const res = await fetch('/api/season/advance-week', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ use_ai: false })
          });
          if (res.ok) {
            toast('已推進一週', 'success');
            await refreshData();
            mount();
          }
          else toast('推進失敗：' + res.status, 'error');
        } catch (e) {
          toast('推進失敗：' + e.message, 'error');
        } finally {
          advWeek.disabled = false;
        }
      });
    }
    // Draft pick
    $$('button[data-reco]').forEach(btn => {
      btn.addEventListener('click', () => toast(`已選擇 ${btn.dataset.reco}`, 'success'));
    });
    // Chat send
    const sendBtn = $('#chat-send');
    if (sendBtn) {
      const doSend = async () => {
        const input = $('#chat-input');
        const t = (input.value || '').trim();
        if (!t) return;
        const body = $('#chat-body');
        body.append(
          h('div', {class:'bubble-row me'},
            h('div', {class:'bubble me'}, t),
            h('div', {class:'bubble-meta'}, '剛剛')
          )
        );
        input.value = '';
        body.scrollTop = body.scrollHeight;
        try {
          await api(`/api/trades/${activeThread}/message`, {
            method: 'POST',
            body: JSON.stringify({ body: t }),
          });
          await refreshData();
          mount();
        } catch (e) {
          toast('發送失敗：' + e.message, 'error');
        }
      };
      sendBtn.addEventListener('click', doSend);
      $('#chat-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') doSend(); });
    }

    // FA claim button
    document.querySelectorAll('[data-fa-claim]').forEach(btn => {
      btn.addEventListener('click', () => {
        const addId = Number(btn.dataset.faClaim);
        const dropOpts = (D.roster || []).map(p => `<option value="${p.playerId}">${p.name} (${p.pos})</option>`).join('');
        $('#modal-card').innerHTML = `
          <div class="modal-head"><h3>認領球員</h3><button class="modal-close" id="modal-close-btn">✕</button></div>
          <div style="display:flex;flex-direction:column;gap:16px;padding-top:8px">
            <div><div class="eyebrow" style="margin-bottom:8px">FAAB 出價 (剩 $${(D.faab?.budget||100)-(D.faab?.spent||0)})</div>
              <input type="number" id="fa-bid" value="0" min="0" max="${(D.faab?.budget||100)-(D.faab?.spent||0)}"
                style="width:100%;background:var(--surface);border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:8px 10px;font-size:var(--fs-sm);font-family:var(--sans)"/></div>
            <div><div class="eyebrow" style="margin-bottom:8px">下架球員</div>
              <select id="fa-drop" style="width:100%;background:var(--surface);border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:8px 10px;font-size:var(--fs-sm);font-family:var(--sans)">${dropOpts}</select></div>
            <button class="btn" id="fa-submit" style="width:100%;justify-content:center">送出認領</button>
          </div>`;
        $('#modal-bd').classList.add('open');
        $('#modal-close-btn').addEventListener('click', () => $('#modal-bd').classList.remove('open'));
        $('#fa-submit').addEventListener('click', async () => {
          const submitBtn = $('#fa-submit');
          submitBtn.disabled = true;
          try {
            await api('/api/fa/claim', {
              method: 'POST',
              body: JSON.stringify({
                add_player_id: addId,
                drop_player_id: Number($('#fa-drop').value),
                bid: Number($('#fa-bid').value || 0),
              }),
            });
            $('#modal-bd').classList.remove('open');
            toast('認領已提交！', 'success');
            await refreshData();
            mount();
          } catch (e) {
            toast('認領失敗：' + e.message, 'error');
            submitBtn.disabled = false;
          }
        });
      });
    });

    // Trade accept/reject buttons
    document.querySelectorAll('[data-trade-accept]').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api(`/api/trades/${btn.dataset.tradeAccept}/accept`, { method: 'POST' });
          toast('已接受交易！', 'success');
          await refreshData();
          mount();
        } catch (e) {
          toast('接受失敗：' + e.message, 'error');
          btn.disabled = false;
        }
      });
    });
    document.querySelectorAll('[data-trade-reject]').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api(`/api/trades/${btn.dataset.tradeReject}/reject`, { method: 'POST' });
          toast('已拒絕交易', 'success');
          await refreshData();
          mount();
        } catch (e) {
          toast('拒絕失敗：' + e.message, 'error');
          btn.disabled = false;
        }
      });
    });

    // Draft pick handler
    document.querySelectorAll('[data-draft-pick]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const pid = parseInt(btn.dataset.draftPick);
        btn.disabled = true;
        try {
          await api('/api/draft/pick', { method: 'POST', body: JSON.stringify({ player_id: pid }) });
          await refreshData();
          mount();
        } catch (e) {
          toast('選秀失敗：' + e.message, 'error');
          btn.disabled = false;
        }
      });
    });

    const speedSeg = document.getElementById('draft-speed-seg');
    if (speedSeg) {
      speedSeg.addEventListener('click', e => {
        const btn = e.target.closest('button[data-speed]');
        if (!btn) return;
        speedSeg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', 'false'));
        btn.setAttribute('aria-pressed', 'true');
        draftSpeed = parseInt(btn.dataset.speed);
        if (draftAutoTimer) { stopDraftAutoAdvance(); startDraftAutoAdvance(); }
      });
    }

    const skipBtn = document.getElementById('draft-skip-to-me');
    if (skipBtn) {
      skipBtn.addEventListener('click', async () => {
        stopDraftAutoAdvance();
        skipBtn.disabled = true;
        skipBtn.textContent = '跳轉中…';
        try {
          await api('/api/draft/sim-to-me', { method: 'POST' });
          await refreshData();
          mount();
        } catch (e) {
          toast('跳轉失敗：' + e.message, 'error');
          skipBtn.disabled = false;
          skipBtn.textContent = '跳到我的回合';
        }
      });
    }

    if (!D.league?.draftDone && !D.draftState?.isMyTurn && document.getElementById('draft-player-tbody')) {
      startDraftAutoAdvance();
    }

    // Draft search/filter
    const draftSearch = document.getElementById('draft-search');
    const draftPosSeg = document.getElementById('draft-pos-seg');
    function _rerenderDraftTable() {
      const tbody = document.getElementById('draft-player-tbody');
      if (!tbody) return;
      const q = draftSearch?.value || '';
      const pos = draftPosSeg?.querySelector('[aria-pressed="true"]')?.dataset.val || '';
      tbody.innerHTML = renderDraftPlayerRows(D.draftPlayers || [], D.draftState?.isMyTurn, pos, q);
      // Re-wire pick buttons
      tbody.querySelectorAll('[data-draft-pick]').forEach(b => {
        b.addEventListener('click', async () => {
          const pid = parseInt(b.dataset.draftPick);
          b.disabled = true;
          try {
            await api('/api/draft/pick', { method: 'POST', body: JSON.stringify({ player_id: pid }) });
            await refreshData(); mount();
          } catch (e) { toast('選秀失敗：' + e.message, 'error'); b.disabled = false; }
        });
      });
    }
    if (draftSearch) draftSearch.addEventListener('input', _rerenderDraftTable);
    if (draftPosSeg) draftPosSeg.addEventListener('click', e => {
      const b = e.target.closest('button[data-val]');
      if (!b) return;
      draftPosSeg.querySelectorAll('button[data-val]').forEach(x => x.setAttribute('aria-pressed','false'));
      b.setAttribute('aria-pressed','true');
      _rerenderDraftTable();
    });
  }

  function openNewLeagueModal() {
    $('#modal-card').innerHTML = `
      <div class="modal-head">
        <h3>開新聯盟</h3>
        <button class="modal-close" id="modal-close-btn">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:20px;padding-top:4px">
        <div>
          <div class="eyebrow" style="margin-bottom:8px">聯盟名稱</div>
          <input type="text" id="nl-name" placeholder="我的聯盟" maxlength="30"
            style="width:100%;background:var(--surface);border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:8px 10px;font-size:var(--fs-sm);font-family:var(--sans)"/>
        </div>
        <div>
          <div class="eyebrow" style="margin-bottom:8px">隊伍數</div>
          <div class="segmented" id="nl-teams-seg">
            <button data-val="8" aria-pressed="true">8 隊</button>
            <button data-val="10">10 隊</button>
            <button data-val="12">12 隊</button>
          </div>
        </div>
        <div>
          <div class="eyebrow" style="margin-bottom:8px">賽季</div>
          <select id="nl-season-sel" style="width:100%;background:var(--surface);border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:8px 10px;font-size:var(--fs-sm);font-family:var(--sans)">
            ${Array.from({length:30},(_,i)=>{const y=2025-i;const s=`${y}-${String((y+1)%100).padStart(2,'0')}`;return`<option value="${s}"${i===0?' selected':''}>${s}</option>`;}).join('')}
          </select>
        </div>
        <div>
          <div class="eyebrow" style="margin-bottom:8px">AI 選秀資訊</div>
          <div class="segmented" id="nl-mode-seg">
            <button data-val="prev_full" aria-pressed="true">公平模式</button>
            <button data-val="current_full">天眼模式</button>
          </div>
          <div style="font-size:11px;color:var(--ink-3);margin-top:8px;line-height:1.5">
            公平：AI 不看 fppg，只憑位置/年齡判斷。天眼：AI 知道本季實際表現。
          </div>
        </div>
        <div>
          <div class="eyebrow" style="margin-bottom:8px">選秀順序</div>
          <div class="segmented" id="nl-draft-order-seg">
            <button data-val="false" aria-pressed="true">固定順序</button>
            <button data-val="true">隨機</button>
          </div>
        </div>
        <div>
          <div class="eyebrow" style="margin-bottom:8px">計分權重</div>
          <div class="segmented" id="nl-scoring-seg">
            <button data-val="default" aria-pressed="true">預設</button>
            <button data-val="high_ast">重助攻</button>
            <button data-val="balanced">均衡</button>
          </div>
        </div>
        <div>
          <div class="eyebrow" style="margin-bottom:8px">交易截止週</div>
          <div class="segmented" id="nl-deadline-seg">
            <button data-val="null" aria-pressed="true">無截止</button>
            <button data-val="10">W10</button>
            <button data-val="12">W12</button>
          </div>
        </div>
        <div>
          <div class="eyebrow" style="margin-bottom:8px">AI 交易頻率</div>
          <div class="segmented" id="nl-ai-trade-seg">
            <button data-val="off">關閉</button>
            <button data-val="low">低</button>
            <button data-val="normal" aria-pressed="true">正常</button>
            <button data-val="high">高</button>
          </div>
        </div>
        <div>
          <div class="eyebrow" style="margin-bottom:8px">否決期</div>
          <div class="segmented" id="nl-veto-seg">
            <button data-val="1">1 天</button>
            <button data-val="2" aria-pressed="true">2 天</button>
            <button data-val="3">3 天</button>
          </div>
        </div>
        <button class="btn" id="nl-submit" style="width:100%;justify-content:center">建立聯盟</button>
      </div>`;
    $('#modal-bd').classList.add('open');
    $('#modal-close-btn').addEventListener('click', () => $('#modal-bd').classList.remove('open'));
    ['#nl-teams-seg', '#nl-mode-seg', '#nl-draft-order-seg', '#nl-scoring-seg', '#nl-deadline-seg', '#nl-ai-trade-seg', '#nl-veto-seg'].forEach(sel => {
      $(sel).addEventListener('click', e => {
        const btn = e.target.closest('button[data-val]');
        if (!btn) return;
        $(sel).querySelectorAll('button[data-val]').forEach(b => b.setAttribute('aria-pressed', 'false'));
        btn.setAttribute('aria-pressed', 'true');
      });
    });
    $('#nl-submit').addEventListener('click', async () => {
      const submitBtn = $('#nl-submit');
      submitBtn.disabled = true;
      try {
        const name = $('#nl-name')?.value?.trim() || '我的聯盟';
        const teams = parseInt($('#nl-teams-seg [aria-pressed="true"]')?.dataset.val || '8');
        const season = $('#nl-season-sel')?.value || '2025-26';
        const mode = $('#nl-mode-seg [aria-pressed="true"]')?.dataset.val || 'prev_full';
        const randomDraft = $('#nl-draft-order-seg [aria-pressed="true"]')?.dataset.val === 'true';
        const deadline = $('#nl-deadline-seg [aria-pressed="true"]')?.dataset.val;
        const aiFreq = $('#nl-ai-trade-seg [aria-pressed="true"]')?.dataset.val || 'normal';
        const vetodays = parseInt($('#nl-veto-seg [aria-pressed="true"]')?.dataset.val || '2');
        const scoringPresets = {
          default:  { pts:1.0, reb:1.2, ast:1.5, stl:2.5, blk:2.5, to:-1.0 },
          high_ast: { pts:1.0, reb:1.2, ast:2.0, stl:2.5, blk:2.5, to:-1.0 },
          balanced: { pts:1.0, reb:1.0, ast:1.0, stl:1.5, blk:1.5, to:-1.0 },
        };
        const scoring = scoringPresets[$('#nl-scoring-seg [aria-pressed="true"]')?.dataset.val || 'default'];
        const res = await fetch('/api/league/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            league_name: name,
            num_teams: teams,
            season_year: season,
            roster_size: 13,
            draft_display_mode: mode,
            randomize_draft_order: randomDraft,
            scoring_weights: scoring,
            trade_deadline_week: deadline === 'null' ? null : parseInt(deadline),
            ai_trade_frequency: aiFreq,
            veto_window_days: vetodays,
          }),
        });
        if (res.ok) {
          $('#modal-bd').classList.remove('open');
          toast('新聯盟已建立，前往選秀廳！', 'success');
          await refreshData();
          location.hash = '#/draft';
          mount();
        } else {
          const err = await res.json().catch(() => ({}));
          const msg = Array.isArray(err.detail?.errors) ? err.detail.errors.join('、') : (typeof err.detail === 'string' ? err.detail : res.status);
          toast('建立失敗：' + msg, 'error');
          submitBtn.disabled = false;
        }
      } catch (e) {
        toast('建立失敗：' + e.message, 'error');
        submitBtn.disabled = false;
      }
    });
  }

  // ========================================================
  // CMD-K palette
  // ========================================================
  const cmdItems = [
    { group:'跳頁' },
    { icon:I.home, label:'今日總覽', hash:'#/home' },
    { icon:I.match, label:'本週對戰', hash:'#/matchup' },
    { icon:I.roster, label:'我的陣容', hash:'#/roster' },
    { icon:I.trade, label:'交易中心', hash:'#/trade' },
    { icon:I.fa, label:'自由球員', hash:'#/fa' },
    { icon:I.draft, label:'選秀廳', hash:'#/draft' },
    { icon:I.league, label:'聯盟排名', hash:'#/standings' },
    { icon:I.schedule, label:'整季排程', hash:'#/schedule' },
    { icon:I.chat, label:'聯盟動態', hash:'#/news' },
    { group:'動作' },
    { icon:I.plus, label:'發起新交易', action:() => { activeThread='t1'; location.hash='#/trade'; } },
    { icon:I.sparkle, label:'建議本週最佳陣容', action:() => { location.hash='#/roster'; toast('已根據你的 9 類別聯盟設定計算最佳陣容'); } },
    { icon:I.waiver, label:'撿角：Scottie Barnes', action:() => toast('已提交認領：Scottie Barnes') },
  ];

  function openCmd() {
    const bd = $('#cmdk-bd'); bd.classList.add('open');
    $('#cmdk-q').value = ''; $('#cmdk-q').focus();
    renderCmdList('');
  }
  function closeCmd() { $('#cmdk-bd').classList.remove('open'); }
  function renderCmdList(q) {
    const filter = (q || '').toLowerCase();
    const list = $('#cmdk-list');
    const sel = 0;
    let html = ''; let idx = 0;
    cmdItems.forEach(it => {
      if (it.group) { html += `<div class="cmdk-group">${it.group}</div>`; return; }
      if (filter && !it.label.toLowerCase().includes(filter)) return;
      html += `<div class="cmdk-item" data-idx="${idx}" ${idx===sel?'aria-selected=true':''}>
        ${it.icon}<span>${it.label}</span>${it.hash?`<span class="kbd">↵</span>`:''}
      </div>`;
      idx++;
    });
    list.innerHTML = html || '<div style="padding:24px;text-align:center;color:var(--ink-3);font-size:var(--fs-sm)">沒有符合的項目</div>';

    const matches = cmdItems.filter(it => !it.group && (!filter || it.label.toLowerCase().includes(filter)));
    $$('.cmdk-item', list).forEach((el, i) => {
      el.addEventListener('click', () => {
        const it = matches[i];
        if (it.hash) location.hash = it.hash;
        if (it.action) it.action();
        closeCmd();
      });
    });
  }

  $('#cmd-open').addEventListener('click', openCmd);
  $('#cmdk-bd').addEventListener('click', e => { if (e.target.id === 'cmdk-bd') closeCmd(); });
  $('#cmdk-q').addEventListener('input', e => renderCmdList(e.target.value));
  $('#cmdk-q').addEventListener('keydown', e => {
    if (e.key === 'Escape') closeCmd();
    if (e.key === 'Enter') {
      const first = $('.cmdk-item', $('#cmdk-list'));
      if (first) first.click();
    }
  });
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openCmd(); }
    if (e.key === 'Escape') { closeCmd(); $('#modal-bd')?.classList.remove('open'); }
  });
  $('#modal-bd')?.addEventListener('click', e => { if (e.target === $('#modal-bd')) $('#modal-bd').classList.remove('open'); });

  // New league btn (header, always visible)
  $('#new-league-btn')?.addEventListener('click', openNewLeagueModal);

  // Notifications btn → modal with lineup alerts
  $('#notifications-btn')?.addEventListener('click', async () => {
    const alerts = await api('/api/season/lineup-alerts').catch(() => null);
    const items = alerts?.alerts?.length
      ? alerts.alerts.map(a => `<div style="padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:var(--fs-sm)">${a.message || JSON.stringify(a)}</div>`).join('')
      : '<div style="color:var(--ink-3);font-size:var(--fs-sm);padding:12px 0">目前沒有通知</div>';
    $('#modal-card').innerHTML = `
      <div class="modal-head"><h3>通知</h3><button class="modal-close" id="modal-close-btn">✕</button></div>
      <div style="padding-top:4px">${items}</div>`;
    $('#modal-bd').classList.add('open');
    $('#modal-close-btn').addEventListener('click', () => $('#modal-bd').classList.remove('open'));
  });

  // Settings btn → modal with league settings summary
  $('#settings-btn')?.addEventListener('click', async () => {
    const s = await api('/api/league/settings').catch(() => null);
    const rows = s ? Object.entries(s)
      .filter(([k]) => !['setup_complete','use_openrouter','show_offseason_headlines','team_names'].includes(k))
      .map(([k,v]) => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line-soft);font-size:var(--fs-sm)"><span style="color:var(--ink-3);font-family:var(--mono)">${k}</span><span>${typeof v === 'object' ? JSON.stringify(v) : String(v)}</span></div>`).join('')
      : '<div style="color:var(--ink-3);font-size:var(--fs-sm)">讀取失敗</div>';
    $('#modal-card').innerHTML = `
      <div class="modal-head"><h3>聯盟設定</h3><button class="modal-close" id="modal-close-btn">✕</button></div>
      <div style="padding-top:4px">${rows}</div>`;
    $('#modal-bd').classList.add('open');
    $('#modal-close-btn').addEventListener('click', () => $('#modal-bd').classList.remove('open'));
  });

  // ========================================================
  // TOASTS
  // ========================================================
  function toast(text, kind='success') {
    const el = h('div', {class:'toast' + (kind==='error'?' error':'')});
    el.innerHTML = `<span class="t-ic">${I.check}</span><div>${text}</div>`;
    $('#toasts').append(el);
    setTimeout(() => { el.style.transition = 'opacity 200ms'; el.style.opacity = '0'; setTimeout(() => el.remove(), 200); }, 2800);
  }

  // ========================================================
  // BOOT
  // ========================================================
  window.addEventListener('hashchange', mount);
  if (!location.hash) location.hash = '#/home';

  // Seed D from window.DATA as fallback
  Object.assign(D, window.DATA || {});

  (async function boot() {
    const vEl = document.querySelector('.brand-name .sub');
    if (vEl) vEl.textContent = `/ v2 · ${VERSION}`;
    await refreshData();
    mount();
  })();
})();
