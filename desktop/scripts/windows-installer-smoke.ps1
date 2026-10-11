[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ArtifactsDir,
  [ValidateSet('x64')][string]$Arch = 'x64'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:CI -ne 'true') {
  throw 'This installer smoke mutates Windows installer registry state and may run only on an ephemeral CI runner.'
}

# The package step has populated electron-builder's NSIS cache. Exercise the
# actual helper writer and uninstall result handling before touching install state.
Push-Location (Join-Path $PSScriptRoot '..\..')
try {
  & bun test ./scripts/pr/windows-installer-process-check.test.ts
  if ($LASTEXITCODE -ne 0) {
    throw 'Native installer helper write regression failed.'
  }
} finally {
  Pop-Location
}

$resolvedArtifactsDir = (Resolve-Path -LiteralPath $ArtifactsDir).Path
$installers = @(Get-ChildItem -LiteralPath $resolvedArtifactsDir -File |
  Where-Object { $_.Name -like "Claude-Code-Haha-*-win-$Arch.exe" })
if ($installers.Count -ne 1) {
  throw "Expected exactly one Windows $Arch installer in $resolvedArtifactsDir, found $($installers.Count)."
}
$installer = $installers[0].FullName

$testRoot = Join-Path ([IO.Path]::GetTempPath()) "cc-haha-installer-smoke-$([Guid]::NewGuid().ToString('N'))"
$installDir = Join-Path $testRoot '中文 安装目录\Claude Code Haha'
$appData = Join-Path $testRoot 'AppData\Roaming'
$localAppData = Join-Path $testRoot 'AppData\Local'
$userProfile = Join-Path $testRoot 'UserProfile'
$appExe = Join-Path $installDir 'Claude Code Haha.exe'
$uninstaller = Join-Path $installDir 'Uninstall Claude Code Haha.exe'
$recoveryHelper = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\build\recover-legacy-install-data.ps1')).Path
$processHelper = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\build\check-install-processes.ps1')).Path
$siblingProcess = $null
$installProcess = $null
$bundledHelperProcess = $null

$savedEnvironment = @{}
foreach ($name in @('APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CC_HAHA_APP_PORTABLE_DIR', 'COMPLUS_Version')) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

function Invoke-ProcessExpectFailure {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [int]$ExpectedExitCode,
    [int]$TimeoutSeconds = 180
  )

  [Console]::Out.WriteLine("$Stage starting...")
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru
  try {
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      throw "$Stage timed out after $TimeoutSeconds seconds."
    }
    if ($PSBoundParameters.ContainsKey('ExpectedExitCode')) {
      if ($process.ExitCode -ne $ExpectedExitCode) {
        # 22 means "a matching process is running" and 20 means "legacy recovery
        # refused to continue". Getting 22 where 20 was expected says the
        # installer stopped before it ever reached recovery, so the process list
        # is the evidence that separates a real regression from a dirty runner.
        Write-InstallerFallbackProcessDiagnostic -Context "$Stage (expected $ExpectedExitCode, got $($process.ExitCode))"
        throw "$Stage expected process exit code $ExpectedExitCode, received $($process.ExitCode)."
      }
    } elseif ($process.ExitCode -eq 0) {
      throw "$Stage unexpectedly succeeded with process exit code 0."
    }
    [Console]::Out.WriteLine("$Stage failed safely with process exit code $($process.ExitCode).")
  } finally {
    $process.Dispose()
  }
}

function Invoke-CheckedProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [int]$TimeoutSeconds = 180
  )

  [Console]::Out.WriteLine("$Stage starting...")
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru
  try {
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      throw "$Stage timed out after $TimeoutSeconds seconds."
    }
    if ($process.ExitCode -ne 0) {
      throw "$Stage failed with process exit code $($process.ExitCode)."
    }
    [Console]::Out.WriteLine("$Stage completed successfully.")
  } finally {
    $process.Dispose()
  }
}

function Test-IsProcessElevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try {
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
  } finally {
    $identity.Dispose()
  }
}

# The exact image names installer.nsh falls back to when PowerShell is
# unavailable (see CcHahaFindInstallProcess's findstr list). Without a CLR the
# installer cannot resolve paths, so it matches on these names alone and any
# process carrying one -- whoever started it -- reads as "the app is still
# running". Keep this in sync with installer.nsh.
$installerFallbackImageNames = @(
  'Claude Code Haha.exe',
  'claude-sidecar-x86_64-pc-windows-msvc.exe',
  'claude-sidecar-aarch64-pc-windows-msvc.exe',
  'claude-sidecar.exe',
  'OpenConsole.exe',
  'winpty-agent.exe',
  'rg.exe'
)

