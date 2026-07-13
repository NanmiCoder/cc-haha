import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedProvider } from '../types/provider'

const {
  providersApiMock,
  chatStoreState,
  runtimeStoreState,
  setSessionRuntimeMock,
  setSelectionMock,
  settingsSetModelMock,
  settingsFetchAllMock,
} = vi.hoisted(() => ({
  providersApiMock: {
    list: vi.fn(),
    presets: vi.fn(),
    authStatus: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    reorder: vi.fn(),
    activate: vi.fn(),
    activateOfficial: vi.fn(),
    test: vi.fn(),
    testConfig: vi.fn(),
  },
  chatStoreState: {
    sessions: {} as Record<string, { connectionState: string; chatState: string }>,
    setSessionRuntime: vi.fn(),
  },
  runtimeStoreState: {
    selections: {} as Record<string, { providerId: string | null; modelId: string }>,
    setSelection: vi.fn(),
  },
  setSessionRuntimeMock: vi.fn(),
  setSelectionMock: vi.fn(),
  settingsSetModelMock: vi.fn(),
  settingsFetchAllMock: vi.fn(),
}))

vi.mock('../api/providers', () => ({
  providersApi: providersApiMock,
}))

vi.mock('./chatStore', () => ({
  useChatStore: {
    getState: () => ({
      ...chatStoreState,
      setSessionRuntime: setSessionRuntimeMock,
    }),
  },
}))

vi.mock('./sessionRuntimeStore', () => ({
  useSessionRuntimeStore: {
    getState: () => ({
      ...runtimeStoreState,
      setSelection: setSelectionMock,
    }),
  },
}))

vi.mock('./settingsStore', () => ({
  useSettingsStore: {
    getState: () => ({
      setModel: settingsSetModelMock,
      fetchAll: settingsFetchAllMock,
    }),
  },
}))

function makeProvider(overrides: Partial<SavedProvider> = {}): SavedProvider {
  return {
    id: 'provider-a',
    presetId: 'custom',
    name: 'Provider A',
    apiKey: 'key-a',
    baseUrl: 'https://example.invalid/api',
    apiFormat: 'anthropic',
    models: {
      main: 'model-main',
      haiku: 'model-haiku',
      sonnet: 'model-sonnet',
      opus: 'model-opus',
    },
    ...overrides,
  }
}

describe('providerStore runtime refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chatStoreState.sessions = {}
    runtimeStoreState.selections = {}
    providersApiMock.list.mockResolvedValue({ providers: [], activeId: null })
  })

  it('reapplies an updated active provider to idle connected sessions using default runtime', async () => {
    const provider = makeProvider()
    providersApiMock.update.mockResolvedValue({ provider })
    providersApiMock.list.mockResolvedValue({ providers: [provider], activeId: provider.id })
    chatStoreState.sessions = {
      'session-a': { connectionState: 'connected', chatState: 'idle' },
    }

    const { useProviderStore } = await import('./providerStore')
    await useProviderStore.getState().updateProvider(provider.id, { apiKey: 'new-key' })

    expect(setSelectionMock).toHaveBeenCalledWith('session-a', {
      providerId: provider.id,
      modelId: 'model-main',
    })
    expect(setSessionRuntimeMock).toHaveBeenCalledWith('session-a', {
      providerId: provider.id,
      modelId: 'model-main',
    })
    expect(settingsSetModelMock).not.toHaveBeenCalled()
  })

  it('keeps an explicit provider model selection when the model still exists', async () => {
    const provider = makeProvider()
    providersApiMock.update.mockResolvedValue({ provider })
    providersApiMock.list.mockResolvedValue({ providers: [provider], activeId: null })
    chatStoreState.sessions = {
      'session-a': { connectionState: 'connected', chatState: 'idle' },
    }
    runtimeStoreState.selections = {
      'session-a': { providerId: provider.id, modelId: 'model-opus' },
    }

    const { useProviderStore } = await import('./providerStore')
    await useProviderStore.getState().updateProvider(provider.id, { apiKey: 'new-key' })

    expect(setSessionRuntimeMock).toHaveBeenCalledWith('session-a', {
      providerId: provider.id,
      modelId: 'model-opus',
    })
  })

  it('does not restart busy sessions while a provider update is saved', async () => {
    const provider = makeProvider()
    providersApiMock.update.mockResolvedValue({ provider })
    providersApiMock.list.mockResolvedValue({ providers: [provider], activeId: provider.id })
    chatStoreState.sessions = {
      'session-a': { connectionState: 'connected', chatState: 'streaming' },
      'session-b': { connectionState: 'disconnected', chatState: 'idle' },
    }

    const { useProviderStore } = await import('./providerStore')
    await useProviderStore.getState().updateProvider(provider.id, { apiKey: 'new-key' })

    expect(setSelectionMock).not.toHaveBeenCalled()
    expect(setSessionRuntimeMock).not.toHaveBeenCalled()
  })

  it('sets the OpenAI default model when activating built-in ChatGPT Official', async () => {
    providersApiMock.activate.mockResolvedValue({ ok: true })
    providersApiMock.list.mockResolvedValue({
      providers: [],
      activeId: 'openai-official',
    })

    const { useProviderStore } = await import('./providerStore')
    await useProviderStore.getState().activateProvider('openai-official')

    expect(settingsSetModelMock).toHaveBeenCalledWith('gpt-5.6-sol')
    expect(settingsFetchAllMock).toHaveBeenCalled()
  })

  it('sets the Grok default model when activating built-in Grok Official', async () => {
    providersApiMock.activate.mockResolvedValue({ ok: true })
    providersApiMock.list.mockResolvedValue({ providers: [], activeId: 'grok-official' })

    const { useProviderStore } = await import('./providerStore')
    await useProviderStore.getState().activateProvider('grok-official')

    expect(settingsSetModelMock).toHaveBeenCalledWith('grok-4.5')
    expect(settingsFetchAllMock).toHaveBeenCalled()
  })

  it('sets the provider main model when activating a saved provider', async () => {
    const provider = makeProvider()
    providersApiMock.activate.mockResolvedValue({ ok: true })
    providersApiMock.list.mockResolvedValue({
      providers: [provider],
      activeId: provider.id,
    })

    const { useProviderStore } = await import('./providerStore')
    await useProviderStore.getState().activateProvider(provider.id)

    expect(settingsSetModelMock).toHaveBeenCalledWith('model-main')
    expect(settingsFetchAllMock).toHaveBeenCalled()
  })

  it('sets the provider main model when updating the active saved provider', async () => {
    const provider = makeProvider({ models: { main: 'model-flash', haiku: 'model-flash', sonnet: 'model-pro', opus: 'model-pro' } })
    providersApiMock.update.mockResolvedValue({ provider })
    providersApiMock.list.mockResolvedValue({
      providers: [provider],
      activeId: provider.id,
    })

    const { useProviderStore } = await import('./providerStore')
    await useProviderStore.getState().updateProvider(provider.id, { models: provider.models })

    expect(settingsSetModelMock).toHaveBeenCalledWith('model-flash')
    expect(settingsFetchAllMock).toHaveBeenCalled()
  })
})

