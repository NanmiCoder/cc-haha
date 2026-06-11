import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import type { Readable } from 'node:stream'
import net from 'node:net'
import path from 'node:path'

export const SERVER_BIND_HOST = '0.0.0.0'
export const SERVER_CONTROL_HOST = '127.0.0.1'
export const SERVER_STARTUP_LOG_LIMIT = 80

export type SidecarChild = ChildProcessByStdio<null, Readable, Readable>

export type SidecarPlan = {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
] as const

export function resolveHostTriple(platform = process.platform, arch = process.arch): string {
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin'
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin'
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc'
  if (platform === 'win32') return 'x86_64-pc-windows-msvc'
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu'
  if (platform === 'linux') return 'x86_64-unknown-linux-gnu'
  throw new Error(`Unsupported Electron sidecar platform: ${platform}/${arch}`)
}

export function resolveSidecarExecutable(desktopRoot: string, triple = resolveHostTriple()): string {
  const base = path.join(desktopRoot, 'src-tauri', 'binaries', `claude-sidecar-${triple}`)
  return process.platform === 'win32' ? `${base}.exe` : base
}

export function httpToWebSocketUrl(serverHttpUrl: string): string {
  if (serverHttpUrl.startsWith('http://')) return `ws://${serverHttpUrl.slice('http://'.length)}`
  if (serverHttpUrl.startsWith('https://')) return `wss://${serverHttpUrl.slice('https://'.length)}`
  return serverHttpUrl
}

export async function reserveLocalPort(bindHost = SERVER_BIND_HOST): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', error => reject(error))
    server.listen(0, bindHost, () => {
      const address = server.address()
      server.close(() => {
        if (!address || typeof address === 'string') {
          reject(new Error('Could not resolve reserved local port'))
          return
        }
        resolve(address.port)
      })
    })
  })
}

export async function waitForServer(host: string, port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await canConnect(host, port)) return
    await sleep(150)
  }
  throw new Error(`desktop server did not start listening on ${host}:${port} within ${Math.round(timeoutMs / 1000)} seconds`)
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host, port, timeout: 200 })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(false))
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function pushStartupLog(logs: string[], line: string) {
  const trimmed = line.trimEnd()
  if (!trimmed) return
  if (logs.length >= SERVER_STARTUP_LOG_LIMIT) logs.shift()
  logs.push(trimmed)
}

export function formatStartupError(message: string, logs: string[]): string {
  const logText = logs.length > 0
    ? logs.join('\n')
    : 'No server stdout/stderr was captured before the timeout.'
  return `${message}\n\nRecent server logs:\n${logText}`
}

export function proxyUrlFromElectronProxyRules(rules: string | undefined): string | undefined {
  if (!rules) return undefined

  for (const rawRule of rules.split(';')) {
    const rule = rawRule.trim()
    if (!rule || /^DIRECT$/i.test(rule)) continue

    const match = rule.match(/^(PROXY|HTTPS)\s+(.+)$/i)
    if (!match) continue

    const scheme = match[1]!.toUpperCase() === 'HTTPS' ? 'https' : 'http'
    const hostPort = match[2]!.trim()
    if (!hostPort) continue

    return `${scheme}://${hostPort}`
  }

  return undefined
}

export function mergeProxyEnv(
  baseEnv: NodeJS.ProcessEnv,
  proxyUrl: string | undefined,
): NodeJS.ProcessEnv {
  if (!proxyUrl) return baseEnv
  if (PROXY_ENV_KEYS.some(key => baseEnv[key])) return baseEnv

  return {
    ...baseEnv,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: baseEnv.NO_PROXY || baseEnv.no_proxy || 'localhost,127.0.0.1,::1',
  }
}

// The agent's PowerShellTool reads this env var to honor the user's chosen shell
// (mirrors src/utils/shell/powershellDetection.ts). Without it the agent would
// re-autodetect PowerShell instead of using the shell the user picked in the UI.
export const POWERSHELL_PATH_OVERRIDE_ENV = 'CLAUDE_CODE_POWERSHELL_PATH'

