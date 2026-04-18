# QA Test Report: Wave K Q2 — 完整一季 Playthrough

**測試日期**: 2026-04-17  
**測試人員**: Q2 QA Agent (claude-sonnet-4-6)  
**測試目標**: https://nbafantasy.cda1234567.com (v0.4.2 Wave K)  
**測試方式**: claude-in-chrome MCP 瀏覽器自動化 + 直接 API 呼叫

---

## Environment

- **Session**: claude-in-chrome MCP (tabId: 2088936391)
- **Service**: NBA Fantasy 模擬器 v0.4.2
- **URL**: https://nbafantasy.cda1234567.com
- **Browser**: Chrome (existing tab)
- **Viewport**: 1568x706

---

## Test Cases

### TC1: 顯示模式下拉選單（Wave K 新功能）
- **Command**: 進入 #draft 頁面，觀察「剩餘球員」標題上方是否有顯示模式下拉選單（prev_full / prev_no_fppg / current_full）
- **Expected**: 顯示下拉選單，可在三種模式間切換
- **Actual**: 「剩餘球員（顯示上季 FPPG）」標題以靜態文字呈現，無下拉選單。僅有搜尋欄、位置篩選、排序方式三個控制項。
- **Status**: **FAIL**
- **Screenshot**: ss_9228w3iei（reload 後確認）

---

### TC2: AI 自動選秀（Wave K 新功能 — 1.5 秒自動推進）
- **Command**: 人類選秀後，等待 AI（BPA Nerd）是否在 1.5 秒內自動選秀（不需按「推進 AI」）
- **Expected**: AI 在人類選完後 1.5 秒內自動推進，不需手動觸發
- **Actual**: 等待 8 秒以上，AI 完全未自動推進。UI 停留在「輪到 BPA Nerd」狀態不動。需要手動按「推進 AI」或「模擬到我」才有反應。
- **Status**: **FAIL**
- **Notes**: 多次重複測試（3 次重置後）均未觀察到自動推進行為

---

### TC3: 選秀板即時更新（蛇形選秀板同步問題）
- **Command**: 人類選秀後，觀察蛇形選秀板是否即時顯示選秀結果
- **Expected**: 點擊「選」後蛇形板立即顯示球員名稱
- **Actual**: 選秀成功後（球員已從可用列表移除），蛇形板第1輪「我的隊伍」格子仍顯示「輪到了」，不顯示選擇的球員名稱。需 F5 重新整理才能看到正確結果。
- **Status**: **FAIL**
- **Notes**: 涉及前端 state 與後端 API 不同步

---

### TC4: 活動記錄繁中（Wave K 修補）
- **Command**: 推進一週或模擬後，觀察右側活動記錄是否顯示繁中
- **Expected**: 顯示「第 X 天比賽結束」「XX 向 YY 提出交易」等繁中描述
- **Actual**: 活動記錄全部顯示英文代碼，例如：
  - `day_advance`
  - `trade_proposed`
  - `trade_executed`
  - `trade_accepted`
  - `trade_veto_vote`
  - `trade_cancelled`
  - `season_start`
  - `season_reset`
  - `ai_decision Stars & Scrubs lineup (stars_scrubs) - Maximizing Stars & Scrubs strategy...`（完整英文句子）
- **Status**: **FAIL**
- **Screenshot**: ss_29984v19u, ss_1653hc8ys

---

### TC5: 前往聯盟按鈕文字消失
- **Command**: 選秀完成後，觀察「前往聯盟」按鈕
- **Expected**: 按鈕顯示「前往聯盟」文字
- **Actual**: 在特定狀態下（選秀完成但賽季尚未啟動的過渡期），按鈕出現藍色背景但無文字（空白）。reload 後恢復正常。
- **Status**: **FAIL（間歇性）**
- **Screenshot**: ss_42805dng9（zoom 確認空白按鈕）
- **Notes**: 可復現條件 — 按「推進 AI」完成全部選秀後立即看到此狀態

---

### TC6: 模擬到我 refreshState 同步（Wave K 修補）
- **Command**: 點擊「模擬到我」，驗證 UI 自動刷新不需 reload
- **Expected**: UI 自動同步顯示最新選秀狀態
- **Actual**: 點擊「模擬到我」後，後端 `/api/state` 確認 `is_complete: true`、`total_picks: 104`，但前端 UI 仍顯示「第1輪第1順，輪到你了」，蛇形板全空。需 F5 重整才能看到正確狀態。
- **Status**: **FAIL**
- **Notes**: Wave K 修補聲稱「模擬到我會 refreshState 強制同步」，實際無效

---

### TC7: 聯盟路由守衛導致選秀未正式啟動
- **Command**: 選秀完成後，點擊「前往聯盟」，觀察是否成功進入聯盟頁
- **Expected**: 正常跳轉聯盟頁，保持 URL = #league
- **Actual**: 前端路由守衛（`renderLeagueView` 第1494行）在偵測到 `d.is_complete` 為 false 時強制顯示「選秀尚未完成」。後端 `/api/state` 顯示選秀完成，但前端快取狀態未更新（TC6 問題），導致路由守衛誤判，無法進入聯盟頁面，並有時重導回 #draft。
- **Status**: **FAIL**
- **Root Cause**: `refreshState()` 呼叫後前端 `state.draft` 未正確從後端同步

