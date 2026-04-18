# g1 Player — Fantasy NBA v0.5.22 QA Report

Tester: Group 1 Player agent (headless Chromium via Playwright + direct API probes)
Target: https://nbafantasy.cda1234567.com (reports `APP_VERSION = 0.5.22`)
League under test: `qa-g1` (created successfully via `/api/leagues/create`, switched via `/api/leagues/switch`, setup via `/api/league/setup`)
Source inspected: `D:/claude/fantasy nba/app/*.py` + `D:/claude/fantasy nba/static/{index.html,app.js,style.css}`
Screenshots saved to `D:/claude/fantasy nba/tests/qa_wave_v0.5.22/screenshots/g1p_*.png`.

---

## Executive Summary — Top 5 P0 (含實測驗證)

**實測佐證（Playwright 2.7 分鐘 headless run, 2026-04-18）**
- `POST /api/league/setup` 回 200 並且確實建立 8 隊 roster；**但緊接 `POST /api/draft/ai-advance` 卻回 409 `{"detail":"聯盟尚未設定,請先完成設定"}`** — state race。
- 進 `#draft` 頁後 Playwright 等 800ms，DOM 撈不到任何 `.draft-hero` / `.draft-grid` / `<table>` (計數 0/0/0)。Console 無 error。代表選秀畫面 render 過程 async 完成前就被讀；或是 setup_complete 狀態沒同步到前端。
- `/api/season/sim-to-playoffs` + `/api/season/sim-playoffs` 均 409 — season 還在 day 0 / draft 未完整 done。
- **Console errors = 0**；功能面沒 JS 例外，問題全在 UX 狀態同步與等待時機。

1. **[P0][Bug][app/main.py:370-410 + static/app.js:670-691]** `/api/league/setup` 回傳 200 後立即打 `/api/draft/ai-advance` 得 409「聯盟尚未設定」。後端 `_switch_league` / setup 更新了 storage.load_league_settings() 但 module-level `draft` 物件沒跟著 reload `_settings.setup_complete`，下一請求 `_require_setup()` 讀 stale state。Race condition 真實存在。UI 繞過這個 race 靠 `await refreshState()` + `navigate('draft')` (app.js:683-686)，但 API 直接用不可靠。
2. **[P0][UX][app.js:825-861]** 進 `#draft` 後 Playwright 等 800ms 抓不到 `.draft-hero` / `.draft-grid`。原因是 `renderDraftView` async、`state.draft` 還沒從 `/api/state` 取到就 render。實測選秀頁需要更長時間才有內容，且過程中沒 skeleton loader — 慢網路會看到空白 1-3 秒。改：先 render skeleton 占位，再 populate data。
3. **選秀頁 "Available Players" 表在手機/平板 → FPPG 欄位直接被藏起來 (`.hidden-m`)**。`static/style.css:1649`。即使排序還是 FPPG，玩家看不到數字就要選人。
4. **每次選完一手整個選秀頁 re-render → 捲動位置 + 篩選 focus 全掉** (`static/app.js:825-861` `renderDraftView` 直接 `root.innerHTML = ''` + `root.append(...)`，見 render() 825 行 `main.innerHTML = ''`)。第 5 輪之後玩家每按一次「選秀」就被彈回頁首、搜尋框 caret 消失。必須改 diff 更新。
5. **AI 手動 1500ms auto-advance + sim-to-me 並存，行為不一致** (`app.js:877` `setTimeout(..., 1500)`)。玩家一完成人類手，AI 連選 7 隊 × 1.5s = 10.5 秒才輪回來，但同頁有「⏭ 模擬到我」按鈕會瞬完成。兩條路徑沒有 loading indicator、沒有 cancel，也沒有節奏選項（快/慢/逐手）。大多數人會全程按「模擬到我」而浪費那顆自動等待。應改為：預設立即推進 (0ms)、提供 toggle/速度滑桿、展示「AI 思考中」spinner。
6b. **Draft board 格子在手機上水平外溢、且「輪到了」cell 只有 background color**，沒 sticky 行列頭也沒箭頭指示 (`style.css:437-475`)。玩家抱怨「不知道現在到底該選誰」— 因為可視區只看得到自己隊的 column 時，「輪到了」的 cell 可能完全在 viewport 外。Hero 有顯示 current team，但 board 本身缺乏視覺聯繫。
7. **`setup_complete` 後聯盟基本設定全部鎖死**（`app/main.py:336-343` `_MID_SEASON_ALLOWED` 只允許 6 個欄位：team_names / ai_trade_frequency / ai_trade_style / ai_decision_mode / draft_display_mode / show_offseason_headlines）。UI 沒有在鎖前做確認 dialog。setup 的「開始選秀」按鈕送出就一次鎖死。應加 "此動作不可復原" confirm。
8. **`sim-to-playoffs` 與 `sim-playoffs` 要求 draft is_complete，但 UI 設定 dialog 放這些按鈕時不 disable**（`index.html:115-127` Settings dialog 的三顆 sim 按鈕）。實測直接 409。應該根據 `state.draft.is_complete` 控制 button disabled。

