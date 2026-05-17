/**
 * Title Service — AI-powered session title generation
 *
 * Two-stage approach matching the CLI:
 * 1. deriveTitle() — instant placeholder from first user message
 * 2. generateTitle() — async Haiku call for a polished 3-7 word title
 */

import { ProviderService } from './providerService.js'
import { SettingsService } from './settingsService.js'
import { sessionService } from './sessionService.js'
import { cleanSessionTitleSource, hasSessionTitleMarkup } from '../../utils/sessionTitleText.js'

const TITLE_MAX_LEN = 50

const TITLE_SYSTEM_PROMPT = `Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session. The title should be clear enough that the user recognizes the session in a list. Use sentence case: capitalize only the first word and proper nouns.

Return JSON with a single "title" field.

Good examples:
{"title": "Fix login button on mobile"}
{"title": "Add OAuth authentication"}
{"title": "Debug failing CI tests"}
{"title": "Refactor API client error handling"}

Bad (too vague): {"title": "Code changes"}
Bad (too long): {"title": "Investigate and fix the issue where the login button does not respond on mobile devices"}
Bad (wrong case): {"title": "Fix Login Button On Mobile"}`

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
        ? providers.find((provider) => provider.id === activeId) ?? null
        : null
    }

    if (!resolvedProvider?.baseUrl || !resolvedProvider?.apiKey) return null

    const model = resolvedProvider.models.haiku || resolvedProvider.models.main
    const url = `${resolvedProvider.baseUrl.replace(/\/+$/, '')}/v1/messages`
    const shouldDisableThinking = await shouldDisableThinkingForTitle()

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': resolvedProvider.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 100,
        system: TITLE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: trimmed.slice(0, 2000) }],
        ...(shouldDisableThinking && { thinking: { type: 'disabled' } }),
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!response.ok) return null

    const body = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>
    }
    const text = body.content?.find((b) => b.type === 'text')?.text
    if (!text) return null

    return parseGeneratedTitleText(text)
  } catch {
    return null
  }
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

async function shouldDisableThinkingForTitle(): Promise<boolean> {
  const settings = await new SettingsService().getUserSettings()
  return settings.alwaysThinkingEnabled === false
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
