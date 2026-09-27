import { beforeEach, expect, it, vi } from 'vitest'
import { sideChatsApi } from '@/api/sideChats'
import { useSideChatStore } from './sideChatStore'
import { isSideChatSession } from '@/lib/sideChatSessions'
import { useWorkspaceChatContextStore } from './workspaceChatContextStore'
const mocks = vi.hoisted(() => ({
  chat: { sessions: {} as Record<string, { chatState: string }>, connectToSession: vi.fn(), disconnectSession: vi.fn(), stopGeneration: vi.fn(), sendMessage: vi.fn(), queueUserMessage: vi.fn(), queueComposerInsertion: vi.fn(), queueComposerPrefill: vi.fn() },
  runtime: { selections: { parent: { providerId: 'provider-a', modelId: 'model-a' } }, setSelection: vi.fn(), clearSelection: vi.fn() },
}))
vi.mock('@/api/sideChats', () => ({ sideChatsApi: { create: vi.fn(), discard: vi.fn() } }))
vi.mock('@/stores/chatStore', () => ({ useChatStore: { getState: () => mocks.chat } }))
vi.mock('@/stores/sessionRuntimeStore', () => ({ useSessionRuntimeStore: { getState: () => mocks.runtime } }))
vi.mock('@/stores/sessionStore', () => ({ useSessionStore: { getState: () => ({ sessions: [{ id: 'parent', permissionMode: 'default' }] }) } }))
vi.mock('@/stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({}) } }))
vi.mock('@/stores/providerStore', () => ({ useProviderStore: { getState: () => ({ activeId: null, providers: [] }) } }))
beforeEach(() => {
  vi.clearAllMocks()
  useSideChatStore.setState({ entries: {} })
  useWorkspaceChatContextStore.setState({ referencesBySession: {} })
  mocks.chat.sessions = {}
  vi.mocked(sideChatsApi.create).mockResolvedValue({ sessionId: 'side-child', parentSessionId: 'parent', workDir: '/repo', title: 'Side chat', ephemeral: true })
  vi.mocked(sideChatsApi.discard).mockResolvedValue({})
})
it('creates independent runtime and attaches selected text only to the child', async () => {
  const reference = { kind: 'chat-selection' as const, path: '', name: 'Selection', quote: 'parent selected text' }
  const child = await useSideChatStore.getState().open('parent', { reference })
  expect(child).toBe('side-child')
  expect(isSideChatSession(child)).toBe(true)
  expect(mocks.runtime.setSelection).toHaveBeenCalledWith(child, { providerId: 'provider-a', modelId: 'model-a' })
  expect(mocks.chat.connectToSession).toHaveBeenCalledWith(child, { prewarm: false, applyRuntimeSelection: false })
  expect(useWorkspaceChatContextStore.getState().referencesBySession[child]?.[0]).toMatchObject(reference)
  expect(useWorkspaceChatContextStore.getState().referencesBySession.parent).toBeUndefined()
  expect(mocks.chat.sendMessage).not.toHaveBeenCalled()
  expect(mocks.chat.queueUserMessage).not.toHaveBeenCalled()
})
it('reuses the child for /btw and sends or queues exclusively to that child', async () => {
  const store = useSideChatStore.getState()
  await store.open('parent', { question: 'Why?', submit: true })
  expect(mocks.chat.sendMessage).toHaveBeenCalledWith('side-child', 'Why?')
  mocks.chat.sessions['side-child'] = { chatState: 'streaming' }
  await store.open('parent', { question: 'Follow up', submit: true })
  expect(mocks.chat.queueUserMessage).toHaveBeenCalledWith('side-child', { content: 'Follow up', displayContent: 'Follow up' })
  expect(sideChatsApi.create).toHaveBeenCalledTimes(1)
})
it('deduplicates simultaneous opens and keeps both selected snippets', async () => {
  const reference = { kind: 'chat-selection' as const, path: '', name: 'Selection', quote: 'one' }
  await Promise.all([useSideChatStore.getState().open('parent', { reference }), useSideChatStore.getState().open('parent', { reference: { ...reference, quote: 'two' } })])
  expect(sideChatsApi.create).toHaveBeenCalledTimes(1)
  expect(useWorkspaceChatContextStore.getState().referencesBySession['side-child']).toHaveLength(2)
})
it('close stops, disconnects and discards only the temporary child', async () => {
  await useSideChatStore.getState().open('parent')
  await useSideChatStore.getState().close('side-child')
  expect(mocks.chat.stopGeneration).not.toHaveBeenCalled()
  expect(mocks.chat.disconnectSession).toHaveBeenCalledWith('side-child')
  expect(sideChatsApi.discard).toHaveBeenCalledWith('parent', 'side-child')
  expect(mocks.runtime.clearSelection).toHaveBeenCalledWith('side-child')
  expect(useSideChatStore.getState().entries['side-child']).toBeUndefined()
})

it('retains a failed deletion for reopening and retry without losing the live child', async () => {
  const child = await useSideChatStore.getState().open('parent')
  vi.mocked(sideChatsApi.discard).mockRejectedValueOnce(new Error('offline'))
  await expect(useSideChatStore.getState().close(child)).rejects.toThrow('offline')
  expect(useSideChatStore.getState().entries[child]).toBeDefined()
  expect(mocks.chat.disconnectSession).not.toHaveBeenCalled()
  expect(mocks.runtime.clearSelection).not.toHaveBeenCalled()
  expect(await useSideChatStore.getState().open('parent')).toBe(child)
  expect(sideChatsApi.create).toHaveBeenCalledTimes(1)
  await useSideChatStore.getState().close(child)
  expect(useSideChatStore.getState().entries[child]).toBeUndefined()
})
it('focuses a selected-text child without replacing its draft; question drafts use insertion', async () => {
  await useSideChatStore.getState().open('parent', { reference: { kind: 'chat-selection', path: '', name: 'Reply', quote: 'text' } })
  expect(mocks.chat.queueComposerPrefill).toHaveBeenCalledWith('side-child', { text: '', mode: 'append' })
  await useSideChatStore.getState().open('parent', { question: 'Draft question' })
  expect(mocks.chat.queueComposerInsertion).toHaveBeenCalledWith('side-child', { text: 'Draft question' })
})
