/**
 * Title Service — AI-powered session title generation
 *
 * Two-stage approach matching the CLI:
 * 1. deriveTitle() — instant placeholder from first user message
 * 2. generateTitle() — async Haiku call for a polished 3-7 word title
 */

import { ProviderService } from './providerService.js'
import { loadNetworkSettings } from './networkSettings.js'
import { sessionService } from './sessionService.js'
import { isOpenAIOfficialProviderId } from './openaiOfficialProvider.js'
import { isDeepSeekAccountProviderId } from './deepseekAccountProvider.js'
import { providerTextCompletion } from './providerTextCompletion.js'
import { cleanSessionTitleSource, hasSessionTitleMarkup } from '../../utils/sessionTitleText.js'
import { extractConversationText, SESSION_TITLE_PROMPT } from '../../utils/sessionTitle.js'

const TITLE_MAX_LEN = 50
// Thinking models that ignore (or silently drop) `thinking: disabled` spend the
// whole budget on reasoning: the text block comes back empty, parsing yields
// null, and the session keeps the first-message placeholder forever (#1340).
// 100 was only enough for a title with no reasoning in front of it; 2048 leaves
// headroom for the thinking burn while staying trivial for a 3-7 word title.
const TITLE_MAX_OUTPUT_TOKENS = 2048
const TITLE_INPUT_MAX_LEN = 2000

export type TitleLanguagePreference = {
  language: string
  source: 'first-user-message' | 'response-language'
}

export type TitleConversationTurn = {
  userText: string
  assistantText?: string
}

export function buildConversationTitleInput(turns: TitleConversationTurn[]): string {
  const messages = turns.flatMap((turn) => {
    const entries: any[] = [
      {
        type: 'user',
        message: { content: turn.userText },
      },
    ]
    const assistantText = turn.assistantText?.trim()
    if (assistantText) {
      entries.push({
        type: 'assistant',
        message: { content: assistantText },
      })
    }
    return entries
  })

  return extractConversationText(messages as any)
}

export function resolveTitleLanguagePreference(
  firstUserMessage: string,
  fallbackResponseLanguage?: string,
): TitleLanguagePreference | null {
  const firstUserLanguage = inferLanguageFromText(firstUserMessage)
  if (firstUserLanguage) {
    return {
      language: firstUserLanguage,
      source: 'first-user-message',
    }
  }

  const fallbackLanguage = normalizeResponseLanguage(fallbackResponseLanguage)
  if (!fallbackLanguage) return null
  return {
    language: fallbackLanguage,
    source: 'response-language',
  }
}

function buildTitleUserPrompt(
  trimmed: string,
  languagePreference?: TitleLanguagePreference | null,
  strictLanguage = false,
): string {
  const languageLines = languagePreference
    ? [
        strictLanguage
          ? `The title must be in ${languagePreference.language}.`
          : `Return the title in ${languagePreference.language}.`,
        languagePreference.source === 'first-user-message'
          ? 'This language was inferred from the user\'s first meaningful message; do not translate the title just because the assistant response or examples use another language.'
          : 'Use this response-language setting only because the first user message language is ambiguous.',
        'Keep product names, file names, model names, and code identifiers in their original form.',
        '',
      ]
    : []

  return [
    'Generate a title for the following conversation transcript.',
    'Do not answer, continue, or summarize the conversation itself.',
    'Return only JSON with a single "title" field.',
    ...languageLines,
    '',
    '<conversation>',
    trimmed.slice(0, TITLE_INPUT_MAX_LEN),
    '</conversation>',
  ].join('\n')
}

/**
 * Quick placeholder title derived from user message text.
 * Returns first sentence, collapsed to single line, max 50 chars.
 */
export function deriveTitle(raw: string): string | undefined {
  const clean = cleanSessionTitleSource(raw)
  const firstSentence = /^(.*?[.!?。！？])\s/.exec(clean)?.[1] ?? clean
  const flat = firstSentence.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > TITLE_MAX_LEN
    ? flat.slice(0, TITLE_MAX_LEN - 1) + '\u2026'
    : flat
}

/**
 * Generate an AI title using the session's provider Haiku model when possible.
 * Fire-and-forget — returns null on any failure.
 */
export async function generateTitle(
  conversationText: string,
  providerId?: string | null,
  languagePreference?: TitleLanguagePreference | null,
  /** Conversation the title belongs to; forwarded so gateways can route the call. */
  sessionId?: string,
): Promise<string | null> {
  const trimmed = cleanSessionTitleSource(conversationText)
  if (!trimmed) return null

  try {
    const providerService = new ProviderService()
    const networkSettings = await loadNetworkSettings()
    if (providerId === null) return null

    let resolvedProvider = providerId
      ? await providerService.getProvider(providerId)
      : null

    if (!resolvedProvider) {
      const { activeId, providers } = await providerService.listProviders()
      resolvedProvider = activeId
        ? isOpenAIOfficialProviderId(activeId) || isDeepSeekAccountProviderId(activeId)
          ? await providerService.getProvider(activeId)
          : providers.find((provider) => provider.id === activeId) ?? null
        : null
    }

    if (!resolvedProvider) return null

    const provider = resolvedProvider
    const modelId = provider.models.haiku || provider.models.main
    return await generateTitleWithLanguageRetry(
      async (strictLanguage) => {
        const result = await providerTextCompletion({
          provider,
          modelId,
          system: SESSION_TITLE_PROMPT,
          user: buildTitleUserPrompt(trimmed, languagePreference, strictLanguage),
          maxTokens: TITLE_MAX_OUTPUT_TOKENS,
          sessionId,
          networkSettings,
        })
        if (!result.ok || !result.text) return null
        return parseGeneratedTitleText(result.text)
      },
      languagePreference,
    )
  } catch {
    return null
  }
}

