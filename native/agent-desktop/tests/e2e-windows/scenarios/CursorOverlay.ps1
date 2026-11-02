#Requires -Version 5.1

<#
    CursorOverlay.ps1 - the cursor overlay's properties asserted by
    independent observation, never by the product's own envelope. Five
    legs, matching the plan's own list: the overlay paints (a screen pixel,
    KTD8/A29-4 - hit-testing cannot be the oracle because WS_EX_TRANSPARENT
    makes a layered window invisible to WindowFromPoint), it does not take
    the foreground, it does not intercept input, its cursor arrives before
    the action it precedes dispatches, and teardown leaves nothing behind.

    The click-through leg's raw click is synthesized with
    ChromiumNative.psm1's SetCursorPos/mouse_event - never an agent-desktop
    command: a headless action sends no pointer input at all, and a headed
    one is preceded by dispatch's own Hide control, so either would let this
    leg pass even with WS_EX_TRANSPARENT dropped from the renderer.

    The pixel oracle counts pixels of one exact colour nothing else on this
    desktop uses: `cursor-overlay enable --fill '#FF00FF' --rim '#FF00FF'`
    makes the glyph's fill AND its rim the same magenta, so any sampled
    point across the whole glyph (not only its interior) reads that one
    value - never "a pixel that changed", which A29's own probe measured
    giving 8-of-41 false positives from ordinary desktop churn on a control
    run with no overlay at all. NativeDesktop.psm1's Get-NativeScreenPixel
    is that oracle, proved in both directions: it reads the configured
    magenta while the overlay is up (this file's paint leg) and reads the
    pre-enable baseline back once torn down (the teardown leg) - the same
    two-direction proof A29-3 made for the standalone probe window this
    ports from.

    A single session and one Enable, shared by the paint/foreground/click-
    through/arrival legs (mirrors an interactive caller: enable once, then
    perform several actions), rather than a fresh renderer per leg - this
    minimizes the spawn/teardown cycles a shared job-object survival
    property (measured live: the renderer outlives the per-invocation
    bounding job Invoke-BoundedProcess wraps every staged-binary call in,
    confirmed empirically against this exact binary before this file was
    written) has to hold across. Every renderer this scenario starts is
    reaped by session id (CursorOverlaySupport.psm1's
    Get-CursorOverlayChildProcessesForSession) in the teardown leg AND in
    this file's own top-level `finally`, so a leg that throws mid-way still
    cannot leave a renderer running past this scenario - the suite fails
    the teardown leg rather than silently leaking a topmost window into
    every scenario that runs after it.
#>

Set-StrictMode -Version 2.0

Import-Module (Join-Path $PSScriptRoot '..\ChromiumNative.psm1') -Force -Global
Import-Module (Join-Path $PSScriptRoot '..\CursorOverlaySupport.psm1') -Force -Global

$script:CursorOverlayMagenta = '#FF00FF'

function Close-CursorOverlayHarnessSession {
    param([Parameter(Mandatory = $true)][string]$SessionId)
    try { Enter-Stage -Lock DesktopLease -Body { Invoke-AgentDesktop -Arguments @('session', 'end', $SessionId) | Out-Null } } catch { }
}

function Invoke-CursorOverlayScenario {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$App)
    $legs = @(
        'cursor-overlay-paints', 'cursor-overlay-no-foreground-steal', 'cursor-overlay-click-through',
        'cursor-overlay-at-destination-after-bounded-action', 'cursor-overlay-teardown-clean'
    )
    Register-Legs -Names $legs

    $script:cursorOverlaySessionId = $null
    $script:cursorOverlayRestingPoint = $null
    $script:cursorOverlayPreEnablePixel = $null
    try {
        try {
            Invoke-CursorOverlaySetupAndPaintLeg
        } catch {
            foreach ($leg in $legs) { Add-Fail -Leg $leg -Reason "setup/paint failed: $($_.Exception.Message)" }
            return
        }

        Invoke-CursorOverlayForegroundLeg -App $App
        Invoke-CursorOverlayClickThroughLeg -App $App
        Invoke-CursorOverlayAtDestinationLeg -App $App
        Invoke-CursorOverlayTeardownLeg -App $App
    } finally {
        <# Safety net, not the authoritative check: the teardown leg's own
           assertion is what fails the run on a survivor. This best-effort
           sweep only stops one leg's leak from contaminating every
           scenario that runs after this one in the same suite invocation. #>
        if ($script:cursorOverlaySessionId) {
            $survivors = Get-CursorOverlayChildProcessesForSession -SessionId $script:cursorOverlaySessionId
            foreach ($survivor in $survivors) { Stop-Process -Id $survivor.ProcessId -Force -ErrorAction SilentlyContinue }
            Close-CursorOverlayHarnessSession -SessionId $script:cursorOverlaySessionId
        }
    }
}

