"""
100-round draft stress test.
Goal: catch critical bugs across varied configurations and chaotic interactions.

Per round:
  * Create fresh league with randomized settings
  * Complete full draft via UI: 模擬到我 (race AI) -> human click -> repeat
  * Functional assertions: pick count, uniqueness, per-team rosters
  * Visual regressions for the 3 v0.5.28 bugs (scroll stability, prev_fppg,
    drafted-in-list)
  * Chaos rounds inject double-click / reload / league-switch

Report: per-round pass/fail + aggregated incidents + screenshots on failure.
"""
import asyncio
import json
import random
import time
import pathlib
from datetime import datetime
from playwright.async_api import async_playwright

BASE = "https://nbafantasy.cda1234567.com"
OUT = pathlib.Path(r"D:\claude\fantasy nba\.qa\stress100")
SHOTS = OUT / "shots"
LOG = OUT / "stress.log"
REPORT = OUT / "stress_report.md"
INCIDENTS = OUT / "incidents.jsonl"

OUT.mkdir(parents=True, exist_ok=True)
SHOTS.mkdir(parents=True, exist_ok=True)

TOTAL_ROUNDS = 100
ROSTER_CHOICES = [10, 13, 15]
STARTERS_CHOICES = [8, 10, 12]

_log_lines = []


def log(msg):
    ts = datetime.now().strftime('%H:%M:%S')
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    _log_lines.append(line)
    try:
        LOG.write_text("\n".join(_log_lines[-2000:]), encoding="utf-8")
    except Exception:
        pass


def record_incident(rnd, kind, detail):
    rec = {"round": rnd, "kind": kind, "detail": detail, "ts": datetime.now().isoformat()}
    with INCIDENTS.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


async def safe_click(page, selector, timeout=5000):
    try:
        await page.locator(selector).first.click(timeout=timeout)
        return True
    except Exception:
        return False


async def create_league(page, lid):
    await page.locator("#btn-league-switch").click()
    await page.wait_for_timeout(250)
    await page.locator("#btn-lsw-new").click()
    await page.wait_for_timeout(350)
    await page.locator("#new-league-id").fill(lid)
    await page.locator("#btn-new-league-create").click()
    await page.wait_for_load_state("networkidle", timeout=20000)


async def setup_random(page, config, rnd):
    """Go to #setup and submit with varied config. Fields we can safely touch:
    roster_size, starters_per_day, randomize_draft_order, player_team_index."""
    await page.goto(f"{BASE}/#setup", wait_until="networkidle")
    await page.locator("#btn-setup-submit").wait_for(state="visible", timeout=15000)

    # Try to set roster_size if selector exists
    try:
        sel = page.locator("#setup-roster-size, select[name='roster_size']").first
        if await sel.count() > 0:
            await sel.select_option(str(config["roster_size"]))
    except Exception:
        pass
    try:
        sel = page.locator("#setup-starters-per-day, select[name='starters_per_day']").first
        if await sel.count() > 0:
            await sel.select_option(str(config["starters_per_day"]))
    except Exception:
        pass
    try:
        chk = page.locator("#setup-randomize, input[name='randomize_draft_order']").first
        if await chk.count() > 0:
            cur = await chk.is_checked()
            if cur != config["randomize"]:
                await chk.click()
    except Exception:
        pass

    await page.locator("#btn-setup-submit").click()
    await page.locator("#tbl-available").wait_for(state="visible", timeout=25000)


async def fetch_state(page):
    return await page.evaluate(f"fetch('{BASE}/api/state',{{credentials:'same-origin'}}).then(r=>r.json())")


