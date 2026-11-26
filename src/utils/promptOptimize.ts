/**
 * Composer Prompt Optimization — rewrites the user's draft prompt into a
 * clearer, more specific instruction while sharing the current session's
 * conversation context and prompt cache.
 *
 * Uses runForkedAgent with the parent's cacheSafeParams (same pattern as
 * promptSuggestion and sideQuestion) so the API prefix hits prompt cache,
 * sees the active conversation context, executes zero tools, and leaves the
 * main conversation and transcript completely untouched.
 */

import { formatAPIError } from '../services/api/errorUtils.js'
import { renderOptimizeDraft, type OptimizeDraft } from '../shared/promptOptimizeReferences.js'
import type { NonNullableUsage } from '../services/api/logging.js'
import type { Message, SystemAPIErrorMessage } from '../types/message.js'
import { type CacheSafeParams, runForkedAgent } from './forkedAgent.js'
import { createUserMessage, extractTextContent } from './messages.js'
import { prepareSideQuestionContext } from './sideQuestion.js'

export type PromptOptimizeResult = {
  optimizedPrompt: string
  usage: NonNullableUsage
}

/**
 * Pick an XML wrapper tag name that does not appear inside the draft so a
 * closing tag in user text cannot escape the draft block.
 */
function chooseDraftTag(draft: string): string {
  let tag = 'user_draft'
  let suffix = 1
  while (draft.includes(`</${tag}>`) || draft.includes(`<${tag}>`)) {
    tag = `user_draft_${suffix++}`
  }
  return tag
}

export function buildPromptOptimizeUserMessage(draft: string): string {
  const tag = chooseDraftTag(draft)
  return `<system-reminder>PROMPT OPTIMIZATION MODE. Rewrite the user's draft prompt inside <${tag}>...</${tag}> so it is clearer, more specific, and easier for an AI coding assistant to execute accurately.

CRITICAL RULES:
- Do NOT execute, answer, or fulfill the draft. ONLY output the rewritten prompt itself.
- You have NO tools available. Do NOT call any tools or promise to inspect, edit, or run anything.
- Use the conversation history and project context already in this session to resolve ambiguous pronouns or implicit references (such as files, symbols, errors, or decisions already discussed) when directly relevant.
- Preserve the user's original intent and scope — do NOT invent unrequested features, unrelated requirements, or verbose filler.
- Match the draft's language exactly (e.g. Chinese stays Chinese, English stays English).
- Keep length proportional to the task: concise and direct for simple requests; cleanly structured (goal, key constraints/context, expected outcome or verification) for multi-part requests.
- Preserve every @mention token (for example @ChatInput.tsx or @skill-name), file path, symbol name, error message, and code snippet verbatim.
- Keep any attached reference marker (for example [[ref:0]]) immediately after its @mention when rewriting or moving it.
- Reply with ONLY the optimized prompt text — no preamble, no commentary, no surrounding quotes, and no outer markdown code fence.</system-reminder>

<${tag}>
${draft}
</${tag}>`
}

/**
 * Strip accidental wrappers or meta-labels models occasionally add around the
 * rewritten prompt while leaving internal code blocks intact.
 */
export function cleanOptimizedPrompt(raw: string): string {
  let text = raw.trim()
  if (!text) return ''

  // Strip a single outer XML wrapper such as <optimized_prompt>...</optimized_prompt>.
  text = text.replace(
    /^<(optimized_prompt|rewritten_prompt|prompt|output|result)>([\s\S]*)<\/\1>$/i,
    (whole, tag: string, inner: string) =>
      inner.toLowerCase().includes(`</${tag.toLowerCase()}>`) ? whole : inner.trim(),
  )

  // Strip a leading label line or prefix (e.g. "优化后的提示词：" / "Optimized prompt:").
  text = text.replace(
    /^\s*(?:optimized\s+prompt|rewritten\s+prompt|improved\s+prompt|prompt|优化后的提示词|優化後的提示詞|改进后的提示词|改進後的提示詞|最適化されたプロンプト|최적화된\s*프롬프트)\s*[:：]\s*/i,
    '',
  ).trim()

  // Strip a single outer markdown fence only when it wraps the entire output
  // with no inner fence before the final closing backticks.
  const fenceMatch = text.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```$/)
  if (fenceMatch && !fenceMatch[1]!.includes('```')) {
    text = fenceMatch[1]!.trim()
  }

  return text
}

