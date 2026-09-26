import { describe, expect, test } from 'bun:test'

import {
  ERROR_MESSAGE_USER_ABORT,
  buildPostCompactMessages,
  maybeVccCompact,
  maybeVccSliceCompact,
  truncateHeadForPTLRetry,
  type CompactionResult,
} from './compact.js'
import { getCurrentUsage } from '../../utils/tokens.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { runVccCompaction } from './vcc/vccCompact.js'

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

describe('vcc compaction degrades instead of stalling the session', () => {
  // The ported adapter reads `m.message.content` without checking that the
  // message is there, so a user line carrying no `message` object throws
  // inside pi-vcc. The throw is not mocked: the assertions below only hold if
  // the real call chain reaches the catch.
  const userLineWithoutMessage = { type: 'user', uuid: 'hostile-1' }
  const throwingLine = (thrown: string) => ({
    type: 'user',
    uuid: 'hostile-2',
    message: {
      get content(): never {
        throw new Error(thrown)
      },
    },
  })

  test('returns null so the caller keeps running the LLM summary', () => {
    // `vccCompactBackend` is unset here, which resolves to 'algorithm' — the
    // production default — so the algorithmic backend really is the one tried.
    expect(maybeVccCompact([userLineWithoutMessage] as never[], undefined, 120_000)).toBeNull()
  })

  test('lets a user abort through untouched', () => {
    // Aborting is not a vcc defect; swallowing it would stop the user's own
    // interrupt from propagating.
    expect(() =>
      maybeVccCompact([throwingLine(ERROR_MESSAGE_USER_ABORT)] as never[], undefined, 120_000),
    ).toThrow(ERROR_MESSAGE_USER_ABORT)
  })

  test('returns null when the window compiles to no summary text', () => {
    // Assert the premise rather than assume it: this window really does compile
    // to an empty summary, so the backend is declining a result that would
    // otherwise replace the conversation with a blank boundary.
    expect(runVccCompaction({ messages: [], preCompactTokenCount: 120_000 }).summary.trim()).toBe('')
    expect(maybeVccCompact([] as never[], undefined, 120_000)).toBeNull()
  })
})

describe('partial compaction reaches the algorithmic backend', () => {
  // Half a conversation cannot honestly report the session's goal or standing
  // preferences, so those sections are suppressed on this path.
  const half = [
    {
      type: 'user',
      uuid: 'p1',
      message: { role: 'user', content: 'Fix the streak rendering in the viewer.' },
    },
    {
      type: 'assistant',
      uuid: 'p2',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Editing the viewer.' },
          { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/tmp/viewer.html' } },
        ],
      },
    },
  ] as never[]

  test('a chosen side compiles without the session-wide headers', () => {
    const result = maybeVccSliceCompact(half, 40_000)
    expect(result).not.toBeNull()
    expect(result!.summary).not.toContain('[Session Goal]')
    expect(result!.summary).not.toContain('[User Preferences]')
    // The caller keeps the other side; a kept tail here would double-keep.
    expect(result!.messagesToKeep).toEqual([])
  })

  test('an empty side reports nothing rather than a blank boundary', () => {
    // A blank summary would replace one side of the pivot while reporting
    // success — the LLM path refuses in this situation, so vcc must too.
    expect(maybeVccSliceCompact([], 40_000)).toBeNull()
  })

  test('a defective compile degrades to the LLM summary instead of stranding the pivot', () => {
    const hostile = [{ type: 'user', uuid: 'p3' }] as never[]
    expect(maybeVccSliceCompact(hostile, 40_000)).toBeNull()
  })
})
