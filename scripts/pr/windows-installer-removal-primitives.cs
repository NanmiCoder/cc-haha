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
  private const string ChosenPrimitive = "NtSetInformationFile(FileRenameInformation=10)+readonly-directory-guards+metadata-target-alias+OpenFileById-prune";

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

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(IntPtr handle, out FileInformation information);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandleEx(IntPtr handle, int informationClass, out StandardInformation information, uint length);
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
        else request.RetainUntilProcessExit = true; // do not free buffers still owned by pending I/O
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
    OwnedHandle volumeHint = Open(root, ReadonlyDirectoryAccess, ShareRead, "move-guard-rejection-parent", true);
    Open(fixtureRoot, ReadonlyDirectoryAccess, ShareRead, "move-guard-fixture-root", true);
    uint volume = RequireNtfs(volumeHint);
    OwnedHandle weak = Open(original, ReadAttributes, ShareAll, "rejection-weak-original", true);
    OwnedHandle otherWeak = Open(other, ReadAttributes, ShareAll, "rejection-weak-other", true);
    OwnedHandle guard = Open(original, ReadonlyDirectoryAccess, ShareRead, "move-guard-rejection-original", true);
    OwnedHandle otherGuard = Open(other, ReadonlyDirectoryAccess, ShareRead, "move-guard-rejection-other", true);
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
    try { action(); }
    catch (Exception error)
    {
      CurrentCaseFailed = true;
      if (diagnostic) DiagnosticChecks.Add(new { caseName = name, name = "exception", status = "observed-incomplete", capabilityCredit = false, detail = error.ToString() });
      else { Failed = true; Checks.Add(new { caseName = name, name = name + "-exception", status = "failed", detail = error.ToString() }); }
    }
    finally { for (int i = Handles.Count - 1; i >= firstHandle; i--) Handles[i].Close(); }
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
      Require("owned-empty-fixture-root", Directory.Exists(root) && Directory.GetFileSystemEntries(root).Length == 0 &&
        (File.GetAttributes(root) & FileAttributes.ReparsePoint) == 0, null);
      RunCase("sharing", false, delegate { Sharing(root); });
      RunCase("control-win32-strong-original-buffer", true, delegate { Win32ForwardControl(root, false); });
      RunCase("control-win32-metadata-original-buffer", true, delegate { Win32ForwardControl(root, true); });
      RunCase("control-win32-metadata-contract-roundtrip", true, delegate { Roundtrip(root, false, false); });
      RunCase("control-nt-strong-metadata-roundtrip", true, delegate { Roundtrip(root, true, false); });
      ChosenRoundtripPassed = RunCase("chosen-nt-readonly-byid-roundtrip", false, delegate { Roundtrip(root, true, true); });
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
    finally { for (int i = Handles.Count - 1; i >= 0; i--) Handles[i].Close(); }
    var report = new {
      version = 3, status = Failed ? "failed" : "passed", processPointerBytes = IntPtr.Size,
      chosenPrimitive = ChosenPrimitive, chosenPrimitiveStatus = ChosenRoundtripPassed ? "passed" : "failed",
      oldWin32Scheme = "diagnostic only; 930 x86/x64 observed FALSE 87, not granted chosen capability",
      oldStrongNtScheme = "diagnostic only; fd452 x86/x64 observed c0000043 / derived DOS32, nonpending; not granted chosen capability",
      ownedFixtureRoot = root, executable = System.Reflection.Assembly.GetExecutingAssembly().Location,
      renameNameOffset = Marshal.OffsetOf(typeof(RenameInformation), "FileName").ToInt32(),
      renameInformationBytes = Marshal.SizeOf(typeof(RenameInformation)), fileInformationBytes = Marshal.SizeOf(typeof(FileInformation)),
      standardInformationBytes = Marshal.SizeOf(typeof(StandardInformation)),
      ioStatusBlockBytes = Marshal.SizeOf(typeof(IoStatusBlock)),
      ioInformationOffset = Marshal.OffsetOf(typeof(IoStatusBlock), "Information").ToInt32(),
      fileIdDescriptorBytes = Marshal.SizeOf(typeof(FileIdDescriptor)),
      fileIdDescriptorUnionOffset = Marshal.OffsetOf(typeof(FileIdDescriptor), "FileId").ToInt32(),
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
