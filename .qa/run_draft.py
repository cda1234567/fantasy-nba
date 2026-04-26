"""Automated draft runner: sim-to-me, pick top available, repeat until complete."""
import json
import urllib.request
import urllib.error
import sys
import time
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

BASE = "https://nbafantasy.cda.tw"
UA = "Mozilla/5.0"


def req(method, path, body=None):
    url = BASE + path
    data = None
    headers = {"User-Agent": UA}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return e.code, body
    except Exception as e:
        return -1, str(e)


def main():
    max_steps = 200
    for i in range(max_steps):
        status, state = req("GET", "/api/state")
        if status != 200:
            print(f"state failed: {status} {state}")
            return 1
        if state.get("is_complete"):
            print(f"Draft complete after {i} steps. picks={len(state['picks'])}")
            return 0
        current_team = state.get("current_team_id")
        human_id = state.get("human_team_id")
        if current_team != human_id:
            # sim to me
            s, r = req("POST", "/api/draft/sim-to-me")
            if s != 200:
                print(f"sim-to-me failed: {s} {r}")
                return 1
            # refresh state after sim
            continue
        # human pick: pick top available by fppg
        s, plist = req("GET", "/api/players?available=true&sort=fppg&limit=1")
        if s != 200:
            print(f"players list failed: {s} {plist}")
            return 1
        if isinstance(plist, dict):
            players = plist.get("players", plist.get("items", []))
        else:
            players = plist
        if not players:
            print("No available players!")
            return 1
        pid = players[0].get("player_id") or players[0].get("id")
        pname = players[0].get("name", "?")
        s, r = req("POST", "/api/draft/pick", {"player_id": pid})
        if s != 200:
            print(f"pick failed pid={pid}: {s} {r}")
            return 1
        print(f"Picked {pname} (round {state.get('current_round')})")
    print("hit max steps")
    return 1


if __name__ == "__main__":
    sys.exit(main())
