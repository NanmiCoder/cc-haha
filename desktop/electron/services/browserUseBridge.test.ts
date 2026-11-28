import http from 'node:http'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  computeCursorWaitCeilingMs,
  ElectronBrowserBridge,
  isLoopbackRemoteAddress,
  verifyBearerToken,
  type BrowserUseBridgeTabInfo,
  type BrowserUseRendererEvent,
  type BrowserUseWorkspaceHost,
} from './browserUseBridge'
import { DebuggerLeaseManager, type WorkspaceBrowserCdpWebContentsLike } from './workspaceBrowserCdp'

const bridges: ElectronBrowserBridge[] = []
const openSockets = new Set<net.Socket>()

afterEach(async () => {
  for (const socket of openSockets) socket.destroy()
  openSockets.clear()
  await Promise.all(bridges.splice(0).map(bridge => bridge.dispose()))
})

function createMockWorkspaceHost() {
  const closedListeners = new Set<(event: { tabId: string, reason: 'closed' | 'crashed' }) => void>()
  const pages = new Map<string, BrowserUseBridgeTabInfo>()
  const cdpSent: Array<{ method: string, params?: Record<string, unknown> }> = []
  let attached = false
  const fakeWc: WorkspaceBrowserCdpWebContentsLike = {
    isDestroyed: () => false,
    debugger: {
      isAttached: () => attached,
      attach: () => { attached = true },
      detach: () => { attached = false },
      sendCommand: async (method, params) => {
        cdpSent.push({ method, params })
        if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 1024, height: 768 } }
        return { method, ok: true }
      },
    },
  }
  const cdp = new DebuggerLeaseManager({
    resolveWebContents: tabId => (pages.has(tabId) ? fakeWc : null),
    idleGraceMs: 0,
  })
  const agentControlCalls: Array<{ tabId: string, active: boolean }> = []
  const closedTabs: string[] = []

  const host: BrowserUseWorkspaceHost = {
    listPages: options => {
      const all = [...pages.values()]
      return options?.sessionId ? all.filter(page => page.sessionId === options.sessionId) : all
    },
    getPageInfo: tabId => pages.get(tabId) ?? null,
    getPageZoomFactor: tabId => {
      const page = pages.get(tabId)
      if (!page) throw new Error(`workspace browser tab not open: ${tabId}`)
      return page.zoomFactor
    },
    getAppZoomFactor: () => 1.25,
    close: tabId => {
      closedTabs.push(tabId)
      pages.delete(tabId)
      cdp.handleTabClosed(tabId, 'closed')
      for (const listener of closedListeners) listener({ tabId, reason: 'closed' })
    },
    setAgentControlActive: async (tabId, active) => {
      agentControlCalls.push({ tabId, active })
    },
    getCdpManager: () => cdp,
    onPageClosed: listener => {
      closedListeners.add(listener)
      return () => closedListeners.delete(listener)
    },
  }

  return {
    host,
    pages,
    cdp,
    cdpSent,
    agentControlCalls,
    closedTabs,
    isAttached: () => attached,
    emitPageClosed: (tabId: string, reason: 'closed' | 'crashed') => {
      pages.delete(tabId)
      for (const listener of closedListeners) listener({ tabId, reason })
    },
  }
}

async function startTestBridge(options: {
  token?: string
  isRendererVisible?: () => boolean
  emitToRenderer?: (event: BrowserUseRendererEvent) => boolean
  ensureTabTimeoutMs?: number
} = {}) {
  const token = options.token ?? randomBytes(32).toString('base64url')
  const workspace = createMockWorkspaceHost()
  const rendererEvents: BrowserUseRendererEvent[] = []
  const bridge = new ElectronBrowserBridge({
    token,
    workspaceBrowser: workspace.host,
    emitToRenderer: event => {
      rendererEvents.push(event)
      return options.emitToRenderer ? options.emitToRenderer(event) : true
    },
    isRendererVisible: options.isRendererVisible,
    ensureTabTimeoutMs: options.ensureTabTimeoutMs,
  })
  bridges.push(bridge)
  const url = await bridge.start()
  return { bridge, url, token, workspace, rendererEvents }
}

function httpRequest(
  baseUrl: string,
  path: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string
  } = {},
): Promise<{ status: number, body: string }> {
  const target = new URL(path, baseUrl)
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: target.hostname,
      port: Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: options.method ?? 'GET',
      headers: options.headers,
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end(options.body)
  })
}

