import { forwardRef, useImperativeHandle, useState } from 'react'
import { Check } from 'lucide-react'
import { useTranslation } from '@/i18n'
import { MobileBottomSheet } from '@/components/ui/MobileBottomSheet'
import { COMPOSER_MENU_ITEM, COMPOSER_MENU_ITEM_ACTIVE } from '@/components/chat/composerMenuStyles'
import type { AgentProfile } from '@/types/session'

export type AgentProfileControlHandle = {
  /**
   * Opens the sheet: the choices while the mode can still be picked, what the
   * mode includes once it is locked. Nothing opens for a standard conversation,
   * which has nothing to explain.
   */
  open: () => void
}

type Props = {
  value: AgentProfile
  onChange?: (value: AgentProfile) => void
  disabled?: boolean
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

/**
 * The phone's Agent mode sheet, opened from a row in the "+" sheet. The desktop
 * has no such control: its "+" menu carries the same choice as a row, and the
 * toolbar only marks a lean conversation.
 *
 * Only an uncreated conversation gets a selector. Existing sessions are immutable.
 */
export const AgentProfileControl = forwardRef<AgentProfileControlHandle, Props>(function AgentProfileControl({
  value,
  onChange,
  disabled,
}, handleRef) {
  const t = useTranslation()
  const [sheetOpen, setSheetOpen] = useState(false)
  const locked = !onChange
  const hasContent = !locked || value === 'lean'
  useImperativeHandle(handleRef, () => ({
    open: () => { if (hasContent) setSheetOpen(true) },
  }), [hasContent])
  if (!hasContent) return null

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
})
