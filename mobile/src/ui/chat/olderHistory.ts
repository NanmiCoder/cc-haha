/** 离顶部不到这么多屏就开始往前翻，滑到顶之前内容通常已经补上。 */
export const PREFETCH_SCREENS = 1.5
/**
 * 一次拖动里最多连续自动翻几批。工具调用多的会话里一整批常常都折进已有的
 * 「处理过程」行、高度几乎不变，判断会接着翻；给个上限，用户再拖一下就继续。
 */
export const AUTO_BATCH_LIMIT = 4

/**
 * 要不要现在往前翻一批。内容不满一屏时一定翻，否则根本滚不起来；
 * 贴底跟随时不翻，刚打开会话、列表还停在顶部那一瞬间不算“滑到了顶部”。
 */
export function shouldPrefetchOlder({
  viewport,
  content,
  offset,
  following,
  batches,
}: {
  viewport: number
  content: number
  offset: number
  following: boolean
  batches: number
}) {
  if (!viewport || batches >= AUTO_BATCH_LIMIT) return false
  if (content <= viewport + 1) return true
  return !following && offset < viewport * PREFETCH_SCREENS
}
