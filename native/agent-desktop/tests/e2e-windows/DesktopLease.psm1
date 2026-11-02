#Requires -Version 5.1

<#
    DesktopLease.psm1 - the top half of tests/e2e/interaction_lock.py: the
    desktop-exclusivity lease this platform has never had, and the two
    lease-adoption spawn entry points every later scenario unit calls
    through rather than invoking agent-desktop.exe directly. Split out of
    Harness.psm1 purely to keep both modules under the 400-line cap.
#>

Set-StrictMode -Version 2.0

Import-Module (Join-Path $PSScriptRoot 'Native.psm1') -Force -Global
Import-Module (Join-Path $PSScriptRoot 'BoundedProcess.psm1') -Force -Global

$script:LockFileName = 'interaction.lock'
$script:DesktopLeaseHandoffEnvName = 'AGENT_DESKTOP_E2E_DESKTOP_LEASE_HANDLE'
$script:DesktopLeaseHandle = $null
$script:DesktopLeaseAdopted = $null

function Get-CanonicalDesktopLockPath {
    <#
    .SYNOPSIS
        Resolves the canonical lock path the same way
        crates/windows/src/system/interaction_lease's canonical_lock_path()
        does: GetSystemWindowsDirectoryW's drive, then
        ProgramData\agent-desktop\<token user SID>\interaction.lock, with
        the SID read through GetTokenInformation(TokenUser) - never from
        %LOCALAPPDATA%, %TEMP%, %TMP% or %HOME%, all of which this harness's
        own isolated environment has already redirected.
    #>
    [CmdletBinding()]
    param()
    $windowsDirectory = Get-NativeSystemWindowsDirectory
    $separatorIndex = $windowsDirectory.IndexOf('\')
    if ($separatorIndex -lt 0) {
        throw 'Get-CanonicalDesktopLockPath: the system Windows directory has no root separator'
    }
    $driveRoot = $windowsDirectory.Substring(0, $separatorIndex + 1)
    $programData = Join-Path $driveRoot 'ProgramData'
    $sid = Get-NativeProcessTokenUserSid
    return Join-Path (Join-Path (Join-Path $programData 'agent-desktop') $sid) $script:LockFileName
}

function New-PrivateLeaseDirectory {
    <#
    .SYNOPSIS
        Creates the lock file's immediate parent directory - the per-SID
        leaf, never the shared `agent-desktop` root above it - with a
        protected three-principal DACL (SYSTEM, BUILTIN\Administrators, the
        token user) on first creation only, mirroring
        crates/windows/src/system/interaction_lease/directory.rs's
        ensure_private closely enough that the product's own directory
        validation (R16b/R16c) accepts a directory this harness created
        first. An already-existing directory is left exactly as it is -
        the product validates it for real on its own next acquisition, and
        this harness does not repair or re-author what it did not create.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$LeafDirectory)
    $rootDirectory = Split-Path -Parent $LeafDirectory
    New-Item -ItemType Directory -Path $rootDirectory -Force | Out-Null
    if (Test-Path -LiteralPath $LeafDirectory) { return }

    New-Item -ItemType Directory -Path $LeafDirectory -Force | Out-Null
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetAccessRuleProtection($true, $false)
    $principals = @(
        (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')),
        (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')),
        ([System.Security.Principal.WindowsIdentity]::GetCurrent().User)
    )
    foreach ($sid in $principals) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
        $security.AddAccessRule($rule) | Out-Null
    }
    [System.IO.Directory]::SetAccessControl($LeafDirectory, $security)
}

function Enter-DesktopLease {
    <#
    .SYNOPSIS
        R15b's harness-side half of the handoff protocol. Exactly one
        acquisition per entry path: adopts the inherited handle named by
        AGENT_DESKTOP_E2E_DESKTOP_LEASE_HANDLE when it is set (the CI entry
        path, where scripts/run-windows-e2e-ci.ps1 already opened it before
        the build), or opens the canonical path itself with a share mode of
        zero when the variable is absent (a developer invoking Run-E2E.ps1
        directly). Re-opening in the CI path is not a design choice, it is
        a deadlock: a second dwShareMode = 0 open of a path already held by
        this same process fails with ERROR_SHARING_VIOLATION even though it
        is the same process holding it.
    .OUTPUTS
        PSCustomObject: Handle, Path, Adopted, ContentionCount.
    #>
    [CmdletBinding()]
    param([int]$TimeoutSeconds = 30)

    if ($null -ne $script:DesktopLeaseHandle) {
        throw 'Enter-DesktopLease: a desktop lease is already held by this process'
    }

    $lockPath = Get-CanonicalDesktopLockPath
    New-PrivateLeaseDirectory -LeafDirectory (Split-Path -Parent $lockPath)

    $handoff = Get-Item -Path "Env:$script:DesktopLeaseHandoffEnvName" -ErrorAction SilentlyContinue

    if ($handoff -and $handoff.Value) {
        $result = Enter-DesktopLeaseByAdoption -LockPath $lockPath -HandoffValue $handoff.Value
    } else {
        $result = Enter-DesktopLeaseByAcquisition -LockPath $lockPath -TimeoutSeconds $TimeoutSeconds
    }

    $script:DesktopLeaseHandle = $result.Handle
    $script:DesktopLeaseAdopted = $result.Adopted
    return $result
}

function Enter-DesktopLeaseByAdoption {
    param(
        [Parameter(Mandatory = $true)][string]$LockPath,
        [Parameter(Mandatory = $true)][string]$HandoffValue
    )
    $handleValue = [long]$HandoffValue
    $handle = [IntPtr]$handleValue

    if ((Get-NativeFileType -Handle $handle) -ne 1) {
        throw 'Enter-DesktopLease: inherited desktop lease handle is not a disk file (POLICY_DENIED)'
    }
    $inheritedIdentity = Get-NativeFileIdentity -Handle $handle
    if (-not $inheritedIdentity) {
        throw 'Enter-DesktopLease: could not read the inherited desktop lease handle identity (POLICY_DENIED)'
    }

    $readOnly = Open-NativeFile -Path $LockPath -DesiredAccess 0x80 -ShareMode 7 -CreationDisposition 3
    if (-not $readOnly.Success) {
        throw "Enter-DesktopLease: could not open the canonical lock path for identity comparison (POLICY_DENIED): Win32 error $($readOnly.Win32Error)"
    }
    try {
        $canonicalIdentity = Get-NativeFileIdentity -Handle $readOnly.Handle
    } finally {
        Close-NativeHandle -Handle $readOnly.Handle
    }
    if (-not $canonicalIdentity -or
        $inheritedIdentity.VolumeSerial -ne $canonicalIdentity.VolumeSerial -or
        $inheritedIdentity.FileIndexHigh -ne $canonicalIdentity.FileIndexHigh -or
        $inheritedIdentity.FileIndexLow -ne $canonicalIdentity.FileIndexLow) {
        throw 'Enter-DesktopLease: inherited desktop lease does not identify the canonical lock file (POLICY_DENIED)'
    }

    $genericRead = [uint32]2147483648
    $probe = Open-NativeFile -Path $LockPath -DesiredAccess $genericRead -ShareMode 7 -CreationDisposition 3
    if ($probe.Success) {
        Close-NativeHandle -Handle $probe.Handle
        throw 'Enter-DesktopLease: inherited desktop lease is not held exclusively (POLICY_DENIED lease_not_exclusive)'
    }
    if ($probe.Win32Error -ne 32) {
        throw "Enter-DesktopLease: exclusivity probe failed unexpectedly: Win32 error $($probe.Win32Error)"
    }

    Remove-Item -Path "Env:$script:DesktopLeaseHandoffEnvName" -ErrorAction SilentlyContinue
    return [pscustomobject]@{ Handle = $handle; Path = $LockPath; Adopted = $true; ContentionCount = 0 }
}

function Enter-DesktopLeaseByAcquisition {
    param(
        [Parameter(Mandatory = $true)][string]$LockPath,
        [Parameter(Mandatory = $true)][int]$TimeoutSeconds
    )
    $genericRead = [uint32]2147483648
    $genericWrite = [uint32]1073741824
    $deadline = [System.Diagnostics.Stopwatch]::StartNew()
    $contention = 0
    while ($true) {
        $open = Open-NativeFile -Path $LockPath -DesiredAccess ($genericRead -bor $genericWrite) -ShareMode 0 -CreationDisposition 4
        if ($open.Success) {
            return [pscustomobject]@{ Handle = $open.Handle; Path = $LockPath; Adopted = $false; ContentionCount = $contention }
        }
        if ($open.Win32Error -ne 32) {
            throw "Enter-DesktopLease: CreateFileW failed acquiring the desktop lease: Win32 error $($open.Win32Error)"
        }
        $contention++
        if ($deadline.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
            throw "Enter-DesktopLease: TIMEOUT acquiring the desktop lease after $contention contention rounds"
        }
        Start-Sleep -Milliseconds 25
    }
}

function Exit-DesktopLease {
    [CmdletBinding()]
    param()
    if ($null -eq $script:DesktopLeaseHandle) { return }
    Close-NativeHandle -Handle $script:DesktopLeaseHandle
    $script:DesktopLeaseHandle = $null
    $script:DesktopLeaseAdopted = $null
}

function Test-DesktopLeaseAdopted {
    [CmdletBinding()]
    param()
    return $script:DesktopLeaseAdopted
}

function Get-DesktopLeaseHandleValue {
    <#
    .SYNOPSIS
        The raw numeric value of the desktop lease handle this process
        currently holds, for a caller that needs to hand it to a spawn
        entry point `Invoke-GuardedAgent` cannot express -
        `Start-StagedIntegrityProcess`'s restricted-token boundary (U11).
        `$null` when no lease is held.
    #>
    [CmdletBinding()]
    param()
    if ($null -eq $script:DesktopLeaseHandle) { return $null }
    return [long]$script:DesktopLeaseHandle
}

function Invoke-Guarded {
    <#
    .SYNOPSIS
        Spawns a non-product child (the fixture, a helper) with no lease
        inheritance - the default-deny opt-in KTD4 requires. Every
        environment variable this call passes strips
        AGENT_DESKTOP_INTERACTION_LEASE_HANDLE even when this process
        happens to have one set, so a fixture launched through this entry
        point cannot hold the desktop lock after the harness releases it.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [int]$TimeoutSeconds,
        [long]$MaxCaptureBytes,
        [string]$WorkingDirectory
    )
    $callArgs = @{ FilePath = $FilePath; ArgumentList = $ArgumentList; WorkingDirectory = $WorkingDirectory }
    if ($PSBoundParameters.ContainsKey('TimeoutSeconds')) { $callArgs.TimeoutSeconds = $TimeoutSeconds }
    if ($PSBoundParameters.ContainsKey('MaxCaptureBytes')) { $callArgs.MaxCaptureBytes = $MaxCaptureBytes }
    return Invoke-BoundedProcess @callArgs
}

