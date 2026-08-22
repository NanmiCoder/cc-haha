import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  appendHostDiagnostic,
  clearProxyEnv,
  createAdapterPlan,
  createServerPlan,
  ELECTRON_DIAGNOSTICS_FILE_ENV,
  formatStartupError,
  killSidecar,
  POWERSHELL_PATH_OVERRIDE_ENV,
  preferredServerPorts,
  pushStartupLog,
  reserveServerPort,
  sanitizeHostDiagnostic,
  SERVER_BIND_HOST,
  SERVER_CONTROL_HOST,
  SERVER_STARTUP_TIMEOUT_MS,
  spawnSidecar,
  waitForServer,
  withAdapterProxyBridgeEnv,
  withSystemProxyBridgeEnv,
  withSystemProxyErrorEnv,
  windowsPowerShellOverride,
  writeLastServerPort,
  type SidecarChild,
} from './sidecarManager'
import { readDesktopTerminalConfig, resolveDesktopTerminalShell } from './terminal'
import {
  SystemProxyBridge,
  type SystemProxyBridgeLike,
} from './systemProxyBridge'

type ServerRuntimeOptions = {
  desktopRoot: string
  appRoot?: string
  h5DistDir?: string
  diagnosticsFile?: string
  env?: NodeJS.ProcessEnv
  deps?: Partial<ServerRuntimeDeps>
  resolveSystemProxy?: (url: string) => Promise<string>
}

type ServerRuntimeDeps = {
  appendHostDiagnostic: typeof appendHostDiagnostic
  now: () => number
  preferredServerPorts: typeof preferredServerPorts
  reserveServerPort: typeof reserveServerPort
  sleep: (delayMs: number) => Promise<void>
  spawnSidecar: typeof spawnSidecar
  waitForServer: typeof waitForServer
  writeLastServerPort: typeof writeLastServerPort
  createSystemProxyBridge: (resolveSystemProxy: (url: string) => Promise<string>) => SystemProxyBridgeLike
}

const DEFAULT_SERVER_RUNTIME_DEPS: ServerRuntimeDeps = {
  appendHostDiagnostic,
  now: Date.now,
  preferredServerPorts,
  reserveServerPort,
  sleep: delayMs => new Promise(resolve => setTimeout(resolve, delayMs)),
  spawnSidecar,
  waitForServer,
  writeLastServerPort,
  createSystemProxyBridge: resolveSystemProxy => new SystemProxyBridge(resolveSystemProxy),
}

const AUTOMATIC_RESTART_LIMIT = 3
const AUTOMATIC_RESTART_STABLE_MS = 60_000
const AUTOMATIC_RESTART_COOLDOWN_MS = 60_000
const AUTOMATIC_RESTART_BACKOFF_MS = [0, 250, 1_000] as const

type ServerStartState = {
  child: SidecarChild
  adapterChildren: SidecarChild[]
  childStopped: boolean
  readonly failure: Error | null
  failurePromise: Promise<never>
  fail: (error: Error) => void
}

type ActiveServer = {
  url: string
  child: SidecarChild
  adapterChildren: SidecarChild[]
  startedAt: number
}

function createServerStartState(child: SidecarChild): ServerStartState {
  let failure: Error | null = null
  let rejectFailure!: (error: Error) => void
  const failurePromise = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject
  })
  return {
    child,
    adapterChildren: [],
    childStopped: false,
    get failure() {
      return failure
    },
    failurePromise,
    fail(error) {
      if (failure) return
      failure = error
      rejectFailure(error)
    },
  }
}

export class ElectronServerRuntime {
  private readonly desktopRoot: string
  private readonly appRoot: string
  private readonly h5DistDir: string
  private readonly diagnosticsFile?: string
  private readonly baseEnv: NodeJS.ProcessEnv
  private readonly deps: ServerRuntimeDeps
  private readonly resolveSystemProxy?: (url: string) => Promise<string>
  private readonly localAccessToken = randomBytes(32).toString('base64url')
  private readonly petAccessToken = randomBytes(32).toString('base64url')
  private sidecarEnvPromise: Promise<NodeJS.ProcessEnv> | null = null
  private systemProxyBridge: SystemProxyBridgeLike | null = null
  private server: ActiveServer | null = null
  private adapters: SidecarChild[] = []
  private startupError: string | null = null
  private restartAfterExit = false
  private automaticRestartAttempts = 0
  private restartBlockedUntil = 0
  private restartNotBefore = 0
  private startPromise: Promise<string> | null = null
  private lifecycleGeneration = 0
  private startingServer: ServerStartState | null = null
  private adapterRestartPromise: Promise<void> | null = null

