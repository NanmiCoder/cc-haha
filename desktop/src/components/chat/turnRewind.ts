import {
  sessionsApi,
  type SessionRewindMode,
  type SessionRewindResponse,
  type SessionTurnCheckpoint,
} from '../../api/sessions'
import { ApiError } from '../../api/client'
import type { TranslationKey } from '../../i18n/locales/en'
import { useChatStore } from '../../stores/chatStore'
import { useWorkspaceReviewStore } from '../../stores/workspaceReviewStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string

/**
 * The one way the chat surface rewinds a turn. Both "undo this turn" and
 * "edit and resend" go through it, so a rewind always stops the live turn
 * first, addresses the server's authoritative checkpoint target, and drops the
 * review state of the turns it removed. Reloading history and what happens to
 * the prompt afterwards are the caller's business.
 */
export async function rewindToTurnCheckpoint(
  sessionId: string,
  request: {
    checkpointTarget: SessionTurnCheckpoint['target']
    expectedContent: string
  },
  mode: SessionRewindMode,
): Promise<SessionRewindResponse> {
  const chatStore = useChatStore.getState()
  if ((chatStore.sessions[sessionId]?.chatState ?? 'idle') !== 'idle') {
    chatStore.stopGeneration(sessionId)
  }

  const { checkpointTarget } = request
  const result = await sessionsApi.rewind(sessionId, {
    targetUserMessageId: checkpointTarget.targetUserMessageId,
    userMessageIndex: checkpointTarget.userMessageIndex,
    expectedContent: request.expectedContent,
    mode,
  })

  useWorkspaceStore.getState().pruneTurnReviewTabs(sessionId, checkpointTarget.userMessageIndex)
  useWorkspaceReviewStore.getState().clearTurnReviews(sessionId, checkpointTarget.userMessageIndex)
  return result
}

/**
 * Each branch has to match what actually happened on disk: nothing was
 * restored in conversation mode, and in `both` mode a turn that also wrote
 * off-checkpoint left changes behind. A plain success would overstate both.
 */
export function describeRewindResult(
  result: SessionRewindResponse,
  mode: SessionRewindMode,
  t: Translate,
): { type: 'success' | 'warning'; message: string } {
  const count = result.conversation.messagesRemoved
  const leftBehind = mode === 'both' ? result.unverifiedChangeSources ?? [] : []
  return {
    type: leftBehind.length > 0 ? 'warning' : 'success',
    message: mode === 'conversation'
      ? t('chat.rewindSuccessConversationOnly', { count })
      : leftBehind.length > 0
        ? t('chat.rewindSuccessPartialCoverage', { count, sources: leftBehind.join(', ') })
        : result.code.available
          ? t('chat.rewindSuccessWithCode', { count })
          : t('chat.rewindSuccessConversationOnly', { count }),
  }
}

/** The server's own explanation when it gave one, otherwise the error text. */
export function getApiErrorMessage(error: unknown): string {
  return error instanceof ApiError
    ? typeof error.body === 'object' && error.body && 'message' in error.body
      ? String((error.body as { message: unknown }).message)
      : error.message
    : error instanceof Error
      ? error.message
      : String(error)
}
