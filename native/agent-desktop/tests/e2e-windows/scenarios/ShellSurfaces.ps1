#Requires -Version 5.1

<#
    ShellSurfaces.ps1 - U15: the shipped shell surfaces driven through the
    release binary against the real desktop, every effect read back through
    an observation the open command did not perform.

    The four legs:

      - the Action Center is raised (open-system-surface --headed), the
        identity it returns is re-rooted by `snapshot --surface
        action-center`, and the snapshot's own output must corroborate the
        open's claim - same window id, at least one ref, and one of the
        measured landmark AutomationIds (A26-3: MainListView when
        notifications are present, the empty-center landmarks when none
        are) inside the tree's native_id fields;

      - the surface is closed the way the shell closes it - the Win+A
        toggle, synthesized harness-side, since there is no CLI close
        command - and the closed state's own refusal shape is asserted
        (WINDOW_NOT_FOUND whose suggestion names open-system-surface);

      - the notification area is counted twice: the binary's
        snapshot --surface system-tray must root at the same promoted
        toolbar the harness's own UIA3 COM read identifies AND report
        exactly the Button-children count that read takes - the count read
        through the binary would not qualify (Assert-Effect's contract);

      - the taskbar, always raised, always restore-free, must snapshot
        with at least one ref.

    No notification is staged here: a toast posted under a harness AUMID
    was measured not to appear in the Action Center, so the mutation path
    is covered by unit tests against constructed trees and the live
    dogfood, not by a scenario that would run only when the machine
    happened to hold a notification.

    Lock order: the Action Center legs take the foreground, so each
    acquires DesktopLease then ForegroundStage inside Enter-Stage; the
    read-only tray/taskbar legs take DesktopLease alone. The tray and
    taskbar reads close nothing and restore nothing; the Action Center
    legs restore the desktop themselves (pre-clean before raising, and a
    best-effort close after the legs, so a failed leg cannot leave the
    surface raised).
#>

Set-StrictMode -Version 2.0

Import-Module (Join-Path $PSScriptRoot '..\LibShell.psm1') -Force -Global

function Invoke-ShellSurfacesScenario {
    $script:ShellSurfacesSkippedLeg = $null
    Register-Legs -Names @(
        'shell-action-center-opens-and-snapshots-with-landmark',
        'shell-action-center-close-reports-closed',
        'shell-tray-count-matches-com-read',
        'shell-taskbar-present-with-refs'
    )
    Invoke-ShellActionCenterOpenLeg
    Invoke-ShellActionCenterCloseLeg
    Invoke-ShellTrayCountLeg
    Invoke-ShellTaskbarLeg
    Invoke-ShellDesktopRestore
}

function Invoke-ShellActionCenterOpenWithRetry {
    <# Setup robustness, not a weakened assertion: the open budget inside
       the binary is a fixed 5s, and a suspended ShellExperienceHost can
       take longer than that to resume and present after its first chord -
       the open's own TIMEOUT suggestion is to retry ("the shell can
       decline an accelerator without reporting it"). The first attempt
       doubles as the wake; the assertions downstream stay strict. #>
    param([Parameter(Mandatory = $true)][string]$Surface)
    $open = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $open = Invoke-ShellSurfaceOpen -Surface $Surface -Headed
        if ($open.Opened -or $open.ErrorCode -ne 'TIMEOUT') { return $open }
        Start-Sleep -Milliseconds 500
    }
    return $open
}

