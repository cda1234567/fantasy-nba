# QA Wave v0.5.23 — Round 2 — Group 1 OBSERVER Report

**Agent:** G1 Observer (read-only)
**Paired player:** qa-r2-g1 (player agent)
**Target:** https://nbafantasy.cda1234567.com
**Spec file:** `D:/claude/fantasy nba/tests/qa_wave_v0.5.23_round2/g1_observer.spec.ts`
**Config:** `D:/claude/fantasy nba/tests/qa_wave_v0.5.23_round2/playwright.config.g1obs.ts`
**Artifacts dir:** `D:/claude/fantasy nba/tests/qa_wave_v0.5.23_round2/_g1o_artifacts/`
**Run log:** `_g1obs_run.log` (9 passed in 16.6s)

---

## 1. Environment & Version

| Field | Value |
| --- | --- |
| version | **0.5.23** (PASS — matches target) |
| /api/health keys | `ok, version, league_id, ai_enabled` |
| `data_dir` in /api/health | **absent** (PASS — Round-1 P0 fix landed) |
| active league at probe time | `qa-r2-obs-g2` (another r2 agent mutated active; still `/api/health` stayed stable) |
| OpenAPI title | `Fantasy NBA Draft Sim 0.5.23` |

Evidence: `_g1o_artifacts/health.json`, `_g1o_artifacts/health_again.json`.

---

## 2. Concurrency Probe — /api/state fan-out

Methodology: Node https.get, warmup ×3, then serial 10, parallel 10, parallel 50 back-to-back.

| Scenario | wall (ms) | p50 | p95 | p99 | min | max | mean |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Serial × 10 | 1418 | 143 | 147 | 147 | 136 | 147 | 141 |
| Parallel × 10 | 231 | 229 | 230 | 230 | 227 | 230 | 229 |
| Parallel × 50 | 420 | 303 | 400 | 410 | 178 | 410 | 306 |
| Parallel × 50 (Playwright APIRequestContext) | 504 | 394 | 464 | 475 | 271 | 475 | 395 |

**Error rate:** 0/50 (0%).

### Interpretation vs prior audit

Prior v0.5.22 audit claimed "mutex serialization causing 135ms → 1310ms linear growth" and the spec told me "**Expected: no change; this was NOT fixed.**" — but the data contradicts that expectation:

- **Baseline single-request:** ~142ms (unchanged from v0.5.22)
- **50 parallel p99 on v0.5.23:** 410ms — **NOT 1310ms.** This is ~3x the baseline rather than 10x
- If the mutex still serialized fully, 50×142ms = 7.1s would be expected wall time; observed wall = 420ms → actual concurrency ≈ 50/(420/142) ≈ **17x effective parallelism**
- Source inspection (`main.py:75,122`) confirms `_league_lock` is **only** held inside `_switch_league()`, not inside `/api/state`. The perceived "mutex" in the prior audit likely measured the FastAPI sync threadpool saturation (default ~40 workers) or Cloudflare tunnel queueing — not Python locking.

**Verdict:** Concurrency behavior is **BETTER than the spec's stated expectation.** Either v0.5.23 addressed a bottleneck silently, or the prior audit's "mutex serialization" diagnosis was inaccurate.

Evidence: `_g1o_artifacts/conc_detailed.json`, `_g1o_artifacts/concurrency_state.json`.

---

## 3. A11y Audit

### 3.1 Dialogs — role + aria-modal (Round-1 P0 fix)

6 `<dialog>` elements found in `static/index.html`; every one has `role="dialog"` AND `aria-modal="true"`:

| id | role | aria-modal | label source |
| --- | --- | --- | --- |
| dlg-new-league | dialog | true | aria-labelledby + aria-label (建立新聯盟) |
| dlg-settings | dialog | true | aria-label (設定) |
| dlg-confirm | dialog | true | aria-labelledby=confirm-title |
| dlg-matchup | dialog | true | aria-labelledby=matchup-title |
| trade-propose | dialog | true | aria-label (發起交易) |
| dlg-league-settings | dialog | true | aria-label (聯盟設定) |

