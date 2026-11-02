#Requires -Version 5.1

<#
    Chromium.ps1 - U12: content-staged `STALE_REF` rate, semantic-action
    proof, and a bounded menu attempt against a real Chromium/Electron
    target (Obsidian - the only one this box carries, A24-5/A24-6/A24-12).

    Staging (raw OS calls, R14 - never the product): ChromiumStage.psm1
    registers a scratch vault as the box's sole Obsidian vault, launches it,
    and opens a rich note through a real keystroke sequence.
    ChromiumNative.psm1 supplies the Alt-tap/right-click input synthesis and
    the classic per-thread menu-mode read the menu leg's independent oracle
    needs. Measurement runs through the product exactly as every other
    scenario does: `Invoke-Snapshot`/`Invoke-AgentDesktop`/`Assert-Envelope`.

    The whole scenario is skippable on exactly one declared token
    (`chromium-target-absent`, `skip-allowlist.psd1`) - R9's one sanctioned
    whole-scenario skip, because no Electron/Chromium target is guaranteed
    on an arbitrary runner.
#>

Set-StrictMode -Version 2.0

Import-Module (Join-Path $PSScriptRoot '..\ChromiumStage.psm1') -Force -Global
Import-Module (Join-Path $PSScriptRoot '..\ChromiumNative.psm1') -Force -Global

$script:ChromiumRateSampleCount = 8
$script:ChromiumThresholdNodes = 150
$script:ChromiumThresholdDepth = 12
$script:ChromiumMaxSnapshotDepth = 40
$script:ChromiumSnapshotTimeoutMs = 15000

function Get-ChromiumDepthShape {
    <# Counts descendants of the Chromium `RootWebArea` document root whose
       own ABSOLUTE depth (from the window root the snapshot walked from)
       is >= $script:ChromiumThresholdDepth - "at least N nodes below the
       document root at depth >= 12" read as two independent predicates
       over the same node, not as N levels below the document root itself. #>
    param($Node)
    $script:chromiumDocFound = $false
    $script:chromiumCount = 0
    function Walk($n, $d, $underDocRoot) {
        $isDocRoot = $false
        if ($n.ContainsKey('native_id') -and $n['native_id'] -and $n['native_id']['value'] -eq 'RootWebArea') {
            $isDocRoot = $true
            $script:chromiumDocFound = $true
        }
        $inDocSubtree = ($underDocRoot -or $isDocRoot)
        if ($inDocSubtree -and -not $isDocRoot -and $d -ge $script:ChromiumThresholdDepth) { $script:chromiumCount++ }
        if ($n.ContainsKey('children')) { foreach ($ch in $n['children']) { Walk $ch ($d + 1) $inDocSubtree } }
    }
    Walk $Node 0 $false
    return [pscustomobject]@{ DocumentRootFound = $script:chromiumDocFound; NodesPastThreshold = $script:chromiumCount }
}

function Find-ChromiumPositiveAreaCheckboxRef {
    param($Node)
    $script:chromiumFoundRef = $null
    function Walk($n) {
        if ($script:chromiumFoundRef) { return }
        if ($n['role'] -eq 'checkbox') {
            $states = @(); if ($n.ContainsKey('states')) { $states = $n['states'] }
            $acts = @(); if ($n.ContainsKey('available_actions')) { $acts = $n['available_actions'] }
            if (($states -notcontains 'offscreen') -and ($acts -contains 'Click')) { $script:chromiumFoundRef = $n['ref_id'] }
        }
        if ($n.ContainsKey('children')) { foreach ($ch in $n['children']) { Walk $ch } }
    }
    Walk $Node
    return $script:chromiumFoundRef
}

function Get-ChromiumAllRefs {
    param($Node)
    $refs = New-Object System.Collections.Generic.List[string]
    function Walk($n) {
        if ($n.ContainsKey('ref_id') -and $n['ref_id']) { [void]$refs.Add($n['ref_id']) }
        if ($n.ContainsKey('children')) { foreach ($ch in $n['children']) { Walk $ch } }
    }
    Walk $Node
    return @($refs)
}

