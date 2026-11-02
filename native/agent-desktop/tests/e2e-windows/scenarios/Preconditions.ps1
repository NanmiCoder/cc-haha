#Requires -Version 5.1

<#
    Preconditions.ps1 - U5's fixture precondition leg, run before any other
    scenario (the plan's own ordering): set equality between the fixture's
    emitted manifest and the harness's declared inventory (fixture-inventory
    .psd1), every resident id resolving by --native-id (abort, never skip -
    R2), and every staged id resolving only while its surface is up. Nothing
    else in the tree implements this leg; U5 specified it but shipped only
    the fixture's own .cs files, so U9's sequencing is its first executor.
#>

Set-StrictMode -Version 2.0

function Get-FixtureInventory {
    [CmdletBinding()]
    param()
    $path = Join-Path (Split-Path -Parent $PSScriptRoot) 'fixture-inventory.psd1'
    return Import-PowerShellDataFile -Path $path
}

function Test-InventorySetEquality {
    <# Compares the fixture's own emitted manifest against the harness's
       declared inventory in both directions, naming the difference - the
       check a resolve-only pass cannot make: a control deleted from the
       fixture and forgotten in the harness would still "resolve" (there is
       nothing to fail to resolve), but the manifest would shrink. #>
    param([Parameter(Mandatory = $true)][string]$ManifestPath, [Parameter(Mandatory = $true)]$Inventory)
    if (-not (Test-Path -LiteralPath $ManifestPath)) {
        throw "Preconditions: fixture manifest not found at $ManifestPath - build the fixture first"
    }
    $manifestIds = [System.Collections.Generic.HashSet[string]]::new([string[]](Get-Content -LiteralPath $ManifestPath))
    $declaredIds = [System.Collections.Generic.HashSet[string]]::new([string[]]($Inventory.Resident + $Inventory.Staged))
    $onlyInManifest = @($manifestIds | Where-Object { -not $declaredIds.Contains($_) })
    $onlyInDeclared = @($declaredIds | Where-Object { -not $manifestIds.Contains($_) })
    if ($onlyInManifest.Count -gt 0 -or $onlyInDeclared.Count -gt 0) {
        throw "Preconditions: fixture manifest and declared inventory disagree - only in manifest: [$($onlyInManifest -join ', ')]; only in declared inventory: [$($onlyInDeclared -join ', ')]"
    }
}

function Invoke-PreconditionsScenario {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$App, [Parameter(Mandatory = $true)][string]$ManifestPath)
    Register-Legs -Names @('inventory-set-equality', 'resident-ids-resolve', 'twin-control-two-hits', 'staged-ids-resolve')
    $inventory = Get-FixtureInventory

    try {
        Test-InventorySetEquality -ManifestPath $ManifestPath -Inventory $inventory
        Add-Pass -Leg 'inventory-set-equality'
    } catch {
        Add-Fail -Leg 'inventory-set-equality' -Reason $_.Exception.Message
        throw
    }

    Enter-Stage -Lock DesktopLease -Body {
        try {
            <# "Resolves" means a match exists, not that it is ref-able:
               tab-one/tab-two and example-link's own AutomationId sit on a
               non-interactive container (measured live - the actionable
               role lives on an unnamed child instead), so Find-Target's
               ref-bearing contract is the wrong tool here and
               Find-TargetMatches's Count is used instead. twin-control
               deliberately shares its id across two controls (R2's
               exemption), so it is checked separately as "exactly two
               hits" rather than through the resolve loop below. #>
            foreach ($id in $inventory.Resident) {
                if ($id -eq 'twin-control') { continue }
                $hit = Find-TargetMatches -App $App -NativeId $id -TimeoutSeconds 10
                if (-not $hit -or $hit.Count -lt 1) {
                    throw "Preconditions: resident id '$id' did not resolve by --native-id"
                }
            }
            Add-Pass -Leg 'resident-ids-resolve'
        } catch {
            Add-Fail -Leg 'resident-ids-resolve' -Reason $_.Exception.Message
            throw
        }

        try {
            $twins = Find-TargetMatches -App $App -NativeId 'twin-control' -TimeoutSeconds 10
            if (-not $twins -or $twins.Count -ne 2) {
                $seen = if ($twins) { $twins.Count } else { 0 }
                throw "Preconditions: 'twin-control' must resolve to exactly 2 hits, saw $seen"
            }
            Add-Pass -Leg 'twin-control-two-hits'
        } catch {
            Add-Fail -Leg 'twin-control-two-hits' -Reason $_.Exception.Message
            throw
        }
    }

    try {
        Test-StagedIdsResolve -App $App -Inventory $inventory
        Add-Pass -Leg 'staged-ids-resolve'
    } catch {
        Add-Fail -Leg 'staged-ids-resolve' -Reason $_.Exception.Message
        throw
    }
}

