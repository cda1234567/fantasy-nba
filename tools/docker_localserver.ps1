param([string]$cmd = "up")
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..
switch ($cmd) {
  "up"      { docker compose --env-file .env.localserver -f docker-compose.localserver.yml up -d --build }
  "down"    { docker compose --env-file .env.localserver -f docker-compose.localserver.yml down }
  "restart" { docker compose --env-file .env.localserver -f docker-compose.localserver.yml up -d --force-recreate --build }
  "logs"    { docker compose --env-file .env.localserver -f docker-compose.localserver.yml logs -f }
  "build"   { docker compose --env-file .env.localserver -f docker-compose.localserver.yml build }
  default   { Write-Host "Usage: docker_localserver.ps1 [up|down|restart|logs|build]"; exit 1 }
}