function Get-InstallerFallbackProcesses {
  # Not $matches: that is an automatic variable holding -match results.
  $running = @()
  foreach ($imageName in $installerFallbackImageNames) {
    $processName = [IO.Path]::GetFileNameWithoutExtension($imageName)
    foreach ($process in @(Get-Process -Name $processName -ErrorAction SilentlyContinue)) {
      $running += $process
    }
  }
  return $running
}

# The no-CLR stages assert an exit code that says *why* the installer stopped,
# so a stray same-named process anywhere on the runner silently rewrites the
# answer. Print what the fallback would have seen; a stage that expected 22 and
# got 22 for the wrong reason looks identical to a pass without this.
function Write-InstallerFallbackProcessDiagnostic {
  param([Parameter(Mandatory = $true)][string]$Context)

  [Console]::Out.WriteLine("--- $Context : processes matching the installer's no-CLR image-name fallback ---")
  $running = @(Get-InstallerFallbackProcesses)
  if ($running.Count -eq 0) {
    [Console]::Out.WriteLine('  (none)')
  } else {
    foreach ($process in $running) {
      $processPath = '<path unavailable>'
      try {
        if ($process.Path) { $processPath = $process.Path }
      } catch {
        # A process owned by another user denies path access; the name is the
        # part that matters here, since the name is all the fallback matches on.
      }
      [Console]::Out.WriteLine("  PID=$($process.Id); Name=$($process.ProcessName); Path=$processPath")
    }
  }
  [Console]::Out.WriteLine('--- end ---')
}

