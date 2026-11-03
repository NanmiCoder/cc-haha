#Requires -Version 5.1

<#
    Surfaces.ps1 - the sheet lifecycle observed independently, the AE6
    analog, and menu dispatch enumerated and fired.

    The list-surfaces leg once asserted this platform's refusal (the
    adapter carried no override and core's default answered
    PLATFORM_NOT_SUPPORTED); that stopped being true when the Windows
    adapter grew a real per-process inventory, so the leg now asserts the
    positive shape it always wanted to prove: the fixture's own window is
    reported as a `window` surface whose id is the one the rest of this
    suite addresses the fixture by. The sheet and menu legs keep asserting
    the classifications through the same inventory.
#>

Set-StrictMode -Version 2.0

function Invoke-SurfacesScenario {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$App)
    Register-Legs -Names @(
        'surfaces-list-surfaces-reports-the-fixture-window', 'surfaces-sheet-lifecycle-independent-observation',
        'surfaces-ae6-surface-appeared', 'surfaces-ae6-window-opened-no-title-or-id',
        'surfaces-menu-enumerated-and-fires'
    )

    Invoke-ListSurfacesLeg -App $App
    Invoke-SheetLifecycleLeg -App $App
    Invoke-Ae6Legs -App $App
    Invoke-MenuDispatchLeg -App $App
}

function Invoke-ListSurfacesLeg {
    param([Parameter(Mandatory = $true)][string]$App)
    try {
        Enter-Stage -Lock DesktopLease -Body {
            $mainWindowId = Get-MainFixtureWindowId -App $App
            $envelope = Invoke-AgentDesktop -Arguments @('list-surfaces', '--app', $App)
            $surfaces = Get-EnvelopeSurfaces -Envelope $envelope
            $window = @($surfaces | Where-Object { $_['type'] -eq 'window' -and $_['id'] -eq $mainWindowId })
            if ($window.Count -ne 1) {
                $types = (@($surfaces | ForEach-Object { $_['type'] }) | Select-Object -Unique) -join ', '
                $raw = ConvertTo-Json -InputObject $envelope -Depth 6 -Compress
                throw "list-surfaces reported no 'window' surface for the fixture's own id $mainWindowId (types: $types; envelope: $raw)"
            }
        }
        Add-Pass -Leg 'surfaces-list-surfaces-reports-the-fixture-window'
    } catch { Add-Fail -Leg 'surfaces-list-surfaces-reports-the-fixture-window' -Reason $_.Exception.Message }
}

function Invoke-SheetLifecycleLeg {
    <# Get-MainFixtureWindowId is Acceptance.ps1's helper, not duplicated
       here - Run-E2E.ps1 dot-sources Acceptance.ps1 before this file, so
       the one definition is already in scope. open-sheet lives on the main
       window; sheet-field/confirm-sheet live on the Sheet window's own id;
       sheet-status lives back on the main window - each resolved against
       its own --window-id, the same discipline Preconditions.ps1's
       staged-id legs already established for this fixture's untitled/owned
       popups. #>
    param([Parameter(Mandatory = $true)][string]$App)
    try {
        Enter-Stage -Lock DesktopLease -Body {
            $mainWindowId = Get-MainFixtureWindowId -App $App
            $status = Require-Target -Target (Find-Target -WindowId $mainWindowId -NativeId 'sheet-status' -TimeoutSeconds 10) -Description 'sheet-status'
            $preStatus = Get-Target -Target $status -Property 'value'

            $openSheet = Require-Target -Target (Find-Target -WindowId $mainWindowId -NativeId 'open-sheet' -TimeoutSeconds 10) -Description 'open-sheet'
            Invoke-Target -Target $openSheet -Action 'click' -RequireOk -Description 'open-sheet' | Out-Null

            $sheetWindowId = Get-WindowId -Where { $_['title'] -eq 'Sheet' } -TimeoutSeconds 10
            if (-not $sheetWindowId) { throw 'the Sheet dialog did not present its own top-level window' }

            $confirm = Require-Target -Target (Find-Target -WindowId $sheetWindowId -NativeId 'confirm-sheet' -TimeoutSeconds 10) -Description 'confirm-sheet'
            Invoke-Target -Target $confirm -Action 'click' -RequireOk -Description 'confirm-sheet' | Out-Null

            $deadline = [System.Diagnostics.Stopwatch]::StartNew()
            $observed = $preStatus
            while ($deadline.Elapsed.TotalSeconds -lt 10 -and $observed -eq $preStatus) {
                $observed = Get-Target -Target $status -Property 'value'
                if ($observed -eq $preStatus) { Start-Sleep -Milliseconds 150 }
            }
            <# FixtureStatus.SetValue appends a counter suffix ("confirmed#N"),
               the same reason menu-status is asserted as a prefix rather
               than an exact match elsewhere in this suite - a rerun of this
               leg would otherwise read 'confirmed#2' and fail an
               exact-string check that never accounted for re-firability. #>
            if ($observed -eq $preStatus -or $observed -notlike 'confirmed#*') { throw "sheet-status read '$observed' after confirm-sheet, expected a changed value matching 'confirmed#*'" }
            if (Get-WindowId -Where { $_['title'] -eq 'Sheet' } -TimeoutSeconds 3) { throw 'the Sheet window is still present after confirm-sheet' }
        }
        Add-Pass -Leg 'surfaces-sheet-lifecycle-independent-observation'
    } catch { Add-Fail -Leg 'surfaces-sheet-lifecycle-independent-observation' -Reason $_.Exception.Message }
}

