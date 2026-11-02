#Requires -Version 5.1

<#
    Reliability.ps1 - U10 approach item 5: remove-row then acting on the
    removed ref fails closed (STALE_REF), --wait-for-gone observes the
    removal, appear-later is observed by `wait --text` and by a post-action
    selector, and `wait enabled` on delayed-button.

    One correction, measured live against this fixture and binary and cited
    in the sub-phase report: the plan does not state a `--timeout-ms` for
    the stale-ref leg, and the default auto-wait budget matters here. A
    plain `click` on the pre-removal ref does not surface STALE_REF at all
    under the default budget - it returns generic `TIMEOUT` after ~5s,
    because the resolve loop treats "no live candidate found yet" as
    retryable and keeps polling until the deadline
    (crates/core/src/ref_action/ref_action_poll.rs's `execute_poll_loop`/
    `handle_resolve_failure`). `--timeout-ms 0` forces exactly one resolve
    attempt and reliably reports `STALE_REF` - the same deterministic-form
    correction Acceptance.ps1's occlusion leg makes for the same reason.
#>

Set-StrictMode -Version 2.0

function Invoke-ReliabilityScenario {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$App)
    Register-Legs -Names @(
        'reliability-stale-ref-after-removal', 'reliability-wait-for-gone-observes-removal',
        'reliability-appear-later-wait-text', 'reliability-appear-later-post-action-selector',
        'reliability-wait-enabled-delayed-button', 'reliability-stale-ref-contract-and-recovery',
        'errors-invalid-args-bare-ref', 'errors-snapshot-not-found-ghost-snapshot',
        'errors-stale-ref-absent-element-number', 'errors-app-not-found',
        'errors-element-not-found-select-missing-value',
        'batch-stop-on-error-halts-remaining', 'batch-continue-runs-remaining-and-reports-entry-error',
        'batch-unknown-command-rejects-whole-batch'
    )

    Invoke-RemoveRowLegs -App $App
    Invoke-StaleRefContractLeg -App $App
    Invoke-AppearLaterLegs -App $App
    Invoke-WaitEnabledLeg -App $App
    Invoke-ErrorEnvelopeLegs -App $App
    Invoke-BatchSemanticsLegs -App $App
}

function Invoke-RemoveRowLegs {
    <# removable-row is reset first (Visible = true) so this leg is
       falsifiable regardless of what an earlier run left behind - the same
       discipline NonInterference.ps1's check/clear legs use with their own
       Setup blocks. #>
    param([Parameter(Mandatory = $true)][string]$App)
    try {
        Enter-Stage -Lock DesktopLease -Body {
            $reset = Require-Target -Target (Find-Target -App $App -NativeId 'reset-removable' -TimeoutSeconds 10) -Description 'reset-removable'
            Invoke-Target -Target $reset -Action 'click' -RequireOk -Description 'reset-removable' | Out-Null

            $preRemoval = Require-Target -Target (Find-Target -App $App -NativeId 'removable-row' -TimeoutSeconds 10) -Description 'removable-row (pre-removal ref)'
            $removeRow = Require-Target -Target (Find-Target -App $App -NativeId 'remove-row' -TimeoutSeconds 10) -Description 'remove-row'

            $callArgs = @('click', $removeRow.RefId, '--wait-for-gone', 'button:Removable row')
            $envelope = Invoke-AgentDesktop -Arguments $callArgs -TimeoutSeconds 20
            Assert-Envelope -Envelope $envelope -Ok
            try {
                $stillThere = Find-Target -App $App -NativeId 'removable-row' -TimeoutSeconds 2
                if ($stillThere) { throw '--wait-for-gone returned ok but removable-row still resolves by --native-id' }
                Add-Pass -Leg 'reliability-wait-for-gone-observes-removal'
            } catch { Add-Fail -Leg 'reliability-wait-for-gone-observes-removal' -Reason $_.Exception.Message }

            try {
                $staleEnvelope = Invoke-AgentDesktop -Arguments @('click', $preRemoval.RefId, '--timeout-ms', '0')
                Assert-Envelope -Envelope $staleEnvelope -ErrorCode 'STALE_REF'
                Add-Pass -Leg 'reliability-stale-ref-after-removal'
            } catch { Add-Fail -Leg 'reliability-stale-ref-after-removal' -Reason $_.Exception.Message }

            $resetAgain = Require-Target -Target (Find-Target -App $App -NativeId 'reset-removable' -TimeoutSeconds 10) -Description 'reset-removable'
            Invoke-Target -Target $resetAgain -Action 'click' -RequireOk -Description 'reset-removable' | Out-Null
        }
    } catch {
        Add-Fail -Leg 'reliability-wait-for-gone-observes-removal' -Reason $_.Exception.Message
        Add-Fail -Leg 'reliability-stale-ref-after-removal' -Reason $_.Exception.Message
    }
}

