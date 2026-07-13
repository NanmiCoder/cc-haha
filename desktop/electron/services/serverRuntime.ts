import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  appendHostDiagnostic,
  createAdapterPlan,
  createServerPlan,
  ELECTRON_DIAGNOSTICS_FILE_ENV,
  formatStartupError,
  killSidecar,
  mergeProxyEnv,
  POWERSHELL_PATH_OVERRIDE_ENV,
  preferredServerPorts,
  proxyUrlFromElectronProxyRules,
  pushStartupLog,
  reserveServerPort,
  sanitizeHostDiagnostic,
  SERVER_BIND_HOST,
  SERVER_CONTROL_HOST,
  SERVER_STARTUP_TIMEOUT_MS,
  spawnSidecar,
  waitForServer,
  windowsPowerShellOverride,
  writeLastServerPort,
  type SidecarChild,
} from './sidecarManager'
import { readDesktopTerminalConfig, resolveDesktopTerminalShell } from './terminal'

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
  preferredServerPorts: typeof preferredServerPorts
  reserveServerPort: typeof reserveServerPort
  spawnSidecar: typeof spawnSidecar
  waitForServer: typeof waitForServer
  writeLastServerPort: typeof writeLastServerPort
}

const DEFAULT_SERVER_RUNTIME_DEPS: ServerRuntimeDeps = {
  appendHostDiagnostic,
  preferredServerPorts,
  reserveServerPort,
  spawnSidecar,
  waitForServer,
  writeLastServerPort,
}

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
  private sidecarEnvPromise: Promise<NodeJS.ProcessEnv> | null = null
  private server: ActiveServer | null = null
  private adapters: SidecarChild[] = []
  private startupError: string | null = null
  private restartAfterExit = false
  private startPromise: Promise<string> | null = null
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

    this.restartAfterExit = false
    this.startPromise = this.startServerOnce()
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async getServerUrl(): Promise<string> {
    if (this.server) return this.server.url
    if (this.startPromise) return await this.startServer()
    if (this.startupError && !this.restartAfterExit) throw new Error(this.startupError)
    return await this.startServer()
  }

  getLocalAccessToken(): string {
    return this.localAccessToken
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
  }

  private async startServerOnce(): Promise<string> {
    // Prefer the configured fixed port, then the previous run's port, so
    // phone bookmarks / QR codes / reverse proxies survive restarts (#767).
    const port = await this.deps.reserveServerPort(
      SERVER_BIND_HOST,
      this.deps.preferredServerPorts(this.baseEnv),
    )
    const url = `http://${SERVER_CONTROL_HOST}:${port}`
    const logs: string[] = []
    let startState: ServerStartState | null = null
    const env = this.withLocalAccessToken(await this.resolveSidecarBaseEnv())
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
      this.server = { url, child, adapterChildren: startState.adapterChildren }
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

  private async startAdaptersSidecars(
    serverUrl: string,
    startState?: ServerStartState,
    activeServer?: ActiveServer,
  ): Promise<void> {
    const env = this.withLocalAccessToken(await this.resolveSidecarBaseEnv())
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
    if (active) {
      const adapterChildren = this.server!.adapterChildren
      this.server = null
      this.stopAdapterChildren(adapterChildren)
    }
    this.restartAfterExit = true
    this.startupError = formatStartupError(message, logs)
    if (starting) this.startingServer?.fail(new Error(message))
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
    if (!this.resolveSystemProxy) return this.applyPowerShellOverride(this.baseEnv)

    try {
      const rules = await this.resolveSystemProxy('https://auth.openai.com/')
      return this.applyPowerShellOverride(mergeProxyEnv(
        this.baseEnv,
        proxyUrlFromElectronProxyRules(rules),
      ))
    } catch (error) {
      console.error('[desktop] failed to resolve system proxy for sidecars', error)
      return this.applyPowerShellOverride(this.baseEnv)
    }
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
