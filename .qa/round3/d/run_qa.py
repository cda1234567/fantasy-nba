"""
Round 3 Pair D player-agent QA
Scenario: Trade edge cases, force-execute, trade deadline
Target: https://nbafantasy.cda1234567.com (v0.5.24)
UI-only via Playwright headless Chromium (NO /api/* calls)
"""
import asyncio
import json
import re
import time
from pathlib import Path
from playwright.async_api import async_playwright, TimeoutError as PWTimeout

BASE = "https://nbafantasy.cda1234567.com"
LEAGUE_ID = "round3-d"
OUT_DIR = Path(r"D:\claude\fantasy nba\.qa\round3\d")
SHOT_DIR = OUT_DIR / "screenshots"
SHOT_DIR.mkdir(parents=True, exist_ok=True)

findings = {
    "steps": [],
    "xss_executed": False,
    "xss_dialog_text": None,
    "version": None,
    "events": {},
    "screenshots": [],
    "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
}
shot_idx = 0


def log(msg, data=None):
    ts = time.strftime("%H:%M:%S")
    line = f"[{ts}] {msg}" + (f" :: {json.dumps(data, ensure_ascii=False)[:600]}" if data is not None else "")
    findings["steps"].append(line)
    print(line, flush=True)


async def snap(page, label):
    global shot_idx
    shot_idx += 1
    name = f"r3d_{shot_idx:02d}_{label}.png"
    try:
        await page.screenshot(path=str(SHOT_DIR / name), full_page=False)
        findings["screenshots"].append(name)
    except Exception as e:
        log(f"screenshot fail {label}: {e}")


async def wait_ui(page, ms=500):
    await page.wait_for_timeout(ms)


async def toast_text(page):
    """Grab last toast if any."""
    try:
        els = await page.locator(".toast, [class*='toast']").all()
        if not els:
            return ""
        return (await els[-1].inner_text()).strip()
    except Exception:
        return ""


async def pick_side(page, which: str, n: int) -> int:
    """Pick n players on the 'send' (col 0) or 'receive' (col 1) side."""
    col = 0 if which == "send" else 1
    sides = page.locator(".propose-side")
    count = await sides.count()
    if count < 2:
        log("pickSide: sides not found", {"count": count})
        return 0
    checks = sides.nth(col).locator("input[type='checkbox']")
    total = await checks.count()
    want = min(n, total)
    picked = 0
    for i in range(total):
        if picked >= want:
            break
        cb = checks.nth(i)
        try:
            if not await cb.is_checked():
                await cb.click(timeout=2000)
                picked += 1
                await wait_ui(page, 120)
        except Exception:
            pass
    return picked


async def clear_all(page):
    sides = page.locator(".propose-side")
    count = await sides.count()
    for s in range(count):
        checks = sides.nth(s).locator("input[type='checkbox']:checked")
        c = await checks.count()
        for i in range(c - 1, -1, -1):
            try:
                await checks.nth(i).click(timeout=1500)
                await wait_ui(page, 80)
            except Exception:
                pass


async def ensure_propose_open(page):
    """Open propose dialog if closed and pick first counterparty."""
    opened = await page.locator("#trade-propose[open]").count()
    if not opened:
        try:
            await page.locator("#btn-propose-trade").first.click(timeout=3000)
        except Exception:
            btn = page.locator("button:has-text('發起交易')").first
            if await btn.count() > 0:
                await btn.click()
        await wait_ui(page, 1200)
    opts = await page.locator("#cp-select option").evaluate_all(
        "els => els.map(o => o.value)"
    )
    non_empty = [v for v in opts if v]
    if non_empty:
        try:
            cur = await page.locator("#cp-select").input_value()
        except Exception:
            cur = ""
        if not cur or cur not in non_empty:
            await page.select_option("#cp-select", non_empty[0])
            await wait_ui(page, 1200)


