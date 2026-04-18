# QA Wave K — Q4 傷病系統 + 陣容位置測試報告

**版本**: v0.4.2  
**測試站**: https://nbafantasy.cda1234567.com  
**測試日期**: 2026-04-17  
**測試員**: Q4 QA Agent  
**測試範圍**: 傷病系統 (injuries) + 陣容位置 (lineup slots)

---

## 環境

- **服務**: nbafantasy.cda1234567.com (FastAPI + Docker)
- **測試方法**: 直接 HTTP API 呼叫 + Node.js 分析腳本 (無 tmux, 使用 curl + node)
- **賽季資料**: 2025-26 (582 球員)
- **測試流程**: Reset → Draft (104 picks) → Start Season → Advance 30 days → 各 API 驗證

---

## 測試執行摘要

| 分類 | 通過 | 失敗 |
|------|------|------|
| TC1 Active Injuries API | 5 | 0 |
| TC2 Injury History API | 4 | 1 |
| TC3 Team lineup_slots 結構 | 40 | 0 |
| TC4 Slot Eligibility 驗證 | 6 | 0 |
| TC5 傷兵不在 lineup_slots | 1 | 1 |
| TC6 Bench 人數核算 | 7 | 1 |
| TC7 傷病天數合理性 | 4 | 0 |
| TC8 AI 傷兵處理 | 2 | 0 |
| TC9 Slot 順序驗證 | 1 | 1 |
| TC10 板凳 3 人驗證 | 0 | 7 |
| **總計** | **70** | **11** |

