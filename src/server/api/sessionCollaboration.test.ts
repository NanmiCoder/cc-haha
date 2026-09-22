import { expect, test } from 'bun:test'
import { handleSessionCollaborationApi, handleSessionCollaborationUiApi } from './sessionCollaboration.js'
import type { SessionCollaborationService } from '../services/sessionCollaborationService.js'

const request = (body: unknown) => new Request('http://127.0.0.1/api/session-collaboration/send', { method: 'POST', body: JSON.stringify(body) })

test('UI and tool search pass request cancellation to the query service', async () => {
  const controller = new AbortController()
  const signals: AbortSignal[] = []
  const service = {
    candidates: async (_query: string, signal: AbortSignal) => { signals.push(signal); return { sessions: [] } },
    list: async ({ signal }: { signal: AbortSignal }) => { signals.push(signal); return { sessions: [] } },
  } as unknown as SessionCollaborationService
  const url = new URL('http://127.0.0.1/api/session-collaboration?query=repair')
  const uiRequest = new Request(url, { signal: controller.signal })
  expect((await handleSessionCollaborationUiApi(uiRequest, url, service)).status).toBe(200)
  const toolRequest = new Request(url, { method: 'POST', body: JSON.stringify({ query: 'repair' }), signal: controller.signal })
  expect((await handleSessionCollaborationApi(toolRequest, 'list', 'caller', service)).status).toBe(200)
  controller.abort()
  expect(signals).toHaveLength(2)
  expect(signals.every(signal => signal.aborted)).toBe(true)
})

test('tool API derives message sender from authenticated caller, not request body', async () => {
  let args: unknown[] = []
  const service = { send: async (...input: unknown[]) => { args = input; return { id: 'm' } } } as unknown as SessionCollaborationService
  const response = await handleSessionCollaborationApi(request({ sourceSessionId: 'spoofed', targetSessionId: 'target', content: 'text', messageId: 'm' }), 'send', 'authenticated', service)
  expect(response.status).toBe(200)
  expect(args).toEqual(['authenticated', 'target', 'text', 'm'])
})

test('tool API rejects malformed read/wait inputs before invoking the service', async () => {
  const service = {} as SessionCollaborationService
  expect((await handleSessionCollaborationApi(request({ sessionId: 's', limit: -1 }), 'read', 'caller', service)).status).toBe(400)
  expect((await handleSessionCollaborationApi(request({ sessionIds: Array.from({ length: 9 }, () => 's') }), 'wait', 'caller', service)).status).toBe(400)
})

test('UI Stop uses the group boundary', async () => {
  let stopped: string | undefined
  const service = { stopGroup: async (id: string) => { stopped = id } } as SessionCollaborationService
  const url = new URL('http://127.0.0.1/api/session-collaboration/root/stop')
  const response = await handleSessionCollaborationUiApi(new Request(url, { method: 'POST' }), url, service)
  expect(response.status).toBe(200)
  expect(stopped).toBe('root')
})
