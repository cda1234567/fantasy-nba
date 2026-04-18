"""
Pair R3-C Watcher - UI-only observer for round3-c league.

- Two headless browser contexts on https://nbafantasy.cda1234567.com
- Polls UI state every 30s
- Captures console errors + non-2xx responses
- Tests realtime-sync and settings-dialog focus behavior
- Writes report to D:\\claude\\fantasy nba\\.qa\\round3\\c\\watcher.md
- NEVER calls /api/* directly from the watcher itself.
"""

from __future__ import annotations

import datetime as dt
import json
import sys
import time
import traceback
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

BASE_URL = "https://nbafantasy.cda1234567.com"
LEAGUE_ID = "round3-c"
REPORT = Path(r"D:\claude\fantasy nba\.qa\round3\c\watcher.md")
MAX_RUN_SECS = 24 * 60  # keep under the 25 min budget
POLL_SECS = 30
APPEAR_POLL_SECS = 60
APPEAR_TIMEOUT_SECS = 5 * 60

report_lines: list[str] = []


def log(msg: str) -> None:
    ts = dt.datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    report_lines.append(line)


def flush_report(header_extra: str = "") -> None:
    body = "\n".join(report_lines)
    REPORT.write_text(
        "# Pair R3-C Watcher Report\n\n"
        f"- League: `{LEAGUE_ID}`\n"
        f"- URL: {BASE_URL}\n"
        "- Role: Watcher (UI-only, no /api calls from watcher; headless Chromium via Playwright)\n"
        f"- Run window: up to {MAX_RUN_SECS // 60} min, poll every {POLL_SECS}s\n"
        f"- Report generated: {dt.datetime.now().isoformat(timespec='seconds')}\n\n"
        f"{header_extra}\n\n"
        "## Timeline\n\n"
        "```\n"
        f"{body}\n"
        "```\n",
        encoding="utf-8",
    )


def snapshot_ui(page) -> dict:
    """Read draft/roster/settings state from DOM only. No /api calls."""
    try:
        state = page.evaluate(
            r"""
            () => {
              const text = (sel) => {
                const el = document.querySelector(sel);
                return el ? (el.innerText || el.textContent || '').trim().slice(0, 400) : null;
              };
              const count = (sel) => document.querySelectorAll(sel).length;
              const bodyTxt = (document.body && document.body.innerText) ? document.body.innerText : '';

              // Detect draft / pick indicators heuristically (UI-only).
              const pickMatches = bodyTxt.match(/(pick|第\s*\d+\s*順位|輪次|round)\s*[#:]?\s*(\d+)/gi) || [];
              const currentPicker = text('[data-testid="current-picker"]') ||
                                    text('.current-picker') ||
                                    text('[data-role="on-clock"]');

              // Roster rows: try several likely selectors.
              const rosterSelectors = [
                '[data-testid="roster-row"]',
                '.roster-row',
                '.team-roster li',
                '[data-role="roster-item"]',
              ];
              let rosterCount = 0;
              for (const s of rosterSelectors) {
                const n = document.querySelectorAll(s).length;
                if (n > rosterCount) rosterCount = n;
              }

              // Settings dialog state.
              const dialog = document.querySelector('[role="dialog"], dialog[open], .settings-dialog, [data-testid="settings-dialog"]');
              const dialogOpen = !!dialog;
              const dialogVisible = dialogOpen && !!(dialog.offsetParent || (dialog.getClientRects && dialog.getClientRects().length));
              const active = document.activeElement;
              const activeInfo = active ? {
                tag: active.tagName,
                id: active.id || null,
                cls: (active.className || '').toString().slice(0, 120),
                label: (active.getAttribute && (active.getAttribute('aria-label') || active.getAttribute('title'))) || null,
              } : null;

              return {
                url: location.href,
                title: document.title,
                pickHints: pickMatches.slice(0, 6),
                currentPicker: currentPicker,
                rosterCount: rosterCount,
                dialogOpen: dialogOpen,
                dialogVisible: dialogVisible,
                activeElement: activeInfo,
                bodyExcerpt: bodyTxt.slice(0, 600),
              };
            }
            """
        )
        return state
    except Exception as e:
        return {"error": f"snapshot failed: {e!r}"}


