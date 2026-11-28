import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { getManagedChromeProfileDir } from './config'
import type {
  CdpTransport,
  ChromeConnectionState,
  DetectedBrowserId,
  DetectedBrowserInfo,
} from './types'
import { DirectCdpWebSocketTransport } from './wsTransport'

export interface BrowserDiscoveryFs {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: BufferEncoding): string
  unlinkSync(path: string): void
  mkdirSync(path: string, options?: { recursive?: boolean }): void
}

const DEFAULT_FS: BrowserDiscoveryFs = {
  existsSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
}

interface BrowserCandidateSpec {
  id: DetectedBrowserId
  name: string
  executablePaths: string[]
  userDataDir: string
}

function joinForPlatform(platform: NodeJS.Platform, ...segments: string[]): string {
  return platform === 'win32'
    ? win32.join(...segments)
    : posix.join(...segments)
}

function getCandidateSpecs(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): BrowserCandidateSpec[] {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir()
  const join = (...segments: string[]) => joinForPlatform(platform, ...segments)

  if (platform === 'darwin') {
    const appSupport = join(home, 'Library', 'Application Support')
    return [
      {
        id: 'chrome',
        name: 'Google Chrome',
        executablePaths: [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        ],
        userDataDir: join(appSupport, 'Google', 'Chrome'),
      },
      {
        id: 'chrome-canary',
        name: 'Google Chrome Canary',
        executablePaths: [
          '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        ],
        userDataDir: join(appSupport, 'Google', 'Chrome Canary'),
      },
      {
        id: 'edge',
        name: 'Microsoft Edge',
        executablePaths: [
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ],
        userDataDir: join(appSupport, 'Microsoft Edge'),
      },
      {
        id: 'brave',
        name: 'Brave Browser',
        executablePaths: [
          '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        ],
        userDataDir: join(appSupport, 'BraveSoftware', 'Brave-Browser'),
      },
      {
        id: 'chromium',
        name: 'Chromium',
        executablePaths: [
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ],
        userDataDir: join(appSupport, 'Chromium'),
      },
    ]
  }

  if (platform === 'win32') {
    const programFiles = env.PROGRAMFILES || 'C:\\Program Files'
    const programFilesX86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    const localAppData =
      env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    return [
      {
        id: 'chrome',
        name: 'Google Chrome',
        executablePaths: [
          join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ],
        userDataDir: join(localAppData, 'Google', 'Chrome', 'User Data'),
      },
      {
        id: 'chrome-canary',
        name: 'Google Chrome Canary',
        executablePaths: [
          join(localAppData, 'Google', 'Chrome SxS', 'Application', 'chrome.exe'),
        ],
        userDataDir: join(localAppData, 'Google', 'Chrome SxS', 'User Data'),
      },
      {
        id: 'edge',
        name: 'Microsoft Edge',
        executablePaths: [
          join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ],
        userDataDir: join(localAppData, 'Microsoft', 'Edge', 'User Data'),
      },
      {
        id: 'brave',
        name: 'Brave Browser',
        executablePaths: [
          join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
          join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        ],
        userDataDir: join(
          localAppData,
          'BraveSoftware',
          'Brave-Browser',
          'User Data',
        ),
      },
      {
        id: 'chromium',
        name: 'Chromium',
        executablePaths: [
          join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
        ],
        userDataDir: join(localAppData, 'Chromium', 'User Data'),
      },
    ]
  }

  // Linux / BSD
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
  return [
    {
      id: 'chrome',
      name: 'Google Chrome',
      executablePaths: [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/opt/google/chrome/chrome',
      ],
      userDataDir: join(configHome, 'google-chrome'),
    },
    {
      id: 'chrome-canary',
      name: 'Google Chrome Unstable',
      executablePaths: [
        '/usr/bin/google-chrome-unstable',
        '/opt/google/chrome-unstable/chrome',
      ],
      userDataDir: join(configHome, 'google-chrome-unstable'),
    },
    {
      id: 'edge',
      name: 'Microsoft Edge',
      executablePaths: [
        '/usr/bin/microsoft-edge',
        '/usr/bin/microsoft-edge-stable',
      ],
      userDataDir: join(configHome, 'microsoft-edge'),
    },
    {
      id: 'brave',
      name: 'Brave Browser',
      executablePaths: [
        '/usr/bin/brave-browser',
        '/usr/bin/brave-browser-stable',
      ],
      userDataDir: join(configHome, 'BraveSoftware', 'Brave-Browser'),
    },
    {
      id: 'chromium',
      name: 'Chromium',
      executablePaths: [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
      ],
      userDataDir: join(configHome, 'chromium'),
    },
  ]
}

export interface DetectBrowsersOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  fs?: BrowserDiscoveryFs
  customExecutablePath?: string
  customUserDataDir?: string
}

export function detectInstalledBrowsers(
  options: DetectBrowsersOptions = {},
): DetectedBrowserInfo[] {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const fsApi = options.fs ?? DEFAULT_FS

  const specs = getCandidateSpecs(platform, env)
  const detected: DetectedBrowserInfo[] = []

  if (options.customExecutablePath && fsApi.existsSync(options.customExecutablePath)) {
    const userDataDir =
      options.customUserDataDir || specs[0]?.userDataDir || ''
    const activePortPath = joinForPlatform(platform, userDataDir, 'DevToolsActivePort')
    detected.push({
      id: 'chrome',
      name: 'Custom Chromium Browser',
      executablePath: options.customExecutablePath,
      userDataDir,
      devToolsActivePortPath: activePortPath,
      hasDevToolsActivePort: Boolean(
        userDataDir && fsApi.existsSync(activePortPath),
      ),
      platform,
    })
  }

  for (const spec of specs) {
    const executablePath = spec.executablePaths.find(p => fsApi.existsSync(p))
    const activePortPath = joinForPlatform(platform, spec.userDataDir, 'DevToolsActivePort')
    const hasDevToolsActivePort = fsApi.existsSync(activePortPath)
    if (executablePath || hasDevToolsActivePort) {
      if (
        executablePath &&
        detected.some(item => item.executablePath === executablePath)
      ) {
        continue
      }
      detected.push({
        id: spec.id,
        name: spec.name,
        executablePath: executablePath ?? spec.executablePaths[0]!,
        userDataDir: spec.userDataDir,
        devToolsActivePortPath: activePortPath,
        hasDevToolsActivePort,
        platform,
      })
    }
  }

  return detected
}

export interface ParsedDevToolsActivePort {
  port: number
  wsPath: string
  wsEndpoint: string
}

export function parseDevToolsActivePortContent(
  content: string,
): ParsedDevToolsActivePort | null {
  const lines = content
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
  if (lines.length < 2) {
    return null
  }
  const port = Number(lines[0])
  const wsPath = lines[1]!
  if (
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65535 ||
    !wsPath.startsWith('/')
  ) {
    return null
  }
  return {
    port,
    wsPath,
    wsEndpoint: `ws://127.0.0.1:${port}${wsPath}`,
  }
}

export function readDevToolsActivePortFile(
  filePath: string,
  fsApi: BrowserDiscoveryFs = DEFAULT_FS,
): ParsedDevToolsActivePort | null {
  if (!fsApi.existsSync(filePath)) {
    return null
  }
  try {
    const raw = fsApi.readFileSync(filePath, 'utf8')
    return parseDevToolsActivePortContent(raw)
  } catch {
    return null
  }
}

export interface ManagedChromeSpawnResult {
  process: ChildProcess
  wsEndpoint: string
  port: number
  pid: number
  userDataDir: string
}

export type ChromeTransportFactory = (wsEndpoint: string) => Promise<CdpTransport>

export interface ChromeConnectionManagerOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  fs?: BrowserDiscoveryFs
  approvalTimeoutMs?: number
  spawnFn?: typeof spawn
  transportFactory?: ChromeTransportFactory
  customExecutablePath?: string
  customUserDataDir?: string
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000
const MANAGED_LAUNCH_TIMEOUT_MS = 15_000

function isLikelyConnectionRefusedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /ECONNREFUSED|connection refused|failed to connect|closed before open|ENOTFOUND|ECONNRESET/i.test(
    msg,
  )
}

function isLikelyTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /timed out|timeout/i.test(msg)
}

export class ChromeConnectionManager {
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private readonly fsApi: BrowserDiscoveryFs
  private readonly approvalTimeoutMs: number
  private readonly spawnFn: typeof spawn
  private readonly transportFactory: ChromeTransportFactory
  private customExecutablePath?: string
  private customUserDataDir?: string

  private transport: CdpTransport | null = null
  private unsubscribeTransportDisconnect: (() => void) | null = null
  private managedProcess: ChildProcess | null = null
  private managedProcessExitListener: (() => void) | null = null
  private readonly pinnedTabIds = new Set<string>()
  private state: ChromeConnectionState

  constructor(options: ChromeConnectionManagerOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.env = options.env ?? process.env
    this.fsApi = options.fs ?? DEFAULT_FS
    this.approvalTimeoutMs =
      options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
    this.spawnFn = options.spawnFn ?? spawn
    this.customExecutablePath = options.customExecutablePath
    this.customUserDataDir = options.customUserDataDir
    this.transportFactory =
      options.transportFactory ??
      (async (wsEndpoint: string) => {
        const transport = new DirectCdpWebSocketTransport({
          wsUrl: wsEndpoint,
          kind: 'chrome',
          connectTimeoutMs: 10_000,
          defaultCommandTimeoutMs: this.approvalTimeoutMs,
        })
        await transport.connect()
        return transport
      })

    this.state = {
      mode: 'disconnected',
      detectedBrowsers: this.detectBrowsers(),
    }
  }

