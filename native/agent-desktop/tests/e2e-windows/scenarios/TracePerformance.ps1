#Requires -Version 5.1

<#
    TracePerformance.ps1 - U10 approach item 8: a session with trace on
    produces per-process JSONL segments, artifact-mode actions use the
    session that created their refs, the trace event kinds expected for a
    scripted interaction are present, and cost is measured under the probe
    corpus methodology (min-of-seven, warm-up discarded, min/median/max
    reported) - the vehicle this platform can actually run, per
    probes/windows/FINDINGS.md A15-13
    (scripts/perf-baseline-compare.sh is macOS-bound and does not run
    here).

    `--session <id>` is set through `$env:AGENT_DESKTOP_SESSION` for the
    duration of each leg's Enter-Stage body rather than threaded through a
    new Lib.psm1 parameter: Lib.psm1 sits just under the 400-line cap
    (LibEnvelope.psm1 already grew for this same reason), and
    `AGENT_DESKTOP_SESSION` is not one of rule07's five protected identity
    variables - CONCEPTS.md (Session) states that an explicit --session
    takes precedence over AGENT_DESKTOP_SESSION, so every existing
    Find-Target/Invoke-Target/Invoke-Snapshot call already honors it once
    set, with no wrapper changes needed. The variable is always cleared in
    a `finally`, never left set for a later scenario. A value produced
    inside an Enter-Stage body (a session id, a snapshot id, a sample list)
    is returned as that body scriptblock's own trailing expression -
    Enter-Stage's `& $Body` passes it straight through as Enter-Stage's own
    return value, so no `$script:`-scoped capture variable is needed to
    read it back in the caller.

    Trace files are read directly (never through the CLI, so never a
    command envelope) with `ConvertFrom-AgentJson` - R12/rule11 ban
    ConvertFrom-Json unconditionally, including here.
#>

Set-StrictMode -Version 2.0

function Invoke-TracePerformanceScenario {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$App)
    Register-Legs -Names @(
        'trace-session-jsonl-segments', 'trace-event-kinds-present-for-scripted-interaction',
        'trace-artifact-mode-uses-session-refmap', 'performance-cost-min-of-seven'
    )

    Invoke-TraceSegmentLegs -App $App
    Invoke-ArtifactModeLeg -App $App
    Invoke-CostMeasurementLeg -App $App
}

function Close-HarnessSession {
    param([Parameter(Mandatory = $true)][string]$SessionId)
    try { Enter-Stage -Lock DesktopLease -Body { Invoke-AgentDesktop -Arguments @('session', 'end', $SessionId) | Out-Null } } catch { }
}

function Invoke-TraceSegmentLegs {
    param([Parameter(Mandatory = $true)][string]$App)
    $sessionId = $null
    try {
        $sessionId = Enter-Stage -Lock DesktopLease -Body {
            $startEnvelope = Invoke-AgentDesktop -Arguments @('session', 'start') -RequireOk -Description 'session start'
            $startEnvelope['data']['session_id']
        }
        if (-not $sessionId) { throw 'session start returned no session_id' }

        $env:AGENT_DESKTOP_SESSION = $sessionId
        try {
            Enter-Stage -Lock DesktopLease -Body {
                $target = Require-Target -Target (Find-Target -App $App -NativeId 'primary-button' -TimeoutSeconds 10) -Description 'primary-button'
                Invoke-Target -Target $target -Action 'click' -RequireOk -Description 'primary-button' | Out-Null
            }
        } finally {
            Remove-Item -Path 'Env:\AGENT_DESKTOP_SESSION' -ErrorAction SilentlyContinue
        }

        $traceDir = Join-Path $env:HOME ".agent-desktop\sessions\$sessionId\trace"
        $segments = @()
        if (Test-Path -LiteralPath $traceDir) {
            $segments = @(Get-ChildItem -LiteralPath $traceDir -Filter '*.jsonl' -File -ErrorAction SilentlyContinue)
        }
        if ($segments.Count -eq 0) { throw "no per-process JSONL segment found under $traceDir" }
        $nonEmpty = @($segments | Where-Object { $_.Length -gt 0 })
        if ($nonEmpty.Count -eq 0) { throw 'every JSONL segment found was empty' }
        Add-Pass -Leg 'trace-session-jsonl-segments'

        try {
            $events = New-Object System.Collections.Generic.HashSet[string]
            foreach ($segment in $nonEmpty) {
                foreach ($line in (Get-Content -LiteralPath $segment.FullName)) {
                    if ([string]::IsNullOrWhiteSpace($line)) { continue }
                    $record = ConvertFrom-AgentJson -Json $line
                    if ($record.ContainsKey('event')) { [void]$events.Add([string]$record['event']) }
                }
            }
            $expected = @(
                'trace.meta', 'command.start', 'ref.resolve.start', 'ref.resolve.ok',
                'actionability.check.start', 'actionability.check.ok',
                'action.dispatch.start', 'action.dispatch.ok', 'command.end'
            )
            $missing = @($expected | Where-Object { -not $events.Contains($_) })
            if ($missing.Count -gt 0) { throw "missing expected trace event kinds: $($missing -join ', ') (observed: $($events -join ', '))" }
            Add-Pass -Leg 'trace-event-kinds-present-for-scripted-interaction'
        } catch { Add-Fail -Leg 'trace-event-kinds-present-for-scripted-interaction' -Reason $_.Exception.Message }
    } catch {
        Add-Fail -Leg 'trace-session-jsonl-segments' -Reason $_.Exception.Message
        Add-Fail -Leg 'trace-event-kinds-present-for-scripted-interaction' -Reason "skipped: $($_.Exception.Message)"
    } finally {
        Remove-Item -Path 'Env:\AGENT_DESKTOP_SESSION' -ErrorAction SilentlyContinue
        if ($sessionId) { Close-HarnessSession -SessionId $sessionId }
    }
}

