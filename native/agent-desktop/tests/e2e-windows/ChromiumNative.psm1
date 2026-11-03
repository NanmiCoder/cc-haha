#Requires -Version 5.1

<#
    ChromiumNative.psm1 - the raw Win32 surface U12's Chromium scenario needs
    beyond what Native.psm1/NativeDesktop.psm1 already expose: real
    hardware-level input synthesis for the bounded menu attempt
    (`keybd_event`/`mouse_event` - real synthesized input the OS delivers
    through normal input processing, never a message posted directly into a
    window's queue) and a per-thread classic menu-mode reader mirroring
    `crates/windows/src/system/menu/menu_state.rs`'s `classic_menu_mode_active`
    (`GetGUIThreadInfo` asked per thread of a named pid, not the foreground
    thread `NativeDesktop.psm1`'s `Get-NativeGuiThreadInfo` answers for).
    Split from Native.psm1/NativeTypes.psm1 rather than added there, both to
    keep those files under the 400-line cap and because this surface is
    Chromium-scenario-specific rather than harness-wide.
#>

Set-StrictMode -Version 2.0

$script:ChromiumNativeTypeName = 'AgentDeskChromium.Native'

function Initialize-ChromiumNative {
    [CmdletBinding()]
    param()
    if ($script:ChromiumNativeTypeName -as [type]) { return }
    Add-Type -Namespace AgentDeskChromium -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct GUITHREADINFO {
    public int cbSize; public uint flags;
    public System.IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public int rcCaretLeft, rcCaretTop, rcCaretRight, rcCaretBottom;
}
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct THREADENTRY32 {
    public uint dwSize, cntUsage, th32ThreadID, th32OwnerProcessID;
    public int tpBasePri, tpDeltaPri; public uint dwFlags;
}
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern System.IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern bool Thread32First(System.IntPtr hSnapshot, ref THREADENTRY32 lpte);
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern bool Thread32Next(System.IntPtr hSnapshot, ref THREADENTRY32 lpte);
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern bool CloseHandle(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetCursorPos(int x, int y);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.UIntPtr dwExtraInfo);
'@
}

function Get-ChromiumNativeClassicMenuMode {
    <# Mirrors `classic_menu_mode_active`: every thread of `ProcessId` read
       through `GetGUIThreadInfo`, true if any reports
       GUI_INMENUMODE|GUI_POPUPMENUMODE|GUI_SYSTEMMENUMODE. A thread that
       vanished between the snapshot and the read is skipped, the same
       honest-absence treatment the product's own source gives it. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    Initialize-ChromiumNative
    $TH32CS_SNAPTHREAD = 0x00000004
    $GUI_INMENUMODE = 0x0004; $GUI_POPUPMENUMODE = 0x0010; $GUI_SYSTEMMENUMODE = 0x0008
    $invalid = [IntPtr]::new(-1)
    $snap = [AgentDeskChromium.Native]::CreateToolhelp32Snapshot($TH32CS_SNAPTHREAD, 0)
    if ($snap -eq [IntPtr]::Zero -or $snap -eq $invalid) { return $false }
    try {
        $te = New-Object AgentDeskChromium.Native+THREADENTRY32
        $te.dwSize = [System.Runtime.InteropServices.Marshal]::SizeOf($te)
        $any = $false
        if ([AgentDeskChromium.Native]::Thread32First($snap, [ref]$te)) {
            do {
                if ($te.th32OwnerProcessID -eq [uint32]$ProcessId) {
                    $gti = New-Object AgentDeskChromium.Native+GUITHREADINFO
                    $gti.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($gti)
                    if ([AgentDeskChromium.Native]::GetGUIThreadInfo($te.th32ThreadID, [ref]$gti)) {
                        if (($gti.flags -band ($GUI_INMENUMODE -bor $GUI_POPUPMENUMODE -bor $GUI_SYSTEMMENUMODE)) -ne 0) { $any = $true }
                    }
                }
                $te.dwSize = [System.Runtime.InteropServices.Marshal]::SizeOf($te)
            } while ([AgentDeskChromium.Native]::Thread32Next($snap, [ref]$te))
        }
        return $any
    } finally {
        [void][AgentDeskChromium.Native]::CloseHandle($snap)
    }
}

function Invoke-ChromiumNativeAltTap {
    <# A real Alt key-down/key-up pair via `keybd_event` - the same
       hardware-level injection family `SendInput` belongs to, never a
       posted message. #>
    [CmdletBinding()]
    param()
    Initialize-ChromiumNative
    $VK_MENU = 0x12; $KEYEVENTF_KEYUP = 0x0002
    [AgentDeskChromium.Native]::keybd_event($VK_MENU, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [AgentDeskChromium.Native]::keybd_event($VK_MENU, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
}

function Invoke-ChromiumNativeRightClick {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][int]$X, [Parameter(Mandatory = $true)][int]$Y)
    Initialize-ChromiumNative
    $MOUSEEVENTF_RIGHTDOWN = 0x0008; $MOUSEEVENTF_RIGHTUP = 0x0010
    [void][AgentDeskChromium.Native]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 60
    [AgentDeskChromium.Native]::mouse_event($MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [AgentDeskChromium.Native]::mouse_event($MOUSEEVENTF_RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
}

function Invoke-ChromiumNativeLeftClick {
    <# A real left-button click via `SetCursorPos` + `mouse_event` - the same
       hardware-level injection family as Invoke-ChromiumNativeRightClick,
       never a message posted directly into a window's queue and never an
       agent-desktop command. CursorOverlay.ps1's click-through leg needs
       exactly this: a click synthesized independently of the product, so a
       WS_EX_TRANSPARENT regression on the overlay window would actually be
       caught rather than papered over by the product's own input path. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][int]$X, [Parameter(Mandatory = $true)][int]$Y)
    Initialize-ChromiumNative
    $MOUSEEVENTF_LEFTDOWN = 0x0002; $MOUSEEVENTF_LEFTUP = 0x0004
    [void][AgentDeskChromium.Native]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 60
    [AgentDeskChromium.Native]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [AgentDeskChromium.Native]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
}

function Invoke-ChromiumNativeEscape {
    [CmdletBinding()]
    param()
    Initialize-ChromiumNative
    $VK_ESCAPE = 0x1B; $KEYEVENTF_KEYUP = 0x0002
    [AgentDeskChromium.Native]::keybd_event($VK_ESCAPE, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [AgentDeskChromium.Native]::keybd_event($VK_ESCAPE, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 300
}

Export-ModuleMember -Function @(
    'Initialize-ChromiumNative',
    'Get-ChromiumNativeClassicMenuMode',
    'Invoke-ChromiumNativeAltTap',
    'Invoke-ChromiumNativeRightClick',
    'Invoke-ChromiumNativeLeftClick',
    'Invoke-ChromiumNativeEscape'
)
