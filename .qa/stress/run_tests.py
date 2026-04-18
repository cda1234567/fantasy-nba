# -*- coding: utf-8 -*-
"""Stress test: lineup override + FA claim flow"""
import sys, json, time
sys.stdout.reconfigure(encoding='utf-8')
import urllib.request
import urllib.error

BASE = 'http://localhost:3504'

FINDINGS = []

def get(path):
    with urllib.request.urlopen(BASE + path, timeout=15) as r:
        return json.loads(r.read())

def post(path, body=None, expect_error=False):
    data = json.dumps(body or {}).encode('utf-8')
    req = urllib.request.Request(
        BASE + path, data=data,
        headers={'Content-Type': 'application/json'}, method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            resp = json.loads(r.read())
            return resp, None
    except urllib.error.HTTPError as e:
        body_bytes = e.read()
        try:
            err_body = json.loads(body_bytes)
        except Exception:
            err_body = body_bytes.decode('utf-8', 'replace')
        return None, (e.code, err_body)

def delete(path, expect_error=False):
    req = urllib.request.Request(BASE + path, method='DELETE')
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read()), None
    except urllib.error.HTTPError as e:
        body_bytes = e.read()
        try:
            err_body = json.loads(body_bytes)
        except Exception:
            err_body = body_bytes.decode('utf-8', 'replace')
        return None, (e.code, err_body)

def log(msg):
    print(msg, flush=True)

def finding(cat, msg):
    FINDINGS.append(f'[{cat}] {msg}')
    print(f'  *** FINDING [{cat}]: {msg}', flush=True)

# ============================================================
# PHASE 1: Complete the draft
# ============================================================
log('\n=== PHASE 1: Complete autodraft ===')
for i in range(200):
    state = get('/api/state')
    if state['is_complete']:
        log(f'Draft complete at iteration {i}')
        break
    team_id = state['current_team_id']
    if team_id == 0:
        players = get('/api/players?available=true&limit=1&sort=fppg')
        if not players:
            log('No players available!')
            break
        pid = players[0]['id']
        post('/api/draft/pick', {'player_id': pid})
    else:
        post('/api/draft/ai-advance')
else:
    finding('DRAFT', 'Draft did not complete in 200 iterations')

state = get('/api/state')
human_roster = state['teams'][0]['roster']
log(f'Human roster ({len(human_roster)} players): {human_roster}')
HUMAN_ID = state['human_team_id']
ROSTER_SIZE = 13

if len(human_roster) != ROSTER_SIZE:
    finding('DRAFT', f'Human roster size {len(human_roster)} != expected {ROSTER_SIZE}')

# ============================================================
# PHASE 2: Start season
# ============================================================
log('\n=== PHASE 2: Start Season ===')
resp, err = post('/api/season/start', {'use_ai': False})
if err:
    finding('SEASON', f'season/start failed: {err}')
else:
    log(f'Season started: week={resp.get("current_week")} day={resp.get("current_day")}')

# ============================================================
# PHASE 3a: Set lineup override with 10 specific player IDs
# ============================================================
log('\n=== PHASE 3a: Lineup override, advance day, verify game_logs ===')
lineup_10 = human_roster[:10]
log(f'Setting lineup: {lineup_10}')
resp, err = post('/api/season/lineup', {
    'team_id': HUMAN_ID,
    'starters': lineup_10,
    'today_only': False
})
if err:
    finding('LINEUP', f'POST /api/season/lineup with valid 10 failed: {err}')
    log(f'Trying to find feasible lineup...')
    # Try the other approach - get team detail to see what slot assignment gives
    team_detail = get(f'/api/teams/{HUMAN_ID}')
    starters = [s['player_id'] for s in team_detail.get('slot_rows', []) if s.get('player_id')]
    log(f'  Auto starters from slot_rows: {starters}')
    if len(starters) == 10:
        resp, err2 = post('/api/season/lineup', {
            'team_id': HUMAN_ID,
            'starters': starters,
            'today_only': False
        })
        if err2:
            finding('LINEUP', f'Even auto-derived starters rejected: {err2}')
        else:
            lineup_10 = starters
            log(f'  Using auto starters: {lineup_10}')
else:
    log(f'  Lineup set ok: today_only={resp.get("today_only")}')

# Advance one day
resp, err = post('/api/season/advance-day', {})
if err:
    finding('ADVANCE', f'advance-day failed: {err}')
else:
    log(f'  Advanced to day={resp.get("current_day")} week={resp.get("current_week")}')

# Check game_logs for human starters
logs_resp = get('/api/season/logs?limit=200')
game_logs = logs_resp if isinstance(logs_resp, list) else logs_resp.get('logs', [])
log(f'  Total game_log entries: {len(game_logs)}')

