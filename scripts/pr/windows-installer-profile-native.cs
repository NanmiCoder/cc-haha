// The only Win32 boundary for issue 1879's disposable CI profile fixture.
// Stage A never invokes account/profile methods. No method grants account
// rights, edits SAM/ProfileList directly, or changes a shared desktop DACL.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace CcHahaInstallerProfile
{
  internal sealed class NativePlatform : ProfilePlatform
  {
    private const uint TokenQuery = 0x0008;
    private const uint TokenAdjustPrivileges = 0x0020;
    private const uint ProcessQueryLimited = 0x1000;
    private const uint StillActive = 259;
    private const uint Infinite = 0xffffffff;
    private const uint AccountDisabled = 0x0002;
    private const uint NormalAccount = 0x0200;
    private const string UsersSid = "S-1-5-32-545";
    // Microsoft WindowsAppSDK ApplicationData spec 3.4.1 identifies this
    // service SID. It is never a fresh-profile owner or a general writer.
    internal const string TrustedInstallerSid = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    private const uint KnownProfileFileRights = 0xf01f01ffu;
    private const uint ProfileMutationMask = 0x500d0156u;
    private const uint ParentMutationMask = 0x500d0152u;
    private const string SetupSha = "dca6bb82f4d0fbee8d43c91912e4d50e7dcea69a7cb22c51cdd9cb265767c7e7";
    private const long SetupBytes = 230611497;
    private readonly int ownerManagedThread = Thread.CurrentThread.ManagedThreadId;
    private uint ownerNativeThread;
    private readonly Dictionary<int, string> preexistingProcesses = new Dictionary<int, string>();
    private FixtureSpec controllerContext;
    private FixtureSpec subjectContext;
    private FixtureState abiEnvironmentContext;
    private bool subjectPeerAuthenticated;
    private bool subjectProductsAllowed;
    private FileSecurity originalControllerImageSecurity;
    private FileIdentity originalControllerImageIdentity;
    private string originalControllerImagePath;
    private readonly List<string> tokenProbeDiagnostics = new List<string>();
    private PrivateDesktopCreator desktopCreator;

    // CreateDesktop attaches its caller to the new desktop. Keep that caller
    // separate from the long-lived STA which may already own COM windows.
    internal sealed class PrivateDesktopCreator
    {
      private readonly Thread thread;
      private Exception failure;
      private bool started;
      internal bool IsAlive { get { return thread.IsAlive; } }

      internal PrivateDesktopCreator(Action create)
      {
        thread = new Thread(delegate() {
          try { create(); }
          catch (Exception error) { failure = error; }
        });
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.MTA);
      }

      internal void Start()
      {
        CorePolicy.Require(!started, "Private desktop creator already started");
        thread.Start();
        started = true;
      }

      internal void WaitForExit(int timeoutMilliseconds)
      {
        CorePolicy.Require(started && timeoutMilliseconds > 0 && timeoutMilliseconds <= 5000, "Invalid private desktop creator wait");
        Stopwatch deadline = Stopwatch.StartNew();
        // Join/WaitHandle on an STA can pump COM/messages while the process
        // station is temporarily changed. Sleep does not pump either queue.
        while (thread.IsAlive)
        {
          int remaining = timeoutMilliseconds - checked((int)Math.Min(deadline.ElapsedMilliseconds, Int32.MaxValue));
          CorePolicy.Require(remaining > 0, "Private desktop creator timed out");
          Thread.Sleep(Math.Min(10, remaining));
        }
        CorePolicy.Require(deadline.ElapsedMilliseconds <= timeoutMilliseconds, "Private desktop creator exceeded its deadline");
        CorePolicy.Require(thread.Join(0), "Private desktop creator has not exited");
      }

      internal void ThrowIfFailed() { if (failure != null) throw failure; }
    }

    private sealed class TokenInformationFailure : InvalidOperationException
    {
      internal TokenInformationFailure(string diagnostic) : base(diagnostic) { }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)]
    private struct LuidAttributes { public Luid Luid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct TokenPrivilegesOne { public uint Count; public LuidAttributes Privilege; }
    [StructLayout(LayoutKind.Sequential)]
    private struct SidAttributes { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct TokenGroupsOne { public uint Count; public SidAttributes Group; }
    [StructLayout(LayoutKind.Sequential)]
    private struct TokenStatistics
    {
      public Luid TokenId; public Luid AuthenticationId; public long ExpirationTime;
      public int TokenType; public int ImpersonationLevel; public uint DynamicCharged;
      public uint DynamicAvailable; public uint GroupCount; public uint PrivilegeCount; public Luid ModifiedId;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime { public uint Low; public uint High; }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
      public uint Attributes; public FileTime Creation; public FileTime Access; public FileTime Write;
      public uint VolumeSerial; public uint SizeHigh; public uint SizeLow; public uint Links;
      public uint IndexHigh; public uint IndexLow;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
      public int cb; public string reserved; public string desktop; public string title;
      public uint x; public uint y; public uint xSize; public uint ySize; public uint xChars;
      public uint yChars; public uint fill; public uint flags; public ushort show; public ushort reservedSize;
      public IntPtr reservedBytes; public IntPtr stdin; public IntPtr stdout; public IntPtr stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation { public IntPtr process; public IntPtr thread; public uint pid; public uint tid; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProfileInfo
    {
      public uint size; public uint flags; public string userName; public string profilePath;
      public string defaultPath; public string serverName; public string policyPath; public IntPtr profile;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
      public long processTime; public long jobTime; public uint flags; public UIntPtr minWorkingSet;
      public UIntPtr maxWorkingSet; public uint activeProcessLimit; public UIntPtr affinity;
      public uint priorityClass; public uint schedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
      public ulong readOperations; public ulong writeOperations; public ulong otherOperations;
      public ulong readBytes; public ulong writeBytes; public ulong otherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
      public BasicLimits basic; public IoCounters io; public UIntPtr processMemory;
      public UIntPtr jobMemory; public UIntPtr peakProcessMemory; public UIntPtr peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct JobAccounting
    {
      public long userTime; public long kernelTime; public long periodUserTime; public long periodKernelTime;
      public uint pageFaults; public uint totalProcesses; public uint activeProcesses; public uint terminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct UserInfo1
    {
      public string name; public IntPtr password; public uint passwordAge; public uint privilege;
      public string home; public string comment; public uint flags; public string script;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct UserInfo4
    {
      public IntPtr name; public IntPtr password; public uint passwordAge; public uint privilege;
      public IntPtr home; public IntPtr comment; public uint flags; public IntPtr script; public uint authFlags;
      public IntPtr fullName; public IntPtr userComment; public IntPtr parameters; public IntPtr workstations;
      public uint lastLogon; public uint lastLogoff; public uint expires; public uint maxStorage;
      public uint unitsPerWeek; public IntPtr logonHours; public uint badPasswordCount; public uint logons;
      public IntPtr logonServer; public uint countryCode; public uint codePage; public IntPtr sid;
      public uint primaryGroup; public IntPtr profile; public IntPtr homeDrive; public uint passwordExpired;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct UserFlags { public uint flags; }
    [StructLayout(LayoutKind.Sequential)]
    private struct LocalGroupMember { public IntPtr sid; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ServiceStatusProcess
    {
      public uint type; public uint state; public uint controls; public uint win32Exit;
      public uint serviceExit; public uint checkpoint; public uint waitHint; public uint pid; public uint flags;
    }

    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentThread();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetModuleHandleExW(uint flags, string module, out IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetModuleFileNameW(IntPtr module, StringBuilder path, uint characters);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, ExactSpelling = true, SetLastError = true)] private static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetHandleInformation(IntPtr handle, out uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern uint GetWindowsDirectoryW(StringBuilder path, uint characters);
    [DllImport("kernel32.dll", EntryPoint = "CreateDirectoryW", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateDirectoryW(string path, ref SecurityAttributes attributes);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateFileW(string file, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandleW(IntPtr file, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(IntPtr file, out FileInformation info);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObjectW(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JobAccounting info, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInformation process);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool CreateProcessWithTokenW(IntPtr token, uint logonFlags, string application, StringBuilder commandLine, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInformation process);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenThreadToken(IntPtr thread, uint access, bool openAsSelf, out IntPtr token);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenSCManagerW(string machine, string database, uint access);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenServiceW(IntPtr manager, string service, uint access);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool QueryServiceStatusEx(IntPtr service, int level, out ServiceStatusProcess status, uint bytes, out uint needed);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool CloseServiceHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr buffer, int length, out int needed);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool LookupPrivilegeNameW(string system, ref Luid luid, StringBuilder name, ref uint length);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool LookupPrivilegeValueW(string system, string name, out Luid luid);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivilegesOne state, uint length, out TokenPrivilegesOne previous, out uint returned);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool LogonUserW(string user, string domain, IntPtr password, int type, int provider, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool LookupAccountNameW(string system, string name, IntPtr sid, ref uint sidBytes, StringBuilder domain, ref uint domainChars, out int use);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool LookupAccountSidW(string system, IntPtr sid, StringBuilder name, ref uint nameChars, StringBuilder domain, ref uint domainChars, out int use);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string descriptor, uint revision, out IntPtr security, out uint size);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityInfo(IntPtr handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] private static extern bool IsValidSecurityDescriptor(IntPtr descriptor);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] private static extern int CreateProfile(string sid, string name, StringBuilder path, uint characters);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool LoadUserProfileW(IntPtr token, ref ProfileInfo profile);
    [DllImport("userenv.dll", SetLastError = true)] private static extern bool UnloadUserProfile(IntPtr token, IntPtr profile);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool DeleteProfileW(string sid, string path, string computer);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetUserProfileDirectoryW(IntPtr token, StringBuilder path, ref uint characters);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetProfilesDirectoryW(StringBuilder path, ref uint characters);
    [DllImport("userenv.dll", SetLastError = true)] private static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);
    [DllImport("userenv.dll", SetLastError = true)] private static extern bool DestroyEnvironmentBlock(IntPtr environment);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern int SHGetKnownFolderPath(ref Guid folder, uint flags, IntPtr token, out IntPtr path);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern uint NetUserAdd(string server, uint level, ref UserInfo1 user, out uint parameterError);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern uint NetUserGetInfo(string server, string name, uint level, out IntPtr buffer);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern uint NetUserSetInfo(string server, string name, uint level, ref UserFlags flags, out uint parameterError);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern uint NetUserDel(string server, string name);
    [DllImport("netapi32.dll")] private static extern uint NetApiBufferFree(IntPtr buffer);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern uint NetUserGetLocalGroups(string server, string user, uint level, uint flags, out IntPtr buffer, uint preferred, out uint read, out uint total);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)] private static extern uint NetLocalGroupAddMembers(string server, string group, uint level, ref LocalGroupMember members, uint count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateWindowStationW(string name, uint flags, uint access, ref SecurityAttributes security);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr mode, uint flags, uint access, ref SecurityAttributes security);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetProcessWindowStation(IntPtr station);
    [DllImport("user32.dll")] private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseWindowStation(IntPtr station);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder value, uint length, out uint needed);
    [DllImport("advapi32.dll")] private static extern int RegOpenCurrentUser(uint access, out IntPtr key);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateNamedPipeW(string name, uint openMode, uint mode, uint instances, uint outSize, uint inSize, uint timeout, ref SecurityAttributes attributes);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid);

    private static void Win(bool success, string operation)
    {
      if (!success) throw new InvalidOperationException(operation + " failed (Win32 " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ")");
    }

    private static void Net(uint status, string operation)
    {
      if (status != 0) throw new InvalidOperationException(operation + " failed (NET_API_STATUS " + status.ToString(CultureInfo.InvariantCulture) + ")");
    }

    internal static string SafeFailure(Exception error)
    {
      if (error == null) return "Native operation failed (UnknownException)";
      if (error is TokenInformationFailure) return error.Message;
      string message = error.Message;
      // FixtureFailure is reserved for our constant stage/assertion labels.
      // Do not allow even that type to carry paths, quoted data or multiline text.
      if (error is FixtureFailure && message != null && message.Length <= 192 &&
        System.Text.RegularExpressions.Regex.IsMatch(message, @"\A[A-Za-z0-9][A-Za-z0-9 _.,:;()=-]{0,191}\z",
          System.Text.RegularExpressions.RegexOptions.CultureInvariant)) return message;
      Win32Exception win32 = error as Win32Exception;
      if (win32 != null) return "Native operation failed (Win32 " + win32.NativeErrorCode.ToString(CultureInfo.InvariantCulture) + ")";
      if (error is InvalidOperationException && message != null && message.Length <= 160 &&
        System.Text.RegularExpressions.Regex.IsMatch(message,
          @"\A[A-Za-z][A-Za-z0-9 _-]{0,95} failed \((?:Win32|NET_API_STATUS) [0-9]{1,10}\)\z",
          System.Text.RegularExpressions.RegexOptions.CultureInvariant)) return message;
      return "Native operation failed (" + error.GetType().Name + ")";
    }

    private static void StageBIdentity(FixtureSpec spec, string mode)
    {
      CorePolicy.Require(spec != null && spec.realExecutionAdmitted && spec.executionStage == "B" && spec.mode == mode &&
        spec.runId == "52f4ce19-5ded-4b27-8268-a2840809e0ca" && spec.generation == 1 &&
        spec.owner == "codex:local:01a1c9a5-381e-7b33-9648-c8968b61de4c" &&
        spec.frozenPlanManifestSha256 == CorePolicy.PlanHash && spec.argvEnvPlanSha256 == CorePolicy.EnvironmentPlanHash,
        "Real profile operation requires an exact reviewed stage B context");
    }

    private void Real(FixtureState state)
    {
      CorePolicy.Require(state != null && Object.ReferenceEquals(state.spec, controllerContext), "Native Controller adapter is not bound");
      if (state.spec.mode == "createprofile-only-controller") CorePolicy.ValidateProfileOnlySpec(state.spec);
      else StageBIdentity(state.spec, "historical-v078-controller");
    }

    private void HistoricalController(FixtureState state)
    {
      Real(state);
      StageBIdentity(state.spec, "historical-v078-controller");
    }

    private void Subject(FixtureSpec spec, bool products)
    {
      CorePolicy.Require(Object.ReferenceEquals(spec, subjectContext) && subjectPeerAuthenticated, "Native subject adapter is not authenticated");
      StageBIdentity(spec, "historical-v078-subject");
      CorePolicy.Require(!products || subjectProductsAllowed, "Product launch has not received authenticated ACK");
      CorePolicy.AssertStandard(InspectCurrentToken(), spec.expectedSid);
    }

    internal void BindControllerContext(FixtureSpec spec)
    {
      CorePolicy.Require(controllerContext == null && subjectContext == null, "Native adapter was already bound");
      CorePolicy.ValidateControllerSpec(spec);
      CorePolicy.Require(Environment.OSVersion.Platform == PlatformID.Win32NT && IntPtr.Size == 8 &&
        String.Equals(Environment.GetEnvironmentVariable("CI"), "true", StringComparison.OrdinalIgnoreCase), "Controller binding requires Windows x64 CI");
      CorePolicy.ValidateBindings(spec, this);
      controllerContext = spec;
    }

    internal void BindProfileOnlyContext(FixtureSpec spec)
    {
      CorePolicy.Require(controllerContext == null && subjectContext == null, "Native adapter was already bound");
      CorePolicy.ValidateProfileOnlySpec(spec);
      CorePolicy.Require(Environment.OSVersion.Platform == PlatformID.Win32NT && IntPtr.Size == 8 &&
        String.Equals(Environment.GetEnvironmentVariable("CI"), "true", StringComparison.OrdinalIgnoreCase), "Profile-only binding requires Windows x64 CI");
      CorePolicy.ValidateProfileOnlyBindings(spec, this);
      controllerContext = spec;
    }

    internal void BindSubjectContext(FixtureSpec spec)
    {
      CorePolicy.Require(controllerContext == null && subjectContext == null, "Native adapter was already bound");
      StageBIdentity(spec, "historical-v078-subject");
      CorePolicy.Require(Environment.OSVersion.Platform == PlatformID.Win32NT && IntPtr.Size == 8, "Subject binding requires Windows x64");
      CorePolicy.AssertStandard(InspectCurrentToken(), spec.expectedSid);
      CorePolicy.ValidateBindings(spec, this);
      subjectContext = spec;
    }

    internal void AllowSubjectProducts(FixtureSpec spec, ProtocolMessage acknowledgement)
    {
      Subject(spec, false);
      CorePolicy.Require(acknowledgement != null && acknowledgement.version == 1 && acknowledgement.kind == "ack" &&
        acknowledgement.nonce == spec.nonce && acknowledgement.binarySha256 == spec.expectedBinarySha256 &&
        acknowledgement.specSha256 == CorePolicy.HashFile(spec.subjectSpecPath), "Native product ACK binding failed");
      subjectProductsAllowed = true;
    }

    private static string Sid(IntPtr sid)
    {
      CorePolicy.Require(sid != IntPtr.Zero, "Missing native SID");
      return new SecurityIdentifier(sid).Value;
    }

    private static IntPtr SidBuffer(string value)
    {
      SecurityIdentifier sid = new SecurityIdentifier(value);
      byte[] bytes = new byte[sid.BinaryLength];
      sid.GetBinaryForm(bytes, 0);
      IntPtr buffer = Marshal.AllocHGlobal(bytes.Length);
      Marshal.Copy(bytes, 0, buffer, bytes.Length);
      return buffer;
    }

    internal static bool AcceptTokenSizeProbe(int infoClass, bool success, int error, int requiredBytes)
    {
      return !success && requiredBytes > 0 && requiredBytes <= 1048576 &&
        (error == 122 || (infoClass == 12 && error == 24 && requiredBytes == sizeof(uint)));
    }

    internal static int FixedTokenCapacity(int infoClass)
    {
      // TOKEN_ELEVATION is exactly one DWORD. Query that structure directly;
      // do not interpret its observed ERROR_BAD_LENGTH size probe as success.
      return infoClass == 20 ? sizeof(uint) : 0;
    }

    internal static bool AcceptTokenFill(int infoClass, bool success, int capacity, int observedLength)
    {
      bool scalar = infoClass == 8 || infoClass == 12 || infoClass == 18 || infoClass == 20;
      return success && capacity > 0 && capacity <= 1048576 && observedLength > 0 && observedLength <= capacity
        && (!scalar || (capacity == sizeof(uint) && observedLength == sizeof(uint)));
    }

    private string TokenDiagnostic(string phase, int infoClass, bool success, int error,
      int seedLength, int capacity, int observedLength)
    {
      string diagnostic = String.Format(CultureInfo.InvariantCulture,
        "GetTokenInformation {0} class={1} success={2} error={3} seedLength={4} capacity={5} observedLength={6}",
        phase, infoClass, success ? 1 : 0, error, seedLength, capacity, observedLength);
      if (tokenProbeDiagnostics.Count < 64) tokenProbeDiagnostics.Add(diagnostic);
      return diagnostic;
    }

    private IntPtr TokenBuffer(IntPtr token, int infoClass)
    {
      int capacity = FixedTokenCapacity(infoClass);
      if (capacity == 0)
      {
        // Framework WindowsIdentity seeds a DWORD for TokenSessionId. A 24
        // response need not prove that native code wrote ReturnLength, so retain
        // the seed separately and require a successful exact scalar fill.
        int seedLength = infoClass == 12 ? sizeof(uint) : 0;
        int size = seedLength;
        bool first = GetTokenInformation(token, infoClass, IntPtr.Zero, 0, out size);
        int sizeError = Marshal.GetLastWin32Error();
        string probe = TokenDiagnostic("size", infoClass, first, sizeError, seedLength, 0, size);
        if (!AcceptTokenSizeProbe(infoClass, first, sizeError, size)) throw new TokenInformationFailure(probe);
        capacity = size;
      }
      else if (tokenProbeDiagnostics.Count < 64)
        tokenProbeDiagnostics.Add("GetTokenInformation fixed-capacity class=20 capacity=4 source=TOKEN_ELEVATION-DWORD; no size probe");
      IntPtr data = Marshal.AllocHGlobal(capacity);
      try
      {
        int observedLength = 0;
        bool filled = GetTokenInformation(token, infoClass, data, capacity, out observedLength);
        int fillError = Marshal.GetLastWin32Error();
        string fill = TokenDiagnostic("fill", infoClass, filled, fillError, 0, capacity, observedLength);
        // Last-error can be stale on Framework after success. It is evidence,
        // not a reason to reject an otherwise successful, bounded fill.
        if (!AcceptTokenFill(infoClass, filled, capacity, observedLength))
          throw new TokenInformationFailure(fill);
        return data;
      }
      catch { Marshal.FreeHGlobal(data); throw; }
    }

    public override TokenIdentity InspectToken(IntPtr token)
    {
      CorePolicy.Require(token != IntPtr.Zero, "Missing token");
      TokenIdentity result = new TokenIdentity();
      IntPtr buffer = TokenBuffer(token, 1);
      try { result.sid = Sid(Marshal.ReadIntPtr(buffer)); } finally { Marshal.FreeHGlobal(buffer); }
      buffer = TokenBuffer(token, 8);
      try { result.tokenType = Marshal.ReadInt32(buffer); } finally { Marshal.FreeHGlobal(buffer); }
      buffer = TokenBuffer(token, 12);
      try { result.sessionId = Marshal.ReadInt32(buffer); } finally { Marshal.FreeHGlobal(buffer); }
      buffer = TokenBuffer(token, 18);
      try { result.elevationType = Marshal.ReadInt32(buffer); } finally { Marshal.FreeHGlobal(buffer); }
      buffer = TokenBuffer(token, 20);
      try { result.elevated = Marshal.ReadInt32(buffer) != 0; } finally { Marshal.FreeHGlobal(buffer); }
      buffer = TokenBuffer(token, 25);
      try
      {
        string integrity = Sid(Marshal.ReadIntPtr(buffer));
        string[] parts = integrity.Split('-');
        result.integrityRid = Int32.Parse(parts[parts.Length - 1], CultureInfo.InvariantCulture);
      }
      finally { Marshal.FreeHGlobal(buffer); }
      buffer = TokenBuffer(token, 10);
      try
      {
        TokenStatistics statistics = (TokenStatistics)Marshal.PtrToStructure(buffer, typeof(TokenStatistics));
        result.authenticationId = (((ulong)(uint)statistics.AuthenticationId.High << 32) | statistics.AuthenticationId.Low).ToString(CultureInfo.InvariantCulture);
      }
      finally { Marshal.FreeHGlobal(buffer); }
      buffer = TokenBuffer(token, 2);
      try
      {
        uint count = unchecked((uint)Marshal.ReadInt32(buffer));
        CorePolicy.Require(count < 4096, "Token group count is out of bounds");
        int offset = Marshal.OffsetOf(typeof(TokenGroupsOne), "Group").ToInt32();
        int stride = Marshal.SizeOf(typeof(SidAttributes));
        for (uint i = 0; i < count; i++)
        {
          SidAttributes group = (SidAttributes)Marshal.PtrToStructure(IntPtr.Add(buffer, offset + checked((int)i * stride)), typeof(SidAttributes));
          // Preserve deny-only groups too. Core's standard-token assertion must
          // reject Administrators even when the enabled bit has been removed.
          result.groups.Add(Sid(group.Sid));
        }
      }
      finally { Marshal.FreeHGlobal(buffer); }
      buffer = TokenBuffer(token, 3);
      try
      {
        uint count = unchecked((uint)Marshal.ReadInt32(buffer));
        CorePolicy.Require(count < 4096, "Token privilege count is out of bounds");
        int offset = Marshal.OffsetOf(typeof(TokenPrivilegesOne), "Privilege").ToInt32();
        int stride = Marshal.SizeOf(typeof(LuidAttributes));
        for (uint i = 0; i < count; i++)
        {
          LuidAttributes privilege = (LuidAttributes)Marshal.PtrToStructure(IntPtr.Add(buffer, offset + checked((int)i * stride)), typeof(LuidAttributes));
          uint length = 256;
          StringBuilder name = new StringBuilder((int)length);
          Win(LookupPrivilegeNameW(null, ref privilege.Luid, name, ref length), "LookupPrivilegeNameW");
          result.privileges.Add(name.ToString());
        }
      }
      finally { Marshal.FreeHGlobal(buffer); }
      return result;
    }

    public override TokenIdentity InspectCurrentToken()
    {
      IntPtr token;
      Win(OpenProcessToken(GetCurrentProcess(), TokenQuery, out token), "OpenProcessToken");
      try { return InspectToken(token); } finally { CloseHandle(token); }
    }

    private static string ProcessCreation(IntPtr process)
    {
      FileTime created, exited, kernel, user;
      Win(GetProcessTimes(process, out created, out exited, out kernel, out user), "GetProcessTimes");
      return (((ulong)created.High << 32) | created.Low).ToString(CultureInfo.InvariantCulture);
    }

    private AccountRecord ReadAccount(string name)
    {
      IntPtr data;
      uint status = NetUserGetInfo(null, name, 4, out data);
      if (status == 2221) return null;
      Net(status, "NetUserGetInfo");
      try
      {
        UserInfo4 user = (UserInfo4)Marshal.PtrToStructure(data, typeof(UserInfo4));
        return new AccountRecord {
          sam = Marshal.PtrToStringUni(user.name), sid = Sid(user.sid),
          marker = Marshal.PtrToStringUni(user.comment), flags = user.flags,
          groups = ReadLocalGroups(name)
        };
      }
      finally { NetApiBufferFree(data); }
    }

    private static string LookupSid(string name)
    {
      uint sidBytes = 0, domainCharacters = 0;
      int use;
      LookupAccountNameW(null, name, IntPtr.Zero, ref sidBytes, null, ref domainCharacters, out use);
      CorePolicy.Require(Marshal.GetLastWin32Error() == 122 && sidBytes > 0 && sidBytes < 4096 && domainCharacters < 32768, "Local group SID query failed");
      IntPtr bytes = Marshal.AllocHGlobal((int)sidBytes);
      try
      {
        StringBuilder domain = new StringBuilder((int)domainCharacters);
        Win(LookupAccountNameW(null, name, bytes, ref sidBytes, domain, ref domainCharacters, out use), "LookupAccountNameW");
        return Sid(bytes);
      }
      finally { Marshal.FreeHGlobal(bytes); }
    }

    private static string LookupName(string sid)
    {
      IntPtr bytes = SidBuffer(sid);
      try
      {
        uint nameCharacters = 1024, domainCharacters = 1024;
        StringBuilder name = new StringBuilder((int)nameCharacters), domain = new StringBuilder((int)domainCharacters);
        int use;
        Win(LookupAccountSidW(null, bytes, name, ref nameCharacters, domain, ref domainCharacters, out use), "LookupAccountSidW");
        return name.ToString();
      }
      finally { Marshal.FreeHGlobal(bytes); }
    }

    private static List<string> ReadLocalGroups(string user)
    {
      IntPtr data;
      uint read, total;
      Net(NetUserGetLocalGroups(null, user, 0, 1, out data, Infinite, out read, out total), "NetUserGetLocalGroups");
      try
      {
        CorePolicy.Require(read == total && read < 1024, "Local group enumeration incomplete");
        List<string> groups = new List<string>();
        for (uint i = 0; i < read; i++) groups.Add(LookupSid(Marshal.PtrToStringUni(Marshal.ReadIntPtr(data, checked((int)i * IntPtr.Size)))));
        return groups;
      }
      finally { if (data != IntPtr.Zero) NetApiBufferFree(data); }
    }

    public override void CreateDisabledAccount(FixtureState state, SecretBuffer password)
    {
      Real(state);
      CorePolicy.Require(!state.accountCreated && !state.accountBound && ReadAccount(state.sam) == null, "Account name is not fresh");
      CorePolicy.Require(password != null && password.Pointer != IntPtr.Zero, "Missing native password buffer");
      UserInfo1 user = new UserInfo1 { name = state.sam, password = password.Pointer, privilege = 1, comment = state.marker, flags = NormalAccount | AccountDisabled | 1 };
      uint parameter;
      Real(state);
      Net(NetUserAdd(null, 1, ref user, out parameter), "NetUserAdd");
      state.accountCreated = true; // Persist even if the subsequent SID read fails.
      state.accountDisabled = true;
      if (state.report != null) state.report.realAccountsCreated++;
      state.account = ReadAccount(state.sam);
      CorePolicy.Require(state.account != null && state.account.marker == state.marker && state.account.sid != state.runnerSid &&
        state.account.sid.StartsWith("S-1-5-21-", StringComparison.Ordinal) && (state.account.flags & AccountDisabled) != 0, "Created account SID/marker readback failed");
    }

    public override void VerifyOwnedAccount(FixtureState state, bool disabled)
    {
      Real(state);
      CorePolicy.Require(state.accountCreated && state.accountBound && state.account != null, "Account ownership has not been durably bound");
      AccountRecord current = ReadAccount(state.sam);
      CorePolicy.Require(current != null && current.sid == state.account.sid && current.sam == state.account.sam &&
        current.marker == state.marker && current.marker == state.account.marker && current.sid != state.runnerSid &&
        ((current.flags & AccountDisabled) != 0) == disabled, "Owned account identity or flags changed");
      state.account = current;
    }

    public override void AddUsersOnly(FixtureState state)
    {
      VerifyOwnedAccount(state, true);
      IntPtr sid = SidBuffer(state.account.sid);
      try
      {
        LocalGroupMember member = new LocalGroupMember { sid = sid };
        Real(state);
        uint status = NetLocalGroupAddMembers(null, LookupName(UsersSid), 0, ref member, 1);
        if (status != 1378) Net(status, "NetLocalGroupAddMembers");
      }
      finally { Marshal.FreeHGlobal(sid); }
      VerifyOwnedAccount(state, true);
      CorePolicy.Require(state.account.groups.Count == 1 && state.account.groups[0] == UsersSid, "New account is not Users-only");
    }

    public override void CreateFreshProfile(FixtureState state)
    {
      VerifyOwnedAccount(state, true);
      CorePolicy.Require(state.accountBound && state.accountCreated && state.accountDisabled && !state.profileCreated
        && state.profileCreationAttempts == 1 && state.profileCreationUncertain && !state.profileOwnershipProven
        && state.profileCreationTokenOwner == null && state.profileCreationIdentity == null && state.profileCreationPin == null
        && !state.profileCreationSucceeded
        && state.account.groups.Count == 1 && state.account.groups[0] == UsersSid, "Profile creation precondition failed");
      StringBuilder path = new StringBuilder(32768);
      string callTokenOwner = RecordCreateProfileDiagnostics(state, path, "before");
      CorePolicy.Require(!OwnProfileRegistration(state, false) && HivesAbsent(state) && !HasOwnedSidProcesses(state),
        "Fresh SID already has profile state or a process");
      Real(state);
      // Allocation and P/Invoke ABI stay unchanged. 260 is the one-factor
      // diagnostic candidate, not a claimed documented CreateProfile limit.
      // Controller durably armed uncertainty before entering this method.
      state.profileCreationUncertain = true;
      state.profileCreationTokenOwner = callTokenOwner;
      state.report.trace.Add("CreateProfile call-entered; calls=1; UTC=" + DateTime.UtcNow.ToString("o"));
      int status = CreateProfile(state.account.sid, state.sam, path, 260u);
      state.report.trace.Add("CreateProfile returned HRESULT=" + status.ToString(CultureInfo.InvariantCulture)
        + "; hex=" + unchecked((uint)status).ToString("x8", CultureInfo.InvariantCulture) + "; UTC=" + DateTime.UtcNow.ToString("o")
        + "; outputLength=" + path.Length.ToString(CultureInfo.InvariantCulture) + "; outputSha256=" + CorePolicy.HashText(path.ToString()));
      if (status == 0)
      {
        state.profileCreated = true;
        state.profileCreationSucceeded = true;
        if (state.report != null) state.report.realProfilesCreated++;
      }
      try { OwnProfileRegistration(state, false); RecordCreateProfileDiagnostics(state, path, "after"); }
      catch (Exception error)
      {
        state.report.trace.Add("CreateProfile after-diagnostics failed: " + SafeFailure(error));
        if (status == 0) throw;
      }
      CorePolicy.Require(status == 0, "CreateProfile failed (HRESULT " + status.ToString(CultureInfo.InvariantCulture) + ")");
      CorePolicy.Require(path.Length > 0 && path.Length < 260, "CreateProfile returned an unbounded path");
      state.profilePath = path.ToString();
      CorePolicy.ValidateAbsolutePath(state.profilePath);
      ProfileDirectoryPin pin = new ProfileDirectoryPin(state.profilePath);
      state.profileCreationPin = pin;
      state.profileIdentity = CopyProfileIdentity(pin.initial.identity);
      state.profileCreationIdentity = CopyProfileIdentity(pin.initial.identity);
      AssertOwnedProfileMetadata(state, pin);
      CorePolicy.Require(OwnProfileRegistration(state, true, pin.initial.ownerSid == "S-1-5-32-544") && HivesAbsent(state) && !HasOwnedSidProcesses(state),
        "Created profile SID path hive or process boundary is unproven");
      VerifyOwnedAccount(state, true);
      pin.VerifyUnchanged();
      state.profileOwnershipProven = true;
      state.profileCreationUncertain = false;
      state.report.trace.Add("CreateProfile owner-path-hive-process-boundary=proven; no profile lease was loaded");
    }

    private static void ProfileTrace(FixtureState state, string text)
    {
      CorePolicy.Require(state.report != null && text != null && text.Length <= 1800
        && text.IndexOfAny(new char[] { '\0', '\r', '\n' }) < 0, "Bounded CreateProfile diagnostic row required");
      state.report.trace.Add("CreateProfile diagnostic " + text);
    }

    private void RecordProfileModule(FixtureState state, string name, string expectedPath, bool exports)
    {
      CorePolicy.Require(new FileInfo(expectedPath).Length <= 64 * 1024 * 1024, "Bounded system module diagnostic required");
      FileIdentity expected = IdentifyPath(expectedPath, false);
      FileVersionInfo version = FileVersionInfo.GetVersionInfo(expected.canonicalPath);
      ProfileTrace(state, "module=" + name + "; systemPath=" + expected.canonicalPath + "; sha256=" + expected.sha256
        + "; version=" + version.FileMajorPart + "." + version.FileMinorPart + "." + version.FileBuildPart + "." + version.FilePrivatePart);
      IntPtr module;
      if (!GetModuleHandleExW(0, expectedPath, out module))
      {
        int error = Marshal.GetLastWin32Error();
        CorePolicy.Require(error == 126, "Loaded module metadata query failed");
        ProfileTrace(state, "module=" + name + "; loaded=false; export-candidates=not_observed");
        return;
      }
      try
      {
        StringBuilder actual = new StringBuilder(32768);
        uint length = GetModuleFileNameW(module, actual, (uint)actual.Capacity);
        Win(length > 0 && length < actual.Capacity, "GetModuleFileNameW profile diagnostics");
        FileIdentity loaded = IdentifyPath(actual.ToString(), false);
        CorePolicy.Require(!loaded.reparse && loaded.fileId == expected.fileId && loaded.volumePath == expected.volumePath
          && loaded.sha256 == expected.sha256 && CorePolicy.SamePath(loaded.canonicalPath, expected.canonicalPath), "Loaded profile module identity differs from system file");
        ProfileTrace(state, "module=" + name + "; loaded=true; exact-system-file=true");
        if (exports)
          ProfileTrace(state, "module=userenv; CreateProfile-present=" + (GetProcAddress(module, "CreateProfile") != IntPtr.Zero)
            + "; CreateProfileW-present=" + (GetProcAddress(module, "CreateProfileW") != IntPtr.Zero)
            + "; actual-marshalling-stub-target=not_observed");
      }
      finally { Win(FreeLibrary(module), "Release existing profile module reference"); }
    }

    private string RecordProfileToken(FixtureState state, IntPtr token, string kind)
    {
      TokenIdentity identity = InspectToken(token);
      IntPtr ownerBuffer = TokenBuffer(token, 4); // TOKEN_OWNER, not TokenUser.
      string owner;
      try { owner = Sid(Marshal.ReadIntPtr(ownerBuffer)); }
      finally { Marshal.FreeHGlobal(ownerBuffer); }
      ProfileTrace(state, "token=" + kind + "; sidSha256=" + CorePolicy.HashText(identity.sid) + "; type=" + identity.tokenType
        + "; integrityRid=" + identity.integrityRid + "; elevated=" + identity.elevated + "; elevationType=" + identity.elevationType
        + "; session=" + identity.sessionId + "; authenticationIdSha256=" + CorePolicy.HashText(identity.authenticationId)
        + "; ownerSidSha256=" + CorePolicy.HashText(owner) + "; ownerEqualsTokenUser=" + (owner == identity.sid));
      IntPtr buffer = TokenBuffer(token, 3);
      try
      {
        int count = Marshal.ReadInt32(buffer);
        CorePolicy.Require(count >= 0 && count < 4096, "Bounded profile token privilege count required");
        Dictionary<string, uint> attributes = new Dictionary<string, uint>(StringComparer.Ordinal);
        int offset = Marshal.OffsetOf(typeof(TokenPrivilegesOne), "Privilege").ToInt32();
        int stride = Marshal.SizeOf(typeof(LuidAttributes));
        for (int i = 0; i < count; i++)
        {
          LuidAttributes value = (LuidAttributes)Marshal.PtrToStructure(IntPtr.Add(buffer, offset + i * stride), typeof(LuidAttributes));
          StringBuilder name = new StringBuilder(256); uint characters = 256;
          Win(LookupPrivilegeNameW(null, ref value.Luid, name, ref characters), "LookupPrivilegeNameW profile diagnostics");
          if (name.ToString() == "SeBackupPrivilege" || name.ToString() == "SeRestorePrivilege" || name.ToString() == "SeImpersonatePrivilege")
            attributes.Add(name.ToString(), value.Attributes);
        }
        foreach (string name in new string[] { "SeBackupPrivilege", "SeRestorePrivilege", "SeImpersonatePrivilege" })
          ProfileTrace(state, "token=" + kind + "; privilege=" + name + "; attributes="
            + (attributes.ContainsKey(name) ? attributes[name].ToString(CultureInfo.InvariantCulture) : "absent"));
      }
      finally { Marshal.FreeHGlobal(buffer); }
      return owner;
    }

    private string RecordCreateProfileDiagnostics(FixtureState state, StringBuilder path, string phase)
    {
      Real(state);
      ProfileTrace(state, "phase=" + phase + "; os=" + Environment.OSVersion.Version + "; clr=" + Environment.Version
        + "; runtime=" + RuntimeEnvironment.GetSystemVersion() + "; processBits=" + (IntPtr.Size * 8)
        + "; os64=" + Environment.Is64BitOperatingSystem);
      foreach (string name in new string[] { "ImageOS", "ImageVersion" })
      {
        string value = Environment.GetEnvironmentVariable(name);
        CorePolicy.Require(value == null || value.Length <= 256, "Bounded image diagnostic required");
        ProfileTrace(state, "imageField=" + name + "; length=" + (value == null ? 0 : value.Length)
          + "; sha256=" + (value == null ? "absent" : CorePolicy.HashText(value)));
      }
      RecordProfileModule(state, "userenv", Path.Combine(Environment.SystemDirectory, "userenv.dll"), true);
      RecordProfileModule(state, "clr", Path.Combine(RuntimeEnvironment.GetRuntimeDirectory(), "clr.dll"), false);
      RecordProfileModule(state, "mscorlib", typeof(object).Module.FullyQualifiedName, false);
      IntPtr token;
      Win(OpenProcessToken(GetCurrentProcess(), TokenQuery, out token), "OpenProcessToken profile diagnostics");
      string effectiveOwner, effectiveSource = "process";
      try { effectiveOwner = RecordProfileToken(state, token, "process"); }
      finally { Win(CloseHandle(token), "Close process diagnostic token"); }
      bool threadToken = OpenThreadToken(GetCurrentThread(), TokenQuery, true, out token);
      int threadError = threadToken ? 0 : Marshal.GetLastWin32Error();
      if (threadToken)
      {
        try { effectiveOwner = RecordProfileToken(state, token, "thread"); effectiveSource = "thread"; }
        finally { Win(CloseHandle(token), "Close thread diagnostic token"); }
      }
      else
      {
        ProfileTrace(state, "token=thread; present=false; Win32=" + threadError);
        CorePolicy.Require(threadError == 1008, "Thread token state is unknown");
      }
      ProfileTrace(state, "effective-token-owner; phase=" + phase + "; source=" + effectiveSource
        + "; sidSha256=" + CorePolicy.HashText(effectiveOwner) + "; observation-only=true");
      IntPtr manager = OpenSCManagerW(null, null, 1);
      Win(manager != IntPtr.Zero, "OpenSCManagerW read-only profile diagnostics");
      try
      {
        IntPtr service = OpenServiceW(manager, "ProfSvc", 4);
        Win(service != IntPtr.Zero, "OpenServiceW read-only profile diagnostics");
        try
        {
          ServiceStatusProcess status; uint needed;
          Win(QueryServiceStatusEx(service, 0, out status, (uint)Marshal.SizeOf(typeof(ServiceStatusProcess)), out needed), "QueryServiceStatusEx profile diagnostics");
          ProfileTrace(state, "service=ProfSvc; state=" + status.state + "; win32Exit=" + status.win32Exit
            + "; serviceExit=" + status.serviceExit + "; checkpoint=" + status.checkpoint + "; waitHint=" + status.waitHint);
        }
        finally { Win(CloseServiceHandle(service), "Close queried profile service"); }
      }
      finally { Win(CloseServiceHandle(manager), "Close queried service manager"); }
      CorePolicy.Require(state.account.sid.IndexOf('\0') < 0 && state.sam.IndexOf('\0') < 0, "CreateProfile input contains NUL");
      ProfileTrace(state, "sidLength=" + state.account.sid.Length + "; sidSha256=" + CorePolicy.HashText(state.account.sid)
        + "; samLength=" + state.sam.Length + "; samSha256=" + CorePolicy.HashText(state.sam) + "; inputsNoNul=true"
        + "; StringBuilderLength=" + path.Length + "; StringBuilderCapacity=" + path.Capacity + "; passedCch=260");
      return effectiveOwner;
    }

    internal static string FreshProfileIdentityRelation(FileIdentity expected, FileIdentity observed)
    {
      if (expected == null || observed == null) return "missing";
      if (expected.reparse || observed.reparse) return "reparse";
      if (!expected.directory || !observed.directory) return "not-directory";
      if (String.IsNullOrEmpty(expected.fileId) || String.IsNullOrEmpty(expected.volumePath)) return "unproven";
      if (expected.fileId != observed.fileId) return "file-id-differs";
      if (expected.volumePath != observed.volumePath) return "volume-differs";
      return CorePolicy.SamePath(expected.canonicalPath, observed.canonicalPath) ? "same-identity" : "canonical-path-differs";
    }

    internal static void RequireBothProfileMappings(int matchedViews)
    {
      CorePolicy.Require(matchedViews == 3, "Both own SID profile registrations must match");
    }

    internal static string ProfileOwnerObservation(string owner, string boundSid, string callTokenOwner, string runnerSid)
    {
      CorePolicy.Require(owner == null || owner.Length <= 184, "Bounded profile owner diagnostic required");
      return "profile-owner; present=" + !String.IsNullOrEmpty(owner)
        + "; sidSha256=" + (String.IsNullOrEmpty(owner) ? "absent" : CorePolicy.HashText(owner))
        + "; equalsBoundSid=" + (!String.IsNullOrEmpty(owner) && owner == boundSid)
        + "; equalsSystem=" + (owner == "S-1-5-18") + "; equalsAdministrators=" + (owner == "S-1-5-32-544")
        + "; equalsTrustedInstaller=" + (owner == TrustedInstallerSid)
        + "; equalsCallTokenOwner=" + (!String.IsNullOrEmpty(owner) && owner == callTokenOwner)
        + "; equalsRunner=" + (!String.IsNullOrEmpty(owner) && owner == runnerSid) + "; observation-only=true";
    }

    internal static void RequireFreshProfileOwner(string owner, string boundSid)
    {
      CorePolicy.Require(!String.IsNullOrEmpty(boundSid) && (owner == boundSid || owner == "S-1-5-18"),
        "Fresh profile owner is not the bound SID or SYSTEM");
    }

    internal sealed class ProfileDiagnosticAce
    {
      internal string sid;
      internal int accessMask;
      internal bool allow, unclassified;
      internal bool inheritOnly;
    }

    internal sealed class ProfileDirectoryMetadata
    {
      internal FileIdentity identity;
      internal string ownerSid, descriptorSha256;
      internal bool daclPresent, protectedDacl;
      internal int aclRevision;
      internal IList<ProfileDiagnosticAce> aces;
    }

    internal static void RequireSameProfileMetadata(ProfileDirectoryMetadata expected, ProfileDirectoryMetadata current)
    {
      CorePolicy.Require(expected != null && current != null
        && FreshProfileIdentityRelation(expected.identity, current.identity) == "same-identity"
        && !String.IsNullOrEmpty(expected.ownerSid) && expected.ownerSid == current.ownerSid
        && expected.descriptorSha256 != null && expected.descriptorSha256.Length == 64
        && expected.descriptorSha256 == current.descriptorSha256, "Profile same-handle identity owner or DACL changed");
    }

    internal static void RequireTrustedProfileDacl(ProfileDirectoryMetadata metadata, string boundSid, bool parent)
    {
      RequireTrustedProfileDaclCore(metadata, boundSid, parent, null);
    }

    internal static void RequireTrustedProfileAncestorDacl(ProfileDirectoryMetadata metadata, string boundSid,
      string profilesDirectory, string directory, FileIdentity profilesIdentity)
    {
      CorePolicy.Require(metadata != null && metadata.identity != null && profilesIdentity != null
        && profilesIdentity.directory && !profilesIdentity.reparse && !String.IsNullOrEmpty(profilesIdentity.fileId)
        && !String.IsNullOrEmpty(profilesIdentity.volumePath)
        && CorePolicy.SamePath(profilesIdentity.canonicalPath, profilesDirectory), "OS ProfilesDirectory identity is unproven");
      CorePolicy.ValidateProfileAncestorPath(metadata.identity.canonicalPath, profilesDirectory, directory);
      CorePolicy.Require(metadata.identity.directory && !metadata.identity.reparse && !String.IsNullOrEmpty(metadata.identity.fileId)
        && metadata.identity.volumePath == profilesIdentity.volumePath, "Profile ancestor identity or volume is unproven");
      RequireTrustedProfileDaclCore(metadata, boundSid, true, profilesIdentity);
    }

    private static void RequireTrustedProfileDaclCore(ProfileDirectoryMetadata metadata, string boundSid, bool parent, FileIdentity profilesIdentity)
    {
      CorePolicy.Require(metadata != null && metadata.daclPresent && metadata.aces != null
        && metadata.aces.Count > 0 && metadata.aces.Count <= 128 && (metadata.aclRevision == 2 || metadata.aclRevision == 4)
        && (parent || metadata.protectedDacl), "Profile DACL is absent unprotected or unbounded");
      // Only the ancestor entry point supplies a real OS ProfilesDirectory
      // identity. A profile pin or ordinary DACL check has no such role.
      bool trustedInstallerRoot = parent && profilesIdentity != null && metadata.identity != null
        && metadata.ownerSid == TrustedInstallerSid && metadata.identity.canonicalPath != null
        && metadata.identity.canonicalPath.Length == 3
        && CorePolicy.SamePath(metadata.identity.canonicalPath, profilesIdentity.canonicalPath.Substring(0, 3))
        && metadata.identity.volumePath == profilesIdentity.volumePath;
      // A parent may grant creation of a different subdirectory (APPEND_DATA),
      // but cannot grant replacement/rename, metadata or permission mutation.
      uint mutations = parent ? ParentMutationMask : ProfileMutationMask;
      foreach (ProfileDiagnosticAce ace in metadata.aces)
      {
        CorePolicy.Require(ace != null && !String.IsNullOrEmpty(ace.sid) && !ace.unclassified && (unchecked((uint)ace.accessMask) & ~KnownProfileFileRights) == 0,
          "Profile DACL has an unknown ACE or access mask");
        bool trusted = ace.sid == boundSid || ace.sid == "S-1-5-18" || ace.sid == "S-1-5-32-544"
          || (trustedInstallerRoot && ace.sid == TrustedInstallerSid);
        // Inherit-only writes remain dangerous inside the profile. They do not
        // grant rights on this parent itself; the profile DACL is protected.
        CorePolicy.Require(!ace.allow || trusted || (parent && ace.inheritOnly)
          || (unchecked((uint)ace.accessMask) & mutations) == 0, "Profile path has a nontrusted mutation allow ACE");
      }
      if (parent) CorePolicy.Require(metadata.ownerSid == boundSid || metadata.ownerSid == "S-1-5-18"
        || metadata.ownerSid == "S-1-5-32-544" || trustedInstallerRoot, "Profile parent has a nontrusted owner");
    }

    internal static void RequireFreshProfileOwner(string owner, string boundSid, string creationTokenOwner,
      bool creationSucceeded, ProfileDirectoryMetadata metadata)
    {
      CorePolicy.Require(!String.IsNullOrEmpty(boundSid) && metadata != null && metadata.ownerSid == owner,
        "Profile owner security descriptor binding is missing");
      if (owner == boundSid || owner == "S-1-5-18") { RequireFreshProfileOwner(owner, boundSid); return; }
      CorePolicy.Require(owner == "S-1-5-32-544" && creationTokenOwner == "S-1-5-32-544" && creationSucceeded,
        "Fresh profile owner is not the bound SID SYSTEM or proven creation TokenOwner");
      RequireTrustedProfileDacl(metadata, boundSid, false);
    }

    private sealed class ProfileDirectoryPin : IDisposable
    {
      private IntPtr handle;
      private readonly string path;
      private readonly string ancestorProfilesDirectory, ancestorDirectory;
      internal readonly ProfileDirectoryMetadata initial;

      internal ProfileDirectoryPin(string path) : this(path, null, null) { }

      internal static ProfileDirectoryPin OpenAncestor(string path, string profilesDirectory, string directory)
      {
        return new ProfileDirectoryPin(path, profilesDirectory, directory);
      }

      private ProfileDirectoryPin(string path, string profilesDirectory, string directory)
      {
        if (profilesDirectory == null) CorePolicy.ValidateAbsolutePath(path);
        else CorePolicy.ValidateProfileAncestorPath(path, profilesDirectory, directory);
        this.path = path;
        ancestorProfilesDirectory = profilesDirectory; ancestorDirectory = directory;
        CorePolicy.Require(!HasReparseComponent(path), "Profile pin ancestor is a reparse point");
        handle = CreateFileW(path, 0x20081, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
        CorePolicy.Require(handle != new IntPtr(-1), "Open noninherited no-follow profile pin failed");
        try
        {
          uint flags; Win(GetHandleInformation(handle, out flags), "Get profile pin flags");
          CorePolicy.Require((flags & 1) == 0, "Profile pin is inheritable");
          initial = Read();
        }
        catch { Dispose(); throw; }
      }

      private ProfileDirectoryMetadata Read()
      {
        CorePolicy.Require(handle != IntPtr.Zero && handle != new IntPtr(-1), "Profile pin is closed");
        FileIdentity identity = ReadHandleIdentity(handle, true, HasReparseComponent(path));
        CorePolicy.Require(!identity.reparse && CorePolicy.SamePath(identity.canonicalPath, path), "Profile pin path or reparse boundary changed");
        IntPtr owner, group, dacl, sacl, descriptor = IntPtr.Zero;
        uint status = GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out descriptor);
        try
        {
          CorePolicy.Require(status == 0 && descriptor != IntPtr.Zero && IsValidSecurityDescriptor(descriptor), "Profile GetSecurityInfo descriptor is unproven");
          uint length = GetSecurityDescriptorLength(descriptor);
          CorePolicy.Require(length >= 20 && length <= 65536, "Profile security descriptor is unbounded");
          byte[] bytes = new byte[(int)length]; Marshal.Copy(descriptor, bytes, 0, bytes.Length);
          RawSecurityDescriptor security = new RawSecurityDescriptor(bytes, 0);
          CorePolicy.Require((security.ControlFlags & ControlFlags.SelfRelative) != 0 && security.Owner != null, "Profile descriptor owner or format is missing");
          RawAcl acl = security.DiscretionaryAcl;
          CorePolicy.Require(acl == null || acl.Count <= 128, "Profile DACL ACE count is unbounded");
          List<ProfileDiagnosticAce> aces = acl == null ? null : new List<ProfileDiagnosticAce>();
          if (acl != null) foreach (GenericAce raw in acl)
          {
            QualifiedAce ace = raw as QualifiedAce;
            aces.Add(new ProfileDiagnosticAce { sid = ace == null ? null : ace.SecurityIdentifier.Value,
              accessMask = ace == null ? 0 : ace.AccessMask, allow = ace != null && ace.AceQualifier == AceQualifier.AccessAllowed,
              inheritOnly = (raw.AceFlags & AceFlags.InheritOnly) != 0,
              unclassified = !(raw is CommonAce) || ace == null || ace.IsCallback
                || (ace.AceQualifier != AceQualifier.AccessAllowed && ace.AceQualifier != AceQualifier.AccessDenied)
                || (unchecked((uint)raw.AceFlags) & ~0x1fu) != 0 });
          }
          byte[] canonical = new byte[security.BinaryLength]; security.GetBinaryForm(canonical, 0);
          string hash;
          using (System.Security.Cryptography.SHA256 algorithm = System.Security.Cryptography.SHA256.Create()) hash = CorePolicy.Hex(algorithm.ComputeHash(canonical));
          return new ProfileDirectoryMetadata { identity = identity, ownerSid = security.Owner.Value,
            descriptorSha256 = hash, daclPresent = (security.ControlFlags & ControlFlags.DiscretionaryAclPresent) != 0,
            protectedDacl = (security.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0,
            aclRevision = acl == null ? 0 : acl.Revision, aces = aces };
        }
        finally { if (descriptor != IntPtr.Zero) CorePolicy.Require(LocalFree(descriptor) == IntPtr.Zero, "Release profile security descriptor failed"); }
      }

      internal void VerifyUnchanged()
      {
        ProfileDirectoryMetadata current = Read();
        RequireSameProfileMetadata(initial, current);
      }

      internal void RequireTrustedParentDacl(string boundSid, FileIdentity profilesIdentity)
      {
        CorePolicy.Require(ancestorProfilesDirectory != null && ancestorDirectory != null, "Profile pin has no readonly ancestor role");
        RequireTrustedProfileAncestorDacl(initial, boundSid, ancestorProfilesDirectory, ancestorDirectory, profilesIdentity);
      }

      public void Dispose()
      {
        IntPtr close = handle; handle = IntPtr.Zero;
        if (close != IntPtr.Zero && close != new IntPtr(-1)) Win(CloseHandle(close), "Close profile metadata pin");
      }
    }

    private static FileIdentity CopyProfileIdentity(FileIdentity identity)
    {
      return new FileIdentity { canonicalPath = identity.canonicalPath, volumePath = identity.volumePath,
        fileId = identity.fileId, directory = identity.directory, reparse = identity.reparse, bytes = identity.bytes, sha256 = identity.sha256 };
    }

    private static string ReadProfilesDirectory()
    {
      uint characters = 32768; StringBuilder path = new StringBuilder((int)characters);
      Win(GetProfilesDirectoryW(path, ref characters), "GetProfilesDirectoryW");
      string directory = path.ToString();
      CorePolicy.Require(characters > 0 && characters <= path.Capacity, "ProfilesDirectory query is unbounded");
      CorePolicy.ValidateAbsolutePath(directory);
      return directory;
    }

    private void RequireTrustedProfileParents(FixtureState state)
    {
      string profiles = ReadProfilesDirectory();
      string directory = Path.GetDirectoryName(state.profileCreationIdentity.canonicalPath);
      string[] parents = CorePolicy.ProfileParentPaths(profiles, directory);
      using (ProfileDirectoryPin profilesPin = ProfileDirectoryPin.OpenAncestor(profiles, profiles, profiles))
      {
        foreach (string parent in parents)
        {
          using (ProfileDirectoryPin pin = ProfileDirectoryPin.OpenAncestor(parent, profiles, directory))
          {
            pin.RequireTrustedParentDacl(state.account.sid, profilesPin.initial.identity);
            pin.VerifyUnchanged();
          }
        }
        profilesPin.VerifyUnchanged();
      }
      ProfileTrace(state, "profile-parent-mutation-boundary=proven; depth=" + parents.Length);
    }

    internal static string ProfileDaclObservation(bool present, bool protectedDacl, IList<ProfileDiagnosticAce> aces, string boundSid)
    {
      string prefix = "profile-dacl; present=" + present + "; protected=" + protectedDacl
        + "; aceCount=" + (aces == null ? "null" : aces.Count.ToString(CultureInfo.InvariantCulture));
      if (!present || aces == null || aces.Count > 128)
        return prefix + "; scan=unproven; nontrustedAllowWrite=unknown; observation-only=true";
      int nontrustedWrites = 0, unclassified = 0;
      foreach (ProfileDiagnosticAce ace in aces)
      {
        if (ace == null || ace.unclassified) unclassified++;
        // Conservative allow-ACE classification, not an effective access check.
        // Deny/inherit-only/callback ACEs cannot establish a cleanup lease.
        bool trustedWriter = ace != null && !String.IsNullOrEmpty(ace.sid)
          && (ace.sid == boundSid || ace.sid == "S-1-5-18" || ace.sid == "S-1-5-32-544");
        if (ace != null && ace.allow && (unchecked((uint)ace.accessMask) & ProfileMutationMask) != 0 && !trustedWriter) nontrustedWrites++;
      }
      return prefix + "; scan=bounded; nontrustedAllowWrite=" + nontrustedWrites.ToString(CultureInfo.InvariantCulture)
        + "; unclassifiedAces=" + unclassified.ToString(CultureInfo.InvariantCulture)
        + "; writeClassification=" + (unclassified != 0 ? "unproven" : nontrustedWrites != 0 ? "nontrusted-allow-present" : "no-nontrusted-allow-observed")
        + "; writerClassification=bound-system-administrators; observation-only=true";
    }

    internal static IList<string> ProfileAceObservations(ProfileDirectoryMetadata metadata, string boundSid)
    {
      List<string> rows = new List<string>();
      if (metadata == null || metadata.aces == null || metadata.aces.Count > 128)
      {
        rows.Add("ace-scan=unproven; unknown=true");
        return rows;
      }
      for (int index = 0; index < metadata.aces.Count; index++)
      {
        ProfileDiagnosticAce ace = metadata.aces[index];
        string sid = ace == null ? null : ace.sid;
        bool boundedSid = !String.IsNullOrEmpty(sid) && sid.Length <= 184;
        string sidClass = !boundedSid ? "unknown" : sid == boundSid ? "bound" : sid == "S-1-5-18" ? "system"
          : sid == "S-1-5-32-544" ? "administrators" : sid == TrustedInstallerSid ? "trusted-installer" : "other";
        uint mask = ace == null ? 0u : unchecked((uint)ace.accessMask);
        bool unknown = ace == null || !boundedSid || ace.unclassified || (mask & ~KnownProfileFileRights) != 0;
        rows.Add("ace=" + index.ToString(CultureInfo.InvariantCulture)
          + "; sidSha256=" + (boundedSid ? CorePolicy.HashText(sid) : "unproven") + "; class=" + sidClass
          + "; mask=" + mask.ToString("x8", CultureInfo.InvariantCulture)
          + "; kind=" + (ace == null || ace.unclassified ? "unknown" : ace.allow ? "allow" : "deny")
          + "; inheritOnly=" + (ace != null && ace.inheritOnly)
          + "; parentMutation=" + (mask & ParentMutationMask).ToString("x8", CultureInfo.InvariantCulture)
          + "; profileMutation=" + (mask & ProfileMutationMask).ToString("x8", CultureInfo.InvariantCulture)
          + "; parentApplies=" + (ace != null && ace.allow && !ace.inheritOnly) + "; unknown=" + unknown);
      }
      return rows;
    }

    private void RecordFreshProfileMetadata(FixtureState state, ProfileDirectoryMetadata metadata, string callTokenOwner)
    {
      ProfileTrace(state, ProfileOwnerObservation(metadata.ownerSid, state.account.sid, callTokenOwner, state.runnerSid));
      ProfileTrace(state, ProfileDaclObservation(metadata.daclPresent, metadata.protectedDacl, metadata.aces, state.account.sid));
      try
      {
        bool present = OwnProfileRegistration(state, true);
        ProfileTrace(state, "ownSID-mapping-observation; present=" + present + "; leaseGranted=false");
      }
      catch (Exception error) { ProfileTrace(state, "ownSID-mapping-observation; identity=unproven; hResult=" + error.HResult.ToString(CultureInfo.InvariantCulture)); }
      ProfileTrace(state, "profile-metadata-identity; relation=" + FreshProfileIdentityRelation(state.profileCreationIdentity, metadata.identity) + "; leaseGranted=false");
    }

    private bool OwnProfileRegistration(FixtureState state, bool match, bool requireBoth = false)
    {
      Real(state); bool present = false; int matchedViews = 0;
      CorePolicy.Require(!requireBoth || match, "Dual profile registration proof requires identities");
      foreach (RegistryView view in new RegistryView[] { RegistryView.Registry32, RegistryView.Registry64 })
      using (RegistryKey machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
      using (RegistryKey key = machine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + state.account.sid, false))
      {
        ProfileTrace(state, "ownSID-ProfileList; view=" + (int)view + "; present=" + (key != null));
        if (key == null) continue;
        present = true;
        object raw = key.GetValue("ProfileImagePath", null, RegistryValueOptions.DoNotExpandEnvironmentNames);
        string registered = raw as string;
        ProfileTrace(state, "ownSID-ProfileList; view=" + (int)view + "; pathString=" + (registered != null)
          + "; pathLength=" + (registered == null ? 0 : registered.Length)
          + "; pathSha256=" + (registered == null || registered.Length >= 800 ? "unproven" : CorePolicy.HashText(registered)));
        if (!match) continue;
        CorePolicy.Require(registered != null && registered.Length < 800 && registered.IndexOf('%') < 0, "Own SID profile registration path is unproven");
        CorePolicy.ValidateAbsolutePath(registered);
        FileIdentity identity;
        if (requireBoth) using (ProfileDirectoryPin mapping = new ProfileDirectoryPin(registered))
        {
          identity = CopyProfileIdentity(mapping.initial.identity);
          mapping.VerifyUnchanged();
        }
        else identity = IdentifyPath(registered, true);
        string relation = FreshProfileIdentityRelation(state.profileIdentity, identity);
        ProfileTrace(state, "ownSID-ProfileList; view=" + (int)view + "; pathSha256=" + CorePolicy.HashText(identity.canonicalPath)
          + "; identityRelation=" + relation + "; exact-returned-file-identity=" + (relation == "same-identity"));
        CorePolicy.Require(relation == "same-identity", "Own SID profile registration differs from returned profile");
        matchedViews |= view == RegistryView.Registry32 ? 1 : 2;
      }
      if (requireBoth) RequireBothProfileMappings(matchedViews);
      return present;
    }

    private void AssertOwnedProfileMetadata(FixtureState state, ProfileDirectoryPin pin)
    {
      FileIdentity identity = pin.initial.identity;
      CorePolicy.Require(state.profileCreationSucceeded && state.profileCreationIdentity != null
        && FreshProfileIdentityRelation(state.profileCreationIdentity, identity) == "same-identity"
        && FreshProfileIdentityRelation(state.profileIdentity, identity) == "same-identity", "Original created profile identity is unproven");
      CorePolicy.Require(identity != null && identity.directory && !identity.reparse && !String.IsNullOrEmpty(identity.fileId)
        && !String.IsNullOrEmpty(identity.volumePath), "Fresh profile canonical identity is unproven");
      string leaf = Path.GetFileName(identity.canonicalPath.TrimEnd('\\'));
      CorePolicy.Require(String.Equals(leaf, state.sam, StringComparison.OrdinalIgnoreCase)
        || leaf.StartsWith(state.sam + ".", StringComparison.OrdinalIgnoreCase), "Fresh profile path lacks the owned unpredictable account basename");
      foreach (string forbidden in new string[] { state.spec.gitRoot, state.spec.sourceRoot, state.spec.controllerRoot })
        CorePolicy.Require(!CorePolicy.SamePath(identity.canonicalPath, forbidden) && !CorePolicy.IsInside(forbidden, identity.canonicalPath)
          && !CorePolicy.IsInside(identity.canonicalPath, forbidden), "Fresh profile intersects another fixture boundary");
      string owner = pin.initial.ownerSid;
      RecordFreshProfileMetadata(state, pin.initial, state.profileCreationTokenOwner);
      RequireFreshProfileOwner(owner, state.account.sid, state.profileCreationTokenOwner, state.profileCreationSucceeded, pin.initial);
      if (owner == "S-1-5-32-544")
      {
        RequireTrustedProfileParents(state);
        CorePolicy.Require(OwnProfileRegistration(state, true, true), "Both own SID profile registrations are unproven");
      }
      pin.VerifyUnchanged();
      ProfileTrace(state, "profile-fileIdSha256=" + CorePolicy.HashText(identity.volumePath + "\n" + identity.fileId)
        + "; pathSha256=" + CorePolicy.HashText(identity.canonicalPath) + "; ownerSidSha256=" + CorePolicy.HashText(owner)
        + "; owner-proof=" + (owner == "S-1-5-32-544" ? "creation-token-administrators" : "bound-or-system") + "; reparse=false");
    }

    public override void SetOwnedAccountDisabled(FixtureState state, bool disabled)
    {
      if (!disabled) HistoricalController(state);
      VerifyOwnedAccount(state, state.accountDisabled);
      UserFlags flags = new UserFlags { flags = disabled ? state.account.flags | AccountDisabled : state.account.flags & ~AccountDisabled };
      uint parameter;
      Real(state);
      Net(NetUserSetInfo(null, state.sam, 1008, ref flags, out parameter), "NetUserSetInfo");
      state.accountDisabled = disabled;
      VerifyOwnedAccount(state, disabled);
    }

    public override void Logon(FixtureState state, SecretBuffer password)
    {
      HistoricalController(state);
      VerifyOwnedAccount(state, false);
      CorePolicy.Require(state.profileCreated && state.token == IntPtr.Zero && password.Pointer != IntPtr.Zero, "Logon precondition failed");
      IntPtr token;
      Real(state);
      Win(LogonUserW(state.sam, ".", password.Pointer, 2, 0, out token), "LogonUserW");
      state.token = token;
      state.targetIdentity = InspectToken(token);
      CorePolicy.Require(state.targetIdentity.sid == state.account.sid, "Logon returned a different SID");
    }

    private sealed class PrivilegeScope : IDisposable
    {
      private IntPtr token;
      private readonly List<TokenPrivilegesOne> previous = new List<TokenPrivilegesOne>();

      public PrivilegeScope(NativePlatform platform)
      {
        Win(OpenProcessToken(GetCurrentProcess(), TokenQuery | TokenAdjustPrivileges, out token), "OpenProcessToken privileges");
        try
        {
          TokenIdentity identity = platform.InspectToken(token);
          foreach (string name in new string[] { "SeBackupPrivilege", "SeRestorePrivilege", "SeImpersonatePrivilege" })
          {
            CorePolicy.Require(identity.privileges.Contains(name), "An already-assigned Controller privilege is missing");
            Luid luid;
            Win(LookupPrivilegeValueW(null, name, out luid), "LookupPrivilegeValueW");
            TokenPrivilegesOne requested = new TokenPrivilegesOne { Count = 1, Privilege = new LuidAttributes { Luid = luid, Attributes = 2 } };
            TokenPrivilegesOne old;
            uint returned;
            Win(AdjustTokenPrivileges(token, false, ref requested, (uint)Marshal.SizeOf(typeof(TokenPrivilegesOne)), out old, out returned), "AdjustTokenPrivileges");
            CorePolicy.Require(Marshal.GetLastWin32Error() == 0, "Controller privilege was not assigned");
            if (old.Count != 0) previous.Add(old);
          }
        }
        catch { Dispose(); throw; }
      }

      public void Dispose()
      {
        if (token == IntPtr.Zero) return;
        Exception failure = null;
        for (int i = previous.Count - 1; i >= 0; i--)
        {
          try
          {
            TokenPrivilegesOne old = previous[i], ignored;
            uint returned;
            Win(AdjustTokenPrivileges(token, false, ref old, (uint)Marshal.SizeOf(typeof(TokenPrivilegesOne)), out ignored, out returned), "Restore Controller privilege");
            CorePolicy.Require(Marshal.GetLastWin32Error() == 0, "Controller privilege restoration incomplete");
          }
          catch (Exception error) { if (failure == null) failure = error; }
        }
        CloseHandle(token); token = IntPtr.Zero;
        if (failure != null) throw failure;
      }
    }

    private static DirectorySecurity PrivateDirectorySecurity(string controllerSid, string readSid)
    {
      DirectorySecurity security = new DirectorySecurity();
      security.SetAccessRuleProtection(true, false);
      security.SetOwner(new SecurityIdentifier(controllerSid));
      InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
      foreach (string sid in new string[] { controllerSid, "S-1-5-18" }.Distinct(StringComparer.Ordinal))
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
      if (!String.IsNullOrEmpty(readSid))
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(readSid), FileSystemRights.ReadAndExecute, inherit, PropagationFlags.None, AccessControlType.Allow));
      return security;
    }

    private static bool CreatePrivateDirectoryAtomically(string path, string controllerSid, string readSid, out int error)
    {
      byte[] descriptor = PrivateDirectorySecurity(controllerSid, readSid).GetSecurityDescriptorBinaryForm();
      IntPtr nativeDescriptor = Marshal.AllocHGlobal(descriptor.Length);
      try
      {
        Marshal.Copy(descriptor, 0, nativeDescriptor, descriptor.Length);
        SecurityAttributes attributes = new SecurityAttributes {
          length = Marshal.SizeOf(typeof(SecurityAttributes)), descriptor = nativeDescriptor, inherit = false
        };
        bool created = CreateDirectoryW(path, ref attributes);
        error = created ? 0 : Marshal.GetLastWin32Error();
        return created;
      }
      finally
      {
        Marshal.FreeHGlobal(nativeDescriptor);
        Array.Clear(descriptor, 0, descriptor.Length);
      }
    }

    public override void PreflightController(FixtureState state)
    {
      Real(state);
      CorePolicy.Require(Environment.OSVersion.Platform == PlatformID.Win32NT && IntPtr.Size == 8 && Environment.Is64BitOperatingSystem, "Windows x64 Controller is required");
      CorePolicy.Require(String.Equals(Environment.GetEnvironmentVariable("CI"), "true", StringComparison.OrdinalIgnoreCase), "Disposable CI is required");
      TokenIdentity runner = InspectCurrentToken();
      CorePolicy.Require(new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator), "Controller is not already administrative");
      state.runnerSid = runner.sid;
      state.runnerPid = checked((int)GetCurrentProcessId());
      state.runnerCreationTime = ProcessCreation(GetCurrentProcess());
      CorePolicy.ValidateAbsolutePath(state.spec.controllerRoot);
      CorePolicy.Require(!CorePolicy.IsInside(state.spec.gitRoot, state.spec.controllerRoot) &&
        !CorePolicy.SamePath(state.spec.gitRoot, state.spec.controllerRoot), "Controller root is inside Git");
      CorePolicy.Require(!Directory.Exists(state.spec.controllerRoot) && !File.Exists(state.spec.controllerRoot), "Controller root already exists");
      string parent = Path.GetDirectoryName(state.spec.controllerRoot);
      CorePolicy.Require(Directory.Exists(parent), "Controller parent does not exist");
      FileIdentity git = IdentifyPath(state.spec.gitRoot, true), parentIdentity = IdentifyPath(parent, true);
      CorePolicy.Require(!parentIdentity.reparse && !CorePolicy.SamePath(git.canonicalPath, parentIdentity.canonicalPath) &&
        !CorePolicy.IsInside(git.canonicalPath, parentIdentity.canonicalPath), "Canonical Controller parent is inside Git or unstable");
      int createError;
      bool created = CreatePrivateDirectoryAtomically(state.spec.controllerRoot, runner.sid, null, out createError);
      if (!created) throw new InvalidOperationException("CreateDirectoryW owned Controller root failed (Win32 " + createError.ToString(CultureInfo.InvariantCulture) + ")");
      state.controllerRootOwned = true; // No cleanup write may precede this fact.
      CorePolicy.Require(!IdentifyPath(state.spec.controllerRoot, true).reparse, "Controller root is a reparse point");
      foreach (Process process in Process.GetProcesses())
      {
        try
        {
          IntPtr handle = OpenProcess(ProcessQueryLimited, false, unchecked((uint)process.Id));
          if (handle == IntPtr.Zero) continue;
          try { preexistingProcesses[process.Id] = ProcessCreation(handle); }
          finally { CloseHandle(handle); }
        }
        finally { process.Dispose(); }
      }
      state.privilegeScope = new PrivilegeScope(this);
    }

    public override void LoadProfile(FixtureState state)
    {
      HistoricalController(state);
      VerifyOwnedAccount(state, false);
      CorePolicy.Require(state.profileCreated && state.profileOwnershipProven && !state.profileCreationUncertain
        && !state.profileLoadAttempted && state.profileCreationPin == null && !state.profileLoaded
        && state.token != IntPtr.Zero && state.profile == IntPtr.Zero, "Profile load precondition failed");
      CorePolicy.AssertStandard(InspectToken(state.token), state.account.sid);
      ProfileInfo profile = new ProfileInfo { size = (uint)Marshal.SizeOf(typeof(ProfileInfo)), flags = 1, userName = state.sam };
      state.profileCreationUncertain = true;
      using (ProfileDirectoryPin pin = new ProfileDirectoryPin(state.profilePath))
      {
        AssertOwnedProfileMetadata(state, pin);
        pin.VerifyUnchanged();
        Real(state);
      }
      state.profileLoadAttempted = true;
      bool loaded = LoadUserProfileW(state.token, ref profile);
      int loadError = Marshal.GetLastWin32Error();
      if (loaded) { state.profile = profile.profile; state.profileLoaded = true; }
      try
      {
        using (ProfileDirectoryPin pin = new ProfileDirectoryPin(state.profilePath)) AssertOwnedProfileMetadata(state, pin);
      }
      catch (Exception error)
      {
        if (!loaded)
        {
          ProfileTrace(state, "Load-failure metadata readback unproven; hResult=" + error.HResult.ToString(CultureInfo.InvariantCulture));
          throw new Win32Exception(loadError, "LoadUserProfileW");
        }
        throw;
      }
      if (!loaded) throw new Win32Exception(loadError, "LoadUserProfileW");
      CorePolicy.Require(state.profile != IntPtr.Zero, "LoadUserProfile returned no hive handle");
      KnownPaths paths = QueryKnownPaths(state.token);
      CorePolicy.Require(CorePolicy.SamePath(paths.profile, state.profilePath), "Loaded profile is not the created profile");
      using (RegistryKey machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
      using (RegistryKey mapping = machine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + state.account.sid, false))
      {
        CorePolicy.Require(mapping != null && CorePolicy.SamePath(Environment.ExpandEnvironmentVariables((string)mapping.GetValue("ProfileImagePath", "", RegistryValueOptions.DoNotExpandEnvironmentNames)), state.profilePath),
          "OS profile registration disagrees with the created profile");
      }
      state.profileCreationUncertain = false;
    }

    private static string KnownFolder(string value, IntPtr token)
    {
      Guid folder = new Guid(value);
      IntPtr path = IntPtr.Zero;
      try
      {
        // DONT_VERIFY is a read-only query. In particular, it must not create
        // UserProgramFiles or Desktop as an incidental ABI-harness side effect.
        int status = SHGetKnownFolderPath(ref folder, 0x4000, token, out path);
        CorePolicy.Require(status == 0 && path != IntPtr.Zero, "SHGetKnownFolderPath failed (HRESULT " + status.ToString(CultureInfo.InvariantCulture) + ")");
        string result = Marshal.PtrToStringUni(path);
        CorePolicy.ValidateAbsolutePath(result);
        return result;
      }
      finally { if (path != IntPtr.Zero) Marshal.FreeCoTaskMem(path); }
    }

    public override KnownPaths QueryKnownPaths(IntPtr token)
    {
      IntPtr ownedToken = IntPtr.Zero;
      if (token == IntPtr.Zero)
      {
        Win(OpenProcessToken(GetCurrentProcess(), TokenQuery | 0x0002 | 0x0004, out ownedToken), "OpenProcessToken known folders");
        token = ownedToken;
      }
      try
      {
        KnownPaths paths = new KnownPaths {
          profile = KnownFolder("5E6C858F-0E22-4760-9AFE-EA3317B67173", token),
          roaming = KnownFolder("3EB685DB-65F9-4CF6-A03A-E3EF65729F3D", token),
          local = KnownFolder("F1B32785-6FBA-4FCF-9D55-7B8E7F157091", token),
          desktop = KnownFolder("B4BFCC3A-DB2C-424C-B029-7FE99A87C641", token),
          programs = KnownFolder("A77F5D77-2E2B-44C3-A6A2-ABA601054A51", token),
          startMenu = KnownFolder("625B53C3-AB48-4EC1-BA1F-A1EF4146FC19", token),
          userPrograms = KnownFolder("5CD7AEE2-2219-4A67-B85D-6C9CE15660CB", token)
        };
        uint length = 32768;
        StringBuilder actual = new StringBuilder((int)length);
        Win(GetUserProfileDirectoryW(token, actual, ref length), "GetUserProfileDirectoryW");
        CorePolicy.Require(CorePolicy.SamePath(paths.profile, actual.ToString()), "Known profile disagrees with token profile directory");
        foreach (string path in new string[] { paths.profile, paths.roaming, paths.local, paths.desktop, paths.programs, paths.startMenu, paths.userPrograms })
          if (Directory.Exists(path)) CorePolicy.Require(!IdentifyPath(path, true).reparse, "Known folder crosses a reparse boundary");
        return paths;
      }
      finally { if (ownedToken != IntPtr.Zero) CloseHandle(ownedToken); }
    }

    public override Dictionary<string, string> TargetEnvironment(FixtureState state)
    {
      HistoricalController(state);
      return ReadTokenEnvironmentBlock(state);
    }

    internal static void RequireAbiEnvironmentRead(FixtureState state, FixtureState ownedAbiState,
      bool historicalContextBound, bool productsAllowed)
    {
      CorePolicy.Require(state != null && Object.ReferenceEquals(state, ownedAbiState)
        && !historicalContextBound && !productsAllowed, "ABI environment requires its exact owned harness state");
      CorePolicy.Require(state.spec != null && state.spec.version == 1 && state.spec.mode == "abi-harness"
        && !state.spec.realExecutionAdmitted && String.IsNullOrEmpty(state.spec.executionStage), "ABI environment has no live execution admission");
      CorePolicy.Require(state.controllerRootOwned && !String.IsNullOrEmpty(state.spec.controllerRoot)
        && state.runnerPid > 0 && !String.IsNullOrEmpty(state.runnerCreationTime) && !String.IsNullOrEmpty(state.runnerSid)
        && state.targetIdentity != null && state.targetIdentity.sid == state.runnerSid && state.targetIdentity.tokenType == 1
        && state.paths != null && CorePolicy.SamePath(state.paths.profile, state.profilePath), "ABI environment lacks its owned root and current-token observations");
      CorePolicy.Require(state.account == null && !state.accountCreated && !state.accountBound
        && !state.profileCreated && !state.profileLoaded && state.profile == IntPtr.Zero
        && state.token != IntPtr.Zero && state.environment == IntPtr.Zero, "ABI environment cannot use account or profile state");
    }

    private Dictionary<string, string> ReadAbiTokenEnvironment(FixtureState state)
    {
      RequireAbiEnvironmentRead(state, abiEnvironmentContext,
        controllerContext != null || subjectContext != null, subjectProductsAllowed);
      return ReadTokenEnvironmentBlock(state);
    }

    // Both callers establish their own authorization before this read-only
    // token operation. This core never enables account/profile/product APIs.
    private static Dictionary<string, string> ReadTokenEnvironmentBlock(FixtureState state)
    {
      CorePolicy.Require(state.token != IntPtr.Zero && state.environment == IntPtr.Zero, "Target environment lifecycle error");
      Win(CreateEnvironmentBlock(out state.environment, state.token, false), "CreateEnvironmentBlock");
      Dictionary<string, string> environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      int position = 0;
      while (position < 65536)
      {
        StringBuilder entry = new StringBuilder();
        while (position < 65536)
        {
          char value = unchecked((char)Marshal.ReadInt16(state.environment, position++ * 2));
          if (value == '\0') break;
          entry.Append(value);
        }
        if (entry.Length == 0) return environment;
        int equals = entry.ToString().IndexOf('=');
        if (equals > 0) environment.Add(entry.ToString().Substring(0, equals), entry.ToString().Substring(equals + 1));
      }
      throw new InvalidOperationException("Target environment block exceeded the bounded reader");
    }

    private static void ValidateHiveKey(FixtureSpec spec)
    {
      CorePolicy.Require(spec.nonce != null && spec.nonce.Length == 32 && spec.nonce.All(Uri.IsHexDigit) &&
        spec.hiveKey == @"Software\CcHaha1879Fixture\" + spec.nonce &&
        spec.hiveNonce != null && spec.hiveNonce.Length == 32 && spec.hiveNonce.All(Uri.IsHexDigit), "Owned hive challenge path is invalid");
    }

    public override void WriteHiveChallenge(FixtureState state)
    {
      HistoricalController(state);
      CorePolicy.Require(state.accountBound && state.profileLoaded && state.profile != IntPtr.Zero && state.account.sid == state.spec.expectedSid, "Target hive is not owned and loaded");
      ValidateHiveKey(state.spec);
      using (RegistryKey root = RegistryKey.FromHandle(new SafeRegistryHandle(state.profile, false), RegistryView.Registry64))
      using (RegistryKey key = root.CreateSubKey(state.spec.hiveKey))
      {
        CorePolicy.Require(key != null, "Owned challenge key was not created");
        key.SetValue("challenge", state.spec.hiveNonce, RegistryValueKind.String);
        key.SetValue("response", "", RegistryValueKind.String);
      }
      using (RegistryKey users = RegistryKey.OpenBaseKey(RegistryHive.Users, RegistryView.Registry64))
      using (RegistryKey key = users.OpenSubKey(state.account.sid + "\\" + state.spec.hiveKey, false))
        CorePolicy.Require(key != null && (string)key.GetValue("challenge", null) == state.spec.hiveNonce, "Explicit SID hive challenge readback failed");
    }

    private static string HiveResponse(FixtureSpec spec, string sid)
    {
      return CorePolicy.HashText(spec.nonce + "\n" + sid + "\n" + spec.hiveNonce);
    }

    public override string SubjectHiveChallenge(FixtureSpec spec)
    {
      Subject(spec, false);
      TokenIdentity identity = InspectCurrentToken();
      CorePolicy.AssertStandard(identity, spec.expectedSid);
      ValidateHiveKey(spec);
      IntPtr hive;
      int status = RegOpenCurrentUser(0x20019 | 0x0002, out hive);
      CorePolicy.Require(status == 0 && hive != IntPtr.Zero, "RegOpenCurrentUser failed");
      using (RegistryKey root = RegistryKey.FromHandle(new SafeRegistryHandle(hive, true), RegistryView.Registry64))
      using (RegistryKey key = root.OpenSubKey(spec.hiveKey, true))
      {
        CorePolicy.Require(key != null && (string)key.GetValue("challenge", null) == spec.hiveNonce, "Actual subject HKCU challenge mismatch");
        string response = HiveResponse(spec, identity.sid);
        key.SetValue("response", response, RegistryValueKind.String);
        return response;
      }
    }

    public override bool VerifyHiveResponse(FixtureState state, string response)
    {
      HistoricalController(state);
      ValidateHiveKey(state.spec);
      if (!state.accountBound || !state.profileLoaded || state.profile == IntPtr.Zero ||
          response != HiveResponse(state.spec, state.account.sid)) return false;
      using (RegistryKey users = RegistryKey.OpenBaseKey(RegistryHive.Users, RegistryView.Registry64))
      using (RegistryKey sid = users.OpenSubKey(state.account.sid + "\\" + state.spec.hiveKey, false))
      using (RegistryKey root = RegistryKey.FromHandle(new SafeRegistryHandle(state.profile, false), RegistryView.Registry64))
      using (RegistryKey loaded = root.OpenSubKey(state.spec.hiveKey, false))
        return sid != null && loaded != null && (string)sid.GetValue("response", null) == response &&
          (string)loaded.GetValue("response", null) == response && (string)sid.GetValue("challenge", null) == state.spec.hiveNonce;
    }

    private static string HandlePath(IntPtr handle, uint flags)
    {
      StringBuilder path = new StringBuilder(32768);
      uint length = GetFinalPathNameByHandleW(handle, path, (uint)path.Capacity, flags);
      if (length == 0) throw new InvalidOperationException("GetFinalPathNameByHandleW failed (Win32 " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ")");
      CorePolicy.Require(length > 0 && length < path.Capacity && length == path.Length, "Final file path could not be read completely");
      return path.ToString();
    }

    private static bool HasReparseComponent(string path)
    {
      string full = Path.GetFullPath(path), root = Path.GetPathRoot(full);
      string current = root;
      foreach (string component in full.Substring(root.Length).Split(new char[] { '\\', '/' }, StringSplitOptions.RemoveEmptyEntries))
      {
        current = Path.Combine(current, component);
        if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) return true;
      }
      return false;
    }

    public override FileIdentity IdentifyPath(string path, bool directory)
    {
      return IdentifyPathCore(path, directory, true);
    }

    private static FileIdentity ReadHandleIdentity(IntPtr file, bool directory, bool reparse)
    {
      FileInformation info;
      Win(GetFileInformationByHandle(file, out info), "GetFileInformationByHandle");
      string final = HandlePath(file, 0), volume = HandlePath(file, 1);
      CorePolicy.Require(final.StartsWith(@"\\?\", StringComparison.Ordinal) && !final.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)
        && volume.StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase), "Unexpected identity namespace");
      int end = volume.IndexOf(@"}\", StringComparison.Ordinal);
      CorePolicy.Require(end > 0, "Volume GUID identity is incomplete");
      FileIdentity identity = new FileIdentity {
        canonicalPath = final.Substring(4), volumePath = volume.Substring(0, end + 2),
        fileId = info.VolumeSerial.ToString("x8") + ":" + info.IndexHigh.ToString("x8") + info.IndexLow.ToString("x8"),
        bytes = checked((long)(((ulong)info.SizeHigh << 32) | info.SizeLow)),
        directory = (info.Attributes & 0x10) != 0, reparse = reparse || (info.Attributes & 0x400) != 0
      };
      CorePolicy.Require(identity.directory == directory, "File identity type changed");
      return identity;
    }

    private FileIdentity IdentifyPathCore(string path, bool directory, bool inspectAncestors)
    {
      CorePolicy.ValidateAbsolutePath(path);
      bool reparse = inspectAncestors ? HasReparseComponent(path) : (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
      IntPtr file = CreateFileW(path, directory ? 0x80u : 0x80000000u, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
      CorePolicy.Require(file != new IntPtr(-1), "Native identity file open failed (Win32 " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ")");
      try
      {
        FileIdentity identity = ReadHandleIdentity(file, directory, reparse);
        if (!directory)
        {
          using (SafeFileHandle borrowed = new SafeFileHandle(file, false))
          using (FileStream input = new FileStream(borrowed, FileAccess.Read))
          using (System.Security.Cryptography.SHA256 hash = System.Security.Cryptography.SHA256.Create())
            identity.sha256 = CorePolicy.Hex(hash.ComputeHash(input));
        }
        return identity;
      }
      finally { CloseHandle(file); }
    }

    public override void PrepareSubjectAccess(FixtureState state)
    {
      HistoricalController(state);
      CorePolicy.Require(state.controllerRootOwned && state.accountBound && state.profileLoaded, "Subject input ownership is incomplete");
      VerifyOwnedAccount(state, false);
      string input = Path.Combine(state.spec.controllerRoot, "subject-input");
      CorePolicy.Require(!Directory.Exists(input) && !File.Exists(input), "Subject input directory already exists");
      Directory.CreateDirectory(input, PrivateDirectorySecurity(state.runnerSid, state.account.sid));
      DirectorySecurity traverse = Directory.GetAccessControl(state.spec.controllerRoot);
      traverse.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(state.account.sid), FileSystemRights.Traverse | FileSystemRights.ReadAttributes, AccessControlType.Allow));
      Directory.SetAccessControl(state.spec.controllerRoot, traverse);
      state.subjectBinaryPath = Path.Combine(input, "profile-fixture.exe");
      FileIdentity controllerImage = IdentifyPath(CorePolicy.BinaryPath, false);
      CorePolicy.Require(!CorePolicy.IsInside(state.spec.gitRoot, CorePolicy.BinaryPath) &&
        controllerImage.sha256 == state.spec.expectedBinarySha256, "Controller binary changed or is inside Git");
      // Authenticate the actual server process image without granting access to
      // its parent directory, source tree, ledger, or the runner's profile.
      FileSecurity controllerImageAccess = File.GetAccessControl(CorePolicy.BinaryPath);
      originalControllerImagePath = CorePolicy.BinaryPath;
      originalControllerImageIdentity = controllerImage;
      originalControllerImageSecurity = new FileSecurity();
      originalControllerImageSecurity.SetSecurityDescriptorBinaryForm(controllerImageAccess.GetSecurityDescriptorBinaryForm(), AccessControlSections.Access);
      controllerImageAccess.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(state.account.sid), FileSystemRights.ReadAndExecute, AccessControlType.Allow));
      File.SetAccessControl(CorePolicy.BinaryPath, controllerImageAccess);
      File.Copy(CorePolicy.BinaryPath, state.subjectBinaryPath, false);
      CorePolicy.Require(IdentifyPath(state.subjectBinaryPath, false).sha256 == state.spec.expectedBinarySha256, "Subject fixture copy hash mismatch");
      FileIdentity setup = IdentifyPath(state.spec.setupPath, false);
      CorePolicy.Require(!setup.reparse && setup.bytes == SetupBytes && setup.sha256 == SetupSha, "Full setup pin changed before copy");
      string setupCopy = Path.Combine(input, "old-setup.exe");
      File.Copy(state.spec.setupPath, setupCopy, false);
      FileIdentity copiedSetup = IdentifyPath(setupCopy, false);
      CorePolicy.Require(!copiedSetup.reparse && copiedSetup.bytes == SetupBytes && copiedSetup.sha256 == SetupSha, "Full setup copy hash mismatch");
      string sources = Path.Combine(input, "sources");
      Directory.CreateDirectory(sources, PrivateDirectorySecurity(state.runnerSid, state.account.sid));
      foreach (SourcePin pin in state.spec.sourcePins)
      {
        CorePolicy.Require(CorePolicy.SourceNames.Contains(pin.file), "Unexpected source copy requested");
        string source = Path.Combine(state.spec.sourceRoot, pin.file), destination = Path.Combine(sources, pin.file);
        CorePolicy.Require(IdentifyPath(source, false).sha256 == pin.sha256, "Reviewed source changed before copy");
        File.Copy(source, destination, false);
        CorePolicy.Require(IdentifyPath(destination, false).sha256 == pin.sha256, "Subject source copy hash mismatch");
      }
      state.spec.sourceRoot = sources;
      state.spec.setupPath = setupCopy;
      state.spec.subjectSpecPath = Path.Combine(input, "subject.json");
    }

    public override void CreatePrivateDesktop(FixtureState state)
    {
      if (controllerContext != null && controllerContext.mode == "createprofile-only-controller") HistoricalController(state);
      CorePolicy.Require(Thread.CurrentThread.ManagedThreadId == ownerManagedThread, "Private station request requires its Controller thread");
      uint currentThread = GetCurrentThreadId();
      if (ownerNativeThread == 0) ownerNativeThread = currentThread;
      CorePolicy.Require(currentThread == ownerNativeThread, "Private station native thread changed");
      CorePolicy.Require(state.station == IntPtr.Zero && state.desktop == IntPtr.Zero && desktopCreator == null, "Private UI objects already exist");
      string sid = state.account == null ? state.runnerSid : state.account.sid;
      CorePolicy.Require(!String.IsNullOrEmpty(sid) && state.targetIdentity != null, "Private desktop lacks a bound token");
      string logonSid = state.targetIdentity.groups.FirstOrDefault(group => group.StartsWith("S-1-5-5-", StringComparison.Ordinal));
      if (state.account != null) { HistoricalController(state); CorePolicy.Require(logonSid != null, "Target token has no logon SID"); }
      string stationName = "CcHaha1879-" + Guid.NewGuid().ToString("N");
      string descriptor = "D:P(A;;GA;;;SY)(A;;GA;;;" + state.runnerSid + ")(A;;GA;;;" + (logonSid ?? sid) + ")";
      state.originalStation = GetProcessWindowStation();
      state.originalDesktop = GetThreadDesktop(GetCurrentThreadId());
      CorePolicy.Require(state.originalStation != IntPtr.Zero && state.originalDesktop != IntPtr.Zero, "Original UI handles were not available");
      desktopCreator = new PrivateDesktopCreator(delegate {
        // This worker owns the descriptor until its native calls return, even
        // if the Controller's bounded wait expires. No caller-side free races it.
        IntPtr security = IntPtr.Zero;
        try
        {
          uint securitySize;
          Win(ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor, 1, out security, out securitySize), "Private station security descriptor");
          SecurityAttributes attributes = new SecurityAttributes { length = Marshal.SizeOf(typeof(SecurityAttributes)), descriptor = security, inherit = false };
          // CWF_CREATE_ONLY: never open an object created by another process.
          state.station = CreateWindowStationW(stationName, 1, 0x000f037f, ref attributes);
          Win(state.station != IntPtr.Zero, "CreateWindowStationW");
          Win(SetProcessWindowStation(state.station), "SetProcessWindowStation private");
          state.desktop = CreateDesktopW("fixture", IntPtr.Zero, IntPtr.Zero, 0, 0x000f01ff, ref attributes);
          Win(state.desktop != IntPtr.Zero, "CreateDesktopW");
          state.desktopName = stationName + @"\fixture";
        }
        finally
        {
          try
          {
            if (GetProcessWindowStation() != state.originalStation)
              Win(SetProcessWindowStation(state.originalStation), "Restore process window station");
            CorePolicy.Require(GetProcessWindowStation() == state.originalStation, "Original process station was not restored");
          }
          finally { if (security != IntPtr.Zero) LocalFree(security); }
        }
      });
      desktopCreator.Start();
      desktopCreator.WaitForExit(5000);
      desktopCreator.ThrowIfFailed();
      AssertOriginalUi(state);
    }

    private void AssertOriginalUi(FixtureState state)
    {
      CorePolicy.Require(Thread.CurrentThread.ManagedThreadId == ownerManagedThread &&
        (ownerNativeThread == 0 || GetCurrentThreadId() == ownerNativeThread), "Original UI verification requires its Controller thread");
      if (state.originalStation != IntPtr.Zero)
        CorePolicy.Require(GetProcessWindowStation() == state.originalStation, "Original process station changed");
      if (state.originalDesktop != IntPtr.Zero)
        CorePolicy.Require(GetThreadDesktop(GetCurrentThreadId()) == state.originalDesktop, "Original Controller desktop changed");
    }

    private static IntPtr EnvironmentBytes(Dictionary<string, string> environment)
    {
      string block = CorePolicy.EnvironmentBlock(environment);
      CorePolicy.Require(block.Length >= 2 && block.Length <= 32767 && block.EndsWith("\0\0", StringComparison.Ordinal), "Invalid bounded Unicode environment block");
      IntPtr memory = Marshal.AllocHGlobal(checked(block.Length * 2));
      for (int i = 0; i < block.Length; i++) Marshal.WriteInt16(memory, i * 2, unchecked((short)block[i]));
      return memory;
    }

    private static void FreeEnvironmentBytes(IntPtr memory, Dictionary<string, string> environment)
    {
      if (memory == IntPtr.Zero) return;
      int bytes = CorePolicy.EnvironmentBlock(environment).Length * 2;
      for (int i = 0; i < bytes; i++) Marshal.WriteByte(memory, i, 0);
      Marshal.FreeHGlobal(memory);
    }

    private static IntPtr NewJob()
    {
      IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
      Win(job != IntPtr.Zero, "CreateJobObjectW");
      try
      {
        ExtendedLimits limits = new ExtendedLimits();
        limits.basic.flags = 0x00002000; // KILL_ON_JOB_CLOSE, no breakaway flags.
        Win(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "SetInformationJobObject");
        return job;
      }
      catch { CloseHandle(job); throw; }
    }

    private static uint JobActive(IntPtr job)
    {
      CorePolicy.Require(job != IntPtr.Zero, "Missing owned Job handle");
      JobAccounting accounting;
      Win(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(JobAccounting)), IntPtr.Zero), "QueryInformationJobObject");
      return accounting.activeProcesses;
    }

    private static bool ProcessAlive(IntPtr process)
    {
      uint result = WaitForSingleObject(process, 0);
      CorePolicy.Require(result == 0 || result == 258, "Owned process wait failed");
      return result == 258;
    }

    private static void WaitJobEmpty(IntPtr job, int milliseconds)
    {
      Stopwatch deadline = Stopwatch.StartNew();
      while (JobActive(job) != 0)
      {
        CorePolicy.Require(deadline.ElapsedMilliseconds < milliseconds, "Owned Job did not become empty");
        Thread.Sleep(25);
      }
    }

    private TokenIdentity ProcessToken(IntPtr process)
    {
      IntPtr token;
      Win(OpenProcessToken(process, TokenQuery, out token), "OpenProcessToken child");
      try { return InspectToken(token); }
      finally { CloseHandle(token); }
    }

    private FileIdentity ProcessImage(IntPtr process, bool inspectAncestors = true)
    {
      uint length = 32768;
      StringBuilder path = new StringBuilder((int)length);
      Win(QueryFullProcessImageNameW(process, 0, path, ref length), "QueryFullProcessImageNameW");
      CorePolicy.Require(length > 0 && length < path.Capacity && length == path.Length, "Child image path was truncated");
      return IdentifyPathCore(path.ToString(), false, inspectAncestors);
    }

    private void CaptureProcess(OwnedProcess process)
    {
      process.creationTime = ProcessCreation(process.process);
      process.identity = ProcessToken(process.process);
      process.image = ProcessImage(process.process);
    }

    private void CheckHeldProcess(OwnedProcess process, string sid, string path, string hash, IntPtr job)
    {
      CorePolicy.Require(process != null && process.process != IntPtr.Zero && process.pid > 0 &&
        ProcessCreation(process.process) == process.creationTime, "Held process creation identity changed");
      TokenIdentity token = ProcessToken(process.process);
      FileIdentity image = ProcessImage(process.process);
      CorePolicy.Require(token.sid == sid && !image.reparse && CorePolicy.SamePath(image.canonicalPath, path) &&
        image.sha256 == hash && (process.image == null || image.fileId == process.image.fileId), "Held process SID/image identity changed");
      bool member;
      Win(IsProcessInJob(process.process, job, out member), "IsProcessInJob");
      CorePolicy.Require(member, "Child is outside the owned Job");
    }

    public override void CreateSubjectSuspended(FixtureState state)
    {
      HistoricalController(state);
      CorePolicy.Require(state.subject == null && state.token != IntPtr.Zero && state.targetEnvironment != null &&
        state.desktop != IntPtr.Zero && !String.IsNullOrEmpty(state.desktopName) && state.spec.subjectSpecPath != null &&
        state.subjectBinaryPath != null, "Suspended subject preconditions failed");
      FileIdentity image = IdentifyPath(state.subjectBinaryPath, false);
      CorePolicy.Require(!image.reparse && image.sha256 == state.spec.expectedBinarySha256 &&
        CorePolicy.HashFile(state.spec.subjectSpecPath) == state.spec.subjectSpecSha256, "Trusted subject input binding changed");
      string command = CorePolicy.SubjectCommand(state.subjectBinaryPath, state.spec.subjectSpecPath);
      CorePolicy.Require(command.Length <= 1023, "WithToken command exceeds its Unicode limit");
      StartupInfo startup = new StartupInfo { cb = Marshal.SizeOf(typeof(StartupInfo)), desktop = state.desktopName };
      ProcessInformation created;
      IntPtr environment = EnvironmentBytes(state.targetEnvironment);
      try
      {
        // No LOGON_WITH_PROFILE: the exact LoadUserProfile lease is explicit.
        // No inherited handles or implicit desktop/environment/current directory.
        Real(state);
        Win(CreateProcessWithTokenW(state.token, 0, state.subjectBinaryPath, new StringBuilder(command), 0x00000404 | 0x08000000,
          environment, state.profilePath, ref startup, out created), "CreateProcessWithTokenW");
        state.subject = new OwnedProcess { process = created.process, thread = created.thread, image = image };
        state.subject.pid = checked((int)created.pid);
        CaptureProcess(state.subject); // Stored handles remain owned on failure.
      }
      finally { FreeEnvironmentBytes(environment, state.targetEnvironment); }
    }

    public override void AssignSubjectToOwnedJob(FixtureState state)
    {
      HistoricalController(state);
      CorePolicy.Require(state.subject != null && !state.subject.resumed && !state.subject.assigned && state.job == IntPtr.Zero, "Subject Job assignment order failed");
      state.job = NewJob();
      Win(AssignProcessToJobObject(state.job, state.subject.process), "AssignProcessToJobObject subject");
      state.subject.assigned = true;
    }

    public override void VerifySubject(FixtureState state)
    {
      HistoricalController(state);
      CorePolicy.Require(state.subject != null && state.subject.assigned && !state.subject.resumed, "Subject must still be suspended");
      CheckHeldProcess(state.subject, state.account.sid, state.subjectBinaryPath, state.spec.expectedBinarySha256, state.job);
      TokenIdentity identity = ProcessToken(state.subject.process);
      CorePolicy.AssertStandard(identity, state.account.sid);
      CorePolicy.Require(identity.authenticationId == state.targetIdentity.authenticationId, "Subject logon identity changed");
      CorePolicy.Require(state.subject.identity.sessionId == InspectCurrentToken().sessionId, "WithToken subject is in a different session");
    }

    public override void ResumeSubject(FixtureState state)
    {
      VerifySubject(state);
      Win(ResumeThread(state.subject.thread) != Infinite, "ResumeThread subject");
      state.subject.resumed = true;
    }

    public override int WaitSubjectExit(FixtureState state, int timeoutMilliseconds)
    {
      HistoricalController(state);
      OwnedProcess subject = state.subject;
      CorePolicy.Require(timeoutMilliseconds > 0 && timeoutMilliseconds <= 30000 && state.acknowledged &&
        subject != null && subject.process != IntPtr.Zero && subject.pid > 0 && subject.assigned && subject.resumed &&
        subject.job == IntPtr.Zero && state.job != IntPtr.Zero && state.account != null &&
        subject.identity != null && subject.image != null && state.targetIdentity != null,
        "Invalid bounded subject natural-exit wait");
      Stopwatch deadline = Stopwatch.StartNew();
      // These identities were captured from this held process while suspended
      // and verified again before resume/ACK. An exited process may no longer
      // expose its token/image, so retain that evidence rather than reopen a PID.
      uint heldPid = GetProcessId(subject.process);
      Win(heldPid != 0, "GetProcessId held subject");
      CorePolicy.Require(heldPid == (uint)subject.pid && ProcessCreation(subject.process) == subject.creationTime &&
        subject.identity.sid == state.account.sid &&
        subject.identity.authenticationId == state.targetIdentity.authenticationId && !subject.image.reparse &&
        CorePolicy.SamePath(subject.image.canonicalPath, state.subjectBinaryPath) &&
        subject.image.sha256 == state.spec.expectedBinarySha256 && !String.IsNullOrEmpty(subject.image.fileId),
        "Held subject natural-exit identity changed");
      CorePolicy.AssertStandard(subject.identity, state.account.sid);
      int remaining = timeoutMilliseconds - checked((int)Math.Min(deadline.ElapsedMilliseconds, Int32.MaxValue));
      CorePolicy.Require(remaining > 0, "Subject natural-exit deadline expired");
      uint wait = WaitForSingleObject(subject.process, (uint)remaining);
      int waitError = Marshal.GetLastWin32Error();
      if (wait == Infinite) throw new InvalidOperationException("WaitForSingleObject subject failed (Win32 " + waitError.ToString(CultureInfo.InvariantCulture) + ")");
      CorePolicy.Require(wait == 0, wait == 258 ? "Subject natural exit timed out" : "Subject natural-exit wait returned an unknown status");
      while (JobActive(state.job) != 0)
      {
        remaining = timeoutMilliseconds - checked((int)Math.Min(deadline.ElapsedMilliseconds, Int32.MaxValue));
        CorePolicy.Require(remaining > 0, "Subject descendants exceeded the natural-exit deadline");
        Thread.Sleep(Math.Min(25, remaining));
      }
      CorePolicy.Require(deadline.ElapsedMilliseconds <= timeoutMilliseconds, "Subject natural-exit deadline expired");
      uint exit;
      Win(GetExitCodeProcess(subject.process, out exit), "GetExitCodeProcess subject");
      subject.exited = true;
      return unchecked((int)exit);
    }

    private void StartChildInternal(OwnedProcess child, CommandPlan command, Dictionary<string, string> environment,
      string cwd, string desktopName, bool abi)
    {
      if (!abi) { Subject(subjectContext, true); ValidateSubjectCommand(command); }
      CorePolicy.Require(child != null && child.process == IntPtr.Zero && child.job == IntPtr.Zero, "Child lease was already used");
      CorePolicy.ValidateAbsolutePath(command.application); CorePolicy.ValidateAbsolutePath(cwd);
      CorePolicy.Require(!String.IsNullOrEmpty(desktopName) && desktopName.IndexOf('\\') > 0 &&
        !desktopName.StartsWith("winsta0\\", StringComparison.OrdinalIgnoreCase), "Child requires the private desktop");
      CorePolicy.Require(command.commandLine != null && command.commandLine.Length <= 32766 &&
        command.commandLine.IndexOfAny(new char[] { '\0', '\r', '\n' }) < 0, "Invalid child command line");
      FileIdentity image = IdentifyPath(command.application, false);
      CorePolicy.Require(!image.reparse && image.sha256 == command.expectedSha256, "Child executable pin changed");
      if (abi) CorePolicy.Require(image.sha256 == CorePolicy.HashFile(CorePolicy.BinaryPath) && command.phase == "abi-owned-child", "ABI launcher accepts only this fixture binary");
      child.job = NewJob();
      IntPtr block = EnvironmentBytes(environment);
      try
      {
        StartupInfo startup = new StartupInfo { cb = Marshal.SizeOf(typeof(StartupInfo)), desktop = desktopName };
        ProcessInformation process;
        if (!abi) Subject(subjectContext, true);
        Win(CreateProcessW(command.application, new StringBuilder(command.commandLine), IntPtr.Zero, IntPtr.Zero, false,
          0x00000404 | 0x08000000, block, cwd, ref startup, out process), "CreateProcessW owned child");
        child.process = process.process; child.thread = process.thread; child.pid = checked((int)process.pid); child.image = image;
        child.creationTime = ProcessCreation(child.process);
        Win(AssignProcessToJobObject(child.job, child.process), "AssignProcessToJobObject owned child");
        child.assigned = true;
        CaptureProcess(child);
      }
      finally { FreeEnvironmentBytes(block, environment); }
    }

    public override void StartChild(OwnedProcess child, CommandPlan command, Dictionary<string, string> environment, string cwd, string desktopName)
    {
      Subject(subjectContext, true);
      StartChildInternal(child, command, environment, cwd, desktopName, false);
    }

    private static string ActualWindowsDirectory()
    {
      StringBuilder path = new StringBuilder(32768);
      uint length = GetWindowsDirectoryW(path, (uint)path.Capacity);
      CorePolicy.Require(length > 0 && length < path.Capacity && length == path.Length, "Actual Windows directory query failed");
      CorePolicy.ValidateAbsolutePath(path.ToString());
      return path.ToString();
    }

    private void ValidateSubjectCommand(CommandPlan command)
    {
      Subject(subjectContext, true);
      CorePolicy.Require(command != null, "Missing fixed subject command");
      string windows = ActualWindowsDirectory(), expected;
      string[] csvPhases = { "observer-calibration", "negative-preflight", "positive-preflight" };
      string[] powershellPhases = { "powershell-normal-capability-1", "powershell-normal-capability-2", "powershell-unavailable-capability" };
      if (csvPhases.Contains(command.phase)) expected = Path.Combine(windows, @"SysWOW64\cmd.exe");
      else if (powershellPhases.Contains(command.phase)) expected = Path.Combine(windows, @"SysWOW64\WindowsPowerShell\v1.0\powershell.exe");
      else if (command.phase == "fresh-install")
      {
        expected = subjectContext.setupPath;
        CorePolicy.Require(command.expectedSha256 == CorePolicy.SetupHash &&
          command.commandLine == CorePolicy.SetupCommand(expected, subjectContext.installRoot) &&
          IdentifyPath(expected, false).bytes == CorePolicy.SetupBytes, "Released setup command/pin changed");
      }
      else if (command.phase == "old22-negative" || command.phase == "old-normal-removal-positive")
      {
        expected = subjectContext.uninstallerCopy;
        CorePolicy.Require(command.expectedSha256 == CorePolicy.UninstallerHash &&
          command.commandLine == CorePolicy.UninstallerCommand(expected, subjectContext.installRoot) &&
          IdentifyPath(expected, false).bytes == CorePolicy.UninstallerBytes, "Released old-uninstaller command/pin changed");
      }
      else if (command.phase == "foreign-helper")
      {
        expected = Path.Combine(subjectContext.fixtureRoot, @"foreign\OpenConsole.exe");
        CorePolicy.Require(command.commandLine == "\"" + expected + "\" -t 127.0.0.1" &&
          command.expectedSha256 == IdentifyPath(Path.Combine(windows, @"System32\ping.exe"), false).sha256, "Owned helper is not the exact system ping copy");
      }
      else throw new InvalidOperationException("Unknown subject process phase");
      CorePolicy.Require(CorePolicy.SamePath(command.application, expected), "Subject executable is outside its fixed phase");
    }

    public override void VerifyChild(OwnedProcess child, string expectedSid, string expectedPath, string expectedSha256)
    {
      CorePolicy.Require(child != null && child.assigned && !child.resumed, "Owned child must remain suspended until verified");
      CheckHeldProcess(child, expectedSid, expectedPath, expectedSha256, child.job);
      if (subjectContext != null) CorePolicy.AssertStandard(ProcessToken(child.process), subjectContext.expectedSid);
    }

    public override void ResumeChild(OwnedProcess child)
    {
      CorePolicy.Require(child != null && child.assigned && !child.resumed && child.identity != null && child.image != null, "Child resume order failed");
      CheckHeldProcess(child, child.identity.sid, child.image.canonicalPath, child.image.sha256, child.job);
      if (subjectContext != null) CorePolicy.AssertStandard(ProcessToken(child.process), subjectContext.expectedSid);
      Win(ResumeThread(child.thread) != Infinite, "ResumeThread child");
      child.resumed = true;
    }

    public override int WaitChild(OwnedProcess child, int timeoutMilliseconds)
    {
      CorePolicy.Require(child != null && child.process != IntPtr.Zero && child.assigned && timeoutMilliseconds > 0 && timeoutMilliseconds <= 300000, "Invalid bounded child wait");
      Stopwatch deadline = Stopwatch.StartNew();
      uint wait = WaitForSingleObject(child.process, (uint)timeoutMilliseconds);
      CorePolicy.Require(wait == 0, wait == 258 ? "Owned child timed out" : "Owned child wait failed");
      int remaining = timeoutMilliseconds - checked((int)Math.Min(deadline.ElapsedMilliseconds, Int32.MaxValue));
      CorePolicy.Require(remaining > 0, "Owned process descendants exceeded the phase deadline");
      WaitJobEmpty(child.job, remaining);
      uint exit;
      Win(GetExitCodeProcess(child.process, out exit), "GetExitCodeProcess");
      child.exited = true;
      return unchecked((int)exit);
    }

    public override void StopChild(OwnedProcess child)
    {
      if (child == null) return;
      if (child.process != IntPtr.Zero && ProcessAlive(child.process))
      {
        if (child.resumed)
        {
          CorePolicy.Require(child.identity != null && child.image != null && child.assigned, "Running child lacks retained ownership");
          CheckHeldProcess(child, child.identity.sid, child.image.canonicalPath, child.image.sha256, child.job);
        }
        if (child.job != IntPtr.Zero && child.assigned) Win(TerminateJobObject(child.job, 241), "TerminateJobObject owned child");
        else
        {
          CorePolicy.Require(!child.resumed, "Unassigned running child cannot be terminated");
          Win(TerminateProcess(child.process, 241), "TerminateProcess owned suspended child");
        }
        CorePolicy.Require(WaitForSingleObject(child.process, 5000) == 0, "Owned child did not terminate");
      }
      if (child.job != IntPtr.Zero)
      {
        if (JobActive(child.job) != 0) Win(TerminateJobObject(child.job, 241), "TerminateJobObject owned descendants");
        WaitJobEmpty(child.job, 5000);
      }
      child.exited = true;
    }

    public override void CloseChild(OwnedProcess child)
    {
      if (child == null) return;
      StopChild(child);
      if (child.thread != IntPtr.Zero) { Win(CloseHandle(child.thread), "Close owned thread"); child.thread = IntPtr.Zero; }
      if (child.process != IntPtr.Zero) { Win(CloseHandle(child.process), "Close owned process"); child.process = IntPtr.Zero; }
      if (child.job != IntPtr.Zero) { Win(CloseHandle(child.job), "Close owned child Job"); child.job = IntPtr.Zero; }
    }

    public override void VerifyReportedPhase(FixtureState state, ProtocolMessage message)
    {
      Real(state);
      CorePolicy.Require(state.acknowledged && state.job != IntPtr.Zero && message != null && message.pid > 0 && message.image != null, "Reported phase has no admitted ownership");
      IntPtr process = OpenProcess(ProcessQueryLimited, false, checked((uint)message.pid));
      Win(process != IntPtr.Zero, "Open reported phase for read-only verification");
      try
      {
        bool member;
        Win(IsProcessInJob(process, state.job, out member), "IsProcessInJob reported phase");
        FileIdentity image = ProcessImage(process);
        TokenIdentity identity = ProcessToken(process);
        CorePolicy.AssertStandard(identity, state.account.sid);
        CorePolicy.Require(member && ProcessCreation(process) == message.creationTime && identity.sid == state.account.sid &&
          !image.reparse && image.fileId == message.image.fileId && image.sha256 == message.image.sha256 &&
          CorePolicy.SamePath(image.canonicalPath, message.image.canonicalPath), "Reported phase identity does not match the held Job");
      }
      finally { CloseHandle(process); }
      // This temporary QUERY handle is closed. IPC PID never confers kill rights.
    }

    internal bool ChildIsAlive(OwnedProcess child)
    {
      CorePolicy.Require(child != null && child.process != IntPtr.Zero, "Missing retained child handle");
      if (!ProcessAlive(child.process)) return false;
      CorePolicy.Require(child.identity != null && child.image != null && child.assigned, "Child lacks retained identity");
      CheckHeldProcess(child, child.identity.sid, child.image.canonicalPath, child.image.sha256, child.job);
      return true;
    }

    internal string CurrentCreationTime() { return ProcessCreation(GetCurrentProcess()); }

    private static string UserObjectName(IntPtr handle)
    {
      uint needed;
      StringBuilder name = new StringBuilder(1024);
      Win(GetUserObjectInformationW(handle, 2, name, (uint)(name.Capacity * 2), out needed), "GetUserObjectInformationW");
      CorePolicy.Require(name.Length > 0 && name.Length < name.Capacity, "UI object name was not complete");
      return name.ToString();
    }

    internal string CurrentPrivateDesktopName()
    {
      string station = UserObjectName(GetProcessWindowStation()), desktop = UserObjectName(GetThreadDesktop(GetCurrentThreadId()));
      CorePolicy.Require(station.StartsWith("CcHaha1879-", StringComparison.Ordinal) && desktop == "fixture", "Current desktop is not a fixture private desktop");
      return station + "\\" + desktop;
    }

    private sealed class NativePipeChannel : FixtureChannel
    {
      private PipeStream stream;
      private readonly bool server;

      private NativePipeChannel(PipeStream value, bool isServer) { stream = value; server = isServer; }

      public static NativePipeChannel Server(string name, string controllerSid, string targetSid)
      {
        CorePolicy.Require(name != null && name.StartsWith("CcHaha1879-", StringComparison.Ordinal) &&
          name.Length < 120 && name.IndexOfAny(new char[] { '\\', '/', '\0', '\r', '\n' }) < 0, "Invalid private pipe name");
        IntPtr descriptor;
        uint bytes;
        // Explicit actual owner + individual client rights. FILE_GENERIC_WRITE
        // would also grant FILE_CREATE_PIPE_INSTANCE; do not give it to subject.
        string security = "O:" + controllerSid + "D:P(A;;GA;;;SY)(A;;GA;;;" + controllerSid + ")(A;;0x00120083;;;" + targetSid + ")";
        Win(ConvertStringSecurityDescriptorToSecurityDescriptorW(security, 1, out descriptor, out bytes), "Private pipe descriptor");
        try
        {
          SecurityAttributes attributes = new SecurityAttributes { length = Marshal.SizeOf(typeof(SecurityAttributes)), descriptor = descriptor, inherit = false };
          // First-instance + overlapped, reject remote clients, byte framing.
          IntPtr pipe = CreateNamedPipeW(@"\\.\pipe\" + name, 0x40080003, 0x00000008, 1, 65536, 65536, 5000, ref attributes);
          Win(pipe != new IntPtr(-1), "CreateNamedPipeW first instance");
          SafePipeHandle owned = new SafePipeHandle(pipe, true);
          try { return new NativePipeChannel(new NamedPipeServerStream(PipeDirection.InOut, true, false, owned), true); }
          catch { owned.Dispose(); throw; }
        }
        finally { LocalFree(descriptor); }
      }

      public static NativePipeChannel Client(string name)
      {
        CorePolicy.Require(name != null && name.StartsWith("CcHaha1879-", StringComparison.Ordinal) &&
          name.Length < 120 && name.IndexOfAny(new char[] { '\\', '/', '\0', '\r', '\n' }) < 0, "Invalid private pipe name");
        PipeAccessRights rights = PipeAccessRights.ReadData | PipeAccessRights.WriteData | PipeAccessRights.ReadAttributes |
          PipeAccessRights.ReadPermissions | PipeAccessRights.Synchronize;
        NamedPipeClientStream pipe = new NamedPipeClientStream(".", name, rights, PipeOptions.Asynchronous, TokenImpersonationLevel.Identification, HandleInheritability.None);
        try { pipe.Connect(10000); return new NativePipeChannel(pipe, false); }
        catch { pipe.Dispose(); throw; }
      }

      private void Connected(int timeout)
      {
        CorePolicy.Require(stream != null, "Private IPC is closed");
        if (!server || stream.IsConnected) return;
        NamedPipeServerStream pipe = (NamedPipeServerStream)stream;
        System.Threading.Tasks.Task wait = System.Threading.Tasks.Task.Factory.FromAsync(pipe.BeginWaitForConnection, pipe.EndWaitForConnection, null);
        Observe(wait);
        if (!wait.Wait(timeout)) { Dispose(); throw new InvalidOperationException("Private IPC connection timed out"); }
      }

      private static void Observe(System.Threading.Tasks.Task task)
      {
        task.ContinueWith(delegate(System.Threading.Tasks.Task failed) { var ignored = failed.Exception; },
          System.Threading.Tasks.TaskContinuationOptions.OnlyOnFaulted);
      }

      public override int PeerProcessId
      {
        get
        {
          Connected(10000);
          uint pid;
          Win(server ? GetNamedPipeClientProcessId(stream.SafePipeHandle.DangerousGetHandle(), out pid) :
            GetNamedPipeServerProcessId(stream.SafePipeHandle.DangerousGetHandle(), out pid), "GetNamedPipe peer process ID");
          return checked((int)pid);
        }
      }

      internal string OwnerSid
      {
        get
        {
          Connected(10000);
          IntPtr owner, group, dacl, sacl, descriptor;
          uint status = GetSecurityInfo(stream.SafePipeHandle.DangerousGetHandle(), 6, 1, out owner, out group, out dacl, out sacl, out descriptor);
          CorePolicy.Require(status == 0, "Private pipe owner query failed (Win32 " + status.ToString(CultureInfo.InvariantCulture) + ")");
          try { CorePolicy.Require(descriptor != IntPtr.Zero && owner != IntPtr.Zero, "Private pipe owner is missing"); return Sid(owner); }
          finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
        }
      }

      public override string ReadLine(int timeoutMilliseconds)
      {
        CorePolicy.Require(timeoutMilliseconds > 0 && timeoutMilliseconds <= 360000, "Invalid IPC timeout");
        Stopwatch deadline = Stopwatch.StartNew();
        Connected(timeoutMilliseconds);
        List<byte> bytes = new List<byte>();
        while (bytes.Count < 65536)
        {
          int remaining = timeoutMilliseconds - checked((int)Math.Min(deadline.ElapsedMilliseconds, Int32.MaxValue));
          CorePolicy.Require(remaining > 0, "Private IPC read timed out");
          byte[] one = new byte[1];
          System.Threading.Tasks.Task<int> read = System.Threading.Tasks.Task<int>.Factory.FromAsync(
            delegate(AsyncCallback callback, object state) { return stream.BeginRead(one, 0, 1, callback, state); }, stream.EndRead, null);
          Observe(read);
          if (!read.Wait(remaining)) { Dispose(); throw new InvalidOperationException("Private IPC read timed out"); }
          CorePolicy.Require(read.Result == 1, "Private IPC closed before a complete message");
          if (one[0] == 10) return new UTF8Encoding(false, true).GetString(bytes.ToArray());
          CorePolicy.Require(one[0] != 0 && one[0] != 13, "Invalid IPC framing byte");
          bytes.Add(one[0]);
        }
        throw new InvalidOperationException("Private IPC message exceeds its bound");
      }

      public override void WriteLine(string line)
      {
        Connected(10000);
        CorePolicy.Require(line != null && line.IndexOfAny(new char[] { '\0', '\r', '\n' }) < 0, "Invalid IPC output framing");
        byte[] bytes = new UTF8Encoding(false, true).GetBytes(line + "\n");
        CorePolicy.Require(bytes.Length <= 65536, "Private IPC output exceeds its bound");
        System.Threading.Tasks.Task write = System.Threading.Tasks.Task.Factory.FromAsync(
          delegate(AsyncCallback callback, object state) { return stream.BeginWrite(bytes, 0, bytes.Length, callback, state); }, stream.EndWrite, null);
        Observe(write);
        if (!write.Wait(10000)) { Dispose(); throw new InvalidOperationException("Private IPC write timed out"); }
      }

      public override void Dispose()
      {
        PipeStream owned = stream; stream = null;
        if (owned != null) owned.Dispose();
      }
    }

    public override FixtureChannel CreateControllerChannel(FixtureState state)
    {
      HistoricalController(state);
      CorePolicy.Require(state.accountBound && state.profileLoaded && state.channel == null, "Controller channel ownership is incomplete");
      return NativePipeChannel.Server(state.spec.pipeName, state.runnerSid, state.account.sid);
    }

    private void VerifyServer(FixtureSpec spec, FixtureChannel pipe)
    {
      CorePolicy.Require(pipe.PeerProcessId == spec.expectedControllerPid && spec.expectedControllerPid > 0 &&
        spec.expectedControllerSid != spec.expectedSid && ((NativePipeChannel)pipe).OwnerSid == spec.expectedControllerSid,
        "Named pipe server PID/actual owner SID is not the expected Controller");
      IntPtr process = OpenProcess(ProcessQueryLimited, false, checked((uint)spec.expectedControllerPid));
      Win(process != IntPtr.Zero, "Open named pipe server for read-only verification");
      try
      {
        FileIdentity image = ProcessImage(process, false);
        // A different standard SID cannot read an elevated Controller token
        // without SeDebugPrivilege (OpenProcessToken's documented restriction).
        // Authenticate actual pipe owner SID, peer PID, creation time and exact
        // image bytes instead; never grant Debug or alter Controller token ACL.
        CorePolicy.Require(ProcessCreation(process) == spec.expectedControllerCreationTime && !image.reparse &&
          image.sha256 == spec.expectedBinarySha256, "Named pipe server identity changed");
      }
      finally { CloseHandle(process); }
    }

    public override FixtureChannel ConnectSubjectChannel(FixtureSpec spec)
    {
      CorePolicy.Require(Object.ReferenceEquals(spec, subjectContext), "Native subject context is not bound");
      StageBIdentity(spec, "historical-v078-subject");
      CorePolicy.AssertStandard(InspectCurrentToken(), spec.expectedSid);
      NativePipeChannel pipe = NativePipeChannel.Client(spec.pipeName);
      try
      {
        VerifyServer(spec, pipe);
        subjectPeerAuthenticated = true;
        return pipe;
      }
      catch { pipe.Dispose(); throw; }
    }

    public override void StopOwnedJobs(FixtureState state)
    {
      CorePolicy.Require(state != null, "Missing owned resource state");
      if (state.job != IntPtr.Zero)
      {
        if (JobActive(state.job) != 0) Win(TerminateJobObject(state.job, 241), "TerminateJobObject Controller-owned scope");
        WaitJobEmpty(state.job, 5000);
      }
      if (state.subject != null)
      {
        if (state.subject.job != IntPtr.Zero) StopChild(state.subject);
        else if (!state.subject.assigned && state.subject.process != IntPtr.Zero && ProcessAlive(state.subject.process))
        {
          CorePolicy.Require(!state.subject.resumed, "Unassigned subject unexpectedly resumed");
          Win(TerminateProcess(state.subject.process, 241), "TerminateProcess owned suspended subject");
        }
        if (state.subject.process != IntPtr.Zero)
          CorePolicy.Require(WaitForSingleObject(state.subject.process, 5000) == 0, "Owned subject did not terminate");
        state.subject.exited = true;
      }
      state.jobsEmpty = true;
    }

    public override bool HasOwnedSidProcesses(FixtureState state)
    {
      Real(state);
      if (!state.accountCreated) return false;
      CorePolicy.Require(state.accountBound && state.account != null, "No bound SID for process census");
      foreach (Process candidate in Process.GetProcesses())
      {
        try
        {
          int pid = candidate.Id;
          if (pid == 0 || pid == 4) continue; // Kernel/system pseudo-processes cannot be the new local user.
          IntPtr process = OpenProcess(ProcessQueryLimited, false, checked((uint)pid));
          if (process == IntPtr.Zero)
          {
            int error = Marshal.GetLastWin32Error();
            if (error == 87) continue; // Exited between enumeration and open.
            throw new InvalidOperationException("Owned SID census contains an unreadable process (Win32 " + error.ToString(CultureInfo.InvariantCulture) + ")");
          }
          try
          {
            string creation = ProcessCreation(process), before;
            // A process with the exact same pre-account creation identity
            // cannot run under the account which did not exist at that time.
            if (preexistingProcesses.TryGetValue(pid, out before) && before == creation) continue;
            TokenIdentity token = ProcessToken(process);
            if (token.sid == state.account.sid) return true;
          }
          finally { CloseHandle(process); }
        }
        finally { candidate.Dispose(); }
      }
      return false;
    }

    public override void CloseRuntimeResources(FixtureState state)
    {
      CorePolicy.Require(state != null && state.jobsEmpty, "Runtime resources cannot be closed before owned jobs are empty");
      if (state.channel != null) { state.channel.Dispose(); state.channel = null; }
      if (state.subject != null) { CloseChild(state.subject); state.subject = null; }
      if (state.job != IntPtr.Zero) { Win(CloseHandle(state.job), "Close Controller-owned Job"); state.job = IntPtr.Zero; }
      if (state.environment != IntPtr.Zero) { Win(DestroyEnvironmentBlock(state.environment), "DestroyEnvironmentBlock"); state.environment = IntPtr.Zero; }
      if (desktopCreator != null)
      {
        desktopCreator.WaitForExit(5000);
        desktopCreator = null;
      }
      if (state.originalStation != IntPtr.Zero && GetProcessWindowStation() != state.originalStation)
        Win(SetProcessWindowStation(state.originalStation), "Restore original station for cleanup");
      AssertOriginalUi(state);
      if (state.desktop != IntPtr.Zero) { Win(CloseDesktop(state.desktop), "Close owned Desktop"); state.desktop = IntPtr.Zero; }
      if (state.station != IntPtr.Zero) { Win(CloseWindowStation(state.station), "Close owned WindowStation"); state.station = IntPtr.Zero; }
      // GetProcessWindowStation / GetThreadDesktop returned borrowed handles.
      state.originalStation = IntPtr.Zero; state.originalDesktop = IntPtr.Zero;
      if (originalControllerImageSecurity != null)
      {
        FileIdentity image = IdentifyPath(originalControllerImagePath, false);
        CorePolicy.Require(originalControllerImageIdentity != null && image.fileId == originalControllerImageIdentity.fileId &&
          image.sha256 == originalControllerImageIdentity.sha256 && !image.reparse, "Controller fixture image changed before ACL restoration");
        File.SetAccessControl(originalControllerImagePath, originalControllerImageSecurity);
        originalControllerImageSecurity = null; originalControllerImageIdentity = null; originalControllerImagePath = null;
      }
    }

    public override void UnloadProfile(FixtureState state)
    {
      HistoricalController(state);
      CorePolicy.Require(state.accountBound && state.profileLoaded && state.profile != IntPtr.Zero &&
        state.token != IntPtr.Zero && state.jobsEmpty, "Paired profile unload precondition failed");
      VerifyOwnedAccount(state, true);
      Real(state);
      Win(UnloadUserProfile(state.token, state.profile), "UnloadUserProfile");
      state.profile = IntPtr.Zero; state.profileLoaded = false;
    }

    public override bool HivesAbsent(FixtureState state)
    {
      Real(state);
      CorePolicy.Require(state.accountBound && state.account != null, "Hive absence has no bound SID");
      foreach (RegistryView view in new RegistryView[] { RegistryView.Registry32, RegistryView.Registry64 })
      using (RegistryKey users = RegistryKey.OpenBaseKey(RegistryHive.Users, view))
      {
        using (RegistryKey sid = users.OpenSubKey(state.account.sid, false))
          if (sid != null) return false;
        using (RegistryKey classes = users.OpenSubKey(state.account.sid + "_Classes", false))
          if (classes != null) return false;
      }
      return true;
    }

    public override void DeleteOwnedProfile(FixtureState state)
    {
      VerifyOwnedAccount(state, true);
      CorePolicy.Require(state.profileCreationAttempts == 1 && state.profileOwnershipProven && !state.profileCreationUncertain
        && state.profileCreationSucceeded && state.profileCreationIdentity != null && state.profileCreationPin == null && !state.profileDeleteAttempted
        && state.profileCreated && !state.profileLoaded && state.profile == IntPtr.Zero &&
        state.jobsEmpty && HivesAbsent(state) && !HasOwnedSidProcesses(state) && state.profileIdentity != null, "Owned profile cannot yet be deleted");
      state.profileCreationUncertain = true;
      using (ProfileDirectoryPin pin = new ProfileDirectoryPin(state.profilePath))
      {
        AssertOwnedProfileMetadata(state, pin);
        CorePolicy.Require(OwnProfileRegistration(state, true, pin.initial.ownerSid == "S-1-5-32-544"), "Owned profile registration disappeared before deletion");
        pin.VerifyUnchanged();
        Real(state);
      }
      state.profileDeleteAttempted = true;
      bool deleted = DeleteProfileW(state.account.sid, state.profilePath, null);
      int deleteError = Marshal.GetLastWin32Error();
      ProfileTrace(state, "DeleteProfile terminal; success=" + deleted + "; Win32=" + deleteError);
      bool absent = ProfileDirectoryAbsent(state.profilePath);
      if (!absent) using (ProfileDirectoryPin pin = new ProfileDirectoryPin(state.profilePath)) AssertOwnedProfileMetadata(state, pin);
      if (!deleted) throw new InvalidOperationException("DeleteProfileW failed (Win32 " + deleteError.ToString(CultureInfo.InvariantCulture) + ")");
      CorePolicy.Require(absent && HivesAbsent(state) && !HasOwnedSidProcesses(state), "Userenv did not remove the owned profile");
      CorePolicy.Require(!OwnProfileRegistration(state, false), "Userenv left owned profile registration behind");
      state.profileCreated = false;
      state.profileCreationUncertain = false;
    }

    private static bool ProfileDirectoryAbsent(string path)
    {
      try { File.GetAttributes(path); return false; }
      catch (FileNotFoundException) { return true; }
      catch (DirectoryNotFoundException) { return true; }
    }

    public override void DeleteOwnedAccount(FixtureState state)
    {
      VerifyOwnedAccount(state, true);
      CorePolicy.Require(!state.profileCreationUncertain && (state.profileCreationAttempts == 0 || state.profileOwnershipProven)
        && !state.profileCreated && !state.profileLoaded && state.profile == IntPtr.Zero &&
        state.jobsEmpty && HivesAbsent(state) && !HasOwnedSidProcesses(state), "Owned account cannot yet be deleted");
      Real(state);
      Net(NetUserDel(null, state.sam), "NetUserDel");
      CorePolicy.Require(ReadAccount(state.sam) == null, "Owned account deletion did not complete");
      state.accountCreated = false;
    }

    public override void CloseTokenAndPrivileges(FixtureState state)
    {
      if (state == null) return;
      // A failed UnloadUserProfile remains failed. Closing the token never
      // relabels the hive as unloaded, and hProfile is not closed separately.
      if (state.token != IntPtr.Zero) { Win(CloseHandle(state.token), "Close target token"); state.token = IntPtr.Zero; }
      if (state.privilegeScope != null) { state.privilegeScope.Dispose(); state.privilegeScope = null; }
    }

    [DataContract]
    private sealed class AbiSpec
    {
      [DataMember] public int version = 1;
      [DataMember] public string mode = "abi-owned-child";
      [DataMember] public string root;
      [DataMember] public FileIdentity rootIdentity;
      [DataMember] public string output;
      [DataMember] public string nonce;
      [DataMember] public string pipeName;
      [DataMember] public string expectedSid;
      [DataMember] public int parentPid;
      [DataMember] public string parentCreationTime;
      [DataMember] public string binarySha256;
      [DataMember] public string desktopName;
    }

    private static void AbiOperatingSystem()
    {
      CorePolicy.Require(Environment.OSVersion.Platform == PlatformID.Win32NT && IntPtr.Size == 8 &&
        Environment.Is64BitOperatingSystem &&
        String.Equals(Environment.GetEnvironmentVariable("CI"), "true", StringComparison.OrdinalIgnoreCase),
        "Native ABI harness requires disposable Windows x64 CI");
    }

    private static void WriteNewJson(string path, object value)
    {
      byte[] bytes = new UTF8Encoding(false, true).GetBytes(CoreJson.Serialize(value));
      using (FileStream output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
      {
        output.Write(bytes, 0, bytes.Length);
        output.Flush(true);
      }
    }

    internal static Dictionary<string, string> BindAbiRuntimeEnvironment(string binaryDirectory, Dictionary<string, string> inherited)
    {
      CorePolicy.ValidateAbsolutePath(binaryDirectory);
      CorePolicy.Require(inherited != null, "ABI private runtime environment is missing");
      string home = Path.Combine(binaryDirectory, "home"), temporary = Path.Combine(home, "tmp");
      Dictionary<string, string> expected = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
        { "HOME", home }, { "USERPROFILE", home }, { "APPDATA", Path.Combine(home, ".config") },
        { "LOCALAPPDATA", Path.Combine(home, ".local") }, { "TEMP", temporary }, { "TMP", temporary }, { "TMPDIR", temporary }
      };
      foreach (KeyValuePair<string, string> path in expected)
      {
        string value;
        CorePolicy.Require(inherited.TryGetValue(path.Key, out value), "ABI private runtime path is missing");
        CorePolicy.ValidateAbsolutePath(value);
        CorePolicy.Require(CorePolicy.SamePath(value, path.Value) && CorePolicy.IsInside(binaryDirectory, value), "ABI private runtime path binding failed");
      }
      return expected; // Never copy provider credentials or arbitrary parent env.
    }

    private static readonly string[] AbiSystemNames = {
      "SystemRoot", "WINDIR", "SystemDrive", "ComSpec", "OS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432", "NUMBER_OF_PROCESSORS"
    };

    internal static Dictionary<string, string> BindAbiSystemEnvironment(Dictionary<string, string> inherited, Dictionary<string, string> tokenEnvironment)
    {
      CorePolicy.Require(inherited != null && tokenEnvironment != null, "ABI system environment is missing");
      string root, tokenRoot;
      CorePolicy.Require(inherited.TryGetValue("SystemRoot", out root) && tokenEnvironment.TryGetValue("SystemRoot", out tokenRoot)
        && CorePolicy.SamePath(root, tokenRoot), "ABI system root identity differs");
      CorePolicy.ValidateAbsolutePath(root);
      Dictionary<string, string> result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      foreach (string name in AbiSystemNames)
      {
        string value;
        if (inherited.TryGetValue(name, out value) && !String.IsNullOrEmpty(value)) result[name] = value;
      }
      string windows;
      if (result.TryGetValue("WINDIR", out windows))
        CorePolicy.Require(CorePolicy.SamePath(windows, root), "ABI Windows directory differs from system root");
      return result;
    }

    private Dictionary<string, string> AbiEnvironment(Dictionary<string, string> actual, string root)
    {
      Dictionary<string, string> parentSystem = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      foreach (string name in AbiSystemNames)
      {
        string value = Environment.GetEnvironmentVariable(name);
        if (value != null) parentSystem[name] = value;
      }
      Dictionary<string, string> result = BindAbiSystemEnvironment(parentSystem, actual);
      result["CI"] = "true";
      string binaryDirectory = Path.GetDirectoryName(CorePolicy.BinaryPath);
      Dictionary<string, string> inherited = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      foreach (string name in new string[] { "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR" })
        inherited[name] = Environment.GetEnvironmentVariable(name);
      Dictionary<string, string> runtime = BindAbiRuntimeEnvironment(binaryDirectory, inherited);
      FileIdentity binaryRoot = IdentifyPath(binaryDirectory, true);
      CorePolicy.Require(!binaryRoot.reparse && CorePolicy.SamePath(Path.GetDirectoryName(root), runtime["TEMP"]), "ABI protocol root is not a private temporary child");
      foreach (string path in runtime.Values.Distinct(StringComparer.OrdinalIgnoreCase))
      {
        FileIdentity directory = IdentifyPath(path, true);
        CorePolicy.Require(!directory.reparse && directory.volumePath == binaryRoot.volumePath
          && CorePolicy.IsInside(binaryRoot.canonicalPath, directory.canonicalPath), "ABI runtime directory escaped its compiler sandbox");
      }
      // Reuse the parent's verified private scratch context, not the protocol
      // root or the real token's profile environment. Identity still comes from
      // native token/known-folder queries and every existing hello comparison.
      foreach (KeyValuePair<string, string> path in runtime) result[path.Key] = path.Value;
      result["PATH"] = Path.Combine(result["SystemRoot"], "System32") + ";" + result["SystemRoot"];
      return result;
    }

    internal static bool IsAbiObservation(string row)
    {
      return row != null && row.Length <= 128 && System.Text.RegularExpressions.Regex.IsMatch(row,
        @"\A(?:env-(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|SystemRoot|WINDIR|SystemDrive|ComSpec|OS|PROCESSOR_ARCHITECTURE|PROCESSOR_ARCHITEW6432|NUMBER_OF_PROCESSORS|PATH)|token-core|roaming-explicit|roaming-current|roaming-current-error|roaming-is-profile-default|roaming-is-private-default|roaming-is-appdata)=(?:[0-9a-f]{64}|[01]|none)\z",
        System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    }

    private static string TokenCoreHash(TokenIdentity identity)
    {
      if (identity == null) return CorePolicy.HashText("missing");
      return CorePolicy.HashText(String.Format(CultureInfo.InvariantCulture, "{0}|{1}|{2}|{3}|{4}|{5}|{6}",
        identity.sid, identity.tokenType, identity.integrityRid, identity.elevated ? 1 : 0,
        identity.elevationType, identity.sessionId, identity.authenticationId));
    }

    private static List<string> AbiObservations(KnownPaths paths, TokenIdentity identity)
    {
      List<string> rows = new List<string>();
      foreach (string name in new string[] { "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR" }.Concat(AbiSystemNames).Concat(new string[] { "PATH" }))
      {
        string value = Environment.GetEnvironmentVariable(name);
        rows.Add("env-" + name + "=" + (value == null ? "none" : CorePolicy.HashText(CorePolicy.NormalizePath(value).ToUpperInvariant())));
      }
      rows.Add("token-core=" + TokenCoreHash(identity));
      rows.Add("roaming-explicit=" + CorePolicy.HashText(paths.roaming));
      try { rows.Add("roaming-current=" + CorePolicy.HashText(KnownFolder("3EB685DB-65F9-4CF6-A03A-E3EF65729F3D", IntPtr.Zero))); }
      catch (Exception error) { rows.Add("roaming-current-error=" + CorePolicy.HashText(SafeFailure(error))); }
      string privateProfile = Environment.GetEnvironmentVariable("USERPROFILE");
      rows.Add("roaming-is-profile-default=" + (CorePolicy.SamePath(paths.roaming, Path.Combine(paths.profile, "AppData", "Roaming")) ? "1" : "0"));
      rows.Add("roaming-is-private-default=" + (privateProfile != null && CorePolicy.SamePath(paths.roaming, Path.Combine(privateProfile, "AppData", "Roaming")) ? "1" : "0"));
      rows.Add("roaming-is-appdata=" + (CorePolicy.SamePath(paths.roaming, Environment.GetEnvironmentVariable("APPDATA")) ? "1" : "0"));
      return rows;
    }

    private static void RecordAbiObservations(FixtureReport report, string role, IEnumerable<string> rows)
    {
      if (rows == null) { report.trace.Add("ABI observation missing role=" + role); return; }
      foreach (string row in rows.Take(32))
        report.trace.Add(IsAbiObservation(row) ? "ABI observation role=" + role + "; " + row : "ABI observation rejected role=" + role);
    }

    private static void ValidateAbiRoot(AbiSpec spec, NativePlatform platform)
    {
      CorePolicy.Require(spec != null && spec.version == 1 && spec.mode == "abi-owned-child" &&
        spec.nonce != null && spec.nonce.Length == 32 && spec.nonce.All(Uri.IsHexDigit) &&
        spec.pipeName == "CcHaha1879-abi-" + spec.nonce, "ABI child spec is invalid");
      CorePolicy.ValidateAbsolutePath(spec.root); CorePolicy.ValidateAbsolutePath(spec.output);
      string name = Path.GetFileName(spec.root);
      CorePolicy.Require(name != null && name.StartsWith("cc-haha-native-abi-", StringComparison.Ordinal) &&
        name.Length == "cc-haha-native-abi-".Length + 32 &&
        name.Substring("cc-haha-native-abi-".Length).All(Uri.IsHexDigit) &&
        CorePolicy.SamePath(Path.GetDirectoryName(spec.output), spec.root) && Path.GetFileName(spec.output) == "child.json",
        "ABI child output is not an owned bounded file");
      FileIdentity root = platform.IdentifyPath(spec.root, true);
      CorePolicy.Require(spec.rootIdentity != null && !root.reparse && root.fileId == spec.rootIdentity.fileId &&
        root.volumePath == spec.rootIdentity.volumePath && CorePolicy.SamePath(root.canonicalPath, spec.rootIdentity.canonicalPath),
        "ABI directory identity changed");
      CorePolicy.Require(File.ReadAllText(Path.Combine(spec.root, "owner.txt"), Encoding.UTF8) == spec.nonce, "ABI ownership marker changed");
    }

    internal static int RunAbiChild(string specPath)
    {
      NativePlatform platform = new NativePlatform();
      NativePipeChannel channel = null;
      string verifiedOutput = null;
      try
      {
        AbiOperatingSystem();
        // Match the parent's read-only native snapshot before managed spec
        // deserialization can initialize per-process folder/configuration state.
        // The untrusted spec still gates every output, pipe, and launch action.
        TokenIdentity identity = platform.InspectCurrentToken();
        KnownPaths paths = platform.QueryKnownPaths(IntPtr.Zero);
        CorePolicy.ValidateAbsolutePath(specPath);
        AbiSpec spec = CoreJson.Read<AbiSpec>(specPath);
        ValidateAbiRoot(spec, platform);
        CorePolicy.Require(CorePolicy.SamePath(specPath, Path.Combine(spec.root, "child-spec.json")) &&
          CorePolicy.SamePath(CorePolicy.BinaryPath, Path.Combine(spec.root, "fixture.exe")) &&
          CorePolicy.HashFile(CorePolicy.BinaryPath) == spec.binarySha256, "ABI same-binary spec binding failed");
        verifiedOutput = spec.output;
        CorePolicy.Require(identity.sid == spec.expectedSid && identity.tokenType == 1, "ABI child identity changed");
        CorePolicy.Require(platform.CurrentPrivateDesktopName() == spec.desktopName, "ABI child did not use the private desktop");
        channel = NativePipeChannel.Client(spec.pipeName);
        CorePolicy.Require(channel.PeerProcessId == spec.parentPid && spec.parentPid > 0, "ABI pipe server is not its parent");
        IntPtr parent = OpenProcess(ProcessQueryLimited, false, checked((uint)spec.parentPid));
        Win(parent != IntPtr.Zero, "Open ABI parent for read-only verification");
        try
        {
          FileIdentity image = platform.ProcessImage(parent);
          CorePolicy.Require(ProcessCreation(parent) == spec.parentCreationTime && platform.ProcessToken(parent).sid == spec.expectedSid &&
            !image.reparse && image.sha256 == spec.binarySha256, "ABI parent identity changed");
        }
        finally { CloseHandle(parent); }
        ProtocolMessage hello = new ProtocolMessage {
          kind = "abi-hello", nonce = spec.nonce, specSha256 = CorePolicy.HashFile(specPath),
          binarySha256 = spec.binarySha256, pid = checked((int)GetCurrentProcessId()),
          creationTime = ProcessCreation(GetCurrentProcess()), sid = identity.sid, identity = identity, knownPaths = paths,
          report = new FixtureReport { mode = "abi-readonly-observations", trace = AbiObservations(paths, identity) }
        };
        channel.WriteLine(CoreJson.Serialize(hello));
        ProtocolMessage ack = CoreJson.Deserialize<ProtocolMessage>(channel.ReadLine(10000));
        CorePolicy.Require(ack != null && ack.version == 1 && ack.kind == "abi-ack" && ack.nonce == spec.nonce &&
          ack.binarySha256 == spec.binarySha256 && ack.specSha256 == hello.specSha256, "ABI nonce acknowledgement failed");
        CorePolicy.Require(platform.controllerContext == null && platform.subjectContext == null && !platform.subjectProductsAllowed,
          "ABI child accidentally acquired a stage B context");
        WriteNewJson(spec.output, hello);
        return 0;
      }
      catch (Exception error)
      {
        if (verifiedOutput != null && !File.Exists(verifiedOutput))
        {
          try { WriteNewJson(verifiedOutput, new CheckResult { name = "abi-child", status = "failed", detail = SafeFailure(error) }); }
          catch { }
        }
        return 81;
      }
      finally { if (channel != null) channel.Dispose(); }
    }

    private static void RemoveAbiRoot(string root, FileIdentity expected, NativePlatform platform)
    {
      if (root == null) return;
      if (expected == null)
      {
        CorePolicy.Require(!Directory.Exists(root) && !File.Exists(root), "ABI root ownership was not established; possible remaining root");
        return;
      }
      FileIdentity actual = platform.IdentifyPath(root, true);
      CorePolicy.Require(!actual.reparse && actual.fileId == expected.fileId && actual.volumePath == expected.volumePath, "ABI cleanup root changed");
      string[] names = { "fixture.exe", "child-spec.json", "child.json", "owner.txt" };
      foreach (string path in Directory.GetFileSystemEntries(root))
      {
        CorePolicy.Require(names.Contains(Path.GetFileName(path), StringComparer.Ordinal) &&
          (File.GetAttributes(path) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0, "ABI cleanup found an unowned entry");
      }
      foreach (string name in names)
      {
        string file = Path.Combine(root, name);
        if (File.Exists(file))
        {
          FileAttributes attributes = File.GetAttributes(file);
          if ((attributes & FileAttributes.ReadOnly) != 0) File.SetAttributes(file, attributes & ~FileAttributes.ReadOnly);
          File.Delete(file);
        }
      }
      Directory.Delete(root, false);
      CorePolicy.Require(!Directory.Exists(root), "ABI directory cleanup incomplete");
    }

    internal static bool CheckAbiHello(FixtureReport report, ProtocolMessage hello, int peerPid, ProtocolMessage expected)
    {
      CorePolicy.Require(expected != null && expected.pid > 0 && expected.version == 1 && expected.kind == "abi-hello", "Invalid expected ABI hello");
      ProtocolMessage actual = hello ?? new ProtocolMessage();
      report.Check("abi-hello-frame", hello != null && actual.version == 1 && actual.kind == "abi-hello", "Requires a nonempty v1 abi-hello frame");
      report.Check("abi-hello-endpoint-pid", peerPid == expected.pid,
        "Expected held PID=" + expected.pid.ToString(CultureInfo.InvariantCulture) + "; actual pipe peer PID=" + peerPid.ToString(CultureInfo.InvariantCulture));
      report.Check("abi-hello-message-pid", actual.pid == expected.pid,
        "Expected held PID=" + expected.pid.ToString(CultureInfo.InvariantCulture) + "; message PID=" + actual.pid.ToString(CultureInfo.InvariantCulture));
      string[] labels = { "nonce", "creation", "sid", "binary", "spec" };
      string[] actualValues = { actual.nonce, actual.creationTime, actual.sid, actual.binarySha256, actual.specSha256 };
      string[] expectedValues = { expected.nonce, expected.creationTime, expected.sid, expected.binarySha256, expected.specSha256 };
      for (int i = 0; i < labels.Length; i++)
        report.Check("abi-hello-" + labels[i], actualValues[i] != null && actualValues[i] == expectedValues[i],
          "Expected SHA256=" + CorePolicy.HashText(expectedValues[i] ?? "") + "; observed SHA256=" + CorePolicy.HashText(actualValues[i] ?? ""));
      KnownPaths observed = actual.knownPaths ?? new KnownPaths(), paths = expected.knownPaths ?? new KnownPaths();
      string[] folders = { "profile", "roaming", "local", "desktop", "programs", "startMenu", "userPrograms" };
      string[] observedPaths = { observed.profile, observed.roaming, observed.local, observed.desktop, observed.programs, observed.startMenu, observed.userPrograms };
      string[] expectedPaths = { paths.profile, paths.roaming, paths.local, paths.desktop, paths.programs, paths.startMenu, paths.userPrograms };
      for (int i = 0; i < folders.Length; i++)
        report.Check("abi-hello-folder-" + folders[i], CorePolicy.SamePath(observedPaths[i], expectedPaths[i]),
          "Expected path SHA256=" + CorePolicy.HashText(expectedPaths[i] ?? "") + "; observed path SHA256=" + CorePolicy.HashText(observedPaths[i] ?? ""));
      return report.checks.All(check => check.status == "passed");
    }

    private static void RecordAbiRootInventory(FixtureReport report, string phase, string root, FileIdentity expected, NativePlatform platform)
    {
      try
      {
        if (root == null || expected == null) return;
        FileIdentity actual = platform.IdentifyPath(root, true);
        CorePolicy.Require(!actual.reparse && actual.fileId == expected.fileId && actual.volumePath == expected.volumePath, "ABI inventory root changed");
        string[] expectedNames = { "fixture.exe", "child-spec.json", "child.json", "owner.txt" };
        int count = 0;
        // Only inspect the immediate owned-root entries. Never traverse an
        // unknown directory or reparse point to obtain diagnostic evidence.
        foreach (string entry in Directory.EnumerateFileSystemEntries(root).Take(33))
        {
          if (count++ >= 32) { report.trace.Add("ABI diagnostic inventory truncated at32 phase=" + phase); break; }
          FileAttributes attributes = File.GetAttributes(entry);
          bool reparse = (attributes & FileAttributes.ReparsePoint) != 0, folder = (attributes & FileAttributes.Directory) != 0;
          string name = Path.GetFileName(entry);
          string label = expectedNames.Concat(new string[] { "Microsoft", "CLR_v4.0", "UsageLogs", "fixture.exe.log" })
            .Contains(name, StringComparer.Ordinal) ? name : "other";
          report.trace.Add("ABI diagnostic entry phase=" + phase + "; label=" + label + "; nameSHA256=" + CorePolicy.HashText(name) +
            "; expectedBaseName=" + (expectedNames.Contains(name, StringComparer.Ordinal) ? "1" : "0") +
            "; type=" + (folder ? "directory" : "file") + "; reparse=" + (reparse ? "1" : "0") +
            "; attributes=" + ((int)attributes).ToString(CultureInfo.InvariantCulture));
        }
      }
      catch (Exception error) { report.trace.Add("ABI diagnostic inventory failed phase=" + phase + ": " + SafeFailure(error)); }
      // Inventory is read-only evidence. It does not authorize any extra delete.
    }

    private static void RunOwnedProfilePinProbe(NativePlatform platform, FixtureState state, string root, FixtureReport report)
    {
      string path = Path.Combine(root, "profile-pin-probe"), renamed = path + "-renamed";
      FileIdentity expected = null; bool created = false;
      CorePolicy.Require(!Directory.Exists(path) && !File.Exists(path) && !Directory.Exists(renamed) && !File.Exists(renamed), "ABI profile pin probe collision");
      try
      {
        int error; created = CreatePrivateDirectoryAtomically(path, state.runnerSid, null, out error);
        CorePolicy.Require(created, "ABI profile pin probe creation failed");
        using (ProfileDirectoryPin pin = new ProfileDirectoryPin(path))
        {
          expected = CopyProfileIdentity(pin.initial.identity);
          RequireTrustedProfileDacl(pin.initial, state.runnerSid, false);
          CorePolicy.Require(pin.initial.ownerSid == state.runnerSid && pin.initial.descriptorSha256.Length == 64, "ABI same-handle metadata binding failed");
          pin.VerifyUnchanged();
          report.Check("owned-profile-metadata-same-handle", true, "No-follow noninherited directory handle supplied identity and bounded GetSecurityInfo owner/DACL; no account/profile context.");
          bool renameDenied = false, deleteDenied = false;
          try { Directory.Move(path, renamed); }
          catch (IOException) { renameDenied = true; }
          catch (UnauthorizedAccessException) { renameDenied = true; }
          CorePolicy.Require(renameDenied && Directory.Exists(path) && !Directory.Exists(renamed), "Profile pin did not reject owned rename");
          try { Directory.Delete(path); }
          catch (IOException) { deleteDenied = true; }
          catch (UnauthorizedAccessException) { deleteDenied = true; }
          CorePolicy.Require(deleteDenied && Directory.Exists(path), "Profile pin did not reject owned deletion");
          pin.VerifyUnchanged();
          report.Check("owned-profile-pin-rename-delete-refused", true, "READ|WRITE share without DELETE refused rename and deletion of the exact empty owned directory.");
        }
        Directory.Move(path, renamed);
        FileIdentity moved = platform.IdentifyPath(renamed, true);
        CorePolicy.Require(!moved.reparse && moved.fileId == expected.fileId && moved.volumePath == expected.volumePath, "Released ABI pin probe identity changed");
        Directory.Move(renamed, path);
        CorePolicy.Require(FreshProfileIdentityRelation(expected, platform.IdentifyPath(path, true)) == "same-identity", "Released ABI pin probe path changed");
        Directory.Delete(path);
        CorePolicy.Require(ProfileDirectoryAbsent(path) && ProfileDirectoryAbsent(renamed), "Released ABI pin probe remained");
        report.Check("owned-profile-pin-release-restores-operations", true, "After explicit close the same owned directory could be renamed and deleted; no userenv API invoked.");
      }
      finally
      {
        if (created && expected != null)
          foreach (string candidate in new string[] { path, renamed })
            if (!ProfileDirectoryAbsent(candidate))
            {
              FileIdentity remaining = platform.IdentifyPath(candidate, true);
              CorePolicy.Require(!remaining.reparse && remaining.fileId == expected.fileId && remaining.volumePath == expected.volumePath
                && Directory.GetFileSystemEntries(candidate).Length == 0, "ABI profile pin cleanup ownership is unknown");
              Directory.Delete(candidate);
            }
      }
    }

    private static void RunProfilesParentProbe(FixtureReport report, string runnerSid)
    {
      // This SID is a fixed synthetic fixture value, never derived from a
      // queried machine/domain SID. Only read the namespace, not user entries.
      const string syntheticBoundSid = "S-1-5-21-1879-1879-1879-4242";
      CorePolicy.Require(!String.IsNullOrEmpty(runnerSid) && syntheticBoundSid != runnerSid, "Synthetic ABI bound SID must differ from runner");
      string profiles = ReadProfilesDirectory();
      string[] parents = CorePolicy.ProfileParentPaths(profiles, profiles);
      bool allTrusted = true; int aceDiagnosticCharacters = 0;
      using (ProfileDirectoryPin profilesPin = ProfileDirectoryPin.OpenAncestor(profiles, profiles, profiles))
      {
        for (int index = 0; index < parents.Length; index++)
        {
          using (ProfileDirectoryPin pin = ProfileDirectoryPin.OpenAncestor(parents[index], profiles, profiles))
          {
            // Record structured read-only facts before the strict policy can
            // refuse them. These strings never enter an authorization branch.
            report.trace.Add("ABI readonly ProfilesDirectory ancestor index=" + index.ToString(CultureInfo.InvariantCulture)
              + "; pathSha256=" + CorePolicy.HashText(parents[index]) + "; leaseGranted=false");
            report.trace.Add(ProfileOwnerObservation(pin.initial.ownerSid, syntheticBoundSid, null, null));
            report.trace.Add(ProfileDaclObservation(pin.initial.daclPresent, pin.initial.protectedDacl, pin.initial.aces, syntheticBoundSid));
            foreach (string row in ProfileAceObservations(pin.initial, syntheticBoundSid))
            {
              if (aceDiagnosticCharacters + row.Length > 262144)
              {
                report.trace.Add("ABI readonly ACE diagnostic budget exhausted; remaining ACE observations unknown; leaseGranted=false");
                break;
              }
              report.trace.Add("ABI readonly ancestor=" + index.ToString(CultureInfo.InvariantCulture) + "; " + row);
              aceDiagnosticCharacters += row.Length;
            }
            bool trusted = false;
            try { pin.RequireTrustedParentDacl(syntheticBoundSid, profilesPin.initial.identity); trusted = true; }
            catch (FixtureFailure) { allTrusted = false; }
            pin.VerifyUnchanged();
            report.trace.Add("ABI readonly ProfilesDirectory parent-policy index=" + index.ToString(CultureInfo.InvariantCulture)
              + "; policyPassed=" + trusted + "; leaseGranted=false");
          }
        }
        profilesPin.VerifyUnchanged();
      }
      report.Check("readonly-profiles-parent-chain", allTrusted,
        "Complete actual ProfilesDirectory-to-volume-root chain used production no-follow metadata pins and parent policy with a fixed synthetic SID; no account or profile API, child enumeration, mutation or lease.");
    }

    internal static FixtureReport RunAbiHarness(string outputPath)
    {
      FixtureReport report = new FixtureReport { mode = "abi-harness" };
      NativePlatform platform = new NativePlatform();
      FixtureState state = new FixtureState { report = report, spec = new FixtureSpec { mode = "abi-harness", version = 1 } };
      string root = null;
      FileIdentity rootIdentity = null;
      NativePipeChannel pipe = null;
      bool cleaned = false;
      IntPtr originalStation = GetProcessWindowStation();
      IntPtr originalDesktop = GetThreadDesktop(GetCurrentThreadId());
      try
      {
        AbiOperatingSystem();
        CorePolicy.ValidateAbsolutePath(outputPath);
        CorePolicy.Require(!File.Exists(outputPath), "ABI final output already exists");
        string parent = Path.GetDirectoryName(outputPath);
        CorePolicy.Require(Directory.Exists(parent) && !platform.IdentifyPath(parent, true).reparse, "ABI parent directory is unstable");
        report.Check("x64-native-layouts", IntPtr.Size == 8 &&
          Marshal.SizeOf(typeof(StartupInfo)) == 104 && Marshal.SizeOf(typeof(ProcessInformation)) == 24 &&
          Marshal.SizeOf(typeof(ProfileInfo)) == 56 && Marshal.SizeOf(typeof(ExtendedLimits)) == 144 &&
          Marshal.SizeOf(typeof(JobAccounting)) == 48 &&
          Marshal.OffsetOf(typeof(TokenGroupsOne), "Group").ToInt32() == 8 &&
          Marshal.OffsetOf(typeof(TokenPrivilegesOne), "Privilege").ToInt32() == 4,
          "Observed marshaled x64 Win32 structure sizes; no profile API invoked");
        CorePolicy.Require(report.checks.All(check => check.status == "passed"), "ABI layout assertion failed");
        state.targetIdentity = platform.InspectCurrentToken();
        state.runnerSid = state.targetIdentity.sid;
        state.runnerPid = checked((int)GetCurrentProcessId());
        state.runnerCreationTime = ProcessCreation(GetCurrentProcess());
        report.Check("current-token-readonly", !String.IsNullOrEmpty(state.runnerSid) && state.targetIdentity.tokenType == 1,
          "Actual current token queried; integrity RID=" + state.targetIdentity.integrityRid.ToString(CultureInfo.InvariantCulture) +
          ", elevated=" + state.targetIdentity.elevated.ToString() + "; this is not a new standard SID/profile claim");
        state.paths = platform.QueryKnownPaths(IntPtr.Zero);
        RecordAbiObservations(report, "parent-before", AbiObservations(state.paths, state.targetIdentity));
        report.Check("current-known-folders-readonly", state.paths != null && !String.IsNullOrEmpty(state.paths.profile),
          "Actual token known folders queried with DONT_VERIFY; no profile or folder created");
        root = Path.Combine(parent, "cc-haha-native-abi-" + Guid.NewGuid().ToString("N"));
        CorePolicy.Require(!Directory.Exists(root) && !File.Exists(root), "ABI root collision");
        int createError;
        bool created = CreatePrivateDirectoryAtomically(root, state.runnerSid, null, out createError);
        if (!created) throw new InvalidOperationException("CreateDirectoryW owned ABI root failed (Win32 " + createError.ToString(CultureInfo.InvariantCulture) + ")");
        state.controllerRootOwned = true;
        rootIdentity = platform.IdentifyPath(root, true);
        RunOwnedProfilePinProbe(platform, state, root, report);
        RunProfilesParentProbe(report, state.runnerSid);
        state.spec.controllerRoot = root;
        state.profilePath = state.paths.profile;
        Win(OpenProcessToken(GetCurrentProcess(), TokenQuery | 0x0002 | 0x0004, out state.token), "Open ABI token");
        // Only this internal harness owns the lease, after AbiOperatingSystem,
        // atomic private-root creation and OpenProcessToken(current process).
        // Do not route Stage A through the historical Controller admission.
        Dictionary<string, string> environment;
        platform.abiEnvironmentContext = state;
        try { environment = platform.AbiEnvironment(platform.ReadAbiTokenEnvironment(state), root); }
        finally { platform.abiEnvironmentContext = null; }
        report.Check("private-runtime-context-bound", true,
          "Parent and child share the verified compiler sandbox home/config/local/tmp paths; environment is not SID/profile evidence");
        platform.CreatePrivateDesktop(state);
        report.Check("private-station-desktop", state.station != IntPtr.Zero && state.desktop != IntPtr.Zero &&
          !state.desktopName.StartsWith("winsta0\\", StringComparison.OrdinalIgnoreCase), "Created private noninteractive UI objects; shared UI DACLs untouched");
        report.Check("creator-exited-original-ui-unchanged", platform.desktopCreator != null && !platform.desktopCreator.IsAlive &&
          originalStation != IntPtr.Zero && originalDesktop != IntPtr.Zero && GetProcessWindowStation() == originalStation &&
          GetThreadDesktop(GetCurrentThreadId()) == originalDesktop,
          "Dedicated MTA creator exited; original process station restored and Controller STA desktop unchanged");
        CorePolicy.Require(report.checks.All(check => check.status == "passed"), "Private desktop creator lifecycle failed");
        string binary = Path.Combine(root, "fixture.exe");
        File.Copy(CorePolicy.BinaryPath, binary, false);
        string binaryHash = CorePolicy.HashFile(CorePolicy.BinaryPath);
        CorePolicy.Require(platform.IdentifyPath(binary, false).sha256 == binaryHash, "ABI fixture copy changed");
        string nonce = Guid.NewGuid().ToString("N");
        AbiSpec spec = new AbiSpec {
          root = root, rootIdentity = rootIdentity, output = Path.Combine(root, "child.json"), nonce = nonce,
          pipeName = "CcHaha1879-abi-" + nonce, expectedSid = state.runnerSid,
          parentPid = state.runnerPid, parentCreationTime = state.runnerCreationTime,
          binarySha256 = binaryHash, desktopName = state.desktopName
        };
        File.WriteAllText(Path.Combine(root, "owner.txt"), nonce, new UTF8Encoding(false));
        int collisionError;
        bool collisionCreated = CreatePrivateDirectoryAtomically(root, state.runnerSid, null, out collisionError);
        FileIdentity collisionIdentity = platform.IdentifyPath(root, true);
        bool refused = !collisionCreated && collisionError == 183 &&
          collisionIdentity.fileId == rootIdentity.fileId && collisionIdentity.volumePath == rootIdentity.volumePath &&
          CorePolicy.SamePath(collisionIdentity.canonicalPath, rootIdentity.canonicalPath) &&
          File.ReadAllText(Path.Combine(root, "owner.txt"), Encoding.UTF8) == nonce;
        report.Check("atomic-owned-root-collision-refused", refused,
          "Same owned root: CreateDirectoryW must return ERROR_ALREADY_EXISTS 183 without changing file identity or owner marker");
        CorePolicy.Require(refused, "Atomic ABI root collision was not refused without mutation");
        string specPath = Path.Combine(root, "child-spec.json");
        WriteNewJson(specPath, spec);
        pipe = NativePipeChannel.Server(spec.pipeName, state.runnerSid, state.runnerSid);
        state.subject = new OwnedProcess();
        CommandPlan command = new CommandPlan {
          phase = "abi-owned-child", application = binary, expectedSha256 = binaryHash,
          commandLine = "\"" + binary + "\" --abi-child --spec \"" + specPath + "\"",
          timeoutMilliseconds = 15000, expectedExitCode = 0
        };
        platform.StartChildInternal(state.subject, command, environment, root, state.desktopName, true);
        platform.VerifyChild(state.subject, state.runnerSid, binary, binaryHash);
        report.Check("suspended-child-job-identity", state.subject.assigned && !state.subject.resumed &&
          state.subject.identity.sid == state.runnerSid, "Created only this fixture child; assigned owned no-breakaway Job before resume");
        RecordAbiRootInventory(report, "before-resume", root, rootIdentity, platform);
        platform.ResumeChild(state.subject);
        ProtocolMessage hello = CoreJson.Deserialize<ProtocolMessage>(pipe.ReadLine(10000));
        RecordAbiRootInventory(report, "after-hello", root, rootIdentity, platform);
        RecordAbiObservations(report, "held-before-resume", new string[] { "token-core=" + TokenCoreHash(state.subject.identity) });
        RecordAbiObservations(report, "child", hello != null && hello.report != null && hello.report.mode == "abi-readonly-observations" ? hello.report.trace : null);
        RecordAbiObservations(report, "parent-after", AbiObservations(platform.QueryKnownPaths(IntPtr.Zero), platform.InspectCurrentToken()));
        CorePolicy.Require(CheckAbiHello(report, hello, pipe.PeerProcessId, new ProtocolMessage {
          kind = "abi-hello", nonce = nonce, pid = state.subject.pid, creationTime = state.subject.creationTime,
          sid = state.runnerSid, binarySha256 = binaryHash, specSha256 = CorePolicy.HashFile(specPath), knownPaths = state.paths
        }), "ABI authenticated child response failed");
        pipe.WriteLine(CoreJson.Serialize(new ProtocolMessage {
          kind = "abi-ack", nonce = nonce, binarySha256 = binaryHash, specSha256 = hello.specSha256
        }));
        int exit = platform.WaitChild(state.subject, 15000);
        ProtocolMessage output = CoreJson.Read<ProtocolMessage>(spec.output);
        report.Check("nonce-bound-private-ipc", exit == 0 && output != null && output.nonce == nonce &&
          output.pid == state.subject.pid && output.creationTime == state.subject.creationTime && output.sid == state.runnerSid,
          "Actual endpoint PID, held creation identity, same binary and two-way nonce acknowledgement matched");
        CorePolicy.Require(report.checks.All(check => check.status == "passed"), "ABI assertion failed");
        report.Check("stage-a-no-real-profile-or-product", platform.controllerContext == null && platform.subjectContext == null &&
          !platform.subjectProductsAllowed && !state.accountCreated && !state.profileCreated && !state.profileLoaded,
          "No stage B context was bound; account/profile/HKCU-write/released-PE methods were unreachable");
      }
      catch (Exception error)
      {
        report.Check("native-abi-execution", false, SafeFailure(error));
        if (rootIdentity != null && File.Exists(Path.Combine(root, "child.json")))
        {
          try
          {
            CheckResult childFailure = CoreJson.Read<CheckResult>(Path.Combine(root, "child.json"));
            if (childFailure != null && childFailure.name == "abi-child" && childFailure.status == "failed")
              report.Check("native-abi-child", false, childFailure.detail);
          }
          catch { }
        }
      }
      finally
      {
        try
        {
          if (pipe != null) { pipe.Dispose(); pipe = null; }
          platform.StopOwnedJobs(state);
          platform.CloseRuntimeResources(state);
          platform.CloseTokenAndPrivileges(state);
          CorePolicy.Require(state.subject == null && state.job == IntPtr.Zero && state.station == IntPtr.Zero &&
            state.desktop == IntPtr.Zero && state.environment == IntPtr.Zero && state.token == IntPtr.Zero &&
            platform.desktopCreator == null && GetProcessWindowStation() == originalStation &&
            GetThreadDesktop(GetCurrentThreadId()) == originalDesktop,
            "ABI native resources remain");
          if (state.controllerRootOwned)
          {
            RecordAbiRootInventory(report, "before-root-cleanup", root, rootIdentity, platform);
            RemoveAbiRoot(root, rootIdentity, platform);
          }
          cleaned = true;
          report.cleanup = "passed";
          report.Check("owned-native-cleanup", true, "Owned processes/Job/thread/UI/IPC/environment/token handles closed and private ABI files removed");
        }
        catch (Exception error)
        {
          report.cleanup = "failed";
          report.Check("owned-native-cleanup", false, SafeFailure(error));
        }
      }
      report.finishedAtUtc = DateTime.UtcNow.ToString("o");
      report.trace.AddRange(platform.tokenProbeDiagnostics);
      report.status = cleaned && report.checks.Count > 0 && report.checks.All(check => check.status == "passed") ? "passed" : "failed";
      return report;
    }
  }
}
