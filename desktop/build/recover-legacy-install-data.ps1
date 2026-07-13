[CmdletBinding()]
param(
  [string]$PerUserInstallDir = '',
  [string]$PerMachineInstallDir = '',
  [string]$CandidateInstallDir = '',
  [string]$UserDataDir = '',
  [string]$RecoveryRoot = '',
  [string]$ProcessName = 'Claude Code Haha.exe',
  [string]$ActiveConfigDir = $env:CLAUDE_CONFIG_DIR,
  [string]$ActiveConfigManaged = $env:CC_HAHA_APP_PORTABLE_DIR,
  [ValidateSet('trusted-user', 'trusted-uac-outer', 'untrusted-elevated')]
  [string]$InstallerIdentitySafety = 'trusted-user',
  [switch]$SkipProcessCheck,
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not ('CcHahaRecoveryNativePath' -as [type])) {
  Add-Type @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class CcHahaRecoveryNativePath
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(
        SafeFileHandle file,
        StringBuilder path,
        uint pathLength,
        uint flags);

    public static string Resolve(string path)
    {
        const uint shareReadWriteDelete = 0x00000007;
        const uint openExisting = 3;
        const uint backupSemantics = 0x02000000;
        using (SafeFileHandle handle = CreateFile(
            path,
            0,
            shareReadWriteDelete,
            IntPtr.Zero,
            openExisting,
            backupSemantics,
            IntPtr.Zero))
        {
            if (handle.IsInvalid) {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Cannot resolve the final path for " + path);
            }
            StringBuilder result = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandle(handle, result, (uint)result.Capacity, 0);
            if (length == 0) {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Cannot resolve the final path for " + path);
            }
            if (length >= (uint)result.Capacity) {
                throw new InvalidOperationException("Resolved path is too long: " + path);
            }
            string value = result.ToString();
            if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) {
                return @"\\" + value.Substring(8);
            }
            return value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)
                ? value.Substring(4)
                : value;
        }
    }
}
'@
}

function Resolve-CanonicalPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  $fullPath = [IO.Path]::GetFullPath($Path)
  $existingPath = $fullPath
  $missingSegments = New-Object 'System.Collections.Generic.List[string]'
  while (-not (Test-Path -LiteralPath $existingPath)) {
    $parent = [IO.Path]::GetDirectoryName($existingPath)
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $existingPath) {
      throw "Cannot resolve an existing ancestor for $Path"
    }
    $missingSegments.Insert(0, [IO.Path]::GetFileName($existingPath))
    $existingPath = $parent
  }

  $resolved = [CcHahaRecoveryNativePath]::Resolve($existingPath)
  foreach ($segment in $missingSegments) {
    $resolved = Join-Path $resolved $segment
  }
  return [IO.Path]::GetFullPath($resolved)
}

