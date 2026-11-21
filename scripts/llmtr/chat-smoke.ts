/**
 * One Chat Completions call through the LLMTR preset and the app's OpenAI
 * Chat request path.
 *
 * Source entry, from the repository root:
 *   LLMTR_API_KEY=... bun --no-env-file run scripts/llmtr/chat-smoke.ts
 * The parent artifact is `bun build` of this file, so it does not need the checkout.
 *   LLMTR_MODEL=minimax/minimax-m3.1-flash   optional full model id
 *
 * This is not a standalone client. It loads the bundled LLMTR preset and
 * builds the body with anthropicToOpenaiChat plus buildOpenaiEndpoint, the
 * same helpers the proxy and provider test use. It sends one request:
 * no tools, max_tokens 64, no retry. The catalog reply ceiling is not the
 * request budget.
 *
 * Reasoning is mandatory and already enabled on the server. This request
 * omits the reasoning parameter. It does not send reasoning:false, a
 * reasoning object, or reasoning_effort.
 *
 * The in-app proxy may resend once if an upstream rejects image input or a
 * reasoning field. This entrypoint does not, and it does not follow redirects.
 *
 * Success requires HTTP success, no error object, and nonempty assistant
 * message text. Empty text and reasoning-only choices are failures.
 *
 * GET /v1/models is public and is not called here. A successful model list
 * does not mean LLMTR_API_KEY is valid.
 */

import { PROVIDER_PRESETS } from '../../src/server/config/providerPresets.js'
import { buildOpenaiEndpoint } from '../../src/server/proxy/openaiEndpoint.js'
import { anthropicToOpenaiChat } from '../../src/server/proxy/transform/anthropicToOpenaiChat.js'
import type { OpenAIChatRequest } from '../../src/server/proxy/transform/types.js'

export const LLMTR_PRESET_ID = 'llmtr'
export const LLMTR_API_KEY_ENV = 'LLMTR_API_KEY'
export const LLMTR_MODEL_ENV = 'LLMTR_MODEL'
export const LLMTR_SMOKE_MAX_TOKENS = 64
export const LLMTR_SMOKE_TIMEOUT_MS = 120_000
export const LLMTR_SMOKE_REDIRECT = 'error' as const
const SMOKE_PROMPT = 'Say "ok" and nothing else.'

export type LlmtrChatSmokeRequest = {
  url: string
  headers: { 'Content-Type': 'application/json'; Authorization: string }
  body: OpenAIChatRequest
}

export function buildLlmtrChatSmokeRequest(options: {
  apiKey: string
  model?: string
}): LlmtrChatSmokeRequest {
  const apiKey = options.apiKey.trim()
  if (!apiKey) throw new Error(`${LLMTR_API_KEY_ENV} is empty`)

  const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === LLMTR_PRESET_ID)
  if (!preset) throw new Error('LLMTR preset is missing from providerPresets.json')
  if (preset.apiFormat !== 'openai_chat') {
    throw new Error(`LLMTR preset apiFormat must stay openai_chat, got ${preset.apiFormat}`)
  }
  if (preset.modelApiFormats?.length) {
    throw new Error('LLMTR preset must not declare per-model format routes')
  }

  const model = options.model?.trim() || preset.defaultModels.main
  if (!model) throw new Error('LLMTR model id is empty')

  const url = buildOpenaiEndpoint(preset.baseUrl, 'chat/completions')
  if (!url.endsWith('/chat/completions') || url.includes('/responses')) {
    throw new Error(`LLMTR chat URL must be Chat Completions, got ${url}`)
  }

  const body = anthropicToOpenaiChat({
    model,
    max_tokens: LLMTR_SMOKE_MAX_TOKENS,
    stream: false,
    messages: [{ role: 'user', content: SMOKE_PROMPT }],
  })
  if (body.tools?.length || body.tool_choice !== undefined) {
    throw new Error('LLMTR smoke must not send tools')
  }
  if ('reasoning' in body || body.reasoning_effort !== undefined || body.thinking !== undefined) {
    throw new Error('LLMTR smoke must not send a reasoning object or reasoning fields')
  }
  if (body.max_tokens !== LLMTR_SMOKE_MAX_TOKENS || body.model !== model) {
    throw new Error('LLMTR smoke dropped the model id or max_tokens')
  }

  return {
    url,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body,
  }
}

function redactSecret(text: string, secret: string): string {
  if (secret.length < 8 || !text.includes(secret)) return text
  return text.split(secret).join('***')
}

function assistantMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const record = part as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') text += record.text
  }
  return text
}

/**
 * Assistant text only. Reasoning fields and empty choices do not count.
 * Returns '' when the payload has an error object or no usable text.
 */
export function llmtrSmokeAssistantText(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
  const record = payload as Record<string, unknown>
  if (record.error != null && record.error !== false) return ''
  const choices = record.choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const choice = choices[0]
  if (!choice || typeof choice !== 'object') return ''
  const message = (choice as Record<string, unknown>).message
  if (!message || typeof message !== 'object') return ''
  return assistantMessageText((message as Record<string, unknown>).content).trim()
}

export function classifyLlmtrSmokePayload(payload: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'Response is not a Chat Completions object' }
  }
  const record = payload as Record<string, unknown>
  if (record.error != null && record.error !== false) {
    return { ok: false, reason: 'Chat Completions response contains an error' }
  }
  const choices = record.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    return { ok: false, reason: 'Response is not a Chat Completions choices payload' }
  }
  const text = llmtrSmokeAssistantText(payload)
  if (!text) return { ok: false, reason: 'Assistant message text is empty' }
  return { ok: true, text }
}

async function main(): Promise<number> {
  const apiKey = process.env[LLMTR_API_KEY_ENV]?.trim() ?? ''
  if (!apiKey) {
    console.error(`${LLMTR_API_KEY_ENV} is required. This script does not read a .env file.`)
    return 1
  }

  let request: LlmtrChatSmokeRequest
  try {
    request = buildLlmtrChatSmokeRequest({
      apiKey,
      model: process.env[LLMTR_MODEL_ENV],
    })
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 2
  }

  console.error(`POST ${request.url} model=${request.body.model} max_tokens=${request.body.max_tokens} tools=0 retry=0`)

  let response: Response
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      redirect: LLMTR_SMOKE_REDIRECT,
      signal: AbortSignal.timeout(LLMTR_SMOKE_TIMEOUT_MS),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(redactSecret(message, apiKey))
    return 1
  }

  const raw = await response.text()
  const text = redactSecret(raw, apiKey).slice(0, 4000)
  console.log(text)

  if (!response.ok) {
    console.error(`HTTP ${response.status}`)
    return 1
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.error('Response was not JSON')
    return 1
  }
  const verdict = classifyLlmtrSmokePayload(parsed)
  if (!verdict.ok) {
    console.error(verdict.reason)
    return 1
  }

  return 0
}

if (import.meta.main) {
  process.exit(await main())
}
