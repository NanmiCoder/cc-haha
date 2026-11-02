#Requires -Version 5.1

<#
    U6SelfTestCasesCore.ps1 - dot-sourced by Invoke-U6SelfTests.ps1. Cases
    1-6: recoverable delete, isolated-environment ownership, bounded-process
    descendant cleanup, lease-handle stripping, inherit-flag clearing, and
    tampered-binary detection. Split out of Invoke-U6SelfTests.ps1 purely to
    keep both files under the 400-line cap; $AgentDesktopBinary and
    $script:E2EWindowsDir are the caller's own scope (dot-sourcing shares
    it), never re-declared here.
#>

<#
    1. Recoverable delete: both branches.
#>
Invoke-SelfTest 'recoverable delete moves an artifact when the backend is available' {
    $path = Join-Path ([System.IO.Path]::GetTempPath()) ('u6-recycle-' + [guid]::NewGuid().ToString('N') + '.txt')
    Set-Content -LiteralPath $path -Value 'scratch'
    $moved = Remove-ItemRecoverable -Path $path
    Assert-True $moved.Equals($true) 'Remove-ItemRecoverable should report success on an unlocked file'
    Assert-True (-not (Test-Path -LiteralPath $path)) 'the artifact should be gone from its original location'
}

Invoke-SelfTest 'recoverable delete retains the artifact with a warning when the backend cannot move it' {
    $path = Join-Path ([System.IO.Path]::GetTempPath()) ('u6-recycle-locked-' + [guid]::NewGuid().ToString('N') + '.txt')
    Set-Content -LiteralPath $path -Value 'scratch'
    $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
    try {
        $retained = Remove-ItemRecoverable -Path $path -WarningAction SilentlyContinue
        Assert-True ($retained.Equals($false)) 'Remove-ItemRecoverable should report failure when the artifact could not be moved'
        Assert-True (Test-Path -LiteralPath $path) 'a retained artifact must still exist - it must never be lost'
    } finally {
        $stream.Close()
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
}

<#
    2. Cleanup refuses a suite root whose ownership marker names another pid.
#>
Invoke-SelfTest 'Exit-IsolatedEnvironment refuses a suite root owned by a different pid' {
    <#
        Enter-IsolatedEnvironment is a process-wide mutation by design (it
        is meant to be called once, near the top of Run-E2E.ps1) - this
        self-test session runs many scenarios in one process, so the
        original HOME/TEMP/TMP are captured and restored regardless of
        outcome, rather than leaving later scenarios (Add-Type in
        particular, which compiles into %TEMP%) pointed at a directory this
        test is about to force-remove.
    #>
    $originalHome = $env:HOME
    $originalTemp = $env:TEMP
    $originalTmp = $env:TMP
    $originalCargoTargetDir = $env:CARGO_TARGET_DIR
    try {
        $env1 = Enter-IsolatedEnvironment -Label 'ownercheck'
        $root = $env1.SuiteRoot
        Set-Content -LiteralPath (Join-Path $root '.agent-desktop-e2e-root') -Value '999999999' -Encoding ASCII -NoNewline
        Exit-IsolatedEnvironment -WarningAction SilentlyContinue
        Assert-True (Test-Path -LiteralPath $root) 'a suite root with a foreign ownership marker must not be removed'
        Set-Content -LiteralPath (Join-Path $root '.agent-desktop-e2e-root') -Value $PID -Encoding ASCII -NoNewline
        $removed = Remove-ItemRecoverable -Path $root
        Assert-True $removed.Equals($true) 'manual cleanup of the test artifact should succeed'
    } finally {
        $env:HOME = $originalHome
        $env:TEMP = $originalTemp
        $env:TMP = $originalTmp
        $env:CARGO_TARGET_DIR = $originalCargoTargetDir
    }
}

<#
    3. A child that spawns a grandchild and exceeds its timeout leaves no
       surviving descendant, asserted by re-querying the grandchild's own
       pid rather than trusting Invoke-BoundedProcess's own report.
#>
Invoke-SelfTest 'a timed-out bounded process leaves no surviving descendant' {
    $marker = Join-Path ([System.IO.Path]::GetTempPath()) ('u6-grandchild-' + [guid]::NewGuid().ToString('N') + '.txt')
    $script = 'Set-Content -LiteralPath ''' + $marker + ''' -Value (Start-Process -FilePath ping.exe -ArgumentList @("-n","30","127.0.0.1") -WindowStyle Hidden -PassThru).Id; Start-Sleep -Seconds 30'
    $result = Invoke-BoundedProcess -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', $script) -TimeoutSeconds 2
    Assert-True $result.TimedOut.Equals($true) 'the outer spawn should have been terminated by its deadline'
    Assert-True ($result.ExitCode -eq 124) 'a timed-out bounded process reports exit code 124'
    Start-Sleep -Milliseconds 500
    Assert-True (Test-Path -LiteralPath $marker) 'the grandchild should have started and recorded its pid before the deadline fired'
    $grandchildPid = [int](Get-Content -LiteralPath $marker)
    $survivor = Get-Process -Id $grandchildPid -ErrorAction SilentlyContinue
    Assert-True ($null -eq $survivor) "grandchild pid $grandchildPid must not survive the job termination - independent re-query, not the terminate call's own success"
    Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
}

<#
    4. Invoke-Guarded does not pass the lease handle: the child sees no
       inherited handoff, and does not hold the lock after the harness
       releases it.
#>
Invoke-SelfTest 'Invoke-Guarded strips the lease handle and the child holds nothing after release' {
    $lease = Enter-DesktopLease -TimeoutSeconds 10
    try {
        $checkScript = 'if ($env:AGENT_DESKTOP_INTERACTION_LEASE_HANDLE) { "present" } else { "absent" }'
        $child = Invoke-Guarded -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', $checkScript) -TimeoutSeconds 10
        Assert-True ($child.StdOut.Trim() -eq 'absent') "Invoke-Guarded must strip AGENT_DESKTOP_INTERACTION_LEASE_HANDLE - saw '$($child.StdOut.Trim())'"
    } finally {
        Exit-DesktopLease
    }
    $probe = Open-NativeFile -Path (Get-CanonicalDesktopLockPath) -DesiredAccess ([uint32]2147483648 -bor [uint32]1073741824) -ShareMode 0 -CreationDisposition 4
    Assert-True $probe.Success 'a fresh exclusive acquisition must succeed once the harness releases its lease - nothing spawned through Invoke-Guarded can be holding it'
    Close-NativeHandle -Handle $probe.Handle
}

<#
    5. Invoke-GuardedAgent clears HANDLE_FLAG_INHERIT after the spawn
       returns, read back through GetHandleInformation rather than trusted
       from the setter.
#>
Invoke-SelfTest 'Invoke-GuardedAgent clears the inherit flag after the spawn returns' {
    $lease = Enter-DesktopLease -TimeoutSeconds 10
    try {
        Assert-True ((Test-NativeHandleInheritable -Handle $lease.Handle) -eq $false) 'the lease handle must start non-inheritable'
        [void](Invoke-GuardedAgent -FilePath 'cmd.exe' -ArgumentList @('/c', 'exit 0') -TimeoutSeconds 10)
        Assert-True ((Test-NativeHandleInheritable -Handle $lease.Handle) -eq $false) 'the inherit flag must be cleared again once the guarded spawn returns'
    } finally {
        Exit-DesktopLease
    }
}

<#
    6. The staged binary's hash mismatching mid-run marks the run
       contaminated. Invert-verified by making Test-ImmutableArtifactHash
       return $true unconditionally and watching this exact test fail.
#>
Invoke-SelfTest 'a tampered staged binary is caught by hash re-verification' {
    $stageDir = New-ScratchDirectory 'stage'
    try {
        $staged = Copy-ImmutableArtifact -Source $AgentDesktopBinary -Destination (Join-Path $stageDir 'agent-desktop.exe')
        Assert-True (Test-ImmutableArtifactHash -Path $staged.Path -ExpectedSha256 $staged.Sha256) 'an untampered staged binary must verify clean'

        $forged = 'not-a-real-hash-0000000000000000000000000000000000000000000000000000'
        Assert-True ((Test-ImmutableArtifactHash -Path $staged.Path -ExpectedSha256 $forged) -eq $false) 'a hash mismatch must be reported, not silently accepted'

        function Test-ImmutableArtifactHashAlwaysTrue { param($Path, $ExpectedSha256) return $true }
        $originalBody = (Get-Command Test-ImmutableArtifactHash).ScriptBlock
        try {
            Set-Item function:Test-ImmutableArtifactHash -Value (Get-Command Test-ImmutableArtifactHashAlwaysTrue).ScriptBlock
            $invertedResult = Test-ImmutableArtifactHash -Path $staged.Path -ExpectedSha256 $forged
            Assert-True ($invertedResult -eq $true) 'INVERT: with the guard replaced by an always-true stub, the same mismatched hash must now be reported as clean - proving the real check is what normally catches it'
        } finally {
            Set-Item function:Test-ImmutableArtifactHash -Value $originalBody
        }
        Assert-True ((Test-ImmutableArtifactHash -Path $staged.Path -ExpectedSha256 $forged) -eq $false) 'RESTORE: the real hash check must reject the forged hash again once the stub is removed'
    } finally {
        Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
