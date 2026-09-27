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
  ModelMapping,
} from '../types/provider'

type ProvidersResponse = { providers: SavedProvider[]; activeId: string | null }
type ProvidersListResponse = ProvidersResponse & { providerOrder?: string[] }
type ProvidersReorderResponse = { providers: SavedProvider[]; providerOrder?: string[] }
type ProviderResponse = { provider: SavedProvider }
type TestResultResponse = { result: ProviderTestResult }
type OfficialProviderModelsResponse = { models: ModelMapping }
type AuthStatusResponse = {
  hasAuth: boolean
  source: 'cc-haha-provider' | 'claude-oauth' | 'openai-oauth' | 'grok-oauth' | 'original-settings' | 'env' | 'none'
  activeProvider?: string
}

export const providersApi = {
  list() {
    return api.get<ProvidersListResponse>('/api/providers')
  },

  authStatus() {
    return api.get<AuthStatusResponse>('/api/providers/auth-status')
  },

  getSettings() {
    return api.get<Record<string, unknown>>('/api/providers/settings')
  },

  updateSettings(settings: Record<string, unknown>) {
    return api.put<{ ok: true }>('/api/providers/settings', settings)
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

  updateOfficialModels(id: string, models: ModelMapping) {
    return api.put<OfficialProviderModelsResponse>(`/api/providers/${id}/models`, { models })
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