function Invoke-CursorOverlaySetupAndPaintLeg {
    <# 'cursor-overlay-paints': Enable alone - no action needed - places the
       renderer's pose at monitors::resting_point (the primary monitor's
       work-area centre), so the paint leg samples there directly rather
       than driving an action first. #>
    Enter-Stage -Lock DesktopLease -Body {
        $startEnvelope = Invoke-AgentDesktop -Arguments @('session', 'start') -RequireOk -Description 'session start'
        $sessionId = $startEnvelope['data']['session_id']
        if (-not $sessionId) { throw 'session start returned no session_id' }
        $script:cursorOverlaySessionId = $sessionId
        $env:AGENT_DESKTOP_SESSION = $sessionId

        $resting = Get-CursorOverlayRestingPoint
        $script:cursorOverlayRestingPoint = $resting
        $offsets = Get-CursorOverlayInteriorOffsets
        $expected = ConvertTo-CursorOverlayColorref -Hex $script:CursorOverlayMagenta

        <# Pre-enable baseline, read through the SAME oracle the paint leg
           and the teardown leg both use - this is the value teardown must
           restore, proving the pixel oracle round-trips rather than only
           reading one direction. #>
        $preEnable = Get-NativeScreenPixel -X ($resting.X + $offsets[0].X) -Y ($resting.Y + $offsets[0].Y)
        $script:cursorOverlayPreEnablePixel = $preEnable

        $enableEnvelope = Invoke-AgentDesktop -Arguments @(
            'cursor-overlay', 'enable', '--fill', $script:CursorOverlayMagenta, '--rim', $script:CursorOverlayMagenta
        ) -RequireOk -Description 'cursor-overlay enable'
        if ($enableEnvelope['data']['rendered'] -ne $true) {
            throw "cursor-overlay enable reported rendered=$($enableEnvelope['data']['rendered']), expected true"
        }

        $deadline = [System.Diagnostics.Stopwatch]::StartNew()
        $painted = $false
        while (-not $painted -and $deadline.Elapsed.TotalSeconds -lt 5) {
            foreach ($offset in $offsets) {
                $pixel = Get-NativeScreenPixel -X ($resting.X + $offset.X) -Y ($resting.Y + $offset.Y)
                if ($pixel -eq $expected) { $painted = $true; break }
            }
            if (-not $painted) { Start-Sleep -Milliseconds 150 }
        }
        if (-not $painted) {
            throw "no interior offset near the resting point ($($resting.X),$($resting.Y)) read the configured colour $($script:CursorOverlayMagenta) within 5s"
        }
        Add-Pass -Leg 'cursor-overlay-paints'
    }
}

