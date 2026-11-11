#Requires -Version 5.1

<#
    LibEnvelope.psm1 - U10's own envelope-inspection doors, split out of
    Lib.psm1 purely to keep that file under the 400-line cap (the same
    reason LibVerdict.psm1 exists) rather than because the concern differs:
    like Lib.psm1, this file reads .ok/.error/.details/.data on a raw
    command envelope, so it carries the same rule05 exemption
    (scripts/lib/e2e-windows-contract-scan.psm1's rule05 ScopeFilter names
    this file beside Lib.psm1) and the same rule10 exemption for the one
    staged-binary call `Invoke-AgentDesktopBatch` makes through
    Invoke-AgentDesktop. Doors: Assert-EnvelopeCheckOccluder reads a
    single action envelope's nested `error.details.checks[]` array (R21's
    exact field path - Assert-Envelope's own -Details only compares flat
    key/value pairs, so the occlusion leg needs a door of its own) and
    Invoke-AgentDesktopBatch composes a `batch` call and returns per-entry
    results as plain, non-banned-named fields - never a raw dictionary a
    caller could be tempted to index into. The two shell-surface doors
    (Invoke-ShellSurfaceOpen, Invoke-ShellSurfaceSnapshot) flatten the
    open-system-surface / snapshot --surface envelopes the same way - the
    surface legs' home for envelope reads, since rule05's exemption names
    this file beside Lib.psm1 and Lib.psm1 is at the cap Invoke-Snapshot
    cannot grow a --surface parameter past.
#>

Set-StrictMode -Version 2.0

function Assert-EnvelopeCheckOccluder {
    <#
    .SYNOPSIS
        Asserts a failed action envelope's error.details.checks[] carries a
        named check (default receives_events) in Fail status whose
        occluder.name equals ExpectedOccluderName - the one assertion this
        suite needs that reads inside the checks array rather than a flat
        details key, so it is its own door rather than an Assert-Envelope
        parameter.
    #>
    param(
        [Parameter(Mandatory = $true)]$Envelope,
        [Parameter(Mandatory = $true)][string]$ErrorCode,
        [string]$Check = 'receives_events',
        [Parameter(Mandatory = $true)][string]$ExpectedOccluderName
    )
    if ($Envelope['ok'] -ne $false) {
        throw "Assert-EnvelopeCheckOccluder: expected ok=false, got ok=$($Envelope['ok'])"
    }
    $err = $Envelope['error']
    if (-not $err -or $err['code'] -ne $ErrorCode) {
        throw "Assert-EnvelopeCheckOccluder: expected error.code '$ErrorCode', got '$($err['code'])'"
    }
    $checks = $null
    if ($err['details']) { $checks = $err['details']['checks'] }
    if (-not $checks) {
        throw "Assert-EnvelopeCheckOccluder: error.details.checks is missing or empty"
    }
    $hit = $checks | Where-Object { $_['check'] -eq $Check -and $_['status'] -eq 'fail' }
    if (-not $hit) {
        throw "Assert-EnvelopeCheckOccluder: no failed '$Check' check in error.details.checks"
    }
    $occluderName = $null
    if ($hit -is [array]) { $occluderName = $hit[0]['occluder']['name'] } else { $occluderName = $hit['occluder']['name'] }
    if ($occluderName -ne $ExpectedOccluderName) {
        throw "Assert-EnvelopeCheckOccluder: expected occluder.name '$ExpectedOccluderName', got '$occluderName'"
    }
}

function Assert-EnvelopeRecovery {
    <#
    .SYNOPSIS
        Asserts a failed envelope's error.recovery block (strategy,
        retryable, requires_fresh_snapshot) - a door of its own because
        Assert-Envelope has no recovery parameter and Lib.psm1 is at the
        400-line cap. recovery_for_code (crates/core/src/response/output.rs) emits it
        only for the codes that have a documented recovery.
    #>
    param(
        [Parameter(Mandatory = $true)]$Envelope,
        [Parameter(Mandatory = $true)][string]$Strategy,
        [bool]$RequiresFreshSnapshot = $true
    )
    if ($Envelope['ok'] -ne $false) {
        throw "Assert-EnvelopeRecovery: expected ok=false, got ok=$($Envelope['ok'])"
    }
    $err = $Envelope['error']
    $recovery = $null
    if ($err) { $recovery = $err['recovery'] }
    if (-not $recovery) { throw 'Assert-EnvelopeRecovery: error.recovery is missing' }
    if ($recovery['strategy'] -ne $Strategy) {
        throw "Assert-EnvelopeRecovery: expected recovery.strategy '$Strategy', got '$($recovery['strategy'])'"
    }
    if ($recovery['retryable'] -ne $true) {
        throw "Assert-EnvelopeRecovery: expected recovery.retryable true, got '$($recovery['retryable'])'"
    }
    if ($recovery['requires_fresh_snapshot'] -ne $RequiresFreshSnapshot) {
        throw "Assert-EnvelopeRecovery: expected requires_fresh_snapshot $RequiresFreshSnapshot, got '$($recovery['requires_fresh_snapshot'])'"
    }
}

