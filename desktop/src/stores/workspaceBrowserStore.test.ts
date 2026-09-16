import { beforeEach, describe, expect, it } from 'vitest'

import { useWorkspaceBrowserStore } from './workspaceBrowserStore'
import type {
  WorkspaceBrowserDownload,
  WorkspaceBrowserEvent,
} from '../lib/desktopHost/types'

const TAB = 'wb-1'
const OTHER_TAB = 'wb-2'

function store() {
  return useWorkspaceBrowserStore.getState()
}

function apply(event: WorkspaceBrowserEvent) {
  store().applyEvent(event)
}

/** The host emits one `state` event per navigation *and* per title/loading flip. */
function stateEvent(overrides: {
  tabId?: string
  url?: string
  title?: string
  canGoBack?: boolean
  canGoForward?: boolean
  loading?: boolean
} = {}): WorkspaceBrowserEvent {
  return {
    type: 'state',
    tabId: overrides.tabId ?? TAB,
    url: overrides.url ?? '',
    title: overrides.title ?? '',
    canGoBack: overrides.canGoBack ?? false,
    canGoForward: overrides.canGoForward ?? false,
    loading: overrides.loading ?? false,
  }
}

function download(overrides: Partial<WorkspaceBrowserDownload> = {}): WorkspaceBrowserDownload {
  return {
    id: 'dl-1',
    filename: 'report.pdf',
    savePath: null,
    receivedBytes: 0,
    totalBytes: 1000,
    state: 'progressing',
    ...overrides,
  }
}

beforeEach(() => {
  useWorkspaceBrowserStore.setState({ pageByTabId: {}, historyByTabId: {}, downloads: [] })
})

describe('page state', () => {
  it('reports an empty page for a tab the host has said nothing about yet', () => {
    // The toolbar reads this before the first event lands; an undefined page
    // would disable nothing and enable nothing in particular.
    expect(store().getPage(TAB)).toEqual({
      registered: false,
      url: '',
      title: '',
      canGoBack: false,
      canGoForward: false,
      loading: false,
      navigationId: 0,
      navigationOutcome: 'idle',
      zoomFactor: 1,
      find: null,
    })
    expect(store().getHistory(TAB)).toEqual([])
  })

  it('accepts only a native state event as registration, not optimistic zoom', () => {
    store().setZoom(TAB, 1.2)
    expect(store().getPage(TAB).registered).toBe(false)
    apply(stateEvent({ loading: true }))
    expect(store().getPage(TAB).registered).toBe(true)
  })

  it('takes back/forward availability straight from the host', () => {
    apply(stateEvent({ url: 'https://a.test/', canGoBack: true, canGoForward: false }))
    expect(store().getPage(TAB).canGoBack).toBe(true)
    expect(store().getPage(TAB).canGoForward).toBe(false)

    apply(stateEvent({ url: 'https://b.test/', canGoBack: true, canGoForward: true }))
    expect(store().getPage(TAB).canGoForward).toBe(true)
  })

  it('keeps each page separate so one tab cannot answer for another', () => {
    apply(stateEvent({ tabId: TAB, url: 'https://a.test/', canGoBack: true }))
    apply(stateEvent({ tabId: OTHER_TAB, url: 'https://b.test/' }))

    expect(store().getPage(TAB).url).toBe('https://a.test/')
    expect(store().getPage(OTHER_TAB).url).toBe('https://b.test/')
    expect(store().getPage(OTHER_TAB).canGoBack).toBe(false)
  })

  it('stops showing a spinner once a load fails', () => {
    apply(stateEvent({ url: 'https://a.test/', loading: true }))
    apply({
      type: 'failed',
      tabId: TAB,
      url: 'https://a.test/',
      errorCode: -105,
      errorDescription: 'NAME_NOT_RESOLVED',
    })
    expect(store().getPage(TAB).loading).toBe(false)
  })
})

