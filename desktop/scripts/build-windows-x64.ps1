[CmdletBinding()]
param(
  [switch]$NoBundle,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$TauriArgs
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktopDir = (Resolve-Path (Join-Path $scriptDir '..')).Path
$repoRoot = (Resolve-Path (Join-Path $desktopDir '..')).Path

$targetTriple = 'x86_64-pc-windows-msvc'
$tauriTargetDir = Join-Path $desktopDir 'src-tauri\target'
$canonicalOutputDir = Join-Path $desktopDir 'build-artifacts\windows-x64'
$debugOutputDir = Join-Path $desktopDir 'build-artifacts\windows-x64-debug'
$activeOutputDir = $canonicalOutputDir
$appVersion = (Get-Content -Path (Join-Path $desktopDir 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version

function Write-Step {
  param([string]$Message)
  Write-Host "[build-windows-x64] $Message"
}

function Assert-WindowsHost {
  if ($env:OS -ne 'Windows_NT') {
    throw '[build-windows-x64] This script must run on Windows.'
  }
}

function Assert-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "[build-windows-x64] Missing required command: $Name"
  }
}

function Import-VsDevEnvironment {
  $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) {
    throw '[build-windows-x64] Could not find vswhere.exe. Install Visual Studio 2022 Build Tools with the C++ workload.'
  }

  $installationPath = & $vswhere `
    -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath |
    Select-Object -First 1

  if (-not $installationPath) {
    throw '[build-windows-x64] Missing Visual C++ build tools. Install the "Desktop development with C++" / VC.Tools.x86.x64 workload first.'
  }

  $vsDevCmd = Join-Path $installationPath 'Common7\Tools\VsDevCmd.bat'
  if (-not (Test-Path $vsDevCmd)) {
    throw "[build-windows-x64] Could not find VsDevCmd.bat under $installationPath"
  }

  Write-Step "Importing MSVC environment from $vsDevCmd"

  $env:VSCMD_SKIP_SENDTELEMETRY = '1'
  $envDump = & cmd.exe /d /s /c "`"$vsDevCmd`" -arch=x64 -host_arch=x64 >nul && set"
  if ($LASTEXITCODE -ne 0) {
    throw "[build-windows-x64] Failed to initialize Visual Studio build environment (exit $LASTEXITCODE)"
  }

  foreach ($line in $envDump) {
    if ($line -match '^(.*?)=(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
  }
}

function Get-RustCargoBinDir {
  return Join-Path $env:USERPROFILE '.cargo\bin'
}

function Ensure-RustInPath {
  $cargoBinDir = Get-RustCargoBinDir
  if ((Test-Path $cargoBinDir) -and -not (($env:Path -split ';') -contains $cargoBinDir)) {
    $env:Path = "$cargoBinDir;$env:Path"
  }
}

function Get-LatestArtifact {
  param(
    [string[]]$SearchRoots,
    [string[]]$Patterns
  )

  foreach ($root in $SearchRoots) {
    if (-not (Test-Path $root)) {
      continue
    }

    foreach ($pattern in $Patterns) {
      $match = Get-ChildItem -Path $root -File -Filter $pattern -ErrorAction SilentlyContinue |
        Sort-Object Name |
        Select-Object -Last 1

      if ($match) {
        return $match
      }
    }
  }

  return $null
}

function Get-StagedArtifactName {
  param([string]$ArtifactName)

  switch -Regex ($ArtifactName) {
    '^latest\.json$' { return 'latest.json' }
    '\.msi\.zip\.sig$' { return "Claude-Code-Haha_${appVersion}_windows_x64_msi.msi.zip.sig" }
    '\.msi\.zip$' { return "Claude-Code-Haha_${appVersion}_windows_x64_msi.msi.zip" }
    '\.msi\.sig$' { return "Claude-Code-Haha_${appVersion}_windows_x64_msi.msi.sig" }
    '\.msi$' { return "Claude-Code-Haha_${appVersion}_windows_x64_msi.msi" }
    default { return $ArtifactName }
  }
}

function Resolve-OutputDirectory {
  param([string]$PreferredPath)

  New-Item -ItemType Directory -Force -Path $PreferredPath | Out-Null

  $existingArtifacts = Get-ChildItem -Path $PreferredPath -Force -ErrorAction SilentlyContinue
  foreach ($artifact in $existingArtifacts) {
    try {
      Remove-Item -LiteralPath $artifact.FullName -Force -Recurse
    } catch {
      $fallbackPath = "$PreferredPath-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
      Write-Step "Could not clear locked artifact '$($artifact.FullName)'. Using fallback output directory: $fallbackPath"
      New-Item -ItemType Directory -Force -Path $fallbackPath | Out-Null
      return $fallbackPath
    }
  }

  return $PreferredPath
}

Assert-WindowsHost
Assert-Command bun

Ensure-RustInPath
Import-VsDevEnvironment

Assert-Command cargo
Assert-Command rustc

if ($env:SKIP_INSTALL -ne '1') {
  Write-Step 'Installing root dependencies...'
  Push-Location $repoRoot
  try {
    & bun install
    if ($LASTEXITCODE -ne 0) {
      throw "[build-windows-x64] bun install failed in repo root (exit $LASTEXITCODE)"
    }
  } finally {
    Pop-Location
  }

  Write-Step 'Installing desktop dependencies...'
  Push-Location $desktopDir
  try {
    & bun install
    if ($LASTEXITCODE -ne 0) {
      throw "[build-windows-x64] bun install failed in desktop (exit $LASTEXITCODE)"
    }
  } finally {
    Pop-Location
  }

  $adaptersDir = Join-Path $repoRoot 'adapters'
  if (Test-Path (Join-Path $adaptersDir 'package.json')) {
    Write-Step 'Installing adapter dependencies...'
    Push-Location $adaptersDir
    try {
      & bun install
      if ($LASTEXITCODE -ne 0) {
        throw "[build-windows-x64] bun install failed in adapters (exit $LASTEXITCODE)"
      }
    } finally {
      Pop-Location
    }
  }
}

$tauriBuildArgs = @(
  'tauri',
  'build',
  '--target',
  $targetTriple,
  '--ci'
)

if ($NoBundle) {
  $tauriBuildArgs += '--no-bundle'
} else {
  $tauriBuildArgs += @('--bundles', 'msi')
}

$tempConfigPath = $null
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
  $tempConfigPath = Join-Path ([System.IO.Path]::GetTempPath()) 'cc-haha.tauri.local.windows.json'
  $tempConfig = @{
    bundle = @{
      createUpdaterArtifacts = $false
    }
  } | ConvertTo-Json -Depth 10
  Set-Content -Path $tempConfigPath -Value $tempConfig -Encoding UTF8
  Write-Step 'TAURI_SIGNING_PRIVATE_KEY not set, disabling updater artifacts for local build'
  $tauriBuildArgs += @('--config', $tempConfigPath)
}

