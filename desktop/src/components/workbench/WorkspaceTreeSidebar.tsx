import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from '@/i18n'
import { X } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'

/** The tree collapses before the main split does, but its toolbar can always reopen it. */
export function WorkspaceTreeSidebar({ open, onOpenChange, children, collapseOnNarrow = true }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
  collapseOnNarrow?: boolean
}) {
  const t = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  const [width, setWidth] = useState(300)
  const drag = useRef<{ x: number, width: number } | null>(null)

  useEffect(() => {
    const parent = ref.current?.parentElement
    if (!parent || typeof ResizeObserver === 'undefined') return
    let wasNarrow = false
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === 0) return
      const next = entry.contentRect.width < 660
      setNarrow(next)
      if (next && !wasNarrow && collapseOnNarrow) onOpenChange(false)
      wasNarrow = next
    })
    observer.observe(parent)
    return () => observer.disconnect()
  }, [collapseOnNarrow, onOpenChange])

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (drag.current) setWidth(Math.max(180, Math.min(480, drag.current.width + drag.current.x - event.clientX)))
    }
    const stop = () => { drag.current = null }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [])

  return (
    <div
      ref={ref}
      data-testid="workspace-tree-sidebar"
      data-overlay={narrow}
      hidden={!open}
      className={`${open ? 'flex' : 'hidden'} min-h-0 shrink-0 flex-col bg-[var(--color-surface)] ${narrow ? 'absolute inset-y-0 right-0 z-[var(--z-drawer)] shadow-[var(--shadow-dropdown)]' : 'relative'}`}
      style={{ width, maxWidth: narrow ? '85%' : '48%' }}
      onKeyDown={(event) => {
        if (open && narrow && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onOpenChange(false)
        }
      }}
    >
      {narrow ? <div className="flex shrink-0 justify-end border-b border-[var(--color-border)] px-2 py-1">
        <IconButton icon={<X size={14} />} size="xs" tone="muted" label={t('common.close')} data-testid="workspace-tree-overlay-close" onClick={() => onOpenChange(false)} />
      </div> : null}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('workspace.resizePanel')}
          aria-valuemin={180}
          aria-valuemax={480}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            drag.current = { x: event.clientX, width }
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            setWidth((current) => Math.max(180, Math.min(480, current + (event.key === 'ArrowLeft' ? 20 : -20))))
          }}
          onDoubleClick={() => setWidth(300)}
          className="absolute inset-y-0 -left-1 w-2 cursor-col-resize outline-none focus-visible:bg-[var(--color-border-focus)]"
        />
        {children}
    </div>
  )
}
