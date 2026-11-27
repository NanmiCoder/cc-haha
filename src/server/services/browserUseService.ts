import { randomUUID } from 'node:crypto'
import {
  BrowserUseEngine,
  ChromeConnectionManager,
  isLoopbackHost,
  loadBrowserUseConfig,
  saveBrowserUseConfig,
  type BrowserActResult,
  type BrowserControlState,
  type BrowserControlStatePayload,
  type BrowserCursorPayload,
  type BrowserInspectResult,
  type BrowserNavigateResult,
  type BrowserPreferredTarget,
  type BrowserSnapshotResult,
  type BrowserTabInfo,
  type BrowserTakeoverState,
  type BrowserTargetKind,
  type BrowserUiHooks,
  type BrowserUseActivityEvent,
  type BrowserUseConfig,
  type BrowserUseStatus,
  type BrowserZoomFactors,
  type CdpEventListener,
  type CdpSendOptions,
  type CdpTransport,
  type ChromeConnectionState,
  type DetectedBrowserId,
  type FlatActionStep,
} from '../../services/browserUse/index.js'
import { ApiError } from '../middleware/errorHandler.js'
import type { ServerMessage } from '../ws/events.js'
import {
  getSessionTurnState,
  sendToSession,
  stopSessionTurn,
  submitSessionTurn,
} from '../ws/handler.js'
import type {
  BrowserActInput,
  BrowserInspectInput,
  BrowserNavigateInput,
  BrowserSnapshotInput,
  BrowserTabsInput,
  BrowserTakeoverInput,
} from '../../tools/BrowserUseTool/schemas.js'

const BRIDGE_RPC_TIMEOUT_MS = 30_000

export interface ElectronBridgeConfig {
  baseUrl: string
  wsUrl: string
  token: string
  port: number
}

interface BridgeJsonRpcResponse {
  id: string | number
  result?: unknown
  error?: { code: string; message: string }
}

interface BridgePushEvent {
  event: string
  params: Record<string, unknown>
}

interface BridgeTabDescriptor {
  tabId: string
  sessionId?: string
  url: string
  title: string
  visible?: boolean
  zoomFactor?: number
  appZoomFactor?: number
}

type BridgePushListener = (event: string, params: Record<string, unknown>) => void

export function resolveElectronBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ElectronBridgeConfig | null {
  const rawUrl = env.CC_HAHA_BROWSER_BRIDGE_URL?.trim()
  const token = env.CC_HAHA_BROWSER_BRIDGE_TOKEN?.trim()
  if (!rawUrl || !token) return null

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (
    parsed.protocol !== 'http:' ||
    !isLoopbackHost(parsed.hostname) ||
    parsed.username ||
    parsed.password
  ) {
    return null
  }
  const port = Number(parsed.port || '80')
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null
  }
  const origin = parsed.origin
  const wsOrigin = origin.replace(/^http:/, 'ws:')
  return {
    baseUrl: origin,
    wsUrl: `${wsOrigin}/ws`,
    token,
    port,
  }
}

function parseLoopbackPortFromUrl(raw: string | undefined): number | null {
  if (!raw?.trim()) return null
  try {
    const parsed = new URL(raw.trim())
    if (!isLoopbackHost(parsed.hostname)) return null
    const port = Number(
      parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
    )
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
  } catch {
    return null
  }
}

export interface BridgeWebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: unknown) => void): void
}

export interface ElectronBridgeRpcClientOptions {
  config: ElectronBridgeConfig
  fetchFn?: typeof fetch
  webSocketFactory?: (
    url: string,
    headers: Record<string, string>,
  ) => BridgeWebSocketLike
}

/**
 * Authenticated loopback RPC + push-event client talking to Electron Main's
 * `ElectronBrowserBridge` (`desktop/electron/services/browserUseBridge.ts`).
 *
 * Security invariants:
 * - Always sends `Authorization: Bearer <token>`.
 * - NEVER sends an `Origin` header (Electron Bridge rejects any `Origin`).
 * - Connects strictly to loopback (`127.0.0.1` / `localhost` / `[::1]`).
 */
