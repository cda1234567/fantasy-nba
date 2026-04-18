"""Debug: inspect the actual page DOM and JS state."""
from playwright.sync_api import sync_playwright
import time

BASE = "https://nbafantasy.cda1234567.com"

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    msgs = []
    page.on("console", lambda m: msgs.append(f"[{m.type}] {m.text}"[:300]))
    page.on("pageerror", lambda e: msgs.append(f"[pageerror] {e}"[:300]))

    page.goto(BASE, wait_until="networkidle", timeout=25000)
    time.sleep(2)
    print("URL:", page.url)
    print("title:", page.title())
    # Check body length
    body = page.evaluate("document.body.innerText.length")
    print("body length:", body)
    # Probe for globals
    for fn in ["onShowWeekRecap", "onAdvanceWeek", "refreshState", "api", "render", "state"]:
        t = page.evaluate(f"typeof {fn}")
        print(f"typeof {fn} =", t)
    # nav links
    print("body text head:", page.evaluate("document.body.innerText.slice(0, 400)"))
    # Try #trades
    page.goto(BASE + "/#trades", wait_until="networkidle", timeout=25000)
    time.sleep(2)
    print("#trades URL:", page.url)
    print("#trades body length:", page.evaluate("document.body.innerText.length"))
    print("#trades body head:", page.evaluate("document.body.innerText.slice(0, 600)"))
    # Re-check typeof
    for fn in ["onShowWeekRecap", "onAdvanceWeek", "render", "state"]:
        print(f"  after #trades typeof {fn} =", page.evaluate(f"typeof {fn}"))

    print("\nconsole msgs:")
    for m in msgs[-30:]:
        try:
            print("  ", m)
        except Exception:
            print("  [encoded]", m.encode("ascii", "replace").decode())
    browser.close()
