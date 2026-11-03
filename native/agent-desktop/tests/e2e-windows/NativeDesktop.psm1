#Requires -Version 5.1

<#
    NativeDesktop.psm1 - raw window/cursor/GUI-thread reads via
    NativeTypes.psm1's P/Invoke surface: the oracle R14 requires
    preconditions to be staged and read through, never through
    agent-desktop.exe itself. Split out of Native.psm1 purely to keep both
    modules under the 400-line cap.
#>

Set-StrictMode -Version 2.0

Import-Module (Join-Path $PSScriptRoot 'NativeTypes.psm1') -Force -Global

function Get-NativeForegroundWindowHandle {
    [CmdletBinding()]
    param()
    Initialize-E2ENative
    return [AgentDesktopE2E.Native]::GetForegroundWindow()
}

function Get-NativeCursorPosition {
    [CmdletBinding()]
    param()
    Initialize-E2ENative
    $point = New-Object AgentDesktopE2E.POINT
    $ok = [AgentDesktopE2E.Native]::GetCursorPos([ref]$point)
    if (-not $ok) {
        throw "GetCursorPos failed: Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    return [pscustomobject]@{ X = $point.X; Y = $point.Y }
}

function Get-NativeWindowProcessId {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][IntPtr]$WindowHandle)
    Initialize-E2ENative
    $processId = 0
    [void][AgentDesktopE2E.Native]::GetWindowThreadProcessId($WindowHandle, [ref]$processId)
    return $processId
}

function Get-NativeWindowThreadId {
    <#
    .SYNOPSIS
        GetWindowThreadProcessId's own uint return value - the thread id, not
        the process id its out-parameter carries. The focus oracle needs
        this: GetGUIThreadInfo(idThread, ...) wants the id of the thread that
        owns the fixture's window, and GetFocus (the wrong API here) only
        ever answers for the calling thread's own queue.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][IntPtr]$WindowHandle)
    Initialize-E2ENative
    $processId = 0
    return [AgentDesktopE2E.Native]::GetWindowThreadProcessId($WindowHandle, [ref]$processId)
}

function Get-NativeTopLevelWindows {
    <#
    .SYNOPSIS
        Every top-level HWND on the desktop with its owning process id, via
        a raw EnumWindows walk.
    #>
    [CmdletBinding()]
    param()
    Initialize-E2ENative
    $results = New-Object System.Collections.Generic.List[object]
    $callback = {
        param([IntPtr]$hWnd, [IntPtr]$lParam)
        $windowProcessId = 0
        [void][AgentDesktopE2E.Native]::GetWindowThreadProcessId($hWnd, [ref]$windowProcessId)
        $results.Add([pscustomobject]@{ Handle = $hWnd; ProcessId = $windowProcessId })
        return $true
    }
    $delegate = $callback -as [AgentDesktopE2E.EnumWindowsProc]
    [void][AgentDesktopE2E.Native]::EnumWindows($delegate, [IntPtr]::Zero)
    return $results.ToArray()
}

function Get-NativeGuiThreadInfo {
    <#
    .SYNOPSIS
        GUITHREADINFO for the given thread id (0 means the foreground
        thread). The focus oracle in scenarios/Interaction.ps1 calls it with
        the fixture window's owning thread id.
    #>
    [CmdletBinding()]
    param([uint32]$ThreadId = 0)
    Initialize-E2ENative
    $info = New-Object AgentDesktopE2E.GUITHREADINFO
    $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][AgentDesktopE2E.GUITHREADINFO])
    $ok = [AgentDesktopE2E.Native]::GetGUIThreadInfo($ThreadId, [ref]$info)
    if (-not $ok) {
        throw "GetGUIThreadInfo failed: Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    return [pscustomobject]@{
        HwndActive = $info.hwndActive
        HwndFocus  = $info.hwndFocus
    }
}

