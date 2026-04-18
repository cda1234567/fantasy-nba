"""
Debug why auto-advance dies after ~2 AI picks.
Instruments the page: logs all scheduleDraftAutoAdvance calls + AI advance results.
"""
import asyncio
import time
import pathlib
from datetime import datetime
from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda1234567.com"
OUT = pathlib.Path(r"D:\claude\fantasy nba\.qa\round3\c")
LEAGUE_ID = f"r3cv26d-{int(time.time())%100000}"
CONSOLE_LOG = OUT / "v26_debug_console.log"
NETWORK_LOG = OUT / "v26_debug_network.log"

console_lines = []
network_lines = []


def log_console(msg):
    line = f"[{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] {msg}"
    print(line, flush=True)
    console_lines.append(line)
    try:
        CONSOLE_LOG.write_text("\n".join(console_lines), encoding="utf-8")
    except Exception:
        pass


def log_net(msg):
    line = f"[{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] {msg}"
    network_lines.append(line)
    try:
        NETWORK_LOG.write_text("\n".join(network_lines), encoding="utf-8")
    except Exception:
        pass


INSTRUMENT_JS = """
(function() {
  window._trace = [];
  const push = (msg) => {
    const t = new Date().toISOString().slice(11, 23);
    window._trace.push(`[${t}] ${msg}`);
    console.log(`[TRACE] ${msg}`);
  };

  // Hook scheduleDraftAutoAdvance
  const origSched = window.scheduleDraftAutoAdvance;
  if (typeof origSched === 'function') {
    window.scheduleDraftAutoAdvance = function() {
      const d = window.state && window.state.draft;
      if (d) {
        push(`scheduleDraftAutoAdvance called: current=${d.current_team_id} human=${d.human_team_id} complete=${d.is_complete} busy=${window.state.draftAutoBusy} timer=${!!window.state.draftAutoTimer}`);
      } else {
        push(`scheduleDraftAutoAdvance called: no draft state`);
      }
      return origSched.apply(this, arguments);
    };
    push('scheduleDraftAutoAdvance hooked');
  } else {
    push('scheduleDraftAutoAdvance NOT found on window');
  }

  // Hook api
  const origApi = window.api;
  if (typeof origApi === 'function') {
    window.api = async function(url, opts) {
      push(`api call: ${(opts && opts.method) || 'GET'} ${url}`);
      try {
        const r = await origApi.call(this, url, opts);
        push(`api OK: ${url}`);
        return r;
      } catch (e) {
        push(`api ERR: ${url} -> ${e.message || e}`);
        throw e;
      }
    };
    push('api hooked');
  }

  // Hook render
  const origRender = window.render;
  if (typeof origRender === 'function') {
    window.render = function() {
      push(`render() called; route=${window.currentRoute ? window.currentRoute() : '?'}`);
      return origRender.apply(this, arguments);
    };
    push('render hooked');
  }
})();
"""


async def main():
    OUT.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await ctx.new_page()

        page.on("console", lambda m: log_console(f"{m.type}: {m.text}") if "[TRACE]" in m.text or m.type == "error" else None)
        page.on("request", lambda r: log_net(f"REQ {r.method} {r.url}") if "/api/" in r.url else None)
        page.on("response", lambda r: log_net(f"RSP {r.status} {r.url}") if "/api/" in r.url else None)

        await page.goto(BASE, wait_until="networkidle")
        v = await page.locator("#app-version").inner_text()
        log_console(f"version: {v}")

        # Create league
        await page.locator("#btn-league-switch").click()
        await page.wait_for_timeout(300)
        await page.locator("#btn-lsw-new").click()
        await page.wait_for_timeout(400)
        await page.locator("#new-league-id").fill(LEAGUE_ID)
        await page.locator("#btn-new-league-create").click()
        await page.wait_for_load_state("networkidle", timeout=20000)
        log_console(f"created league {LEAGUE_ID}")

        # Setup
        await page.goto(f"{BASE}/#setup", wait_until="networkidle")
        await page.locator("#btn-setup-submit").wait_for(state="visible", timeout=15000)

        # Inject instrumentation BEFORE setup submit so all subsequent calls are traced
        await page.evaluate(INSTRUMENT_JS)
        log_console("instrumentation injected")

        await page.locator("#btn-setup-submit").click()
        log_console("setup submitted")
        await page.locator("#tbl-available").wait_for(state="visible", timeout=20000)

        # Wait for human turn
        for _ in range(60):
            body = await page.locator("body").inner_text()
            if "輪到你" in body:
                break
            await page.wait_for_timeout(500)
        log_console("human turn reached (or not)")

        # Make 1 human pick
        btn = page.locator("#tbl-available button[data-draft]:not([disabled])").first
        await btn.wait_for(state="visible", timeout=8000)
        pid = await btn.get_attribute("data-draft")
        log_console(f"clicking draft button pid={pid}")
        await btn.click()
        log_console("human click done; now observing auto-advance cycle for 40s")

        # Observe for 40 seconds — should see 7 ai-advance calls + return to human
        for i in range(40):
            await page.wait_for_timeout(1000)
            body = await page.locator("body").inner_text()
            if "輪到你" in body:
                log_console(f"[tick {i}s] HUMAN TURN RETURNED")
                break
            if i % 5 == 0:
                # Get current drafting team index from API
                status = await page.evaluate("window.state && window.state.draft ? ({current: state.draft.current_team_id, human: state.draft.human_team_id, complete: state.draft.is_complete, busy: state.draftAutoBusy, timer: !!state.draftAutoTimer, route: currentRoute()}) : null")
                log_console(f"[tick {i}s] state={status}")

        # Dump trace
        trace = await page.evaluate("window._trace || []")
        log_console("=== full client trace ===")
        for t in trace:
            log_console(t)

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