function Test-PathAtOrBelow {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Candidate
  )

  $resolvedParent = (Resolve-CanonicalPath $Parent).TrimEnd('\', '/')
  $resolvedCandidate = (Resolve-CanonicalPath $Candidate).TrimEnd('\', '/')
  if ($resolvedCandidate.Equals($resolvedParent, [StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }
  return $resolvedCandidate.StartsWith(
    $resolvedParent + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase)
}

function Test-LexicalPathAtOrBelow {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Candidate
  )

  $fullParent = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  $fullCandidate = [IO.Path]::GetFullPath($Candidate).TrimEnd('\', '/')
  if ($fullCandidate.Equals($fullParent, [StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }
  return $fullCandidate.StartsWith(
    $fullParent + [IO.Path]::DirectorySeparatorChar,
    [StringComparison]::OrdinalIgnoreCase)
}

function Test-PathMayBeDeleted {
  param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$Candidate
  )

  return (Test-LexicalPathAtOrBelow -Parent $InstallDir -Candidate $Candidate) -or
    (Test-PathAtOrBelow -Parent $InstallDir -Candidate $Candidate)
}

function Test-SamePath {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right
  )
  return (Resolve-CanonicalPath $Left).TrimEnd('\', '/').Equals(
    (Resolve-CanonicalPath $Right).TrimEnd('\', '/'),
    [StringComparison]::OrdinalIgnoreCase)
}

function Read-AppMode {
  param([Parameter(Mandatory = $true)][string]$ConfigDir)

  $modeFile = Join-Path $ConfigDir 'app-mode.json'
  if (-not (Test-Path -LiteralPath $modeFile -PathType Leaf)) {
    return $null
  }
  try {
    $parsed = Get-Content -LiteralPath $modeFile -Raw | ConvertFrom-Json
  } catch {
    throw "Existing app mode metadata cannot be read safely ($modeFile): $($_.Exception.Message)"
  }
  if ($null -eq $parsed -or $parsed -isnot [pscustomobject]) {
    throw "Existing app mode metadata is not a JSON object: $modeFile"
  }

  $modeProperty = $parsed.PSObject.Properties['mode']
  if ($null -ne $modeProperty -and $modeProperty.Value -isnot [string]) {
    throw "Existing app mode metadata has an invalid mode value: $modeFile"
  }
  $mode = if ($null -ne $modeProperty) {
    ([string]$modeProperty.Value).ToLowerInvariant()
  } else {
    'default'
  }
  if ($mode -notin @('default', 'portable')) {
    throw "Existing app mode metadata has an unsupported mode '$mode': $modeFile"
  }

  $portableProperty = $parsed.PSObject.Properties['portable_dir']
  if ($null -ne $portableProperty -and
      $null -ne $portableProperty.Value -and
      $portableProperty.Value -isnot [string]) {
    throw "Existing app mode metadata has an invalid portable_dir value: $modeFile"
  }
  $portableDir = if ($null -ne $portableProperty -and $portableProperty.Value -is [string]) {
    ([string]$portableProperty.Value).Trim()
  } else {
    $null
  }
  return [pscustomobject]@{
    Mode = $mode
    PortableDir = $portableDir
  }
}

function Test-LegacyPortableData {
  param([Parameter(Mandatory = $true)][string]$Dir)

  if (-not (Test-Path -LiteralPath $Dir -PathType Container)) {
    return $false
  }
  foreach ($file in @('settings.json', '.claude.json', '.mcp.json', 'window-state.json', 'terminal-config.json')) {
    if (Test-Path -LiteralPath (Join-Path $Dir $file) -PathType Leaf) {
      return $true
    }
  }
  foreach ($childDir in @('Cache', 'EBWebView', 'projects', 'skills', 'plugins', 'cowork_plugins', 'cc-haha')) {
    if (Test-Path -LiteralPath (Join-Path $Dir $childDir) -PathType Container) {
      return $true
    }
  }
  return $false
}

function Resolve-LegacyConfiguredPath {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Source
  )

  if (-not [IO.Path]::IsPathRooted($Value)) {
    throw "Legacy custom data path is relative and cannot be recovered safely ($Source): $Value"
  }
  return [IO.Path]::GetFullPath($Value)
}

function Get-LegacyActiveSource {
  param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    $SystemMode
  )

  $legacyDir = Join-Path $InstallDir 'CLAUDE_CONFIG_DIR'
  $legacyMode = Read-AppMode -ConfigDir $legacyDir
  if ($null -ne $legacyMode) {
    if ($legacyMode.Mode -ne 'portable') {
      return $null
    }
    if (Test-LegacyPortableData -Dir $legacyDir) {
      return $legacyDir
    }
    if ([string]::IsNullOrWhiteSpace([string]$legacyMode.PortableDir)) {
      return $legacyDir
    }
    return Resolve-LegacyConfiguredPath -Value $legacyMode.PortableDir -Source (Join-Path $legacyDir 'app-mode.json')
  }

  if ($null -ne $SystemMode) {
    if ($SystemMode.Mode -ne 'portable') {
      return $null
    }
    if ([string]::IsNullOrWhiteSpace([string]$SystemMode.PortableDir)) {
      return $legacyDir
    }
    return Resolve-LegacyConfiguredPath -Value $SystemMode.PortableDir -Source 'system app-mode.json'
  }

  if (Test-LegacyPortableData -Dir $legacyDir) {
    return $legacyDir
  }
  return $null
}

function Get-ExistingInstallDirs {
  param([string[]]$InstallDirs)

  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $result = New-Object 'System.Collections.Generic.List[string]'
  foreach ($installDir in $InstallDirs) {
    if ([string]::IsNullOrWhiteSpace($installDir) -or -not (Test-Path -LiteralPath $installDir -PathType Container)) {
      continue
    }
    $canonical = Resolve-CanonicalPath $installDir
    if ($seen.Add($canonical)) {
      $result.Add($canonical)
    }
  }
  return $result.ToArray()
}

function Get-PotentialInstallDirs {
  param([string[]]$InstallDirs)

  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $result = New-Object 'System.Collections.Generic.List[string]'
  foreach ($installDir in $InstallDirs) {
    if ([string]::IsNullOrWhiteSpace($installDir)) {
      continue
    }
    if (-not [IO.Path]::IsPathRooted($installDir)) {
      throw "Application install directory is relative and cannot be checked safely: $installDir"
    }
    $fullPath = [IO.Path]::GetFullPath($installDir)
    if ($seen.Add($fullPath)) {
      $result.Add($fullPath)
    }
  }
  return $result.ToArray()
}

function Get-UnsafeLegacySource {
  param(
    [Parameter(Mandatory = $true)][string[]]$InstallDirs,
    [Parameter(Mandatory = $true)][string]$UserDataDir,
    [AllowEmptyString()][string]$ActiveConfigDir,
    [AllowEmptyString()][string]$ActiveConfigManaged
  )

  $sources = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
  $activeInsideInstall = $false
  $activeOutsideInstall = $false
  $active = $null
  if (-not [string]::IsNullOrWhiteSpace($ActiveConfigDir)) {
    if (-not [IO.Path]::IsPathRooted($ActiveConfigDir)) {
      throw "Active CLAUDE_CONFIG_DIR is relative and cannot be recovered safely: $ActiveConfigDir"
    }
    $active = [IO.Path]::GetFullPath($ActiveConfigDir)
    foreach ($installDir in $InstallDirs) {
      if (Test-PathMayBeDeleted -InstallDir $installDir -Candidate $active) {
        $activeInsideInstall = $true
        if ($ActiveConfigManaged -ne '1') {
          throw "Active CLAUDE_CONFIG_DIR is managed outside Claude Code Haha and points inside an application install directory. Move or remove that environment variable before upgrading: $active"
        }
        if (Test-SamePath -Left $installDir -Right $active) {
          throw "The active data directory is the application install root itself: $active"
        }
        if (Test-Path -LiteralPath $active -PathType Container) {
          $canonicalActive = Resolve-CanonicalPath $active
          if (-not $sources.ContainsKey($canonicalActive)) {
            $sources.Add($canonicalActive, $active)
          }
        }
        break
      }
    }
    if (-not $activeInsideInstall) {
      $activeOutsideInstall = $true
    }
  }

  if ($activeOutsideInstall -and $ActiveConfigManaged -eq '1') {
    $systemMode = Read-AppMode -ConfigDir $UserDataDir
    if ($null -eq $systemMode -or
        $systemMode.Mode -ne 'portable' -or
        [string]::IsNullOrWhiteSpace([string]$systemMode.PortableDir)) {
      throw 'App-managed CLAUDE_CONFIG_DIR has no matching persisted custom mode. Restart the old app before upgrading so its active and saved data directories agree.'
    }
    $persistedActive = Resolve-LegacyConfiguredPath -Value $systemMode.PortableDir -Source 'system app-mode.json'
    if (-not (Test-SamePath -Left $active -Right $persistedActive)) {
      throw "App-managed CLAUDE_CONFIG_DIR does not match persisted custom mode. Active: $active; persisted: $persistedActive"
    }
  } elseif ($activeOutsideInstall) {
    $systemMode = $null
  } else {
    $systemMode = Read-AppMode -ConfigDir $UserDataDir
  }
  foreach ($installDir in $InstallDirs) {
    $source = Get-LegacyActiveSource -InstallDir $installDir -SystemMode $systemMode
    if ([string]::IsNullOrWhiteSpace([string]$source) -or
        -not (Test-Path -LiteralPath $source -PathType Container)) {
      continue
    }
    foreach ($possiblyDeletedRoot in $InstallDirs) {
      if (Test-PathMayBeDeleted -InstallDir $possiblyDeletedRoot -Candidate $source) {
        if (Test-SamePath -Left $possiblyDeletedRoot -Right $source) {
          throw "The active data directory is the application install root itself: $source"
        }
        $canonicalSource = Resolve-CanonicalPath $source
        if (-not $sources.ContainsKey($canonicalSource)) {
          $sources.Add($canonicalSource, $source)
        }
        break
      }
    }
  }

  if ($activeOutsideInstall) {
    if ($sources.Count -gt 0) {
      throw "External CLAUDE_CONFIG_DIR is active while install-contained legacy data still exists. Refusing to remove data that may belong to another Windows user: $($sources.Values -join ', ')"
    }
    return $null
  }
  if ($sources.Count -gt 1) {
    throw "Multiple distinct legacy data sources may be removed; refusing to guess which one is active: $($sources.Values -join ', ')"
  }
  if ($sources.Count -eq 1) {
    return @($sources.Values)[0]
  }
  return $null
}

function Assert-NoUndiscoveredLegacySources {
  param(
    [Parameter(Mandatory = $true)][string[]]$InstallDirs,
    [AllowNull()][AllowEmptyString()][string]$ActiveSource
  )

  foreach ($installDir in $InstallDirs) {
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($installDir)
    while ($pending.Count -gt 0) {
      $currentDir = $pending.Pop()
      foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($currentDir)) {
        $attributes = [IO.File]::GetAttributes($entry)
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
          throw "Application install tree contains a reparse point that prevents a complete legacy data scan: $entry"
        }
        if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
          $pending.Push($entry)
          continue
        }
        if (-not ([IO.Path]::GetFileName($entry)).Equals('app-mode.json', [StringComparison]::OrdinalIgnoreCase)) {
          continue
        }

        $modeDir = [IO.Path]::GetDirectoryName($entry)
        $mode = Read-AppMode -ConfigDir $modeDir
        if ($null -eq $mode -or $mode.Mode -ne 'portable') {
          continue
        }
        $candidate = if (Test-LegacyPortableData -Dir $modeDir) {
          $modeDir
        } elseif ([string]::IsNullOrWhiteSpace([string]$mode.PortableDir)) {
          $modeDir
        } else {
          Resolve-LegacyConfiguredPath -Value $mode.PortableDir -Source $entry
        }
        if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
          continue
        }

        $willBeRemoved = $false
        foreach ($possiblyDeletedRoot in $InstallDirs) {
          if (Test-PathMayBeDeleted -InstallDir $possiblyDeletedRoot -Candidate $candidate) {
            $willBeRemoved = $true
            break
          }
        }
        if (-not $willBeRemoved) {
          continue
        }
        if (-not [string]::IsNullOrWhiteSpace($ActiveSource) -and
            (Test-SamePath -Left $ActiveSource -Right $candidate)) {
          continue
        }
        throw "Install-contained custom data was configured by another Windows user or an undiscovered legacy mode. Refusing to remove it: $candidate (metadata: $entry)"
      }
    }
  }
}

