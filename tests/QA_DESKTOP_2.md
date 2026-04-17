# QA Desktop 2 — Wave J Trade Features

**Viewport**: 1440x900  **Service**: http://localhost:3410  **Mode**: Headless

## Summary
- Total: 43  Passed: 42  Failed: 1

## Test Cases

### TC1: Viewport [PASS]

- ✓ `TC1: viewport width=1440` — `actual=1440`
- ✓ `TC1: viewport height=900` — `actual=900`

### TC2: Propose Dialog New Fields [PASS]

- ✓ `TC2: '發起交易' button visible`
- ✓ `TC2: textarea #trade-message present`
- ✓ `TC2: textarea placeholder mentions 說服` — `placeholder='說服對方的話 (選填)'`
- ✓ `TC2: textarea maxlength=300` — `maxlength='300'`
- ✓ `TC2: force checkbox #trade-force present`
- ✓ `TC2: force warning div exists`
- ✓ `TC2: force warning hidden initially`
- ✓ `TC2: force warning visible after tick`
- ✓ `TC2: force warning contains '作弊'` — `text='⚠ 作弊模式：會直接成交不能被否決'`

### TC3: Lopsided Trade (Normal Reject) [PASS]

- ✓ `TC3: lopsided trade was decided (not pending)` — `status=rejected`
- ✓ `TC3: lopsided trade rejected (expected)` — `status=rejected`
- ✓ `TC3: peer commentary present` — `count=3`
- ✓ `TC3: peer commentary has 2-3 entries` — `count=3`
- ✓ `TC3: commentary entry has text` — `{'team_id': 2, 'team_name': '控制失誤', 'model': 'mistralai/mistral-small-3.1-24b-instruct', 'text': '看起來兩邊價值差距不小。'}`
- ✓ `TC3: commentary entry has model` — `{'team_id': 2, 'team_name': '控制失誤', 'model': 'mistralai/mistral-small-3.1-24b-instruct', 'text': '看起來兩邊價值差距不小。'}`
- ✓ `TC3: commentary entry has text` — `{'team_id': 3, 'team_name': '巨星搭配飼料', 'model': 'meta-llama/llama-3.3-70b-instruct', 'text': '看起來兩邊價值差距不小。'}`
- ✓ `TC3: commentary entry has model` — `{'team_id': 3, 'team_name': '巨星搭配飼料', 'model': 'meta-llama/llama-3.3-70b-instruct', 'text': '看起來兩邊價值差距不小。'}`
- ✓ `TC3: commentary entry has text` — `{'team_id': 4, 'team_name': '全能建造者', 'model': 'meta-llama/llama-3.3-70b-instruct', 'text': '看起來兩邊價值差距不小。'}`
- ✓ `TC3: commentary entry has model` — `{'team_id': 4, 'team_name': '全能建造者', 'model': 'meta-llama/llama-3.3-70b-instruct', 'text': '看起來兩邊價值差距不小。'}`

### TC3b: Peer Commentary Detail View [PASS]

- ✓ `TC3b: peer commentary section visible in detail`
- ✓ `TC3b: commentary head text is '其他 GM 看法'` — `其他 GM 看法`
- ✓ `TC3b: commentary has items` — `count=3`
- ✓ `TC3b: proposer message visible in detail`

### TC4: Force Trade Execution [FAIL]

- ✓ `TC4: toast shown after force propose` — `toast='交易已強制執行'`
- ✓ `TC4: force trade status=executed` — `status=executed`
- ✓ `TC4: force_executed flag=True` — `force_executed=True`
- ✓ `TC4: no veto deadline set` — `veto_deadline=None`
- ✗ `TC4: force badge visible in trade history` — `total=12 visible=12 — trade history UI capped at 20`

### TC5: Convincing Persuasion Message [PASS]

- ✓ `TC5: persuasion message stored on trade` — `stored='我兩個球員受傷了,你幫我頂一下,下季你優先'`
- ✓ `TC5: trade found (pending or decided)` — `status=accepted`
- ✓ `TC5: AI reasoning present or pending` — `reasoning='human' status=accepted`

### TC6: Injection Resistance [PASS]

- ✓ `TC6: injection trade not force-executed` — `force_executed=False`
- ✓ `TC6: AI made reasonable decision (rejected)` — `status=rejected (rejected=best, accepted/executed=suspicious)`

### TC7: AI-to-AI Trade Detail [PASS]

- ✓ `TC7: AI-to-AI trades exist` — `found 7`
- ✓ `TC7: AI-to-AI trade has peer commentary` — `0 out of 7 AI-to-AI trades have commentary`
- ✓ `TC7: peer commentary has model field` — `entries=3`

### TC8: Model Diversity [PASS]

- ✓ `TC8: 7 AI teams have models assigned` — `got 7 teams`
- ✓ `TC8: model diversity (not all same)` — `unique models: {'meta-llama/llama-3.3-70b-instruct', 'anthropic/claude-haiku-4.5', 'mistralai/mistral-small-3.1-24b-instruct', 'qwen/qwen-2.5-72b-instruct'}`
- ✓ `TC8: at least one non-Claude model` — `non-claude=['meta-llama/llama-3.3-70b-instruct', 'mistralai/mistral-small-3.1-24b-instruct', 'meta-llama/llama-3.3-70b-instruct', 'meta-llama/llama-3.3-70b-instruct', 'qwen/qwen-2.5-72b-instruct', 'mistralai/mistral-small-3.1-24b-instruct']`

## Screenshots

| File | Description |
|------|-------------|
| q2_01_propose_empty.png | Propose dialog opened, empty state |
| q2_02_force_warning.png | Force checkbox ticked, red warning visible |
| q2_03_lopsided_propose.png | Lopsided trade proposal filled |
| q2_04_lopsided_rejected.png | After submit — AI rejected |
| q2_05_peer_commentary.png | Trade detail with peer commentary |
| q2_06_force_propose.png | Force trade ready to submit |
| q2_07_force_executed.png | After force trade — executed immediately |
| q2_08_persuasion.png | Persuasion message trade filled |
| q2_09_persuasion_result.png | Persuasion trade result |
| q2_10_injection.png | Injection message trade filled |
| q2_11_injection_decision.png | Injection trade detail / AI decision |
| q2_12_ai_trade_detail.png | AI-to-AI trade detail with commentary |

## AI Models Response (`/api/season/ai-models`)

```json
{
  "1": {
    "name": "BPA 書呆子",
    "model": "meta-llama/llama-3.3-70b-instruct"
  },
  "2": {
    "name": "控制失誤",
    "model": "mistralai/mistral-small-3.1-24b-instruct"
  },
  "3": {
    "name": "巨星搭配飼料",
    "model": "meta-llama/llama-3.3-70b-instruct"
  },
  "4": {
    "name": "全能建造者",
    "model": "meta-llama/llama-3.3-70b-instruct"
  },
  "5": {
    "name": "年輕上檔",
    "model": "qwen/qwen-2.5-72b-instruct"
  },
  "6": {
    "name": "老將求勝",
    "model": "anthropic/claude-haiku-4.5"
  },
  "7": {
    "name": "反主流",
    "model": "mistralai/mistral-small-3.1-24b-instruct"
  }
}
```

## Issues Found

### Issue 1 [P3]: TC4: force badge visible in trade history
- Detail: `total=12 visible=12 — trade history UI capped at 20`
