import { describe, expect, test } from 'bun:test'
import type { Message } from '../types/message.js'
import { createAssistantAPIErrorMessage, createAssistantMessage } from './messages.js'
import { getLastAssistantTextForHook } from './hooks.js'

// #1468: a provider ending the stream with an empty text block appends a
// blank assistant message; Stop/SubagentStop hooks must still see the real
// reply as last_assistant_message.
describe('getLastAssistantTextForHook', () => {
  const reply = (text: string): Message =>
    createAssistantMessage({ content: [{ type: 'text', text }] }) as Message
  const blank = (): Message =>
    createAssistantMessage({ content: [{ type: 'text', text: '' }] }) as Message

  test('returns the last assistant text', () => {
    expect(getLastAssistantTextForHook([reply('earlier'), reply('final reply')])).toBe(
      'final reply',
    )
  })

  test('skips a blank trailing assistant and returns the real reply', () => {
    expect(getLastAssistantTextForHook([reply('real reply'), blank()])).toBe(
      'real reply',
    )
  })

  test('returns the API error text when it wins the walk', () => {
    const error = createAssistantAPIErrorMessage({
      content: 'API Error: 529 Overloaded',
    }) as Message
    expect(getLastAssistantTextForHook([reply('real reply'), blank(), error])).toBe(
      'API Error: 529 Overloaded',
    )
  })

  test('returns undefined when no assistant carries text', () => {
    expect(getLastAssistantTextForHook([blank()])).toBeUndefined()
    expect(getLastAssistantTextForHook([])).toBeUndefined()
  })
})
