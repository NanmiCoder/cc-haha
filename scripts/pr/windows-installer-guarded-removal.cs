using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

// Separate test entry point; never compiled into the shipped helper.
internal static class GuardedRemovalChecks
{
  private static int Count;
  private static string ParentObservation = "null";
  private static void Assert(bool value, string name) { if (!value) throw new Exception(name); Count++; }
  private static void Reject(Action action, string code)
  {
    try { action(); }
    catch (GuardedRemoval.Failure failure) { Assert(code == null || failure.Code == code, "wrong-rejection-" + failure.Code); return; }
    throw new Exception("expected-rejection");
  }
  private static string[] Arguments(string root, string caps, string parent)
  { return new string[] { "--cc-guarded-removal=1", "--root=" + root, "--capabilities=" + caps, "--parent=" + parent }; }
  private static GuardedRemoval.Registration Registered()
  {
    return new GuardedRemoval.Registration { Guid = GuardedRemoval.ProductGuid, Version = "0.7.8", Root = "C:\\Apps\\Claude Code Haha",
      Uninstall = "\"C:\\Apps\\Claude Code Haha\\Uninstall Claude Code Haha.exe\" /currentuser", MachineAbsent = true, User32Absent = true };
  }
  public static string Managed()
  {
    Count = 0;
    Assert(Marshal.SizeOf(typeof(GuardedRemoval.PublicObjectBasicInformation)) == 56, "public-basic-information-exact-fourteen-dwords");
    Assert(Marshal.OffsetOf(typeof(GuardedRemoval.PublicObjectBasicInformation), "GrantedAccess").ToInt32() == 4, "public-basic-information-access-offset");
    const string root = "C:\\Apps\\Claude Code Haha", caps = "4:7:1:0,8:7:2:0,12:7:3:0", parent = "16:123:4:5";
    GuardedRemoval.Invocation input = GuardedRemoval.Parse(Arguments(root, caps, parent));
    Assert(input.Paths.Length == 3 && input.Paths[0] == "C:\\" && input.Paths[2] == root && input.Parent[1] == 123, "complete-chain-and-parent");
    foreach (string bad in new string[] { "C:\\", "\\\\server\\share\\app", "C:/Apps/App", "C:\\Apps\\..\\App", "C:\\Apps\\App\\", "C:\\Apps\\--app",
      "C:\\Apps\\app.", "C:\\Apps\\app ", "C:\\Apps\\app:stream", "C:\\Apps\\CON", "C:\\Apps\\a\"b", "C:\\Apps\\a\nb" })
      Reject(delegate { GuardedRemoval.ChainPaths(bad); }, null);
    foreach (string bad in new string[] { "0:7:1:0,8:7:2:0,12:7:3:0", "4:7:1:0,4:7:2:0,12:7:3:0", "4:7:1:0,8:7:1:0,12:7:3:0",
      "4:7:1:0,8:8:2:0,12:7:3:0", "4:7:0:0,8:7:2:0,12:7:3:0", "04:7:1:0,8:7:2:0,12:7:3:0",
      "4294967295:7:1:0,8:7:2:0,12:7:3:0", "4:7:1:0,8:7:2:0", "4:7:1:0,8:7:2:0,12:7:3:0,20:7:4:0",
      "4:7:1:0,8:7:2:0,12:7:4294967296:0", "4:7:1:0,8:7:2:0,12:7:-1:0", "4:7:1:0,8:7:2:0,12:7:0x3:0" })
      Reject(delegate { GuardedRemoval.Parse(Arguments(root, bad, parent)); }, null);
    foreach (string bad in new string[] { "12:123:4:5", "0:123:4:5", "16:0:4:5", "16:123:0:0", "16:0123:4:5", "16:123:4" })
      Reject(delegate { GuardedRemoval.Parse(Arguments(root, caps, bad)); }, null);
    Reject(delegate { GuardedRemoval.Parse(new string[] { "--cc-guarded-removal=1", "--root=" + root, "--capabilities=" + caps }); }, "invalid-arguments");
    Reject(delegate { GuardedRemoval.Parse(new string[] { "--cc-guarded-removal=1", "--root=" + root, "--root=" + root, "--parent=" + parent }); }, "duplicate-root");
    Reject(delegate { GuardedRemoval.Parse(new string[] { "--cc-guarded-removal=2", "--root=" + root, "--capabilities=" + caps, "--parent=" + parent }); }, "unknown-argument");
    GuardedRemoval.ValidateRegistration(root, Registered()); Count++;
    foreach (int mismatch in new int[] { 0, 1, 2, 3, 4, 5 })
    {
      var registration = Registered();
      if (mismatch == 0) registration.Guid = "another-product";
      if (mismatch == 1) registration.Version = "0.7.9";
      if (mismatch == 2) registration.Root += "-sibling";
      if (mismatch == 3) registration.Uninstall += " /allusers";
      if (mismatch == 4) registration.MachineAbsent = false;
      if (mismatch == 5) { registration.User32Absent = false; registration.Root32 = root + "-other"; }
      Reject(delegate { GuardedRemoval.ValidateRegistration(root, registration); }, null);
    }
    Assert(GuardedRemoval.ValidUserSid("S-1-5-21-1-2-3-1001"), "normal-user-sid");
    foreach (string sid in new string[] { null, "S-1-5-18", "S-1-5-32-544", "S-1-5-21-1-2-3", "S-1-5-21-1-2-3-unknown" })
      Assert(!GuardedRemoval.ValidUserSid(sid), "foreign-or-unknown-sid");
    var original = new GuardedRemoval.Metadata { Volume = 7, Id = 123, Directory = true, Path = root };
    Assert(GuardedRemoval.SameObject(original, original, true, root), "bound-object");
    foreach (int mismatch in new int[] { 0, 1, 2, 3, 4, 5 })
    {
      var actual = new GuardedRemoval.Metadata { Volume = 7, Id = 123, Directory = true, Path = root };
      if (mismatch == 0) actual.Volume++;
      if (mismatch == 1) actual.Id++;
      if (mismatch == 2) actual.Path += "-drift";
      if (mismatch == 3) actual.Reparse = true;
      if (mismatch == 4) actual.Pending = true;
      if (mismatch == 5) actual.Directory = false;
      Assert(!GuardedRemoval.SameObject(actual, original, true, root), "reject-identity-drift");
    }
    var old = new GuardedRemoval.FileNode { Leaf = GuardedRemoval.OldName, Original = new GuardedRemoval.Metadata { Bytes = GuardedRemoval.OldBytes }, Hash = "wrong" };
    Reject(delegate { GuardedRemoval.Tree.FixedOld(old); }, "official-old-uninstaller-fingerprint");
    old.Hash = GuardedRemoval.OldHash; old.Original.Bytes++;
    Reject(delegate { GuardedRemoval.Tree.FixedOld(old); }, "official-old-uninstaller-fingerprint");
    Assert(!GuardedRemoval.Inside(root, root + "-sibling\\rg.exe") && GuardedRemoval.Inside(root, root + "\\rg.exe"), "directory-boundary");
    Assert(GuardedRemoval.RelatedImage("RG.EXE") && !GuardedRemoval.RelatedImage("foorg.exe"), "exact-image-name");
    GuardedRemoval.RequireSeparateData(root, "C:\\Users\\normal\\.claude"); Count++;
    Reject(delegate { GuardedRemoval.RequireSeparateData("C:\\Users\\normal", "C:\\Users\\normal\\.claude"); }, null);
    Reject(delegate { GuardedRemoval.RequireSeparateData("C:\\Users\\normal\\.claude\\child", "C:\\Users\\normal\\.claude"); }, null);
    Assert(GuardedRemoval.MissingDataLeaf(new GuardedRemoval.Failure("nt-relative-protected-data", unchecked((int)0xc0000034))), "exact-relative-missing-data");
    foreach (int error in new int[] { unchecked((int)0xc0000022), unchecked((int)0xc000003a), unchecked((int)0xc0000280), 2, 3, 5, 0x103 })
      Assert(!GuardedRemoval.MissingDataLeaf(new GuardedRemoval.Failure("nt-relative-protected-data", error)), "unknown-data-is-not-absent");
    Assert(!GuardedRemoval.MissingDataLeaf(new GuardedRemoval.Failure("another-api", unchecked((int)0xc0000034))), "missing-status-source-bound");
    byte[] mode = Encoding.UTF8.GetBytes(GuardedRemoval.DefaultMode);
    GuardedRemoval.RequireDefaultMode(mode, mode.Length); Count++;
    foreach (string badMode in new string[] { GuardedRemoval.DefaultMode.Replace("default", "portable"), GuardedRemoval.DefaultMode + "\nextra",
      GuardedRemoval.DefaultMode.Replace("null", "\"C:\\\\portable\""), GuardedRemoval.DefaultMode.Replace("\n", "\r\n") })
    {
      byte[] invalid = Encoding.UTF8.GetBytes(badMode);
      Reject(delegate { GuardedRemoval.RequireDefaultMode(invalid, invalid.Length); }, "non-default-or-unknown-app-mode");
    }
    foreach (bool create in new bool[] { false, true })
    {
      Assert(GuardedRemoval.RelativeSucceeded(create, 0, 0, true, create ? 2ul : 1ul, new IntPtr(4)), "relative-info-success");
      Assert(!GuardedRemoval.RelativeSucceeded(create, 0, 0, true, create ? 1ul : 2ul, new IntPtr(4)), "open-create-info-not-interchangeable");
      Assert(!GuardedRemoval.RelativeSucceeded(create, 0x103, 0, false, create ? 2ul : 1ul, new IntPtr(4)), "pending-is-not-success");
      Assert(!GuardedRemoval.RelativeSucceeded(create, 0, 0x103, true, create ? 2ul : 1ul, new IntPtr(4)), "pending-iosb-is-not-success");
      Assert(!GuardedRemoval.RelativeSucceeded(create, 0, 0, true, create ? 2ul : 1ul, IntPtr.Zero), "missing-relative-handle");
    }
    var namedParent = new GuardedRemoval.Metadata { Volume = 7, Id = 77, Directory = true, Path = "C:\\Apps" };
    var namedExpected = new GuardedRemoval.Metadata { Volume = 7, Id = 123, Directory = true, Path = root };
    Assert(GuardedRemoval.NamedPruneReason(namedExpected, namedExpected, namedExpected, namedParent, "Claude Code Haha") == "matched", "named-positive-object");
    foreach (int mismatch in new int[] { 0, 1, 2, 3, 4, 5 })
    {
      var candidate = new GuardedRemoval.Metadata { Volume = 7, Id = 123, Directory = true, Path = root };
      if (mismatch == 0) candidate.Id++;
      if (mismatch == 1) candidate.Volume++;
      if (mismatch == 2) candidate.Path += "-changed";
      if (mismatch == 3) candidate.Reparse = true;
      if (mismatch == 4) candidate.Pending = true;
      if (mismatch == 5) candidate.Directory = false;
      Assert(GuardedRemoval.NamedPruneReason(candidate, namedExpected, namedExpected, namedParent, "Claude Code Haha") != "matched", "named-negative-object");
    }
    Assert(GuardedRemoval.NamedPruneReason(namedExpected, namedExpected, namedExpected, namedParent, "replacement") == "parent-or-request-mismatch", "named-exact-leaf-only");
    var movedWeak = new GuardedRemoval.Metadata { Volume = 7, Id = 123, Directory = true, Path = root + "-moved" };
    Assert(GuardedRemoval.NamedPruneReason(null, movedWeak, namedExpected, namedParent, "Claude Code Haha") == "canonical-drift", "named-renamed-away-rejected");
    movedWeak.Path = root; movedWeak.Id++;
    Assert(GuardedRemoval.NamedPruneReason(namedExpected, movedWeak, namedExpected, namedParent, "Claude Code Haha") == "weak-identity-mismatch", "named-retained-weak-id-required");
    return "managed-pass:" + Count.ToString(CultureInfo.InvariantCulture);
  }

