import type { ReactNode } from 'react'
import { ChevronLeft, PanelLeft } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { IconButton } from '@/components/ui/IconButton'
import { MobileAttentionDot } from '../layout/MobileAttentionDot'

type Props = {
  title: string
  subtitle?: ReactNode
  /** Absent on a page with nothing above it (the tablet's session pane). */
  onBack?: () => void
  onMenu?: () => void
  backLabel?: string
  /** The session on screen, so the dot on Back only counts the others. */
  activeSessionId?: string | null
  trailing?: ReactNode
}

/**
 * Shared chat/page bar. The leading menu opens sessions without navigating;
 * nested pages use Back. The attention dot still points to waiting sessions.
 */
export function MobileTopBar({ title, subtitle, onBack, onMenu, backLabel, activeSessionId = null, trailing }: Props) {
  const t = useTranslation()
  return (
    <div
      data-testid="mobile-top-bar"
      className="flex min-h-14 shrink-0 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface)] py-1 pl-1 pr-2"
    >
      {onBack || onMenu ? (
        <span className="relative inline-flex shrink-0">
          <IconButton
            data-testid={onMenu ? 'mobile-open-sessions' : 'mobile-back'}
            size="2xl"
            tone="secondary"
            icon={onMenu ? <PanelLeft size={22} strokeWidth={1.75} aria-hidden="true" /> : <ChevronLeft size={22} strokeWidth={1.75} aria-hidden="true" />}
            label={onMenu ? t('mobile.home.title') : backLabel ?? t('mobile.nav.back')}
            onClick={onMenu ?? onBack}
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
