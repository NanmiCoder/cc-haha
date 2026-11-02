/** 离已加载的最早内容不到这么多屏就开始往前翻，滑到顶之前内容通常已经补上。 */
export const PREFETCH_SCREENS = 1.5
/**
 * 一次拖动里最多连续自动翻几批。工具调用多的会话里一整批常常都折进已有的
 * 「处理过程」行、高度几乎不变，判断会接着翻；给个上限，用户再拖一下就继续。
 */
export const AUTO_BATCH_LIMIT = 4

/**
 * 要不要现在往前翻一批。消息流是倒置列表（起点是最新处），toOldest 是可视区顶边到
 * 已加载最早内容的距离：内容不满一屏时它是 0，自然会补；更早的内容接在列表末尾，
 * 不会挪动阅读位置，所以停在最新处时也可以提前翻。
 */
export function shouldPrefetchOlder({
  viewport,
  content,
  toOldest,
  batches,
}: {
  viewport: number
  content: number
  toOldest: number
  batches: number
}) {
  if (!viewport || !content || batches >= AUTO_BATCH_LIMIT) return false
  return toOldest < viewport * PREFETCH_SCREENS
}
