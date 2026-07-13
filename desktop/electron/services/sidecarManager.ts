import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process'
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import type { Readable } from 'node:stream'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { isBrowserSafePort } from '../../src/lib/browserSafePort'

export const SERVER_BIND_HOST = '0.0.0.0'
export const SERVER_CONTROL_HOST = '127.0.0.1'
export const SERVER_STARTUP_TIMEOUT_MS = 30_000
export const SERVER_STARTUP_LOG_LIMIT = 80
export const HOST_DIAGNOSTICS_LINE_LIMIT = 80
export const HOST_DIAGNOSTICS_BYTE_LIMIT = 256 * 1024
export const ELECTRON_DIAGNOSTICS_FILE_ENV = 'CC_HAHA_ELECTRON_DIAGNOSTICS_FILE'
const HOST_DIAGNOSTICS_LINE_BYTE_LIMIT = 4096
// Shared with the Tauri shell (src-tauri/src/lib.rs) so both desktop builds
// reuse the same sticky port across restarts (issue #767).
export const SERVER_STATE_FILE = 'desktop-server-state.json'
// Mirrors the server-side fixedPort range (h5AccessService MIN/MAX_FIXED_PORT).
const MIN_FIXED_PORT = 1024
const MAX_FIXED_PORT = 65535
const MAX_PORT_RESERVATION_ATTEMPTS = 128

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
const LOOPBACK_NO_PROXY_ENTRIES = ['localhost', '127.0.0.1', '::1'] as const

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

export type ReserveLocalPortDeps = {
  reserveCandidate?: (bindHost: string) => Promise<number>
}

async function reserveLocalPortCandidate(bindHost: string): Promise<number> {
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

export async function reserveLocalPort(
  bindHost = SERVER_BIND_HOST,
  deps: ReserveLocalPortDeps = {},
): Promise<number> {
  const reserveCandidate = deps.reserveCandidate ?? reserveLocalPortCandidate
  for (let attempt = 0; attempt < MAX_PORT_RESERVATION_ATTEMPTS; attempt++) {
    const port = await reserveCandidate(bindHost)
    if (isBrowserSafePort(port)) return port
    console.error(`[desktop] OS assigned browser-blocked server port ${port}; retrying`)
  }
  throw new Error('Could not reserve a browser-safe local port')
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
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      console.error(`[desktop] preferred server port ${port} is invalid; skipping`)
      continue
    }
    if (!isBrowserSafePort(port)) {
      console.error(`[desktop] preferred server port ${port} is blocked by browser fetch; skipping`)
      continue
    }
    if (await canBindPort(bindHost, port)) return port
    console.error(`[desktop] preferred server port ${port} unavailable`)
  }
  return await reserveLocalPort(bindHost)
}

export function claudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): string {
  return env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude')
}

