import path from 'node:path'
import {
  createAdapterPlan,
  createServerPlan,
  createTunnelPlan,
  formatStartupError,
  killSidecar,
  mergeProxyEnv,
  POWERSHELL_PATH_OVERRIDE_ENV,
  preferredServerPorts,
  proxyUrlFromElectronProxyRules,
  pushStartupLog,
  reserveServerPort,
  resolveCloudflaredPath,
  SERVER_BIND_HOST,
  SERVER_CONTROL_HOST,
  spawnSidecar,
  spawnTunnel,
  waitForServer,
  waitForTunnelUrl,
  windowsPowerShellOverride,
  writeLastServerPort,
  type H5TunnelMode,
  type SidecarChild,
} from './sidecarManager'
import { readDesktopTerminalConfig, resolveDesktopTerminalShell } from './terminal'

export type TunnelStartOptions = {
  mode: H5TunnelMode
  token?: string | null
  /** Public base URL to report for a named tunnel (the user's bound domain). */
  namedUrl?: string | null
}

export type TunnelStatus = {
  status: 'idle' | 'starting' | 'running' | 'error'
  url: string | null
  mode: H5TunnelMode | null
  error: string | null
}

type ServerRuntimeOptions = {
  desktopRoot: string
  appRoot?: string
  h5DistDir?: string
  resolveSystemProxy?: (url: string) => Promise<string>
}

export class ElectronServerRuntime {
  private readonly desktopRoot: string
  private readonly appRoot: string
  private readonly h5DistDir: string
  private readonly resolveSystemProxy?: (url: string) => Promise<string>
  private sidecarEnvPromise: Promise<NodeJS.ProcessEnv> | null = null
  private server: { url: string, child: SidecarChild } | null = null
  private adapters: SidecarChild[] = []
  private tunnel: { child: SidecarChild, mode: H5TunnelMode } | null = null
  private tunnelState: TunnelStatus = { status: 'idle', url: null, mode: null, error: null }
  private startupError: string | null = null
  private startPromise: Promise<string> | null = null

  constructor(options: ServerRuntimeOptions) {
    this.desktopRoot = options.desktopRoot
    this.appRoot = options.appRoot ?? options.desktopRoot
    this.h5DistDir = options.h5DistDir ?? path.join(options.desktopRoot, 'dist')
    this.resolveSystemProxy = options.resolveSystemProxy
  }

