#Requires -Version 5.1

<#
    Observation.ps1 - U9 approach item 1: the tree is right. One snapshot
    exposes every role in R4's closed list (derived from
    crates/windows/src/tree/roles.rs, KTD8), --skeleton clamps depth and
    annotates truncated containers, --root replaces only that subtree's
    refs, find resolves by --native-id/--name/--role, bounds are present
    with --include-bounds and absent in compact mode, and the twin controls
    prove both arms of bounds-hash disambiguation.
#>

Set-StrictMode -Version 2.0

$script:ObservationRoles = @(
    'button', 'textfield', 'checkbox', 'combobox', 'slider', 'incrementor', 'radiobutton',
    'tab', 'tablist', 'treeitem', 'outline', 'link', 'listbox', 'menuitem', 'cell', 'row',
    'switch', 'menubutton'
)

function Find-TreeNodeById {
    param($Node, [Parameter(Mandatory = $true)][string]$Id)
    if ($Node.ContainsKey('native_id') -and $Node['native_id'] -and $Node['native_id']['value'] -eq $Id) { return $Node }
    if ($Node.ContainsKey('children')) {
        foreach ($child in $Node['children']) {
            $found = Find-TreeNodeById -Node $child -Id $Id
            if ($found) { return $found }
        }
    }
    return $null
}

function Get-TreeRoleSet {
    param($Node, [System.Collections.Generic.HashSet[string]]$Roles)
    if ($Node.ContainsKey('role')) { [void]$Roles.Add([string]$Node['role']) }
    if ($Node.ContainsKey('children')) {
        foreach ($child in $Node['children']) { Get-TreeRoleSet -Node $child -Roles $Roles }
    }
}

function Get-TreeMaxDepth {
    param($Node, [int]$Depth = 0)
    $max = $Depth
    if ($Node.ContainsKey('children')) {
        foreach ($child in $Node['children']) {
            $childMax = Get-TreeMaxDepth -Node $child -Depth ($Depth + 1)
            if ($childMax -gt $max) { $max = $childMax }
        }
    }
    return $max
}

function Test-AnyNodeHasKey {
    param($Node, [Parameter(Mandatory = $true)][string]$Key)
    if ($Node.ContainsKey($Key)) { return $true }
    if ($Node.ContainsKey('children')) {
        foreach ($child in $Node['children']) {
            if (Test-AnyNodeHasKey -Node $child -Key $Key) { return $true }
        }
    }
    return $false
}

