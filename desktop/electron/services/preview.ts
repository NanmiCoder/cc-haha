import { existsSync, readFileSync } from 'node:fs'
import { ELECTRON_EVENT_CHANNELS } from '../ipc/channels'
import { parsePreviewAgentMessage, type PreviewAgentMessage } from '../ipc/previewMessage'
import { normalizeZoomFactor } from './zoom'
export { parsePreviewAgentMessage, shouldForwardPreviewMessage } from '../ipc/previewMessage'

export type PreviewBounds = {
  x: number
  y: number
  width: number
  height: number
}

type PreviewCaptureRect = PreviewBounds

type PreviewDebuggerLike = {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>
}

const FULL_CAPTURE_MAX_EDGE = 16_384
const FULL_CAPTURE_MAX_PIXELS = 32_000_000

export type PreviewWebContentsLike = {
  loadURL(url: string): Promise<unknown>
  executeJavaScript(script: string): Promise<unknown>
  on(event: 'did-finish-load', handler: () => void): unknown
  close?(): void
  isDestroyed?(): boolean
  capturePage?(rect?: PreviewCaptureRect): Promise<{ toDataURL(): string }>
  debugger?: PreviewDebuggerLike
  setZoomFactor?(factor: number): void
  send(channel: string, payload: unknown): void
}

export type PreviewViewLike = {
  webContents: PreviewWebContentsLike
  setBounds(bounds: PreviewBounds): void
  setVisible?(visible: boolean): void
}

export type PreviewParentWindowLike = {
  contentView: {
    addChildView(view: unknown): void
    removeChildView(view: unknown): void
  }
  getBounds?(): PreviewBounds
}

export type ElectronPreviewServiceOptions = {
  createView: () => PreviewViewLike
  previewScriptPath: string
  resolveScaleFactor?: (parent: PreviewParentWindowLike) => number
}

