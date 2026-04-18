"""Click-through the live site: draft-complete → league → try to play."""
import asyncio
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")

from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda1234567.com"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()
        events = []
        page.on("console", lambda m: events.append(f"[{m.type}] {m.text[:200]}") if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: events.append(f"[pageerror] {str(e)[:400]}"))
        page.on("response", lambda r: events.append(f"[http {r.status}] {r.request.method} {r.url}") if r.status >= 400 and "/api/" in r.url else None)

        await page.goto(BASE, wait_until="networkidle", timeout=30000)
        await asyncio.sleep(2)

        async def snap(tag):
            path = f"D:/claude/fantasy nba/.qa/cant_play_{tag}.png"
            await page.screenshot(path=path, full_page=False)
            return path

        def ui_probe():
            return page.evaluate("""() => {
              const nav = [...document.querySelectorAll('.nav-item, .tab-btn')].map(a => ({
                text: (a.innerText||'').trim().slice(0,30),
                route: a.dataset.route,
                active: a.classList.contains('active'),
              }));
              const main = document.querySelector('#main-view');
              const main_html_len = (main?.innerHTML || '').length;
              const h1 = main?.querySelector('h1, h2, .view-title')?.innerText?.trim() || '';
              const headings = [...main?.querySelectorAll('h1,h2,h3,h4') || []].slice(0,5).map(h=>h.innerText.trim());
              const btns = [...main?.querySelectorAll('button, a.btn') || []].slice(0,30).map(b=>({
                text: (b.innerText||'').trim().slice(0,40),
                classes: b.className,
                disabled: b.disabled,
                href: b.getAttribute('href'),
                id: b.id,
              }));
              return {
                hash: location.hash,
                nav, main_html_len, h1, headings, btns,
                body_text: document.body.innerText.replace(/\\s+/g,' ').slice(0,400),
              };
            }""")

        print("=== Initial (no click) ===")
        r = await ui_probe()
        print(f"  hash={r['hash']}  main_len={r['main_html_len']}")
        print(f"  active nav: {[n['route'] for n in r['nav'] if n['active']]}")
        print(f"  h1: {r['h1']!r}")
        print(f"  first 5 headings: {r['headings']}")
        print(f"  first 6 buttons: {json.dumps(r['btns'][:6], ensure_ascii=False)}")
        await snap("1_initial")

        print("\n=== Click '前往聯盟' CTA ===")
        cta = page.locator("a.btn.primary:has-text('前往聯盟')").first
        if await cta.count():
            await cta.click()
            await asyncio.sleep(2)
            r = await ui_probe()
            print(f"  hash={r['hash']}  main_len={r['main_html_len']}")
            print(f"  active nav: {[n['route'] for n in r['nav'] if n['active']]}")
            print(f"  h1: {r['h1']!r}")
            print(f"  first 5 headings: {r['headings']}")
            print(f"  first 15 buttons:")
            for b in r['btns'][:15]:
                print(f"    - {b}")
            print(f"  body_text (first 400): {r['body_text']}")
            await snap("2_after_cta")
        else:
            print("  CTA not found on initial page")

        print("\n=== Try clicking 'League' nav directly ===")
        await page.evaluate("location.hash = '#league'")
        await asyncio.sleep(2)
        r = await ui_probe()
        print(f"  hash={r['hash']}  main_len={r['main_html_len']}")
        print(f"  h1: {r['h1']!r}")
        print(f"  body_text: {r['body_text']}")
        await snap("3_league_hash")

        print("\n=== Try to find + click a 'start season' / 'advance' / 'playoff' button ===")
        play_btns = await page.evaluate("""() => {
          return [...document.querySelectorAll('button, a.btn')].filter(b => {
            const s = (b.innerText||'').trim();
            return b.offsetParent !== null &&
                   (s.includes('推進') || s.includes('模擬') || s.includes('季後賽') ||
                    s.includes('開始') || s.includes('下一週') || s.includes('下一天') ||
                    s.includes('Advance') || s.includes('Play') || s.includes('Simulate'));
          }).map(b => ({
            text: (b.innerText||'').trim().slice(0,60),
            disabled: b.disabled,
            id: b.id,
            classes: b.className,
          }));
        }""")
        print(f"  game-action buttons: {json.dumps(play_btns, ensure_ascii=False, indent=2)}")

        if play_btns and not play_btns[0].get("disabled"):
            target = play_btns[0]["text"]
            print(f"\n=== Clicking '{target}' ===")
            before_events = len(events)
            await page.locator(f"button:has-text('{target}'), a.btn:has-text('{target}')").first.click(timeout=5000)
            await asyncio.sleep(3)
            r2 = await ui_probe()
            new_events = events[before_events:]
            print(f"  hash={r2['hash']}  body_text: {r2['body_text'][:200]}")
            print(f"  new events: {json.dumps(new_events, ensure_ascii=False, indent=2)}")
            await snap("4_after_action")

        print("\n=== All console / network events ===")
        for e in events[-40:]:
            print(f"  {e}")

        await b.close()


asyncio.run(main())
