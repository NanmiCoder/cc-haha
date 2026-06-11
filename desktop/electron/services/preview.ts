import { existsSync, readFileSync } from 'node:fs'
import { ELECTRON_EVENT_CHANNELS } from '../ipc/channels'
import { parsePreviewAgentMessage, type PreviewAgentMessage } from '../ipc/previewMessage'
export { parsePreviewAgentMessage, shouldForwardPreviewMessage } from '../ipc/previewMessage'

export type PreviewBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type PreviewWebContentsLike = {
  loadURL(url: string): Promise<unknown>
  executeJavaScript(script: string): Promise<unknown>
  on(event: 'did-finish-load', handler: () => void): unknown
  close?(): void
  isDestroyed?(): boolean
  capturePage?(): Promise<{ toDataURL(): string }>
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
}

export type ElectronPreviewServiceOptions = {
  createView: () => PreviewViewLike
  previewScriptPath: string
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
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
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
  private view: PreviewViewLike | null = null
  private parent: PreviewParentWindowLike | null = null

  constructor(options: ElectronPreviewServiceOptions) {
    this.createView = options.createView
    this.previewScriptPath = options.previewScriptPath
  }

  async open(parent: PreviewParentWindowLike, url: string, bounds: PreviewBounds): Promise<void> {
    const normalizedUrl = normalizePreviewUrl(url)
    const normalizedBounds = normalizePreviewBounds(bounds)
    const view = this.ensureView(parent)
    view.setBounds(normalizedBounds)
    await view.webContents.loadURL(normalizedUrl)
  }

  async navigate(url: string): Promise<void> {
    const view = this.requireView()
    await view.webContents.loadURL(normalizePreviewUrl(url))
  }

  setBounds(bounds: PreviewBounds): void {
    this.view?.setBounds(normalizePreviewBounds(bounds))
  }

  setVisible(visible: boolean): void {
    this.view?.setVisible?.(visible)
  }

  close(): void {
    if (!this.view) return
    this.parent?.contentView.removeChildView(this.view)
    if (!this.view.webContents.isDestroyed?.()) {
      this.view.webContents.close?.()
    }
    this.view = null
    this.parent = null
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

  private async captureNativeDataUrl(): Promise<string> {
    const webContents = this.requireView().webContents
    if (!webContents.capturePage) throw new Error('native preview capture unavailable')
    const image = await webContents.capturePage()
    return image.toDataURL()
  }

  private async captureScreenshotToRenderer(kind: PreviewHostCaptureMessage['kind'], renderer: PreviewWebContentsLike): Promise<void> {
    try {
      renderer.send(ELECTRON_EVENT_CHANNELS.previewEvent, {
        v: 1,
        type: 'screenshot',
        dataUrl: await this.captureNativeDataUrl(),
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
            dataUrl: await this.captureNativeDataUrl(),
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
