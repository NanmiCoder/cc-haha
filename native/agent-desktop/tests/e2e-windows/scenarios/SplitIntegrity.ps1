#Requires -Version 5.1

<#
    SplitIntegrity.ps1 - U11: confirms live what four sub-phases could only
    unit-test - that a Medium-integrity observation read crosses the
    Medium/High boundary, an input write does not and surfaces a
    fail-closed envelope, and a capture behaves as measured - on staging
    A24-4 proved available on this class of box (CreateRestrictedToken +
    SetTokenInformation, confirmed by reading the live token back). The
    plan's own assumption that window activation *also* fails closed is
    measured false here (Invoke-SplitIntegrityActivationLeg) - Windows
    gates `SetForegroundWindow` by a foreground-lock-timeout heuristic, not
    by Mandatory Integrity Control, so a Medium `focus-window` against the
    High fixture genuinely succeeds.

    Every staged Medium/Low process here is spawned through
    `Start-StagedIntegrityProcess` (StagedProcess.psm1), never through
    `Invoke-GuardedAgent`, which is a .NET Process wrapper and structurally
    cannot run a caller-built restricted token. Every staged invocation that
    touches the fixture inherits the harness's own already-held
    `DesktopLease` handle exactly the way `Invoke-GuardedAgent` inherits it
    for a High-integrity spawn - self-acquiring instead would contend with
    the lock this scenario is already holding and return `TIMEOUT`, which
    the lease-adoption precondition leg exists to rule out before any effect
    leg's `PERM_DENIED` could be misread as that contention.
#>

Set-StrictMode -Version 2.0

$script:MediumSid = 'S-1-16-8192'
$script:LowSid = 'S-1-16-4096'

function Get-SplitIntegrityStagedBinary {
    <# The same staged, hash-verified agent-desktop.exe the High-side harness
       calls through Invoke-AgentDesktop (Lib.psm1's Get-TargetBinary), so a
       Medium/Low spawn runs the identical artifact under test. Passed
       explicitly into StagedProcess.psm1's Invoke-StagedAgentDesktop below,
       which must not itself depend on Lib.psm1. #>
    return (Get-TargetBinary).FilePath
}

function Assert-StagingConfirmedMedium {
    <# Staging is judged by the live process's own token read-back
       (Start-StagedIntegrityProcess already performs that read), never by
       CreateProcessAsUser's own return value - A24-4's route A measured a
       launcher that reported success while the launched process stayed
       High. This runs before any effect leg and fails the scenario, rather
       than skipping, on any reading that is not confirmed Medium. #>
    param([Parameter(Mandatory = $true)]$Staging)
    if (-not $Staging.LiveProcessIntegrityReadOk) {
        throw "Assert-StagingConfirmedMedium: could not read the staged process's own live token"
    }
    if ($Staging.LiveProcessIntegritySid -ne $script:MediumSid) {
        throw "Assert-StagingConfirmedMedium: staged process's live token reads '$($Staging.LiveProcessIntegritySid)', not Medium ($script:MediumSid)"
    }
    if (-not $Staging.IntegrityConfirmedNonHigh) {
        throw 'Assert-StagingConfirmedMedium: IntegrityConfirmedNonHigh is false despite a Medium SID reading'
    }
}

function Invoke-SplitIntegrityStagingLeg {
    <# Runs before the scenario's main DesktopLease stage opens - spawns a
       helper and reads its own token back, never touching the fixture or
       lease. Its own top-level Enter-Stage -Lock DesktopLease, entered and
       exited here before the scenario's stage opens (never nested inside
       it), is rule09's requirement on this leg's Start-StagedIntegrityProcess
       call - the same "two independent top-level blocks" shape
       Observation.ps1/Chromium.ps1 use, since DesktopLease refuses reentry. #>
    param([Parameter(Mandatory = $true)][string]$App)
    Enter-Stage -Lock DesktopLease -Body {
        $result = Start-StagedIntegrityProcess -IntegrityLevel Medium -ReportOwnHandles -TimeoutSeconds 15
        Assert-StagingConfirmedMedium -Staging $result
        Add-Pass -Leg 'split-integrity-staging-confirmed'
    }
}

