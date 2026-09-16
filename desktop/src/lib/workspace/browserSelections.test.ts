import { beforeEach, expect, it, vi } from 'vitest'
import { usePreviewSelectionStore, MAX_PREVIEW_SELECTIONS } from '../../stores/previewSelectionStore'
import { discardNavigatedBrowserSelections, handleBrowserSelectionEvent } from './browserSelections'

const { sendMessage, message, addToast } = vi.hoisted(() => ({ sendMessage: vi.fn(), message: vi.fn(async () => ({ ok: true })), addToast: vi.fn() }))
vi.mock('../../stores/chatStore', () => ({ useChatStore: { getState: () => ({ sendMessage }) } }))
vi.mock('../../stores/uiStore', () => ({ useUIStore: { getState: () => ({ addToast }) } }))
vi.mock('./browserHost', () => ({ workspaceBrowserHost: { message } }))

beforeEach(() => {
  usePreviewSelectionStore.setState({ bySession: {} })
  sendMessage.mockClear()
  message.mockClear()
  addToast.mockClear()
})

it('preserves direct send with its annotated screenshot', () => {
  handleBrowserSelectionEvent('task', 'page', { type: 'selection', payload: { pageUrl: 'https://example.test/', element: { selector: '#x', tag: 'h1', classes: [] }, screenshot: { dataUrl: 'data:image/png;base64,AAAA' } } })
  expect(sendMessage).toHaveBeenCalledWith('task', expect.any(String), [expect.objectContaining({ quote: '#x' })], expect.objectContaining({ hideDisplayContent: true }))
  expect(usePreviewSelectionStore.getState().bySession.page).toBeUndefined()
})

it('caps the queue, rearms after cancel, and drops only the navigated page draft', () => {
  const payload = { pageUrl: '', delivery: 'queue', element: { selector: '#x', tag: 'h1', classes: [] } }
  handleBrowserSelectionEvent('task', 'other', { type: 'selection', payload })
  for (let index = 0; index <= MAX_PREVIEW_SELECTIONS; index += 1) handleBrowserSelectionEvent('task', 'page', { type: 'selection', payload })
  expect(usePreviewSelectionStore.getState().bySession.page?.items).toHaveLength(MAX_PREVIEW_SELECTIONS)
  expect(addToast).toHaveBeenCalledTimes(2)
  handleBrowserSelectionEvent('task', 'other', { type: 'picker-exited', reason: 'cancel-current' })
  expect(message).toHaveBeenLastCalledWith('other', expect.objectContaining({ type: 'enter-picker', mode: 'batch', label: 2 }))
  discardNavigatedBrowserSelections('page')
  expect(usePreviewSelectionStore.getState().bySession.page).toBeUndefined()
  expect(usePreviewSelectionStore.getState().bySession.other?.items).toHaveLength(1)
  expect(sendMessage).not.toHaveBeenCalled()
})


it('leaves continuation of persistent annotations to the host, without replacing its mode', () => {
  handleBrowserSelectionEvent('task', 'page', { type: 'selection', persistent: true, payload: {
    pageUrl: '', delivery: 'queue', element: { selector: '#x', tag: 'h1', classes: [] },
  } })
  expect(usePreviewSelectionStore.getState().bySession.page?.items).toHaveLength(1)
  expect(message).not.toHaveBeenCalled()
})


it('ends picking and rolls back a rejected extra item when an already-full queue receives another annotation', async () => {
  for (let index = 0; index < MAX_PREVIEW_SELECTIONS; index++) {
    usePreviewSelectionStore.getState().add('page', { pageUrl: '', element: { selector: '#old', nthPath: 'h1', tag: 'h1', classes: [], boundingBox: { x: 0, y: 0, w: 1, h: 1 }, computedStyles: {} } })
  }
  handleBrowserSelectionEvent('task', 'page', { type: 'selection', persistent: true, payload: {
    pageUrl: '', delivery: 'queue', draftItemId: 'rejected-item', element: { selector: '#extra', tag: 'h1', classes: [] },
  } })
  expect(usePreviewSelectionStore.getState().bySession.page?.items).toHaveLength(MAX_PREVIEW_SELECTIONS)
  expect(message).toHaveBeenCalledWith('page', { v: 1, type: 'exit-picker' })
  await vi.waitFor(() => expect(message).toHaveBeenCalledWith('page', { v: 1, type: 'undo-selection', itemId: 'rejected-item' }))
  expect(addToast).toHaveBeenCalledTimes(1)
  expect(sendMessage).not.toHaveBeenCalled()
})


it('still attempts rollback after a failed exit and reports cleanup failure without clearing the accepted batch', async () => {
  for (let index = 0; index < MAX_PREVIEW_SELECTIONS; index++) {
    usePreviewSelectionStore.getState().add('page', { pageUrl: '', element: { selector: '#old', nthPath: 'h1', tag: 'h1', classes: [], boundingBox: { x: 0, y: 0, w: 1, h: 1 }, computedStyles: {} } })
  }
  message.mockRejectedValueOnce(new Error('closed page'))
  handleBrowserSelectionEvent('task', 'page', { type: 'selection', persistent: true, payload: {
    delivery: 'queue', draftItemId: 'extra', element: { selector: '#extra', tag: 'h1', classes: [] },
  } })
  await vi.waitFor(() => expect(message).toHaveBeenCalledWith('page', { v: 1, type: 'undo-selection', itemId: 'extra' }))
  expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringContaining('closed page') }))
  expect(usePreviewSelectionStore.getState().bySession.page?.items).toHaveLength(MAX_PREVIEW_SELECTIONS)
})
