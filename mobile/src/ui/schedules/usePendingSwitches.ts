import { useState } from 'react'

/**
 * 开关先按用户的选择显示，等电脑返回的值一致后再撤掉本地值；
 * 请求失败时立即撤掉，开关回到电脑上的真实状态。
 */
export function settlePending(
  pending: Record<string, boolean>,
  server: Map<string, boolean>
): Record<string, boolean> {
  const next = Object.fromEntries(
    Object.entries(pending).filter(([id, value]) => server.has(id) && server.get(id) !== value)
  )
  return Object.keys(next).length === Object.keys(pending).length ? pending : next
}

export function usePendingSwitches(server: Map<string, boolean>) {
  const [pending, setPending] = useState<Record<string, boolean>>({})
  // 电脑返回新数据时在渲染中结算（React 推荐的“随 props 调整 state”写法）。
  const [seen, setSeen] = useState(server)
  if (seen !== server) {
    setSeen(server)
    setPending((current) => settlePending(current, server))
  }
  return {
    value: (id: string, fallback: boolean) => pending[id] ?? fallback,
    set: (id: string, value: boolean) => setPending((current) => ({ ...current, [id]: value })),
    drop: (id: string) =>
      setPending((current) => {
        const { [id]: _dropped, ...rest } = current
        return rest
      }),
  }
}
