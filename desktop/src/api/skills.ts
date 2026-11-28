import { api } from './client'
import type { SkillMeta, SkillDetail } from '../types/skill'
import type { SlashCommandOption } from '../types/slashCommand'

export const skillsApi = {
  list: (cwd?: string) => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    return api.get<{ skills: SkillMeta[] }>(`/api/skills${query}`, { timeout: 120_000 })
  },

  commands: (cwd?: string, agentProfile?: 'lean', providerId?: string) => {
    const query = new URLSearchParams()
    if (cwd) query.set('cwd', cwd)
    if (agentProfile) query.set('agentProfile', agentProfile)
    if (providerId) query.set('providerId', providerId)
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return api.get<{ commands: SlashCommandOption[] }>(
      `/api/skills/commands${suffix}`,
      { timeout: 120_000 },
    )
  },

  detail: (source: string, name: string, cwd?: string) => {
    const query = new URLSearchParams({
      source,
      name,
    })
    if (cwd) query.set('cwd', cwd)

    return api.get<{ detail: SkillDetail }>(
      `/api/skills/detail?${query.toString()}`,
      { timeout: 120_000 },
    )
  },
}