export function electronHostDiagnosticsFile(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = os.homedir(),
): string {
  return path.join(claudeConfigDir(env, homeDir), 'cc-haha', 'diagnostics', 'electron-host.log')
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
  return port >= MIN_FIXED_PORT && port <= MAX_FIXED_PORT && isBrowserSafePort(port) ? port : null
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
    return isBrowserSafePort(port) ? port : null
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

export async function waitForServer(host: string, port: number, timeoutMs = SERVER_STARTUP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const healthUrl = `http://${host}:${port}/health`
  let lastError: Error | null = null

  while (Date.now() < deadline) {
    try {
      await assertServerHealth(healthUrl, Math.min(500, Math.max(100, deadline - Date.now())))
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
    await sleep(150)
  }

  const reason = lastError ? `: ${lastError.message}` : ''
  throw new Error(`desktop server did not report healthy at ${healthUrl} within ${Math.round(timeoutMs / 1000)} seconds${reason}`)
}

async function assertServerHealth(healthUrl: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(healthUrl, {
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`healthcheck returned ${response.status}`)

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().includes('application/json')) {
      throw new Error(`healthcheck returned non-JSON response from ${healthUrl}`)
    }

    const body = await response.json().catch(() => null)
    if (!body || typeof body !== 'object' || !('status' in body) || body.status !== 'ok') {
      throw new Error(`healthcheck returned invalid response from ${healthUrl}`)
    }
  } finally {
    clearTimeout(timeout)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function pushStartupLog(logs: string[], line: string) {
  const trimmed = sanitizeHostDiagnostic(line, os.homedir())
  if (!trimmed) return
  if (logs.length >= SERVER_STARTUP_LOG_LIMIT) logs.shift()
  logs.push(trimmed)
}

export function appendHostDiagnostic(
  filePath: string | undefined,
  line: string,
  { homeDir = os.homedir() }: { homeDir?: string } = {},
): void {
  if (!filePath) return
  const tempPath = `${filePath}.${process.pid}.tmp`
  try {
    const sanitized = sanitizeHostDiagnostic(line, homeDir)
    if (!sanitized) return
    const existing = readHostDiagnosticsTail(filePath)
    const lines = existing.trimEnd()
      ? existing.trimEnd().split('\n').map(entry => sanitizeHostDiagnostic(entry, homeDir)).filter(Boolean)
      : []
    lines.push(sanitized)
    const boundedLines: string[] = []
    let retainedBytes = 0
    for (const entry of lines.slice(-HOST_DIAGNOSTICS_LINE_LIMIT).reverse()) {
      const entryBytes = Buffer.byteLength(entry, 'utf-8') + 1
      if (retainedBytes + entryBytes > HOST_DIAGNOSTICS_BYTE_LIMIT) break
      boundedLines.unshift(entry)
      retainedBytes += entryBytes
    }
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(tempPath, `${boundedLines.join('\n')}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    })
    renameSync(tempPath, filePath)
  } catch {
    try {
      rmSync(tempPath, { force: true })
    } catch {
      // Best-effort cleanup must not mask the original diagnostics failure.
    }
    console.error('[desktop] failed to persist Electron host diagnostics')
  }
}

function readHostDiagnosticsTail(filePath: string): string {
  let descriptor: number | undefined
  try {
    descriptor = openSync(filePath, 'r')
    const size = fstatSync(descriptor).size
    const length = Math.min(size, HOST_DIAGNOSTICS_BYTE_LIMIT)
    const buffer = Buffer.alloc(length)
    const bytesRead = readSync(descriptor, buffer, 0, length, size - length)
    const tail = buffer.subarray(0, bytesRead).toString('utf-8')
    if (size <= length) return tail
    const firstNewline = tail.indexOf('\n')
    return firstNewline >= 0 ? tail.slice(firstNewline + 1) : ''
  } catch {
    return ''
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

export function sanitizeHostDiagnostic(line: string, homeDir = os.homedir()): string {
  let sanitized = line
    .replace(/[\r\n]+/g, ' ')
    .replace(/https?:\/\/[^\s<>"')\]}]+/gi, candidate => sanitizeUrlUserinfo(candidate))
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b((?:(?:[a-z0-9]+_)*(?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|password|secret))\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:sk-(?:ant-api03-|proj-)?|ghp_)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .trimEnd()
  if (homeDir) sanitized = sanitized.replaceAll(homeDir, '[HOME]')
  return truncateUtf8(sanitized, HOST_DIAGNOSTICS_LINE_BYTE_LIMIT)
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf-8')
  if (buffer.byteLength <= maxBytes) return value
  return buffer.subarray(0, maxBytes).toString('utf-8').replace(/\uFFFD$/, '')
}

function sanitizeUrlUserinfo(candidate: string): string {
  try {
    const url = new URL(candidate)
    if (!url.username && !url.password) return candidate
    return `${url.protocol}//[REDACTED]@${url.host}${url.pathname}${url.search}${url.hash}`
  } catch {
    return '[REDACTED_URL]'
  }
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
  if (PROXY_ENV_KEYS.some(key => baseEnv[key])) {
    const noProxy = mergeLoopbackNoProxy(baseEnv.no_proxy || baseEnv.NO_PROXY)
    return { ...baseEnv, NO_PROXY: noProxy, no_proxy: noProxy }
  }

  const noProxy = mergeLoopbackNoProxy(baseEnv.no_proxy || baseEnv.NO_PROXY)

  return {
    ...baseEnv,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  }
}

function mergeLoopbackNoProxy(existing: string | undefined): string {
  const entries = (existing ?? '')
    .split(/[,\s]+/)
    .map(entry => entry.trim())
    .filter(Boolean)
  const lowerEntries = new Set(entries.map(entry => entry.toLowerCase()))

  for (const entry of LOOPBACK_NO_PROXY_ENTRIES) {
    if (!lowerEntries.has(entry.toLowerCase())) entries.push(entry)
  }

  return entries.join(',')
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
