// Issue 1879's bounded, offline Windows CI evidence fixture. C# 5 / .NET Framework.
// Stage A invokes only --self-test and --abi-harness. Neither creates an account,
// loads a profile, changes HKCU, or starts a released product executable.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Management;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;

namespace CcHahaInstallerProfile
{
  [DataContract]
  internal sealed class CheckResult
  {
    [DataMember] public string name;
    [DataMember] public string status;
    [DataMember] public string detail;
  }

  [DataContract]
  internal sealed class FixtureReport
  {
    [DataMember] public int version = 1;
    [DataMember] public string mode;
    [DataMember] public string status = "failed";
    [DataMember] public List<CheckResult> checks = new List<CheckResult>();
    [DataMember(EmitDefaultValue = false)] public F1SessionObservation f1NativeCanary;
    [DataMember] public int realAccountsCreated;
    [DataMember] public int realProfilesCreated;
    [DataMember] public bool releasedPeExecuted;
    [DataMember] public bool releasedPeMayHaveExecuted;
    [DataMember] public string releasedPeExecutionStatus = "not_run";
    [DataMember] public bool compatibilityEnabled;
    [DataMember] public string oldExit22Policy = "fatal";
    [DataMember] public string member_proven = "not_run";
    [DataMember] public string installed_bytes_equal = "not_run";
    [DataMember] public string old22_before_protected_mutation = "not_run";
    [DataMember] public string removal_equivalence = "not_run";
    [DataMember] public string full_old_to_new = "not_run";
    [DataMember] public string binarySha256;
    [DataMember] public string specSha256;
    [DataMember] public string startedAtUtc = DateTime.UtcNow.ToString("o");
    [DataMember] public string finishedAtUtc;
    [DataMember] public string failedStage;
    [DataMember] public string cleanup = "not_run";
    [DataMember] public List<string> trace = new List<string>();
    [DataMember] public List<PhaseEvidence> phases = new List<PhaseEvidence>();
    [DataMember] public List<ObservedStart> observations = new List<ObservedStart>();
    [DataMember] public Dictionary<string, string> evidenceFiles = new Dictionary<string, string>();

    public void Check(string name, bool passed, string detail)
    {
      checks.Add(new CheckResult { name = name, status = passed ? "passed" : "failed", detail = detail });
      if (!passed) status = "failed";
    }
  }

  [DataContract]
  internal sealed class SourcePin
  {
    [DataMember] public string file;
    [DataMember] public string sha256;
  }

  [DataContract]
  internal sealed class FixtureSpec
  {
    [DataMember] public int version;
    [DataMember] public string mode;
    [DataMember] public string executionStage;
    [DataMember] public bool realExecutionAdmitted;
    [DataMember] public string runId;
    [DataMember] public string owner;
    [DataMember] public int generation;
    [DataMember] public string sourceRoot;
    [DataMember] public string gitRoot;
    [DataMember] public string controllerRoot;
    [DataMember] public string output;
    [DataMember] public string setupPath;
    [DataMember] public string expectedBinarySha256;
    [DataMember] public List<SourcePin> sourcePins;
    [DataMember] public string frozenPlanManifestSha256;
    [DataMember] public string argvEnvPlanSha256;
    // Controller generates the following subject-only fields after real
    // account/profile admission. They never include a password or admin handle.
    [DataMember] public string controllerSpecSha256;
    [DataMember] public string subjectSpecSha256;
    [DataMember] public string expectedSid;
    [DataMember] public string expectedControllerSid;
    [DataMember] public int expectedControllerPid;
    [DataMember] public string expectedControllerCreationTime;
    [DataMember] public string profilePath;
    [DataMember] public KnownPaths knownPaths;
    [DataMember] public string fixtureRoot;
    [DataMember] public string tempRoot;
    [DataMember] public string installRoot;
    [DataMember] public string uninstallerCopy;
    [DataMember] public string pipeName;
    [DataMember] public string nonce;
    [DataMember] public string hiveKey;
    [DataMember] public string hiveNonce;
    [DataMember] public string desktopName;
    [DataMember] public string subjectSpecPath;
    [DataMember] public F1InputBindings f1;
  }

  [DataContract]
  internal sealed class TokenIdentity
  {
    [DataMember] public string sid;
    [DataMember] public int tokenType;
    [DataMember] public int integrityRid;
    [DataMember] public bool elevated;
    [DataMember] public int elevationType;
    [DataMember] public int sessionId;
    [DataMember] public string authenticationId;
    [DataMember] public List<string> groups = new List<string>();
    [DataMember] public List<string> privileges = new List<string>();
  }

  [DataContract]
  internal sealed class KnownPaths
  {
    [DataMember] public string profile;
    [DataMember] public string roaming;
    [DataMember] public string local;
    [DataMember] public string desktop;
    [DataMember] public string programs;
    [DataMember] public string startMenu;
    [DataMember] public string userPrograms;
  }

  [DataContract]
  internal sealed class FileIdentity
  {
    [DataMember] public string canonicalPath;
    [DataMember] public string volumePath;
    [DataMember] public string fileId;
    [DataMember] public long bytes;
    [DataMember] public string sha256;
    [DataMember] public bool directory;
    [DataMember] public bool reparse;
  }

  [DataContract]
  internal sealed class AccountRecord
  {
    [DataMember] public string sam;
    [DataMember] public string sid;
    [DataMember] public string marker;
    [DataMember] public uint flags;
    [DataMember] public List<string> groups = new List<string>();
  }

  internal sealed class OwnedProcess
  {
    public IntPtr process;
    public IntPtr thread;
    public IntPtr job;
    public int pid;
    public string creationTime;
    public FileIdentity image;
    public TokenIdentity identity;
    public bool assigned;
    public bool resumed;
    public bool exited;
    internal F1DebugPump debugPump;
    internal Func<F1DebugNotice, F1DebugReply> debugExchange;
  }

  internal sealed class FixtureState
  {
    public FixtureSpec spec;
    public FixtureReport report;
    public string stage;
    public string sam;
    public string marker;
    public string ledgerPath;
    public string profilePath;
    public string runnerSid;
    public int runnerPid;
    public string runnerCreationTime;
    public bool controllerRootOwned;
    public string subjectBinaryPath;
    public AccountRecord account;
    public bool accountCreated;
    public bool accountEverCreated;
    public bool accountBound;
    public bool profileCreated;
    // Runtime-only uncertainty, armed before the single CreateProfile attempt.
    // The existing ledger.stage records the durable armed/proven boundary.
    public int profileCreationAttempts;
    public bool profileCreationUncertain;
    public bool profileOwnershipProven;
    public bool f1AuditResourceUncertain;
    public bool f1AuditArmOutcomeUnknown;
    public List<F1AuditLease> f1AuditLeases = new List<F1AuditLease>();
    // Only this process's successful creation may supply an ownership context.
    // These fields/pin are never recovered from the ledger or a prior report.
    public string profileCreationTokenOwner;
    public FileIdentity profileCreationIdentity;
    public IDisposable profileCreationPin;
    public bool profileCreationSucceeded;
    public bool profileLoadAttempted;
    public bool profileDeleteAttempted;
    public bool profileEverCreated;
    public bool profileLoaded;
    public bool accountDisabled = true;
    public bool acknowledged;
    public bool jobsEmpty;
    public IntPtr token;
    public IntPtr profile;
    public IntPtr environment;
    public IntPtr station;
    public IntPtr desktop;
    public IntPtr originalStation;
    public IntPtr originalDesktop;
    public IntPtr job;
    public string desktopName;
    public TokenIdentity targetIdentity;
    public KnownPaths paths;
    public FileIdentity profileIdentity;
    public Dictionary<string, string> targetEnvironment;
    public OwnedProcess subject;
    public FixtureChannel channel;
    public IDisposable privilegeScope;
  }

  internal abstract class FixtureChannel : IDisposable
  {
    public abstract int PeerProcessId { get; }
    public abstract string ReadLine(int timeoutMilliseconds);
    public abstract void WriteLine(string line);
    public abstract void Dispose();
  }

  [DataContract]
  internal sealed class ProtocolMessage
  {
    [DataMember] public int version = 1;
    [DataMember] public string kind;
    [DataMember] public string nonce;
    [DataMember] public string specSha256;
    [DataMember] public string binarySha256;
    [DataMember] public int pid;
    [DataMember] public string creationTime;
    [DataMember] public string sid;
    [DataMember] public TokenIdentity identity;
    [DataMember] public KnownPaths knownPaths;
    [DataMember] public string hiveResponse;
    [DataMember] public string phase;
    [DataMember] public FileIdentity image;
    [DataMember] public PhaseEvidence evidence;
    [DataMember] public FixtureReport report;
    [DataMember(EmitDefaultValue = false)] public F1DebugNotice debug;
    [DataMember(EmitDefaultValue = false)] public F1DebugReply debugReply;
  }

  [DataContract]
  internal sealed class PhaseEvidence
  {
    [DataMember] public string phase;
    [DataMember] public string startedAtUtc;
    [DataMember] public string finishedAtUtc;
    [DataMember] public string applicationSha256;
    [DataMember] public string argvSha256;
    [DataMember] public string environmentSha256;
    [DataMember] public int exitCode;
    [DataMember] public bool helperAlive;
    [DataMember] public bool protectedFinalStateUnchanged;
    [DataMember] public bool payloadRemoved;
    [DataMember] public bool registrationRemoved;
    [DataMember] public bool keptDataUnchanged;
    [DataMember] public bool oldStateEquivalent;
    [DataMember] public bool newPackageInstalled;
    [DataMember] public bool legacyOnlyCanaryRemoved;
    [DataMember] public bool shortcutTargetsUnchanged;
    [DataMember] public F1AuditEvidence protectedMutationAudit;
    [DataMember] public string installedUninstallerSha256;
    [DataMember] public string fallbackObservation = "not_proven";
    [DataMember] public string fileRegistryOperationStream = "not_provided";
  }

  internal sealed class CommandPlan
  {
    public string phase;
    public string application;
    public string commandLine;
    public string expectedSha256;
    public int timeoutMilliseconds;
    public int expectedExitCode;
  }

  // Purpose-specific injection boundary: FakePlatform never calls Win32.
  // NativePlatform is the sole P/Invoke implementation, in the native source.
  internal abstract class ProfilePlatform
  {
    public virtual bool IsFake { get { return false; } }
    public virtual bool F1AuditAvailable { get { return false; } }
    public virtual bool F1SubjectProtocolAvailable { get { return IsFake; } }
    public virtual F1AuditLease PrepareF1Audit(FixtureState state, string phase) { throw new FixtureFailure("f1-session-prepare-unavailable"); }
    public virtual F1AuditLease ArmF1Audit(FixtureState state, ProtocolMessage phase) { throw new FixtureFailure("f1-native-audit-adapter-unavailable"); }
    public abstract void PreflightController(FixtureState state);
    public abstract void CreateDisabledAccount(FixtureState state, SecretBuffer password);
    public abstract void VerifyOwnedAccount(FixtureState state, bool disabled);
    public abstract void AddUsersOnly(FixtureState state);
    public abstract void CreateFreshProfile(FixtureState state);
    public abstract void SetOwnedAccountDisabled(FixtureState state, bool disabled);
    public abstract void Logon(FixtureState state, SecretBuffer password);
    public abstract TokenIdentity InspectToken(IntPtr token);
    public abstract TokenIdentity InspectCurrentToken();
    public abstract KnownPaths QueryKnownPaths(IntPtr token);
    public abstract void LoadProfile(FixtureState state);
    public abstract Dictionary<string, string> TargetEnvironment(FixtureState state);
    public abstract void WriteHiveChallenge(FixtureState state);
    public abstract bool VerifyHiveResponse(FixtureState state, string response);
    public abstract string SubjectHiveChallenge(FixtureSpec spec);
    public abstract void PrepareSubjectAccess(FixtureState state);
    public abstract void CreatePrivateDesktop(FixtureState state);
    public abstract FixtureChannel CreateControllerChannel(FixtureState state);
    public abstract FixtureChannel ConnectSubjectChannel(FixtureSpec spec);
    public abstract void CreateSubjectSuspended(FixtureState state);
    public abstract void AssignSubjectToOwnedJob(FixtureState state);
    public abstract void VerifySubject(FixtureState state);
    public abstract void ResumeSubject(FixtureState state);
    public abstract int WaitSubjectExit(FixtureState state, int timeoutMilliseconds);
    public abstract FileIdentity IdentifyPath(string path, bool directory);
    public abstract void StartChild(OwnedProcess child, CommandPlan command, Dictionary<string, string> environment, string cwd, string desktopName);
    public abstract void VerifyChild(OwnedProcess child, string expectedSid, string expectedPath, string expectedSha256);
    public abstract void ResumeChild(OwnedProcess child);
    public abstract int WaitChild(OwnedProcess child, int timeoutMilliseconds);
    public abstract void StopChild(OwnedProcess child);
    public abstract void CloseChild(OwnedProcess child);
    public abstract void VerifyReportedPhase(FixtureState state, ProtocolMessage message);
    public abstract void StopOwnedJobs(FixtureState state);
    public abstract bool HasOwnedSidProcesses(FixtureState state);
    public abstract void CloseRuntimeResources(FixtureState state);
    public abstract void UnloadProfile(FixtureState state);
    public abstract bool HivesAbsent(FixtureState state);
    public abstract void DeleteOwnedProfile(FixtureState state);
    public abstract void DeleteOwnedAccount(FixtureState state);
    public abstract void CloseTokenAndPrivileges(FixtureState state);
  }

  internal sealed class SecretBuffer : IDisposable
  {
    public IntPtr Pointer { get; private set; }
    private const int Characters = 48;

    public SecretBuffer()
    {
      byte[] random = new byte[Characters];
      char[] alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%+-".ToCharArray();
      Pointer = Marshal.AllocHGlobal((Characters + 1) * 2);
      try
      {
        using (RandomNumberGenerator generator = RandomNumberGenerator.Create()) generator.GetBytes(random);
        for (int i = 0; i < Characters; i++) Marshal.WriteInt16(Pointer, i * 2, (short)alphabet[random[i] % alphabet.Length]);
        // Ensure all required policy classes without ever constructing a managed password string.
        Marshal.WriteInt16(Pointer, 0, (short)'A');
        Marshal.WriteInt16(Pointer, 2, (short)'a');
        Marshal.WriteInt16(Pointer, 4, (short)'7');
        Marshal.WriteInt16(Pointer, 6, (short)'!');
        Marshal.WriteInt16(Pointer, Characters * 2, 0);
      }
      catch { Dispose(); throw; }
      finally { Array.Clear(random, 0, random.Length); Array.Clear(alphabet, 0, alphabet.Length); }
    }

    public void Dispose()
    {
      if (Pointer == IntPtr.Zero) return;
      for (int i = 0; i < (Characters + 1) * 2; i++) Marshal.WriteByte(Pointer, i, 0);
      Marshal.FreeHGlobal(Pointer);
      Pointer = IntPtr.Zero;
    }
  }

  internal sealed class FixtureFailure : Exception
  {
    public FixtureFailure(string stage) : base(stage) { }
  }

  internal static class CoreJson
  {
    private static DataContractJsonSerializer Serializer(Type type)
    {
      return new DataContractJsonSerializer(type, new DataContractJsonSerializerSettings {
        UseSimpleDictionaryFormat = true, KnownTypes = new Type[] { typeof(AccountRecord), typeof(FileIdentity), typeof(Dictionary<string, string>) }
      });
    }

    public static string Serialize(object value)
    {
      using (MemoryStream stream = new MemoryStream())
      {
        Serializer(value.GetType()).WriteObject(stream, value);
        return Encoding.UTF8.GetString(stream.ToArray());
      }
    }

    public static T Deserialize<T>(string json)
    {
      CorePolicy.Require(json != null && Encoding.UTF8.GetByteCount(json) <= 65536, "bounded-json");
      using (MemoryStream stream = new MemoryStream(Encoding.UTF8.GetBytes(json)))
        return (T)Serializer(typeof(T)).ReadObject(stream);
    }

    public static T Read<T>(string file)
    {
      CorePolicy.Require(new FileInfo(file).Length <= 65536, "bounded-spec");
      return Deserialize<T>(File.ReadAllText(file, Encoding.UTF8));
    }

    public static void Write(string file, object value)
    {
      byte[] bytes = new UTF8Encoding(false).GetBytes(Serialize(value) + "\n");
      using (FileStream stream = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None))
      {
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush(true);
      }
    }

