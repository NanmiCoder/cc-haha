import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import {
  buildPostCompactMessages,
  createCompactApiAttemptBudget,
  createPostCompactDeltaAttachments,
  getCompactForkMaxOutputTokens,
  streamCompactSummary,
  stripImagesFromMessages,
  truncateHeadForPTLRetry,
  type CompactionResult,
} from './compact.js'
import { setAgentProfile } from '../../utils/agentProfile.js'
import * as attachments from '../../utils/attachments.js'
import * as forkedAgent from '../../utils/forkedAgent.js'
import { COMPACT_MAX_OUTPUT_TOKENS } from '../../utils/context.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
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

describe('compaction fork output allowance near the context window', () => {
  const ENV_KEYS = ['CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_MODEL_CONTEXT_WINDOWS'] as const
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  // claude-opus-4-8: 1M window, 64K default output allowance.
  test('leaves the fork identical to the main thread while the default allowance fits', () => {
    expect(getCompactForkMaxOutputTokens(900_000, 'claude-opus-4-8')).toBeUndefined()
    // 930K + 5K overhead + 64K = exactly the window.
    expect(getCompactForkMaxOutputTokens(931_000, 'claude-opus-4-8')).toBeUndefined()
  })

  test('caps the fork to the 20K summary reserve once the default allowance would not fit', () => {
    // The auto-compact threshold for a 1M window is 967K.
    expect(getCompactForkMaxOutputTokens(967_000, 'claude-opus-4-8')).toBe(COMPACT_MAX_OUTPUT_TOKENS)
    expect(getCompactForkMaxOutputTokens(931_001, 'claude-opus-4-8')).toBe(COMPACT_MAX_OUTPUT_TOKENS)
  })

  test('follows the configured window, so a 200K model is capped at its own threshold', () => {
    // claude-sonnet-4-6: 200K window, 32K default; its threshold is 167K.
    expect(getCompactForkMaxOutputTokens(120_000, 'claude-sonnet-4-6')).toBeUndefined()
    expect(getCompactForkMaxOutputTokens(167_000, 'claude-sonnet-4-6')).toBe(COMPACT_MAX_OUTPUT_TOKENS)
    process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS = JSON.stringify({ 'claude-opus-4-8': 500_000 })
    expect(getCompactForkMaxOutputTokens(450_000, 'claude-opus-4-8')).toBe(COMPACT_MAX_OUTPUT_TOKENS)
  })

  test('does not touch a fork whose allowance is already within the summary reserve', () => {
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '8000'
    expect(getCompactForkMaxOutputTokens(990_000, 'claude-opus-4-8')).toBeUndefined()
  })

  describe('as sent by the cache-sharing fork', () => {
    let forkSpy: ReturnType<typeof spyOn>
    let captured: forkedAgent.ForkedAgentParams | undefined
    beforeEach(() => {
      captured = undefined
      forkSpy = spyOn(forkedAgent, 'runForkedAgent').mockImplementation(async params => {
        captured = params
        return {
          messages: [createAssistantMessage({ content: '<summary>ok</summary>' })],
          totalUsage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        } as never
      })
    })
    afterEach(() => forkSpy.mockRestore())

    async function summarize(preCompactTokenCount: number) {
      const abortController = new AbortController()
      const context = {
        abortController,
        options: { mainLoopModel: 'claude-opus-4-8' },
        setResponseLength: () => {},
        setSDKStatus: () => {},
      }
      return streamCompactSummary({
        messages: [],
        summaryRequest: createUserMessage({ content: 'summarize' }),
        appState: {} as never,
        context: context as never,
        preCompactTokenCount,
        cacheSafeParams: { systemPrompt: ['s'], userContext: {}, systemContext: {}, toolUseContext: context, forkContextMessages: [] } as never,
        apiAttemptBudget: createCompactApiAttemptBudget(),
      })
    }

    test('keeps the main thread allowance with room to spare, preserving the cache key', async () => {
      await summarize(600_000)
      expect(captured).toBeDefined()
      expect(captured?.maxOutputTokens).toBeUndefined()
      expect(captured?.querySource).toBe('compact')
    })

    test('requests only the summary reserve at the threshold instead of a size-rejected default', async () => {
      await summarize(967_000)
      expect(captured?.maxOutputTokens).toBe(COMPACT_MAX_OUTPUT_TOKENS)
    })
  })
})