function Get-NativeWindowRect {
    <#
    .SYNOPSIS
        Raw screen-coordinate rect for a live HWND - the independent half of
        the focus oracle's identity check: GetGUIThreadInfo names a focused
        HWND, this reads its geometry back so it can be compared against the
        product's own reported bounds without asking the product itself.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][IntPtr]$WindowHandle)
    Initialize-E2ENative
    $rect = New-Object AgentDesktopE2E.RECT
    $ok = [AgentDesktopE2E.Native]::GetWindowRect($WindowHandle, [ref]$rect)
    if (-not $ok) {
        throw "GetWindowRect failed: Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    return [pscustomobject]@{ Left = $rect.Left; Top = $rect.Top; Right = $rect.Right; Bottom = $rect.Bottom }
}

function Set-NativeForegroundWindow {
    <#
    .SYNOPSIS
        Stages OS foreground onto WindowHandle with a raw SetForegroundWindow
        - the AttachThreadInput dance crate::system::fixture::test_support::
        stage_foreground uses, ported rather than reimplemented from
        scratch: SetForegroundWindow alone is routinely refused by Windows
        when the caller is not the thread that currently owns foreground, so
        this attaches this process's input queue to the current foreground
        thread's queue for the duration of the call, exactly as the in-crate
        precedent does, and detaches again immediately after. R14: this is
        precondition staging through raw Win32, never through the product.
    .OUTPUTS
        bool: whether WindowHandle became the foreground window within the
        short settle poll below.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][IntPtr]$WindowHandle)
    Initialize-E2ENative
    $foreground = [AgentDesktopE2E.Native]::GetForegroundWindow()
    $foregroundThreadId = 0
    if ($foreground -ne [IntPtr]::Zero) {
        [void][AgentDesktopE2E.Native]::GetWindowThreadProcessId($foreground, [ref]$foregroundThreadId)
    }
    $currentThreadId = [AgentDesktopE2E.Native]::GetCurrentThreadId()
    $attached = $false
    if ($foregroundThreadId -ne 0 -and $foregroundThreadId -ne $currentThreadId) {
        $attached = [AgentDesktopE2E.Native]::AttachThreadInput($currentThreadId, $foregroundThreadId, $true)
    }
    <# ASFW_ANY (-1): a long-lived harness process can lose the "recent
       input" standing SetForegroundWindow otherwise requires, in a way a
       freshly-spawned CLI invocation of the product typically has not -
       measured live, a bare AttachThreadInput dance that succeeds in an
       interactive test shell still failed partway through a real,
       long-running suite. AllowSetForegroundWindow is harmless to call
       even when it has no effect. #>
    [void][AgentDesktopE2E.Native]::AllowSetForegroundWindow(-1)
    [void][AgentDesktopE2E.Native]::SetForegroundWindow($WindowHandle)
    if ($attached) {
        [void][AgentDesktopE2E.Native]::AttachThreadInput($currentThreadId, $foregroundThreadId, $false)
    }
    <# A single immediate read here is a false-negative trap: measured
       live, the Win32 foreground transition this call just triggered is
       not always visible to GetForegroundWindow the instant
       SetForegroundWindow returns, so an immediate one-shot check reported
       staging as failed even when it had, in fact, succeeded and would
       have read correctly a few dozen milliseconds later. This is the same
       class of race Wait-NativeForegroundToSettle's own doc-comment names
       for a freshly created window, applied here to a foreground change
       rather than a window creation - so the settle is a short bounded
       poll, not the single synchronous read a naive port of the in-crate
       stage_foreground would use. #>
    $pollDeadline = [System.Diagnostics.Stopwatch]::StartNew()
    while ($pollDeadline.Elapsed.TotalMilliseconds -lt 500) {
        if ($WindowHandle -eq [AgentDesktopE2E.Native]::GetForegroundWindow()) { return $true }
        Start-Sleep -Milliseconds 25
    }
    return $false
}

function Wait-NativeForegroundToSettle {
    <#
    .SYNOPSIS
        Polls raw GetForegroundWindow until it stops moving for
        RequiredStableReads consecutive reads, or BudgetSeconds elapses -
        the same settle proof crate::system::fixture::test_support::
        wait_for_foreground_to_settle makes, because a newly spawned window
        is not steady: Windows grants it foreground a variable time after
        creation, so a control's "who owns foreground" premise has to be
        established by observation, never inferred from a spawn call having
        returned.
    .OUTPUTS
        bool: whether the foreground window settled within the budget.
    #>
    [CmdletBinding()]
    param([int]$RequiredStableReads = 5, [int]$PollMilliseconds = 50, [int]$BudgetSeconds = 15)
    Initialize-E2ENative
    $deadline = [System.Diagnostics.Stopwatch]::StartNew()
    $last = [AgentDesktopE2E.Native]::GetForegroundWindow()
    $stable = 0
    while ($deadline.Elapsed.TotalSeconds -lt $BudgetSeconds) {
        Start-Sleep -Milliseconds $PollMilliseconds
        $current = [AgentDesktopE2E.Native]::GetForegroundWindow()
        if ($current -eq $last) {
            $stable++
            if ($stable -ge $RequiredStableReads) { return $true }
        } else {
            $stable = 0
            $last = $current
        }
    }
    return $false
}

$script:ScreenCaptureTypeName = 'AgentDesktopE2E.ScreenCapture'

function Initialize-E2EScreenCapture {
    <#
    .SYNOPSIS
        Loads the GDI screen-capture P/Invoke surface once - a separate
        Add-Type from NativeTypes.psm1's shared Native class (which is
        already at the 400-line cap) rather than an extension of it, the
        same way ChromiumNative.psm1/LibShell.psm1 each carry their own
        small compiled surface beside the shared one.
    #>
    [CmdletBinding()]
    param()
    if ($script:ScreenCaptureTypeName -as [type]) { return }
    Add-Type -Namespace AgentDesktopE2E -Name ScreenCapture -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetDC(System.IntPtr hwnd);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern int ReleaseDC(System.IntPtr hwnd, System.IntPtr hdc);
