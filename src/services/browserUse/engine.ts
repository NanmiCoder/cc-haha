import { randomUUID } from 'node:crypto'
import { InPageCursorController } from './inPageCursor'
import {
  BrowserNavigationGuard,
  maskSensitiveValueForUi,
  redactSensitiveHeaders,
  wrapUntrustedBrowserContent,
} from './security'
import {
  SnapshotRefStore,
  capturePageSnapshot,
  getTopFrameIdentity,
} from './snapshot'
import type {
  BrowserActOptions,
  BrowserActResult,
  BrowserActStepResult,
  BrowserBoundingBox,
  BrowserConsoleEntry,
  BrowserControlState,
  BrowserDialogState,
  BrowserInspectOptions,
  BrowserInspectResult,
  BrowserModifierKey,
  BrowserMouseButton,
  BrowserNavigateOptions,
  BrowserNavigateResult,
  BrowserNetworkEntry,
  BrowserRefEntry,
  BrowserSnapshotOptions,
  BrowserSnapshotResult,
  BrowserTabInfo,
  BrowserTakeoverReason,
  BrowserTakeoverRequestOptions,
  BrowserTakeoverState,
  BrowserUiHooks,
  BrowserUseActivityEvent,
  CdpTransport,
  ComputedCoordinates,
  FlatActionStep,
  ViewportCoordinateMetrics,
} from './types'

const MAX_ACT_STEPS = 10
const MAX_WAIT_MS = 30_000
const RING_BUFFER_LIMIT = 200
const DEFAULT_INSPECT_MAX_CHARS = 24_000

/**
 * Exact coordinate transformation shared between Electron `<webview>` overlay
 * (`xSlot`, `ySlot`) and CDP `Input.dispatchMouseEvent` DIPs (`xDispatch`, `yDispatch`).
 *
 * - `x_vv = (x_css - offsetX) * visualViewportScale`
 * - `y_vv = (y_css - offsetY) * visualViewportScale`
 * - `x_slot = x_vv * (zoomFactor / appZoomFactor)`
 * - `y_slot = y_vv * (zoomFactor / appZoomFactor)`
 * - `x_dispatch = x_vv * zoomFactor`
 * - `y_dispatch = y_vv * zoomFactor`
 */
export function computeViewportCoordinates(
  metrics: ViewportCoordinateMetrics,
): ComputedCoordinates {
  const scale =
    Number.isFinite(metrics.visualViewportScale) &&
    metrics.visualViewportScale > 0
      ? metrics.visualViewportScale
      : 1
  const zoom =
    Number.isFinite(metrics.zoomFactor) && metrics.zoomFactor > 0
      ? metrics.zoomFactor
      : 1
  const appZoom =
    Number.isFinite(metrics.appZoomFactor) && metrics.appZoomFactor > 0
      ? metrics.appZoomFactor
      : 1

  const xVv = (metrics.xCss - metrics.offsetX) * scale
  const yVv = (metrics.yCss - metrics.offsetY) * scale
  const slotRatio = zoom / appZoom

  return {
    xVv,
    yVv,
    xSlot: xVv * slotRatio,
    ySlot: yVv * slotRatio,
    xDispatch: xVv * zoom,
    yDispatch: yVv * zoom,
  }
}

interface KeyDescriptor {
  key: string
  code: string
  windowsVirtualKeyCode: number
  text?: string
}

const SPECIAL_KEY_MAP: Record<string, KeyDescriptor> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: {
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39,
  },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
}

function modifiersToBitmask(modifiers?: BrowserModifierKey[]): number {
  let mask = 0
  for (const mod of modifiers ?? []) {
    if (mod === 'Alt') mask |= 1
    else if (mod === 'Control') mask |= 2
    else if (mod === 'Meta') mask |= 4
    else if (mod === 'Shift') mask |= 8
  }
  return mask
}

function parseKeyChord(
  rawKey: string,
  extraModifiers?: BrowserModifierKey[],
): { descriptor: KeyDescriptor; modifiers: number } {
  const parts = rawKey
    .split('+')
    .map(p => p.trim())
    .filter(Boolean)
  const mods: BrowserModifierKey[] = [...(extraModifiers ?? [])]
  let mainKey = rawKey

  if (parts.length > 1) {
    mainKey = parts[parts.length - 1]!
    for (const part of parts.slice(0, -1)) {
      const lower = part.toLowerCase()
      if (lower === 'alt' || lower === 'option') mods.push('Alt')
      else if (lower === 'ctrl' || lower === 'control') mods.push('Control')
      else if (lower === 'meta' || lower === 'cmd' || lower === 'command') {
        mods.push('Meta')
      } else if (lower === 'shift') mods.push('Shift')
    }
  }

  const special = SPECIAL_KEY_MAP[mainKey]
  if (special) {
    return { descriptor: special, modifiers: modifiersToBitmask(mods) }
  }

  const upper = mainKey.length === 1 ? mainKey.toUpperCase() : mainKey
  const code =
    mainKey.length === 1 && /[a-z]/i.test(mainKey)
      ? `Key${upper}`
      : mainKey.length === 1 && /[0-9]/.test(mainKey)
        ? `Digit${mainKey}`
        : mainKey
  const keyCode = mainKey.length === 1 ? upper.charCodeAt(0) : 0
  return {
    descriptor: {
      key: mainKey,
      code,
      windowsVirtualKeyCode: keyCode,
      ...(mainKey.length === 1 && mods.length === 0 ? { text: mainKey } : {}),
    },
    modifiers: modifiersToBitmask(mods),
  }
}

export interface SensitiveGuardrailMatch {
  reason: BrowserTakeoverReason
  message: string
}

const CAPTCHA_PATTERN = /captcha|recaptcha|hcaptcha|turnstile|verify you are human|人机验证|滑动验证|图形验证码/i
const PAYMENT_PATTERN = /\b(pay now|place order|confirm payment|checkout|credit card|cvv|card number|buy now)\b|立即支付|确认付款|提交订单|银行卡号|安全码/i
const AUTH_TWO_FACTOR_PATTERN = /\b(two[- ]?factor|2fa|otp|verification code|authenticator|sign in|log in|password)\b|两步验证|双重验证|验证码|登录密码/i

/**
 * Guardrail detector that recommends a clean human takeover before interacting
 * with CAPTCHAs, payment submission buttons, or sensitive authentication walls.
 */
export function detectSensitiveActionGuardrail(
  step: FlatActionStep,
  ref: BrowserRefEntry | undefined,
  url: string,
  pageTitle: string,
): SensitiveGuardrailMatch | null {
  const combinedTarget = [
    step.label ?? '',
    ref?.humanLabel ?? '',
    ref?.name ?? '',
    ref?.hint ?? '',
  ].join(' ')
  const combinedPage = `${url} ${pageTitle}`

  if (CAPTCHA_PATTERN.test(combinedTarget) || CAPTCHA_PATTERN.test(combinedPage)) {
    return {
      reason: 'captcha',
      message: 'CAPTCHA or human verification detected — please complete it manually.',
    }
  }

  if (
    (step.action === 'click' || step.action === 'dblclick') &&
    PAYMENT_PATTERN.test(combinedTarget)
  ) {
    return {
      reason: 'payment',
      message: `Payment or purchase confirmation ("${ref?.humanLabel || step.label || 'checkout'}") requires your approval.`,
    }
  }

  if (
    ref?.isPassword ||
    step.sensitive ||
    (AUTH_TWO_FACTOR_PATTERN.test(combinedTarget) &&
      (step.action === 'fill' || step.action === 'type'))
  ) {
    return {
      reason: ref?.isPassword ? 'login' : 'two_factor',
      message: 'Authentication or password input requires your confirmation.',
    }
  }

  return null
}

interface PendingInputWaiter {
  settleWithDialog: (dialog: BrowserDialogState) => void
  rejectWithError: (err: Error) => void
}

interface TabRuntimeState {
  info: BrowserTabInfo
  queue: Promise<void>
  consoleLogs: BrowserConsoleEntry[]
  networkLogs: BrowserNetworkEntry[]
  networkByRequestId: Map<string, BrowserNetworkEntry>
  dialog: BrowserDialogState | null
  pendingInputs: Set<PendingInputWaiter>
  mouseDown: {
    x: number
    y: number
    button: BrowserMouseButton
  } | null
  lastCursorPos: { x: number; y: number }
  inPageCursor?: InPageCursorController
  domainsEnabled: boolean
}

export interface ResolvedRefTarget {
  entry: BrowserRefEntry
  objectId: string
  xCss: number
  yCss: number
  boxCss: BrowserBoundingBox
  coords: ComputedCoordinates
  targetBoxSlot: BrowserBoundingBox
}

export interface BrowserUseEngineOptions {
  transport: CdpTransport
  navigationGuard?: BrowserNavigationGuard
  blockedLoopbackPorts?: number[]
  uiHooks?: BrowserUiHooks
  refStore?: SnapshotRefStore
  noInPageOverlay?: boolean
  defaultTabId?: string
}

export class BrowserUseEngine {
  readonly transport: CdpTransport
  readonly navigationGuard: BrowserNavigationGuard
  readonly refStore: SnapshotRefStore

