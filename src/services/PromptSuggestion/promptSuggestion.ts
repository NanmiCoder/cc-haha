import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { count } from '../../utils/array.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { toError } from '../../utils/errors.js'
import {
  type CacheSafeParams,
  createCacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import { logError } from '../../utils/log.js'
import {
  createUserMessage,
  getLastAssistantMessage,
} from '../../utils/messages.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { isTeammate } from '../../utils/teammate.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { currentLimits } from '../claudeAiLimits.js'
import { isSpeculationEnabled, startSpeculation } from './speculation.js'

let currentAbortController: AbortController | null = null

export type PromptVariant = 'user_intent' | 'stated_intent'

export function getPromptVariant(): PromptVariant {
  return 'user_intent'
}

export function shouldEnablePromptSuggestion(): boolean {
  // Env var overrides everything (for testing)
  const envOverride = process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION
  if (isEnvDefinedFalsy(envOverride)) {
    logEvent('tengu_prompt_suggestion_init', {
      enabled: false,
      source:
        'env' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return false
  }
  if (isEnvTruthy(envOverride)) {
    logEvent('tengu_prompt_suggestion_init', {
      enabled: true,
      source:
        'env' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return true
  }

  // Keep default in sync with Config.tsx (settings toggle visibility)
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_chomp_inflection', false)) {
    logEvent('tengu_prompt_suggestion_init', {
      enabled: false,
      source:
        'growthbook' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return false
  }

  // Disable in non-interactive mode (print mode, piped input, SDK)
  if (getIsNonInteractiveSession()) {
    logEvent('tengu_prompt_suggestion_init', {
      enabled: false,
      source:
        'non_interactive' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return false
  }

  // Disable for swarm teammates (only leader should show suggestions)
  if (isAgentSwarmsEnabled() && isTeammate()) {
    logEvent('tengu_prompt_suggestion_init', {
      enabled: false,
      source:
        'swarm_teammate' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return false
  }

  const enabled = getInitialSettings()?.promptSuggestionEnabled !== false
  logEvent('tengu_prompt_suggestion_init', {
    enabled,
    source:
      'setting' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  return enabled
}

/**
 * True when a queued command came from the user typing a prompt, as opposed
 * to task notifications, teammate/channel deliveries, scheduled tasks, host
 * notices or other system-injected turns.
 */
export function isUserStartedCommand(
  command: Pick<QueuedCommand, 'mode' | 'isMeta' | 'isSynthetic' | 'origin'>,
): boolean {
  if (command.mode !== 'prompt' || command.isMeta || command.isSynthetic) {
    return false
  }
  return command.origin === undefined || command.origin.kind === 'human'
}

export function abortPromptSuggestion(): void {
  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
  }
}

/**
 * Returns a suppression reason if suggestions should not be generated,
 * or null if generation is allowed. Shared by main and pipelined paths.
 */
export function getSuggestionSuppressReason(appState: AppState): string | null {
  if (!appState.promptSuggestionEnabled) return 'disabled'
  if (appState.pendingWorkerRequest || appState.pendingSandboxRequest)
    return 'pending_permission'
  if (appState.elicitation.queue.length > 0) return 'elicitation_active'
  if (appState.toolPermissionContext.mode === 'plan') return 'plan_mode'
  if (
    process.env.USER_TYPE === 'external' &&
    currentLimits.status !== 'allowed'
  )
    return 'rate_limit'
  return null
}

/**
 * Shared guard + generation logic used by both CLI TUI and SDK push paths.
 * Returns the suggestion with metadata, or null if suppressed/filtered.
 */
export async function tryGenerateSuggestion(
  abortController: AbortController,
  messages: Message[],
  getAppState: () => AppState,
  cacheSafeParams: CacheSafeParams,
  source?: 'cli' | 'sdk',
): Promise<{
  suggestion: string
  promptId: PromptVariant
  generationRequestId: string | null
} | null> {
  if (abortController.signal.aborted) {
    logSuggestionSuppressed('aborted', undefined, undefined, source)
    return null
  }

  const assistantTurnCount = count(messages, m => m.type === 'assistant')
  if (assistantTurnCount < 2) {
    logSuggestionSuppressed('early_conversation', undefined, undefined, source)
    return null
  }

  const lastAssistantMessage = getLastAssistantMessage(messages)
  if (lastAssistantMessage?.isApiErrorMessage) {
    logSuggestionSuppressed('last_response_error', undefined, undefined, source)
    return null
  }
  const cacheReason = getParentCacheSuppressReason(lastAssistantMessage)
  if (cacheReason) {
    logSuggestionSuppressed(cacheReason, undefined, undefined, source)
    return null
  }

  const appState = getAppState()
  const suppressReason = getSuggestionSuppressReason(appState)
  if (suppressReason) {
    logSuggestionSuppressed(suppressReason, undefined, undefined, source)
    return null
  }

  const promptId = getPromptVariant()
  const { suggestion, generationRequestId } = await generateSuggestion(
    abortController,
    promptId,
    cacheSafeParams,
  )
  if (abortController.signal.aborted) {
    logSuggestionSuppressed('aborted', undefined, undefined, source)
    return null
  }
  if (!suggestion) {
    logSuggestionSuppressed('empty', undefined, promptId, source)
    return null
  }
  if (shouldFilterSuggestion(suggestion, promptId, source)) return null

  return { suggestion, promptId, generationRequestId }
}

export async function executePromptSuggestion(
  context: REPLHookContext,
): Promise<void> {
  if (context.querySource !== 'repl_main_thread') return

  currentAbortController = new AbortController()
  const abortController = currentAbortController
  const cacheSafeParams = createCacheSafeParams(context)

  try {
    const result = await tryGenerateSuggestion(
      abortController,
      context.messages,
      context.toolUseContext.getAppState,
      cacheSafeParams,
      'cli',
    )
    if (!result) return

    context.toolUseContext.setAppState(prev => ({
      ...prev,
      promptSuggestion: {
        text: result.suggestion,
        promptId: result.promptId,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: result.generationRequestId,
      },
    }))

    if (isSpeculationEnabled() && result.suggestion) {
      void startSpeculation(
        result.suggestion,
        context,
        context.toolUseContext.setAppState,
        false,
        cacheSafeParams,
      )
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'APIUserAbortError')
    ) {
      logSuggestionSuppressed('aborted', undefined, undefined, 'cli')
      return
    }
    logError(toError(error))
  } finally {
    if (currentAbortController === abortController) {
      currentAbortController = null
    }
  }
}

const MAX_PARENT_UNCACHED_TOKENS = 10_000

export function getParentCacheSuppressReason(
  lastAssistantMessage: ReturnType<typeof getLastAssistantMessage>,
): string | null {
  if (!lastAssistantMessage) return null

  const usage = lastAssistantMessage.message.usage
  const inputTokens = usage.input_tokens ?? 0
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
  // The fork re-processes the parent's output (never cached) plus its own prompt.
  const outputTokens = usage.output_tokens ?? 0

  return inputTokens + cacheWriteTokens + outputTokens >
    MAX_PARENT_UNCACHED_TOKENS
    ? 'cache_cold'
    : null
}

const SUGGESTION_PROMPT = `[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
User asked "fix the bug and run tests", bug is fixed → "run the tests"
After code written → "try it out"
Claude offers options → suggest the one the user would likely pick, based on conversation
Claude asks to continue → "yes" or "go ahead"
Task complete, obvious follow-up → "commit this" or "push it"
After error or misunderstanding → silence (let them assess/correct)

Be specific: "run the tests" beats "continue".

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Claude-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Stay silent if a suggestion could be unsafe or inappropriate — including any sensitive topic (security incidents, credentials, harm, private data). Even when the user is doing legitimate security or cybersecurity work, do not predict potentially unsafe actions.

Format: 2-12 words in the language the user writes in, matching their style. Or nothing.

Reply with ONLY the suggestion, no quotes or explanation.`

const SUGGESTION_PROMPTS: Record<PromptVariant, string> = {
  user_intent: SUGGESTION_PROMPT,
  stated_intent: SUGGESTION_PROMPT,
}

export async function generateSuggestion(
  abortController: AbortController,
  promptId: PromptVariant,
  cacheSafeParams: CacheSafeParams,
): Promise<{ suggestion: string | null; generationRequestId: string | null }> {
  const prompt = SUGGESTION_PROMPTS[promptId]

  // Deny tools via callback, NOT by passing tools:[] - that busts cache (0% hit)
  const canUseTool = async () => ({
    behavior: 'deny' as const,
    message: 'No tools needed for suggestion',
    decisionReason: { type: 'other' as const, reason: 'suggestion only' },
  })

  // DO NOT override any API parameter that differs from the parent request.
  // The fork piggybacks on the main thread's prompt cache by sending identical
  // cache-key params. The billing cache key includes more than just
  // system/tools/model/messages/thinking — empirically, setting effortValue
  // or maxOutputTokens on the fork (even via output_config or getAppState)
  // busts cache. PR #18143 tried effort:'low' and caused a 45x spike in cache
  // writes (92.7% → 61% hit rate). The only safe overrides are:
  //   - abortController (not sent to API)
  //   - skipTranscript (client-side only)
  //   - skipCacheWrite (controls cache_control markers, not the cache key)
  //   - canUseTool (client-side permission check)
  const result = await runForkedAgent({
    promptMessages: [createUserMessage({ content: prompt })],
    cacheSafeParams, // Don't override tools/thinking settings - busts cache
    canUseTool,
    querySource: 'prompt_suggestion',
    forkLabel: 'prompt_suggestion',
    overrides: {
      abortController,
    },
    skipTranscript: true,
    skipCacheWrite: true,
  })

  // Check ALL messages - model may loop (try tool → denied → text in next message)
  // Also extract the requestId from the first assistant message for RL dataset joins
  const firstAssistantMsg = result.messages.find(m => m.type === 'assistant')
  const generationRequestId =
    firstAssistantMsg?.type === 'assistant'
      ? (firstAssistantMsg.requestId ?? null)
      : null

  for (const msg of result.messages) {
    if (msg.type !== 'assistant' || msg.isApiErrorMessage) continue
    const textBlock = msg.message.content.find(b => b.type === 'text')
    if (textBlock?.type === 'text') {
      const suggestion = cleanSuggestionCandidate(textBlock.text)
      if (suggestion) {
        return { suggestion, generationRequestId }
      }
    }
  }

  return { suggestion: null, generationRequestId }
}

/**
 * Strip wrappers and labels models add around the bare suggestion, e.g.
 * `<suggestion>run the tests</suggestion>` or `建议：运行测试`.
 */
export function cleanSuggestionCandidate(text: string): string {
  return text
    .trim()
    .replace(
      /^<(suggestion|response|output|answer|result)>([\s\S]*)<\/\1>$/i,
      (whole, tag: string, inner: string) =>
        inner.toLowerCase().includes(`</${tag.toLowerCase()}>`) ? whole : inner,
    )
    .replace(
      /^\s*(suggested\s+(response|reply|input|prompt)|suggestion|response|reply|answer|output|result|提案|回答|返信|応答|出力|結果|建议|回复|答案|输出|结果|제안|답변|응답|출력|결과)\s*[:：]\s*/i,
      '',
    )
    .trim()
}

const HAN_CHAR = /\p{Script=Han}/u
const PHONETIC_CHAR =
  /[\p{Script=Hiragana}\p{Script=Katakana}ーｰ\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u
const HANGUL_CHAR = /\p{Script=Hangul}/u
const OTHER_WORD_CHAR = /[\p{L}\p{N}]/u

function countScripts(text: string): {
  han: number
  phonetic: number
  hangul: number
  other: number
} {
  const counts = { han: 0, phonetic: 0, hangul: 0, other: 0 }
  for (const char of text) {
    if (HAN_CHAR.test(char)) counts.han++
    else if (PHONETIC_CHAR.test(char)) counts.phonetic++
    else if (HANGUL_CHAR.test(char)) counts.hangul++
    else if (OTHER_WORD_CHAR.test(char)) counts.other++
  }
  return counts
}

function countCjkChars(text: string): number {
  const { han, phonetic, hangul } = countScripts(text)
  return han + phonetic + hangul
}

/**
 * Whitespace word count that also works for scripts written without spaces:
 * a Han character counts as half a word and kana/Thai-like characters as a
 * quarter, so "运行测试" counts as 2 words instead of 1.
 */
export function countSuggestionWords(text: string): number {
  const trimmed = text.trim()
  if (trimmed === '') return 0
  let words = 0
  for (const token of trimmed.split(/\s+/)) {
    const { han, phonetic, hangul, other } = countScripts(token)
    words +=
      han === 0 && phonetic === 0
        ? 1
        : (other + hangul > 0 ? 1 : 0) + han / 2 + phonetic / 4
  }
  return Math.ceil(words)
}

export function shouldFilterSuggestion(
  suggestion: string | null,
  promptId: PromptVariant,
  source?: 'cli' | 'sdk',
): boolean {
  if (!suggestion) {
    logSuggestionSuppressed('empty', undefined, promptId, source)
    return true
  }

  const lower = suggestion.toLowerCase()
  const wordCount = countSuggestionWords(suggestion)

  const filters: Array<[string, () => boolean]> = [
    [
      'done',
      () =>
        lower === 'done' ||
        /^\P{L}*(完了(しました)?|完成了?|완료됨?)\P{L}*$/u.test(suggestion),
    ],
    [
      'meta_text',
      () =>
        lower === 'nothing found' ||
        lower === 'nothing found.' ||
        lower.startsWith('nothing to suggest') ||
        lower.startsWith('no suggestion') ||
        // Model spells out the prompt's "stay silent" instruction
        /\bsilence is\b|\bstay(s|ing)? silent\b/.test(lower) ||
        // Model outputs bare "silence" wrapped in punctuation/whitespace
        /^\W*silence\W*$/.test(lower) ||
        /^\P{L}*(沈黙|沉默|静默|침묵|提案(なし|はありません)|特に(なし|ありません)|[无没沒]有?建[议議]|(제안|해당)\s*없음)\P{L}*$/u.test(
          suggestion,
        ) ||
        // Phrasings around the same meta reply ("保持沉默", "暂无建议",
        // "没有明显的下一步") that a user would never type as a message.
        /沈黙|沉默|静默|침묵|(暂无|暫無|没有|沒有|无|無|不需要|不用)(明显的|明顯的|其他|任何|更多)?(建[议議]|下一步)/u.test(
          suggestion,
        ),
    ],
    [
      'meta_wrapped',
      // Model wraps meta-reasoning in parens/brackets: (silence — ...), [no suggestion]
      () =>
        /^(\(.*\)|\[.*\]|（.*）|［.*］|【.*】|〔.*〕)$/.test(suggestion),
    ],
    [
      'error_message',
      () =>
        lower.startsWith('api error:') ||
        lower.startsWith('prompt is too long') ||
        lower.startsWith('request timed out') ||
        lower.startsWith('invalid api key') ||
        lower.startsWith('image was too large'),
    ],
    ['prefixed_label', () => /^\w+:\s/.test(suggestion)],
    [
      'too_few_words',
      () => {
        if (wordCount >= 2) return false
        // Allow slash commands — these are valid user commands
        if (suggestion.startsWith('/')) return false
        // CJK text needs at least two characters ("提交" is fine, "好" is not)
        const cjkChars = countCjkChars(suggestion)
        if (cjkChars > 0) return cjkChars < 2
        // Allow common single-word inputs that are valid user commands
        const ALLOWED_SINGLE_WORDS = new Set([
          // Affirmatives
          'yes',
          'yeah',
          'yep',
          'yea',
          'yup',
          'sure',
          'ok',
          'okay',
          // Actions
          'push',
          'commit',
          'deploy',
          'stop',
          'continue',
          'check',
          'exit',
          'quit',
          // Negation
          'no',
        ])
        return !ALLOWED_SINGLE_WORDS.has(lower)
      },
    ],
    ['too_many_words', () => wordCount > 12],
    ['too_long', () => suggestion.length >= 100],
    [
      'multiple_sentences',
      () => /[.!?]\s+[A-Z]|[。！？]\s*[\p{L}\p{N}]/u.test(suggestion),
    ],
    ['has_formatting', () => /[\n*]|\*\*/.test(suggestion)],
    [
      'evaluative',
      () =>
        /thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent/.test(
          lower,
        ) ||
        /^\P{L}*(ありがとう(ございます|ございました)?|助かりました|[谢謝][谢謝][你您]?|感谢[你您]?|感謝します|감사합니다|고마워요?)(\P{L}|的|$)/u.test(
          suggestion,
        ) ||
        /(良さそう|よさそう|いいですね|看起来不错|太好了|完璧|完美|좋네요)(です|ですね|だね)?\P{L}*$/u.test(
          suggestion,
        ),
    ],
    [
      'claude_voice',
      () =>
        /^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly|让我(?!们)|我来|我会|我将)/i.test(
          suggestion,
        ),
    ],
  ]

  for (const [reason, check] of filters) {
    if (check()) {
      logSuggestionSuppressed(reason, suggestion, promptId, source)
      return true
    }
  }

  return false
}

/**
 * Log acceptance/ignoring of a prompt suggestion. Used by the SDK push path
 * to track outcomes when the next user message arrives.
 */
export function logSuggestionOutcome(
  suggestion: string,
  userInput: string,
  emittedAt: number,
  promptId: PromptVariant,
  generationRequestId: string | null,
): void {
  const similarity =
    Math.round((userInput.length / (suggestion.length || 1)) * 100) / 100
  const wasAccepted = userInput === suggestion
  const timeMs = Math.max(0, Date.now() - emittedAt)

  logEvent('tengu_prompt_suggestion', {
    source: 'sdk' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    outcome: (wasAccepted
      ? 'accepted'
      : 'ignored') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    prompt_id:
      promptId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(generationRequestId && {
      generationRequestId:
        generationRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    ...(wasAccepted && {
      timeToAcceptMs: timeMs,
    }),
    ...(!wasAccepted && { timeToIgnoreMs: timeMs }),
    similarity,
    ...(process.env.USER_TYPE === 'ant' && {
      suggestion:
        suggestion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      userInput:
        userInput as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
  })
}

export function logSuggestionSuppressed(
  reason: string,
  suggestion?: string,
  promptId?: PromptVariant,
  source?: 'cli' | 'sdk',
): void {
  const resolvedPromptId = promptId ?? getPromptVariant()
  logEvent('tengu_prompt_suggestion', {
    ...(source && {
      source:
        source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    outcome:
      'suppressed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    reason:
      reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    prompt_id:
      resolvedPromptId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(process.env.USER_TYPE === 'ant' &&
      suggestion && {
        suggestion:
          suggestion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
  })
}
