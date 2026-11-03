#Requires -Version 5.1

<#
    U7SelfTestCasesAssert.ps1 - dot-sourced by Invoke-U7SelfTests.ps1. Cases
    1-6c: Find-Target's snapshot_id requirement, Invoke-AgentDesktop's
    fail-closed empty-stdout extraction, Assert-Effect's three conjuncts
    (status moved, pre-read guard, mechanism match), and
    Initialize-NoEffectWindow's 1.5x-p99 refusal and bootstrap fallback, and
    Invoke-AgentDesktopBatch's --stop-on-error default and -ContinueOnError.
    Split out of Invoke-U7SelfTests.ps1 purely to keep every file under the
    400-line cap; $script:FakeTarget/$OkClick/$OkClickPhysical and the
    New-StubConfig/Set-LibFunctionText/New-Baseline helpers are the caller's
    own scope (dot-sourcing shares it), never re-declared here.
#>

<#
    1. Find-Target: a payload lacking snapshot_id is a failure, not a
       partial target.
#>
Invoke-SelfTest 'Find-Target returns null, not a partial target, when snapshot_id is absent' {
    $noSnapshot = '{"version":"2.3","ok":true,"command":"find","data":{"match":{"ref_id":"@x:e1","role":"button","name":"OK"}}}'
    New-StubConfig -Rules @(@{ Match = '*find*'; Responses = @($noSnapshot) }) | Out-Null
    $result = Find-Target -App 'Stub' -NativeId 'anything' -TimeoutSeconds 1
    Assert-True ($null -eq $result) 'Find-Target must return $null when the envelope carries a match but no snapshot_id'
}

<#
    1b. Invoke-AgentDesktop refuses to hand ConvertFrom-AgentJson an empty
        stdout string (a timed-out or killed child, or a non-JSON tool)
        and instead throws with ExitCode/TimedOut context - fail-closed
        extraction (json_tool.py:62-95's pattern), never the opaque
        "Cannot bind argument to parameter 'Json'" a caller would
        otherwise see three call frames away from the real cause.
#>
Invoke-SelfTest 'Invoke-AgentDesktop throws a diagnosable error on empty stdout, not an opaque bind failure' {
    Set-TargetBinary -FilePath 'cmd.exe' -PrefixArgs @('/c', 'rem')
    $threw = $false
    try {
        Invoke-AgentDesktop -Arguments @('find', '--first') -TimeoutSeconds 5 | Out-Null
    } catch {
        $threw = $true
        Assert-True ($_.Exception.Message -like '*ExitCode=*') "the error must name ExitCode/TimedOut, not surface ConvertFrom-AgentJson's bind failure - saw: $($_.Exception.Message)"
        Assert-True ($_.Exception.Message -notlike "*Cannot bind argument*") "the caller must never see the raw parameter-binding error - saw: $($_.Exception.Message)"
    }
    Assert-True $threw 'Invoke-AgentDesktop must throw when the child produced no stdout'

    # Normalized to LF because the needles below are written with `n while git
    # checks these files out CRLF on the CI runner - an exact match across that
    # difference passes on a developer box and fails only on the lane.
    $original = ((Get-Command Invoke-AgentDesktop).ScriptBlock.ToString()) -replace "`r`n", "`n"
    $guardLine = "    if ([string]::IsNullOrWhiteSpace(`$result.StdOut)) {`n        throw `"Invoke-AgentDesktop: '`$(`$Arguments -join ' ')' produced no stdout to parse (ExitCode=`$(`$result.ExitCode), TimedOut=`$(`$result.TimedOut), OutputLimited=`$(`$result.OutputLimited)); stderr: `$(`$result.StdErr.Trim())`"`n    }`n"
    Assert-True ($original.Contains($guardLine)) 'the invert target block must actually be present in the real Invoke-AgentDesktop - if this fails, Lib.psm1 drifted from what this test expects'
    $strippedText = $original.Replace($guardLine, '')
    try {
        Set-LibFunctionText -Name 'Invoke-AgentDesktop' -Text $strippedText
        $sawBindError = $false
        try {
            Invoke-AgentDesktop -Arguments @('find', '--first') -TimeoutSeconds 5 | Out-Null
        } catch {
            $sawBindError = ($_.Exception.Message -like '*Cannot bind argument*')
        }
        Assert-True $sawBindError 'INVERT: with the empty-stdout guard removed, the same empty-output call must now surface the opaque ConvertFrom-AgentJson bind failure'
    } finally {
        Set-LibFunctionText -Name 'Invoke-AgentDesktop' -Text $original
    }
}

<#
    2. Assert-Effect fails when the status did not change even though ok
       was true.
#>
Invoke-SelfTest 'Assert-Effect fails when the status never changes though ok is true' {
    $idle = '{"version":"2.3","ok":true,"command":"get","data":{"ref":"@stub-snap:e1","property":"value","value":"idle"}}'
    New-StubConfig -Rules @(
        @{ Match = '*get*'; Responses = @($idle) },
        @{ Match = '*click*'; Responses = @($OkClick) }
    ) | Out-Null
    Assert-Throws {
        Assert-Effect -Target $script:FakeTarget -Property 'value' -Expected 'done' -Action 'click' -TimeoutSeconds 1
    } 'Assert-Effect must throw when the status never reaches Expected, even though the action reported ok=true'
}

<#
    3. Assert-Effect fails when the status already equals the expectation
       before the action ran - the pre-read comparison. Invert-verified by
       stripping the real guard block out of Assert-Effect's own text,
       rebinding it with Set-LibFunctionText, and watching the same call
       succeed.
#>
Invoke-SelfTest 'Assert-Effect fails when the pre-read already equals Expected, and the pre-read guard is what catches it' {
    $done = '{"version":"2.3","ok":true,"command":"get","data":{"ref":"@stub-snap:e1","property":"value","value":"done"}}'
    New-StubConfig -Rules @(
        @{ Match = '*get*'; Responses = @($done) },
        @{ Match = '*click*'; Responses = @($OkClick) }
    ) | Out-Null

    Assert-Throws {
        Assert-Effect -Target $script:FakeTarget -Property 'value' -Expected 'done' -Action 'click' -TimeoutSeconds 1
    } 'Assert-Effect must throw when Property already equals Expected before the action ran'

    $original = ((Get-Command Assert-Effect).ScriptBlock.ToString()) -replace "`r`n", "`n"
    $preReadGuard = @(
        '    if ((-not $AnyChange) -and (& $reached $pre)) {',
        '        throw "Assert-Effect: the status on $($readTarget.RefId) already equals expected ''$describeExpected'' before the action ran; this leg is unfalsifiable"',
        '    }',
        ''
    ) -join "`n"
    Assert-True ($original.Contains($preReadGuard)) 'the invert target block must actually be present in the real Assert-Effect - if this fails, Lib.psm1 drifted from what this test expects'
    $strippedText = $original.Replace($preReadGuard, '')
    try {
        Set-LibFunctionText -Name 'Assert-Effect' -Text $strippedText
        Assert-NotThrows {
            Assert-Effect -Target $script:FakeTarget -Property 'value' -Expected 'done' -Action 'click' -TimeoutSeconds 1
        } 'INVERT: with the real pre-read guard stripped from Assert-Effect, an already-satisfied leg must now silently succeed - proving the guard is what normally catches it'
    } finally {
        Set-LibFunctionText -Name 'Assert-Effect' -Text $original
    }

    Assert-Throws {
        Assert-Effect -Target $script:FakeTarget -Property 'value' -Expected 'done' -Action 'click' -TimeoutSeconds 1
    } 'RESTORE: the real Assert-Effect must throw again once its original text is rebound'
}