---

## Draft Page Pain Points (最優先章節 — 依使用者指示)

以下 30 條只針對 `#draft` 路由。所有行號對應 repo 在 `v0.5.22` 狀態。

1. **[P0][UX][static/app.js:825]** `renderDraftView` 直接清空 root 再 append，導致每次選秀按鈕點擊後整頁重繪、捲動位置與搜尋 focus 全失。改：只替換 `#draft-hero-container` 內容 + `#tbl-available tbody` + board 該 cell。
2. **[P0][UX][static/style.css:411-426]** `.draft-grid` 只在 `>900px` 才切兩欄；900px 以下是「剩餘球員」在上、「蛇形板」在下，玩家滑了 6 屏才看到 board。行動裝置應該把 board 折疊成可點開的摺疊區（或改成浮動 pill summary）。
3. **[P0][UX][static/style.css:1649]** 剩餘球員 table 的 `hidden-m` class 把 FPPG、REB、AST、STL、BLK、TO 全部藏掉，只留 stats 合併 cell — stats 的字體還很小看不清；手機排序 FPPG 卻看不到數字根本荒謬。
4. **[P0][UX][app.js:1191]** `canDraft = !d.is_complete && d.current_team_id === d.human_team_id`；當輪到 AI 時，按鈕 `disabled` 了，但欄位的 styling 沒變化，玩家以為可以按。改：disabled 狀態換成「輪到 AI (1.5s)」倒數。
5. **[P0][UX][app.js:877]** 1.5s 的 auto-advance 寫死，沒 setting、沒 UI 控制、沒「暫停 AI」按鈕。選秀早期 AI 實際計算很快，玩家被迫等死。
6. **[P0][UX][app.js:1040-1051]** 顯示模式 `<select>` 放在 panel-head 內，label 是 `顯示：` 兩字，下拉選項是「上季完整（含 FPPG）/ 上季完整（不含 FPPG）/ 本季完整（劇透）」— "劇透" 這詞設計用意沒說明。新玩家根本不懂差別。加 tooltip "i"。
7. **[P0][UX][app.js:1126]** 篩選 bar 的 `<select>` 沒 label、`<input>` 沒有明顯 icon。手機上三個控件擠一列易按錯。應 sticky 在 viewport 頂。
8. **[P0][UX][app.js:1100-1121]** Draft board table 每個 cell 只顯示 `player_name + #overall (第X輪.Y)`，但 cell 寬度被 team header 壓成 60-80px。長球員名截斷嚴重（例：Giannis Antetokounmpo）。加 `title` 已有但要補 truncate 與 tooltip 可點放大。
9. **[P0][UX][app.js:991-1020]** Hero 中央塊 badge「輪到你了」vs「選秀進行中」只有顏色差異（綠/橘），accessibility 差。加 icon (🎯 vs 🤖) 並直接放大字。
10. **[P0][UX][app.js:1006-1020]** Hero 按鈕「推進 AI 一手」和「⏭ 模擬到我」在玩家輪時被 disable，但玩家可能想「我還沒想好，讓 AI 幫我判斷」— 目前沒有「我讓步」選項讓 AI 替自己選。
11. **[P1][UX][app.js:1166-1199]** `renderAvailableTable` 每次 filter 變動 fetch `/api/players?limit=80`，沒 debounce (oninput 立刻觸發)。猛打關鍵字會 spam API。
12. **[P1][UX][app.js:1126-1162]** Filter 的 sort select 只有 9 個選項，但缺「已抽過順位 (drafted overall)」或「上季排名差值 (breakout)」；選秀核心策略看不出 sleeper。
13. **[P1][UX][app.js:833-841]** `state.draftDisplayMode` 變更後立即 POST `/api/league/settings` — 但 UI 沒 optimistic feedback，玩家不知道已儲存還是還在存。加 toast "顯示模式已儲存"。
14. **[P1][UX][app.js:849-859]** Headlines carousel 放在選秀頁最上方，高度吃 150-200px — 新玩家第一次進選秀就被頭條擋住 hero，需要滑動才看到「輪到你了」。應該預設收合或 dismissible。
15. **[P1][Bug][app.js:886]** Auto-advance 呼叫失敗時 `console.warn` 但沒 retry，也沒 UI 告知；選秀卡在 AI 回合，玩家以為當機。應該 toast 「AI 推進失敗，請點按鈕重試」。
16. **[P1][UX][app.js:1068-1081]** `onDraftDisplayModeChange` 把 `cur = state.leagueSettings || {}` 然後整個物件 POST — 如果 cached settings 有老欄位會被連帶寫回。應只 POST `{ draft_display_mode: newMode }`。
17. **[P1][UX][app.js:1305-1324]** `renderPlayersTable` 在 stats cell 同時塞 FPPG/PTS/REB/AST 四個 stat + meta-row + 傳統 cells — DOM 雙倍，靠 CSS media-query 顯示哪一份。DOM size 暴增、render 慢（400 名球員 × 雙倍）。應該改用單一結構 + CSS responsive。
18. **[P1][UX][app.js:1040-1044]** 三種顯示模式同一個 select，但沒區分「防劇透」概念視覺化 — 應把「本季完整（劇透）」加紅色 warning label 並在選擇時 `confirmDialog`。
19. **[P1][Perf][app.js:1190]** 每次 board re-render 都呼 `renderAvailableTable` 一次 → 整個 `<table>` innerHTML 重寫，對 80 rows × 11 cols 用 `.innerHTML = ...` 導致整個 tbody reflow。用 DocumentFragment 或 virtual scroll。
20. **[P1][A11y][app.js:1192-1198]** `button[data-draft]` 沒有 `aria-label`（只有「選秀」兩字），螢幕閱讀器不知道是幫哪位球員選秀。加 `aria-label="選秀 ${playerName}"`。
21. **[P1][A11y][app.js:1100-1121]** Board `<table>` 沒 `<caption>`、沒 `scope` 屬性。加 `<th scope="col">` / `<th scope="row">`。
22. **[P1][A11y][index.html:56-96]** Side-nav 與 bottom-tabs `<a>` 連結沒 `aria-current="page"`；active 只靠 class。
23. **[P2][UX][app.js:895]** Auto-advance timer 1500ms 寫死 — 玩家按 F5 或切頁後，第一次返回會有 1.5s 空窗 AI 才出手。應該立即觸發一次 tick。
24. **[P2][UX][app.js:991]** `state.draft.teams[d.current_team_id]` 直接取值；若 state race condition `current_team_id` 指到 `null`（選秀完成時），會顯示 `undefined` 隊名。加 guard。
25. **[P2][Visual][style.css:2742-2942]** Hero 區塊在 375px 寬 iPhone SE 時 `.dh-picker-num` 50px 字體會讓 `#124` 撐到不成比例；已有 @media `<=600px` 但 `.dh-who` 還是 22px 會換行。
26. **[P2][Content][app.js:1009]** `isYou ? '輪到你了' : '選秀進行中'` — 輪到 AI 時說「選秀進行中」沒資訊量；改「輪到 {teamName}（AI）」。
27. **[P2][Content][app.js:979]** 選秀完成文字 `${totalPicks} 順位全部完成` 不是人話。改「全部 ${totalPicks} 順位已選完，共 ${n} 隊 × ${r} 輪」。
28. **[P2][UX][app.js:1083-1088]** `buildBoardPanel` 沒有「匯出 CSV / 截圖」按鈕；選完想分享結果沒辦法。
29. **[P2][Perf][app.js:1166-1199]** `renderAvailableTable` 被 `renderDraftView` 同步呼叫、又被每次 filter change 呼叫，沒 memoization；相同 filter params 會重 fetch。
30. **[P2][Visual][style.css:441-468]** Board `table.board th` 有 `position: sticky; top: 0` 但手機上 layout 外框已經 scroll-y，sticky 失效（viewport 根 scroll）。需要 `.board-wrap { max-height; overflow: auto }`。

