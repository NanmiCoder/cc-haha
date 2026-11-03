#Requires -Version 5.1

<#
    BoundedProcess.psm1 - the Windows equivalent of tests/e2e/bounded_process.py.

    Every child the harness spawns runs inside a job object created with
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (Native.psm1's New-NativeJobObject),
    so a timeout terminates the whole tree - including a grandchild the
    timed-out process spawned and never told anything about - rather than
    the one process this module started directly. Output is read on
    PowerShell's async OutputDataReceived/ErrorDataReceived handlers because
    Windows `select` has no analog for anonymous pipes, and capture is
    bounded by a byte cap independent of the timeout.

    Lease-handle inheritance is opt-in and explicit (InheritLeaseHandle),
    never implicit: the default spawn strips
    AGENT_DESKTOP_INTERACTION_LEASE_HANDLE from the child's environment even
    when the parent process happens to have it set, mirroring
    bounded_process.py's INTERACTION_LEASE_FD_ENV handling.
#>

Set-StrictMode -Version 2.0

Import-Module (Join-Path $PSScriptRoot 'Native.psm1') -Force -Global

$script:DefaultTimeoutSeconds = 20
$script:DefaultMaxCaptureBytes = 2097152
$script:LeaseHandleEnvName = 'AGENT_DESKTOP_INTERACTION_LEASE_HANDLE'

function Get-InteractionLeaseHandleEnvironmentVariableName {
    <#
    .SYNOPSIS
        The single canonical name of the environment variable a spawn path
        uses to hand an inherited desktop-lease handle value to a child -
        declared once here (the module every other harness spawn path in
        this suite already imports) so DesktopLease.psm1 and
        StagedProcess.psm1 read it from one place instead of each carrying
        their own copy of the literal that could drift out of step.
    .OUTPUTS
        string
    #>
    [CmdletBinding()]
    param()
    return $script:LeaseHandleEnvName
}

function Invoke-BoundedProcess {
    <#
    .SYNOPSIS
        Runs FilePath under a job object with a wall-clock deadline and a
        captured-output byte cap. Never throws on the child's own failure -
        a non-zero exit, a timeout and an output cap are all reported in the
        returned object, exactly as tests/e2e/bounded_process.py reports
        them through BoundedResult rather than an exception.
    .OUTPUTS
        PSCustomObject: Arguments, ExitCode, StdOut, StdErr, TimedOut,
        OutputLimited, TerminationNote, WallMs, CpuMs (CpuMs is $null when
        it could not be read, never a silent 0).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [int]$TimeoutSeconds = $script:DefaultTimeoutSeconds,
        [long]$MaxCaptureBytes = $script:DefaultMaxCaptureBytes,
        [System.Collections.IDictionary]$Environment,
        [string]$WorkingDirectory,
        [Nullable[long]]$InheritLeaseHandle
    )

    if ($TimeoutSeconds -le 0 -or $MaxCaptureBytes -le 0) {
        throw 'Invoke-BoundedProcess: timeout and capture limits must be positive'
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = ConvertTo-Win32CommandLine -Tokens $ArgumentList
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }

    $psi.EnvironmentVariables.Clear()
    $sourceEnvironment = if ($Environment) { $Environment } else { Get-CurrentProcessEnvironment }
    foreach ($key in $sourceEnvironment.Keys) {
        $psi.EnvironmentVariables[$key] = [string]$sourceEnvironment[$key]
    }
    if ($PSBoundParameters.ContainsKey('InheritLeaseHandle') -and $null -ne $InheritLeaseHandle) {
        $psi.EnvironmentVariables[$script:LeaseHandleEnvName] = [string]$InheritLeaseHandle
    } else {
        $psi.EnvironmentVariables.Remove($script:LeaseHandleEnvName)
    }

    <#
        StdOutDone/StdErrDone are the synchronization primitive this loop is
        missing without them: .NET signals HasExited/WaitForExit off the
        process's own exit, independently of whether PowerShell's own event
        queue has yet dequeued and run the corresponding OutputDataReceived
        Data=$null (end-of-stream) action. Measured while building this
        module: reading $state immediately after WaitForExit() returns
        loses output that arrives a beat later on the queue - a fixed sleep
        would paper over it by timing rather than by proof, so this waits
        on the actual end-of-stream signal instead.
    #>
    $state = [hashtable]::Synchronized(@{
        StdOut          = New-Object System.Text.StringBuilder
        StdErr          = New-Object System.Text.StringBuilder
        CapturedBytes   = 0L
        MaxCaptureBytes = [long]$MaxCaptureBytes
        OutputLimited   = $false
        StdOutDone      = New-Object System.Threading.ManualResetEventSlim($false)
        StdErrDone      = New-Object System.Threading.ManualResetEventSlim($false)
    })

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi

    $outSubscription = Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -MessageData $state -Action {
        $line = $EventArgs.Data
        $shared = $Event.MessageData
        if ($null -eq $line) { $shared.StdOutDone.Set(); return }
        $lineBytes = [long]([System.Text.Encoding]::UTF8.GetByteCount($line) + 1)
        if ($shared.OutputLimited) { return }
        if (($shared.CapturedBytes + $lineBytes) -gt $shared.MaxCaptureBytes) {
            $shared.OutputLimited = $true
            return
        }
        [void]$shared.StdOut.AppendLine($line)
        $shared.CapturedBytes += $lineBytes
    }
    $errSubscription = Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived -MessageData $state -Action {
        $line = $EventArgs.Data
        $shared = $Event.MessageData
        if ($null -eq $line) { $shared.StdErrDone.Set(); return }
        $lineBytes = [long]([System.Text.Encoding]::UTF8.GetByteCount($line) + 1)
        if ($shared.OutputLimited) { return }
        if (($shared.CapturedBytes + $lineBytes) -gt $shared.MaxCaptureBytes) {
            $shared.OutputLimited = $true
            return
        }
        [void]$shared.StdErr.AppendLine($line)
        $shared.CapturedBytes += $lineBytes
    }

    $job = New-NativeJobObject
    $terminationNote = $null
    $wallStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $cpuMs = $null
    try {
        [void]$process.Start()
        try {
            Add-NativeProcessToJob -JobHandle $job -ProcessHandle $process.Handle
        } catch {
            <#
                The job object was the only thing bounding this child - with
                assignment failed, a later timeout's Stop-NativeJobObject
                would terminate a job with nothing in it, leaving the child
                to run unbounded. Kill it immediately rather than relying on
                a bound that was never established.
            #>
            $terminationNote = "could not assign the child to its bounding job object: $($_.Exception.Message)"
            try { $process.Kill() } catch { }
        }
        $process.BeginOutputReadLine()
        $process.BeginErrorReadLine()

        <#
            A single blocking WaitForExit(timeout) cannot also react to the
            byte cap tripping mid-stream, so both conditions are polled
            here - the byte cap terminates the job exactly as promptly as
            the deadline does, rather than waiting out the full timeout
            once the cap is already exceeded.
        #>
        $elapsed = [System.Diagnostics.Stopwatch]::StartNew()
        $timedOut = $false
        while (-not $process.HasExited) {
            if ($state.OutputLimited) { break }
            if ($elapsed.Elapsed.TotalSeconds -ge $TimeoutSeconds) { $timedOut = $true; break }
            Start-Sleep -Milliseconds 25
        }
        if ($timedOut -or $state.OutputLimited) {
            Stop-NativeJobObject -JobHandle $job
            $reaped = $process.WaitForExit(5000)
            if (-not $reaped) {
                $terminationNote = Merge-TerminationNote -Current $terminationNote -Additional 'child did not exit within the post-terminate grace window'
            }
        } else {
            try { $process.WaitForExit() } catch { }
        }

        <#
            A raw .NET blocking wait (ManualResetEventSlim.Wait) does not
            yield back to the single-threaded Windows PowerShell 5.1 engine
            that still has to dequeue and run the queued OutputDataReceived
            action - measured while building this module, that blocked the
            drain outright. Start-Sleep does yield (it is what let the
            in-stream lines above drain during the exit-wait loop too), so
            the wait for end-of-stream is expressed the same way: polled
            against the real IsSet signal, never a bare fixed sleep.
        #>
        $drainDeadline = [System.Diagnostics.Stopwatch]::StartNew()
        while (-not ($state.StdOutDone.IsSet -and $state.StdErrDone.IsSet)) {
            if ($drainDeadline.Elapsed.TotalMilliseconds -ge 5000) { break }
            Start-Sleep -Milliseconds 10
        }
        if (-not $state.StdOutDone.IsSet) {
            $terminationNote = Merge-TerminationNote -Current $terminationNote -Additional 'stdout end-of-stream was not observed within the grace window'
        }
        if (-not $state.StdErrDone.IsSet) {
            $terminationNote = Merge-TerminationNote -Current $terminationNote -Additional 'stderr end-of-stream was not observed within the grace window'
        }

        try { $cpuMs = $process.TotalProcessorTime.TotalMilliseconds } catch {
            $terminationNote = Merge-TerminationNote -Current $terminationNote -Additional 'CPU time unavailable: GetProcessTimes could not be read'
        }

        $exitCode = if ($timedOut) { 124 } elseif ($state.OutputLimited) { 125 } else {
            try { $process.ExitCode } catch { 126 }
        }

        return [pscustomobject]@{
            Arguments       = @($FilePath) + $ArgumentList
            ExitCode        = $exitCode
            StdOut          = $state.StdOut.ToString()
            StdErr          = $state.StdErr.ToString()
            TimedOut        = [bool]$timedOut
            OutputLimited   = [bool]$state.OutputLimited
            TerminationNote = $terminationNote
            WallMs          = $wallStopwatch.Elapsed.TotalMilliseconds
            CpuMs           = $cpuMs
        }
    } finally {
        Unregister-Event -SourceIdentifier $outSubscription.Name -ErrorAction SilentlyContinue
        Unregister-Event -SourceIdentifier $errSubscription.Name -ErrorAction SilentlyContinue
        Remove-Job -Id $outSubscription.Id -Force -ErrorAction SilentlyContinue
        Remove-Job -Id $errSubscription.Id -Force -ErrorAction SilentlyContinue
        Close-NativeHandle -Handle $job
        $state.StdOutDone.Dispose()
        $state.StdErrDone.Dispose()
        $process.Dispose()
    }
}

