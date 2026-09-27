import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSandboxedTestEnvironment } from '../../../../scripts/pr/test-environment.js'

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 10_000
  let value: T
  do {
    value = await read()
    if (ready(value)) return value
    await Bun.sleep(20)
  } while (Date.now() < deadline)
  throw new Error(`${label}: ${JSON.stringify(value!)}`)
}

test('side question HTTP controls preserve active/idle main session and cancel only isolated work', async () => {
  const home = await mkdtemp(join(tmpdir(), 'session-collaboration-e2e-'))
  const original = { ...process.env }
  const env = createSandboxedTestEnvironment(home, {
    CLAUDE_CLI_PATH: fileURLToPath(new URL('../fixtures/mock-sdk-cli.ts', import.meta.url)),
    CC_HAHA_DISABLE_TERMINAL_SHELL_ENV: '1', MOCK_SDK_STREAM_DELAY_MS: '1500',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  let server: ReturnType<typeof Bun.serve> | undefined
  let socket: WebSocket | undefined
  let shutdown: (() => Promise<void>) | undefined
  try {
    const workDir = join(home, 'project')
    await mkdir(workDir)
    const runtime = await import('../../index.js')
    shutdown = runtime.stopServerRuntimeForShutdown
    server = runtime.startServer(0, '127.0.0.1')
    const base = `http://127.0.0.1:${server.port}`
    async function api(path: string, body?: unknown, headers?: Record<string, string>) {
      const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
      const data = await response.json()
      if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(data)}`)
      return data as any
    }
    const root = await api('/api/sessions', { workDir })
    const events: any[] = []
    socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/${root.sessionId}`)
    socket.addEventListener('message', event => events.push(JSON.parse(String(event.data))))
    await eventually(async () => events, values => values.some(value => value.type === 'connected'), 'root websocket')
    const endpoint = `/api/sessions/${root.sessionId}/side-question`
    socket.send(JSON.stringify({ type: 'user_message', content: 'Main fixture task' }))
    const { conversationService } = await import('../../services/conversationService.js')
    await eventually(async () => conversationService.hasSession(root.sessionId), Boolean, 'runtime started')
    const questionId = crypto.randomUUID()
    const response = await api(endpoint, { questionId, question: 'Explain isolated side question', history: [{ question: 'previous', response: 'answer' }] })
    expect(response.questionId).toBe(questionId)
    expect(response.response).toContain('Previous side questions: 1')
    expect(response.response).toContain('Main task is still running')
    const duplicate = await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId, question: 'duplicate' }) })
    expect(duplicate.status).toBe(409)
    const cancelId = crypto.randomUUID()
    const pending = fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: cancelId, question: 'MOCK_SLOW cancelled side question' }) })
    await Bun.sleep(100)
    const cancelled = await fetch(base + endpoint + '/' + cancelId, { method: 'DELETE' })
    expect(await cancelled.json()).toEqual({ questionId: cancelId, cancelled: true })
    expect((await pending).status).toBe(499)
    await eventually(async () => events, values => values.some(value => value.type === 'message_complete'), 'main turn remains uninterrupted')
    expect(events.some(event => event.type === 'error')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('Side answer:')
    expect(JSON.stringify(events)).not.toContain('Explain isolated side question')
    const idle = await api(endpoint, { questionId: crypto.randomUUID(), question: 'idle side question' })
    expect(idle.response).toContain('Main task is idle')
    const invalid = await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: crypto.randomUUID(), question: ' ' }) })
    expect(invalid.status).toBe(400)
    const oversized = await fetch(base + endpoint, { method: 'POST', body: 'a'.repeat(1024 * 1024 + 1) })
    expect(oversized.status).toBe(413)
    const malformedDelete = await fetch(base + endpoint + '/' + crypto.randomUUID() + '/extra', { method: 'DELETE' })
    expect(malformedDelete.status).toBe(404)
    expect(conversationService.hasSession(root.sessionId)).toBe(true)
    const transcript = await api(`/api/sessions/${root.sessionId}/messages`)
    expect(JSON.stringify(transcript)).not.toContain('Side answer:')
    expect(JSON.stringify(transcript)).not.toContain('Explain isolated side question')
  } finally {
    socket?.close()
    await shutdown?.()
    server?.stop(true)
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, original)
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)
