#Requires -Version 5.1

<#
    Interaction.ps1 - U9 approach items 3-6: every interaction command
    behaves as the Windows contract says, in the headless semantic tier, the
    headless refusal tier and the headed physical tier. Every envelope shape
    below was read from a live run against this fixture and binary - three
    disagree with the plan text as written, corrected here and cited in the
    sub-phase report:
      - `select` has no CLI ref-target form; option-picker's `ComboBox`
        advertises only SetValue/SetFocus (ACTION_NOT_SUPPORTED for
        `select`), so its headless leg drives `set-value` and reads the
        combo's own value, which `ValuePattern.SetValue` touches.
      - `mouse-down`/`mouse-up` return POLICY_DENIED headless, not
        ACTION_NOT_SUPPORTED - reachable only past the headless gate, under
        --headed, which this suite never asks these atomic-only commands to
        run under. `key-down`/`key-up` are gated higher still
        (`input_hold_policy.rs`), carrying no `details` object in any mode.
      - `press` takes a combo and an optional `--app`, never a ref
        (`src/cli_args/actions.rs`); "press <ref>" is not a shape any
        platform's CLI accepts.
#>

Set-StrictMode -Version 2.0

<# Invoke-HeadedInteractionLegs lives in ../InteractionHeaded.ps1, not
   alongside the other Invoke-*Leg(s) functions below - purely to keep this
   file under the 400-line cap. It is not under scenarios/ itself: see that
   file's own header for why. #>
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'InteractionHeaded.ps1')
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'InteractionPress.ps1')
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'InteractionScroll.ps1')

<# Invoke-PressLegs lives in ../InteractionPress.ps1 for the same reason. #>
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'InteractionPress.ps1')

function Get-InteractionHeadlessLegTable {
    @(
        @{ Name = 'click'; TargetId = 'primary-button'; StatusId = 'click-status'; Property = 'value'; Prefix = 'clicked'; AnyChange = $true; Action = 'click'; Mechanism = 'semantic_api' }
        @{ Name = 'set-value'; TargetId = 'text-input'; StatusId = 'text-status'; Property = 'value'; Prefix = 'changed'; AnyChange = $true; Action = 'set-value'; ActionArgs = @('hello') }
        <# Targets text-input, not a fresh field: clear's own value must
           move away from "" to be a falsifiable leg at all, and the
           preceding set-value leg already left it non-empty - relying on
           table order rather than pre-populating a second field. #>
        @{ Name = 'clear'; TargetId = 'text-input'; Property = 'value'; AnyChange = $true; Action = 'clear' }
        <# Refresh: switch-button's own Name is its toggle's visible evidence
           (fixture wires Text to "Switch: on"/"Switch: off" on flip, the
           same pattern outline-parent/menu-disclosure use below) - a stale
           ref re-identifies by name and fails strict re-identification
           after the flip, measured live as a TIMEOUT on `is --property
           checked` against the pre-toggle ref rather than a clean
           STALE_REF. Re-resolving fresh every poll (as the expand/collapse
           legs already do) reads the live element instead. #>
        @{ Name = 'toggle'; TargetId = 'switch-button'; IsProperty = 'checked'; ExpectedState = $true; Action = 'toggle'; Refresh = $true }
        @{ Name = 'check'; TargetId = 'toggle-box'; IsProperty = 'checked'; ExpectedState = $true; Action = 'check' }
        @{ Name = 'uncheck'; TargetId = 'toggle-box'; IsProperty = 'checked'; ExpectedState = $false; Action = 'uncheck' }
        @{ Name = 'expand-outline'; TargetId = 'outline-parent'; IsProperty = 'expanded'; ExpectedState = $true; Action = 'expand'; Refresh = $true }
        @{ Name = 'collapse-outline'; TargetId = 'outline-parent'; IsProperty = 'expanded'; ExpectedState = $false; Action = 'collapse'; Refresh = $true }
        @{ Name = 'expand-menu-disclosure'; TargetId = 'menu-disclosure'; IsProperty = 'expanded'; ExpectedState = $true; Action = 'expand'; Refresh = $true }
        @{ Name = 'collapse-menu-disclosure'; TargetId = 'menu-disclosure'; IsProperty = 'expanded'; ExpectedState = $false; Action = 'collapse'; Refresh = $true }
        <# Setup forces a known starting tab (independent of whatever an
           earlier scenario left selected) so the asserted select is
           guaranteed to be a real change rather than a same-tab no-op that
           never fires SelectedIndexChanged. #>
        @{ Name = 'select-tab'; TargetRole = 'tab'; TargetName = 'One'; StatusId = 'tab-status'; Property = 'value'; AnyChange = $true; Action = 'select'; ActionArgs = @('One'); Setup = @{ Role = 'tab'; Name = 'Two'; Action = 'select'; ActionArgs = @('Two') } }
        @{ Name = 'set-value-combobox'; TargetId = 'option-picker'; SelfStatus = $true; Property = 'value'; Expected = 'two'; Action = 'set-value'; ActionArgs = @('two') }
        @{ Name = 'scroll'; TargetId = 'scroll-area'; StatusId = 'scroll-offset'; Property = 'value'; AnyChange = $true; Action = 'scroll'; ActionArgs = @('--direction', 'down', '--amount', '3') }
        @{ Name = 'menu-fire'; TargetId = 'menu-fire-item'; StatusId = 'menu-status'; Property = 'value'; Prefix = 'fired'; AnyChange = $true; Action = 'click' }
    )
}

