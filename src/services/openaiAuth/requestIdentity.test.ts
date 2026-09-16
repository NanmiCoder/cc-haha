import { describe, expect, test } from 'bun:test'
import { resolveOpenAIRequestIdentity } from './requestIdentity.js'

describe('OpenAI request identity', () => {
  test('uses root UUID as UUIDv5 namespace for stable branch identity', () => {
    expect(resolveOpenAIRequestIdentity('01234567-89ab-4cde-8fab-0123456789ab', 'a0000000000000001')).toEqual({
      sessionId: '01234567-89ab-4cde-8fab-0123456789ab',
      threadId: 'cd60d441-70fc-52c7-b989-79084eb60b3a',
    })
  })

  test('supports legacy session IDs without ambiguous concatenation or random state', () => {
    const a = resolveOpenAIRequestIdentity(' legacy-root ', 'branch')
    expect(a).toEqual(resolveOpenAIRequestIdentity('legacy-root', 'branch'))
    expect(a?.sessionId).toBe('legacy-root')
    expect(a?.threadId).not.toBe(resolveOpenAIRequestIdentity('legacy-rootbranch', '')?.threadId)
    expect(a?.threadId).not.toBe(resolveOpenAIRequestIdentity('legacy-root', 'another')?.threadId)
    expect(resolveOpenAIRequestIdentity('legacy-root')).toEqual({ sessionId: 'legacy-root', threadId: 'legacy-root' })
  })

  test('missing root identity stays absent even when branch identity is supplied', () => {
    for (const root of [undefined, null, '', '   ']) {
      expect(resolveOpenAIRequestIdentity(root, 'branch')).toBeUndefined()
    }
  })
})
