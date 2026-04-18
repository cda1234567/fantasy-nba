"""Reproduce what happens when user clicks the post-draft CTA on the live site.

Hypothesis: default league has draft complete + season started + regular season
done (20-0 standings). User clicks 'go to league' CTA and something breaks in
the transition to playoffs. Capture every console error, network 4xx/5xx, and
UI state transition.
"""
import asyncio
import json
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda1234567.com"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()

        events = []

        def log_console(msg):
            if msg.type in ("error", "warning"):
                events.append(f"[console.{msg.type}] {msg.text[:300]}")

        def log_pageerror(err):
            events.append(f"[pageerror] {str(err)[:500]}")

        def log_response(resp):
            if resp.status >= 400 and "/api/" in resp.url:
                events.append(f"[http {resp.status}] {resp.request.method} {resp.url}")

        page.on("console", log_console)
        page.on("pageerror", log_pageerror)
        page.on("response", log_response)

        print(f"=== Load {BASE} ===")
        await page.goto(BASE, wait_until="networkidle", timeout=30000)
        await asyncio.sleep(2)

        # Pull initial state
        state = await page.evaluate("() => fetch('/api/state').then(r=>r.json())")
        season = await page.evaluate(
            "() => fetch('/api/season/standings').then(r=>r.ok?r.json():null)"
        )
        summary = await page.evaluate(
            "() => fetch('/api/season/summary').then(r=>r.ok?r.json():null)"
        )

        print(f"  draft.is_complete: {state.get('is_complete')}")
        print(f"  draft.picks: {len(state.get('picks', []))}")
        print(f"  season standings: {len(season.get('standings', [])) if season else 'null'}")
        print(f"  season summary is_complete: {summary.get('is_complete') if summary else 'null'}")
        print(f"  season summary champion: {summary.get('champion_name') if summary else 'null'}")

        # Find visible view + CTA
        ui = await page.evaluate("""() => {
          const visible_views = [...document.querySelectorAll('.view')]
            .filter(v => !v.hidden && v.offsetParent !== null).map(v => v.id);
          const ctas = [...document.querySelectorAll('button, a.btn, .cta')].filter(el => {
            const s = (el.innerText || '').trim();
            return s && el.offsetParent !== null &&
                   (s.includes('聯盟') || s.includes('賽季') || s.includes('開始') ||
                    s.includes('前往') || s.includes('季後賽') || s.includes('Playoff'));
          }).map(el => ({
            tag: el.tagName,
            text: (el.innerText || '').trim().slice(0, 80),
            id: el.id,
            classes: el.className,
            disabled: el.disabled,
          }));
          const nav = [...document.querySelectorAll('.nav-link')].map(n => ({
            text: (n.innerText || '').trim(),
            active: n.classList.contains('active'),
            href: n.getAttribute('href'),
          }));
          return { visible_views, ctas, nav };
        }""")
        print(f"\n=== Initial UI ===")
        print(f"  visible_views: {ui['visible_views']}")
        print(f"  nav: {json.dumps(ui['nav'], ensure_ascii=False)}")
        print(f"  CTAs matching play/season keywords:")
        for c in ui["ctas"]:
            print(f"    - {c}")

        await page.screenshot(path="D:/claude/fantasy nba/.qa/cant_play_initial.png", full_page=False)

        # Try clicking each nav in turn and see what loads
        print(f"\n=== Click-through each nav ===")
        nav_names = [n["text"] for n in ui["nav"] if n["text"]]
        for name in nav_names:
            try:
                loc = page.locator(f".nav-link:has-text('{name}')").first
                if await loc.count() == 0:
                    continue
                await loc.click(timeout=5000)
                await asyncio.sleep(1.2)
                visible = await page.evaluate(
                    "() => [...document.querySelectorAll('.view')].filter(v => !v.hidden && v.offsetParent !== null).map(v => v.id)"
                )
                print(f"  click '{name}' → visible: {visible}")
            except Exception as e:
                print(f"  click '{name}' → ERROR: {str(e)[:200]}")

        # Try the season page specifically and look for playoff CTA
        print(f"\n=== Season / Playoffs check ===")
        try:
            await page.locator(".nav-link:has-text('聯盟')").first.click(timeout=5000)
            await asyncio.sleep(1.5)
        except Exception:
            pass
        playoff_buttons = await page.evaluate("""() => {
          return [...document.querySelectorAll('button')].filter(b =>
            b.offsetParent !== null &&
            (b.innerText || '').trim().length > 0
          ).slice(0, 20).map(b => ({
            text: (b.innerText || '').trim().slice(0, 60),
            id: b.id,
            disabled: b.disabled,
            classes: b.className,
          }));
        }""")
        print(f"  visible buttons on league view:")
        for b in playoff_buttons:
            print(f"    - {b}")

        await page.screenshot(path="D:/claude/fantasy nba/.qa/cant_play_league.png", full_page=False)

        # Dump everything
        print(f"\n=== Console / Network events ===")
        if events:
            for e in events[-30:]:
                print(f"  {e}")
        else:
            print("  (none)")

        # Write report
        report = {
            "ts": time.time(),
            "state_summary": {
                "draft_complete": state.get("is_complete"),
                "picks": len(state.get("picks", [])),
                "standings_teams": len(season.get("standings", [])) if season else None,
                "season_is_complete": summary.get("is_complete") if summary else None,
                "champion": summary.get("champion_name") if summary else None,
            },
            "initial_ui": ui,
            "league_view_buttons": playoff_buttons,
            "events": events,
        }
        with open("D:/claude/fantasy nba/.qa/diagnose_cant_play.json", "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        print(f"\nReport: .qa/diagnose_cant_play.json")

        await b.close()


asyncio.run(main())
