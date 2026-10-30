import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveHostTriple } from './sidecarManager'
import { startCloudflareProxyTransport } from './cloudflareProxy'

export type CloudflareTunnelPhase = 'starting' | 'registering' | 'ready'
export type CloudflareTunnelErrorCode = 'runtime' | 'network' | 'configuration' | 'proxy'

export class CloudflareTunnelError extends Error {
  constructor(
    public readonly code: CloudflareTunnelErrorCode,
    message: string,
    /** Main-process-only recovery handle; never expose it through an IPC status object. */
    public readonly retryStop?: () => Promise<void>,
  ) {
    super(message)
    this.name = 'CloudflareTunnelError'
  }
}

export type CloudflareTunnelOptions = {
  mode: 'quick' | 'named'
  localPort: number
  publicUrl?: string
  token?: string
  proxyUrl?: string
  signal?: AbortSignal
  onPhase?: (phase: CloudflareTunnelPhase) => void
}

export type CloudflareTunnelExit = { code: number | null, signal: NodeJS.Signals | null }
export type CloudflareTunnel = {
  url: string
  stop(): Promise<void>
  onExit(callback: (exit: CloudflareTunnelExit) => void): () => void
}

export type CloudflareTunnelDependencies = {
  binaryPath?: string
  desktopRoot?: string
  spawn?: typeof spawn
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  stopTimeoutMs?: number
  temporaryDirectory?: string
  startProxyTransport?: typeof startCloudflareProxyTransport
}

const PROXY_ENVIRONMENT = /^(?:https?_proxy|all_proxy|no_proxy)$/i
const CLOUDFLARE_ENVIRONMENT = /^(?:TUNNEL_|CLOUDFLARED_|NO_AUTOUPDATE$)/i
const QUICK_URL = /https:\/\/(?!api\.)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com(?![a-z0-9.-])/i
const LOG_WINDOW_BYTES = 16 * 1024
const DEFAULT_START_TIMEOUT_MS = 30_000
const DEFAULT_STOP_TIMEOUT_MS = 2_000

/** The same target triple is used by sidecar packaging, including unpacked ASAR resources. */
export function resolveBundledCloudflared(
  desktopRoot: string,
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): string {
  const root = desktopRoot.replace(/\.asar$/, '.asar.unpacked')
  const suffix = platform === 'win32' ? '.exe' : ''
  return path.join(root, 'src-tauri', 'binaries', `cloudflared-${resolveHostTriple(platform, arch)}${suffix}`)
}

/** A desktop-owned connector never adopts another cloudflared installation's settings or token. */
export function cloudflareProcessEnvironment(
  source: NodeJS.ProcessEnv,
  directory: string,
  token?: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (!PROXY_ENVIRONMENT.test(key) && !CLOUDFLARE_ENVIRONMENT.test(key)) environment[key] = value
  }
  environment.HOME = directory
  environment.USERPROFILE = directory
  environment.XDG_CONFIG_HOME = directory
  environment.NO_AUTOUPDATE = 'true'
  if (token) environment.TUNNEL_TOKEN = token
  return environment
}

function aborted(): Error {
  const error = new Error('Cloudflare connection cancelled')
  error.name = 'AbortError'
  return error
}

function validateOptions(options: CloudflareTunnelOptions): string | undefined {
  if ((options.mode !== 'quick' && options.mode !== 'named') ||
    !Number.isInteger(options.localPort) || options.localPort < 1024 || options.localPort > 65535) {
    throw new CloudflareTunnelError('configuration', 'Invalid Cloudflare connection configuration')
  }
  if (options.mode === 'quick') return undefined
  if (typeof options.token !== 'string' || !/^[A-Za-z0-9_+/=-]{20,8192}$/.test(options.token)) {
    throw new CloudflareTunnelError('configuration', 'A Cloudflare Tunnel Token is required')
  }
  try {
    const origin = new URL(options.publicUrl ?? '')
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      throw new Error('Invalid origin')
    }
    return origin.origin
  } catch {
    throw new CloudflareTunnelError('configuration', 'A fixed HTTPS address is required')
  }
}

function phase(options: CloudflareTunnelOptions, value: CloudflareTunnelPhase) {
  try { options.onPhase?.(value) } catch { /* A status observer cannot interrupt connector cleanup. */ }
}

function isLoopbackAddress(value: string): boolean {
  try {
    const parsed = new URL(`http://${value}`)
    return ['127.0.0.1', '[::1]'].includes(parsed.hostname) &&
      !!parsed.port && parsed.pathname === '/' && !parsed.search && !parsed.hash && !parsed.username && !parsed.password
  } catch { return false }
}

