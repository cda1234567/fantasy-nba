# QA Wave K - Q5 Regression Test Report

**版本**: v0.4.2  
**測試日期**: 2026-04-17  
**目標網站**: https://nbafantasy.cda1234567.com  
**測試人員**: QA Agent (Claude Sonnet 4.6)

---

## 版本確認

```
GET /api/health
{"ok":true,"version":"0.4.2","league_id":"default","data_dir":"/app/data","ai_enabled":true}
```

版本確認：**v0.4.2** ✓

---

## TC1：選秀顯示模式即時切換

### 狀態：FAIL

### 測試步驟
1. 進入 `#draft` 頁面
2. 搜尋 `<select id="draft-display-mode-switch">` 元素

### 證據

**瀏覽器 JS 查詢結果：**
```javascript
document.getElementById('draft-display-mode-switch')
// 結果: NOT FOUND (null)
```

**全頁面 HTML 搜尋：**
```javascript
document.body.innerHTML.indexOf('draft-display-mode-switch')
// 結果: -1 (不存在)
document.body.innerHTML.indexOf('prev_no_fppg')
// 結果: -1 (不存在)
document.body.innerHTML.indexOf('current_full')
// 結果: -1 (不存在)
```

**app.js 搜尋（Docker v0.3.0 + live v0.4.2 WebFetch）：**
```
draft-display-mode-switch: NOT FOUND (0 次出現)
```

**截圖分析（ss_2102puj9s）：**  
「剩餘球員」面板標題顯示「（顯示上季 FPPG）」模式備注，但面板上方**完全沒有 `<select>` 切換元件**。

**API 確認 `draft_display_mode` 欄位存在：**
```
GET /api/league/settings
{"draft_display_mode":"prev_full", ...}
```
後端欄位存在，但前端 draft 頁面的即時切換 `<select>` 元件未實作。

### 根本原因
`draft_display_mode` 只能在 League Settings 對話框（`#ls-draft-mode` select）中修改，**沒有在 draft 頁面的「剩餘球員」面板提供即時切換控件**。

---

## TC2：「推進 AI」「模擬到我」UI 自動 refresh

### 狀態：PASS

### 測試步驟
1. 重置選秀（`POST /api/draft/reset`）
2. 重載頁面
3. 點擊 Nikola Jokić「選秀」按鈕（人類回合）
4. 點擊「推進 AI」按鈕
5. 點擊「模擬到我」按鈕

### 證據

**人類選秀後（立即更新，無 reload）：**

| 指標 | 選秀前 | 選秀後 |
|------|--------|--------|
| 輪到誰了 | 輪到你了 | 輪到 BPA Nerd |
| 選秀板填滿格 | 1 | 2 |
| 剩餘球員表頭 | Nikola Jokić | Luka Dončić |
| 推進 AI 按鈕 | disabled | **enabled** |
| 模擬到我按鈕 | disabled | **enabled** |

**「推進 AI」點擊後（截圖 ss_3681ovu3e）：**

```
網路請求: POST /api/draft/ai-advance → 200 OK
（只有這一個請求，無 reload）

之前: 填滿 2 格, 輪到 BPA Nerd
之後: 填滿 3 格, 輪到 Punt TO (第1輪第3順)
BPA Nerd 格: "Victor Wembanyama #2"（已更新）
剩餘球員: Wembanyama 已移除
```

**「模擬到我」點擊後（截圖 ss_1792nc8fs）：**

```
網路請求: POST /api/draft/sim-to-me → 200 OK
（只有這一個請求，無 reload）

之前: 填滿 3 格, Punt TO 回合
之後: 填滿 16 格, 輪到你了（第2輪第8順，#16）
蛇形選秀板第1輪完整顯示: Jokić, Wembanyama, SGA, Giannis, Dončić...
停在人類回合 ✓（沒有繼續自動選）
剩餘球員更新為 Kawhi Leonard 開頭
```

**結論**：兩個按鈕都能在不 reload 頁面的情況下立即更新選秀板與剩餘球員表。

---

## TC3：選秀 AI 自動推進（每 1.5s 推一個）

### 狀態：FAIL

### 測試步驟
1. 重置選秀
2. 硬重載頁面（Ctrl+Shift+R）
3. 等待 12 秒，不按任何按鈕
4. 每 2 秒輪詢 `/api/state`

### 證據

**輪詢結果（重載後不互動）：**

```
t=2s:  picks=0, complete=False, team=0, round=1
t=4s:  picks=0, complete=False, team=0, round=1
t=6s:  picks=0, complete=False, team=0, round=1
t=8s:  picks=0, complete=False, team=0, round=1
t=10s: picks=0, complete=False, team=0, round=1
t=12s: picks=0, complete=False, team=0, round=1
```

