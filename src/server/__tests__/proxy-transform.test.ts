/**
 * Unit tests for proxy protocol transformation
 */

import { describe, test, expect } from 'bun:test'
import { anthropicToOpenaiChat } from '../proxy/transform/anthropicToOpenaiChat.js'
import { anthropicToOpenaiResponses } from '../proxy/transform/anthropicToOpenaiResponses.js'
import { openaiChatToAnthropic } from '../proxy/transform/openaiChatToAnthropic.js'
import { openaiResponsesToAnthropic } from '../proxy/transform/openaiResponsesToAnthropic.js'
import type { AnthropicRequest, OpenAIChatResponse, OpenAIResponsesResponse } from '../proxy/transform/types.js'

// ─── anthropicToOpenaiChat ──────────────────────────────────────

describe('anthropicToOpenaiChat', () => {
  test('basic text message', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.model).toBe('gpt-4')
    expect(result.max_tokens).toBeUndefined()
    expect(result.messages).toEqual([{ role: 'user', content: 'Hello' }])
  })

  test('system prompt string', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'Hi' }],
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are helpful' })
    expect(result.messages[1]).toEqual({ role: 'user', content: 'Hi' })
  })

  test('system prompt array', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      system: [{ type: 'text', text: 'Part 1' }, { type: 'text', text: 'Part 2' }],
      messages: [{ role: 'user', content: 'Hi' }],
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.messages[0]).toEqual({ role: 'system', content: 'Part 1\nPart 2' })
  })

  test('stop_sequences → stop', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      stop_sequences: ['END', 'STOP'],
      messages: [{ role: 'user', content: 'Hi' }],
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.stop).toEqual(['END', 'STOP'])
  })

  test('tools conversion', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      }],
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.tools).toHaveLength(1)
    expect(result.tools![0].type).toBe('function')
    expect(result.tools![0].function.name).toBe('get_weather')
    expect(result.tools![0].function.parameters).toEqual({ type: 'object', properties: { city: { type: 'string' } } })
  })

  test('filters BatchTool', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        { name: 'BatchTool', input_schema: {} },
        { name: 'real_tool', input_schema: {} },
      ],
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.tools).toHaveLength(1)
    expect(result.tools![0].function.name).toBe('real_tool')
  })

  test('tool_choice conversion', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      tool_choice: { type: 'any' },
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.tool_choice).toBe('required')
  })

  test('tool_choice type=tool', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      tool_choice: { type: 'tool', name: 'get_weather' },
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } })
  })

  test('thinking budget → reasoning_effort', () => {
    const lowReq: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { type: 'enabled', budget_tokens: 512 },
    }
    expect(anthropicToOpenaiChat(lowReq).reasoning_effort).toBe('low')

    const medReq: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { type: 'enabled', budget_tokens: 4096 },
    }
    expect(anthropicToOpenaiChat(medReq).reasoning_effort).toBe('medium')

    const highReq: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { type: 'enabled', budget_tokens: 16000 },
    }
    expect(anthropicToOpenaiChat(highReq).reasoning_effort).toBe('high')
  })

  test('assistant message with tool_use', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check' },
          { type: 'tool_use', id: 'tc_1', name: 'get_weather', input: { city: 'NYC' } },
        ],
      }],
    }
    const result = anthropicToOpenaiChat(req)
    const msg = result.messages[0]
    expect(msg.role).toBe('assistant')
    expect(msg.content).toBe('Let me check')
    expect(msg.tool_calls).toHaveLength(1)
    expect(msg.tool_calls![0].id).toBe('tc_1')
    expect(msg.tool_calls![0].function.name).toBe('get_weather')
    expect(msg.tool_calls![0].function.arguments).toBe('{"city":"NYC"}')
  })

  test('user message with tool_result', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tc_1', content: 'Sunny, 72°F' },
        ],
      }],
    }
    const result = anthropicToOpenaiChat(req)
    expect(result.messages[0].role).toBe('tool')
    expect(result.messages[0].tool_call_id).toBe('tc_1')
    expect(result.messages[0].content).toBe('Sunny, 72°F')
  })

  test('image content conversion', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
        ],
      }],
    }
    const result = anthropicToOpenaiChat(req)
    const content = result.messages[0].content as Array<{ type: string; image_url?: { url: string } }>
    expect(content[0].type).toBe('image_url')
    expect(content[0].image_url!.url).toBe('data:image/png;base64,abc123')
  })
})