function Invoke-ObservationScenario {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$App)
    Register-Legs -Names @(
        'role-coverage-one-snapshot', 'scroll-container-refable', 'skeleton-depth-clamp',
        'root-drilldown-scoped-refs', 'find-by-name', 'find-by-role', 'bounds-present-with-flag',
        'bounds-absent-compact', 'twins-ambiguous-after-move', 'twins-resolve-without-move'
    )

    Enter-Stage -Lock DesktopLease -Body {
        $snap = Invoke-Snapshot -App $App
        $roles = [System.Collections.Generic.HashSet[string]]::new()
        Get-TreeRoleSet -Node $snap.Root -Roles $roles
        $missing = @($script:ObservationRoles | Where-Object { -not $roles.Contains($_) })
        if ($missing.Count -gt 0) {
            Add-Fail -Leg 'role-coverage-one-snapshot' -Reason "missing roles in one snapshot: $($missing -join ', ')"
        } else {
            Add-Pass -Leg 'role-coverage-one-snapshot'
        }

        $scrollNode = Find-TreeNodeById -Node $snap.Root -Id 'scroll-area'
        if ($scrollNode -and $scrollNode.ContainsKey('ref_id') -and $scrollNode['ref_id']) {
            Add-Pass -Leg 'scroll-container-refable'
        } else {
            Add-Fail -Leg 'scroll-container-refable' -Reason 'scroll-area container did not appear as a ref-able element in the snapshot'
        }

        $skeleton = Invoke-Snapshot -App $App -Skeleton
        $depth = Get-TreeMaxDepth -Node $skeleton.Root
        $hasChildrenCount = Test-AnyNodeHasKey -Node $skeleton.Root -Key 'children_count'
        if ($depth -le 3 -and $hasChildrenCount) {
            Add-Pass -Leg 'skeleton-depth-clamp'
        } else {
            Add-Fail -Leg 'skeleton-depth-clamp' -Reason "skeleton depth=$depth (want <=3), children_count annotation present=$hasChildrenCount"
        }

        <# outline-tree itself is a bare Panel wearing only a ControlType
           override (tests/fixture-app-windows/FixtureCardsCollections.cs):
           it advertises no action beyond SetFocus, so is_ref_able
           (crates/core/src/refs/ref_alloc.rs) never gives it a ref, by design -
           outline-parent is the outline's own actionable evidence, not its
           container. scroll-area is the tree's genuinely ref-able
           container (advertises Scroll), so it is the drill-down root this
           leg exercises instead. #>
        $scrollArea = Find-TreeNodeById -Node $snap.Root -Id 'scroll-area'
        if (-not $scrollArea -or -not $scrollArea['ref_id']) {
            Add-Fail -Leg 'root-drilldown-scoped-refs' -Reason 'scroll-area did not resolve as a drill-down root'
        } else {
            $drill = Invoke-Snapshot -App $App -Root $scrollArea['ref_id']
            $drillHasRow = Find-TreeNodeById -Node $drill.Root -Id 'scroll-row-1'
            if ($drill.SnapshotId -eq $snap.SnapshotId -and $drillHasRow) {
                Add-Pass -Leg 'root-drilldown-scoped-refs'
            } else {
                Add-Fail -Leg 'root-drilldown-scoped-refs' -Reason 'a --root drill-down did not stay in the same snapshot namespace or lost its own subtree'
            }
        }

        $byName = Find-Target -App $App -Name 'Primary' -Exact -TimeoutSeconds 10
        if ($byName) { Add-Pass -Leg 'find-by-name' } else { Add-Fail -Leg 'find-by-name' -Reason "find --name 'Primary' --exact returned no match" }

        $byRole = Find-Target -App $App -Role 'checkbox' -TimeoutSeconds 10
        if ($byRole) { Add-Pass -Leg 'find-by-role' } else { Add-Fail -Leg 'find-by-role' -Reason "find --role checkbox returned no match" }

        $boundedSnap = Invoke-Snapshot -App $App -IncludeBounds
        $boundedButton = Find-TreeNodeById -Node $boundedSnap.Root -Id 'primary-button'
        if ($boundedButton -and $boundedButton.ContainsKey('bounds')) { Add-Pass -Leg 'bounds-present-with-flag' } else { Add-Fail -Leg 'bounds-present-with-flag' -Reason '--include-bounds did not attach a bounds field' }

        $compactButton = Find-TreeNodeById -Node $snap.Root -Id 'primary-button'
        if ($compactButton -and -not $compactButton.ContainsKey('bounds')) { Add-Pass -Leg 'bounds-absent-compact' } else { Add-Fail -Leg 'bounds-absent-compact' -Reason 'compact-mode snapshot carried a bounds field' }
    }

    <# A second, independent Enter-Stage rather than nesting inside the
       block above: DesktopLease cannot be re-acquired while already held
       (Enter-Stage refuses reentrant acquisition), and rule09 requires
       every Invoke-Target call site to be lexically enclosed in its own
       Enter-Stage - a call inside a helper function is not lexically
       inside the caller's block just because the caller happens to hold
       the lock at runtime. #>
    Enter-Stage -Lock DesktopLease -Body {
        <# select_by_bounds_hash resolves whenever exactly one live
           candidate still matches the stored hash - the only way to reach
           SearchVerdict::Ambiguous is to move BOTH twins so the stored
           hash matches neither, which move-twins does. A second leg
           proves the tie-break also works in the non-moved direction. #>
        $twins = Find-TargetMatches -App $App -NativeId 'twin-control' -TimeoutSeconds 10
        if (-not $twins -or $twins.Count -ne 2) {
            Add-Fail -Leg 'twins-ambiguous-after-move' -Reason "expected exactly 2 twin-control hits, saw $(if ($twins) { $twins.Count } else { 0 })"
            Add-Fail -Leg 'twins-resolve-without-move' -Reason 'skipped: twin discovery itself failed'
            return
        }
        $staleTwin = $twins.Targets[0]
        $mover = Require-Target -Target (Find-Target -App $App -NativeId 'move-twins' -TimeoutSeconds 10) -Description 'move-twins'
        Invoke-Target -Target $mover -Action 'click' -RequireOk -Description 'move-twins' | Out-Null
        <# Envelope inspection goes through Assert-Envelope, never through a
           direct .ok/.error read on the result - rule 5 forbids that outside
           Lib.psm1, and Assert-Envelope is the door it leaves open for
           exactly this refusal-tier assertion. #>
        $movedEnvelope = Invoke-Target -Target $staleTwin -Action 'click'
        try {
            Assert-Envelope -Envelope $movedEnvelope -ErrorCode 'AMBIGUOUS_TARGET' -Delivery 'not_delivered' -Retry 'safe'
            Add-Pass -Leg 'twins-ambiguous-after-move'
        } catch {
            Add-Fail -Leg 'twins-ambiguous-after-move' -Reason $_.Exception.Message
        }

        $freshTwins = Find-TargetMatches -App $App -NativeId 'twin-control' -TimeoutSeconds 10
        if ($freshTwins -and $freshTwins.Count -eq 2) {
            $unmovedEnvelope = Invoke-Target -Target $freshTwins.Targets[0] -Action 'click'
            try {
                Assert-Envelope -Envelope $unmovedEnvelope -Ok
                Add-Pass -Leg 'twins-resolve-without-move'
            } catch {
                Add-Fail -Leg 'twins-resolve-without-move' -Reason $_.Exception.Message
            }
        } else {
            Add-Fail -Leg 'twins-resolve-without-move' -Reason 'twin-control did not re-resolve to 2 hits after the ambiguity leg'
        }
    }
}
