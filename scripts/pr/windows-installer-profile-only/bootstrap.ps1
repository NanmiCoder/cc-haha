# Preparation only: no account/Profile/process launch or reconciliation API.
[CmdletBinding()]
param(
  [switch]$PrepareReviewedProfileOnly,
  [string]$PlanPath,
  [string]$ApprovedPlanSha256
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(-not $PrepareReviewedProfileOnly){
  [ordered]@{version=1;status='not_run';accountApi='not_run';nativeExecution='not_run'}|ConvertTo-Json
  return
}
function Require-Bootstrap([bool]$Value,[string]$Code){if(-not $Value){throw $Code}}
Require-Bootstrap ($ApprovedPlanSha256 -cmatch '\A[0-9a-f]{64}\z' -and (Get-FileHash -LiteralPath $PlanPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $ApprovedPlanSha256) 'approved_preparation_plan_required'
$planItem=Get-Item -LiteralPath $PlanPath -Force
Require-Bootstrap (-not $planItem.PSIsContainer -and $planItem.Length -le 1048576 -and ($planItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'bounded_plan_required'
$plan=Get-Content -Raw -LiteralPath $PlanPath -Encoding UTF8|ConvertFrom-Json
Require-Bootstrap ($plan.version -eq 1 -and $env:CI -ceq 'true' -and $env:GITHUB_ACTIONS -ceq 'true' -and $env:GITHUB_EVENT_NAME -ceq 'pull_request' -and $env:GITHUB_ACTOR -ceq 'NanmiCoder' -and $env:GITHUB_REPOSITORY -ceq 'NanmiCoder/cc-haha' -and $env:GITHUB_RUN_ATTEMPT -ceq '1') 'explicit_first_actions_context_required'
Require-Bootstrap ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT -and [Environment]::Is64BitProcess -and $PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -eq 1 -and $PSVersionTable.PSEdition -ceq 'Desktop') 'powershell51_x64_required'
Require-Bootstrap ($env:RUNNER_TEMP -ceq 'D:\a\_temp' -and $env:GITHUB_WORKSPACE -ceq 'D:\a\cc-haha\cc-haha') 'reviewed_runner_paths_required'
$event=Get-Content -Raw -LiteralPath $env:GITHUB_EVENT_PATH -Encoding UTF8|ConvertFrom-Json
$head=[string]$plan.invocation.head
Require-Bootstrap ($head -cmatch '\A[0-9a-f]{40}\z' -and $event.action -ceq 'labeled' -and $event.sender.login -ceq 'NanmiCoder' -and $event.number -eq 1883 -and $event.pull_request.number -eq 1883 -and $event.repository.full_name -ceq 'NanmiCoder/cc-haha' -and $event.pull_request.head.sha -ceq $head -and $event.label.name -ceq ('p1879p-'+$head) -and $event.pull_request.head.repo.full_name -ceq 'toBerlinWay/cc-haha' -and $event.pull_request.head.ref -ceq 'fix/installer-fallback-foreign-helpers' -and $event.pull_request.base.ref -ceq 'main') 'specific_profile_only_label_required'
$stage='D:\a\_temp\cc-haha-1879-p-'+$head+'-52f4ce19-g1'
Require-Bootstrap ($plan.paths.stageBase -ceq $stage -and $plan.paths.privateBootstrapRoot -ceq ($stage+'-bootstrap') -and $plan.paths.stageAInputDirectory -ceq ($stage+'-A') -and $plan.paths.packageDirectory -ceq (Join-Path ($stage+'-bootstrap') 'packet') -and $plan.paths.claimFile -ceq (Join-Path ($stage+'-bootstrap') 'claim.json') -and $plan.stageA -ceq 'D:\a\_temp\cc-haha-1879-profile-only-download\profile-stage-a') 'exact_preparation_paths_required'
# Extract declarations from the reviewed launcher, never dot-source its body.
$launcher=Join-Path $PSScriptRoot 'fixtures\launch-profile-only.proposed.ps1'
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($launcher,[ref]$tokens,[ref]$parseErrors)
Require-Bootstrap (@($parseErrors).Count -eq 0) 'launcher_parse_failed'
foreach($name in @('Require-True','Hash-Bytes','Same-Path','Assert-LocalPath','Assert-OrdinaryPath','Assert-PrivateAcl','File-Hash')){
  $functions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true))
  Require-Bootstrap ($functions.Count -eq 1) 'exact_launcher_function_required'
  . ([ScriptBlock]::Create($functions[0].Extent.Text))
}
Assert-OrdinaryPath $PlanPath $false
Assert-OrdinaryPath $env:GITHUB_EVENT_PATH $false
Assert-OrdinaryPath $plan.stageA $true
$expectedNames=@('launch-profile-only.proposed.ps1','reconcile-profile-only.proposed.ps1','argv-env-plan.json','pins.proposed.json','profile-only-spec.proposed.json','root-admission.proposed.json')
Require-Bootstrap ($plan.files.Count -eq 6 -and @($plan.files.name|Sort-Object -Unique).Count -eq 6) 'exact_packet_files_required'
$decoded=@{}
foreach($file in $plan.files){
  Require-Bootstrap ($expectedNames -ccontains $file.name) 'unexpected_packet_file'
  $bytes=[Convert]::FromBase64String($file.base64)
  Require-Bootstrap ($bytes.Length -gt 0 -and $bytes.Length -le 65536 -and (Hash-Bytes $bytes) -ceq $file.sha256) 'packet_bytes_changed'
  $decoded[$file.name]=$bytes
}
$pins=[Text.Encoding]::UTF8.GetString($decoded['pins.proposed.json'])|ConvertFrom-Json
$spec=[Text.Encoding]::UTF8.GetString($decoded['profile-only-spec.proposed.json'])|ConvertFrom-Json
$admission=[Text.Encoding]::UTF8.GetString($decoded['root-admission.proposed.json'])|ConvertFrom-Json
Require-Bootstrap ((Hash-Bytes $decoded['pins.proposed.json']) -ceq $plan.hashes.pins -and (Hash-Bytes $decoded['profile-only-spec.proposed.json']) -ceq $plan.hashes.spec -and (Hash-Bytes $decoded['root-admission.proposed.json']) -ceq $plan.hashes.admission) 'external_packet_hashes_changed'
$claimBytes=[Convert]::FromBase64String($plan.claimBase64)
$claim=[Text.Encoding]::UTF8.GetString($claimBytes)|ConvertFrom-Json
Require-Bootstrap ($claim.version -eq 1 -and $claim.status -ceq 'first_matching_run_claimed' -and $claim.repository -ceq 'NanmiCoder/cc-haha' -and $claim.head -ceq $head -and $claim.runId.ToString() -ceq $env:GITHUB_RUN_ID -and $claim.runNumber.ToString() -ceq $env:GITHUB_RUN_NUMBER -and $claim.runAttempt -eq 1 -and $claim.workflowId -eq 269753168 -and $claim.displayTitle -ceq ('profile1879-p:'+$head) -and $claim.minimumMatchingRunNumber -eq $claim.runNumber -and $claim.minimumMatchingRunId -eq $claim.runId -and $claim.completePagination -is [bool] -and $claim.completePagination -and $claim.claimantSourceSha256 -ceq $pins.workflow.claimantSourceSha256) 'complete_claim_required'
Require-Bootstrap ($pins.activationHead -ceq $head -and $pins.privateBootstrapRoot -ceq $plan.paths.privateBootstrapRoot -and $pins.stageAInputDirectory -ceq $plan.paths.stageAInputDirectory -and $pins.stageBase -ceq $stage -and $admission.newTriggerLabel -ceq $event.label.name -and $spec.realExecutionAdmitted -is [bool] -and $spec.realExecutionAdmitted) 'packet_preparation_binding_changed'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
try{
  $runnerSid=$identity.User.Value
  Require-Bootstrap ([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'existing_administrative_context_required'
}finally{$identity.Dispose()}
$native=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.StringConstantType -eq [Management.Automation.Language.StringConstantType]::SingleQuotedHereString -and $node.Value.Contains('namespace CcHaha1879ProfileOnlyLaunchV1')},$true))
Require-Bootstrap ($native.Count -eq 1 -and $null -eq ('CcHaha1879ProfileOnlyLaunchV1.Native' -as [type])) 'one_fresh_native_declaration_required'
Add-Type -TypeDefinition $native[0].Value -Language CSharp -ReferencedAssemblies @('System.dll') -ErrorAction Stop
$roots=@()
foreach($directory in @($plan.paths.privateBootstrapRoot,$plan.paths.packageDirectory,$plan.paths.stageAInputDirectory)){
  Assert-OrdinaryPath ([IO.Path]::GetDirectoryName([string]$directory)) $true
  $record=[CcHaha1879ProfileOnlyLaunchV1.Native]::CreateOwnedDirectory($directory,$runnerSid)
  Require-Bootstrap (Same-Path $record.Path $directory) 'created_directory_identity_changed'
  Assert-PrivateAcl (Get-Acl -LiteralPath $directory) $runnerSid $true $true $false
  $roots+=@{path=$record.Path;fileIdentity=$record.Id}
}
function Write-OwnedNew([string]$Path,[byte[]]$Bytes,[bool]$ReadOnly){
  $stream=[IO.FileStream]::new($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
  # Set attributes while the newly created file still has writable inherited
  # rights. Persist owner+DACL exactly once, then verify the actual roundtrip.
  if($ReadOnly){[IO.File]::SetAttributes($Path,[IO.FileAttributes]::ReadOnly)}
  $acl=[Security.AccessControl.FileSecurity]::new()
  $acl.SetAccessRuleProtection($true,$false)
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($runnerSid))
  $rights=if($ReadOnly){[Security.AccessControl.FileSystemRights]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)}else{[Security.AccessControl.FileSystemRights]::FullControl}
  foreach($sid in @($runnerSid,'S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),$rights,[Security.AccessControl.AccessControlType]::Allow))}
  [IO.File]::SetAccessControl($Path,$acl)
  Assert-OrdinaryPath $Path $false
  Assert-PrivateAcl (Get-Acl -LiteralPath $Path) $runnerSid $true $true $ReadOnly
  Require-Bootstrap ((File-Hash $Path) -ceq (Hash-Bytes $Bytes)) 'created_file_hash_changed'
}
Write-OwnedNew $plan.paths.claimFile $claimBytes $false
foreach($name in $expectedNames){Write-OwnedNew (Join-Path $plan.paths.packageDirectory $name) $decoded[$name] $true}
$expectedA=@('profile-fixture.exe','windows-installer-profile-fixture.cs','windows-installer-profile-native.cs','windows-installer-profile-fixture-tests.cs','checks.json','self-test.raw.json','abi-harness.raw.json','profile-only-preflight.raw.json')
Require-Bootstrap ($plan.aInputs.Count -eq 8 -and @($plan.aInputs.file|Sort-Object -Unique).Count -eq 8) 'exact_a_inputs_required'
foreach($inputFile in $plan.aInputs){
  Require-Bootstrap ($expectedA -ccontains $inputFile.file -and $inputFile.bytes -gt 0 -and $inputFile.bytes -le 1048576) 'unexpected_a_input'
  $from=Join-Path $plan.stageA $inputFile.file
  Assert-OrdinaryPath $from $false
  $bytes=[IO.File]::ReadAllBytes($from)
  Require-Bootstrap ($bytes.Length -eq $inputFile.bytes -and (Hash-Bytes $bytes) -ceq $inputFile.sha256) 'downloaded_a_input_changed'
  Write-OwnedNew (Join-Path $plan.paths.stageAInputDirectory $inputFile.file) $bytes $true
}
$receipt=[ordered]@{version=1;status='prepared_no_native_execution';activationHead=$head;actionsRunId=$env:GITHUB_RUN_ID;runnerSid=$runnerSid;planSha256=$ApprovedPlanSha256;claimSha256=(Hash-Bytes $claimBytes);roots=$roots;accountApi='not_run';nativeExecution='not_run';cleanup='not_run'}
Write-OwnedNew (Join-Path $plan.paths.privateBootstrapRoot 'bootstrap-receipt.json') ([Text.UTF8Encoding]::new($false).GetBytes(($receipt|ConvertTo-Json -Depth 8)+"`n")) $false
$receipt|ConvertTo-Json -Depth 8
# Retain these exact evidence roots. Never delete native/controller/account or
# profile state here, including after any partial preparation failure.
