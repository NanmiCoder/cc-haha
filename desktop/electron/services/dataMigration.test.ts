import * as fs from 'node:fs/promises'
import nativeFs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataMigration, MIGRATION_JOURNAL_FILE, type DataMigrationHooks } from './dataMigration'
import type { AppModeAppLike } from './appMode'
import { resolveRelocatedAttachmentPath } from '../../../src/utils/storageRelocations'
import { assertMigrationManifest, migrationManifest, validateMigrationManifest } from './dataMigrationFiles'

const roots: string[] = []
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'haha-migration-'))
  roots.push(root)
  const home = path.join(root, 'home')
  const source = path.join(home, '.claude')
  const target = path.join(root, '新数据 directory')
  const userData = path.join(root, 'profile')
  await fs.mkdir(source, { recursive: true })
  await fs.mkdir(path.join(root, 'install'), { recursive: true })
  const app: AppModeAppLike = { getPath(name) { return name === 'home' ? home : name === 'userData' ? userData : path.join(root, 'install', 'haha.exe') } }
  const hooks: DataMigrationHooks = { preview: vi.fn(async () => ({ activeTasks: 2, externalProcesses: 0 })), quiesce: vi.fn(async () => {}), resume: vi.fn(async () => {}), restart: vi.fn(), progress: vi.fn(), platform: 'win32', permissions: { restrictStaging: vi.fn(async () => {}), preserve: vi.fn(async () => {}) } }
  const put = async (relative: string, value: string) => {
    const file = path.join(source, relative)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, value)
  }
  await put('settings.json', '{"unknown":{"preserve":true}}')
  await put('projects/fixture/session.jsonl', '{"type":"user","message":"hello"}\n')
  await put('uploads/session/file.txt', 'attachment bytes')
  await fs.writeFile(path.join(home, '.claude.json'), '{"trustedProjects":{"x":true},"unknown":7}')
  return { root, home, source, target, userData, app, hooks, put, migration: new DataMigration(app, hooks, {}) }
}

afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

