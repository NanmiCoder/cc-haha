#Requires -Version 5.1

<#
    AcceptanceContendedFocus.ps1 - the contended focus-steal leg, split out
    of Acceptance.ps1 purely to keep that file under the 400-line cap, the
    same reason InteractionHeaded.ps1 sits beside it. It is dot-sourced by
    Acceptance.ps1 and runs inside that scenario's own registration.
#>

Set-StrictMode -Version 2.0


function Invoke-ContendedFocusStealLeg {
    <# The focus-steal budget of 2 rests on A21-6,
       an UNCONTENDED capture (0/5 both attempts); the contended re-measure
       is assigned here because this file already stages open-duplicate-windows
       + ForegroundStage. Judged only by a raw GetForegroundWindow re-read,
       never by focus-window's own answer - A21-6 already measured that
       answer as untrustworthy. A control proves the oracle moves at all
       (stages the contender, reads foreground back BEFORE any focus-window
       is issued) before the N-trial rate is taken; a leg that cannot
       complete N trials fails rather than reporting a partial rate. #>
    param([Parameter(Mandatory = $true)][string]$App)
    Enter-Stage -Lock DesktopLease -Body {
        Enter-Stage -Lock ForegroundStage -Body {
            $mainWindowId = Get-MainFixtureWindowId -App $App
            $openDuplicates = Require-Target -Target (Find-Target -WindowId $mainWindowId -NativeId 'open-duplicate-windows' -TimeoutSeconds 10) -Description 'open-duplicate-windows'
            Invoke-Target -Target $openDuplicates -Action 'click' -RequireOk -Description 'open-duplicate-windows' | Out-Null
            $duplicatesOpened = $false
            <# Every exit path runs close-duplicate-windows once
               $duplicatesOpened is true - measured live: an earlier draft
               returned out of the control-failure branch without closing
               them, leaving two same-titled windows open, which made every
               later --app-scoped Find-Target downstream hit
               AMBIGUOUS_TARGET and fail PRECONDITION_FAILED. #>
            try {
                $count = Get-WindowId -Where { $_['title'] -eq 'Duplicate Window' } -TimeoutSeconds 10 -CountOnly
                if ($count -lt 2) {
                    Add-Fail -Leg 'contended-focus-steal-control' -Reason "expected 2 duplicate windows, saw $count"
                    Add-Fail -Leg 'contended-focus-steal-rate' -Reason 'skipped: duplicate windows never opened'
                    return
                }
                $duplicatesOpened = $true
                <# Two-step resolution, same reasoning as the duplicate-title
                   leg: the first id is "any" duplicate, the second -
                   excluding that exact id - is provably the other one. #>
                $contenderWindowId = Get-WindowId -Where { $_['title'] -eq 'Duplicate Window' } -TimeoutSeconds 10
                $targetWindowId = Get-WindowId -Where { $_['title'] -eq 'Duplicate Window' -and $_['id'] -ne $contenderWindowId } -TimeoutSeconds 10
                if (-not $targetWindowId) {
                    Add-Fail -Leg 'contended-focus-steal-control' -Reason 'could not resolve two distinct duplicate window ids'
                    Add-Fail -Leg 'contended-focus-steal-rate' -Reason 'skipped: only one distinct duplicate window id resolved'
                    return
                }
                $contenderHandle = ConvertTo-NativeWindowHandle -WindowId $contenderWindowId
                $targetHandle = ConvertTo-NativeWindowHandle -WindowId $targetWindowId

                $controlStaged = Set-NativeForegroundWindow -WindowHandle $contenderHandle
                Wait-NativeForegroundToSettle -RequiredStableReads 3 -BudgetSeconds 5 | Out-Null
                $controlObserved = ((Get-NativeForegroundWindowHandle) -eq $contenderHandle)
                if (-not $controlStaged -or -not $controlObserved) {
                    <# The same declared-skip escape the in-crate
                       focus_changed test takes when this desktop declines
                       foreground even to a raw, fully-workaround-ed
                       SetForegroundWindow - an environment limitation, recorded rather than hidden. #>
                    Add-Skip -Leg 'contended-focus-steal-control' -Token 'foreground-grant-declined' -Reason "raw SetForegroundWindow (AttachThreadInput + AllowSetForegroundWindow) could not stage the contender (staged=$controlStaged observed=$controlObserved)"
                    Add-Skip -Leg 'contended-focus-steal-rate' -Token 'foreground-grant-declined' -Reason 'control could not be established; the N-trial rate is never reached'
                    return
                }
                Add-Pass -Leg 'contended-focus-steal-control'

                <# A leg that cannot complete N iterations fails rather than
                   reporting a partial rate - each trial is individually
                   guarded so an exception mid-loop is counted and stops the
                   loop, rather than escaping uncaught and crashing the run. #>
                $iterations = 5
                $landed = 0
                $completed = 0
                for ($i = 0; $i -lt $iterations; $i++) {
                    try {
                        Set-NativeForegroundWindow -WindowHandle $contenderHandle | Out-Null
                        Wait-NativeForegroundToSettle -RequiredStableReads 3 -BudgetSeconds 5 | Out-Null
                        Invoke-AgentDesktop -Arguments @('focus-window', '--window-id', $targetWindowId) | Out-Null
                        Start-Sleep -Milliseconds 200
                        if ((Get-NativeForegroundWindowHandle) -eq $targetHandle) { $landed++ }
                        $completed++
                    } catch { break }
                }
                Write-Host "VERDICT probe contended-focus-steal: landed=$landed/$iterations completed=$completed/$iterations"
                <# The rate gates the leg named for it: five trials with zero
                   wins used to pass. The floor is one, not five, because the
                   contender is a real window on a shared desktop. #>
                if ($completed -lt $iterations) {
                    Add-Fail -Leg 'contended-focus-steal-rate' -Reason "only completed $completed of $iterations trials"
                } elseif ($landed -lt 1) {
                    Add-Fail -Leg 'contended-focus-steal-rate' -Reason "focus-window won the foreground in $landed of $iterations contended trials"
                } else {
                    Add-Pass -Leg 'contended-focus-steal-rate'
                }
            } finally {
                if ($duplicatesOpened) {
                    $closeDuplicates = Find-Target -WindowId $mainWindowId -NativeId 'close-duplicate-windows' -TimeoutSeconds 10
                    if ($closeDuplicates) { Invoke-Target -Target $closeDuplicates -Action 'click' -Description 'close-duplicate-windows' | Out-Null }
                }
            }
        }
    }
}
