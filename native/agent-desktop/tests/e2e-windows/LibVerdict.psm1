#Requires -Version 5.1

<#
    LibVerdict.psm1 - lock ordering and the leg/verdict/skip ledger, split
    out of Lib.psm1 purely to keep that file under the 400-line cap. Neither
    concern here touches a command envelope field or invokes the staged
    binary, so unlike the assertion primitives this module needs no rule05/
    rule10 gate exemption - Lib.psm1 imports it and re-exports its functions
    so scenario authors keep calling one surface.
#>

Set-StrictMode -Version 2.0

$script:StageOrder = @('DesktopLease', 'ForegroundStage', 'MenuStage')
$script:HeldStages = New-Object System.Collections.Generic.List[string]
$script:SkipAllowlistPath = Join-Path $PSScriptRoot 'skip-allowlist.psd1'
$script:SkipAllowlist = $null
$script:RegisteredLegs = New-Object System.Collections.Generic.List[string]
$script:LegDispositions = @{}
$script:UndeclaredSkipTokens = New-Object System.Collections.Generic.List[string]

function Require-Target {
    <# Aborts through the one canonical failure path when a precondition is
       missing - "setup is broken", never "the assertion failed". Reads only
       the Target's own RefId/SnapshotId, never a command envelope, so it
       carries no rule05 exemption need despite living beside Enter-Stage. #>
    param($Target, [string]$Description = 'fixture target')
    if (-not $Target -or -not $Target.RefId -or -not $Target.SnapshotId) {
        throw "PRECONDITION_FAILED: $Description was not found"
    }
    return $Target
}

function Enter-Stage {
    <# Lock ordering: DesktopLease -> ForegroundStage -> MenuStage. Refuses
       an acquisition that skips or reorders that prefix. #>
    param(
        [Parameter(Mandatory = $true)][ValidateSet('DesktopLease', 'ForegroundStage', 'MenuStage')][string]$Lock,
        [Parameter(Mandatory = $true)][scriptblock]$Body
    )
    $index = $script:StageOrder.IndexOf($Lock)
    if ($index -ne $script:HeldStages.Count) {
        $held = $script:HeldStages -join ', '
        throw "Enter-Stage: out-of-order lock acquisition - '$Lock' requires stage index $index to be next, currently held: [$held]"
    }
    $script:HeldStages.Add($Lock)
    try {
        & $Body
    } finally {
        $script:HeldStages.RemoveAt($script:HeldStages.Count - 1)
    }
}

function Set-SkipAllowlistPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $script:SkipAllowlistPath = $Path
    $script:SkipAllowlist = $null
}

function Get-SkipAllowlist {
    if (-not $script:SkipAllowlist) {
        $script:SkipAllowlist = Import-PowerShellDataFile -Path $script:SkipAllowlistPath
    }
    return $script:SkipAllowlist
}

function Register-Legs {
    param([Parameter(Mandatory = $true)][string[]]$Names)
    foreach ($name in $Names) {
        if (-not $script:RegisteredLegs.Contains($name)) { $script:RegisteredLegs.Add($name) }
    }
}

function Add-Pass {
    param([Parameter(Mandatory = $true)][string]$Leg)
    $script:LegDispositions[$Leg] = @{ Status = 'passed' }
}

function Add-Fail {
    param([Parameter(Mandatory = $true)][string]$Leg, [string]$Reason)
    $script:LegDispositions[$Leg] = @{ Status = 'failed'; Detail = $Reason }
}

function Add-Skip {
    <# A skip is never indistinguishable from a pass: an undeclared token
       still records the disposition (the leg counts as executed) but
       marks the run failed through Write-Verdict. #>
    param([Parameter(Mandatory = $true)][string]$Leg, [Parameter(Mandatory = $true)][string]$Token, [string]$Reason)
    $allowlist = Get-SkipAllowlist
    if (-not $allowlist.ContainsKey($Token)) {
        $script:UndeclaredSkipTokens.Add($Token)
    }
    $script:LegDispositions[$Leg] = @{ Status = 'skipped'; Token = $Token; Detail = $Reason }
}

function Reset-Verdict {
    <# Clears the leg ledger; exported for self-tests running several
       independent verdict scenarios in one process. #>
    $script:RegisteredLegs.Clear()
    $script:LegDispositions = @{}
    $script:UndeclaredSkipTokens.Clear()
}

function Write-Verdict {
    <# Prints the one verdict line and returns $true/$false. Never calls
       exit and never performs cleanup. #>
    param([bool]$NoEffectWindowBootstrapUsed = $false)
    $dispositions = $script:LegDispositions.Values
    $passed = @($dispositions | Where-Object { $_.Status -eq 'passed' })
    $failed = @($dispositions | Where-Object { $_.Status -eq 'failed' })
    $skipped = @($dispositions | Where-Object { $_.Status -eq 'skipped' })
    $failedNames = @($script:LegDispositions.Keys | Where-Object { $script:LegDispositions[$_].Status -eq 'failed' })
    $undisposed = @($script:RegisteredLegs | Where-Object { -not $script:LegDispositions.ContainsKey($_) })
    $tokens = @($skipped | ForEach-Object { $_.Token } | Sort-Object -Unique)

    $reasons = New-Object System.Collections.Generic.List[string]
    if ($failed.Count -gt 0) { $reasons.Add("failed legs: $($failedNames -join ', ')") }
    if ($script:RegisteredLegs.Count -gt 0 -and $script:LegDispositions.Count -eq 0) { $reasons.Add('legs were registered but none were dispositioned') }
    if ($undisposed.Count -gt 0) { $reasons.Add("registered legs never dispositioned: $($undisposed -join ', ')") }
    if ($passed.Count -eq 0) { $reasons.Add('no leg in the run passed') }
    if ($script:UndeclaredSkipTokens.Count -gt 0) { $reasons.Add("undeclared skip tokens: $($script:UndeclaredSkipTokens -join ', ')") }

    $ok = ($reasons.Count -eq 0)
    $status = 'ok'
    if (-not $ok) { $status = 'failed' }
    Write-Host ('VERDICT {0} passed={1} failed={2} skipped={3} tokens=[{4}]' -f $status, $passed.Count, $failed.Count, $skipped.Count, ($tokens -join ','))
    if ($NoEffectWindowBootstrapUsed) { Write-Host 'VERDICT note: Assert-NoEffect window bootstrap value was used (no costed legs recorded yet)' }
    foreach ($reason in $reasons) { Write-Host "VERDICT reason: $reason" }
    <# One line per failed leg naming its own Detail: the aggregate "failed
       legs: a, b, c" reason above says WHICH legs failed but not WHY, which
       makes a real run's failure undiagnosable from its own verdict output
       without re-instrumenting the scenario file by hand. #>
    foreach ($name in $failedNames) {
        Write-Host "VERDICT failed leg '$name': $($script:LegDispositions[$name].Detail)"
    }
    return $ok
}

Export-ModuleMember -Function @(
    'Require-Target', 'Enter-Stage',
    'Set-SkipAllowlistPath', 'Register-Legs', 'Add-Pass', 'Add-Fail', 'Add-Skip',
    'Reset-Verdict', 'Write-Verdict'
)