function Invoke-LeaseAdoptionPreconditionLeg {
    <# The lease-adoption precondition, run before any effect leg: a
       trivially-leased command from a staged Medium process that INHERITS
       the harness's already-held DesktopLease must never see
       error.details.kind of `lock_timeout` or
       `interaction_process_lock_timeout` - that is what stops a
       lease-adoption failure from being read as a UIPI denial later.
       `focus-window` against the fixture's own window id, not the plan's
       named `focus <ref>`: measured live, `focus <ref>` first runs the
       ref-resolving actionability preflight, which times out on its own
       (`actionability_timeout`) well before the command ever reaches the
       interaction lease at Medium integrity, masking the very signal this
       leg needs - a window-level command reaches the lease with no
       per-element preflight in between. The negative control lives in this
       same leg: the identical command staged WITHOUT lease inheritance,
       while the harness still holds the lock, must see exactly one of
       those two kinds - proving the positive half is not vacuously true
       because nothing in this environment can ever produce a
       lock_timeout. #>
    param([Parameter(Mandatory = $true)][string]$WindowId, [Parameter(Mandatory = $true)][long]$LeaseHandle)

    $adopted = Invoke-StagedAgentDesktop -IntegrityLevel Medium -FilePath (Get-SplitIntegrityStagedBinary) -InheritLeaseHandle $LeaseHandle `
        -Arguments @('focus-window', '--window-id', $WindowId) -TimeoutSeconds 20
    $adoptedKind = $null
    if ($adopted.Envelope['ok'] -eq $false) { $adoptedKind = $adopted.Envelope['error']['details']['kind'] }
    if ($adoptedKind -eq 'lock_timeout' -or $adoptedKind -eq 'interaction_process_lock_timeout') {
        throw "Invoke-LeaseAdoptionPreconditionLeg: lease-inheriting spawn still reported '$adoptedKind' - the staged process self-acquired instead of adopting"
    }

    $selfAcquired = Invoke-StagedAgentDesktop -IntegrityLevel Medium -FilePath (Get-SplitIntegrityStagedBinary) `
        -Arguments @('focus-window', '--window-id', $WindowId) -TimeoutSeconds 20
    $selfAcquiredKind = $null
    if ($selfAcquired.Envelope['ok'] -eq $false) { $selfAcquiredKind = $selfAcquired.Envelope['error']['details']['kind'] }
    if ($selfAcquiredKind -ne 'lock_timeout' -and $selfAcquiredKind -ne 'interaction_process_lock_timeout') {
        throw "Invoke-LeaseAdoptionPreconditionLeg: negative control expected a lock_timeout kind from a non-inheriting spawn contending the held lease, got '$selfAcquiredKind' (ok=$($selfAcquired.Envelope['ok']))"
    }

    Add-Pass -Leg 'split-integrity-lease-adoption-precondition'
}

