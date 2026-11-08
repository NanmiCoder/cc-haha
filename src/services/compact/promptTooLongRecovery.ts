import { BUSINESS_ERROR_CODES } from '../../constants/businessErrors.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { MODEL_CONTEXT_WINDOW_MIN } from '../../utils/model/modelContextWindows.js'
import {
  hasUsableContextUsage,
  tokenCountWithEstimation,
} from '../../utils/tokens.js'
import {
  isPromptTooLongMessage,
  parsePromptTooLongTokenCounts,
} from '../api/errors.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import {
  estimateFallbackFixedContextTokens,
  getAutoCompactThreshold,
  isAutoCompactEnabled,
} from './autoCompact.js'
import {
  type CompactionResult,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
} from './compact.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'

/**
 * Recovery for a request the provider rejected as too long.
 *
 * Proactive auto-compact fires at a threshold derived from the window the app
 * believes in. When the provider's real cap is smaller (an unregistered model
 * on the 200K default, a mistyped window, a gateway with its own limit), the
 * request is rejected before that threshold is ever reached and, without this,
 * the turn just ends. A desktop team member then stays stuck: everything sent
 * to it replays the same oversized context. The official CLI compacts and
 * retries once in this case; this is the same recovery built on the regular
 * compaction path, whose summary request already peels the oldest messages
 * when it is itself too long.
 *
 * Only agent loops recover (the main thread, SDK sessions such as desktop
 * members, subagents and teammates). Forked side queries (prompt suggestions,
 * summaries, memory extraction) are short-lived and share the main thread's
 * module state, so they keep surfacing the error.
 */
export function canRecoverFromPromptTooLong(querySource: QuerySource): boolean {
  const isAgentLoop =
    querySource === 'sdk' ||
    querySource.startsWith('repl_main_thread') ||
    querySource.startsWith('agent:')
  return isAgentLoop && isAutoCompactEnabled()
}

export function isPromptTooLongApiError(
  message: unknown,
): message is AssistantMessage {
  return (
    (message as Message | undefined)?.type === 'assistant' &&
    isPromptTooLongMessage(message as AssistantMessage)
  )
}

function hasMediaBlocks(content: unknown): boolean {
  return Array.isArray(content) && content.some(block =>
    block?.type === 'image' ||
    block?.type === 'document' ||
    (block?.type === 'tool_result' && hasMediaBlocks(block.content)),
  )
}

/**
 * A rejection that compacting the conversation can fix: a context overflow,
 * or a relay's byte limit (413) on a request with no media in it. A 413 on a
 * request carrying images or PDFs is left to the media stripping that history
 * normalization applies on the next turn, which keeps the text intact.
 */
export function isRecoverableContextRejection(
  message: unknown,
  messages: readonly Message[],
): message is AssistantMessage {
  if (isPromptTooLongApiError(message)) return true
  return (
    (message as Message | undefined)?.type === 'assistant' &&
    (message as AssistantMessage).isApiErrorMessage === true &&
    (message as AssistantMessage).businessErrorCode ===
      BUSINESS_ERROR_CODES.REQUEST_TOO_LARGE &&
    !messages.some(
      candidate =>
        candidate.type === 'user' && hasMediaBlocks(candidate.message.content),
    )
  )
}

/**
 * The provider's hard limit: the one its error states, or else the size of
 * the request it just rejected, which the limit is below. A rejected request
 * smaller than any real context window says nothing about the window (it was
 * refused for something else that merely reads like an overflow), so it
 * teaches nothing.
 */
export function getProviderContextLimit(
  message: AssistantMessage,
  rejectedRequestTokens: number,
): number | undefined {
  const stated = parsePromptTooLongTokenCounts(message.errorDetails ?? '').limitTokens
  if (stated !== undefined) return stated
  return rejectedRequestTokens >= MODEL_CONTEXT_WINDOW_MIN
    ? rejectedRequestTokens
    : undefined
}

/**
 * How large the rejected request was: the provider's last reported usage plus
 * everything added since, and the fixed prefix (system prompt, tools) when the
 * provider never reported usage — the same count proactive auto-compact uses.
 */
export function estimateRejectedRequestTokens(
  messages: readonly Message[],
  cacheSafeParams: CacheSafeParams,
): number {
  return (
    tokenCountWithEstimation(messages) +
    (hasUsableContextUsage(messages)
      ? 0
      : estimateFallbackFixedContextTokens(cacheSafeParams))
  )
}

export async function compactAfterPromptTooLong({
  messages,
  toolUseContext,
  cacheSafeParams,
  querySource,
}: {
  messages: Message[]
  toolUseContext: ToolUseContext
  cacheSafeParams: CacheSafeParams
  querySource: QuerySource
}): Promise<CompactionResult | null> {
  if (toolUseContext.abortController.signal.aborted) return null
  try {
    const result = await compactConversation(
      messages,
      toolUseContext,
      cacheSafeParams,
      true, // No follow-up questions: nobody is waiting on this compaction
      undefined,
      true, // isAutoCompact
      {
        isRecompactionInChain: false,
        turnsSincePreviousCompact: -1,
        autoCompactThreshold: getAutoCompactThreshold(
          toolUseContext.options.mainLoopModel,
        ),
        querySource,
      },
    )
    // Same bookkeeping as a proactive auto-compact: the summarized message
    // ids are gone and the module caches describe the old conversation.
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    logForDebugging('prompt-too-long: compacted the rejected request; retrying once')
    return result
  } catch (error) {
    if (!hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)) {
      logError(error)
    }
    return null
  }
}
