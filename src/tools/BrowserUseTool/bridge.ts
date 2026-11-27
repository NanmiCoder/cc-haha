import {
  BrowserUseEngine,
  ChromeConnectionManager,
  loadBrowserUseConfig,
  type BrowserActResult,
  type BrowserInspectResult,
  type BrowserNavigateResult,
  type BrowserSnapshotResult,
  type BrowserTabInfo,
  type BrowserTakeoverState,
  type BrowserTargetKind,
  type CdpTransport,
  type FlatActionStep,
} from '../../services/browserUse/index.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { getSessionBridgeConfig } from '../SessionCollaborationTool/bridge.js'
import type {
  BrowserActInput,
  BrowserInspectInput,
  BrowserNavigateInput,
  BrowserSnapshotInput,
  BrowserTabsInput,
  BrowserTakeoverInput,
} from './schemas.js'

const REQUEST_TIMEOUT_MS = 120_000
const CLEANUP_TIMEOUT_MS = 5_000

const activeBrowserScopes = new Set<string>()
const pendingTakeoverScopes = new Set<string>()

interface StandaloneRuntime {
  chromeManager: ChromeConnectionManager
  engine: BrowserUseEngine
  transport: CdpTransport
  attachedTargets: Map<string, { targetId: string; cdpSessionId: string }>
}

let standaloneRuntime: StandaloneRuntime | null = null
let standaloneConnectPromise: Promise<StandaloneRuntime> | null = null
let standaloneShutdownRegistered = false

function registerStandaloneShutdownHook(): void {
  if (standaloneShutdownRegistered) return
  standaloneShutdownRegistered = true
  const teardown = async () => {
    const rt = standaloneRuntime
    standaloneRuntime = null
    if (!rt) return
    rt.engine.dispose()
    await rt.chromeManager.disconnect().catch(() => {})
  }
  registerCleanup(teardown, { timeoutMs: 3_000 })
  const onSignal = () => {
    void teardown()
  }
  process.once('beforeExit', onSignal)
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
}

export function clearBrowserUseTakeoverPending(agentId?: string): void {
  pendingTakeoverScopes.delete(currentScopeKey(agentId))
}

function scopeKey(sessionId?: string, agentId?: string): string {
  return `${sessionId || 'standalone'}::${agentId || 'main'}`
}

function currentScopeKey(agentId?: string): string {
  let sessionId = 'standalone'
  try {
    sessionId = getSessionBridgeConfig()?.sessionId ?? 'standalone'
  } catch {
    sessionId = 'standalone'
  }
  return scopeKey(sessionId, agentId)
}

export function markBrowserUseTakeoverPending(agentId?: string): void {
  const key = currentScopeKey(agentId)
  activeBrowserScopes.add(key)
  pendingTakeoverScopes.add(key)
}

export function isBrowserUseBridgeDesktopMode(): boolean {
  try {
    return getSessionBridgeConfig() !== undefined
  } catch {
    return false
  }
}

export function resetBrowserUseBridgeStateForTests(): void {
  activeBrowserScopes.clear()
  pendingTakeoverScopes.clear()
  if (standaloneRuntime) {
    standaloneRuntime.engine.dispose()
    void standaloneRuntime.chromeManager.disconnect().catch(() => {})
    standaloneRuntime = null
  }
  standaloneConnectPromise = null
}

async function postToDesktopServer(
  action: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const config = getSessionBridgeConfig()
  if (!config) {
    throw new Error('Desktop server bridge is unavailable')
  }

  const effectiveSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs)

  const response = await fetch(`${config.endpoint}/api/browser-use/${action}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'X-Session-Id': config.sessionId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: effectiveSignal,
  })

  if (!response.ok) {
    const errBody = (await response.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null
    const detail =
      typeof errBody?.message === 'string'
        ? `: ${errBody.message.slice(0, 1000)}`
        : typeof errBody?.error === 'string'
          ? `: ${errBody.error.slice(0, 200)}`
          : ''
    throw new Error(`Browser Use ${action} failed (${response.status})${detail}`)
  }

  const data: unknown = await response.json()
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Invalid Browser Use ${action} response`)
  }
  return data as Record<string, unknown>
}

