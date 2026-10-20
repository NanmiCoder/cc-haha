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

test('single and batch tool calls propose work instead of creating before review', async () => {
  const calls: unknown[][] = []
  const service = { propose: async (...args: unknown[]) => { calls.push(args); return { id: 'batch', state: 'review', sessions: [] } } } as unknown as SessionCollaborationService
  const single = await handleSessionCollaborationApi(request({ prompt: 'review', requestId: 'r', runtime: { providerId: 'a', modelId: 'shared' } }), 'create', 'caller', service)
  expect(single.status).toBe(200)
  expect(await single.json()).toMatchObject({ requiresReview: true })
  expect(calls[0]).toEqual(['caller', { requestId: 'r', sessions: [{ prompt: 'review', requestId: undefined, runtime: { providerId: 'a', modelId: 'shared' } }] }])
  const batch = await handleSessionCollaborationApi(request({ requestId: 'r2', sessions: [{ prompt: 'work' }] }), 'create-batch', 'caller', service)
  expect(batch.status).toBe(200)
  expect(calls).toHaveLength(2)
  const invalid = await handleSessionCollaborationApi(request({ requestId: 'r3', sessions: [{ prompt: 'work', model: 'old', runtime: { providerId: 'a', modelId: 'shared' } }] }), 'create-batch', 'caller', service)
  expect(invalid.status).toBe(400)
  expect(calls).toHaveLength(2)
})

test('UI model changes validate input and bind the route session', async () => {
  const calls: unknown[][] = []
  const service = { changeModels: async (...args: unknown[]) => { calls.push(args); return { id: 'change' } } } as unknown as SessionCollaborationService
  const url = new URL('http://localhost/api/session-collaboration/parent/model-changes')
  const input = { requestId: 'change', mode: 'after_turn', selections: [{ sessionId: 'child', runtime: { providerId: 'b', modelId: 'shared' } }] }
  const response = await handleSessionCollaborationUiApi(new Request(url, { method: 'POST', body: JSON.stringify(input) }), url, service)
  expect(response.status).toBe(200)
  expect(calls).toEqual([['parent', input, { wait: false }]])
  const invalid = await handleSessionCollaborationUiApi(new Request(url, { method: 'POST', body: '{' }), url, service)
  expect(invalid.status).toBe(400)
})

test('tool credentials cannot approve or alter pending model selections', async () => {
  const response = await handleSessionCollaborationApi(request({ expectedRevision: 1 }), 'confirm', 'caller', {} as SessionCollaborationService)
  expect(response.status).toBe(404)
})
