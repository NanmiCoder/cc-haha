import { expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import { composerReferencesApi, mentionProviderId } from './composerReferences'
vi.mock('@/api/client', () => ({ api: { get: vi.fn() } }))
it('requests available capabilities for the exact workspace without credentials or catalog installation', () => {
  composerReferencesApi.list('/repo/中文 folder')
  expect(api.get).toHaveBeenCalledWith('/api/skills/mentions?cwd=%2Frepo%2F%E4%B8%AD%E6%96%87%20folder')
})

it('names the provider the session runs with so provider-backed skills match it', () => {
  composerReferencesApi.list('/repo', 'grok-official')
  expect(api.get).toHaveBeenLastCalledWith('/api/skills/mentions?cwd=%2Frepo&providerId=grok-official')
  expect(mentionProviderId({ providerId: 'grok-official', modelId: 'grok-4.7' })).toBe('grok-official')
  // A null provider is the Claude subscription, which offers no image provider.
  expect(mentionProviderId({ providerId: null, modelId: 'opus' })).toBe('claude-official')
  // No selection inherits the active provider; the server resolves it.
  expect(mentionProviderId(undefined)).toBeUndefined()
  composerReferencesApi.list(undefined, undefined)
  expect(api.get).toHaveBeenLastCalledWith('/api/skills/mentions')
})
