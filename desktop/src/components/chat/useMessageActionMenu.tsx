import { useState, type ReactNode } from 'react'
import { Copy, GitFork, Pencil, TextCursorInput } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { MobileBottomSheet } from '@/components/ui/MobileBottomSheet'
import { useLongPress } from '../../hooks/useLongPress'
import { useMobileViewport } from '../../hooks/useMobileViewport'
import { copyTextToClipboard } from '../../lib/clipboard'
import { isDesktopRuntime } from '../../lib/desktopRuntime'
import { formatExactMessageTimestamp } from '../../lib/formatMessageTimestamp'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import type { MessageBranchAction, MessageEditAction } from './MessageActionBar'

type Input = {
  copyText?: string
  branchAction?: MessageBranchAction
  editAction?: MessageEditAction
  timestamp?: number
}

type MessageActionMenu = {
  /** True on a touch layout: the hover bar is replaced by press-and-hold. */
  enabled: boolean
  /** Spread on the message shell. Inert unless `enabled`. */
  pressProps: ReturnType<typeof useLongPress>
  /** Add to the shell's classes: stops the browser's own long-press callout. */
  pressClassName: string
  /** The sheets; render it once next to the message. */
  sheet: ReactNode
}

/**
 * Press and hold a message on a phone for its actions: copy, select text,
 * edit and resend, branch from here. On the desktop these are a hover bar
 * under the message; a phone has no hover, and a bar kept always visible put
 * a row of icons under every message. The sheet's header carries the exact
 * time, and an edit that cannot be made says why instead of disappearing.
 *
 * Holding a message no longer starts the browser's own text selection, so
 * "Select text" opens the message as plain text where selection works.
 */
export function useMessageActionMenu({ copyText, branchAction, editAction, timestamp }: Input): MessageActionMenu {
  const t = useTranslation()
  const locale = useSettingsStore((state) => state.locale)
  const enabled = useMobileViewport() && !isDesktopRuntime()
  const [mode, setMode] = useState<'closed' | 'actions' | 'select'>('closed')
  const text = copyText?.trim() ? copyText : ''
  const hasActions = Boolean(text || branchAction || editAction)
  const longPress = useLongPress({ onLongPress: () => setMode('actions'), disabled: !enabled || !hasActions })
  const close = () => setMode('closed')

  const copy = async () => {
    close()
    const ok = await copyTextToClipboard(text)
    useUIStore.getState().addToast({
      type: ok ? 'success' : 'error',
      message: ok ? t('common.copied') : t('common.copyFailed'),
    })
  }

  const exactTime = typeof timestamp === 'number' ? formatExactMessageTimestamp(timestamp, locale) : ''

  const sheet = enabled ? (
    <>
      <MobileBottomSheet
        open={mode === 'actions'}
        onClose={close}
        title={exactTime || t('chat.messageActions.title')}
        ariaLabel={t('chat.messageActions.title')}
        closeLabel={t('common.close')}
        testId="message-action-sheet"
      >
        <div role="menu" aria-label={t('chat.messageActions.title')} className="flex flex-col p-2">
          {text ? (
            <ActionRow icon={<Copy size={18} strokeWidth={1.75} aria-hidden="true" />} onClick={() => void copy()}>
              {t('common.copy')}
            </ActionRow>
          ) : null}
          {text ? (
            <ActionRow icon={<TextCursorInput size={18} strokeWidth={1.75} aria-hidden="true" />} onClick={() => setMode('select')}>
              {t('chat.messageActions.selectText')}
            </ActionRow>
          ) : null}
          {editAction ? (
            <ActionRow
              icon={<Pencil size={18} strokeWidth={1.75} aria-hidden="true" />}
              disabled={editAction.disabled}
              description={editAction.disabled ? editAction.disabledReason : undefined}
              onClick={() => {
                close()
                editAction.onEdit()
              }}
            >
              {editAction.label}
            </ActionRow>
          ) : null}
          {branchAction ? (
            <ActionRow
              icon={<GitFork size={18} strokeWidth={1.75} aria-hidden="true" />}
              disabled={branchAction.loading}
              onClick={() => {
                close()
                branchAction.onBranch()
              }}
            >
              {branchAction.label}
            </ActionRow>
          ) : null}
        </div>
      </MobileBottomSheet>
      <MobileBottomSheet
        open={mode === 'select'}
        onClose={close}
        title={t('chat.messageActions.selectText')}
        closeLabel={t('common.close')}
        testId="message-select-sheet"
        tall
        contentClassName="p-4"
      >
        <div
          data-testid="message-select-text"
          className="select-text whitespace-pre-wrap break-words text-[15px] leading-[1.7] text-[var(--color-text-primary)] [-webkit-touch-callout:default]"
        >
          {text}
        </div>
      </MobileBottomSheet>
    </>
  ) : null

  return {
    enabled,
    pressProps: longPress,
    pressClassName: enabled && hasActions ? 'select-none [-webkit-touch-callout:none]' : '',
    sheet,
  }
}

function ActionRow({
  icon,
  disabled = false,
  description,
  onClick,
  children,
}: {
  icon: ReactNode
  disabled?: boolean
  description?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-12 items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-left text-[var(--color-text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] active:bg-[var(--color-surface-hover)] disabled:text-[var(--color-text-tertiary)]"
    >
      <span className="shrink-0 text-[var(--color-text-secondary)]">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[15px]">{children}</span>
        {description ? <span className="text-[12px] text-[var(--color-text-tertiary)]">{description}</span> : null}
      </span>
    </button>
  )
}