describe('visit history', () => {
  it('records a visit when a URL commits', () => {
    apply(stateEvent({ url: 'https://a.test/', title: 'A' }))

    expect(store().getHistory(TAB).map((visit) => visit.url)).toEqual(['https://a.test/'])
  })

  it('does not record a second visit when only the title changes', () => {
    // Regression anchor: a page emits `state` again as soon as its <title>
    // resolves. Keying the visit on the event rather than on the URL filled the
    // History menu with the same page two or three times per navigation.
    apply(stateEvent({ url: 'https://a.test/', title: '' }))
    apply(stateEvent({ url: 'https://a.test/', title: 'A' }))
    apply(stateEvent({ url: 'https://a.test/', title: 'A — updated' }))

    expect(store().getHistory(TAB)).toHaveLength(1)
  })

  it('does not record a visit while the page is still loading', () => {
    // The first `state` of a navigation arrives with `loading: true` and the
    // *old* URL of the frame; recording it would log pages that never rendered.
    apply(stateEvent({ url: 'https://a.test/', loading: true }))

    expect(store().getHistory(TAB)).toEqual([])
  })

  it('records the next URL once a different page commits', () => {
    apply(stateEvent({ url: 'https://a.test/', title: 'A' }))
    apply(stateEvent({ url: 'https://a.test/', loading: true }))
    apply(stateEvent({ url: 'https://b.test/', title: 'B' }))

    expect(store().getHistory(TAB).map((visit) => visit.url)).toEqual([
      'https://a.test/',
      'https://b.test/',
    ])
  })

  it('records a return visit to a page seen earlier in the session', () => {
    // The visit log is a record of what the user looked at, not a de-duplicated
    // set — going back to A after B is a real third visit.
    apply(stateEvent({ url: 'https://a.test/' }))
    apply(stateEvent({ url: 'https://b.test/' }))
    apply(stateEvent({ url: 'https://a.test/' }))

    expect(store().getHistory(TAB)).toHaveLength(3)
  })

  it('ignores a committed event with no URL', () => {
    apply(stateEvent({ url: '' }))
    expect(store().getHistory(TAB)).toEqual([])
  })
})

describe('find', () => {
  it('shows the match counter the host reports', () => {
    apply(stateEvent({ url: 'https://a.test/' }))
    apply({ type: 'found', tabId: TAB, activeMatchOrdinal: 2, matches: 7 })

    expect(store().getPage(TAB).find).toEqual({ active: 2, total: 7 })
  })

  it('keeps the counter while the same page emits further state updates', () => {
    apply({ type: 'found', tabId: TAB, activeMatchOrdinal: 1, matches: 3 })
    apply(stateEvent({ url: 'https://a.test/', title: 'A' }))

    expect(store().getPage(TAB).find).toEqual({ active: 1, total: 3 })
  })

  it('clears the counter when a new load starts', () => {
    // Matches belong to the document that was searched. Carrying "3/12" across
    // a navigation shows a count for content that is no longer on screen.
    apply({ type: 'found', tabId: TAB, activeMatchOrdinal: 3, matches: 12 })
    apply(stateEvent({ url: 'https://b.test/', loading: true }))

    expect(store().getPage(TAB).find).toBeNull()
  })
})

describe('downloads', () => {
  it('updates a download in place instead of appending a duplicate', () => {
    // Regression anchor: progress arrives as a stream of events for one id. An
    // append-only list turned a single file into one row per progress tick.
    apply({ type: 'download', tabId: TAB, download: download({ receivedBytes: 100 }) })
    apply({ type: 'download', tabId: TAB, download: download({ receivedBytes: 500 }) })
    apply({
      type: 'download',
      tabId: TAB,
      download: download({ receivedBytes: 1000, state: 'completed', savePath: '/tmp/report.pdf' }),
    })

    expect(store().downloads).toHaveLength(1)
    expect(store().downloads[0]).toMatchObject({
      id: 'dl-1',
      state: 'completed',
      receivedBytes: 1000,
      savePath: '/tmp/report.pdf',
    })
  })

  it('keeps distinct downloads, newest first', () => {
    apply({ type: 'download', tabId: TAB, download: download({ id: 'dl-1' }) })
    apply({ type: 'download', tabId: OTHER_TAB, download: download({ id: 'dl-2' }) })

    expect(store().downloads.map((item) => item.id)).toEqual(['dl-2', 'dl-1'])
  })

  it('clears the list on request', () => {
    apply({ type: 'download', tabId: TAB, download: download() })
    store().clearDownloads()
    expect(store().downloads).toEqual([])
  })
})

