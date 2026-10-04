import { api } from './client'
import type { TraceCaptureSettings } from '../types/trace'

export const tracesApi = {
  getSettings() {
    return api.get<TraceCaptureSettings>('/api/traces/settings')
  },

  updateSettings(settings: Partial<Pick<TraceCaptureSettings, 'enabled'>>) {
    return api.put<TraceCaptureSettings>('/api/traces/settings', settings)
  },
}
