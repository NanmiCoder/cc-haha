#Requires -Version 5.1

<#
    SelfTestSupport.psm1 - the shared driver both Invoke-U6SelfTests.ps1 and
    Invoke-U7SelfTests.ps1 run their numbered cases through: a named-case
    runner that records pass/fail without ever stopping the run on the first
    failure, plain assertion helpers, and one verdict printer so both self-
    test tiers report the same shape U8's -SelfTest half parses. Reachable
    only from selftest/ (contract-gate rule 12's stub-reachability
    discipline extends to every selftest/-only helper, not only the stub).
#>

Set-StrictMode -Version 2.0

$script:Results = New-Object System.Collections.Generic.List[object]

function Reset-SelfTestResults {
    [CmdletBinding()]
    param()
    $script:Results = New-Object System.Collections.Generic.List[object]
}

function Get-SelfTestResults {
    [CmdletBinding()]
    param()
    return $script:Results.ToArray()
}

function Invoke-SelfTest {
    param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][scriptblock]$Body)
    Write-Host "RUN  $Name"
    try {
        & $Body | Out-Null
        $script:Results.Add([pscustomobject]@{ Name = $Name; Passed = $true; Detail = $null })
        Write-Host "PASS $Name"
    } catch {
        $script:Results.Add([pscustomobject]@{ Name = $Name; Passed = $false; Detail = $_.Exception.Message })
        Write-Host "FAIL $Name : $($_.Exception.Message)"
    }
}

function Assert-True {
    param([Parameter(Mandatory = $true)][bool]$Condition, [Parameter(Mandatory = $true)][string]$Message)
    if (-not $Condition) { throw "assertion failed: $Message" }
}

function Assert-Throws {
    param([Parameter(Mandatory = $true)][scriptblock]$Body, [Parameter(Mandatory = $true)][string]$Message)
    $threw = $false
    try { & $Body | Out-Null } catch { $threw = $true }
    Assert-True $threw $Message
}

function Assert-NotThrows {
    param([Parameter(Mandatory = $true)][scriptblock]$Body, [Parameter(Mandatory = $true)][string]$Message)
    $threw = $false
    try { & $Body | Out-Null } catch { $threw = $true }
    Assert-True (-not $threw) $Message
}

function New-TempPath {
    param([string]$Prefix, [string]$Extension)
    return (Join-Path ([System.IO.Path]::GetTempPath()) ("$Prefix-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + $Extension))
}

function New-ScratchDirectory {
    param([string]$Label)
    $path = Join-Path ([System.IO.Path]::GetTempPath()) ("selftest-$Label-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    return $path
}

function Write-SelfTestVerdict {
    <#
    .SYNOPSIS
        Prints "VERDICT passed=<n> failed=<n> total=<n>" plus one "FAILED:"
        line per failing case, and returns $true only when every recorded
        case passed AND at least one case ran - an empty result list is a
        failure, never a vacuous pass.
    #>
    [CmdletBinding()]
    param()
    <#
        .ToArray(), never the @() array-subexpression operator, over
        $script:Results: @() on a System.Collections.Generic.List[object]
        hits a measured Windows PowerShell 5.1 PSToObjectArrayBinder defect
        ("Argument types do not match", thrown from
        System.Linq.Expressions.Expression.Condition inside the dynamic
        call-site binder) once the site has already bound against a
        different enumerable shape earlier in the process - reproduced
        while building this module, not a parse-time concern. .ToArray()
        never engages that binder.
    #>
    $results = $script:Results.ToArray()
    $failed = @($results | Where-Object { -not $_.Passed })
    $passed = @($results | Where-Object { $_.Passed })
    Write-Host ''
    Write-Host ('VERDICT passed={0} failed={1} total={2}' -f $passed.Count, $failed.Count, $results.Count)
    foreach ($item in $failed) { Write-Host ('  FAILED: {0} -- {1}' -f $item.Name, $item.Detail) }
    if ($results.Count -eq 0) {
        Write-Host '  FAILED: zero self-test cases ran'
        return $false
    }
    return ($failed.Count -eq 0)
}

Export-ModuleMember -Function @(
    'Reset-SelfTestResults', 'Get-SelfTestResults', 'Invoke-SelfTest',
    'Assert-True', 'Assert-Throws', 'Assert-NotThrows',
    'New-TempPath', 'New-ScratchDirectory', 'Write-SelfTestVerdict'
)
