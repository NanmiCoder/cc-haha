#Requires -Version 5.1

<#
    Invoke-U6SelfTests.ps1 - standalone verification for Harness.psm1,
    DesktopLease.psm1, BoundedProcess.psm1 and Native.psm1/NativeDesktop.psm1
    (harness core: isolation, immutable staging, bounded spawn, lease
    adoption). Cases live in U6SelfTestCasesCore.ps1 (1-6) and
    U6SelfTestCasesLease.ps1 (7-13), dot-sourced below - split purely to
    keep every file under the 400-line cap; this file is the one process
    entry point and owns the one exit call.

    This is not the full self-test tier U7 builds (Lib.psm1's Write-Verdict,
    the skip ledger, the canned-CLI stub) - U7 depends on U6. This script
    proves the primitives U6 owns work, each assertion checked by
    independent re-observation (a raw handle, a raw process re-query, or the
    real agent-desktop.exe envelope), never by a helper's own claimed
    success. Every scenario corresponds to one of U6's plan-listed test
    scenarios; where a scenario names an invert-verification, the case
    performs it inline and restores the guarded behavior before continuing,
    so a single run proves both that the guard exists and that it is what
    actually fires.

    Requires target\release\agent-desktop.exe to already be built. Needs a
    real desktop and acquires the real desktop lease - not hosted-runner-
    runnable, unlike U7's stub-driven tier.
#>
[CmdletBinding()]
param(
    [string]$AgentDesktopBinary
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:SelftestDir = $PSScriptRoot
$script:E2EWindowsDir = Split-Path -Parent $script:SelftestDir
$script:TestsDir = Split-Path -Parent $script:E2EWindowsDir
$script:RepoRoot = Split-Path -Parent $script:TestsDir
if (-not $AgentDesktopBinary) {
    $AgentDesktopBinary = Join-Path $script:RepoRoot 'target\release\agent-desktop.exe'
}
Import-Module (Join-Path $script:E2EWindowsDir 'Native.psm1') -Force
Import-Module (Join-Path $script:E2EWindowsDir 'NativeDesktop.psm1') -Force
Import-Module (Join-Path $script:E2EWindowsDir 'BoundedProcess.psm1') -Force
Import-Module (Join-Path $script:E2EWindowsDir 'DesktopLease.psm1') -Force
Import-Module (Join-Path $script:E2EWindowsDir 'Harness.psm1') -Force
Import-Module (Join-Path $script:SelftestDir 'SelfTestSupport.psm1') -Force

if (-not (Test-Path -LiteralPath $AgentDesktopBinary -PathType Leaf)) {
    throw "Invoke-U6SelfTests: agent-desktop.exe not found at $AgentDesktopBinary - run 'cargo build --release -p agent-desktop' first"
}

Reset-SelfTestResults
. (Join-Path $script:SelftestDir 'U6SelfTestCasesCore.ps1')
. (Join-Path $script:SelftestDir 'U6SelfTestCasesLease.ps1')

$ok = Write-SelfTestVerdict
if (-not $ok) { exit 1 }
exit 0
