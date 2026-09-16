import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { usePreviewSelectionStore } from '@/stores/previewSelectionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { WorkspaceBrowserSelectionBar } from './WorkspaceBrowserSelectionBar'
import { handleBrowserSelectionEvent } from '@/lib/workspace/browserSelections'

const { sendMessage, message } = vi.hoisted(() => ({ sendMessage: vi.fn(), message: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/stores/chatStore', () => ({ useChatStore: { getState: () => ({ sendMessage }) } }))
vi.mock('@/lib/workspace/browserHost', () => ({ workspaceBrowserHost: { message } }))

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
  usePreviewSelectionStore.setState({ bySession: {} })
  sendMessage.mockClear()
  message.mockClear()
})
afterEach(cleanup)

it('keeps queued picks out of chat until Send, with page-specific undo and clear', async () => {
  for (const page of ['a', 'b']) handleBrowserSelectionEvent('session', page, {
    type: 'selection', payload: { pageUrl: 'https://same.test/', delivery: 'queue', draftItemId: `${page}-1`, element: { selector: '#title', tag: 'h1', classes: [] }, screenshot: { dataUrl: 'data:image/png;base64,AAAA' } },
  })
  expect(sendMessage).not.toHaveBeenCalled()
  expect(message).toHaveBeenCalledWith('a', expect.objectContaining({ type: 'enter-picker', mode: 'batch', label: 2 }))
  const view = render(<WorkspaceBrowserSelectionBar sessionId="session" browserTabId="a" />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Send/ })) })
  expect(sendMessage).toHaveBeenCalledTimes(1)
  expect(sendMessage).toHaveBeenCalledWith('session', expect.any(String), [expect.objectContaining({ selectionNumber: 1 })], expect.any(Object))
  expect(usePreviewSelectionStore.getState().bySession.a).toBeUndefined()
  expect(usePreviewSelectionStore.getState().bySession.b?.items).toHaveLength(1)
  view.rerender(<WorkspaceBrowserSelectionBar sessionId="session" browserTabId="b" />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Undo/ })) })
  expect(message).toHaveBeenCalledWith('b', { v: 1, type: 'undo-selection', itemId: 'b-1' })
  expect(screen.queryByRole('region')).not.toBeInTheDocument()
})

it('clears a draft only on the addressed page', async () => {
  handleBrowserSelectionEvent('session', 'a', { type: 'selection', payload: { pageUrl: '', delivery: 'queue', element: { selector: '#a', tag: 'p', classes: [] } } })
  render(<WorkspaceBrowserSelectionBar sessionId="session" browserTabId="a" />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Clear/ })) })
  expect(message).toHaveBeenCalledWith('a', { v: 1, type: 'clear-selection-draft' })
  expect(usePreviewSelectionStore.getState().bySession.a).toBeUndefined()
})
