#Requires -Version 5.1

<#
    Harness.psm1 - the Windows equivalent of tests/e2e/harness.sh: a private
    isolated environment, a hashed read-only staged binary, fixture process
    identity, and the one JSON parser this suite ever calls. The
    desktop-exclusivity lease and the two lease-adoption spawn entry points
    live in the sibling DesktopLease.psm1 - split out purely to keep both
    modules under the 400-line cap.
#>

Set-StrictMode -Version 2.0

Import-Module (Join-Path $PSScriptRoot 'Native.psm1') -Force -Global
Import-Module (Join-Path $PSScriptRoot 'BoundedProcess.psm1') -Force -Global
Import-Module (Join-Path $PSScriptRoot 'DesktopLease.psm1') -Force -Global

$script:OwnershipMarkerName = '.agent-desktop-e2e-root'
$script:SuiteRoot = $null
$script:SuiteOwnerPid = $null
$script:AgentJsonSerializer = $null

function Enter-IsolatedEnvironment {
    <#
    .SYNOPSIS
        Stands up a private suite root under the host temp directory,
        stamped with the creating pid, and points HOME at that root - the
        one variable crates/core/src/refs/mod.rs's home_dir() prefers over
        USERPROFILE on every platform, so isolation needs no other identity
        variable touched. USERNAME, COMPUTERNAME, USERPROFILE, LOCALAPPDATA
        and APPDATA are deliberately left at their real values: the capture-
        redaction gate derives every redaction rule and residue check from
        those same five (probes/windows/common.ps1:38-70,148-178), so
        overriding one would silently disarm it (R21; contract-gate rule 7).
    .OUTPUTS
        PSCustomObject: SuiteRoot, OwnerPid.
    #>
    [CmdletBinding()]
    param(
        [string]$Label = 'e2e',
        [int]$TimeoutSeconds = 20,
        [long]$MaxCaptureBytes = 2097152
    )
    $hostTemp = [System.IO.Path]::GetTempPath()
    $root = Join-Path $hostTemp ('agent-desktop-{0}-{1}-{2}' -f $Label, $PID, [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $root $script:OwnershipMarkerName) -Value $PID -Encoding ASCII -NoNewline

    foreach ($sub in @('home', 'tmp', 'bin', 'fixture', 'cargo-target')) {
        New-Item -ItemType Directory -Path (Join-Path $root $sub) -Force | Out-Null
    }

    $env:HOME = Join-Path $root 'home'
    $env:TEMP = Join-Path $root 'tmp'
    $env:TMP = Join-Path $root 'tmp'
    $env:CARGO_TARGET_DIR = Join-Path $root 'cargo-target'
    $env:AGENT_DESKTOP_E2E_TIMEOUT_SECONDS = [string]$TimeoutSeconds
    $env:AGENT_DESKTOP_E2E_MAX_CAPTURE_BYTES = [string]$MaxCaptureBytes
    Remove-Item Env:\AGENT_DESKTOP_SESSION -ErrorAction SilentlyContinue

    $script:SuiteRoot = $root
    $script:SuiteOwnerPid = $PID
    return [pscustomobject]@{ SuiteRoot = $root; OwnerPid = $PID }
}

function Exit-IsolatedEnvironment {
    <#
    .SYNOPSIS
        Removes the suite root through the recoverable-delete primitive,
        refusing a root this process did not create - the same refusal
        tests/e2e/harness.sh's cleanup_isolated_environment makes by
        comparing the ownership marker's pid.
    #>
    [CmdletBinding()]
    param()
    if (-not $script:SuiteRoot -or -not (Test-Path -LiteralPath $script:SuiteRoot)) { return }
    $markerPath = Join-Path $script:SuiteRoot $script:OwnershipMarkerName
    $owner = $null
    if (Test-Path -LiteralPath $markerPath) {
        $owner = (Get-Content -LiteralPath $markerPath -Raw).Trim()
    }
    if ($owner -ne [string]$script:SuiteOwnerPid) {
        Write-Warning "refusing to remove an E2E suite root this process does not own: $script:SuiteRoot"
        return
    }
    Remove-ItemRecoverable -Path $script:SuiteRoot
    $script:SuiteRoot = $null
    $script:SuiteOwnerPid = $null
}

function Remove-ItemRecoverable {
    <#
    .SYNOPSIS
        Sends Path to the recycle bin; retains it with a warning when no
        recycle backend is available rather than losing it, and never calls
        Remove-Item on a harness artifact directly (R11).
    .OUTPUTS
        $true when the artifact was removed, $false when it was retained.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    Add-Type -AssemblyName Microsoft.VisualBasic
    try {
        if ((Get-Item -LiteralPath $Path -Force).PSIsContainer) {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
                $Path,
                [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
                [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
                [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
        } else {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
                $Path,
                [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
                [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,
                [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
        }
    } catch {
        Write-Warning "recoverable cleanup unavailable; retained artifact: $Path ($($_.Exception.Message))"
        return $false
    }
    if (Test-Path -LiteralPath $Path) {
        Write-Warning "recoverable cleanup did not move artifact; retained: $Path"
        return $false
    }
    return $true
}

function Copy-ImmutableArtifact {
    <#
    .SYNOPSIS
        Hashes Source, copies it to Destination, re-hashes both, refuses on
        any mismatch, then denies write-class rights to the copying
        identity on the destination - NTFS's answer to `chmod 500`. Delete
        is deliberately not denied: denying it to ourselves would make
        Remove-ItemRecoverable fail on every run and turn the retain-and-
        warn branch into the normal path instead of the exceptional one.
    .OUTPUTS
        PSCustomObject: Path, Sha256.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Copy-ImmutableArtifact: source binary missing at $Source"
    }
    $before = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
    $after = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
    $copied = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash
    if ($before -ne $after -or $before -ne $copied) {
        throw 'Copy-ImmutableArtifact: artifact changed while it was copied; refusing a contaminated run'
    }
    Set-ArtifactReadOnly -Path $Destination
    return [pscustomobject]@{ Path = $Destination; Sha256 = $copied }
}

function Set-ArtifactReadOnly {
    param([Parameter(Mandatory = $true)][string]$Path)
    $acl = Get-Acl -LiteralPath $Path
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $denyRights = [System.Security.AccessControl.FileSystemRights]'WriteData,AppendData,WriteAttributes,WriteExtendedAttributes'
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, $denyRights, 'Deny')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Test-ImmutableArtifactHash {
    <#
    .SYNOPSIS
        The load-bearing re-verification: every success claim in the suite
        re-hashes the staged binary against the hash recorded at staging
        time before trusting a single result it produced, mirroring
        tests/e2e/harness.sh's verify_immutable_binary.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    return ($actual -eq $ExpectedSha256)
}

function Get-FixtureProcessIdentity {
    <#
    .SYNOPSIS
        (pid, StartTime), never pid alone - Windows pids recycle, the same
        hazard tests/e2e/safe-semantic.sh's lstart generation token guards
        against on macOS.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc) { return $null }
    return [pscustomobject]@{ ProcessId = $proc.Id; StartTime = $proc.StartTime }
}

function Test-FixtureProcessIdentity {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Identity)
    $current = Get-FixtureProcessIdentity -ProcessId $Identity.ProcessId
    if (-not $current) { return $false }
    return ($current.StartTime -eq $Identity.StartTime)
}

function Get-AgentJsonSerializer {
    <#
    .SYNOPSIS
        Script-scoped lazy singleton backing ConvertFrom-AgentJson:
        Add-Type and the JavaScriptSerializer construction happen once per
        module instance, not once per JSON document. RecursionLimit and
        MaxJsonLength are applied only while building that one instance -
        every call site in this suite passes ConvertFrom-AgentJson's own
        fixed defaults, so there is nothing that needs re-applying on a
        later call.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][int]$RecursionLimit,
        [Parameter(Mandatory = $true)][int]$MaxJsonLength
    )
    if ($null -eq $script:AgentJsonSerializer) {
        Add-Type -AssemblyName System.Web.Extensions
        $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
        $serializer.RecursionLimit = $RecursionLimit
        $serializer.MaxJsonLength = $MaxJsonLength
        $script:AgentJsonSerializer = $serializer
    }
    return $script:AgentJsonSerializer
}

function ConvertFrom-AgentJson {
    <#
    .SYNOPSIS
        The one JSON parser this harness ever calls, built on
        System.Web.Script.Serialization.JavaScriptSerializer with
        RecursionLimit and MaxJsonLength raised past its 100/2,097,152
        defaults. ConvertFrom-Json is never called anywhere else in the
        non-selftest harness (enforced by rule 11 of
        scripts/check-e2e-windows-contract.ps1) because it measures a
        RecursionLimit of 101 nesting levels on this host - a 102-deep
        document throws - and a snapshot contributes two nesting levels per
        UI level on top of the envelope, which a content-staged web tree
        exceeds by design.
    .OUTPUTS
        Dictionary<string,object> / Object[] - never PSCustomObject. Every
        accessor in this suite is written against that shape.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, ValueFromPipeline = $true)][string]$Json,
        [int]$RecursionLimit = 4096,
        [int]$MaxJsonLength = 67108864
    )
    $serializer = Get-AgentJsonSerializer -RecursionLimit $RecursionLimit -MaxJsonLength $MaxJsonLength
    return $serializer.DeserializeObject($Json)
}

Export-ModuleMember -Function @(
    'Enter-IsolatedEnvironment',
    'Exit-IsolatedEnvironment',
    'Remove-ItemRecoverable',
    'Copy-ImmutableArtifact',
    'Test-ImmutableArtifactHash',
    'Get-FixtureProcessIdentity',
    'Test-FixtureProcessIdentity',
    'ConvertFrom-AgentJson'
)
