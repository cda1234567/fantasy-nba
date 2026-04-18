"""Mobile viewport stress test for Fantasy NBA - Agent 8 (port 3418)."""
import asyncio
import json
import os
import random

from playwright.async_api import async_playwright

BASE = "http://127.0.0.1:3418"
SCREENSHOT_DIR = "D:/claude/fantasy nba/.qa/chaos"
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

IPHONE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
)


async def run():
    findings = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 390, "height": 844},
            user_agent=IPHONE_UA,
            is_mobile=True,
            has_touch=True,
            device_scale_factor=3.0,
        )
        page = await context.new_page()

        js_errors = []
        page.on("pageerror", lambda e: js_errors.append(str(e)))

        async def screenshot(name, note=""):
            path = f"{SCREENSHOT_DIR}/agent-8-{name}.png"
            await page.screenshot(path=path, full_page=False)
            print(f"Screenshot: {path} {note}")
            return path

        async def check_overflow(section):
            result = await page.evaluate(
                """() => {
                const issues = [];
                document.querySelectorAll('*').forEach(el => {
                    const rect = el.getBoundingClientRect();
                    if (rect.right > window.innerWidth + 2) {
                        issues.push({
                            tag: el.tagName,
                            cls: el.className.toString().slice(0, 50),
                            overflowBy: Math.round(rect.right - window.innerWidth)
                        });
                    }
                });
                return issues.slice(0, 10);
            }"""
            )
            if result:
                findings.append({"section": section, "type": "overflow", "details": result})
                print(f"  OVERFLOW in {section}: {result}")
            return result

        async def check_tap_targets(section):
            result = await page.evaluate(
                """() => {
                const small = [];
                const selectors = ['button', 'a', '[role="button"]', '.tab-btn', '.nav-btn', 'input[type="submit"]'];
                selectors.forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            if (rect.width < 44 || rect.height < 44) {
                                small.push({
                                    tag: el.tagName,
                                    text: el.textContent.trim().slice(0, 30),
                                    w: Math.round(rect.width),
                                    h: Math.round(rect.height),
                                    cls: el.className.toString().slice(0, 40)
                                });
                            }
                        }
                    });
                });
                return small.slice(0, 15);
            }"""
            )
            if result:
                findings.append({"section": section, "type": "small_tap_target", "details": result})
                print(f"  SMALL TAP TARGETS in {section}: {len(result)} items")
                for item in result[:5]:
                    print(f"    {item}")
            return result

        async def check_clipped(section):
            result = await page.evaluate(
                """() => {
                const hidden = [];
                const bottomThreshold = window.innerHeight - 70;
                document.querySelectorAll('button, a, input, select').forEach(el => {
                    const rect = el.getBoundingClientRect();
                    if (rect.bottom > bottomThreshold && rect.top < window.innerHeight && rect.width > 0) {
                        hidden.push({
                            tag: el.tagName,
                            text: el.textContent.trim().slice(0, 30),
                            bottom: Math.round(rect.bottom),
                            viewH: window.innerHeight,
                            cls: el.className.toString().slice(0, 40)
                        });
                    }
                });
                return hidden.slice(0, 10);
            }"""
            )
            if result:
                findings.append({"section": section, "type": "clipped_under_tabs", "details": result})
                print(f"  CLIPPED UNDER TABS in {section}: {len(result)} items")
                for item in result[:3]:
                    print(f"    {item}")
            return result

        async def check_dialog_fit(section):
            result = await page.evaluate(
                """() => {
                const dialog = document.querySelector('.modal, dialog, [role="dialog"], .overlay, .modal-overlay, .settings-panel, .panel');
                if (!dialog) return {found: false};
                const rect = dialog.getBoundingClientRect();
                return {
                    found: true,
                    top: Math.round(rect.top),
                    bottom: Math.round(rect.bottom),
                    right: Math.round(rect.right),
                    viewW: window.innerWidth,
                    viewH: window.innerHeight,
                    overflowH: rect.bottom > window.innerHeight,
                    overflowW: rect.right > window.innerWidth
                };
            }"""
            )
            if result.get("overflowH") or result.get("overflowW"):
                findings.append({"section": section, "type": "dialog_overflow", "details": result})
                print(f"  DIALOG OVERFLOW in {section}: {result}")
            return result

        # Navigate all routes
        routes = [
            ("draft", "02-draft"),
            ("teams", "03-teams"),
            ("fa", "04-fa"),
            ("league", "05-league"),
            ("schedule", "06-schedule"),
        ]

        print("\n=== Loading app (home) ===")
        await page.goto(BASE, wait_until="networkidle")
        await screenshot("01-home")
        await check_overflow("home")
        await check_tap_targets("home")
        await check_clipped("home")

        # Collect all nav tab selectors from DOM
        tab_selectors = await page.evaluate(
            """() => {
            const tabs = [];
            document.querySelectorAll('nav a, nav button, .nav-tabs a, .bottom-nav a, .bottom-nav button, .tab-bar a, .tab-bar button').forEach(el => {
                tabs.push({
                    text: el.textContent.trim().slice(0, 20),
                    href: el.getAttribute('href') || '',
                    cls: el.className.toString().slice(0, 50)
                });
            });
            return tabs;
        }"""
        )
        print(f"Nav tabs found: {tab_selectors}")

        for route_hash, ss_name in routes:
            print(f"\n=== {route_hash} tab ===")
            # Try clicking nav tab first
            clicked = False
            for sel in [
                f'a[href="#{route_hash}"]',
                f'[data-tab="{route_hash}"]',
                f'button[data-route="{route_hash}"]',
            ]:
                try:
                    tab = await page.query_selector(sel)
                    if tab:
                        await tab.click()
                        await page.wait_for_timeout(800)
                        clicked = True
                        break
                except Exception:
                    pass
            if not clicked:
                await page.goto(f"{BASE}/#{route_hash}", wait_until="networkidle")
            await page.wait_for_timeout(1000)
            await screenshot(ss_name)
            await check_overflow(route_hash)
            await check_tap_targets(route_hash)
            await check_clipped(route_hash)

        # Settings dialog
        print("\n=== Settings dialog ===")
        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(500)
        settings_btn = None
        for sel in [
            'button[title*="etting"]',
            'button[aria-label*="etting"]',
            ".settings-btn",
            "#settings-btn",
            'button:has-text("Settings")',
            'button:has-text("⚙")',
            'a[href="#settings"]',
        ]:
            try:
                settings_btn = await page.query_selector(sel)
                if settings_btn:
                    break
            except Exception:
                pass

        if settings_btn:
            await settings_btn.click()
            await page.wait_for_timeout(700)
            await screenshot("07-settings-dialog")
            await check_overflow("settings-dialog")
            await check_tap_targets("settings-dialog")
            await check_dialog_fit("settings-dialog")
            # Close
            for close_sel in [".modal-close", ".close-btn", 'button:has-text("×")', 'button:has-text("Close")', 'button:has-text("X")', "[aria-label='Close']"]:
                try:
                    btn = await page.query_selector(close_sel)
                    if btn:
                        await btn.click()
                        break
                except Exception:
                    pass
            else:
                await page.keyboard.press("Escape")
        else:
            print("  No settings button found")
            findings.append({"section": "settings", "type": "not_found", "details": "settings button not found on home"})

        # Trade dialog
        print("\n=== Trade dialog ===")
        await page.goto(f"{BASE}/#teams", wait_until="networkidle")
        await page.wait_for_timeout(800)
        trade_btn = None
        for sel in ['button:has-text("Trade")', 'button:has-text("Propose")', ".trade-btn", 'a:has-text("Trade")']:
            try:
                trade_btn = await page.query_selector(sel)
                if trade_btn:
                    break
            except Exception:
                pass
        if trade_btn:
            await trade_btn.click()
            await page.wait_for_timeout(700)
            await screenshot("08-trade-dialog")
            await check_overflow("trade-dialog")
            await check_dialog_fit("trade-dialog")
            await page.keyboard.press("Escape")
        else:
            print("  No trade button found")
            findings.append({"section": "trade", "type": "not_found", "details": "trade/propose button not found on teams"})

        # League settings dialog
        print("\n=== League settings dialog ===")
        await page.goto(f"{BASE}/#league", wait_until="networkidle")
        await page.wait_for_timeout(800)
        league_settings_btn = None
        for sel in ['button:has-text("Settings")', 'button:has-text("League Settings")', ".league-settings-btn", 'a[href="#settings"]']:
            try:
                league_settings_btn = await page.query_selector(sel)
                if league_settings_btn:
                    break
            except Exception:
                pass
        if league_settings_btn:
            await league_settings_btn.click()
            await page.wait_for_timeout(700)
            await screenshot("09-league-settings-dialog")
            await check_overflow("league-settings-dialog")
            await check_dialog_fit("league-settings-dialog")
            await page.keyboard.press("Escape")

        # Matchup dialog
        print("\n=== Matchup dialog ===")
        await page.goto(f"{BASE}/#league", wait_until="networkidle")
        await page.wait_for_timeout(800)
        matchup_btn = None
        for sel in ['button:has-text("Matchup")', ".matchup-btn", 'button:has-text("View")', ".matchup-link"]:
            try:
                matchup_btn = await page.query_selector(sel)
                if matchup_btn:
                    break
            except Exception:
                pass
        if matchup_btn:
            await matchup_btn.click()
            await page.wait_for_timeout(700)
            await screenshot("10-matchup-dialog")
            await check_overflow("matchup-dialog")
            await check_dialog_fit("matchup-dialog")
            await page.keyboard.press("Escape")
        else:
            print("  No matchup button found")

        # Random tap stress test
        print("\n=== Random tap stress test ===")
        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(500)
        clickables = await page.evaluate(
            """() => {
            const els = [];
            document.querySelectorAll('button, a, [role="button"], .tab-btn, .nav-item').forEach(el => {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight) {
                    els.push({
                        x: Math.round(rect.left + rect.width / 2),
                        y: Math.round(rect.top + rect.height / 2),
                        text: el.textContent.trim().slice(0, 20)
                    });
                }
            });
            return els;
        }"""
        )
        print(f"  Found {len(clickables)} tappable elements")
        random.shuffle(clickables)
        for i, el in enumerate(clickables[:10]):
            try:
                await page.mouse.click(el["x"], el["y"])
                await page.wait_for_timeout(400)
                await check_overflow(f"random-tap-{i}")
            except Exception as e:
                print(f"  Tap error at {el}: {e}")
        await screenshot("11-after-random-taps")

        # Input keyboard obscuring check
        print("\n=== Input field check ===")
        inputs = await page.evaluate(
            """() => {
            const res = [];
            document.querySelectorAll('input, textarea').forEach(el => {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0) {
                    res.push({
                        type: el.type,
                        id: el.id,
                        bottom: Math.round(rect.bottom),
                        viewH: window.innerHeight,
                        nearBottom: rect.bottom > window.innerHeight * 0.6
                    });
                }
            });
            return res;
        }"""
        )
        if inputs:
            risky = [inp for inp in inputs if inp.get("nearBottom")]
            if risky:
                findings.append({"section": "inputs", "type": "keyboard_obscure_risk", "details": risky})
                print(f"  Inputs near bottom (keyboard obscure risk): {risky}")
            else:
                print(f"  {len(inputs)} inputs found, none near bottom")

        # Final screenshot
        await page.goto(BASE, wait_until="networkidle")
        await page.wait_for_timeout(500)
        await screenshot("12-final")

        print("\n=== JS Errors ===")
        if js_errors:
            print(js_errors)
            findings.append({"section": "global", "type": "js_errors", "details": js_errors})
        else:
            print("  None")

        await browser.close()

    return findings


if __name__ == "__main__":
    findings = asyncio.run(run())
    print("\n=== ALL FINDINGS ===")
    for f in findings:
        print(json.dumps(f))
    # Save findings to JSON for report generation
    with open(f"{SCREENSHOT_DIR}/agent-8-findings.json", "w") as fh:
        json.dump(findings, fh, indent=2)
    print(f"\nFindings saved to {SCREENSHOT_DIR}/agent-8-findings.json")
