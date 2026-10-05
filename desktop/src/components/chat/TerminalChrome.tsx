import type { ReactNode } from 'react'
import { SquareTerminal } from 'lucide-react'

type Props = {
  /** Mono label at the head's left: the shell the command ran in. */
  label?: string
  /** Right side of the head: exit-code pill, duration, copy. */
  meta?: ReactNode
  children: ReactNode
  className?: string
}

/**
 * The frame a shell call's output sits in: a 32px head and a sunken body.
 *
 * Deliberately not a window. The macOS traffic lights it used to wear were
 * decoration pretending to be controls, and the black slab they sat on was the
 * loudest thing in a light transcript — a terminal block is a code block that
 * happens to have run, so it takes the code block's ground in every theme.
 */
export function TerminalChrome({ label, meta, children, className = '' }: Props) {
  return (
    <div
      data-terminal-chrome=""
      className={`overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-code-bg)] ${className}`}
    >
      <div className="flex h-8 items-center gap-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface-container)] pl-2.5 pr-1.5 text-[var(--color-text-tertiary)]">
        <SquareTerminal size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{label}</span>
        {meta ? <span className="flex shrink-0 items-center gap-2">{meta}</span> : null}
      </div>
      <div className="text-[var(--color-code-fg)]">
        {children}
      </div>
    </div>
  )
}
