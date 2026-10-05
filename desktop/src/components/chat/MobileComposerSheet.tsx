import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from '@/i18n'
import { MobileBottomSheet } from '@/components/ui/MobileBottomSheet'
import type { NewComposerMention } from '@/lib/composerMentions'
import { ComposerCapabilityMenu } from './ComposerCapabilityMenu'
import type { CapabilityAction, CapabilityMenuSection } from './capabilityMenuModel'

export type MobileComposerSetting = {
  key: string
  icon: ReactNode
  label: string
  /** The current choice, shown on the right of the row. */
  value?: ReactNode
  disabled?: boolean
  onSelect: () => void
}

type Props = {
  open: boolean
  onClose: () => void
  menuId: string
  settings: MobileComposerSetting[]
  sections: CapabilityMenuSection[]
  cwd?: string
  referencesLoading?: boolean
  referencesError?: string | boolean | null
  onSelectFile?: (mention: NewComposerMention) => void
  onAction: (action: CapabilityAction) => void
}

/**
 * What the phone composer's + opens: the session's settings that left the
 * toolbar (permission mode, context usage, model) on top, then the same
 * capability menu the desktop + shows — attachments, files, skills, commands —
 * laid out for a finger. A setting row closes this sheet and opens that
 * control's own sheet, so two sheets never stack.
 */
export function MobileComposerSheet({
  open,
  onClose,
  menuId,
  settings,
  sections,
  cwd,
  referencesLoading,
  referencesError,
  onSelectFile,
  onAction,
}: Props) {
  const t = useTranslation()
  return (
    <MobileBottomSheet
      open={open}
      onClose={onClose}
      title={t('chat.mobileSheet.title')}
      closeLabel={t('common.close')}
      testId="mobile-composer-sheet"
    >
      {settings.length > 0 ? (
        <div role="group" aria-label={t('chat.mobileSheet.sessionSettings')} className="border-b border-[var(--color-border)] p-2">
          {settings.map((setting) => (
            <button
              key={setting.key}
              type="button"
              disabled={setting.disabled}
              onClick={setting.onSelect}
              className="flex min-h-12 w-full items-center gap-3 rounded-[var(--radius-md)] px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] active:bg-[var(--color-surface-hover)] disabled:opacity-50"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-surface-container)] text-[var(--color-text-secondary)]">
                {setting.icon}
              </span>
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[var(--color-text-primary)]">{setting.label}</span>
              {setting.value ? (
                <span className="max-w-[50%] truncate text-[13px] text-[var(--color-text-tertiary)]">{setting.value}</span>
              ) : null}
              <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)]" />
            </button>
          ))}
        </div>
      ) : null}
      <ComposerCapabilityMenu
        id={menuId}
        presentation="sheet"
        sections={sections}
        cwd={cwd}
        referencesLoading={referencesLoading}
        referencesError={referencesError}
        onSelectFile={onSelectFile}
        onAction={onAction}
        onClose={onClose}
      />
    </MobileBottomSheet>
  )
}
