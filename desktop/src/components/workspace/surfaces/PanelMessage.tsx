import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Spinner } from '@/components/ui/Spinner'

export function PanelMessage({
  icon: Icon,
  busy = false,
  message,
  tone = 'muted',
  compact = false,
  announce = true,
  action,
}: {
  /** A lucide icon for the state. Ignored while `busy`, which shows a spinner. */
  icon?: LucideIcon
  /** The state is work in progress (loading, searching): spin instead of an icon. */
  busy?: boolean
  message: string
  tone?: 'muted' | 'error'
  compact?: boolean
  announce?: boolean
  /**
   * A way out of the state the message describes — "open in the system app" on a
   * file that cannot be previewed. Rendered beside, not inside, the live region:
   * a screen reader announces the message, not the button as part of it.
   */
  action?: ReactNode
}) {
  const role = announce ? tone === 'error' ? 'alert' : 'status' : undefined
  const glyph = busy
    ? <Spinner size={compact ? 12 : 16} />
    : Icon ? <Icon size={compact ? 14 : 16} strokeWidth={1.75} aria-hidden="true" className="shrink-0" /> : null

  // Inside a list or a card: one quiet line, no icon tile.
  if (compact) {
    const row = (
      <div
        className={`flex items-center gap-2 px-4 ${action ? 'pt-2 pb-1' : 'py-2'} text-[12px] ${tone === 'error' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-tertiary)]'}`}
        role={role}
      >
        {glyph}
        <span className="min-w-0 leading-[1.5]">{message}</span>
      </div>
    )
    if (!action) return row
    return (
      <div>
        {row}
        {/* Indented to the message text: 16px padding + 14px icon + 8px gap. */}
        <div className="flex flex-wrap items-center gap-2 pb-2 pl-[38px] pr-4">{action}</div>
      </div>
    )
  }

  // A whole panel in one state: centred, an icon tile over the sentence.
  const messageBlock = (
    <div
      className={`flex flex-col items-center gap-3 px-6 text-center ${action ? 'pt-8 pb-3' : 'py-8'} ${tone === 'error' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-secondary)]'}`}
      role={role}
    >
      {glyph ? (
        <span
          aria-hidden="true"
          className={`flex h-9 w-9 items-center justify-center rounded-[var(--radius-md)] ${tone === 'error'
            ? 'bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
            : 'bg-[var(--color-surface-container)] text-[var(--color-text-tertiary)]'}`}
        >
          {glyph}
        </span>
      ) : null}
      <span className="max-w-[420px] text-[13px] leading-[1.6]">
        {message}
      </span>
    </div>
  )

  if (!action) return messageBlock

  return (
    <div>
      {messageBlock}
      <div className="flex flex-wrap items-center justify-center gap-2 px-6 pb-8">{action}</div>
    </div>
  )
}
