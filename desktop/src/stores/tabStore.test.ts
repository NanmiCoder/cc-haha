import { beforeEach, describe, expect, it } from 'vitest'
import { useTabStore } from './tabStore'

describe('tabStore', () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null })
    localStorage.clear()
  })

  it('refreshes an existing tab title when opening the same session again', () => {
    useTabStore.getState().openTab('session-1', '```json {"title":')
    useTabStore.getState().openTab('session-1', '使用bash写一个shell，随便写点什么东西')

    expect(useTabStore.getState().tabs).toHaveLength(1)
    expect(useTabStore.getState().tabs[0]).toMatchObject({
      sessionId: 'session-1',
      title: '使用bash写一个shell，随便写点什么东西',
      type: 'session',
    })
    expect(useTabStore.getState().activeTabId).toBe('session-1')
  })
})