type PreviewHostCaptureMessage = {
  v: 1
  type: 'capture'
  kind: 'full' | 'viewport' | 'element'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHostCaptureMessage(payload: unknown): payload is PreviewHostCaptureMessage {
  return isPlainRecord(payload) &&
    payload.v === 1 &&
    payload.type === 'capture' &&
    (payload.kind === 'full' || payload.kind === 'viewport' || payload.kind === 'element')
}

export function normalizePreviewUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('empty url')
  const parsed = new URL(trimmed)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported url scheme: ${trimmed}`)
  }
  return trimmed
}

export function normalizePreviewBounds(bounds: PreviewBounds): PreviewBounds {
  for (const [key, value] of Object.entries(bounds)) {
    if (!Number.isFinite(value)) throw new Error(`invalid preview bounds ${key}`)
  }
  return {
    x: bounds.x,
    y: bounds.y,
    width: Math.max(0, bounds.width),
    height: Math.max(0, bounds.height),
  }
}

function normalizeScaleFactor(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 1
}

function roundDip(value: number): number {
  return Math.round(value * 1000000) / 1000000
}

export function snapPreviewBoundsToScaleFactor(bounds: PreviewBounds, scaleFactor: unknown): PreviewBounds {
  const normalized = normalizePreviewBounds(bounds)
  const factor = normalizeScaleFactor(scaleFactor)
  const left = Math.round(normalized.x * factor)
  const top = Math.round(normalized.y * factor)
  const right = Math.round((normalized.x + normalized.width) * factor)
  const bottom = Math.round((normalized.y + normalized.height) * factor)

  return {
    x: roundDip(left / factor),
    y: roundDip(top / factor),
    width: roundDip(Math.max(0, right - left) / factor),
    height: roundDip(Math.max(0, bottom - top) / factor),
  }
}

export function resolvePreviewScriptPath(previewScriptPath: string): string {
  if (existsSync(previewScriptPath)) return previewScriptPath
  const unpackedPath = previewScriptPath.replace(/\.asar([/\\])/, '.asar.unpacked$1')
  if (unpackedPath !== previewScriptPath && existsSync(unpackedPath)) return unpackedPath
  return previewScriptPath
}

export class ElectronPreviewService {
  private readonly createView: () => PreviewViewLike
  private readonly previewScriptPath: string
  private readonly resolveScaleFactor?: (parent: PreviewParentWindowLike) => number
  private view: PreviewViewLike | null = null
  private parent: PreviewParentWindowLike | null = null
  private requestedBounds: PreviewBounds | null = null
  private zoomFactor = 1
  private fullCapture: {
    webContents: PreviewWebContentsLike
    promise: Promise<string>
  } | null = null

  constructor(options: ElectronPreviewServiceOptions) {
    this.createView = options.createView
    this.previewScriptPath = options.previewScriptPath
    this.resolveScaleFactor = options.resolveScaleFactor
  }

  async open(parent: PreviewParentWindowLike, url: string, bounds: PreviewBounds): Promise<void> {
    const normalizedUrl = normalizePreviewUrl(url)
    this.parent = parent
    this.requestedBounds = normalizePreviewBounds(bounds)
    const view = this.ensureView(parent)
    this.applyBounds(view)
    await view.webContents.loadURL(normalizedUrl)
  }

  async navigate(url: string): Promise<void> {
    const view = this.requireView()
    await view.webContents.loadURL(normalizePreviewUrl(url))
  }

  setBounds(bounds: PreviewBounds): void {
    this.requestedBounds = normalizePreviewBounds(bounds)
    this.applyBounds(this.view)
  }

  setVisible(visible: boolean): void {
    this.view?.setVisible?.(visible)
  }

  setZoomFactor(value: unknown): void {
    this.zoomFactor = normalizeZoomFactor(value)
    this.applyZoomFactor(this.view)
  }

  refreshBounds(): void {
    this.applyBounds(this.view)
  }

  close(): void {
    if (!this.view) return
    this.parent?.contentView.removeChildView(this.view)
    if (!this.view.webContents.isDestroyed?.()) {
      this.view.webContents.close?.()
    }
    this.view = null
    this.parent = null
    this.requestedBounds = null
  }

  async message(payload: unknown, renderer?: PreviewWebContentsLike | null): Promise<void> {
    if (isHostCaptureMessage(payload) && renderer) {
      await this.captureScreenshotToRenderer(payload.kind, renderer)
      return
    }

    const raw = JSON.stringify(payload)
    const script = `globalThis.__PREVIEW_BRIDGE__?.handleHostRaw(${JSON.stringify(raw)})`
    await this.requireView().webContents.executeJavaScript(script)
  }

  async sendMessageToRenderer(sender: PreviewWebContentsLike, raw: unknown, renderer: PreviewWebContentsLike | null | undefined): Promise<void> {
    if (sender !== this.view?.webContents) return
    if (typeof raw !== 'string') return
    const message = parsePreviewAgentMessage(raw)
    if (!message) return
    const event = message.type === 'selection'
      ? await this.withNativeSelectionScreenshot(message)
      : message
    renderer?.send(ELECTRON_EVENT_CHANNELS.previewEvent, event)
  }

  private ensureView(parent: PreviewParentWindowLike): PreviewViewLike {
    if (this.view) return this.view
    const view = this.createView()
    parent.contentView.addChildView(view)
    view.webContents.on('did-finish-load', () => {
      void this.injectPreviewAgent(view)
    })
    this.applyZoomFactor(view)
    this.view = view
    this.parent = parent
    return view
  }

  private requireView(): PreviewViewLike {
    if (!this.view) throw new Error('preview not open')
    return this.view
  }

  private async injectPreviewAgent(view: PreviewViewLike): Promise<void> {
    if (view.webContents.isDestroyed?.()) return
    const script = readFileSync(resolvePreviewScriptPath(this.previewScriptPath), 'utf8')
    await view.webContents.executeJavaScript(script)
  }

  private async captureNativeDataUrl(kind: PreviewHostCaptureMessage['kind'] = 'viewport'): Promise<string> {
    const webContents = this.requireView().webContents
    if (kind === 'full') return this.captureFullPageDataUrl(webContents)
    if (!webContents.capturePage) throw new Error('native preview capture unavailable')
    const image = await webContents.capturePage()
    return image.toDataURL()
  }

  private async captureFullPageDataUrl(webContents: PreviewWebContentsLike): Promise<string> {
    if (this.fullCapture?.webContents === webContents) {
      return await this.fullCapture.promise
    }

    const promise = this.captureFullPageDataUrlOnce(webContents)
    const capture = { webContents, promise }
    this.fullCapture = capture
    try {
      return await promise
    } finally {
      if (this.fullCapture === capture) this.fullCapture = null
    }
  }

  private async captureFullPageDataUrlOnce(webContents: PreviewWebContentsLike): Promise<string> {
    const debuggerApi = webContents.debugger
    if (!debuggerApi) throw new Error('full preview capture unavailable')

    let attachedHere = false
    try {
      if (!debuggerApi.isAttached()) {
        debuggerApi.attach('1.3')
        attachedHere = true
      }

      const metrics = await debuggerApi.sendCommand('Page.getLayoutMetrics')
      if (!isPlainRecord(metrics)) throw new Error('invalid full preview layout metrics')
      const contentSize = isPlainRecord(metrics.cssContentSize)
        ? metrics.cssContentSize
        : metrics.contentSize
      if (!isPlainRecord(contentSize)) throw new Error('invalid full preview layout metrics')

      const width = Math.ceil(Number(contentSize.width))
      const height = Math.ceil(Number(contentSize.height))
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('invalid full preview dimensions')
      }
      if (
        width > FULL_CAPTURE_MAX_EDGE ||
        height > FULL_CAPTURE_MAX_EDGE ||
        width * height > FULL_CAPTURE_MAX_PIXELS
      ) {
        throw new Error(`full preview capture exceeds safety limit: ${width}x${height}`)
      }

      const screenshot = await debuggerApi.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      })
      if (!isPlainRecord(screenshot) || typeof screenshot.data !== 'string' || !screenshot.data) {
        throw new Error('invalid full preview screenshot data')
      }
      return `data:image/png;base64,${screenshot.data}`
    } finally {
      if (attachedHere) {
        try {
          if (debuggerApi.isAttached()) debuggerApi.detach()
        } catch {
          // The page may close while a full-page capture is in flight.
        }
      }
    }
  }

  private applyZoomFactor(view: PreviewViewLike | null): void {
    view?.webContents.setZoomFactor?.(this.zoomFactor)
  }

  private applyBounds(view: PreviewViewLike | null): void {
    if (!view || !this.parent || !this.requestedBounds) return
    const scaleFactor = this.resolveScaleFactor?.(this.parent) ?? 1
    view.setBounds(snapPreviewBoundsToScaleFactor(this.requestedBounds, scaleFactor))
  }

  private async captureScreenshotToRenderer(kind: PreviewHostCaptureMessage['kind'], renderer: PreviewWebContentsLike): Promise<void> {
    try {
      renderer.send(ELECTRON_EVENT_CHANNELS.previewEvent, {
        v: 1,
        type: 'screenshot',
        dataUrl: await this.captureNativeDataUrl(kind),
        kind,
      })
    } catch (error) {
      renderer.send(ELECTRON_EVENT_CHANNELS.previewEvent, {
        v: 1,
        type: 'error',
        message: String(error),
      })
    }
  }

  private async withNativeSelectionScreenshot(message: Extract<PreviewAgentMessage, { type: 'selection' }>): Promise<PreviewAgentMessage> {
    try {
      const payload = message.payload
      const screenshot = isPlainRecord(payload.screenshot) ? payload.screenshot : {}
      return {
        ...message,
        payload: {
          ...payload,
          screenshot: {
            ...screenshot,
            kind: screenshot.kind ?? 'region',
            dataUrl: await this.captureNativeDataUrl('viewport'),
          },
        },
      }
    } catch {
      return message
    } finally {
      await this.clearSelectionOverlay()
    }
  }

  private async clearSelectionOverlay(): Promise<void> {
    const webContents = this.view?.webContents
    if (!webContents || webContents.isDestroyed?.()) return
    try {
      await webContents.executeJavaScript('globalThis.__PREVIEW_AGENT_CLEAR_SELECTION_OVERLAY__?.()')
    } catch {
      // The page may navigate while the native capture is in flight.
    }
  }
}
