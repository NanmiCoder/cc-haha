import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Globe, ExternalLink, FileText } from 'lucide-react'
import { TargetIcon } from './TargetIcon'
import type { OpenWithItem } from '../../lib/openWithItems'

type Props = {
  items: OpenWithItem[]
  anchor: { top: number; bottom: number; left: number; right: number }
  onClose: () => void
  // Optional trigger element to exclude from outside-close detection. When the
  // user clicks the same trigger that opened this menu, the trigger's own
  // click handler is responsible for toggling — don't double-close here.
  triggerEl?: HTMLElement | null
}

function ItemIcon({ item }: { item: OpenWithItem }) {
  if ((item.icon === 'ide' || item.icon === 'file-manager') && item.target) return <TargetIcon target={item.target} size={20} />
  if (item.icon === 'in-app-browser') return <Globe size={18} strokeWidth={1.9} />
  if (item.icon === 'preview') return <FileText size={18} strokeWidth={1.9} />
  return <ExternalLink size={18} strokeWidth={1.9} />
}

const MARGIN = 8

export function OpenWithMenu({ items, anchor, onClose, triggerEl }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  // Initial guess; corrected (before paint) by the layout effect once we can measure the menu.
  const [pos, setPos] = useState<{ top: number; left: number }>(() => ({
    top: anchor.bottom + 6,
    left: Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - 240 - MARGIN)),
  }))

  // Position viewport-aware: flip above the anchor if it would overflow the bottom
  // (the trigger often sits right above the composer), and clamp into the viewport.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { height, width } = el.getBoundingClientRect()
    const vh = window.innerHeight
    const vw = window.innerWidth

    let top = anchor.bottom + 6
    if (height > 0 && top + height > vh - MARGIN) {
      const flipped = anchor.top - height - 6
      top = flipped >= MARGIN ? flipped : Math.max(MARGIN, vh - height - MARGIN)
    }
    let left = anchor.left
    if (width > 0) left = Math.max(MARGIN, Math.min(left, vw - width - MARGIN))
    setPos({ top, left })
  }, [anchor])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (!target) return
      // Ignore clicks inside the menu itself, AND clicks inside the trigger
      // element that opened it — the trigger's own onClick handler will toggle.
      if (ref.current?.contains(target)) return
      if (triggerEl && triggerEl.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onViewportMove = () => onClose()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onViewportMove, true)
    window.addEventListener('resize', onViewportMove)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onViewportMove, true)
      window.removeEventListener('resize', onViewportMove)
    }
  }, [onClose, triggerEl])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed min-w-[220px] overflow-hidden rounded-[12px] border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-[var(--shadow-dropdown)]"
      style={{ top: pos.top, left: pos.left, zIndex: 1000 }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          onClick={() => { item.onSelect(); onClose() }}
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
        >
          <span className="flex h-6 w-6 items-center justify-center text-[var(--color-text-secondary)]"><ItemIcon item={item} /></span>
          <span className="min-w-0 truncate">{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}
