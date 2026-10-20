import { expect, test } from 'bun:test'
import { sessionCollaborationTools } from './SessionCollaborationTool.js'

test('exposes session tools with explicit mutation boundaries and bounded arguments', () => {
  expect(sessionCollaborationTools.map(tool => tool.name)).toEqual(['ListSessions', 'ReadSession', 'CreateSession', 'SendSessionMessage', 'WaitSessions', 'ListSessionModels', 'CreateSessions'])
  expect(sessionCollaborationTools.map(tool => tool.isReadOnly({} as never))).toEqual([true, true, false, false, true, true, false])
  expect(sessionCollaborationTools[4]!.inputSchema.safeParse({ timeoutMs: 300_001 }).success).toBe(false)
  expect(sessionCollaborationTools[4]!.inputSchema.safeParse({ timeoutMs: 300_000 }).success).toBe(true)
  expect(sessionCollaborationTools[4]!.inputSchema.safeParse({ sessionIds: Array(9).fill('peer') }).success).toBe(false)
  expect(sessionCollaborationTools[1]!.inputSchema.safeParse({ sessionId: 'peer', cursor: 'a'.repeat(1000) }).success).toBe(true)
  expect(sessionCollaborationTools[3]!.inputSchema.safeParse({ targetSessionId: 'peer', content: '' }).success).toBe(false)
  expect(sessionCollaborationTools[2]!.inputSchema.safeParse({ prompt: 'Implement widget', title: 'Widget' }).success).toBe(true)
})


test('batch creation bounds tasks and accepts exact provider/model identities', () => {
  const tool = sessionCollaborationTools.find(tool => tool.name === 'CreateSessions')!
  expect(tool.inputSchema.safeParse({ sessions: [] }).success).toBe(false)
  expect(tool.inputSchema.safeParse({ sessions: Array(9).fill({ prompt: 'task' }) }).success).toBe(false)
  expect(tool.inputSchema.safeParse({ sessions: [{ prompt: 'review', runtime: { providerId: 'provider-a', modelId: 'shared-name' }, userInstruction: { quote: 'Use shared-name for review' } }] }).success).toBe(true)
  expect(tool.inputSchema.safeParse({ sessions: [{ prompt: 'review', userInstruction: { messageId: 'spoofed', quote: 'a' } }] }).success).toBe(false)
})

test('pending proposals yield the turn and explicit quotes get the actual latest human message identity', async () => {
  const { consumeUserDecisionTurnPause } = await import('../../utils/userDecisionTurnBoundary.js')
  const names = ['CC_HAHA_DESKTOP_SERVER_URL', 'CC_HAHA_SESSION_COLLABORATION_TOKEN', 'CC_HAHA_SESSION_ID'] as const
  const original = names.map(name => process.env[name])
  const fetchBefore = globalThis.fetch
  const payloads: any[] = []
  let requiresReview = true
  try {
    process.env.CC_HAHA_DESKTOP_SERVER_URL = 'http://127.0.0.1:12345'
    process.env.CC_HAHA_SESSION_COLLABORATION_TOKEN = 'fixture-token'
    process.env.CC_HAHA_SESSION_ID = 'fixture-parent'
    globalThis.fetch = (async (_url, options) => {
      payloads.push(JSON.parse(String(options?.body)))
      return Response.json({ state: requiresReview ? 'review' : 'launched', requiresReview })
    }) as typeof fetch
    const controller = new AbortController()
    const context = {
      abortController: controller, toolUseId: 'call-1',
      messages: [
        { type: 'user', uuid: 'human-id', message: { content: 'Use A for review' } },
        { type: 'user', uuid: 'peer-id', isMeta: true, message: { content: 'Use B' } },
      ],
    } as never
    const tool = sessionCollaborationTools.find(tool => tool.name === 'CreateSessions')!
    await tool.call({ sessions: [{ prompt: 'review' }] } as never, context)
    expect(payloads[0].requestId).toBe('call-1')
    expect(consumeUserDecisionTurnPause(controller)).toBe(true)
    expect(consumeUserDecisionTurnPause(controller)).toBe(false)
    requiresReview = false
    await tool.call({ sessions: [{ prompt: 'review', runtime: { providerId: 'provider-a', modelId: 'A' }, userInstruction: { quote: 'Use A for review' } }] } as never, context)
    expect(payloads[1].sessions[0].userInstruction).toEqual({ messageId: 'human-id', quote: 'Use A for review' })
    expect(consumeUserDecisionTurnPause(controller)).toBe(false)
  } finally {
    globalThis.fetch = fetchBefore
    names.forEach((name, index) => { if (original[index] === undefined) delete process.env[name]; else process.env[name] = original[index] })
  }
})