describe('providerStore reorderProviders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chatStoreState.sessions = {}
    runtimeStoreState.selections = {}
    providersApiMock.list.mockResolvedValue({ providers: [], activeId: null })
  })

  it('optimistically applies the new order before the request resolves', async () => {
    const a = makeProvider({ id: 'a', name: 'A' })
    const b = makeProvider({ id: 'b', name: 'B' })
    const c = makeProvider({ id: 'c', name: 'C' })

    let resolveReorder: (value: { providers: SavedProvider[]; providerOrder?: string[] }) => void = () => {}
    providersApiMock.reorder.mockReturnValue(
      new Promise((resolve) => {
        resolveReorder = resolve
      }),
    )

    const { useProviderStore } = await import('./providerStore')
    useProviderStore.setState({ providers: [a, b, c], activeId: null })

    const promise = useProviderStore.getState().reorderProviders(['c', 'a', 'b'])

    // Optimistic update is visible immediately, before the API resolves.
    expect(useProviderStore.getState().providers.map((p) => p.id)).toEqual(['c', 'a', 'b'])

    resolveReorder({ providers: [c, a, b] })
    await promise

    expect(providersApiMock.reorder).toHaveBeenCalledWith(['c', 'a', 'b'])
    expect(useProviderStore.getState().providers.map((p) => p.id)).toEqual(['c', 'a', 'b'])
  })

  it('optimistically applies full display order including built-in providers', async () => {
    const a = makeProvider({ id: 'a', name: 'A' })
    const b = makeProvider({ id: 'b', name: 'B' })
    providersApiMock.reorder.mockResolvedValue({
      providers: [b, a],
      providerOrder: ['openai-official', 'b', 'claude-official', 'a', 'grok-official'],
    })

    const { useProviderStore } = await import('./providerStore')
    useProviderStore.setState({
      providers: [a, b],
      providerOrder: ['a', 'b', 'claude-official', 'openai-official', 'grok-official'],
      activeId: null,
    })

    await useProviderStore.getState().reorderProviders(['openai-official', 'b', 'claude-official', 'a', 'grok-official'])

    expect(providersApiMock.reorder).toHaveBeenCalledWith(['openai-official', 'b', 'claude-official', 'a', 'grok-official'])
    expect(useProviderStore.getState().providerOrder).toEqual(['openai-official', 'b', 'claude-official', 'a', 'grok-official'])
    expect(useProviderStore.getState().providers.map((p) => p.id)).toEqual(['b', 'a'])
  })

  it('rolls back to the previous order when the request fails', async () => {
    const a = makeProvider({ id: 'a', name: 'A' })
    const b = makeProvider({ id: 'b', name: 'B' })
    providersApiMock.reorder.mockRejectedValue(new Error('network down'))

    const { useProviderStore } = await import('./providerStore')
    useProviderStore.setState({ providers: [a, b], activeId: null })

    await useProviderStore.getState().reorderProviders(['b', 'a'])

    // Rolls back to the pre-drag order and surfaces the error.
    expect(useProviderStore.getState().providers.map((p) => p.id)).toEqual(['a', 'b'])
    expect(useProviderStore.getState().error).toBe('network down')
  })

  it('refetches instead of reordering when the id set is stale', async () => {
    const a = makeProvider({ id: 'a', name: 'A' })
    const b = makeProvider({ id: 'b', name: 'B' })
    providersApiMock.list.mockResolvedValue({ providers: [a, b], activeId: null })

    const { useProviderStore } = await import('./providerStore')
    useProviderStore.setState({ providers: [a, b], activeId: null })

    // Only one id supplied — the list changed under us, so don't persist a bad order.
    await useProviderStore.getState().reorderProviders(['a'])

    expect(providersApiMock.reorder).not.toHaveBeenCalled()
    expect(providersApiMock.list).toHaveBeenCalled()
  })
})
