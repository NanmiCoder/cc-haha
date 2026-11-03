import type * as fs from 'node:fs'
import type * as path from 'node:path'

/** Native realpath must preserve Unicode bytes and prove the same inode.
 * Explicit dependencies also let the read-only I/O worker reuse this boundary. */
export function readNativeProjectDirectoryIdentity(
  projectPath: string,
  filesystem: Pick<typeof fs, 'statSync' | 'realpathSync'>,
  paths: Pick<typeof path, 'isAbsolute'>,
): { directory: string; dev: number; ino: number } {
  if (!projectPath || !paths.isAbsolute(projectPath) || projectPath.includes('\0')) {
    throw new Error('Project path must be an absolute directory path')
  }
  try {
    const requested = filesystem.statSync(projectPath)
    if (!requested.isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' })
    const canonical = filesystem.realpathSync(projectPath) as string
    const physical = filesystem.statSync(canonical)
    if (!physical.isDirectory() || requested.dev !== physical.dev || requested.ino !== physical.ino) {
      throw new Error('Project directory identity could not be verified')
    }
    return { directory: canonical, dev: requested.dev, ino: requested.ino }
  } catch (error) {
    if (error instanceof Error && error.message === 'Project directory identity could not be verified') throw error
    throw Object.assign(new Error('Project directory is unavailable'), { code: (error as NodeJS.ErrnoException)?.code })
  }
}
