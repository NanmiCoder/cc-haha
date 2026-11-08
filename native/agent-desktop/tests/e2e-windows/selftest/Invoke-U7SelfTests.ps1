#Requires -Version 5.1

<#
    Invoke-U7SelfTests.ps1 - standalone verification for Lib.psm1: target
    objects, Assert-Effect / Assert-NoEffect / Assert-Envelope, lock
    ordering, and the verdict/skip ledger. Runs against
    Stub-AgentDesktop.ps1, never against a real agent-desktop.exe or a real
    fixture, so it needs no desktop and no staged binary - exactly what
    U8's -SelfTest half requires of this tier. Every assertion below calls
    the real shipped primitive; where the plan names an invert-verification
    this script performs it inline (swap the real function body for a
    guard-less one, observe the danger the guard exists to prevent, then
    restore) before continuing.

    Cases live in U7SelfTestCasesAssert.ps1 (1-6c) and
    U7SelfTestCasesVerdict.ps1 (7-14), dot-sourced below - split purely to
    keep every file under the 400-line cap; this file is the one process
    entry point and owns the one exit call.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:SelftestDir = $PSScriptRoot
$script:E2EWindowsDir = Split-Path -Parent $script:SelftestDir
$script:StubPath = Join-Path $script:SelftestDir 'Stub-AgentDesktop.ps1'
$script:RunE2EPath = Join-Path $script:E2EWindowsDir 'Run-E2E.ps1'

Import-Module (Join-Path $script:E2EWindowsDir 'Native.psm1') -Force
Import-Module (Join-Path $script:E2EWindowsDir 'BoundedProcess.psm1') -Force
Import-Module (Join-Path $script:E2EWindowsDir 'DesktopLease.psm1') -Force
Import-Module (Join-Path $script:E2EWindowsDir 'Harness.psm1') -Force
Import-Module (Join-Path $script:E2EWindowsDir 'Lib.psm1') -Force
Import-Module (Join-Path $script:SelftestDir 'SelfTestSupport.psm1') -Force

Reset-SelfTestResults

function New-StubConfig {
    <#
    .SYNOPSIS
        Writes a psd1 rule table Import-PowerShellDataFile can read and
        points the module's one target-binary variable at the stub through
        powershell.exe -File.
    #>
    param([Parameter(Mandatory = $true)][array]$Rules)
    $path = New-TempPath -Prefix 'u7-cfg' -Extension '.psd1'
    $ruleEntries = foreach ($rule in $Rules) {
        $quoted = $rule.Responses | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }
        "  @{ Match = '$($rule.Match)'; Responses = @($($quoted -join ', ')) }"
    }
    $lines = @('@{ Rules = @(') + @($ruleEntries -join ",`n") + @(') }')
    Set-Content -LiteralPath $path -Value $lines
    $statePath = New-TempPath -Prefix 'u7-state' -Extension '.json'
    $env:AGENT_DESKTOP_E2E_STUB_SCRIPT = $path
    $env:AGENT_DESKTOP_E2E_STUB_STATE = $statePath
    Set-TargetBinary -FilePath 'powershell.exe' -PrefixArgs @('-NoProfile', '-File', $script:StubPath)
    return [pscustomobject]@{ ConfigPath = $path; StatePath = $statePath }
}

function Set-LibFunctionText {
    <#
    .SYNOPSIS
        Rebinds Name to a scriptblock compiled from Text inside ModuleName's
        own module session state (System.Management.Automation.PSModuleInfo
        .NewBoundScriptBlock), so $script:-scoped module variables inside
        Text resolve correctly. A scriptblock literal written directly in
        this self-test script has no such binding and would resolve
        $script: against this script's own scope instead - a real trap this
        file hit while it was being built. ModuleName defaults to 'Lib';
        Write-Verdict's ledger state lives in 'LibVerdict' since U9 split it
        out to keep Lib.psm1 under the 400-line cap, so its two invert sites
        pass that name explicitly.
    #>
    param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][string]$Text, [string]$ModuleName = 'Lib')
    $module = Get-Module -Name $ModuleName
    $bound = $module.NewBoundScriptBlock([scriptblock]::Create($Text))
    Set-Item "function:$Name" -Value $bound
}

function New-Baseline {
    param([int]$BootstrapP99Ms, [hashtable]$Legs = @{})
    $path = New-TempPath -Prefix 'u7-baseline' -Extension '.psd1'
    $legLines = $Legs.Keys | ForEach-Object { "'$_' = $($Legs[$_])" }
    "@{ BootstrapP99Ms = $BootstrapP99Ms; Legs = @{ $($legLines -join '; ') } }" | Set-Content -LiteralPath $path
    return $path
}

$script:FakeTarget = [pscustomobject]@{ RefId = '@stub-snap:e1'; SnapshotId = 'stub-snap' }
$OkClick = '{"version":"2.3","ok":true,"command":"click","data":{"action":"click","steps":[{"label":"InvokePattern.Invoke","outcome":"succeeded","mechanism":"semantic_api","verified":true}],"disposition":{"delivery":"delivered_verified","retry":"unsafe"}}}'
$OkClickPhysical = '{"version":"2.3","ok":true,"command":"click","data":{"action":"click","steps":[{"label":"SendInput","outcome":"succeeded","mechanism":"physical_synthetic","verified":true}],"disposition":{"delivery":"delivered_verified","retry":"unsafe"}}}'

. (Join-Path $script:SelftestDir 'U7SelfTestCasesAssert.ps1')
. (Join-Path $script:SelftestDir 'U7SelfTestCasesVerdict.ps1')

Remove-Item Env:\AGENT_DESKTOP_E2E_STUB_SCRIPT, Env:\AGENT_DESKTOP_E2E_STUB_STATE -ErrorAction SilentlyContinue

$ok = Write-SelfTestVerdict
if (-not $ok) { exit 1 }
exit 0
