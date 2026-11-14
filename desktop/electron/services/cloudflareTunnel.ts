import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveHostTriple } from './sidecarManager'
import { startCloudflareProxyTransport } from './cloudflareProxy'
import { recordPublicAccessDiagnostic, sanitizePublicAccessDiagnosticText, type PublicAccessDiagnosticWriter } from './publicAccessDiagnostics'

export type CloudflareTunnelPhase = 'starting' | 'registering' | 'ready'
export type CloudflareTunnelErrorCode = 'runtime' | 'network' | 'configuration' | 'proxy' | 'token' | 'route'

export class CloudflareTunnelError extends Error {
  constructor(
    public readonly code: CloudflareTunnelErrorCode,
    message: string,
    /** Main-process-only recovery handle; never expose it through an IPC status object. */
    public readonly retryStop?: () => Promise<void>,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'CloudflareTunnelError'
  }
}

export type CloudflareTunnelOptions = {
  mode: 'quick' | 'named'
  localPort: number
  token?: string
  proxyUrl?: string
  signal?: AbortSignal
  onPhase?: (phase: CloudflareTunnelPhase) => void
  onDiagnostic?: PublicAccessDiagnosticWriter
}

export type CloudflareTunnelExit = { code: number | null, signal: NodeJS.Signals | null }
/** One ingress rule of the configuration Cloudflare pushes to a dashboard-managed tunnel. */
export type CloudflareTunnelRoute = { hostname?: string, service?: string }
export type CloudflareTunnelRouteWait = { timeoutMs?: number, signal?: AbortSignal }
export type CloudflareTunnel = {
  /** The Quick Tunnel address. A named tunnel's hostname comes from its published routes. */
  url: string | null
  /**
   * The latest pushed ingress rules (null before any arrive). Waits until they are no longer
   * `seen`, the wait times out or is aborted, or the connector exits.
   */
  publishedRoutes(seen: CloudflareTunnelRoute[] | null, wait?: CloudflareTunnelRouteWait): Promise<CloudflareTunnelRoute[] | null>
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
const MAX_LOG_LINE_BYTES = 256 * 1024
// cloudflared logs every edge refusal of the registration RPC with this message and retries forever.
const SERVER_REFUSAL = /\bRegister tunnel error from server side\b/
// A second refusal before any registration rules out a one-off edge hiccup.
const TOKEN_REFUSALS = 2
// zerolog's console writer prints string fields with Go's strconv.Quote.
const PUSHED_CONFIGURATION = /\bUpdated to new configuration\b.*?\bconfig=("(?:[^"\\]|\\.)*")/
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

