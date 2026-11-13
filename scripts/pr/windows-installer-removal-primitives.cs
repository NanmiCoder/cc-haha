using System;
using System.Collections.Generic;
using System.Collections;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

// Owned temporary fixtures only. No registry, account, profile, installer or
// product executable is read or executed by this primitive probe.
internal static class RemovalPrimitiveProbe
{
  private const uint ReadAttributes = 0x80;
  private const uint Traverse = 0x20;
  private const uint DeleteAccess = 0x10000;
  private const uint DirectoryAccess = DeleteAccess | ReadAttributes | 1 | 2 | 4;
  private const uint ReadonlyDirectoryAccess = ReadAttributes | Traverse | 1;
  private const uint PruneAccess = DeleteAccess | ReadAttributes;
  private const uint ShareRead = 1;
  private const uint ShareReadWrite = 3;
  private const uint ShareAll = 7;
  private const uint OpenExisting = 3;
  private const uint NoFollow = 0x02200000; // BACKUP_SEMANTICS | OPEN_REPARSE_POINT
  private static readonly IntPtr Invalid = new IntPtr(-1);
  private static readonly List<OwnedHandle> Handles = new List<OwnedHandle>();
  private static readonly List<object> Observations = new List<object>();
  private static readonly List<object> Checks = new List<object>();
  private static readonly List<object> DiagnosticChecks = new List<object>();
  private static readonly List<object> CaseResults = new List<object>();
  private static bool Failed;
  private static string CurrentCase;
  private static bool CurrentDiagnostic;
  private static bool CurrentCaseFailed;
  private static bool ChosenRoundtripPassed;
  private static int LastDispositionError;
  private static bool RootInitiallyVerified, PendingNativeIo, UnsafeCleanup;
  private static ProtectedDirectory FixtureBoundary, SandboxBoundary, Outside;
  private static OwnedHandle OutsideMarker;
  private static byte[] OutsideMarkerBytes, CalibrationBuffer;
  private static string OutsideInventory;
  private static readonly List<ReparseLease> ReparseLeases = new List<ReparseLease>();
  private const string ChosenPrimitive = "NtRename+readonly-share3+relative-NtCreate-sentinel+same-handle-byID-prune";