<#
    4. Assert-Effect fails when the status changed but the delivered
       mechanism differs from the expected one.
#>
Invoke-SelfTest 'Assert-Effect fails when the mechanism differs from ExpectedMechanism' {
    $idle = '{"version":"2.3","ok":true,"command":"get","data":{"ref":"@stub-snap:e1","property":"value","value":"idle"}}'
    $done = '{"version":"2.3","ok":true,"command":"get","data":{"ref":"@stub-snap:e1","property":"value","value":"done"}}'
    New-StubConfig -Rules @(
        @{ Match = '*get*'; Responses = @($idle, $done) },
        @{ Match = '*click*'; Responses = @($OkClickPhysical) }
    ) | Out-Null
    Assert-Throws {
        Assert-Effect -Target $script:FakeTarget -Property 'value' -Expected 'done' -Action 'click' -ExpectedMechanism 'semantic_api' -TimeoutSeconds 3
    } 'Assert-Effect must throw when the last step delivered via a different mechanism than ExpectedMechanism'
}

<#
    5. Assert-NoEffect fails when the status changes after its first
       sample, not only if it had already changed at the start.
#>
Invoke-SelfTest 'Assert-NoEffect fails on a change observed after the window has started, not only at t=0' {
    $idle = '{"version":"2.3","ok":true,"command":"get","data":{"ref":"@stub-snap:e1","property":"value","value":"idle"}}'
    $changed = '{"version":"2.3","ok":true,"command":"get","data":{"ref":"@stub-snap:e1","property":"value","value":"changed"}}'
    $denied = '{"version":"2.3","ok":false,"command":"right-click","error":{"code":"POLICY_DENIED","message":"headless policy denial","disposition":{"delivery":"not_delivered","retry":"safe"}}}'
    New-StubConfig -Rules @(
        @{ Match = '*get*'; Responses = @($idle, $changed) },
        @{ Match = '*right-click*'; Responses = @($denied) }
    ) | Out-Null
    Assert-Throws {
        Assert-NoEffect -Target $script:FakeTarget -Property 'value' -Action 'right-click' -WindowMs 600
    } 'Assert-NoEffect must throw once a later sample within the window differs from the pre-value, not only an immediate one'
}

