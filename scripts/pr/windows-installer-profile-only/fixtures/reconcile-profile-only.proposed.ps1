# SOURCE-ONLY DRAFT. No profile-only/live admission is provided here.
# Default reads only package JSON and emits NOT_READY/not_run; no Add-Type/API.
[CmdletBinding()]
param(
  [switch]$DisableReviewedProfileOnlyOwnedAccount,
  [string]$ApprovedPinsSha256,
  [string]$ApprovedSpecSha256,
  [string]$ApprovedAdmissionSha256,
  [string]$ClaimFile
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$pinsPath=Join-Path $PSScriptRoot 'pins.proposed.json'
$specPath=Join-Path $PSScriptRoot 'profile-only-spec.proposed.json'
$admissionPath=Join-Path $PSScriptRoot 'root-admission.proposed.json'
$pins=Get-Content -Raw -LiteralPath $pinsPath -Encoding UTF8|ConvertFrom-Json
$spec=Get-Content -Raw -LiteralPath $specPath -Encoding UTF8|ConvertFrom-Json
$admission=Get-Content -Raw -LiteralPath $admissionPath -Encoding UTF8|ConvertFrom-Json
if(-not $DisableReviewedProfileOnlyOwnedAccount){
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
  Require-True ($pins.binarySha256 -ceq 'be48adb570326e5fd23161e2f51a6af2cf4aa7f0316e6dbd85fe8a09b99fc312' -and $pins.binaryBytes -eq 225792 -and $spec.expectedBinarySha256 -ceq $pins.binarySha256) 'original_new_stage_a_pe_changed'
  Require-True ($pins.stageA.status -ceq 'passed' -and $pins.stageA.head -ceq '1482440377d9de67f5222a3fc3db2758f03c5297' -and $pins.stageA.runId -eq 43420260030 -and $pins.stageA.artifactId -eq 14034096259) 'new_stage_a_binding_changed'
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

$held=[Collections.Generic.List[IDisposable]]::new(); $savedScratch=@{}
$receiptStream=$null; $reconciliation=$null; $stage='frozen-packet'
function Read-PrivateJson([string]$Path,[string]$RunnerSid,[bool]$Strict) {
  Assert-OrdinaryPath $Path $false
  $share=if($Strict){[IO.FileShare]::Read}else{[IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete}
  $stream=[IO.FileStream]::new($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,$share); $retained=$false
  try {
    Require-True ($stream.Length -gt 0 -and $stream.Length -le 65536) 'bounded_private_json_required'
    Assert-PrivateAcl $stream.GetAccessControl() $RunnerSid $false $false $false
    $bytes=New-Object byte[] ([int]$stream.Length); $offset=0
    while($offset -lt $bytes.Length){$count=$stream.Read($bytes,$offset,$bytes.Length-$offset);Require-True ($count -gt 0) 'incomplete_private_snapshot';$offset+=$count}
    Require-True ($stream.Length -eq $bytes.Length) 'private_snapshot_changed'
    $text=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)
    if($text.Length -gt 0 -and $text[0] -eq [char]0xfeff){$text=$text.Substring(1)}
    $value=ConvertFrom-Json -InputObject $text
    if($Strict){$script:held.Add($stream);$retained=$true}
    return [pscustomobject]@{Value=$value;Sha256=(Hash-Bytes $bytes)}
  }finally{if(-not $retained){$stream.Dispose()}}
}
function Read-LauncherReceipt([string]$Path,[string]$RunnerSid,[bool]$Strict) {
  # Launcher container grants Administrators too; native Controller does not.
  Assert-OrdinaryPath $Path $false
  $share=if($Strict){[IO.FileShare]::Read}else{[IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete}
  $stream=[IO.FileStream]::new($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,$share);$retained=$false
  try{
    Require-True ($stream.Length -gt 0 -and $stream.Length -le 65536) 'bounded_launch_receipt_required'
    Assert-PrivateAcl $stream.GetAccessControl() $RunnerSid $false $true $false
    $bytes=New-Object byte[] ([int]$stream.Length);$offset=0
    while($offset -lt $bytes.Length){$count=$stream.Read($bytes,$offset,$bytes.Length-$offset);Require-True ($count -gt 0) 'incomplete_launch_snapshot';$offset+=$count}
    Require-True ($stream.Length -eq $bytes.Length) 'launch_snapshot_changed'
    $text=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)
    if($text.Length -gt 0 -and $text[0] -eq [char]0xfeff){$text=$text.Substring(1)}
    $value=ConvertFrom-Json -InputObject $text
    if($Strict){$script:held.Add($stream);$retained=$true}
    return [pscustomobject]@{Value=$value;Sha256=(Hash-Bytes $bytes)}
  }finally{if(-not $retained){$stream.Dispose()}}
}
function Birth-FileTime($Utc,[string]$Stored) {
  $birth=if($Utc -is [DateTime]){$Utc}elseif($Utc -is [string]){[DateTime]::ParseExact($Utc,'o',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::RoundtripKind)}else{throw 'invalid_birth_type'}
  Require-True ($birth.Kind -eq [DateTimeKind]::Utc -and $birth -le [DateTime]::UtcNow -and $Stored -cmatch '\A[0-9]{1,20}\z') 'invalid_birth_identity'
  $fileTime=[uint64]$birth.ToFileTimeUtc();Require-True ($fileTime -gt 0 -and $fileTime.ToString([Globalization.CultureInfo]::InvariantCulture) -ceq $Stored) 'birth_representation_mismatch'
  return $fileTime
}
function Assert-ManagedGone([int]$ProcessId,[uint64]$Birth) {
  # No compilation, strict lock or reconciliation receipt before both PIDs are
  # gone. Any access error, reused PID or still-live process stops the helper.
  Require-True ($ProcessId -gt 4 -and $Birth -gt 0) 'missing_process_identity'
  try{$candidate=[Diagnostics.Process]::GetProcessById($ProcessId)}catch [ArgumentException]{return}
  try{
    Require-True ([uint64]$candidate.StartTime.ToUniversalTime().ToFileTimeUtc() -eq $Birth) 'process_pid_reused_or_unknown'
    Require-True ($candidate.HasExited) 'launcher_or_controller_still_alive'
  }finally{$candidate.Dispose()}
}
function Save-Reconciliation {
  Require-True ($null -ne $receiptStream -and $null -ne $reconciliation) 'owned_reconciliation_stream_required'
  $bytes=[Text.UTF8Encoding]::new($false,$true).GetBytes(($reconciliation|ConvertTo-Json -Depth 10)+"`n")
  $receiptStream.Position=0;$receiptStream.SetLength(0);$receiptStream.Write($bytes,0,$bytes.Length);$receiptStream.Flush($true)
}
try{
  Assert-FrozenPacket $ApprovedPinsSha256 $ApprovedSpecSha256 $ApprovedAdmissionSha256 (File-Hash $PSCommandPath) $true
  Require-True ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT -and [Environment]::Is64BitProcess -and $PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -eq 1 -and $PSVersionTable.PSEdition -ceq 'Desktop') 'windows_x64_powershell51_required'
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  try{$runnerSid=$identity.User.Value;Require-True ([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'existing_admin_required'}finally{$identity.Dispose()}
  $stage='protected-bootstrap-and-claim'
  Assert-OrdinaryPath $pins.privateBootstrapRoot $true;Assert-PrivateAcl (Get-Acl -LiteralPath $pins.privateBootstrapRoot) $runnerSid $true $true $false
  $claim=Assert-ActionsContext $ClaimFile $runnerSid
  $stage='owned-stage-controller-layout'
  Assert-OrdinaryPath $pins.stageBase $true;Assert-PrivateAcl (Get-Acl -LiteralPath $pins.stageBase) $runnerSid $true $true $false
  Assert-OrdinaryPath $spec.controllerRoot $true;Assert-PrivateAcl (Get-Acl -LiteralPath $spec.controllerRoot) $runnerSid $true $false $false
  $launchPath=Join-Path $pins.stageBase 'launch-receipt.json';$ledgerPath=Join-Path $spec.controllerRoot 'ledger.json'
  $stage='noninterfering-receipt-ledger-snapshots'
  $launchSnapshot=Read-LauncherReceipt $launchPath $runnerSid $false;$ledgerSnapshot=Read-PrivateJson $ledgerPath $runnerSid $false
  $launch=$launchSnapshot.Value;$ledger=$ledgerSnapshot.Value
  Require-True ($launch.version -eq 1 -and $launch.mode -ceq 'profile-only-launch' -and $launch.runnerSid -ceq $runnerSid -and $launch.specSha256 -ceq $ApprovedSpecSha256 -and $launch.pinsSha256 -ceq $ApprovedPinsSha256 -and $launch.rootAdmissionSha256 -ceq $ApprovedAdmissionSha256 -and $launch.binarySha256 -ceq $pins.binarySha256 -and $launch.binaryBytes -eq $pins.binaryBytes -and $launch.stageBase -ceq $pins.stageBase -and $launch.activationHead -ceq $pins.activationHead -and $launch.actionsRunId -ceq $env:GITHUB_RUN_ID -and $launch.claimFile -ceq $ClaimFile -and $launch.claimSha256 -ceq $claim.Sha256) 'launch_binding_missing'
  Require-True ($launch.launcherScriptSha256 -ceq $pins.launcherSha256 -and $launch.reconcileScriptSha256 -ceq $pins.reconcileSha256 -and $launch.binaryPath -ceq (Join-Path $spec.sourceRoot 'profile-fixture.exe') -and $launch.stagedSpec -ceq (Join-Path $spec.sourceRoot 'profile-only-spec.proposed.json')) 'payload_path_or_hash_changed'
  foreach($value in @($launch,$ledger)){Require-True ($value.runId -ceq $spec.runId -and $value.owner -ceq $spec.owner -and $value.generation -eq $spec.generation) 'ledger_owner_generation_changed'}
  Require-True ($launch.controllerStartAttempted -is [bool] -and $launch.controllerStartAttempted -and $launch.controllerStarted -is [bool] -and $launch.controllerStarted -and $launch.controllerIdentityVerified -is [bool] -and $launch.controllerIdentityVerified -and $launch.controllerRunnerSid -ceq $runnerSid -and (Same-Path $launch.controllerImage $launch.binaryPath)) 'actual_controller_identity_not_proven'
  Require-True (@('controller_start_attempt_in_progress','failed_requires_serial_reconciliation','timeout_unknown_requires_serial_reconciliation') -ccontains $launch.status) 'normal_success_or_unstarted_launch_cannot_reconcile'
  Require-True ($launch.controllerPid -gt 4 -and $launch.controllerPid -le [int]::MaxValue -and $launch.launcherPid -gt 4 -and $launch.launcherPid -le [int]::MaxValue -and $launch.controllerPid -ne $launch.launcherPid) 'invalid_retained_pids'
  $controllerPid=[int]$launch.controllerPid;$launcherPid=[int]$launch.launcherPid
  $controllerBirth=Birth-FileTime $launch.controllerBirthUtc ([string]$launch.controllerBirthFileTime)
  $launcherBirth=Birth-FileTime $launch.launcherBirthUtc ([string]$launch.launcherBirthFileTime)
  Require-True ($ledger.version -eq 1 -and $ledger.specSha256 -ceq $ApprovedSpecSha256 -and $ledger.accountCreated -is [bool] -and $ledger.accountCreated -and $ledger.accountBound -is [bool] -and $ledger.accountBound -and $null -ne $ledger.account) 'intent_only_or_unbound_ledger_forbidden'
  Require-True (@('sid-marker-ledger','createprofile-call-armed','createprofile-owner-proven') -ccontains $ledger.stage) 'ledger_outside_profile_only_creation_boundary'
  $marker=[string]$ledger.marker;$match=[Text.RegularExpressions.Regex]::Match($marker,'\ACcHaha1879:52f4ce19-5ded-4b27-8268-a2840809e0ca:([0-9a-f]{32})\z',[Text.RegularExpressions.RegexOptions]::CultureInvariant)
  Require-True ($match.Success) 'full_unpredictable_marker_required'
  $sam='c1879_'+$match.Groups[1].Value.Substring(0,12);$accountSid=[string]$ledger.account.sid
  Require-True ($ledger.intentSam -ceq $sam -and $ledger.account.sam -ceq $sam -and $ledger.account.marker -ceq $marker -and $accountSid -cmatch '\AS-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+\z' -and [Security.Principal.SecurityIdentifier]::new($accountSid).Value -ceq $accountSid -and $accountSid -cne $runnerSid) 'owned_sam_sid_fullmarker_mismatch'
  $stage='both-launcher-and-controller-gone-before-lock-or-write'
  Assert-ManagedGone $launcherPid $launcherBirth;Assert-ManagedGone $controllerPid $controllerBirth
  # No lock excluding Controller AtomicWrite and no CreateNew receipt above.
  $stage='private-helper-compilation'
  $scratch=Join-Path $pins.stageBase 'runtime\temp';Assert-OrdinaryPath $scratch $true;Assert-PrivateAcl (Get-Acl -LiteralPath $scratch) $runnerSid $true $true $false
  foreach($name in @('TEMP','TMP','TMPDIR')){$savedScratch[$name]=[Environment]::GetEnvironmentVariable($name,'Process');[Environment]::SetEnvironmentVariable($name,$scratch,'Process')}
  Require-True ($null -eq ('CcHaha1879ProfileOnlyDisableV1.Native' -as [type])) 'helper_type_already_loaded_no_retry'
  $nativeSource = @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

namespace CcHaha1879ProfileOnlyDisableV1
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
  public sealed class FileRecord { public string Path, Id; }
  public static class Native
  {
    [StructLayout(LayoutKind.Sequential)]
    private struct User23 { public IntPtr name, fullName, comment; public uint flags; public IntPtr sid; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Flags1008 { public uint flags; }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime { public uint low, high; }
    [StructLayout(LayoutKind.Sequential)] private struct FileInformation { public uint attributes; public FileTime creation, access, write; public uint volume, high, low, links, indexHigh, indexLow; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern IntPtr CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandle(IntPtr file,out FileInformation info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern uint GetFinalPathNameByHandleW(IntPtr file,StringBuilder path,uint chars,uint flags);
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

    public static FileRecord Identity(string path, bool directory)
    {
      IntPtr file=CreateFileW(path,0x80,7,IntPtr.Zero,3,0x00200000u|(directory?0x02000000u:0),IntPtr.Zero);
      if(file==new IntPtr(-1)) throw new Failure("CreateFileW",unchecked((uint)Marshal.GetLastWin32Error()),0);
      try {
        FileInformation info;
        if(!GetFileInformationByHandle(file,out info)) throw new Failure("GetFileInformationByHandle",unchecked((uint)Marshal.GetLastWin32Error()),0);
        if((info.attributes&0x400)!=0 || ((info.attributes&0x10)!=0)!=directory) throw new InvalidOperationException("Unexpected ordinary path kind");
        StringBuilder actual=new StringBuilder(32768); uint length=GetFinalPathNameByHandleW(file,actual,(uint)actual.Capacity,0);
        if(length==0 || length>=actual.Capacity) throw new Failure("GetFinalPathNameByHandleW",unchecked((uint)Marshal.GetLastWin32Error()),0);
        string canonical=actual.ToString(); if(canonical.StartsWith(@"\\?\",StringComparison.Ordinal)) canonical=canonical.Substring(4);
        return new FileRecord { Path=canonical,Id=info.volume.ToString("x8",CultureInfo.InvariantCulture)+":"+info.indexHigh.ToString("x8",CultureInfo.InvariantCulture)+info.indexLow.ToString("x8",CultureInfo.InvariantCulture) };
      } finally { if(!CloseHandle(file)) throw new Failure("CloseHandle",unchecked((uint)Marshal.GetLastWin32Error()),0); }
    }

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

    public static Observation DisableBound(string sam, string sid, string marker, int controllerPid, ulong controllerBirth, int launcherPid, ulong launcherBirth)
    {
      RequireControllerGone(launcherPid, launcherBirth);
      RequireControllerGone(controllerPid, controllerBirth);
      Account before = ReadBound(sam, sid, marker);
      uint desired = before.flags | 0x0002;
      bool changed = (before.flags & 0x0002) == 0;
      if (changed)
      {
        RequireControllerGone(launcherPid, launcherBirth);
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
  $stage='native-gone-proof-before-strict-lock'
  $launcherGone=[CcHaha1879ProfileOnlyDisableV1.Native]::RequireControllerGone($launcherPid,$launcherBirth)
  $controllerGone=[CcHaha1879ProfileOnlyDisableV1.Native]::RequireControllerGone($controllerPid,$controllerBirth)
  $stageRecord=[CcHaha1879ProfileOnlyDisableV1.Native]::Identity($pins.stageBase,$true)
  $imageRecord=[CcHaha1879ProfileOnlyDisableV1.Native]::Identity($launch.binaryPath,$false)
  Require-True ((Same-Path $stageRecord.Path $pins.stageBase) -and $stageRecord.Id -ceq $launch.stageIdentity -and (Same-Path $imageRecord.Path $launch.binaryPath) -and $imageRecord.Id -ceq $launch.binaryFileIdentity) 'owned_stage_or_binary_file_identity_changed'
  $stage='strict-immutable-rebinding'
  Lock-HashedFile $pinsPath $ApprovedPinsSha256;Lock-HashedFile $specPath $ApprovedSpecSha256;Lock-HashedFile $admissionPath $ApprovedAdmissionSha256
  Lock-HashedFile $PSCommandPath $pins.reconcileSha256;Lock-HashedFile (Join-Path $PSScriptRoot 'launch-profile-only.proposed.ps1') $pins.launcherSha256
  Lock-HashedFile $launch.binaryPath $pins.binarySha256 $pins.binaryBytes;Lock-HashedFile $launch.stagedSpec $ApprovedSpecSha256;Lock-HashedFile $ClaimFile $claim.Sha256
  Assert-PrivateAcl (Get-Acl -LiteralPath $launch.binaryPath) $runnerSid $false $true $true
  foreach($pin in $pins.sourcePins){$file=Join-Path $spec.sourceRoot $pin.file;Lock-HashedFile $file $pin.sha256 $pin.bytes;Assert-PrivateAcl (Get-Acl -LiteralPath $file) $runnerSid $false $true $true}
  $launchHeld=Read-LauncherReceipt $launchPath $runnerSid $true;$ledgerHeld=Read-PrivateJson $ledgerPath $runnerSid $true
  Require-True ($launchHeld.Sha256 -ceq $launchSnapshot.Sha256 -and $ledgerHeld.Sha256 -ceq $ledgerSnapshot.Sha256) 'snapshot_changed_after_gone_proof'
  Assert-PrivateAcl (Get-Acl -LiteralPath $spec.controllerRoot) $runnerSid $true $false $false
  $launcherGone=[CcHaha1879ProfileOnlyDisableV1.Native]::RequireControllerGone($launcherPid,$launcherBirth)
  $controllerGone=[CcHaha1879ProfileOnlyDisableV1.Native]::RequireControllerGone($controllerPid,$controllerBirth)
  $stage='one-shot-reconciliation-receipt'
  $receiptStream=[IO.FileStream]::new((Join-Path $pins.stageBase 'reconcile-receipt.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
  Assert-PrivateAcl $receiptStream.GetAccessControl() $runnerSid $false $true $false
  $reconciliation=[ordered]@{
    version=1;mode='profile-only-disable-only';status='disable_not_attempted';cleanup='failed';remaining='unknown';retryAllowed=$false
    pinsSha256=$ApprovedPinsSha256;specSha256=$ApprovedSpecSha256;rootAdmissionSha256=$ApprovedAdmissionSha256;binarySha256=$pins.binarySha256
    runId=$spec.runId;owner=$spec.owner;generation=$spec.generation;activationHead=$pins.activationHead;runnerSid=$runnerSid
    ledgerSha256=$ledgerHeld.Sha256;launchReceiptSha256=$launchHeld.Sha256;markerSha256=(Hash-Text $marker);accountSidSha256=(Hash-Text $accountSid)
    launcherPid=$launcherPid;launcherBirthFileTime=$launcherBirth.ToString();launcherState=$launcherGone;controllerPid=$controllerPid;controllerBirthFileTime=$controllerBirth.ToString();controllerState=$controllerGone
    accountQueryAttempted=$false;disableMayHaveOccurred=$false;disabledVerified=$false;flagsBefore=$null;flagsAfter=$null
    originalProfileLease='not_available';profileAndHiveState='unknown_not_mutated';ownedJobs='unknown_not_mutated';failedStage=$null;diagnostic=$null;errorInfo=$null;receiptWriteError=$null
    member_proven='not_run';installed_bytes_equal='not_run';old22_before_protected_mutation='not_run';removal_equivalence='not_run';full_old_to_new='not_run';compatibilityEnabled=$false;oldExit22Policy='fatal'
  }
  Save-Reconciliation
  $stage='exact-bound-account-disable-only'
  $reconciliation.accountQueryAttempted=$true;$reconciliation.disableMayHaveOccurred=$true;$reconciliation.status='disable_attempt_in_progress_remaining_unknown';Save-Reconciliation
  $observed=[CcHaha1879ProfileOnlyDisableV1.Native]::DisableBound($sam,$accountSid,$marker,$controllerPid,$controllerBirth,$launcherPid,$launcherBirth)
  $reconciliation.disabledVerified=$true;$reconciliation.disableMayHaveOccurred=[bool]$observed.SetCalled;$reconciliation.flagsBefore=[uint32]$observed.FlagsBefore;$reconciliation.flagsAfter=[uint32]$observed.FlagsAfter
  $reconciliation.status='disabled_remaining_unknown';Save-Reconciliation
  $reconciliation|ConvertTo-Json -Depth 10
}catch{
  $failureInfo=Get-SafeFailure $_
  $diagnostic='precondition_or_managed_operation_failed';$errorObject=$_.Exception
  for($depth=0;$null -ne $errorObject -and $depth -lt 6;$depth++){
    if($errorObject.GetType().FullName -ceq 'CcHaha1879ProfileOnlyDisableV1.Failure'){$diagnostic='native_operation='+$errorObject.Operation+';code='+$errorObject.Code+';parameter='+$errorObject.Parameter;break};$errorObject=$errorObject.InnerException
  }
  if($null -ne $reconciliation){$reconciliation.status='stopped_unknown_requires_root_reconciliation';$reconciliation.failedStage=$stage;$reconciliation.diagnostic=$diagnostic;$reconciliation.errorInfo=$failureInfo;try{Save-Reconciliation}catch{$reconciliation.receiptWriteError=Get-SafeFailure $_};$reconciliation|ConvertTo-Json -Depth 10}
  else{[ordered]@{version=1;status='stopped_unknown_requires_root_reconciliation';failedStage=$stage;diagnostic=$diagnostic;errorInfo=$failureInfo;accountApi='not_run';cleanup='failed';remaining='unknown';retryAllowed=$false}|ConvertTo-Json}
}finally{
  if($null -ne $receiptStream){$receiptStream.Dispose()};foreach($stream in $held){$stream.Dispose()};foreach($name in $savedScratch.Keys){[Environment]::SetEnvironmentVariable($name,$savedScratch[$name],'Process')}
}
# Success means only the owned account is disabled. No hProfile lease exists
# here; no kill/unload/DeleteProfile/NetUserDel/password/global repair is legal.
exit 1
