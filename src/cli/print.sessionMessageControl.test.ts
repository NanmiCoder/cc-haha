import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'

const home = mkdtempSync(join(tmpdir(), 'peer-control-'))
const originalEnv = { ...process.env }
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, createSandboxedTestEnvironment(home, { CLAUDE_CODE_SIMPLE: '1' }, originalEnv))
const { __runHeadlessStreamingForTests } = await import('./print.js')
const { StructuredIO } = await import('./structuredIO.js')
const { Stream } = await import('../utils/stream.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { clearCommandQueue, getCommandQueue } = await import('../utils/messageQueueManager.js')
const { SDKSessionMessageReceiptSchema } = await import('../entrypoints/sdk/controlSchemas.js')
const { sessionMessageInputSchema, sessionMessageUuid } = await import('../utils/sessionMessageInbox.js')
const { setIsInteractive, getIsInteractive } = await import('../bootstrap/state.js')
const wasInteractive = getIsInteractive()
setIsInteractive(false)
afterAll(() => {
  clearCommandQueue()
  setIsInteractive(wasInteractive)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  rmSync(home, { recursive: true, force: true })
})

const peer = { subtype: 'enqueue_session_message', message_id: 'stop-queued', sender_session_id: 'peer', text: 'pending work' }

test('headless interrupt removes pending peer work and allows an explicit fresh redelivery', async () => {
  clearCommandQueue()
  const input = new Stream<string>()
  let state = getDefaultAppState()
  const output = __runHeadlessStreamingForTests(new StructuredIO(input), [], [], [], [], (() => undefined) as any, {}, () => state, update => { state = update(state) }, [], { outputFormat: 'stream-json' })
  const iterator = output[Symbol.asyncIterator]()
  async function request(id: string, request: unknown) {
    input.enqueue(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n')
    while (true) {
      const item = await iterator.next()
      if (item.done) throw new Error('Missing control response')
      if ((item.value as any).type === 'control_response') return (item.value as any).response
    }
  }
  try {
    expect((await request('enqueue', peer)).response).toMatchObject({ status: 'queued', duplicate: false })
    expect(getCommandQueue()).toHaveLength(1)
    expect((await request('interrupt', { subtype: 'interrupt' })).subtype).toBe('success')
    expect(getCommandQueue()).toHaveLength(0)
    expect((await request('redeliver', peer)).response).toMatchObject({ status: 'queued', duplicate: false })
    expect((await request('end', { subtype: 'end_session' })).subtype).toBe('success')
    expect(getCommandQueue()).toHaveLength(0)
  } finally {
    input.done()
    await iterator.return?.()
    clearCommandQueue()
  }
})

test('SDK control and receipt schemas preserve stable IDs and reject invalid wire messages', () => {
  expect(sessionMessageInputSchema.parse({ ...peer, start_if_idle: true }).start_if_idle).toBe(true)
  expect(sessionMessageInputSchema.safeParse({ ...peer, start_if_idle: 'true' }).success).toBe(false)
  const receipt = { type: 'system', subtype: 'session_message_receipt', message_id: peer.message_id, source_uuid: sessionMessageUuid(peer.message_id), status: 'consumed', duplicate: false, session_id: 'target', uuid: crypto.randomUUID() }
  expect(SDKSessionMessageReceiptSchema().parse(receipt)).toEqual(receipt)
  expect(SDKSessionMessageReceiptSchema().safeParse({ ...receipt, status: 'finished' }).success).toBe(false)
})
