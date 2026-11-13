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
  private const uint DeleteAccess = 0x10000;
  private const uint DirectoryAccess = DeleteAccess | ReadAttributes | 1 | 2 | 4;
  private const uint ShareRead = 1;
  private const uint ShareAll = 7;
  private const uint OpenExisting = 3;
  private const uint NoFollow = 0x02200000; // BACKUP_SEMANTICS | OPEN_REPARSE_POINT
  private static readonly IntPtr Invalid = new IntPtr(-1);
  private static readonly List<OwnedHandle> Handles = new List<OwnedHandle>();
  private static readonly List<object> Observations = new List<object>();
  private static readonly List<object> Checks = new List<object>();
  private static bool Failed;
  private static string CurrentCase;

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

  private sealed class OwnedHandle
  {
    public IntPtr Value;
    public readonly string Name;
    public OwnedHandle(IntPtr value, string name) { Value = value; Name = name; Handles.Add(this); }
    public void Close()
    {
      if (Value == IntPtr.Zero || Value == Invalid) return;
      bool success = CloseHandle(Value);
      int error = Marshal.GetLastWin32Error();
      Observe("CloseHandle", Name, success, error, null);
      Value = IntPtr.Zero;
      if (!success) Failed = true;
    }
  }

  private static void Observe(string api, string name, bool success, long error, object detail)
  {
    Observations.Add(new { caseName = CurrentCase, api = api, name = name, success = success, win32Error = error,
      errorAuthoritative = !success, errorSource = "GetLastWin32Error", detail = detail });
  }
  private static void Check(string name, bool passed, object detail)
  {
    Checks.Add(new { caseName = CurrentCase, name = name, status = passed ? "passed" : "failed", detail = detail });
    if (!passed) Failed = true;
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
    Observe("CreateFileW", label, success, error, new { access = access, share = share, flags = NoFollow });
    if (required) Require(label, success, new { win32Error = error });
    return new OwnedHandle(handle, label);
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
      Observe("SetFileInformationByHandle(FileDispositionInfo)", label, success, error, new { delete = delete, bytes = 1 });
      return success;
    }
    finally { Marshal.FreeHGlobal(buffer); }
  }
  private static bool Rename(OwnedHandle file, OwnedHandle targetParent, string leaf, string label)
  {
    byte[] name = Encoding.Unicode.GetBytes(leaf);
    int rootOffset = Marshal.OffsetOf(typeof(RenameInformation), "RootDirectory").ToInt32();
    int lengthOffset = Marshal.OffsetOf(typeof(RenameInformation), "FileNameLength").ToInt32();
    int offset = Marshal.OffsetOf(typeof(RenameInformation), "FileName").ToInt32();
    int bytes = Math.Max(Marshal.SizeOf(typeof(RenameInformation)), offset + name.Length + 2);
    IntPtr buffer = Marshal.AllocHGlobal(bytes);
    try
    {
      for (int i = 0; i < bytes; i++) Marshal.WriteByte(buffer, i, 0);
      Marshal.WriteIntPtr(buffer, rootOffset, targetParent.Value);
      Marshal.WriteInt32(buffer, lengthOffset, name.Length);
      Marshal.Copy(name, 0, IntPtr.Add(buffer, offset), name.Length);
      bool result = SetFileInformationByHandle(file.Value, 3, buffer, (uint)bytes);
      int lastError = Marshal.GetLastWin32Error();
      Observe("SetFileInformationByHandle(FileRenameInfo)", label, result, lastError,
        new { rootDirectoryHandle = targetParent.Value.ToInt64(), replaceIfExists = false, leaf = leaf,
          rootOffset = rootOffset, lengthOffset = lengthOffset, nameOffset = offset, nameBytesExcludingNul = name.Length, bufferBytesIncludingNul = bytes });
      return result;
    }
    finally { Marshal.FreeHGlobal(buffer); }
  }
  private static void CreateOwnedDirectory(string path, string label)
  {
    bool success = CreateDirectoryW(path, IntPtr.Zero);
    int error = Marshal.GetLastWin32Error();
    Observe("CreateDirectoryW", label, success, error, null);
    Require(label, success, new { win32Error = error });
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

  private static void Roundtrip(string root)
  {
    string source = Path.Combine(root, "source");
    string child = Path.Combine(source, "nested");
    string stage = Path.Combine(root, "stage");
    CreateOwnedDirectory(source, "create-source");
    CreateOwnedDirectory(child, "create-child");
    CreateOwnedDirectory(stage, "create-stage");
    string original = Path.Combine(child, "payload.bin");
    const string bytes = "owned rename/prune/restore sentinel";
    File.WriteAllText(original, bytes);
    OwnedHandle weakParent = Open(source, ReadAttributes, ShareAll, "weak-parent", true);
    OwnedHandle weakChild = Open(child, ReadAttributes, ShareAll, "weak-child", true);
    OwnedHandle weakFile = Open(original, ReadAttributes, ShareAll, "weak-payload", true);
    OwnedHandle parent = Open(source, DirectoryAccess, ShareRead, "strong-parent", true);
    OwnedHandle nested = Open(child, DirectoryAccess, ShareRead, "strong-child", true);
    OwnedHandle file = Open(original, ReadAttributes | DeleteAccess, ShareRead, "strong-payload", true);
    OwnedHandle staging = Open(stage, DirectoryAccess, ShareRead, "strong-stage", true);
    string identity = Identity(file);
    Require("weak-and-strong-directories-coexist", Identity(weakParent) == Identity(parent) && Identity(weakChild) == Identity(nested), null);

    Require("relative-forward-existing-file-handle", Rename(file, staging, "payload.bin", "relative-forward"), null);
    Require("rename-kept-source-object", Identity(file) == identity, null);

    Require("mark-empty-child-delete-pending", Disposition(nested, true, "child-pending-with-weak"), null);
    StandardInformation standard;
    bool info = GetFileInformationByHandleEx(weakChild.Value, 1, out standard, (uint)Marshal.SizeOf(typeof(StandardInformation)));
    int infoError = Marshal.GetLastWin32Error();
    Observe("GetFileInformationByHandleEx(FileStandardInfo)", "weak-child-pending", info, infoError,
      new { bytes = Marshal.SizeOf(typeof(StandardInformation)), deletePending = standard.DeletePending, directory = standard.Directory });
    Require("weak-observes-delete-pending", info && standard.DeletePending != 0, null);
    Require("cancel-delete-pending-on-same-handle", Disposition(nested, false, "clear-child-pending"), null);

    // Same-process stand-in for PINNED -> parent closes ALL weak -> ACK.
    // A production cross-process handshake is explicitly not proved here.
    weakFile.Close(); weakChild.Close(); weakParent.Close();
    Require("prune-child-after-weak-release", Disposition(nested, true, "prune-child"), null);
    nested.Close();
    Require("prune-parent-after-weak-release", Disposition(parent, true, "prune-parent"), null);
    parent.Close();
    CreateOwnedDirectory(source, "restore-source-name-after-prune");
    CreateOwnedDirectory(child, "restore-child-name-after-prune");
    OwnedHandle restoredParent = Open(source, DirectoryAccess, ShareRead, "restored-parent", true);
    OwnedHandle restoredChild = Open(child, DirectoryAccess, ShareRead, "restored-child", true);
    Require("relative-restore-after-prune", Rename(file, restoredChild, "payload.bin", "relative-restore"), null);
    Require("restore-kept-source-object", Identity(file) == identity, null);
    file.Close(); restoredChild.Close(); restoredParent.Close(); staging.Close();
    Require("restore-preserved-owned-payload-bytes", File.ReadAllText(original) == bytes && !File.Exists(Path.Combine(stage, "payload.bin")), null);
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

  private static void RunCase(string name, Action action)
  {
    CurrentCase = name;
    try { action(); }
    catch (Exception error) { Failed = true; Checks.Add(new { name = name + "-exception", status = "failed", detail = error.ToString() }); }
    finally { CurrentCase = null; }
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
      Require("owned-empty-fixture-root", Directory.Exists(root) && Directory.GetFileSystemEntries(root).Length == 0 &&
        (File.GetAttributes(root) & FileAttributes.ReparsePoint) == 0, null);
      RunCase("sharing", delegate { Sharing(root); });
      RunCase("roundtrip", delegate { Roundtrip(root); });
      RunCase("weak-lifetime", delegate { WeakLifetime(root, false); });
      RunCase("shared-reader-lifetime", delegate { WeakLifetime(root, true); });
    }
    catch (Exception error)
    {
      Failed = true;
      Checks.Add(new { name = "probe-exception", status = "failed", detail = error.ToString() });
    }
    finally { for (int i = Handles.Count - 1; i >= 0; i--) Handles[i].Close(); }
    var report = new {
      version = 1, status = Failed ? "failed" : "passed", processPointerBytes = IntPtr.Size,
      ownedFixtureRoot = root, executable = System.Reflection.Assembly.GetExecutingAssembly().Location,
      renameNameOffset = Marshal.OffsetOf(typeof(RenameInformation), "FileName").ToInt32(),
      renameInformationBytes = Marshal.SizeOf(typeof(RenameInformation)), fileInformationBytes = Marshal.SizeOf(typeof(FileInformation)),
      standardInformationBytes = Marshal.SizeOf(typeof(StandardInformation)),
      checks = Checks, observations = Observations,
      toolFileVersions = ToolVersions(args.Length == 3 ? args[2] : null),
      realAccountsCreated = 0, realProfilesCreated = 0, officialOldPeExecuted = false, productPeExecuted = false,
      fixtureKind = "owned-temp-native-api-only", crossProcessPinnedAck = "not_run", junctionRaces = "not_run",
      completeFailureRestore = "unknown", productRemoval = "not_run", f1 = "not_run"
    };
    File.WriteAllText(output, Json(report), new UTF8Encoding(false));
    return Failed ? 1 : 0;
  }
}
