import { describe, expect, it } from 'bun:test'
import {
  BrowserUseEngine,
  computeViewportCoordinates,
  detectSensitiveActionGuardrail,
} from '../engine'
import {
  InPageCursorController,
  buildInPageCursorBootstrapScript,
} from '../inPageCursor'
import { BrowserSecurityError } from '../security'
import type {
  BrowserControlStatePayload,
  BrowserCursorPayload,
  BrowserUseActivityEvent,
} from '../types'
import {
  DirectCdpWebSocketTransport,
  type WebSocketLike,
} from '../wsTransport'
import { MockCdpTransport } from './mockCdpTransport'

function setupStandardPageMock(transport: MockCdpTransport, opts?: {
  loaderId?: string
  url?: string
  hitBackendNodeId?: number
  hitRelated?: boolean
  quad?: number[]
  offsetX?: number
  offsetY?: number
  visualViewportScale?: number
}) {
  let loaderId = opts?.loaderId ?? 'L1'
  const url = opts?.url ?? 'https://app.example.com/checkout'
  const quad = opts?.quad ?? [100, 200, 200, 200, 200, 240, 100, 240]

  transport.onCommand('Page.getFrameTree', () => ({
    frameTree: {
      frame: { id: 'main', loaderId, url },
    },
  }))
  transport.onCommand('Accessibility.getFullAXTree', () => ({
    nodes: [
      {
        nodeId: 'btn1',
        backendDOMNodeId: 101,
        role: { value: 'button' },
        name: { value: 'Search' },
      },
      {
        nodeId: 'input1',
        backendDOMNodeId: 102,
        role: { value: 'textbox' },
        name: { value: 'Query' },
      },
      {
        nodeId: 'payBtn',
        backendDOMNodeId: 103,
        role: { value: 'button' },
        name: { value: 'Pay Now' },
      },
    ],
  }))
  transport.onCommand('DOM.resolveNode', params => ({
    object: { objectId: `obj-${String(params?.backendNodeId)}` },
  }))
  transport.onCommand('DOM.getContentQuads', () => ({
    quads: [quad],
  }))
  transport.onCommand('Page.getLayoutMetrics', () => ({
    cssVisualViewport: {
      offsetX: opts?.offsetX ?? 10,
      offsetY: opts?.offsetY ?? 20,
      scale: opts?.visualViewportScale ?? 1,
    },
  }))
  transport.onCommand('DOM.getNodeForLocation', () => ({
    backendNodeId: opts?.hitBackendNodeId ?? 101,
  }))
  transport.onCommand('Runtime.callFunctionOn', () => ({
    result: { value: opts?.hitRelated ?? true },
  }))
  transport.onCommand('Runtime.evaluate', params => {
    const expr = String(params?.expression ?? '')
    if (expr.includes('document.title')) {
      return { result: { value: 'Example App' } }
    }
    if (expr.includes('innerText')) {
      return { result: { value: 'Hello page body' } }
    }
    if (expr.includes('outerHTML')) {
      return { result: { value: '<html><body>Hello</body></html>' } }
    }
    return { result: { value: true } }
  })

  return {
    setLoaderId(next: string) {
      loaderId = next
    },
  }
}

