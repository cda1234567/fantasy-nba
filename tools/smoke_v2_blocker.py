"""Smoke test for v2 new-league + setup UI (BLOCKER fix v26.04.24.10)."""
import sys, time
from playwright.sync_api import sync_playwright, TimeoutError as PwTimeout

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8770"
FAILS: list[str] = []

def fail(m): print(f"FAIL: {m}"); FAILS.append(m)
def ok(m): print(f"OK  : {m}")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context()
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append(f"[{m.type}] {m.text}") if m.type == "error" else None)

    # 1. Open v2 root
    page.goto(BASE + "/")
    try:
        page.wait_for_selector("#btn-league-switch", timeout=5000)
        ok("header has #btn-league-switch")
    except PwTimeout:
        fail("no #btn-league-switch in header")

    # Allow boot to settle (may redirect to #/setup if default league not set up)
    page.wait_for_load_state("networkidle", timeout=5000)
    time.sleep(0.5)
    hash1 = page.evaluate("location.hash")
    print(f"    initial hash: {hash1}")

    # 2. Click league switch button, expect menu + "+ 建立新聯盟" button
    page.click("#btn-league-switch")
    try:
        page.wait_for_selector("#btn-lsw-new-v2", timeout=2000)
        ok("dropdown shows '建立新聯盟' button")
    except PwTimeout:
        fail("dropdown '建立新聯盟' not visible")

    # 3. Click "建立新聯盟" -> expect dialog open with #new-league-id-v2
    page.click("#btn-lsw-new-v2")
    try:
        page.wait_for_selector("#new-league-id-v2", state="visible", timeout=2000)
        ok("new-league modal opens")
    except PwTimeout:
        fail("new-league modal did not open")

    # 4. Create a new league
    lid = f"smoke{int(time.time()) % 100000}"
    page.fill("#new-league-id-v2", lid)
    # Intercept reload via route (don't actually reload during test)
    # Simpler: call API directly via fetch to avoid full-page reload interrupting test.
    resp = page.evaluate(f"""async () => {{
        const r = await fetch('/api/leagues/create', {{
            method: 'POST',
            headers: {{'Content-Type':'application/json'}},
            body: JSON.stringify({{league_id: '{lid}', switch: true}})
        }});
        return {{status: r.status, body: await r.json()}};
    }}""")
    if resp.get("status") == 200 and resp.get("body", {}).get("ok"):
        ok(f"POST /api/leagues/create lid={lid} → active={resp['body'].get('active')}")
    else:
        fail(f"create league failed: {resp}")

    # 5. Reload page, should auto-redirect to #/setup (setup_complete=false for new league)
    page.goto(BASE + "/")
    page.wait_for_load_state("networkidle", timeout=5000)
    time.sleep(0.8)
    h = page.evaluate("location.hash")
    print(f"    post-create hash: {h}")
    if "setup" in h:
        ok("auto-redirected to #/setup for new league")
    else:
        fail(f"expected redirect to #/setup, got hash={h}")

    # 6. Setup page should have 開始選秀 button
    try:
        page.wait_for_selector("#btn-setup-submit-v2", timeout=3000)
        ok("setup view shows '開始選秀' button")
    except PwTimeout:
        fail("setup view missing submit button")

    # 7. Click submit → league/setup API → redirect to draft
    page.click("#btn-setup-submit-v2")
    time.sleep(2.0)
    h2 = page.evaluate("location.hash")
    print(f"    post-setup hash: {h2}")
    if "draft" in h2:
        ok("after setup, navigated to #/draft")
    else:
        fail(f"expected #/draft after setup, got {h2}")

    # 8. Switch back to 'default' league via API (clean up smoke test)
    sw = page.evaluate("""async () => {
        const r = await fetch('/api/leagues/switch', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({league_id:'default'})
        });
        return r.status;
    }""")
    ok(f"switch back to default: status={sw}")

    # 9. Delete test league
    del_resp = page.evaluate(f"""async () => {{
        const r = await fetch('/api/leagues/delete', {{
            method:'POST', headers:{{'Content-Type':'application/json'}},
            body: JSON.stringify({{league_id:'{lid}'}})
        }});
        return r.status;
    }}""")
    if del_resp == 200:
        ok(f"delete league {lid}")
    else:
        fail(f"delete league failed: {del_resp}")

    # Dump any JS errors
    if errs:
        print("----- JS console/page errors -----")
        for e in errs:
            print(e)
        # Only fail on pageerror / actual errors (already filtered to type=error)
        if any("error" in e.lower() or "typeerror" in e.lower() for e in errs):
            fail(f"{len(errs)} JS errors collected")

    browser.close()

if FAILS:
    print(f"\n=== SMOKE FAIL: {len(FAILS)} issue(s) ===")
    for f in FAILS:
        print(" -", f)
    sys.exit(1)
print("\n=== SMOKE OK ===")