  detectBrowsers(): DetectedBrowserInfo[] {
    return detectInstalledBrowsers({
      platform: this.platform,
      env: this.env,
      fs: this.fsApi,
      customExecutablePath: this.customExecutablePath,
      customUserDataDir: this.customUserDataDir,
    })
  }

  updateOptions(options: {
    customExecutablePath?: string
    customUserDataDir?: string
  }): void {
    if ('customExecutablePath' in options) {
      this.customExecutablePath = options.customExecutablePath?.trim() || undefined
    }
    if ('customUserDataDir' in options) {
      this.customUserDataDir = options.customUserDataDir?.trim() || undefined
    }
    this.state = {
      ...this.state,
      detectedBrowsers: this.detectBrowsers(),
    }
  }

  private attachTransportLifecycle(transport: CdpTransport): void {
    this.unsubscribeTransportDisconnect?.()
    this.unsubscribeTransportDisconnect = null
    this.transport = transport
    if (transport.onDisconnect) {
      this.unsubscribeTransportDisconnect = transport.onDisconnect(() => {
        if (this.transport !== transport) {
          return
        }
        this.handleUnexpectedDisconnect()
      })
    }
  }

  private attachManagedProcessExitLifecycle(child: ChildProcess): void {
    const onExit = () => {
      if (this.managedProcess !== child) {
        return
      }
      this.managedProcess = null
      this.managedProcessExitListener = null
      this.handleUnexpectedDisconnect()
    }
    this.managedProcessExitListener = () => {
      child.off('exit', onExit)
    }
    child.once('exit', onExit)
  }

  private handleUnexpectedDisconnect(): void {
    this.unsubscribeTransportDisconnect?.()
    this.unsubscribeTransportDisconnect = null
    const staleTransport = this.transport
    this.transport = null
    if (staleTransport) {
      void staleTransport.close().catch(() => {})
    }
    this.pinnedTabIds.clear()
    this.state = {
      mode: 'disconnected',
      detectedBrowsers: this.detectBrowsers(),
    }
  }

  getState(): ChromeConnectionState {
    return {
      ...this.state,
      pinnedTabIds: [...this.pinnedTabIds],
      detectedBrowsers: this.detectBrowsers(),
    }
  }

  getTransport(): CdpTransport | null {
    return this.transport
  }

  pinTab(targetId: string): void {
    this.pinnedTabIds.add(targetId)
  }

  unpinTab(targetId: string): void {
    this.pinnedTabIds.delete(targetId)
  }

  isTabPinned(targetId: string): boolean {
    return this.pinnedTabIds.has(targetId)
  }

  getPinnedTabIds(): string[] {
    return [...this.pinnedTabIds]
  }

