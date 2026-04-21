/* Fantasy NBA v2 — data */
window.DATA = {
  me: { id: 'me', name: 'Chen W.', team: '肉圓幫', initials: 'CW', grad: 1 },
  league: { name: '絕地爆米花盃', size: 12, week: 14, totalWeeks: 21, phase: 'regular', draftDone: true, playoffStartWeek: 18 },

  standings: [
    { r:1, team:'爆米花特攻', owner:'Alex', w:11, l:2, pf:1432, streak:'W4', you:false },
    { r:2, team:'吸管神', owner:'Ben', w:10, l:3, pf:1401, streak:'W2', you:false },
    { r:3, team:'肉圓幫', owner:'Chen W.', w:9, l:4, pf:1385, streak:'W3', you:true },
    { r:4, team:'蛋塔軍團', owner:'Diana', w:8, l:5, pf:1370, streak:'L1', you:false },
    { r:5, team:'珍奶兄弟', owner:'Eric', w:8, l:5, pf:1360, streak:'W1', you:false },
    { r:6, team:'滷肉飯派', owner:'Fiona', w:7, l:6, pf:1342, streak:'W1', you:false },
    { r:7, team:'臭豆腐隊', owner:'Gary', w:6, l:7, pf:1298, streak:'L2', you:false },
    { r:8, team:'鹽酥雞團', owner:'Hana', w:6, l:7, pf:1289, streak:'L1', you:false },
    { r:9, team:'小籠包', owner:'Ivan', w:5, l:8, pf:1270, streak:'L3', you:false },
    { r:10, team:'牛肉麵友', owner:'Jay', w:4, l:9, pf:1251, streak:'W1', you:false },
    { r:11, team:'刈包戰神', owner:'Kelly', w:3, l:10, pf:1210, streak:'L5', you:false },
    { r:12, team:'夜市之光', owner:'Leo', w:2, l:11, pf:1180, streak:'L2', you:false },
  ],

  roster: [
    { slot:'PG', name:'Luka Dončić', pos:'PG', grad:2, team:'DAL', form:[1,1,1,1,1], proj:52.1, status:'hot', game:'vs PHX · 今晚',
      avg:{ pts:33.9, reb:8.7, ast:9.8, stl:1.4, blk:0.5, to:4.1 }, days:[true,false,true,false,true,false,true] },
    { slot:'SG', name:'Devin Booker', pos:'SG', grad:3, team:'PHX', form:[1,1,0,1,1], proj:41.2, status:'ok', game:'@ DAL · 今晚',
      avg:{ pts:27.1, reb:4.5, ast:6.9, stl:1.2, blk:0.3, to:3.2 }, days:[true,false,true,false,false,true,false] },
    { slot:'SF', name:'Jayson Tatum', pos:'SF', grad:4, team:'BOS', form:[1,1,1,1,0], proj:44.7, status:'hot', game:'vs MIA · 明',
      avg:{ pts:27.3, reb:8.1, ast:4.9, stl:1.1, blk:0.6, to:2.8 }, days:[false,true,false,true,false,true,false] },
    { slot:'PF', name:'Giannis A.', pos:'PF', grad:5, team:'MIL', form:[1,1,0,0,1], proj:48.5, status:'ok', game:'@ CLE · 明',
      avg:{ pts:30.4, reb:11.5, ast:6.5, stl:1.2, blk:1.1, to:3.4 }, days:[false,true,false,true,false,false,true] },
    { slot:'C',  name:'Nikola Jokić', pos:'C',  grad:6, team:'DEN', form:[1,1,1,1,1], proj:55.3, status:'hot', game:'vs LAL · 今晚',
      avg:{ pts:26.4, reb:12.4, ast:9.0, stl:1.4, blk:0.9, to:3.0 }, days:[true,false,true,false,true,false,false] },
    { slot:'G',  name:'Tyrese Haliburton', pos:'PG', grad:7, team:'IND', form:[0,1,1,1,0], proj:38.4, status:'warm', game:'休息日',
      avg:{ pts:20.1, reb:3.9, ast:10.9, stl:1.6, blk:0.2, to:3.5 }, days:[false,false,true,false,true,false,true] },
    { slot:'F',  name:'Kawhi Leonard', pos:'SF', grad:8, team:'LAC', form:[0,0,-1,1,1], proj:35.2, status:'warm', game:'出賽存疑',
      avg:{ pts:22.7, reb:6.1, ast:3.5, stl:1.6, blk:0.4, to:2.1 }, days:[false,true,false,false,true,true,false] },
    { slot:'UTIL', name:'Anthony Edwards', pos:'SG', grad:1, team:'MIN', form:[1,1,1,0,1], proj:43.1, status:'hot', game:'@ OKC · 明',
      avg:{ pts:25.9, reb:5.4, ast:5.1, stl:1.3, blk:0.5, to:2.7 }, days:[false,true,false,true,false,true,false] },
    { slot:'BN', name:'Anfernee Simons', pos:'SG', grad:2, team:'POR', form:[0,1,0,1,1], proj:32.0, status:'warm',
      avg:{ pts:21.5, reb:3.1, ast:4.9, stl:0.8, blk:0.3, to:2.4 }, days:[true,false,false,true,false,true,false] },
    { slot:'BN', name:'Jalen Brunson', pos:'PG', grad:3, team:'NYK', form:[1,1,1,1,1], proj:41.8, status:'hot',
      avg:{ pts:28.7, reb:3.6, ast:6.7, stl:0.9, blk:0.2, to:2.5 }, days:[false,true,true,false,true,false,true] },
    { slot:'BN', name:'Pascal Siakam', pos:'PF', grad:4, team:'IND', form:[1,0,1,0,1], proj:34.5, status:'warm',
      avg:{ pts:21.3, reb:7.8, ast:3.3, stl:1.1, blk:0.6, to:2.2 }, days:[true,false,true,false,false,true,false] },
    { slot:'IR', name:'Kristaps Porziņģis', pos:'C', grad:5, team:'BOS', form:[-1,-1,-1,0,0], proj:0, status:'injured',
      avg:{ pts:20.1, reb:7.2, ast:2.0, stl:0.6, blk:1.9, to:1.8 }, days:[false,false,false,false,false,false,false] },
  ],

  matchup: {
    week: 14,
    you:   { team:'肉圓幫', score:412.4, proj:520, played:5, total:8, grad:1 },
    them:  { team:'珍奶兄弟', score:386.1, proj:495, played:5, total:8, grad:7, owner:'Eric' },
    catBreakdown: [
      { cat:'PTS', you:621.4, them:589.2 },
      { cat:'REB', you:198.0, them:211.5 },
      { cat:'AST', you:143.7, them:128.3 },
      { cat:'STL', you:22.0,  them:19.5 },
      { cat:'BLK', you:14.0,  them:18.0 },
      { cat:'TO',  you:52.1,  them:58.4 },
    ]
  },

  // Action queue — "今天該做什麼"
  actions: [
    { id:'a1', urgency:'high', ic:'syringe', title:'Porziņģis 今晚出賽存疑', sub:'建議把 Jokić 上先發、Porziņģis 移到 BN', cta:'調整先發', time:'18:30 鎖定' },
    { id:'a2', urgency:'high', ic:'trade', title:'Eric 提出交易提案', sub:'用他的 Siakam + Quickley 換你的 Simons + Porziņģis', cta:'審視提案', time:'12 小時內回覆' },
    { id:'a3', urgency:'med', ic:'waiver', title:'自由球員熱潮', sub:'Scottie Barnes (TOR) 本週三場、你的 F 位有空缺', cta:'撿人', time:'週三 03:00 截止' },
    { id:'a4', urgency:'med', ic:'schedule', title:'下週 Haliburton 只有 2 場', sub:'考慮把他坐板凳，上 Brunson（4 場）', cta:'看排程', time:'下週五 18:30' },
    { id:'a5', urgency:'done', ic:'check', title:'本週先發已送出', sub:'週一 03:15 已鎖定 · Jokić、Luka、Tatum 先發', cta:'查看', time:'' },
  ],

  news: [
    { kind:'injury', title:'Porziņģis 背部緊繃、今晚出賽存疑', meta:'BOS · 30 分鐘前', flash:true },
    { kind:'heat', title:'Jokić 連 5 場 50+，本季 MVP 賠率跳升', meta:'DEN · 1 小時前' },
    { kind:'quote', quote:'這禮拜我很強勢，你們都要小心。', attrib:'Alex · 爆米花特攻', meta:'聯盟 · 2 小時前' },
    { kind:'league', title:'Ben 剛把 Ayton 丟到自由球員', meta:'吸管神 · 3 小時前' },
    { kind:'milestone', title:'Luka 生涯第 50 次大三元', meta:'DAL · 昨晚' },
    { kind:'matchup', title:'你與 Eric 差 26 分，還有 3 場比賽', meta:'第 14 週 · 剛更新' },
    { kind:'quote', quote:'我覺得 Edwards 該進先發 All-Star。', attrib:'你的上週訪談', meta:'聯盟 · 昨天' },
    { kind:'league', title:'Diana 撿走了 Coby White', meta:'蛋塔軍團 · 昨天' },
  ],

  // Draft recommendations (first-round opening pick)
  draftState: {
    round: 1, pickOverall: 8, pickInRound: 8, timeLeft: 47,
    roster: { PG:0, SG:0, SF:0, PF:0, C:0, total:0 },
    needs: [
      { pos:'PG', need:'high',  filled:0, target:2 },
      { pos:'SG', need:'med',   filled:0, target:2 },
      { pos:'SF', need:'high',  filled:0, target:2 },
      { pos:'PF', need:'med',   filled:0, target:2 },
      { pos:'C',  need:'high',  filled:0, target:2 },
      { pos:'BN', need:'low',   filled:0, target:4 },
    ],
    recos: [
      { rank:1, top:true, name:'Shai Gilgeous-Alexander', pos:'PG', team:'OKC', grad:1,
        fit:94, reasons:['填補你最缺的 PG 位','本季助攻+出手量皆上升','首輪唯一連續三年 上升的後衛'] },
      { rank:2, top:false, name:'Anthony Davis', pos:'C', team:'LAL', grad:5,
        fit:88, reasons:['你 C 位也缺','多類別貢獻：籃板、阻攻','健康是風險，但產能無敵'] },
      { rank:3, top:false, name:'Jaylen Brown', pos:'SF', team:'BOS', grad:4,
        fit:82, reasons:['SF 位置需求高','穩定上場 34 分鐘','與你下輪可能選到的 PF 組合佳'] },
    ]
  },

  // Trade conversations
  tradeThreads: [
    { id:'t1', with:'Eric', team:'珍奶兄弟', grad:7, persona:'aggressive', fit:'high',
      preview:'你的 Simons 我真的很想要…',
      unread:true, time:'12 分鐘前',
      msgs:[
        { from:'them', time:'今早 10:15', text:'兄弟我注意你隊上 PG 太多，Simons 來我這好嗎' },
        { from:'me',   time:'今早 10:22', text:'你打算給什麼？' },
        { from:'them', time:'今早 10:25', text:'Siakam + Quickley 給你 Simons + Porziņģis' },
        { type:'proposal', id:'#2041', from:'Eric',
          mine:[{n:'A. Simons',p:'SG'},{n:'K. Porziņģis',p:'C'}],
          theirs:[{n:'P. Siakam',p:'PF'},{n:'I. Quickley',p:'PG'}] },
        { from:'them', time:'12 分鐘前', text:'我給你加一個次輪 pick，這樣好嗎' },
      ]},
    { id:'t2', with:'Alex', team:'爆米花特攻', grad:2, persona:'calm', fit:'mid',
      preview:'我這週不交易，先謝了。', unread:false, time:'昨天',
      msgs:[
        { from:'me', time:'昨天 14:02', text:'你的 Tatum 有興趣交易嗎？' },
        { from:'them', time:'昨天 14:30', text:'我這週不交易，先謝了。' },
      ]},
    { id:'t3', with:'Diana', team:'蛋塔軍團', grad:4, persona:'numbers', fit:'mid',
      preview:'給我數據我再評估。', unread:false, time:'2 天前',
      msgs:[
        { from:'me', time:'2 天前', text:'有意思交易 Brunson 嗎' },
        { from:'them', time:'2 天前', text:'給我數據我再評估。' },
      ]},
    { id:'t4', with:'Ben', team:'吸管神', grad:3, persona:'hype', fit:'low',
      preview:'（已讀不回）', unread:false, time:'3 天前', msgs:[
        { from:'me', time:'3 天前', text:'Haliburton 交易?' }
      ]},
  ],

  // Free agents
  freeAgents: [
    { name:'Scottie Barnes', pos:'SF', team:'TOR', grad:4, form:[1,1,1,1,0], owned:62, trend:'up', note:'本週 3 場、F 位熱門撿角' },
    { name:'Coby White', pos:'SG', team:'CHI', grad:2, form:[1,1,0,1,1], owned:48, trend:'up', note:'上場時間穩定 34 分鐘' },
    { name:'Naz Reid', pos:'C', team:'MIN', grad:5, form:[1,0,1,1,0], owned:44, trend:'flat', note:'KAT 復出後角色存疑' },
    { name:'Jaden Ivey', pos:'PG', team:'DET', grad:7, form:[0,1,1,1,1], owned:35, trend:'up', note:'連 4 場 25+ 表現' },
    { name:'Klay Thompson', pos:'SG', team:'DAL', grad:6, form:[1,0,0,1,1], owned:70, trend:'down', note:'上場時間被限制' },
    { name:'Bobby Portis', pos:'PF', team:'MIL', grad:4, form:[1,1,1,0,1], owned:52, trend:'flat', note:'穩定的 PF 替補' },
  ],

  // Season schedule — 21 weeks
  schedule: [
    { w:1, score:'98-112', result:'L', opp:'Alex' },
    { w:2, score:'121-110', result:'W', opp:'Ben' },
    { w:3, score:'105-99', result:'W', opp:'Diana' },
    { w:4, score:'88-92', result:'L', opp:'Eric' },
    { w:5, score:'115-102', result:'W', opp:'Fiona' },
    { w:6, score:'110-107', result:'W', opp:'Gary' },
    { w:7, score:'94-98', result:'L', opp:'Hana' },
    { w:8, score:'118-109', result:'W', opp:'Ivan' },
    { w:9, score:'121-116', result:'W', opp:'Jay' },
    { w:10, score:'109-99', result:'W', opp:'Kelly' },
    { w:11, score:'89-102', result:'L', opp:'Leo' },
    { w:12, score:'113-108', result:'W', opp:'Alex' },
    { w:13, score:'117-104', result:'W', opp:'Ben' },
    { w:14, score:'412-386', result:'current', opp:'Eric' },
    { w:15, score:'—', result:'future', opp:'Gary' },
    { w:16, score:'—', result:'future', opp:'Fiona' },
    { w:17, score:'—', result:'future', opp:'Ben' },
    { w:18, score:'—', result:'playoff', opp:'QF' },
    { w:19, score:'—', result:'playoff', opp:'SF' },
    { w:20, score:'—', result:'playoff', opp:'F' },
    { w:21, score:'—', result:'playoff', opp:'F' },
  ],
};