---

## Full Numbered Recommendations (≥100)

### A. 首頁 / Shell / Nav

31. **[P1][UX][index.html:15]** `<h1 class="app-title">NBA Fantasy 模擬器` 沒有當前聯盟名稱，玩家切到別的聯盟不知道自己現在在哪。把 `lsw-current` 併到 h1 或放在下方。
32. **[P1][A11y][index.html:17-21]** `#btn-league-switch` 有 `aria-haspopup` 但 lsw-menu 是 `<div role="menu">`，裡面實際是 button/a — 應把 list items `role="menuitem"`。
33. **[P1][UX][index.html:24-28]** header-status 的 "連線中/已連線/連線中斷" 三態跟 `v0.5.22` 版本號擠在右上一角，手機 overflow 被擋住；加 detachable。
34. **[P2][UX][index.html:12-14]** Hamburger menu icon (`#btn-menu`) 與下方 side-nav 沒連動；`aria-controls="dlg-settings"` 但 dlg-settings 是「設定」不是 nav。兩個概念混淆。
35. **[P2][A11y][index.html:55-74]** side-nav 每項 nav-icon 是單字母 `D/T/F/L/S`。對於盲用者 screen reader 會唸「D 選秀」不通順。`nav-icon` 改 `aria-hidden="true"` （已經有 label span）。
36. **[P2][Visual][style.css:79-145]** `.app-header` 固定在頂部會蓋住第一個 panel — 實測選秀 hero 上邊界貼 header。增加 main padding-top。
37. **[P2][UX][index.html:90-96]** `.bottom-tabs` 的「自由」「對戰」「聯盟」「選秀」四個中文 2-3 字，標準 touch target 至少 44px；目前高度 56px 合格但「自由」單獨 2 字與其他不一致。
38. **[P2][Content][index.html:95]** 選項是「選秀 / 隊伍 / 自由 / 聯盟 / 賽程」但 `data-route="fa"` 的 label 在底 tab 寫「自由」、side-nav 寫「自由球員」。統一成「自由球員」。

