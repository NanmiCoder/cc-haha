/** Fixed read-only WMI/TCP projection. Never emit full process argv or secrets. */
export const SAKURA_DISCOVERY_FUNCTIONS = String.raw`
function Read-SakuraArg([string]$line, [string]$names) {
  $matches = [regex]::Matches($line, '(?i)(?:^|\s)-{1,2}(?:' + $names + ')(?:=|\s+)(?:"([^"]+)"|([^\s"]+))(?=\s|$)')
  if ($matches.Count -ne 1) { return '' }
  if ($matches[0].Groups[1].Success) { return $matches[0].Groups[1].Value }
  return $matches[0].Groups[2].Value
}
function Local-SakuraPath([string]$value) {
  if ($value -notmatch '^[a-zA-Z]:[\\/]' -or $value -match '[\x00-\x1f"<>|*?]') { return '' }
  try { return [IO.Path]::GetFullPath($value) } catch { return '' }
}
function Get-SakuraProcesses {
  $issues = [Collections.Generic.List[string]]::new()
  $names = @('SakuraCat.exe','Sakura Cat.exe','sakura-cat.exe')
  $processes = @(Get-CimInstance Win32_Process -Filter "Name='com.vortex.helper.exe' OR Name='SakuraCat.exe' OR Name='Sakura Cat.exe' OR Name='sakura-cat.exe'")
  $listeners = @()
  try { $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::1','::') } | Select-Object LocalPort,OwningProcess) }
  catch { $issues.Add('SAKURA_LISTENERS_UNAVAILABLE') }
  $cores = @(foreach ($proc in $processes) {
    if ($proc.Name -ne 'com.vortex.helper.exe') { continue }
    $line = [string]$proc.CommandLine
    $file = Read-SakuraArg $line 'f|config'
    $directory = Local-SakuraPath (Read-SakuraArg $line 'd|home')
    # Relative -f is resolved only against an explicit absolute -d, never our cwd.
    $config = Local-SakuraPath $file
    if (-not $config -and $file -and $directory -and -not [IO.Path]::IsPathRooted($file) -and $file -notmatch ':') {
      $config = Local-SakuraPath (Join-Path $directory $file)
    }
    $controller = Read-SakuraArg $line 'ext-ctl|external-controller'
    if ($controller -and $controller -notmatch '^(127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$') { $controller = ''; $issues.Add('PROXY_LOOPBACK_REQUIRED') }
    $client = ''
    $parentId = [int]$proc.ParentProcessId
    $visited = @([int]$proc.ProcessId)
    for ($depth = 0; $depth -lt 6 -and $parentId -gt 0 -and $parentId -notin $visited; $depth++) {
      $visited += $parentId
      $parent = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $parentId) -ErrorAction SilentlyContinue
      if (-not $parent -or $parent.CreationDate -gt $proc.CreationDate) { break }
      if ($parent.Name -in $names) { $client = Local-SakuraPath ([string]$parent.ExecutablePath); break }
      $parentId = [int]$parent.ParentProcessId
    }
    [pscustomobject]@{
      pid=[int]$proc.ProcessId
      startedAt=$(if ($proc.CreationDate) { $proc.CreationDate.ToUniversalTime().ToString('o') } else { '' })
      executablePath=(Local-SakuraPath ([string]$proc.ExecutablePath))
      clientExecutable=$client
      configPath=$config
      controller=$controller
      listeningPorts=@($listeners | Where-Object OwningProcess -eq $proc.ProcessId | Select-Object -ExpandProperty LocalPort -Unique)
      configSource=$(if ($config) { 'process-argument' } else { 'unresolved' })
      authOverride=[bool]($line -match '(?i)(?:^|\s)-{1,2}(?:secret|ext-secret)(?:\s|=|$)')
    }
  })
  [pscustomobject]@{ running=($processes.Count -gt 0); cores=$cores; issues=@($issues.ToArray()) }
}
`
