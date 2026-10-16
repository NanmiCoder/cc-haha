import { useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { useTranslation } from '@/i18n'
import { ActionDialog } from '@/components/ui/ActionDialog'
import { Checkbox } from '@/components/ui/Checkbox'

type Props = {
  open: boolean
  /**
   * Offer the "don't remind me again" checkbox. Only the composer's per-message
   * switch passes this: it is armed again for every message, while the Settings
   * switch is a rare, deliberate change that should always be confirmed.
   */
  allowDismiss?: boolean
  onClose: () => void
  onConfirm: (options: { dontRemind: boolean }) => void | Promise<void>
}

/**
 * Shown before Agent Teams is turned on, from Settings and from the composer.
 * One component so both entries say exactly the same thing.
 */
export function AgentTeamsCostDialog({ open, allowDismiss = false, onClose, onConfirm }: Props) {
  const t = useTranslation()
  const [dontRemind, setDontRemind] = useState(false)

  useEffect(() => {
    if (open) setDontRemind(false)
  }, [open])

  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      title={t('agentTeams.notice.title')}
      width={480}
      body={(
        <div className="space-y-4 text-[13px] leading-[1.6] text-[var(--color-text-secondary)]">
          <div className="flex items-start gap-2.5 rounded-[var(--radius-md)] bg-[var(--color-warning-container)] px-3 py-2.5 text-[var(--color-on-warning-container)]">
            <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
            <p className="font-medium">{t('agentTeams.notice.intro')}</p>
          </div>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>{t('agentTeams.notice.tokens')}</li>
            <li>{t('agentTeams.notice.slow')}</li>
            <li>{t('agentTeams.notice.scope')}</li>
          </ul>
          {allowDismiss && (
            <Checkbox
              size="sm"
              label={t('agentTeams.notice.dontRemind')}
              checked={dontRemind}
              onChange={(event) => setDontRemind(event.target.checked)}
            />
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
          label: t('agentTeams.notice.confirm'),
          onClick: () => onConfirm({ dontRemind: allowDismiss && dontRemind }),
          variant: 'primary',
        },
      ]}
    />
  )
}