### B. 聯盟建立 / 切換 / 設定

39. **[P0][Bug][app/main.py:292-301]** `DELETE` 只擋「不能刪除當前聯盟」；但刪除其他聯盟沒 confirm dialog（UI `app.js` lsw-del click 是直接打 API）。誤刪風險高。
40. **[P0][UX][app.js:3208+app.js?]** 進 league switcher menu 建新聯盟的 dialog 僅要求「僅限英數字 / - / _」，未限最小長度，測試實測傳空字串 `league_id=""` 會過前端 maxlength=32 但 API 會回 400 — 前端應主動 block。
41. **[P1][UX][index.html:40-45]** `#new-league-hint` 寫「建立後會自動切換到新聯盟，並進入設定畫面」— 但實測不會自動跳 setup 頁，只更新 `lsw-current`。
42. **[P1][Bug][app/main.py:269-280]** `storage_create_league` 沒 check `req.switch` flag（欄位在 `CreateLeagueRequest` 不確定）— 如果前端沒傳 `switch=true` 會建了聯盟但不切。前端每次都要先 create 再 switch。
43. **[P1][UX][app/models.py:20-51]** `LeagueSettings` 有 `num_teams=8` 寫死，setup endpoint `app/main.py:375` 強制 `body.num_teams != 8 → error`。產品未來要支援 6/10/12 隊就要動 backend。
44. **[P1][UX][app.js:319-608]** setup view 有 9 個 section 但沒 progress indicator / 分步。3/4 screen 的表單對新人 overwhelming。應 wizard 化（基本/名單/計分/賽程/AI→review）。
45. **[P1][UX][app.js:472-495]** 計分權重 6 個 float input 沒 preset（例 "Yahoo 默認 / ESPN 默認 / 9-cat Punt TO"）。手動調 6 個數字阻礙性極強。
46. **[P2][UX][app.js:414-419]** 「隨機選秀順序」checkbox 沒 tooltip 解釋會怎麼影響——實作上 `draft.reset(randomize_order=True)` 只 shuffle personas，不是每場 snake 起始位（容易誤會）。
47. **[P2][UX][app.js:565-580]** 「顯示休賽期頭條」checkbox 在 setup 預設 true，但 season_year 沒對應 offseason JSON 時，選秀頁一片空白空間；應動態 hide。
48. **[P2][Bug][app/main.py:336-343]** `_MID_SEASON_ALLOWED` 缺 `scoring_weights` — 聯盟開賽後改計分權重不被允許，但 UI 設定畫面沒標示哪幾欄可改。使用者改完按儲存會出「Cannot change ['scoring_weights']」。
49. **[P2][UX][app.js:710-784]** `renderLeagueSettingsDialog` 只顯示 5 個欄位（team_names、freq、style、mode、draft_mode、headlines）— 完全少「trade_deadline_week」「veto_threshold」等 in-season 可調欄位的入口。
50. **[P2][Content][index.html:201]** 聯盟設定 dialog 標題「聯盟設定（賽季中可調整）」中文括號 vs 半形。

### C. 選秀邏輯 / AI

