"""Active UI audit — find real UX/a11y/visual issues a test-automator would miss."""
import asyncio
import json
import time
from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda1234567.com"


async def audit_viewport(page, label, w, h):
    await page.set_viewport_size({"width": w, "height": h})
    await asyncio.sleep(0.5)
    findings = await page.evaluate(r"""
        () => {
          const issues = [];

          // 1. Buttons without accessible name
          document.querySelectorAll('button').forEach(b => {
            const r = b.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return;
            const name = (b.getAttribute('aria-label') || b.textContent || '').trim();
            if (!name) issues.push({ kind: 'button_no_label', id: b.id, cls: b.className?.toString().slice(0,50) });
          });

          // 2. Images without alt
          document.querySelectorAll('img').forEach(img => {
            if (img.alt === undefined || img.alt === null) issues.push({ kind: 'img_no_alt', src: img.src.slice(-40) });
          });

          // 3. Inputs without label
          document.querySelectorAll('input, select, textarea').forEach(inp => {
            if (inp.type === 'hidden') return;
            const id = inp.id;
            const hasLabel = id && document.querySelector(`label[for="${id}"]`);
            const hasAria = inp.getAttribute('aria-label') || inp.getAttribute('aria-labelledby');
            const placeholder = inp.placeholder;
            if (!hasLabel && !hasAria && !placeholder) {
              issues.push({ kind: 'input_no_label', id: inp.id, type: inp.type });
            }
          });

          // 4. Horizontal overflow at this viewport
          if (document.body.scrollWidth > document.body.clientWidth + 2) {
            issues.push({ kind: 'horizontal_overflow', gap: document.body.scrollWidth - document.body.clientWidth });
          }

          // 5. Tap targets smaller than 44x44 (mobile)
          if (window.innerWidth <= 640) {
            document.querySelectorAll('button, a, input[type=checkbox], input[type=radio]').forEach(el => {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44)) {
                issues.push({ kind: 'small_tap_target', id: el.id, size: `${Math.round(r.width)}x${Math.round(r.height)}`, text: (el.textContent||'').trim().slice(0,20) });
              }
            });
          }

          // 6. Low-contrast text: check sample text colors against their background
          // simple heuristic: read body color vs body bg
          const body = document.body;
          const bs = getComputedStyle(body);
          const muted = [];
          document.querySelectorAll('.muted, .small, .fppg, [class*="muted"], [class*="dim"]').forEach(el => {
            const cs = getComputedStyle(el);
            const c = cs.color;
            muted.push({ id: el.id, cls: el.className?.toString().slice(0,30), color: c });
          });

          // 7. Things that look broken
          const empty_titles = [];
          document.querySelectorAll('h1, h2, h3, h4').forEach(h => {
            if (!h.textContent.trim()) empty_titles.push(h.tagName);
          });
          if (empty_titles.length) issues.push({ kind: 'empty_heading', tags: empty_titles });

          // 8. Tables: missing thead? missing caption?
          document.querySelectorAll('table').forEach(t => {
            if (!t.querySelector('thead')) issues.push({ kind: 'table_no_thead', id: t.id });
            if (!t.querySelector('caption') && !t.getAttribute('aria-label')) {
              issues.push({ kind: 'table_no_caption', id: t.id });
            }
          });

          return { viewport: `${window.innerWidth}x${window.innerHeight}`, issues: issues.slice(0, 50), muted_sample: muted.slice(0,5) };
        }
    """)
    return label, findings


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()

        await page.goto(BASE, wait_until="networkidle", timeout=30000)
        await asyncio.sleep(2)

        # Snapshot different viewports
        results = []
        for label, w, h in [("desktop", 1400, 900), ("tablet", 900, 1200), ("mobile", 390, 844)]:
            label, f = await audit_viewport(page, label, w, h)
            results.append((label, f))

        out_path = "D:/claude/fantasy nba/.qa/stress100/ui_audit.json"
        with open(out_path, "w", encoding="utf-8") as fp:
            json.dump({lbl: data for lbl, data in results}, fp, ensure_ascii=False, indent=2)
        print(f"Wrote {out_path}")
        for label, f in results:
            kind_counts = {}
            for i in f['issues']:
                kind_counts[i['kind']] = kind_counts.get(i['kind'], 0) + 1
            print(f"{label} {f['viewport']}: {kind_counts}")

        await b.close()


asyncio.run(main())
