import path from 'node:path'
import {
  createAdapterPlan,
  createServerPlan,
  formatStartupError,
  killSidecar,
  mergeProxyEnv,
  proxyUrlFromElectronProxyRules,
  pushStartupLog,
  reserveLocalPort,
  SERVER_BIND_HOST,
  SERVER_CONTROL_HOST,
  spawnSidecar,
  waitForServer,
  type SidecarChild,
} from './sidecarManager'

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

  stopAll() {
    this.stopAdaptersSidecars()
    if (this.server) {
      killSidecar(this.server.child)
      this.server = null
    }
  }

  private async startServerOnce(): Promise<string> {
    const port = await reserveLocalPort(SERVER_BIND_HOST)
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

  private stopAdaptersSidecars() {
    for (const child of this.adapters.splice(0)) {
      killSidecar(child)
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
    if (!this.resolveSystemProxy) return process.env

    try {
      const rules = await this.resolveSystemProxy('https://auth.openai.com/')
      return mergeProxyEnv(
        process.env,
        proxyUrlFromElectronProxyRules(rules),
      )
    } catch (error) {
      console.error('[desktop] failed to resolve system proxy for sidecars', error)
      return process.env
    }
  }
}
