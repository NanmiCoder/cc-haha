import { describe, expect, test } from 'bun:test'
import { openaiChatToAnthropic } from './openaiChatToAnthropic.js'
import type { OpenAIChatResponse } from './types.js'

function response(tool: Record<string, unknown>, reason = 'tool_calls'): OpenAIChatResponse {
  return { id: 'fixture', model: 'fixture', choices: [{ message: { role: 'assistant', content: null, tool_calls: [tool] }, finish_reason: reason }], usage: { prompt_tokens: 1, completion_tokens: 1 } } as OpenAIChatResponse
}

describe('Chat non-streaming response integrity', () => {
  for (const args of ['{"path":', '[]', 'null', '42']) {
    test(`completed malformed/non-object arguments reject: ${args}`, () => {
      expect(() => openaiChatToAnthropic(response({ id: 'call', function: { name: 'Read', arguments: args } }), 'fixture')).toThrow()
    })
  }
  test('error envelope rejects rather than returning empty success', () => {
    expect(() => openaiChatToAnthropic({ error: { message: 'Fixture failure' } } as unknown as OpenAIChatResponse, 'fixture')).toThrow('Fixture failure')
  })
  test('tool identity is required', () => {
    expect(() => openaiChatToAnthropic(response({ id: '', function: { name: 'Read', arguments: '{}' } }), 'fixture')).toThrow()
  })
  test('object-valued gateway arguments remain supported', () => {
    const result = openaiChatToAnthropic(response({ id: 'call', function: { name: 'Read', arguments: { path: 'fixture' } } }), 'fixture')
    expect(result.content[0]).toMatchObject({ type: 'tool_use', input: { path: 'fixture' } })
  })
  test('length does not turn partial arguments into an executable tool', () => {
    const result = openaiChatToAnthropic(response({ id: 'call', function: { name: 'Read', arguments: '{"path":' } }, 'length'), 'fixture')
    expect(result.stop_reason).toBe('max_tokens')
    expect(result.content.some(block => block.type === 'tool_use')).toBe(false)
  })
})
