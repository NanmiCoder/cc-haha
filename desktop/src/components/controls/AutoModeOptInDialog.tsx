import { TriangleAlert } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { ActionDialog } from '@/components/ui/ActionDialog'

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
          {/* Warning tones are paired: `--color-warning` is the marker (icon,
              border) and `--color-on-warning-container` is the only readable
              foreground on the container fill. The `/N` alpha this replaced is
              also dropped outright by the Safari 15 WebView. */}
          <div className="flex items-start gap-3 rounded-[var(--radius-md)] bg-[var(--color-warning-container)] px-3 py-3">
            <TriangleAlert aria-hidden="true" size={16} strokeWidth={1.75} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
            <div className="space-y-2 text-[13px] leading-6 text-[var(--color-on-warning-container)]">
              <p className="font-medium">{t('permMode.enableAutoBody')}</p>
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