---

### TC8: 推進一週觸發後端狀態異常
- **Command**: 進入聯盟頁，按「推進一週」按鈕
- **Expected**: 推進7天，顯示週結果，活動記錄更新
- **Actual**: 第一次按「推進一週」正常（活動記錄更新），第二次按下後 URL 跳回 #draft，後端 `/api/state` 回傳 `is_complete: false`、`picks: 0`，選秀資料清空。活動記錄顯示新的 `season_reset`。
- **Status**: **FAIL**
- **Notes**: 症狀與 TC7 相同——後端 advance-week 可能觸發了某些副作用，或 refreshState 與 season_reset 存在競態條件

---

### TC9: AI 隊伍陣容為空（得分異常）
- **Command**: 推進一週後，觀察各隊得分
- **Expected**: 8隊均有合理得分（>0）
- **Actual**: 活動記錄顯示：
  - `ai_decision Contrarian lineup - No roster provided`
  - `ai_decision Vet Win-Now lineup - Since my roster is empty, I cannot set a lineup`
  - `ai_decision Stars & Scrubs - Cannot field a lineup: roster is empty (0 players)`
  - `ai_decision Balanced Builder - No players available on roster`
  - 只有我的隊伍（team 0）有得分（65 FP），其他 7 隊得分均為 0.0
- **Status**: **FAIL**
- **Notes**: AI 隊伍在 season_start 後 roster 為空，原因待查（可能與選秀資料被清空有關）

---

### TC10: 交易面板開啟速度
- **Command**: 點擊「發起交易」按鈕，計時反應時間
- **Expected**: 3秒內開啟交易對話框
- **Actual**: 約 1 秒內立即開啟，交易對話框顯示正常，UI 為繁中
- **Status**: **PASS**
- **Screenshot**: ss_1129g826h

---

### TC11: AI 模型白名單驗證
- **Command**: `GET /api/season/ai-models`（賽季啟動後）
- **Expected**: 所有 AI GM 使用白名單模型
- **Actual**: 所有 7 隊 AI 模型均在白名單內：
  - BPA Nerd: `google/gemini-2.0-flash-001` ✓
  - Punt TO: `meta-llama/llama-3.3-70b-instruct` ✓
  - Stars & Scrubs: `mistralai/mistral-small-3.1-24b-instruct` ✓
  - Balanced Builder: `mistralai/mistral-small-3.1-24b-instruct` ✓
  - Youth Upside: `anthropic/claude-haiku-4.5` ✓
  - Vet Win-Now: `meta-llama/llama-3.3-70b-instruct` ✓
  - Contrarian: `qwen/qwen-2.5-72b-instruct` ✓
- **Status**: **PASS**

---

### TC12: 球員名稱顯示（無 #id）
- **Command**: 觀察蛇形選秀板的球員名稱
- **Expected**: 顯示真實球員名稱，不顯示 #id
- **Actual**: 蛇形選秀板所有球員均顯示真實姓名（Nikola Jokić, Shai Gilgeous-Alexander 等），無 #id 問題
- **Status**: **PASS**

---

### TC13: 日曆顯示
- **Command**: 進入聯盟頁，觀察日曆
- **Expected**: 正確顯示週次、日期、已結束標記
- **Actual**: 日曆正常，第1週 10/22-10/28，已過日期標記「已結束」，今日日期框選
- **Status**: **PASS**

---

### TC14: 選秀 AI GM 策略說明文字語言
- **Command**: 選秀時觀察「輪到 BPA Nerd」面板說明文字
- **Expected**: 繁中說明
- **Actual**: 英文說明「Best player available by FPPG, every round.」漏翻
- **Status**: **FAIL**

---

### TC15: 模擬到季後賽 / 模擬季後賽
- **Command**: 呼叫 `POST /api/season/sim-to-playoffs`
- **Expected**: 成功執行所有例行賽週次並進入季後賽
- **Actual**: API 呼叫導致瀏覽器分頁 detach（`Detached while handling command`），頁面強制 reload，後端再次出現 season_reset 記錄。功能無法完整測試。
- **Status**: **FAIL（無法完成）**
- **Notes**: 可能是長時間 API 呼叫（模擬整季）超時導致前端頁面 reload

---

## Bug 清單（嚴重度排序）

### 🔴 Critical

**BUG-01: 推進一週 / 模擬操作觸發 season_reset**
- 症狀：按「推進一週」第二次，或執行 sim-to-playoffs，後端資料清空（picks=0, rosters=[])
- 復現步驟：1) 完成選秀 → 2) season/start → 3) 進聯盟頁 → 4) 按「推進一週」第一次（正常）→ 5) 再按一次（資料清空）
- 疑似原因：refreshState() 或 advance-week 觸發競態條件，或後端 advance-week 有副作用
- Console Errors: 無
- 影響：無法完成完整一季遊玩