if ($null -ne $TauriArgs) {
  $remainingArgs = @($TauriArgs)
  if ($remainingArgs.Count -gt 0) {
    $tauriBuildArgs += $remainingArgs
  }
}

Write-Step "Building Windows desktop app for $targetTriple"

Push-Location $desktopDir
try {
  $env:TAURI_ENV_TARGET_TRIPLE = $targetTriple
  & bun x @tauriBuildArgs
  if ($LASTEXITCODE -ne 0) {
    throw "[build-windows-x64] tauri build failed (exit $LASTEXITCODE)"
  }
} finally {
  Pop-Location
  if ($tempConfigPath -and (Test-Path $tempConfigPath)) {
    Remove-Item -LiteralPath $tempConfigPath -Force
  }
}

if ($NoBundle) {
  $activeOutputDir = Resolve-OutputDirectory -PreferredPath $debugOutputDir
  $exeRoots = @(
    (Join-Path $tauriTargetDir "$targetTriple\release"),
    (Join-Path $tauriTargetDir 'release')
  )
  $exeArtifact = Get-LatestArtifact -SearchRoots $exeRoots -Patterns @('claude-code-desktop.exe')
  if (-not $exeArtifact) {
    throw '[build-windows-x64] Build succeeded but main desktop executable was not found.'
  }
  $exeDestination = Join-Path $activeOutputDir $exeArtifact.Name
  Copy-Item -LiteralPath $exeArtifact.FullName -Destination $exeDestination -Force
  Write-Step "Copied desktop executable to $exeDestination"

  $sidecarSource = Join-Path $desktopDir "src-tauri\binaries\claude-sidecar-$targetTriple.exe"
  if (-not (Test-Path $sidecarSource)) {
    throw "[build-windows-x64] Sidecar binary not found: $sidecarSource"
  }
  $sidecarDestination = Join-Path $activeOutputDir 'claude-sidecar.exe'
  Copy-Item -LiteralPath $sidecarSource -Destination $sidecarDestination -Force
  Write-Step "Copied sidecar executable to $sidecarDestination"

  Write-Step "Windows no-bundle build artifacts are ready in $activeOutputDir"
  exit 0
}

