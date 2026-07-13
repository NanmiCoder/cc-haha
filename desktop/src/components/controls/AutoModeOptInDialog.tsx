import { useTranslation } from '../../i18n'
import { ActionDialog } from '../shared/ActionDialog'

type Props = {
  open: boolean
  loading?: boolean
  onClose: () => void
  onConfirm: () => void | Promise<void>
}

export function AutoModeOptInDialog({ open, loading = false, onClose, onConfirm }: Props) {
  const t = useTranslation()

  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      title={t('permMode.enableAutoTitle')}
      width={460}
      loading={loading}
      body={(
        <div className="space-y-3">
          <div className="flex items-start gap-3 rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 px-3 py-3">
            <span className="material-symbols-outlined mt-0.5 text-[20px] text-[var(--color-warning)]">warning</span>
            <div className="space-y-2 text-sm leading-6 text-[var(--color-text-secondary)]">
              <p className="font-medium text-[var(--color-text-primary)]">{t('permMode.enableAutoBody')}</p>
              <p>{t('permMode.enableAutoDetail')}</p>
            </div>
          </div>
        </div>
      )}
      actions={[
        {
          label: t('common.cancel'),
          onClick: onClose,
          variant: 'secondary',
        },
        {
          label: t('permMode.enableAutoBtn'),
          onClick: onConfirm,
          variant: 'primary',
          loading,
        },
      ]}
    />
  )
}
