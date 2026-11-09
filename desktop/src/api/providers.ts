// desktop/src/api/providers.ts

import { api } from './client'
import type {
  SavedProvider,
  CreateProviderInput,
  UpdateProviderInput,
  TestProviderConfigInput,
  ProviderTestResult,
  CcSwitchScanResult,
  CcSwitchImportResult,
  ProviderModelsInput,
  ProviderModelsResult,
  ModelContextWindows,
  ModelMapping,
  MagpieState,
  OpenMagpieResult,
} from '../types/provider'

type ProvidersResponse = { providers: SavedProvider[]; activeId: string | null }
type ProvidersListResponse = ProvidersResponse & {
  providerOrder?: string[]
  /** Saved alias mapping of the built-in DeepSeek account provider. */
  deepSeekAccountModels?: ModelMapping
}
type ProvidersReorderResponse = { providers: SavedProvider[]; providerOrder?: string[] }
type ProviderResponse = { provider: SavedProvider }
type TestResultResponse = { result: ProviderTestResult }
type OfficialProviderModelsResponse = {
  models: ModelMapping
  /** The user's own per-model windows; absent from a server that predates them. */
  modelContextWindows?: ModelContextWindows
}
type AuthStatusResponse = {
  hasAuth: boolean
  source: 'cc-haha-provider' | 'claude-oauth' | 'openai-oauth' | 'grok-oauth' | 'deepseek-oauth' | 'original-settings' | 'env' | 'none'
  activeProvider?: string
}

export const providersApi = {
  list() {
    return api.get<ProvidersListResponse>('/api/providers')
  },

  /**
   * Without `providerId` the server judges the global default provider; with
   * one (a saved provider id or a built-in id such as `claude-official`) it
   * judges only that provider's credentials.
   */
  authStatus(providerId?: string) {
    const query = providerId ? `?providerId=${encodeURIComponent(providerId)}` : ''
    return api.get<AuthStatusResponse>(`/api/providers/auth-status${query}`)
  },

  getSettings() {
    return api.get<Record<string, unknown>>('/api/providers/settings')
  },

  updateSettings(settings: Record<string, unknown>, expectedActiveProviderId?: string) {
    const query = expectedActiveProviderId === undefined
      ? ''
      : `?expectedActiveProviderId=${encodeURIComponent(expectedActiveProviderId)}`
    return api.put<{ ok: true }>(`/api/providers/settings${query}`, settings)
  },

  create(input: CreateProviderInput) {
    return api.post<ProviderResponse>('/api/providers', input)
  },

  update(id: string, input: UpdateProviderInput) {
    return api.put<ProviderResponse>(`/api/providers/${id}`, input)
  },

  delete(id: string) {
    return api.delete<{ ok: true }>(`/api/providers/${id}`)
  },

  activate(id: string) {
    return api.post<{ ok: true }>(`/api/providers/${id}/activate`)
  },

  activateOfficial() {
    return api.post<{ ok: true }>('/api/providers/official')
  },

  getOfficialModels(id: string) {
    return api.get<OfficialProviderModelsResponse>(`/api/providers/${id}/models`)
  },

  /** `modelContextWindows` replaces the saved overrides (`{}` clears them); leave it out to keep them. */
  updateOfficialModels(id: string, models: ModelMapping, modelContextWindows?: ModelContextWindows) {
    return api.put<OfficialProviderModelsResponse>(
      `/api/providers/${id}/models`,
      modelContextWindows === undefined ? { models } : { models, modelContextWindows },
    )
  },

  reorder(orderedIds: string[]) {
    return api.put<ProvidersReorderResponse>('/api/providers/reorder', { orderedIds })
  },

  test(id: string, overrides?: { modelId?: string }) {
    return api.post<TestResultResponse>(`/api/providers/${id}/test`, overrides)
  },

  testConfig(input: TestProviderConfigInput) {
    return api.post<TestResultResponse>('/api/providers/test', input)
  },

  scanCcSwitch() {
    return api.get<CcSwitchScanResult>('/api/providers/cc-switch/scan')
  },

  /** The local Magpie gateway and its catalog; `refresh` skips the server's short cache. */
  magpie(refresh = false) {
    return api.get<MagpieState>(`/api/providers/magpie${refresh ? '?refresh=1' : ''}`)
  },

  openMagpie() {
    return api.post<OpenMagpieResult>('/api/providers/magpie/open')
  },

  importCcSwitch(sourceIds: string[]) {
    return api.post<CcSwitchImportResult>('/api/providers/cc-switch/import', { sourceIds })
  },

  /**
   * Upstream failures are reported as HTTP 200 with `ok: false`, so this only
   * rejects when our own server is unreachable.
   */
  fetchModels(input: ProviderModelsInput) {
    return api.post<ProviderModelsResult>('/api/providers/models', input)
  },
}
