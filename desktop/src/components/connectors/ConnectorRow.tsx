import { useState, type ReactNode } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import { Badge, type Tone } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/IconButton'

export function ConnectorRow({ id, name, description, kind, status, statusTone = 'neutral', actionLabel, added, onDetails, onAction, action }: {
  action?: ReactNode
  id: string
  name: string
  description: string
  kind?: string
  status?: string
  /** The app-wide status vocabulary: working = info, needs you = warning, usable = success. */
  statusTone?: Tone
  actionLabel: string
  added: boolean
  onDetails: () => void
  onAction: () => void
}) {
  const [failedIcon, setFailedIcon] = useState(false)
  // White card on a hairline; hover only deepens the edge — no lift.
  return <article className="flex min-h-[104px] items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-4 transition-colors duration-150 hover:border-[var(--color-outline)]">
    <button type="button" aria-label={name} onClick={onDetails} className="flex min-w-0 flex-1 items-start gap-3 rounded-[var(--radius-sm)] text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]">
      <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-md)] text-[15px] font-medium text-[var(--color-text-secondary)]">
        {failedIcon ? <span className="flex h-full w-full items-center justify-center bg-[var(--color-surface-container)]">{name.slice(0, 1)}</span> : <img src={`${import.meta.env.BASE_URL}connectors/${id}.svg`} alt="" className="h-10 w-10 object-contain" onError={() => setFailedIcon(true)} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2"><span className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{name}</span>{kind && <Badge variant="outline" size="xs">{kind}</Badge>}</span>
        <span className="mt-1 block line-clamp-2 text-xs leading-[18px] text-[var(--color-text-secondary)]">{description}</span>
        {status && <Badge tone={statusTone} size="xs" className="mt-2">{status}</Badge>}
      </span>
    </button>
    {action ?? <IconButton label={actionLabel} size="md" tone="secondary" bordered onClick={onAction} icon={added ? <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" /> : <Plus size={16} strokeWidth={1.75} aria-hidden="true" />} />}
  </article>
}