// ─── openaiChatToAnthropic ──────────────────────────────────────

describe('openaiChatToAnthropic', () => {
  test('basic text response', () => {
    const res: OpenAIChatResponse = {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1234567890,
      model: 'gpt-4',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello!' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }
    const result = openaiChatToAnthropic(res, 'gpt-4')
    expect(result.type).toBe('message')
    expect(result.role).toBe('assistant')
    expect(result.content).toEqual([{ type: 'text', text: 'Hello!' }])
    expect(result.stop_reason).toBe('end_turn')
    expect(result.usage.input_tokens).toBe(10)
    expect(result.usage.output_tokens).toBe(5)
  })

  test('tool_calls response', () => {
    const res: OpenAIChatResponse = {
      id: 'chatcmpl-2',
      object: 'chat.completion',
      created: 1234567890,
      model: 'gpt-4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }
    const result = openaiChatToAnthropic(res, 'gpt-4')
    expect(result.stop_reason).toBe('tool_use')
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('tool_use')
    if (result.content[0].type === 'tool_use') {
      expect(result.content[0].id).toBe('call_1')
      expect(result.content[0].name).toBe('get_weather')
      expect(result.content[0].input).toEqual({ city: 'NYC' })
    }
  })

  test('finish_reason mapping', () => {
    const make = (reason: string) => ({
      id: 'x', object: 'chat.completion', created: 0, model: 'gpt-4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: reason }],
    } as OpenAIChatResponse)

    expect(openaiChatToAnthropic(make('stop'), 'gpt-4').stop_reason).toBe('end_turn')
    expect(openaiChatToAnthropic(make('length'), 'gpt-4').stop_reason).toBe('max_tokens')
    expect(openaiChatToAnthropic(make('tool_calls'), 'gpt-4').stop_reason).toBe('tool_use')
    expect(openaiChatToAnthropic(make('content_filter'), 'gpt-4').stop_reason).toBe('end_turn')
  })

  test('empty choices', () => {
    const res: OpenAIChatResponse = {
      id: 'x', object: 'chat.completion', created: 0, model: 'gpt-4',
      choices: [],
    }
    const result = openaiChatToAnthropic(res, 'gpt-4')
    expect(result.content).toEqual([{ type: 'text', text: '' }])
    expect(result.stop_reason).toBe('end_turn')
  })

  test('cached tokens mapping', () => {
    const res: OpenAIChatResponse = {
      id: 'x', object: 'chat.completion', created: 0, model: 'gpt-4',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 80 },
      },
    }
    const result = openaiChatToAnthropic(res, 'gpt-4')
    expect(result.usage.cache_read_input_tokens).toBe(80)
  })
})

// ─── anthropicToOpenaiResponses ─────────────────────────────────

