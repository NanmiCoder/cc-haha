import { useState } from 'react'
import { Waypoints, X } from 'lucide-react'

import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '../../i18n'
import { useMagpieStore } from '../../stores/magpieStore'
import type { SavedProvider } from '../../types/provider'

/**
 * Shown at the top of the API Key list only while Magpie runs on this
 * computer and is not connected yet; × hides it for good.
 */
export function MagpieConnectBanner({ modelCount, onConnect }: { modelCount: number; onConnect: () => void }) {
  const t = useTranslation()
  const dismiss = useMagpieStore((store) => store.dismissBanner)
  return (
    <div
      data-testid="magpie-connect-banner"
      className="mt-4 flex items-center gap-3 rounded-[var(--radius-lg)] bg-[var(--color-surface-container)] py-3.5 pl-4 pr-3"
    >
      <span
        aria-hidden="true"
        className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)]"
      >
        <Waypoints size={18} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
          {t('settings.providers.magpie.bannerTitle')}
          <Badge tone="success">{t('settings.providers.magpie.bannerDetected')}</Badge>
        </div>
        <p className="mt-0.5 text-xs leading-[18px] text-[var(--color-text-tertiary)]">
          {t('settings.providers.magpie.bannerBody', { count: modelCount })}
        </p>
      </div>
      <Button size="base" onClick={onConnect}>{t('settings.providers.magpie.connect')}</Button>
      <IconButton
        icon={<X size={14} strokeWidth={1.75} />}
        label={t('settings.providers.magpie.dismiss')}
        size="sm"
        tone="muted"
        onClick={dismiss}
      />
    </div>
  )
}

/** Whether the saved Magpie provider's gateway answers right now. */
export function MagpieStatusLine() {
  const t = useTranslation()
  const state = useMagpieStore((store) => store.state)
  const openApp = useMagpieStore((store) => store.open)
  const refresh = useMagpieStore((store) => store.refresh)
  const [openUnsupported, setOpenUnsupported] = useState(false)
  if (!state) return null

  if (state.status.running) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-[var(--color-text-tertiary)]">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-[var(--color-success)]" />
        {t('settings.providers.magpie.running', { count: state.models?.length ?? 0 })}
      </p>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-secondary)]">
      <Badge tone="warning">{t('settings.providers.magpie.notRunningBadge')}</Badge>
      <span className="min-w-0 flex-1">
        {t(openUnsupported ? 'settings.providers.magpie.openAppManually' : 'settings.providers.magpie.notRunningBody')}
      </span>
      {!openUnsupported && (
        <Button
          variant="secondary"
          size="sm"
          onClick={async () => {
            const result = await openApp()
            if (result.unsupported) setOpenUnsupported(true)
            else void refresh({ force: true })
          }}
        >
          {t('settings.providers.magpie.openApp')}
        </Button>
      )}
    </div>
  )
}

/** The default Magpie provider's two choices: the main model and the background one. */
export function MagpieModelChips({ provider }: { provider: SavedProvider }) {
  const t = useTranslation()
  const main = provider.models.main
  const background = provider.models.haiku && provider.models.haiku !== main ? provider.models.haiku : null
  const chip = 'inline-flex h-6 max-w-full items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--color-surface-container)] px-2 text-[11px] text-[var(--color-text-tertiary)]'
  return (
    <div className="flex flex-wrap gap-1.5">
      <span className={chip}>
        <span className="shrink-0">{t('settings.providers.mainModel')}</span>
        <span className="min-w-0 truncate font-mono text-[var(--color-text-primary)]">{main}</span>
      </span>
      <span className={chip}>
        <span className="shrink-0">{t('settings.providers.magpie.backgroundChip')}</span>
        {background
          ? <span className="min-w-0 truncate font-mono text-[var(--color-text-primary)]">{background}</span>
          : <span className="text-[var(--color-text-primary)]">{t('settings.providers.magpie.sameAsMain')}</span>}
      </span>
    </div>
  )
}