async function ensureStandaloneRuntime(): Promise<StandaloneRuntime> {
  if (standaloneRuntime && standaloneRuntime.transport.isConnected()) {
    return standaloneRuntime
  }
  if (standaloneConnectPromise) {
    return standaloneConnectPromise
  }

  standaloneConnectPromise = (async () => {
    const config = loadBrowserUseConfig({ bypassCache: true })
    const chromeManager = new ChromeConnectionManager({
      customExecutablePath: config.chromeBinaryPath,
      customUserDataDir: config.chromeUserDataDir,
    })

    let state = await chromeManager.connectLiveAttach({ timeoutMs: 15_000 })
    if (state.mode === 'awaiting_approval') {
      throw new Error(
        state.guidance ??
          'Chrome is waiting for you to approve the remote debugging prompt. Click Allow in Chrome and retry.',
      )
    }
    if (state.mode !== 'live_attach') {
      state = await chromeManager.launchManagedChrome({
        headless: config.managedChromeHeadless,
      })
    }

    const transport = chromeManager.getTransport()
    if (!transport || !transport.isConnected()) {
      throw new Error(
        state.error ??
          state.guidance ??
          'Failed to connect to System or Managed Chrome in standalone CLI mode.',
      )
    }

    const engine = new BrowserUseEngine({
      transport,
      blockedLoopbackPorts: config.blockedLoopbackPorts,
      noInPageOverlay: !config.showCursorOverlay,
    })

    const runtime: StandaloneRuntime = {
      chromeManager,
      engine,
      transport,
      attachedTargets: new Map(),
    }
    standaloneRuntime = runtime
    registerStandaloneShutdownHook()
    return runtime
  })()

  try {
    return await standaloneConnectPromise
  } finally {
    standaloneConnectPromise = null
  }
}

async function syncStandaloneTabs(runtime: StandaloneRuntime): Promise<BrowserTabInfo[]> {
  const { targetInfos } = await runtime.transport.send<{
    targetInfos?: Array<{
      targetId: string
      type: string
      title: string
      url: string
      attached?: boolean
    }>
  }>('Target.getTargets')

  const pages = (targetInfos ?? []).filter(t => t.type === 'page')
  for (const page of pages) {
    const existing = runtime.engine.getTab(page.targetId)
    if (existing) {
      runtime.engine.registerTab({
        ...existing,
        url: page.url,
        title: page.title,
      })
    } else {
      runtime.engine.registerTab({
        tabId: page.targetId,
        target: 'chrome',
        targetId: page.targetId,
        url: page.url,
        title: page.title,
        active: false,
      })
    }
  }
  return runtime.engine.listTabs()
}

async function ensureStandaloneTabAttached(
  runtime: StandaloneRuntime,
  requestedTabId?: string,
  openUrl?: string,
): Promise<BrowserTabInfo> {
  let tab = requestedTabId
    ? runtime.engine.getTab(requestedTabId)
    : runtime.engine.getTab()

  const isLiveAttach = runtime.chromeManager.getState().mode === 'live_attach'
  if (!tab && requestedTabId) {
    const tabs = await syncStandaloneTabs(runtime)
    tab = tabs.find(t => t.tabId === requestedTabId) ?? null
  } else if (!tab && !isLiveAttach) {
    const tabs = await syncStandaloneTabs(runtime)
    tab = tabs[0] ?? null
  }
  // In Live Attach mode with no explicit tabId and no agent-pinned tab yet,
  // fall through to Target.createTarget + pinTab so we never hijack the user's
  // existing browser tab.

  if (!tab) {
    const created = await runtime.transport.send<{ targetId: string }>(
      'Target.createTarget',
      { url: openUrl || 'about:blank' },
    )
    const attached = await runtime.transport.send<{ sessionId: string }>(
      'Target.attachToTarget',
      { targetId: created.targetId, flatten: true },
    )
    runtime.chromeManager.pinTab(created.targetId)
    runtime.attachedTargets.set(created.targetId, {
      targetId: created.targetId,
      cdpSessionId: attached.sessionId,
    })
    return runtime.engine.registerTab({
      tabId: created.targetId,
      target: 'chrome',
      targetId: created.targetId,
      cdpSessionId: attached.sessionId,
      url: openUrl || 'about:blank',
      title: '',
      active: true,
      pinned: true,
    })
  }

  if (!tab.cdpSessionId) {
    const targetId = tab.targetId ?? tab.tabId
    const attached = await runtime.transport.send<{ sessionId: string }>(
      'Target.attachToTarget',
      { targetId, flatten: true },
    )
    runtime.attachedTargets.set(tab.tabId, {
      targetId,
      cdpSessionId: attached.sessionId,
    })
    tab = runtime.engine.registerTab({
      ...tab,
      cdpSessionId: attached.sessionId,
      active: true,
    })
  }

  return tab
}

