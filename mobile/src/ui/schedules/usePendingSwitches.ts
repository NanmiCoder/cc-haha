import { useState } from 'react'

/**
 * The toggle first shows the user's choice, and the local value is dropped once the computer returns a matching value; 
 * on request failure it is dropped immediately and the toggle returns to the real state on the computer.
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
  // Settle during render when the computer returns new data (React's recommended "adjust state with props" pattern).
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
