/**
 * Title Service — AI-powered session title generation
 *
 * Two-stage approach matching the CLI:
 * 1. deriveTitle() — instant placeholder from first user message
 * 2. generateTitle() — async Haiku call for a polished 3-7 word title
 */

import { ProviderService } from './providerService.js'
import { sessionService } from './sessionService.js'

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
  const clean = raw.replace(/<[^>]+>[^<]*<\/[^>]+>/g, '').trim()
  const firstSentence = /^(.*?[.!?。！？])\s/.exec(clean)?.[1] ?? clean
  const flat = firstSentence.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > TITLE_MAX_LEN
    ? flat.slice(0, TITLE_MAX_LEN - 1) + '\u2026'
    : flat
}

/**
 * Generate an AI title using the active provider's Haiku model.
 * Fire-and-forget — returns null on any failure.
 */
export async function generateTitle(conversationText: string): Promise<string | null> {
  const trimmed = conversationText.trim()
  if (!trimmed) return null

  try {
    const providerService = new ProviderService()
    const { activeId, providers } = await providerService.listProviders()
    if (!activeId) return null

    const provider = providers.find((p) => p.id === activeId)
    if (!provider?.baseUrl || !provider?.apiKey) return null

    const model = provider.models.haiku || provider.models.main
    const url = `${provider.baseUrl.replace(/\/+$/, '')}/v1/messages`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 100,
        system: TITLE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: trimmed.slice(0, 2000) }],
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!response.ok) return null

    const body = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>
    }
    const text = body.content?.find((b) => b.type === 'text')?.text
    if (!text) return null

    // Parse JSON response
    const match = text.match(/\{[^}]*"title"\s*:\s*"([^"]+)"[^}]*\}/)
    if (match?.[1]) return match[1].trim()

    // Fallback: if model returned plain text instead of JSON
    const plain = text.trim()
    if (plain.length > 0 && plain.length <= 60) return plain

    return null
  } catch {
    return null
  }
}

/**
 * Persist an AI-generated title to the session's JSONL file.
 */
export async function saveAiTitle(sessionId: string, title: string): Promise<void> {
  await sessionService.appendAiTitle(sessionId, title)
}