async def run_draft_to_complete(page, rnd, chaos_mode, results, config):
    """Play the draft until is_complete. Strategy:
       - While not complete:
         * If human turn: click a draft button
         * Else: click 模擬到我 (fastest way to advance AI)
       - Periodically run visual/regression assertions
    """
    iterations = 0
    max_iters = 300
    picked_pids = []  # our human-picked pid history
    visual_findings = []

    # Capture initial scrollY for scroll-stability check
    last_scroll_y = await page.evaluate("window.scrollY")

    while iterations < max_iters:
        iterations += 1
        d = await fetch_state(page)
        if d.get("is_complete"):
            log(f"r{rnd}: draft complete after {iterations} iters")
            break

        if d.get("current_team_id") == d.get("human_team_id"):
            # Visual/regression checks before picking
            # BUG #3 regression: drafted players must NOT appear in table
            body_pids = await page.evaluate(
                "Array.from(document.querySelectorAll('#tbl-available button[data-draft]')).map(b => parseInt(b.getAttribute('data-draft'),10))"
            )
            server_drafted = {p["player_id"] for p in (d.get("picks") or [])}
            stale = [pid for pid in body_pids if pid in server_drafted]
            if stale:
                visual_findings.append({"kind": "drafted_in_list", "pids": stale[:5]})
                record_incident(rnd, "drafted_in_list", {"pids": stale[:10], "league": config["lid"]})

            # BUG #2 regression: prev_fppg column should differ from current fppg
            # (sampling check)
            if config.get("display_mode_check") and iterations == 1:
                try:
                    r = await page.evaluate(f"fetch('{BASE}/api/players?available=true&limit=3').then(r=>r.json())")
                    all_same = all((p.get('prev_fppg') == p.get('fppg') or p.get('prev_fppg') is None) for p in r[:3])
                    any_valid = any((p.get('prev_fppg') is not None and p.get('prev_fppg') != p.get('fppg')) for p in r[:3])
                    if not any_valid:
                        visual_findings.append({"kind": "prev_fppg_missing", "sample": r[:3]})
                        record_incident(rnd, "prev_fppg_missing", {"sample": r[:3]})
                except Exception:
                    pass

            # BUG #1 regression: scroll should be STABLE unless this is the first
            # human turn transition. (we only check after at least 1 AI pick)
            if iterations > 5:
                cur_scroll = await page.evaluate("window.scrollY")
                if abs(cur_scroll - last_scroll_y) > 400:
                    visual_findings.append({"kind": "scroll_jump", "from": last_scroll_y, "to": cur_scroll})
                    record_incident(rnd, "scroll_jump", {"from": last_scroll_y, "to": cur_scroll})
                last_scroll_y = cur_scroll

            # Pick first available button
            btn = page.locator("#tbl-available button[data-draft]:not([disabled])").first
            try:
                await btn.wait_for(state="visible", timeout=10000)
            except Exception:
                record_incident(rnd, "no_draft_button_on_human_turn", {"iter": iterations})
                return False, iterations, visual_findings
            pid = int(await btn.get_attribute("data-draft"))

            # Chaos: rapid double-click — should not create duplicate pick
            if chaos_mode == "double_click" and len(picked_pids) == 2:
                await btn.click()
                await btn.click(force=True, no_wait_after=True)
                await page.wait_for_timeout(800)
                d2 = await fetch_state(page)
                count = sum(1 for p in d2.get("picks") or [] if p["player_id"] == pid and p["team_id"] == d["human_team_id"])
                if count > 1:
                    record_incident(rnd, "double_click_dup_pick", {"pid": pid, "count": count})
            else:
                await btn.click()

            # Wait for pick to register
            deadline = time.time() + 8
            while time.time() < deadline:
                await page.wait_for_timeout(250)
                d2 = await fetch_state(page)
                if any(pk["player_id"] == pid and pk["team_id"] == d["human_team_id"] for pk in (d2.get("picks") or [])):
                    picked_pids.append(pid)
                    break
            else:
                # Might have been rejected; check server state
                d2 = await fetch_state(page)
                if not any(pk["player_id"] == pid for pk in (d2.get("picks") or [])):
                    record_incident(rnd, "human_pick_not_registered", {"pid": pid, "iter": iterations})
                    return False, iterations, visual_findings

            # Chaos: mid-draft reload
            if chaos_mode == "reload" and len(picked_pids) == 2:
                picks_before = len((await fetch_state(page)).get("picks") or [])
                await page.reload(wait_until="networkidle")
                await page.wait_for_timeout(1500)
                picks_after = len((await fetch_state(page)).get("picks") or [])
                if picks_after < picks_before:
                    record_incident(rnd, "reload_lost_picks", {"before": picks_before, "after": picks_after})

            # Chaos: league switch + switch back mid-draft
            if chaos_mode == "league_switch" and len(picked_pids) == 2:
                original = config["lid"]
                picks_before = len((await fetch_state(page)).get("picks") or [])
                # Open switcher and switch to some other existing league or back
                try:
                    await page.locator("#btn-league-switch").click(timeout=3000)
                    await page.wait_for_timeout(400)
                    # pick first non-active entry
                    alt = page.locator(".lsw-item:not(.active), .league-list-item:not(.active)").first
                    if await alt.count() > 0:
                        await alt.click()
                        await page.wait_for_timeout(1500)
                        # Switch back
                        await page.locator("#btn-league-switch").click()
                        await page.wait_for_timeout(400)
                        back = page.locator(f"text={original}").first
                        if await back.count() > 0:
                            await back.click()
                            await page.wait_for_timeout(1500)
                    # Close any open drawer
                    close = page.locator("#btn-lsw-close, .drawer-close").first
                    if await close.count() > 0:
                        try:
                            await close.click(timeout=1000)
                        except Exception:
                            pass
                except Exception as e:
                    log(f"r{rnd}: league switch chaos error {e}")
                picks_after = len((await fetch_state(page)).get("picks") or [])
                if picks_after < picks_before:
                    record_incident(rnd, "league_switch_lost_picks", {"before": picks_before, "after": picks_after})
        else:
            # AI turn — click 模擬到我 to race forward
            btn = page.locator("button:has-text('模擬到我')").first
            try:
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click()
                    await page.wait_for_timeout(800)
                else:
                    # Fallback: wait for auto-advance timer
                    await page.wait_for_timeout(1800)
            except Exception:
                await page.wait_for_timeout(1500)

    # Final state checks
    final = await fetch_state(page)
    complete = final.get("is_complete") is True
    picks = final.get("picks") or []
    num_teams = final.get("num_teams") or 8
    expected = num_teams * (final.get("total_rounds") or config["roster_size"])

    errors = []
    if not complete:
        errors.append(f"not_complete: picks={len(picks)}/{expected}")
    if len(picks) != expected:
        errors.append(f"pick_count_mismatch: {len(picks)}!={expected}")
    pids = [p["player_id"] for p in picks]
    if len(set(pids)) != len(pids):
        dups = [pid for pid in pids if pids.count(pid) > 1]
        errors.append(f"duplicate_pids: {set(dups)}")
    per_team = {}
    for p in picks:
        per_team[p["team_id"]] = per_team.get(p["team_id"], 0) + 1
    roster = final.get("total_rounds") or config["roster_size"]
    short_teams = [tid for tid, c in per_team.items() if c != roster]
    if short_teams:
        errors.append(f"short_teams: {per_team}")

    if errors:
        for e in errors:
            record_incident(rnd, "final_assertion", {"error": e, "league": config["lid"]})
        return False, iterations, visual_findings

    return True, iterations, visual_findings


