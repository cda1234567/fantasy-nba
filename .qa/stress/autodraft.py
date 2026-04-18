# -*- coding: utf-8 -*-
import sys, os
sys.stdout.reconfigure(encoding='utf-8')

import urllib.request, json

BASE = 'http://localhost:3504'

def get(path):
    with urllib.request.urlopen(BASE + path) as r:
        return json.loads(r.read())

def post(path, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(BASE + path, data=data, headers={'Content-Type':'application/json'}, method='POST')
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

# Run full draft
max_picks = 200
for i in range(max_picks):
    state = get('/api/state')
    if state['is_complete']:
        print(f'Draft complete after {i} iters')
        break
    team_id = state['current_team_id']
    if team_id == 0:
        players = get('/api/players?available=true&limit=1&sort=fppg')
        if not players:
            print('No available players!')
            break
        pid = players[0]['id']
        pname = players[0]['name'].encode('ascii','replace').decode()
        post('/api/draft/pick', {'player_id': pid})
        print(f'Human pick #{state["current_overall"]}: pid={pid} name={pname}')
    else:
        post('/api/draft/ai-advance')

state = get('/api/state')
print(f'Final: is_complete={state["is_complete"]} human_roster_len={len(state["teams"][0]["roster"])}')
print(f'Human roster: {state["teams"][0]["roster"]}')
