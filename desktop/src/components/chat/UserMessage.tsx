import type { UIAttachment } from '../../types/chat'
import { AttachmentGallery } from './AttachmentGallery'
import { MessageActionBar } from './MessageActionBar'

type Props = {
  content: string
  attachments?: UIAttachment[]
  onRecall?: () => void
  recallLabel?: string
  recallDisplayLabel?: string
  recallDisabled?: boolean
}

export function UserMessage({
  content,
  attachments,
  onRecall,
  recallLabel = 'Recall to edit',
  recallDisplayLabel = 'Recall',
  recallDisabled = false,
}: Props) {
  const hasText = content.trim().length > 0
  const hasActions = Boolean(onRecall)

  return (
    <div className="group mb-5 flex justify-end">
      <div
        data-message-shell="user"
        className="flex min-w-0 w-full max-w-[82%] flex-col items-end gap-2 sm:max-w-[78%] lg:max-w-[72%]"
      >
        {attachments && attachments.length > 0 && (
          <AttachmentGallery attachments={attachments} variant="message" />
        )}

        {hasText && (
          <div
            className="bg-[var(--color-surface-user-msg)] px-4 py-3 text-sm leading-relaxed text-[var(--color-text-primary)] whitespace-pre-wrap break-words"
            style={{ borderRadius: '18px 4px 18px 18px' }}
          >
            {content}
          </div>
        )}

        {(hasText || hasActions) && (
          <MessageActionBar
            copyText={hasText ? content : undefined}
            copyLabel="Copy prompt"
            align="end"
            actions={onRecall
              ? [{
                  label: recallLabel,
                  displayLabel: recallDisplayLabel,
                  onClick: onRecall,
                  disabled: recallDisabled,
                  tone: 'danger',
                }]
              : undefined}
          />
        )}
      </div>
    </div>
  )
}