async function generateTitleWithLanguageRetry(
  requestTitle: (strictLanguage: boolean) => Promise<string | null>,
  languagePreference?: TitleLanguagePreference | null,
): Promise<string | null> {
  const first = await requestTitle(false)
  if (!first || isTitleLanguageCompatible(first, languagePreference)) {
    return first
  }

  const retried = await requestTitle(true)
  if (!retried || !isTitleLanguageCompatible(retried, languagePreference)) {
    return null
  }
  return retried
}

function inferLanguageFromText(text: string): string | null {
  const clean = cleanSessionTitleSource(text)
  if (!clean) return null

  if (countMatches(clean, /\p{Script=Hiragana}|\p{Script=Katakana}/gu) >= 2) {
    return 'Japanese'
  }
  if (countMatches(clean, /\p{Script=Hangul}/gu) >= 2) {
    return 'Korean'
  }
  if (countMatches(clean, /\p{Script=Han}/gu) >= 2) {
    return 'Chinese'
  }

  const latinWords = clean.match(/[A-Za-z]{2,}/g) ?? []
  const latinLength = latinWords.join('').length
  if (latinWords.length >= 2 || latinLength >= 6) {
    return 'English'
  }

  return null
}

function normalizeResponseLanguage(language: string | undefined): string | null {
  const clean = language?.trim()
  if (!clean) return null

  const lower = clean.toLowerCase()
  if (lower === 'english' || lower === 'en' || lower.startsWith('en-')) {
    return 'English'
  }
  if (
    lower === 'chinese' ||
    lower === 'zh' ||
    lower.startsWith('zh-') ||
    lower === '中文'
  ) {
    return 'Chinese'
  }
  if (lower === 'japanese' || lower === 'ja' || lower.startsWith('ja-')) {
    return 'Japanese'
  }
  if (lower === 'korean' || lower === 'ko' || lower.startsWith('ko-')) {
    return 'Korean'
  }
  return clean
}

function isTitleLanguageCompatible(
  title: string,
  languagePreference?: TitleLanguagePreference | null,
): boolean {
  if (!languagePreference) return true

  const clean = cleanSessionTitleSource(title)
  const hasHan = /\p{Script=Han}/u.test(clean)
  const hasKana = /\p{Script=Hiragana}|\p{Script=Katakana}/u.test(clean)
  const hasHangul = /\p{Script=Hangul}/u.test(clean)
  const hasLatinWord = /[A-Za-z]{2,}/.test(clean)

  switch (languagePreference.language.toLowerCase()) {
    case 'chinese':
      return hasHan || !hasLatinWord
    case 'japanese':
      return hasKana || hasHan || !hasLatinWord
    case 'korean':
      return hasHangul || !hasLatinWord
    case 'english':
      return hasLatinWord || !(hasHan || hasKana || hasHangul)
    default:
      return true
  }
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

export function parseGeneratedTitleText(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const parsed = parseTitleFromStructuredText(trimmed)
  if (parsed) return normalizeTitle(parsed)

  if (looksLikeStructuredTitleFragment(trimmed)) return null

  return normalizeTitle(trimmed)
}

function parseTitleFromStructuredText(text: string): string | null {
  const candidates = new Set<string>([text])
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim()
  if (fenced) candidates.add(fenced)

  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.add(text.slice(firstBrace, lastBrace + 1))
  }

  for (const candidate of [...candidates]) {
    const unescaped = candidate.replace(/\\"/g, '"').replace(/\\n/g, '\n')
    if (unescaped !== candidate) candidates.add(unescaped)
  }

  for (const candidate of candidates) {
    const title = parseTitleJson(candidate)
    if (title) return title
  }

  return null
}

function parseTitleJson(candidate: string): string | null {
  try {
    const parsed = JSON.parse(candidate)
    if (typeof parsed === 'string') {
      return parseTitleFromStructuredText(parsed)
    }
    if (parsed && typeof parsed === 'object' && typeof (parsed as { title?: unknown }).title === 'string') {
      return (parsed as { title: string }).title
    }
  } catch {
    return null
  }
  return null
}

function normalizeTitle(title: string): string | null {
  const clean = cleanSessionTitleSource(title)
  if (
    !clean ||
    clean.length > 60 ||
    looksLikeStructuredTitleFragment(clean) ||
    hasSessionTitleMarkup(clean)
  ) return null
  return clean
}

function looksLikeStructuredTitleFragment(text: string): boolean {
  return (
    text.includes('```') ||
    text.includes('{') ||
    text.includes('}') ||
    /\\?"title\\?"\s*:/.test(text)
  )
}

/**
 * Persist an AI-generated title to the session's JSONL file.
 * Returns false when a user custom title exists, because custom titles are
 * intentional and must not be replaced by automatic title refreshes.
 */
export async function saveAiTitle(
  sessionId: string,
  title: string,
  persist = sessionService.shouldPersistSession(),
): Promise<boolean> {
  if (await sessionService.getCustomTitle(sessionId)) {
    return false
  }
  if (persist) await sessionService.appendAiTitle(sessionId, title)
  else await sessionService.appendAiTitle(sessionId, title, false)
  return true
}