function Invoke-GuardedAgent {
    <#
    .SYNOPSIS
        Spawns a staged agent-desktop.exe invocation with the desktop lease
        made inheritable for exactly this one spawn: HANDLE_FLAG_INHERIT is
        set immediately before Start(), AGENT_DESKTOP_INTERACTION_LEASE_HANDLE
        is passed with the held handle's value, and the flag is cleared
        again once the spawn returns - never left inheritable for the
        run's duration (KTD4). Every invocation of the staged binary in
        this suite routes through here, including commands that acquire no
        lease of their own (`version`), because "which commands need a
        lease" is exactly the judgement a scenario author must not have to
        make. Self-test mode (no lease held) skips inheritance entirely and
        still strips the variable, so U7's stub-driven self-tests run with
        no desktop and no staged binary.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [int]$TimeoutSeconds,
        [long]$MaxCaptureBytes,
        [string]$WorkingDirectory
    )
    $callArgs = @{ FilePath = $FilePath; ArgumentList = $ArgumentList; WorkingDirectory = $WorkingDirectory }
    if ($PSBoundParameters.ContainsKey('TimeoutSeconds')) { $callArgs.TimeoutSeconds = $TimeoutSeconds }
    if ($PSBoundParameters.ContainsKey('MaxCaptureBytes')) { $callArgs.MaxCaptureBytes = $MaxCaptureBytes }

    if ($null -eq $script:DesktopLeaseHandle) {
        return Invoke-BoundedProcess @callArgs
    }

    Set-NativeHandleInheritable -Handle $script:DesktopLeaseHandle -Enabled $true
    try {
        $callArgs.InheritLeaseHandle = [long]$script:DesktopLeaseHandle
        return Invoke-BoundedProcess @callArgs
    } finally {
        Set-NativeHandleInheritable -Handle $script:DesktopLeaseHandle -Enabled $false
    }
}

