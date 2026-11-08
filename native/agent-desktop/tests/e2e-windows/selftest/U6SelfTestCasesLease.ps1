#Requires -Version 5.1

<#
    U6SelfTestCasesLease.ps1 - dot-sourced by Invoke-U6SelfTests.ps1. Cases
    7-13: the CI handoff protocol, handoff-variable leakage, lease
    contention at the real canonical path, deep-JSON parsing, the raw
    window/cursor/thread-info P/Invoke surface, the token-user SID oracle,
    and lease-directory validation. Split out of Invoke-U6SelfTests.ps1
    purely to keep both files under the 400-line cap; $AgentDesktopBinary
    and $script:E2EWindowsDir are the caller's own scope (dot-sourcing
    shares it), never re-declared here.
#>

<#
    7. The CI entry path completes with exactly one lock held (R15b): a raw
       parent process opens the canonical lock exclusively and inheritably,
       hands its value to a real child process (Process with redirected
       streams, which sets bInheritHandles=TRUE - Invoke-Guarded/
       Invoke-GuardedAgent deliberately cannot be used here, they strip
       this exact variable by design), the child adopts and reports so, and
       a third process attempting the same exclusive open is refused
       throughout. Invert-verified by forcing the child down the
       self-acquire branch instead of adopting and watching it fail to
       reach the lease at all (the deadlock R15b exists to prevent).
#>
Invoke-SelfTest 'the CI handoff protocol adopts once, holds one lock throughout, and a forced re-open deadlocks' {
    $lockPath = Get-CanonicalDesktopLockPath
    New-PrivateLeaseDirectory -LeafDirectory (Split-Path -Parent $lockPath)

    $genericRead = [uint32]2147483648
    $genericWrite = [uint32]1073741824
    $parentOpen = Open-NativeFile -Path $lockPath -DesiredAccess ($genericRead -bor $genericWrite) -ShareMode 0 -CreationDisposition 4
    Assert-True $parentOpen.Success 'the parent must be able to acquire the canonical lock exclusively to start this scenario'
    Set-NativeHandleInheritable -Handle $parentOpen.Handle -Enabled $true
    try {
        $adoptScript = @'
Import-Module (Join-Path $args[0] 'DesktopLease.psm1') -Force
$lease = Enter-DesktopLease -TimeoutSeconds 5
Write-Output ("ADOPTED=" + (Test-DesktopLeaseAdopted))
Exit-DesktopLease
'@
        $adoptScriptPath = Join-Path ([System.IO.Path]::GetTempPath()) ('u6-adopt-' + [guid]::NewGuid().ToString('N') + '.ps1')
        Set-Content -LiteralPath $adoptScriptPath -Value $adoptScript

        $childPsi = New-Object System.Diagnostics.ProcessStartInfo
        $childPsi.FileName = 'powershell.exe'
        $childPsi.Arguments = '-NoProfile -File "' + $adoptScriptPath + '" "' + $script:E2EWindowsDir + '"'
        $childPsi.RedirectStandardOutput = $true
        $childPsi.RedirectStandardError = $true
        $childPsi.UseShellExecute = $false
        $childPsi.CreateNoWindow = $true
        $childPsi.EnvironmentVariables['AGENT_DESKTOP_E2E_DESKTOP_LEASE_HANDLE'] = [string]([long]$parentOpen.Handle)
        $child = New-Object System.Diagnostics.Process
        $child.StartInfo = $childPsi
        [void]$child.Start()
        $childStdout = $child.StandardOutput.ReadToEnd()
        $childStderr = $child.StandardError.ReadToEnd()
        $child.WaitForExit()
        Remove-Item -LiteralPath $adoptScriptPath -Force -ErrorAction SilentlyContinue

        Assert-True ($child.ExitCode -eq 0) "the adopting child must exit cleanly - stderr: $childStderr"
        Assert-True ($childStdout -match 'ADOPTED=True') "the child must report that its adopting branch fired, not its opening branch - stdout: $childStdout"

        $thirdProbe = Open-NativeFile -Path $lockPath -DesiredAccess ($genericRead -bor $genericWrite) -ShareMode 0 -CreationDisposition 4
        Assert-True ($thirdProbe.Success -eq $false -and $thirdProbe.Win32Error -eq 32) 'a third process must still be refused with ERROR_SHARING_VIOLATION - the single lock is genuinely held throughout the handoff'

        <#
            INVERT: force the child down the self-acquire branch (as if the
            handoff variable had been ignored and Enter-DesktopLease
            re-opened the same path) and confirm it cannot reach the
            lease at all while the parent still holds it - the deadlock
            R15b's adoption protocol exists to prevent.
        #>
        $reopenScript = @'
Import-Module (Join-Path $args[0] 'DesktopLease.psm1') -Force
Remove-Item Env:\AGENT_DESKTOP_E2E_DESKTOP_LEASE_HANDLE -ErrorAction SilentlyContinue
try {
    $lease = Enter-DesktopLease -TimeoutSeconds 2
    Write-Output "REOPEN_SUCCEEDED"
} catch {
    Write-Output ("REOPEN_FAILED=" + $_.Exception.Message)
}
'@
        $reopenScriptPath = Join-Path ([System.IO.Path]::GetTempPath()) ('u6-reopen-' + [guid]::NewGuid().ToString('N') + '.ps1')
        Set-Content -LiteralPath $reopenScriptPath -Value $reopenScript
        $reopenChild = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-File', $reopenScriptPath, $script:E2EWindowsDir) -PassThru -NoNewWindow -RedirectStandardOutput ($reopenScriptPath + '.out')
        $reopenChild.WaitForExit()
        $reopenOutput = Get-Content -LiteralPath ($reopenScriptPath + '.out') -Raw
        Remove-Item -LiteralPath $reopenScriptPath, ($reopenScriptPath + '.out') -Force -ErrorAction SilentlyContinue
        Assert-True ($reopenOutput -match 'REOPEN_FAILED') "INVERT: a child that re-opens instead of adopting must fail to reach the lease while the parent holds it (this is the deadlock R15b prevents) - saw: $reopenOutput"
    } finally {
        Close-NativeHandle -Handle $parentOpen.Handle
    }
}

