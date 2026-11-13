// Stage A regressions: this file never constructs NativePlatform or calls an
// account, registry, profile, privilege or released-product Windows API.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;

namespace CcHahaInstallerProfile
{
  internal static class FixtureTests
  {
    internal const string RunnerSid = "S-1-5-21-900-901-902-1000";
    internal const string TargetSid = "S-1-5-21-100-101-102-1001";

    private static void Assert(bool condition, string message)
    {
      if (!condition) throw new Exception(message);
    }

    private static void Reject(Action action, string message)
    {
      bool rejected = false;
      try { action(); }
      catch (FixtureFailure) { rejected = true; }
      Assert(rejected, message);
    }

    private static void Case(FixtureReport report, string name, Action action)
    {
      try
      {
        action();
        report.Check(name, true, "Deterministic FakeAPI regression; no native account/profile/product operation.");
      }
      catch (Exception error)
      {
        report.Check(name, false, error.GetType().Name + ":" + error.Message);
      }
    }

    internal static FixtureSpec Spec()
    {
      return new FixtureSpec {
        version = 1, mode = "historical-v078-controller", executionStage = "B", realExecutionAdmitted = true,
        runId = "52f4ce19-5ded-4b27-8268-a2840809e0ca",
        owner = "codex:local:01a1c9a5-381e-7b33-9648-c8968b61de4c", generation = 1,
        gitRoot = @"D:\source\cc-haha", sourceRoot = @"C:\FixtureInputs\sources",
        controllerRoot = @"C:\FixtureController\new-root", output = @"C:\FixtureController\new-root\result.json",
        setupPath = @"C:\FixtureInputs\locked-setup.exe",
        expectedBinarySha256 = CorePolicy.HashFile(CorePolicy.BinaryPath),
        frozenPlanManifestSha256 = CorePolicy.PlanHash, argvEnvPlanSha256 = CorePolicy.EnvironmentPlanHash,
        sourcePins = CorePolicy.SourceNames.Select(name => new SourcePin { file = name, sha256 = new String('a', 64) }).ToList()
      };
    }

    internal static TokenIdentity Standard()
    {
      return new TokenIdentity {
        sid = TargetSid, tokenType = 1, integrityRid = 0x2000, elevated = false, elevationType = 1,
        sessionId = 4, authenticationId = "fixture-logon-id",
        groups = new List<string> { "S-1-5-32-545|7", "S-1-5-11|7" },
        privileges = new List<string> { "SeChangeNotifyPrivilege|3", "SeShutdownPrivilege|0" }
      };
    }

    internal static KnownPaths Paths()
    {
      string root = @"C:\Users\fixture-owned";
      return new KnownPaths { profile = root, roaming = root + @"\AppData\Roaming", local = root + @"\AppData\Local",
        desktop = root + @"\Desktop", programs = root + @"\AppData\Roaming\Microsoft\Windows\Start Menu\Programs",
        startMenu = root + @"\AppData\Roaming\Microsoft\Windows\Start Menu", userPrograms = root + @"\AppData\Local\Programs" };
    }

    private static FixtureState Execute(FakePlatform api, FixtureSpec spec)
    {
      FixtureReport report = new FixtureReport { mode = "fake-controller", specSha256 = new String('b', 64) };
      FixtureState state = Controller.NewState(spec, report);
      Controller.Run(state, api);
      return state;
    }

    private static FixtureSpec ProfileOnlySpec()
    {
      FixtureSpec spec = Spec();
      spec.mode = "createprofile-only-controller"; spec.executionStage = "profile-only";
      spec.frozenPlanManifestSha256 = CorePolicy.ProfileOnlyPlanHash;
      spec.argvEnvPlanSha256 = CorePolicy.ProfileOnlyEnvironmentPlanHash;
      spec.setupPath = null;
      return spec;
    }

    private static void AssertNoNativePromotion(FixtureState state)
    {
      Assert(!state.report.compatibilityEnabled && state.report.oldExit22Policy == "fatal", "compatibility must remain disabled");
      Assert(state.report.realAccountsCreated == 0 && state.report.realProfilesCreated == 0 && !state.report.releasedPeExecuted, "FakeAPI must not claim native execution");
      Assert(!state.report.releasedPeMayHaveExecuted && state.report.releasedPeExecutionStatus == "not_run", "FakeAPI must not imply possible product execution");
      Assert(state.report.member_proven == "not_run" && state.report.installed_bytes_equal == "not_run"
        && state.report.old22_before_protected_mutation == "not_run" && state.report.removal_equivalence == "not_run"
        && state.report.full_old_to_new == "not_run", "five evidence fields must remain not_run");
    }

