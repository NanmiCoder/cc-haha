import { api } from './client'
import type { ComposerReferenceCandidate } from '@/types/composerReference'

export const composerReferencesApi = {
  list(cwd?: string) {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    return api.get<{ skills: ComposerReferenceCandidate[], plugins: ComposerReferenceCandidate[] }>(`/api/skills/mentions${query}`)
  },
}
