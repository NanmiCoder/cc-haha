import { spawn, spawnSync, type SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWindowsMigrationPermissionsRunner, preflightWindowsMigrationPermissions, preserveWindowsMigrationPermissions, restrictWindowsMigrationStaging, type MigrationPermissionsRunner } from './migrationPermissions'

// Non-Windows hosts can exercise script control flow without emulating NTFS.
const canRunPowerShell = process.platform === 'win32' || spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore', timeout: 5_000 }).status === 0

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
    expect(script).toContain('Get-Acl -LiteralPath $sourcePath')
    expect(script).toContain('Set-Acl -LiteralPath $targetPath')
    expect(script).not.toContain('Set-Acl -LiteralPath $entry.source')
    expect(JSON.parse(input)).toEqual({ entries: [{ source: f.sourceFile, target: f.targetFile, index: 1 }, { source: f.sourceDir, target: f.targetDir, index: 0 }] })
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
    const child = Object.assign(new EventEmitter(), { stdin, stdout: new PassThrough(), kill: vi.fn(() => true) })
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
    expect(spawnProcess.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'], timeout: 60_000, signal: abort.signal })
    child.emit('close', null)
    await expect(operation).rejects.toThrow('migration was stopped')
  })

  it('reports only bounded structured ACL diagnostics after the writer closes', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdin, stdout, kill: vi.fn(() => true) })
    const runner = createWindowsMigrationPermissionsRunner((() => child) as unknown as typeof spawn, 'win32')
    const operation = runner('fixture', '{}')
    let settled = false
    void operation.catch(() => { settled = true })
    stdout.write(JSON.stringify({ version: 1, ok: false, phase: 'preserve', operation: 'write-acl', entry: 128, kind: 'directory', type: 'UnauthorizedAccessException', hresult: '0x80070005' }))
    await new Promise(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    child.emit('close', 1)
    await expect(operation).rejects.toThrow('phase=preserve operation=write-acl entry=128 kind=directory type=UnauthorizedAccessException hresult=0x80070005 exit=1')
  })

  it.each([['private text', 'raw private path C:\\Users\\secret'], ['success on failure', '{"version":1,"ok":true}'], ['oversized', 'x'.repeat(4097)]])('fails closed without reflecting invalid failure output: %s', async (_label, output) => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdin, stdout, kill: vi.fn(() => true) })
    const runner = createWindowsMigrationPermissionsRunner((() => child) as unknown as typeof spawn, 'win32')
    const operation = runner('fixture', '{}')
    stdout.write(output)
    child.emit('close', 1)
    await expect(operation).rejects.toThrow('migration was stopped')
    await expect(operation).rejects.not.toThrow(output)
  })

  it.each([
    ['', 0, false],
    ['{"version":1,"ok":true}', 0, true],
    ['{"version":1,"ok":true}', null, false],
    ['{"version":1,"ok":true,"private":"secret"}', 0, false],
    ['{"version":1,"ok":false,"phase":"preserve","operation":"write-acl","entry":0,"kind":"file","type":"Other","hresult":"0x80070005"}', 0, false],
  ])('requires a successful protocol and exit status (%#)', async (output, code, success) => {
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, kill: vi.fn(() => true) })
    const runner = createWindowsMigrationPermissionsRunner((() => child) as unknown as typeof spawn, 'win32')
    const operation = runner('fixture', '{}')
    stdout.write(output as string)
    child.emit('close', code)
    if (success) await expect(operation).resolves.toBeUndefined()
    else await expect(operation).rejects.toThrow('migration was stopped')
  })

  it.each(['phase', 'operation', 'kind', 'type', 'hresult', 'entry', 'extra'])('does not leak untrusted diagnostic field %s', async field => {
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, kill: vi.fn(() => true) })
    const runner = createWindowsMigrationPermissionsRunner((() => child) as unknown as typeof spawn, 'win32')
    const operation = runner('fixture', '{}')
    stdout.write(JSON.stringify({ version: 1, ok: false, phase: 'preflight', operation: 'read-acl', entry: 0, kind: 'file', type: 'Other', hresult: '0x80070005', [field]: 'private account path SID' }))
    child.emit('close', 1)
    await expect(operation).rejects.toThrow('process-failed')
    await expect(operation).rejects.not.toThrow('private')
  })

  it('kills oversized output but does not settle until close, even with exit zero', async () => {
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, kill: vi.fn(() => true) })
    const runner = createWindowsMigrationPermissionsRunner((() => child) as unknown as typeof spawn, 'win32')
    const operation = runner('fixture', '{}')
    let settled = false
    void operation.catch(() => { settled = true })
    stdout.write(Buffer.alloc(4097, 120))
    await new Promise(resolve => setImmediate(resolve))
    expect(child.kill).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    child.emit('close', 0)
    await expect(operation).rejects.toThrow('output-limit')
  })

  it('fails closed on timeout termination and on abort with a late success reply', async () => {
    for (const aborting of [false, true]) {
      const stdout = new PassThrough()
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, kill: vi.fn(() => true) })
      const abort = new AbortController()
      const runner = createWindowsMigrationPermissionsRunner((() => child) as unknown as typeof spawn, 'win32')
      const operation = runner('fixture', '{}', abort.signal)
      if (aborting) { abort.abort(); stdout.write('{"version":1,"ok":true}') }
      child.emit('close', aborting ? 0 : null, aborting ? null : 'SIGTERM')
      await expect(operation).rejects.toThrow(aborting ? 'cancelled' : 'process-failed')
    }
  })

  it('preflights empty file and directory probes in bounded batches with stable indices', async () => {
    const f = await fixture()
    const stage = path.join(f.targetDir, 'private-stage')
    await fs.mkdir(stage)
    const sources = [f.sourceDir, ...Array.from({ length: 128 }, () => f.sourceFile)]
    const runner = vi.fn<MigrationPermissionsRunner>(async () => {})
    await preflightWindowsMigrationPermissions(sources, stage, undefined, runner)
    expect(runner.mock.calls.map(call => JSON.parse(call[1]).entries.length)).toEqual([128, 1])
    expect(JSON.parse(runner.mock.calls[1]![1]).entries).toEqual([{ source: f.sourceFile, index: 128 }])
    const script = runner.mock.calls[0]![0]
    expect(script).toContain('Write-Permissions $acl $probe')
    expect(script).toContain('FileMode]::CreateNew')
    expect(script).toContain('Remove-Item -LiteralPath $probe')
    expect(script).toContain('$expected.GetOwner($sidType).Value -ne $actual.GetOwner($sidType).Value')
    expect(script).not.toContain(f.sourceFile)
    expect(await fs.readFile(f.sourceFile, 'utf8')).toBe('source fixture bytes')
    expect(await fs.readdir(stage)).toEqual([])
  })

  it('rejects source/staging overlap, linked paths and leftover probes', async () => {
    const f = await fixture()
    const runner = vi.fn<MigrationPermissionsRunner>(async () => {})
    await expect(preflightWindowsMigrationPermissions([f.sourceFile], f.targetDir, undefined, runner)).rejects.toThrow('empty private staging')
    const stage = path.join(f.targetDir, 'private-stage')
    await fs.mkdir(stage)
    await expect(preflightWindowsMigrationPermissions([stage], stage, undefined, runner)).rejects.toThrow('independent')
    await expect(preflightWindowsMigrationPermissions([f.targetDir], stage, undefined, runner)).rejects.toThrow('independent')
    const link = path.join(f.root, 'linked-stage')
    await fs.symlink(stage, link, 'junction')
    await expect(preflightWindowsMigrationPermissions([f.sourceFile], link, undefined, runner)).rejects.toThrow('links')
    expect(runner).not.toHaveBeenCalled()
    await expect(preflightWindowsMigrationPermissions([f.sourceFile], stage, undefined, async () => {
      await fs.writeFile(path.join(stage, 'leftover-empty-probe'), '')
    })).rejects.toThrow('clean up')
  })

  it('stops permission preflight batches on failure or cancellation', async () => {
    const f = await fixture()
    const stage = path.join(f.targetDir, 'private-stage')
    await fs.mkdir(stage)
    const sources = Array.from({ length: 129 }, () => f.sourceFile)
    const failing = vi.fn<MigrationPermissionsRunner>(async () => { throw new Error('preflight denied') })
    await expect(preflightWindowsMigrationPermissions(sources, stage, undefined, failing)).rejects.toThrow('preflight denied')
    expect(failing).toHaveBeenCalledOnce()
    const abort = new AbortController()
    const cancelling = vi.fn<MigrationPermissionsRunner>(async () => { abort.abort(new Error('cancel preflight')) })
    await expect(preflightWindowsMigrationPermissions(sources, stage, abort.signal, cancelling)).rejects.toThrow('cancel preflight')
    expect(cancelling).toHaveBeenCalledOnce()
    expect(await fs.readdir(stage)).toEqual([])
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

  it.skipIf(!canRunPowerShell).each(['file', 'directory'])('leaves no probe when reading a %s ACL fails in the actual script', async kind => {
    const f = await fixture()
    const stage = path.join(f.targetDir, 'private-stage')
    await fs.mkdir(stage)
    const spawnProcess = ((executable: string, args: readonly string[], options: SpawnOptions) =>
      spawn(process.platform === 'win32' ? executable : 'pwsh', args, options)) as unknown as typeof spawn
    const runner = createWindowsMigrationPermissionsRunner(spawnProcess, 'win32')
    const rejectingRead: MigrationPermissionsRunner = (script, input, signal) => runner(
      script.replace("$phase = 'preflight'", "function Get-Acl { throw [System.UnauthorizedAccessException]::new('fixture read denied') }\n$phase = 'preflight'"),
      input, signal,
    )
    await expect(preflightWindowsMigrationPermissions([kind === 'file' ? f.sourceFile : f.sourceDir], stage, undefined, rejectingRead))
      .rejects.toThrow(`phase=preflight operation=read-acl entry=0 kind=${kind} type=UnauthorizedAccessException hresult=0x80070005 exit=1`)
    expect(await fs.readdir(stage)).toEqual([])
    expect(await fs.readFile(f.sourceFile, 'utf8')).toBe('source fixture bytes')
  }, 30_000)

  it.skipIf(process.platform !== 'win32')('preflights real current-user file and directory ACLs without changing source or stage ACLs', async () => {
    const f = await fixture()
    const stage = path.join(f.targetDir, 'private-stage')
    await fs.mkdir(stage)
    await restrictWindowsMigrationStaging(stage)
    await restrictWindowsMigrationStaging(f.sourceParent)
    const payload = { paths: [f.sourceDir, f.sourceFile, stage] }
    const snapshot = `
      $before = @($payload.paths | ForEach-Object { (Get-Acl -LiteralPath $_).Sddl }) -join '|'
      $hash = [System.Security.Cryptography.SHA256]::Create()
      [Convert]::ToBase64String($hash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($before)))
    `
    const before = await powershell(snapshot, payload)
    await preflightWindowsMigrationPermissions([f.sourceFile, f.sourceDir], stage)
    expect(await powershell(snapshot, payload)).toBe(before)
    expect(await fs.readdir(stage)).toEqual([])
    expect(await fs.readFile(f.sourceFile, 'utf8')).toBe('source fixture bytes')
  }, 30_000)

  it.skipIf(process.platform !== 'win32')('reports a real read-ACL denial before creating a probe', async () => {
    const f = await fixture()
    const stage = path.join(f.targetDir, 'private-stage')
    await fs.mkdir(stage)
    await restrictWindowsMigrationStaging(stage)
    // OWNER RIGHTS replaces the owner's implicit READ_CONTROL/WRITE_DAC.
    // Retain ChangePermissions so finally can restore this disposable ACL.
    await powershell(`
      $acl = Get-Acl -LiteralPath $payload.sourceDir
      $ownerRights = [System.Security.Principal.SecurityIdentifier]::new('S-1-3-4')
      $deny = [System.Security.AccessControl.FileSystemAccessRule]::new($ownerRights, [System.Security.AccessControl.FileSystemRights]::ReadPermissions, [System.Security.AccessControl.AccessControlType]::Deny)
      $allow = [System.Security.AccessControl.FileSystemAccessRule]::new($ownerRights, [System.Security.AccessControl.FileSystemRights]::ChangePermissions, [System.Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($deny)
      $acl.AddAccessRule($allow)
      Set-Acl -LiteralPath $payload.sourceDir -AclObject $acl
    `, f)
    try {
      await expect(preflightWindowsMigrationPermissions([f.sourceDir], stage)).rejects.toThrow('phase=preflight operation=read-acl entry=0 kind=directory')
      expect(await fs.readdir(stage)).toEqual([])
      expect(await fs.readFile(f.sourceFile, 'utf8')).toBe('source fixture bytes')
    } finally {
      await restrictWindowsMigrationStaging(f.sourceDir)
    }
  }, 30_000)

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
