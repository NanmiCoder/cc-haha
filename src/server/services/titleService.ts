/**
 * Title Service — AI-powered session title generation
 *
 * Two-stage approach matching the CLI:
 * 1. deriveTitle() — instant placeholder from first user message
 * 2. generateTitle() — async Haiku call for a polished 3-7 word title
 */

import { ProviderService, buildAnthropicAuthHeaders } from './providerService.js'
import { sessionService } from './sessionService.js'
import { hahaOpenAIOAuthService } from './hahaOpenAIOAuthService.js'
import { isOpenAIOfficialProviderId } from './openaiOfficialProvider.js'
import { OPENAI_CODEX_API_ENDPOINT } from '../../services/openaiAuth/client.js'
import { resolveOpenAICodexModel } from '../../services/openaiAuth/models.js'
import { anthropicToOpenaiResponses } from '../proxy/transform/anthropicToOpenaiResponses.js'
import { anthropicToOpenaiChat } from '../proxy/transform/anthropicToOpenaiChat.js'
import { openaiChatToAnthropic } from '../proxy/transform/openaiChatToAnthropic.js'
import { openaiResponsesToAnthropic } from '../proxy/transform/openaiResponsesToAnthropic.js'
import { openaiResponsesStreamToAnthropicResponse } from '../proxy/streaming/openaiResponsesStreamToAnthropicResponse.js'
import type { ApiFormat, ProviderAuthStrategy } from '../types/provider.js'
import type { AnthropicRequest } from '../proxy/transform/types.js'
import { normalizeModelStringForAPI } from '../../utils/model/model.js'
import { getPresetAuthStrategy } from './providerRuntimeEnv.js'
import { cleanSessionTitleSource, hasSessionTitleMarkup } from '../../utils/sessionTitleText.js'
import { extractConversationText, SESSION_TITLE_PROMPT } from '../../utils/sessionTitle.js'

const TITLE_MAX_LEN = 50
const TITLE_MAX_OUTPUT_TOKENS = 100
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
): Promise<string | null> {
  const trimmed = cleanSessionTitleSource(conversationText)
  if (!trimmed) return null

  try {
    const providerService = new ProviderService()
    if (providerId === null) return null

    let resolvedProvider = providerId
      ? await providerService.getProvider(providerId)
      : null

    if (!resolvedProvider) {
      const { activeId, providers } = await providerService.listProviders()
      resolvedProvider = activeId
        ? isOpenAIOfficialProviderId(activeId)
          ? await providerService.getProvider(activeId)
          : providers.find((provider) => provider.id === activeId) ?? null
        : null
    }

    if (resolvedProvider && isOpenAIOfficialProviderId(resolvedProvider.id)) {
      return await generateOpenAIOfficialTitle(
        trimmed,
        resolvedProvider.models.haiku || resolvedProvider.models.main,
        languagePreference,
      )
    }

    if (!resolvedProvider?.baseUrl || !resolvedProvider?.apiKey) return null

    const model = normalizeModelStringForAPI(resolvedProvider.models.haiku || resolvedProvider.models.main)
    const apiFormat: ApiFormat = resolvedProvider.apiFormat ?? 'anthropic'
    const authStrategy: ProviderAuthStrategy =
      resolvedProvider.authStrategy ?? getPresetAuthStrategy(resolvedProvider.presetId)
    const baseUrl = resolvedProvider.baseUrl.replace(/\/+$/, '')

    return await generateTitleWithLanguageRetry(
      async (strictLanguage) => {
        const userContent = buildTitleUserPrompt(trimmed, languagePreference, strictLanguage)
        const response = await fetchTitleText({
          apiFormat,
          authStrategy,
          baseUrl,
          apiKey: resolvedProvider.apiKey,
          model,
          systemPrompt: SESSION_TITLE_PROMPT,
          userContent,
        })
        if (!response) return null
        return parseGeneratedTitleText(response)
      },
      languagePreference,
    )
  } catch {
    return null
  }
}

async function generateOpenAIOfficialTitle(
  trimmed: string,
  model: string,
  languagePreference?: TitleLanguagePreference | null,
): Promise<string | null> {
  const tokens = await hahaOpenAIOAuthService.ensureFreshTokens()
  if (!tokens?.accessToken) return null

  const mappedModel = resolveOpenAICodexModel(model)
  return await generateTitleWithLanguageRetry(
    async (strictLanguage) => {
      const requestBody = anthropicToOpenaiResponses({
        model: mappedModel,
        max_tokens: TITLE_MAX_OUTPUT_TOKENS,
        system: SESSION_TITLE_PROMPT,
        messages: [{
          role: 'user',
          content: buildTitleUserPrompt(trimmed, languagePreference, strictLanguage),
        }],
        stream: true,
        thinking: { type: 'disabled' },
      })
      requestBody.stream = true
      requestBody.max_output_tokens = TITLE_MAX_OUTPUT_TOKENS

      const headers = new Headers()
      headers.set('Content-Type', 'application/json')
      headers.set('Authorization', `Bearer ${tokens.accessToken}`)
      if (tokens.accountId) {
        headers.set('ChatGPT-Account-Id', tokens.accountId)
      }

      const response = await fetch(OPENAI_CODEX_API_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(15_000),
      })

      if (!response.ok || !response.body) return null

      const body = await openaiResponsesStreamToAnthropicResponse(
        response.body,
        mappedModel,
      )
      const text = body.content.find((b) => b.type === 'text')?.text
      if (!text) return null

      return parseGeneratedTitleText(text)
    },
    languagePreference,
  )
}

type FetchTitleInput = {
  apiFormat: ApiFormat
  authStrategy: ProviderAuthStrategy
  baseUrl: string
  apiKey: string
  model: string
  systemPrompt: string
  userContent: string
}

async function fetchTitleText(input: FetchTitleInput): Promise<string | null> {
  if (input.apiFormat === 'openai_chat') {
    return fetchOpenAIChatTitleText(input)
  }
  if (input.apiFormat === 'openai_responses') {
    return fetchOpenAIResponsesTitleText(input)
  }
  return fetchAnthropicTitleText(input)
}

async function fetchAnthropicTitleText(input: FetchTitleInput): Promise<string | null> {
  const url = `${input.baseUrl}/v1/messages`
  const requestHeaders = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...buildAnthropicAuthHeaders(input.apiKey, input.authStrategy),
  }
  const requestBody: Record<string, unknown> = {
    model: input.model,
    max_tokens: TITLE_MAX_OUTPUT_TOKENS,
    system: input.systemPrompt,
    messages: [{ role: 'user', content: input.userContent }],
  }

  // First attempt with thinking disabled. Some providers reject this field
  // with a 4xx error, so retry without it on 4xx.
  let response = await fetch(url, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({
      ...requestBody,
      thinking: { type: 'disabled' },
    }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok && response.status >= 400 && response.status < 500) {
    response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(15_000),
    })
  }

  if (!response.ok) return null

  const body = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>
  }
  return body.content?.find((b) => b.type === 'text')?.text ?? null
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
export async function saveAiTitle(sessionId: string, title: string): Promise<boolean> {
  if (await sessionService.getCustomTitle(sessionId)) {
    return false
  }
  await sessionService.appendAiTitle(sessionId, title)
  return true
}