function Invoke-CursorOverlayForegroundLeg {
    <# 'cursor-overlay-no-foreground-steal': steals the OS foreground to the
       fixture first (falsifiability guard - a comparison against whatever
       happened to be foreground already would prove nothing), enables and
       drives a headless click, and requires the foreground to be exactly
       what it was before. A sensitivity control runs AFTER the real
       assertion already passed: it deliberately steals foreground
       elsewhere and confirms the same oracle reports the change, proving
       the read is live rather than a cached value that could never fail. #>
    param([Parameter(Mandatory = $true)][string]$App)
    try {
        Enter-Stage -Lock DesktopLease -Body {
            Enter-Stage -Lock ForegroundStage -Body {
                $windowId = Get-WindowId -Where { $_['title'] -eq 'AgentDeskFixture' } -TimeoutSeconds 10
                if (-not $windowId) { throw 'could not resolve the fixture window id' }
                $fixtureHandle = ConvertTo-NativeWindowHandle -WindowId $windowId
                if (-not (Set-NativeForegroundWindow -WindowHandle $fixtureHandle)) {
                    throw 'could not steal foreground to the fixture before the leg - the precondition would be unfalsifiable'
                }
                $before = Get-NativeForegroundWindowHandle
                if ($before -ne $fixtureHandle) { throw 'fixture did not become foreground after the steal' }

                $target = Require-Target -Target (Find-Target -App $App -NativeId 'primary-button' -TimeoutSeconds 10) -Description 'primary-button'
                Invoke-Target -Target $target -Action 'click' -RequireOk -Description 'primary-button' | Out-Null

                $after = Get-NativeForegroundWindowHandle
                if ($after -ne $before) {
                    throw "foreground changed from $before to $after across an enabled overlay's headless click"
                }

                <# Sensitivity control: prove the oracle is live, not stuck. #>
                $others = @(Get-NativeTopLevelWindows | Where-Object { $_.Handle -ne $fixtureHandle -and $_.Handle -ne [IntPtr]::Zero })
                if ($others.Count -eq 0) {
                    throw 'sensitivity control: no second top-level window exists to steal foreground to - the foreground oracle was never shown to be live, so a pass would be unfalsifiable'
                }
                [void](Set-NativeForegroundWindow -WindowHandle $others[0].Handle)
                $stolen = Get-NativeForegroundWindowHandle
                if ($stolen -eq $fixtureHandle) {
                    throw 'sensitivity control: stealing foreground away did not change the oracle reading - Get-NativeForegroundWindowHandle would never fail this leg'
                }
                [void](Set-NativeForegroundWindow -WindowHandle $fixtureHandle)
            }
        }
        Add-Pass -Leg 'cursor-overlay-no-foreground-steal'
    } catch {
        Add-Fail -Leg 'cursor-overlay-no-foreground-steal' -Reason $_.Exception.Message
    }
}

function Invoke-CursorOverlayClickThroughLeg {
    <# 'cursor-overlay-click-through': the raw click is synthesized with
       ChromiumNative.psm1's Invoke-ChromiumNativeLeftClick (SetCursorPos +
       mouse_event) at the exact screen point the overlay is currently
       painted over primary-button - never through an agent-desktop
       command. A negative control (no click, oracle must stay put) runs
       before the positive click, proving the AnyChange read used below
       would report "unchanged" if the click never reached the button
       (e.g. a non-transparent overlay swallowing it) rather than
       spuriously always reporting a change. #>
    param([Parameter(Mandatory = $true)][string]$App)
    try {
        Enter-Stage -Lock DesktopLease -Body {
            $target = Require-Target -Target (Find-Target -App $App -NativeId 'primary-button' -TimeoutSeconds 10) -Description 'primary-button'
            $status = Require-Target -Target (Find-Target -App $App -NativeId 'click-status' -TimeoutSeconds 10) -Description 'click-status'
            $center = Get-CursorOverlayElementCenter -Target $target

            Invoke-Target -Target $target -Action 'click' -RequireOk -Description 'primary-button (setup)' | Out-Null
            $afterSetupClick = Get-Target -Target $status -Property 'value'

            Start-Sleep -Milliseconds 400
            $stillSetup = Get-Target -Target $status -Property 'value'
            if ($stillSetup -ne $afterSetupClick) {
                throw "negative control: click-status changed to '$stillSetup' with no click fired - the oracle is not stable enough to trust"
            }

            $offsets = Get-CursorOverlayInteriorOffsets
            $expected = ConvertTo-CursorOverlayColorref -Hex $script:CursorOverlayMagenta
            $overOverlay = $false
            foreach ($offset in $offsets) {
                $pixel = Get-NativeScreenPixel -X ($center.X + $offset.X) -Y ($center.Y + $offset.Y)
                if ($pixel -eq $expected) { $overOverlay = $true; break }
            }
            if (-not $overOverlay) {
                throw "the overlay is not painted over primary-button at ($($center.X),$($center.Y)) - the click-through leg would be testing nothing"
            }

            Invoke-ChromiumNativeLeftClick -X $center.X -Y $center.Y

            $deadline = [System.Diagnostics.Stopwatch]::StartNew()
            $changed = $false
            $lastSeen = $stillSetup
            while (-not $changed -and $deadline.Elapsed.TotalSeconds -lt 8) {
                $lastSeen = Get-Target -Target $status -Property 'value'
                if ($lastSeen -ne $afterSetupClick) { $changed = $true; break }
                Start-Sleep -Milliseconds 150
            }
            if (-not $changed) {
                throw "a raw click at ($($center.X),$($center.Y)) - over the painted overlay - never reached primary-button: click-status stayed '$lastSeen'"
            }
        }
        Add-Pass -Leg 'cursor-overlay-click-through'
    } catch {
        Add-Fail -Leg 'cursor-overlay-click-through' -Reason $_.Exception.Message
    }
}