describe('anthropicToOpenaiResponses', () => {
  test('basic message', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 1024,
      system: 'Be helpful',
      messages: [{ role: 'user', content: 'Hello' }],
    }
    const result = anthropicToOpenaiResponses(req)
    expect(result.model).toBe('gpt-4o')
    expect(result.instructions).toBe('Be helpful')
    expect(result.max_output_tokens).toBeUndefined()
    expect(result.input).toEqual([{ type: 'message', role: 'user', content: 'Hello' }])
  })

  test('tool_use lifted to function_call', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tc_1', name: 'search', input: { q: 'test' } },
        ],
      }],
    }
    const result = anthropicToOpenaiResponses(req)
    const fc = result.input.find((i) => i.type === 'function_call')
    expect(fc).toBeDefined()
    if (fc && fc.type === 'function_call') {
      expect(fc.call_id).toBe('tc_1')
      expect(fc.name).toBe('search')
      expect(fc.arguments).toBe('{"q":"test"}')
    }
  })

  test('tool_result lifted to function_call_output', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tc_1', content: 'found it' },
        ],
      }],
    }
    const result = anthropicToOpenaiResponses(req)
    const fco = result.input.find((i) => i.type === 'function_call_output')
    expect(fco).toBeDefined()
    if (fco && fco.type === 'function_call_output') {
      expect(fco.call_id).toBe('tc_1')
      expect(fco.output).toBe('found it')
    }
  })

  test('thinking → reasoning', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { type: 'enabled', budget_tokens: 10000 },
    }
    const result = anthropicToOpenaiResponses(req)
    expect(result.reasoning).toEqual({ effort: 'high' })
  })

  test('stop_sequences dropped', () => {
    const req: AnthropicRequest = {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hi' }],
      stop_sequences: ['END'],
    }
    const result = anthropicToOpenaiResponses(req)
    expect((result as Record<string, unknown>).stop).toBeUndefined()
    expect((result as Record<string, unknown>).stop_sequences).toBeUndefined()
  })
})

// ─── openaiResponsesToAnthropic ─────────────────────────────────

describe('openaiResponsesToAnthropic', () => {
  test('basic text response', () => {
    const res: OpenAIResponsesResponse = {
      id: 'resp_1',
      object: 'response',
      created_at: 1234567890,
      model: 'gpt-4o',
      status: 'completed',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello!' }],
      }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }
    const result = openaiResponsesToAnthropic(res, 'gpt-4o')
    expect(result.content).toEqual([{ type: 'text', text: 'Hello!' }])
    expect(result.stop_reason).toBe('end_turn')
    expect(result.usage.input_tokens).toBe(10)
    expect(result.usage.output_tokens).toBe(5)
  })

  test('function_call → tool_use', () => {
    const res: OpenAIResponsesResponse = {
      id: 'resp_2',
      object: 'response',
      created_at: 0,
      model: 'gpt-4o',
      status: 'completed',
      output: [{
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'search',
        arguments: '{"q":"test"}',
      }],
    }
    const result = openaiResponsesToAnthropic(res, 'gpt-4o')
    expect(result.stop_reason).toBe('tool_use')
    expect(result.content[0].type).toBe('tool_use')
    if (result.content[0].type === 'tool_use') {
      expect(result.content[0].id).toBe('call_1')
      expect(result.content[0].input).toEqual({ q: 'test' })
    }
  })

  test('reasoning → thinking', () => {
    const res: OpenAIResponsesResponse = {
      id: 'resp_3',
      object: 'response',
      created_at: 0,
      model: 'gpt-4o',
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'r_1', summary: [{ type: 'text', text: 'Thinking...' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Result' }] },
      ],
    }
    const result = openaiResponsesToAnthropic(res, 'gpt-4o')
    expect(result.content).toHaveLength(2)
    expect(result.content[0].type).toBe('thinking')
    if (result.content[0].type === 'thinking') {
      expect(result.content[0].thinking).toBe('Thinking...')
    }
    expect(result.content[1].type).toBe('text')
  })

  test('status incomplete → max_tokens', () => {
    const res: OpenAIResponsesResponse = {
      id: 'resp_4',
      object: 'response',
      created_at: 0,
      model: 'gpt-4o',
      status: 'incomplete',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] }],
    }
    const result = openaiResponsesToAnthropic(res, 'gpt-4o')
    expect(result.stop_reason).toBe('max_tokens')
  })

  test('empty output', () => {
    const res: OpenAIResponsesResponse = {
      id: 'resp_5',
      object: 'response',
      created_at: 0,
      model: 'gpt-4o',
      status: 'completed',
      output: [],
    }
    const result = openaiResponsesToAnthropic(res, 'gpt-4o')
    expect(result.content).toEqual([{ type: 'text', text: '' }])
  })
})
