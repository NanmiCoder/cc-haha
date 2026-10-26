import type { ConnectionState } from './sessionTransport'

/** 后台超过这个时长，iOS 可能已经挂起进程，套接字不再可信。 */
export const RESUME_RECONNECT_AFTER_MS = 15_000

/**
 * 回到前台时是否重建会话连接。连接本来就不可用时立即重连；
 * 短暂离开（拉下通知中心、切去别的 App 看一眼）不重连，免得按钮无故变灰几秒。
 */
export function shouldReconnectOnResume({
  connection,
  hiddenAt,
  now,
  threshold = RESUME_RECONNECT_AFTER_MS,
}: {
  connection: ConnectionState
  hiddenAt?: number
  now: number
  threshold?: number
}) {
  if (connection !== 'ready') return connection !== 'pairing_required'
  if (hiddenAt === undefined) return false
  return now - hiddenAt >= threshold
}