  constructor(options: ServerRuntimeOptions) {
    this.desktopRoot = options.desktopRoot
    this.appRoot = options.appRoot ?? options.desktopRoot
    this.h5DistDir = options.h5DistDir ?? path.join(options.desktopRoot, 'dist')
    this.diagnosticsFile = options.diagnosticsFile
    this.baseEnv = options.env ?? process.env
    this.deps = { ...DEFAULT_SERVER_RUNTIME_DEPS, ...options.deps }
    this.resolveSystemProxy = options.resolveSystemProxy
  }

  async startServer(): Promise<string> {
    if (this.server) return this.server.url
    if (this.startPromise) return this.startPromise
    this.assertRestartCircuitAllowsStart()

    this.restartAfterExit = false
    const generation = this.lifecycleGeneration
    const restartDelayMs = Math.max(0, this.restartNotBefore - this.deps.now())
    this.startPromise = this.startServerAfterDelay(generation, restartDelayMs)
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async getServerUrl(): Promise<string> {
    if (this.server) return this.server.url
    if (this.startPromise) return await this.startServer()
    this.assertRestartCircuitAllowsStart()
    if (this.startupError && !this.restartAfterExit) throw new Error(this.startupError)
    return await this.startServer()
  }

  getLocalAccessToken(): string {
    return this.localAccessToken
  }

  getPetAccessToken(): string {
    return this.petAccessToken
  }

  getActiveServerUrl(): string | null {
    return this.server?.url ?? null
  }

  restartAdaptersSidecars(): Promise<void> {
    if (this.adapterRestartPromise) return this.adapterRestartPromise
    const operation = this.restartAdaptersSidecarsOnce()
    const tracked = operation.finally(() => {
      if (this.adapterRestartPromise === tracked) this.adapterRestartPromise = null
    })
    this.adapterRestartPromise = tracked
    return tracked
  }

  private async restartAdaptersSidecarsOnce(): Promise<void> {
    const serverUrl = await this.getServerUrl()
    const server = this.server
    if (!server || server.url !== serverUrl) return
    this.stopAdapterChildren(server.adapterChildren)
    await this.startAdaptersSidecars(serverUrl, undefined, server)
  }

  stopAll(sync = false) {
    ++this.lifecycleGeneration
    this.restartNotBefore = 0
    const starting = this.startingServer
    if (starting) {
      this.startingServer = null
      this.stopAdaptersForStart(starting, sync)
      if (this.server?.child === starting.child) this.server = null
      starting.fail(new Error('server startup stopped'))
      if (!starting.childStopped) {
        starting.childStopped = true
        killSidecar(starting.child, sync)
      }
    }
    this.stopAdaptersSidecars(sync)
    if (this.server) {
      killSidecar(this.server.child, sync)
      this.server = null
    }
    this.stopSystemProxyBridge()
  }

  private async startServerAfterDelay(generation: number, delayMs: number): Promise<string> {
    if (delayMs > 0) await this.deps.sleep(delayMs)
    this.assertCurrentGeneration(generation)
    return await this.startServerOnce(generation)
  }

  private async startServerOnce(generation: number): Promise<string> {
    // Prefer the configured fixed port, then the previous run's port, so
    // phone bookmarks / QR codes / reverse proxies survive restarts (#767).
    const port = await this.deps.reserveServerPort(
      SERVER_BIND_HOST,
      this.deps.preferredServerPorts(this.baseEnv),
    )
    const url = `http://${SERVER_CONTROL_HOST}:${port}`
    const logs: string[] = []
    let startState: ServerStartState | null = null
    const env = this.withServerAccessTokens(await this.resolveSidecarBaseEnv())
    this.assertCurrentGeneration(generation)
    const plan = createServerPlan({
      desktopRoot: this.desktopRoot,
      appRoot: this.appRoot,
      port,
      h5DistDir: this.h5DistDir,
      env: this.diagnosticsFile
        ? { ...env, [ELECTRON_DIAGNOSTICS_FILE_ENV]: this.diagnosticsFile }
        : env,
    })

    try {
      const child = this.deps.spawnSidecar(plan)
      startState = createServerStartState(child)
      this.startingServer = startState
      this.captureLogs(child, 'claude-server', logs, (code, signal) => {
        this.handleServerExit(child, code, signal, logs)
      }, error => {
        this.handleServerError(child, error, logs)
      })
      await Promise.race([
        this.deps.waitForServer(SERVER_CONTROL_HOST, port, SERVER_STARTUP_TIMEOUT_MS),
        startState.failurePromise,
      ])
      if (startState.failure) throw startState.failure
      this.deps.writeLastServerPort(port, this.baseEnv)
      this.server = {
        url,
        child,
        adapterChildren: startState.adapterChildren,
        startedAt: this.deps.now(),
      }
      const activeServer = this.server
      this.startupError = null
      this.stopAdaptersSidecars()
      await Promise.race([
        this.startAdaptersSidecars(url, startState, activeServer),
        startState.failurePromise,
      ])
      if (startState.failure) throw startState.failure
      return url
    } catch (error) {
      if (startState) {
        this.stopAdaptersForStart(startState)
        if (this.server?.child === startState.child) this.server = null
        if (!startState.childStopped) {
          startState.childStopped = true
          killSidecar(startState.child)
        }
      }
      if (startState?.failure) {
        throw new Error(this.startupError ?? startState.failure.message)
      }
      const message = error instanceof Error ? error.message : String(error)
      this.deps.appendHostDiagnostic(this.diagnosticsFile, `[claude-server] [startup-error] ${message}`)
      this.startupError = formatStartupError(message, logs)
      throw new Error(this.startupError)
    } finally {
      if (this.startingServer === startState) this.startingServer = null
    }
  }

  private assertCurrentGeneration(generation: number): void {
    if (generation !== this.lifecycleGeneration) throw new Error('server startup stopped')
  }

  private async startAdaptersSidecars(
    serverUrl: string,
    startState?: ServerStartState,
    activeServer?: ActiveServer,
  ): Promise<void> {
    const baseEnv = this.withLocalAccessToken(await this.resolveSidecarBaseEnv())
    const bridgeUrl = baseEnv.CC_HAHA_SYSTEM_PROXY_URL
    const env = bridgeUrl
      ? withAdapterProxyBridgeEnv(baseEnv, bridgeUrl)
      : baseEnv
    const isCurrentGeneration = () => {
      if (startState?.failure) return false
      if (activeServer && this.server !== activeServer) return false
      return true
    }
    if (!isCurrentGeneration()) return
    const ownedAdapters = startState?.adapterChildren
      ?? activeServer?.adapterChildren
    for (const [label, flag] of [
      ['feishu', '--feishu'],
      ['telegram', '--telegram'],
      ['wechat', '--wechat'],
      ['dingtalk', '--dingtalk'],
      ['whatsapp', '--whatsapp'],
    ] as const) {
      if (!isCurrentGeneration()) break
      try {
        const child = this.deps.spawnSidecar(createAdapterPlan({
          desktopRoot: this.desktopRoot,
          appRoot: this.appRoot,
          h5DistDir: this.h5DistDir,
          serverUrl,
          flag,
          env,
        }))
        if (!isCurrentGeneration()) {
          killSidecar(child)
          break
        }
        this.captureLogs(child, `claude-adapters:${label}`)
        this.adapters.push(child)
        ownedAdapters?.push(child)
      } catch (error) {
        console.error(`[desktop] failed to start ${label} adapter sidecar`, error)
      }
    }
  }

  private stopAdaptersSidecars(sync = false) {
    const children = this.adapters.splice(0)
    this.removeOwnedAdapters(this.server?.adapterChildren, children)
    this.removeOwnedAdapters(this.startingServer?.adapterChildren, children)
    for (const child of children) {
      killSidecar(child, sync)
    }
  }

  private withLocalAccessToken(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
      ...env,
      CC_HAHA_LOCAL_ACCESS_TOKEN: this.localAccessToken,
    }
  }

