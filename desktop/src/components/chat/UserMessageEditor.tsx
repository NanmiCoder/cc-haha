import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Button } from '@/components/ui/Button'
import { TextArea } from '@/components/ui/TextArea'
import { useTranslation } from '../../i18n'
import { useSettingsStore } from '../../stores/settingsStore'
import { AttachmentGallery } from './AttachmentGallery'
import { shouldSubmitOnEnter } from './sendShortcut'
import type { UserMessageEditDraft } from './userMessageEdit'

type Props = {
  initialDraft: UserMessageEditDraft
  submitting: boolean
  disabled: boolean
  onDraftChange: (draft: UserMessageEditDraft) => void
  onCancel: () => void
  onSubmit: (draft: UserMessageEditDraft) => void
}

const MIN_ROWS = 2
const MAX_ROWS = 12

export function UserMessageEditor({
  initialDraft,
  submitting,
  disabled,
  onDraftChange,
  onCancel,
  onSubmit,
}: Props) {
  const t = useTranslation()
  const chatSendBehavior = useSettingsStore((state) => state.chatSendBehavior)
  const [draft, setDraft] = useState(initialDraft)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composingRef = useRef(false)

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  }, [])

  const updateDraft = (next: UserMessageEditDraft) => {
    setDraft(next)
    onDraftChange(next)
  }

  const unavailableCount = draft.attachments.filter((attachment) => !attachment.sendable).length
  const hasContent = draft.text.trim().length > 0 ||
    draft.attachments.some((attachment) => attachment.sendable)
  const canSubmit = hasContent && !disabled && !submitting
  const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, draft.text.split('\n').length))

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // The message list reads arrow keys and Space as scroll intent; keystrokes
    // typed into the editor belong to the editor alone.
    event.stopPropagation()
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!submitting) onCancel()
      return
    }
    if (shouldSubmitOnEnter(event, chatSendBehavior)) {
      event.preventDefault()
      if (canSubmit) onSubmit(draft)
    }
  }

  return (
    <div
      data-testid="user-message-editor"
      className="flex w-full flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-2.5"
    >
      {draft.attachments.length > 0 ? (
        <AttachmentGallery
          attachments={draft.attachments}
          variant="composer"
          onRemove={submitting ? undefined : (id) => updateDraft({
            ...draft,
            attachments: draft.attachments.filter((attachment) => attachment.id !== id),
          })}
        />
      ) : null}
      {unavailableCount > 0 ? (
        <p className="px-0.5 text-xs text-[var(--color-warning)]">
          {t('chat.editAttachmentUnavailable', { count: unavailableCount })}
        </p>
      ) : null}
      <TextArea
        ref={textareaRef}
        aria-label={t('chat.editMessageInputLabel')}
        value={draft.text}
        rows={rows}
        disabled={submitting}
        onChange={(event) => updateDraft({ ...draft, text: event.target.value })}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false }}
        className="chat-reading-text resize-none"
      />
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => onSubmit(draft)}
          disabled={!canSubmit}
          loading={submitting}
        >
          {t('chat.editMessageSend')}
        </Button>
      </div>
    </div>
  )
}