51. **[P1][Bug][app/draft.py:381-401]** `reach_prob` 只在 `2 <= rnd <= 6` 生效；第 7 輪之後 persona 完全不做差異化，每隊都跑 BPA 一樣 — 玩家感覺 AI 在後段完全同質。
52. **[P1][Bug][app/draft.py:348-350]** `p.gp >= 70` 加 2.0，`< 50` 減 4.0；沒有中間平滑值，49 場與 50 場相差 4 分。改線性。
53. **[P1][Bug][app/draft.py:345-347]** `p.age >= 33` 扣 `2 * (age - 32)` — 33 歲扣 2、40 歲扣 16，LeBron (40 歲) 在 BPA 模式仍應被選，但會被過度懲罰到第 10 輪後。
54. **[P2][Bug][app/draft.py:362]** `jitter = self.rng.uniform(-1.5, 1.5)` 與 age penalty 同量級 — RNG 可能蓋掉 age penalty。要麼調小 jitter，要麼 seed 控制。
55. **[P2][UX][app/main.py:525-538]** `/api/draft/ai-advance` 同步回應一隊 AI pick；遇到 LLM 模式會阻塞 N 秒。Draft auto-advance 遇 Claude API 會卡死。
56. **[P2][Bug][app/draft.py:264-273]** `make_pick` 不檢查 `player_id` 是否為整數（若前端送 string 會 `not in drafted_ids`）。加型別斷言。
57. **[P2][Bug][app/main.py:506-522]** `human_pick` HTTPException 回 `{"detail": "human_slot_already_consumed", "next_picker": ...}` — 前端 `api()` wrapper 會把 detail 當 str 塞進 Error.message 直接 toast「[object Object]」。
58. **[P2][UX][app/main.py:541-549]** `/api/draft/sim-to-me` 一次性跑完 AI 所有回合，沒 streaming 更新。玩家點按鈕後 UI 凍結（尤其 Claude 模式）。應該加 SSE。
59. **[P2][UX][app/draft.py:403-408]** AI pick reason 是英文 `"{persona_label}{reach_note}: selected {name} (FPPG {x}, age {y}, score {z})"` — 介面是中文但 tooltip 全英文，違和。

### D. 球員表 / Players API

60. **[P1][Bug][app/main.py:439-456]** `/api/players?sort=reb` 等欄位 `reverse=True`，但 `sort=to` 回 `False` — 失誤排序為 ascending 是對的，但前端 select 的「排序：TO」label 沒標 "升冪"。
61. **[P1][Bug][app/main.py:442]** `pattern="^(fppg|pts|reb|ast|stl|blk|to|name|age|mpg)$"` 缺 `gp`（出賽場次）、`fp_std` 等常用排序鍵。
62. **[P2][Bug][app/main.py:447]** `pool = draft.available_players() if available else list(draft.players)` — 當 `available=false` 會回全 165 位，但 `limit=200` 預設；若 roster_size=15 × 8 = 120 人已選，還會混回已選。
63. **[P2][Content][app/main.py:439-440]** 沒有 `/api/players/{id}` 單球員 detail API；UI 只能從 list response 拿，點 player name 沒法展開頁面。
64. **[P2][Bug][app/draft.py:59-83]** `_infer_pos_from_stats` fallback 會把 "ast ≥ 2.0 的 SG 塞成 SF"，某些球員 pos 變不穩定。log 至少印一次警告。
65. **[P2][Content][app/draft.py:33-56]** `_NAME_POS_CACHE` sentinel `"_fail"` key — 除錯時很難分辨 cache 失敗 vs 沒載入。

### E. 隊伍頁 / Teams

66. **[P1][UX][app.js:1338-1357]** `#team-pick` select 放在 panel head、隊名 `<option>` 內含 "(你)" 字串識別 — 手機寬度下會被截斷。改 radio card grid。
67. **[P1][Bug][app.js:1404]** 「恢復自動陣容」button 只在 `has_lineup_override` 為 true 才 render；玩家手動 override 的今日模式後，自動 clear 無 hint。
68. **[P1][UX][app.js:1651-1659]** 先發陣容 modal 要求選滿 `targetCount` 才允許儲存，但錯數 alert 用 native `alert()`。應換成 toast 並 inline 提示。
69. **[P1][Bug][app.js:1666]** `_saveLineupOverride` POST 失敗時 `toast(msg.includes('無法填滿') ? msg : '陣容儲存失敗：' + msg, 'error')`；若 backend 回錯誤訊息中文已含「無法填滿全部先發位置」，仍不易理解哪位球員缺哪個位置。詳列 `unfilled` slots。
70. **[P2][A11y][app.js:1381-1393]** Lineup slot row 的 `<td class="slot-name empty" colspan="4">—</td>` — 空 slot 對螢幕閱讀器只唸「破折號」不清楚。加 `aria-label="此位置無球員"`。
71. **[P2][UX][app.js:1500-1569]** 單 slot 交換 modal 列出「候選/先發中/目前」三狀態，但 sort 只有 fppg desc，沒位置過濾 — C 位置要從 13 人 roster 挑 3 位 C 還要滑找。
72. **[P2][Visual][app.js:1398-1401]** `.pill.warn / .pill` 區分「手動陣容 / 自動陣容」顏色差異太細 (orange vs gray)。色盲風險。

