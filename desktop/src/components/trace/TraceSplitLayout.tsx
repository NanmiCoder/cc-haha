import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

const STORAGE_KEY = 'trace.treeWidth'
const DEFAULT_WIDTH = 380
const MIN_WIDTH = 280
const MAX_WIDTH = 560

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)))
}

function readStoredWidth(): number {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    const parsed = stored === null ? Number.NaN : Number.parseInt(stored, 10)
    return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

function persistWidth(width: number) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(width))
  } catch {
    // localStorage unavailable (private mode); keep the in-memory width.
  }
}

export function TraceSplitLayout({ tree, detail }: { tree: ReactNode; detail: ReactNode }) {
  const [width, setWidth] = useState(readStoredWidth)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const widthRef = useRef(width)
  widthRef.current = width

  const onPointerMove = useCallback((event: MouseEvent) => {
    const drag = dragRef.current
    if (!drag) return
    setWidth(clampWidth(drag.startWidth + (event.clientX - drag.startX)))
  }, [])

  const onPointerUp = useCallback(() => {
    if (!dragRef.current) return
    dragRef.current = null
    persistWidth(widthRef.current)
    document.body.style.removeProperty('cursor')
    document.body.style.removeProperty('user-select')
    window.removeEventListener('mousemove', onPointerMove)
    window.removeEventListener('mouseup', onPointerUp)
  }, [onPointerMove])

  const onDividerMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    dragRef.current = { startX: event.clientX, startWidth: widthRef.current }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onPointerMove)
    window.addEventListener('mouseup', onPointerUp)
  }, [onPointerMove, onPointerUp])

  const onDividerDoubleClick = useCallback(() => {
    setWidth(DEFAULT_WIDTH)
    persistWidth(DEFAULT_WIDTH)
  }, [])

  useEffect(() => () => {
    window.removeEventListener('mousemove', onPointerMove)
    window.removeEventListener('mouseup', onPointerUp)
  }, [onPointerMove, onPointerUp])

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row"
      style={{ '--trace-tree-width': `${width}px` } as CSSProperties}
      data-testid="trace-split-layout"
    >
      <div className="flex h-[40vh] min-h-0 shrink-0 flex-col overflow-hidden lg:h-auto lg:w-[var(--trace-tree-width)]">
        {tree}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        data-testid="trace-split-divider"
        onMouseDown={onDividerMouseDown}
        onDoubleClick={onDividerDoubleClick}
        className="group relative hidden w-px shrink-0 cursor-col-resize bg-[var(--color-border)] lg:block"
      >
        <div className="absolute inset-y-0 -left-[2px] w-[5px] transition-colors group-hover:bg-[var(--color-brand)]/25" />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-t border-[var(--color-border)] lg:border-t-0">
        {detail}
      </div>
    </div>
  )
}