async def run_round(browser, rnd, chaos_mode, results):
    config = {
        "lid": f"stress-{int(time.time())%100000}-{rnd}",
        "roster_size": random.choice(ROSTER_CHOICES),
        "starters_per_day": random.choice(STARTERS_CHOICES),
        "randomize": random.choice([True, False]),
        "display_mode_check": rnd % 10 == 0,  # sample every 10 rounds
    }
    ctx = await browser.new_context(viewport={"width": 1400, "height": 900})
    page = await ctx.new_page()

    console_errors = []
    failed_requests = []
    server_errors = []
    page.on("console", lambda m: console_errors.append(m.text[:200]) if m.type == "error" else None)
    page.on("requestfailed", lambda r: failed_requests.append(f"{r.method} {r.url.split('?')[0]} {r.failure}"))
    page.on("response", lambda r: server_errors.append(f"{r.status} {r.url.split('?')[0]}") if r.status >= 500 else None)

    t0 = time.time()
    try:
        await page.goto(BASE, wait_until="networkidle", timeout=30000)
        await create_league(page, config["lid"])
        await setup_random(page, config, rnd)

        ok, iters, visual_findings = await run_draft_to_complete(page, rnd, chaos_mode, results, config)
    except Exception as e:
        log(f"r{rnd}: EXC {type(e).__name__}: {str(e)[:200]}")
        record_incident(rnd, "exception", {"type": type(e).__name__, "msg": str(e)[:500]})
        try:
            await page.screenshot(path=str(SHOTS / f"r{rnd:03d}_exc.png"))
        except Exception:
            pass
        ok, iters, visual_findings = False, 0, []

    elapsed = int(time.time() - t0)
    result = {
        "round": rnd,
        "chaos": chaos_mode,
        "lid": config["lid"],
        "roster_size": config["roster_size"],
        "starters": config["starters_per_day"],
        "shuffle": config["randomize"],
        "iters": iters,
        "elapsed_s": elapsed,
        "ok": ok,
        "console_errors": len(console_errors),
        "failed_requests": len(failed_requests),
        "server_errors": len(server_errors),
        "visual_findings": len(visual_findings),
    }
    if console_errors:
        record_incident(rnd, "console_errors", {"samples": console_errors[:5]})
    if server_errors:
        record_incident(rnd, "server_5xx", {"samples": server_errors[:5]})
    if visual_findings:
        result["visual_findings_sample"] = visual_findings[:3]

    if not ok:
        try:
            await page.screenshot(path=str(SHOTS / f"r{rnd:03d}_fail.png"), full_page=False)
        except Exception:
            pass

    await ctx.close()
    return result


