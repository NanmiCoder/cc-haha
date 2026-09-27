/**
 * Side Question ("/btw") feature - allows asking quick questions without
 * interrupting the main agent context.
 *
 * Uses runForkedAgent to leverage prompt caching from the parent context
 * while keeping the side question response separate from main conversation.
 */

import { formatAPIError } from '../services/api/errorUtils.js'
import type { NonNullableUsage } from '../services/api/logging.js'
import type { Message, SystemAPIErrorMessage } from '../types/message.js'
import { type CacheSafeParams, runForkedAgent } from './forkedAgent.js'
import { createAssistantMessage, createUserMessage, extractTextContent, getMessagesAfterCompactBoundary } from './messages.js'

// Pattern to detect "/btw" at start of input (case-insensitive, word boundary)
const BTW_PATTERN = /^\/btw\b/gi

/**
 * Find positions of "/btw" keyword at the start of text for highlighting.
 * Similar to findThinkingTriggerPositions in thinking.ts.
 */
export function findBtwTriggerPositions(text: string): Array<{
  word: string
  start: number
  end: number
}> {
  const positions: Array<{ word: string; start: number; end: number }> = []
  const matches = text.matchAll(BTW_PATTERN)

  for (const match of matches) {
    if (match.index !== undefined) {
      positions.push({
        word: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return positions
}

export type SideQuestionHistoryEntry = { question: string; response: string }

/** Snapshot current parent context without mutating its in-flight messages. */
export function prepareSideQuestionContext(messages: Message[]): Message[] {
  let snapshot = getMessagesAfterCompactBoundary(messages).slice()
  const last = snapshot.findLast(message => message.type === 'assistant' || message.type === 'user')
  if (last?.type === 'assistant' && last.message.stop_reason == null) {
    // A response is split into one message per content block. Remove its whole
    // unfinished group, not merely the last text/thinking block.
    snapshot = snapshot.filter(message => message.type !== 'assistant' || message.message.id !== last.message.id)
  }
  const pending = new Set<string>()
  for (const message of snapshot) {
    if (message.type !== 'assistant' && message.type !== 'user') continue
    if (!Array.isArray(message.message.content)) continue
    for (const block of message.message.content) {
      if (block.type === 'tool_use') pending.add(block.id)
      else if (block.type === 'tool_result') pending.delete(block.tool_use_id)
    }
  }
  if (pending.size) snapshot.push(createUserMessage({ content: [...pending].map(id => ({
    type: 'tool_result' as const, tool_use_id: id, is_error: true,
    content: 'This tool is still running in the main conversation. Its result is not available to this side question.',
  })) }))
  return snapshot
}

export type SideQuestionResult = {
  response: string
  usage: NonNullableUsage
}

/**
 * Run a side question using a forked agent.
 * Shares the parent's prompt cache — no thinking override, no cache write.
 * All tools are blocked and we cap at 1 turn.
 */
export async function runSideQuestion({
  question,
  cacheSafeParams,
  history = [],
  signal,
}: {
  question: string
  cacheSafeParams: CacheSafeParams
  history?: SideQuestionHistoryEntry[]
  signal?: AbortSignal
}): Promise<SideQuestionResult> {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const cancel = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  controller.signal.throwIfAborted()
  // Wrap the question with instructions to answer without tools
  const wrappedQuestion = `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect

CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- Answer this question in one response; previous side-question exchanges may be provided below
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate

Simply answer the question with the information you have.</system-reminder>

${question}`

  try {
    const agentResult = await runForkedAgent({
      promptMessages: [
        ...history.slice(-20).flatMap(entry => [createUserMessage({ content: entry.question }), createAssistantMessage({ content: entry.response })]),
        createUserMessage({ content: wrappedQuestion }),
      ],
      // Do NOT override thinkingConfig — thinking is part of the API cache key,
      // and diverging from the main thread's config busts the prompt cache.
      // Adaptive thinking on a quick Q&A has negligible overhead.
      cacheSafeParams: { ...cacheSafeParams, forkContextMessages: prepareSideQuestionContext(cacheSafeParams.forkContextMessages) },
      overrides: { abortController: controller, requireCanUseTool: true },
      skipTranscript: true,
      // query yields assistant messages before dispatching tool execution.
      // Stop here so even PreToolUse hooks cannot run for a side question.
      onMessage: message => {
        if (message.type !== 'assistant') return
        const tool = message.message.content.find(block => block.type === 'tool_use')
        if (tool?.type === 'tool_use') throw new Error(`Side questions cannot call ${tool.name}`)
      },
      canUseTool: async () => ({
        behavior: 'deny' as const,
        message: 'Side questions cannot use tools',
        decisionReason: { type: 'other' as const, reason: 'side_question' },
      }),
      querySource: 'side_question',
      forkLabel: 'side_question',
      maxTurns: 1, // Single turn only - no tool use loops
      // No future request shares this suffix; skip writing cache entries.
      skipCacheWrite: true,
    })

    controller.signal.throwIfAborted()
    const response = extractSideQuestionResponse(agentResult.messages)
    if (!response) throw new Error('No response received')
    return { response, usage: agentResult.totalUsage }
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

/**
 * Extract a display string from forked agent messages.
 *
 * IMPORTANT: claude.ts yields one AssistantMessage PER CONTENT BLOCK, not one
 * per API response. With adaptive thinking enabled (inherited from the main
 * thread to preserve the cache key), a thinking response arrives as:
 *   messages[0] = assistant { content: [thinking_block] }
 *   messages[1] = assistant { content: [text_block] }
 *
 * The old code used `.find(m => m.type === 'assistant')` which grabbed the
 * first (thinking-only) message, found no text block, and returned null →
 * "No response received". Repos with large context (many skills, big CLAUDE.md)
 * trigger thinking more often, which is why this reproduced in the monorepo
 * but not here.
 *
 * Secondary failure modes also surfaced as "No response received":
 *   - Model attempts tool_use → content = [thinking, tool_use], no text.
 *     Rare — the system-reminder usually prevents this, but handled here.
 *   - API error exhausts retries → query yields system api_error + user
 *     interruption, no assistant message at all.
 */
function extractSideQuestionResponse(messages: Message[]): string | null {
  const assistantError = messages.find(message => message.type === 'assistant' && message.isApiErrorMessage)
  if (assistantError?.type === 'assistant') throw new Error(extractTextContent(assistantError.message.content, '\n').trim() || 'Side question failed')
  const apiError = messages.find((message): message is SystemAPIErrorMessage => message.type === 'system' && message.subtype === 'api_error')
  // Flatten all assistant content blocks across the per-block messages.
  const assistantBlocks = messages.flatMap(m =>
    m.type === 'assistant' ? m.message.content : [],
  )

  if (assistantBlocks.length > 0) {
    // Concatenate all text blocks (there's normally at most one, but be safe).
    const text = extractTextContent(assistantBlocks, '\n\n').trim()
    if (text) return text

    // No text — check if the model tried to call a tool despite instructions.
    const toolUse = assistantBlocks.find(b => b.type === 'tool_use')
    if (toolUse) {
      const toolName = 'name' in toolUse ? toolUse.name : 'a tool'
      throw new Error(`The model tried to call ${toolName} instead of answering directly. Try rephrasing or ask in the main conversation.`)
    }
  }

  if (apiError) throw new Error(formatAPIError(apiError.error))
  return null
}
