// desktop/src/stores/providerStore.ts

import { create } from 'zustand'
import { providersApi } from '../api/providers'
import { useChatStore } from './chatStore'
import { useSessionRuntimeStore } from './sessionRuntimeStore'
import { useSettingsStore } from './settingsStore'
import { OFFICIAL_DEFAULT_MODEL_ID } from '../constants/modelCatalog'
import {
  BUILT_IN_PROVIDER_IDS,
  OPENAI_OFFICIAL_DEFAULT_MODEL_ID,
  OPENAI_OFFICIAL_PROVIDER_ID,
} from '../constants/openaiOfficialProvider'
import {
  GROK_OFFICIAL_DEFAULT_MODEL_ID,
  GROK_OFFICIAL_PROVIDER_ID,
} from '../constants/grokOfficialProvider'
import type {
  SavedProvider,
  CreateProviderInput,
  UpdateProviderInput,
  TestProviderConfigInput,
  ProviderTestResult,
} from '../types/provider'
import type { ProviderPreset } from '../types/providerPreset'
import type { RuntimeSelection } from '../types/runtime'

type ProviderStore = {
  providers: SavedProvider[]
  providerOrder: string[]
  activeId: string | null
  hasLoadedProviders: boolean
  presets: ProviderPreset[]
  isLoading: boolean
  isPresetsLoading: boolean
  error: string | null

  fetchProviders: () => Promise<void>
  fetchPresets: () => Promise<void>
  createProvider: (input: CreateProviderInput) => Promise<SavedProvider>
  updateProvider: (id: string, input: UpdateProviderInput) => Promise<SavedProvider>
  deleteProvider: (id: string) => Promise<void>
  reorderProviders: (orderedIds: string[]) => Promise<void>
  activateProvider: (id: string) => Promise<void>
  activateOfficial: () => Promise<void>
  testProvider: (id: string, overrides?: { baseUrl?: string; modelId?: string; apiFormat?: string; authStrategy?: string }) => Promise<ProviderTestResult>
  testConfig: (input: TestProviderConfigInput) => Promise<ProviderTestResult>
}

function defaultProviderOrder(providers: SavedProvider[]): string[] {
  return [
    ...providers.map((provider) => provider.id),
    ...BUILT_IN_PROVIDER_IDS,
  ]
}

function normalizeProviderOrder(providerOrder: string[] | undefined, providers: SavedProvider[]): string[] {
  const knownIds = new Set<string>(defaultProviderOrder(providers))
  const source = providerOrder && providerOrder.length > 0
    ? providerOrder
    : defaultProviderOrder(providers)
  const seen = new Set<string>()
  const order: string[] = []

  for (const id of source) {
    if (!knownIds.has(id) || seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }

  for (const id of defaultProviderOrder(providers)) {
    if (seen.has(id)) continue
    seen.add(id)
    order.push(id)
  }

  return order
}

function isPermutation(candidateIds: string[], expectedIds: string[]): boolean {
  const expectedSet = new Set(expectedIds)
  const candidateSet = new Set(candidateIds)
  return (
    candidateIds.length === expectedIds.length &&
    candidateSet.size === candidateIds.length &&
    expectedIds.every((id) => candidateSet.has(id)) &&
    candidateIds.every((id) => expectedSet.has(id))
  )
}

function sortSavedProvidersByOrder(providers: SavedProvider[], providerOrder: string[]): SavedProvider[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]))
  return providerOrder
    .map((id) => byId.get(id))
    .filter((provider): provider is SavedProvider => provider !== undefined)
}

function mergeSavedOrderIntoProviderOrder(providerOrder: string[], savedOrder: string[]): string[] {
  const savedSet = new Set(savedOrder)
  const queue = [...savedOrder]
  return providerOrder.map((id) => {
    if (!savedSet.has(id)) return id
    return queue.shift() ?? id
  })
}

function providerModelIds(provider: SavedProvider): Set<string> {
  return new Set(
    Object.values(provider.models)
      .map((modelId) => modelId.trim())
      .filter(Boolean),
  )
}

function resolveRuntimeRefreshSelection(
  provider: SavedProvider,
  activeId: string | null,
  currentSelection: RuntimeSelection | undefined,
): RuntimeSelection | null {
  if (currentSelection?.providerId === provider.id) {
    const modelIds = providerModelIds(provider)
    return {
      providerId: provider.id,
      modelId: modelIds.has(currentSelection.modelId)
        ? currentSelection.modelId
        : provider.models.main,
      ...(currentSelection.effortLevel ? { effortLevel: currentSelection.effortLevel } : {}),
    }
  }

  if (!currentSelection && activeId === provider.id) {
    return {
      providerId: provider.id,
      modelId: provider.models.main,
    }
  }

  return null
}

