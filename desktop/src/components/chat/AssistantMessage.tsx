import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { MessageActionBar } from './MessageActionBar'
import { InlineImageGallery } from './InlineImageGallery'

type Props = {
  content: string
  isStreaming?: boolean
}

export function AssistantMessage({ content, isStreaming }: Props) {
  return (
    <div className="group mb-5 ml-10 flex items-end gap-1.5">
      <div className="min-w-0">
        <div className="rounded-[20px] rounded-tl-[8px] border border-[var(--color-border)]/60 bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-text-primary)] shadow-sm">
          <MarkdownRenderer content={content} />
          {!isStreaming && <InlineImageGallery text={content} />}
          {isStreaming && (
            <span className="ml-0.5 inline-block h-4 w-0.5 animate-shimmer bg-[var(--color-brand)] align-text-bottom" />
          )}
        </div>
      </div>

      <MessageActionBar
        copyText={isStreaming ? undefined : content}
        copyLabel="Copy reply"
      />
    </div>
  )
}