function Assert-NoRunningApplication {
  param(
    [Parameter(Mandatory = $true)][string[]]$InstallDirs,
    [Parameter(Mandatory = $true)][string]$ProcessName
  )

  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    try {
      $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    } catch {
      throw "Cannot verify whether the old application or one of its sidecars is still running: $($_.Exception.Message)"
    }

    $matching = New-Object 'System.Collections.Generic.List[string]'
    $hasUnknownAppPath = $false
    foreach ($process in $processes) {
      $executablePath = [string]$process.ExecutablePath
      if ([string]::IsNullOrWhiteSpace($executablePath)) {
        if (([string]$process.Name).Equals($ProcessName, [StringComparison]::OrdinalIgnoreCase)) {
          $hasUnknownAppPath = $true
        }
        continue
      }
      foreach ($installDir in $InstallDirs) {
        if (Test-PathMayBeDeleted -InstallDir $installDir -Candidate $executablePath) {
          $matching.Add($executablePath)
          break
        }
      }
    }
    if ($matching.Count -eq 0 -and -not $hasUnknownAppPath) {
      return
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)

  if ($hasUnknownAppPath) {
    throw "Cannot verify the executable path of a running $ProcessName process. Close the app and run the installer again."
  }
  throw "An application process is still running from an installation that may contain legacy data: $($matching -join ', '). Close the app and run the installer again."
}

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '')
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Get-TreeManifest {
  param([Parameter(Mandatory = $true)][string]$Root)

  $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  $rootAttributes = [IO.File]::GetAttributes($rootPath)
  if (($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Legacy data root is a reparse point and cannot be copied without ambiguity: $rootPath"
  }

  $entries = New-Object 'System.Collections.Generic.List[string]'
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($rootPath)
  while ($pending.Count -gt 0) {
    $currentDir = $pending.Pop()
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($currentDir)) {
      $attributes = [IO.File]::GetAttributes($entry)
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Legacy data contains a reparse point and recovery must stop: $entry"
      }
      $relative = [IO.Path]::GetFullPath($entry).Substring($rootPath.Length).TrimStart('\', '/')
      if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
        $entries.Add("D|$relative")
        $pending.Push($entry)
      } else {
        $file = Get-Item -LiteralPath $entry -Force
        $entries.Add("F|$relative|$($file.Length)|$(Get-FileSha256 -Path $entry)")
      }
    }
  }
  return @($entries.ToArray() | Sort-Object)
}