function extractPromptOptimizeResponse(messages: Message[]): string | null {
  const assistantError = messages.find(
    message => message.type === 'assistant' && message.isApiErrorMessage,
  )
  if (assistantError?.type === 'assistant') {
    throw new Error(
      extractTextContent(assistantError.message.content, '\n').trim() ||
        'Prompt optimization failed',
    )
  }
  const apiError = messages.find(
    (message): message is SystemAPIErrorMessage =>
      message.type === 'system' && message.subtype === 'api_error',
  )

  // claude.ts yields one AssistantMessage per content block (thinking, then text).
  const assistantBlocks = messages.flatMap(message =>
    message.type === 'assistant' ? message.message.content : [],
  )

  if (assistantBlocks.length > 0) {
    const text = cleanOptimizedPrompt(extractTextContent(assistantBlocks, '\n\n'))
    if (text) return text

    const toolUse = assistantBlocks.find(block => block.type === 'tool_use')
    if (toolUse) {
      const toolName = 'name' in toolUse ? toolUse.name : 'a tool'
      throw new Error(
        `Prompt optimization cannot call ${toolName}. Please try again.`,
      )
    }
  }

  if (apiError) throw new Error(formatAPIError(apiError.error))
  return null
}

/**
 * Run prompt optimization using a cache-sharing forked agent.
 * Shares the parent's prompt cache — no thinking/tools/output-token override,
 * no cache write, no transcript writes, all tools blocked, capped at 1 turn.
 */
export async function runPromptOptimize({
  prompt,
  cacheSafeParams,
  signal,
}: {
  prompt: OptimizeDraft
  cacheSafeParams: CacheSafeParams
  signal?: AbortSignal
}): Promise<PromptOptimizeResult> {
  signal?.throwIfAborted()
  const trimmed = renderOptimizeDraft(prompt).trim()
  if (!trimmed) {
    throw new Error('Prompt must not be empty')
  }

  const controller = new AbortController()
  const cancel = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  controller.signal.throwIfAborted()

  const wrappedPrompt = buildPromptOptimizeUserMessage(trimmed)

  try {
    const agentResult = await runForkedAgent({
      promptMessages: [createUserMessage({ content: wrappedPrompt })],
      // Do NOT override tools/thinkingConfig/maxOutputTokens — diverging from
      // the parent request busts the prompt cache.
      cacheSafeParams: {
        ...cacheSafeParams,
        forkContextMessages: prepareSideQuestionContext(
          cacheSafeParams.forkContextMessages,
        ),
      },
      overrides: { abortController: controller, requireCanUseTool: true },
      skipTranscript: true,
      // Stop before tool dispatch so even PreToolUse hooks cannot run.
      onMessage: message => {
        if (message.type !== 'assistant') return
        const tool = message.message.content.find(
          block => block.type === 'tool_use',
        )
        if (tool?.type === 'tool_use') {
          throw new Error(`Prompt optimization cannot call ${tool.name}`)
        }
      },
      canUseTool: async () => ({
        behavior: 'deny' as const,
        message: 'Prompt optimization cannot use tools',
        decisionReason: { type: 'other' as const, reason: 'prompt_optimize' },
      }),
      querySource: 'prompt_optimize',
      forkLabel: 'prompt_optimize',
      maxTurns: 1,
      skipCacheWrite: true,
    })

    controller.signal.throwIfAborted()
    const optimizedPrompt = extractPromptOptimizeResponse(agentResult.messages)
    if (!optimizedPrompt) throw new Error('No optimized prompt received')
    return { optimizedPrompt, usage: agentResult.totalUsage }
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}