function Invoke-StaleRefContractLeg {
    <# A ref taken before a real UI change (remove-row hides removable-row) must fail closed with the full agent-facing contract (STALE_REF, not_delivered, safe to retry, refresh-then-retry recovery), must not have acted (removable-status is read across the whole no-effect window), and the documented recovery (reset, fresh find, retry) must work on the same control. --timeout-ms 0 forces one resolve attempt, the same deterministic form Invoke-RemoveRowLegs uses. The first click is a falsifiability guard: it proves removable-row really drives removable-status before the removal. AMBIGUOUS_TARGET carries no recovery object (output.rs recovery_for_code has no arm for it) and the twin buttons drive no readout, so its disposition is asserted in Observation.ps1 and no NoEffect read exists for it. #>
    param([Parameter(Mandatory = $true)][string]$App)
    try {
        Enter-Stage -Lock DesktopLease -Body {
            $reset = Require-Target -Target (Find-Target -App $App -NativeId 'reset-removable' -TimeoutSeconds 10) -Description 'reset-removable'
            Invoke-Target -Target $reset -Action 'click' -RequireOk -Description 'reset-removable' | Out-Null
            $row = Require-Target -Target (Find-Target -App $App -NativeId 'removable-row' -TimeoutSeconds 10) -Description 'removable-row (pre-removal ref)'
            $status = Require-Target -Target (Find-Target -App $App -NativeId 'removable-status' -TimeoutSeconds 10) -Description 'removable-status'
            Assert-Effect -Target $row -StatusTarget $status -Property 'value' -Expected 'row-clicked' -ExpectedIsPrefix -AnyChange -Action 'click' | Out-Null
            $removeRow = Require-Target -Target (Find-Target -App $App -NativeId 'remove-row' -TimeoutSeconds 10) -Description 'remove-row'
            Invoke-Target -Target $removeRow -Action 'click' -RequireOk -Description 'remove-row' | Out-Null
            if (Find-Target -App $App -NativeId 'removable-row' -TimeoutSeconds 2) { throw 'removable-row still resolves after remove-row; the UI change did not happen' }

            $stale = Assert-NoEffect -Target $row -StatusTarget $status -Property 'value' -Action 'click' -ActionArgs @('--timeout-ms', '0')
            Assert-Envelope -Envelope $stale -ErrorCode 'STALE_REF' -Delivery 'not_delivered' -Retry 'safe'
            Assert-EnvelopeRecovery -Envelope $stale -Strategy 'refresh_snapshot_then_retry_original'

            $resetAgain = Require-Target -Target (Find-Target -App $App -NativeId 'reset-removable' -TimeoutSeconds 10) -Description 'reset-removable'
            Invoke-Target -Target $resetAgain -Action 'click' -RequireOk -Description 'reset-removable' | Out-Null
            $fresh = Require-Target -Target (Find-Target -App $App -NativeId 'removable-row' -TimeoutSeconds 10) -Description 'removable-row (fresh ref)'
            $statusAgain = Require-Target -Target (Find-Target -App $App -NativeId 'removable-status' -TimeoutSeconds 10) -Description 'removable-status'
            Assert-Effect -Target $fresh -StatusTarget $statusAgain -Property 'value' -Expected 'row-clicked' -ExpectedIsPrefix -AnyChange -Action 'click' | Out-Null
        }
        Add-Pass -Leg 'reliability-stale-ref-contract-and-recovery'
    } catch { Add-Fail -Leg 'reliability-stale-ref-contract-and-recovery' -Reason $_.Exception.Message }
}

