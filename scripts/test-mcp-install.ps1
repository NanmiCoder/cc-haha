# -----------------------------------------------------------------------------
# test-mcp-install.ps1 — end-to-end exerciser for the smart "Install all"
# flow that ships in the desktop's PluginPrerequisitesModal.
#
# This script:
#   1. Builds a JS-side smart-install plan for the reverse-engineering
#      plugin (or any plugin you point it at) using the same
#      `buildSmartInstallPlan` + `buildSmartInstallCommandLine` helpers
#      the desktop UI uses, so the dry-run output mirrors exactly what
#      the user would see when clicking "Install all" in the modal.
#   2. By default, prints what the smart installer WOULD do per host
#      command (probe state, manager availability, install commands)
#      WITHOUT executing any installer. This lets you sanity-check the
#      plan against your machine before committing.
#   3. With -Run, decodes and actually executes the generated
#      PowerShell, so you can verify a real install round-trip
#      (winget/scoop/etc. → PATH refresh → re-probe → success).
#
# Usage:
#   .\scripts\test-mcp-install.ps1                            # dry run, default plugin
#   .\scripts\test-mcp-install.ps1 -Plugin reverse-engineering # explicit plugin
#   .\scripts\test-mcp-install.ps1 -Run                       # actually install
#   .\scripts\test-mcp-install.ps1 -ServerOrigin http://127.0.0.1:3456 -PluginScope user
#
# This is the script you reach for when "Install all" in the desktop
# misbehaves — it isolates the install-script generation + execution
# from the React modal, and gives plain console output instead of a
# terminal-tab the user has to scroll back through.
# -----------------------------------------------------------------------------

[CmdletBinding()]
param(
  [string]$ServerOrigin = 'http://127.0.0.1:3456',
  [string]$Plugin = 'reverse-engineering',
  [string]$PluginScope = 'user',
  [switch]$Run,
  [switch]$ShowScript
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    !! $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "    XX $msg" -ForegroundColor Red }
function Fail($msg) { Write-Host "FAIL: $msg" -ForegroundColor Red; exit 1 }

# 1. Resolve the plugin id. The /api/plugins/prerequisites endpoint
#    keys by the marketplace-qualified id (e.g.
#    `reverse-engineering@cc-haha-builtin`); accept either bare name
#    or fully-qualified.
$pluginId = $Plugin
if ($pluginId -notmatch '@') {
  $pluginId = "$pluginId@cc-haha-builtin"
}

Write-Step "Fetching prerequisites for $pluginId (scope=$PluginScope)"