$activeOutputDir = Resolve-OutputDirectory -PreferredPath $canonicalOutputDir

$bundleRoots = @(
  (Join-Path $tauriTargetDir "$targetTriple\release\bundle"),
  (Join-Path $tauriTargetDir 'release\bundle')
)

$artifactPatterns = @('*.msi', '*.msi.sig', '*.msi.zip', '*.msi.zip.sig', 'latest.json')
$copiedArtifacts = New-Object System.Collections.Generic.List[string]

foreach ($root in $bundleRoots) {
  if (-not (Test-Path $root)) {
    continue
  }

  foreach ($pattern in $artifactPatterns) {
    $artifacts = Get-ChildItem -Path $root -Recurse -File -Filter $pattern -ErrorAction SilentlyContinue
    foreach ($artifact in $artifacts) {
      $destinationName = Get-StagedArtifactName -ArtifactName $artifact.Name
      $destination = Join-Path $activeOutputDir $destinationName
      Copy-Item -LiteralPath $artifact.FullName -Destination $destination -Force
      if (-not $copiedArtifacts.Contains($destination)) {
        $copiedArtifacts.Add($destination) | Out-Null
      }
    }
  }
}

$msiInstaller = Get-LatestArtifact -SearchRoots @(
  (Join-Path $tauriTargetDir "$targetTriple\release\bundle\msi"),
  (Join-Path $tauriTargetDir 'release\bundle\msi')
) -Patterns @('*.msi')

$msiInstallerPath = if ($msiInstaller) { $msiInstaller.FullName } else { 'not found' }

$buildInfo = @(
  "App version: $appVersion"
  "Target triple: $targetTriple"
  "Canonical output: $canonicalOutputDir"
  "Actual output: $activeOutputDir"
  "Windows installer (MSI): $msiInstallerPath"
  "Artifacts copied: $($copiedArtifacts.Count)"
  "Built at: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
)

Set-Content -Path (Join-Path $activeOutputDir 'BUILD_INFO.txt') -Value $buildInfo -Encoding UTF8

Write-Host ''
Write-Step 'Build finished.'
Write-Step "Artifacts output: $activeOutputDir"
if ($msiInstaller) {
  Write-Step "MSI installer source: $($msiInstaller.FullName)"
} else {
  Write-Step 'No MSI installer found under bundle directories.'
}

Write-Step "Canonical output: $canonicalOutputDir"

if ($env:OPEN_OUTPUT -eq '1') {
  Invoke-Item $canonicalOutputDir
}