function Invoke-ArtifactModeLeg {
    <# ArtifactsMode::Full (--screenshots) copies each refmap into
       <session>/trace/refmaps/<snapshot_id>.json, as CONCEPTS.md's
       Replay Artifacts entry describes. The snapshot id proving this is the one the
       click's own ref actually resolved from, not merely "a" snapshot id
       under the session. #>
    param([Parameter(Mandatory = $true)][string]$App)
    $sessionId = $null
    try {
        $sessionId = Enter-Stage -Lock DesktopLease -Body {
            $startEnvelope = Invoke-AgentDesktop -Arguments @('session', 'start', '--screenshots') -RequireOk -Description 'session start --screenshots'
            $startEnvelope['data']['session_id']
        }
        if (-not $sessionId) { throw 'session start --screenshots returned no session_id' }

        $env:AGENT_DESKTOP_SESSION = $sessionId
        $usedSnapshotId = $null
        try {
            $usedSnapshotId = Enter-Stage -Lock DesktopLease -Body {
                $target = Require-Target -Target (Find-Target -App $App -NativeId 'toggle-box' -TimeoutSeconds 10) -Description 'toggle-box'
                Invoke-Target -Target $target -Action 'toggle' -RequireOk -Description 'toggle-box' | Out-Null
                $target.SnapshotId
            }
        } finally {
            Remove-Item -Path 'Env:\AGENT_DESKTOP_SESSION' -ErrorAction SilentlyContinue
        }
        if (-not $usedSnapshotId) { throw 'could not determine the snapshot id the acting ref actually resolved from' }

        $refmapPath = Join-Path $env:HOME ".agent-desktop\sessions\$sessionId\trace\refmaps\$usedSnapshotId.json"
        if (-not (Test-Path -LiteralPath $refmapPath)) { throw "no refmap copy found at $refmapPath - ArtifactsMode::Full did not carry the acting ref's own session" }
        Add-Pass -Leg 'trace-artifact-mode-uses-session-refmap'
    } catch {
        Add-Fail -Leg 'trace-artifact-mode-uses-session-refmap' -Reason $_.Exception.Message
    } finally {
        Remove-Item -Path 'Env:\AGENT_DESKTOP_SESSION' -ErrorAction SilentlyContinue
        if ($sessionId) { Close-HarnessSession -SessionId $sessionId }
    }
}

function Invoke-CostMeasurementLeg {
    <# Probe corpus methodology (A15-13, applied A18-7): min-of-seven with
       the warm-up discarded, reported as min with median and max beside
       it. This leg measures and records; it does not gate on an absolute
       number - the pinned-baseline write-back (R18b) is U15's, not this
       unit's. #>
    param([Parameter(Mandatory = $true)][string]$App)
    try {
        $samples = Enter-Stage -Lock DesktopLease -Body {
            $collected = @()
            for ($i = 0; $i -lt 7; $i++) {
                $clock = [System.Diagnostics.Stopwatch]::StartNew()
                $envelope = Invoke-AgentDesktop -Arguments @('list-windows') -TimeoutSeconds 20
                $clock.Stop()
                if ($envelope['ok'] -ne $true) { throw "list-windows sample $i failed: $($envelope['error']['code'])" }
                $collected += , $clock.Elapsed.TotalMilliseconds
            }
            , $collected
        }
        if (-not $samples -or $samples.Count -lt 7) { throw "collected $(if ($samples) { $samples.Count } else { 0 }) samples, expected 7" }
        $warm = $samples[1..6]
        $sorted = $warm | Sort-Object
        # rule15-reported: a cost baseline is recorded for the ledger, not gated -
    # the corpus methodology reports min with median and max beside it, and a
    # threshold here would fail on desktop contention rather than on latency.
    $min = $sorted[0]
        $max = $sorted[-1]
        $median = $sorted[[Math]::Floor($sorted.Count / 2)]
        Write-Host ("VERDICT probe cost list-windows: min={0}ms median={1}ms max={2}ms (n=6, warm-up discarded)" -f $min, $median, $max)
        Add-Pass -Leg 'performance-cost-min-of-seven'
    } catch { Add-Fail -Leg 'performance-cost-min-of-seven' -Reason $_.Exception.Message }
}
