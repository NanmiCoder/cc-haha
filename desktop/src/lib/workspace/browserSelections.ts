import { t } from '../../i18n'
import { useChatStore } from '../../stores/chatStore'
import { MAX_PREVIEW_SELECTIONS, usePreviewSelectionStore } from '../../stores/previewSelectionStore'
import { useUIStore } from '../../stores/uiStore'
import { buildSelectionBatchMessage, buildSelectionDirectMessage, type SelectionPayload } from '../selectionComposer'
import { buildPreviewPickerMessage } from '../previewSelectionPicker'
import { workspaceBrowserHost } from './browserHost'

async function endFullPicker(browserTabId: string, rejectedItemId?: string): Promise<void> {
  const report = (error: unknown) => useUIStore.getState().addToast({
    type: 'error', message: t('browser.selection.cleanupFailed', { reason: error instanceof Error ? error.message : String(error) }),
  })
  try { await workspaceBrowserHost.message(browserTabId, { v: 1, type: 'exit-picker' }) } catch (error) { report(error) }
  // Even if exit failed, try to roll back the extra optimistic edit. Accepted
  // draft items stay intact and the user sees any host failure explicitly.
  if (rejectedItemId) {
    try { await workspaceBrowserHost.message(browserTabId, { v: 1, type: 'undo-selection', itemId: rejectedItemId }) } catch (error) { report(error) }
  }
}

// Drafts are keyed by the native page identity, so two pages of one task never
// share element ids, undo commands, or screenshots. They survive UI remounts.
export function handleBrowserSelectionEvent(sessionId: string, browserTabId: string, message: unknown): void {
  if (typeof message !== 'object' || message === null) return
  const parsed = message as { type?: string, reason?: string, persistent?: boolean, payload?: SelectionPayload }
  const drafts = usePreviewSelectionStore.getState()
  if (parsed.type === 'picker-exited') {
    const draft = drafts.bySession[browserTabId]
    if (parsed.reason === 'cancel-current' && draft?.items.length) {
      void workspaceBrowserHost.message(browserTabId, buildPreviewPickerMessage('batch', draft.nextNumber))
    }
    return
  }
  const payload = parsed.payload
  if (parsed.type !== 'selection' || !payload || !payload.element) return
  if (payload.delivery === 'queue') {
    if (!drafts.add(browserTabId, payload)) {
      // An in-flight selection can arrive after the queue reached its cap.
      // End picking and revert only this rejected item's optimistic page edit.
      void endFullPicker(browserTabId, payload.draftItemId)
      useUIStore.getState().addToast({ type: 'info', message: t('browser.selection.limitReached', { count: MAX_PREVIEW_SELECTIONS }) })
      return
    }
    const draft = usePreviewSelectionStore.getState().bySession[browserTabId]!
    if (draft.items.length < MAX_PREVIEW_SELECTIONS && !parsed.persistent) {
      void workspaceBrowserHost.message(browserTabId, buildPreviewPickerMessage('batch', draft.nextNumber))
    } else if (draft.items.length >= MAX_PREVIEW_SELECTIONS) {
      if (parsed.persistent) void endFullPicker(browserTabId)
      useUIStore.getState().addToast({ type: 'info', message: t('browser.selection.limitReached', { count: MAX_PREVIEW_SELECTIONS }) })
    }
    return
  }
  const selection = buildSelectionDirectMessage(payload)
  const attachments = payload.screenshot?.dataUrl ? [{
    type: 'image' as const, name: selection.displayName, mimeType: 'image/png',
    data: payload.screenshot.dataUrl, note: selection.note, quote: payload.element.selector,
  }] : []
  void useChatStore.getState().sendMessage(sessionId, selection.modelText, attachments, {
    displayContent: selection.displayName, displayAttachments: attachments, hideDisplayContent: attachments.length > 0,
  })
}

export async function discardBrowserSelections(browserTabId: string): Promise<void> {
  await workspaceBrowserHost.message(browserTabId, { v: 1, type: 'exit-picker' })
  await workspaceBrowserHost.message(browserTabId, { v: 1, type: 'clear-selection-draft' })
  usePreviewSelectionStore.getState().clear(browserTabId)
}

export async function undoBrowserSelection(browserTabId: string): Promise<void> {
  const draft = usePreviewSelectionStore.getState().bySession[browserTabId]
  const last = draft?.items.at(-1)
  if (!draft || !last) return
  if (draft.items.length === 1) await workspaceBrowserHost.message(browserTabId, { v: 1, type: 'exit-picker' })
  await workspaceBrowserHost.message(browserTabId, { v: 1, type: 'undo-selection', itemId: last.id })
  usePreviewSelectionStore.getState().undoLast(browserTabId)
}

const sending = new Set<string>()
export async function sendBrowserSelections(sessionId: string, browserTabId: string): Promise<void> {
  const draft = usePreviewSelectionStore.getState().bySession[browserTabId]
  if (!draft?.items.length || sending.has(browserTabId)) return
  sending.add(browserTabId)
  try {
    await workspaceBrowserHost.message(browserTabId, { v: 1, type: 'exit-picker' })
    const batch = buildSelectionBatchMessage(draft.items)
    const attachments = draft.items.flatMap((entry, index) => {
      const data = entry.payload.screenshot?.dataUrl
      const item = batch.items[index]!
      return data ? [{ type: 'image' as const, name: item.displayName, mimeType: 'image/png', data, note: item.note, quote: item.selector, selectionNumber: entry.number }] : []
    })
    void useChatStore.getState().sendMessage(sessionId, batch.modelText, attachments, {
      displayContent: t('browser.selection.batchMessage', { count: draft.items.length }), displayAttachments: attachments,
    })
    try {
      await workspaceBrowserHost.message(browserTabId, { v: 1, type: 'commit-selection-draft' })
    } finally {
      // The message was submitted. A page closing before acknowledgement must
      // not leave the same batch available to send a second time.
      usePreviewSelectionStore.getState().clear(browserTabId)
    }
  } finally {
    sending.delete(browserTabId)
  }
}

export function discardNavigatedBrowserSelections(browserTabId: string): void {
  const items = usePreviewSelectionStore.getState().clear(browserTabId)
  if (items.length) useUIStore.getState().addToast({ type: 'warning', message: t('browser.selection.navigationDiscarded', { count: items.length }) })
}
