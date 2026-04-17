"""Generate 10 Traditional Chinese offseason headlines per NBA season.

Usage:
    python tools/generate_headlines.py

Reads  app/data/seasons/{YYYY-YY}.json (30 files, 1996-97 through 2025-26)
Writes app/data/offseason/{YYYY-YY}.json (29 files, 1997-98 through 2025-26)
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parent.parent
SEASONS_DIR = REPO_ROOT / "app" / "data" / "seasons"
OUT_DIR = REPO_ROOT / "app" / "data" / "offseason"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Team name mapping (abbr -> Traditional Chinese)
# ---------------------------------------------------------------------------
TEAM_ZH: dict[str, str] = {
    "ATL": "亞特蘭大老鷹",
    "BOS": "波士頓塞爾提克",
    "BRK": "布魯克林籃網",
    "NJN": "紐澤西籃網",
    "CHA": "夏洛特黃蜂",
    "CHH": "夏洛特黃蜂",
    "CHO": "夏洛特黃蜂",
    "CHI": "芝加哥公牛",
    "CLE": "克里夫蘭騎士",
    "DAL": "達拉斯獨行俠",
    "DEN": "丹佛金塊",
    "DET": "底特律活塞",
    "GSW": "金州勇士",
    "HOU": "休士頓火箭",
    "IND": "印第安納溜馬",
    "LAC": "洛杉磯快艇",
    "LAL": "洛杉磯湖人",
    "MEM": "曼菲斯灰熊",
    "VAN": "溫哥華灰熊",
    "MIA": "邁阿密熱火",
    "MIL": "密爾瓦基公鹿",
    "MIN": "明尼蘇達灰狼",
    "NOH": "紐奧良黃蜂",
    "NOK": "紐奧良/奧克拉荷馬城黃蜂",
    "NOP": "紐奧良鵜鶘",
    "NYK": "紐約尼克",
    "OKC": "奧克拉荷馬城雷霆",
    "ORL": "奧蘭多魔術",
    "PHI": "費城七六人",
    "PHX": "鳳凰城太陽",
    "POR": "波特蘭拓荒者",
    "SAC": "沙加緬度國王",
    "SAS": "聖安東尼奧馬刺",
    "SEA": "西雅圖超音速",
    "TOR": "多倫多暴龍",
    "UTA": "猶他爵士",
    "WAS": "華盛頓巫師",
    "WSB": "華盛頓子彈",
}


def team_zh(abbr: str) -> str:
    return TEAM_ZH.get(abbr, abbr)


# ---------------------------------------------------------------------------
# Data helpers
# ---------------------------------------------------------------------------
SEASON_FILES = sorted(SEASONS_DIR.glob("*.json"))


def load_season(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))


def detect_events(prev: list[dict], curr: list[dict]) -> dict:
    """Return structured event data comparing two consecutive seasons."""
    prev_map = {p["id"]: p for p in prev}
    curr_map = {p["id"]: p for p in curr}

    # Top players by fppg
    top20_prev = {p["id"] for p in sorted(prev, key=lambda x: x["fppg"], reverse=True)[:20]}
    top50_prev = {p["id"] for p in sorted(prev, key=lambda x: x["fppg"], reverse=True)[:50]}
    top20_curr = {p["id"] for p in sorted(curr, key=lambda x: x["fppg"], reverse=True)[:20]}

    team_changes: list[dict] = []
    retirements: list[dict] = []
    rookies: list[dict] = []          # new to curr, no prev record, high fppg
    breakouts: list[dict] = []        # in prev but outside top 100, now top 30

    prev_top100 = {p["id"] for p in sorted(prev, key=lambda x: x["fppg"], reverse=True)[:100]}
    curr_top30  = {p["id"] for p in sorted(curr, key=lambda x: x["fppg"], reverse=True)[:30]}

    for pid, cp in curr_map.items():
        if pid in prev_map:
            pp = prev_map[pid]
            if pp["team"] != cp["team"]:
                team_changes.append({
                    "name": cp["name"],
                    "from": pp["team"],
                    "to": cp["team"],
                    "fppg": cp["fppg"],
                    "is_star": pid in top20_prev or pid in top20_curr,
                    "is_top50": pid in top50_prev,
                })
        else:
            # New player in curr — rookie or returning
            if cp["fppg"] >= 28:
                rookies.append({"name": cp["name"], "team": cp["team"], "fppg": cp["fppg"]})

    # Breakouts: was in prev but outside top 100, now in top 30
    for pid in curr_top30:
        if pid in prev_map and pid not in prev_top100:
            cp = curr_map[pid]
            breakouts.append({"name": cp["name"], "team": cp["team"], "fppg": cp["fppg"]})

    # Retirements: was in prev top 200, gone from curr, age would be 34+
    prev_top200_ids = {p["id"] for p in sorted(prev, key=lambda x: x["fppg"], reverse=True)[:200]}
    for pid in prev_top200_ids:
        if pid not in curr_map:
            pp = prev_map[pid]
            if pp.get("age", 0) >= 33:
                retirements.append({"name": pp["name"], "team": pp["team"], "age": pp.get("age", 0), "fppg": pp["fppg"]})

    # Sort team changes: stars first
    team_changes.sort(key=lambda x: (-x["is_star"], -x["fppg"]))
    retirements.sort(key=lambda x: -x["fppg"])

    return {
        "team_changes": team_changes,
        "rookies": rookies,
        "breakouts": breakouts,
        "retirements": retirements,
    }


def build_facts_text(season_label: str, events: dict) -> str:
    lines = [f"NBA {season_label} 球季開始前的休賽期重大動態："]

    changes = events["team_changes"]
    if changes:
        lines.append("\n【球員轉隊】")
        for c in changes[:20]:
            star = "（頂級球星）" if c["is_star"] else ("（明星）" if c["is_top50"] else "")
            lines.append(f"- {c['name']}{star}：{team_zh(c['from'])} → {team_zh(c['to'])}，fppg={c['fppg']:.1f}")

    retires = events["retirements"]
    if retires:
        lines.append("\n【可能退役老將】")
        for r in retires[:5]:
            lines.append(f"- {r['name']}（{r['age']}歲，fppg={r['fppg']:.1f}）上季效力 {team_zh(r['team'])}")

    rookies = events["rookies"]
    if rookies:
        lines.append("\n【新秀/新面孔】")
        for rk in rookies[:5]:
            lines.append(f"- {rk['name']}（{team_zh(rk['team'])}，fppg={rk['fppg']:.1f}）")

    breakouts = events["breakouts"]
    if breakouts:
        lines.append("\n【突破性崛起】")
        for b in breakouts[:5]:
            lines.append(f"- {b['name']}（{team_zh(b['team'])}，fppg={b['fppg']:.1f}）")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Fallback: pure-Python mechanical headline generation (no API)
# ---------------------------------------------------------------------------
def mechanical_headlines(season_label: str, events: dict) -> list[str]:
    headlines: list[str] = []
    changes = events["team_changes"]
    retires = events["retirements"]
    rookies = events["rookies"]
    breakouts = events["breakouts"]

    # Up to 6 transfer headlines
    for c in changes[:6]:
        from_zh = team_zh(c["from"])
        to_zh = team_zh(c["to"])
        if c["is_star"]:
            headlines.append(f"{c['name']} 震撼轉會，從{from_zh}加盟{to_zh}")
        else:
            headlines.append(f"{c['name']} 離開{from_zh}，加入{to_zh}")

    # Retirement
    for r in retires[:2]:
        headlines.append(f"老將{r['name']}（{r['age']}歲）告別賽場，{season_label}球季謝幕")

    # Rookies
    for rk in rookies[:2]:
        headlines.append(f"新秀{rk['name']}加盟{team_zh(rk['team'])}，備受矚目")

    # Breakouts
    for b in breakouts[:1]:
        headlines.append(f"{b['name']} 強勢崛起，成為{team_zh(b['team'])}新核心")

    # Pad to 10
    generic = [
        f"{season_label} 球季各隊積極補強，爭冠格局成形",
        f"選秀會結束，各隊期待新血注入",
        f"自由球員市場風起雲湧，多支球隊大幅改變陣容",
        f"傷兵消息不斷，球迷引頸期盼健康回歸",
        f"NBA {season_label} 球季即將揭幕，競爭白熱化",
    ]
    for g in generic:
        if len(headlines) >= 10:
            break
        headlines.append(g)

    return headlines[:10]


# ---------------------------------------------------------------------------
# Claude Haiku API generation
# ---------------------------------------------------------------------------
def generate_with_claude(client, season_label: str, facts: str) -> list[str]:
    system_prompt = (
        "你是 NBA 歷史專家與運動記者。請根據提供的轉隊資料，"
        "撰寫 10 條精彩的繁體中文休賽期頭條新聞。"
        "要求：\n"
        "1. 每條頭條獨立一行，不加編號或符號前綴\n"
        "2. 用詞生動，符合台灣運動媒體風格\n"
        "3. 完全根據提供資料，不捏造統計數字\n"
        "4. 點名真實球員姓名與球隊\n"
        "5. 若資料中有頂級球星轉隊，必須優先撰寫\n"
        "6. 只輸出 10 條頭條，每條一行，無其他文字"
    )

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=600,
        system=system_prompt,
        messages=[
            {
                "role": "user",
                "content": facts,
            }
        ],
    )
    text = response.content[0].text.strip()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    # Keep only lines that look like headlines (not meta text)
    headlines = [ln for ln in lines if not ln.startswith("#")][:10]
    return headlines


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    # Try to set up Anthropic client
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    client = None
    if api_key:
        try:
            import anthropic
            client = anthropic.Anthropic(api_key=api_key)
            print("Using Claude Haiku for headline generation.")
        except ImportError:
            print("anthropic package not found; falling back to mechanical generation.")
    else:
        print("ANTHROPIC_API_KEY not set; falling back to mechanical generation.")

    season_files = sorted(SEASONS_DIR.glob("*.json"))
    if len(season_files) < 2:
        print("Not enough season files found.")
        sys.exit(1)

    failed: list[str] = []

    for i in range(1, len(season_files)):
        prev_path = season_files[i - 1]
        curr_path = season_files[i]
        season_label = curr_path.stem  # e.g. "1997-98"
        out_path = OUT_DIR / f"{season_label}.json"

        if out_path.exists():
            print(f"  [{season_label}] already exists, skipping.")
            continue

        print(f"  [{season_label}] generating...", end=" ", flush=True)
        try:
            prev = load_season(prev_path)
            curr = load_season(curr_path)
            events = detect_events(prev, curr)
            facts = build_facts_text(season_label, events)

            if client is not None:
                try:
                    headlines = generate_with_claude(client, season_label, facts)
                    # Ensure exactly 10
                    while len(headlines) < 10:
                        headlines.extend(mechanical_headlines(season_label, events))
                    headlines = headlines[:10]
                except Exception as e:
                    print(f"[API error: {e}] falling back...", end=" ", flush=True)
                    headlines = mechanical_headlines(season_label, events)
                # Small rate-limit pause
                time.sleep(0.5)
            else:
                headlines = mechanical_headlines(season_label, events)

            payload = {"season": season_label, "headlines": headlines}
            out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"OK ({len(headlines)} headlines)")
        except Exception as e:
            print(f"FAILED: {e}")
            failed.append(season_label)

    print("\n=== Done ===")
    created = sorted(OUT_DIR.glob("*.json"))
    print(f"Files created: {len(created)}")
    if failed:
        print(f"Failed seasons: {failed}")
    else:
        print("No failures.")

    # Sample output
    for sample in ["1997-98", "2010-11", "2025-26"]:
        p = OUT_DIR / f"{sample}.json"
        if p.exists():
            data = json.loads(p.read_text(encoding="utf-8"))
            print(f"\n--- {sample} sample headlines ---")
            for h in data["headlines"][:5]:
                print(f"  {h}")


if __name__ == "__main__":
    main()
