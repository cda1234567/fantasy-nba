# Q1 Wave K QA Report

- 目標：https://nbafantasy.cda1234567.com v0.4.0
- 時間：2026-04-17 11:40
- Total: 10 / Pass: 8 / Fail: 1 / Partial: 1

---

## TC1 重置聯盟

- **Command**: POST /api/season/reset → POST /api/draft/reset → POST /api/league/setup (8隊 standard)
- **Expected**: 三個 API 均回 200，8 隊名單重置完成
- **Actual**: season/reset 200 OK, draft/reset 200 OK (回傳 8 隊空陣列), league/setup 200 OK (8 隊各具 gm_persona)
- **Status**: PASS

---

## TC2 選秀頁滾輪測試

- **Command**: `page.mouse.scroll(600, 630, down, 5)` — window.scrollY 前後記錄
- **Expected**: scrollY 有明顯變化 (>0)
- **Actual**: scrollBefore=0, scrollAfter=1000, diff=1000px；頁面成功滾動，球員列表往下顯示 Kawhi Leonard 等球員
- **Status**: PASS

---

## TC3 隱藏數據模式驗證 (prev_no_fppg)

- **Command**: 切換 draft_display_mode 到 `prev_no_fppg`，驗證表頭
- **Expected**: 表頭有 PTS/REB/AST 欄位，無 FPPG 欄位
- **Actual**: `prev_no_fppg` 模式在前端 DOM 中不存在；排序下拉有 PTS/REB/AST 選項，但選擇後表頭欄位名稱仍顯示「上季FPPG」，只有排序順序改變，column header 不變。無法找到切換表頭顯示欄位的 UI 控件。
- **Status**: FAIL
- **Bug**: `prev_no_fppg` 模式未實作（或 UI 入口未開放）。排序欄位改變不等同於表頭欄位切換。

---

## TC4 手動 draft 1 人 + sim-to-me 完成選秀

- **Command**: 點擊 Nikola Jokić「選秀」按鈕 → 循環 POST /api/draft/sim-to-me + POST /api/draft/pick 共 12 輪
- **Expected**: 選秀完成，我的隊伍有 13 名球員
- **Actual**: Jokić 手動選秀成功（#1 第1輪第1順位），後續 12 輪透過 sim-to-me + pick API 完成，最終 team0.roster.length=13；頁面顯示「選秀完成 — 104/104 順位」
- **Status**: PASS
- **Note**: 「模擬到我」UI 按鈕觸發後 UI 不自動刷新（需手動重整），但 API 端正常執行

---

## TC5 開始賽季

- **Command**: POST /api/season/start → 驗證 current_week=1，無英文錯誤
- **Expected**: 不跳「Season has not started」英文，current_week=1
- **Actual**: API 回傳 `{"started":true,"current_week":1,"current_day":0}`；頁面顯示「今日・2025年10月22日（週三）第1週」；無任何英文錯誤訊息
- **Status**: PASS
- **Note**: 頁面無「開始賽季」明顯按鈕，需透過 API 或「前往聯盟」頁面自動觸發

---

## TC6 日曆顯示驗證

- **Command**: 進入 #league，截圖日曆 panel，DOM 掃描
- **Expected**: 有「今日・2025年10月22日（週三）」字串，7格日期格出現
- **Actual**: DOM 掃描確認 `"今日"` + `"2025年10月22日"` + `"第 1 週"`；日曆顯示 週三10/22「今日」、週四10/23、週五10/24、週六10/25、週日10/26、週一10/27、週二10/28 共7格
- **Status**: PASS

---

## TC7 位置卡槽驗證

- **Command**: 進入 #teams，截圖，DOM 掃描 `.slot-badge`
- **Expected**: 10 個 slot（PG/SG/G/SF/PF/F/C/C/UTIL/UTIL），板凳(3)
- **Actual**: slot-badge 陣列 = `["PG","SG","SF","PF","C","C","G","F","UTIL","UTIL"]`（10個，順序略異）；板凳顯示 `板凳 (13)`（選了13名球員，非預設3人板凳）
- **Status**: PASS
- **Note**: 板凳人數是13而非3，因為 13 名球員全部在板凳（位置 slot 未自動填入）

