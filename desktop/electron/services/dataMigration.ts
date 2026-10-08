import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { MigrationPreview, MigrationStatus } from '../../src/lib/desktopHost/types'
import { relocateManagedData } from '../../../src/utils/storageMigrationMetadata'
import { normalizedCustomDir, setAppMode, systemClaudeConfigDir, type AppModeAppLike } from './appMode'
import { assertMigrationDirectory, assertMigrationManifest, assertUnlinkedDirectoryPath, canonicalPath, copyMigrationFiles, isWithin, migrationDirectoryIdentity, migrationManifest, restoreMigrationPermissions, scanMigrationFiles, validateMigrationManifest, verifyMigrationSource, type MigrationDirectoryIdentity, type VerifiedMigrationFile } from './dataMigrationFiles'
import { copyMigrationCredentials, removeMigrationCredentials, systemMigrationCredentialStore, verifyMigrationCredentials, type MigrationCredentialReceipt, type MigrationCredentialStore } from './migrationCredentials'
import { preserveWindowsMigrationPermissions, restrictWindowsMigrationStaging } from './migrationPermissions'

export const MIGRATION_JOURNAL_FILE = 'data-migration-v1.json'
type Journal = {
  version: 1
  status: MigrationStatus
  oldMode: string | null
  stagingDir: string
  manifest: VerifiedMigrationFile[]
  createdCredentials: MigrationCredentialReceipt[]
  credentials: MigrationCredentialReceipt[]
  directories?: { source: MigrationDirectoryIdentity; target: MigrationDirectoryIdentity }
  stagingIdentity?: MigrationDirectoryIdentity
}

const stages = ['preparing', 'quiescing', 'copying', 'verifying', 'committing', 'restarting', 'completed', 'failed', 'cancelled']
const absoluteDirectory = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value) && path.resolve(value) === value
const directoryIdentity = (value: unknown): value is MigrationDirectoryIdentity => {
  if (!value || typeof value !== 'object') return false
  const identity = value as MigrationDirectoryIdentity
  return absoluteDirectory(identity.canonical) && typeof identity.dev === 'string' && /^\d+$/.test(identity.dev) && typeof identity.ino === 'string' && /^\d+$/.test(identity.ino)
}

function parseJournal(value: unknown): Journal {
  if (!value || typeof value !== 'object') throw new Error('Unsupported migration recovery record')
  const parsed = value as Journal
  if (parsed.version !== 1 || !parsed.status || typeof parsed.status.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(parsed.status.id) ||
    !stages.includes(parsed.status.stage) || !absoluteDirectory(parsed.status.sourceDir) || !absoluteDirectory(parsed.status.targetDir) ||
    !absoluteDirectory(parsed.stagingDir) || parsed.stagingDir !== path.join(parsed.status.targetDir, `.cc-haha-migration-${parsed.status.id}`) ||
    !Array.isArray(parsed.createdCredentials) || !Array.isArray(parsed.credentials) || (parsed.oldMode !== null && typeof parsed.oldMode !== 'string') ||
    (parsed.directories !== undefined && (!directoryIdentity(parsed.directories?.source) || !directoryIdentity(parsed.directories?.target))) ||
    (parsed.stagingIdentity !== undefined && !directoryIdentity(parsed.stagingIdentity))) throw new Error('Unsupported migration recovery record')
  assertMigrationManifest(parsed.manifest)
  if (isWithin(parsed.status.sourceDir, parsed.status.targetDir) || isWithin(parsed.status.targetDir, parsed.status.sourceDir)) throw new Error('Migration recovery directories overlap')
  if (parsed.directories && (isWithin(parsed.directories.source.canonical, parsed.directories.target.canonical) || isWithin(parsed.directories.target.canonical, parsed.directories.source.canonical))) throw new Error('Migration recovery directories overlap')
  const targetHash = createHash('sha256').update(parsed.status.targetDir.normalize('NFC')).digest('hex').slice(0, 8)
  for (const receipts of [parsed.credentials, parsed.createdCredentials]) {
    const services = new Set<string>()
    for (const receipt of receipts) {
      if (!receipt || typeof receipt.service !== 'string' || !new RegExp(`^Claude Code(?:-(?:custom|staging|local)-oauth)?(?:-credentials)?-${targetHash}$`).test(receipt.service) ||
        typeof receipt.digest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.digest) || services.has(receipt.service)) throw new Error('Invalid migration credential receipt')
      services.add(receipt.service)
    }
  }
  if (parsed.oldMode !== null) {
    const mode: unknown = JSON.parse(parsed.oldMode)
    // Restore the user-owned snapshot byte for byte, including old defaults
    // and unknown fields. AppMode remains the authority for its known fields.
    if (!mode || typeof mode !== 'object' || Array.isArray(mode)) throw new Error('Invalid previous migration mode')
  }
  return parsed
}

