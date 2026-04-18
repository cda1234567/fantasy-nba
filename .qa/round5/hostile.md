# Round 5 — Hostile API probing

Host: https://nbafantasy.cda1234567.com

## Results

| test | status | response preview |
|------|--------|------------------|
| draft-pick non-int pid | 422 | `{"detail":[{"type":"int_parsing","loc":["body","player_id"],"msg":"Input should be a valid integer, unable to parse stri` |
| draft-pick huge pid | 400 | `{"detail":{"detail":"human_slot_already_consumed","next_picker":1,"is_complete":false}}` |
| draft-pick negative pid | 400 | `{"detail":{"detail":"human_slot_already_consumed","next_picker":1,"is_complete":false}}` |
| draft-pick with array | 422 | `{"detail":[{"type":"int_type","loc":["body","player_id"],"msg":"Input should be a valid integer","input":[1,2,3]}]}` |
| draft-pick empty body | 422 | `{"detail":[{"type":"missing","loc":["body","player_id"],"msg":"Field required","input":{}}]}` |
| draft-pick no body | 422 | `{"detail":[{"type":"missing","loc":["body"],"msg":"Field required","input":null}]}` |
| league create SQLi attempt | 400 | `{"detail":"league_id may only contain letters, digits, '-', '_'"}` |
| league create XSS attempt | 400 | `{"detail":"league_id may only contain letters, digits, '-', '_'"}` |
| league create path traversal | 400 | `{"detail":"league_id may only contain letters, digits, '-', '_'"}` |
| league create null bytes | 400 | `{"detail":"league_id may only contain letters, digits, '-', '_'"}` |
| league create long id | 400 | `{"detail":"league_id too long (max 64 chars)"}` |
| seasons get /etc/passwd | 404 | `{"detail":"Not Found"}` |
| setup huge roster | 400 | `{"detail":{"errors":["roster_size must be one of [10, 13, 15]"]}}` |
| setup negative values | 400 | `{"detail":{"errors":["roster_size must be one of [10, 13, 15]","starters_per_day must be one of [8, 10, 12]"]}}` |
| wrong content-type | 422 | `{"detail":[{"type":"model_attributes_type","loc":["body"],"msg":"Input should be a valid dictionary or object to extract` |
| switch to non-existent league | 400 | `{"detail":"league 'nonexistent-xyz-1776505619' does not exist"}` |
| advance-day no season | 409 | `{"detail":"賽季尚未開始"}` |

## Summary

Server 5xx count: 0
Verdict: PASS - all malformed inputs handled without 5xx