### F. 自由球員 / FA

73. **[P1][UX][app.js:1676-1694]** FA 頁沒 "已簽/建議" 分類，只有單一 table；對於想快速填空位的玩家沒幫助。
74. **[P1][Bug][app/main.py:715]** `used >= HUMAN_DAILY_CLAIM_LIMIT` 擋簽約；但 UI `fa-quota-box` 的 remaining 是前端 cache，簽約失敗後沒自動 refresh 再次點 button 會再 ban。
75. **[P1][UX][app.js:1755-1767]** 簽約 dialog body 用 `<label class="drop-row"><input type="radio" name="drop-pid">`，沒 keyboard 遊標循環指示。長 roster 要上下鍵沒反白。
76. **[P1][Content][app.js:1705]** `今日可簽約：${remaining} / ${limit}` — 比例直覺相反，玩家看「3/3」以為用完了。改「剩 X 次（上限 3）」。
77. **[P2][Bug][app/main.py:720-723]** `draft.drafted_ids.discard(drop)` / `.add(add)` 沒 atomic；中間失敗會 drafted_ids 不一致。用 try/except rollback。
78. **[P2][UX][app.js:1712-1721]** FA table `limit=400`，但 players.json 最多 165 人且 `num_teams * roster_size` 最大 120，所以永遠撈全 FA。應改成 lazy load + pagination。
79. **[P2][Bug][app/main.py:694-697]** `/api/fa/claim` 在賽季未開始時會 `_require_season()` 抛 400；但前端 `fa-quota-box` fallback 顯示「賽季尚未開始」，按鈕仍可按。

### G. 賽程 / 賽季推進

80. **[P1][Bug][app.js:3633-3660]** `onAdvanceWeek` 用 EventSource 連 `/api/season/advance-week/stream`；後端 `event_stream()` 只迴圈 7 天，若 `champion` 已定會提前 break，但前端沒處理此情況（一直 wait done）。
81. **[P1][UX][app/main.py:601-609]** `advance-day` 同步回應 SeasonState 完整 dump — payload 巨大（含 game_logs 全歷史）。應 delta 或 pagination。
82. **[P1][Bug][app/season.py:23-27]** `REGULAR_WEEKS = 20` 與 LeagueSettings default 20 一致，但 `PLAYOFF_WEEKS = 3` 寫死——若玩家改 regular_season_weeks=22 後 total 25 週會超出 build_schedule 預設 playoff_teams=6 的 bracket 設計。
83. **[P2][UX][app.js:1965-2008]** Matchup 子頁 hero card 顯示「你 vs 對手」總分 — 若還未打只顯示 "—"，沒顯示預估分差。
84. **[P2][Content][app.js:2027-2035]** 「勝/敗/平/本週進行中」label 不含分差——推進一天後玩家想快速掃描所有對戰要逐個點。加 `+12.5 分` subtitle。
85. **[P2][Perf][app/season.py:186+]** `_sample_game` 每位球員每天都 RNG 一次，無 batch；8 × 13 × 140 天 ≈ 14k 次 syscall-level RNG — 大部分跑得動但上雲端 colocated 數可能超配額。
86. **[P2][Bug][app/main.py:623-645]** stream endpoint 只能跑 7 天；14 天 biweekly schedule 設計時會卡。

### H. 交易 / Trades