export type DataMigrationHooks = {
  preview(): Promise<{ activeTasks: number; externalProcesses: number }>
  quiesce(): Promise<void>
  resume(): Promise<void>
  restart(): Promise<void> | void
  progress(status: MigrationStatus): void
  credentialStore?: MigrationCredentialStore
  permissions?: {
    restrictStaging(directory: string, signal: AbortSignal): Promise<void>
    preserve(entries: { source: string; target: string }[], signal: AbortSignal): Promise<void>
  }
  platform?: NodeJS.Platform
}

async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function atomicWrite(file: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(value)
    await handle.sync()
  } finally { await handle.close() }
  try { await fs.rename(temporary, file) } finally { await fs.rm(temporary, { force: true }) }
}

export class DataMigration {
  private previewState: MigrationPreview | null = null
  private previewDirectories: Journal['directories'] = undefined
  private journal: Journal | null = null
  private operation: Promise<void> | null = null
  private abort: AbortController | null = null
  private activeId: string | null = null
  get sourceDir(): string { return path.resolve(this.env.CLAUDE_CONFIG_DIR || systemClaudeConfigDir(this.app)) }
  get sourceDefault(): boolean { return !this.env.CLAUDE_CONFIG_DIR }
  private readonly journalPath: string
  private readonly modePath: string

  constructor(private readonly app: AppModeAppLike, private readonly hooks: DataMigrationHooks, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.journalPath = path.join(app.getPath('userData'), MIGRATION_JOURNAL_FILE)
    this.modePath = path.join(app.getPath('userData'), 'app-mode.json')
  }

  get running(): boolean { return this.operation !== null }
  get status(): MigrationStatus | null { return this.journal?.status ?? null }
  wait(): Promise<void> { return this.operation ?? Promise.resolve() }

  async prepare(targetDir: string): Promise<MigrationPreview> {
    if (this.running) throw new Error('Data migration is already running')
    this.previewState = null
    this.previewDirectories = undefined
    if (this.env.CLAUDE_CONFIG_DIR && this.env.CC_HAHA_APP_PORTABLE_DIR !== '1') throw new Error('CLAUDE_CONFIG_DIR is controlled by the launch environment')
    const target = normalizedCustomDir(this.app, targetDir)
    const sourceReal = await canonicalPath(this.sourceDir)
    const targetReal = await canonicalPath(target)
    if (isWithin(sourceReal, targetReal) || isWithin(targetReal, sourceReal)) throw new Error('Source and target data directories must be separate')
    if (await exists(target) && (await fs.readdir(target)).length) throw new Error('Choose an empty target directory; existing data will not be merged')
    await fs.mkdir(target, { recursive: true })
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('Choose a target directory without a link')
    const directories = { source: await migrationDirectoryIdentity(this.sourceDir), target: await migrationDirectoryIdentity(target) }
    if (path.relative(targetReal, directories.target.canonical) !== '' || path.relative(sourceReal, directories.source.canonical) !== '') throw new Error('Migration directory was replaced; choose the directory again')
    const probe = await fs.mkdtemp(path.join(target, '.migration-probe-'))
    const probeIdentity = await migrationDirectoryIdentity(probe)
    try {
      await this.assertDirectories(directories, this.sourceDir, target)
      await fs.writeFile(path.join(probe, 'probe'), '', { flag: 'wx' })
      const files = await scanMigrationFiles(this.sourceDir, this.sourceDefault ? this.app.getPath('home') : undefined)
      for (const file of files.filter(entry => entry.kind === 'link')) {
        const stat = await fs.stat(file.source).catch(() => null)
        const testLink = path.join(probe, 'link')
        await fs.symlink(file.source, testLink, stat?.isDirectory() ? 'junction' : 'file')
        await fs.unlink(testLink)
      }
      const bytes = files.reduce((sum, file) => sum + file.size, 0)
      const disk = await fs.statfs(target)
      if (disk.bavail * disk.bsize < bytes) throw new Error('Not enough free space in the target directory')
      const runtime = await this.hooks.preview()
      if (runtime.externalProcesses) throw new Error('Another Claude process is using this data directory; close it and retry')
      this.previewState = { id: randomUUID(), sourceDir: this.sourceDir, targetDir: target, files: files.length, bytes, activeTasks: runtime.activeTasks }
      await this.assertDirectories(directories, this.sourceDir, target)
      this.previewDirectories = directories
      return this.previewState
    } finally {
      await assertMigrationDirectory(target, directories.target)
      await assertMigrationDirectory(probe, probeIdentity)
      await fs.rm(probe, { recursive: true, force: true })
    }
  }

