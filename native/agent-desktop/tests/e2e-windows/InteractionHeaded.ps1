#Requires -Version 5.1

<#
    InteractionHeaded.ps1 - Invoke-HeadedInteractionLegs, dot-sourced by
    scenarios/Interaction.ps1. Split out purely to keep both files under
    the 400-line cap. Deliberately not placed under scenarios/ itself: the
    contract gate's rule08/rule09 scope every scenarios/*.ps1 file as a
    top-level scenario required to call Register-Legs and declare its own
    locks directly - correct for a real scenario entry point, wrong for a
    function this file's own caller already registers and locks around.
    Living here instead of there is the same "split file escapes the
    scanner's per-entry-point assumptions" shape selftest/ already uses
    for its own Invoke-U6SelfTests.ps1/Invoke-U7SelfTests.ps1 split-outs.
    $App is always passed explicitly by the caller; no caller-scope state
    is shared implicitly.
#>

Set-StrictMode -Version 2.0

function Invoke-HeadedInteractionLegs {
    param([Parameter(Mandatory = $true)][string]$App)
    Enter-Stage -Lock DesktopLease -Body {
        Enter-Stage -Lock ForegroundStage -Body {
            <# Every physical (coordinate-based) action below scrolls its own
               target into view first - measured live: the earlier resident-
               id resolve loop leaves the AutoScroll viewport scrolled deep
               into the scroll-row list, so a stale off-screen bounds reading
               can never be clicked. scroll-to is a no-op when visible. #>
            try {
                $target = Require-Target -Target (Find-Target -App $App -NativeId 'double-target' -TimeoutSeconds 10) -Description 'double-target'
                Invoke-Target -Target $target -Action 'scroll-to' -RequireOk -Description 'double-target (scroll into view)' | Out-Null
                $status = Require-Target -Target (Find-Target -App $App -NativeId 'double-status' -TimeoutSeconds 10) -Description 'double-status'
                Assert-Effect -Target $target -StatusTarget $status -Property 'value' -Expected 'double-clicked' -ExpectedIsPrefix -Action 'double-click' -Headed | Out-Null
                Add-Pass -Leg 'headed-double-click'
            } catch { Add-Fail -Leg 'headed-double-click' -Reason $_.Exception.Message }

            try {
                $target = Require-Target -Target (Find-Target -App $App -NativeId 'triple-target' -TimeoutSeconds 10) -Description 'triple-target'
                Invoke-Target -Target $target -Action 'scroll-to' -RequireOk -Description 'triple-target (scroll into view)' | Out-Null
                $status = Require-Target -Target (Find-Target -App $App -NativeId 'triple-status' -TimeoutSeconds 10) -Description 'triple-status'
                Add-Type -AssemblyName System.Windows.Forms
                $resetWindow = [System.Windows.Forms.SystemInformation]::DoubleClickTime * 2 + 100
                $twoClicks = Assert-NoEffect -Target $target -StatusTarget $status -Property 'value' -Action 'double-click' -Headed -WindowMs $resetWindow
                Assert-Envelope -Envelope $twoClicks -Ok
                Assert-Effect -Target $target -StatusTarget $status -Property 'value' -Expected 'triple-clicked' -ExpectedIsPrefix -Action 'triple-click' -Headed | Out-Null
                Add-Pass -Leg 'headed-triple-click'
            } catch { Add-Fail -Leg 'headed-triple-click' -Reason $_.Exception.Message }

            try {
                $target = Require-Target -Target (Find-Target -App $App -NativeId 'context-target' -TimeoutSeconds 10) -Description 'context-target'
                <# context-status must resolve before the right-click, not
                   after: context-choice's popup (FixtureCardsClicks.cs) is a
                   real second top-level Form sharing this process's
                   app_name - measured live, once it is open, `find --app`
                   window resolution lands on the focused popup, not the
                   main window, so a main-window-only id polls to
                   PRECONDITION_FAILED for the popup's whole lifetime.
                   Preconditions.ps1's own right-click leg avoids this by
                   resolving through -WindowId instead of -App; this leg
                   avoids it by resolving context-status while only the main
                   window exists, the same ordering every other leg in this
                   file already uses (status found before its action fires). #>
                $status = Require-Target -Target (Find-Target -App $App -NativeId 'context-status' -TimeoutSeconds 10) -Description 'context-status'
                Invoke-Target -Target $target -Action 'scroll-to' -RequireOk -Description 'context-target (scroll into view)' | Out-Null
                Invoke-Target -Target $target -Action 'right-click' -Headed -RequireOk -Description 'context-target' | Out-Null
                $choice = Require-Target -Target (Find-Target -App $App -NativeId 'context-choice' -TimeoutSeconds 10) -Description 'context-choice'
                Assert-Effect -Target $choice -StatusTarget $status -Property 'value' -Expected 'chosen' -ExpectedIsPrefix -AnyChange -Action 'click' | Out-Null
                Add-Pass -Leg 'headed-right-click-then-choose'
            } catch { Add-Fail -Leg 'headed-right-click-then-choose' -Reason $_.Exception.Message }

            try {
                <# 'mouse-move' takes --xy (absolute screen coordinates), never
                   a ref positional argument (agent-desktop.exe mouse-move
                   --help) - a ref-shaped call here fails INVALID_ARGS before
                   ever reaching the fixture. `hover` is the ref-resolving
                   action for "move the cursor onto this element", and
                   Assert-Effect's own -Action 'hover' below already performs
                   and verifies it; this leg only needs to scroll the target
                   into view first, the same as every other physical leg in
                   this file. #>
                Assert-Envelope -Envelope (Invoke-AgentDesktop -Arguments @('--headed', 'mouse-move', '--xy', '5,5')) -Ok
                $mover = Require-Target -Target (Find-Target -App $App -NativeId 'hover-target' -TimeoutSeconds 10) -Description 'hover-target'
                Invoke-Target -Target $mover -Action 'scroll-to' -RequireOk -Description 'hover-target (scroll into view)' | Out-Null
                $status = Require-Target -Target (Find-Target -App $App -NativeId 'hover-status' -TimeoutSeconds 10) -Description 'hover-status'
                Assert-Effect -Target $mover -StatusTarget $status -Property 'value' -Expected 'hovered' -ExpectedIsPrefix -AnyChange -Action 'hover' -Headed | Out-Null
                Add-Pass -Leg 'headed-hover'
            } catch { Add-Fail -Leg 'headed-hover' -Reason $_.Exception.Message }

            try {
                $source = Require-Target -Target (Find-Target -App $App -NativeId 'scroll-area' -TimeoutSeconds 10) -Description 'scroll-area'
                Invoke-Target -Target $source -Action 'scroll-to' -RequireOk -Description 'scroll-area (scroll into view)' | Out-Null
                $dragDestination = @{ X = 5; Y = 5 }
                $e = Invoke-AgentDesktop -Arguments @('--headed', 'drag', '--from', $source.RefId, '--to-xy', "$($dragDestination.X),$($dragDestination.Y)")
                Assert-Envelope -Envelope $e -Ok
                <# Assert-Envelope -Ok alone only proves the command claimed
                   success. drag.rs's own drag_sequence ends its physical
                   delivery, on the success path, with the button release
                   posted at the destination - so the OS cursor's own
                   resting position is an independent oracle that needs no
                   fixture cooperation: no fixture control here is draggable
                   in an observable way, so this is the re-observation that
                   is actually available. +/-3px matches
                   Invoke-FocusOracleLeg's own bounds tolerance in
                   Interaction.ps1 and absorbs SendInput's normalized-
                   absolute round-trip (mouse_coord.rs: pixel -> 0..65535 ->
                   pixel). #>
                $cursor = Get-NativeCursorPosition
                if ([Math]::Abs($cursor.X - $dragDestination.X) -gt 3 -or [Math]::Abs($cursor.Y - $dragDestination.Y) -gt 3) {
                    throw "headed-drag: the OS cursor settled at $($cursor.X),$($cursor.Y), not within 3px of the drag's own destination $($dragDestination.X),$($dragDestination.Y) - ok:true is not independently corroborated"
                }
                Add-Pass -Leg 'headed-drag'
            } catch { Add-Fail -Leg 'headed-drag' -Reason $_.Exception.Message }

            try {
                <# Physical `type` is a pure keyboard-focus check
                   (ensure_keyboard_delivery_ready in
                   crates/windows/src/actions/physical_target.rs), never a
                   focus-establishing action itself - unlike physical click,
                   which focuses its target as an OS side effect of the
                   click. Measured live: 'type' on an unfocused text-input
                   returns ACTION_FAILED "lost focus before physical input
                   delivery" every time; an explicit 'focus' first (the same
                   action Invoke-FocusOracleLeg already uses) is what
                   establishes the precondition this leg's physical delivery
                   depends on. #>
                $textInput = Require-Target -Target (Find-Target -App $App -NativeId 'text-input' -TimeoutSeconds 10) -Description 'text-input'
                Invoke-Target -Target $textInput -Action 'scroll-to' -RequireOk -Description 'text-input (scroll into view)' | Out-Null
                Invoke-Target -Target $textInput -Action 'focus' -Headed -RequireOk -Description 'text-input (establish keyboard focus)' | Out-Null
                $status = Require-Target -Target (Find-Target -App $App -NativeId 'text-status' -TimeoutSeconds 10) -Description 'text-status'
                Assert-Effect -Target $textInput -StatusTarget $status -Property 'value' -Expected 'changed' -ExpectedIsPrefix -AnyChange -Action 'type' -ActionArgs @('typed') -Headed -ExpectedMechanism 'physical_synthetic' | Out-Null
                Add-Pass -Leg 'headed-type'
            } catch { Add-Fail -Leg 'headed-type' -Reason $_.Exception.Message }

            try {
                <# MEASURED DIVERGENCE: Assert-Envelope -Ok is the only check
                   this leg can make. `press --app escape` fires an atomic
                   key-down+key-up pair with no residual OS state afterward
                   (unlike drag, which leaves the cursor resting at its
                   destination) - there is no oracle like
                   Get-NativeCursorPosition to read back. `key-down`/
                   `key-up` cannot substitute: they are gated to refuse
                   under this suite's policy regardless of --headed (see
                   Interaction.ps1's own header), so the key cannot be held
                   to inspect mid-press state either. The fixture itself
                   wires no observable effect to Escape - no control in
                   tests/fixture-app-windows sets Form.CancelButton, and
                   none of FixtureCards.cs, FixtureSheet.cs or
                   AgentDeskFixture.cs binds a KeyDown/PreviewKeyDown
                   handler to any key (checked live against the tree) - so
                   even a fixture-side observation is not available without
                   adding one, which is fixture-app-windows scope, not this
                   scenario's. #>
                $e = Invoke-AgentDesktop -Arguments @('--headed', 'press', 'escape', '--app', $App)
                Assert-Envelope -Envelope $e -Ok
                Add-Pass -Leg 'headed-press-app'
            } catch { Add-Fail -Leg 'headed-press-app' -Reason $_.Exception.Message }
        }
    }
}
