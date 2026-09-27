import { expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import { sideChatsApi } from './sideChats'
vi.mock('@/api/client', () => ({ api: { post: vi.fn(), delete: vi.fn() } }))
it('uses an independent idempotency id and encodes both parent and child path components', () => {
  sideChatsApi.create('parent/one')
  expect(api.post).toHaveBeenCalledWith('/api/sessions/parent%2Fone/side-chats', { sideChatId: expect.stringMatching(/^[a-f0-9-]{36}$/) })
  sideChatsApi.discard('parent/one', 'side-child/two')
  expect(api.delete).toHaveBeenCalledWith('/api/sessions/parent%2Fone/side-chats/side-child%2Ftwo')
})