  async start(id: string): Promise<void> {
    if (this.running || !this.previewState || this.previewState.id !== id) throw new Error('Migration preview expired; choose the directory again')
    const preview = this.previewState
    const directories = this.previewDirectories
    this.previewState = null
    this.previewDirectories = undefined
    // Mark running synchronously before any await, blocking two simultaneous starts.
    this.abort = new AbortController()
    this.activeId = id
    this.operation = this.execute(preview, directories!, this.abort.signal).finally(() => { this.operation = null; this.abort = null; this.activeId = null })
    // Errors are kept in the durable receipt; don't leave unhandled promises.
    void this.operation.catch(() => {})
  }

  cancel(id: string): void {
    if (this.activeId !== id || (this.status?.id === id && !this.status.cancellable)) throw new Error('Migration can no longer be cancelled')
    this.abort?.abort(new Error('Migration cancelled'))
  }

  cancelActive(): void {
    if (!this.activeId || (this.status?.id === this.activeId && !this.status.cancellable)) return
    this.cancel(this.activeId)
  }

  private async save(): Promise<void> {
    await atomicWrite(this.journalPath, JSON.stringify(this.journal))
  }

  private async stage(stage: MigrationStatus['stage']): Promise<void> {
    this.journal!.status.stage = stage
    this.journal!.status.cancellable = !['committing', 'restarting', 'completed', 'failed', 'cancelled'].includes(stage)
    await this.save()
    this.hooks.progress({ ...this.journal!.status })
  }

  private credentialStore(): MigrationCredentialStore {
    return this.hooks.credentialStore ?? systemMigrationCredentialStore()
  }

  private async assertDirectories(directories: NonNullable<Journal['directories']>, source: string, target: string): Promise<void> {
    await assertMigrationDirectory(source, directories.source)
    await assertMigrationDirectory(target, directories.target)
    if (isWithin(directories.source.canonical, directories.target.canonical) || isWithin(directories.target.canonical, directories.source.canonical)) throw new Error('Source and target data directories must be separate')
  }

