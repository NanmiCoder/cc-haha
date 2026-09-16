import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'

type HeaderSlot = { node: HTMLDivElement; sessionId: string }
type HeaderGeometry = { owner: symbol; sessionId: string; width: number }
type HeaderContext = {
  slot: HeaderSlot | null
  geometry: HeaderGeometry | null
  register: (node: HTMLDivElement | null, sessionId: string) => void
  measure: (owner: symbol, sessionId: string, width: number) => void
  release: (owner: symbol) => void
}

const Context = createContext<HeaderContext | null>(null)

/** The window owns the header location; the resource surface still owns its tabs. */
export function WorkspaceHeaderProvider({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HeaderSlot | null>(null)
  const [geometry, setGeometry] = useState<HeaderGeometry | null>(null)
  const register = useCallback((node: HTMLDivElement | null, sessionId: string) => {
    setSlot(current => node
      ? current?.node === node && current.sessionId === sessionId ? current : { node, sessionId }
      : current?.sessionId === sessionId ? null : current)
  }, [])
  const measure = useCallback((owner: symbol, sessionId: string, width: number) => {
    if (!Number.isFinite(width) || width <= 0) return
    setGeometry(current => current?.owner === owner && current.width === width
      ? current : { owner, sessionId, width })
  }, [])
  const release = useCallback((owner: symbol) => {
    setGeometry(current => current?.owner === owner ? null : current)
  }, [])
  const value = useMemo(() => ({ slot, geometry, register, measure, release }), [slot, geometry, register, measure, release])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useWorkspaceHeaderHost(sessionId: string | null) {
  const context = useContext(Context)
  const register = context?.register
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (sessionId) register?.(node, sessionId)
  }, [register, sessionId])
  return {
    available: context !== null,
    ref,
    width: context?.geometry?.sessionId === sessionId ? context.geometry.width : undefined,
  }
}

export function useWorkspaceHeaderTarget(surfaceRef: RefObject<HTMLDivElement>, sessionId: string, enabled: boolean) {
  const context = useContext(Context)
  const owner = useRef(Symbol('workspace-header'))
  const target = enabled && context?.slot?.sessionId === sessionId ? context.slot.node : null
  const measure = context?.measure
  const release = context?.release
  useLayoutEffect(() => {
    const element = surfaceRef.current
    if (!target || !element || !measure || !release) return
    const token = owner.current
    let disposed = false
    // clientWidth/contentRect are CSS pixels; viewport rects can include app zoom.
    measure(token, sessionId, element.clientWidth)
    const observer = new ResizeObserver(([entry]) => {
      if (!disposed && entry) measure(token, sessionId, entry.contentRect.width)
    })
    observer.observe(element)
    return () => { disposed = true; observer.disconnect(); release(token) }
  }, [measure, release, sessionId, surfaceRef, target])
  return target
}