describe('forgetTab', () => {
  it('drops that page state and history and nothing else', () => {
    apply(stateEvent({ tabId: TAB, url: 'https://a.test/' }))
    apply(stateEvent({ tabId: OTHER_TAB, url: 'https://b.test/' }))
    apply({ type: 'download', tabId: TAB, download: download() })

    store().forgetTab(TAB)

    expect(store().pageByTabId[TAB]).toBeUndefined()
    expect(store().historyByTabId[TAB]).toBeUndefined()
    expect(store().pageByTabId[OTHER_TAB]?.url).toBe('https://b.test/')
    expect(store().historyByTabId[OTHER_TAB]).toHaveLength(1)
    // Downloads are a window-level list, not a per-page one: closing the tab
    // that started a download must not erase the record of the saved file.
    expect(store().downloads).toHaveLength(1)
  })

  it('leaves the store untouched for a tab it never knew about', () => {
    apply(stateEvent({ tabId: TAB, url: 'https://a.test/' }))
    const before = useWorkspaceBrowserStore.getState()

    store().forgetTab('wb-never-existed')

    expect(useWorkspaceBrowserStore.getState().pageByTabId).toBe(before.pageByTabId)
    expect(useWorkspaceBrowserStore.getState().historyByTabId).toBe(before.historyByTabId)
  })
})


it('tracks annotation mode per live page and accepts legacy state events without resetting it', () => {
  apply({ ...stateEvent(), annotationActive: true } as WorkspaceBrowserEvent)
  apply(stateEvent({ title: 'New title' }))
  expect(store().getPage(TAB).annotationActive).toBe(true)
  expect(store().getPage(OTHER_TAB).annotationActive ?? false).toBe(false)
  apply({ ...stateEvent(), annotationActive: false } as WorkspaceBrowserEvent)
  expect(store().getPage(TAB).annotationActive).toBe(false)
  store().forgetTab(TAB)
  expect(store().getPage(TAB).annotationActive ?? false).toBe(false)
})


describe('native history contract', () => {
  it('uses committed host visits and their timestamps rather than dropping history events', () => {
    apply({ type: 'history', tabId: TAB, entries: [{ url: 'https://a.test/', title: '', visitedAt: 123 }] })
    expect(store().getHistory(TAB)).toEqual([{ url: 'https://a.test/', title: '', visitedAt: 123 }])
    // Titles resolve after did-navigate. Enrich without inventing a timestamp.
    apply(stateEvent({ url: 'https://a.test/', title: 'Resolved title' }))
    apply({ type: 'history', tabId: TAB, entries: [
      { url: 'https://a.test/', title: '', visitedAt: 123 },
      { url: 'https://b.test/', title: 'B', visitedAt: 456 },
    ] })
    expect(store().getHistory(TAB)).toEqual([
      { url: 'https://a.test/', title: 'Resolved title', visitedAt: 123 },
      { url: 'https://b.test/', title: 'B', visitedAt: 456 },
    ])
    expect(store().getHistory(OTHER_TAB)).toEqual([])
  })

  it('does not turn a stopped failed navigation into a successful visit', () => {
    apply({ ...stateEvent({ url: 'https://failed.test/', title: 'Error' }), navigationOutcome: 'failed', navigationId: 1 } as WorkspaceBrowserEvent)
    expect(store().getHistory(TAB)).toEqual([])
  })

  it('updates a late page title on the existing visit without adding duplicates', () => {
    apply(stateEvent({ url: 'https://a.test/' }))
    const timestamp = store().getHistory(TAB)[0]!.visitedAt
    apply(stateEvent({ url: 'https://a.test/', title: 'Loaded title' }))
    expect(store().getHistory(TAB)).toEqual([{ url: 'https://a.test/', title: 'Loaded title', visitedAt: timestamp }])
  })
})
