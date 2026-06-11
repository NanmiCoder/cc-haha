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
  shouldForwardPreviewMessage,
  type PreviewViewLike,
  type PreviewWebContentsLike,
} from './preview'

class FakeWebContents implements PreviewWebContentsLike {
  loadedUrls: string[] = []
  scripts: string[] = []
  sent: Array<{ channel: string, payload: unknown }> = []
  close = vi.fn()
  capturePage = vi.fn(async () => ({ toDataURL: () => 'data:image/png;base64,NATIVE' }))
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

  it('normalizes finite bounds for WebContentsView', () => {
    expect(normalizePreviewBounds({ x: 1.2, y: 2.7, width: 20.4, height: -1 })).toEqual({
      x: 1,
      y: 3,
      width: 20,
      height: 0,
    })
    expect(() => normalizePreviewBounds({ x: Number.NaN, y: 0, width: 1, height: 1 })).toThrow('invalid preview bounds x')
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

    expect(view.webContents.capturePage).toHaveBeenCalledTimes(1)
    expect(view.webContents.scripts.at(-1)).toBe('window.__previewInjected = true')
    expect(renderer.sent).toEqual([
      {
        channel: ELECTRON_EVENT_CHANNELS.previewEvent,
        payload: { v: 1, type: 'screenshot', dataUrl: 'data:image/png;base64,NATIVE', kind: 'full' },
      },
    ])
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