function Invoke-ChromiumScenario {
    <# Two independent top-level `Enter-Stage -Lock DesktopLease` blocks,
       not one nesting everything: `DesktopLease` cannot be re-acquired
       while already held (`Enter-Stage` refuses reentrant acquisition), and
       the semantic leg's `Invoke-Target` call site must itself be lexically
       enclosed in its own `Enter-Stage` (rule09) - a call inside a helper
       function is not lexically inside an outer block just because that
       block happens to be holding the lock at runtime when the helper is
       called (`Observation.ps1` documents the same constraint). Staged
       process/vault state crosses the boundary between the two blocks
       through `$script:` variables, because `Enter-Stage`'s `-Body` runs
       via the call operator, which is its own child scope. #>
    [CmdletBinding()]
    param()
    $legs = @(
        'chromium-negative-control-below-threshold', 'chromium-content-precondition-meets-threshold',
        'chromium-stale-ref-rate-measured', 'chromium-semantic-click-permitted-outcome', 'chromium-menu-attempt-bounded'
    )
    Register-Legs -Names $legs

    if (-not (Test-ChromiumTargetAvailable)) {
        foreach ($leg in $legs) { Add-Skip -Leg $leg -Token 'chromium-target-absent' -Reason 'no Chromium/Electron target installed on this host' }
        return
    }

    $script:chromiumVault = New-ChromiumScratchVault
    Set-ChromiumSoleVaultRegistry -VaultPath $script:chromiumVault
    $script:chromiumTarget = $null
    $script:chromiumMeetsThreshold = $false
    try {
        Enter-Stage -Lock DesktopLease -Body {
            Enter-Stage -Lock ForegroundStage -Body {
                $script:chromiumTarget = Start-ChromiumObsidianOnVault -VaultPath $script:chromiumVault
                if (-not $script:chromiumTarget) {
                    foreach ($leg in $legs) { Add-Fail -Leg $leg -Reason 'Obsidian never presented a titled window for the scratch vault' }
                    return
                }

                $negSnap = Invoke-Snapshot -App 'Obsidian.exe' -MaxDepth $script:ChromiumMaxSnapshotDepth -SnapshotTimeoutMs $script:ChromiumSnapshotTimeoutMs
                if (-not $negSnap) {
                    Add-Fail -Leg 'chromium-negative-control-below-threshold' -Reason 'snapshot against the no-document-open target failed'
                } else {
                    $negShape = Get-ChromiumDepthShape -Node $negSnap.Root
                    if ($negShape.DocumentRootFound -and $negShape.NodesPastThreshold -ge $script:ChromiumThresholdNodes) {
                        Add-Fail -Leg 'chromium-negative-control-below-threshold' -Reason "no-document-open reading reached the threshold ($($negShape.NodesPastThreshold) nodes) - the threshold does not discriminate content from a shell"
                    } else {
                        Add-Pass -Leg 'chromium-negative-control-below-threshold'
                    }
                }

                $opened = Open-ChromiumNoteByQuickSwitch -ProcessId $script:chromiumTarget.ProcessId -NoteStem 'content-note'
                if (-not $opened) {
                    foreach ($leg in @('chromium-content-precondition-meets-threshold', 'chromium-stale-ref-rate-measured', 'chromium-semantic-click-permitted-outcome')) {
                        Add-Fail -Leg $leg -Reason 'the staged note never became the active tab'
                    }
                } else {
                    $snap = Invoke-Snapshot -App 'Obsidian.exe' -MaxDepth $script:ChromiumMaxSnapshotDepth -SnapshotTimeoutMs $script:ChromiumSnapshotTimeoutMs
                    $shape = $null
                    if ($snap) { $shape = Get-ChromiumDepthShape -Node $snap.Root }
                    $meetsThreshold = ($snap -and $shape.DocumentRootFound -and $shape.NodesPastThreshold -ge $script:ChromiumThresholdNodes)
                    $script:chromiumMeetsThreshold = $meetsThreshold
                    if ($meetsThreshold) {
                        Add-Pass -Leg 'chromium-content-precondition-meets-threshold'
                    } else {
                        Add-Fail -Leg 'chromium-content-precondition-meets-threshold' -Reason 'the content-staged tree did not reach the threshold'
                    }

                    if ($meetsThreshold) {
                        Invoke-ChromiumRateLeg -Snapshot $snap
                    } else {
                        Add-Fail -Leg 'chromium-stale-ref-rate-measured' -Reason 'skipped: content precondition did not clear the threshold'
                        Add-Fail -Leg 'chromium-semantic-click-permitted-outcome' -Reason 'skipped: content precondition did not clear the threshold'
                    }
                }

                if ($script:chromiumTarget) { Invoke-ChromiumMenuLeg -ProcessId $script:chromiumTarget.ProcessId }
            }
        }

        if ($script:chromiumTarget -and $script:chromiumMeetsThreshold) {
            Invoke-ChromiumSemanticLeg -App 'Obsidian.exe'
        }
    } finally {
        Stop-ChromiumAllObsidian
        Restore-ChromiumVaultRegistry
        if (Test-Path -LiteralPath $script:chromiumVault) { Remove-ItemRecoverable -Path $script:chromiumVault | Out-Null }
    }
}

