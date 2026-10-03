import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import path from 'node:path'

export type MigrationPermissionsRunner = (script: string, input: string, signal?: AbortSignal) => Promise<void>
export type MigrationPermissionEntry = { source: string; target: string }

const scriptPrelude = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
foreach ($module in @('Security', 'Management', 'Utility')) {
  Import-Module (Join-Path $PSHOME ('Modules/Microsoft.PowerShell.{0}/Microsoft.PowerShell.{0}.psd1' -f $module)) -ErrorAction Stop
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
`

const preserveScript = `${scriptPrelude}
try {
  $payload = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
  foreach ($entry in $payload.entries) {
    $source = Assert-RegularItem $entry.source
    $target = Assert-RegularItem $entry.target
    if ($source.PSIsContainer -ne $target.PSIsContainer -or [string]::Equals($source.FullName, $target.FullName, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid migration entry' }
    $acl = Get-Acl -LiteralPath $entry.source -ErrorAction Stop
    $acl.SetAccessRuleProtection($true, $true)
    Assert-UnlinkedTarget $entry.target
    Set-Acl -LiteralPath $entry.target -AclObject $acl -ErrorAction Stop
    Assert-Permissions $acl $entry.target
  }
  exit 0
} catch { exit 1 }
`

const restrictScript = `${scriptPrelude}
try {
  $payload = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
  $target = Assert-RegularItem $payload.directory
  if (-not $target.PSIsContainer) { throw 'Staging is not a directory' }
  $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($owner)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($owner, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  Assert-UnlinkedTarget $payload.directory
  Set-Acl -LiteralPath $payload.directory -AclObject $acl -ErrorAction Stop
  Assert-Permissions $acl $payload.directory
  exit 0
} catch { exit 1 }
`

export function createWindowsMigrationPermissionsRunner(spawnProcess: typeof spawn = spawn, platform: NodeJS.Platform = process.platform): MigrationPermissionsRunner {
  return async (script, input, signal) => {
    if (platform !== 'win32') throw new Error('Windows migration permissions are unavailable on this platform')
    signal?.throwIfAborted()
    const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    await new Promise<void>((resolve, reject) => {
      const child = spawnProcess(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'ignore'], timeout: 60_000, signal,
      })
      // Never include PowerShell diagnostics: paths and ACL identities belong
      // to user state and must not be exposed in a receipt.
      let failed = false
      const stop = () => { failed = true; child.kill() }
      child.once('error', stop)
      child.stdin!.once('error', stop)
      // Wait for close even on abort or EPIPE, so rollback never races a still
      // running ACL writer. spawn's signal/timeout also terminate the child.
      child.once('close', code => {
        if (!failed && code === 0) resolve()
        else reject(new Error('Could not preserve Windows data permissions; migration was stopped'))
      })
      try { child.stdin!.end(input, 'utf8') } catch { stop() }
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
  const ordered = [...entries].sort((left, right) => right.target.split(/[\\/]/).length - left.target.split(/[\\/]/).length)
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