# Earlier steps in this same CI job start sidecars and helpers, and this script
# deliberately leaves probe processes running for the stages that assert on
# them. Anything still alive when a later stage runs would be attributed to that
# stage instead. Settle the field before a stage whose expected exit code
# depends on nothing matching.
function Clear-InstallerFallbackProcesses {
  param(
    [Parameter(Mandatory = $true)][string]$Context,
    [int]$TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ($true) {
    $running = @(Get-InstallerFallbackProcesses)
    if ($running.Count -eq 0) { return }

    if ((Get-Date) -ge $deadline) {
      # Deliberately not a throw. Anything surviving this is outside the
      # script's control (a runner-owned process of the same name), and failing
      # here would replace the stage's own failure -- which now prints the same
      # process list -- with a less informative one. Report and let the stage
      # speak for itself.
      [Console]::Out.WriteLine("WARNING: $Context could not clear $($running.Count) matching process(es) within ${TimeoutSeconds}s.")
      Write-InstallerFallbackProcessDiagnostic -Context "$Context (still present after ${TimeoutSeconds}s)"
      return
    }

    foreach ($process in $running) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 250
  }
}

function Invoke-ProcessHelperExpectExit {
  param(
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][int]$ExpectedExitCode,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  [Console]::Out.WriteLine("$Stage starting...")
  & $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $processHelper @Arguments
  if ($LASTEXITCODE -ne $ExpectedExitCode) {
    throw "$Stage expected exit code $ExpectedExitCode, received $LASTEXITCODE."
  }
  [Console]::Out.WriteLine("$Stage completed with expected exit code $ExpectedExitCode.")
}

function Invoke-ProcessHelperCleanup {
  param(
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  [Console]::Out.WriteLine("$Stage starting...")
  & $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $processHelper @Arguments
  if ($LASTEXITCODE -notin @(0, 1)) {
    throw "$Stage expected process exit code 0 (killed) or 1 (already stopped), received $LASTEXITCODE."
  }
  [Console]::Out.WriteLine("$Stage completed with process exit code $LASTEXITCODE.")
}

function Write-InstalledApplicationDiagnostics {
  param(
    [Parameter(Mandatory = $true)][string]$WindowLog,
    [Parameter(Mandatory = $true)][string]$HostDiagnostics
  )

  foreach ($path in @($WindowLog, $HostDiagnostics)) {
    [Console]::Out.WriteLine("--- installed application diagnostic: $path ---")
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      foreach ($line in @(Get-Content -LiteralPath $path -Tail 80 -ErrorAction SilentlyContinue)) {
        [Console]::Out.WriteLine([string]$line)
      }
    } else {
      [Console]::Out.WriteLine('  (missing)')
    }
    [Console]::Out.WriteLine('--- end ---')
  }
}

function Invoke-InstalledApplicationSmoke {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string]$InstallDirectory,
    [Parameter(Mandatory = $true)][string]$IsolatedUserProfile,
    [int]$TimeoutSeconds = 60
  )

  $configDir = Join-Path $IsolatedUserProfile '.claude'
  $serverStateFile = Join-Path $configDir 'desktop-server-state.json'
  $windowLog = Join-Path $testRoot 'electron-window-smoke.jsonl'
  $hostDiagnostics = Join-Path $configDir 'cc-haha\diagnostics\electron-host.log'
  $smokeEnvironmentNames = @(
    'CLAUDE_CONFIG_DIR',
    'CC_HAHA_ELECTRON_WINDOW_SMOKE_LOG',
    'HOME',
    'CI',
    'NO_PROXY',
    'no_proxy'
  )
  $savedSmokeEnvironment = @{}
  foreach ($name in $smokeEnvironmentNames) {
    $savedSmokeEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }

  $application = $null
  try {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    $env:CLAUDE_CONFIG_DIR = $configDir
    $env:CC_HAHA_ELECTRON_WINDOW_SMOKE_LOG = $windowLog
    $env:HOME = $IsolatedUserProfile
    Remove-Item Env:CI -ErrorAction SilentlyContinue
    $env:NO_PROXY = '127.0.0.1,localhost,::1'
    $env:no_proxy = '127.0.0.1,localhost,::1'

    [Console]::Out.WriteLine("Installed application Unicode-path smoke starting: $FilePath")
    $application = Start-Process -FilePath $FilePath -PassThru
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastFailure = 'waiting for the Electron window, server state, and loopback responses'

    while ((Get-Date) -lt $deadline) {
      if ($application.HasExited) {
        throw "Installed application exited before readiness with process exit code $($application.ExitCode)."
      }

      $windowReady = (Test-Path -LiteralPath $windowLog -PathType Leaf) -and
        (Select-String -LiteralPath $windowLog -SimpleMatch '"reason":"after-final-show"' -Quiet)
      if (-not $windowReady) {
        $lastFailure = 'Electron did not record after-final-show'
        Start-Sleep -Milliseconds 250
        continue
      }

      if (-not (Test-Path -LiteralPath $serverStateFile -PathType Leaf)) {
        $lastFailure = "server state file is missing: $serverStateFile"
        Start-Sleep -Milliseconds 250
        continue
      }

      try {
        $serverState = Get-Content -LiteralPath $serverStateFile -Raw | ConvertFrom-Json
        $port = [int]$serverState.lastPort
        if ($port -lt 1 -or $port -gt 65535) {
          throw "invalid server port $port"
        }
        $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
        $healthPayload = $health.Content | ConvertFrom-Json
        if ($health.StatusCode -ne 200 -or $healthPayload.status -ne 'ok') {
          throw "health returned HTTP $($health.StatusCode): $($health.Content)"
        }
        $root = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/" -TimeoutSec 2
        if ($root.StatusCode -ne 200 -or $root.Content -notmatch '<html') {
          throw "application root returned HTTP $($root.StatusCode) without HTML"
        }
        [Console]::Out.WriteLine(
          "Installed application Unicode-path smoke passed (window shown; /health and / served from port $port).")
        return
      } catch {
        $lastFailure = ([string]$_.Exception.Message) -replace '[\r\n]+', ' '
      }

      Start-Sleep -Milliseconds 250
    }

    throw "Installed application Unicode-path smoke timed out after $TimeoutSeconds seconds: $lastFailure"
  } catch {
    Write-InstalledApplicationDiagnostics -WindowLog $windowLog -HostDiagnostics $hostDiagnostics
    throw
  } finally {
    try {
      if ($null -ne $application) {
        try {
          Invoke-ProcessHelperCleanup `
            -Stage 'Installed application Unicode-path smoke cleanup' `
            -Arguments @(
              '-InstallDir', $InstallDirectory,
              '-ProcessName', 'Claude Code Haha.exe',
              '-Action', 'KillForce',
              '-InstallerPid', [string]$PID,
              '-InstallerParentPid', '0'
            )
        } finally {
          if (-not $application.WaitForExit(30000)) {
            Stop-Process -Id $application.Id -Force -ErrorAction SilentlyContinue
            throw 'Installed application did not exit after Unicode-path smoke cleanup.'
          }
          $application.Dispose()
        }
      }
    } finally {
      foreach ($name in $smokeEnvironmentNames) {
        $value = $savedSmokeEnvironment[$name]
        if ($null -eq $value) {
          [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        } else {
          [Environment]::SetEnvironmentVariable($name, [string]$value, 'Process')
        }
      }
    }
  }
}