  private readonly uiHooks?: BrowserUiHooks
  private noInPageOverlay: boolean
  private readonly tabs = new Map<string, TabRuntimeState>()
  private activeTabId: string | null = null
  private readonly tabControlStates = new Map<string, BrowserControlState>()
  private readonly activeTakeovers = new Map<string, BrowserTakeoverState>()
  private readonly unsubscribeEvent: () => void

  constructor(options: BrowserUseEngineOptions) {
    this.transport = options.transport
    this.navigationGuard =
      options.navigationGuard ??
      new BrowserNavigationGuard({
        blockedLoopbackPorts: options.blockedLoopbackPorts,
      })
    this.uiHooks = options.uiHooks
    this.refStore = options.refStore ?? new SnapshotRefStore()
    this.noInPageOverlay = options.noInPageOverlay === true

    if (options.defaultTabId) {
      this.registerTab({
        tabId: options.defaultTabId,
        target: this.transport.kind,
        url: 'about:blank',
        title: '',
        active: true,
      })
    }

    this.unsubscribeEvent = this.transport.onEvent(
      (method, params, sessionId) => {
        this.handleCdpEvent(method, params, sessionId)
      },
    )
  }

  dispose(): void {
    this.unsubscribeEvent()
    for (const tab of this.tabs.values()) {
      void tab.inPageCursor?.teardown()
    }
    this.tabs.clear()
    this.tabControlStates.clear()
    this.activeTakeovers.clear()
  }

  getControlState(tabId?: string): BrowserControlState {
    if (tabId) {
      if (this.activeTakeovers.get(tabId)?.status === 'pending') return 'takeover'
      return this.tabControlStates.get(tabId) ?? 'idle'
    }
    for (const takeover of this.activeTakeovers.values()) {
      if (takeover.status === 'pending') return 'takeover'
    }
    for (const state of this.tabControlStates.values()) {
      if (state === 'active') return 'active'
    }
    return 'idle'
  }