function Start-BoundedProcess {
    <#
    .SYNOPSIS
        Starts FilePath under a job object (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
        and returns immediately - the long-lived-GUI-process shape
        Invoke-BoundedProcess's wait-and-capture contract cannot express, and
        the one the fixture launch actually needs. Never inherits the
        interaction lease, mirroring Invoke-Guarded's default deny.
    .OUTPUTS
        PSCustomObject: ProcessId, StartTime, JobHandle.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [System.Collections.IDictionary]$Environment,
        [string]$WorkingDirectory
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = ConvertTo-Win32CommandLine -Tokens $ArgumentList
    $psi.UseShellExecute = $false
    if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
    $psi.EnvironmentVariables.Clear()
    $sourceEnvironment = if ($Environment) { $Environment } else { Get-CurrentProcessEnvironment }
    foreach ($key in $sourceEnvironment.Keys) { $psi.EnvironmentVariables[$key] = [string]$sourceEnvironment[$key] }
    $psi.EnvironmentVariables.Remove($script:LeaseHandleEnvName)

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    [void]$process.Start()
    $job = New-NativeJobObject
    try {
        Add-NativeProcessToJob -JobHandle $job -ProcessHandle $process.Handle
    } catch {
        <#
            The job object was the only bound on this child - closing it
            without also killing the process leaves that child running
            unbounded for the rest of the suite. Kill it before throwing.
        #>
        try { $process.Kill() } catch { }
        Close-NativeHandle -Handle $job
        throw "Start-BoundedProcess: could not assign the child to its bounding job object: $($_.Exception.Message)"
    }
    return [pscustomobject]@{ ProcessId = $process.Id; StartTime = $process.StartTime; JobHandle = $job }
}

function Stop-BoundedProcess {
    <#
    .SYNOPSIS
        Closes the job handle Start-BoundedProcess returned, terminating the
        process and any grandchild it spawned - the counterpart teardown a
        detached launch needs and a waited one never does.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Handle)
    Stop-NativeJobObject -JobHandle $Handle.JobHandle
    Close-NativeHandle -Handle $Handle.JobHandle
}

