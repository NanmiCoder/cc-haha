import { beforeEach, expect, it, vi } from 'vitest'
import { sideChatsApi } from '@/api/sideChats'
import { useSideChatStore } from './sideChatStore'
import { isSideChatSession } from '@/lib/sideChatSessions'
import { useWorkspaceChatContextStore } from './workspaceChatContextStore'
const mocks = vi.hoisted(() => ({
  chat: { sessions: {} as Record<string, { chatState: string }>, connectToSession: vi.fn(), disconnectSession: vi.fn(), markSessionCompletionRead: vi.fn(), stopGeneration: vi.fn(), sendMessage: vi.fn(), queueUserMessage: vi.fn(), queueComposerInsertion: vi.fn(), queueComposerPrefill: vi.fn() },
  runtime: { selections: { parent: { providerId: 'provider-a', modelId: 'model-a' } } as Record<string, { providerId: string | null; modelId: string; effortLevel?: string }>, setSelection: vi.fn(), clearSelection: vi.fn() },
}))
vi.mock('@/api/sideChats', () => ({ sideChatsApi: { create: vi.fn(), discard: vi.fn() } }))
vi.mock('@/stores/chatStore', () => ({ useChatStore: { getState: () => mocks.chat } }))
vi.mock('@/stores/sessionRuntimeStore', () => ({ useSessionRuntimeStore: { getState: () => mocks.runtime } }))
vi.mock('@/stores/sessionStore', () => ({ useSessionStore: { getState: () => ({ sessions: [{ id: 'parent', permissionMode: 'default' }] }) } }))
vi.mock('@/stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({}) } }))
vi.mock('@/stores/providerStore', () => ({ useProviderStore: { getState: () => ({ activeId: null, providers: [] }) } }))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.chat.sendMessage.mockReset().mockReturnValue(true)
  useSideChatStore.setState({ entries: {} })
  useWorkspaceChatContextStore.setState({ referencesBySession: {} })
  mocks.chat.sessions = {}
  mocks.runtime.selections = { parent: { providerId: 'provider-a', modelId: 'model-a' } }
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

it('retains a refused side question in its child composer', async () => {
  mocks.chat.sendMessage.mockReturnValue(false)
  await useSideChatStore.getState().open('parent', { question: 'Keep this question', submit: true })
  expect(mocks.chat.queueComposerPrefill).toHaveBeenCalledWith('side-child', { text: 'Keep this question', mode: 'append' })
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
  expect(mocks.chat.markSessionCompletionRead).toHaveBeenCalledWith('side-child')
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
  expect(mocks.chat.markSessionCompletionRead).not.toHaveBeenCalled()
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

it('inherits Antigravity runtime metadata when opening a side chat without a cached parent runtime selection', async () => {
  vi.mocked(sideChatsApi.create).mockResolvedValueOnce({
    sessionId: 'side-agy',
    parentSessionId: 'parent-agy',
    workDir: '/repo',
    title: 'Side chat',
    ephemeral: true,
    permissionMode: 'acceptEdits',
    runtimeProviderId: 'antigravity-acp',
    runtimeModelId: 'gemini-4-neon',
    effortLevel: 'high',
  })
  const child = await useSideChatStore.getState().open('parent-agy')
  expect(child).toBe('side-agy')
  expect(mocks.runtime.setSelection).toHaveBeenCalledWith('side-agy', {
    providerId: 'antigravity-acp',
    modelId: 'gemini-4-neon',
    effortLevel: 'high',
  })
  expect(useSideChatStore.getState().entries['side-agy']).toMatchObject({
    runtimeProviderId: 'antigravity-acp',
    runtimeModelId: 'gemini-4-neon',
    effortLevel: 'high',
    permissionMode: 'acceptEdits',
  })
})

it('prefers server-authoritative Antigravity child runtime over placeholder or stale cached parent selections', async () => {
  mocks.runtime.selections['parent-agy-default'] = {
    providerId: 'antigravity-acp',
    modelId: 'agent-default',
  }
  vi.mocked(sideChatsApi.create).mockResolvedValueOnce({
    sessionId: 'side-agy-resolved',
    parentSessionId: 'parent-agy-default',
    workDir: '/repo',
    title: 'Side chat',
    ephemeral: true,
    runtimeProviderId: 'antigravity-acp',
    runtimeModelId: 'gemini-3.8-flash',
    effortLevel: 'low',
  })
  const resolvedChild = await useSideChatStore.getState().open('parent-agy-default')
  expect(resolvedChild).toBe('side-agy-resolved')
  expect(mocks.runtime.setSelection).toHaveBeenCalledWith('side-agy-resolved', {
    providerId: 'antigravity-acp',
    modelId: 'gemini-3.8-flash',
    effortLevel: 'low',
  })

  // Even if cached parent selection holds a non-Antigravity provider, server Antigravity wins
  mocks.runtime.selections['parent-agy-stale'] = {
    providerId: 'provider-a',
    modelId: 'claude-sonnet-4-5',
  }
  vi.mocked(sideChatsApi.create).mockResolvedValueOnce({
    sessionId: 'side-agy-orch',
    parentSessionId: 'parent-agy-stale',
    workDir: '/repo',
    title: 'Side chat',
    ephemeral: true,
    runtimeProviderId: 'antigravity-acp',
    runtimeModelId: 'gemini-pro-orchestrator-neon',
  })
  const orchChild = await useSideChatStore.getState().open('parent-agy-stale')
  expect(orchChild).toBe('side-agy-orch')
  expect(mocks.runtime.setSelection).toHaveBeenCalledWith('side-agy-orch', {
    providerId: 'antigravity-acp',
    modelId: 'gemini-pro-orchestrator-neon',
  })
})
