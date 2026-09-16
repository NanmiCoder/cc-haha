import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTabStore, HOSTS_TAB_ID } from '../../../stores/tabStore'
import { sessionsApi } from '../../../api/sessions'

if (typeof localStorage === 'undefined') {
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
  }
}

describe('tabStore hosts integration (M2.2 & M2.4)', () => {
  beforeEach(() => {
    localStorage.clear()
    useTabStore.setState({ tabs: [], activeTabId: null })
  })

  it('opens and activates singleton hosts tab with id __hosts__ and type hosts', () => {
    useTabStore.getState().openHostsTab('主机管理')

    const hostsTab = useTabStore.getState().tabs.find(t => t.sessionId === HOSTS_TAB_ID)
    expect(hostsTab).toBeDefined()
    expect(hostsTab?.type).toBe('hosts')
    expect(hostsTab?.title).toBe('主机管理')
    expect(useTabStore.getState().activeTabId).toBe(HOSTS_TAB_ID)

    // Opening again does not duplicate
    useTabStore.getState().openHostsTab('主机管理')
    const count = useTabStore.getState().tabs.filter(t => t.sessionId === HOSTS_TAB_ID).length
    expect(count).toBe(1)
  })

  it('restores special hosts tab and persisted session tabs even when sessionsApi.list fails', async () => {
    vi.spyOn(sessionsApi, 'list').mockRejectedValue(new Error('Server unavailable'))

    localStorage.setItem('cc-haha-open-tabs', JSON.stringify({
      openTabs: [
        { sessionId: '__hosts__', title: '主机管理', type: 'hosts' },
        { sessionId: 's-1', title: 'Chat 1', type: 'session' },
      ],
      activeTabId: '__hosts__',
    }))

    await useTabStore.getState().restoreTabs()

    const tabs = useTabStore.getState().tabs
    expect(tabs.length).toBe(2)
    expect(tabs[0]?.sessionId).toBe(HOSTS_TAB_ID)
    expect(tabs[0]?.type).toBe('hosts')
    expect(tabs[1]?.sessionId).toBe('s-1')
    expect(tabs[1]?.type).toBe('session')
    expect(useTabStore.getState().activeTabId).toBe(HOSTS_TAB_ID)
  })

  it('deduplicates multiple __hosts__ tabs during restoration', async () => {
    vi.spyOn(sessionsApi, 'list').mockResolvedValue({ sessions: [] } as any)

    localStorage.setItem('cc-haha-open-tabs', JSON.stringify({
      openTabs: [
        { sessionId: '__hosts__', title: '主机管理', type: 'hosts' },
        { sessionId: '__hosts__', title: '主机管理 (duplicate)', type: 'hosts' },
      ],
      activeTabId: '__hosts__',
    }))

    await useTabStore.getState().restoreTabs()

    const tabs = useTabStore.getState().tabs
    expect(tabs.length).toBe(1)
    expect(tabs[0]?.sessionId).toBe(HOSTS_TAB_ID)
    expect(useTabStore.getState().activeTabId).toBe(HOSTS_TAB_ID)
  })
})