function ConvertTo-Win32CommandLine {
    <#
    .SYNOPSIS
        Joins Tokens into one .Arguments string using the standard Win32
        command-line quoting algorithm - the one .NET's own ArgumentList
        applies internally, reimplemented here because ArgumentList is not
        present on System.Diagnostics.ProcessStartInfo on every .NET
        Framework build this suite might run under, while .Arguments always
        is.
    #>
    param([string[]]$Tokens)
    if (-not $Tokens -or $Tokens.Count -eq 0) { return '' }
    return (($Tokens | ForEach-Object { ConvertTo-Win32Arg -Value $_ }) -join ' ')
}

function ConvertTo-Win32Arg {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $backslashes = 0
    foreach ($char in $Value.ToCharArray()) {
        if ($char -eq '\') { $backslashes++; continue }
        if ($char -eq '"') {
            [void]$builder.Append('\', ($backslashes * 2 + 1))
            [void]$builder.Append('"')
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) { [void]$builder.Append('\', $backslashes); $backslashes = 0 }
        [void]$builder.Append($char)
    }
    if ($backslashes -gt 0) { [void]$builder.Append('\', ($backslashes * 2)) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Merge-TerminationNote {
    param([string]$Current, [string]$Additional)
    if ([string]::IsNullOrEmpty($Additional)) { return $Current }
    if ([string]::IsNullOrEmpty($Current)) { return $Additional }
    return "$Current; $Additional"
}

function Get-CurrentProcessEnvironment {
    $table = @{}
    foreach ($entry in [System.Environment]::GetEnvironmentVariables().GetEnumerator()) {
        $table[[string]$entry.Key] = [string]$entry.Value
    }
    return $table
}

Export-ModuleMember -Function @(
    'Invoke-BoundedProcess', 'Start-BoundedProcess', 'Stop-BoundedProcess',
    'ConvertTo-Win32Arg', 'Get-InteractionLeaseHandleEnvironmentVariableName'
)
