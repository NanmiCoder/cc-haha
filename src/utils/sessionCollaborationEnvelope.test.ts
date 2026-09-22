import { describe, expect, it } from 'bun:test'
import {
  formatSessionCollaborationPrompt,
  parseSessionCollaborationEnvelope,
  SESSION_COLLABORATION_PROMPT_PREFIX,
} from './sessionCollaborationEnvelope.js'

describe('sessionCollaborationEnvelope', () => {
  it('round-trips a formatted prompt', () => {
    const envelope = { senderSessionId: 'root', messageId: 'm1', text: '多看一眼\n第二行 "quoted"' }
    expect(parseSessionCollaborationEnvelope(formatSessionCollaborationPrompt(envelope))).toEqual(envelope)
  })

  it('rejects ordinary user text and other content shapes', () => {
    expect(parseSessionCollaborationEnvelope('hello')).toBeNull()
    expect(parseSessionCollaborationEnvelope(undefined)).toBeNull()
    expect(parseSessionCollaborationEnvelope([{ type: 'text', text: 'x' }])).toBeNull()
    expect(parseSessionCollaborationEnvelope(SESSION_COLLABORATION_PROMPT_PREFIX + 'not json')).toBeNull()
    expect(parseSessionCollaborationEnvelope(SESSION_COLLABORATION_PROMPT_PREFIX + '{"senderSessionId":"a"}')).toBeNull()
  })

  it('keeps the model-facing prefix stable', () => {
    expect(SESSION_COLLABORATION_PROMPT_PREFIX.startsWith('Message from another session.')).toBe(true)
  })
})
