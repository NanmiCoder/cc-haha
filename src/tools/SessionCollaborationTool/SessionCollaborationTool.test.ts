import { expect, test } from 'bun:test'
import { sessionCollaborationTools } from './SessionCollaborationTool.js'

test('exposes five session tools with explicit mutation boundaries and bounded arguments', () => {
  expect(sessionCollaborationTools.map(tool => tool.name)).toEqual(['ListSessions', 'ReadSession', 'CreateSession', 'SendSessionMessage', 'WaitSessions'])
  expect(sessionCollaborationTools.map(tool => tool.isReadOnly({} as never))).toEqual([true, true, false, false, true])
  expect(sessionCollaborationTools[4]!.inputSchema.safeParse({ timeoutMs: 300_001 }).success).toBe(false)
  expect(sessionCollaborationTools[4]!.inputSchema.safeParse({ timeoutMs: 300_000 }).success).toBe(true)
  expect(sessionCollaborationTools[4]!.inputSchema.safeParse({ sessionIds: Array(9).fill('peer') }).success).toBe(false)
  expect(sessionCollaborationTools[1]!.inputSchema.safeParse({ sessionId: 'peer', cursor: 'a'.repeat(1000) }).success).toBe(true)
  expect(sessionCollaborationTools[3]!.inputSchema.safeParse({ targetSessionId: 'peer', content: '' }).success).toBe(false)
  expect(sessionCollaborationTools[2]!.inputSchema.safeParse({ prompt: 'Implement widget', title: 'Widget' }).success).toBe(true)
})
