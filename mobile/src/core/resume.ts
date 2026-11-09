import type { ConnectionState } from './sessionTransport'

/**
 * 建连途中切到后台、并且离开超过这个时长：这次尝试多半已被系统挂起掐断
 * （iOS 挂起进程后套接字和请求都不再推进），回来直接重开，不等它慢慢超时。
 */
export const RESUME_STALE_ATTEMPT_MS = 10_000

/**
 * - probe：连接看起来还开着，先探活，收到任何一帧就继续用；
 * - expedite：正在等退避，立即重试；
 * - reconnect：连接已不可用，重建；
 * - none：不动（正在建连，或配对已失效）。
 */
export type ResumeAction = 'none' | 'probe' | 'expedite' | 'reconnect'

/**
 * 回到前台（或网络变化）时怎么处理会话连接。离开多久都先探活，不拆掉还能用的连接；
 * 正在建连的不打断，除非它跨过了一段足以被挂起的后台。
 */
export function resumeAction({
  connection,
  socketOpen,
  backoffPending,
  attemptStartedAt,
  hiddenAt,
  now,
  staleAfter = RESUME_STALE_ATTEMPT_MS,
}: {
  connection: ConnectionState
  socketOpen: boolean
  backoffPending: boolean
  attemptStartedAt?: number
  hiddenAt?: number
  now: number
  staleAfter?: number
}): ResumeAction {
  if (connection === 'pairing_required') return 'none'
  if (backoffPending) return 'expedite'
  if (connection === 'ready') return socketOpen ? 'probe' : 'reconnect'
  if (connection === 'offline') return 'reconnect'
  const spannedSuspension =
    hiddenAt !== undefined &&
    attemptStartedAt !== undefined &&
    attemptStartedAt <= hiddenAt &&
    now - hiddenAt >= staleAfter
  return spannedSuspension ? 'reconnect' : 'none'
}
