import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'

type Props = {
  sessionId: string
  compact?: boolean
  isLoading?: boolean
  error?: string | null
}

export function SessionChat({ sessionId, compact = false, isLoading, error }: Props) {
  if (isLoading) {
    return (
      <div role="status" className="flex flex-1 items-center justify-center p-8 text-sm text-[var(--color-text-secondary)]">
        <span className="material-symbols-outlined mr-2 animate-spin text-[18px]">progress_activity</span>
        Loading...
      </div>
    )
  }

  if (error) {
    return (
      <div role="alert" className="flex flex-1 items-center justify-center p-8 text-sm text-[var(--color-error)]">
        {error}
      </div>
    )
  }

  return (
    <>
      <MessageList sessionId={sessionId} compact={compact} />
      <ChatInput sessionId={sessionId} variant="default" compact={compact} />
    </>
  )
}
