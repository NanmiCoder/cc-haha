import { ChatInput } from '@/components/chat/ChatInput'
import { MessageList } from '@/components/chat/MessageList'
import { useSideChatStore } from '@/stores/sideChatStore'
import { EmptyState } from '@/components/ui/EmptyState'
import { useChatStore } from '@/stores/chatStore'
import { useTranslation } from '@/i18n'

export function SideChatSurface({ parentSessionId, sideChatId, visible = true }: {
  parentSessionId: string
  sideChatId: string
  visible?: boolean
}) {
  const t = useTranslation()
  const entry = useSideChatStore(state => state.entries[sideChatId])
  const empty = useChatStore(state => !state.sessions[sideChatId]?.messages.length && !state.sessions[sideChatId]?.streamingText && (state.sessions[sideChatId]?.chatState ?? 'idle') === 'idle')
  if (!entry || entry.parentSessionId !== parentSessionId) return null
  return (
    <section className="flex h-full min-h-0 flex-col bg-[var(--color-surface)]" aria-label={t('sideChat.title')} data-side-chat-id={sideChatId}>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {empty && <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><EmptyState variant="plain" title={t('sideChat.title')} description={t('sideChat.emptyDescription')} /></div>}
        <MessageList sessionId={sideChatId} compact />
      </div>
      <ChatInput sessionId={sideChatId} compact visible={visible} />
    </section>
  )
}