  /**
   * Tier 1: Live Attach via `DevToolsActivePort` -> `ws://127.0.0.1:<port><wsPath>`
   * + `Browser.getVersion` with 30s approval timeout (Chrome 136+ / 144+ modal).
   *
   * - On timeout: returns `awaiting_approval` immediately WITHOUT retrying so we
   *   never pop duplicate Chrome approval modals.
   * - On dead/refused socket: cleans the stale `DevToolsActivePort` file and
   *   returns Tier 3 `remote_debugging_not_enabled`.
   */
  async connectLiveAttach(
    options: { browserId?: DetectedBrowserId; timeoutMs?: number } = {},
  ): Promise<ChromeConnectionState> {
    const detected = this.detectBrowsers()
    const targetBrowser = options.browserId
      ? detected.find(b => b.id === options.browserId)
      : detected.find(b => b.hasDevToolsActivePort) ?? detected[0]

    if (!targetBrowser || !targetBrowser.hasDevToolsActivePort) {
      this.state = {
        mode: 'remote_debugging_not_enabled',
        browserId: targetBrowser?.id,
        browserName: targetBrowser?.name,
        detectedBrowsers: detected,
        guidance:
          'Open chrome://inspect/#remote-debugging in Chrome and enable remote debugging, then click Connect.',
      }
      return this.getState()
    }

    const parsed = readDevToolsActivePortFile(
      targetBrowser.devToolsActivePortPath,
      this.fsApi,
    )
    if (!parsed) {
      this.tryRemoveStaleActivePort(targetBrowser.devToolsActivePortPath)
      this.state = {
        mode: 'remote_debugging_not_enabled',
        browserId: targetBrowser.id,
        browserName: targetBrowser.name,
        detectedBrowsers: this.detectBrowsers(),
        error: 'DevToolsActivePort file was malformed and has been cleaned up.',
        guidance:
          'Open chrome://inspect/#remote-debugging in Chrome and enable remote debugging.',
      }
      return this.getState()
    }

    // Disconnect any previous transport cleanly without killing user Chrome
    await this.disconnect()

    let transport: CdpTransport
    try {
      transport = await this.transportFactory(parsed.wsEndpoint)
    } catch (err) {
      if (isLikelyConnectionRefusedError(err)) {
        this.tryRemoveStaleActivePort(targetBrowser.devToolsActivePortPath)
        this.state = {
          mode: 'remote_debugging_not_enabled',
          browserId: targetBrowser.id,
          browserName: targetBrowser.name,
          detectedBrowsers: this.detectBrowsers(),
          error:
            'Cleaned stale DevToolsActivePort (browser remote debugging socket was not listening).',
          guidance:
            'Open chrome://inspect/#remote-debugging in Chrome and enable remote debugging, or launch Managed Isolated Chrome.',
        }
        return this.getState()
      }

      if (isLikelyTimeoutError(err)) {
        this.state = {
          mode: 'awaiting_approval',
          browserId: targetBrowser.id,
          browserName: targetBrowser.name,
          wsEndpoint: parsed.wsEndpoint,
          port: parsed.port,
          detectedBrowsers: detected,
          guidance:
            'Waiting for you to click "Allow" in Chrome\'s remote debugging approval dialog.',
        }
        return this.getState()
      }

      this.state = {
        mode: 'error',
        browserId: targetBrowser.id,
        browserName: targetBrowser.name,
        detectedBrowsers: detected,
        error: err instanceof Error ? err.message : String(err),
      }
      return this.getState()
    }

    // Verify with Browser.getVersion (30s timeout for Chrome 136+/144+ modal)
    const timeoutMs = options.timeoutMs ?? this.approvalTimeoutMs
    try {
      const version = await transport.send<{
        product?: string
        protocolVersion?: string
      }>('Browser.getVersion', undefined, { timeoutMs })

      this.attachTransportLifecycle(transport)
      this.state = {
        mode: 'live_attach',
        browserId: targetBrowser.id,
        browserName: targetBrowser.name,
        browserVersion: version.product || version.protocolVersion || 'Chrome',
        wsEndpoint: parsed.wsEndpoint,
        userDataDir: targetBrowser.userDataDir,
        port: parsed.port,
        detectedBrowsers: detected,
      }
      return this.getState()
    } catch (err) {
      await transport.close().catch(() => {})
      if (isLikelyTimeoutError(err)) {
        // NEVER retry immediately: Chrome 144+ would show duplicate prompts!
        this.state = {
          mode: 'awaiting_approval',
          browserId: targetBrowser.id,
          browserName: targetBrowser.name,
          wsEndpoint: parsed.wsEndpoint,
          port: parsed.port,
          detectedBrowsers: detected,
          guidance:
            'Chrome is awaiting your approval in its remote debugging dialog. Approve in Chrome, then click Connect again.',
        }
        return this.getState()
      }

      if (isLikelyConnectionRefusedError(err)) {
        this.tryRemoveStaleActivePort(targetBrowser.devToolsActivePortPath)
        this.state = {
          mode: 'remote_debugging_not_enabled',
          browserId: targetBrowser.id,
          browserName: targetBrowser.name,
          detectedBrowsers: this.detectBrowsers(),
          error:
            'Chrome remote debugging port was closed; stale DevToolsActivePort cleaned.',
          guidance:
            'Open chrome://inspect/#remote-debugging in Chrome and enable remote debugging.',
        }
        return this.getState()
      }

      this.state = {
        mode: 'error',
        browserId: targetBrowser.id,
        browserName: targetBrowser.name,
        detectedBrowsers: detected,
        error: err instanceof Error ? err.message : String(err),
      }
      return this.getState()
    }
  }

