import { describe, expect, test } from 'bun:test'
import {
  createAssistantAPIErrorMessage,
  createUserInterruptionMessage,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
} from './messages.js'
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
})