/**
 * Map a resolved Windows shell path to a PowerShell override for the sidecar env.
 * Returns the path only on Windows when it points at pwsh/powershell, so that a
 * cmd.exe or non-PowerShell custom shell selection does not get misreported as a
 * PowerShell override. Matches the consumer's isPowerShellExecutablePath check.
 */
export function windowsPowerShellOverride(
  shellPath: string | null | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'win32') return null
  const trimmed = shellPath?.trim()
  if (!trimmed) return null
  const base = trimmed.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '')
  return base === 'pwsh' || base === 'powershell' ? trimmed : null
}

export function buildSidecarEnv(baseEnv: NodeJS.ProcessEnv, h5DistDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    CLAUDE_H5_AUTO_PUBLIC_URL: '1',
    CLAUDE_H5_DIST_DIR: h5DistDir,
  }
  const configDir = baseEnv.CLAUDE_CONFIG_DIR
  if (configDir) {
    const cacheDir = path.join(configDir, 'Cache')
    mkdirSync(cacheDir, { recursive: true })
    env.CLAUDE_CONFIG_DIR = configDir
    env.XDG_CACHE_HOME = cacheDir
  }
  return env
}

export function createServerPlan({
  desktopRoot,
  appRoot,
  port,
  bindHost = SERVER_BIND_HOST,
  h5DistDir = path.join(desktopRoot, 'dist'),
  env = process.env,
}: {
  desktopRoot: string
  appRoot: string
  port: number
  bindHost?: string
  h5DistDir?: string
  env?: NodeJS.ProcessEnv
}): SidecarPlan {
  return {
    command: resolveSidecarExecutable(desktopRoot),
    args: ['server', '--app-root', appRoot, '--host', bindHost, '--port', String(port)],
    env: buildSidecarEnv(env, h5DistDir),
  }
}

export function createAdapterPlan({
  desktopRoot,
  appRoot,
  serverUrl,
  flag,
  h5DistDir = path.join(desktopRoot, 'dist'),
  env = process.env,
}: {
  desktopRoot: string
  appRoot: string
  serverUrl: string
  flag: '--feishu' | '--telegram' | '--wechat' | '--dingtalk' | '--whatsapp'
  h5DistDir?: string
  env?: NodeJS.ProcessEnv
}): SidecarPlan {
  return {
    command: resolveSidecarExecutable(desktopRoot),
    args: ['adapters', '--app-root', appRoot, flag],
    env: {
      ...buildSidecarEnv(env, h5DistDir),
      ADAPTER_SERVER_URL: httpToWebSocketUrl(serverUrl),
    },
  }
}

export function spawnSidecar(plan: SidecarPlan): SidecarChild {
  if (!existsSync(plan.command)) {
    throw new Error(`Electron sidecar binary not found: ${plan.command}. Run "cd desktop && bun run build:sidecars" first.`)
  }
  return spawn(plan.command, plan.args, {
    env: plan.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export type KillSidecarDeps = {
  platform?: NodeJS.Platform
  spawnAsync?: typeof spawn
  spawnSyncFn?: typeof spawnSync
}

/**
 * Terminate a sidecar process. On Windows we shell out to `taskkill /T` to also
 * reap the child process tree (the Bun sidecar spawns workers). Pass `sync=true`
 * during app shutdown so the kill completes before the process exits — otherwise
 * the async `taskkill` is fire-and-forget and can leave orphaned processes.
 */
export function killSidecar(child: SidecarChild, sync = false, deps: KillSidecarDeps = {}) {
  const platform = deps.platform ?? process.platform
  if (platform === 'win32' && child.pid) {
    const args = ['/F', '/T', '/PID', String(child.pid)]
    if (sync) (deps.spawnSyncFn ?? spawnSync)('taskkill', args, { stdio: 'ignore' })
    else (deps.spawnAsync ?? spawn)('taskkill', args, { stdio: 'ignore' })
    return
  }
  child.kill()
}
