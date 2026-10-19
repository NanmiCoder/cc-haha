import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import path from 'node:path'

export type MigrationPermissionsRunner = (script: string, input: string, signal?: AbortSignal) => Promise<void>
export type MigrationPermissionEntry = { source: string; target: string }

const scriptPrelude = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$operation = 'initialize'
$entryIndex = -1
$kind = 'unknown'
function Initialize-Permissions {
  foreach ($module in @('Security', 'Management', 'Utility')) {
    Import-Module (Join-Path $PSHOME ('Modules/Microsoft.PowerShell.{0}/Microsoft.PowerShell.{0}.psd1' -f $module)) -Global -ErrorAction Stop
  }
}
function Complete-Permissions {
  [Console]::Out.WriteLine('{"version":1,"ok":true}')
}
function Fail-Permissions($record) {
  $exception = $record.Exception
  for ($depth = 0; $depth -lt 8 -and $null -ne $exception.InnerException; $depth++) { $exception = $exception.InnerException }
  $type = $exception.GetType().Name
  if ($type -notin @('UnauthorizedAccessException', 'PrivilegeNotHeldException', 'IOException', 'FileNotFoundException', 'DirectoryNotFoundException', 'SecurityException', 'ArgumentException')) { $type = 'Other' }
  $result = @{ version = 1; ok = $false; phase = $phase; operation = $operation; entry = $entryIndex; kind = $kind; type = $type; hresult = ('0x{0:X8}' -f $exception.HResult) }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress))
}
function Assert-RegularItem([string]$itemPath) {
  $item = Get-Item -LiteralPath $itemPath -Force -ErrorAction Stop
  if ($item -isnot [System.IO.FileSystemInfo] -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Unsupported migration entry' }
  return $item
}
function Assert-UnlinkedTarget([string]$itemPath) {
  $current = [System.IO.Path]::GetFullPath($itemPath)
  while ($current) {
    $null = Assert-RegularItem $current
    $parent = [System.IO.Directory]::GetParent($current)
    if ($null -eq $parent) { return }
    $current = $parent.FullName
  }
}
function Assert-Permissions($expected, [string]$target) {
  $actual = Get-Acl -LiteralPath $target -ErrorAction Stop
  if (-not $actual.AreAccessRulesProtected) { throw 'Migration permissions are not protected' }
  $sidType = [System.Security.Principal.SecurityIdentifier]
  if ($expected.GetOwner($sidType).Value -ne $actual.GetOwner($sidType).Value) { throw 'Migration owner changed' }
  $expectedRules = @($expected.GetAccessRules($true, $true, $sidType) | ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.IdentityReference.Value, [int]$_.FileSystemRights, [int]$_.InheritanceFlags, [int]$_.PropagationFlags, [int]$_.AccessControlType } | Sort-Object)
  $actualRules = @($actual.GetAccessRules($true, $true, $sidType) | ForEach-Object { if ($_.IsInherited) { throw 'Unexpected inherited migration permissions' }; '{0}|{1}|{2}|{3}|{4}' -f $_.IdentityReference.Value, [int]$_.FileSystemRights, [int]$_.InheritanceFlags, [int]$_.PropagationFlags, [int]$_.AccessControlType } | Sort-Object)
  if (($expectedRules -join '\n') -cne ($actualRules -join '\n')) { throw 'Migration permissions differ' }
}
function Read-Permissions([string]$sourcePath) {
  $script:operation = 'read-acl'
  $acl = Get-Acl -LiteralPath $sourcePath -ErrorAction Stop
  $script:operation = 'protect-acl'
  $acl.SetAccessRuleProtection($true, $true)
  return $acl
}
function Write-Permissions($acl, [string]$targetPath) {
  $script:operation = 'validate-target'
  Assert-UnlinkedTarget $targetPath
  $script:operation = 'write-acl'
  Set-Acl -LiteralPath $targetPath -AclObject $acl -ErrorAction Stop
  $script:operation = 'verify-acl'
  Assert-Permissions $acl $targetPath
}
`

const preserveScript = `${scriptPrelude}
$phase = 'preserve'
try {
  Initialize-Permissions
  $payload = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
  foreach ($entry in $payload.entries) {
    $entryIndex = $entry.index
    $kind = 'unknown'
    $operation = 'validate-source'
    $source = Assert-RegularItem $entry.source
    $kind = if ($source.PSIsContainer) { 'directory' } else { 'file' }
    $operation = 'validate-target'
    $target = Assert-RegularItem $entry.target
    if ($source.PSIsContainer -ne $target.PSIsContainer -or [string]::Equals($source.FullName, $target.FullName, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid migration entry' }
    $acl = Read-Permissions $entry.source
    Write-Permissions $acl $entry.target
  }
  Complete-Permissions
  exit 0
} catch { Fail-Permissions $_; exit 1 }
`

// Probe only empty, newly created entries under the private staging directory.
// A successful probe is not a substitute for verifying the real copied entries.
const preflightScript = `${scriptPrelude}
$phase = 'preflight'
try {
  Initialize-Permissions
  $payload = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
  foreach ($entry in $payload.entries) {
    $entryIndex = $entry.index
    $kind = 'unknown'
    $operation = 'validate-source'
    $source = Assert-RegularItem $entry.source
    $kind = if ($source.PSIsContainer) { 'directory' } else { 'file' }
    $operation = 'validate-target'
    Assert-UnlinkedTarget $payload.directory
    # Reading can fail without any target mutation. Apply this same descriptor
    # after creation, so a second source read cannot leave an unused probe.
    $acl = Read-Permissions $entry.source
    $probe = Join-Path $payload.directory ('.acl-probe-' + [Guid]::NewGuid().ToString('N'))
    $operation = 'create-probe'
    if ($source.PSIsContainer) { $null = New-Item -Path $probe -ItemType Directory -ErrorAction Stop }
    else { $stream = [System.IO.File]::Open($probe, [System.IO.FileMode]::CreateNew); $stream.Dispose() }
    Write-Permissions $acl $probe
    $operation = 'remove-probe'
    Assert-UnlinkedTarget $probe
    Remove-Item -LiteralPath $probe -Force -ErrorAction Stop
  }
  Complete-Permissions
  exit 0
} catch { Fail-Permissions $_; exit 1 }
`

const restrictScript = `${scriptPrelude}
$phase = 'restrict'
$kind = 'directory'
try {
  Initialize-Permissions
  $payload = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
  $operation = 'validate-target'
  $target = Assert-RegularItem $payload.directory
  if (-not $target.PSIsContainer) { throw 'Staging is not a directory' }
  $operation = 'protect-acl'
  $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($owner)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($owner, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  $operation = 'validate-target'
  Assert-UnlinkedTarget $payload.directory
  $operation = 'write-acl'
  Set-Acl -LiteralPath $payload.directory -AclObject $acl -ErrorAction Stop
  $operation = 'verify-acl'
  Assert-Permissions $acl $payload.directory
  Complete-Permissions
  exit 0
} catch { Fail-Permissions $_; exit 1 }
`

const failureMessage = 'Could not preserve Windows data permissions; migration was stopped'

function permissionDiagnostic(output: string, exitCode: number | null): string | undefined {
  try {
    const value: unknown = JSON.parse(output)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const result = value as Record<string, unknown>
    if (result.version !== 1) return
    if (exitCode === 0 && result.ok === true && Object.keys(result).length === 2) return 'ok'
    if (exitCode !== 1 || result.ok !== false || Object.keys(result).sort().join(',') !== 'entry,hresult,kind,ok,operation,phase,type,version') return
    if (typeof result.phase !== 'string' || !['restrict', 'preflight', 'preserve'].includes(result.phase) ||
      typeof result.operation !== 'string' || !['initialize', 'validate-source', 'validate-target', 'create-probe', 'read-acl', 'protect-acl', 'write-acl', 'verify-acl', 'remove-probe'].includes(result.operation) ||
      typeof result.kind !== 'string' || !['unknown', 'file', 'directory'].includes(result.kind) ||
      typeof result.type !== 'string' || !['UnauthorizedAccessException', 'PrivilegeNotHeldException', 'IOException', 'FileNotFoundException', 'DirectoryNotFoundException', 'SecurityException', 'ArgumentException', 'Other'].includes(result.type) ||
      typeof result.entry !== 'number' || !Number.isSafeInteger(result.entry) || result.entry < -1 || result.entry > 10_000_000 ||
      typeof result.hresult !== 'string' || !/^0x[0-9A-F]{8}$/.test(result.hresult)) return
    return `phase=${result.phase} operation=${result.operation} entry=${result.entry} kind=${result.kind} type=${result.type} hresult=${result.hresult} exit=1`
  } catch { return }
}

export function createWindowsMigrationPermissionsRunner(spawnProcess: typeof spawn = spawn, platform: NodeJS.Platform = process.platform): MigrationPermissionsRunner {
  return async (script, input, signal) => {
    if (platform !== 'win32') throw new Error('Windows migration permissions are unavailable on this platform')
    signal?.throwIfAborted()
    const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    await new Promise<void>((resolve, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
          windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'], timeout: 60_000, signal,
        })
      } catch { reject(new Error(`${failureMessage} [win-acl/v1 process-error]`)); return }
      // Only the bounded, allowlisted protocol may reach status.error. Never
      // reflect stderr, exception messages, paths, account names or SIDs.
      let failed: string | undefined
      let output = ''
      let bytes = 0
      const stop = (reason: string) => { failed ??= reason; child.kill() }
      child.once('error', () => stop('process-error'))
      child.stdin!.once('error', () => stop('input-error'))
      child.stdout!.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 4096) { output = ''; stop('output-limit'); return }
        output += chunk.toString('utf8')
      })
      child.stdout!.once('error', () => stop('output-error'))
      // Wait for close even on abort or EPIPE, so rollback never races a still
      // running ACL writer. spawn's signal/timeout also terminate the child.
      child.once('close', (code: number | null) => {
        const diagnostic = failed || signal?.aborted ? undefined : permissionDiagnostic(output, code)
        if (diagnostic === 'ok') resolve()
        else reject(new Error(`${failureMessage} [win-acl/v1 ${signal?.aborted ? 'cancelled' : failed ?? diagnostic ?? (code === 0 ? 'invalid-response' : 'process-failed')}]`))
      })
      try { child.stdin!.end(input, 'utf8') } catch { stop('input-error') }
    })
  }
}

const systemRunner = createWindowsMigrationPermissionsRunner()

async function regularItem(file: string, directoryOnly = false): Promise<import('node:fs').BigIntStats> {
  if (!path.isAbsolute(file) || file.includes('\0')) throw new Error('Invalid migration permission path')
  const stat = await fs.lstat(file, { bigint: true })
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (directoryOnly && !stat.isDirectory())) throw new Error('Migration permissions cannot be applied to links or special entries')
  return stat
}

async function assertUnlinkedTarget(file: string): Promise<void> {
  let current = path.dirname(path.resolve(file))
  for (;;) {
    await regularItem(current, true)
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

/** Call immediately after creating the empty private stage, before any copy. */
export async function restrictWindowsMigrationStaging(stagingDir: string, signal?: AbortSignal, runner: MigrationPermissionsRunner = systemRunner): Promise<void> {
  signal?.throwIfAborted()
  await regularItem(stagingDir, true)
  await assertUnlinkedTarget(stagingDir)
  await runner(restrictScript, JSON.stringify({ directory: stagingDir }), signal)
  signal?.throwIfAborted()
}

/** Copies DACLs and owners to independent copies, never updating a source ACL. */
export async function preserveWindowsMigrationPermissions(entries: MigrationPermissionEntry[], signal?: AbortSignal, runner: MigrationPermissionsRunner = systemRunner): Promise<void> {
  signal?.throwIfAborted()
  const sourcePaths = new Set(entries.map(entry => path.resolve(entry.source).toLowerCase()))
  for (const entry of entries) {
    signal?.throwIfAborted()
    if (sourcePaths.has(path.resolve(entry.target).toLowerCase())) throw new Error('Migration permissions must not modify a source entry')
    const source = await regularItem(entry.source)
    const target = await regularItem(entry.target)
    await assertUnlinkedTarget(entry.target)
    if (source.isDirectory() !== target.isDirectory() || (target.isFile() && target.nlink !== 1n) || (source.ino !== 0n && source.dev === target.dev && source.ino === target.ino)) throw new Error('Migration permissions require an independent copy')
  }
  // Protect descendants first so replacing a parent DACL cannot retain or
  // propagate the wider ACL inherited from the destination volume.
  const ordered = entries.map((entry, index) => ({ ...entry, index })).sort((left, right) => right.target.split(/[\\/]/).length - left.target.split(/[\\/]/).length)
  for (let index = 0; index < ordered.length; index += 128) {
    signal?.throwIfAborted()
    const batch = ordered.slice(index, index + 128)
    for (const entry of batch) {
      const target = await regularItem(entry.target)
      if (target.isFile() && target.nlink !== 1n) throw new Error('Migration permissions require an independent copy')
      await assertUnlinkedTarget(entry.target)
      signal?.throwIfAborted()
    }
    await runner(preserveScript, JSON.stringify({ entries: batch }), signal)
  }
  signal?.throwIfAborted()
}

/** Try strict Owner/DACL preservation on empty probes before copying any data. */
export async function preflightWindowsMigrationPermissions(sources: string[], stagingDir: string, signal?: AbortSignal, runner: MigrationPermissionsRunner = systemRunner): Promise<void> {
  signal?.throwIfAborted()
  const staging = await regularItem(stagingDir, true)
  await assertUnlinkedTarget(stagingDir)
  if ((await fs.readdir(stagingDir)).length) throw new Error('Permission preflight requires empty private staging')
  const entries = sources.map((source, index) => ({ source, index }))
  for (let index = 0; index < entries.length; index += 128) {
    signal?.throwIfAborted()
    const current = await regularItem(stagingDir, true)
    if (current.dev !== staging.dev || current.ino !== staging.ino) throw new Error('Migration staging directory changed')
    await assertUnlinkedTarget(stagingDir)
    const batch = entries.slice(index, index + 128)
    for (const entry of batch) {
      const source = await regularItem(entry.source)
      const relative = path.relative(stagingDir, entry.source)
      const stageRelative = path.relative(entry.source, stagingDir)
      if (source.isDirectory() && !path.isAbsolute(stageRelative) && stageRelative !== '..' && !stageRelative.startsWith(`..${path.sep}`)) throw new Error('Permission probes must be independent of source entries')
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) ||
        (source.ino !== 0n && source.dev === staging.dev && source.ino === staging.ino)) throw new Error('Permission probes must be independent of source entries')
    }
    await runner(preflightScript, JSON.stringify({ directory: stagingDir, entries: batch }), signal)
    signal?.throwIfAborted()
    const after = await regularItem(stagingDir, true)
    if (after.dev !== staging.dev || after.ino !== staging.ino) throw new Error('Migration staging directory changed')
    await assertUnlinkedTarget(stagingDir)
    if ((await fs.readdir(stagingDir)).length) throw new Error('Permission preflight did not clean up its probes')
  }
}
