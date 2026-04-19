/* Fantasy NBA v2 — app.js
 * Hash router, nav, views. All views rendered as innerHTML strings.
 */
(() => {
  const D = window.DATA;
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
        <b style="color:var(--ink)">關鍵三件事</b><br/>
        · 把 Jokić 確認先發（DEN vs LAL）<br/>
        · Porziņģis 出賽存疑，備胎 Simons<br/>
        · Eric 剩 Brunson 沒打，小心他週末追上
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
    return `<div class="rail-section">
      <div class="rail-head"><span>選秀順位</span></div>
      <div class="card card-pad" style="font-size:var(--fs-sm);display:flex;flex-direction:column;gap:4px">
        ${[
          ['1','Alex','P. Banchero',true],
          ['2','Ben','V. Wembanyama',true],
          ['3','Diana','T. Haliburton',true],
          ['4','Eric','L. Dončić',true],
          ['5','Fiona','J. Tatum',true],
          ['6','Gary','G. Antetokounmpo',true],
          ['7','Hana','A. Edwards',true],
          ['8','你',null,false,true],
          ['9','Ivan',null,false],
          ['10','Jay',null,false],
          ['11','Kelly',null,false],
          ['12','Leo',null,false],
        ].map(([p,n,pk,done,me]) => `
          <div style="display:grid;grid-template-columns:24px 1fr 1fr;gap:8px;padding:6px 8px;border-radius:6px;${me?'background:var(--accent-14)':''}">
            <span class="mono" style="color:var(--ink-3);font-size:11px">${p}</span>
            <span style="${me?'color:var(--accent-hi);font-weight:600':''}">${n}</span>
            <span class="mono" style="font-size:11px;color:${done?'var(--ink-2)':'var(--ink-4)'};text-align:right">${pk || (me?'選擇中…':'—')}</span>
          </div>
        `).join('')}
      </div>
    </div>`;
  }

  function renderWaiverBudget() {
    return `<div class="rail-section">
      <div class="rail-head"><span>本季 Waiver 預算</span></div>
      <div class="card card-pad">
        <div style="font-family:var(--mono);font-size:var(--fs-2xl);font-weight:700;letter-spacing:-0.02em">\$67 <span style="font-size:var(--fs-sm);color:var(--ink-3);font-weight:400">/ \$100</span></div>
        <div style="height:4px;background:var(--line);border-radius:999px;overflow:hidden;margin-top:10px"><div style="height:100%;width:67%;background:linear-gradient(90deg,var(--accent),var(--accent-hi));border-radius:999px"></div></div>
        <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:var(--fs-xs);color:var(--ink-3);font-family:var(--mono)"><span>已用 \$33</span><span>剩 7 週</span></div>
      </div>
    </div>
    <div class="rail-section">
      <div class="rail-head"><span>聯盟最近撿角</span></div>
      <div class="card card-pad" style="font-size:var(--fs-sm);line-height:1.7;color:var(--ink-2)">
        · Diana 撿走 <b style="color:var(--ink)">Coby White</b> (\$12)<br/>
        · Alex 丟了 <b style="color:var(--ink)">R. Holmes</b><br/>
        · Ben 撿走 <b style="color:var(--ink)">Brandon Miller</b> (\$8)
      </div>
    </div>`;
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
        <div class="home-date mono">WED · 03.12 · 例行賽第 14 週</div>
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
  views.roster = () => {
    const byZone = { STARTERS: [], BN: [], IR: [] };
    D.roster.forEach(p => {
      if (p.slot === 'BN') byZone.BN.push(p);
      else if (p.slot === 'IR') byZone.IR.push(p);
      else byZone.STARTERS.push(p);
    });

    const renderSlot = (p) => `
      <div class="slot">
        <span class="slot-label">${p.slot}</span>
        ${av(p.name, p.grad)}
        <div>
          <div class="slot-name">${p.name}</div>
          <div class="slot-team">${p.team} · ${p.game || '—'}</div>
        </div>
        <div class="slot-form">${p.form.map(f => `<div class="spark ${f===1?'hot':f===0?'warm':'cold'}"></div>`).join('')}</div>
        <div class="slot-proj">${p.proj || '—'}</div>
      </div>`;

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

      <div style="margin-bottom:var(--s-6)">
        <div class="eyebrow" style="margin-bottom:var(--s-3)">先發 · 8 人</div>
        <div class="roster-grid">${byZone.STARTERS.map(renderSlot).join('')}</div>
      </div>

      <div style="margin-bottom:var(--s-6)">
        <div class="eyebrow" style="margin-bottom:var(--s-3)">板凳 · ${byZone.BN.length} 人</div>
        <div class="roster-grid">${byZone.BN.map(renderSlot).join('')}</div>
      </div>

      <div>
        <div class="eyebrow" style="margin-bottom:var(--s-3)">傷兵名單 · ${byZone.IR.length} 人</div>
        <div class="roster-grid">${byZone.IR.map(renderSlot).join('')}</div>
      </div>
    `;
  };

  // ---------- MATCHUP ----------
  views.matchup = () => {
    const { you, them } = D.matchup;
    const stars = D.roster.filter(p => ['PG','SG','SF','PF','C','G','F','UTIL'].includes(p.slot));
    return `
      <div class="view-head">
        <div class="view-title-block">
          <span class="eyebrow">第 14 週 · 例行賽</span>
          <div class="view-title">肉圓幫 vs 珍奶兄弟</div>
          <div class="view-sub">已打 5/8 場 · 週日 18:30 結算</div>
        </div>
      </div>

      <div class="card" style="margin-bottom:var(--s-5)">
        <div class="matchup-body" style="padding:var(--s-7) var(--s-8)">
          <div class="matchup-side you winning">
            <div class="matchup-team">${av('Chen', you.grad, 'lg')}<span style="font-size:var(--fs-lg);font-weight:600;margin-top:6px">肉圓幫</span></div>
            <div class="matchup-score mono" style="color:var(--good);font-size:var(--fs-4xl)">${you.score}</div>
          </div>
          <div class="matchup-vs mono" style="font-size:var(--fs-xl)">VS</div>
          <div class="matchup-side them losing">
            <div class="matchup-team">${av('Eric', them.grad, 'lg')}<span style="font-size:var(--fs-lg);font-weight:600;margin-top:6px">珍奶兄弟</span></div>
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

  // ---------- STANDINGS ----------
  views.standings = () => `
    <div class="view-head">
      <div class="view-title-block">
        <span class="eyebrow">聯盟</span>
        <div class="view-title">排名 · 絕地爆米花盃</div>
        <div class="view-sub">第 14 週 · 前 6 名進季後賽 · 後 2 名直接抽下季選秀籤</div>
      </div>
      <div class="view-actions">
        <div class="segmented"><button aria-pressed="true">整體</button><button>東區</button><button>西區</button></div>
      </div>
    </div>
    <div class="card">
      <table class="standings-table">
        <thead><tr><th>名次</th><th>隊伍</th><th class="num">戰績</th><th class="num">總得分</th><th class="num">連勝</th><th class="num">趨勢</th></tr></thead>
        <tbody>${D.standings.map(s => `
          <tr class="${s.you?'you':''} ${s.r<=6?'playoff':''}">
            <td><span class="rank-medal" data-rank="${s.r}">${s.r}</span></td>
            <td><div style="display:flex;align-items:center;gap:10px">${av(s.team, ((s.r-1)%8)+1, 'sm')}<div><div style="font-weight:500">${s.team}${s.you?' <span class="pill accent" style="margin-left:6px">你</span>':''}</div><div style="font-size:11px;color:var(--ink-3);font-family:var(--mono)">${s.owner}</div></div></div></td>
            <td class="num"><b>${s.w}–${s.l}</b></td>
            <td class="num">${s.pf}</td>
            <td class="num"><span class="streak ${s.streak[0].toLowerCase()}">${s.streak}</span></td>
            <td class="num" style="color:var(--ink-3)">${s.r <= 3 ? '▲' : s.r >= 10 ? '▼' : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  // ---------- DRAFT ----------
  views.draft = () => {
    const ds = D.draftState;
    const needs = ds.needs.map(n => `
      <div class="need-cell ${n.need==='high'?'short':''}">
        <div class="np">${n.pos}</div>
        <div class="nc">${n.filled}/${n.target}</div>
      </div>`).join('');

    const recos = ds.recos.map(r => `
      <div class="reco-card ${r.top?'top':''}">
        <div class="reco-player">
          ${av(r.name, r.grad, 'lg')}
          <div>
            <div class="reco-name">${r.name}</div>
            <div class="reco-meta"><span class="pos-tag" data-pos="${r.pos}">${r.pos}</span><span>${r.team}</span><span>·</span><span>ADP 第 ${r.rank+6} 順位</span></div>
          </div>
        </div>
        <div class="reco-fit">
          <span class="score">${r.fit}<small>/100</small></span>
          <span class="label">陣容適配分</span>
        </div>
        <div class="reco-reasons">${r.reasons.map(x => `<div class="reco-r"><span class="bullet">◆</span>${x}</div>`).join('')}</div>
        <div class="reco-actions">
          <button class="btn" data-reco="${r.name}">選他 ${I.arrow}</button>
          <button class="btn ghost">略過</button>
        </div>
      </div>`).join('');

    return `
      <div class="view-head">
        <div class="view-title-block">
          <span class="eyebrow">選秀廳 · 第 ${ds.round} 輪</span>
          <div class="view-title">你的第 ${ds.pickOverall} 順位</div>
        </div>
      </div>

      <div class="draft-top">
        <div class="draft-clock">
          <div class="dc-eyebrow">
            <span class="live">LIVE · 第 ${ds.round} 輪 第 ${ds.pickInRound} 順位</span>
            <span class="pick-num">你的第 1 支籤</span>
          </div>
          <h2>剩 ${ds.timeLeft} 秒</h2>
          <div class="dc-sub">前 7 順位已選走前段球星。根據你聯盟設定（9 類別）與位置缺口，以下是我們的建議。</div>
        </div>
        <div class="needs-strip">
          <div class="needs-head">目前陣容缺口</div>
          <div class="needs-grid">${needs}</div>
        </div>
      </div>

      <div class="reco-grid">${recos}</div>

      <div class="card">
        <div class="card-header"><h3>可選球員（前 10 名）</h3><span class="sub">依 ADP 排序 · 灰色代表已被選走</span></div>
        <table class="standings-table">
          <tbody>${[
            ['P. Banchero','PF','ORL',1,true],
            ['V. Wembanyama','C','SAS',2,true],
            ['T. Haliburton','PG','IND',3,true],
            ['L. Dončić','PG','DAL',4,true],
            ['J. Tatum','SF','BOS',5,true],
            ['G. Antetokounmpo','PF','MIL',6,true],
            ['A. Edwards','SG','MIN',7,true],
            ['SGA','PG','OKC',8,false],
            ['A. Davis','C','LAL',9,false],
            ['J. Brown','SF','BOS',10,false],
          ].map(([n,p,t,r,taken], i) => `
            <tr style="${taken?'opacity:0.4':''}">
              <td><span class="mono" style="color:var(--ink-3);font-size:11px">${r}</span></td>
              <td><div style="display:flex;align-items:center;gap:10px">${av(n, (i%8)+1, 'sm')}<span style="${taken?'text-decoration:line-through':''}">${n}</span></div></td>
              <td><span class="pos-tag" data-pos="${p}">${p}</span></td>
              <td>${t}</td>
              <td class="num">${taken ? '<span style="color:var(--ink-3)">已選走</span>' : '<button class="btn sm ghost">選</button>'}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
    `;
  };

  // ---------- TRADE ----------
  let activeThread = 't1';
  views.trade = () => {
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
          <div style="display:flex;gap:8px;justify-content:center;margin-top:6px"><button class="btn sm">接受</button><button class="btn sm ghost">還價</button><button class="btn sm subtle">拒絕</button></div>
        </div>`;
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
        <div class="view-actions"><button class="btn">發起交易 ${I.plus}</button></div>
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
        <div class="view-sub">週三 03:00 處理認領 · 你剩 \$67 Waiver 預算</div>
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
            <td><button class="btn sm">認領</button></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;

  // ---------- SCHEDULE ----------
  views.schedule = () => `
    <div class="view-head">
      <div class="view-title-block">
        <span class="eyebrow">整季排程</span>
        <div class="view-title">2024-25 · 21 週</div>
        <div class="view-sub">13 場已打、3 場待打、4 場季後賽</div>
      </div>
    </div>
    <div class="week-grid">${D.schedule.map(w => {
      const cls = w.result === 'W' ? 'won' : w.result === 'L' ? 'lost'
        : w.result === 'current' ? 'current' : w.result === 'playoff' ? 'playoff' : 'future';
      return `<div class="week-cell ${cls}">
        <div class="wn">W${w.w}</div>
        <div class="wscore">${w.score}</div>
        <div style="font-size:10px;color:var(--ink-3);font-family:var(--mono);margin-top:4px">${w.opp}</div>
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
    // Trade thread clicks
    $$('.ts-row[data-thread]').forEach(row => {
      row.addEventListener('click', () => {
        activeThread = row.dataset.thread;
        mount();
      });
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
    // Draft pick
    $$('button[data-reco]').forEach(btn => {
      btn.addEventListener('click', () => toast(`已選擇 ${btn.dataset.reco}`, 'success'));
    });
    // Chat send
    const sendBtn = $('#chat-send');
    if (sendBtn) {
      const doSend = () => {
        const input = $('#chat-input');
        const t = (input.value || '').trim();
        if (!t) return;
        const body = $('#chat-body');
        body.insertAdjacentHTML('beforeend', `<div class="bubble-row me"><div class="bubble me">${t}</div><div class="bubble-meta">剛剛</div></div>`);
        input.value = '';
        body.scrollTop = body.scrollHeight;
        // simulate reply
        body.insertAdjacentHTML('beforeend', `<div class="typing"><div class="d"></div><div class="d"></div><div class="d"></div></div>`);
        body.scrollTop = body.scrollHeight;
        setTimeout(() => {
          body.querySelector('.typing')?.remove();
          body.insertAdjacentHTML('beforeend', `<div class="bubble-row them"><div class="bubble them">嗯…讓我想想。這邊我覺得可能要你再加一點。</div><div class="bubble-meta">剛剛</div></div>`);
          body.scrollTop = body.scrollHeight;
        }, 1200);
      };
      sendBtn.addEventListener('click', doSend);
      $('#chat-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') doSend(); });
    }
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
    { icon:I.waiver, label:'撿角：Scottie Barnes', action:() => toast('已提交認領：Scottie Barnes (\$5)') },
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
    if (e.key === 'Escape') closeCmd();
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
  mount();
})();
