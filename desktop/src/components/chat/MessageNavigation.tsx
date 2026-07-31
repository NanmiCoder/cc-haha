import { memo, useMemo } from 'react'
import { User } from 'lucide-react'
import type { UIMessage } from '../../types/chat'

type MessageNavigationProps = {
  messages: UIMessage[]
  onNavigate: (messageId: string) => void
}

type NavigationItem = {
  id: string
  label: string
}

function getNavigationLabel(message: UIMessage): string {
  if (message.type === 'user_text') {
    const text = message.content.trim()
    return text.length > 30 ? text.slice(0, 30) + '...' : text || '用户消息'
  }
  return '消息'
}

export const MessageNavigation = memo(function MessageNavigation({
  messages,
  onNavigate,
}: MessageNavigationProps) {
  const navItems = useMemo(() => {
    const items: NavigationItem[] = []
    for (const message of messages) {
      if (message.type === 'user_text') {
        items.push({
          id: message.id,
          label: getNavigationLabel(message),
        })
      }
    }
    return items
  }, [messages])

  if (navItems.length === 0) {
    return null
  }

  return (
    <div className="absolute right-0 top-0 bottom-0 w-[220px] overflow-y-auto py-4 pl-2 pr-4">
      <div className="sticky top-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-2 shadow-sm">
        <div className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
          消息导航
        </div>
        <div className="flex flex-col gap-0.5">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]"
            >
              <User size={12} strokeWidth={2} className="shrink-0 text-[var(--color-text-tertiary)]" />
              <span className="min-w-0 truncate">{item.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
})
