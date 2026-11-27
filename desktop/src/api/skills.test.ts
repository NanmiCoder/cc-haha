import { expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import { skillsApi } from './skills'

vi.mock('@/api/client', () => ({ api: { get: vi.fn() } }))

it('requests draft slash commands with optional cwd and agentProfile parameters', () => {
  skillsApi.commands()
  expect(api.get).toHaveBeenLastCalledWith('/api/skills/commands', { timeout: 120_000 })

  skillsApi.commands('/workspace/project')
  expect(api.get).toHaveBeenLastCalledWith(
    '/api/skills/commands?cwd=%2Fworkspace%2Fproject',
    { timeout: 120_000 },
  )

  skillsApi.commands('/workspace/project', 'lean')
  expect(api.get).toHaveBeenLastCalledWith(
    '/api/skills/commands?cwd=%2Fworkspace%2Fproject&agentProfile=lean',
    { timeout: 120_000 },
  )

  skillsApi.commands('/workspace/project', undefined, 'antigravity-acp')
  expect(api.get).toHaveBeenLastCalledWith(
    '/api/skills/commands?cwd=%2Fworkspace%2Fproject&providerId=antigravity-acp',
    { timeout: 120_000 },
  )
})
