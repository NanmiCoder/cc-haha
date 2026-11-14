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

    private static FileIdentity ProfilesDirectoryIdentity()
    {
      return new FileIdentity { canonicalPath = @"C:\Users", directory = true, fileId = "profiles-directory", volumePath = @"\\?\Volume{fixture}\" };
    }

    private static NativePlatform.ProfileDirectoryMetadata VolumeRootMetadata()
    {
      NativePlatform.ProfileDirectoryMetadata metadata = ProfileMetadata(NativePlatform.TrustedInstallerSid);
      metadata.identity.canonicalPath = @"C:\"; metadata.identity.fileId = "volume-root"; metadata.protectedDacl = false;
      metadata.aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = NativePlatform.TrustedInstallerSid, accessMask = 0x1f01ff, allow = true });
      return metadata;
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
      Case(report, "fake-trustedinstaller-is-only-an-exact-os-profiles-volume-root-ancestor", delegate {
        Assert(CorePolicy.HashText(NativePlatform.TrustedInstallerSid) == "b7dbc3c7788501b28d8487f2f34b21755e7c55868ed055d96ac262b6d49faad4", "fixed official TI SID must match the original readonly observation");
        FileIdentity profiles = ProfilesDirectoryIdentity();
        NativePlatform.ProfileDirectoryMetadata root = VolumeRootMetadata();
        root.aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = RunnerSid, accessMask = 4, allow = true });
        root.aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = RunnerSid, accessMask = 2, allow = true, inheritOnly = true });
        NativePlatform.RequireTrustedProfileAncestorDacl(root, TargetSid, profiles.canonicalPath, profiles.canonicalPath, profiles);
        Reject(delegate { NativePlatform.RequireTrustedProfileDacl(root, TargetSid, true); }, "ordinary parent checks have no OS ancestor role");
        NativePlatform.ProfileDirectoryMetadata profile = ProfileMetadata(NativePlatform.TrustedInstallerSid);
        Reject(delegate { NativePlatform.RequireFreshProfileOwner(profile.ownerSid, TargetSid); }, "TI is never a strict profile owner");
        Reject(delegate { NativePlatform.RequireFreshProfileOwner(profile.ownerSid, TargetSid, NativePlatform.TrustedInstallerSid, true, profile); }, "TI TokenOwner cannot become the Admin creation branch");
        root.protectedDacl = true;
        Reject(delegate { NativePlatform.RequireTrustedProfileDacl(root, TargetSid, false); }, "the profile DACL entry point cannot trust TI mutation ACEs");
        foreach (string fault in new string[] { "nonroot", "other-root", "other-path", "root-owner", "missing-context", "missing-file", "context-path", "context-reparse", "context-volume", "root-volume", "root-reparse", "root-file", "root-type" })
        {
          NativePlatform.ProfileDirectoryMetadata candidate = VolumeRootMetadata(); FileIdentity context = ProfilesDirectoryIdentity();
          if (fault == "nonroot") candidate.identity.canonicalPath = context.canonicalPath;
          if (fault == "other-root") candidate.identity.canonicalPath = @"D:\";
          if (fault == "other-path") candidate.identity.canonicalPath = @"C:\elsewhere";
          if (fault == "root-owner") candidate.ownerSid = "S-1-5-18";
          if (fault == "missing-context") context = null;
          if (fault == "missing-file") context.fileId = null;
          if (fault == "context-path") context.canonicalPath = @"C:\elsewhere";
          if (fault == "context-reparse") context.reparse = true;
          if (fault == "context-volume") context.volumePath += "-changed";
          if (fault == "root-volume") candidate.identity.volumePath += "-changed";
          if (fault == "root-reparse") candidate.identity.reparse = true;
          if (fault == "root-file") candidate.identity.fileId = null;
          if (fault == "root-type") candidate.identity.directory = false;
          Reject(delegate { NativePlatform.RequireTrustedProfileAncestorDacl(candidate, TargetSid, @"C:\Users", @"C:\Users", context); }, "root proof cannot be inferred from owner or an arbitrary path: " + fault);
        }
      });
      Case(report, "fake-trustedinstaller-volume-root-still-refuses-unsafe-or-unknown-dacl", delegate {
        FileIdentity profiles = ProfilesDirectoryIdentity();
        foreach (int mask in new int[] { 2, 16, 64, 256, 0x10000, 0x40000, 0x80000, 0x10000000, 0x40000000 })
        {
          NativePlatform.ProfileDirectoryMetadata root = VolumeRootMetadata();
          root.aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = RunnerSid, accessMask = mask, allow = false });
          root.aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = RunnerSid, accessMask = mask, allow = true });
          Reject(delegate { NativePlatform.RequireTrustedProfileAncestorDacl(root, TargetSid, @"C:\Users", @"C:\Users", profiles); }, "TI owner never masks a nontrusted mutation Allow");
        }
        foreach (string fault in new string[] { "missing", "null", "empty", "large", "revision", "unknown-ace", "missing-sid", "unknown-mask", "ti-unknown-ace", "ti-unknown-mask" })
        {
          NativePlatform.ProfileDirectoryMetadata root = VolumeRootMetadata();
          if (fault == "missing") root.daclPresent = false;
          if (fault == "null") root.aces = null;
          if (fault == "empty") root.aces.Clear();
          if (fault == "large") while (root.aces.Count <= 128) root.aces.Add(root.aces[0]);
          if (fault == "revision") root.aclRevision = 255;
          if (fault == "unknown-ace") root.aces[0].unclassified = true;
          if (fault == "missing-sid") root.aces[0].sid = null;
          if (fault == "unknown-mask") root.aces[0].accessMask = 0x2000000;
          if (fault == "ti-unknown-ace") root.aces.Last().unclassified = true;
          if (fault == "ti-unknown-mask") root.aces.Last().accessMask = 0x2000000;
          Reject(delegate { NativePlatform.RequireTrustedProfileAncestorDacl(root, TargetSid, @"C:\Users", @"C:\Users", profiles); }, "TI root keeps structured DACL refusal: " + fault);
        }
      });
      Case(report, "fake-ace-observations-separate-parent-creation-and-profile-inherit-only-writes", delegate {
        NativePlatform.ProfileDirectoryMetadata parent = ProfileMetadata("S-1-5-18"); parent.protectedDacl = false;
        parent.aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = RunnerSid, accessMask = 4, allow = true });
        parent.aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = RunnerSid, accessMask = 2, allow = true, inheritOnly = true });
        parent.aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = RunnerSid, accessMask = 2, allow = false });
        NativePlatform.RequireTrustedProfileDacl(parent, TargetSid, true);
        IList<string> rows = NativePlatform.ProfileAceObservations(parent, TargetSid);
        Assert(rows[3].Contains("parentMutation=00000000") && rows[3].Contains("profileMutation=00000004") && rows[3].Contains("parentApplies=True"), "create-only mask is not parent replacement permission");
        Assert(rows[4].Contains("parentMutation=00000002") && rows[4].Contains("inheritOnly=True") && rows[4].Contains("parentApplies=False"), "inherit-only does not apply to the parent itself");
        Assert(rows[5].Contains("kind=deny") && rows[5].Contains("parentApplies=False"), "deny masks are observable but do not grant mutation");
        parent.protectedDacl = true;
        Reject(delegate { NativePlatform.RequireTrustedProfileDacl(parent, TargetSid, false); }, "create-only and inherit-only writes remain dangerous inside a profile");
        NativePlatform.ProfileDirectoryMetadata root = VolumeRootMetadata();
        root.aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = RunnerSid, accessMask = 0x2000000, allow = true });
        root.aces.Add(null);
        root.aces.Add(new NativePlatform.ProfileDiagnosticAce { sid = new String('x', 185), unclassified = true });
        rows = NativePlatform.ProfileAceObservations(root, TargetSid);
        Assert(rows[3].Contains("class=trusted-installer") && rows[3].Contains("sidSha256=b7dbc3c7788501b28d8487f2f34b21755e7c55868ed055d96ac262b6d49faad4"), "fixed SID class and hash are read-only facts");
        Assert(rows[4].Contains("unknown=True") && rows[5].Contains("unknown=True") && rows[6].Contains("sidSha256=unproven"), "unknown masks ACEs and unbounded SIDs stay unknown");
        foreach (string row in rows) Assert(row.Length < 512 && row.IndexOf('\n') < 0 && !row.Contains("S-1-") && !row.Contains(new String('x', 185)), "bounded diagnostics cannot dump SID ACL text or arbitrary values");
        while (root.aces.Count <= 128) root.aces.Add(root.aces[0]);
        Assert(NativePlatform.ProfileAceObservations(root, TargetSid).Single() == "ace-scan=unproven; unknown=true", "unbounded ACL diagnostics refuse rather than enumerate");
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

    private static FixtureSpec F1PreparedSpec()
    {
      Func<string, F1BlobPin> blob = name => new F1BlobPin { file = @"C:\FixtureInputs\" + name, bytes = 1024, sha256 = new String('b', 64) };
      FixtureSpec spec = new FixtureSpec {
        version = 1, mode = F1Policy.ControllerMode, executionStage = "F1", realExecutionAdmitted = false,
        runId = "52f4ce19-5ded-4b27-8268-a2840809e0ca", owner = "codex:local:01a1c9a5-381e-7b33-9648-c8968b61de4c", generation = 1,
        gitRoot = @"D:\source\cc-haha", sourceRoot = @"C:\FixtureInputs\sources", controllerRoot = @"C:\FixtureController\f1-new",
        setupPath = @"C:\FixtureInputs\old-setup.exe", output = @"C:\FixtureController\f1-new\result.json",
        nonce = new String('a', 32), expectedBinarySha256 = new String('a', 64), frozenPlanManifestSha256 = F1Policy.PlanHash,
        argvEnvPlanSha256 = F1Policy.EnvironmentHash,
        sourcePins = CorePolicy.SourceNames.Select(name => new SourcePin { file = name, sha256 = new String('a', 64) }).ToList(),
        f1 = new F1InputBindings { version = 1, status = "proposed", activationHead = null,
          candidateSourceHead = new String('c', 40), stageASourceHead = new String('d', 40), stageARunId = 1, stageAArtifactId = 2,
          fixtureBytes = 1000, stageAArtifactSha256 = new String('e', 64), stageAReceipt = blob("stage-a.json"), oldMemberReceipt = blob("old-member.json"),
          newPackage = new F1PackagePin { sourceHead = new String('c', 40), displayVersion = "0.7.8",
            setup = new F1BlobPin { file = @"C:\FixtureInputs\new-full-setup.exe", bytes = 200000000, sha256 = new String('f', 64) },
            buildReceipt = blob("new-build.json"), memberReceipt = blob("new-member.json"), archiveLiteral = "$R0\\Uninstall Claude Code Haha.exe",
            uninstallerBytes = 180000, uninstallerSha256 = new String('c', 64), guardedRemovalBytes = 40000, guardedRemovalSha256 = new String('9', 64),
            payloads = new List<F1PayloadPin> {
              new F1PayloadPin { kind = "app-exe", relativePath = "Claude Code Haha.exe", bytes = 1000, sha256 = new String('1', 64) },
              new F1PayloadPin { kind = "app-asar", relativePath = @"resources\app.asar", bytes = 1000, sha256 = new String('2', 64) },
              new F1PayloadPin { kind = "sidecar", relativePath = @"resources\sidecars\claude-sidecar.exe", bytes = 1000, sha256 = new String('3', 64) }
            } }
        }
      }; return spec;
    }

    private static F1AuditEvidence F1ReplayAudit(FixtureSpec spec, string phase)
    {
      F1AuditEvidence a = new F1AuditEvidence { status = "replay-complete", phase = phase, nonce = spec.nonce,
        specSha256 = new String('b', 64), rootPid = 17, rootCreationTime = "123456789", fileWriteRestoreCalibrated = true,
        registrySetRestoreCalibrated = true, calibrationFinalStateEqual = true, mapsComplete = true, rootsAndRegistryParentsComplete = true,
        stagingIdentityCoverage = true, allPeJobsNaturallyExited = true, closed = true, armedSequence = 1, ackSequence = 10, endSequence = 40,
        oldUninstallerExitCode = 22, oldUninstallerExit22Sequence = 12, trustedRemovalStartSequence = 15, oldUninstallerSha256 = CorePolicy.UninstallerHash,
        trustedRemovalSha256 = spec.f1.newPackage.guardedRemovalSha256 };
      if (phase == "guarded-new-upgrade")
      {
        a.oldPayloadObjects.AddRange(new string[] { new String('1', 64), new String('2', 64) });
        a.oldRegistryObjects.AddRange(new string[] { new String('3', 64), new String('4', 64) });
        long sequence = 20;
        foreach (string id in a.oldPayloadObjects) a.operations.Add(new F1AuditOperation { resultKnown = true, succeeded = true, objectRetired = true, sequence = sequence++, kind = "delete", scope = "old-payload", objectId = id });
        foreach (string id in a.oldRegistryObjects) a.operations.Add(new F1AuditOperation { resultKnown = true, succeeded = true, objectRetired = true, sequence = sequence++, kind = "delete", scope = "old-registry", objectId = id });
        a.operations.Add(new F1AuditOperation { resultKnown = true, succeeded = true, objectRetired = true, sequence = sequence++, kind = "create", scope = "new-payload", objectId = new String('5', 64) });
        a.operations.Add(new F1AuditOperation { resultKnown = true, succeeded = true, objectRetired = true, sequence = sequence++, kind = "create", scope = "new-registry", objectId = new String('6', 64) });
      }
      return a;
    }

    private sealed class F1ReplayLease : F1AuditLease
    {
      private readonly F1AuditEvidence arming, completed;
      internal int disposeCount, ackCount, queryCount;
      internal bool throwDispose, throwClosureQuery, closeBeforeThrow;
      private bool closed;
      internal F1ReplayLease(FixtureSpec spec, string phase)
      {
        completed = F1ReplayAudit(spec, phase); arming = F1ReplayAudit(spec, phase); arming.status = "armed"; arming.ackSequence = 0;
      }
      public override F1AuditEvidence Arming { get { return arming; } }
      public override bool AllResourcesKnownClosed { get { queryCount++; if (throwClosureQuery) throw new FixtureFailure("f1-replay-closure-query-unknown"); return closed; } }
      public override void BeforeAck() { ackCount++; }
      public override F1AuditEvidence Complete() { return completed; }
      public override void Dispose() { disposeCount++; if (closeBeforeThrow) closed = true; if (throwDispose) throw new FixtureFailure("f1-replay-dispose-unknown"); closed = true; }
    }

    private static ProtocolMessage F1Start(string phase)
    {
      return new ProtocolMessage { phase = phase, pid = 17, creationTime = "123456789" };
    }
    private static ProtocolMessage F1End(string phase)
    {
      return new ProtocolMessage { phase = phase, evidence = new PhaseEvidence { phase = phase, payloadRemoved = true,
        registrationRemoved = true, keptDataUnchanged = true, oldStateEquivalent = true, newPackageInstalled = true,
        legacyOnlyCanaryRemoved = true, helperAlive = true, shortcutTargetsUnchanged = true } };
    }

    private static void RunF1PureTests(FixtureReport report)
    {
      Case(report, "f1-proposed-inputs-bind-full-current-package-without-version-bump-or-activation", delegate {
        FixtureSpec spec = F1PreparedSpec(); F1Policy.ValidatePrepared(spec, false);
        Assert(spec.f1.newPackage.displayVersion == "0.7.8" && spec.f1.activationHead == null && !spec.realExecutionAdmitted, "same version is allowed but never an admission");
        Reject(delegate { F1Policy.RequireNativeAdmission(spec, true); }, "proposed data is not a native grant");
        spec.realExecutionAdmitted = true; spec.f1.status = "admitted"; spec.f1.activationHead = new String('a', 40);
        Reject(delegate { F1Policy.RequireNativeAdmission(spec, false); }, "missing native audit stops before SID budget");
      });
      foreach (string fault in new string[] { "old-mode", "profile-only", "plan", "activation", "head", "stage-a", "tiny-setup", "old-setup", "old-uninstaller", "missing-helper", "payload-traversal", "missing-asar", "missing-sidecar" })
        Case(report, "f1-rejects-unbound-input-" + fault, delegate {
          FixtureSpec s = F1PreparedSpec();
          if (fault == "old-mode") s.mode = "historical-v078-controller";
          if (fault == "profile-only") { s.mode = "createprofile-only-controller"; s.executionStage = "profile-only"; }
          if (fault == "plan") s.frozenPlanManifestSha256 = CorePolicy.PlanHash;
          if (fault == "activation") s.f1.activationHead = new String('a', 40);
          if (fault == "head") s.f1.newPackage.sourceHead = new String('e', 40);
          if (fault == "stage-a") s.f1.stageAArtifactId = 0;
          if (fault == "tiny-setup") s.f1.newPackage.setup.bytes = 65536;
          if (fault == "old-setup") s.f1.newPackage.setup.sha256 = CorePolicy.SetupHash;
          if (fault == "old-uninstaller") s.f1.newPackage.uninstallerSha256 = CorePolicy.UninstallerHash;
          if (fault == "missing-helper") s.f1.newPackage.guardedRemovalSha256 = null;
          if (fault == "payload-traversal") s.f1.newPackage.payloads[0].relativePath = @"..\outside.exe";
          if (fault == "missing-asar") s.f1.newPackage.payloads[1].kind = "payload";
          if (fault == "missing-sidecar") s.f1.newPackage.payloads[2].kind = "payload";
          Reject(delegate { F1Policy.ValidatePrepared(s, false); }, "every bound input is independent: " + fault);
        });
      Case(report, "f1-subject-accepts-only-new-owned-readonly-input-copies", delegate {
        FixtureSpec s = F1PreparedSpec(); KnownPaths paths = Paths(); string input = Path.Combine(s.controllerRoot, "subject-input");
        s.mode = F1Policy.SubjectMode; s.profilePath = paths.profile; s.knownPaths = paths;
        s.expectedSid = "S-1-5-21-1-2-3-4001"; s.expectedControllerSid = "S-1-5-21-1-2-3-1000"; s.expectedControllerPid = 101; s.expectedControllerCreationTime = "1";
        s.fixtureRoot = Path.Combine(paths.local, "CcHaha1879Fixture", s.nonce); s.tempRoot = Path.Combine(s.fixtureRoot, "temp");
        s.installRoot = Path.Combine(paths.userPrograms, "Claude Code Haha"); s.uninstallerCopy = Path.Combine(s.fixtureRoot, "old-uninstaller.exe");
        s.output = Path.Combine(s.fixtureRoot, "subject-result.json"); s.subjectSpecPath = Path.Combine(input, "subject.json");
        s.sourceRoot = Path.Combine(input, "sources"); s.setupPath = Path.Combine(input, "old-setup.exe");
        s.f1.stageAReceipt.file = Path.Combine(input, "f1-stage-a-receipt.json"); s.f1.oldMemberReceipt.file = Path.Combine(input, "f1-old-member-proof.json");
        s.f1.newPackage.buildReceipt.file = Path.Combine(input, "f1-build-receipt.json"); s.f1.newPackage.memberReceipt.file = Path.Combine(input, "f1-new-member-proof.json");
        s.f1.newPackage.setup.file = Path.Combine(input, "f1-new-full-setup.exe"); s.pipeName = "CcHaha1879-" + s.nonce;
        s.hiveKey = @"Software\CcHaha1879Fixture\" + s.nonce; s.hiveNonce = new String('b', 32); s.desktopName = "CcHaha1879-f1\\fixture";
        F1Policy.ValidatePrepared(s, true); s.f1.newPackage.setup.file = @"C:\outside\new-setup.exe";
        Reject(delegate { F1Policy.ValidatePrepared(s, true); }, "a subject cannot substitute an input path after readonly copy");
      });
      Case(report, "f1-bound-metadata-survives-only-readonly-input-relocation", delegate {
        FixtureSpec spec = F1PreparedSpec(); string hash = F1Policy.BindingHash(spec);
        spec.sourceRoot = @"C:\FixtureController\f1-new\subject-input\sources";
        spec.setupPath = @"C:\FixtureController\f1-new\subject-input\old-setup.exe";
        spec.f1.newPackage.setup.file = @"C:\FixtureController\f1-new\subject-input\new-setup.exe";
        Assert(F1Policy.BindingHash(spec) == hash, "Native may copy exactly pinned bytes without altering reviewed metadata");
        spec.f1.newPackage.setup.sha256 = new String('8', 64);
        Assert(F1Policy.BindingHash(spec) != hash, "relocation cannot silently substitute package bytes");
        spec = F1PreparedSpec(); spec.f1.version = 2;
        Assert(F1Policy.BindingHash(spec) != hash, "schema versions are bound too");
      });
      Case(report, "f1-transient-write-restore-is-rejected-even-with-equal-snapshots", delegate {
        F1AuditEvidence a = F1ReplayAudit(F1PreparedSpec(), "old22-negative");
        a.operations.Add(new F1AuditOperation { resultKnown = true, succeeded = true, objectRetired = true, sequence = 20, kind = "write", scope = "kept-data", objectId = new String('1', 64) });
        a.operations.Add(new F1AuditOperation { resultKnown = true, succeeded = true, objectRetired = true, sequence = 21, kind = "write", scope = "kept-data", objectId = new String('1', 64) });
        Assert(a.calibrationFinalStateEqual, "positive calibration restores final bytes");
        Reject(delegate { F1Policy.RequireCompleteAudit(a, "old22-negative", false); }, "final equality cannot hide any protected write");
      });
      foreach (string fault in new string[] { "file-calibration", "registry-calibration", "maps", "parents", "gap", "events-lost", "buffers-lost", "job-alive", "not-closed", "ack-order", "unknown-kind", "unknown-scope", "native-claim" })
        Case(report, "f1-audit-fails-closed-" + fault, delegate {
          F1AuditEvidence a = F1ReplayAudit(F1PreparedSpec(), "old22-negative");
          if (fault == "file-calibration") a.fileWriteRestoreCalibrated = false;
          if (fault == "registry-calibration") a.registrySetRestoreCalibrated = false;
          if (fault == "maps") a.mapsComplete = false;
          if (fault == "parents") a.rootsAndRegistryParentsComplete = false;
          if (fault == "gap") a.gap = true;
          if (fault == "events-lost") a.eventsLost = 1;
          if (fault == "buffers-lost") a.buffersLost = 1;
          if (fault == "job-alive") a.allPeJobsNaturallyExited = false;
          if (fault == "not-closed") a.closed = false;
          if (fault == "ack-order") a.ackSequence = a.armedSequence;
          if (fault == "unknown-kind" || fault == "unknown-scope") a.operations.Add(new F1AuditOperation { resultKnown = true, succeeded = true, objectRetired = true, sequence = 20, kind = fault == "unknown-kind" ? "unknown" : "read", scope = fault == "unknown-scope" ? "unknown" : "old-payload", objectId = new String('1', 64) });
          Reject(delegate { F1Policy.RequireCompleteAudit(a, "old22-negative", fault == "native-claim"); }, "unknown streams never become native proof: " + fault);
        });
      Case(report, "f1-upgrade-replay-requires-old-payload-and-registry-deletion-before-new-creation", delegate {
        F1Policy.RequireCompleteAudit(F1ReplayAudit(F1PreparedSpec(), "guarded-new-upgrade"), "guarded-new-upgrade", false);
      });
      foreach (string fault in new string[] { "registry-overwrite-only", "payload-overwrite-only", "rename-only", "new-before-delete", "kept-write", "shortcut-during-removal", "old22-missing", "wrong-old-exit", "wrong-old-pe", "component-before-old22", "staging-gap", "failed-delete", "pending-delete", "unknown-result" })
        Case(report, "f1-upgrade-order-rejects-" + fault, delegate {
          F1AuditEvidence a = F1ReplayAudit(F1PreparedSpec(), "guarded-new-upgrade");
          if (fault == "registry-overwrite-only") a.operations.RemoveAll(op => op.scope == "old-registry");
          if (fault == "payload-overwrite-only") a.operations.RemoveAll(op => op.scope == "old-payload");
          if (fault == "rename-only") foreach (F1AuditOperation op in a.operations.Where(op => op.scope == "old-payload")) op.kind = "rename";
          if (fault == "new-before-delete") { a.operations[0].scope = "new-payload"; a.operations[0].kind = "create"; }
          if (fault == "kept-write" || fault == "shortcut-during-removal") a.operations.Insert(0, new F1AuditOperation { resultKnown = true, succeeded = true, objectRetired = true, sequence = 19, kind = "write", scope = fault == "kept-write" ? "kept-data" : "shortcut", objectId = new String('8', 64) });
          if (fault == "old22-missing") a.oldUninstallerExit22Sequence = 0;
          if (fault == "wrong-old-exit") a.oldUninstallerExitCode = 0;
          if (fault == "wrong-old-pe") a.oldUninstallerSha256 = new String('8', 64);
          if (fault == "component-before-old22") a.trustedRemovalStartSequence = 11;
          if (fault == "staging-gap") a.stagingIdentityCoverage = false;
          if (fault == "failed-delete") a.operations[0].succeeded = false;
          if (fault == "pending-delete") a.operations[0].objectRetired = false;
          if (fault == "unknown-result") a.operations[0].resultKnown = false;
          Reject(delegate { F1Policy.RequireCompleteAudit(a, "guarded-new-upgrade", false); }, "post-state cannot prove a missing removal: " + fault);
        });
      Case(report, "f1-ordered-phase-replay-arms-before-ack-and-keeps-native-report-unpromoted", delegate {
        FixtureSpec spec = F1PreparedSpec(); List<F1ReplayLease> audits = new List<F1ReplayLease>();
        using (F1PhaseState state = new F1PhaseState(spec, new String('b', 64), false))
        {
          foreach (string phase in F1Policy.Phases)
          {
            F1ReplayLease audit = F1Policy.Audited(phase) ? new F1ReplayLease(spec, phase) : null;
            if (audit != null) audits.Add(audit);
            state.Prepare(F1Start(phase), audit); state.BeforeAck(); state.Complete(F1End(phase));
          }
          state.RequireFinished();
        }
        Assert(audits.Count == 2 && audits.All(a => a.ackCount == 1 && a.disposeCount == 1 && a.AllResourcesKnownClosed), "two isolated audit leases close once");
        Assert(report.member_proven == "not_run" && report.old22_before_protected_mutation == "not_run" && report.full_old_to_new == "not_run", "pure replay cannot promote native F1");
      });
      Case(report, "f1-unknown-arming-and-wrong-phase-close-without-ack", delegate {
        FixtureSpec spec = F1PreparedSpec(); F1ReplayLease lease = new F1ReplayLease(spec, "old22-negative");
        using (F1PhaseState state = new F1PhaseState(spec, new String('b', 64), false))
          Reject(delegate { state.Prepare(F1Start("old22-negative"), lease); }, "cannot skip earlier verified phases");
        Assert(lease.disposeCount == 1 && lease.ackCount == 0 && lease.AllResourcesKnownClosed, "rejected lease is closed before any ACK");
      });
      Case(report, "f1-audit-close-failure-preserves-first-proof-failure-and-unknown-resources", delegate {
        FixtureSpec spec = F1PreparedSpec(); F1ReplayLease lease = new F1ReplayLease(spec, "old22-negative");
        lease.throwDispose = true; F1AuditEvidence a = lease.Complete();
        a.operations.Add(new F1AuditOperation { resultKnown = true, succeeded = true, objectRetired = true, sequence = 20, kind = "write", scope = "old-registry", objectId = new String('1', 64) });
        using (F1PhaseState state = new F1PhaseState(spec, new String('b', 64), false))
        {
          foreach (string phase in F1Policy.Phases.TakeWhile(phase => phase != "old22-negative")) { state.Prepare(F1Start(phase), null); state.BeforeAck(); state.Complete(F1End(phase)); }
          state.Prepare(F1Start("old22-negative"), lease); state.BeforeAck();
          string first = null; try { state.Complete(F1End("old22-negative")); } catch (FixtureFailure failure) { first = failure.Message; }
          Assert(first == "f1-old22-no-protected-mutation-observed" && !lease.AllResourcesKnownClosed && lease.disposeCount == 1,
            "proof failure remains primary, uncertain audit closure cannot be called cleaned");
        }
      });
      Case(report, "f1-no-completion-before-ack-or-duplicate-ack", delegate {
        FixtureSpec spec = F1PreparedSpec();
        using (F1PhaseState state = new F1PhaseState(spec, new String('b', 64), false))
        {
          state.Prepare(F1Start(F1Policy.Phases[0]), null);
          Reject(delegate { state.Complete(F1End(F1Policy.Phases[0])); }, "suspended child cannot finish before ACK");
          state.BeforeAck(); Reject(delegate { state.BeforeAck(); }, "one ACK attempt only");
          state.Complete(F1End(F1Policy.Phases[0])); Reject(delegate { state.RequireFinished(); }, "partial phase history is not F1");
        }
      });
    }

    private static ProtectedSnapshot F1RebuildSnapshot(string payloadIdentity)
    {
      ProtectedSnapshot snapshot = new ProtectedSnapshot();
      snapshot.values["payload/@directory"] = payloadIdentity + "-directory";
      snapshot.values["payload/app.bin"] = payloadIdentity + "-file:4:" + new String('a', 64);
      snapshot.rebuildPayloadEntries["payload/@directory"] = new RebuiltPayloadEntry { kind = "directory" };
      snapshot.rebuildPayloadEntries["payload/app.bin"] = new RebuiltPayloadEntry { kind = "file", bytes = 4, sha256 = new String('a', 64) };
      snapshot.values["registry/Registry32/product/@key"] = "present";
      snapshot.values["registry/Registry32/product/Version"] = "String:0.7.8";
      snapshot.values["registry/Registry64/product/@key"] = "present";
      snapshot.values["registry/Registry64/product/Flag"] = "DWord:1";
      snapshot.values["claude/@directory"] = "kept-directory";
      snapshot.values["claude/settings.json"] = "kept-file:4:" + new String('b', 64);
      snapshot.values["updater/@directory"] = "kept-updater";
      snapshot.values["desktop/CcHaha1879-canary.txt"] = "kept-canary:4:" + new String('c', 64);
      snapshot.values["claude/Claude Code Haha.lnk"] = "kept-user-link:4:" + new String('d', 64);
      foreach (string location in new string[] { "desktop", "programs" })
      {
        string shortcut = location + "/Claude Code Haha.lnk";
        snapshot.values[shortcut] = payloadIdentity + "-rewritten-link:100:" + new String(payloadIdentity == "old" ? 'e' : 'f', 64);
        snapshot.verifiedProductShortcutTargets[shortcut] = @"C:\OwnedInstall\Claude Code Haha.exe";
      }
      return snapshot;
    }

    private static void RunF1RebuildTests(FixtureReport report)
    {
      Case(report, "f1-rebuild-accepts-new-payload-identities-and-rewritten-product-links-only", delegate {
        ProtectedSnapshot original = F1RebuildSnapshot("old"), rebuilt = F1RebuildSnapshot("new");
        Assert(!original.Same(rebuilt), "negative Same retains original payload and shortcut identities/bytes");
        Assert(original.SameRebuiltInstallation(rebuilt, @"C:\OwnedInstall\Claude Code Haha.exe"), "rebuild compares actual inventory/content and verified product targets");
      });
      foreach (string fault in new string[] { "missing", "extra", "type", "bytes", "hash", "unknown", "unmapped-payload", "kept-id", "kept-bytes",
        "canary", "updater", "user-link", "registry-kind", "registry-data", "registry-missing", "registry-extra", "shortcut-target", "shortcut-unverified", "shortcut-missing" })
        Case(report, "f1-rebuild-rejects-" + fault, delegate {
          ProtectedSnapshot original = F1RebuildSnapshot("old"), rebuilt = F1RebuildSnapshot("new");
          if (fault == "missing") { rebuilt.values.Remove("payload/app.bin"); rebuilt.rebuildPayloadEntries.Remove("payload/app.bin"); }
          if (fault == "extra") { rebuilt.values["payload/extra.bin"] = "new-extra:4:" + new String('a', 64); rebuilt.rebuildPayloadEntries["payload/extra.bin"] = new RebuiltPayloadEntry { kind = "file", bytes = 4, sha256 = new String('a', 64) }; }
          if (fault == "type") rebuilt.rebuildPayloadEntries["payload/app.bin"] = new RebuiltPayloadEntry { kind = "directory" };
          if (fault == "bytes") rebuilt.rebuildPayloadEntries["payload/app.bin"].bytes++;
          if (fault == "hash") rebuilt.rebuildPayloadEntries["payload/app.bin"].sha256 = new String('b', 64);
          if (fault == "unknown") rebuilt.rebuildPayloadEntries["payload/app.bin"].kind = "unknown";
          if (fault == "unmapped-payload") { original.rebuildPayloadEntries.Remove("payload/app.bin"); rebuilt.rebuildPayloadEntries.Remove("payload/app.bin"); }
          if (fault == "kept-id") rebuilt.values["claude/@directory"] += "-new";
          if (fault == "kept-bytes") rebuilt.values["claude/settings.json"] += "-changed";
          if (fault == "canary") rebuilt.values["desktop/CcHaha1879-canary.txt"] += "-changed";
          if (fault == "updater") rebuilt.values["updater/@directory"] += "-changed";
          if (fault == "user-link") rebuilt.values["claude/Claude Code Haha.lnk"] += "-changed";
          if (fault == "registry-kind") rebuilt.values["registry/Registry64/product/Flag"] = "String:1";
          if (fault == "registry-data") rebuilt.values["registry/Registry64/product/Flag"] = "DWord:2";
          if (fault == "registry-missing") rebuilt.values.Remove("registry/Registry64/product/@key");
          if (fault == "registry-extra") rebuilt.values["registry/Registry32/product/Unexpected"] = "String:extra";
          if (fault == "shortcut-target") rebuilt.verifiedProductShortcutTargets["desktop/Claude Code Haha.lnk"] = @"C:\Other\Claude Code Haha.exe";
          if (fault == "shortcut-unverified") rebuilt.verifiedProductShortcutTargets.Remove("desktop/Claude Code Haha.lnk");
          if (fault == "shortcut-missing") rebuilt.values["desktop/Claude Code Haha.lnk"] = "absent";
          Assert(!original.SameRebuiltInstallation(rebuilt, @"C:\OwnedInstall\Claude Code Haha.exe"), "rebuild must not broaden retained or logical facts: " + fault);
        });
    }

    private static void RunF1ClosureTests(FixtureReport report)
    {
      foreach (bool disposeThrows in new bool[] { false, true })
        Case(report, "f1-proof-remains-first-with-throwing-closure-query-dispose-" + disposeThrows, delegate {
          FixtureSpec spec = F1PreparedSpec();
          F1ReplayLease lease = new F1ReplayLease(spec, "old22-negative") { throwDispose = disposeThrows, throwClosureQuery = true };
          lease.Complete().operations.Add(new F1AuditOperation { resultKnown = true, succeeded = true, objectRetired = true, sequence = 20, kind = "write", scope = "old-registry", objectId = new String('1', 64) });
          using (F1PhaseState state = new F1PhaseState(spec, new String('b', 64), false))
          {
            foreach (string phase in F1Policy.Phases.TakeWhile(phase => phase != "old22-negative")) { state.Prepare(F1Start(phase), null); state.BeforeAck(); state.Complete(F1End(phase)); }
            state.Prepare(F1Start("old22-negative"), lease); state.BeforeAck();
            string first = null; try { state.Complete(F1End("old22-negative")); } catch (FixtureFailure error) { first = error.Message; }
            Assert(first == "f1-old22-no-protected-mutation-observed" && lease.disposeCount == 1 && lease.ClosureFailed, "closure/dispose must preserve first proof failure and unknown state without disposal retry");
          }
        });
      Case(report, "f1-dispose-failure-latches-unknown-even-if-a-later-query-says-closed", delegate {
        FixtureSpec spec = F1PreparedSpec(); F1ReplayLease lease = new F1ReplayLease(spec, "old22-negative") { throwDispose = true, closeBeforeThrow = true };
        using (F1PhaseState state = new F1PhaseState(spec, new String('b', 64), false))
        {
          foreach (string phase in F1Policy.Phases.TakeWhile(phase => phase != "old22-negative")) { state.Prepare(F1Start(phase), null); state.BeforeAck(); state.Complete(F1End(phase)); }
          state.Prepare(F1Start("old22-negative"), lease); state.BeforeAck();
          Reject(delegate { state.Complete(F1End("old22-negative")); }, "a failed resource close is a phase failure");
          Assert(lease.AllResourcesKnownClosed && lease.ClosureFailed && lease.disposeCount == 1, "a later getter cannot clear the original closure exception");
        }
      });
    }

    public static void Run(FixtureReport report)
    {
      RunF1RebuildTests(report);
      RunF1ClosureTests(report);
      RunF1PureTests(report);
      RunF1NativeSliceTests(report);
      RunF1SafetyFixTests(report);
      RunF1CanaryDiagnosticContractTests(report);
      RunF1CanaryRuntimeFixTests(report);
      Case(report, "fake-f1-unavailable-audit-denies-before-account-and-profile", delegate {
        FakePlatform api = new FakePlatform(); FixtureState state = Execute(api, F1PreparedSpec());
        Assert(state.report.status == "failed" && !api.Calls.Contains("CreateDisabledAccount") && !api.Calls.Contains("CreateFreshProfile")
          && !api.Calls.Contains("Logon") && !api.Calls.Contains("LoadProfile"), "proposed F1 consumes no SID or profile budget");
        AssertNoNativePromotion(state);
      });
      Case(report, "fake-f1-unknown-audit-resource-retains-profile-disabled-without-unload-or-delete", delegate {
        FakePlatform api = new FakePlatform { Fault = "f1-audit-cleanup-unknown" }; FixtureState state = Execute(api, Spec());
        Assert(state.report.status == "failed" && state.accountDisabled && !api.Calls.Contains("UnloadProfile")
          && !api.Calls.Contains("DeleteOwnedProfile") && !api.Calls.Contains("DeleteOwnedAccount"), "unknown audit resources permit disable-only cleanup");
        AssertNoNativePromotion(state);
      });
      foreach (string fault in new string[] { "f1-audit-closure-query-throw", "f1-audit-dispose-and-query-throw" })
        Case(report, "fake-" + fault + "-still-disables-and-retains", delegate {
          FakePlatform api = new FakePlatform { Fault = fault }; FixtureState state = Execute(api, Spec());
          Assert(state.report.status == "failed" && state.accountDisabled && state.f1AuditResourceUncertain
            && api.Calls.Contains("StopOwnedJobs") && api.Calls.Contains("CloseRuntimeResources") && api.Calls.Contains("DisableAccount")
            && !api.Calls.Contains("UnloadProfile") && !api.Calls.Contains("DeleteOwnedProfile") && !api.Calls.Contains("DeleteOwnedAccount"), "getter/dispose exception cannot bypass disable-only cleanup");
          Assert(state.report.checks.First(check => check.status == "failed").detail == "subject-complete", "first subject/proof failure remains first");
          Assert(((F1ReplayLease)state.f1AuditLeases.Single()).disposeCount == 1, "finally does not repeat a failed Dispose");
          AssertNoNativePromotion(state);
        });
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
      foreach (string fault in new string[] { "token-query", "token-missing", "token-different", "create-failed", "owner-missing", "owner-other", "owner-trustedinstaller",
        "dacl-null", "dacl-unprotected", "dacl-unknown", "dacl-write", "parent-owner", "parent-replace", "view32", "view64",
        "reparse", "file-drift", "volume-drift", "hive", "process", "pin-close", "parent-trustedinstaller" })
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
        if (api.Fault == "f1-audit-cleanup-unknown") { state.f1AuditResourceUncertain = true; state.f1AuditArmOutcomeUnknown = true; }
        bool auditClosureFault = api.Fault == "f1-audit-closure-query-throw" || api.Fault == "f1-audit-dispose-and-query-throw";
        if (auditClosureFault)
        {
          state.f1AuditResourceUncertain = true;
          F1ReplayLease lease = new F1ReplayLease(F1PreparedSpec(), "old22-negative") { throwClosureQuery = true, throwDispose = api.Fault == "f1-audit-dispose-and-query-throw" };
          state.f1AuditLeases.Add(lease);
          try { lease.Dispose(); } catch (FixtureFailure) { lease.RecordClosureFailure(); }
        }
        return CoreJson.Serialize(new ProtocolMessage { kind = "complete", nonce = api.Fault == "complete-nonce" ? "wrong" : state.spec.nonce,
          report = new FixtureReport { status = api.Fault == "complete-failed" || auditClosureFault ? "failed" : "passed",
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


    private sealed class F1ReplayDebugApi : F1DebugApi
    {
      internal readonly Queue<F1DebugRecord> events = new Queue<F1DebugRecord>();
      internal readonly List<string> calls = new List<string>();
      internal bool empty, terminated, pending, throwContinue, throwTerminate, throwDispose, emptyOnTerminate, throwAbortWait;
      public F1DebugRecord Wait(int milliseconds) { calls.Add("wait"); if (events.Count == 0) return null; pending = true; return events.Dequeue(); }
      public F1DebugNotice Capture(F1DebugRecord e) { calls.Add("capture:" + e.pid); return new F1DebugNotice { pid = e.pid, tid = e.tid, creationTime = "epoch-" + e.pid, image = new FileIdentity { sha256 = new String('a', 64) } }; }
      public void CloseImage(F1DebugRecord e) { if (e != null && e.file != IntPtr.Zero) { calls.Add("close-image"); e.file = IntPtr.Zero; } }
      public void Continue(F1DebugRecord e, uint disposition) { calls.Add("continue:" + e.code); if (throwContinue) throw new FixtureFailure("replay-continue-failed"); pending = false; if (events.Count == 0 && e.code == 5) empty = true; }
      public void TerminateOwnedJob() { calls.Add("terminate-owned-job"); if (throwTerminate) throw new FixtureFailure("replay-termination-unknown"); terminated = true; if (emptyOnTerminate) empty = true; }
      public bool JobEmpty { get { return empty; } }
      public void WaitNaturalExit(int milliseconds) { Assert(!pending && empty, "kernel wait must follow continued EXIT"); calls.Add("natural-wait"); }
      public void WaitTerminatedExit(int milliseconds) { calls.Add("abort-wait"); Assert(!pending && empty && (!emptyOnTerminate || calls.Contains("continue:5")), "abort kernel wait must follow continued EXIT"); if (throwAbortWait) throw new FixtureFailure("replay-abort-kernel-exit-unknown"); }
      public void Dispose() { calls.Add("close-readonly-caps"); if (throwDispose) throw new FixtureFailure("replay-cap-close-unknown"); }
      internal void Process(int pid)
      { events.Enqueue(new F1DebugRecord { code = 3, pid = pid, tid = pid + 100, file = new IntPtr(1) }); events.Enqueue(new F1DebugRecord { code = 1, pid = pid, tid = pid + 100, exception = 0x80000003, firstChance = true }); events.Enqueue(new F1DebugRecord { code = 5, pid = pid, tid = pid + 100 }); }
    }
    private sealed class F1PoisonBytes : F1MetadataBytes
    {
      internal byte[] bytes; internal int poisonStart, poisonLength, secondStart, secondLength, reads;
      public byte Read(int offset) { if ((offset >= poisonStart && offset < poisonStart + poisonLength) || (offset >= secondStart && offset < secondStart + secondLength)) throw new Exception("CapturedData was read"); reads++; return bytes[offset]; }
    }
    private static void RunF1NativeSliceTests(FixtureReport report)
    {
      Case(report, "f1-debug-real-machine-continues-exit-before-kernel-wait-and-closes-images", delegate {
        F1ReplayDebugApi api = new F1ReplayDebugApi(); api.Process(10); List<string> notices = new List<string>();
        using (F1DebugPump pump = new F1DebugPump(api, n => { notices.Add(n.kind); return new F1DebugReply { accept = true, sequence = n.sequence, barrier = n.barrier }; }, "old22-negative", new String('a', 32)))
        { pump.Run(1000); Assert(pump.Finished, "natural pump finished"); }
        Assert(notices.SequenceEqual(new string[] { "create", "continued", "exit" }), "preallocated continue confirmation and EXIT ACK");
        Assert(api.calls.IndexOf("close-image") < api.calls.IndexOf("continue:3") && api.calls.IndexOf("continue:5") < api.calls.IndexOf("natural-wait"), "hFile closure and EXIT order");
      });
      Case(report, "f1-debug-twelve-process-epochs-without-filter-retirement", delegate {
        F1ReplayDebugApi api = new F1ReplayDebugApi();
        for (int i = 1; i <= 12; i++) api.events.Enqueue(new F1DebugRecord { code = 3, pid = i, tid = i + 100 });
        for (int i = 1; i <= 12; i++) api.events.Enqueue(new F1DebugRecord { code = 1, pid = i, tid = i + 100, exception = 0x80000003, firstChance = true });
        for (int i = 1; i <= 12; i++) api.events.Enqueue(new F1DebugRecord { code = 5, pid = i, tid = i + 100 });
        int creates = 0;
        using (F1DebugPump pump = new F1DebugPump(api, n => { if (n.kind == "create") creates++; return new F1DebugReply { accept = true, sequence = n.sequence, barrier = n.barrier }; }, "guarded-new-upgrade", new String('a', 32))) pump.Run(1000);
        Assert(creates == 12 && api.calls.Count(c => c == "continue:1") == 12, "each process has its own loader gate; no eight-PID cap");
      });
      Case(report, "f1-debug-rejected-ack-aborts-and-drains-same-pending-event", delegate {
        F1ReplayDebugApi api = new F1ReplayDebugApi(); api.Process(10);
        using (F1DebugPump pump = new F1DebugPump(api, n => new F1DebugReply { accept = false, sequence = n.sequence, barrier = n.barrier }, "old22-negative", new String('a', 32)))
          Reject(() => pump.Run(1000), "ACK rejection remains failure");
        Assert(api.terminated && api.empty && !api.calls.Contains("natural-wait") && api.calls.IndexOf("terminate-owned-job") < api.calls.IndexOf("continue:3"), "abort releases EXIT without pretending natural completion");
      });

      Case(report, "f1-debug-machine-rejects-work-moved-off-creating-thread", delegate {
        F1ReplayDebugApi api = new F1ReplayDebugApi { empty = true }; bool rejected = false;
        using (F1DebugPump pump = new F1DebugPump(api, n => null, "old22-negative", new String('a', 32)))
        { Thread other = new Thread(delegate() { try { pump.Step(1); } catch (FixtureFailure) { rejected = true; } }); other.Start(); other.Join(); Assert(rejected && !api.calls.Contains("wait"), "no wait/continue on an async worker"); }
      });
      Case(report, "f1-debug-continue-failure-never-confirms-trusted-start", delegate {
        F1ReplayDebugApi api = new F1ReplayDebugApi(); api.Process(10); int confirmed = 0;
        F1DebugPump pump = new F1DebugPump(api, n => { if (n.kind == "continued") confirmed++; return new F1DebugReply { accept = true, sequence = n.sequence, barrier = n.barrier }; }, "guarded-new-upgrade", new String('a', 32));
        api.throwContinue = true; Reject(() => pump.Run(1000), "Continue failure rejects"); Assert(confirmed == 0, "a failed Continue is never trustedStart");
      });
      Case(report, "f1-metadata-nonzero-registry-values-skipped-without-reading-payload", delegate {
        F1MetadataPlan plan = new F1MetadataPlan(); plan.fields.Add(new F1MetadataField { name = "DataSize", inputType = 8 });
        plan.fields.Add(new F1MetadataField { name = "CapturedData", inputType = 14, lengthProperty = 0, skipValue = true });
        plan.fields.Add(new F1MetadataField { name = "Status", inputType = 8 });
        F1PoisonBytes input = new F1PoisonBytes { bytes = new byte[] { 4,0,0,0, 99,98,97,96, 0,0,0,0 }, poisonStart = 4, poisonLength = 4 };
        Dictionary<string, object> decoded = plan.Read(input, input.bytes.Length, 8);
        Assert((ulong)decoded["DataSize"] == 4 && (ulong)decoded["Status"] == 0 && input.reads == 8 && !decoded.ContainsKey("CapturedData"), "normal nonzero value is metadata, no byte payload read");
      });

      Case(report, "f1-metadata-skips-both-current-and-previous-nonzero-value-spans", delegate {
        F1MetadataPlan plan = new F1MetadataPlan();
        foreach (string name in new string[] { "Type", "DataSize", "CapturedDataSize" }) plan.fields.Add(new F1MetadataField { name = name, inputType = 8 });
        plan.fields.Add(new F1MetadataField { name = "CapturedData", inputType = 14, lengthProperty = 2, skipValue = true });
        foreach (string name in new string[] { "PreviousDataType", "PreviousDataSize", "PreviousDataCapturedSize" }) plan.fields.Add(new F1MetadataField { name = name, inputType = 8 });
        plan.fields.Add(new F1MetadataField { name = "PreviousData", inputType = 14, lengthProperty = 6, skipValue = true });
        plan.fields.Add(new F1MetadataField { name = "Status", inputType = 8 });
        byte[] bytes = new byte[36]; bytes[0] = 3; bytes[4] = 4; bytes[8] = 4; bytes[16] = 3; bytes[20] = 4; bytes[24] = 4;
        F1PoisonBytes poison = new F1PoisonBytes { bytes = bytes, poisonStart = 12, poisonLength = 4, secondStart = 28, secondLength = 4 };
        Dictionary<string, object> metadata = plan.Read(poison, 36, 4);
        Assert(poison.reads == 28 && (ulong)metadata["DataSize"] == 4 && !metadata.ContainsKey("PreviousData"), "x86 nonzero blobs skipped; only metadata touched");
      });
      Case(report, "f1-metadata-schema-tuple-rejects-extra-fields-and-wrong-version", delegate {
        string[] names = { "Irp", "FileObject", "FileKey", "ExtraInformation", "IssuingThreadId", "InfoClass" };
        Assert(F1KnownMetadataSchemas.Matches(false, 19, 1, 0, names), "actual 4a rename metadata tuple");
        Assert(!F1KnownMetadataSchemas.Matches(false, 19, 0, 0, names) && !F1KnownMetadataSchemas.Matches(false, 19, 1, 0, names.Concat(new string[] { "opaque" })), "unknown body/version never generalized");
      });
      Case(report, "f1-observed-registry-requires-absolute-anchor-and-retires-generations", delegate {
        F1ObservedNamespaces graph = new F1ObservedNamespaces { CanaryRegistry = @"\REGISTRY\USER\owned\Software\fixture" };
        graph.Registry(2, 0, new Dictionary<string, object> { { "Status", 0UL }, { "KeyObject", 1UL }, { "RelativeName", @"\REGISTRY\USER\owned\Software" } }, 1);
        graph.Registry(1, 0, new Dictionary<string, object> { { "Status", 0UL }, { "KeyObject", 2UL }, { "BaseObject", 1UL }, { "RelativeName", "fixture" } }, 2);
        graph.Registry(5, 0, new Dictionary<string, object> { { "Status", 0UL }, { "KeyObject", 2UL }, { "DataSize", 4UL } }, 3);
        Assert(graph.RegistrySets == 1 && !graph.Gap, "actual namespace chain can map normal nonzero sets");
        graph.Registry(13, 0, new Dictionary<string, object> { { "Status", 0UL }, { "KeyObject", 2UL } }, 4);
        graph.Registry(5, 0, new Dictionary<string, object> { { "Status", 0UL }, { "KeyObject", 2UL } }, 5);
        Assert(graph.RegistrySets == 1 && graph.Gap, "post-close pointer reuse needs a new observed generation");
      });
      Case(report, "f1-observed-file-write-needs-matching-successful-irp-and-strict-capture-order", delegate {
        F1ObservedNamespaces graph = new F1ObservedNamespaces { CanaryFile = @"\Device\Owned\canary.bin" };
        graph.File(12, 1, new Dictionary<string, object> { { "FileObject", 1UL }, { "Irp", 10UL }, { "FileName", graph.CanaryFile } }, 1);
        graph.File(30, 1, new Dictionary<string, object> { { "FileObject", 1UL }, { "Irp", 10UL }, { "FileName", graph.CanaryFile } }, 2);
        graph.File(16, 1, new Dictionary<string, object> { { "FileObject", 1UL }, { "Irp", 11UL } }, 3);
        Assert(graph.FileWrites == 0 && graph.PendingCount == 1, "initiation is not successful completion");
        graph.File(24, 0, new Dictionary<string, object> { { "Irp", 11UL }, { "Status", 0UL } }, 4);
        Assert(graph.FileWrites == 1 && graph.PendingCount == 0 && !graph.Gap, "exact IRP completed");
        graph.File(16, 1, new Dictionary<string, object> { { "FileObject", 1UL }, { "Irp", 12UL } }, 5);
        graph.File(24, 0, new Dictionary<string, object> { { "Irp", 12UL }, { "Status", 0UL } }, 5);
        Assert(graph.FileWrites == 1 && graph.Gap, "equal timestamps cannot create a favorable order");
      });
      Case(report, "f1-observed-file-close-never-promotes-delete-or-rename-proof", delegate {
        F1ObservedNamespaces graph = new F1ObservedNamespaces { CanaryFile = @"\Device\Owned\canary.bin" };
        graph.File(12, 1, new Dictionary<string, object> { { "FileObject", 1UL }, { "Irp", 10UL }, { "FileName", graph.CanaryFile } }, 1);
        graph.File(14, 1, new Dictionary<string, object> { { "FileObject", 1UL }, { "Irp", 20UL } }, 2);
        graph.File(24, 0, new Dictionary<string, object> { { "Irp", 20UL }, { "Status", 0UL } }, 3);
        Assert(graph.FileCloses == 1 && graph.operations.Count == 0, "close does not retire an old inventory link");
        graph.File(27, 1, new Dictionary<string, object> { { "FileObject", 1UL }, { "Irp", 21UL }, { "FileName", @"\Device\Owned\stage" } }, 4);
        Assert(graph.Gap && graph.operations.Count == 0, "target path semantics/identity missing is unknown");
      });

      Case(report, "f1-debug-sdk-union-uses-176-bytes-and-explicit-x64-offsets", delegate {
        Assert(System.Runtime.InteropServices.Marshal.SizeOf(typeof(NativePlatform.F1DebugEvent)) == 176, "SDK x64 DEBUG_EVENT size");
        Assert(System.Runtime.InteropServices.Marshal.OffsetOf(typeof(NativePlatform.F1DebugEvent), "file").ToInt32() == 16
          && System.Runtime.InteropServices.Marshal.OffsetOf(typeof(NativePlatform.F1DebugEvent), "firstChance").ToInt32() == 168, "union and exception firstChance offsets");
      });
      Case(report, "f1-pointer-fields-require-one-explicit-event-header-width", delegate {
        F1MetadataPlan plan = new F1MetadataPlan(); plan.fields.Add(new F1MetadataField { name = "FileObject", inputType = 16 });
        Assert(plan.PointerWidth(0x20) == 4 && plan.PointerWidth(0x40) == 8, "target payload width comes from event flags");
        Reject(() => plan.PointerWidth(0), "unknown pointer width"); Reject(() => plan.PointerWidth(0x60), "conflicting pointer width");
      });

      Case(report, "f1-native-unknown-counters-remain-null-before-any-session-call", delegate {
        F1EtwSession session = new F1EtwSession(new string[] { "owned.exe" }); F1SessionObservation o = session.Observation();
        Assert(!o.startAttempted && !o.started && o.eventsLost == null && o.buffersLost == null && o.processTraceResult == null && o.scopeSupport == "not_proven", "an exit-zero tool or default struct cannot imply loss-free capture");
        session.Dispose(); Assert(session.Observation().closed, "a never-started session owns no native resource and is never stopped by name");
      });
      Case(report, "f1-managed-sdk-layout-and-literal-executable-filter-boundaries", delegate {
        Assert(F1EtwSession.Abi(), "documented x64 sizes/offsets; managed layout only, not a Windows SDK run");
        string[] names = Enumerable.Range(0, 12).Select(i => "owned-" + i + ".exe").ToArray(); new F1EtwSession(names);
        Reject(() => new F1EtwSession(new string[] { "*.exe" }), "no wildcard");
        Reject(() => new F1EtwSession(new string[] { "cmd.exe;other.exe" }), "no delimiter injection");
        Reject(() => new F1EtwSession(new string[] { new String('a', 512) }), "limit counts UTF16 bytes and terminator");
      });

      Case(report, "f1-metadata-actual-extra-information-and-malformed-tail", delegate {
        F1MetadataPlan plan = new F1MetadataPlan(); plan.fields.Add(new F1MetadataField { name = "ExtraInformation", inputType = 10 });
        Assert((ulong)plan.Read(new F1ArrayMetadataBytes(new byte[8]), 8, 8)["ExtraInformation"] == 0, "actual 4a metadata field admitted");
        Reject(() => plan.Read(new F1ArrayMetadataBytes(new byte[9]), 9, 8), "unclaimed body tail is unknown");
        plan.fields.Add(new F1MetadataField { name = "opaque", inputType = 8 });
        Reject(() => plan.Read(new F1ArrayMetadataBytes(new byte[12]), 12, 8), "unknown body not called a read");
      });
    }


    private static void RunF1SafetyFixTests(FixtureReport report)
    {
      Case(report, "f1-actual-tdh-fixed-zero-reg5-skips-both-value-spans", delegate {
        foreach (bool fixedZero in new bool[] { true, false })
        {
          string[] names = { "KeyObject", "Status", "Type", "DataSize", "KeyName", "ValueName", "CapturedDataSize", "CapturedData", "PreviousDataType", "PreviousDataSize", "PreviousDataCapturedSize", "PreviousData" };
          Assert(F1KnownMetadataSchemas.Matches(true, 5, 0, 36, names), "same actual known Reg5/v0/op36 tuple"); F1MetadataPlan plan = new F1MetadataPlan();
          for (int i = 0; i < names.Length; i++)
          {
            bool text = names[i] == "KeyName" || names[i] == "ValueName", blob = names[i] == "CapturedData" || names[i] == "PreviousData";
            plan.fields.Add(F1MetadataPlan.Project(names[i], (ushort)(text ? 1 : blob ? 14 : i == 0 ? 10 : 8), text && fixedZero ? 0x10 : blob ? 2 : 0, 1, i == 7 ? 6 : i == 11 ? 10 : 0, i));
          }
          int shift = fixedZero ? 0 : 4; byte[] bytes = new byte[44 + shift]; bytes[0] = 1; bytes[12] = 3; bytes[16] = 4; bytes[20 + shift] = 4;
          bytes[28 + shift] = 3; bytes[32 + shift] = 4; bytes[36 + shift] = 4;
          F1PoisonBytes poison = new F1PoisonBytes { bytes = bytes, poisonStart = 24 + shift, poisonLength = 4, secondStart = 40 + shift, secondLength = 4 };
          Dictionary<string, object> metadata = plan.Read(poison, bytes.Length, 8);
          Assert((ulong)metadata["DataSize"] == 4 && (ulong)metadata["CapturedDataSize"] == 4 && (string)metadata["KeyName"] == "" && (string)metadata["ValueName"] == "" && poison.reads == bytes.Length - 8 && !metadata.ContainsKey("CapturedData") && !metadata.ContainsKey("PreviousData"), "actual Project+Read preserve fixed-zero vs nul and never read either nonzero blob");
        }
      });
      Case(report, "f1-unsupported-explicit-string-or-unspecified-blob-rejected-before-body", delegate {
        foreach (int kind in new int[] { 0, 1, 2 })
        {
          F1MetadataPlan plan = new F1MetadataPlan(); plan.fields.Add(F1MetadataPlan.Project("DataSize", 8, 0, 1, 0, 0));
          plan.fields.Add(F1MetadataPlan.Project(kind == 2 ? "CapturedData" : "KeyName", (ushort)(kind == 2 ? 14 : 1), kind == 0 ? 0x10 : kind == 1 ? 2 : 0, 1, kind == 0 ? 4 : 0, 1));
          F1PoisonBytes poison = new F1PoisonBytes { bytes = new byte[16], poisonStart = 0, poisonLength = 16 };
          Reject(() => plan.Read(poison, 16, 8), "unsupported shape must be denied before reading even earlier metadata"); Assert(poison.reads == 0, "body not touched");
        }
      });
      Case(report, "f1-direct-abort-failure-latches-unknown-and-retains-readonly-caps", delegate {
        F1ReplayDebugApi api = new F1ReplayDebugApi { throwTerminate = true }; F1DebugPump pump = new F1DebugPump(api, n => null, "old22-negative", new String('a', 32));
        Reject(() => pump.Abort(), "termination failure"); api.throwTerminate = false;
        Reject(() => pump.Abort(), "uncertainty cannot be retried into success"); Reject(() => pump.Dispose(), "unknown abort cannot close caps");
        Assert(!api.empty && api.calls.Count(c => c == "terminate-owned-job") == 1 && !api.calls.Contains("close-readonly-caps"), "the exact frozen failure path no longer disposes caps");
      });
      Case(report, "f1-readonly-cap-dispose-failure-is-permanently-latched", delegate {
        F1ReplayDebugApi api = new F1ReplayDebugApi(); api.Process(1); F1DebugPump pump = new F1DebugPump(api, n => new F1DebugReply { accept = true, sequence = n.sequence, barrier = n.barrier }, "old22-negative", new String('a', 32)); pump.Run(1000); api.throwDispose = true;
        Reject(() => pump.Dispose(), "cap close failure"); api.throwDispose = false; Reject(() => pump.Dispose(), "unknown close cannot be retried as known");
        Assert(api.calls.Count(c => c == "close-readonly-caps") == 1, "no second close attempt after uncertain cap disposition");
      });
      Case(report, "f1-canary-registry-cleanup-requires-natural-zero-after-any-resume-attempt", delegate {
        Assert(F1Policy.CanaryRegistryCleanupKnown(false, false), "never-resumed child cannot create its user-mode volatile leaf");
        Assert(F1Policy.CanaryRegistryCleanupKnown(true, true), "natural exit0 occurs only after child close/delete finally succeeds");
        Assert(!F1Policy.CanaryRegistryCleanupKnown(true, false), "timeout/forced exit/nonzero including registry cleanup failure remains unknown even with empty files");
      });
    }


    private static void RunF1CanaryRuntimeFixTests(FixtureReport report)
    {
      Case(report, "f1-canary-abort-job-empty-still-drains-exit-before-cap-close", delegate {
        F1ReplayDebugApi api = new F1ReplayDebugApi { emptyOnTerminate = true }; api.Process(10);
        F1DebugPump pump = new F1DebugPump(api, n => new F1DebugReply { accept = false, sequence = n.sequence, barrier = n.barrier }, "zero-account-canary", new String('a', 32));
        Reject(() => pump.Run(1000), "rejected create remains failure"); pump.Dispose();
        Assert(api.calls.Contains("continue:5") && api.calls.IndexOf("continue:5") < api.calls.IndexOf("abort-wait")
          && api.calls.IndexOf("abort-wait") < api.calls.IndexOf("close-readonly-caps"), "JobEmpty must not bypass the stopped EXIT event and kernel wait");
      });
      Case(report, "f1-canary-abort-kernel-wait-failure-retains-unknown-caps", delegate {
        F1ReplayDebugApi api = new F1ReplayDebugApi { emptyOnTerminate = true, throwAbortWait = true }; api.Process(10);
        F1DebugPump pump = new F1DebugPump(api, n => new F1DebugReply { accept = false, sequence = n.sequence, barrier = n.barrier }, "zero-account-canary", new String('a', 32));
        Reject(() => pump.Run(1000), "first rejected create remains failure");
        Reject(() => pump.Dispose(), "failed termination wait permanently latches unknown closure");
        Assert(!api.calls.Contains("close-readonly-caps"), "unknown process exit cannot close epoch capabilities");
      });
      Case(report, "f1-canary-report-converts-filetime-without-changing-process-identity", delegate {
        DateTime date = new DateTime(2026, 11, 14, 1, 2, 3, DateTimeKind.Utc).AddTicks(1234567);
        string identity = date.ToFileTimeUtc().ToString(System.Globalization.CultureInfo.InvariantCulture), original = identity;
        Assert(NativePlatform.CanaryCreationTimestamp(identity) == date.ToString("o", System.Globalization.CultureInfo.InvariantCulture)
          && identity == original && identity.Length == 18, "report UTC projection must not mutate the retained FILETIME identity");
        Assert(NativePlatform.CanaryCreationTimestamp(null) == null, "a never-created child retains nullable report time");
      });
      Case(report, "f1-canary-filetime-conversion-boundaries-and-malformed-inputs", delegate {
        Assert(NativePlatform.CanaryCreationTimestamp("0") == "1601-01-01T00:00:00.0000000Z", "FILETIME epoch boundary");
        string maximum = DateTime.SpecifyKind(DateTime.MaxValue, DateTimeKind.Utc).ToFileTimeUtc().ToString(System.Globalization.CultureInfo.InvariantCulture);
        Assert(NativePlatform.CanaryCreationTimestamp(maximum) == "9999-12-31T23:59:59.9999999Z", "maximum UTC FILETIME boundary");
        foreach (string invalid in new string[] { "", "-1", "+1", " 1", "1 ", "01", "1.0", "1e0", "18446744073709551616", "9223372036854775808", "2650467744000000000" })
          Reject(() => NativePlatform.CanaryCreationTimestamp(invalid), "invalid or out-of-range FILETIME must fail closed");
      });
      Case(report, "f1-canary-create-binds-resolved-owned-image-before-user-code", delegate {
        string hash = new String('a', 64), creation = "134391781230000000";
        FileIdentity root = new FileIdentity { canonicalPath = @"C:\OwnedCanary", volumePath = "owned-volume", directory = true };
        FileIdentity expected = new FileIdentity { canonicalPath = @"C:\OwnedCanary\profile-fixture.exe", volumePath = root.volumePath, fileId = "owned-image-id", sha256 = hash, bytes = 42 };
        NativePlatform.RequireCanaryExpectedImage(expected, root, hash);
        F1DebugNotice notice = new F1DebugNotice { pid = 10, creationTime = creation, image = new FileIdentity {
          canonicalPath = expected.canonicalPath, volumePath = expected.volumePath, fileId = expected.fileId, sha256 = hash, bytes = expected.bytes } };
        Assert(!CorePolicy.SamePath(notice.image.canonicalPath, @"D:\LogicalAlias\profile-fixture.exe"), "literal launch spelling is not a resolved object identity");
        NativePlatform.RequireCanaryCreateNotice(notice, 10, creation, expected, hash);
        foreach (string fault in new string[] { "pid", "ctime", "id", "volume", "bytes", "hash", "path", "reparse" })
        {
          F1DebugNotice changed = new F1DebugNotice { pid = notice.pid, creationTime = creation, image = new FileIdentity {
            canonicalPath = expected.canonicalPath, volumePath = expected.volumePath, fileId = expected.fileId, sha256 = hash, bytes = expected.bytes } };
          if (fault == "pid") changed.pid++;
          if (fault == "ctime") changed.creationTime = "134391781230000001";
          if (fault == "id") changed.image.fileId = "other-image-id";
          if (fault == "volume") changed.image.volumePath = "other-volume";
          if (fault == "bytes") changed.image.bytes++;
          if (fault == "hash") changed.image.sha256 = new String('b', 64);
          if (fault == "path") changed.image.canonicalPath = @"C:\Outside\profile-fixture.exe";
          if (fault == "reparse") changed.image.reparse = true;
          Reject(() => NativePlatform.RequireCanaryCreateNotice(changed, 10, creation, expected, hash), "every create identity constraint remains required");
        }
      });
      Case(report, "f1-canary-expected-image-cannot-escape-its-owned-root-or-hash", delegate {
        string hash = new String('a', 64);
        FileIdentity root = new FileIdentity { canonicalPath = @"C:\OwnedCanary", volumePath = "owned-volume", directory = true };
        foreach (string fault in new string[] { "path", "volume", "id", "hash", "directory", "reparse" })
        {
          FileIdentity changed = new FileIdentity { canonicalPath = @"C:\OwnedCanary\profile-fixture.exe", volumePath = root.volumePath, fileId = "owned-image-id", sha256 = hash, bytes = 42 };
          if (fault == "path") changed.canonicalPath = @"C:\Outside\profile-fixture.exe";
          if (fault == "volume") changed.volumePath = "other-volume";
          if (fault == "id") changed.fileId = null;
          if (fault == "hash") changed.sha256 = new String('b', 64);
          if (fault == "directory") changed.directory = true;
          if (fault == "reparse") changed.reparse = true;
          Reject(() => NativePlatform.RequireCanaryExpectedImage(changed, root, hash), "the pre-launch held file is limited to the exact owned child leaf");
        }
      });
    }

    private static void RunF1CanaryDiagnosticContractTests(FixtureReport report)
    {
      Case(report, "f1-canary-diagnostic-contract-encodes-shared-constant-without-changing-history", delegate {
        const string label = "Owned child did not terminate"; Exception error = new FixtureFailure(label);
        Assert(NativePlatform.SafeFailure(error) == label, "historical failure text remains unchanged");
        string value = NativePlatform.SafeCanaryFailure(error);
        Assert(value == "f1-canary-failure-fixture-code-none-labelchars-29-labelsha-" + CorePolicy.HashText(label) && value.IndexOf(label, StringComparison.Ordinal) < 0, "bounded constant/hash contract replaces raw detail only for canary");
      });
      Case(report, "f1-canary-diagnostic-contract-keeps-numeric-error-and-rejects-value-text", delegate {
        const string marker = "CapturedData=PRIVATE_CANARY_DIAGNOSTIC";
        string value = NativePlatform.SafeCanaryFailure(new System.ComponentModel.Win32Exception(5, marker));
        Assert(value == "f1-canary-failure-win32-code-00000005-labelchars-0-labelsha-none" && value.IndexOf(marker, StringComparison.Ordinal) < 0, "typed numeric code without arbitrary Win32 text");
        string wrapped = NativePlatform.SafeCanaryFailure(new InvalidOperationException("Owned API failed (Win32 32)"));
        Assert(wrapped.Contains("-code-00000020-") && !wrapped.Contains("Owned API"), "existing bounded numeric wrapper is preserved as a code/hash");
      });
      Case(report, "f1-canary-diagnostic-contract-is-bounded-for-long-or-unknown-errors", delegate {
        foreach (Exception error in new Exception[] { null, new Exception("CapturedData=PRIVATE"), new FixtureFailure(new String('x', 10000)) })
        {
          string value = NativePlatform.SafeCanaryFailure(error);
          Assert(value.Length < 192 && System.Text.RegularExpressions.Regex.IsMatch(value, "\\Af1-[a-z0-9-]+\\z") && !value.Contains("CapturedData"), "finite category/code/length/hash, never exception payload");
        }
      });
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
          if (Fault == "profile-admin-owner-trustedinstaller") metadata.ownerSid = NativePlatform.TrustedInstallerSid;
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
          if (Fault == "profile-admin-parent-trustedinstaller") parent.ownerSid = NativePlatform.TrustedInstallerSid;
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