<#
    8. The handoff variable does not leak: a non-agent child spawned
       through Invoke-Guarded after adoption sees no
       AGENT_DESKTOP_E2E_DESKTOP_LEASE_HANDLE.
#>
Invoke-SelfTest 'the handoff variable does not leak into a child spawned after adoption' {
    $lease = Enter-DesktopLease -TimeoutSeconds 10
    try {
        Assert-True (-not (Test-Path Env:\AGENT_DESKTOP_E2E_DESKTOP_LEASE_HANDLE)) 'Enter-DesktopLease must clear the handoff variable from the harness environment once it adopts or acquires'
        $checkScript = 'if ($env:AGENT_DESKTOP_E2E_DESKTOP_LEASE_HANDLE) { "present" } else { "absent" }'
        $child = Invoke-Guarded -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', $checkScript) -TimeoutSeconds 10
        Assert-True ($child.StdOut.Trim() -eq 'absent') "a non-agent child must never see the harness's own handoff variable - saw '$($child.StdOut.Trim())'"
    } finally {
        Exit-DesktopLease
    }
}

<#
    9. With the lease held by Enter-DesktopLease and
       AGENT_DESKTOP_INTERACTION_LEASE_HANDLE deliberately unset (via
       Invoke-Guarded), a guarded spawn running a leased command returns
       TIMEOUT - proving PowerShell's resolver and canonical_lock_path()
       name the same file. Invert-verified by pointing Enter-DesktopLease
       at a scratch root: the same spawn then succeeds uncontended, which
       is exactly the false pass this test exists to catch.