function Invoke-InheritedHandleSetLeg {
    <# Step 3b-i: the staged spawn's inherited handle set is bounded to the
       lease handle plus its own stdio. Compared as: every handle value the
       child reports that ALSO appears in the harness's own pre-spawn
       inheritable set must be one this spawn deliberately arranged - any
       other coincidence is a leaked harness handle. A handle the child
       reports that the harness never had inheritable is the child's own
       post-exec allocation (its console/CLR startup), not a leak, and is
       not asserted on. Its own Enter-Stage -Lock ForegroundStage wraps this
       leg's entire body: called with only DesktopLease held (the lease-
       adoption leg's own ForegroundStage use has already exited by here),
       so entering ForegroundStage is the next stage in order. #>
    param([Parameter(Mandatory = $true)][long]$LeaseHandle)
    Enter-Stage -Lock ForegroundStage -Body {
        $result = Start-StagedIntegrityProcess -IntegrityLevel Medium -ReportOwnHandles -InheritLeaseHandle $LeaseHandle -TimeoutSeconds 15
        Assert-StagingConfirmedMedium -Staging $result
        if ($null -eq $result.ChildReportedInheritableHandles -or @($result.ChildReportedInheritableHandles).Count -eq 0) {
            throw "Invoke-InheritedHandleSetLeg: the staged child reported no handle set at all - a live child always owns its stdio handles, so an empty report means the report did not happen (ExitCode=$($result.ExitCode), TimedOut=$($result.TimedOut), StdErr='$($result.StdErr)')"
        }
        $leaked = @($result.ChildReportedInheritableHandles | Where-Object {
                ($result.HarnessInheritableHandlesBeforeSpawn -contains $_) -and (-not ($result.ExpectedInheritableHandles -contains $_))
            })
        if ($leaked.Count -gt 0) {
            throw "Invoke-InheritedHandleSetLeg: the staged child inherited $($leaked.Count) harness handle(s) beyond the lease and its own stdio: $($leaked -join ',')"
        }
        Add-Pass -Leg 'split-integrity-inherited-handle-set-bounded'
    }
}

function Invoke-SplitIntegrityReadLeg {
    param([Parameter(Mandatory = $true)][string]$App)
    $result = Invoke-StagedAgentDesktop -IntegrityLevel Medium -FilePath (Get-SplitIntegrityStagedBinary) -Arguments @('snapshot', '--app', $App) -TimeoutSeconds 20
    Assert-StagingConfirmedMedium -Staging $result.Staging
    if ($result.Envelope['ok'] -ne $true) {
        throw "Invoke-SplitIntegrityReadLeg: Medium-side snapshot failed: $($result.Envelope['error']['code'])"
    }
    $refCount = $result.Envelope['data']['ref_count']
    if (-not $refCount -or [int]$refCount -le 0) {
        throw "Invoke-SplitIntegrityReadLeg: Medium-side snapshot returned ref_count $refCount, expected a non-zero tree"
    }
    Add-Pass -Leg 'split-integrity-read-crosses'
}

function Assert-MediumActionFailsClosed {
    <# The fail-closed envelope every ref-resolving action from Medium
       against the High fixture actually produces, and why it is asserted
       as a set rather than a single code: measured live, `snapshot --app`
       crosses (read_leg, ref_count > 0) but the tree it returns is exactly
       the top-level window, with no descendant walked - a genuinely
       degraded read, not a full one. A ref-resolving command therefore has
       nothing of its own to resolve against and fails STRICT
       re-identification (`STALE_REF`/`resolve_no_candidate`, inside an
       `actionability_timeout`) before it ever reaches the input-delivery
       boundary `PERM_DENIED` names. Both are genuine fail-closed, nothing-
       landed outcomes for the same reason the plan's own read leg accepts
       either a populated or a `None` `process_instance` branch (KTD3's
       fail-closed elevated-process path) rather than pre-judging it -
       this is that same branch firing one step earlier than the plan's
       text anticipated, recorded rather than forced into a single code. #>
    param([Parameter(Mandatory = $true)]$Envelope, [Parameter(Mandatory = $true)][string]$LegLabel)
    if ($Envelope['ok'] -ne $false) {
        throw "${LegLabel}: expected a fail-closed envelope from Medium, got ok=true"
    }
    $code = $Envelope['error']['code']
    $kind = $null
    if ($Envelope['error']['details']) { $kind = $Envelope['error']['details']['kind'] }
    $isPermDenied = ($code -eq 'PERM_DENIED')
    $isDegradedResolution = ($code -eq 'STALE_REF') -or ($code -eq 'TIMEOUT' -and $kind -eq 'actionability_timeout')
    if (-not $isPermDenied -and -not $isDegradedResolution) {
        throw "${LegLabel}: expected PERM_DENIED, STALE_REF, or a TIMEOUT/actionability_timeout resolution failure from Medium, got code='$code' kind='$kind'"
    }
    if ($Envelope['error']['disposition']['delivery'] -ne 'not_delivered') {
        throw "${LegLabel}: expected disposition.delivery 'not_delivered', got '$($Envelope['error']['disposition']['delivery'])'"
    }
    $branch = if ($isPermDenied) { 'PERM_DENIED' } else { "$code/$kind" }
    Write-Host "$LegLabel branch: $branch"
    return $branch
}

