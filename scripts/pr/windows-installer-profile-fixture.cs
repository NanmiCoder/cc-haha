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
        if (!api.IsFake) CorePolicy.ValidateBindings(state.spec, api);
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
          subject.mode = "historical-v078-subject"; subject.controllerSpecSha256 = state.report.specSha256;
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
      if (native && (phase == "fresh-install" || phase == "old22-negative" || phase == "old-normal-removal-positive"))
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
      string[] sequence = { "observer-calibration", "powershell-normal-capability-1", "powershell-normal-capability-2",
        "powershell-unavailable-capability", "fresh-install", "negative-preflight", "old22-negative",
        "positive-preflight", "old-normal-removal-positive" };
      int phaseIndex = 0;
      DateTime deadline = DateTime.UtcNow.AddMinutes(10);
      string active = null;
      while (true)
      {
        CorePolicy.Require(DateTime.UtcNow < deadline, "subject-overall-deadline");
        int remaining = (int)Math.Max(1, (deadline - DateTime.UtcNow).TotalMilliseconds);
        int phaseBudget = active == "fresh-install" ? 305000
          : active == "old22-negative" || active == "old-normal-removal-positive" ? 185000 : 35000;
        ProtocolMessage message = CoreJson.Deserialize<ProtocolMessage>(state.channel.ReadLine(Math.Min(remaining, active == null ? 30000 : phaseBudget)));
        CorePolicy.Require(message.version == 1 && message.nonce == state.spec.nonce, "phase-nonce");
        if (message.kind == "phase-start")
        {
          CorePolicy.Require(active == null && message.phase != null && !phases.Contains(message.phase)
            && phaseIndex < sequence.Length && message.phase == sequence[phaseIndex], "one-ordered-owned-phase");
          api.VerifyReportedPhase(state, message);
          if (observer != null) observer.Arm(message.phase, message.pid, message.creationTime);
          active = message.phase;
          SendPhaseAck(state.report, state.channel, state.spec.nonce, message.phase, !api.IsFake);
        }
        else if (message.kind == "phase-end")
        {
          CorePolicy.Require(active == message.phase && message.evidence != null && message.evidence.phase == active, "phase-completion-binding");
          bool unavailable = active == "old22-negative" || active == "old-normal-removal-positive" || active == "powershell-unavailable-capability";
          Dictionary<string, string> expectedEnvironment = unavailable
            ? CorePolicy.BuildEnvironment(state.targetEnvironment, state.spec, true) : state.targetEnvironment;
          CorePolicy.Require(message.evidence.environmentSha256 == CorePolicy.EnvironmentHash(expectedEnvironment), "phase-environment-binding");
          int expectedExit = active == "observer-calibration" || active == "positive-preflight" ? 1 : active == "old22-negative" ? 22 : 0;
          CorePolicy.Require(active == "powershell-unavailable-capability" ? message.evidence.exitCode != 0
            : message.evidence.exitCode == expectedExit, "phase-native-exit");
          if (active == "fresh-install") CorePolicy.Require(message.evidence.installedUninstallerSha256 == CorePolicy.UninstallerHash
            && message.evidence.argvSha256 == CorePolicy.HashText(CorePolicy.SetupCommand(state.spec.setupPath, state.spec.installRoot)), "installed-byte-and-argv-binding");
          if (active == "old22-negative" || active == "old-normal-removal-positive")
          {
            CorePolicy.Require(message.evidence.applicationSha256 == CorePolicy.UninstallerHash
              && message.evidence.argvSha256 == CorePolicy.HashText(CorePolicy.UninstallerCommand(state.spec.uninstallerCopy, state.spec.installRoot)), "same-old-binary-and-argv");
            if (active == "old22-negative") CorePolicy.Require(message.evidence.helperAlive && message.evidence.protectedFinalStateUnchanged, "negative-native-postconditions");
            else CorePolicy.Require(message.evidence.payloadRemoved && message.evidence.registrationRemoved && message.evidence.keptDataUnchanged, "positive-native-postconditions");
          }
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
          if (!api.IsFake && (message.phase == "fresh-install" || message.phase == "old22-negative" || message.phase == "old-normal-removal-positive"))
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
            string evidenceDirectory = Path.Combine(state.spec.controllerRoot, "evidence");
            Directory.CreateDirectory(evidenceDirectory);
            foreach (KeyValuePair<string, string> file in message.report.evidenceFiles)
            {
              CorePolicy.Require(new string[] { "negative-before.json", "negative-after.json", "positive-kept-before.json", "positive-kept-after.json" }.Contains(file.Key), "bounded-evidence-file");
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
  internal sealed class ProtectedSnapshot
  {
    [DataMember] public Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.Ordinal);
    private long bytes;

    private void FileEntry(string label, string file, ProfilePlatform api)
    {
      FileIdentity identity = api.IdentifyPath(file, false);
      CorePolicy.Require(!identity.reparse && identity.sha256 != null, "snapshot-ordinary-file");
      bytes += identity.bytes;
      CorePolicy.Require(bytes <= 2147483648L && values.Count <= 20000, "bounded-protected-snapshot");
      values[label] = identity.fileId + ":" + identity.bytes + ":" + identity.sha256;
    }

    private void DirectoryEntry(string label, string directory, ProfilePlatform api, int depth)
    {
      CorePolicy.Require(depth <= 32 && values.Count <= 20000, "bounded-protected-tree");
      if (!Directory.Exists(directory)) { values[label] = "absent"; return; }
      FileIdentity identity = api.IdentifyPath(directory, true);
      CorePolicy.Require(!identity.reparse, "no-snapshot-reparse-directory");
      values[label + "/@directory"] = identity.fileId;
      foreach (string file in Directory.GetFiles(directory).OrderBy(item => item, StringComparer.Ordinal))
        FileEntry(label + "/" + Path.GetFileName(file), file, api);
      foreach (string child in Directory.GetDirectories(directory).OrderBy(item => item, StringComparer.Ordinal))
        DirectoryEntry(label + "/" + Path.GetFileName(child), child, api, depth + 1);
    }

    public static ProtectedSnapshot Capture(FixtureSpec spec, ProfilePlatform api, bool payload)
    {
      ProtectedSnapshot snapshot = new ProtectedSnapshot();
      if (payload)
      {
        snapshot.DirectoryEntry("payload", spec.installRoot, api, 0);
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
          if (File.Exists(file)) snapshot.FileEntry(root.Key + "/" + name, file, api);
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

    public string WriteRedacted(string file, FixtureSpec spec)
    {
      ProtectedSnapshot redacted = new ProtectedSnapshot();
      foreach (KeyValuePair<string, string> value in values)
        redacted.values[value.Key] = value.Value.Replace(spec.profilePath, "<OWNED_PROFILE>");
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
      FixtureReport report = new FixtureReport { mode = "subject", binarySha256 = CorePolicy.HashFile(CorePolicy.BinaryPath),
        specSha256 = CorePolicy.HashFile(spec.subjectSpecPath) };
      FixtureChannel channel = null;
      Subject subject = null;
      try
      {
        CorePolicy.ValidateSubjectSpec(spec);
        api.BindSubjectContext(spec);
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
      try
      {
        api.StartChild(child, command, environment, spec.fixtureRoot, spec.desktopName);
        api.VerifyChild(child, spec.expectedSid, command.application, command.expectedSha256);
        channel.WriteLine(CoreJson.Serialize(new ProtocolMessage { kind = "phase-start", nonce = spec.nonce,
          phase = command.phase, pid = child.pid, creationTime = child.creationTime, image = child.image, sid = spec.expectedSid }));
        ReadAck("phase-ack", command.phase);
        api.ResumeChild(child);
        if (command.phase == "fresh-install" || command.phase == "old22-negative" || command.phase == "old-normal-removal-positive")
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
      finally
      {
        api.StopChild(child); api.CloseChild(child); owned.Remove(child);
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
          && (arguments[1] == "controller" || arguments[1] == "subject" || arguments[1] == "profile-only"), "explicit-role-required-no-default-execution");
        string specFile = Path.GetFullPath(arguments[3]);
        FixtureSpec spec = CoreJson.Read<FixtureSpec>(specFile);
        NativePlatform native = new NativePlatform();
        if (arguments[1] == "subject")
        {
          CorePolicy.Require(CorePolicy.SamePath(spec.subjectSpecPath, specFile), "subject-spec-file-binding");
          FixtureReport result = Subject.Run(spec, native);
          return result.status == "passed" ? 0 : 1;
        }
        bool profileOnly = arguments[1] == "profile-only";
        CorePolicy.Require(Environment.GetEnvironmentVariable("CI") == "true", "controller-disposable-ci-only");
        if (profileOnly) { CorePolicy.ValidateProfileOnlySpec(spec); native.BindProfileOnlyContext(spec); }
        else { CorePolicy.ValidateControllerSpec(spec); native.BindControllerContext(spec); }
        report = new FixtureReport { mode = profileOnly ? "profile-only" : "controller", binarySha256 = CorePolicy.HashFile(CorePolicy.BinaryPath),
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
            report.status = "failed"; report.Check("fixture-entry", false, NativePlatform.SafeFailure(error));
            report.binarySha256 = CorePolicy.HashFile(CorePolicy.BinaryPath);
            report.finishedAtUtc = DateTime.UtcNow.ToString("o"); CoreJson.Write(output, report);
          }
          catch { }
        }
        Console.Error.WriteLine("Installer profile fixture stopped: " + NativePlatform.SafeFailure(error));
        return 1;
      }
    }
  }
}