def wire_listeners(page, label: str, bus: dict) -> None:
    bus.setdefault("console_errors", [])
    bus.setdefault("page_errors", [])
    bus.setdefault("bad_responses", [])

    def on_console(msg):
        if msg.type in ("error", "warning"):
            try:
                txt = msg.text
            except Exception:
                txt = "<no text>"
            bus["console_errors"].append({
                "ctx": label,
                "t": dt.datetime.now().strftime("%H:%M:%S"),
                "type": msg.type,
                "text": txt[:300],
            })

    def on_pageerror(err):
        bus["page_errors"].append({
            "ctx": label,
            "t": dt.datetime.now().strftime("%H:%M:%S"),
            "text": str(err)[:300],
        })

    def on_response(resp):
        try:
            status = resp.status
            if status >= 400:
                url = resp.url
                # Record but do NOT fetch body - we never initiate /api calls ourselves.
                bus["bad_responses"].append({
                    "ctx": label,
                    "t": dt.datetime.now().strftime("%H:%M:%S"),
                    "status": status,
                    "url": url[:240],
                })
        except Exception:
            pass

    page.on("console", on_console)
    page.on("pageerror", on_pageerror)
    page.on("response", on_response)


def try_goto_league(page, ctx_label: str) -> bool:
    """Try a handful of URL patterns for entering a league. UI navigation only."""
    tried = []
    candidates = [
        f"{BASE_URL}/leagues/{LEAGUE_ID}",
        f"{BASE_URL}/league/{LEAGUE_ID}",
        f"{BASE_URL}/?league={LEAGUE_ID}",
        f"{BASE_URL}/#/leagues/{LEAGUE_ID}",
        f"{BASE_URL}/",
    ]
    for url in candidates:
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=15000)
            page.wait_for_timeout(1500)
            tried.append((url, True))
            body = page.evaluate("() => (document.body && document.body.innerText || '').slice(0, 4000)")
            if LEAGUE_ID in (body or "") or LEAGUE_ID in (page.url or ""):
                log(f"[{ctx_label}] landed on {page.url} (round3-c visible)")
                return True
        except Exception as e:
            tried.append((url, f"err:{e!r}"))
            continue
    log(f"[{ctx_label}] could not confirm round3-c; last url={page.url}; tried={tried}")
    return False


def wait_for_round3c(page, ctx_label: str) -> bool:
    """Poll landing page for up to APPEAR_TIMEOUT_SECS for round3-c to appear."""
    deadline = time.time() + APPEAR_TIMEOUT_SECS
    attempt = 0
    while time.time() < deadline:
        attempt += 1
        try:
            page.goto(BASE_URL + "/", wait_until="domcontentloaded", timeout=15000)
            page.wait_for_timeout(1500)
            body = page.evaluate("() => (document.body && document.body.innerText || '')")
            if LEAGUE_ID in (body or ""):
                log(f"[{ctx_label}] round3-c appeared on landing page (attempt {attempt}).")
                return True
            # Try direct URL
            if try_goto_league(page, ctx_label):
                return True
        except Exception as e:
            log(f"[{ctx_label}] wait poll error: {e!r}")
        log(f"[{ctx_label}] round3-c not yet visible (attempt {attempt}); sleeping {APPEAR_POLL_SECS}s")
        time.sleep(APPEAR_POLL_SECS)
    return False


