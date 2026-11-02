#Requires -Version 5.1

<#
    Native.psm1 - file-handle, job-object and token primitives built on
    NativeTypes.psm1's P/Invoke surface. CreateFileW/CloseHandle plus the
    file-identity and exclusivity-probe reads are how Enter-DesktopLease
    (DesktopLease.psm1) mirrors crates/windows/src/system/interaction_lease's
    canonical-path resolution and its adoption protocol without going
    through agent-desktop.exe itself; the job-object primitives are how
    BoundedProcess.psm1 guarantees a spawned tree cannot outlive its
    deadline.

    Every wrapper here returns a plain PSCustomObject or a primitive value,
    never a bare P/Invoke struct, so a caller never touches
    [AgentDesktopE2E.Native] directly. Window/cursor/GUI-thread reads live in
    the sibling NativeDesktop.psm1 - split out purely to keep both modules
    under the 400-line cap without duplicating the Add-Type block, which
    lives once in NativeTypes.psm1.
#>

Set-StrictMode -Version 2.0

Import-Module (Join-Path $PSScriptRoot 'NativeTypes.psm1') -Force -Global

function Open-NativeFile {
    <#
    .SYNOPSIS
        A thin, fully-parameterized CreateFileW wrapper. Every caller states
        access, sharing and disposition explicitly - there is no default
        that could silently grant a shared or non-exclusive open.
    .OUTPUTS
        PSCustomObject: Success, Handle (IntPtr or $null), Win32Error (int).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][uint32]$DesiredAccess,
        [Parameter(Mandatory = $true)][uint32]$ShareMode,
        [Parameter(Mandatory = $true)][uint32]$CreationDisposition,
        [switch]$Inheritable
    )
    Initialize-E2ENative
    $attributes = New-E2ESecurityAttributes -Inheritable:$Inheritable.IsPresent
    $handle = [AgentDesktopE2E.Native]::CreateFileW(
        $Path, $DesiredAccess, $ShareMode, [ref]$attributes, $CreationDisposition, 0x80, [IntPtr]::Zero)
    $win32Error = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $invalid = [IntPtr]::new(-1)
    if ($handle -eq $invalid) {
        return [pscustomobject]@{ Success = $false; Handle = $null; Win32Error = $win32Error }
    }
    return [pscustomobject]@{ Success = $true; Handle = $handle; Win32Error = 0 }
}

function Close-NativeHandle {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][IntPtr]$Handle)
    Initialize-E2ENative
    if ($Handle -eq [IntPtr]::Zero -or $Handle -eq [IntPtr]::new(-1)) { return }
    [void][AgentDesktopE2E.Native]::CloseHandle($Handle)
}

function Get-NativeFileType {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][IntPtr]$Handle)
    Initialize-E2ENative
    return [AgentDesktopE2E.Native]::GetFileType($Handle)
}

function Get-NativeFileIdentity {
    <#
    .SYNOPSIS
        (VolumeSerial, FileIndexHigh, FileIndexLow) - the same identity
        triple crates/windows/src/system/interaction_lease/identity.rs
        compares to prove an inherited handle names the canonical lock.
    .OUTPUTS
        PSCustomObject on success, $null on failure.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][IntPtr]$Handle)
    Initialize-E2ENative
    $info = New-Object AgentDesktopE2E.BY_HANDLE_FILE_INFORMATION
    $ok = [AgentDesktopE2E.Native]::GetFileInformationByHandle($Handle, [ref]$info)
    if (-not $ok) { return $null }
    return [pscustomobject]@{
        VolumeSerial  = $info.dwVolumeSerialNumber
        FileIndexHigh = $info.nFileIndexHigh
        FileIndexLow  = $info.nFileIndexLow
    }
}

function Set-NativeHandleInheritable {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][IntPtr]$Handle,
        [Parameter(Mandatory = $true)][bool]$Enabled
    )
    Initialize-E2ENative
    $flag = if ($Enabled) { 0x1 } else { 0x0 }
    $ok = [AgentDesktopE2E.Native]::SetHandleInformation($Handle, 0x1, $flag)
    if (-not $ok) {
        throw "SetHandleInformation failed: Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
}

function Test-NativeHandleInheritable {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][IntPtr]$Handle)
    Initialize-E2ENative
    $flags = 0
    $ok = [AgentDesktopE2E.Native]::GetHandleInformation($Handle, [ref]$flags)
    if (-not $ok) {
        throw "GetHandleInformation failed: Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    return (($flags -band 0x1) -ne 0)
}

