// desktop/src/components/settings/OfficialLoginRiskDialog.tsx
//
// Risk confirmation before an official-model OAuth login. Shared by every official login entry; only the risk level and body differ.

import { Badge, type Tone } from '@/components/ui/Badge'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useTranslation, type TranslationKey } from '../../i18n'

export type OfficialLoginRiskProvider = 'claude' | 'chatgpt' | 'grok' | 'deepseek'

type RiskCopy = {
  tone: Tone
  level: TranslationKey
  body: TranslationKey
}

const RISK_COPY: Record<OfficialLoginRiskProvider, RiskCopy> = {
  claude: {
    tone: 'danger',
    level: 'settings.officialLoginRisk.level.high',
    body: 'settings.officialLoginRisk.claude.body',
  },
  grok: {
    tone: 'warning',
    level: 'settings.officialLoginRisk.level.medium',
    body: 'settings.officialLoginRisk.grok.body',
  },
  deepseek: {
    tone: 'warning',
    level: 'settings.officialLoginRisk.level.medium',
    body: 'settings.officialLoginRisk.deepseek.body',
  },
  chatgpt: {
    tone: 'info',
    level: 'settings.officialLoginRisk.level.low',
    body: 'settings.officialLoginRisk.chatgpt.body',
  },
}

type OfficialLoginRiskDialogProps = {
  open: boolean
  provider: OfficialLoginRiskProvider
  onClose: () => void
  onConfirm: () => void
}

export function OfficialLoginRiskDialog({
  open,
  provider,
  onClose,
  onConfirm,
}: OfficialLoginRiskDialogProps) {
  const t = useTranslation()
  const copy = RISK_COPY[provider]

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      title={t('settings.officialLoginRisk.title')}
      confirmLabel={t('settings.officialLoginRisk.confirm')}
      cancelLabel={t('common.cancel')}
      confirmVariant="primary"
      body={(
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-[13px] text-[var(--color-text-secondary)]">
            {t('settings.officialLoginRisk.levelLabel')}
            <Badge tone={copy.tone} size="sm">{t(copy.level)}</Badge>
          </div>
          <p className="text-[13px] leading-6 text-[var(--color-text-secondary)]">
            {t(copy.body)}
          </p>
          <p className="text-[13px] leading-6 text-[var(--color-text-secondary)]">
            {t('settings.officialLoginRisk.advice')}
          </p>
        </div>
      )}
    />
  )
}
