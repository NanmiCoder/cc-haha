import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browserUseApi, type BrowserUseConfig, type BrowserUseStatus } from '@/api/browserUse'
import { useUIStore } from './uiStore'
import { useBrowserUseStore } from './browserUseStore'

vi.mock('@/api/browserUse', () => ({
  browserUseApi: {
    getStatus: vi.fn(),
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    resumeTakeover: vi.fn(),
    abortTakeover: vi.fn(),
  },
}))

const mockApi = browserUseApi as unknown as {
  getStatus: ReturnType<typeof vi.fn>
  getConfig: ReturnType<typeof vi.fn>
  updateConfig: ReturnType<typeof vi.fn>
  resumeTakeover: ReturnType<typeof vi.fn>
  abortTakeover: ReturnType<typeof vi.fn>
}

const baseConfig: BrowserUseConfig = {
  enabled: false,
  preferredTarget: 'auto',
  showCursorOverlay: true,
  autoOpenWorkspacePanel: true,
  managedChromeHeadless: false,
}

const baseStatus: BrowserUseStatus = {
  enabled: false,
  preferredTarget: 'auto',
  activeTarget: null,
  workspaceAvailable: true,
  chrome: {
    mode: 'disconnected',
    detectedBrowsers: [],
  },
  controlState: 'idle',
  tabs: [],
  config: baseConfig,
}

