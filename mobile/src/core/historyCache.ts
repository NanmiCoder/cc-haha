import type { HistoryStore } from './sessionTransport'
import type { HistoryPage } from './types'

/**
 * History of the few recently opened sessions, kept only in memory. When returning to a session, show what was last read first
 * (including paged-back pages), then let the transport resync with the computer instead of paging again from the latest page.
 */
export function createHistoryCache(limit = 6) {
  const pages = new Map<string, HistoryPage>()
  return {
    store(hostId: string, sessionId: string): HistoryStore {
      const key = `${hostId}\n${sessionId}`
      return {
        read() {
          const page = pages.get(key)
          if (page) {
            pages.delete(key)
            pages.set(key, page)
          }
          return page
        },
        write(page) {
          pages.delete(key)
          pages.set(key, page)
          for (const oldest of pages.keys()) {
            if (pages.size <= limit) break
            pages.delete(oldest)
          }
        },
      }
    },
    forget(hostId: string, sessionId: string) {
      pages.delete(`${hostId}\n${sessionId}`)
    },
  }
}

export const sessionHistory = createHistoryCache()
