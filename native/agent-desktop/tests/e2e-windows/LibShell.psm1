#Requires -Version 5.1

<#
    LibShell.psm1 - the shell-surface helpers U15's scenario composes, split
    into their own module rather than added to Lib.psm1 (which is at the
    400-line cap) or LibEnvelope.psm1 (whose reason to exist is envelope
    doors, and which stays the only place envelope fields are read). Three
    concerns, none of which touches a command envelope field:

      - the shell's own accelerators, synthesized harness-side through
        `keybd_event` (the same hardware-level injection family
        ChromiumNative.psm1 uses): there is no CLI close command for a shell
        surface, so closing what a leg opens - and restoring the desktop
        when a leg fails mid-way - is done the way the shell itself does it.

      - the UIA3 COM read the tray-count assertion needs: compiles the U1
        probe's shell-probe.cs (probes/windows/26-shell-surfaces/) with the
        in-box csc.exe exactly as that probe's own lib.ps1 does, and runs
        its trayscan mode - the promoted notification-area toolbar
        identified and its Button children counted straight off the COM
        stack the Rust `uiautomation` crate wraps (KTD3), never through the
        binary, so the count the binary reports is checked against a read
        the binary did not perform.

      - a walk over an already-extracted snapshot tree (the Root the
        LibEnvelope doors return): tree nodes' ref_id/native_id are plain
        tree data, not envelope fields, but the walk lives here so scenario
        files stay declarative.
#>

Set-StrictMode -Version 2.0

<#
    No Import-Module of its own, deliberately: re-importing Harness.psm1
    (or anything above it) with -Force would recreate those modules' script
    scopes and wipe DesktopLease.psm1's held-lease state - after which every
    guarded spawn silently stops inheriting the lease and the product's own
    lock acquisition contends with the harness's until it times out. The
    three functions this module calls at runtime (ConvertFrom-AgentJson,
    Invoke-BoundedProcess) resolve through the session state the importing
    suite already populated globally, exactly the way scenario files and
    LibVerdict.psm1 resolve theirs.
#>

$script:ShellKeybdTypeName = 'AgentDeskShell.Native'
$script:ShellComProbeExe = $null

function Initialize-ShellKeybd {
    <#
    .SYNOPSIS
        Loads the harness-side `keybd_event` P/Invoke once - the same
        Add-Type -MemberDefinition shape ChromiumNative.psm1 uses for
        real synthesized input, never a message posted directly into a
        window's queue.
    #>
    [CmdletBinding()]
    param()
    if ($script:ShellKeybdTypeName -as [type]) { return }
    Add-Type -Namespace AgentDeskShell -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@
}