async function callStandaloneEngine(
  action: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const runtime = await ensureStandaloneRuntime()
  const agentId =
    typeof payload.agentId === 'string' ? payload.agentId : undefined

  switch (action) {
    case 'tabs': {
      const input = payload as unknown as BrowserTabsInput
      if (input.action === 'list') {
        const tabs = await syncStandaloneTabs(runtime)
        return { target: 'chrome' as BrowserTargetKind, tabs }
      }
      if (input.action === 'open') {
        if (input.url) {
          runtime.engine.navigationGuard.assertAllowed(input.url)
        }
        const created = await runtime.transport.send<{ targetId: string }>(
          'Target.createTarget',
          { url: input.url ?? 'about:blank' },
        )
        const attached = await runtime.transport.send<{ sessionId: string }>(
          'Target.attachToTarget',
          { targetId: created.targetId, flatten: true },
        )
        runtime.chromeManager.pinTab(created.targetId)
        const tab = runtime.engine.registerTab({
          tabId: created.targetId,
          target: 'chrome',
          targetId: created.targetId,
          cdpSessionId: attached.sessionId,
          url: input.url ?? 'about:blank',
          title: '',
          active: true,
          pinned: true,
          ownerAgentId: agentId,
        })
        return { target: 'chrome' as BrowserTargetKind, tab, tabs: runtime.engine.listTabs() }
      }
      if (input.action === 'focus') {
        if (!input.tabId) throw new Error('tabId is required for focus')
        const tab = await ensureStandaloneTabAttached(runtime, input.tabId)
        await runtime.transport.send('Target.activateTarget', {
          targetId: tab.targetId ?? tab.tabId,
        })
        runtime.engine.setActiveTab(tab.tabId)
        return { target: 'chrome' as BrowserTargetKind, tab }
      }
      if (input.action === 'close') {
        if (!input.tabId) throw new Error('tabId is required for close')
        await runtime.transport.send('Target.closeTarget', {
          targetId: input.tabId,
        })
        runtime.engine.unregisterTab(input.tabId)
        runtime.chromeManager.unpinTab(input.tabId)
        return { ok: true, tabId: input.tabId, target: 'chrome' as BrowserTargetKind }
      }
      throw new Error(`Unsupported tabs action: ${String(input.action)}`)
    }
    case 'navigate': {
      const input = payload as unknown as BrowserNavigateInput
      const tab = await ensureStandaloneTabAttached(runtime, input.tabId)
      const result: BrowserNavigateResult = await runtime.engine.navigate({
        tabId: tab.tabId,
        url: input.url,
        action: input.action,
        waitUntil: input.waitUntil,
        timeoutMs: input.timeoutMs,
        agentId,
        signal,
      })
      return result as unknown as Record<string, unknown>
    }
    case 'snapshot': {
      const input = payload as unknown as BrowserSnapshotInput
      const tab = await ensureStandaloneTabAttached(runtime, input.tabId)
      const result: BrowserSnapshotResult = await runtime.engine.snapshot({
        tabId: tab.tabId,
        diff: input.diff,
        screenshot: input.screenshot,
        screenshotFormat: input.screenshotFormat,
        includeNonInteractive: input.includeNonInteractive,
        maxNodes: input.maxNodes,
        agentId,
        signal,
      })
      return result as unknown as Record<string, unknown>
    }
    case 'act': {
      const input = payload as unknown as BrowserActInput
      const tab = await ensureStandaloneTabAttached(runtime, input.tabId)
      const result: BrowserActResult = await runtime.engine.act({
        tabId: tab.tabId,
        steps: input.steps as FlatActionStep[],
        stopOnNavigation: input.stopOnNavigation,
        autoTakeoverOnSensitive: input.autoTakeoverOnSensitive,
        agentId,
        signal,
      })
      return result as unknown as Record<string, unknown>
    }
    case 'inspect': {
      const input = payload as unknown as BrowserInspectInput
      const tab = await ensureStandaloneTabAttached(runtime, input.tabId)
      const result: BrowserInspectResult = await runtime.engine.inspect({
        tabId: tab.tabId,
        kind: input.kind,
        selector: input.selector,
        expression: input.expression,
        limit: input.limit,
        maxChars: input.maxChars,
        agentId,
        signal,
      })
      return result as unknown as Record<string, unknown>
    }
    case 'takeover': {
      const input = payload as unknown as BrowserTakeoverInput
      const tab = await ensureStandaloneTabAttached(runtime, input.tabId)
      const result: BrowserTakeoverState = await runtime.engine.requestTakeover({
        tabId: tab.tabId,
        reason: input.reason,
        message: input.message,
        agentId,
      })
      return result as unknown as Record<string, unknown>
    }
    default:
      throw new Error(`Unknown Browser Use action: ${action}`)
  }
}