function Get-InteractionRefusalLegTable {
    @(
        @{ Name = 'right-click-refused'; TargetId = 'context-target'; StatusId = 'context-status'; Action = 'right-click' }
        @{ Name = 'double-click-refused'; TargetId = 'double-target'; StatusId = 'double-status'; Action = 'double-click' }
        @{ Name = 'triple-click-refused'; TargetId = 'triple-target'; StatusId = 'triple-status'; Action = 'triple-click' }
        @{ Name = 'hover-refused'; TargetId = 'hover-target'; StatusId = 'hover-status'; Action = 'hover' }
        @{ Name = 'drag-refused'; TargetId = 'scroll-area'; Action = 'drag'; ActionArgs = @('--to-xy', '5,5') }
    )
}

function Assert-RefusalLeg {
    param($Leg, [Parameter(Mandatory = $true)][string]$App)
    Enter-Stage -Lock DesktopLease -Body {
        $target = Require-Target -Target (Find-Target -App $App -NativeId $Leg.TargetId -TimeoutSeconds 10) -Description $Leg.TargetId
        if ($Leg.Action -eq 'drag') {
            $callArgs = @('drag', '--from', $target.RefId) + $Leg.ActionArgs
            $envelope = Invoke-AgentDesktop -Arguments $callArgs
            Assert-Envelope -Envelope $envelope -ErrorCode 'POLICY_DENIED' -Delivery 'not_delivered' -Retry 'safe'
            return
        }
        Invoke-Target -Target $target -Action 'scroll-to' -RequireOk -Description $Leg.TargetId | Out-Null
        $statusTarget = Require-Target -Target (Find-Target -App $App -NativeId $Leg.StatusId -TimeoutSeconds 10) -Description $Leg.StatusId
        $envelope = Assert-NoEffect -Target $target -StatusTarget $statusTarget -Property 'value' -Action $Leg.Action
        Assert-Envelope -Envelope $envelope -ErrorCode 'POLICY_DENIED' -Delivery 'not_delivered' -Retry 'safe'
    }
}

