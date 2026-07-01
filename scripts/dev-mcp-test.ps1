# -----------------------------------------------------------------------------
# dev-mcp-test.ps1 — one-click setup for the local Chrome DevTools MCP smoke
# workflow documented in docs/desktop/10-local-mcp-testing.md.
#
# What it does (idempotent — safe to re-run):
#   1. Health-check the local API server on :3456 — fail with a hint if down.
#   2. Health-check the Vite dev server on :1420 — fail with a hint if down.
#   3. Confirm Vite's /api proxy is forwarding to :3456.
#   4. Ensure http://localhost:1420 is in H5 allowedOrigins.
#   5. Regenerate a fresh H5 access token.
#   6. Build the full ?serverUrl + ?forceH5=1 + ?h5Token=... URL.
#   7. Copy the URL to the clipboard and print it.
#   8. With -Open, also launch the default browser at that URL.
#
# This script does NOT start the server or Vite. Those are persistent dev
# processes, and starting them from a one-shot script makes lifecycle
# unclear. Start them yourself in two terminals first:
#
#   # terminal 1 (repo root)
#   $env:SERVER_PORT='3456'; bun run src/server/index.ts
#
#   # terminal 2 (desktop dir)
#   bun run dev
#
# Usage:
#   .\scripts\dev-mcp-test.ps1               # generate token, copy URL
#   .\scripts\dev-mcp-test.ps1 -Open         # also open in default browser
#   .\scripts\dev-mcp-test.ps1 -Quiet        # only print the URL (for piping)
# -----------------------------------------------------------------------------

[CmdletBinding()]
param(
  [switch]$Open,
  [switch]$Quiet,
  [string]$ServerOrigin = 'http://127.0.0.1:3456',
  [string]$ViteOrigin = 'http://localhost:1420'
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) {
  if (-not $Quiet) { Write-Host "==> $msg" -ForegroundColor Cyan }
}
function Write-Ok($msg) {
  if (-not $Quiet) { Write-Host "    OK $msg" -ForegroundColor Green }
}
function Write-Warn($msg) {
  if (-not $Quiet) { Write-Host "    !! $msg" -ForegroundColor Yellow }
}
function Fail($msg) {
  Write-Host "FAIL: $msg" -ForegroundColor Red
  exit 1
}

# 1. Server health
Write-Step "Checking API server at $ServerOrigin"
try {
  $health = Invoke-RestMethod -Uri "$ServerOrigin/health" -TimeoutSec 3 -UseBasicParsing
  if ($health.status -ne 'ok') { Fail "Server health endpoint returned: $($health | ConvertTo-Json -Compress)" }
  Write-Ok "$ServerOrigin/health -> ok"
} catch {
  Fail @"
Could not reach $ServerOrigin/health ($($_.Exception.Message)).
Start the API server in another terminal:
    `$env:SERVER_PORT='3456'; bun run src/server/index.ts
"@
}

# 2. Vite health
Write-Step "Checking Vite dev server at $ViteOrigin"
try {
  $viteRoot = Invoke-WebRequest -Uri "$ViteOrigin/" -TimeoutSec 3 -UseBasicParsing
  if ($viteRoot.StatusCode -ne 200) { Fail "Vite root returned HTTP $($viteRoot.StatusCode)" }
  Write-Ok "$ViteOrigin/ -> 200"
} catch {
  Fail @"
Could not reach $ViteOrigin/ ($($_.Exception.Message)).
Start the desktop dev server in another terminal:
    cd desktop
    bun run dev
"@
}

# 3. Vite proxy is wired (the dev-only `/health` proxy entry)
Write-Step "Checking Vite -> server proxy"
try {
  $proxied = Invoke-RestMethod -Uri "$ViteOrigin/health" -TimeoutSec 3 -UseBasicParsing
  if ($proxied.status -ne 'ok') { Fail "Vite /health proxy returned: $($proxied | ConvertTo-Json -Compress)" }
  Write-Ok "$ViteOrigin/health -> ok (proxied)"
} catch {
  Fail @"
$ViteOrigin/health did not proxy to the server ($($_.Exception.Message)).
Confirm desktop/vite.config.ts has the dev-only proxy block (see
docs/desktop/10-local-mcp-testing.md step 1).
"@
}

# 4. Allowed origins includes our Vite origin
Write-Step "Ensuring $ViteOrigin is an allowed H5 origin"
$current = Invoke-RestMethod -Uri "$ServerOrigin/api/h5-access" -UseBasicParsing
$origins = @()
if ($current.settings -and $current.settings.allowedOrigins) {
  $origins = @($current.settings.allowedOrigins)
}
if ($origins -notcontains $ViteOrigin) {
  $origins = @($origins) + $ViteOrigin
  $body = @{ allowedOrigins = $origins } | ConvertTo-Json -Compress
  $null = Invoke-WebRequest -Method PUT -Uri "$ServerOrigin/api/h5-access" `
    -ContentType 'application/json' -Body $body -UseBasicParsing
  Write-Ok "Added $ViteOrigin to allowedOrigins"
} else {
  Write-Ok "$ViteOrigin already in allowedOrigins"
}

# 5. Regenerate token
Write-Step "Regenerating H5 access token"
$resp = Invoke-RestMethod -Method POST -Uri "$ServerOrigin/api/h5-access/regenerate" -UseBasicParsing
$token = $resp.token
if (-not $token) { Fail "Regenerate response had no token: $($resp | ConvertTo-Json -Compress)" }
Write-Ok "token issued: $($token.Substring(0,8))...$($token.Substring($token.Length-4))"

# 6. Build URL
$encodedServerUrl = [uri]::EscapeDataString($ViteOrigin)
$url = "$ViteOrigin/?serverUrl=$encodedServerUrl&forceH5=1&h5Token=$token"

# 7. Clipboard + print
try {
  Set-Clipboard -Value $url
  $copied = $true
} catch {
  $copied = $false
}

if ($Quiet) {
  Write-Output $url
} else {
  Write-Host ""
  Write-Host "Open this URL in Chrome (already on clipboard):" -ForegroundColor Cyan
  Write-Host "  $url" -ForegroundColor White
  if (-not $copied) { Write-Warn "could not copy to clipboard (Set-Clipboard failed)" }
}

# 8. Optional auto-open
if ($Open) {
  Write-Step "Opening in default browser"
  Start-Process $url | Out-Null
}
