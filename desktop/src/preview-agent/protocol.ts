import type { PreviewBrowserControlsMessage } from '../lib/desktopHost/types'

export type AgentMessage =
  | { type: 'ready'; supportsPickerGeneration?: boolean }
  | { type: 'browser-zoom'; action: 'out' | 'in' | 'reset' }
  | { type: 'navigated'; url: string; title: string }
  | { type: 'error'; message: string }
  | { type: 'selection'; generation?: number; payload: unknown }   // M5 填充结构
  | { type: 'screenshot'; dataUrl: string; kind: 'full' | 'viewport' | 'element' } // M4
  | { type: 'picker-exited'; generation?: number; reason?: 'cancel-current' | 'host' | 'invalid-target' }

export type PickerCopy = {
  cancel: string
  send: string
  queueAndContinue: string
  add: string
  descriptionPlaceholder: string
}

export type HostMessage =
  | Omit<PreviewBrowserControlsMessage, 'v'>
  | { type: 'enter-picker'; generation?: number; persistent?: boolean; mode?: 'single' | 'batch'; label?: number; copy?: PickerCopy }
  | { type: 'exit-picker'; generation?: number }
  | { type: 'undo-selection'; itemId: string }
  | { type: 'clear-selection-draft' }
  | { type: 'commit-selection-draft' }
  | { type: 'capture'; kind: 'full' | 'viewport' | 'element' }

const MAX_COPY_LENGTH = 80

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPickerCopy(value: unknown): value is PickerCopy {
  if (!isRecord(value)) return false
  return ['cancel', 'send', 'queueAndContinue', 'add', 'descriptionPlaceholder']
    .every((key) => typeof value[key] === 'string' && value[key].length <= MAX_COPY_LENGTH)
}

export function serializeAgentMessage(msg: AgentMessage): string {
  return JSON.stringify({ v: 1, ...msg })
}

export function parseHostMessage(raw: string): HostMessage | null {
  try {
    const obj = JSON.parse(raw) as unknown
    if (!isRecord(obj) || obj.v !== 1 || typeof obj.type !== 'string') return null

    if (obj.type === 'browser-controls') {
      // Native keyboard/pinch zoom can exceed our buttons' 50–200% range.
      // Keep the displayed factor truthful and let Reset bring it back.
      if (typeof obj.zoomFactor !== 'number' || !Number.isFinite(obj.zoomFactor) || obj.zoomFactor < 0.1 || obj.zoomFactor > 10) return null
      if (typeof obj.appZoom !== 'number' || !Number.isFinite(obj.appZoom) || obj.appZoom < 0.5 || obj.appZoom > 2) return null
      if (!isRecord(obj.copy) || !isRecord(obj.colors)) return null
      const copy = obj.copy
      const colors = obj.colors
      if (!['zoom', 'zoomOut', 'zoomIn', 'zoomReset'].every(key => typeof copy[key] === 'string' && copy[key].length <= MAX_COPY_LENGTH)) return null
      if (!['background', 'foreground', 'muted', 'border', 'hover', 'focus', 'shadow'].every(key => typeof colors[key] === 'string' && colors[key].length <= 256)) return null
      return { type: 'browser-controls', zoomFactor: obj.zoomFactor, appZoom: obj.appZoom,
        copy: copy as PreviewBrowserControlsMessage['copy'], colors: colors as PreviewBrowserControlsMessage['colors'] }
    }

    if ((obj.type === 'enter-picker' || obj.type === 'exit-picker') && obj.generation !== undefined &&
        (!Number.isSafeInteger(obj.generation) || Number(obj.generation) < 1)) return null
    if (obj.type === 'enter-picker') {
      if (obj.persistent !== undefined && typeof obj.persistent !== 'boolean') return null
      if (obj.mode !== undefined && obj.mode !== 'single' && obj.mode !== 'batch') return null
      if (obj.label !== undefined && (!Number.isInteger(obj.label) || Number(obj.label) < 1 || Number(obj.label) > 99)) return null
      if (obj.copy !== undefined && !isPickerCopy(obj.copy)) return null
      return {
        type: 'enter-picker',
        ...(typeof obj.generation === 'number' ? { generation: obj.generation } : {}),
        ...(typeof obj.persistent === 'boolean' ? { persistent: obj.persistent } : {}),
        ...(obj.mode ? { mode: obj.mode } : {}),
        ...(typeof obj.label === 'number' ? { label: obj.label } : {}),
        ...(obj.copy ? { copy: obj.copy } : {}),
      }
    }
    if (obj.type === 'exit-picker') return { type: 'exit-picker', ...(typeof obj.generation === 'number' ? { generation: obj.generation } : {}) }
    if (obj.type === 'clear-selection-draft' || obj.type === 'commit-selection-draft') {
      return { type: obj.type }
    }
    if (obj.type === 'undo-selection') {
      return typeof obj.itemId === 'string' && obj.itemId.length > 0 && obj.itemId.length <= 128
        ? { type: 'undo-selection', itemId: obj.itemId }
        : null
    }
    if (obj.type === 'capture') {
      return obj.kind === 'full' || obj.kind === 'viewport' || obj.kind === 'element'
        ? { type: 'capture', kind: obj.kind }
        : null
    }
    return null
  } catch {
    return null
  }
}