function Invoke-InteractionScenario {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$App)
    $headlessLegs = Get-InteractionHeadlessLegTable
    $refusalLegs = Get-InteractionRefusalLegTable
    Register-Legs -Names (@($headlessLegs | ForEach-Object { "interaction-$($_.Name)" }) + @($refusalLegs | ForEach-Object { $_.Name }) + @(
            'key-down-not-supported', 'key-up-not-supported', 'mouse-down-refused', 'mouse-up-refused',
            'mouse-move-refused', 'mouse-click-refused', 'mouse-wheel-refused', 'surface-menu-closed-is-window-not-found',
            'headed-double-click', 'headed-triple-click', 'headed-right-click-then-choose', 'headed-hover',
            'headed-drag', 'headed-type', 'headed-press-app',
            'press-ctrl-a-backspace-clears-text', 'press-shift-tab-moves-focus',
            'press-return-activates-focused-button', 'press-blocked-combo-refused',
            'interaction-scroll-to-visibility', 'interaction-horizontal-scroll-to-containment', 'interaction-focus-refused-headless', 'interaction-focus-headed-oracle'
        ))

    foreach ($leg in $headlessLegs) {
        $legName = "interaction-$($leg.Name)"
        try {
            Enter-Stage -Lock DesktopLease -Body {
                <# Bracket access ($leg[...], never $leg.X): the table is heterogeneous and StrictMode 2.0 throws on a dot-access to an absent key - measured live, every leg here failed before touching the fixture. #>
                if ($leg['TargetRole']) {
                    $target = Require-Target -Target (Find-Target -App $App -Role $leg['TargetRole'] -Name $leg['TargetName'] -Exact -TimeoutSeconds 10) -Description "$($leg['TargetRole']):$($leg['TargetName'])"
                } else {
                    $target = Require-Target -Target (Find-Target -App $App -NativeId $leg['TargetId'] -TimeoutSeconds 10) -Description $leg['TargetId']
                }
                $statusTarget = $target
                if ($leg['StatusId']) { $statusTarget = Require-Target -Target (Find-Target -App $App -NativeId $leg['StatusId'] -TimeoutSeconds 10) -Description $leg['StatusId'] }

                if ($leg['Setup']) {
                    $setupTarget = Require-Target -Target (Find-Target -App $App -Role $leg['Setup']['Role'] -Name $leg['Setup']['Name'] -Exact -TimeoutSeconds 10) -Description "$($leg['Setup']['Role']):$($leg['Setup']['Name'])"
                    Invoke-Target -Target $setupTarget -Action $leg['Setup']['Action'] -ActionArgs $leg['Setup']['ActionArgs'] -RequireOk -Description "$($leg['Setup']['Role']):$($leg['Setup']['Name']) setup" | Out-Null
                }

                $assertArgs = @{ Target = $target; StatusTarget = $statusTarget; Action = $leg['Action'] }
                if ($leg['ActionArgs']) { $assertArgs.ActionArgs = $leg['ActionArgs'] }
                if ($leg['Mechanism']) { $assertArgs.ExpectedMechanism = $leg['Mechanism'] }
                if ($leg['IsProperty']) {
                    $assertArgs.IsProperty = $leg['IsProperty']
                    $assertArgs.ExpectedState = $leg['ExpectedState']
                    if ($leg['Refresh']) { $assertArgs.RefreshApp = $App; $assertArgs.RefreshNativeId = $leg['TargetId'] }
                } elseif ($leg['AnyChange'] -and $leg['Prefix']) {
                    $assertArgs.Property = $leg['Property']
                    $assertArgs.Expected = $leg['Prefix']
                    $assertArgs.ExpectedIsPrefix = $true
                    $assertArgs.AnyChange = $true
                } elseif ($leg['AnyChange']) {
                    $assertArgs.Property = $leg['Property']
                    $assertArgs.AnyChange = $true
                } elseif ($leg['Expected']) {
                    $assertArgs.Property = $leg['Property']
                    $assertArgs.Expected = $leg['Expected']
                } else {
                    $assertArgs.Property = $leg['Property']
                    $assertArgs.Expected = $leg['Prefix']
                    $assertArgs.ExpectedIsPrefix = $true
                }
                Assert-Effect @assertArgs | Out-Null
            }
            Add-Pass -Leg $legName
        } catch {
            Add-Fail -Leg $legName -Reason $_.Exception.Message
        }
    }

    foreach ($leg in $refusalLegs) {
        try {
            Assert-RefusalLeg -Leg $leg -App $App
            Add-Pass -Leg $leg.Name
        } catch {
            Add-Fail -Leg $leg.Name -Reason $_.Exception.Message
        }
    }

    Invoke-BareCoordinateRefusalLegs -App $App
    Invoke-HeldInputRefusalLegs
    Invoke-SurfaceClosedMenuLeg -App $App
    Invoke-HeadedInteractionLegs -App $App
    Invoke-PressLegs -App $App
    Invoke-ScrollToVisibilityLeg -App $App
    Invoke-HorizontalScrollToLeg -App $App
    Invoke-FocusRefusalLeg -App $App
    Invoke-FocusOracleLeg -App $App
}

