import asyncio
from playwright.async_api import async_playwright
import json
import sys

async def run_check():
    results = {
        "navigation": {},
        "draft": "Pending",
        "roster": "Pending",
        "trade": "Pending",
        "console_errors": [],
        "api_failures": [],
        "summary": {
            "functional": [],
            "not_implemented_or_failed": []
        }
    }

    async with async_playwright() as p:
        # Using a longer timeout for slower responses
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        page = await context.new_page()

        # Capture console logs (errors and 404/500)
        page.on("console", lambda msg: results["console_errors"].append(f"{msg.type}: {msg.text}") if msg.type in ["error"] else None)
        
        def handle_response(response):
            if response.status >= 400:
                results["api_failures"].append(f"{response.status} {response.url}")

        page.on("response", handle_response)

        base_url = "http://127.0.0.1:3410/static/v2/index.html"
        print(f"Visiting {base_url}...")
        try:
            await page.goto(base_url, timeout=10000)
        except Exception as e:
            print(f"Failed to load page: {e}")
            await browser.close()
            return {"error": f"Could not connect to {base_url}. Is the server running?"}

        await page.wait_for_timeout(3000) # Wait for initial data load

        # 1. Navigation Check
        tabs = [
            ("home", "今日 (Today)"),
            ("matchup", "對手 (Rival)"),
            ("roster", "名單 (Roster)"),
            ("trade", "交易 (Trade)"),
            ("draft", "選秀 (Draft)"),
            ("settings-btn", "設置 (Settings)"), # This is a button ID
            ("fa", "自由球員 (FA)"),
            ("standings", "排名 (Standings)")
        ]
        
        for tab_id, label in tabs:
            print(f"Checking: {label}")
            if tab_id == "settings-btn":
                try:
                    btn = await page.query_selector(f"#{tab_id}")
                    if btn:
                        await btn.click()
                        await page.wait_for_timeout(800)
                        is_visible = await page.is_visible("#modal-bd.open")
                        if is_visible:
                            results["navigation"][label] = "OK (Modal)"
                            results["summary"]["functional"].append(label)
                            # Close modal
                            close_btn = await page.query_selector("#modal-close-btn")
                            if close_btn:
                                await close_btn.click()
                            else:
                                await page.keyboard.press("Escape")
                            await page.wait_for_timeout(500)
                        else:
                            results["navigation"][label] = "Failed to open modal"
                            results["summary"]["not_implemented_or_failed"].append(label)
                    else:
                        results["navigation"][label] = "Button not found"
                        results["summary"]["not_implemented_or_failed"].append(label)
                except Exception as e:
                    results["navigation"][label] = f"Error: {str(e)}"
                    results["summary"]["not_implemented_or_failed"].append(label)
            else:
                try:
                    await page.goto(f"{base_url}#/{tab_id}")
                    await page.wait_for_timeout(1500)
                    # Check if view has content
                    content = await page.inner_html("#main")
                    if content.strip() and "refreshData error" not in content and "empty-state" not in content:
                        results["navigation"][label] = "OK"
                        results["summary"]["functional"].append(label)
                    elif "empty-state" in content:
                        results["navigation"][label] = "Empty State (Possibly normal)"
                        results["summary"]["functional"].append(label + " (Empty)")
                    else:
                        results["navigation"][label] = "Empty or Error"
                        results["summary"]["not_implemented_or_failed"].append(label)
                except Exception as e:
                    results["navigation"][label] = f"Navigation Error: {str(e)}"
                    results["summary"]["not_implemented_or_failed"].append(label)

        # 2. Roster Page Check
        print("Checking Roster data...")
        await page.goto(f"{base_url}#/roster")
        await page.wait_for_timeout(2000)
        roster_rows = await page.query_selector_all("#roster-tbody tr")
        if len(roster_rows) > 0:
            results["roster"] = f"OK ({len(roster_rows)} players rendered)"
            results["summary"]["functional"].append("名單數據渲染")
        else:
            content = await page.inner_text("#main")
            if "選秀尚未完成" in content or "尚未完成" in content:
                results["roster"] = "Draft not done (Expected behavior)"
                results["summary"]["functional"].append("名單頁面 (預期選秀前狀態)")
            else:
                results["roster"] = "Failed (No rows found)"
                results["summary"]["not_implemented_or_failed"].append("名單數據渲染")

        # 3. Trade Page Check
        print("Checking Trade list...")
        await page.goto(f"{base_url}#/trade")
        await page.wait_for_timeout(2000)
        trade_threads = await page.query_selector_all(".ts-row")
        content = await page.inner_text("#main")
        if len(trade_threads) > 0:
            results["trade"] = f"OK ({len(trade_threads)} threads found)"
            results["summary"]["functional"].append("交易列表顯示")
        elif "尚未" in content or "Empty" in content or "暫無" in content or "交易" in content:
            results["trade"] = "OK (Empty/No trades found)"
            results["summary"]["functional"].append("交易頁面 (空列表)")
        else:
            results["trade"] = "Empty or Error"
            results["summary"]["not_implemented_or_failed"].append("交易列表顯示")

        # 4. Draft Page Check
        print("Checking Draft...")
        await page.goto(f"{base_url}#/draft")
        await page.wait_for_timeout(2000)
        
        pick_btn = await page.query_selector("button[data-draft-pick]")
        if pick_btn:
            player_id = await pick_btn.get_attribute("data-draft-pick")
            print(f"Attempting to draft player {player_id}")
            
            pick_success = False
            async def handle_pick_response(response):
                nonlocal pick_success
                if "/api/draft/pick" in response.url:
                    print(f"API Pick Response: {response.status}")
                    if response.status < 400:
                        pick_success = True
            
            page.on("response", handle_pick_response)
            await pick_btn.click()
            await page.wait_for_timeout(3000)
            
            if pick_success:
                results["draft"] = "OK (Pick successful)"
                results["summary"]["functional"].append("選秀功能 (API調用成功)")
            else:
                results["draft"] = "Failed (API error or button didn't trigger)"
                results["summary"]["not_implemented_or_failed"].append("選秀點擊功能")
        else:
            content = await page.inner_text("#main")
            if "Draft is done" in content or "已完成" in content or "選秀回顧" in content:
                results["draft"] = "Draft already completed"
                results["summary"]["functional"].append("選秀頁面 (已完成狀態)")
            else:
                results["draft"] = "No pick button found (Not your turn or data error)"
                results["summary"]["not_implemented_or_failed"].append("選秀點擊功能 (找不到按鈕)")

        # Final check for Uncaught Errors
        if results["console_errors"]:
             results["summary"]["not_implemented_or_failed"].append(f"Console 報錯 ({len(results['console_errors'])} 處)")
        
        if results["api_failures"]:
             results["summary"]["not_implemented_or_failed"].append(f"API 失敗 ({len(results['api_failures'])} 處)")

        await browser.close()
    
    return results

if __name__ == "__main__":
    try:
        res = asyncio.run(run_check())
        print("\n=== QA CHECK REPORT ===")
        print(json.dumps(res, indent=2, ensure_ascii=False))
    except Exception as e:
        print(f"ERROR running QA script: {e}")
        sys.exit(1)