function isLoopbackService(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(parsed.hostname) &&
      !!parsed.port && !parsed.search && !parsed.hash && !parsed.username && !parsed.password
  } catch { return false }
}

/**
 * Start the pinned, bundled connector. Readiness requires an edge registration as well
 * as a Quick Tunnel URL; a URL printed before the data connection is not a working tunnel.
 * PublicAccessManager separately verifies that this URL reaches its own gateway.
 */
export async function startCloudflareTunnel(
  options: CloudflareTunnelOptions,
  dependencies: CloudflareTunnelDependencies = {},
): Promise<CloudflareTunnel> {
  const namedUrl = validateOptions(options)
  if (options.signal?.aborted) throw aborted()
  const binary = dependencies.binaryPath ?? resolveBundledCloudflared(dependencies.desktopRoot ?? process.cwd())
  try {
    await access(binary, constants.X_OK)
  } catch {
    throw new CloudflareTunnelError('runtime', 'The bundled Cloudflare connector is unavailable')
  }
  if (options.signal?.aborted) throw aborted()

  const directory = await mkdtemp(path.join(dependencies.temporaryDirectory ?? os.tmpdir(), 'cc-haha-cloudflared-'))
  let transport: Awaited<ReturnType<typeof startCloudflareProxyTransport>> | undefined
  let child: ChildProcess | undefined
  let cleanupPromise: Promise<void> | undefined
  let transportStopPromise: Promise<void> | undefined
  let stopPromise: Promise<void> | undefined
  let exited = false
  let stopping = false
  let exitInfo: CloudflareTunnelExit | undefined
  let startupSettled = false
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let resolveStartup!: (url: string) => void
  let rejectStartup!: (error: Error) => void
  let resolveExit!: () => void
  const exitCallbacks = new Set<(exit: CloudflareTunnelExit) => void>()
  const exit = new Promise<void>(resolve => { resolveExit = resolve })
  const startup = new Promise<string>((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject })
  // A spawn or proxy setup failure can happen before startup is awaited.
  void startup.catch(() => {})

  const reject = (error: Error) => {
    if (startupSettled) return
    startupSettled = true
    clearTimeout(startupTimer)
    rejectStartup(error)
  }

  const stopTransport = () => {
    transportStopPromise ??= transport?.stop() ?? Promise.resolve()
    return transportStopPromise
  }

  const cleanup = () => {
    cleanupPromise ??= (async () => {
      clearTimeout(startupTimer)
      options.signal?.removeEventListener('abort', onAbort)
      try { await stopTransport() } finally { await rm(directory, { recursive: true, force: true }) }
    })()
    return cleanupPromise
  }

  const waitForExit = async (milliseconds: number): Promise<boolean> => {
    if (exited) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([exit, new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds) })])
      return exited
    } finally { clearTimeout(timer) }
  }

  const stop = () => {
    if (stopPromise) return stopPromise
    const operation = (async () => {
      stopping = true
      reject(aborted())
      if (child && !exited) {
        try { child.kill('SIGTERM') } catch { /* Escalate after the bounded grace period. */ }
        if (!await waitForExit(dependencies.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS)) {
          try { child.kill('SIGKILL') } catch { /* The confirmed exit is checked below. */ }
          if (!await waitForExit(dependencies.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS)) {
            // Cut the selected network transport even when the OS has not yet
            // acknowledged process termination. Keep the handle for a later retry.
            await stopTransport().catch(() => {})
            throw new CloudflareTunnelError('runtime', 'Cloudflare connector shutdown could not be confirmed', stop)
          }
        }
      }
      await cleanup()
    })()
    stopPromise = operation
    // A late OS exit can make a previously unconfirmed shutdown recoverable.
    void operation.catch(() => { if (stopPromise === operation) stopPromise = undefined })
    return operation
  }

  const onAbort = () => {
    reject(aborted())
    void stop().catch(() => {})
  }

  try {
    const configPath = path.join(directory, 'config.yml')
    await writeFile(configPath, '{}\n', { mode: 0o600 })
    if (options.proxyUrl) {
      try {
        transport = await (dependencies.startProxyTransport ?? startCloudflareProxyTransport)(options.proxyUrl, { signal: options.signal })
        if (!transport.edgeAddresses.length || transport.edgeAddresses.some(address => !isLoopbackAddress(address)) || !isLoopbackService(transport.quickServiceUrl)) {
          throw new Error('Invalid private proxy transport')
        }
      } catch {
        throw options.signal?.aborted ? aborted() : new CloudflareTunnelError('proxy', 'Cloudflare could not use the configured network proxy')
      }
    }
    if (options.signal?.aborted) throw aborted()

    // Current cloudflared has these flags at the global/tunnel level, before `run`.
    // TCP avoids the long QUIC retry/fallback delay on UDP-restricted networks.
    // HTTP/2 still connects to Cloudflare on TCP 7844; it is not a port-443 bypass.
    const args = ['--no-autoupdate', '--config', configPath, 'tunnel', '--metrics', '127.0.0.1:0', '--protocol', 'http2']
    if (transport) {
      // Built-in probes test the direct network rather than the selected CONNECT transport.
      args.push('--no-prechecks')
      for (const address of transport.edgeAddresses) args.push('--edge', address)
    }
    if (options.mode === 'quick') {
      if (transport) args.push('--quick-service', transport.quickServiceUrl)
      args.push('--url', `http://127.0.0.1:${options.localPort}`)
    } else args.push('run')

    phase(options, 'starting')
    if (options.signal?.aborted) throw aborted()
    try {
      child = (dependencies.spawn ?? spawn)(binary, args, {
        cwd: directory,
        env: cloudflareProcessEnvironment(dependencies.env ?? process.env, directory, options.mode === 'named' ? options.token : undefined),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      throw new CloudflareTunnelError('runtime', 'The Cloudflare connector could not be started')
    }

    let logWindow = ''
    let quickUrl: string | undefined
    let registered = false
    let startupErrorCode: CloudflareTunnelErrorCode | undefined
    const onData = (data: Buffer | string) => {
      if (stopping || startupSettled) return
      logWindow = (logWindow + String(data)).slice(-LOG_WINDOW_BYTES)
      quickUrl ??= logWindow.match(QUICK_URL)?.[0]
      registered ||= /\bRegistered tunnel connection\b/.test(logWindow)
      if (/provided.*token.*not valid|invalid tunnel token|failed to parse tunnel token/i.test(logWindow)) startupErrorCode = 'configuration'
      if (/incorrect usage|flag provided but not defined|unknown flag|unknown command/i.test(logWindow)) startupErrorCode = 'runtime'
      if (registered && (namedUrl || quickUrl)) {
        startupSettled = true
        clearTimeout(startupTimer)
        phase(options, 'ready')
        resolveStartup(namedUrl ?? quickUrl!)
      }
    }

    const onExit = (code: number | null, signal: NodeJS.Signals | null = null) => {
      if (exited) return
      exited = true
      exitInfo = { code, signal }
      resolveExit()
      reject(new CloudflareTunnelError(startupErrorCode ?? (options.proxyUrl ? 'proxy' : 'network'), 'Cloudflare disconnected before the connection was ready'))
      if (!stopping) for (const callback of exitCallbacks) {
        try { callback(exitInfo) } catch { /* Keep other lifecycle observers informed. */ }
      }
      void cleanup().catch(() => {})
    }

    child.once('exit', onExit)
    child.once('error', () => {
      reject(new CloudflareTunnelError('runtime', 'The Cloudflare connector could not be started'))
      // A failed spawn has no process to terminate and does not necessarily emit `exit`.
      if (!child?.pid) onExit(null)
      else void stop().catch(() => {})
    })
    // Continue consuming both pipes after readiness; unconsumed logs can block the child.
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    startupTimer = setTimeout(() => reject(new CloudflareTunnelError(options.proxyUrl ? 'proxy' : 'network', 'Cloudflare connection timed out')), dependencies.timeoutMs ?? DEFAULT_START_TIMEOUT_MS)
    phase(options, 'registering')
    if (options.signal?.aborted) onAbort()

    const url = await startup
    if (exited || options.signal?.aborted) throw options.signal?.aborted ? aborted() : new CloudflareTunnelError('network', 'Cloudflare disconnected before the connection was ready')
    return {
      url,
      stop,
      onExit(callback) {
        exitCallbacks.add(callback)
        if (exitInfo && !stopping) queueMicrotask(() => {
          if (exitCallbacks.has(callback)) {
            try { callback(exitInfo!) } catch { /* A late observer cannot interrupt cleanup. */ }
          }
        })
        return () => { exitCallbacks.delete(callback) }
      },
    }
  } catch (error) {
    await stop()
    if (error instanceof CloudflareTunnelError || (error instanceof Error && error.name === 'AbortError')) throw error
    throw new CloudflareTunnelError('runtime', 'The Cloudflare connector could not be started')
  }
}
