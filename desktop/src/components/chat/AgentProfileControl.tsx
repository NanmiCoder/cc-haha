import { ChevronDown, Info, LockKeyhole } from 'lucide-react'
import { Tooltip } from '@/components/ui/Tooltip'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '@/i18n'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dropdown } from '@/components/ui/Dropdown'
import type { AgentProfile } from '@/types/session'

/** Only an uncreated conversation gets a selector. Existing sessions are immutable. */
export function AgentProfileControl({ value, onChange, disabled }: {
  value: AgentProfile
  onChange?: (value: AgentProfile) => void
  disabled?: boolean
}) {
  const t = useTranslation()
  if (!onChange && value !== 'lean') return null
  const locked = !onChange
  return (
    <div className="flex shrink-0 items-center gap-1">
      {onChange ? (
        <Dropdown<AgentProfile>
          label={t('agentProfile.label')}
          value={value}
          onChange={profile => { if (!disabled) onChange(profile) }}
          portal
          placement="top"
          align="right"
          width="min(300px, calc(100vw - 32px))"
          items={[
            { value: 'standard', label: t('agentProfile.standard'), description: t('agentProfile.standardSummary'), disabled },
            { value: 'lean', label: t('agentProfile.lean'), description: t('agentProfile.leanSummary'), disabled },
          ]}
          trigger={(
            <Button variant={value === 'lean' ? 'tonal' : 'ghost'} size="sm" disabled={disabled}
              aria-label={`${t('agentProfile.label')}: ${t(value === 'lean' ? 'agentProfile.lean' : 'agentProfile.standard')}`} title={t('agentProfile.draftHint')}
              icon={<ChevronDown size={13} strokeWidth={1.75} aria-hidden="true" />} iconPosition="end">
              {t(value === 'lean' ? 'agentProfile.lean' : 'agentProfile.standard')}
            </Button>
          )}
        />
      ) : (
        <Badge tone="neutral" title={t('agentProfile.locked')}
          icon={<LockKeyhole size={12} strokeWidth={1.75} aria-hidden="true" />}>
          {t('agentProfile.lean')}
        </Badge>
      )}
      <Tooltip delay={0} placement="top-end" content={(
        <div className="space-y-2 p-1">
          <p className="font-medium">{t('agentProfile.lean')}</p>
          <p>{t('agentProfile.leanSummary')}</p>
          <dl className="space-y-2">
            <div><dt className="font-medium">{t('agentProfile.availableLabel')}</dt><dd>{t('agentProfile.available')}</dd></div>
            <div><dt className="font-medium">{t('agentProfile.unavailableLabel')}</dt><dd>{t('agentProfile.unavailable')}</dd></div>
          </dl>
          <p>{t(locked ? 'agentProfile.locked' : 'agentProfile.draftHint')}</p>
        </div>
      )}>
        <IconButton icon={<Info size={15} strokeWidth={1.75} />} label={t('agentProfile.info')}
          showTooltip={false} size="sm" onClick={event => event.currentTarget.focus()} />
      </Tooltip>
    </div>
  )
}