describe('post-compact delta re-announcement', () => {
  const savedDelta = process.env.CLAUDE_CODE_MCP_INSTR_DELTA
  // A connected server whose handshake carried instructions, as print mode tracks it.
  const instructedServer = {
    type: 'connected', name: 'fixture-mcp', instructions: 'FIXTURE_MCP_INSTRUCTIONS',
    capabilities: {}, client: {}, cleanup: async () => {},
    config: { type: 'stdio', command: 'fixture', args: [], scope: 'user' },
  }
  const context = () => ({
    options: { tools: [], mainLoopModel: 'mock-model', mcpClients: [instructedServer], agentDefinitions: { activeAgents: [], allAgents: [] } },
  }) as never

  beforeEach(() => {
    process.env.CLAUDE_CODE_MCP_INSTR_DELTA = '1'
  })
  afterEach(() => {
    if (savedDelta === undefined) delete process.env.CLAUDE_CODE_MCP_INSTR_DELTA
    else process.env.CLAUDE_CODE_MCP_INSTR_DELTA = savedDelta
    setAgentProfile('standard')
  })

  test('standard re-announces connected MCP instructions after full and partial compaction', () => {
    const full = createPostCompactDeltaAttachments(context(), [], 'compact_full')
    expect(full.map(message => message.attachment)).toEqual([expect.objectContaining({
      type: 'mcp_instructions_delta', addedNames: ['fixture-mcp'],
    })])
    expect(createPostCompactDeltaAttachments(context(), [makePreservedUser()], 'compact_partial')).toHaveLength(1)
  })

  test('lean never gains MCP instructions through compaction, even with the delta gate on', () => {
    setAgentProfile('lean')
    expect(createPostCompactDeltaAttachments(context(), [], 'compact_full')).toEqual([])
    expect(createPostCompactDeltaAttachments(context(), [makePreservedUser()], 'compact_partial')).toEqual([])
  })

  test('standard keeps the previous producer order and arguments', () => {
    const kept = [makePreservedUser()]
    const calls: unknown[] = []
    const spies = [
      spyOn(attachments, 'getDeferredToolsDeltaAttachment').mockImplementation((_tools, model, messages, scan) => {
        calls.push(['deferred', model, messages === kept, scan?.callSite])
        return [{ type: 'deferred_tools_delta', addedNames: ['Deferred'], addedLines: ['Deferred'], removedNames: [] }] as never
      }),
      spyOn(attachments, 'getAgentListingDeltaAttachment').mockImplementation((_context, messages) => {
        calls.push(['agents', messages === kept])
        return [{ type: 'agent_listing_delta', addedTypes: ['fixture'], addedLines: ['fixture'], removedTypes: [], isInitial: true, showConcurrencyNote: false }] as never
      }),
      spyOn(attachments, 'getMcpInstructionsDeltaAttachment').mockImplementation((clients, _tools, model, messages) => {
        calls.push(['mcp', clients.length, model, messages === kept])
        return [{ type: 'mcp_instructions_delta', addedNames: ['fixture-mcp'], addedBlocks: ['block'], removedNames: [] }] as never
      }),
    ]
    try {
      const result = createPostCompactDeltaAttachments(context(), kept, 'compact_partial')
      expect(result.map(message => message.attachment.type)).toEqual(['deferred_tools_delta', 'agent_listing_delta', 'mcp_instructions_delta'])
      expect(calls).toEqual([
        ['deferred', 'mock-model', true, 'compact_partial'],
        ['agents', true],
        ['mcp', 1, 'mock-model', true],
      ])
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