def try_open_settings(page, ctx_label: str) -> dict:
    """Try to open/close settings dialog a few times; observe focus behavior."""
    results = {"attempts": [], "focus_returned_ok": None, "trap_suspected": False}
    selectors_open = [
        'button:has-text("設定")',
        'button[aria-label*="設定"]',
        'button:has-text("Settings")',
        '[data-testid="open-settings"]',
        'button[title*="設定"]',
    ]
    selectors_close = [
        'button:has-text("關閉")',
        'button[aria-label*="關閉"]',
        'button:has-text("Close")',
        '[data-testid="close-settings"]',
        'button[aria-label="Close"]',
    ]

    for i in range(3):
        try:
            opener = None
            for sel in selectors_open:
                loc = page.locator(sel).first
                if loc.count() > 0 and loc.is_visible():
                    opener = loc
                    break
            if not opener:
                results["attempts"].append({"i": i, "open": "no-opener-found"})
                break
            # capture focus before opening
            before_focus = page.evaluate(
                "() => { const a=document.activeElement; return a ? {tag:a.tagName, id:a.id||null, cls:(a.className||'').toString().slice(0,80)} : null; }"
            )
            opener.click(timeout=3000)
            page.wait_for_timeout(500)
            dialog_open = page.evaluate(
                "() => !!document.querySelector('[role=\"dialog\"], dialog[open], .settings-dialog, [data-testid=\"settings-dialog\"]')"
            )
            # try Escape
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            # fallback close click
            closed_via = "Escape"
            still_open = page.evaluate(
                "() => !!document.querySelector('[role=\"dialog\"], dialog[open], .settings-dialog, [data-testid=\"settings-dialog\"]')"
            )
            if still_open:
                closer = None
                for sel in selectors_close:
                    loc = page.locator(sel).first
                    if loc.count() > 0 and loc.is_visible():
                        closer = loc
                        break
                if closer:
                    closer.click(timeout=3000)
                    page.wait_for_timeout(400)
                    closed_via = "close-button"
                else:
                    closed_via = "stuck"
            after_focus = page.evaluate(
                "() => { const a=document.activeElement; return a ? {tag:a.tagName, id:a.id||null, cls:(a.className||'').toString().slice(0,80)} : null; }"
            )
            same_area = False
            try:
                same_area = (
                    before_focus and after_focus
                    and before_focus.get("tag") == after_focus.get("tag")
                    and (before_focus.get("id") or "") == (after_focus.get("id") or "")
                )
            except Exception:
                same_area = False
            results["attempts"].append({
                "i": i,
                "dialog_opened": dialog_open,
                "closed_via": closed_via,
                "before": before_focus,
                "after": after_focus,
                "focus_same_area": same_area,
            })
            if closed_via == "stuck":
                results["trap_suspected"] = True
                break
        except Exception as e:
            results["attempts"].append({"i": i, "error": repr(e)[:200]})
            break

    goods = [a for a in results["attempts"] if a.get("dialog_opened") and a.get("closed_via") != "stuck"]
    if goods:
        results["focus_returned_ok"] = all(a.get("after") for a in goods)
    return results


