import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type net from 'node:net'
import type { Duplex } from 'node:stream'
import type { DebuggerLeaseManager } from './workspaceBrowserCdp'

export const BROWSER_BRIDGE_HOST = '127.0.0.1'
const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_HTTP_BODY_BYTES = 16 * 1024 * 1024
const MAX_WS_PAYLOAD_BYTES = 16 * 1024 * 1024
const DEFAULT_ENSURE_TAB_TIMEOUT_MS = 10_000
const DEFAULT_CURSOR_DURATION_MS = 260
const MAX_CURSOR_WAIT_CEILING_MS = 750
const CURSOR_WAIT_BUFFER_MS = 250

export type BrowserUseControlState = 'idle' | 'active' | 'takeover'
export type BrowserUseUserActionKind = 'takeover' | 'resume' | 'stop' | 'cancel'

export type BrowserUseCursorRect = {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserUseBridgeTabInfo = {
  tabId: string
  sessionId?: string
  url: string
  title: string
  visible: boolean
  zoomFactor: number
  appZoomFactor: number
}

export type BrowserUseRendererEvent =
  | {
      type: 'ensure-tab'
      requestId: string
      sessionId?: string
      tabId?: string
      url?: string
      focus?: boolean
      revealWorkbench?: boolean
      createNew?: boolean
    }
  | {
      type: 'focus-tab'
      tabId: string
      sessionId?: string
      revealWorkbench?: boolean
    }
  | {
      type: 'close-tab'
      tabId: string
      sessionId?: string
    }
  | {
      type: 'control-state'
      tabId: string
      state: BrowserUseControlState
      actionLabel?: string
      takeoverReason?: string
      sessionId?: string
      showOverlay?: boolean
      autoReveal?: boolean
    }
  | {
      type: 'move-cursor'
      tabId: string
      moveId: string
      x: number
      y: number
      targetRect?: BrowserUseCursorRect
      durationMs: number
      label?: string
    }
  | {
      type: 'click-ripple'
      tabId: string
      x: number
      y: number
      button?: 'left' | 'right' | 'middle'
    }

export type BrowserUseTabReadyPayload = {
  requestId: string
  tabId: string
  ok: boolean
  error?: string
}

export type BrowserUseCursorArrivedPayload = {
  moveId: string
  tabId: string
  skipped?: boolean
}

export type BrowserUseUserActionPayload = {
  tabId: string
  action: BrowserUseUserActionKind
  reason?: string
}

export type BrowserUseWorkspaceHost = {
  listPages(options?: { sessionId?: string }): BrowserUseBridgeTabInfo[]
  getPageInfo(tabId: string): BrowserUseBridgeTabInfo | null
  getPageZoomFactor(tabId: string): number
  getAppZoomFactor(): number
  close(tabId: string): void
  setAgentControlActive(tabId: string, active: boolean): Promise<void>
  getCdpManager(): DebuggerLeaseManager
  onPageClosed(listener: (event: { tabId: string, reason: 'closed' | 'crashed' }) => void): () => void
}

export type ElectronBrowserBridgeOptions = {
  token: string
  workspaceBrowser: BrowserUseWorkspaceHost
  emitToRenderer: (event: BrowserUseRendererEvent) => boolean
  isRendererVisible?: () => boolean
  ensureTabTimeoutMs?: number
}

type RpcRequest = {
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

type RpcClientContext = {
  trackLease: (tabId: string, leaseId: string) => void
  untrackLease: (tabId: string, leaseId?: string) => void
  markControlledTab: (tabId: string, active: boolean) => void
}

type PendingEnsureTab = {
  resolve: (payload: BrowserUseTabReadyPayload) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type PendingCursorArrival = {
  resolve: (result: { moveId: string, arrived: boolean, skipped: boolean }) => void
  timer: ReturnType<typeof setTimeout>
  cleanupAbort?: () => void
}

type WsClientConnection = {
  socket: Duplex
  leases: Map<string, Set<string>>
  controlledTabs: Set<string>
  sendJson: (payload: Record<string, unknown>) => void
  close: () => void
}

export function computeCursorWaitCeilingMs(durationMs?: number): number {
  const normalized = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
    ? durationMs
    : DEFAULT_CURSOR_DURATION_MS
  return Math.min(normalized + CURSOR_WAIT_BUFFER_MS, MAX_CURSOR_WAIT_CEILING_MS)
}

export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (!address) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function verifyBearerToken(
  authorizationHeader: string | string[] | undefined,
  expectedToken: string,
): boolean {
  if (!expectedToken) return false
  const raw = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader
  if (typeof raw !== 'string') return false
  const match = raw.match(/^Bearer\s+(.+)$/i)
  if (!match) return false
  const provided = match[1]?.trim()
  if (!provided) return false
  const providedDigest = createHash('sha256').update(provided).digest()
  const expectedDigest = createHash('sha256').update(expectedToken).digest()
  return timingSafeEqual(providedDigest, expectedDigest)
}

/**
 * Authenticated loopback-only HTTP + WebSocket JSON-RPC bridge between the
 * local Bun server sidecar and the Electron main process.
 *
 * Security invariants:
 * - Binds strictly to `127.0.0.1:0` and validates `socket.remoteAddress`.
 * - Rejects ANY request carrying an `Origin` header (prevents CSWSH/CSRF).
 * - Requires `Authorization: Bearer <256-bit token>` verified via `timingSafeEqual`.
 * - Never grants raw CDP access: every command passes through `DebuggerLeaseManager`.
 */
export class ElectronBrowserBridge {
  private readonly token: string
  private readonly workspaceBrowser: BrowserUseWorkspaceHost
  private readonly emitToRenderer: (event: BrowserUseRendererEvent) => boolean
  private readonly isRendererVisible: () => boolean
  private readonly ensureTabTimeoutMs: number
  private server: http.Server | null = null
  private startPromise: Promise<string> | null = null
  private bridgeUrl: string | null = null
  private lifecycleGeneration = 0
  private readonly httpSockets = new Set<net.Socket>()
  private readonly wsClients = new Set<WsClientConnection>()
  private readonly pendingEnsureTabs = new Map<string, PendingEnsureTab>()
  private readonly pendingCursorMoves = new Map<string, PendingCursorArrival>()
  private unsubPageClosed: (() => void) | null = null
  private activeControlTabs = new Set<string>()

  constructor(options: ElectronBrowserBridgeOptions) {
    this.token = options.token
    this.workspaceBrowser = options.workspaceBrowser
    this.emitToRenderer = options.emitToRenderer
    this.isRendererVisible = options.isRendererVisible ?? (() => true)
    this.ensureTabTimeoutMs = options.ensureTabTimeoutMs ?? DEFAULT_ENSURE_TAB_TIMEOUT_MS
    this.unsubPageClosed = this.workspaceBrowser.onPageClosed(event => {
      this.activeControlTabs.delete(event.tabId)
      this.broadcastEvent('tab.closed', {
        tabId: event.tabId,
        reason: event.reason,
      })
    })
  }

  getUrl(): string | null {
    return this.bridgeUrl
  }

  start(): Promise<string> {
    if (this.startPromise) return this.startPromise
    const generation = ++this.lifecycleGeneration
    this.startPromise = this.startOnce(generation)
    return this.startPromise
  }

  async stop(): Promise<void> {
    ++this.lifecycleGeneration
    const startPromise = this.startPromise
    this.startPromise = null
    this.bridgeUrl = null
    const server = this.server
    this.server = null

    for (const [requestId, pending] of [...this.pendingEnsureTabs.entries()]) {
      this.pendingEnsureTabs.delete(requestId)
      clearTimeout(pending.timer)
      pending.reject(new Error('Browser bridge stopped'))
    }
    for (const [moveId, pending] of [...this.pendingCursorMoves.entries()]) {
      this.pendingCursorMoves.delete(moveId)
      clearTimeout(pending.timer)
      pending.cleanupAbort?.()
      pending.resolve({ moveId, arrived: false, skipped: true })
    }
    for (const tabId of [...this.activeControlTabs]) {
      this.activeControlTabs.delete(tabId)
      void this.workspaceBrowser.setAgentControlActive(tabId, false).catch(() => {})
    }
    for (const client of [...this.wsClients]) {
      this.cleanupWsClient(client)
      client.close()
    }
    for (const socket of this.httpSockets) socket.destroy()
    this.httpSockets.clear()

    await startPromise?.catch(() => {})
    if (server) await closeHttpServer(server)
  }

  dispose(): Promise<void> {
    this.unsubPageClosed?.()
    this.unsubPageClosed = null
    return this.stop()
  }

  /** Called by the CDP lease manager when a guest emits a CDP event or detaches. */
  pushCdpEvent(event: { tabId: string, method: string, params: Record<string, unknown> }): void {
    this.broadcastEvent('cdp.event', event)
  }

  /** Called from Electron IPC `desktop:browser-use:tab-ready`. */
  handleRendererTabReady(payload: BrowserUseTabReadyPayload): void {
    const pending = this.pendingEnsureTabs.get(payload.requestId)
    if (!pending) return
    this.pendingEnsureTabs.delete(payload.requestId)
    clearTimeout(pending.timer)
    pending.resolve(payload)
  }

  /** Called from Electron IPC `desktop:browser-use:cursor-arrived`. */
  handleRendererCursorArrived(payload: BrowserUseCursorArrivedPayload): void {
    const pending = this.pendingCursorMoves.get(payload.moveId)
    if (!pending) return
    this.pendingCursorMoves.delete(payload.moveId)
    clearTimeout(pending.timer)
    pending.cleanupAbort?.()
    pending.resolve({
      moveId: payload.moveId,
      arrived: true,
      skipped: Boolean(payload.skipped),
    })
  }

  /** Called from Electron IPC `desktop:browser-use:user-action`. */
  handleRendererUserAction(payload: BrowserUseUserActionPayload): void {
    if (payload.action === 'takeover' || payload.action === 'stop' || payload.action === 'cancel') {
      this.activeControlTabs.delete(payload.tabId)
      void this.workspaceBrowser.setAgentControlActive(payload.tabId, false).catch(() => {})
    }
    this.broadcastEvent('ui.takeover', {
      tabId: payload.tabId,
      action: payload.action,
      ...(payload.reason ? { reason: payload.reason } : {}),
    })
  }

  /**
   * Waits for the renderer virtual cursor animation to arrive, bounded by
   * `Math.min(durationMs + 250, 750)ms` and optional `AbortSignal` so hidden,
   * minimized, or frozen renderers can never deadlock CDP input.
   */
  waitForCursorArrival(
    moveId: string,
    durationMs?: number,
    signal?: AbortSignal,
  ): Promise<{ moveId: string, arrived: boolean, skipped: boolean }> {
    if (signal?.aborted || !this.isRendererVisible()) {
      return Promise.resolve({ moveId, arrived: false, skipped: true })
    }
    const ceilingMs = computeCursorWaitCeilingMs(durationMs)
    return new Promise(resolve => {
      let settled = false
      const settle = (result: { moveId: string, arrived: boolean, skipped: boolean }) => {
        if (settled) return
        settled = true
        this.pendingCursorMoves.delete(moveId)
        clearTimeout(timer)
        cleanupAbort?.()
        resolve(result)
      }
      const onAbort = () => settle({ moveId, arrived: false, skipped: true })
      const cleanupAbort = signal
        ? () => signal.removeEventListener('abort', onAbort)
        : undefined
      signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => settle({ moveId, arrived: false, skipped: true }), ceilingMs)
      timer.unref?.()
      this.pendingCursorMoves.set(moveId, { resolve: settle, timer, cleanupAbort })
    })
  }

  private async startOnce(generation: number): Promise<string> {
    const server = http.createServer((request, response) => {
      void this.handleHttpRequest(request, response)
    })
    server.on('upgrade', (request, socket, head) => {
      this.handleWsUpgrade(request, socket, head)
    })
    server.on('clientError', (_error, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    })
    server.on('connection', socket => {
      this.httpSockets.add(socket)
      socket.once('close', () => this.httpSockets.delete(socket))
    })
    this.server = server

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, BROWSER_BRIDGE_HOST, () => {
          server.off('error', reject)
          resolve()
        })
      })
    } catch (error) {
      if (this.server === server) this.server = null
      throw error
    }
    if (generation !== this.lifecycleGeneration || this.server !== server) {
      await closeHttpServer(server)
      throw new Error('Browser bridge startup was stopped')
    }
    const address = server.address()
    if (!address || typeof address === 'string') {
      if (this.server === server) this.server = null
      await closeHttpServer(server)
      throw new Error('Could not resolve browser bridge port')
    }
    this.bridgeUrl = `http://${BROWSER_BRIDGE_HOST}:${address.port}`
    return this.bridgeUrl
  }

  private checkRequestAuth(request: http.IncomingMessage): { status: number, message: string } | null {
    if (!isLoopbackRemoteAddress(request.socket.remoteAddress)) {
      return { status: 403, message: 'Forbidden: loopback clients only' }
    }
    if (request.headers.origin !== undefined) {
      return { status: 403, message: 'Forbidden: Origin header not permitted' }
    }
    if (!verifyBearerToken(request.headers.authorization, this.token)) {
      return { status: 401, message: 'Unauthorized' }
    }
    return null
  }

  private async handleHttpRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const authError = this.checkRequestAuth(request)
    if (authError) {
      writeJson(response, authError.status, { error: authError.message })
      return
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/health') {
      writeJson(response, 200, { ok: true })
      return
    }

    if (request.method !== 'POST' || url.pathname !== '/rpc') {
      writeJson(response, 404, { error: 'Not Found' })
      return
    }

    let rpc: RpcRequest
    try {
      const body = await readBody(request, MAX_HTTP_BODY_BYTES)
      const parsed = JSON.parse(body.toString('utf8')) as unknown
      if (!isPlainRecord(parsed) || typeof parsed.method !== 'string') {
        writeJson(response, 400, { error: { code: 'INVALID_REQUEST', message: 'Invalid JSON-RPC request' } })
        return
      }
      rpc = {
        id: typeof parsed.id === 'string' || typeof parsed.id === 'number' ? parsed.id : undefined,
        method: parsed.method,
        params: isPlainRecord(parsed.params) ? parsed.params : undefined,
      }
    } catch (error) {
      writeJson(response, 400, {
        error: {
          code: 'PARSE_ERROR',
          message: error instanceof Error ? error.message : 'Failed to parse request body',
        },
      })
      return
    }

    const noopContext: RpcClientContext = {
      trackLease: () => {},
      untrackLease: () => {},
      markControlledTab: () => {},
    }
    try {
      const result = await this.dispatchRpc(rpc.method, rpc.params ?? {}, noopContext)
      writeJson(response, 200, { ...(rpc.id !== undefined ? { id: rpc.id } : {}), result })
    } catch (error) {
      writeJson(response, 200, {
        ...(rpc.id !== undefined ? { id: rpc.id } : {}),
        error: {
          code: classifyRpcError(error),
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  private handleWsUpgrade(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const authError = this.checkRequestAuth(request)
    if (authError) {
      rejectUpgrade(socket, authError.status, authError.message)
      return
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/ws' && url.pathname !== '/') {
      rejectUpgrade(socket, 404, 'Not Found')
      return
    }

    const upgrade = String(request.headers.upgrade ?? '').toLowerCase()
    const key = request.headers['sec-websocket-key']
    const version = request.headers['sec-websocket-version']
    if (upgrade !== 'websocket' || typeof key !== 'string' || !key.trim() || version !== '13') {
      rejectUpgrade(socket, 400, 'Bad WebSocket Upgrade Request')
      return
    }

    const acceptKey = createHash('sha1').update(`${key.trim()}${WS_MAGIC_GUID}`).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${acceptKey}\r\n`
      + '\r\n',
    )

    const leases = new Map<string, Set<string>>()
    const controlledTabs = new Set<string>()
    let closed = false
    const sendFrame = (opcode: number, payload: Buffer) => {
      if (closed || socket.destroyed || !socket.writable) return
      socket.write(encodeWsFrame(opcode, payload))
    }
    const client: WsClientConnection = {
      socket,
      leases,
      controlledTabs,
      sendJson: payload => {
        sendFrame(0x1, Buffer.from(JSON.stringify(payload), 'utf8'))
      },
      close: () => {
        if (closed) return
        closed = true
        try {
          if (!socket.destroyed && socket.writable) {
            socket.write(encodeWsFrame(0x8, Buffer.alloc(0)))
          }
        } catch {
          // Ignore write errors during close.
        }
        socket.destroy()
      },
    }
    this.wsClients.add(client)

    const clientContext: RpcClientContext = {
      trackLease: (tabId, leaseId) => {
        let set = leases.get(tabId)
        if (!set) {
          set = new Set()
          leases.set(tabId, set)
        }
        set.add(leaseId)
      },
      untrackLease: (tabId, leaseId) => {
        const set = leases.get(tabId)
        if (!set) return
        if (leaseId) set.delete(leaseId)
        else {
          const first = set.values().next()
          if (!first.done) set.delete(first.value)
        }
        if (set.size === 0) leases.delete(tabId)
      },
      markControlledTab: (tabId, active) => {
        if (active) controlledTabs.add(tabId)
        else controlledTabs.delete(tabId)
      },
    }

    const parser = createWsFrameParser({
      maxPayloadBytes: MAX_WS_PAYLOAD_BYTES,
      onText: text => {
        void this.handleWsTextMessage(client, clientContext, text)
      },
      onPing: payload => sendFrame(0xA, payload),
      onClose: () => {
        this.cleanupWsClient(client)
        client.close()
      },
      onError: () => {
        this.cleanupWsClient(client)
        client.close()
      },
    })

    const onDisconnect = () => {
      closed = true
      this.cleanupWsClient(client)
    }
    socket.on('data', chunk => parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    socket.once('close', onDisconnect)
    socket.once('end', onDisconnect)
    socket.once('error', onDisconnect)

    if (head.length > 0) {
      parser.push(head)
    }
  }

  private async handleWsTextMessage(
    client: WsClientConnection,
    context: RpcClientContext,
    text: string,
  ): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      client.sendJson({ error: { code: 'PARSE_ERROR', message: 'Invalid JSON message' } })
      return
    }
    if (!isPlainRecord(parsed) || typeof parsed.method !== 'string') {
      client.sendJson({
        ...(typeof parsed === 'object' && parsed !== null && 'id' in parsed ? { id: (parsed as Record<string, unknown>).id } : {}),
        error: { code: 'INVALID_REQUEST', message: 'Invalid JSON-RPC request' },
      })
      return
    }
    const id = typeof parsed.id === 'string' || typeof parsed.id === 'number' ? parsed.id : undefined
    const params = isPlainRecord(parsed.params) ? parsed.params : {}
    try {
      const result = await this.dispatchRpc(parsed.method, params, context)
      client.sendJson({ ...(id !== undefined ? { id } : {}), result })
    } catch (error) {
      client.sendJson({
        ...(id !== undefined ? { id } : {}),
        error: {
          code: classifyRpcError(error),
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  private cleanupWsClient(client: WsClientConnection): void {
    if (!this.wsClients.delete(client)) return
    const cdp = this.workspaceBrowser.getCdpManager()
    const tabsToReleaseControl = new Set<string>(client.controlledTabs)
    for (const [tabId, leaseIds] of client.leases.entries()) {
      tabsToReleaseControl.add(tabId)
      for (const leaseId of leaseIds) {
        cdp.release(tabId, leaseId)
      }
    }
    client.leases.clear()
    client.controlledTabs.clear()
    if (this.wsClients.size === 0) {
      for (const tabId of this.activeControlTabs) {
        tabsToReleaseControl.add(tabId)
      }
    }
    for (const tabId of tabsToReleaseControl) {
      const wasActive = this.activeControlTabs.delete(tabId)
      void this.workspaceBrowser.setAgentControlActive(tabId, false).catch(() => {})
      if (wasActive) {
        this.emitToRenderer({ type: 'control-state', tabId, state: 'idle' })
      }
    }
  }

  private broadcastEvent(event: string, params: Record<string, unknown>): void {
    for (const client of this.wsClients) {
      client.sendJson({ event, params })
    }
  }

  private async dispatchRpc(
    method: string,
    params: Record<string, unknown>,
    context: RpcClientContext,
  ): Promise<unknown> {
    switch (method) {
      case 'tabs.list': {
        const sessionId = typeof params.sessionId === 'string' && params.sessionId.trim()
          ? params.sessionId.trim()
          : undefined
        return { tabs: this.workspaceBrowser.listPages(sessionId ? { sessionId } : undefined) }
      }

      case 'tabs.ensure':
        return await this.rpcTabsEnsure(params)

      case 'tabs.focus': {
        const tabId = requireStringParam(params, 'tabId')
        const sessionId = typeof params.sessionId === 'string' && params.sessionId.trim()
          ? params.sessionId.trim()
          : undefined
        const existing = this.workspaceBrowser.getPageInfo(tabId)
        if (!existing) {
          throw new Error(`workspace browser tab not open: ${tabId}`)
        }
        if (sessionId && existing.sessionId && existing.sessionId !== sessionId) {
          throw new Error(`workspace browser tab belongs to another session: ${tabId}`)
        }
        this.emitToRenderer({
          type: 'focus-tab',
          tabId,
          ...(sessionId ? { sessionId } : {}),
          ...(typeof params.revealWorkbench === 'boolean' ? { revealWorkbench: params.revealWorkbench } : {}),
        })
        return { ok: true, tabId }
      }

      case 'tabs.close': {
        const tabId = requireStringParam(params, 'tabId')
        const sessionId = typeof params.sessionId === 'string' && params.sessionId.trim()
          ? params.sessionId.trim()
          : undefined
        const existing = this.workspaceBrowser.getPageInfo(tabId)
        if (sessionId && existing?.sessionId && existing.sessionId !== sessionId) {
          throw new Error(`workspace browser tab belongs to another session: ${tabId}`)
        }
        this.activeControlTabs.delete(tabId)
        this.workspaceBrowser.close(tabId)
        this.emitToRenderer({
          type: 'close-tab',
          tabId,
          ...(sessionId ? { sessionId } : {}),
        })
        return { ok: true, tabId }
      }

      case 'tabs.zoom': {
        const tabId = requireStringParam(params, 'tabId')
        return {
          tabId,
          zoomFactor: this.workspaceBrowser.getPageZoomFactor(tabId),
          appZoomFactor: this.workspaceBrowser.getAppZoomFactor(),
        }
      }

      case 'cdp.acquire': {
        const tabId = requireStringParam(params, 'tabId')
        const handle = this.workspaceBrowser.getCdpManager().acquire(tabId)
        context.trackLease(tabId, handle.leaseId)
        return {
          leaseId: handle.leaseId,
          tabId,
          zoomFactor: this.workspaceBrowser.getPageZoomFactor(tabId),
          appZoomFactor: this.workspaceBrowser.getAppZoomFactor(),
        }
      }

      case 'cdp.release': {
        const tabId = requireStringParam(params, 'tabId')
        const leaseId = typeof params.leaseId === 'string' ? params.leaseId : undefined
        this.workspaceBrowser.getCdpManager().release(tabId, leaseId)
        context.untrackLease(tabId, leaseId)
        return { ok: true }
      }

      case 'cdp.send': {
        const tabId = requireStringParam(params, 'tabId')
        const cdpMethod = requireStringParam(params, 'method')
        const cdpParams = isPlainRecord(params.params) ? params.params : undefined
        const leaseId = typeof params.leaseId === 'string' ? params.leaseId : undefined
        return await this.workspaceBrowser.getCdpManager().sendCommand(
          tabId,
          cdpMethod,
          cdpParams,
          leaseId ? { leaseId } : undefined,
        )
      }

      case 'ui.controlState': {
        const tabId = requireStringParam(params, 'tabId')
        const state = params.state
        if (state !== 'idle' && state !== 'active' && state !== 'takeover') {
          throw new Error('ui.controlState requires state: idle | active | takeover')
        }
        const active = state === 'active'
        if (active) this.activeControlTabs.add(tabId)
        else this.activeControlTabs.delete(tabId)
        context.markControlledTab(tabId, active)
        if (this.workspaceBrowser.getPageInfo(tabId)) {
          await this.workspaceBrowser.setAgentControlActive(tabId, active).catch(() => {})
        }
        this.emitToRenderer({
          type: 'control-state',
          tabId,
          state,
          ...(typeof params.actionLabel === 'string' ? { actionLabel: params.actionLabel } : {}),
          ...(typeof params.takeoverReason === 'string' ? { takeoverReason: params.takeoverReason } : {}),
          ...(typeof params.sessionId === 'string' ? { sessionId: params.sessionId } : {}),
          ...(typeof params.showOverlay === 'boolean' ? { showOverlay: params.showOverlay } : {}),
          ...(typeof params.autoReveal === 'boolean' ? { autoReveal: params.autoReveal } : {}),
        })
        return { ok: true }
      }

      case 'ui.moveCursor': {
        const tabId = requireStringParam(params, 'tabId')
        const x = requireFiniteNumberParam(params, 'x')
        const y = requireFiniteNumberParam(params, 'y')
        const moveId = typeof params.moveId === 'string' && params.moveId.trim()
          ? params.moveId.trim()
          : `cursor-${randomUUID()}`
        const durationMs = typeof params.durationMs === 'number' && Number.isFinite(params.durationMs) && params.durationMs >= 0
          ? params.durationMs
          : DEFAULT_CURSOR_DURATION_MS
        const targetRect = parseCursorRect(params.targetRect)
        const waitPromise = this.waitForCursorArrival(moveId, durationMs)
        const delivered = this.emitToRenderer({
          type: 'move-cursor',
          tabId,
          moveId,
          x,
          y,
          durationMs,
          ...(targetRect ? { targetRect } : {}),
          ...(typeof params.label === 'string' ? { label: params.label } : {}),
        })
        if (!delivered) {
          this.handleRendererCursorArrived({ moveId, tabId, skipped: true })
          return { moveId, arrived: false, skipped: true }
        }
        return await waitPromise
      }

      case 'ui.clickRipple': {
        const tabId = requireStringParam(params, 'tabId')
        const x = requireFiniteNumberParam(params, 'x')
        const y = requireFiniteNumberParam(params, 'y')
        const button = params.button === 'left' || params.button === 'right' || params.button === 'middle'
          ? params.button
          : undefined
        this.emitToRenderer({
          type: 'click-ripple',
          tabId,
          x,
          y,
          ...(button ? { button } : {}),
        })
        return { ok: true }
      }

      default:
        throw new Error(`Unknown browser bridge RPC method: ${method}`)
    }
  }

  private async rpcTabsEnsure(params: Record<string, unknown>): Promise<BrowserUseBridgeTabInfo> {
    const sessionId = typeof params.sessionId === 'string' && params.sessionId.trim() ? params.sessionId.trim() : undefined
    const requestedTabId = typeof params.tabId === 'string' && params.tabId.trim() ? params.tabId.trim() : undefined
    const url = typeof params.url === 'string' && params.url.trim() ? params.url.trim() : undefined
    const focus = typeof params.focus === 'boolean' ? params.focus : true
    const revealWorkbench = typeof params.revealWorkbench === 'boolean' ? params.revealWorkbench : true
    const createNew = params.createNew === true

    let safeRequestedTabId = !createNew ? requestedTabId : undefined
    if (safeRequestedTabId) {
      const existing = this.workspaceBrowser.getPageInfo(safeRequestedTabId)
      if (existing) {
        if (!sessionId || existing.sessionId === sessionId) {
          if (focus) {
            this.emitToRenderer({
              type: 'focus-tab',
              tabId: safeRequestedTabId,
              ...(sessionId ? { sessionId } : {}),
              revealWorkbench,
            })
          }
          return existing
        }
        // Never reuse a workspace tab owned by a different session; fall
        // through to the renderer without the foreign tabId so the caller's
        // own session workspace gets its tab.
        if (existing.sessionId && existing.sessionId !== sessionId) {
          safeRequestedTabId = undefined
        }
      }
    }

    const requestId = `ensure-${randomUUID()}`
    const readyPromise = new Promise<BrowserUseTabReadyPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingEnsureTabs.delete(requestId)
        reject(new Error(`Timed out waiting for workspace browser tab to become ready (${this.ensureTabTimeoutMs}ms)`))
      }, this.ensureTabTimeoutMs)
      timer.unref?.()
      this.pendingEnsureTabs.set(requestId, { resolve, reject, timer })
    })

    const delivered = this.emitToRenderer({
      type: 'ensure-tab',
      requestId,
      ...(sessionId ? { sessionId } : {}),
      ...(safeRequestedTabId ? { tabId: safeRequestedTabId } : {}),
      ...(url ? { url } : {}),
      focus,
      revealWorkbench,
      ...(createNew ? { createNew: true } : {}),
    })
    if (!delivered) {
      const pending = this.pendingEnsureTabs.get(requestId)
      if (pending) {
        this.pendingEnsureTabs.delete(requestId)
        clearTimeout(pending.timer)
      }
      throw new Error('Desktop renderer window is unavailable')
    }

    const response = await readyPromise
    if (!response.ok) {
      throw new Error(response.error || 'Renderer failed to prepare workspace browser tab')
    }
    const info = this.workspaceBrowser.getPageInfo(response.tabId)
    if (!info) {
      throw new Error(`Workspace browser tab was reported ready but is not registered: ${response.tabId}`)
    }
    return info
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing or invalid string parameter: ${key}`)
  }
  return value.trim()
}

function requireFiniteNumberParam(params: Record<string, unknown>, key: string): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Missing or invalid numeric parameter: ${key}`)
  }
  return value
}

function parseCursorRect(value: unknown): BrowserUseCursorRect | undefined {
  if (!isPlainRecord(value)) return undefined
  if (
    typeof value.x !== 'number' || !Number.isFinite(value.x)
    || typeof value.y !== 'number' || !Number.isFinite(value.y)
    || typeof value.width !== 'number' || !Number.isFinite(value.width)
    || typeof value.height !== 'number' || !Number.isFinite(value.height)
  ) {
    return undefined
  }
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

function classifyRpcError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('forbidden by Electron host policy') || message.includes('not allowlisted')) {
    return 'CDP_METHOD_FORBIDDEN'
  }
  if (message.includes('tab not open')) return 'TAB_NOT_FOUND'
  if (message.includes('Timed out')) return 'TIMEOUT'
  if (message.includes('Unknown browser bridge RPC method')) return 'METHOD_NOT_FOUND'
  return 'RPC_ERROR'
}

function writeJson(response: http.ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': encoded.byteLength,
    Connection: 'close',
  })
  response.end(encoded)
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const statusText = status === 401
    ? 'Unauthorized'
    : status === 403
      ? 'Forbidden'
      : status === 404
        ? 'Not Found'
        : 'Bad Request'
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + `Content-Length: ${Buffer.byteLength(message)}\r\n`
    + '\r\n'
    + message,
  )
}

async function readBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, total)
}

function closeHttpServer(server: http.Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  server.closeAllConnections()
  return new Promise(resolve => server.close(() => resolve()))
}

function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.allocUnsafe(2)
    header[0] = 0x80 | (opcode & 0x0f)
    header[1] = length
  } else if (length < 65_536) {
    header = Buffer.allocUnsafe(4)
    header[0] = 0x80 | (opcode & 0x0f)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[0] = 0x80 | (opcode & 0x0f)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

function createWsFrameParser(handlers: {
  maxPayloadBytes: number
  onText: (text: string) => void
  onPing: (payload: Buffer) => void
  onClose: () => void
  onError: (error: Error) => void
}) {
  let buffer: Buffer = Buffer.alloc(0)
  let fragmentedOpcode: number | null = null
  let fragments: Buffer[] = []
  let fragmentedBytes = 0

  return {
    push(chunk: Buffer) {
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk])
      while (buffer.length >= 2) {
        const first = buffer[0]!
        const second = buffer[1]!
        const fin = (first & 0x80) !== 0
        const opcode = first & 0x0f
        const masked = (second & 0x80) !== 0
        let payloadLength = second & 0x7f
        let offset = 2

        if (payloadLength === 126) {
          if (buffer.length < 4) return
          payloadLength = buffer.readUInt16BE(2)
          offset = 4
        } else if (payloadLength === 127) {
          if (buffer.length < 10) return
          const bigLen = buffer.readBigUInt64BE(2)
          if (bigLen > BigInt(handlers.maxPayloadBytes)) {
            handlers.onError(new Error('WebSocket frame too large'))
            return
          }
          payloadLength = Number(bigLen)
          offset = 10
        }

        if (payloadLength > handlers.maxPayloadBytes) {
          handlers.onError(new Error('WebSocket frame too large'))
          return
        }

        const maskSize = masked ? 4 : 0
        const frameEnd = offset + maskSize + payloadLength
        if (buffer.length < frameEnd) return

        let payload = buffer.subarray(offset + maskSize, frameEnd)
        if (masked) {
          const mask = buffer.subarray(offset, offset + 4)
          const unmasked = Buffer.allocUnsafe(payloadLength)
          for (let i = 0; i < payloadLength; i++) {
            unmasked[i] = payload[i]! ^ mask[i & 3]!
          }
          payload = unmasked
        } else {
          payload = Buffer.from(payload)
        }
        buffer = buffer.subarray(frameEnd)

        if (opcode === 0x8) {
          handlers.onClose()
          return
        }
        if (opcode === 0x9) {
          handlers.onPing(payload)
          continue
        }
        if (opcode === 0xA) {
          continue
        }

        if (opcode === 0x1 || opcode === 0x2) {
          if (fin) {
            if (opcode === 0x1) handlers.onText(payload.toString('utf8'))
          } else {
            fragmentedOpcode = opcode
            fragments = [payload]
            fragmentedBytes = payload.length
          }
          continue
        }

        if (opcode === 0x0 && fragmentedOpcode !== null) {
          fragmentedBytes += payload.length
          if (fragmentedBytes > handlers.maxPayloadBytes) {
            handlers.onError(new Error('WebSocket fragmented message too large'))
            return
          }
          fragments.push(payload)
          if (fin) {
            const combined = Buffer.concat(fragments, fragmentedBytes)
            const op = fragmentedOpcode
            fragmentedOpcode = null
            fragments = []
            fragmentedBytes = 0
            if (op === 0x1) handlers.onText(combined.toString('utf8'))
          }
          continue
        }
      }
    },
  }
}
