import { expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import { composerReferencesApi } from './composerReferences'
vi.mock('@/api/client', () => ({ api: { get: vi.fn() } }))
it('requests available capabilities for the exact workspace without credentials or catalog installation', () => {
  composerReferencesApi.list('/repo/中文 folder')
  expect(api.get).toHaveBeenCalledWith('/api/skills/mentions?cwd=%2Frepo%2F%E4%B8%AD%E6%96%87%20folder')
})
