import { api } from './client'
import type { ModelInfo, EffortLevel } from '../types/settings'

type ModelsResponse = { models: ModelInfo[]; provider: { id: string; name: string } | null }
type CurrentModelResponse = { model: ModelInfo }
type EffortResponse = { level: EffortLevel; available: EffortLevel[] }

export const modelsApi = {
  list() {
    return api.get<ModelsResponse>('/api/models')
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
