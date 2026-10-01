import { api } from './client'
import { CLAUDE_OFFICIAL_PROVIDER_ID } from '@/constants/openaiOfficialProvider'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import type { RuntimeSelection } from '@/types/runtime'

/**
 * Provider-backed skills (imagegen) exist only when the session's provider
 * offers them, so the server needs the provider the session will run with.
 * A `null` selection is the Claude subscription; no selection inherits the
 * active provider, which the server resolves itself.
 */
export function mentionProviderId(selection: RuntimeSelection | undefined): string | undefined {
  if (!selection) return undefined
  return selection.providerId ?? CLAUDE_OFFICIAL_PROVIDER_ID
}

export const composerReferencesApi = {
  list(cwd?: string, providerId?: string) {
    const params = [
      cwd ? `cwd=${encodeURIComponent(cwd)}` : '',
      providerId ? `providerId=${encodeURIComponent(providerId)}` : '',
    ].filter(Boolean)
    const query = params.length ? `?${params.join('&')}` : ''
    return api.get<{ skills: ComposerReferenceCandidate[], plugins: ComposerReferenceCandidate[] }>(`/api/skills/mentions${query}`)
  },
}