function Invoke-AppearLaterLegs {
    <# reset-appeared-text forces the known-false starting state first, the
       same Setup discipline NonInterference.ps1's check/clear legs use, so
       the wait below is provably watching a real transition. #>
    param([Parameter(Mandatory = $true)][string]$App)
    try {
        Enter-Stage -Lock DesktopLease -Body {
            $reset = Require-Target -Target (Find-Target -App $App -NativeId 'reset-appeared-text' -TimeoutSeconds 10) -Description 'reset-appeared-text'
            Invoke-Target -Target $reset -Action 'click' -RequireOk -Description 'reset-appeared-text' | Out-Null
            $appearLater = Require-Target -Target (Find-Target -App $App -NativeId 'appear-later' -TimeoutSeconds 10) -Description 'appear-later'
            Invoke-Target -Target $appearLater -Action 'click' -RequireOk -Description 'appear-later' | Out-Null
        }

        try {
            Enter-Stage -Lock DesktopLease -Body {
                $waitEnvelope = Invoke-AgentDesktop -Arguments @('wait', '--text', 'appeared', '--app', $App, '--timeout', '5000') -TimeoutSeconds 15
                Assert-Envelope -Envelope $waitEnvelope -Ok
            }
            Add-Pass -Leg 'reliability-appear-later-wait-text'
        } catch { Add-Fail -Leg 'reliability-appear-later-wait-text' -Reason $_.Exception.Message }

        try {
            Enter-Stage -Lock DesktopLease -Body {
                $appeared = Require-Target -Target (Find-Target -App $App -NativeId 'appeared-text' -TimeoutSeconds 10) -Description 'appeared-text'
                $value = Get-Target -Target $appeared -Property 'value'
                if ($value -ne 'appeared') { throw "appeared-text read '$value' via a fresh post-action find/get, expected 'appeared'" }
            }
            Add-Pass -Leg 'reliability-appear-later-post-action-selector'
        } catch { Add-Fail -Leg 'reliability-appear-later-post-action-selector' -Reason $_.Exception.Message }

        Enter-Stage -Lock DesktopLease -Body {
            $resetAgain = Require-Target -Target (Find-Target -App $App -NativeId 'reset-appeared-text' -TimeoutSeconds 10) -Description 'reset-appeared-text'
            Invoke-Target -Target $resetAgain -Action 'click' -RequireOk -Description 'reset-appeared-text' | Out-Null
        }
    } catch {
        Add-Fail -Leg 'reliability-appear-later-wait-text' -Reason $_.Exception.Message
        Add-Fail -Leg 'reliability-appear-later-post-action-selector' -Reason $_.Exception.Message
    }
}

function Invoke-WaitEnabledLeg {
    <# delayed-button starts disabled (reset-delayed-button forces that
       known-false state) and the 4s timer flips it enabled - `wait
       --predicate enabled` is the oracle, read independently of the click
       auto-wait legs Acceptance.ps1 already exercises against the same
       card. Wait-Target itself calls only Invoke-AgentDesktop (not
       Invoke-Target/Native), but it still touches the desktop, so it stays
       inside the same Enter-Stage body as the setup for R13's declared-lock
       discipline rather than only where rule09 strictly requires it. #>
    param([Parameter(Mandatory = $true)][string]$App)
    try {
        Enter-Stage -Lock DesktopLease -Body {
            $reset = Require-Target -Target (Find-Target -App $App -NativeId 'reset-delayed-button' -TimeoutSeconds 10) -Description 'reset-delayed-button'
            Invoke-Target -Target $reset -Action 'click' -RequireOk -Description 'reset-delayed-button' | Out-Null
            $enableLater = Require-Target -Target (Find-Target -App $App -NativeId 'enable-later' -TimeoutSeconds 10) -Description 'enable-later'
            Invoke-Target -Target $enableLater -Action 'click' -RequireOk -Description 'enable-later' | Out-Null
            $target = Require-Target -Target (Find-Target -App $App -NativeId 'delayed-button' -TimeoutSeconds 10) -Description 'delayed-button'
            if (Test-Target -Target $target -Property 'enabled') {
                throw 'delayed-button was already enabled before the wait, so the wait proves nothing'
            }
            $elapsed = [System.Diagnostics.Stopwatch]::StartNew()
            $ok = Wait-Target -Target $target -Predicate 'enabled' -TimeoutMs 8000
            $elapsed.Stop()
            if (-not $ok) { throw 'wait --predicate enabled on delayed-button did not report found within 8000ms' }
            <# The command's own success flag is the anti-pattern this harness
               forbids, and the sibling leg two functions above already reads
               the value back independently. Two things are checked that the
               flag cannot show: the button really is enabled now, and the
               wait actually waited - a build with no waiting at all would
               return before the 4s timer flips it. #>
            if (-not (Test-Target -Target $target -Property 'enabled')) {
                throw 'wait reported found but an independent read says delayed-button is still disabled'
            }
            if ($elapsed.ElapsedMilliseconds -lt 2000) {
                throw ("wait returned after only {0}ms, but delayed-button is not enabled until its 4s timer fires" -f $elapsed.ElapsedMilliseconds)
            }
        }
        Add-Pass -Leg 'reliability-wait-enabled-delayed-button'
    } catch { Add-Fail -Leg 'reliability-wait-enabled-delayed-button' -Reason $_.Exception.Message }
}