function Invoke-ScrollToVisibilityLeg {
    <# R5: the forced ancestor-scroll ladder case. Offset changing alone (the
       'scroll' leg above) does not prove a below-fold row was ever realized -
       this leg requires BOTH: offset moves AND scroll-row-50's 'visible' flips false->true, re-read fresh each poll. #>
    param([Parameter(Mandatory = $true)][string]$App)
    try {
        Enter-Stage -Lock DesktopLease -Body {
            $offsetStatus = Require-Target -Target (Find-Target -App $App -NativeId 'scroll-offset' -TimeoutSeconds 10) -Description 'scroll-offset'
            <# An earlier scenario may already have realized scroll-row-50,
               tripping the unfalsifiability guard below on sequencing rather
               than a regression - restore below-fold first via scroll-row-1.
               Scrolling moves scroll-row-50's own bounds, so every read
               below is a fresh find; a stale-ref error during the
               transition counts as "not yet settled", not a crash. #>
            $top = Require-Target -Target (Find-Target -App $App -NativeId 'scroll-row-1' -TimeoutSeconds 10) -Description 'scroll-row-1'
            $diagTopEnvelope = Invoke-Target -Target $top -Action 'scroll-to' -Description 'scroll-row-1 DIAG'
            Write-Host "DIAG scroll-row-1-envelope: $($diagTopEnvelope | ConvertTo-Json -Depth 12 -Compress)"
            if ($diagTopEnvelope['ok'] -ne $true) {
                throw "Invoke-Target: setup action 'scroll-to' on scroll-row-1 failed: $($diagTopEnvelope['error']['code'])"
            }

            $restoreDeadline = [System.Diagnostics.Stopwatch]::StartNew()
            $restoredBelowFold = $false
            while ($restoreDeadline.Elapsed.TotalSeconds -lt 10 -and -not $restoredBelowFold) {
                try {
                    $freshRow = Find-Target -App $App -NativeId 'scroll-row-50' -TimeoutSeconds 2
                    if ($freshRow -and -not (Test-Target -Target $freshRow -Property 'visible')) { $restoredBelowFold = $true }
                } catch { }
                if (-not $restoredBelowFold) { Start-Sleep -Milliseconds 150 }
            }
            if (-not $restoredBelowFold) {
                throw "interaction-scroll-to-visibility: 'scroll-row-50' never settled below-fold after restoring to scroll-row-1 within 10s"
            }

            $preOffset = Get-Target -Target $offsetStatus -Property 'value'
            $row = Require-Target -Target (Find-Target -App $App -NativeId 'scroll-row-50' -TimeoutSeconds 10) -Description 'scroll-row-50'
            Invoke-Target -Target $row -Action 'scroll-to' -RequireOk -Description 'scroll-row-50' | Out-Null

            $deadline = [System.Diagnostics.Stopwatch]::StartNew()
            $offsetChanged = $false
            $becameVisible = $false
            while ($deadline.Elapsed.TotalSeconds -lt 10 -and (-not $offsetChanged -or -not $becameVisible)) {
                try {
                    if (-not $offsetChanged -and (Get-Target -Target $offsetStatus -Property 'value') -ne $preOffset) { $offsetChanged = $true }
                    if (-not $becameVisible) {
                        $freshRow = Find-Target -App $App -NativeId 'scroll-row-50' -TimeoutSeconds 2
                        if ($freshRow -and (Test-Target -Target $freshRow -Property 'visible')) { $becameVisible = $true }
                    }
                } catch { }
                if (-not $offsetChanged -or -not $becameVisible) { Start-Sleep -Milliseconds 150 }
            }
            if (-not $offsetChanged) { throw "interaction-scroll-to-visibility: 'scroll-offset' did not change within 10s of scroll-to" }
            if (-not $becameVisible) { throw "interaction-scroll-to-visibility: 'scroll-row-50' never became visible within 10s of scroll-to" }
        }
        Add-Pass -Leg 'interaction-scroll-to-visibility'
    } catch {
        Add-Fail -Leg 'interaction-scroll-to-visibility' -Reason $_.Exception.Message
    }
}

