import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import {
  isPromptTooLongMessage,
  parsePromptTooLongTokenCounts,
} from '../api/errors.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import { getAutoCompactThreshold, isAutoCompactEnabled } from './autoCompact.js'
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

/** The provider's hard limit, when its error states one. */
export function getProviderContextLimit(
  message: AssistantMessage,
): number | undefined {
  return parsePromptTooLongTokenCounts(message.errorDetails ?? '').limitTokens
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