describe('data directory migration', () => {
  it('previews without stopping work and switches only after a verified complete copy', async () => {
    const f = await fixture()
    await f.put('cc-haha/db/index-v1.sqlite', 'regenerable')
    await f.put('cc-haha/db/unknown.sqlite', 'protected unknown database')
    await f.put('.runtime/venv/Scripts/pip.exe', 'old absolute-path executable')
    await f.put('.runtime/requirements.sha256', 'old dependency stamp')
    const original = await fs.readFile(path.join(f.source, 'settings.json'))
    const preview = await f.migration.prepare(f.target)
    expect(preview).toMatchObject({ sourceDir: f.source, targetDir: f.target, activeTasks: 2 })
    expect(f.hooks.quiesce).not.toHaveBeenCalled()
    expect(f.migration.status).toBeNull()
    await f.migration.start(preview.id)
    await f.migration.wait()
    expect(f.migration.status?.stage).toBe('restarting')
    expect(f.hooks.restart).toHaveBeenCalledOnce()
    expect(await fs.readFile(path.join(f.source, 'settings.json'))).toEqual(original)
    expect(await fs.readFile(path.join(f.target, 'settings.json'))).toEqual(original)
    expect(await fs.readFile(path.join(f.target, '.claude.json'), 'utf8')).toContain('"unknown":7')
    expect(await fs.readFile(path.join(f.target, 'projects/fixture/session.jsonl'), 'utf8')).toContain('hello')
    expect(await fs.readFile(path.join(f.target, 'cc-haha/db/unknown.sqlite'), 'utf8')).toBe('protected unknown database')
    await expect(fs.stat(path.join(f.target, 'cc-haha/db/index-v1.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.join(f.target, '.runtime/venv'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.join(f.target, '.runtime/requirements.sha256'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await fs.readFile(path.join(f.userData, 'app-mode.json'), 'utf8'))).toMatchObject({ mode: 'portable', portable_dir: f.target })
    await fs.rename(f.source, `${f.source}-retained`)
    expect(await fs.readFile(resolveRelocatedAttachmentPath(path.join(f.source, 'uploads/session/file.txt'), f.target), 'utf8')).toBe('attachment bytes')
  })

  it('rejects nonempty, overlapping, install-contained and externally controlled targets', async () => {
    const f = await fixture()
    await fs.mkdir(f.target)
    await fs.writeFile(path.join(f.target, 'keep'), 'existing data')
    await expect(f.migration.prepare(f.target)).rejects.toThrow('empty')
    await expect(f.migration.prepare(f.source)).rejects.toThrow('separate')
    await expect(f.migration.prepare(path.join(f.source, 'nested'))).rejects.toThrow('separate')
    await expect(f.migration.prepare(path.dirname(f.source))).rejects.toThrow('separate')
    await expect(f.migration.prepare(path.join(f.root, 'install', 'data'))).rejects.toThrow('install')
    const external = new DataMigration(f.app, f.hooks, { CLAUDE_CONFIG_DIR: f.source })
    await expect(external.prepare(path.join(f.root, 'empty'))).rejects.toThrow('launch environment')
    expect(await fs.readFile(path.join(f.target, 'keep'), 'utf8')).toBe('existing data')
    expect(f.hooks.quiesce).not.toHaveBeenCalled()
  })

  it('blocks outside writers before stopping any session', async () => {
    const f = await fixture()
    f.hooks.preview = async () => ({ activeTasks: 0, externalProcesses: 1 })
    await expect(f.migration.prepare(f.target)).rejects.toThrow('Another Claude process')
    expect(f.hooks.quiesce).not.toHaveBeenCalled()
  })

  it('checks free space before stopping work', async () => {
    const f = await fixture()
    vi.spyOn(nativeFs, 'statfs').mockImplementation(async () => ({ bavail: 0, bsize: 4096 } as never))
    syncBuiltinESMExports()
    await expect(f.migration.prepare(f.target)).rejects.toThrow('Not enough free space')
    expect(f.hooks.quiesce).not.toHaveBeenCalled()
    expect(await fs.readdir(f.target)).toEqual([])
  })

  it('relocates internal directory links without copying or changing external link data', async () => {
    const f = await fixture()
    await f.put('linked-data/file.txt', 'inside fixture')
    const external = path.join(f.root, 'external')
    await fs.mkdir(external)
    await fs.writeFile(path.join(external, 'keep'), 'external fixture')
    await fs.symlink(path.join(f.source, 'linked-data'), path.join(f.source, 'internal-link'), 'junction')
    await fs.symlink(external, path.join(f.source, 'external-link'), 'junction')
    const preview = await f.migration.prepare(f.target)
    await f.migration.start(preview.id)
    await f.migration.wait()
    expect(f.migration.status?.stage).toBe('restarting')
    expect((await fs.lstat(path.join(f.target, 'internal-link'))).isSymbolicLink()).toBe(true)
    expect(await fs.realpath(path.join(f.target, 'internal-link'))).toBe(await fs.realpath(path.join(f.target, 'linked-data')))
    expect(await fs.realpath(path.join(f.target, 'external-link'))).toBe(await fs.realpath(external))
    await fs.rename(f.source, `${f.source}-retained`)
    expect(await fs.readFile(path.join(f.target, 'internal-link/file.txt'), 'utf8')).toBe('inside fixture')
    expect(await fs.readFile(path.join(external, 'keep'), 'utf8')).toBe('external fixture')
  })

  it('preserves canonical-path attachments and internal links when the runtime root is an alias', async () => {
    const f = await fixture()
    const alias = path.join(f.root, 'active-data-alias')
    await fs.symlink(f.source, alias, 'junction')
    await fs.symlink(path.join(f.source, 'uploads'), path.join(f.source, 'internal-link'), 'junction')
    const migration = new DataMigration(f.app, f.hooks, { CLAUDE_CONFIG_DIR: alias, CC_HAHA_APP_PORTABLE_DIR: '1' })
    const preview = await migration.prepare(f.target)
    expect(preview.sourceDir).toBe(alias)
    await migration.start(preview.id)
    await migration.wait()
    expect(migration.status?.stage).toBe('restarting')
    await fs.rename(f.source, `${f.source}-retained`)
    expect(await fs.readFile(path.join(f.target, 'internal-link/session/file.txt'), 'utf8')).toBe('attachment bytes')
    for (const previous of [alias, f.source]) {
      expect(await fs.readFile(resolveRelocatedAttachmentPath(path.join(previous, 'uploads/session/file.txt'), f.target), 'utf8')).toBe('attachment bytes')
    }
  })

  it('fails safely when a target runs out of space during publication', async () => {
    const f = await fixture()
    const rename = fs.rename
    vi.spyOn(nativeFs, 'rename').mockImplementation(async (source, target) => {
      if (String(source).includes('.cc-haha-migration-')) throw Object.assign(new Error('Target disk is full'), { code: 'ENOSPC' })
      return rename(source, target)
    })
    syncBuiltinESMExports()
    const preview = await f.migration.prepare(f.target)
    await f.migration.start(preview.id)
    await f.migration.wait()
    expect(f.migration.status).toMatchObject({ stage: 'failed', error: 'Target disk is full' })
    expect(f.hooks.resume).toHaveBeenCalledOnce()
    expect(f.hooks.restart).not.toHaveBeenCalled()
    expect(await fs.readdir(f.target)).toEqual([])
    expect(await fs.readFile(path.join(f.source, 'settings.json'), 'utf8')).toContain('preserve')
    await expect(fs.stat(path.join(f.userData, 'app-mode.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores file and directory permissions after copying children and rewriting managed metadata', async () => {
    const f = await fixture()
    await f.put('protected/unknown.txt', 'read-only data')
    const directory = path.join(f.source, 'protected')
    await fs.chmod(directory, 0o500)
    await fs.chmod(path.join(directory, 'unknown.txt'), 0o400)
    const originalMode = (await fs.stat(directory)).mode
    try {
      const preview = await f.migration.prepare(f.target)
      await f.migration.start(preview.id)
      await f.migration.wait()
      expect(f.migration.status?.stage).toBe('restarting')
      expect(await fs.readFile(path.join(f.target, 'protected/unknown.txt'), 'utf8')).toBe('read-only data')
      expect((await fs.stat(path.join(f.target, 'protected'))).mode).toBe(originalMode)
      if (process.platform !== 'win32') expect((await fs.stat(path.join(f.target, 'protected'))).mode & 0o777).toBe(0o500)
    } finally {
      // Leave disposable fixtures writable for cleanup on Unix too.
      await fs.chmod(directory, 0o700)
      await fs.chmod(path.join(f.target, 'protected'), 0o700).catch(() => {})
    }
  })

  it('fails safely on copy permission errors and never switches the original pointer', async () => {
    const f = await fixture()
    const mkdir = fs.mkdir
    vi.spyOn(nativeFs, 'mkdir').mockImplementation((async (directory: string, options: unknown) => {
      if (String(directory).includes('.cc-haha-migration-')) return Promise.reject(Object.assign(new Error('Copy permission denied'), { code: 'EACCES' }))
      return mkdir(directory, options as never)
    }) as typeof fs.mkdir)
    syncBuiltinESMExports()
    const preview = await f.migration.prepare(f.target)
    await f.migration.start(preview.id)
    await f.migration.wait()
    expect(f.migration.status).toMatchObject({ stage: 'failed', error: 'Copy permission denied' })
    expect(await fs.readdir(f.target)).toEqual([])
    expect(f.hooks.restart).not.toHaveBeenCalled()
    expect(f.hooks.resume).toHaveBeenCalledOnce()
  })

  it('does not copy before Windows staging is protected or commit after an ACL failure', async () => {
    const f = await fixture()
    f.hooks.permissions!.restrictStaging = async directory => {
      expect(await fs.readdir(directory)).toEqual([])
      expect(f.hooks.quiesce).toHaveBeenCalledOnce()
    }
    f.hooks.permissions!.preserve = async () => { throw new Error('Windows permission verification failed') }
    const preview = await f.migration.prepare(f.target)
    await f.migration.start(preview.id)
    await f.migration.wait()
    expect(f.migration.status).toMatchObject({ stage: 'failed', error: 'Windows permission verification failed' })
    expect(f.hooks.resume).toHaveBeenCalledOnce()
    expect(f.hooks.restart).not.toHaveBeenCalled()
    expect(await fs.readdir(f.target)).toEqual([])
    expect(await fs.readFile(path.join(f.source, 'settings.json'), 'utf8')).toContain('preserve')
  })

  it('cancels before commit, retains the source and resumes services without replaying work', async () => {
    const f = await fixture()
    f.hooks.progress = status => { if (status.stage === 'copying') f.migration.cancel(status.id) }
    const preview = await f.migration.prepare(f.target)
    await f.migration.start(preview.id)
    await f.migration.wait()
    expect(f.migration.status?.stage).toBe('cancelled')
    expect(f.hooks.resume).toHaveBeenCalledOnce()
    expect(f.hooks.restart).not.toHaveBeenCalled()
    expect(await fs.readdir(f.target)).toEqual([])
    await expect(fs.stat(path.join(f.userData, 'app-mode.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(f.source, 'uploads/session/file.txt'), 'utf8')).toBe('attachment bytes')
  })

  it('cancels a quit request even before the first journal write finishes', async () => {
    const f = await fixture()
    const preview = await f.migration.prepare(f.target)
    const started = f.migration.start(preview.id)
    f.migration.cancelActive()
    await started
    await f.migration.wait()
    expect(f.migration.status?.stage).toBe('cancelled')
    expect(f.hooks.quiesce).not.toHaveBeenCalled()
    expect(f.hooks.restart).not.toHaveBeenCalled()
    expect(await fs.readdir(f.target)).toEqual([])
  })

  it('never copies when the runtime cannot confirm quiescence', async () => {
    const f = await fixture()
    f.hooks.quiesce = async () => { throw new Error('process did not exit') }
    const preview = await f.migration.prepare(f.target)
    await f.migration.start(preview.id)
    await f.migration.wait()
    expect(f.migration.status).toMatchObject({ stage: 'failed', error: 'process did not exit' })
    expect(await fs.readdir(f.target)).toEqual([])
    expect(f.hooks.resume).toHaveBeenCalledOnce()
  })

  it('reports an unavailable original runtime when recovery after cancellation fails', async () => {
    const f = await fixture()
    f.hooks.progress = status => { if (status.stage === 'copying') f.migration.cancel(status.id) }
    f.hooks.resume = async () => { throw new Error('process is still draining') }
    const preview = await f.migration.prepare(f.target)
    await f.migration.start(preview.id)
    await f.migration.wait()
    expect(f.migration.status).toMatchObject({ stage: 'failed', error: expect.stringContaining('Original services could not restart: process is still draining') })
    expect(await fs.readdir(f.target)).toEqual([])
    expect(await fs.readFile(path.join(f.source, 'settings.json'), 'utf8')).toContain('preserve')
  })

  it('detects late source writes and preserves the original startup pointer', async () => {
    const f = await fixture()
    await fs.mkdir(f.userData)
    const old = '{"mode":"default","portable_dir":null,"unknown":{"keep":1}}'
    await fs.writeFile(path.join(f.userData, 'app-mode.json'), old)
    f.hooks.progress = status => { if (status.stage === 'verifying') require('node:fs').writeFileSync(path.join(f.source, 'settings.json'), '{"late":true}') }
    const preview = await f.migration.prepare(f.target)
    await f.migration.start(preview.id)
    await f.migration.wait()
    expect(f.migration.status?.stage).toBe('failed')
    expect(await fs.readFile(path.join(f.userData, 'app-mode.json'), 'utf8')).toBe(old)
    expect(f.hooks.restart).not.toHaveBeenCalled()
  })

  it('recovers a verified pending restart and retains its success receipt', async () => {
    const f = await fixture()
    const preview = await f.migration.prepare(f.target)
    await f.migration.start(preview.id)
    await f.migration.wait()
    const relaunched = new DataMigration(f.app, f.hooks, {})
    expect(await relaunched.recover()).toBe('validate')
    await relaunched.completeValidation()
    const later = new DataMigration(f.app, f.hooks, {})
    expect(await later.recover()).toBe('normal')
    expect(later.status).toMatchObject({ stage: 'completed', sourceDir: f.source, targetDir: f.target })
  })

  it('rolls back a corrupted target before any new tasks are allowed', async () => {
    const f = await fixture()
    const preview = await f.migration.prepare(f.target)
    await f.migration.start(preview.id)
    await f.migration.wait()
    await fs.writeFile(path.join(f.target, 'settings.json'), '{"tampered":true}')
    const relaunched = new DataMigration(f.app, f.hooks, {})
    expect(await relaunched.recover()).toBe('normal')
    expect(relaunched.status?.stage).toBe('failed')
    await expect(fs.stat(path.join(f.userData, 'app-mode.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(f.source, 'settings.json'), 'utf8')).toContain('preserve')
  })

  it.each(['directory', 'pointer'] as const)('fails closed when a completed migration loses its %s', async unavailable => {
    const f = await fixture()
    const preview = await f.migration.prepare(f.target)
    await f.migration.start(preview.id)
    await f.migration.wait()
    await f.migration.completeValidation()
    if (unavailable === 'directory') await fs.rename(f.target, `${f.target}-disconnected`)
    else await fs.rm(path.join(f.userData, 'app-mode.json'))
    const later = new DataMigration(f.app, f.hooks, {})
    await expect(later.recover()).rejects.toThrow(unavailable === 'directory' ? 'Migrated data directory is unavailable' : 'startup configuration is unavailable')
    expect(f.hooks.resume).not.toHaveBeenCalled()
    if (unavailable === 'directory') await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps deliberate default and external launch selections after a completed migration', async () => {
    const f = await fixture()
    const preview = await f.migration.prepare(f.target)
    await f.migration.start(preview.id)
    await f.migration.wait()
    await f.migration.completeValidation()
    await fs.rename(f.target, `${f.target}-disconnected`)
    const override = new DataMigration(f.app, f.hooks, { CLAUDE_CONFIG_DIR: path.join(f.root, 'explicit-data') })
    expect(await override.recover()).toBe('normal')
    await fs.writeFile(path.join(f.userData, 'app-mode.json'), '{"mode":"default","portable_dir":null,"unknown":7}')
    expect(await new DataMigration(f.app, f.hooks, {}).recover()).toBe('normal')
    expect(JSON.parse(await fs.readFile(path.join(f.userData, 'app-mode.json'), 'utf8')).unknown).toBe(7)
  })

  it('upgrades a v1 interrupted journal and removes only its private staging directory', async () => {
    const f = await fixture()
    await fs.mkdir(f.target)
    const id = 'fixture-id'
    const stagingDir = path.join(f.target, `.cc-haha-migration-${id}`)
    await fs.mkdir(stagingDir)
    await fs.writeFile(path.join(stagingDir, 'partial'), 'partial')
    await fs.writeFile(path.join(f.target, 'unrelated'), 'must survive')
    await fs.mkdir(f.userData)
    await fs.writeFile(path.join(f.userData, MIGRATION_JOURNAL_FILE), JSON.stringify({ version: 1, status: { id, sourceDir: f.source, targetDir: f.target, stage: 'copying', cancellable: true }, stagingDir, oldMode: '{"mode":"default","unknown":42}', manifest: [], createdCredentials: [], credentials: [] }))
    expect(await f.migration.recover()).toBe('normal')
    expect(f.migration.status?.stage).toBe('failed')
    expect(await fs.readFile(path.join(f.target, 'unrelated'), 'utf8')).toBe('must survive')
    expect(await fs.readFile(path.join(f.userData, 'app-mode.json'), 'utf8')).toContain('"unknown":42')
    await expect(fs.stat(stagingDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when startup rollback would recreate a missing original directory', async () => {
    const f = await fixture()
    const preview = await f.migration.prepare(f.target)
    await f.migration.start(preview.id)
    await f.migration.wait()
    await fs.rename(f.source, `${f.source}-retained`)
    await fs.writeFile(path.join(f.target, 'settings.json'), 'corrupted target')
    const recovered = new DataMigration(f.app, f.hooks, {})
    await expect(recovered.recover()).rejects.toThrow('Original data directory is unavailable')
    expect(JSON.parse(await fs.readFile(path.join(f.userData, 'app-mode.json'), 'utf8')).portable_dir).toBe(f.target)
    await expect(fs.stat(f.source)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['source', 'target'] as const)('rejects a replaced %s directory after preview even at the same canonical path', async directory => {
    const f = await fixture()
    const preview = await f.migration.prepare(f.target)
    const selected = f[directory]
    await fs.rename(selected, `${selected}-original`)
    await fs.mkdir(selected)
    await fs.writeFile(path.join(selected, 'keep'), 'replacement must survive')
    await f.migration.start(preview.id)
    await f.migration.wait()
    expect(f.migration.status).toMatchObject({ stage: 'failed', error: expect.stringContaining('replaced') })
    expect(f.hooks.quiesce).not.toHaveBeenCalled()
    expect(f.hooks.restart).not.toHaveBeenCalled()
    expect(await fs.readFile(path.join(selected, 'keep'), 'utf8')).toBe('replacement must survive')
    expect(await fs.readFile(path.join(directory === 'source' ? `${f.source}-original` : f.source, 'settings.json'), 'utf8')).toContain('preserve')
  })

  it('refuses a target junction swap before copying and never cleans through its replacement', async () => {
    const f = await fixture()
    const outside = path.join(f.root, 'outside')
    await fs.mkdir(outside)
    let replacementStage = ''
    f.hooks.progress = status => {
      if (status.stage !== 'copying') return
      const sync = require('node:fs') as typeof import('node:fs')
      sync.renameSync(f.target, `${f.target}-original`)
      replacementStage = path.join(outside, `.cc-haha-migration-${status.id}`)
      sync.mkdirSync(replacementStage)
      sync.writeFileSync(path.join(replacementStage, 'keep'), 'unrelated data')
      sync.symlinkSync(outside, f.target, 'junction')
    }
    const preview = await f.migration.prepare(f.target)
    await f.migration.start(preview.id)
    await f.migration.wait()
    expect(f.migration.status).toMatchObject({ stage: 'failed', error: expect.stringContaining('replaced') })
    expect(await fs.readFile(path.join(replacementStage, 'keep'), 'utf8')).toBe('unrelated data')
    expect(await fs.readdir(path.join(`${f.target}-original`, `.cc-haha-migration-${preview.id}`))).toEqual([])
    expect(await fs.readFile(path.join(f.source, 'settings.json'), 'utf8')).toContain('preserve')
    expect(f.hooks.resume).toHaveBeenCalledOnce()
    expect(f.hooks.restart).not.toHaveBeenCalled()
  })

  it('refuses a replaced target ancestor before verification and preserves external staging data', async () => {
    const f = await fixture()
    const parent = path.join(f.root, 'selected-parent')
    const target = path.join(parent, 'data')
    const outside = path.join(f.root, 'outside-parent')
    await fs.mkdir(path.join(outside, 'data'), { recursive: true })
    let replacementStage = ''
    f.hooks.progress = status => {
      if (status.stage !== 'verifying') return
      const sync = require('node:fs') as typeof import('node:fs')
      sync.renameSync(parent, `${parent}-original`)
      replacementStage = path.join(outside, 'data', `.cc-haha-migration-${status.id}`)
      sync.mkdirSync(replacementStage)
      sync.writeFileSync(path.join(replacementStage, 'keep'), 'external transaction')
      sync.symlinkSync(outside, parent, 'junction')
    }
    const preview = await f.migration.prepare(target)
    await f.migration.start(preview.id)
    await f.migration.wait()
    expect(f.migration.status).toMatchObject({ stage: 'failed', error: expect.stringContaining('replaced') })
    expect(await fs.readFile(path.join(replacementStage, 'keep'), 'utf8')).toBe('external transaction')
    expect(await fs.readFile(path.join(f.source, 'uploads/session/file.txt'), 'utf8')).toBe('attachment bytes')
    expect(f.hooks.restart).not.toHaveBeenCalled()
  })

  it('rechecks external writers at the commit boundary', async () => {
    const f = await fixture()
    let previews = 0
    f.hooks.preview = async () => ({ activeTasks: 0, externalProcesses: ++previews >= 3 ? 1 : 0 })
    const preview = await f.migration.prepare(f.target)
    await f.migration.start(preview.id)
    await f.migration.wait()
    expect(f.migration.status).toMatchObject({ stage: 'failed', error: expect.stringContaining('Another Claude process') })
    expect(await fs.readdir(f.target)).toEqual([])
    expect(f.hooks.restart).not.toHaveBeenCalled()
  })

  it('rejects hostile recovery records before restoring settings or deleting any directory', async () => {
    const f = await fixture()
    await fs.mkdir(f.target)
    await fs.mkdir(f.userData)
    const id = 'safe-id'
    const stagingDir = path.join(f.target, `.cc-haha-migration-${id}`)
    await fs.mkdir(stagingDir)
    await fs.writeFile(path.join(stagingDir, 'keep'), 'protected transaction')
    const journal = { version: 1, status: { id, sourceDir: f.source, targetDir: f.target, stage: 'copying', cancellable: true }, stagingDir, oldMode: '{"mode":"default"}', manifest: [], createdCredentials: [], credentials: [] }
    const digest = 'a'.repeat(64)
    const hostile = [
      { ...journal, stagingDir: f.target },
      { ...journal, stagingDir: f.source },
      { ...journal, status: { ...journal.status, id: '../escape' } },
      { ...journal, status: { ...journal.status, stage: 'unknown' } },
      { ...journal, status: { ...journal.status, sourceDir: path.dirname(f.target) } },
      { ...journal, manifest: [{ relative: '../settings.json', kind: 'file', digest }] },
      { ...journal, manifest: [{ relative: '..\\settings.json', kind: 'file', digest }] },
      { ...journal, manifest: [{ relative: f.source, kind: 'directory' }] },
      { ...journal, manifest: [{ relative: 'settings.json', kind: 'unexpected' }] },
      { ...journal, createdCredentials: [{ service: 'Claude Code', digest }] },
      { ...journal, oldMode: '[]' },
    ]
    for (const entry of hostile) {
      await fs.writeFile(path.join(f.userData, MIGRATION_JOURNAL_FILE), JSON.stringify(entry))
      const recovery = new DataMigration(f.app, f.hooks, {})
      await expect(recovery.recover()).rejects.toThrow()
      expect(await fs.readFile(path.join(stagingDir, 'keep'), 'utf8')).toBe('protected transaction')
      await expect(fs.stat(path.join(f.userData, 'app-mode.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await fs.readFile(path.join(f.source, 'settings.json'), 'utf8')).toContain('preserve')
  })

  it('rejects a legacy recovery target whose canonical path overlaps the source', async () => {
    const f = await fixture()
    await fs.symlink(f.source, f.target, 'junction')
    await fs.mkdir(f.userData)
    const id = 'safe-id'
    await fs.writeFile(path.join(f.source, 'keep'), 'source must survive')
    await fs.writeFile(path.join(f.userData, MIGRATION_JOURNAL_FILE), JSON.stringify({ version: 1, status: { id, sourceDir: f.source, targetDir: f.target, stage: 'copying' }, stagingDir: path.join(f.target, `.cc-haha-migration-${id}`), oldMode: null, manifest: [], credentials: [], createdCredentials: [] }))
    await expect(f.migration.recover()).rejects.toThrow('overlap')
    expect(await fs.readFile(path.join(f.source, 'keep'), 'utf8')).toBe('source must survive')
  })

  it('rejects a parent junction replacement even when manifest file bytes match', async () => {
    const f = await fixture()
    const manifest = await migrationManifest(f.source)
    const original = path.join(f.source, 'uploads')
    const outside = path.join(f.root, 'same-bytes')
    await fs.rename(original, outside)
    await fs.symlink(outside, original, 'junction')
    await expect(validateMigrationManifest(f.source, manifest)).rejects.toThrow()
    await expect(validateMigrationManifest(f.source, [{ relative: 'uploads/session/file.txt', kind: 'file', digest: manifest.find(file => file.relative === path.join('uploads', 'session', 'file.txt'))!.digest }])).rejects.toThrow('parent')
    expect(await fs.readFile(path.join(outside, 'session/file.txt'), 'utf8')).toBe('attachment bytes')
    expect(() => assertMigrationManifest([{ relative: 'a', kind: 'file' }])).toThrow()
  })
})