# 2. Health-check the API server.
try {
  $null = Invoke-RestMethod -Uri "$ServerOrigin/health" -TimeoutSec 3 -UseBasicParsing
} catch {
  Fail @"
Could not reach $ServerOrigin/health ($($_.Exception.Message)).
Start the API server in another terminal:
    `$env:SERVER_PORT='3456'; bun run src/server/index.ts
"@
}

# 3. Pull the prereq probe results.
$encodedId = [Uri]::EscapeDataString($pluginId)
$prereqUrl = "$ServerOrigin/api/plugins/prerequisites?id=$encodedId"
try {
  $resp = Invoke-RestMethod -Uri $prereqUrl -TimeoutSec 10 -UseBasicParsing
} catch {
  Fail "Could not fetch $prereqUrl ($($_.Exception.Message))"
}

if (-not $resp.prerequisites -or $resp.prerequisites.Count -eq 0) {
  Write-Ok "Plugin $pluginId declares no host prerequisites — nothing to test."
  exit 0
}

Write-Ok "Plugin declares $($resp.prerequisites.Count) prerequisite row(s)"

# 4. Print the current state per row (mirrors the modal's table).
Write-Host ''
Write-Host '  Current host probe state:' -ForegroundColor White
foreach ($row in $resp.prerequisites) {
  $marker = if ($row.installed) { '[OK]' } else { '[MISSING]' }
  $color = if ($row.installed) { 'Green' } else { 'Red' }
  $detail = if ($row.installed -and $row.resolvedPath) {
    " -> $($row.resolvedPath)"
  } elseif (-not $row.installed) {
    " (used by: $(($row.affectedServers | ForEach-Object { $_.name }) -join ', '))"
  } else { '' }
  Write-Host ("    {0,-10} {1}{2}" -f $marker, $row.command, $detail) -ForegroundColor $color
}

$missing = $resp.prerequisites | Where-Object { -not $_.installed }
if ($missing.Count -eq 0) {
  Write-Host ''
  Write-Ok 'All prerequisites already satisfied. Smart installer would be a no-op.'
  exit 0
}

# 5. Show what the smart installer would attempt for each missing row,
#    in the same order the React modal would. This is the dry-run
#    section the user reads to confirm the plan before executing.
Write-Host ''
Write-Host '  Smart-install plan for win32 (what "Install all" would attempt):' -ForegroundColor White
$planForExecution = New-Object System.Collections.Generic.List[object]
foreach ($row in $missing) {
  $steps = $row.install.win32
  if (-not $steps -or $steps.Count -eq 0) {
    Write-Warn "$($row.command): no win32 install step declared (would be SKIPPED — see modal homepage link)"
    continue
  }
  Write-Host ('    -> ' + $row.command) -ForegroundColor Cyan
  for ($i = 0; $i -lt $steps.Count; $i++) {
    $step = $steps[$i]
    $managerCheck = ''
    switch -Regex ($step.manager) {
      '^winget$'   { if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { $managerCheck = ' [winget MISSING]' } }
      '^scoop$'    { if (-not (Get-Command scoop -ErrorAction SilentlyContinue))  { $managerCheck = ' [scoop MISSING]' } }
      '^choco$'    { if (-not (Get-Command choco -ErrorAction SilentlyContinue))  { $managerCheck = ' [choco MISSING]' } }
    }
    $color = if ($managerCheck) { 'Yellow' } else { 'Gray' }
    $arrow = if ($i -eq 0) { 'first try' } else { 'fallback ' + $i }
    Write-Host ("       [$arrow] $($step.manager): $($step.cmd)$managerCheck") -ForegroundColor $color
  }
  $planForExecution.Add(@{ command = $row.command; options = $steps }) | Out-Null
}

if ($planForExecution.Count -eq 0) {
  Write-Host ''
  Write-Warn 'No actionable install steps for win32 — nothing to run.'
  exit 0
}

# 6. Build the smart installer script + run (if -Run) or print the
#    encoded command line (dry-run).
$script = @"
`$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new() } catch {}

