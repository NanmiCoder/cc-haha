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

test('desktop host dispatches independent sessions, exchanges messages, exposes history and stops the group', async () => {
  const home = await mkdtemp(join(tmpdir(), 'session-collaboration-e2e-'))
  const original = { ...process.env }
  const env = createSandboxedTestEnvironment(home, {
    CLAUDE_CLI_PATH: fileURLToPath(new URL('../fixtures/mock-sdk-cli.ts', import.meta.url)),
    CC_HAHA_DISABLE_TERMINAL_SHELL_ENV: '1', MOCK_SDK_STREAM_DELAY_MS: '100',
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
    socket.send(JSON.stringify({ type: 'user_message', content: 'Coordinate independent tasks' }))
    await eventually(async () => events, values => values.some(value => value.type === 'message_complete'), 'root initial turn')
    const { conversationService } = await import('../../services/conversationService.js')
    // Read only the synthetic process token minted in this isolated test server.
    const processRecord = (conversationService as unknown as { sessions: Map<string, { sdkToken: string }> }).sessions.get(root.sessionId)!
    const headers = { authorization: `Bearer ${processRecord.sdkToken}`, 'x-session-id': root.sessionId }
    const tool = (action: string, body: unknown) => api(`/api/session-collaboration/${action}`, body, headers)
    const children = await Promise.all([
      tool('create', { prompt: 'Review alpha', title: 'Alpha session', requestId: 'alpha-create' }),
      tool('create', { prompt: 'Review beta', title: 'Beta session', requestId: 'beta-create' }),
    ])
    expect(new Set([root.sessionId, ...children.map(child => child.sessionId)]).size).toBe(3)
    const busyDelivery = await tool('send', { targetSessionId: children[0].sessionId, content: 'Progress while running', messageId: 'busy-message' })
    expect(['queued', 'accepted', 'consumed']).toContain(busyDelivery.status)
    const childToken = (conversationService as unknown as { sessions: Map<string, { sdkToken: string }> }).sessions.get(children[0].sessionId)!.sdkToken
    const peerDelivery = await api('/api/session-collaboration/send', { targetSessionId: children[1].sessionId, content: 'Peer finding from alpha', messageId: 'peer-message' }, { authorization: `Bearer ${childToken}`, 'x-session-id': children[0].sessionId })
    expect(peerDelivery.sourceSessionId).toBe(children[0].sessionId)
    const groupPath = `/api/session-collaboration/${root.sessionId}/status`
    const completed = await eventually(() => api(groupPath), status => children.every(child => status.members.some((member: any) => member.sessionId === child.sessionId && member.state === 'completed')) && status.messages.filter((message: any) => message.targetSessionId !== root.sessionId).every((message: any) => message.status === 'consumed'), 'children completed')
    expect(completed.members).toHaveLength(3)
    expect(completed.messages.filter((message: any) => message.targetSessionId !== root.sessionId).every((message: any) => message.status === 'consumed')).toBe(true)
    expect(completed.messages.some((message: any) => message.targetSessionId === root.sessionId)).toBe(true)
    const listed = await api('/api/sessions')
    for (const child of children) {
      expect(listed.sessions.some((session: any) => session.id === child.sessionId)).toBe(true)
      const history = await tool('read', { sessionId: child.sessionId, limit: 3 })
      expect(JSON.stringify(history)).toContain('Review')
    }
    const sent = await tool('send', { targetSessionId: children[0].sessionId, content: 'Second assignment', messageId: 'second-assignment' })
    const duplicate = await tool('send', { targetSessionId: children[0].sessionId, content: 'Second assignment', messageId: 'second-assignment' })
    expect(duplicate.id).toBe(sent.id)
    await eventually(() => api(groupPath), status => status.messages.some((message: any) => message.id === sent.id && message.status === 'consumed'), 'followup consumed')
    // Exercise the idle host admission path, where peer text previously ran
    // the desktop /clear command before reaching the CLI's literal inbox.
    await eventually(() => api(groupPath), status => status.members.some((member: any) => member.sessionId === children[0].sessionId && member.state === 'completed'), 'followup completed')
    await tool('send', { targetSessionId: children[0].sessionId, content: '/clear', messageId: 'literal-clear' })
    await eventually(() => api(groupPath), status => status.messages.some((message: any) => message.id === 'literal-clear' && message.status === 'consumed'), 'literal peer command consumed')
    await eventually(() => api(groupPath), status => status.members.some((member: any) => member.sessionId === children[0].sessionId && member.state === 'completed'), 'literal peer command completed')
    const preserved = await tool('read', { sessionId: children[0].sessionId, limit: 10 })
    expect(JSON.stringify(preserved)).toContain('Review alpha')
    expect(JSON.stringify(preserved)).toContain('/clear')
    await api(`/api/session-collaboration/${root.sessionId}/stop`, {})
    const stopped = await api(groupPath)
    expect(stopped.members.every((member: any) => member.stopped)).toBe(true)
    expect(events.some(event => event.type === 'system_notification' && event.subtype === 'session_collaboration_updated')).toBe(true)
  } finally {
    socket?.close()
    await shutdown?.()
    server?.stop(true)
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, original)
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)
