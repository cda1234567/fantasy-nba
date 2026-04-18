#Requires -Version 5.1
<#
.SYNOPSIS
    Push + deploy fantasy-nba to Oracle VM.
.DESCRIPTION
    1. git push (if there are commits ahead of origin)
    2. Wait for GitHub Actions build to go green
    3. ssh to Oracle, pull new image, recreate container
    4. Verify /api/health returns the APP_VERSION from app/main.py
.EXAMPLE
    ./deploy/push.ps1
    ./deploy/push.ps1 -SkipPush   # skip git push, just deploy latest :latest
#>

param(
    [switch]$SkipPush,
    [string]$SshTarget = "ubuntu@168.138.203.245",
    [string]$SshKey = "$env:USERPROFILE\.ssh\oracle_vm.key",
    [string]$RemoteDir = "~/fantasy",
    [string]$HealthUrl = "https://nbafantasy.cda1234567.com/api/health",
    [int]$CiTimeoutSec = 600
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "!!  $msg" -ForegroundColor Red; exit 1 }

# --- Read expected version from app/main.py ---
$mainPy = Get-Content "app/main.py" -Raw
if ($mainPy -match 'APP_VERSION\s*=\s*"([^"]+)"') {
    $expectedVersion = $Matches[1]
} else {
    Die "Cannot find APP_VERSION in app/main.py"
}
Step "Target version: $expectedVersion"

# --- Push ---
if (-not $SkipPush) {
    Step "git push"
    $ahead = git rev-list --count "@{u}..HEAD" 2>$null
    if (-not $ahead -or $ahead -eq "0") {
        Warn "No commits ahead of origin; skipping push"
    } else {
        git push
        if ($LASTEXITCODE -ne 0) { Die "git push failed" }
        Ok "Pushed $ahead commit(s)"
    }
}

# --- Wait for CI ---
Step "Wait for GitHub Actions (timeout ${CiTimeoutSec}s)"
$sha = (git rev-parse HEAD).Trim()
$deadline = (Get-Date).AddSeconds($CiTimeoutSec)
$ciOk = $false
while ((Get-Date) -lt $deadline) {
    $json = gh run list --commit $sha --limit 1 --json status,conclusion,name 2>$null | ConvertFrom-Json
    if ($json -and $json.Count -gt 0) {
        $run = $json[0]
        if ($run.status -eq "completed") {
            if ($run.conclusion -eq "success") { $ciOk = $true; break }
            Die "CI finished with conclusion=$($run.conclusion)"
        }
        Write-Host "    status=$($run.status) ..." -ForegroundColor DarkGray
    }
    Start-Sleep -Seconds 10
}
if (-not $ciOk) { Die "CI timeout after ${CiTimeoutSec}s" }
Ok "CI green"

# --- Deploy ---
if (-not (Test-Path $SshKey)) { Die "SSH key not found: $SshKey" }
Step "Deploy on $SshTarget (key=$(Split-Path $SshKey -Leaf))"
$deployCmd = "cd $RemoteDir && docker compose -f docker-compose.server.yml pull && docker compose -f docker-compose.server.yml up -d"
ssh -i $SshKey $SshTarget $deployCmd
if ($LASTEXITCODE -ne 0) { Die "Remote deploy failed" }
Ok "Container recreated"

# --- Verify ---
Step "Verify $HealthUrl"
$attempts = 0
$maxAttempts = 12
while ($attempts -lt $maxAttempts) {
    Start-Sleep -Seconds 5
    try {
        $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 10
        if ($health.version -eq $expectedVersion) {
            Ok "Health OK: version=$($health.version) league=$($health.league_id)"
            exit 0
        }
        Write-Host "    got version=$($health.version), expected $expectedVersion ..." -ForegroundColor DarkGray
    } catch {
        Write-Host "    health probe failed: $_" -ForegroundColor DarkGray
    }
    $attempts++
}
Die "Version did not flip to $expectedVersion within $($maxAttempts * 5)s"