def main() -> int:
    start = time.time()
    bus = {"console_errors": [], "page_errors": [], "bad_responses": []}
    sync_findings = []
    settings_findings = []

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            try:
                ctxA = browser.new_context()
                ctxB = browser.new_context()
                pageA = ctxA.new_page()
                pageB = ctxB.new_page()
                wire_listeners(pageA, "A", bus)
                wire_listeners(pageB, "B", bus)

                log("Phase 1: wait for round3-c to appear (context A)")
                ok = wait_for_round3c(pageA, "A")
                if not ok:
                    log("round3-c did not appear within 5 min on context A; aborting monitor phase.")
                    return 2

                log("Phase 2: open second context B on round3-c")
                try_goto_league(pageB, "B")

                log("Phase 3: snapshot loop (30s cadence)")
                last_snap_a = None
                last_snap_b = None
                stale_suspected = 0
                realtime_observed = 0
                loop_idx = 0
                while time.time() - start < MAX_RUN_SECS:
                    loop_idx += 1
                    snapA = snapshot_ui(pageA)
                    snapB = snapshot_ui(pageB)
                    log(f"snapA#{loop_idx} roster={snapA.get('rosterCount')} pickHints={snapA.get('pickHints')} dialogOpen={snapA.get('dialogOpen')} currentPicker={snapA.get('currentPicker')}")
                    log(f"snapB#{loop_idx} roster={snapB.get('rosterCount')} pickHints={snapB.get('pickHints')} dialogOpen={snapB.get('dialogOpen')} currentPicker={snapB.get('currentPicker')}")

                    if last_snap_a and last_snap_b:
                        a_changed = (snapA.get("bodyExcerpt") != last_snap_a.get("bodyExcerpt"))
                        b_changed = (snapB.get("bodyExcerpt") != last_snap_b.get("bodyExcerpt"))
                        if a_changed and not b_changed:
                            stale_suspected += 1
                            sync_findings.append(f"loop#{loop_idx} A changed but B did not -> possible stale B")
                        elif a_changed and b_changed:
                            realtime_observed += 1
                            sync_findings.append(f"loop#{loop_idx} A and B both changed -> realtime sync observed")
                    last_snap_a, last_snap_b = snapA, snapB

                    # Every 3rd loop, exercise settings dialog on B
                    if loop_idx % 3 == 1:
                        sr = try_open_settings(pageB, "B")
                        settings_findings.append({"loop": loop_idx, "result": sr})
                        log(f"settings dialog probe B: attempts={len(sr['attempts'])} trap={sr['trap_suspected']} focusOk={sr['focus_returned_ok']}")

                    # Simulate "player closes session" by closing pageA mid-run, then watching B for staleness.
                    if loop_idx == 6 and not pageA.is_closed():
                        log("Phase 3b: closing context A to simulate player leaving; watching B for sync behavior.")
                        try:
                            pageA.close()
                            ctxA.close()
                        except Exception as e:
                            log(f"close A error: {e!r}")

                    remaining = MAX_RUN_SECS - (time.time() - start)
                    if remaining <= POLL_SECS:
                        break
                    time.sleep(POLL_SECS)

                log(f"Snapshot loop finished: realtimeObserved={realtime_observed}, staleSuspected={stale_suspected}")

            finally:
                try:
                    browser.close()
                except Exception:
                    pass

    except Exception as e:
        log(f"FATAL: {e!r}\n{traceback.format_exc()[:2000]}")
        return 1

    # Compose findings section
    header = [
        "## Findings",
        "",
        "### Sync between the two sessions",
    ]
    if sync_findings:
        header += [f"- {f}" for f in sync_findings[:40]]
    else:
        header += ["- No deterministic sync transitions observed during the window (UI excerpt hash stable on both sides)."]

    header += ["", "### Settings dialog probes (context B)"]
    if settings_findings:
        for sf in settings_findings:
            header.append(f"- loop#{sf['loop']}: trap_suspected={sf['result']['trap_suspected']}, focus_returned_ok={sf['result']['focus_returned_ok']}, attempts={len(sf['result']['attempts'])}")
            for a in sf["result"]["attempts"]:
                header.append(f"    - attempt {a.get('i')}: dialogOpened={a.get('dialog_opened')}, closedVia={a.get('closed_via')}, focusSameArea={a.get('focus_same_area')}, err={a.get('error','')}")
    else:
        header += ["- No settings dialog probes ran (UI did not expose a recognizable 設定 button)."]

    header += ["", "### Console errors / page errors / non-2xx responses"]
    if bus["console_errors"]:
        header += [f"- console {e['t']} [{e['ctx']}] {e['type']}: {e['text']}" for e in bus["console_errors"][:40]]
    if bus["page_errors"]:
        header += [f"- pageerror {e['t']} [{e['ctx']}]: {e['text']}" for e in bus["page_errors"][:40]]
    if bus["bad_responses"]:
        header += [f"- http {e['t']} [{e['ctx']}] {e['status']} {e['url']}" for e in bus["bad_responses"][:60]]
    if not (bus["console_errors"] or bus["page_errors"] or bus["bad_responses"]):
        header += ["- None observed."]

    header_extra = "\n".join(header)
    flush_report(header_extra)
    return 0


if __name__ == "__main__":
    try:
        rc = main()
    except Exception:
        traceback.print_exc()
        rc = 3
    # Always flush whatever we have
    try:
        flush_report("")
    except Exception:
        pass
    sys.exit(rc)
