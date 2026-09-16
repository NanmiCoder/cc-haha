import { describe, expect, test } from 'bun:test'
import { anthropicToOpenaiChat } from './anthropicToOpenaiChat.js'
import { anthropicToOpenaiResponses } from './anthropicToOpenaiResponses.js'
import { resolveRequestCompatibility } from './requestCompatibility.js'
import type { AnthropicRequest } from './types.js'

const body = (patch: Partial<AnthropicRequest> = {}): AnthropicRequest => ({ model: 'fixture-model', max_tokens: 32_000, messages: [{ role: 'user', content: 'fixture' }], ...patch })
const tools = [{ name: 'Read', input_schema: { type: 'object', properties: {} } }]

describe('request intent survives protocol conversion', () => {
  test('budget evidence distinguishes local request, provider override, wire limit and omission', () => {
    expect(resolveRequestCompatibility(body(), {
      protocol: 'openai_chat', budgetSource: 'default', requestCompatibility: { maxOutputTokens: 96_000, outputTokenLimit: 64_000 },
    }).outputBudget).toEqual({ source: 'default', requested: 32_000, configured: 96_000, hardLimit: 64_000, field: 'max_tokens', effective: 64_000, reason: 'hard_limit' })
    expect(resolveRequestCompatibility(body(), { protocol: 'openai_responses', budgetSource: 'default' }).outputBudget)
      .toEqual({ source: 'default', requested: 32_000, field: 'omit', reason: 'upstream_default' })
    expect(resolveRequestCompatibility(body({ max_tokens: 1 }), { protocol: 'openai_responses' }).outputBudget)
      .toEqual({ source: 'explicit', requested: 1, field: 'max_output_tokens', effective: 16, reason: 'responses_minimum' })
  })

  test('explicit budgets reach Chat and Responses while local defaults may omit', () => {
    expect(anthropicToOpenaiChat(body({ max_tokens: 64 })).max_tokens).toBe(64)
    expect(anthropicToOpenaiResponses(body({ max_tokens: 64 })).max_output_tokens).toBe(64)
    expect(anthropicToOpenaiChat(body(), { budgetSource: 'default' }).max_tokens).toBeUndefined()
    expect(anthropicToOpenaiResponses(body(), { budgetSource: 'default' }).max_output_tokens).toBeUndefined()
  })

  test('provider default applies only to a default source and hard limit caps the effective value', () => {
    const requestCompatibility = { maxOutputTokens: 96_000, outputTokenLimit: 64_000 }
    expect(anthropicToOpenaiChat(body(), { requestCompatibility, budgetSource: 'default' }).max_tokens).toBe(64_000)
    expect(anthropicToOpenaiChat(body({ max_tokens: 64 }), { requestCompatibility, budgetSource: 'explicit' }).max_tokens).toBe(64)
    expect(anthropicToOpenaiResponses(body({ max_tokens: 96_000 }), { requestCompatibility }).max_output_tokens).toBe(64_000)
  })

  test('a hard limit alone constrains automatic requests without guessing a model limit', () => {
    const requestCompatibility = { outputTokenLimit: 64_000 }
    expect(resolveRequestCompatibility(body(), { protocol: 'openai_chat', requestCompatibility, budgetSource: 'default' }).outputBudget)
      .toEqual({ source: 'default', requested: 32_000, hardLimit: 64_000, field: 'max_tokens', effective: 64_000, reason: 'hard_limit' })
    expect(anthropicToOpenaiResponses(body(), { requestCompatibility, budgetSource: 'default' }).max_output_tokens).toBe(64_000)
    expect(anthropicToOpenaiChat(body({ max_tokens: 64 }), { requestCompatibility }).max_tokens).toBe(64)
  })

  test('omit conflicts with configured ceilings but remains valid for an unconstrained default', () => {
    for (const requestCompatibility of [
      { outputTokenField: 'omit' as const, outputTokenLimit: 64_000 },
      { outputTokenField: 'omit' as const, maxOutputTokens: 64_000 },
    ]) {
      expect(() => anthropicToOpenaiChat(body(), { requestCompatibility, budgetSource: 'default' })).toThrow('output budget')
      expect(() => anthropicToOpenaiResponses(body(), { requestCompatibility, budgetSource: 'default' })).toThrow('output budget')
    }
    expect(resolveRequestCompatibility(body(), { protocol: 'openai_chat', requestCompatibility: { outputTokenField: 'omit' }, budgetSource: 'default' }).outputBudget.reason).toBe('provider_omit')
  })

  test('known modern models choose completion budget field, explicit override wins', () => {
    for (const model of ['o3', 'gpt-5.4', 'gpt-6-astra']) {
      expect(anthropicToOpenaiChat(body({ model })).max_completion_tokens).toBe(32_000)
    }
    expect(anthropicToOpenaiChat(body({ model: 'gpt-6-astra' }), { requestCompatibility: { outputTokenField: 'max_tokens' } }).max_tokens).toBe(32_000)
    expect(anthropicToOpenaiChat(body(), { requestCompatibility: { outputTokenField: 'max_completion_tokens' } }).max_completion_tokens).toBe(32_000)
  })

  test('unsupported explicit output ceiling fails except for the dedicated OAuth contract', () => {
    expect(() => anthropicToOpenaiChat(body({ max_tokens: 64 }), { requestCompatibility: { outputTokenField: 'omit' } })).toThrow('output budget')
    expect(anthropicToOpenaiResponses(body(), { openAICodexOAuth: true }).max_output_tokens).toBeUndefined()
  })

  test('Responses tiny probes use minimum 16 without enlarging normal probes', () => {
    expect(anthropicToOpenaiResponses(body({ max_tokens: 1 })).max_output_tokens).toBe(16)
    expect(anthropicToOpenaiResponses(body({ max_tokens: 64 })).max_output_tokens).toBe(64)
    expect(() => anthropicToOpenaiResponses(body({ max_tokens: 1 }), { requestCompatibility: { outputTokenLimit: 8 } })).toThrow()
  })

  test('parallel disable and JSON schema survive both output shapes unchanged', () => {
    const schema = { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: false }
    const original = JSON.stringify(schema)
    const request = body({ tools, tool_choice: { type: 'auto', disable_parallel_tool_use: true }, output_config: { format: { type: 'json_schema', schema } } })
    const chat = anthropicToOpenaiChat(request)
    const responses = anthropicToOpenaiResponses(request)
    expect(chat.parallel_tool_calls).toBe(false)
    expect(responses.parallel_tool_calls).toBe(false)
    expect(chat.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'response', schema, strict: false } })
    expect(responses.text).toEqual({ format: { type: 'json_schema', name: 'response', schema, strict: false } })
    expect(JSON.stringify(schema)).toBe(original)
  })

  test('unsupported hard schema and serial-tools constraints fail instead of disappearing', () => {
    for (const convert of [anthropicToOpenaiChat, anthropicToOpenaiResponses]) {
      expect(() => convert(body({ tools, tool_choice: { type: 'auto', disable_parallel_tool_use: true } }), { requestCompatibility: { parallelTools: 'unsupported' } })).toThrow()
      expect(() => convert(body({ output_config: { format: { type: 'json_schema', schema: { type: 'object' } } } }), { requestCompatibility: { structuredOutput: 'unsupported' } })).toThrow()
    }
  })

  test('sampling and reasoning capability overrides retain the auto baseline', () => {
    const request = body({ temperature: 0.2, top_p: 0.7, thinking: { type: 'enabled', budget_tokens: 2048 } })
    expect(anthropicToOpenaiChat(request).temperature).toBeUndefined()
    expect(anthropicToOpenaiChat(request).reasoning_effort).toBe('medium')
    expect(anthropicToOpenaiChat(request, { requestCompatibility: { sampling: 'supported' } }).temperature).toBe(0.2)
    expect(anthropicToOpenaiChat(request, { requestCompatibility: { reasoning: 'unsupported' } }).reasoning_effort).toBeUndefined()
    expect(anthropicToOpenaiResponses(request, { requestCompatibility: { sampling: 'supported', reasoning: 'unsupported' } })).toMatchObject({ temperature: 0.2, top_p: 0.7 })
    expect(anthropicToOpenaiResponses(request, { requestCompatibility: { reasoning: 'unsupported' } }).reasoning).toBeUndefined()
  })

  test('filtering tools removes orphan choices and parallel-tool options', () => {
    for (const convert of [anthropicToOpenaiChat, anthropicToOpenaiResponses]) {
      const result = convert(body({ tools: [{ name: 'BatchTool', input_schema: {} }], tool_choice: { type: 'tool', name: 'BatchTool', disable_parallel_tool_use: true } }))
      expect(result.tools).toBeUndefined()
      expect(result.tool_choice).toBeUndefined()
      expect(result.parallel_tool_calls).toBeUndefined()
    }
  })

  test('optional schema fields keep omission semantics and legacy output_format remains supported', () => {
    const schema = { type: 'object', properties: { optional: { type: 'string' } } }
    const input = body({ output_format: { type: 'json_schema', schema } })
    const chat = anthropicToOpenaiChat(input)
    const responses = anthropicToOpenaiResponses(input)
    expect(chat.response_format?.json_schema).toMatchObject({ schema, strict: false })
    expect(responses.text?.format).toMatchObject({ schema, strict: false })
    expect(chat.response_format?.json_schema.schema.required).toBeUndefined()
    expect(responses.text?.format.schema.required).toBeUndefined()
  })

  test('invalid structured output requests cannot silently disappear', () => {
    for (const format of ['json', [], { type: 'json_schema', schema: true }]) {
      expect(() => anthropicToOpenaiChat(body({ output_config: { format } }))).toThrow()
      expect(() => anthropicToOpenaiResponses(body({ output_config: { format } }))).toThrow()
    }
  })

  test('unsupported reasoning removes generation and history extension fields', () => {
    const input = body({ messages: [{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'fixture thought' },
      { type: 'tool_use', id: 'call_1', name: 'Read', input: {} },
    ] }] })
    const transformed = anthropicToOpenaiChat(input, { roundTripReasoningContent: true, requestCompatibility: { reasoning: 'unsupported' } })
    expect(transformed.messages[0].reasoning_content).toBeUndefined()
  })
})