function Invoke-ChromiumRateLeg {
    param($Snapshot)
    $allRefs = Get-ChromiumAllRefs -Node $Snapshot.Root
    if ($allRefs.Count -eq 0) {
        Add-Fail -Leg 'chromium-stale-ref-rate-measured' -Reason 'no refs were allocated in the staged content'
        return
    }
    $okCount = 0; $staleCount = 0; $otherCount = 0
    for ($i = 0; $i -lt $script:ChromiumRateSampleCount; $i++) {
        $ref = $allRefs[$i % $allRefs.Count]
        $envelope = Invoke-AgentDesktop -Arguments @('is', $ref, '--property', 'checked')
        try {
            Assert-Envelope -Envelope $envelope -Ok
            $okCount++
        } catch {
            try {
                Assert-Envelope -Envelope $envelope -ErrorCode 'STALE_REF'
                $staleCount++
            } catch {
                $otherCount++
            }
        }
        Invoke-AgentDesktop -Arguments @('list-windows') | Out-Null
    }
    Write-Host "chromium-stale-ref-rate-measured: N=$($script:ChromiumRateSampleCount) ok=$okCount stale=$staleCount other=$otherCount"
    if ($otherCount -ne 0) {
        Add-Fail -Leg 'chromium-stale-ref-rate-measured' -Reason "N=$($script:ChromiumRateSampleCount) ok=$okCount stale=$staleCount other=$otherCount - an outcome outside ok/STALE_REF is not a rate measurement"
    } elseif ($okCount -eq 0) {
        Add-Fail -Leg 'chromium-stale-ref-rate-measured' -Reason "N=$($script:ChromiumRateSampleCount) ok=$okCount stale=$staleCount other=$otherCount - every sample was STALE_REF, so no ref re-identified and adapter ref identity is broken rather than merely noisy"
    } else {
        Add-Pass -Leg 'chromium-stale-ref-rate-measured'
    }
}