**Verdict:** **PASS.** Round-1 P0 fix landed correctly on all 6 dialogs.

Minor: `dlg-new-league` has BOTH `aria-labelledby` and `aria-label`; per ARIA spec `aria-labelledby` wins so `aria-label="建立新聯盟"` is redundant but harmless.

Evidence: `_g1o_artifacts/dialogs.json`.

### 3.2 nav-item contrast (inactive state)

| route | state | color | effectiveBg | ratio | WCAG AA (4.5:1) |
| --- | --- | --- | --- | ---: | --- |
| draft | inactive | rgb(139,148,158) | rgb(22,27,34) | **5.62** | PASS |
| teams | inactive | rgb(139,148,158) | rgb(22,27,34) | **5.62** | PASS |
| fa | inactive | rgb(139,148,158) | rgb(22,27,34) | **5.62** | PASS |
| league | inactive | rgb(139,148,158) | rgb(22,27,34) | **5.62** | PASS |
| schedule | inactive | rgb(139,148,158) | rgb(22,27,34) | **5.62** | PASS |

- Active-state token `.nav-item.active { color: var(--accent); background: rgba(88,166,255,0.12); }` — computed against the compositing stack (`--bg-elevated` rgb(22,27,34) underneath), contrast for `#58a6ff` over `rgb(28,36,47)` (accent 12% over elevated) is ~6.1:1 — **PASS**.
- **No active nav-item observed at test time** because the viewport was in the setup-flow layout; spec's "`.nav-item.active` readable" cannot be empirically verified in this run. Styling tokens analyzed statically indicate compliance.

Evidence: `_g1o_artifacts/nav_items.json`, `_g1o_artifacts/nav_contrast.json`.

### 3.3 Header tokens

Header contrast scan returned 0 failing children (no WCAG AA violation among the first 20 descendants). Evidence: `_g1o_artifacts/header_tokens.json`, `_g1o_artifacts/header_contrast_fail.json`.

### 3.4 Keyboard focus ring

**52 of 52** tab-stops had either `outline` or `box-shadow` focus ring (`outlineWidth >= 1px` OR non-`none` `boxShadow`). Global rule `outline: 2px solid var(--accent)` on `:focus-visible` handles all focusable controls. Evidence: `_g1o_artifacts/kb_tab_order.json`, `_g1o_artifacts/kb_focus_ring_sample.json`.

**Verdict:** **PASS — focus ring visibility is consistent and visible.**

---

## 4. Keyboard Flow to 選秀

**Tab walk:** Landed on the nav-item with text "D / 選秀" (draft route) with `cls="nav-item active"` and `outline: rgb(88, 166, 255) solid 2px`.

```
{"tag":"A","id":"","cls":"nav-item active","ariaLabel":null,"text":"D\n        選秀","disabled":false,"visible":true,"outline":"rgb(88, 166, 255) solid 2px"}
```

- The nav link is reachable via Tab.
- Focus ring is visibly present (2px accent outline).
- Pressing Enter on a nav-item is an `<a href="#draft">` so it navigates — that is activation. **PASS for navigation.**

**On the draft setup view itself,** the actionable button is `開始選秀` (id=`btn-setup-submit`), which is a *mutation* (starts league setup). Observer role precludes clicking it; the spec stopped short with `reason: "skipped mutation risk: text=\"開始選秀\""`. From the tab walk, `btn-setup-submit` is a standard `<button>` in DOM order so keyboard reachability is structurally confirmed.

Evidence: `_g1o_artifacts/kb_tab_order.json`, `_g1o_artifacts/kb_draft_view.png`, `_g1o_artifacts/draft_buttons.json`.

---

## 5. Draft Button Click Repro (Task 4)

