#Requires -Version 5.1
<#
.SYNOPSIS
    Builds the agent-desktop Windows E2E fixture into a runnable WinForms exe.

.DESCRIPTION
    Compiles every .cs file in this directory as one module with the pinned
    in-box .NET Framework compiler, resolved by absolute path rather than
    through PATH so the build cannot silently pick up a different compiler
    on a differently-provisioned box (A24-1). The language level is pinned
    at /langversion:5 rather than left at Default so a future in-box
    compiler upgrade cannot silently start accepting syntax this corpus has
    never compiled against.

    The build is idempotent: output is written to a temporary path first and
    only moved into place once the compile has fully succeeded, so a failed
    build never destroys a previously working artifact.

.PARAMETER OutputDir
    Directory the built AgentDeskFixture.exe is written into. Defaults to
    a "build" directory alongside this script. The harness passes its own
    isolated suite root here.

.OUTPUTS
    Writes "Built: <path>" to stdout on success. Throws on any failure.
#>
[CmdletBinding()]
param(
    [string]$OutputDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$here = Split-Path -Parent $PSCommandPath
if (-not $OutputDir) {
    $OutputDir = Join-Path $here 'build'
}

# Resolved by absolute path, never through PATH (R1). A csc.exe found via
# PATH could be a different, unpinned compiler on a machine where the shell
# profile puts a newer toolchain ahead of the in-box one.
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) {
    throw ("pinned compiler not found at " + $csc + " - this fixture targets " +
        "the in-box .NET Framework 4.x csc.exe and does not resolve a " +
        "compiler through PATH")
}

<#
    UIAutomationProvider.dll and UIAutomationTypes.dll (needed by the
    cell-role and the other UiaProviderHost-based WM_GETOBJECT providers, A24-9) ship only in
    the GAC on this toolchain, not alongside csc.exe itself - a plain
    /reference:UIAutomationProvider.dll fails with CS0006 because the
    legacy pre-Roslyn compiler does not search the GAC for a bare filename.
    Resolved by globbing the well-known GAC_MSIL layout rather than
    hardcoding the version-hash folder name, so a differently-serviced box
    with the same assembly at a different folder name still resolves it.
#>
function Resolve-GacAssembly {
    param([Parameter(Mandatory = $true)][string]$AssemblyName)
    $root = Join-Path $env:WINDIR ('Microsoft.NET\assembly\GAC_MSIL\' + $AssemblyName)
    if (-not (Test-Path -LiteralPath $root)) {
        throw ("required GAC assembly not found: " + $AssemblyName + " (looked under " + $root + ")")
    }
    $found = Get-ChildItem -LiteralPath $root -Recurse -Filter ($AssemblyName + '.dll') |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $found) {
        throw ("required GAC assembly not found: " + $AssemblyName + " (searched " + $root + ")")
    }
    return $found
}

$uiaProvider = Resolve-GacAssembly -AssemblyName 'UIAutomationProvider'
$uiaTypes = Resolve-GacAssembly -AssemblyName 'UIAutomationTypes'

<#
    WindowsBase.dll supplies System.Windows.Rect and the other System.Windows
    types the UIAutomation assemblies depend on; it lives outside
    System.Windows.Forms.dll. Resolved through the same GAC lookup as the two
    UIAutomation assemblies above rather than hardcoded, for the same reason.
#>
$windowsBase = Resolve-GacAssembly -AssemblyName 'WindowsBase'

if (-not (Test-Path -LiteralPath $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

$exePath = Join-Path $OutputDir 'AgentDeskFixture.exe'
$tempExePath = Join-Path $OutputDir ('AgentDeskFixture.exe.build-' + [guid]::NewGuid().ToString('N'))

$sources = @(Get-ChildItem -LiteralPath $here -Filter '*.cs' | Select-Object -ExpandProperty FullName)
if ($sources.Count -eq 0) {
    throw ("no .cs source files found in " + $here)
}

$cscArgs = @(
    '/nologo',
    '/target:winexe',
    '/langversion:5',
    '/platform:anycpu',
    ('/out:' + $tempExePath),
    '/reference:System.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    ('/reference:' + $uiaProvider),
    ('/reference:' + $uiaTypes),
    ('/reference:' + $windowsBase)
) + $sources

Write-Verbose ("Invoking: " + $csc + " " + ($cscArgs -join ' '))
$output = @(& $csc $cscArgs 2>&1 | ForEach-Object { "$_" })
$exitCode = $LASTEXITCODE

foreach ($line in $output) { Write-Verbose $line }

if ($exitCode -ne 0 -or -not (Test-Path -LiteralPath $tempExePath)) {
    Remove-Item -LiteralPath $tempExePath -Force -ErrorAction SilentlyContinue
    throw ("csc.exe failed with exit code " + $exitCode + "`n" + ($output -join [Environment]::NewLine))
}

Move-Item -LiteralPath $tempExePath -Destination $exePath -Force

Write-Output ("Built: " + $exePath)