**網路請求監控（12 秒內）：**
```
/api/draft/* 請求數: 0
```

**程式碼分析（app.js WebFetch）：**
- 無任何 `setTimeout` 或 `setInterval` 觸發自動選秀
- 無 `autoPlay`、`autoDraft`、`draftLoop` 等自動推進邏輯
- 所有選秀動作需使用者明確點擊按鈕

**結論**：v0.4.2 沒有「每 1.5s 自動推進 AI」機制。AI 選秀**完全依賴人工觸發**（點「推進 AI」或「模擬到我」）。

---

## TC4：gemini-flash-1.5 404 已消除

### 狀態：PASS

### 測試步驟
1. 確認選秀完成（104/104）
2. `POST /api/season/start`
3. `GET /api/season/ai-models`
4. 驗證無隊伍使用 `google/gemini-flash-1.5`

### 證據

**`GET /api/season/ai-models` 完整回應：**

```json
{
  "1": {"name": "BPA Nerd",         "model": "google/gemini-2.0-flash-001"},
  "2": {"name": "Punt TO",           "model": "meta-llama/llama-3.3-70b-instruct"},
  "3": {"name": "Stars & Scrubs",    "model": "mistralai/mistral-small-3.1-24b-instruct"},
  "4": {"name": "Balanced Builder",  "model": "mistralai/mistral-small-3.1-24b-instruct"},
  "5": {"name": "Youth Upside",      "model": "anthropic/claude-haiku-4.5"},
  "6": {"name": "Vet Win-Now",       "model": "meta-llama/llama-3.3-70b-instruct"},
  "7": {"name": "Contrarian",        "model": "qwen/qwen-2.5-72b-instruct"}
}
```

**白名單驗證：**

| 隊伍 | 模型 | 白名單 |
|------|------|--------|
| BPA Nerd | google/gemini-2.0-flash-001 | ✓ |
| Punt TO | meta-llama/llama-3.3-70b-instruct | ✓ |
| Stars & Scrubs | mistralai/mistral-small-3.1-24b-instruct | ✓ |
| Balanced Builder | mistralai/mistral-small-3.1-24b-instruct | ✓ |
| Youth Upside | anthropic/claude-haiku-4.5 | ✓ |
| Vet Win-Now | meta-llama/llama-3.3-70b-instruct | ✓ |
| Contrarian | qwen/qwen-2.5-72b-instruct | ✓ |

**`google/gemini-flash-1.5`** 出現次數：**0**

所有隊伍均使用白名單內的模型。

---

## 總結

| # | 測試項目 | 結果 | 說明 |
|---|---------|------|------|
| TC1 | 選秀顯示模式即時切換 | **FAIL** | `<select id="draft-display-mode-switch">` 元件不存在於 draft 頁面 |
| TC2 | 推進AI / 模擬到我 UI 自動 refresh | **PASS** | 點擊後立即更新選秀板與剩餘球員表，無需 reload |
| TC3 | 選秀 AI 自動推進 | **FAIL** | 無 1.5s 自動推進機制，12 秒內 0 個 AI 選秀 |
| TC4 | gemini-flash-1.5 404 已消除 | **PASS** | 7 支 AI 隊伍均使用白名單模型，無 gemini-flash-1.5 |

- **總計**: 4 項
- **通過**: 2 項（TC2, TC4）
- **失敗**: 2 項（TC1, TC3）

---

## 問題摘要

### TC1 失敗根本原因
Draft 頁面的「剩餘球員」面板缺少即時模式切換 `<select>` 元件。`draft_display_mode` 僅能透過聯盟設定對話框（齒輪圖示 → 選秀顯示模式）修改，不支援在選秀過程中即時切換。

### TC3 失敗根本原因
v0.4.2 的 `app.js` 沒有實作任何計時器（`setTimeout` / `setInterval`）來觸發 AI 自動選秀。「AI 每 1.5 秒自動推一個」功能**未實作**。選秀進展完全依賴使用者手動點擊「推進 AI」或「模擬到我」。

---

## 附錄：使用截圖清單

| 截圖 ID | 說明 |
|---------|------|
| ss_2102puj9s | TC1 + TC2 前置：乾淨 draft 頁面，顯示無 display-mode-switch |
| ss_3681ovu3e | TC2「推進 AI」後：BPA Nerd 選了 Wembanyama，Punt TO 輪次 |
| ss_1792nc8fs | TC2「模擬到我」後：停在人類第2輪第8順，16格已填 |
| ss_29075kkn3 | 初始 draft 狀態確認（輪到你了，第1輪第1順） |
| ss_6684yxtb3 | TC3 前置：重置後乾淨 draft 狀態 |