describe('useBrowserUseStore', () => {
  beforeEach(() => {
    useBrowserUseStore.getState().reset()
    vi.clearAllMocks()
  })

  it('optimistically updates config and rolls back on failure', async () => {
    useBrowserUseStore.getState().applyStatus(baseStatus)
    mockApi.updateConfig.mockRejectedValueOnce(new Error('disk full'))

    const saved = await useBrowserUseStore.getState().updateConfig({ enabled: true })

    expect(saved).toBeNull()
    expect(useBrowserUseStore.getState().config?.enabled).toBe(false)
    expect(useBrowserUseStore.getState().error).toBe('disk full')
  })

  it('applies host control-state, move-cursor, and click-ripple events per tab', () => {
    useBrowserUseStore.getState().applyHostEvent({
      type: 'control-state',
      tabId: 'tab-1',
      state: 'active',
      actionLabel: 'Click Submit',
      sessionId: 'sess-1',
    })
    useBrowserUseStore.getState().applyHostEvent({
      type: 'move-cursor',
      tabId: 'tab-1',
      moveId: 'move-1',
      x: 120,
      y: 240,
      durationMs: 220,
      label: 'Click Submit',
    })
    useBrowserUseStore.getState().applyHostEvent({
      type: 'click-ripple',
      tabId: 'tab-1',
      x: 120,
      y: 240,
      button: 'left',
    })

    const tabState = useBrowserUseStore.getState().tabStates['tab-1']
    expect(tabState?.controlState).toBe('active')
    expect(tabState?.actionLabel).toBe('Click Submit')
    expect(tabState?.cursor).toMatchObject({ moveId: 'move-1', x: 120, y: 240 })
    expect(tabState?.ripple).toMatchObject({ x: 120, y: 240, button: 'left' })

    useBrowserUseStore.getState().applyHostEvent({
      type: 'control-state',
      tabId: 'tab-1',
      state: 'idle',
    })
    expect(useBrowserUseStore.getState().tabStates['tab-1']?.cursor).toBeNull()
  })

  it('syncs browser_use_takeover events with session takeover and workspace tab state', () => {
    useBrowserUseStore.getState().applyTakeoverEvent('sess-1', {
      takeoverId: 'tk-1',
      tabId: 'tab-1',
      target: 'workspace',
      sessionId: 'sess-1',
      reason: 'captcha',
      message: 'Solve the CAPTCHA',
      createdAt: 1000,
      status: 'pending',
    })

    expect(useBrowserUseStore.getState().takeoverBySession['sess-1']?.takeoverId).toBe('tk-1')
    expect(useBrowserUseStore.getState().tabStates['tab-1']?.controlState).toBe('takeover')

    useBrowserUseStore.getState().applyTakeoverEvent('sess-1', {
      takeoverId: 'tk-1',
      tabId: 'tab-1',
      target: 'workspace',
      sessionId: 'sess-1',
      reason: 'captcha',
      message: 'Solve the CAPTCHA',
      createdAt: 1000,
      status: 'resumed',
    })
    expect(useBrowserUseStore.getState().takeoverBySession['sess-1']).toBeNull()
    // Resuming transitions local tab state back to 'idle' (never stuck 'active').
    expect(useBrowserUseStore.getState().tabStates['tab-1']?.controlState).toBe('idle')
  })

  it('preserves optimistic config in applyStatus while an updateConfig PUT is in flight', async () => {
    useBrowserUseStore.getState().applyStatus(baseStatus)
    let resolvePut!: (value: BrowserUseConfig) => void
    mockApi.updateConfig.mockImplementationOnce(
      () => new Promise<BrowserUseConfig>((resolve) => { resolvePut = resolve }),
    )

    const pending = useBrowserUseStore.getState().updateConfig({ enabled: true })
    expect(useBrowserUseStore.getState().config?.enabled).toBe(true)

    // A background 1.5s poll returns stale enabled: false while PUT is still in flight.
    useBrowserUseStore.getState().applyStatus({ ...baseStatus, enabled: false, config: baseConfig })
    expect(useBrowserUseStore.getState().config?.enabled).toBe(true)

    resolvePut({ ...baseConfig, enabled: true })
    await pending
    expect(useBrowserUseStore.getState().config?.enabled).toBe(true)
  })

  it('deduplicates activity updates by id and preserves latest screenshot', () => {
    useBrowserUseStore.getState().applyActivityEvent('sess-1', {
      id: 'act-1',
      timestamp: 100,
      sessionId: 'sess-1',
      tabId: 'tab-1',
      target: 'workspace',
      kind: 'act',
      humanLabel: 'Click login',
      status: 'running',
    })
    useBrowserUseStore.getState().applyActivityEvent('sess-1', {
      id: 'act-1',
      timestamp: 200,
      sessionId: 'sess-1',
      tabId: 'tab-1',
      target: 'workspace',
      kind: 'act',
      humanLabel: 'Click login',
      status: 'completed',
      screenshotDataUrl: 'data:image/png;base64,AAA',
    })

    const list = useBrowserUseStore.getState().activitiesBySession['sess-1']
    expect(list).toHaveLength(1)
    expect(list?.[0]?.status).toBe('completed')
    expect(list?.[0]?.screenshotDataUrl).toBe('data:image/png;base64,AAA')
  })

  it('fetches status & config with race protection, handles takeover API success/error toasts, and clears tab/session state', async () => {
    useUIStore.setState({ toasts: [] })

    // fetchStatus success and error
    mockApi.getStatus.mockResolvedValueOnce({ ...baseStatus, enabled: true, config: { ...baseConfig, enabled: true } })
    const fetched = await useBrowserUseStore.getState().fetchStatus()
    expect(fetched?.enabled).toBe(true)
    expect(useBrowserUseStore.getState().config?.enabled).toBe(true)

    mockApi.getStatus.mockRejectedValueOnce(new Error('offline'))
    expect(await useBrowserUseStore.getState().fetchStatus()).toBeNull()
    expect(useBrowserUseStore.getState().error).toBe('offline')

    // fetchConfig success and failure
    mockApi.getConfig.mockResolvedValueOnce({ ...baseConfig, preferredTarget: 'chrome' })
    const cfg = await useBrowserUseStore.getState().fetchConfig()
    expect(cfg?.preferredTarget).toBe('chrome')
    expect(useBrowserUseStore.getState().status?.preferredTarget).toBe('chrome')

    mockApi.getConfig.mockRejectedValueOnce(new Error('403'))
    expect(await useBrowserUseStore.getState().fetchConfig()).toBeNull()

    // updateConfig success updates both config and status
    mockApi.updateConfig.mockResolvedValueOnce({ ...baseConfig, enabled: true, preferredTarget: 'workspace' })
    const updated = await useBrowserUseStore.getState().updateConfig({ enabled: true, preferredTarget: 'workspace' })
    expect(updated?.preferredTarget).toBe('workspace')
    expect(useBrowserUseStore.getState().status?.preferredTarget).toBe('workspace')

    // resumeTakeover & abortTakeover success (with and without takeover payload) + error toasts
    mockApi.resumeTakeover.mockResolvedValueOnce({ ok: true, resumed: true })
    expect(await useBrowserUseStore.getState().resumeTakeover('sess-1', 'tk-1')).toBe(true)

    mockApi.resumeTakeover.mockResolvedValueOnce({
      ok: true,
      resumed: true,
      takeover: {
        takeoverId: 'tk-2',
        tabId: 'tab-1',
        target: 'workspace',
        sessionId: 'sess-1',
        reason: 'login',
        message: 'Sign in',
        createdAt: 100,
        status: 'resumed',
      },
    })
    expect(await useBrowserUseStore.getState().resumeTakeover('sess-1', 'tk-2')).toBe(true)

    mockApi.resumeTakeover.mockRejectedValueOnce(new Error('resume failed'))
    expect(await useBrowserUseStore.getState().resumeTakeover('sess-1')).toBe(false)
    expect(useUIStore.getState().toasts.at(-1)).toMatchObject({ type: 'error', message: 'resume failed' })

    mockApi.abortTakeover.mockResolvedValueOnce({ ok: true })
    expect(await useBrowserUseStore.getState().abortTakeover('sess-1', 'tk-1', 'cancelled')).toBe(true)

    mockApi.abortTakeover.mockResolvedValueOnce({
      ok: true,
      takeover: {
        takeoverId: 'tk-3',
        tabId: 'tab-1',
        target: 'workspace',
        sessionId: 'sess-1',
        reason: 'login',
        message: 'Sign in',
        createdAt: 100,
        status: 'aborted',
      },
    })
    expect(await useBrowserUseStore.getState().abortTakeover('sess-1', 'tk-3')).toBe(true)

    mockApi.abortTakeover.mockRejectedValueOnce(new Error('abort failed'))
    expect(await useBrowserUseStore.getState().abortTakeover('sess-1')).toBe(false)
    expect(useUIStore.getState().toasts.at(-1)).toMatchObject({ type: 'error', message: 'abort failed' })

    // activity with embedded takeover + clearTabState / close-tab / clearSession
    useBrowserUseStore.getState().applyActivityEvent('sess-1', {
      id: 'act-tk',
      timestamp: 300,
      sessionId: 'sess-1',
      tabId: 'tab-2',
      target: 'workspace',
      kind: 'takeover',
      humanLabel: 'Need login',
      status: 'paused',
      takeover: {
        takeoverId: 'tk-4',
        tabId: 'tab-2',
        target: 'workspace',
        sessionId: 'sess-1',
        reason: 'login',
        message: 'Sign in',
        createdAt: 300,
        status: 'pending',
      },
    })
    expect(useBrowserUseStore.getState().takeoverBySession['sess-1']?.takeoverId).toBe('tk-4')

    useBrowserUseStore.getState().applyHostEvent({ type: 'control-state', tabId: 'tab-2', state: 'active' })
    useBrowserUseStore.getState().applyHostEvent({ type: 'close-tab', tabId: 'tab-2' })
    expect(useBrowserUseStore.getState().tabStates['tab-2']).toBeUndefined()

    useBrowserUseStore.getState().clearTabState('non-existent')
    useBrowserUseStore.getState().clearSession('sess-1')
    expect(useBrowserUseStore.getState().activitiesBySession['sess-1']).toBeUndefined()
    expect(useBrowserUseStore.getState().takeoverBySession['sess-1']).toBeUndefined()
  })
})
