import { expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import { connectorsApi } from './connectors'
vi.mock('@/api/client', () => ({ api: { get: vi.fn(), post: vi.fn() } }))
it('passes explicit shared-credential acknowledgment only in the requested action', () => {
  connectorsApi.action('feishu', 'authenticate', { acknowledgeSharedCredentials: true })
  expect(api.post).toHaveBeenCalledWith('/api/connectors/feishu/authenticate', { acknowledgeSharedCredentials: true })
  connectorsApi.list()
  expect(api.get).toHaveBeenCalledWith('/api/connectors', { signal: undefined })
})
