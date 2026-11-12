/**
 * Network changed (Wi-Fi ↔ cellular, reconnected after offline): old sockets are most likely dead, 
 * but would only be noticed after missed heartbeats (15–30 s). Have the session probe immediately on any change.
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
/** The system often reports state several times during a network switch; wait for it to settle before probing. */
export const NETWORK_SETTLE_MS = 1000

const differs = (a: NetworkSnapshot, b: NetworkSnapshot) =>
  a.type !== b.type || a.isConnected !== b.isConnected

/**
 * `readCurrent` Read the current network once as a baseline (expo-network getNetworkStateAsync).
 * Native only starts observing and reports the current state once when the first subscriber arrives; later subscribers miss it: 
 * without a baseline, the first real network switch would be swallowed as the baseline.
 */
export function watchNetwork(
  subscribe: NetworkSubscribe,
  onChange: () => void,
  timers: Timers = defaultTimers,
  readCurrent?: () => Promise<NetworkSnapshot>
) {
  let previous: NetworkSnapshot | undefined
  /** The first report received before the baseline is read: it may just restate the current state, or may already be a change. */
  let early: NetworkSnapshot | undefined
  let reading = !!readCurrent
  let stopped = false
  let pending: unknown
  const changed = (state: NetworkSnapshot) => {
    // Probing while offline cannot succeed; probe once the network comes back.
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
      // The baseline was read before that report: if they differ, the report is a real change.
      else if (differs(baseline, early)) changed(previous!)
    })
    .catch(() => {
      /* If it cannot be read fall back to the old way: the first report is the baseline. */
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
