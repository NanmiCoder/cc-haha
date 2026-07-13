import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ELECTRON_EVENT_CHANNELS } from '../ipc/channels'
import {
  ElectronPreviewService,
  normalizePreviewBounds,
  normalizePreviewUrl,
  parsePreviewAgentMessage,
  resolvePreviewScriptPath,
  snapPreviewBoundsToScaleFactor,
  shouldForwardPreviewMessage,
  type PreviewViewLike,
  type PreviewWebContentsLike,
} from './preview'

class FakeWebContents implements PreviewWebContentsLike {
  loadedUrls: string[] = []
  scripts: string[] = []
  zoomFactors: number[] = []
  sent: Array<{ channel: string, payload: unknown }> = []
  documentSize = { width: 1280, height: 3200 }
  debuggerAttached = false
  debugger = {
    isAttached: vi.fn(() => this.debuggerAttached),
    attach: vi.fn(() => {
      this.debuggerAttached = true
    }),
    detach: vi.fn(() => {
      this.debuggerAttached = false
    }),
    sendCommand: vi.fn(async (method: string) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssContentSize: { x: 0, y: 0, ...this.documentSize } }
      }
      if (method === 'Page.captureScreenshot') return { data: 'FULL' }
      throw new Error(`unexpected debugger command: ${method}`)
    }),
  }
  close = vi.fn()
  capturePage = vi.fn(async (_rect?: { x: number, y: number, width: number, height: number }) => ({
    toDataURL: () => 'data:image/png;base64,NATIVE',
  }))
  private loadHandler: (() => void) | null = null

  async loadURL(url: string) {
    this.loadedUrls.push(url)
    this.loadHandler?.()
  }

  async executeJavaScript(script: string) {
    this.scripts.push(script)
    return 'ok'
  }

  on(_event: 'did-finish-load', handler: () => void) {
    this.loadHandler = handler
  }

  isDestroyed() {
    return false
  }

  setZoomFactor(factor: number) {
    this.zoomFactors.push(factor)
  }

  send(channel: string, payload: unknown) {
    this.sent.push({ channel, payload })
  }
}

class FakeView implements PreviewViewLike {
  webContents = new FakeWebContents()
  bounds: unknown[] = []
  visible: boolean[] = []

  setBounds(bounds: unknown) {
    this.bounds.push(bounds)
  }

  setVisible(visible: boolean) {
    this.visible.push(visible)
  }
}

const tempDirs: string[] = []