function Invoke-ShellActionCenterOpenLeg {
    <# Raises the surface on a clean baseline, then re-roots the identity
       the open returned through a separate snapshot command. #>
    $leg = 'shell-action-center-opens-and-snapshots-with-landmark'
    try {
        Enter-Stage -Lock DesktopLease -Body {
            Enter-Stage -Lock ForegroundStage -Body {
                $pre = Invoke-ShellSurfaceSnapshot -Surface 'action-center'
                if ($pre.Opened) {
                    <# Nothing another leg left on screen may stand in for
                       the surface about to be raised. #>
                    Invoke-ShellActionCenterToggle
                    $cleared = $false
                    $deadline = [System.Diagnostics.Stopwatch]::StartNew()
                    do {
                        $recheck = Invoke-ShellSurfaceSnapshot -Surface 'action-center'
                        if (-not $recheck.Opened) { $cleared = $true; break }
                        Start-Sleep -Milliseconds 250
                    } while ($deadline.Elapsed.TotalSeconds -lt 10)
                    if (-not $cleared) { throw 'a pre-open Action Center stayed open across its own toggle; refusing to raise over it' }
                }
                $open = Invoke-ShellActionCenterOpenWithRetry -Surface 'action-center'
                if (-not $open.Opened) {
                    if ($open.ErrorCode -eq 'PLATFORM_NOT_SUPPORTED') {
                        $script:ShellSurfacesSkippedLeg = $leg
                        Add-Skip -Leg $leg -Token 'shell-surface-absent' -Reason "open-system-surface refused with $($open.ErrorCode); this runner does not expose the surface"
                        return
                    }
                    throw "open-system-surface --surface action-center failed: $($open.ErrorCode)"
                }
                if (-not $open.WindowId) { throw 'open-system-surface returned no window id' }
                $snap = $null
                $deadline = [System.Diagnostics.Stopwatch]::StartNew()
                do {
                    $snap = Invoke-ShellSurfaceSnapshot -Surface 'action-center'
                    if ($snap.Opened) { break }
                    Start-Sleep -Milliseconds 250
                } while ($deadline.Elapsed.TotalSeconds -lt 10)
                if (-not $snap) { throw 'snapshot --surface action-center produced no answer within the poll window' }
                if (-not $snap.Opened) { throw "snapshot --surface action-center never resolved the raised surface (last: $($snap.ErrorCode))" }
                if ($snap.WindowId -ne $open.WindowId) {
                    throw "snapshot resolved window id '$($snap.WindowId)', not the id open-system-surface returned ('$($open.WindowId)')"
                }
                if (-not $snap.RefCount -or $snap.RefCount -lt 1) { throw "the Action Center snapshot carried $($snap.RefCount) refs" }
                $marks = Get-ShellTreeIdentityMarks -Root $snap.Root -Landmarks @('MainListView', 'NoNotificationsTextBlock', 'ScrollWrapper')
                if (-not $marks.HasRef) { throw 'the Action Center snapshot tree carries no ref' }
                if (-not $marks.Landmark) { throw "the Action Center snapshot tree carries none of the landmarks MainListView/NoNotificationsTextBlock/ScrollWrapper in its native_id fields - the tree is not the Action Center's" }
            }
        }
        if ($script:ShellSurfacesSkippedLeg -eq $leg) { return }
        Add-Pass -Leg $leg
    } catch {
        Add-Fail -Leg $leg -Reason $_.Exception.Message
    }
}

