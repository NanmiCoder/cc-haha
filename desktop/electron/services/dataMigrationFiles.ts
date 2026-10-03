import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as fs from 'node:fs/promises'
import path from 'node:path'

export type MigrationFile = {
  relative: string
  source: string
  kind: 'file' | 'directory' | 'link'
  size: number
  mode: number
  mtime: number
  link?: string
  digest?: string
}

const indexes = new Set(['index-v1.sqlite', 'trace-index-v1.sqlite', 'search-index-v1.sqlite', 'scheduled-runs-v1.sqlite'])

export function skipMigrationEntry(relative: string): boolean {
  const normalized = relative.split(path.sep).join('/')
  if (normalized.startsWith('cc-haha/db/')) {
    const name = normalized.slice('cc-haha/db/'.length)
    if (indexes.has(name.replace(/-(wal|shm|journal)$/, ''))) return true
  }
  if (normalized === '.runtime/venv' || normalized.startsWith('.runtime/venv/')) return true
  if (/^\.runtime\/(?:requirements\.sha256|venv-base-interpreter\.txt)$/.test(normalized)) return true
  if (/^\.runtime\/cu-helper\.daemon\..*\.sock(?:\.pid)?$/.test(normalized)) return true
  if (/^sessions\/\d+\.json$/.test(normalized)) return true
  return normalized === '.credentials.json.lock' || normalized === '.config.json.lock' || /^\.claude(?:-.*)?\.json\.lock$/.test(normalized)
}

export function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export async function canonicalPath(input: string): Promise<string> {
  let current = path.resolve(input)
  const missing: string[] = []
  for (;;) {
    try { return path.join(await fs.realpath(current), ...missing) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      missing.unshift(path.basename(current))
      current = parent
    }
  }
}

export type MigrationDirectoryIdentity = { canonical: string; dev: string; ino: string }

export async function migrationDirectoryIdentity(directory: string): Promise<MigrationDirectoryIdentity> {
  const canonical = await fs.realpath(directory)
  const stat = await fs.stat(directory, { bigint: true })
  if (!stat.isDirectory()) throw new Error('Migration directory is not a directory')
  return { canonical, dev: String(stat.dev), ino: String(stat.ino) }
}

export async function assertMigrationDirectory(directory: string, expected: MigrationDirectoryIdentity): Promise<void> {
  const actual = await migrationDirectoryIdentity(directory)
  // Some volumes do not expose an inode. Canonical paths still bind the root;
  // compare the volume and inode whenever the filesystem provides them.
  if (path.relative(actual.canonical, expected.canonical) !== '' || actual.dev !== expected.dev || (expected.ino !== '0' && actual.ino !== expected.ino)) {
    throw new Error('Migration directory was replaced; choose the directory again')
  }
}

export async function assertUnlinkedDirectoryPath(directory: string): Promise<void> {
  let current = path.resolve(directory)
  for (;;) {
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Migration directory path contains a link')
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

export async function scanMigrationFiles(sourceDir: string, homeDir?: string, signal?: AbortSignal): Promise<MigrationFile[]> {
  const files: MigrationFile[] = []
  async function visit(source: string, relative: string): Promise<void> {
    signal?.throwIfAborted()
    if (skipMigrationEntry(relative)) return
    const stat = await fs.lstat(source)
    if (stat.isSymbolicLink()) {
      files.push({ relative, source, kind: 'link', size: 0, mode: stat.mode, mtime: stat.mtimeMs, link: await fs.readlink(source) })
    } else if (stat.isDirectory()) {
      files.push({ relative, source, kind: 'directory', size: 0, mode: stat.mode, mtime: stat.mtimeMs })
      for (const name of (await fs.readdir(source)).sort()) await visit(path.join(source, name), path.join(relative, name))
    } else if (stat.isFile()) {
      files.push({ relative, source, kind: 'file', size: stat.size, mode: stat.mode, mtime: stat.mtimeMs })
    } else {
      throw new Error(`Unsupported data entry: ${relative}`)
    }
  }
  for (const name of (await fs.readdir(sourceDir)).sort()) await visit(path.join(sourceDir, name), name)
  if (homeDir && !files.some(file => file.relative === '.config.json')) {
    for (const suffix of ['', '-custom-oauth', '-staging-oauth', '-local-oauth']) {
      signal?.throwIfAborted()
      const name = `.claude${suffix}.json`
      const source = path.join(homeDir, name)
      try {
        const stat = await fs.lstat(source)
        if (!stat.isFile()) throw new Error(`Global configuration is not a regular file: ${name}`)
        if (files.some(file => file.relative === name)) throw new Error(`Global configuration collision: ${name}`)
        files.push({ relative: name, source, kind: 'file', size: stat.size, mode: stat.mode, mtime: stat.mtimeMs })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  return files
}

export async function hashFile(file: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk)
  return hash.digest('hex')
}

export async function copyMigrationFiles(
  files: MigrationFile[], sourceDir: string, targetDir: string, stagedDir: string,
  signal: AbortSignal, progress: (file: MigrationFile) => void,
  validateDirectories?: () => Promise<void>,
): Promise<void> {
  const sourceReal = await fs.realpath(sourceDir)
  for (const file of files) {
    signal.throwIfAborted()
    await validateDirectories?.()
    const output = path.join(stagedDir, file.relative)
    if (!isWithin(stagedDir, output)) throw new Error('Unsafe migration path')
    if (file.kind === 'directory') {
      // Keep the private copy writable until managed metadata has been updated.
      // Applying a read-only source directory mode here prevents copying its children.
      await fs.mkdir(output, { mode: 0o700 })
    } else if (file.kind === 'link') {
      const original = file.link!
      const resolved = path.resolve(path.dirname(file.source), original)
      const resolvedReal = await canonicalPath(resolved)
      const internalRoot = isWithin(sourceDir, resolved) ? sourceDir : isWithin(sourceReal, resolved) ? sourceReal : undefined
      const internal = internalRoot ? path.relative(internalRoot, resolved)
        : isWithin(sourceReal, resolvedReal) ? path.relative(sourceReal, resolvedReal) : undefined
      let link = path.isAbsolute(original) && internal !== undefined ? path.join(targetDir, internal) : original
      const targetStat = await fs.stat(file.source).catch(() => null)
      if (process.platform === 'win32' && targetStat?.isDirectory()) {
        link = internal !== undefined ? path.join(targetDir, internal) : resolved
      }
      await fs.symlink(link, output, targetStat?.isDirectory() ? 'junction' : 'file')
    } else {
      const hash = createHash('sha256')
      const hashing = new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk) } })
      await pipeline(createReadStream(file.source), hashing, createWriteStream(output, { flags: 'wx', mode: file.mode, flush: true }), { signal })
      await fs.chmod(output, file.mode)
      await fs.utimes(output, new Date(file.mtime), new Date(file.mtime))
      file.digest = hash.digest('hex')
      if (await hashFile(output, signal) !== file.digest) throw new Error(`Copy verification failed: ${file.relative}`)
    }
    progress(file)
  }
}