  /**
   * Tier 2: Launch Managed Isolated Chrome using an isolated `--user-data-dir`
   * under `<CLAUDE_CONFIG_DIR>/browser-profiles/managed-chrome` and ephemeral
   * `--remote-debugging-port=0` (never hardcodes 9222, never kills user Chrome).
   */
  async launchManagedChrome(
    options: {
      browserId?: DetectedBrowserId
      headless?: boolean
      launchTimeoutMs?: number
    } = {},
  ): Promise<ChromeConnectionState> {
    const detected = this.detectBrowsers()
    const targetBrowser = options.browserId
      ? detected.find(b => b.id === options.browserId)
      : detected[0]

    if (!targetBrowser) {
      this.state = {
        mode: 'remote_debugging_not_enabled',
        detectedBrowsers: detected,
        error: 'No Chromium-based browser (Chrome, Edge, Brave, Chromium) was detected on this machine.',
        guidance: 'Install Google Chrome or configure chromeBinaryPath in settings.',
      }
      return this.getState()
    }

    await this.disconnect()

    const profileDir = getManagedChromeProfileDir(this.env)
    this.fsApi.mkdirSync(profileDir, { recursive: true })

    // Remove any stale DevToolsActivePort from a previous managed run
    const managedActivePort = joinForPlatform(this.platform, profileDir, 'DevToolsActivePort')
    this.tryRemoveStaleActivePort(managedActivePort)

    const args = [
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      ...(options.headless ? ['--headless=new'] : []),
      'about:blank',
    ]

    const child = this.spawnFn(targetBrowser.executablePath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: this.platform !== 'win32',
    })
    this.managedProcess = child

    const timeoutMs = options.launchTimeoutMs ?? MANAGED_LAUNCH_TIMEOUT_MS
    let wsEndpoint: string
    let port: number

    try {
      const discovered = await this.waitForManagedEndpoint(
        child,
        managedActivePort,
        timeoutMs,
      )
      wsEndpoint = discovered.wsEndpoint
      port = discovered.port
    } catch (err) {
      await this.terminateManagedProcess()
      this.state = {
        mode: 'error',
        browserId: targetBrowser.id,
        browserName: targetBrowser.name,
        userDataDir: profileDir,
        detectedBrowsers: detected,
        error: err instanceof Error ? err.message : String(err),
      }
      return this.getState()
    }

