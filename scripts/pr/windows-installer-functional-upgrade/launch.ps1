# Independent isolated functional regression; never the exhaustive F1 audit.
[CmdletBinding()]
param([switch]$ExecuteFunctionalUpgrade,[string]$ApprovedPinsSha256,[string]$ApprovedSpecSha256,[string]$ApprovedAuthorizationSha256,[string]$ClaimFile)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(-not $ExecuteFunctionalUpgrade){[ordered]@{version=1;status='not_run';accountApi='not_run';nativeExecution='not_run';fullF1='not_proven';exhaustiveAudit='not_run'}|ConvertTo-Json;return}
function Require-Functional([bool]$Value,[string]$Code){if(-not $Value){throw $Code}}
foreach($hash in @($ApprovedPinsSha256,$ApprovedSpecSha256,$ApprovedAuthorizationSha256)){Require-Functional ($hash -cmatch '\A[0-9a-f]{64}\z') 'external_reviewed_packet_hashes_required'}
Require-Functional ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT -and [Environment]::Is64BitProcess -and $PSVersionTable.PSVersion.Major -eq 5 -and $PSVersionTable.PSVersion.Minor -eq 1 -and $PSVersionTable.PSEdition -ceq 'Desktop') 'windows51_x64_required'
$pinsPath=Join-Path $PSScriptRoot 'pins.json';$specPath=Join-Path $PSScriptRoot 'controller-spec.json';$authorizationPath=Join-Path $PSScriptRoot 'functional-authorization.json'
Require-Functional ((Get-FileHash -LiteralPath $pinsPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $ApprovedPinsSha256 -and (Get-FileHash -LiteralPath $specPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $ApprovedSpecSha256 -and (Get-FileHash -LiteralPath $authorizationPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $ApprovedAuthorizationSha256) 'reviewed_functional_packet_changed'
$pins=Get-Content -Raw -LiteralPath $pinsPath -Encoding UTF8|ConvertFrom-Json
$spec=Get-Content -Raw -LiteralPath $specPath -Encoding UTF8|ConvertFrom-Json
$authorization=Get-Content -Raw -LiteralPath $authorizationPath -Encoding UTF8|ConvertFrom-Json
# These text-only gates precede token access, compilation, file writes and Start.
Require-Functional ($pins.version -eq 1 -and $pins.kind -ceq 'functional-upgrade' -and $pins.status -ceq 'new_root_once_claimed' -and $pins.activationHead -cmatch '\A[0-9a-f]{40}\z' -and $pins.specSha256 -ceq $ApprovedSpecSha256 -and $pins.authorizationSha256 -ceq $ApprovedAuthorizationSha256 -and $pins.workflowId -eq 327327938) 'new_functional_once_packet_required'
Require-Functional ($authorization.version -eq 1 -and $authorization.kind -ceq 'isolated-functional-upgrade-once' -and $authorization.status -ceq 'root_admitted_once' -and $authorization.activationHead -ceq $pins.activationHead -and $authorization.candidateSourceHead -ceq $pins.activationHead -and $authorization.candidateTree -ceq $pins.candidateTree -and $authorization.rootPacketSha256 -ceq $pins.rootPacketSha256 -and $authorization.claimSha256 -ceq $pins.claimSha256 -and $authorization.claimantSourceSha256 -ceq $pins.claimantSourceSha256 -and $authorization.completeFirstInvocation -is [bool] -and $authorization.completeFirstInvocation -and $authorization.priorBProfileOrF1AuthorityInherited -is [bool] -and -not $authorization.priorBProfileOrF1AuthorityInherited) 'independent_root_once_authority_required'
Require-Functional ($spec.version -eq 1 -and $spec.mode -ceq 'functional-upgrade-controller' -and $spec.executionStage -ceq 'functional-upgrade' -and $spec.realExecutionAdmitted -is [bool] -and $spec.realExecutionAdmitted -and $null -eq $spec.f1 -and $spec.functional.status -ceq 'admitted-functional' -and $spec.runId -ceq 'a2c7e590-96df-40b1-8943-8e4bcf07a6d2' -and $spec.owner -ceq 'codex:local:01a1c9a5-381e-7b33-9648-c8968b61de4c' -and $spec.generation -eq 1 -and $spec.expectedBinarySha256 -ceq $pins.binarySha256 -and $spec.functional.fixtureBytes -eq $pins.binaryBytes -and $spec.frozenPlanManifestSha256 -ceq $pins.planSha256 -and $spec.argvEnvPlanSha256 -ceq $pins.environmentSha256) 'functional_not_F1_role_required'
Require-Functional ($env:CI -ceq 'true' -and $env:GITHUB_ACTIONS -ceq 'true' -and $env:GITHUB_EVENT_NAME -ceq 'workflow_dispatch' -and $env:GITHUB_REPOSITORY -ceq 'NanmiCoder/cc-haha' -and $env:GITHUB_ACTOR -ceq 'NanmiCoder' -and $env:GITHUB_RUN_ATTEMPT -ceq '1' -and $env:GITHUB_REF -ceq 'refs/heads/fix/issue-1879-functional-validation' -and $env:GITHUB_SHA -ceq $pins.activationHead -and $env:RUNNER_TEMP -ceq 'D:\a\_temp' -and $env:GITHUB_WORKSPACE -ceq 'D:\a\cc-haha\cc-haha') 'exact_functional_actions_context_required'
$event=Get-Content -Raw -LiteralPath $env:GITHUB_EVENT_PATH -Encoding UTF8|ConvertFrom-Json
Require-Functional ($event.inputs.functional_upgrade -ceq 'true' -and $event.inputs.functional_head -ceq $pins.activationHead -and $event.inputs.functional_packet_sha256 -ceq $pins.rootPacketSha256 -and $event.sender.login -ceq 'NanmiCoder' -and $event.repository.full_name -ceq 'NanmiCoder/cc-haha' -and $authorization.actionsRunId.ToString() -ceq $env:GITHUB_RUN_ID -and $authorization.actionsRunNumber.ToString() -ceq $env:GITHUB_RUN_NUMBER) 'functional_dispatch_data_changed'
$stageBase='D:\a\_temp\cc-haha-1879-u-'+$pins.activationHead+'-a2c7e590-g1'
Require-Functional ($pins.stageBase -ceq $stageBase -and $pins.bootstrap -ceq ($stageBase+'-bootstrap') -and $pins.inputDirectory -ceq ($stageBase+'-input') -and $pins.packageDirectory -ceq (Join-Path $pins.bootstrap 'packet') -and $PSScriptRoot -ceq $pins.packageDirectory -and $ClaimFile -ceq (Join-Path $pins.bootstrap 'claim.json') -and $spec.sourceRoot -ceq $pins.inputDirectory -and $spec.controllerRoot -ceq (Join-Path $stageBase 'controller') -and $spec.output -ceq (Join-Path $spec.controllerRoot 'functional-upgrade-report.json') -and $spec.gitRoot -ceq $env:GITHUB_WORKSPACE -and $pins.launcherWaitMilliseconds -eq 1200000) 'exact_functional_paths_budget_required'
$common=Join-Path $PSScriptRoot 'primitives.ps1'
Require-Functional ((Get-FileHash -LiteralPath $common -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $pins.primitivesSha256 -and (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $pins.launcherSha256) 'functional_launcher_primitives_changed'
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($common,[ref]$tokens,[ref]$parseErrors)
Require-Functional (@($parseErrors).Count -eq 0) 'functional_primitives_parse_failed'
foreach($name in @('Require-True','Is-Sha','Hash-Bytes','Same-Path','Inside-Path','Assert-LocalPath','Assert-OrdinaryPath','Assert-PrivateAcl','File-Hash','Read-PacketJson','Lock-HashedFile','Save-AtomicJson','Get-SafeFailure')){
  $functions=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true))
  Require-Functional ($functions.Count -eq 1) 'one_reviewed_functional_primitive_required'
  . ([ScriptBlock]::Create($functions[0].Extent.Text))
}
$held=[Collections.Generic.List[IDisposable]]::new();$savedScratch=@{}
$receipt=$null;$process=$null;$stdout=$null;$stderr=$null;$stage='protected-packet'
try{
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  try{$runnerSid=$identity.User.Value;Require-Functional ([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'existing_admin_context_required'}finally{$identity.Dispose()}
  foreach($directory in @($pins.bootstrap,$pins.packageDirectory,$pins.inputDirectory)){Assert-OrdinaryPath $directory $true;Assert-PrivateAcl (Get-Acl -LiteralPath $directory) $runnerSid $true $true $false}
  foreach($file in @($pinsPath,$specPath,$authorizationPath,$common,$PSCommandPath,(Join-Path $PSScriptRoot 'plan.json'),(Join-Path $PSScriptRoot 'argv-env-plan.json'),(Join-Path $PSScriptRoot 'root-once-packet.json'))){Assert-OrdinaryPath $file $false;Assert-PrivateAcl (Get-Acl -LiteralPath $file) $runnerSid $true $true $true}
  Lock-HashedFile $pinsPath $ApprovedPinsSha256;Lock-HashedFile $specPath $ApprovedSpecSha256;Lock-HashedFile $authorizationPath $ApprovedAuthorizationSha256
  Lock-HashedFile $common $pins.primitivesSha256;Lock-HashedFile $PSCommandPath $pins.launcherSha256
  Lock-HashedFile (Join-Path $PSScriptRoot 'plan.json') $pins.planSha256;Lock-HashedFile (Join-Path $PSScriptRoot 'argv-env-plan.json') $pins.environmentSha256;Lock-HashedFile (Join-Path $PSScriptRoot 'root-once-packet.json') $pins.rootPacketSha256
  Assert-OrdinaryPath $ClaimFile $false;Assert-PrivateAcl (Get-Acl -LiteralPath $ClaimFile) $runnerSid $true $true $false;Lock-HashedFile $ClaimFile $pins.claimSha256
  $claim=Read-PacketJson $ClaimFile
  Require-Functional ($claim.version -eq 1 -and $claim.status -ceq 'first_matching_run_claimed' -and $claim.repository -ceq 'NanmiCoder/cc-haha' -and $claim.head -ceq $pins.activationHead -and $claim.runId.ToString() -ceq $env:GITHUB_RUN_ID -and $claim.runNumber.ToString() -ceq $env:GITHUB_RUN_NUMBER -and $claim.runAttempt -eq 1 -and $claim.workflowId -eq 327327938 -and $claim.displayTitle -ceq ('functional1879-u:'+$pins.activationHead) -and $claim.minimumMatchingRunId -eq $claim.runId -and $claim.minimumMatchingRunNumber -eq $claim.runNumber -and $claim.completePagination -is [bool] -and $claim.completePagination -and $claim.claimantSourceSha256 -ceq $pins.claimantSourceSha256 -and $claim.rootPacketSha256 -ceq $pins.rootPacketSha256) 'complete_protected_first_functional_claim_required'
  $expectedInputs=@('profile-fixture.exe','windows-installer-profile-fixture.cs','windows-installer-profile-native.cs','windows-installer-profile-fixture-tests.cs','old-setup.exe','functional-new-full-setup.exe','functional-old-member-proof.json','functional-build-receipt.json','functional-package-receipt.json','functional-new-member-proof.json','functional-authorization.json','functional-stage-a-receipt.json')
  Require-Functional ($pins.inputs.Count -eq $expectedInputs.Count -and @($pins.inputs.name|Sort-Object -Unique).Count -eq $expectedInputs.Count) 'exact_functional_native_inputs_required'
  foreach($pin in $pins.inputs){
    Require-Functional ($expectedInputs -ccontains $pin.name -and $pin.bytes -gt 0 -and $pin.bytes -le 1073741824) 'invalid_functional_input_pin'
    $path=Join-Path $pins.inputDirectory $pin.name;Assert-PrivateAcl (Get-Acl -LiteralPath $path) $runnerSid $true $true $true;Lock-HashedFile $path $pin.sha256 $pin.bytes
  }
  $stage='trusted-primitives-compiler-only'
  foreach($name in @('TEMP','TMP','TMPDIR')){$savedScratch[$name]=[Environment]::GetEnvironmentVariable($name,'Process');[Environment]::SetEnvironmentVariable($name,[string]$pins.bootstrap,'Process')}
  $native=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.StringConstantType -eq [Management.Automation.Language.StringConstantType]::SingleQuotedHereString -and $node.Value.Contains('namespace CcHaha1879ProfileOnlyLaunchV1')},$true))
  Require-Functional ($native.Count -eq 1 -and $null -eq ('CcHaha1879ProfileOnlyLaunchV1.Native' -as [type])) 'one_fresh_primitives_type_required'
  Add-Type -TypeDefinition $native[0].Value -Language CSharp -ReferencedAssemblies @('System.dll') -ErrorAction Stop
  $stage='atomic-owned-functional-stage'
  Assert-OrdinaryPath ([IO.Path]::GetDirectoryName($stageBase)) $true
  $stageIdentity=[CcHaha1879ProfileOnlyLaunchV1.Native]::CreateOwnedDirectory($stageBase,$runnerSid)
  Require-Functional (Same-Path $stageIdentity.Path $stageBase) 'functional_stage_canonical_changed'
  Assert-PrivateAcl (Get-Acl -LiteralPath $stageBase) $runnerSid $true $true $false
  $runtime=Join-Path $stageBase 'runtime';$controllerHome=Join-Path $runtime 'home';$scratch=Join-Path $runtime 'temp'
  foreach($directory in @($runtime,$controllerHome,(Join-Path $controllerHome 'AppData'),(Join-Path $controllerHome 'AppData\Roaming'),(Join-Path $controllerHome 'AppData\Local'),$scratch)){
    $created=[CcHaha1879ProfileOnlyLaunchV1.Native]::CreateOwnedDirectory($directory,$runnerSid)
    Require-Functional (Same-Path $created.Path $directory) 'functional_runtime_identity_changed'
    Assert-PrivateAcl (Get-Acl -LiteralPath $directory) $runnerSid $true $true $false
  }
  $binary=Join-Path $pins.inputDirectory 'profile-fixture.exe'
  $binaryIdentity=[CcHaha1879ProfileOnlyLaunchV1.Native]::Identity($binary,$false)
  $windows=[CcHaha1879ProfileOnlyLaunchV1.Native]::WindowsDirectory()
  $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$binary;$start.Arguments='--role functional-controller --spec "'+$specPath+'"';$start.WorkingDirectory=$runtime
  $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true;$start.EnvironmentVariables.Clear()
  foreach($name in @('SystemRoot','WINDIR')){$start.EnvironmentVariables[$name]=$windows}
  $start.EnvironmentVariables['SystemDrive']=[IO.Path]::GetPathRoot($windows).TrimEnd('\');$start.EnvironmentVariables['OS']='Windows_NT';$start.EnvironmentVariables['ComSpec']=Join-Path $windows 'System32\cmd.exe'
  $start.EnvironmentVariables['PATH']=$windows+'\System32;'+$windows+';'+$windows+'\System32\Wbem'
  foreach($name in @('HOME','USERPROFILE')){$start.EnvironmentVariables[$name]=$controllerHome}
  $start.EnvironmentVariables['APPDATA']=Join-Path $controllerHome 'AppData\Roaming';$start.EnvironmentVariables['LOCALAPPDATA']=Join-Path $controllerHome 'AppData\Local'
  foreach($name in @('TEMP','TMP','TMPDIR')){$start.EnvironmentVariables[$name]=$scratch}
  $start.EnvironmentVariables['CI']='true'
  foreach($name in @('GITHUB_RUN_ID','GITHUB_RUN_NUMBER','GITHUB_ACTOR','GITHUB_REF','GITHUB_SHA')){$start.EnvironmentVariables[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
  # No token/provider/COMPLUS/COR profiler/NODE_OPTIONS/PSModulePath is inherited.
  $receipt=[ordered]@{version=1;mode='functional-upgrade-launch';status='prepared_no_controller_start';runId=$spec.runId;owner=$spec.owner;generation=1;specSha256=$ApprovedSpecSha256;pinsSha256=$ApprovedPinsSha256;authorizationSha256=$ApprovedAuthorizationSha256;claimSha256=$pins.claimSha256;activationHead=$pins.activationHead;actionsRunId=$env:GITHUB_RUN_ID;runnerSid=$runnerSid;stageBase=$stageBase;stageIdentity=$stageIdentity.Id;binarySha256=$pins.binarySha256;binaryBytes=$pins.binaryBytes;controllerStartAttempted=$false;controllerStarted=$false;controllerMayHaveExecuted=$false;controllerIdentityVerified=$false;controllerPid=$null;controllerBirthFileTime=$null;controllerImage=$null;nativeExitCode=$null;nativeCleanup='not_run';nativeCleanupReported=$null;terminalReportSha256=$null;stdoutComplete=$false;stderrComplete=$false;rawLogOverflow=$false;failedStage=$null;errorInfo=$null;receiptWriteError=$null;member_proven='not_run';installed_bytes_equal='not_run';old22_before_protected_mutation='not_run';removal_equivalence='not_run';full_old_to_new='not_run';fullF1='not_proven';exhaustiveAudit='not_run';retryAllowed=$false}
  $receiptPath=Join-Path $stageBase 'launch-receipt.json';$stage='persist-prepared';Save-AtomicJson $receiptPath $receipt
  $process=[Diagnostics.Process]::new();$process.StartInfo=$start
  $receipt.controllerStartAttempted=$true;$receipt.controllerMayHaveExecuted=$true;$receipt.nativeCleanup='unknown';$receipt.status='controller_start_attempt_in_progress'
  $stage='persist-arm-before-start';Save-AtomicJson $receiptPath $receipt
  $stage='process-start';Require-Functional ($process.Start()) 'controller_start_failed_unknown'
  $stage='close-stdin';$process.StandardInput.Close()
  $stage='bounded-capture-stdout';$stdout=[CcHaha1879ProfileOnlyLaunchV1.RawCapture]::new($process.StandardOutput.BaseStream,(Join-Path $stageBase 'controller.stdout.raw.log'),1048576)
  $stage='bounded-capture-stderr';$stderr=[CcHaha1879ProfileOnlyLaunchV1.RawCapture]::new($process.StandardError.BaseStream,(Join-Path $stageBase 'controller.stderr.raw.log'),1048576)
  $receipt.controllerStarted=$true;$receipt.controllerPid=$process.Id;$stage='capture-held-controller-identity';Save-AtomicJson $receiptPath $receipt
  $actual=[CcHaha1879ProfileOnlyLaunchV1.Native]::Capture($process)
  Require-Functional ($actual.Pid -eq $receipt.controllerPid -and $actual.Sid -ceq $runnerSid -and (Same-Path $actual.Image $binary)) 'held_controller_identity_changed'
  $imageIdentity=[CcHaha1879ProfileOnlyLaunchV1.Native]::Identity($actual.Image,$false)
  Require-Functional ($imageIdentity.Id -ceq $binaryIdentity.Id -and (File-Hash $binary) -ceq $pins.binarySha256) 'held_controller_binary_changed'
  $receipt.controllerIdentityVerified=$true;$receipt.controllerBirthFileTime=$actual.BirthFileTime;$receipt.controllerImage=$actual.Image;Save-AtomicJson $receiptPath $receipt
  $stage='bounded-natural-controller-exit'
  if(-not $process.WaitForExit(1200000)){$receipt.status='timeout_unknown_no_kill_no_retry';Save-AtomicJson $receiptPath $receipt;throw 'controller_timeout_unknown'}
  $receipt.nativeExitCode=$process.ExitCode;$receipt.stdoutComplete=$stdout.Wait(5000);$receipt.stderrComplete=$stderr.Wait(5000);$receipt.rawLogOverflow=$stdout.Overflow -or $stderr.Overflow
  Require-Functional ($receipt.stdoutComplete -and $receipt.stderrComplete -and -not $receipt.rawLogOverflow -and $null -eq $stdout.Failure -and $null -eq $stderr.Failure) 'bounded_output_incomplete'
  $stage='bound-native-functional-terminal';Assert-OrdinaryPath $spec.output $false
  $reportHash=File-Hash $spec.output;Lock-HashedFile $spec.output $reportHash
  Assert-PrivateAcl (Get-Acl -LiteralPath $spec.controllerRoot) $runnerSid $true $false $false;Assert-PrivateAcl (Get-Acl -LiteralPath $spec.output) $runnerSid $false $false $false
  $report=Read-PacketJson $spec.output 1048576;$receipt.nativeCleanupReported=[string]$report.cleanup;$receipt.terminalReportSha256=$reportHash
  Require-Functional ($receipt.nativeExitCode -eq 0 -and $report.version -eq 1 -and $report.mode -ceq 'functional-upgrade' -and $report.status -ceq 'passed' -and $report.cleanup -ceq 'cleaned' -and $report.specSha256 -ceq $ApprovedSpecSha256 -and $report.binarySha256 -ceq $pins.binarySha256 -and $report.realAccountsCreated -eq 1 -and $report.realProfilesCreated -eq 1 -and $report.checks.Count -gt 0 -and @($report.checks|Where-Object{$_.status -cne 'passed'}).Count -eq 0) 'functional_native_failed_or_not_cleaned'
  Require-Functional ($report.functionalFacts.status -ceq 'passed' -and $report.functionalFacts.scope -ceq 'isolated-v078-first-upgrade' -and $report.functionalFacts.ownedCleanupKnown -is [bool] -and $report.functionalFacts.ownedCleanupKnown -and $report.functionalFacts.exhaustiveAudit -ceq 'not_run' -and $report.compatibilityEnabled -is [bool] -and -not $report.compatibilityEnabled -and $report.oldExit22Policy -ceq 'fatal') 'functional_not_exhaustive_result_required'
  foreach($name in @('member_proven','installed_bytes_equal','old22_before_protected_mutation','removal_equivalence','full_old_to_new')){Require-Functional ($report.$name -ceq 'not_run') 'old_F1_overclaim'}
  Require-Functional ((File-Hash $binary) -ceq $pins.binarySha256) 'postrun_fixture_changed'
  $receipt.nativeCleanup='cleaned';$receipt.status='functional_passed_and_cleaned_no_exhaustive_F1';Save-AtomicJson $receiptPath $receipt
  $receipt|ConvertTo-Json -Depth 12
}catch{
  $safeFailure=Get-SafeFailure $_
  if($null -ne $receipt){$receipt.status='failed_unknown_no_retry';$receipt.nativeCleanup='unknown';$receipt.failedStage=$stage;$receipt.errorInfo=$safeFailure;try{Save-AtomicJson $receiptPath $receipt}catch{$receipt.receiptWriteError=Get-SafeFailure $_};$receipt|ConvertTo-Json -Depth 12}
  else{[ordered]@{version=1;status='stopped_before_start';stage=$stage;nativeExecution='not_run';cleanup='not_run';errorInfo=$safeFailure}|ConvertTo-Json -Depth 6}
  exit 1
}finally{
  if($null -ne $process){$process.Dispose()}
  foreach($stream in $held){$stream.Dispose()}
  foreach($name in $savedScratch.Keys){[Environment]::SetEnvironmentVariable($name,$savedScratch[$name],'Process')}
  # Never kill a timed-out Controller or infer cleanup from its absence. Native
  # owns its fresh SID/profile/Job ledger; missing/failed reports remain unknown.
}
exit 0
