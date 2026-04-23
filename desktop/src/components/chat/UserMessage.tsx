import type { UIAttachment } from '../../types/chat'
import { AttachmentGallery } from './AttachmentGallery'
import { MessageActionBar } from './MessageActionBar'

type Props = {
  content: string
  attachments?: UIAttachment[]
}

export function UserMessage({ content, attachments }: Props) {
  const hasText = content.trim().length > 0

  return (
    <div className="group mb-5 flex items-end justify-end gap-1.5">
      <div className="min-w-0 max-w-[82%] space-y-2">
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
      </div>

      {hasText && (
        <MessageActionBar
          copyText={content}
          copyLabel="Copy prompt"
        />
      )}
    </div>
  )
}
