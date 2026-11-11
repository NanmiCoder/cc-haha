#Requires -Version 5.1

Set-StrictMode -Version 2.0

function Invoke-PressLegs {
    param([Parameter(Mandatory = $true)][string]$App)
    Enter-Stage -Lock DesktopLease -Body {
        Enter-Stage -Lock ForegroundStage -Body {
            try {
                $textInput = Require-Target -Target (Find-Target -App $App -NativeId 'text-input' -TimeoutSeconds 10) -Description 'text-input'
                Invoke-Target -Target $textInput -Action 'scroll-to' -RequireOk -Description 'text-input (scroll into view)' | Out-Null
                Invoke-Target -Target $textInput -Action 'set-value' -ActionArgs @('abc') -RequireOk -Description 'text-input (seed)' | Out-Null
                Invoke-Target -Target $textInput -Action 'focus' -Headed -RequireOk -Description 'text-input (keyboard focus)' | Out-Null
                if ((Get-Target -Target $textInput -Property 'value') -ne 'abc') { throw 'text-input did not hold the seed value before the press' }
                Assert-Envelope -Envelope (Invoke-AgentDesktop -Arguments @('--headed', 'press', 'ctrl+a', '--app', $App)) -Ok
                Assert-Envelope -Envelope (Invoke-AgentDesktop -Arguments @('--headed', 'press', 'backspace', '--app', $App)) -Ok
                $clock = [System.Diagnostics.Stopwatch]::StartNew()
                $observed = Get-Target -Target $textInput -Property 'value'
                while ($observed -ne '' -and $clock.Elapsed.TotalSeconds -lt 5) {
                    Start-Sleep -Milliseconds 150
                    $observed = Get-Target -Target $textInput -Property 'value'
                }
                if ($observed -ne '') { throw "ctrl+a then backspace left text-input at '$observed'; expected the whole value removed (a dropped ctrl would leave a partial value, an undelivered press leaves 'abc')" }
                Add-Pass -Leg 'press-ctrl-a-backspace-clears-text'
            } catch { Add-Fail -Leg 'press-ctrl-a-backspace-clears-text' -Reason $_.Exception.Message }

            try {
                $textInput = Require-Target -Target (Find-Target -App $App -NativeId 'text-input' -TimeoutSeconds 10) -Description 'text-input'
                $secureInput = Require-Target -Target (Find-Target -App $App -NativeId 'secure-input' -TimeoutSeconds 10) -Description 'secure-input'
                Invoke-Target -Target $secureInput -Action 'focus' -Headed -RequireOk -Description 'secure-input (plain Tab control)' | Out-Null
                Assert-Envelope -Envelope (Invoke-AgentDesktop -Arguments @('--headed', 'press', 'tab', '--app', $App)) -Ok
                if (Test-Target -Target $textInput -Property 'focused') { throw 'plain Tab moved backward to text-input; the Shift direction check would prove nothing' }
                Invoke-Target -Target $secureInput -Action 'focus' -Headed -RequireOk -Description 'secure-input (keyboard focus)' | Out-Null
                if (-not (Test-Target -Target $secureInput -Property 'focused')) { throw 'secure-input was not focused before shift+tab; the leg would prove nothing' }
                Assert-Envelope -Envelope (Invoke-AgentDesktop -Arguments @('--headed', 'press', 'shift+tab', '--app', $App)) -Ok
                $clock = [System.Diagnostics.Stopwatch]::StartNew()
                $previousFocused = Test-Target -Target $textInput -Property 'focused'
                while (-not $previousFocused -and $clock.Elapsed.TotalSeconds -lt 5) {
                    Start-Sleep -Milliseconds 150
                    $previousFocused = Test-Target -Target $textInput -Property 'focused'
                }
                if (-not $previousFocused) { throw 'shift+tab did not focus the previous control text-input' }
                Add-Pass -Leg 'press-shift-tab-moves-focus'
            } catch { Add-Fail -Leg 'press-shift-tab-moves-focus' -Reason $_.Exception.Message }

            try {
                $button = Require-Target -Target (Find-Target -App $App -NativeId 'primary-button' -TimeoutSeconds 10) -Description 'primary-button'
                Invoke-Target -Target $button -Action 'scroll-to' -RequireOk -Description 'primary-button (scroll into view)' | Out-Null
                Invoke-Target -Target $button -Action 'focus' -Headed -RequireOk -Description 'primary-button (keyboard focus)' | Out-Null
                $clickStatus = Require-Target -Target (Find-Target -App $App -NativeId 'click-status' -TimeoutSeconds 10) -Description 'click-status'
                $before = Get-Target -Target $clickStatus -Property 'value'
                Assert-Envelope -Envelope (Invoke-AgentDesktop -Arguments @('--headed', 'press', 'return', '--app', $App)) -Ok
                $clock = [System.Diagnostics.Stopwatch]::StartNew()
                $after = Get-Target -Target $clickStatus -Property 'value'
                while ($after -eq $before -and $clock.Elapsed.TotalSeconds -lt 5) {
                    Start-Sleep -Milliseconds 150
                    $after = Get-Target -Target $clickStatus -Property 'value'
                }
                if ($after -eq $before -or $after -notlike 'clicked#*') { throw "return on the focused primary-button left click-status at '$after' (was '$before')" }
                Add-Pass -Leg 'press-return-activates-focused-button'
            } catch { Add-Fail -Leg 'press-return-activates-focused-button' -Reason $_.Exception.Message }

            try {
                $foregroundBefore = Get-NativeForegroundWindowHandle
                $refused = Invoke-AgentDesktop -Arguments @('press', 'meta+x', '--app', $App)
                Assert-Envelope -Envelope $refused -ErrorCode 'POLICY_DENIED' -Delivery 'not_delivered'
                if (-not ([string]$refused['error']['message']).Contains('blocked for safety')) { throw "win+x was refused with an unexpected message: '$($refused['error']['message'])'" }
                $clock = [System.Diagnostics.Stopwatch]::StartNew()
                while ($clock.ElapsedMilliseconds -lt 1500) {
                    if ((Get-NativeForegroundWindowHandle) -ne $foregroundBefore) { throw 'foreground window changed after a refused win+x; the combo may have been delivered' }
                    Start-Sleep -Milliseconds 150
                }
                if (-not (Get-WindowId -Where { $_['title'] -eq 'AgentDeskFixture' } -TimeoutSeconds 5)) { throw 'the fixture window is no longer listed after the refused combo' }
                Add-Pass -Leg 'press-blocked-combo-refused'
            } catch { Add-Fail -Leg 'press-blocked-combo-refused' -Reason $_.Exception.Message }
        }
    }
}
