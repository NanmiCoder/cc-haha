# Ordinary CI fixture only. Imports declarations, never either script body.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or $PSVersionTable.PSEdition -cne 'Desktop'){throw 'Windows x64 PowerShell 5.1 Desktop required'}
$report=[ordered]@{version=1;mode='profile-only-bootstrap-preflight';status='failed';engine='WindowsPowerShell5.1-Desktop';checks=@();realAccountsCreated=0;realProfilesCreated=0;releasedPeExecuted=$false;releasedPeMayHaveExecuted=$false;compatibilityEnabled=$false;oldExit22Policy='fatal';cleanup='not_created'}
$root=Join-Path $env:RUNNER_TEMP ('cc1879-bootstrap-fixture-'+[Guid]::NewGuid().ToString('N'))
$rootIdentity=$null;$ownedFiles=@();$held=[Collections.Generic.List[IDisposable]]::new()
function Check([string]$Name,[bool]$Passed){$report.checks+=@{name=$Name;status=$(if($Passed){'passed'}else{'failed'})};if(-not $Passed){throw ('Bootstrap preflight failed: '+$Name)}}
function Import-Function($Ast,[string]$Name){
  $functions=@($Ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $Name},$true))
  if($functions.Count -ne 1){throw 'Expected one reviewed function'}
  # Return source; the caller imports it into this fixture's scope.
  return [ScriptBlock]::Create($functions[0].Extent.Text)
}
try{
  $asts=@{}
  foreach($name in @('bootstrap.ps1','fixtures\launch-profile-only.proposed.ps1')){
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
  foreach($name in @('Require-Bootstrap','Write-OwnedNew')){. (Import-Function $bootstrapAst $name)}
  $native=@($launcherAst.FindAll({param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.StringConstantType -eq [Management.Automation.Language.StringConstantType]::SingleQuotedHereString -and $node.Value.Contains('namespace CcHaha1879ProfileOnlyLaunchV1')},$true))
  Check 'one-bootstrap-native-declaration' ($native.Count -eq 1)
  Add-Type -TypeDefinition $native[0].Value -Language CSharp -ReferencedAssemblies @('System.dll') -ErrorAction Stop
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  try{$runnerSid=$identity.User.Value}finally{$identity.Dispose()}
  $rootIdentity=[CcHaha1879ProfileOnlyLaunchV1.Native]::CreateOwnedDirectory($root,$runnerSid)
  Assert-PrivateAcl (Get-Acl -LiteralPath $root) $runnerSid $true $true $false
  Check 'bootstrap-atomic-owned-root' ($rootIdentity.Path -ceq $root)
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
  $report.status='passed'
}catch{$report.error=$_.Exception.Message}finally{
  foreach($stream in $held){$stream.Dispose()}
  if($null -ne $rootIdentity){
    try{
      $actual=[CcHaha1879ProfileOnlyLaunchV1.Native]::Identity($root,$true)
      if($actual.Id -cne $rootIdentity.Id -or $actual.Path -cne $rootIdentity.Path){throw 'Fixture root identity changed'}
      $children=@(Get-ChildItem -LiteralPath $root -Force)
      if($children.Count -ne $ownedFiles.Count){throw 'Unknown fixture entry; no recursive cleanup'}
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
      [IO.Directory]::Delete($root,$false)
      $report.cleanup='passed'
    }catch{$report.cleanup='failed';$report.status='failed';$report.cleanupError=$_.Exception.Message}
  }
  [IO.File]::WriteAllText($OutputPath,($report|ConvertTo-Json -Depth 8)+"`n",[Text.UTF8Encoding]::new($false))
}
if($report.status -cne 'passed' -or $report.cleanup -cne 'passed'){exit 1}
exit 0
