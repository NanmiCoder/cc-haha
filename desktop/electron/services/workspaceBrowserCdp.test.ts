import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertAllowedCdpMethod,
  DebuggerLeaseManager,
  isAllowedCdpMethod,
  isHardDeniedCdpMethod,
  type CdpDetachNotice,
  type CdpEventNotice,
  type WorkspaceBrowserCdpWebContentsLike,
  type WorkspaceBrowserDebuggerLike,
} from './workspaceBrowserCdp'

type Listener = (...args: never[]) => void

class FakeDebugger implements WorkspaceBrowserDebuggerLike {
  attached = false
  attachCalls = 0
  detachCalls = 0
  sent: Array<{ method: string, params?: Record<string, unknown> }> = []
  sendImpl: (method: string, params?: Record<string, unknown>) => Promise<unknown> = async () => ({ ok: true })
  private readonly listeners = new Map<string, Set<Listener>>()

  isAttached(): boolean {
    return this.attached
  }

  attach(_protocolVersion?: string): void {
    this.attachCalls += 1
    this.attached = true
  }

  detach(): void {
    this.detachCalls += 1
    this.attached = false
  }

  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ method, params: commandParams })
    return this.sendImpl(method, commandParams)
  }

  on(event: string, listener: Listener): this {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    if (event === 'detach') this.attached = false
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      ;(listener as (...input: unknown[]) => void)(...args)
    }
  }
}

class FakeWebContents implements WorkspaceBrowserCdpWebContentsLike {
  destroyed = false
  debugger = new FakeDebugger()
  private readonly listeners = new Map<string, Set<Listener>>()

  isDestroyed(): boolean {
    return this.destroyed
  }

  on(event: string, listener: Listener): this {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    if (event === 'destroyed') this.destroyed = true
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      ;(listener as (...input: unknown[]) => void)(...args)
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Electron main CDP method allowlist', () => {
  it.each([
    'Accessibility.getFullAXTree',
    'DOM.getDocument',
    'DOM.describeNode',
    'DOM.resolveNode',
    'DOM.getContentQuads',
    'DOM.getBoxModel',
    'DOM.getNodeForLocation',
    'DOM.focus',
    'DOM.scrollIntoViewIfNeeded',
    'Page.navigate',
    'Page.reload',
    'Page.getNavigationHistory',
    'Page.navigateToHistoryEntry',
    'Page.captureScreenshot',
    'Page.getLayoutMetrics',
    'Page.handleJavaScriptDialog',
    'Page.getFrameTree',
    'Page.createIsolatedWorld',
    'Page.addScriptToEvaluateOnNewDocument',
    'Page.enable',
    'Input.dispatchMouseEvent',
    'Input.dispatchKeyEvent',
    'Input.insertText',
    'Emulation.setDeviceMetricsOverride',
    'Runtime.evaluate',
    'Runtime.callFunctionOn',
    'Runtime.getProperties',
    'Runtime.releaseObjectGroup',
    'Runtime.enable',
    'Log.enable',
    'Network.enable',
  ])('allows %s', method => {
    expect(isAllowedCdpMethod(method)).toBe(true)
    expect(isHardDeniedCdpMethod(method)).toBe(false)
    expect(() => assertAllowedCdpMethod(method)).not.toThrow()
  })

  it.each([
    'Browser.close',
    'Browser.getVersion',
    'Browser.setDownloadBehavior',
    'Target.exposeDevToolsProtocol',
    'Target.createTarget',
    'Storage.getCookies',
    'Storage.clearDataForOrigin',
    'Network.getAllCookies',
    'Network.getCookies',
    'Network.setCookie',
    'Security.setIgnoreCertificateErrors',
    'Page.setDownloadBehavior',
    'DOM.setFileInputFiles',
  ])('hard-denies forbidden method %s', method => {
    expect(isHardDeniedCdpMethod(method)).toBe(true)
    expect(isAllowedCdpMethod(method)).toBe(false)
    expect(() => assertAllowedCdpMethod(method)).toThrow('forbidden by Electron host policy')
  })

  it.each([
    'Debugger.enable',
    'Fetch.enable',
    'Page.setDocumentContent',
    'Emulation.setGeolocationOverride',
  ])('rejects non-allowlisted method %s', method => {
    expect(isAllowedCdpMethod(method)).toBe(false)
    expect(() => assertAllowedCdpMethod(method)).toThrow('not allowlisted')
  })
})