function Invoke-ErrorEnvelopeLegs {
    <# Each refusal must carry the right code, the not_delivered disposition and its documented suggestion or recovery, and leave the fixture unchanged. A ref with no ':' (the bare form) and ghost refs built with -f keep every string literal clear of the ref shape rule 4 forbids; the synthetic targets carry only the RefId and SnapshotId Assert-NoEffect reads. Exit code 1 for a structured refusal comes from src/main.rs finish(); 2 is clap parse errors only. #>
    param([Parameter(Mandatory = $true)][string]$App)
    $legNames = @(
        'errors-invalid-args-bare-ref', 'errors-snapshot-not-found-ghost-snapshot',
        'errors-stale-ref-absent-element-number', 'errors-app-not-found',
        'errors-element-not-found-select-missing-value'
    )
    try {
        Enter-Stage -Lock DesktopLease -Body {
            $button = Require-Target -Target (Find-Target -App $App -NativeId 'primary-button' -TimeoutSeconds 10) -Description 'primary-button'
            $clickStatus = Require-Target -Target (Find-Target -App $App -NativeId 'click-status' -TimeoutSeconds 10) -Description 'click-status'

            try {
                $bare = [pscustomobject]@{ RefId = '@e1'; SnapshotId = 'none' }
                $bareEnvelope = Assert-NoEffect -Target $bare -StatusTarget $clickStatus -Property 'value' -Action 'click'
                Assert-Envelope -Envelope $bareEnvelope -ErrorCode 'INVALID_ARGS' -Delivery 'not_delivered'
                Assert-EnvelopeSuggestion -Envelope $bareEnvelope -Contains 'snapshot-qualified'
                $bareRun = Invoke-AgentDesktopWithExitCode -Arguments @('click', '@e1')
                if ($bareRun.ExitCode -ne 1) { throw "bare @e1 exited $($bareRun.ExitCode), expected 1" }
                Add-Pass -Leg 'errors-invalid-args-bare-ref'
            } catch { Add-Fail -Leg 'errors-invalid-args-bare-ref' -Reason $_.Exception.Message }

            try {
                $ghost = [pscustomobject]@{ RefId = ('@{0}:e{1}' -f 'sdeadbeef', 1); SnapshotId = 'sdeadbeef' }
                $missing = Assert-NoEffect -Target $ghost -StatusTarget $clickStatus -Property 'value' -Action 'click' -ActionArgs @('--timeout-ms', '0')
                Assert-Envelope -Envelope $missing -ErrorCode 'SNAPSHOT_NOT_FOUND' -Delivery 'not_delivered'
                Assert-EnvelopeRecovery -Envelope $missing -Strategy 'refresh_snapshot_then_retry_original'
                Add-Pass -Leg 'errors-snapshot-not-found-ghost-snapshot'
            } catch { Add-Fail -Leg 'errors-snapshot-not-found-ghost-snapshot' -Reason $_.Exception.Message }

            try {
                $phantom = [pscustomobject]@{ RefId = ('@{0}:e{1}' -f $button.SnapshotId, 99999); SnapshotId = $button.SnapshotId }
                $absent = Assert-NoEffect -Target $phantom -StatusTarget $clickStatus -Property 'value' -Action 'click' -ActionArgs @('--timeout-ms', '0')
                Assert-Envelope -Envelope $absent -ErrorCode 'STALE_REF' -Delivery 'not_delivered'
                Assert-EnvelopeRecovery -Envelope $absent -Strategy 'refresh_snapshot_then_retry_original'
                Add-Pass -Leg 'errors-stale-ref-absent-element-number'
            } catch { Add-Fail -Leg 'errors-stale-ref-absent-element-number' -Reason $_.Exception.Message }

            try {
                $noApp = Invoke-AgentDesktopWithExitCode -Arguments @('snapshot', '--app', 'NoSuchApp9')
                if ($noApp.ExitCode -ne 1) { throw "snapshot --app NoSuchApp9 exited $($noApp.ExitCode), expected 1" }
                Assert-Envelope -Envelope $noApp.Envelope -ErrorCode 'APP_NOT_FOUND' -Delivery 'not_delivered'
                if (Get-Process -Name 'NoSuchApp9' -ErrorAction SilentlyContinue) { throw 'a NoSuchApp9 process exists, so the not-found claim is unfalsifiable on this host' }
                Add-Pass -Leg 'errors-app-not-found'
            } catch { Add-Fail -Leg 'errors-app-not-found' -Reason $_.Exception.Message }

            try {
                $tabOne = Require-Target -Target (Find-Target -App $App -Role 'tab' -Name 'One' -TimeoutSeconds 10) -Description 'tab One'
                $tabTwo = Require-Target -Target (Find-Target -App $App -Role 'tab' -Name 'Two' -TimeoutSeconds 10) -Description 'tab Two'
                $tabStatus = Require-Target -Target (Find-Target -App $App -NativeId 'tab-status' -TimeoutSeconds 10) -Description 'tab-status'
                Invoke-Target -Target $tabTwo -Action 'select' -ActionArgs @('Two') -RequireOk -Description 'tab Two (known start)' | Out-Null
                Assert-Effect -Target $tabOne -StatusTarget $tabStatus -Property 'value' -Action 'select' -ActionArgs @('One') -AnyChange | Out-Null
                $noItem = Assert-NoEffect -Target $tabOne -StatusTarget $tabStatus -Property 'value' -Action 'select' -ActionArgs @('NoSuchTab9')
                Assert-Envelope -Envelope $noItem -ErrorCode 'ELEMENT_NOT_FOUND' -Delivery 'not_delivered'
                Add-Pass -Leg 'errors-element-not-found-select-missing-value'
            } catch { Add-Fail -Leg 'errors-element-not-found-select-missing-value' -Reason $_.Exception.Message }
        }
    } catch {
        foreach ($leg in $legNames) { Add-Fail -Leg $leg -Reason $_.Exception.Message }
    }
}

