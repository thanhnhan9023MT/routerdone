# RouterDone one-line installer for Windows (PowerShell).
# Usage:
#   irm https://raw.githubusercontent.com/thoa100m/routerdone/main/install.ps1 | iex
#
# Optional env before running:
#   $env:PORT="20128"; $env:DIR="routerdone"; $env:INITIAL_PASSWORD="..."

$ErrorActionPreference = "Stop"
$Repo = "https://github.com/thoa100m/routerdone.git"
$Dir  = if ($env:DIR) { $env:DIR } else { "routerdone" }
$RequestedPort = if ($env:PORT) { $env:PORT } else { "20128" }
$Port = $RequestedPort

function Say($m) { Write-Host "[routerdone] $m" -ForegroundColor Cyan }
function Die($m) { Write-Host "[routerdone] $m" -ForegroundColor Red; exit 1 }
function Parse-Port($value) {
  $parsed = 0
  if (-not [int]::TryParse([string]$value, [ref]$parsed) -or $parsed -lt 1 -or $parsed -gt 65535) {
    Die "Invalid PORT '$value'. Use a number from 1 to 65535."
  }
  return $parsed
}
function Get-PortOwnerHint($portNumber) {
  if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { return $null }
  $items = Get-NetTCPConnection -LocalPort $portNumber -State Listen -ErrorAction SilentlyContinue | Select-Object -First 3
  if (-not $items) { return $null }
  $hints = foreach ($item in $items) {
    $process = Get-Process -Id $item.OwningProcess -ErrorAction SilentlyContinue
    if ($process) { "$($process.ProcessName) (PID $($item.OwningProcess))" } else { "PID $($item.OwningProcess)" }
  }
  return ($hints -join ", ")
}
function Test-CurrentComposeServiceRunning {
  $containerIds = docker compose ps -q routerdone 2>$null
  if (-not $containerIds) { return $false }
  foreach ($containerId in $containerIds) {
    $isRunning = docker inspect --format '{{.State.Running}}' $containerId 2>$null
    if ($isRunning -eq "true") { return $true }
  }
  return $false
}
function Assert-PortFree($portNumber, $allowCurrentComposeService) {
  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $portNumber)
    $listener.Start()
  } catch {
    if ($allowCurrentComposeService) {
      Say "Port $portNumber is already used by the current RouterDone container; continuing update."
      return
    }
    $owner = Get-PortOwnerHint $portNumber
    $hint = if ($owner) { " Current listener: $owner." } else { "" }
    Die "Port $portNumber is already in use.$hint Stop that process or run: `$env:PORT='20130'; irm https://raw.githubusercontent.com/thoa100m/routerdone/main/install.ps1 | iex"
  } finally {
    if ($listener) { $listener.Stop() }
  }
}
function Set-DotEnvValue($path, $key, $value) {
  $lines = Get-Content $path
  $found = $false
  $next = foreach ($line in $lines) {
    if ($line -match "^$([regex]::Escape($key))=") {
      $found = $true
      "$key=$value"
    } else {
      $line
    }
  }
  if (-not $found) { $next += "$key=$value" }
  $next | Set-Content -Path $path -Encoding ascii
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die "git is required." }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Die "Docker Desktop is required." }
docker compose version *> $null; if ($LASTEXITCODE -ne 0) { Die "docker compose v2 is required." }
docker info *> $null; if ($LASTEXITCODE -ne 0) { Die "Docker engine is not running. Start Docker Desktop, wait until it says Docker is running, then rerun this installer." }

function Rand32 { -join ((1..32) | ForEach-Object { "{0:x2}" -f (Get-Random -Max 256) }) }

if (Test-Path "$Dir\.git") {
  Say "Updating existing clone in $Dir"
  git -C $Dir pull --ff-only
} else {
  Say "Cloning into $Dir"
  git clone --depth 1 $Repo $Dir
}
Set-Location $Dir

$envPortWasSet = [bool]$env:PORT
if ((-not $envPortWasSet) -and (Test-Path ".env")) {
  $envPortLine = Get-Content ".env" | Select-String '^PORT=' | Select-Object -First 1
  if ($envPortLine) { $Port = $envPortLine.Line.Split('=',2)[1].Trim() }
}
$PortNumber = Parse-Port $Port
$Port = [string]$PortNumber
$allowCurrentComposeService = Test-CurrentComposeServiceRunning
Assert-PortFree $PortNumber $allowCurrentComposeService

$printPw = $false
if (-not (Test-Path ".env")) {
  Say "Generating .env with fresh secrets"
  $adminPw = if ($env:INITIAL_PASSWORD) { $env:INITIAL_PASSWORD } else { (Rand32).Substring(0,24) }
  @"
JWT_SECRET=$(Rand32)
INITIAL_PASSWORD=$adminPw
API_KEY_SECRET=$(Rand32)
MACHINE_ID_SALT=$(Rand32)
PORT=$Port
NODE_ENV=production
TZ=UTC
DATA_DIR=/app/data
BASE_URL=http://localhost:$Port
NEXT_PUBLIC_BASE_URL=http://localhost:$Port
AUTH_COOKIE_SECURE=false
REQUIRE_API_KEY=false
ENABLE_REQUEST_LOGS=false
OBSERVABILITY_ENABLED=true
"@ | Set-Content -Path ".env" -Encoding ascii
  $printPw = $true
} else {
  Say ".env already exists, keeping it"
  if ($envPortWasSet) {
    Say "Updating .env URL fields to PORT=$Port"
    Set-DotEnvValue ".env" "PORT" $Port
    Set-DotEnvValue ".env" "BASE_URL" "http://localhost:$Port"
    Set-DotEnvValue ".env" "NEXT_PUBLIC_BASE_URL" "http://localhost:$Port"
  }
}

Say "Building and starting (first run may take a few minutes)"
$env:PORT = $Port
docker compose up --build -d
if ($LASTEXITCODE -ne 0) { Die "docker compose failed. Inspect: docker compose logs -f" }

Say "Waiting for health..."
for ($i = 0; $i -lt 60; $i++) {
  try {
    Invoke-WebRequest -UseBasicParsing "http://localhost:$Port/api/health" *> $null
    Say "RouterDone is up at http://localhost:$Port"
    if ($printPw) { Say "Admin password: $((Get-Content .env | Select-String '^INITIAL_PASSWORD=').Line.Split('=',2)[1])" }
    exit 0
  } catch { Start-Sleep -Seconds 3 }
}
Die "Health check timed out. Inspect logs: docker compose logs -f"