function openRawWsUpgrade(
  baseUrl: string,
  headers: Record<string, string>,
  path = '/ws',
): Promise<{ statusLine: string, socket: net.Socket, initialRest: Buffer }> {
  const target = new URL(baseUrl)
  const key = randomBytes(16).toString('base64')
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: target.hostname, port: Number(target.port) })
    openSockets.add(socket)
    socket.once('close', () => openSockets.delete(socket))
    let buf = Buffer.alloc(0)
    socket.once('connect', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${target.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ]
      socket.write(lines.join('\r\n'))
    })
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      const idx = buf.indexOf('\r\n\r\n')
      if (idx < 0) return
      socket.off('data', onData)
      const headerText = buf.subarray(0, idx).toString('latin1')
      const statusLine = headerText.split('\r\n', 1)[0] ?? ''
      resolve({ statusLine, socket, initialRest: buf.subarray(idx + 4) })
    }
    socket.on('data', onData)
    socket.once('error', reject)
  })
}

function createMaskedClientTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const mask = randomBytes(4)
  const masked = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) {
    masked[i] = payload[i]! ^ mask[i & 3]!
  }
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.allocUnsafe(2)
    header[0] = 0x81
    header[1] = 0x80 | payload.length
  } else {
    header = Buffer.allocUnsafe(4)
    header[0] = 0x81
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  }
  return Buffer.concat([header, mask, masked])
}

function readServerWsMessages(socket: net.Socket, initialRest: Buffer) {
  let buf = initialRest
  const queue: unknown[] = []
  const waiters: Array<(msg: unknown) => void> = []

  const drain = () => {
    while (buf.length >= 2) {
      const opcode = buf[0]! & 0x0f
      let len = buf[1]! & 0x7f
      let offset = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        len = Number(buf.readBigUInt64BE(2))
        offset = 10
      }
      if (buf.length < offset + len) return
      const payload = buf.subarray(offset, offset + len)
      buf = buf.subarray(offset + len)
      if (opcode === 0x1) {
        const parsed = JSON.parse(payload.toString('utf8')) as unknown
        const waiter = waiters.shift()
        if (waiter) waiter(parsed)
        else queue.push(parsed)
      }
    }
  }
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    drain()
  })
  drain()

  return {
    next(): Promise<unknown> {
      if (queue.length > 0) return Promise.resolve(queue.shift()!)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for WS message')), 2_000)
        waiters.push(msg => {
          clearTimeout(timer)
          resolve(msg)
        })
      })
    },
  }
}

describe('ElectronBrowserBridge security & auth helpers', () => {
  it('validates loopback remote addresses and timing-safe bearer tokens', () => {
    expect(isLoopbackRemoteAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackRemoteAddress('::1')).toBe(true)
    expect(isLoopbackRemoteAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackRemoteAddress('192.168.1.10')).toBe(false)
    expect(isLoopbackRemoteAddress('0.0.0.0')).toBe(false)
    expect(isLoopbackRemoteAddress(undefined)).toBe(false)

    expect(verifyBearerToken('Bearer secret-token', 'secret-token')).toBe(true)
    expect(verifyBearerToken('Bearer wrong-token', 'secret-token')).toBe(false)
    expect(verifyBearerToken('Bearer short', 'secret-token')).toBe(false)
    expect(verifyBearerToken('Basic secret-token', 'secret-token')).toBe(false)
    expect(verifyBearerToken(undefined, 'secret-token')).toBe(false)
  })

  it('caps cursor arrival wait ceiling at Math.min(durationMs + 250, 750)ms', () => {
    expect(computeCursorWaitCeilingMs(0)).toBe(250)
    expect(computeCursorWaitCeilingMs(200)).toBe(450)
    expect(computeCursorWaitCeilingMs(500)).toBe(750)
    expect(computeCursorWaitCeilingMs(5_000)).toBe(750)
  })

  it('binds strictly to 127.0.0.1 and rejects missing auth or any Origin header on HTTP and WS', async () => {
    const { url, token } = await startTestBridge()
    expect(new URL(url).hostname).toBe('127.0.0.1')

    const noAuth = await httpRequest(url, '/health')
    expect(noAuth.status).toBe(401)

    const wrongAuth = await httpRequest(url, '/health', {
      headers: { Authorization: 'Bearer wrong-token' },
    })
    expect(wrongAuth.status).toBe(401)

    const withOrigin = await httpRequest(url, '/health', {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'http://127.0.0.1:3000',
      },
    })
    expect(withOrigin.status).toBe(403)

    const ok = await httpRequest(url, '/health', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body)).toEqual({ ok: true })

    // WebSocket upgrade rejects Origin and invalid token.
    const wsOrigin = await openRawWsUpgrade(url, {
      Authorization: `Bearer ${token}`,
      Origin: 'https://evil.example',
    })
    expect(wsOrigin.statusLine).toContain('403')
    wsOrigin.socket.destroy()

    const wsBadToken = await openRawWsUpgrade(url, {
      Authorization: 'Bearer invalid',
    })
    expect(wsBadToken.statusLine).toContain('401')
    wsBadToken.socket.destroy()
  })
})

