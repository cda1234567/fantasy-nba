"""Reproduce what the user sees when they try to play league 260418-2."""
import asyncio
import sys
sys.stdout.reconfigure(encoding="utf-8")
from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda1234567.com"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()

        errs = []
        page.on("console", lambda m: errs.append(f"[{m.type}] {m.text[:200]}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errs.append(f"[pageerror] {e}"))

        await page.goto(BASE, wait_until="networkidle", timeout=30000)
        await asyncio.sleep(2)
        await page.screenshot(path="D:/claude/fantasy nba/.qa/user_saw.png", full_page=False)

        # Get current hash + visible main content
        info = await page.evaluate("""() => {
          const state = {
            url: location.href,
            hash: location.hash,
            title: document.title,
            version: document.querySelector('#app-version')?.textContent || 'n/a',
            activeLeague: document.querySelector('.lsw-current')?.textContent?.trim() || 'n/a',
            nav_active: document.querySelector('.nav-link.active')?.textContent?.trim() || 'n/a',
            visible_views: [...document.querySelectorAll('.view')].filter(v => !v.hidden && v.offsetParent !== null).map(v => v.id),
            draft_button_state: document.querySelectorAll('button[data-draft-pid]').length,
            setup_form: !!document.querySelector('#setup'),
            visible_text: document.body.innerText.slice(0, 600)
          };
          return state;
        }""")

        # State from API
        state = await page.evaluate("() => fetch('/api/state').then(r=>r.json())")
        draft = state.get("draft", {}) or {}
        season = state.get("season", {}) or {}

        print("=== URL / View ===")
        print(f"  URL: {info['url']}")
        print(f"  Hash: {info['hash']}")
        print(f"  Active league label: {info['activeLeague']}")
        print(f"  Nav active: {info['nav_active']}")
        print(f"  Visible views: {info['visible_views']}")
        print(f"  Version badge: {info['version']}")
        print(f"  #setup exists: {info['setup_form']}")
        print(f"  Draft buttons found: {info['draft_button_state']}")

        print("\n=== /api/state ===")
        print(f"  draft.started:   {draft.get('started')}")
        print(f"  draft.is_complete: {draft.get('is_complete')}")
        print(f"  draft.picks:     {len(draft.get('picks', []))}")
        print(f"  draft.num_teams: {draft.get('num_teams')}")
        print(f"  draft.roster_sz: {draft.get('roster_size')}")
        print(f"  season.started:  {season.get('started')}")

        print("\n=== Visible text (first 600) ===")
        print(info["visible_text"])

        print("\n=== Console errors ===")
        if errs:
            for e in errs:
                print(f"  {e}")
        else:
            print("  (none)")

        await page.screenshot(path="D:/claude/fantasy nba/.qa/user_saw.png", full_page=False)
        print("\nScreenshot: .qa/user_saw.png")

        await b.close()


asyncio.run(main())