  private static string Dword(uint value) { return value.ToString(CultureInfo.InvariantCulture); }
  private static string Number(IntPtr value) { return Dword(unchecked((uint)value.ToInt32())); }
  private static string ObserveParent(IntPtr parent, uint expectedPid)
  {
    uint flags;
    bool flagsRead = GuardedRemoval.Native.GetHandleInformation(parent, out flags);
    int flagsError = Marshal.GetLastWin32Error();
    uint actualPid = GuardedRemoval.Native.GetProcessId(parent), ownPid = GuardedRemoval.Native.GetCurrentProcessId();
    uint wait = GuardedRemoval.Native.WaitForSingleObject(parent, 0);
    var queries = new List<string>();
    // Diagnostic comparisons only. Neither result replaces or bypasses the
    // production ReceiveParent check; failed queries never grant admission.
    foreach (uint length in new uint[] { 64, 56 })
    {
      IntPtr buffer = Marshal.AllocHGlobal((int)length);
      try
      {
        for (int i = 0; i < length; i++) Marshal.WriteByte(buffer, i, 0);
        uint returned;
        int status = GuardedRemoval.Native.NtQueryObject(parent, 0, buffer, length, out returned);
        string granted = status >= 0 && returned >= 8 && returned <= length ?
          Quote(unchecked((uint)Marshal.ReadInt32(buffer, 4)).ToString("x8", CultureInfo.InvariantCulture)) : "null";
        queries.Add("{\"queryBytes\":" + Dword(length) + ",\"ntStatus\":" + Quote(unchecked((uint)status).ToString("x8", CultureInfo.InvariantCulture)) +
          ",\"returnedBytes\":" + Dword(returned) + ",\"grantedMask\":" + granted + "}");
      }
      finally { Marshal.FreeHGlobal(buffer); }
    }
    return "{\"requestedMask\":\"00101000\",\"source\":\"OpenProcess\",\"expectedPid\":" + Dword(expectedPid) +
      ",\"actualPid\":" + Dword(actualPid) + ",\"ownPid\":" + Dword(ownPid) +
      ",\"matchesRequestedNonSelf\":" + (actualPid == expectedPid && actualPid != ownPid && actualPid != 0 ? "true" : "false") +
      ",\"flagsRead\":" + (flagsRead ? "true" : "false") + ",\"flags\":" + Dword(flags) +
      ",\"flagsError\":" + (flagsRead ? "null" : flagsError.ToString(CultureInfo.InvariantCulture)) + ",\"wait0\":" + Dword(wait) +
      ",\"queries\":[" + String.Join(",", queries.ToArray()) + "]}";
  }
  private static void Receive(GuardedRemoval.Context context, string root, uint parentPid, bool wrongId, List<IntPtr> created)
  {
    var tuples = new List<string>();
    try
    {
    foreach (string path in GuardedRemoval.ChainPaths(root))
    {
      IntPtr raw = GuardedRemoval.Native.CreateFileW(path, 0x80, 7, IntPtr.Zero, 3, GuardedRemoval.NoFollow, IntPtr.Zero);
      GuardedRemoval.Need(raw != new IntPtr(-1) && raw != IntPtr.Zero, "fixture-open-capability");
      created.Add(raw);
      GuardedRemoval.Metadata metadata = context.ReadRaw(raw);
      GuardedRemoval.Need(GuardedRemoval.Native.SetHandleInformation(raw, 1, 1), "fixture-mark-capability");
      ulong id = metadata.Id;
      if (wrongId && path == root) id = unchecked(id + 1);
      tuples.Add(Number(raw) + ":" + Dword(metadata.Volume) + ":" + Dword(unchecked((uint)id)) + ":" + Dword((uint)(id >> 32)));
    }
    IntPtr parent = GuardedRemoval.Native.OpenProcess(0x101000, true, parentPid);
    GuardedRemoval.Need(parent != IntPtr.Zero, "fixture-open-parent"); created.Add(parent);
    GuardedRemoval.Time creation, exit, kernel, user;
    GuardedRemoval.Need(GuardedRemoval.Native.GetProcessTimes(parent, out creation, out exit, out kernel, out user), "fixture-parent-times");
    ParentObservation = ObserveParent(parent, parentPid);
    string tuple = Number(parent) + ":" + Dword(parentPid) + ":" + Dword(creation.Low) + ":" + Dword(creation.High);
    var invocation = GuardedRemoval.Parse(Arguments(root, String.Join(",", tuples.ToArray()), tuple));
      context.Receive(invocation);
      context.ReceiveParent(invocation.Parent, WindowsIdentity.GetCurrent().User.Value, root);
    }
    catch
    {
      context.CloseAll();
      // Only handles created by this test, never values taken from an argument.
      foreach (IntPtr raw in created)
      {
        bool owned = false;
        foreach (GuardedRemoval.Handle handle in context.Handles) if (handle.OriginalValue == raw) owned = true;
        if (!owned && !GuardedRemoval.Native.CloseHandle(raw)) context.Unknown = true;
      }
      created.Clear(); throw;
    }
  }
  private static string Quote(string value) { return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool DeviceIoControl(IntPtr handle, uint control, byte[] input, uint bytes, IntPtr output, uint outputBytes, out uint returned, IntPtr overlapped);
  private static void CreateOwnedJunction(GuardedRemoval.Context context, string path, string target)
  {
    Directory.CreateDirectory(path);
    GuardedRemoval.Handle writer = context.OpenPath(path, 0x180, 7, "owned-data-junction-writer");
    GuardedRemoval.Metadata before = context.Read(writer);
    Assert(before.Directory && !before.Reparse && before.Path == path && Directory.GetFileSystemEntries(path).Length == 0, "owned-empty-data-junction");
    byte[] substitute = Encoding.Unicode.GetBytes("\\??\\" + target), print = Encoding.Unicode.GetBytes(target);
    byte[] buffer = new byte[16 + substitute.Length + 2 + print.Length + 2];
    Array.Copy(BitConverter.GetBytes(0xa0000003u), 0, buffer, 0, 4);
    Array.Copy(BitConverter.GetBytes((ushort)(buffer.Length - 8)), 0, buffer, 4, 2);
    Array.Copy(BitConverter.GetBytes((ushort)substitute.Length), 0, buffer, 10, 2);
    Array.Copy(BitConverter.GetBytes((ushort)(substitute.Length + 2)), 0, buffer, 12, 2);
    Array.Copy(BitConverter.GetBytes((ushort)print.Length), 0, buffer, 14, 2);
    Array.Copy(substitute, 0, buffer, 16, substitute.Length); Array.Copy(print, 0, buffer, 18 + substitute.Length, print.Length);
    uint returned;
    bool set = DeviceIoControl(writer.Value, 0x900a4, buffer, (uint)buffer.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero);
    int error = Marshal.GetLastWin32Error();
    GuardedRemoval.Win(set, "fixture-set-data-junction", error);
    GuardedRemoval.Metadata after = context.Read(writer);
    Assert(after.Id == before.Id && after.Volume == before.Volume && after.Reparse, "owned-junction-actually-set");
  }
  private static bool DataNamespaceCase(GuardedRemoval.Context context, string root, string mode, out GuardedRemoval.Failure rejectedBy)
  {
    string arena = Path.GetDirectoryName(root);
    string profile = Path.Combine(arena, mode == "data-config-ancestor" ? "profile-parent\\profile" : "profile");
    string roaming = Path.Combine(arena, mode == "data-product-ancestor" ? "roaming-parent\\roaming" : "roaming");
    string[] known = new string[] { profile, roaming };
    bool rejectionExpected = mode != "data-plain" && mode != "data-missing";
    rejectedBy = null;
    try
    {
      // The seam exists only inside this separately compiled test entry point;
      // production Main always calls its fixed real KnownFolder provider.
      context.DataGuard = new GuardedRemoval.ProtectedDataGuard(context, root, delegate { return known; });
      context.RevalidateData();
    }
    catch (GuardedRemoval.Failure failure) { rejectedBy = failure; }
    if (mode == "data-missing-then-plain" || mode == "data-missing-then-junction")
    {
      Assert(rejectedBy == null, "actual-missing-positive-before-injection");
      if (mode == "data-missing-then-plain") Directory.CreateDirectory(Path.Combine(profile, ".claude"));
      else CreateOwnedJunction(context, Path.Combine(profile, ".claude"), root);
      try { context.RevalidateData(); }
      catch (GuardedRemoval.Failure failure) { rejectedBy = failure; }
    }
    bool rejected = rejectedBy != null;
    Assert(rejected == rejectionExpected && !context.Unknown && !context.PendingIo, "protected-data-rejection-or-positive-control");
    if (rejected) Assert(rejectedBy.Code == "protected-data-component-alias-or-unknown" || rejectedBy.Code == "protected-data-missing-leaf-appeared" ||
      (rejectedBy.Code == "nt-relative-protected-data" && (rejectedBy.NativeError == unchecked((int)0xc0000280) || rejectedBy.NativeError == unchecked((int)0xc000050b))),
      "data-rejection-must-be-alias-or-real-reparse-refusal");
    foreach (GuardedRemoval.Handle handle in context.Handles)
      Assert(handle.Role != "owned-sentinel" && handle.Role != "source-file" && handle.Role != "prune-named-delete-pin", "data-gate-before-tree-mutation");
    return rejected;
  }
  private static int Main(string[] args)
  {
    if (args.Length == 1 && args[0] == "managed") { Console.WriteLine(Managed()); return 0; }
    if (args.Length == 1 && args[0] == "fixture-lifetime") { System.Threading.Thread.Sleep(9000); return 0; }
    if (args.Length != 4) return 2;
    string mode = args[0], root = Path.GetFullPath(args[1]), report = Path.GetFullPath(args[3]);
    uint parentPid = UInt32.Parse(args[2], CultureInfo.InvariantCulture);
    GuardedRemoval.Context context = null; GuardedRemoval.Tree tree = null;
    var created = new List<IntPtr>(); IntPtr busy = IntPtr.Zero;
    bool passed = false, rejected = false, restored = false, rawClosed = false, fileIdsPreserved = false, bytesPreserved = false;
    int nativeError = 0, namedPrunePins = 0;
    string errorCode = null, operation = "not-started";
    try
    {
      Assert(Environment.OSVersion.Platform == PlatformID.Win32NT && IntPtr.Size == 4, "fixture-windows-x86");
      Assert(Directory.Exists(root) && Directory.GetFileSystemEntries(root).Length == 0 && (File.GetAttributes(root) & FileAttributes.ReparsePoint) == 0, "fresh-owned-root");
      Directory.CreateDirectory(Path.Combine(root, "nested"));
      File.WriteAllText(Path.Combine(root, "a.bin"), "owned first payload");
      File.WriteAllText(Path.Combine(root, "nested", "b.bin"), "owned nested payload");
      if (mode.StartsWith("data-", StringComparison.Ordinal))
      {
        context = new GuardedRemoval.Context();
        GuardedRemoval.Failure dataFailure;
        rejected = DataNamespaceCase(context, root, mode, out dataFailure);
        if (dataFailure != null) { errorCode = dataFailure.Code; nativeError = dataFailure.NativeError; }
        operation = rejected ? "rejected-before-mutation" : "protected-data-control";
        bytesPreserved = true;
      }
      else if (mode == "wrong-cap")
      {
        context = new GuardedRemoval.Context();
        Reject(delegate { Receive(context, root, parentPid, true, created); }, "capability-identity-mismatch");
        rejected = true; operation = "rejected-before-tree";
      }
      else
      {
        context = new GuardedRemoval.Context();
        Receive(context, root, parentPid, false, created);
        if (mode == "busy")
        {
          busy = GuardedRemoval.Native.CreateFileW(Path.Combine(root, "a.bin"), 0x40000000, 7, IntPtr.Zero, 3, GuardedRemoval.NoFollow, IntPtr.Zero);
          Assert(busy != IntPtr.Zero && busy != new IntPtr(-1), "busy-writer-actually-opened");
        }
        tree = new GuardedRemoval.Tree(context);
        try
        {
          tree.Admit(null);
          tree.PrepareStage(Path.GetDirectoryName(typeof(GuardedRemovalChecks).Assembly.Location));
          Action barrier = mode == "namespace-change" ? (Action)delegate { File.WriteAllText(Path.Combine(root, "unexpected.bin"), "new owned entry"); } : null;
          Action commit = mode == "rollback" ? (Action)delegate { throw new GuardedRemoval.Failure("fixture-before-commit", 0); } :
            mode == "parent-dead" ? (Action)delegate { Assert(GuardedRemoval.Native.WaitForSingleObject(context.Parent.Value, 0xffffffff) == 0, "owned-monitored-process-really-exited"); } : null;
          tree.Remove(barrier, commit);
          operation = "removed";
          Assert(mode == "success" && !Directory.Exists(root) && !Directory.Exists(context.StagingPath), "complete-owned-removal");
        }
        catch (GuardedRemoval.Failure failure)
        {
          rejected = true; errorCode = failure.Code;
          nativeError = failure.NativeError;
          Assert(mode != "success", "success-case-cannot-use-failure-as-proof");
          if (!tree.MutationStarted && !context.Unknown) tree.CleanPreparation();
          restored = tree.Restored;
          operation = restored ? "restored-after-failure" : "rejected-before-mutation";
          Assert(!context.Unknown && Directory.Exists(root), "owned-rejection-known-root-retained");
          if (mode == "rollback") Assert(restored && failure.Code == "fixture-before-commit" && !Directory.Exists(context.StagingPath), "full-handle-rollback");
          if (mode == "parent-dead") Assert(restored && context.ParentDead && failure.Code == "parent-exited" && !Directory.Exists(context.StagingPath), "parent-death-handle-rollback");
          if (mode == "busy") Assert(!tree.MutationStarted && failure.Code == "nt-relative-source-file", "busy-failure-before-mutation");
          if (mode == "namespace-change") Assert(!tree.MutationStarted && File.Exists(Path.Combine(root, "unexpected.bin")), "unknown-entry-never-deleted");
        }
      }
      if (mode != "success")
      {
        Assert((rejected || mode == "data-plain" || mode == "data-missing") && File.ReadAllText(Path.Combine(root, "a.bin")) == "owned first payload" &&
          File.ReadAllText(Path.Combine(root, "nested", "b.bin")) == "owned nested payload", "owned-rejection-preserves-original-bytes");
        bytesPreserved = true;
        if (tree != null) foreach (GuardedRemoval.FileNode file in tree.Files)
          Assert(context.Read(file.Pin).Id == file.Original.Id && context.Hash(file.Pin) == file.Hash, "original-file-id-and-hash-retained");
        fileIdsPreserved = tree != null && tree.Files.Count == 2;
      }
      if (context != null) foreach (GuardedRemoval.Handle handle in context.Handles)
        if (handle.Role == "prune-named-delete-pin") namedPrunePins++;
      if (mode == "success" || mode == "rollback" || mode == "parent-dead") Assert(namedPrunePins > 0, "actual-named-prune-protocol-used");
      passed = true;
    }
    catch (Exception error) { errorCode = error is GuardedRemoval.Failure ? ((GuardedRemoval.Failure)error).Code : error.GetType().Name;
      if (error is GuardedRemoval.Failure) nativeError = ((GuardedRemoval.Failure)error).NativeError; }
    finally
    {
      if (context != null) context.CloseAll();
      bool busyClosed = busy == IntPtr.Zero || busy == new IntPtr(-1) || GuardedRemoval.Native.CloseHandle(busy);
      rawClosed = busyClosed && (context == null || (!context.Unknown && !context.PendingIo));
      if (!rawClosed) passed = false;
      File.WriteAllText(report, "{\"fixtureStatus\":" + Quote(passed ? "passed" : "failed") + ",\"operationOutcome\":" + Quote(operation) +
        ",\"mode\":" + Quote(mode) + ",\"errorCode\":" + (errorCode == null ? "null" : Quote(errorCode)) +
        ",\"restored\":" + (restored ? "true" : "false") + ",\"safeForOwnedCleanup\":" + (rawClosed ? "true" : "false") +
        ",\"originalFileIdsAndBytesPreserved\":" + (fileIdsPreserved ? "true" : "false") +
        ",\"originalBytesPreserved\":" + (bytesPreserved ? "true" : "false") + ",\"nativeError\":" + nativeError.ToString(CultureInfo.InvariantCulture) +
        ",\"namedPrunePins\":" + namedPrunePins.ToString(CultureInfo.InvariantCulture) +
        ",\"phase\":" + Quote(context == null ? "receive" : context.Phase) +
        ",\"parentCapabilityObservation\":" + ParentObservation +
        ",\"treeMutationStarted\":" + (tree != null && tree.MutationStarted ? "true" : "false") +
        ",\"protectedNamespaceMetadataCase\":" + (mode.StartsWith("data-", StringComparison.Ordinal) ? "true" : "false") +
        ",\"capabilityBoundary\":\"same-process fixture handles; NSIS cross-process handoff tested separately\",\"realAccountsCreated\":0,\"realProfilesCreated\":0,\"productPeExecuted\":false}", new UTF8Encoding(false));
    }
    return passed ? 0 : 1;
  }
}

// Only used by a separately compiled, native-stubbed copy of the production
// source. The shipped helper never includes this class or an injection hook.
internal static class GuardedRemovalIoStubs
{
  private static int Mode, Frees, Closes;
  private static int ParentMode;
  private static uint LastParentQueryBytes;
  private static IntPtr Io;
  private static readonly List<IntPtr> Allocations = new List<IntPtr>();
  public static IntPtr Allocate(int bytes) { IntPtr value = Marshal.AllocHGlobal(bytes); Allocations.Add(value); return value; }
  public static void Free(IntPtr value) { if (!Allocations.Remove(value)) throw new Exception("untracked-free"); Frees++; Marshal.FreeHGlobal(value); }
  public static bool Close(IntPtr value) { Closes++; return true; }
  public static int QueryParent(IntPtr handle, int kind, IntPtr buffer, uint bytes, out uint returned)
  {
    if (handle != new IntPtr(4) || kind != 0) throw new Exception("parent-query-stub-boundary");
    LastParentQueryBytes = bytes;
    returned = 0;
    if (bytes != 56) return unchecked((int)0xc0000004);
    returned = ParentMode == 3 ? 55u : ParentMode == 4 ? 64u : ParentMode == 5 ? 0u : 56u;
    Marshal.WriteInt32(buffer, 4, ParentMode == 1 ? 0x101010 : 0x101000);
    return ParentMode == 2 ? unchecked((int)0xc0000004) : ParentMode == 6 ? 1 : 0;
  }
  private static int Call(IntPtr io)
  {
    Io = io;
    if (Mode == 0) Marshal.WriteInt32(io, 0x103);
    if (Mode == 6) { Marshal.WriteInt32(io, 0); Marshal.WriteIntPtr(io, IntPtr.Size, new IntPtr(1)); return 0; }
    return Mode == 3 ? unchecked((int)0xc0000022) : 0x103;
  }
  public static int Create(out IntPtr handle, uint access, IntPtr attributes, IntPtr io, IntPtr allocation, uint fileAttributes,
    uint share, uint disposition, uint options, IntPtr ea, uint eaBytes)
  { handle = new IntPtr(16); return Call(io); }
  public static int Rename(IntPtr handle, IntPtr io, IntPtr information, uint bytes, int kind) { return Call(io); }
  public static uint Wait(IntPtr handle, uint milliseconds)
  {
    if (Mode == 2 || Mode == 4 || Mode == 5)
    {
      Marshal.WriteInt32(Io, Mode == 2 ? unchecked((int)0xc0000022) : 0);
      Marshal.WriteIntPtr(Io, IntPtr.Size, new IntPtr(1));
    }
    return Mode == 5 ? 0xffffffffu : 0u;
  }
  private static void Assert(bool condition, string code) { if (!condition) throw new Exception("pending-control-" + code); }
  public static string Run()
  {
    int cases = 0;
    foreach (bool relative in new bool[] { true, false }) for (Mode = 0; Mode < 7; Mode++)
    {
      Frees = Closes = 0;
      var context = new GuardedRemoval.Context();
      var parent = context.Own(new IntPtr(4), "stub-parent");
      var file = context.Own(new IntPtr(8), "stub-file");
      GuardedRemoval.Failure failure = null;
      try
      {
        if (relative) context.Relative(parent, "child", true, false, 0x1100a1, 1, "stub");
        else context.Rename(file, parent, "child");
      }
      catch (GuardedRemoval.Failure error) { failure = error; }
      bool unresolved = Mode < 2 || Mode == 5;
      Assert(context.PendingIo == unresolved && context.Unknown == unresolved, "flags");
      Assert((failure == null) == (Mode == 4 || Mode == 6), "result");
      if (Mode == 2 || Mode == 3) Assert(failure.NativeError == unchecked((int)0xc0000022), "authoritative-terminal-error");
      if (unresolved)
      {
        Assert(Frees == 0 && Allocations.Count == (relative ? 4 : 2), "buffers-retained");
        var tree = (GuardedRemoval.Tree)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(typeof(GuardedRemoval.Tree));
        typeof(GuardedRemoval.Tree).GetField("Context", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic).SetValue(tree, context);
        try { tree.Restore(); throw new Exception("restore-accepted"); }
        catch (GuardedRemoval.Failure error) { Assert(error.Code == "restore-state-unknown", "restore-refused-before-io"); }
        try { file.Close(); throw new Exception("close-accepted"); }
        catch (GuardedRemoval.Failure error) { Assert(error.Code == "close-with-pending-io", "explicit-close-refused"); }
      }
      else Assert(Frees == (relative ? 4 : 2) && Allocations.Count == 0, "terminal-buffers-freed");
      context.CloseAll();
      Assert(Closes == (unresolved ? 0 : relative ? 3 : 2), "close-all");
      // These are managed-stub allocations: no OS request ever owned them.
      foreach (IntPtr retained in Allocations) Marshal.FreeHGlobal(retained);
      Allocations.Clear(); cases++;
    }
    return "pending-control-pass:" + cases.ToString(CultureInfo.InvariantCulture);
  }
  public static string RunParent()
  {
    IntPtr legacy = Allocate(64);
    try
    {
      uint returned;
      Assert(QueryParent(new IntPtr(4), 0, legacy, 64, out returned) == unchecked((int)0xc0000004) && returned == 0, "actual-legacy-size-control");
    }
    finally { Free(legacy); }
    int cases = 0;
    for (ParentMode = 0; ParentMode < 7; ParentMode++)
    {
      Frees = Closes = 0;
      var context = new GuardedRemoval.Context();
      GuardedRemoval.Failure rejected = null;
      try { context.RequireReadonlyParentCapability(new IntPtr(4)); }
      catch (GuardedRemoval.Failure error) { rejected = error; }
      Assert((rejected == null) == (ParentMode == 0), "exact-parent-status-size-and-mask");
      if (rejected != null) Assert(rejected.Code == "parent-not-readonly-process-capability", "parent-rejection-reason");
      Assert(LastParentQueryBytes == 56 && Frees == 1 && Allocations.Count == 0 && Closes == 0, "parent-query-no-fallback-and-lifetime");
      Assert(!context.Unknown && !context.PendingIo, "terminal-parent-query-not-queued");
      cases++;
    }
    return "parent-query-control-pass:" + cases.ToString(CultureInfo.InvariantCulture);
  }
  private static int Main(string[] args)
  {
    if (args.Length == 0) Console.WriteLine(Run());
    else if (args.Length == 1 && args[0] == "parent-capability") Console.WriteLine(RunParent());
    else return 2;
    return 0;
  }
}
