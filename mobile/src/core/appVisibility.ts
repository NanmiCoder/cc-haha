/**
 * App 是否还在前台。iOS 的 inactive（下拉通知中心、控制中心、Face ID、多任务切换）
 * 期间进程照常运行，连接也还在，不能当成离开；只有 background 才算。
 * 参数是 AppState 的状态；启动早期的 `unknown`/空值按不在前台处理，等第一个事件。
 */
export function isAppForeground(state: string | null | undefined) {
  return state === 'active' || state === 'inactive'
}

/**
 * 把 AppState 的变化折成「离开」和「回来」：进入 background 才算离开，之后第一次 active
 * 才算回来。active ↔ inactive 来回闪（控制中心、Face ID）两样都不是，
 * 不能每闪一次就当回到前台去重置冷却、重新协商。`initial` 是订阅时的 AppState.currentState。
 */
export function foregroundTransitions(initial?: string | null) {
  let away = initial === 'background'
  return (state: string | null | undefined): 'left' | 'returned' | null => {
    if (state === 'background') {
      if (away) return null
      away = true
      return 'left'
    }
    if (state !== 'active' || !away) return null
    away = false
    return 'returned'
  }
}
