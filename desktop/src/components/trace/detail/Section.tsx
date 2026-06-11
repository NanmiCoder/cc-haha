import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

/**
 * Collapse state is remembered per section key at module level so that
 * switching the selected span keeps the user's reading layout intact.
 */
const sectionOpenState = new Map<string, boolean>()

export function resetTraceSectionState(): void {
  sectionOpenState.clear()
}

export function Section({
  sectionKey,
  title,
  badge,
  actions,
  defaultOpen = false,
  children,
}: {
  sectionKey: string
  title: string
  badge?: string | number
  actions?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(() => sectionOpenState.get(sectionKey) ?? defaultOpen)

  // defaultOpen can flip after async detail loads (e.g. legacy fallback opens
  // Raw). Follow it until the user toggles this section explicitly.
  useEffect(() => {
    if (!sectionOpenState.has(sectionKey)) setOpen(defaultOpen)
  }, [sectionKey, defaultOpen])

  const toggle = () => {
    setOpen((previous) => {
      sectionOpenState.set(sectionKey, !previous)
      return !previous
    })
  }

  return (
    <section className="border-t border-[var(--color-border)] first:border-t-0">
      <div className="flex items-center gap-2 px-4 py-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors"
        >
          <ChevronRight
            size={13}
            strokeWidth={2}
            className={`shrink-0 text-[var(--color-text-tertiary)] transition-transform ${open ? 'rotate-90' : ''}`}
          />
          <span className="truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
            {title}
          </span>
          {badge !== undefined ? (
            <span className="shrink-0 rounded-[var(--radius-sm)] bg-[var(--color-surface-container)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-tertiary)]">
              {badge}
            </span>
          ) : null}
        </button>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {open ? <div className="px-4 pb-4">{children}</div> : null}
    </section>
  )
}