[System.Runtime.InteropServices.DllImport("gdi32.dll")]
public static extern System.IntPtr CreateCompatibleDC(System.IntPtr hdc);
[System.Runtime.InteropServices.DllImport("gdi32.dll")]
public static extern System.IntPtr CreateCompatibleBitmap(System.IntPtr hdc, int w, int h);
[System.Runtime.InteropServices.DllImport("gdi32.dll")]
public static extern System.IntPtr SelectObject(System.IntPtr hdc, System.IntPtr obj);
[System.Runtime.InteropServices.DllImport("gdi32.dll")]
public static extern bool DeleteObject(System.IntPtr obj);
[System.Runtime.InteropServices.DllImport("gdi32.dll")]
public static extern bool DeleteDC(System.IntPtr hdc);
[System.Runtime.InteropServices.DllImport("gdi32.dll", SetLastError = true)]
public static extern bool BitBlt(System.IntPtr dst, int x, int y, int w, int h, System.IntPtr src, int sx, int sy, uint rop);
[System.Runtime.InteropServices.DllImport("gdi32.dll")]
public static extern uint GetPixel(System.IntPtr hdc, int x, int y);
'@
}

function Get-NativeScreenPixel {
    <#
    .SYNOPSIS
        The COLORREF (0x00bbggrr) at screen point (X, Y), read through a
        screen-DC BitBlt into a 1x1 memory bitmap and GetPixel - never a
        direct GetPixel on the screen DC. KTD8/A29-4: a layered window
        carrying WS_EX_TRANSPARENT is invisible to hit-testing
        (WindowFromPoint), so "is the overlay on screen" has to be a real
        painted pixel; BitBlt with CAPTUREBLT is what makes that read
        include a layered window's composited output at all - without the
        flag the desktop compositor's own composited surface is what a
        plain screen-DC read returns, and a layered window is silently
        missing from it. Mirrors probes/windows/29-cursor-overlay.ps1's own
        SampleScreenPixel, which proved this in both directions (A29-3).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][int]$X, [Parameter(Mandatory = $true)][int]$Y)
    Initialize-E2EScreenCapture
    $srcCopy = 0x00CC0020
    $captureBlt = 0x40000000
    $screenDc = [AgentDesktopE2E.ScreenCapture]::GetDC([IntPtr]::Zero)
    if ($screenDc -eq [IntPtr]::Zero) { throw 'Get-NativeScreenPixel: GetDC(NULL) failed' }
    try {
        $memDc = [AgentDesktopE2E.ScreenCapture]::CreateCompatibleDC($screenDc)
        $bitmap = [AgentDesktopE2E.ScreenCapture]::CreateCompatibleBitmap($screenDc, 1, 1)
        $previous = [AgentDesktopE2E.ScreenCapture]::SelectObject($memDc, $bitmap)
        try {
            $ok = [AgentDesktopE2E.ScreenCapture]::BitBlt($memDc, 0, 0, 1, 1, $screenDc, $X, $Y, ($srcCopy -bor $captureBlt))
            if (-not $ok) {
                throw "Get-NativeScreenPixel: BitBlt failed: Win32 error $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
            }
            return [uint32]([AgentDesktopE2E.ScreenCapture]::GetPixel($memDc, 0, 0))
        } finally {
            [void][AgentDesktopE2E.ScreenCapture]::SelectObject($memDc, $previous)
            [void][AgentDesktopE2E.ScreenCapture]::DeleteObject($bitmap)
            [void][AgentDesktopE2E.ScreenCapture]::DeleteDC($memDc)
        }
    } finally {
        [void][AgentDesktopE2E.ScreenCapture]::ReleaseDC([IntPtr]::Zero, $screenDc)
    }
}

function ConvertTo-NativeWindowHandle {
    <#
    .SYNOPSIS
        Parses agent-desktop's own "w-<handle>" window-id shape into an
        IntPtr purely as a handle carrier for a subsequent raw OS call
        (GetWindowThreadProcessId, GetWindowRect, ...) - never itself the
        assertion. Mirrors the numeric-handle-from-string cast
        DesktopLease.psm1 already uses for an inherited lease handle.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$WindowId)
    if ($WindowId -notmatch '^w-(\d+)$') {
        throw "ConvertTo-NativeWindowHandle: '$WindowId' is not a 'w-<handle>' shaped window id"
    }
    <#
        Reinterpret the bits rather than casting through a signed integer. A
        HWND is unsigned, and agent-desktop prints it unsigned, so a window
        whose handle has the high bit set renders as a decimal above
        Int64.MaxValue and `[int64]` throws - aborting the whole suite rather
        than the one leg. Which windows land there varies per run, so the
        failure is intermittent and looks like anything but a cast.
    #>
    $unsigned = [uint64]$Matches[1]
    return [IntPtr][System.BitConverter]::ToInt64([System.BitConverter]::GetBytes($unsigned), 0)
}

Export-ModuleMember -Function @(
    'Get-NativeForegroundWindowHandle',
    'Get-NativeCursorPosition',
    'Get-NativeWindowProcessId',
    'Get-NativeWindowThreadId',
    'Get-NativeTopLevelWindows',
    'Get-NativeGuiThreadInfo',
    'Get-NativeWindowRect',
    'Set-NativeForegroundWindow',
    'Wait-NativeForegroundToSettle',
    'ConvertTo-NativeWindowHandle',
    'Get-NativeScreenPixel'
)
