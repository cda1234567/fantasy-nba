"""Recon 2: explore league switcher + hamburger menu."""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
from playwright.sync_api import sync_playwright
import time, json

URL = "https://nbafantasy.cda1234567.com"
OUT = "D:/claude/fantasy nba/.qa/round3/c"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    page.goto(URL, wait_until="networkidle", timeout=30000)
    time.sleep(2)

    # Click league dropdown (button[1] "聯盟 QA Test League")
    league_btn = page.locator("button:has-text('聯盟')").first
    print("League button text:", league_btn.inner_text())
    league_btn.click()
    time.sleep(1)
    page.screenshot(path=f"{OUT}/01_league_dropdown.png", full_page=True)

    # Dump visible text
    body = page.locator("body").inner_text()
    print("---After league click (first 3000)---")
    print(body[:3000])
    print("---END---")

    # Find all visible buttons now
    btns = page.locator("button:visible").all()
    print(f"Visible buttons: {len(btns)}")
    for i, b in enumerate(btns[:40]):
        try:
            txt = b.inner_text().strip()[:80]
            print(f"  [{i}] {txt!r}")
        except: pass

    # Dump inputs
    inputs = page.locator("input:visible").all()
    print(f"Visible inputs: {len(inputs)}")
    for i, inp in enumerate(inputs):
        try:
            ph = inp.get_attribute("placeholder") or ""
            typ = inp.get_attribute("type") or ""
            print(f"  input[{i}] type={typ} placeholder={ph!r}")
        except: pass

    browser.close()