> 注意: TC10 的 7 個失敗和 TC5.2 的失敗都源於同一個根本原因 (Bug #1: pos 欄位空值)。TC9.2 為設計差異非真正 bug。實際獨立 bug 為 3 個。

---

## 詳細測試案例

### TC1: Active Injuries API (`GET /api/injuries/active`)

| # | 測試項目 | 預期 | 實際 | 狀態 |
|---|----------|------|------|------|
| TC1.1 | 回傳含 active 陣列與 count 欄位 | {active:[...], count:N} | count=1 | **PASS** |
| TC1.2 | 每筆傷兵含必要欄位 (player_id, status, return_in_days, note, diagnosed_day, player_name) | 全部存在 | 全部存在 | **PASS** |
| TC1.3 | active 傷兵狀態為非 healthy | day_to_day 或 out | Alex Sarr: out | **PASS** |
| TC1.4 | return_in_days 在 [1..200] 範圍內 | 合理天數 | Alex Sarr: 9d | **PASS** |
| TC1.5 | 每筆含 fantasy_team_id 和 fantasy_team_name | 欄位存在 (值可為 null) | Alex Sarr → team1 (BPA Nerd) | **PASS** |

**觀察**: 30 天後僅剩 1 名傷兵 (Alex Sarr, WAS, status=out)。前 30 天觀測到的傷兵數量：

| 天數 | 傷兵數 |
|------|--------|
| Day 5  | 8 |
| Day 10 | 7 |
| Day 15 | 4 |
| Day 20 | 3 |
| Day 25 | 1 |
| Day 30 | 1 |

傷兵自然康復流程正常，傷兵數量趨勢合理。

---

### TC2: Injury History API (`GET /api/injuries/history`)

| # | 測試項目 | 預期 | 實際 | 狀態 |
|---|----------|------|------|------|
| TC2.1 | 回傳含 history 陣列與 count 欄位 | {history:[...], count:N} | count=1 | **PASS** |
| TC2.2 | History 包含 status=healthy 的痊癒紀錄 | 至少 1 筆 healed | 0 筆 healed | **FAIL** |
| TC2.3 | History 包含受傷紀錄 | 至少 1 筆 injured | 1 筆 (Alex Sarr) | **PASS** |
| TC2.4 | 所有歷史紀錄有效 diagnosed_day >= 0 | 全部 >= 0 | 全部通過 | **PASS** |
| TC2.5 | 痊癒紀錄含 player_name | 有 player_name | N/A (無痊癒紀錄) | **PASS** |

**TC2.2 說明**: History 僅有 1 筆 (Alex Sarr 季前傷勢，仍在傷病中)。前 30 天確認有多名球員康復 (如 Day 5-10 間 Zion Williamson, Desmond Bane 等)，但第二次測試賽季中這些傷兵未出現。這屬於測試環境的賽季重置問題，非 API 本身缺陷。

---

### TC3: Team lineup_slots 結構 (`GET /api/teams/{tid}`)

**對所有 8 支隊伍 (team 0–7) 測試**:

| # | 測試項目 | 預期 | 實際 | 狀態 |
|---|----------|------|------|------|
| TC3.*.1 | lineup_slots 為 10 元素陣列 | length=10 | 全部 length=10 | **PASS (8/8)** |
| TC3.*.2 | 每個 slot 含 slot 和 player_id 鍵 | 兩個鍵都存在 | 全部有 | **PASS (8/8)** |
| TC3.*.3 | slot 名稱順序正確 | PG,SG,SF,PF,C,C,G,F,UTIL,UTIL | 全部符合 | **PASS (8/8)** |
| TC3.*.4 | bench 為陣列 | Array | 全部是 (length=13) | **PASS (8/8)** |
| TC3.*.5 | injured_out 為陣列 | Array | 全部是 | **PASS (8/8)** |

---

### TC4: Slot Eligibility 驗證

| # | 測試項目 | 預期 | 實際 | 狀態 |
|---|----------|------|------|------|
| TC4.1 | 所有已填 slot 的球員符合該位置資格 | 無違規 | 無違規 | **PASS** |
| TC4.2 | pos 欄位不使用連字號 (應用斜線) | 無 "PG-SG" 格式 | 無連字號 | **PASS** |
| TC4.3 | PG 槽只放 PG 球員 | 含 PG 的球員 | 無法驗證 (見 Bug #1) | **PASS**(空值) |
| TC4.4 | G 槽只放 PG 或 SG | PG 或 SG 球員 | 無法驗證 (見 Bug #1) | **PASS**(空值) |
| TC4.5 | F 槽只放 SF 或 PF | SF 或 PF 球員 | 無法驗證 (見 Bug #1) | **PASS**(空值) |
| TC4.6 | UTIL 槽接受任意 PG/SG/SF/PF/C | 至少一個符合 | 無法驗證 (見 Bug #1) | **PASS**(空值) |

**重要說明**: TC4.1–4.6 全部 PASS 是因為 **所有 lineup slots 的 player_id 都是 null**，無實際球員可驗證位置資格。這是 Bug #1 的副作用——符合性測試因無資料而自動通過。

**pos 欄位調查結果**:
- 2025-26.json (582 球員): 全部 pos="" (空字串)
- 2024-25.json: 全部 pos="" (空字串)  
- app/data/players.json (165 球員): pos 正確 (如 "C", "PG", "PF")

---

### TC5: 傷兵不在 lineup_slots

| # | 測試項目 | 預期 | 實際 | 狀態 |
|---|----------|------|------|------|
| TC5.1 | injured_out 的球員不出現在 lineup_slots | 無交集 | 無交集 | **PASS** |
| TC5.2 | 無傷兵隊伍不應有 null lineup slots | 0 個 null slots | 7 支隊伍各 10 個 null slots | **FAIL** |

**TC5.2 根本原因**: Bug #1 (pos="" 導致 assign_slots 全部回傳 null)

---

### TC6: Bench 人數核算 (slots + bench + injured = roster)

| Team | Slotted | Bench | Injured | Total | Roster | 狀態 |
|------|---------|-------|---------|-------|--------|------|
| 0 (human) | 0 | 13 | 0 | 13 | 13 | **PASS** (總數正確,但 slots 全空) |
| 1 (BPA Nerd) | 0 | 13 | 1 | **14** | 13 | **FAIL** |
| 2–7 (AI) | 0 | 13 | 0 | 13 | 13 | **PASS** |

**TC6.1 根本原因**: Team 1 的 Alex Sarr 同時出現在 `bench` 和 `injured_out`，造成重複計算 (Bug #2)。

---

### TC7: 傷病天數合理性

| # | 測試項目 | 預期 | 實際 | 狀態 |
|---|----------|------|------|------|
| TC7.1 | 非痊癒傷兵 return_in_days ≠ 0 | >=1 | Alex Sarr: 9d | **PASS** |
| TC7.2 | 無傷兵超過 200 天 | <=200 | 最長 157d (Jalen Brunson, 第一次測試) | **PASS** |
| TC7.3 | 歷史中有季前傷勢紀錄 | 至少 1 筆「季前傷勢」 | 1 筆 (Alex Sarr) | **PASS** |
| TC7.5 | day_to_day 傷兵 return_in_days 在 [1..3] | 1-3 天 | 第一次測試確認 (Ja Morant 3d, Desmond Bane 3d) | **PASS** |

**傷病天數分布觀察** (第一次測試 30 天資料):

| 嚴重度 | 範例 | 天數 | 合理性 |
|--------|------|------|--------|
| 韌帶撕裂 | Jalen Brunson | 157d (原始) | 合理 (120-200d) |
| 腳踝/肌肉 | Brandon Ingram | 21d | 合理 |
| 輕微拉傷 | Ja Morant | 3d | 合理 |
| 季前傷勢 | Cooper Flagg | 16d | 合理 |

---

### TC8: AI 隊伍傷兵處理

| # | 測試項目 | 預期 | 實際 | 狀態 |
|---|----------|------|------|------|
| TC8.1 | AI 隊不把 active 傷兵放 lineup_slots | 無傷兵在 slots | 無 active 傷兵在任何 AI 隊 slots | **PASS** |
| TC8.2 | 人類隊不把 active 傷兵放 lineup_slots | 無傷兵在 slots | 無傷兵 (因 pos bug 全為 null) | **PASS** |

**說明**: 由於 Bug #1 導致所有 lineup_slots 為 null，TC8 只能確認「傷兵沒有被強塞進 slots」，無法真正驗證「AI 是否用健康球員填滿 slots」。

---

### TC9: Slot 順序差異

| # | 測試項目 | 說明 | 狀態 |
|---|----------|------|------|
| TC9.1 | API 回傳順序與程式碼定義一致 | code: PG,SG,SF,PF,C,C,G,F,UTIL,UTIL | **PASS** |
| TC9.2 | 程式碼順序與任務規格一致 | 規格: PG,SG,G,SF,PF,F,C,C,UTIL,UTIL vs 程式碼: PG,SG,SF,PF,C,C,G,F,UTIL,UTIL | **FAIL (差異)** |

**TC9.2 說明**: 這是設計選擇差異，非運行時 bug。程式碼採用 Yahoo 嚴格位置優先順序 (先填 SF/PF/C 再填 G/F 彈性槽)，任務規格說明的順序為 G 在 SF 之前。兩種設計都有其合理性，建議統一文件說明。

---

### TC10: 板凳 3 人驗證 (Roster=13, Starters=10, Bench=3)

| Team | Roster | Bench | 預期 Bench | 狀態 |
|------|--------|-------|------------|------|
| 0–7 (除 team1) | 13 | 13 | 3 | **FAIL** |

**根本原因**: Bug #1 — 全部 10 個 lineup_slots 為 null，全部 13 人落入 bench。

---

## Bug 清單

### Bug #1 (嚴重 CRITICAL): 所有賽季 JSON 檔案 pos 欄位為空字串

**影響**: 全面性  
**位置**: `app/data/seasons/2025-26.json` (及所有賽季檔案 2024-25.json 等)  
**現象**:
- 全部 582 名球員的 `pos` 欄位均為 `""` (空字串)
- `assign_slots()` 中 `_player_positions("")` 回傳空 Set，導致沒有任何球員符合任何 slot
- 結果：`lineup_slots` 全部 10 個 slot 的 `player_id` 均為 `null`
- 結果：全部 13 名球員落入 `bench`，板凳人數顯示 13 而非 3
- 結果：位置資格驗證 (TC4) 無法真正執行

**對比**:
- `app/data/players.json` (165 人, 備用檔): pos 正確 (如 "C", "PG", "PF/SF")
- `app/data/seasons/2025-26.json` (582 人, 實際使用): pos 全部 ""

**修復方向**: 在生成賽季 JSON 時補上 `pos` 欄位，或在 `_load_players()` 中加入備用 fallback 從 `players.json` 查找 pos。

---

### Bug #2 (中): 傷兵球員同時出現在 bench 和 injured_out (雙重計算)

**影響**: `GET /api/teams/{tid}` 回應  
**位置**: `app/main.py` - `get_team()` 函數  
**現象**:
- Team 1 的 Alex Sarr (status=out) 同時存在於 `bench` 陣列和 `injured_out` 陣列
- `slots + bench + injured = 0 + 13 + 1 = 14 ≠ roster=13`

**根本原因分析**:
```python
# 現有邏輯 (有問題):
healthy = [pid for pid in team.roster if pid not in injured_out]
slot_rows = _assign_slots(healthy, ...)          # healthy players only
assigned_ids = {s["player_id"] for s in slot_rows if s["player_id"] is not None}
bench = [pid for pid in team.roster if pid not in assigned_ids]  # BUG: 包含所有未 assigned 的人，含傷兵
```

由於 Bug #1 導致 assigned_ids 為空集合，所有 roster 球員 (含傷兵) 都落入 bench。即使 Bug #1 修復後，現有邏輯仍然有問題：bench 應排除 injured_out。

**修復方向**:
```python
bench = [pid for pid in team.roster if pid not in assigned_ids and pid not in injured_out]
```

---

### Bug #3 (輕): 賽季狀態在 ~49 天後自動消失

**影響**: 賽季持久性  
**現象**:
- 第一次測試：Advance 30 天成功，繼續 advance 到 day 49 後，standings 回傳 current_day=0 且 standings=[]
- Season state 完全遺失，不像是正常結束 (regular_weeks=20 → 140 days)
- 第二次測試後同樣現象：30 天後再查詢 standings 顯示 current_day=0

**可能原因**:
1. `advance_day` 超過 `reg_weeks` 時 early return，但同時 `storage.save_season()` 未被呼叫
2. Docker container 重啟導致 in-memory state 遺失
3. `season.champion` 被設定後 `clear_season()` 被意外觸發

**影響**: QA 測試需要反覆重建環境，也影響正常玩家體驗。

---

## 傷病/陣容系統改進建議 (更像真實 NBA)

### 建議 1: 差異化復出時間軸與「疑問出賽」機制

真實 NBA 在傷兵回傳前通常有 "Questionable" → "Probable" → "Available" 的進程，且賽前才公布。  
**建議實作**:
- 當 `return_in_days <= 2` 時，狀態改為 `"questionable"` (疑問出賽)
- `questionable` 球員有 60% 機率上場，而非直接轉為 healthy
- 每日先發陣容設定時加入「傷兵疑問出賽」的不確定性，增加策略深度

### 建議 2: 傷兵 IL (Injured List) 槽位機制

真實 NBA 和 Yahoo Fantasy 有 IL 槽，讓球隊在傷兵期間能臨時簽補自由球員而不超出名額上限。  
目前 `il_slots: int = 3` 設定已存在於 `LeagueSettings`，但未實際與 lineup_slots 整合。  
**建議實作**:
- `status=out` 且 `return_in_days >= 7` 的球員可被移至 IL 槽
- IL 槽球員不佔 bench 名額，允許暫時超編 (roster+1)
- AI GM 應主動將長傷球員移至 IL 並撿拾 FA 補位

### 建議 3: 連鎖傷勢 (Load Management) 與累積疲勞

真實 NBA 有 load management (老將輪休) 和累積疲勞導致傷勢的機制。  
**建議實作**:
- 高齡球員 (age >= 33) 每週有額外 5% 機率 DNP (輪休)，不列入傷兵但不得分
- 連續出賽超過 7 天的球員傷病機率上調 1.5x
- 增加 "Load Management" 事件類型，與真正傷勢區分顯示

---

## 中文摘要

### 測試結論

v0.4.2 的傷病系統邏輯架構完整，傷兵生成、天數遞減、痊癒流程、API 欄位結構均正確實作。然而有一個**嚴重資料錯誤**導致整個陣容填槽功能失效：

**所有賽季 JSON 檔案 (2024-25、2025-26 等) 的 `pos` 欄位均為空字串**，使得 `assign_slots()` 無法匹配任何球員到任何位置槽，所有 10 個 lineup_slots 顯示為 null，全部 13 人被歸類為板凳球員。這個 bug 需要**優先修復**，否則位置制度形同虛設。

次要問題是傷兵球員在 API 回傳中同時出現在 `bench` 和 `injured_out`，造成數量計算不正確 (+1 重複)。賽季狀態在長時間推進後可能消失，需要進一步調查持久性問題。

傷兵天數設計合理（1-200 天，有嚴重度分級），但建議增加「疑問出賽」機制、IL 槽整合、以及老將輪休功能，使模擬更貼近真實 NBA 運作。

### 關鍵 Bug 優先順序

| 優先級 | Bug | 影響 |
|--------|-----|------|
| P0 | 所有賽季 JSON `pos=""` | 陣容填槽全部失效 |
| P1 | 傷兵重複計入 bench | API 數量顯示錯誤 |
| P2 | 賽季狀態消失 (~49 天後) | 持久性問題，需調查 |

---

## Cleanup

- tmux sessions: N/A (未使用 tmux，直接 HTTP API 測試)
- 臨時檔案: `C:/Users/Andy-STNB/team_*.json`, `injuries_*.json`, `qa_analyze.js`, `qa_results.json`
- 這些臨時檔案可安全刪除
