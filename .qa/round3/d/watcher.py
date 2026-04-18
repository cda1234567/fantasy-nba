"""Round 3 Pair D Watcher — UI-only observer via Playwright (headless).

Polls https://nbafantasy.cda1234567.com every 30s for up to ~24 minutes.
- waits for round3-d league to appear in the league dropdown
- snapshots 活動 log, roster/standings, watches for trade-related entries
- captures console errors + network 4xx/5xx
- exercises 發起交易 dialog focus management (Tab, Escape, return focus)
- writes report to watcher.md (UI-only, never edits source, no /api calls)
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

TARGET = "https://nbafantasy.cda1234567.com"
LEAGUE = "round3-d"
BASE = Path(r"D:\claude\fantasy nba\.qa\round3\d")
REPORT = BASE / "watcher.md"
LOGFILE = BASE / "watcher.log"
SHOTS = BASE / "screenshots"
SHOTS.mkdir(exist_ok=True)

MAX_MIN = 24
POLL_SEC = 30

console_errors: list[dict] = []
network_issues: list[dict] = []
snapshots: list[dict] = []
trade_log_entries: list[str] = []
a11y_findings: list[str] = []
ui_issues: list[str] = []
navigation_errors: list[str] = []


def ts() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def log(msg: str) -> None:
    line = f"[{ts()}] {msg}"
    print(line, flush=True)
    try:
        with open(LOGFILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


# -- Page helpers --------------------------------------------------------------

def select_league(page, league_name: str) -> bool:
    """Try select/option, then custom dropdown buttons."""
    # Native <select>
    try:
        res = page.evaluate(
            """(name) => {
                const selects = Array.from(document.querySelectorAll('select'));
                for (const s of selects) {
                    const opt = Array.from(s.options || []).find(o =>
                        (o.textContent || '').trim() === name || (o.value || '') === name);
                    if (opt) {
                        s.value = opt.value;
                        s.dispatchEvent(new Event('change', { bubbles: true }));
                        s.dispatchEvent(new Event('input', { bubbles: true }));
                        return 'native';
                    }
                }
                return null;
            }""",
            league_name,
        )
        if res:
            return True
    except Exception as e:
        log(f"select_league native err: {e}")

    # Custom: find button/link whose text contains league name
    try:
        clicked = page.evaluate(
            """(name) => {
                const els = Array.from(document.querySelectorAll('button,a,li,div[role=option],[role=menuitem]'));
                const m = els.find(e => ((e.innerText||'').trim() === name) || ((e.innerText||'').includes(name) && e.offsetParent));
                if (m) { m.click(); return true; }
                return false;
            }""",
            league_name,
        )
        if clicked:
            return True
    except Exception as e:
        log(f"select_league custom err: {e}")
    return False


def list_leagues(page) -> list[str]:
    try:
        names = page.evaluate(
            """() => {
                const out = new Set();
                document.querySelectorAll('select option').forEach(o => {
                    const t = (o.textContent||'').trim(); if (t) out.add(t);
                });
                document.querySelectorAll('[data-league], [class*="league"]').forEach(el => {
                    const t = (el.innerText||'').trim(); if (t && t.length < 60) out.add(t);
                });
                return Array.from(out).slice(0, 50);
            }"""
        )
        return names or []
    except Exception:
        return []


def click_text(page, text: str) -> bool:
    try:
        return bool(page.evaluate(
            """(t) => {
                const els = Array.from(document.querySelectorAll('button,a,[role=tab],[role=button]'));
                const m = els.find(e => (e.innerText||'').trim().startsWith(t));
                if (m) { m.click(); return true; }
                return false;
            }""",
            text,
        ))
    except Exception:
        return False


def snapshot(page, idx) -> dict:
    snap = {"idx": idx, "ts": ts(), "url": page.url}
    try:
        # Activity log
        activity = page.evaluate(
            """() => {
                const cands = document.querySelectorAll('[class*="activity"], [class*="log"], [id*="activity"], [id*="log"], [class*="feed"]');
                const texts = [];
                cands.forEach(c => {
                    const t = (c.innerText || '').trim();
                    if (t && t.length < 4000) texts.push(t.slice(0, 2500));
                });
                return texts.slice(0, 3);
            }"""
        )
        snap["activity"] = activity or []

        # Body text
        snap["body"] = page.evaluate("() => (document.body?.innerText || '').slice(0, 6000)")

        # Trade-like log lines (Chinese 交易 or 'trade')
        trade_lines = page.evaluate(
            """() => {
                const text = (document.body?.innerText || '');
                const lines = text.split(/\\n/).map(l => l.trim()).filter(Boolean);
                return lines.filter(l => /交易|提議|否決|接受|trade/i.test(l)).slice(0, 60);
            }"""
        )
        snap["trade_lines"] = trade_lines or []
        for l in trade_lines or []:
            if l not in trade_log_entries:
                trade_log_entries.append(l)

        # Standings snippet (look for table with 排名/戰績)
        standings = page.evaluate(
            """() => {
                const tables = Array.from(document.querySelectorAll('table'));
                const hit = tables.find(t => /排名|戰績|勝|敗|W-L|Standings/i.test(t.innerText||''));
                if (!hit) return null;
                return (hit.innerText || '').split('\\n').slice(0, 40).join('\\n');
            }"""
        )
        snap["standings"] = standings

        # Roster signal (look for player row count)
        roster = page.evaluate(
            """() => {
                const lists = Array.from(document.querySelectorAll('[class*="roster"],[class*="lineup"],[class*="team"]'));
                const blocks = lists.map(l => (l.innerText||'').slice(0, 1200)).filter(Boolean);
                return blocks.slice(0, 2);
            }"""
        )
        snap["roster"] = roster or []

        # Visual regression: detect overflow, invisible z-index modal residue
        visual = page.evaluate(
            """() => {
                const issues = [];
                const all = document.querySelectorAll('body *');
                let overflowCount = 0;
                all.forEach(el => {
                    const r = el.getBoundingClientRect();
                    if (r.right - document.documentElement.clientWidth > 10 && r.width > 100) overflowCount++;
                });
                if (overflowCount > 0) issues.push('horizontal-overflow-nodes:' + overflowCount);
                // orphan modal backdrop
                const bd = document.querySelectorAll('[class*="backdrop"],[class*="overlay"]');
                bd.forEach(b => {
                    const s = getComputedStyle(b);
                    if (s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity||'1') > 0.1) {
                        if (!b.querySelector('[role=dialog], dialog, [class*="modal"]')) {
                            issues.push('stray-backdrop:' + (b.className||'') );
                        }
                    }
                });
                return issues;
            }"""
        )
        snap["visual"] = visual or []
        for v in visual or []:
            if v not in ui_issues:
                ui_issues.append(v)

        # screenshot
        try:
            p = SHOTS / f"snap_{idx}.png"
            page.screenshot(path=str(p), full_page=False)
            snap["screenshot"] = p.name
        except Exception as e:
            snap["screenshot_err"] = str(e)

        log(
            f"snap #{idx} url={snap['url']} trade_lines={len(trade_lines or [])} standings={'Y' if standings else 'N'} visual={len(visual or [])}"
        )
    except Exception as e:
        snap["error"] = str(e)
        log(f"snapshot #{idx} ERROR: {e}")
    snapshots.append(snap)
    return snap


def test_trade_dialog_a11y(page) -> None:
    """Open 發起交易 dialog, Tab through, Escape to close, verify focus returns."""
    try:
        # Record focused element before opening
        pre_focus = page.evaluate(
            "() => { const e = document.activeElement; return e ? (e.tagName + '#' + (e.id||'') + '.' + (e.className||'')).slice(0,120) : 'none'; }"
        )
        # Find trigger
        opened = page.evaluate(
            """() => {
                const buttons = Array.from(document.querySelectorAll('button,a,[role=button]'));
                const trigger = buttons.find(b => /發起交易|提議交易|新增交易|Propose trade|Create trade/i.test((b.innerText||'').trim()));
                if (!trigger) return null;
                trigger.setAttribute('data-qa-trade-trigger','1');
                trigger.focus();
                trigger.click();
                return { text: (trigger.innerText||'').trim(), tag: trigger.tagName };
            }"""
        )
        if not opened:
            a11y_findings.append("trade_trigger_not_found: could not find 發起交易 / 提議交易 button on page")
            log("trade_trigger_not_found")
            return
        log(f"trade trigger clicked: {opened}")
        page.wait_for_timeout(1500)

        # Is a dialog / modal visible?
        dialog_info = page.evaluate(
            """() => {
                const sels = 'dialog[open],[role=dialog],[aria-modal="true"],[class*="modal"][class*="open"],[class*="Dialog"]';
                const dlg = document.querySelector(sels);
                if (!dlg) {
                    // fallback: any freshly visible large fixed element
                    const fixed = Array.from(document.querySelectorAll('*')).filter(el => {
                        const s = getComputedStyle(el);
                        return s.position === 'fixed' && s.display !== 'none' && parseFloat(s.opacity||'1') > 0.5 && el.getBoundingClientRect().width > 300;
                    });
                    if (fixed.length) {
                        const el = fixed[0];
                        return { foundFallback: true, tag: el.tagName, cls: el.className, ariaModal: el.getAttribute('aria-modal'), role: el.getAttribute('role') };
                    }
                    return null;
                }
                return { tag: dlg.tagName, cls: dlg.className, ariaModal: dlg.getAttribute('aria-modal'), role: dlg.getAttribute('role') };
            }"""
        )
        if not dialog_info:
            a11y_findings.append("trade_dialog_did_not_open after clicking trigger")
            log("trade dialog did not open")
            return
        a11y_findings.append(f"dialog opened: {json.dumps(dialog_info, ensure_ascii=False)}")

        # Focus management: initial focus should be inside dialog
        initial_focus = page.evaluate(
            """() => {
                const dlg = document.querySelector('dialog[open],[role=dialog],[aria-modal="true"],[class*="modal"][class*="open"],[class*="Dialog"]');
                const ae = document.activeElement;
                return { activeTag: ae?.tagName, insideDialog: dlg ? dlg.contains(ae) : null, activeText: (ae?.innerText||'').slice(0,60) };
            }"""
        )
        a11y_findings.append(f"initial focus: {json.dumps(initial_focus, ensure_ascii=False)}")
        if initial_focus and initial_focus.get("insideDialog") is False:
            a11y_findings.append("ISSUE: initial focus is NOT inside dialog after open")

        # Tab through a few times, record focus path
        path = []
        for i in range(6):
            page.keyboard.press("Tab")
            page.wait_for_timeout(120)
            ae = page.evaluate(
                """() => {
                    const ae = document.activeElement;
                    const dlg = document.querySelector('dialog[open],[role=dialog],[aria-modal="true"],[class*="modal"][class*="open"],[class*="Dialog"]');
                    return { tag: ae?.tagName, txt: (ae?.innerText||'').slice(0,50), insideDialog: dlg ? dlg.contains(ae) : null };
                }"""
            )
            path.append(ae)
        a11y_findings.append(f"tab path: {json.dumps(path, ensure_ascii=False)}")
        outside = [p for p in path if p.get("insideDialog") is False]
        if outside:
            a11y_findings.append(f"ISSUE: focus escaped dialog during Tab (count={len(outside)})")

        # Screenshot with dialog open
        try:
            page.screenshot(path=str(SHOTS / "dialog_open.png"))
        except Exception:
            pass

        # Escape should close
        page.keyboard.press("Escape")
        page.wait_for_timeout(800)
        closed = page.evaluate(
            """() => {
                const dlg = document.querySelector('dialog[open],[role=dialog],[aria-modal="true"],[class*="modal"][class*="open"],[class*="Dialog"]');
                return !dlg || getComputedStyle(dlg).display === 'none' || dlg.getAttribute('aria-hidden') === 'true';
            }"""
        )
        a11y_findings.append(f"escape-closes-dialog: {bool(closed)}")
        if not closed:
            a11y_findings.append("ISSUE: Escape did not close dialog")

        # Focus returns to trigger
        post = page.evaluate(
            """() => {
                const trig = document.querySelector('[data-qa-trade-trigger]');
                const ae = document.activeElement;
                return { triggerFound: !!trig, focusReturnedToTrigger: trig === ae, activeTag: ae?.tagName, activeText: (ae?.innerText||'').slice(0,60) };
            }"""
        )
        a11y_findings.append(f"post-close focus: {json.dumps(post, ensure_ascii=False)}")
        if not post.get("focusReturnedToTrigger"):
            a11y_findings.append("ISSUE: focus did not return to the trigger button after close")

        log(f"dialog a11y done: {post}")
    except Exception as e:
        a11y_findings.append(f"a11y_test_exception: {e}")
        log(f"a11y test exception: {e}\n{traceback.format_exc()}")


# -- Report --------------------------------------------------------------------

def write_report(final: bool) -> None:
    lines: list[str] = []
    lines.append("# Round 3 Pair D - Watcher Report")
    lines.append("")
    lines.append(f"**Target:** {TARGET}")
    lines.append(f"**League:** {LEAGUE}")
    lines.append(f"**Mode:** Playwright headless, UI-only, no /api calls")
    lines.append(f"**Started:** {snapshots[0]['ts'] if snapshots else '(pending)'}")
    lines.append(f"**Last update:** {ts()}")
    lines.append(f"**Status:** {'completed' if final else 'in-progress'}")
    lines.append(f"**Snapshots:** {len(snapshots)}")
    lines.append("")

    # Trade log quality
    lines.append("## Trade Log Quality & i18n")
    lines.append("")
    if not trade_log_entries:
        lines.append("_No trade-related log entries captured yet._")
    else:
        ascii_only = [l for l in trade_log_entries if not re.search(r"[\u4e00-\u9fff]", l)]
        has_chinese = [l for l in trade_log_entries if re.search(r"[\u4e00-\u9fff]", l)]
        lines.append(f"- total trade/交易-related lines captured: {len(trade_log_entries)}")
        lines.append(f"- lines with Chinese characters: {len(has_chinese)}")
        lines.append(f"- lines that are ASCII-only (possible i18n miss): {len(ascii_only)}")
        if ascii_only:
            lines.append("  - ASCII-only samples (may indicate untranslated strings):")
            for l in ascii_only[:10]:
                lines.append(f"    - `{l[:180]}`")
        lines.append("")
        lines.append("### Sample trade log entries")
        for l in trade_log_entries[:25]:
            lines.append(f"- {l[:240]}")
    lines.append("")

    # Dialog a11y
    lines.append("## Trade Dialog — Focus Management & a11y")
    lines.append("")
    if not a11y_findings:
        lines.append("_Dialog test was not executed (trigger may not have appeared)._")
    else:
        for f in a11y_findings:
            lines.append(f"- {f}")
    lines.append("")

    # Console errors
    lines.append("## Console Errors / Warnings")
    lines.append("")
    if not console_errors:
        lines.append("_None captured._")
    else:
        for e in console_errors[:80]:
            loc = e.get("location") or {}
            lines.append(f"- [{e['ts']}] {e['type']}: {e['text'][:260]}")
            if loc.get("url"):
                lines.append(f"  - at {loc.get('url')}:{loc.get('lineNumber')}")
    lines.append("")

    # Network
    lines.append("## Non-2xx Network Responses")
    lines.append("")
    if not network_issues:
        lines.append("_None captured._")
    else:
        for n in network_issues[:80]:
            lines.append(f"- [{n['ts']}] {n['status']} {n['method']} {n['url']}")
    lines.append("")

    # UI polish
    lines.append("## Visual / UI Issues")
    lines.append("")
    if not ui_issues:
        lines.append("_No overflow or stray backdrop detected during window._")
    else:
        for u in ui_issues:
            lines.append(f"- {u}")
    lines.append("")

    # Standings/rosters sync sanity
    lines.append("## Standings / Rosters Observation")
    lines.append("")
    snaps_with_standings = [s for s in snapshots if s.get("standings")]
    lines.append(f"- snapshots containing standings table: {len(snaps_with_standings)}")
    if snaps_with_standings:
        last = snaps_with_standings[-1]
        lines.append(f"- last standings snapshot (#{last['idx']} @ {last['ts']}):")
        lines.append("```")
        lines.append(last["standings"][:1500])
        lines.append("```")
    lines.append("")

    # Snapshot log
    lines.append("## Snapshot Timeline")
    lines.append("")
    for s in snapshots:
        lines.append(f"### Snapshot #{s['idx']} — {s['ts']}")
        lines.append(f"- url: {s.get('url','')}")
        if s.get("error"):
            lines.append(f"- ERROR: {s['error']}")
            continue
        lines.append(f"- trade lines: {len(s.get('trade_lines',[]))}  visual: {s.get('visual',[])}")
        if s.get("screenshot"):
            lines.append(f"- screenshot: screenshots/{s['screenshot']}")
        act = s.get("activity") or []
        if act:
            lines.append("- activity excerpt:")
            lines.append("```")
            for a in act[:1]:
                for ln in a.split("\n")[:12]:
                    lines.append(ln)
            lines.append("```")
        lines.append("")

    lines.append("## Summary")
    lines.append("")
    lines.append(f"- snapshots: {len(snapshots)}")
    lines.append(f"- trade log entries observed: {len(trade_log_entries)}")
    lines.append(f"- console errors: {len(console_errors)}")
    lines.append(f"- non-2xx responses: {len(network_issues)}")
    lines.append(f"- UI issues: {len(ui_issues)}")
    lines.append(f"- a11y findings: {len(a11y_findings)}")
    if navigation_errors:
        lines.append("- navigation errors:")
        for n in navigation_errors:
            lines.append(f"  - {n}")
    lines.append("")

    REPORT.write_text("\n".join(lines), encoding="utf-8")


# -- Main ----------------------------------------------------------------------

def main() -> int:
    log("watcher starting")
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True)
        except Exception as e:
            log(f"chromium launch failed: {e}")
            navigation_errors.append(f"chromium launch failed: {e}")
            write_report(True)
            return 2

        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()

        def on_console(msg):
            t = msg.type
            if t in ("error", "warning"):
                console_errors.append({
                    "ts": ts(),
                    "type": t,
                    "text": msg.text,
                    "location": msg.location,
                })

        def on_pageerror(err):
            console_errors.append({"ts": ts(), "type": "pageerror", "text": str(err), "location": None})

        def on_response(resp):
            try:
                status = resp.status
                url = resp.url
                if status >= 400 and url.startswith(TARGET):
                    network_issues.append({
                        "ts": ts(),
                        "status": status,
                        "method": resp.request.method,
                        "url": url,
                    })
            except Exception:
                pass

        page.on("console", on_console)
        page.on("pageerror", on_pageerror)
        page.on("response", on_response)

        log(f"navigating to {TARGET}")
        try:
            page.goto(TARGET, wait_until="domcontentloaded", timeout=30_000)
        except Exception as e:
            navigation_errors.append(f"initial nav error: {e}")
            log(f"nav error: {e}")
        page.wait_for_timeout(3000)

        # Wait/retry for league round3-d
        selected = False
        deadline_wait = time.time() + 8 * 60  # give up to 8 minutes for league to appear
        attempt = 0
        while not selected and time.time() < deadline_wait:
            attempt += 1
            selected = select_league(page, LEAGUE)
            if selected:
                log(f"league {LEAGUE} selected on attempt {attempt}")
                break
            avail = list_leagues(page)
            log(f"attempt {attempt}: league {LEAGUE} not present. visible: {avail[:12]}")
            # snapshot interval during wait
            try:
                page.screenshot(path=str(SHOTS / f"wait_{attempt}.png"))
            except Exception:
                pass
            page.wait_for_timeout(60_000)
            try:
                page.reload(wait_until="domcontentloaded", timeout=20_000)
            except Exception as e:
                log(f"reload err: {e}")
            page.wait_for_timeout(2000)
            write_report(False)

        if not selected:
            log("WARN: round3-d never appeared in dropdown. Continuing to observe default page.")
            navigation_errors.append(f"league {LEAGUE} not found after {attempt} attempts")
        page.wait_for_timeout(2000)

        # Observation loop
        deadline = time.time() + MAX_MIN * 60
        idx = 0
        a11y_tested = False
        while time.time() < deadline:
            idx += 1
            # Cycle views
            if click_text(page, "聯盟"):
                page.wait_for_timeout(1200)
            snapshot(page, f"{idx}-league")

            if click_text(page, "隊伍") or click_text(page, "球隊"):
                page.wait_for_timeout(1200)
            snapshot(page, f"{idx}-team")

            # Run a11y test once after we've seen a trade button become likely (ideally around idx 3-5)
            if not a11y_tested and idx >= 2:
                test_trade_dialog_a11y(page)
                a11y_tested = True

            write_report(False)

            remaining = deadline - time.time()
            sleep_s = min(POLL_SEC, max(0, remaining))
            if sleep_s <= 0:
                break
            log(f"sleeping {int(sleep_s)}s")
            page.wait_for_timeout(int(sleep_s * 1000))

        log("observation window complete")
        write_report(True)
        try:
            browser.close()
        except Exception:
            pass
    log("watcher done")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log(f"FATAL: {e}\n{traceback.format_exc()}")
        navigation_errors.append(f"fatal: {e}")
        try:
            write_report(True)
        except Exception:
            pass
        sys.exit(1)