function validateOptions(options: CloudflareTunnelOptions) {
  if ((options.mode !== 'quick' && options.mode !== 'named') ||
    !Number.isInteger(options.localPort) || options.localPort < 1024 || options.localPort > 65535) {
    throw new CloudflareTunnelError('configuration', 'Invalid Cloudflare connection configuration')
  }
  if (options.mode === 'named' && (typeof options.token !== 'string' || !/^[A-Za-z0-9_+/=-]{20,8192}$/.test(options.token))) {
    throw new CloudflareTunnelError('token', 'A Cloudflare Tunnel Token is required')
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

/** Ingress rules from one connector log line announcing a configuration pushed by Cloudflare. */
export function readPublishedRoutes(line: string): CloudflareTunnelRoute[] | null {
  const quoted = line.match(PUSHED_CONFIGURATION)?.[1]
  if (!quoted) return null
  try {
    const configuration: unknown = JSON.parse(JSON.parse(quoted) as string)
    const ingress = configuration && typeof configuration === 'object' ? (configuration as { ingress?: unknown }).ingress : undefined
    if (!Array.isArray(ingress)) return null
    return ingress.filter((rule): rule is Record<string, unknown> => !!rule && typeof rule === 'object').map(rule => ({
      ...(typeof rule.hostname === 'string' && rule.hostname ? { hostname: rule.hostname } : {}),
      ...(typeof rule.service === 'string' ? { service: rule.service } : {}),
    }))
  } catch { return null }
}

function reachesGateway(route: CloudflareTunnelRoute, localPort: number): boolean {
  try {
    const service = new URL(route.service ?? '')
    return service.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(service.hostname) && Number(service.port) === localPort
  } catch { return false }
}

function hostnameOrigin(hostname: string): string | null {
  try {
    const url = new URL(`https://${hostname}`)
    return url.hostname === hostname.toLowerCase() && !url.port ? url.origin : null
  } catch { return null }
}

/**
 * The HTTPS origin whose pushed route sends traffic to this computer's plain-HTTP gateway.
 * `preferred` wins when a matching rule covers it, including a wildcard or catch-all rule.
 */
export function publishedGatewayOrigin(routes: CloudflareTunnelRoute[], localPort: number, preferred?: string): string | null {
  const gatewayRoutes = routes.filter(route => reachesGateway(route, localPort))
  if (preferred) {
    const host = new URL(preferred).hostname
    if (gatewayRoutes.some(route => {
      const pattern = route.hostname?.toLowerCase()
      return !pattern || pattern === host || (pattern.startsWith('*.') && host.endsWith(pattern.slice(1)))
    })) return preferred
  }
  for (const route of gatewayRoutes) {
    const origin = route.hostname && !route.hostname.includes('*') ? hostnameOrigin(route.hostname) : null
    if (origin) return origin
  }
  return null
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
  const startedAt = Date.now()
  const secrets = [options.token ?? '', options.proxyUrl ?? '']
  const diagnostic: PublicAccessDiagnosticWriter = event => recordPublicAccessDiagnostic(options.onDiagnostic, event, secrets)
  try { validateOptions(options) }
  catch (error) {
    diagnostic({ stage: 'configuration', outcome: 'failed', reason: 'invalid_configuration', error })
    throw error
  }
  if (options.signal?.aborted) throw aborted()
  const binary = dependencies.binaryPath ?? resolveBundledCloudflared(dependencies.desktopRoot ?? process.cwd())
  try {
    await access(binary, constants.X_OK)
    diagnostic({ stage: 'binary', outcome: 'succeeded', durationMs: Date.now() - startedAt })
  } catch (error) {
    diagnostic({ stage: 'binary', outcome: 'failed', reason: 'binary_unavailable', error, durationMs: Date.now() - startedAt })
    throw new CloudflareTunnelError('runtime', 'The bundled Cloudflare connector is unavailable', undefined, error)
  }
  if (options.signal?.aborted) throw aborted()

  let directory: string
  try { directory = await mkdtemp(path.join(dependencies.temporaryDirectory ?? os.tmpdir(), 'cc-haha-cloudflared-')) }
  catch (error) {
    diagnostic({ stage: 'connector_spawn', outcome: 'failed', reason: 'temporary_directory_failed', error, durationMs: Date.now() - startedAt })
    throw error
  }
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
  let registrationStartedAt: number | undefined
  const diagnosticTail: Array<{ sequence: number, line: string }> = []
  let outputSequence = 0
  const outputBuffers = { stdout: '', stderr: '' }
  const outputSequences = { stdout: 0, stderr: 0 }
  const discardingOutput = { stdout: false, stderr: false }
  const safeOutputLine = (value: string) => {
    // A process can exit halfway through an unlabelled credential. Never export
    // the matching prefix of the known tunnel token from that final fragment.
    const token = options.token
    if (token && token.length >= 8) {
      const start = value.lastIndexOf(token.slice(0, 8))
      if (start >= 0 && token.startsWith(value.slice(start))) value = `${value.slice(0, start)}[REDACTED]`
    }
    try { return sanitizePublicAccessDiagnosticText(value, secrets).slice(0, 512) }
    catch { return '' /* Optional log collection must never interrupt the connector's pipes. */ }
  }
  const diagnosticLogTail = () => {
    const pending = (['stdout', 'stderr'] as const).flatMap(stream => {
      if (discardingOutput[stream] || !outputBuffers[stream]) return []
      const line = safeOutputLine(outputBuffers[stream])
      return line ? [{ sequence: outputSequences[stream], line: `${stream}: ${line}` }] : []
    })
    // Snapshot pending fragments without consuming them: timeout and exit may
    // both need the same evidence, but each tail contains a line only once.
    return [...diagnosticTail, ...pending].sort((left, right) => left.sequence - right.sequence)
      .slice(-4).map(entry => entry.line).join('\n')
  }
  const captureOutput = (stream: keyof typeof outputBuffers, chunk: Buffer | string) => {
    if (!options.onDiagnostic) return
    // Assemble complete lines before redacting so a credential split between chunks
    // cannot escape exact-secret replacement. Oversized lines are discarded whole.
    for (const part of String(chunk).split(/(?<=\n)/)) {
      if (discardingOutput[stream]) {
        if (part.endsWith('\n')) discardingOutput[stream] = false
        continue
      }
      if (outputBuffers[stream].length + part.length > MAX_LOG_LINE_BYTES) {
        outputBuffers[stream] = ''
        discardingOutput[stream] = !part.endsWith('\n')
        continue
      }
      outputBuffers[stream] += part
      outputSequences[stream] = ++outputSequence
      if (!part.endsWith('\n')) continue
      const line = safeOutputLine(outputBuffers[stream])
      outputBuffers[stream] = ''
      if (!line) continue
      diagnosticTail.push({ sequence: outputSequences[stream], line: `${stream}: ${line}` })
      if (diagnosticTail.length > 4) diagnosticTail.shift()
    }
  }
  let resolveStartup!: (url: string | null) => void
  let rejectStartup!: (error: Error) => void
  let resolveExit!: () => void
  const exitCallbacks = new Set<(exit: CloudflareTunnelExit) => void>()
  const exit = new Promise<void>(resolve => { resolveExit = resolve })
  const startup = new Promise<string | null>((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject })
  // A spawn or proxy setup failure can happen before startup is awaited.
  void startup.catch(() => {})

  const reject = (error: Error, reason = error.name === 'AbortError' ? 'request_cancelled' : 'startup_failed') => {
    if (startupSettled) return
    startupSettled = true
    clearTimeout(startupTimer)
    if (registrationStartedAt !== undefined) diagnostic({ stage: 'tunnel_registration', outcome: error.name === 'AbortError' ? 'cancelled' : 'failed',
      reason, error, durationMs: Date.now() - registrationStartedAt,
      details: { timeoutMs: dependencies.timeoutMs ?? DEFAULT_START_TIMEOUT_MS, logTail: diagnosticLogTail() } })
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
      const proxyStartedAt = Date.now()
      try {
        transport = await (dependencies.startProxyTransport ?? startCloudflareProxyTransport)(options.proxyUrl, { signal: options.signal,
          ...(options.onDiagnostic ? { onDiagnostic: diagnostic } : {}) })
        if (!transport.edgeAddresses.length || transport.edgeAddresses.some(address => !isLoopbackAddress(address)) || !isLoopbackService(transport.quickServiceUrl)) {
          throw new Error('Invalid private proxy transport')
        }
        diagnostic({ stage: 'proxy_transport', outcome: 'succeeded', durationMs: Date.now() - proxyStartedAt })
      } catch (error) {
        diagnostic({ stage: 'proxy_transport', outcome: options.signal?.aborted ? 'cancelled' : 'failed', reason: 'transport_setup_failed', error, durationMs: Date.now() - proxyStartedAt })
        throw options.signal?.aborted ? aborted() : new CloudflareTunnelError('proxy', 'Cloudflare could not use the configured network proxy', undefined, error)
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
    const spawnStartedAt = Date.now()
    try {
      child = (dependencies.spawn ?? spawn)(binary, args, {
        cwd: directory,
        env: cloudflareProcessEnvironment(dependencies.env ?? process.env, directory, options.mode === 'named' ? options.token : undefined),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      diagnostic({ stage: 'connector_spawn', outcome: 'succeeded', durationMs: Date.now() - spawnStartedAt })
    } catch (error) {
      diagnostic({ stage: 'connector_spawn', outcome: 'failed', reason: 'spawn_failed', error, durationMs: Date.now() - spawnStartedAt })
      throw new CloudflareTunnelError('runtime', 'The Cloudflare connector could not be started', undefined, error)
    }
    registrationStartedAt = Date.now()

    let logWindow = ''
    let quickUrl: string | undefined
    let registered = false
    let startupErrorCode: CloudflareTunnelErrorCode | undefined
    let refusals = 0
    let partialLine = ''
    let routes: CloudflareTunnelRoute[] | null = null
    const routeWaiters = new Set<() => void>()
    const releaseRouteWaiters = () => { for (const release of [...routeWaiters]) release() }
    const onLines = (data: Buffer | string) => {
      const lines = (partialLine + String(data)).split('\n')
      partialLine = lines.pop()!
      if (partialLine.length > MAX_LOG_LINE_BYTES) partialLine = ''
      for (const line of lines) {
        if (!registered && SERVER_REFUSAL.test(line)) refusals++
        const pushed = readPublishedRoutes(line)
        if (pushed) { routes = pushed; releaseRouteWaiters() }
      }
    }
    const onData = (data: Buffer | string) => {
      if (stopping) return
      if (options.mode === 'named') onLines(data)
      if (startupSettled) return
      logWindow = (logWindow + String(data)).slice(-LOG_WINDOW_BYTES)
      quickUrl ??= logWindow.match(QUICK_URL)?.[0]
      registered ||= /\bRegistered tunnel connection\b/.test(logWindow)
      if (/provided.*token.*not valid|invalid tunnel token|failed to parse tunnel token/i.test(logWindow)) startupErrorCode = 'token'
      if (/incorrect usage|flag provided but not defined|unknown flag|unknown command/i.test(logWindow)) startupErrorCode = 'runtime'
      if (!registered && refusals >= TOKEN_REFUSALS) {
        reject(new CloudflareTunnelError('token', 'Cloudflare refused this tunnel token'), 'token_refused')
        return
      }
      if (registered && (options.mode === 'named' || quickUrl)) {
        startupSettled = true
        clearTimeout(startupTimer)
        diagnostic({ stage: 'tunnel_registration', outcome: 'succeeded', reason: 'edge_registered', durationMs: Date.now() - registrationStartedAt!,
          details: { mode: options.mode, hasPublicUrl: !!quickUrl } })
        phase(options, 'ready')
        resolveStartup(options.mode === 'quick' ? quickUrl! : null)
      }
    }

    const onExit = (code: number | null, signal: NodeJS.Signals | null = null) => {
      if (exited) return
      exited = true
      exitInfo = { code, signal }
      resolveExit()
      releaseRouteWaiters()
      diagnostic({ stage: 'connector_exit', outcome: stopping ? 'cancelled' : 'failed', reason: stopping ? 'connector_stopped' : 'connector_exited',
        durationMs: Date.now() - startedAt, details: { exitCode: code, exitSignal: signal, logTail: diagnosticLogTail() } })
      reject(new CloudflareTunnelError(startupErrorCode ?? (options.proxyUrl ? 'proxy' : 'network'), 'Cloudflare disconnected before the connection was ready'), 'exited_before_ready')
      if (!stopping) for (const callback of exitCallbacks) {
        try { callback(exitInfo) } catch { /* Keep other lifecycle observers informed. */ }
      }
      void cleanup().catch(() => {})
    }

    child.once('exit', onExit)
    child.once('error', error => {
      diagnostic({ stage: 'connector_spawn', outcome: 'failed', reason: 'spawn_failed', error, durationMs: Date.now() - spawnStartedAt })
      reject(new CloudflareTunnelError('runtime', 'The Cloudflare connector could not be started', undefined, error), 'spawn_failed')
      // A failed spawn has no process to terminate and does not necessarily emit `exit`.
      if (!child?.pid) onExit(null)
      else void stop().catch(() => {})
    })
    // Continue consuming both pipes after readiness; unconsumed logs can block the child.
    child.stdout?.on('data', (data: Buffer | string) => { captureOutput('stdout', data); onData(data) })
    child.stderr?.on('data', (data: Buffer | string) => { captureOutput('stderr', data); onData(data) })
    options.signal?.addEventListener('abort', onAbort, { once: true })
    startupTimer = setTimeout(() => reject(new CloudflareTunnelError(options.proxyUrl ? 'proxy' : 'network', 'Cloudflare connection timed out'), 'startup_timeout'), dependencies.timeoutMs ?? DEFAULT_START_TIMEOUT_MS)
    phase(options, 'registering')
    if (options.signal?.aborted) onAbort()

    const url = await startup
    if (exited || options.signal?.aborted) throw options.signal?.aborted ? aborted() : new CloudflareTunnelError('network', 'Cloudflare disconnected before the connection was ready')
    return {
      url,
      async publishedRoutes(seen, wait = {}) {
        if (routes === seen && !exited && !wait.signal?.aborted && (wait.timeoutMs === undefined || wait.timeoutMs > 0)) {
          let timer: ReturnType<typeof setTimeout> | undefined
          await new Promise<void>(resolve => {
            const release = () => {
              clearTimeout(timer)
              routeWaiters.delete(release)
              wait.signal?.removeEventListener('abort', release)
              resolve()
            }
            routeWaiters.add(release)
            wait.signal?.addEventListener('abort', release, { once: true })
            if (wait.timeoutMs !== undefined) timer = setTimeout(release, wait.timeoutMs)
          })
        }
        return routes
      },
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
    diagnostic({ stage: 'connector_spawn', outcome: 'failed', reason: 'connector_setup_failed', error, durationMs: Date.now() - startedAt })
    throw new CloudflareTunnelError('runtime', 'The Cloudflare connector could not be started', undefined, error)
  }
}
