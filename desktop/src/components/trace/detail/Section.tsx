import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

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