# Find fp entries for human team
human_fp_entries = [g for g in game_logs if g.get('team_id') == HUMAN_ID and g.get('type') == 'game_log']
log(f'  Human FP entries: {len(human_fp_entries)}')
human_fp_pids = set(g.get('player_id') for g in human_fp_entries)
log(f'  Human FP player_ids: {human_fp_pids}')

# Check if override players got FP entries
lineup_set = set(lineup_10)
fp_intersection = lineup_set & human_fp_pids
if len(fp_intersection) < len(lineup_10) and len(human_fp_pids) > 0:
    finding('LINEUP', f'Only {len(fp_intersection)}/{len(lineup_10)} override players got FP entries (got: {fp_intersection})')
elif len(human_fp_pids) == 0:
    finding('LINEUP', 'No FP entries found for human team after advance-day with lineup override')
else:
    log(f'  OK: {len(fp_intersection)} override players have FP entries')

# ============================================================
# PHASE 3b: One-shot override (today_only=True)
# ============================================================
log('\n=== PHASE 3b: One-shot override (today_only=True) ===')

# Check current alerts before
alerts_before = get('/api/season/lineup-alerts')
log(f'  Alerts before one-shot: {alerts_before}')

# Check season state for lineup_override_today_only
resp, err = post('/api/season/lineup', {
    'team_id': HUMAN_ID,
    'starters': lineup_10,
    'today_only': True
})
if err:
    finding('ONE_SHOT', f'today_only=True lineup failed: {err}')
else:
    log(f'  One-shot override set: {resp}')

# Advance day - should consume the one-shot
resp, err = post('/api/season/advance-day', {})
if err:
    finding('ADVANCE', f'advance-day (one-shot test) failed: {err}')
else:
    log(f'  Advanced to day={resp.get("current_day")}')

# Check that alert appeared (today_only consumed alert if invalid, or cleared if valid)
alerts_after = get('/api/season/lineup-alerts')
log(f'  Alerts after one-shot advance: {alerts_after}')

# The one-shot override should have been used (removed from lineup_overrides)
# We check by verifying the override is gone by trying to see if alert was generated or override consumed
# According to code: if today_only=True and lineup is valid, it gets USED (not an alert) and REMOVED.
# Alert only appears if the override becomes INVALID (players no longer on roster).
# So after a valid one-shot: no alert expected, override should be cleared.
alert_count_after = len(alerts_after.get('alerts', []))
log(f'  Alert count after one-shot day: {alert_count_after}')
# Note: alert only fires if lineup becomes infeasible, not on normal consumption

# ============================================================
# PHASE 3c: POST lineup with only 9 players — expect 400/422
# ============================================================
log('\n=== PHASE 3c: 9-player lineup (expect 400) ===')
resp, err = post('/api/season/lineup', {
    'team_id': HUMAN_ID,
    'starters': lineup_10[:9],
    'today_only': False
})
if err:
    code, body = err
    if code in (400, 422):
        log(f'  OK: 9-player lineup rejected with {code}: {body}')
    else:
        finding('VALIDATION', f'9-player lineup returned unexpected {code}: {body}')
else:
    finding('VALIDATION', '9-player lineup was ACCEPTED (should be rejected with 400/422)')

# ============================================================
# PHASE 3d: POST with player not on roster — expect 400
# ============================================================
log('\n=== PHASE 3d: Player not on roster (expect 400) ===')
# Find a player not on human roster
state = get('/api/state')
all_players = get('/api/players?available=false&limit=200&sort=fppg')
not_on_human = [p['id'] for p in all_players if p['id'] not in set(human_roster)]
if not_on_human:
    bad_lineup = lineup_10[:9] + [not_on_human[0]]
    resp, err = post('/api/season/lineup', {
        'team_id': HUMAN_ID,
        'starters': bad_lineup,
        'today_only': False
    })
    if err:
        code, body = err
        if code == 400:
            log(f'  OK: non-roster player rejected with 400')
        else:
            finding('VALIDATION', f'Non-roster player returned {code}: {body}')
    else:
        finding('VALIDATION', f'Non-roster player {not_on_human[0]} accepted in lineup!')
else:
    log('  SKIP: could not find player not on human roster')

# ============================================================
# PHASE 3e: Duplicate player IDs — expect 400
# ============================================================
log('\n=== PHASE 3e: Duplicate player IDs (expect 400) ===')
dup_lineup = lineup_10[:9] + [lineup_10[0]]  # duplicate first player
resp, err = post('/api/season/lineup', {
    'team_id': HUMAN_ID,
    'starters': dup_lineup,
    'today_only': False
})
if err:
    code, body = err
    if code == 400:
        log(f'  OK: duplicate players rejected with 400')
    else:
        finding('VALIDATION', f'Duplicate players returned {code}: {body}')
