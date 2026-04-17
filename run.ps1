$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
uv sync
uv run uvicorn app.main:app --host 127.0.0.1 --port 8770