function Invoke-SplitIntegrityWriteLeg {
    <# Two checks, not one. A fail-closed envelope from Medium
       (Assert-MediumActionFailsClosed), plus an independent High-side
       re-read of text-status proving nothing landed (A9-3 measured
       SendInput reporting success in both arms, so the envelope alone is
       not evidence) - and a control proving that same High-side oracle
       actually moves when the identical write is issued from High. #>
    param([Parameter(Mandatory = $true)][string]$App, [Parameter(Mandatory = $true)][long]$LeaseHandle)
    $textInput = Require-Target -Target (Find-Target -App $App -NativeId 'text-input' -TimeoutSeconds 10) -Description 'text-input'
    $status = Require-Target -Target (Find-Target -App $App -NativeId 'text-status' -TimeoutSeconds 10) -Description 'text-status'
    $baseline = Get-Target -Target $status -Property 'value'

    $medium = Invoke-StagedAgentDesktop -IntegrityLevel Medium -FilePath (Get-SplitIntegrityStagedBinary) -InheritLeaseHandle $LeaseHandle `
        -Arguments @('set-value', $textInput.RefId, 'medium-write-attempt') -TimeoutSeconds 20
    Assert-StagingConfirmedMedium -Staging $medium.Staging
    Assert-MediumActionFailsClosed -Envelope $medium.Envelope -LegLabel 'Invoke-SplitIntegrityWriteLeg'

    $afterDeniedWrite = Get-Target -Target $status -Property 'value'
    if ($afterDeniedWrite -ne $baseline) {
        throw "Invoke-SplitIntegrityWriteLeg: text-status changed from '$baseline' to '$afterDeniedWrite' despite a PERM_DENIED Medium write"
    }

    <# Control: the same write from the High session must move the oracle,
       proving the unchanged-status re-read above is live evidence rather
       than a status nothing ever updates. Wrapped in its own
       Enter-Stage -Lock ForegroundStage since only DesktopLease is held
       here - the next stage in order, for this one Invoke-Target site. #>
    Enter-Stage -Lock ForegroundStage -Body {
        Invoke-Target -Target $textInput -Action 'set-value' -ActionArgs @('high-write-control') -RequireOk -Description 'text-input (control)' | Out-Null
    }
    $afterControlWrite = Get-Target -Target $status -Property 'value'
    if ($afterControlWrite -eq $baseline) {
        throw "Invoke-SplitIntegrityWriteLeg: control write from the High session did not change text-status - the oracle itself is not falsifiable"
    }

    Add-Pass -Leg 'split-integrity-write-denied'
}

function Invoke-SplitIntegrityActivationLeg {
    <# The window-activation expectation was that Medium->High
       `focus-window` "silently no-ops" and surfaces `ACTION_FAILED` /
       `not_delivered` - measured live, against a genuine Medium-integrity
       process with a foreground precondition that rules out a no-op
       success, it does not: `focus-window` returns `ok:true` and the raw
       `GetForegroundWindow` re-read confirms the fixture genuinely became
       foreground. This is consistent with `SetForegroundWindow` on Windows
       being gated by the foreground-lock-timeout heuristic (recent input,
       `AllowSetForegroundWindow`), not by Mandatory Integrity Control the
       way `SendInput`/`PostMessage` are - UIPI does not cover this API.
       This leg asserts the measured behavior rather than the
       disproven one, with the same independent-oracle discipline every
       other leg here uses: a raw GetForegroundWindow read, not the
       command's own envelope. The whole body runs inside its own
       Enter-Stage -Lock ForegroundStage - only DesktopLease is held when
       this leg is called (the write leg's own ForegroundStage use has
       already exited), so this is the next stage in order, and rule09
       requires every Native*/staged call site below to be inside it. #>
    param([Parameter(Mandatory = $true)][string]$App, [Parameter(Mandatory = $true)][long]$LeaseHandle)
    Enter-Stage -Lock ForegroundStage -Body {
        $windowId = Get-MainFixtureWindowId -App $App
        $fixtureHandle = ConvertTo-NativeWindowHandle -WindowId $windowId

        <# Unfalsifiable-precondition guard (Assert-Effect's own pattern): a
           freshly-launched, non-activating fixture can still settle as
           foreground with nothing else competing for it on this desktop,
           which would make a Medium focus-window's `ok:true` ambiguous
           between "it genuinely activated the window" and "it was already
           there." Any other real top-level window on the desktop is stolen
           to the foreground first, through the same raw
           Set-NativeForegroundWindow this harness already uses for R14
           preconditions - never through the product - and the steal is
           verified before the leg proceeds. #>
        $stealCandidate = Get-NativeTopLevelWindows | Where-Object { $_.Handle -ne $fixtureHandle -and $_.Handle -ne [IntPtr]::Zero } | Select-Object -First 1
        if ($stealCandidate) {
            [void](Set-NativeForegroundWindow -WindowHandle $stealCandidate.Handle)
        }
        $beforeForeground = Get-NativeForegroundWindowHandle
        if ($beforeForeground -eq $fixtureHandle) {
            throw 'Invoke-SplitIntegrityActivationLeg: could not steal foreground away from the fixture before the leg - the precondition would be unfalsifiable'
        }

        $medium = Invoke-StagedAgentDesktop -IntegrityLevel Medium -FilePath (Get-SplitIntegrityStagedBinary) -InheritLeaseHandle $LeaseHandle `
            -Arguments @('focus-window', '--window-id', $windowId) -TimeoutSeconds 20
        Assert-StagingConfirmedMedium -Staging $medium.Staging
        if ($medium.Envelope['ok'] -ne $true) {
            throw "Invoke-SplitIntegrityActivationLeg: expected Medium focus-window to succeed (measured behavior), got ok=false code=$($medium.Envelope['error']['code'])"
        }

        $afterForeground = Get-NativeForegroundWindowHandle
        if ($afterForeground -ne $fixtureHandle) {
            throw "Invoke-SplitIntegrityActivationLeg: focus-window reported ok=true but raw GetForegroundWindow ($afterForeground) never became the fixture ($fixtureHandle) - the envelope and the independent oracle disagree"
        }

        Add-Pass -Leg 'split-integrity-activation-recorded'
    }
}

