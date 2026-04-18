"""Recon 3: explore create-league dialog + hamburger."""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
from playwright.sync_api import sync_playwright
import time

URL = "https://nbafantasy.cda1234567.com"
OUT = "D:/claude/fantasy nba/.qa/round3/c"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    page.goto(URL, wait_until="networkidle", timeout=30000)
    time.sleep(2)

    # Open league dropdown
    page.locator("button:has-text('聯盟')").first.click()
    time.sleep(0.5)
    # Click create
    page.locator("button:has-text('建立新聯盟')").first.click()
    time.sleep(1)
    page.screenshot(path=f"{OUT}/02_create_dialog.png", full_page=True)

    # Dump visible inputs + buttons
    inputs = page.locator("input:visible").all()
    print(f"Visible inputs: {len(inputs)}")
    for i, inp in enumerate(inputs):
        ph = inp.get_attribute("placeholder") or ""
        nm = inp.get_attribute("name") or ""
        typ = inp.get_attribute("type") or ""
        print(f"  input[{i}] type={typ} name={nm} placeholder={ph!r}")

    btns = page.locator("button:visible").all()
    print(f"Visible buttons: {len(btns)}")
    for i, b in enumerate(btns):
        txt = b.inner_text().strip()[:60]
        if txt: print(f"  [{i}] {txt!r}")

    # Look for hamburger  try common icons - dump all top-level button attrs
    print("\n--- Top-right / header buttons ---")
    hdr_btns = page.locator("header button, nav button").all()
    for i, b in enumerate(hdr_btns):
        try:
            aria = b.get_attribute("aria-label") or ""
            title = b.get_attribute("title") or ""
            txt = b.inner_text().strip()[:40]
            print(f"  hdr[{i}] aria={aria} title={title} text={txt!r}")
        except: pass

    browser.close()
