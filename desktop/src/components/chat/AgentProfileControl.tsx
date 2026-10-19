import { forwardRef, useImperativeHandle, useState } from 'react'
import { Check, ChevronDown, Info, LockKeyhole } from 'lucide-react'
import { Tooltip } from '@/components/ui/Tooltip'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '@/i18n'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dropdown } from '@/components/ui/Dropdown'
import { MobileBottomSheet } from '@/components/ui/MobileBottomSheet'
import { COMPOSER_MENU_ITEM, COMPOSER_MENU_ITEM_ACTIVE } from '@/components/chat/composerMenuStyles'
import type { AgentProfile } from '@/types/session'

export type AgentProfileControlHandle = {
  /**
   * Opens the sheet of `presentation="sheet"`: the choices while the mode can
   * still be picked, what the mode includes once it is locked. Nothing opens
   * for a standard conversation, which has nothing to explain.
   */
  open: () => void
}

type Props = {
  value: AgentProfile
  onChange?: (value: AgentProfile) => void
  disabled?: boolean
  /**
   * `toolbar` is the composer row's chip (or locked badge) with its info
   * button. `sheet` puts nothing on the row: a phone has no width to spare, so
   * its "+" sheet carries a row for the mode and calls `open()` on this.
   */
  presentation?: 'toolbar' | 'sheet'
}

/**
 * What lean includes and gives up, and when the choice is made. `intro` names
 * the mode and sums it up; a sheet that lists the choices above already does.
 */
function ProfileDetails({ locked, intro }: { locked: boolean; intro: boolean }) {
  const t = useTranslation()
  return (
    <>
      {intro && (
        <>
          <p className="font-medium">{t('agentProfile.lean')}</p>
          <p>{t('agentProfile.leanSummary')}</p>
        </>
      )}
      <dl className="space-y-2">
        <div><dt className="font-medium">{t('agentProfile.availableLabel')}</dt><dd>{t('agentProfile.available')}</dd></div>
        <div><dt className="font-medium">{t('agentProfile.unavailableLabel')}</dt><dd>{t('agentProfile.unavailable')}</dd></div>
      </dl>
      <p>{t(locked ? 'agentProfile.locked' : 'agentProfile.draftHint')}</p>
    </>
  )
}

/** Only an uncreated conversation gets a selector. Existing sessions are immutable. */
export const AgentProfileControl = forwardRef<AgentProfileControlHandle, Props>(function AgentProfileControl({
  value,
  onChange,
  disabled,
  presentation = 'toolbar',
}, handleRef) {
  const t = useTranslation()
  const [sheetOpen, setSheetOpen] = useState(false)
  const locked = !onChange
  const hasContent = !locked || value === 'lean'
  useImperativeHandle(handleRef, () => ({
    open: () => { if (hasContent) setSheetOpen(true) },
  }), [hasContent])
  if (!hasContent) return null

  if (presentation === 'sheet') {
    const choices: Array<{ profile: AgentProfile; label: string; summary: string }> = [
      { profile: 'standard', label: t('agentProfile.standard'), summary: t('agentProfile.standardSummary') },
      { profile: 'lean', label: t('agentProfile.lean'), summary: t('agentProfile.leanSummary') },
    ]
    const close = () => setSheetOpen(false)
    return (
      <MobileBottomSheet
        open={sheetOpen}
        onClose={close}
        title={t('agentProfile.label')}
        closeLabel={t('common.close')}
        testId="agent-profile-sheet"
        contentClassName="p-2"
      >
        {onChange ? (
          <div role="radiogroup" aria-label={t('agentProfile.label')} className="space-y-1">
            {choices.map(choice => (
              <button
                key={choice.profile}
                type="button"
                role="radio"
                aria-checked={value === choice.profile}
                disabled={disabled}
                onClick={() => { onChange(choice.profile); close() }}
                className={`${COMPOSER_MENU_ITEM} min-h-12 items-start py-2.5 disabled:cursor-not-allowed disabled:opacity-50 ${value === choice.profile ? COMPOSER_MENU_ITEM_ACTIVE : ''}`}
              >
                <span className="grid min-w-0 flex-1 gap-px">
                  <span className="font-medium">{choice.label}</span>
                  <span className="text-xs text-[var(--color-text-tertiary)]">{choice.summary}</span>
                </span>
                {value === choice.profile && (
                  <Check size={14} strokeWidth={2} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--color-brand)]" />
                )}
              </button>
            ))}
          </div>
        ) : null}
        <div className={`space-y-2 px-2 pb-1 text-xs leading-relaxed text-[var(--color-text-secondary)] ${onChange ? 'mt-2 border-t border-[var(--color-border)] pt-3' : 'pt-1'}`}>
          <ProfileDetails locked={locked} intro={locked} />
        </div>
      </MobileBottomSheet>
    )
  }

  return (
    <div data-testid="agent-profile-control" className="flex shrink-0 items-center gap-1">
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
            // The chip carries the short name: the toolbar shares its width
            // with the project, branch and model, and "experimental" is still
            // on the menu row and in the explanation behind the info button.
            <Button variant={value === 'lean' ? 'tonal' : 'ghost'} size="sm" disabled={disabled}
              aria-label={`${t('agentProfile.label')}: ${t(value === 'lean' ? 'agentProfile.lean' : 'agentProfile.standard')}`} title={t('agentProfile.draftHint')}
              icon={<ChevronDown size={13} strokeWidth={1.75} aria-hidden="true" />} iconPosition="end">
              {t(value === 'lean' ? 'agentProfile.leanShort' : 'agentProfile.standard')}
            </Button>
          )}
        />
      ) : (
        <Badge tone="neutral" title={t('agentProfile.locked')}
          icon={<LockKeyhole size={12} strokeWidth={1.75} aria-hidden="true" />}>
          {t('agentProfile.leanShort')}
        </Badge>
      )}
      <Tooltip delay={0} placement="top-end" content={(
        <div className="space-y-2 p-1">
          <ProfileDetails locked={locked} intro />
        </div>
      )}>
        <IconButton icon={<Info size={15} strokeWidth={1.75} />} label={t('agentProfile.info')}
          showTooltip={false} size="sm" onClick={event => event.currentTarget.focus()} />
      </Tooltip>
    </div>
  )
})
