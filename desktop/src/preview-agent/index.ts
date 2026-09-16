import { createBridge } from './bridge'
import { captureToDataUrl, createAnnotationOverlay } from './screenshot'
import { createPicker } from './picker'
import { buildElementMetadata } from './metadata'
import { createEditBubble, type EditBubbleCopy } from './editBubble'
import { createZoomControls } from './zoomControls'

;(() => {
  ;(window as unknown as { __PREVIEW_AGENT__?: boolean }).__PREVIEW_AGENT__ = true

  const previewWindow = window as unknown as {
    __DESKTOP_PREVIEW_POST__?: (raw: string) => void
    __PREVIEW_BRIDGE__?: unknown
    __PREVIEW_AGENT_CLEAR_SELECTION_OVERLAY__?: (captureId?: number) => void
  } & Record<string, unknown>

  const postToHost = (raw: string) => {
    const post = previewWindow.__DESKTOP_PREVIEW_POST__
    if (post) post(raw)
    // 回退（M1 证伪 IPC 时启用）：new WebSocket('ws://127.0.0.1:'+PORT+'/preview-agent') ...
  }

  const bridge = createBridge({ postToHost, location: window.location, title: document.title })
  previewWindow.__PREVIEW_BRIDGE__ = bridge
  previewWindow.__PREVIEW_AGENT_CAPTURE__ = captureToDataUrl
  const zoomControls = createZoomControls(action => bridge.send({ type: 'browser-zoom', action }))
  previewWindow.__PREVIEW_AGENT_SET_CHROME_HIDDEN__ = (hidden: boolean) => zoomControls.setCaptureSuppressed(hidden)
  bridge.on('browser-controls', message => zoomControls.update(message))
  window.addEventListener('pagehide', () => zoomControls.destroy())
  window.addEventListener('pageshow', () => zoomControls.restore())

  let selectionOverlayCleanup: (() => void) | null = null
  let selectionOverlayTimer: number | null = null
  let selectionOverlayId: number | null = null
  let selectionCaptureSequence = 0
  let pickerOn = false
  let activeBubble: { destroy: () => void; revert: () => void } | null = null
  const updateChromeSuppression = () => {
    zoomControls.setSuppressed(pickerOn || activeBubble !== null || selectionOverlayCleanup !== null || (persistentPicker && !temporarilyBrowsing))
  }
  const clearSelectionOverlay = (captureId?: number) => {
    // Captures can finish after a newer selection, or after the 5 s fallback.
    // A stale completion owns only its own overlay, never the current one.
    if (captureId !== undefined && captureId !== selectionOverlayId) return
    if (selectionOverlayTimer !== null) {
      window.clearTimeout(selectionOverlayTimer)
      selectionOverlayTimer = null
    }
    selectionOverlayCleanup?.()
    selectionOverlayCleanup = null
    selectionOverlayId = null
    updateChromeSuppression()
  }
  previewWindow.__PREVIEW_AGENT_CLEAR_SELECTION_OVERLAY__ = clearSelectionOverlay

  bridge.on('capture', async (m) => {
    try { bridge.send({ type: 'screenshot', dataUrl: await captureToDataUrl(m.kind), kind: m.kind }) }
    catch (e) { bridge.reportError(String(e)) }
  })

  let pickerGeneration: number | undefined
  const acceptPickerCommand = (generation?: number) => {
    if (generation !== undefined && pickerGeneration !== undefined && generation <= pickerGeneration) return false
    pickerGeneration = generation
    return true
  }
  let persistentPicker = false
  let temporarilyBrowsing = false
  let pickerMode: 'single' | 'batch' = 'single'
  let pickerLabel = 1
  let pickerCopy: EditBubbleCopy | undefined
  let itemSequence = 0
  const queuedReverts = new Map<string, () => void>()
  const picker = createPicker({ onSelect: () => {} })

  // 只做页面侧清理。宿主的 picker 授权由 selection / picker-exited 之一消费，
  // 所以产出 selection 的路径必须走这个函数，绝不能再补发 picker-exited。
  const closePicker = () => {
    activeBubble?.destroy()
    activeBubble = null
    pickerOn = false
    temporarilyBrowsing = false
    picker.exit()
    updateChromeSuppression()
  }

  // 本次拾取结束但没有产出 selection：通知宿主解除授权、复位按钮态。
  const teardown = (reason: 'cancel-current' | 'host' | 'invalid-target') => {
    persistentPicker = false
    activeBubble?.revert()
    closePicker()
    bridge.send({ type: 'picker-exited', reason, ...(pickerGeneration !== undefined ? { generation: pickerGeneration } : {}) })
  }

  const emitSelection = async (
    el: Element,
    change: unknown,
    delivery: 'send' | 'queue',
    draftItemId?: string,
  ) => {
    const captureId = ++selectionCaptureSequence
    try {
      clearSelectionOverlay()
      const overlay = createAnnotationOverlay(el, pickerLabel)
      selectionOverlayCleanup = () => { overlay.remove() }
      selectionOverlayId = captureId
      updateChromeSuppression()
      selectionOverlayTimer = window.setTimeout(() => clearSelectionOverlay(captureId), 5000)
      bridge.send({
        type: 'selection',
        ...(pickerGeneration !== undefined ? { generation: pickerGeneration } : {}),
        payload: {
          pageUrl: window.location.href,
          sourceHint: document.title || undefined,
          element: buildElementMetadata(el),
          change,
          delivery,
          selectionNumber: pickerLabel,
          ...(draftItemId ? { draftItemId } : {}),
          screenshot: { kind: 'region', captureId },
        },
      })
    } catch (e) {
      clearSelectionOverlay(captureId)
      if (draftItemId) {
        queuedReverts.get(draftItemId)?.()
        queuedReverts.delete(draftItemId)
      }
      bridge.reportError(String(e))
    }
  }

  bridge.on('enter-picker', (message) => {
    if (!acceptPickerCommand(message.generation)) return
    activeBubble?.revert()
    closePicker()
    persistentPicker = message.persistent === true
    pickerMode = message.mode ?? 'single'
    pickerLabel = message.label ?? 1
    pickerCopy = message.copy
    pickerOn = true
    updateChromeSuppression()
    picker.enter()
  })
  bridge.on('exit-picker', (message) => {
    if (!acceptPickerCommand(message.generation)) return
    teardown('host')
  })
  bridge.on('undo-selection', (message) => {
    queuedReverts.get(message.itemId)?.()
    queuedReverts.delete(message.itemId)
    clearSelectionOverlay()
  })
  bridge.on('clear-selection-draft', () => {
    for (const revert of [...queuedReverts.values()].reverse()) revert()
    queuedReverts.clear()
    clearSelectionOverlay()
  })
  bridge.on('commit-selection-draft', () => {
    queuedReverts.clear()
    clearSelectionOverlay()
  })

  document.addEventListener('mousemove', (e) => {
    if (!pickerOn) return
    if (zoomControls.ownsTarget(e.composedPath())) return
    const t = e.target
    if (t instanceof Element) picker.hover(t)
  }, true)

  document.addEventListener('click', (e) => {
    if (!pickerOn || activeBubble) return
    if (zoomControls.ownsTarget(e.composedPath())) return
    e.preventDefault(); e.stopPropagation()
    picker.select()
    const el = picker.current()
    pickerOn = false   // stop hovering; keep highlight on the selected element while the bubble is open
    if (!(el instanceof HTMLElement)) { teardown('invalid-target'); return }
    activeBubble = createEditBubble(el, {
      // selection 自带「本次拾取结束」的语义，宿主收到后会自行复位 picker 态。
      // 若这里先发 picker-exited，宿主会把授权解除在前、selection 到达在后而丢弃它。
      onConfirm: (change) => { closePicker(); void emitSelection(el, change, 'send') },
      onQueue: (change) => {
        const itemId = `preview-selection-${++itemSequence}`
        const revert = activeBubble?.revert
        closePicker()
        if (revert) queuedReverts.set(itemId, revert)
        void emitSelection(el, change, 'queue', itemId)
      },
      onCancel: () => {
        if (!persistentPicker) { teardown('cancel-current'); return }
        activeBubble?.revert()
        closePicker()
        pickerOn = true
        picker.enter()
        updateChromeSuppression()
      },
      mode: pickerMode,
      copy: pickerCopy,
    })
    updateChromeSuppression()
  }, true)

  // Space is a temporary pass-through only while hovering. Text entry in the
  // edit bubble remains normal, and Escape always leaves persistent mode.
  document.addEventListener('keydown', (event) => {
    if (!persistentPicker) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      teardown('host')
      return
    }
    if (event.code !== 'Space' || activeBubble || !pickerOn) return
    const target = event.composedPath()[0]
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return
    event.preventDefault()
    event.stopImmediatePropagation()
    temporarilyBrowsing = true
    pickerOn = false
    picker.exit()
    updateChromeSuppression()
  }, true)
  const resumeAfterBrowsing = () => {
    if (!persistentPicker || !temporarilyBrowsing) return
    temporarilyBrowsing = false
    pickerOn = true
    picker.enter()
    updateChromeSuppression()
  }
  document.addEventListener('keyup', (event) => {
    if (event.code !== 'Space' || !temporarilyBrowsing) return
    event.preventDefault()
    event.stopImmediatePropagation()
    resumeAfterBrowsing()
  }, true)
  window.addEventListener('blur', resumeAfterBrowsing)

  const onReady = () => { bridge.send({ type: 'ready', supportsPickerGeneration: true }); bridge.reportNavigated() }
  if (document.readyState !== 'loading') onReady()
  else document.addEventListener('DOMContentLoaded', onReady)
  window.addEventListener('popstate', () => bridge.reportNavigated())
})()
