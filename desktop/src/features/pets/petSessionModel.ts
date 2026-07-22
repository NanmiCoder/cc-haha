import type { PerSessionState } from '../../stores/chatStore'
import { hasRunningBackgroundTasks } from '../../lib/backgroundTasks'
import type { UIMessage } from '../../types/chat'
import type { SessionListItem } from '../../types/session'
import type { PetAnimationState } from './petAnimation'

export type PetSessionStatus = 'waiting' | 'failed' | 'review' | 'running' | 'idle'

export type PetSessionActivity = {
  session: SessionListItem
  status: PetSessionStatus
  preview: string
}

const STATUS_PRIORITY: Record<PetSessionStatus, number> = {
  waiting: 0,
  failed: 1,
  review: 2,
  running: 3,
  idle: 4,
}

export function resolvePetSessionStatus(
  chat: PerSessionState | undefined,
  review = false,
  observed: PetSessionStatus = 'idle',
): PetSessionStatus {
  if (chat?.chatState === 'permission_pending') return 'waiting'
  if (chat && chat.chatState !== 'idle') return 'running'
  if (hasRunningBackgroundTasks(chat?.backgroundAgentTasks)) return 'running'
  if (observed === 'waiting' || observed === 'running') return observed
  if (chat?.messages.at(-1)?.type === 'error') return 'failed'
  if (observed === 'failed') return 'failed'
  if (chat?.historyStatus === 'error') return 'failed'
  // Older servers reported every successful turn as review while its tab was
  // still open. Completion is idle unless a real actionable state is present.
  if (review || observed === 'review') return 'idle'
  return 'idle'
}

export function petStatusAnimation(status: PetSessionStatus): PetAnimationState {
  switch (status) {
    case 'waiting': return 'waiting'
    case 'failed': return 'failed'
    case 'review': return 'review'
    case 'running': return 'running'
    case 'idle': return 'idle'
  }
}

export function latestAssistantPreview(messages: readonly UIMessage[] | undefined, maxLength = 120): string {
  const message = [...(messages ?? [])]
    .reverse()
    .find((candidate) => candidate.type === 'assistant_text')
  if (!message || message.type !== 'assistant_text') return ''
  const normalized = message.content.replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
    : normalized
}

export function currentPetPreview(chat: PerSessionState | undefined, maxLength = 120): string {
  const live = chat?.streamingText?.trim() || chat?.statusVerb?.trim() || ''
  if (live) {
    const normalized = live.replace(/\s+/g, ' ')
    return normalized.length > maxLength
      ? `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
      : normalized
  }
  return latestAssistantPreview(chat?.messages, maxLength)
}

export function buildPetSessionActivities({
  sessions,
  chats,
  observedStatuses = {},
  reviewSessionIds = new Set<string>(),
  limit = 9,
}: {
  sessions: readonly SessionListItem[]
  chats: Record<string, PerSessionState | undefined>
  observedStatuses?: Record<string, PetSessionStatus | undefined>
  reviewSessionIds?: ReadonlySet<string>
  limit?: number
}): PetSessionActivity[] {
  return sessions
    .map((session) => {
      const chat = chats[session.id]
      return {
        session,
        status: resolvePetSessionStatus(
          chat,
          reviewSessionIds.has(session.id),
          observedStatuses[session.id],
        ),
        preview: currentPetPreview(chat),
      }
    })
    .sort((left, right) => {
      const priority = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status]
      if (priority !== 0) return priority
      return Date.parse(right.session.modifiedAt) - Date.parse(left.session.modifiedAt)
    })
    .slice(0, Math.max(0, limit))
}