function Assert-StagedIdSetEquality {
    <# The ids this leg actually exercises, gathered as each one is proven
       to resolve, checked against fixture-inventory.psd1's own Staged
       array in both directions - the same shape as
       Test-InventorySetEquality above, but scoped to the ids this function
       hardcodes rather than the fixture's emitted manifest. Without this, a
       Staged id added or removed from the .psd1 with no matching edit here
       (or the reverse) would drift invisibly: every id this function does
       check would still resolve, so nothing here would fail on its own. #>
    param([Parameter(Mandatory = $true)][string[]]$Verified, [Parameter(Mandatory = $true)][string[]]$Declared)
    $verifiedIds = [System.Collections.Generic.HashSet[string]]::new([string[]]$Verified)
    $declaredIds = [System.Collections.Generic.HashSet[string]]::new([string[]]$Declared)
    $onlyVerified = @($verifiedIds | Where-Object { -not $declaredIds.Contains($_) })
    $onlyDeclared = @($declaredIds | Where-Object { -not $verifiedIds.Contains($_) })
    if ($onlyVerified.Count -gt 0 -or $onlyDeclared.Count -gt 0) {
        throw "Preconditions: staged ids exercised by Test-StagedIdsResolve and fixture-inventory.psd1's Staged array disagree - only exercised here: [$($onlyVerified -join ', ')]; only in declared Staged: [$($onlyDeclared -join ', ')]"
    }
}

