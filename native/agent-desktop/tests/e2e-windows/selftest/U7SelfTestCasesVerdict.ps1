#Requires -Version 5.1

<#
    U7SelfTestCasesVerdict.ps1 - dot-sourced by Invoke-U7SelfTests.ps1. Cases
    7-14: the skip ledger, the fail/undispositioned/all-skipped verdict
    rules, Assert-Envelope's disposition/details checks, Enter-Stage's lock
    ordering, deep-tree round-tripping and the seeded-failure end-to-end
    exit-code wire. Split out of Invoke-U7SelfTests.ps1 purely to keep every
    file under the 400-line cap; $script:RunE2EPath is the caller's own
    scope (dot-sourcing shares it), never re-declared here.
#>

<#
    7. Add-Skip: an undeclared token fails the run; a declared token does
       not, and its token is printed.
#>
Invoke-SelfTest 'Add-Skip with an undeclared token fails the run; a declared token does not' {
    $allowlist = New-TempPath -Prefix 'u7-allowlist' -Extension '.psd1'
    "@{ 'known-token' = 'a declared reason' }" | Set-Content -LiteralPath $allowlist
    Set-SkipAllowlistPath -Path $allowlist

    Reset-Verdict
    Register-Legs -Names @('leg-pass', 'leg-skip')
    Add-Pass -Leg 'leg-pass'
    Add-Skip -Leg 'leg-skip' -Token 'undeclared-token'
    Assert-True ((Write-Verdict) -eq $false) 'an undeclared skip token must fail Write-Verdict even when another leg passed'

    Reset-Verdict
    Register-Legs -Names @('leg-pass', 'leg-skip')
    Add-Pass -Leg 'leg-pass'
    Add-Skip -Leg 'leg-skip' -Token 'known-token'
    Assert-True ((Write-Verdict) -eq $true) 'a declared skip token must not fail Write-Verdict'
}

<#
    8. Add-Fail on a registered leg fails the run and the failing leg
       appears by name in the verdict output.
#>
Invoke-SelfTest 'Add-Fail fails the run and names the failing leg in the verdict output' {
    Reset-Verdict
    Register-Legs -Names @('leg-pass', 'leg-fail')
    Add-Pass -Leg 'leg-pass'
    Add-Fail -Leg 'leg-fail' -Reason 'boom'
    $records = Write-Verdict 6>&1
    $ok = @($records | Where-Object { $_ -is [bool] })[0]
    $hostText = ($records | Where-Object { $_ -is [System.Management.Automation.InformationRecord] } | ForEach-Object { $_.MessageData.ToString() }) -join "`n"
    Assert-True ($ok -eq $false) 'Write-Verdict must return $false when a registered leg failed'
    Assert-True ($hostText -like '*leg-fail*') 'the failing leg name must appear in the verdict output'
}

<#
    9. A scenario that registers legs and dispositions none of them fails
       the run. Invert-verified by removing the leg-accounting checks and
       watching this scenario pass.