    try {
      const transport = await this.transportFactory(wsEndpoint)
      const version = await transport.send<{ product?: string }>(
        'Browser.getVersion',
        undefined,
        { timeoutMs: 10_000 },
      )
      this.attachTransportLifecycle(transport)
      this.attachManagedProcessExitLifecycle(child)
      this.state = {
        mode: 'managed',
        browserId: targetBrowser.id,
        browserName: targetBrowser.name,
        browserVersion: version.product || 'Chrome',
        wsEndpoint,
        userDataDir: profileDir,
        port,
        pid: child.pid,
        detectedBrowsers: detected,
      }
      return this.getState()
    } catch (err) {
      await this.terminateManagedProcess()
      this.state = {
        mode: 'error',
        browserId: targetBrowser.id,
        browserName: targetBrowser.name,
        userDataDir: profileDir,
        detectedBrowsers: detected,
        error: err instanceof Error ? err.message : String(err),
      }
      return this.getState()
    }
  }

  /**
   * Disconnects from Chrome cleanly:
   * - In `live_attach` mode: detaches CDP/WS ONLY — NEVER closes user Chrome!
   * - In `managed` mode: closes transport and cleanly tears down the managed
   *   isolated Chrome process group.
   */
  async disconnect(): Promise<ChromeConnectionState> {
    const wasManaged = this.state.mode === 'managed'
    this.unsubscribeTransportDisconnect?.()
    this.unsubscribeTransportDisconnect = null
    this.managedProcessExitListener?.()
    this.managedProcessExitListener = null
    if (this.transport) {
      const t = this.transport
      this.transport = null
      await t.close().catch(() => {})
    }
    if (wasManaged || this.managedProcess) {
      await this.terminateManagedProcess()
    }
    this.pinnedTabIds.clear()
    this.state = {
      mode: 'disconnected',
      detectedBrowsers: this.detectBrowsers(),
    }
    return this.getState()
  }

  private tryRemoveStaleActivePort(filePath: string): void {
    try {
      if (this.fsApi.existsSync(filePath)) {
        this.fsApi.unlinkSync(filePath)
      }
    } catch {
      // Best-effort cleanup
    }
  }

  private async waitForManagedEndpoint(
    child: ChildProcess,
    activePortPath: string,
    timeoutMs: number,
  ): Promise<{ wsEndpoint: string; port: number }> {
    return new Promise((resolve, reject) => {
      let settled = false
      let stderrBuf = ''

      const onStderrData = (chunk: Buffer | string) => {
        stderrBuf += chunk.toString()
        const match =
          /DevTools listening on (ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/devtools\/browser\/[^\s]+)/i.exec(
            stderrBuf,
          )
        if (match?.[1] && match[2]) {
          finish({ wsEndpoint: match[1], port: Number(match[2]) })
        }
      }

      const onChildError = (err: Error) => {
        finish(
          null,
          new Error(`Failed to spawn Managed Chrome: ${err.message}`),
        )
      }

      const onChildExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(
          null,
          new Error(
            `Managed Chrome exited before DevTools endpoint became ready (code=${code}, signal=${signal})`,
          ),
        )
      }

      const finish = (
        result: { wsEndpoint: string; port: number } | null,
        err?: Error,
      ) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(poll)
        child.stderr?.off('data', onStderrData)
        child.off('error', onChildError)
        child.off('exit', onChildExit)
        if (err) {
          reject(err)
        } else if (result) {
          resolve(result)
        }
      }

      const timer = setTimeout(() => {
        finish(
          null,
          new Error(
            `Timed out waiting for Managed Chrome DevTools endpoint after ${timeoutMs}ms`,
          ),
        )
      }, timeoutMs)

      const poll = setInterval(() => {
        const parsed = readDevToolsActivePortFile(activePortPath, this.fsApi)
        if (parsed) {
          finish({ wsEndpoint: parsed.wsEndpoint, port: parsed.port })
        }
      }, 150)

      child.stderr?.on('data', onStderrData)
      child.once('error', onChildError)
      child.once('exit', onChildExit)
    })
  }

  private async terminateManagedProcess(): Promise<void> {
    const proc = this.managedProcess
    this.managedProcess = null
    if (!proc || proc.killed || proc.exitCode !== null) {
      return
    }
    const pid = proc.pid
    try {
      if (this.platform !== 'win32' && typeof pid === 'number' && pid > 0) {
        process.kill(-pid, 'SIGTERM')
      } else {
        proc.kill('SIGTERM')
      }
    } catch {
      try {
        proc.kill('SIGTERM')
      } catch {
        // Already exited
      }
    }

    await new Promise<void>(resolve => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(killTimer)
        resolve()
      }
      proc.once('exit', finish)
      const killTimer = setTimeout(() => {
        try {
          if (this.platform !== 'win32' && typeof pid === 'number' && pid > 0) {
            process.kill(-pid, 'SIGKILL')
          } else {
            proc.kill('SIGKILL')
          }
        } catch {
          // Ignore
        }
        finish()
      }, 1_500)
    })
  }
}