async def run():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()

        # XSS detector
        async def on_dialog(d):
            findings["xss_executed"] = True
            findings["xss_dialog_text"] = f"{d.type}: {d.message}"
            log("NATIVE DIALOG FIRED", {"type": d.type, "message": d.message})
            try:
                await d.dismiss()
            except Exception:
                pass

        page.on("dialog", lambda d: asyncio.create_task(on_dialog(d)))
        page.on("pageerror", lambda e: log("pageerror", {"msg": str(e)}))

        try:
            # ---- Step 1
            log("step-1 open target")
            await page.goto(BASE, wait_until="domcontentloaded", timeout=45000)
            try:
                await page.wait_for_load_state("networkidle", timeout=15000)
            except PWTimeout:
                pass
            await wait_ui(page, 800)
            try:
                findings["version"] = (await page.locator("#app-version").inner_text()).strip()
            except Exception:
                pass
            log("version", {"v": findings["version"]})
            await snap(page, "01_loaded")

            # ---- Step 2 create / switch league round3-d
            log("step-2 create/switch league")
            await page.click("#btn-league-switch")
            await wait_ui(page, 700)
            # Check if already active (current label match)
            try:
                cur_label = (await page.locator("#lsw-current").inner_text()).strip()
            except Exception:
                cur_label = ""
            existing = page.locator(f".lsw-pick[data-league='{LEAGUE_ID}']")
            if cur_label == LEAGUE_ID:
                log("league already active via label match")
                await page.keyboard.press("Escape")
                await wait_ui(page, 400)
            elif await existing.count() > 0:
                log("switching to existing league")
                await existing.click()
                # Reload happens — wait for it
                try:
                    await page.wait_for_load_state("load", timeout=20000)
                except PWTimeout:
                    pass
                await wait_ui(page, 3000)
            else:
                log("creating new league")
                await page.click("#btn-lsw-new")
                await wait_ui(page, 600)
                await page.fill("#new-league-id", LEAGUE_ID)
                await page.click("#btn-new-league-create")
                # Wait for page reload after creation
                try:
                    await page.wait_for_load_state("load", timeout=20000)
                except PWTimeout:
                    pass
                await wait_ui(page, 3500)
            # Re-read label after navigation settles
            try:
                active_label = (await page.locator("#lsw-current").inner_text()).strip()
            except Exception:
                active_label = ""
            log("active-league", {"label": active_label, "url": page.url})
            await snap(page, "02_league_active")

            # ---- Step 3 setup -> draft -> season
            log("step-3 setup / draft / season")
            log("url", {"url": page.url})

            # Navigate to setup page to be sure
            await page.goto(BASE + "/#setup", wait_until="domcontentloaded")
            await wait_ui(page, 2000)
            await snap(page, "03a_setup_page")

            # Click the real setup submit button
            submit = page.locator("#btn-setup-submit").first
            if await submit.count() > 0:
                enabled = False
                try:
                    enabled = await submit.is_enabled()
                except Exception:
                    pass
                if enabled:
                    log("click btn-setup-submit (開始選秀)")
                    await submit.click()
                    # wait for toast "聯盟設定完成" + navigation to draft
                    for _ in range(30):
                        await wait_ui(page, 700)
                        if "#draft" in page.url or await page.locator("text=/選秀/").count() > 2:
                            break
                else:
                    log("setup-submit disabled (setup might already be complete)")
            else:
                log("no #btn-setup-submit found — setup likely already done")
            await wait_ui(page, 2000)
            await snap(page, "03b_after_setup_submit")

            # Go to draft route
            await page.goto(BASE + "/#draft", wait_until="domcontentloaded")
            await wait_ui(page, 2500)
            await snap(page, "04_draft_view")

            # Auto-draft loop. Human picks = click first enabled [data-draft]; AI picks auto-advance.
            log("auto-draft loop")
            for i in range(200):
                done_btn = await page.locator("button:has-text('開始賽季')").count()
                if done_btn > 0:
                    log("draft complete detected", {"iter": i})
                    break
                # If "模擬到我" is enabled (AI's turn), click it to fast-forward
                sim_me = page.locator("button:has-text('模擬到我')").first
                if await sim_me.count() > 0:
                    try:
                        if await sim_me.is_enabled():
                            await sim_me.click(timeout=2000)
                            await wait_ui(page, 1500)
                            continue
                    except Exception:
                        pass
                # Otherwise it's likely human's turn — pick first enabled player
                pick_buttons = page.locator("button[data-draft]:not([disabled])")
                pc = await pick_buttons.count()
                if pc > 0:
                    try:
                        await pick_buttons.first.click(timeout=2000)
                        await wait_ui(page, 400)
                        ok = page.locator("#confirm-ok").first
                        if await ok.count() > 0 and await ok.is_visible():
                            await ok.click()
                        await wait_ui(page, 800)
                        continue
                    except Exception as e:
                        log("human-pick-err", {"e": str(e)})
                # Advance AI if sim-to-me not available
                adv = page.locator("button:has-text('推進 AI 一手')").first
                if await adv.count() > 0:
                    try:
                        if await adv.is_enabled():
                            await adv.click(timeout=2000)
                            await wait_ui(page, 600)
                            continue
                    except Exception:
                        pass
                await wait_ui(page, 700)
            await snap(page, "05_draft_done")

            # Start season
            start_btn = page.locator("button:has-text('開始賽季')").first
            if await start_btn.count() > 0:
                log("start-season")
                try:
                    await start_btn.click()
                    await wait_ui(page, 3000)
                    # confirm
                    ok = page.locator("#confirm-ok").first
                    if await ok.count() > 0 and await ok.is_visible():
                        await ok.click()
                        await wait_ui(page, 2500)
                except Exception as e:
                    log("start-season-err", {"err": str(e)})
            else:
                log("no 開始賽季 button found — draft may not be complete")

            await snap(page, "06_season_started")

            # ---- Step 4: open propose trade dialog
            log("step-4 open propose trade")
            await page.goto(BASE + "/#teams", wait_until="domcontentloaded")
            await wait_ui(page, 1800)
            btn_prop = page.locator("#btn-propose-trade").first
            if await btn_prop.count() == 0:
                btn_prop = page.locator("button:has-text('發起交易')").first
            if await btn_prop.count() > 0:
                try:
                    await btn_prop.click()
                except Exception as e:
                    log("propose-btn-err", {"err": str(e)})
            else:
                log("no propose button found")
            await wait_ui(page, 1500)
            await snap(page, "07_trade_dialog")

            # ==== 5a: empty proposal ====
            log("step-5a empty proposal")
            empty_result = {"submitted": False, "toast": None, "still_open": True}
            cp_sel = page.locator("#cp-select").first
            if await cp_sel.count() > 0:
                opts = await page.locator("#cp-select option").evaluate_all(
                    "els => els.map(o => ({v: o.value, t: o.textContent}))"
                )
                log("cp-options", {"count": len(opts), "sample": opts[:4]})
                first = next((o for o in opts if o["v"]), None)
                if first:
                    await page.select_option("#cp-select", first["v"])
                    await wait_ui(page, 1500)
            # submit with no picks
            try:
                await page.click("#btn-trade-propose-submit", timeout=3000)
            except Exception:
                pass
            await wait_ui(page, 1200)
            t = await toast_text(page)
            empty_result["toast"] = t
            empty_result["still_open"] = (await page.locator("#trade-propose[open]").count()) > 0
            log("5a-result", empty_result)
            findings["events"]["5a_empty"] = empty_result
            await snap(page, "08_empty_submit")

            # ==== 5b: 1-for-3 + 3-for-1 ====
            log("step-5b lopsided")
            await clear_all(page)
            p1 = await pick_side(page, "send", 1)
            p3 = await pick_side(page, "receive", 3)
            bal1 = ""
            try:
                bal1 = (await page.locator(".propose-balance").inner_text()).strip()
            except Exception:
                pass
            log("1v3 picks", {"send": p1, "receive": p3, "balance": bal1})
            try:
                await page.click("#btn-trade-propose-submit", timeout=3000)
            except Exception:
                pass
            await wait_ui(page, 3000)
            toast_1v3 = await toast_text(page)
            log("5b-1v3-toast", {"toast": toast_1v3})
            findings["events"]["5b_1v3"] = {"send": p1, "recv": p3, "balance": bal1, "toast": toast_1v3}

            # Reopen if closed
            await ensure_propose_open(page)
            await clear_all(page)
            p3b = await pick_side(page, "send", 3)
            p1b = await pick_side(page, "receive", 1)
            bal2 = ""
            try:
                bal2 = (await page.locator(".propose-balance").inner_text()).strip()
            except Exception:
                pass
            log("3v1 picks", {"send": p3b, "receive": p1b, "balance": bal2})
            try:
                await page.click("#btn-trade-propose-submit", timeout=3000)
            except Exception:
                pass
            await wait_ui(page, 3000)
            toast_3v1 = await toast_text(page)
            log("5b-3v1-toast", {"toast": toast_3v1})
            findings["events"]["5b_3v1"] = {"send": p3b, "recv": p1b, "balance": bal2, "toast": toast_3v1}
            await snap(page, "09_lopsided")

            # ==== 5c: force-execute ====
            log("step-5c force-execute")
            await ensure_propose_open(page)
            await clear_all(page)
            await pick_side(page, "send", 1)
            await pick_side(page, "receive", 1)
            try:
                await page.check("#trade-force")
            except Exception as e:
                log("force-check-err", {"err": str(e)})
            await wait_ui(page, 400)
            try:
                warn_visible = await page.locator("#trade-force-warn").is_visible()
            except Exception:
                warn_visible = False
            log("force-warn-visible", {"v": warn_visible})
            await snap(page, "10_force_checked")
            try:
                await page.click("#btn-trade-propose-submit", timeout=3000)
            except Exception:
                pass
            await wait_ui(page, 4000)
            toast_force = await toast_text(page)
            log("5c-force-toast", {"toast": toast_force})
            findings["events"]["5c_force"] = {"warn_visible": warn_visible, "toast": toast_force}
            await snap(page, "11_after_force")

            # ==== 5d: pending + history ====
            log("step-5d pending + history")
            await page.goto(BASE + "/#teams", wait_until="domcontentloaded")
            await wait_ui(page, 2000)
            pending_body = ""
            try:
                pending_body = (await page.locator("#trade-pending-body").inner_text()).strip()
            except Exception:
                pass
            log("pending-snippet", {"body": pending_body[:500]})
            try:
                await page.locator("#panel-trade-history h2").first.click()
            except Exception:
                try:
                    await page.locator("#panel-trade-history .panel-head").first.click()
                except Exception:
                    pass
            await wait_ui(page, 1500)
            history_body = ""
            try:
                history_body = (await page.locator("#trade-history-body").inner_text()).strip()
            except Exception:
                pass
            log("history-snippet", {"body": history_body[:600]})
            activity_log = ""
            try:
                activity_log = (await page.locator("#log-list").inner_text()).strip()
            except Exception:
                pass
            log("activity-log-snippet", {"body": activity_log[:600]})
            findings["events"]["5d"] = {
                "pending": pending_body[:500],
                "history": history_body[:600],
                "activity_log": activity_log[:600],
            }
            await snap(page, "12_pending_and_history")

            # ==== 5e: 300-char cap ====
            log("step-5e 300-char cap")
            await ensure_propose_open(page)
            msg400 = "A" * 400
            try:
                await page.fill("#trade-message", msg400)
            except Exception as e:
                log("fill-err", {"e": str(e)})
            length_after_fill = await page.eval_on_selector(
                "#trade-message", "el => el.value.length"
            )
            max_attr = await page.eval_on_selector(
                "#trade-message", "el => el.getAttribute('maxlength')"
            )
            log("5e-fill", {"len": length_after_fill, "maxlength_attr": max_attr})
            # Try JS bypass
            await page.evaluate(
                """() => {
                    const t = document.getElementById('trade-message');
                    if (t) { t.value = 'B'.repeat(400); t.dispatchEvent(new Event('input', {bubbles: true})); }
                }"""
            )
            bypass_len = await page.eval_on_selector(
                "#trade-message", "el => el.value.length"
            )
            log("5e-js-bypass-length", {"len": bypass_len})
            findings["events"]["5e_300char"] = {
                "maxlength_attr": max_attr,
                "fill_length": length_after_fill,
                "js_bypass_length": bypass_len,
            }

            # ==== 5f: XSS ====
            log("step-5f XSS")
            xss_payload = "<img src=x onerror=alert(1)>"
            await page.fill("#trade-message", xss_payload)
            await clear_all(page)
            await pick_side(page, "send", 1)
            await pick_side(page, "receive", 1)
            # tick force so it immediately lands in history
            try:
                await page.check("#trade-force")
            except Exception:
                pass
            await snap(page, "13_xss_prepared")
            try:
                await page.click("#btn-trade-propose-submit", timeout=3000)
            except Exception:
                pass
            await wait_ui(page, 4000)

            # Check pending/history DOM for payload render
            await page.goto(BASE + "/#teams", wait_until="domcontentloaded")
            await wait_ui(page, 2000)
            try:
                await page.locator("#panel-trade-history h2").first.click()
            except Exception:
                pass
            await wait_ui(page, 1500)
            dom_has_img_x = await page.evaluate(
                """() => {
                    const imgs = Array.from(document.querySelectorAll('img'));
                    return imgs.some(img => {
                        const s = img.getAttribute('src') || '';
                        return s === 'x' || (s.includes('x') && img.hasAttribute('onerror'));
                    });
                }"""
            )
            raw_text_present = await page.evaluate(
                "(p) => document.body.innerText.includes(p)", xss_payload
            )
            xss_summary = {
                "payload": xss_payload,
                "dom_has_malicious_img": dom_has_img_x,
                "raw_text_present": raw_text_present,
                "native_dialog_fired": findings["xss_executed"],
                "native_dialog_text": findings["xss_dialog_text"],
            }
            log("5f-xss", xss_summary)
            findings["events"]["5f_xss"] = xss_summary
            await snap(page, "14_xss_after")

            # ==== Step 6: advance past trade deadline ====
            log("step-6 advance past trade deadline")
            await page.goto(BASE + "/#league", wait_until="domcontentloaded")
            await wait_ui(page, 1500)
            deadline_text = ""
            try:
                deadline_text = (await page.locator("text=/交易截止/").first.inner_text()).strip()
            except Exception:
                pass
            log("deadline-setting", {"t": deadline_text})

            await page.goto(BASE + "/#schedule", wait_until="domcontentloaded")
            await wait_ui(page, 1500)

            sim_po = page.locator("button:has-text('模擬到季後賽')").first
            used_sim = False
            if await sim_po.count() > 0:
                try:
                    if await sim_po.is_enabled():
                        log("sim-to-playoffs click")
                        await sim_po.click()
                        await wait_ui(page, 1200)
                        ok = page.locator("#confirm-ok").first
                        if await ok.count() > 0 and await ok.is_visible():
                            await ok.click()
                        used_sim = True
                        # Wait for completion (toast "例行賽模擬完成" or no "推進中")
                        for _ in range(60):
                            await wait_ui(page, 2500)
                            busy = await page.locator(".toast:has-text('推進中')").count()
                            done_toast = await page.locator(".toast:has-text('模擬完成')").count()
                            if done_toast > 0 or busy == 0:
                                break
                except Exception as e:
                    log("sim-po-err", {"e": str(e)})
            if not used_sim:
                log("fallback: press 推進一週 x 12")
                for _ in range(12):
                    adv = page.locator("button:has-text('推進一週')").first
                    if await adv.count() == 0:
                        break
                    try:
                        await adv.click()
                    except Exception:
                        break
                    await wait_ui(page, 3500)

            await snap(page, "15_after_advance")

            week_text = ""
            try:
                week_text = (await page.locator("text=/第.*週/").first.inner_text()).strip()
            except Exception:
                pass
            log("current-week", {"t": week_text[:120]})
            findings["events"]["6_advance"] = {"deadline_setting": deadline_text, "week_after": week_text[:200]}

            # Try propose trade post-deadline
            log("step-6b propose after deadline")
            await page.goto(BASE + "/#teams", wait_until="domcontentloaded")
            await wait_ui(page, 2000)
            try:
                await page.locator("#btn-propose-trade").first.click(timeout=3000)
            except Exception:
                pass
            await wait_ui(page, 1500)
            dlg_open = await page.locator("#trade-propose[open]").count()
            log("dialog-opens-post-deadline", {"open": dlg_open})
            deadline_block = {"dialog_opens": dlg_open > 0, "toast": None, "could_submit": False}
            if dlg_open > 0:
                try:
                    opts = await page.locator("#cp-select option").evaluate_all(
                        "els => els.map(o => o.value)"
                    )
                    non_empty = [v for v in opts if v]
                    if non_empty:
                        await page.select_option("#cp-select", non_empty[0])
                        await wait_ui(page, 1500)
                    await pick_side(page, "send", 1)
                    await pick_side(page, "receive", 1)
                    try:
                        await page.click("#btn-trade-propose-submit", timeout=3000)
                    except Exception:
                        pass
                    await wait_ui(page, 3000)
                    dt = await toast_text(page)
                    deadline_block["toast"] = dt
                    still_open = (await page.locator("#trade-propose[open]").count()) > 0
                    deadline_block["could_submit"] = (not still_open) and ("成功" in (dt or "") or "已發起" in (dt or "") or "強制執行" in (dt or ""))
                    log("deadline-toast", {"t": dt, "dialog_still_open": still_open})
                except Exception as e:
                    log("deadline-submit-err", {"e": str(e)})
            findings["events"]["6b_deadline_block"] = deadline_block
            await snap(page, "16_deadline_attempt")

            # ==== Step 7: final activity log ====
            log("step-7 final activity log")
            await page.goto(BASE + "/#teams", wait_until="domcontentloaded")
            await wait_ui(page, 1500)
            final_log = ""
            try:
                final_log = (await page.locator("#log-list").inner_text()).strip()
            except Exception:
                pass
            log("final-activity-log", {"body": final_log[:1500]})
            findings["events"]["7_final_log"] = final_log[:2000]
            await snap(page, "17_final_log")

            log("DONE")
        except Exception as e:
            log("FATAL", {"err": str(e)})
        finally:
            (OUT_DIR / "findings.json").write_text(
                json.dumps(findings, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            await browser.close()


if __name__ == "__main__":
    asyncio.run(run())
