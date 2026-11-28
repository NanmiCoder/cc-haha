import { randomUUID } from 'node:crypto'

export type WorkspaceBrowserDebuggerLike = {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>
  on?(event: 'detach', listener: (event: unknown, reason: string) => void): unknown
  on?(event: 'message', listener: (event: unknown, method: string, params: Record<string, unknown>) => void): unknown
  off?(event: 'detach', listener: (event: unknown, reason: string) => void): unknown
  off?(event: 'message', listener: (event: unknown, method: string, params: Record<string, unknown>) => void): unknown
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
}

export type WorkspaceBrowserCdpWebContentsLike = {
  debugger?: WorkspaceBrowserDebuggerLike
  isDestroyed?(): boolean
  on?(event: 'render-process-gone', listener: (event: unknown, details: { reason: string }) => void): unknown
  on?(event: 'destroyed', listener: () => void): unknown
  off?(event: 'render-process-gone', listener: (event: unknown, details: { reason: string }) => void): unknown
  off?(event: 'destroyed', listener: () => void): unknown
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown
}

export type CdpEventNotice = {
  tabId: string
  method: string
  params: Record<string, unknown>
}

export type CdpDetachNotice = {
  tabId: string
  reason: string
}

export type DebuggerLeaseManagerOptions = {
  resolveWebContents: (tabId: string) => WorkspaceBrowserCdpWebContentsLike | null
  idleGraceMs?: number
  /**
   * Maximum time (ms) a held lease may sit without any CDP command before the
   * host detaches the debugger to prevent orphaned `Network.enable`/`Runtime.enable`
   * streams from keeping a background guest active indefinitely. `0` disables.
   */
  leaseInactivityTimeoutMs?: number
  onEvent?: (event: CdpEventNotice) => void
  onDetached?: (event: CdpDetachNotice) => void
}

export type DebuggerLeaseHandle = {
  leaseId: string
  tabId: string
}

const DEFAULT_IDLE_GRACE_MS = 2_000
const DEFAULT_LEASE_INACTIVITY_TIMEOUT_MS = 5 * 60_000

const HARD_DENIED_CDP_PREFIXES = [
  'Browser.',
  'Target.',
  'Storage.',
  'Security.',
] as const

const HARD_DENIED_CDP_METHODS: ReadonlySet<string> = new Set([
  'Target.exposeDevToolsProtocol',
  'Storage.getCookies',
  'Network.getAllCookies',
  'Network.getCookies',
  'Network.setCookie',
  'Network.setCookies',
  'Network.deleteCookies',
  'Network.clearBrowserCookies',
  'Security.setIgnoreCertificateErrors',
  'Page.setDownloadBehavior',
  'DOM.setFileInputFiles',
])

/**
 * Defense-in-depth Electron main-process CDP allowlist.
 * Even an authenticated local server caller can only invoke bounded page
 * inspection, navigation, and input primitives — never cookie theft,
 * certificate bypass, download redirection, file-input exfiltration, or
 * browser-wide DevTools protocol exposure.
 */
export const ALLOWED_CDP_METHODS: ReadonlySet<string> = new Set([
  'Accessibility.enable',
  'Accessibility.getFullAXTree',
  'DOM.enable',
  'DOM.getDocument',
  'DOM.describeNode',
  'DOM.resolveNode',
  'DOM.getContentQuads',
  'DOM.getBoxModel',
  'DOM.getNodeForLocation',
  'DOM.focus',
  'DOM.scrollIntoViewIfNeeded',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'DOM.getAttributes',
  'DOM.getOuterHTML',
  'DOM.requestChildNodes',
  'DOM.getFrameOwner',
  'Page.enable',
  'Page.navigate',
  'Page.reload',
  'Page.getNavigationHistory',
  'Page.navigateToHistoryEntry',
  'Page.stopLoading',
  'Page.bringToFront',
  'Page.captureScreenshot',
  'Page.getLayoutMetrics',
  'Page.handleJavaScriptDialog',
  'Page.getFrameTree',
  'Page.createIsolatedWorld',
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.removeScriptToEvaluateOnNewDocument',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Emulation.setDeviceMetricsOverride',
  'Emulation.clearDeviceMetricsOverride',
  'Runtime.enable',
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Runtime.getProperties',
  'Runtime.releaseObject',
  'Runtime.releaseObjectGroup',
  'Log.enable',
  'Log.clear',
  'Network.enable',
  'Network.disable',
])