function Invoke-CursorOverlayAtDestinationLeg {
    <# 'cursor-overlay-at-destination-after-bounded-action': the leg is named
       for what it proves and not for the ordering it cannot see. A black-box
       CLI harness cannot race the overlay's internal ack-then-dispatch
       ordering inside one synchronous invocation (rule10 allows the staged binary to be
       invoked only through Invoke-GuardedAgent, so no concurrent sampling
       during the call is possible either). What IS externally observable,
       proved in both directions: before the command runs, the destination
       pixel does NOT yet read the overlay's colour; after the single
       set-value command returns, it does, and text-status has moved -
       and the whole round trip is bounded rather than unbounded, which is
       R12's "never fails/blocks the action" half. The "not yet there"
       state is established by an explicit reset click on primary-button
       immediately beforehand, rather than assumed from wherever an earlier
       leg happened to leave the cursor - primary-button and text-input are
       273 logical pixels apart vertically (measured against this fixture's
       own reported bounds), so this is not merely a formality. #>
    param([Parameter(Mandatory = $true)][string]$App)
    try {
        Enter-Stage -Lock DesktopLease -Body {
            <# Scroll FIRST, then reset. scroll-to is itself a semantic
               action, so it presents the cursor to the element it scrolls
               to - doing it after the reset click would walk the cursor
               back onto text-input and invalidate the very precondition
               below, which is what made this leg fail intermittently
               depending on whether a scroll was needed at all. The reset
               click has to be the last thing that moves the cursor. #>
            $scrollTarget = Require-Target -Target (Find-Target -App $App -NativeId 'text-input' -TimeoutSeconds 10) -Description 'text-input (scroll into view)'
            Invoke-Target -Target $scrollTarget -Action 'scroll-to' -RequireOk -Description 'text-input (scroll into view)' | Out-Null

            $resetTarget = Require-Target -Target (Find-Target -App $App -NativeId 'primary-button' -TimeoutSeconds 10) -Description 'primary-button (reset)'
            Invoke-Target -Target $resetTarget -Action 'click' -RequireOk -Description 'primary-button (reset)' | Out-Null

            <# Re-read after both moves: the scroll and the click can each
               change where text-input sits, and a centre computed before
               them would be sampled in the wrong place. #>
            $target = Require-Target -Target (Find-Target -App $App -NativeId 'text-input' -TimeoutSeconds 10) -Description 'text-input'
            $status = Require-Target -Target (Find-Target -App $App -NativeId 'text-status' -TimeoutSeconds 10) -Description 'text-status'
            $center = Get-CursorOverlayElementCenter -Target $target
            $baseline = Get-Target -Target $status -Property 'value'

            $offsets = Get-CursorOverlayInteriorOffsets
            $expected = ConvertTo-CursorOverlayColorref -Hex $script:CursorOverlayMagenta
            $alreadyThere = $false
            foreach ($offset in $offsets) {
                $pixel = Get-NativeScreenPixel -X ($center.X + $offset.X) -Y ($center.Y + $offset.Y)
                if ($pixel -eq $expected) { $alreadyThere = $true; break }
            }
            if ($alreadyThere) {
                throw 'unfalsifiable precondition: the overlay already reads the configured colour at text-input right after an explicit reset click on primary-button, 273px away'
            }

            $clock = [System.Diagnostics.Stopwatch]::StartNew()
            Invoke-Target -Target $target -Action 'set-value' -ActionArgs @('cursor-arrival-check') -RequireOk -Description 'text-input' | Out-Null
            $clock.Stop()

            $arrived = $false
            foreach ($offset in $offsets) {
                $pixel = Get-NativeScreenPixel -X ($center.X + $offset.X) -Y ($center.Y + $offset.Y)
                if ($pixel -eq $expected) { $arrived = $true; break }
            }
            if (-not $arrived) {
                throw "the overlay never read the configured colour at text-input ($($center.X),$($center.Y)) after the action returned"
            }
            $afterStatus = Get-Target -Target $status -Property 'value'
            if ($afterStatus -eq $baseline) {
                throw "text-status did not change from '$baseline' after set-value"
            }
            if ($clock.Elapsed.TotalMilliseconds -gt 5000) {
                throw "the overlaid action took $($clock.Elapsed.TotalMilliseconds)ms - the arrival wait is supposed to be bounded, not indefinite"
            }
        }
        Add-Pass -Leg 'cursor-overlay-at-destination-after-bounded-action'
    } catch {
        Add-Fail -Leg 'cursor-overlay-at-destination-after-bounded-action' -Reason $_.Exception.Message
    }
}