  private async publishStagedEntry(name: string): Promise<void> {
    const journal = this.journal!
    const output = path.join(journal.status.targetDir, name)
    for (let attempt = 0; ; attempt += 1) {
      // A Windows scanner can briefly open a copied descendant without sharing
      // delete access. Recheck transaction boundaries after every wait so a
      // retry never publishes through a replaced directory or overwrites data.
      await this.assertDirectories(journal.directories!, journal.status.sourceDir, journal.status.targetDir)
      await assertMigrationDirectory(journal.stagingDir, journal.stagingIdentity!)
      if (await exists(output)) throw new Error('Target directory changed during migration')
      try {
        await fs.rename(path.join(journal.stagingDir, name), output)
        return
      } catch (error) {
        if ((this.hooks.platform ?? process.platform) !== 'win32' || attempt >= 5 ||
          !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        // Six attempts, at most 3.1 seconds of backoff. Persistent permission
        // failures still roll back without changing ACLs or the startup pointer.
        await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt))
      }
    }
  }

  private async execute(preview: MigrationPreview, directories: NonNullable<Journal['directories']>, signal: AbortSignal): Promise<void> {
    let quiescing = false
    let switched = false
    const stagingDir = path.join(preview.targetDir, `.cc-haha-migration-${preview.id}`)
    try {
      const oldMode = await fs.readFile(this.modePath, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return null
      })
      this.journal = { version: 1, oldMode, stagingDir, directories, manifest: [], createdCredentials: [], credentials: [], status: {
        ...preview, stage: 'quiescing', files: 0, totalFiles: preview.files, bytes: 0, totalBytes: preview.bytes, cancellable: true,
      } }
      await this.stage('quiescing')
      signal.throwIfAborted()
      await this.assertDirectories(directories, preview.sourceDir, preview.targetDir)
      if ((await fs.readdir(preview.targetDir)).length) throw new Error('Target directory is no longer empty')
      if ((await this.hooks.preview()).externalProcesses) throw new Error('Another Claude process is using this data directory')
      quiescing = true
      await this.hooks.quiesce()
      signal.throwIfAborted()
      await this.assertDirectories(directories, preview.sourceDir, preview.targetDir)
      const files = await scanMigrationFiles(preview.sourceDir, this.sourceDefault ? this.app.getPath('home') : undefined, signal)
      this.journal.status.totalFiles = files.length
      this.journal.status.totalBytes = files.reduce((sum, file) => sum + file.size, 0)
      await fs.mkdir(stagingDir, { mode: 0o700 })
      const stagingIdentity = await migrationDirectoryIdentity(stagingDir)
      this.journal.stagingIdentity = stagingIdentity
      if ((this.hooks.platform ?? process.platform) === 'win32') {
        await (this.hooks.permissions?.restrictStaging ?? restrictWindowsMigrationStaging)(stagingIdentity.canonical, signal)
      }
      await this.stage('copying')
      await this.assertDirectories(directories, preview.sourceDir, preview.targetDir)
      await assertMigrationDirectory(stagingDir, this.journal.stagingIdentity)
      await copyMigrationFiles(files, preview.sourceDir, preview.targetDir, stagingDir, signal, file => {
        this.journal!.status.files += 1
        this.journal!.status.bytes += file.size
        this.hooks.progress({ ...this.journal!.status })
      }, async () => {
        await this.assertDirectories(directories, preview.sourceDir, preview.targetDir)
        await assertMigrationDirectory(stagingDir, this.journal!.stagingIdentity!)
      })
      await this.stage('verifying')
      await this.assertDirectories(directories, preview.sourceDir, preview.targetDir)
      await assertMigrationDirectory(stagingDir, this.journal.stagingIdentity)
      await verifyMigrationSource(files, await scanMigrationFiles(preview.sourceDir, this.sourceDefault ? this.app.getPath('home') : undefined, signal), signal)
      await relocateManagedData(preview.sourceDir, preview.targetDir, stagingDir)
      if ((this.hooks.platform ?? process.platform) === 'darwin') {
        this.journal.credentials = await copyMigrationCredentials(preview.sourceDir, this.sourceDefault, preview.targetDir, this.credentialStore(), async receipt => {
          this.journal!.createdCredentials.push(receipt)
          await this.save()
        }, signal)
      }
      await restoreMigrationPermissions(files, stagingDir, signal)
      if ((this.hooks.platform ?? process.platform) === 'win32') {
        await this.assertDirectories(directories, preview.sourceDir, preview.targetDir)
        await assertMigrationDirectory(stagingDir, this.journal.stagingIdentity)
        await (this.hooks.permissions?.preserve ?? preserveWindowsMigrationPermissions)([
          ...files.filter(file => file.kind !== 'link').map(file => ({
            source: isWithin(preview.sourceDir, file.source) ? path.join(directories.source.canonical, path.relative(preview.sourceDir, file.source)) : file.source,
            target: path.join(stagingIdentity.canonical, file.relative),
          })),
          { source: directories.source.canonical, target: directories.target.canonical },
        ], signal)
      }
      this.journal.manifest = await migrationManifest(stagingDir, signal)
      // Keychain prompts and target rewrites may take time. Validate the source
      // again at the commit boundary, rather than trusting the earlier scan.
      await this.assertDirectories(directories, preview.sourceDir, preview.targetDir)
      await assertMigrationDirectory(stagingDir, this.journal.stagingIdentity)
      await verifyMigrationSource(files, await scanMigrationFiles(preview.sourceDir, this.sourceDefault ? this.app.getPath('home') : undefined, signal), signal)
      if ((await this.hooks.preview()).externalProcesses) throw new Error('Another Claude process is using this data directory')
      signal.throwIfAborted()
      const names = await fs.readdir(preview.targetDir)
      if (names.length !== 1 || names[0] !== path.basename(stagingDir)) throw new Error('Target directory changed during migration')
      await this.stage('committing')
      await this.assertDirectories(directories, preview.sourceDir, preview.targetDir)
      await assertMigrationDirectory(stagingDir, this.journal.stagingIdentity)
      for (const name of await fs.readdir(stagingDir)) {
        await this.publishStagedEntry(name)
      }
      await fs.rmdir(stagingDir)
      await assertMigrationDirectory(preview.targetDir, directories.target)
      await fs.chmod(preview.targetDir, (await fs.stat(preview.sourceDir)).mode)
      await validateMigrationManifest(preview.targetDir, this.journal.manifest)
      await this.stage('restarting')
      await assertMigrationDirectory(preview.targetDir, directories.target)
      setAppMode(this.app, { mode: 'portable', portableDir: preview.targetDir }, this.env)
      switched = true
      await this.hooks.restart()
    } catch (error) {
      if (this.journal) {
        if (switched || this.journal.status.stage === 'restarting') await this.restoreMode()
        if ((this.hooks.platform ?? process.platform) === 'darwin') await removeMigrationCredentials(this.journal.createdCredentials, this.credentialStore()).catch(() => {})
        // Remove only the private transaction directory, never a source or
        // target directory that may now contain independently written files.
        await this.removeStaging().catch(() => {})
        this.journal.status.error = error instanceof Error ? error.message : 'Data migration failed'
        await this.stage(signal.aborted ? 'cancelled' : 'failed')
      }
      if (quiescing) {
        try { await this.hooks.resume() } catch (resumeError) {
          if (this.journal) {
            const detail = resumeError instanceof Error ? resumeError.message : 'Runtime is unavailable'
            this.journal.status.error = `${this.journal.status.error ?? 'Migration stopped'}. Original services could not restart: ${detail}`
            await this.stage('failed')
          }
        }
      }
    }
  }

  private async restoreMode(): Promise<void> {
    try {
      if (this.journal!.directories) await assertMigrationDirectory(this.journal!.status.sourceDir, this.journal!.directories.source)
      else if (!(await fs.stat(this.journal!.status.sourceDir)).isDirectory()) throw new Error('Original path is not a directory')
    } catch (error) {
      throw new Error('Original data directory is unavailable; restore it before retrying migration recovery', { cause: error })
    }
    if (this.journal!.oldMode === null) await fs.rm(this.modePath, { force: true })
    else await atomicWrite(this.modePath, this.journal!.oldMode)
  }

  private async removeStaging(): Promise<void> {
    const journal = this.journal!
    const expected = path.join(journal.status.targetDir, `.cc-haha-migration-${journal.status.id}`)
    if (journal.stagingDir !== expected || path.dirname(expected) !== journal.status.targetDir || expected === journal.status.targetDir) throw new Error('Invalid migration staging path')
    const stat = await fs.lstat(expected).catch(() => null)
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Migration staging directory was replaced')
    if (!stat) return
    // The v1 fixture predates directory identities. Upgrade it only when its
    // entire target path has no links; a legacy receipt cannot prove an alias
    // still points to the directory originally chosen by the user.
    if (journal.directories) await assertMigrationDirectory(journal.status.targetDir, journal.directories.target)
    else await assertUnlinkedDirectoryPath(journal.status.targetDir)
    const targetReal = await fs.realpath(journal.status.targetDir)
    const stageReal = await fs.realpath(expected)
    if (path.relative(targetReal, path.dirname(stageReal)) !== '' || path.basename(stageReal) !== path.basename(expected)) throw new Error('Invalid migration staging path')
    if (journal.stagingIdentity) await assertMigrationDirectory(expected, journal.stagingIdentity)
    await fs.rm(expected, { recursive: true, force: true })
  }

  async recover(): Promise<'validate' | 'normal'> {
    if (!await exists(this.journalPath)) return 'normal'
    const parsed = parseJournal(JSON.parse(await fs.readFile(this.journalPath, 'utf8')))
    const sourceReal = await canonicalPath(parsed.status.sourceDir)
    const targetReal = await canonicalPath(parsed.status.targetDir)
    if (isWithin(sourceReal, targetReal) || isWithin(targetReal, sourceReal)) throw new Error('Migration recovery directories overlap')
    this.journal = parsed
    if (parsed.status.stage === 'restarting') {
      try {
        if (parsed.directories) await assertMigrationDirectory(parsed.status.targetDir, parsed.directories.target)
        else await assertUnlinkedDirectoryPath(parsed.status.targetDir)
        await validateMigrationManifest(parsed.status.targetDir, parsed.manifest)
        if ((this.hooks.platform ?? process.platform) === 'darwin') await verifyMigrationCredentials(parsed.credentials, this.credentialStore())
        if (parsed.directories) await assertMigrationDirectory(parsed.status.targetDir, parsed.directories.target)
        else await assertUnlinkedDirectoryPath(parsed.status.targetDir)
        setAppMode(this.app, { mode: 'portable', portableDir: parsed.status.targetDir }, this.env)
        return 'validate'
      } catch (error) {
        await this.failValidation(error)
        return 'normal'
      }
    }
    if (parsed.status.stage === 'completed') {
      // A disconnected migrated disk must not be recreated as an empty store.
      // An explicit launch override still selects its own independent store.
      if (this.env.CLAUDE_CONFIG_DIR && this.env.CC_HAHA_APP_PORTABLE_DIR !== '1' &&
        path.relative(path.resolve(this.env.CLAUDE_CONFIG_DIR), parsed.status.targetDir) !== '') return 'normal'
      let mode: { mode?: string; portable_dir?: string }
      try { mode = JSON.parse(await fs.readFile(this.modePath, 'utf8')) } catch (error) {
        throw new Error('Migrated data startup configuration is unavailable; restore its saved directory selection', { cause: error })
      }
      if (!mode || (mode.mode !== 'default' && (mode.mode !== 'portable' || !absoluteDirectory(mode.portable_dir)))) {
        throw new Error('Migrated data startup configuration is invalid; restore its saved directory selection')
      }
      if (mode.mode === 'portable' && mode.portable_dir === parsed.status.targetDir) {
        if (!await exists(parsed.status.targetDir)) throw new Error('Migrated data directory is unavailable; reconnect its disk')
        if (parsed.directories) await assertMigrationDirectory(parsed.status.targetDir, parsed.directories.target)
      }
      return 'normal'
    }
    if (!['failed', 'cancelled'].includes(parsed.status.stage)) {
      await this.restoreMode()
      await this.removeStaging()
      if ((this.hooks.platform ?? process.platform) === 'darwin') await removeMigrationCredentials(parsed.createdCredentials, this.credentialStore())
      this.journal.status.error = 'Migration was interrupted; original data directory restored'
      await this.stage('failed')
    }
    return 'normal'
  }

  async completeValidation(): Promise<void> { await this.stage('completed') }

  async failValidation(error: unknown): Promise<void> {
    await this.restoreMode()
    this.journal!.status.error = error instanceof Error ? error.message : 'New directory startup failed'
    await this.stage('failed')
  }
}