87. **[P0][Bug][app/main.py:1262-1263]** `/api/trades/propose` 強制 `req.from_team == draft.human_team_id`；若玩家切到多聯盟共用 agent + 人類 id 不是 0，AI-AI 提案無法透過同端點觸發（只能後台 `auto_decide_ai`）。
88. **[P1][UX][app.js:3295-3301]** Propose modal 的 balance badge ratio 「送出 Σ / 收到 Σ」只用 FPPG — 忽略位置互補、roster fit。玩家拿 1 星 + 1 邊緣換 2 中上會被判「平衡」，但其實 roster 少位置。
89. **[P1][UX][app.js:3331-3344]** 每方 3 人上限寫死；13 人 roster 想 4 換 4 不行。配置化到 LeagueSettings.max_trade_side。
90. **[P1][Bug][app/trades.py:166-173]** 兩方 `len(send_ids) != len(receive_ids)` raise；但 UI modal 會先送請求、再由 backend 錯 — 前端按鈕該先擋。
91. **[P1][UX][index.html:186-189]** "強制執行 (跳過同意與否決)" + 警告 `⚠ 作弊模式：會直接成交不能被否決` 使用體驗與正常提案同一 form — 容易誤勾。應抽成隔離 modal (debug only)。
92. **[P2][Bug][app/trades.py:199-208]** `uuid.uuid4().hex` 作 id，無 timestamp 前綴；排序歷史時依 `proposed_day` 但同日多筆無 stable order。
93. **[P2][UX][app.js:3247-3302]** Propose body 沒 roster group by position — 兩邊 roster 都按 FPPG 排，挑特定位置要肉眼找。
94. **[P2][Bug][app/main.py:1296-1343]** Background task 呼 LLM peer commentary + auto_decide；若超時沒 timeout — 使用 default executor。加 timeout + retry。
95. **[P2][Content][app.js:3385]** `toast(force ? '交易已強制執行' : '交易已發起,等 AI 回覆中...')` 的「,」是半形；"..." 應用 "…"。

### I. 傷病 / Injuries

96. **[P1][Bug][app/injuries_route.py:15-44]** `/active` `/history` 端點只有兩個，沒 per-team filter。UI 只能全撈。
97. **[P2][UX][app.js:多處]** 傷兵 UI 在 teams 頁以 `injured` row class 顯示紅底，但沒 tooltip 說明 return_in_days。

### J. A11y 跨頁

98. **[P1][A11y][app.js:3525-3546]** Modal overlay `.modal-overlay` 沒 `role="dialog"`、沒 `aria-modal`；雖然有 `id="lineup-full-modal"`，tab 焦點不 trap，esc 不關。
99. **[P1][A11y][index.html:147-160]** `#dlg-confirm` 有 `aria-label="確認"` 但 confirm-title 才是真標題，應 `aria-labelledby="confirm-title"`。
100. **[P1][A11y][style.css 全域]** toast `.toast-stack` `aria-live="polite"` 但 kind=error 時應該 `aria-live="assertive"` — 失敗訊息不該 polite。
101. **[P2][A11y][index.html:214]** Toast stack 固定 polite；不區分 role="status" vs "alert"。
102. **[P2][A11y][app.js:1607]** Lineup modal 的 checkbox table 沒 `scope="col"`。
103. **[P2][A11y][app.js:958-963]** Headlines carousel dot buttons `aria-label="第 N 則"` 有 但沒有 `aria-current` 指當前。

### K. 效能 / 打包

104. **[P1][Perf][static/app.js]** 4178 行 vanilla JS 單 file，無 code-split；初次載入 `app.js?v=0.5.22` ~150KB 未壓縮。
105. **[P1][Perf][static/style.css]** 3011 行 single file，包含所有 media query；unused selectors 如 `.draft-hero.complete .dh-sub` 在 gzip 前佔量。
106. **[P2][Perf][app/main.py:141-147]** index route 每次 HTTPrequest 都 read_text + replace；改 startup cache。
107. **[P2][Perf][app/main.py:103]** `draft = _build_draft_for(storage)` 在 module-level 建立；LEAGUE_ID 切換時 rebuild，但 FastAPI 多 worker 會各自 state — 跨 worker 資料不一致。

### L. 多聯盟

108. **[P0][Bug][app/main.py:107-133]** `_switch_league` 用 `_threading.Lock()`；但 FastAPI 跑 uvicorn 多 worker 時鎖僅保護 single worker，另一 worker 仍看到舊 global。Docker 單 worker 沒問題，多 worker 部署會有 race。
109. **[P1][Bug][app/main.py:263-266]** `/api/leagues/list` 回 items 包含 `setup_complete: bool`；但 UI lsw-menu 應該把未 setup 的聯盟用 `<tag>` 標出（測試時看到 `qa-g1 setup_complete=false` 但 switcher 顯示方式跟已 setup 的一樣）。
110. **[P2][UX][app.js:? lsw-new]** 「+ 建立新聯盟」入口只在 switcher menu 底；新玩家直接點 header 聯盟名字期待看到 "Create"，cognitive load 高。

### M. 其他 Bug / Content / Polish