describe('DebuggerLeaseManager', () => {
  it('attaches on 0->1, keeps attached across nested leases, and detaches after idle grace on 1->0', () => {
    vi.useFakeTimers()
    const wc = new FakeWebContents()
    const manager = new DebuggerLeaseManager({
      resolveWebContents: tabId => (tabId === 'tab-1' ? wc : null),
      idleGraceMs: 250,
    })

    const first = manager.acquire('tab-1')
    expect(wc.debugger.attachCalls).toBe(1)
    expect(manager.getLeaseCount('tab-1')).toBe(1)

    const second = manager.acquire('tab-1')
    expect(wc.debugger.attachCalls).toBe(1)
    expect(manager.getLeaseCount('tab-1')).toBe(2)

    manager.release('tab-1', first.leaseId)
    vi.advanceTimersByTime(500)
    expect(wc.debugger.detachCalls).toBe(0)
    expect(wc.debugger.isAttached()).toBe(true)

    manager.release('tab-1', second.leaseId)
    vi.advanceTimersByTime(200)
    expect(wc.debugger.detachCalls).toBe(0)

    // Re-acquiring inside the grace window cancels the pending detach.
    const third = manager.acquire('tab-1')
    vi.advanceTimersByTime(500)
    expect(wc.debugger.detachCalls).toBe(0)

    manager.release('tab-1', third.leaseId)
    vi.advanceTimersByTime(250)
    expect(wc.debugger.detachCalls).toBe(1)
    expect(wc.debugger.isAttached()).toBe(false)
  })

  it('rejects in-flight commands on unexpected debugger detach and transparently re-attaches on next command', async () => {
    const wc = new FakeWebContents()
    const events: CdpEventNotice[] = []
    const detaches: CdpDetachNotice[] = []
    const manager = new DebuggerLeaseManager({
      resolveWebContents: () => wc,
      idleGraceMs: 1_000,
      onEvent: event => events.push(event),
      onDetached: notice => detaches.push(notice),
    })

    const lease = manager.acquire('tab-1')
    wc.debugger.sendImpl = () => new Promise(() => {})
    const pending = manager.sendCommand('tab-1', 'Page.getLayoutMetrics', undefined, { leaseId: lease.leaseId })

    wc.debugger.emit('detach', {}, 'target_closed')
    await expect(pending).rejects.toThrow('CDP debugger detached on tab tab-1: target_closed')
    expect(detaches).toEqual([{ tabId: 'tab-1', reason: 'target_closed' }])
    expect(events).toContainEqual({
      tabId: 'tab-1',
      method: 'Inspector.detached',
      params: { reason: 'target_closed' },
    })
    expect(wc.debugger.isAttached()).toBe(false)

    // Next command transparently re-attaches without throwing.
    wc.debugger.sendImpl = async () => ({ layoutViewport: { clientWidth: 1000 } })
    const result = await manager.sendCommand('tab-1', 'Page.getLayoutMetrics', undefined, { leaseId: lease.leaseId })
    expect(result).toEqual({ layoutViewport: { clientWidth: 1000 } })
    expect(wc.debugger.attachCalls).toBe(2)
    expect(wc.debugger.isAttached()).toBe(true)

    manager.disposeAll()
  })

  it('rejects in-flight commands on render-process-gone and forwards CDP message events', async () => {
    const wc = new FakeWebContents()
    const events: CdpEventNotice[] = []
    const manager = new DebuggerLeaseManager({
      resolveWebContents: () => wc,
      idleGraceMs: 1_000,
      onEvent: event => events.push(event),
    })

    const lease = manager.acquire('tab-2')
    wc.debugger.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Hi' })
    expect(events).toContainEqual({
      tabId: 'tab-2',
      method: 'Page.javascriptDialogOpening',
      params: { type: 'alert', message: 'Hi' },
    })

    wc.debugger.sendImpl = () => new Promise(() => {})
    const pending = manager.sendCommand('tab-2', 'Runtime.evaluate', { expression: '1+1' }, { leaseId: lease.leaseId })
    wc.emit('render-process-gone', {}, { reason: 'crashed' })

    await expect(pending).rejects.toThrow('Renderer process gone on tab tab-2: crashed')
    manager.disposeAll()
  })

  it('blocks forbidden CDP methods before touching the debugger', async () => {
    const wc = new FakeWebContents()
    const manager = new DebuggerLeaseManager({
      resolveWebContents: () => wc,
      idleGraceMs: 0,
    })

    await expect(manager.sendCommand('tab-1', 'Storage.getCookies')).rejects.toThrow('forbidden by Electron host policy')
    await expect(manager.sendCommand('tab-1', 'Network.getAllCookies')).rejects.toThrow('forbidden by Electron host policy')
    await expect(manager.sendCommand('tab-1', 'DOM.setFileInputFiles', { files: ['/etc/passwd'] })).rejects.toThrow('forbidden by Electron host policy')
    expect(wc.debugger.attachCalls).toBe(0)
    expect(wc.debugger.sent).toEqual([])
  })
})
