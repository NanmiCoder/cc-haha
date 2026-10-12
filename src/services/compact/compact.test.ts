import { describe, expect, test } from 'bun:test'

import {
  buildPostCompactMessages,
  findLastAssistantWithText,
  shouldAdoptCompactionResponse,
  stripImagesFromMessages,
  truncateHeadForPTLRetry,
  type CompactionResult,
} from './compact.js'
import { getAssistantMessageText } from '../../utils/messages.js'
import { PROMPT_TOO_LONG_ERROR_MESSAGE } from '../api/errors.js'
import { getCurrentUsage } from '../../utils/tokens.js'
import type { AssistantMessage, Message } from '../../types/message.js'

const PRE_COMPACT_USAGE = {
  input_tokens: 150_000,
  output_tokens: 900,
  cache_creation_input_tokens: 2_000,
  cache_read_input_tokens: 120_000,
  service_tier: 'standard',
}

function makeBoundary(): CompactionResult['boundaryMarker'] {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: '00000000-0000-0000-0000-000000000001',
    level: 'info',
    compactMetadata: { trigger: 'manual', preTokens: 150_000 },
  } as unknown as CompactionResult['boundaryMarker']
}

function makeSummaryMessage(): CompactionResult['summaryMessages'][number] {
  return {
    type: 'user',
    uuid: '00000000-0000-0000-0000-000000000002',
    timestamp: new Date().toISOString(),
    isCompactSummary: true,
    message: { role: 'user', content: 'This session is being continued…' },
  } as unknown as CompactionResult['summaryMessages'][number]
}

function makePreservedAssistant(): Message {
  return {
    type: 'assistant',
    uuid: '00000000-0000-0000-0000-000000000003',
    timestamp: new Date().toISOString(),
    message: {
      id: 'msg_old',
      role: 'assistant',
      model: 'mock-model',
      content: [{ type: 'text', text: 'old reply kept after compact' }],
      stop_reason: 'end_turn',
      usage: { ...PRE_COMPACT_USAGE },
    },
  } as unknown as Message
}

function makePreservedUser(): Message {
  return {
    type: 'user',
    uuid: '00000000-0000-0000-0000-000000000004',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'kept user message' },
  } as unknown as Message
}

function makeResult(messagesToKeep?: Message[]): CompactionResult {
  return {
    boundaryMarker: makeBoundary(),
    summaryMessages: [makeSummaryMessage()],
    attachments: [],
    hookResults: [],
    ...(messagesToKeep ? { messagesToKeep } : {}),
  }
}

describe('buildPostCompactMessages stale-usage stripping (#743)', () => {
  test('zeroes provider usage on preserved assistant messages', () => {
    const kept = makePreservedAssistant()
    const result = buildPostCompactMessages(makeResult([kept, makePreservedUser()]))

    const assistant = result.find(m => m.type === 'assistant') as {
      message: { usage: Record<string, unknown> }
    }
    expect(assistant.message.usage).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
    // Non-token usage metadata survives the strip.
    expect(assistant.message.usage.service_tier).toBe('standard')
  })

  test('does not mutate the original preserved message', () => {
    const kept = makePreservedAssistant()
    buildPostCompactMessages(makeResult([kept]))

    expect(
      (kept as unknown as { message: { usage: { input_tokens: number } } })
        .message.usage.input_tokens,
    ).toBe(150_000)
  })

  test('keeps ordering and passes non-assistant messages through untouched', () => {
    const keptUser = makePreservedUser()
    const result = buildPostCompactMessages(makeResult([keptUser]))

    expect(result[0]?.type).toBe('system')
    expect(result[1]?.type).toBe('user')
    expect(result[2]).toBe(keptUser)
  })

  test('post-compact view no longer anchors getCurrentUsage to the pre-compact request size', () => {
    const result = buildPostCompactMessages(
      makeResult([makePreservedUser(), makePreservedAssistant()]),
    )

    // getCurrentUsage skips zeroed usage (its stale placeholder convention),
    // so the context meter falls back to the local estimate and recovers
    // immediately instead of staying pinned at the pre-compact 100%.
    expect(getCurrentUsage(result)).toBeNull()
  })

  test('handles results without messagesToKeep', () => {
    const result = buildPostCompactMessages(makeResult())
    expect(result).toHaveLength(2)
    expect(getCurrentUsage(result)).toBeNull()
  })
})

