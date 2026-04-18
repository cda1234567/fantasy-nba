# QA Wave v0.5.22 — Interim Audit (5/8 agents back)

5 份報告、共 ~559 條建議；3 個尚未回歸（G1O / G3P / G4P）。

## 🔥 三隻以上 agent 共同確認的 P0（必修）

### Data / Backend
1. **qa-g2.name == "qa-g1"**（G2O / G3O / G4O 命中 3 次）
   聯盟建立時 `name` 被沿用上一個 active 聯盟。`app/main.py` `/api/leagues/create` handler。
2. **`POST /api/leagues/switch` 回 200 但 UI desync**（G2O / G4O）
   `#lsw-current` 繼續顯示舊聯盟；後續 API 打到錯聯盟。
3. **`/api/state` 全域鎖，10 並發 135ms→1310ms 線性**（G3O）
   每個 state read 卡同一把 mutex；單用戶還好，多 tab/多用戶崩盤。
4. **setup 後 race**：`/api/league/setup` 200 → `/api/draft/ai-advance` 409「聯盟尚未設定」（G1P 實測）
   module-level `draft` 未 reload `_settings.setup_complete`。

### Accessibility（三 observer 一致）
5. **6 個 `<dialog>` 全缺 `aria-modal` / `role="dialog"`**
   `dlg-new-league / dlg-settings / dlg-confirm / dlg-matchup / trade-propose / dlg-league-settings`
6. **11+ form controls 無 label / aria-label**
   setup 的所有 input、trade-message textarea、FA search、排序/位置/顯示模式 select
7. **`.nav-item.active` 藍字畫藍底 contrast = 1.0**（完全看不到）
   `static/style.css:770-783`
8. **Header 文字不過 WCAG AA**
   `.lsw-current` 1.54、`.conn-text` 1.49、`.app-version` 3.46
9. **Focus ring 黑色畫深灰 → 看不到**
   checkbox / number input / radio group

### Draft UX（Player 兩隻 × 30+ 條共識）— 使用者最痛點
10. **Available 表在 1440×900 被 headlines + hero 擠到 fold 下**
    `app.js:843-846` + `style.css:411-426`
11. **沒鍵盤流程**：13 手都要 mouse click（`Enter` 選第一順位？`J/K` 移動？沒有）
12. **沒 tier/rank/ADP 欄**：FPPG 41.0 到底 elite 還是 mid 玩家無法判斷
13. **AI auto-advance 1500ms 寫死**：7 AI × 1.5s = 10.5s 純看動畫、無暫停/加速
14. **每選一手 root.innerHTML = '' + re-append**：捲軸 & 搜尋框 focus 全掉
15. **手機 `.hidden-m` class 把 FPPG/REB/AST/STL/BLK/TO 全藏**
    `style.css:1649` — 手機按 FPPG 排序卻看不到數字
16. **Board table 小螢幕 horizontal overflow**，sticky header 失效
17. **AI 回合按鈕 disabled 但無「輪到 AI」倒數或 spinner**

### API semantics
18. **Season-gated endpoints 回 400 應該 409**
    `/api/season/summary` / `/api/injuries/active` / `/api/injuries/history`
19. **中英錯誤訊息混用**：`"賽季尚未開始"` vs `"league 'x' does not exist"`
20. **全無 ETag / Cache-Control**：每 tick 都重下 1.4 KB state + 25.8 KB players
21. **`/api/health` 洩露 `data_dir` 絕對路徑**

---

## 📊 報告總覽

| Agent | 建議數 | 獨家亮點 |
|-------|--------|---------|
| G1 Player | 100+ | setup→draft state race、draft headlines 擠壓 |
| G2 Player | 100+ | DP-01~50 專章 50 條只談選秀 |
| G2 Observer | 125 | `.nav-item.active` contrast 1.0、5 inputs 無 label |
| G3 Observer | 105 | `/api/state` 全域鎖 135→1310ms、11 inputs 無 label |
| G4 Observer | 109 | switch API UI desync、season 400 應 409 |
| G1 Observer | ⏳ | - |
| G3 Player | ⚠️ | 提早回 (`足夠。等 playwright。`) |
| G4 Player | ⚠️ | 提早回，未寫 md |

---

## 🎯 建議修復順序（若你要動手）

**Wave 1（backend 1 小時）**
- qa-g2.name 污染 → fix `_create_league` 路徑
- `/api/leagues/switch` → 回傳 reload signal，前端 subscribe 更新 lsw-current
- setup race → `_switch_league` 完成後 reload `_current_settings` cache

**Wave 2（a11y 1-2 小時）**
- 6 dialog 加 `role="dialog" aria-modal="true"`
- 所有 form 加 `<label>` 或 `aria-label`
- `.nav-item.active` 改色、header token 調對比度
- global `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`

**Wave 3（draft UX 重構，半天）**
- `renderDraftView` 改 DOM diff，不整塊炸掉
- 加鍵盤：`/` focus search、`Enter` 選第一順位、`J/K` 移游標
- 加 tier 欄、FPPG rank 欄
- Settings 加 AI 速度滑桿（0/500/1500/3000ms）+ 暫停 toggle
- `.hidden-m` 拿掉至少讓 FPPG 看得到

**Wave 4（API polish）**
- season-gated 400 → 409
- 所有 detail 統一中文
- `/api/state` 加 ETag
- `/api/health` 移除 `data_dir`
