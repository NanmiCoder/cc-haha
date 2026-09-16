import { describe, expect, test } from 'bun:test'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { AssistantMessage } from '../types/message.js'
import {
  createAssistantMessage,
  createUserMessage,
  normalizeMessagesForAPI,
  stripSignatureBlocksAfterModelChange,
} from './messages.js'

function assistant(
  messageId: string,
  content: AssistantMessage['message']['content'],
): AssistantMessage {
  const message = createAssistantMessage({ content })
  message.message.id = messageId
  return message
}

function toolUse(id: string): AssistantMessage['message']['content'][number] {
  return {
    type: 'tool_use',
    id,
    name: 'Read',
    input: { file_path: `/tmp/${id}` },
  }
}

function toolResult(id: string) {
  return createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: 'ok',
      },
    ] as ContentBlockParam[],
  })
}

describe('normalizeMessagesForAPI assistant fragment indexing', () => {
  test('preserves a 10,000-step tool-result chain', () => {
    const messages = [createUserMessage({ content: 'start' })]

    for (let i = 0; i < 10_000; i++) {
      const toolId = `tool-${i}`
      messages.push(
        assistant(`response-${i}`, [toolUse(toolId)]),
        toolResult(toolId),
      )
    }

    const normalized = normalizeMessagesForAPI(messages)
    const assistants = normalized.filter(
      (message): message is AssistantMessage => message.type === 'assistant',
    )
    const toolResults = normalized.filter(message => message.type === 'user')

    expect(normalized).toHaveLength(20_001)
    expect(assistants).toHaveLength(10_000)
    expect(toolResults).toHaveLength(10_001)
    expect(assistants.at(-1)?.message.id).toBe('response-9999')
    expect(toolResults.at(-1)?.message.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tool-9999',
        content: 'ok',
      },
    ])
  })

  test('merges interleaved response IDs across tool-result messages', () => {
    const normalized = normalizeMessagesForAPI([
      assistant('response-a', [toolUse('tool-a')]),
      toolResult('tool-a'),
      assistant('response-b', [toolUse('tool-b')]),
      toolResult('tool-b'),
      assistant('response-a', [{ type: 'text', text: 'A complete' }]),
      assistant('response-b', [{ type: 'text', text: 'B complete' }]),
    ])

    const assistants = normalized.filter(
      (message): message is AssistantMessage => message.type === 'assistant',
    )

    expect(assistants.map(message => message.message.id)).toEqual([
      'response-a',
      'response-b',
    ])
    expect(assistants[0]!.message.content.map(block => block.type)).toEqual([
      'tool_use',
      'text',
    ])
    expect(assistants[1]!.message.content.map(block => block.type)).toEqual([
      'tool_use',
      'text',
    ])
  })

  test('does not merge the same response ID across a normal user turn', () => {
    const normalized = normalizeMessagesForAPI([
      assistant('response-a', [{ type: 'text', text: 'before' }]),
      createUserMessage({ content: 'next turn' }),
      assistant('response-a', [{ type: 'text', text: 'after' }]),
    ])

    const assistants = normalized.filter(
      (message): message is AssistantMessage => message.type === 'assistant',
    )

    expect(assistants).toHaveLength(2)
    expect(
      assistants.map(message =>
        message.message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join(''),
      ),
    ).toEqual(['before', 'after'])
  })
})

describe('normalizeMessagesForAPI tool-result media', () => {
  test('preserves nested images from restored messages at the API boundary', () => {
    const image = {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: 'image/png' as const,
        data: 'AAECAwQ=',
      },
    }
    const message = createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'read-1',
          content: [image],
        },
      ],
    })

    const [normalized] = normalizeMessagesForAPI([message])

    expect(normalized?.type).toBe('user')
    if (normalized?.type === 'user') {
      expect(normalized.message.content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 'read-1',
          content: [image],
        },
      ])
    }
  })

  test('keeps parallel tool results contiguous and preserves their ownership', () => {
    const imageA = {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'A' },
    }
    const imageB = {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'B' },
    }
    const message = createUserMessage({
      content: [
        { type: 'tool_result', tool_use_id: 'tool-a', content: [imageA] },
        { type: 'tool_result', tool_use_id: 'tool-b', content: [imageB] },
      ],
    })

    const [normalized] = normalizeMessagesForAPI([message])

    expect(normalized?.type).toBe('user')
    if (normalized?.type === 'user') {
      expect(normalized.message.content).toEqual([
        { type: 'tool_result', tool_use_id: 'tool-a', content: [imageA] },
        { type: 'tool_result', tool_use_id: 'tool-b', content: [imageB] },
      ])
    }
  })
})

describe('stripSignatureBlocksAfterModelChange', () => {
  test('removes protected thinking from history produced by another model', () => {
    const previous = assistant('response-a', [
      { type: 'redacted_thinking', data: 'encrypted reasoning' },
      { type: 'thinking', thinking: 'visible reasoning', signature: 'model-bound' },
      { type: 'text', text: 'Keep this answer.' },
    ])
    previous.message.model = 'gpt-luna'

    const messages = [previous, createUserMessage({ content: 'Continue' })]
    const result = stripSignatureBlocksAfterModelChange(messages, 'deepseek-v4-flash')

    expect(result).not.toBe(messages)
    expect(result[0]?.type).toBe('assistant')
    if (result[0]?.type === 'assistant') {
      expect(result[0].message.content).toEqual([
        { type: 'text', text: 'Keep this answer.' },
      ])
    }
    expect(previous.message.content.map(block => block.type)).toEqual([
      'redacted_thinking',
      'thinking',
      'text',
    ])
  })

  test('preserves protected thinking when the model has not changed', () => {
    const previous = assistant('response-a', [
      { type: 'redacted_thinking', data: 'encrypted reasoning' },
      { type: 'text', text: 'Keep all blocks.' },
    ])
    previous.message.model = 'deepseek-v4-flash'
    const messages = [previous, createUserMessage({ content: 'Continue' })]

    expect(
      stripSignatureBlocksAfterModelChange(messages, 'deepseek-v4-flash[1m]'),
    ).toBe(messages)
  })

  test('leaves history without protected thinking untouched', () => {
    const messages = [createUserMessage({ content: 'Continue' })]

    expect(
      stripSignatureBlocksAfterModelChange(messages, 'deepseek-v4-flash'),
    ).toBe(messages)
  })
})