function refreshConnectedSessionsForProvider(provider: SavedProvider, activeId: string | null) {
  const chatStore = useChatStore.getState()
  const runtimeStore = useSessionRuntimeStore.getState()

  for (const [sessionId, session] of Object.entries(chatStore.sessions)) {
    if (session.connectionState !== 'connected' || session.chatState !== 'idle') {
      continue
    }

    const selection = resolveRuntimeRefreshSelection(
      provider,
      activeId,
      runtimeStore.selections[sessionId],
    )
    if (!selection) continue

    runtimeStore.setSelection(sessionId, selection)
    chatStore.setSessionRuntime(sessionId, selection)
  }
}

export const useProviderStore = create<ProviderStore>((set, get) => ({
  providers: [],
  providerOrder: [...BUILT_IN_PROVIDER_IDS],
  activeId: null,
  hasLoadedProviders: false,
  presets: [],
  isLoading: false,
  isPresetsLoading: false,
  error: null,

  fetchProviders: async () => {
    set({ isLoading: true, error: null })
    try {
      const { providers, activeId, providerOrder } = await providersApi.list()
      set({
        providers,
        providerOrder: normalizeProviderOrder(providerOrder, providers),
        activeId,
        hasLoadedProviders: true,
        isLoading: false,
      })
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  fetchPresets: async () => {
    set({ isPresetsLoading: true, error: null })
    try {
      const { presets } = await providersApi.presets()
      set({ presets, isPresetsLoading: false })
    } catch (err) {
      set({ isPresetsLoading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  createProvider: async (input) => {
    const { provider } = await providersApi.create(input)
    await get().fetchProviders()
    return provider
  },

  updateProvider: async (id, input) => {
    const { provider } = await providersApi.update(id, input)
    await get().fetchProviders()
    const activeId = get().activeId
    if (activeId === provider.id && input.models !== undefined) {
      const mainModelId = provider.models.main.trim()
      if (mainModelId) {
        const settings = useSettingsStore.getState()
        await settings.setModel(mainModelId)
        await settings.fetchAll()
      }
    }
    refreshConnectedSessionsForProvider(provider, activeId)
    return provider
  },

  deleteProvider: async (id) => {
    await providersApi.delete(id)
    await get().fetchProviders()
  },

  reorderProviders: async (orderedIds) => {
    const previous = get().providers
    const previousOrder = normalizeProviderOrder(get().providerOrder, previous)
    const savedIds = previous.map((provider) => provider.id)
    const nextOrder = isPermutation(orderedIds, previousOrder)
      ? orderedIds
      : isPermutation(orderedIds, savedIds)
        ? mergeSavedOrderIntoProviderOrder(previousOrder, orderedIds)
        : null

    if (!nextOrder) {
      await get().fetchProviders()
      return
    }

    // Optimistically reorder locally so the drag feels instant.
    set({
      providers: sortSavedProvidersByOrder(previous, nextOrder),
      providerOrder: nextOrder,
    })
    try {
      const { providers, providerOrder } = await providersApi.reorder(orderedIds)
      set({
        providers,
        providerOrder: normalizeProviderOrder(providerOrder, providers),
      })
    } catch (err) {
      // Roll back to the server's last-known truth if persistence fails.
      set({
        providers: previous,
        providerOrder: previousOrder,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  activateProvider: async (id) => {
    await providersApi.activate(id)
    await get().fetchProviders()
    // 更新默认 provider 时，同步刷新默认 model，避免 settings.json 里残留
    // 旧 provider 的 model id 导致默认选择指向不存在的模型。
    const settings = useSettingsStore.getState()
    if (id === OPENAI_OFFICIAL_PROVIDER_ID) {
      await settings.setModel(OPENAI_OFFICIAL_DEFAULT_MODEL_ID)
      await settings.fetchAll()
      return
    }
    if (id === GROK_OFFICIAL_PROVIDER_ID) {
      await settings.setModel(GROK_OFFICIAL_DEFAULT_MODEL_ID)
      await settings.fetchAll()
      return
    }

    const provider = get().providers.find((p) => p.id === id)
    if (!provider) return
    await settings.setModel(provider.models.main)
    await settings.fetchAll()
  },

  activateOfficial: async () => {
    await providersApi.activateOfficial()
    await get().fetchProviders()
    // 切回官方默认时同样重置 currentModel，避免残留第三方 model id。
    const settings = useSettingsStore.getState()
    await settings.setModel(OFFICIAL_DEFAULT_MODEL_ID)
    await settings.fetchAll()
  },

  testProvider: async (id, overrides?) => {
    const { result } = await providersApi.test(id, overrides)
    return result
  },

  testConfig: async (input) => {
    const { result } = await providersApi.testConfig(input)
    return result
  },
}))
