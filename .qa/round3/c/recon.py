"""Quick recon - explore UI to understand structure."""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
from playwright.sync_api import sync_playwright
import time, json

URL = "https://nbafantasy.cda1234567.com"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    page.goto(URL, wait_until="networkidle", timeout=30000)
    time.sleep(2)
    print("TITLE:", page.title())
    print("URL:", page.url)
    # Dump top-level structure
    html = page.content()
    print("HTML LEN:", len(html))
    # Snapshot body text
    body = page.locator("body").inner_text()
    print("---BODY TEXT (first 3000)---")
    print(body[:3000])
    print("---END---")
    # Find all buttons
    btns = page.locator("button").all()
    print(f"BUTTON COUNT: {len(btns)}")
    for i, b in enumerate(btns[:30]):
        try:
            txt = b.inner_text().strip()[:60]
            visible = b.is_visible()
            print(f"  [{i}] visible={visible} text={txt!r}")
        except:
            pass
    page.screenshot(path="D:/claude/fantasy nba/.qa/round3/c/00_initial.png", full_page=True)
    browser.close()