else:
    finding('VALIDATION', f'Duplicate player lineup ACCEPTED (should be 400)')

# ============================================================
# PHASE 3f: DELETE lineup override, verify auto-lineup resumes
# ============================================================
log('\n=== PHASE 3f: DELETE lineup override ===')
# First set an override
post('/api/season/lineup', {'team_id': HUMAN_ID, 'starters': lineup_10, 'today_only': False})
resp, err = delete(f'/api/season/lineup/{HUMAN_ID}')
if err:
    finding('LINEUP_CLEAR', f'DELETE lineup override failed: {err}')
else:
    log(f'  Override cleared: {resp}')

# Advance day - should use auto lineup
resp, err = post('/api/season/advance-day', {})
if err:
    finding('ADVANCE', f'advance-day after clear failed: {err}')
else:
    day = resp.get("current_day")
    log(f'  Advanced to day={day} with auto lineup')

    # Verify human team still got FP entries (auto lineup working)
    logs_resp2 = get('/api/season/logs?limit=500')
    game_logs2 = logs_resp2 if isinstance(logs_resp2, list) else logs_resp2.get('logs', [])
    day_entries = [g for g in game_logs2 if g.get('team_id') == HUMAN_ID
                   and g.get('type') == 'game_log' and g.get('day') == day]
    log(f'  FP entries for day {day}: {len(day_entries)}')
    if len(day_entries) == 0:
        finding('AUTO_LINEUP', f'No FP entries for human after clearing lineup override (day {day})')

# ============================================================
# PHASE 4a: Free-agent claim stress
# ============================================================
log('\n=== PHASE 4a: Get free agents ===')
# Refresh human roster
state = get('/api/state')
human_roster = state['teams'][0]['roster']
log(f'Current human roster ({len(human_roster)}): {human_roster}')

# Get available free agents
avail_players = get('/api/players?available=true&limit=20&sort=fppg')
log(f'Top free agents available: {[p["id"] for p in avail_players[:5]]}')

if len(avail_players) < 5:
    finding('FA', f'Only {len(avail_players)} free agents available')

# ============================================================
# PHASE 4b: Rapid-fire claim+drop (10 iterations)
# ============================================================
log('\n=== PHASE 4b: Rapid-fire claim+drop (10 iterations) ===')
fa_status = get('/api/fa/claim-status')
log(f'FA claim status: {fa_status}')

# We'll pick FA[0] and drop human_roster[12] (last player), then reverse
def get_all_roster_sizes():
    state = get('/api/state')
    return {t['id']: len(t['roster']) for t in state['teams']}

# Get a stable FA player and a stable drop target
fa_players = get('/api/players?available=true&limit=10&sort=fppg')
if len(fa_players) >= 2 and len(human_roster) >= 1:
    fa_x = fa_players[0]['id']
    fa_y = fa_players[1]['id']
    drop_y_init = human_roster[-1]   # player Y on roster (will be dropped in iter 1)

    # Advance day to reset daily claim limit
    post('/api/season/advance-day', {})

    errors_found = []
    for iter_i in range(10):
        # Get current state
        state = get('/api/state')
        curr_roster = state['teams'][0]['roster']

        if fa_x in curr_roster:
            # fa_x is on roster, drop it and add fa_y
            avail = get('/api/players?available=true&limit=50&sort=fppg')
            avail_ids = [p['id'] for p in avail]
            if fa_y not in avail_ids:
                # fa_y is on a roster somewhere - find another FA
                log(f'  iter {iter_i}: fa_y not available, advancing day...')
                post('/api/season/advance-day', {})
                continue
            resp, err = post('/api/fa/claim', {'drop_player_id': fa_x, 'add_player_id': fa_y})
            if err:
                errors_found.append(f'iter {iter_i} drop_fa_x+add_fa_y: {err}')
                log(f'  iter {iter_i}: claim error: {err}')
                post('/api/season/advance-day', {})
            else:
                log(f'  iter {iter_i}: dropped fa_x={fa_x}, added fa_y={fa_y}')
        else:
            # fa_y might be on roster (or initial state), add fa_x
            avail = get('/api/players?available=true&limit=50&sort=fppg')
            avail_ids = [p['id'] for p in avail]
            if fa_x not in avail_ids:
                log(f'  iter {iter_i}: fa_x not available, advancing day...')
                post('/api/season/advance-day', {})
                continue
            # drop fa_y if on roster, else drop last roster player
            state2 = get('/api/state')
            curr_roster2 = state2['teams'][0]['roster']
            drop_target = fa_y if fa_y in curr_roster2 else curr_roster2[-1]
            resp, err = post('/api/fa/claim', {'drop_player_id': drop_target, 'add_player_id': fa_x})
            if err:
                errors_found.append(f'iter {iter_i} add_fa_x: {err}')
                log(f'  iter {iter_i}: claim error: {err}')
                post('/api/season/advance-day', {})
            else:
                log(f'  iter {iter_i}: dropped {drop_target}, added fa_x={fa_x}')

        # Verify roster sizes after each claim
        sizes = get_all_roster_sizes()
        for tid, sz in sizes.items():
            if sz != ROSTER_SIZE:
                finding('ROSTER_INTEGRITY', f'iter {iter_i}: team {tid} has {sz} players (expected {ROSTER_SIZE})')
                errors_found.append(f'Roster size violation team {tid}: {sz}')

        # Advance day to reset claim limit
        post('/api/season/advance-day', {})

    if errors_found:
        finding('FA_RAPID', f'Rapid-fire claim errors: {errors_found}')
    else:
        log('  Rapid-fire claims: all roster sizes maintained correctly')