function Invoke-SplitIntegrityCaptureLeg {
    <# Records which branch fired and whether pixels were produced - closing
       A22-7's medium_printwindow_launch_failed rather than pre-judging it. #>
    param([Parameter(Mandatory = $true)][string]$App, [Parameter(Mandatory = $true)][long]$LeaseHandle)
    $windowId = Get-MainFixtureWindowId -App $App
    $outputPath = Join-Path $env:TEMP ('split-integrity-capture-' + [guid]::NewGuid().ToString('N') + '.png')

    $medium = Invoke-StagedAgentDesktop -IntegrityLevel Medium -FilePath (Get-SplitIntegrityStagedBinary) -InheritLeaseHandle $LeaseHandle `
        -Arguments @('screenshot', '--window-id', $windowId, $outputPath) -TimeoutSeconds 20
    Assert-StagingConfirmedMedium -Staging $medium.Staging

    $pixelsProduced = $false
    if ($medium.Envelope['ok'] -eq $true -and (Test-Path -LiteralPath $outputPath)) {
        $pixelsProduced = ((Get-Item -LiteralPath $outputPath).Length -gt 0)
    }
    Write-Host ("SplitIntegrity capture leg: ok={0} errorCode={1} pixelsProduced={2}" -f `
            $medium.Envelope['ok'], $(if ($medium.Envelope['ok'] -ne $true) { $medium.Envelope['error']['code'] } else { '<none>' }), $pixelsProduced)
    Remove-ItemRecoverable -Path $outputPath | Out-Null

    <# Which branch the product took is still recorded rather than
       pre-judged: a refusal across the integrity boundary is a documented
       outcome and passes. What does not pass is a success envelope with no
       pixels behind it. That combination was computed and discarded here,
       so a capture reporting ok:true over a zero-byte PNG went unnoticed -
       and a capture path that silently produced nothing is exactly what
       this leg exists to catch. #>
    if ($medium.Envelope['ok'] -eq $true -and -not $pixelsProduced) {
        Add-Fail -Leg 'split-integrity-capture-recorded' -Reason 'the capture reported ok:true but produced no pixels'
        return
    }
    Add-Pass -Leg 'split-integrity-capture-recorded'
}

