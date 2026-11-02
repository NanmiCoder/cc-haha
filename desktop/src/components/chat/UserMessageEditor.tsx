import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import type { ComposerMention } from '@/lib/composerMentions'
import { useTranslation } from '../../i18n'
import { useSettingsStore } from '../../stores/settingsStore'
import { AgentTeamChip } from './AgentTeamChip'
import { AttachmentGallery } from './AttachmentGallery'
import { MentionComposer, type MentionComposerHandle } from './MentionComposer'
import { shouldSubmitOnEnter } from './sendShortcut'
import type { UserMessageEditDraft } from './userMessageEdit'
import { useEditorCapabilityTriggers } from './useEditorCapabilityTriggers'

const NO_MENTIONS: ComposerMention[] = []

type Props = {
  initialDraft: UserMessageEditDraft
  /** Where `/` and `@` look up commands, skills and plugins. */
  sessionId?: string
  submitting: boolean
  disabled: boolean
  onDraftChange: (draft: UserMessageEditDraft) => void
  onCancel: () => void
  onSubmit: (draft: UserMessageEditDraft) => void
}

export function UserMessageEditor({
  initialDraft,
  sessionId,
  submitting,
  disabled,
  onDraftChange,
  onCancel,
  onSubmit,
}: Props) {
  const t = useTranslation()
  const chatSendBehavior = useSettingsStore((state) => state.chatSendBehavior)
  const [draft, setDraft] = useState(initialDraft)
  const composerRef = useRef<MentionComposerHandle>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const composingRef = useRef(false)

  useEffect(() => {
    composerRef.current?.focus()
    composerRef.current?.setSelectionOffsets(initialDraft.text.length)
    // Opening the editor is the only moment the draft's own length places the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updateDraft = (next: UserMessageEditDraft) => {
    setDraft(next)
    onDraftChange(next)
  }

  const mentions = draft.mentions ?? NO_MENTIONS
  const triggers = useEditorCapabilityTriggers({
    sessionId,
    text: draft.text,
    mentions,
    composerRef,
    containerRef: cardRef,
    onChange: (text, nextMentions) => updateDraft({ ...draft, text, mentions: nextMentions }),
  })

  const unavailableCount = draft.attachments.filter((attachment) => !attachment.sendable).length
  const hasContent = draft.text.trim().length > 0 ||
    draft.attachments.some((attachment) => attachment.sendable)
  const canSubmit = hasContent && !disabled && !submitting

  const handleKeyDown = (event: KeyboardEvent): boolean => {
    if (composingRef.current || event.isComposing || event.keyCode === 229) return false
    if (triggers.handleKeyDown(event)) return true
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!submitting) onCancel()
      return true
    }
    if (shouldSubmitOnEnter(event, chatSendBehavior)) {
      event.preventDefault()
      if (canSubmit) onSubmit(draft)
      return true
    }
    return false
  }

  const aria = useMemo(
    () => ({ ...triggers.comboboxAria, 'aria-label': t('chat.editMessageInputLabel') }),
    [t, triggers.comboboxAria],
  )

  return (
    <div
      ref={cardRef}
      data-testid="user-message-editor"
      // The keys typed here belong to the editor; the message list reads arrows
      // and Space as scroll intent.
      onKeyDown={(event) => event.stopPropagation()}
      className="relative flex w-full flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] p-2.5"
    >
      {triggers.menus}
      {draft.agentTeam ? (
        <div className="flex">
          <AgentTeamChip onRemove={submitting ? undefined : () => updateDraft({ ...draft, agentTeam: false })} />
        </div>
      ) : null}
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
      <MentionComposer
        ref={composerRef}
        value={draft.text}
        mentions={mentions}
        disabled={submitting}
        onChange={(text, nextMentions) => {
          updateDraft({ ...draft, text, mentions: nextMentions.length > 0 ? nextMentions : undefined })
          triggers.detectTriggers(text, nextMentions)
        }}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false }}
        editorClassName="chat-reading-text min-h-[52px] max-h-[320px] overflow-y-auto px-1 py-0.5 text-[var(--color-text-primary)]"
        aria={aria}
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
