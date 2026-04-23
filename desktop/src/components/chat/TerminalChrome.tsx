import type { ReactNode } from 'react'

type Props = {
  title?: string
  children: ReactNode
  className?: string
}

/**
 * macOS-style terminal window decoration with traffic light buttons.
 * Reusable wrapper for Bash commands, tool results, and code viewers.
 */
export function TerminalChrome({ title, children, className = '' }: Props) {
  return (
    <div className={`overflow-hidden rounded-2xl border border-[var(--color-outline-variant)]/20 bg-[var(--color-surface-dim)] ${className}`}>
      {/* Title bar with traffic lights */}
      <div className="flex items-center gap-2 border-b border-[var(--color-terminal-border)] bg-[var(--color-terminal-header)] px-3 py-2">
        <div className="flex gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-[var(--color-terminal-danger)]" />
          <div className="w-2.5 h-2.5 rounded-full bg-[var(--color-terminal-warning)]" />
          <div className="w-2.5 h-2.5 rounded-full bg-[var(--color-terminal-accent)]" />
        </div>
        {title && (
          <span className="ml-2 truncate font-[var(--font-mono)] text-[10px] text-[var(--color-terminal-muted)]">
            {title}
          </span>
        )}
      </div>
      {/* Content */}
      <div className="bg-[var(--color-terminal-bg)] text-[var(--color-terminal-fg)]">
        {children}
      </div>
    </div>
  )
}
