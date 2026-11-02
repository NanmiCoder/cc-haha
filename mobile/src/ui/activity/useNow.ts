import { useEffect, useState } from 'react'

/** 有东西在跑时每秒刷新一次“现在”，让计时走起来；没有时不开定时器。 */
export function useNow(ticking: boolean, intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    const tick = () => setNow(Date.now())
    // 开始计时时立刻对一次表，之后按间隔走。
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, intervalMs)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [ticking, intervalMs])
  return now
}
