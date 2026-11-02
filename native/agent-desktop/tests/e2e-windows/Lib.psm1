#Requires -Version 5.1

<#
    Lib.psm1 - primitives every scenario composes from: target objects that
    always carry their snapshot, independent-observation assertions, and a
    thin snapshot/find/list-windows wrapper keeping tree/envelope reads
    inside this file or sibling LibEnvelope.psm1 - no other harness file
    uses dotted .ok/.error/.disposition/.data access (rule 5 does not gate
    bracket indexing), and this file never calls `exit`;
    only Run-E2E.ps1 does. Lock ordering/leg ledger/Require-Target live in
    LibVerdict.psm1; batch/occluder assertions live in LibEnvelope.psm1 -
    both re-exported below, both split out for the 400-line cap. #>

Set-StrictMode -Version 2.0

Import-Module (Join-Path $PSScriptRoot 'Harness.psm1') -Force -Global
Import-Module (Join-Path $PSScriptRoot 'LibVerdict.psm1') -Force -Global
Import-Module (Join-Path $PSScriptRoot 'LibEnvelope.psm1') -Force -Global

$script:TargetExe = $null
$script:NoEffectWindowMs = 6000

function Set-TargetBinary {
    <# The one variable every ref-command wrapper resolves its CLI call from;
       self-tests point it at Stub-AgentDesktop.ps1 via powershell.exe. #>
    param([Parameter(Mandatory = $true)][string]$FilePath, [string[]]$PrefixArgs = @())
    $script:TargetExe = [pscustomobject]@{ FilePath = $FilePath; PrefixArgs = $PrefixArgs }
}

function Get-TargetBinary {
    [CmdletBinding()]
    param()
    if (-not $script:TargetExe) {
        $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
        $default = Join-Path $repoRoot 'target\release\agent-desktop.exe'
        $script:TargetExe = [pscustomobject]@{ FilePath = $default; PrefixArgs = @() }
    }
    return $script:TargetExe
}

function Invoke-AgentDesktop {
    <# Every CLI call in this file goes through here, so binary-vs-stub lives
       in one place. -RequireOk mirrors Invoke-Target's setup-call check for
       the raw (non-ref) commands, e.g. focus-window. #>
    param([Parameter(Mandatory = $true)][string[]]$Arguments, [int]$TimeoutSeconds = 20, [switch]$RequireOk, [string]$Description = 'command')
    $bin = Get-TargetBinary
    $full = @($bin.PrefixArgs) + $Arguments
    $result = Invoke-GuardedAgent -FilePath $bin.FilePath -ArgumentList $full -TimeoutSeconds $TimeoutSeconds
    if ([string]::IsNullOrWhiteSpace($result.StdOut)) {
        throw "Invoke-AgentDesktop: '$($Arguments -join ' ')' produced no stdout to parse (ExitCode=$($result.ExitCode), TimedOut=$($result.TimedOut), OutputLimited=$($result.OutputLimited)); stderr: $($result.StdErr.Trim())"
    }
    $envelope = ConvertFrom-AgentJson -Json $result.StdOut
    if ($RequireOk -and $envelope['ok'] -ne $true) {
        throw "Invoke-AgentDesktop: setup command '$($Arguments -join ' ')' on $Description failed: $($envelope['error']['code'])"
    }
    return $envelope
}