#>
Invoke-SelfTest 'legs registered but never dispositioned fail the run, and the accounting check is what catches it' {
    Reset-Verdict
    Register-Legs -Names @('leg-forgotten')
    Add-Pass -Leg 'leg-elsewhere'
    Assert-True ((Write-Verdict) -eq $false) 'a registered leg with no disposition at all must fail the run even when an unrelated leg passed'

    $originalText = ((Get-Command Write-Verdict).ScriptBlock.ToString()) -replace "`r`n", "`n"
    $noneDispositionedLine = "    if (`$script:RegisteredLegs.Count -gt 0 -and `$script:LegDispositions.Count -eq 0) { `$reasons.Add('legs were registered but none were dispositioned') }"
    $undisposedLine = "    if (`$undisposed.Count -gt 0) { `$reasons.Add(`"registered legs never dispositioned: `$(`$undisposed -join ', ')`") }"
    Assert-True ($originalText.Contains($noneDispositionedLine) -and $originalText.Contains($undisposedLine)) 'the invert target lines must actually be present in the real Write-Verdict - if this fails, Lib.psm1 drifted from what this test expects'
    $strippedText = $originalText.Replace($noneDispositionedLine, '').Replace($undisposedLine, '')
    try {
        Set-LibFunctionText -Name 'Write-Verdict' -Text $strippedText -ModuleName 'LibVerdict'
        Reset-Verdict
        Register-Legs -Names @('leg-forgotten')
        Add-Pass -Leg 'leg-elsewhere'
        Assert-True ((Write-Verdict) -eq $true) 'INVERT: with the leg-accounting checks removed, a run that forgot a registered leg must now wrongly pass'
    } finally {
        Set-LibFunctionText -Name 'Write-Verdict' -Text $originalText -ModuleName 'LibVerdict'
    }
    Reset-Verdict
    Register-Legs -Names @('leg-forgotten')
    Add-Pass -Leg 'leg-elsewhere'
    Assert-True ((Write-Verdict) -eq $false) 'RESTORE: the real Write-Verdict must fail this scenario again once the stripped version is reverted'
}

<#
    10. A run whose every leg skipped on declared tokens still fails,
        because nothing passed. Invert-verified by removing the no-pass
        check and watching this scenario pass.
#>
Invoke-SelfTest 'an all-skipped run fails because nothing passed, and the no-pass check is what catches it' {
    $allowlist = New-TempPath -Prefix 'u7-allowlist2' -Extension '.psd1'
    "@{ 'known-token' = 'a declared reason' }" | Set-Content -LiteralPath $allowlist
    Set-SkipAllowlistPath -Path $allowlist

    Reset-Verdict
    Register-Legs -Names @('leg-a')
    Add-Skip -Leg 'leg-a' -Token 'known-token'
    Assert-True ((Write-Verdict) -eq $false) 'a run where every leg skipped on a declared token must still fail - a whole-run skip is not legal'

    $originalText = ((Get-Command Write-Verdict).ScriptBlock.ToString()) -replace "`r`n", "`n"
    $noPassLine = "    if (`$passed.Count -eq 0) { `$reasons.Add('no leg in the run passed') }"
    Assert-True ($originalText.Contains($noPassLine)) 'the invert target line must actually be present in the real Write-Verdict - if this fails, Lib.psm1 drifted from what this test expects'
    $strippedText = $originalText.Replace($noPassLine, '')
    try {
        Set-LibFunctionText -Name 'Write-Verdict' -Text $strippedText -ModuleName 'LibVerdict'
        Reset-Verdict
        Register-Legs -Names @('leg-a')
        Add-Skip -Leg 'leg-a' -Token 'known-token'
        Assert-True ((Write-Verdict) -eq $true) 'INVERT: with the no-pass check removed, an all-skipped run must now wrongly pass'
    } finally {
        Set-LibFunctionText -Name 'Write-Verdict' -Text $originalText -ModuleName 'LibVerdict'
    }
    Reset-Verdict
    Register-Legs -Names @('leg-a')
    Add-Skip -Leg 'leg-a' -Token 'known-token'
    Assert-True ((Write-Verdict) -eq $false) 'RESTORE: the real Write-Verdict must fail this all-skipped run again once the stripped version is reverted'
}

<#
    11. Assert-Envelope fails when the code matches but disposition.delivery
        differs, and when a named details field is absent - and does not
        fail when every named expectation is actually met.
#>
Invoke-SelfTest 'Assert-Envelope checks disposition and details precisely' {
    $envelope = @{
        ok    = $false
        error = @{
            code        = 'POLICY_DENIED'
            disposition = @{ delivery = 'not_delivered'; retry = 'safe' }
            details     = @{ raw_input_emitted = $false }
        }
    }
    Assert-NotThrows {
        Assert-Envelope -Envelope $envelope -ErrorCode 'POLICY_DENIED' -Delivery 'not_delivered' -Retry 'safe' -Details @{ raw_input_emitted = $false }
    } 'Assert-Envelope must not throw when every named expectation is met'
    Assert-Throws {
        Assert-Envelope -Envelope $envelope -ErrorCode 'POLICY_DENIED' -Delivery 'delivered_verified'
    } 'Assert-Envelope must throw when the code matches but disposition.delivery differs'
    Assert-Throws {
        Assert-Envelope -Envelope $envelope -ErrorCode 'POLICY_DENIED' -Details @{ missing_field = $true }
    } 'Assert-Envelope must throw when a named details field is absent from the envelope'
}