function Invoke-Ae6Legs {
    <# The mechanism macOS's own AE6 leg (tests/e2e/scenarios/acceptance.sh)
       uses: `batch` captures the signal baseline immediately before the
       acting (click) entry runs, so the modal genuinely opens mid-wait with
       no concurrency of any kind needed - one process, two sequential
       entries. Each leg reopens the sheet itself (via its own click entry)
       rather than reusing the lifecycle leg's own open, since that leg may
       have already closed it, or may itself have failed. #>
    param([Parameter(Mandatory = $true)][string]$App)
    try {
        Enter-Stage -Lock DesktopLease -Body {
            $mainWindowId = Get-MainFixtureWindowId -App $App
            if (Get-WindowId -Where { $_['title'] -eq 'Sheet' } -TimeoutSeconds 2) {
                throw 'a Sheet window is already open; the AE6 leg needs a genuine open-mid-wait transition'
            }
            $openSheet = Require-Target -Target (Find-Target -WindowId $mainWindowId -NativeId 'open-sheet' -TimeoutSeconds 10) -Description 'open-sheet'
            $entries = @(
                @{ Command = 'click'; Args = @{ ref_id = $openSheet.RefId } }
                @{ Command = 'wait'; Args = @{ event = 'surface-appeared'; app = $App; timeout = 5000 } }
            )
            $results = Invoke-AgentDesktopBatch -Entries $entries -TimeoutSeconds 20
            if (-not $results[0].EntryOk) { throw "the click entry failed: $($results[0].ErrorCode)" }
            if (-not $results[1].EntryOk) { throw "the wait entry failed: $($results[1].ErrorCode)" }
            if ($results[1].Found -ne $true) { throw 'wait --event surface-appeared reported found=false' }
            if ($results[1].EventKind -ne 'surface_appeared') { throw "event.kind was '$($results[1].EventKind)', expected 'surface_appeared'" }
            if ($results[1].EventSurface -ne 'sheet') { throw "event.surface was '$($results[1].EventSurface)', expected 'sheet'" }

            $sheetWindowId = Get-WindowId -Where { $_['title'] -eq 'Sheet' } -TimeoutSeconds 10
            $cancel = Require-Target -Target (Find-Target -WindowId $sheetWindowId -NativeId 'cancel-sheet' -TimeoutSeconds 10) -Description 'cancel-sheet'
            Invoke-Target -Target $cancel -Action 'click' -RequireOk -Description 'cancel-sheet' | Out-Null
        }
        Add-Pass -Leg 'surfaces-ae6-surface-appeared'
    } catch { Add-Fail -Leg 'surfaces-ae6-surface-appeared' -Reason $_.Exception.Message }

    try {
        Enter-Stage -Lock DesktopLease -Body {
            $mainWindowId = Get-MainFixtureWindowId -App $App
            if (Get-WindowId -Where { $_['title'] -eq 'Sheet' } -TimeoutSeconds 2) {
                throw 'a Sheet window is already open; the AE6 leg needs a genuine open-mid-wait transition'
            }
            $openSheet = Require-Target -Target (Find-Target -WindowId $mainWindowId -NativeId 'open-sheet' -TimeoutSeconds 10) -Description 'open-sheet'
            <# The caller names neither a title nor an id - only --app,
               which narrows the scan population without selecting the
               window by identity. #>
            $entries = @(
                @{ Command = 'click'; Args = @{ ref_id = $openSheet.RefId } }
                @{ Command = 'wait'; Args = @{ event = 'window-opened'; app = $App; timeout = 5000 } }
            )
            $results = Invoke-AgentDesktopBatch -Entries $entries -TimeoutSeconds 20
            if (-not $results[0].EntryOk) { throw "the click entry failed: $($results[0].ErrorCode)" }
            if (-not $results[1].EntryOk) { throw "the wait entry failed: $($results[1].ErrorCode)" }
            if ($results[1].Found -ne $true) { throw 'wait --event window-opened reported found=false' }
            if ($results[1].EventKind -ne 'window_opened') { throw "event.kind was '$($results[1].EventKind)', expected 'window_opened'" }
            if (-not $results[1].EventWindowId) { throw 'event.window_id was empty - the server must supply the new window identity though the caller named none' }

            $sheetWindowId = $results[1].EventWindowId
            $cancel = Require-Target -Target (Find-Target -WindowId $sheetWindowId -NativeId 'cancel-sheet' -TimeoutSeconds 10) -Description 'cancel-sheet'
            Invoke-Target -Target $cancel -Action 'click' -RequireOk -Description 'cancel-sheet' | Out-Null
        }
        Add-Pass -Leg 'surfaces-ae6-window-opened-no-title-or-id'
    } catch { Add-Fail -Leg 'surfaces-ae6-window-opened-no-title-or-id' -Reason $_.Exception.Message }
}