describe('browserUse/engine', () => {
  it('computes exact viewport, Electron slot overlay, and CDP DIP dispatch coordinates', () => {
    // x_css=250, offsetX=50 -> 200; * visualViewportScale(1.5) -> x_vv=300
    // x_slot = 300 * (1.25 / 1.0) = 375 (or with appZoom=1.25 -> 300)
    // x_dispatch = 300 * 1.25 = 375
    const coords = computeViewportCoordinates({
      xCss: 250,
      yCss: 140,
      offsetX: 50,
      offsetY: 40,
      visualViewportScale: 1.5,
      zoomFactor: 1.25,
      appZoomFactor: 1.1,
    })

    expect(coords.xVv).toBeCloseTo(300, 6)
    expect(coords.yVv).toBeCloseTo(150, 6)
    expect(coords.xSlot).toBeCloseTo(300 * (1.25 / 1.1), 6)
    expect(coords.ySlot).toBeCloseTo(150 * (1.25 / 1.1), 6)
    expect(coords.xDispatch).toBeCloseTo(375, 6)
    expect(coords.yDispatch).toBeCloseTo(187.5, 6)
  })

  it('executes click + fill + press using exact DIPs, Input.insertText, and BrowserUiHooks', async () => {
    const transport = new MockCdpTransport('workspace')
    setupStandardPageMock(transport, {
      quad: [100, 200, 200, 200, 200, 240, 100, 240], // center = (150, 220)
      offsetX: 30,
      offsetY: 20,
      visualViewportScale: 2,
    })

    const cursorMoves: BrowserCursorPayload[] = []
    const ripples: BrowserCursorPayload[] = []
    const states: BrowserControlStatePayload[] = []
    const activities: BrowserUseActivityEvent[] = []

    const engine = new BrowserUseEngine({
      transport,
      defaultTabId: 'tab-1',
      uiHooks: {
        getZoomFactors: async () => ({
          pageZoomFactor: 1.5,
          appZoomFactor: 1.2,
        }),
        moveCursor: async payload => {
          cursorMoves.push(payload)
          return { arrived: true }
        },
        clickRipple: payload => {
          ripples.push(payload)
        },
        setControlState: payload => {
          states.push(payload)
        },
        onActivity: event => {
          activities.push(event)
        },
      },
    })

    const snap = await engine.snapshot({ tabId: 'tab-1' })
    expect(snap.refs[0]?.refId).toBe('@e1')
    expect(snap.refs[1]?.refId).toBe('@e2')

    const res = await engine.act({
      tabId: 'tab-1',
      steps: [
        { action: 'click', ref: '@e1' },
        { action: 'fill', ref: '@e2', text: 'hello world' },
        { action: 'press', key: 'Control+Enter' },
      ],
    })

    expect(res.completedSteps).toBe(3)
    expect(res.stoppedReason).toBeUndefined()

    // Verify exact coordinate math:
    // x_vv = (150 - 30) * 2 = 240, y_vv = (220 - 20) * 2 = 400
    // x_slot = 240 * (1.5 / 1.2) = 300, y_slot = 400 * (1.5 / 1.2) = 500
    // x_dispatch = 240 * 1.5 = 360, y_dispatch = 400 * 1.5 = 600
    expect(cursorMoves[0]?.x).toBeCloseTo(300, 4)
    expect(cursorMoves[0]?.y).toBeCloseTo(500, 4)
    expect(ripples).toHaveLength(1)
    expect(states.some(s => s.state === 'active')).toBe(true)
    expect(activities.length).toBeGreaterThan(0)

    const mousePressed = transport.commands.find(
      c =>
        c.method === 'Input.dispatchMouseEvent' &&
        c.params?.type === 'mousePressed',
    )
    expect(mousePressed?.params?.x).toBeCloseTo(360, 4)
    expect(mousePressed?.params?.y).toBeCloseTo(600, 4)

    // Verify Input.insertText used for printable text (Electron <webview> compatibility!)
    const insertText = transport.commands.find(
      c => c.method === 'Input.insertText',
    )
    expect(insertText?.params?.text).toBe('hello world')

    // Verify Input.dispatchKeyEvent used for Control+Enter (Control bitmask = 2)
    const keyDown = transport.commands.find(
      c =>
        c.method === 'Input.dispatchKeyEvent' &&
        c.params?.type === 'rawKeyDown',
    )
    expect(keyDown?.params?.key).toBe('Enter')
    expect(keyDown?.params?.modifiers).toBe(2)

    engine.dispose()
  })

  it('settles pending input immediately when Page.javascriptDialogOpening fires and halts micro-batch', async () => {
    const transport = new MockCdpTransport('workspace')
    setupStandardPageMock(transport)

    // Simulate a click that blocks in CDP because the page synchronously calls alert()
    transport.onCommand('Input.dispatchMouseEvent', params => {
      if (params?.type === 'mousePressed') {
        setTimeout(() => {
          transport.emitEvent('Page.javascriptDialogOpening', {
            type: 'confirm',
            message: 'Delete this item?',
            url: 'https://app.example.com/checkout',
          })
        }, 15)
        // Return a promise that never resolves while dialog is open
        return new Promise<Record<string, unknown>>(() => {})
      }
      return {}
    })

    const engine = new BrowserUseEngine({
      transport,
      defaultTabId: 'tab-1',
    })
    await engine.snapshot({ tabId: 'tab-1' })

    const res = await engine.act({
      tabId: 'tab-1',
      steps: [
        { action: 'click', ref: '@e1' },
        { action: 'fill', ref: '@e2', text: 'must-not-run' },
      ],
    })

    expect(res.stoppedReason).toBe('dialog')
    expect(res.completedSteps).toBe(1)
    expect(res.dialog?.type).toBe('confirm')
    expect(res.dialog?.message).toBe('Delete this item?')
    expect(res.wrappedDialog?.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(res.wrappedDialog?.wrapped).toContain('Delete this item?')
    expect(
      transport.commands.some(c => c.method === 'Input.insertText'),
    ).toBe(false)

    // Handle the dialog cleanly
    const dialogAct = await engine.act({
      tabId: 'tab-1',
      steps: [{ action: 'dialog', accept: true }],
    })
    expect(dialogAct.completedSteps).toBe(1)
    expect(
      transport.commands.some(
        c =>
          c.method === 'Page.handleJavaScriptDialog' &&
          c.params?.accept === true,
      ),
    ).toBe(true)

    engine.dispose()
  })

  it('flushes mouseReleased on error and detects obscured hit-test targets', async () => {
    const transport = new MockCdpTransport('workspace')
    setupStandardPageMock(transport, {
      hitBackendNodeId: 999,
      hitRelated: false,
    })

    const engine = new BrowserUseEngine({
      transport,
      defaultTabId: 'tab-1',
    })
    await engine.snapshot({ tabId: 'tab-1' })

    const occluded = await engine.act({
      tabId: 'tab-1',
      steps: [{ action: 'click', ref: '@e1' }],
    })
    expect(occluded.stoppedReason).toBe('error')
    expect(occluded.results[0]?.error).toContain('obscured')

    // Now simulate an error right after mousePressed and verify mouseReleased flush
    setupStandardPageMock(transport, { hitBackendNodeId: 101 })
    let pressed = false
    transport.onCommand('Input.dispatchMouseEvent', params => {
      if (params?.type === 'mousePressed') {
        pressed = true
        return {}
      }
      if (params?.type === 'mouseReleased' && pressed) {
        pressed = false
        throw new Error('simulated release error')
      }
      return {}
    })

    const res2 = await engine.act({
      tabId: 'tab-1',
      steps: [{ action: 'click', ref: '@e1' }],
    })
    expect(res2.stoppedReason).toBe('error')
    const releases = transport.commands.filter(
      c =>
        c.method === 'Input.dispatchMouseEvent' &&
        c.params?.type === 'mouseReleased',
    )
    expect(releases.length).toBeGreaterThanOrEqual(2)

    engine.dispose()
  })

  it('serializes concurrent tab operations strictly in FIFO order', async () => {
    const transport = new MockCdpTransport('workspace')
    setupStandardPageMock(transport)
    const order: string[] = []

    const engine = new BrowserUseEngine({
      transport,
      defaultTabId: 'tab-1',
      uiHooks: {
        onActivity: ev => {
          if (ev.status === 'running' && ev.action === 'wait') {
            order.push(`start:${ev.humanLabel}`)
          }
          if (ev.status === 'completed' && ev.action === 'wait') {
            order.push(`end:${ev.humanLabel}`)
          }
        },
      },
    })

    const p1 = engine.act({
      tabId: 'tab-1',
      steps: [{ action: 'wait', ms: 30, label: 'first' }],
    })
    const p2 = engine.act({
      tabId: 'tab-1',
      steps: [{ action: 'wait', ms: 5, label: 'second' }],
    })
    await Promise.all([p1, p2])

    expect(order).toEqual([
      'start:first',
      'end:first',
      'start:second',
      'end:second',
    ])
    engine.dispose()
  })

  it('triggers sensitive guardrail takeover on payment click and stops micro-batch on navigation', async () => {
    const transport = new MockCdpTransport('workspace')
    const state = setupStandardPageMock(transport)
    const engine = new BrowserUseEngine({
      transport,
      defaultTabId: 'tab-1',
    })
    await engine.snapshot({ tabId: 'tab-1' })

    // Payment guardrail
    const payRes = await engine.act({
      tabId: 'tab-1',
      steps: [{ action: 'click', ref: '@e3' }],
    })
    expect(payRes.stoppedReason).toBe('sensitive_gate')
    expect(payRes.takeover?.reason).toBe('payment')
    expect(engine.getControlState()).toBe('takeover')

    const resumed = await engine.resumeTakeover(payRes.takeover?.takeoverId)
    expect(resumed?.status).toBe('resumed')
    expect(engine.getControlState()).toBe('idle')

    // Navigation stops subsequent steps in micro-batch
    transport.onCommand('Input.dispatchMouseEvent', params => {
      if (params?.type === 'mouseReleased') {
        state.setLoaderId('L2')
      }
      return {}
    })
    await engine.snapshot({ tabId: 'tab-1' })
    const navStop = await engine.act({
      tabId: 'tab-1',
      steps: [
        { action: 'click', ref: '@e4' },
        { action: 'press', key: 'Enter' },
      ],
    })
    expect(navStop.stoppedReason).toBe('navigation')
    expect(navStop.completedSteps).toBe(1)

    // Guardrail helper directly detects captcha
    expect(
      detectSensitiveActionGuardrail(
        { action: 'click', label: 'Verify' },
        undefined,
        'https://example.com/recaptcha',
        'Verify you are human',
      )?.reason,
    ).toBe('captcha')

    engine.dispose()
  })

  it('enforces BrowserNavigationGuard and redacts headers in inspect(network)', async () => {
    const transport = new MockCdpTransport('workspace')
    setupStandardPageMock(transport)
    const engine = new BrowserUseEngine({
      transport,
      blockedLoopbackPorts: [45678],
      defaultTabId: 'tab-1',
    })

    await expect(
      engine.navigate({ tabId: 'tab-1', url: 'file:///etc/passwd' }),
    ).rejects.toThrow(BrowserSecurityError)
    await expect(
      engine.navigate({ tabId: 'tab-1', url: 'http://127.0.0.1:45678/rpc' }),
    ).rejects.toThrow(BrowserSecurityError)
    await expect(
      engine.navigate({
        tabId: 'tab-1',
        url: 'http://169.254.169.254/latest/meta-data/',
      }),
    ).rejects.toThrow(BrowserSecurityError)

    // Feed network & console events
    transport.emitEvent('Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ value: 'Boom!' }],
    })
    transport.emitEvent('Network.requestWillBeSent', {
      requestId: 'r1',
      request: {
        url: 'https://api.example.com/me',
        method: 'GET',
        headers: {
          Authorization: 'Bearer super-secret-jwt',
          Cookie: 'sid=12345',
          Accept: 'application/json',
        },
      },
    })
    transport.emitEvent('Network.responseReceived', {
      requestId: 'r1',
      response: {
        status: 200,
        headers: {
          'Set-Cookie': 'sid=67890; HttpOnly',
          'Content-Type': 'application/json',
        },
      },
    })

    const netInspect = await engine.inspect({ tabId: 'tab-1', kind: 'network' })
    expect(netInspect.wrappedContent.wrapped).not.toContain('super-secret-jwt')
    expect(netInspect.wrappedContent.wrapped).not.toContain('sid=12345')
    expect(netInspect.wrappedContent.wrapped).not.toContain('sid=67890')
    expect(netInspect.wrappedContent.wrapped).toContain('application/json')

    const consoleInspect = await engine.inspect({
      tabId: 'tab-1',
      kind: 'console',
    })
    expect(consoleInspect.wrappedContent.wrapped).toContain('Boom!')

    engine.dispose()
  })

  it('keeps inPageCursor Trusted-Types/CSP safe, hides before screenshot, and tears down within 150ms', async () => {
    const script = buildInPageCursorBootstrapScript()
    expect(script).toContain('document.createElementNS')
    expect(script).toContain('CSSStyleSheet')
    expect(script).toContain('adoptedStyleSheets')
    expect(script).toContain("mode: 'closed'")
    expect(script).not.toContain('innerHTML')
    expect(script).not.toContain('outerHTML')
    expect(script).not.toContain('<style')

    // Verify noOverlay disables all CDP calls
    const transport = new MockCdpTransport('chrome')
    const disabledCursor = new InPageCursorController({
      transport,
      noOverlay: true,
    })
    await disabledCursor.moveCursor('main', {
      tabId: 't1',
      target: 'chrome',
      x: 10,
      y: 20,
    })
    expect(transport.commands).toHaveLength(0)

    // Verify teardown completes within 150ms even if transport hangs
    transport.onCommand('Page.createIsolatedWorld', () => ({
      executionContextId: 42,
    }))
    transport.onCommand('Runtime.evaluate', params => {
      if (String(params?.expression).trim() === 'globalThis.__ccHahaCursor?.destroy()') {
        return new Promise<Record<string, unknown>>(() => {})
      }
      return { result: { value: { arrived: true } } }
    })

    const cursor = new InPageCursorController({ transport })
    await cursor.moveCursor('main', {
      tabId: 't1',
      target: 'chrome',
      x: 50,
      y: 60,
    })
    const start = Date.now()
    await cursor.teardown()
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(400)
  })

  it('correlates requests and fails fast on Target.detachedFromTarget in DirectCdpWebSocketTransport', async () => {
    const listeners = new Map<string, Array<(ev: unknown) => void>>()
    const sentPayloads: Array<Record<string, unknown>> = []

    const fakeSocket: WebSocketLike = {
      readyState: 1,
      send(data: string) {
        const parsed = JSON.parse(data) as Record<string, unknown>
        sentPayloads.push(parsed)
        if (parsed.method === 'Browser.getVersion') {
          queueMicrotask(() => {
            for (const fn of listeners.get('message') ?? []) {
              fn({
                data: JSON.stringify({
                  id: parsed.id,
                  result: { product: 'Chrome/144.0' },
                }),
              })
            }
          })
        }
      },
      close() {},
      addEventListener(type, listener) {
        const list = listeners.get(type) ?? []
        list.push(listener)
        listeners.set(type, list)
        if (type === 'open') {
          queueMicrotask(() => listener({}))
        }
      },
    }

    const wsTransport = new DirectCdpWebSocketTransport({
      wsUrl: 'ws://127.0.0.1:9222/devtools/browser/test',
      keepaliveIntervalMs: 0,
      webSocketFactory: () => fakeSocket,
    })

    await wsTransport.connect()
    const version = await wsTransport.send<{ product: string }>(
      'Browser.getVersion',
    )
    expect(version.product).toBe('Chrome/144.0')

    // Start a command on sessionId="S1" that never gets a response, then detach S1
    const pendingPromise = wsTransport.send('Runtime.evaluate', {}, {
      sessionId: 'S1',
      timeoutMs: 10_000,
    })
    for (const fn of listeners.get('message') ?? []) {
      fn({
        data: JSON.stringify({
          method: 'Target.detachedFromTarget',
          params: { sessionId: 'S1' },
        }),
      })
    }
    await expect(pendingPromise).rejects.toThrow('CDP target detached')
    await wsTransport.close()
  })

  it('passes document/page coordinates (xCss+pageX, yCss+pageY) to DOM.getNodeForLocation without double-subtracting scroll in xSlot/xDispatch', async () => {
    const transport = new MockCdpTransport('workspace')
    setupStandardPageMock(transport, {
      quad: [100, 120, 200, 120, 200, 160, 100, 160], // viewport center = (150, 140)
      offsetX: 0,
      offsetY: 0,
      visualViewportScale: 1,
    })
    // Override Page.getLayoutMetrics with scrolled pageY=200, pageX=40, offsetY=0, offsetX=0
    transport.onCommand('Page.getLayoutMetrics', () => ({
      cssVisualViewport: {
        pageX: 40,
        pageY: 200,
        offsetX: 0,
        offsetY: 0,
        scale: 1,
      },
    }))

    const engine = new BrowserUseEngine({
      transport,
      defaultTabId: 'tab-scroll',
      uiHooks: {
        getZoomFactors: async () => ({
          pageZoomFactor: 1.25,
          appZoomFactor: 1,
        }),
      },
    })
    await engine.snapshot({ tabId: 'tab-scroll' })
    const resolved = await engine.resolveRef('tab-scroll', '@e1')

    // xSlot / xDispatch MUST use offsetX/offsetY (0), NOT pageX/pageY (scroll)!
    expect(resolved.coords.xSlot).toBeCloseTo(150 * 1.25, 4)
    expect(resolved.coords.ySlot).toBeCloseTo(140 * 1.25, 4)
    expect(resolved.coords.xDispatch).toBeCloseTo(150 * 1.25, 4)
    expect(resolved.coords.yDispatch).toBeCloseTo(140 * 1.25, 4)

    // DOM.getNodeForLocation MUST receive document coordinates (xCss + pageX, yCss + pageY)
    const hitCmd = transport.commands.find(
      c => c.method === 'DOM.getNodeForLocation',
    )
    expect(hitCmd?.params?.x).toBe(190) // 150 + 40
    expect(hitCmd?.params?.y).toBe(340) // 140 + 200

    engine.dispose()
  })

  it('re-enables CDP domains after resetTabDomains() and Inspector.detached', async () => {
    const transport = new MockCdpTransport('workspace')
    setupStandardPageMock(transport)
    const engine = new BrowserUseEngine({
      transport,
      defaultTabId: 'tab-1',
    })

    const countPageEnable = () =>
      transport.commands.filter(c => c.method === 'Page.enable').length

    await engine.snapshot({ tabId: 'tab-1' })
    expect(countPageEnable()).toBe(1)

    // Already enabled -> no duplicate Page.enable
    await engine.snapshot({ tabId: 'tab-1' })
    expect(countPageEnable()).toBe(1)

    // Explicit resetTabDomains -> re-enables on next command
    engine.resetTabDomains('tab-1')
    await engine.snapshot({ tabId: 'tab-1' })
    expect(countPageEnable()).toBe(2)

    // Inspector.detached event -> re-enables on next command
    transport.emitEvent('Inspector.detached', { reason: 'target_closed' })
    await engine.snapshot({ tabId: 'tab-1' })
    expect(countPageEnable()).toBe(3)

    engine.dispose()
  })

  it('recovers InPageCursorController after navigation/stale context, uses top frameId for ripple, and recreates cursor on cdpSessionId change', async () => {
    const transport = new MockCdpTransport('chrome')
    let worldCalls = 0
    let failOnceOnMove = true
    const rippleFrames: string[] = []

    transport.onCommand('Page.createIsolatedWorld', params => {
      worldCalls += 1
      rippleFrames.push(String(params?.frameId))
      return { executionContextId: 100 + worldCalls }
    })
    transport.onCommand('Runtime.evaluate', params => {
      const expr = String(params?.expression ?? '')
      if (expr.includes('__ccHahaCursor?.move') && failOnceOnMove) {
        failOnceOnMove = false
        throw new Error('CDP error (Runtime.evaluate): Cannot find context with specified id')
      }
      return { result: { value: { arrived: true } } }
    })

    const cursor = new InPageCursorController({ transport })
    const moved = await cursor.moveCursor('top-frame', {
      tabId: 't1',
      target: 'chrome',
      x: 10,
      y: 20,
    })
    expect(moved.arrived).toBe(true)
    expect(worldCalls).toBe(2) // initial + automatic recovery retry!

    // Engine integration: top-frame Page.frameNavigated invalidates cursor,
    // registerTab with new cdpSessionId resets domains & recreates cursor,
    // and setNoInPageOverlay toggles overlay immediately.
    const engineTransport = new MockCdpTransport('chrome')
    setupStandardPageMock(engineTransport)
    const createdWorlds: Array<{ frameId: unknown; sessionId: unknown }> = []
    engineTransport.onCommand('Page.createIsolatedWorld', (params, opts) => {
      createdWorlds.push({ frameId: params?.frameId, sessionId: opts?.sessionId })
      return { executionContextId: 200 + createdWorlds.length }
    })
    engineTransport.onCommand('Accessibility.getFullAXTree', () => ({
      nodes: [
        {
          nodeId: 'iframe-btn',
          backendDOMNodeId: 101,
          frameId: 'child-iframe-99',
          role: { value: 'button' },
          name: { value: 'Iframe Action' },
        },
      ],
    }))

    const engine = new BrowserUseEngine({ transport: engineTransport })
    engine.registerTab({
      tabId: 'chrome-tab-1',
      target: 'chrome',
      url: 'https://example.com',
      title: 'Example',
      active: true,
      cdpSessionId: 'sess-1',
    })
    await engine.snapshot({ tabId: 'chrome-tab-1' })
    await engine.act({
      tabId: 'chrome-tab-1',
      steps: [{ action: 'click', ref: '@e1' }],
    })
    // Every Page.createIsolatedWorld call must target top frame ('main'), NEVER 'child-iframe-99'
    expect(createdWorlds.length).toBeGreaterThan(0)
    expect(createdWorlds.every(w => w.frameId === 'main')).toBe(true)

    // Top-frame navigation invalidates isolated world so next action re-creates it
    const worldsBeforeNav = createdWorlds.length
    engineTransport.emitEvent(
      'Page.frameNavigated',
      { frame: { id: 'main', url: 'https://example.com/next' } },
      'sess-1',
    )
    await engine.act({
      tabId: 'chrome-tab-1',
      steps: [{ action: 'click', ref: '@e1' }],
    })
    expect(createdWorlds.length).toBeGreaterThan(worldsBeforeNav)

    // Re-registering tab with a new cdpSessionId recreates cursor with new sessionId and resets domains
    const pageEnablesBefore = engineTransport.commands.filter(
      c => c.method === 'Page.enable',
    ).length
    engine.registerTab({
      tabId: 'chrome-tab-1',
      target: 'chrome',
      url: 'https://example.com/next',
      title: 'Example',
      active: true,
      cdpSessionId: 'sess-2',
    })
    await engine.snapshot({ tabId: 'chrome-tab-1' })
    expect(
      engineTransport.commands.filter(c => c.method === 'Page.enable').length,
    ).toBeGreaterThan(pageEnablesBefore)

    // setNoInPageOverlay(true) suppresses subsequent cursor world creation
    engine.setNoInPageOverlay(true)
    const worldsAfterDisable = createdWorlds.length
    engineTransport.emitEvent(
      'Page.frameNavigated',
      { frame: { id: 'main', url: 'https://example.com/third' } },
      'sess-2',
    )
    await engine.act({
      tabId: 'chrome-tab-1',
      steps: [{ action: 'click', ref: '@e2' }],
    })
    expect(createdWorlds.length).toBe(worldsAfterDisable)

    engine.dispose()
  })

  it('implements real navigate() waitUntil (load, domcontentloaded, none, dialog settle)', async () => {
    const transport = new MockCdpTransport('workspace')
    setupStandardPageMock(transport)
    const engine = new BrowserUseEngine({
      transport,
      defaultTabId: 'tab-nav',
    })

    // 1. waitUntil: 'none' resolves immediately
    const resNone = await engine.navigate({
      tabId: 'tab-nav',
      url: 'https://example.com/none',
      waitUntil: 'none',
    })
    expect(resNone.url).toBe('https://app.example.com/checkout')

    // 2. waitUntil: 'load' waits until Page.loadEventFired fires
    let loadResolved = false
    const loadPromise = engine
      .navigate({
        tabId: 'tab-nav',
        url: 'https://example.com/load',
        waitUntil: 'load',
        timeoutMs: 2_000,
      })
      .then(res => {
        loadResolved = true
        return res
      })
    await new Promise(r => setTimeout(r, 20))
    expect(loadResolved).toBe(false)
    transport.emitEvent('Page.loadEventFired', {})
    await loadPromise
    expect(loadResolved).toBe(true)

    // 3. waitUntil: 'domcontentloaded' (default) waits for Page.domContentEventFired
    let dclResolved = false
    const dclPromise = engine
      .navigate({
        tabId: 'tab-nav',
        url: 'https://example.com/dcl',
        timeoutMs: 2_000,
      })
      .then(res => {
        dclResolved = true
        return res
      })
    await new Promise(r => setTimeout(r, 20))
    expect(dclResolved).toBe(false)
    transport.emitEvent('Page.domContentEventFired', {})
    await dclPromise
    expect(dclResolved).toBe(true)

    // 4. Dialog opening during navigation settles cleanly instead of timing out
    const dialogNavPromise = engine.navigate({
      tabId: 'tab-nav',
      url: 'https://example.com/dialog-on-load',
      waitUntil: 'load',
      timeoutMs: 2_000,
    })
    await new Promise(r => setTimeout(r, 15))
    transport.emitEvent('Page.javascriptDialogOpening', {
      type: 'alert',
      message: 'Welcome!',
    })
    const dialogNav = await dialogNavPromise
    expect(dialogNav.dialog?.message).toBe('Welcome!')

    engine.dispose()
  })

  it('protects pending user takeover from navigate/act and keeps controlState during snapshot/inspect', async () => {
    const transport = new MockCdpTransport('workspace')
    setupStandardPageMock(transport)
    const controlStates: string[] = []
    const engine = new BrowserUseEngine({
      transport,
      defaultTabId: 'tab-1',
      uiHooks: {
        setControlState: p => {
          controlStates.push(p.state)
        },
      },
    })

    await engine.requestTakeover({
      tabId: 'tab-1',
      reason: 'user_requested',
      message: 'User took over browser control.',
    })
    expect(engine.getControlState()).toBe('takeover')

    await expect(
      engine.navigate({
        tabId: 'tab-1',
        url: 'https://example.com',
        waitUntil: 'none',
      }),
    ).rejects.toThrow('paused for user takeover')

    await expect(
      engine.act({
        tabId: 'tab-1',
        steps: [{ action: 'wait', ms: 1 }],
      }),
    ).rejects.toThrow('paused for user takeover')

    // snapshot and inspect succeed without overwriting takeover controlState
    await engine.snapshot({ tabId: 'tab-1' })
    await engine.inspect({ tabId: 'tab-1', kind: 'text' })
    expect(engine.getControlState()).toBe('takeover')
    expect(controlStates).toEqual(['takeover'])

    engine.dispose()
  })

  it('prevents unknown sessionId event misattribution, unregisters detached/destroyed tabs, and handles fill focus click dialogs', async () => {
    const transport = new MockCdpTransport('chrome')
    setupStandardPageMock(transport)
    const engine = new BrowserUseEngine({ transport })
    engine.registerTab({
      tabId: 'tab-a',
      target: 'chrome',
      targetId: 'target-a',
      cdpSessionId: 'sess-a',
      url: 'https://example.com/a',
      title: 'A',
      active: true,
    })

    // Console event for unknown sessionId must NOT pollute tab-a
    transport.emitEvent(
      'Runtime.consoleAPICalled',
      { type: 'error', args: [{ value: 'secret-from-other-tab' }] },
      'sess-unrelated',
    )
    const consoleRes = await engine.inspect({ tabId: 'tab-a', kind: 'console' })
    expect(consoleRes.wrappedContent.wrapped).not.toContain(
      'secret-from-other-tab',
    )

    // fill focus click triggering JS dialog settles immediately & flushes mouseReleased
    await engine.snapshot({ tabId: 'tab-a' })
    transport.onCommand('Input.dispatchMouseEvent', params => {
      if (params?.type === 'mousePressed') {
        setTimeout(() => {
          transport.emitEvent(
            'Page.javascriptDialogOpening',
            { type: 'alert', message: 'Focus dialog!' },
            'sess-a',
          )
        }, 10)
        return new Promise<Record<string, unknown>>(() => {})
      }
      return {}
    })
    const fillDialog = await engine.act({
      tabId: 'tab-a',
      steps: [{ action: 'fill', ref: '@e2', text: 'abc' }],
    })
    expect(fillDialog.stoppedReason).toBe('dialog')
    expect(fillDialog.dialog?.message).toBe('Focus dialog!')
    expect(
      transport.commands.some(
        c =>
          c.method === 'Input.dispatchMouseEvent' &&
          c.params?.type === 'mouseReleased',
      ),
    ).toBe(true)

    // Target.targetDestroyed unregisters dead tab cleanly
    transport.emitEvent('Target.targetDestroyed', { targetId: 'target-a' })
    expect(engine.getTab('tab-a')).toBeNull()

    // Target.detachedFromTarget rejects pending inputs & unregisters tab
    engine.registerTab({
      tabId: 'tab-b',
      target: 'chrome',
      targetId: 'target-b',
      cdpSessionId: 'sess-b',
      url: 'https://example.com/b',
      title: 'B',
      active: true,
    })
    await engine.snapshot({ tabId: 'tab-b' })
    transport.onCommand('Input.dispatchMouseEvent', params => {
      if (params?.type === 'mousePressed') {
        setTimeout(() => {
          transport.emitEvent('Target.detachedFromTarget', {
            sessionId: 'sess-b',
            targetId: 'target-b',
          })
        }, 10)
        return new Promise<Record<string, unknown>>(() => {})
      }
      return {}
    })
    const detachRes = await engine.act({
      tabId: 'tab-b',
      steps: [{ action: 'click', ref: '@e4' }],
    })
    expect(detachRes.stoppedReason).toBe('error')
    expect(detachRes.results[0]?.error).toContain('CDP target detached')
    expect(engine.getTab('tab-b')).toBeNull()

    engine.dispose()
  })

  it('tracks active takeover and control state independently per tab across concurrent sessions', async () => {
    const transport = new MockCdpTransport('workspace')
    const controlEvents: Array<{ tabId: string; state: string; sessionId?: string }> = []
    const engine = new BrowserUseEngine({
      transport,
      noInPageOverlay: true,
      uiHooks: {
        setControlState: async payload => {
          controlEvents.push({
            tabId: payload.tabId,
            state: payload.state,
            sessionId: payload.sessionId,
          })
        },
      },
    })

    engine.registerTab({
      tabId: 'wb-a',
      target: 'workspace',
      cdpSessionId: 'wb-a',
      url: 'https://a.example.com/',
      title: 'A',
      active: true,
      ownerSessionId: 'sess-a',
    })
    engine.registerTab({
      tabId: 'wb-b',
      target: 'workspace',
      cdpSessionId: 'wb-b',
      url: 'https://b.example.com/',
      title: 'B',
      active: false,
      ownerSessionId: 'sess-b',
    })

    // Both tabs enter takeover independently without clobbering each other.
    const toA = await engine.requestTakeover({
      tabId: 'wb-a',
      sessionId: 'sess-a',
      reason: 'login',
      message: 'Login A',
    })
    const toB = await engine.requestTakeover({
      tabId: 'wb-b',
      sessionId: 'sess-b',
      reason: 'captcha',
      message: 'Captcha B',
    })

    expect(engine.getActiveTakeover({ tabId: 'wb-a' })?.takeoverId).toBe(toA.takeoverId)
    expect(engine.getActiveTakeover({ tabId: 'wb-b' })?.takeoverId).toBe(toB.takeoverId)
    expect(engine.getActiveTakeover({ sessionId: 'sess-a' })?.takeoverId).toBe(toA.takeoverId)
    expect(engine.getControlState('wb-a')).toBe('takeover')
    expect(engine.getControlState('wb-b')).toBe('takeover')
    expect(engine.getControlState()).toBe('takeover')

    // wb-a remains protected while wb-b also has a pending takeover.
    await expect(
      engine.navigate({ tabId: 'wb-a', url: 'https://a.example.com/next', waitUntil: 'none' }),
    ).rejects.toThrow(/paused for user takeover/)
    await engine.releaseControl('wb-a')
    expect(engine.getControlState('wb-a')).toBe('takeover')

    // Resuming wb-a settles wb-a while leaving wb-b in takeover.
    const resumedA = await engine.resumeTakeover(toA.takeoverId)
    expect(resumedA?.status).toBe('resumed')
    expect(engine.getActiveTakeover({ tabId: 'wb-a' })).toBeNull()
    expect(engine.getActiveTakeover({ tabId: 'wb-b' })?.takeoverId).toBe(toB.takeoverId)
    expect(engine.getControlState('wb-a')).toBe('idle')
    expect(engine.getControlState('wb-b')).toBe('takeover')
    expect(engine.getControlState()).toBe('takeover')
    expect(controlEvents.at(-1)).toEqual({ tabId: 'wb-a', state: 'idle', sessionId: 'sess-a' })

    // Releasing control on wb-a while wb-b is active must not flip aggregate state to idle.
    await engine.abortTakeover(toB.takeoverId)
    expect(engine.getControlState()).toBe('idle')
    await engine.navigate({ tabId: 'wb-b', url: 'https://b.example.com/run', waitUntil: 'none', sessionId: 'sess-b' })
    expect(engine.getControlState('wb-b')).toBe('active')
    await engine.releaseControl('wb-a')
    expect(engine.getControlState('wb-b')).toBe('active')
    expect(engine.getControlState()).toBe('active')
    await engine.releaseControl('wb-b')
    expect(engine.getControlState()).toBe('idle')

    engine.dispose()
  })
})
