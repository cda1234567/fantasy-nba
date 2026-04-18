# Fantasy NBA Draft Simulator

8-team snake draft with 7 AI GM personas. Full season simulation with H2H matchups, standings, and Claude-powered GM decisions.

Production: https://nbafantasy.cda1234567.com

## Scoring

PTS x1.0, REB x1.2, AST x1.5, STL x2.5, BLK x2.5, TO x-1.0. FPPG drives the draft.

## Local Development

### With Docker (recommended)

```powershell
# Start (builds image, mounts data volume)
./tools/docker_localserver.ps1 up

# Other commands
./tools/docker_localserver.ps1 logs
./tools/docker_localserver.ps1 restart
./tools/docker_localserver.ps1 down
```

App available at http://127.0.0.1:3410

### Without Docker

```powershell
uv sync
uv run uvicorn app.main:app --reload --port 3410
```

## Environment Variables

Copy `.env.example` to `.env.localserver` and fill in:

| Variable | Default | Description |
|---|---|---|
| `APP_PORT` | `3410` | Port the app listens on |
| `LEAGUE_ID` | `default` | League namespace for saved data |
| `ANTHROPIC_API_KEY` | _(blank)_ | Enables Claude AI GM decisions (falls back to heuristic if unset) |

## Data Persistence

League state is saved to `./data/leagues/{league_id}/` as JSON files. The `data/` directory is volume-mounted so state survives container restarts.

## Stack

FastAPI + vanilla JS/CSS. ~165 players seeded.

## Deployment

See `deploy/ORACLE_DEPLOY.md` for full Oracle Cloud deployment instructions.

CI: push to `main` → GitHub Actions builds `ghcr.io/cda1234567/fantasy-nba:latest`. Deploy manually on Oracle:

```bash
ssh oracle "cd ~/fantasy && docker compose -f docker-compose.server.yml pull && docker compose -f docker-compose.server.yml up -d"
```