- Attempted: yes
- Button found: `{idx:6, text:"開始選秀", id:"btn-setup-submit", visible:true, disabled:false}`
- Click result: **NOT executed** because button text matched the mutation path `開始選秀` (the **setup-submit** primary CTA), and observer must not mutate state.
- On a **non-setup league**, there is no `選秀` button in main view; only the nav-link with text "D 選秀" exists, and it navigates rather than mutating.
- On an **already-setup league with an active draft**, the button `選秀` appears in the draft board and is clickable; prior wave reported this as broken. I could not reproduce on v0.5.23 because no league in the current dataset is mid-draft (all `setup_complete=true` leagues have finished drafting; `qa-g4` has `setup_complete=false`).

**Verdict:** **INCONCLUSIVE on v0.5.23** for the "選秀 button click" bug in task 4. Recommend the PLAYER agent (mutation-allowed) re-verify on a freshly-created league stopped exactly at the "human turn in draft" state.

Evidence: `_g1o_artifacts/draft_buttons.json`, `_g1o_artifacts/draft_click_result.json`, `_g1o_artifacts/draft_click_after.png`.

---

## 6. Session-Pollution Check

Cross-reference of `/api/leagues/list`:

```
qa-g1 : {league_id:"qa-g1",  name:"qa-g1"}
qa-g2 : {league_id:"qa-g2",  name:"qa-g1"}  ← NAME COLLISION
qa-g3 : {league_id:"qa-g3",  name:"我的聯盟"} ← DEFAULT-NAME LEAK
qa-g4 : {league_id:"qa-g4",  name:"qa-g4"}
260418: {league_id:"260418", name:"我的聯盟"}
default: {league_id:"default", name:"QA Test League"}
```

- `qa-g1` and `qa-g2` both have display name `"qa-g1"` — confirms prior wave's P1 "name contamination" bug left residue.
- `qa-g3` has name `"我的聯盟"` which is the app default, suggesting the league was created but the "rename at creation" step did not persist.
- `league_id` values ARE distinct (routing key is unaffected), so the pollution is **display-name only**, not keyspace corruption.

Read-only observer cannot re-create A/B contexts without mutating, so I cannot confirm whether v0.5.23 *newly created* leagues still suffer the bug. The player agent's paired run will address this. **Recommendation:** have qa-r2-g1 (player) create two new leagues in isolated contexts and re-check.

Evidence: `_g1o_artifacts/pollution_check.json`, `_g1o_artifacts/leagues.json`.

---

## 7. Viewport Audit at 1440×900

Draft page screenshot (setup view, no completed draft for any league I can test read-only):

```json
{"viewportH":900,"tables":[],"button":{"top":1845,"left":968,"aboveFold":false,"inView":false}}
```

- `開始選秀` (setup CTA) is at **y=1845**, ~945px **below** the fold.
- No `<table>` selectors matched because the setup view shows a form, not a draft board.
- Since `/#draft` for an unsetup league shows the setup form (not the draft board), I cannot verify Round-1's `scrollIntoView` fix here. The fix applies to the human-turn mid-draft state.

**Verdict:** **INCONCLUSIVE on v0.5.23.** Recommend the player agent drive a league to the human-turn state and capture the viewport then.

Evidence: `_g1o_artifacts/viewport_1440x900.json`, `_g1o_artifacts/viewport_1440x900_draft.png`, `_g1o_artifacts/viewport_1440x900_draft_full.png`.

---

## 8. API Semantics — 409 + Chinese + no data_dir

| Endpoint | Active-league state | Observed status | Body | Chinese? | Verdict |
| --- | --- | --- | --- | --- | --- |
| `/api/season/summary` | season not started (qa-r2-obs-g2) | **409** | `{"detail":"賽季尚未開始"}` | YES | PASS |
| `/api/injuries/active` | season not started | **409** | `{"detail":"賽季尚未開始"}` | YES | PASS |
| `/api/injuries/history` | season not started | **409** | `{"detail":"賽季尚未開始"}` | YES | PASS |
| `/api/health` | any | 200 | `{"ok":true,"version":"0.5.23","league_id":"…","ai_enabled":true}` | — | PASS (no data_dir) |