  private withServerAccessTokens(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
      ...this.withLocalAccessToken(env),
      CC_HAHA_PET_ACCESS_TOKEN: this.petAccessToken,
    }
  }

  private removeOwnedAdapters(owned: SidecarChild[] | undefined, removed: SidecarChild[]) {
    if (!owned?.length || !removed.length) return
    const removedSet = new Set(removed)
    const retained = owned.filter(child => !removedSet.has(child))
    owned.splice(0, owned.length, ...retained)
  }

  private stopAdaptersForStart(startState: ServerStartState, sync = false) {
    this.stopAdapterChildren(startState.adapterChildren, sync)
  }

  private captureLogs(
    child: SidecarChild,
    label: string,
    startupLogs?: string[],
    onExit?: (code: number | null, signal: NodeJS.Signals | null) => void,
    onError?: (error: Error) => void,
  ) {
    child.stdout.on('data', chunk => {
      const line = String(chunk).trimEnd()
      if (!line) return
      console.log(`[${label}] ${line}`)
      this.deps.appendHostDiagnostic(this.diagnosticsFile, `[${label}] [stdout] ${line}`)
      if (startupLogs) pushStartupLog(startupLogs, `[stdout] ${line}`)
    })
    child.stderr.on('data', chunk => {
      const line = String(chunk).trimEnd()
      if (!line) return
      console.error(`[${label}] ${line}`)
      this.deps.appendHostDiagnostic(this.diagnosticsFile, `[${label}] [stderr] ${line}`)
      if (startupLogs) pushStartupLog(startupLogs, `[stderr] ${line}`)
    })
    child.on('exit', (code, signal) => {
      const line = `sidecar exited (code=${code}, signal=${signal})`
      console.log(`[${label}] ${line}`)
      this.deps.appendHostDiagnostic(this.diagnosticsFile, `[${label}] [exit] ${line}`)
      if (startupLogs) pushStartupLog(startupLogs, `[exit] ${line}`)
      onExit?.(code, signal)
    })
    child.on('error', error => {
      const message = error instanceof Error ? error.message : String(error)
      const line = `sidecar process error: ${message}`
      console.error(`[${label}] ${sanitizeHostDiagnostic(line)}`)
      this.deps.appendHostDiagnostic(this.diagnosticsFile, `[${label}] [process-error] ${line}`)
      if (startupLogs) pushStartupLog(startupLogs, `[process-error] ${line}`)
      onError?.(error instanceof Error ? error : new Error(message))
    })
  }

  private handleServerExit(
    child: SidecarChild,
    code: number | null,
    signal: NodeJS.Signals | null,
    logs: string[],
  ) {
    this.handleServerFailure(
      child,
      `server sidecar exited after spawn (code=${code}, signal=${signal})`,
      logs,
    )
  }

  private handleServerError(child: SidecarChild, error: Error, logs: string[]) {
    this.handleServerFailure(
      child,
      `server sidecar process error after spawn: ${sanitizeHostDiagnostic(error.message)}`,
      logs,
    )
  }

  private handleServerFailure(child: SidecarChild, message: string, logs: string[]) {
    const active = this.server?.child === child
    const starting = this.startingServer?.child === child
    if (!active && !starting) return
    const failedServer = active ? this.server : null
    if (active) {
      const adapterChildren = this.server!.adapterChildren
      this.server = null
      this.stopAdapterChildren(adapterChildren)
    }
    this.restartAfterExit = true
    this.startupError = formatStartupError(message, logs)
    if (starting) this.startingServer?.fail(new Error(message))
    if (failedServer && !starting) {
      const now = this.deps.now()
      if (now - failedServer.startedAt >= AUTOMATIC_RESTART_STABLE_MS) {
        this.automaticRestartAttempts = 0
      }
      if (this.automaticRestartAttempts >= AUTOMATIC_RESTART_LIMIT) {
        this.openAutomaticRestartCircuit(message, logs, now)
        return
      }
      const attempt = ++this.automaticRestartAttempts
      const backoffMs = AUTOMATIC_RESTART_BACKOFF_MS[attempt - 1] ?? 0
      this.restartNotBefore = now + backoffMs
      const restartGeneration = this.lifecycleGeneration
      void this.startServer().catch((error) => {
        if (this.lifecycleGeneration === restartGeneration) {
          // Keep a later renderer recovery request eligible to retry if this
          // immediate restart lost a port-release race or failed transiently.
          this.restartAfterExit = true
        }
        const detail = sanitizeHostDiagnostic(error instanceof Error ? error.message : String(error))
        console.error(`[desktop] failed to restart server sidecar after exit: ${detail}`)
      })
    }
  }

  private openAutomaticRestartCircuit(message: string, logs: string[], now: number) {
    this.restartAfterExit = false
    this.restartNotBefore = 0
    this.restartBlockedUntil = now + AUTOMATIC_RESTART_COOLDOWN_MS
    const circuitMessage = `automatic restart paused after ${AUTOMATIC_RESTART_LIMIT} consecutive crashes; retry in ${AUTOMATIC_RESTART_COOLDOWN_MS / 1_000} seconds`
    this.startupError = formatStartupError(`${message}; ${circuitMessage}`, logs)
    this.deps.appendHostDiagnostic(
      this.diagnosticsFile,
      `[claude-server] [restart-circuit-open] ${circuitMessage}`,
    )
    console.error(`[desktop] ${circuitMessage}`)
  }

  private assertRestartCircuitAllowsStart() {
    if (this.restartBlockedUntil === 0) return
    if (this.deps.now() < this.restartBlockedUntil) {
      throw new Error(this.startupError ?? 'automatic restart paused')
    }
    this.restartBlockedUntil = 0
    this.automaticRestartAttempts = 0
    this.restartAfterExit = true
  }

  private stopAdapterChildren(children: SidecarChild[], sync = false) {
    for (const child of children.splice(0)) {
      const index = this.adapters.indexOf(child)
      if (index >= 0) this.adapters.splice(index, 1)
      killSidecar(child, sync)
    }
  }

  private async resolveSidecarBaseEnv(): Promise<NodeJS.ProcessEnv> {
    this.sidecarEnvPromise ??= this.resolveSidecarBaseEnvOnce()
    return await this.sidecarEnvPromise
  }

  private async resolveSidecarBaseEnvOnce(): Promise<NodeJS.ProcessEnv> {
    const baseEnv = clearProxyEnv(this.baseEnv)
    if (!this.resolveSystemProxy) return this.applyPowerShellOverride(baseEnv)

    const bridge = this.deps.createSystemProxyBridge(this.resolveSystemProxy)
    this.systemProxyBridge = bridge
    try {
      const bridgeUrl = await bridge.start()
      if (this.systemProxyBridge !== bridge) {
        throw new Error('system proxy bridge startup was stopped')
      }
      return this.applyPowerShellOverride(withSystemProxyBridgeEnv(baseEnv, bridgeUrl))
    } catch (error) {
      if (this.systemProxyBridge === bridge) {
        this.systemProxyBridge = null
        await bridge.stop().catch(() => {})
      }
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[desktop] failed to start system proxy bridge for sidecars: ${sanitizeHostDiagnostic(message)}`)
      return this.applyPowerShellOverride(withSystemProxyErrorEnv(baseEnv, error))
    }
  }

  private stopSystemProxyBridge(): void {
    const bridge = this.systemProxyBridge
    this.systemProxyBridge = null
    this.sidecarEnvPromise = null
    if (bridge) void bridge.stop()
  }

  // On Windows, forward the user's chosen PowerShell to the agent sidecar so its
  // PowerShellTool honors the same shell as the UI terminal (regression from the
  // Tauri build, where this lived in src-tauri/src/lib.rs). Best-effort: never
  // block sidecar startup, and never override an explicitly set env var.
  private applyPowerShellOverride(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (process.platform !== 'win32' || env[POWERSHELL_PATH_OVERRIDE_ENV]) return env
    try {
      const shell = resolveDesktopTerminalShell('win32', readDesktopTerminalConfig(env))
      const override = windowsPowerShellOverride(shell, 'win32')
      if (override) return { ...env, [POWERSHELL_PATH_OVERRIDE_ENV]: override }
    } catch {
      // Misconfigured custom shell etc. — fall through to the unmodified env.
    }
    return env
  }
}
