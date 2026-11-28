# REVIEW-ONLY emergency-disable proposal. No Stage B admission is supplied here.
# Default: summary only. Never unload a hive, delete a profile/account, or kill.
[CmdletBinding()]
param(
  [switch]$DisableReviewedOwnedAccount,
  [string]$ApprovedSpecSha256
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$expectedSpecHash = '337f999c0c3a0417c90ab4aae501849901ddf82c1d44d522083f311036de0a90'
if (-not $DisableReviewedOwnedAccount) {
  [ordered]@{ status = 'not_run'; admission = 'not_granted_by_this_file'; specSha256 = $expectedSpecHash; accountApi = 'not_run'; cleanup = 'not_run'; retryAllowed = $false } | ConvertTo-Json
  return
}

# Every statement below, including Add-Type, belongs only to a future separately
# admitted execution. No SAM, SID, password or arbitrary path is accepted as argv.
$stage = 'external-admission-and-context'
$held = New-Object 'System.Collections.Generic.List[System.IDisposable]'
$receiptStream = $null
$savedEnvironment = @{}
$reconciliation = $null

function Require-True([bool]$Condition) { if (-not $Condition) { throw 'Reviewed reconciliation precondition failed' } }
function Is-Integer($Value) { return ($Value -is [int] -or $Value -is [long] -or $Value -is [uint32] -or $Value -is [uint64]) }
function Hash-Text([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function Assert-OrdinaryPath([string]$Path, [bool]$Directory) {
  $item = Get-Item -LiteralPath $Path -Force
  Require-True ($item.PSIsContainer -eq $Directory)
  Require-True (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
  $parent = if ($Directory) { $item.Parent } else { $item.Directory }
  while ($null -ne $parent) {
    Require-True (($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
    $parent = $parent.Parent
  }
}
function Assert-PrivateAcl($Security, [string]$RunnerSid, [string]$MetadataSid, [bool]$ProtectedRoot) {
  $ownerSid = $Security.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($ProtectedRoot) {
    Require-True ($Security.AreAccessRulesProtected -and $ownerSid -ceq $RunnerSid)
  } else {
    # Elevated Windows file creation may choose the Administrators owner SID.
    # Owner authority is trusted only for runner/SYSTEM/Administrators; DACL data
    # access below must still be exclusively this exact runner and SYSTEM.
    Require-True (@($RunnerSid, 'S-1-5-18', 'S-1-5-32-544') -ccontains $ownerSid)
  }
  $runnerFull = $false
  $systemFull = $false
  foreach ($rule in $Security.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    Require-True ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow)
    $identity = $rule.IdentityReference.Value
    $mask = [long]$rule.FileSystemRights
    if ($identity -ceq $RunnerSid -or $identity -ceq 'S-1-5-18') {
      Require-True ($mask -eq [long][Security.AccessControl.FileSystemRights]::FullControl)
      if ($identity -ceq $RunnerSid) { $runnerFull = $true } else { $systemFull = $true }
    } else {
      # The only exception is the frozen this-folder-only metadata grant.
      # FileSystemAccessRule Allow can automatically add SYNCHRONIZE.
      Require-True ($MetadataSid -and $identity -ceq $MetadataSid -and
        ($mask -eq 0xa0 -or $mask -eq 0x1000a0) -and -not $rule.IsInherited -and
        $rule.InheritanceFlags -eq [Security.AccessControl.InheritanceFlags]::None -and
        $rule.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None)
    }
  }
  Require-True ($runnerFull -and $systemFull)
}
function Open-PrivateJson([string]$Path, [string]$RunnerSid, [bool]$HoldAgainstChanges) {
  Assert-OrdinaryPath $Path $false
  # Before liveness is proved, snapshots must not interfere with Controller
  # AtomicWrite or the launcher's receipt writes. Only a stopped Controller
  # permits the second, held read which excludes replacement and writes.
  $share = if ($HoldAgainstChanges) { [IO.FileShare]::Read } else { [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete }
  $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
  $retained = $false
  try {
    Require-True ($stream.Length -gt 0 -and $stream.Length -le 65536)
    Assert-PrivateAcl $stream.GetAccessControl() $RunnerSid '' $false
    $bytes = New-Object byte[] ([int]$stream.Length)
    $position = 0
    while ($position -lt $bytes.Length) {
      $count = $stream.Read($bytes, $position, $bytes.Length - $position)
      Require-True ($count -gt 0)
      $position += $count
    }
    Require-True ($stream.Length -eq $bytes.Length)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xfeff) { $text = $text.Substring(1) }
    $value = ConvertFrom-Json -InputObject $text
    if ($HoldAgainstChanges) { $held.Add($stream); $retained = $true }
    return [pscustomobject]@{ Value = $value; Sha256 = $hash }
  } finally { if (-not $retained) { $stream.Dispose() } }
}
function Save-Reconciliation {
  Require-True ($null -ne $receiptStream -and $null -ne $reconciliation)
  $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes(($reconciliation | ConvertTo-Json -Depth 8) + "`n")
  $receiptStream.Position = 0
  $receiptStream.SetLength(0)
  $receiptStream.Write($bytes, 0, $bytes.Length)
  $receiptStream.Flush($true)
}

try {
  Require-True ($ApprovedSpecSha256 -ceq $expectedSpecHash)
  Require-True ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT -and [Environment]::Is64BitProcess)
  Require-True ($env:CI -ceq 'true' -and $env:GITHUB_ACTIONS -ceq 'true' -and $env:GITHUB_REPOSITORY -ceq 'NanmiCoder/cc-haha')
  Require-True ($env:RUNNER_TEMP -ceq 'D:\a\_temp' -and $env:GITHUB_WORKSPACE -ceq 'D:\a\cc-haha\cc-haha')
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try {
    $runnerSid = $identity.User.Value
    Require-True ([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
  } finally { $identity.Dispose() }
  $stage = 'fixed-spec-and-container-bindings'
  $pinsPath = Join-Path $PSScriptRoot 'pins.json'
  $specPath = Join-Path $PSScriptRoot 'controller-spec.proposed-admitted.json'
  Assert-OrdinaryPath $pinsPath $false
  Assert-OrdinaryPath $specPath $false
  Require-True ((Get-FileHash -LiteralPath $specPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $expectedSpecHash)
  $pins = Get-Content -Raw -LiteralPath $pinsPath -Encoding UTF8 | ConvertFrom-Json
  $spec = Get-Content -Raw -LiteralPath $specPath -Encoding UTF8 | ConvertFrom-Json
  $stageBase = 'D:\a\_temp\cc-haha-1879-b-e5aad0f-52f4ce19-g1'
  $controllerRoot = Join-Path $stageBase 'controller'
  Require-True ($pins.stageBase -ceq $stageBase -and $pins.specSha256 -ceq $expectedSpecHash)
  Require-True ($spec.version -eq 1 -and $spec.mode -ceq 'historical-v078-controller' -and
    $spec.executionStage -ceq 'B' -and $spec.realExecutionAdmitted -is [bool] -and $spec.realExecutionAdmitted)
  Require-True ($spec.runId -ceq '52f4ce19-5ded-4b27-8268-a2840809e0ca' -and
    $spec.owner -ceq 'codex:local:01a1c9a5-381e-7b33-9648-c8968b61de4c' -and $spec.generation -eq 1)
  Require-True ($spec.controllerRoot -ceq $controllerRoot -and $spec.sourceRoot -ceq (Join-Path $stageBase 'input') -and
    $spec.gitRoot -ceq $env:GITHUB_WORKSPACE -and $spec.output -ceq (Join-Path $controllerRoot 'controller-report.json'))
  Assert-OrdinaryPath $stageBase $true
  Assert-OrdinaryPath $controllerRoot $true
  Assert-PrivateAcl (Get-Acl -LiteralPath $stageBase) $runnerSid 'S-1-5-32-545' $true

  $stage = 'noninterfering-private-receipt-and-ledger-snapshots'
  $launchPath = Join-Path $stageBase 'launch-receipt.json'
  $ledgerPath = Join-Path $controllerRoot 'ledger.json'
  $launchSnapshot = Open-PrivateJson $launchPath $runnerSid $false
  $ledgerSnapshot = Open-PrivateJson $ledgerPath $runnerSid $false
  $launch = $launchSnapshot.Value
  $ledger = $ledgerSnapshot.Value
  Require-True ($launch.specSha256 -ceq $expectedSpecHash -and $launch.binarySha256 -ceq $pins.binarySha256 -and
    $launch.stageBase -ceq $stageBase -and $launch.runnerSid -ceq $runnerSid)
  foreach ($name in @('runId', 'owner', 'generation')) { Require-True ($launch.$name -ceq $spec.$name -and $ledger.$name -ceq $spec.$name) }
  Require-True ($ledger.version -eq 1 -and $ledger.specSha256 -ceq $expectedSpecHash -and
    $ledger.accountCreated -is [bool] -and $ledger.accountCreated -and
    $ledger.accountBound -is [bool] -and $ledger.accountBound -and $null -ne $ledger.account)
  Require-True ($launch.controllerStartAttempted -is [bool] -and $launch.controllerStartAttempted -and
    $launch.controllerStarted -is [bool] -and $launch.controllerStarted -and
    @('starting', 'timeout_unknown_requires_reconciliation', 'failed_requires_reconciliation') -ccontains $launch.status)
  Require-True ((Is-Integer $launch.controllerPid) -and $launch.controllerPid -gt 4 -and $launch.controllerPid -le [int]::MaxValue)
  $controllerPid = [int]$launch.controllerPid
  # ConvertFrom-Json can materialize an ISO timestamp as DateTime already.
  # Never stringify that value using the process's current culture.
  if ($launch.controllerBirthUtc -is [DateTime]) { $birth = $launch.controllerBirthUtc }
  elseif ($launch.controllerBirthUtc -is [string]) {
    $birth = [DateTime]::ParseExact($launch.controllerBirthUtc, 'o', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
  } else { throw 'Reviewed Controller birth type is invalid' }
  Require-True ($birth.Kind -eq [DateTimeKind]::Utc -and $birth -le [DateTime]::UtcNow)
  $birthFileTime = [uint64]$birth.ToFileTimeUtc()
  $marker = [string]$ledger.marker
  $match = [Text.RegularExpressions.Regex]::Match($marker, '\ACcHaha1879:52f4ce19-5ded-4b27-8268-a2840809e0ca:([0-9a-f]{32})\z', [Text.RegularExpressions.RegexOptions]::CultureInvariant)
  Require-True ($match.Success)
  $sam = 'c1879_' + $match.Groups[1].Value.Substring(0, 12)
  $accountSid = [string]$ledger.account.sid
  Require-True ($ledger.intentSam -ceq $sam -and $ledger.account.sam -ceq $sam -and $ledger.account.marker -ceq $marker)
  Require-True ([Text.RegularExpressions.Regex]::IsMatch($accountSid, '\AS-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+\z'))
  Require-True ([Security.Principal.SecurityIdentifier]::new($accountSid).Value -ceq $accountSid -and $accountSid -cne $runnerSid)
  Assert-PrivateAcl (Get-Acl -LiteralPath $controllerRoot) $runnerSid $accountSid $true

  $stage = 'private-compiler-scratch'
  $scratch = Join-Path $stageBase 'runtime\temp'
  Assert-OrdinaryPath $scratch $true
  Assert-PrivateAcl (Get-Acl -LiteralPath $scratch) $runnerSid '' $false
  foreach ($name in @('TEMP', 'TMP', 'TMPDIR')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $scratch, 'Process')
  }
  Require-True ($null -eq ('CcHaha1879EmergencyDisable.Native' -as [type]))
  $stage = 'explicit-only-native-adapter-compilation'
  $nativeSource = @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace CcHaha1879EmergencyDisable
{
  public sealed class Failure : Exception
  {
    public readonly string Operation;
    public readonly uint Code;
    public readonly uint Parameter;
    public Failure(string operation, uint code, uint parameter) : base("Bounded native reconciliation failed")
    { Operation = operation; Code = code; Parameter = parameter; }
  }
  public sealed class Observation
  {
    public uint FlagsBefore;
    public uint FlagsAfter;
    public bool SetCalled;
  }
  public static class Native
  {
    [StructLayout(LayoutKind.Sequential)]
    private struct User23 { public IntPtr name, fullName, comment; public uint flags; public IntPtr sid; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Flags1008 { public uint flags; }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime { public uint low, high; }
    private sealed class Account { internal string sam, sid, marker; internal uint flags; }
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern uint NetUserGetInfo(string server, string user, uint level, out IntPtr buffer);
    [DllImport("netapi32.dll", CharSet = CharSet.Unicode)]
    private static extern uint NetUserSetInfo(string server, string user, uint level, ref Flags1008 flags, out uint parameter);
    [DllImport("netapi32.dll")] private static extern uint NetApiBufferFree(IntPtr buffer);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(IntPtr process, out FileTime birth, out FileTime exit, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr process, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);

    public static string RequireControllerGone(int pid, ulong expectedBirth)
    {
      if (pid <= 4 || expectedBirth == 0) throw new InvalidOperationException("Controller identity is missing");
      IntPtr process = OpenProcess(0x00101000, false, checked((uint)pid));
      int openError = Marshal.GetLastWin32Error();
      if (process == IntPtr.Zero)
      {
        if (openError == 87)
        {
          // Do not equate a bare OpenProcess error with termination. Confirm
          // this single PID is absent using the managed not-running contract.
          System.Diagnostics.Process candidate;
          try { candidate = System.Diagnostics.Process.GetProcessById(pid); }
          catch (ArgumentException) { return "gone_no_pid_confirmed"; }
          candidate.Dispose();
          throw new InvalidOperationException("Controller absence is not confirmed");
        }
        throw new Failure("OpenProcess", unchecked((uint)openError), 0);
      }
      try
      {
        FileTime birth, exit, kernel, user;
        bool read = GetProcessTimes(process, out birth, out exit, out kernel, out user);
        int readError = Marshal.GetLastWin32Error();
        if (!read) throw new Failure("GetProcessTimes", unchecked((uint)readError), 0);
        ulong actualBirth = ((ulong)birth.high << 32) | birth.low;
        if (actualBirth != expectedBirth) throw new InvalidOperationException("Controller PID was reused or identity is unknown");
        uint wait = WaitForSingleObject(process, 0);
        int waitError = Marshal.GetLastWin32Error();
        if (wait == 258) throw new InvalidOperationException("Original Controller is still alive");
        if (wait == 0xffffffff) throw new Failure("WaitForSingleObject", unchecked((uint)waitError), 0);
        if (wait != 0) throw new InvalidOperationException("Controller termination status is unknown");
        return "gone_same_birth_signaled";
      }
      finally
      {
        bool closed = CloseHandle(process);
        int closeError = Marshal.GetLastWin32Error();
        if (!closed) throw new Failure("CloseHandle", unchecked((uint)closeError), 0);
      }
    }

    private static Account ReadBound(string sam, string sid, string marker)
    {
      if (IntPtr.Size != 8 || Marshal.SizeOf(typeof(User23)) != 40 || Marshal.SizeOf(typeof(Flags1008)) != 4)
        throw new InvalidOperationException("Unexpected account API layout");
      IntPtr buffer;
      uint status = NetUserGetInfo(null, sam, 23, out buffer);
      if (status != 0) throw new Failure("NetUserGetInfo", status, 0);
      if (buffer == IntPtr.Zero) throw new InvalidOperationException("Account API returned no data");
      try
      {
        User23 value = (User23)Marshal.PtrToStructure(buffer, typeof(User23));
        if (value.sid == IntPtr.Zero) throw new InvalidOperationException("Account API returned no SID");
        Account account = new Account {
          sam = Marshal.PtrToStringUni(value.name), marker = Marshal.PtrToStringUni(value.comment),
          sid = new SecurityIdentifier(value.sid).Value, flags = value.flags
        };
        if (!String.Equals(account.sam, sam, StringComparison.Ordinal) || !String.Equals(account.sid, sid, StringComparison.Ordinal) ||
          !String.Equals(account.marker, marker, StringComparison.Ordinal) || (account.flags & 0x0200) == 0)
          throw new InvalidOperationException("Full owned account binding did not match");
        return account;
      }
      finally
      {
        uint freed = NetApiBufferFree(buffer);
        if (freed != 0) throw new Failure("NetApiBufferFree", freed, 0);
      }
    }

    public static Observation DisableBound(string sam, string sid, string marker, int controllerPid, ulong controllerBirth)
    {
      RequireControllerGone(controllerPid, controllerBirth);
      Account before = ReadBound(sam, sid, marker);
      uint desired = before.flags | 0x0002;
      bool changed = (before.flags & 0x0002) == 0;
      if (changed)
      {
        RequireControllerGone(controllerPid, controllerBirth);
        Flags1008 flags = new Flags1008 { flags = desired };
        uint parameter;
        uint status = NetUserSetInfo(null, sam, 1008, ref flags, out parameter);
        if (status != 0) throw new Failure("NetUserSetInfo", status, parameter);
      }
      Account after = ReadBound(sam, sid, marker);
      if (after.flags != desired || (after.flags & 0x0002) == 0)
        throw new InvalidOperationException("Disabled flag or preserved account flags did not match");
      return new Observation { FlagsBefore = before.flags, FlagsAfter = after.flags, SetCalled = changed };
    }
  }
}
'@
  Add-Type -TypeDefinition $nativeSource -Language CSharp -ReferencedAssemblies @('System.dll') -ErrorAction Stop
  $stage = 'original-controller-must-have-terminated'
  $controllerState = [CcHaha1879EmergencyDisable.Native]::RequireControllerGone($controllerPid, $birthFileTime)
  $stage = 'stopped-controller-strict-snapshot-rebinding'
  $launchHeld = Open-PrivateJson $launchPath $runnerSid $true
  $ledgerHeld = Open-PrivateJson $ledgerPath $runnerSid $true
  Require-True ($launchHeld.Sha256 -ceq $launchSnapshot.Sha256 -and $ledgerHeld.Sha256 -ceq $ledgerSnapshot.Sha256)
  Assert-PrivateAcl (Get-Acl -LiteralPath $controllerRoot) $runnerSid $accountSid $true
  $controllerState = [CcHaha1879EmergencyDisable.Native]::RequireControllerGone($controllerPid, $birthFileTime)
  $stage = 'one-shot-private-reconciliation-receipt'
  $reconciliationPath = Join-Path $stageBase 'reconcile-receipt.json'
  # No overwrite/retry, even if a prior attempt stopped before the account API.
  # This new file and every strict lock occur only after Controller-gone proof.
  $receiptStream = [IO.FileStream]::new($reconciliationPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
  Assert-PrivateAcl $receiptStream.GetAccessControl() $runnerSid '' $false
  $reconciliation = [ordered]@{
    version = 1; status = 'disable_not_attempted'; cleanup = 'failed'; admissionMustExistExternally = $true
    runId = $spec.runId; owner = $spec.owner; generation = $spec.generation; specSha256 = $expectedSpecHash
    runnerSid = $runnerSid; accountSidSha256 = (Hash-Text $accountSid); markerSha256 = (Hash-Text $marker)
    controllerPid = $controllerPid; controllerBirthUtc = $birth.ToString('o', [Globalization.CultureInfo]::InvariantCulture); controllerState = $controllerState
    accountQueryAttempted = $false; disableMayHaveOccurred = $false; disabledVerified = $false; flagsBefore = $null; flagsAfter = $null
    originalProfileLease = 'not_available'; profileAndHiveState = 'unknown_not_mutated'; ownedJobs = 'unknown_not_mutated'
    retryAllowed = $false; failedStage = $null; diagnostic = $null
  }
  Save-Reconciliation
  $stage = 'bound-account-disable-only'
  $reconciliation.accountQueryAttempted = $true
  # Conservative durable intent: any later failure may have followed SetInfo.
  $reconciliation.disableMayHaveOccurred = $true
  $reconciliation.status = 'disable_attempt_in_progress_remaining_unknown'
  Save-Reconciliation
  $observed = [CcHaha1879EmergencyDisable.Native]::DisableBound($sam, $accountSid, $marker, $controllerPid, $birthFileTime)
  $reconciliation.disabledVerified = $true
  $reconciliation.disableMayHaveOccurred = [bool]$observed.SetCalled
  $reconciliation.flagsBefore = [uint32]$observed.FlagsBefore
  $reconciliation.flagsAfter = [uint32]$observed.FlagsAfter
  $reconciliation.status = 'disabled_remaining_unknown'
  # A disabled account is not paired UnloadUserProfile/cleaned evidence.
  Save-Reconciliation
  $reconciliation | ConvertTo-Json -Depth 8
} catch {
  $diagnostic = 'precondition_or_managed_operation_failed'
  $errorObject = $_.Exception
  for ($depth = 0; $null -ne $errorObject -and $depth -lt 6; $depth++) {
    if ($errorObject.GetType().FullName -ceq 'CcHaha1879EmergencyDisable.Failure') {
      $diagnostic = 'native_operation=' + $errorObject.Operation + ';code=' + $errorObject.Code + ';parameter=' + $errorObject.Parameter
      break
    }
    $errorObject = $errorObject.InnerException
  }
  if ($null -ne $reconciliation) {
    $reconciliation.status = 'stopped_unknown_requires_reconciliation'
    $reconciliation.failedStage = $stage
    $reconciliation.diagnostic = $diagnostic
    try { Save-Reconciliation } catch { }
    $reconciliation | ConvertTo-Json -Depth 8
  } else {
    [ordered]@{ status = 'stopped_unknown_requires_reconciliation'; failedStage = $stage; diagnostic = $diagnostic; cleanup = 'failed'; accountApi = 'not_run'; retryAllowed = $false } | ConvertTo-Json
  }
} finally {
  if ($null -ne $receiptStream) { $receiptStream.Dispose() }
  foreach ($stream in $held) { $stream.Dispose() }
  foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
}
# The emergency path never turns a failed/cancelled run green, even after a
# verified disable. Account/profile/hive/Job reclamation remains unproved.
exit 1