  async startServer(): Promise<string> {
    if (this.server) return this.server.url
    if (this.startPromise) return this.startPromise

    this.startPromise = this.startServerOnce()
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async getServerUrl(): Promise<string> {
    if (this.server) return this.server.url
    if (this.startupError) throw new Error(this.startupError)
    return await this.startServer()
  }

  async restartAdaptersSidecars(): Promise<void> {
    this.stopAdaptersSidecars()
    const serverUrl = await this.getServerUrl()
    await this.startAdaptersSidecars(serverUrl)
  }

  stopAll(sync = false) {
    this.stopTunnelProcess(sync)
    this.stopAdaptersSidecars(sync)
    if (this.server) {
      killSidecar(this.server.child, sync)
      this.server = null
    }
  }

  getTunnelStatus(): TunnelStatus {
    return { ...this.tunnelState }
  }

  /**
   * Start a Cloudflare tunnel and report the resulting public URL to the running
   * H5 server so it becomes the effective publicBaseUrl. Quick mode scrapes the
   * trycloudflare URL from cloudflared's output; named mode uses the user's
   * configured domain (namedUrl) since cloudflared does not print it.
   */
  async startTunnel(options: TunnelStartOptions): Promise<TunnelStatus> {
    const serverUrl = await this.getServerUrl()
    const port = Number(new URL(serverUrl).port) || 0

    // Replace any existing tunnel so a mode switch / restart is clean.
    this.stopTunnelProcess()
    this.tunnelState = { status: 'starting', url: null, mode: options.mode, error: null }

    const cloudflaredPath = resolveCloudflaredPath()
    if (!cloudflaredPath) {
      this.tunnelState = {
        status: 'error',
        url: null,
        mode: options.mode,
        error: 'cloudflared not found. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
      }
      await this.reportTunnel(serverUrl)
      return this.getTunnelStatus()
    }

    try {
      const plan = createTunnelPlan({
        cloudflaredPath,
        port,
        mode: options.mode,
        token: options.token,
        env: await this.resolveSidecarBaseEnv(),
      })
      const child = spawnTunnel(plan)
      this.tunnel = { child, mode: options.mode }
      this.captureLogs(child, `cloudflared:${options.mode}`)
      child.on('exit', () => {
        // Clear state when cloudflared dies so the UI never shows a stale URL.
        if (this.tunnel?.child === child) {
          this.tunnel = null
          this.tunnelState = { status: 'idle', url: null, mode: null, error: null }
          void this.reportTunnel(serverUrl)
        }
      })

      let url: string
      if (options.mode === 'named') {
        if (!options.namedUrl) {
          throw new Error('A bound domain (public URL) is required for the named tunnel mode.')
        }
        url = options.namedUrl
      } else {
        url = await waitForTunnelUrl(child)
      }

      this.tunnelState = { status: 'running', url, mode: options.mode, error: null }
      await this.reportTunnel(serverUrl)
      return this.getTunnelStatus()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.stopTunnelProcess()
      this.tunnelState = { status: 'error', url: null, mode: options.mode, error: message }
      await this.reportTunnel(serverUrl)
      return this.getTunnelStatus()
    }
  }

  async stopTunnel(): Promise<TunnelStatus> {
    this.stopTunnelProcess()
    this.tunnelState = { status: 'idle', url: null, mode: null, error: null }
    if (this.server) {
      // Use /tunnel/clear, NOT /tunnel/report — the report handler treats a
      // missing/null url as "don't touch" (so a status-only heartbeat can't
      // accidentally wipe a live URL). To truly clear the server-side runtime
      // override after the user stops the tunnel, we have to call the explicit
      // clear endpoint. Reporting idle without clearing leaves the old URL as
      // the effective publicBaseUrl, so phones bookmark a dead address (CF 1033).
      await this.clearTunnelOnServer(this.server.url)
    }
    return this.getTunnelStatus()
  }

  private stopTunnelProcess(sync = false) {
    if (this.tunnel) {
      killSidecar(this.tunnel.child, sync)
      this.tunnel = null
    }
  }

  /** Wipe the server-side runtime tunnel override after the tunnel is stopped. */
  private async clearTunnelOnServer(serverUrl: string): Promise<void> {
    try {
      await fetch(`${serverUrl}/api/h5-access/tunnel/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    } catch (error) {
      console.error('[desktop] failed to clear tunnel state on server', error)
    }
  }

  /** Push the current tunnel state into the server's runtime override. */
  private async reportTunnel(serverUrl: string): Promise<void> {
    try {
      await fetch(`${serverUrl}/api/h5-access/tunnel/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: this.tunnelState.url,
          status: this.tunnelState.status,
          mode: this.tunnelState.mode ?? undefined,
          error: this.tunnelState.error,
        }),
      })
    } catch (error) {
      console.error('[desktop] failed to report tunnel state to server', error)
    }
  }

  private async startServerOnce(): Promise<string> {
    // Prefer the configured fixed port, then the previous run's port, so
    // phone bookmarks / QR codes / reverse proxies survive restarts (#767).
    const port = await reserveServerPort(SERVER_BIND_HOST, preferredServerPorts())
    const url = `http://${SERVER_CONTROL_HOST}:${port}`
    const logs: string[] = []
    const env = await this.resolveSidecarBaseEnv()
    const plan = createServerPlan({
      desktopRoot: this.desktopRoot,
      appRoot: this.appRoot,
      port,
      h5DistDir: this.h5DistDir,
      env,
    })

    try {
      const child = spawnSidecar(plan)
      this.captureLogs(child, 'claude-server', logs)
      await waitForServer(SERVER_CONTROL_HOST, port)
      writeLastServerPort(port)
      this.server = { url, child }
      this.startupError = null
      await this.startAdaptersSidecars(url)
      return url
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.startupError = formatStartupError(message, logs)
      throw new Error(this.startupError)
    }
  }

  private async startAdaptersSidecars(serverUrl: string): Promise<void> {
    const env = await this.resolveSidecarBaseEnv()
    for (const [label, flag] of [
      ['feishu', '--feishu'],
      ['telegram', '--telegram'],
      ['wechat', '--wechat'],
      ['dingtalk', '--dingtalk'],
      ['whatsapp', '--whatsapp'],
    ] as const) {
      try {
        const child = spawnSidecar(createAdapterPlan({
          desktopRoot: this.desktopRoot,
          appRoot: this.appRoot,
          h5DistDir: this.h5DistDir,
          serverUrl,
          flag,
          env,
        }))
        this.captureLogs(child, `claude-adapters:${label}`)
        this.adapters.push(child)
      } catch (error) {
        console.error(`[desktop] failed to start ${label} adapter sidecar`, error)
      }
    }
  }

  private stopAdaptersSidecars(sync = false) {
    for (const child of this.adapters.splice(0)) {
      killSidecar(child, sync)
    }
  }

  private captureLogs(child: SidecarChild, label: string, startupLogs?: string[]) {
    child.stdout.on('data', chunk => {
      const line = String(chunk).trimEnd()
      if (!line) return
      console.log(`[${label}] ${line}`)
      if (startupLogs) pushStartupLog(startupLogs, `[stdout] ${line}`)
    })
    child.stderr.on('data', chunk => {
      const line = String(chunk).trimEnd()
      if (!line) return
      console.error(`[${label}] ${line}`)
      if (startupLogs) pushStartupLog(startupLogs, `[stderr] ${line}`)
    })
    child.on('exit', (code, signal) => {
      const line = `sidecar exited (code=${code}, signal=${signal})`
      console.log(`[${label}] ${line}`)
      if (startupLogs) pushStartupLog(startupLogs, `[exit] ${line}`)
    })
  }

  private async resolveSidecarBaseEnv(): Promise<NodeJS.ProcessEnv> {
    this.sidecarEnvPromise ??= this.resolveSidecarBaseEnvOnce()
    return await this.sidecarEnvPromise
  }

  private async resolveSidecarBaseEnvOnce(): Promise<NodeJS.ProcessEnv> {
    if (!this.resolveSystemProxy) return this.applyPowerShellOverride(process.env)

    try {
      const rules = await this.resolveSystemProxy('https://auth.openai.com/')
      return this.applyPowerShellOverride(mergeProxyEnv(
        process.env,
        proxyUrlFromElectronProxyRules(rules),
      ))
    } catch (error) {
      console.error('[desktop] failed to resolve system proxy for sidecars', error)
      return this.applyPowerShellOverride(process.env)
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
