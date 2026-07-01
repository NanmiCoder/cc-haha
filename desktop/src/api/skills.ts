import { api } from './client'
import type { SkillMeta, SkillDetail, CatalogSkill } from '../types/skill'

export const skillsApi = {
  list: (cwd?: string) => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    return api.get<{ skills: SkillMeta[] }>(`/api/skills${query}`, { timeout: 120_000 })
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

  catalog: () => api.get<{ catalog: CatalogSkill[] }>(`/api/skills/catalog`),

  install: (name: string) =>
    api.post<{ ok: true; installed?: boolean; alreadyInstalled?: boolean }>(
      `/api/skills/install`,
      { name },
    ),

  getActiveSkills: (scope: 'global' | 'project' | 'merged' = 'merged', cwd?: string) => {
    const query = new URLSearchParams({ scope })
    if (cwd) query.set('cwd', cwd)
    return api.get<{ activeSkills: string[] }>(`/api/skills/active?${query.toString()}`)
  },

  setActiveSkills: (skills: string[], scope: 'global' | 'project', cwd?: string) =>
    api.post<{ ok: true; scope: string; activeSkills: string[] }>(
      `/api/skills/active`,
      { scope, skills, cwd },
    ),
}
