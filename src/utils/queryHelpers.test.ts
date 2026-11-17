import { describe, expect, test } from 'bun:test'
import {
  SDKMessageSchema,
  SDKUserMessageSchema,
} from '../entrypoints/sdk/coreSchemas.js'
import { yieldMissingToolResultBlocks } from '../query.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createProgressMessage,
  createUserInterruptionMessage,
  createUserMessage,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  normalizeMessages,
} from './messages.js'
import { toInternalMessages, toSDKMessages } from './messages/mappers.js'
import { isResultSuccessful, normalizeMessage } from './queryHelpers.js'

describe('isResultSuccessful', () => {
  test('treats user interruption during tool use as a normal terminal result', () => {
    const interruption = createUserInterruptionMessage({ toolUse: true })

    expect(isResultSuccessful(interruption, 'tool_use')).toBe(true)
  })

  test('does not treat an ordinary user prompt as successful after tool_use', () => {
    const ordinaryPrompt = createUserInterruptionMessage({ toolUse: true })
    ordinaryPrompt.message.content = [
      {
        type: 'text',
        text: `${INTERRUPT_MESSAGE_FOR_TOOL_USE} keep going`,
      },
    ]

    expect(isResultSuccessful(ordinaryPrompt, 'tool_use')).toBe(false)
  })
})

describe('normalizeMessage', () => {
  // The desktop server localizes synthetic errors by the code on the SDK
  // assistant frame; dropping it here left them in English (#1544).
  test('keeps the business error code on synthetic API errors', () => {
    const [frame] = [...normalizeMessage(createAssistantAPIErrorMessage({
      content: 'Auto-compact is thrashing',
      error: 'invalid_request',
      businessErrorCode: 'autocompact_thrashing',
    }))]

    expect(frame).toMatchObject({
      type: 'assistant',
      error: 'invalid_request',
      businessErrorCode: 'autocompact_thrashing',
    })
  })

  test('does not add a code to ordinary API errors', () => {
    const [frame] = [...normalizeMessage(createAssistantAPIErrorMessage({
      content: 'upstream failed',
      error: 'unknown',
    }))]

    expect(frame).not.toHaveProperty('businessErrorCode')
  })

  test('propagates tool execution durationMs through normalizeMessages, normalizeMessage, and SDK mappers (#1915)', () => {
    const toolResultMsg = createUserMessage({
      content: [
        { type: 'tool_result', tool_use_id: 'edit-1', content: 'updated' },
        { type: 'text', text: 'accept feedback' },
      ],
      durationMs: 220,
    })

    const split = normalizeMessages([toolResultMsg])
    expect(split).toHaveLength(2)
    expect((split[0] as { durationMs?: number }).durationMs).toBe(220)
    expect('durationMs' in split[1]!).toBe(false)

    const [sdkResultFrame, sdkTextFrame] = [...normalizeMessage(toolResultMsg)]
    expect(sdkResultFrame).toMatchObject({ type: 'user', durationMs: 220 })
    expect('durationMs' in sdkTextFrame!).toBe(false)

    const progress = createProgressMessage({
      toolUseID: 'edit-1',
      parentToolUseID: 'agent-1',
      data: {
        type: 'agent_progress',
        prompt: 'edit',
        agentId: 'sub-1' as never,
        message: split[0]!,
      } as never,
    })
    const [subagentFrame] = [...normalizeMessage(progress)]
    expect(subagentFrame).toMatchObject({
      type: 'user',
      parent_tool_use_id: 'agent-1',
      durationMs: 220,
    })

    const sdkMapped = toSDKMessages([split[0]!, split[1]!])
    expect(sdkMapped[0]).toMatchObject({ type: 'user', durationMs: 220 })
    expect('durationMs' in sdkMapped[1]!).toBe(false)

    const internalMapped = toInternalMessages(sdkMapped)
    expect((internalMapped[0] as { durationMs?: number }).durationMs).toBe(220)
    expect('durationMs' in internalMapped[1]!).toBe(false)
  })

  test('stamps durationMs: 0 on synthetic missing tool_result blocks (#1915)', () => {
    const assistant = createAssistantMessage({
      content: [
        { type: 'tool_use', id: 'toolu_interrupted', name: 'Edit', input: { file_path: 'a.ts' } },
      ],
    })
    const [synthetic] = [...yieldMissingToolResultBlocks([assistant], 'Request was aborted.')]
    expect(synthetic).toBeDefined()
    expect((synthetic as { durationMs?: number }).durationMs).toBe(0)
  })

  test('validates durationMs in SDKUserMessageSchema and SDKMessageSchema (#1915)', () => {
    const baseUserFrame = {
      type: 'user' as const,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'edit-1', content: 'ok' }],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-000000000001',
      session_id: 'session-1',
    }

    expect(SDKUserMessageSchema().parse({ ...baseUserFrame, durationMs: 0 }).durationMs).toBe(0)
    expect(SDKUserMessageSchema().parse({ ...baseUserFrame, durationMs: 220 }).durationMs).toBe(220)
    expect('durationMs' in SDKUserMessageSchema().parse(baseUserFrame)).toBe(false)

    const parsedUnion = SDKMessageSchema().parse({ ...baseUserFrame, durationMs: 0 })
    expect(parsedUnion).toMatchObject({ type: 'user', durationMs: 0 })

    expect(SDKUserMessageSchema().safeParse({ ...baseUserFrame, durationMs: -1 }).success).toBe(false)
    expect(SDKMessageSchema().safeParse({ ...baseUserFrame, durationMs: -1 }).success).toBe(false)
    expect(SDKUserMessageSchema().safeParse({ ...baseUserFrame, durationMs: Number.NaN }).success).toBe(false)
    expect(SDKUserMessageSchema().safeParse({ ...baseUserFrame, durationMs: Number.POSITIVE_INFINITY }).success).toBe(false)
  })
})