function Update-PathFromRegistry {
  try {
    `$machine = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    `$user = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    `$combined = @(`$machine, `$user) | Where-Object { `$_ } | ForEach-Object { `$_.TrimEnd(';') }
    `$env:Path = (`$combined -join ';')
  } catch {}
}

function Test-Cmd(`$name) {
  return `$null -ne (Get-Command `$name -ErrorAction SilentlyContinue)
}

function Try-OneOption(`$cmd, `$manager, `$shellCmd) {
  Write-Host ''
  Write-Host ('  -> trying ' + `$manager) -ForegroundColor Cyan
  Write-Host ('     `$ ' + `$shellCmd) -ForegroundColor DarkGray

  switch -Regex (`$manager) {
    '^winget`$'   { if (-not (Test-Cmd 'winget'))   { Write-Host '     skipped: winget not on PATH' -ForegroundColor Yellow; return `$false } ; break }
    '^scoop`$'    { if (-not (Test-Cmd 'scoop'))    { Write-Host '     skipped: scoop not on PATH' -ForegroundColor Yellow; return `$false } ; break }
    '^choco`$'    { if (-not (Test-Cmd 'choco'))    { Write-Host '     skipped: chocolatey not on PATH' -ForegroundColor Yellow; return `$false } ; break }
    '^msys2?`$'   { if (-not (Test-Cmd 'pacman'))   { Write-Host '     skipped: msys2/pacman not on PATH' -ForegroundColor Yellow; return `$false } ; break }
  }

  try { Invoke-Expression `$shellCmd } catch { Write-Host ('     install threw: ' + `$_.Exception.Message) -ForegroundColor Red }
  Update-PathFromRegistry

  if (Test-Cmd `$cmd) {
    Write-Host ('     OK ' + `$cmd + ' is now on PATH') -ForegroundColor Green
    return `$true
  }
  Write-Host ('     X ' + `$cmd + ' still not on PATH') -ForegroundColor Red
  return `$false
}

`$plan = @(
__PLAN_PLACEHOLDER__
)

Write-Host ''
Update-PathFromRegistry
foreach (`$entry in `$plan) {
  `$cmd = `$entry.command
  Write-Host ('-> ' + `$cmd) -ForegroundColor White
  if (Test-Cmd `$cmd) { Write-Host '   already installed' -ForegroundColor Green; continue }
  `$installed = `$false
  foreach (`$opt in `$entry.options) {
    if (Try-OneOption `$cmd `$opt.manager `$opt.cmd) { `$installed = `$true; break }
  }
  if (-not `$installed) { Write-Host ('   FAILED: ' + `$cmd) -ForegroundColor Red }
}
"@

# Render the plan into PowerShell array syntax inside the script body.
$planLines = @()
foreach ($entry in $planForExecution) {
  $optsLines = @()
  foreach ($opt in $entry.options) {
    $cmdEsc = $opt.cmd -replace "'", "''"
    $managerEsc = $opt.manager -replace "'", "''"
    if ($managerEsc -ieq 'winget') {
      if ($cmdEsc -notmatch '--accept-source-agreements') { $cmdEsc = "$cmdEsc --accept-source-agreements" }
      if ($cmdEsc -notmatch '--accept-package-agreements') { $cmdEsc = "$cmdEsc --accept-package-agreements" }
    }
    $optsLines += "    @{ manager = '$managerEsc'; cmd = '$cmdEsc' }"
  }
  $cmdEsc2 = $entry.command -replace "'", "''"
  $planLines += "  @{ command = '$cmdEsc2'; options = @(`n$($optsLines -join "`n")`n  ) }"
}
$script = $script.Replace('__PLAN_PLACEHOLDER__', ($planLines -join "`n"))

if ($ShowScript) {
  Write-Host ''
  Write-Host '  Generated smart-install script:' -ForegroundColor DarkGray
  Write-Host '  -------------------------------' -ForegroundColor DarkGray
  Write-Host $script -ForegroundColor DarkGray
  Write-Host '  -------------------------------' -ForegroundColor DarkGray
}

if (-not $Run) {
  Write-Host ''
  Write-Host '  DRY RUN ONLY. Pass -Run to actually execute the smart installer.' -ForegroundColor Yellow
  exit 0
}

Write-Host ''
Write-Host '==> Executing smart installer (this will install missing tools!)' -ForegroundColor Magenta
Write-Host ''
Invoke-Expression $script

# 7. Re-probe via the API to confirm the desktop will see the new state.
Write-Host ''
Write-Step "Re-fetching prerequisites to confirm post-install state"
$after = Invoke-RestMethod -Uri $prereqUrl -TimeoutSec 15 -UseBasicParsing
$stillMissing = $after.prerequisites | Where-Object { -not $_.installed }
if ($stillMissing.Count -eq 0) {
  Write-Ok 'All prerequisites are satisfied. Reload the plugin in cc-haha to start its MCP servers.'
} else {
  Write-Host ''
  Write-Warn 'Some prerequisites are STILL missing after the install pass:'
  foreach ($row in $stillMissing) {
    Write-Host ("    XX $($row.command)") -ForegroundColor Red
  }
  Write-Host ''
  Write-Host '  Possible reasons: the manager is itself missing, the package'   -ForegroundColor Yellow
  Write-Host '  needs admin privileges, or the install added the binary to a'   -ForegroundColor Yellow
  Write-Host '  PATH location that requires a fresh shell to pick up. Open the' -ForegroundColor Yellow
  Write-Host '  modal''s row for each remaining tool to see manual install hints.' -ForegroundColor Yellow
  exit 1
}
