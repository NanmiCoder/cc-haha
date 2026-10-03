import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWindowsMigrationPermissionsRunner, preserveWindowsMigrationPermissions, restrictWindowsMigrationStaging, type MigrationPermissionsRunner } from './migrationPermissions'

const roots: string[] = []
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'haha-migration-acl-')))
  roots.push(root)
  const sourceParent = path.join(root, 'source-parent')
  const targetParent = path.join(root, 'target-parent')
  const sourceDir = path.join(sourceParent, 'source')
  const targetDir = path.join(targetParent, 'target')
  await fs.mkdir(sourceDir, { recursive: true })
  await fs.mkdir(targetDir, { recursive: true })
  const sourceFile = path.join(sourceDir, "中 [literal]; $(Write-Output injected) '.txt")
  const targetFile = path.join(targetDir, "中 [literal]; $(Write-Output injected) '.txt")
  await fs.writeFile(sourceFile, 'source fixture bytes')
  await fs.copyFile(sourceFile, targetFile)
  return { root, sourceParent, targetParent, sourceDir, targetDir, sourceFile, targetFile }
}

afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })

function powershell(script: string, payload: object): Promise<string> {
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; $payload = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); ${script}`, 'utf16le').toString('base64')], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'], timeout: 60_000 })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { output += chunk })
    child.once('error', () => reject(new Error('Disposable ACL fixture could not run')))
    child.stdin.once('error', () => reject(new Error('Disposable ACL fixture input failed')))
    child.once('close', code => { if (code === 0) resolve(output.trim()); else reject(new Error('Disposable ACL fixture command failed')) })
    child.stdin.end(JSON.stringify(payload), 'utf8')
  })
}

describe('Windows migration permissions', () => {
  it('sends paths as JSON, converts inherited source rules and protects descendants first', async () => {
    const f = await fixture()
    const runner = vi.fn<MigrationPermissionsRunner>(async () => {})
    await preserveWindowsMigrationPermissions([{ source: f.sourceDir, target: f.targetDir }, { source: f.sourceFile, target: f.targetFile }], undefined, runner)
    expect(runner).toHaveBeenCalledOnce()
    const [script, input] = runner.mock.calls[0]!
    expect(script).not.toContain(f.sourceFile)
    expect(script).not.toContain(f.targetDir)
    expect(script).toContain('$acl.SetAccessRuleProtection($true, $true)')
    expect(script).toContain('Get-Acl -LiteralPath $entry.source')
    expect(script).toContain('Set-Acl -LiteralPath $entry.target')
    expect(script).not.toContain('Set-Acl -LiteralPath $entry.source')
    expect(JSON.parse(input)).toEqual({ entries: [{ source: f.sourceFile, target: f.targetFile }, { source: f.sourceDir, target: f.targetDir }] })
  })

  it('restricts staging to the current owner with protected inheritable FullControl', async () => {
    const f = await fixture()
    const runner = vi.fn<MigrationPermissionsRunner>(async () => {})
    await restrictWindowsMigrationStaging(f.targetDir, undefined, runner)
    const [script, input] = runner.mock.calls[0]!
    expect(JSON.parse(input)).toEqual({ directory: f.targetDir })
    expect(script).toContain('$acl.SetAccessRuleProtection($true, $false)')
    expect(script).toContain('WindowsIdentity]::GetCurrent().User')
    expect(script).toContain('FileSystemRights]::FullControl')
    expect(script).toContain('ContainerInherit, ObjectInherit')
    expect(script).not.toContain(f.targetDir)
  })

  it('rejects source targets and hardlinks without invoking ACL mutation', async () => {
    const f = await fixture()
    const runner = vi.fn<MigrationPermissionsRunner>(async () => {})
    await expect(preserveWindowsMigrationPermissions([{ source: f.sourceFile, target: f.sourceFile }], undefined, runner)).rejects.toThrow('source entry')
    const linked = path.join(f.targetDir, 'hardlink')
    await fs.link(f.sourceFile, linked)
    await expect(preserveWindowsMigrationPermissions([{ source: f.sourceFile, target: linked }], undefined, runner)).rejects.toThrow('independent copy')
    expect(runner).not.toHaveBeenCalled()
    expect(await fs.readFile(f.sourceFile, 'utf8')).toBe('source fixture bytes')
  })

  it('never applies permissions through a junction or symlink', async () => {
    const f = await fixture()
    const link = path.join(f.root, 'linked-directory')
    await fs.symlink(f.targetDir, link, 'junction')
    const runner = vi.fn<MigrationPermissionsRunner>(async () => {})
    await expect(restrictWindowsMigrationStaging(link, undefined, runner)).rejects.toThrow('links')
    await expect(preserveWindowsMigrationPermissions([{ source: f.sourceDir, target: link }], undefined, runner)).rejects.toThrow('links')
    await expect(preserveWindowsMigrationPermissions([{ source: link, target: f.sourceDir }], undefined, runner)).rejects.toThrow('links')
    expect(runner).not.toHaveBeenCalled()
    const parentLink = path.join(f.root, 'linked-parent')
    await fs.symlink(f.targetParent, parentLink, 'junction')
    const targetThroughParent = path.join(parentLink, path.basename(f.targetDir))
    await expect(restrictWindowsMigrationStaging(targetThroughParent, undefined, runner)).rejects.toThrow('links')
    await expect(preserveWindowsMigrationPermissions([{ source: f.sourceDir, target: targetThroughParent }], undefined, runner)).rejects.toThrow('links')
    expect(runner).not.toHaveBeenCalled()
  })

  it.each(['process error', 'stdin error', 'abort'])('waits for child close after %s before allowing rollback', async event => {
    const stdin = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdin, kill: vi.fn(() => true) })
    const spawnProcess = vi.fn<(...args: Parameters<typeof spawn>) => typeof child>(() => child)
    const runner = createWindowsMigrationPermissionsRunner(spawnProcess as unknown as typeof spawn, 'win32')
    const abort = new AbortController()
    let settled = false
    const operation = runner('static fixture script', '{"fixture":true}', abort.signal)
    void operation.then(() => { settled = true }, () => { settled = true })
    if (event === 'stdin error') stdin.emit('error', new Error('private diagnostic'))
    else {
      if (event === 'abort') abort.abort()
      child.emit('error', new Error('private diagnostic'))
    }
    await new Promise(resolve => setImmediate(resolve))
    expect(child.kill).toHaveBeenCalled()
    expect(settled).toBe(false)
    expect(spawnProcess.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, shell: false, stdio: ['pipe', 'ignore', 'ignore'], timeout: 60_000, signal: abort.signal })
    child.emit('close', null)
    await expect(operation).rejects.toThrow('migration was stopped')
  })

  it('stops on an ACL failure and bounds entries in each process', async () => {
    const f = await fixture()
    const entries = Array.from({ length: 129 }, () => ({ source: f.sourceFile, target: f.targetFile }))
    const runner = vi.fn<MigrationPermissionsRunner>(async () => {})
    await preserveWindowsMigrationPermissions(entries, undefined, runner)
    expect(runner.mock.calls.map(call => JSON.parse(call[1]).entries.length)).toEqual([128, 1])
    const failing = vi.fn<MigrationPermissionsRunner>(async () => { throw new Error('ACL unavailable') })
    await expect(preserveWindowsMigrationPermissions(entries, undefined, failing)).rejects.toThrow('ACL unavailable')
    expect(failing).toHaveBeenCalledOnce()
  })

  it('honors cancellation before mutation and after each runner', async () => {
    const f = await fixture()
    const abort = new AbortController()
    const runner = vi.fn<MigrationPermissionsRunner>(async () => {})
    abort.abort(new Error('cancel fixture'))
    await expect(restrictWindowsMigrationStaging(f.targetDir, abort.signal, runner)).rejects.toThrow('cancel fixture')
    await expect(preserveWindowsMigrationPermissions([{ source: f.sourceFile, target: f.targetFile }], abort.signal, runner)).rejects.toThrow('cancel fixture')
    expect(runner).not.toHaveBeenCalled()
    const during = new AbortController()
    await expect(preserveWindowsMigrationPermissions([{ source: f.sourceFile, target: f.targetFile }], during.signal, async () => { during.abort(new Error('cancel during ACL')) })).rejects.toThrow('cancel during ACL')
  })

  it.skipIf(process.platform !== 'win32')('removes wider inherited target grants and leaves actual source ACLs unchanged', async () => {
    const f = await fixture()
    // Only disposable directories are changed. Give their two parent trees
    // different ACLs, reproducing a move to a volume with broader inheritance.
    await restrictWindowsMigrationStaging(f.sourceParent)
    const sourceHash = await powershell(`
      $acl = Get-Acl -LiteralPath $payload.targetParent
      $everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
      Set-Acl -LiteralPath $payload.targetParent -AclObject $acl
      $before = @($payload.sourceDir, $payload.sourceFile | ForEach-Object { (Get-Acl -LiteralPath $_).Sddl }) -join '|'
      $hash = [System.Security.Cryptography.SHA256]::Create()
      [Convert]::ToBase64String($hash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($before)))
    `, f)
    const before = JSON.parse(await powershell(`
      $sidType = [System.Security.Principal.SecurityIdentifier]
      $acl = Get-Acl -LiteralPath $payload.targetFile
      @{ wideInherited = @($acl.GetAccessRules($true, $true, $sidType) | Where-Object { $_.IdentityReference.Value -eq 'S-1-1-0' -and $_.IsInherited }).Count -gt 0; sourceInherited = -not (Get-Acl -LiteralPath $payload.sourceFile).AreAccessRulesProtected } | ConvertTo-Json -Compress
    `, f))
    expect(before).toEqual({ wideInherited: true, sourceInherited: true })
    await preserveWindowsMigrationPermissions([{ source: f.sourceDir, target: f.targetDir }, { source: f.sourceFile, target: f.targetFile }])
    const after = JSON.parse(await powershell(`
      $sidType = [System.Security.Principal.SecurityIdentifier]
      function Rules([string]$entry) { @((Get-Acl -LiteralPath $entry).GetAccessRules($true, $true, $sidType) | ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.IdentityReference.Value, [int]$_.FileSystemRights, [int]$_.InheritanceFlags, [int]$_.PropagationFlags, [int]$_.AccessControlType } | Sort-Object) -join '|' }
      $acl = Get-Acl -LiteralPath $payload.targetFile
      $current = @($payload.sourceDir, $payload.sourceFile | ForEach-Object { (Get-Acl -LiteralPath $_).Sddl }) -join '|'
      $hash = [System.Security.Cryptography.SHA256]::Create()
      @{ sourceHash = [Convert]::ToBase64String($hash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($current))); rulesEqual = (Rules $payload.sourceFile) -ceq (Rules $payload.targetFile); directoriesEqual = (Rules $payload.sourceDir) -ceq (Rules $payload.targetDir); protected = $acl.AreAccessRulesProtected; widerGrant = @($acl.GetAccessRules($true, $true, $sidType) | Where-Object { $_.IdentityReference.Value -eq 'S-1-1-0' }).Count -gt 0 } | ConvertTo-Json -Compress
    `, f))
    expect(after).toEqual({ sourceHash, rulesEqual: true, directoriesEqual: true, protected: true, widerGrant: false })
    expect(await fs.readFile(f.sourceFile, 'utf8')).toBe('source fixture bytes')
    expect(await fs.readFile(f.targetFile, 'utf8')).toBe('source fixture bytes')
  }, 30_000)

  it.skipIf(process.platform !== 'win32')('makes actual staging ACL current-user-only before files are copied', async () => {
    const f = await fixture()
    await restrictWindowsMigrationStaging(f.targetDir)
    const file = path.join(f.targetDir, 'created-after-restriction')
    await fs.writeFile(file, 'private fixture')
    const actual = JSON.parse(await powershell(`
      $sidType = [System.Security.Principal.SecurityIdentifier]
      $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      $acl = Get-Acl -LiteralPath $payload.directory
      $rules = @($acl.GetAccessRules($true, $true, $sidType))
      $fileRules = @((Get-Acl -LiteralPath $payload.file).GetAccessRules($true, $true, $sidType))
      @{ protected = $acl.AreAccessRulesProtected; onlyOwner = $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $owner -and $rules[0].FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl -and -not $rules[0].IsInherited; fileOnlyOwner = $fileRules.Count -eq 1 -and $fileRules[0].IdentityReference.Value -eq $owner -and $fileRules[0].IsInherited } | ConvertTo-Json -Compress
    `, { directory: f.targetDir, file }))
    expect(actual).toEqual({ protected: true, onlyOwner: true, fileOnlyOwner: true })
  }, 30_000)
})
