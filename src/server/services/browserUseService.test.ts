import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ChromeConnectionManager,
  invalidateBrowserUseConfigCache,
  saveBrowserUseConfig,
  type CdpEventListener,
  type CdpTransport,
} from '../../services/browserUse/index.js'
import type { ServerMessage } from '../ws/events.js'
import {
  BrowserUseService,
  ElectronBridgeRpcClient,
  configureBrowserUseHost,
  getBrowserUseService,
  resetBrowserUseServiceForTests,
  resolveElectronBridgeConfig,
  type BridgeWebSocketLike,
} from './browserUseService.js'

let tempConfigDir: string | null = null

function createEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: tempConfigDir!,
    CC_HAHA_BROWSER_BRIDGE_URL: 'http://127.0.0.1:49991',
    CC_HAHA_BROWSER_BRIDGE_TOKEN: 'bridge-secret-token',
    CC_HAHA_SYSTEM_PROXY_URL: 'http://127.0.0.1:49992',
  }
}

class FakeBridgeServer {
  readonly rpcCalls: Array<{
    method: string
    params: Record<string, unknown>
    transport: 'http' | 'ws'
  }> = []
  private readonly wsListeners = new Map<string, Array<(ev: unknown) => void>>()
  private openTabSeq = 1

  createFetch(): typeof fetch {
    return (async (_url, init) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('origin')).toBeNull()
      expect(headers.get('authorization')).toBe('Bearer bridge-secret-token')

      const parsed = JSON.parse(String(init?.body)) as {
        id: number
        method: string
        params: Record<string, unknown>
      }
      this.rpcCalls.push({
        method: parsed.method,
        params: parsed.params,
        transport: 'http',
      })

      const result = this.handleRpc(parsed.method, parsed.params)
      return Response.json({ id: parsed.id, result })
    }) as typeof fetch
  }

  createWebSocketFactory() {
    return (_url: string, headers: Record<string, string>): BridgeWebSocketLike => {
      expect(headers.Authorization).toBe('Bearer bridge-secret-token')
      expect('Origin' in headers).toBe(false)
      return {
        readyState: 1,
        send: (raw: string) => {
          const parsed = JSON.parse(raw) as {
            id: number
            method: string
            params: Record<string, unknown>
          }
          this.rpcCalls.push({
            method: parsed.method,
            params: parsed.params,
            transport: 'ws',
          })
          const result = this.handleRpc(parsed.method, parsed.params)
          const reply = JSON.stringify({ id: parsed.id, result })
          for (const listener of this.wsListeners.get('message') ?? []) {
            listener({ data: reply })
          }
        },
        close() {},
        addEventListener: (type, listener) => {
          const list = this.wsListeners.get(type) ?? []
          list.push(listener)
          this.wsListeners.set(type, list)
          if (type === 'open') listener({})
        },
      }
    }
  }

  emitPush(event: string, params: Record<string, unknown>): void {
    const payload = JSON.stringify({ event, params })
    for (const listener of this.wsListeners.get('message') ?? []) {
      listener({ data: payload })
    }
  }

  private handleRpc(
    method: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    switch (method) {
      case 'tabs.list':
        return {
          tabs: [
            {
              tabId: 'ws-tab-1',
              url: 'http://127.0.0.1:5173/',
              title: 'Local Dev App',
              visible: true,
              zoomFactor: 1,
              appZoomFactor: 1,
            },
          ],
        }
      case 'tabs.ensure':
        return {
          tabId: params.createNew
            ? `ws-tab-new-${this.openTabSeq++}`
            : (params.tabId as string) || 'ws-tab-1',
          url: (params.url as string) || 'http://127.0.0.1:5173/',
          title: 'Local Dev App',
          visible: true,
          zoomFactor: 1,
          appZoomFactor: 1,
        }
      case 'tabs.zoom':
        return { tabId: params.tabId, zoomFactor: 1, appZoomFactor: 1 }
      case 'cdp.acquire':
        return {
          leaseId: `lease-${String(params.tabId)}`,
          tabId: params.tabId,
          zoomFactor: 1,
          appZoomFactor: 1,
        }
      case 'cdp.release':
      case 'ui.controlState':
      case 'ui.clickRipple':
      case 'tabs.focus':
      case 'tabs.close':
        return { ok: true }
      case 'ui.moveCursor':
        return {
          moveId: (params.moveId as string) || 'move-1',
          arrived: true,
          skipped: false,
        }
      case 'cdp.send': {
        const cdpMethod = String(params.method)
        if (cdpMethod === 'Page.getFrameTree') {
          return {
            frameTree: {
              frame: {
                id: 'frame-1',
                loaderId: 'loader-1',
                url: 'http://127.0.0.1:5173/',
              },
            },
          }
        }
        if (cdpMethod === 'Page.navigate') {
          return { frameId: 'frame-1', loaderId: 'loader-2' }
        }
        if (cdpMethod === 'Runtime.evaluate') {
          const expr = String((params.params as { expression?: string })?.expression ?? '')
          if (expr.includes('document.title')) {
            return { result: { value: 'Local Dev App' } }
          }
          if (expr.includes('location.href')) {
            return { result: { value: 'http://127.0.0.1:5173/' } }
          }
          return { result: { value: [] } }
        }
        if (cdpMethod === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              {
                nodeId: '1',
                role: { value: 'RootWebArea' },
                name: { value: 'Local Dev App' },
                childIds: ['2'],
              },
              {
                nodeId: '2',
                backendDOMNodeId: 101,
                role: { value: 'button' },
                name: { value: 'Run Tests' },
                childIds: [],
              },
            ],
          }
        }
        return {}
      }
      default:
        return { ok: true }
    }
  }
}

