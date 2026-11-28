# Stage A only. The frozen packet stays unadmitted. Never call an account,
# Profile, process-reconciliation, Subject or installer method from this check.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$PacketDirectory,
  [Parameter(Mandatory=$true)][string]$FixtureRoot,
  [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or $PSVersionTable.PSEdition -cne 'Desktop') { throw 'Windows x64 PowerShell 5.1 Desktop required' }
if(Test-Path -LiteralPath $FixtureRoot) { throw 'Existing preflight root cannot be reused' }
$packetNames=@('launch-profile-only.proposed.ps1','reconcile-profile-only.proposed.ps1','pins.proposed.json','profile-only-spec.proposed.json','root-admission.proposed.json','argv-env-plan.json')
$report=[ordered]@{version=1;mode='profile-only-preflight';status='failed';engine='WindowsPowerShell5.1-Desktop';checks=@();realAccountsCreated=0;realProfilesCreated=0;releasedPeExecuted=$false;releasedPeMayHaveExecuted=$false;compatibilityEnabled=$false;oldExit22Policy='fatal';cleanup='not_run';packetUnchanged=$false;packetHashes=[ordered]@{}}
$rootIdentity=$null
$runnerSid=$null
function Check([string]$Name,[bool]$Passed) {
  $report.checks+=@{name=$Name;status=$(if($Passed){'passed'}else{'failed'})}
  if(-not $Passed){throw ('Preflight failed: '+$Name)}
}
function Read-PacketHashes {
  $hashes=[ordered]@{}
  foreach($name in $packetNames) {
    $file=Get-Item -LiteralPath (Join-Path $PacketDirectory $name) -Force
    if($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $file.Length -gt 1048576){throw 'Ordinary bounded packet source required'}
    $hashes[$name]=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  return $hashes
}
function Invoke-PendingPacket([string]$Script,[string]$Switch) {
  $process=[Diagnostics.Process]::new()
  try {
    if($Script.Contains('"')){throw 'Invalid script path'}
    $process.StartInfo.FileName=Join-Path $PSHOME 'powershell.exe'
    $process.StartInfo.Arguments='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$Script+'" '+$Switch
    $process.StartInfo.UseShellExecute=$false
    $process.StartInfo.CreateNoWindow=$true
    $process.StartInfo.RedirectStandardOutput=$true
    $process.StartInfo.RedirectStandardError=$true
    $process.StartInfo.RedirectStandardInput=$true
    if(-not $process.Start()){throw 'Pending-only child did not start'}
    $process.StandardInput.Close()
    $stdout=$process.StandardOutput.ReadToEndAsync()
    $stderr=$process.StandardError.ReadToEndAsync()
    if(-not $process.WaitForExit(30000)) {
      # This held child can only read the unadmitted packet and return/deny.
      $process.Kill();$process.WaitForExit();throw 'Pending-only child timed out'
    }
    $text=$stdout.GetAwaiter().GetResult()
    $errorText=$stderr.GetAwaiter().GetResult()
    if($text.Length -gt 65536 -or $errorText.Length -gt 65536){throw 'Unbounded pending-only output'}
    return @{code=$process.ExitCode;value=($text|ConvertFrom-Json);stderr=$errorText}
  } finally {$process.Dispose()}
}
try {
  $report.packetHashes=Read-PacketHashes
  $pins=Get-Content -Raw -LiteralPath (Join-Path $PacketDirectory 'pins.proposed.json') -Encoding UTF8|ConvertFrom-Json
  $spec=Get-Content -Raw -LiteralPath (Join-Path $PacketDirectory 'profile-only-spec.proposed.json') -Encoding UTF8|ConvertFrom-Json
  $admission=Get-Content -Raw -LiteralPath (Join-Path $PacketDirectory 'root-admission.proposed.json') -Encoding UTF8|ConvertFrom-Json
  Check 'packet-explicitly-unadmitted' ($pins.status -ceq 'DRAFT_NOT_READY' -and $pins.admissionStatus -ceq 'not_admitted' -and $null -eq $pins.activationHead -and $null -eq $pins.stageBase -and $spec.realExecutionAdmitted -is [bool] -and -not $spec.realExecutionAdmitted -and $admission.status -ceq 'not_admitted')
  $asts=@{}
  foreach($name in @('launch-profile-only.proposed.ps1','reconcile-profile-only.proposed.ps1')) {
    $tokens=$null;$parseErrors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PacketDirectory $name),[ref]$tokens,[ref]$parseErrors)
    Check ('parse-'+$name) (@($parseErrors).Count -eq 0)
    $reservedWrites=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and @('HOME','PID','Host') -contains $node.Left.VariablePath.UserPath},$true))
    Check ('no-automatic-variable-assignment-'+$name) ($reservedWrites.Count -eq 0)
    $asts[$name]=$ast
    $default=Invoke-PendingPacket (Join-Path $PacketDirectory $name) ''
    Check ('default-'+$name) ($default.code -eq 0 -and $default.stderr -ceq '' -and $default.value.status -ceq 'not_run' -and $default.value.accountApi -ceq 'not_run' -and $default.value.nativeExecution -ceq 'not_run')
    $switch=if($name -ceq 'launch-profile-only.proposed.ps1'){'-ExecuteReviewedProfileOnly'}else{'-DisableReviewedProfileOnlyOwnedAccount'}
    $denied=Invoke-PendingPacket (Join-Path $PacketDirectory $name) $switch
    $expectedDeniedStatus=if($name -ceq 'launch-profile-only.proposed.ps1'){'stopped_before_controller_start'}else{'stopped_unknown_requires_root_reconciliation'}
    Check ('pending-denial-'+$name) ($denied.code -eq 1 -and $denied.value.status -ceq $expectedDeniedStatus -and $denied.value.accountApi -ceq 'not_run')
    $native=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.StringConstantType -eq [Management.Automation.Language.StringConstantType]::SingleQuotedHereString -and $node.Value.Contains('namespace CcHaha1879ProfileOnly')},$true))
    Check ('one-embedded-source-'+$name) ($native.Count -eq 1)
    # Compile declarations only. In particular, the disable helper's SAM and
    # process methods are never invoked by this fixture.
    Add-Type -TypeDefinition $native[0].Value -Language CSharp -ReferencedAssemblies @('System.dll') -ErrorAction Stop
    Check ('compile-'+$name) $true
  }
  # Reuse the launcher's exact ACL predicate and atomic directory producer.
  # Import only these two function definitions, never the launch body.
  foreach($name in @('Require-True','Assert-PrivateAcl')) {
    $functions=@($asts['launch-profile-only.proposed.ps1'].FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true))
    if($functions.Count -ne 1){throw 'Expected exact launcher ACL function'}
    . ([ScriptBlock]::Create($functions[0].Extent.Text))
  }
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  try {$runnerSid=$identity.User.Value}finally{$identity.Dispose()}
  $rootIdentity=[CcHaha1879ProfileOnlyLaunchV1.Native]::CreateOwnedDirectory($FixtureRoot,$runnerSid)
  Assert-PrivateAcl (Get-Acl -LiteralPath $FixtureRoot) $runnerSid $true $true $false
  Check 'atomic-private-root-acl' ($rootIdentity.Path -ceq $FixtureRoot)
  $rejected=$false
  try {[CcHaha1879ProfileOnlyLaunchV1.Native]::CreateOwnedDirectory($FixtureRoot,$runnerSid)|Out-Null}catch{$rejected=$true}
  Check 'existing-root-rejected' $rejected
  function Set-FixtureAcl([string]$Name,[string]$ExtraSid,[bool]$ExtraWrite) {
    # Each ACL case starts with its own newly created writable file. Rewriting
    # the owner of an already-readonly case would require WRITE_OWNER.
    $caseFile=Join-Path $FixtureRoot $Name
    $stream=[IO.FileStream]::new($caseFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    $stream.Dispose()
    $acl=[Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true,$false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($runnerSid))
    $rights=[Security.AccessControl.FileSystemRights]([Security.AccessControl.FileSystemRights]::ReadAndExecute -bor [Security.AccessControl.FileSystemRights]::Synchronize)
    foreach($sid in @($runnerSid,'S-1-5-18','S-1-5-32-544')) {$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),$rights,[Security.AccessControl.AccessControlType]::Allow))}
    if($ExtraSid){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($ExtraSid),$rights,[Security.AccessControl.AccessControlType]::Allow))}
    if($ExtraWrite){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($runnerSid),[Security.AccessControl.FileSystemRights]::WriteData,[Security.AccessControl.AccessControlType]::Allow))}
    [IO.File]::SetAccessControl($caseFile,$acl)
    return $caseFile
  }
  $file=Set-FixtureAcl 'readonly-input.txt' '' $false
  Assert-PrivateAcl (Get-Acl -LiteralPath $file) $runnerSid $false $true $true
  Check 'readonly-allow-synchronize-roundtrip' $true
  $file=Set-FixtureAcl 'extra-write-input.txt' '' $true
  $rejected=$false
  try {Assert-PrivateAcl (Get-Acl -LiteralPath $file) $runnerSid $false $true $true}catch{$rejected=$true}
  Check 'readonly-extra-write-rejected' $rejected
  $file=Set-FixtureAcl 'extra-principal-input.txt' 'S-1-5-32-545' $false
  $rejected=$false
  try {Assert-PrivateAcl (Get-Acl -LiteralPath $file) $runnerSid $false $true $true}catch{$rejected=$true}
  Check 'readonly-extra-principal-rejected' $rejected
  $after=Read-PacketHashes
  $unchanged=$true
  foreach($name in $packetNames){if($after[$name] -cne $report.packetHashes[$name]){$unchanged=$false}}
  $report.packetUnchanged=$unchanged
  Check 'packet-source-unchanged' $unchanged
  $report.status='passed'
} catch {
  $report.error=$_.Exception.Message
} finally {
  if($null -ne $rootIdentity) {
    try {
      $actual=[CcHaha1879ProfileOnlyLaunchV1.Native]::Identity($FixtureRoot,$true)
      if($actual.Id -cne $rootIdentity.Id -or $actual.Path -cne $rootIdentity.Path){throw 'Owned preflight root identity changed'}
      [IO.Directory]::Delete($FixtureRoot,$true)
      $report.cleanup='passed'
    } catch {$report.cleanup='failed';$report.status='failed';$report.cleanupError=$_.Exception.Message}
  } else {$report.cleanup='not_created'}
  [IO.File]::WriteAllText($OutputPath,($report|ConvertTo-Json -Depth 12)+"`n",[Text.UTF8Encoding]::new($false))
}
if($report.status -cne 'passed' -or $report.cleanup -cne 'passed'){exit 1}
exit 0
