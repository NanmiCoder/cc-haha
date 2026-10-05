import { useEffect, useState } from 'react'
import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { NormalizedSkill, NormalizedSkillDetail } from '../../types/market'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Modal } from '@/components/ui/Modal'
import { CAPABILITY_LEVEL_TONES, capabilityText, useSkillInsights } from './CapabilityPanel'
import { SecurityBadge } from './SecurityBadge'

const RISK_KEYS = {
  verified: 'market.installConfirm.riskVerified',
  benign: 'market.installConfirm.riskBenign',
  unknown: 'market.installConfirm.riskUnknown',
  flagged: 'market.installConfirm.riskFlagged',
} as const

/**
 * Install confirmation.
 *
 * A skill that did not scan clean (flagged or unknown) needs an explicit
 * acknowledgement before the confirm button arms: installing is a trust
 * decision about a third party, and the dialog makes it one rather than a
 * reflex click. The acknowledgement belongs to one skill and one opening, so
 * it resets whenever either changes.
 *
 * When the dialog is opened from the detail page the skill's files are known,
 * and with them what it will be able to do; from a catalog card they are not,
 * and the list is simply absent rather than guessed.
 */
export function InstallConfirmDialog({
  skill,
  detail,
  open,
  installing,
  onConfirm,
  onClose,
}: {
  skill: NormalizedSkill | null
  /** The loaded detail for this skill, when there is one. */
  detail?: NormalizedSkillDetail | null
  open: boolean
  installing: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const t = useTranslation()
  const [acknowledged, setAcknowledged] = useState(false)
  const { capabilities } = useSkillInsights(detail && skill && detail.id === skill.id ? detail : null)
  const skillId = skill?.id

  useEffect(() => {
    setAcknowledged(false)
  }, [skillId, open])

  if (!skill) return null

  const risky = skill.securityStatus === 'flagged' || skill.securityStatus === 'unknown'
  const armed = !risky || acknowledged
  const RiskIcon =
    skill.securityStatus === 'flagged' ? ShieldAlert : risky ? ShieldQuestion : ShieldCheck

  return (
    <Modal open={open} onClose={installing ? () => {} : onClose} title={t('market.installConfirm.title')} width={480}>
      <div className="flex flex-col gap-4" data-testid="market-install-confirm">
        <p className="text-[13px] leading-5 text-[var(--color-text-primary)]">
          {t('market.installConfirm.message', { name: skill.name, source: t(`market.source.${skill.source}`) })}
        </p>

        <div className="flex flex-col gap-2 rounded-[var(--radius-md)] bg-[var(--color-surface-container)] px-3 py-2.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[var(--color-text-tertiary)]">{t('market.filter.source')}</span>
            <span className="font-medium text-[var(--color-text-primary)]">{t(`market.source.${skill.source}`)}</span>
          </div>
          {skill.version && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[var(--color-text-tertiary)]">{t('market.detail.version')}</span>
              <span className="font-mono text-[var(--color-text-primary)]">v{skill.version}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[var(--color-text-tertiary)]">{t('market.filter.security')}</span>
            <SecurityBadge status={skill.securityStatus} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[var(--color-text-tertiary)]">{t('market.installConfirm.location')}</span>
            <span className="truncate font-mono text-[11px] text-[var(--color-text-secondary)]">
              …/skills/{skill.slug.toLowerCase()}/
            </span>
          </div>
        </div>

        {/* Tone pairs, not alpha: `--color-<tone>-container` with its own
            `--color-on-<tone>-container` foreground. The `/40` modifiers this
            carried compile to a color function Safari 15 WebViews drop. */}
        <div
          className={`flex items-start gap-2 rounded-[var(--radius-md)] px-3 py-2 text-xs leading-5 ${
            skill.securityStatus === 'flagged'
              ? 'bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
              : risky
                ? 'bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]'
                : 'bg-[var(--color-success-container)] text-[var(--color-on-success-container)]'
          }`}
        >
          <RiskIcon className="mt-0.5 flex-shrink-0" size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>{t(RISK_KEYS[skill.securityStatus])}</span>
        </div>

        {capabilities.length > 0 && (
          <section data-testid="market-install-capabilities">
            <h3 className="text-[13px] font-semibold text-[var(--color-text-primary)]">
              {t('market.installConfirm.willGet')}
            </h3>
            <ul className="mt-2 divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
              {capabilities.map((capability) => {
                const text = capabilityText(t, capability)
                return (
                  <li key={capability.kind} className="flex items-center gap-3 px-3 py-2">
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-[13px] text-[var(--color-text-primary)]">{text.title}</span>
                      <span className="truncate font-mono text-[11px] text-[var(--color-text-tertiary)]" title={text.detail}>
                        {text.detail}
                      </span>
                    </span>
                    <Badge tone={CAPABILITY_LEVEL_TONES[capability.level]} size="xs">
                      {t(`market.cap.level.${capability.level}`)}
                    </Badge>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">{t('market.installConfirm.effectNote')}</p>

        {risky && (
          <Checkbox
            data-testid="market-install-ack"
            label={t('market.installConfirm.ack')}
            checked={acknowledged}
            disabled={installing}
            onChange={(event) => setAcknowledged(event.currentTarget.checked)}
          />
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="secondary" size="base" disabled={installing} onClick={onClose}>
            {t('market.installConfirm.cancel')}
          </Button>
          {/* `primary` is the ink confirm; the flagged path keeps its solid
              red through `danger`. */}
          <Button
            variant={skill.securityStatus === 'flagged' ? 'danger' : 'primary'}
            size="base"
            data-testid="market-install-confirm-button"
            loading={installing}
            disabled={!armed}
            onClick={onConfirm}
          >
            {installing ? t('market.install.installing') : t('market.installConfirm.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
