/**
 * prerequisitesService — host-command availability probe.
 *
 * Plugin MCP servers can declare host-side prerequisites in their
 * `mcp/servers.json` (see `McpPrerequisiteSchema`). When the user
 * enables a plugin, cc-haha probes whether each declared command is
 * resolvable in PATH, so the desktop can pop a "missing dependency"
 * modal up front instead of letting the server fail to spawn with a
 * cryptic error like "uvx: command not found".
 *
 * Implementation note: we deliberately do NOT execute the commands —
 * a presence probe is `where` (Windows) / `command -v` (POSIX), which
 * does not invoke the program. This is safe even for misconfigured
 * shims; the probe answers "is it on PATH?" and nothing more.
 *
 * Caching: results are cached for 60s keyed on the literal command
 * name. The PATH lookup is cheap, but plugin enable can fan out to
 * many servers (the reverse-engineering plugin alone has 7) all
 * declaring `uvx`; without caching that's 7 redundant subprocess
 * spawns per click. The TTL is short enough that a user who installs
 * `uvx` and clicks the modal's "recheck" button sees the new state
 * without restarting cc-haha.
 */

import { spawn } from 'node:child_process'

export type PrerequisiteProbeResult = {
  command: string
  installed: boolean
  /** Resolved absolute path when found; null otherwise. */
  resolvedPath: string | null
}

const CACHE_TTL_MS = 60_000

type CacheEntry = {
  result: PrerequisiteProbeResult
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

/**
 * Reset the prerequisite probe cache. Used by tests and by the
 * "recheck" affordance in the desktop modal so the user gets fresh
 * answers right after installing a missing dep.
 */
export function clearPrerequisitesCache(): void {
  cache.clear()
}

/**
 * Probe a single host command. Returns the cached result when the TTL
 * is still alive. Resolves to `installed: false` on any error or
 * non-zero exit — we never throw to the caller, missing-tool detection
 * is best-effort by design.
 */
export async function probeHostCommand(
  command: string,
): Promise<PrerequisiteProbeResult> {
  const trimmed = command.trim()
  if (!trimmed) {
    return { command, installed: false, resolvedPath: null }
  }

  const cached = cache.get(trimmed)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result
  }

  const result = await runProbe(trimmed)
  cache.set(trimmed, { result, expiresAt: Date.now() + CACHE_TTL_MS })
  return result
}

/**
 * Probe a batch in parallel — typical case when a plugin enable
 * fans out to several servers each declaring 1-3 prerequisites.
 * De-dups by command name before probing so the same `uvx` declared
 * by 5 different MCP servers triggers one shell call, not five.
 */
export async function probeHostCommands(
  commands: ReadonlyArray<string>,
): Promise<Map<string, PrerequisiteProbeResult>> {
  const unique = [...new Set(commands.map((c) => c.trim()).filter(Boolean))]
  const results = await Promise.all(unique.map((c) => probeHostCommand(c)))
  return new Map(results.map((r) => [r.command, r]))
}

function runProbe(command: string): Promise<PrerequisiteProbeResult> {
  // Reject anything that looks like shell metacharacters. Plugin
  // manifest authors should declare bare command names (`uvx`,
  // `radare2`); allowing more would let a malicious plugin smuggle a
  // shell snippet into our probe call, even though we don't pass
  // through `shell:true` on Windows.
  if (!/^[A-Za-z0-9._+\-]+$/.test(command)) {
    return Promise.resolve({ command, installed: false, resolvedPath: null })
  }

  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32'
    const probeCmd = isWindows ? 'where' : 'command'
    const probeArgs = isWindows ? [command] : ['-v', command]

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(probeCmd, probeArgs, {
        // POSIX `command -v` is a shell builtin — we have to spawn
        // through a shell to reach it. `where` on Windows is a real
        // executable, so we run it directly to avoid cmd.exe escaping
        // surprises.
        shell: !isWindows,
        windowsHide: true,
      })
    } catch {
      resolve({ command, installed: false, resolvedPath: null })
      return
    }

    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })

    // Belt-and-suspenders: kill probes that hang for more than 3s.
    // The shell builtin / `where` are practically instant; anything
    // taking longer is a host-environment pathology we shouldn't
    // wait on.
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      resolve({ command, installed: false, resolvedPath: null })
    }, 3_000)

    child.on('error', () => {
      clearTimeout(timeout)
      resolve({ command, installed: false, resolvedPath: null })
    })

    child.on('close', (code) => {
      clearTimeout(timeout)
      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
      const installed = code === 0 && lines.length > 0
      resolve({
        command,
        installed,
        resolvedPath: installed ? (lines[0] ?? null) : null,
      })
    })
  })
}
