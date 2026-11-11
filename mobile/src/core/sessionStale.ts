/**
 * 别的页面改写了会话记录（回退对话 / 代码）之后，会话页的内容就过时了。
 * 回退页在这里记一笔再返回，会话页重新获得焦点时取走标记并重新读取历史。
 * 只在内存里，和导航栈同生命周期。
 */
const stale = new Set<string>()
const key = (hostId: string, sessionId: string) => JSON.stringify([hostId, sessionId])

export function markSessionStale(hostId: string, sessionId: string) {
  stale.add(key(hostId, sessionId))
}

/** 取走标记：返回 true 表示需要重新读取，之后再调用返回 false。 */
export function takeSessionStale(hostId: string, sessionId: string) {
  return stale.delete(key(hostId, sessionId))
}