function Invoke-SplitIntegrityScenario {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$App)
    Register-Legs -Names @(
        'split-integrity-staging-confirmed',
        'split-integrity-lease-adoption-precondition',
        'split-integrity-inherited-handle-set-bounded',
        'split-integrity-read-crosses',
        'split-integrity-write-denied',
        'split-integrity-activation-recorded',
        'split-integrity-capture-recorded'
    )

    try {
        Invoke-SplitIntegrityStagingLeg -App $App
    } catch {
        Add-Fail -Leg 'split-integrity-staging-confirmed' -Reason $_.Exception.Message
        throw
    }

    Enter-Stage -Lock DesktopLease -Body {
        $leaseHandle = [long](Get-DesktopLeaseHandleValue)
        $windowId = Get-MainFixtureWindowId -App $App

        Enter-Stage -Lock ForegroundStage -Body {
            try {
                Invoke-LeaseAdoptionPreconditionLeg -WindowId $windowId -LeaseHandle $leaseHandle
            } catch {
                Add-Fail -Leg 'split-integrity-lease-adoption-precondition' -Reason $_.Exception.Message
                throw
            }
        }

        try {
            Invoke-InheritedHandleSetLeg -LeaseHandle $leaseHandle
        } catch {
            Add-Fail -Leg 'split-integrity-inherited-handle-set-bounded' -Reason $_.Exception.Message
            throw
        }

        try {
            Invoke-SplitIntegrityReadLeg -App $App
        } catch {
            Add-Fail -Leg 'split-integrity-read-crosses' -Reason $_.Exception.Message
            throw
        }

        try {
            Invoke-SplitIntegrityWriteLeg -App $App -LeaseHandle $leaseHandle
        } catch {
            Add-Fail -Leg 'split-integrity-write-denied' -Reason $_.Exception.Message
            throw
        }

        <# No outer ForegroundStage wrap here (unlike lease-adoption above):
           Invoke-SplitIntegrityActivationLeg opens ForegroundStage itself
           around its whole body - a caller-side wrap does not lexically
           enclose (rule09) the calls inside a separately-defined function. #>
        try {
            Invoke-SplitIntegrityActivationLeg -App $App -LeaseHandle $leaseHandle
        } catch {
            Add-Fail -Leg 'split-integrity-activation-recorded' -Reason $_.Exception.Message
            throw
        }

        try {
            Invoke-SplitIntegrityCaptureLeg -App $App -LeaseHandle $leaseHandle
        } catch {
            Add-Fail -Leg 'split-integrity-capture-recorded' -Reason $_.Exception.Message
            throw
        }
    }
}