function Get-NativeSystemWindowsDirectory {
    [CmdletBinding()]
    param()
    Initialize-E2ENative
    $buffer = New-Object System.Text.StringBuilder 300
    $written = [AgentDesktopE2E.Native]::GetSystemWindowsDirectoryW($buffer, [uint32]$buffer.Capacity)
    if ($written -eq 0) {
        throw "GetSystemWindowsDirectoryW failed: Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    return $buffer.ToString()
}

function Get-NativeProcessTokenUserSid {
    <#
    .SYNOPSIS
        This process's TokenUser SID in its `S-1-5-...` string form, read
        through OpenProcessToken + GetTokenInformation(TokenUser) +
        ConvertSidToStringSidW - the same three calls
        crates/windows/src/system/interaction_lease/sid.rs makes, so the
        canonical lock path this module resolves names the same file the
        product's own lease resolves.
    #>
    [CmdletBinding()]
    param()
    Initialize-E2ENative
    $tokenHandle = [IntPtr]::Zero
    $tokenQuery = 0x0008
    if (-not [AgentDesktopE2E.Native]::OpenProcessToken([AgentDesktopE2E.Native]::GetCurrentProcess(), $tokenQuery, [ref]$tokenHandle)) {
        throw "OpenProcessToken failed: Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    try {
        $tokenUserClass = 1
        $required = 0
        [void][AgentDesktopE2E.Native]::GetTokenInformation($tokenHandle, $tokenUserClass, [IntPtr]::Zero, 0, [ref]$required)
        if ($required -le 0) {
            throw 'GetTokenInformation(TokenUser) reported no payload size'
        }
        $buffer = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($required)
        try {
            $fetched = [AgentDesktopE2E.Native]::GetTokenInformation($tokenHandle, $tokenUserClass, $buffer, $required, [ref]$required)
            if (-not $fetched) {
                throw "GetTokenInformation(TokenUser) failed: Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
            }
            $sidPtr = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($buffer, 0)
            $stringSidPtr = [IntPtr]::Zero
            if (-not [AgentDesktopE2E.Native]::ConvertSidToStringSidW($sidPtr, [ref]$stringSidPtr)) {
                throw "ConvertSidToStringSidW failed: Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
            }
            try {
                return [System.Runtime.InteropServices.Marshal]::PtrToStringUni($stringSidPtr)
            } finally {
                [void][AgentDesktopE2E.Native]::LocalFree($stringSidPtr)
            }
        } finally {
            [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
        }
    } finally {
        [void][AgentDesktopE2E.Native]::CloseHandle($tokenHandle)
    }
}

function New-NativeJobObject {
    <#
    .SYNOPSIS
        A job object created with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, so
        closing the returned handle - or an explicit Stop-NativeJobObject -
        terminates every process ever assigned to it, including a
        grandchild that process never told the harness about.
    #>
    [CmdletBinding()]
    param()
    Initialize-E2ENative
    $job = [AgentDesktopE2E.Native]::CreateJobObjectW([IntPtr]::Zero, $null)
    if ($job -eq [IntPtr]::Zero) {
        throw "CreateJobObjectW failed: Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    $limits = New-Object AgentDesktopE2E.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    $limits.BasicLimitInformation.LimitFlags = 0x2000
    $size = [System.Runtime.InteropServices.Marshal]::SizeOf([type][AgentDesktopE2E.JOBOBJECT_EXTENDED_LIMIT_INFORMATION])
    $jobObjectExtendedLimitInformation = 9
    $ok = [AgentDesktopE2E.Native]::SetInformationJobObject($job, $jobObjectExtendedLimitInformation, [ref]$limits, [uint32]$size)
    if (-not $ok) {
        $win32Error = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        [void][AgentDesktopE2E.Native]::CloseHandle($job)
        throw "SetInformationJobObject failed: Win32 error $win32Error"
    }
    return $job
}

function Add-NativeProcessToJob {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][IntPtr]$JobHandle,
        [Parameter(Mandatory = $true)][IntPtr]$ProcessHandle
    )
    Initialize-E2ENative
    $ok = [AgentDesktopE2E.Native]::AssignProcessToJobObject($JobHandle, $ProcessHandle)
    if (-not $ok) {
        throw "AssignProcessToJobObject failed: Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
}

function Get-NativeInheritableHandleValues {
    <#
    .SYNOPSIS
        Every handle value in this process currently marked
        HANDLE_FLAG_INHERIT, via NtQueryInformationProcess
        (ProcessHandleInformation). The pre/post-spawn oracle U11's staged
        restricted-token spawn bounds itself against: measured live on this
        box before this function shipped, an ordinary interactive
        PowerShell process already carries over a dozen ambient inheritable
        handles (console/pipe plumbing this module never opened), which is
        exactly the all-or-nothing hazard KTD4 names for bInheritHandles.
    .OUTPUTS
        long[]
    #>
    [CmdletBinding()]
    param()
    Initialize-E2ENative
    return [AgentDesktopE2E.Native]::GetInheritableHandleValues()
}

function Stop-NativeJobObject {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][IntPtr]$JobHandle)
    Initialize-E2ENative
    [void][AgentDesktopE2E.Native]::TerminateJobObject($JobHandle, 1)
}

Export-ModuleMember -Function @(
    'Open-NativeFile',
    'Close-NativeHandle',
    'Get-NativeFileType',
    'Get-NativeFileIdentity',
    'Set-NativeHandleInheritable',
    'Test-NativeHandleInheritable',
    'Get-NativeSystemWindowsDirectory',
    'Get-NativeProcessTokenUserSid',
    'New-NativeJobObject',
    'Add-NativeProcessToJob',
    'Stop-NativeJobObject',
    'Get-NativeInheritableHandleValues'
)
