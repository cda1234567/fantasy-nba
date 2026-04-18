# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: g2_player.spec.ts >> g2 player full flow
- Location: g2_player.spec.ts:13:5

# Error details

```
Test timeout of 900000ms exceeded.
```

```
Error: locator.click: Test timeout of 900000ms exceeded.
Call log:
  - waiting for locator('#btn-menu')
    - locator resolved to <button id="btn-menu" aria-label="開啟設定" aria-haspopup="dialog" class="icon-btn hamburger" aria-controls="dlg-settings">…</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not visible
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not visible
    - retrying click action
      - waiting 100ms
    1716 × waiting for element to be visible, enabled and stable
         - element is not visible
       - retrying click action
         - waiting 500ms

```

# Page snapshot

```yaml
- generic [ref=e1]:
  - banner [ref=e2]:
    - heading "NBA Fantasy 模擬器" [level=1] [ref=e3]
    - button "聯盟 qa-g2" [ref=e5] [cursor=pointer]:
      - generic [ref=e6]: 聯盟
      - generic "qa-g2" [ref=e7]
      - img [ref=e8]
    - generic [ref=e10]:
      - generic [ref=e12]: 已連線
      - generic "應用版本" [ref=e13]: v0.5.22
  - generic [ref=e14]:
    - navigation "主選單" [ref=e15]:
      - link "選秀" [ref=e16] [cursor=pointer]:
        - /url: "#draft"
        - generic [ref=e17]: D
        - generic [ref=e18]: 選秀
      - link "隊伍" [ref=e19] [cursor=pointer]:
        - /url: "#teams"
        - generic [ref=e20]: T
        - generic [ref=e21]: 隊伍
      - link "自由球員" [ref=e22] [cursor=pointer]:
        - /url: "#fa"
        - generic [ref=e23]: F
        - generic [ref=e24]: 自由球員
      - link "聯盟" [ref=e25] [cursor=pointer]:
        - /url: "#league"
        - generic [ref=e26]: L
        - generic [ref=e27]: 聯盟
      - link "賽程" [ref=e28] [cursor=pointer]:
        - /url: "#schedule"
        - generic [ref=e29]: S
        - generic [ref=e30]: 賽程
    - main [active] [ref=e31]:
      - generic [ref=e32]:
        - heading "聯盟設定" [level=1] [ref=e33]
        - generic [ref=e34]:
          - generic [ref=e35]: 聯盟基本
          - generic [ref=e36]:
            - generic [ref=e37]: 聯盟名稱
            - textbox [ref=e39]: 我的聯盟
          - generic [ref=e40]:
            - generic [ref=e41]: 賽季年份
            - combobox [ref=e43]:
              - option "1996-97"
              - option "1997-98"
              - option "1998-99"
              - option "1999-00"
              - option "2000-01"
              - option "2001-02"
              - option "2002-03"
              - option "2003-04"
              - option "2004-05"
              - option "2005-06"
              - option "2006-07"
              - option "2007-08"
              - option "2008-09"
              - option "2009-10"
              - option "2010-11"
              - option "2011-12"
              - option "2012-13"
              - option "2013-14"
              - option "2014-15"
              - option "2015-16"
              - option "2016-17"
              - option "2017-18"
              - option "2018-19"
              - option "2019-20"
              - option "2020-21"
              - option "2021-22"
              - option "2022-23"
              - option "2023-24"
              - option "2024-25"
              - option "2025-26" [selected]
          - generic [ref=e44]:
            - generic [ref=e45]: 我的隊伍
            - combobox [ref=e47]:
              - 'option "0: 我的隊伍" [selected]'
              - 'option "1: BPA Nerd"'
              - 'option "2: Punt TO"'
              - 'option "3: Stars & Scrubs"'
              - 'option "4: Balanced Builder"'
              - 'option "5: Youth Upside"'
              - 'option "6: Vet Win-Now"'
              - 'option "7: Contrarian"'
          - generic [ref=e48]:
            - generic [ref=e49]: 隨機選秀順序
            - checkbox "隨機選秀順序" [ref=e51]
        - generic [ref=e52]:
          - generic [ref=e53]: 隊伍名稱
          - generic [ref=e54]:
            - generic [ref=e55]:
              - generic [ref=e56]: "0"
              - textbox "0" [ref=e57]:
                - /placeholder: 隊伍 0
                - text: 我的隊伍
            - generic [ref=e58]:
              - generic [ref=e59]: "1"
              - textbox "1" [ref=e60]:
                - /placeholder: 隊伍 1
                - text: BPA Nerd
            - generic [ref=e61]:
              - generic [ref=e62]: "2"
              - textbox "2" [ref=e63]:
                - /placeholder: 隊伍 2
                - text: Punt TO
            - generic [ref=e64]:
              - generic [ref=e65]: "3"
              - textbox "3" [ref=e66]:
                - /placeholder: 隊伍 3
                - text: Stars & Scrubs
            - generic [ref=e67]:
              - generic [ref=e68]: "4"
              - textbox "4" [ref=e69]:
                - /placeholder: 隊伍 4
                - text: Balanced Builder
            - generic [ref=e70]:
              - generic [ref=e71]: "5"
              - textbox "5" [ref=e72]:
                - /placeholder: 隊伍 5
                - text: Youth Upside
            - generic [ref=e73]:
              - generic [ref=e74]: "6"
              - textbox "6" [ref=e75]:
                - /placeholder: 隊伍 6
                - text: Vet Win-Now
            - generic [ref=e76]:
              - generic [ref=e77]: "7"
              - textbox "7" [ref=e78]:
                - /placeholder: 隊伍 7
                - text: Contrarian
        - generic [ref=e79]:
          - generic [ref=e80]: 名單
          - generic [ref=e81]:
            - generic [ref=e82]: 名單人數
            - generic [ref=e84]:
              - generic [ref=e85]:
                - radio "10" [ref=e86] [cursor=pointer]
                - generic [ref=e87] [cursor=pointer]: "10"
              - generic [ref=e88]:
                - radio "13" [checked] [ref=e89] [cursor=pointer]
                - generic [ref=e90] [cursor=pointer]: "13"
              - generic [ref=e91]:
                - radio "15" [ref=e92] [cursor=pointer]
                - generic [ref=e93] [cursor=pointer]: "15"
          - generic [ref=e94]:
            - generic [ref=e95]: 每日先發
            - generic [ref=e97]:
              - generic [ref=e98]:
                - radio "8" [ref=e99] [cursor=pointer]
                - generic [ref=e100] [cursor=pointer]: "8"
              - generic [ref=e101]:
                - radio "10" [checked] [ref=e102] [cursor=pointer]
                - generic [ref=e103] [cursor=pointer]: "10"
              - generic [ref=e104]:
                - radio "12" [ref=e105] [cursor=pointer]
                - generic [ref=e106] [cursor=pointer]: "12"
          - generic [ref=e107]:
            - generic [ref=e108]: 傷兵名單位置
            - generic [ref=e110]:
              - generic [ref=e111]:
                - radio "0" [ref=e112] [cursor=pointer]
                - generic [ref=e113] [cursor=pointer]: "0"
              - generic [ref=e114]:
                - radio "1" [ref=e115] [cursor=pointer]
                - generic [ref=e116] [cursor=pointer]: "1"
              - generic [ref=e117]:
                - radio "2" [ref=e118] [cursor=pointer]
                - generic [ref=e119] [cursor=pointer]: "2"
              - generic [ref=e120]:
                - radio "3 (預設)" [checked] [ref=e121] [cursor=pointer]
                - generic [ref=e122] [cursor=pointer]: 3 (預設)
        - generic [ref=e123]:
          - generic [ref=e124]: 計分權重
          - generic [ref=e125]:
            - generic [ref=e126]:
              - generic [ref=e127]: PTS
              - spinbutton "PTS" [ref=e128]: "1"
            - generic [ref=e129]:
              - generic [ref=e130]: REB
              - spinbutton "REB" [ref=e131]: "1.2"
            - generic [ref=e132]:
              - generic [ref=e133]: AST
              - spinbutton "AST" [ref=e134]: "1.5"
            - generic [ref=e135]:
              - generic [ref=e136]: STL
              - spinbutton "STL" [ref=e137]: "2.5"
            - generic [ref=e138]:
              - generic [ref=e139]: BLK
              - spinbutton "BLK" [ref=e140]: "2.5"
            - generic [ref=e141]:
              - generic [ref=e142]: TO
              - spinbutton "TO" [ref=e143]: "-1"
        - generic [ref=e144]:
          - generic [ref=e145]: 賽程
          - generic [ref=e146]:
            - generic [ref=e147]: 例行賽週數
            - generic [ref=e149]:
              - generic [ref=e150]:
                - radio "18" [ref=e151] [cursor=pointer]
                - generic [ref=e152] [cursor=pointer]: "18"
              - generic [ref=e153]:
                - radio "19" [ref=e154] [cursor=pointer]
                - generic [ref=e155] [cursor=pointer]: "19"
              - generic [ref=e156]:
                - radio "20 (預設)" [checked] [ref=e157] [cursor=pointer]
                - generic [ref=e158] [cursor=pointer]: 20 (預設)
              - generic [ref=e159]:
                - radio "21" [ref=e160] [cursor=pointer]
                - generic [ref=e161] [cursor=pointer]: "21"
              - generic [ref=e162]:
                - radio "22" [ref=e163] [cursor=pointer]
                - generic [ref=e164] [cursor=pointer]: "22"
          - generic [ref=e165]:
            - generic [ref=e166]: 交易截止週
            - combobox [ref=e168]:
              - option "無" [selected]
              - option "W10"
              - option "W11"
              - option "W12"
        - generic [ref=e169]:
          - generic [ref=e170]: 交易 AI
          - generic [ref=e171]:
            - generic [ref=e172]: 交易頻率
            - combobox [ref=e174]:
              - option "極少"
              - option "少"
              - option "正常" [selected]
              - option "多"
              - option "極多"
          - generic [ref=e175]:
            - generic [ref=e176]: 交易風格
            - combobox [ref=e178]:
              - option "保守"
              - option "平衡" [selected]
              - option "激進"
          - generic [ref=e179]:
            - generic [ref=e180]: 否決門檻（票數）
            - generic [ref=e182]:
              - generic [ref=e183]:
                - radio "2" [ref=e184] [cursor=pointer]
                - generic [ref=e185] [cursor=pointer]: "2"
              - generic [ref=e186]:
                - radio "3" [checked] [ref=e187] [cursor=pointer]
                - generic [ref=e188] [cursor=pointer]: "3"
              - generic [ref=e189]:
                - radio "4" [ref=e190] [cursor=pointer]
                - generic [ref=e191] [cursor=pointer]: "4"
          - generic [ref=e192]:
            - generic [ref=e193]: 否決窗口（天）
            - generic [ref=e195]:
              - generic [ref=e196]:
                - radio "1" [ref=e197] [cursor=pointer]
                - generic [ref=e198] [cursor=pointer]: "1"
              - generic [ref=e199]:
                - radio "2" [checked] [ref=e200] [cursor=pointer]
                - generic [ref=e201] [cursor=pointer]: "2"
              - generic [ref=e202]:
                - radio "3" [ref=e203] [cursor=pointer]
                - generic [ref=e204] [cursor=pointer]: "3"
        - generic [ref=e205]:
          - generic [ref=e206]: AI 行為
          - generic [ref=e207]:
            - generic [ref=e208]: AI 決策模式
            - combobox [ref=e210]:
              - option "自動偵測" [selected]
              - option "Claude API"
              - option "純啟發式"
        - generic [ref=e211]:
          - generic [ref=e212]: 顯示
          - generic [ref=e213]:
            - generic [ref=e214]: 選秀顯示模式
            - combobox [ref=e216]:
              - option "上季完整（含 FPPG）" [selected]
              - option "上季完整（不含 FPPG）"
              - option "本季完整（劇透）"
          - generic [ref=e217]:
            - generic [ref=e218]: 顯示休賽期頭條
            - checkbox "顯示休賽期頭條" [checked] [ref=e220]
        - generic [ref=e221]:
          - button "使用預設值" [ref=e222] [cursor=pointer]
          - button "開始選秀" [ref=e223] [cursor=pointer]
    - complementary "活動記錄" [ref=e224]:
      - generic [ref=e225]:
        - heading "活動" [level=2] [ref=e226]
        - button "重新整理活動記錄" [ref=e227] [cursor=pointer]:
          - img [ref=e228]
      - list [ref=e230]
```

