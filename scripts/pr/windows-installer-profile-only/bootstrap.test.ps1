# Ordinary CI fixture only. Imports declarations, never either script body.
[CmdletBinding()]
param([string]$OutputPath,[switch]$StartupProbeOnly)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($StartupProbeOnly){
  # .NET-only diagnostics precede the first module command, so a failed
  # lookup still leaves actual engine context without dumping user paths.
  [Console]::WriteLine('CC1879_PSHOME='+$PSHOME)
  [Console]::WriteLine('CC1879_OWN_SYSTEM_MODULES='+[IO.Path]::Combine($PSHOME,'Modules'))
}
# Keep this the first module command in the fresh Bun -> 5.1 process. Loading
# Add-Type/ConvertFrom-Json first could hide a broken Utility discovery path.
$startupHash=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or $PSVersionTable.PSEdition -cne 'Desktop'){throw 'Windows x64 PowerShell 5.1 Desktop required'}
if($StartupProbeOnly){
  $moduleRoot=[IO.Path]::Combine($PSHOME,'Modules')
  $commands=@()
  foreach($name in @('Get-FileHash','Get-Item','Get-Content','ConvertFrom-Json','Get-Acl','Join-Path','Sort-Object','Add-Type')){
    $command=Get-Command $name -ErrorAction Stop
    $path=[string]$command.Module.Path
    if(-not $path.StartsWith($PSHOME+'\',[StringComparison]::OrdinalIgnoreCase)){throw ('Non-system module source for '+$name)}
    $commands+=@{name=$name;source=$command.Source;modulePath=$path;commandType=$command.CommandType.ToString()}
  }
  $safePaths=@();$otherPaths=0
  foreach($path in $env:PSModulePath.Split(';')){
    if([string]::Equals($path,$moduleRoot,[StringComparison]::OrdinalIgnoreCase)){$safePaths+=$path}else{$otherPaths++}
  }
  if($safePaths.Count -ne 1){throw 'Own system module path was not bound exactly once'}
  $probe=[ordered]@{version=1;status='passed';engine='WindowsPowerShell5.1-Desktop';psHome=$PSHOME;ownSystemModuleRoot=$moduleRoot;safeModulePaths=$safePaths;otherModulePathEntriesRedacted=$otherPaths;startupFileSha256=$startupHash;commands=$commands}
  [Console]::WriteLine('CC1879_PROBE_JSON='+($probe|ConvertTo-Json -Depth 6 -Compress))
  exit 0
}
if(-not $OutputPath){throw 'Ordinary fixture output path required'}
$report=[ordered]@{version=1;mode='profile-only-bootstrap-preflight';status='failed';engine='WindowsPowerShell5.1-Desktop';checks=@();realAccountsCreated=0;realProfilesCreated=0;releasedPeExecuted=$false;releasedPeMayHaveExecuted=$false;compatibilityEnabled=$false;oldExit22Policy='fatal';cleanup='not_created'}
$root=Join-Path $env:RUNNER_TEMP ('cc1879-bootstrap-fixture-'+[Guid]::NewGuid().ToString('N'))
$rootIdentity=$null;$ownedFiles=@();$ownedDirectories=@();$held=[Collections.Generic.List[IDisposable]]::new()
function Check([string]$Name,[bool]$Passed){$report.checks+=@{name=$Name;status=$(if($Passed){'passed'}else{'failed'})};if(-not $Passed){throw ('Bootstrap preflight failed: '+$Name)}}
function Import-Function($Ast,[string]$Name){
  $functions=@($Ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $Name},$true))
  if($functions.Count -ne 1){throw 'Expected one reviewed function'}
  # Return source; the caller imports it into this fixture's scope.
  return [ScriptBlock]::Create($functions[0].Extent.Text)
}
try{
  Check 'startup-first-get-filehash' ($startupHash -cmatch '\A[0-9a-f]{64}\z')
  $asts=@{}
  foreach($name in @('bootstrap.ps1','fixtures\launch-profile-only.proposed.ps1','fixtures\reconcile-profile-only.proposed.ps1')){
    $tokens=$null;$errors=$null
    $asts[$name]=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name),[ref]$tokens,[ref]$errors)
    Check ('parse-'+$name) (@($errors).Count -eq 0)
  }
  $bootstrapAst=$asts['bootstrap.ps1'];$launcherAst=$asts['fixtures\launch-profile-only.proposed.ps1']
  # The actual default entry point returns before plan reads, writes or Add-Type.
  $default=& (Join-Path $PSScriptRoot 'bootstrap.ps1')|ConvertFrom-Json
  Check 'bootstrap-default-not-run' ($default.status -ceq 'not_run' -and $default.accountApi -ceq 'not_run' -and $default.nativeExecution -ceq 'not_run')
  $denied=$false
  try{& (Join-Path $PSScriptRoot 'bootstrap.ps1') -PrepareReviewedProfileOnly|Out-Null}catch{$denied=$true}
  Check 'bootstrap-missing-plan-denied' $denied
  foreach($name in @('Require-True','Is-Sha','Hash-Bytes','Same-Path','Assert-LocalPath','Assert-OrdinaryPath','Assert-PrivateAcl','File-Hash','Lock-HashedFile','Copy-ReadonlyInput')){. (Import-Function $launcherAst $name)}
  foreach($name in @('Require-Bootstrap','Write-OwnedNew','Prepare-OwnedBootstrapFiles')){. (Import-Function $bootstrapAst $name)}
  $native=@($launcherAst.FindAll({param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.StringConstantType -eq [Management.Automation.Language.StringConstantType]::SingleQuotedHereString -and $node.Value.Contains('namespace CcHaha1879ProfileOnlyLaunchV1')},$true))
  Check 'one-bootstrap-native-declaration' ($native.Count -eq 1)
  Add-Type -TypeDefinition $native[0].Value -Language CSharp -ReferencedAssemblies @('System.dll') -ErrorAction Stop
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  try{$runnerSid=$identity.User.Value}finally{$identity.Dispose()}
  $rootIdentity=[CcHaha1879ProfileOnlyLaunchV1.Native]::CreateOwnedDirectory($root,$runnerSid)
  Assert-PrivateAcl (Get-Acl -LiteralPath $root) $runnerSid $true $true $false
  Check 'bootstrap-atomic-owned-root' ($rootIdentity.Path -ceq $root)
  # Run the actual receipt writers, not a fixture reimplementation. These
  # JSONs cannot satisfy a live claim or launch receipt contract.
  foreach($name in @('launch-profile-only.proposed.ps1','reconcile-profile-only.proposed.ps1')){
    $receiptAst=$asts['fixtures\'+$name]
    foreach($function in @('Save-AtomicJson','Get-SafeFailure')){. (Import-Function $receiptAst $function)}
    $atomicPath=Join-Path $root ($name+'.fixture-receipt.json')
    $fixtureReceipt=[ordered]@{fixture='unadmitted-no-native';status='prepared';errorInfo=$null}
    Save-AtomicJson $atomicPath $fixtureReceipt
    Check ('receipt-create-'+$name) ((Get-Content -Raw -LiteralPath $atomicPath|ConvertFrom-Json).status -ceq 'prepared')
    $fixtureReceipt.status='armed-fixture-only'
    Save-AtomicJson $atomicPath $fixtureReceipt
    Check ('receipt-replace-'+$name) ((Get-Content -Raw -LiteralPath $atomicPath|ConvertFrom-Json).status -ceq 'armed-fixture-only')
    try{throw [InvalidOperationException]::new('CC1879_FAKE_SECRET_DO_NOT_EMIT')}catch{
      $fixtureReceipt.status='failed-fixture-only';$fixtureReceipt.errorInfo=Get-SafeFailure $_
      Save-AtomicJson $atomicPath $fixtureReceipt
    }
    $text=[IO.File]::ReadAllText($atomicPath);$saved=$text|ConvertFrom-Json
    Check ('receipt-catch-save-'+$name) ($saved.status -ceq 'failed-fixture-only')
    Check ('receipt-safe-error-'+$name) (-not $text.Contains('CC1879_FAKE_SECRET_DO_NOT_EMIT') -and $saved.errorInfo.type -is [string] -and ($saved.errorInfo.hResult -is [int] -or $saved.errorInfo.hResult -is [long]) -and $saved.errorInfo.sourceLine -gt 0 -and ((@($saved.errorInfo.PSObject.Properties.Name|Sort-Object) -join '|') -ceq 'hResult|innerHResult|innerType|sourceLine|type'))
    $ownedFiles+=@{path=$atomicPath;hash=(File-Hash $atomicPath)}
  }
  $claimPath=Join-Path $root 'claim.json';$inputPath=Join-Path $root 'input.txt'
  $claimBytes=[Text.Encoding]::UTF8.GetBytes('{"fixture":"complete-claim-bytes-preserved"}')
  Write-OwnedNew $claimPath $claimBytes $false
  $ownedFiles+=@{path=$claimPath;hash=(Hash-Bytes $claimBytes)}
  Assert-PrivateAcl (Get-Acl -LiteralPath $claimPath) $runnerSid $true $true $false
  Check 'bootstrap-create-new-protected-claim' ((File-Hash $claimPath) -ceq (Hash-Bytes $claimBytes))
  $inputBytes=[Text.Encoding]::UTF8.GetBytes('fixture input only, never a PE')
  Write-OwnedNew $inputPath $inputBytes $true
  $ownedFiles+=@{path=$inputPath;hash=(Hash-Bytes $inputBytes)}
  Assert-PrivateAcl (Get-Acl -LiteralPath $inputPath) $runnerSid $true $true $true
  Check 'bootstrap-readonly-input-roundtrip' (((Get-Item -LiteralPath $inputPath -Force).Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0)
  $copyPath=Join-Path $root 'copy.txt'
  Copy-ReadonlyInput $inputPath $copyPath (Hash-Bytes $inputBytes) $inputBytes.Length
  $ownedFiles+=@{path=$copyPath;hash=(Hash-Bytes $inputBytes)}
  Assert-PrivateAcl (Get-Acl -LiteralPath $copyPath) $runnerSid $true $true $true
  Check 'launcher-copy-readonly-input-roundtrip' ((File-Hash $copyPath) -ceq (Hash-Bytes $inputBytes))
  $rejected=$false
  try{Write-OwnedNew $claimPath ([Text.Encoding]::UTF8.GetBytes('overwrite forbidden')) $false}catch{$rejected=$true}
  Check 'bootstrap-existing-claim-rejected' ($rejected -and (File-Hash $claimPath) -ceq (Hash-Bytes $claimBytes))
  # Exercise the complete shared filesystem producer with explicitly
  # unadmitted fixture data. No live claim or Actions event is fabricated.
  $sourceRoot=Join-Path $root 'fixture-source'
  $created=[CcHaha1879ProfileOnlyLaunchV1.Native]::CreateOwnedDirectory($sourceRoot,$runnerSid)
  $ownedDirectories+=@{path=$created.Path;id=$created.Id}
  $names=@('launch-profile-only.proposed.ps1','reconcile-profile-only.proposed.ps1','argv-env-plan.json','pins.proposed.json','profile-only-spec.proposed.json','root-admission.proposed.json')
  $decoded=@{}
  foreach($name in $names){$decoded[$name]=[IO.File]::ReadAllBytes((Join-Path (Join-Path $PSScriptRoot 'fixtures') $name))}
  $aInputs=@()
  foreach($name in @('profile-fixture.exe','windows-installer-profile-fixture.cs','windows-installer-profile-native.cs','windows-installer-profile-fixture-tests.cs','checks.json','self-test.raw.json','abi-harness.raw.json','profile-only-preflight.raw.json')){
    $bytes=[Text.Encoding]::UTF8.GetBytes('unadmitted text fixture only; never an executable: '+$name)
    Write-OwnedNew (Join-Path $sourceRoot $name) $bytes $false
    $ownedFiles+=@{path=(Join-Path $sourceRoot $name);hash=(Hash-Bytes $bytes)}
    $aInputs+=@{file=$name;bytes=$bytes.Length;sha256=(Hash-Bytes $bytes)}
  }
  $fixtureBootstrap=Join-Path $root 'fixture-bootstrap';$fixtureA=Join-Path $root 'fixture-A'
  $fixturePlan=[pscustomobject]@{invocation=@{head='unadmitted-fixture'};stageA=$sourceRoot;aInputs=$aInputs;paths=@{privateBootstrapRoot=$fixtureBootstrap;packageDirectory=(Join-Path $fixtureBootstrap 'packet');stageAInputDirectory=$fixtureA;claimFile=(Join-Path $fixtureBootstrap 'claim.json')}}
  $fixtureClaim=[Text.Encoding]::UTF8.GetBytes('{"fixture":"not-a-live-claim; no admission"}')
  $prepared=Prepare-OwnedBootstrapFiles $fixturePlan $decoded $fixtureClaim $runnerSid $names ('0'*64)
  foreach($record in $prepared.roots){$ownedDirectories+=@{path=$record.path;id=$record.fileIdentity}}
  foreach($path in @($fixturePlan.paths.claimFile,(Join-Path $fixtureBootstrap 'bootstrap-receipt.json'))){$ownedFiles+=@{path=$path;hash=(File-Hash $path)}}
  foreach($name in $names){$ownedFiles+=@{path=(Join-Path $fixturePlan.paths.packageDirectory $name);hash=(Hash-Bytes $decoded[$name])}}
  foreach($inputFile in $aInputs){$ownedFiles+=@{path=(Join-Path $fixtureA $inputFile.file);hash=$inputFile.sha256}}
  Check 'bootstrap-complete-filesystem-producer-unadmitted' ($prepared.status -ceq 'prepared_no_native_execution' -and $prepared.roots.Count -eq 3 -and $prepared.accountApi -ceq 'not_run' -and $prepared.nativeExecution -ceq 'not_run' -and (File-Hash $fixturePlan.paths.claimFile) -ceq (Hash-Bytes $fixtureClaim))
  $report.status='passed'
}catch{$report.error=$_.Exception.Message}finally{
  foreach($stream in $held){$stream.Dispose()}
  if($null -ne $rootIdentity){
    try{
      $actual=[CcHaha1879ProfileOnlyLaunchV1.Native]::Identity($root,$true)
      if($actual.Id -cne $rootIdentity.Id -or $actual.Path -cne $rootIdentity.Path){throw 'Fixture root identity changed'}
      $children=@(Get-ChildItem -LiteralPath $root -Force -Recurse)
      if($children.Count -ne ($ownedFiles.Count+$ownedDirectories.Count)){throw 'Unknown fixture entry; no recursive cleanup'}
      foreach($directory in $ownedDirectories){
        $actual=[CcHaha1879ProfileOnlyLaunchV1.Native]::Identity($directory.path,$true)
        if($actual.Id -cne $directory.id -or $actual.Path -cne $directory.path){throw 'Fixture child directory identity changed'}
      }
      foreach($file in $ownedFiles){
        Assert-OrdinaryPath $file.path $false
        if((File-Hash $file.path) -cne $file.hash){throw 'Fixture bytes changed; no cleanup'}
        # Owner retains WRITE_DAC. Restore only DACL, never try to persist the
        # owner again after the readonly case has dropped WRITE_OWNER.
        $acl=[Security.AccessControl.FileSecurity]::new();$acl.SetAccessRuleProtection($true,$false)
        foreach($sid in @($runnerSid,'S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))}
        [IO.File]::SetAccessControl($file.path,$acl)
        [IO.File]::SetAttributes($file.path,[IO.FileAttributes]::Normal)
        [IO.File]::Delete($file.path)
      }
      foreach($directory in @($ownedDirectories|Sort-Object { $_.path.Length } -Descending)){[IO.Directory]::Delete($directory.path,$false)}
      [IO.Directory]::Delete($root,$false)
      $report.cleanup='passed'
    }catch{$report.cleanup='failed';$report.status='failed';$report.cleanupError=$_.Exception.Message}
  }
  [IO.File]::WriteAllText($OutputPath,($report|ConvertTo-Json -Depth 8)+"`n",[Text.UTF8Encoding]::new($false))
}
if($report.status -cne 'passed' -or $report.cleanup -cne 'passed'){exit 1}
exit 0