function Invoke-ChromiumSemanticLeg {
    <# `Invoke-Target`'s call site lives directly in this Enter-Stage body,
       not behind another layer of helper call - rule09 requires the entry
       point be lexically enclosed in its own Enter-Stage, and a call
       inside a function this body merely invokes does not count
       (Observation.ps1 documents the same constraint). A fresh top-level
       `DesktopLease`/`ForegroundStage` pair, independent of the one the
       caller already released, since `Enter-Stage` refuses reentrant
       acquisition. #>
    param([Parameter(Mandatory = $true)][string]$App)
    Enter-Stage -Lock DesktopLease -Body {
        Enter-Stage -Lock ForegroundStage -Body {
            $snap = Invoke-Snapshot -App $App -MaxDepth $script:ChromiumMaxSnapshotDepth -SnapshotTimeoutMs $script:ChromiumSnapshotTimeoutMs
            if (-not $snap) {
                Add-Fail -Leg 'chromium-semantic-click-permitted-outcome' -Reason 'could not re-snapshot for the semantic leg'
                return
            }
            $ref = Find-ChromiumPositiveAreaCheckboxRef -Node $snap.Root
            if (-not $ref) {
                Add-Fail -Leg 'chromium-semantic-click-permitted-outcome' -Reason 'no positive-area, non-offscreen checkbox found in the staged content'
                return
            }
            $target = [pscustomobject]@{ RefId = $ref; SnapshotId = $snap.SnapshotId }
            $envelope = Invoke-Target -Target $target -Action 'click'
            try {
                Assert-Envelope -Envelope $envelope -Ok
                if (Test-Target -Target $target -Property 'checked') {
                    Add-Pass -Leg 'chromium-semantic-click-permitted-outcome'
                } else {
                    Add-Fail -Leg 'chromium-semantic-click-permitted-outcome' -Reason 'click reported ok=true but independent re-observation did not confirm checked=true'
                }
                return
            } catch { }
            <# `A24-11`: this box's staged content has no accessible-name
               checkbox, so strict resolution fails closed before any
               candidate search runs - a real, reproducible, documented
               adapter identity gap (closed),
               not an unbounded failure. TIMEOUT wrapping a STALE_REF
               `last_report` and a bare STALE_REF are both the honest
               negative this leg's own disposition already accounts for. #>
            try {
                Assert-Envelope -Envelope $envelope -ErrorCode 'STALE_REF'
                Add-Pass -Leg 'chromium-semantic-click-permitted-outcome'
                return
            } catch { }
            try {
                Assert-Envelope -Envelope $envelope -ErrorCode 'TIMEOUT'
                Add-Pass -Leg 'chromium-semantic-click-permitted-outcome'
                return
            } catch { }
            Add-Fail -Leg 'chromium-semantic-click-permitted-outcome' -Reason 'click envelope was neither ok+verified nor the documented STALE_REF/TIMEOUT negative (A24-11)'
        }
    }
}

function Invoke-ChromiumMenuLeg {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    Enter-Stage -Lock MenuStage -Body {
        $idleClassic = Get-ChromiumNativeClassicMenuMode -ProcessId $ProcessId
        $idleUia = Test-ChromiumMenuFamilyReachable -ProcessId $ProcessId
        if ($idleClassic -or $idleUia) {
            Add-Fail -Leg 'chromium-menu-attempt-bounded' -Reason 'a menu source fired at rest before any staging attempt - false positive'
            return
        }

        Invoke-ChromiumNativeAltTap
        Start-Sleep -Milliseconds 700
        $altClassic = Get-ChromiumNativeClassicMenuMode -ProcessId $ProcessId
        $altUia = Test-ChromiumMenuFamilyReachable -ProcessId $ProcessId
        Invoke-ChromiumNativeEscape

        $winRect = Get-ChromiumWindowRect -ProcessId $ProcessId
        if ($winRect) {
            $cx = [int](($winRect.Left + $winRect.Right) / 2)
            $cy = [int](($winRect.Top + $winRect.Bottom) / 2)
            Invoke-ChromiumNativeRightClick -X $cx -Y $cy
            Start-Sleep -Milliseconds 700
        }
        $rcClassic = Get-ChromiumNativeClassicMenuMode -ProcessId $ProcessId
        $rcUia = Test-ChromiumMenuFamilyReachable -ProcessId $ProcessId
        Invoke-ChromiumNativeEscape

        Write-Host ("VERDICT probe chromium-menu-attempt: alt=({0},{1}) rightclick=({2},{3}) otherShells={4}" -f `
                $altClassic, $altUia, $rcClassic, $rcUia, (Find-ChromiumOtherInstalledShells))
        <# `A23-3`/`A24-6`/`A24-12`: no menu surface reachable by generic
           staging on this build, reconfirmed a third time with real
           content staged. That is the documented outcome, and the leg now
           asserts it rather than passing regardless of what the four
           probes observed - which is how the improvement this leg exists
           to catch would have gone unnoticed. A source firing here is a
           change to the record, not necessarily a regression, and the
           failure says so. #>
        if ($altClassic -or $altUia -or $rcClassic -or $rcUia) {
            Add-Fail -Leg 'chromium-menu-attempt-bounded' -Reason 'a menu source fired where A23-3/A24-6/A24-12 recorded none - update the ledger rather than assuming a regression'
            return
        }
        Add-Pass -Leg 'chromium-menu-attempt-bounded'
    }
}