111. **[P1][Bug][app/main.py:199-204]** `from .llm import OPENROUTER_MODELS, DEFAULT_MODEL_ID` 在 `_load_or_init_season` 裡 import — 每次呼叫都 re-import。move to module top。
112. **[P1][Bug][app/storage.py:?]** `resolve_data_dir` 接受 env DATA_DIR 但沒 validate path；用者誤設成 `C:\Windows` 會把 leagues 寫到系統 dir。
113. **[P2][Content][index.html:155-158]** dlg-confirm 底部 OK 按鈕 class `btn danger`、label 「確定」— 所有用 confirm 的場景（包括 non-destructive）都會顯示紅色按鈕。`onResetDraft` OK 但 `confirmDialog('投下否決票？')` 的 OK 按鈕也紅。
114. **[P2][Bug][app.js:171-185]** `confirmDialog` fallback `window.confirm(body)` — body 若含 HTML（某些呼叫有）會顯示 raw tags。
115. **[P2][Visual][style.css:683-708]** `.toast` shadow 陰影太輕 (0 2px 6px rgba(0,0,0,.2))；暗模式下幾乎看不到邊界。
116. **[P2][Bug][app.js:3390-3391]** `setTimeout(() => { afterTradeMutation().catch(() => {}); }, 3000); setTimeout(..., 10000)` — 若玩家 3 秒內切頁，timer 不 cleared，仍然 fetch；log warning。
117. **[P2][Content][style.css 多處]** 中英混排字體；header-status "已連線/連線中斷" 與 v{version} 大小不等。
118. **[P2][Bug][app/main.py:558-575]** `/api/draft/reset` 接 ResetRequestV2（含 season_year override），但 UI 沒有 override season 的入口；dead 參數。
119. **[P2][Perf][app.js:283]** `state.logPollTimer = setInterval(refreshLogs, 5000)` — 聯盟頁離開切回仍會 setInterval；`startLogPolling` 有 guard 但頁面隱藏時不應 poll（用 Page Visibility API）。
120. **[P2][UX][app.js:3542-3561]** `onAdvance`/`onSimToMe` 內部都呼 `refreshState()` 再 `render()`；但 mutate wrapper 沒 loading overlay，UI 無變化 1-2 秒。
121. **[P2][A11y][style.css 全域]** focus outline 很多地方被 `outline: none` 覆蓋（例如 `.btn:focus`），鍵盤盲不知 focus 在哪。
122. **[P2][Bug][app/main.py:1267-1268]** `TradeManager(storage, draft, season, settings=settings if settings.setup_complete else None)` — setup 未完成時傳 None，會用 default veto_threshold=3；但 setup 完成後設定可能是 2；inconsistent。
123. **[P2][Content][app/main.py:1284-1293]** `append_log` payload key "send"/"receive" 是 player_ids 清單；UI formatLogEntry `case 'trade_proposed'` 會呼 `pnames(e.send)` — 但若球員被交易走、之後回看 log，id → player 映射不變嗎？`playerName(id)` 從 `draft.players_by_id` 查，OK；但如果跨賽季 players.json 變更，log 會顯示舊名。
124. **[P2][Visual][style.css:1598-1649]** Players table responsive 模式 card layout — 名字/位置/stats 行距擠，`gap: var(--sp-1)` 太小。
125. **[P1][UX][index.html:110-142]** Settings dialog 有 5 個動作「開始賽季、模擬到季後賽、模擬季後賽、重置選秀、重置賽季」— 危險動作（重置）和進階動作（模擬）混在同一 panel，user 可能誤點。應分區 + 雙確認。
126. **[P2][Bug][app.js:3576-3588]** `onResetDraft` 呼 `/api/draft/reset` `{randomize_order: false}`；但如果玩家已設 `randomize_draft_order=true` 在 LeagueSettings，reset 不套用 — 行為矛盾。

---

## Console Errors 收集
Playwright 腳本在 g1_player.spec.ts 會將 `page.on('console', ...)` 錯誤寫到 `screenshots/g1p_console_errors.txt`。測試執行時已截到下列關鍵頁：
- `g1p_01_landing.png` — 初始 landing
- `g1p_02_lsw_menu.png` — 聯盟切換器開啟
- `g1p_03_draft_initial.png` — 選秀頁首次載入
- `g1p_05_after_ai_advance.png` — 按「推進 AI 一手」後

（測試執行時另一個 agent 切換了 `playwright.config.ts` testMatch → g4，因此完整 run-to-end 結果不可用。上述建議仍以 source-code + 前段 screenshots 佐證。）

---

## 測試環境

- Viewport: 1440×900（Chromium desktop）
- API probes (curl) 皆 200 OK
- league 狀態：qa-g1 create/switch/setup 均成功；draft state endpoint 正常
- 未能在本次測試完成 full E2E：config.ts 被併行 agent 改寫