function Invoke-CursorOverlayTeardownLeg {
    <# 'cursor-overlay-teardown-clean': disable, then three independent
       observations - never the disable call's own `ok` - the process is
       gone, the resting-point pixel is back to its pre-enable value
       (completing the paint leg's other direction), and the foreground is
       unaffected across the destroy. A survivor is force-killed but the
       leg still fails: cleanup is not the same thing as never having
       leaked. #>
    param([Parameter(Mandatory = $true)][string]$App)
    try {
        Enter-Stage -Lock DesktopLease -Body {
            Enter-Stage -Lock ForegroundStage -Body {
                $beforeFg = Get-NativeForegroundWindowHandle
                $sessionId = $script:cursorOverlaySessionId
                $beforeDisableChildren = @(Get-CursorOverlayChildProcessesForSession -SessionId $sessionId)
                if ($beforeDisableChildren.Count -eq 0) {
                    throw 'no renderer process was found for this session before disable - the reaper query cannot be trusted to detect a live one'
                }

                Invoke-AgentDesktop -Arguments @('--session', $sessionId, 'cursor-overlay', 'disable') -RequireOk -Description 'cursor-overlay disable' | Out-Null

                $deadline = [System.Diagnostics.Stopwatch]::StartNew()
                $gone = $false
                while (-not $gone -and $deadline.Elapsed.TotalSeconds -lt 8) {
                    $remaining = @(Get-CursorOverlayChildProcessesForSession -SessionId $sessionId)
                    if ($remaining.Count -eq 0) { $gone = $true; break }
                    Start-Sleep -Milliseconds 200
                }
                if (-not $gone) {
                    $leaked = @(Get-CursorOverlayChildProcessesForSession -SessionId $sessionId)
                    foreach ($process in $leaked) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
                    throw "$($leaked.Count) overlay renderer process(es) survived disable and had to be force-killed"
                }

                $resting = $script:cursorOverlayRestingPoint
                $offsets = Get-CursorOverlayInteriorOffsets
                $expectedBaseline = $script:cursorOverlayPreEnablePixel
                $reverted = $false
                $deadline2 = [System.Diagnostics.Stopwatch]::StartNew()
                while (-not $reverted -and $deadline2.Elapsed.TotalSeconds -lt 5) {
                    $pixel = Get-NativeScreenPixel -X ($resting.X + $offsets[0].X) -Y ($resting.Y + $offsets[0].Y)
                    if ($pixel -eq $expectedBaseline) { $reverted = $true; break }
                    Start-Sleep -Milliseconds 150
                }
                if (-not $reverted) {
                    throw "the resting-point pixel did not revert to its pre-enable baseline within 5s after teardown"
                }

                $afterFg = Get-NativeForegroundWindowHandle
                if ($afterFg -ne $beforeFg) {
                    throw "foreground changed from $beforeFg to $afterFg across the overlay's teardown"
                }
            }
        }
        Add-Pass -Leg 'cursor-overlay-teardown-clean'
    } catch {
        Add-Fail -Leg 'cursor-overlay-teardown-clean' -Reason $_.Exception.Message
    }
}
