import {
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'node:fs'
import {
  dirname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'

export const LOCAL_INDEX_UNSAFE_PATH = 'LOCAL_INDEX_UNSAFE_PATH' as const
export const LOCAL_INDEX_BUSY_TIMEOUT_MS = 100

export class UnsafeLocalIndexPathError extends Error {
  readonly code = LOCAL_INDEX_UNSAFE_PATH

  constructor() {
    super(LOCAL_INDEX_UNSAFE_PATH)
    this.name = 'UnsafeLocalIndexPathError'
  }
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function isContained(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (
    child !== '..' &&
    !child.startsWith(`..${sep}`) &&
    !child.startsWith(sep)
  )
}

function ensureRealManagedDirectory(path: string, trustRoot: string): void {
  try {
    mkdirSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const snapshot = lstatSync(path)
  if (!snapshot.isDirectory() || snapshot.isSymbolicLink()) {
    throw new UnsafeLocalIndexPathError()
  }
  if (!isContained(trustRoot, realpathSync.native(path))) {
    throw new UnsafeLocalIndexPathError()
  }
}

function assertDatabaseFamilySafe(databasePath: string): void {
  for (const path of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`,
  ]) {
    const snapshot = lstatIfPresent(path)
    if (!snapshot) continue
    if (
      !snapshot.isFile() ||
      snapshot.isSymbolicLink() ||
      snapshot.nlink !== 1
    ) {
      throw new UnsafeLocalIndexPathError()
    }
  }
}

/**
 * Prepares the disposable database directory without following any managed
 * descendant symlink. The configured scope itself is the trust boundary and
 * may intentionally be a symlink (for example, a relocated user config).
 */
export function prepareManagedDatabasePath(options: {
  databasePath: string
  filename: string
  scope?: string
}): void {
  const databasePath = resolve(options.databasePath)
  if (!options.scope) {
    mkdirSync(dirname(databasePath), { recursive: true })
    assertDatabaseFamilySafe(databasePath)
    return
  }

  const lexicalScope = resolve(options.scope)
  const expectedPath = join(lexicalScope, 'cc-haha', 'db', options.filename)
  if (databasePath !== expectedPath) throw new UnsafeLocalIndexPathError()

  // Recursive creation is restricted to the caller-owned trust root. Every
  // managed descendant is created one component at a time and lstat-verified.
  mkdirSync(lexicalScope, { recursive: true })
  const trustRoot = realpathSync.native(lexicalScope)
  const scopeSnapshot = lstatSync(lexicalScope)
  if (!scopeSnapshot.isDirectory() && !scopeSnapshot.isSymbolicLink()) {
    throw new UnsafeLocalIndexPathError()
  }
  // Resolve the caller-owned root before creating managed children. In
  // particular, mkdir through a Windows junction must not retain an alias.
  const ccHahaDir = join(trustRoot, 'cc-haha')
  const databaseDir = join(ccHahaDir, 'db')
  ensureRealManagedDirectory(ccHahaDir, trustRoot)
  ensureRealManagedDirectory(databaseDir, trustRoot)
  assertDatabaseFamilySafe(databasePath)
}