export class ElectronBridgeRpcClient {
  readonly config: ElectronBridgeConfig
  private readonly fetchFn: typeof fetch
  private readonly webSocketFactory?: ElectronBridgeRpcClientOptions['webSocketFactory']
  private ws: BridgeWebSocketLike | null = null
  private wsConnected = false
  private closed = false
  private nextId = 1
  private readonly wsPending = new Map<
    string | number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
      abortCleanup?: () => void
    }
  >()
  private readonly wsOpenWaiters: Array<() => void> = []
  private readonly pushListeners = new Set<BridgePushListener>()
  private readonly disconnectListeners = new Set<(reason: string) => void>()

  constructor(options: ElectronBridgeRpcClientOptions) {
    this.config = options.config
    this.fetchFn = options.fetchFn ?? globalThis.fetch
    this.webSocketFactory = options.webSocketFactory
  }

  onPushEvent(listener: BridgePushListener): () => void {
    this.pushListeners.add(listener)
    return () => {
      this.pushListeners.delete(listener)
    }
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    this.disconnectListeners.add(listener)
    return () => {
      this.disconnectListeners.delete(listener)
    }
  }

  isConnected(): boolean {
    return !this.closed
  }

  private flushOpenWaiters(): void {
    while (this.wsOpenWaiters.length > 0) {
      const waiter = this.wsOpenWaiters.shift()
      waiter?.()
    }
  }

  private rejectAllWsPending(reason: string): void {
    for (const [id, pending] of this.wsPending.entries()) {
      this.wsPending.delete(id)
      clearTimeout(pending.timer)
      pending.abortCleanup?.()
      pending.reject(new Error(reason))
    }
  }

  ensureEventStream(): void {
    if (this.closed || this.ws) return
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.token}`,
    }

    let socket: BridgeWebSocketLike
    try {
      if (this.webSocketFactory) {
        socket = this.webSocketFactory(this.config.wsUrl, headers)
      } else {
        // Bun's WebSocket constructor accepts `{ headers }` and omits `Origin`.
        const WsCtor = globalThis.WebSocket as unknown as new (
          url: string,
          init?: { headers?: Record<string, string> },
        ) => BridgeWebSocketLike
        socket = new WsCtor(this.config.wsUrl, { headers })
      }
    } catch {
      return
    }

    this.ws = socket
    socket.addEventListener('open', () => {
      this.wsConnected = true
      this.flushOpenWaiters()
    })
    socket.addEventListener('message', rawEvent => {
      const data =
        typeof (rawEvent as { data?: unknown })?.data === 'string'
          ? (rawEvent as { data: string }).data
          : String((rawEvent as { data?: unknown })?.data ?? '')
      if (!data) return
      try {
        const parsed = JSON.parse(data) as Partial<
          BridgePushEvent & BridgeJsonRpcResponse
        >
        if (parsed.id !== undefined && this.wsPending.has(parsed.id)) {
          const pending = this.wsPending.get(parsed.id)!
          this.wsPending.delete(parsed.id)
          clearTimeout(pending.timer)
          pending.abortCleanup?.()
          if (parsed.error) {
            pending.reject(
              new Error(
                `Electron Browser Bridge WS error (${parsed.error.code}): ${parsed.error.message}`,
              ),
            )
          } else {
            pending.resolve(parsed.result ?? {})
          }
          return
        }
        if (typeof parsed.event === 'string') {
          const params =
            parsed.params && typeof parsed.params === 'object'
              ? parsed.params
              : {}
          for (const listener of this.pushListeners) {
            try {
              listener(parsed.event, params)
            } catch {
              // Isolate listener failures
            }
          }
        }
      } catch {
        // Ignore malformed bridge frames
      }
    })
    socket.addEventListener('close', () => {
      const wasConnected = this.wsConnected
      this.wsConnected = false
      if (this.ws === socket) {
        this.ws = null
      }
      this.flushOpenWaiters()
      this.rejectAllWsPending('Electron Browser Bridge socket closed')
      if (wasConnected) {
        for (const listener of this.disconnectListeners) {
          try {
            listener('Electron Browser Bridge socket closed')
          } catch {
            // Isolate
          }
        }
      }
    })
    socket.addEventListener('error', () => {
      this.wsConnected = false
      this.flushOpenWaiters()
    })
  }

  private async waitForWsReady(maxWaitMs = 500): Promise<boolean> {
    this.ensureEventStream()
    if (this.ws && this.wsConnected && this.ws.readyState === 1) {
      return true
    }
    if (!this.ws || this.ws.readyState !== 0) {
      return false
    }
    await new Promise<void>(resolve => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, maxWaitMs)
      this.wsOpenWaiters.push(finish)
    })
    return Boolean(this.ws && this.wsConnected && this.ws.readyState === 1)
  }

  /**
   * Sends a JSON-RPC request over the Bridge WebSocket when connected so
   * Electron Main associates CDP leases with this WS connection and
   * automatically releases them if the server sidecar crashes. Falls back to
   * HTTP `POST /rpc` only when the WS is unavailable.
   */
  async rpcOverWs<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.closed) {
      throw new Error('Electron Browser Bridge client is closed')
    }
    const wsReady = await this.waitForWsReady()
    if (!wsReady || !this.ws) {
      return this.rpc<T>(method, params, options)
    }

    const id = this.nextId++
    const timeoutMs = options.timeoutMs ?? BRIDGE_RPC_TIMEOUT_MS
    const socket = this.ws

    return new Promise<T>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new Error(`Electron Browser Bridge WS ${method} aborted`))
        return
      }
      const timer = setTimeout(() => {
        if (!this.wsPending.delete(id)) return
        abortCleanup?.()
        reject(
          new Error(
            `Electron Browser Bridge WS ${method} timed out after ${timeoutMs}ms`,
          ),
        )
      }, timeoutMs)

      let abortCleanup: (() => void) | undefined
      if (options.signal) {
        const onAbort = () => {
          if (!this.wsPending.delete(id)) return
          clearTimeout(timer)
          reject(new Error(`Electron Browser Bridge WS ${method} aborted`))
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
        abortCleanup = () =>
          options.signal?.removeEventListener('abort', onAbort)
      }

      this.wsPending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
        abortCleanup,
      })

      try {
        socket.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        if (this.wsPending.delete(id)) {
          clearTimeout(timer)
          abortCleanup?.()
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }
    })
  }

  async rpc<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.closed) {
      throw new Error('Electron Browser Bridge client is closed')
    }
    this.ensureEventStream()

    const id = this.nextId++
    const timeoutMs = options.timeoutMs ?? BRIDGE_RPC_TIMEOUT_MS
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs)

    const response = await this.fetchFn(`${this.config.baseUrl}/rpc`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id, method, params }),
      signal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(
        `Electron Browser Bridge RPC ${method} failed (${response.status})${text ? `: ${text.slice(0, 300)}` : ''}`,
      )
    }

    const payload = (await response.json()) as BridgeJsonRpcResponse
    if (payload.error) {
      throw new Error(
        `Electron Browser Bridge ${method} error (${payload.error.code}): ${payload.error.message}`,
      )
    }
    return (payload.result ?? {}) as T
  }

  async close(): Promise<void> {
    this.closed = true
    this.wsConnected = false
    this.flushOpenWaiters()
    this.rejectAllWsPending('BrowserUseService disposed')
    const socket = this.ws
    this.ws = null
    if (socket) {
      try {
        socket.close(1000, 'BrowserUseService disposed')
      } catch {
        // Ignore close errors
      }
    }
  }
}

/**
 * `CdpTransport` implementation backed by Electron Main's loopback
 * `ElectronBrowserBridge` (`cdp.acquire`, `cdp.release`, `cdp.send`, `cdp.event`).
 */
export class ElectronDebuggerTransport implements CdpTransport {
  readonly kind: BrowserTargetKind = 'workspace'
  private readonly eventListeners = new Set<CdpEventListener>()
  private readonly leases = new Map<string, string>()
  private readonly unsubPush: () => void
  private readonly onLeaseAcquired?: (tabId: string) => void

  constructor(
    private readonly client: ElectronBridgeRpcClient,
    options: { onLeaseAcquired?: (tabId: string) => void } = {},
  ) {
    this.onLeaseAcquired = options.onLeaseAcquired
    this.unsubPush = client.onPushEvent((event, params) => {
      if (event !== 'cdp.event') return
      const tabId = typeof params.tabId === 'string' ? params.tabId : undefined
      const method = typeof params.method === 'string' ? params.method : ''
      if (!method) return
      const eventParams =
        params.params && typeof params.params === 'object'
          ? (params.params as Record<string, unknown>)
          : {}
      if (method === 'Inspector.detached' && tabId) {
        this.leases.delete(tabId)
      }
      for (const listener of this.eventListeners) {
        try {
          listener(method, eventParams, tabId)
        } catch {
          // Isolate listener errors
        }
      }
    })
  }

  async acquireLease(tabId: string): Promise<{
    leaseId: string
    zoomFactor: number
    appZoomFactor: number
  }> {
    const res = await this.client.rpcOverWs<{
      leaseId: string
      tabId: string
      zoomFactor?: number
      appZoomFactor?: number
    }>('cdp.acquire', { tabId })
    if (res.leaseId) {
      this.leases.set(tabId, res.leaseId)
    }
    this.onLeaseAcquired?.(tabId)
    return {
      leaseId: res.leaseId,
      zoomFactor: res.zoomFactor ?? 1,
      appZoomFactor: res.appZoomFactor ?? 1,
    }
  }

  async releaseLease(tabId: string): Promise<void> {
    const leaseId = this.leases.get(tabId)
    this.leases.delete(tabId)
    try {
      await this.client.rpcOverWs('cdp.release', {
        tabId,
        ...(leaseId ? { leaseId } : {}),
      })
    } catch {
      // Best-effort release
    }
  }

  async releaseAllLeases(): Promise<void> {
    const tabIds = [...this.leases.keys()]
    await Promise.allSettled(tabIds.map(tabId => this.releaseLease(tabId)))
  }

  async send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    options?: CdpSendOptions,
  ): Promise<T> {
    const tabId = options?.sessionId
    if (!tabId) {
      throw new Error(`ElectronDebuggerTransport requires tabId (sessionId) for ${method}`)
    }
    let leaseId = this.leases.get(tabId)
    if (!leaseId) {
      const acquired = await this.acquireLease(tabId)
      leaseId = acquired.leaseId
    }
    return this.client.rpc<T>(
      'cdp.send',
      {
        tabId,
        method,
        ...(params ? { params } : {}),
        ...(leaseId ? { leaseId } : {}),
      },
      { timeoutMs: options?.timeoutMs, signal: options?.signal },
    )
  }

  onEvent(listener: CdpEventListener): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    return this.client.onDisconnect(listener)
  }

  isConnected(): boolean {
    return this.client.isConnected()
  }

  async close(): Promise<void> {
    this.unsubPush()
    await this.releaseAllLeases()
  }
}

export interface BrowserUseServiceDependencies {
  env?: NodeJS.ProcessEnv
  serverHost?: string
  serverPort?: number
  blockedLoopbackPorts?: number[]
  bridgeClient?: ElectronBridgeRpcClient | null
  chromeManager?: ChromeConnectionManager
  broadcastToSession?: (sessionId: string, message: ServerMessage) => boolean
  submitResumeTurn?: (sessionId: string, content: string) => Promise<void>
  stopSession?: (sessionId: string) => void
}

interface SessionTabOwnership {
  target: BrowserTargetKind
  tabId: string
  sessionId: string
  agentId?: string
}

export class BrowserUseService {
  private readonly env: NodeJS.ProcessEnv
  private serverHost: string
  private serverPort: number
  private readonly extraBlockedPorts: Set<number>
  private readonly broadcastFn: (
    sessionId: string,
    message: ServerMessage,
  ) => boolean
  private readonly submitResumeTurnFn?: (
    sessionId: string,
    content: string,
  ) => Promise<void>
  private readonly stopSessionFn: (sessionId: string) => void

  private bridgeClient: ElectronBridgeRpcClient | null = null
  private workspaceTransport: ElectronDebuggerTransport | null = null
  private workspaceEngine: BrowserUseEngine | null = null
  private unsubBridgeEvents: (() => void) | null = null

  private readonly chromeManager: ChromeConnectionManager
  private chromeEngine: BrowserUseEngine | null = null
  private chromeEngineTransport: CdpTransport | null = null

  // Track which tab each (sessionId, agentId) last operated on
  private readonly sessionTabs = new Map<string, SessionTabOwnership>()
  // Track ALL tabs touched per (sessionId, agentId) so multi-tab turns never leak leases
  private readonly sessionTouchedTabs = new Map<
    string,
    Map<string, BrowserTargetKind>
  >()
  // Track active takeover per sessionId
  private readonly sessionTakeovers = new Map<string, BrowserTakeoverState>()
  // Synchronous in-flight guard so concurrent resume/abort calls stay strictly idempotent
  private readonly settlingTakeovers = new Set<string>()

  constructor(deps: BrowserUseServiceDependencies = {}) {
    this.env = deps.env ?? process.env
    this.serverHost = deps.serverHost ?? '127.0.0.1'
    this.serverPort = deps.serverPort ?? 0
    this.extraBlockedPorts = new Set(deps.blockedLoopbackPorts ?? [])
    this.broadcastFn = deps.broadcastToSession ?? sendToSession
    this.submitResumeTurnFn = deps.submitResumeTurn
    this.stopSessionFn = deps.stopSession ?? stopSessionTurn

    const config = loadBrowserUseConfig({ env: this.env, bypassCache: true })
    this.chromeManager =
      deps.chromeManager ??
      new ChromeConnectionManager({
        env: this.env,
        customExecutablePath: config.chromeBinaryPath,
        customUserDataDir: config.chromeUserDataDir,
      })

    if (deps.bridgeClient !== undefined) {
      if (deps.bridgeClient) {
        this.attachBridgeClient(deps.bridgeClient)
      }
    } else {
      const bridgeConfig = resolveElectronBridgeConfig(this.env)
      if (bridgeConfig) {
        this.attachBridgeClient(new ElectronBridgeRpcClient({ config: bridgeConfig }))
      }
    }
  }

  configureHost(serverHost: string, serverPort: number): void {
    this.serverHost = serverHost
    this.serverPort = serverPort
    this.syncBlockedPorts()
  }

  private getBlockedLoopbackPorts(): number[] {
    const ports = new Set<number>(this.extraBlockedPorts)
    if (this.serverPort > 0) ports.add(this.serverPort)
    if (this.bridgeClient?.config.port) ports.add(this.bridgeClient.config.port)

    const envUrlKeys = [
      'CC_HAHA_BROWSER_BRIDGE_URL',
      'CC_HAHA_DESKTOP_SERVER_URL',
      'CC_HAHA_SYSTEM_PROXY_URL',
      'HTTP_PROXY',
      'HTTPS_PROXY',
    ]
    for (const key of envUrlKeys) {
      const port = parseLoopbackPortFromUrl(this.env[key])
      if (port) ports.add(port)
    }

    const config = loadBrowserUseConfig({ env: this.env })
    for (const port of config.blockedLoopbackPorts ?? []) {
      ports.add(port)
    }

    return [...ports].sort((a, b) => a - b)
  }

  private syncBlockedPorts(): void {
    const ports = this.getBlockedLoopbackPorts()
    this.workspaceEngine?.navigationGuard.setBlockedLoopbackPorts(ports)
    this.chromeEngine?.navigationGuard.setBlockedLoopbackPorts(ports)
  }

  private attachBridgeClient(client: ElectronBridgeRpcClient): void {
    this.bridgeClient = client
    this.extraBlockedPorts.add(client.config.port)
    this.workspaceTransport = new ElectronDebuggerTransport(client, {
      onLeaseAcquired: tabId => {
        this.workspaceEngine?.resetTabDomains(tabId)
      },
    })
    this.workspaceEngine = new BrowserUseEngine({
      transport: this.workspaceTransport,
      blockedLoopbackPorts: this.getBlockedLoopbackPorts(),
      noInPageOverlay: true,
      uiHooks: this.createWorkspaceUiHooks(client),
    })

    this.unsubBridgeEvents = client.onPushEvent((event, params) => {
      if (event === 'tab.closed') {
        const tabId = typeof params.tabId === 'string' ? params.tabId : ''
        if (tabId) {
          this.workspaceEngine?.unregisterTab(tabId)
          this.clearTrackedTab(tabId)
          void this.workspaceTransport?.releaseLease(tabId)
        }
        return
      }
      if (event === 'ui.takeover') {
        const tabId = typeof params.tabId === 'string' ? params.tabId : ''
        const action = typeof params.action === 'string' ? params.action : ''
        const reason = typeof params.reason === 'string' ? params.reason : undefined
        void this.handleBridgeUserAction(tabId, action, reason)
      }
    })
  }

  private createWorkspaceUiHooks(client: ElectronBridgeRpcClient): BrowserUiHooks {
    return {
      moveCursor: async (payload: BrowserCursorPayload, signal?: AbortSignal) => {
        const config = loadBrowserUseConfig({ env: this.env })
        if (!config.showCursorOverlay) {
          return { arrived: true, skipped: true }
        }
        try {
          const res = await client.rpc<{
            moveId: string
            arrived: boolean
            skipped: boolean
          }>(
            'ui.moveCursor',
            {
              tabId: payload.tabId,
              ...(payload.moveId ? { moveId: payload.moveId } : {}),
              x: payload.x,
              y: payload.y,
              ...(payload.targetBox ? { targetRect: payload.targetBox } : {}),
              ...(payload.durationMs !== undefined
                ? { durationMs: payload.durationMs }
                : {}),
              ...(payload.label ? { label: payload.label } : {}),
            },
            { timeoutMs: 2_000, signal },
          )
          return { arrived: res.arrived !== false, skipped: res.skipped === true }
        } catch {
          return { arrived: true, skipped: true }
        }
      },
      clickRipple: async (payload: BrowserCursorPayload) => {
        const config = loadBrowserUseConfig({ env: this.env })
        if (!config.showCursorOverlay) return
        try {
          await client.rpc(
            'ui.clickRipple',
            { tabId: payload.tabId, x: payload.x, y: payload.y },
            { timeoutMs: 1_000 },
          )
        } catch {
          // Best-effort visual feedback
        }
      },
      setControlState: async (payload: BrowserControlStatePayload) => {
        const config = loadBrowserUseConfig({ env: this.env })
        try {
          await client.rpc(
            'ui.controlState',
            {
              tabId: payload.tabId,
              state: payload.state,
              ...(payload.label ? { actionLabel: payload.label } : {}),
              ...(payload.takeoverMessage || payload.takeoverReason
                ? {
                    takeoverReason:
                      payload.takeoverMessage ?? payload.takeoverReason,
                  }
                : {}),
              ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
              showOverlay: config.showCursorOverlay,
              autoReveal: config.autoOpenWorkspacePanel,
            },
            { timeoutMs: 2_000 },
          )
        } catch {
          // Best-effort UI sync
        }
      },
      getZoomFactors: async (tabId: string): Promise<BrowserZoomFactors> => {
        try {
          const res = await client.rpc<{
            zoomFactor?: number
            appZoomFactor?: number
          }>('tabs.zoom', { tabId }, { timeoutMs: 1_500 })
          return {
            pageZoomFactor: res.zoomFactor ?? 1,
            appZoomFactor: res.appZoomFactor ?? 1,
          }
        } catch {
          return { pageZoomFactor: 1, appZoomFactor: 1 }
        }
      },
      onActivity: event => {
        this.handleEngineActivity(event)
      },
    }
  }

  private handleEngineActivity(event: BrowserUseActivityEvent): void {
    const sessionId =
      event.sessionId ?? this.findSessionIdForTab(event.tabId)
    if (!sessionId) return

    const enriched: BrowserUseActivityEvent = {
      ...event,
      sessionId,
    }
    this.broadcastFn(sessionId, {
      type: 'browser_use_activity',
      activity: enriched,
    })

    if (event.takeover) {
      const takeover: BrowserTakeoverState = {
        ...event.takeover,
        sessionId,
      }
      if (takeover.status === 'pending') {
        this.sessionTakeovers.set(sessionId, takeover)
      } else {
        this.sessionTakeovers.delete(sessionId)
      }
      this.broadcastFn(sessionId, {
        type: 'browser_use_takeover',
        takeover,
      })
    }
  }

  private async handleBridgeUserAction(
    tabId: string,
    action: string,
    reason?: string,
  ): Promise<void> {
    const sessionId = this.findSessionIdForTab(tabId)
    if (!sessionId) return

    if (action === 'takeover') {
      const normalizedMessage =
        !reason || reason.trim() === '' || reason.trim() === 'user_requested'
          ? 'User took over browser control.'
          : reason.trim()
      if (this.workspaceEngine) {
        const takeover = await this.workspaceEngine.requestTakeover({
          tabId,
          reason: 'user_requested',
          message: normalizedMessage,
          sessionId,
        })
        this.sessionTakeovers.set(sessionId, { ...takeover, sessionId })
      }
      // Stop the active turn immediately so the agent cannot issue a follow-up
      // BrowserNavigate/BrowserAct and slam the shield back over the user.
      try {
        this.stopSessionFn(sessionId)
      } catch {
        // Best-effort turn interrupt
      }
      return
    }

    if (action === 'resume') {
      await this.resumeTakeover({ sessionId })
      return
    }

    if (action === 'stop' || action === 'cancel') {
      await this.abortTakeover({
        sessionId,
        reason:
          action === 'stop'
            ? 'user_stopped'
            : reason || 'User cancelled browser control',
      })
    }
  }

  private recordTabOwnership(
    sessionId: string,
    agentId: string | undefined,
    target: BrowserTargetKind,
    tabId: string,
  ): void {
    const key = this.scopeKey(sessionId, agentId)
    this.sessionTabs.set(key, { target, tabId, sessionId, agentId })
    let touched = this.sessionTouchedTabs.get(key)
    if (!touched) {
      touched = new Map()
      this.sessionTouchedTabs.set(key, touched)
    }
    touched.set(tabId, target)
  }

  private findSessionIdForTab(tabId: string): string | undefined {
    const registeredOwner = this.workspaceEngine?.getTab(tabId)?.ownerSessionId
    if (registeredOwner) return registeredOwner
    for (const ownership of this.sessionTabs.values()) {
      if (ownership.tabId === tabId) return ownership.sessionId
    }
    for (const [key, tabs] of this.sessionTouchedTabs.entries()) {
      if (tabs.has(tabId)) return key.split('::')[0]
    }
    for (const [sessionId, takeover] of this.sessionTakeovers) {
      if (takeover.tabId === tabId) return sessionId
    }
    return undefined
  }

  private clearTrackedTab(tabId: string): void {
    for (const [key, ownership] of [...this.sessionTabs.entries()]) {
      if (ownership.tabId === tabId) {
        this.sessionTabs.delete(key)
      }
    }
    for (const [key, touched] of [...this.sessionTouchedTabs.entries()]) {
      touched.delete(tabId)
      if (touched.size === 0) {
        this.sessionTouchedTabs.delete(key)
      }
    }
  }

  private scopeKey(sessionId: string, agentId?: string): string {
    return `${sessionId}::${agentId || 'main'}`
  }

  getConfig(): BrowserUseConfig {
    return loadBrowserUseConfig({ env: this.env, bypassCache: true })
  }

  updateConfig(patch: Partial<BrowserUseConfig>): BrowserUseConfig {
    const updated = saveBrowserUseConfig(patch, { env: this.env })
    this.chromeManager.updateOptions({
      customExecutablePath: updated.chromeBinaryPath,
      customUserDataDir: updated.chromeUserDataDir,
    })
    this.syncBlockedPorts()
    this.chromeEngine?.setNoInPageOverlay(!updated.showCursorOverlay)
    return updated
  }

  async getStatus(): Promise<BrowserUseStatus> {
    const config = this.getConfig()
    const chrome = this.chromeManager.getState()
    const workspaceAvailable = Boolean(
      this.bridgeClient && this.workspaceEngine && this.bridgeClient.isConnected(),
    )

    const tabs: BrowserTabInfo[] = []
    if (workspaceAvailable && this.workspaceEngine) {
      try {
        const res = await this.bridgeClient!.rpc<{
          tabs?: BridgeTabDescriptor[]
        }>('tabs.list', {}, { timeoutMs: 2_000 })
        for (const t of res.tabs ?? []) {
          const existing = this.workspaceEngine.getTab(t.tabId)
          this.workspaceEngine.registerTab({
            ...(existing ?? {}),
            tabId: t.tabId,
            target: 'workspace',
            url: t.url,
            title: t.title,
            active: t.visible ?? existing?.active ?? false,
            ...(t.sessionId || existing?.ownerSessionId
              ? { ownerSessionId: t.sessionId ?? existing?.ownerSessionId }
              : {}),
            cdpSessionId: t.tabId,
          })
        }
      } catch {
        // Keep last known tabs if bridge is momentarily busy
      }
      tabs.push(...this.workspaceEngine.listTabs())
    }
    if (this.chromeEngine && this.chromeManager.getTransport()?.isConnected()) {
      tabs.push(...this.chromeEngine.listTabs())
    }

    const activeTakeover =
      this.workspaceEngine?.getActiveTakeover() ??
      this.chromeEngine?.getActiveTakeover() ??
      [...this.sessionTakeovers.values()].find(t => t.status === 'pending') ??
      null

    const controlState: BrowserControlState =
      activeTakeover?.status === 'pending'
        ? 'takeover'
        : this.workspaceEngine?.getControlState() === 'active' ||
            this.chromeEngine?.getControlState() === 'active'
          ? 'active'
          : 'idle'

    let activeTarget: BrowserTargetKind | null = null
    if (config.preferredTarget === 'chrome') {
      activeTarget =
        chrome.mode === 'live_attach' || chrome.mode === 'managed'
          ? 'chrome'
          : null
    } else if (config.preferredTarget === 'workspace') {
      activeTarget = workspaceAvailable ? 'workspace' : null
    } else if (chrome.mode === 'live_attach' || chrome.mode === 'managed') {
      activeTarget = 'chrome'
    } else if (workspaceAvailable) {
      activeTarget = 'workspace'
    }

    const activeTabId =
      activeTakeover?.tabId ??
      tabs.find(t => t.active)?.tabId ??
      tabs[0]?.tabId

    return {
      enabled: config.enabled,
      preferredTarget: config.preferredTarget,
      activeTarget,
      workspaceAvailable,
      chrome,
      controlState,
      ...(activeTabId ? { activeTabId } : {}),
      activeTakeover,
      tabs,
      config,
    }
  }

  async connectChrome(options: {
    browserId?: DetectedBrowserId
    timeoutMs?: number
  } = {}): Promise<{ chrome: ChromeConnectionState; status: BrowserUseStatus }> {
    const chrome = await this.chromeManager.connectLiveAttach(options)
    this.syncChromeEngine()
    const status = await this.getStatus()
    return { chrome, status }
  }

  async launchManagedChrome(options: {
    browserId?: DetectedBrowserId
    headless?: boolean
  } = {}): Promise<{ chrome: ChromeConnectionState; status: BrowserUseStatus }> {
    const config = this.getConfig()
    const chrome = await this.chromeManager.launchManagedChrome({
      browserId: options.browserId,
      headless: options.headless ?? config.managedChromeHeadless,
    })
    this.syncChromeEngine()
    const status = await this.getStatus()
    return { chrome, status }
  }

  async disconnectChrome(): Promise<BrowserUseStatus> {
    if (this.chromeEngine) {
      this.chromeEngine.dispose()
      this.chromeEngine = null
      this.chromeEngineTransport = null
    }
    await this.chromeManager.disconnect()
    return this.getStatus()
  }

  private syncChromeEngine(): BrowserUseEngine | null {
    const transport = this.chromeManager.getTransport()
    if (!transport || !transport.isConnected()) {
      if (this.chromeEngine) {
        this.chromeEngine.dispose()
        this.chromeEngine = null
        this.chromeEngineTransport = null
      }
      return null
    }
    if (this.chromeEngine && this.chromeEngineTransport === transport) {
      return this.chromeEngine
    }
    this.chromeEngine?.dispose()
    const config = this.getConfig()
    this.chromeEngineTransport = transport
    this.chromeEngine = new BrowserUseEngine({
      transport,
      blockedLoopbackPorts: this.getBlockedLoopbackPorts(),
      noInPageOverlay: !config.showCursorOverlay,
      uiHooks: {
        onActivity: event => this.handleEngineActivity(event),
      },
    })
    return this.chromeEngine
  }

  private resolveTarget(requested?: BrowserPreferredTarget): BrowserTargetKind {
    const config = this.getConfig()
    if (!config.enabled) {
      throw new ApiError(
        403,
        'Browser Use is disabled. Enable it in Settings or the Composer "+" menu first.',
        'BROWSER_USE_DISABLED',
      )
    }

    const pref = requested && requested !== 'auto' ? requested : config.preferredTarget
    const chromeReady = Boolean(this.chromeManager.getTransport()?.isConnected())
    const workspaceReady = Boolean(
      this.bridgeClient && this.workspaceEngine && this.bridgeClient.isConnected(),
    )

    if (pref === 'chrome') {
      if (!chromeReady) {
        throw new ApiError(
          409,
          'System Chrome is not connected. Connect Chrome or launch Managed Chrome in Settings -> Browser Use.',
          'CHROME_NOT_CONNECTED',
        )
      }
      return 'chrome'
    }

    if (pref === 'workspace') {
      if (!workspaceReady) {
        throw new ApiError(
          503,
          'Workspace Browser bridge is unavailable in this environment.',
          'WORKSPACE_BROWSER_UNAVAILABLE',
        )
      }
      return 'workspace'
    }

    // 'auto': prefer connected Chrome if explicitly connected, else Workspace Browser
    if (chromeReady) return 'chrome'
    if (workspaceReady) return 'workspace'

    throw new ApiError(
      503,
      'No Browser Use target is ready. Open the Desktop app for Workspace Browser or connect Chrome in Settings.',
      'NO_BROWSER_TARGET_AVAILABLE',
    )
  }

  private async ensureTargetTab(options: {
    target: BrowserTargetKind
    tabId?: string
    url?: string
    sessionId: string
    agentId?: string
  }): Promise<{ engine: BrowserUseEngine; tab: BrowserTabInfo }> {
    const key = this.scopeKey(options.sessionId, options.agentId)
    const remembered = this.sessionTabs.get(key)
    const rememberedTabId =
      remembered && remembered.target === options.target
        ? remembered.tabId
        : undefined
    let desiredTabId = options.tabId ?? rememberedTabId

    if (options.target === 'workspace') {
      if (!this.bridgeClient || !this.workspaceEngine) {
        throw new ApiError(
          503,
          'Workspace Browser bridge is unavailable',
          'WORKSPACE_BROWSER_UNAVAILABLE',
        )
      }
      // Never allow one session to hijack a workspace browser tab owned by a
      // different session (e.g., from a stale or cross-session tabId).
      if (desiredTabId) {
        const known = this.workspaceEngine.getTab(desiredTabId)
        if (known?.ownerSessionId && known.ownerSessionId !== options.sessionId) {
          const fallbackKnown = rememberedTabId
            ? this.workspaceEngine.getTab(rememberedTabId)
            : null
          desiredTabId =
            rememberedTabId &&
            (!fallbackKnown?.ownerSessionId ||
              fallbackKnown.ownerSessionId === options.sessionId)
              ? rememberedTabId
              : undefined
        }
      }
      const config = this.getConfig()
      if (options.url) {
        this.workspaceEngine.navigationGuard.assertAllowed(options.url)
      }
      const ensured = await this.bridgeClient.rpc<BridgeTabDescriptor>(
        'tabs.ensure',
        {
          sessionId: options.sessionId,
          ...(desiredTabId ? { tabId: desiredTabId } : {}),
          ...(options.url ? { url: options.url } : {}),
          focus: true,
          revealWorkbench: config.autoOpenWorkspacePanel,
        },
      )
      if (ensured.sessionId && ensured.sessionId !== options.sessionId) {
        throw new ApiError(
          409,
          `Workspace browser tab ${ensured.tabId} belongs to another session`,
          'WORKSPACE_TAB_SESSION_MISMATCH',
        )
      }
      const tab = this.workspaceEngine.registerTab({
        tabId: ensured.tabId,
        target: 'workspace',
        url: ensured.url || options.url || 'about:blank',
        title: ensured.title || '',
        active: true,
        ownerSessionId: ensured.sessionId ?? options.sessionId,
        ownerAgentId: options.agentId,
        cdpSessionId: ensured.tabId,
      })
      this.recordTabOwnership(
        options.sessionId,
        options.agentId,
        'workspace',
        tab.tabId,
      )
      return { engine: this.workspaceEngine, tab }
    }

    // System / Managed Chrome
    const engine = this.syncChromeEngine()
    const transport = this.chromeManager.getTransport()
    if (!engine || !transport) {
      throw new ApiError(409, 'System Chrome is not connected', 'CHROME_NOT_CONNECTED')
    }

    if (options.url) {
      engine.navigationGuard.assertAllowed(options.url)
    }

    let tab = desiredTabId ? engine.getTab(desiredTabId) : null
    if (!tab) {
      // Tab Pinning: in Live Attach mode, create and pin a dedicated agent tab
      // so we never hijack the user's active browser tab!
      const created = await transport.send<{ targetId: string }>(
        'Target.createTarget',
        { url: options.url ?? 'about:blank' },
      )
      const attached = await transport.send<{ sessionId: string }>(
        'Target.attachToTarget',
        { targetId: created.targetId, flatten: true },
      )
      this.chromeManager.pinTab(created.targetId)
      tab = engine.registerTab({
        tabId: created.targetId,
        target: 'chrome',
        targetId: created.targetId,
        cdpSessionId: attached.sessionId,
        url: options.url ?? 'about:blank',
        title: '',
        active: true,
        pinned: true,
        ownerSessionId: options.sessionId,
        ownerAgentId: options.agentId,
      })
    } else if (!tab.cdpSessionId) {
      const targetId = tab.targetId ?? tab.tabId
      const attached = await transport.send<{ sessionId: string }>(
        'Target.attachToTarget',
        { targetId, flatten: true },
      )
      tab = engine.registerTab({
        ...tab,
        cdpSessionId: attached.sessionId,
        ownerSessionId: options.sessionId,
        ownerAgentId: options.agentId,
      })
    }

    this.recordTabOwnership(
      options.sessionId,
      options.agentId,
      'chrome',
      tab.tabId,
    )
    return { engine, tab }
  }

  async executeTabs(
    input: BrowserTabsInput & {
      sessionId: string
      agentId?: string
      signal?: AbortSignal
    },
  ): Promise<Record<string, unknown>> {
    const target = this.resolveTarget(input.target)

    if (target === 'workspace') {
      if (!this.bridgeClient || !this.workspaceEngine) {
        throw new ApiError(503, 'Workspace Browser bridge is unavailable')
      }
      if (input.action === 'list') {
        const res = await this.bridgeClient.rpc<{ tabs?: BridgeTabDescriptor[] }>(
          'tabs.list',
          { sessionId: input.sessionId },
          { signal: input.signal },
        )
        const tabs: BrowserTabInfo[] = []
        for (const t of res.tabs ?? []) {
          const existing = this.workspaceEngine.getTab(t.tabId)
          const ownerSessionId = t.sessionId ?? existing?.ownerSessionId
          if (ownerSessionId && ownerSessionId !== input.sessionId) {
            continue
          }
          tabs.push(
            this.workspaceEngine.registerTab({
              ...(existing ?? {}),
              tabId: t.tabId,
              target: 'workspace',
              url: t.url,
              title: t.title,
              active: t.visible ?? false,
              ownerSessionId: ownerSessionId ?? input.sessionId,
              cdpSessionId: t.tabId,
            }),
          )
        }
        return { target, tabs }
      }
      if (input.action === 'open') {
        if (input.url) {
          this.workspaceEngine.navigationGuard.assertAllowed(input.url)
        }
        const config = this.getConfig()
        const ensured = await this.bridgeClient.rpc<BridgeTabDescriptor>(
          'tabs.ensure',
          {
            sessionId: input.sessionId,
            createNew: true,
            ...(input.url ? { url: input.url } : {}),
            focus: true,
            revealWorkbench: config.autoOpenWorkspacePanel,
          },
          { signal: input.signal },
        )
        const tab = this.workspaceEngine.registerTab({
          tabId: ensured.tabId,
          target: 'workspace',
          url: ensured.url || input.url || 'about:blank',
          title: ensured.title || '',
          active: true,
          ownerSessionId: ensured.sessionId ?? input.sessionId,
          ownerAgentId: input.agentId,
          cdpSessionId: ensured.tabId,
        })
        this.recordTabOwnership(
          input.sessionId,
          input.agentId,
          'workspace',
          tab.tabId,
        )
        return {
          target,
          tab,
          tabs: this.workspaceEngine
            .listTabs()
            .filter(t => t.ownerSessionId === input.sessionId),
        }
      }
      if (input.action === 'focus') {
        if (!input.tabId) throw ApiError.badRequest('tabId is required for focus')
        const existing = this.workspaceEngine.getTab(input.tabId)
        if (existing?.ownerSessionId && existing.ownerSessionId !== input.sessionId) {
          throw new ApiError(
            403,
            `Workspace browser tab ${input.tabId} belongs to another session`,
            'WORKSPACE_TAB_SESSION_MISMATCH',
          )
        }
        const config = this.getConfig()
        await this.bridgeClient.rpc(
          'tabs.focus',
          {
            tabId: input.tabId,
            sessionId: input.sessionId,
            revealWorkbench: config.autoOpenWorkspacePanel,
          },
          { signal: input.signal },
        )
        const tab = this.workspaceEngine.setActiveTab(input.tabId)
        this.recordTabOwnership(
          input.sessionId,
          input.agentId,
          'workspace',
          input.tabId,
        )
        return { ok: true, target, tabId: input.tabId, ...(tab ? { tab } : {}) }
      }
      if (input.action === 'close') {
        if (!input.tabId) throw ApiError.badRequest('tabId is required for close')
        const existing = this.workspaceEngine.getTab(input.tabId)
        if (existing?.ownerSessionId && existing.ownerSessionId !== input.sessionId) {
          throw new ApiError(
            403,
            `Workspace browser tab ${input.tabId} belongs to another session`,
            'WORKSPACE_TAB_SESSION_MISMATCH',
          )
        }
        await this.workspaceTransport?.releaseLease(input.tabId)
        await this.bridgeClient.rpc(
          'tabs.close',
          { tabId: input.tabId, sessionId: input.sessionId },
          { signal: input.signal },
        )
        this.workspaceEngine.unregisterTab(input.tabId)
        this.clearTrackedTab(input.tabId)
        return { ok: true, target, tabId: input.tabId }
      }
    }

    // Chrome target
    const engine = this.syncChromeEngine()
    const transport = this.chromeManager.getTransport()
    if (!engine || !transport) {
      throw new ApiError(409, 'System Chrome is not connected')
    }

    if (input.action === 'list') {
      const { targetInfos } = await transport.send<{
        targetInfos?: Array<{
          targetId: string
          type: string
          title: string
          url: string
        }>
      }>('Target.getTargets', undefined, { signal: input.signal })
      const tabs = (targetInfos ?? [])
        .filter(t => t.type === 'page')
        .map(t =>
          engine.registerTab({
            ...(engine.getTab(t.targetId) ?? {}),
            tabId: t.targetId,
            target: 'chrome',
            targetId: t.targetId,
            url: t.url,
            title: t.title,
            active: engine.getTab()?.tabId === t.targetId,
            pinned: this.chromeManager.isTabPinned(t.targetId),
          }),
        )
      return { target, tabs }
    }
    if (input.action === 'open') {
      if (input.url) {
        engine.navigationGuard.assertAllowed(input.url)
      }
      const created = await transport.send<{ targetId: string }>(
        'Target.createTarget',
        { url: input.url ?? 'about:blank' },
        { signal: input.signal },
      )
      const attached = await transport.send<{ sessionId: string }>(
        'Target.attachToTarget',
        { targetId: created.targetId, flatten: true },
        { signal: input.signal },
      )
      this.chromeManager.pinTab(created.targetId)
      const tab = engine.registerTab({
        tabId: created.targetId,
        target: 'chrome',
        targetId: created.targetId,
        cdpSessionId: attached.sessionId,
        url: input.url ?? 'about:blank',
        title: '',
        active: true,
        pinned: true,
        ownerSessionId: input.sessionId,
        ownerAgentId: input.agentId,
      })
      this.recordTabOwnership(
        input.sessionId,
        input.agentId,
        'chrome',
        tab.tabId,
      )
      return { target, tab, tabs: engine.listTabs() }
    }
    if (input.action === 'focus') {
      if (!input.tabId) throw ApiError.badRequest('tabId is required for focus')
      await transport.send(
        'Target.activateTarget',
        { targetId: input.tabId },
        { signal: input.signal },
      )
      const tab = engine.setActiveTab(input.tabId)
      return { ok: true, target, tabId: input.tabId, ...(tab ? { tab } : {}) }
    }
    if (input.action === 'close') {
      if (!input.tabId) throw ApiError.badRequest('tabId is required for close')
      await transport.send(
        'Target.closeTarget',
        { targetId: input.tabId },
        { signal: input.signal },
      )
      engine.unregisterTab(input.tabId)
      this.chromeManager.unpinTab(input.tabId)
      return { ok: true, target, tabId: input.tabId }
    }
    throw ApiError.badRequest(`Unsupported tabs action: ${String(input.action)}`)
  }

  async executeNavigate(
    input: BrowserNavigateInput & {
      sessionId: string
      agentId?: string
      signal?: AbortSignal
    },
  ): Promise<BrowserNavigateResult> {
    const target = this.resolveTarget(input.target)
    const { engine, tab } = await this.ensureTargetTab({
      target,
      tabId: input.tabId,
      sessionId: input.sessionId,
      agentId: input.agentId,
    })
    return engine.navigate({
      tabId: tab.tabId,
      url: input.url,
      action: input.action,
      waitUntil: input.waitUntil,
      timeoutMs: input.timeoutMs,
      sessionId: input.sessionId,
      agentId: input.agentId,
      signal: input.signal,
    })
  }

  async executeSnapshot(
    input: BrowserSnapshotInput & {
      sessionId: string
      agentId?: string
      signal?: AbortSignal
    },
  ): Promise<BrowserSnapshotResult> {
    const target = this.resolveTarget(input.target)
    const { engine, tab } = await this.ensureTargetTab({
      target,
      tabId: input.tabId,
      sessionId: input.sessionId,
      agentId: input.agentId,
    })
    return engine.snapshot({
      tabId: tab.tabId,
      diff: input.diff,
      screenshot: input.screenshot,
      screenshotFormat: input.screenshotFormat,
      includeNonInteractive: input.includeNonInteractive,
      maxNodes: input.maxNodes,
      sessionId: input.sessionId,
      agentId: input.agentId,
      signal: input.signal,
    })
  }

  async executeAct(
    input: BrowserActInput & {
      sessionId: string
      agentId?: string
      signal?: AbortSignal
    },
  ): Promise<BrowserActResult> {
    const target = this.resolveTarget(input.target)
    const { engine, tab } = await this.ensureTargetTab({
      target,
      tabId: input.tabId,
      sessionId: input.sessionId,
      agentId: input.agentId,
    })
    return engine.act({
      tabId: tab.tabId,
      steps: input.steps as FlatActionStep[],
      stopOnNavigation: input.stopOnNavigation,
      autoTakeoverOnSensitive: input.autoTakeoverOnSensitive,
      sessionId: input.sessionId,
      agentId: input.agentId,
      signal: input.signal,
    })
  }

  async executeInspect(
    input: BrowserInspectInput & {
      sessionId: string
      agentId?: string
      signal?: AbortSignal
    },
  ): Promise<BrowserInspectResult> {
    const target = this.resolveTarget(input.target)
    const { engine, tab } = await this.ensureTargetTab({
      target,
      tabId: input.tabId,
      sessionId: input.sessionId,
      agentId: input.agentId,
    })
    return engine.inspect({
      tabId: tab.tabId,
      kind: input.kind,
      selector: input.selector,
      expression: input.expression,
      limit: input.limit,
      maxChars: input.maxChars,
      sessionId: input.sessionId,
      agentId: input.agentId,
      signal: input.signal,
    })
  }

  async executeTakeover(
    input: BrowserTakeoverInput & {
      sessionId: string
      agentId?: string
    },
  ): Promise<BrowserTakeoverState> {
    const target = this.resolveTarget(input.target)
    const { engine, tab } = await this.ensureTargetTab({
      target,
      tabId: input.tabId,
      sessionId: input.sessionId,
      agentId: input.agentId,
    })
    const takeover = await engine.requestTakeover({
      tabId: tab.tabId,
      reason: input.reason,
      message: input.message,
      sessionId: input.sessionId,
      agentId: input.agentId,
    })
    this.sessionTakeovers.set(input.sessionId, {
      ...takeover,
      sessionId: input.sessionId,
    })
    return takeover
  }

  private claimPendingTakeover(
    sessionId: string,
    takeoverId?: string,
  ): BrowserTakeoverState | null {
    if (this.settlingTakeovers.has(sessionId)) {
      return null
    }
    const candidates: Array<BrowserTakeoverState | null | undefined> = [
      this.sessionTakeovers.get(sessionId),
      this.workspaceEngine?.getActiveTakeover(),
      this.chromeEngine?.getActiveTakeover(),
    ]
    const match = candidates.find(candidate => {
      if (!candidate || candidate.status !== 'pending') return false
      if (candidate.sessionId && candidate.sessionId !== sessionId) return false
      if (takeoverId && candidate.takeoverId !== takeoverId) return false
      return true
    })
    if (!match) {
      return null
    }
    this.settlingTakeovers.add(sessionId)
    this.sessionTakeovers.delete(sessionId)
    return { ...match, sessionId }
  }

  async resumeTakeover(options: {
    sessionId: string
    takeoverId?: string
    note?: string
  }): Promise<{
    resumed: boolean
    turnResumed?: boolean
    resumeError?: string
    takeover?: BrowserTakeoverState
  }> {
    const claimed = this.claimPendingTakeover(
      options.sessionId,
      options.takeoverId,
    )
    if (!claimed) {
      return { resumed: false }
    }

    try {
      let resumed: BrowserTakeoverState | null = null
      if (
        this.workspaceEngine?.getActiveTakeover()?.takeoverId ===
        claimed.takeoverId
      ) {
        resumed = await this.workspaceEngine.resumeTakeover(claimed.takeoverId)
      }
      if (
        !resumed &&
        this.chromeEngine?.getActiveTakeover()?.takeoverId ===
          claimed.takeoverId
      ) {
        resumed = await this.chromeEngine.resumeTakeover(claimed.takeoverId)
      }

      if (!resumed) {
        resumed = { ...claimed, status: 'resumed' }
        this.broadcastFn(options.sessionId, {
          type: 'browser_use_takeover',
          takeover: resumed,
        })
      }

      const resumeMessage = options.note
        ? `[Browser Use] The user completed the manual browser takeover (${options.note}). Call BrowserSnapshot to observe the updated page and continue.`
        : '[Browser Use] The user completed the manual browser takeover. Call BrowserSnapshot to observe the updated page and continue.'

      let turnResumed = false
      let resumeError: string | undefined
      if (this.submitResumeTurnFn) {
        try {
          await this.submitResumeTurnFn(options.sessionId, resumeMessage)
          turnResumed = true
        } catch (err) {
          resumeError = err instanceof Error ? err.message : String(err)
          console.warn(
            `[BrowserUse] Failed to submit resume turn for ${options.sessionId}: ${resumeError}`,
          )
        }
      } else if (
        this.serverPort > 0 &&
        getSessionTurnState(options.sessionId) === 'idle'
      ) {
        try {
          await submitSessionTurn(options.sessionId, resumeMessage, {
            serverHost: this.serverHost,
            serverPort: this.serverPort,
            messageId: randomUUID(),
            sourceSessionId: options.sessionId,
          })
          turnResumed = true
        } catch (err) {
          resumeError = err instanceof Error ? err.message : String(err)
          console.warn(
            `[BrowserUse] Failed to submit resume turn for ${options.sessionId}: ${resumeError}`,
          )
        }
      }

      return {
        resumed: true,
        turnResumed,
        ...(resumeError ? { resumeError } : {}),
        takeover: resumed,
      }
    } finally {
      this.settlingTakeovers.delete(options.sessionId)
    }
  }

  private async releaseTabScope(
    tabs: Map<string, BrowserTargetKind>,
  ): Promise<number> {
    let released = 0
    for (const [tabId, target] of tabs.entries()) {
      released += 1
      if (target === 'workspace') {
        await this.workspaceEngine?.releaseControl(tabId)
        await this.workspaceTransport?.releaseLease(tabId)
        this.workspaceEngine?.resetTabDomains(tabId)
      } else if (target === 'chrome') {
        await this.chromeEngine?.releaseControl(tabId)
      }
    }
    return released
  }

  private async releaseAllTabsForSession(sessionId: string): Promise<number> {
    const prefix = `${sessionId}::`
    const tabsToRelease = new Map<string, BrowserTargetKind>()
    for (const [key, touched] of [...this.sessionTouchedTabs.entries()]) {
      if (!key.startsWith(prefix)) continue
      for (const [tabId, target] of touched.entries()) {
        tabsToRelease.set(tabId, target)
      }
      this.sessionTouchedTabs.delete(key)
    }
    for (const [key, ownership] of [...this.sessionTabs.entries()]) {
      if (!key.startsWith(prefix)) continue
      tabsToRelease.set(ownership.tabId, ownership.target)
    }
    return this.releaseTabScope(tabsToRelease)
  }

  async abortTakeover(options: {
    sessionId: string
    takeoverId?: string
    reason?: string
  }): Promise<{ takeover?: BrowserTakeoverState; stopped?: boolean }> {
    const isStopRequest = options.reason === 'user_stopped'
    const alreadySettling = this.settlingTakeovers.has(options.sessionId)
    const claimed = this.claimPendingTakeover(
      options.sessionId,
      options.takeoverId,
    )
    if (!claimed) {
      if (alreadySettling) {
        return {}
      }
      const releasedCount = await this.releaseAllTabsForSession(
        options.sessionId,
      )
      if (isStopRequest || releasedCount > 0) {
        try {
          this.stopSessionFn(options.sessionId)
        } catch {
          // Best-effort turn stop
        }
        return { stopped: true }
      }
      return {}
    }

    try {
      let aborted: BrowserTakeoverState | null = null
      if (
        this.workspaceEngine?.getActiveTakeover()?.takeoverId ===
        claimed.takeoverId
      ) {
        aborted = await this.workspaceEngine.abortTakeover(claimed.takeoverId)
      }
      if (
        !aborted &&
        this.chromeEngine?.getActiveTakeover()?.takeoverId ===
          claimed.takeoverId
      ) {
        aborted = await this.chromeEngine.abortTakeover(claimed.takeoverId)
      }

      if (!aborted) {
        aborted = {
          ...claimed,
          status: 'aborted',
          ...(options.reason ? { message: options.reason } : {}),
        }
        this.broadcastFn(options.sessionId, {
          type: 'browser_use_takeover',
          takeover: aborted,
        })
      }

      if (isStopRequest) {
        await this.releaseAllTabsForSession(options.sessionId)
        try {
          this.stopSessionFn(options.sessionId)
        } catch {
          // Best-effort turn stop
        }
      }

      return { takeover: aborted, ...(isStopRequest ? { stopped: true } : {}) }
    } finally {
      this.settlingTakeovers.delete(options.sessionId)
    }
  }

  async cleanupAfterTurn(options: {
    sessionId: string
    agentId?: string
  }): Promise<{ ok: true; preservedTakeover: boolean }> {
    const activeTakeover = this.sessionTakeovers.get(options.sessionId)
    if (
      activeTakeover &&
      activeTakeover.status === 'pending' &&
      (!options.agentId || !activeTakeover.agentId || activeTakeover.agentId === options.agentId)
    ) {
      return { ok: true, preservedTakeover: true }
    }

    const key = this.scopeKey(options.sessionId, options.agentId)
    const touched = this.sessionTouchedTabs.get(key)
    const tabsToRelease = new Map<string, BrowserTargetKind>(touched ?? [])
    this.sessionTouchedTabs.delete(key)

    const lastOwnership = this.sessionTabs.get(key)
    if (lastOwnership) {
      tabsToRelease.set(lastOwnership.tabId, lastOwnership.target)
    }

    if (tabsToRelease.size === 0) {
      return { ok: true, preservedTakeover: false }
    }

    await this.releaseTabScope(tabsToRelease)
    return { ok: true, preservedTakeover: false }
  }

  async dispose(): Promise<void> {
    this.unsubBridgeEvents?.()
    this.unsubBridgeEvents = null
    this.workspaceEngine?.dispose()
    this.workspaceEngine = null
    await this.workspaceTransport?.close().catch(() => {})
    this.workspaceTransport = null
    await this.bridgeClient?.close().catch(() => {})
    this.bridgeClient = null
    this.chromeEngine?.dispose()
    this.chromeEngine = null
    this.chromeEngineTransport = null
    await this.chromeManager.disconnect().catch(() => {})
    this.sessionTabs.clear()
    this.sessionTouchedTabs.clear()
    this.sessionTakeovers.clear()
    this.settlingTakeovers.clear()
  }
}

let singletonService: BrowserUseService | null = null

export function getBrowserUseService(): BrowserUseService {
  if (!singletonService) {
    singletonService = new BrowserUseService()
  }
  return singletonService
}

export function configureBrowserUseHost(
  serverHost: string,
  serverPort: number,
): () => void {
  const service = getBrowserUseService()
  service.configureHost(serverHost, serverPort)
  return () => {
    void service.dispose()
    if (singletonService === service) {
      singletonService = null
    }
  }
}

export function resetBrowserUseServiceForTests(): void {
  if (singletonService) {
    void singletonService.dispose()
    singletonService = null
  }
}