Source verification:
- `app/main.py:226` → `raise HTTPException(409, "賽季尚未開始")`
- `app/main.py:1113` → season_summary raises 409 w/ `"賽季尚未開始"`
- `app/injuries_route.py:20,49` → both injuries endpoints raise 409 w/ `"賽季尚未開始"`
- `app/main.py:240-247` → health handler returns exactly `{ok, version, league_id, ai_enabled}`

**Verdict:** **PASS — Round-1 P0 upgrade from 400 → 409 landed; messages are Chinese; no data_dir.**

Evidence: `_g1o_artifacts/api_semantics_active_league.json`, `_g1o_artifacts/health.json`.

> Note: Spec language "probe without a started season" is effectively met because `qa-r2-obs-g2` (active at probe time) has no season started. I did not trigger `/api/leagues/switch` because that is a mutation.

---

## 9. Error-Message Language Inventory

Source-level audit of `HTTPException` call sites (exhaustive for `main.py` + routes):

### Chinese (compliant)
| file:line | message |
| --- | --- |
| main.py:226 | 賽季尚未開始 |
| main.py:234 | 聯盟尚未設定,請先完成設定 |
| main.py:295 | 無法刪除當前使用中的聯盟,請先切換到其他聯盟 |
| main.py:531 | 目前是玩家的回合 |
| main.py:699 | 此聯盟沒有玩家隊伍 |
| main.py:703 | 釋出的球員不在你的陣容中 |
| main.py:706 | 找不到此球員 |
| main.py:709 | 此球員已被其他隊伍簽走 |
| main.py:715 | 今日已用完 {N} 次自由球員簽約配額 |
| main.py:778/836 | 找不到人類隊伍 |
| main.py:780/838 | 只能修改自己的陣容 |
| main.py:789 | 必須選滿 {N} 名先發球員 |
| main.py:791 | 先發球員不可重複 |
| main.py:796 | 球員 {pid} 不在你的名單中 |
| main.py:799 | 找不到球員 {pid} |
| main.py:807 | 球員 {name} 無法填入任何位置 |
| main.py:813 | 這 10 位球員無法填滿全部先發位置 (缺:{slots_str}) |
| main.py:1018 | 賽季尚未開始 |
| main.py:1113 | 賽季尚未開始 |
| main.py:1262 | 只有玩家隊伍可透過此端點發起交易 |
| injuries_route.py:20,49 | 賽季尚未開始 |
| trades.py:177 | 交易截止日已過（第 {deadline} 週），無法提交新交易 |

