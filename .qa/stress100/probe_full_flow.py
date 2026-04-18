"""Full flow probe: create league, draft first 3 picks, capture failures + UI oddities.

Goals:
- What is the per-round `failed_requests: 1`? (URL + reason)
- Any console errors NOT from CSP?
- Layout / overflow / z-index / button state anomalies during draft?
"""
import asyncio
import json
import time
from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda1234567.com"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()

        failed = []
        console = []
        resp4xx = []
        page.on("requestfailed", lambda r: failed.append((r.method, r.url, r.failure)))
        page.on("console", lambda m: console.append((m.type, m.text[:300])) if m.type in ("error", "warning") else None)
        page.on("response", lambda r: resp4xx.append(f"{r.status} {r.url}") if 400 <= r.status < 600 else None)

        lid = f"probe-{int(time.time())}"
        await page.goto(BASE, wait_until="networkidle", timeout=30000)
        await asyncio.sleep(1)

        # Switch-to / create new league
        try:
            await page.locator("#btn-league-switch").click(timeout=5000)
            await page.locator("#btn-lsw-new").click(timeout=3000)
            await page.locator("#new-league-id").fill(lid)
            await page.locator("#btn-new-league-create").click(timeout=3000)
            await asyncio.sleep(1.5)
        except Exception as e:
            print("create_league err:", e)

        # Setup defaults, submit
        try:
            btn = page.locator("#setup button[type=submit], #btn-setup-apply, #btn-start")
            await btn.first.click(timeout=3000)
        except Exception as e:
            print("setup err:", e)
        await asyncio.sleep(2)

        # Draft a few human picks via UI until ok
        for attempt in range(30):
            state = await page.evaluate("() => fetch('/api/state').then(r => r.json())")
            draft = state.get("draft", {})
            if draft.get("is_complete"):
                break
            cur_team = draft.get("current_team_id")
            if cur_team == state.get("user_team_id"):
                # human turn: click first draft button
                btns = page.locator("button[data-draft-pid]")
                n = await btns.count()
                if n == 0:
                    break
                await btns.first.click(timeout=3000)
                await asyncio.sleep(1)
            else:
                # AI turn: try 模擬到我 button to fast-forward
                try:
                    await page.locator("#btn-sim-to-me").click(timeout=2000)
                    await asyncio.sleep(0.8)
                except Exception:
                    await asyncio.sleep(0.8)

        # Capture layout oddities
        layout = await page.evaluate("""
            () => {
              const out = {};
              const body = document.body;
              out.scrollW = body.scrollWidth;
              out.clientW = body.clientWidth;
              out.overflowX = body.scrollWidth > body.clientWidth;
              out.horizontalGap = body.scrollWidth - body.clientWidth;

              // find elements extending beyond viewport
              const overflows = [];
              document.querySelectorAll('*').forEach(el => {
                const r = el.getBoundingClientRect();
                if (r.right > window.innerWidth + 2) {
                  overflows.push({
                    tag: el.tagName,
                    id: el.id || null,
                    cls: el.className?.toString().slice(0,60),
                    right: Math.round(r.right)
                  });
                }
              });
              out.overflow_elems = overflows.slice(0, 5);

              // find invisible buttons / zero-size clickables
              const hidden = [];
              document.querySelectorAll('button').forEach(b => {
                const r = b.getBoundingClientRect();
                if ((r.width === 0 || r.height === 0) && !b.hidden) {
                  hidden.push({ id: b.id, text: b.textContent.trim().slice(0,30) });
                }
              });
              out.zero_size_btns = hidden.slice(0, 5);

              // check CSS vars actually defined
              const cs = getComputedStyle(document.documentElement);
              out.accent = cs.getPropertyValue('--accent').trim();
              out.bg = cs.getPropertyValue('--bg').trim();
              return out;
            }
        """)

        print("\n=== FAILED REQUESTS ===")
        for m, u, f in failed:
            print(f"  {m} {u}  -> {f}")
        if not failed:
            print("  (none)")

        print("\n=== 4xx/5xx RESPONSES ===")
        for r in resp4xx[:10]:
            print(f"  {r}")
        if not resp4xx:
            print("  (none)")

        print("\n=== CONSOLE (non-CSP) ===")
        non_csp = [c for c in console if "Content Security Policy" not in c[1]]
        for t, m in non_csp[:15]:
            print(f"  [{t}] {m}")
        if not non_csp:
            print("  (only CSP, none else)")

        print("\n=== LAYOUT ===")
        print(json.dumps(layout, ensure_ascii=False, indent=2))

        await b.close()


asyncio.run(main())