export function isHardDeniedCdpMethod(method: string): boolean {
  if (HARD_DENIED_CDP_METHODS.has(method)) return true
  return HARD_DENIED_CDP_PREFIXES.some(prefix => method.startsWith(prefix))
}

export function isAllowedCdpMethod(method: string): boolean {
  if (!method || typeof method !== 'string') return false
  if (isHardDeniedCdpMethod(method)) return false
  return ALLOWED_CDP_METHODS.has(method)
}

export function assertAllowedCdpMethod(method: string): void {
  if (typeof method !== 'string' || !method.trim()) {
    throw new Error('CDP method must be a non-empty string')
  }
  if (isHardDeniedCdpMethod(method)) {
    throw new Error(`CDP method is forbidden by Electron host policy: ${method}`)
  }
  if (!ALLOWED_CDP_METHODS.has(method)) {
    throw new Error(`CDP method is not allowlisted by Electron host: ${method}`)
  }
}

type PendingCommand = {
  reject: (error: Error) => void
}

type TabDebuggerEntry = {
  tabId: string
  webContents: WorkspaceBrowserCdpWebContentsLike
  debuggerApi: WorkspaceBrowserDebuggerLike
  leases: Set<string>
  idleTimer: ReturnType<typeof setTimeout> | null
  inactivityTimer: ReturnType<typeof setTimeout> | null
  inFlight: Set<PendingCommand>
  cleanupListeners: () => void
}

