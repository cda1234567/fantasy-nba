"""Find what the 8x8 mystery buttons are on mobile."""
import asyncio
import json
from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda1234567.com"


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 390, "height": 844})
        page = await ctx.new_page()
        await page.goto(BASE, wait_until="networkidle", timeout=30000)
        await asyncio.sleep(2)

        details = await page.evaluate(r"""
            () => {
              const out = [];
              document.querySelectorAll('button, a, input[type=checkbox], input[type=radio]').forEach(el => {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44)) {
                  const parent = el.parentElement;
                  out.push({
                    tag: el.tagName,
                    id: el.id,
                    cls: el.className?.toString().slice(0, 80),
                    size: `${Math.round(r.width)}x${Math.round(r.height)}`,
                    pos: `${Math.round(r.x)},${Math.round(r.y)}`,
                    text: (el.textContent || el.value || '').trim().slice(0, 30),
                    aria: el.getAttribute('aria-label'),
                    title: el.getAttribute('title'),
                    html: el.outerHTML.slice(0, 180),
                    parent_id: parent?.id,
                    parent_cls: parent?.className?.toString().slice(0, 60),
                  });
                }
              });
              return out;
            }
        """)

        out_path = "D:/claude/fantasy nba/.qa/stress100/small_btns.json"
        with open(out_path, "w", encoding="utf-8") as fp:
            json.dump(details, fp, ensure_ascii=False, indent=2)
        print(f"Wrote {out_path}  ({len(details)} items)")

        await b.close()


asyncio.run(main())
