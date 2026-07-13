// desktop/src/api/providers.ts

import { api } from './client'
import type {
  SavedProvider,
  CreateProviderInput,
  UpdateProviderInput,
  TestProviderConfigInput,
  ProviderTestResult,
} from '../types/provider'
import type { ProviderPreset } from '../types/providerPreset'

type ProvidersResponse = { providers: SavedProvider[]; activeId: string | null }
type ProvidersListResponse = ProvidersResponse & { providerOrder?: string[] }
type ProvidersReorderResponse = { providers: SavedProvider[]; providerOrder?: string[] }
type ProviderResponse = { provider: SavedProvider }
type PresetsResponse = { presets: ProviderPreset[] }
type TestResultResponse = { result: ProviderTestResult }
type AuthStatusResponse = {
  hasAuth: boolean
  source: 'cc-haha-provider' | 'openai-oauth' | 'grok-oauth' | 'original-settings' | 'env' | 'none'
  activeProvider?: string
}

export const providersApi = {
  list() {
    return api.get<ProvidersListResponse>('/api/providers')
  },

  presets() {
    return api.get<PresetsResponse>('/api/providers/presets')
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

  reorder(orderedIds: string[]) {
    return api.put<ProvidersReorderResponse>('/api/providers/reorder', { orderedIds })
  },

  test(id: string, overrides?: { baseUrl?: string; modelId?: string; apiFormat?: string; authStrategy?: string }) {
    return api.post<TestResultResponse>(`/api/providers/${id}/test`, overrides)
  },

  testConfig(input: TestProviderConfigInput) {
    return api.post<TestResultResponse>('/api/providers/test', input)
  },
}