function Invoke-ShellActionCenterToggle {
    <#
    .SYNOPSIS
        The Win+A chord via `keybd_event` - the accelerator the shell
        listens for to raise AND dismiss the Action Center (the kind
        table's SurfaceDismiss::Toggle for this kind). This is the close
        path legs drive and the restore path falls back to: there is no
        CLI close command, and closing the surface any other way would not
        be closing it the way the shell does.
    #>
    [CmdletBinding()]
    param()
    Initialize-ShellKeybd
    $vkLwin = 0x5B
    $vkA = 0x41
    $keyeventfKeyup = 0x0002
    [AgentDeskShell.Native]::keybd_event($vkLwin, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [AgentDeskShell.Native]::keybd_event($vkA, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [AgentDeskShell.Native]::keybd_event($vkA, 0, $keyeventfKeyup, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [AgentDeskShell.Native]::keybd_event($vkLwin, 0, $keyeventfKeyup, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 500
}

function Initialize-ShellComProbe {
    <#
    .SYNOPSIS
        Compiles the U1 probe's shell-probe.cs with the in-box pre-Roslyn
        csc.exe under /langversion:5 - the same compile, same flags and
        same absolute-path compiler resolution probes/windows/26-shell-
        surfaces/lib.ps1 performs - into a temp dir keyed by this pid, and
        returns the exe path. Rebuilt when the source is newer than the
        exe; the compile output lives outside the suite tree, so the
        400-line and file-set rules never see it.
    #>
    [CmdletBinding()]
    param()
    if ($script:ShellComProbeExe -and (Test-Path -LiteralPath $script:ShellComProbeExe)) { return $script:ShellComProbeExe }
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path -LiteralPath $csc)) {
        throw "Initialize-ShellComProbe: the in-box csc.exe was not found at $csc; the COM read cannot be built"
    }
    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $probeSource = Join-Path $repoRoot 'probes\windows\26-shell-surfaces\shell-probe.cs'
    if (-not (Test-Path -LiteralPath $probeSource)) {
        throw "Initialize-ShellComProbe: the shell-probe source is missing at $probeSource"
    }
    $buildDir = Join-Path ([System.IO.Path]::GetTempPath()) ('agent-desktop-shell26-' + $PID)
    New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
    $exe = Join-Path $buildDir 'shell-probe.exe'
    $needsBuild = -not (Test-Path -LiteralPath $exe)
    if (-not $needsBuild) {
        $needsBuild = ((Get-Item -LiteralPath $probeSource).LastWriteTimeUtc -gt (Get-Item -LiteralPath $exe).LastWriteTimeUtc)
    }
    if ($needsBuild) {
        $compilerOutput = (& $csc /nologo /target:exe /langversion:5 /platform:anycpu ('/out:' + $exe) '/reference:System.dll' $probeSource 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            throw "Initialize-ShellComProbe: csc.exe failed ($LASTEXITCODE): $compilerOutput"
        }
    }
    $script:ShellComProbeExe = $exe
    return $exe
}

function Invoke-ShellComProbe {
    <#
    .SYNOPSIS
        Runs one shell-probe mode as a job-bounded child (Invoke-BoundedProcess:
        killed on deadline, output capped) and parses its one-line JSON
        through ConvertFrom-AgentJson - the one parser this suite uses. The
        probe never inherits the interaction lease (BoundedProcess's
        default-deny), so a COM read holds nothing the legs hold.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string[]]$ProbeArguments,
        [int]$TimeoutSeconds = 120
    )
    $exe = Initialize-ShellComProbe
    $mode = $ProbeArguments[0]
    $result = Invoke-BoundedProcess -FilePath $exe -ArgumentList $ProbeArguments -TimeoutSeconds $TimeoutSeconds
    if ($result.TimedOut) {
        throw "Invoke-ShellComProbe: probe mode '$mode' exceeded ${TimeoutSeconds}s"
    }
    if ($result.OutputLimited) {
        throw "Invoke-ShellComProbe: probe mode '$mode' exceeded the capture byte cap"
    }
    if ($result.ExitCode -ne 0) {
        throw "Invoke-ShellComProbe: probe mode '$mode' exited $($result.ExitCode): $($result.StdErr.Trim())"
    }
    if ([string]::IsNullOrWhiteSpace($result.StdOut)) {
        throw "Invoke-ShellComProbe: probe mode '$mode' produced no stdout to parse"
    }
    return ($result.StdOut.Trim() | ConvertFrom-AgentJson)
}

function Get-ShellTrayToolbarIdentity {
    <#
    .SYNOPSIS
        The promoted notification-area toolbar as the harness's own COM
        read sees it: the ToolbarWindow32 promoted inside TrayNotifyWnd
        (the exact chain the binary's system-tray kind walks) with its
        Button children counted. This is the independent side of the tray
        count assertion - a count read through the binary would not
        qualify, per Assert-Effect's read-act-reread contract (A26-5/A26-6
        measured the promoted toolbar as the tray family's rootable
        window).
    #>
    [CmdletBinding()]
    param()
    $scan = Invoke-ShellComProbe -ProbeArguments @('trayscan')
    $promoted = @($scan['toolbars'] | Where-Object { $_['label'] -eq 'promoted_via_tray_notify_wnd' -and $_['found'] })
    if ($promoted.Count -ne 1) {
        throw "Get-ShellTrayToolbarIdentity: the COM read did not yield exactly one promoted notification-area toolbar (got $($promoted.Count))"
    }
    $toolbar = $promoted[0]
    $buttons = @($toolbar['buttons'] | Where-Object { $_['ct'] -eq 'Button' })
    return [pscustomobject]@{
        Handle      = [long]$toolbar['nativewindowhandle']
        ButtonCount = $buttons.Count
    }
}

function Get-ShellTreeIdentityMarks {
    <#
    .SYNOPSIS
        One bounded walk over a door-extracted snapshot tree Root, reporting
        whether any node carries a ref and whether any node's native_id
        names one of Landmarks. The tree is plain tree data (the Root the
        LibEnvelope doors already extracted), never a command envelope.
        The landmark is what ties the tree to the specific surface rather
        than to whatever window happened to open: the Action Center
        carries MainListView when notifications are present and the
        empty-center landmarks when none are (A26-3), so either names it.
    #>
    [CmdletBinding()]
    param(
        [AllowNull()]$Root,
        [Parameter(Mandatory = $true)][string[]]$Landmarks
    )
    $hasRef = $false
    $landmark = $null
    if ($Root) {
        $pending = New-Object System.Collections.Generic.Stack[object]
        $pending.Push($Root)
        $visits = 0
        while ($pending.Count -gt 0 -and $visits -lt 5000) {
            $visits++
            $node = $pending.Pop()
            if ($node -isnot [System.Collections.IDictionary]) { continue }
            if ($node['ref_id']) { $hasRef = $true }
            if (-not $landmark) {
                $nativeId = $node['native_id']
                if ($nativeId) {
                    $value = [string]$nativeId['value']
                    foreach ($wanted in $Landmarks) {
                        if ($value -eq $wanted) { $landmark = $wanted; break }
                    }
                }
            }
            $children = $node['children']
            if ($children) {
                foreach ($child in @($children)) { $pending.Push($child) }
            }
        }
    }
    return [pscustomobject]@{ HasRef = $hasRef; Landmark = $landmark }
}

Export-ModuleMember -Function @(
    'Initialize-ShellKeybd',
    'Invoke-ShellActionCenterToggle',
    'Get-ShellTrayToolbarIdentity',
    'Get-ShellTreeIdentityMarks'
)
