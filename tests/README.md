# Fantasy NBA — Playwright Season Runner

Plays the Fantasy NBA app as a human for N full seasons and produces a metrics
report (`tests/run_report.json`).

## Prerequisites

| Requirement | Details |
|---|---|
| Docker container | `fantasy-nba-local` running and bound to `127.0.0.1:3410` |
| Python 3.12+ | Via `uv` — no system install needed |
| Network access (first run) | `playwright install chromium` downloads ~170 MB |

## Setup

```bash
# 1. Install Python dependencies (including dev group)
uv sync --dev

# 2. Install the Chromium browser used by Playwright
uv run playwright install chromium
```

## Running

```bash
# Play 3 seasons (default)
uv run python tests/play_season.py --seasons 3

# Custom number of seasons or app URL
uv run python tests/play_season.py --seasons 1 --base-url http://127.0.0.1:3410
```

The browser opens in headed mode (`headless=False`) so you can watch it play.
Expected runtime: **5–15 minutes** for 3 seasons (depends on AI GM call budget).

## Output

| Path | Description |
|---|---|
| `tests/run_report.json` | JSON report with per-season metrics |
| `tests/screenshots/s1_start.png` | Season 1 start screenshot |
| `tests/screenshots/s1_w01.png` | Season 1 after week 1 |
| `tests/screenshots/s1_end.png` | Season 1 final standings |
| … | (same pattern for each season) |

### Report shape

```json
{
  "runs": [
    {
      "season": 1,
      "trades_executed": 12,
      "trades_vetoed": 1,
      "trades_rejected": 3,
      "trades_expired": 5,
      "ai_to_ai_trades": 10,
      "human_trades": 2,
      "champion": 3,
      "champion_name": "Team Baller",
      "issues": []
    }
  ]
}
```

> **Note:** Trade counters require Wave D (trade system routes) to be deployed.
> If those endpoints are absent the script continues normally and logs a note
> in `issues[]`.

## How it works

The script uses a **hybrid approach**:

- **API calls** (`httpx`) for the draft, season advancement, and trade actions —
  fast and reliable even when UI panels are mid-development.
- **Playwright** for browser navigation, weekly screenshots, and optionally
  clicking the "Advance Day" button when it's present in the UI.

The human team always drafts the best available player by FPPG.  Incoming
trade offers are accepted if the received value is ≥ 90 % of the sent value;
lopsided AI-to-AI trades (ratio ≥ 1.35×) may be vetoed.
