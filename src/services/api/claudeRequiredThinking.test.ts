import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getIsInteractive,
  setIsInteractive,
} from '../../bootstrap/state.js'
import { enableConfigs } from '../../utils/config.js'
import { get3PModelCapabilityOverride } from '../../utils/model/modelSupportOverrides.js'
import { queryWithModel } from './claude.js'

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

function successfulResponse(model: string): string {
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_required_thinking',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'OK' },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('')
}

function truncatedToolResponse(model: string): string {
  return [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_truncated_tool',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'tool_truncated_write',
        name: 'Write',
        input: {},
      },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: '{"file_path":"/tmp/never-created","content":"unfinished',
      },
    }),
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens', stop_sequence: null },
      usage: { output_tokens: 131_072 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  ].join('')
}

function hangingToolResponse(model: string): Response {
  const initialEvents = [
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_hanging_tool',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'tool_hanging_write',
        name: 'Write',
        input: {},
      },
    }),
    sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: '{"content":"still growing',
      },
    }),
  ].join('')

  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(initialEvents))
      setTimeout(() => {
        try {
          controller.close()
        } catch {
          // The watchdog cancels the response body before this fallback close.
        }
      }, 250)
    },
  }), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

const ENV_KEYS = [
  'NODE_ENV',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_ENABLE_STREAM_WATCHDOG',
  'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
  'CLAUDE_STREAM_MAX_DURATION_MS',
  'CLAUDE_STREAM_TOOL_INPUT_MAX_DURATION_MS',
] as const