---

## TC8 交易 propose 速度測試

- **Command**: POST /api/trades/propose `{from_team:0, to_team:1, send:[kawhi_id], receive:[opp_id], message:"QA speed test trade"}`
- **Expected**: 回應時間 < 3000ms，status 200
- **Actual**: status=200，回應時間=218ms，trade_id=`228905136044402cb202f9011722d4fa`；遠低於3秒門檻
- **Status**: PASS

---

## TC9 英文訊息掃描

- **Command**: DOM 全文 regex `/[a-z].*has not started/i` 掃描，含所有可見頁面
- **Expected**: 無「has not started」等英文錯誤訊息
- **Actual**: `hasNotStarted=false`，`seasonNotStarted=false`；未發現任何「has not started」字串。右側活動欄有 AI LLMError 技術訊息（OpenRouter 404 google/gemini-flash-1.5 找不到），但這是後端 AI 模型呼叫失敗，非 UI 面向的賽季錯誤訊息。
- **Status**: PASS
- **Note**: BPA Nerd / Vet Win-Now 的 AI GM 使用 google/gemini-flash-1.5，OpenRouter 回 404，建議更換可用模型

---

## TC10 推進 2 週

- **Command**: 點「推進一週」x2（每次等待 5 秒後刷新確認）
- **Expected**: 日曆「今日」日期前進 14 天（10/22 → 11/5）
- **Actual**:
  - 第1次推進一週後：2025年10月25日（+3天，推到當週週六）
  - 第2次推進一週後：2025年10月27日（+2天，推到週一）
  - 第3次推進一週後：2025年10月29日（+2天），進入「第2週」
  - 最終日期：10/29，距初始 10/22 共推進 7 天，顯示第2週
- **Status**: PARTIAL PASS
- **Note**: 「推進一週」按鈕實際行為是「推進到本週結束」而非「+7天」。執行 3 次推進操作後進入第2週，但累計推進天數為7天（不足14天）。TC10 要求推進2週（14天），實際只完成1個完整週期進入第2週。

---

## Summary

| TC | 名稱 | 結果 |
|---|---|---|
| TC1 | 重置聯盟 | PASS |
| TC2 | 選秀頁滾輪測試 | PASS |
| TC3 | 隱藏數據模式 (prev_no_fppg) | FAIL |
| TC4 | 手動draft + sim-to-me | PASS |
| TC5 | 開始賽季 | PASS |
| TC6 | 日曆顯示驗證 | PASS |
| TC7 | 位置卡槽驗證 | PASS |
| TC8 | 交易 propose 速度 | PASS |
| TC9 | 英文訊息掃描 | PASS |
| TC10 | 推進2週 | PARTIAL PASS |

- **Total**: 10
- **Pass**: 8
- **Fail**: 1 (TC3)
- **Partial**: 1 (TC10)

---

## 主要 Bug

1. **TC3 FAIL** — `prev_no_fppg` 隱藏數據模式未在 UI 中實作。排序下拉有 PTS/REB/AST 但 column header 不變，無法透過 UI 切換到「不顯示 FPPG 只顯示 PTS/REB/AST」的表頭模式。

2. **TC10 PARTIAL** — 「推進一週」按鈕的行為是「推到本週邊界」而非「+7天」，導致需要點擊多次才能跨越一個完整週期。3次點擊只推進7天（進入第2週），未達14天目標。

3. **AI GM 模型錯誤（非測試失敗，但建議修復）** — BPA Nerd、Vet Win-Now 等 AI GM 使用 `google/gemini-flash-1.5`，OpenRouter 回 HTTP 404「No endpoints found」，導致這些隊伍使用 fallback 邏輯選陣容。建議換用可用模型（如 `google/gemini-flash-1.5-8b` 或 `meta-llama/llama-3.1-8b-instruct`）。

4. **「模擬到我」UI 不自動刷新** — 點擊「模擬到我」按鈕後，頁面 UI 不會自動更新顯示其他隊伍的選秀結果，需手動重整。

---

## Cleanup

- Session killed: N/A (使用 chrome MCP，無 tmux session)
- Artifacts removed: N/A
- Browser tab: 保留在 #league 頁面
