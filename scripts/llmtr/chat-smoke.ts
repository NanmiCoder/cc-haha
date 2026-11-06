/**
 * One Chat Completions call through the LLMTR preset and the app's OpenAI
 * Chat request path.
 *
 * Run from the repository root after `bun install`:
 *   LLMTR_API_KEY=... bun run scripts/llmtr/chat-smoke.ts
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
 * reasoning field. This entrypoint does not.
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

  try {
    const parsed = JSON.parse(raw) as { choices?: unknown; error?: unknown }
    if (!Array.isArray(parsed.choices) || parsed.choices.length === 0 || parsed.error) {
      console.error('Response is not a Chat Completions choices payload')
      return 1
    }
  } catch {
    console.error('Response was not JSON')
    return 1
  }

  return 0
}

if (import.meta.main) {
  process.exit(await main())
}
