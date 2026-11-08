/**
 * 网络换了（Wi-Fi ↔ 蜂窝、断网后又连上）：旧套接字多半已经不通，
 * 却要等心跳漏掉才发现（15–30 秒）。一有变化就让会话立即探活。
 */
export type NetworkSnapshot = { type?: string; isConnected?: boolean }
export type NetworkSubscribe = (listener: (state: NetworkSnapshot) => void) => { remove(): void }
type Timers = {
  set(callback: () => void, delay: number): unknown
  clear(handle: unknown): void
}
const defaultTimers: Timers = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}
/** 切网时系统往往连着报好几次状态，等它稳定下来再探。 */
export const NETWORK_SETTLE_MS = 1000

const differs = (a: NetworkSnapshot, b: NetworkSnapshot) =>
  a.type !== b.type || a.isConnected !== b.isConnected

/**
 * `readCurrent` 读一次当前网络作基线（expo-network 的 getNetworkStateAsync）。
 * 原生那边只在第一个订阅者到来时开始观察并报一次当前状态，之后订阅的拿不到这一次：
 * 没有基线时，第一次真实的切网会被当成基线吞掉。
 */
export function watchNetwork(
  subscribe: NetworkSubscribe,
  onChange: () => void,
  timers: Timers = defaultTimers,
  readCurrent?: () => Promise<NetworkSnapshot>
) {
  let previous: NetworkSnapshot | undefined
  /** 基线读到之前收到的第一次报告：可能只是重报当前状态，也可能已经是一次变化。 */
  let early: NetworkSnapshot | undefined
  let reading = !!readCurrent
  let stopped = false
  let pending: unknown
  const changed = (state: NetworkSnapshot) => {
    // 断网时探也探不通；等网络回来那一次再探。
    if (state.isConnected === false) return
    timers.clear(pending)
    pending = timers.set(() => {
      pending = undefined
      onChange()
    }, NETWORK_SETTLE_MS)
  }
  const subscription = subscribe((state) => {
    const next = { type: state.type, isConnected: state.isConnected }
    const before = previous
    previous = next
    if (before) {
      if (differs(before, next)) changed(next)
    } else if (reading) early = next
  })
  readCurrent?.()
    .then((state) => {
      if (stopped) return
      const baseline = { type: state.type, isConnected: state.isConnected }
      if (!early) previous ??= baseline
      // 基线是在那次报告之前读的：两者不同，那次报告就是一次真实的变化。
      else if (differs(baseline, early)) changed(previous!)
    })
    .catch(() => {
      /* 读不到就退回旧办法：第一次报告当基线。 */
    })
    .finally(() => {
      reading = false
    })
  return () => {
    stopped = true
    timers.clear(pending)
    subscription.remove()
  }
}