function Assert-TreeManifestsEqual {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Expected,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Actual,
    [Parameter(Mandatory = $true)][string]$Message
  )

  if ($Expected.Count -ne $Actual.Count -or
      $null -ne (Compare-Object -ReferenceObject @($Expected) -DifferenceObject @($Actual) -CaseSensitive)) {
    throw $Message
  }
}

function Copy-VerifiedTree {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$RecoveryRoot
  )

  New-Item -ItemType Directory -Path $RecoveryRoot -Force | Out-Null
  $id = [Guid]::NewGuid().ToString('N')
  $timestamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
  $staging = Join-Path $RecoveryRoot ".$id.partial"
  $destination = Join-Path $RecoveryRoot "Recovered-$timestamp-$id"
  New-Item -ItemType Directory -Path $staging | Out-Null

  try {
    $before = @(Get-TreeManifest -Root $Source)
    & "$env:SystemRoot\System32\robocopy.exe" `
      $Source $staging /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
    $robocopyExitCode = $LASTEXITCODE
    if ($robocopyExitCode -ge 8) {
      throw "robocopy failed with exit code $robocopyExitCode"
    }

    $after = @(Get-TreeManifest -Root $Source)
    $copied = @(Get-TreeManifest -Root $staging)
    Assert-TreeManifestsEqual -Expected $before -Actual $after -Message 'Legacy data changed while it was being copied; close every app using it and retry.'
    Assert-TreeManifestsEqual -Expected $after -Actual $copied -Message 'The recovered copy does not exactly match the legacy data source.'

    [IO.Directory]::Move($staging, $destination)
    return $destination
  } finally {
    if (Test-Path -LiteralPath $staging) {
      Remove-Item -LiteralPath $staging -Recurse -Force
    }
  }
}

function Write-AppModeAtomically {
  param(
    [Parameter(Mandatory = $true)][string]$UserDataDir,
    [Parameter(Mandatory = $true)][string]$CustomDir
  )

  New-Item -ItemType Directory -Path $UserDataDir -Force | Out-Null
  $target = Join-Path $UserDataDir 'app-mode.json'
  $id = [Guid]::NewGuid().ToString('N')
  $temporary = Join-Path $UserDataDir ".app-mode.$id.tmp"
  $backup = Join-Path $UserDataDir "app-mode.pre-recovery.$id.bak"
  $json = [ordered]@{
    mode = 'portable'
    portable_dir = $CustomDir
  } | ConvertTo-Json

  try {
    [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $target -PathType Leaf) {
      [IO.File]::Replace($temporary, $target, $backup, $true)
    } else {
      [IO.File]::Move($temporary, $target)
    }
  } finally {
    if (Test-Path -LiteralPath $temporary) {
      Remove-Item -LiteralPath $temporary -Force
    }
  }
}

function Invoke-LegacyRecovery {
  param(
    [Parameter(Mandatory = $true)][string[]]$InstallDirs,
    [Parameter(Mandatory = $true)][string]$UserDataDir,
    [Parameter(Mandatory = $true)][string]$RecoveryRoot,
    [Parameter(Mandatory = $true)][string]$ProcessName,
    [AllowEmptyString()][string]$ActiveConfigDir,
    [AllowEmptyString()][string]$ActiveConfigManaged = '',
    [string]$InstallerIdentitySafety = 'trusted-user',
    [string[]]$RegisteredInstallDirs = @(),
    [switch]$SkipProcessCheck
  )

  $potentialInstallDirs = @(Get-PotentialInstallDirs -InstallDirs $InstallDirs)
  $existingInstallDirs = @(Get-ExistingInstallDirs -InstallDirs $potentialInstallDirs)
  if ($existingInstallDirs.Count -eq 0) {
    return $null
  }
  if ($InstallerIdentitySafety -eq 'untrusted-elevated' -and
      @(Get-ExistingInstallDirs -InstallDirs $RegisteredInstallDirs).Count -gt 0) {
    throw 'An existing registered installation cannot be upgraded from an elevated installer without the original user process. Run the installer normally (not as Administrator).'
  }
  if (-not $SkipProcessCheck) {
    Assert-NoRunningApplication -InstallDirs $existingInstallDirs -ProcessName $ProcessName
  }

  $source = Get-UnsafeLegacySource `
    -InstallDirs $existingInstallDirs `
    -UserDataDir $UserDataDir `
    -ActiveConfigDir $ActiveConfigDir `
    -ActiveConfigManaged $ActiveConfigManaged
  Assert-NoUndiscoveredLegacySources -InstallDirs $existingInstallDirs -ActiveSource $source
  if ([string]::IsNullOrWhiteSpace([string]$source)) {
    return $null
  }
  if ($InstallerIdentitySafety -eq 'untrusted-elevated') {
    throw 'Legacy data recovery was requested from an elevated installer without the original user process. Run the installer normally (not as Administrator) so recovery is written to the correct Windows user profile.'
  }

  foreach ($installDir in $potentialInstallDirs) {
    if (Test-PathMayBeDeleted -InstallDir $installDir -Candidate $UserDataDir) {
      throw "The mode metadata directory is inside an application install directory: $UserDataDir"
    }
    if (Test-PathMayBeDeleted -InstallDir $installDir -Candidate $RecoveryRoot) {
      throw "The recovery destination is inside an application install directory: $RecoveryRoot"
    }
  }

  $destination = Copy-VerifiedTree -Source $source -RecoveryRoot $RecoveryRoot
  $finalSource = @(Get-TreeManifest -Root $source)
  $finalDestination = @(Get-TreeManifest -Root $destination)
  Assert-TreeManifestsEqual `
    -Expected $finalSource `
    -Actual $finalDestination `
    -Message 'Legacy data changed after the verified recovery copy was finalized; the installer stopped before removing the old version.'
  if (-not $SkipProcessCheck) {
    Assert-NoRunningApplication -InstallDirs $existingInstallDirs -ProcessName $ProcessName
  }
  Write-AppModeAtomically -UserDataDir $UserDataDir -CustomDir $destination
  return $destination
}