export async function restoreMigrationPermissions(files: MigrationFile[], stagedDir: string, signal: AbortSignal): Promise<void> {
  for (const file of [...files].reverse()) {
    signal.throwIfAborted()
    if (file.kind !== 'link') await fs.chmod(path.join(stagedDir, file.relative), file.mode)
  }
}

export async function verifyMigrationSource(files: MigrationFile[], current: MigrationFile[], signal: AbortSignal): Promise<void> {
  const shape = (entries: MigrationFile[]) => JSON.stringify(entries.map(({ relative, kind, size, mtime, link }) => ({ relative, kind, size, mtime, link })))
  if (shape(files) !== shape(current)) throw new Error('Source data changed during migration; close other Claude processes and retry')
  for (const file of files) {
    signal.throwIfAborted()
    if (file.kind === 'file' && await hashFile(file.source, signal) !== file.digest) throw new Error(`Source data changed: ${file.relative}`)
  }
}

export type VerifiedMigrationFile = { relative: string; kind: MigrationFile['kind']; digest?: string; link?: string }

export async function migrationManifest(root: string, signal?: AbortSignal): Promise<VerifiedMigrationFile[]> {
  const files = await scanMigrationFiles(root, undefined, signal)
  const manifest: VerifiedMigrationFile[] = []
  for (const file of files) manifest.push({
    relative: file.relative, kind: file.kind,
    ...(file.kind === 'file' ? { digest: await hashFile(file.source, signal) } : {}),
    ...(file.kind === 'link' ? { link: file.link } : {}),
  })
  return manifest
}

export function assertMigrationManifest(manifest: unknown): asserts manifest is VerifiedMigrationFile[] {
  if (!Array.isArray(manifest)) throw new Error('Invalid migration manifest')
  const seen = new Set<string>()
  for (const file of manifest) {
    if (!file || typeof file !== 'object' || typeof file.relative !== 'string' || !file.relative || file.relative.includes('\0') ||
      path.isAbsolute(file.relative) || path.win32.isAbsolute(file.relative) || file.relative.split(/[\\/]/).some((part: string) => !part || part === '.' || part === '..') ||
      !['file', 'directory', 'link'].includes(file.kind) ||
      (file.kind === 'file' && (typeof file.digest !== 'string' || !/^[a-f0-9]{64}$/.test(file.digest))) ||
      (file.kind === 'link' && typeof file.link !== 'string')) throw new Error('Invalid migration manifest entry')
    const key = process.platform === 'win32' ? file.relative.toLowerCase() : file.relative
    if (seen.has(key)) throw new Error('Duplicate migration manifest entry')
    seen.add(key)
  }
}

export async function validateMigrationManifest(root: string, manifest: VerifiedMigrationFile[]): Promise<void> {
  assertMigrationManifest(manifest)
  // Validate each ancestor before reading a file: lstat(file) alone follows a
  // replaced parent junction and can hash data outside the copied tree.
  const checked = new Set<string>()
  for (const file of manifest) {
    const target = path.join(root, file.relative)
    if (!isWithin(root, target)) throw new Error('Invalid migration manifest path')
    let parent = path.dirname(target)
    while (isWithin(root, parent) && !checked.has(parent)) {
      const stat = await fs.lstat(parent)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Migration manifest parent was replaced')
      checked.add(parent)
      if (parent === root) break
      parent = path.dirname(parent)
    }
    const stat = await fs.lstat(target)
    if (file.kind === 'directory' && !stat.isDirectory()) throw new Error(`Migration directory missing: ${file.relative}`)
    if (file.kind === 'link' && (!stat.isSymbolicLink() || await fs.readlink(target) !== file.link)) throw new Error(`Migration link changed: ${file.relative}`)
    if (file.kind === 'file' && (!stat.isFile() || await hashFile(target) !== file.digest)) throw new Error(`Migration file changed: ${file.relative}`)
  }
}
