import { describe, expect, it } from 'vitest'
import type { ManagedContextSubmission } from './chatSubmission'
import { buildUserMessageFrame } from './userMessageFrame'

describe('upstream session references with managed context tickets', () => {
  it('keeps the original wire shape when neither feature is selected', () => {
    expect(buildUserMessageFrame({ content: 'hello', sessionReferences: [], submission: null }))
      .toEqual({ type: 'user_message', content: 'hello', attachments: undefined })
  })

  it('retains session references without allocating a context ticket', () => {
    const sessionReferences = [{ sessionId: 'session-reference' }]
    const frame = buildUserMessageFrame({ content: 'hello', sessionReferences })
    expect(frame.sessionReferences).toEqual(sessionReferences)
    expect(frame).not.toHaveProperty('requestId')
    expect(frame).not.toHaveProperty('contextTicket')
  })

  it('retains both reference metadata and the original managed submission identity', () => {
    // The transport reads only submissionId; it must not inspect or transmit snapshot contents.
    const submission = { submissionId: 'prepared-request' } as ManagedContextSubmission
    const sessionReferences = [{ sessionId: 'session-reference' }]
    const ticket = { ticketId: 'fixture-ticket', sidecarInstanceId: 'fixture-sidecar' }
    const frame = buildUserMessageFrame({ content: 'hello', sessionReferences, submission, ticket })
    expect(frame).toMatchObject({ sessionReferences, requestId: 'prepared-request', contextTicket: ticket })
    expect(frame).not.toHaveProperty('snapshot')
  })
})
