import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { Readable } from 'node:stream'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export const SERVER_BIND_HOST = '0.0.0.0'
export const SERVER_CONTROL_HOST = '127.0.0.1'
export const SERVER_STARTUP_LOG_LIMIT = 80
// Shared with the Tauri shell (src-tauri/src/lib.rs) so both desktop builds
// reuse the same sticky port across restarts (issue #767).
export const SERVER_STATE_FILE = 'desktop-server-state.json'
// Mirrors the server-side fixedPort range (h5AccessService MIN/MAX_FIXED_PORT).
const MIN_FIXED_PORT = 1024
const MAX_FIXED_PORT = 65535

export type SidecarChild = ChildProcessByStdio<null, Readable, Readable>

export type SidecarPlan = {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export type SpawnSidecarDeps = {
  existsSyncFn?: typeof existsSync
  spawnFn?: typeof spawn
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

function canBindPort(bindHost: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, bindHost, () => {
      server.close(() => resolve(true))
    })
  })
}

/**
 * Try the preferred ports in order (h5Access.fixedPort first, then the port
 * used by the previous run) and fall back to an OS-assigned random port when
 * all of them are taken, so the app always starts.
 */
export async function reserveServerPort(
  bindHost: string,
  preferred: number[],
): Promise<number> {
  for (const port of preferred) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
    if (await canBindPort(bindHost, port)) return port
    console.error(`[desktop] preferred server port ${port} unavailable`)
  }
  return await reserveLocalPort(bindHost)
}

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

/** Parse h5Access.fixedPort out of cc-haha/settings.json contents. */
export function parseH5FixedPort(contents: string): number | null {
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const h5Access = (value as Record<string, unknown>).h5Access
  if (!h5Access || typeof h5Access !== 'object') return null
  const port = (h5Access as Record<string, unknown>).fixedPort
  if (typeof port !== 'number' || !Number.isInteger(port)) return null
  return port >= MIN_FIXED_PORT && port <= MAX_FIXED_PORT ? port : null
}

export function readH5FixedPort(env: NodeJS.ProcessEnv = process.env): number | null {
  try {
    const settingsPath = path.join(claudeConfigDir(env), 'cc-haha', 'settings.json')
    return parseH5FixedPort(readFileSync(settingsPath, 'utf-8'))
  } catch {
    return null
  }
}

export function readLastServerPort(env: NodeJS.ProcessEnv = process.env): number | null {
  try {
    const statePath = path.join(claudeConfigDir(env), SERVER_STATE_FILE)
    const state: unknown = JSON.parse(readFileSync(statePath, 'utf-8'))
    if (!state || typeof state !== 'object') return null
    const port = (state as Record<string, unknown>).lastPort
    if (typeof port !== 'number' || !Number.isInteger(port)) return null
    return port > 0 && port <= 65535 ? port : null
  } catch {
    return null
  }
}

export function writeLastServerPort(port: number, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const dir = claudeConfigDir(env)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, SERVER_STATE_FILE), `${JSON.stringify({ lastPort: port }, null, 2)}\n`, 'utf-8')
  } catch (error) {
    console.error('[desktop] failed to persist server state', error)
  }
}

/** Preferred ports for the next server start: explicit fixed port first, then the sticky last-used port. */
export function preferredServerPorts(env: NodeJS.ProcessEnv = process.env): number[] {
  const ports: number[] = []
  const fixedPort = readH5FixedPort(env)
  if (fixedPort !== null) ports.push(fixedPort)
  const lastPort = readLastServerPort(env)
  if (lastPort !== null && !ports.includes(lastPort)) ports.push(lastPort)
  return ports
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

export function buildSidecarEnv(baseEnv: NodeJS.ProcessEnv, h5DistDir: string, desktopRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    CLAUDE_H5_AUTO_PUBLIC_URL: '1',
    CLAUDE_H5_DIST_DIR: h5DistDir,
    CLAUDE_CODE_PLUGIN_SEED_DIR: path.join(desktopRoot, 'plugin-seed'),
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
    env: buildSidecarEnv(env, h5DistDir, desktopRoot),
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
      ...buildSidecarEnv(env, h5DistDir, desktopRoot),
      ADAPTER_SERVER_URL: httpToWebSocketUrl(serverUrl),
    },
  }
}

