import { describe, expect, test } from 'bun:test'
import { stripUnsignedThinkingBlocks } from '../messages.js'
import { isLikelyClaudeModel } from '../model/model.js'

describe('isLikelyClaudeModel', () => {
  test('detects first-party and routed Claude model names', () => {
    expect(isLikelyClaudeModel('claude-opus-4.7')).toBe(true)
    expect(isLikelyClaudeModel('anthropic/claude-opus-4.7')).toBe(true)
    expect(isLikelyClaudeModel('us.anthropic.claude-sonnet-4-6-v1:0')).toBe(true)
  })

  test('does not classify DeepSeek or OpenAI models as Claude', () => {
    expect(isLikelyClaudeModel('deepseek-v4')).toBe(false)
    expect(isLikelyClaudeModel('gpt-5.2-codex')).toBe(false)
    expect(isLikelyClaudeModel(undefined)).toBe(false)
  })
})

describe('stripUnsignedThinkingBlocks', () => {
  test('removes unsigned reasoning blocks while preserving assistant text', () => {
    const messages = [
      assistantMessage('a1', [
        { type: 'thinking', thinking: 'deepseek reasoning' },
        { type: 'text', text: '你好！有什么可以帮你的？', citations: [] },
      ]),
      userMessage('u1', '你是什么模型'),
    ]

    const result = stripUnsignedThinkingBlocks(messages as any) as any[]

    expect(result).toHaveLength(2)
    expect(result[0]?.type).toBe('assistant')
    expect(result[0]?.message.content).toEqual([
      { type: 'text', text: '你好！有什么可以帮你的？', citations: [] },
    ])
  })

  test('keeps signed Anthropic thinking blocks', () => {
    const messages = [
      assistantMessage('a1', [
        {
          type: 'thinking',
          thinking: 'signed Claude thinking',
          signature: 'sig_123',
        },
        { type: 'text', text: 'answer', citations: [] },
      ]),
    ]

    const result = stripUnsignedThinkingBlocks(messages as any) as any[]

    expect(result).toBe(messages)
    expect(result[0]?.message.content[0]).toEqual({
      type: 'thinking',
      thinking: 'signed Claude thinking',
      signature: 'sig_123',
    })
  })

  test('drops unsigned thinking-only assistant turns and merges adjacent users', () => {
    const messages = [
      userMessage('u1', 'one'),
      assistantMessage('a1', [{ type: 'thinking', thinking: 'orphan' }]),
      userMessage('u2', 'two'),
    ]

    const result = stripUnsignedThinkingBlocks(messages as any) as any[]

    expect(result).toHaveLength(1)
    expect(result[0]?.type).toBe('user')
    expect(
      result[0]?.message.content
        .map(block => ('text' in block ? block.text : ''))
        .join(''),
    ).toContain('one')
    expect(
      result[0]?.message.content
        .map(block => ('text' in block ? block.text : ''))
        .join(''),
    ).toContain('two')
  })
})

function assistantMessage(uuid: string, content: any[]) {
  return {
    type: 'assistant' as const,
    uuid,
    timestamp: '2026-05-10T00:00:00.000Z',
    message: {
      id: `msg_${uuid}`,
      type: 'message',
      role: 'assistant' as const,
      model: 'deepseek-v4',
      content,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }
}

function userMessage(uuid: string, text: string) {
  return {
    type: 'user' as const,
    uuid,
    timestamp: '2026-05-10T00:00:00.000Z',
    message: {
      role: 'user' as const,
      content: [{ type: 'text' as const, text }],
    },
  }
}