    public static void AtomicWrite(string file, object value)
    {
      string temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
      Write(temporary, value);
      if (File.Exists(file)) File.Replace(temporary, file, null);
      else File.Move(temporary, file);
    }
  }

  // F1 preparation is a separate protocol. No profile-only or historical B
  // input is promoted, and the native audit adapter is deliberately unavailable.
  [DataContract]
  internal sealed class F1BlobPin
  {
    [DataMember] public string file;
    [DataMember] public long bytes;
    [DataMember] public string sha256;
  }

  [DataContract]
  internal sealed class F1PayloadPin
  {
    [DataMember] public string kind;
    [DataMember] public string relativePath;
    [DataMember] public long bytes;
    [DataMember] public string sha256;
  }

  [DataContract]
  internal sealed class F1PackagePin
  {
    [DataMember] public string sourceHead;
    [DataMember] public string displayVersion;
    [DataMember] public F1BlobPin setup;
    [DataMember] public F1BlobPin buildReceipt;
    [DataMember] public F1BlobPin memberReceipt;
    [DataMember] public long uninstallerBytes;
    [DataMember] public string uninstallerSha256;
    [DataMember] public string archiveLiteral;
    [DataMember] public string guardedRemovalSha256;
    [DataMember] public long guardedRemovalBytes;
    [DataMember] public List<F1PayloadPin> payloads;
  }

  [DataContract]
  internal sealed class F1InputBindings
  {
    [DataMember] public int version;
    [DataMember] public string status;
    [DataMember] public string activationHead;
    [DataMember] public string candidateSourceHead;
    [DataMember] public string stageASourceHead;
    [DataMember] public long stageARunId;
    [DataMember] public long stageAArtifactId;
    [DataMember] public long fixtureBytes;
    [DataMember] public string stageAArtifactSha256;
    [DataMember] public F1BlobPin stageAReceipt;
    [DataMember] public F1BlobPin oldMemberReceipt;
    [DataMember] public F1PackagePin newPackage;
  }

  [DataContract]
  internal sealed class F1MemberReceipt
  {
    [DataMember(IsRequired = true)] public int version;
    [DataMember(IsRequired = true)] public string status;
    [DataMember(IsRequired = true)] public string forcedType;
    [DataMember(IsRequired = true)] public string literalMember;
    [DataMember(IsRequired = true)] public bool peExecuted;
    [DataMember(IsRequired = true)] public F1BlobPin setup;
    [DataMember(IsRequired = true)] public F1BlobPin output;
  }
  [DataContract]
  internal sealed class F1StageAReceipt
  {
    [DataMember] public int version;
    [DataMember] public string status;
    [DataMember] public string sourceHead;
    [DataMember] public long runId;
    [DataMember] public long artifactId;
    [DataMember] public string artifactSha256;
    [DataMember] public string fixtureSha256;
    [DataMember] public long fixtureBytes;
    [DataMember] public List<SourcePin> sourcePins;
    [DataMember] public List<SourcePin> rawReports;
  }
  [DataContract]
  internal sealed class F1BuildReceipt
  {
    [DataMember] public int version;
    [DataMember] public string kind;
    [DataMember] public string sourceHead;
    [DataMember] public string displayVersion;
    [DataMember] public string setupSha256;
    [DataMember] public long setupBytes;
    [DataMember] public string uninstallerSha256;
    [DataMember] public long uninstallerBytes;
    [DataMember] public string guardedRemovalSha256;
    [DataMember] public long guardedRemovalBytes;
    [DataMember] public List<F1PayloadPin> payloads;
  }

  // This is an authenticated Controller adapter output, never a subject claim.
  // A future ETW adapter must derive these fields from retained native resources
  // and raw records; the current NativePlatform cannot construct a lease.
  [DataContract]
  internal sealed class F1AuditOperation
  {
    [DataMember] public long sequence;
    [DataMember] public string kind;
    [DataMember] public string scope;
    [DataMember] public string objectId;
    [DataMember] public bool resultKnown;
    [DataMember] public bool succeeded;
    [DataMember] public bool objectRetired;
  }

  [DataContract]
  internal sealed class F1AuditEvidence
  {
    [DataMember] public string status = "not_proven";
    [DataMember] public string phase;
    [DataMember] public string nonce;
    [DataMember] public string specSha256;
    [DataMember] public int rootPid;
    [DataMember] public string rootCreationTime;
    [DataMember] public bool fileWriteRestoreCalibrated;
    [DataMember] public bool registrySetRestoreCalibrated;
    [DataMember] public bool calibrationFinalStateEqual;
    [DataMember] public bool mapsComplete;
    [DataMember] public bool rootsAndRegistryParentsComplete;
    [DataMember] public bool stagingIdentityCoverage;
    [DataMember] public bool allPeJobsNaturallyExited;
    [DataMember] public bool closed;
    [DataMember] public bool gap;
    [DataMember] public long eventsLost;
    [DataMember] public long buffersLost;
    [DataMember] public long armedSequence;
    [DataMember] public long ackSequence;
    [DataMember] public long endSequence;
    [DataMember] public long oldUninstallerExit22Sequence;
    [DataMember] public int oldUninstallerExitCode;
    [DataMember] public long trustedRemovalStartSequence;
    [DataMember] public string oldUninstallerSha256;
    [DataMember] public string trustedRemovalSha256;
    [DataMember] public List<string> oldPayloadObjects = new List<string>();
    [DataMember] public List<string> oldRegistryObjects = new List<string>();
    [DataMember] public List<F1AuditOperation> operations = new List<F1AuditOperation>();
  }

  internal abstract class F1AuditLease : IDisposable
  {
    private bool closureFailed;
    internal bool ClosureFailed { get { return closureFailed; } }
    internal void RecordClosureFailure() { closureFailed = true; }
    // These arming fields must already be proven before Controller attempts ACK.
    public virtual void AttachRoot(ProtocolMessage root) { throw new FixtureFailure("f1-root-attachment-unavailable"); }
    public virtual F1DebugReply Debug(F1DebugNotice notice) { throw new FixtureFailure("f1-debug-protocol-unavailable"); }
    public abstract F1AuditEvidence Arming { get; }
    public abstract bool AllResourcesKnownClosed { get; }
    public abstract void BeforeAck();
    public abstract F1AuditEvidence Complete();
    public abstract void Dispose();
  }

  internal static class F1Policy
  {
    public const string ControllerMode = "guarded-f1-controller";
    public const string SubjectMode = "guarded-f1-subject";
    public const string PlanHash = "2de900f8e84dd881a9654f202dfcb651f8e143f1a817a5c1cee3db62e4ea82ad";
    public const string EnvironmentHash = "af4ce4ad3d0efb7b67b36b92149fde28a7723b79bd60e65eecc22c56402c67bd";
    public static readonly string[] Phases = {
      "observer-calibration", "powershell-normal-capability-1", "powershell-normal-capability-2",
      "powershell-unavailable-capability", "fresh-install", "negative-preflight", "old22-negative",
      "positive-preflight", "old-normal-removal-positive", "rebuild-old-install", "upgrade-negative-preflight", "guarded-new-upgrade"
    };
    internal static bool IsF1(FixtureSpec spec) { return spec != null && (spec.mode == ControllerMode || spec.mode == SubjectMode); }
    internal static bool Hash(string value) { return value != null && System.Text.RegularExpressions.Regex.IsMatch(value, "\\A[0-9a-f]{64}\\z"); }
    internal static bool Commit(string value) { return value != null && System.Text.RegularExpressions.Regex.IsMatch(value, "\\A[0-9a-f]{40}\\z"); }
    internal static bool CanaryRegistryCleanupKnown(bool resumeAttempted, bool naturalExitZero) { return !resumeAttempted || naturalExitZero; }
    internal static bool Audited(string phase) { return phase == "old22-negative" || phase == "guarded-new-upgrade"; }

    internal static void Blob(F1BlobPin pin)
    {
      CorePolicy.Require(pin != null && pin.bytes > 0 && pin.bytes <= 4294967296L && Hash(pin.sha256), "f1-exact-blob-pin");
      CorePolicy.ValidateAbsolutePath(pin.file);
    }

    internal static void ValidatePrepared(FixtureSpec spec, bool subject)
    {
      CorePolicy.Require(spec != null && spec.version == 1 && spec.executionStage == "F1"
        && spec.mode == (subject ? SubjectMode : ControllerMode), "f1-separate-explicit-mode");
      CorePolicy.Require(spec.runId == "52f4ce19-5ded-4b27-8268-a2840809e0ca" && spec.generation == 1
        && spec.owner == "codex:local:01a1c9a5-381e-7b33-9648-c8968b61de4c", "f1-original-owner-generation");
      CorePolicy.Require(spec.frozenPlanManifestSha256 == PlanHash && spec.argvEnvPlanSha256 == EnvironmentHash, "f1-independent-plan-binding");
      F1InputBindings f = spec.f1;
      CorePolicy.Require(f != null && f.version == 1 && Commit(f.candidateSourceHead) && Commit(f.stageASourceHead)
        && f.stageARunId > 0 && f.stageAArtifactId > 0 && f.fixtureBytes > 0 && Hash(f.stageAArtifactSha256), "f1-source-a-binding");
      CorePolicy.Require((!spec.realExecutionAdmitted && f.status == "proposed" && f.activationHead == null)
        || (spec.realExecutionAdmitted && f.status == "admitted" && Commit(f.activationHead)), "f1-no-inherited-activation");
      CorePolicy.Require(Hash(spec.expectedBinarySha256) && spec.sourcePins != null && spec.sourcePins.Count == CorePolicy.SourceNames.Length
        && spec.sourcePins.Select(pin => pin.file).Distinct(StringComparer.Ordinal).Count() == CorePolicy.SourceNames.Length
        && spec.sourcePins.All(pin => CorePolicy.SourceNames.Contains(pin.file) && Hash(pin.sha256)), "f1-exact-fixture-source-pins");
      Blob(f.stageAReceipt); Blob(f.oldMemberReceipt); Blob(f.newPackage == null ? null : f.newPackage.setup);
      F1PackagePin package = f.newPackage; Blob(package.buildReceipt); Blob(package.memberReceipt);
      CorePolicy.Require(package.sourceHead == f.candidateSourceHead && !String.IsNullOrEmpty(package.displayVersion)
        && package.displayVersion.Length <= 32 && package.setup.bytes >= 104857600 && package.setup.sha256 != CorePolicy.SetupHash
        && package.uninstallerBytes > 0 && Hash(package.uninstallerSha256) && package.uninstallerSha256 != CorePolicy.UninstallerHash
        && package.guardedRemovalBytes > 0 && Hash(package.guardedRemovalSha256),
        "f1-current-full-package-not-a-tiny-fixture");
      CorePolicy.Require(package.archiveLiteral != null && package.archiveLiteral.Length < 256
        && !package.archiveLiteral.Any(c => c == '*' || c == '?' || c == ':' || Char.IsControl(c))
        && !package.archiveLiteral.StartsWith("\\", StringComparison.Ordinal)
        && !package.archiveLiteral.Split(new char[] { '\\', '/' }).Any(part => part == ".." || part == "." || part.Length == 0), "f1-exact-new-archive-literal");
      CorePolicy.Require(package.payloads != null && package.payloads.All(pin => pin != null) && package.payloads.Count >= 3 && package.payloads.Count <= 20000
        && package.payloads.Select(pin => pin.relativePath).Distinct(StringComparer.OrdinalIgnoreCase).Count() == package.payloads.Count
        && package.payloads.Count(pin => pin.kind == "app-asar") == 1 && package.payloads.Any(pin => pin.kind == "sidecar")
        && package.payloads.Count(pin => pin.kind == "app-exe") == 1, "f1-new-payload-manifest");
      foreach (F1PayloadPin pin in package.payloads)
      {
        CorePolicy.Require(pin != null && pin.bytes > 0 && Hash(pin.sha256) && pin.relativePath != null
          && pin.relativePath.Length < 512 && pin.relativePath.IndexOfAny(new char[] { ':', '*', '?', '\r', '\n', '\0' }) < 0
          && !pin.relativePath.StartsWith("\\", StringComparison.Ordinal) && !pin.relativePath.StartsWith("/", StringComparison.Ordinal)
          && !pin.relativePath.Split(new char[] { '\\', '/' }).Any(part => part.Length == 0 || part == "." || part == ".."), "f1-relative-payload-pin");
        CorePolicy.Require(pin.kind == "app-asar" || pin.kind == "app-exe" || pin.kind == "sidecar" || pin.kind == "payload", "f1-known-payload-kind");
        if (pin.kind == "app-asar") CorePolicy.Require(CorePolicy.SamePath(pin.relativePath, @"resources\app.asar"), "f1-app-asar-location");
        if (pin.kind == "app-exe") CorePolicy.Require(CorePolicy.SamePath(pin.relativePath, "Claude Code Haha.exe"), "f1-app-exe-location");
      }
      foreach (string path in new string[] { spec.gitRoot, spec.sourceRoot, spec.controllerRoot, spec.output, spec.setupPath }) CorePolicy.ValidateAbsolutePath(path);
      CorePolicy.Require(!CorePolicy.IsInside(spec.gitRoot, spec.controllerRoot) && !CorePolicy.SamePath(spec.gitRoot, spec.controllerRoot)
        && !CorePolicy.SamePath(spec.controllerRoot, spec.gitRoot), "f1-controller-boundaries");
      if (!subject) CorePolicy.Require(CorePolicy.IsInside(spec.controllerRoot, spec.output)
        && !CorePolicy.IsInside(spec.controllerRoot, spec.sourceRoot) && !CorePolicy.SamePath(spec.controllerRoot, spec.sourceRoot), "f1-controller-output-and-inputs");
      else
      {
        CorePolicy.AssertPaths(spec.knownPaths, spec.profilePath);
        foreach (string path in new string[] { spec.fixtureRoot, spec.tempRoot, spec.installRoot, spec.uninstallerCopy, spec.subjectSpecPath }) CorePolicy.ValidateAbsolutePath(path);
        CorePolicy.Require(spec.expectedSid != null && spec.expectedSid.StartsWith("S-1-5-21-", StringComparison.Ordinal)
          && spec.expectedSid != spec.expectedControllerSid && spec.expectedControllerPid > 0 && !String.IsNullOrEmpty(spec.expectedControllerCreationTime)
          && CorePolicy.IsInside(spec.profilePath, spec.fixtureRoot) && CorePolicy.IsInside(spec.fixtureRoot, spec.tempRoot)
          && CorePolicy.IsInside(spec.fixtureRoot, spec.uninstallerCopy) && CorePolicy.IsInside(spec.fixtureRoot, spec.output)
          && CorePolicy.IsInside(spec.controllerRoot, spec.subjectSpecPath) && CorePolicy.IsInside(spec.controllerRoot, spec.sourceRoot)
          && !CorePolicy.IsInside(spec.gitRoot, spec.profilePath)
          && CorePolicy.SamePath(spec.installRoot, Path.Combine(spec.knownPaths.userPrograms, "Claude Code Haha")), "f1-subject-exact-owned-paths");
        string input = Path.Combine(spec.controllerRoot, "subject-input");
        CorePolicy.Require(CorePolicy.SamePath(spec.subjectSpecPath, Path.Combine(input, "subject.json"))
          && CorePolicy.SamePath(spec.sourceRoot, Path.Combine(input, "sources"))
          && CorePolicy.SamePath(spec.setupPath, Path.Combine(input, "old-setup.exe"))
          && CorePolicy.SamePath(f.stageAReceipt.file, Path.Combine(input, "f1-stage-a-receipt.json"))
          && CorePolicy.SamePath(f.oldMemberReceipt.file, Path.Combine(input, "f1-old-member-proof.json"))
          && CorePolicy.SamePath(package.buildReceipt.file, Path.Combine(input, "f1-build-receipt.json"))
          && CorePolicy.SamePath(package.memberReceipt.file, Path.Combine(input, "f1-new-member-proof.json"))
          && CorePolicy.SamePath(package.setup.file, Path.Combine(input, "f1-new-full-setup.exe")), "f1-subject-exact-readonly-input-copies");
        CorePolicy.Require(spec.nonce != null && spec.nonce.Length == 32 && spec.pipeName == "CcHaha1879-" + spec.nonce
          && spec.hiveKey == @"Software\CcHaha1879Fixture\" + spec.nonce && spec.hiveNonce != null && spec.hiveNonce.Length == 32
          && spec.desktopName != null && spec.desktopName.IndexOf('\\') > 0, "f1-subject-private-object-bindings");
      }
    }

    internal static void RequireRoleIdentity(FixtureSpec spec, bool subject)
    {
      CorePolicy.Require(spec != null && spec.mode == (subject ? SubjectMode : ControllerMode) && spec.executionStage == "F1"
        && spec.runId == "52f4ce19-5ded-4b27-8268-a2840809e0ca" && spec.generation == 1
        && spec.owner == "codex:local:01a1c9a5-381e-7b33-9648-c8968b61de4c"
        && spec.frozenPlanManifestSha256 == PlanHash && spec.argvEnvPlanSha256 == EnvironmentHash, "f1-separate-fixed-role-identity");
    }

    internal static string BindingHash(FixtureSpec spec)
    {
      F1InputBindings f = spec.f1; F1PackagePin p = f.newPackage;
      List<string> rows = new List<string> { spec.version.ToString(), f.version.ToString(), spec.mode, spec.executionStage, spec.owner, spec.runId, spec.generation.ToString(),
        spec.realExecutionAdmitted.ToString(), spec.expectedBinarySha256, spec.frozenPlanManifestSha256, spec.argvEnvPlanSha256,
        f.status, f.activationHead, f.candidateSourceHead, f.stageASourceHead, f.stageARunId.ToString(), f.stageAArtifactId.ToString(),
        f.fixtureBytes.ToString(), f.stageAArtifactSha256, p.sourceHead, p.displayVersion, p.archiveLiteral,
        p.uninstallerBytes.ToString(), p.uninstallerSha256, p.guardedRemovalBytes.ToString(), p.guardedRemovalSha256 };
      foreach (F1BlobPin blob in new F1BlobPin[] { f.stageAReceipt, f.oldMemberReceipt, p.setup, p.buildReceipt, p.memberReceipt })
      { rows.Add(blob.bytes.ToString()); rows.Add(blob.sha256); }
      foreach (SourcePin pin in spec.sourcePins.OrderBy(pin => pin.file, StringComparer.Ordinal)) { rows.Add(pin.file); rows.Add(pin.sha256); }
      foreach (F1PayloadPin pin in p.payloads.OrderBy(pin => pin.relativePath, StringComparer.Ordinal))
      { rows.Add(pin.kind); rows.Add(pin.relativePath); rows.Add(pin.bytes.ToString()); rows.Add(pin.sha256); }
      // Input file locations are deliberately excluded: Native copies the exact
      // verified bytes into new readonly subject inputs before changing paths.
      return CorePolicy.HashText(String.Join("", rows.Select(row => row == null ? "-1:" : row.Length.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + row)));
    }

    internal static void RequireNativeAdmission(FixtureSpec spec, bool auditAvailable)
    {
      CorePolicy.Require(IsF1(spec) && spec.realExecutionAdmitted && spec.f1 != null && spec.f1.status == "admitted"
        && Commit(spec.f1.activationHead) && auditAvailable, "f1-native-audit-and-separate-activation-required-before-account");
    }

    internal static void RequireArmed(F1AuditEvidence a, ProtocolMessage start, FixtureSpec spec, string specSha)
    {
      CorePolicy.Require(a != null && a.status == "armed" && a.phase == start.phase && a.nonce == spec.nonce
        && a.specSha256 == specSha && a.rootPid == start.pid && a.rootCreationTime == start.creationTime
        && a.fileWriteRestoreCalibrated && a.registrySetRestoreCalibrated && a.calibrationFinalStateEqual
        && a.mapsComplete && a.rootsAndRegistryParentsComplete && !a.gap && a.eventsLost == 0 && a.buffersLost == 0
        && a.armedSequence > 0 && a.ackSequence == 0, "f1-calibrated-owned-audit-before-ack");
    }

    internal static void RequireCompleteAudit(F1AuditEvidence a, string phase, bool native)
    {
      CorePolicy.Require(Audited(phase) && a != null && a.status == (native ? "native-complete" : "replay-complete") && a.phase == phase
        && a.fileWriteRestoreCalibrated && a.registrySetRestoreCalibrated && a.calibrationFinalStateEqual
        && a.mapsComplete && a.rootsAndRegistryParentsComplete && a.allPeJobsNaturallyExited && a.closed && !a.gap
        && a.eventsLost == 0 && a.buffersLost == 0 && a.armedSequence > 0 && a.ackSequence > a.armedSequence
        && a.endSequence > a.ackSequence && a.operations != null && a.operations.Count <= 100000,
        "f1-complete-lossless-owned-operation-stream");
      long previous = a.ackSequence;
      foreach (F1AuditOperation op in a.operations)
      {
        CorePolicy.Require(op != null && op.sequence > previous && op.sequence < a.endSequence && Hash(op.objectId)
          && new string[] { "old-payload", "old-registry", "new-payload", "new-registry", "kept-data", "shortcut" }.Contains(op.scope)
          && new string[] { "read", "write", "rename", "delete", "create" }.Contains(op.kind) && op.resultKnown, "f1-known-ordered-mapped-operation");
        previous = op.sequence;
        if (phase == "old22-negative") CorePolicy.Require(op.kind == "read", "f1-old22-no-protected-mutation-observed");
      }
      if (phase != "guarded-new-upgrade") return;
      CorePolicy.Require(a.oldUninstallerExitCode == 22 && a.oldUninstallerSha256 == CorePolicy.UninstallerHash && Hash(a.trustedRemovalSha256)
        && a.oldUninstallerExit22Sequence > a.ackSequence && a.trustedRemovalStartSequence > a.oldUninstallerExit22Sequence
        && a.trustedRemovalStartSequence < a.endSequence, "f1-real-old22-before-trusted-component");
      CorePolicy.Require(a.stagingIdentityCoverage && a.oldPayloadObjects != null && a.oldPayloadObjects.Count > 0
        && a.oldPayloadObjects.Count <= 20000 && a.oldPayloadObjects.All(Hash) && a.oldPayloadObjects.Distinct().Count() == a.oldPayloadObjects.Count
        && a.oldRegistryObjects != null && a.oldRegistryObjects.Count >= 2 && a.oldRegistryObjects.Count <= 4
        && a.oldRegistryObjects.All(Hash) && a.oldRegistryObjects.Distinct().Count() == a.oldRegistryObjects.Count, "f1-complete-old-removal-inventory");
      HashSet<string> payload = new HashSet<string>(a.oldPayloadObjects), registry = new HashSet<string>(a.oldRegistryObjects);
      bool newPayload = false, newRegistry = false;
      foreach (F1AuditOperation op in a.operations)
      {
        if (op.kind != "read") CorePolicy.Require(op.succeeded && op.sequence > a.trustedRemovalStartSequence, "f1-successful-mutation-after-trusted-component");
        if (op.kind == "delete") CorePolicy.Require(op.objectRetired, "f1-delete-must-retire-the-actual-old-object");
        if (op.scope == "kept-data") CorePolicy.Require(op.kind == "read", "f1-kept-data-not-mutated");
        if (op.scope == "shortcut" && op.kind != "read") CorePolicy.Require(payload.Count == 0 && registry.Count == 0, "f1-shortcuts-survive-removal-window");
        if (op.kind == "delete" && op.scope == "old-payload") CorePolicy.Require(payload.Remove(op.objectId), "f1-known-old-payload-deletion");
        if (op.kind == "delete" && op.scope == "old-registry") CorePolicy.Require(registry.Remove(op.objectId), "f1-known-old-registry-deletion");
        if (op.scope == "new-payload" || op.scope == "new-registry")
        {
          CorePolicy.Require(payload.Count == 0 && registry.Count == 0, "f1-old-removal-before-any-new-install-write");
          if (op.kind == "create" && op.scope == "new-payload") newPayload = true;
          if (op.kind == "create" && op.scope == "new-registry") newRegistry = true;
        }
      }
      CorePolicy.Require(payload.Count == 0 && registry.Count == 0 && newPayload && newRegistry, "f1-removal-and-new-creation-both-observed");
    }
  }

  internal sealed class F1PhaseState : IDisposable
  {
    private readonly FixtureSpec spec;
    private readonly string specSha;
    private readonly bool native;
    private int next;
    private ProtocolMessage active;
    private F1AuditLease lease;
    private bool ackAttempted, oldRemoval, rebuilt, upgraded;
    internal F1PhaseState(FixtureSpec input, string hash, bool real) { spec = input; specSha = hash; native = real; }
    internal void Prepare(ProtocolMessage message, F1AuditLease audit)
    {
      try
      {
        CorePolicy.Require(active == null && next < F1Policy.Phases.Length && message != null && message.phase == F1Policy.Phases[next]
          && message.pid > 0 && !String.IsNullOrEmpty(message.creationTime), "f1-one-ordered-phase-before-ack");
        if (F1Policy.Audited(message.phase)) { F1Policy.RequireArmed(audit == null ? null : audit.Arming, message, spec, specSha); lease = audit; }
        else CorePolicy.Require(audit == null, "f1-no-audit-scope-substitution");
        active = message; ackAttempted = false;
      }
      catch { if (audit != null) { try { audit.Dispose(); } catch { audit.RecordClosureFailure(); } } throw; }
    }
    internal void BeforeAck()
    {
      CorePolicy.Require(active != null && !ackAttempted, "f1-single-ack-attempt");
      if (lease != null) lease.BeforeAck();
      ackAttempted = true;
    }
    internal void Complete(ProtocolMessage message)
    {
      CorePolicy.Require(active != null && ackAttempted && message != null && message.phase == active.phase
        && message.evidence != null && message.evidence.phase == active.phase, "f1-completion-after-owned-ack");
      bool failed = true;
      try
      {
        if (lease != null)
        {
          F1AuditEvidence a = lease.Complete();
          CorePolicy.Require(a != null && a.nonce == spec.nonce && a.specSha256 == specSha && a.rootPid == active.pid
            && a.rootCreationTime == active.creationTime, "f1-audit-completion-identity");
          F1Policy.RequireCompleteAudit(a, active.phase, native);
          if (active.phase == "guarded-new-upgrade") CorePolicy.Require(a.trustedRemovalSha256 == spec.f1.newPackage.guardedRemovalSha256, "f1-exact-packaged-trusted-component");
          message.evidence.protectedMutationAudit = a;
        }
        if (active.phase == "old-normal-removal-positive") oldRemoval = message.evidence.payloadRemoved && message.evidence.registrationRemoved && message.evidence.keptDataUnchanged;
        if (active.phase == "rebuild-old-install") { CorePolicy.Require(oldRemoval && message.evidence.oldStateEquivalent, "f1-equivalent-old-state-rebuilt-after-real-removal"); rebuilt = true; }
        if (active.phase == "guarded-new-upgrade")
        {
          CorePolicy.Require(oldRemoval && rebuilt && message.evidence.newPackageInstalled && message.evidence.legacyOnlyCanaryRemoved
            && message.evidence.helperAlive && message.evidence.keptDataUnchanged && message.evidence.shortcutTargetsUnchanged,
            "f1-full-upgrade-and-independent-removal-postconditions"); upgraded = true;
        }
        next++; active = null; failed = false;
      }
      finally { CloseLease(failed); }
    }
    internal void RequireFinished() { CorePolicy.Require(active == null && next == F1Policy.Phases.Length && oldRemoval && rebuilt && upgraded, "f1-complete-native-scenario-required"); }
    private void CloseLease(bool preserveFirstFailure)
    {
      if (lease == null) return;
      try { lease.Dispose(); CorePolicy.Require(lease.AllResourcesKnownClosed, "f1-audit-resources-not-proven-closed"); }
      catch { lease.RecordClosureFailure(); if (!preserveFirstFailure) throw; }
      finally { lease = null; }
    }
    public void Dispose() { CloseLease(false); }
  }

  internal static class CorePolicy
  {
    public const string SetupHash = "dca6bb82f4d0fbee8d43c91912e4d50e7dcea69a7cb22c51cdd9cb265767c7e7";
    public const long SetupBytes = 230611497;
    public const string UninstallerHash = "b0242b31b839cc8bf40ba4ac492004629bcf8ed28f8648d8c46b1797f7befb60";
    public const long UninstallerBytes = 174881;
    public const string ProductGuid = "f01cf2f0-8fe7-55b9-af4b-027bcf9c2cfe";
    public const string PlanHash = "71bd11ce0f76cd98de7dbbe429f00269782e8c9e64156a2d0b493578c93a5376";
    public const string EnvironmentPlanHash = "c43a2ecd835e2c090a2058dc54f83cc0c2df06fafc087e8d6ef26a4061fb4e5f";
    public const string ProfileOnlyPlanHash = "60e087a037ab8cd6ff9115615f9426b01f261236ccaa267c955677eeb4d6e672";
    public const string ProfileOnlyEnvironmentPlanHash = "d2e740b8d48b87b3e34a53cec9f9400bd08797b17538ab8cb1f0cc548736451a";
    public const string BadClr = "v0.0.0-test-invalid-clr";
    public static readonly string[] SourceNames = {
      "windows-installer-profile-fixture.cs", "windows-installer-profile-native.cs", "windows-installer-profile-fixture-tests.cs"
    };
    public static readonly string[] LegacyNames = {
      "Claude Code Haha.exe", "claude-sidecar-x86_64-pc-windows-msvc.exe",
      "claude-sidecar-aarch64-pc-windows-msvc.exe", "claude-sidecar.exe",
      "OpenConsole.exe", "winpty-agent.exe", "rg.exe"
    };

    public static void Require(bool condition, string stage)
    {
      if (!condition) throw new FixtureFailure(stage);
    }

    public static string BinaryPath
    {
      get { return Path.GetFullPath(System.Reflection.Assembly.GetExecutingAssembly().Location); }
    }

    public static string HashFile(string path)
    {
      using (SHA256 hash = SHA256.Create())
      using (FileStream input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        return Hex(hash.ComputeHash(input));
    }

    public static string HashText(string text)
    {
      using (SHA256 hash = SHA256.Create()) return Hex(hash.ComputeHash(Encoding.UTF8.GetBytes(text)));
    }

    public static string Hex(byte[] bytes)
    {
      StringBuilder text = new StringBuilder(bytes.Length * 2);
      foreach (byte value in bytes) text.Append(value.ToString("x2"));
      return text.ToString();
    }

    public static string NormalizePath(string path)
    {
      string value = path.Replace('/', '\\');
      if (value.StartsWith(@"\\?\", StringComparison.Ordinal)) value = value.Substring(4);
      return value.TrimEnd('\\');
    }

    public static bool SamePath(string left, string right)
    {
      return left != null && right != null && String.Equals(NormalizePath(left), NormalizePath(right), StringComparison.OrdinalIgnoreCase);
    }

    public static bool IsInside(string root, string candidate)
    {
      return root != null && candidate != null && NormalizePath(candidate).StartsWith(NormalizePath(root) + "\\", StringComparison.OrdinalIgnoreCase);
    }

    public static void ValidateAbsolutePath(string path)
    {
      Require(!String.IsNullOrEmpty(path) && path.Length < 800 && path.IndexOfAny(new char[] { '\0', '\r', '\n', '"' }) < 0, "path-characters");
      Require(path.Length > 3 && Char.IsLetter(path[0]) && path[1] == ':' && (path[2] == '\\' || path[2] == '/'), "local-absolute-path");
      Require(!path.Split(new char[] { '\\', '/' }).Any(part => part == "." || part == ".."), "path-components");
      Require(path.IndexOf(':', 2) < 0 && !path.EndsWith(" ", StringComparison.Ordinal), "path-stream-or-tail");
    }

    // Read-only namespace metadata only. The owned/destructive path validator
    // above deliberately continues to reject a volume root.
    internal static string[] ProfileParentPaths(string profilesDirectory, string directory)
    {
      ValidateAbsolutePath(profilesDirectory); ValidateAbsolutePath(directory);
      string profiles = NormalizePath(profilesDirectory), current = NormalizePath(directory);
      Require(SamePath(profiles, current) || IsInside(profiles, current), "Profile parent is outside verified ProfilesDirectory");
      List<string> parents = new List<string>();
      while (true)
      {
        Require(parents.Count < 32, "Profile parent chain is unbounded");
        parents.Add(current);
        if (current.Length == 3) break;
        int separator = current.LastIndexOf('\\');
        Require(separator >= 2, "Profile parent chain lacks its local volume root");
        current = separator == 2 ? current.Substring(0, 3) : current.Substring(0, separator);
      }
      return parents.ToArray();
    }

    internal static void ValidateProfileAncestorPath(string path, string profilesDirectory, string directory)
    {
      Require(ProfileParentPaths(profilesDirectory, directory).Contains(path, StringComparer.OrdinalIgnoreCase),
        "Read-only ancestor pin is not on the verified ProfilesDirectory chain");
    }

    public static void AssertStandard(TokenIdentity identity, string expectedSid)
    {
      Require(identity != null && identity.sid == expectedSid && identity.tokenType == 1, "standard-primary-sid");
      Require(identity.integrityRid == 0x2000 && !identity.elevated && identity.elevationType == 1, "standard-medium-token");
      Require(identity.groups != null && identity.groups.Any(group => group == "S-1-5-32-545" || group.StartsWith("S-1-5-32-545|", StringComparison.Ordinal)), "users-token-group");
      string[] prohibitedGroups = { "S-1-5-32-544", "S-1-5-32-547", "S-1-5-32-548", "S-1-5-32-549", "S-1-5-32-550", "S-1-5-32-551", "S-1-5-32-552" };
      Require(!identity.groups.Any(group => prohibitedGroups.Any(sid => group == sid || group.StartsWith(sid + "|", StringComparison.Ordinal))), "no-admin-or-deny-only-admin");
      HashSet<string> allowed = new HashSet<string>(new string[] {
        "SeChangeNotifyPrivilege", "SeShutdownPrivilege", "SeUndockPrivilege", "SeIncreaseWorkingSetPrivilege", "SeTimeZonePrivilege"
      }, StringComparer.OrdinalIgnoreCase);
      Require(identity.privileges != null && identity.privileges.All(value => allowed.Contains(value.Split('|')[0])), "no-privileged-token-capability");
      Require(!String.IsNullOrEmpty(identity.authenticationId), "logon-authentication-id");
    }

    public static void AssertPaths(KnownPaths paths, string profile)
    {
      Require(paths != null && SamePath(paths.profile, profile), "actual-profile-path");
      foreach (string path in new string[] { paths.profile, paths.roaming, paths.local, paths.desktop, paths.programs, paths.startMenu, paths.userPrograms })
      {
        ValidateAbsolutePath(path);
        Require(SamePath(path, profile) || IsInside(profile, path), "known-folder-owned-profile");
      }
    }

    public static bool SamePaths(KnownPaths left, KnownPaths right)
    {
      return left != null && right != null && SamePath(left.profile, right.profile) && SamePath(left.roaming, right.roaming)
        && SamePath(left.local, right.local) && SamePath(left.desktop, right.desktop) && SamePath(left.programs, right.programs)
        && SamePath(left.startMenu, right.startMenu) && SamePath(left.userPrograms, right.userPrograms);
    }

    public static string SetupCommand(string setup, string root)
    {
      ValidateAbsolutePath(setup); ValidateAbsolutePath(root);
      return "\"" + setup + "\" /S /currentuser /D=" + root;
    }

    public static string UninstallerCommand(string executable, string root)
    {
      ValidateAbsolutePath(executable); ValidateAbsolutePath(root);
      return "\"" + executable + "\" /S /KEEP_APP_DATA /currentuser --keep-shortcuts --updated _?=" + root;
    }

    public static string SubjectCommand(string executable, string spec)
    {
      ValidateAbsolutePath(executable); ValidateAbsolutePath(spec);
      string command = "\"" + executable + "\" --role subject --spec \"" + spec + "\"";
      Require(command.Length <= 1023, "with-token-command-bound");
      return command;
    }

    public static Dictionary<string, string> BuildEnvironment(Dictionary<string, string> target, FixtureSpec spec, bool badClr)
    {
      Require(target != null && spec.knownPaths != null, "target-environment-source");
      Dictionary<string, string> environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      string[] allowed = {
        "SystemRoot", "WINDIR", "SystemDrive", "ComSpec", "OS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432",
        "NUMBER_OF_PROCESSORS", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles",
        "CommonProgramFiles(x86)", "CommonProgramW6432", "ProgramData", "ALLUSERSPROFILE",
        "USERPROFILE", "APPDATA", "LOCALAPPDATA", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH"
      };
      foreach (string name in allowed) if (target.ContainsKey(name)) environment[name] = target[name];
      Require(environment.ContainsKey("SystemRoot") && environment.ContainsKey("USERNAME") && environment.ContainsKey("USERDOMAIN"), "target-environment-required");
      Require(environment.ContainsKey("USERPROFILE") && SamePath(environment["USERPROFILE"], spec.profilePath), "environment-real-profile");
      Require(environment.ContainsKey("APPDATA") && SamePath(environment["APPDATA"], spec.knownPaths.roaming), "environment-real-roaming");
      Require(environment.ContainsKey("LOCALAPPDATA") && SamePath(environment["LOCALAPPDATA"], spec.knownPaths.local), "environment-real-local");
      ValidateAbsolutePath(environment["SystemRoot"]);
      environment["HOME"] = spec.profilePath;
      environment["TEMP"] = spec.tempRoot; environment["TMP"] = spec.tempRoot; environment["TMPDIR"] = spec.tempRoot;
      string windows = environment["SystemRoot"].TrimEnd('\\');
      environment["PATH"] = windows + @"\System32;" + windows + ";" + windows + @"\System32\Wbem;" + windows + @"\System32\WindowsPowerShell\v1.0";
      environment["CC_HAHA_DISABLE_TERMINAL_SHELL_ENV"] = "1";
      foreach (string suffix in new string[] { "CONFIG", "CACHE", "DATA", "STATE" })
        environment["XDG_" + suffix + "_HOME"] = Path.Combine(spec.fixtureRoot, "isolated-" + suffix.ToLowerInvariant());
      environment["GH_CONFIG_DIR"] = Path.Combine(spec.fixtureRoot, "gh");
      environment["CODEX_HOME"] = Path.Combine(spec.fixtureRoot, "codex");
      if (badClr) environment["COMPLUS_Version"] = BadClr;
      EnvironmentBlock(environment);
      return environment;
    }

    public static string EnvironmentBlock(Dictionary<string, string> environment)
    {
      Require(environment != null && environment.Count > 0 && environment.Count <= 64, "environment-count");
      StringBuilder block = new StringBuilder();
      HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      foreach (KeyValuePair<string, string> item in environment.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase))
      {
        Require(names.Add(item.Key), "unique-case-insensitive-environment");
        Require(!String.IsNullOrEmpty(item.Key) && item.Key.IndexOfAny(new char[] { '=', '\0', '\r', '\n' }) < 0
          && item.Value != null && item.Value.IndexOfAny(new char[] { '\0', '\r', '\n' }) < 0, "environment-encoding");
        block.Append(item.Key).Append('=').Append(item.Value).Append('\0');
      }
      block.Append('\0');
      Require(block.Length <= 16384, "bounded-environment");
      return block.ToString();
    }

    public static string EnvironmentHash(Dictionary<string, string> environment)
    {
      using (SHA256 hash = SHA256.Create()) return Hex(hash.ComputeHash(Encoding.Unicode.GetBytes(EnvironmentBlock(environment))));
    }

    public static void ValidateControllerSpec(FixtureSpec spec)
    {
      Require(spec != null && spec.version == 1 && spec.mode == "historical-v078-controller"
        && spec.executionStage == "B" && spec.realExecutionAdmitted, "explicit-stage-b-controller-admission");
      Require(spec.runId == "52f4ce19-5ded-4b27-8268-a2840809e0ca" && spec.generation == 1
        && spec.owner == "codex:local:01a1c9a5-381e-7b33-9648-c8968b61de4c", "original-owner-generation");
      Require(spec.frozenPlanManifestSha256 == PlanHash && spec.argvEnvPlanSha256 == EnvironmentPlanHash, "frozen-plan-binding");
      ValidateControllerPathsAndPins(spec);
      ValidateAbsolutePath(spec.setupPath);
    }

    public static void ValidateProfileOnlySpec(FixtureSpec spec)
    {
      Require(spec != null && spec.version == 1 && spec.mode == "createprofile-only-controller"
        && spec.executionStage == "profile-only" && spec.realExecutionAdmitted, "explicit-profile-only-admission");
      Require(spec.runId == "52f4ce19-5ded-4b27-8268-a2840809e0ca" && spec.generation == 1
        && spec.owner == "codex:local:01a1c9a5-381e-7b33-9648-c8968b61de4c", "profile-only-original-owner-generation");
      Require(spec.frozenPlanManifestSha256 == ProfileOnlyPlanHash
        && spec.argvEnvPlanSha256 == ProfileOnlyEnvironmentPlanHash, "profile-only-frozen-plan-binding");
      ValidateControllerPathsAndPins(spec);
      Require(!SamePath(spec.controllerRoot, spec.sourceRoot) && !IsInside(spec.sourceRoot, spec.controllerRoot)
        && !IsInside(spec.gitRoot, spec.sourceRoot), "profile-only-separate-private-inputs");
      // setupPath and historical subject fields are not consumed in this mode.
      // Identity is always created from a new nonce in Controller.NewState.
    }

    private static void ValidateControllerPathsAndPins(FixtureSpec spec)
    {
      foreach (string path in new string[] { spec.gitRoot, spec.sourceRoot, spec.controllerRoot, spec.output }) ValidateAbsolutePath(path);
      Require(!SamePath(spec.controllerRoot, spec.gitRoot) && !IsInside(spec.gitRoot, spec.controllerRoot)
        && IsInside(spec.controllerRoot, spec.output) && !IsInside(spec.controllerRoot, spec.sourceRoot), "controller-root-boundaries");
      Require(spec.expectedBinarySha256 != null && spec.expectedBinarySha256.Length == 64, "binary-pin-required");
      Require(spec.sourcePins != null && spec.sourcePins.Count == SourceNames.Length
        && spec.sourcePins.Select(pin => pin.file).Distinct(StringComparer.Ordinal).Count() == SourceNames.Length
        && spec.sourcePins.All(pin => SourceNames.Contains(pin.file) && pin.sha256 != null && pin.sha256.Length == 64), "exact-source-pins");
    }

    public static void ValidateBindings(FixtureSpec spec, ProfilePlatform platform)
    {
      ValidateFixtureBindings(spec, platform);
      FileIdentity setup = platform.IdentifyPath(spec.setupPath, false);
      Require(!setup.reparse && setup.bytes == SetupBytes && setup.sha256 == SetupHash, "exact-full-setup");
    }

    public static string F1SubjectCommand(string executable, string spec)
    {
      ValidateAbsolutePath(executable); ValidateAbsolutePath(spec);
      string command = "\"" + executable + "\" --role f1-subject --spec \"" + spec + "\"";
      Require(command.Length <= 1023, "f1-with-token-command-bound"); return command;
    }

    public static void ValidateF1Bindings(FixtureSpec spec, ProfilePlatform platform)
    {
      F1Policy.ValidatePrepared(spec, spec.mode == F1Policy.SubjectMode);
      ValidateBindings(spec, platform); // Same frozen old setup, self PE and exact three source bytes.
      F1InputBindings f = spec.f1;
      Require(platform.IdentifyPath(BinaryPath, false).bytes == f.fixtureBytes, "f1-stage-a-pe-size");
      foreach (F1BlobPin pin in new F1BlobPin[] { f.stageAReceipt, f.oldMemberReceipt, f.newPackage.buildReceipt, f.newPackage.memberReceipt, f.newPackage.setup })
      {
        FileIdentity file = platform.IdentifyPath(pin.file, false);
        Require(!file.reparse && !file.directory && file.bytes == pin.bytes && file.sha256 == pin.sha256, "f1-exact-readonly-input-bytes");
      }
      Require(new F1BlobPin[] { f.stageAReceipt, f.oldMemberReceipt, f.newPackage.buildReceipt, f.newPackage.memberReceipt }
        .All(pin => pin.bytes <= 16777216), "f1-bounded-receipt-inputs");
      F1StageAReceipt a = CoreJson.Read<F1StageAReceipt>(f.stageAReceipt.file);
      Require(a != null && a.version == 1 && a.status == "verified-stage-a" && a.sourceHead == f.stageASourceHead
        && a.runId == f.stageARunId && a.artifactId == f.stageAArtifactId && a.artifactSha256 == f.stageAArtifactSha256
        && a.fixtureBytes == f.fixtureBytes && a.fixtureSha256 == spec.expectedBinarySha256
        && a.sourcePins != null && a.sourcePins.Count == spec.sourcePins.Count
        && a.sourcePins.All(pin => spec.sourcePins.Any(expected => expected.file == pin.file && expected.sha256 == pin.sha256))
        && a.sourcePins.Select(pin => pin.file).Distinct(StringComparer.Ordinal).Count() == SourceNames.Length
        && a.rawReports != null && a.rawReports.Count >= 4 && a.rawReports.Count <= 12
        && a.rawReports.All(pin => pin != null && F1Policy.Hash(pin.sha256) && !String.IsNullOrEmpty(pin.file))
        && a.rawReports.Select(pin => pin.file).Distinct(StringComparer.Ordinal).Count() == a.rawReports.Count, "f1-stage-a-verified-receipt-binding");
      RequireMemberReceipt(CoreJson.Read<F1MemberReceipt>(f.oldMemberReceipt.file), SetupHash, SetupBytes,
        "$R0\\Uninstall Claude Code Haha.exe", UninstallerHash, UninstallerBytes);
      F1PackagePin package = f.newPackage;
      RequireMemberReceipt(CoreJson.Read<F1MemberReceipt>(package.memberReceipt.file), package.setup.sha256, package.setup.bytes,
        package.archiveLiteral, package.uninstallerSha256, package.uninstallerBytes);
      F1BuildReceipt build = CoreJson.Read<F1BuildReceipt>(package.buildReceipt.file);
      Require(build != null && build.version == 1 && build.kind == "full-electron-nsis-package" && build.sourceHead == package.sourceHead && build.displayVersion == package.displayVersion
        && build.setupBytes == package.setup.bytes && build.setupSha256 == package.setup.sha256
        && build.uninstallerBytes == package.uninstallerBytes && build.uninstallerSha256 == package.uninstallerSha256
        && build.guardedRemovalBytes == package.guardedRemovalBytes && build.guardedRemovalSha256 == package.guardedRemovalSha256
        && build.payloads != null && CoreJson.Serialize(build.payloads) == CoreJson.Serialize(package.payloads), "f1-current-full-build-receipt-binding");
    }

    private static void RequireMemberReceipt(F1MemberReceipt proof, string setupHash, long setupBytes, string literal, string memberHash, long memberBytes)
    {
      Require(proof != null && proof.version == 1 && proof.status == "member_proven" && proof.forcedType == "Nsis" && !proof.peExecuted
        && proof.literalMember == literal && proof.setup != null && proof.setup.sha256 == setupHash && proof.setup.bytes == setupBytes
        && proof.output != null && proof.output.sha256 == memberHash && proof.output.bytes == memberBytes, "f1-full-setup-static-member-receipt");
    }

    public static void ValidateProfileOnlyBindings(FixtureSpec spec, ProfilePlatform platform)
    {
      ValidateProfileOnlySpec(spec);
      ValidateFixtureBindings(spec, platform);
    }

    private static void ValidateFixtureBindings(FixtureSpec spec, ProfilePlatform platform)
    {
      Require(HashFile(BinaryPath) == spec.expectedBinarySha256, "exact-fixture-binary");
      foreach (SourcePin pin in spec.sourcePins)
      {
        string file = Path.Combine(spec.sourceRoot, pin.file);
        FileIdentity identity = platform.IdentifyPath(file, false);
        Require(!identity.reparse && identity.sha256 == pin.sha256, "exact-compiled-source");
      }
    }

    public static void ValidateSubjectSpec(FixtureSpec spec)
    {
      Require(spec != null && spec.version == 1 && spec.mode == "historical-v078-subject"
        && spec.executionStage == "B" && spec.realExecutionAdmitted, "explicit-stage-b-subject-admission");
      Require(spec.runId == "52f4ce19-5ded-4b27-8268-a2840809e0ca" && spec.generation == 1
        && spec.owner == "codex:local:01a1c9a5-381e-7b33-9648-c8968b61de4c"
        && spec.frozenPlanManifestSha256 == PlanHash && spec.argvEnvPlanSha256 == EnvironmentPlanHash, "subject-original-plan-binding");
      Require(spec.expectedSid != null && spec.expectedSid.StartsWith("S-1-5-21-", StringComparison.Ordinal)
        && spec.expectedSid != spec.expectedControllerSid && spec.expectedControllerPid > 0
        && !String.IsNullOrEmpty(spec.expectedControllerCreationTime), "subject-controller-identity-binding");
      AssertPaths(spec.knownPaths, spec.profilePath);
      foreach (string path in new string[] { spec.gitRoot, spec.sourceRoot, spec.controllerRoot, spec.fixtureRoot,
        spec.tempRoot, spec.installRoot, spec.uninstallerCopy, spec.subjectSpecPath, spec.setupPath, spec.output }) ValidateAbsolutePath(path);
      Require(IsInside(spec.profilePath, spec.fixtureRoot) && IsInside(spec.fixtureRoot, spec.tempRoot)
        && IsInside(spec.fixtureRoot, spec.uninstallerCopy) && IsInside(spec.fixtureRoot, spec.output)
        && SamePath(spec.installRoot, Path.Combine(spec.knownPaths.userPrograms, "Claude Code Haha"))
        && IsInside(spec.controllerRoot, spec.subjectSpecPath) && !IsInside(spec.gitRoot, spec.controllerRoot)
        && !IsInside(spec.gitRoot, spec.profilePath), "subject-exact-private-paths");
      Require(spec.nonce != null && spec.nonce.Length == 32 && spec.pipeName == "CcHaha1879-" + spec.nonce
        && spec.hiveKey == @"Software\CcHaha1879Fixture\" + spec.nonce && spec.hiveNonce != null && spec.hiveNonce.Length == 32
        && spec.desktopName != null && spec.desktopName.IndexOf('\\') > 0, "subject-private-object-bindings");
      Require(spec.sourcePins != null && spec.sourcePins.Count == SourceNames.Length
        && spec.sourcePins.Select(pin => pin.file).Distinct(StringComparer.Ordinal).Count() == SourceNames.Length
        && spec.sourcePins.All(pin => SourceNames.Contains(pin.file) && pin.sha256 != null && pin.sha256.Length == 64), "subject-exact-source-pins");
    }
  }

  internal static class Controller
  {
    private static void Stage(FixtureState state, string stage, Action action)
    {
      state.stage = stage; state.report.trace.Add(stage);
      try { action(); }
      finally { state.accountEverCreated |= state.accountCreated; state.profileEverCreated |= state.profileCreated; }
    }

    private static void Ledger(FixtureState state, ProfilePlatform api)
    {
      if (api.IsFake) { state.report.trace.Add("ledger-durable"); return; }
      CorePolicy.Require(state.controllerRootOwned, "owned-controller-ledger-root");
      CoreJson.AtomicWrite(state.ledgerPath, new Dictionary<string, object> {
        { "version", 1 }, { "runId", state.spec.runId }, { "owner", state.spec.owner }, { "generation", state.spec.generation },
        { "intentSam", state.sam }, { "marker", state.marker }, { "account", state.account },
        { "accountCreated", state.accountCreated }, { "accountBound", state.accountBound },
        { "profilePath", state.profilePath }, { "profileIdentity", state.profileIdentity },
        { "profileCreated", state.profileCreated }, { "profileLoaded", state.profileLoaded },
        { "accountDisabled", state.accountDisabled }, { "stage", state.stage }, { "specSha256", state.report.specSha256 }
      });
      state.report.trace.Add("ledger-durable");
    }

    public static FixtureState NewState(FixtureSpec spec, FixtureReport report)
    {
      string nonce = Guid.NewGuid().ToString("N");
      return new FixtureState {
        spec = spec, report = report, sam = "c1879_" + nonce.Substring(0, 12),
        marker = "CcHaha1879:" + spec.runId + ":" + nonce,
        ledgerPath = Path.Combine(spec.controllerRoot, "ledger.json")
      };
    }

    public static FixtureReport Run(FixtureState state, ProfilePlatform api)
    {
      if (state.spec.mode == "createprofile-only-controller") return RunProfileOnly(state, api);
      PositiveProcessObserver observer = null;
      Dictionary<string, string> hostBefore = null;
      try
      {
        if (F1Policy.IsF1(state.spec)) Stage(state, "f1-bindings-before-account", delegate {
          F1Policy.ValidatePrepared(state.spec, false);
          F1Policy.RequireNativeAdmission(state.spec, api.F1AuditAvailable);
          if (!api.IsFake) CorePolicy.ValidateF1Bindings(state.spec, api);
        });
        else if (!api.IsFake) CorePolicy.ValidateBindings(state.spec, api);
        Stage(state, "controller-preflight", delegate { api.PreflightController(state); });
        if (!api.IsFake)
        {
          hostBefore = RegistryEvidence.HostProducts(state.runnerSid);
          CorePolicy.Require(!hostBefore.Keys.Any(key => key.StartsWith("HKLM/", StringComparison.Ordinal)), "machine-product-conflict");
        }
        Stage(state, "creation-intent-ledger", delegate { Ledger(state, api); });
        using (SecretBuffer password = new SecretBuffer())
        {
          CreateOwnedProfileOnce(state, api, password);
          Stage(state, "enable-bound-account", delegate { api.SetOwnedAccountDisabled(state, false); Ledger(state, api); });
          Stage(state, "interactive-logon", delegate { api.Logon(state, password); });
        }
        Stage(state, "standard-primary-token", delegate {
          state.targetIdentity = api.InspectToken(state.token);
          CorePolicy.AssertStandard(state.targetIdentity, state.account.sid);
        });
        Stage(state, "load-user-profile", delegate { api.LoadProfile(state); Ledger(state, api); });
        Stage(state, "actual-known-folders", delegate {
          state.paths = api.QueryKnownPaths(state.token);
          CorePolicy.AssertPaths(state.paths, state.profilePath);
          state.spec.expectedSid = state.account.sid; state.spec.expectedControllerSid = state.runnerSid;
          state.spec.expectedControllerPid = state.runnerPid; state.spec.expectedControllerCreationTime = state.runnerCreationTime;
          state.spec.profilePath = state.profilePath; state.spec.knownPaths = state.paths;
          state.spec.nonce = Guid.NewGuid().ToString("N");
          state.spec.pipeName = "CcHaha1879-" + state.spec.nonce;
          state.spec.hiveKey = @"Software\CcHaha1879Fixture\" + state.spec.nonce;
          state.spec.hiveNonce = Guid.NewGuid().ToString("N");
          state.spec.fixtureRoot = Path.Combine(state.paths.local, "CcHaha1879Fixture", state.spec.nonce);
          state.spec.tempRoot = Path.Combine(state.spec.fixtureRoot, "temp");
          state.spec.installRoot = Path.Combine(state.paths.userPrograms, "Claude Code Haha");
          state.spec.uninstallerCopy = Path.Combine(state.spec.fixtureRoot, "old-uninstaller.exe");
        });
        Stage(state, "target-environment", delegate { state.targetEnvironment = CorePolicy.BuildEnvironment(api.TargetEnvironment(state), state.spec, false); });
        Stage(state, "target-hive-challenge", delegate { api.WriteHiveChallenge(state); });
        Stage(state, "private-noninteractive-desktop", delegate { api.CreatePrivateDesktop(state); state.spec.desktopName = state.desktopName; });
        Stage(state, "readonly-subject-inputs", delegate {
          api.PrepareSubjectAccess(state);
          FixtureSpec subject = CoreJson.Deserialize<FixtureSpec>(CoreJson.Serialize(state.spec));
          subject.mode = F1Policy.IsF1(state.spec) ? F1Policy.SubjectMode : "historical-v078-subject"; subject.controllerSpecSha256 = state.report.specSha256;
          subject.output = Path.Combine(subject.fixtureRoot, "subject-result.json");
          if (!api.IsFake) PersistReadonlySubjectSpec(state, subject);
        });
        Stage(state, "private-authenticated-pipe", delegate { state.channel = api.CreateControllerChannel(state); });
        Stage(state, "suspended-subject", delegate { api.CreateSubjectSuspended(state); });
        Stage(state, "subject-job-before-resume", delegate { api.AssignSubjectToOwnedJob(state); });
        Stage(state, "suspended-subject-identity", delegate { api.VerifySubject(state); CorePolicy.AssertStandard(state.subject.identity, state.account.sid); });
        Stage(state, "resume-trusted-subject", delegate { api.ResumeSubject(state); });
        Stage(state, "authenticate-subject-hello", delegate {
          ProtocolMessage hello = CoreJson.Deserialize<ProtocolMessage>(state.channel.ReadLine(30000));
          CorePolicy.Require(hello.version == 1 && hello.kind == "hello" && hello.nonce == state.spec.nonce
            && hello.pid == state.subject.pid && state.channel.PeerProcessId == state.subject.pid
            && hello.creationTime == state.subject.creationTime && hello.binarySha256 == state.spec.expectedBinarySha256
            && hello.specSha256 == state.spec.subjectSpecSha256, "authenticated-subject-message");
          CorePolicy.AssertStandard(hello.identity, state.account.sid);
          CorePolicy.Require(CorePolicy.SamePaths(hello.knownPaths, state.paths) && api.VerifyHiveResponse(state, hello.hiveResponse), "subject-profile-hive-proof");
        });
        if (!api.IsFake) observer = new PositiveProcessObserver(state.account.sid);
        Stage(state, "acknowledge-subject", delegate {
          state.channel.WriteLine(CoreJson.Serialize(new ProtocolMessage { kind = "ack", nonce = state.spec.nonce,
            specSha256 = state.spec.subjectSpecSha256, binarySha256 = state.spec.expectedBinarySha256 }));
          state.acknowledged = true;
        });
        Stage(state, "bounded-historical-subject", delegate { ReceivePhases(state, api, observer); });
        if (!api.IsFake) CorePolicy.Require(RegistryEvidence.Equal(hostBefore, RegistryEvidence.HostProducts(state.runnerSid)), "host-product-state-unchanged");
        state.report.Check("historical-profile-subject", true, "Historical facts only; profile compatibility remains disabled.");
        state.report.status = "passed";
      }
      catch (Exception error)
      {
        state.report.failedStage = state.stage ?? "source-binding";
        state.report.Check(state.report.failedStage, false, NativePlatform.SafeFailure(error));
      }
      finally
      {
        try { if (observer != null) observer.Dispose(); }
        catch (Exception error) { state.report.Check("cleanup-owned-observer", false, NativePlatform.SafeFailure(error)); }
        if (state.f1AuditResourceUncertain)
        {
          bool uncertain = state.f1AuditArmOutcomeUnknown;
          // PhaseState already attempted each lease's single Dispose. A query
          // failure is unknown, never a reason to skip disabling the bound SID
          // or to retry disposal while other owned resources are still live.
          foreach (F1AuditLease lease in state.f1AuditLeases)
          {
            try
            {
              if (lease == null) uncertain = true;
              else
              {
                if (lease.ClosureFailed) uncertain = true;
                if (!lease.AllResourcesKnownClosed) uncertain = true;
              }
            }
            catch (Exception error)
            {
              uncertain = true;
              if (lease != null) lease.RecordClosureFailure();
              state.report.Check("f1-audit-resource-closure-query", false, NativePlatform.SafeFailure(error));
            }
          }
          state.f1AuditResourceUncertain = uncertain;
          if (state.f1AuditResourceUncertain) state.report.Check("f1-audit-resource-closure", false, "Unknown audit resources retained; disable-only cleanup.");
        }
        Cleanup(state, api);
        state.report.realAccountsCreated = !api.IsFake && state.accountEverCreated ? 1 : 0;
        state.report.realProfilesCreated = !api.IsFake && state.profileEverCreated ? 1 : 0;
        state.report.finishedAtUtc = DateTime.UtcNow.ToString("o");
      }
      return state.report;
    }

    private static void PersistReadonlySubjectSpec(FixtureState state, FixtureSpec subject)
    {
      // Keep Windows-only ACL methods outside FakeAPI's JIT-compiled delegates.
      CoreJson.Write(state.spec.subjectSpecPath, subject);
      System.Security.AccessControl.FileSecurity security = new System.Security.AccessControl.FileSecurity();
      security.SetAccessRuleProtection(true, false);
      foreach (string sid in new string[] { state.runnerSid, "S-1-5-18" })
        security.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(new System.Security.Principal.SecurityIdentifier(sid),
          System.Security.AccessControl.FileSystemRights.FullControl, System.Security.AccessControl.AccessControlType.Allow));
      security.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(new System.Security.Principal.SecurityIdentifier(state.account.sid),
        System.Security.AccessControl.FileSystemRights.ReadAndExecute, System.Security.AccessControl.AccessControlType.Allow));
      File.SetAccessControl(state.spec.subjectSpecPath, security);
      state.spec.subjectSpecSha256 = CorePolicy.HashFile(state.spec.subjectSpecPath);
    }

    private static void CreateOwnedProfileOnce(FixtureState state, ProfilePlatform api, SecretBuffer password)
    {
      Stage(state, "create-disabled-account", delegate { api.CreateDisabledAccount(state, password); });
      CorePolicy.Require(state.accountCreated && state.account != null && state.account.marker == state.marker
        && state.account.sam == state.sam && state.account.sid != state.runnerSid
        && state.account.sid != null && state.account.sid.StartsWith("S-1-5-21-", StringComparison.Ordinal), "actual-created-sid");
      Stage(state, "sid-marker-ledger", delegate { Ledger(state, api); });
      state.accountBound = true;
      Ledger(state, api);
      Stage(state, "users-only-membership", delegate { api.AddUsersOnly(state); api.VerifyOwnedAccount(state, true); });
      Stage(state, "create-fresh-profile", delegate {
        CorePolicy.Require(state.profileCreationAttempts == 0 && !state.profileCreated && !state.profileOwnershipProven,
          "single-fresh-createprofile-attempt");
        state.profileCreationAttempts = 1; state.profileCreationUncertain = true;
        state.stage = "createprofile-call-armed"; state.report.trace.Add(state.stage); Ledger(state, api);
        state.stage = "create-fresh-profile";
        try
        {
          api.CreateFreshProfile(state);
          CorePolicy.Require(state.profileCreated && state.profileOwnershipProven && !state.profileCreationUncertain,
            "createprofile-owner-path-hive-lease-unproven");
          state.stage = "createprofile-owner-proven"; state.report.trace.Add(state.stage); Ledger(state, api);
          ReleaseProfileCreationPin(state);
        }
        catch
        {
          state.profileOwnershipProven = false; state.profileCreationUncertain = true;
          throw;
        }
      });
    }

    private static void ReleaseProfileCreationPin(FixtureState state)
    {
      IDisposable pin = state.profileCreationPin;
      state.profileCreationPin = null;
      if (pin != null) pin.Dispose();
    }

    private static FixtureReport RunProfileOnly(FixtureState state, ProfilePlatform api)
    {
      state.report.mode = "profile-only";
      try
      {
        CorePolicy.ValidateProfileOnlySpec(state.spec);
        if (!api.IsFake) CorePolicy.ValidateProfileOnlyBindings(state.spec, api);
        Stage(state, "controller-preflight", delegate { api.PreflightController(state); });
        Stage(state, "creation-intent-ledger", delegate { Ledger(state, api); });
        using (SecretBuffer password = new SecretBuffer()) CreateOwnedProfileOnce(state, api, password);
        CorePolicy.Require(state.accountDisabled && state.token == IntPtr.Zero && !state.profileLoaded && state.profile == IntPtr.Zero
          && state.subject == null && !state.acknowledged, "profile-only-no-historical-continuation");
        CorePolicy.Require(!state.report.releasedPeExecuted && !state.report.releasedPeMayHaveExecuted
          && state.report.releasedPeExecutionStatus == "not_run" && !state.report.compatibilityEnabled
          && state.report.oldExit22Policy == "fatal" && state.report.member_proven == "not_run"
          && state.report.installed_bytes_equal == "not_run" && state.report.old22_before_protected_mutation == "not_run"
          && state.report.removal_equivalence == "not_run" && state.report.full_old_to_new == "not_run", "profile-only-no-historical-evidence-claim");
        state.report.Check("profile-only-createprofile", true, "One owned disabled SID and one CreateProfile call; no logon, profile load or historical product execution.");
        state.report.status = "passed";
      }
      catch (Exception error)
      {
        state.report.failedStage = state.stage ?? "profile-only-source-binding";
        state.report.Check(state.report.failedStage, false, NativePlatform.SafeFailure(error));
      }
      finally
      {
        Cleanup(state, api);
        state.report.realAccountsCreated = !api.IsFake && state.accountEverCreated ? 1 : 0;
        state.report.realProfilesCreated = !api.IsFake && state.profileEverCreated ? 1 : 0;
        state.report.finishedAtUtc = DateTime.UtcNow.ToString("o");
      }
      return state.report;
    }

    internal static void SendPhaseAck(FixtureReport report, FixtureChannel channel, string nonce, string phase, bool native)
    {
      if (native && (phase == "fresh-install" || phase == "old22-negative" || phase == "old-normal-removal-positive"
        || phase == "rebuild-old-install" || phase == "guarded-new-upgrade"))
      {
        // A complete ACK may reach the subject even when the local async write
        // later fails or times out. Record uncertainty before attempting it.
        report.releasedPeMayHaveExecuted = true;
        report.releasedPeExecutionStatus = report.releasedPeExecuted
          ? "prior_resume_confirmed;latest_ack_attempted_resume_unknown" : "ack_attempted;resume_unconfirmed";
      }
      channel.WriteLine(CoreJson.Serialize(new ProtocolMessage { kind = "phase-ack", nonce = nonce, phase = phase }));
    }

    private static void ReceivePhases(FixtureState state, ProfilePlatform api, PositiveProcessObserver observer)
    {
      HashSet<string> phases = new HashSet<string>(StringComparer.Ordinal);
      bool f1Mode = state.spec.mode == F1Policy.ControllerMode;
      string[] sequence = f1Mode ? F1Policy.Phases : new string[] { "observer-calibration", "powershell-normal-capability-1", "powershell-normal-capability-2",
        "powershell-unavailable-capability", "fresh-install", "negative-preflight", "old22-negative",
        "positive-preflight", "old-normal-removal-positive" };
      int phaseIndex = 0;
      DateTime deadline = DateTime.UtcNow.AddMinutes(f1Mode ? 20 : 10);
      string active = null; F1AuditLease preparedAudit = null;
      using (F1PhaseState f1 = f1Mode ? new F1PhaseState(state.spec, state.report.specSha256, !api.IsFake) : null)
      {
      while (true)
      {
        CorePolicy.Require(DateTime.UtcNow < deadline, "subject-overall-deadline");
        int remaining = (int)Math.Max(1, (deadline - DateTime.UtcNow).TotalMilliseconds);
        int phaseBudget = active == "fresh-install" || active == "rebuild-old-install" || active == "guarded-new-upgrade" ? 305000
          : active == "old22-negative" || active == "old-normal-removal-positive" ? 185000 : 35000;
        ProtocolMessage message = CoreJson.Deserialize<ProtocolMessage>(state.channel.ReadLine(Math.Min(remaining, active == null ? 30000 : phaseBudget)));
        CorePolicy.Require(message.version == 1 && message.nonce == state.spec.nonce, "phase-nonce");
        if (message.kind == "audit-prepare")
        {
          CorePolicy.Require(f1Mode && active == null && preparedAudit == null && phaseIndex < sequence.Length && message.phase == sequence[phaseIndex] && F1Policy.Audited(message.phase), "f1-session-prepare-order");
          state.f1AuditResourceUncertain = true;
          try { preparedAudit = api.PrepareF1Audit(state, message.phase); CorePolicy.Require(preparedAudit != null, "f1-prepared-lease"); state.f1AuditLeases.Add(preparedAudit); }
          catch { state.f1AuditArmOutcomeUnknown = true; throw; }
          state.channel.WriteLine(CoreJson.Serialize(new ProtocolMessage { kind = "audit-ready", nonce = state.spec.nonce, phase = message.phase }));
        }
        else if (message.kind == "debug-stop")
        {
          CorePolicy.Require(f1Mode && active == message.phase && preparedAudit != null && message.debug != null, "f1-debug-during-owned-phase");
          F1DebugReply response = preparedAudit.Debug(message.debug);
          state.channel.WriteLine(CoreJson.Serialize(new ProtocolMessage { kind = "debug-ack", nonce = state.spec.nonce, phase = message.phase, debugReply = response }));
        }
        else if (message.kind == "phase-start")
        {
          CorePolicy.Require(active == null && message.phase != null && !phases.Contains(message.phase)
            && phaseIndex < sequence.Length && message.phase == sequence[phaseIndex], "one-ordered-owned-phase");
          api.VerifyReportedPhase(state, message);
          if (observer != null) observer.Arm(message.phase, message.pid, message.creationTime);
          if (f1 != null)
          {
            F1AuditLease audit = null;
            if (F1Policy.Audited(message.phase))
            {
              CorePolicy.Require(preparedAudit != null, "f1-session-before-root-start");
              audit = api.ArmF1Audit(state, message); CorePolicy.Require(Object.ReferenceEquals(audit, preparedAudit), "f1-single-session-attachment");
            }
            f1.Prepare(message, audit); f1.BeforeAck();
          }
          active = message.phase;
          SendPhaseAck(state.report, state.channel, state.spec.nonce, message.phase, !api.IsFake);
        }
        else if (message.kind == "phase-end")
        {
          CorePolicy.Require(active == message.phase && message.evidence != null && message.evidence.phase == active, "phase-completion-binding");
          bool unavailable = active == "old22-negative" || active == "old-normal-removal-positive" || active == "powershell-unavailable-capability"
            || active == "guarded-new-upgrade";
          Dictionary<string, string> expectedEnvironment = unavailable
            ? CorePolicy.BuildEnvironment(state.targetEnvironment, state.spec, true) : state.targetEnvironment;
          CorePolicy.Require(message.evidence.environmentSha256 == CorePolicy.EnvironmentHash(expectedEnvironment), "phase-environment-binding");
          int expectedExit = active == "observer-calibration" || active == "positive-preflight" ? 1 : active == "old22-negative" ? 22 : 0;
          CorePolicy.Require(active == "powershell-unavailable-capability" ? message.evidence.exitCode != 0
            : message.evidence.exitCode == expectedExit, "phase-native-exit");
          if (active == "fresh-install" || active == "rebuild-old-install") CorePolicy.Require(message.evidence.installedUninstallerSha256 == CorePolicy.UninstallerHash
            && message.evidence.argvSha256 == CorePolicy.HashText(CorePolicy.SetupCommand(state.spec.setupPath, state.spec.installRoot)), "installed-byte-and-argv-binding");
          if (active == "old22-negative" || active == "old-normal-removal-positive")
          {
            CorePolicy.Require(message.evidence.applicationSha256 == CorePolicy.UninstallerHash
              && message.evidence.argvSha256 == CorePolicy.HashText(CorePolicy.UninstallerCommand(state.spec.uninstallerCopy, state.spec.installRoot)), "same-old-binary-and-argv");
            if (active == "old22-negative") CorePolicy.Require(message.evidence.helperAlive && message.evidence.protectedFinalStateUnchanged, "negative-native-postconditions");
            else CorePolicy.Require(message.evidence.payloadRemoved && message.evidence.registrationRemoved && message.evidence.keptDataUnchanged, "positive-native-postconditions");
          }
          if (active == "guarded-new-upgrade") CorePolicy.Require(message.evidence.applicationSha256 == state.spec.f1.newPackage.setup.sha256
            && message.evidence.installedUninstallerSha256 == state.spec.f1.newPackage.uninstallerSha256
            && message.evidence.argvSha256 == CorePolicy.HashText(CorePolicy.SetupCommand(state.spec.f1.newPackage.setup.file, state.spec.installRoot)), "f1-full-package-phase-binding");
          if (f1 != null) { f1.Complete(message); preparedAudit = null; }
          if (observer != null)
          {
            message.evidence.fallbackObservation = observer.Complete(active);
            state.report.observations.AddRange(observer.Observed());
            CorePolicy.Require(!observer.Observed().Any(item => String.Equals(item.imageName, "Claude Code Haha.exe", StringComparison.OrdinalIgnoreCase)
              || item.imageName.StartsWith("claude-sidecar", StringComparison.OrdinalIgnoreCase)), "no-product-app-session");
            if (active == "observer-calibration" || active == "old22-negative" || active == "old-normal-removal-positive")
              CorePolicy.Require(message.evidence.fallbackObservation == "positive_tasklist_and_findstr_observed", "positive-fallback-observation");
          }
          state.report.phases.Add(message.evidence); phases.Add(active); phaseIndex++; active = null;
          if (!api.IsFake && (message.phase == "fresh-install" || message.phase == "old22-negative" || message.phase == "old-normal-removal-positive"
            || message.phase == "rebuild-old-install" || message.phase == "guarded-new-upgrade"))
          {
            state.report.releasedPeExecuted = true;
            state.report.releasedPeExecutionStatus = "resume_and_phase_completion_confirmed";
          }
          state.channel.WriteLine(CoreJson.Serialize(new ProtocolMessage { kind = "phase-end-ack", nonce = state.spec.nonce, phase = message.phase }));
        }
        else if (message.kind == "failed")
        {
          if (message.report != null)
          {
            state.report.releasedPeExecuted |= message.report.releasedPeExecuted;
            state.report.releasedPeMayHaveExecuted |= message.report.releasedPeMayHaveExecuted;
            if (message.report.releasedPeExecuted) state.report.releasedPeExecutionStatus = "subject_reported_resume_success_before_failure";
          }
          throw new FixtureFailure("subject-reported-failure");
        }
        else if (message.kind == "complete")
        {
          CorePolicy.Require(active == null && message.report != null && message.report.status == "passed"
            && message.report.cleanup == "passed" && message.report.compatibilityEnabled == false
            && message.report.oldExit22Policy == "fatal", "subject-complete");
          if (f1 != null) f1.RequireFinished();
          Stage(state, "subject-natural-exit", delegate {
            CorePolicy.Require(api.WaitSubjectExit(state, 30000) == 0, "subject-natural-exit-zero");
          });
          if (!api.IsFake)
          {
            CorePolicy.Require(phases.Contains("observer-calibration") && phases.Contains("fresh-install")
              && phases.Contains("old22-negative") && phases.Contains("old-normal-removal-positive"), "historical-required-phases");
            state.report.installed_bytes_equal = "native_equal_exact_pin";
            state.report.old22_before_protected_mutation = "native_exit22_and_final_state_equal_only;transient_operation_order_not_proven";
            state.report.removal_equivalence = "old_binary_positive_only;trusted_replacement_equivalence_not_run";
            if (f1 != null)
            {
              state.report.member_proven = "native_exact_old_and_current_full_setup_static_members_bound";
              state.report.old22_before_protected_mutation = "native_calibrated_lossless_owned_operation_stream_no_protected_mutation";
              state.report.removal_equivalence = "native_old_normal_reference_and_ordered_trusted_removal_equal";
              state.report.full_old_to_new = "native_exact_current_full_package_upgrade_and_kept_state_verified";
            }
            string evidenceDirectory = Path.Combine(state.spec.controllerRoot, "evidence");
            Directory.CreateDirectory(evidenceDirectory);
            foreach (KeyValuePair<string, string> file in message.report.evidenceFiles)
            {
              CorePolicy.Require((f1Mode ? new string[] { "negative-before.json", "negative-after.json", "positive-kept-before.json", "positive-kept-after.json", "f1-rebuilt-old.json", "f1-upgrade-kept-before.json", "f1-upgrade-kept-after.json" }
                : new string[] { "negative-before.json", "negative-after.json", "positive-kept-before.json", "positive-kept-after.json" }).Contains(file.Key), "bounded-evidence-file");
              string input = Path.Combine(state.spec.fixtureRoot, file.Key);
              FileIdentity identity = api.IdentifyPath(input, false);
              CorePolicy.Require(!identity.reparse && identity.bytes <= 16777216 && identity.sha256 == file.Value, "subject-evidence-file-binding");
              string output = Path.Combine(evidenceDirectory, file.Key);
              File.Copy(input, output, false);
              CorePolicy.Require(CorePolicy.HashFile(output) == file.Value, "copied-evidence-binding");
              state.report.evidenceFiles[file.Key] = file.Value;
            }
          }
          return;
        }
        else throw new FixtureFailure("unknown-phase-message");
      }
      }
    }

    public static void Cleanup(FixtureState state, ProfilePlatform api)
    {
      bool clean = true;
      try
      {
        Stage(state, "cleanup-owned-jobs", delegate { api.StopOwnedJobs(state); CorePolicy.Require(!api.HasOwnedSidProcesses(state), "no-unknown-owned-sid-process"); });
        Stage(state, "cleanup-runtime-handles", delegate { api.CloseRuntimeResources(state); });
        if (state.accountCreated)
        {
          CorePolicy.Require(state.accountBound && state.account != null, "cleanup-requires-bound-sid");
          Stage(state, "cleanup-disable-account", delegate { api.VerifyOwnedAccount(state, state.accountDisabled); api.SetOwnedAccountDisabled(state, true); });
        }
        CorePolicy.Require(!state.f1AuditResourceUncertain, "F1 audit state unknown; unload and destructive cleanup forbidden");
        if (state.profileLoaded)
        {
          Stage(state, "cleanup-unload-profile", delegate { api.UnloadProfile(state); });
          CorePolicy.Require(!state.profileLoaded, "profile-unload-confirmed");
        }
        if (state.profileCreationUncertain || (state.profileCreationAttempts != 0 && !state.profileOwnershipProven))
        {
          state.report.trace.Add("partial-profile-state=unknown; account-disabled-if-bound; profile-and-account-retained");
          throw new FixtureFailure("CreateProfile partial state unknown; destructive cleanup forbidden");
        }
        if (state.profileCreated)
        {
          Stage(state, "cleanup-hives-absent", delegate { CorePolicy.Require(api.HivesAbsent(state), "owned-hives-unloaded"); });
          Stage(state, "cleanup-delete-profile", delegate { api.DeleteOwnedProfile(state); });
          CorePolicy.Require(!state.profileCreated, "profile-delete-confirmed");
        }
        if (state.accountCreated) Stage(state, "cleanup-delete-account", delegate { api.DeleteOwnedAccount(state); });
        state.report.cleanup = "cleaned";
      }
      catch (Exception error)
      {
        clean = false; state.report.cleanup = "failed";
        state.report.Check("cleanup-deny-by-default", false, state.stage + ":" + NativePlatform.SafeFailure(error));
      }
      finally
      {
        try { ReleaseProfileCreationPin(state); }
        catch (Exception error) { clean = false; state.profileOwnershipProven = false; state.profileCreationUncertain = true;
          state.report.cleanup = "failed"; state.report.Check("cleanup-profile-pin", false, NativePlatform.SafeFailure(error)); }
        try { api.CloseTokenAndPrivileges(state); }
        catch (Exception error) { clean = false; state.report.cleanup = "failed"; state.report.Check("cleanup-token-handles", false, NativePlatform.SafeFailure(error)); }
        if (!clean) state.report.status = "failed";
      }
    }
  }

  internal static class RegistryEvidence
  {
    private static readonly string[] ProductKeys = {
      @"Software\" + CorePolicy.ProductGuid,
      @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + CorePolicy.ProductGuid
    };

    private static void ReadKey(RegistryKey parent, string path, string label, Dictionary<string, string> values, int depth)
    {
      CorePolicy.Require(depth <= 8 && values.Count <= 4096, "bounded-product-registry");
      using (RegistryKey key = parent.OpenSubKey(path, false))
      {
        if (key == null) return;
        values[label + "/@exists"] = "1";
        foreach (string name in key.GetValueNames().OrderBy(value => value, StringComparer.Ordinal))
        {
          object value = key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
          string rendered;
          if (value is byte[]) rendered = Convert.ToBase64String((byte[])value);
          else if (value is string[]) rendered = CoreJson.Serialize((string[])value);
          else rendered = Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
          values[label + "/" + name] = key.GetValueKind(name).ToString() + ":" + rendered;
        }
        foreach (string child in key.GetSubKeyNames().OrderBy(value => value, StringComparer.Ordinal))
          ReadKey(key, child, label + "/" + child, values, depth + 1);
      }
    }

    public static Dictionary<string, string> HostProducts(string runnerSid)
    {
      Dictionary<string, string> result = new Dictionary<string, string>(StringComparer.Ordinal);
      foreach (RegistryView view in new RegistryView[] { RegistryView.Registry32, RegistryView.Registry64 })
      {
        using (RegistryKey machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
          foreach (string key in ProductKeys) ReadKey(machine, key, "HKLM/" + view + "/" + key, result, 0);
        using (RegistryKey users = RegistryKey.OpenBaseKey(RegistryHive.Users, view))
          foreach (string key in ProductKeys) ReadKey(users, runnerSid + "\\" + key, "runner/" + view + "/" + key, result, 0);
      }
      return result;
    }

    public static Dictionary<string, string> OwnedProducts(string sid)
    {
      Dictionary<string, string> result = new Dictionary<string, string>(StringComparer.Ordinal);
      foreach (RegistryView view in new RegistryView[] { RegistryView.Registry32, RegistryView.Registry64 })
        using (RegistryKey users = RegistryKey.OpenBaseKey(RegistryHive.Users, view))
          foreach (string key in ProductKeys) ReadKey(users, sid + "\\" + key, view + "/" + key, result, 0);
      return result;
    }

    public static void RequireString(string sid, string relativeKey, string name, string expected)
    {
      int found = 0;
      foreach (RegistryView view in new RegistryView[] { RegistryView.Registry32, RegistryView.Registry64 })
        using (RegistryKey users = RegistryKey.OpenBaseKey(RegistryHive.Users, view))
        using (RegistryKey key = users.OpenSubKey(sid + "\\" + relativeKey, false))
        {
          if (key == null) continue;
          object value = key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
          if (value == null) continue;
          CorePolicy.Require(key.GetValueKind(name) == RegistryValueKind.String && (string)value == expected, "installed-registry-shape-" + name);
          found++;
        }
      CorePolicy.Require(found > 0, "installed-registry-present-" + name);
    }

    public static bool Equal(Dictionary<string, string> before, Dictionary<string, string> after)
    {
      return before != null && after != null && before.Count == after.Count
        && before.All(item => after.ContainsKey(item.Key) && after[item.Key] == item.Value);
    }
  }

  [DataContract]
  internal sealed class RebuiltPayloadEntry
  {
    [DataMember] public string kind;
    [DataMember] public long bytes;
    [DataMember] public string sha256;

    public bool SameContent(RebuiltPayloadEntry other)
    {
      if (other == null || kind != other.kind || bytes != other.bytes || sha256 != other.sha256) return false;
      if (kind == "directory" || kind == "absent") return bytes == 0 && sha256 == null;
      return kind == "file" && bytes >= 0 && sha256 != null && sha256.Length == 64
        && sha256.All(value => value >= '0' && value <= '9' || value >= 'a' && value <= 'f');
    }
  }

  [DataContract]
  internal sealed class ProtectedSnapshot
  {
    [DataMember] public Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.Ordinal);
    [DataMember] public Dictionary<string, RebuiltPayloadEntry> rebuildPayloadEntries = new Dictionary<string, RebuiltPayloadEntry>(StringComparer.Ordinal);
    [DataMember] public Dictionary<string, string> verifiedProductShortcutTargets = new Dictionary<string, string>(StringComparer.Ordinal);
    private static readonly string[] ProductShortcuts = { "desktop/Claude Code Haha.lnk", "programs/Claude Code Haha.lnk" };
    private long bytes;

    private void FileEntry(string label, string file, ProfilePlatform api, bool rebuildingPayload = false)
    {
      FileIdentity identity = api.IdentifyPath(file, false);
      CorePolicy.Require(!identity.reparse && identity.sha256 != null, "snapshot-ordinary-file");
      if (rebuildingPayload) CorePolicy.Require(!identity.directory, "f1-rebuild-file-type");
      bytes += identity.bytes;
      CorePolicy.Require(bytes <= 2147483648L && values.Count <= 20000, "bounded-protected-snapshot");
      values[label] = identity.fileId + ":" + identity.bytes + ":" + identity.sha256;
      if (rebuildingPayload) rebuildPayloadEntries[label] = new RebuiltPayloadEntry { kind = "file", bytes = identity.bytes, sha256 = identity.sha256 };
    }

    private void DirectoryEntry(string label, string directory, ProfilePlatform api, int depth, bool rebuildingPayload = false)
    {
      CorePolicy.Require(depth <= 32 && values.Count <= 20000, "bounded-protected-tree");
      if (!Directory.Exists(directory))
      {
        values[label] = "absent";
        if (rebuildingPayload) rebuildPayloadEntries[label] = new RebuiltPayloadEntry { kind = "absent" };
        return;
      }
      FileIdentity identity = api.IdentifyPath(directory, true);
      CorePolicy.Require(!identity.reparse, "no-snapshot-reparse-directory");
      if (rebuildingPayload) CorePolicy.Require(identity.directory, "f1-rebuild-directory-type");
      values[label + "/@directory"] = identity.fileId;
      if (rebuildingPayload) rebuildPayloadEntries[label + "/@directory"] = new RebuiltPayloadEntry { kind = "directory" };
      foreach (string file in Directory.GetFiles(directory).OrderBy(item => item, StringComparer.Ordinal))
        FileEntry(label + "/" + Path.GetFileName(file), file, api, rebuildingPayload);
      foreach (string child in Directory.GetDirectories(directory).OrderBy(item => item, StringComparer.Ordinal))
        DirectoryEntry(label + "/" + Path.GetFileName(child), child, api, depth + 1, rebuildingPayload);
    }

    public static ProtectedSnapshot Capture(FixtureSpec spec, ProfilePlatform api, bool payload)
    {
      ProtectedSnapshot snapshot = new ProtectedSnapshot();
      if (payload)
      {
        snapshot.DirectoryEntry("payload", spec.installRoot, api, 0, spec.mode == F1Policy.SubjectMode);
        foreach (KeyValuePair<string, string> value in RegistryEvidence.OwnedProducts(spec.expectedSid))
          snapshot.values["registry/" + value.Key] = value.Value;
      }
      snapshot.DirectoryEntry("appdata", Path.Combine(spec.knownPaths.roaming, "Claude Code Haha"), api, 0);
      snapshot.DirectoryEntry("claude", Path.Combine(spec.profilePath, ".claude"), api, 0);
      snapshot.DirectoryEntry("recovery", Path.Combine(spec.profilePath, "Claude Code Haha Data", "Recovered"), api, 0);
      foreach (KeyValuePair<string, string> root in new Dictionary<string, string> {
        { "desktop", spec.knownPaths.desktop }, { "programs", spec.knownPaths.programs }
      })
      {
        foreach (string name in new string[] { "Claude Code Haha.lnk", "CcHaha1879-canary.txt" })
        {
          string file = Path.Combine(root.Value, name);
          if (File.Exists(file))
          {
            snapshot.FileEntry(root.Key + "/" + name, file, api);
            if (payload && spec.mode == F1Policy.SubjectMode && name == "Claude Code Haha.lnk")
            {
              string target = ShortcutTarget.Read(file);
              CorePolicy.Require(CorePolicy.SamePath(target, Path.Combine(spec.installRoot, "Claude Code Haha.exe")), "f1-rebuild-actual-product-shortcut-target");
              snapshot.verifiedProductShortcutTargets[root.Key + "/" + name] = target;
            }
          }
          else snapshot.values[root.Key + "/" + name] = "absent";
        }
      }
      // Only the known updater store, never the entire profile or cache tree.
      // Released desktop/package.json name is claude-code-desktop; the pinned
      // AppInfo.updaterCacheDirName getter appends "-updater" to that name.
      snapshot.DirectoryEntry("updater", Path.Combine(spec.knownPaths.local, "claude-code-desktop-updater"), api, 0);
      return snapshot;
    }

    public bool Same(ProtectedSnapshot other) { return other != null && RegistryEvidence.Equal(values, other.values); }
    public bool SameRebuiltInstallation(ProtectedSnapshot other, string expectedShortcutTarget)
    {
      if (other == null || values == null || other.values == null || rebuildPayloadEntries == null || other.rebuildPayloadEntries == null
        || rebuildPayloadEntries.Count == 0 || rebuildPayloadEntries.Count != other.rebuildPayloadEntries.Count
        || !rebuildPayloadEntries.ContainsKey("payload/@directory") || rebuildPayloadEntries["payload/@directory"] == null
        || rebuildPayloadEntries["payload/@directory"].kind != "directory") return false;
      CorePolicy.ValidateAbsolutePath(expectedShortcutTarget);
      Func<string, bool> payloadKey = key => key == "payload" || key.StartsWith("payload/", StringComparison.Ordinal);
      if (values.Keys.Any(key => payloadKey(key) && !rebuildPayloadEntries.ContainsKey(key))
        || other.values.Keys.Any(key => payloadKey(key) && !other.rebuildPayloadEntries.ContainsKey(key))) return false;
      foreach (KeyValuePair<string, RebuiltPayloadEntry> entry in rebuildPayloadEntries)
      {
        if (!entry.Key.StartsWith("payload/", StringComparison.Ordinal) || !values.ContainsKey(entry.Key) || !other.values.ContainsKey(entry.Key)
          || entry.Value == null || !other.rebuildPayloadEntries.ContainsKey(entry.Key)
          || !entry.Value.SameContent(other.rebuildPayloadEntries[entry.Key])) return false;
      }
      if (verifiedProductShortcutTargets == null || other.verifiedProductShortcutTargets == null
        || verifiedProductShortcutTargets.Count != ProductShortcuts.Length || other.verifiedProductShortcutTargets.Count != ProductShortcuts.Length) return false;
      foreach (string shortcut in ProductShortcuts)
      {
        if (!values.ContainsKey(shortcut) || !other.values.ContainsKey(shortcut) || values[shortcut] == "absent" || other.values[shortcut] == "absent"
          || !verifiedProductShortcutTargets.ContainsKey(shortcut) || !other.verifiedProductShortcutTargets.ContainsKey(shortcut)
          || !CorePolicy.SamePath(verifiedProductShortcutTargets[shortcut], expectedShortcutTarget)
          || !CorePolicy.SamePath(other.verifiedProductShortcutTargets[shortcut], expectedShortcutTarget)) return false;
      }
      // The complete registry logical state, kept object identities and every
      // user canary remain exact. Only typed payload inventory and the two
      // independently read product shortcut targets have rebuild semantics.
      Func<KeyValuePair<string, string>, bool> retained = entry => !rebuildPayloadEntries.ContainsKey(entry.Key) && !ProductShortcuts.Contains(entry.Key);
      return RegistryEvidence.Equal(values.Where(retained).ToDictionary(entry => entry.Key, entry => entry.Value),
        other.values.Where(retained).ToDictionary(entry => entry.Key, entry => entry.Value));
    }
    public bool SameDataAndCanaries(ProtectedSnapshot other)
    {
      if (other == null) return false;
      Func<KeyValuePair<string, string>, bool> kept = entry => !entry.Key.EndsWith("/Claude Code Haha.lnk", StringComparison.Ordinal);
      return RegistryEvidence.Equal(values.Where(kept).ToDictionary(entry => entry.Key, entry => entry.Value),
        other.values.Where(kept).ToDictionary(entry => entry.Key, entry => entry.Value));
    }

    public string WriteRedacted(string file, FixtureSpec spec)
    {
      ProtectedSnapshot redacted = new ProtectedSnapshot();
      foreach (KeyValuePair<string, string> value in values)
        redacted.values[value.Key] = value.Value.Replace(spec.profilePath, "<OWNED_PROFILE>");
      foreach (KeyValuePair<string, RebuiltPayloadEntry> value in rebuildPayloadEntries)
        redacted.rebuildPayloadEntries[value.Key] = new RebuiltPayloadEntry { kind = value.Value.kind, bytes = value.Value.bytes, sha256 = value.Value.sha256 };
      foreach (KeyValuePair<string, string> value in verifiedProductShortcutTargets)
        redacted.verifiedProductShortcutTargets[value.Key] = value.Value.Replace(spec.profilePath, "<OWNED_PROFILE>");
      CoreJson.Write(file, redacted);
      return CorePolicy.HashFile(file);
    }
  }

  [DataContract]
  internal sealed class ObservedStart
  {
    [DataMember] public string phase;
    [DataMember] public int pid;
    [DataMember] public int parentPid;
    [DataMember] public string sid;
    [DataMember] public string imageName;
    [DataMember] public string eventFileTime;
  }

  internal sealed class PositiveProcessObserver : IDisposable
  {
    private readonly object gate = new object();
    private readonly string sid;
    private readonly ManagementEventWatcher watcher;
    private readonly List<ObservedStart> pending = new List<ObservedStart>();
    private readonly List<ObservedStart> observed = new List<ObservedStart>();
    private readonly Dictionary<int, ulong> lineage = new Dictionary<int, ulong>();
    private string phase;
    private ulong phaseCreated;
    private bool failed;

    public PositiveProcessObserver(string expectedSid)
    {
      sid = expectedSid;
      watcher = new ManagementEventWatcher(new WqlEventQuery("SELECT * FROM Win32_ProcessStartTrace"));
      watcher.EventArrived += delegate(object sender, EventArrivedEventArgs args) {
        try
        {
          int pid = Convert.ToInt32(args.NewEvent["ProcessID"]);
          int parent = Convert.ToInt32(args.NewEvent["ParentProcessID"]);
          byte[] eventSid = args.NewEvent["Sid"] as byte[];
          string actualSid = eventSid == null ? null : new System.Security.Principal.SecurityIdentifier(eventSid, 0).Value;
          lock (gate)
          {
            if (actualSid != sid)
            {
              if (phase != null && lineage.ContainsKey(parent)) failed = true;
              return;
            }
            if (pending.Count + observed.Count >= 8192) { failed = true; return; }
            pending.Add(new ObservedStart { pid = pid, parentPid = parent, sid = actualSid,
              imageName = Convert.ToString(args.NewEvent["ProcessName"]),
              eventFileTime = Convert.ToString(args.NewEvent["TIME_CREATED"], System.Globalization.CultureInfo.InvariantCulture) });
            Reconcile();
          }
        }
        catch { lock (gate) failed = true; }
      };
      watcher.Stopped += delegate(object sender, StoppedEventArgs args) { lock (gate) failed = true; };
      watcher.Start();
    }

    public void Arm(string name, int pid, string creationTime)
    {
      lock (gate)
      {
        CorePolicy.Require(phase == null && UInt64.TryParse(creationTime, out phaseCreated), "observer-phase-identity");
        phase = name; lineage.Clear(); observed.Clear(); lineage[pid] = phaseCreated; Reconcile();
      }
    }

    private void Reconcile()
    {
      if (phase == null) return;
      bool changed;
      do
      {
        changed = false;
        for (int index = pending.Count - 1; index >= 0; index--)
        {
          ObservedStart item = pending[index];
          ulong created;
          if (!UInt64.TryParse(item.eventFileTime, out created)) { failed = true; pending.RemoveAt(index); continue; }
          if (created < phaseCreated) { pending.RemoveAt(index); continue; }
          ulong parentCreated;
          if (!lineage.TryGetValue(item.parentPid, out parentCreated) || created < parentCreated) continue;
          if (lineage.ContainsKey(item.pid) && lineage[item.pid] != created) { failed = true; continue; }
          lineage[item.pid] = created; item.phase = phase; observed.Add(item); pending.RemoveAt(index); changed = true;
        }
      } while (changed);
    }

    public string Complete(string name)
    {
      // Bounded delivery grace is for this event subscription, not a repeated
      // product run. Missing events remain unproven, never proof of absence.
      for (int index = 0; index < 20; index++)
      {
        lock (gate)
        {
          Reconcile();
          if (observed.Any(item => String.Equals(item.imageName, "tasklist.exe", StringComparison.OrdinalIgnoreCase))
            && observed.Any(item => String.Equals(item.imageName, "findstr.exe", StringComparison.OrdinalIgnoreCase))) break;
        }
        System.Threading.Thread.Sleep(100);
      }
      lock (gate)
      {
        CorePolicy.Require(phase == name && !failed, "observer-subscription-and-lineage");
        bool complete = observed.Any(item => String.Equals(item.imageName, "tasklist.exe", StringComparison.OrdinalIgnoreCase))
          && observed.Any(item => String.Equals(item.imageName, "findstr.exe", StringComparison.OrdinalIgnoreCase));
        phase = null; lineage.Clear();
        return complete ? "positive_tasklist_and_findstr_observed" : "not_proven";
      }
    }

    public List<ObservedStart> Observed() { lock (gate) return new List<ObservedStart>(observed); }
    public void Dispose() { watcher.Stop(); watcher.Dispose(); }
  }

  internal sealed class Subject
  {
    private readonly FixtureSpec spec;
    private readonly NativePlatform api;
    private readonly FixtureChannel channel;
    private readonly FixtureReport report;
    private readonly Dictionary<string, string> normal;
    private readonly Dictionary<string, string> unavailable;
    private readonly List<OwnedProcess> owned = new List<OwnedProcess>();

    private Subject(FixtureSpec input, NativePlatform native, FixtureChannel connection, FixtureReport result)
    {
      spec = input; api = native; channel = connection; report = result;
      Dictionary<string, string> current = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
        current[(string)entry.Key] = (string)entry.Value;
      normal = CorePolicy.BuildEnvironment(current, spec, false);
      unavailable = CorePolicy.BuildEnvironment(current, spec, true);
    }

    public static FixtureReport Run(FixtureSpec spec, NativePlatform api)
    {
      FixtureReport report = new FixtureReport { mode = spec.mode == F1Policy.SubjectMode ? "f1-subject" : "subject", binarySha256 = CorePolicy.HashFile(CorePolicy.BinaryPath),
        specSha256 = CorePolicy.HashFile(spec.subjectSpecPath) };
      FixtureChannel channel = null;
      Subject subject = null;
      try
      {
        if (spec.mode == F1Policy.SubjectMode) { F1Policy.ValidatePrepared(spec, true); api.BindF1SubjectContext(spec); }
        else { CorePolicy.ValidateSubjectSpec(spec); api.BindSubjectContext(spec); }
        channel = api.ConnectSubjectChannel(spec);
        TokenIdentity actual = api.InspectCurrentToken();
        CorePolicy.AssertStandard(actual, spec.expectedSid);
        KnownPaths paths = api.QueryKnownPaths(IntPtr.Zero);
        CorePolicy.Require(CorePolicy.SamePaths(paths, spec.knownPaths), "subject-actual-known-folders");
        CorePolicy.Require(String.Equals(api.CurrentPrivateDesktopName(), spec.desktopName, StringComparison.OrdinalIgnoreCase), "subject-actual-private-desktop");
        string response = api.SubjectHiveChallenge(spec);
        channel.WriteLine(CoreJson.Serialize(new ProtocolMessage {
          kind = "hello", nonce = spec.nonce, specSha256 = report.specSha256, binarySha256 = report.binarySha256,
          pid = Process.GetCurrentProcess().Id, creationTime = api.CurrentCreationTime(),
          sid = actual.sid, identity = actual, knownPaths = paths, hiveResponse = response
        }));
        ProtocolMessage acknowledgement = CoreJson.Deserialize<ProtocolMessage>(channel.ReadLine(30000));
        CorePolicy.Require(acknowledgement.version == 1 && acknowledgement.kind == "ack" && acknowledgement.nonce == spec.nonce
          && acknowledgement.specSha256 == report.specSha256 && acknowledgement.binarySha256 == report.binarySha256, "subject-authenticated-ack");
        api.AllowSubjectProducts(spec, acknowledgement);
        subject = new Subject(spec, api, channel, report);
        subject.HistoricalProfile();
      }
      catch (Exception error)
      {
        report.status = "failed"; report.Check("historical-subject", false, NativePlatform.SafeFailure(error));
      }
      finally
      {
        Finish(api, subject == null ? new List<OwnedProcess>() : subject.owned, channel, report, spec.nonce,
          subject == null ? null : (Action)delegate { CoreJson.Write(spec.output, report); });
      }
      return report;
    }

    internal static void Finish(ProfilePlatform api, IEnumerable<OwnedProcess> owned, FixtureChannel channel,
      FixtureReport report, string nonce, Action persist)
    {
      bool cleaned = true;
      foreach (OwnedProcess process in owned)
      {
        try { api.StopChild(process); }
        catch (Exception error) { cleaned = false; report.Check("subject-owned-child-stop", false, NativePlatform.SafeFailure(error)); }
        try { api.CloseChild(process); }
        catch (Exception error) { cleaned = false; report.Check("subject-owned-child-close", false, NativePlatform.SafeFailure(error)); }
      }
      report.cleanup = cleaned ? "passed" : "failed";
      report.finishedAtUtc = DateTime.UtcNow.ToString("o");
      try { if (persist != null) persist(); }
      catch (Exception error) { report.Check("subject-terminal-report", false, NativePlatform.SafeFailure(error)); }
      if (channel == null) return;
      try
      {
        // Completion describes the cleanup result, never the pre-finally state.
        channel.WriteLine(CoreJson.Serialize(new ProtocolMessage {
          kind = report.status == "passed" ? "complete" : "failed", nonce = nonce, report = report
        }));
      }
      catch (Exception error) { report.Check("subject-terminal-message", false, NativePlatform.SafeFailure(error)); }
      finally
      {
        try { channel.Dispose(); }
        catch (Exception error) { report.Check("subject-channel-close", false, NativePlatform.SafeFailure(error)); }
      }
      // A disposal/write failure after delivery still returns failed/exit1.
      // Controller must independently wait for the retained subject's exit0.
    }

    private CommandPlan Command(string phase, string application, string commandLine, int expectedExit, int timeout)
    {
      FileIdentity image = api.IdentifyPath(application, false);
      CorePolicy.Require(!image.reparse, "ordinary-phase-image");
      return new CommandPlan { phase = phase, application = application, commandLine = commandLine,
        expectedSha256 = image.sha256, expectedExitCode = expectedExit, timeoutMilliseconds = timeout };
    }

    private ProtocolMessage ReadAck(string kind, string phase)
    {
      ProtocolMessage message = CoreJson.Deserialize<ProtocolMessage>(channel.ReadLine(30000));
      CorePolicy.Require(message.version == 1 && message.kind == kind && message.nonce == spec.nonce
        && message.phase == phase, "phase-authenticated-ack");
      return message;
    }

    private PhaseEvidence Phase(CommandPlan command, Dictionary<string, string> environment, Action<PhaseEvidence> beforeEnd)
    {
      OwnedProcess child = new OwnedProcess(); owned.Add(child);
      PhaseEvidence evidence = new PhaseEvidence {
        phase = command.phase, applicationSha256 = command.expectedSha256,
        argvSha256 = CorePolicy.HashText(command.commandLine), environmentSha256 = CorePolicy.EnvironmentHash(environment),
        startedAtUtc = DateTime.UtcNow.ToString("o")
      };
      Exception firstFailure = null;
      try
      {
        if (spec.mode == F1Policy.SubjectMode && F1Policy.Audited(command.phase))
        {
          channel.WriteLine(CoreJson.Serialize(new ProtocolMessage { kind = "audit-prepare", nonce = spec.nonce, phase = command.phase }));
          ReadAck("audit-ready", command.phase);
          child.debugExchange = delegate(F1DebugNotice notice) {
            channel.WriteLine(CoreJson.Serialize(new ProtocolMessage { kind = "debug-stop", nonce = spec.nonce, phase = command.phase, debug = notice }));
            return ReadAck("debug-ack", command.phase).debugReply;
          };
        }
        api.StartChild(child, command, environment, spec.fixtureRoot, spec.desktopName);
        api.VerifyChild(child, spec.expectedSid, command.application, command.expectedSha256);
        channel.WriteLine(CoreJson.Serialize(new ProtocolMessage { kind = "phase-start", nonce = spec.nonce,
          phase = command.phase, pid = child.pid, creationTime = child.creationTime, image = child.image, sid = spec.expectedSid }));
        ReadAck("phase-ack", command.phase);
        api.ResumeChild(child);
        if (command.phase == "fresh-install" || command.phase == "old22-negative" || command.phase == "old-normal-removal-positive"
          || command.phase == "rebuild-old-install" || command.phase == "guarded-new-upgrade")
        {
          report.releasedPeExecuted = true; report.releasedPeMayHaveExecuted = true;
          report.releasedPeExecutionStatus = "resume_returned_success";
        }
        evidence.exitCode = api.WaitChild(child, command.timeoutMilliseconds);
        CorePolicy.Require(evidence.exitCode == command.expectedExitCode, "phase-exact-exit-" + command.phase);
        if (beforeEnd != null) beforeEnd(evidence);
        evidence.finishedAtUtc = DateTime.UtcNow.ToString("o");
        report.phases.Add(evidence);
        channel.WriteLine(CoreJson.Serialize(new ProtocolMessage { kind = "phase-end", nonce = spec.nonce,
          phase = command.phase, evidence = evidence }));
        ReadAck("phase-end-ack", command.phase);
        return evidence;
      }
      catch (Exception error) { firstFailure = error; throw; }
      finally
      {
        if (child.debugPump == null || firstFailure == null) { api.StopChild(child); api.CloseChild(child); owned.Remove(child); }
        else { try { api.StopChild(child); api.CloseChild(child); owned.Remove(child); } catch (Exception cleanup) { report.Check("f1-debug-cleanup-unknown", false, NativePlatform.SafeFailure(cleanup)); } }
      }
    }

    private void PrepareDirectories()
    {
      CorePolicy.Require(!Directory.Exists(spec.fixtureRoot) && !File.Exists(spec.fixtureRoot), "fresh-subject-fixture-root");
      CorePolicy.Require(!Directory.Exists(spec.installRoot) && !File.Exists(spec.installRoot)
        && RegistryEvidence.OwnedProducts(spec.expectedSid).Count == 0, "fresh-unregistered-default-root");
      Directory.CreateDirectory(spec.fixtureRoot); Directory.CreateDirectory(spec.tempRoot); Directory.CreateDirectory(spec.installRoot);
      foreach (string name in new string[] { "CONFIG", "CACHE", "DATA", "STATE" }) Directory.CreateDirectory(normal["XDG_" + name + "_HOME"]);
      Directory.CreateDirectory(normal["GH_CONFIG_DIR"]); Directory.CreateDirectory(normal["CODEX_HOME"]);
      FileIdentity root = api.IdentifyPath(spec.installRoot, true);
      FileIdentity temporary = api.IdentifyPath(spec.tempRoot, true);
      FileIdentity profile = api.IdentifyPath(spec.profilePath, true);
      CorePolicy.Require(!root.reparse && !temporary.reparse && !profile.reparse
        && CorePolicy.IsInside(profile.canonicalPath, root.canonicalPath)
        && CorePolicy.IsInside(profile.canonicalPath, temporary.canonicalPath)
        && !String.IsNullOrEmpty(root.volumePath) && root.volumePath == temporary.volumePath, "actual-same-volume");
      CorePolicy.Require(Directory.GetFileSystemEntries(spec.installRoot).Length == 0
        && RegistryEvidence.OwnedProducts(spec.expectedSid).Count == 0, "empty-precreated-default-root");
    }

    private static void ShellPath(string path)
    {
      CorePolicy.ValidateAbsolutePath(path);
      CorePolicy.Require(path.IndexOfAny(new char[] { '&', '|', '<', '>', '%', '!', '^', '(', ')' }) < 0, "literal-os-tool-shell-path");
    }

    private void LegacyPreflight(string phase, OwnedProcess allowedHelper)
    {
      string tools = Path.Combine(normal["SystemRoot"], "SysWOW64");
      string cmd = Path.Combine(tools, "cmd.exe");
      string tasklist = Path.Combine(tools, "tasklist.exe");
      string findstr = Path.Combine(tools, "findstr.exe");
      string csv = Path.Combine(spec.fixtureRoot, phase + "-tasklist.csv");
      string matches = Path.Combine(spec.fixtureRoot, phase + "-matches.csv");
      foreach (string path in new string[] { cmd, tasklist, findstr, csv, matches }) ShellPath(path);
      CorePolicy.Require(!File.Exists(csv) && !File.Exists(matches), "fresh-legacy-preflight-output");
      StringBuilder predicates = new StringBuilder();
      foreach (string name in CorePolicy.LegacyNames) predicates.Append(" /C:\"").Append(name).Append('"');
      // Same seven literal /C terms as the released fallback, over the entire
      // real CSV row. No exact-image name set substitutes for this command.
      string command = "\"" + cmd + "\" /D /C \"\"" + tasklist + "\" /FO CSV /NH > \"" + csv
        + "\" && \"" + findstr + "\" /I /L" + predicates + " \"" + csv + "\" > \"" + matches + "\"\"";
      int expected = allowedHelper == null ? 1 : 0;
      Phase(Command(phase, cmd, command, expected, 30000), normal, delegate {
        CorePolicy.Require(File.Exists(csv) && File.Exists(matches), "tasklist-and-findstr-both-ran");
        CorePolicy.Require(new FileInfo(csv).Length <= 2097152 && new FileInfo(matches).Length <= 2097152, "bounded-legacy-csv");
        List<string[]> all = ParseCsv(Encoding.ASCII.GetString(File.ReadAllBytes(csv)));
        CorePolicy.Require(all.Count > 0 && all.Any(row => row.Length >= 2 && row[1] == "4"), "valid-complete-tasklist-shape");
        List<string[]> hits = ParseCsv(Encoding.ASCII.GetString(File.ReadAllBytes(matches)));
        foreach (string[] row in hits)
        {
          int pid = 0;
          CorePolicy.Require(row.Length >= 2 && Int32.TryParse(row[1], out pid), "structured-matching-csv");
          CorePolicy.Require(allowedHelper != null && pid == allowedHelper.pid
            && String.Equals(row[0], "OpenConsole.exe", StringComparison.OrdinalIgnoreCase)
            && api.ChildIsAlive(allowedHelper), "no-nonowned-legacy-match");
        }
        CorePolicy.Require(allowedHelper == null ? hits.Count == 0 : hits.Count == 1, "exact-owned-legacy-cohort");
      });
    }

    internal static List<string[]> ParseCsv(string text)
    {
      List<string[]> rows = new List<string[]>();
      using (StringReader input = new StringReader(text))
      {
        string line;
        while ((line = input.ReadLine()) != null)
        {
          if (String.IsNullOrWhiteSpace(line)) continue;
          CorePolicy.Require(line.Length <= 16384 && rows.Count < 10000, "bounded-tasklist-row");
          List<string> fields = new List<string>(); StringBuilder field = new StringBuilder(); bool quoted = false;
          for (int index = 0; index < line.Length; index++)
          {
            char value = line[index];
            if (value == '"')
            {
              if (quoted && index + 1 < line.Length && line[index + 1] == '"') { field.Append('"'); index++; }
              else quoted = !quoted;
            }
            else if (value == ',' && !quoted) { fields.Add(field.ToString()); field.Length = 0; }
            else field.Append(value);
          }
          CorePolicy.Require(!quoted, "closed-tasklist-csv-quotes");
          fields.Add(field.ToString()); rows.Add(fields.ToArray());
        }
      }
      return rows;
    }

    private void CalibratePowerShell()
    {
      string powershell = Path.Combine(normal["SystemRoot"], "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe");
      CorePolicy.ValidateAbsolutePath(powershell);
      string first = "\"" + powershell + "\" -C \"if (Get-Command Get-CimInstance -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }\"";
      string second = "\"" + powershell + "\" -C \"if ((Get-ExecutionPolicy -Scope Process) -eq 'Restricted') { exit 1 } else { exit 0 }\"";
      Phase(Command("powershell-normal-capability-1", powershell, first, 0, 30000), normal, null);
      Phase(Command("powershell-normal-capability-2", powershell, second, 0, 30000), normal, null);
      // A nonzero unavailable result must be observed, not assumed from env.
      OwnedProcess child = new OwnedProcess(); owned.Add(child);
      CommandPlan command = Command("powershell-unavailable-capability", powershell, first, 0, 30000);
      try
      {
        api.StartChild(child, command, unavailable, spec.fixtureRoot, spec.desktopName);
        api.VerifyChild(child, spec.expectedSid, powershell, command.expectedSha256);
        channel.WriteLine(CoreJson.Serialize(new ProtocolMessage { kind = "phase-start", nonce = spec.nonce,
          phase = command.phase, pid = child.pid, creationTime = child.creationTime, image = child.image, sid = spec.expectedSid }));
        ReadAck("phase-ack", command.phase); api.ResumeChild(child);
        int exit = api.WaitChild(child, 30000); CorePolicy.Require(exit != 0, "actual-unavailable-condition");
        PhaseEvidence evidence = new PhaseEvidence { phase = command.phase, exitCode = exit,
          applicationSha256 = command.expectedSha256, argvSha256 = CorePolicy.HashText(first),
          environmentSha256 = CorePolicy.EnvironmentHash(unavailable), finishedAtUtc = DateTime.UtcNow.ToString("o") };
        report.phases.Add(evidence);
        channel.WriteLine(CoreJson.Serialize(new ProtocolMessage { kind = "phase-end", nonce = spec.nonce,
          phase = command.phase, evidence = evidence })); ReadAck("phase-end-ack", command.phase);
      }
      finally { api.StopChild(child); api.CloseChild(child); owned.Remove(child); }
      CorePolicy.Require(!normal.ContainsKey("COMPLUS_Version") && Environment.GetEnvironmentVariable("COMPLUS_Version") == null, "bad-clr-child-only");
    }

    private void VerifyInstalled()
    {
      string uninstaller = Path.Combine(spec.installRoot, "Uninstall Claude Code Haha.exe");
      FileIdentity image = api.IdentifyPath(uninstaller, false);
      CorePolicy.Require(!image.reparse && image.bytes == CorePolicy.UninstallerBytes && image.sha256 == CorePolicy.UninstallerHash, "actual-installed-uninstaller-pin");
      CorePolicy.Require(File.Exists(Path.Combine(spec.installRoot, "Claude Code Haha.exe")), "actual-installed-app-exe");
      string installKey = @"Software\" + CorePolicy.ProductGuid;
      string uninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + CorePolicy.ProductGuid;
      RegistryEvidence.RequireString(spec.expectedSid, installKey, "InstallLocation", spec.installRoot);
      RegistryEvidence.RequireString(spec.expectedSid, installKey, "KeepShortcuts", "true");
      RegistryEvidence.RequireString(spec.expectedSid, uninstallKey, "DisplayVersion", "0.7.8");
      RegistryEvidence.RequireString(spec.expectedSid, uninstallKey, "UninstallString", "\"" + uninstaller + "\" /currentuser");
      foreach (string shortcut in new string[] { Path.Combine(spec.knownPaths.desktop, "Claude Code Haha.lnk"),
        Path.Combine(spec.knownPaths.programs, "Claude Code Haha.lnk") })
      {
        CorePolicy.Require(File.Exists(shortcut), "actual-kept-shortcut");
        CorePolicy.Require(CorePolicy.SamePath(ShortcutTarget.Read(shortcut), Path.Combine(spec.installRoot, "Claude Code Haha.exe")), "actual-shortcut-target");
      }
    }

    private void SeedCanaries()
    {
      foreach (string directory in new string[] {
        Path.Combine(spec.knownPaths.roaming, "Claude Code Haha"), Path.Combine(spec.profilePath, ".claude"),
        Path.Combine(spec.profilePath, "Claude Code Haha Data", "Recovered"), spec.knownPaths.desktop, spec.knownPaths.programs
      })
      {
        CorePolicy.Require(CorePolicy.IsInside(spec.profilePath, directory), "owned-canary-root");
        Directory.CreateDirectory(directory);
        string file = Path.Combine(directory, "CcHaha1879-canary.txt");
        CorePolicy.Require(!File.Exists(file), "new-canary-only");
        using (FileStream output = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
          byte[] content = Encoding.UTF8.GetBytes("FAKE FIXTURE DATA; NO REAL PROVIDER\n" + spec.nonce);
          output.Write(content, 0, content.Length); output.Flush(true);
        }
      }
    }

    private void SnapshotFile(string name, ProtectedSnapshot snapshot)
    {
      string file = Path.Combine(spec.fixtureRoot, name);
      report.evidenceFiles[name] = snapshot.WriteRedacted(file, spec);
    }

    private string LegacyOnlyCanaryPath()
    {
      return Path.Combine(spec.installRoot, "CcHaha1879-legacy-only-" + spec.nonce + ".txt");
    }

    private void SeedLegacyOnlyCanary()
    {
      string file = LegacyOnlyCanaryPath();
      CorePolicy.Require(CorePolicy.IsInside(spec.installRoot, file), "f1-legacy-canary-exact-root");
      byte[] bytes = Encoding.UTF8.GetBytes("OWNED F1 LEGACY-ONLY CANARY\n" + spec.nonce);
      using (FileStream output = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None))
      { output.Write(bytes, 0, bytes.Length); output.Flush(true); }
    }

    private bool ShortcutTargetsMatch()
    {
      string expected = Path.Combine(spec.installRoot, "Claude Code Haha.exe");
      foreach (string file in new string[] { Path.Combine(spec.knownPaths.desktop, "Claude Code Haha.lnk"), Path.Combine(spec.knownPaths.programs, "Claude Code Haha.lnk") })
        if (!File.Exists(file) || api.IdentifyPath(file, false).reparse || !CorePolicy.SamePath(ShortcutTarget.Read(file), expected)) return false;
      return true;
    }

    private void VerifyCurrentPackageInstalled()
    {
      F1PackagePin package = spec.f1.newPackage;
      foreach (F1PayloadPin pin in package.payloads)
      {
        string file = Path.Combine(spec.installRoot, pin.relativePath);
        CorePolicy.Require(CorePolicy.IsInside(spec.installRoot, file), "f1-installed-payload-root");
        FileIdentity actual = api.IdentifyPath(file, false);
        CorePolicy.Require(!actual.reparse && actual.bytes == pin.bytes && actual.sha256 == pin.sha256, "f1-installed-current-full-package-bytes");
      }
      string uninstaller = Path.Combine(spec.installRoot, "Uninstall Claude Code Haha.exe");
      FileIdentity image = api.IdentifyPath(uninstaller, false);
      CorePolicy.Require(!image.reparse && image.bytes == package.uninstallerBytes && image.sha256 == package.uninstallerSha256, "f1-current-installed-uninstaller-member");
      RegistryEvidence.RequireString(spec.expectedSid, @"Software\" + CorePolicy.ProductGuid, "InstallLocation", spec.installRoot);
      RegistryEvidence.RequireString(spec.expectedSid, @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + CorePolicy.ProductGuid, "DisplayVersion", package.displayVersion);
      RegistryEvidence.RequireString(spec.expectedSid, @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + CorePolicy.ProductGuid, "UninstallString", "\"" + uninstaller + "\" /currentuser");
      CorePolicy.Require(ShortcutTargetsMatch(), "f1-current-shortcut-targets");
    }

    private void GuardedFullUpgrade(ProtectedSnapshot originalOld, string helperPath, string helperHash)
    {
      CorePolicy.Require(spec.mode == F1Policy.SubjectMode, "f1-no-legacy-role-upgrade");
      // An actual normal removal has already finished and its state was checked
      // before fixture cleanup. Rebuild only by running the same full old setup.
      Phase(Command("rebuild-old-install", spec.setupPath, CorePolicy.SetupCommand(spec.setupPath, spec.installRoot), 0, 300000), normal,
        delegate(PhaseEvidence evidence) {
          VerifyInstalled(); SeedLegacyOnlyCanary();
          ProtectedSnapshot rebuilt = ProtectedSnapshot.Capture(spec, api, true); SnapshotFile("f1-rebuilt-old.json", rebuilt);
          evidence.oldStateEquivalent = originalOld.SameRebuiltInstallation(rebuilt, Path.Combine(spec.installRoot, "Claude Code Haha.exe"));
          evidence.installedUninstallerSha256 = CorePolicy.UninstallerHash;
          CorePolicy.Require(evidence.oldStateEquivalent, "f1-rebuilt-old-payload-registry-data-equivalence");
        });
      ProtectedSnapshot kept = ProtectedSnapshot.Capture(spec, api, false); SnapshotFile("f1-upgrade-kept-before.json", kept);
      OwnedProcess helper = new OwnedProcess(); owned.Add(helper);
      try
      {
        api.StartChild(helper, Command("foreign-helper", helperPath, "\"" + helperPath + "\" -t 127.0.0.1", 0, 0), normal, spec.fixtureRoot, spec.desktopName);
        api.VerifyChild(helper, spec.expectedSid, helperPath, helperHash); api.ResumeChild(helper);
        CorePolicy.Require(api.ChildIsAlive(helper), "f1-same-owned-foreign-helper-restarted");
        LegacyPreflight("upgrade-negative-preflight", helper);
        F1BlobPin setup = spec.f1.newPackage.setup;
        FileIdentity full = api.IdentifyPath(setup.file, false);
        CorePolicy.Require(!full.reparse && full.bytes == setup.bytes && full.sha256 == setup.sha256, "f1-full-new-setup-before-first-upgrade");
        Phase(Command("guarded-new-upgrade", setup.file, CorePolicy.SetupCommand(setup.file, spec.installRoot), 0, 300000), unavailable,
          delegate(PhaseEvidence evidence) {
            evidence.helperAlive = api.ChildIsAlive(helper); CorePolicy.Require(evidence.helperAlive, "f1-foreign-helper-survives-full-upgrade");
            VerifyCurrentPackageInstalled(); evidence.newPackageInstalled = true;
            evidence.installedUninstallerSha256 = spec.f1.newPackage.uninstallerSha256;
            evidence.legacyOnlyCanaryRemoved = !File.Exists(LegacyOnlyCanaryPath()) && !Directory.Exists(LegacyOnlyCanaryPath());
            ProtectedSnapshot after = ProtectedSnapshot.Capture(spec, api, false); SnapshotFile("f1-upgrade-kept-after.json", after);
            evidence.keptDataUnchanged = kept.SameDataAndCanaries(after); evidence.shortcutTargetsUnchanged = ShortcutTargetsMatch();
            CorePolicy.Require(evidence.legacyOnlyCanaryRemoved && evidence.keptDataUnchanged && evidence.shortcutTargetsUnchanged, "f1-full-upgrade-kept-state-and-legacy-only-removal");
          });
      }
      finally { api.StopChild(helper); api.CloseChild(helper); owned.Remove(helper); }
      // Controller, not the subject, must independently require a lossless
      // calibrated audit proving old payload AND registration removal before
      // new creation. These final snapshots alone never set F1 evidence fields.
    }

    private void HistoricalProfile()
    {
      PrepareDirectories();
      LegacyPreflight("observer-calibration", null);
      CalibratePowerShell();
      FileIdentity setup = api.IdentifyPath(spec.setupPath, false);
      CorePolicy.Require(setup.bytes == CorePolicy.SetupBytes && setup.sha256 == CorePolicy.SetupHash && !setup.reparse, "setup-recheck-before-launch");
      Phase(Command("fresh-install", spec.setupPath, CorePolicy.SetupCommand(spec.setupPath, spec.installRoot), 0, 300000), normal,
        delegate(PhaseEvidence evidence) { VerifyInstalled(); evidence.installedUninstallerSha256 = CorePolicy.UninstallerHash; });
      report.installed_bytes_equal = "native_equal_exact_pin";
      SeedCanaries();
      if (spec.mode == F1Policy.SubjectMode) SeedLegacyOnlyCanary();
      string installed = Path.Combine(spec.installRoot, "Uninstall Claude Code Haha.exe");
      File.Copy(installed, spec.uninstallerCopy, false);
      FileIdentity copied = api.IdentifyPath(spec.uninstallerCopy, false);
      CorePolicy.Require(copied.bytes == CorePolicy.UninstallerBytes && copied.sha256 == CorePolicy.UninstallerHash && !copied.reparse, "copied-installed-uninstaller-pin");
      string foreign = Path.Combine(spec.fixtureRoot, "foreign"); Directory.CreateDirectory(foreign);
      string source = Path.Combine(normal["SystemRoot"], "System32", "ping.exe");
      string helperPath = Path.Combine(foreign, "OpenConsole.exe");
      FileIdentity sourceIdentity = api.IdentifyPath(source, false);
      File.Copy(source, helperPath, false);
      CorePolicy.Require(api.IdentifyPath(helperPath, false).sha256 == sourceIdentity.sha256, "exact-system-ping-copy");
      OwnedProcess helper = new OwnedProcess(); owned.Add(helper);
      try
      {
        CommandPlan helperCommand = Command("foreign-helper", helperPath, "\"" + helperPath + "\" -t 127.0.0.1", 0, 0);
        api.StartChild(helper, helperCommand, normal, spec.fixtureRoot, spec.desktopName);
        api.VerifyChild(helper, spec.expectedSid, helperPath, sourceIdentity.sha256); api.ResumeChild(helper);
        CorePolicy.Require(api.ChildIsAlive(helper), "owned-foreign-helper-alive");
        LegacyPreflight("negative-preflight", helper);
        ProtectedSnapshot before = ProtectedSnapshot.Capture(spec, api, true); SnapshotFile("negative-before.json", before);
        string argv = CorePolicy.UninstallerCommand(spec.uninstallerCopy, spec.installRoot);
        string argvHash = CorePolicy.HashText(argv); string envHash = CorePolicy.EnvironmentHash(unavailable);
        Phase(Command("old22-negative", spec.uninstallerCopy, argv, 22, 180000), unavailable, delegate(PhaseEvidence evidence) {
          evidence.helperAlive = api.ChildIsAlive(helper); CorePolicy.Require(evidence.helperAlive, "negative-helper-remains-alive");
          ProtectedSnapshot after = ProtectedSnapshot.Capture(spec, api, true); SnapshotFile("negative-after.json", after);
          evidence.protectedFinalStateUnchanged = before.Same(after);
          CorePolicy.Require(evidence.protectedFinalStateUnchanged, "negative-protected-final-state-unchanged");
        });
        api.StopChild(helper); api.CloseChild(helper); owned.Remove(helper);
        LegacyPreflight("positive-preflight", null);
        VerifyInstalled();
        CorePolicy.Require(before.Same(ProtectedSnapshot.Capture(spec, api, true)), "same-profile-before-positive");
        ProtectedSnapshot keptBefore = ProtectedSnapshot.Capture(spec, api, false); SnapshotFile("positive-kept-before.json", keptBefore);
        FileIdentity sameBinary = api.IdentifyPath(spec.uninstallerCopy, false);
        CorePolicy.Require(sameBinary.sha256 == copied.sha256 && sameBinary.fileId == copied.fileId
          && CorePolicy.HashText(argv) == argvHash && CorePolicy.EnvironmentHash(unavailable) == envHash, "identical-positive-binary-argv-env");
        Phase(Command("old-normal-removal-positive", spec.uninstallerCopy, argv, 0, 180000), unavailable, delegate(PhaseEvidence evidence) {
          evidence.payloadRemoved = !Directory.Exists(spec.installRoot) && !File.Exists(spec.installRoot);
          evidence.registrationRemoved = RegistryEvidence.OwnedProducts(spec.expectedSid).Count == 0;
          CorePolicy.Require(evidence.payloadRemoved && evidence.registrationRemoved, "product-removed-before-fixture-cleanup");
          ProtectedSnapshot keptAfter = ProtectedSnapshot.Capture(spec, api, false); SnapshotFile("positive-kept-after.json", keptAfter);
          evidence.keptDataUnchanged = keptBefore.Same(keptAfter);
          CorePolicy.Require(evidence.keptDataUnchanged, "positive-kept-data-and-shortcuts");
        });
        if (spec.mode == F1Policy.SubjectMode) GuardedFullUpgrade(before, helperPath, sourceIdentity.sha256);
        report.old22_before_protected_mutation = "native_exit22_and_final_state_equal_only;transient_operation_order_not_proven";
        report.removal_equivalence = "old_binary_positive_only;trusted_replacement_equivalence_not_run";
        report.Check("historical-negative-and-positive", true, "Exact old binary; positive removal observed before fixture cleanup.");
        report.status = "passed";
      }
      finally
      {
        if (owned.Contains(helper)) { api.StopChild(helper); api.CloseChild(helper); owned.Remove(helper); }
      }
    }
  }

  // Read only: IPersistFile.Load(STGM_READ) and IShellLinkW.GetPath. No Save,
  // ShellExecute, WScript host, shortcut creation or target execution.
  internal static class ShortcutTarget
  {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink { }
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IReadShellLink
    {
      [PreserveSig] int GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int length, IntPtr findData, uint flags);
    }

    public static string Read(string file)
    {
      object link = new ShellLink();
      try
      {
        ((System.Runtime.InteropServices.ComTypes.IPersistFile)link).Load(file, 0);
        StringBuilder target = new StringBuilder(1024);
        CorePolicy.Require(((IReadShellLink)link).GetPath(target, target.Capacity, IntPtr.Zero, 4) == 0, "read-existing-shortcut-target");
        CorePolicy.ValidateAbsolutePath(target.ToString());
        return target.ToString();
      }
      finally { Marshal.FinalReleaseComObject(link); }
    }
  }

  internal static class Program
  {
    private static void StageAOutput(string file)
    {
      CorePolicy.ValidateAbsolutePath(file);
      string parent = Path.GetDirectoryName(file);
      string temporary = Path.GetFullPath(Path.GetTempPath());
      CorePolicy.Require(!File.Exists(file) && !Directory.Exists(file) && Directory.Exists(parent)
        && Directory.Exists(temporary), "new-private-output");
      // The TS entry proves its sandbox is outside the source Git root. CWD is
      // intentionally that private sandbox, so it is not a Git-root identity.
      NativePlatform inspection = new NativePlatform();
      FileIdentity tempIdentity = inspection.IdentifyPath(temporary, true);
      FileIdentity parentIdentity = inspection.IdentifyPath(parent, true);
      CorePolicy.Require(!tempIdentity.reparse && !parentIdentity.reparse
        && (CorePolicy.SamePath(tempIdentity.canonicalPath, parentIdentity.canonicalPath)
          || CorePolicy.IsInside(tempIdentity.canonicalPath, parentIdentity.canonicalPath))
        && CorePolicy.IsInside(tempIdentity.canonicalPath, Path.Combine(parentIdentity.canonicalPath, Path.GetFileName(file))),
        "output-inside-canonical-private-temp");
    }

    [STAThread]
    public static int Main(string[] arguments)
    {
      string output = null;
      FixtureReport report = null;
      try
      {
        CorePolicy.Require(Environment.OSVersion.Platform == PlatformID.Win32NT && IntPtr.Size == 8, "windows-x64-only");
        if (arguments.Length == 3 && arguments[0] == "--f1-audit-child" && arguments[1] == "--spec")
          return NativePlatform.RunF1AuditChild(Path.GetFullPath(arguments[2]));
        if (arguments.Length == 3 && arguments[0] == "--f1-audit-canary" && arguments[1] == "--output")
        {
          output = Path.GetFullPath(arguments[2]); StageAOutput(output);
          report = NativePlatform.RunF1AuditCanary(output); CoreJson.Write(output, report);
          return report.status == "passed" ? 0 : 1;
        }
        if (arguments.Length == 3 && (arguments[0] == "--self-test" || arguments[0] == "--abi-harness") && arguments[1] == "--output")
        {
          output = Path.GetFullPath(arguments[2]); StageAOutput(output);
          if (arguments[0] == "--self-test")
          {
            report = new FixtureReport { mode = "self-test" };
            FixtureTests.Run(report);
            report.status = report.checks.Count > 0 && report.checks.All(check => check.status == "passed") ? "passed" : "failed";
          }
          else
          {
            CorePolicy.Require(Environment.GetEnvironmentVariable("CI") == "true", "abi-disposable-ci-only");
            report = NativePlatform.RunAbiHarness(output);
            CorePolicy.Require(report != null && report.mode == "abi-harness", "abi-real-report");
            if (report.cleanup != "passed") report.status = "failed";
          }
          report.binarySha256 = CorePolicy.HashFile(CorePolicy.BinaryPath);
          CorePolicy.Require(report.realAccountsCreated == 0 && report.realProfilesCreated == 0
            && !report.releasedPeExecuted && !report.releasedPeMayHaveExecuted && report.releasedPeExecutionStatus == "not_run"
            && !report.compatibilityEnabled && report.oldExit22Policy == "fatal", "stage-a-zero-real-effects");
          CorePolicy.Require(report.member_proven == "not_run" && report.installed_bytes_equal == "not_run"
            && report.old22_before_protected_mutation == "not_run" && report.removal_equivalence == "not_run"
            && report.full_old_to_new == "not_run", "stage-a-no-historical-claim");
          if (report.checks.Count == 0 || report.checks.Any(check => check.status != "passed")) report.status = "failed";
          report.finishedAtUtc = DateTime.UtcNow.ToString("o"); CoreJson.Write(output, report);
          return report.status == "passed" ? 0 : 1;
        }
        if (arguments.Length == 3 && arguments[0] == "--abi-child" && arguments[1] == "--spec")
        {
          CorePolicy.Require(Environment.GetEnvironmentVariable("CI") == "true", "abi-child-ci-only");
          return NativePlatform.RunAbiChild(Path.GetFullPath(arguments[2]));
        }
        CorePolicy.Require(arguments.Length == 4 && arguments[0] == "--role" && arguments[2] == "--spec"
          && (arguments[1] == "controller" || arguments[1] == "subject" || arguments[1] == "profile-only"
            || arguments[1] == "f1-controller" || arguments[1] == "f1-subject"), "explicit-role-required-no-default-execution");
        string specFile = Path.GetFullPath(arguments[3]);
        FixtureSpec spec = CoreJson.Read<FixtureSpec>(specFile);
        NativePlatform native = new NativePlatform();
        if (arguments[1] == "subject" || arguments[1] == "f1-subject")
        {
          CorePolicy.Require((arguments[1] == "f1-subject") == (spec.mode == F1Policy.SubjectMode), "f1-subject-role-cannot-reuse-legacy-spec");
          CorePolicy.Require(CorePolicy.SamePath(spec.subjectSpecPath, specFile), "subject-spec-file-binding");
          FixtureReport result = Subject.Run(spec, native);
          return result.status == "passed" ? 0 : 1;
        }
        bool profileOnly = arguments[1] == "profile-only";
        CorePolicy.Require(Environment.GetEnvironmentVariable("CI") == "true", "controller-disposable-ci-only");
        if (profileOnly) { CorePolicy.ValidateProfileOnlySpec(spec); native.BindProfileOnlyContext(spec); }
        else if (arguments[1] == "f1-controller") { F1Policy.ValidatePrepared(spec, false); native.BindF1ControllerContext(spec); }
        else { CorePolicy.ValidateControllerSpec(spec); native.BindControllerContext(spec); }
        report = new FixtureReport { mode = profileOnly ? "profile-only" : arguments[1] == "f1-controller" ? "f1-controller" : "controller", binarySha256 = CorePolicy.HashFile(CorePolicy.BinaryPath),
          specSha256 = CorePolicy.HashFile(specFile) };
        FixtureState state = Controller.NewState(spec, report);
        Controller.Run(state, native);
        if (state.controllerRootOwned) CoreJson.Write(spec.output, report);
        return report.status == "passed" ? 0 : 1;
      }
      catch (Exception error)
      {
        // No exception text/arguments: usernames, credentials and environment
        // values never become console diagnostics or public report fields.
        if (report != null && output != null && !File.Exists(output))
        {
          try
          {
            report.status = "failed"; report.Check("fixture-entry", false, arguments.Length > 0 && arguments[0] == "--f1-audit-canary" ? NativePlatform.SafeCanaryFailure(error) : NativePlatform.SafeFailure(error));
            report.binarySha256 = CorePolicy.HashFile(CorePolicy.BinaryPath);
            report.finishedAtUtc = DateTime.UtcNow.ToString("o"); CoreJson.Write(output, report);
          }
          catch { }
        }
        Console.Error.WriteLine("Installer profile fixture stopped: " + (arguments.Length > 0 && arguments[0] == "--f1-audit-canary" ? NativePlatform.SafeCanaryFailure(error) : NativePlatform.SafeFailure(error)));
        return 1;
      }
    }
  }

  [DataContract]
  internal sealed class F1DebugNotice
  {
    [DataMember] public long sequence;
    [DataMember] public string kind;
    [DataMember] public string phase;
    [DataMember] public string nonce;
    [DataMember] public int pid, tid;
    [DataMember] public string creationTime;
    [DataMember] public FileIdentity image;
    [DataMember] public string sid;
    [DataMember] public int exitCode;
    [DataMember] public long barrier;
    [DataMember] public bool continued;
  }
  [DataContract]
  internal sealed class F1DebugReply
  {
    [DataMember] public long sequence, barrier;
    [DataMember] public bool accept;
  }
  internal sealed class F1DebugRecord
  {
    internal int code, pid, tid, exitCode;
    internal uint exception;
    internal bool firstChance;
    internal IntPtr file;
  }
  internal interface F1DebugApi : IDisposable
  {
    F1DebugRecord Wait(int milliseconds);
    F1DebugNotice Capture(F1DebugRecord record);
    void CloseImage(F1DebugRecord record);
    void Continue(F1DebugRecord record, uint disposition);
    void TerminateOwnedJob();
    bool JobEmpty { get; }
    void WaitNaturalExit(int milliseconds);
    void WaitTerminatedExit(int milliseconds);
  }
  // Same synchronous machine is used by Win32 and deterministic replays.
  // It never waits for kernel shutdown while EXIT is still pending.
  internal sealed class F1DebugPump : IDisposable
  {
    private readonly F1DebugApi api;
    private readonly Func<F1DebugNotice, F1DebugReply> exchange;
    private readonly string phase, nonce;
    private readonly int thread = System.Threading.Thread.CurrentThread.ManagedThreadId;
    private readonly HashSet<int> live = new HashSet<int>(), breakpoints = new HashSet<int>();
    private F1DebugRecord pending;
    private long sequence, barrier;
    private bool finished, aborted, abortComplete, disposed, closureUnknown;
    internal F1DebugPump(F1DebugApi native, Func<F1DebugNotice, F1DebugReply> transport, string p, string n)
    { CorePolicy.Require(native != null && transport != null, "f1-debug-dependencies"); api = native; exchange = transport; phase = p; nonce = n; }
    private void Owner() { CorePolicy.Require(thread == System.Threading.Thread.CurrentThread.ManagedThreadId && !disposed, "f1-debug-creating-thread-only"); }
    private void Ack(F1DebugNotice notice)
    {
      notice.sequence = ++sequence; notice.phase = phase; notice.nonce = nonce;
      F1DebugReply reply = exchange(notice);
      CorePolicy.Require(reply != null && reply.accept && reply.sequence == notice.sequence && reply.barrier == notice.barrier, "f1-debug-exact-single-ack");
    }
    private void Continue(uint disposition)
    {
      CorePolicy.Require(pending != null, "f1-debug-single-pending-event");
      api.Continue(pending, disposition); pending = null;
    }
    internal void Step(int milliseconds)
    {
      Owner(); CorePolicy.Require(!finished && !aborted && pending == null, "f1-debug-step-state");
      pending = api.Wait(milliseconds); if (pending == null) return;
      F1DebugRecord item = pending;
      if (item.code == 3)
      {
        F1DebugNotice notice;
        try { notice = api.Capture(item); }
        finally { api.CloseImage(item); }
        CorePolicy.Require(notice != null && notice.pid == item.pid && notice.tid == item.tid && !live.Contains(item.pid), "f1-debug-unique-process-epoch");
        notice.kind = "create"; notice.barrier = ++barrier; notice.continued = false; Ack(notice);
        live.Add(item.pid); breakpoints.Add(item.pid);
        Continue(0x00010002);
        // Preallocated before Continue; never a post-Continue QPC claim.
        notice = new F1DebugNotice { kind = "continued", pid = item.pid, tid = item.tid, barrier = notice.barrier, continued = true };
        Ack(notice);
      }
      else if (item.code == 5)
      {
        CorePolicy.Require(live.Contains(item.pid), "f1-debug-exit-without-create");
        F1DebugNotice notice = new F1DebugNotice { kind = "exit", pid = item.pid, tid = item.tid, exitCode = item.exitCode, barrier = ++barrier };
        Ack(notice); Continue(0x00010002); live.Remove(item.pid); breakpoints.Remove(item.pid);
        if (live.Count == 0) { api.WaitNaturalExit(milliseconds); CorePolicy.Require(api.JobEmpty, "f1-debug-natural-job-empty"); finished = true; }
      }
      else if (item.code == 6) { api.CloseImage(item); Continue(0x00010002); }
      else if (item.code == 1)
      {
        CorePolicy.Require(live.Contains(item.pid), "f1-debug-exception-epoch");
        bool loader = item.firstChance && (item.exception == 0x80000003 || item.exception == 0x4000001f) && breakpoints.Remove(item.pid);
        Continue(loader ? 0x00010002U : 0x80010001U);
      }
      else if (item.code == 2)
      { CorePolicy.Require(live.Contains(item.pid), "f1-debug-thread-epoch"); F1DebugNotice notice = api.Capture(item); notice.kind = "thread"; notice.barrier = barrier; Ack(notice); Continue(0x00010002); }
      else if (item.code == 4 || item.code == 7 || item.code == 8)
      { CorePolicy.Require(live.Contains(item.pid), "f1-debug-event-epoch"); Continue(0x00010002); }
      else throw new FixtureFailure("f1-unknown-debug-event");
    }
    internal void Run(int milliseconds)
    {
      Owner(); Stopwatch budget = Stopwatch.StartNew();
      try { while (!finished) { CorePolicy.Require(budget.ElapsedMilliseconds < milliseconds, "f1-debug-phase-deadline"); Step((int)Math.Min(1000, milliseconds - budget.ElapsedMilliseconds)); } }
      catch { try { Abort(); } catch { closureUnknown = true; } throw; }
    }
    internal void Abort()
    {
      Owner(); if (finished || abortComplete) return;
      CorePolicy.Require(!closureUnknown && !aborted, "f1-debug-abort-previously-unknown"); aborted = true;
      try
      {
      // Signal only the separately verified owned Job, then release the stopped
      // event and drain on the creating thread. No kill-by-PID or image name.
      api.TerminateOwnedJob();
      HashSet<int> draining = new HashSet<int>(live);
      if (pending != null) DrainTerminatedEvent(draining);
      Stopwatch budget = Stopwatch.StartNew();
      while ((draining.Count != 0 || !api.JobEmpty) && budget.ElapsedMilliseconds < 5000)
      {
        F1DebugRecord next = api.Wait(100); if (next == null) continue;
        pending = next; DrainTerminatedEvent(draining);
      }
      CorePolicy.Require(draining.Count == 0 && api.JobEmpty && budget.ElapsedMilliseconds < 5000, "f1-debug-abort-closure-unknown");
      api.WaitTerminatedExit(5000 - checked((int)budget.ElapsedMilliseconds));
      CorePolicy.Require(api.JobEmpty, "f1-debug-abort-final-job-not-empty");
      abortComplete = true;
      }
      catch { closureUnknown = true; throw; }
    }
    private void DrainTerminatedEvent(HashSet<int> draining)
    {
      F1DebugRecord item = pending;
      if (item.code == 3) draining.Add(item.pid);
      try { api.CloseImage(item); } finally { Continue(item.code == 1 ? 0x80010001U : 0x00010002U); }
      if (item.code == 5) CorePolicy.Require(draining.Remove(item.pid), "f1-debug-abort-unobserved-exit");
    }
    internal bool Finished { get { return finished && !aborted; } }
    public void Dispose() { if (disposed) return; Owner(); CorePolicy.Require(!closureUnknown, "f1-debug-closure-unknown-retain-caps"); if (!finished) Abort(); CorePolicy.Require((finished || abortComplete) && api.JobEmpty, "f1-debug-drain-before-cap-close"); try { api.Dispose(); disposed = true; } catch { closureUnknown = true; throw; } }
  }

  internal enum F1LengthKind { Unspecified, Fixed, Parameter }
  internal sealed class F1MetadataField
  {
    internal string name;
    internal ushort inputType;
    internal int fixedLength, lengthProperty = -1, fixedCount = 1, countProperty = -1;
    internal bool skipValue;
    internal F1LengthKind lengthKind;
  }
  internal interface F1MetadataBytes { byte Read(int offset); }
  internal sealed class F1ArrayMetadataBytes : F1MetadataBytes
  {
    private readonly byte[] data;
    internal F1ArrayMetadataBytes(byte[] bytes) { data = bytes; }
    public byte Read(int offset) { return data[offset]; }
  }
  internal sealed class F1MetadataPlan
  {
    internal readonly List<F1MetadataField> fields = new List<F1MetadataField>();
    internal static readonly HashSet<string> MetadataNames = new HashSet<string>(StringComparer.Ordinal) {
      "BaseObject", "KeyObject", "Status", "Disposition", "BaseName", "RelativeName", "KeyName", "Irp", "FileObject", "IssuingThreadId",
      "CreateOptions", "CreateAttributes", "ShareAccess", "FileName", "ExtraInformation", "FileKey", "InfoClass", "ByteOffset", "IOSize",
      "IOFlags", "ExtraFlags", "Length", "FileIndex", "Type", "DataSize", "ValueName", "CapturedDataSize", "PreviousDataType", "PreviousDataSize", "PreviousDataCapturedSize" };

    internal static F1MetadataField Project(string name, ushort type, int flags, int count, int length, int ordinal)
    {
      CorePolicy.Require((flags & ~0x36) == 0 && (flags & 0x12) != 0x12 && (flags & 0x24) != 0x24, "f1-supported-tdh-property-flags");
      F1MetadataField field = new F1MetadataField { name = name, inputType = type, skipValue = name == "CapturedData" || name == "PreviousData",
        fixedCount = count == 0 && (flags & 0x20) == 0 ? 1 : count, fixedLength = length,
        lengthKind = (flags & 2) != 0 ? F1LengthKind.Parameter : (flags & 0x10) != 0 || length != 0 ? F1LengthKind.Fixed : F1LengthKind.Unspecified };
      if ((flags & 2) != 0) { CorePolicy.Require(length < ordinal, "f1-schema-prior-length-property"); field.lengthProperty = length; field.fixedLength = 0; }
      if ((flags & 4) != 0) { CorePolicy.Require(count < ordinal, "f1-schema-prior-count-property"); field.countProperty = count; }
      return field;
    }
    private static F1LengthKind Kind(F1MetadataField field)
    { return field.lengthProperty >= 0 ? F1LengthKind.Parameter : field.lengthKind == F1LengthKind.Parameter ? F1LengthKind.Parameter : field.lengthKind == F1LengthKind.Fixed || field.fixedLength != 0 ? F1LengthKind.Fixed : F1LengthKind.Unspecified; }
    internal void ValidateShape(int pointer)
    {
      HashSet<string> names = new HashSet<string>(StringComparer.Ordinal);
      for (int i = 0; i < fields.Count; i++)
      {
        F1MetadataField f = fields[i];
        CorePolicy.Require(f != null && !String.IsNullOrEmpty(f.name) && names.Add(f.name) && (f.skipValue || MetadataNames.Contains(f.name)), "f1-known-metadata-shape");
        CorePolicy.Require(f.fixedLength >= 0 && f.fixedCount >= 0 && f.lengthProperty < i && f.countProperty < i, "f1-prior-size-field-only");
        foreach (int reference in new int[] { f.lengthProperty, f.countProperty }) if (reference >= 0)
          CorePolicy.Require(ScalarWidth(fields[reference].inputType, pointer) > 0 && !fields[reference].skipValue && fields[reference].fixedCount == 1 && fields[reference].countProperty < 0, "f1-scalar-size-reference");
        F1LengthKind kind = Kind(f);
        CorePolicy.Require((kind != F1LengthKind.Parameter || f.lengthProperty >= 0) && (f.lengthKind != F1LengthKind.Fixed || f.lengthProperty < 0), "f1-unambiguous-length-kind");
        if (f.skipValue)
          CorePolicy.Require((f.name == "CapturedData" || f.name == "PreviousData") && f.inputType == 14 && kind != F1LengthKind.Unspecified, "f1-explicit-value-span-required");
        else
        {
          CorePolicy.Require(f.fixedCount == 1 && f.countProperty < 0, "f1-metadata-arrays-unsupported");
          if (f.inputType == 1)
            CorePolicy.Require(kind == F1LengthKind.Unspecified || (kind == F1LengthKind.Fixed && f.fixedLength == 0), "f1-explicit-nonzero-or-param-string-unsupported");
          else { int width = ScalarWidth(f.inputType, pointer); CorePolicy.Require(width > 0 && kind != F1LengthKind.Parameter && (kind != F1LengthKind.Fixed || f.fixedLength == width), "f1-known-scalar-width"); }
        }
      }
    }
    internal int PointerWidth(int flags)
    {
      int width = flags & 0x60;
      CorePolicy.Require(width != 0x60 && (width != 0 || !fields.Any(field => field.inputType == 16)), "f1-explicit-payload-pointer-width");
      return width == 0x20 ? 4 : 8;
    }
    private static int ScalarWidth(ushort type, int pointer)
    { if (type == 3 || type == 4) return 1; if (type == 5 || type == 6) return 2; if (type == 7 || type == 8 || type == 13 || type == 20) return 4;
      if (type == 9 || type == 10 || type == 17 || type == 21) return 8; if (type == 16) return pointer; return 0; }
    internal Dictionary<string, object> Read(F1MetadataBytes source, int length, int pointer)
    {
      CorePolicy.Require(source != null && length >= 0 && length <= 65535 && (pointer == 4 || pointer == 8), "f1-bounded-metadata-body");
      ValidateShape(pointer); // Entire schema is checked before the first body byte.
      Dictionary<string, object> output = new Dictionary<string, object>(StringComparer.Ordinal); List<ulong> numbers = new List<ulong>(); int at = 0;
      foreach (F1MetadataField f in fields)
      {
        CorePolicy.Require(f != null && !String.IsNullOrEmpty(f.name) && !output.ContainsKey(f.name) &&
          (f.skipValue || MetadataNames.Contains(f.name)), "f1-unknown-schema-field");
        CorePolicy.Require(f.countProperty < numbers.Count && f.lengthProperty < numbers.Count, "f1-prior-size-field-only");
        int count = f.countProperty >= 0 ? checked((int)numbers[f.countProperty]) : f.fixedCount;
        int span = f.lengthProperty >= 0 ? checked((int)numbers[f.lengthProperty]) : f.fixedLength;
        CorePolicy.Require(count >= 0 && count <= 65535 && span >= 0 && span <= length, "f1-invalid-metadata-span");
        if (f.skipValue)
        {
          CorePolicy.Require((f.name == "CapturedData" || f.name == "PreviousData") && f.inputType == 14 && (Kind(f) != F1LengthKind.Unspecified), "f1-value-span-only");
          int bytes = checked(span * count); CorePolicy.Require(bytes <= length - at, "f1-value-span-overflow"); at += bytes; numbers.Add(0); continue;
        }
        CorePolicy.Require(count == 1, "f1-metadata-arrays-unsupported"); int width = ScalarWidth(f.inputType, pointer);
        if (width > 0)
        {
          CorePolicy.Require(width <= length - at && (span == 0 || span == width), "f1-metadata-scalar-span");
          ulong number = 0; for (int i = 0; i < width; i++) number |= ((ulong)source.Read(at + i)) << (8 * i);
          at += width; output.Add(f.name, number); numbers.Add(number);
        }
        else if (f.inputType == 1)
        {
          if (Kind(f) == F1LengthKind.Fixed) { output.Add(f.name, String.Empty); numbers.Add(0); continue; }
          StringBuilder text = new StringBuilder(); bool terminated = false;
          int limit = length;
          while (at < limit) { CorePolicy.Require(at + 1 < limit, "f1-metadata-string-truncated"); ushort ch = (ushort)(source.Read(at) | (source.Read(at + 1) << 8)); at += 2; if (ch == 0) { terminated = true; break; } CorePolicy.Require(text.Length < 32767, "f1-metadata-string-bound"); text.Append((char)ch); }
          CorePolicy.Require(terminated, "f1-metadata-string-termination"); output.Add(f.name, text.ToString()); numbers.Add(0);
        }
        else throw new FixtureFailure("f1-unsupported-metadata-type");
      }
      CorePolicy.Require(at == length, "f1-metadata-unclaimed-tail"); return output;
    }
  }

  // Metadata-only object/IRP reducer. A close retires a handle generation;
  // deletion is separate. Names are only learned from observed absolute names
  // or a live observed BaseObject, never from the canary API arguments.
  internal sealed class F1ObservedNamespaces
  {
    private sealed class Pending { internal string kind, path; internal ulong obj; internal long qpc; }
    private readonly Dictionary<ulong, string> files = new Dictionary<ulong, string>(), keys = new Dictionary<ulong, string>(), fileKeys = new Dictionary<ulong, string>();
    private readonly Dictionary<ulong, Pending> irps = new Dictionary<ulong, Pending>();
    private readonly Dictionary<ulong, ulong> createIrps = new Dictionary<ulong, ulong>();
    private readonly Dictionary<ulong, long> generations = new Dictionary<ulong, long>();
    internal readonly List<F1AuditOperation> operations = new List<F1AuditOperation>();
    internal long FileWrites, RegistrySets, KeyCloses, FileCloses;
    internal bool Gap;
    internal string CanaryFile, CanaryRegistry;
    internal int PendingCount { get { return irps.Count; } }
    private static ulong Number(Dictionary<string, object> data, string name)
    { object value; return data.TryGetValue(name, out value) && value is ulong ? (ulong)value : 0; }
    private static string Text(Dictionary<string, object> data, string name)
    { object value; return data.TryGetValue(name, out value) && value is string ? (string)value : null; }
    private static bool Same(string a, string b) { return !String.IsNullOrEmpty(a) && String.Equals(a, b, StringComparison.OrdinalIgnoreCase); }
    private static bool AbsoluteKey(string name) { return name != null && name.StartsWith(@"\REGISTRY\", StringComparison.OrdinalIgnoreCase); }
    private static bool AbsoluteFile(string name) { return name != null && name.StartsWith(@"\Device\", StringComparison.OrdinalIgnoreCase); }
    internal void Registry(int id, int version, Dictionary<string, object> d, long qpc)
    {
      if (version != 0 || !d.ContainsKey("Status")) { Gap = true; return; }
      ulong obj = Number(d, "KeyObject"); if (obj == 0) { Gap = true; return; }
      if (Number(d, "Status") != 0) return;
      if (id == 1 || id == 2)
      {
        string relative = Text(d, "RelativeName"), baseName = Text(d, "BaseName"), path = null;
        if (AbsoluteKey(relative)) path = relative;
        else if (AbsoluteKey(baseName)) path = String.IsNullOrEmpty(relative) ? baseName : baseName.TrimEnd('\\') + "\\" + relative;
        else { string parent; if (keys.TryGetValue(Number(d, "BaseObject"), out parent)) path = String.IsNullOrEmpty(relative) ? parent : parent.TrimEnd('\\') + "\\" + relative; }
        if (!AbsoluteKey(path)) { Gap = true; return; }
        if (keys.ContainsKey(obj)) { Gap = true; return; }
        long generation; generations.TryGetValue(obj, out generation); generations[obj] = generation + 1; keys.Add(obj, path);
      }
      else if (id == 13) { if (!keys.Remove(obj)) Gap = true; else KeyCloses++; }
      else if (id == 5)
      {
        string path; if (!keys.TryGetValue(obj, out path)) { Gap = true; return; }
        // Normal nonzero DataSize is metadata, never an excuse to read bytes.
        if (Same(path, CanaryRegistry)) RegistrySets++;
      }
      else if (id == 3) { if (!keys.ContainsKey(obj)) Gap = true; /* Delete is observed, not a close or final snapshot. */ }
      else if (id < 1 || id > 15) Gap = true;
    }
    internal void File(int id, int version, Dictionary<string, object> d, long qpc)
    {
      ulong obj = Number(d, "FileObject"), key = Number(d, "FileKey"), irp = Number(d, "Irp");
      if (id == 10 || id == 11)
      { string name = Text(d, "FileName"); if (key == 0 || !AbsoluteFile(name)) { Gap = true; return; } if (id == 10) fileKeys[key] = name; else fileKeys.Remove(key); return; }
      if (id == 24 && version == 0)
      {
        Pending pending; if (irp == 0 || !irps.TryGetValue(irp, out pending)) return;
        irps.Remove(irp); if (qpc <= pending.qpc) { Gap = true; return; }
        if (Number(d, "Status") == 0 && d.ContainsKey("Status"))
        { if (pending.kind == "write" && Same(pending.path, CanaryFile)) FileWrites++; if (pending.kind == "close") { files.Remove(pending.obj); createIrps.Remove(pending.obj); FileCloses++; } }
        return;
      }
      if (version != 1) { Gap = true; return; }
      if (id == 12 || id == 30)
      { string path = Text(d, "FileName"); if (obj == 0 || !AbsoluteFile(path)) { Gap = true; return; } if (files.ContainsKey(obj)) { if (id != 30 || !Same(files[obj], path) || !createIrps.ContainsKey(obj) || createIrps[obj] != irp) { Gap = true; return; } } else { files.Add(obj, path); createIrps[obj] = irp; } }
      string current = null;
      if (obj != 0) files.TryGetValue(obj, out current);
      if (key != 0 && fileKeys.ContainsKey(key)) { if (current != null && !Same(current, fileKeys[key])) { Gap = true; return; } current = fileKeys[key]; }
      if (id == 16 || id == 18 || id == 19 || id == 14)
      {
        if (irp == 0 || current == null || irps.ContainsKey(irp)) { Gap = true; return; }
        irps.Add(irp, new Pending { kind = id == 16 ? "write" : id == 18 ? "delete" : id == 19 ? "rename" : "close", path = current, obj = obj, qpc = qpc });
      }
      if (id == 26 || id == 27 || id == 28 || id == 29) Gap = true; // target/link bridge is not inferred from adjacent arrival.
    }
  }

  internal static class F1KnownMetadataSchemas
  {
    // Verified 4a source XML SHA233b7ff46f425efeb68e062f3e79c08288da41ce069f8bcbc53a54f023c0a6a1.
    // Names only: native types/lengths are read from TDH, never inferred from XML text.
    internal static bool Matches(bool registry, int id, int version, int opcode, IEnumerable<string> fields)
    {
      string names = null;
      if (registry && version == 0 && opcode == id + 31)
      {
        if (id == 1 || id == 2) names = "BaseObject,KeyObject,Status,Disposition,BaseName,RelativeName";
        if (id == 3 || id == 13) names = "KeyObject,Status,KeyName";
        if (id == 5) names = "KeyObject,Status,Type,DataSize,KeyName,ValueName,CapturedDataSize,CapturedData,PreviousDataType,PreviousDataSize,PreviousDataCapturedSize,PreviousData";
      }
      if (!registry && opcode == 0)
      {
        if ((id == 10 || id == 11) && version == 0) names = "FileKey,FileName";
        if ((id == 12 || id == 30) && version == 1) names = "Irp,FileObject,IssuingThreadId,CreateOptions,CreateAttributes,ShareAccess,FileName";
        if ((id == 13 || id == 14 || id == 21) && version == 1) names = "Irp,FileObject,FileKey,IssuingThreadId";
        if ((id == 15 || id == 16) && version == 1) names = "ByteOffset,Irp,FileObject,FileKey,IssuingThreadId,IOSize,IOFlags,ExtraFlags";
        if (new int[] {17,18,19,22,23,32,34}.Contains(id) && version == 1) names = "Irp,FileObject,FileKey,ExtraInformation,IssuingThreadId,InfoClass";
        if (id == 20 && version == 1) names = "Irp,FileObject,FileKey,IssuingThreadId,Length,InfoClass,FileIndex,FileName";
        if (id == 24 && version == 0) names = "Irp,ExtraInformation,Status";
      }
      if (names == null) return false;
      string[] expected = names.Split(','); string[] actual = fields.ToArray();
      return actual.Length == expected.Length && actual.Distinct(StringComparer.Ordinal).Count() == actual.Length && new HashSet<string>(expected, StringComparer.Ordinal).SetEquals(actual);
    }
  }

  [DataContract]
  internal sealed class F1SessionObservation
  {
    [DataMember] public string status = "not_proven", F1 = "not_proven", scopeSupport = "not_proven";
    [DataMember] public string name, guid;
    [DataMember] public ulong retainedHandle;
    [DataMember] public bool startAttempted, started, stopAttempted, stopped, consumerDrained, closed, gap;
    [DataMember] public long? eventsLost, buffersLost;
    [DataMember] public uint? processTraceResult, fileEnableCode, registryEnableCode;
    [DataMember] public long ownedRecords, otherHeaders, unknownRecords, mappedFileWrites, mappedRegistrySets;
    [DataMember] public int childPid;
    [DataMember] public bool childResumeAttempted, childResumed, childExited;
    [DataMember] public string childCreationTime;
    [DataMember] public List<string> nativeSchemaShapes = new List<string>();
  }
}