beforeEach(() => {
  tempConfigDir = mkdtempSync(join(tmpdir(), 'cc-haha-browser-use-service-'))
  invalidateBrowserUseConfigCache()
})

afterEach(() => {
  invalidateBrowserUseConfigCache()
  if (tempConfigDir) {
    rmSync(tempConfigDir, { recursive: true, force: true })
    tempConfigDir = null
  }
})

describe('BrowserUseService', () => {
  test('validates loopback bridge config and rejects non-loopback URLs', () => {
    expect(
      resolveElectronBridgeConfig({
        CC_HAHA_BROWSER_BRIDGE_URL: 'http://127.0.0.1:49100',
        CC_HAHA_BROWSER_BRIDGE_TOKEN: 'secret',
      }),
    ).toMatchObject({
      baseUrl: 'http://127.0.0.1:49100',
      wsUrl: 'ws://127.0.0.1:49100/ws',
      port: 49100,
    })

    expect(
      resolveElectronBridgeConfig({
        CC_HAHA_BROWSER_BRIDGE_URL: 'http://evil.example:49100',
        CC_HAHA_BROWSER_BRIDGE_TOKEN: 'secret',
      }),
    ).toBeNull()
  })

  test('routes Workspace Browser navigate/snapshot through Electron bridge without Origin header and blocks internal ports', async () => {
    const env = createEnv()
    saveBrowserUseConfig({ enabled: true, preferredTarget: 'workspace' }, { env })

    const fakeBridge = new FakeBridgeServer()
    const bridgeConfig = resolveElectronBridgeConfig(env)!
    const client = new ElectronBridgeRpcClient({
      config: bridgeConfig,
      fetchFn: fakeBridge.createFetch(),
      webSocketFactory: fakeBridge.createWebSocketFactory(),
    })

    const wsMessages: Array<{ sessionId: string; message: ServerMessage }> = []
    const service = new BrowserUseService({
      env,
      serverHost: '127.0.0.1',
      serverPort: 3456,
      bridgeClient: client,
      broadcastToSession: (sessionId, message) => {
        wsMessages.push({ sessionId, message })
        return true
      },
    })

    try {
      // Must block local server port (3456), bridge port (49991), and proxy port (49992)
      await expect(
        service.executeNavigate({
          sessionId: 'sess-1',
          url: 'http://127.0.0.1:3456/api/settings',
        }),
      ).rejects.toThrow(/internal application loopback port 3456/i)

      await expect(
        service.executeNavigate({
          sessionId: 'sess-1',
          url: 'http://127.0.0.1:49991/rpc',
        }),
      ).rejects.toThrow(/internal application loopback port 49991/i)

      await expect(
        service.executeNavigate({
          sessionId: 'sess-1',
          url: 'http://127.0.0.1:49992/',
        }),
      ).rejects.toThrow(/internal application loopback port 49992/i)

      // Ordinary localhost dev server (5173) is allowed!
      const nav = await service.executeNavigate({
        sessionId: 'sess-1',
        url: 'http://127.0.0.1:5173/',
        waitUntil: 'none',
      })
      expect(nav.tabId).toBe('ws-tab-1')
      expect(nav.target).toBe('workspace')

      const snap = await service.executeSnapshot({ sessionId: 'sess-1' })
      expect(snap.tabId).toBe('ws-tab-1')
      expect(snap.treeText).toContain('Run Tests')

      // Verify activity WS events were broadcast
      expect(
        wsMessages.some(
          m =>
            m.sessionId === 'sess-1' &&
            m.message.type === 'browser_use_activity' &&
            m.message.activity.kind === 'snapshot',
        ),
      ).toBe(true)

      // Turn-end cleanup releases control and CDP lease when no takeover is pending
      const cleanup = await service.cleanupAfterTurn({ sessionId: 'sess-1' })
      expect(cleanup).toEqual({ ok: true, preservedTakeover: false })
      expect(fakeBridge.rpcCalls.some(c => c.method === 'cdp.release')).toBe(true)
    } finally {
      await service.dispose()
    }
  })

  test('broadcasts takeover events, preserves pause on cleanup, and resumes turn cleanly', async () => {
    const env = createEnv()
    saveBrowserUseConfig({ enabled: true, preferredTarget: 'workspace' }, { env })

    const fakeBridge = new FakeBridgeServer()
    const client = new ElectronBridgeRpcClient({
      config: resolveElectronBridgeConfig(env)!,
      fetchFn: fakeBridge.createFetch(),
      webSocketFactory: fakeBridge.createWebSocketFactory(),
    })

    const wsMessages: Array<{ sessionId: string; message: ServerMessage }> = []
    const resumedTurns: Array<{ sessionId: string; content: string }> = []
    const service = new BrowserUseService({
      env,
      serverHost: '127.0.0.1',
      serverPort: 3456,
      bridgeClient: client,
      broadcastToSession: (sessionId, message) => {
        wsMessages.push({ sessionId, message })
        return true
      },
      submitResumeTurn: async (sessionId, content) => {
        resumedTurns.push({ sessionId, content })
      },
    })

    try {
      const takeover = await service.executeTakeover({
        sessionId: 'sess-takeover',
        reason: 'two_factor',
        message: 'Enter your 6-digit OTP code',
      })
      expect(takeover.status).toBe('pending')

      expect(
        wsMessages.some(
          m =>
            m.sessionId === 'sess-takeover' &&
            m.message.type === 'browser_use_takeover' &&
            m.message.takeover.status === 'pending',
        ),
      ).toBe(true)

      // Turn-end cleanup MUST preserve pending takeover state
      const cleanup = await service.cleanupAfterTurn({ sessionId: 'sess-takeover' })
      expect(cleanup).toEqual({ ok: true, preservedTakeover: true })

      // Resume clears takeover, broadcasts resumed status, and submits follow-up turn
      const resumed = await service.resumeTakeover({
        sessionId: 'sess-takeover',
        takeoverId: takeover.takeoverId,
        note: 'OTP verified',
      })
      expect(resumed.resumed).toBe(true)
      expect(resumed.takeover?.status).toBe('resumed')
      expect(resumedTurns).toHaveLength(1)
      expect(resumedTurns[0]?.content).toContain('OTP verified')

      // Stale/duplicate resume after already resumed is a no-op (no duplicate turn)
      const stale = await service.resumeTakeover({
        sessionId: 'sess-takeover',
        takeoverId: takeover.takeoverId,
      })
      expect(stale).toEqual({ resumed: false })
      expect(resumedTurns).toHaveLength(1)
    } finally {
      await service.dispose()
    }
  })

  test('deduplicates concurrent resumeTakeover and abortTakeover calls idempotently', async () => {
    const env = createEnv()
    saveBrowserUseConfig({ enabled: true, preferredTarget: 'workspace' }, { env })

    const fakeBridge = new FakeBridgeServer()
    const client = new ElectronBridgeRpcClient({
      config: resolveElectronBridgeConfig(env)!,
      fetchFn: fakeBridge.createFetch(),
      webSocketFactory: fakeBridge.createWebSocketFactory(),
    })

    const wsMessages: Array<{ sessionId: string; message: ServerMessage }> = []
    const resumedTurns: Array<{ sessionId: string; content: string }> = []
    const service = new BrowserUseService({
      env,
      serverHost: '127.0.0.1',
      serverPort: 3456,
      bridgeClient: client,
      broadcastToSession: (sessionId, message) => {
        wsMessages.push({ sessionId, message })
        return true
      },
      submitResumeTurn: async (sessionId, content) => {
        await Bun.sleep(15)
        resumedTurns.push({ sessionId, content })
      },
    })

    try {
      const takeover = await service.executeTakeover({
        sessionId: 'sess-race',
        reason: 'login',
        message: 'Sign in',
      })

      // Fire two concurrent resumeTakeover calls + a racing abortTakeover
      const [r1, r2, a1] = await Promise.all([
        service.resumeTakeover({ sessionId: 'sess-race', takeoverId: takeover.takeoverId }),
        service.resumeTakeover({ sessionId: 'sess-race', takeoverId: takeover.takeoverId }),
        service.abortTakeover({ sessionId: 'sess-race', takeoverId: takeover.takeoverId }),
      ])

      expect(r1.resumed).toBe(true)
      expect(r2).toEqual({ resumed: false })
      expect(a1).toEqual({})
      expect(resumedTurns).toHaveLength(1)

      const resumedEvents = wsMessages.filter(
        m =>
          m.sessionId === 'sess-race' &&
          m.message.type === 'browser_use_takeover' &&
          m.message.takeover.status === 'resumed',
      )
      expect(resumedEvents).toHaveLength(1)

      // Calling resume when no takeover is pending must not submit a turn
      const noOp = await service.resumeTakeover({ sessionId: 'sess-other' })
      expect(noOp).toEqual({ resumed: false })
      expect(resumedTurns).toHaveLength(1)

      // Concurrent abortTakeover calls are also strictly idempotent
      const takeover2 = await service.executeTakeover({
        sessionId: 'sess-race',
        reason: 'captcha',
        message: 'Solve captcha',
      })
      const [ab1, ab2] = await Promise.all([
        service.abortTakeover({ sessionId: 'sess-race', takeoverId: takeover2.takeoverId }),
        service.abortTakeover({ sessionId: 'sess-race', takeoverId: takeover2.takeoverId }),
      ])
      expect(ab1.takeover?.status).toBe('aborted')
      expect(ab2).toEqual({})
    } finally {
      await service.dispose()
    }
  })

  test('supports Chrome Live Attach connect/disconnect via ChromeConnectionManager', async () => {
    const env = createEnv()
    saveBrowserUseConfig({ enabled: true, preferredTarget: 'auto' }, { env })

    const fakeTransport: CdpTransport = {
      kind: 'chrome',
      async send(method) {
        if (method === 'Browser.getVersion') {
          return { product: 'Chrome/144.0.0.0' } as never
        }
        return {} as never
      },
      onEvent(_listener: CdpEventListener) {
        return () => {}
      },
      isConnected: () => true,
      async close() {},
    }

    const fakeChromeManager = new ChromeConnectionManager({
      platform: 'darwin',
      env,
      fs: {
        existsSync: path =>
          path.includes('Google Chrome') || path.endsWith('DevToolsActivePort'),
        readFileSync: () => '9222\n/devtools/browser/test-id\n',
        unlinkSync: () => {},
        mkdirSync: () => {},
      },
      transportFactory: async () => fakeTransport,
    })

    const service = new BrowserUseService({
      env,
      bridgeClient: null,
      chromeManager: fakeChromeManager,
      broadcastToSession: () => true,
    })

    try {
      const connected = await service.connectChrome({ browserId: 'chrome' })
      expect(connected.chrome.mode).toBe('live_attach')
      expect(connected.status.activeTarget).toBe('chrome')

      const afterDisconnect = await service.disconnectChrome()
      expect(afterDisconnect.chrome.mode).toBe('disconnected')
      expect(afterDisconnect.activeTarget).toBeNull()
    } finally {
      await service.dispose()
    }
  })

  test('sends cdp.acquire/release over WS, forwards sessionId+createNew on tabs.ensure, cleans up multi-tab leases, and handles user takeover/stop', async () => {
    const env = createEnv()
    saveBrowserUseConfig({ enabled: true, preferredTarget: 'workspace' }, { env })

    const fakeBridge = new FakeBridgeServer()
    const client = new ElectronBridgeRpcClient({
      config: resolveElectronBridgeConfig(env)!,
      fetchFn: fakeBridge.createFetch(),
      webSocketFactory: fakeBridge.createWebSocketFactory(),
    })

    const stoppedSessions: string[] = []
    const wsMessages: Array<{ sessionId: string; message: ServerMessage }> = []
    const service = new BrowserUseService({
      env,
      serverHost: '127.0.0.1',
      serverPort: 3456,
      bridgeClient: client,
      broadcastToSession: (sessionId, message) => {
        wsMessages.push({ sessionId, message })
        return true
      },
      stopSession: sessionId => {
        stoppedSessions.push(sessionId)
      },
    })

    try {
      // Open two tabs in the same turn
      const open1 = await service.executeTabs({
        sessionId: 'sess-multi',
        action: 'open',
        url: 'http://127.0.0.1:5173/a',
      })
      const open2 = await service.executeTabs({
        sessionId: 'sess-multi',
        action: 'open',
        url: 'http://127.0.0.1:5173/b',
      })
      const tab1Id = (open1.tab as { tabId: string }).tabId
      const tab2Id = (open2.tab as { tabId: string }).tabId
      expect(tab1Id).not.toBe(tab2Id)

      // Verify tabs.ensure received sessionId + createNew: true
      const ensureCalls = fakeBridge.rpcCalls.filter(c => c.method === 'tabs.ensure')
      expect(ensureCalls[0]?.params).toMatchObject({
        sessionId: 'sess-multi',
        createNew: true,
      })

      // Snapshot both tabs so leases are acquired over WS
      await service.executeSnapshot({ sessionId: 'sess-multi', tabId: tab1Id })
      await service.executeSnapshot({ sessionId: 'sess-multi', tabId: tab2Id })

      const acquireCalls = fakeBridge.rpcCalls.filter(c => c.method === 'cdp.acquire')
      expect(acquireCalls.length).toBeGreaterThanOrEqual(2)
      expect(acquireCalls.every(c => c.transport === 'ws')).toBe(true)

      // Turn-end cleanup must release BOTH tabs over WS
      await service.cleanupAfterTurn({ sessionId: 'sess-multi' })
      const releaseCalls = fakeBridge.rpcCalls.filter(c => c.method === 'cdp.release')
      expect(releaseCalls.every(c => c.transport === 'ws')).toBe(true)
      expect(releaseCalls.map(c => c.params.tabId)).toEqual(
        expect.arrayContaining([tab1Id, tab2Id]),
      )

      // Turn 2: re-acquiring lease must re-enable Page.enable (domains reset!)
      const pageEnableBefore = fakeBridge.rpcCalls.filter(
        c => c.method === 'cdp.send' && c.params.method === 'Page.enable',
      ).length
      await service.executeSnapshot({ sessionId: 'sess-multi', tabId: tab1Id })
      const pageEnableAfter = fakeBridge.rpcCalls.filter(
        c => c.method === 'cdp.send' && c.params.method === 'Page.enable',
      ).length
      expect(pageEnableAfter).toBeGreaterThan(pageEnableBefore)

      // User-initiated takeover via bridge must NOT use raw 'user_requested' as message AND must stop active turn
      fakeBridge.emitPush('ui.takeover', {
        tabId: tab1Id,
        action: 'takeover',
        reason: 'user_requested',
      })
      await Bun.sleep(10)
      const takeoverEv = wsMessages.find(
        m =>
          m.sessionId === 'sess-multi' &&
          m.message.type === 'browser_use_takeover' &&
          m.message.takeover.status === 'pending',
      )
      expect(takeoverEv).toBeDefined()
      if (takeoverEv?.message.type === 'browser_use_takeover') {
        expect(takeoverEv.message.takeover.message).not.toBe('user_requested')
      }
      expect(stoppedSessions).toContain('sess-multi')

      // Clear takeover, then test non-desktop Stop on an active run (no pending takeover)
      await service.abortTakeover({ sessionId: 'sess-multi' })
      stoppedSessions.length = 0
      await service.executeSnapshot({ sessionId: 'sess-multi', tabId: tab1Id })
      const stopRes = await service.abortTakeover({
        sessionId: 'sess-multi',
        reason: 'user_stopped',
      })
      expect(stopRes.stopped).toBe(true)
      expect(stoppedSessions).toEqual(['sess-multi'])
    } finally {
      await service.dispose()
    }
  })

  test('executes full Chrome target operations (tabs/navigate/snapshot/act/inspect/takeover/cleanup) and target resolution errors', async () => {
    const env = createEnv()
    saveBrowserUseConfig({ enabled: false, preferredTarget: 'auto' }, { env })

    let connected = false
    let targetSeq = 1
    const fakeTransport: CdpTransport = {
      kind: 'chrome',
      async send(method, params) {
        if (method === 'Browser.getVersion') return { product: 'Chrome/144.0.0.0' } as never
        if (method === 'Target.getTargets') {
          return {
            targetInfos: [
              { targetId: 'chrome-t-1', type: 'page', title: 'Chrome App', url: 'https://chrome.example' },
            ],
          } as never
        }
        if (method === 'Target.createTarget') {
          return { targetId: `chrome-t-${targetSeq++}` } as never
        }
        if (method === 'Target.attachToTarget') {
          return { sessionId: `chrome-sess-${String(params?.targetId)}` } as never
        }
        if (method === 'Page.getFrameTree') {
          return {
            frameTree: {
              frame: { id: 'f1', loaderId: 'l1', url: 'https://chrome.example' },
            },
          } as never
        }
        if (method === 'Page.navigate') return { frameId: 'f1', loaderId: 'l2' } as never
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Chrome App' }, childIds: [] },
            ],
          } as never
        }
        if (method === 'Runtime.evaluate') {
          const expr = String(params?.expression ?? '')
          if (expr.includes('document.title')) return { result: { value: 'Chrome App' } } as never
          if (expr.includes('location.href')) return { result: { value: 'https://chrome.example' } } as never
          return { result: { value: 'Chrome text' } } as never
        }
        return {} as never
      },
      onEvent: () => () => {},
      isConnected: () => connected,
      async close() {
        connected = false
      },
    }

    const fakeChromeManager = new ChromeConnectionManager({
      platform: 'darwin',
      env,
      fs: {
        existsSync: p => p.includes('Google Chrome') || p.endsWith('DevToolsActivePort'),
        readFileSync: () => '9222\n/devtools/browser/test\n',
        unlinkSync: () => {},
        mkdirSync: () => {},
      },
      transportFactory: async () => {
        connected = true
        return fakeTransport
      },
    })

    const service = new BrowserUseService({
      env,
      bridgeClient: null,
      chromeManager: fakeChromeManager,
      broadcastToSession: () => true,
    })

    try {
      // Disabled error
      await expect(service.executeSnapshot({ sessionId: 's1' })).rejects.toThrow(/Browser Use is disabled/)

      // Enable, test unavailable targets
      service.updateConfig({ enabled: true, preferredTarget: 'chrome' })
      await expect(service.executeSnapshot({ sessionId: 's1' })).rejects.toThrow(/System Chrome is not connected/)

      service.updateConfig({ preferredTarget: 'workspace' })
      await expect(service.executeSnapshot({ sessionId: 's1' })).rejects.toThrow(/Workspace Browser bridge is unavailable/)

      service.updateConfig({ preferredTarget: 'auto' })
      await expect(service.executeSnapshot({ sessionId: 's1' })).rejects.toThrow(/No Browser Use target is ready/)

      // Connect Chrome and exercise all Chrome operations
      await service.connectChrome({ browserId: 'chrome' })
      const openRes = await service.executeTabs({
        sessionId: 's1',
        action: 'open',
        url: 'https://chrome.example',
        target: 'chrome',
      })
      const tabId = (openRes.tab as { tabId: string }).tabId

      const listRes = await service.executeTabs({ sessionId: 's1', action: 'list', target: 'chrome' })
      expect(Array.isArray(listRes.tabs)).toBe(true)

      const focusRes = await service.executeTabs({ sessionId: 's1', action: 'focus', tabId, target: 'chrome' })
      expect(focusRes.ok).toBe(true)

      const nav = await service.executeNavigate({
        sessionId: 's1',
        tabId,
        url: 'https://chrome.example/next',
        waitUntil: 'none',
        target: 'chrome',
      })
      expect(nav.target).toBe('chrome')

      const snap = await service.executeSnapshot({ sessionId: 's1', tabId, target: 'chrome' })
      expect(snap.target).toBe('chrome')

      const act = await service.executeAct({
        sessionId: 's1',
        tabId,
        target: 'chrome',
        steps: [{ action: 'wait', ms: 1 }],
      })
      expect(act.completedSteps).toBe(1)

      const inspect = await service.executeInspect({
        sessionId: 's1',
        tabId,
        target: 'chrome',
        kind: 'text',
      })
      expect(inspect.target).toBe('chrome')

      // Hot-update config applies overlay/ports cleanly
      service.updateConfig({ showCursorOverlay: false, blockedLoopbackPorts: [8888] })
      await service.cleanupAfterTurn({ sessionId: 's1' })

      const tk = await service.executeTakeover({
        sessionId: 's1',
        tabId,
        target: 'chrome',
        reason: 'payment',
        message: 'Confirm order',
      })
      expect(tk.status).toBe('pending')

      const status = await service.getStatus()
      expect(status.controlState).toBe('takeover')

      await service.abortTakeover({ sessionId: 's1', takeoverId: tk.takeoverId })
      const closeRes = await service.executeTabs({ sessionId: 's1', action: 'close', tabId, target: 'chrome' })
      expect(closeRes.ok).toBe(true)
    } finally {
      await service.dispose()
    }
  })

  test('covers ElectronBridgeRpcClient HTTP fallback, WS errors/close, workspace tabs focus/close, tab.closed, and bridge resume/cancel', async () => {
    const env = createEnv()
    saveBrowserUseConfig({ enabled: true, preferredTarget: 'workspace', showCursorOverlay: false }, { env })

    const fakeBridge = new FakeBridgeServer()
    const client = new ElectronBridgeRpcClient({
      config: resolveElectronBridgeConfig(env)!,
      fetchFn: fakeBridge.createFetch(),
      webSocketFactory: fakeBridge.createWebSocketFactory(),
    })

    const resumedTurns: string[] = []
    const service = new BrowserUseService({
      env,
      serverHost: '127.0.0.1',
      serverPort: 3456,
      bridgeClient: client,
      broadcastToSession: () => true,
      submitResumeTurn: async (_s, msg) => {
        resumedTurns.push(msg)
      },
      stopSession: () => {},
    })

    try {
      const listRes = await service.executeTabs({ sessionId: 's-ws', action: 'list' })
      expect(Array.isArray(listRes.tabs)).toBe(true)

      const focusRes = await service.executeTabs({
        sessionId: 's-ws',
        action: 'focus',
        tabId: 'ws-tab-1',
      })
      expect(focusRes.ok).toBe(true)

      // Execute snapshot, then trigger bridge push resume + cancel + tab.closed
      await service.executeSnapshot({ sessionId: 's-ws', tabId: 'ws-tab-1' })
      await service.executeAct({
        sessionId: 's-ws',
        tabId: 'ws-tab-1',
        steps: [{ action: 'wait', ms: 1 }],
      })
      await service.executeInspect({
        sessionId: 's-ws',
        tabId: 'ws-tab-1',
        kind: 'console',
      })
      await service.executeTakeover({
        sessionId: 's-ws',
        tabId: 'ws-tab-1',
        reason: 'login',
        message: 'Sign in',
      })
      fakeBridge.emitPush('ui.takeover', { tabId: 'ws-tab-1', action: 'resume' })
      await Bun.sleep(15)
      expect(resumedTurns).toHaveLength(1)

      await service.executeTakeover({
        sessionId: 's-ws',
        tabId: 'ws-tab-1',
        reason: 'captcha',
        message: 'Captcha',
      })
      fakeBridge.emitPush('ui.takeover', { tabId: 'ws-tab-1', action: 'cancel' })
      await Bun.sleep(15)

      fakeBridge.emitPush('cdp.event', {
        tabId: 'ws-tab-1',
        method: 'Inspector.detached',
        params: { reason: 'target_closed' },
      })
      fakeBridge.emitPush('tab.closed', { tabId: 'ws-tab-1', reason: 'closed' })

      const closeRes = await service.executeTabs({
        sessionId: 's-ws',
        action: 'close',
        tabId: 'ws-tab-1',
      })
      expect(closeRes.ok).toBe(true)

      // Test HTTP fallback when WS is unavailable (readyState = 3)
      const fallbackClient = new ElectronBridgeRpcClient({
        config: resolveElectronBridgeConfig(env)!,
        fetchFn: fakeBridge.createFetch(),
        webSocketFactory: () => ({
          readyState: 3,
          send() {},
          close() {},
          addEventListener() {},
        }),
      })
      const httpAcquire = await fallbackClient.rpcOverWs('cdp.acquire', { tabId: 'ws-tab-2' })
      expect(httpAcquire.leaseId).toBe('lease-ws-tab-2')
      await fallbackClient.close()
      await expect(fallbackClient.rpc('tabs.list')).rejects.toThrow(/closed/)

      // Exercise host singleton lifecycle helpers
      const disposeHost = configureBrowserUseHost('127.0.0.1', 3456)
      expect(getBrowserUseService()).toBeDefined()
      disposeHost()
      resetBrowserUseServiceForTests()
    } finally {
      await service.dispose()
    }
  })
})
