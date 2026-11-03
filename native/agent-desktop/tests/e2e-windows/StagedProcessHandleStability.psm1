#Requires -Version 5.1

<#
    StagedProcessHandleStability.psm1 - Get-StableNonInheritableHandleSet,
    split out of StagedProcess.psm1 purely to keep both files under the
    400-line cap (the same "split file escapes the scanner's per-entry-point
    assumptions" shape InteractionHeaded.ps1/selftest's own split-outs use).

    Comparing a single Get-NativeInheritableHandleValues snapshot against a
    single post-disable spawn is not enough: a harness process this
    long-lived accumulates undisposed System.Diagnostics.Process objects
    (every Get-Process caller upstream, e.g. ChromiumStage.psm1's polling
    loops), and a SafeHandle finalizer running between that snapshot and the
    spawn can close one, freeing its numeric value for immediate reuse by
    something inheritable created in the same window - not a hypothetical:
    reproduced live, 60 undisposed Get-Process reads immediately before a
    staged spawn leaked the identical handle value in 3 of 8 iterations.
    Draining finalizers first (a targeted GC.Collect/WaitForPendingFinalizers/
    GC.Collect, not a blanket one) empties the single largest source but
    does not close the window a background thread can still open a handle
    in, so this stabilizes instead: capture, disable whatever is not
    expected, and recapture until a fresh snapshot already needs no
    disabling - the same fixed-point pattern the rest of this harness uses
    for polling a real, externally-driven condition rather than trusting a
    single read of it.
#>

Set-StrictMode -Version 2.0

Import-Module (Join-Path $PSScriptRoot 'Native.psm1') -Force -Global

function Get-StableNonInheritableHandleSet {
    <#
    .SYNOPSIS
        Drains finalizers, then captures and neutralizes this process's own
        inheritable-handle set until a fresh capture already matches
        Expected, so the caller's own spawn sees a settled precondition
        rather than a racing one.
    .OUTPUTS
        pscustomobject: Before (the stable capture, for reporting what was
        true at spawn) and Disabled (the union of every handle value this
        call turned non-inheritable, across every pass - the caller must
        re-enable exactly this set, not just the last pass's, or an earlier
        pass's handle stays wrongly non-inheritable for the rest of the run).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][System.Collections.Generic.List[long]]$Expected,
        [int]$MaxPasses = 5
    )
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
    [System.GC]::Collect()

    $disabled = New-Object System.Collections.Generic.List[long]
    $capture = $null
    for ($pass = 0; $pass -lt $MaxPasses; $pass++) {
        $capture = @(Get-NativeInheritableHandleValues)
        $extra = @($capture | Where-Object { -not ($Expected -contains $_) })
        if ($extra.Count -eq 0) { return [pscustomobject]@{ Before = $capture; Disabled = $disabled } }
        foreach ($handle in $extra) {
            try { Set-NativeHandleInheritable -Handle ([IntPtr]$handle) -Enabled $false } catch { }
            if (-not ($disabled -contains $handle)) { $disabled.Add($handle) }
        }
    }
    throw "Get-StableNonInheritableHandleSet: the inheritable-handle set never stabilized within $MaxPasses passes (last capture: $($capture -join ','))"
}

Export-ModuleMember -Function @('Get-StableNonInheritableHandleSet')
