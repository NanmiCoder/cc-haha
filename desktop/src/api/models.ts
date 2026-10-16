import { api } from './client'
import type { ModelInfo, EffortLevel } from '../types/settings'

type ModelsResponse = { models: ModelInfo[]; provider: { id: string; name: string } | null }
type ModelCatalogResponse = { models: ModelInfo[] }
type CurrentModelResponse = { model: ModelInfo }
type EffortResponse = { level: EffortLevel; available: EffortLevel[] }

export const modelsApi = {
  list() {
    return api.get<ModelsResponse>('/api/models')
  },

  /** Models one built-in OAuth provider's account offers, whether or not it is the active provider. */
  catalog(providerId: string) {
    return api.get<ModelCatalogResponse>(`/api/models/catalog?provider=${encodeURIComponent(providerId)}`)
  },

  getCurrent() {
    return api.get<CurrentModelResponse>('/api/models/current')
  },

  setCurrent(modelId: string) {
    return api.put<{ ok: true; model: string }>('/api/models/current', { modelId })
  },

  getEffort() {
    return api.get<EffortResponse>('/api/effort')
  },

  setEffort(level: EffortLevel) {
    return api.put<{ ok: true; level: EffortLevel }>('/api/effort', { level })
  },
}