else:
    finding('FA', 'Not enough FA players or roster for rapid-fire test')

# ============================================================
# PHASE 4c: Claim player already on another team — expect 400
# ============================================================
log('\n=== PHASE 4c: Claim player on another team (expect 400) ===')
state = get('/api/state')
# Find a player on another team's roster
other_team_roster = state['teams'][1]['roster']
if other_team_roster:
    owned_pid = other_team_roster[0]
    human_roster_now = state['teams'][0]['roster']
    resp, err = post('/api/fa/claim', {
        'drop_player_id': human_roster_now[-1],
        'add_player_id': owned_pid
    })
    if err:
        code, body = err
        if code == 400:
            log(f'  OK: owned player rejected with 400')
        else:
            finding('FA_VALIDATION', f'Claiming owned player returned {code}: {body}')
    else:
        finding('FA_VALIDATION', f'Claimed player {owned_pid} who is already on team 1!')
else:
    log('  SKIP: no players on team 1')

# ============================================================
# PHASE 4d: Drop player not on human roster — expect 400
# ============================================================
log('\n=== PHASE 4d: Drop player not on roster (expect 400) ===')
state = get('/api/state')
human_roster_now = state['teams'][0]['roster']
other_roster = state['teams'][1]['roster']
avail_fa = get('/api/players?available=true&limit=1&sort=fppg')
if avail_fa and other_roster:
    bad_drop = other_roster[0]
    resp, err = post('/api/fa/claim', {
        'drop_player_id': bad_drop,
        'add_player_id': avail_fa[0]['id']
    })
    if err:
        code, body = err
        if code == 400:
            log(f'  OK: dropping non-roster player rejected with 400')
        else:
            finding('FA_VALIDATION', f'Drop non-roster player returned {code}: {body}')
    else:
        finding('FA_VALIDATION', f'Drop of non-roster player {bad_drop} was ACCEPTED!')

# ============================================================
# PHASE 5: Simulate a few weeks, verify roster size
# ============================================================
log('\n=== PHASE 5: Advance 3 weeks, verify roster sizes ===')
for week_i in range(3):
    resp, err = post('/api/season/advance-week', {})
    if err:
        finding('ADVANCE_WEEK', f'advance-week {week_i+1} failed: {err}')
        break
    log(f'  Week {week_i+1} advanced: day={resp.get("current_day")} week={resp.get("current_week")}')

sizes = get_all_roster_sizes()
log(f'Roster sizes after 3 weeks: {sizes}')
for tid, sz in sizes.items():
    if sz != ROSTER_SIZE:
        finding('ROSTER_INTEGRITY', f'After 3 weeks: team {tid} has {sz} players (expected {ROSTER_SIZE})')

if not any('team' in f for f in FINDINGS if 'ROSTER' in f):
    log('  All teams at correct roster size after 3 weeks')

# ============================================================
# Summary
# ============================================================
log('\n=== FINDINGS SUMMARY ===')
if not FINDINGS:
    log('No issues found.')
else:
    for f in FINDINGS:
        log(f)

# Write findings
findings_out = {
    'total_findings': len(FINDINGS),
    'findings': FINDINGS,
    'roster_sizes_final': get_all_roster_sizes(),
}
with open('D:/claude/fantasy nba/.qa/stress/findings-5.json', 'w', encoding='utf-8') as f:
    json.dump(findings_out, f, indent=2, ensure_ascii=False)
log('\nFindings written to findings-5.json')
