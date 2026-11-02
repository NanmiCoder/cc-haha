#Requires -Version 5.1

<#
    NativeTypes.psm1 - the raw Win32 P/Invoke type surface: every struct and
    DllImport declaration the harness needs, loaded exactly once per process
    through Add-Type. Split out of Native.psm1 so that module and its sibling
    NativeDesktop.psm1 can each stay under the 400-line cap while sharing one
    compiled type definition rather than two independent Add-Type blocks
    racing to define AgentDesktopE2E.Native twice in the same process.
#>

Set-StrictMode -Version 2.0

$script:NativeTypeName = 'AgentDesktopE2E.Native'

function Initialize-E2ENative {
    <#
    .SYNOPSIS
        Loads the Win32 P/Invoke surface exactly once per process.
    #>
    [CmdletBinding()]
    param()
    if ($script:NativeTypeName -as [type]) { return }

    $source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace AgentDesktopE2E {
    [StructLayout(LayoutKind.Sequential)]
    public struct FILETIME {
        public uint dwLowDateTime;
        public uint dwHighDateTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct BY_HANDLE_FILE_INFORMATION {
        public uint dwFileAttributes;
        public FILETIME ftCreationTime;
        public FILETIME ftLastAccessTime;
        public FILETIME ftLastWriteTime;
        public uint dwVolumeSerialNumber;
        public uint nFileSizeHigh;
        public uint nFileSizeLow;
        public uint nNumberOfLinks;
        public uint nFileIndexHigh;
        public uint nFileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO {
        public int cbSize;
        public uint flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public RECT rcCaret;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFOW {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SID_AND_ATTRIBUTES {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct TOKEN_MANDATORY_LABEL {
        public SID_AND_ATTRIBUTES Label;
    }

    public static class Native {
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateFileW(
            string lpFileName,
            uint dwDesiredAccess,
            uint dwShareMode,
            ref SECURITY_ATTRIBUTES lpSecurityAttributes,
            uint dwCreationDisposition,
            uint dwFlagsAndAttributes,
            IntPtr hTemplateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint GetFileType(IntPtr hFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetFileInformationByHandle(IntPtr hFile, out BY_HANDLE_FILE_INFORMATION lpFileInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetHandleInformation(IntPtr hObject, out uint lpdwFlags);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern uint GetSystemWindowsDirectoryW(StringBuilder lpBuffer, uint uSize);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo, uint cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool GetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, IntPtr TokenInformation, int TokenInformationLength, out int ReturnLength);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool ConvertSidToStringSidW(IntPtr Sid, out IntPtr StringSid);

        [DllImport("kernel32.dll")]
        public static extern IntPtr LocalFree(IntPtr hMem);

        [DllImport("kernel32.dll")]
        public static extern IntPtr GetCurrentProcess();

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool GetCursorPos(out POINT lpPoint);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool AllowSetForegroundWindow(int dwProcessId);

        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool CreateRestrictedToken(
            IntPtr existingTokenHandle,
            uint flags,
            int disableSidCount,
            IntPtr sidsToDisable,
            int deletePrivilegeCount,
            IntPtr privilegesToDelete,
            int restrictSidCount,
            IntPtr sidsToRestrict,
            out IntPtr newTokenHandle);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool ConvertStringSidToSidW(string stringSid, out IntPtr sid);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool SetTokenInformation(IntPtr tokenHandle, int tokenInformationClass, IntPtr tokenInformation, int tokenInformationLength);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern int GetLengthSid(IntPtr sid);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcessAsUser(
            IntPtr tokenHandle,
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFOW startupInfo,
            out PROCESS_INFORMATION processInformation);

        /// `CreateProcessAsUser` is never called directly from PowerShell:
        /// measured live, PowerShell's own P/Invoke marshaling of a `ref
        /// STARTUPINFOW` (non-blittable - it embeds `string` fields) reliably
        /// fails with ERROR_PATH_NOT_FOUND even with every field set
        /// correctly, while the identical call from a compiled method (this
        /// one) succeeds. Every other export here passes only blittable types
        /// or an `out` blittable struct, so this is the one boundary that
        /// needs a wrapper.
        public static int SpawnUnderToken(
            IntPtr tokenHandle,
            string commandLine,
            string workingDirectory,
            IntPtr stdInput,
            IntPtr stdOutput,
            IntPtr stdError,
            IntPtr environment,
            bool inheritHandles,
            uint creationFlags,
            out IntPtr processHandle,
            out IntPtr threadHandle,
            out string errorDetail) {
            errorDetail = "";
            processHandle = IntPtr.Zero;
            threadHandle = IntPtr.Zero;
            STARTUPINFOW startupInfo = new STARTUPINFOW();
            startupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOW));
            startupInfo.lpDesktop = "winsta0" + "\\" + "default";
            startupInfo.dwFlags = 0x100;
            startupInfo.hStdInput = stdInput;
            startupInfo.hStdOutput = stdOutput;
            startupInfo.hStdError = stdError;
            PROCESS_INFORMATION processInformation;
            StringBuilder mutableCommandLine = new StringBuilder(commandLine);
            bool spawned = CreateProcessAsUser(
                tokenHandle, null, mutableCommandLine, IntPtr.Zero, IntPtr.Zero, inheritHandles,
                creationFlags, environment, workingDirectory, ref startupInfo, out processInformation);
            if (!spawned) {
                errorDetail = "CreateProcessAsUser failed, error " + Marshal.GetLastWin32Error();
                return -1;
            }
            processHandle = processInformation.hProcess;
            threadHandle = processInformation.hThread;
            return processInformation.dwProcessId;
        }

        [DllImport("kernel32.dll")]
        public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateProcess(IntPtr handle, uint exitCode);

        [DllImport("ntdll.dll")]
        public static extern int NtQueryInformationProcess(IntPtr processHandle, int processInformationClass, IntPtr buffer, int bufferLength, out int returnLength);

        /// Every open handle value in THIS process carrying OBJ_INHERIT
        /// (HandleAttributes bit 0x2), via NtQueryInformationProcess
        /// (ProcessHandleInformation=0x33). Field offsets are the x64
        /// PROCESS_HANDLE_TABLE_ENTRY_INFO layout, measured live against a
        /// handle opened inheritable and one opened non-inheritable.
        public static long[] GetInheritableHandleValues() {
            int size = 1 << 16;
            IntPtr buffer = IntPtr.Zero;
            try {
                for (int attempt = 0; attempt < 10; attempt++) {
                    buffer = Marshal.AllocHGlobal(size);
                    int returnLength;
                    int status = NtQueryInformationProcess(GetCurrentProcess(), 0x33, buffer, size, out returnLength);
                    if (status == 0) { break; }
                    Marshal.FreeHGlobal(buffer);
                    buffer = IntPtr.Zero;
                    if (status == unchecked((int)0xC0000004)) { size *= 2; continue; }
                    throw new InvalidOperationException("NtQueryInformationProcess(ProcessHandleInformation) failed: NTSTATUS 0x" + status.ToString("X8"));
                }
                if (buffer == IntPtr.Zero) {
                    throw new InvalidOperationException("NtQueryInformationProcess(ProcessHandleInformation) never fit the retry budget's buffer sizes");
                }
                long numberOfHandles = Marshal.ReadInt64(buffer, 0);
                const int entryOffset = 16;
                const int entrySize = 40;
                var values = new System.Collections.Generic.List<long>();
                for (long i = 0; i < numberOfHandles; i++) {
                    IntPtr entryPtr = IntPtr.Add(buffer, entryOffset + (int)(i * entrySize));
                    IntPtr handleValue = Marshal.ReadIntPtr(entryPtr, 0);
                    int handleAttributes = Marshal.ReadInt32(entryPtr, 32);
                    if ((handleAttributes & 0x2) != 0) {
                        values.Add(handleValue.ToInt64());
                    }
                }
                return values.ToArray();
            } finally {
                if (buffer != IntPtr.Zero) { Marshal.FreeHGlobal(buffer); }
            }
        }
    }
}
'@

    Add-Type -TypeDefinition $source -ErrorAction Stop
}

function New-E2ESecurityAttributes {
    param([bool]$Inheritable)
    Initialize-E2ENative
    $attributes = New-Object AgentDesktopE2E.SECURITY_ATTRIBUTES
    $attributes.nLength = [System.Runtime.InteropServices.Marshal]::SizeOf([type][AgentDesktopE2E.SECURITY_ATTRIBUTES])
    $attributes.lpSecurityDescriptor = [IntPtr]::Zero
    $attributes.bInheritHandle = if ($Inheritable) { 1 } else { 0 }
    return $attributes
}

Export-ModuleMember -Function @(
    'Initialize-E2ENative',
    'New-E2ESecurityAttributes'
)
