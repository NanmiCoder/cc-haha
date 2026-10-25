import { expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { serveOfficialAgentSdkStdio } from './officialAgentSdk.js'
import type { OfficialAgentSdkBridge } from '../server/services/officialAgentSdkBridge.js'

function transportFixture() {
  const input = new PassThrough()
  const output = new PassThrough()
  const received: Record<string, any>[] = []
  const sent: Record<string, any>[] = []
  let resolveReady!: () => void
  let resolveDone!: () => void
  const ready = new Promise<void>(resolve => { resolveReady = resolve })
  const done = new Promise<void>(resolve => { resolveDone = resolve })
  output.on('data', chunk => {
    for (const line of chunk.toString().trim().split('\n')) if (line) sent.push(JSON.parse(line))
  })
  let closed = 0
  const bridge: OfficialAgentSdkBridge = {
    ready, done,
    async receive(payload) {
      const message = JSON.parse(payload)
      received.push(message)
      if (message.request?.subtype === 'end_session') resolveDone()
    },
    close() { closed++; resolveDone() },
  }
  return { input, output, received, sent, resolveReady, resolveDone, bridge, closed: () => closed }
}

test('stdio retains a prompt received before SDK readiness and gracefully drains on EOF', async () => {
  const f = transportFixture()
  const task = serveOfficialAgentSdkStdio(() => f.bridge, f.input, f.output)
  f.input.write(JSON.stringify({ type: 'user', message: { role: 'user', content: 'fixture' } }) + '\n')
  await new Promise(resolve => setImmediate(resolve))
  expect(f.received).toEqual([])
  f.resolveReady()
  f.input.end()
  await task
  expect(f.received.map(message => message.type)).toEqual(['user', 'control_request'])
  expect(f.received[1]?.request).toMatchObject({ subtype: 'end_session', reason: 'stdin_closed' })
  expect(f.closed()).toBe(1)
})

test('unattended SDK prompts are denied rather than hanging or silently approving', async () => {
  const f = transportFixture()
  let send!: (message: Record<string, unknown>) => void
  const originalReceive = f.bridge.receive
  f.bridge.receive = async message => {
    await originalReceive(message)
    if (JSON.parse(message).type === 'control_response') f.resolveDone()
  }
  const task = serveOfficialAgentSdkStdio(sender => { send = sender; return f.bridge }, f.input, f.output)
  f.resolveReady()
  send({ type: 'control_request', request_id: 'question', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion' } })
  await task
  expect(f.received[0]?.response).toMatchObject({
    request_id: 'question', response: { behavior: 'deny', interrupt: true },
  })
  expect(f.sent[0]?.type).toBe('control_request')
})

test('an SDK error result does not become a successful scheduler process exit', async () => {
  const f = transportFixture()
  let send!: (message: Record<string, unknown>) => void
  const task = serveOfficialAgentSdkStdio(sender => { send = sender; return f.bridge }, f.input, f.output)
  f.resolveReady()
  send({ type: 'result', is_error: true, result: 'fixture failure' })
  f.resolveDone()
  await expect(task).rejects.toThrow('error result')
  expect(f.sent[0]?.result).toBe('fixture failure')
  expect(f.closed()).toBe(1)
})

test('native startup failure closes the stdio reader without waiting for more host input', async () => {
  const f = transportFixture()
  const failure = Promise.reject(new Error('fixture initialization failure'))
  f.bridge.ready = failure
  f.bridge.done = failure
  await expect(serveOfficialAgentSdkStdio(() => f.bridge, f.input, f.output)).rejects.toThrow('initialization failure')
  expect(f.closed()).toBe(1)
})