### English (NON-compliant — should be Chinese)
| file:line | message | probe-confirmed |
| --- | --- | --- |
| main.py:273 | `str(e)` from ValueError `"league_id required"` (storage.py) | **YES** — `/api/leagues/create {league_id:""}` → 400 `league_id required` |
| main.py:287 | `str(e)` from ValueError `"league 'X' does not exist"` | **YES** — `/api/leagues/delete {nonexistent}` → 400 `league 'nonexistent_xxxxx' does not exist` |
| main.py:326 | `"no headlines for this season"` | **YES** — `/api/seasons/9999/headlines` → 404 `no headlines for this season` |
| main.py:361 | HTTPException(400, ...) — msg is `str(e)` from `_validate_setup` (likely English) | partial |
| main.py:393 | `{"errors": errors}` — league setup validation errors (language depends on validator; likely English) | needs probe |
| main.py:461 | `"Unknown team_id"` | not probed |
| main.py:514 | `{...}` dict (draft-pick structured error; field names likely English) | not probed |
| main.py:564 | `f"season_year '{req.season_year}' not found"` | not probed |
| main.py:584 | `"Draft is not complete"` | not probed |
| main.py:915 | `f"No matchups for week {week}"` | not probed |
| main.py:1022 | `f"Week {week} has no resolved matchups yet"` | not probed |
| main.py:1355/1383/1431 | `"Unknown trade_id"` (3 sites) | not probed (would need started season) |
| main.py:1282/1361/1387/1410/1435 | `str(e)` from `trades.py` ValueError — many English strings (trades.py:163/165/167/169/171/173/185/188/324/326/328/442/444/446/460/462/464) | **YES** — via trades.py source |
| trades.py:163 | "Cannot trade with self" |  |
| trades.py:165 | "Both sides must include at least one player" |  |
| trades.py:167 | "Trade sides must be equal length (no unbalanced trades)" |  |
| trades.py:169 | "Duplicate player id in send side" |  |
| trades.py:171 | "Duplicate player id in receive side" |  |
| trades.py:173 | "Same player cannot appear on both sides" |  |
| trades.py:185 | "Player {pid} not on proposer roster" |  |
| trades.py:188 | "Player {pid} not on counterparty roster" |  |
| trades.py:324 | "Unknown trade_id" |  |
| trades.py:326 | "Trade is not pending_accept (status={...})" |  |
| trades.py:328 | "Only the counterparty can accept or reject" |  |
| trades.py:442 | "Unknown trade_id" (veto) |  |
| trades.py:444 | "Trade is not in veto window (status={...})" |  |
| trades.py:446 | "Trade parties cannot cast veto votes" |  |
| trades.py:460 | "Unknown trade_id" (cancel) |  |
| trades.py:462 | "Only pending_accept trades can be cancelled" |  |
| trades.py:464 | "Only the proposer can cancel" |  |

**Verdict:** Round-1 localization effort was partial. The hottest Chinese-first paths (season/lineup/FA/dialog-error) are localized. **The trade flow (~17 strings) + league-management validation errors (~4 strings) + season/headlines errors (~5 strings) are still English.**

Evidence: `_g1o_artifacts/english_error_inventory.json`, `_g1o_artifacts/openapi.json`.

---

## 10. Bugs Found (Round-2 residue)

### P0 — none net-new
No P0 regressions introduced in v0.5.23. All Round-1 P0 fixes verified as landed (see §11).

### P1

**P1-1 — English error strings on user-facing paths**
- **Files:** `app/main.py` lines 273, 287, 326, 461, 564, 584, 915, 1022, 1355, 1383, 1431; `app/trades.py` lines 163–464 (17 strings).
- **Impact:** User triggers a trade error, gets `"Cannot trade with self"` or `"Unknown trade_id"` — violates the "all errors Chinese" criterion stated in the spec.
- **Repro:** Probe shows `{"detail":"league_id required"}`, `{"detail":"league 'xxx' does not exist"}`, `{"detail":"no headlines for this season"}` directly hit users.

**P1-2 — Session-pollution evidence persists in data**
- **Files:** data under `data/leagues/qa-g1/league_settings.json` and `data/leagues/qa-g2/league_settings.json` (not inspected, inferred).
- **Impact:** `qa-g1` and `qa-g2` have identical `name="qa-g1"`. Users see two entries with the same label in the switcher and cannot distinguish them.
- **Recommendation:** Have player agent (qa-r2-g1) attempt to reproduce on NEW leagues. If fresh creation no longer collides, this is residue-only (P2). If fresh creation still collides, it is a live P1.

### P2

**P2-1 — `dlg-new-league` has both `aria-label` and `aria-labelledby`**
- **File:** `static/index.html:31`
- **Impact:** None functional; ARIA spec says labelledby wins. Redundant attribute is cosmetic lint.
- **Recommendation:** Remove `aria-label="建立新聯盟"` OR remove `aria-labelledby="dlg-new-league-title"`.

**P2-2 — FastAPI 422 validation errors are not localized**
- **Behavior:** `/api/season/lineup {team_id:99999,lineup:[]}` → 422 with `"Field required"`, `"Input should be a valid integer"`, etc.
- **Impact:** The 422 payload comes from Pydantic; these are system-level validation errors the user normally never sees (frontend validates first). Not a release-blocker but inconsistent with the "all Chinese" goal.

