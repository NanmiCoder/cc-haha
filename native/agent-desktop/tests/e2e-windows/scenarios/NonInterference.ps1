#Requires -Version 5.1

<#
    NonInterference.ps1 - U9 approach item 2: the headless semantic tier
    really is non-interfering. Cursor position (GetCursorPos) and foreground
    window (GetForegroundWindow) are read through raw P/Invoke before and
    after every Tier-1 semantic command, and neither may move - conjoined in
    the same leg with Assert-Effect, because "cursor/foreground unchanged"
    alone is satisfied perfectly by a command that fails in 5ms or by a
    build whose entire Tier-1 dispatch is dead. `focus` is excluded from
    this table on measured grounds, not the plan's assumed one: on this
    adapter a headless `focus` returns POLICY_DENIED ("SetFocus moves the
    desktop foreground window on Windows") - it cannot run headless at all,
    so it never belongs to a headless non-interference gate here. `type` and
    `press` stay excluded for the reason the plan already gives (always
    SendInput).
#>

Set-StrictMode -Version 2.0

function Get-NonInterferenceLegTable {
    @(
        @{ Name = 'click'; TargetId = 'primary-button'; StatusId = 'click-status'; Property = 'value'; Prefix = 'clicked'; AnyChange = $true; Action = 'click'; Mechanism = 'semantic_api' }
        @{ Name = 'toggle'; TargetId = 'toggle-box'; StatusId = 'toggle-status'; Property = 'value'; Prefix = $null; AnyChange = $true; Action = 'toggle'; Mechanism = 'semantic_api' }
        <# check's own precondition (toggle-box unchecked) is not assumed:
           the preceding toggle leg above may have left it checked, which
           would make this leg's pre-read already match and throw the
           unfalsifiability guard - Setup forces the known-false state first,
           mirroring Interaction's select-tab precedent. #>
        @{ Name = 'check'; TargetId = 'toggle-box'; IsProperty = 'checked'; ExpectedState = $true; Action = 'check'; Mechanism = 'semantic_api'; Setup = @{ Action = 'uncheck' } }
        @{ Name = 'uncheck'; TargetId = 'toggle-box'; IsProperty = 'checked'; ExpectedState = $false; Action = 'uncheck'; Mechanism = 'semantic_api' }
        @{ Name = 'expand'; TargetId = 'menu-disclosure'; IsProperty = 'expanded'; ExpectedState = $true; Action = 'expand'; Mechanism = 'semantic_api'; Refresh = $true }
        @{ Name = 'collapse'; TargetId = 'menu-disclosure'; IsProperty = 'expanded'; ExpectedState = $false; Action = 'collapse'; Mechanism = 'semantic_api'; Refresh = $true }
        @{ Name = 'select'; TargetRole = 'tab'; TargetName = 'Two'; StatusId = 'tab-status'; Property = 'value'; AnyChange = $true; Action = 'select'; ActionArgs = @('Two'); Mechanism = 'semantic_api' }
        @{ Name = 'scroll'; TargetId = 'scroll-area'; StatusId = 'scroll-offset'; Property = 'value'; AnyChange = $true; Action = 'scroll'; ActionArgs = @('--direction', 'down', '--amount', '3'); Mechanism = 'semantic_api' }
        @{ Name = 'scroll-to'; TargetId = 'scroll-row-50'; StatusId = 'scroll-offset'; Property = 'value'; AnyChange = $true; Action = 'scroll-to'; Mechanism = 'semantic_api' }
        @{ Name = 'set-value'; TargetId = 'text-input'; StatusId = 'text-status'; Property = 'value'; Prefix = 'changed'; AnyChange = $true; Action = 'set-value'; ActionArgs = @('hello'); Mechanism = 'semantic_api' }
        <# clear's own value must move away from non-empty to be falsifiable;
           Setup forces a known non-empty state first rather than assuming
           the preceding set-value leg left one behind, mirroring check's
           own Setup precedent above. #>
        @{ Name = 'clear'; TargetId = 'text-input'; StatusId = 'text-status'; Property = 'value'; AnyChange = $true; Action = 'clear'; Mechanism = 'semantic_api'; Setup = @{ Action = 'set-value'; ActionArgs = @('still-there') } }
    )
}

function Invoke-NonInterferenceScenario {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$App)
    $legs = Get-NonInterferenceLegTable
    Register-Legs -Names @($legs | ForEach-Object { "non-interference-$($_.Name)" })

    foreach ($leg in $legs) {
        $legName = "non-interference-$($leg.Name)"
        try {
            Enter-Stage -Lock DesktopLease -Body {
                <# Bracket access throughout this leg's own hashtable reads
                   ($leg[...], never $leg.X): the table is heterogeneous -
                   most entries omit TargetRole/StatusId/Setup/IsProperty/
                   AnyChange/Prefix entirely, and Set-StrictMode -Version
                   2.0 throws PropertyNotFoundException on a dot-access to a
                   Hashtable key that is simply absent, not merely $null -
                   measured live: every leg in this loop failed immediately
                   on `if ($leg.TargetRole)` before touching the fixture at
                   all. Writes to $assertArgs (a different, always-uniform
                   hashtable this loop builds) are untouched - StrictMode
                   guards reads, not writes, and dot-assignment there was
                   never the defect. #>
                if ($leg['TargetRole']) {
                    $target = Require-Target -Target (Find-Target -App $App -Role $leg['TargetRole'] -Name $leg['TargetName'] -Exact -TimeoutSeconds 10) -Description "$($leg['TargetRole']):$($leg['TargetName'])"
                } else {
                    $target = Require-Target -Target (Find-Target -App $App -NativeId $leg['TargetId'] -TimeoutSeconds 10) -Description $leg['TargetId']
                }
                $statusTarget = $null
                if ($leg['StatusId']) { $statusTarget = Require-Target -Target (Find-Target -App $App -NativeId $leg['StatusId'] -TimeoutSeconds 10) -Description $leg['StatusId'] }

                if ($leg['Setup']) {
                    $setupArgs = @()
                    if ($leg['Setup']['ActionArgs']) { $setupArgs = $leg['Setup']['ActionArgs'] }
                    Invoke-Target -Target $target -Action $leg['Setup']['Action'] -ActionArgs $setupArgs -RequireOk -Description "$($leg['TargetId']) setup" | Out-Null
                }

                $cursorBefore = Get-NativeCursorPosition
                $foregroundBefore = Get-NativeForegroundWindowHandle

                $assertArgs = @{
                    Target            = $target
                    Action            = $leg['Action']
                    ExpectedMechanism = $leg['Mechanism']
                }
                if ($leg['ActionArgs']) { $assertArgs.ActionArgs = $leg['ActionArgs'] }
                if ($statusTarget) { $assertArgs.StatusTarget = $statusTarget }
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
                } else {
                    $assertArgs.Property = $leg['Property']
                    $assertArgs.Expected = $leg['Prefix']
                    $assertArgs.ExpectedIsPrefix = $true
                }
                Assert-Effect @assertArgs | Out-Null

                $cursorAfter = Get-NativeCursorPosition
                $foregroundAfter = Get-NativeForegroundWindowHandle
                if ($cursorBefore.X -ne $cursorAfter.X -or $cursorBefore.Y -ne $cursorAfter.Y) {
                    throw "$($leg.Name): cursor moved from ($($cursorBefore.X),$($cursorBefore.Y)) to ($($cursorAfter.X),$($cursorAfter.Y)) during a headless semantic command"
                }
                if ($foregroundBefore -ne $foregroundAfter) {
                    throw "$($leg.Name): foreground window changed during a headless semantic command"
                }
            }
            Add-Pass -Leg $legName
        } catch {
            Add-Fail -Leg $legName -Reason $_.Exception.Message
        }
    }
}
