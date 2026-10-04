import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

import { Badge } from '@/components/ui/Badge'

const sectionOpenState = new Map<string, boolean>()
const TraceSectionScopeContext = createContext('default')

export function resetTraceSectionState(): void {
  sectionOpenState.clear()
}

export function TraceSectionStateProvider({
  scopeId,
  children,
}: {
  scopeId: string
  children: ReactNode
}) {
  return (
    <TraceSectionScopeContext.Provider value={scopeId}>
      {children}
    </TraceSectionScopeContext.Provider>
  )
}

export function Section({
  scopeId,
  sectionKey,
  title,
  badge,
  actions,
  defaultOpen = false,
  children,
}: {
  scopeId?: string
  sectionKey: string
  title: string
  badge?: string | number
  actions?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const contextScopeId = useContext(TraceSectionScopeContext)
  const resolvedScopeId = scopeId ?? contextScopeId
  const stateKey = useMemo(() => `${resolvedScopeId}:${sectionKey}`, [resolvedScopeId, sectionKey])
  const [open, setOpen] = useState(() => sectionOpenState.get(stateKey) ?? defaultOpen)

  useEffect(() => {
    setOpen(sectionOpenState.get(stateKey) ?? defaultOpen)
  }, [stateKey, defaultOpen])

  const toggle = () => {
    setOpen((previous) => {
      sectionOpenState.set(stateKey, !previous)
      return !previous
    })
  }

  return (
    <section className="border-t border-[var(--color-border)] first:border-t-0">
      <div className="flex items-center gap-2 px-6 pb-2 pt-4">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors"
        >
          <ChevronRight
            size={13}
            strokeWidth={2}
            className={`shrink-0 text-[var(--color-text-tertiary)] transition-transform ${open ? 'rotate-90' : ''}`}
          />
          <span className="truncate text-[14px] font-bold text-[var(--color-text-primary)]">
            {title}
          </span>
          {badge !== undefined ? (
            <Badge tone="neutral" size="xs" pill={false} mono>
              {badge}
            </Badge>
          ) : null}
        </button>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
      {open ? <div className="px-6 pb-5">{children}</div> : null}
    </section>
  )
}
