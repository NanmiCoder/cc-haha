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
    scanCcSwitch: vi.fn(),
    importCcSwitch: vi.fn(),
    fetchModels: vi.fn(),
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

describe('providerStore presets', () => {
  it('starts with the provider presets bundled into the desktop app', async () => {
    const { useProviderStore } = await import('./providerStore')

    expect(useProviderStore.getState().presets).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'custom' }),
      expect.objectContaining({ id: 'deepseek' }),
    ]))
  })
})

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

  it.each([true, false])('refreshes saved model capabilities for idle, disconnected and draft selections (1m=%s)', async (enabled) => {
    const provider = makeProvider({ model1mSupport: { main: enabled, haiku: false, sonnet: false, opus: enabled } })
    providersApiMock.update.mockResolvedValue({ provider })
    providersApiMock.list.mockResolvedValue({ providers: [provider], activeId: provider.id })
    chatStoreState.sessions = {
      idle: { connectionState: 'connected', chatState: 'idle' },
      offline: { connectionState: 'disconnected', chatState: 'idle' },
      busy: { connectionState: 'connected', chatState: 'streaming' },
    }
    const previous = `model-opus${enabled ? '' : '[1m]'}`
    runtimeStoreState.selections = Object.fromEntries(
      ['idle', 'offline', 'busy', '__draft__', 'restored'].map((key) => [key, {
        providerId: provider.id,
        modelId: previous,
        effortLevel: 'high',
      }]),
    )

    const { useProviderStore } = await import('./providerStore')
    await useProviderStore.getState().updateProvider(provider.id, { model1mSupport: provider.model1mSupport })

    const selection = { providerId: provider.id, modelId: `model-opus${enabled ? '[1m]' : ''}`, effortLevel: 'high' }
    for (const key of ['idle', 'offline', '__draft__', 'restored']) {
      expect(setSelectionMock).toHaveBeenCalledWith(key, selection)
    }
    expect(setSelectionMock).not.toHaveBeenCalledWith('busy', expect.anything())
    expect(setSessionRuntimeMock.mock.calls).toEqual([['idle', selection]])
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

  it('reconciles restored selections when provider capabilities arrive after connection', async () => {
    const provider = makeProvider({ model1mSupport: { main: true, haiku: false, sonnet: false, opus: false } })
    providersApiMock.list.mockResolvedValue({ providers: [provider], activeId: provider.id })
    chatStoreState.sessions = { restored: { connectionState: 'connected', chatState: 'idle' } }
    runtimeStoreState.selections = { restored: { providerId: provider.id, modelId: 'model-main' } }
    const { useProviderStore } = await import('./providerStore')
    useProviderStore.setState({ hasLoadedProviders: false })

    await useProviderStore.getState().fetchProviders()

    expect(setSessionRuntimeMock).toHaveBeenCalledWith('restored', { providerId: provider.id, modelId: 'model-main[1m]' })
    expect(setSelectionMock).toHaveBeenCalledWith('restored', { providerId: provider.id, modelId: 'model-main[1m]' })
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

    expect(settingsSetModelMock).toHaveBeenCalledWith('grok-4.6')
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

describe('providerStore cc-switch import', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chatStoreState.sessions = {}
    runtimeStoreState.selections = {}
    providersApiMock.list.mockResolvedValue({ providers: [], activeId: null })
  })

  it('returns the scan result untouched', async () => {
    const scan = {
      available: true,
      source: 'json' as const,
      configDir: '/Users/tester/.cc-switch',
      candidates: [],
    }
    providersApiMock.scanCcSwitch.mockResolvedValue(scan)

    const { useProviderStore } = await import('./providerStore')

    await expect(useProviderStore.getState().scanCcSwitch()).resolves.toEqual(scan)
  })

  it('refreshes the provider list through the shared path after importing', async () => {
    const imported = makeProvider({ id: 'imported-1', name: 'Imported' })
    providersApiMock.importCcSwitch.mockResolvedValue({ imported: [imported], skipped: [] })
    providersApiMock.list.mockResolvedValue({ providers: [imported], activeId: null })

    const { useProviderStore } = await import('./providerStore')
    const result = await useProviderStore.getState().importCcSwitch(['source-1'])

    expect(providersApiMock.importCcSwitch).toHaveBeenCalledWith(['source-1'])
    expect(providersApiMock.list).toHaveBeenCalled()
    expect(result.imported).toEqual([imported])
    expect(useProviderStore.getState().providers).toEqual([imported])
  })

  // Refetching after a wholly skipped import would only churn the list and drop
  // any in-flight optimistic order for nothing.
  it('skips the refresh when the server imported nothing', async () => {
    providersApiMock.importCcSwitch.mockResolvedValue({
      imported: [],
      skipped: [{ sourceId: 'source-1', reason: 'no-api-key' }],
    })

    const { useProviderStore } = await import('./providerStore')
    const result = await useProviderStore.getState().importCcSwitch(['source-1'])

    expect(providersApiMock.list).not.toHaveBeenCalled()
    expect(result.skipped).toHaveLength(1)
  })

  it('propagates an import failure to the caller instead of swallowing it', async () => {
    providersApiMock.importCcSwitch.mockRejectedValue(new Error('config locked'))

    const { useProviderStore } = await import('./providerStore')

    await expect(useProviderStore.getState().importCcSwitch(['source-1'])).rejects.toThrow('config locked')
    expect(providersApiMock.list).not.toHaveBeenCalled()
  })
})

describe('providerStore fetchModels', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    providersApiMock.list.mockResolvedValue({ providers: [], activeId: null })
  })

  it('passes the typed request through and returns the model list', async () => {
    providersApiMock.fetchModels.mockResolvedValue({
      ok: true,
      models: [{ id: 'gpt-5', ownedBy: 'openai' }],
      endpoint: 'https://api.example.invalid/v1/models',
    })

    const { useProviderStore } = await import('./providerStore')
    const result = await useProviderStore.getState().fetchModels({
      baseUrl: 'https://api.example.invalid',
      apiKey: 'sk-test',
    })

    expect(providersApiMock.fetchModels).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.invalid',
      apiKey: 'sk-test',
    })
    expect(result).toEqual(expect.objectContaining({ ok: true }))
  })

  // An upstream failure is a resolved `ok: false`, not a rejection — resolving
  // it as an error would hide the code the UI switches on.
  it('resolves an upstream failure rather than throwing', async () => {
    providersApiMock.fetchModels.mockResolvedValue({
      ok: false,
      errorCode: 'auth-failed',
      message: '401 Unauthorized',
      httpStatus: 401,
      endpointsTried: ['https://api.example.invalid/v1/models'],
    })

    const { useProviderStore } = await import('./providerStore')
    const result = await useProviderStore.getState().fetchModels({
      baseUrl: 'https://api.example.invalid',
      apiKey: 'sk-bad',
    })

    expect(result).toEqual(expect.objectContaining({ ok: false, errorCode: 'auth-failed' }))
  })
})