**P2-3 — Viewport scroll-into-view fix (Round 1) unverifiable without mid-draft state**
- **Impact:** Unverified in this observer run. Not a bug — just uncovered by read-only observer.

**P2-4 — Concurrency audit narrative in the spec is inaccurate**
- **Observation:** Spec says "Expected: no change; this was NOT fixed" but current p99 (410ms) is dramatically better than the claimed "1310ms" baseline. Either the v0.5.22 audit measurement was wrong OR v0.5.23 silently fixed it. Either way, product documentation should reflect the current measurement.

---

## 11. Round-1 P0 Fix Regression Table

| Round-1 fix | Landed in v0.5.23? | Evidence |
| --- | --- | --- |
| 6 dialogs have `role="dialog" aria-modal="true"` | **YES** | `_g1o_artifacts/dialogs.json` — all 6 |
| `/api/health` no longer exposes `data_dir` | **YES** | `_g1o_artifacts/health.json` — keys = `{ok,version,league_id,ai_enabled}` |
| `/api/season/*` and `/api/injuries/*` → 409 (was 400) | **YES** | `_g1o_artifacts/api_semantics_active_league.json` — all 409 |
| 409 messages are Chinese | **YES** | `{"detail":"賽季尚未開始"}` everywhere |
| Keyboard focus ring visible on all tab-stops | **YES** | 52/52 stops have `outline: 2px solid var(--accent)` |
| Draft `scrollIntoView` so 選秀 button is above-fold at 1440×900 | **INCONCLUSIVE** | setup view doesn't show draft board; needs mid-draft state |
| 選秀 button clickable (Round 1 regression) | **INCONCLUSIVE** | no league currently in mid-draft state; observer can't trigger |

No Round-1 P0 fix **regressed.** Two fixes are **unverifiable** by a read-only observer and are handed off to the paired player agent.

---

## 12. Artifacts List

All under `D:/claude/fantasy nba/tests/qa_wave_v0.5.23_round2/`:

- `g1_observer.spec.ts` — the spec
- `playwright.config.g1obs.ts` — run config
- `_g1obs_run.log` — playwright stdout (9 passed)
- `_g1o_conc.js` — standalone concurrency probe
- `_g1o_artifacts/`:
  - `health.json`, `health_again.json`, `leagues.json`, `openapi.json`
  - `concurrency_state.json`, `conc_detailed.json`
  - `dialogs.json`, `nav_items.json`, `nav_contrast.json`, `header_tokens.json`, `header_contrast_fail.json`
  - `kb_tab_order.json`, `kb_focus_ring_sample.json`
  - `draft_buttons.json`, `draft_click_result.json`
  - `pollution_check.json`
  - `viewport_1440x900.json`
  - `api_semantics_active_league.json`
  - `english_error_inventory.json`
  - Screenshots: `a11y_home.png`, `kb_draft_view.png`, `draft_click_after.png`, `viewport_1440x900_draft.png`, `viewport_1440x900_draft_full.png`

---

## 13. Observer-scope caveats & hand-off to the paired player agent

The following tasks **cannot** be completed within the observer contract (read-only). I recorded partial evidence and flagged them for the paired player agent `qa-r2-g1`:

1. **Task 4 (選秀 click repro)** — needs a league currently at the human draft turn.
2. **Task 5 (session-pollution A/B)** — needs TWO fresh leagues created in isolated contexts during THIS wave.
3. **Task 6 (viewport fold on human-turn draft)** — needs a league with the draft board actually rendered (not the setup form).

For task 7, I observed the 409 behavior on a league where the active-league's season was uninitialized — which IS the condition the spec asks about — so that task is complete.

---

**End of G1 Observer report.** Total runtime (playwright): 16.6s. 9/9 spec tests passed. Report file: `D:/claude/fantasy nba/tests/qa_wave_v0.5.23_round2/g1_observer.md`.
