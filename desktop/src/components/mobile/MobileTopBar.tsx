import type { ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { IconButton } from '@/components/ui/IconButton'
import { MobileAttentionDot } from '../layout/MobileAttentionDot'

type Props = {
  title: string
  subtitle?: ReactNode
  /** Absent on a page with nothing above it (the tablet's session pane). */
  onBack?: () => void
  backLabel?: string
  /** The session on screen, so the dot on Back only counts the others. */
  activeSessionId?: string | null
  trailing?: ReactNode
}

/**
 * The bar above every page that is not home: Back on the left, the page's
 * name, and room on the right for page actions. Back carries the dot that
 * says another session is waiting, because the list it returns to is where
 * that session is.
 */
export function MobileTopBar({ title, subtitle, onBack, backLabel, activeSessionId = null, trailing }: Props) {
  const t = useTranslation()
  return (
    <div
      data-testid="mobile-top-bar"
      className="flex min-h-14 shrink-0 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface)] py-1 pl-1 pr-2"
    >
      {onBack ? (
        <span className="relative inline-flex shrink-0">
          <IconButton
            data-testid="mobile-back"
            size="2xl"
            tone="secondary"
            icon={<ChevronLeft size={22} strokeWidth={1.75} aria-hidden="true" />}
            label={backLabel ?? t('mobile.nav.back')}
            onClick={onBack}
          />
          <MobileAttentionDot activeSessionId={activeSessionId} />
        </span>
      ) : (
        <span className="w-3 shrink-0" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[15px] font-semibold leading-tight text-[var(--color-text-primary)]">{title}</h1>
        {subtitle ? (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[12px] text-[var(--color-text-tertiary)]">
            {subtitle}
          </div>
        ) : null}
      </div>
      {trailing ? <div className="flex shrink-0 items-center gap-1">{trailing}</div> : null}
    </div>
  )
}