export async function callBrowserUseBridge(
  action: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const agentId =
    typeof payload.agentId === 'string' ? payload.agentId : undefined
  const key = currentScopeKey(agentId)
  activeBrowserScopes.add(key)
  if (action !== 'takeover') {
    pendingTakeoverScopes.delete(key)
  }

  if (isBrowserUseBridgeDesktopMode()) {
    return postToDesktopServer(action, payload, signal)
  }

  return callStandaloneEngine(action, payload, signal)
}

/**
 * Turn-end cleanup invoked from `src/query/stopHooks.ts`, scoped by
 * `(sessionId, agentId)`.
 *
 * - Zero-syscall / zero-network fast path on turns that never touched Browser Use.
 * - Preserves browser takeover pause state when waiting for human Resume.
 */
export async function cleanupBrowserUseAfterTurn(options: {
  sessionId?: string
  agentId?: string
}): Promise<void> {
  let effectiveSessionId = options.sessionId
  if (!effectiveSessionId) {
    try {
      effectiveSessionId = getSessionBridgeConfig()?.sessionId
    } catch {
      effectiveSessionId = undefined
    }
  }
  const key = scopeKey(effectiveSessionId, options.agentId)
  const fallbackKey = currentScopeKey(options.agentId)

  if (!activeBrowserScopes.has(key) && !activeBrowserScopes.has(fallbackKey)) {
    return
  }

  // Never tear down or hide overlay while the turn is paused for human takeover.
  if (
    pendingTakeoverScopes.has(key) ||
    pendingTakeoverScopes.has(fallbackKey)
  ) {
    return
  }

  activeBrowserScopes.delete(key)
  activeBrowserScopes.delete(fallbackKey)

  if (isBrowserUseBridgeDesktopMode()) {
    try {
      await postToDesktopServer(
        'cleanup',
        {
          ...(options.agentId ? { agentId: options.agentId } : {}),
        },
        undefined,
        CLEANUP_TIMEOUT_MS,
      )
    } catch {
      // Best-effort turn-end cleanup
    }
    return
  }

  if (standaloneRuntime) {
    try {
      await standaloneRuntime.engine.releaseControl()
    } catch {
      // Best-effort turn-end cleanup
    }
  }
}