**BUG-02: AI 隊伍陣容為空（season_start 後 roster = 0）**
- 症狀：season_start 後，7 支 AI 隊伍 roster 全部為空，無法排陣，所有比賽得分為 0
- 活動記錄：`No roster provided to make lineup decisions`、`Cannot field a lineup: roster is empty (0 players)`
- 影響：整個遊戲機制失效，無競爭性

### 🟠 High

**BUG-03: 模擬到我 / refreshState 不同步前端 UI**
- 症狀：點擊「模擬到我」後，後端已完成選秀（is_complete: true），但前端 UI 仍顯示「輪到你了 第1順」
- 需 F5 reload 才能更新
- Wave K 修補聲稱已修復，實際無效

**BUG-04: 活動記錄全部顯示英文代碼**
- 症狀：`day_advance`、`trade_proposed`、`season_start` 等代碼未翻譯
- AI 決策內容也是完整英文句子
- Wave K 修補聲稱已改繁中，實際無效

**BUG-05: AI 選秀未自動推進（1.5 秒功能未生效）**
- 症狀：人類選秀後，等待 8+ 秒，AI 不自動推進
- 需手動按「推進 AI」
- Wave K 修補聲稱已實作，實際無效

### 🟡 Medium

**BUG-06: 蛇形選秀板未即時更新**
- 症狀：選秀成功後，選秀板格子仍顯示「輪到了」，不顯示球員姓名
- 需 F5 才能正確顯示

**BUG-07: 「前往聯盟」按鈕文字間歇性消失**
- 症狀：選秀完成後過渡狀態下，按鈕顯示空白背景但無文字
- 可能是 CSS 顏色（白字白底）或 DOM 競態

**BUG-08: 選秀 AI GM 策略說明文字未翻譯**
- 症狀：「Best player available by FPPG, every round.」未翻譯為繁中
- 建議譯文：「每輪選擇 FPPG 最高的可用球員」

---

## Console Errors 摘要

測試期間未觀察到來自 `nbafantasy.cda1234567.com` 的 JavaScript console errors。
（僅有 2 條來自 `dash.cloudflare.com` 的第三方錯誤，與本應用無關）

---

## 「更好玩」建議清單

1. **選秀即時動畫**  
   AI 選秀時加入短暫的球員卡片「滑入」動畫效果，讓選秀過程更有節奏感。目前即使 AI 自動推進，畫面切換太過生硬，缺乏「蛇形選秀現場感」。

2. **週結算報告頁面**  
   推進一週後，彈出一個摘要面板顯示：本週各隊積分、最高得分球員、最佳陣容、交易結果。目前只有活動記錄的代碼，完全看不出本週精彩時刻。

3. **球員趨勢指標**  
   在球員列表加入「上升/下降趨勢」圖示（過去 3 週 FPPG 對比），讓玩家在自由球員市場有更豐富的決策依據。

4. **交易助理 AI**  
   發起交易時，加入「AI 評估」按鈕，讓系統分析這筆交易對雙方的公平性，並提供贏/輸分析。目前「說服文字」欄位是手動輸入，加入 AI 輔助建議會更有互動感。

5. **季後賽對決視覺化**  
   模擬季後賽後，加入賽程表格（類 NBA Bracket），顯示準決賽與決賽的對戰積分，讓冠軍誕生更有儀式感，而不只是活動記錄中的一行文字。

---

## Summary

| 類別 | 數量 |
|------|------|
| 測試案例總數 | 15 |
| PASS | 4 |
| FAIL | 11 |
| Critical Bugs | 2 |
| High Bugs | 3 |
| Medium Bugs | 3 |

**Pass**: TC10（交易開啟速度）、TC11（AI 模型白名單）、TC12（球員名稱顯示）、TC13（日曆顯示）  
**Fail**: TC1, TC2, TC3, TC4, TC5, TC6, TC7, TC8, TC9, TC14, TC15

---

## Cleanup

- Session killed: N/A（使用 MCP chrome 工具，無 tmux session）
- Artifacts removed: N/A
- 瀏覽器標籤頁保留供開發者查閱

---

## Final Summary（中文摘要）

Wave K v0.4.2 的 4 項主要修補中，**3 項完全未生效**：

1. **AI 1.5 秒自動推進** — 未實作或未觸發，AI 完全不自動推進
2. **活動記錄改繁中** — 全部仍顯示英文代碼與英文句子
3. **模擬到我 refreshState** — 前端 UI 在呼叫後無法同步，仍需手動 F5

第4項（`POST /api/season/reset` + `POST /api/draft/reset`）功能正常。

**最嚴重的新發現 Bug**：完成選秀並啟動賽季後，AI 隊伍 roster 全空（0 球員），導致 7 隊 AI 完全無法參賽，得分全為 0，整場遊戲實際上只有玩家1人在玩。加上「推進一週」第二次會觸發後端資料清空，目前版本無法完成完整一季 playthrough。

建議優先修復 BUG-01（season reset 觸發條件）和 BUG-02（AI 隊伍 roster 為空）後，再重新進行 Q2 完整一季測試。
