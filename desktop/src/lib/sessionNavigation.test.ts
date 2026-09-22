import { expect, it, vi } from 'vitest'
import { openSessionSource, sessionSourceTitle } from './sessionNavigation'
const openTab = vi.fn()
vi.mock('@/stores/tabStore', () => ({ useTabStore: { getState: () => ({ openTab }) } }))
vi.mock('@/stores/sessionStore', () => ({ useSessionStore: { getState: () => ({ sessions: [{ id: 'source', title: 'Auth review' }] }) } }))
it('uses known conversation titles while retaining the exact target identity', () => {
  expect(sessionSourceTitle('source')).toBe('Auth review')
  openSessionSource('source')
  expect(openTab).toHaveBeenCalledWith('source', 'Auth review')
  expect(sessionSourceTitle('unloaded')).toBe('unloaded')
})