function Invoke-BatchSemanticsLegs {
    <# batch is sequential and non-atomic: an entry that fails at runtime halts the rest only with --stop-on-error (src/batch/execution.rs); an entry that cannot be parsed rejects the whole batch before any entry runs (src/batch/preparation.rs). Entry 1 acts on click-status and entry 3 on toggle-box, so each effect is read independently of the batch envelope. Entry 2 is a ghost-snapshot click: its ref is well-formed, so preflight passes and it fails only at run time. #>
    param([Parameter(Mandatory = $true)][string]$App)
    $legNames = @(
        'batch-stop-on-error-halts-remaining', 'batch-continue-runs-remaining-and-reports-entry-error',
        'batch-unknown-command-rejects-whole-batch'
    )
    try {
        Enter-Stage -Lock DesktopLease -Body {
            $button = Require-Target -Target (Find-Target -App $App -NativeId 'primary-button' -TimeoutSeconds 10) -Description 'primary-button'
            $clickStatus = Require-Target -Target (Find-Target -App $App -NativeId 'click-status' -TimeoutSeconds 10) -Description 'click-status'
            $box = Require-Target -Target (Find-Target -App $App -NativeId 'toggle-box' -TimeoutSeconds 10) -Description 'toggle-box'
            $ghostRef = '@{0}:e{1}' -f 'sdeadbeef', 1
            $entries = @(
                @{ Command = 'click'; Args = @{ ref_id = $button.RefId } }
                @{ Command = 'click'; Args = @{ ref_id = $ghostRef; timeout_ms = 0 } }
                @{ Command = 'check'; Args = @{ ref_id = $box.RefId } }
            )

            try {
                Invoke-Target -Target $box -Action 'uncheck' -RequireOk -Description 'toggle-box (known-false start)' | Out-Null
                $statusBefore = Get-Target -Target $clickStatus -Property 'value'
                $stopped = @(Invoke-AgentDesktopBatch -Entries $entries -TimeoutSeconds 30)
                if ($stopped.Count -ne 2) { throw "stop-on-error returned $($stopped.Count) results, expected 2 (entry 3 must not have run)" }
                if (-not $stopped[0].EntryOk -or $stopped[1].EntryOk) { throw 'entry 1 must succeed and entry 2 must fail' }
                if ($stopped[1].ErrorCode -ne 'SNAPSHOT_NOT_FOUND') { throw "entry 2 failed with '$($stopped[1].ErrorCode)', expected SNAPSHOT_NOT_FOUND" }
                if ((Get-Target -Target $clickStatus -Property 'value') -eq $statusBefore) { throw 'entry 1 reported ok but click-status did not move' }
                if (Test-Target -Target $box -Property 'checked') { throw 'entry 3 ran even though --stop-on-error halted the batch at entry 2' }
                Add-Pass -Leg 'batch-stop-on-error-halts-remaining'
            } catch { Add-Fail -Leg 'batch-stop-on-error-halts-remaining' -Reason $_.Exception.Message }

            try {
                Invoke-Target -Target $box -Action 'uncheck' -RequireOk -Description 'toggle-box (known-false start)' | Out-Null
                $continued = @(Invoke-AgentDesktopBatch -Entries $entries -TimeoutSeconds 30 -ContinueOnError)
                if ($continued.Count -ne 3) { throw "continue-on-error returned $($continued.Count) results, expected 3" }
                if ($continued[1].EntryOk -or $continued[1].ErrorCode -ne 'SNAPSHOT_NOT_FOUND') { throw "entry 2 should fail alone with SNAPSHOT_NOT_FOUND, got ok=$($continued[1].EntryOk) code='$($continued[1].ErrorCode)'" }
                if (-not (Test-Target -Target $box -Property 'checked')) { throw 'entry 3 did not run after the failed entry 2 in continue mode' }
                Add-Pass -Leg 'batch-continue-runs-remaining-and-reports-entry-error'
            } catch { Add-Fail -Leg 'batch-continue-runs-remaining-and-reports-entry-error' -Reason $_.Exception.Message }

            try {
                Invoke-Target -Target $box -Action 'uncheck' -RequireOk -Description 'toggle-box (known-false start)' | Out-Null
                $payload = ConvertTo-Json -InputObject @(
                    @{ command = 'check'; args = @{ ref_id = $box.RefId } }
                    @{ command = 'no-such-command'; args = @{} }
                ) -Depth 10 -Compress
                $rejected = Invoke-AgentDesktopWithExitCode -Arguments @('batch', $payload)
                if ($rejected.ExitCode -ne 1) { throw "malformed batch exited $($rejected.ExitCode), expected 1" }
                Assert-Envelope -Envelope $rejected.Envelope -ErrorCode 'INVALID_ARGS'
                if (Test-Target -Target $box -Property 'checked') { throw 'the valid entry 1 ran even though entry 2 made the whole batch invalid' }
                Add-Pass -Leg 'batch-unknown-command-rejects-whole-batch'
            } catch { Add-Fail -Leg 'batch-unknown-command-rejects-whole-batch' -Reason $_.Exception.Message }
        }
    } catch {
        foreach ($leg in $legNames) { Add-Fail -Leg $leg -Reason $_.Exception.Message }
    }
}
