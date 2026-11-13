using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

// CLR4 / C#5. The shipped entry point has no fixture or self-test mode.
// Production admission is separate from the internal tree engine so a second,
// test-only Main can exercise that same engine on newly created temporary data.
internal static class GuardedRemoval
{
  internal const string ProductGuid = "f01cf2f0-8fe7-55b9-af4b-027bcf9c2cfe";
  internal const string OldName = "Uninstall Claude Code Haha.exe";
  internal const string OldHash = "b0242b31b839cc8bf40ba4ac492004629bcf8ed28f8648d8c46b1797f7befb60";
  internal const long OldBytes = 174881;
  internal const uint NoFollow = 0x02200000, ReadonlyDirectory = 0xa1, ShareAll = 7;
  private static readonly IntPtr Invalid = new IntPtr(-1);

  internal sealed class Failure : Exception
  {
    internal readonly string Code;
    internal readonly int NativeError;
    internal Failure(string code, int error) : base(code) { Code = code; NativeError = error; }
  }
  internal static void Need(bool condition, string code) { if (!condition) throw new Failure(code, 0); }
  internal static void Win(bool condition, string code, int error) { if (!condition) throw new Failure(code, error); }

  internal sealed class Capability
  {
    internal uint Handle, Volume, Low, High;
    internal ulong Id { get { return ((ulong)High << 32) | Low; } }
  }
  internal sealed class Invocation
  {
    internal string Root;
    internal string[] Paths;
    internal Capability[] Capabilities;
    internal uint[] Parent;
  }
  private static uint DecimalDword(string value)
  {
    Need(value != null && value.Length > 0 && value.Length <= 10 && (value.Length == 1 || value[0] != '0'), "invalid-dword");
    foreach (char c in value) Need(c >= '0' && c <= '9', "invalid-dword");
    uint parsed;
    Need(UInt32.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out parsed), "invalid-dword");
    return parsed;
  }
  internal static bool ValidLeaf(string leaf)
  {
    if (String.IsNullOrEmpty(leaf) || leaf.Length > 255 || leaf == "." || leaf == ".." || leaf[0] == '-' ||
      leaf[leaf.Length - 1] == '.' || leaf[leaf.Length - 1] == ' ' || leaf.IndexOf("--", StringComparison.Ordinal) >= 0) return false;
    foreach (char c in leaf) if (c < 32 || c == 127 || "\\/:\"<>|?*".IndexOf(c) >= 0) return false;
    string stem = leaf.Split('.')[0].ToUpperInvariant();
    if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" ||
      (stem.Length == 4 && (stem.StartsWith("COM", StringComparison.Ordinal) || stem.StartsWith("LPT", StringComparison.Ordinal)) && stem[3] >= '1' && stem[3] <= '9')) return false;
    return true;
  }
  internal static string[] ChainPaths(string root)
  {
    Need(root != null && root.Length > 3 && root.Length < 1024 && root[1] == ':' && root[2] == '\\' &&
      ((root[0] >= 'A' && root[0] <= 'Z') || (root[0] >= 'a' && root[0] <= 'z')), "invalid-root");
    var paths = new List<string>();
    paths.Add(root.Substring(0, 3));
    string current = root.Substring(0, 2);
    foreach (string component in root.Substring(3).Split('\\'))
    {
      Need(ValidLeaf(component), "invalid-root-component");
      current += "\\" + component;
      paths.Add(current);
    }
    Need(paths.Count >= 2 && paths.Count <= 32, "invalid-chain-length");
    return paths.ToArray();
  }
  internal static Invocation Parse(string[] args)
  {
    Need(args != null && args.Length == 4, "invalid-arguments");
    string root = null, tuples = null, parentTuple = null;
    bool version = false;
    foreach (string arg in args)
    {
      Need(arg != null && arg.Length < 8192, "oversized-argument");
      if (arg == "--cc-guarded-removal=1") { Need(!version, "duplicate-version"); version = true; }
      else if (arg.StartsWith("--root=", StringComparison.Ordinal)) { Need(root == null, "duplicate-root"); root = arg.Substring(7); }
      else if (arg.StartsWith("--capabilities=", StringComparison.Ordinal)) { Need(tuples == null, "duplicate-capabilities"); tuples = arg.Substring(15); }
      else if (arg.StartsWith("--parent=", StringComparison.Ordinal)) { Need(parentTuple == null, "duplicate-parent"); parentTuple = arg.Substring(9); }
      else throw new Failure("unknown-argument", 0);
    }
    Need(version && root != null && tuples != null && parentTuple != null, "missing-argument");
    string[] paths = ChainPaths(root), records = tuples.Split(',');
    Need(records.Length == paths.Length, "incomplete-capability-chain");
    var capabilities = new Capability[records.Length];
    var handles = new HashSet<uint>();
    var identities = new HashSet<string>(StringComparer.Ordinal);
    uint? volume = null;
    for (int i = 0; i < records.Length; i++)
    {
      string[] fields = records[i].Split(':');
      Need(fields.Length == 4, "invalid-capability-tuple");
      var cap = new Capability { Handle = DecimalDword(fields[0]), Volume = DecimalDword(fields[1]), Low = DecimalDword(fields[2]), High = DecimalDword(fields[3]) };
      Need(cap.Handle != 0 && cap.Handle < 0xfffffff0 && (cap.Handle & 3) == 0 && handles.Add(cap.Handle), "invalid-or-duplicate-handle");
      Need(cap.Id != 0 && identities.Add(cap.Volume.ToString("x8") + ":" + cap.Id.ToString("x16")), "invalid-or-duplicate-identity");
      if (volume.HasValue) Need(cap.Volume == volume.Value, "mixed-volume-chain");
      volume = cap.Volume;
      capabilities[i] = cap;
    }
    string[] parentFields = parentTuple.Split(':');
    Need(parentFields.Length == 4, "invalid-parent-tuple");
    uint[] parent = new uint[4];
    for (int i = 0; i < parent.Length; i++) parent[i] = DecimalDword(parentFields[i]);
    Need(parent[0] != 0 && parent[0] < 0xfffffff0 && (parent[0] & 3) == 0 && handles.Add(parent[0]) && parent[1] != 0 &&
      (parent[2] != 0 || parent[3] != 0), "invalid-or-duplicate-parent");
    return new Invocation { Root = root, Paths = paths, Capabilities = capabilities, Parent = parent };
  }

  [StructLayout(LayoutKind.Sequential)] internal struct Time { internal uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] internal struct FileInfo
  {
    internal uint Attributes; internal Time Created, Accessed, Written;
    internal uint Volume, SizeHigh, SizeLow, Links, High, Low;
  }
  [StructLayout(LayoutKind.Sequential)] internal struct StandardInfo
  {
    internal long Allocation, Length; internal uint Links; internal byte Pending, Directory;
  }
  [StructLayout(LayoutKind.Explicit, Size = 24)] internal struct Descriptor
  { [FieldOffset(0)] internal uint Size; [FieldOffset(4)] internal int Type; [FieldOffset(8)] internal long Id; }
  [StructLayout(LayoutKind.Sequential)] internal struct UnicodeName { internal ushort Length, Maximum; internal IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] internal struct ObjectAttributes
  { internal uint Length; internal IntPtr Root, Name; internal uint Flags; internal IntPtr Security, Quality; }
  [StructLayout(LayoutKind.Explicit)] internal struct IoUnion
  { [FieldOffset(0)] internal int Status; [FieldOffset(0)] internal IntPtr Pointer; }
  [StructLayout(LayoutKind.Sequential)] internal struct IoStatus { internal IoUnion Result; internal UIntPtr Information; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct RenameInfo
  { internal uint Replace; internal IntPtr Root; internal uint NameLength; internal char Name; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct ProcessEntry
  {
    internal uint Size, Usage, Pid; internal UIntPtr Heap; internal uint Module, Threads, Parent;
    internal int Priority; internal uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] internal string Name;
  }
  internal static class Native
  {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] internal static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetHandleInformation(IntPtr handle, out uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint GetFileType(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetFileInformationByHandle(IntPtr handle, out FileInfo information);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetFileInformationByHandleEx(IntPtr handle, int kind, out StandardInfo information, uint length);
    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)] internal static extern bool Query(IntPtr handle, int kind, IntPtr information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetFileInformationByHandle(IntPtr handle, int kind, IntPtr information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr OpenFileById(IntPtr volume, ref Descriptor descriptor, uint access, uint share, IntPtr security, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] internal static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder path, uint capacity, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] internal static extern bool GetVolumeInformationByHandleW(IntPtr handle, StringBuilder label, uint labelBytes, out uint serial, out uint maximum, out uint flags, StringBuilder fs, uint fsBytes);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] internal static extern uint GetDriveTypeW(string root);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] internal static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetProcessTimes(IntPtr process, out Time creation, out Time exit, out Time kernel, out Time user);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetFilePointerEx(IntPtr handle, long distance, out long position, uint origin);
    [DllImport("ntdll.dll", ExactSpelling = true)] internal static extern int NtCreateFile(out IntPtr handle, uint access, IntPtr attributes, IntPtr io, IntPtr allocation, uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaBytes);
    [DllImport("ntdll.dll", ExactSpelling = true)] internal static extern int NtSetInformationFile(IntPtr handle, IntPtr io, IntPtr information, uint bytes, int kind);
    [DllImport("ntdll.dll", ExactSpelling = true)] internal static extern int NtQueryObject(IntPtr handle, int kind, IntPtr information, uint bytes, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsWow64Process(IntPtr process, out bool wow64);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, uint bytes, out uint returned);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr text);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr value);
    [DllImport("shell32.dll")] private static extern int SHGetKnownFolderPath(ref Guid folder, uint flags, IntPtr token, out IntPtr path);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint process);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] internal static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint capacity);

    internal static string CurrentUser(Context context)
    {
      bool wow64;
      bool queried = IsWow64Process(new IntPtr(-1), out wow64); int error = Marshal.GetLastWin32Error();
      Win(queried && wow64 && IntPtr.Size == 4, "requires-x86-on-x64", error);
      return ProcessSid(context, new IntPtr(-1), true);
    }
    internal static string ProcessSid(Context context, IntPtr process, bool requireNormalToken)
    {
      IntPtr value;
      bool opened = OpenProcessToken(process, 8, out value); int error = Marshal.GetLastWin32Error();
      Win(opened, "token-open", error);
      Handle token = context.Own(value, "token");
      IntPtr buffer = Marshal.AllocHGlobal(512);
      try
      {
        uint returned;
        if (requireNormalToken) foreach (int kind in new int[] { 20, 29 })
        {
          bool success = GetTokenInformation(token.Value, kind, buffer, 4, out returned); error = Marshal.GetLastWin32Error();
          Win(success && returned == 4 && Marshal.ReadInt32(buffer) == 0, "elevated-or-appcontainer-token", error);
        }
        bool user = GetTokenInformation(token.Value, 1, buffer, 512, out returned); error = Marshal.GetLastWin32Error();
        Win(user && returned >= IntPtr.Size && returned <= 512, "token-user", error);
        IntPtr text;
        bool converted = ConvertSidToStringSidW(Marshal.ReadIntPtr(buffer), out text); error = Marshal.GetLastWin32Error();
        Win(converted, "token-sid", error);
        try
        {
          string sid = Marshal.PtrToStringUni(text);
          Need(ValidUserSid(sid), "non-user-sid");
          return sid;
        }
        finally { Need(LocalFree(text) == IntPtr.Zero, "sid-string-free"); }
      }
      finally { Marshal.FreeHGlobal(buffer); token.Close(); }
    }
    internal static string RoamingAppData()
    {
      return KnownFolder("3eb685db-65f9-4cf6-a03a-e3ef65729f3d");
    }
    internal static string KnownFolder(string id)
    {
      Guid folder = new Guid(id);
      IntPtr path;
      int result = SHGetKnownFolderPath(ref folder, 0, IntPtr.Zero, out path);
      Need(result == 0 && path != IntPtr.Zero, "known-roaming-appdata");
      try { return Marshal.PtrToStringUni(path); }
      finally { Marshal.FreeCoTaskMem(path); }
    }
    internal static void Census(Context context, string root)
    {
      IntPtr value = CreateToolhelp32Snapshot(2, 0); int error = Marshal.GetLastWin32Error();
      Win(value != Invalid, "process-snapshot", error);
      Handle snapshot = context.Own(value, "process-snapshot");
      try
      {
        var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
        bool next = Process32FirstW(snapshot.Value, ref entry); error = Marshal.GetLastWin32Error();
        int count = 0;
        while (next)
        {
          Need(++count <= 32768, "process-census-bound");
          if (RelatedImage(entry.Name))
          {
            IntPtr process = OpenProcess(0x1000, false, entry.Pid); int processError = Marshal.GetLastWin32Error();
            Win(process != IntPtr.Zero, "unresolved-related-process", processError);
            Handle processPin = context.Own(process, "related-process");
            try
            {
              var path = new StringBuilder(32768); uint capacity = (uint)path.Capacity;
              bool query = QueryFullProcessImageNameW(processPin.Value, 0, path, ref capacity); int queryError = Marshal.GetLastWin32Error();
              Win(query && capacity > 0 && capacity < path.Capacity, "unresolved-related-image", queryError);
              Handle image = context.OpenPath(path.ToString(), 0x80, 7, "related-image");
              try
              {
                Metadata metadata = context.Read(image);
                Need(!metadata.Directory && !metadata.Reparse && !metadata.Pending && !Inside(root, metadata.Path), "related-process-in-root-or-unknown");
              }
              finally { image.Close(); }
            }
            finally { processPin.Close(); }
          }
          next = Process32NextW(snapshot.Value, ref entry); error = Marshal.GetLastWin32Error();
        }
        Win(error == 18, "incomplete-process-census", error);
      }
      finally { snapshot.Close(); }
    }
  }

  internal static bool ValidUserSid(string sid)
  {
    if (sid == null || !sid.StartsWith("S-1-5-21-", StringComparison.Ordinal)) return false;
    string[] components = sid.Substring(9).Split('-');
    if (components.Length != 4) return false;
    foreach (string component in components)
    {
      uint value;
      if (component.Length == 0 || !UInt32.TryParse(component, NumberStyles.None, CultureInfo.InvariantCulture, out value)) return false;
    }
    return true;
  }
  internal static bool Inside(string root, string path)
  { return path != null && path.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase); }
  internal static bool RelatedImage(string name)
  {
    foreach (string image in new string[] { "Claude Code Haha.exe", "claude-sidecar.exe", "claude-sidecar-x86_64-pc-windows-msvc.exe",
      "claude-sidecar-aarch64-pc-windows-msvc.exe", "OpenConsole.exe", "winpty-agent.exe", "rg.exe" })
      if (String.Equals(name, image, StringComparison.OrdinalIgnoreCase)) return true;
    return false;
  }

  internal sealed class Registration
  {
    internal string Guid, Version, Root, Uninstall;
    internal bool MachineAbsent, User32Absent;
    internal string Root32, Version32, Uninstall32;
  }
  internal static void ValidateRegistration(string root, Registration state)
  {
    Need(state != null && state.Guid == ProductGuid && state.Version == "0.7.8" && state.Root == root &&
      state.Uninstall == "\"" + root + "\\" + OldName + "\" /currentuser" && state.MachineAbsent, "registration-mismatch");
    Need(state.User32Absent || (state.Root32 == state.Root && state.Version32 == state.Version && state.Uninstall32 == state.Uninstall), "registry-view-conflict");
  }
  private static string RequiredString(RegistryKey key, string name)
  {
    Need(key != null && key.GetValueKind(name) == RegistryValueKind.String, "missing-or-nonstring-registry-value");
    string value = key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
    Need(value != null && value.Length < 1024, "invalid-registry-value");
    return value;
  }
  internal static Registration ReadRegistration()
  {
    const string install = "Software\\" + ProductGuid;
    const string uninstall = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + ProductGuid;
    var result = new Registration { Guid = ProductGuid, MachineAbsent = true, User32Absent = true };
    foreach (RegistryView view in new RegistryView[] { RegistryView.Registry64, RegistryView.Registry32 })
    {
      using (RegistryKey machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
      using (RegistryKey first = machine.OpenSubKey(install, false))
      using (RegistryKey second = machine.OpenSubKey(uninstall, false))
        Need(first == null && second == null, "machine-install-or-unknown");
      using (RegistryKey user = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, view))
      using (RegistryKey first = user.OpenSubKey(install, false))
      using (RegistryKey second = user.OpenSubKey(uninstall, false))
      {
        if (view == RegistryView.Registry64)
        {
          result.Root = RequiredString(first, "InstallLocation"); result.Version = RequiredString(second, "DisplayVersion");
          result.Uninstall = RequiredString(second, "UninstallString");
        }
        else if (first != null || second != null)
        {
          result.User32Absent = false;
          result.Root32 = RequiredString(first, "InstallLocation"); result.Version32 = RequiredString(second, "DisplayVersion");
          result.Uninstall32 = RequiredString(second, "UninstallString");
        }
      }
    }
    return result;
  }

  internal sealed class Handle
  {
    internal IntPtr Value;
    internal readonly Context Context;
    internal readonly string Role;
    internal readonly IntPtr OriginalValue;
    internal bool CloseAttempted;
    internal Handle(Context context, IntPtr value, string role) { Context = context; Value = value; OriginalValue = value; Role = role; }
    internal void Close()
    {
      if (Value == IntPtr.Zero) return;
      Need(!Context.PendingIo, "close-with-pending-io");
      Need(!CloseAttempted, "close-already-unknown");
      CloseAttempted = true;
      bool success = Native.CloseHandle(Value); int error = Marshal.GetLastWin32Error();
      if (!success) Context.Unknown = true;
      Win(success, "close-" + Role, error);
      Value = IntPtr.Zero;
    }
  }
  internal sealed class Metadata
  {
    internal uint Volume, Attributes, Links;
    internal ulong Id;
    internal long Bytes;
    internal string Path;
    internal bool Directory, Reparse, Pending;
  }
  internal sealed class Entry
  {
    internal string Leaf;
    internal ulong Id;
    internal uint Attributes;
    internal bool Directory { get { return (Attributes & 16) != 0; } }
  }
  internal static bool SameObject(Metadata actual, Metadata expected, bool directory, string path)
  {
    return actual != null && expected != null && actual.Volume == expected.Volume && actual.Id == expected.Id && actual.Id != 0 &&
      actual.Directory == directory && !actual.Reparse && !actual.Pending && actual.Path == path;
  }
  internal static bool RelativeSucceeded(bool create, int status, int ioStatus, bool completed, ulong information, IntPtr handle)
  {
    return (status == 0x103 ? completed : status >= 0) && completed && ioStatus >= 0 && ioStatus != 0x103 &&
      information == (create ? 2ul : 1ul) && handle != IntPtr.Zero && handle != Invalid;
  }
  internal static string NamedPruneReason(Metadata actual, Metadata weak, Metadata expected, Metadata parent, string leaf)
  {
    if (expected == null || !expected.Directory || expected.Reparse || expected.Pending || parent == null || String.IsNullOrEmpty(parent.Path) ||
      !ValidLeaf(leaf) || !parent.Directory || parent.Reparse || parent.Pending || parent.Id == 0 || parent.Volume != expected.Volume ||
      expected.Path != ChildPath(parent.Path, leaf)) return "parent-or-request-mismatch";
    if (weak == null || weak.Volume != expected.Volume || weak.Id != expected.Id || expected.Id == 0) return "weak-identity-mismatch";
    if (weak.Reparse || (actual != null && actual.Reparse)) return "reparse";
    if (!weak.Directory || weak.Pending || (actual != null && (!actual.Directory || actual.Pending))) return "not-directory-or-pending";
    if (actual != null && actual.Volume != expected.Volume) return "volume-mismatch";
    if (actual != null && actual.Id != expected.Id) return "id-mismatch";
    if (weak.Path != expected.Path || (actual != null && actual.Path != expected.Path)) return "canonical-drift";
    return actual == null ? "named-open-failed" : "matched";
  }
  internal static string ChildPath(string parent, string leaf) { Need(ValidLeaf(leaf), "unsafe-relative-leaf"); return parent.TrimEnd('\\') + "\\" + leaf; }
  internal sealed class Context
  {
    internal readonly List<Handle> Handles = new List<Handle>();
    internal readonly List<Handle> Inherited = new List<Handle>();
    internal readonly List<Metadata> InheritedMetadata = new List<Metadata>();
    internal readonly List<Handle> AncestorGuards = new List<Handle>();
    internal Handle VolumeHint;
    internal Handle Parent, ParentCode;
    internal ProtectedDataGuard DataGuard;
    internal string ParentImage;
    internal bool Unknown, PendingIo, ParentDead;
    internal string Phase = "receive", StagingPath, StageCreation = "not-attempted";
    internal Handle Own(IntPtr value, string role)
    {
      Need(value != IntPtr.Zero && value != Invalid, "invalid-owned-handle");
      var handle = new Handle(this, value, role); Handles.Add(handle); return handle;
    }
    internal Handle OpenPath(string path, uint access, uint share, string role)
    {
      IntPtr value = Native.CreateFileW(path, access, share, IntPtr.Zero, 3, NoFollow, IntPtr.Zero); int error = Marshal.GetLastWin32Error();
      Win(value != Invalid && value != IntPtr.Zero, "open-" + role, error);
      return Own(value, role);
    }
    internal Metadata Read(Handle handle) { return ReadRaw(handle.Value); }
    internal void RevalidateData() { if (DataGuard != null) DataGuard.Revalidate(); }
    internal void ReceiveParent(uint[] tuple, string currentSid, string installRoot)
    {
      IntPtr raw = new IntPtr(unchecked((int)tuple[0])); uint flags;
      bool inherited = Native.GetHandleInformation(raw, out flags); int error = Marshal.GetLastWin32Error();
      Win(inherited && (flags & 1) == 1 && (flags & 2) == 0, "parent-not-inherited", error);
      bool cleared = Native.SetHandleInformation(raw, 1, 0); error = Marshal.GetLastWin32Error();
      Win(cleared, "parent-clear-inheritance", error);
      uint pid = Native.GetProcessId(raw); error = Marshal.GetLastWin32Error();
      Win(pid == tuple[1] && pid != 0 && pid != Native.GetCurrentProcessId(), "parent-pid-mismatch", error);
      Time creation, exit, kernel, user;
      bool timed = Native.GetProcessTimes(raw, out creation, out exit, out kernel, out user); error = Marshal.GetLastWin32Error();
      Win(timed && creation.Low == tuple[2] && creation.High == tuple[3], "parent-creation-mismatch", error);
      IntPtr access = Marshal.AllocHGlobal(64);
      try
      {
        uint returned;
        int status = Native.NtQueryObject(raw, 0, access, 64, out returned);
        Need(status >= 0 && returned >= 8 && returned <= 64 && unchecked((uint)Marshal.ReadInt32(access, 4)) == 0x101000,
          "parent-not-readonly-process-capability");
      }
      finally { Marshal.FreeHGlobal(access); }
      Need(Native.ProcessSid(this, raw, false) == currentSid, "parent-user-mismatch");
      var path = new StringBuilder(32768); uint length = (uint)path.Capacity;
      bool image = Native.QueryFullProcessImageNameW(raw, 0, path, ref length); error = Marshal.GetLastWin32Error();
      Win(image && length > 0 && length < path.Capacity, "parent-image-unknown", error);
      ParentCode = OpenPath(path.ToString(), 0x80, 1, "parent-code-pin");
      Metadata code = Read(ParentCode);
      Need(!code.Directory && !code.Reparse && !code.Pending && code.Links == 1 && !Inside(installRoot, code.Path), "parent-image-not-external-regular-code");
      ParentImage = code.Path;
      Parent = Own(raw, "inherited-parent-process");
      CheckParent(false);
    }
    internal void CheckParent(bool restoring)
    {
      Need(Parent != null && Parent.Value != IntPtr.Zero, "parent-capability-missing");
      uint state = Native.WaitForSingleObject(Parent.Value, 0); int error = Marshal.GetLastWin32Error();
      if (state == 258) return;
      if (state == 0) { ParentDead = true; if (restoring) return; throw new Failure("parent-exited", 0); }
      Unknown = true; throw new Failure("parent-liveness-unknown", error);
    }
    internal Metadata ReadRaw(IntPtr handle)
    {
      uint kind = Native.GetFileType(handle); int error = Marshal.GetLastWin32Error();
      Win(kind == 1, "non-disk-object", error);
      FileInfo file;
      bool queried = Native.GetFileInformationByHandle(handle, out file); error = Marshal.GetLastWin32Error();
      Win(queried, "file-metadata", error);
      StandardInfo standard;
      bool info = Native.GetFileInformationByHandleEx(handle, 1, out standard, (uint)Marshal.SizeOf(typeof(StandardInfo))); error = Marshal.GetLastWin32Error();
      Win(info, "standard-metadata", error);
      Need((standard.Directory != 0) == ((file.Attributes & 16) != 0) && standard.Length >= 0 && file.Links > 0, "inconsistent-metadata");
      var path = new StringBuilder(32768);
      uint length = Native.GetFinalPathNameByHandleW(handle, path, (uint)path.Capacity, 0); error = Marshal.GetLastWin32Error();
      Win(length > 0 && length < path.Capacity, "canonical-path-unknown", error);
      string canonical = path.ToString();
      Need(canonical.StartsWith("\\\\?\\", StringComparison.Ordinal) && canonical.Length >= 7 && canonical[5] == ':', "non-local-canonical-path");
      return new Metadata { Volume = file.Volume, Id = ((ulong)file.High << 32) | file.Low, Path = canonical.Substring(4),
        Attributes = file.Attributes, Links = file.Links, Bytes = standard.Length, Directory = standard.Directory != 0,
        Reparse = (file.Attributes & 0x400) != 0, Pending = standard.Pending != 0 };
    }
    internal void Receive(Invocation input)
    {
      Need(Native.GetDriveTypeW(input.Paths[0]) == 3, "not-fixed-local-volume");
      for (int i = 0; i < input.Capabilities.Length; i++)
      {
        Capability cap = input.Capabilities[i];
        IntPtr value = new IntPtr(unchecked((int)cap.Handle));
        uint flags;
        bool inherited = Native.GetHandleInformation(value, out flags); int error = Marshal.GetLastWin32Error();
        Win(inherited && (flags & 1) == 1 && (flags & 2) == 0, "not-an-inherited-capability", error);
        bool cleared = Native.SetHandleInformation(value, 1, 0); error = Marshal.GetLastWin32Error();
        Win(cleared, "clear-capability-inheritance", error);
        Metadata actual = ReadRaw(value);
        // Only a verified inherited directory is owned/closed by this process.
        // A guessed number must not cause a CloseHandle on an unrelated object.
        Need(actual.Directory && !actual.Reparse && !actual.Pending && actual.Volume == cap.Volume && actual.Id == cap.Id &&
          actual.Path == input.Paths[i], "capability-identity-mismatch");
        Inherited.Add(Own(value, "inherited-directory")); InheritedMetadata.Add(actual);
      }
      var fs = new StringBuilder(261); uint serial, maximum, volumeFlags;
      bool ntfs = Native.GetVolumeInformationByHandleW(Inherited[0].Value, null, 0, out serial, out maximum, out volumeFlags, fs, (uint)fs.Capacity);
      int fsError = Marshal.GetLastWin32Error();
      Win(ntfs && fs.ToString() == "NTFS" && serial == input.Capabilities[0].Volume, "requires-bound-ntfs", fsError);
      VolumeHint = Inherited[0];
      for (int i = 0; i < Inherited.Count; i++)
      {
        Handle guard = ById(InheritedMetadata[i], ReadonlyDirectory, 3, "ancestor-guard");
        Need(SameObject(Read(guard), InheritedMetadata[i], true, input.Paths[i]), "ancestor-guard-mismatch");
        AncestorGuards.Add(guard);
        if (i == 0) VolumeHint = guard;
      }
      ValidateAncestors();
    }
    internal void ValidateAncestors()
    {
      for (int i = 0; i < AncestorGuards.Count; i++)
      {
        Handle guard = AncestorGuards[i];
        if (guard.Value == IntPtr.Zero) continue; // the original root may have been pruned
        Need(SameObject(Read(guard), InheritedMetadata[i], true, InheritedMetadata[i].Path), "ancestor-changed");
        if (i + 1 < AncestorGuards.Count && AncestorGuards[i + 1].Value != IntPtr.Zero)
          Need(Contains(Entries(guard), InheritedMetadata[i + 1]), "ancestor-child-identity-changed");
      }
    }
    internal void CloseInherited()
    {
      Phase = "close-inherited";
      for (int i = 0; i < Inherited.Count; i++)
      {
        Need(SameObject(Read(Inherited[i]), InheritedMetadata[i], true, InheritedMetadata[i].Path), "inherited-drift-before-close");
        Inherited[i].Close();
      }
    }
    internal Handle ById(Metadata expected, uint access, uint share, string role)
    {
      var descriptor = new Descriptor { Size = 24, Type = 0, Id = unchecked((long)expected.Id) };
      IntPtr value = Native.OpenFileById(VolumeHint.Value, ref descriptor, access, share, IntPtr.Zero, NoFollow); int error = Marshal.GetLastWin32Error();
      Win(value != Invalid && value != IntPtr.Zero, "byid-" + role, error);
      return Own(value, role);
    }
    internal List<Entry> Entries(Handle directory)
    {
      const int capacity = 65536;
      IntPtr buffer = Marshal.AllocHGlobal(capacity);
      var entries = new List<Entry>(); var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      try
      {
        for (int page = 0; page < 2048; page++)
        {
          for (int n = 0; n < capacity; n++) Marshal.WriteByte(buffer, n, 0);
          bool success = Native.Query(directory.Value, page == 0 ? 11 : 10, buffer, capacity); int error = Marshal.GetLastWin32Error();
          if (!success && error == 18) return entries;
          Win(success, "directory-enumeration", error);
          int offset = 0;
          for (int n = 0; n < 512; n++)
          {
            Need(offset >= 0 && offset <= capacity - 104, "directory-entry-header");
            uint next = unchecked((uint)Marshal.ReadInt32(buffer, offset)), bytes = unchecked((uint)Marshal.ReadInt32(buffer, offset + 60));
            Need(bytes > 0 && bytes <= 510 && bytes % 2 == 0 && offset + 104 + bytes <= capacity &&
              (next == 0 || (next % 8 == 0 && next >= 104 + bytes && offset + next <= capacity - 104)), "directory-entry-bounds");
            string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + 104), (int)bytes / 2);
            if (name != "." && name != "..")
            {
              Need(name.IndexOf('\0') < 0 && name.IndexOf('\\') < 0 && name.IndexOf('/') < 0 && names.Add(name) && entries.Count < 32768,
                "invalid-or-duplicate-directory-entry");
              uint attributes = unchecked((uint)Marshal.ReadInt32(buffer, offset + 56));
              entries.Add(new Entry { Leaf = name, Id = unchecked((ulong)Marshal.ReadInt64(buffer, offset + 96)), Attributes = attributes });
            }
            if (next == 0) break;
            offset += (int)next;
            Need(n < 511, "directory-page-bound");
          }
        }
        throw new Failure("directory-page-limit", 0);
      }
      finally { Marshal.FreeHGlobal(buffer); }
    }
    internal static bool Contains(List<Entry> entries, Metadata metadata)
    {
      string leaf = metadata.Path.Substring(metadata.Path.LastIndexOf('\\') + 1);
      foreach (Entry entry in entries) if (entry.Leaf == leaf) return entry.Id == metadata.Id && entry.Directory == metadata.Directory;
      return false;
    }
    internal static bool Absent(List<Entry> entries, string leaf)
    {
      foreach (Entry entry in entries) if (String.Equals(entry.Leaf, leaf, StringComparison.OrdinalIgnoreCase)) return false;
      return true;
    }
    internal Handle Relative(Handle parent, string leaf, bool directory, bool create, uint access, uint share, string role)
    {
      Need(ValidLeaf(leaf), "unsafe-relative-leaf");
      byte[] name = Encoding.Unicode.GetBytes(leaf + "\0");
      IntPtr text = Marshal.AllocHGlobal(name.Length), unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeName))),
        attributes = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ObjectAttributes))), io = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(IoStatus)));
      bool completed = true;
      try
      {
        Marshal.Copy(name, 0, text, name.Length);
        Marshal.StructureToPtr(new UnicodeName { Length = (ushort)(name.Length - 2), Maximum = (ushort)name.Length, Buffer = text }, unicode, false);
        Marshal.StructureToPtr(new ObjectAttributes { Length = (uint)Marshal.SizeOf(typeof(ObjectAttributes)), Root = parent.Value, Name = unicode, Flags = 0x1040 }, attributes, false);
        for (int n = 0; n < Marshal.SizeOf(typeof(IoStatus)); n++) Marshal.WriteByte(io, n, 0);
        Marshal.WriteInt32(io, 0x103); // unchanged IOSB stays distinguishably pending
        IntPtr value;
        int status = Native.NtCreateFile(out value, access, attributes, io, IntPtr.Zero, directory ? 16u : 128u, share,
          create ? 2u : 1u, directory ? 0x200021u : 0x200060u, IntPtr.Zero, 0);
        completed = status != 0x103;
        Handle owned = value == IntPtr.Zero || value == Invalid ? null : Own(value, role);
        uint wait = status == 0x103 && owned != null ? Native.WaitForSingleObject(value, 0xffffffff) : 0xffffffff;
        var final = (IoStatus)Marshal.PtrToStructure(io, typeof(IoStatus));
        if (status == 0x103) completed = wait == 0 && final.Result.Status != 0x103;
        if (!completed) { PendingIo = true; Unknown = true; throw new Failure("nt-relative-completion-unknown", status); }
        bool success = RelativeSucceeded(create, status, final.Result.Status, completed, final.Information.ToUInt64(), value) && owned != null;
        if (!success) { if (create) Unknown = true; throw new Failure("nt-relative-" + role, status < 0 ? status : final.Result.Status); }
        return owned;
      }
      finally
      {
        if (completed) { Marshal.FreeHGlobal(io); Marshal.FreeHGlobal(attributes); Marshal.FreeHGlobal(unicode); Marshal.FreeHGlobal(text); }
        else { PendingIo = true; Unknown = true; }
      }
    }
    internal void Rename(Handle file, Handle parent, string leaf)
    {
      Need(ValidLeaf(leaf), "unsafe-rename-leaf");
      byte[] name = Encoding.Unicode.GetBytes(leaf);
      int rootOffset = Marshal.OffsetOf(typeof(RenameInfo), "Root").ToInt32(), lengthOffset = Marshal.OffsetOf(typeof(RenameInfo), "NameLength").ToInt32(),
        nameOffset = Marshal.OffsetOf(typeof(RenameInfo), "Name").ToInt32();
      int length = Math.Max(nameOffset + name.Length + 2, Marshal.SizeOf(typeof(RenameInfo)) + name.Length);
      IntPtr buffer = Marshal.AllocHGlobal(length), io = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(IoStatus)));
      bool completed = true;
      try
      {
        for (int n = 0; n < length; n++) Marshal.WriteByte(buffer, n, 0);
        for (int n = 0; n < Marshal.SizeOf(typeof(IoStatus)); n++) Marshal.WriteByte(io, n, 0);
        Marshal.WriteIntPtr(buffer, rootOffset, parent.Value); Marshal.WriteInt32(buffer, lengthOffset, name.Length);
        Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length); Marshal.WriteInt32(io, 0x103);
        int status = Native.NtSetInformationFile(file.Value, io, buffer, (uint)length, 10);
        completed = status != 0x103;
        uint wait = status == 0x103 ? Native.WaitForSingleObject(file.Value, 0xffffffff) : 0xffffffff;
        var final = (IoStatus)Marshal.PtrToStructure(io, typeof(IoStatus));
        if (status == 0x103) completed = wait == 0 && final.Result.Status != 0x103;
        if (!completed) { PendingIo = true; Unknown = true; throw new Failure("nt-rename-completion-unknown", status); }
        if (!((status == 0x103 ? completed : status >= 0) && completed && final.Result.Status >= 0 && final.Result.Status != 0x103))
          throw new Failure("nt-relative-rename", status < 0 ? status : final.Result.Status);
      }
      finally { if (completed) { Marshal.FreeHGlobal(io); Marshal.FreeHGlobal(buffer); } else { PendingIo = true; Unknown = true; } }
    }
    internal void Disposition(Handle handle, bool delete)
    {
      IntPtr buffer = Marshal.AllocHGlobal(1);
      try
      {
        Marshal.WriteByte(buffer, delete ? (byte)1 : (byte)0);
        bool success = Native.SetFileInformationByHandle(handle.Value, 4, buffer, 1); int error = Marshal.GetLastWin32Error();
        Win(success, delete ? "same-handle-delete-mark" : "same-handle-delete-cancel", error);
      }
      finally { Marshal.FreeHGlobal(buffer); }
    }
    internal string Hash(Handle file)
    {
      long position;
      bool seek = Native.SetFilePointerEx(file.Value, 0, out position, 0); int error = Marshal.GetLastWin32Error();
      Win(seek && position == 0, "hash-seek", error);
      using (var borrowed = new SafeFileHandle(file.Value, false))
      using (var input = new FileStream(borrowed, FileAccess.Read, 65536, false))
      using (var algorithm = new SHA256Managed())
      {
        byte[] hash = algorithm.ComputeHash(input);
        var text = new StringBuilder(64);
        foreach (byte b in hash) text.Append(b.ToString("x2", CultureInfo.InvariantCulture));
        return text.ToString();
      }
    }
    internal void CloseAll()
    {
      if (PendingIo) { Unknown = true; return; }
      for (int i = Handles.Count - 1; i >= 0; i--)
      {
        Handle handle = Handles[i];
        if (handle == Parent) continue;
        if (handle.CloseAttempted || handle.Value == IntPtr.Zero) continue;
        try { handle.Close(); } catch (Failure) { Unknown = true; }
      }
      if (Parent != null && Parent.Value != IntPtr.Zero && !Parent.CloseAttempted)
      {
        try { CheckParent(true); if (ParentDead && Phase == "removed") Unknown = true; } catch (Failure) { Unknown = true; }
        try { Parent.Close(); } catch (Failure) { Unknown = true; }
      }
    }
  }

  internal sealed class DirectoryNode
  {
    internal Handle Weak, Guard, Sentinel, PrunePin;
    internal Metadata Original, Current, SentinelIdentity;
    internal DirectoryNode Parent;
    internal Handle ParentAnchor;
    internal string Leaf, SentinelLeaf;
    internal bool Removed;
    internal readonly List<DirectoryNode> Children = new List<DirectoryNode>();
    internal readonly List<FileNode> Files = new List<FileNode>();
    internal int OriginalEntryCount;
  }
  internal sealed class FileNode
  {
    internal Handle Pin;
    internal Metadata Original;
    internal DirectoryNode Parent;
    internal string Leaf, StageLeaf, Hash;
    internal bool Moved, DeleteMarked;
  }
  internal sealed class Tree
  {
    internal readonly Context Context;
    internal readonly DirectoryNode Root;
    internal DirectoryNode Stage;
    internal readonly List<FileNode> Files = new List<FileNode>();
    internal readonly List<DirectoryNode> Directories = new List<DirectoryNode>();
    internal bool MutationStarted, CommitStarted, Restored;
    private bool Restoring;
    private readonly List<DirectoryNode> SentinelOwners = new List<DirectoryNode>();
    private readonly HashSet<ulong> Ids = new HashSet<ulong>();
    internal Tree(Context context)
    {
      Context = context;
      int last = context.InheritedMetadata.Count - 1;
      Need(last >= 1, "missing-install-parent");
      Metadata root = context.InheritedMetadata[last];
      Root = new DirectoryNode { Original = root, Current = root, Guard = context.AncestorGuards[last],
        Weak = context.ById(root, ReadonlyDirectory, ShareAll, "root-object-weak"), ParentAnchor = context.AncestorGuards[last - 1],
        Leaf = root.Path.Substring(root.Path.LastIndexOf('\\') + 1) };
      Need(SameObject(context.Read(Root.Weak), root, true, root.Path), "root-object-weak-mismatch");
    }
    internal void ValidateDirectory(DirectoryNode node)
    {
      Need(node.Guard != null && node.Guard.Value != IntPtr.Zero && SameObject(Context.Read(node.Guard), node.Current, true, node.Current.Path), "directory-guard-drift");
      if (node.Weak != null && node.Weak.Value != IntPtr.Zero)
        Need(SameObject(Context.Read(node.Weak), node.Current, true, node.Current.Path), "directory-weak-drift");
      if (node.Sentinel != null && node.Sentinel.Value != IntPtr.Zero)
      {
        Metadata sentinel = Context.Read(node.Sentinel);
        Need(SameObject(sentinel, node.SentinelIdentity, false, ChildPath(node.Current.Path, node.SentinelLeaf)) &&
          GuardedRemoval.Context.Contains(Context.Entries(node.Guard), sentinel), "sentinel-not-bound-in-original-directory");
      }
    }
    private void AddSentinel(DirectoryNode node)
    {
      Context.RevalidateData();
      Context.CheckParent(Restoring);
      node.SentinelLeaf = "cc-haha-sentinel-" + Guid.NewGuid().ToString("N");
      node.Sentinel = Context.Relative(node.Weak, node.SentinelLeaf, false, true, 0x110080, 1, "owned-sentinel");
      try
      {
        node.SentinelIdentity = Context.Read(node.Sentinel);
        Need(SameObject(node.SentinelIdentity, node.SentinelIdentity, false, ChildPath(node.Current.Path, node.SentinelLeaf)) &&
          node.SentinelIdentity.Volume == node.Current.Volume && node.SentinelIdentity.Bytes == 0 &&
          GuardedRemoval.Context.Contains(Context.Entries(node.Weak), node.SentinelIdentity), "created-sentinel-identity");
        SentinelOwners.Add(node);
      }
      catch (Exception) { Context.Unknown = true; throw; }
    }
    private Handle ParentGuard(DirectoryNode node) { return node.Parent == null ? node.ParentAnchor : node.Parent.Guard; }
    private string ParentPath(DirectoryNode node)
    { return node.Parent == null ? Context.InheritedMetadata[Context.InheritedMetadata.Count - 2].Path : node.Parent.Current.Path; }
    private DirectoryNode CreateDirectory(DirectoryNode parent, Handle anchor, string path, string leaf, string role)
    {
      Context.RevalidateData();
      Context.CheckParent(Restoring);
      if (parent != null) ValidateDirectory(parent);
      Handle weak = Context.Relative(parent == null ? anchor : parent.Guard, leaf, true, true, 0x1000a1, 7, role + "-weak");
      if (role == "staging") Context.StageCreation = "confirmed";
      try
      {
        Metadata current = Context.Read(weak);
        Need(current.Directory && !current.Reparse && !current.Pending && current.Volume == Root.Original.Volume && current.Path == ChildPath(path, leaf), "new-directory-identity");
        var node = new DirectoryNode { Weak = weak, Current = current, Original = current, Parent = parent, ParentAnchor = anchor, Leaf = leaf };
        node.Guard = Context.ById(current, ReadonlyDirectory, 3, role + "-guard");
        Need(SameObject(Context.Read(node.Guard), current, true, current.Path), "new-directory-guard-drift-before-sentinel");
        AddSentinel(node);
        ValidateDirectory(node);
        Need(GuardedRemoval.Context.Contains(Context.Entries(parent == null ? anchor : parent.Guard), current), "new-directory-not-in-parent");
        return node;
      }
      catch (Exception) { Context.Unknown = true; throw; }
    }
    private static void NormalFile(Metadata metadata)
    {
      Need(!metadata.Directory && !metadata.Reparse && !metadata.Pending && metadata.Links == 1 && metadata.Id != 0 &&
        (metadata.Attributes & (1u | 0x40u | 0x1000u | 0x4000u | 0x400000u)) == 0 && metadata.Bytes >= 0, "non-normal-source-file");
    }
    internal FileNode PinFile(DirectoryNode parent, string leaf)
    {
      Context.RevalidateData();
      Handle pin = Context.Relative(parent.Guard, leaf, false, false, 0x110081, 1, "source-file");
      Metadata metadata = Context.Read(pin);
      NormalFile(metadata);
      Need(metadata.Volume == Root.Original.Volume && metadata.Path == ChildPath(parent.Current.Path, leaf), "source-file-parent-mismatch");
      return new FileNode { Pin = pin, Original = metadata, Parent = parent, Leaf = leaf, Hash = Context.Hash(pin) };
    }
    internal void VerifyFile(FileNode file, DirectoryNode parent, string leaf)
    {
      Metadata current = Context.Read(file.Pin);
      NormalFile(current);
      Need(SameObject(current, file.Original, false, ChildPath(parent.Current.Path, leaf)) && current.Bytes == file.Original.Bytes &&
        Context.Hash(file.Pin) == file.Hash && GuardedRemoval.Context.Contains(Context.Entries(parent.Guard), current), "source-file-identity-or-bytes-changed");
    }
    internal static void FixedOld(FileNode file)
    { Need(file.Leaf == OldName && file.Original.Bytes == OldBytes && file.Hash == OldHash, "official-old-uninstaller-fingerprint"); }
    internal void Admit(FileNode seed)
    {
      Context.RevalidateData();
      Context.Phase = "tree-admission";
      AddSentinel(Root);
      Scan(Root, seed, 0);
      ValidateDirectory(Root);
      Context.ValidateAncestors();
      if (seed != null) Need(Files.Contains(seed), "pinned-old-file-not-in-tree");
    }
    private void Scan(DirectoryNode node, FileNode seed, int depth)
    {
      Context.RevalidateData();
      Need(depth < 128 && Directories.Count < 4096 && Ids.Add(node.Current.Id), "directory-tree-bound-or-identity-alias");
      Directories.Add(node);
      ValidateDirectory(node);
      List<Entry> entries = Context.Entries(node.Guard);
      node.OriginalEntryCount = entries.Count - 1;
      foreach (Entry entry in entries)
      {
        if (entry.Leaf == node.SentinelLeaf) continue;
        Need(ValidLeaf(entry.Leaf) && (entry.Attributes & 0x400) == 0 && entry.Id != 0, "unrecognized-source-entry");
        if (entry.Directory)
        {
          Handle weak = Context.Relative(node.Guard, entry.Leaf, true, false, 0x1000a1, 7, "source-directory-weak");
          Metadata metadata = Context.Read(weak);
          Need(metadata.Directory && !metadata.Reparse && !metadata.Pending && metadata.Id == entry.Id && metadata.Volume == Root.Original.Volume &&
            metadata.Path == ChildPath(node.Current.Path, entry.Leaf), "source-directory-enumeration-drift");
          var child = new DirectoryNode { Weak = weak, Original = metadata, Current = metadata, Parent = node, Leaf = entry.Leaf };
          child.Guard = Context.ById(metadata, ReadonlyDirectory, 3, "source-directory-guard");
          Need(SameObject(Context.Read(child.Guard), metadata, true, metadata.Path), "source-directory-guard-drift-before-sentinel");
          AddSentinel(child);
          node.Children.Add(child);
          Scan(child, seed, depth + 1);
        }
        else
        {
          FileNode file = seed != null && node == Root && entry.Leaf == seed.Leaf ? seed : PinFile(node, entry.Leaf);
          Need(file.Original.Id == entry.Id && Ids.Add(entry.Id) && Files.Count < 32768, "file-enumeration-drift-or-identity-alias");
          file.StageLeaf = "file-" + Files.Count.ToString("D8", CultureInfo.InvariantCulture);
          Files.Add(file); node.Files.Add(file);
        }
      }
      foreach (DirectoryNode child in node.Children)
        if (node == Root && String.Equals(child.Leaf, "CLAUDE_CONFIG_DIR", StringComparison.OrdinalIgnoreCase))
          Need(child.OriginalEntryCount == 0, "legacy-config-data-present");
      foreach (FileNode file in node.Files)
        Need(node != Root || !String.Equals(file.Leaf, "CLAUDE_CONFIG_DIR", StringComparison.OrdinalIgnoreCase), "legacy-config-data-unknown");
      AssertExpectedEntries(node, false);
    }
    private void AssertExpectedEntries(DirectoryNode node, bool emptied)
    {
      ValidateDirectory(node);
      var expected = new Dictionary<string, ulong>(StringComparer.Ordinal);
      expected.Add(node.SentinelLeaf, node.SentinelIdentity.Id);
      if (!emptied)
      {
        foreach (DirectoryNode child in node.Children) if (!child.Removed) expected.Add(child.Leaf, child.Current.Id);
        foreach (FileNode file in node.Files) if (!file.Moved) expected.Add(file.Leaf, file.Original.Id);
      }
      List<Entry> entries = Context.Entries(node.Guard);
      Need(entries.Count == expected.Count, "unrecognized-or-missing-tree-entry");
      foreach (Entry entry in entries)
      {
        ulong id;
        Need(expected.TryGetValue(entry.Leaf, out id) && id == entry.Id && (entry.Attributes & 0x400) == 0, "tree-entry-identity-drift");
      }
    }
    internal void PrepareStage(string prohibitedCleanupRoot)
    {
      Context.RevalidateData();
      Context.Phase = "prepare-staging";
      Context.ValidateAncestors();
      string parent = ParentPath(Root), leaf = "cc-haha-removal-" + Guid.NewGuid().ToString("N");
      string stagePath = ChildPath(parent, leaf);
      Need(!Inside(prohibitedCleanupRoot, stagePath) && stagePath != prohibitedCleanupRoot, "staging-in-automatic-cleanup-root");
      Context.StagingPath = stagePath; Context.StageCreation = "unknown";
      Stage = CreateDirectory(null, Root.ParentAnchor, parent, leaf, "staging");
      Context.StagingPath = Stage.Current.Path;
    }
    private void Move(FileNode file, bool restore)
    {
      Context.RevalidateData();
      Context.CheckParent(restore);
      DirectoryNode from = restore ? Stage : file.Parent, to = restore ? file.Parent : Stage;
      string fromLeaf = restore ? file.StageLeaf : file.Leaf, toLeaf = restore ? file.Leaf : file.StageLeaf;
      ValidateDirectory(from); ValidateDirectory(to); Context.ValidateAncestors();
      VerifyFile(file, from, fromLeaf);
      try { Context.Rename(file.Pin, to.Guard, toLeaf); }
      catch (Exception)
      {
        if (!Context.PendingIo)
        {
          Metadata current = Context.Read(file.Pin);
          if (SameObject(current, file.Original, false, ChildPath(to.Current.Path, toLeaf))) file.Moved = !restore;
          else if (!SameObject(current, file.Original, false, ChildPath(from.Current.Path, fromLeaf))) Context.Unknown = true;
        }
        throw;
      }
      file.Moved = !restore;
      VerifyFile(file, to, toLeaf);
    }
    private void RemoveSentinel(DirectoryNode node)
    {
      Context.RevalidateData();
      Need(SameObject(Context.Read(node.Sentinel), node.SentinelIdentity, false, ChildPath(node.Current.Path, node.SentinelLeaf)), "sentinel-changed-before-removal");
      Context.Disposition(node.Sentinel, true); node.Sentinel.Close();
    }
    private void Prune(DirectoryNode node)
    {
      Context.RevalidateData();
      Context.CheckParent(Restoring);
      Context.ValidateAncestors(); AssertExpectedEntries(node, true);
      Handle parent = ParentGuard(node);
      Metadata parentExpected = node.Parent == null ? Context.InheritedMetadata[Context.InheritedMetadata.Count - 2] : node.Parent.Current;
      Need(SameObject(Context.Read(parent), parentExpected, true, ParentPath(node)) && node.Current.Path == ChildPath(parentExpected.Path, node.Leaf),
        "prune-original-parent-or-leaf-changed");
      node.Guard.Close();
      // The chosen DELETE pin is one named FILE_OPEN, not a retry/fallback
      // after the c899 by-ID disposition87 observation (whose cause is unknown).
      node.PrunePin = Context.Relative(parent, node.Leaf, true, false, 0x1100a1, 1, "prune-named-delete-pin");
      Metadata parentAfter = Context.Read(parent);
      Need(SameObject(parentAfter, parentExpected, true, ParentPath(node)), "prune-parent-changed-during-open");
      string reason = NamedPruneReason(Context.Read(node.PrunePin), Context.Read(node.Weak), node.Current, parentAfter, node.Leaf);
      Need(reason == "matched", "prune-object-" + reason);
      List<Entry> entries = Context.Entries(node.PrunePin);
      Need(entries.Count == 1 && GuardedRemoval.Context.Contains(entries, node.SentinelIdentity), "prune-only-original-sentinel");
      node.Weak.Close();
      RemoveSentinel(node);
      Context.Disposition(node.PrunePin, true); node.PrunePin.Close();
      node.Removed = true;
      Need(GuardedRemoval.Context.Absent(Context.Entries(ParentGuard(node)), node.Leaf), "pruned-original-link-still-present");
    }
    private void StageExpected(bool includeFiles)
    {
      ValidateDirectory(Stage);
      var expected = new Dictionary<string, ulong>(StringComparer.Ordinal);
      expected.Add(Stage.SentinelLeaf, Stage.SentinelIdentity.Id);
      if (includeFiles) foreach (FileNode file in Files) if (file.Moved) expected.Add(file.StageLeaf, file.Original.Id);
      List<Entry> entries = Context.Entries(Stage.Guard);
      Need(entries.Count == expected.Count, "unrecognized-staging-entry");
      foreach (Entry entry in entries)
      {
        ulong id;
        Need(expected.TryGetValue(entry.Leaf, out id) && id == entry.Id && (entry.Attributes & 0x400) == 0, "staging-entry-drift");
      }
    }
    private void VerifyCommitMarks()
    {
      ValidateDirectory(Stage); Context.ValidateAncestors();
      var allowed = new Dictionary<string, ulong>(StringComparer.Ordinal);
      allowed.Add(Stage.SentinelLeaf, Stage.SentinelIdentity.Id);
      foreach (FileNode file in Files)
      {
        Metadata current = Context.Read(file.Pin);
        Need(file.DeleteMarked && current.Pending && !current.Directory && !current.Reparse && current.Volume == file.Original.Volume &&
          current.Id == file.Original.Id && current.Bytes == file.Original.Bytes && current.Path == ChildPath(Stage.Current.Path, file.StageLeaf),
          "commit-mark-identity-unknown");
        allowed.Add(file.StageLeaf, file.Original.Id);
      }
      List<Entry> entries = Context.Entries(Stage.Guard);
      Need(GuardedRemoval.Context.Contains(entries, Stage.SentinelIdentity), "commit-sentinel-missing");
      // Some filesystems hide delete-pending names. Every visible name must
      // still be known; every pending original object was verified by its pin.
      foreach (Entry entry in entries)
      {
        ulong id;
        Need(allowed.TryGetValue(entry.Leaf, out id) && entry.Id == id && !entry.Directory && (entry.Attributes & 0x400) == 0,
          "unrecognized-entry-before-commit-close");
      }
    }
    internal void Remove(Action beforeMutation, Action beforeCommit)
    {
      Need(Stage != null, "staging-not-prepared");
      Context.Phase = "freeze-complete";
      foreach (DirectoryNode node in Directories) AssertExpectedEntries(node, false);
      foreach (FileNode file in Files) VerifyFile(file, file.Parent, file.Leaf);
      Context.CheckParent(false);
      if (beforeMutation != null) beforeMutation();
      foreach (DirectoryNode node in Directories) AssertExpectedEntries(node, false);
      Context.RevalidateData();
      Context.CloseInherited();
      Context.Phase = "move"; MutationStarted = true;
      try
      {
        foreach (FileNode file in Files) Move(file, false);
        StageExpected(true);
        Context.Phase = "prune";
        for (int i = Directories.Count - 1; i >= 0; i--) Prune(Directories[i]);
        Context.Phase = "commit-prepare";
        if (beforeCommit != null) beforeCommit();
        StageExpected(true);
        foreach (FileNode file in Files)
        {
          Context.RevalidateData();
          Context.CheckParent(false);
          VerifyFile(file, Stage, file.StageLeaf);
          Context.Disposition(file.Pin, true); file.DeleteMarked = true;
        }
        // No original file handle closes before every delete mark succeeds.
        // A failure before this point can cancel every mark and restore by handle.
        VerifyCommitMarks();
        Context.Phase = "commit-close";
        foreach (FileNode file in Files) { Context.RevalidateData(); Context.CheckParent(false); CommitStarted = true; file.Pin.Close(); }
        StageExpected(false);
        Context.CheckParent(false); CommitStarted = true;
        Prune(Stage);
        Context.CheckParent(false);
        Context.Phase = "removed";
      }
      catch (Exception)
      {
        if (!Context.PendingIo) foreach (FileNode file in Files)
          if (file.DeleteMarked && file.Pin.Value != IntPtr.Zero && !file.Pin.CloseAttempted)
          {
            try { Context.Disposition(file.Pin, false); file.DeleteMarked = false; }
            catch (Exception) { Context.Unknown = true; }
          }
        if (!CommitStarted && !Context.Unknown && !Context.PendingIo)
        {
          try { Restore(); } catch (Exception) { Context.Unknown = true; }
        }
        else Context.Unknown = true;
        throw;
      }
    }
    private void Reprotect(DirectoryNode node)
    {
      if (node.Removed)
      {
        DirectoryNode replacement = CreateDirectory(node.Parent, node.ParentAnchor, ParentPath(node), node.Leaf, "restore-directory");
        node.Current = replacement.Current; node.Weak = replacement.Weak; node.Guard = replacement.Guard;
        node.Sentinel = replacement.Sentinel; node.SentinelIdentity = replacement.SentinelIdentity; node.SentinelLeaf = replacement.SentinelLeaf;
        node.Removed = false;
        return;
      }
      if (node.PrunePin != null && node.PrunePin.Value != IntPtr.Zero)
      {
        Metadata current = Context.Read(node.PrunePin);
        if (current.Pending) Context.Disposition(node.PrunePin, false);
        Need(SameObject(Context.Read(node.PrunePin), node.Current, true, node.Current.Path), "restore-prune-pin-drift");
        node.Weak = Context.ById(node.Current, ReadonlyDirectory, 7, "restore-retained-weak");
        Need(SameObject(Context.Read(node.Weak), node.Current, true, node.Current.Path), "restore-retained-weak-drift");
        node.PrunePin.Close();
      }
      if (node.Sentinel == null || node.Sentinel.Value == IntPtr.Zero) AddSentinel(node);
      if (node.Guard == null || node.Guard.Value == IntPtr.Zero) node.Guard = Context.ById(node.Current, ReadonlyDirectory, 3, "restore-retained-guard");
      ValidateDirectory(node);
    }
    internal void Restore()
    {
      Need(!CommitStarted && !Context.Unknown && !Context.PendingIo, "restore-state-unknown");
      Context.RevalidateData();
      Context.Phase = "restore";
      Restoring = true;
      Context.CheckParent(true);
      foreach (FileNode file in Files)
        if (file.DeleteMarked) { Context.Disposition(file.Pin, false); file.DeleteMarked = false; }
      foreach (DirectoryNode node in Directories) Reprotect(node);
      foreach (FileNode file in Files) if (file.Moved) Move(file, true);
      foreach (DirectoryNode node in Directories) AssertExpectedEntries(node, false);
      foreach (FileNode file in Files) VerifyFile(file, file.Parent, file.Leaf);
      // Remove only the sentinels this process created. Original directory IDs
      // that were pruned may differ, while original file IDs/bytes must not.
      for (int i = Directories.Count - 1; i >= 0; i--)
      {
        DirectoryNode node = Directories[i];
        RemoveSentinel(node);
      }
      StageExpected(false); Prune(Stage);
      Restored = true; Context.Phase = "restored-after-failure";
    }
    internal void CleanPreparation()
    {
      Need(!MutationStarted && !Context.Unknown && !Context.PendingIo, "preparation-cleanup-unknown");
      Restoring = true;
      Context.CheckParent(true);
      for (int i = SentinelOwners.Count - 1; i >= 0; i--)
      {
        DirectoryNode node = SentinelOwners[i];
        if (node == Stage || node.Sentinel.Value == IntPtr.Zero) continue;
        RemoveSentinel(node);
      }
      if (Stage != null && !Stage.Removed) { StageExpected(false); Prune(Stage); }
      Context.Phase = "admission-failed-owned-markers-cleaned";
    }
  }

  internal const string DefaultMode = "{\n  \"mode\": \"default\",\n  \"portable_dir\": null\n}";
  internal static void RequireDefaultMode(byte[] bytes, int count)
  { Need(count >= 0 && count <= bytes.Length && Encoding.UTF8.GetString(bytes, 0, count) == DefaultMode, "non-default-or-unknown-app-mode"); }
  internal static void RequireSeparateData(string root, string protectedPath)
  {
    Need(!String.Equals(root, protectedPath, StringComparison.OrdinalIgnoreCase) && !Inside(root, protectedPath) && !Inside(protectedPath, root),
      "install-root-overlaps-protected-data");
  }
  // Metadata only: never enumerate or read the protected namespaces. Pin each
  // existing component with no-follow, deny DELETE and remember an exact
  // missing final leaf. Access denied/path unknown is not absence.
  internal static bool MissingDataLeaf(Failure failure)
  { return failure.Code == "nt-relative-protected-data" && failure.NativeError == unchecked((int)0xc0000034); }
  internal sealed class ProtectedNamespace
  {
    private readonly Context Context;
    private readonly string InstallRoot;
    private readonly string[] Paths;
    private readonly List<Handle> Pins = new List<Handle>();
    private readonly List<Metadata> Identities = new List<Metadata>();
    internal Handle LeafPin { get { return Pins.Count == Paths.Length ? Pins[Pins.Count - 1] : null; } }
    internal string LeafPath { get { return Paths[Paths.Length - 1]; } }
    internal ProtectedNamespace(Context context, string root, string path)
    {
      Context = context; InstallRoot = root; Paths = ChainPaths(path);
      RequireSeparateData(root, path);
      Handle drive = context.OpenPath(Paths[0], 0x1000a0, 3, "protected-data-drive");
      Add(drive, Paths[0], null);
      for (int i = 1; i < Paths.Length; i++)
      {
        Handle pin = Open(i);
        if (pin == null) { Need(i == Paths.Length - 1, "protected-data-parent-missing"); break; }
        Add(pin, Paths[i], Identities[i - 1]);
      }
    }
    private Handle Open(int index)
    {
      try { return Context.Relative(Pins[index - 1], Paths[index].Substring(Paths[index].LastIndexOf('\\') + 1), true, false, 0x1000a0, 3, "protected-data"); }
      catch (Failure failure) { if (MissingDataLeaf(failure) && !Context.PendingIo) return null; throw; }
    }
    private void Add(Handle pin, string expected, Metadata parent)
    {
      Metadata actual = Context.Read(pin);
      Need(actual.Directory && !actual.Reparse && !actual.Pending && actual.Id != 0 &&
        String.Equals(actual.Path, expected, StringComparison.OrdinalIgnoreCase) && (parent == null || actual.Volume == parent.Volume),
        "protected-data-component-alias-or-unknown");
      if (Pins.Count == Paths.Length - 1) RequireSeparateData(InstallRoot, actual.Path);
      Pins.Add(pin); Identities.Add(actual);
    }
    internal void Revalidate()
    {
      for (int i = 0; i < Pins.Count; i++)
      {
        Need(SameObject(Context.Read(Pins[i]), Identities[i], true, Identities[i].Path), "protected-data-metadata-drift");
        if (i == 0) continue;
        Handle current = Open(i);
        Need(current != null, "protected-data-component-disappeared");
        Need(SameObject(Context.Read(current), Identities[i], true, Identities[i].Path), "protected-data-link-drift");
        current.Close();
      }
      if (Pins.Count != Paths.Length)
      {
        Handle appeared = Open(Pins.Count);
        if (appeared != null) { appeared.Close(); throw new Failure("protected-data-missing-leaf-appeared", 0); }
      }
    }
  }
  internal sealed class ProtectedDataGuard
  {
    private readonly Func<string[]> KnownPaths;
    private readonly string[] Original;
    private readonly ProtectedNamespace Config, Product;
    internal Handle ProductPin { get { return Product.LeafPin; } }
    internal string ProductPath { get { return Product.LeafPath; } }
    internal ProtectedDataGuard(Context context, string root, Func<string[]> knownPaths)
    {
      KnownPaths = knownPaths; string[] paths = knownPaths();
      Need(paths != null && paths.Length == 2 && !String.IsNullOrEmpty(paths[0]) && !String.IsNullOrEmpty(paths[1]), "user-data-location-unknown");
      Original = (string[])paths.Clone();
      Config = new ProtectedNamespace(context, root, ChildPath(paths[0], ".claude"));
      Product = new ProtectedNamespace(context, root, ChildPath(paths[1], "Claude Code Haha"));
    }
    internal void Revalidate()
    {
      string[] current = KnownPaths();
      Need(current != null && current.Length == 2 && current[0] == Original[0] && current[1] == Original[1], "known-data-location-drift");
      Config.Revalidate(); Product.Revalidate();
    }
  }
  private static string[] KnownDataPaths()
  { return new string[] { Native.KnownFolder("5e6c858f-0e22-4760-9afe-ea3317b67173"), Native.RoamingAppData() }; }
  internal static void CheckData(Context context, string root)
  {
    Need(String.IsNullOrEmpty(Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR")) &&
      String.IsNullOrEmpty(Environment.GetEnvironmentVariable("CC_HAHA_APP_PORTABLE_DIR")), "managed-or-portable-override");
    if (context.DataGuard == null) context.DataGuard = new ProtectedDataGuard(context, root, KnownDataPaths);
    context.RevalidateData();
    if (context.DataGuard.ProductPin == null) return;
    string mode = ChildPath(context.DataGuard.ProductPath, "app-mode.json");
    Handle modePin;
    try { modePin = context.Relative(context.DataGuard.ProductPin, "app-mode.json", false, false, 0x80100080, 1, "app-mode"); }
    catch (Failure failure)
    {
      if (failure.Code == "nt-relative-app-mode" && failure.NativeError == unchecked((int)0xc0000034) && !context.PendingIo) return;
      throw;
    }
    Metadata file = context.Read(modePin);
    Need(!file.Directory && !file.Reparse && !file.Pending && file.Links == 1 && file.Bytes <= 512 && file.Path == mode, "app-mode-not-normal");
    using (var borrowed = new SafeFileHandle(modePin.Value, false))
    using (var stream = new FileStream(borrowed, FileAccess.Read, 1024, false))
    {
      byte[] bytes = new byte[file.Bytes + 1];
      int total = 0, read;
      while ((read = stream.Read(bytes, total, bytes.Length - total)) > 0) { total += read; Need(total < bytes.Length, "app-mode-size-drift"); }
      Need(total == file.Bytes, "app-mode-size-drift"); RequireDefaultMode(bytes, total);
    }
    context.RevalidateData();
  }
  private static int Main(string[] args)
  {
    var context = new Context(); Tree tree = null;
    Failure failure = null;
    try
    {
      Invocation input = Parse(args);
      Need(Environment.OSVersion.Platform == PlatformID.Win32NT && IntPtr.Size == 4, "requires-windows-clr4-x86");
      context.Receive(input);
      string sid = Native.CurrentUser(context);
      context.ReceiveParent(input.Parent, sid, input.Root);
      Need(context.ParentImage.Substring(context.ParentImage.LastIndexOf('\\') + 1) == "cc-haha-current-uninstaller.exe" &&
        Native.ProcessSid(context, context.Parent.Value, true) == sid, "not-current-user-uninstaller-parent");
      context.Phase = "product-admission";
      ValidateRegistration(input.Root, ReadRegistration());
      CheckData(context, input.Root);
      tree = new Tree(context);
      FileNode old = tree.PinFile(tree.Root, OldName);
      Tree.FixedOld(old);
      Native.Census(context, input.Root);
      tree.Admit(old);
      string codeDirectory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
      tree.PrepareStage(codeDirectory);
      tree.Remove(delegate {
        context.CheckParent(false);
        Need(Native.CurrentUser(context) == sid, "caller-token-changed");
        ValidateRegistration(input.Root, ReadRegistration());
        CheckData(context, input.Root);
        Tree.FixedOld(old);
        Native.Census(context, input.Root);
      }, delegate {
        context.CheckParent(false);
        ValidateRegistration(input.Root, ReadRegistration());
        Native.Census(context, input.Root);
      });
    }
    catch (Failure error) { failure = error; }
    catch (Exception) { context.Unknown = true; failure = new Failure("unexpected-runtime-failure", 0); }
    finally
    {
      if (failure != null && tree != null && !tree.MutationStarted && !context.Unknown && !context.PendingIo)
      {
        try { tree.CleanPreparation(); } catch (Exception) { context.Unknown = true; }
      }
      context.CloseAll();
    }
    if (failure == null && !context.Unknown && !context.ParentDead && context.Phase == "removed") return 0;
    string code = failure == null ? "final-state-unknown" : failure.Code;
    int native = failure == null ? 0 : failure.NativeError;
    string outcome = context.Unknown ? "unknown" : tree != null && tree.Restored ? "restored-after-failure" : "rejected";
    Console.Error.WriteLine("guarded-removal: code=" + code + "; phase=" + context.Phase + "; native=" + native.ToString(CultureInfo.InvariantCulture) +
      "; outcome=" + outcome + "; staging=" + (context.StagingPath ?? "not-created") + "; stagingCreation=" + context.StageCreation);
    return 22;
  }
}
