import { useTranslation } from '@/i18n'
import { ActionDialog } from '@/components/ui/ActionDialog'

type Props = {
  open: boolean
  loading?: boolean
  platform: 'darwin' | 'win32'
  onClose: () => void
  onConfirm: () => void | Promise<void>
}

export function ComputerUseEnableDialog({
  open,
  loading = false,
  platform,
  onClose,
  onConfirm,
}: Props) {
  const t = useTranslation()

  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      title={t('settings.computerUse.enableRiskTitle')}
      width={500}
      loading={loading}
      body={(
        <div className="space-y-4 text-sm leading-6 text-[var(--color-text-secondary)]">
          <div className="flex items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] px-3 py-3 text-[var(--color-on-warning-container)]">
            <span className="material-symbols-outlined mt-0.5 text-[20px] text-[var(--color-warning)]">warning</span>
            <p className="font-semibold">{t('settings.computerUse.enableRiskSummary')}</p>
          </div>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>{t('settings.computerUse.enableRiskScreen')}</li>
            <li>{t('settings.computerUse.enableRiskActions')}</li>
            <li>{t('settings.computerUse.enableRiskAllApps')}</li>
            <li>{t('settings.computerUse.enableRiskStop')}</li>
          </ul>
          {platform === 'darwin' && (
            <p className="rounded-[var(--radius-lg)] bg-[var(--color-surface-container-low)] px-3 py-2 text-xs text-[var(--color-text-tertiary)]">
              {t('settings.computerUse.enableRiskMacos')}
            </p>
          )}
        </div>
      )}
      actions={[
        {
          label: t('common.cancel'),
          onClick: onClose,
          variant: 'secondary',
        },
        {
          label: t('settings.computerUse.enableRiskConfirm'),
          onClick: onConfirm,
          variant: 'primary',
          loading,
        },
      ]}
    />
  )
}
