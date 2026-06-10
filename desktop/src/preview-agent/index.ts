import { createBridge } from './bridge'
import { captureToDataUrl, createAnnotationOverlay } from './screenshot'
import { createPicker } from './picker'
import { buildElementMetadata } from './metadata'
import { createEditBubble } from './editBubble'

;(() => {
  ;(window as unknown as { __PREVIEW_AGENT__?: boolean }).__PREVIEW_AGENT__ = true

  const previewWindow = window as unknown as {
    __DESKTOP_PREVIEW_POST__?: (raw: string) => void
    __PREVIEW_BRIDGE__?: unknown
    __PREVIEW_AGENT_CLEAR_SELECTION_OVERLAY__?: () => void
  } & Record<string, unknown>

  const postToHost = (raw: string) => {
    const post = previewWindow.__DESKTOP_PREVIEW_POST__
    if (post) post(raw)
    // 回退（M1 证伪 IPC 时启用）：new WebSocket('ws://127.0.0.1:'+PORT+'/preview-agent') ...
  }

  const bridge = createBridge({ postToHost, location: window.location, title: document.title })
  previewWindow.__PREVIEW_BRIDGE__ = bridge
  previewWindow.__PREVIEW_AGENT_CAPTURE__ = captureToDataUrl

  let selectionOverlayCleanup: (() => void) | null = null
  let selectionOverlayTimer: number | null = null
  const clearSelectionOverlay = () => {
    if (selectionOverlayTimer !== null) {
      window.clearTimeout(selectionOverlayTimer)
      selectionOverlayTimer = null
    }
    selectionOverlayCleanup?.()
    selectionOverlayCleanup = null
  }
  previewWindow.__PREVIEW_AGENT_CLEAR_SELECTION_OVERLAY__ = clearSelectionOverlay

  bridge.on('capture', async (m) => {
    try { bridge.send({ type: 'screenshot', dataUrl: await captureToDataUrl(m.kind), kind: m.kind }) }
    catch (e) { bridge.reportError(String(e)) }
  })

  let pickerOn = false
  let activeBubble: { destroy: () => void } | null = null
  const picker = createPicker({ onSelect: () => {} })

  const teardown = () => {
    activeBubble?.destroy()
    activeBubble = null
    pickerOn = false
    picker.exit()
    bridge.send({ type: 'picker-exited' })
  }

  const emitSelection = async (el: Element, change?: unknown) => {
    try {
      clearSelectionOverlay()
      const overlay = createAnnotationOverlay(el, 1)
      selectionOverlayCleanup = () => { overlay.remove() }
      selectionOverlayTimer = window.setTimeout(clearSelectionOverlay, 5000)
      bridge.send({
        type: 'selection',
        payload: {
          pageUrl: window.location.href,
          sourceHint: document.title || undefined,
          element: buildElementMetadata(el),
          change,
          screenshot: { kind: 'region' },
        },
      })
    } catch (e) { bridge.reportError(String(e)) }
  }

  bridge.on('enter-picker', () => { pickerOn = true; picker.enter() })
  bridge.on('exit-picker', () => { teardown() })

  document.addEventListener('mousemove', (e) => {
    if (!pickerOn) return
    const t = e.target
    if (t instanceof Element) picker.hover(t)
  }, true)

  document.addEventListener('click', (e) => {
    if (!pickerOn || activeBubble) return
    e.preventDefault(); e.stopPropagation()
    picker.select()
    const el = picker.current()
    pickerOn = false   // stop hovering; keep highlight on the selected element while the bubble is open
    if (!(el instanceof HTMLElement)) { teardown(); return }
    activeBubble = createEditBubble(el, {
      onConfirm: (change) => { teardown(); void emitSelection(el, change) },
      onCancel: () => { teardown() },
    })
  }, true)

  const onReady = () => { bridge.reportReady(); bridge.reportNavigated() }
  if (document.readyState !== 'loading') onReady()
  else document.addEventListener('DOMContentLoaded', onReady)
  window.addEventListener('popstate', () => bridge.reportNavigated())
})()
