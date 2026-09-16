export const MAX_PREVIEW_EVENT_BYTES = 8 * 1024 * 1024
const MAX_PREVIEW_TEXT_LENGTH = 32_768

export type PreviewAgentMessage =
  | { v: 1, type: 'ready', supportsPickerGeneration?: boolean }
  | { v: 1, type: 'browser-zoom', action: 'out' | 'in' | 'reset' }
  | { v: 1, type: 'picker-exited', generation?: number, reason?: 'cancel-current' | 'host' | 'invalid-target' }
  | { v: 1, type: 'navigated', url: string, title: string }
  | { v: 1, type: 'error', message: string }
  | { v: 1, type: 'screenshot', dataUrl: string, kind: 'full' | 'viewport' | 'element' }
  | { v: 1, type: 'selection', generation?: number, payload: Record<string, unknown> }

function byteLength(input: string): number {
  return new TextEncoder().encode(input).byteLength
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown, maxLength = MAX_PREVIEW_TEXT_LENGTH): value is string {
  return typeof value === 'string' && value.length <= maxLength
}

function isPreviewDataUrl(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length <= MAX_PREVIEW_EVENT_BYTES &&
    /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\r\n]+$/i.test(value)
}

function isPreviewKind(value: unknown): value is 'full' | 'viewport' | 'element' {
  return value === 'full' || value === 'viewport' || value === 'element'
}

function isSelectionScreenshotKind(value: unknown): value is 'full' | 'viewport' | 'element' | 'region' {
  return isPreviewKind(value) || value === 'region'
}

export function parsePreviewAgentMessage(raw: string): PreviewAgentMessage | null {
  if (byteLength(raw) > MAX_PREVIEW_EVENT_BYTES) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!isPlainRecord(parsed) || parsed.v !== 1 || typeof parsed.type !== 'string') {
    return null
  }

  if ((parsed.type === 'selection' || parsed.type === 'picker-exited') && parsed.generation !== undefined &&
      (!Number.isSafeInteger(parsed.generation) || Number(parsed.generation) < 1)) return null
  const ownership = typeof parsed.generation === 'number' ? { generation: parsed.generation } : {}

  switch (parsed.type) {
    case 'browser-zoom':
      return parsed.action === 'out' || parsed.action === 'in' || parsed.action === 'reset'
        ? { v: 1, type: 'browser-zoom', action: parsed.action }
        : null
    case 'ready':
      if (parsed.supportsPickerGeneration !== undefined && typeof parsed.supportsPickerGeneration !== 'boolean') return null
      return { v: 1, type: 'ready', ...(typeof parsed.supportsPickerGeneration === 'boolean' ? { supportsPickerGeneration: parsed.supportsPickerGeneration } : {}) }
    case 'picker-exited':
      if (
        parsed.reason !== undefined &&
        parsed.reason !== 'cancel-current' &&
        parsed.reason !== 'host' &&
        parsed.reason !== 'invalid-target'
      ) return null
      return { v: 1, type: 'picker-exited', ...ownership, ...(parsed.reason ? { reason: parsed.reason } : {}) }
    case 'navigated':
      if (!isBoundedString(parsed.url) || !isBoundedString(parsed.title)) return null
      try {
        const url = new URL(parsed.url)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      } catch {
        return null
      }
      return { v: 1, type: 'navigated', url: parsed.url, title: parsed.title }
    case 'error':
      if (!isBoundedString(parsed.message)) return null
      return { v: 1, type: 'error', message: parsed.message }
    case 'screenshot':
      if (!isPreviewDataUrl(parsed.dataUrl) || !isPreviewKind(parsed.kind)) return null
      return { v: 1, type: 'screenshot', dataUrl: parsed.dataUrl, kind: parsed.kind }
    case 'selection':
      if (!isPlainRecord(parsed.payload)) return null
      if ('screenshot' in parsed.payload) {
        const screenshot = parsed.payload.screenshot
        if (!isPlainRecord(screenshot)) return null
        if (screenshot.dataUrl !== undefined && !isPreviewDataUrl(screenshot.dataUrl)) return null
        if (screenshot.kind !== undefined && !isSelectionScreenshotKind(screenshot.kind)) return null
        if (screenshot.captureId !== undefined && (!Number.isSafeInteger(screenshot.captureId) || Number(screenshot.captureId) < 1)) return null
      }
      return { v: 1, type: 'selection', ...ownership, payload: parsed.payload }
    default:
      return null
  }
}

export function shouldForwardPreviewMessage(input: {
  raw: unknown
  href: string
  isTopFrame: boolean
}): input is { raw: string, href: string, isTopFrame: true } {
  if (typeof input.raw !== 'string') return false
  if (byteLength(input.raw) > MAX_PREVIEW_EVENT_BYTES) return false
  if (!input.isTopFrame) return false
  try {
    const parsed = new URL(input.href)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
