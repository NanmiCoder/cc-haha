import { useEffect, useState } from 'react'

/** While something is running refresh "now" every second so the timer ticks; no timer when nothing runs. */
export function useNow(ticking: boolean, intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    const tick = () => setNow(Date.now())
    // Sync once immediately when the timer starts, then tick at the interval.
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, intervalMs)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [ticking, intervalMs])
  return now
}
