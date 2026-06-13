import type { AssistantMessage, Message } from '../../types/message.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { isPromptTooLongMessage } from '../api/errors.js'
import {
  compactConversation,
  ERROR_MESSAGE_PROMPT_TOO_LONG,
  ERROR_MESSAGE_USER_ABORT,
  type CompactionResult,
} from './compact.js'

export type ReactiveCompactOutcome =
  | { ok: true; result: CompactionResult }
  | {
      ok: false
      reason: 'too_few_groups' | 'aborted' | 'exhausted' | 'error' | 'media_unstrippable'
    }

export function isWithheldPromptTooLong(
  message: Message | undefined,
): message is AssistantMessage {
  return message?.type === 'assistant' && isPromptTooLongMessage(message)
}

export function isWithheldMediaSizeError(_message: Message | undefined): boolean {
  return false
}

export function isReactiveCompactEnabled(): boolean {
  return true
}

export function isReactiveOnlyMode(): boolean {
  return false
}

export async function tryReactiveCompact({
  hasAttempted,
  aborted,
  messages,
  cacheSafeParams,
}: {
  hasAttempted: boolean
  querySource?: unknown
  aborted: boolean
  messages: Message[]
  cacheSafeParams: CacheSafeParams
}): Promise<CompactionResult | null> {
  if (hasAttempted || aborted) return null

  const messagesForCompact = getMessagesAfterCompactBoundary(messages)
  if (messagesForCompact.length === 0) return null

  try {
    return await compactConversation(
      messagesForCompact,
      cacheSafeParams.toolUseContext,
      {
        ...cacheSafeParams,
        forkContextMessages: messagesForCompact,
      },
      true,
      undefined,
      true,
    )
  } catch (error) {
    if (
      !hasExactErrorMessage(error, ERROR_MESSAGE_PROMPT_TOO_LONG) &&
      !hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)
    ) {
      logError(error)
    }
    return null
  }
}

export async function reactiveCompactOnPromptTooLong(
  _messages: Message[],
  _cacheSafeParams: CacheSafeParams,
  _options?: { customInstructions?: string; trigger?: 'manual' | 'auto' },
): Promise<ReactiveCompactOutcome> {
  return { ok: false, reason: 'error' }
}

export const createCachedMCState = undefined
export const isCachedMicrocompactEnabled = () => false
export const isModelSupportedForCacheEditing = () => false
export const getCachedMCConfig = () => undefined
export const markToolsSentToAPI = () => undefined
export const resetCachedMCState = () => undefined
export const checkProtectedNamespace = () => undefined
export const getCoordinatorUserContext = () => undefined