function Assert-EnvelopeSuggestion {
    <# Asserts a failed envelope's error.suggestion contains the given text. #>
    param(
        [Parameter(Mandatory = $true)]$Envelope,
        [Parameter(Mandatory = $true)][string]$Contains
    )
    $err = $Envelope['error']
    $suggestion = ''
    if ($err -and $err['suggestion']) { $suggestion = [string]$err['suggestion'] }
    if (-not $suggestion.Contains($Contains)) {
        throw "Assert-EnvelopeSuggestion: error.suggestion does not contain '$Contains' (got '$suggestion')"
    }
}

function Invoke-AgentDesktopWithExitCode {
    <#
    .SYNOPSIS
        The exit code Invoke-AgentDesktop discards. Calls the same one
        guarded door (Invoke-GuardedAgent) and returns plain fields, never a
        raw result: ExitCode and the parsed Envelope.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string[]]$Arguments, [int]$TimeoutSeconds = 20)
    $bin = Get-TargetBinary
    $full = @($bin.PrefixArgs) + $Arguments
    $result = Invoke-GuardedAgent -FilePath $bin.FilePath -ArgumentList $full -TimeoutSeconds $TimeoutSeconds
    if ([string]::IsNullOrWhiteSpace($result.StdOut)) {
        throw "Invoke-AgentDesktopWithExitCode: '$($Arguments -join ' ')' produced no stdout to parse (ExitCode=$($result.ExitCode), TimedOut=$($result.TimedOut))"
    }
    return [pscustomobject]@{
        ExitCode = [int]$result.ExitCode
        Envelope = (ConvertFrom-AgentJson -Json $result.StdOut)
    }
}

function Invoke-AgentDesktopBatch {
    <#
    .SYNOPSIS
        Builds a `batch` payload from Entries (each @{ Command; Args }),
        invokes it through Invoke-AgentDesktop (Lib.psm1's one staged-binary
        door) and flattens each result entry into a plain, safely-named
        object - never a raw envelope a caller could index into banned
        fields on. This is the mechanism macOS's own AE6 leg
        (tests/e2e/scenarios/acceptance.sh) uses: `batch` captures the
        signal baseline immediately before the acting entry runs, so an
        event a later entry waits for is detected against a truly
        pre-action baseline with no concurrency of any kind - one process,
        sequential entries, no detached spawn needed. Entries halt at the
        first failed one (--stop-on-error) unless -ContinueOnError is given.
    .OUTPUTS
        PSCustomObject[]: one entry per batch step - EntryOk, ErrorCode,
        ActionOk (Invoke-Target-shaped success), Found (wait's own
        data.found), EventKind, EventApp, EventSurface, EventWindowId.
        Fields that do not apply to a given entry's command are $null.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][hashtable[]]$Entries, [int]$TimeoutSeconds = 20, [switch]$ContinueOnError)
    $payload = @($Entries | ForEach-Object { @{ command = $_.Command; args = $_.Args } })
    $json = ConvertTo-Json -InputObject $payload -Depth 10 -Compress
    $batchArgs = @('batch', $json)
    if (-not $ContinueOnError) { $batchArgs += '--stop-on-error' }
    $envelope = Invoke-AgentDesktop -Arguments $batchArgs -TimeoutSeconds $TimeoutSeconds
    if ($envelope['ok'] -ne $true) {
        throw "Invoke-AgentDesktopBatch: the batch call itself failed: $($envelope['error']['code'])"
    }
    $results = $envelope['data']['results']
    if (-not $results) { throw 'Invoke-AgentDesktopBatch: batch response carried no results' }
    return @($results | ForEach-Object {
            $entryOk = ($_['ok'] -eq $true)
            $errorCode = $null
            $found = $null
            $eventKind = $null
            $eventApp = $null
            $eventSurface = $null
            $eventWindowId = $null
            if ($entryOk) {
                $data = $_['data']
                if ($data -and $data.ContainsKey('found')) { $found = [bool]$data['found'] }
                if ($data -and $data['event']) {
                    $eventData = $data['event']
                    $eventKind = $eventData['kind']
                    $eventApp = $eventData['app']
                    $eventSurface = $eventData['surface']
                    $eventWindowId = $eventData['window_id']
                }
            } else {
                $errorCode = $_['error']['code']
            }
            [pscustomobject]@{
                EntryOk       = $entryOk
                ErrorCode     = $errorCode
                Found         = $found
                EventKind     = $eventKind
                EventApp      = $eventApp
                EventSurface  = $eventSurface
                EventWindowId = $eventWindowId
            }
        })
}