function Assert-SelfTest {
  param(
    [Parameter(Mandatory = $true)][bool]$Condition,
    [Parameter(Mandatory = $true)][string]$Message
  )
  if (-not $Condition) {
    throw "Self-test failed: $Message"
  }
}

function Write-TestMode {
  param(
    [Parameter(Mandatory = $true)][string]$Dir,
    [Parameter(Mandatory = $true)]$Value
  )
  New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  $Value | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Dir 'app-mode.json') -Encoding UTF8
}

function Run-SelfTest {
  $testRoot = Join-Path ([IO.Path]::GetTempPath()) "cc-haha-storage-recovery-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $testRoot | Out-Null
  try {
    $install = Join-Path $testRoot 'old install'
    $legacy = Join-Path $install 'CLAUDE_CONFIG_DIR'
    $userData = Join-Path $testRoot 'app data'
    $recovery = Join-Path $testRoot 'recovery'
    New-Item -ItemType Directory -Path $legacy -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $legacy 'settings.json') -Value 'legacy-v1' -NoNewline
    Write-TestMode -Dir $legacy -Value @{ mode = 'portable'; portable_dir = $null }
    Write-TestMode -Dir $userData -Value @{ mode = 'default'; portable_dir = $null }

    $first = Invoke-LegacyRecovery `
      -InstallDirs @($install) -UserDataDir $userData -RecoveryRoot $recovery `
      -ProcessName $ProcessName -ActiveConfigDir '' -SkipProcessCheck
    Assert-SelfTest -Condition (Test-Path -LiteralPath (Join-Path $first 'settings.json') -PathType Leaf) -Message 'legacy default was not recovered'
    Assert-SelfTest -Condition ((Get-Content -LiteralPath (Join-Path $first 'settings.json') -Raw) -eq 'legacy-v1') -Message 'recovered content differs'
    Assert-SelfTest -Condition (Test-Path -LiteralPath (Join-Path $legacy 'settings.json') -PathType Leaf) -Message 'source was modified'
    $firstMode = Get-Content -LiteralPath (Join-Path $userData 'app-mode.json') -Raw | ConvertFrom-Json
    Assert-SelfTest -Condition ($firstMode.mode -eq 'portable' -and $firstMode.portable_dir -eq $first) -Message 'recovery was not persisted as explicit custom mode'

    Set-Content -LiteralPath (Join-Path $legacy 'settings.json') -Value 'legacy-v2' -NoNewline
    $second = Invoke-LegacyRecovery `
      -InstallDirs @($install) -UserDataDir $userData -RecoveryRoot $recovery `
      -ProcessName $ProcessName -ActiveConfigDir '' -SkipProcessCheck
    Assert-SelfTest -Condition ($second -ne $first) -Message 'retry reused an existing destination'
    Assert-SelfTest -Condition ((Get-Content -LiteralPath (Join-Path $second 'settings.json') -Raw) -eq 'legacy-v2') -Message 'retry did not capture the latest source'
    Assert-SelfTest -Condition ((Get-Content -LiteralPath (Join-Path $first 'settings.json') -Raw) -eq 'legacy-v1') -Message 'retry overwrote the first recovery'

    $pointerInstall = Join-Path $testRoot 'pointer install'
    $pointerLegacy = Join-Path $pointerInstall 'CLAUDE_CONFIG_DIR'
    $pointerData = Join-Path $pointerInstall 'custom data'
    $pointerUserData = Join-Path $testRoot 'pointer app data'
    New-Item -ItemType Directory -Path $pointerData -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $pointerData '.claude.json') -Value 'pointer-data' -NoNewline
    Write-TestMode -Dir $pointerLegacy -Value @{ mode = 'portable'; portable_dir = $pointerData }
    $pointerRecovered = Invoke-LegacyRecovery `
      -InstallDirs @($pointerInstall) -UserDataDir $pointerUserData -RecoveryRoot (Join-Path $testRoot 'pointer recovery') `
      -ProcessName $ProcessName -ActiveConfigDir '' -SkipProcessCheck
    Assert-SelfTest -Condition ((Get-Content -LiteralPath (Join-Path $pointerRecovered '.claude.json') -Raw) -eq 'pointer-data') -Message 'legacy custom pointer was not recovered'

    $managedInstall = Join-Path $testRoot 'managed env install'
    $managedLegacy = Join-Path $managedInstall 'CLAUDE_CONFIG_DIR'
    New-Item -ItemType Directory -Path $managedLegacy -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $managedLegacy 'settings.json') -Value 'managed-env' -NoNewline
    $unmanagedFailed = $false
    try {
      Invoke-LegacyRecovery `
        -InstallDirs @($managedInstall) -UserDataDir (Join-Path $testRoot 'unmanaged app data') `
        -RecoveryRoot (Join-Path $testRoot 'unmanaged recovery') -ProcessName $ProcessName `
        -ActiveConfigDir $managedLegacy -ActiveConfigManaged '' -SkipProcessCheck | Out-Null
    } catch {
      $unmanagedFailed = $_.Exception.Message.Contains('managed outside Claude Code Haha')
    }
    Assert-SelfTest -Condition $unmanagedFailed -Message 'unsafe external CLAUDE_CONFIG_DIR did not fail closed'

    $managedRecovered = Invoke-LegacyRecovery `
      -InstallDirs @($managedInstall) -UserDataDir (Join-Path $testRoot 'managed app data') `
      -RecoveryRoot (Join-Path $testRoot 'managed recovery') -ProcessName $ProcessName `
      -ActiveConfigDir $managedLegacy -ActiveConfigManaged '1' -SkipProcessCheck
    Assert-SelfTest -Condition ((Get-Content -LiteralPath (Join-Path $managedRecovered 'settings.json') -Raw) -eq 'managed-env') -Message 'app-managed active environment was not recovered'

    $elevatedFailed = $false
    try {
      Invoke-LegacyRecovery `
        -InstallDirs @($managedInstall) -UserDataDir (Join-Path $testRoot 'elevated app data') `
        -RecoveryRoot (Join-Path $testRoot 'elevated recovery') -ProcessName $ProcessName `
        -ActiveConfigDir $managedLegacy -ActiveConfigManaged '1' `
        -InstallerIdentitySafety 'untrusted-elevated' -SkipProcessCheck | Out-Null
    } catch {
      $elevatedFailed = $_.Exception.Message.Contains('original user process')
    }
    Assert-SelfTest -Condition $elevatedFailed -Message 'untrusted elevated recovery did not fail closed'

    $wrongIdentityInstall = Join-Path $testRoot 'registered shared install'
    New-Item -ItemType Directory -Path (Join-Path $wrongIdentityInstall 'custom data') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $wrongIdentityInstall 'custom data\settings.json') -Value 'other-user-data' -NoNewline
    $wrongIdentityFailed = $false
    try {
      Invoke-LegacyRecovery `
        -InstallDirs @($wrongIdentityInstall) -RegisteredInstallDirs @($wrongIdentityInstall) `
        -UserDataDir (Join-Path $testRoot 'wrong identity app data') `
        -RecoveryRoot (Join-Path $testRoot 'wrong identity recovery') -ProcessName $ProcessName `
        -ActiveConfigDir '' -InstallerIdentitySafety 'untrusted-elevated' -SkipProcessCheck | Out-Null
    } catch {
      $wrongIdentityFailed = $_.Exception.Message.Contains('existing registered installation')
    }
    Assert-SelfTest -Condition $wrongIdentityFailed -Message 'untrusted elevated installer treated invisible user metadata as safe'

    $futureInstall = Join-Path $testRoot 'future install'
    $futureRecovery = Join-Path $futureInstall 'Recovered'
    $futureFailed = $false
    try {
      Invoke-LegacyRecovery `
        -InstallDirs @($managedInstall, $futureInstall) `
        -UserDataDir (Join-Path $testRoot 'future app data') -RecoveryRoot $futureRecovery `
        -ProcessName $ProcessName -ActiveConfigDir $managedLegacy -ActiveConfigManaged '1' `
        -SkipProcessCheck | Out-Null
    } catch {
      $futureFailed = $_.Exception.Message.Contains('recovery destination is inside an application install directory')
    }
    Assert-SelfTest -Condition $futureFailed -Message 'missing future install root did not protect its recovery subtree'

    $sharedInstall = Join-Path $testRoot 'shared install'
    $sharedLegacy = Join-Path $sharedInstall 'CLAUDE_CONFIG_DIR'
    $activeExternal = Join-Path $testRoot 'active external'
    New-Item -ItemType Directory -Path $sharedLegacy -Force | Out-Null
    New-Item -ItemType Directory -Path $activeExternal -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $sharedLegacy 'settings.json') -Value 'shared-user-data' -NoNewline
    $sharedFailed = $false
    try {
      Invoke-LegacyRecovery `
        -InstallDirs @($sharedInstall) -UserDataDir (Join-Path $testRoot 'shared app data') `
        -RecoveryRoot (Join-Path $testRoot 'shared recovery') -ProcessName $ProcessName `
        -ActiveConfigDir $activeExternal -ActiveConfigManaged '' -SkipProcessCheck | Out-Null
    } catch {
      $sharedFailed = $_.Exception.Message.Contains('another Windows user')
    }
    Assert-SelfTest -Condition $sharedFailed -Message 'external active config hid shared install-contained data'

    $otherUserInstall = Join-Path $testRoot 'other user shared install'
    $otherUserData = Join-Path $otherUserInstall 'B-data'
    $currentUserMode = Join-Path $testRoot 'current user shared mode'
    New-Item -ItemType Directory -Path $otherUserData -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $otherUserData 'settings.json') -Value 'other-windows-user' -NoNewline
    Write-TestMode -Dir $otherUserData -Value @{ mode = 'portable'; portable_dir = $otherUserData }
    Write-TestMode -Dir $currentUserMode -Value @{ mode = 'default'; portable_dir = $null }
    $otherUserFailed = $false
    try {
      Invoke-LegacyRecovery `
        -InstallDirs @($otherUserInstall) -UserDataDir $currentUserMode `
        -RecoveryRoot (Join-Path $testRoot 'other user recovery') -ProcessName $ProcessName `
        -ActiveConfigDir '' -SkipProcessCheck | Out-Null
    } catch {
      $otherUserFailed = $_.Exception.Message.Contains('another Windows user')
    }
    Assert-SelfTest -Condition $otherUserFailed -Message 'another Windows user custom directory was not protected'

    $managedExternalInstall = Join-Path $testRoot 'managed external install'
    $managedExternalData = Join-Path $testRoot 'managed external data'
    $managedExternalUserData = Join-Path $testRoot 'managed external app data'
    New-Item -ItemType Directory -Path $managedExternalInstall -Force | Out-Null
    New-Item -ItemType Directory -Path $managedExternalData -Force | Out-Null
    Write-TestMode -Dir $managedExternalUserData -Value @{ mode = 'portable'; portable_dir = $managedExternalData }
    $managedExternalResult = Invoke-LegacyRecovery `
      -InstallDirs @($managedExternalInstall) -UserDataDir $managedExternalUserData `
      -RecoveryRoot (Join-Path $testRoot 'managed external recovery') -ProcessName $ProcessName `
      -ActiveConfigDir $managedExternalData -ActiveConfigManaged '1' -SkipProcessCheck
    Assert-SelfTest -Condition ($null -eq $managedExternalResult) -Message 'matching app-managed external custom mode was not accepted'

    Set-Content -LiteralPath (Join-Path $managedExternalUserData 'app-mode.json') -Value '{broken-json' -NoNewline
    $managedExternalInvalidFailed = $false
    try {
      Invoke-LegacyRecovery `
        -InstallDirs @($managedExternalInstall) -UserDataDir $managedExternalUserData `
        -RecoveryRoot (Join-Path $testRoot 'managed external invalid recovery') -ProcessName $ProcessName `
        -ActiveConfigDir $managedExternalData -ActiveConfigManaged '1' -SkipProcessCheck | Out-Null
    } catch {
      $managedExternalInvalidFailed = $_.Exception.Message.Contains('cannot be read safely')
    }
    Assert-SelfTest -Condition $managedExternalInvalidFailed -Message 'invalid metadata bypassed app-managed external mode validation'

    $externalInstall = Join-Path $testRoot 'external install'
    $externalLegacy = Join-Path $externalInstall 'CLAUDE_CONFIG_DIR'
    $externalUserData = Join-Path $testRoot 'external app data'
    $externalDir = Join-Path $testRoot 'external custom'
    New-Item -ItemType Directory -Path $externalLegacy -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $externalLegacy 'settings.json') -Value 'inactive-legacy' -NoNewline
    New-Item -ItemType Directory -Path $externalDir -Force | Out-Null
    Write-TestMode -Dir $externalUserData -Value @{ mode = 'portable'; portable_dir = $externalDir }
    $externalResult = Invoke-LegacyRecovery `
      -InstallDirs @($externalInstall) -UserDataDir $externalUserData -RecoveryRoot (Join-Path $testRoot 'external recovery') `
      -ProcessName $ProcessName -ActiveConfigDir '' -SkipProcessCheck
    Assert-SelfTest -Condition ($null -eq $externalResult) -Message 'external custom data was unnecessarily migrated'

    $secondInstall = Join-Path $testRoot 'second install'
    $secondLegacy = Join-Path $secondInstall 'CLAUDE_CONFIG_DIR'
    New-Item -ItemType Directory -Path $secondLegacy -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $secondLegacy 'settings.json') -Value 'second-source' -NoNewline
    Write-TestMode -Dir $secondLegacy -Value @{ mode = 'portable'; portable_dir = $null }
    $multipleFailed = $false
    try {
      Invoke-LegacyRecovery `
        -InstallDirs @($install, $secondInstall) -UserDataDir (Join-Path $testRoot 'multiple app data') `
        -RecoveryRoot (Join-Path $testRoot 'multiple recovery') -ProcessName $ProcessName `
        -ActiveConfigDir $legacy -ActiveConfigManaged '1' -SkipProcessCheck | Out-Null
    } catch {
      $multipleFailed = $_.Exception.Message.Contains('Multiple distinct legacy data sources')
    }
    Assert-SelfTest -Condition $multipleFailed -Message 'active environment hid an ambiguous dual-install source'

    $invalidInstall = Join-Path $testRoot 'invalid mode install'
    $invalidUserData = Join-Path $testRoot 'invalid mode app data'
    New-Item -ItemType Directory -Path $invalidInstall -Force | Out-Null
    New-Item -ItemType Directory -Path $invalidUserData -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $invalidUserData 'app-mode.json') -Value '{broken-json' -NoNewline
    $invalidFailed = $false
    try {
      Invoke-LegacyRecovery `
        -InstallDirs @($invalidInstall) -UserDataDir $invalidUserData `
        -RecoveryRoot (Join-Path $testRoot 'invalid recovery') -ProcessName $ProcessName `
        -ActiveConfigDir '' -SkipProcessCheck | Out-Null
    } catch {
      $invalidFailed = $_.Exception.Message.Contains('cannot be read safely')
    }
    Assert-SelfTest -Condition $invalidFailed -Message 'invalid existing mode metadata was treated as absent'

    $junctionInstall = Join-Path $testRoot 'junction install'
    $junctionTarget = Join-Path $testRoot 'junction external target'
    $junctionLegacy = Join-Path $junctionInstall 'CLAUDE_CONFIG_DIR'
    New-Item -ItemType Directory -Path $junctionInstall -Force | Out-Null
    New-Item -ItemType Directory -Path $junctionTarget -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $junctionTarget 'settings.json') -Value 'junction-data' -NoNewline
    New-Item -ItemType Junction -Path $junctionLegacy -Target $junctionTarget | Out-Null
    $junctionFailed = $false
    try {
      Invoke-LegacyRecovery `
        -InstallDirs @($junctionInstall) -UserDataDir (Join-Path $testRoot 'junction app data') `
        -RecoveryRoot (Join-Path $testRoot 'junction recovery') -ProcessName $ProcessName `
        -ActiveConfigDir '' -SkipProcessCheck | Out-Null
    } catch {
      $junctionFailed = $_.Exception.Message.Contains('reparse point')
    }
    Assert-SelfTest -Condition $junctionFailed -Message 'install-contained junction source was silently skipped'

    [Console]::Out.WriteLine('Legacy install data recovery self-test passed.')
  } finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

try {
  if ($SelfTest) {
    Run-SelfTest
    exit 0
  }

  $result = Invoke-LegacyRecovery `
    -InstallDirs @($PerUserInstallDir, $PerMachineInstallDir, $CandidateInstallDir) `
    -UserDataDir $UserDataDir `
    -RecoveryRoot $RecoveryRoot `
    -ProcessName $ProcessName `
    -ActiveConfigDir $ActiveConfigDir `
    -ActiveConfigManaged $ActiveConfigManaged `
    -InstallerIdentitySafety $InstallerIdentitySafety `
    -RegisteredInstallDirs @($PerUserInstallDir, $PerMachineInstallDir) `
    -SkipProcessCheck:$SkipProcessCheck
  if (-not [string]::IsNullOrWhiteSpace([string]$result)) {
    [Console]::Out.WriteLine("Recovered legacy data to $result")
  }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 20
}
