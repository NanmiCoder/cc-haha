import { useEffect, useState } from 'react'
import type { ConnectionState } from '../../core/sessionTransport'

/** 断开这么久之后，导航栏副标题才改成连接状态；之前照常显示会话信息。 */
export const CONNECTION_LABEL_AFTER_MS = 3000
/** 断开这么久之后，才弹出「正在重连」的提示条。 */
export const CONNECTION_BANNER_AFTER_MS = 10000
/** 连着失败这么多次就不再等：多半是电脑睡了或网络不通，马上告诉用户。 */
export const CONNECTION_BANNER_AFTER_FAILURES = 2

/** 这些状态下的提示条说的是「断开了，正在自动重连」，并给出重试。 */
export function showsReconnectBanner(connection: ConnectionState) {
  return connection === 'resuming' || connection === 'reconnecting' || connection === 'offline'
}

export type ConnectionNotice = {
  /** 副标题显示连接状态。 */
  label: boolean
  /** 显示连接提示条（重连中 / 读取失败）。 */
  banner: boolean
  /** 过多久状态会变，需要重新判断。 */
  recheckIn?: number
}

/**
 * 回到前台、切网这类短暂断线通常一两秒就自己恢复，这期间不打扰用户。
 * 配对失效要用户处理，立即提示；连着两次没连上也不再等满十秒；
 * 刚打开会话还没连上过，照常显示「正在连接」。
 */
export function connectionNotice({
  connection,
  since,
  now,
  everReady,
  failures = 0,
}: {
  connection: ConnectionState
  /** 这次离开 ready 的时刻（还没连上过时是打开会话的时刻）。 */
  since: number
  now: number
  everReady: boolean
  /** 连着失败的建连次数（见 SessionTransport.failures）。 */
  failures?: number
}): ConnectionNotice {
  if (connection === 'ready') return { label: false, banner: false }
  if (connection === 'pairing_required') return { label: true, banner: true }
  const elapsed = Math.max(0, now - since)
  const failing = failures >= CONNECTION_BANNER_AFTER_FAILURES
  const label = !everReady || failing || elapsed >= CONNECTION_LABEL_AFTER_MS
  const banner = failing || elapsed >= CONNECTION_BANNER_AFTER_MS
  const next = banner
    ? undefined
    : [CONNECTION_LABEL_AFTER_MS, CONNECTION_BANNER_AFTER_MS].find((threshold) => threshold > elapsed)
  return {
    label,
    banner,
    ...(next === undefined ? {} : { recheckIn: next - elapsed }),
  }
}

/** 记下这次离开 ready 的时刻，并在提示该出现时重新渲染。 */
export function useConnectionNotice(
  connection: ConnectionState,
  failures = 0,
  now: () => number = Date.now
) {
  const ready = connection === 'ready'
  const [track, setTrack] = useState(() => ({ ready, since: now(), everReady: ready }))
  // 状态变化当场记下时刻：等 effect 再记会先用旧时刻算一帧，把提示条闪出来。
  let current = track
  if (track.ready !== ready) {
    current = { ready, since: now(), everReady: track.everReady || ready }
    setTrack(current)
  }
  const [, setChecks] = useState(0)
  const notice = connectionNotice({
    connection,
    since: current.since,
    now: now(),
    everReady: current.everReady,
    failures,
  })
  const wait = notice.recheckIn
  useEffect(() => {
    if (wait === undefined) return
    const timer = setTimeout(() => setChecks((value) => value + 1), wait)
    return () => clearTimeout(timer)
  }, [wait, current.since])
  return notice
}