  [StructLayout(LayoutKind.Sequential)]
  private struct FileTime { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)]
  private struct FileInformation
  {
    public uint Attributes;
    public FileTime Created;
    public FileTime Accessed;
    public FileTime Written;
    public uint Volume;
    public uint SizeHigh;
    public uint SizeLow;
    public uint Links;
    public uint IndexHigh;
    public uint IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct StandardInformation
  {
    public long AllocationSize;
    public long EndOfFile;
    public uint Links;
    public byte DeletePending;
    public byte Directory;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct RenameInformation
  {
    public uint Flags;
    public IntPtr RootDirectory;
    public uint FileNameLength;
    public char FileName;
  }
  [StructLayout(LayoutKind.Explicit)]
  private struct IoStatusUnion
  {
    [FieldOffset(0)] public int Status;
    [FieldOffset(0)] public IntPtr Pointer;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IoStatusBlock
  {
    public IoStatusUnion Result;
    public UIntPtr Information;
  }
  // SDK FILE_ID_DESCRIPTOR has a 16-byte union, including GUID / FILE_ID_128,
  // even though this NTFS-only probe uses the 64-bit FileIdType member.
  [StructLayout(LayoutKind.Explicit, Size = 24)]
  private struct FileIdDescriptor
  {
    [FieldOffset(0)] public uint Size;
    [FieldOffset(4)] public int Type;
    [FieldOffset(8)] public long FileId;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct UnicodeString { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  private struct ObjectAttributes
  {
    public uint Length;
    public IntPtr RootDirectory, ObjectName;
    public uint Attributes;
    public IntPtr SecurityDescriptor, SecurityQualityOfService;
  }
  // FILE_ID_BOTH_DIR_INFO is explicitly 8-byte aligned on both architectures.
  [StructLayout(LayoutKind.Explicit, Size = 112)]
  private struct DirectoryEntryLayout
  {
    [FieldOffset(0)] public uint Next;
    [FieldOffset(56)] public uint Attributes;
    [FieldOffset(60)] public uint NameBytes;
    [FieldOffset(96)] public long Id;
    [FieldOffset(104)] public char Name;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(IntPtr handle, out FileInformation information);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(IntPtr handle, int informationClass, out StandardInformation information, uint length);
  [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "GetFileInformationByHandleEx")]
  private static extern bool QueryDirectory(IntPtr handle, int informationClass, IntPtr information, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetFileInformationByHandle(IntPtr handle, int informationClass, IntPtr information, uint length);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateDirectoryW(string name, IntPtr security);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenFileById(IntPtr volumeHint, ref FileIdDescriptor descriptor, uint access, uint share, IntPtr security, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder path, uint capacity, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool GetVolumeInformationByHandleW(IntPtr handle, StringBuilder volumeName, uint volumeCapacity,
    out uint serial, out uint maximumComponentLength, out uint flags, StringBuilder fileSystem, uint fileSystemCapacity);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool MoveFileExW(string source, string target, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("ntdll.dll", ExactSpelling = true)]
  private static extern int NtSetInformationFile(IntPtr handle, IntPtr ioStatusBlock, IntPtr information, uint length, int informationClass);
  [DllImport("ntdll.dll", ExactSpelling = true)]
  private static extern uint RtlNtStatusToDosError(int status);
  [DllImport("ntdll.dll", ExactSpelling = true)]
  private static extern int NtCreateFile(out IntPtr handle, uint access, IntPtr objectAttributes, IntPtr ioStatusBlock,
    IntPtr allocationSize, uint attributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool DeviceIoControl(IntPtr handle, uint control, byte[] input, uint inputBytes,
    byte[] output, uint outputBytes, out uint returned, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool WriteFile(IntPtr handle, byte[] bytes, uint count, out uint written, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool ReadFile(IntPtr handle, byte[] bytes, uint count, out uint read, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetFilePointerEx(IntPtr handle, long distance, out long position, uint origin);

  private sealed class OwnedHandle
  {
    public IntPtr Value;
    public readonly string Name;
    public readonly uint Access;
    public readonly uint Share;
    public OwnedHandle(IntPtr value, string name, uint access = 0, uint share = 0)
    { Value = value; Name = name; Access = access; Share = share; Handles.Add(this); }
    public bool Close()
    {
      if (Value == IntPtr.Zero || Value == Invalid) return true;
      bool success = CloseHandle(Value);
      int error = Marshal.GetLastWin32Error();
      Observe("CloseHandle", Name, success, error, new { handle = Value.ToInt64(), access = Access, share = Share });
      if (success) Value = IntPtr.Zero;
      if (!success) { Failed = true; CurrentCaseFailed = true; }
      return success;
    }
  }

  private static void Observe(string api, string name, bool success, long error, object detail)
  {
    Observations.Add(new { caseName = CurrentCase, diagnosticOnly = CurrentDiagnostic, api = api, name = name, success = success, win32Error = error,
      errorAuthoritative = !success, errorSource = "GetLastWin32Error", detail = detail });
  }
  private static void Check(string name, bool passed, object detail)
  {
    if (CurrentDiagnostic) DiagnosticChecks.Add(new { caseName = CurrentCase, name = name, status = passed ? "observed-true" : "observed-false", capabilityCredit = false, detail = detail });
    else Checks.Add(new { caseName = CurrentCase, name = name, status = passed ? "passed" : "failed", detail = detail });
    if (!passed) { CurrentCaseFailed = true; if (!CurrentDiagnostic) Failed = true; }
  }
  private static void Require(string name, bool passed, object detail)
  {
    Check(name, passed, detail);
    if (!passed) throw new InvalidOperationException(name);
  }
  private static OwnedHandle Open(string name, uint access, uint share, string label, bool required)
  {
    IntPtr handle = CreateFileW(name, access, share, IntPtr.Zero, OpenExisting, NoFollow, IntPtr.Zero);
    int error = Marshal.GetLastWin32Error();
    bool success = handle != Invalid;
    Observe("CreateFileW", label, success, error, new { handle = handle.ToInt64(), access = access, share = share, flags = NoFollow });
    if (required) Require(label, success, new { win32Error = error });
    return new OwnedHandle(handle, label, access, share);
  }
  private static string Identity(OwnedHandle handle)
  {
    FileInformation info;
    bool success = GetFileInformationByHandle(handle.Value, out info);
    int error = Marshal.GetLastWin32Error();
    Observe("GetFileInformationByHandle", handle.Name, success, error, null);
    Require("no-follow-object-information-" + handle.Name, success && (info.Attributes & 0x400) == 0,
      new { attributes = info.Attributes, win32Error = error });
    return info.Volume.ToString("x8") + ":" + info.IndexHigh.ToString("x8") + info.IndexLow.ToString("x8");
  }
  private static bool Disposition(OwnedHandle handle, bool delete, string label)
  {
    IntPtr buffer = Marshal.AllocHGlobal(1);
    try
    {
      Marshal.WriteByte(buffer, delete ? (byte)1 : (byte)0);
      bool success = SetFileInformationByHandle(handle.Value, 4, buffer, 1);
      int error = Marshal.GetLastWin32Error();
      LastDispositionError = error;
      Observe("SetFileInformationByHandle(FileDispositionInfo)", label, success, error,
        new { handle = handle.Value.ToInt64(), access = handle.Access, share = handle.Share, delete = delete, bytes = 1 });
      return success;
    }
    finally { Marshal.FreeHGlobal(buffer); }
  }
  private sealed class RenameBuffer : IDisposable
  {
    public readonly IntPtr Value;
    public readonly int Bytes;
    public readonly int RootOffset;
    public readonly int LengthOffset;
    public readonly int NameOffset;
    public readonly int NameBytes;
    public readonly bool ContractLength;
    public bool RetainUntilProcessExit;
    public RenameBuffer(OwnedHandle parent, string leaf, bool contractLength)
    {
      byte[] name = Encoding.Unicode.GetBytes(leaf);
      RootOffset = Marshal.OffsetOf(typeof(RenameInformation), "RootDirectory").ToInt32();
      LengthOffset = Marshal.OffsetOf(typeof(RenameInformation), "FileNameLength").ToInt32();
      NameOffset = Marshal.OffsetOf(typeof(RenameInformation), "FileName").ToInt32();
      NameBytes = name.Length;
      ContractLength = contractLength;
      Bytes = Math.Max(Marshal.SizeOf(typeof(RenameInformation)), NameOffset + name.Length + 2);
      // The Native contract also requires sizeof(struct) + name bytes. The
      // original Win32-sized buffer remains a separate diagnostic control.
      if (contractLength) Bytes = Math.Max(Bytes, Marshal.SizeOf(typeof(RenameInformation)) + name.Length);
      Value = Marshal.AllocHGlobal(Bytes);
      for (int i = 0; i < Bytes; i++) Marshal.WriteByte(Value, i, 0);
      Marshal.WriteIntPtr(Value, RootOffset, parent.Value);
      Marshal.WriteInt32(Value, LengthOffset, name.Length);
      Marshal.Copy(name, 0, IntPtr.Add(Value, NameOffset), name.Length);
    }
    public object Detail(OwnedHandle parent, string leaf)
    {
      return new { rootDirectoryHandle = parent.Value.ToInt64(), replaceIfExists = false, leaf = leaf,
        rootOffset = RootOffset, lengthOffset = LengthOffset, nameOffset = NameOffset,
        nameBytesExcludingNul = NameBytes, bufferBytesIncludingNul = Bytes, contractLength = ContractLength };
    }
    public void Dispose() { if (!RetainUntilProcessExit) Marshal.FreeHGlobal(Value); }
  }

  private static bool RenameWin32(OwnedHandle file, OwnedHandle parent, string leaf, string label, bool contractLength)
  {
    using (var request = new RenameBuffer(parent, leaf, contractLength))
    {
      bool result = SetFileInformationByHandle(file.Value, 3, request.Value, (uint)request.Bytes);
      int error = Marshal.GetLastWin32Error();
      Observe("SetFileInformationByHandle(FileRenameInfo)", label, result, error, request.Detail(parent, leaf));
      return result;
    }
  }

  // Fixed chosen primitive, never a fallback after a failed Win32 call.
  // Official contracts (Microsoft Learn / windows-hardware/drivers/ddi):
  // ntifs/nf-ntifs-ntsetinformationfile (class 10, source DELETE access)
  // ntifs/ns-ntifs-_file_rename_information (target metadata access, length)
  // wdm/ns-wdm-_io_status_block (pointer-sized union + ULONG_PTR).
  private static bool RenameNt(OwnedHandle file, OwnedHandle parent, string leaf, string label)
  {
    using (var request = new RenameBuffer(parent, leaf, true))
    {
      int ioBytes = Marshal.SizeOf(typeof(IoStatusBlock));
      IntPtr io = Marshal.AllocHGlobal(ioBytes);
      bool completed = true;
      try
      {
        for (int i = 0; i < ioBytes; i++) Marshal.WriteByte(io, i, 0);
        Marshal.WriteInt32(io, unchecked((int)0xc0000001)); // unchanged IO status cannot look successful
        int status = NtSetInformationFile(file.Value, io, request.Value, (uint)request.Bytes, 10);
        object waitDetail = null;
        uint wait = 0;
        if (status == 0x103) // STATUS_PENDING is not completed success
        {
          // CreateFileW opened a synchronous handle (no OVERLAPPED). Keep both
          // unmanaged buffers alive until completion; the parent bounds this
          // owned fixture process. No path monitoring or retry is involved.
          wait = WaitForSingleObject(file.Value, 0xffffffff);
          int waitError = Marshal.GetLastWin32Error();
          completed = wait == 0;
          waitDetail = new { result = wait, win32Error = waitError, errorAuthoritative = wait == 0xffffffff };
        }
        IoStatusBlock final = (IoStatusBlock)Marshal.PtrToStructure(io, typeof(IoStatusBlock));
        bool callSucceeded = status == 0x103 ? completed : status >= 0;
        bool ioSucceeded = completed && final.Result.Status >= 0 && final.Result.Status != 0x103;
        bool success = callSucceeded && ioSucceeded;
        Observations.Add(new { caseName = CurrentCase, diagnosticOnly = CurrentDiagnostic,
          api = "NtSetInformationFile(FileRenameInformation)", informationClass = 10, name = label, success = success,
          callNtStatus = unchecked((uint)status).ToString("x8"), callDosError = RtlNtStatusToDosError(status),
          callWasPending = status == 0x103, callSucceeded = callSucceeded,
          ioNtStatus = unchecked((uint)final.Result.Status).ToString("x8"), ioDosError = RtlNtStatusToDosError(final.Result.Status),
          ioSucceeded = ioSucceeded, ioInformation = final.Information.ToUInt64(), completed = completed, wait = waitDetail,
          errorSource = "NTSTATUS; DOS errors are derived RtlNtStatusToDosError mappings, not GetLastError",
          ioStatusBlockBytes = ioBytes, ioInformationOffset = Marshal.OffsetOf(typeof(IoStatusBlock), "Information").ToInt32(),
          detail = request.Detail(parent, leaf) });
        return success;
      }
      finally
      {
        if (completed) Marshal.FreeHGlobal(io);
        else { PendingNativeIo = true; request.RetainUntilProcessExit = true; } // pending I/O still owns both buffers
      }
    }
  }

  private static OwnedHandle MetadataAlias(string path, OwnedHandle strong, string label)
  {
    OwnedHandle alias = Open(path, ReadAttributes | Traverse, ShareAll, label, true);
    Require("independent-metadata-alias-same-object", alias.Value != strong.Value && Identity(alias) == Identity(strong),
      new { independentCreateFile = true, duplicateHandle = false, requestedAccess = ReadAttributes | Traverse, share = ShareAll,
        strongShare = strong.Share, strongAccess = strong.Access });
    return alias;
  }

  private static void CreateOwnedDirectory(string path, string label)
  {
    bool success = CreateDirectoryW(path, IntPtr.Zero);
    int error = Marshal.GetLastWin32Error();
    Observe("CreateDirectoryW", label, success, error, null);
    Require(label, success, new { win32Error = error });
  }

  private sealed class DirectoryBinding
  {
    public uint Volume;
    public ulong FileId;
    public string Canonical;
    public bool Directory;
    public bool Reparse;
    public bool DeletePending;
  }

  private static DirectoryBinding ReadDirectoryBinding(OwnedHandle handle, string label)
  {
    FileInformation file;
    bool queried = GetFileInformationByHandle(handle.Value, out file);
    int error = Marshal.GetLastWin32Error();
    Observe("GetFileInformationByHandle", label, queried, error, new { attributes = file.Attributes, volume = file.Volume,
      fileId = (((ulong)file.IndexHigh << 32) | file.IndexLow).ToString("x16") });
    Require(label + "-object-information", queried, new { win32Error = error });
    StandardInformation standard;
    bool standardQueried = GetFileInformationByHandleEx(handle.Value, 1, out standard, (uint)Marshal.SizeOf(typeof(StandardInformation)));
    int standardError = Marshal.GetLastWin32Error();
    Observe("GetFileInformationByHandleEx(FileStandardInfo)", label, standardQueried, standardError,
      new { deletePending = standard.DeletePending, directory = standard.Directory });
    Require(label + "-standard-information", standardQueried, new { win32Error = standardError });
    var path = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandleW(handle.Value, path, (uint)path.Capacity, 0); // normalized DOS path
    int pathError = Marshal.GetLastWin32Error();
    bool canonicalKnown = length > 0 && length < path.Capacity && path.ToString().StartsWith("\\\\?\\", StringComparison.Ordinal);
    Observe("GetFinalPathNameByHandleW", label, canonicalKnown, pathError,
      new { returnedLength = length, capacity = path.Capacity, flags = 0, canonical = canonicalKnown ? path.ToString() : null });
    Require(label + "-canonical-known", canonicalKnown, new { win32Error = pathError, length = length });
    return new DirectoryBinding { Volume = file.Volume, FileId = ((ulong)file.IndexHigh << 32) | file.IndexLow,
      Canonical = path.ToString(), Directory = standard.Directory != 0 && (file.Attributes & 0x10) != 0,
      Reparse = (file.Attributes & 0x400) != 0, DeletePending = standard.DeletePending != 0 };
  }

  private static uint RequireNtfs(OwnedHandle volumeHint)
  {
    var volumeName = new StringBuilder(261);
    var fileSystem = new StringBuilder(261);
    uint serial, maximum, flags;
    bool queried = GetVolumeInformationByHandleW(volumeHint.Value, volumeName, (uint)volumeName.Capacity,
      out serial, out maximum, out flags, fileSystem, (uint)fileSystem.Capacity);
    int error = Marshal.GetLastWin32Error();
    Observe("GetVolumeInformationByHandleW", "bound-volume-hint", queried, error,
      new { fileSystem = fileSystem.ToString(), serial = serial, fileSystemFlags = flags });
    // The existing 64-bit BY_HANDLE_FILE_INFORMATION ID is not unique on ReFS.
    // This probe does not silently change identifier kinds or reopen a volume.
    Require("byid-probe-is-ntfs", queried && fileSystem.ToString() == "NTFS", new { win32Error = error });
    return serial;
  }

  // This is an owned-sandbox experiment, not an installed-path ancestor policy.
  // All name anchors stay pinned; possibly empty targets also keep a sentinel.
  private sealed class ProtectedDirectory
  {
    public OwnedHandle Weak, Guard, Sentinel;
    public DirectoryBinding Binding, SentinelBinding;
    public ProtectedDirectory Parent;
    public string Leaf, SentinelLeaf;
  }
  private sealed class DirectoryEntry
  {
    public string Name;
    public ulong Id;
    public uint Attributes;
  }
  private sealed class ReparseLease
  {
    public OwnedHandle Writer;
    public DirectoryBinding Original;
    public bool Active, Unknown;
  }
  private sealed class CreateResult
  {
    public OwnedHandle Handle;
    public int Status, IoStatus;
    public bool Success, Completed;
    public ulong Information;
  }
  private static object BindingDetail(DirectoryBinding value)
  {
    return new { volume = value.Volume, fileId = value.FileId.ToString("x16"), canonical = value.Canonical,
      directory = value.Directory, reparse = value.Reparse, deletePending = value.DeletePending };
  }
  private static bool SameBinding(DirectoryBinding actual, DirectoryBinding expected, bool directory)
  {
    return actual.Volume == expected.Volume && actual.FileId == expected.FileId && actual.FileId != 0 &&
      actual.Directory == directory && !actual.Reparse && !actual.DeletePending &&
      String.Equals(actual.Canonical, expected.Canonical, StringComparison.Ordinal);
  }
  private static bool ValidLeaf(string leaf)
  {
    if (String.IsNullOrEmpty(leaf) || leaf.Length > 80 || leaf == "." || leaf == "..") return false;
    foreach (char c in leaf) if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.')) return false;
    return leaf[leaf.Length - 1] != '.';
  }
  private static string NewLeaf(string prefix) { return prefix + "-" + Guid.NewGuid().ToString("N"); }

  // No flag fallback. Pending requests retain all native memory until completion.
  private static CreateResult CreateRelative(OwnedHandle parent, string leaf, uint access, uint share, bool directory, string label)
  {
    Require(label + "-literal-single-leaf", ValidLeaf(leaf), new { leaf = leaf });
    byte[] name = Encoding.Unicode.GetBytes(leaf + "\0");
    IntPtr text = Marshal.AllocHGlobal(name.Length), unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString))),
      attributes = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ObjectAttributes))), io = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(IoStatusBlock)));
    bool completed = true;
    try
    {
      Marshal.Copy(name, 0, text, name.Length);
      Marshal.StructureToPtr(new UnicodeString { Length = (ushort)(name.Length - 2), MaximumLength = (ushort)name.Length, Buffer = text }, unicode, false);
      Marshal.StructureToPtr(new ObjectAttributes { Length = (uint)Marshal.SizeOf(typeof(ObjectAttributes)),
        RootDirectory = parent.Value, ObjectName = unicode, Attributes = 0x1040 }, attributes, false);
      for (int i = 0; i < Marshal.SizeOf(typeof(IoStatusBlock)); i++) Marshal.WriteByte(io, i, 0);
      Marshal.WriteInt32(io, unchecked((int)0xc0000001));
      uint options = directory ? 0x200021u : 0x200060u;
      IntPtr value;
      int status = NtCreateFile(out value, access, attributes, io, IntPtr.Zero, directory ? 0x10u : 0x80u,
        share, 2, options, IntPtr.Zero, 0);
      uint wait = 0;
      if (status == 0x103)
      {
        wait = value == IntPtr.Zero || value == Invalid ? 0xffffffff : WaitForSingleObject(value, 0xffffffff);
        completed = wait == 0;
      }
      IoStatusBlock final = (IoStatusBlock)Marshal.PtrToStructure(io, typeof(IoStatusBlock));
      bool success = (status == 0x103 ? completed : status >= 0) && completed && final.Result.Status >= 0 &&
        final.Result.Status != 0x103 && final.Information.ToUInt64() == 2 && value != IntPtr.Zero && value != Invalid;
      Observations.Add(new { caseName = CurrentCase, diagnosticOnly = CurrentDiagnostic, api = "NtCreateFile(FILE_CREATE)", name = label,
        success = success, callNtStatus = unchecked((uint)status).ToString("x8"), ioNtStatus = unchecked((uint)final.Result.Status).ToString("x8"),
        completed = completed, wait = wait, ioInformation = final.Information.ToUInt64(), rootDirectoryHandle = parent.Value.ToInt64(),
        handle = value.ToInt64(), leaf = leaf, access = access, share = share, objectAttributes = 0x1040, createDisposition = 2,
        createOptions = options, directory = directory, securityDescriptorNull = true, fallback = false });
      return new CreateResult { Handle = new OwnedHandle(value, label, access, share), Status = status, IoStatus = final.Result.Status,
        Information = final.Information.ToUInt64(), Completed = completed, Success = success };
    }
    finally
    {
      if (completed) { Marshal.FreeHGlobal(io); Marshal.FreeHGlobal(attributes); Marshal.FreeHGlobal(unicode); Marshal.FreeHGlobal(text); }
      else { PendingNativeIo = true; UnsafeCleanup = true; }
    }
  }
  private static OwnedHandle ById(DirectoryBinding expected, uint access, uint share, string label)
  {
    var descriptor = new FileIdDescriptor { Size = 24, Type = 0, FileId = unchecked((long)expected.FileId) };
    IntPtr value = OpenFileById(SandboxBoundary.Guard.Value, ref descriptor, access, share, IntPtr.Zero, NoFollow);
    int error = Marshal.GetLastWin32Error();
    Observe("OpenFileById", label, value != Invalid && value != IntPtr.Zero, error,
      new { handle = value.ToInt64(), access = access, share = share, flags = NoFollow, fileId = expected.FileId.ToString("x16"),
        descriptorSize = 24, descriptorType = 0, volumeHint = SandboxBoundary.Guard.Value.ToInt64(), securityAttributesNull = true });
    Require(label + "-opened", value != Invalid && value != IntPtr.Zero, new { win32Error = error });
    return new OwnedHandle(value, label, access, share);
  }
  private static List<DirectoryEntry> Entries(OwnedHandle directory, string label)
  {
    const int capacity = 65536;
    IntPtr buffer = Marshal.AllocHGlobal(capacity);
    var entries = new List<DirectoryEntry>();
    var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    try
    {
      for (int page = 0; page < 32; page++)
      {
        for (int n = 0; n < capacity; n++) Marshal.WriteByte(buffer, n, 0);
        bool success = QueryDirectory(directory.Value, page == 0 ? 11 : 10, buffer, capacity);
        int error = Marshal.GetLastWin32Error();
        Observe("GetFileInformationByHandleEx(FileIdBothDirectoryInfo)", label, success, error,
          new { handle = directory.Value.ToInt64(), informationClass = page == 0 ? 11 : 10, capacity = capacity, page = page });
        if (!success && error == 18) return entries; // ERROR_NO_MORE_FILES is an enumeration terminator only
        Require(label + "-enumeration-completed", success, new { win32Error = error });
        int offset = 0;
        for (int count = 0; count < 256; count++)
        {
          Require(label + "-entry-header-bounded", offset >= 0 && offset <= capacity - 104, null);
          uint next = unchecked((uint)Marshal.ReadInt32(buffer, offset)), bytes = unchecked((uint)Marshal.ReadInt32(buffer, offset + 60));
          Require(label + "-entry-name-bounded", bytes > 0 && bytes <= 510 && bytes % 2 == 0 && offset + 104 + bytes <= capacity &&
            (next == 0 || (next % 8 == 0 && next >= 104 + bytes && offset + next <= capacity - 104)), null);
          string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + 104), (int)bytes / 2);
          if (name != "." && name != "..")
          {
            Require(label + "-unique-bounded-entry", names.Add(name) && entries.Count < 128, null);
            entries.Add(new DirectoryEntry { Name = name, Id = unchecked((ulong)Marshal.ReadInt64(buffer, offset + 96)),
              Attributes = unchecked((uint)Marshal.ReadInt32(buffer, offset + 56)) });
          }
          if (next == 0) break;
          offset += (int)next;
          Require(label + "-page-entry-limit", count < 255, null);
        }
      }
      throw new InvalidOperationException(label + "-page-limit");
    }
    finally { Marshal.FreeHGlobal(buffer); }
  }
  private static bool EntryMatches(List<DirectoryEntry> entries, string leaf, DirectoryBinding expected)
  {
    foreach (DirectoryEntry entry in entries)
      if (entry.Name == leaf) return entry.Id == expected.FileId && (entry.Attributes & 0x410) == (expected.Directory ? 0x10u : 0u);
    return false;
  }
  private static bool EntryAbsent(ProtectedDirectory parent, string leaf, string label)
  {
    foreach (DirectoryEntry entry in Entries(parent.Guard, label)) if (String.Equals(entry.Name, leaf, StringComparison.OrdinalIgnoreCase)) return false;
    return true;
  }
  private static void AddSentinel(ProtectedDirectory directory, string label)
  {
    directory.SentinelLeaf = NewLeaf("sentinel");
    CreateResult result = CreateRelative(directory.Weak, directory.SentinelLeaf, 0x110080, ShareRead, false, label + "-sentinel");
    Require(label + "-sentinel-created", result.Success, null);
    directory.Sentinel = result.Handle;
    directory.SentinelBinding = ReadDirectoryBinding(result.Handle, label + "-sentinel-binding");
    Require(label + "-sentinel-object", directory.SentinelBinding.Volume == directory.Binding.Volume &&
      !directory.SentinelBinding.Directory && !directory.SentinelBinding.Reparse && !directory.SentinelBinding.DeletePending, null);
  }
  private static void ValidateProtected(ProtectedDirectory directory, string label)
  {
    DirectoryBinding guard = ReadDirectoryBinding(directory.Guard, label + "-guard"), weak = ReadDirectoryBinding(directory.Weak, label + "-weak");
    Require(label + "-same-id-path-no-reparse", SameBinding(guard, directory.Binding, true) && SameBinding(weak, directory.Binding, true),
      new { expected = BindingDetail(directory.Binding), actual = BindingDetail(guard), weak = BindingDetail(weak) });
    if (directory.Sentinel != null)
    {
      DirectoryBinding sentinel = ReadDirectoryBinding(directory.Sentinel, label + "-sentinel");
      Require(label + "-sentinel-bound-in-directory", SameBinding(sentinel, directory.SentinelBinding, false) &&
        EntryMatches(Entries(directory.Guard, label + "-entries"), directory.SentinelLeaf, sentinel), BindingDetail(sentinel));
    }
  }
  private static ProtectedDirectory NewDirectory(ProtectedDirectory parent, string leaf, bool sentinel, string label)
  {
    ValidateProtected(parent, label + "-parent-before-create");
    CreateResult created = CreateRelative(parent.Guard, leaf, 0x1000a1, ShareAll, true, label + "-directory");
    Require(label + "-directory-created", created.Success, null);
    DirectoryBinding binding = ReadDirectoryBinding(created.Handle, label + "-initial-binding");
    Require(label + "-child-bound-to-parent", binding.Directory && !binding.Reparse && !binding.DeletePending && binding.Volume == parent.Binding.Volume &&
      binding.Canonical == parent.Binding.Canonical.TrimEnd('\\') + "\\" + leaf && EntryMatches(Entries(parent.Guard, label + "-parent-entries"), leaf, binding),
      BindingDetail(binding));
    var directory = new ProtectedDirectory { Weak = created.Handle, Binding = binding, Parent = parent, Leaf = leaf };
    if (sentinel) AddSentinel(directory, label);
    directory.Guard = ById(binding, ReadonlyDirectoryAccess, ShareReadWrite, label + "-readonly-guard");
    ValidateProtected(directory, label + "-admission");
    return directory;
  }
  private static OwnedHandle NewFile(ProtectedDirectory parent, string leaf, byte[] bytes, string label)
  {
    ValidateProtected(parent, label + "-parent");
    CreateResult created = CreateRelative(parent.Guard, leaf, 0x110083, ShareRead, false, label);
    Require(label + "-created", created.Success, null);
    DirectoryBinding binding = ReadDirectoryBinding(created.Handle, label + "-binding");
    Require(label + "-same-parent-file", !binding.Directory && !binding.Reparse && !binding.DeletePending && binding.Volume == parent.Binding.Volume &&
      EntryMatches(Entries(parent.Guard, label + "-entries"), leaf, binding), BindingDetail(binding));
    uint written;
    bool success = WriteFile(created.Handle.Value, bytes, (uint)bytes.Length, out written, IntPtr.Zero);
    int error = Marshal.GetLastWin32Error();
    Observe("WriteFile", label, success, error, new { bytes = bytes.Length, written = written });
    Require(label + "-written", success && written == bytes.Length, null);
    return created.Handle;
  }
  private static byte[] ReadOwnedBytes(OwnedHandle file, int expectedLength, string label)
  {
    long position;
    bool seek = SetFilePointerEx(file.Value, 0, out position, 0);
    int seekError = Marshal.GetLastWin32Error();
    Observe("SetFilePointerEx", label, seek, seekError, new { position = position });
    Require(label + "-seek", seek && position == 0, null);
    byte[] bytes = new byte[expectedLength + 1];
    uint read;
    bool success = ReadFile(file.Value, bytes, (uint)bytes.Length, out read, IntPtr.Zero);
    int error = Marshal.GetLastWin32Error();
    Observe("ReadFile", label, success, error, new { read = read, expected = expectedLength });
    Require(label + "-length", success && read == expectedLength, null);
    Array.Resize(ref bytes, (int)read);
    return bytes;
  }

  private static void EstablishBoundary(string root, string output)
  {
    string sandbox = Path.GetDirectoryName(root);
    Require("owned-sandbox-output-sibling", Path.GetDirectoryName(output) == sandbox && Path.GetFileName(root) == "fixture", null);
    OwnedHandle sandboxGuard = Open(sandbox, ReadonlyDirectoryAccess, ShareReadWrite, "sandbox-boundary-guard", true);
    DirectoryBinding sandboxBinding = ReadDirectoryBinding(sandboxGuard, "sandbox-boundary");
    Require("sandbox-plain-directory", sandboxBinding.Directory && !sandboxBinding.Reparse && !sandboxBinding.DeletePending, BindingDetail(sandboxBinding));
    SandboxBoundary = new ProtectedDirectory { Weak = sandboxGuard, Guard = sandboxGuard, Binding = sandboxBinding };
    Require("owned-sandbox-ntfs-volume", RequireNtfs(sandboxGuard) == sandboxBinding.Volume, null);
    OwnedHandle weak = Open(root, ReadonlyDirectoryAccess, ShareAll, "fixture-boundary-weak", true);
    DirectoryBinding binding = ReadDirectoryBinding(weak, "fixture-boundary");
    Require("fixture-is-exact-sandbox-child", binding.Directory && !binding.Reparse && !binding.DeletePending && binding.Volume == sandboxBinding.Volume &&
      binding.Canonical == sandboxBinding.Canonical.TrimEnd('\\') + "\\fixture", BindingDetail(binding));
    FixtureBoundary = new ProtectedDirectory { Weak = weak, Binding = binding, Parent = SandboxBoundary, Leaf = "fixture" };
    AddSentinel(FixtureBoundary, "fixture-boundary");
    FixtureBoundary.Guard = ById(binding, ReadonlyDirectoryAccess, ShareReadWrite, "fixture-boundary-guard");
    ValidateProtected(FixtureBoundary, "fixture-boundary-admission");
    RootInitiallyVerified = true;
    Outside = NewDirectory(FixtureBoundary, "outside", true, "outside");
    OutsideMarkerBytes = Encoding.UTF8.GetBytes("owned outside marker: " + Guid.NewGuid().ToString("N"));
    OutsideMarker = NewFile(Outside, "marker.bin", OutsideMarkerBytes, "outside-marker");
    OutsideInventory = Inventory(Outside);
    CalibrationBuffer = MountPointBuffer(Outside.Binding.Canonical);
  }

  private static string Inventory(ProtectedDirectory directory)
  {
    var values = new List<string>();
    foreach (DirectoryEntry entry in Entries(directory.Guard, "outside-inventory"))
      values.Add(entry.Name + ":" + entry.Id.ToString("x16") + ":" + entry.Attributes.ToString("x8"));
    values.Sort(StringComparer.Ordinal);
    return String.Join("|", values.ToArray());
  }
  private static void RequireOutsideUnchanged(string label)
  {
    ValidateProtected(Outside, label + "-outside");
    Require(label + "-outside-unchanged", Inventory(Outside) == OutsideInventory &&
      SameBytes(ReadOwnedBytes(OutsideMarker, OutsideMarkerBytes.Length, label + "-marker"), OutsideMarkerBytes),
      new { originalEntries = OutsideInventory, currentEntries = Inventory(Outside), markerIdentity = Identity(OutsideMarker) });
  }
  private static byte[] MountPointBuffer(string canonical)
  {
    if (!canonical.StartsWith("\\\\?\\", StringComparison.Ordinal) || canonical.Length < 8 || canonical[5] != ':')
      throw new InvalidOperationException("mount-point-local-dos-target-required");
    string print = canonical.Substring(4), substitute = "\\??\\" + print;
    byte[] first = Encoding.Unicode.GetBytes(substitute + "\0"), second = Encoding.Unicode.GetBytes(print + "\0");
    byte[] buffer = new byte[16 + first.Length + second.Length];
    if (buffer.Length > 16384) throw new InvalidOperationException("mount-point-buffer-bound");
    Array.Copy(BitConverter.GetBytes(0xa0000003u), 0, buffer, 0, 4);
    Array.Copy(BitConverter.GetBytes((ushort)(buffer.Length - 8)), 0, buffer, 4, 2);
    Array.Copy(BitConverter.GetBytes((ushort)(first.Length - 2)), 0, buffer, 10, 2);
    Array.Copy(BitConverter.GetBytes((ushort)first.Length), 0, buffer, 12, 2);
    Array.Copy(BitConverter.GetBytes((ushort)(second.Length - 2)), 0, buffer, 14, 2);
    Array.Copy(first, 0, buffer, 16, first.Length);
    Array.Copy(second, 0, buffer, 16 + first.Length, second.Length);
    return buffer;
  }
  private static bool ExactMountPoint(byte[] buffer, uint returned)
  {
    if (returned != CalibrationBuffer.Length || returned < 16 || returned > buffer.Length) return false;
    byte[] actual = new byte[returned];
    Array.Copy(buffer, actual, actual.Length);
    return SameBytes(actual, CalibrationBuffer);
  }
  private static ReparseLease WriterFor(ProtectedDirectory directory, string label)
  {
    OwnedHandle writer = Open(directory.Binding.Canonical, 0x180, ShareAll, label, true);
    DirectoryBinding actual = ReadDirectoryBinding(writer, label + "-binding");
    Require(label + "-same-id-before-fsctl", SameBinding(actual, directory.Binding, true), BindingDetail(actual));
    var lease = new ReparseLease { Writer = writer, Original = directory.Binding };
    ReparseLeases.Add(lease);
    return lease;
  }
  private static bool SetJunction(ReparseLease lease, string label, out int error)
  {
    DirectoryBinding before = ReadDirectoryBinding(lease.Writer, label + "-before");
    Require(label + "-writer-still-original", before.Volume == lease.Original.Volume && before.FileId == lease.Original.FileId &&
      before.Directory && !before.Reparse && !before.DeletePending && before.Canonical == lease.Original.Canonical, BindingDetail(before));
    lease.Unknown = true; // retain unknown on any failure before an authoritative GET
    uint returned;
    bool success = DeviceIoControl(lease.Writer.Value, 0x900a4, CalibrationBuffer, (uint)CalibrationBuffer.Length,
      null, 0, out returned, IntPtr.Zero);
    error = Marshal.GetLastWin32Error();
    Observe("DeviceIoControl(FSCTL_SET_REPARSE_POINT)", label, success, error,
      new { handle = lease.Writer.Value.ToInt64(), access = lease.Writer.Access, share = lease.Writer.Share,
        synchronous = true, bytesReturnedPointerNonNull = true, bytesReturned = returned, bufferBase64 = Convert.ToBase64String(CalibrationBuffer),
        original = BindingDetail(lease.Original) });
    if (!success && error == 997) { PendingNativeIo = true; UnsafeCleanup = true; }
    return success;
  }
  private static bool QueryJunction(ReparseLease lease, string label)
  {
    byte[] buffer = new byte[16384];
    uint returned;
    bool success = DeviceIoControl(lease.Writer.Value, 0x900a8, null, 0, buffer, (uint)buffer.Length, out returned, IntPtr.Zero);
    int error = Marshal.GetLastWin32Error();
    DirectoryBinding current = ReadDirectoryBinding(lease.Writer, label + "-object");
    bool same = current.Volume == lease.Original.Volume && current.FileId == lease.Original.FileId && current.Directory;
    bool active = success && ExactMountPoint(buffer, returned) && same && current.Reparse;
    bool plain = !success && error == 4390 && same && !current.Reparse; // ERROR_NOT_A_REPARSE_POINT
    Observe("DeviceIoControl(FSCTL_GET_REPARSE_POINT)", label, success, error,
      new { handle = lease.Writer.Value.ToInt64(), bytesReturned = returned, exactTarget = active, plain = plain, sameIdentity = same,
        reparseTag = success && returned >= 4 ? BitConverter.ToUInt32(buffer, 0).ToString("x8") : null });
    lease.Active = active;
    lease.Unknown = !active && !plain;
    if (lease.Unknown) UnsafeCleanup = true;
    return active;
  }
  private static void ClearJunction(ReparseLease lease, string label)
  {
    Require(label + "-original-owned-junction", QueryJunction(lease, label + "-before"), null);
    byte[] buffer = new byte[8];
    Array.Copy(BitConverter.GetBytes(0xa0000003u), buffer, 4);
    uint returned;
    bool success = DeviceIoControl(lease.Writer.Value, 0x900ac, buffer, 8, null, 0, out returned, IntPtr.Zero);
    int error = Marshal.GetLastWin32Error();
    Observe("DeviceIoControl(FSCTL_DELETE_REPARSE_POINT)", label, success, error,
      new { handle = lease.Writer.Value.ToInt64(), bytesReturned = returned, originalHandleOnly = true });
    Require(label + "-delete-tag-completed", success, new { win32Error = error });
    bool active = QueryJunction(lease, label + "-after");
    Require(label + "-plain-original-restored", !active && !lease.Unknown, null);
  }
  private static void PrepareCalibrationTarget(out ProtectedDirectory target, out ReparseLease lease, string label)
  {
    // No sentinel: this separate owned target intentionally permits the attack.
    target = NewDirectory(FixtureBoundary, NewLeaf(label), false, label);
    lease = WriterFor(target, label + "-writer");
    int error;
    Require(label + "-real-set-succeeded", SetJunction(lease, label + "-set", out error), new { win32Error = error });
    Require(label + "-real-get-confirmed", QueryJunction(lease, label + "-get"), null);
    RequireOutsideUnchanged(label + "-calibration");
  }
  private static void PreJunctionCreate()
  {
    ProtectedDirectory target;
    ReparseLease lease;
    PrepareCalibrationTarget(out target, out lease, "pre-junction");
    string leaf = NewLeaf("sentinel");
    CreateResult result;
    try { result = CreateRelative(target.Weak, leaf, 0x110080, ShareRead, false, "hostile-root-sentinel"); }
    catch (Exception) { UnsafeCleanup = true; throw; }
    // First inspect outside, before clearing the injected junction or any cleanup.
    bool outsideSame = Inventory(Outside) == OutsideInventory &&
      SameBytes(ReadOwnedBytes(OutsideMarker, OutsideMarkerBytes.Length, "pre-junction-marker"), OutsideMarkerBytes);
    if (!outsideSame) UnsafeCleanup = true;
    Require("pre-junction-create-no-outside-effect", outsideSame, new { leaf = leaf, checkedBeforeCleanup = true });
    bool rejected = result.Completed && result.Status == unchecked((int)0xc000050b);
    bool originalOnly = false;
    if (result.Success)
    {
      DirectoryBinding sentinel = ReadDirectoryBinding(result.Handle, "hostile-root-created-object");
      originalOnly = !sentinel.Directory && !sentinel.Reparse && !sentinel.DeletePending && sentinel.Volume == target.Binding.Volume &&
        EntryMatches(Entries(target.Weak, "hostile-root-original-entries"), leaf, sentinel);
    }
    Require("pre-junction-create-rejected-or-original-only", rejected || originalOnly,
      new { rejectedReparse = rejected, createdInOriginalObject = originalOnly, admissionGranted = false });
    DirectoryBinding root = ReadDirectoryBinding(target.Weak, "hostile-root-admission");
    Require("pre-junction-root-admission-still-rejected", root.Reparse && root.FileId == target.Binding.FileId,
      new { admissionGranted = false });
    if (result.Success)
    {
      Require("pre-junction-own-sentinel-disposition", Disposition(result.Handle, true, "hostile-sentinel-disposition"), null);
      Require("pre-junction-own-sentinel-close", result.Handle.Close(), null);
    }
    ClearJunction(lease, "pre-junction-clear");
    RequireOutsideUnchanged("pre-junction-final");
  }
  private static void SentinelBlocksJunction()
  {
    ProtectedDirectory target = NewDirectory(FixtureBoundary, NewLeaf("protected-set"), true, "protected-set");
    ReparseLease lease = WriterFor(target, "protected-set-writer");
    int error;
    bool set = SetJunction(lease, "protected-set-attempt", out error);
    bool active = QueryJunction(lease, "protected-set-after");
    Require("sentinel-set-exact-directory-not-empty", !set && error == 145 && !active && !lease.Unknown,
      new { win32Error = error, writerOpened = true, writerAccess = 0x180, writerShare = 7, actualFsctlExecuted = true });
    ValidateProtected(target, "protected-set-sentinel-retained");
    RequireOutsideUnchanged("protected-set-final");
  }
  private static OwnedHandle AcquirePrune(ProtectedDirectory directory, string label)
  {
    ValidateProtected(directory, label + "-before");
    Require(label + "-close-readonly-guard", directory.Guard.Close(), null);
    OwnedHandle pin = ById(directory.Binding, 0x10081, ShareReadWrite, label + "-delete-pin");
    DirectoryBinding actual = ReadDirectoryBinding(pin, label + "-candidate"), weak = ReadDirectoryBinding(directory.Weak, label + "-weak");
    bool matches = SameBinding(actual, directory.Binding, true) && SameBinding(weak, directory.Binding, true);
    Observations.Add(new { caseName = CurrentCase, diagnosticOnly = CurrentDiagnostic, api = "ValidateSentinelPruneCandidate", name = label,
      success = matches, actual = BindingDetail(actual), expected = BindingDetail(directory.Binding), weak = BindingDetail(weak),
      pinHandle = pin.Value.ToInt64(), weakHandle = directory.Weak.Value.ToInt64(), removalMutationPerformed = false });
    Require(label + "-same-original-directory", matches, null);
    List<DirectoryEntry> entries = Entries(pin, label + "-only-sentinel-entries");
    Require(label + "-only-owned-sentinel", entries.Count == 1 && EntryMatches(entries, directory.SentinelLeaf, directory.SentinelBinding),
      new { entries = entries.Count, sentinelId = directory.SentinelBinding.FileId.ToString("x16") });
    Require(label + "-close-weak-after-validation", directory.Weak.Close(), null);
    return pin;
  }
  private static void RemoveSentinel(ProtectedDirectory directory, string label)
  {
    DirectoryBinding actual = ReadDirectoryBinding(directory.Sentinel, label + "-binding");
    Require(label + "-same-original-sentinel", SameBinding(actual, directory.SentinelBinding, false), null);
    Require(label + "-sentinel-disposition", Disposition(directory.Sentinel, true, label + "-sentinel-disposition"), null);
    Require(label + "-sentinel-close", directory.Sentinel.Close(), null);
  }
  private static void PruneSentinelDirectory(ProtectedDirectory directory, string label)
  {
    OwnedHandle pin = AcquirePrune(directory, label);
    RemoveSentinel(directory, label);
    // After the last sentinel goes, no name-based open/rename/recursive action.
    Require(label + "-same-handle-disposition", Disposition(pin, true, label + "-directory-disposition"), null);
    Require(label + "-delete-pin-close", pin.Close(), null);
    Require(label + "-directory-entry-gone", EntryAbsent(directory.Parent, directory.Leaf, label + "-parent-after"), null);
  }
  private static void LastSentinelDisposition(bool addChild)
  {
    ProtectedDirectory target = NewDirectory(FixtureBoundary, NewLeaf(addChild ? "late-child" : "last-sentinel"), true, "last-sentinel");
    ReparseLease lease = addChild ? null : WriterFor(target, "last-sentinel-writer");
    OwnedHandle pin = AcquirePrune(target, "last-sentinel");
    RemoveSentinel(target, "last-sentinel");
    if (addChild)
    {
      CreateResult child = CreateRelative(pin, "late-owned-child", 0x110080, ShareRead, false, "late-owned-child");
      Require("late-owned-child-created", child.Success, null);
      bool disposed = Disposition(pin, true, "late-child-directory-disposition");
      int dispositionError = LastDispositionError;
      // Authoritative failure is captured by Disposition; retained child is never force-pruned.
      StandardInformation standard;
      bool query = GetFileInformationByHandleEx(pin.Value, 1, out standard, (uint)Marshal.SizeOf(typeof(StandardInformation)));
      int queryError = Marshal.GetLastWin32Error();
      Observe("GetFileInformationByHandleEx(FileStandardInfo)", "late-child-retained", query, queryError, new { deletePending = standard.DeletePending });
      Require("late-child-prevents-disposition-and-is-retained", !disposed && dispositionError == 145 && query && standard.DeletePending == 0 &&
        EntryMatches(Entries(pin, "late-child-after"), "late-owned-child", ReadDirectoryBinding(child.Handle, "late-child-binding")),
        new { dispositionError = dispositionError, removalRetried = false });
      RequireOutsideUnchanged("late-child-final");
      return;
    }
    int error;
    Require("last-sentinel-real-set-succeeded", SetJunction(lease, "last-sentinel-set", out error), new { win32Error = error });
    Require("last-sentinel-real-get-confirmed", QueryJunction(lease, "last-sentinel-get"), null);
    RequireOutsideUnchanged("last-sentinel-before-disposition");
    Require("last-sentinel-same-pin-disposition", Disposition(pin, true, "last-sentinel-directory-disposition"), null);
    Require("last-sentinel-writer-close", lease.Writer.Close(), null);
    Require("last-sentinel-delete-pin-close", pin.Close(), null);
    bool gone = EntryAbsent(target.Parent, target.Leaf, "last-sentinel-parent-after");
    if (gone) { lease.Active = false; lease.Unknown = false; }
    Require("last-sentinel-original-link-gone", gone, null);
    RequireOutsideUnchanged("last-sentinel-final");
  }
  private static OwnedHandle BoundAlias(ProtectedDirectory directory, string label)
  {
    ValidateProtected(directory, label + "-target");
    OwnedHandle alias = ById(directory.Binding, 0xa0, ShareAll, label);
    Require(label + "-independent-same-object", alias.Value != directory.Guard.Value &&
      SameBinding(ReadDirectoryBinding(alias, label + "-binding"), directory.Binding, true),
      new { duplicateHandle = false, guardAccess = directory.Guard.Access, guardShare = directory.Guard.Share });
    return alias;
  }
  private static void SentinelRoundtrip()
  {
    ProtectedDirectory arena = NewDirectory(FixtureBoundary, "chosen-roundtrip", true, "chosen-root");
    ProtectedDirectory parent = NewDirectory(arena, "source", true, "move-parent"),
      child = NewDirectory(parent, "nested", true, "move-child"), stage = NewDirectory(arena, "stage", true, "move-stage");
    byte[] bytes = Encoding.UTF8.GetBytes("owned complete forward/prune/relative-create/restore payload");
    OwnedHandle file = NewFile(child, "payload.bin", bytes, "chosen-payload");
    string identity = Identity(file);
    OwnedHandle alias = BoundAlias(stage, "chosen-stage-alias");
    ValidateProtected(arena, "forward-arena"); ValidateProtected(parent, "forward-parent"); ValidateProtected(child, "forward-child");
    Require("relative-forward-existing-file-handle", RenameNt(file, alias, "payload.bin", "relative-forward"), null);
    Require("rename-kept-source-object", Identity(file) == identity, null);
    ValidateProtected(stage, "forward-stage-after");
    PruneSentinelDirectory(child, "prune-child");
    PruneSentinelDirectory(parent, "prune-parent");
    ProtectedDirectory restoredParent = NewDirectory(arena, "source", true, "restore-parent"),
      restoredChild = NewDirectory(restoredParent, "nested", true, "restore-child");
    OwnedHandle restoreAlias = BoundAlias(restoredChild, "chosen-restore-alias");
    ValidateProtected(arena, "restore-arena"); ValidateProtected(stage, "restore-stage");
    Require("relative-restore-after-prune", RenameNt(file, restoreAlias, "payload.bin", "relative-restore"), null);
    Require("restore-kept-source-object", Identity(file) == identity, null);
    DirectoryBinding restoredFile = ReadDirectoryBinding(file, "restored-payload-binding");
    Require("restore-preserved-owned-payload-bytes", SameBytes(bytes, ReadOwnedBytes(file, bytes.Length, "restored-payload")) &&
      EntryMatches(Entries(restoredChild.Guard, "restore-child-entries"), "payload.bin", restoredFile) &&
      EntryAbsent(stage, "payload.bin", "restore-stage-entries"), new { expectedBase64 = Convert.ToBase64String(bytes), identity = identity });
    ValidateProtected(restoredParent, "restore-parent-after"); ValidateProtected(restoredChild, "restore-child-after");
    RequireOutsideUnchanged("roundtrip-final");
  }
  private static void UnprotectedRenameDiagnostic()
  {
    ProtectedDirectory source = NewDirectory(FixtureBoundary, NewLeaf("diagnostic-source"), true, "diagnostic-source");
    byte[] bytes = Encoding.UTF8.GetBytes("owned diagnostic only");
    OwnedHandle payload = NewFile(source, "diagnostic.bin", bytes, "diagnostic-payload");
    string identity = Identity(payload);
    ProtectedDirectory target;
    ReparseLease lease;
    PrepareCalibrationTarget(out target, out lease, "diagnostic-junction");
    bool safelyRestored = false;
    try
    {
      OwnedHandle alias = ById(target.Binding, 0xa0, ShareAll, "diagnostic-junction-alias");
      bool moved = RenameNt(payload, alias, "diagnostic.bin", "unprotected-relative-forward");
      bool outsideEffect = Inventory(Outside) != OutsideInventory;
      Observations.Add(new { caseName = CurrentCase, diagnosticOnly = true, api = "UnprotectedRenameOutcome", name = "no-sentinel-diagnostic",
        success = moved, outsideEffectObserved = outsideEffect, capabilityCredit = false, checkedBeforeRestore = true });
      if (moved)
      {
        OwnedHandle restore = BoundAlias(source, "diagnostic-source-alias");
        Require("diagnostic-original-handle-restored", RenameNt(payload, restore, "diagnostic.bin", "diagnostic-original-handle-restore"), null);
      }
      DirectoryBinding original = ReadDirectoryBinding(payload, "diagnostic-restored-payload");
      Require("diagnostic-restore-kept-original-id-bytes-and-entry", Identity(payload) == identity &&
        SameBytes(bytes, ReadOwnedBytes(payload, bytes.Length, "diagnostic-restored-bytes")) &&
        EntryMatches(Entries(source.Guard, "diagnostic-restored-source"), "diagnostic.bin", original), null);
      ClearJunction(lease, "diagnostic-junction-clear");
      RequireOutsideUnchanged("diagnostic-final");
      safelyRestored = true;
    }
    finally { if (!safelyRestored) { UnsafeCleanup = true; Failed = true; } }
  }

  private static OwnedHandle TryPinForPrune(OwnedHandle guard, OwnedHandle weak, OwnedHandle volumeHint,
    DirectoryBinding expected, ulong descriptorId, Action afterGuardClose, string label, out string reason)
  {
    Require(label + "-weak-retained-before-guard-close", weak.Value != IntPtr.Zero && weak.Value != Invalid,
      new { weakHandle = weak.Value.ToInt64() });
    Require(label + "-close-readonly-guard", guard.Close(), null);
    if (afterGuardClose != null) afterGuardClose(); // explicit owned-fixture barrier, not a retry or watcher
    var descriptor = new FileIdDescriptor { Size = (uint)Marshal.SizeOf(typeof(FileIdDescriptor)), Type = 0, FileId = unchecked((long)descriptorId) };
    IntPtr value = OpenFileById(volumeHint.Value, ref descriptor, PruneAccess, ShareRead, IntPtr.Zero, NoFollow);
    int error = Marshal.GetLastWin32Error();
    bool opened = value != Invalid;
    Observe("OpenFileById", label, opened, error, new { handle = value.ToInt64(), access = PruneAccess, share = ShareRead, flags = NoFollow,
      descriptorSize = descriptor.Size, descriptorType = descriptor.Type, fileId = descriptorId.ToString("x16"),
      volumeHint = volumeHint.Value.ToInt64(), weakHandle = weak.Value.ToInt64(), guardClosed = guard.Value == IntPtr.Zero,
      securityAttributesNull = true });
    OwnedHandle pin = new OwnedHandle(value, label, PruneAccess, ShareRead);
    if (!opened) { reason = "open-by-id-failed"; return null; }
    DirectoryBinding actual = ReadDirectoryBinding(pin, label + "-candidate");
    DirectoryBinding currentWeak = ReadDirectoryBinding(weak, label + "-weak-revalidation");
    bool weakSameIdentity = currentWeak.Volume == expected.Volume && currentWeak.FileId == expected.FileId;
    reason = actual.Volume != expected.Volume ? "volume-mismatch" : actual.FileId != expected.FileId ? "id-mismatch" :
      !weakSameIdentity ? "weak-identity-mismatch" : actual.Reparse || currentWeak.Reparse ? "reparse" :
      !actual.Directory || !currentWeak.Directory ? "not-directory" : actual.DeletePending || currentWeak.DeletePending ? "delete-pending" :
      !String.Equals(actual.Canonical, expected.Canonical, StringComparison.Ordinal) ||
      !String.Equals(currentWeak.Canonical, expected.Canonical, StringComparison.Ordinal) ? "canonical-drift" : "matched";
    Observations.Add(new { caseName = CurrentCase, diagnosticOnly = CurrentDiagnostic, api = "ValidateByIdPruneCandidate", name = label,
      success = reason == "matched", reason = reason, weakStillLive = weak.Value != IntPtr.Zero && weak.Value != Invalid,
      expectedVolume = expected.Volume, actualVolume = actual.Volume, expectedId = expected.FileId.ToString("x16"),
      actualId = actual.FileId.ToString("x16"), expectedCanonical = expected.Canonical, actualCanonical = actual.Canonical,
      weakSameIdentity = weakSameIdentity, weakVolume = currentWeak.Volume, weakId = currentWeak.FileId.ToString("x16"),
      weakCanonical = currentWeak.Canonical, noReparse = !actual.Reparse && !currentWeak.Reparse,
      directory = actual.Directory && currentWeak.Directory, deletePending = actual.DeletePending || currentWeak.DeletePending,
      removalMutationPerformed = false });
    if (reason != "matched") { pin.Close(); return null; }
    Require(label + "-close-weak-after-id-revalidation", weak.Close(), null);
    return pin;
  }

  private static void PruneById(OwnedHandle guard, OwnedHandle weak, OwnedHandle volumeHint, DirectoryBinding expected, string label)
  {
    string reason;
    OwnedHandle pin = TryPinForPrune(guard, weak, volumeHint, expected, expected.FileId, null, label, out reason);
    Require(label + "-bound-delete-pin", pin != null, new { reason = reason });
    Require(label + "-same-handle-disposition", Disposition(pin, true, label + "-disposition"), null);
    Require(label + "-last-delete-pin-close", pin.Close(), null);
  }

  private static void Sharing(string root)
  {
    string file = Path.Combine(root, "sharing.bin");
    const string bytes = "owned sharing sentinel";
    File.WriteAllText(file, bytes);
    OwnedHandle weak = Open(file, ReadAttributes, ShareAll, "weak-file", true);
    OwnedHandle strong = Open(file, ReadAttributes | DeleteAccess, ShareRead, "strong-file", true);
    Require("weak-and-strong-same-object", Identity(weak) == Identity(strong), null);
    strong.Close();
    foreach (uint access in new uint[] { 0x40000000, DeleteAccess })
    {
      string kind = access == DeleteAccess ? "deleter" : "writer";
      OwnedHandle conflict = Open(file, access, ShareAll, "preopened-" + kind, true);
      IntPtr denied = CreateFileW(file, ReadAttributes | DeleteAccess, ShareRead, IntPtr.Zero, OpenExisting, NoFollow, IntPtr.Zero);
      int error = Marshal.GetLastWin32Error();
      Observe("CreateFileW", "strong-with-preopened-" + kind, denied != Invalid, error, null);
      if (denied != Invalid) new OwnedHandle(denied, "unexpected-strong").Close();
      Require("preopened-" + kind + "-denies-strong", denied == Invalid && error == 32, new { win32Error = error });
      conflict.Close();
    }
    weak.Close();
    Require("sharing-probe-preserved-bytes", File.ReadAllText(file) == bytes, null);
  }

  private static bool SameBytes(byte[] first, byte[] second)
  {
    if (first.Length != second.Length) return false;
    for (int i = 0; i < first.Length; i++) if (first[i] != second[i]) return false;
    return true;
  }

  private static void Win32ForwardControl(string fixtureRoot, bool metadataAlias)
  {
    string root = Path.Combine(fixtureRoot, CurrentCase);
    CreateOwnedDirectory(root, "create-control-root");
    string source = Path.Combine(root, "source");
    string child = Path.Combine(source, "nested");
    string stage = Path.Combine(root, "stage");
    CreateOwnedDirectory(source, "create-control-source");
    CreateOwnedDirectory(child, "create-control-child");
    CreateOwnedDirectory(stage, "create-control-stage");
    string original = Path.Combine(child, "payload.bin");
    File.WriteAllText(original, "owned diagnostic payload");
    Open(source, ReadAttributes, ShareAll, "control-weak-parent", true);
    Open(child, ReadAttributes, ShareAll, "control-weak-child", true);
    Open(original, ReadAttributes, ShareAll, "control-weak-payload", true);
    Open(source, DirectoryAccess, ShareRead, "control-strong-parent", true);
    Open(child, DirectoryAccess, ShareRead, "control-strong-child", true);
    OwnedHandle file = Open(original, ReadAttributes | DeleteAccess, ShareRead, "control-strong-payload", true);
    OwnedHandle target = Open(stage, DirectoryAccess, ShareRead, "control-strong-stage", true);
    if (metadataAlias) target = MetadataAlias(stage, target, "control-metadata-alias");
    string identity = Identity(file);
    bool moved = RenameWin32(file, target, "payload.bin", "relative-forward-original-buffer", false);
    Require("diagnostic-relative-forward", moved, new { selectedPrimitive = false, original930BufferLength = true, metadataAlias = metadataAlias });
    Require("diagnostic-source-object-unchanged", Identity(file) == identity, null);
  }

  private static void Roundtrip(string fixtureRoot, bool useNt, bool byIdPrune)
  {
    string root = Path.Combine(fixtureRoot, CurrentCase);
    CreateOwnedDirectory(root, "create-roundtrip-root");
    string source = Path.Combine(root, "source");
    string child = Path.Combine(source, "nested");
    string stage = Path.Combine(root, "stage");
    CreateOwnedDirectory(source, "create-source");
    CreateOwnedDirectory(child, "create-child");
    CreateOwnedDirectory(stage, "create-stage");
    string original = Path.Combine(child, "payload.bin");
    const string bytes = "owned rename/prune/restore sentinel";
    File.WriteAllText(original, bytes);
    byte[] expectedBytes = File.ReadAllBytes(original);
    OwnedHandle weakParent = Open(source, ReadAttributes, ShareAll, "weak-parent", true);
    OwnedHandle weakChild = Open(child, ReadAttributes, ShareAll, "weak-child", true);
    OwnedHandle weakFile = Open(original, ReadAttributes, ShareAll, "weak-payload", true);
    uint directoryAccess = byIdPrune ? ReadonlyDirectoryAccess : DirectoryAccess;
    string guardPrefix = byIdPrune ? "move-guard-" : "strong-";
    OwnedHandle parent = Open(source, directoryAccess, ShareRead, guardPrefix + "parent", true);
    OwnedHandle nested = Open(child, directoryAccess, ShareRead, guardPrefix + "child", true);
    OwnedHandle file = Open(original, ReadAttributes | DeleteAccess, ShareRead, "strong-payload", true);
    OwnedHandle staging = Open(stage, directoryAccess, ShareRead, guardPrefix + "stage", true);
    OwnedHandle volumeHint = byIdPrune ? Open(root, ReadonlyDirectoryAccess, ShareRead, "move-guard-case-root", true) : null;
    DirectoryBinding parentBinding = null, childBinding = null;
    if (byIdPrune)
    {
      Open(fixtureRoot, ReadonlyDirectoryAccess, ShareRead, "move-guard-fixture-root", true);
      uint volume = RequireNtfs(volumeHint);
      parentBinding = ReadDirectoryBinding(weakParent, "snapshot-parent");
      childBinding = ReadDirectoryBinding(weakChild, "snapshot-child");
      Require("initial-directory-bindings", parentBinding.Volume == volume && childBinding.Volume == volume &&
        parentBinding.Directory && childBinding.Directory && !parentBinding.Reparse && !childBinding.Reparse &&
        !parentBinding.DeletePending && !childBinding.DeletePending && parentBinding.FileId != 0 && childBinding.FileId != 0, null);
    }
    string identity = Identity(file);
    Require("weak-and-strong-directories-coexist", Identity(weakParent) == Identity(parent) && Identity(weakChild) == Identity(nested), null);

    OwnedHandle targetAlias = MetadataAlias(stage, staging, "stage-metadata-alias");
    bool forward = useNt ? RenameNt(file, targetAlias, "payload.bin", "relative-forward") :
      RenameWin32(file, targetAlias, "payload.bin", "relative-forward", true);
    Require("relative-forward-existing-file-handle", forward, new { chosen = byIdPrune, targetAlias = true });
    Require("rename-kept-source-object", Identity(file) == identity, null);

    if (byIdPrune)
    {
      Require("close-payload-weak-before-prune", weakFile.Close(), null);
      // Only the directory being pruned releases its readonly guard. Its weak
      // retains the original object while by-ID acquires and validates DELETE.
      // Parent / stage / case-root guards remain at shareREAD throughout.
      PruneById(nested, weakChild, volumeHint, childBinding, "prune-child-byid");
      PruneById(parent, weakParent, volumeHint, parentBinding, "prune-parent-byid");
    }
    else
    {
      Require("mark-empty-child-delete-pending", Disposition(nested, true, "child-pending-with-weak"), null);
      StandardInformation standard;
      bool info = GetFileInformationByHandleEx(weakChild.Value, 1, out standard, (uint)Marshal.SizeOf(typeof(StandardInformation)));
      int infoError = Marshal.GetLastWin32Error();
      Observe("GetFileInformationByHandleEx(FileStandardInfo)", "weak-child-pending", info, infoError,
        new { bytes = Marshal.SizeOf(typeof(StandardInformation)), deletePending = standard.DeletePending, directory = standard.Directory });
      Require("weak-observes-delete-pending", info && standard.DeletePending != 0, null);
      Require("cancel-delete-pending-on-same-handle", Disposition(nested, false, "clear-child-pending"), null);
      weakFile.Close(); weakChild.Close(); weakParent.Close();
      Require("prune-child-after-weak-release", Disposition(nested, true, "prune-child"), null);
      nested.Close();
      Require("prune-parent-after-weak-release", Disposition(parent, true, "prune-parent"), null);
      parent.Close();
    }
    CreateOwnedDirectory(source, "restore-source-name-after-prune");
    CreateOwnedDirectory(child, "restore-child-name-after-prune");
    OwnedHandle restoredParent = Open(source, directoryAccess, ShareRead, byIdPrune ? "restore-guard-parent" : "restored-parent", true);
    OwnedHandle restoredChild = Open(child, directoryAccess, ShareRead, byIdPrune ? "restore-guard-child" : "restored-child", true);
    OwnedHandle restoreAlias = MetadataAlias(child, restoredChild, "restore-metadata-alias");
    bool restored = useNt ? RenameNt(file, restoreAlias, "payload.bin", "relative-restore") :
      RenameWin32(file, restoreAlias, "payload.bin", "relative-restore", true);
    Require("relative-restore-after-prune", restored, new { chosen = byIdPrune, targetAlias = true });
    Require("restore-kept-source-object", Identity(file) == identity, null);
    file.Close(); restoreAlias.Close(); restoredChild.Close(); restoredParent.Close(); targetAlias.Close(); staging.Close();
    byte[] observedBytes = File.ReadAllBytes(original);
    Require("restore-preserved-owned-payload-bytes", SameBytes(expectedBytes, observedBytes) && !File.Exists(Path.Combine(stage, "payload.bin")),
      new { expectedBase64 = Convert.ToBase64String(expectedBytes), restoredBase64 = Convert.ToBase64String(observedBytes) });
  }

  private static void RejectedByIdTransition(string fixtureRoot, bool drift)
  {
    string root = Path.Combine(fixtureRoot, CurrentCase);
    CreateOwnedDirectory(root, "create-rejection-root");
    string original = Path.Combine(root, "original");
    string other = Path.Combine(root, "other");
    string moved = Path.Combine(root, "moved");
    CreateOwnedDirectory(original, "create-rejection-original");
    CreateOwnedDirectory(other, "create-rejection-other");
    const string bytes = "owned by-id rejection sentinel";
    File.WriteAllText(Path.Combine(original, "sentinel.bin"), bytes);
    File.WriteAllText(Path.Combine(other, "sentinel.bin"), bytes);
    // These independent negative fixtures intentionally permit the owned rename
    // injection. An unrelated share1 parent must not turn error32 into a pass.
    OwnedHandle volumeHint = Open(root, ReadonlyDirectoryAccess, ShareReadWrite, "move-guard-rejection-parent", true);
    Open(fixtureRoot, ReadonlyDirectoryAccess, ShareReadWrite, "move-guard-fixture-root", true);
    uint volume = RequireNtfs(volumeHint);
    OwnedHandle weak = Open(original, ReadAttributes, ShareAll, "rejection-weak-original", true);
    OwnedHandle otherWeak = Open(other, ReadAttributes, ShareAll, "rejection-weak-other", true);
    OwnedHandle guard = Open(original, ReadonlyDirectoryAccess, ShareReadWrite, "move-guard-rejection-original", true);
    OwnedHandle otherGuard = Open(other, ReadonlyDirectoryAccess, ShareReadWrite, "move-guard-rejection-other", true);
    DirectoryBinding expected = ReadDirectoryBinding(weak, "rejection-snapshot-original");
    DirectoryBinding otherBinding = ReadDirectoryBinding(otherWeak, "rejection-snapshot-other");
    Require("rejection-fixture-distinct-ntfs-objects", expected.Volume == volume && otherBinding.Volume == volume &&
      expected.FileId != otherBinding.FileId && !expected.Reparse && !otherBinding.Reparse &&
      expected.Directory && otherBinding.Directory && !expected.DeletePending && !otherBinding.DeletePending, null);
    Action barrier = null;
    if (drift) barrier = delegate {
      bool renamed = MoveFileExW(original, moved, 0);
      int error = Marshal.GetLastWin32Error();
      Observe("MoveFileExW(owned-fixture-barrier)", "inject-canonical-drift", renamed, error, new { flags = 0 });
      Require("owned-canonical-drift-injected", renamed, new { win32Error = error });
    };
    else
    {
      // Deliberately permit the wrong owned object to open so the identity
      // validator, not an incidental sharing error, must reject it. Both weak
      // snapshots and the parent guard remain live; no removal is attempted.
      Require("release-wrong-object-guard-for-id-mismatch-control", otherGuard.Close(), null);
    }
    string reason;
    OwnedHandle pin = TryPinForPrune(guard, weak, volumeHint, expected, drift ? expected.FileId : otherBinding.FileId,
      barrier, "rejection-byid", out reason);
    Require("byid-transition-rejected-with-specific-reason", pin == null && reason == (drift ? "canonical-drift" : "id-mismatch"),
      new { reason = reason, removalMutationPerformed = false });
    Require("rejection-retains-original-weak-object", weak.Value != IntPtr.Zero && Identity(weak) ==
      expected.Volume.ToString("x8") + ":" + expected.FileId.ToString("x16"), null);
    Require("rejection-keeps-owned-sentinels", File.ReadAllText(Path.Combine(drift ? moved : original, "sentinel.bin")) == bytes &&
      File.ReadAllText(Path.Combine(other, "sentinel.bin")) == bytes, null);
  }

  private static void WeakLifetime(string root, bool extraReader)
  {
    string parentPath = Path.Combine(root, extraReader ? "lifetime-reader-parent" : "lifetime-weak-parent");
    string childPath = Path.Combine(parentPath, "nested");
    CreateOwnedDirectory(parentPath, "create-lifetime-parent");
    CreateOwnedDirectory(childPath, "create-lifetime-child");
    OwnedHandle weak = Open(childPath, ReadAttributes, ShareAll, "lifetime-weak-child", true);
    OwnedHandle reader = extraReader ? Open(childPath, ReadAttributes | 1, ShareAll, "extra-shared-reader", true) : null;
    OwnedHandle parent = Open(parentPath, DirectoryAccess, ShareRead, "lifetime-strong-parent", true);
    OwnedHandle child = Open(childPath, DirectoryAccess, ShareRead, "lifetime-strong-child", true);
    Require("lifetime-mark-child", Disposition(child, true, "lifetime-mark-child"), null);
    child.Close();
    if (extraReader) weak.Close();
    OwnedHandle retained = extraReader ? reader : weak;
    StandardInformation info;
    bool queried = GetFileInformationByHandleEx(retained.Value, 1, out info, (uint)Marshal.SizeOf(typeof(StandardInformation)));
    int queryError = Marshal.GetLastWin32Error();
    Observe("GetFileInformationByHandleEx(FileStandardInfo)", "after-strong-close-retained-handle-live", queried, queryError,
      new { deletePending = info.DeletePending, extraReader = extraReader, parentWeakAlreadyClosed = extraReader });
    Require("retained-handle-keeps-pending-object-live", queried && info.DeletePending != 0, null);
    // The exact OS result is an observation, not an assumed DIR_NOT_EMPTY.
    bool before = Disposition(parent, true, "parent-prune-before-weak-release");
    if (before) Require("cancel-early-parent-mark", Disposition(parent, false, "clear-early-parent-mark"), null);
    retained.Close();
    Require("lifetime-parent-prunes-after-weak-close", Disposition(parent, true, "parent-prune-after-weak-release"), null);
    parent.Close();
    CreateOwnedDirectory(parentPath, "lifetime-parent-name-reusable");
    CreateOwnedDirectory(childPath, "lifetime-child-name-reusable");
  }

  private static bool RunCase(string name, bool diagnostic, Action action)
  {
    CurrentCase = name;
    CurrentDiagnostic = diagnostic;
    CurrentCaseFailed = false;
    int firstHandle = Handles.Count;
    int firstLease = ReparseLeases.Count;
    try { Require(name + "-no-prior-pending-io", !PendingNativeIo, null); action(); }
    catch (Exception error)
    {
      CurrentCaseFailed = true;
      if (diagnostic) DiagnosticChecks.Add(new { caseName = name, name = "exception", status = "observed-incomplete", capabilityCredit = false, detail = error.ToString() });
      else { Failed = true; Checks.Add(new { caseName = name, name = name + "-exception", status = "failed", detail = error.ToString() }); }
    }
    finally
    {
      // Known injected tags may only be removed through their bound original
      // writer. Unknown state is retained, never traversed by recursive cleanup.
      for (int i = ReparseLeases.Count - 1; i >= firstLease; i--)
      {
        ReparseLease lease = ReparseLeases[i];
        if (lease.Active && !lease.Unknown && !PendingNativeIo && lease.Writer.Value != IntPtr.Zero)
        {
          try { ClearJunction(lease, "case-finally-owned-tag-clear"); }
          catch (Exception) { UnsafeCleanup = true; CurrentCaseFailed = true; if (!diagnostic) Failed = true; }
        }
      }
      if (!PendingNativeIo) for (int i = Handles.Count - 1; i >= firstHandle; i--) Handles[i].Close();
    }
    bool completed = !CurrentCaseFailed;
    CaseResults.Add(new { name = name, role = diagnostic ? "diagnostic" : "required", completed = completed,
      capabilityCredit = !diagnostic && completed, fullRoundtrip = name.IndexOf("roundtrip", StringComparison.Ordinal) >= 0 && completed });
    CurrentCase = null;
    CurrentDiagnostic = false;
    return completed;
  }

  private static object ToolVersions(string input)
  {
    var versions = new Dictionary<string, object>();
    if (input == null) return versions;
    foreach (string file in File.ReadAllLines(input))
    {
      try
      {
        var info = System.Diagnostics.FileVersionInfo.GetVersionInfo(file);
        versions[file] = new { fileVersion = info.FileVersion, productVersion = info.ProductVersion };
      }
      catch (Exception error) { versions[file] = new { error = error.Message }; }
    }
    return versions;
  }

  private static string Json(object value)
  {
    if (value == null) return "null";
    if (value is string || value is char)
    {
      var output = new StringBuilder("\"");
      foreach (char c in Convert.ToString(value, CultureInfo.InvariantCulture))
      {
        if (c == '\\') output.Append("\\\\");
        else if (c == '"') output.Append("\\\"");
        else if (c < 32) output.Append("\\u" + ((int)c).ToString("x4"));
        else output.Append(c);
      }
      return output.Append('"').ToString();
    }
    if (value is bool) return (bool)value ? "true" : "false";
    if (value.GetType().IsPrimitive || value is decimal) return Convert.ToString(value, CultureInfo.InvariantCulture);
    var parts = new List<string>();
    var dictionary = value as IDictionary;
    if (dictionary != null)
    {
      foreach (DictionaryEntry entry in dictionary) parts.Add(Json(entry.Key) + ":" + Json(entry.Value));
      return "{" + String.Join(",", parts) + "}";
    }
    var enumerable = value as IEnumerable;
    if (enumerable != null)
    {
      foreach (object item in enumerable) parts.Add(Json(item));
      return "[" + String.Join(",", parts) + "]";
    }
    foreach (PropertyInfo property in value.GetType().GetProperties()) parts.Add(Json(property.Name) + ":" + Json(property.GetValue(value, null)));
    return "{" + String.Join(",", parts) + "}";
  }

  private static int Main(string[] args)
  {
    if (args.Length < 2 || args.Length > 3) return 2;
    string root = Path.GetFullPath(args[0]);
    string output = Path.GetFullPath(args[1]);
    try
    {
      Require("native-process-width", IntPtr.Size == 4 || IntPtr.Size == 8, new { pointerBytes = IntPtr.Size });
      Require("rename-sdk-layout", Marshal.OffsetOf(typeof(RenameInformation), "RootDirectory").ToInt32() == (IntPtr.Size == 4 ? 4 : 8) &&
        Marshal.OffsetOf(typeof(RenameInformation), "FileNameLength").ToInt32() == (IntPtr.Size == 4 ? 8 : 16) &&
        Marshal.OffsetOf(typeof(RenameInformation), "FileName").ToInt32() == (IntPtr.Size == 4 ? 12 : 20) &&
        Marshal.SizeOf(typeof(RenameInformation)) == (IntPtr.Size == 4 ? 16 : 24), null);
      Require("io-status-block-layout", Marshal.SizeOf(typeof(IoStatusUnion)) == IntPtr.Size &&
        Marshal.SizeOf(typeof(IoStatusBlock)) == IntPtr.Size * 2 &&
        Marshal.OffsetOf(typeof(IoStatusBlock), "Information").ToInt32() == IntPtr.Size, null);
      Require("file-id-descriptor-sdk-layout", Marshal.SizeOf(typeof(FileIdDescriptor)) == 24 &&
        Marshal.OffsetOf(typeof(FileIdDescriptor), "Size").ToInt32() == 0 &&
        Marshal.OffsetOf(typeof(FileIdDescriptor), "Type").ToInt32() == 4 &&
        Marshal.OffsetOf(typeof(FileIdDescriptor), "FileId").ToInt32() == 8, null);
      Require("directory-entry-sdk-layout", Marshal.OffsetOf(typeof(DirectoryEntryLayout), "Name").ToInt32() == 104 &&
        Marshal.OffsetOf(typeof(DirectoryEntryLayout), "Id").ToInt32() == 96, null);
      Require("owned-empty-fixture-root", Directory.Exists(root) && Directory.GetFileSystemEntries(root).Length == 0 &&
        (File.GetAttributes(root) & FileAttributes.ReparsePoint) == 0, null);
      EstablishBoundary(root, output);
      RunCase("sharing", false, delegate { Sharing(root); });
      RunCase("control-win32-strong-original-buffer", true, delegate { Win32ForwardControl(root, false); });
      RunCase("control-win32-metadata-original-buffer", true, delegate { Win32ForwardControl(root, true); });
      RunCase("control-win32-metadata-contract-roundtrip", true, delegate { Roundtrip(root, false, false); });
      RunCase("control-nt-strong-metadata-roundtrip", true, delegate { Roundtrip(root, true, false); });
      RunCase("control-nt-readonly-share1-roundtrip", true, delegate { Roundtrip(root, true, true); });
      bool noEscape = RunCase("pre-junction-relative-create", false, PreJunctionCreate);
      RunCase("control-nt-no-sentinel-pre-junction", true, UnprotectedRenameDiagnostic);
      bool nonempty = RunCase("sentinel-blocks-junction", false, SentinelBlocksJunction);
      bool disposition = RunCase("last-sentinel-junction-disposition", false, delegate { LastSentinelDisposition(false); });
      bool lateChild = RunCase("last-sentinel-new-child-rejected", false, delegate { LastSentinelDisposition(true); });
      ChosenRoundtripPassed = RunCase("chosen-sentinel-share3-roundtrip", false, delegate {
        Require("controlled-reparse-prerequisites-passed", noEscape && nonempty && disposition && lateChild, null);
        SentinelRoundtrip();
      });
      RunCase("byid-reject-canonical-drift", false, delegate { RejectedByIdTransition(root, true); });
      RunCase("byid-reject-id-mismatch", false, delegate { RejectedByIdTransition(root, false); });
      RunCase("weak-lifetime", false, delegate { WeakLifetime(root, false); });
      RunCase("shared-reader-lifetime", false, delegate { WeakLifetime(root, true); });
    }
    catch (Exception error)
    {
      Failed = true;
      Checks.Add(new { name = "probe-exception", status = "failed", detail = error.ToString() });
    }
    finally { if (!PendingNativeIo) for (int i = Handles.Count - 1; i >= 0; i--) Handles[i].Close(); }
    bool reparseUncertain = false, handlesClosed = true;
    foreach (ReparseLease lease in ReparseLeases) if (lease.Active || lease.Unknown) reparseUncertain = true;
    foreach (OwnedHandle handle in Handles) if (handle.Value != IntPtr.Zero && handle.Value != Invalid) handlesClosed = false;
    bool safeCleanup = RootInitiallyVerified && !PendingNativeIo && !UnsafeCleanup && !reparseUncertain && handlesClosed;
    if (!safeCleanup) Failed = true;
    var report = new {
      version = 4, status = Failed ? "failed" : "passed", processPointerBytes = IntPtr.Size,
      chosenPrimitive = ChosenPrimitive, chosenPrimitiveStatus = ChosenRoundtripPassed ? "passed" : "failed",
      oldWin32Scheme = "diagnostic only; 930 x86/x64 observed FALSE 87, not granted chosen capability",
      oldStrongNtScheme = "diagnostic only; fd452 x86/x64 observed c0000043 / derived DOS32, nonpending; not granted chosen capability",
      oldReadonlyShare1Scheme = "diagnostic only; e5a7 x86/x64 observed c0000043 / derived DOS32; not granted chosen capability",
      controlledThreatBoundary = "fresh private sandbox only; not installed ancestry to volume root",
      sandboxBinding = SandboxBoundary == null ? null : BindingDetail(SandboxBoundary.Binding),
      fixtureBinding = FixtureBoundary == null ? null : BindingDetail(FixtureBoundary.Binding),
      outsideBinding = Outside == null ? null : BindingDetail(Outside.Binding),
      safeForControllerCleanup = safeCleanup, cleanupState = new { rootInitiallyVerified = RootInitiallyVerified,
        pendingNativeIo = PendingNativeIo, unsafeEffectObserved = UnsafeCleanup, reparseUncertain = reparseUncertain, allHandlesClosed = handlesClosed },
      ownedFixtureRoot = root, executable = System.Reflection.Assembly.GetExecutingAssembly().Location,
      renameNameOffset = Marshal.OffsetOf(typeof(RenameInformation), "FileName").ToInt32(),
      renameInformationBytes = Marshal.SizeOf(typeof(RenameInformation)), fileInformationBytes = Marshal.SizeOf(typeof(FileInformation)),
      standardInformationBytes = Marshal.SizeOf(typeof(StandardInformation)),
      ioStatusBlockBytes = Marshal.SizeOf(typeof(IoStatusBlock)),
      ioInformationOffset = Marshal.OffsetOf(typeof(IoStatusBlock), "Information").ToInt32(),
      fileIdDescriptorBytes = Marshal.SizeOf(typeof(FileIdDescriptor)),
      fileIdDescriptorUnionOffset = Marshal.OffsetOf(typeof(FileIdDescriptor), "FileId").ToInt32(),
      directoryEntryNameOffset = Marshal.OffsetOf(typeof(DirectoryEntryLayout), "Name").ToInt32(),
      directoryEntryIdOffset = Marshal.OffsetOf(typeof(DirectoryEntryLayout), "Id").ToInt32(),
      checks = Checks, diagnosticChecks = DiagnosticChecks, caseResults = CaseResults, observations = Observations,
      toolFileVersions = ToolVersions(args.Length == 3 ? args[2] : null),
      realAccountsCreated = 0, realProfilesCreated = 0, officialOldPeExecuted = false, productPeExecuted = false,
      fixtureKind = "owned-temp-native-api-only", crossProcessPinnedAck = "not_run", junctionRaces = "not_run",
      completeFailureRestore = "unknown", productRemoval = "not_run", f1 = "not_run"
    };
    File.WriteAllText(output, Json(report), new UTF8Encoding(false));
    return Failed ? 1 : 0;
  }
}