# Test source

```ts
  1   | import { test, expect, Page } from '@playwright/test';
  2   | 
  3   | const BASE = 'https://nbafantasy.cda1234567.com';
  4   | const LEAGUE_ID = 'qa-g2';
  5   | const SHOT = (n: string) => `screenshots/g2p_${n}.png`;
  6   | 
  7   | async function shoot(page: Page, name: string, full = true) {
  8   |   await page.screenshot({ path: SHOT(name), fullPage: full });
  9   | }
  10  | 
  11  | test.setTimeout(15 * 60 * 1000);
  12  | 
  13  | test('g2 player full flow', async ({ page }) => {
  14  |   const logs: string[] = [];
  15  |   page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  16  |   page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  17  | 
  18  |   // 1. Open site
  19  |   await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  20  |   await page.waitForTimeout(1500);
  21  |   await shoot(page, '01_home');
  22  | 
  23  |   // 2. Open league switcher and try create new league
  24  |   const switchBtn = page.locator('#btn-league-switch');
  25  |   if (await switchBtn.count()) {
  26  |     await switchBtn.click();
  27  |     await page.waitForTimeout(400);
  28  |     await shoot(page, '02_league_menu');
  29  | 
  30  |     const menuItems = page.locator('#league-switch-menu [role="menuitem"], #league-switch-menu button, #league-switch-menu a');
  31  |     const itemsCount = await menuItems.count();
  32  |     logs.push(`[debug] league menu items=${itemsCount}`);
  33  | 
  34  |     // Try find "create" button in menu
  35  |     const createTrigger = page.locator('#league-switch-menu').getByText(/建立|新增|create/i).first();
  36  |     if (await createTrigger.count()) {
  37  |       await createTrigger.click();
  38  |     } else {
  39  |       // Try scroll menu for item, else API fallback
  40  |       await page.keyboard.press('Escape');
  41  |       await page.evaluate(async (lid) => {
  42  |         await fetch('/api/leagues/create', {
  43  |           method: 'POST',
  44  |           headers: { 'content-type': 'application/json' },
  45  |           body: JSON.stringify({ league_id: lid }),
  46  |         });
  47  |       }, LEAGUE_ID);
  48  |       await page.reload();
  49  |       await page.waitForTimeout(1000);
  50  |     }
  51  |     await page.waitForTimeout(500);
  52  | 
  53  |     // new-league dialog if present
  54  |     const newLeagueDlg = page.locator('#dlg-new-league');
  55  |     if (await newLeagueDlg.isVisible().catch(() => false)) {
  56  |       await page.locator('#new-league-id').fill(LEAGUE_ID);
  57  |       await shoot(page, '03_new_league_form');
  58  |       await page.locator('#btn-new-league-create').click();
  59  |       await page.waitForTimeout(1500);
  60  |     }
  61  |   }
  62  | 
  63  |   // Ensure we're on qa-g2 via API switch
  64  |   await page.evaluate(async (lid) => {
  65  |     await fetch('/api/leagues/switch', {
  66  |       method: 'POST',
  67  |       headers: { 'content-type': 'application/json' },
  68  |       body: JSON.stringify({ league_id: lid }),
  69  |     });
  70  |   }, LEAGUE_ID);
  71  |   await page.reload();
  72  |   await page.waitForTimeout(1500);
  73  |   await shoot(page, '04_after_switch');
  74  | 
  75  |   // 3. Check if setup needed; navigate to setup
  76  |   const setupBtn = page.locator('#btn-menu');
> 77  |   await setupBtn.click();
      |                  ^ Error: locator.click: Test timeout of 900000ms exceeded.
  78  |   await page.waitForTimeout(400);
  79  |   await shoot(page, '05_settings_dialog');
  80  |   await page.keyboard.press('Escape');
  81  |   await page.waitForTimeout(300);
  82  | 
  83  |   // Check league status
  84  |   const status = await page.evaluate(async () => {
  85  |     const r = await fetch('/api/league/status');
  86  |     return r.json();
  87  |   });
  88  |   logs.push(`[debug] league status=${JSON.stringify(status)}`);
  89  | 
  90  |   // If not setup, call setup API
  91  |   if (!status.setup_complete) {
  92  |     const setupRes = await page.evaluate(async () => {
  93  |       const r = await fetch('/api/league/setup', {
  94  |         method: 'POST',
  95  |         headers: { 'content-type': 'application/json' },
  96  |         body: JSON.stringify({}),
  97  |       });
  98  |       return { status: r.status, body: await r.text().catch(() => '') };
  99  |     });
  100 |     logs.push(`[debug] setup res=${JSON.stringify(setupRes)}`);
  101 |     await page.reload();
  102 |     await page.waitForTimeout(1500);
  103 |   }
  104 | 
  105 |   // 4. Draft page — main focus
  106 |   await page.goto(`${BASE}/#draft`);
  107 |   await page.waitForTimeout(1500);
  108 |   await shoot(page, '10_draft_initial');
  109 | 
  110 |   // Inspect draft hero & table
  111 |   const heroTxt = await page.locator('#draft-hero-container, .draft-hero').first().innerText().catch(() => '');
  112 |   logs.push(`[debug] draft hero txt len=${heroTxt.length}`);
  113 | 
  114 |   // Grab available rows
  115 |   const availRows = page.locator('table tbody tr');
  116 |   const rowCount = await availRows.count();
  117 |   logs.push(`[debug] draft rows=${rowCount}`);
  118 | 
  119 |   // Try manual picks: click 5 draft buttons whenever it's human turn
  120 |   for (let i = 0; i < 60; i++) {
  121 |     const state = await page.evaluate(async () => {
  122 |       const r = await fetch('/api/state');
  123 |       return r.json();
  124 |     });
  125 |     if (state.is_complete) {
  126 |       logs.push(`[debug] draft complete at iter ${i}`);
  127 |       break;
  128 |     }
  129 |     const isHuman = state.current_team_id === state.human_team_id;
  130 |     if (isHuman) {
  131 |       // Click first draft button
  132 |       const btn = page.locator('button[data-draft]').first();
  133 |       if (await btn.count()) {
  134 |         await btn.click();
  135 |         await page.waitForTimeout(400);
  136 |         if (i < 5) await shoot(page, `11_pick_${i + 1}`);
  137 |       } else {
  138 |         // fallback API pick
  139 |         await page.evaluate(async () => {
  140 |           const s = await fetch('/api/state').then((r) => r.json());
  141 |           const avail = (s.available || []).slice(0, 1);
  142 |           if (avail.length) {
  143 |             await fetch('/api/draft/pick', {
  144 |               method: 'POST',
  145 |               headers: { 'content-type': 'application/json' },
  146 |               body: JSON.stringify({ player_id: avail[0].id }),
  147 |             });
  148 |           }
  149 |         });
  150 |       }
  151 |     } else {
  152 |       // AI turn: try ai-advance
  153 |       await page.evaluate(async () => {
  154 |         await fetch('/api/draft/ai-advance', { method: 'POST' });
  155 |       });
  156 |       await page.waitForTimeout(200);
  157 |     }
  158 |   }
  159 |   await shoot(page, '12_draft_midway');
  160 | 
  161 |   // Try "sim to me"
  162 |   const simToMe = await page.evaluate(async () => {
  163 |     const r = await fetch('/api/draft/sim-to-me', { method: 'POST' });
  164 |     return { status: r.status };
  165 |   });
  166 |   logs.push(`[debug] sim-to-me=${JSON.stringify(simToMe)}`);
  167 |   await page.reload();
  168 |   await page.waitForTimeout(1500);
  169 |   await shoot(page, '13_after_sim');
  170 | 
  171 |   // Finish the draft via repeated ai-advance
  172 |   for (let i = 0; i < 200; i++) {
  173 |     const s = await page.evaluate(async () => (await fetch('/api/state')).json());
  174 |     if (s.is_complete) break;
  175 |     if (s.current_team_id === s.human_team_id) {
  176 |       await page.evaluate(async () => {
  177 |         const ss = await (await fetch('/api/state')).json();
```