function Invoke-ShellActionCenterCloseLeg {
    <# Closes the surface the way the shell does (the harness's own
       synthesized Win+A toggle - the dismiss accelerator the kind table
       names) and asserts the closed state's refusal shape. Self-contained:
       it raises its own surface when the open leg left none, so it never
       toggles a closed center open by accident. #>
    $leg = 'shell-action-center-close-reports-closed'
    try {
        Enter-Stage -Lock DesktopLease -Body {
            Enter-Stage -Lock ForegroundStage -Body {
                $pre = Invoke-ShellSurfaceSnapshot -Surface 'action-center'
                if (-not $pre.Opened) {
                    $open = Invoke-ShellActionCenterOpenWithRetry -Surface 'action-center'
                    if (-not $open.Opened) {
                        if ($open.ErrorCode -eq 'PLATFORM_NOT_SUPPORTED') {
                            $script:ShellSurfacesSkippedLeg = $leg
                            Add-Skip -Leg $leg -Token 'shell-surface-absent' -Reason "open-system-surface refused with $($open.ErrorCode); this runner does not expose the surface"
                            return
                        }
                        throw "open-system-surface --surface action-center failed: $($open.ErrorCode)"
                    }
                }
                Invoke-ShellActionCenterToggle
                $verified = $false
                $deadline = [System.Diagnostics.Stopwatch]::StartNew()
                do {
                    $snap = Invoke-ShellSurfaceSnapshot -Surface 'action-center'
                    if (-not $snap.Opened) {
                        if ($snap.ErrorCode -ne 'WINDOW_NOT_FOUND') {
                            throw "expected WINDOW_NOT_FOUND for the closed surface, got $($snap.ErrorCode)"
                        }
                        if (-not $snap.Suggestion) { throw 'the closed-surface refusal carried no suggestion' }
                        if ($snap.Suggestion -notlike '*open-system-surface*') {
                            throw "the closed-surface refusal's suggestion '$($snap.Suggestion)' does not name open-system-surface"
                        }
                        $verified = $true
                        break
                    }
                    Start-Sleep -Milliseconds 250
                } while ($deadline.Elapsed.TotalSeconds -lt 10)
                if (-not $verified) { throw 'the Action Center was still snapshotable 10s after its toggle; the close did not land' }
            }
        }
        if ($script:ShellSurfacesSkippedLeg -eq $leg) { return }
        Add-Pass -Leg $leg
    } catch {
        Add-Fail -Leg $leg -Reason $_.Exception.Message
    }
}

function Invoke-ShellTrayCountLeg {
    <# The count assertion whose read side is genuinely independent: the
       harness's own COM read names the promoted toolbar and counts its
       Button children, and the binary must agree on both the identity and
       the number. The read closes nothing and needs no restore. #>
    $leg = 'shell-tray-count-matches-com-read'
    try {
        Enter-Stage -Lock DesktopLease -Body {
            $com = Get-ShellTrayToolbarIdentity
            $snap = Invoke-ShellSurfaceSnapshot -Surface 'system-tray'
            if (-not $snap.Opened) { throw "snapshot --surface system-tray failed: $($snap.ErrorCode)" }
            $expectedId = 'w-{0}' -f $com.Handle
            if ($snap.WindowId -ne $expectedId) {
                throw "the tray snapshot rooted at '$($snap.WindowId)', not at the COM-read promoted toolbar '$expectedId'"
            }
            if ($snap.RefCount -ne $com.ButtonCount) {
                throw "the tray snapshot reported $($snap.RefCount) refs; the harness's own COM read counted $($com.ButtonCount) Button children on the promoted toolbar"
            }
        }
        Add-Pass -Leg $leg
    } catch {
        Add-Fail -Leg $leg -Reason $_.Exception.Message
    }
}

function Invoke-ShellTaskbarLeg {
    <# The taskbar is always raised on a presented desktop - nothing to
       open, no state to restore; the assertion is that the always-present
       surface snapshots with refs. #>
    $leg = 'shell-taskbar-present-with-refs'
    try {
        Enter-Stage -Lock DesktopLease -Body {
            $snap = Invoke-ShellSurfaceSnapshot -Surface 'taskbar'
            if (-not $snap.Opened) { throw "snapshot --surface taskbar failed: $($snap.ErrorCode)" }
            if (-not $snap.RefCount -or $snap.RefCount -lt 1) { throw "the taskbar snapshot carried $($snap.RefCount) refs" }
        }
        Add-Pass -Leg $leg
    } catch {
        Add-Fail -Leg $leg -Reason $_.Exception.Message
    }
}

function Invoke-ShellDesktopRestore {
    <# Best-effort, never verdict-bearing: a leg that failed mid-way may
       have left the surface raised, and the scenario must not leave the
       desktop with the Action Center open. #>
    try {
        Enter-Stage -Lock DesktopLease -Body {
            Enter-Stage -Lock ForegroundStage -Body {
                $snap = Invoke-ShellSurfaceSnapshot -Surface 'action-center'
                if ($snap.Opened) {
                    Invoke-ShellActionCenterToggle
                }
            }
        }
    } catch {
        Write-Warning "ShellSurfaces: desktop restore did not complete: $($_.Exception.Message)"
    }
}
