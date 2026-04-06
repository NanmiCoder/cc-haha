import { useChatStore } from '../../stores/chatStore'

export function StreamingIndicator() {
  const { chatState } = useChatStore()

  const verb = chatState === 'thinking'
    ? 'Thinking'
    : chatState === 'tool_executing'
      ? 'Running'
      : 'Working'

  return (
    <div className="mb-2 ml-10 flex w-fit items-center gap-2 rounded-full border border-[var(--color-border)]/40 bg-[var(--color-surface-container-low)] px-3 py-1">
      <span className="text-[var(--color-brand)] animate-shimmer text-xs">✦</span>
      <span className="text-xs font-medium text-[var(--color-text-secondary)]">{verb}...</span>
    </div>
  )
}