function Invoke-FocusRefusalLeg {
    <# Measured: headless `focus` returns POLICY_DENIED (SetFocus moves the desktop foreground window) - it cannot run headless at all. #>
    param([Parameter(Mandatory = $true)][string]$App)
    try {
        Enter-Stage -Lock DesktopLease -Body {
            $target = Require-Target -Target (Find-Target -App $App -NativeId 'text-input' -TimeoutSeconds 10) -Description 'text-input'
            $envelope = Invoke-Target -Target $target -Action 'focus'
            Assert-Envelope -Envelope $envelope -ErrorCode 'POLICY_DENIED' -Delivery 'not_delivered' -Retry 'safe'
        }
        Add-Pass -Leg 'interaction-focus-refused-headless'
    } catch {
        Add-Fail -Leg 'interaction-focus-refused-headless' -Reason $_.Exception.Message
    }
}

function Invoke-FocusOracleLeg {
    <# F13/R14: GetFocus reads NULL here (answers only for the CALLING
       thread's queue), so the oracle is GetGUIThreadInfo against the
       fixture's own UI thread - never the product's claim. Two-legged: the
       thread id comes from a raw GetWindowThreadProcessId off the fixture's
       HWND (by title, never by trusting `focus`), and the focused HWND's
       own GetWindowRect is cross-checked against text-input's reported
       bounds - a wrong-or-no focus regression fails this even if `focus
       --headed` itself returns ok=true. #>
    param([Parameter(Mandatory = $true)][string]$App)
    try {
        Enter-Stage -Lock DesktopLease -Body {
            Enter-Stage -Lock ForegroundStage -Body {
                $mainWindowId = Get-WindowId -Where { $_['title'] -eq 'AgentDeskFixture' } -TimeoutSeconds 10
                if (-not $mainWindowId) { throw 'interaction-focus-headed-oracle: could not resolve the main fixture window id' }
                $fixtureHandle = ConvertTo-NativeWindowHandle -WindowId $mainWindowId
                $threadId = Get-NativeWindowThreadId -WindowHandle $fixtureHandle

                $target = Require-Target -Target (Find-Target -WindowId $mainWindowId -NativeId 'text-input' -TimeoutSeconds 10) -Description 'text-input'
                Invoke-Target -Target $target -Action 'scroll-to' -RequireOk -Description 'text-input (scroll into view)' | Out-Null
                $bounds = Get-Target -Target $target -Property 'bounds' -Raw

                Invoke-Target -Target $target -Action 'focus' -Headed -RequireOk -Description 'text-input' | Out-Null

                $deadline = [System.Diagnostics.Stopwatch]::StartNew()
                $matched = $false
                $lastSeen = 'never observed a non-null hwndFocus'
                while ($deadline.Elapsed.TotalSeconds -lt 10 -and -not $matched) {
                    $gui = Get-NativeGuiThreadInfo -ThreadId $threadId
                    if ($gui.HwndFocus -ne [IntPtr]::Zero) {
                        $rect = Get-NativeWindowRect -WindowHandle $gui.HwndFocus
                        $lastSeen = "rect=$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom) vs bounds=$($bounds['x']),$($bounds['y'])"
                        if ([Math]::Abs($rect.Left - [double]$bounds['x']) -le 3 -and [Math]::Abs($rect.Top - [double]$bounds['y']) -le 3) {
                            $matched = $true
                        }
                    }
                    if (-not $matched) { Start-Sleep -Milliseconds 150 }
                }
                if (-not $matched) {
                    throw "interaction-focus-headed-oracle: GetGUIThreadInfo's hwndFocus never matched text-input's own bounds within 10s (last: $lastSeen)"
                }
            }
        }
        Add-Pass -Leg 'interaction-focus-headed-oracle'
    } catch {
        Add-Fail -Leg 'interaction-focus-headed-oracle' -Reason $_.Exception.Message
    }
}

