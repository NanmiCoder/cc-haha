import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'

/** Never sweeps PID files or assumes an inaccessible process is dead. */
export async function countExternalMigrationProcesses(
  ownedPids: readonly number[],
  configDir = getClaudeConfigHomeDir(),
  isAlive: (pid: number) => boolean = pid => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  },
): Promise<number> {
  const owned = new Set([process.pid, ...ownedPids])
  let files: string[]
  try { files = await readdir(join(configDir, 'sessions')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let count = 0
  for (const file of files) {
    if (!/^\d+\.json$/.test(file)) continue
    const pid = Number(file.slice(0, -5))
    if (!Number.isSafeInteger(pid) || pid <= 0 || owned.has(pid) || !isAlive(pid)) continue
    // An unreadable/malformed live registration cannot safely be ignored.
    try {
      const entry = JSON.parse(await readFile(join(configDir, 'sessions', file), 'utf8'))
      if (entry.pid !== pid) throw new Error('Invalid session process registration')
    } catch {
      count += 1
      continue
    }
    count += 1
  }
  return count
}