function Invoke-LegacyRecoveryDiagnostic {
  $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $recoveryHelper,
    '-PerUserInstallDir',
    $installDir,
    '-CandidateInstallDir',
    $installDir,
    '-UserDataDir',
    (Join-Path $appData 'Claude Code Haha'),
    '-RecoveryRoot',
    (Join-Path $userProfile 'Claude Code Haha Data\Recovered'),
    '-ProcessName',
    'Claude Code Haha.exe',
    '-InstallerIdentitySafety',
    'trusted-user'
  )

  [Console]::Out.WriteLine('Direct legacy recovery diagnostic starting...')
  $output = @(& $windowsPowerShell @arguments 2>&1)
  $exitCode = $LASTEXITCODE
  foreach ($line in $output) {
    [Console]::Out.WriteLine([string]$line)
  }
  if ($exitCode -ne 0) {
    throw "Direct legacy recovery diagnostic failed with exit code $exitCode."
  }
  [Console]::Out.WriteLine('Direct legacy recovery diagnostic completed successfully.')
}

try {
  New-Item -ItemType Directory -Path $appData, $localAppData, $userProfile -Force | Out-Null
  $env:APPDATA = $appData
  $env:LOCALAPPDATA = $localAppData
  $env:USERPROFILE = $userProfile
  Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:CC_HAHA_APP_PORTABLE_DIR -ErrorAction SilentlyContinue

  # Baseline before anything here starts a process. Whatever this prints was put
  # there by earlier steps of the job or by the runner image, and it is exactly
  # what the no-CLR stages would misattribute to themselves.
  Write-InstallerFallbackProcessDiagnostic -Context 'Runner baseline before fresh install'

  Invoke-CheckedProcess -FilePath $installer -Stage 'Fresh install' -Arguments @('/S', '/currentuser', "/D=$installDir")
  if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) {
    throw "Fresh install did not create the application executable: $appExe"
  }
  Invoke-InstalledApplicationSmoke `
    -FilePath $appExe `
    -InstallDirectory $installDir `
    -IsolatedUserProfile $userProfile

  $processProbeSource = Join-Path $env:SystemRoot 'System32\ping.exe'
  $siblingDir = "$installDir Tools"
  $siblingProbe = Join-Path $siblingDir 'Claude Code Haha.exe'
  New-Item -ItemType Directory -Path $siblingDir -Force | Out-Null
  Copy-Item -LiteralPath $processProbeSource -Destination $siblingProbe
  $siblingProcess = Start-Process -FilePath $siblingProbe -ArgumentList @('-t', '127.0.0.1') -PassThru
  Start-Sleep -Milliseconds 500
  Invoke-CheckedProcess -FilePath $installer -Stage 'Sibling-prefix process reinstall' -Arguments @('--updated', '/S', '/currentuser', "/D=$installDir")
  if ($siblingProcess.HasExited) {
    throw 'Sibling-prefix process was mistaken for an install-directory process.'
  }
  [Console]::Out.WriteLine('Sibling-prefix process remains running after reinstall.')

  $installProbe = Join-Path $installDir 'install-process-probe.exe'
  Copy-Item -LiteralPath $processProbeSource -Destination $installProbe
  $installProcess = Start-Process -FilePath $installProbe -ArgumentList @('-t', '127.0.0.1') -PassThru
  Start-Sleep -Milliseconds 500
  Invoke-ProcessHelperExpectExit `
    -Stage 'Install-directory parent process detection' `
    -ExpectedExitCode 0 `
    -Arguments @(
      '-InstallDir', $installDir,
      '-ProcessName', 'Claude Code Haha.exe',
      '-Action', 'Find',
      '-InstallerPid', [string]$PID,
      '-InstallerParentPid', [string]$installProcess.Id
    )
  Invoke-CheckedProcess -FilePath $installer -Stage 'Install-directory process reinstall' -Arguments @('--updated', '/S', '/currentuser', "/D=$installDir")
  if (-not $installProcess.HasExited) {
    throw 'Install-directory process was not terminated before reinstall.'
  }

  Invoke-LegacyRecoveryDiagnostic
  Stop-Process -Id $siblingProcess.Id -Force
  $siblingProcess.WaitForExit()
  $siblingProcess.Dispose()
  $siblingProcess = $null

  $bundledHelperProbe = Join-Path $siblingDir 'OpenConsole.exe'
  Copy-Item -LiteralPath $processProbeSource -Destination $bundledHelperProbe
  $bundledHelperProcess = Start-Process -FilePath $bundledHelperProbe -ArgumentList @('-t', '127.0.0.1') -PassThru
  Start-Sleep -Milliseconds 500
  $env:COMPLUS_Version = 'v0.0.0-test-invalid-clr'
  Invoke-ProcessExpectFailure -FilePath $installer -Stage 'No-CLR external bundled-helper process reinstall' -ExpectedExitCode 22 -Arguments @('--updated', '/S', '/currentuser', "/D=$installDir")
  if ($bundledHelperProcess.HasExited) {
    throw 'No-CLR exact-image fallback terminated an external bundled-helper process.'
  }
  Remove-Item Env:COMPLUS_Version -ErrorAction SilentlyContinue
  Stop-Process -Id $bundledHelperProcess.Id -Force
  $bundledHelperProcess.WaitForExit()
  $bundledHelperProcess.Dispose()
  $bundledHelperProcess = $null

  # WaitForExit covers the PID this script started; the fallback matches on the
  # image name, so it also sees anything left over from earlier steps of this
  # job (the compiled-sidecar smoke starts 20 sidecars) and any child the probe
  # spawned. The next two stages expect 20 -- "recovery refused" -- which they can
  # only reach if nothing matches the name list first.
  Clear-InstallerFallbackProcesses -Context 'Before no-CLR default-mode reinstall'

  $env:COMPLUS_Version = 'v0.0.0-test-invalid-clr'
  if (Test-IsProcessElevated) {
    Invoke-ProcessExpectFailure -FilePath $installer -Stage 'Elevated default-mode reinstall without CLR' -ExpectedExitCode 20 -Arguments @('--updated', '/S', '/currentuser', "/D=$installDir")
  } else {
    Invoke-CheckedProcess -FilePath $installer -Stage 'Trusted-user default-mode reinstall without CLR' -Arguments @('--updated', '/S', '/currentuser', "/D=$installDir")
  }
  Remove-Item Env:COMPLUS_Version -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) {
    throw "Reinstall removed the application executable: $appExe"
  }

  $legacyDir = Join-Path $installDir 'CLAUDE_CONFIG_DIR'
  $legacySentinel = Join-Path $legacyDir 'settings.json'
  New-Item -ItemType Directory -Path $legacyDir -Force | Out-Null
  Set-Content -LiteralPath $legacySentinel -Value 'must-survive-failed-upgrade' -NoNewline
  # Same reason as the stage above: this one also expects 20, so it has to start
  # from a field where nothing matches the name list. The preceding installer run
  # can leave its own uninstaller helper behind briefly.
  Clear-InstallerFallbackProcesses -Context 'Before no-CLR portable reinstall'
  $env:COMPLUS_Version = 'v0.0.0-test-invalid-clr'
  Invoke-ProcessExpectFailure -FilePath $installer -Stage 'Portable reinstall without CLR' -ExpectedExitCode 20 -Arguments @('--updated', '/S', '/currentuser', "/D=$installDir")
  Remove-Item Env:COMPLUS_Version -ErrorAction SilentlyContinue
  if ((Get-Content -LiteralPath $legacySentinel -Raw) -ne 'must-survive-failed-upgrade') {
    throw 'Portable reinstall without CLR modified legacy data instead of failing closed.'
  }

  [Console]::Out.WriteLine('Windows installer Unicode-path launch, fresh-install, no-CLR default reinstall, and fail-closed portable reinstall smoke passed.')
} finally {
  foreach ($probeProcess in @($installProcess, $siblingProcess, $bundledHelperProcess)) {
    if ($null -ne $probeProcess) {
      if (-not $probeProcess.HasExited) {
        Stop-Process -Id $probeProcess.Id -Force -ErrorAction SilentlyContinue
      }
      $probeProcess.Dispose()
    }
  }
  if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
    Invoke-CheckedProcess -FilePath $uninstaller -Stage 'Cleanup uninstall' -Arguments @('/S', '/KEEP_APP_DATA', '/currentuser') -TimeoutSeconds 120
  }
  foreach ($name in $savedEnvironment.Keys) {
    $value = $savedEnvironment[$name]
    if ($null -eq $value) {
      [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    } else {
      [Environment]::SetEnvironmentVariable($name, [string]$value, 'Process')
    }
  }
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
