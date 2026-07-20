import { describe, expect, test } from 'bun:test'
import {
  createUserInterruptionMessage,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
} from './messages.js'
import { isResultSuccessful } from './queryHelpers.js'

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