describe('ElectronBrowserBridge JSON-RPC, WS push events & cursor ceiling', () => {
  it('handles HTTP and WebSocket JSON-RPC calls, CDP allowlist enforcement, and push events', async () => {
    const { bridge, url, token, workspace, rendererEvents } = await startTestBridge()
    workspace.pages.set('tab-1', {
      tabId: 'tab-1',
      url: 'https://example.test/',
      title: 'Example',
      visible: true,
      zoomFactor: 1.5,
      appZoomFactor: 1.25,
    })

    // HTTP POST /rpc works and enforces CDP allowlist.
    const listRes = await httpRequest(url, '/rpc', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: 1, method: 'tabs.list' }),
    })
    expect(listRes.status).toBe(200)
    expect(JSON.parse(listRes.body)).toEqual({
      id: 1,
      result: {
        tabs: [{
          tabId: 'tab-1',
          url: 'https://example.test/',
          title: 'Example',
          visible: true,
          zoomFactor: 1.5,
          appZoomFactor: 1.25,
        }],
      },
    })

    const forbiddenCdp = await httpRequest(url, '/rpc', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: 2,
        method: 'cdp.send',
        params: { tabId: 'tab-1', method: 'Storage.getCookies' },
      }),
    })
    expect(JSON.parse(forbiddenCdp.body)).toMatchObject({
      id: 2,
      error: { code: 'CDP_METHOD_FORBIDDEN' },
    })

    // Authenticated WebSocket connection without Origin succeeds.
    const ws = await openRawWsUpgrade(url, { Authorization: `Bearer ${token}` })
    expect(ws.statusLine).toContain('101')
    const reader = readServerWsMessages(ws.socket, ws.initialRest)

    // cdp.acquire + cdp.send over WS
    ws.socket.write(createMaskedClientTextFrame(JSON.stringify({
      id: 'acq-1',
      method: 'cdp.acquire',
      params: { tabId: 'tab-1' },
    })))
    const acq = await reader.next() as { id: string, result: { leaseId: string, zoomFactor: number, appZoomFactor: number } }
    expect(acq.id).toBe('acq-1')
    expect(acq.result.zoomFactor).toBe(1.5)
    expect(acq.result.appZoomFactor).toBe(1.25)
    expect(workspace.isAttached()).toBe(true)

    ws.socket.write(createMaskedClientTextFrame(JSON.stringify({
      id: 'send-1',
      method: 'cdp.send',
      params: { tabId: 'tab-1', leaseId: acq.result.leaseId, method: 'Page.getLayoutMetrics' },
    })))
    expect(await reader.next()).toEqual({
      id: 'send-1',
      result: { cssContentSize: { width: 1024, height: 768 } },
    })

    // ui.controlState activates preview-agent suppression and emits to renderer
    ws.socket.write(createMaskedClientTextFrame(JSON.stringify({
      id: 'ctrl-1',
      method: 'ui.controlState',
      params: { tabId: 'tab-1', state: 'active', actionLabel: 'Clicking submit' },
    })))
    expect(await reader.next()).toEqual({ id: 'ctrl-1', result: { ok: true } })
    expect(workspace.agentControlCalls).toContainEqual({ tabId: 'tab-1', active: true })
    expect(rendererEvents.at(-1)).toMatchObject({
      type: 'control-state',
      tabId: 'tab-1',
      state: 'active',
      actionLabel: 'Clicking submit',
    })

    // Server push events: cdp.event, ui.takeover, tab.closed
    bridge.pushCdpEvent({ tabId: 'tab-1', method: 'Page.frameNavigated', params: { frame: { id: 'f1' } } })
    expect(await reader.next()).toEqual({
      event: 'cdp.event',
      params: { tabId: 'tab-1', method: 'Page.frameNavigated', params: { frame: { id: 'f1' } } },
    })

    bridge.handleRendererUserAction({ tabId: 'tab-1', action: 'takeover', reason: 'user_clicked' })
    expect(await reader.next()).toEqual({
      event: 'ui.takeover',
      params: { tabId: 'tab-1', action: 'takeover', reason: 'user_clicked' },
    })
    expect(workspace.agentControlCalls.at(-1)).toEqual({ tabId: 'tab-1', active: false })

    // Closing WS client automatically releases its tracked CDP leases.
    ws.socket.destroy()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(workspace.cdp.getLeaseCount('tab-1')).toBe(0)
    expect(workspace.isAttached()).toBe(false)
  })

  it('completes tabs.ensure handshake with renderer and returns registered tab info', async () => {
    const { bridge, url, token, workspace } = await startTestBridge({
      emitToRenderer: event => {
        if (event.type === 'ensure-tab') {
          queueMicrotask(() => {
            workspace.pages.set('wb-new', {
              tabId: 'wb-new',
              url: event.url ?? 'https://docs.test/',
              title: 'Docs',
              visible: true,
              zoomFactor: 1,
              appZoomFactor: 1.25,
            })
            bridge.handleRendererTabReady({ requestId: event.requestId, tabId: 'wb-new', ok: true })
          })
        }
        return true
      },
    })

    const res = await httpRequest(url, '/rpc', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'ensure-1',
        method: 'tabs.ensure',
        params: { url: 'https://docs.test/', focus: true, revealWorkbench: true },
      }),
    })
    expect(JSON.parse(res.body)).toEqual({
      id: 'ensure-1',
      result: {
        tabId: 'wb-new',
        url: 'https://docs.test/',
        title: 'Docs',
        visible: true,
        zoomFactor: 1,
        appZoomFactor: 1.25,
      },
    })
  })

  it('forwards sessionId and createNew on tabs.ensure without reusing an existing tabId', async () => {
    const { bridge, url, token, workspace, rendererEvents } = await startTestBridge({
      emitToRenderer: event => {
        if (event.type === 'ensure-tab') {
          queueMicrotask(() => {
            workspace.pages.set('wb-created', {
              tabId: 'wb-created',
              url: event.url ?? 'https://fresh.test/',
              title: 'Fresh',
              visible: true,
              zoomFactor: 1,
              appZoomFactor: 1.25,
            })
            bridge.handleRendererTabReady({ requestId: event.requestId, tabId: 'wb-created', ok: true })
          })
        }
        return true
      },
    })
    workspace.pages.set('wb-existing', {
      tabId: 'wb-existing',
      url: 'https://old.test/',
      title: 'Old',
      visible: true,
      zoomFactor: 1,
      appZoomFactor: 1.25,
    })

    const res = await httpRequest(url, '/rpc', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'ensure-new',
        method: 'tabs.ensure',
        params: {
          sessionId: 'sess-42',
          tabId: 'wb-existing',
          url: 'https://fresh.test/',
          createNew: true,
          focus: false,
          revealWorkbench: true,
        },
      }),
    })
    expect(JSON.parse(res.body)).toMatchObject({
      id: 'ensure-new',
      result: { tabId: 'wb-created', url: 'https://fresh.test/' },
    })
    const ensureEvent = rendererEvents.find(e => e.type === 'ensure-tab')
    expect(ensureEvent).toMatchObject({
      type: 'ensure-tab',
      sessionId: 'sess-42',
      url: 'https://fresh.test/',
      createNew: true,
      focus: false,
      revealWorkbench: true,
    })
    expect(ensureEvent && 'tabId' in ensureEvent ? ensureEvent.tabId : undefined).toBeUndefined()
  })

  it('releases all WS CDP leases and resets active agent control to idle on abrupt sidecar disconnect', async () => {
    const { url, token, workspace, rendererEvents } = await startTestBridge()
    workspace.pages.set('tab-1', {
      tabId: 'tab-1',
      url: 'https://one.test/',
      title: 'One',
      visible: true,
      zoomFactor: 1,
      appZoomFactor: 1.25,
    })
    workspace.pages.set('tab-2', {
      tabId: 'tab-2',
      url: 'https://two.test/',
      title: 'Two',
      visible: false,
      zoomFactor: 1,
      appZoomFactor: 1.25,
    })

    const ws = await openRawWsUpgrade(url, { Authorization: `Bearer ${token}` })
    expect(ws.statusLine).toContain('101')
    const reader = readServerWsMessages(ws.socket, ws.initialRest)

    ws.socket.write(createMaskedClientTextFrame(JSON.stringify({ id: 'l1', method: 'cdp.acquire', params: { tabId: 'tab-1' } })))
    await reader.next()
    ws.socket.write(createMaskedClientTextFrame(JSON.stringify({ id: 'l2', method: 'cdp.acquire', params: { tabId: 'tab-2' } })))
    await reader.next()
    ws.socket.write(createMaskedClientTextFrame(JSON.stringify({
      id: 'c1',
      method: 'ui.controlState',
      params: { tabId: 'tab-1', state: 'active', actionLabel: 'Clicking' },
    })))
    await reader.next()

    expect(workspace.cdp.getLeaseCount('tab-1')).toBe(1)
    expect(workspace.cdp.getLeaseCount('tab-2')).toBe(1)
    expect(workspace.isAttached()).toBe(true)

    rendererEvents.length = 0
    workspace.agentControlCalls.length = 0
    ws.socket.destroy()
    await new Promise(resolve => setTimeout(resolve, 40))

    expect(workspace.cdp.getLeaseCount('tab-1')).toBe(0)
    expect(workspace.cdp.getLeaseCount('tab-2')).toBe(0)
    expect(workspace.isAttached()).toBe(false)
    expect(workspace.agentControlCalls).toContainEqual({ tabId: 'tab-1', active: false })
    expect(workspace.agentControlCalls).toContainEqual({ tabId: 'tab-2', active: false })
    expect(rendererEvents).toContainEqual({ type: 'control-state', tabId: 'tab-1', state: 'idle' })
  })

  it('never deadlocks ui.moveCursor when renderer is hidden, aborted, or frozen', async () => {
    // 1) Hidden renderer resolves immediately with skipped: true
    const hidden = await startTestBridge({ isRendererVisible: () => false })
    const hiddenRes = await httpRequest(hidden.url, '/rpc', {
      method: 'POST',
      headers: { Authorization: `Bearer ${hidden.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'm1',
        method: 'ui.moveCursor',
        params: { tabId: 'tab-1', moveId: 'move-hidden', x: 100, y: 200, durationMs: 400 },
      }),
    })
    expect(JSON.parse(hiddenRes.body)).toEqual({
      id: 'm1',
      result: { moveId: 'move-hidden', arrived: false, skipped: true },
    })

    // 2) Visible renderer that ACKs resolves immediately with arrived: true
    const visible = await startTestBridge({
      isRendererVisible: () => true,
      emitToRenderer: event => {
        if (event.type === 'move-cursor') {
          queueMicrotask(() => {
            visible.bridge.handleRendererCursorArrived({
              moveId: event.moveId,
              tabId: event.tabId,
              skipped: false,
            })
          })
        }
        return true
      },
    })
    const ackRes = await httpRequest(visible.url, '/rpc', {
      method: 'POST',
      headers: { Authorization: `Bearer ${visible.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'm2',
        method: 'ui.moveCursor',
        params: { tabId: 'tab-1', moveId: 'move-ok', x: 100, y: 200, durationMs: 200 },
      }),
    })
    expect(JSON.parse(ackRes.body)).toEqual({
      id: 'm2',
      result: { moveId: 'move-ok', arrived: true, skipped: false },
    })

    // 3) AbortSignal resolves waitForCursorArrival immediately
    const controller = new AbortController()
    const waitPromise = visible.bridge.waitForCursorArrival('move-abort', 500, controller.signal)
    controller.abort()
    await expect(waitPromise).resolves.toEqual({ moveId: 'move-abort', arrived: false, skipped: true })

    // 4) Frozen renderer hits the hard ceiling (durationMs=0 -> 250ms ceiling)
    vi.useFakeTimers()
    try {
      const frozenPromise = visible.bridge.waitForCursorArrival('move-frozen', 0)
      vi.advanceTimersByTime(250)
      await expect(frozenPromise).resolves.toEqual({ moveId: 'move-frozen', arrived: false, skipped: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('isolates tabs.list, tabs.ensure, tabs.focus, and tabs.close by sessionId', async () => {
    const { bridge, url, token, workspace, rendererEvents } = await startTestBridge({
      emitToRenderer: event => {
        if (event.type === 'ensure-tab') {
          queueMicrotask(() => {
            workspace.pages.set('wb-sess-b', {
              tabId: 'wb-sess-b',
              sessionId: event.sessionId,
              url: event.url ?? 'about:blank',
              title: 'Session B',
              visible: true,
              zoomFactor: 1,
              appZoomFactor: 1.25,
            })
            bridge.handleRendererTabReady({ requestId: event.requestId, tabId: 'wb-sess-b', ok: true })
          })
        }
        return true
      },
    })

    workspace.pages.set('wb-sess-a', {
      tabId: 'wb-sess-a',
      sessionId: 'sess-a',
      url: 'https://modeldial.com/',
      title: 'ModelDial',
      visible: true,
      zoomFactor: 1,
      appZoomFactor: 1.25,
    })

    // 1. tabs.list scoped to sess-b must not return sess-a's tab.
    const listB = await httpRequest(url, '/rpc', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'list-b', method: 'tabs.list', params: { sessionId: 'sess-b' } }),
    })
    expect(JSON.parse(listB.body)).toEqual({ id: 'list-b', result: { tabs: [] } })

    const listA = await httpRequest(url, '/rpc', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'list-a', method: 'tabs.list', params: { sessionId: 'sess-a' } }),
    })
    expect(JSON.parse(listA.body).result.tabs.map((t: { tabId: string }) => t.tabId)).toEqual(['wb-sess-a'])

    // 2. tabs.ensure for sess-b with sess-a's tabId must NOT reuse wb-sess-a;
    // it drops the foreign tabId and asks the renderer to ensure a tab for sess-b.
    const ensureB = await httpRequest(url, '/rpc', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'ensure-b',
        method: 'tabs.ensure',
        params: { sessionId: 'sess-b', tabId: 'wb-sess-a', url: 'https://modeldial.com/subscriptions' },
      }),
    })
    expect(JSON.parse(ensureB.body)).toMatchObject({
      id: 'ensure-b',
      result: { tabId: 'wb-sess-b', sessionId: 'sess-b' },
    })
    const ensureEvent = rendererEvents.find(e => e.type === 'ensure-tab')
    expect(ensureEvent).toMatchObject({ type: 'ensure-tab', sessionId: 'sess-b' })
    expect(ensureEvent && 'tabId' in ensureEvent ? ensureEvent.tabId : undefined).toBeUndefined()

    // 3. tabs.focus / tabs.close reject foreign session tabs.
    const badFocus = await httpRequest(url, '/rpc', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'focus-bad', method: 'tabs.focus', params: { sessionId: 'sess-b', tabId: 'wb-sess-a' } }),
    })
    expect(JSON.parse(badFocus.body).error.message).toMatch(/belongs to another session/)

    const badClose = await httpRequest(url, '/rpc', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'close-bad', method: 'tabs.close', params: { sessionId: 'sess-b', tabId: 'wb-sess-a' } }),
    })
    expect(JSON.parse(badClose.body).error.message).toMatch(/belongs to another session/)
    expect(workspace.closedTabs).toEqual([])

    // 4. Untagged pages are also rejected when a caller scopes focus/close by sessionId,
    // and ui.controlState rejects mismatched sessionId.
    workspace.pages.set('wb-untagged', {
      tabId: 'wb-untagged',
      url: 'https://untagged.test/',
      title: 'Untagged',
      visible: true,
      zoomFactor: 1,
      appZoomFactor: 1.25,
    })
    const untaggedFocus = await httpRequest(url, '/rpc', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'focus-untagged', method: 'tabs.focus', params: { sessionId: 'sess-b', tabId: 'wb-untagged' } }),
    })
    expect(JSON.parse(untaggedFocus.body).error.message).toMatch(/belongs to another session/)

    const untaggedClose = await httpRequest(url, '/rpc', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'close-untagged', method: 'tabs.close', params: { sessionId: 'sess-b', tabId: 'wb-untagged' } }),
    })
    expect(JSON.parse(untaggedClose.body).error.message).toMatch(/belongs to another session/)
    expect(workspace.closedTabs).toEqual([])

    const badControl = await httpRequest(url, '/rpc', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'ctrl-bad',
        method: 'ui.controlState',
        params: { tabId: 'wb-sess-a', sessionId: 'sess-b', state: 'active' },
      }),
    })
    expect(JSON.parse(badControl.body).error.message).toMatch(/belongs to another session/)
  })
})
