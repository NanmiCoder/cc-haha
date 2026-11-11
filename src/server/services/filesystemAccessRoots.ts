import { realpathSync } from 'node:fs'
import * as path from 'node:path'
import {
  isSameOrInsidePathForPlatform,
  normalizeDriveRootPathForPlatform,
} from './windowsDrivePath.js'

const registeredRoots = new Set<string>()

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  return isSameOrInsidePathForPlatform(targetPath, rootPath)
}

export function canonicalizeFilesystemAccessPath(filePath: string): string {
  const resolved = path.resolve(normalizeDriveRootPathForPlatform(filePath))

  // A path may not exist yet (for example, a missing preview target). Resolve
  // the closest existing ancestor so macOS's /var -> /private/var alias does
  // not make an otherwise in-sandbox path look like an escape.
  const suffix: string[] = []
  let candidate = resolved
  while (true) {
    try {
      const canonicalAncestor = realpathSync(candidate)
      return path.resolve(
        normalizeDriveRootPathForPlatform(canonicalAncestor),
        ...suffix,
      )
    } catch {
      const parent = path.dirname(candidate)
      if (parent === candidate) return resolved
      suffix.unshift(path.basename(candidate))
      candidate = parent
    }
  }
}

export function registerFilesystemAccessRoot(rootPath: string | null | undefined): void {
  if (!rootPath) return
  registeredRoots.add(canonicalizeFilesystemAccessPath(rootPath))
}

/** Only for an existing canonical directory already verified by directory I/O.
 * Avoid repeating native realpath on the API event loop after that boundary. */
export function registerCanonicalFilesystemAccessRoot(rootPath: string): void {
  registeredRoots.add(path.resolve(normalizeDriveRootPathForPlatform(rootPath)))
}

/**
 * Register the directory of a file this session actually changed so it becomes
 * previewable, even when the user pointed the model at an absolute path outside
 * the session workdir (a different folder, or a different drive on Windows).
 *
 * Writing the file was already authorized via the permission system, so reading
 * it back for a preview is consistent. Files inside the workdir need nothing —
 * they are previewable already — so those are skipped to keep the root set tight.
 */
export function registerChangedFileAccessRoot(
  absoluteFilePath: string | null | undefined,
  workDir: string | null | undefined,
): void {
  if (!absoluteFilePath) return
  const resolved = canonicalizeFilesystemAccessPath(absoluteFilePath)
  if (workDir) {
    const root = canonicalizeFilesystemAccessPath(workDir)
    if (isWithinRoot(resolved, root)) return
  }
  registeredRoots.add(path.dirname(resolved))
}

export function isWithinRegisteredFilesystemRoot(targetPath: string): boolean {
  const canonicalTarget = canonicalizeFilesystemAccessPath(targetPath)
  for (const rootPath of registeredRoots) {
    if (isWithinRoot(canonicalTarget, rootPath)) return true
  }
  return false
}

export function clearFilesystemAccessRootsForTests(): void {
  registeredRoots.clear()
}