<#
    6. Initialize-NoEffectWindow refuses to start when the pinned constant
       is below 1.5x the seeded maximum p99, and starts on a bootstrap-only
       baseline recording that the bootstrap was used. Invert-verified by
       stripping the real threshold check out of Initialize-NoEffectWindow's
       own text, rebinding it with Set-LibFunctionText, and watching the
       refusal case start (the danger the guard exists to prevent).
#>
Invoke-SelfTest 'Initialize-NoEffectWindow refuses a window below 1.5x recorded p99, and the check is what refuses it' {
    $tooLow = New-Baseline -BootstrapP99Ms 2500 -Legs @{ 'click-status' = 10000 }
    Assert-Throws {
        Initialize-NoEffectWindow -BaselinePath $tooLow
    } 'Initialize-NoEffectWindow must throw when the pinned window is below 1.5x the seeded maximum p99'

    $original = ((Get-Command Initialize-NoEffectWindow).ScriptBlock.ToString()) -replace "`r`n", "`n"
    $thresholdCheck = @(
        '    if ($script:NoEffectWindowMs -lt $minRequired) {',
        '        throw "Initialize-NoEffectWindow: pinned window ($($script:NoEffectWindowMs)ms) is below 1.5x the recorded maximum p99 (${minRequired}ms required); refusing to start"',
        '    }',
        ''
    ) -join "`n"
    Assert-True ($original.Contains($thresholdCheck)) 'the invert target block must actually be present in the real Initialize-NoEffectWindow - if this fails, Lib.psm1 drifted from what this test expects'
    $strippedText = $original.Replace($thresholdCheck, '')
    try {
        Set-LibFunctionText -Name 'Initialize-NoEffectWindow' -Text $strippedText
        Assert-NotThrows {
            Initialize-NoEffectWindow -BaselinePath $tooLow
        } 'INVERT: with the real 1.5x threshold check stripped from Initialize-NoEffectWindow, a window that should be refused must now start - proving the check is what normally refuses it'
    } finally {
        Set-LibFunctionText -Name 'Initialize-NoEffectWindow' -Text $original
    }
    Assert-Throws {
        Initialize-NoEffectWindow -BaselinePath $tooLow
    } 'RESTORE: the real check must refuse the same baseline again once its original text is rebound'
}

Invoke-SelfTest 'Initialize-NoEffectWindow starts on a bootstrap-only baseline and records that the bootstrap was used' {
    $bootstrapOnly = New-Baseline -BootstrapP99Ms 100 -Legs @{}
    $info = Initialize-NoEffectWindow -BaselinePath $bootstrapOnly
    Assert-True ($info.BootstrapUsed -eq $true) 'a baseline with an empty Legs table must report BootstrapUsed'
}

<#
    6c. Invoke-AgentDesktopBatch passes --stop-on-error by default and omits
       it with -ContinueOnError. The first stub rule matches only an argv
       carrying the flag (one result entry); the second matches any other
       batch call (two result entries), so the entry count proves which
       argv was sent. INVERT: hard-coding the flag again makes the
       -ContinueOnError call return one entry and this case fail.
#>
Invoke-SelfTest 'Invoke-AgentDesktopBatch sends --stop-on-error by default and omits it with -ContinueOnError' {
    $halted = '{"version":"2.3","ok":true,"command":"batch","data":{"results":[{"ok":true,"data":{"found":true}}]}}'
    $continued = '{"version":"2.3","ok":true,"command":"batch","data":{"results":[{"ok":true,"data":{"found":true}},{"ok":true,"data":{"found":true}}]}}'
    New-StubConfig -Rules @(
        @{ Match = '*batch*--stop-on-error*'; Responses = @($halted) },
        @{ Match = '*batch*'; Responses = @($continued) }
    ) | Out-Null
    $entries = @(@{ Command = 'click'; Args = @{ ref_id = 'x' } })
    $defaultResults = @(Invoke-AgentDesktopBatch -Entries $entries -TimeoutSeconds 5)
    Assert-True ($defaultResults.Count -eq 1) "the default batch call must carry --stop-on-error (got $($defaultResults.Count) result entries)"
    $continueResults = @(Invoke-AgentDesktopBatch -Entries $entries -TimeoutSeconds 5 -ContinueOnError)
    Assert-True ($continueResults.Count -eq 2) "-ContinueOnError must omit --stop-on-error (got $($continueResults.Count) result entries)"
}