function Invoke-GuardedDetached {
    <#
    .SYNOPSIS
        The fixture-launch shape Invoke-Guarded cannot express: starts a
        non-product child (the fixture) with no lease inheritance and
        returns immediately rather than waiting for exit, so a long-lived
        GUI process can outlive the spawn call. Stop-GuardedDetached is the
        matching teardown.

        Enforces the one lease policy specific to a detached, long-lived,
        desktop-touching child that Invoke-Guarded's own wait-and-capture
        callers never had to worry about: this harness must hold the
        desktop lease before it hands the interactive desktop to a
        long-lived GUI process, or two runs could touch the same desktop
        at once - the exact contention this module's lease scheme exists
        to prevent. Start-BoundedProcess itself always strips the lease
        env var unconditionally (there is no non-guarded variant of it to
        distinguish this wrapper from), so that half of "guarded" needed
        no restating here; the held-lease precondition is what this
        wrapper actually adds.
    .OUTPUTS
        PSCustomObject: ProcessId, StartTime, JobHandle (Start-BoundedProcess's shape).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [System.Collections.IDictionary]$Environment,
        [string]$WorkingDirectory
    )
    if ($null -eq $script:DesktopLeaseHandle) {
        throw 'Invoke-GuardedDetached: no desktop lease is held by this process; acquire one with Enter-DesktopLease before launching a detached desktop-touching child'
    }
    return Start-BoundedProcess -FilePath $FilePath -ArgumentList $ArgumentList -Environment $Environment -WorkingDirectory $WorkingDirectory
}

function Stop-GuardedDetached {
    <#
    .SYNOPSIS
        Teardown for a handle Invoke-GuardedDetached returned. Carries no
        lease precondition of its own to enforce - stopping an already-
        started child is safe regardless of whether the lease is still
        held, unlike starting one.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Handle)
    Stop-BoundedProcess -Handle $Handle
}

Export-ModuleMember -Function @(
    'Get-CanonicalDesktopLockPath',
    'New-PrivateLeaseDirectory',
    'Enter-DesktopLease',
    'Exit-DesktopLease',
    'Test-DesktopLeaseAdopted',
    'Get-DesktopLeaseHandleValue',
    'Invoke-Guarded',
    'Invoke-GuardedAgent',
    'Invoke-GuardedDetached',
    'Stop-GuardedDetached'
)
