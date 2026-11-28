# REVIEW-ONLY proposal. Native Stage B has not been executed.
# No switch: read-only review summary. Execution needs root's exact admission.
[CmdletBinding()]
param(
  [switch]$ExecuteReviewedStageB,
  [string]$ApprovedSpecSha256,
  [string]$StageAInputDirectory,
  [string]$VerifiedSetupPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$pins = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'pins.json') | ConvertFrom-Json
$specFile = Join-Path $PSScriptRoot 'controller-spec.proposed-admitted.json'
if (-not $ExecuteReviewedStageB) {
  [ordered]@{ status = 'not_run'; admission = 'not_granted_by_this_file'; specSha256 = $pins.specSha256 } | ConvertTo-Json
  return
}
if ($ApprovedSpecSha256 -cne $pins.specSha256) { throw 'Exact root-reviewed spec hash is required' }
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess) { throw 'Windows x64 only' }
if ($env:CI -cne 'true' -or $env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'NanmiCoder/cc-haha') { throw 'Disposable original-repository Actions context required' }
if ($env:RUNNER_TEMP -cne 'D:\a\_temp' -or $env:GITHUB_WORKSPACE -cne 'D:\a\cc-haha\cc-haha') { throw 'Reviewed runner paths changed; stop for reconciliation' }
if (-not $StageAInputDirectory -or -not $VerifiedSetupPath) { throw 'Verified original A inputs and full setup are required' }
function Assert-RegularFile([string]$Path, [string]$Hash, [long]$Bytes = -1) {
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Input is not an ordinary file' }
  for ($parent = $item.Directory; $null -ne $parent; $parent = $parent.Parent) {
    if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Input ancestor is a reparse point' }
  }
  if ($Bytes -ge 0 -and $item.Length -ne $Bytes) { throw 'Pinned input size changed' }
  if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash) { throw 'Pinned input hash changed' }
}
Assert-RegularFile $specFile $pins.specSha256
$approvedSpec = Get-Content -Raw -LiteralPath $specFile | ConvertFrom-Json
if ($pins.binarySha256 -cne $approvedSpec.expectedBinarySha256) { throw 'Metadata binary pin disagrees with approved spec' }
if ($pins.setupSha256 -cne 'dca6bb82f4d0fbee8d43c91912e4d50e7dcea69a7cb22c51cdd9cb265767c7e7' -or $pins.setupBytes -ne 230611497) { throw 'Frozen released setup pin changed' }
$stageBase = [IO.Path]::GetDirectoryName([string]$approvedSpec.controllerRoot)
if ($pins.stageBase -cne $stageBase -or $approvedSpec.sourceRoot -cne (Join-Path $stageBase 'input')) { throw 'Metadata layout disagrees with approved spec' }
if (($pins.sourcePins | ConvertTo-Json -Depth 5 -Compress) -cne ($approvedSpec.sourcePins | ConvertTo-Json -Depth 5 -Compress)) { throw 'Metadata sources disagree with approved spec' }
Assert-RegularFile (Join-Path $StageAInputDirectory 'profile-fixture.exe') $pins.binarySha256 $pins.binaryBytes
foreach ($pin in $pins.sourcePins) { Assert-RegularFile (Join-Path $StageAInputDirectory $pin.file) $pin.sha256 }
Assert-RegularFile $VerifiedSetupPath $pins.setupSha256 $pins.setupBytes
if (Test-Path -LiteralPath $stageBase) { throw 'Proposed stage root already exists; no reuse or deletion' }
$root = New-Item -ItemType Directory -Path $stageBase -ErrorAction Stop
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner([Security.Principal.SecurityIdentifier]::new($sid))
foreach ($owner in @($sid, 'S-1-5-18')) {
  $identity = [Security.Principal.SecurityIdentifier]::new($owner)
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $stageBase -AclObject $acl
$inputRoot = Join-Path $stageBase 'input'
$runtime = Join-Path $stageBase 'runtime'
New-Item -ItemType Directory -Path $inputRoot, $runtime | Out-Null
# The frozen child checks every ancestor's attributes. These two newly owned
# containers allow metadata/traverse only, without listing or file-read rights.
# No host ancestor/global ACL is changed; native owns the private controller ACL.
foreach ($container in @($stageBase, $inputRoot)) {
  $metadataAcl = Get-Acl -LiteralPath $container
  $users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
  $metadata = [Security.AccessControl.FileSystemRights]::Traverse -bor [Security.AccessControl.FileSystemRights]::ReadAttributes
  $metadataAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users, $metadata, [Security.AccessControl.InheritanceFlags]::None, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
  Set-Acl -LiteralPath $container -AclObject $metadataAcl
}
foreach ($pin in $pins.sourcePins) { Copy-Item -LiteralPath (Join-Path $StageAInputDirectory $pin.file) -Destination (Join-Path $inputRoot $pin.file) -ErrorAction Stop }
$binary = Join-Path $inputRoot 'profile-fixture.exe'
Copy-Item -LiteralPath (Join-Path $StageAInputDirectory 'profile-fixture.exe') -Destination $binary -ErrorAction Stop
Copy-Item -LiteralPath $VerifiedSetupPath -Destination (Join-Path $inputRoot 'old-setup.exe') -ErrorAction Stop
$stagedSpec = Join-Path $inputRoot 'controller-spec.proposed-admitted.json'
Copy-Item -LiteralPath $specFile -Destination $stagedSpec -ErrorAction Stop
Assert-RegularFile $binary $pins.binarySha256 $pins.binaryBytes
Assert-RegularFile $stagedSpec $pins.specSha256
foreach ($pin in $pins.sourcePins) { Assert-RegularFile (Join-Path $inputRoot $pin.file) $pin.sha256 }
Assert-RegularFile (Join-Path $inputRoot 'old-setup.exe') $pins.setupSha256 $pins.setupBytes
$spec = Get-Content -Raw -LiteralPath $stagedSpec | ConvertFrom-Json
if (Test-Path -LiteralPath $spec.controllerRoot) { throw 'Native controller root must be absent before launch' }
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $binary
$start.Arguments = '--role controller --spec "' + $stagedSpec + '"'
$start.WorkingDirectory = $inputRoot
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.EnvironmentVariables.Clear()
foreach ($key in @('SystemRoot','WINDIR','SystemDrive','ComSpec','OS','PROCESSOR_ARCHITECTURE','PROCESSOR_ARCHITEW6432','NUMBER_OF_PROCESSORS','ProgramFiles','ProgramFiles(x86)','ProgramW6432','CommonProgramFiles','CommonProgramFiles(x86)','CommonProgramW6432','ProgramData','ALLUSERSPROFILE')) {
  $value = [Environment]::GetEnvironmentVariable($key)
  if ($null -ne $value) { $start.EnvironmentVariables[$key] = $value }
}
if (-not $start.EnvironmentVariables['SystemRoot']) { throw 'SystemRoot missing' }
$start.EnvironmentVariables['PATH'] = $start.EnvironmentVariables['SystemRoot'] + '\System32;' + $start.EnvironmentVariables['SystemRoot'] + ';' + $start.EnvironmentVariables['SystemRoot'] + '\System32\Wbem;' + $start.EnvironmentVariables['SystemRoot'] + '\System32\WindowsPowerShell\v1.0'
$start.EnvironmentVariables['CI'] = 'true'
foreach ($key in @('HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','CLAUDE_CONFIG_DIR','CODEX_HOME','GH_CONFIG_DIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME')) {
  $private = Join-Path $runtime $key.ToLowerInvariant()
  New-Item -ItemType Directory -Path $private | Out-Null
  $start.EnvironmentVariables[$key] = $private
}
$receipt = [ordered]@{ status = 'starting'; rootAdmissionMustExistExternally = $true; runnerSid = $sid; runId = $spec.runId; owner = $spec.owner; generation = $spec.generation; specSha256 = $pins.specSha256; binarySha256 = $pins.binarySha256; controllerStartAttempted = $false; controllerStarted = $false; controllerPid = $null; controllerBirthUtc = $null; nativeExitCode = $null; nativeCleanup = 'not_run'; nativeCleanupReported = $null; releasedPeMayHaveExecuted = $false; stageBase = $stageBase }
$receiptFile = Join-Path $stageBase 'launch-receipt.json'
function Save-Receipt { $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptFile -Encoding UTF8 }
Save-Receipt
$process = New-Object Diagnostics.Process
$process.StartInfo = $start
try {
  # Arm uncertainty before Start: a failure can occur after process creation.
  $receipt.controllerStartAttempted = $true
  $receipt.releasedPeMayHaveExecuted = $true
  $receipt.nativeCleanup = 'unknown'
  Save-Receipt
  if (-not $process.Start()) { throw 'Controller process did not start' }
  $receipt.controllerStarted = $true
  $receipt.controllerPid = $process.Id
  $receipt.controllerBirthUtc = $process.StartTime.ToUniversalTime().ToString('o')
  Save-Receipt
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(900000)) {
    $receipt.status = 'timeout_unknown_requires_reconciliation'
    Save-Receipt
    throw 'Controller timeout: no wrapper kill/account/profile deletion or retry; reconcile owned CI state'
  }
  $receipt.nativeExitCode = $process.ExitCode
  [IO.File]::WriteAllText((Join-Path $stageBase 'controller.stdout.log'), $stdout.GetAwaiter().GetResult())
  [IO.File]::WriteAllText((Join-Path $stageBase 'controller.stderr.log'), $stderr.GetAwaiter().GetResult())
  if (-not (Test-Path -LiteralPath $spec.output -PathType Leaf)) { throw 'Native terminal report missing; effects remain unknown' }
  $report = Get-Content -Raw -LiteralPath $spec.output | ConvertFrom-Json
  $receipt.nativeCleanupReported = [string]$report.cleanup
  if ($process.ExitCode -ne 0 -or $report.status -cne 'passed' -or $report.cleanup -cne 'cleaned') { throw 'Native B or native cleanup failed; no outer repair' }
  if ($report.binarySha256 -cne $pins.binarySha256 -or $report.specSha256 -cne $pins.specSha256) { throw 'Native terminal binding changed' }
  if ($report.realAccountsCreated -ne 1 -or $report.realProfilesCreated -ne 1 -or $report.compatibilityEnabled -or $report.oldExit22Policy -cne 'fatal') { throw 'Native scope facts are invalid' }
  if ($report.full_old_to_new -cne 'not_run' -or $report.member_proven -cne 'not_run') { throw 'Native report overclaims historical membership/full upgrade' }
  $receipt.nativeCleanup = 'cleaned'
  $receipt.releasedPeMayHaveExecuted = [bool]$report.releasedPeMayHaveExecuted
  $receipt.status = 'native_historical_B_passed_only_F1_incomplete'
  Save-Receipt
} catch {
  if ($receipt.status -cne 'timeout_unknown_requires_reconciliation') { $receipt.status = 'failed_requires_reconciliation' }
  Save-Receipt
  throw
} finally {
  # Dispose only the wrapper's retained Process object; no host-wide process or
  # account/profile/file removal. A live/timed-out controller remains unknown.
  $process.Dispose()
}
