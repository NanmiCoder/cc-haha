import { create } from 'zustand'
import type {
  WorkspaceBrowserDownload,
  WorkspaceBrowserEvent,
} from '../lib/desktopHost/types'

/**
 * Volatile per-page browser state: what the host has told us about a live page.
 *
 * Navigation history here is a *record of visits for the History menu*, not the
 * back/forward stack. Back and forward are answered by `canGoBack`/`canGoForward`
 * straight from the host's own navigation controller — simulating them with an
 * array is exactly what made the previous implementation disagree with the page
 * after a redirect or an in-page navigation.
 */

const HISTORY_LIMIT = 200
const DOWNLOAD_LIMIT = 50

export type WorkspaceBrowserPageState = {
  /** A native state event confirms that the host has registered this resource. */
  registered: boolean
  annotationActive?: boolean
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  navigationId: number
  navigationOutcome: 'idle' | 'pending' | 'succeeded' | 'failed'
  zoomFactor: number
  find: { active: number; total: number } | null
}

export type WorkspaceBrowserVisit = {
  url: string
  title: string
  visitedAt: number
}

const EMPTY_PAGE_STATE: WorkspaceBrowserPageState = {
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
}

type WorkspaceBrowserStore = {
  pageByTabId: Record<string, WorkspaceBrowserPageState | undefined>
  historyByTabId: Record<string, WorkspaceBrowserVisit[] | undefined>
  downloads: WorkspaceBrowserDownload[]

  getPage: (browserTabId: string) => WorkspaceBrowserPageState
  getHistory: (browserTabId: string) => WorkspaceBrowserVisit[]

  applyEvent: (event: WorkspaceBrowserEvent) => boolean
  setZoom: (browserTabId: string, factor: number) => void
  forgetTab: (browserTabId: string) => void
  clearDownloads: () => void
}

export const useWorkspaceBrowserStore = create<WorkspaceBrowserStore>((set, get) => ({
  pageByTabId: {},
  historyByTabId: {},
  downloads: [],

  getPage: (browserTabId) => get().pageByTabId[browserTabId] ?? EMPTY_PAGE_STATE,
  getHistory: (browserTabId) => get().historyByTabId[browserTabId] ?? [],

  applyEvent: (event) => {
    const previous = get().pageByTabId[event.tabId]
    if (event.type === 'state' || event.type === 'failed') {
      if (event.navigationId !== undefined && previous && (
        event.navigationId < previous.navigationId ||
        (event.type === 'failed' && event.navigationId === previous.navigationId && previous.navigationOutcome === 'succeeded')
      )) return false
    }
    set((state) => {
      switch (event.type) {
        case 'state': {
          const previous = state.pageByTabId[event.tabId] ?? EMPTY_PAGE_STATE
          const history = state.historyByTabId[event.tabId] ?? []
          // Record a visit only when a *different* URL has committed. Title
          // updates and loading flips arrive as separate `state` events for the
          // same page and would otherwise fill the history with duplicates.
          const committed = !event.loading &&
            (event.navigationOutcome === undefined || event.navigationOutcome === 'succeeded')
          const lastVisit = history.at(-1)
          const isNewVisit = committed && event.url && event.url !== lastVisit?.url
          const updatedTitle = committed && lastVisit?.url === event.url && event.title && event.title !== lastVisit.title
          const nextHistory = isNewVisit
            ? [...history, { url: event.url, title: event.title, visitedAt: Date.now() }].slice(-HISTORY_LIMIT)
            : updatedTitle
              ? [...history.slice(0, -1), { ...lastVisit, title: event.title }]
              : history
          return {
            pageByTabId: {
              ...state.pageByTabId,
              [event.tabId]: {
                registered: true,
                annotationActive: event.annotationActive ?? previous.annotationActive ?? false,
                url: event.url,
                title: event.title,
                canGoBack: event.canGoBack,
                canGoForward: event.canGoForward,
                loading: event.loading,
                navigationId: event.navigationId ?? previous.navigationId,
                navigationOutcome: event.navigationOutcome ?? previous.navigationOutcome,
                zoomFactor: event.zoomFactor ?? previous.zoomFactor,
                find: event.loading ? null : previous.find,
              },
            },
            historyByTabId: nextHistory === history ? state.historyByTabId : {
              ...state.historyByTabId,
              [event.tabId]: nextHistory,
            },
          }
        }
        case 'history': {
          // The main process owns committed visits and timestamps. State events
          // still support legacy hosts, but must not replace this authoritative
          // snapshot or lose titles that resolved after did-navigate.
          const previous = state.historyByTabId[event.tabId] ?? []
          const knownVisits = new Map(previous.map(visit => [`${visit.visitedAt}:${visit.url}`, visit]))
          const entries = event.entries.slice(-HISTORY_LIMIT).map(visit => {
            const known = knownVisits.get(`${visit.visitedAt}:${visit.url}`)
            return { ...visit, title: known?.title || visit.title }
          })
          return { historyByTabId: { ...state.historyByTabId, [event.tabId]: entries } }
        }
        case 'found': {
          const previous = state.pageByTabId[event.tabId] ?? EMPTY_PAGE_STATE
          return {
            pageByTabId: {
              ...state.pageByTabId,
              [event.tabId]: {
                ...previous,
                find: { active: event.activeMatchOrdinal, total: event.matches },
              },
            },
          }
        }
        case 'failed': {
          const previous = state.pageByTabId[event.tabId] ?? EMPTY_PAGE_STATE
          return {
            pageByTabId: {
              ...state.pageByTabId,
              [event.tabId]: {
                ...previous,
                loading: false,
                navigationId: event.navigationId ?? previous.navigationId,
                navigationOutcome: 'failed',
              },
            },
          }
        }
        case 'download': {
          const rest = state.downloads.filter((item) => item.id !== event.download.id)
          return { downloads: [event.download, ...rest].slice(0, DOWNLOAD_LIMIT) }
        }
        default:
          return state
      }
    })
    return true
  },

  setZoom: (browserTabId, factor) => set((state) => ({
    pageByTabId: {
      ...state.pageByTabId,
      [browserTabId]: { ...(state.pageByTabId[browserTabId] ?? EMPTY_PAGE_STATE), zoomFactor: factor },
    },
  })),

  forgetTab: (browserTabId) =>
    set((state) => {
      if (!(browserTabId in state.pageByTabId) && !(browserTabId in state.historyByTabId)) {
        return state
      }
      const { [browserTabId]: _page, ...pageByTabId } = state.pageByTabId
      const { [browserTabId]: _history, ...historyByTabId } = state.historyByTabId
      return { pageByTabId, historyByTabId }
    }),

  clearDownloads: () => set({ downloads: [] }),
}))
