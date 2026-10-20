import { expect, test } from 'bun:test'
import { matchesDelegationUserInstruction } from './sessionDelegationEvidence.js'

test('delegation evidence belongs to the latest human message, never a peer or assistant', () => {
  const messages = [
    { id: 'old', type: 'user', content: 'Use A' },
    { id: 'new', type: 'user', content: [{ type: 'text', text: 'Use B for review' }] },
    { id: 'assistant', type: 'assistant', content: 'Use C' },
    { id: 'peer', type: 'user', content: 'Use C', collaboration: { sourceSessionId: 'other' } },
  ]
  expect(matchesDelegationUserInstruction(messages, { messageId: 'new', quote: 'Use B for review' })).toBe(true)
  for (const messageId of ['old', 'assistant', 'peer', 'missing']) {
    expect(matchesDelegationUserInstruction(messages, { messageId, quote: 'Use' })).toBe(false)
  }
  expect(matchesDelegationUserInstruction(messages, { messageId: 'new', quote: 'Use C' })).toBe(false)
  expect(matchesDelegationUserInstruction(messages, { messageId: 'new', quote: ' ' })).toBe(false)
})
