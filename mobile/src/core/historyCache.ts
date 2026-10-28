import type { HistoryStore } from './sessionTransport'
import type { HistoryPage } from './types'

/**
 * 最近打开过的几段会话的历史，只存在内存里。返回会话时先显示上次读到的内容
 * （包括往前翻过的页），再由传输层和电脑对齐，不用从最新一页重新翻起。
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
