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
    private const string SetupSha = "dca6bb82f4d0fbee8d43c91912e4d50e7dcea69a7cb22c51cdd9cb265767c7e7";
    private const long SetupBytes = 230611497;
    private readonly int ownerManagedThread = Thread.CurrentThread.ManagedThreadId;
    private uint ownerNativeThread;
    private readonly Dictionary<int, string> preexistingProcesses = new Dictionary<int, string>();
    private FixtureSpec controllerContext;
    private FixtureSpec subjectContext;
    private bool subjectPeerAuthenticated;
    private bool subjectProductsAllowed;
    private FileSecurity originalControllerImageSecurity;
    private FileIdentity originalControllerImageIdentity;
    private string originalControllerImagePath;
    private readonly List<string> tokenProbeDiagnostics = new List<string>();

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

    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] private static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
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
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr buffer, int length, out int needed);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool LookupPrivilegeNameW(string system, ref Luid luid, StringBuilder name, ref uint length);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool LookupPrivilegeValueW(string system, string name, out Luid luid);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivilegesOne state, uint length, out TokenPrivilegesOne previous, out uint returned);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool LogonUserW(string user, string domain, IntPtr password, int type, int provider, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool LookupAccountNameW(string system, string name, IntPtr sid, ref uint sidBytes, StringBuilder domain, ref uint domainChars, out int use);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool LookupAccountSidW(string system, IntPtr sid, StringBuilder name, ref uint nameChars, StringBuilder domain, ref uint domainChars, out int use);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string descriptor, uint revision, out IntPtr security, out uint size);
    [DllImport("advapi32.dll")] private static extern uint GetSecurityInfo(IntPtr handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)] private static extern int CreateProfile(string sid, string name, StringBuilder path, uint characters);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool LoadUserProfileW(IntPtr token, ref ProfileInfo profile);
    [DllImport("userenv.dll", SetLastError = true)] private static extern bool UnloadUserProfile(IntPtr token, IntPtr profile);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool DeleteProfileW(string sid, string path, string computer);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetUserProfileDirectoryW(IntPtr token, StringBuilder path, ref uint characters);
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
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetThreadDesktop(IntPtr desktop);
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
      // Framework WindowsIdentity seeds a DWORD for TokenSessionId. A 24
      // response need not prove that native code wrote ReturnLength, so retain
      // the seed separately in diagnostics and require a successful exact fill.
      int seedLength = infoClass == 12 ? sizeof(uint) : 0;
      int size = seedLength;
      bool first = GetTokenInformation(token, infoClass, IntPtr.Zero, 0, out size);
      int sizeError = Marshal.GetLastWin32Error();
      string probe = TokenDiagnostic("size", infoClass, first, sizeError, seedLength, 0, size);
      if (!AcceptTokenSizeProbe(infoClass, first, sizeError, size)) throw new TokenInformationFailure(probe);
      int capacity = size;
      IntPtr data = Marshal.AllocHGlobal(capacity);
      try
      {
        int observedLength = 0;
        bool filled = GetTokenInformation(token, infoClass, data, capacity, out observedLength);
        int fillError = Marshal.GetLastWin32Error();
        string fill = TokenDiagnostic("fill", infoClass, filled, fillError, 0, capacity, observedLength);
        // Last-error can be stale on Framework after success. It is evidence,
        // not a reason to reject an otherwise successful, bounded fill.
        if (!filled || observedLength <= 0 || observedLength > capacity ||
          (infoClass == 12 && (capacity != sizeof(uint) || observedLength != sizeof(uint))))
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
      CorePolicy.Require(!state.profileCreated && state.account.groups.Count == 1 && state.account.groups[0] == UsersSid, "Profile creation precondition failed");
      StringBuilder path = new StringBuilder(32768);
      Real(state);
      int status = CreateProfile(state.account.sid, state.sam, path, (uint)path.Capacity);
      CorePolicy.Require(status == 0, "CreateProfile failed (HRESULT " + status.ToString(CultureInfo.InvariantCulture) + ")");
      state.profileCreated = true;
      state.profilePath = path.ToString();
      if (state.report != null) state.report.realProfilesCreated++;
      state.profileIdentity = IdentifyPath(state.profilePath, true);
      CorePolicy.Require(!state.profileIdentity.reparse && !CorePolicy.IsInside(state.spec.gitRoot, state.profilePath), "Fresh profile identity is outside the allowed boundary");
    }

    public override void SetOwnedAccountDisabled(FixtureState state, bool disabled)
    {
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
      VerifyOwnedAccount(state, false);
      CorePolicy.Require(state.profileCreated && !state.profileLoaded && state.token != IntPtr.Zero && state.profile == IntPtr.Zero, "Profile load precondition failed");
      CorePolicy.AssertStandard(InspectToken(state.token), state.account.sid);
      ProfileInfo profile = new ProfileInfo { size = (uint)Marshal.SizeOf(typeof(ProfileInfo)), flags = 1, userName = state.sam };
      Real(state);
      Win(LoadUserProfileW(state.token, ref profile), "LoadUserProfileW");
      state.profile = profile.profile;
      state.profileLoaded = true;
      CorePolicy.Require(state.profile != IntPtr.Zero, "LoadUserProfile returned no hive handle");
      KnownPaths paths = QueryKnownPaths(state.token);
      CorePolicy.Require(CorePolicy.SamePath(paths.profile, state.profilePath), "Loaded profile is not the created profile");
      using (RegistryKey machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
      using (RegistryKey mapping = machine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + state.account.sid, false))
      {
        CorePolicy.Require(mapping != null && CorePolicy.SamePath(Environment.ExpandEnvironmentVariables((string)mapping.GetValue("ProfileImagePath", "", RegistryValueOptions.DoNotExpandEnvironmentNames)), state.profilePath),
          "OS profile registration disagrees with the created profile");
      }
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
      Real(state);
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
      Real(state);
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

    private FileIdentity IdentifyPathCore(string path, bool directory, bool inspectAncestors)
    {
      CorePolicy.ValidateAbsolutePath(path);
      bool reparse = inspectAncestors ? HasReparseComponent(path) : (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
      IntPtr file = CreateFileW(path, directory ? 0x80u : 0x80000000u, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
      CorePolicy.Require(file != new IntPtr(-1), "Native identity file open failed (Win32 " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ")");
      try
      {
        FileInformation info;
        Win(GetFileInformationByHandle(file, out info), "GetFileInformationByHandle");
        string final = HandlePath(file, 0), volume = HandlePath(file, 1);
        CorePolicy.Require(final.StartsWith(@"\\?\", StringComparison.Ordinal) && !final.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase) &&
          volume.StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase), "Unexpected identity namespace");
        int end = volume.IndexOf(@"}\", StringComparison.Ordinal);
        CorePolicy.Require(end > 0, "Volume GUID identity is incomplete");
        FileIdentity identity = new FileIdentity {
          canonicalPath = final.Substring(4), volumePath = volume.Substring(0, end + 2),
          fileId = info.VolumeSerial.ToString("x8") + ":" + info.IndexHigh.ToString("x8") + info.IndexLow.ToString("x8"),
          bytes = checked((long)(((ulong)info.SizeHigh << 32) | info.SizeLow)),
          directory = (info.Attributes & 0x10) != 0, reparse = reparse || (info.Attributes & 0x400) != 0
        };
        CorePolicy.Require(identity.directory == directory, "File identity type changed");
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
      Real(state);
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
      CorePolicy.Require(Thread.CurrentThread.ManagedThreadId == ownerManagedThread, "Private station must use the dedicated console Controller thread");
      uint currentThread = GetCurrentThreadId();
      if (ownerNativeThread == 0) ownerNativeThread = currentThread;
      CorePolicy.Require(currentThread == ownerNativeThread, "Private station native thread changed");
      CorePolicy.Require(state.station == IntPtr.Zero && state.desktop == IntPtr.Zero, "Private UI objects already exist");
      string sid = state.account == null ? state.runnerSid : state.account.sid;
      CorePolicy.Require(!String.IsNullOrEmpty(sid) && state.targetIdentity != null, "Private desktop lacks a bound token");
      string logonSid = state.targetIdentity.groups.FirstOrDefault(group => group.StartsWith("S-1-5-5-", StringComparison.Ordinal));
      if (state.account != null) { Real(state); CorePolicy.Require(logonSid != null, "Target token has no logon SID"); }
      string stationName = "CcHaha1879-" + Guid.NewGuid().ToString("N");
      string descriptor = "D:P(A;;GA;;;SY)(A;;GA;;;" + state.runnerSid + ")(A;;GA;;;" + (logonSid ?? sid) + ")";
      IntPtr security;
      uint securitySize;
      Win(ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor, 1, out security, out securitySize), "Private station security descriptor");
      try
      {
        SecurityAttributes attributes = new SecurityAttributes { length = Marshal.SizeOf(typeof(SecurityAttributes)), descriptor = security, inherit = false };
        state.originalStation = GetProcessWindowStation();
        state.originalDesktop = GetThreadDesktop(GetCurrentThreadId());
        CorePolicy.Require(state.originalStation != IntPtr.Zero && state.originalDesktop != IntPtr.Zero, "Original UI handles were not available");
        // CWF_CREATE_ONLY: never open an object created by another process.
        state.station = CreateWindowStationW(stationName, 1, 0x000f037f, ref attributes);
        Win(state.station != IntPtr.Zero, "CreateWindowStationW");
        try
        {
          Win(SetProcessWindowStation(state.station), "SetProcessWindowStation private");
          state.desktop = CreateDesktopW("fixture", IntPtr.Zero, IntPtr.Zero, 0, 0x000f01ff, ref attributes);
          Win(state.desktop != IntPtr.Zero, "CreateDesktopW");
          state.desktopName = stationName + @"\fixture";
        }
        finally
        {
          Win(SetProcessWindowStation(state.originalStation), "Restore process window station");
          Win(SetThreadDesktop(state.originalDesktop), "Restore thread desktop");
        }
      }
      finally { LocalFree(security); }
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
      Real(state);
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
      Real(state);
      CorePolicy.Require(state.subject != null && !state.subject.resumed && !state.subject.assigned && state.job == IntPtr.Zero, "Subject Job assignment order failed");
      state.job = NewJob();
      Win(AssignProcessToJobObject(state.job, state.subject.process), "AssignProcessToJobObject subject");
      state.subject.assigned = true;
    }

    public override void VerifySubject(FixtureState state)
    {
      Real(state);
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
      Real(state);
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
      Real(state);
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
      if (state.originalStation != IntPtr.Zero) Win(SetProcessWindowStation(state.originalStation), "Restore original station for cleanup");
      if (state.originalDesktop != IntPtr.Zero) Win(SetThreadDesktop(state.originalDesktop), "Restore original desktop for cleanup");
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
      Real(state);
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
      CorePolicy.Require(state.profileCreated && !state.profileLoaded && state.profile == IntPtr.Zero &&
        state.jobsEmpty && HivesAbsent(state) && !HasOwnedSidProcesses(state) && state.profileIdentity != null, "Owned profile cannot yet be deleted");
      FileIdentity identity = IdentifyPath(state.profilePath, true);
      CorePolicy.Require(!identity.reparse && identity.fileId == state.profileIdentity.fileId &&
        identity.volumePath == state.profileIdentity.volumePath && CorePolicy.SamePath(identity.canonicalPath, state.profileIdentity.canonicalPath), "Owned profile directory identity changed");
      Real(state);
      Win(DeleteProfileW(state.account.sid, state.profilePath, null), "DeleteProfileW");
      CorePolicy.Require(!Directory.Exists(state.profilePath) && HivesAbsent(state), "Userenv did not remove the owned profile");
      state.profileCreated = false;
    }

    public override void DeleteOwnedAccount(FixtureState state)
    {
      VerifyOwnedAccount(state, true);
      CorePolicy.Require(!state.profileCreated && !state.profileLoaded && state.profile == IntPtr.Zero &&
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

    private static Dictionary<string, string> AbiEnvironment(Dictionary<string, string> actual, string root)
    {
      string[] allowed = {
        "SystemRoot", "WINDIR", "SystemDrive", "ComSpec", "OS", "PROCESSOR_ARCHITECTURE",
        "PROCESSOR_ARCHITEW6432", "NUMBER_OF_PROCESSORS"
      };
      Dictionary<string, string> result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      foreach (string name in allowed)
      {
        string value;
        if (actual.TryGetValue(name, out value)) result[name] = value;
      }
      CorePolicy.Require(result.ContainsKey("SystemRoot"), "ABI target environment lacks SystemRoot");
      result["CI"] = "true";
      result["TEMP"] = root; result["TMP"] = root; result["TMPDIR"] = root;
      // These paths only contain potential runtime scratch state. They are not
      // identity evidence; child known folders are queried from its real token.
      result["HOME"] = root; result["USERPROFILE"] = root;
      result["APPDATA"] = root; result["LOCALAPPDATA"] = root;
      result["PATH"] = Path.Combine(result["SystemRoot"], "System32") + ";" + result["SystemRoot"];
      return result;
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
        CorePolicy.ValidateAbsolutePath(specPath);
        AbiSpec spec = CoreJson.Read<AbiSpec>(specPath);
        ValidateAbiRoot(spec, platform);
        CorePolicy.Require(CorePolicy.SamePath(specPath, Path.Combine(spec.root, "child-spec.json")) &&
          CorePolicy.SamePath(CorePolicy.BinaryPath, Path.Combine(spec.root, "fixture.exe")) &&
          CorePolicy.HashFile(CorePolicy.BinaryPath) == spec.binarySha256, "ABI same-binary spec binding failed");
        verifiedOutput = spec.output;
        TokenIdentity identity = platform.InspectCurrentToken();
        CorePolicy.Require(identity.sid == spec.expectedSid && identity.tokenType == 1, "ABI child identity changed");
        KnownPaths paths = platform.QueryKnownPaths(IntPtr.Zero);
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
          creationTime = ProcessCreation(GetCurrentProcess()), sid = identity.sid, identity = identity, knownPaths = paths
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

    internal static FixtureReport RunAbiHarness(string outputPath)
    {
      FixtureReport report = new FixtureReport { mode = "abi-harness" };
      NativePlatform platform = new NativePlatform();
      FixtureState state = new FixtureState { report = report, spec = new FixtureSpec { mode = "abi-harness", version = 1 } };
      string root = null;
      FileIdentity rootIdentity = null;
      NativePipeChannel pipe = null;
      bool cleaned = false;
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
        report.Check("current-known-folders-readonly", state.paths != null && !String.IsNullOrEmpty(state.paths.profile),
          "Actual token known folders queried with DONT_VERIFY; no profile or folder created");
        root = Path.Combine(parent, "cc-haha-native-abi-" + Guid.NewGuid().ToString("N"));
        CorePolicy.Require(!Directory.Exists(root) && !File.Exists(root), "ABI root collision");
        int createError;
        bool created = CreatePrivateDirectoryAtomically(root, state.runnerSid, null, out createError);
        if (!created) throw new InvalidOperationException("CreateDirectoryW owned ABI root failed (Win32 " + createError.ToString(CultureInfo.InvariantCulture) + ")");
        state.controllerRootOwned = true;
        rootIdentity = platform.IdentifyPath(root, true);
        state.spec.controllerRoot = root;
        state.profilePath = state.paths.profile;
        Win(OpenProcessToken(GetCurrentProcess(), TokenQuery | 0x0002 | 0x0004, out state.token), "Open ABI token");
        Dictionary<string, string> environment = AbiEnvironment(platform.TargetEnvironment(state), root);
        platform.CreatePrivateDesktop(state);
        report.Check("private-station-desktop", state.station != IntPtr.Zero && state.desktop != IntPtr.Zero &&
          !state.desktopName.StartsWith("winsta0\\", StringComparison.OrdinalIgnoreCase), "Created private noninteractive UI objects; shared UI DACLs untouched");
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
        platform.ResumeChild(state.subject);
        ProtocolMessage hello = CoreJson.Deserialize<ProtocolMessage>(pipe.ReadLine(10000));
        CorePolicy.Require(pipe.PeerProcessId == state.subject.pid && hello != null && hello.version == 1 &&
          hello.kind == "abi-hello" && hello.nonce == nonce && hello.pid == state.subject.pid &&
          hello.creationTime == state.subject.creationTime && hello.sid == state.runnerSid &&
          hello.binarySha256 == binaryHash && hello.specSha256 == CorePolicy.HashFile(specPath) &&
          CorePolicy.SamePaths(hello.knownPaths, state.paths), "ABI authenticated child response failed");
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
            state.desktop == IntPtr.Zero && state.environment == IntPtr.Zero && state.token == IntPtr.Zero,
            "ABI native resources remain");
          if (state.controllerRootOwned) RemoveAbiRoot(root, rootIdentity, platform);
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
