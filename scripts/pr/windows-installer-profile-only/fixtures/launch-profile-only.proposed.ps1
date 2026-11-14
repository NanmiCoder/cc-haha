# SOURCE-ONLY DRAFT. No profile-only/live admission is provided here.
# Default reads only package JSON and emits NOT_READY/not_run; no Add-Type/API.
[CmdletBinding()]
param(
  [switch]$ExecuteReviewedProfileOnly,
  [string]$ApprovedPinsSha256,
  [string]$ApprovedSpecSha256,
  [string]$ApprovedAdmissionSha256,
  [string]$ClaimFile,
  [string]$StageAInputDirectory
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$pinsPath=Join-Path $PSScriptRoot 'pins.proposed.json'
$specPath=Join-Path $PSScriptRoot 'profile-only-spec.proposed.json'
$admissionPath=Join-Path $PSScriptRoot 'root-admission.proposed.json'
$pins=Get-Content -Raw -LiteralPath $pinsPath -Encoding UTF8|ConvertFrom-Json
$spec=Get-Content -Raw -LiteralPath $specPath -Encoding UTF8|ConvertFrom-Json
$admission=Get-Content -Raw -LiteralPath $admissionPath -Encoding UTF8|ConvertFrom-Json
if(-not $ExecuteReviewedProfileOnly){
  [ordered]@{version=1;status='not_run';readiness='NOT_READY';admission=$admission.status;packetStatus=$pins.status;role='profile-only';accountApi='not_run';nativeExecution='not_run';cleanup='not_run';compatibilityEnabled=$false;oldExit22Policy='fatal';retryAllowed=$false}|ConvertTo-Json
  return
}


function Require-True([bool]$Value, [string]$Code) { if (-not $Value) { throw $Code } }
function Is-Sha([object]$Value) { return $Value -is [string] -and [Text.RegularExpressions.Regex]::IsMatch($Value, '\A[0-9a-f]{64}\z') }
function Is-Head([object]$Value) { return $Value -is [string] -and [Text.RegularExpressions.Regex]::IsMatch($Value, '\A[0-9a-f]{40}\z') }
function Hash-Bytes([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function Hash-Text([string]$Text) { return Hash-Bytes ([Text.Encoding]::UTF8.GetBytes($Text)) }
function Same-Path([string]$Left, [string]$Right) {
  return [string]::Equals($Left.TrimEnd('\'), $Right.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
}
function Inside-Path([string]$Parent, [string]$Child) { return $Child.StartsWith($Parent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) }
function Assert-LocalPath([string]$Path) {
  Require-True ($Path -and $Path.Length -lt 800 -and $Path -cmatch '\A[A-Za-z]:[\\/]' -and $Path -notmatch '[\x00\r\n"]' -and $Path.IndexOf(':', 2) -lt 0) 'invalid_local_path'
  foreach ($part in $Path.Split([char[]]@('\','/'))) { Require-True ($part -cne '.' -and $part -cne '..') 'path_dot_component' }
  Require-True (-not $Path.EndsWith(' ')) 'path_tail_space'
}
function Assert-OrdinaryPath([string]$Path, [bool]$Directory) {
  Assert-LocalPath $Path
  $item = Get-Item -LiteralPath $Path -Force
  Require-True ($item.PSIsContainer -eq $Directory -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'ordinary_path_required'
  $parent = if ($Directory) { $item.Parent } else { $item.Directory }
  while ($null -ne $parent) {
    Require-True (($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'reparse_ancestor'
    $parent = $parent.Parent
  }
}
function Read-PacketJson([string]$Path, [long]$Maximum = 65536) {
  $item = Get-Item -LiteralPath $Path -Force
  Require-True (-not $item.PSIsContainer -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and $item.Length -gt 0 -and $item.Length -le $Maximum -and $Maximum -le 1048576) 'bounded_packet_json_required'
  return Get-Content -Raw -LiteralPath $Path -Encoding UTF8 | ConvertFrom-Json
}
function File-Hash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Assert-PrivateAcl($Acl, [string]$RunnerSid, [bool]$Root, [bool]$AdministratorsAllowed, [bool]$ReadOnlyFile) {
  $owner = $Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($Root) { Require-True ($Acl.AreAccessRulesProtected -and $owner -ceq $RunnerSid) 'root_acl_owner_or_inheritance' }
  else { Require-True (@($RunnerSid,'S-1-5-18','S-1-5-32-544') -ccontains $owner) 'file_acl_owner' }
  $runner = $false; $system = $false
  foreach ($rule in $Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    $sid = $rule.IdentityReference.Value
    Require-True ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) 'unexpected_acl_deny'
    Require-True ($sid -ceq $RunnerSid -or $sid -ceq 'S-1-5-18' -or ($AdministratorsAllowed -and $sid -ceq 'S-1-5-32-544')) 'unexpected_acl_identity'
    # Allow ACE normalization includes SYNCHRONIZE. Require exactly this readonly mask; never strip unknown rights.
    $readonlyMask = [long]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
    $expected = if ($ReadOnlyFile) { $readonlyMask } else { [long][Security.AccessControl.FileSystemRights]::FullControl }
    Require-True ([long]$rule.FileSystemRights -eq $expected) 'unexpected_acl_rights'
    if ($sid -ceq $RunnerSid) { $runner = $true }; if ($sid -ceq 'S-1-5-18') { $system = $true }
  }
  Require-True ($runner -and $system) 'private_acl_required_principals'
}
function Lock-HashedFile([string]$Path, [string]$Hash, [long]$Bytes = -1) {
  Assert-OrdinaryPath $Path $false
  Require-True (Is-Sha $Hash) 'missing_file_pin'
  $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($Bytes -ge 0) { Require-True ($stream.Length -eq $Bytes) 'file_size_changed' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
    Require-True ($actual -ceq $Hash) 'file_hash_changed'
    $script:held.Add($stream); $stream = $null
  } finally { if ($null -ne $stream) { $stream.Dispose() } }
}
function Assert-FrozenPacket([string]$PinsHash, [string]$SpecHash, [string]$AdmissionHash, [string]$SelfHash, [bool]$Reconcile) {
  # This is the first explicit-execution gate. It only reads packet text/hashes.
  # Pending refuses before WindowsIdentity, Add-Type, process or account APIs,
  # environment changes, receipt creation or any other file write.
  Require-True ($pins.version -eq 1 -and $pins.packetKind -ceq 'profile-only' -and $pins.status -ceq 'FROZEN_PROFILE_ONLY_INPUTS' -and $pins.admissionStatus -ceq 'external_root_grant_required') 'packet_pending_not_admitted'
  Require-True ((Is-Sha $PinsHash) -and (Is-Sha $SpecHash) -and (Is-Sha $AdmissionHash)) 'exact_external_approval_hashes_required'
  Require-True ((File-Hash $pinsPath) -ceq $PinsHash -and (File-Hash $specPath) -ceq $SpecHash -and (File-Hash $admissionPath) -ceq $AdmissionHash) 'approved_packet_hash_changed'
  Require-True ($pins.specSha256 -ceq $SpecHash -and (Is-Head $pins.activationHead)) 'spec_or_new_activation_head_pending'
  Require-True ($admission.status -ceq 'admitted_profile_only_once' -and $admission.role -ceq 'profile-only' -and $admission.runAuthorization -ceq 'first_exact_head_once_no_rerun') 'specific_root_admission_missing'
  Require-True ($admission.pinsSha256 -ceq $PinsHash -and $admission.specSha256 -ceq $SpecHash -and $admission.activationHead -ceq $pins.activationHead -and $admission.newTriggerLabel -ceq ('p1879p-' + $pins.activationHead)) 'root_admission_binding'
  Require-True ($pins.launcherSha256 -ceq $admission.launcherSha256 -and $pins.reconcileSha256 -ceq $admission.reconcileSha256 -and (Is-Sha $pins.launcherSha256) -and (Is-Sha $pins.reconcileSha256)) 'script_pins_pending'
  $expectedSelf = if ($Reconcile) { [string]$pins.reconcileSha256 } else { [string]$pins.launcherSha256 }
  Require-True ($SelfHash -ceq $expectedSelf) 'script_source_changed'
  Require-True ($pins.controllerTimeoutMilliseconds -gt 0 -and $pins.controllerTimeoutMilliseconds -le 300000) 'invalid_controller_timeout'
  Require-True ($admission.maximumControllerStarts -eq 1 -and $admission.maximumCreateProfileCalls -eq 1 -and $admission.maximumFreshOwnedSids -eq 1) 'one_attempt_scope_changed'
  foreach ($value in @($pins,$spec,$admission)) {
    Require-True ($value.runId -ceq '52f4ce19-5ded-4b27-8268-a2840809e0ca' -and $value.owner -ceq 'codex:local:01a1c9a5-381e-7b33-9648-c8968b61de4c' -and $value.generation -eq 1) 'owner_generation_changed'
  }
  Require-True ($spec.version -eq 1 -and $spec.mode -ceq 'createprofile-only-controller' -and $spec.executionStage -ceq 'profile-only' -and $spec.realExecutionAdmitted -is [bool] -and $spec.realExecutionAdmitted) 'profile_only_role_not_admitted'
  Require-True ($null -eq $spec.setupPath -and $spec.frozenPlanManifestSha256 -ceq '60e087a037ab8cd6ff9115615f9426b01f261236ccaa267c955677eeb4d6e672' -and $spec.argvEnvPlanSha256 -ceq 'd2e740b8d48b87b3e34a53cec9f9400bd08797b17538ab8cb1f0cc548736451a') 'profile_only_scope_changed'
  Require-True ($pins.binarySha256 -ceq '9c03e5b01b25503cbae216854d70991a7f781020ef8262c356dc75eea0acb782' -and $pins.binaryBytes -eq 283136 -and $spec.expectedBinarySha256 -ceq $pins.binarySha256) 'original_new_stage_a_pe_changed'
  Require-True ($pins.stageA.status -ceq 'passed' -and $pins.candidateSourceCommit -ceq 'fd452cd919d1f2c79eecc3e4b7697862b3ed5a8c' -and $pins.stageA.head -ceq $pins.candidateSourceCommit -and $pins.stageA.runId -eq 43492838022 -and $pins.stageA.artifactId -eq 14070542178) 'new_stage_a_binding_changed'
  Require-True ($pins.sourcePins.Count -eq 3 -and $spec.sourcePins.Count -eq 3) 'exact_raw_sources_required'
  $expectedNames = @('windows-installer-profile-fixture.cs','windows-installer-profile-native.cs','windows-installer-profile-fixture-tests.cs')
  foreach ($name in $expectedNames) {
    $pin = @($pins.sourcePins | Where-Object { $_.file -ceq $name }); $sp = @($spec.sourcePins | Where-Object { $_.file -ceq $name })
    Require-True ($pin.Count -eq 1 -and $sp.Count -eq 1 -and (Is-Sha $pin[0].sha256) -and $sp[0].sha256 -ceq $pin[0].sha256 -and $pin[0].bytes -gt 0) 'raw_source_pin_changed'
  }
  Require-True ((File-Hash (Join-Path $PSScriptRoot 'argv-env-plan.json')) -ceq $spec.argvEnvPlanSha256) 'env_contract_changed'
  Assert-LocalPath $pins.stageBase; Assert-LocalPath $pins.privateBootstrapRoot; Assert-LocalPath $pins.stageAInputDirectory
  Require-True ($pins.stageBase -ceq $admission.stageBase -and $pins.privateBootstrapRoot -ceq $admission.privateBootstrapRoot) 'specific_paths_pending'
  Require-True ((Inside-Path $pins.runnerTemp $pins.stageBase) -and (Inside-Path $pins.runnerTemp $pins.privateBootstrapRoot) -and -not (Same-Path $pins.stageBase $pins.privateBootstrapRoot) -and -not (Inside-Path $pins.stageBase $pins.privateBootstrapRoot) -and -not (Inside-Path $pins.privateBootstrapRoot $pins.stageBase)) 'private_bootstrap_or_stage_boundary'
  Require-True ($spec.gitRoot -ceq $pins.workspace -and $spec.sourceRoot -ceq (Join-Path $pins.stageBase 'input') -and $spec.controllerRoot -ceq (Join-Path $pins.stageBase 'controller') -and $spec.output -ceq (Join-Path $spec.controllerRoot 'profile-only-report.json')) 'sibling_input_controller_layout'
  Require-True (-not (Inside-Path $spec.gitRoot $pins.stageBase) -and -not (Same-Path $spec.gitRoot $pins.stageBase) -and -not (Inside-Path $spec.gitRoot $pins.privateBootstrapRoot)) 'git_boundary'
  Require-True ((Is-Sha $pins.workflow.sha256) -and (Is-Sha $pins.workflow.claimantSourceSha256) -and $admission.claimantSourceSha256 -ceq $pins.workflow.claimantSourceSha256 -and $pins.workflow.workflowId -eq 269753168 -and $pins.workflow.path -ceq '.github/workflows/pr-quality.yml' -and $admission.allowedWorkflowId -eq $pins.workflow.workflowId -and $null -eq $admission.allowedRunId) 'future_workflow_claimant_not_frozen'
  foreach ($binding in @(@($pins.workflow.path,$pins.workflow.sha256),@('scripts/pr/windows-installer-profile-review.ts',$pins.workflow.claimantSourceSha256))) {
    $path=Join-Path $pins.workspace $binding[0]; Assert-OrdinaryPath $path $false
    Require-True ((Hash-Text ([IO.File]::ReadAllText($path).Replace("`r`n","`n"))) -ceq $binding[1]) 'activation_workflow_or_claimant_source_changed'
  }
}
function Assert-ActionsContext([string]$ClaimFile, [string]$RunnerSid) {
  Require-True ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT -and [Environment]::Is64BitProcess) 'windows_x64_required'
  Require-True ($env:CI -ceq 'true' -and $env:GITHUB_ACTIONS -ceq 'true' -and $env:GITHUB_REPOSITORY -ceq 'NanmiCoder/cc-haha' -and $env:GITHUB_RUN_ATTEMPT -ceq '1' -and $env:GITHUB_ACTOR -ceq 'NanmiCoder') 'original_actions_first_attempt_required'
  Require-True ($env:RUNNER_TEMP -ceq 'D:\a\_temp' -and $env:GITHUB_WORKSPACE -ceq 'D:\a\cc-haha\cc-haha' -and $pins.runnerTemp -ceq $env:RUNNER_TEMP -and $pins.workspace -ceq $env:GITHUB_WORKSPACE) 'reviewed_runner_paths_changed'
  Assert-OrdinaryPath $env:GITHUB_EVENT_PATH $false
  $event = Read-PacketJson $env:GITHUB_EVENT_PATH 1048576
  Require-True ($event.action -ceq 'labeled' -and $event.sender.login -ceq 'NanmiCoder' -and $event.number -eq 1883 -and $event.pull_request.head.sha -ceq $pins.activationHead -and $event.label.name -ceq ('p1879p-' + $pins.activationHead) -and $event.pull_request.head.repo.full_name -ceq 'toBerlinWay/cc-haha' -and $event.pull_request.head.ref -ceq 'fix/installer-fallback-foreign-helpers' -and $event.pull_request.base.ref -ceq 'main') 'new_profile_only_activation_changed'
  Assert-OrdinaryPath $ClaimFile $false
  Require-True ((Inside-Path $pins.privateBootstrapRoot $ClaimFile)) 'claim_not_in_trusted_bootstrap'
  Assert-PrivateAcl (Get-Acl -LiteralPath $ClaimFile) $RunnerSid $false $true $false
  $claim = Read-PacketJson $ClaimFile
  Require-True ($claim.version -eq 1 -and $claim.status -ceq 'first_matching_run_claimed' -and $claim.repository -ceq $pins.repository -and $claim.head -ceq $pins.activationHead -and $claim.runId.ToString() -ceq $env:GITHUB_RUN_ID -and $claim.runAttempt -eq 1 -and $claim.workflowId -eq $pins.workflow.workflowId -and $claim.displayTitle -ceq ('profile1879-p:' + $pins.activationHead) -and $claim.runNumber.ToString() -ceq $env:GITHUB_RUN_NUMBER -and $claim.minimumMatchingRunNumber -eq $claim.runNumber -and $claim.minimumMatchingRunId.ToString() -ceq $env:GITHUB_RUN_ID -and $claim.completePagination -is [bool] -and $claim.completePagination -and $claim.claimantSourceSha256 -ceq $pins.workflow.claimantSourceSha256) 'first_run_claim_missing_or_unbound'
  return [pscustomobject]@{ Value = $claim; Sha256 = (File-Hash $ClaimFile) }
}
function Get-SafeFailure([Management.Automation.ErrorRecord]$Record) {
  $errorObject=$Record.Exception; $inner=$errorObject.InnerException
  $type=$errorObject.GetType().FullName
  $innerType=if($null -eq $inner){$null}else{$inner.GetType().FullName}
  if($type.Length -gt 160 -or $type -cnotmatch '\A[A-Za-z0-9_.+`]+\z'){$type='unavailable'}
  if($null -ne $innerType -and ($innerType.Length -gt 160 -or $innerType -cnotmatch '\A[A-Za-z0-9_.+`]+\z')){$innerType='unavailable'}
  $line=$null
  if($null -ne $Record.InvocationInfo){$candidate=[int]$Record.InvocationInfo.ScriptLineNumber;if($candidate -gt 0 -and $candidate -le 10000){$line=$candidate}}
  # Never emit Message, ScriptStackTrace, paths, invocation text or environment.
  return [ordered]@{type=$type;innerType=$innerType;hResult=[int]$errorObject.HResult;innerHResult=$(if($null -eq $inner){$null}else{[int]$inner.HResult});sourceLine=$line}
}
function Save-AtomicJson([string]$Path, $Value) {
  $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  $bytes = [Text.UTF8Encoding]::new($false, $true).GetBytes(($Value | ConvertTo-Json -Depth 12) + "`n")
  $stream = [IO.FileStream]::new($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary,$Path,[System.Management.Automation.Language.NullString]::Value) } else { [IO.File]::Move($temporary,$Path) }
}

$held = [Collections.Generic.List[IDisposable]]::new()
$savedScratch = @{}
$receipt = $null; $process = $null; $stdout = $null; $stderr = $null
$stage = 'frozen-packet'
try {
  Assert-FrozenPacket $ApprovedPinsSha256 $ApprovedSpecSha256 $ApprovedAdmissionSha256 (File-Hash $PSCommandPath) $false
  # No Windows identity, compilation, environment change or write precedes the
  # pending gate above. A reviewed source template is not an execution grant.
  Require-True ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT -and [Environment]::Is64BitProcess -and $PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -eq 1 -and $PSVersionTable.PSEdition -ceq 'Desktop') 'windows_x64_powershell51_required'
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try {
    $runnerSid = $identity.User.Value
    Require-True ([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'existing_administrative_context_required'
  } finally { $identity.Dispose() }
  Assert-OrdinaryPath $pins.privateBootstrapRoot $true
  Assert-PrivateAcl (Get-Acl -LiteralPath $pins.privateBootstrapRoot) $runnerSid $true $true $false
  $claim = Assert-ActionsContext $ClaimFile $runnerSid
  foreach ($path in @($pinsPath,$specPath,$admissionPath,$PSCommandPath,(Join-Path $PSScriptRoot 'reconcile-profile-only.proposed.ps1'),(Join-Path $PSScriptRoot 'argv-env-plan.json'))) {
    Assert-OrdinaryPath $path $false
  }
  Lock-HashedFile $pinsPath $ApprovedPinsSha256
  Lock-HashedFile $specPath $ApprovedSpecSha256
  Lock-HashedFile $admissionPath $ApprovedAdmissionSha256
  Lock-HashedFile $PSCommandPath $pins.launcherSha256
  Lock-HashedFile (Join-Path $PSScriptRoot 'reconcile-profile-only.proposed.ps1') $pins.reconcileSha256
  Lock-HashedFile $ClaimFile $claim.Sha256
  Require-True ($StageAInputDirectory -ceq $pins.stageAInputDirectory) 'exact_new_artifact_directory_required'
  Assert-OrdinaryPath $StageAInputDirectory $true
  Assert-PrivateAcl (Get-Acl -LiteralPath $StageAInputDirectory) $runnerSid $true $true $false
  Lock-HashedFile (Join-Path $StageAInputDirectory 'profile-fixture.exe') $pins.binarySha256 $pins.binaryBytes
  foreach ($pin in $pins.sourcePins) { Lock-HashedFile (Join-Path $StageAInputDirectory $pin.file) $pin.sha256 $pin.bytes }
  foreach ($proof in @(@('checks.json',$pins.stageA.checksSha256),@('self-test.raw.json',$pins.stageA.selfTestSha256),@('abi-harness.raw.json',$pins.stageA.abiHarnessSha256))) {
    Lock-HashedFile (Join-Path $StageAInputDirectory $proof[0]) $proof[1]
  }
  $a = Read-PacketJson (Join-Path $StageAInputDirectory 'checks.json')
  Require-True ($a.version -eq 1 -and $a.stage -ceq 'A' -and $a.status -ceq 'passed' -and $a.platform -ceq 'win32' -and $a.executableSha256 -ceq $pins.binarySha256 -and $a.sourceSetSha256 -ceq $pins.stageA.sourceSetSha256 -and $a.compilerSha256 -ceq $pins.stageA.compilerSha256) 'new_stage_a_provenance_changed'
  foreach ($pin in $pins.sourcePins) {
    $source=@($a.sources|Where-Object { $_.path -ceq ('scripts/pr/' + $pin.file) })
    Require-True ($source.Count -eq 1 -and $source[0].sha256 -ceq $pin.sha256 -and $source[0].bytes -eq $pin.bytes -and $source[0].canonicalSha256 -ceq $pin.canonicalSha256) 'actual_a_raw_source_binding_changed'
  }
  foreach ($name in @('compile','self-test','abi-harness')) {
    $command = @($a.commands | Where-Object { $_.name -ceq $name })
    Require-True ($command.Count -eq 1 -and $command[0].exitCode -eq 0 -and $command[0].timedOut -is [bool] -and -not $command[0].timedOut) 'new_stage_a_command_failed'
  }
  foreach ($path in @('self-test.raw.json','abi-harness.raw.json')) {
    $proof = Read-PacketJson (Join-Path $StageAInputDirectory $path)
    Require-True ($proof.version -eq 1 -and $proof.status -ceq 'passed' -and $proof.binarySha256 -ceq $pins.binarySha256 -and $proof.checks.Count -gt 0 -and @($proof.checks | Where-Object { $_.status -cne 'passed' }).Count -eq 0 -and $proof.realAccountsCreated -eq 0 -and $proof.realProfilesCreated -eq 0 -and $proof.releasedPeExecuted -is [bool] -and -not $proof.releasedPeExecuted -and $proof.releasedPeMayHaveExecuted -is [bool] -and -not $proof.releasedPeMayHaveExecuted) 'stage_a_report_failed'
    if ($path -ceq 'abi-harness.raw.json') { Require-True ($proof.cleanup -ceq 'passed') 'stage_a_cleanup_failed' }
  }
  $stage = 'trusted-bootstrap-compiler-only'
  foreach ($name in @('TEMP','TMP','TMPDIR')) {
    $savedScratch[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
    [Environment]::SetEnvironmentVariable($name,[string]$pins.privateBootstrapRoot,'Process')
  }
  Require-True ($null -eq ('CcHaha1879ProfileOnlyLaunchV1.Native' -as [type])) 'launcher_type_already_loaded_no_reuse'
  # Embedded source is injected verbatim here by the source-only text builder.
  $nativeSource = @'
using System;
using System.IO;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
namespace CcHaha1879ProfileOnlyLaunchV1 {
  public sealed class Failure : Exception {
    public readonly string Operation; public readonly int Code;
    public Failure(string operation, int code) : base("Bounded launcher API failure") { Operation=operation; Code=code; }
  }
  public sealed class FileRecord { public string Path, Id; }
  public sealed class ProcessRecord { public int Pid; public string BirthUtc, BirthFileTime, Image, Sid; }
  public static class Native {
    [StructLayout(LayoutKind.Sequential)] private struct SecurityAttributes { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
    [StructLayout(LayoutKind.Sequential)] private struct Time { public uint low, high; }
    [StructLayout(LayoutKind.Sequential)] private struct FileInfo { public uint attributes; public Time creation, access, write; public uint volume, high, low, links, indexHigh, indexLow; }
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text,uint revision,out IntPtr descriptor,out uint bytes);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true,ExactSpelling=true)] private static extern bool CreateDirectoryW(string path,ref SecurityAttributes attributes);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern IntPtr CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandle(IntPtr file,out FileInfo info);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern uint GetFinalPathNameByHandleW(IntPtr file,StringBuilder path,uint chars,uint flags);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetProcessTimes(IntPtr process,out Time birth,out Time exit,out Time kernel,out Time user);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern bool QueryFullProcessImageNameW(IntPtr process,uint flags,StringBuilder path,ref uint chars);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] private static extern bool GetTokenInformation(IntPtr token,int infoClass,IntPtr data,int bytes,out int needed);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] private static extern uint GetWindowsDirectoryW(StringBuilder path,uint chars);
    private static void Win(bool ok,string operation) { if(!ok) throw new Failure(operation,Marshal.GetLastWin32Error()); }
    public static FileRecord Identity(string path,bool directory) {
      IntPtr file=CreateFileW(path,0x80,7,IntPtr.Zero,3,0x00200000u|(directory?0x02000000u:0),IntPtr.Zero);
      if(file==new IntPtr(-1)) throw new Failure("CreateFileW",Marshal.GetLastWin32Error());
      try {
        FileInfo info; Win(GetFileInformationByHandle(file,out info),"GetFileInformationByHandle");
        if((info.attributes&0x400)!=0 || ((info.attributes&0x10)!=0)!=directory) throw new InvalidOperationException("Unexpected ordinary file kind");
        StringBuilder actual=new StringBuilder(32768); uint length=GetFinalPathNameByHandleW(file,actual,(uint)actual.Capacity,0);
        Win(length>0 && length<actual.Capacity,"GetFinalPathNameByHandleW");
        string canonical=actual.ToString(); if(canonical.StartsWith(@"\\?\",StringComparison.Ordinal)) canonical=canonical.Substring(4);
        return new FileRecord { Path=canonical, Id=info.volume.ToString("x8",CultureInfo.InvariantCulture)+":"+info.indexHigh.ToString("x8",CultureInfo.InvariantCulture)+info.indexLow.ToString("x8",CultureInfo.InvariantCulture) };
      } finally { Win(CloseHandle(file),"Close file identity"); }
    }
    public static FileRecord CreateOwnedDirectory(string path,string runnerSid) {
      string sid=new SecurityIdentifier(runnerSid).Value;
      IntPtr descriptor; uint bytes;
      Win(ConvertStringSecurityDescriptorToSecurityDescriptorW("O:"+sid+"D:P(A;OICI;FA;;;"+sid+")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",1,out descriptor,out bytes),"Convert owned directory descriptor");
      try {
        SecurityAttributes sa=new SecurityAttributes { length=Marshal.SizeOf(typeof(SecurityAttributes)), descriptor=descriptor, inherit=false };
        Win(CreateDirectoryW(path,ref sa),"CreateDirectoryW CreateNew owned root"); // ERROR_ALREADY_EXISTS is always fatal.
        return Identity(path,true);
      } finally { if(descriptor!=IntPtr.Zero && LocalFree(descriptor)!=IntPtr.Zero) throw new InvalidOperationException("Descriptor release failed"); }
    }
    public static string WindowsDirectory() {
      StringBuilder path=new StringBuilder(32768); uint chars=GetWindowsDirectoryW(path,(uint)path.Capacity);
      Win(chars>0 && chars<path.Capacity && chars==path.Length,"GetWindowsDirectoryW"); return path.ToString();
    }
    public static ProcessRecord Capture(Process process) {
      IntPtr handle=process.Handle; uint pid=GetProcessId(handle); Win(pid>0,"GetProcessId");
      Time birth,exit,kernel,user; Win(GetProcessTimes(handle,out birth,out exit,out kernel,out user),"GetProcessTimes");
      ulong value=((ulong)birth.high<<32)|birth.low;
      StringBuilder image=new StringBuilder(32768); uint chars=(uint)image.Capacity;
      Win(QueryFullProcessImageNameW(handle,0,image,ref chars),"QueryFullProcessImageNameW");
      IntPtr token; Win(OpenProcessToken(handle,8,out token),"OpenProcessToken read-only launcher capture");
      string sid;
      try {
        int needed; bool ok=GetTokenInformation(token,1,IntPtr.Zero,0,out needed); int error=Marshal.GetLastWin32Error();
        if(ok || error!=122 || needed<=0 || needed>65536) throw new Failure("GetTokenInformation size",error);
        IntPtr data=Marshal.AllocHGlobal(needed);
        try { int filled; Win(GetTokenInformation(token,1,data,needed,out filled),"GetTokenInformation fill"); if(filled<=0 || filled>needed) throw new InvalidOperationException("Unbounded token fill"); sid=new SecurityIdentifier(Marshal.ReadIntPtr(data)).Value; }
        finally { Marshal.FreeHGlobal(data); }
      } finally { Win(CloseHandle(token),"Close captured token"); }
      return new ProcessRecord { Pid=checked((int)pid),BirthUtc=DateTime.FromFileTimeUtc(checked((long)value)).ToString("o",CultureInfo.InvariantCulture),BirthFileTime=value.ToString(CultureInfo.InvariantCulture),Image=image.ToString(),Sid=sid };
    }
  }
  public sealed class RawCapture {
    private readonly Thread worker;
    private readonly FileStream output;
    private readonly Stream input;
    private readonly long limit;
    private volatile bool completed, overflow;
    private string failure;
    public bool Completed { get { return completed; } }
    public bool Overflow { get { return overflow; } }
    public string Failure { get { return failure; } }
    public RawCapture(Stream source,string path,long maximum) {
      if(maximum<=0 || maximum>4194304) throw new InvalidOperationException("Invalid capture bound");
      input=source; limit=maximum; output=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.Read);
      worker=new Thread(Pump); worker.IsBackground=true;
      try { worker.Start(); } catch { output.Dispose(); throw; }
    }
    private void Pump() {
      try {
        byte[] block=new byte[4096]; long written=0; int count;
        while((count=input.Read(block,0,block.Length))>0) {
          int keep=(int)Math.Min((long)count,Math.Max(0,limit-written));
          if(keep>0) { output.Write(block,0,keep); written+=keep; output.Flush(true); }
          if(keep<count) overflow=true; // Continue draining; never kill a process to cap logs.
        }
      } catch(Exception error) { failure=error.GetType().Name; }
      finally { try { output.Dispose(); } finally { completed=true; } }
    }
    public bool Wait(int milliseconds) { if(milliseconds<0 || milliseconds>5000) throw new InvalidOperationException("Invalid capture wait"); return worker.Join(milliseconds); }
  }
}
'@
  Add-Type -TypeDefinition $nativeSource -Language CSharp -ReferencedAssemblies @('System.dll') -ErrorAction Stop
  $stage = 'atomic-new-owned-stage'
  Assert-OrdinaryPath ([IO.Path]::GetDirectoryName([string]$pins.stageBase)) $true
  Require-True (-not (Test-Path -LiteralPath $pins.stageBase)) 'stage_already_exists_no_reuse'
  $stageIdentity = [CcHaha1879ProfileOnlyLaunchV1.Native]::CreateOwnedDirectory($pins.stageBase,$runnerSid)
  Require-True (Same-Path $stageIdentity.Path $pins.stageBase) 'stage_canonical_identity_changed'
  Assert-PrivateAcl (Get-Acl -LiteralPath $pins.stageBase) $runnerSid $true $true $false
  $inputRoot = Join-Path $pins.stageBase 'input'
  $runtime = Join-Path $pins.stageBase 'runtime'
  $profileOnlyHome = Join-Path $runtime 'home'; $temp = Join-Path $runtime 'temp'
  foreach ($directory in @($inputRoot,$runtime,$profileOnlyHome,(Join-Path $profileOnlyHome 'AppData'),(Join-Path $profileOnlyHome 'AppData\Roaming'),(Join-Path $profileOnlyHome 'AppData\Local'),$temp)) {
    $created = [CcHaha1879ProfileOnlyLaunchV1.Native]::CreateOwnedDirectory($directory,$runnerSid)
    Require-True (Same-Path $created.Path $directory) 'owned_child_canonical_identity_changed'
    Assert-PrivateAcl (Get-Acl -LiteralPath $directory) $runnerSid $true $true $false
  }
  Require-True (-not (Test-Path -LiteralPath $spec.controllerRoot)) 'native_controller_root_must_not_exist'
  function Copy-ReadonlyInput([string]$From,[string]$To,[string]$Hash,[long]$Bytes=-1) {
    # CreateNew under the owned writable root before applying the exact final
    # ACL. Do not inherit source file attributes/security through File.Copy.
    $source = [IO.FileStream]::new($From,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
      Require-True ($source.Length -gt 0 -and $source.Length -le 1048576 -and ($Bytes -lt 0 -or $source.Length -eq $Bytes)) 'bounded_readonly_input_required'
      $target = [IO.FileStream]::new($To,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      try { $source.CopyTo($target); $target.Flush($true) } finally { $target.Dispose() }
    } finally { $source.Dispose() }
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true,$false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($runnerSid))
    $readonlyRights = [Security.AccessControl.FileSystemRights]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
    foreach ($sid in @($runnerSid,'S-1-5-18','S-1-5-32-544')) {
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),$readonlyRights,[Security.AccessControl.AccessControlType]::Allow))
    }
    [IO.File]::SetAttributes($To,[IO.File]::GetAttributes($To) -bor [IO.FileAttributes]::ReadOnly)
    [IO.File]::SetAccessControl($To,$acl)
    Lock-HashedFile $To $Hash $Bytes
    Assert-PrivateAcl (Get-Acl -LiteralPath $To) $runnerSid $false $true $true
  }
  $binary = Join-Path $inputRoot 'profile-fixture.exe'
  Copy-ReadonlyInput (Join-Path $StageAInputDirectory 'profile-fixture.exe') $binary $pins.binarySha256 $pins.binaryBytes
  foreach ($pin in $pins.sourcePins) { Copy-ReadonlyInput (Join-Path $StageAInputDirectory $pin.file) (Join-Path $inputRoot $pin.file) $pin.sha256 $pin.bytes }
  $stagedSpec = Join-Path $inputRoot 'profile-only-spec.proposed.json'
  Copy-ReadonlyInput $specPath $stagedSpec $ApprovedSpecSha256
  # No setup, old uninstaller, Subject or helper payload is read or copied.
  $binaryIdentity = [CcHaha1879ProfileOnlyLaunchV1.Native]::Identity($binary,$false)
  Require-True (Same-Path $binaryIdentity.Path $binary) 'staged_binary_canonical_identity_changed'
  $windows = [CcHaha1879ProfileOnlyLaunchV1.Native]::WindowsDirectory()
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $binary
  $start.Arguments = '--role profile-only --spec "' + $stagedSpec + '"'
  $start.WorkingDirectory = [string]$pins.stageBase
  $start.UseShellExecute = $false; $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
  $start.EnvironmentVariables.Clear()
  foreach ($name in @('SystemRoot','WINDIR','SystemDrive','OS','ComSpec','PROCESSOR_ARCHITECTURE','PROCESSOR_ARCHITEW6432','NUMBER_OF_PROCESSORS')) {
    $value = [Environment]::GetEnvironmentVariable($name,'Process')
    if ($null -ne $value) { $start.EnvironmentVariables[$name] = $value }
  }
  Require-True ((Same-Path $start.EnvironmentVariables['SystemRoot'] $windows) -and (Same-Path $start.EnvironmentVariables['WINDIR'] $windows)) 'actual_windows_root_changed'
  $start.EnvironmentVariables['PATH'] = $windows + '\System32;' + $windows + ';' + $windows + '\System32\Wbem'
  foreach ($name in @('HOME','USERPROFILE')) { $start.EnvironmentVariables[$name] = $profileOnlyHome }
  $start.EnvironmentVariables['APPDATA'] = Join-Path $profileOnlyHome 'AppData\Roaming'
  $start.EnvironmentVariables['LOCALAPPDATA'] = Join-Path $profileOnlyHome 'AppData\Local'
  foreach ($name in @('TEMP','TMP','TMPDIR')) { $start.EnvironmentVariables[$name] = $temp }
  $start.EnvironmentVariables['CI'] = 'true'
  foreach ($name in @('ImageOS','ImageVersion')) {
    $value = [Environment]::GetEnvironmentVariable($name,'Process')
    Require-True ($null -eq $value -or $value.Length -le 256) 'bounded_image_diagnostic_required'
    if ($null -ne $value) { $start.EnvironmentVariables[$name] = $value }
  }
  # No GITHUB/ACTIONS token, provider, CLAUDE_CONFIG_DIR, XDG/GH/CODEX or
  # COMPLUS variable is inherited. These are exactly the new d2e names.
  $self = [Diagnostics.Process]::GetCurrentProcess()
  try { $launcher = [CcHaha1879ProfileOnlyLaunchV1.Native]::Capture($self) } finally { $self.Dispose() }
  Require-True ($launcher.Pid -eq $PID -and $launcher.Sid -ceq $runnerSid) 'launcher_identity_changed'
  $receipt = [ordered]@{
    version=1; mode='profile-only-launch'; status='prepared_no_controller_start'; rootAdmissionSha256=$ApprovedAdmissionSha256
    pinsSha256=$ApprovedPinsSha256; specSha256=$ApprovedSpecSha256; binarySha256=$pins.binarySha256; binaryBytes=$pins.binaryBytes
    runId=$spec.runId; owner=$spec.owner; generation=$spec.generation; activationHead=$pins.activationHead; actionsRunId=$env:GITHUB_RUN_ID
    runnerSid=$runnerSid; stageBase=$pins.stageBase; stageIdentity=$stageIdentity.Id; stagedSpec=$stagedSpec; binaryPath=$binary; binaryFileIdentity=$binaryIdentity.Id
    claimFile=$ClaimFile; claimSha256=$claim.Sha256; launcherPid=$launcher.Pid; launcherBirthUtc=$launcher.BirthUtc; launcherBirthFileTime=$launcher.BirthFileTime
    launcherImage=$launcher.Image; launcherScriptSha256=$pins.launcherSha256; reconcileScriptSha256=$pins.reconcileSha256
    controllerStartAttempted=$false; controllerStarted=$false; controllerMayHaveExecuted=$false; controllerIdentityVerified=$false
    controllerPid=$null; controllerBirthUtc=$null; controllerBirthFileTime=$null; controllerImage=$null; controllerRunnerSid=$null
    nativeExitCode=$null; nativeCleanup='not_run'; nativeCleanupReported=$null; terminalReportSha256=$null
    releasedPeExecuted=$false; releasedPeMayHaveExecuted=$false; releasedPeExecutionStatus='not_run'; compatibilityEnabled=$false; oldExit22Policy='fatal'
    member_proven='not_run'; installed_bytes_equal='not_run'; old22_before_protected_mutation='not_run'; removal_equivalence='not_run'; full_old_to_new='not_run'
    stdoutComplete=$false; stderrComplete=$false; rawLogOverflow=$false; failedStage=$null; diagnostic=$null; errorInfo=$null; receiptWriteError=$null; retryAllowed=$false
  }
  $receiptPath = Join-Path $pins.stageBase 'launch-receipt.json'
  $stage='persist-prepared-receipt'
  Save-AtomicJson $receiptPath $receipt
  $process = [Diagnostics.Process]::new(); $process.StartInfo=$start
  $stage='persist-arm-before-start'
  $receipt.controllerStartAttempted=$true; $receipt.controllerMayHaveExecuted=$true; $receipt.nativeCleanup='unknown'; $receipt.status='controller_start_attempt_in_progress'
  Save-AtomicJson $receiptPath $receipt
  $stage='process-start'
  Require-True ($process.Start()) 'controller_start_failed_unknown'
  $stage='close-controller-stdin'
  $process.StandardInput.Close()
  $stage='capture-controller-stdout'
  $stdout=[CcHaha1879ProfileOnlyLaunchV1.RawCapture]::new($process.StandardOutput.BaseStream,(Join-Path $pins.stageBase 'controller.stdout.raw.log'),1048576)
  $stage='capture-controller-stderr'
  $stderr=[CcHaha1879ProfileOnlyLaunchV1.RawCapture]::new($process.StandardError.BaseStream,(Join-Path $pins.stageBase 'controller.stderr.raw.log'),1048576)
  $stage='capture-controller-identity'
  $receipt.controllerStarted=$true; $receipt.controllerPid=$process.Id
  # Keep the held Process object. No PID-only reopening authorizes success.
  $receipt.controllerBirthUtc=$process.StartTime.ToUniversalTime().ToString('o',[Globalization.CultureInfo]::InvariantCulture)
  $receipt.controllerBirthFileTime=$process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
  Save-AtomicJson $receiptPath $receipt
  $actual=[CcHaha1879ProfileOnlyLaunchV1.Native]::Capture($process)
  Require-True ($actual.Pid -eq $receipt.controllerPid -and $actual.BirthFileTime -ceq $receipt.controllerBirthFileTime -and $actual.Sid -ceq $runnerSid -and (Same-Path $actual.Image $binary)) 'held_controller_identity_changed'
  $currentBinary=[CcHaha1879ProfileOnlyLaunchV1.Native]::Identity($actual.Image,$false)
  Require-True ($currentBinary.Id -ceq $binaryIdentity.Id -and (File-Hash $binary) -ceq $pins.binarySha256) 'controller_binary_replaced'
  $receipt.controllerIdentityVerified=$true; $receipt.controllerImage=$actual.Image; $receipt.controllerRunnerSid=$actual.Sid
  Save-AtomicJson $receiptPath $receipt
  $stage='bounded-natural-controller-exit'
  Require-True ($pins.controllerTimeoutMilliseconds -gt 0 -and $pins.controllerTimeoutMilliseconds -le 300000) 'invalid_controller_timeout'
  if (-not $process.WaitForExit([int]$pins.controllerTimeoutMilliseconds)) {
    $receipt.status='timeout_unknown_requires_serial_reconciliation'; Save-AtomicJson $receiptPath $receipt
    throw 'controller_timeout_no_kill_no_retry'
  }
  $receipt.nativeExitCode=$process.ExitCode
  $receipt.stdoutComplete=$stdout.Wait(5000); $receipt.stderrComplete=$stderr.Wait(5000)
  $receipt.rawLogOverflow=$stdout.Overflow -or $stderr.Overflow
  Require-True ($receipt.stdoutComplete -and $receipt.stderrComplete -and -not $receipt.rawLogOverflow -and $null -eq $stdout.Failure -and $null -eq $stderr.Failure) 'raw_log_capture_incomplete_or_failed'
  $stage='bound-native-terminal-report'
  Assert-OrdinaryPath $spec.output $false
  $reportHash=File-Hash $spec.output; Lock-HashedFile $spec.output $reportHash
  Assert-PrivateAcl (Get-Acl -LiteralPath $spec.controllerRoot) $runnerSid $true $false $false
  Assert-PrivateAcl (Get-Acl -LiteralPath $spec.output) $runnerSid $false $false $false
  $report=Read-PacketJson $spec.output
  $receipt.nativeCleanupReported=[string]$report.cleanup; $receipt.terminalReportSha256=$reportHash
  Require-True ($process.ExitCode -eq 0 -and $report.version -eq 1 -and $report.mode -ceq 'profile-only' -and $report.status -ceq 'passed' -and $report.cleanup -ceq 'cleaned' -and $report.binarySha256 -ceq $pins.binarySha256 -and $report.specSha256 -ceq $ApprovedSpecSha256 -and $report.checks.Count -gt 0 -and @($report.checks | Where-Object { $_.status -cne 'passed' }).Count -eq 0) 'native_failed_unbound_or_not_cleaned'
  Require-True ($report.realAccountsCreated -eq 1 -and $report.realProfilesCreated -eq 1 -and $report.releasedPeExecuted -is [bool] -and -not $report.releasedPeExecuted -and $report.releasedPeMayHaveExecuted -is [bool] -and -not $report.releasedPeMayHaveExecuted -and $report.releasedPeExecutionStatus -ceq 'not_run' -and $report.compatibilityEnabled -is [bool] -and -not $report.compatibilityEnabled -and $report.oldExit22Policy -ceq 'fatal') 'profile_only_effect_scope_changed'
  foreach ($name in @('member_proven','installed_bytes_equal','old22_before_protected_mutation','removal_equivalence','full_old_to_new')) { Require-True ($report.$name -ceq 'not_run') 'historical_overclaim' }
  Require-True ((File-Hash $binary) -ceq $pins.binarySha256) 'postrun_binary_changed'
  $receipt.nativeCleanup='cleaned'; $receipt.status='native_profile_only_passed_and_cleaned_no_F1_claim'
  Save-AtomicJson $receiptPath $receipt
  $receipt | ConvertTo-Json -Depth 10
} catch {
  $failureInfo=Get-SafeFailure $_
  if ($null -ne $receipt) {
    if ($receipt.status -cne 'timeout_unknown_requires_serial_reconciliation') { $receipt.status='failed_requires_serial_reconciliation' }
    $receipt.nativeCleanup='unknown'; $receipt.failedStage=$stage; $receipt.diagnostic='bounded_precondition_or_operation_failure'; $receipt.errorInfo=$failureInfo
    try { Save-AtomicJson $receiptPath $receipt } catch { $receipt.receiptWriteError=Get-SafeFailure $_ }
    $receipt | ConvertTo-Json -Depth 10
  } else { [ordered]@{version=1;status='stopped_before_controller_start';stage=$stage;cleanup='not_run';accountApi='not_run';readiness='NOT_READY_OR_PRECONDITION_FAILED';errorInfo=$failureInfo} | ConvertTo-Json }
  exit 1
} finally {
  if ($null -ne $process) { $process.Dispose() }
  foreach ($stream in $held) { $stream.Dispose() }
  foreach ($name in $savedScratch.Keys) { [Environment]::SetEnvironmentVariable($name,$savedScratch[$name],'Process') }
  # No kill, retry, account/profile/hive delete, unknown-entry removal or
  # automatic helper call. Reconciliation is a separately reviewed serial step.
}

exit 0