  getActiveTakeover(filter?: {
    tabId?: string
    sessionId?: string
    takeoverId?: string
  }): BrowserTakeoverState | null {
    if (filter?.tabId) {
      const candidate = this.activeTakeovers.get(filter.tabId)
      if (!candidate) return null
      if (filter.takeoverId && candidate.takeoverId !== filter.takeoverId) return null
      if (filter.sessionId && candidate.sessionId && candidate.sessionId !== filter.sessionId) return null
      return { ...candidate }
    }
    const entries = [...this.activeTakeovers.values()]
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i]!
      if (filter?.takeoverId && candidate.takeoverId !== filter.takeoverId) continue
      if (filter?.sessionId && candidate.sessionId && candidate.sessionId !== filter.sessionId) continue
      return { ...candidate }
    }
    return null
  }

  getActiveTakeovers(): BrowserTakeoverState[] {
    return [...this.activeTakeovers.values()].map(takeover => ({ ...takeover }))
  }

  resetTabDomains(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (tab) {
      tab.domainsEnabled = false
    }
  }

  setNoInPageOverlay(noOverlay: boolean): void {
    this.noInPageOverlay = noOverlay === true
    for (const tab of this.tabs.values()) {
      tab.inPageCursor?.setNoOverlay(this.noInPageOverlay)
    }
  }

  registerTab(info: BrowserTabInfo): BrowserTabInfo {
    const existing = this.tabs.get(info.tabId)
    if (existing) {
      const prevSessionId = existing.info.cdpSessionId
      existing.info = { ...existing.info, ...info }
      if (info.cdpSessionId && info.cdpSessionId !== prevSessionId) {
        existing.domainsEnabled = false
        void existing.inPageCursor?.teardown()
        if (existing.info.target === 'chrome') {
          existing.inPageCursor = new InPageCursorController({
            transport: this.transport,
            sessionId: info.cdpSessionId,
            noOverlay: this.noInPageOverlay,
          })
        }
      }
      if (info.active) {
        this.setActiveTab(info.tabId)
      }
      return { ...existing.info }
    }

    const runtime: TabRuntimeState = {
      info: {
        ...info,
        createdAt: info.createdAt ?? Date.now(),
      },
      queue: Promise.resolve(),
      consoleLogs: [],
      networkLogs: [],
      networkByRequestId: new Map(),
      dialog: null,
      pendingInputs: new Set(),
      mouseDown: null,
      lastCursorPos: { x: 0, y: 0 },
      domainsEnabled: false,
      ...(info.target === 'chrome'
        ? {
            inPageCursor: new InPageCursorController({
              transport: this.transport,
              sessionId: info.cdpSessionId,
              noOverlay: this.noInPageOverlay,
            }),
          }
        : {}),
    }

    this.tabs.set(info.tabId, runtime)
    if (info.active || !this.activeTabId) {
      this.setActiveTab(info.tabId)
    }
    return { ...runtime.info }
  }

  unregisterTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (tab) {
      void tab.inPageCursor?.teardown()
      this.tabs.delete(tabId)
      this.refStore.invalidateTab(tabId)
    }
    this.tabControlStates.delete(tabId)
    this.activeTakeovers.delete(tabId)
    if (this.activeTabId === tabId) {
      const next = this.tabs.keys().next().value
      this.activeTabId = next ?? null
      if (next) {
        const nextTab = this.tabs.get(next)
        if (nextTab) nextTab.info.active = true
      }
    }
  }

  setActiveTab(tabId: string): BrowserTabInfo | null {
    const target = this.tabs.get(tabId)
    if (!target) {
      return null
    }
    for (const tab of this.tabs.values()) {
      tab.info.active = tab.info.tabId === tabId
    }
    this.activeTabId = tabId
    return { ...target.info }
  }

  listTabs(): BrowserTabInfo[] {
    return [...this.tabs.values()].map(t => ({ ...t.info }))
  }

  getTab(tabId?: string): BrowserTabInfo | null {
    const resolvedId = tabId ?? this.activeTabId
    if (!resolvedId) {
      return null
    }
    const found = this.tabs.get(resolvedId)
    return found ? { ...found.info } : null
  }

  pinTab(tabId: string, pinned = true): boolean {
    const tab = this.tabs.get(tabId)
    if (!tab) return false
    tab.info.pinned = pinned
    return true
  }

  private requireTab(tabId?: string): TabRuntimeState {
    const id = tabId ?? this.activeTabId
    if (!id) {
      const fallback = this.registerTab({
        tabId: 'default',
        target: this.transport.kind,
        url: 'about:blank',
        title: '',
        active: true,
      })
      return this.tabs.get(fallback.tabId)!
    }
    const existing = this.tabs.get(id)
    if (existing) {
      return existing
    }
    this.registerTab({
      tabId: id,
      target: this.transport.kind,
      url: 'about:blank',
      title: '',
      active: !this.activeTabId,
    })
    return this.tabs.get(id)!
  }

  /**
   * Per-tab FIFO serial queue ensuring concurrent commands against the same
   * tab never interleave input/DOM/navigation state.
   */
  private enqueueTabOperation<T>(
    tab: TabRuntimeState,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = tab.queue
    let release!: () => void
    tab.queue = new Promise<void>(resolve => {
      release = resolve
    })

    return previous.then(async () => {
      try {
        return await operation()
      } finally {
        release()
      }
    })
  }

  private async ensureDomainsEnabled(tab: TabRuntimeState): Promise<void> {
    if (tab.domainsEnabled) {
      return
    }
    const sessionId = tab.info.cdpSessionId
    await Promise.allSettled([
      this.transport.send('Page.enable', undefined, { sessionId, timeoutMs: 3_000 }),
      this.transport.send('DOM.enable', undefined, { sessionId, timeoutMs: 3_000 }),
      this.transport.send('Runtime.enable', undefined, { sessionId, timeoutMs: 3_000 }),
      this.transport.send('Network.enable', undefined, { sessionId, timeoutMs: 3_000 }),
      this.transport.send('Log.enable', undefined, { sessionId, timeoutMs: 3_000 }),
    ])
    tab.domainsEnabled = true
  }

  private assertNoPendingTakeover(tabId: string): void {
    const pending = this.activeTakeovers.get(tabId)
    if (pending && pending.status === 'pending') {
      throw new Error(
        `Browser tab "${tabId}" is paused for user takeover (${pending.reason}): ${pending.message}. Resume or abort takeover before continuing.`,
      )
    }
  }

  private createNavigationWaiter(
    tab: TabRuntimeState,
    waitEvent: 'Page.loadEventFired' | 'Page.domContentEventFired',
    timeoutMs: number,
    signal?: AbortSignal,
  ): { promise: Promise<void>; cancel: () => void } {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined
    let onAbort: (() => void) | undefined

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = undefined
      }
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort)
        onAbort = undefined
      }
    }

    let resolveFn!: () => void
    let rejectFn!: (err: Error) => void

    const promise = new Promise<void>((resolve, reject) => {
      resolveFn = resolve
      rejectFn = reject

      if (signal?.aborted) {
        settled = true
        reject(new Error('Navigation aborted'))
        return
      }

      const expectedSessionId = tab.info.cdpSessionId
      unsubscribe = this.transport.onEvent((method, _params, eventSessionId) => {
        if (settled) return
        if (expectedSessionId) {
          if (eventSessionId !== expectedSessionId) return
        } else if (eventSessionId) {
          return
        }
        if (method === waitEvent || method === 'Page.javascriptDialogOpening') {
          settled = true
          cleanup()
          resolve()
        }
      })

      if (signal) {
        onAbort = () => {
          if (settled) return
          settled = true
          cleanup()
          reject(new Error('Navigation aborted'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return
          settled = true
          cleanup()
          reject(
            new Error(
              `Timed out waiting for navigation (${waitEvent}) after ${timeoutMs}ms`,
            ),
          )
        }, timeoutMs)
      }
    })

    // Avoid unhandled rejection if caller cancels before awaiting
    void promise.catch(() => {})

    return {
      promise,
      cancel: () => {
        if (settled) return
        settled = true
        cleanup()
        resolveFn()
      },
    }
  }

  private isSameDocumentFragmentNavigation(
    previousUrl: string,
    nextUrl: URL,
  ): boolean {
    try {
      const prev = new URL(previousUrl)
      return (
        prev.origin === nextUrl.origin &&
        prev.pathname === nextUrl.pathname &&
        prev.search === nextUrl.search &&
        nextUrl.hash.length > 0
      )
    } catch {
      return false
    }
  }

  async navigate(options: BrowserNavigateOptions): Promise<BrowserNavigateResult> {
    const tab = this.requireTab(options.tabId)
    return this.enqueueTabOperation(tab, async () => {
      this.assertNoPendingTakeover(tab.info.tabId)
      await this.ensureDomainsEnabled(tab)
      const action = options.action ?? 'goto'
      const waitUntil = options.waitUntil ?? 'domcontentloaded'
      const timeoutMs = options.timeoutMs ?? 20_000
      const waitEvent =
        waitUntil === 'load'
          ? 'Page.loadEventFired'
          : waitUntil === 'domcontentloaded'
            ? 'Page.domContentEventFired'
            : null
      const sessionId = tab.info.cdpSessionId

      if (action === 'goto') {
        if (!options.url) {
          throw new Error('navigate action "goto" requires a url')
        }
        const validated = this.navigationGuard.assertAllowed(options.url)
        this.emitActivity({
          tabId: tab.info.tabId,
          target: tab.info.target,
          sessionId: options.sessionId,
          agentId: options.agentId,
          kind: 'navigate',
          action: 'goto',
          humanLabel: `正在打开 ${validated.hostname || validated.href}`,
          url: validated.href,
          status: 'running',
        })

        await this.updateControlState(tab, 'active', {
          sessionId: options.sessionId,
          agentId: options.agentId,
          label: `正在打开 ${validated.hostname || validated.href}`,
        })

        const previousUrl = tab.info.url
        const waiter = waitEvent
          ? this.createNavigationWaiter(tab, waitEvent, timeoutMs, options.signal)
          : null

        try {
          const navRes = await this.transport.send<{
            frameId?: string
            loaderId?: string
            errorText?: string
          }>(
            'Page.navigate',
            { url: validated.href },
            {
              sessionId,
              signal: options.signal,
              timeoutMs,
            },
          )
          if (navRes.errorText) {
            throw new Error(`Navigation failed: ${navRes.errorText}`)
          }
          const isSameDocHash =
            !navRes.loaderId &&
            this.isSameDocumentFragmentNavigation(previousUrl, validated)
          if (waiter) {
            if (isSameDocHash) {
              waiter.cancel()
            } else {
              await waiter.promise
            }
          }
        } catch (err) {
          waiter?.cancel()
          throw err
        }

        this.refStore.invalidateTab(tab.info.tabId)
        tab.info.url = validated.href
      } else if (action === 'reload') {
        const waiter = waitEvent
          ? this.createNavigationWaiter(tab, waitEvent, timeoutMs, options.signal)
          : null
        try {
          await this.transport.send(
            'Page.reload',
            {},
            { sessionId, signal: options.signal, timeoutMs },
          )
          if (waiter) {
            await waiter.promise
          }
        } catch (err) {
          waiter?.cancel()
          throw err
        }
        this.refStore.invalidateTab(tab.info.tabId)
      } else if (action === 'back' || action === 'forward') {
        const hist = await this.transport.send<{
          currentIndex?: number
          entries?: Array<{ id: number; url: string }>
        }>('Page.getNavigationHistory', undefined, { sessionId, signal: options.signal })
        const idx = hist.currentIndex ?? 0
        const targetIdx = action === 'back' ? idx - 1 : idx + 1
        const entry = hist.entries?.[targetIdx]
        if (!entry) {
          throw new Error(`No ${action} navigation history entry available`)
        }
        this.navigationGuard.assertAllowed(entry.url)
        const waiter = waitEvent
          ? this.createNavigationWaiter(tab, waitEvent, timeoutMs, options.signal)
          : null
        try {
          await this.transport.send(
            'Page.navigateToHistoryEntry',
            { entryId: entry.id },
            { sessionId, signal: options.signal, timeoutMs },
          )
          if (waiter) {
            await waiter.promise
          }
        } catch (err) {
          waiter?.cancel()
          throw err
        }
        this.refStore.invalidateTab(tab.info.tabId)
        tab.info.url = entry.url
      }

      const frame = await getTopFrameIdentity(
        this.transport,
        sessionId,
        options.signal,
      ).catch(() => ({
        frameId: 'main',
        loaderId: 'unknown',
        url: tab.info.url,
      }))
      const titleRes = await this.transport
        .send<{ result?: { value?: string } }>(
          'Runtime.evaluate',
          { expression: 'document.title || ""', returnByValue: true },
          { sessionId, signal: options.signal, timeoutMs: 3_000 },
        )
        .catch(() => ({ result: { value: tab.info.title } }))

      if (frame.url && frame.url !== 'about:blank') {
        tab.info.url = frame.url
      }
      tab.info.title =
        typeof titleRes.result?.value === 'string'
          ? titleRes.result.value
          : tab.info.title

      this.emitActivity({
        tabId: tab.info.tabId,
        target: tab.info.target,
        sessionId: options.sessionId,
        agentId: options.agentId,
        kind: 'navigate',
        action,
        humanLabel: `已打开 ${tab.info.title || tab.info.url}`,
        url: tab.info.url,
        title: tab.info.title,
        status: 'completed',
      })

      return {
        tabId: tab.info.tabId,
        target: tab.info.target,
        url: tab.info.url,
        title: tab.info.title,
        frameId: frame.frameId,
        loaderId: frame.loaderId,
        ...(tab.dialog ? { dialog: { ...tab.dialog } } : {}),
      }
    })
  }

  async snapshot(
    options: BrowserSnapshotOptions = {},
  ): Promise<BrowserSnapshotResult> {
    const tab = this.requireTab(options.tabId)
    return this.enqueueTabOperation(tab, async () => {
      await this.ensureDomainsEnabled(tab)
      const result = await capturePageSnapshot({
        transport: this.transport,
        tabId: tab.info.tabId,
        target: tab.info.target,
        cdpSessionId: tab.info.cdpSessionId,
        refStore: this.refStore,
        options,
        beforeScreenshot: async () => {
          await tab.inPageCursor?.setHidden(true)
        },
        afterScreenshot: async () => {
          await tab.inPageCursor?.setHidden(false)
        },
      })

      tab.info.url = result.url
      tab.info.title = result.title

      this.emitActivity({
        tabId: tab.info.tabId,
        target: tab.info.target,
        sessionId: options.sessionId,
        agentId: options.agentId,
        kind: 'snapshot',
        action: 'snapshot',
        humanLabel: `已读取页面结构（${result.refCount} 个可交互元素）`,
        url: result.url,
        title: result.title,
        status: 'completed',
        ...(result.screenshotDataUrl
          ? { screenshotDataUrl: result.screenshotDataUrl }
          : {}),
      })

      return {
        ...result,
        ...(tab.dialog ? { dialog: { ...tab.dialog } } : {}),
      }
    })
  }

  /**
   * Resolves a `@eN` ref to verified viewport, overlay, and CDP dispatch coordinates.
   * Performs:
   * 1. Frame/loaderId staleness check
   * 2. `DOM.resolveNode`
   * 3. Scroll into view + rAF settle
   * 4. `DOM.getContentQuads` + `Page.getLayoutMetrics`
   * 5. `computeViewportCoordinates` (`x_vv`, `x_slot`, `x_dispatch`)
   * 6. `DOM.getNodeForLocation` hit-test verification
   */
  async resolveRef(
    tabId: string,
    refId: string,
    signal?: AbortSignal,
  ): Promise<ResolvedRefTarget> {
    const tab = this.requireTab(tabId)
    const sessionId = tab.info.cdpSessionId
    const frame = await getTopFrameIdentity(this.transport, sessionId, signal)
    const entry = this.refStore.getRef(
      tab.info.tabId,
      refId,
      undefined,
      frame.loaderId,
    )
    if (!entry) {
      throw new Error(
        `Stale or unknown ref "${refId}" for tab "${tab.info.tabId}" (current loaderId=${frame.loaderId}). Capture a fresh snapshot first.`,
      )
    }

    const resolved = await this.transport.send<{
      object?: { objectId?: string }
    }>(
      'DOM.resolveNode',
      { backendNodeId: entry.backendNodeId },
      { sessionId, signal, timeoutMs: 5_000 },
    )
    const objectId = resolved.object?.objectId
    if (!objectId) {
      throw new Error(
        `Element "${entry.humanLabel}" (${refId}) is no longer attached to the DOM.`,
      )
    }

    // Scroll into view
    try {
      await this.transport.send(
        'DOM.scrollIntoViewIfNeeded',
        { backendNodeId: entry.backendNodeId },
        { sessionId, signal, timeoutMs: 3_000 },
      )
    } catch {
      await this.transport
        .send(
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration:
              'function() { this.scrollIntoView && this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); }',
            returnByValue: true,
          },
          { sessionId, signal, timeoutMs: 3_000 },
        )
        .catch(() => {})
    }

    // Wait 2 rAF ticks for layout/scroll settle
    await this.transport
      .send(
        'Runtime.evaluate',
        {
          expression:
            'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))',
          awaitPromise: true,
          returnByValue: true,
        },
        { sessionId, signal, timeoutMs: 1_000 },
      )
      .catch(() => {})

    const [quadsRes, metricsRes, zoomFactors] = await Promise.all([
      this.transport.send<{ quads?: number[][] }>(
        'DOM.getContentQuads',
        { backendNodeId: entry.backendNodeId },
        { sessionId, signal, timeoutMs: 3_000 },
      ),
      this.transport.send<{
        cssVisualViewport?: {
          pageX?: number
          pageY?: number
          offsetX?: number
          offsetY?: number
          scale?: number
        }
        visualViewport?: {
          pageX?: number
          pageY?: number
          offsetX?: number
          offsetY?: number
          scale?: number
        }
      }>('Page.getLayoutMetrics', undefined, {
        sessionId,
        signal,
        timeoutMs: 3_000,
      }),
      this.uiHooks?.getZoomFactors
        ? this.uiHooks.getZoomFactors(tab.info.tabId)
        : Promise.resolve({ pageZoomFactor: 1, appZoomFactor: 1 }),
    ])

    const quad = quadsRes.quads?.[0]
    if (!quad || quad.length < 8) {
      throw new Error(
        `Element "${entry.humanLabel}" (${refId}) has no visible layout geometry.`,
      )
    }

    const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!]
    const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!]
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)
    const width = Math.max(1, maxX - minX)
    const height = Math.max(1, maxY - minY)
    const xCss = minX + width / 2
    const yCss = minY + height / 2

    const vv = metricsRes.cssVisualViewport ?? metricsRes.visualViewport ?? {}
    // DOM.getContentQuads returns viewport-relative CSS coordinates (already scroll-adjusted),
    // so only pinch-zoom visual viewport offsetX/offsetY apply here (NEVER vv.pageX/pageY!).
    const offsetX = vv.offsetX ?? 0
    const offsetY = vv.offsetY ?? 0
    const pageX = vv.pageX ?? 0
    const pageY = vv.pageY ?? 0
    const visualViewportScale = vv.scale ?? 1

    const coords = computeViewportCoordinates({
      xCss,
      yCss,
      offsetX,
      offsetY,
      visualViewportScale,
      zoomFactor: zoomFactors.pageZoomFactor,
      appZoomFactor: zoomFactors.appZoomFactor,
    })

    const topLeft = computeViewportCoordinates({
      xCss: minX,
      yCss: minY,
      offsetX,
      offsetY,
      visualViewportScale,
      zoomFactor: zoomFactors.pageZoomFactor,
      appZoomFactor: zoomFactors.appZoomFactor,
    })
    const bottomRight = computeViewportCoordinates({
      xCss: maxX,
      yCss: maxY,
      offsetX,
      offsetY,
      visualViewportScale,
      zoomFactor: zoomFactors.pageZoomFactor,
      appZoomFactor: zoomFactors.appZoomFactor,
    })

    // Hit-test verification via DOM.getNodeForLocation (expects document/page coordinates!)
    await this.verifyHitTest(
      tab,
      entry,
      objectId,
      xCss + pageX,
      yCss + pageY,
      signal,
    )

    return {
      entry,
      objectId,
      xCss,
      yCss,
      boxCss: { x: minX, y: minY, width, height },
      coords,
      targetBoxSlot: {
        x: topLeft.xSlot,
        y: topLeft.ySlot,
        width: Math.max(1, bottomRight.xSlot - topLeft.xSlot),
        height: Math.max(1, bottomRight.ySlot - topLeft.ySlot),
      },
    }
  }

  private async verifyHitTest(
    tab: TabRuntimeState,
    entry: BrowserRefEntry,
    targetObjectId: string,
    xCss: number,
    yCss: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const sessionId = tab.info.cdpSessionId
    let hitRes: { backendNodeId?: number }
    try {
      hitRes = await this.transport.send<{ backendNodeId?: number }>(
        'DOM.getNodeForLocation',
        {
          x: Math.round(xCss),
          y: Math.round(yCss),
          includeUserAgentShadowDOM: true,
        },
        { sessionId, signal, timeoutMs: 2_000 },
      )
    } catch {
      // If transport/browser doesn't support getNodeForLocation, don't block
      return
    }

    const hitId = hitRes.backendNodeId
    if (!hitId || hitId === entry.backendNodeId) {
      return
    }

    // Check if hit node is a child or ancestor (e.g. <span> inside <button>, or <label>)
    try {
      const hitResolved = await this.transport.send<{
        object?: { objectId?: string }
      }>(
        'DOM.resolveNode',
        { backendNodeId: hitId },
        { sessionId, signal, timeoutMs: 2_000 },
      )
      const hitObjId = hitResolved.object?.objectId
      if (!hitObjId) {
        return
      }
      const related = await this.transport.send<{
        result?: { value?: boolean }
      }>(
        'Runtime.callFunctionOn',
        {
          objectId: targetObjectId,
          arguments: [{ objectId: hitObjId }],
          functionDeclaration:
            'function(hit) { return Boolean(this === hit || (this.contains && this.contains(hit)) || (hit && hit.contains && hit.contains(this))); }',
          returnByValue: true,
        },
        { sessionId, signal, timeoutMs: 2_000 },
      )
      if (related.result?.value === false) {
        throw new Error(
          `Element "${entry.humanLabel}" (${entry.refId}) is obscured by another element at (${Math.round(xCss)}, ${Math.round(yCss)}). Capture a fresh snapshot or dismiss any covering modal first.`,
        )
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('is obscured by')) {
        throw err
      }
    }
  }

  /**
   * Executes a micro-batch of 1–10 flat action steps serially on a tab.
   * Stops immediately on error, navigation, JS dialog, takeover, sensitive gate, or abort.
   */
  async act(options: BrowserActOptions): Promise<BrowserActResult> {
    if (!Array.isArray(options.steps) || options.steps.length === 0) {
      throw new Error('act() requires between 1 and 10 action steps')
    }
    if (options.steps.length > MAX_ACT_STEPS) {
      throw new Error(
        `act() accepts at most ${MAX_ACT_STEPS} steps per batch (received ${options.steps.length})`,
      )
    }

    const tab = this.requireTab(options.tabId)
    return this.enqueueTabOperation(tab, async () => {
      this.assertNoPendingTakeover(tab.info.tabId)
      await this.ensureDomainsEnabled(tab)
      const sessionId = tab.info.cdpSessionId
      const results: BrowserActStepResult[] = []
      let stoppedReason: BrowserActResult['stoppedReason']
      let completedSteps = 0

      const startFrame = await getTopFrameIdentity(
        this.transport,
        sessionId,
        options.signal,
      ).catch(() => ({
        frameId: 'main',
        loaderId: 'initial',
        url: tab.info.url,
      }))
      let currentLoaderId = startFrame.loaderId

      try {
        for (let i = 0; i < options.steps.length; i++) {
          const step = options.steps[i]!

          if (options.signal?.aborted) {
            stoppedReason = 'aborted'
            break
          }

          if (this.activeTakeovers.get(tab.info.tabId)?.status === 'pending') {
            stoppedReason = 'takeover'
            break
          }

          if (tab.dialog && step.action !== 'dialog') {
            stoppedReason = 'dialog'
            break
          }

          const refEntry = step.ref
            ? this.refStore.getRef(tab.info.tabId, step.ref)
            : undefined
          const humanLabel = this.formatStepLabel(step, refEntry)

          // Sensitive action guardrail check
          if (options.autoTakeoverOnSensitive !== false) {
            const guardrail = detectSensitiveActionGuardrail(
              step,
              refEntry,
              tab.info.url,
              tab.info.title,
            )
            if (guardrail) {
              const takeover = await this.enterTakeoverState(tab, {
                tabId: tab.info.tabId,
                reason: guardrail.reason,
                message: guardrail.message,
                sessionId: options.sessionId,
                agentId: options.agentId,
              })
              results.push({
                index: i,
                action: step.action,
                ref: step.ref,
                humanLabel,
                status: 'stopped',
                takeover,
              })
              stoppedReason = 'sensitive_gate'
              break
            }
          }

          await this.updateControlState(tab, 'active', {
            sessionId: options.sessionId,
            agentId: options.agentId,
            label: humanLabel,
          })

          this.emitActivity({
            tabId: tab.info.tabId,
            target: tab.info.target,
            sessionId: options.sessionId,
            agentId: options.agentId,
            kind: 'act',
            action: step.action,
            humanLabel,
            ...(step.text !== undefined
              ? {
                  maskedValue: maskSensitiveValueForUi(
                    step.text,
                    Boolean(step.sensitive || refEntry?.isPassword),
                  ),
                }
              : {}),
            url: tab.info.url,
            title: tab.info.title,
            status: 'running',
          })

          try {
            const stepOutcome = await this.executeSingleStep(
              tab,
              step,
              humanLabel,
              options.signal,
            )

            if (stepOutcome.dialogOpened && tab.dialog) {
              results.push({
                index: i,
                action: step.action,
                ref: step.ref,
                humanLabel,
                status: 'stopped',
                dialog: { ...tab.dialog },
              })
              completedSteps += 1
              stoppedReason = 'dialog'
              break
            }

            // Check if navigation occurred after this step
            const postFrame = await getTopFrameIdentity(
              this.transport,
              sessionId,
              options.signal,
            ).catch(() => null)
            const navigationChanged = Boolean(
              postFrame && postFrame.loaderId !== currentLoaderId,
            )
            if (postFrame) {
              currentLoaderId = postFrame.loaderId
              if (postFrame.url && postFrame.url !== 'about:blank') {
                tab.info.url = postFrame.url
              }
            }

            completedSteps += 1
            results.push({
              index: i,
              action: step.action,
              ref: step.ref,
              humanLabel,
              status: 'ok',
              ...(navigationChanged ? { navigationChanged: true } : {}),
            })

            this.emitActivity({
              tabId: tab.info.tabId,
              target: tab.info.target,
              sessionId: options.sessionId,
              agentId: options.agentId,
              kind: 'act',
              action: step.action,
              humanLabel,
              url: tab.info.url,
              title: tab.info.title,
              status: 'completed',
            })

            if (navigationChanged && options.stopOnNavigation !== false) {
              this.refStore.invalidateTab(tab.info.tabId)
              if (i < options.steps.length - 1) {
                stoppedReason = 'navigation'
                break
              }
            }
          } catch (err) {
            await this.flushMouseRelease(tab)
            const message = err instanceof Error ? err.message : String(err)
            results.push({
              index: i,
              action: step.action,
              ref: step.ref,
              humanLabel,
              status: 'failed',
              error: message,
            })
            this.emitActivity({
              tabId: tab.info.tabId,
              target: tab.info.target,
              sessionId: options.sessionId,
              agentId: options.agentId,
              kind: 'error',
              action: step.action,
              humanLabel,
              status: 'failed',
              error: message,
            })
            stoppedReason = options.signal?.aborted ? 'aborted' : 'error'
            break
          }
        }
      } finally {
        await this.flushMouseRelease(tab)
      }

      const dialog = tab.dialog ? { ...tab.dialog } : undefined
      const wrappedDialog = dialog
        ? wrapUntrustedBrowserContent(
            JSON.stringify({
              type: dialog.type,
              message: dialog.message,
              ...(dialog.defaultPrompt !== undefined
                ? { defaultPrompt: dialog.defaultPrompt }
                : {}),
              ...(dialog.url ? { url: dialog.url } : {}),
            }),
            {
              source: 'browser_dialog',
              kind: 'javascript_dialog',
              tabId: tab.info.tabId,
              url: tab.info.url,
            },
          )
        : undefined

      return {
        tabId: tab.info.tabId,
        target: tab.info.target,
        completedSteps,
        totalSteps: options.steps.length,
        ...(stoppedReason ? { stoppedReason } : {}),
        results,
        url: tab.info.url,
        title: tab.info.title,
        ...(dialog ? { dialog, wrappedDialog } : {}),
        ...(this.activeTakeovers.has(tab.info.tabId)
          ? { takeover: { ...this.activeTakeovers.get(tab.info.tabId)! } }
          : {}),
      }
    })
  }

  private async executeSingleStep(
    tab: TabRuntimeState,
    step: FlatActionStep,
    humanLabel: string,
    signal?: AbortSignal,
  ): Promise<{ dialogOpened: boolean }> {
    const sessionId = tab.info.cdpSessionId

    switch (step.action) {
      case 'click':
      case 'dblclick': {
        if (!step.ref) {
          throw new Error(`${step.action} requires a target ref`)
        }
        const resolved = await this.resolveRef(tab.info.tabId, step.ref, signal)
        await this.moveVisualCursor(tab, resolved, step.action, humanLabel, signal)

        const button: BrowserMouseButton = step.button ?? 'left'
        const modifiers = modifiersToBitmask(step.modifiers)
        const clickCount = step.action === 'dblclick' ? 2 : 1

        const outcome = await this.runInterruptibleInput(tab, async () => {
          await this.transport.send(
            'Input.dispatchMouseEvent',
            {
              type: 'mouseMoved',
              x: resolved.coords.xDispatch,
              y: resolved.coords.yDispatch,
              modifiers,
            },
            { sessionId, signal },
          )
          for (let c = 1; c <= clickCount; c++) {
            tab.mouseDown = {
              x: resolved.coords.xDispatch,
              y: resolved.coords.yDispatch,
              button,
            }
            await this.transport.send(
              'Input.dispatchMouseEvent',
              {
                type: 'mousePressed',
                x: resolved.coords.xDispatch,
                y: resolved.coords.yDispatch,
                button,
                clickCount: c,
                modifiers,
              },
              { sessionId, signal },
            )
            await this.emitClickRipple(tab, resolved, step.action, humanLabel)
            await this.transport.send(
              'Input.dispatchMouseEvent',
              {
                type: 'mouseReleased',
                x: resolved.coords.xDispatch,
                y: resolved.coords.yDispatch,
                button,
                clickCount: c,
                modifiers,
              },
              { sessionId, signal },
            )
            tab.mouseDown = null
          }
        })
        return outcome
      }

      case 'hover': {
        if (!step.ref) {
          throw new Error('hover requires a target ref')
        }
        const resolved = await this.resolveRef(tab.info.tabId, step.ref, signal)
        await this.moveVisualCursor(tab, resolved, 'hover', humanLabel, signal)
        await this.transport.send(
          'Input.dispatchMouseEvent',
          {
            type: 'mouseMoved',
            x: resolved.coords.xDispatch,
            y: resolved.coords.yDispatch,
            modifiers: modifiersToBitmask(step.modifiers),
          },
          { sessionId, signal },
        )
        return { dialogOpened: Boolean(tab.dialog) }
      }

      case 'fill':
      case 'type': {
        const text = step.text ?? ''
        const resolved = step.ref
          ? await this.resolveRef(tab.info.tabId, step.ref, signal)
          : null
        if (resolved) {
          await this.moveVisualCursor(tab, resolved, step.action, humanLabel, signal)
        }

        // Route focus click + clear + Input.insertText through runInterruptibleInput
        // so an onfocus/onclick JS dialog settles cleanly and flushes mouseReleased.
        const outcome = await this.runInterruptibleInput(tab, async () => {
          if (resolved) {
            await this.transport
              .send(
                'DOM.focus',
                { backendNodeId: resolved.entry.backendNodeId },
                { sessionId, signal },
              )
              .catch(() => {})
            tab.mouseDown = {
              x: resolved.coords.xDispatch,
              y: resolved.coords.yDispatch,
              button: 'left',
            }
            await this.transport.send(
              'Input.dispatchMouseEvent',
              {
                type: 'mousePressed',
                x: resolved.coords.xDispatch,
                y: resolved.coords.yDispatch,
                button: 'left',
                clickCount: 1,
              },
              { sessionId, signal },
            )
            await this.transport.send(
              'Input.dispatchMouseEvent',
              {
                type: 'mouseReleased',
                x: resolved.coords.xDispatch,
                y: resolved.coords.yDispatch,
                button: 'left',
                clickCount: 1,
              },
              { sessionId, signal },
            )
            tab.mouseDown = null

            if (step.action === 'fill' && step.clear !== false) {
              await this.transport
                .send(
                  'Runtime.callFunctionOn',
                  {
                    objectId: resolved.objectId,
                    functionDeclaration: `function() {
                      if (typeof this.select === 'function') this.select();
                      if ('value' in this) {
                        this.value = '';
                        this.dispatchEvent(new Event('input', { bubbles: true }));
                      } else if (this.isContentEditable) {
                        this.textContent = '';
                      }
                    }`,
                    returnByValue: true,
                  },
                  { sessionId, signal },
                )
                .catch(() => {})
            }
          }

          // Use Input.insertText for printable text (Electron <webview> safe!)
          if (text.length > 0) {
            await this.transport.send(
              'Input.insertText',
              { text },
              { sessionId, signal },
            )
          }
          if (step.submit) {
            await this.dispatchSpecialKey(tab, 'Enter', undefined, signal)
          }
        })
        return outcome
      }

      case 'press': {
        if (!step.key) {
          throw new Error('press requires a key name')
        }
        if (step.ref) {
          const resolved = await this.resolveRef(tab.info.tabId, step.ref, signal)
          await this.transport
            .send(
              'DOM.focus',
              { backendNodeId: resolved.entry.backendNodeId },
              { sessionId, signal },
            )
            .catch(() => {})
        }
        return this.runInterruptibleInput(tab, async () => {
          await this.dispatchSpecialKey(tab, step.key!, step.modifiers, signal)
        })
      }

      case 'select': {
        if (!step.ref) {
          throw new Error('select requires a target ref')
        }
        const targetValue = step.value ?? step.text
        if (targetValue === undefined) {
          throw new Error('select requires a value')
        }
        const resolved = await this.resolveRef(tab.info.tabId, step.ref, signal)
        await this.moveVisualCursor(tab, resolved, 'select', humanLabel, signal)

        const res = await this.transport.send<{
          result?: { value?: { matched: boolean; selectedValue?: string } }
        }>(
          'Runtime.callFunctionOn',
          {
            objectId: resolved.objectId,
            arguments: [{ value: targetValue }],
            functionDeclaration: `function(val) {
              if (!this || this.tagName !== 'SELECT') {
                return { matched: false };
              }
              const opts = Array.from(this.options || []);
              const match = opts.find(o => o.value === val || o.text.trim() === val);
              if (!match) return { matched: false };
              this.value = match.value;
              this.dispatchEvent(new Event('input', { bubbles: true }));
              this.dispatchEvent(new Event('change', { bubbles: true }));
              return { matched: true, selectedValue: match.value };
            }`,
            returnByValue: true,
          },
          { sessionId, signal },
        )
        if (!res.result?.value?.matched) {
          throw new Error(
            `Option "${targetValue}" not found in select "${resolved.entry.humanLabel}"`,
          )
        }
        return { dialogOpened: Boolean(tab.dialog) }
      }

      case 'scroll': {
        let deltaX = step.deltaX ?? 0
        let deltaY = step.deltaY ?? 0
        if (step.direction) {
          const amount = step.amount ?? 480
          if (step.direction === 'down') deltaY = amount
          else if (step.direction === 'up') deltaY = -amount
          else if (step.direction === 'right') deltaX = amount
          else if (step.direction === 'left') deltaX = -amount
        } else if (deltaX === 0 && deltaY === 0) {
          deltaY = step.amount ?? 480
        }

        let x = 200
        let y = 200
        if (step.ref) {
          const resolved = await this.resolveRef(tab.info.tabId, step.ref, signal)
          await this.moveVisualCursor(tab, resolved, 'scroll', humanLabel, signal)
          x = resolved.coords.xDispatch
          y = resolved.coords.yDispatch
        }

        await this.transport.send(
          'Input.dispatchMouseEvent',
          {
            type: 'mouseWheel',
            x,
            y,
            deltaX,
            deltaY,
          },
          { sessionId, signal },
        )
        return { dialogOpened: Boolean(tab.dialog) }
      }

      case 'wait': {
        if (step.waitForText || step.waitForSelector) {
          const deadline =
            Date.now() + Math.min(Math.max(step.ms ?? 5_000, 100), MAX_WAIT_MS)
          while (Date.now() <= deadline) {
            if (signal?.aborted) {
              throw new Error('Wait aborted')
            }
            const expr = step.waitForSelector
              ? `Boolean(document.querySelector(${JSON.stringify(step.waitForSelector)}))`
              : `Boolean((document.body?.innerText || '').includes(${JSON.stringify(step.waitForText)}))`
            const check = await this.transport
              .send<{ result?: { value?: boolean } }>(
                'Runtime.evaluate',
                { expression: expr, returnByValue: true },
                { sessionId, signal, timeoutMs: 2_000 },
              )
              .catch(() => ({ result: { value: false } }))
            if (check.result?.value === true) {
              return { dialogOpened: Boolean(tab.dialog) }
            }
            await sleepWithAbort(100, signal)
          }
          throw new Error(
            `Timed out waiting for ${step.waitForSelector ? `selector "${step.waitForSelector}"` : `text "${step.waitForText}"`}`,
          )
        }

        const duration = Math.min(Math.max(step.ms ?? 500, 0), MAX_WAIT_MS)
        await sleepWithAbort(duration, signal)
        return { dialogOpened: Boolean(tab.dialog) }
      }

      case 'dialog': {
        const accept = step.accept !== false
        await this.transport.send(
          'Page.handleJavaScriptDialog',
          {
            accept,
            ...(step.promptText !== undefined
              ? { promptText: step.promptText }
              : {}),
          },
          { sessionId, signal },
        )
        tab.dialog = null
        return { dialogOpened: false }
      }
    }
  }

  private async dispatchSpecialKey(
    tab: TabRuntimeState,
    rawKey: string,
    extraModifiers?: BrowserModifierKey[],
    signal?: AbortSignal,
  ): Promise<void> {
    const { descriptor, modifiers } = parseKeyChord(rawKey, extraModifiers)
    const sessionId = tab.info.cdpSessionId
    await this.transport.send(
      'Input.dispatchKeyEvent',
      {
        type: 'rawKeyDown',
        key: descriptor.key,
        code: descriptor.code,
        windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
        nativeVirtualKeyCode: descriptor.windowsVirtualKeyCode,
        modifiers,
        ...(descriptor.text ? { text: descriptor.text } : {}),
      },
      { sessionId, signal },
    )
    if (descriptor.text) {
      await this.transport.send(
        'Input.dispatchKeyEvent',
        {
          type: 'char',
          key: descriptor.key,
          code: descriptor.code,
          text: descriptor.text,
          unmodifiedText: descriptor.text,
          modifiers,
        },
        { sessionId, signal },
      )
    }
    await this.transport.send(
      'Input.dispatchKeyEvent',
      {
        type: 'keyUp',
        key: descriptor.key,
        code: descriptor.code,
        windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
        nativeVirtualKeyCode: descriptor.windowsVirtualKeyCode,
        modifiers,
      },
      { sessionId, signal },
    )
  }

  /**
   * Runs a CDP input dispatch promise while registering a `pendingInputs` waiter
   * so `Page.javascriptDialogOpening` immediately settles the step without hanging.
   */
  private async runInterruptibleInput(
    tab: TabRuntimeState,
    fn: () => Promise<void>,
  ): Promise<{ dialogOpened: boolean }> {
    let waiter!: PendingInputWaiter
    const interruptPromise = new Promise<{ dialogOpened: boolean }>(
      (resolve, reject) => {
        waiter = {
          settleWithDialog: () => resolve({ dialogOpened: true }),
          rejectWithError: (err: Error) => reject(err),
        }
      },
    )
    tab.pendingInputs.add(waiter)

    const inputPromise = fn()
      .then(() => ({ dialogOpened: Boolean(tab.dialog) }))
      .finally(() => {
        tab.pendingInputs.delete(waiter)
      })

    try {
      const outcome = await Promise.race([inputPromise, interruptPromise])
      tab.pendingInputs.delete(waiter)
      if (outcome.dialogOpened) {
        // Suppress unhandled rejection if the underlying CDP input call later rejects
        void inputPromise.catch(() => {})
      }
      return outcome
    } catch (err) {
      tab.pendingInputs.delete(waiter)
      void inputPromise.catch(() => {})
      throw err
    }
  }

  private async flushMouseRelease(tab: TabRuntimeState): Promise<void> {
    if (!tab.mouseDown) {
      return
    }
    const down = tab.mouseDown
    tab.mouseDown = null
    await this.transport
      .send(
        'Input.dispatchMouseEvent',
        {
          type: 'mouseReleased',
          x: down.x,
          y: down.y,
          button: down.button,
          clickCount: 1,
        },
        { sessionId: tab.info.cdpSessionId, timeoutMs: 1_000 },
      )
      .catch(() => {})
  }

  async inspect(options: BrowserInspectOptions): Promise<BrowserInspectResult> {
    const tab = this.requireTab(options.tabId)
    return this.enqueueTabOperation(tab, async () => {
      await this.ensureDomainsEnabled(tab)
      const sessionId = tab.info.cdpSessionId
      const maxChars = options.maxChars ?? DEFAULT_INSPECT_MAX_CHARS
      const limit = Math.min(Math.max(options.limit ?? 50, 1), RING_BUFFER_LIMIT)

      let rawPayload = ''
      let itemCount: number | undefined

      switch (options.kind) {
        case 'console': {
          const items = tab.consoleLogs.slice(-limit)
          itemCount = items.length
          rawPayload = JSON.stringify(items, null, 2)
          break
        }
        case 'network': {
          const items = tab.networkLogs.slice(-limit).map(entry => ({
            ...entry,
            ...(entry.requestHeaders
              ? { requestHeaders: redactSensitiveHeaders(entry.requestHeaders) }
              : {}),
            ...(entry.responseHeaders
              ? {
                  responseHeaders: redactSensitiveHeaders(entry.responseHeaders),
                }
              : {}),
          }))
          itemCount = items.length
          rawPayload = JSON.stringify(items, null, 2)
          break
        }
        case 'text': {
          const expr = options.selector
            ? `(document.querySelector(${JSON.stringify(options.selector)})?.innerText || '')`
            : `(document.body?.innerText || '')`
          const res = await this.transport.send<{
            result?: { value?: string }
          }>(
            'Runtime.evaluate',
            { expression: expr, returnByValue: true },
            { sessionId, signal: options.signal, timeoutMs: 5_000 },
          )
          rawPayload =
            typeof res.result?.value === 'string' ? res.result.value : ''
          break
        }
        case 'html': {
          const expr = options.selector
            ? `(document.querySelector(${JSON.stringify(options.selector)})?.outerHTML || '')`
            : `(document.documentElement?.outerHTML || '')`
          const res = await this.transport.send<{
            result?: { value?: string }
          }>(
            'Runtime.evaluate',
            { expression: expr, returnByValue: true },
            { sessionId, signal: options.signal, timeoutMs: 5_000 },
          )
          rawPayload =
            typeof res.result?.value === 'string' ? res.result.value : ''
          break
        }
        case 'eval': {
          if (!options.expression?.trim()) {
            throw new Error('inspect kind "eval" requires an expression')
          }
          const res = await this.transport.send<{
            result?: { value?: unknown; description?: string }
            exceptionDetails?: { text?: string }
          }>(
            'Runtime.evaluate',
            {
              expression: options.expression,
              returnByValue: true,
              awaitPromise: true,
              timeout: 5_000,
            },
            { sessionId, signal: options.signal, timeoutMs: 8_000 },
          )
          if (res.exceptionDetails) {
            rawPayload = `Error: ${res.exceptionDetails.text ?? 'evaluation exception'}`
          } else if (res.result?.value !== undefined) {
            rawPayload =
              typeof res.result.value === 'string'
                ? res.result.value
                : JSON.stringify(res.result.value, null, 2)
          } else {
            rawPayload = res.result?.description ?? 'undefined'
          }
          break
        }
      }

      const wrappedContent = wrapUntrustedBrowserContent(rawPayload, {
        source: 'browser_inspect',
        kind: options.kind,
        tabId: tab.info.tabId,
        url: tab.info.url,
        title: tab.info.title,
        maxChars,
      })

      this.emitActivity({
        tabId: tab.info.tabId,
        target: tab.info.target,
        sessionId: options.sessionId,
        agentId: options.agentId,
        kind: 'inspect',
        action: options.kind,
        humanLabel: `已检查页面 ${options.kind}`,
        url: tab.info.url,
        title: tab.info.title,
        status: 'completed',
      })

      return {
        tabId: tab.info.tabId,
        target: tab.info.target,
        kind: options.kind,
        url: tab.info.url,
        wrappedContent,
        ...(itemCount !== undefined ? { itemCount } : {}),
      }
    })
  }

  async requestTakeover(
    options: BrowserTakeoverRequestOptions,
  ): Promise<BrowserTakeoverState> {
    const tab = this.requireTab(options.tabId)
    return this.enterTakeoverState(tab, options)
  }

  private findTakeoverForSettlement(takeoverId?: string): BrowserTakeoverState | null {
    if (takeoverId) {
      for (const takeover of this.activeTakeovers.values()) {
        if (takeover.takeoverId === takeoverId) return takeover
      }
      return null
    }
    if (this.activeTabId) {
      const active = this.activeTakeovers.get(this.activeTabId)
      if (active) return active
    }
    const entries = [...this.activeTakeovers.values()]
    return entries.at(-1) ?? null
  }

  async resumeTakeover(takeoverId?: string): Promise<BrowserTakeoverState | null> {
    const existing = this.findTakeoverForSettlement(takeoverId)
    if (!existing) {
      return null
    }
    const resumed: BrowserTakeoverState = {
      ...existing,
      status: 'resumed',
    }
    const tab = this.tabs.get(resumed.tabId)
    this.activeTakeovers.delete(resumed.tabId)
    if (tab) {
      await this.updateControlState(tab, 'idle', {
        sessionId: resumed.sessionId,
        agentId: resumed.agentId,
      })
    } else {
      this.tabControlStates.delete(resumed.tabId)
    }
    this.emitActivity({
      tabId: resumed.tabId,
      target: resumed.target,
      sessionId: resumed.sessionId,
      agentId: resumed.agentId,
      kind: 'takeover',
      action: 'resume',
      humanLabel: '用户已完成接管，继续执行',
      status: 'completed',
      takeover: resumed,
    })
    return resumed
  }

  async abortTakeover(takeoverId?: string): Promise<BrowserTakeoverState | null> {
    const existing = this.findTakeoverForSettlement(takeoverId)
    if (!existing) {
      return null
    }
    const aborted: BrowserTakeoverState = {
      ...existing,
      status: 'aborted',
    }
    const tab = this.tabs.get(aborted.tabId)
    this.activeTakeovers.delete(aborted.tabId)
    if (tab) {
      await this.updateControlState(tab, 'idle', {
        sessionId: aborted.sessionId,
        agentId: aborted.agentId,
      })
    } else {
      this.tabControlStates.delete(aborted.tabId)
    }
    this.emitActivity({
      tabId: aborted.tabId,
      target: aborted.target,
      sessionId: aborted.sessionId,
      agentId: aborted.agentId,
      kind: 'takeover',
      action: 'abort',
      humanLabel: '已取消浏览器接管操作',
      status: 'failed',
      takeover: aborted,
    })
    return aborted
  }

  async releaseControl(tabId?: string): Promise<void> {
    const tab = tabId ? this.tabs.get(tabId) : this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
    if (!tab) return
    if (this.activeTakeovers.get(tab.info.tabId)?.status === 'pending') {
      return
    }
    await this.updateControlState(tab, 'idle', {})
  }

  private async enterTakeoverState(
    tab: TabRuntimeState,
    options: BrowserTakeoverRequestOptions,
  ): Promise<BrowserTakeoverState> {
    const takeover: BrowserTakeoverState = {
      takeoverId: randomUUID(),
      tabId: tab.info.tabId,
      target: tab.info.target,
      sessionId: options.sessionId,
      agentId: options.agentId,
      reason: options.reason,
      message: options.message,
      url: tab.info.url,
      createdAt: Date.now(),
      status: 'pending',
    }
    this.activeTakeovers.set(tab.info.tabId, takeover)
    await this.updateControlState(tab, 'takeover', {
      sessionId: options.sessionId,
      agentId: options.agentId,
      label: options.message,
      takeoverId: takeover.takeoverId,
      takeoverReason: options.reason,
      takeoverMessage: options.message,
    })
    this.emitActivity({
      tabId: tab.info.tabId,
      target: tab.info.target,
      sessionId: options.sessionId,
      agentId: options.agentId,
      kind: 'takeover',
      action: options.reason,
      humanLabel: `需要你来完成：${options.message}`,
      url: tab.info.url,
      title: tab.info.title,
      status: 'paused',
      takeover,
    })
    return takeover
  }

  private async moveVisualCursor(
    tab: TabRuntimeState,
    resolved: ResolvedRefTarget,
    action: FlatActionStep['action'],
    label: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const dx = resolved.coords.xSlot - tab.lastCursorPos.x
    const dy = resolved.coords.ySlot - tab.lastCursorPos.y
    const dist = Math.hypot(dx, dy)
    const style = dist <= 160 ? 'scoot' : 'bezier'
    const durationMs = Math.round(Math.min(460, Math.max(220, 180 + dist * 0.42)))
    tab.lastCursorPos = { x: resolved.coords.xSlot, y: resolved.coords.ySlot }

    const payload = {
      tabId: tab.info.tabId,
      target: tab.info.target,
      moveId: randomUUID(),
      x: resolved.coords.xSlot,
      y: resolved.coords.ySlot,
      targetBox: resolved.targetBoxSlot,
      durationMs,
      style: style as 'scoot' | 'bezier',
      label,
      action,
    }

    if (this.uiHooks?.moveCursor) {
      await this.uiHooks.moveCursor(payload, signal)
    } else if (tab.inPageCursor) {
      const frame = await getTopFrameIdentity(
        this.transport,
        tab.info.cdpSessionId,
        signal,
      ).catch(() => ({ frameId: 'main', loaderId: 'initial', url: tab.info.url }))
      await tab.inPageCursor.moveCursor(frame.frameId, {
        ...payload,
        x: resolved.coords.xVv,
        y: resolved.coords.yVv,
      })
    }
  }

  private async emitClickRipple(
    tab: TabRuntimeState,
    resolved: ResolvedRefTarget,
    action: FlatActionStep['action'],
    label: string,
  ): Promise<void> {
    const payload = {
      tabId: tab.info.tabId,
      target: tab.info.target,
      x: resolved.coords.xSlot,
      y: resolved.coords.ySlot,
      label,
      action,
      click: true,
    }
    if (this.uiHooks?.clickRipple) {
      await this.uiHooks.clickRipple(payload)
    } else if (tab.inPageCursor) {
      const topFrame = await getTopFrameIdentity(
        this.transport,
        tab.info.cdpSessionId,
      ).catch(() => ({ frameId: 'main', loaderId: 'initial', url: tab.info.url }))
      await tab.inPageCursor.clickRipple(topFrame.frameId, {
        ...payload,
        x: resolved.coords.xVv,
        y: resolved.coords.yVv,
      })
    }
  }

  private async updateControlState(
    tab: TabRuntimeState,
    state: BrowserControlState,
    extra: {
      sessionId?: string
      agentId?: string
      label?: string
      takeoverId?: string
      takeoverReason?: BrowserTakeoverReason
      takeoverMessage?: string
    },
  ): Promise<void> {
    if (
      state === 'active' &&
      this.activeTakeovers.get(tab.info.tabId)?.status === 'pending'
    ) {
      return
    }
    if (state === 'idle') {
      this.tabControlStates.delete(tab.info.tabId)
    } else {
      this.tabControlStates.set(tab.info.tabId, state)
    }
    const payload = {
      tabId: tab.info.tabId,
      target: tab.info.target,
      state,
      ...extra,
    }
    if (this.uiHooks?.setControlState) {
      await this.uiHooks.setControlState(payload)
    } else if (tab.inPageCursor) {
      if (state === 'idle') {
        await tab.inPageCursor.teardown()
      } else {
        const frame = await getTopFrameIdentity(
          this.transport,
          tab.info.cdpSessionId,
        ).catch(() => ({ frameId: 'main', loaderId: 'initial', url: tab.info.url }))
        await tab.inPageCursor.setControlState(frame.frameId, payload)
      }
    }
  }

  private emitActivity(
    event: Omit<BrowserUseActivityEvent, 'id' | 'timestamp'>,
  ): void {
    this.uiHooks?.onActivity?.({
      id: randomUUID(),
      timestamp: Date.now(),
      ...event,
    })
  }

  private formatStepLabel(
    step: FlatActionStep,
    ref?: BrowserRefEntry,
  ): string {
    if (step.label?.trim()) {
      return step.label.trim()
    }
    const targetName = ref?.humanLabel ? `「${ref.humanLabel}」` : ''
    switch (step.action) {
      case 'click':
        return `正在点击${targetName || '元素'}`
      case 'dblclick':
        return `正在双击${targetName || '元素'}`
      case 'fill':
      case 'type':
        return `正在输入${targetName || '内容'}`
      case 'press':
        return `正在按键 ${step.key ?? ''}`.trim()
      case 'select':
        return `正在选择${targetName || '选项'}`
      case 'hover':
        return `正在悬停${targetName || '元素'}`
      case 'scroll':
        return '正在滚动页面'
      case 'wait':
        return '正在等待页面响应'
      case 'dialog':
        return step.accept === false ? '正在取消对话框' : '正在确认对话框'
    }
  }

  private resolveTabForEvent(sessionId?: string): TabRuntimeState | undefined {
    if (sessionId) {
      for (const tab of this.tabs.values()) {
        if (tab.info.cdpSessionId === sessionId) {
          return tab
        }
      }
      return undefined
    }
    if (this.activeTabId) {
      return this.tabs.get(this.activeTabId)
    }
    return this.tabs.values().next().value
  }

  private findTabBySessionOrTarget(
    cdpSessionId?: string,
    targetId?: string,
  ): TabRuntimeState | undefined {
    for (const tab of this.tabs.values()) {
      if (cdpSessionId && tab.info.cdpSessionId === cdpSessionId) {
        return tab
      }
      if (targetId && (tab.info.targetId === targetId || tab.info.tabId === targetId)) {
        return tab
      }
    }
    return undefined
  }

  private rejectPendingInputs(tab: TabRuntimeState, err: Error): void {
    for (const waiter of tab.pendingInputs) {
      waiter.rejectWithError(err)
    }
    tab.pendingInputs.clear()
  }

  private handleCdpEvent(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): void {
    if (method === 'Target.detachedFromTarget') {
      const detachedSessionId =
        typeof params.sessionId === 'string' ? params.sessionId : sessionId
      const detachedTargetId =
        typeof params.targetId === 'string' ? params.targetId : undefined
      const deadTab = this.findTabBySessionOrTarget(
        detachedSessionId,
        detachedTargetId,
      )
      if (deadTab) {
        this.rejectPendingInputs(
          deadTab,
          new Error(
            `CDP target detached for tab "${deadTab.info.tabId}"`,
          ),
        )
        this.unregisterTab(deadTab.info.tabId)
      }
      return
    }

    if (method === 'Target.targetDestroyed') {
      const destroyedTargetId =
        typeof params.targetId === 'string' ? params.targetId : undefined
      const deadTab = this.findTabBySessionOrTarget(undefined, destroyedTargetId)
      if (deadTab) {
        this.rejectPendingInputs(
          deadTab,
          new Error(
            `CDP target destroyed for tab "${deadTab.info.tabId}"`,
          ),
        )
        this.unregisterTab(deadTab.info.tabId)
      }
      return
    }

    const tab = this.resolveTabForEvent(sessionId)
    if (!tab) {
      return
    }

    if (method === 'Inspector.detached') {
      tab.domainsEnabled = false
      tab.inPageCursor?.invalidateContext()
      return
    }

    if (method === 'Page.frameNavigated') {
      const frame = params.frame as { parentId?: string; url?: string } | undefined
      if (!frame?.parentId) {
        tab.inPageCursor?.invalidateContext()
        if (typeof frame?.url === 'string' && frame.url && frame.url !== 'about:blank') {
          tab.info.url = frame.url
        }
      }
      return
    }

    if (method === 'Page.javascriptDialogOpening') {
      const dialog: BrowserDialogState = {
        type:
          params.type === 'confirm' ||
          params.type === 'prompt' ||
          params.type === 'beforeunload'
            ? params.type
            : 'alert',
        message: typeof params.message === 'string' ? params.message : '',
        ...(typeof params.defaultPrompt === 'string'
          ? { defaultPrompt: params.defaultPrompt }
          : {}),
        ...(typeof params.url === 'string' ? { url: params.url } : {}),
        ...(typeof params.hasBrowserHandler === 'boolean'
          ? { hasBrowserHandler: params.hasBrowserHandler }
          : {}),
        openedAt: Date.now(),
      }
      tab.dialog = dialog
      // Immediately settle any in-flight inputs so micro-batch halts cleanly!
      for (const waiter of tab.pendingInputs) {
        waiter.settleWithDialog(dialog)
      }
      tab.pendingInputs.clear()
      this.emitActivity({
        tabId: tab.info.tabId,
        target: tab.info.target,
        kind: 'dialog',
        action: dialog.type,
        humanLabel: `页面弹出 ${dialog.type} 对话框`,
        detail: dialog.message.slice(0, 120),
        url: tab.info.url,
        status: 'paused',
      })
      return
    }

    if (method === 'Page.javascriptDialogClosed') {
      tab.dialog = null
      return
    }

    if (method === 'Runtime.consoleAPICalled') {
      const args = Array.isArray(params.args) ? params.args : []
      const text = args
        .map(arg => {
          if (typeof arg !== 'object' || arg === null) return String(arg)
          const rec = arg as { value?: unknown; description?: string }
          if (rec.value !== undefined) return String(rec.value)
          return rec.description ?? ''
        })
        .filter(Boolean)
        .join(' ')
      pushBounded(tab.consoleLogs, {
        timestamp: Date.now(),
        level: typeof params.type === 'string' ? params.type : 'log',
        text,
      })
      return
    }

    if (method === 'Log.entryAdded') {
      const entry = params.entry as
        | { level?: string; text?: string; url?: string; lineNumber?: number }
        | undefined
      if (entry) {
        pushBounded(tab.consoleLogs, {
          timestamp: Date.now(),
          level: entry.level ?? 'info',
          text: entry.text ?? '',
          ...(entry.url ? { url: entry.url } : {}),
          ...(typeof entry.lineNumber === 'number'
            ? { lineNumber: entry.lineNumber }
            : {}),
        })
      }
      return
    }

    if (method === 'Network.requestWillBeSent') {
      const requestId =
        typeof params.requestId === 'string' ? params.requestId : ''
      const req = params.request as
        | { url?: string; method?: string; headers?: Record<string, string> }
        | undefined
      if (!requestId || !req) return
      const entry: BrowserNetworkEntry = {
        timestamp: Date.now(),
        requestId,
        url: req.url ?? '',
        method: req.method ?? 'GET',
        ...(typeof params.type === 'string'
          ? { resourceType: params.type }
          : {}),
        ...(req.headers
          ? { requestHeaders: redactSensitiveHeaders(req.headers) }
          : {}),
      }
      tab.networkByRequestId.set(requestId, entry)
      pushBounded(tab.networkLogs, entry)
      if (tab.networkByRequestId.size > RING_BUFFER_LIMIT * 2) {
        const oldestKey = tab.networkByRequestId.keys().next().value
        if (oldestKey) tab.networkByRequestId.delete(oldestKey)
      }
      return
    }

    if (method === 'Network.responseReceived') {
      const requestId =
        typeof params.requestId === 'string' ? params.requestId : ''
      const res = params.response as
        | {
            status?: number
            statusText?: string
            headers?: Record<string, string>
          }
        | undefined
      const existing = tab.networkByRequestId.get(requestId)
      if (existing && res) {
        existing.status = res.status
        existing.statusText = res.statusText
        if (res.headers) {
          existing.responseHeaders = redactSensitiveHeaders(res.headers)
        }
      }
      return
    }

    if (method === 'Network.loadingFailed') {
      const requestId =
        typeof params.requestId === 'string' ? params.requestId : ''
      const existing = tab.networkByRequestId.get(requestId)
      if (existing) {
        existing.failed = true
        existing.errorText =
          typeof params.errorText === 'string' ? params.errorText : 'failed'
      }
    }
  }
}

function pushBounded<T>(arr: T[], item: T): void {
  arr.push(item)
  if (arr.length > RING_BUFFER_LIMIT) {
    arr.splice(0, arr.length - RING_BUFFER_LIMIT)
  }
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Wait aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Wait aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