function Invoke-MenuDispatchLeg {
    <# macOS can only assert enumerability; this platform can assert
       dispatch too. Enumeration: --role menuitem must resolve menu-fire-item
       specifically, not merely some element of that role somewhere in the
       tree (Observation.ps1's role-coverage leg already proves the role
       exists at all). Dispatch: the counter-suffixed status is asserted to
       change and to say the right thing, independent of Interaction.ps1's
       own 'menu-fire' leg, which this leg does not depend on or reuse. #>
    param([Parameter(Mandatory = $true)][string]$App)
    try {
        Enter-Stage -Lock DesktopLease -Body {
            $byRole = Find-Target -App $App -Role 'menuitem' -TimeoutSeconds 10
            if (-not $byRole) { throw "find --role menuitem returned no match" }
            $enumerated = Find-Target -App $App -NativeId 'menu-fire-item' -Role 'menuitem' -TimeoutSeconds 10
            if (-not $enumerated) { throw "menu-fire-item did not resolve when scoped to --role menuitem" }

            $target = Require-Target -Target (Find-Target -App $App -NativeId 'menu-fire-item' -TimeoutSeconds 10) -Description 'menu-fire-item'
            $status = Require-Target -Target (Find-Target -App $App -NativeId 'menu-status' -TimeoutSeconds 10) -Description 'menu-status'
            Assert-Effect -Target $target -StatusTarget $status -Property 'value' -Expected 'fired' -ExpectedIsPrefix -AnyChange -Action 'click' | Out-Null
        }
        Add-Pass -Leg 'surfaces-menu-enumerated-and-fires'
    } catch { Add-Fail -Leg 'surfaces-menu-enumerated-and-fires' -Reason $_.Exception.Message }
}
