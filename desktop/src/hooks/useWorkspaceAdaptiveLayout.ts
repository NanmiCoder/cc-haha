import { useEffect, useState, type RefObject } from 'react'

/** Keep the saved split preference, but stop squeezing chat when both panes no longer fit. */
export function useWorkspaceAdaptiveLayout(panelRef: RefObject<HTMLElement | null>, visible: boolean) {
  const [singlePane, setSinglePane] = useState(false)
  useEffect(() => {
    const row = panelRef.current?.parentElement
    if (!visible || !row || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry?.contentRect.width) setSinglePane(entry.contentRect.width < 840)
    })
    observer.observe(row)
    return () => observer.disconnect()
  }, [panelRef, visible])
  return visible && singlePane
}