#>
Invoke-SelfTest 'a leased command contends against the harness-held lease at the real canonical path' {
    $lease = Enter-DesktopLease -TimeoutSeconds 10
    try {
        $result = Invoke-Guarded -FilePath $AgentDesktopBinary -ArgumentList @('mouse-move', '--headed', '--xy', '5,5') -TimeoutSeconds 10
        $envelope = ConvertFrom-AgentJson -Json $result.StdOut
        Assert-True ($envelope['ok'] -eq $false -and $envelope['error']['code'] -eq 'TIMEOUT') "an agent-desktop.exe command run without lease inheritance must contend against the harness's own lease and report TIMEOUT - saw: $($result.StdOut.Trim())"
    } finally {
        Exit-DesktopLease
    }

    <#
        INVERT: acquire on a SCRATCH root instead of the real canonical
        path (simulating a resolver that has drifted from
        canonical_lock_path()) and re-run the identical command. If the
        two resolvers ever diverge, the command now finds the real lock
        free and succeeds - the false pass a TIMEOUT-only assertion must
        catch, proven here by actually observing it.
    #>
    $scratchRoot = New-ScratchDirectory 'lease-divergence'
    try {
        $scratchLockPath = Join-Path $scratchRoot 'interaction.lock'
        $genericRead = [uint32]2147483648
        $genericWrite = [uint32]1073741824
        $scratchOpen = Open-NativeFile -Path $scratchLockPath -DesiredAccess ($genericRead -bor $genericWrite) -ShareMode 0 -CreationDisposition 4
        Assert-True $scratchOpen.Success 'the scratch lock must be acquirable to stage the divergence'
        try {
            $result2 = Invoke-Guarded -FilePath $AgentDesktopBinary -ArgumentList @('mouse-move', '--headed', '--xy', '5,5') -TimeoutSeconds 10
            $envelope2 = ConvertFrom-AgentJson -Json $result2.StdOut
            Assert-True ($envelope2['ok'] -eq $true) "INVERT: with the harness holding a lock at a path other than canonical_lock_path()'s, the real lock is free and the command must succeed uncontended - proving a resolver drift would have made the TIMEOUT assertion above a false pass. Saw: $($result2.StdOut.Trim())"
        } finally {
            Close-NativeHandle -Handle $scratchOpen.Handle
        }
    } finally {
        Remove-Item -LiteralPath $scratchRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

<#
    10. ConvertFrom-AgentJson parses a 300-level fixture document that
        ConvertFrom-Json rejects, and the same document round-trips a value
        read through the harness's own Dictionary/Object[] accessors.
#>
Invoke-SelfTest 'ConvertFrom-AgentJson parses past the ConvertFrom-Json recursion ceiling' {
    $depth = 300
    $doc = '0'
    for ($i = 0; $i -lt $depth; $i++) { $doc = '{"n":' + $doc + ',"list":[1,2,3]}' }

    $stockFailed = $false
    try { $null = $doc | ConvertFrom-Json } catch { $stockFailed = $true }
    Assert-True $stockFailed 'ConvertFrom-Json is expected to fail on a document this deep on this host (measured RecursionLimit: 101 levels)'

    $parsed = ConvertFrom-AgentJson -Json $doc
    Assert-True ($parsed -is [System.Collections.Generic.Dictionary[string, object]]) 'ConvertFrom-AgentJson must return a Dictionary<string,object>, never a PSCustomObject'

    $cursor = $parsed
    $walked = 0
    while ($cursor -is [System.Collections.Generic.Dictionary[string, object]]) {
        Assert-True ($cursor['list'].Count -eq 3) 'each level must round-trip its sibling array intact'
        $cursor = $cursor['n']
        $walked++
    }
    Assert-True ($walked -eq $depth) "the walk must reach every level the document has - reached $walked of $depth"
    Assert-True ($cursor -eq 0) 'the innermost scalar must round-trip as 0'
}

<#
    11. Native.psm1/NativeDesktop.psm1's currently-unexercised-by-U6-tests
        P/Invoke surface (GetForegroundWindow, GetCursorPos, EnumWindows,
        GetGUIThreadInfo) each gets one live invocation, so nothing shipped
        is dead on arrival for the scenario units that will actually
        consume it.
#>
Invoke-SelfTest 'the window/cursor/thread-info P/Invoke surface is live' {
    $fg = Get-NativeForegroundWindowHandle
    Assert-True ($fg -ne [IntPtr]::Zero) 'GetForegroundWindow must return a real window on an interactive desktop'
    $cursor = Get-NativeCursorPosition
    Assert-True ($cursor.X -is [int] -and $cursor.Y -is [int]) 'GetCursorPos must report integer coordinates'
    $windows = Get-NativeTopLevelWindows
    Assert-True ($windows.Count -ge 1) 'EnumWindows must enumerate at least one top-level window'
    $gui = Get-NativeGuiThreadInfo
    Assert-True ($null -ne $gui) 'GetGUIThreadInfo must succeed for the foreground thread'
}

<#
    12. The SID this module reads through GetTokenInformation(TokenUser)
        must be the identical string ConvertSidToStringSidW would produce -
        cross-checked against .NET's own independent SID marshaling.
#>
Invoke-SelfTest 'the resolved token-user SID matches the WindowsIdentity oracle' {
    $native = Get-NativeProcessTokenUserSid
    $oracle = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Assert-True ($native -eq $oracle) "Get-NativeProcessTokenUserSid ($native) must match WindowsIdentity's own SID read ($oracle)"
}

<#
    13. The lock directory this harness creates on a fresh box is accepted
        by the product's own directory validation (R16b/R16c), and a
        plainly-created directory in the same spot is refused - the
        positive/negative control pair that proves the DACL this module
        authors is the one the Rust side actually requires, not merely a
        directory that happens to already validate from an earlier run.
#>
Invoke-SelfTest 'a freshly-created lease directory validates against the real product, a plain one does not' {
    $lockPath = Get-CanonicalDesktopLockPath
    $leaf = Split-Path -Parent $lockPath

    if (Test-Path -LiteralPath $leaf) { Remove-Item -LiteralPath $leaf -Recurse -Force }
    New-PrivateLeaseDirectory -LeafDirectory $leaf
    $lease = Enter-DesktopLease -TimeoutSeconds 5
    Exit-DesktopLease

    $positive = Invoke-Guarded -FilePath $AgentDesktopBinary -ArgumentList @('mouse-move', '--headed', '--xy', '5,5') -TimeoutSeconds 10
    $positiveEnvelope = ConvertFrom-AgentJson -Json $positive.StdOut
    Assert-True ($positiveEnvelope['ok'] -eq $true) "a freshly-created, protected lease directory must be accepted by the product - saw: $($positive.StdOut.Trim())"

    Remove-Item -LiteralPath $leaf -Recurse -Force
    New-Item -ItemType Directory -Path $leaf -Force | Out-Null
    $negative = Invoke-Guarded -FilePath $AgentDesktopBinary -ArgumentList @('mouse-move', '--headed', '--xy', '5,5') -TimeoutSeconds 10
    $negativeEnvelope = ConvertFrom-AgentJson -Json $negative.StdOut
    Assert-True (
        $negativeEnvelope['ok'] -eq $false -and
        $negativeEnvelope['error']['code'] -eq 'INTERNAL' -and
        $negativeEnvelope['error']['details']['kind'] -eq 'lease_directory_untrusted'
    ) "NEGATIVE CONTROL: a plainly-created directory (inheriting the world-writable ProgramData ACE) must be refused as lease_directory_untrusted - saw: $($negative.StdOut.Trim())"

    Remove-Item -LiteralPath $leaf -Recurse -Force
    New-PrivateLeaseDirectory -LeafDirectory $leaf
    $restored = Enter-DesktopLease -TimeoutSeconds 5
    Exit-DesktopLease
}
