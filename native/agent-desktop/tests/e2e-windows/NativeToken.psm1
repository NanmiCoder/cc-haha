#Requires -Version 5.1

<#
    NativeToken.psm1 - CreateRestrictedToken + SetTokenInformation
    (TokenIntegrityLevel) + CreateProcessAsUser, the one launcher in this
    tree that can cross a genuine Medium/Low integrity boundary.
    `Invoke-GuardedAgent` (DesktopLease.psm1) is a .NET
    System.Diagnostics.Process wrapper and is structurally incapable of
    running under a caller-built token, so U11's split-integrity legs need a
    second launcher rather than a parameter on the first one. This module
    supplies exactly that second launcher - `Start-StagedIntegrityProcess` -
    replicating `Invoke-GuardedAgent`'s lease-inheritance discipline
    (HANDLE_FLAG_INHERIT set immediately before the spawn, cleared
    immediately after) across the restricted-token boundary, plus the
    bounded-handle-set discipline the raw Win32 path needs that the .NET
    path does not (KTD4's all-or-nothing `bInheritHandles` hazard, mitigated
    there only).

    Every claim this module makes about a staged process's integrity is
    read back from the live process's own token (`OpenProcessToken` against
    the handle `CreateProcessAsUser` itself returned) - never inferred from
    the launcher's own success return, which A24-4's route A measured as
    unreliable on this box (a launcher that reports success while the
    launched process stays High).
#>

Set-StrictMode -Version 2.0

Import-Module (Join-Path $PSScriptRoot 'NativeTypes.psm1') -Force -Global
Import-Module (Join-Path $PSScriptRoot 'Native.psm1') -Force -Global

$script:TokenIntegrityLevelClass = 25
$script:TokenAllAccess = 0xF01FF
$script:DisableMaxPrivilege = 0x1
$script:IntegritySidByLevel = @{ Medium = 'S-1-16-8192'; Low = 'S-1-16-4096' }

function Get-NativeTokenIntegritySid {
    <#
    .SYNOPSIS
        GetTokenInformation(TokenIntegrityLevel) read back from an already-
        open token handle, as its `S-1-16-...` string form. The one read
        every staging judgement in this module goes through - never a
        launcher exit code (A24-4's route A: a launcher that reports success
        while the launched process silently stays High).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][IntPtr]$TokenHandle)
    Initialize-E2ENative
    $required = 0
    [void][AgentDesktopE2E.Native]::GetTokenInformation($TokenHandle, $script:TokenIntegrityLevelClass, [IntPtr]::Zero, 0, [ref]$required)
    if ($required -le 0) {
        throw "Get-NativeTokenIntegritySid: GetTokenInformation(TokenIntegrityLevel) reported no payload size: Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    $buffer = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($required)
    try {
        $ok = [AgentDesktopE2E.Native]::GetTokenInformation($TokenHandle, $script:TokenIntegrityLevelClass, $buffer, $required, [ref]$required)
        if (-not $ok) {
            throw "Get-NativeTokenIntegritySid: GetTokenInformation(TokenIntegrityLevel) failed: Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
        }
        $sidPtr = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($buffer, 0)
        $stringSidPtr = [IntPtr]::Zero
        if (-not [AgentDesktopE2E.Native]::ConvertSidToStringSidW($sidPtr, [ref]$stringSidPtr)) {
            throw "Get-NativeTokenIntegritySid: ConvertSidToStringSidW failed: Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
        }
        try {
            return [System.Runtime.InteropServices.Marshal]::PtrToStringUni($stringSidPtr)
        } finally {
            [void][AgentDesktopE2E.Native]::LocalFree($stringSidPtr)
        }
    } finally {
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
    }
}

function New-RestrictedIntegrityToken {
    <#
    .SYNOPSIS
        `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE)` against this
        process's own token, then `SetTokenInformation(TokenIntegrityLevel)`
        lowers the mandatory label - A24-4's measured route D, the one of
        four routes that staged both Medium and Low, confirmed by token
        read-back rather than by CreateRestrictedToken's own return value.
        Deliberately not `common.ps1`'s `Start-MediumIntegrityProcess`
        (`DuplicateTokenEx`, no privilege stripping) - that helper also
        hardcodes `bInheritHandles = false` into its own `CreateProcessAsUser`
        call, which is precisely the property this module exists to change.
    .OUTPUTS
        IntPtr: the restricted, integrity-labelled token handle. Caller owns
        it and must `Close-NativeHandle` it.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][ValidateSet('Medium', 'Low')][string]$IntegrityLevel)
    Initialize-E2ENative
    $hSelf = [IntPtr]::Zero
    if (-not [AgentDesktopE2E.Native]::OpenProcessToken([AgentDesktopE2E.Native]::GetCurrentProcess(), $script:TokenAllAccess, [ref]$hSelf)) {
        throw "New-RestrictedIntegrityToken: OpenProcessToken(self) failed: Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    try {
        $hRestricted = [IntPtr]::Zero
        $created = [AgentDesktopE2E.Native]::CreateRestrictedToken(
            $hSelf, $script:DisableMaxPrivilege, 0, [IntPtr]::Zero, 0, [IntPtr]::Zero, 0, [IntPtr]::Zero, [ref]$hRestricted)
        if (-not $created) {
            throw "New-RestrictedIntegrityToken: CreateRestrictedToken failed: Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
        }
        $integritySid = $script:IntegritySidByLevel[$IntegrityLevel]
        $pSid = [IntPtr]::Zero
        if (-not [AgentDesktopE2E.Native]::ConvertStringSidToSidW($integritySid, [ref]$pSid)) {
            Close-NativeHandle -Handle $hRestricted
            throw "New-RestrictedIntegrityToken: ConvertStringSidToSidW($integritySid) failed: Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
        }
        try {
            <# A two-level field chain ($label.Label.Sid = ...) mutates a
               PowerShell-side copy of the nested SID_AND_ATTRIBUTES value,
               never the parent TOKEN_MANDATORY_LABEL instance itself -
               measured live while building this module: the whole nested
               struct must be constructed separately and assigned to the
               parent's field in one shot, or SetTokenInformation reads a
               zeroed Sid pointer and fails ERROR_NOACCESS. #>
            $label = New-Object AgentDesktopE2E.SID_AND_ATTRIBUTES
            $label.Sid = $pSid
            $label.Attributes = 0x20
            $mandatoryLabel = New-Object AgentDesktopE2E.TOKEN_MANDATORY_LABEL
            $mandatoryLabel.Label = $label
            $labelSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][AgentDesktopE2E.TOKEN_MANDATORY_LABEL])
            $labelPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($labelSize)
            try {
                [System.Runtime.InteropServices.Marshal]::StructureToPtr($mandatoryLabel, $labelPtr, $false)
                $sidLength = [AgentDesktopE2E.Native]::GetLengthSid($pSid)
                $ok = [AgentDesktopE2E.Native]::SetTokenInformation($hRestricted, $script:TokenIntegrityLevelClass, $labelPtr, $labelSize + $sidLength)
                if (-not $ok) {
                    throw "New-RestrictedIntegrityToken: SetTokenInformation(TokenIntegrityLevel) failed: Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
                }
            } finally {
                [System.Runtime.InteropServices.Marshal]::FreeHGlobal($labelPtr)
            }
        } finally {
            [void][AgentDesktopE2E.Native]::LocalFree($pSid)
        }
        return $hRestricted
    } finally {
        Close-NativeHandle -Handle $hSelf
    }
}

Export-ModuleMember -Function @('Get-NativeTokenIntegritySid', 'New-RestrictedIntegrityToken')