export function spawnSidecar(plan: SidecarPlan, deps: SpawnSidecarDeps = {}): SidecarChild {
  const exists = deps.existsSyncFn ?? existsSync
  if (!exists(plan.command)) {
    throw new Error(`Electron sidecar binary not found: ${plan.command}. Run "cd desktop && bun run build:sidecars" first.`)
  }
  return (deps.spawnFn ?? spawn)(plan.command, plan.args, {
    env: plan.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

export type H5TunnelMode = 'quick' | 'named'

// Quick-tunnel URL printed by cloudflared on stderr, e.g.
// "https://random-words-1234.trycloudflare.com".
export const TRYCLOUDFLARE_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

/**
 * Locate the cloudflared executable. Honors an explicit override, then PATH,
 * then the common Windows install location. Returns null when not found so the
 * caller can surface a friendly "install cloudflared" message.
 */
export function resolveCloudflaredPath(
  env: NodeJS.ProcessEnv = process.env,
  deps: { existsSyncFn?: typeof existsSync; platform?: NodeJS.Platform } = {},
): string | null {
  const exists = deps.existsSyncFn ?? existsSync
  const platform = deps.platform ?? process.platform

  const override = env.CLOUDFLARED_PATH?.trim()
  if (override) return exists(override) ? override : null

  const candidates: string[] = []
  if (platform === 'win32') {
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const programFiles = env.ProgramFiles || 'C:\\Program Files'
    candidates.push(
      path.join(programFilesX86, 'cloudflared', 'cloudflared.exe'),
      path.join(programFiles, 'cloudflared', 'cloudflared.exe'),
    )
  } else {
    candidates.push('/usr/local/bin/cloudflared', '/usr/bin/cloudflared', '/opt/homebrew/bin/cloudflared')
  }

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }

  // Fall back to a bare command name; spawn will resolve it via PATH. We return
  // it as-is (the tunnel spawner does not gate on existsSync, unlike sidecars).
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
}

/**
 * Build the cloudflared invocation.
 * - quick: ephemeral tunnel to a random trycloudflare.com URL (no credentials).
 * - named: persistent tunnel bound to the user's domain via a Cloudflare token.
 */
export function createTunnelPlan({
  cloudflaredPath,
  port,
  mode,
  token,
  controlHost = SERVER_CONTROL_HOST,
  env = process.env,
}: {
  cloudflaredPath: string
  port: number
  mode: H5TunnelMode
  token?: string | null
  controlHost?: string
  env?: NodeJS.ProcessEnv
}): SidecarPlan {
  if (mode === 'named') {
    if (!token) {
      throw new Error('A Cloudflare tunnel token is required for the named tunnel mode.')
    }
    return {
      command: cloudflaredPath,
      args: ['tunnel', '--no-autoupdate', 'run', '--token', token],
      env,
    }
  }

  return {
    command: cloudflaredPath,
    args: ['tunnel', '--no-autoupdate', '--url', `http://${controlHost}:${port}`],
    env,
  }
}

/**
 * Spawn cloudflared without the existsSync gate (the binary may live on PATH as
 * a bare command name). Stdio is piped so the caller can scrape the URL.
 */
export function spawnTunnel(plan: SidecarPlan, deps: SpawnSidecarDeps = {}): SidecarChild {
  return (deps.spawnFn ?? spawn)(plan.command, plan.args, {
    env: plan.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

/**
 * Resolve with the first quick-tunnel URL cloudflared prints on stderr. Rejects
 * if the process exits first or the timeout elapses. Listeners are attached
 * synchronously by the caller right after spawn to avoid missing an early line.
 */
export function waitForTunnelUrl(
  child: SidecarChild,
  options: { regex?: RegExp; timeoutMs?: number } = {},
): Promise<string> {
  const regex = options.regex ?? TRYCLOUDFLARE_URL_RE
  const timeoutMs = options.timeoutMs ?? 30_000

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      child.off('exit', onExit)
      fn()
    }

    const onData = (chunk: Buffer | string) => {
      const match = String(chunk).match(regex)
      if (match) finish(() => resolve(match[0]))
    }
    const onExit = (code: number | null) => {
      finish(() => reject(new Error(`cloudflared exited before printing a tunnel URL (code=${code})`)))
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Timed out waiting for cloudflared tunnel URL after ${Math.round(timeoutMs / 1000)}s`)))
    }, timeoutMs)

    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', onExit)
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
    const options = { stdio: 'ignore', windowsHide: true } as const
    if (sync) (deps.spawnSyncFn ?? spawnSync)('taskkill', args, options)
    else (deps.spawnAsync ?? spawn)('taskkill', args, options)
    return
  }
  child.kill()
}