function Invoke-BareCoordinateRefusalLegs {
    param([Parameter(Mandatory = $true)][string]$App)
    Enter-Stage -Lock DesktopLease -Body {
        try {
            $e = Invoke-AgentDesktop -Arguments @('mouse-down', '--xy', '100,100')
            Assert-Envelope -Envelope $e -ErrorCode 'POLICY_DENIED' -Delivery 'not_delivered' -Retry 'safe'
            Add-Pass -Leg 'mouse-down-refused'
        } catch { Add-Fail -Leg 'mouse-down-refused' -Reason $_.Exception.Message }
        try {
            $e = Invoke-AgentDesktop -Arguments @('mouse-up', '--xy', '100,100')
            Assert-Envelope -Envelope $e -ErrorCode 'POLICY_DENIED' -Delivery 'not_delivered' -Retry 'safe'
            Add-Pass -Leg 'mouse-up-refused'
        } catch { Add-Fail -Leg 'mouse-up-refused' -Reason $_.Exception.Message }
        try {
            $e = Invoke-AgentDesktop -Arguments @('mouse-move', '--xy', '100,100')
            Assert-Envelope -Envelope $e -ErrorCode 'POLICY_DENIED' -Delivery 'not_delivered' -Retry 'safe'
            Add-Pass -Leg 'mouse-move-refused'
        } catch { Add-Fail -Leg 'mouse-move-refused' -Reason $_.Exception.Message }
        try {
            $e = Invoke-AgentDesktop -Arguments @('mouse-click', '--xy', '100,100')
            Assert-Envelope -Envelope $e -ErrorCode 'POLICY_DENIED' -Delivery 'not_delivered' -Retry 'safe'
            Add-Pass -Leg 'mouse-click-refused'
        } catch { Add-Fail -Leg 'mouse-click-refused' -Reason $_.Exception.Message }
        try {
            $e = Invoke-AgentDesktop -Arguments @('mouse-wheel', '--x', '100', '--y', '100')
            Assert-Envelope -Envelope $e -ErrorCode 'POLICY_DENIED' -Delivery 'not_delivered' -Retry 'safe'
            Add-Pass -Leg 'mouse-wheel-refused'
        } catch { Add-Fail -Leg 'mouse-wheel-refused' -Reason $_.Exception.Message }
    }
}

function Invoke-HeldInputRefusalLegs {
    Enter-Stage -Lock DesktopLease -Body {
        try {
            $e = Invoke-AgentDesktop -Arguments @('key-down', 'shift')
            Assert-Envelope -Envelope $e -ErrorCode 'ACTION_NOT_SUPPORTED'
            Add-Pass -Leg 'key-down-not-supported'
        } catch { Add-Fail -Leg 'key-down-not-supported' -Reason $_.Exception.Message }
        try {
            $e = Invoke-AgentDesktop -Arguments @('key-up', 'shift')
            Assert-Envelope -Envelope $e -ErrorCode 'ACTION_NOT_SUPPORTED'
            Add-Pass -Leg 'key-up-not-supported'
        } catch { Add-Fail -Leg 'key-up-not-supported' -Reason $_.Exception.Message }
    }
}

function Invoke-SurfaceClosedMenuLeg {
    param([Parameter(Mandatory = $true)][string]$App)
    Enter-Stage -Lock DesktopLease -Body {
        try {
            <# The menu surface is advertised and resolvable on this platform,
               so a closed menu is a not-found answer, not a refusal - the
               same WINDOW_NOT_FOUND shape the shell kinds return when the
               surface is absent. #>
            $e = Invoke-AgentDesktop -Arguments @('snapshot', '--app', $App, '--surface', 'menu')
            Assert-Envelope -Envelope $e -ErrorCode 'WINDOW_NOT_FOUND'
            Add-Pass -Leg 'surface-menu-closed-is-window-not-found'
        } catch { Add-Fail -Leg 'surface-menu-closed-is-window-not-found' -Reason $_.Exception.Message }
    }
}
