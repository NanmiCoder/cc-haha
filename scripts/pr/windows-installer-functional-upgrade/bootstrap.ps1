# Preparation only. No Native fixture, account/Profile or product process.
[CmdletBinding()]
param([switch]$PrepareFunctionalUpgrade,[string]$PlanPath,[string]$ApprovedPlanSha256)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(-not $PrepareFunctionalUpgrade){[ordered]@{version=1;status='not_run';accountApi='not_run';nativeExecution='not_run'}|ConvertTo-Json;return}
function Require-Functional([bool]$Value,[string]$Code){if(-not $Value){throw $Code}}
Require-Functional ($ApprovedPlanSha256 -cmatch '\A[0-9a-f]{64}\z') 'exact_preparation_hash_required'
$item=Get-Item -LiteralPath $PlanPath -Force
Require-Functional (-not $item.PSIsContainer -and $item.Length -gt 0 -and $item.Length -le 1048576 -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and (Get-FileHash -LiteralPath $PlanPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $ApprovedPlanSha256) 'bounded_exact_preparation_required'
$plan=Get-Content -Raw -LiteralPath $PlanPath -Encoding UTF8|ConvertFrom-Json
Require-Functional ($plan.version -eq 1 -and $plan.kind -ceq 'functional-bootstrap' -and $env:CI -ceq 'true' -and $env:GITHUB_ACTIONS -ceq 'true' -and $env:GITHUB_EVENT_NAME -ceq 'workflow_dispatch' -and $env:GITHUB_ACTOR -ceq 'NanmiCoder' -and $env:GITHUB_REPOSITORY -ceq 'NanmiCoder/cc-haha' -and $env:GITHUB_RUN_ATTEMPT -ceq '1') 'explicit_functional_dispatch_required'
Require-Functional ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT -and [Environment]::Is64BitProcess -and $PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -eq 1 -and $PSVersionTable.PSEdition -ceq 'Desktop') 'windows51_x64_required'
Require-Functional ($env:RUNNER_TEMP -ceq 'D:\a\_temp' -and $env:GITHUB_WORKSPACE -ceq 'D:\a\cc-haha\cc-haha' -and $env:GITHUB_REF -ceq 'refs/heads/fix/issue-1879-functional-validation') 'exact_disposable_runner_ref_required'
$event=Get-Content -Raw -LiteralPath $env:GITHUB_EVENT_PATH -Encoding UTF8|ConvertFrom-Json
$head=[string]$plan.invocation.head
Require-Functional ($head -cmatch '\A[0-9a-f]{40}\z' -and $env:GITHUB_SHA -ceq $head -and $event.inputs.functional_upgrade -ceq 'true' -and $event.inputs.functional_head -ceq $head -and $event.sender.login -ceq 'NanmiCoder' -and $event.repository.full_name -ceq 'NanmiCoder/cc-haha') 'specific_functional_dispatch_required'
$stage='D:\a\_temp\cc-haha-1879-u-'+$head+'-a2c7e590-g1'
Require-Functional ($plan.paths.stageBase -ceq $stage -and $plan.paths.bootstrap -ceq ($stage+'-bootstrap') -and $plan.paths.inputDirectory -ceq ($stage+'-input') -and $plan.paths.packageDirectory -ceq (Join-Path ($stage+'-bootstrap') 'packet') -and $plan.paths.claimFile -ceq (Join-Path ($stage+'-bootstrap') 'claim.json')) 'exact_owned_functional_paths_required'
$names=@('launch.ps1','primitives.ps1','plan.json','argv-env-plan.json','root-once-packet.json','controller-spec.json','functional-authorization.json','functional-stage-a-receipt.json','pins.json')
Require-Functional ($plan.files.Count -eq $names.Count -and @($plan.files.name|Sort-Object -Unique).Count -eq $names.Count) 'exact_functional_packet_files_required'
$decoded=@{}
foreach($file in $plan.files){
  Require-Functional ($names -ccontains $file.name -and $file.sha256 -cmatch '\A[0-9a-f]{64}\z') 'unknown_functional_packet_file'
  $bytes=[Convert]::FromBase64String($file.base64)
  Require-Functional ($bytes.Length -gt 0 -and $bytes.Length -le 131072) 'bounded_functional_packet_file_required'
  $sha=[Security.Cryptography.SHA256]::Create()
  try{$hash=([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
  Require-Functional ($hash -ceq $file.sha256) 'functional_packet_bytes_changed'
  $decoded[$file.name]=$bytes
}
$pins=[Text.Encoding]::UTF8.GetString($decoded['pins.json'])|ConvertFrom-Json
Require-Functional ($pins.kind -ceq 'functional-upgrade' -and $pins.status -ceq 'new_root_once_claimed' -and $pins.activationHead -ceq $head -and $pins.rootPacketSha256 -ceq $event.inputs.functional_packet_sha256 -and $pins.workflowId -eq 327327938) 'independent_functional_admission_required'
# Extract only reviewed declarations. Never evaluate the old launcher's body,
# historical/profile grants, role validation or any reconciliation action.
$common=Join-Path $env:GITHUB_WORKSPACE 'scripts\pr\windows-installer-profile-only\fixtures\launch-profile-only.proposed.ps1'
$commonBytes=[Text.UTF8Encoding]::new($false,$true).GetBytes(([IO.File]::ReadAllText($common)).Replace("`r`n","`n"))
Require-Functional ([Convert]::ToBase64String($commonBytes) -ceq [Convert]::ToBase64String($decoded['primitives.ps1'])) 'reviewed_primitives_source_changed'
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString($commonBytes),[ref]$tokens,[ref]$parseErrors)
Require-Functional (@($parseErrors).Count -eq 0) 'reviewed_primitives_parse_failed'
foreach($name in @('Require-True','Hash-Bytes','Same-Path','Assert-LocalPath','Assert-OrdinaryPath','Assert-PrivateAcl','File-Hash')){
  $functions=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true))
  Require-Functional ($functions.Count -eq 1) 'one_reviewed_primitive_required'
  . ([ScriptBlock]::Create($functions[0].Extent.Text))
}
Assert-OrdinaryPath $PlanPath $false
Assert-OrdinaryPath $env:GITHUB_EVENT_PATH $false
Assert-OrdinaryPath $common $false
Require-Functional ((Hash-Bytes $decoded['pins.json']) -ceq $plan.hashes.pins -and (Hash-Bytes $decoded['controller-spec.json']) -ceq $plan.hashes.spec -and (Hash-Bytes $decoded['functional-authorization.json']) -ceq $plan.hashes.authorization -and (Hash-Bytes $commonBytes) -ceq $pins.primitivesSha256 -and (Hash-Bytes $decoded['launch.ps1']) -ceq $pins.launcherSha256) 'functional_frozen_hash_binding_changed'
$claimBytes=[Convert]::FromBase64String($plan.claimBase64)
Require-Functional ($claimBytes.Length -gt 0 -and $claimBytes.Length -le 65536 -and (Hash-Bytes $claimBytes) -ceq $pins.claimSha256) 'bounded_independent_claim_required'
$claim=[Text.Encoding]::UTF8.GetString($claimBytes)|ConvertFrom-Json
Require-Functional ($claim.version -eq 1 -and $claim.status -ceq 'first_matching_run_claimed' -and $claim.repository -ceq 'NanmiCoder/cc-haha' -and $claim.head -ceq $head -and $claim.runId.ToString() -ceq $env:GITHUB_RUN_ID -and $claim.runNumber.ToString() -ceq $env:GITHUB_RUN_NUMBER -and $claim.runAttempt -eq 1 -and $claim.workflowId -eq 327327938 -and $claim.displayTitle -ceq ('functional1879-u:'+$head) -and $claim.minimumMatchingRunId -eq $claim.runId -and $claim.minimumMatchingRunNumber -eq $claim.runNumber -and $claim.completePagination -is [bool] -and $claim.completePagination -and $claim.claimantSourceSha256 -ceq $pins.claimantSourceSha256 -and $claim.rootPacketSha256 -ceq $pins.rootPacketSha256) 'complete_first_functional_claim_required'
$spec=[Text.Encoding]::UTF8.GetString($decoded['controller-spec.json'])|ConvertFrom-Json
$authorization=[Text.Encoding]::UTF8.GetString($decoded['functional-authorization.json'])|ConvertFrom-Json
Require-Functional ($spec.mode -ceq 'functional-upgrade-controller' -and $spec.executionStage -ceq 'functional-upgrade' -and $spec.realExecutionAdmitted -is [bool] -and $spec.realExecutionAdmitted -and $null -eq $spec.f1 -and $spec.functional.status -ceq 'admitted-functional' -and $authorization.status -ceq 'root_admitted_once' -and $authorization.runId -ceq 'a2c7e590-96df-40b1-8943-8e4bcf07a6d2' -and $authorization.actionsRunId -eq $claim.runId -and $authorization.claimSha256 -ceq $pins.claimSha256 -and $authorization.completeFirstInvocation -is [bool] -and $authorization.completeFirstInvocation) 'functional_not_F1_admission_required'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
try{$runnerSid=$identity.User.Value;Require-Functional ([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'existing_admin_context_required'}finally{$identity.Dispose()}
$native=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.StringConstantType -eq [Management.Automation.Language.StringConstantType]::SingleQuotedHereString -and $node.Value.Contains('namespace CcHaha1879ProfileOnlyLaunchV1')},$true))
Require-Functional ($native.Count -eq 1 -and $null -eq ('CcHaha1879ProfileOnlyLaunchV1.Native' -as [type])) 'one_fresh_primitives_declaration_required'
Add-Type -TypeDefinition $native[0].Value -Language CSharp -ReferencedAssemblies @('System.dll') -ErrorAction Stop
function Protect-OwnedFile([string]$Path,[bool]$ReadOnly){
  if($ReadOnly){[IO.File]::SetAttributes($Path,[IO.FileAttributes]::ReadOnly)}
  $acl=[Security.AccessControl.FileSecurity]::new();$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner([Security.Principal.SecurityIdentifier]::new($runnerSid))
  $rights=if($ReadOnly){[Security.AccessControl.FileSystemRights]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)}else{[Security.AccessControl.FileSystemRights]::FullControl}
  foreach($sid in @($runnerSid,'S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),$rights,[Security.AccessControl.AccessControlType]::Allow))}
  [IO.File]::SetAccessControl($Path,$acl);Assert-OrdinaryPath $Path $false;Assert-PrivateAcl (Get-Acl -LiteralPath $Path) $runnerSid $true $true $ReadOnly
}
function Write-OwnedFile([string]$Path,[byte[]]$Bytes,[bool]$ReadOnly){
  $stream=[IO.FileStream]::new($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
  Protect-OwnedFile $Path $ReadOnly
  Require-Functional ((File-Hash $Path) -ceq (Hash-Bytes $Bytes)) 'new_owned_file_changed'
}
$roots=@()
foreach($directory in @($plan.paths.bootstrap,$plan.paths.packageDirectory,$plan.paths.inputDirectory)){
  Assert-OrdinaryPath ([IO.Path]::GetDirectoryName([string]$directory)) $true
  $record=[CcHaha1879ProfileOnlyLaunchV1.Native]::CreateOwnedDirectory($directory,$runnerSid)
  Require-Functional (Same-Path $record.Path $directory) 'atomic_owned_directory_identity_changed'
  Assert-PrivateAcl (Get-Acl -LiteralPath $directory) $runnerSid $true $true $false
  $roots+=@{path=$record.Path;fileIdentity=$record.Id}
}
Write-OwnedFile $plan.paths.claimFile $claimBytes $false
foreach($name in $names){Write-OwnedFile (Join-Path $plan.paths.packageDirectory $name) $decoded[$name] $true}
$expectedInputs=@('profile-fixture.exe','windows-installer-profile-fixture.cs','windows-installer-profile-native.cs','windows-installer-profile-fixture-tests.cs','old-setup.exe','functional-new-full-setup.exe','functional-old-member-proof.json','functional-build-receipt.json','functional-package-receipt.json','functional-new-member-proof.json','functional-authorization.json','functional-stage-a-receipt.json')
Require-Functional ($plan.inputs.Count -eq $expectedInputs.Count -and $pins.inputs.Count -eq $expectedInputs.Count -and @($plan.inputs.name|Sort-Object -Unique).Count -eq $expectedInputs.Count) 'exact_functional_input_set_required'
$download='D:\a\_temp\cc-haha-1879-functional-download'
foreach($inputFile in $plan.inputs){
  Require-Functional ($expectedInputs -ccontains $inputFile.name -and $inputFile.bytes -gt 0 -and $inputFile.sha256 -cmatch '\A[0-9a-f]{64}\z') 'unknown_functional_input'
  $pin=@($pins.inputs|Where-Object{$_.name -ceq $inputFile.name})
  Require-Functional ($pin.Count -eq 1 -and $pin[0].bytes -eq $inputFile.bytes -and $pin[0].sha256 -ceq $inputFile.sha256) 'functional_copy_pin_changed'
  $expectedFrom=switch -Exact ($inputFile.name){
    'old-setup.exe'{Join-Path $download 'old\Claude-Code-Haha-0.7.8-Windows-x64-Setup.exe'}
    'functional-new-full-setup.exe'{Join-Path $download 'new\Claude-Code-Haha-0.7.8-Windows-x64-Setup.exe'}
    'functional-old-member-proof.json'{Join-Path $download 'A\member-proof\historical\member-proof.json'}
    'functional-build-receipt.json'{Join-Path $download 'new\candidate-package-receipt.json'}
    'functional-package-receipt.json'{Join-Path $download 'new\candidate-package-receipt.json'}
    'functional-new-member-proof.json'{Join-Path $download 'new\setup-member\member-proof.json'}
    'functional-authorization.json'{Join-Path $plan.paths.packageDirectory 'functional-authorization.json'}
    'functional-stage-a-receipt.json'{Join-Path $plan.paths.packageDirectory 'functional-stage-a-receipt.json'}
    default{Join-Path $download ('A\profile-stage-a\'+$inputFile.name)}
  }
  Require-Functional ($inputFile.from -ceq $expectedFrom) 'exact_functional_copy_source_required'
  Assert-OrdinaryPath $inputFile.from $false
  $maximum=if($inputFile.name -ceq 'old-setup.exe' -or $inputFile.name -ceq 'functional-new-full-setup.exe'){1073741824}else{1048576}
  Require-Functional ($inputFile.bytes -le $maximum) 'functional_input_size_bound'
  $source=[IO.FileStream]::new($inputFile.from,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try{
    Require-Functional ($source.Length -eq $inputFile.bytes) 'functional_input_length_changed'
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$hash=([BitConverter]::ToString($sha.ComputeHash($source))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
    Require-Functional ($hash -ceq $inputFile.sha256) 'functional_input_hash_changed';$source.Position=0
    $destination=Join-Path $plan.paths.inputDirectory $inputFile.name
    $target=[IO.FileStream]::new($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$source.CopyTo($target);$target.Flush($true)}finally{$target.Dispose()}
  }finally{$source.Dispose()}
  Protect-OwnedFile $destination $true
  Require-Functional ((File-Hash $destination) -ceq $inputFile.sha256 -and (Get-Item -LiteralPath $destination).Length -eq $inputFile.bytes) 'functional_protected_copy_changed'
}
$receipt=[ordered]@{version=1;status='prepared_no_native_execution';activationHead=$head;actionsRunId=$env:GITHUB_RUN_ID;runnerSid=$runnerSid;planSha256=$ApprovedPlanSha256;claimSha256=(Hash-Bytes $claimBytes);roots=$roots;accountApi='not_run';nativeExecution='not_run';cleanup='not_run'}
Write-OwnedFile (Join-Path $plan.paths.bootstrap 'bootstrap-receipt.json') ([Text.UTF8Encoding]::new($false).GetBytes(($receipt|ConvertTo-Json -Depth 8)+"`n")) $false
$receipt|ConvertTo-Json -Depth 8
# Partial roots and unknown native/account state are never removed here.