function Find-Target {
    <# Polls `find --first` to a deadline, returning RefId+SnapshotId - never
       a bare ref, $null rather than a partial object on timeout. `--first`
       carries the match under data.match (single object, possibly null),
       never data.matches (find_live.rs's single_match_response). #>
    [CmdletBinding()]
    param(
        [string]$App, [string]$WindowId, [string]$NativeId, [string]$Name, [string]$Role,
        [switch]$Exact, [int]$TimeoutSeconds = 10
    )
    $findArgs = @('find', '--first')
    if ($App) { $findArgs += @('--app', $App) }
    if ($WindowId) { $findArgs += @('--window-id', $WindowId) }
    if ($NativeId) { $findArgs += @('--native-id', $NativeId) }
    if ($Name) { $findArgs += @('--name', $Name) }
    if ($Role) { $findArgs += @('--role', $Role) }
    if ($Exact) { $findArgs += '--exact' }

    $deadline = [System.Diagnostics.Stopwatch]::StartNew()
    do {
        $envelope = Invoke-AgentDesktop -Arguments $findArgs
        if ($envelope['ok'] -eq $true) {
            $match = $envelope['data']['match']
            $snapshotId = $envelope['data']['snapshot_id']
            if ($match -and $snapshotId) {
                $refId = $match['ref_id']
                if ($refId) {
                    return [pscustomobject]@{ RefId = $refId; SnapshotId = $snapshotId }
                }
            }
        }
        Start-Sleep -Milliseconds 200
    } while ($deadline.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    return $null
}

function Find-TargetMatches {
    <# Cardinality-preserving sibling of Find-Target: omits --first - plural data.matches[]/data.total_matches. #>
    [CmdletBinding()]
    param(
        [string]$App, [string]$WindowId, [string]$NativeId, [string]$Name, [string]$Role,
        [switch]$Exact, [int]$TimeoutSeconds = 10
    )
    $findArgs = @('find')
    if ($App) { $findArgs += @('--app', $App) }
    if ($WindowId) { $findArgs += @('--window-id', $WindowId) }
    if ($NativeId) { $findArgs += @('--native-id', $NativeId) }
    if ($Name) { $findArgs += @('--name', $Name) }
    if ($Role) { $findArgs += @('--role', $Role) }
    if ($Exact) { $findArgs += '--exact' }

    $deadline = [System.Diagnostics.Stopwatch]::StartNew()
    do {
        $envelope = Invoke-AgentDesktop -Arguments $findArgs
        if ($envelope['ok'] -eq $true) {
            $matchList = $envelope['data']['matches']
            $snapshotId = $envelope['data']['snapshot_id']
            if ($matchList -and $snapshotId) {
                $targets = @($matchList | ForEach-Object { [pscustomobject]@{ RefId = $_['ref_id']; SnapshotId = $snapshotId } })
                return [pscustomobject]@{ Targets = $targets; Count = [int]$envelope['data']['total_matches']; SnapshotId = $snapshotId }
            }
        }
        Start-Sleep -Milliseconds 200
    } while ($deadline.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    return $null
}

function Find-TargetById {
    param([string]$App, [Parameter(Mandatory = $true)][string]$NativeId, [int]$TimeoutSeconds = 10)
    return Find-Target -App $App -NativeId $NativeId -TimeoutSeconds $TimeoutSeconds
}
function Get-Target {
    <# -Raw skips the string cast for a non-scalar property (bounds' own
       x/y/width/height object) - still plain data, never the envelope. #>
    param([Parameter(Mandatory = $true)]$Target, [Parameter(Mandatory = $true)][string]$Property, [switch]$Raw)
    $envelope = Invoke-AgentDesktop -Arguments @('get', $Target.RefId, '--property', $Property)
    if ($envelope['ok'] -ne $true) {
        throw "Get-Target: 'get --property $Property' on $($Target.RefId) failed: $($envelope['error']['code'])"
    }
    if ($Raw) { return $envelope['data']['value'] }
    return [string]$envelope['data']['value']
}

function Test-Target {
    param([Parameter(Mandatory = $true)]$Target, [Parameter(Mandatory = $true)][string]$Property)
    $envelope = Invoke-AgentDesktop -Arguments @('is', $Target.RefId, '--property', $Property)
    if ($envelope['ok'] -ne $true) {
        throw "Test-Target: 'is --property $Property' on $($Target.RefId) failed: $($envelope['error']['code'])"
    }
    return [bool]$envelope['data']['result']
}

function Wait-Target {
    param(
        [Parameter(Mandatory = $true)]$Target, [Parameter(Mandatory = $true)][string]$Predicate,
        [string]$Value, [string]$WaitAction, [int]$TimeoutMs = 5000
    )
    $waitArgs = @('wait', '--element', $Target.RefId, '--predicate', $Predicate, '--timeout', [string]$TimeoutMs)
    if ($Value) { $waitArgs += @('--value', $Value) }
    if ($WaitAction) { $waitArgs += @('--action', $WaitAction) }
    $seconds = [int][Math]::Ceiling($TimeoutMs / 1000) + 10
    $envelope = Invoke-AgentDesktop -Arguments $waitArgs -TimeoutSeconds $seconds
    return [bool]$envelope['ok']
}

function Invoke-Target {
    <# Runs a ref-resolving action; -RequireOk converts an ok=false setup
       action into a named throw instead of waiting out a status never armed. #>
    param(
        [Parameter(Mandatory = $true)]$Target, [Parameter(Mandatory = $true)][string]$Action,
        [string[]]$ActionArgs = @(), [switch]$Headed, [int]$TimeoutSeconds = 20,
        [switch]$RequireOk, [string]$Description = 'target'
    )
    $callArgs = @()
    if ($Headed) { $callArgs += '--headed' }
    $callArgs += @($Action, $Target.RefId)
    $callArgs += $ActionArgs
    $envelope = Invoke-AgentDesktop -Arguments $callArgs -TimeoutSeconds $TimeoutSeconds
    if ($RequireOk -and $envelope['ok'] -ne $true) {
        throw "Invoke-Target: setup action '$Action' on $Description failed: $($envelope['error']['code'])"
    }
    return $envelope
}

function Invoke-Snapshot {
    <# The one door scenario files use to read a tree: wraps `snapshot`,
       returns safe names (SnapshotId/Root/RefCount/Complete), never .data -
       walking the returned Root's own role/children/native_id is not a
       banned envelope touch. #>
    [CmdletBinding()]
    param(
        [string]$App, [string]$WindowId, [switch]$Skeleton, [string]$Root,
        [switch]$IncludeBounds, [int]$TimeoutSeconds = 20, [int]$MaxDepth, [int]$SnapshotTimeoutMs
    )
    $snapArgs = @('snapshot')
    if ($App) { $snapArgs += @('--app', $App) }
    if ($WindowId) { $snapArgs += @('--window-id', $WindowId) }
    if ($Skeleton) { $snapArgs += '--skeleton' }
    if ($Root) { $snapArgs += @('--root', $Root) }
    if ($IncludeBounds) { $snapArgs += '--include-bounds' }
    if ($MaxDepth) { $snapArgs += @('--max-depth', [string]$MaxDepth) }; if ($SnapshotTimeoutMs) { $snapArgs += @('--timeout-ms', [string]$SnapshotTimeoutMs) }
    $envelope = Invoke-AgentDesktop -Arguments $snapArgs -TimeoutSeconds $TimeoutSeconds
    if ($envelope['ok'] -ne $true) { return $null }
    return [pscustomobject]@{
        SnapshotId = $envelope['data']['snapshot_id']
        Root       = $envelope['data']['tree']
        RefCount   = $envelope['data']['ref_count']
        Complete   = $envelope['data']['complete']
    }
}

function Get-WindowId {
    <# Resolves list-windows' id under a caller-supplied predicate - fixes
       --app's ambiguity once a fixture surface shares the app_name (measured:
       --app picked the wrong window). -CountOnly counts matches (two same-
       titled windows is duplicate-window's own point). #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][scriptblock]$Where, [int]$TimeoutSeconds = 10, [switch]$CountOnly)
    $deadline = [System.Diagnostics.Stopwatch]::StartNew()
    do {
        $envelope = Invoke-AgentDesktop -Arguments @('list-windows')
        if ($envelope['ok'] -eq $true) {
            $hits = @($envelope['data'] | Where-Object $Where)
            if ($CountOnly -and $hits.Count -ge 1) { return $hits.Count }
            if (-not $CountOnly -and $hits.Count -ge 1) { return [string]$hits[0]['id'] }
        }
        Start-Sleep -Milliseconds 200
    } while ($deadline.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    if ($CountOnly) { return 0 }
    return $null
}

function Assert-Effect {
    <# Independent-observation primitive: reads Property/IsProperty on
       StatusTarget (Target when omitted). Fails if the pre-read already
       matches (unfalsifiable otherwise), acts, polls transient reads, asserts status/ok/mechanism. ExpectedIsPrefix compares "<Expected>#*". #>
    param(
        [Parameter(Mandatory = $true)]$Target, $StatusTarget,
        [string]$Property, [string]$Expected, [string]$IsProperty, [bool]$ExpectedState,
        [Parameter(Mandatory = $true)][string]$Action, [string[]]$ActionArgs = @(), [switch]$Headed,
        [string]$ExpectedMechanism, [int]$TimeoutSeconds = 10, [switch]$ExpectedIsPrefix, [switch]$AnyChange,
        [string]$RefreshApp, [string]$RefreshNativeId
    )
    if (-not $IsProperty -and -not $Property) {
        throw 'Assert-Effect: pass either -Property/-Expected or -IsProperty/-ExpectedState'
    }
    $readTarget = $Target
    if ($StatusTarget) { $readTarget = $StatusTarget }
    <# RefreshApp/RefreshNativeId re-resolve a fresh ref every poll: a
       control whose own name/text is the changed evidence (outline-parent's
       label) fails strict re-identification against a stale ref - measured live, not transient; it exhausts the poll window otherwise. #>
    $readState = {
        $target = $readTarget
        if ($RefreshNativeId) {
            $target = Find-Target -App $RefreshApp -NativeId $RefreshNativeId -TimeoutSeconds 2
            if (-not $target) { throw "Assert-Effect: RefreshNativeId '$RefreshNativeId' did not resolve" }
        }
        if ($IsProperty) { return [bool](Test-Target -Target $target -Property $IsProperty) }
        return Get-Target -Target $target -Property $Property
    }
    $pre = & $readState
    <# AnyChange: "reached" means "differs from pre" (no value known ahead of
       time). AnyChange+ExpectedIsPrefix together require both: changed AND says the right thing - lets a re-firing counter-suffixed leg stay falsifiable without weakening the oracle to "changed at all". #>
    $reached = { param($value) if ($IsProperty) { return $value -eq $ExpectedState } if ($AnyChange -and $ExpectedIsPrefix) { return ($value -ne $pre) -and ($value -like "$Expected#*") } if ($AnyChange) { return $value -ne $pre } if ($ExpectedIsPrefix) { return $value -like "$Expected#*" } return $value -eq $Expected }
    $describeExpected = if ($IsProperty) { "$IsProperty=$ExpectedState" } elseif ($AnyChange) { "<any value other than '$pre'>" } else { $Expected }

    if ((-not $AnyChange) -and (& $reached $pre)) {
        throw "Assert-Effect: the status on $($readTarget.RefId) already equals expected '$describeExpected' before the action ran; this leg is unfalsifiable"
    }
    $envelope = Invoke-Target -Target $Target -Action $Action -ActionArgs $ActionArgs -Headed:$Headed

    $deadline = [System.Diagnostics.Stopwatch]::StartNew()
    $observed = $pre
    $lastReadError = $null
    while ($deadline.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        try {
            $observed = & $readState
            $lastReadError = $null
            if (& $reached $observed) { break }
        } catch {
            $lastReadError = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 150
    }
    if (-not (& $reached $observed)) {
        $extra = ''
        if ($lastReadError) { $extra = "; last transient read error: $lastReadError" }
        throw "Assert-Effect: the status on $($readTarget.RefId) did not reach '$describeExpected' within ${TimeoutSeconds}s (last observed '$observed')$extra"
    }
    if ($envelope['ok'] -ne $true) {
        throw "Assert-Effect: action '$Action' on $($Target.RefId) reported ok=false ($($envelope['error']['code'])) even though the status reached '$describeExpected'"
    }
    if ($ExpectedMechanism) {
        $steps = $envelope['data']['steps']
        $lastMechanism = $null
        if ($steps -and $steps.Count -gt 0) { $lastMechanism = $steps[$steps.Count - 1]['mechanism'] }
        if ($lastMechanism -ne $ExpectedMechanism) {
            throw "Assert-Effect: action '$Action' on $($Target.RefId) delivered via '$lastMechanism', expected '$ExpectedMechanism'"
        }
    }
    return $envelope
}

function Initialize-NoEffectWindow {
    <# Start-up refusal: requires the pinned NoEffectWindowMs constant be at
       least 1.5x the max recorded p99 (or the bootstrap value); throws rather than run under-guarded. #>
    param([string]$BaselinePath = (Join-Path $PSScriptRoot 'latency-baseline.psd1'))
    $data = Import-PowerShellDataFile -Path $BaselinePath
    $legs = $data.Legs
    $bootstrapUsed = $true
    $maxP99 = $data.BootstrapP99Ms
    if ($legs -and $legs.Count -gt 0) {
        $maxP99 = ($legs.Values | Measure-Object -Maximum).Maximum
        $bootstrapUsed = $false
    }
    $minRequired = [Math]::Ceiling($maxP99 * 1.5)
    if ($script:NoEffectWindowMs -lt $minRequired) {
        throw "Initialize-NoEffectWindow: pinned window ($($script:NoEffectWindowMs)ms) is below 1.5x the recorded maximum p99 (${minRequired}ms required); refusing to start"
    }
    return [pscustomobject]@{ WindowMs = $script:NoEffectWindowMs; MaxP99Ms = $maxP99; BootstrapUsed = $bootstrapUsed }
}

function Assert-NoEffect {
    <# Negative sibling of Assert-Effect: acts, samples Property across the
       whole window (including the boundary), throwing the moment a sample differs. Returns the envelope for Assert-Envelope. #>
    param(
        [Parameter(Mandatory = $true)]$Target, $StatusTarget,
        [Parameter(Mandatory = $true)][string]$Property,
        [Parameter(Mandatory = $true)][string]$Action, [string[]]$ActionArgs = @(), [switch]$Headed,
        [int]$WindowMs = $script:NoEffectWindowMs
    )
    $readTarget = $Target
    if ($StatusTarget) { $readTarget = $StatusTarget }
    $pre = Get-Target -Target $readTarget -Property $Property
    $envelope = Invoke-Target -Target $Target -Action $Action -ActionArgs $ActionArgs -Headed:$Headed

    $sampleMs = [Math]::Max(50, [Math]::Floor($WindowMs / 6))
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        $observed = Get-Target -Target $readTarget -Property $Property
        if ($observed -ne $pre) {
            throw "Assert-NoEffect: '$Property' on $($readTarget.RefId) changed from '$pre' to '$observed' within the ${WindowMs}ms no-effect window"
        }
        if ($stopwatch.Elapsed.TotalMilliseconds -ge $WindowMs) { break }
        $remaining = $WindowMs - $stopwatch.Elapsed.TotalMilliseconds
        Start-Sleep -Milliseconds ([Math]::Max(1, [Math]::Min($sampleMs, $remaining)))
    }
    return $envelope
}

function Assert-Envelope {
    <# Envelope primitive: expected ok/ErrorCode, disposition.delivery/.retry,
       named details pairs. An unnamed field is not asserted; a named field the envelope lacks is a failure. #>
    param(
        [Parameter(Mandatory = $true)]$Envelope, [switch]$Ok, [string]$ErrorCode,
        [string]$Delivery, [string]$Retry, [hashtable]$Details
    )
    if ($ErrorCode) {
        if ($Envelope['ok'] -ne $false) { throw "Assert-Envelope: expected ok=false for error code '$ErrorCode', got ok=$($Envelope['ok'])" }
        $err = $Envelope['error']
        if (-not $err -or $err['code'] -ne $ErrorCode) { throw "Assert-Envelope: expected error.code '$ErrorCode', got '$($err['code'])'" }
        $disposition = $err['disposition']
        $detailsBag = $err['details']
    } elseif ($Ok) {
        if ($Envelope['ok'] -ne $true) { throw "Assert-Envelope: expected ok=true, got ok=$($Envelope['ok'])" }
        $disposition = $Envelope['data']['disposition']
        $detailsBag = $Envelope['data']['details']
    } else {
        throw 'Assert-Envelope: pass either -Ok or -ErrorCode'
    }
    if ($Delivery -and (-not $disposition -or $disposition['delivery'] -ne $Delivery)) {
        throw "Assert-Envelope: expected disposition.delivery '$Delivery', got '$($disposition['delivery'])'"
    }
    if ($Retry -and (-not $disposition -or $disposition['retry'] -ne $Retry)) {
        throw "Assert-Envelope: expected disposition.retry '$Retry', got '$($disposition['retry'])'"
    }
    if ($Details) {
        foreach ($key in $Details.Keys) {
            $expectedValue = $Details[$key]
            <# Test-EnvelopeValueEquals (LibEnvelope.psm1), never a bare
               -ne: for an array-typed expected value, "$array -ne $other"
               is PowerShell's array-filter form, not whole-value equality -
               truthy even when both arrays print identically. Measured
               live against surface-menu-refused. #>
            if (-not $detailsBag -or -not $detailsBag.ContainsKey($key) -or -not (Test-EnvelopeValueEquals -Actual $detailsBag[$key] -Expected $expectedValue)) {
                $actual = $null
                if ($detailsBag -and $detailsBag.ContainsKey($key)) { $actual = $detailsBag[$key] }
                throw "Assert-Envelope: expected details.$key = '$expectedValue', got '$actual'"
            }
        }
    }
}

Export-ModuleMember -Function @(
    'Set-TargetBinary', 'Get-TargetBinary', 'Invoke-AgentDesktop',
    'Find-Target', 'Find-TargetMatches', 'Find-TargetById', 'Require-Target',
    'Get-Target', 'Test-Target', 'Wait-Target', 'Invoke-Target', 'Invoke-Snapshot', 'Get-WindowId',
    'Assert-Effect', 'Assert-NoEffect', 'Assert-Envelope', 'Initialize-NoEffectWindow',
    'Enter-Stage',
    'Set-SkipAllowlistPath', 'Register-Legs', 'Add-Pass', 'Add-Fail', 'Add-Skip',
    'Reset-Verdict', 'Write-Verdict'
)
