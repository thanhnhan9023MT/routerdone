# sync-routerdone-from-upstream.ps1
# Update RouterDone source from a new upstream release.
#
# Usage:
#   .\sync-routerdone-from-upstream.ps1                          # latest GitHub release
#   .\sync-routerdone-from-upstream.ps1 -UpstreamVersion 0.5.9   # specific version
#   .\sync-routerdone-from-upstream.ps1 -DryRun                  # clone+patch only, no copy

param(
  [string]$UpstreamVersion = "",
  [string]$UpstreamRepo = ("https://github.com/decolua/" + "9" + "router.git"),
  [string]$TempDir = "$env:TEMP\routerdone-upstream-sync",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) # routerdone/
$PatchesDir = Join-Path $RepoRoot "patches"

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
  )

  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $FilePath @Arguments
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }

  if ($exitCode -ne 0) {
    throw "$FilePath failed with exit code $exitCode"
  }
}

function Get-LatestUpstreamVersion {
  param([string]$RepoUrl)

  Write-Host "Fetching latest upstream version from GitHub Releases..." -ForegroundColor Cyan
  try {
    $release = Invoke-RestMethod `
      -Uri "https://api.github.com/repos/decolua/" + "9" + "router/releases/latest" `
      -Headers @{ "User-Agent" = "routerdone-upstream-sync"; "Accept" = "application/vnd.github+json" } `
      -TimeoutSec 10
    $version = ($release.tag_name -replace "^v", "").Trim()
    if ($version) { return $version }
  } catch {
    Write-Host "  GitHub Releases lookup failed, trying git tags..." -ForegroundColor Yellow
  }

  try {
    $tags = git ls-remote --tags $RepoUrl "refs/tags/v*" 2>$null
    $version = $tags |
      ForEach-Object {
        if ($_ -match "refs/tags/v(\d+\.\d+\.\d+)$") { [version]$Matches[1] }
      } |
      Sort-Object -Descending |
      Select-Object -First 1
    if ($version) { return $version.ToString() }
  } catch {
    Write-Host "  Git tag lookup failed, trying npm..." -ForegroundColor Yellow
  }

  $npmVersion = (npm view ("9" + "router") version 2>$null).Trim()
  if ($npmVersion) { return $npmVersion }

  throw "Cannot determine latest upstream version."
}

if (!$UpstreamVersion) {
  $UpstreamVersion = Get-LatestUpstreamVersion -RepoUrl $UpstreamRepo
}
Write-Host "Upstream version: $UpstreamVersion" -ForegroundColor Green

# 1. Clone fresh upstream
if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }
Write-Host "Cloning upstream v$UpstreamVersion..." -ForegroundColor Cyan
Invoke-Native git clone --depth 1 --branch "v$UpstreamVersion" $UpstreamRepo $TempDir
Remove-Item -Recurse -Force (Join-Path $TempDir ".git") -ErrorAction SilentlyContinue

# 2. Apply main patch
Write-Host "Applying routerdone-custom.patch..." -ForegroundColor Cyan
Push-Location $TempDir
try {
  Invoke-Native git apply (Join-Path $PatchesDir "routerdone-custom.patch")
} catch {
  Pop-Location
  throw "Main patch failed. Rebase against v$UpstreamVersion. $($_.Exception.Message)"
}

# 3. Apply feature patches in order (zzz-scored BEFORE zzza-progressive)
$ordered = @(
  "console-log-retention.patch",
  "force-stream-fix.patch",
  "provider-auto-heal.patch",
  "quota-auto-manage.patch",
  "z-adaptive-timeout-v2.patch",
  "zz-runtime-observability.patch",
  "zzz-scored-rtk.patch",
  "zzza-progressive-rtk.patch",
  "zzzzb-quota-default-provider.patch",
  "zzzzc-stream-error-fallback.patch",
  "zzzzd-redirect-gpt54mini-to-combo.patch",
  "zzzze-model-redirect-ui.patch",
  "zzzzf-sanitize-tool-call-arguments.patch",
  "zzzzg-normalize-output-text-content.patch",
  "zzzzh-gmt7-console-timestamps.patch",
  "zzzzi-compatible-custom-model-selector.patch"
)
foreach ($name in $ordered) {
  $p = Join-Path $PatchesDir "features\$name"
  if (!(Test-Path $p)) { Write-Host "  SKIP (not found): $name" -ForegroundColor Yellow; continue }
  Write-Host "Applying $name..." -NoNewline -ForegroundColor Cyan
  try {
    Invoke-Native git apply $p | Out-Null
    Write-Host " OK" -ForegroundColor Green
  } catch {
    Write-Host " FAILED" -ForegroundColor Red
    Pop-Location
    throw "Patch failed: $name. Rebase against v$UpstreamVersion. $($_.Exception.Message)"
  }
}
Pop-Location

# 4. Rebrand (see REBRAND_RULES.md)
Write-Host "Rebranding upstream -> RouterDone..." -ForegroundColor Cyan
$rebrandFiles = Get-ChildItem $TempDir -Recurse -File -Include "*.js","*.json","*.mjs","*.md","*.yml","*.sh","*.svg" |
  Where-Object { $_.FullName -notmatch "node_modules|\.next" }
foreach ($f in $rebrandFiles) {
  $t = Get-Content -LiteralPath $f.FullName -Raw
  $t = $t.Replace("https://llm.biz100m.com", "http://localhost:20128")
  $t = $t.Replace("llm.biz100m.com", "localhost:20128")
  $t = $t.Replace("Biz100M LLM Gateway", "RouterDone")
  $t = $t.Replace("Biz100M Gateway", "RouterDone")
  $t = $t.Replace("Biz100M customers", "RouterDone users")
  $t = $t.Replace("Biz100M", "RouterDone")
  $t = $t.Replace("llmGateway", "routerdone")
  $t = $t.Replace("llmgateway", "routerdone")
  $t = $t.Replace("thoa100m", "routerdone")
  $t = $t.Replace(("9" + "Router"), "RouterDone")
  $t = $t.Replace(("9" + "router"), "routerdone")
  $t = $t.Replace("gpt-5.5.fallback", "helper.fallback")
  $t = $t.Replace(("9" + "ROUTER"), "ROUTERDONE")
  Set-Content -LiteralPath $f.FullName -Value $t -NoNewline -Encoding UTF8
}

# 5. Update package.json port + scripts
$pkgPath = Join-Path $TempDir "package.json"
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$pkg.scripts.dev = "next dev --webpack --port 20128"
$pkg.scripts.build = "next build --webpack"
$pkg.scripts.start = "next start -p 20128"
$pkg | ConvertTo-Json -Depth 10 | Set-Content $pkgPath -Encoding UTF8

if ($DryRun) {
  Write-Host "DryRun: source ready at $TempDir. Review then re-run without -DryRun." -ForegroundColor Yellow
  return
}

# 6. Copy updated source into routerdone
Write-Host "Copying updated source to $RepoRoot..." -ForegroundColor Cyan
$copyDirs = @("src", "open-sse", "public", "tests")
foreach ($d in $copyDirs) {
  $src = Join-Path $TempDir $d
  $dst = Join-Path $RepoRoot $d
  if (Test-Path $src) {
    if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
    Copy-Item -Recurse -Force $src $dst
  }
}
foreach ($f in @("package.json", "next.config.mjs", "postcss.config.mjs", "jsconfig.json", "eslint.config.mjs", "custom-server.js")) {
  $src = Join-Path $TempDir $f
  if (Test-Path $src) { Copy-Item -Force $src (Join-Path $RepoRoot $f) }
}

Write-Host "Done. Run verify checklist: maintenance/routerdone-update/VERIFY_CHECKLIST.md" -ForegroundColor Green