async function captureQueryRequest({
  model,
  pinnedModel,
  capabilities,
  effortValue,
  configureCapabilityOverrides = true,
  responseFactory,
  env,
}: {
  model: string
  pinnedModel?: string
  capabilities?: string
  effortValue?: 'low'
  configureCapabilityOverrides?: boolean
  responseFactory?: (model: string) => Response
  env?: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>
}): Promise<{
  content: unknown
  apiError: string | undefined
  error: string | undefined
  requests: Array<Record<string, unknown>>
  requestHeaders: Array<Headers>
}> {
  const requests: Array<Record<string, unknown>> = []
  const requestHeaders: Array<Headers> = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requestHeaders.push(new Headers(request.headers))
      requests.push(await request.json() as Record<string, unknown>)
      return responseFactory?.(model) ?? new Response(successfulResponse(model), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  const configDir = await mkdtemp(join(tmpdir(), 'cc-haha-required-thinking-'))
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  const globals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
  const originalMacro = globals.MACRO
  const originalIsInteractive = getIsInteractive()

  try {
    globals.MACRO = { BUILD_TIME: '' }
    setIsInteractive(false)
    process.env.NODE_ENV = 'production'
    process.env.CLAUDE_CONFIG_DIR = configDir
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL
    delete process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
    delete process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`
    delete process.env.ANTHROPIC_AUTH_TOKEN
    process.env.ANTHROPIC_API_KEY = 'loopback-test-key'
    process.env.ANTHROPIC_MODEL = model
    delete process.env.ANTHROPIC_DEFAULT_FABLE_MODEL
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
    delete process.env.ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES
    if (configureCapabilityOverrides && capabilities !== undefined) {
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = pinnedModel ?? model
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
        capabilities
    }
    for (const [key, value] of Object.entries(env ?? {})) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    clearCapabilityCache()
    enableConfigs()

    const result = await queryWithModel({
      userPrompt: 'Reply exactly OK',
      signal: new AbortController().signal,
      options: {
        model,
        querySource: 'insights',
        agents: [],
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        effortValue,
      },
    })

    return {
      content: result.message.content,
      apiError: result.apiError,
      error: result.error,
      requests,
      requestHeaders,
    }
  } finally {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (originalMacro === undefined) delete globals.MACRO
    else globals.MACRO = originalMacro
    setIsInteractive(originalIsInteractive)
    server.stop(true)
    clearCapabilityCache()
    await rm(configDir, { recursive: true, force: true })
  }
}

test('keeps required-thinking models enabled when the caller requests disabled thinking', async () => {
  const { content, requests } = await captureQueryRequest({
    model: 'k3',
    capabilities: 'thinking,required_thinking,effort,max_effort',
  })

  expect(content).toEqual([{ type: 'text', text: 'OK' }])
  expect(requests).toHaveLength(1)
  expect(requests[0]?.model).toBe('k3')
  expect(requests[0]?.thinking).toMatchObject({ type: 'enabled' })
}, 10_000)

test('keeps request effort when thinking is explicitly disabled', async () => {
  const { requests } = await captureQueryRequest({
    model: 'effort-model',
    capabilities: 'thinking,effort,max_effort',
    effortValue: 'low',
  })

  expect(requests).toHaveLength(1)
  expect(requests[0]?.thinking).toEqual({ type: 'disabled' })
  expect(requests[0]?.output_config).toEqual({ effort: 'low' })
}, 10_000)

test('sends effort through the final request when a pinned model adds a 1M marker', async () => {
  const { requests, requestHeaders } = await captureQueryRequest({
    model: 'deepseek-v4-flash',
    pinnedModel: 'deepseek-v4-flash[1m]',
    capabilities: 'thinking,effort,adaptive_thinking,xhigh_effort,max_effort',
    effortValue: 'low',
  })

  expect(requests).toHaveLength(1)
  expect(requests[0]?.model).toBe('deepseek-v4-flash')
  expect(requests[0]?.output_config).toEqual({ effort: 'low' })
  expect(requests[0]?.thinking).toEqual({ type: 'disabled' })
  expect(requestHeaders[0]?.get('anthropic-beta')).toContain('effort-2025-11-24')
}, 10_000)

test('normalizes a disabled parent thinking mode to adaptive for Fable', async () => {
  const { requests } = await captureQueryRequest({
    model: 'claude-fable-5',
    configureCapabilityOverrides: false,
  })

  expect(requests).toHaveLength(1)
  expect(requests[0]?.thinking).toEqual({ type: 'adaptive' })
  expect(requests[0]?.thinking).not.toEqual({ type: 'disabled' })
}, 10_000)

test('drops a tool call truncated at the output-token boundary', async () => {
  const { content, apiError, error, requests } = await captureQueryRequest({
    model: 'deepseek-v4-flash',
    configureCapabilityOverrides: false,
    responseFactory: model => new Response(truncatedToolResponse(model), {
      headers: { 'content-type': 'text/event-stream' },
    }),
  })

  expect(requests).toHaveLength(1)
  expect(content).toEqual([
    expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('tool call was truncated'),
    }),
  ])
  expect(content).not.toContainEqual(expect.objectContaining({ type: 'tool_use' }))
  expect(apiError).toBeUndefined()
  expect(error).toBe('max_output_tokens')
}, 10_000)

test('aborts a tool input that keeps streaming without completing', async () => {
  const { content, error, requests } = await captureQueryRequest({
    model: 'deepseek-v4-flash',
    configureCapabilityOverrides: false,
    responseFactory: hangingToolResponse,
    env: {
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
      CLAUDE_ENABLE_STREAM_WATCHDOG: '1',
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: '1000',
      CLAUDE_STREAM_MAX_DURATION_MS: '1000',
      CLAUDE_STREAM_TOOL_INPUT_MAX_DURATION_MS: '20',
    },
  })

  expect(requests).toHaveLength(1)
  expect(content).toEqual([
    expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('Tool input generation exceeded'),
    }),
  ])
  expect(error).toBe('server_error')
}, 10_000)

function clearCapabilityCache() {
  ;(get3PModelCapabilityOverride as typeof get3PModelCapabilityOverride & {
    cache?: { clear?: () => void }
  }).cache?.clear?.()
}