    private static NativePlatform.ProfileDirectoryMetadata ProfileMetadata(string owner)
    {
      return new NativePlatform.ProfileDirectoryMetadata {
        identity = new FileIdentity { canonicalPath = Paths().profile, directory = true, fileId = "profile-file", volumePath = @"\\?\Volume{fixture}\" },
        ownerSid = owner, daclPresent = true, protectedDacl = true, aclRevision = 2, descriptorSha256 = new String('a', 64),
        aces = new List<NativePlatform.ProfileDiagnosticAce> {
          new NativePlatform.ProfileDiagnosticAce { sid = TargetSid, accessMask = 0x1f01ff, allow = true },
          new NativePlatform.ProfileDiagnosticAce { sid = "S-1-5-18", accessMask = 0x1f01ff, allow = true },
          new NativePlatform.ProfileDiagnosticAce { sid = "S-1-5-32-544", accessMask = 0x1f01ff, allow = true }
        }
      };
    }

    private static void RunProfileLeasePolicyTests(FixtureReport report)
    {
      Case(report, "managed-readonly-profile-parent-chain-includes-only-its-exact-volume-root", delegate {
        string[][] chains = {
          new string[] { @"C:\Users", @"C:\" },
          new string[] { @"D:\Data\Profiles\nested", @"D:\Data\Profiles", @"D:\Data", @"D:\" }
        };
        foreach (string[] expected in chains)
        {
          string profiles = expected.Length == 2 ? expected[0] : expected[1];
          string[] actual = CorePolicy.ProfileParentPaths(profiles, expected[0]);
          Assert(actual.SequenceEqual(expected), "real managed enumeration must reach the exact volume root");
          foreach (string path in actual) CorePolicy.ValidateProfileAncestorPath(path, profiles, expected[0]);
          Reject(delegate { CorePolicy.ValidateAbsolutePath(actual.Last()); }, "volume root remains forbidden for owned or destructive operations");
          foreach (string path in new string[] { @"E:\", @"C:", @"\\host\share", profiles + @"\not-on-chain", profiles + @"\.." })
            Reject(delegate { CorePolicy.ValidateProfileAncestorPath(path, profiles, expected[0]); }, "read-only pin must not escape the exact chain");
        }
        Reject(delegate { CorePolicy.ProfileParentPaths(@"C:\Users", @"C:\elsewhere"); }, "unrelated directory cannot select a root");
        Reject(delegate { CorePolicy.ProfileParentPaths(@"C:\", @"C:\Users"); }, "volume root cannot become ProfilesDirectory");
        Reject(delegate { CorePolicy.ProfileParentPaths(@"C:\Users", @"C:\Users" + String.Concat(Enumerable.Repeat(@"\x", 33))); }, "parent chain remains bounded");
      });
      Case(report, "fake-admin-owner-requires-original-successful-creation-context", delegate {
        NativePlatform.ProfileDirectoryMetadata metadata = ProfileMetadata("S-1-5-32-544");
        NativePlatform.RequireFreshProfileOwner(metadata.ownerSid, TargetSid, "S-1-5-32-544", true, metadata);
        foreach (string before in new string[] { null, TargetSid, RunnerSid, "S-1-5-18" })
          Reject(delegate { NativePlatform.RequireFreshProfileOwner(metadata.ownerSid, TargetSid, before, true, metadata); }, "only original Admin TokenOwner admits Admin owner");
        Reject(delegate { NativePlatform.RequireFreshProfileOwner(metadata.ownerSid, TargetSid, "S-1-5-32-544", false, metadata); }, "failed or unobserved creation is not a lease");
        foreach (string owner in new string[] { null, RunnerSid, "S-1-5-21-7-8-9-1001" })
        {
          metadata.ownerSid = owner;
          Reject(delegate { NativePlatform.RequireFreshProfileOwner(owner, TargetSid, owner, true, metadata); }, "other owner cannot become trusted by equaling a token/runner");
        }
        foreach (string owner in new string[] { TargetSid, "S-1-5-18" })
        {
          metadata.ownerSid = owner; NativePlatform.RequireFreshProfileOwner(owner, TargetSid, null, true, metadata);
        }
        Reject(delegate { NativePlatform.RequireFreshProfileOwner(TargetSid, TargetSid, null, true, ProfileMetadata("S-1-5-32-544")); }, "owner and SD from different objects");
      });
      Case(report, "fake-admin-dacl-rejects-mutation-unknown-and-inherit-only-writes", delegate {
        foreach (int mask in new int[] { 2, 4, 16, 64, 256, 0x10000, 0x40000, 0x80000, 0x10000000, 0x40000000 })
          foreach (bool inheritOnly in new bool[] { false, true })
          {
            NativePlatform.ProfileDirectoryMetadata metadata = ProfileMetadata("S-1-5-32-544");
            metadata.aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = RunnerSid, accessMask = mask, allow = false });
            metadata.aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = RunnerSid, accessMask = mask, allow = true, inheritOnly = inheritOnly });
            Reject(delegate { NativePlatform.RequireTrustedProfileDacl(metadata, TargetSid, false); }, "Deny cannot cancel a mutation Allow, even inherit-only");
          }
        foreach (string fault in new string[] { "missing", "null", "empty", "unprotected", "large", "revision", "unknown-ace", "missing-sid", "unknown-mask" })
        {
          NativePlatform.ProfileDirectoryMetadata metadata = ProfileMetadata("S-1-5-32-544");
          if (fault == "missing") metadata.daclPresent = false;
          if (fault == "null") metadata.aces = null;
          if (fault == "empty") metadata.aces.Clear();
          if (fault == "unprotected") metadata.protectedDacl = false;
          if (fault == "large") while (metadata.aces.Count <= 128) metadata.aces.Add(metadata.aces[0]);
          if (fault == "revision") metadata.aclRevision = 255;
          if (fault == "unknown-ace") metadata.aces[0].unclassified = true;
          if (fault == "missing-sid") metadata.aces[0].sid = null;
          if (fault == "unknown-mask") metadata.aces[0].accessMask = 0x2000000;
          Reject(delegate { NativePlatform.RequireTrustedProfileDacl(metadata, TargetSid, false); }, "DACL unknown must fail: " + fault);
        }
      });
      Case(report, "fake-admin-parent-rejects-replacement-and-permission-mutation", delegate {
        foreach (int mask in new int[] { 2, 16, 64, 256, 0x10000, 0x40000, 0x80000, 0x10000000, 0x40000000 })
        {
          NativePlatform.ProfileDirectoryMetadata metadata = ProfileMetadata("S-1-5-18"); metadata.protectedDacl = false;
          metadata.aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = RunnerSid, accessMask = mask, allow = true });
          Reject(delegate { NativePlatform.RequireTrustedProfileDacl(metadata, TargetSid, true); }, "parent permits nontrusted replacement or mutation");
        }
        NativePlatform.ProfileDirectoryMetadata parent = ProfileMetadata("S-1-5-18"); parent.protectedDacl = false;
        parent.aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = RunnerSid, accessMask = 4, allow = true });
        parent.aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = RunnerSid, accessMask = 0x1f01ff, allow = true, inheritOnly = true });
        NativePlatform.RequireTrustedProfileDacl(parent, TargetSid, true);
        parent.ownerSid = RunnerSid;
        Reject(delegate { NativePlatform.RequireTrustedProfileDacl(parent, TargetSid, true); }, "parent owner can rewrite permissions");
      });
      Case(report, "fake-admin-profile-mapping-requires-both-exact-views", delegate {
        NativePlatform.RequireBothProfileMappings(3);
        foreach (int views in new int[] { 0, 1, 2, 4, 7 })
          Reject(delegate { NativePlatform.RequireBothProfileMappings(views); }, "OR of views is not an exact two-view proof");
      });
      Case(report, "fake-profile-snapshot-rejects-object-owner-or-dacl-drift", delegate {
        NativePlatform.ProfileDirectoryMetadata expected = ProfileMetadata("S-1-5-32-544");
        NativePlatform.RequireSameProfileMetadata(expected, ProfileMetadata(expected.ownerSid));
        foreach (string fault in new string[] { "missing", "owner", "dacl", "missing-hash", "file", "volume", "path", "reparse" })
        {
          NativePlatform.ProfileDirectoryMetadata current = ProfileMetadata(expected.ownerSid);
          if (fault == "missing") current = null;
          if (fault == "owner") current.ownerSid = TargetSid;
          if (fault == "dacl") current.descriptorSha256 = new String('b', 64);
          if (fault == "missing-hash") current.descriptorSha256 = null;
          if (fault == "file") current.identity.fileId += "-different";
          if (fault == "volume") current.identity.volumePath += "-different";
          if (fault == "path") current.identity.canonicalPath += "-sibling";
          if (fault == "reparse") current.identity.reparse = true;
          Reject(delegate { NativePlatform.RequireSameProfileMetadata(expected, current); }, "metadata must remain the same object: " + fault);
        }
      });
    }

    public static void Run(FixtureReport report)
    {
      RunProfileBoundaryTests(report);
      RunProfileLeasePolicyTests(report);
      Case(report, "fake-abi-system-context-preserves-parent-presence-and-redacts-observations", delegate {
        Dictionary<string, string> parentSystem = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
          { "SystemRoot", @"C:\Windows" }, { "WINDIR", @"C:\Windows" }, { "OS", "Windows_NT" },
          { "PROCESSOR_ARCHITECTURE", "AMD64" }, { "GITHUB_TOKEN", "fake-do-not-copy" }
        };
        Dictionary<string, string> tokenSystem = new Dictionary<string, string>(parentSystem, StringComparer.OrdinalIgnoreCase) {
          { "SystemDrive", "C:" }, { "PROCESSOR_ARCHITEW6432", "AMD64" }
        };
        Dictionary<string, string> boundSystem = NativePlatform.BindAbiSystemEnvironment(parentSystem, tokenSystem);
        Assert(boundSystem.Count == 4 && !boundSystem.ContainsKey("GITHUB_TOKEN") && !boundSystem.ContainsKey("SystemDrive")
          && !boundSystem.ContainsKey("PROCESSOR_ARCHITEW6432"), "a token environment must not inject variables absent from the parent");
        parentSystem["SystemRoot"] = @"D:\WrongWindows";
        Reject(delegate { NativePlatform.BindAbiSystemEnvironment(parentSystem, tokenSystem); }, "system root mismatch must fail");
        parentSystem["SystemRoot"] = @"C:\Windows"; parentSystem["WINDIR"] = @"D:\WrongWindows";
        Reject(delegate { NativePlatform.BindAbiSystemEnvironment(parentSystem, tokenSystem); }, "WINDIR mismatch must fail");
        Assert(NativePlatform.IsAbiObservation("env-HOME=" + new String('a', 64))
          && NativePlatform.IsAbiObservation("env-SystemDrive=none")
          && NativePlatform.IsAbiObservation("roaming-is-profile-default=1"), "bounded hashes/presence/relations remain observable");
        foreach (string unsafeRow in new string[] { "env-HOME=" + Paths().profile, "env-GITHUB_TOKEN=" + new String('a', 64),
          "token-core=" + TargetSid, "env-HOME=" + new String('a', 64) + "\nsecret", new String('a', 129), null })
          Assert(!NativePlatform.IsAbiObservation(unsafeRow), "untrusted observation rows must not echo raw paths, SID or secrets");
      });

      Case(report, "fake-abi-runtime-context-rejects-missing-and-escaping-paths", delegate {
        string imageDirectory = @"D:\Fixture Compiler\private-stage-a";
        string privateHome = Path.Combine(imageDirectory, "home"), privateTemp = Path.Combine(privateHome, "tmp");
        Dictionary<string, string> inherited = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
          { "HOME", privateHome }, { "USERPROFILE", privateHome }, { "APPDATA", Path.Combine(privateHome, ".config") },
          { "LOCALAPPDATA", Path.Combine(privateHome, ".local") }, { "TEMP", privateTemp }, { "TMP", privateTemp }, { "TMPDIR", privateTemp },
          { "GITHUB_TOKEN", "fake-must-not-be-copied" }
        };
        Dictionary<string, string> bound = NativePlatform.BindAbiRuntimeEnvironment(imageDirectory, inherited);
        Assert(bound.Count == 7 && !bound.ContainsKey("GITHUB_TOKEN"), "only seven exact private runtime paths may be copied");
        foreach (string key in bound.Keys)
        {
          Dictionary<string, string> missing = new Dictionary<string, string>(inherited, StringComparer.OrdinalIgnoreCase);
          missing.Remove(key);
          Reject(delegate { NativePlatform.BindAbiRuntimeEnvironment(imageDirectory, missing); }, "missing private path must fail");
          Dictionary<string, string> escaped = new Dictionary<string, string>(inherited, StringComparer.OrdinalIgnoreCase);
          escaped[key] = @"C:\Users\unrelated-profile";
          Reject(delegate { NativePlatform.BindAbiRuntimeEnvironment(imageDirectory, escaped); }, "real or unrelated user paths must fail");
          escaped[key] = privateHome + @"-sibling\tmp";
          Reject(delegate { NativePlatform.BindAbiRuntimeEnvironment(imageDirectory, escaped); }, "a sibling-prefix cannot count as the fixed private home");
          escaped[key] = privateHome + @"\..\outside";
          Reject(delegate { NativePlatform.BindAbiRuntimeEnvironment(imageDirectory, escaped); }, "dot-segment escapes must fail");
        }
        Reject(delegate { NativePlatform.BindAbiRuntimeEnvironment(imageDirectory, null); }, "no caller environment fallback is allowed");
      });

      Case(report, "fake-abi-hello-preserves-every-binding-and-redacts-values", delegate {
        string[] abiFaults = { "none", "null", "frame", "endpoint-pid", "message-pid", "nonce", "creation", "sid", "binary", "spec",
          "profile", "roaming", "local", "desktop", "programs", "startMenu", "userPrograms" };
        foreach (string fault in abiFaults)
        {
          ProtocolMessage expected = new ProtocolMessage { kind = "abi-hello", nonce = "private-fixture-nonce",
            pid = 4242, creationTime = "123456", sid = TargetSid, binarySha256 = new String('a', 64),
            specSha256 = new String('b', 64), knownPaths = Paths() };
          ProtocolMessage hello = CoreJson.Deserialize<ProtocolMessage>(CoreJson.Serialize(expected));
          int peer = expected.pid;
          if (fault == "null") hello = null;
          else if (fault == "frame") hello.version = 2;
          else if (fault == "endpoint-pid") peer++;
          else if (fault == "message-pid") hello.pid++;
          else if (fault == "nonce") hello.nonce = "wrong";
          else if (fault == "creation") hello.creationTime = "wrong";
          else if (fault == "sid") hello.sid = RunnerSid;
          else if (fault == "binary") hello.binarySha256 = new String('0', 64);
          else if (fault == "spec") hello.specSha256 = new String('0', 64);
          else if (fault == "profile") hello.knownPaths.profile += "-wrong";
          else if (fault == "roaming") hello.knownPaths.roaming += "-wrong";
          else if (fault == "local") hello.knownPaths.local += "-wrong";
          else if (fault == "desktop") hello.knownPaths.desktop += "-wrong";
          else if (fault == "programs") hello.knownPaths.programs += "-wrong";
          else if (fault == "startMenu") hello.knownPaths.startMenu += "-wrong";
          else if (fault == "userPrograms") hello.knownPaths.userPrograms += "-wrong";
          FixtureReport simulated = new FixtureReport { status = "passed" };
          bool matches = NativePlatform.CheckAbiHello(simulated, hello, peer, expected);
          Assert(matches == (fault == "none") && simulated.checks.Count == 15, "each ABI binding remains mandatory with separate diagnostics: " + fault);
          Assert(simulated.status == (fault == "none" ? "passed" : "failed"), "diagnostics cannot turn a mismatched response into success");
          string serialized = CoreJson.Serialize(simulated);
          Assert(!serialized.Contains(expected.nonce) && !serialized.Contains(TargetSid) && !serialized.Contains("fixture-owned"), "binding diagnostics must not expose nonce, SID or raw known paths");
        }
      });

      Case(report, "fake-private-desktop-creator-is-separate-mta-and-exits", delegate {
        int caller = Thread.CurrentThread.ManagedThreadId, worker = caller;
        ApartmentState apartment = ApartmentState.Unknown;
        NativePlatform.PrivateDesktopCreator creator = new NativePlatform.PrivateDesktopCreator(delegate {
          worker = Thread.CurrentThread.ManagedThreadId; apartment = Thread.CurrentThread.GetApartmentState();
        });
        Reject(delegate { creator.WaitForExit(1); }, "an unstarted creator is not a completed UI lease");
        creator.Start();
        Reject(delegate { creator.Start(); }, "creator cannot run twice");
        creator.WaitForExit(5000); creator.ThrowIfFailed();
        Assert(worker != caller && apartment == ApartmentState.MTA && !creator.IsAlive, "creator must leave the original STA thread untouched and really terminate");
      });

      Case(report, "fake-private-desktop-creator-propagates-failure-after-exit", delegate {
        bool released = false;
        NativePlatform.PrivateDesktopCreator creator = new NativePlatform.PrivateDesktopCreator(delegate {
          try { throw new FixtureFailure("fake-private-desktop-create-failure"); }
          finally { released = true; }
        });
        creator.Start(); creator.WaitForExit(5000);
        Reject(delegate { creator.ThrowIfFailed(); }, "native creation failure must reach the Controller");
        Assert(released && !creator.IsAlive, "failure must not masquerade as a live or successful creator");
      });

      Case(report, "fake-private-desktop-creator-timeout-retains-resource-lease", delegate {
        using (ManualResetEvent entered = new ManualResetEvent(false))
        using (ManualResetEvent release = new ManualResetEvent(false))
        {
          bool held = false;
          NativePlatform.PrivateDesktopCreator creator = new NativePlatform.PrivateDesktopCreator(delegate {
            held = true; entered.Set();
            try { release.WaitOne(); }
            finally { held = false; }
          });
          creator.Start();
          try
          {
            Assert(entered.WaitOne(5000), "fake creator must reach its held lease");
            Reject(delegate { creator.WaitForExit(1); }, "timeout cannot claim the creator exited");
            Assert(creator.IsAlive && held, "caller timeout must not free a live creator's resources");
          }
          finally { release.Set(); creator.WaitForExit(5000); }
          creator.ThrowIfFailed();
          Assert(!held && !creator.IsAlive, "only the terminated worker releases its own lease");
        }
      });

      Case(report, "fake-token-fixed-elevation-and-exact-fill-contract", delegate {
        Assert(NativePlatform.FixedTokenCapacity(20) == 4, "TOKEN_ELEVATION is a known DWORD queried with a real four-byte buffer");
        foreach (int infoClass in new int[] { 1, 2, 3, 8, 10, 12, 18, 25 })
          Assert(NativePlatform.FixedTokenCapacity(infoClass) == 0, "other information classes retain their bounded size probe");
        Assert(!NativePlatform.AcceptTokenSizeProbe(20, false, 24, 4), "class20 BAD_LENGTH is still a failure, never an accepted size result");
        foreach (int infoClass in new int[] { 8, 12, 18, 20 })
        {
          Assert(NativePlatform.AcceptTokenFill(infoClass, true, 4, 4), "actual successful DWORD fill is required");
          Assert(!NativePlatform.AcceptTokenFill(infoClass, false, 4, 4), "failure cannot be promoted by an expected length");
          foreach (int length in new int[] { -1, 0, 3, 5 })
            Assert(!NativePlatform.AcceptTokenFill(infoClass, true, 4, length), "scalar fill rejects absent, short or oversized actual length");
          Assert(!NativePlatform.AcceptTokenFill(infoClass, true, 8, 4), "scalar capacity must also be exact");
        }
        Assert(NativePlatform.AcceptTokenFill(1, true, 44, 44), "variable-sized token user remains supported");
        Assert(!NativePlatform.AcceptTokenFill(1, true, 0, 0)
          && !NativePlatform.AcceptTokenFill(1, true, 1048577, 44)
          && !NativePlatform.AcceptTokenFill(1, true, 44, 45), "all other fills remain bounded");
      });

      Case(report, "fake-token-size-probe-exact-session-id-contract", delegate {
        Assert(NativePlatform.AcceptTokenSizeProbe(12, false, 24, 4), "TokenSessionId ERROR_BAD_LENGTH requires exactly DWORD bytes");
        Assert(NativePlatform.AcceptTokenSizeProbe(1, false, 122, 32), "normal insufficient-buffer probe remains supported");
        Assert(NativePlatform.AcceptTokenSizeProbe(12, false, 122, 4), "session-id normal insufficient-buffer probe remains supported");
        foreach (int infoClass in new int[] { 1, 8, 18, 20, 25 })
          Assert(!NativePlatform.AcceptTokenSizeProbe(infoClass, false, 24, 4), "BAD_LENGTH is not accepted for other information classes");
        foreach (int size in new int[] { -1, 0, 3, 5, 1048577 })
          Assert(!NativePlatform.AcceptTokenSizeProbe(12, false, 24, size), "session-id BAD_LENGTH cannot change the scalar size");
        foreach (int error in new int[] { 0, 5, 87 })
          Assert(!NativePlatform.AcceptTokenSizeProbe(12, false, error, 4), "other native errors remain fatal");
        Assert(!NativePlatform.AcceptTokenSizeProbe(12, true, 24, 4), "unexpected probe success is rejected");
        Assert(!NativePlatform.AcceptTokenSizeProbe(1, false, 122, 0)
          && !NativePlatform.AcceptTokenSizeProbe(1, false, 122, 1048577), "all allocations remain bounded");
      });

      Case(report, "fake-controller-complete-order-and-resource-lifecycle", delegate {
        FakePlatform api = new FakePlatform();
        FixtureState state = Execute(api, Spec());
        Assert(state.report.status == "passed" && state.report.cleanup == "cleaned", "complete FakeAPI path must clean successfully");
        string[] order = { "PreflightController", "CreateDisabledAccount", "AddUsersOnly", "CreateFreshProfile", "EnableAccount",
          "Logon", "InspectToken", "LoadProfile", "QueryKnownPaths", "WriteHiveChallenge", "CreatePrivateDesktop",
          "PrepareSubjectAccess", "CreateSubjectSuspended", "AssignSubjectToOwnedJob", "VerifySubject", "ResumeSubject",
          "VerifyHiveResponse", "WaitSubjectExit", "StopOwnedJobs", "CloseRuntimeResources", "DisableAccount", "UnloadProfile", "HivesAbsent",
          "DeleteOwnedProfile", "DeleteOwnedAccount", "CloseTokenAndPrivileges" };
        int previous = -1;
        foreach (string operation in order)
        {
          int current = api.Calls.IndexOf(operation);
          Assert(current > previous, "operation order: " + operation);
          previous = current;
        }
        Assert(state.report.trace.IndexOf("creation-intent-ledger") < state.report.trace.IndexOf("create-disabled-account"), "intent must precede create");
        Assert(state.report.trace.IndexOf("sid-marker-ledger") < state.report.trace.IndexOf("enable-bound-account"), "SID must bind before enable");
        Assert(api.Channel.Acknowledged && api.Channel.Disposed && state.jobsEmpty, "ACK and owned channel/job lifecycle");
        Assert(!state.accountCreated && !state.profileCreated && !state.profileLoaded && state.token == IntPtr.Zero, "no fake resource left live");
        Assert(api.LastPassword != null && api.LastPassword.Pointer == IntPtr.Zero, "credential buffer disposed after logon");
        AssertNoNativePromotion(state);
      });

      foreach (string failure in new string[] { "subject-exit-nonzero", "subject-exit-timeout" })
      {
        string fault = failure;
        Case(report, "fake-complete-requires-natural-exit-" + fault, delegate {
          FakePlatform api = new FakePlatform { Fault = fault };
          FixtureState state = Execute(api, Spec());
          Assert(state.report.status == "failed" && state.report.failedStage == "subject-natural-exit", "complete message alone cannot pass");
          Assert(api.Calls.IndexOf("WaitSubjectExit") < api.Calls.IndexOf("StopOwnedJobs"), "wait must precede forced cleanup");
          AssertNoNativePromotion(state);
        });
      }

      foreach (string phase in new string[] { "fresh-install", "old22-negative", "old-normal-removal-positive" })
      {
        string releasedPhase = phase;
        Case(report, "fake-ack-write-uncertainty-" + releasedPhase, delegate {
          FixtureReport simulated = new FixtureReport { mode = "fake-protocol-accounting" };
          ProtocolTestChannel channel = new ProtocolTestChannel { FailWrite = true };
          Reject(delegate { Controller.SendPhaseAck(simulated, channel, "nonce", releasedPhase, true); }, "delivered-then-failed ACK must propagate failure");
          Assert(channel.Messages.Count == 1, "fake models complete delivery before local failure");
          Assert(simulated.releasedPeMayHaveExecuted && !simulated.releasedPeExecuted
            && simulated.releasedPeExecutionStatus == "ack_attempted;resume_unconfirmed", "uncertain delivery cannot claim not_run or execution success");
          simulated.releasedPeExecuted = true;
          Reject(delegate { Controller.SendPhaseAck(simulated, channel, "nonce", releasedPhase, true); }, "later ACK failure must propagate");
          Assert(simulated.releasedPeExecuted && simulated.releasedPeExecutionStatus == "prior_resume_confirmed;latest_ack_attempted_resume_unknown", "prior execution proof survives a later uncertain ACK");
        });
      }

      Case(report, "fake-nonreleased-and-fake-ack-do-not-promote", delegate {
        FixtureReport simulated = new FixtureReport(); ProtocolTestChannel channel = new ProtocolTestChannel();
        Controller.SendPhaseAck(simulated, channel, "nonce", "observer-calibration", true);
        Controller.SendPhaseAck(simulated, channel, "nonce", "fresh-install", false);
        Assert(!simulated.releasedPeMayHaveExecuted && !simulated.releasedPeExecuted && simulated.releasedPeExecutionStatus == "not_run", "nonreleased/FakeAPI paths remain not_run");
      });

      foreach (string failure in new string[] { "none", "subject-child-stop", "subject-child-close", "persist", "write", "dispose" })
      {
        string fault = failure;
        Case(report, "fake-subject-terminal-after-cleanup-" + fault, delegate {
          FakePlatform api = new FakePlatform { Fault = fault };
          FixtureReport simulated = new FixtureReport { status = "passed" };
          ProtocolTestChannel channel = new ProtocolTestChannel { FailWrite = fault == "write", FailDispose = fault == "dispose" };
          bool persisted = false;
          Subject.Finish(api, new List<OwnedProcess> { new OwnedProcess() }, channel, simulated, "nonce", delegate {
            Assert(api.Calls.Contains("StopChild") && api.Calls.Contains("CloseChild"), "persist must follow every owned cleanup attempt");
            Assert(!String.IsNullOrEmpty(simulated.finishedAtUtc), "terminal report needs final UTC");
            if (fault == "persist") throw new FixtureFailure("fake-persist-failure");
            persisted = true;
          });
          Assert(simulated.status == (fault == "none" ? "passed" : "failed"), "late errors must force subject exit1");
          Assert(channel.Disposed && channel.Messages.Count == 1, "terminal channel must always close");
          ProtocolMessage terminal = CoreJson.Deserialize<ProtocolMessage>(channel.Messages[0]);
          bool beforeDeliveryFailure = fault == "subject-child-stop" || fault == "subject-child-close" || fault == "persist";
          Assert(terminal.kind == (beforeDeliveryFailure ? "failed" : "complete"), "cleanup failure must never send complete");
          Assert(terminal.report.cleanup == (fault.StartsWith("subject-child-", StringComparison.Ordinal) ? "failed" : "passed"), "cleanup facts precede terminal serialization");
          Assert(persisted == (fault != "persist"), "persistence result is not invented");
        });
      }

      Case(report, "fake-native-error-code-survives-redacted-report", delegate {
        FixtureState state = Execute(new FakePlatform { Fault = "native-error" }, Spec());
        Assert(state.report.status == "failed" && state.report.failedStage == "load-user-profile", "native failure must retain its stage");
        Assert(state.report.checks.Any(check => check.name == "load-user-profile" && check.detail.Contains("Win32 5")), "actual error code was dropped");
        AssertNoNativePromotion(state);
      });

      string[] faults = { "controller-preflight", "create-disabled-account", "users-only-membership", "create-fresh-profile",
        "enable-bound-account", "interactive-logon", "standard-primary-token", "load-user-profile", "actual-known-folders",
        "target-environment", "target-hive-challenge", "private-noninteractive-desktop", "readonly-subject-inputs",
        "private-authenticated-pipe", "suspended-subject", "subject-job-before-resume", "suspended-subject-identity",
        "resume-trusted-subject", "authenticate-subject-hello" };
      foreach (string failure in faults)
      {
        string fault = failure;
        Case(report, "fake-reject-" + fault, delegate {
          FakePlatform api = new FakePlatform { Fault = fault };
          FixtureState state = Execute(api, Spec());
          Assert(state.report.status == "failed", "injected operation must fail");
          Assert(state.report.failedStage == fault, "original failed stage must remain recorded");
          Assert(api.Calls.Contains("CloseTokenAndPrivileges"), "finally must always release token/privilege scope");
          Assert(!state.acknowledged, "no product ACK after a preflight failure");
          AssertNoNativePromotion(state);
        });
      }

      string[] cleanFaults = { "cleanup-owned-jobs", "cleanup-runtime-handles", "cleanup-disable-account",
        "cleanup-unload-profile", "cleanup-hives-absent", "cleanup-delete-profile", "cleanup-delete-account", "CloseTokenAndPrivileges" };
      foreach (string failure in cleanFaults)
      {
        string fault = failure;
        Case(report, "fake-cleanup-failure-" + fault, delegate {
          FakePlatform api = new FakePlatform { Fault = fault };
          FixtureState state = Execute(api, Spec());
          Assert(state.report.status == "failed" && state.report.cleanup == "failed", "cleanup failure cannot become green");
          if (fault == "cleanup-owned-jobs" || fault == "cleanup-runtime-handles" || fault == "cleanup-disable-account"
            || fault == "cleanup-unload-profile" || fault == "cleanup-hives-absent")
            Assert(!api.Calls.Contains("DeleteOwnedProfile") && !api.Calls.Contains("DeleteOwnedAccount"), "stop destructive cleanup after uncertainty");
          if (fault == "cleanup-delete-profile") Assert(!api.Calls.Contains("DeleteOwnedAccount"), "failed profile deletion must preserve account");
          AssertNoNativePromotion(state);
        });
      }

      foreach (string failure in new string[] { "unbound-created-sid", "replaced-account-at-cleanup", "hive-still-mounted", "unload-not-confirmed", "delete-not-confirmed", "unknown-sid-process" })
      {
        string fault = failure;
        Case(report, "fake-deny-uncertain-ownership-" + fault, delegate {
          FakePlatform api = new FakePlatform { Fault = fault };
          FixtureState state = Execute(api, Spec());
          Assert(state.report.status == "failed" && state.report.cleanup == "failed", "uncertain ownership must fail cleanup");
          Assert(!api.Calls.Contains("DeleteOwnedAccount"), "cannot delete an unproved or still loaded account");
          if (fault == "unbound-created-sid") Assert(!api.Calls.Contains("EnableAccount") && !api.Calls.Contains("Logon"), "unbound SID must stay disabled");
          if (fault != "delete-not-confirmed") Assert(!api.Calls.Contains("DeleteOwnedProfile"), "cannot delete an unproved profile");
          AssertNoNativePromotion(state);
        });
      }

      foreach (string failure in new string[] { "hello-nonce", "hello-pid", "hello-peer", "hello-creation", "hello-binary", "hello-spec", "hello-admin", "hello-path", "hive-response", "complete-nonce", "complete-failed", "complete-cleanup-failed" })
      {
        string fault = failure;
        Case(report, "fake-authentication-reject-" + fault, delegate {
          FakePlatform api = new FakePlatform { Fault = fault };
          FixtureState state = Execute(api, Spec());
          Assert(state.report.status == "failed", "incorrect authenticated data must stop the controller");
          if (!fault.StartsWith("complete-", StringComparison.Ordinal)) Assert(!api.Channel.Acknowledged, "no ACK for bad hello");
          AssertNoNativePromotion(state);
        });
      }

      Action<TokenIdentity>[] badTokens = {
        delegate(TokenIdentity token) { token.sid = RunnerSid; }, delegate(TokenIdentity token) { token.tokenType = 2; },
        delegate(TokenIdentity token) { token.integrityRid = 0x3000; }, delegate(TokenIdentity token) { token.integrityRid = 0x1000; },
        delegate(TokenIdentity token) { token.elevated = true; }, delegate(TokenIdentity token) { token.elevationType = 3; },
        delegate(TokenIdentity token) { token.groups.Add("S-1-5-32-544|16"); }, delegate(TokenIdentity token) { token.groups.Clear(); },
        delegate(TokenIdentity token) { token.privileges.Add("SeDebugPrivilege|0"); }, delegate(TokenIdentity token) { token.authenticationId = ""; }
      };
      for (int index = 0; index < badTokens.Length; index++)
      {
        int item = index;
        Case(report, "standard-token-reject-" + item, delegate {
          TokenIdentity token = Standard(); badTokens[item](token);
          Reject(delegate { CorePolicy.AssertStandard(token, TargetSid); }, "unsafe token admitted");
        });
      }

      Case(report, "controller-spec-requires-exact-stage-owner-plan-and-paths", delegate {
        CorePolicy.ValidateControllerSpec(Spec());
        Action<FixtureSpec>[] invalid = {
          delegate(FixtureSpec s) { s.realExecutionAdmitted = false; }, delegate(FixtureSpec s) { s.executionStage = "A"; },
          delegate(FixtureSpec s) { s.owner = "unowned"; }, delegate(FixtureSpec s) { s.generation = 2; },
          delegate(FixtureSpec s) { s.frozenPlanManifestSha256 = new String('0', 64); },
          delegate(FixtureSpec s) { s.argvEnvPlanSha256 = new String('0', 64); },
          delegate(FixtureSpec s) { s.controllerRoot = s.gitRoot + @"\inside"; },
          delegate(FixtureSpec s) { s.output = @"C:\other\result.json"; },
          delegate(FixtureSpec s) { s.sourcePins[1].file = s.sourcePins[0].file; },
          delegate(FixtureSpec s) { s.sourcePins.RemoveAt(0); }, delegate(FixtureSpec s) { s.expectedBinarySha256 = ""; }
        };
        foreach (Action<FixtureSpec> mutate in invalid)
        {
          FixtureSpec spec = Spec(); mutate(spec);
          Reject(delegate { CorePolicy.ValidateControllerSpec(spec); }, "invalid spec accepted");
        }
      });

      Case(report, "exact-binary-source-and-setup-bindings", delegate {
        FakePlatform api = new FakePlatform(); FixtureSpec spec = Spec(); api.Specification = spec;
        CorePolicy.ValidateBindings(spec, api);
        foreach (string fault in new string[] { "source-hash", "source-reparse", "setup-size", "setup-hash", "setup-reparse" })
        {
          api.Fault = fault;
          Reject(delegate { CorePolicy.ValidateBindings(spec, api); }, "bad pinned input admitted");
        }
        api.Fault = null; spec.expectedBinarySha256 = new String('0', 64);
        Reject(delegate { CorePolicy.ValidateBindings(spec, api); }, "wrong fixture binary admitted");
        Assert(!api.Calls.Contains("CreateDisabledAccount"), "binding checks do not create accounts");
      });

      Case(report, "exact-nsis-command-tails-with-spaces", delegate {
        string root = @"C:\Users\fixture-owned\AppData\Local\Programs\Claude Code Haha";
        Assert(CorePolicy.SetupCommand(@"C:\locked input\setup.exe", root) == "\"C:\\locked input\\setup.exe\" /S /currentuser /D=" + root, "setup tail changed");
        Assert(CorePolicy.UninstallerCommand(@"C:\owned temp\old.exe", root) == "\"C:\\owned temp\\old.exe\" /S /KEEP_APP_DATA /currentuser --keep-shortcuts --updated _?=" + root, "uninstall tail changed");
        foreach (string value in new string[] { root + "\" /allusers", root + "\r", root + "\n", root + "\0", root + @"\..\escape", @"\\host\share\root", root + ":stream", root + " " })
          Reject(delegate { CorePolicy.SetupCommand(@"C:\locked\setup.exe", value); }, "bad raw tail accepted");
        Reject(delegate { CorePolicy.SubjectCommand(@"C:\" + new String('a', 700) + ".exe", @"C:\" + new String('b', 400) + ".json"); }, "WithToken command bound missing");
      });

      Case(report, "target-only-environment-and-identical-uninstall-block", delegate {
        FixtureSpec spec = Spec(); spec.knownPaths = Paths(); spec.profilePath = spec.knownPaths.profile;
        spec.fixtureRoot = spec.knownPaths.local + @"\CcHaha1879Fixture\nonce"; spec.tempRoot = spec.fixtureRoot + @"\temp";
        FakePlatform api = new FakePlatform(); Dictionary<string, string> target = api.Environment();
        target["GITHUB_TOKEN"] = "fake-must-be-omitted"; target["ANTHROPIC_API_KEY"] = "fake-must-be-omitted";
        target["CLAUDE_CONFIG_DIR"] = @"C:\foreign"; target["CC_HAHA_APP_PORTABLE_DIR"] = @"C:\foreign";
        target["PSModulePath"] = @"C:\foreign"; target["COMPLUS_Version"] = "foreign"; target["PATH"] = @"C:\foreign";
        Dictionary<string, string> normal = CorePolicy.BuildEnvironment(target, spec, false);
        foreach (string excluded in new string[] { "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "CC_HAHA_APP_PORTABLE_DIR", "PSModulePath", "COMPLUS_Version" })
          Assert(!normal.ContainsKey(excluded), "unlisted environment leaked");
        Assert(normal["TEMP"] == spec.tempRoot && normal["HOME"] == spec.profilePath && normal["PATH"].StartsWith(@"C:\Windows\System32;", StringComparison.Ordinal), "real target environment mismatch");
        Dictionary<string, string> negative = CorePolicy.BuildEnvironment(target, spec, true);
        Dictionary<string, string> positive = CorePolicy.BuildEnvironment(target, spec, true);
        Assert(negative["COMPLUS_Version"] == CorePolicy.BadClr && CorePolicy.EnvironmentHash(negative) == CorePolicy.EnvironmentHash(positive), "negative/positive environment differs");
        string block = CorePolicy.EnvironmentBlock(negative);
        Assert(block.EndsWith("\0\0", StringComparison.Ordinal) && block.IndexOf("GITHUB_TOKEN", StringComparison.Ordinal) < 0, "Unicode block termination or secret filter");
        target["APPDATA"] = @"C:\foreign";
        Reject(delegate { CorePolicy.BuildEnvironment(target, spec, false); }, "environment masquerades as profile identity");
      });

      Case(report, "environment-rejects-duplicates-injection-and-unbounded-data", delegate {
        Reject(delegate { CorePolicy.EnvironmentBlock(new Dictionary<string, string> { { "PATH", "a" }, { "path", "b" } }); }, "duplicate names accepted");
        Reject(delegate { CorePolicy.EnvironmentBlock(new Dictionary<string, string> { { "BAD=KEY", "a" } }); }, "bad name accepted");
        Reject(delegate { CorePolicy.EnvironmentBlock(new Dictionary<string, string> { { "KEY", "a\0b" } }); }, "NUL value accepted");
        Reject(delegate { CorePolicy.EnvironmentBlock(new Dictionary<string, string> { { "KEY", new String('x', 16384) } }); }, "unbounded environment accepted");
        KnownPaths escaped = Paths(); escaped.local = escaped.profile + "-sibling\\Local";
        Reject(delegate { CorePolicy.AssertPaths(escaped, Paths().profile); }, "sibling-prefix folder escape admitted");
      });
    }

    // Also callable by a temporary managed-only entry point on non-Windows.
    // This subset never constructs NativePlatform or invokes a Windows API.
    internal static void RunProfileBoundaryTests(FixtureReport report)
    {
      Case(report, "fake-abi-environment-is-owned-readonly-and-does-not-require-historical-admission", delegate {
        FixtureState state = AbiEnvironmentState();
        NativePlatform.RequireAbiEnvironmentRead(state, state, false, false);
        Assert(!state.spec.realExecutionAdmitted && state.account == null && !state.profileCreated && !state.profileLoaded,
          "an owned ABI current-token environment read must remain possible without a live Controller binding");
      });
      Case(report, "fake-abi-environment-rejects-profile-only-and-unowned-or-live-state", delegate {
        foreach (string fault in new string[] { "not-owned", "historical-context", "products", "profile-only", "historical",
          "live-admission", "live-stage", "no-root", "wrong-sid", "nonprimary", "no-birth", "account", "account-created",
          "account-bound", "profile-created", "profile-loaded", "profile-lease", "no-token", "environment-already-owned" })
        {
          FixtureState state = AbiEnvironmentState();
          switch (fault)
          {
            case "profile-only": state.spec = ProfileOnlySpec(); break;
            case "historical": state.spec = Spec(); break;
            case "live-admission": state.spec.realExecutionAdmitted = true; break;
            case "live-stage": state.spec.executionStage = "B"; break;
            case "no-root": state.controllerRootOwned = false; break;
            case "wrong-sid": state.targetIdentity.sid = TargetSid; break;
            case "nonprimary": state.targetIdentity.tokenType = 2; break;
            case "no-birth": state.runnerCreationTime = null; break;
            case "account": state.account = new AccountRecord(); break;
            case "account-created": state.accountCreated = true; break;
            case "account-bound": state.accountBound = true; break;
            case "profile-created": state.profileCreated = true; break;
            case "profile-loaded": state.profileLoaded = true; break;
            case "profile-lease": state.profile = new IntPtr(123); break;
            case "no-token": state.token = IntPtr.Zero; break;
            case "environment-already-owned": state.environment = new IntPtr(456); break;
          }
          Reject(delegate { NativePlatform.RequireAbiEnvironmentRead(state, fault == "not-owned" ? AbiEnvironmentState() : state,
            fault == "historical-context", fault == "products"); }, "ABI readonly entry must reject " + fault);
        }
        Reject(delegate { NativePlatform.RequireAbiEnvironmentRead(null, null, false, false); }, "an absent harness state is not authorization");
      });
      Case(report, "fake-profile-only-stops-before-account-enable-and-logon", delegate {
        FakePlatform api = new FakePlatform();
        FixtureSpec spec = ProfileOnlySpec();
        FixtureState state = Execute(api, spec);
        Assert(state.report.status == "passed" && state.report.cleanup == "cleaned", "profile-only must complete its own bounded operation and cleanup");
        Assert(api.Calls.Count(name => name == "CreateFreshProfile") == 1, "one fresh SID receives exactly one CreateProfile attempt");
        foreach (string forbidden in new string[] { "EnableAccount", "Logon", "LoadProfile", "WriteHiveChallenge", "CreatePrivateDesktop", "PrepareSubjectAccess", "CreateSubjectSuspended" })
          Assert(!api.Calls.Contains(forbidden), "profile-only cannot enter a historical continuation: " + forbidden);
        Assert(api.Calls.Contains("DeleteOwnedProfile") && api.Calls.Contains("DeleteOwnedAccount"), "a proven successful profile receives ordered cleanup");
        AssertNoNativePromotion(state);
      });
      Case(report, "fake-profile-only-failure-is-single-attempt-and-retained-unknown", delegate {
        FakePlatform api = new FakePlatform { Fault = "profile-partial-after-success" };
        FixtureState state = Execute(api, ProfileOnlySpec());
        Assert(state.report.mode == "profile-only" && state.report.status == "failed" && state.report.cleanup == "failed",
          "profile-only partial failure cannot be called a successful or clean historical execution");
        Assert(state.profileCreationAttempts == 1 && state.profileCreationUncertain && !state.profileOwnershipProven
          && api.Calls.Count(name => name == "CreateFreshProfile") == 1, "one attempt remains uncertain without a retry");
        Assert(!api.Calls.Contains("EnableAccount") && !api.Calls.Contains("Logon") && !api.Calls.Contains("LoadProfile")
          && !api.Calls.Contains("DeleteOwnedProfile") && !api.Calls.Contains("DeleteOwnedAccount"), "partial failure stops every continuation and destructive cleanup");
        Assert(state.report.trace.IndexOf("createprofile-call-armed") < state.report.trace.IndexOf("cleanup-owned-jobs"), "uncertainty must be armed before cleanup");
        AssertNoNativePromotion(state);
      });
      Case(report, "fake-profile-owner-observations-do-not-expand-strict-owner-policy", delegate {
        foreach (string owner in new string[] { TargetSid, "S-1-5-18", "S-1-5-32-544", RunnerSid, "S-1-5-21-7-8-9-1010", null })
        {
          string row = NativePlatform.ProfileOwnerObservation(owner, TargetSid, "S-1-5-32-544", RunnerSid);
          Assert(row.Length < 1800 && row.Contains("observation-only=true")
            && !row.Contains("S-1-") && !row.Contains(Paths().profile), "owner diagnostics must contain only bounded hashes and relations");
          Assert(row.Contains("sidSha256=" + (owner == null ? "absent" : CorePolicy.HashText(owner))), "owner hash is available before rejection");
          if (owner == TargetSid || owner == "S-1-5-18") NativePlatform.RequireFreshProfileOwner(owner, TargetSid);
          else Reject(delegate { NativePlatform.RequireFreshProfileOwner(owner, TargetSid); }, "observing an owner must not admit it");
          if (owner == "S-1-5-32-544") Assert(row.Contains("equalsAdministrators=True") && row.Contains("equalsCallTokenOwner=True"),
            "matching effective TokenOwner and Administrators is still diagnostic only");
        }
        Reject(delegate { NativePlatform.ProfileOwnerObservation(new String('x', 185), TargetSid, null, RunnerSid); }, "unbounded owner input");
      });
      Case(report, "fake-profile-dacl-diagnostics-conservatively-classify-allow-writes", delegate {
        List<NativePlatform.ProfileDiagnosticAce> aces = new List<NativePlatform.ProfileDiagnosticAce>();
        foreach (string sid in new string[] { TargetSid, "S-1-5-18", "S-1-5-32-544" })
          aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = sid, accessMask = 0x10000000, allow = true });
        aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = RunnerSid, accessMask = 0x120089, allow = true });
        string row = NativePlatform.ProfileDaclObservation(true, true, aces, TargetSid);
        Assert(row.Contains("aceCount=4") && row.Contains("protected=True") && row.Contains("nontrustedAllowWrite=0"), "trusted writes and unrelated readonly ACEs");
        foreach (int mask in new int[] { 2, 4, 16, 64, 256, 0x10000, 0x40000, 0x80000, 0x10000000, 0x40000000 })
        {
          aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = RunnerSid, accessMask = mask, allow = true, unclassified = true });
          row = NativePlatform.ProfileDaclObservation(true, false, aces, TargetSid);
          Assert(row.Contains("nontrustedAllowWrite=1") && row.Contains("unclassifiedAces=1") && !row.Contains(RunnerSid), "all modifying rights remain redacted and conservatively classified");
          aces.RemoveAt(aces.Count - 1);
        }
        aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = RunnerSid, accessMask = 0x10000000, allow = false });
        Assert(NativePlatform.ProfileDaclObservation(true, false, aces, TargetSid).Contains("nontrustedAllowWrite=0"), "deny ACE is not a write grant");
        Assert(NativePlatform.ProfileDaclObservation(false, false, null, TargetSid).Contains("nontrustedAllowWrite=unknown"), "missing/null DACL cannot be classified safe");
        while (aces.Count <= 128) aces.Add(new NativePlatform.ProfileDiagnosticAce());
        Assert(NativePlatform.ProfileDaclObservation(true, false, aces, TargetSid).Contains("scan=unproven"), "large ACLs are not partially presented as proven");
      });
      Case(report, "fake-profile-directory-mapping-diagnostics-distinguish-identity-failures", delegate {
        FileIdentity expected = new FileIdentity { canonicalPath = Paths().profile, directory = true, fileId = "owned-profile", volumePath = "fixture-volume" };
        foreach (string fault in new string[] { "none", "missing", "reparse", "not-directory", "file-id", "volume", "path" })
        {
          FileIdentity actual = new FileIdentity { canonicalPath = expected.canonicalPath, directory = true, fileId = expected.fileId, volumePath = expected.volumePath };
          switch (fault)
          {
            case "missing": actual = null; break;
            case "reparse": actual.reparse = true; break;
            case "not-directory": actual.directory = false; break;
            case "file-id": actual.fileId += "-changed"; break;
            case "volume": actual.volumePath += "-changed"; break;
            case "path": actual.canonicalPath += "-sibling"; break;
          }
          Assert((NativePlatform.FreshProfileIdentityRelation(expected, actual) == "same-identity") == (fault == "none"), "mapping diagnostic must distinguish " + fault);
        }
      });
      foreach (string fault in new string[] { "owner-administrators", "owner-unknown", "owner-missing", "mapping", "reparse", "identity-drift" })
        Case(report, "fake-profile-diagnostic-failure-retains-unknown-" + fault, delegate {
          FakePlatform api = new FakePlatform { Fault = "profile-diagnostic-" + fault };
          FixtureState state = Execute(api, ProfileOnlySpec());
          Assert(state.report.status == "failed" && state.report.cleanup == "failed" && state.profileCreationUncertain
            && !state.profileOwnershipProven && state.profileCreationAttempts == 1, "diagnostics cannot establish an ownership lease");
          Assert(state.report.trace.Any(row => row.Contains("profile-owner;")) && state.report.trace.Any(row => row.Contains("identityRelation=")), "rejection must retain redacted metadata observations");
          Assert(api.Calls.Count(name => name == "CreateFreshProfile") == 1 && state.accountDisabled, "one call, disabled account");
          foreach (string forbidden in new string[] { "EnableAccount", "Logon", "LoadProfile", "DeleteOwnedProfile", "DeleteOwnedAccount" })
            Assert(!api.Calls.Contains(forbidden), "uncertain diagnostics cannot reach native deletion or continuation: " + forbidden);
          AssertNoNativePromotion(state);
        });
      Case(report, "fake-admin-profile-lease-keeps-creation-context-through-ledger-and-cleanup", delegate {
        FakePlatform api = new FakePlatform { Fault = "profile-admin-valid" };
        FixtureState state = Execute(api, ProfileOnlySpec());
        Assert(state.report.status == "passed" && state.report.cleanup == "cleaned", "complete fresh Admin proof may clean only its own new resources");
        Assert(state.profileCreationTokenOwner == "S-1-5-32-544" && state.profileCreationIdentity != null && state.profileCreationSucceeded,
          "original creation context survives cleanup without a new token query");
        Assert(state.profileCreationPin == null && api.Calls.Count(name => name == "ReleaseProfileCreationPin") == 1,
          "creation pin released once, after the proven ledger");
        Assert(api.Calls.IndexOf("ReleaseProfileCreationPin") < api.Calls.IndexOf("CloseRuntimeResources")
          && api.Calls.Count(name => name == "DeleteProfileCall") == 1 && api.Calls.Count(name => name == "NetUserDelCall") == 1,
          "pin does not cross profile API boundary and owned deletion remains ordered");
        AssertNoNativePromotion(state);
      });
      foreach (string fault in new string[] { "token-query", "token-missing", "token-different", "create-failed", "owner-missing", "owner-other",
        "dacl-null", "dacl-unprotected", "dacl-unknown", "dacl-write", "parent-owner", "parent-replace", "view32", "view64",
        "reparse", "file-drift", "volume-drift", "hive", "process", "pin-close" })
        Case(report, "fake-admin-profile-refusal-keeps-unknown-" + fault, delegate {
          FakePlatform api = new FakePlatform { Fault = "profile-admin-" + fault };
          FixtureState state = Execute(api, ProfileOnlySpec());
          Assert(state.report.status == "failed" && state.report.cleanup == "failed" && state.profileCreationUncertain
            && !state.profileOwnershipProven && state.profileCreationAttempts == 1 && state.accountDisabled,
            "unknown or failed proof cannot become an ownership lease");
          Assert(!api.Calls.Contains("DeleteProfileCall") && !api.Calls.Contains("NetUserDelCall")
            && !api.Calls.Contains("EnableAccount") && !api.Calls.Contains("Logon") && !api.Calls.Contains("LoadProfile"), "failure cannot delete or continue");
          Assert(api.Calls.Count(name => name == "FakeCreateProfileCall") == (fault == "token-query" ? 0 : 1), "no profile API retry");
          Assert(state.profileCreationPin == null && api.Calls.Count(name => name == "ReleaseProfileCreationPin") <= 1,
            "every assigned pin is released even on refusal or close failure");
          AssertNoNativePromotion(state);
        });
      foreach (string fault in new string[] { "cleanup-context", "cleanup-drift", "delete-failed" })
        Case(report, "fake-admin-cleanup-refuses-drift-or-uncertain-api-" + fault, delegate {
          FakePlatform api = new FakePlatform { Fault = "profile-admin-" + fault };
          FixtureState state = Execute(api, ProfileOnlySpec());
          Assert(state.report.status == "failed" && state.report.cleanup == "failed" && state.profileCreationUncertain
            && state.profileCreated && !api.Calls.Contains("NetUserDelCall"), "cleanup failure must preserve account and unknown profile");
          int calls = api.Calls.Count(name => name == "DeleteProfileCall");
          Assert(calls == (fault == "delete-failed" ? 1 : 0), "pre-API refusal versus one uncertain Delete call");
          Controller.Cleanup(state, api);
          Assert(api.Calls.Count(name => name == "DeleteProfileCall") == calls && !api.Calls.Contains("NetUserDelCall"), "uncertain cleanup cannot retry Delete or advance to NetUserDel");
          AssertNoNativePromotion(state);
        });
      Case(report, "fake-admin-creation-pin-does-not-cross-original-load-boundary", delegate {
        FakePlatform api = new FakePlatform { Fault = "profile-admin-valid" };
        FixtureState state = Execute(api, Spec());
        Assert(state.report.status == "passed" && api.Calls.IndexOf("ReleaseProfileCreationPin") < api.Calls.IndexOf("LoadProfile"), "original controller retains one released creation context before Load");
        AssertNoNativePromotion(state);
      });
      foreach (string fault in new string[] { "load-failed", "load-drift", "load-failed-drift" })
        Case(report, "fake-admin-load-boundary-failure-remains-unknown-" + fault, delegate {
          FakePlatform api = new FakePlatform { Fault = "profile-admin-" + fault };
          FixtureState state = Execute(api, Spec());
          Assert(state.report.status == "failed" && state.report.cleanup == "failed" && state.profileCreationUncertain
            && state.profileCreationPin == null && !api.Calls.Contains("DeleteProfileCall") && !api.Calls.Contains("NetUserDelCall"), "failed Load boundary cannot authorize cleanup deletion");
          Assert(api.Calls.Count(name => name == "LoadUserProfileCall") == 1, "one simulated userenv boundary");
          Assert(api.Calls.IndexOf("PostLoadMetadataReadback") > api.Calls.IndexOf("LoadUserProfileCall"), "both BOOL results must reach read-only metadata validation");
          if (fault.StartsWith("load-failed", StringComparison.Ordinal))
          {
            Assert(!state.profileLoaded && state.profile == IntPtr.Zero, "failed BOOL and any returned hive handle cannot authorize unload or cleanup");
            Assert(state.report.checks.Any(check => check.name == "load-user-profile" && check.detail.Contains("Win32 5")), "readback failure must not replace the cached Load error");
          }
          Reject(delegate { api.LoadProfile(state); }, "uncertain Load cannot be retried");
          Assert(api.Calls.Count(name => name == "LoadUserProfileCall") == 1, "no repeated API after pin release");
          AssertNoNativePromotion(state);
        });
      Case(report, "fake-old-ledger-booleans-cannot-reconstruct-admin-creation-context", delegate {
        FakePlatform api = new FakePlatform { Fault = "profile-admin-valid" };
        FixtureState state = Controller.NewState(ProfileOnlySpec(), new FixtureReport());
        state.account = new AccountRecord { sam = state.sam, sid = TargetSid, marker = state.marker, flags = 515, groups = new List<string> { "S-1-5-32-545" } };
        state.accountCreated = true; state.accountBound = true; state.profileCreated = true;
        state.profileCreationAttempts = 1; state.profileOwnershipProven = true;
        state.profileIdentity = ProfileMetadata("S-1-5-32-544").identity;
        state.report.trace.Add("old-report-owner-equals-token-owner=true");
        Controller.Cleanup(state, api);
        Assert(state.report.cleanup == "failed" && state.profileCreationTokenOwner == null && !state.profileCreationSucceeded
          && !api.Calls.Contains("DeleteProfileCall") && !api.Calls.Contains("NetUserDelCall"), "disk/report observations are never an original in-memory creation proof");
      });
      Case(report, "fake-profile-only-rejects-historical-and-crossed-plan-admission", delegate {
        Reject(delegate { CorePolicy.ValidateProfileOnlySpec(Spec()); }, "historical admission cannot authorize profile-only");
        Reject(delegate { CorePolicy.ValidateControllerSpec(ProfileOnlySpec()); }, "profile-only admission cannot authorize historical B");
        foreach (string field in new string[] { "mode", "executionStage", "realExecutionAdmitted", "runId", "owner", "generation", "frozenPlanManifestSha256", "argvEnvPlanSha256" })
        {
          FixtureSpec spec = ProfileOnlySpec();
          switch (field)
          {
            case "mode": spec.mode = "historical-v078-controller"; break;
            case "executionStage": spec.executionStage = "B"; break;
            case "realExecutionAdmitted": spec.realExecutionAdmitted = false; break;
            case "runId": spec.runId = "unbound-run"; break;
            case "owner": spec.owner = "unbound-owner"; break;
            case "generation": spec.generation++; break;
            case "frozenPlanManifestSha256": spec.frozenPlanManifestSha256 = CorePolicy.PlanHash; break;
            case "argvEnvPlanSha256": spec.argvEnvPlanSha256 = CorePolicy.EnvironmentPlanHash; break;
          }
          Reject(delegate { CorePolicy.ValidateProfileOnlySpec(spec); }, "profile-only must reject crossed admission field " + field);
        }
      });
      Case(report, "fake-profile-only-binds-three-sources-and-never-reads-setup", delegate {
        FixtureSpec spec = ProfileOnlySpec();
        spec.setupPath = "not-an-executable-path-and-never-consumed";
        FakePlatform api = new FakePlatform();
        CorePolicy.ValidateProfileOnlyBindings(spec, api);
        Assert(api.IdentifiedPaths.Count == 3 && api.IdentifiedPaths.All(path => path.EndsWith(".cs", StringComparison.Ordinal)),
          "profile-only source binding may identify exactly the three compiled sources, never historical setup");
        foreach (string fault in new string[] { "source-reparse", "source-hash" })
          Reject(delegate { CorePolicy.ValidateProfileOnlyBindings(spec, new FakePlatform { Fault = fault }); }, "source binding remains exact");
        spec.expectedBinarySha256 = new String('0', 64);
        Reject(delegate { CorePolicy.ValidateProfileOnlyBindings(spec, api); }, "new fixture binary pin cannot be bypassed");
      });
      Case(report, "fake-profile-only-generates-fresh-nonce-and-preserves-old-report-shape", delegate {
        FixtureSpec spec = ProfileOnlySpec();
        FixtureState first = Controller.NewState(spec, new FixtureReport());
        FixtureState second = Controller.NewState(spec, new FixtureReport());
        Assert(first.sam != second.sam && first.marker != second.marker && first.sam.StartsWith("c1879_", StringComparison.Ordinal),
          "each invocation generates a fresh unpredictable account intent");
        FixtureReport old = CoreJson.Deserialize<FixtureReport>(CoreJson.Serialize(new FixtureReport { mode = "controller" }));
        Assert(old.version == 1 && old.mode == "controller" && old.cleanup == "not_run" && old.oldExit22Policy == "fatal"
          && old.trace.Count == 0 && old.member_proven == "not_run" && old.full_old_to_new == "not_run", "version1 report roundtrip retains existing fields");
      });
      Case(report, "fake-createprofile-failure-preserves-partial-unknown", delegate {
        FakePlatform api = new FakePlatform { Fault = "create-fresh-profile" };
        FixtureState state = Execute(api, Spec());
        Assert(state.report.status == "failed" && state.report.cleanup == "failed", "a failing CreateProfile may have partial side effects");
        Assert(api.Calls.Contains("DisableAccount") && !api.Calls.Contains("DeleteOwnedProfile") && !api.Calls.Contains("DeleteOwnedAccount"), "only the exactly bound account may be disabled; unknown profile/account cannot be deleted");
        Assert(state.accountCreated && state.accountDisabled, "unknown cleanup preserves the disabled owned account");
        AssertNoNativePromotion(state);
      });
      Case(report, "fake-createprofile-partial-success-without-identity-is-unknown", delegate {
        FakePlatform api = new FakePlatform { Fault = "profile-partial-after-success" };
        FixtureState state = Execute(api, Spec());
        Assert(state.report.status == "failed" && state.report.cleanup == "failed", "a returned path without proven identity is insufficient for deletion");
        Assert(!api.Calls.Contains("DeleteOwnedProfile") && !api.Calls.Contains("DeleteOwnedAccount"), "partial state cannot authorize destructive cleanup");
        AssertNoNativePromotion(state);
      });
      Case(report, "fake-historical-controller-retains-version1-input", delegate {
        FixtureSpec original = Spec();
        FixtureSpec roundTrip = CoreJson.Deserialize<FixtureSpec>(CoreJson.Serialize(original));
        CorePolicy.ValidateControllerSpec(roundTrip);
        Assert(roundTrip.mode == "historical-v078-controller" && roundTrip.executionStage == "B"
          && roundTrip.frozenPlanManifestSha256 == CorePolicy.PlanHash && roundTrip.setupPath == original.setupPath,
          "old version1 input keeps its independent historical admission and setup binding");
      });
      Case(report, "fake-historical-controller-keeps-full-continuation-after-profile-proof", delegate {
        FakePlatform api = new FakePlatform();
        FixtureState state = Execute(api, CoreJson.Deserialize<FixtureSpec>(CoreJson.Serialize(Spec())));
        Assert(state.report.status == "passed" && state.report.cleanup == "cleaned", "historical FakeAPI continuation must remain successful");
        Assert(state.profileCreationAttempts == 1 && state.profileOwnershipProven && !state.profileCreationUncertain
          && api.Calls.Contains("EnableAccount") && api.Calls.Contains("Logon") && api.Calls.Contains("LoadProfile")
          && api.Calls.Contains("CreateSubjectSuspended") && api.Calls.Contains("WaitSubjectExit"), "historical admission retains the full post-profile path");
        AssertNoNativePromotion(state);
      });
    }

    private static FixtureState AbiEnvironmentState()
    {
      return new FixtureState {
        spec = new FixtureSpec { version = 1, mode = "abi-harness", controllerRoot = @"C:\FixturePrivate\owned-abi" },
        controllerRootOwned = true, runnerPid = 42, runnerCreationTime = "owned-current-process-creation", runnerSid = RunnerSid,
        targetIdentity = new TokenIdentity { sid = RunnerSid, tokenType = 1 }, paths = Paths(), profilePath = Paths().profile,
        token = new IntPtr(101)
      };
    }

    private sealed class ProtocolTestChannel : FixtureChannel
    {
      public readonly List<string> Messages = new List<string>();
      public bool FailWrite;
      public bool FailDispose;
      public bool Disposed;
      public override int PeerProcessId { get { return 0; } }
      public override string ReadLine(int timeoutMilliseconds) { throw new FixtureFailure("fake-protocol-read-unavailable"); }
      public override void WriteLine(string line)
      {
        Messages.Add(line);
        if (FailWrite) throw new FixtureFailure("fake-delivered-write-failure");
      }
      public override void Dispose()
      {
        Disposed = true;
        if (FailDispose) throw new FixtureFailure("fake-dispose-failure");
      }
    }

    private sealed class FakeChannel : FixtureChannel
    {
      private readonly FakePlatform api;
      private readonly FixtureState state;
      private int reads;
      public bool Acknowledged;
      public bool Disposed;
      public FakeChannel(FakePlatform api, FixtureState state) { this.api = api; this.state = state; }
      public override int PeerProcessId { get { return state.subject.pid + (api.Fault == "hello-peer" ? 1 : 0); } }
      public override string ReadLine(int timeoutMilliseconds)
      {
        api.Gate(state, "ReadLine");
        if (reads++ == 0)
        {
          TokenIdentity identity = Standard(); KnownPaths paths = Paths();
          if (api.Fault == "hello-admin") identity.groups.Add("S-1-5-32-544|16");
          if (api.Fault == "hello-path") paths.local = @"C:\Users\other\Local";
          return CoreJson.Serialize(new ProtocolMessage {
            kind = "hello", nonce = api.Fault == "hello-nonce" ? "wrong" : state.spec.nonce,
            pid = state.subject.pid + (api.Fault == "hello-pid" ? 1 : 0), sid = TargetSid,
            creationTime = api.Fault == "hello-creation" ? "wrong" : state.subject.creationTime,
            binarySha256 = api.Fault == "hello-binary" ? "wrong" : state.spec.expectedBinarySha256,
            specSha256 = api.Fault == "hello-spec" ? "wrong" : state.spec.subjectSpecSha256,
            identity = identity, knownPaths = paths, hiveResponse = "hive-proof"
          });
        }
        Assert(Acknowledged, "subject cannot send product completion before ACK");
        return CoreJson.Serialize(new ProtocolMessage { kind = "complete", nonce = api.Fault == "complete-nonce" ? "wrong" : state.spec.nonce,
          report = new FixtureReport { status = api.Fault == "complete-failed" ? "failed" : "passed",
            cleanup = api.Fault == "complete-cleanup-failed" ? "failed" : "passed" } });
      }
      public override void WriteLine(string line)
      {
        ProtocolMessage message = CoreJson.Deserialize<ProtocolMessage>(line);
        if (message.kind == "ack") Acknowledged = true;
      }
      public override void Dispose() { Disposed = true; }
    }

    private sealed class FakeProfilePin : IDisposable
    {
      private readonly FakePlatform api;
      private readonly FixtureState state;
      internal bool disposed;
      internal FakeProfilePin(FakePlatform api, FixtureState state) { this.api = api; this.state = state; }
      public void Dispose()
      {
        Assert(!disposed, "pin cannot be released twice"); disposed = true;
        api.Calls.Add("ReleaseProfileCreationPin");
        if (state.profileOwnershipProven) Assert(state.report.trace.Last() == "ledger-durable", "creation pin must survive the proven ledger");
        if (api.Fault == "profile-admin-pin-close") throw new FixtureFailure("fake-profile-pin-close-failed");
      }
    }

    private sealed class FakePlatform : ProfilePlatform
    {
      public override bool IsFake { get { return true; } }
      public string Fault;
      public FixtureSpec Specification;
      public readonly List<string> Calls = new List<string>();
      public readonly List<string> IdentifiedPaths = new List<string>();
      public FakeChannel Channel;
      public SecretBuffer LastPassword;
      private FixtureState current;
      private bool faultThrown;

      public void Gate(FixtureState state, string name)
      {
        if (state != null) current = state;
        Calls.Add(name);
        if (Fault == "native-error" && name == "LoadProfile") throw new InvalidOperationException("LoadUserProfile failed (Win32 5)");
        if (!faultThrown && Fault != null && (Fault == name || (current != null && Fault == current.stage)))
        {
          faultThrown = true;
          throw new FixtureFailure("fake-injected-" + name);
        }
      }

      public override void PreflightController(FixtureState state)
      {
        Gate(state, "PreflightController"); Specification = state.spec;
        if (state.spec.mode == "createprofile-only-controller") CorePolicy.ValidateProfileOnlySpec(state.spec);
        else CorePolicy.ValidateControllerSpec(state.spec);
        state.controllerRootOwned = true; state.runnerSid = RunnerSid; state.runnerPid = 42; state.runnerCreationTime = "controller-creation";
      }
      public override void CreateDisabledAccount(FixtureState state, SecretBuffer password)
      {
        Gate(state, "CreateDisabledAccount"); LastPassword = password;
        Assert(password.Pointer != IntPtr.Zero, "creation needs live native credential buffer");
        state.accountCreated = true;
        state.account = new AccountRecord { sam = state.sam, sid = Fault == "unbound-created-sid" ? RunnerSid : TargetSid,
          marker = state.marker, flags = 0x202 };
      }
      public override void VerifyOwnedAccount(FixtureState state, bool disabled)
      {
        Gate(state, "VerifyOwnedAccount");
        Assert(state.account != null && state.account.sid == TargetSid && state.account.sam == state.sam && state.account.marker == state.marker, "owned SID/marker binding");
        if (Fault == "replaced-account-at-cleanup" && state.stage.StartsWith("cleanup-", StringComparison.Ordinal)) throw new FixtureFailure("actual-SID-replaced");
        Assert(state.accountDisabled == disabled, "account disable flag must agree");
      }
      public override void AddUsersOnly(FixtureState state) { Gate(state, "AddUsersOnly"); state.account.groups.Add("S-1-5-32-545"); }
      public override void CreateFreshProfile(FixtureState state)
      {
        Gate(state, "CreateFreshProfile");
        if (Fault == "profile-admin-token-query") throw new FixtureFailure("fake-original-TokenOwner-query-failed");
        state.profileCreationTokenOwner = Fault == "profile-admin-token-missing" ? null : Fault == "profile-admin-token-different" ? RunnerSid : "S-1-5-32-544";
        Calls.Add("FakeCreateProfileCall");
        state.profilePath = Paths().profile; state.profileCreated = true;
        state.profileCreationSucceeded = Fault != "profile-admin-create-failed";
        if (Fault == "profile-partial-after-success") throw new FixtureFailure("fake-profile-side-effect-before-identity");
        state.profileIdentity = new FileIdentity { canonicalPath = state.profilePath, directory = true, volumePath = @"\\?\Volume{fixture}\", fileId = "profile-file" };
        state.profileCreationIdentity = new FileIdentity { canonicalPath = state.profilePath, directory = true, volumePath = state.profileIdentity.volumePath, fileId = state.profileIdentity.fileId };
        state.profileCreationPin = new FakeProfilePin(this, state);
        if (Fault != null && Fault.StartsWith("profile-admin-", StringComparison.Ordinal))
        {
          NativePlatform.ProfileDirectoryMetadata metadata = ProfileMetadata("S-1-5-32-544");
          if (Fault == "profile-admin-owner-missing") metadata.ownerSid = null;
          if (Fault == "profile-admin-owner-other") metadata.ownerSid = RunnerSid;
          if (Fault == "profile-admin-dacl-null") metadata.aces = null;
          if (Fault == "profile-admin-dacl-unprotected") metadata.protectedDacl = false;
          if (Fault == "profile-admin-dacl-unknown") metadata.aces[0].unclassified = true;
          if (Fault == "profile-admin-dacl-write") metadata.aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = RunnerSid, accessMask = 64, allow = true });
          if (Fault == "profile-admin-reparse") metadata.identity.reparse = true;
          if (Fault == "profile-admin-file-drift") metadata.identity.fileId += "-changed";
          if (Fault == "profile-admin-volume-drift") metadata.identity.volumePath += "-changed";
          NativePlatform.RequireFreshProfileOwner(metadata.ownerSid, TargetSid, state.profileCreationTokenOwner, state.profileCreationSucceeded, metadata);
          CorePolicy.Require(NativePlatform.FreshProfileIdentityRelation(state.profileCreationIdentity, metadata.identity) == "same-identity", "fake-same-object-identity-unproven");
          NativePlatform.ProfileDirectoryMetadata parent = ProfileMetadata("S-1-5-18");
          if (Fault == "profile-admin-parent-owner") parent.ownerSid = RunnerSid;
          if (Fault == "profile-admin-parent-replace") parent.aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = RunnerSid, accessMask = 64, allow = true });
          NativePlatform.RequireTrustedProfileDacl(parent, TargetSid, true);
          NativePlatform.RequireBothProfileMappings(Fault == "profile-admin-view32" ? 2 : Fault == "profile-admin-view64" ? 1 : 3);
          CorePolicy.Require(HivesAbsent(state) && !HasOwnedSidProcesses(state), "fake-post-create-hive-process-unproven");
        }
        if (Fault != null && Fault.StartsWith("profile-diagnostic-", StringComparison.Ordinal))
        {
          string owner = Fault == "profile-diagnostic-owner-administrators" ? "S-1-5-32-544"
            : Fault == "profile-diagnostic-owner-unknown" ? RunnerSid : Fault == "profile-diagnostic-owner-missing" ? null : TargetSid;
          FileIdentity mapped = new FileIdentity { canonicalPath = state.profilePath, directory = true,
            volumePath = state.profileIdentity.volumePath, fileId = state.profileIdentity.fileId };
          if (Fault == "profile-diagnostic-mapping") mapped.canonicalPath += "-sibling";
          if (Fault == "profile-diagnostic-reparse") mapped.reparse = true;
          if (Fault == "profile-diagnostic-identity-drift") mapped.fileId += "-changed";
          state.report.trace.Add(NativePlatform.ProfileOwnerObservation(owner, TargetSid, "S-1-5-32-544", RunnerSid));
          string relation = NativePlatform.FreshProfileIdentityRelation(state.profileIdentity, mapped);
          state.report.trace.Add("ownSID-ProfileList; identityRelation=" + relation + "; leaseGranted=false");
          NativePlatform.RequireFreshProfileOwner(owner, TargetSid);
          CorePolicy.Require(relation == "same-identity", "Own SID profile registration differs from returned profile");
        }
        state.profileOwnershipProven = true; state.profileCreationUncertain = false;
      }
      public override void SetOwnedAccountDisabled(FixtureState state, bool disabled)
      {
        Gate(state, disabled ? "DisableAccount" : "EnableAccount"); state.accountDisabled = disabled;
        state.account.flags = disabled ? state.account.flags | 2U : state.account.flags & ~2U;
      }
      public override void Logon(FixtureState state, SecretBuffer password)
      {
        Gate(state, "Logon"); Assert(password == LastPassword && password.Pointer != IntPtr.Zero, "same native password buffer until authentication"); state.token = new IntPtr(101);
      }
      public override TokenIdentity InspectToken(IntPtr token) { Gate(null, "InspectToken"); return Standard(); }
      public override TokenIdentity InspectCurrentToken() { return new TokenIdentity { sid = RunnerSid }; }
      public override KnownPaths QueryKnownPaths(IntPtr token) { Gate(null, "QueryKnownPaths"); return Paths(); }
      public override void LoadProfile(FixtureState state)
      {
        Gate(state, "LoadProfile"); Assert(state.profileCreationPin == null, "no restrictive pin may cross Load");
        CorePolicy.Require(!state.profileLoadAttempted && !state.profileCreationUncertain, "fake-Load-cannot-retry");
        state.profileCreationUncertain = true;
        state.profileLoadAttempted = true; Calls.Add("LoadUserProfileCall");
        bool loaded = Fault != "profile-admin-load-failed" && Fault != "profile-admin-load-failed-drift";
        if (loaded) { state.profileLoaded = true; state.profile = new IntPtr(201); }
        Calls.Add("PostLoadMetadataReadback");
        try { CorePolicy.Require(Fault != "profile-admin-load-drift" && Fault != "profile-admin-load-failed-drift", "fake-after-Load-drift"); }
        catch { if (!loaded) throw new System.ComponentModel.Win32Exception(5, "LoadUserProfileW"); throw; }
        if (!loaded) throw new System.ComponentModel.Win32Exception(5, "LoadUserProfileW");
        state.profileCreationUncertain = false;
      }
      public Dictionary<string, string> Environment()
      {
        KnownPaths paths = Paths();
        return new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { { "SystemRoot", @"C:\Windows" }, { "USERNAME", "fixture-owned" },
          { "USERDOMAIN", "fixture-machine" }, { "USERPROFILE", paths.profile }, { "APPDATA", paths.roaming }, { "LOCALAPPDATA", paths.local } };
      }
      public override Dictionary<string, string> TargetEnvironment(FixtureState state) { Gate(state, "TargetEnvironment"); return Environment(); }
      public override void WriteHiveChallenge(FixtureState state) { Gate(state, "WriteHiveChallenge"); Assert(state.profileLoaded, "hive challenge needs loaded profile"); }
      public override bool VerifyHiveResponse(FixtureState state, string response) { Gate(state, "VerifyHiveResponse"); return Fault != "hive-response" && response == "hive-proof"; }
      public override string SubjectHiveChallenge(FixtureSpec spec) { return "hive-proof"; }
      public override void PrepareSubjectAccess(FixtureState state)
      {
        Gate(state, "PrepareSubjectAccess"); state.subjectBinaryPath = state.spec.controllerRoot + @"\subject.exe";
        state.spec.subjectSpecPath = state.spec.controllerRoot + @"\subject.json"; state.spec.subjectSpecSha256 = new String('c', 64);
      }
      public override void CreatePrivateDesktop(FixtureState state)
      {
        Gate(state, "CreatePrivateDesktop"); state.station = new IntPtr(301); state.desktop = new IntPtr(302); state.desktopName = "fixture-station\\fixture-desktop";
      }
      public override FixtureChannel CreateControllerChannel(FixtureState state) { Gate(state, "CreateControllerChannel"); Channel = new FakeChannel(this, state); return Channel; }
      public override FixtureChannel ConnectSubjectChannel(FixtureSpec spec) { throw new FixtureFailure("fake-not-a-subject-process"); }
      public override void CreateSubjectSuspended(FixtureState state)
      {
        Gate(state, "CreateSubjectSuspended"); state.subject = new OwnedProcess { process = new IntPtr(401), thread = new IntPtr(402), pid = 4242,
          creationTime = "subject-creation", identity = Standard(), image = new FileIdentity { sha256 = state.spec.expectedBinarySha256 } };
      }
      public override void AssignSubjectToOwnedJob(FixtureState state) { Gate(state, "AssignSubjectToOwnedJob"); state.job = new IntPtr(501); state.subject.assigned = true; }
      public override void VerifySubject(FixtureState state) { Gate(state, "VerifySubject"); Assert(state.subject.assigned && !state.subject.resumed, "must inspect suspended assigned process"); }
      public override void ResumeSubject(FixtureState state) { Gate(state, "ResumeSubject"); Assert(state.subject.assigned, "no resume before job assignment"); state.subject.resumed = true; }
      public override int WaitSubjectExit(FixtureState state, int timeoutMilliseconds)
      {
        Gate(state, "WaitSubjectExit");
        Assert(state.subject.assigned && state.subject.resumed && !state.subject.exited && !state.jobsEmpty && timeoutMilliseconds == 30000, "wait must retain the live subject and precede cleanup");
        if (Fault == "subject-exit-timeout") throw new FixtureFailure("fake-subject-exit-timeout");
        state.subject.exited = true;
        return Fault == "subject-exit-nonzero" ? 1 : 0;
      }
      public override FileIdentity IdentifyPath(string path, bool directory)
      {
        IdentifiedPaths.Add(path);
        bool source = path.EndsWith(".cs", StringComparison.Ordinal);
        return new FileIdentity { canonicalPath = path, directory = directory, fileId = "fake-identity", volumePath = @"\\?\Volume{fixture}\",
          bytes = source ? 10 : CorePolicy.SetupBytes + (Fault == "setup-size" ? 1 : 0),
          sha256 = source ? (Fault == "source-hash" ? new String('0', 64) : new String('a', 64))
            : (Fault == "setup-hash" ? new String('0', 64) : CorePolicy.SetupHash),
          reparse = source ? Fault == "source-reparse" : Fault == "setup-reparse" };
      }
      public override void StartChild(OwnedProcess child, CommandPlan command, Dictionary<string, string> environment, string cwd, string desktopName) { throw new FixtureFailure("no-real-child-in-fake-controller"); }
      public override void VerifyChild(OwnedProcess child, string expectedSid, string expectedPath, string expectedSha256) { throw new FixtureFailure("no-real-child-in-fake-controller"); }
      public override void ResumeChild(OwnedProcess child) { throw new FixtureFailure("no-real-child-in-fake-controller"); }
      public override int WaitChild(OwnedProcess child, int timeoutMilliseconds) { throw new FixtureFailure("no-real-child-in-fake-controller"); }
      public override void StopChild(OwnedProcess child)
      {
        Gate(null, "StopChild");
        if (Fault == "subject-child-stop") throw new FixtureFailure("fake-child-stop-failure");
        child.exited = true;
      }
      public override void CloseChild(OwnedProcess child)
      {
        Gate(null, "CloseChild");
        if (Fault == "subject-child-close") throw new FixtureFailure("fake-child-close-failure");
        child.process = IntPtr.Zero; child.thread = IntPtr.Zero; child.job = IntPtr.Zero;
      }
      public override void VerifyReportedPhase(FixtureState state, ProtocolMessage message) { Gate(state, "VerifyReportedPhase"); }
      public override void StopOwnedJobs(FixtureState state) { Gate(state, "StopOwnedJobs"); state.jobsEmpty = true; if (state.subject != null) state.subject.exited = true; }
      public override bool HasOwnedSidProcesses(FixtureState state) { Gate(state, "HasOwnedSidProcesses"); return Fault == "unknown-sid-process" || Fault == "profile-admin-process"; }
      public override void CloseRuntimeResources(FixtureState state)
      {
        Gate(state, "CloseRuntimeResources"); if (state.channel != null) state.channel.Dispose();
        state.station = IntPtr.Zero; state.desktop = IntPtr.Zero; state.job = IntPtr.Zero;
        if (state.subject != null) { state.subject.process = IntPtr.Zero; state.subject.thread = IntPtr.Zero; }
      }
      public override void UnloadProfile(FixtureState state)
      {
        Gate(state, "UnloadProfile"); Assert(state.profileLoaded && state.profile != IntPtr.Zero, "unload only paired loaded hive");
        if (Fault != "unload-not-confirmed") { state.profileLoaded = false; state.profile = IntPtr.Zero; }
      }
      public override bool HivesAbsent(FixtureState state) { Gate(state, "HivesAbsent"); return Fault != "hive-still-mounted" && Fault != "profile-admin-hive"; }
      public override void DeleteOwnedProfile(FixtureState state)
      {
        Gate(state, "DeleteOwnedProfile"); Assert(!state.profileLoaded && state.profileCreationPin == null, "no loaded hive or restrictive pin crosses Delete");
        if (Fault != null && Fault.StartsWith("profile-admin-", StringComparison.Ordinal))
        {
          state.profileCreationUncertain = true;
          if (Fault == "profile-admin-cleanup-context") state.profileCreationTokenOwner = null;
          NativePlatform.ProfileDirectoryMetadata metadata = ProfileMetadata("S-1-5-32-544");
          NativePlatform.RequireFreshProfileOwner(metadata.ownerSid, TargetSid, state.profileCreationTokenOwner, state.profileCreationSucceeded, metadata);
          if (Fault == "profile-admin-cleanup-drift") throw new FixtureFailure("fake-cleanup-object-drift");
        }
        Assert(!state.profileDeleteAttempted, "Delete cannot retry"); state.profileDeleteAttempted = true; Calls.Add("DeleteProfileCall");
        if (Fault == "profile-admin-delete-failed") { state.profileCreationUncertain = true; throw new FixtureFailure("fake-DeleteProfile-failed"); }
        if (Fault != "delete-not-confirmed") { state.profileCreated = false; state.profileCreationUncertain = false; }
      }
      public override void DeleteOwnedAccount(FixtureState state) { Gate(state, "DeleteOwnedAccount"); VerifyOwnedAccount(state, true); Assert(!state.profileCreated, "do not delete account before profile"); Calls.Add("NetUserDelCall"); state.accountCreated = false; }
      public override void CloseTokenAndPrivileges(FixtureState state) { Gate(state, "CloseTokenAndPrivileges"); state.token = IntPtr.Zero; }
    }
  }
}