describe('oversized compaction recovery (#1373)', () => {
  function toolHistory(rounds: number): Message[] {
    const content = 'historical log data '.repeat(28_000)
    const messages: Message[] = [makePreservedUser()]
    for (let index = 0; index < rounds; index++) {
      messages.push({
        ...makePreservedAssistant(),
        uuid: crypto.randomUUID(),
        message: {
          id: `round-${index}`, role: 'assistant', model: 'deepseek-flash',
          content: [{ type: 'tool_use', id: `read-${index}`, name: 'Read', input: { file_path: `/fixture/${index}` } }],
          stop_reason: 'tool_use', usage: { input_tokens: 0, output_tokens: 0 },
        },
      } as Message, {
        ...makePreservedUser(),
        uuid: crypto.randomUUID(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `read-${index}`, content }] },
      } as Message)
    }
    messages.push(makePreservedAssistant(), makePreservedUser())
    return messages
  }

  function overflow(errorDetails: string): AssistantMessage {
    return {
      ...makePreservedAssistant(), isApiErrorMessage: true, errorDetails,
      message: { ...(makePreservedAssistant() as AssistantMessage).message,
        content: [{ type: 'text', text: 'Prompt is too long' }] },
    } as AssistantMessage
  }

  test('fits the provider budget despite an overestimated local tokenizer, preserving recent tool pairs', () => {
    const messages = toolHistory(44)
    // Counts captured from the real DeepSeek request: chars/4 estimates this
    // repeated log much higher than the provider. Subtracting its raw token
    // gap from our estimate leaves too many rounds and exhausts the retries.
    const error = overflow("This model's maximum context length is 1048576 tokens. However, you requested 3763011 tokens (3731011 in the messages, 32000 in the completion).")
    const result = truncateHeadForPTLRetry(messages, error)!
    const uses = result.flatMap(message => message.type === 'assistant'
      ? message.message.content.filter(block => block.type === 'tool_use') : [])
    const results = result.flatMap(message => message.type === 'user' && Array.isArray(message.message.content)
      ? message.message.content.filter(block => block.type === 'tool_result') : [])
    // Real fixture rounds cost about 84k tokens each, plus fixed request
    // overhead. A retry must actually fit, not merely become smaller.
    expect(62_000 + uses.length * 84_114).toBeLessThan(1_048_576)
    expect(uses.length).toBeGreaterThan(0)
    expect(uses.map(block => block.id)).toEqual(results.map(block => block.tool_use_id))
    expect(uses.at(-1)?.id).toBe('read-43')
    expect(result.at(-1)).toBe(messages.at(-1))
    expect(messages).toHaveLength(91)
    expect(result[0]?.type).toBe('user')
  })

  test('unparseable overflow still makes progress across retries and keeps the newest round', () => {
    const messages = toolHistory(8)
    const error = overflow('Provider rejected the prompt without token counts')
    const first = truncateHeadForPTLRetry(messages, error)!
    const second = truncateHeadForPTLRetry(first, error)!
    expect(first.length).toBeLessThan(messages.length)
    expect(second.length).toBeLessThan(first.length)
    expect(second.at(-1)).toBe(messages.at(-1))
    expect(second[0]?.type).toBe('user')
  })
})

describe('stripImagesFromMessages', () => {
  const image = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
  }
  const userWith = (content: unknown) =>
    ({
      ...makePreservedUser(),
      uuid: crypto.randomUUID(),
      message: { role: 'user', content },
    }) as Message

  test('replaces images and documents with markers, including inside tool results', () => {
    const [stripped] = stripImagesFromMessages([
      userWith([
        { type: 'text', text: 'look' },
        image,
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
        },
        { type: 'tool_result', tool_use_id: 't1', content: [image, { type: 'text', text: 'caption' }] },
      ]),
    ])

    expect((stripped as { message: { content: unknown } }).message.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'text', text: '[image]' },
      { type: 'text', text: '[document]' },
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: [
          { type: 'text', text: '[image]' },
          { type: 'text', text: 'caption' },
        ],
      },
    ])
  })

  test('returns messages without media untouched', () => {
    const plain = userWith([{ type: 'text', text: 'plain' }])
    const assistant = makePreservedAssistant()

    const result = stripImagesFromMessages([plain, assistant])

    expect(result[0]).toBe(plain)
    expect(result[1]).toBe(assistant)
  })
})

// #1451: an openai_responses relay that keeps the connection warm with empty
// text deltas makes the transform emit a blank trailing content block, which
// claude.ts turns into its own blank assistant message. Compaction must read
// the real summary instead of reporting the response as empty.
describe('a trailing blank assistant does not hide the compaction summary (#1451)', () => {
  const assistantWith = (text: string): AssistantMessage =>
    ({
      type: 'assistant',
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      message: { id: crypto.randomUUID(), role: 'assistant', model: 'mock-model', content: [{ type: 'text', text }] },
    }) as unknown as AssistantMessage
  const blankAssistant = () =>
    ({
      type: 'assistant',
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      message: { id: crypto.randomUUID(), role: 'assistant', model: 'mock-model', content: [{ type: 'text', text: '' }] },
    }) as unknown as AssistantMessage
  const apiErrorAssistant = (text: string): AssistantMessage =>
    ({
      type: 'assistant',
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      isApiErrorMessage: true,
      message: { id: crypto.randomUUID(), role: 'assistant', model: 'mock-model', content: [{ type: 'text', text }] },
    }) as unknown as AssistantMessage

  test('the summary before a blank trailing block is still found', () => {
    const summary = assistantWith('valid summary')

    const found = findLastAssistantWithText([summary, blankAssistant()])

    expect(found).toBe(summary)
    expect(getAssistantMessageText(found!)).toBe('valid summary')
  })

  test('a blank-only response yields nothing so the caller falls back', () => {
    const blank = blankAssistant()

    expect(findLastAssistantWithText([blank])).toBeUndefined()
  })

  test('an API error after a valid summary still wins the walk', () => {
    const error = apiErrorAssistant('API Error: upstream refused the request')

    expect(findLastAssistantWithText([assistantWith('valid summary'), blankAssistant(), error])).toBe(error)
  })

  test('a blank streaming assistant cannot displace a collected summary', () => {
    const summary = assistantWith('valid summary')

    expect(shouldAdoptCompactionResponse(summary, blankAssistant())).toBe(false)
    expect(shouldAdoptCompactionResponse(summary, summary)).toBe(true)
    expect(shouldAdoptCompactionResponse(undefined, blankAssistant())).toBe(true)
  })

  test('a prompt-too-long error still replaces a collected summary', () => {
    const ptl = assistantWith(PROMPT_TOO_LONG_ERROR_MESSAGE)

    expect(shouldAdoptCompactionResponse(assistantWith('valid summary'), ptl)).toBe(true)
    expect(shouldAdoptCompactionResponse(assistantWith('valid summary'), apiErrorAssistant('API Error: 500'))).toBe(true)
  })
})
