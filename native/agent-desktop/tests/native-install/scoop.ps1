param(
    [Parameter(Mandatory = $true)][string]$ScoopRoot,
    [Parameter(Mandatory = $true)][string]$Manifest
)
$ErrorActionPreference = 'Stop'
$env:SCOOP = [IO.Path]::GetFullPath($ScoopRoot)
$env:SCOOP_CACHE = Join-Path $env:SCOOP 'cache'
$env:XDG_CONFIG_HOME = Join-Path $env:SCOOP 'config'
$scoop = Join-Path $env:SCOOP 'apps/scoop/current/bin/scoop.ps1'
$manifestData = Get-Content -Raw $Manifest | ConvertFrom-Json
$originalPath = $env:PATH
foreach ($app in @('agent-desktop', '7zip')) {
    if (Test-Path (Join-Path $env:SCOOP "apps/$app")) { throw "Test requires a fresh Scoop root: $app already exists" }
}
New-Item -ItemType Directory -Force (Join-Path $env:SCOOP 'shims'), (Join-Path $env:SCOOP 'buckets') | Out-Null

function Invoke-Scoop {
    & powershell -NoProfile -File $scoop @args
    if ($LASTEXITCODE -ne 0) { throw "Scoop failed: $args" }
}

function Assert-NativeCommand {
    $current = Join-Path $env:SCOOP 'apps/agent-desktop/current'
    $binary = Join-Path $current 'agent-desktop.exe'
    $registeredPath = [Environment]::GetEnvironmentVariable('Path', 'User') -split ';'
    if ($current -notin $registeredPath) { throw 'Native directory was not registered on PATH' }
    $junction = Get-Item $current
    if ($junction.LinkType -ne 'Junction') { throw 'Current version is not a directory junction' }
    if (@(Get-ChildItem (Join-Path $env:SCOOP 'shims') -Filter 'agent-desktop*').Count) {
        throw 'Scoop created an agent-desktop shim'
    }
    $versionedBinary = Join-Path $env:SCOOP "apps/agent-desktop/$($manifestData.version)/agent-desktop.exe"
    if ((Get-FileHash $binary).Hash -ne (Get-FileHash $versionedBinary).Hash) {
        throw 'PATH executable differs from installed release'
    }
    $magic = [IO.File]::ReadAllBytes($binary)
    if ($magic[0] -ne 77 -or $magic[1] -ne 90) { throw 'Command is not a native PE executable' }
    $env:PATH = "$current;$env:SystemRoot/System32;$env:SystemRoot"
    try {
        if ((Get-Command agent-desktop).Source -ne $binary) { throw 'Command is shadowed' }
        if (Get-Command node -ErrorAction SilentlyContinue) { throw 'Node is unexpectedly available' }
        foreach ($command in @('version', 'permissions')) {
            $response = & agent-desktop $command | ConvertFrom-Json
            if ($LASTEXITCODE -ne 0 -or -not $response.ok) { throw "Native $command failed" }
            if ($command -eq 'version' -and $response.data.version -ne $manifestData.version) {
                throw 'Installed version does not match manifest'
            }
        }
    } finally {
        $env:PATH = $originalPath
    }
}

try {
    Invoke-Scoop bucket add main
    Invoke-Scoop install --no-update-scoop $Manifest
    Assert-NativeCommand
    Invoke-Scoop reset agent-desktop
    Assert-NativeCommand
    Invoke-Scoop uninstall agent-desktop
    $current = Join-Path $env:SCOOP 'apps/agent-desktop/current'
    if (Test-Path $current) { throw 'Uninstall retained the native command' }
    if ($current -in ([Environment]::GetEnvironmentVariable('Path', 'User') -split ';')) {
        throw 'Uninstall retained the PATH entry'
    }
    Invoke-Scoop uninstall 7zip
    Write-Output 'PASS: fresh Scoop install, native PATH, no Node, reset and uninstall'
} finally {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $cleanPath = ($userPath -split ';' | Where-Object { -not $_.StartsWith($env:SCOOP + '\', [StringComparison]::OrdinalIgnoreCase) }) -join ';'
    if ($userPath -ne $cleanPath) { [Environment]::SetEnvironmentVariable('Path', $cleanPath, 'User') }
    $env:PATH = $originalPath
}