function detachEventListener(
  emitter: {
    off?: (event: any, listener: any) => unknown
    removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown
  },
  event: string,
  listener: (...args: unknown[]) => void,
): void {
  if (typeof emitter.off === 'function') {
    emitter.off(event, listener)
  } else if (typeof emitter.removeListener === 'function') {
    emitter.removeListener(event, listener)
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reference-counted per-tab Electron `webContents.debugger` lease broker.
 *
 * Ensures multiple callers (e.g., Browser Use + full-page screenshot capture)
 * share a single debugger attachment without detaching underneath one another,
 * rejects in-flight commands cleanly on unexpected detach or renderer crash,
 * and enforces the main-process CDP allowlist.
 */
export class DebuggerLeaseManager {
  private readonly resolveWebContents: (tabId: string) => WorkspaceBrowserCdpWebContentsLike | null
  private readonly idleGraceMs: number
  private readonly leaseInactivityTimeoutMs: number
  private readonly onEvent?: (event: CdpEventNotice) => void
  private readonly onDetached?: (event: CdpDetachNotice) => void
  private readonly entries = new Map<string, TabDebuggerEntry>()

  constructor(options: DebuggerLeaseManagerOptions) {
    this.resolveWebContents = options.resolveWebContents
    this.idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS
    this.leaseInactivityTimeoutMs = options.leaseInactivityTimeoutMs ?? DEFAULT_LEASE_INACTIVITY_TIMEOUT_MS
    this.onEvent = options.onEvent
    this.onDetached = options.onDetached
  }

  acquire(tabId: string): DebuggerLeaseHandle {
    const entry = this.ensureEntry(tabId)
    this.cancelIdleTimer(entry)
    this.ensureAttached(entry)
    const leaseId = `cdp-lease-${randomUUID()}`
    entry.leases.add(leaseId)
    this.resetInactivityTimer(entry)
    return { leaseId, tabId }
  }

  release(tabId: string, leaseId?: string): void {
    const entry = this.entries.get(tabId)
    if (!entry) return
    if (leaseId) {
      entry.leases.delete(leaseId)
    } else {
      const first = entry.leases.values().next()
      if (!first.done) entry.leases.delete(first.value)
    }
    if (entry.leases.size === 0) {
      this.cancelInactivityTimer(entry)
      this.scheduleIdleDetach(entry)
    }
  }

  getLeaseCount(tabId: string): number {
    return this.entries.get(tabId)?.leases.size ?? 0
  }

  isAttached(tabId: string): boolean {
    const entry = this.entries.get(tabId)
    if (!entry || entry.webContents.isDestroyed?.()) return false
    return entry.debuggerApi.isAttached()
  }

  async sendCommand(
    tabId: string,
    method: string,
    params?: Record<string, unknown>,
    options?: { leaseId?: string },
  ): Promise<unknown> {
    assertAllowedCdpMethod(method)

    const existing = this.entries.get(tabId)
    const hasActiveLease = options?.leaseId
      ? Boolean(existing?.leases.has(options.leaseId))
      : Boolean(existing && existing.leases.size > 0)

    let temporaryLeaseId: string | null = null
    if (!hasActiveLease) {
      const acquired = this.acquire(tabId)
      temporaryLeaseId = acquired.leaseId
    }

    try {
      const entry = this.ensureEntry(tabId)
      this.cancelIdleTimer(entry)
      this.cancelInactivityTimer(entry)
      this.ensureAttached(entry)

      return await this.runTrackedCommand(entry, method, params)
    } finally {
      if (temporaryLeaseId) {
        this.release(tabId, temporaryLeaseId)
      } else {
        const current = this.entries.get(tabId)
        if (current) this.resetInactivityTimer(current)
      }
    }
  }

  async withLease<T>(
    tabId: string,
    operation: (
      send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
    ) => Promise<T>,
  ): Promise<T> {
    const lease = this.acquire(tabId)
    try {
      return await operation((method, params) =>
        this.sendCommand(tabId, method, params, { leaseId: lease.leaseId }))
    } finally {
      this.release(tabId, lease.leaseId)
    }
  }

  handleTabClosed(tabId: string, reason = 'closed'): void {
    const entry = this.entries.get(tabId)
    if (!entry) return
    this.entries.delete(tabId)
    this.cancelIdleTimer(entry)
    this.cancelInactivityTimer(entry)
    entry.leases.clear()
    this.rejectInFlight(entry, new Error(`CDP target closed on tab ${tabId}: ${reason}`))
    entry.cleanupListeners()
    this.safeDetach(entry)
  }

  disposeAll(): void {
    for (const tabId of [...this.entries.keys()]) {
      this.handleTabClosed(tabId, 'disposed')
    }
  }

  private ensureEntry(tabId: string): TabDebuggerEntry {
    const webContents = this.resolveWebContents(tabId)
    if (!webContents || webContents.isDestroyed?.()) {
      this.handleTabClosed(tabId, 'destroyed')
      throw new Error(`workspace browser tab not open: ${tabId}`)
    }
    const debuggerApi = webContents.debugger
    if (!debuggerApi) {
      throw new Error(`CDP debugger unavailable for tab ${tabId}`)
    }

    const existing = this.entries.get(tabId)
    if (existing && existing.webContents === webContents && existing.debuggerApi === debuggerApi) {
      return existing
    }
    if (existing) {
      this.handleTabClosed(tabId, 'replaced')
    }

    const onDebuggerDetach = (_event: unknown, reason: string) => {
      const current = this.entries.get(tabId)
      if (!current || current !== entry) return
      const detail = typeof reason === 'string' && reason ? reason : 'detached'
      this.rejectInFlight(current, new Error(`CDP debugger detached on tab ${tabId}: ${detail}`))
      this.onDetached?.({ tabId, reason: detail })
      this.onEvent?.({ tabId, method: 'Inspector.detached', params: { reason: detail } })
    }

    const onDebuggerMessage = (
      _event: unknown,
      method: string,
      params: Record<string, unknown>,
    ) => {
      const current = this.entries.get(tabId)
      if (!current || current !== entry) return
      if (typeof method !== 'string' || !method) return
      this.onEvent?.({
        tabId,
        method,
        params: isPlainRecord(params) ? params : {},
      })
    }

    const onRenderProcessGone = (_event: unknown, details: { reason?: string }) => {
      const current = this.entries.get(tabId)
      if (!current || current !== entry) return
      const reason = details?.reason || 'crashed'
      this.rejectInFlight(current, new Error(`Renderer process gone on tab ${tabId}: ${reason}`))
      this.onDetached?.({ tabId, reason: `render-process-gone:${reason}` })
      this.onEvent?.({ tabId, method: 'Inspector.detached', params: { reason: `render-process-gone:${reason}` } })
    }

    const onDestroyed = () => {
      const current = this.entries.get(tabId)
      if (!current || current !== entry) return
      this.handleTabClosed(tabId, 'destroyed')
    }

    debuggerApi.on?.('detach', onDebuggerDetach)
    debuggerApi.on?.('message', onDebuggerMessage)
    webContents.on?.('render-process-gone', onRenderProcessGone)
    webContents.on?.('destroyed', onDestroyed)

    const entry: TabDebuggerEntry = {
      tabId,
      webContents,
      debuggerApi,
      leases: new Set(),
      idleTimer: null,
      inactivityTimer: null,
      inFlight: new Set(),
      cleanupListeners: () => {
        detachEventListener(debuggerApi, 'detach', onDebuggerDetach as (...args: unknown[]) => void)
        detachEventListener(debuggerApi, 'message', onDebuggerMessage as (...args: unknown[]) => void)
        detachEventListener(webContents, 'render-process-gone', onRenderProcessGone as (...args: unknown[]) => void)
        detachEventListener(webContents, 'destroyed', onDestroyed)
      },
    }
    this.entries.set(tabId, entry)
    return entry
  }

  private ensureAttached(entry: TabDebuggerEntry): void {
    if (entry.webContents.isDestroyed?.()) {
      this.handleTabClosed(entry.tabId, 'destroyed')
      throw new Error(`workspace browser tab destroyed: ${entry.tabId}`)
    }
    if (!entry.debuggerApi.isAttached()) {
      entry.debuggerApi.attach('1.3')
    }
  }

  private runTrackedCommand(
    entry: TabDebuggerEntry,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    let pending!: PendingCommand
    const abortPromise = new Promise<never>((_resolve, reject) => {
      pending = { reject }
      entry.inFlight.add(pending)
    })
    const commandPromise = Promise.resolve().then(() =>
      params === undefined
        ? entry.debuggerApi.sendCommand(method)
        : entry.debuggerApi.sendCommand(method, params))
    // Avoid unhandled rejection if the command settles after abortPromise wins.
    void commandPromise.catch(() => undefined)
    return Promise.race([commandPromise, abortPromise]).finally(() => {
      entry.inFlight.delete(pending)
    })
  }

  private rejectInFlight(entry: TabDebuggerEntry, error: Error): void {
    for (const pending of [...entry.inFlight]) {
      entry.inFlight.delete(pending)
      pending.reject(error)
    }
  }

  private cancelIdleTimer(entry: TabDebuggerEntry): void {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
  }

  private cancelInactivityTimer(entry: TabDebuggerEntry): void {
    if (entry.inactivityTimer !== null) {
      clearTimeout(entry.inactivityTimer)
      entry.inactivityTimer = null
    }
  }

  private resetInactivityTimer(entry: TabDebuggerEntry): void {
    this.cancelInactivityTimer(entry)
    if (this.leaseInactivityTimeoutMs <= 0) return
    if (entry.leases.size === 0 || entry.inFlight.size > 0) return
    entry.inactivityTimer = setTimeout(() => {
      entry.inactivityTimer = null
      if (this.entries.get(entry.tabId) !== entry) return
      if (entry.leases.size === 0 || entry.inFlight.size > 0) return
      this.entries.delete(entry.tabId)
      this.cancelIdleTimer(entry)
      entry.leases.clear()
      entry.cleanupListeners()
      this.safeDetach(entry)
      this.onDetached?.({ tabId: entry.tabId, reason: 'idle-timeout' })
      this.onEvent?.({ tabId: entry.tabId, method: 'Inspector.detached', params: { reason: 'idle-timeout' } })
    }, this.leaseInactivityTimeoutMs)
    entry.inactivityTimer.unref?.()
  }

  private scheduleIdleDetach(entry: TabDebuggerEntry): void {
    this.cancelIdleTimer(entry)
    const detachNow = () => {
      entry.idleTimer = null
      if (this.entries.get(entry.tabId) !== entry) return
      if (entry.leases.size > 0 || entry.inFlight.size > 0) return
      this.entries.delete(entry.tabId)
      entry.cleanupListeners()
      this.safeDetach(entry)
    }
    if (this.idleGraceMs <= 0) {
      detachNow()
      return
    }
    entry.idleTimer = setTimeout(detachNow, this.idleGraceMs)
    entry.idleTimer.unref?.()
  }

  private safeDetach(entry: TabDebuggerEntry): void {
    if (entry.webContents.isDestroyed?.()) return
    try {
      if (entry.debuggerApi.isAttached()) {
        entry.debuggerApi.detach()
      }
    } catch {
      // Guest may close concurrently while detaching.
    }
  }
}