async def main():
    random.seed(42)
    results = []
    INCIDENTS.write_text("", encoding="utf-8")  # reset
    start = time.time()

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        for rnd in range(1, TOTAL_ROUNDS + 1):
            chaos_mode = "none"
            if rnd % 10 == 0 and rnd >= 70:
                chaos_mode = random.choice(["double_click", "reload", "league_switch"])
            log(f"=== round {rnd}/{TOTAL_ROUNDS} (chaos={chaos_mode}) ===")
            try:
                res = await run_round(browser, rnd, chaos_mode, results)
            except Exception as e:
                res = {"round": rnd, "ok": False, "error": f"{type(e).__name__}: {e}"}
                log(f"r{rnd}: round-level exception: {e}")
            results.append(res)
            log(f"r{rnd}: ok={res.get('ok')} iters={res.get('iters')} t={res.get('elapsed_s')}s cerr={res.get('console_errors')} 5xx={res.get('server_errors')} visual={res.get('visual_findings')}")
            # Persist incremental summary every round
            summary = {
                "completed": len(results),
                "passed": sum(1 for r in results if r.get("ok")),
                "failed": sum(1 for r in results if not r.get("ok")),
                "elapsed_min": round((time.time() - start) / 60, 1),
            }
            (OUT / "summary.json").write_text(json.dumps({"summary": summary, "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")

        await browser.close()

    # Final report
    passed = [r for r in results if r.get("ok")]
    failed = [r for r in results if not r.get("ok")]

    report = f"""# Stress — 100 draft rounds

Host: {BASE}
Total: {len(results)}  PASS: {len(passed)}  FAIL: {len(failed)}
Total time: {round((time.time() - start)/60, 1)} min

## Failed rounds

""" + ("\n".join(f"- round {r['round']}: lid={r.get('lid')} roster={r.get('roster_size')} chaos={r.get('chaos')}" for r in failed) if failed else "(none)")

    report += "\n\n## Error counts across runs\n\n"
    report += f"- Rounds with console errors: {sum(1 for r in results if r.get('console_errors'))}\n"
    report += f"- Rounds with server 5xx: {sum(1 for r in results if r.get('server_errors'))}\n"
    report += f"- Rounds with visual findings: {sum(1 for r in results if r.get('visual_findings'))}\n"
    report += "\n## Chaos breakdown\n\n"
    for mode in ("double_click", "reload", "league_switch"):
        subset = [r for r in results if r.get("chaos") == mode]
        if subset:
            report += f"- {mode}: {len(subset)} rounds, {sum(1 for r in subset if r.get('ok'))} pass\n"

    report += "\n## Incidents (first 30)\n\n```\n"
    try:
        lines = INCIDENTS.read_text(encoding="utf-8").strip().split("\n")[:30]
        report += "\n".join(lines)
    except Exception:
        pass
    report += "\n```\n"

    REPORT.write_text(report, encoding="utf-8")
    log(f"done. report: {REPORT}")


if __name__ == "__main__":
    asyncio.run(main())
