import * as path from 'node:path'

/**
 * Stopping a whole process tree on Windows.
 *
 * Windows has no signals: `process.kill()` / `Subprocess.kill()` are a
 * TerminateProcess on that one pid. Children survive and lose their parent
 * link, after which `taskkill /T` can no longer find them. A stdio MCP server
 * launched as `npx …` is `cmd.exe /d /s /c "npx …"` (cross-spawn) with the
 * node launcher and the real server below it, so terminating the direct child
 * only removes cmd.exe. `taskkill /PID <pid> /T /F` walks the tree while `pid`
 * still anchors it.
 *
 * taskkill is run by absolute System32 path without a shell: no PATH or
 * current-directory lookup (a CLI runs in the user's project, where a planted
 * `taskkill.exe` must never be what runs), and no console window for a
 * console-less parent.
 */

export type WindowsTaskkillSpawnOptions = {
  stdin: 'ignore'
  stdout: 'ignore'
  stderr: 'ignore'
  windowsHide: true
}

export type WindowsTaskkillSpawn = (
  cmd: string[],
  options: WindowsTaskkillSpawnOptions,
) => { exited: Promise<number>; kill?: () => void }

export type WindowsProcessTreeKillDeps = {
  env?: NodeJS.ProcessEnv
  spawn?: WindowsTaskkillSpawn
  timeoutMs?: number
}

const TASKKILL_SPAWN_OPTIONS: WindowsTaskkillSpawnOptions = {
  stdin: 'ignore',
  stdout: 'ignore',
  stderr: 'ignore',
  windowsHide: true,
}

// A taskkill that has not finished by now is not going to; the caller falls
// back to terminating the pid itself rather than waiting on it forever.
const TASKKILL_TIMEOUT_MS = 5_000

function getWindowsEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalizedName = name.toLowerCase()
  return Object.entries(env)
    .find(([key, value]) => key.toLowerCase() === normalizedName && value)?.[1]
}

/** System32's taskkill, or null when the environment does not say where Windows is. */
export function resolveWindowsTaskkillExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  const systemRoot = getWindowsEnv(env, 'SystemRoot') ?? getWindowsEnv(env, 'windir')
  return systemRoot ? path.win32.join(systemRoot, 'System32', 'taskkill.exe') : null
}

/**
 * Terminates `pid` and every descendant still linked to it. Resolves true only
 * when taskkill reported success; on false (no System32 to run it from, failed
 * to start, non-zero exit, or still running at the timeout) the caller falls
 * back to terminating `pid` directly.
 */
export async function killWindowsProcessTree(
  pid: number | null | undefined,
  deps: WindowsProcessTreeKillDeps = {},
): Promise<boolean> {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  const taskkill = resolveWindowsTaskkillExecutable(deps.env ?? process.env)
  if (!taskkill) return false
  const spawn: WindowsTaskkillSpawn = deps.spawn ?? ((cmd, options) => Bun.spawn(cmd, options))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const killer = spawn([taskkill, '/PID', String(pid), '/T', '/F'], { ...TASKKILL_SPAWN_OPTIONS })
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(resolve, deps.timeoutMs ?? TASKKILL_TIMEOUT_MS, 'timeout')
    })
    const outcome = await Promise.race([killer.exited, timedOut])
    if (outcome !== 'timeout') return outcome === 0
    try { killer.kill?.() } catch { /* already gone */ }
    return false
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
