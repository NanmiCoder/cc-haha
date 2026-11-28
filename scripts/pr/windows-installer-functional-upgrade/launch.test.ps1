# Zero-account regression of the launcher's actual AST-selected declarations.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$launch=Join-Path $PSScriptRoot 'launch.ps1'
$primitives=Join-Path (Split-Path $PSScriptRoot -Parent) 'windows-installer-profile-only\fixtures\launch-profile-only.proposed.ps1'
$tokens=$null;$parseErrors=$null
$launcherAst=[Management.Automation.Language.Parser]::ParseFile($launch,[ref]$tokens,[ref]$parseErrors)
if(@($parseErrors).Count -ne 0){throw 'launcher_parse_failed'}
$loops=@($launcherAst.FindAll({param($node)$node -is [Management.Automation.Language.ForEachStatementAst] -and $node.Variable.VariablePath.UserPath -ceq 'name' -and $node.Condition.Extent.Text.Contains("'Lock-HashedFile'")},$true))
if($loops.Count -ne 1){throw 'actual_import_loop_required'}
$names=@($loops[0].Condition.SafeGetValue())
$primitiveAst=[Management.Automation.Language.Parser]::ParseFile($primitives,[ref]$tokens,[ref]$parseErrors)
if(@($parseErrors).Count -ne 0){throw 'primitives_parse_failed'}
foreach($name in $names){
  $functions=@($primitiveAst.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true))
  if($functions.Count -ne 1){throw 'one_actual_declaration_required'}
  . ([ScriptBlock]::Create($functions[0].Extent.Text))
}
$fixtureParent=[IO.Path]::GetTempPath()
$fixtureRoot=Join-Path $fixtureParent ('cc1879-import-lock-'+[Guid]::NewGuid().ToString('N'))
$fixtureFile=Join-Path $fixtureRoot 'owned.txt'
$held=[Collections.Generic.List[IDisposable]]::new()
$correct=$false;$wrong=$false;$closed=$false;$failed=$false;$missing=$null;$created=$false
try{
  [void](New-Item -ItemType Directory -Path $fixtureRoot -ErrorAction Stop);$created=$true
  $bytes=[Text.Encoding]::UTF8.GetBytes("cc1879-owned-real-lock`n")
  $output=[IO.FileStream]::new($fixtureFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try{$output.Write($bytes,0,$bytes.Length);$output.Flush($true)}finally{$output.Dispose()}
  if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT){
    # The original path primitive requires a Windows drive. Only that platform
    # precondition is replaced on Core/macOS; Lock and Is-Sha remain actual.
    function Assert-OrdinaryPath([string]$Path,[bool]$Directory){
      if($Directory -or $Path -cne $fixtureFile){throw 'owned_fixture_path_required'}
      $item=Get-Item -LiteralPath $Path -Force
      if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'ordinary_fixture_required'}
    }
  }
  Lock-HashedFile $fixtureFile (Hash-Bytes $bytes) $bytes.Length
  if($held.Count -ne 1 -or -not $held[0].CanRead -or $held[0].Length -ne $bytes.Length){throw 'actual_stream_not_retained'}
  $correct=$true
  try{Lock-HashedFile $fixtureFile ('0'*64) $bytes.Length}catch{
    if($_.Exception.Message -cne 'file_hash_changed'){throw}
    $wrong=$true
  }
  if(-not $wrong -or $held.Count -ne 1){throw 'wrong_hash_not_rejected_without_new_retained_stream'}
}catch{
  $failed=$true
  if($_.Exception -is [Management.Automation.CommandNotFoundException] -and $_.Exception.CommandName -ceq 'Is-Sha'){$missing='Is-Sha'}
}finally{
  foreach($stream in $held){$stream.Dispose()}
  $closed=@($held|Where-Object{$_.CanRead}).Count -eq 0
  # Only these newly created known entries. No recursive/unknown cleanup.
  if($created -and [IO.File]::Exists($fixtureFile)){[IO.File]::Delete($fixtureFile)}
  if($created -and [IO.Directory]::Exists($fixtureRoot)){[IO.Directory]::Delete($fixtureRoot,$false)}
}
$result=[ordered]@{version=1;status=$(if(-not $failed -and $correct -and $wrong -and $closed){'passed'}else{'failed'});actualSelectedDeclarations=$true;correctHashRetained=$correct;wrongHashRejected=$wrong;streamsClosed=$closed;missingDependency=$missing;realAccountsCreated=0;realProfilesCreated=0;nativeExecution='not_run'}
$result|ConvertTo-Json
if($result.status -cne 'passed'){exit 1}
