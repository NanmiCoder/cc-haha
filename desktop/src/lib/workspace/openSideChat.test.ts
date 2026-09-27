import { beforeEach, expect, it, vi } from 'vitest'
import { registerSideChatSession, unregisterSideChatSession } from '@/lib/sideChatSessions'
import { openSideChat } from '@/lib/workspace/openSideChat'
const mocks = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(async () => {}), openTab: vi.fn(), toast: vi.fn() }))
vi.mock('@/stores/sideChatStore', () => ({ useSideChatStore: { getState: () => ({ open: mocks.open, close: mocks.close }) } }))
vi.mock('@/stores/uiStore', () => ({ useUIStore: { getState: () => ({ addToast: mocks.toast }) } }))
vi.mock('@/lib/workspace/openTarget', () => ({ workspaceOpen: { sideChat: mocks.openTab } }))
beforeEach(() => { vi.clearAllMocks(); mocks.open.mockResolvedValue('side-child'); mocks.openTab.mockReturnValue('workspace-child') })
it('forwards selected text and opens the independent child in its parent workspace', async () => {
  const reference = { kind: 'chat-selection' as const, path: 'chat://assistant/a', name: 'Answer', quote: 'Quoted text' }
  expect(await openSideChat('parent', { reference })).toBe('workspace-child')
  expect(mocks.open).toHaveBeenCalledWith('parent', { reference })
  expect(mocks.openTab).toHaveBeenCalledWith('parent', 'side-child')
})
it('releases a child when a full workspace cannot open its tab', async () => {
  mocks.openTab.mockReturnValue(null)
  expect(await openSideChat('parent')).toBeNull()
  expect(mocks.close).toHaveBeenCalledWith('side-child')
})
it('surfaces an opening error without creating a tab', async () => {
  mocks.open.mockRejectedValue(new Error('Session missing'))
  expect(await openSideChat('parent')).toBeNull()
  expect(mocks.openTab).not.toHaveBeenCalled()
  expect(mocks.toast).toHaveBeenCalledWith({ type: 'error', message: 'Session missing' })
})

it('adds selected side-chat text to its existing parent workspace rather than nesting side chats', async () => {
  registerSideChatSession('side-source', 'parent')
  try {
    await openSideChat('side-source', { question: 'Explain this' })
    expect(mocks.open).toHaveBeenCalledWith('parent', { question: 'Explain this' })
    expect(mocks.openTab).toHaveBeenCalledWith('parent', 'side-child')
  } finally { unregisterSideChatSession('side-source') }
})