function Test-StagedIdsResolve {
    <# Each staged id is present only while its own transient surface is up.
       Measured live: most of these staged ids are not descendants of the
       main window at all - fixture-overlay/the duplicate windows/the sheet/
       the context popup are each their OWN top-level Form, so a lookup
       scoped to the main window's --window-id (or an --app filter that,
       once a second same-named window exists, may resolve to either one)
       never finds them. Every element-level id below is therefore resolved
       against the --window-id of the specific window that actually
       contains it, resolved fresh by that window's own Title once its
       surface is open; fixture-overlay and the duplicate windows are
       window-level ids in their own right and are proven by Get-WindowId
       returning a real id, not by finding a child element inside them. #>
    param([Parameter(Mandatory = $true)][string]$App, [Parameter(Mandatory = $true)]$Inventory)
    $verifiedIds = [System.Collections.Generic.List[string]]::new()

    <# context-choice's popup and tab-two's pane are staged for two
       different reasons: the popup opens only from a physical right-click
       (ForegroundStage), and tab-two's WinForms pane is not realized at all
       until its tab is actually selected (measured live) - its opener is
       the tab HEADER (role+name), a distinct element from the pane whose
       native id is being proven.

       This block runs FIRST, before appear-later/the occluder/the
       duplicate windows/the modal sheet dialog below: measured live,
       clicking appear-later (focus follows the click, and the fixture's
       AutoScroll main form follows focus) leaves context-target scrolled
       up to 1218px above the viewport, and even after the ancestor-scroll
       ladder converges it back into minimal visibility, that minimal
       on-screen position collides with this box's own taskbar strip
       (measured live: a WezTerm taskbar button occluding the button's
       reported bounds, actionability preflight's receives_events check
       failing every attempt). context-target sits in the very first
       fixture group ("Clicks and mouse"), so at the main form's untouched
       resting scroll position - true here, before anything below has run -
       it is already on-screen clear of that strip, exactly as it was in
       the very first live probe of this leg. Running this block before the
       scroll-disturbing setup below is the fix; convergent re-scrolling
       chases a moving, occluded target and is unnecessary work this
       ordering makes moot. #>
    Enter-Stage -Lock DesktopLease -Body {
        Enter-Stage -Lock ForegroundStage -Body {
            $mainWindowId = Get-WindowId -Where { $_['title'] -eq 'AgentDeskFixture' } -TimeoutSeconds 10
            if (-not $mainWindowId) { throw 'Preconditions: could not resolve the main fixture window id by title' }
            <# The popup is untitled, ShowInTaskbar=false, so a plain Title
               or --app search is not reliable here. R2 asks only that the
               staged id resolve while its own surface is up - it does not
               ask that the surface hold real OS foreground - so the lookup
               identifies the popup by what is actually invariant about it
               (owned by the fixture process, blank title, visible), never
               by is_focused. #>
            $target = Require-Target -Target (Find-Target -WindowId $mainWindowId -NativeId 'context-target' -TimeoutSeconds 10) -Description 'context-target'
            Invoke-Target -Target $target -Action 'scroll-to' -Description 'context-target (scroll into view)' | Out-Null
            $choice = $null
            <# A failed attempt consumes a retry, it does not abort the leg -
               this is why the loop exists at all: a per-attempt throw
               (focus-window, the click) must not escape and kill the whole
               run over a single race. #>
            for ($attempt = 1; $attempt -le 3 -and -not $choice; $attempt++) {
                try {
                    Invoke-AgentDesktop -Arguments @('focus-window', '--window-id', $mainWindowId) -RequireOk -Description 'focus-window (main fixture window)' | Out-Null
                    Invoke-Target -Target $target -Action 'right-click' -Headed -RequireOk -Description 'context-target' | Out-Null
                    $popupWindowId = Get-WindowId -Where { $_['app_name'] -eq 'AgentDeskFixture.exe' -and $_['title'] -eq '' -and $_['visible'] -eq $true } -TimeoutSeconds 3
                    if ($popupWindowId) { $choice = Find-Target -WindowId $popupWindowId -NativeId 'context-choice' -TimeoutSeconds 3 }
                } catch { }
                if (-not $choice) { Start-Sleep -Milliseconds 500 }
            }
            if (-not $choice) {
                throw "Preconditions: staged id 'context-choice' did not resolve while its surface (context-target right-click) was open, after 3 attempts"
            }
            Invoke-Target -Target $choice -Action 'click' -RequireOk -Description 'context-choice' | Out-Null
            $verifiedIds.Add('context-choice')
        }

        $tabTwoHeader = Require-Target -Target (Find-Target -App $App -Role 'tab' -Name 'Two' -Exact -TimeoutSeconds 10) -Description 'tab:Two'
        Invoke-Target -Target $tabTwoHeader -Action 'select' -ActionArgs @('Two') -RequireOk -Description 'tab:Two' | Out-Null
        $paneHit = Find-TargetMatches -App $App -NativeId 'tab-two' -TimeoutSeconds 10
        if (-not $paneHit -or $paneHit.Count -lt 1) {
            throw "Preconditions: staged id 'tab-two' did not resolve after selecting the Two tab"
        }
        $verifiedIds.Add('tab-two')
        $tabOneHeader = Require-Target -Target (Find-Target -App $App -Role 'tab' -Name 'One' -Exact -TimeoutSeconds 10) -Description 'tab:One'
        Invoke-Target -Target $tabOneHeader -Action 'select' -ActionArgs @('One') -RequireOk -Description 'tab:One' | Out-Null
    }

    Enter-Stage -Lock DesktopLease -Body {
        $mainWindowId = Get-WindowId -Where { $_['title'] -eq 'AgentDeskFixture' } -TimeoutSeconds 10
        if (-not $mainWindowId) { throw 'Preconditions: could not resolve the main fixture window id by title' }

        $appearButton = Require-Target -Target (Find-Target -WindowId $mainWindowId -NativeId 'appear-later' -TimeoutSeconds 10) -Description 'appear-later'
        Invoke-Target -Target $appearButton -Action 'click' -RequireOk -Description 'appear-later' | Out-Null
        $appearedHit = Find-TargetMatches -WindowId $mainWindowId -NativeId 'appeared-text' -TimeoutSeconds 10
        if (-not $appearedHit -or $appearedHit.Count -lt 1) { throw "Preconditions: staged id 'appeared-text' did not resolve while appear-later was armed" }
        $verifiedIds.Add('appeared-text')
        $resetAppear = Require-Target -Target (Find-Target -WindowId $mainWindowId -NativeId 'reset-appeared-text' -TimeoutSeconds 10) -Description 'reset-appeared-text'
        Invoke-Target -Target $resetAppear -Action 'click' -RequireOk -Description 'reset-appeared-text' | Out-Null

        $openOccluder = Require-Target -Target (Find-Target -WindowId $mainWindowId -NativeId 'open-occluder' -TimeoutSeconds 10) -Description 'open-occluder'
        Invoke-Target -Target $openOccluder -Action 'click' -RequireOk -Description 'open-occluder' | Out-Null
        if (-not (Get-WindowId -Where { $_['title'] -eq 'fixture-overlay' } -TimeoutSeconds 10)) { throw "Preconditions: staged id 'fixture-overlay' did not resolve as its own top-level window" }
        $verifiedIds.Add('fixture-overlay')
        $closeOccluder = Require-Target -Target (Find-Target -WindowId $mainWindowId -NativeId 'close-occluder' -TimeoutSeconds 10) -Description 'close-occluder'
        Invoke-Target -Target $closeOccluder -Action 'click' -RequireOk -Description 'close-occluder' | Out-Null

        $openDuplicates = Require-Target -Target (Find-Target -WindowId $mainWindowId -NativeId 'open-duplicate-windows' -TimeoutSeconds 10) -Description 'open-duplicate-windows'
        Invoke-Target -Target $openDuplicates -Action 'click' -RequireOk -Description 'open-duplicate-windows' | Out-Null
        $duplicateCount = Get-WindowId -Where { $_['title'] -eq 'Duplicate Window' } -TimeoutSeconds 10 -CountOnly
        if ($duplicateCount -lt 2) { throw "Preconditions: staged ids 'duplicate-window-a'/'duplicate-window-b' - expected 2 'Duplicate Window' top-level windows, saw $duplicateCount" }
        $verifiedIds.Add('duplicate-window-a')
        $verifiedIds.Add('duplicate-window-b')
        $closeDuplicates = Require-Target -Target (Find-Target -WindowId $mainWindowId -NativeId 'close-duplicate-windows' -TimeoutSeconds 10) -Description 'close-duplicate-windows'
        Invoke-Target -Target $closeDuplicates -Action 'click' -RequireOk -Description 'close-duplicate-windows' | Out-Null

        $openSheet = Require-Target -Target (Find-Target -WindowId $mainWindowId -NativeId 'open-sheet' -TimeoutSeconds 10) -Description 'open-sheet'
        Invoke-Target -Target $openSheet -Action 'click' -RequireOk -Description 'open-sheet' | Out-Null
        $sheetWindowId = Get-WindowId -Where { $_['title'] -eq 'Sheet' } -TimeoutSeconds 10
        if (-not $sheetWindowId) { throw 'Preconditions: the Sheet dialog did not present its own top-level window' }
        foreach ($id in @('sheet-title', 'sheet-field', 'confirm-sheet', 'cancel-sheet')) {
            $hit = Find-TargetMatches -WindowId $sheetWindowId -NativeId $id -TimeoutSeconds 10
            if (-not $hit -or $hit.Count -lt 1) { throw "Preconditions: staged id '$id' did not resolve inside the Sheet window" }
            $verifiedIds.Add($id)
        }
        $cancelSheet = Require-Target -Target (Find-Target -WindowId $sheetWindowId -NativeId 'cancel-sheet' -TimeoutSeconds 10) -Description 'cancel-sheet'
        Invoke-Target -Target $cancelSheet -Action 'click' -RequireOk -Description 'cancel-sheet' | Out-Null
    }

    Assert-StagedIdSetEquality -Verified $verifiedIds.ToArray() -Declared $Inventory.Staged
}
