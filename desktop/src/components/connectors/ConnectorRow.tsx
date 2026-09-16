import { useState, type ReactNode } from 'react'
import { IconButton } from '@/components/ui/IconButton'

export function ConnectorRow({ id, name, description, kind, status, actionLabel, added, onDetails, onAction, action }: {
  action?: ReactNode
  id: string
  name: string
  description: string
  kind?: string
  status?: string
  actionLabel: string
  added: boolean
  onDetails: () => void
  onAction: () => void
}) {
  const [failedIcon, setFailedIcon] = useState(false)
  return <article className="flex min-h-24 items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 transition-colors hover:bg-[var(--color-surface-hover)]">
    <button type="button" aria-label={name} onClick={onDetails} className="flex min-w-0 flex-1 items-start gap-3 rounded-[var(--radius-sm)] text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]">
      <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center text-lg font-medium text-[var(--color-text-secondary)]">
        {failedIcon ? name.slice(0, 1) : <img src={`${import.meta.env.BASE_URL}connectors/${id}.svg`} alt="" className="h-10 w-10 object-contain" onError={() => setFailedIcon(true)} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"><span className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{name}</span>{kind && <span className="rounded-[var(--radius-sm)] border border-[var(--color-border)] px-1 text-[10px] leading-4 text-[var(--color-text-tertiary)]">{kind}</span>}</span>
        <span className="mt-1 block line-clamp-2 text-xs leading-5 text-[var(--color-text-secondary)]">{description}</span>
        {status && <span className="mt-1 block text-[10px] leading-4 text-[var(--color-text-tertiary)]">{status}</span>}
      </span>
    </button>
    {action ?? <IconButton label={actionLabel} size="md" shape="circle" tone="secondary" bordered onClick={onAction} icon={<svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{added ? <path d="m7 5 5 5-5 5" /> : <path d="M10 4v12M4 10h12" />}</svg>} />}
  </article>
}