function previewScript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-preview-'))
  tempDirs.push(dir)
  const file = path.join(dir, 'preview-agent.js')
  fs.writeFileSync(file, 'window.__previewInjected = true')
  return file
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('Electron preview service', () => {
  it('allows only http and https URLs', () => {
    expect(normalizePreviewUrl(' https://example.com ')).toBe('https://example.com')
    expect(normalizePreviewUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    expect(() => normalizePreviewUrl('file:///tmp/index.html')).toThrow('unsupported url scheme')
    expect(() => normalizePreviewUrl('javascript:alert(1)')).toThrow('unsupported url scheme')
  })

  it('normalizes finite bounds for WebContentsView without dropping high-DPI fractions', () => {
    expect(normalizePreviewBounds({ x: 1.2, y: 2.7, width: 20.4, height: -1 })).toEqual({
      x: 1.2,
      y: 2.7,
      width: 20.4,
      height: 0,
    })
    expect(() => normalizePreviewBounds({ x: Number.NaN, y: 0, width: 1, height: 1 })).toThrow('invalid preview bounds x')
  })

  it('snaps preview bounds to physical pixels at fractional Windows scale factors', () => {
    const snapped = snapPreviewBoundsToScaleFactor({
      x: 1.1,
      y: 2.2,
      width: 10.3,
      height: 4.4,
    }, 2.25)

    expect(snapped).toEqual({
      x: 0.888889,
      y: 2.222222,
      width: 10.666667,
      height: 4.444444,
    })
    expect(snapped.x * 2.25).toBeCloseTo(Math.round(snapped.x * 2.25), 5)
    expect((snapped.x + snapped.width) * 2.25).toBeCloseTo(
      Math.round((snapped.x + snapped.width) * 2.25),
      5,
    )
  })

  it('falls back from app.asar to app.asar.unpacked for the preview agent script', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-haha-preview-asar-'))
    tempDirs.push(dir)
    const unpackedFile = path.join(dir, 'app.asar.unpacked', 'src-tauri', 'resources', 'preview-agent.js')
    fs.mkdirSync(path.dirname(unpackedFile), { recursive: true })
    fs.writeFileSync(unpackedFile, 'window.__previewInjected = true')

    const packagedPath = path.join(dir, 'app.asar', 'src-tauri', 'resources', 'preview-agent.js')
    expect(resolvePreviewScriptPath(packagedPath)).toBe(unpackedFile)
  })

  it('creates one child WebContentsView, loads URLs, and injects the preview agent after load', async () => {
    const view = new FakeView()
    const parent = {
      contentView: {
        addChildView: vi.fn(),
        removeChildView: vi.fn(),
      },
    }
    const service = new ElectronPreviewService({
      createView: () => view,
      previewScriptPath: previewScript(),
    })

    await service.open(parent, 'http://localhost:5173', { x: 1, y: 2, width: 300, height: 200 })
    await service.open(parent, 'https://example.com', { x: 3, y: 4, width: 500, height: 240 })
    service.setVisible(false)
    service.setBounds({ x: 5, y: 6, width: 100, height: 80 })

    expect(parent.contentView.addChildView).toHaveBeenCalledTimes(1)
    expect(view.webContents.loadedUrls).toEqual(['http://localhost:5173', 'https://example.com'])
    expect(view.bounds).toEqual([
      { x: 1, y: 2, width: 300, height: 200 },
      { x: 3, y: 4, width: 500, height: 240 },
      { x: 5, y: 6, width: 100, height: 80 },
    ])
    expect(view.visible).toEqual([false])
    expect(view.webContents.scripts).toEqual(['window.__previewInjected = true', 'window.__previewInjected = true'])
  })

  it('applies scale-aware snapped bounds and can refresh them after display metrics change', async () => {
    const view = new FakeView()
    const parent = {
      contentView: {
        addChildView: vi.fn(),
        removeChildView: vi.fn(),
      },
      getBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    }
    let scaleFactor = 1
    const service = new ElectronPreviewService({
      createView: () => view,
      previewScriptPath: previewScript(),
      resolveScaleFactor: () => scaleFactor,
    })

    await service.open(parent, 'http://localhost:5173', { x: 1.1, y: 2.2, width: 10.3, height: 4.4 })
    scaleFactor = 2.25
    service.refreshBounds()

    expect(view.bounds).toEqual([
      { x: 1, y: 2, width: 10, height: 5 },
      { x: 0.888889, y: 2.222222, width: 10.666667, height: 4.444444 },
    ])
  })

  it('forwards only validated preview messages from the child view to the renderer', async () => {
    const view = new FakeView()
    const renderer = new FakeWebContents()
    const service = new ElectronPreviewService({
      createView: () => view,
      previewScriptPath: previewScript(),
    })
    await service.open({ contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }, 'https://example.com', {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    })

    service.sendMessageToRenderer(view.webContents, '{"v":1,"type":"ready"}', renderer)
    service.sendMessageToRenderer(new FakeWebContents(), '{"v":1,"type":"ready"}', renderer)
    expect(() => service.sendMessageToRenderer(view.webContents, 'not-json', renderer)).not.toThrow()
    service.sendMessageToRenderer(view.webContents, '{"v":1,"type":"unknown"}', renderer)
    service.sendMessageToRenderer(view.webContents, JSON.stringify({ v: 1, type: 'screenshot', dataUrl: 'data:text/html;base64,AAAA', kind: 'full' }), renderer)

    expect(renderer.sent).toEqual([
      {
        channel: ELECTRON_EVENT_CHANNELS.previewEvent,
        payload: { v: 1, type: 'ready' },
      },
    ])
  })

  it('stops forwarding preview messages after the view is closed', async () => {
    const view = new FakeView()
    const renderer = new FakeWebContents()
    const parent = { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }
    const service = new ElectronPreviewService({
      createView: () => view,
      previewScriptPath: previewScript(),
    })

    await service.open(parent, 'https://example.com', { x: 0, y: 0, width: 100, height: 100 })
    service.close()
    service.sendMessageToRenderer(view.webContents, '{"v":1,"type":"ready"}', renderer)

    expect(renderer.sent).toEqual([])
  })

  it('captures screenshots from the native WebContentsView instead of DOM repainting in the page', async () => {
    const view = new FakeView()
    const renderer = new FakeWebContents()
    const service = new ElectronPreviewService({
      createView: () => view,
      previewScriptPath: previewScript(),
    })
    await service.open({ contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }, 'https://example.com', {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    })

    await service.message({ v: 1, type: 'capture', kind: 'full' }, renderer)

    expect(view.webContents.capturePage).not.toHaveBeenCalled()
    expect(view.webContents.scripts).not.toContain(expect.stringContaining('html2canvas'))
    expect(renderer.sent).toEqual([
      {
        channel: ELECTRON_EVENT_CHANNELS.previewEvent,
        payload: { v: 1, type: 'screenshot', dataUrl: 'data:image/png;base64,FULL', kind: 'full' },
      },
    ])
  })

  it('captures the full document through CDP with bounded document dimensions', async () => {
    const view = new FakeView()
    const renderer = new FakeWebContents()
    view.webContents.documentSize = { width: 1280, height: 3200 }
    const service = new ElectronPreviewService({
      createView: () => view,
      previewScriptPath: previewScript(),
    })
    await service.open({ contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }, 'https://example.com', {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    })

    await service.message({ v: 1, type: 'capture', kind: 'full' }, renderer)

    expect(view.webContents.debugger.attach).toHaveBeenCalledWith('1.3')
    expect(view.webContents.debugger.sendCommand.mock.calls).toEqual([
      ['Page.getLayoutMetrics'],
      ['Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: 1280, height: 3200, scale: 1 },
      }],
    ])
    expect(view.webContents.debugger.detach).toHaveBeenCalledTimes(1)
    expect(view.webContents.capturePage).not.toHaveBeenCalled()
  })

  it('keeps viewport capture limited to the visible page', async () => {
    const view = new FakeView()
    const renderer = new FakeWebContents()
    view.webContents.documentSize = { width: 1280, height: 3200 }
    const service = new ElectronPreviewService({
      createView: () => view,
      previewScriptPath: previewScript(),
    })
    await service.open({ contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }, 'https://example.com', {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    })

    await service.message({ v: 1, type: 'capture', kind: 'viewport' }, renderer)

    expect(view.webContents.capturePage).toHaveBeenCalledWith()
    expect(view.webContents.debugger.sendCommand).not.toHaveBeenCalled()
  })

  it('detaches the debugger when a full capture fails', async () => {
    const view = new FakeView()
    const renderer = new FakeWebContents()
    view.webContents.debugger.sendCommand.mockRejectedValueOnce(new Error('layout failed'))
    const service = new ElectronPreviewService({
      createView: () => view,
      previewScriptPath: previewScript(),
    })
    await service.open({ contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }, 'https://example.com', {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    })

    await service.message({ v: 1, type: 'capture', kind: 'full' }, renderer)

    expect(view.webContents.debugger.detach).toHaveBeenCalledTimes(1)
    expect(renderer.sent.at(-1)).toMatchObject({
      channel: ELECTRON_EVENT_CHANNELS.previewEvent,
      payload: { v: 1, type: 'error', message: 'Error: layout failed' },
    })
  })

  it('preserves a completed capture if debugger state lookup fails during cleanup', async () => {
    const view = new FakeView()
    const renderer = new FakeWebContents()
    view.webContents.debugger.isAttached
      .mockReturnValueOnce(false)
      .mockImplementationOnce(() => {
        throw new Error('view closed')
      })
    const service = new ElectronPreviewService({
      createView: () => view,
      previewScriptPath: previewScript(),
    })
    await service.open({ contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }, 'https://example.com', {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    })

    await service.message({ v: 1, type: 'capture', kind: 'full' }, renderer)

    expect(renderer.sent.at(-1)).toMatchObject({
      payload: { type: 'screenshot', dataUrl: 'data:image/png;base64,FULL', kind: 'full' },
    })
  })

  it('does not detach a debugger session it did not attach', async () => {
    const view = new FakeView()
    const renderer = new FakeWebContents()
    view.webContents.debuggerAttached = true
    const service = new ElectronPreviewService({
      createView: () => view,
      previewScriptPath: previewScript(),
    })
    await service.open({ contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }, 'https://example.com', {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    })

    await service.message({ v: 1, type: 'capture', kind: 'full' }, renderer)

    expect(view.webContents.debugger.attach).not.toHaveBeenCalled()
    expect(view.webContents.debugger.detach).not.toHaveBeenCalled()
  })

  it('shares one debugger capture across concurrent full-page requests', async () => {
    const view = new FakeView()
    const firstRenderer = new FakeWebContents()
    const secondRenderer = new FakeWebContents()
    const service = new ElectronPreviewService({
      createView: () => view,
      previewScriptPath: previewScript(),
    })
    await service.open({ contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }, 'https://example.com', {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    })

    await Promise.all([
      service.message({ v: 1, type: 'capture', kind: 'full' }, firstRenderer),
      service.message({ v: 1, type: 'capture', kind: 'full' }, secondRenderer),
    ])

    expect(view.webContents.debugger.attach).toHaveBeenCalledTimes(1)
    expect(view.webContents.debugger.detach).toHaveBeenCalledTimes(1)
    expect(view.webContents.debugger.sendCommand).toHaveBeenCalledTimes(2)
    expect(firstRenderer.sent.at(-1)).toEqual(secondRenderer.sent.at(-1))
  })

  it('starts a new full-page capture after the preview is closed and reopened', async () => {
    const firstView = new FakeView()
    const secondView = new FakeView()
    const firstRenderer = new FakeWebContents()
    const secondRenderer = new FakeWebContents()
    const coalescedRenderer = new FakeWebContents()
    let resolveFirstCapture!: (value: { data: string }) => void
    let resolveSecondCapture!: (value: { data: string }) => void
    const firstCapture = new Promise<{ data: string }>((resolve) => {
      resolveFirstCapture = resolve
    })
    const secondCapture = new Promise<{ data: string }>((resolve) => {
      resolveSecondCapture = resolve
    })

    firstView.webContents.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssContentSize: { x: 0, y: 0, width: 800, height: 1200 } }
      }
      if (method === 'Page.captureScreenshot') return await firstCapture
      throw new Error(`unexpected debugger command: ${method}`)
    })
    secondView.webContents.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Page.getLayoutMetrics') {
        return { cssContentSize: { x: 0, y: 0, width: 900, height: 1400 } }
      }
      if (method === 'Page.captureScreenshot') return await secondCapture
      throw new Error(`unexpected debugger command: ${method}`)
    })

    const views = [firstView, secondView]
    const parent = { contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }
    const service = new ElectronPreviewService({
      createView: () => views.shift()!,
      previewScriptPath: previewScript(),
    })
    await service.open(parent, 'https://first.example.com', { x: 0, y: 0, width: 800, height: 600 })

    const firstRequest = service.message({ v: 1, type: 'capture', kind: 'full' }, firstRenderer)
    let secondRequest: Promise<void> | null = null
    let coalescedRequest: Promise<void> | null = null
    try {
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
      expect(firstView.webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', expect.anything())

      service.close()
      await service.open(parent, 'https://second.example.com', { x: 0, y: 0, width: 900, height: 700 })
      secondRequest = service.message({ v: 1, type: 'capture', kind: 'full' }, secondRenderer)

      for (let index = 0; index < 8; index += 1) await Promise.resolve()
      expect(secondView.webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', expect.anything())

      resolveFirstCapture({ data: 'FIRST' })
      await firstRequest

      coalescedRequest = service.message({ v: 1, type: 'capture', kind: 'full' }, coalescedRenderer)
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
      expect(secondView.webContents.debugger.sendCommand).toHaveBeenCalledTimes(2)

      resolveSecondCapture({ data: 'SECOND' })
      await Promise.all([secondRequest, coalescedRequest])

      expect(secondRenderer.sent.at(-1)).toMatchObject({
        payload: { type: 'screenshot', dataUrl: 'data:image/png;base64,SECOND', kind: 'full' },
      })
      expect(coalescedRenderer.sent.at(-1)).toEqual(secondRenderer.sent.at(-1))
    } finally {
      resolveFirstCapture({ data: 'FIRST' })
      resolveSecondCapture({ data: 'SECOND' })
      await Promise.allSettled([
        firstRequest,
        ...(secondRequest ? [secondRequest] : []),
        ...(coalescedRequest ? [coalescedRequest] : []),
      ])
    }
  })

  it.each([
    ['edge', { width: 16_385, height: 100 }],
    ['pixel count', { width: 8_001, height: 4_000 }],
  ])('rejects full captures that exceed the %s safety limit', async (_limit, documentSize) => {
    const view = new FakeView()
    const renderer = new FakeWebContents()
    view.webContents.documentSize = documentSize
    const service = new ElectronPreviewService({
      createView: () => view,
      previewScriptPath: previewScript(),
    })
    await service.open({ contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }, 'https://example.com', {
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    })

    await service.message({ v: 1, type: 'capture', kind: 'full' }, renderer)

    expect(view.webContents.debugger.sendCommand).toHaveBeenCalledTimes(1)
    expect(view.webContents.debugger.detach).toHaveBeenCalledTimes(1)
    expect(renderer.sent.at(-1)).toMatchObject({
      payload: { type: 'error', message: expect.stringContaining('exceeds safety limit') },
    })
  })

  it('applies preview zoom to the native WebContentsView before screenshot capture', async () => {
    const view = new FakeView()
    const renderer = new FakeWebContents()
    const service = new ElectronPreviewService({
      createView: () => view,
      previewScriptPath: previewScript(),
    })
    await service.open({ contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }, 'https://example.com', {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    })

    service.setZoomFactor(0.8)
    await service.message({ v: 1, type: 'capture', kind: 'full' }, renderer)

    expect(view.webContents.zoomFactors.at(-1)).toBe(0.8)
    expect(view.bounds).toHaveLength(1)
    expect(view.webContents.capturePage).not.toHaveBeenCalled()
    expect(renderer.sent.at(-1)).toEqual({
      channel: ELECTRON_EVENT_CHANNELS.previewEvent,
      payload: { v: 1, type: 'screenshot', dataUrl: 'data:image/png;base64,FULL', kind: 'full' },
    })
  })

  it('forwards picker host messages into the injected preview bridge', async () => {
    const view = new FakeView()
    const service = new ElectronPreviewService({
      createView: () => view,
      previewScriptPath: previewScript(),
    })
    await service.open({ contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }, 'https://example.com', {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    })

    await service.message({ v: 1, type: 'enter-picker' })

    expect(view.webContents.scripts.at(-1)).toBe(
      'globalThis.__PREVIEW_BRIDGE__?.handleHostRaw("{\\"v\\":1,\\"type\\":\\"enter-picker\\"}")',
    )
  })

  it('adds a native screenshot to selection events before forwarding them to the renderer', async () => {
    const view = new FakeView()
    const renderer = new FakeWebContents()
    const service = new ElectronPreviewService({
      createView: () => view,
      previewScriptPath: previewScript(),
    })
    await service.open({ contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }, 'https://example.com', {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    })

    await service.sendMessageToRenderer(view.webContents, JSON.stringify({
      v: 1,
      type: 'selection',
      payload: {
        pageUrl: 'https://example.com',
        element: { selector: '#todo', tag: 'input', classes: [] },
        screenshot: { kind: 'region' },
      },
    }), renderer)

    expect(view.webContents.capturePage).toHaveBeenCalledTimes(1)
    expect(view.webContents.scripts.at(-1)).toBe('globalThis.__PREVIEW_AGENT_CLEAR_SELECTION_OVERLAY__?.()')
    expect(renderer.sent).toEqual([
      {
        channel: ELECTRON_EVENT_CHANNELS.previewEvent,
        payload: {
          v: 1,
          type: 'selection',
          payload: {
            pageUrl: 'https://example.com',
            element: { selector: '#todo', tag: 'input', classes: [] },
            screenshot: { kind: 'region', dataUrl: 'data:image/png;base64,NATIVE' },
          },
        },
      },
    ])
  })

  it('rejects host messages before a preview view exists', async () => {
    const service = new ElectronPreviewService({
      createView: () => new FakeView(),
      previewScriptPath: previewScript(),
    })

    await expect(service.message({ v: 1, type: 'capture', kind: 'viewport' })).rejects.toThrow('preview not open')
  })

  it('allows preload forwarding only for top-level http/https preview pages', () => {
    expect(shouldForwardPreviewMessage({
      raw: '{"v":1,"type":"ready"}',
      href: 'https://example.com/workbench',
      isTopFrame: true,
    })).toBe(true)
    expect(shouldForwardPreviewMessage({
      raw: '{"v":1,"type":"ready"}',
      href: 'http://127.0.0.1:3000',
      isTopFrame: true,
    })).toBe(true)
    expect(shouldForwardPreviewMessage({
      raw: '{"v":1,"type":"ready"}',
      href: 'https://example.com/frame',
      isTopFrame: false,
    })).toBe(false)
    expect(shouldForwardPreviewMessage({
      raw: '{"v":1,"type":"ready"}',
      href: 'file:///tmp/index.html',
      isTopFrame: true,
    })).toBe(false)
    expect(shouldForwardPreviewMessage({
      raw: { type: 'ready' },
      href: 'https://example.com',
      isTopFrame: true,
    })).toBe(false)
    expect(shouldForwardPreviewMessage({
      raw: '{"v":1,"type":"ready"}',
      href: 'not-a-url',
      isTopFrame: true,
    })).toBe(false)
  })

  it('parses only bounded preview agent message shapes', () => {
    expect(parsePreviewAgentMessage('{"v":1,"type":"ready"}')).toEqual({ v: 1, type: 'ready' })
    expect(parsePreviewAgentMessage(JSON.stringify({
      v: 1,
      type: 'navigated',
      url: 'https://example.com',
      title: 'Example',
    }))).toEqual({
      v: 1,
      type: 'navigated',
      url: 'https://example.com',
      title: 'Example',
    })
    expect(parsePreviewAgentMessage(JSON.stringify({
      v: 1,
      type: 'screenshot',
      dataUrl: 'data:image/png;base64,AAAA',
      kind: 'full',
    }))).toEqual({
      v: 1,
      type: 'screenshot',
      dataUrl: 'data:image/png;base64,AAAA',
      kind: 'full',
    })
    expect(parsePreviewAgentMessage('{"v":1,"type":"screenshot","dataUrl":"data:text/html;base64,AAAA","kind":"full"}')).toBeNull()
    expect(parsePreviewAgentMessage(JSON.stringify({ v: 1, type: 'navigated', url: 'file:///tmp/a', title: 'A' }))).toBeNull()
    expect(parsePreviewAgentMessage(JSON.stringify({ v: 1, type: 'selection', payload: null }))).toBeNull()
  })

  it('removes and closes the preview view', async () => {
    const view = new FakeView()
    const parent = {
      contentView: {
        addChildView: vi.fn(),
        removeChildView: vi.fn(),
      },
    }
    const service = new ElectronPreviewService({
      createView: () => view,
      previewScriptPath: previewScript(),
    })

    await service.open(parent, 'https://example.com', { x: 0, y: 0, width: 100, height: 100 })
    service.close()

    expect(parent.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(view.webContents.close).toHaveBeenCalled()
    await expect(service.message({ v: 1, type: 'capture', kind: 'full' })).rejects.toThrow('preview not open')
  })
})
