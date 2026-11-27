import { Globe, X } from 'lucide-react'
import { useTranslation } from '@/i18n'
import { ActionDialog } from '@/components/ui/ActionDialog'
import type { BrowserPreferredTarget } from '@/api/browserUse'

type Props = {
  open: boolean
  loading?: boolean
  onClose: () => void
  onConfirm: () => void | Promise<void>
}

export function BrowserUseEnableDialog({
  open,
  loading = false,
  onClose,
  onConfirm,
}: Props) {
  const t = useTranslation()

  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      title={t('settings.browserUse.enableDialogTitle')}
      width={480}
      loading={loading}
      body={(
        <div className="space-y-4 text-[13px] leading-[1.6] text-[var(--color-text-secondary)]">
          <div className="flex items-start gap-2.5 rounded-[var(--radius-md)] bg-[var(--color-info-container)] px-3 py-2.5 text-[var(--color-on-info-container)]">
            <Globe size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
            <p className="font-medium">{t('settings.browserUse.enableDialogSummary')}</p>
          </div>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>{t('settings.browserUse.enableDialogWorkspace')}</li>
            <li>{t('settings.browserUse.enableDialogChrome')}</li>
            <li>{t('settings.browserUse.enableDialogTakeover')}</li>
          </ul>
          <p className="rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2 text-xs leading-[1.5] text-[var(--color-text-tertiary)]">
            {t('settings.browserUse.enableDialogNoOsPerms')}
          </p>
        </div>
      )}
      actions={[
        {
          label: t('common.cancel'),
          onClick: onClose,
          variant: 'secondary',
        },
        {
          label: t('settings.browserUse.enableDialogConfirm'),
          onClick: onConfirm,
          variant: 'primary',
          loading,
        },
      ]}
    />
  )
}

const TARGET_CYCLE: readonly BrowserPreferredTarget[] = ['auto', 'workspace', 'chrome']

/**
 * Compact target selector chip rendered in both composers only while Browser
 * Use is enabled. Clicking the target label cycles Auto -> Workspace -> Chrome;
 * the trailing close button turns Browser Use off in one click.
 */
export function BrowserUseTargetPill({
  target,
  onChange,
  onDisable,
  touch = false,
}: {
  target: BrowserPreferredTarget
  onChange: (next: BrowserPreferredTarget) => void
  onDisable: () => void
  touch?: boolean
}) {
  const t = useTranslation()
  const labelKey = target === 'workspace'
    ? 'settings.browserUse.targetWorkspace'
    : target === 'chrome'
      ? 'settings.browserUse.targetChrome'
      : 'settings.browserUse.targetAuto'
  const nextTarget = TARGET_CYCLE[(TARGET_CYCLE.indexOf(target) + 1) % TARGET_CYCLE.length] ?? 'auto'

  return (
    <span
      data-testid="browser-use-target-pill"
      className={`control-bevel inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-info-container)] pl-2 text-xs font-medium text-[var(--color-on-info-container)] ${touch ? 'h-9' : 'h-6'}`}
    >
      <button
        type="button"
        onClick={() => onChange(nextTarget)}
        aria-label={t('chat.capabilities.browserUseTargetCycle', { target: t(labelKey) })}
        title={t('chat.capabilities.browserUseTargetCycle', { target: t(labelKey) })}
        className="inline-flex items-center gap-1 rounded-[var(--radius-xs)] pr-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]"
      >
        <Globe size={12} strokeWidth={1.75} aria-hidden="true" />
        <span>{t('chat.capabilities.browserUseShort')}</span>
        <span className="opacity-75">· {t(labelKey)}</span>
      </button>
      <button
        type="button"
        onClick={onDisable}
        aria-label={t('chat.capabilities.browserUseDisable')}
        title={t('chat.capabilities.browserUseDisable')}
        className={`inline-flex items-center justify-center rounded-[var(--radius-xs)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] ${touch ? 'h-9 w-9' : 'h-6 w-6'}`}
      >
        <X size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </span>
  )
}
