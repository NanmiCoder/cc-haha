// Stage A regressions: this file never constructs NativePlatform or calls an
// account, registry, profile, privilege or released-product Windows API.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

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

    private static void AssertNoNativePromotion(FixtureState state)
    {
      Assert(!state.report.compatibilityEnabled && state.report.oldExit22Policy == "fatal", "compatibility must remain disabled");
      Assert(state.report.realAccountsCreated == 0 && state.report.realProfilesCreated == 0 && !state.report.releasedPeExecuted, "FakeAPI must not claim native execution");
      Assert(!state.report.releasedPeMayHaveExecuted && state.report.releasedPeExecutionStatus == "not_run", "FakeAPI must not imply possible product execution");
      Assert(state.report.member_proven == "not_run" && state.report.installed_bytes_equal == "not_run"
        && state.report.old22_before_protected_mutation == "not_run" && state.report.removal_equivalence == "not_run"
        && state.report.full_old_to_new == "not_run", "five evidence fields must remain not_run");
    }

    public static void Run(FixtureReport report)
    {
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

    private sealed class FakePlatform : ProfilePlatform
    {
      public override bool IsFake { get { return true; } }
      public string Fault;
      public FixtureSpec Specification;
      public readonly List<string> Calls = new List<string>();
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
        Gate(state, "PreflightController"); Specification = state.spec; CorePolicy.ValidateControllerSpec(state.spec);
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
        Gate(state, "CreateFreshProfile"); state.profilePath = Paths().profile; state.profileCreated = true;
        state.profileIdentity = new FileIdentity { canonicalPath = state.profilePath, directory = true, volumePath = @"\\?\Volume{fixture}\", fileId = "profile-file" };
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
      public override void LoadProfile(FixtureState state) { Gate(state, "LoadProfile"); state.profileLoaded = true; state.profile = new IntPtr(201); }
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
      public override bool HasOwnedSidProcesses(FixtureState state) { Gate(state, "HasOwnedSidProcesses"); return Fault == "unknown-sid-process"; }
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
      public override bool HivesAbsent(FixtureState state) { Gate(state, "HivesAbsent"); return Fault != "hive-still-mounted"; }
      public override void DeleteOwnedProfile(FixtureState state) { Gate(state, "DeleteOwnedProfile"); Assert(!state.profileLoaded, "do not delete loaded profile"); if (Fault != "delete-not-confirmed") state.profileCreated = false; }
      public override void DeleteOwnedAccount(FixtureState state) { Gate(state, "DeleteOwnedAccount"); VerifyOwnedAccount(state, true); Assert(!state.profileCreated, "do not delete account before profile"); state.accountCreated = false; }
      public override void CloseTokenAndPrivileges(FixtureState state) { Gate(state, "CloseTokenAndPrivileges"); state.token = IntPtr.Zero; }
    }
  }
}