<#
    12. Enter-Stage refuses out-of-order acquisition and accepts the
        declared prefix order.
#>
Invoke-SelfTest 'Enter-Stage refuses MenuStage before DesktopLease and accepts the declared order' {
    Assert-Throws {
        Enter-Stage -Lock 'MenuStage' -Body { }
    } 'Enter-Stage must refuse MenuStage when no lock is currently held'
    Assert-NotThrows {
        Enter-Stage -Lock 'DesktopLease' -Body {
            Enter-Stage -Lock 'ForegroundStage' -Body {
                Enter-Stage -Lock 'MenuStage' -Body { }
            }
        }
    } 'Enter-Stage must accept DesktopLease -> ForegroundStage -> MenuStage in that order'
}

<#
    13. The stub's deeply-nested-tree capability actually round-trips
        through ConvertFrom-AgentJson via the real Find-Target path, so it
        is not shipped dead for the units that will reuse it.
#>
Invoke-SelfTest 'a deeply-nested tree in a stubbed find response round-trips through Find-Target' {
    $depth = 200
    $tree = '{"role":"window","children":[]}'
    for ($i = 0; $i -lt $depth; $i++) { $tree = '{"role":"group","children":[' + $tree + ']}' }
    $deep = '{"version":"2.3","ok":true,"command":"find","data":{"snapshot_id":"deep-snap","match":{"ref_id":"@deep-snap:e9","role":"button","name":"Deep"},"tree":' + $tree + '}}'
    New-StubConfig -Rules @(@{ Match = '*find*'; Responses = @($deep) }) | Out-Null
    $result = Find-Target -App 'Stub' -NativeId 'deep' -TimeoutSeconds 1
    Assert-True ($null -ne $result) 'Find-Target must resolve a match even when the envelope carries a deeply nested tree alongside it'
    Assert-True ($result.RefId -eq '@deep-snap:e9') 'the resolved ref must be the one from data.match, unaffected by the nested tree payload'
}

<#
    14. The seeded-failure entry path: Run-E2E.ps1 -SelfTestSeedFailure
        reaches a non-zero process exit code. Invert-verified by discarding
        Write-Verdict's result at the call site and watching this exact
        test fail.
#>
Invoke-SelfTest 'Run-E2E.ps1 -SelfTestSeedFailure exits non-zero, and the exit-code wire is what carries it' {
    $seeded = Invoke-BoundedProcess -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-File', $script:RunE2EPath, '-SelfTestSeedFailure') -TimeoutSeconds 30
    Assert-True ($seeded.ExitCode -ne 0) "Run-E2E.ps1 -SelfTestSeedFailure must exit non-zero - saw exit code $($seeded.ExitCode), stdout: $($seeded.StdOut.Trim())"

    $originalContent = Get-Content -LiteralPath $script:RunE2EPath -Raw
    $wireLine = '    if ($ok) { $exitCode = 0 } else { $exitCode = 1 }'
    Assert-True ($originalContent.Contains($wireLine)) 'the invert target line must actually be present in the real Run-E2E.ps1 - if this fails, the file drifted from what this test expects'
    $discardWire = $originalContent.Replace($wireLine, '    $exitCode = 0')
    try {
        Set-Content -LiteralPath $script:RunE2EPath -Value $discardWire -NoNewline
        $inverted = Invoke-BoundedProcess -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-File', $script:RunE2EPath, '-SelfTestSeedFailure') -TimeoutSeconds 30
        Assert-True ($inverted.ExitCode -eq 0) 'INVERT: with the verdict result discarded at the call site, the seeded failure must now wrongly exit zero'
    } finally {
        Set-Content -LiteralPath $script:RunE2EPath -Value $originalContent -NoNewline
    }
    $restored = Invoke-BoundedProcess -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-File', $script:RunE2EPath, '-SelfTestSeedFailure') -TimeoutSeconds 30
    Assert-True ($restored.ExitCode -ne 0) 'RESTORE: the real file must exit non-zero again once the discarded wire is reverted'
}