function Test-EnvelopeValueEquals {
    <#
    .SYNOPSIS
        Whole-value equality for an envelope detail field, correct for both
        scalars and arrays. `$array -ne $other` is PowerShell's array-filter
        form (elements of $array not equal to $other, RHS never iterated),
        not a whole-array comparison - it is truthy even when both arrays
        print identically, which is exactly the shape
        `supported_surfaces = @('window','focused','sheet')` takes.
        Assert-Envelope's own -Details comparison calls this rather than a
        bare -ne/-eq for that reason.
    #>
    [CmdletBinding()]
    param($Actual, $Expected)
    $actualIsArray = ($Actual -is [array])
    $expectedIsArray = ($Expected -is [array])
    if ($actualIsArray -or $expectedIsArray) {
        if (-not $actualIsArray -or -not $expectedIsArray) { return $false }
        if ($Actual.Count -ne $Expected.Count) { return $false }
        for ($i = 0; $i -lt $Actual.Count; $i++) {
            if ($Actual[$i] -ne $Expected[$i]) { return $false }
        }
        return $true
    }
    return ($Actual -eq $Expected)
}

function Get-EnvelopeSurfaces {
    <#
    .SYNOPSIS
        Rule05 door for a list-surfaces envelope's data.surfaces array: the
        scenario asserts on surface kinds and ids without touching envelope
        fields directly.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Envelope)
    if ($Envelope['ok'] -ne $true) { throw 'Get-EnvelopeSurfaces: expected ok=true' }
    $data = $Envelope['data']
    if (-not $data -or -not $data['surfaces']) { throw 'Get-EnvelopeSurfaces: the envelope carries no surfaces array' }
    return $data['surfaces']
}

function Invoke-ShellSurfaceOpen {
    <#
    .SYNOPSIS
        open-system-surface's door: invokes the staged binary through
        Invoke-AgentDesktop (Lib.psm1's one door) and flattens the envelope
        into safe, non-banned-named fields - Opened, Surface, WindowId,
        ErrorCode - so a scenario never touches .ok/.error/.data itself
        (rule05 keeps that inside this module). WindowId is $null unless
        the open answered ok with a window identity; ErrorCode is $null
        unless it answered with an error.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Surface,
        [switch]$Headed,
        [int]$TimeoutSeconds = 30
    )
    $callArgs = @()
    if ($Headed) { $callArgs += '--headed' }
    $callArgs += @('open-system-surface', '--surface', $Surface)
    $envelope = Invoke-AgentDesktop -Arguments $callArgs -TimeoutSeconds $TimeoutSeconds
    $opened = ($envelope['ok'] -eq $true)
    $windowId = $null
    $errorCode = $null
    if ($opened) {
        $window = $envelope['data']['window']
        if ($window) { $windowId = [string]$window['id'] }
    } else {
        $err = $envelope['error']
        if ($err) { $errorCode = [string]$err['code'] }
    }
    return [pscustomobject]@{
        Opened    = $opened
        Surface   = $Surface
        WindowId  = $windowId
        ErrorCode = $errorCode
    }
}

function Invoke-ShellSurfaceSnapshot {
    <#
    .SYNOPSIS
        `snapshot --surface`'s door - the surface-shape sibling of
        Lib.psm1's Invoke-Snapshot, which has no --surface parameter and
        cannot grow one (the 400-line cap): the same safe-names flatten,
        plus the closed-surface refusal's ErrorCode/Suggestion so a leg can
        assert the closed state's own error shape. Root is the extracted
        tree, whose nodes' ref_id/native_id are plain tree data a caller
        may walk (Get-ShellTreeIdentityMarks) without touching an
        envelope.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Surface,
        [int]$TimeoutSeconds = 20
    )
    $envelope = Invoke-AgentDesktop -Arguments @('snapshot', '--surface', $Surface) -TimeoutSeconds $TimeoutSeconds
    $opened = ($envelope['ok'] -eq $true)
    $windowId = $null
    $snapshotId = $null
    $refCount = $null
    $complete = $null
    $root = $null
    $errorCode = $null
    $suggestion = $null
    if ($opened) {
        $data = $envelope['data']
        $window = $data['window']
        if ($window) { $windowId = [string]$window['id'] }
        $snapshotId = $data['snapshot_id']
        $refCount = $data['ref_count']
        $complete = $data['complete']
        $root = $data['tree']
    } else {
        $err = $envelope['error']
        if ($err) {
            $errorCode = [string]$err['code']
            $suggestion = [string]$err['suggestion']
        }
    }
    return [pscustomobject]@{
        Opened     = $opened
        Surface    = $Surface
        WindowId   = $windowId
        SnapshotId = $snapshotId
        RefCount   = $refCount
        Complete   = $complete
        Root       = $root
        ErrorCode  = $errorCode
        Suggestion = $suggestion
    }
}

Export-ModuleMember -Function @('Assert-EnvelopeCheckOccluder', 'Assert-EnvelopeRecovery', 'Assert-EnvelopeSuggestion', 'Invoke-AgentDesktopWithExitCode', 'Invoke-AgentDesktopBatch', 'Test-EnvelopeValueEquals', 'Get-EnvelopeSurfaces', 'Invoke-ShellSurfaceOpen', 'Invoke-ShellSurfaceSnapshot')
