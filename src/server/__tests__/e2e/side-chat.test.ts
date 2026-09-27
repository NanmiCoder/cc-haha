import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, appendFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSandboxedTestEnvironment } from '../../../../scripts/pr/test-environment.js'

async function eventually(check: () => boolean, label: string): Promise<void> {
  const until = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > until) throw new Error(label)
    await Bun.sleep(20)
  }
}
test('temporary side chat forks a fixed boundary, supports independent multi-turn WS/model and closes without parent mutation or transcript', async () => {
  const home = await mkdtemp(join(tmpdir(), 'side-chat-'))
  const original = { ...process.env }
  const env = createSandboxedTestEnvironment(home, {
    CLAUDE_CLI_PATH: fileURLToPath(new URL('../fixtures/mock-sdk-cli.ts', import.meta.url)),
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  let server: ReturnType<typeof Bun.serve> | undefined
  const sockets: WebSocket[] = []
  let shutdown: (() => Promise<void>) | undefined
  try {
    const workDir = join(home, 'project')
    await mkdir(workDir)
    const runtime = await import('../../index.js')
    const { sessionService } = await import('../../services/sessionService.js')
    const { conversationService } = await import('../../services/conversationService.js')
    shutdown = runtime.stopServerRuntimeForShutdown
    server = runtime.startServer(0, '127.0.0.1')
    const base = `http://127.0.0.1:${server.port}`
    async function api(path: string, body?: unknown, method?: string) {
      const response = await fetch(base + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      const data = await response.json()
      if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(data)}`)
      return data as any
    }
    async function connect(id: string) {
      const events: any[] = []
      const socket = new WebSocket(`ws://127.0.0.1:${server!.port}/ws/${id}`)
      sockets.push(socket)
      socket.onmessage = event => events.push(JSON.parse(String(event.data)))
      await eventually(() => events.some(event => event.type === 'connected'), 'connect')
      return { socket, events }
    }
    const parent = await api('/api/sessions', { workDir })
    const launch = await sessionService.getSessionLaunchInfo(parent.sessionId)
    const record = (text: string) => JSON.stringify({ uuid: crypto.randomUUID(), type: 'user', timestamp: new Date().toISOString(), sessionId: parent.sessionId, cwd: workDir, message: { role: 'user', content: text } }) + '\n'
    await appendFile(launch!.filePath, record('parent context snapshot'))
    const endpoint = `/api/sessions/${parent.sessionId}/side-chats`
    const side = await api(endpoint, {})
    expect(side).toMatchObject({ parentSessionId: parent.sessionId, workDir: parent.workDir, ephemeral: true })
    expect(side.sessionId).toStartWith('side-')
    await appendFile(launch!.filePath, record('later parent content excluded'))
    const parentBefore = await readFile(launch!.filePath, 'utf8')
    const main = await connect(parent.sessionId)
    main.socket.send(JSON.stringify({ type: 'user_message', content: 'MOCK_RECONNECT_GATE parent remains active' }))
    await eventually(() => conversationService.hasSession(parent.sessionId), 'parent runtime')
    const child = await connect(side.sessionId)
    child.socket.send(JSON.stringify({ type: 'user_message', content: 'MOCK_SIDE_CONTEXT first' }))
    await eventually(() => child.events.some(event => JSON.stringify(event).includes('parent context snapshot')), 'inherited context')
    expect(JSON.stringify(child.events)).not.toContain('later parent content excluded')
    expect(JSON.stringify(child.events)).toContain('reference context only')
    await eventually(() => child.events.some(event => event.type === 'message_complete'), 'first done')
    child.socket.send(JSON.stringify({ type: 'set_runtime_config', providerId: null, modelId: 'mock-next' }))
    await Bun.sleep(100)
    child.socket.send(JSON.stringify({ type: 'user_message', content: 'MOCK_SIDE_CONTEXT second' }))
    await eventually(() => child.events.filter(event => event.type === 'message_complete').length >= 2, 'follow-up')
    expect(JSON.stringify(child.events)).toContain('MOCK_SIDE_CONTEXT second')
    expect(child.events.filter(event => event.type === 'error')).toEqual([])
    // Tool permission is routed to the child socket and cannot consume a parent approval.
    child.socket.send(JSON.stringify({ type: 'user_message', content: 'MOCK_TOOL ' + JSON.stringify({ tool: 'Read', input: { file_path: 'fixture.txt' }, reply: 'isolated tool result' }) }))
    await eventually(() => child.events.some(event => event.type === 'permission_request'), 'side tool permission')
    const permission = child.events.find(event => event.type === 'permission_request')
    child.socket.send(JSON.stringify({ type: 'permission_response', requestId: permission.requestId, allowed: true }))
    await eventually(() => child.events.filter(event => event.type === 'message_complete').length >= 3, 'side tool completed')
    expect(main.events.some(event => event.type === 'permission_request')).toBe(false)
    // A runtime change that needs restart must fail before stopping the live child.
    child.socket.send(JSON.stringify({ type: 'set_runtime_config', providerId: 'different-provider', modelId: 'other' }))
    await eventually(() => child.events.some(event => event.code === 'SIDE_CHAT_RUNTIME_RESTART_UNAVAILABLE'), 'safe runtime rejection')
    expect(conversationService.hasSession(side.sessionId)).toBe(true)
    expect((await api(`/api/sessions/${side.sessionId}/messages`)).messages).toEqual([])
    expect(await api(`/api/sessions/${side.sessionId}/turn-checkpoints`)).toEqual({ checkpoints: [] })
    expect(await sessionService.getSessionMessagesWithEvidence(side.sessionId)).toEqual({ messages: [], transcriptEvidenceComplete: false })
    expect(await sessionService.getSessionFileHistorySnapshots(side.sessionId)).toEqual([])
    expect((await api('/api/sessions')).sessions.some((entry: any) => entry.id === side.sessionId)).toBe(false)
    const withoutMetadata = (raw: string) => raw.split('\n').filter(Boolean).filter(line => JSON.parse(line).type !== 'session-meta')
    expect(withoutMetadata(await readFile(launch!.filePath, 'utf8'))).toEqual(withoutMetadata(parentBefore))
    expect(JSON.stringify(main.events)).not.toContain('MOCK_SIDE_CONTEXT')
    expect(conversationService.hasSession(side.sessionId)).toBe(true)
    child.socket.close()
    const reconnected = await connect(side.sessionId)
    reconnected.socket.send(JSON.stringify({ type: 'user_message', content: 'MOCK_SIDE_CONTEXT after reconnect' }))
    await eventually(() => JSON.stringify(reconnected.events).includes('MOCK_SIDE_CONTEXT second'), 'ephemeral reconnect retains CLI context')
    await api(`${endpoint}/${side.sessionId}`, undefined, 'DELETE')
    expect(conversationService.hasSession(parent.sessionId)).toBe(true)
    expect(main.events.some(event => event.type === 'message_complete')).toBe(false)
    await conversationService.requestControl(parent.sessionId, { subtype: 'mock_release_reconnect_stream' }, 1000)
    await eventually(() => main.events.some(event => event.type === 'message_complete'), 'parent still completes')
    expect(conversationService.hasSession(side.sessionId)).toBe(false)
    const sideFiles = (await readdir(join(env.CLAUDE_CONFIG_DIR!, 'projects'), { recursive: true })).filter(file => String(file).includes(side.sessionId) || String(file).includes(side.sessionId.slice(5)))
    expect(sideFiles).toEqual([])
    await expect(conversationService.startSession('side-' + crypto.randomUUID(), workDir, 'ws://127.0.0.1:1/sdk/no')).rejects.toThrow('expired')
    const sibling = await api(endpoint, {})
    const unopened = await api(endpoint, {})
    const siblingClient = await connect(sibling.sessionId)
    siblingClient.socket.send(JSON.stringify({ type: 'user_message', content: 'MOCK_SIDE_CONTEXT sibling' }))
    await eventually(() => siblingClient.events.some(event => event.type === 'message_complete'), 'sibling running')
    await api(`/api/sessions/${parent.sessionId}`, undefined, 'DELETE')
    expect(conversationService.hasSession(sibling.sessionId)).toBe(false)
    await expect(conversationService.startSession(unopened.sessionId, workDir, 'ws://127.0.0.1:1/sdk/no')).rejects.toThrow('expired')

  } finally {
    sockets.forEach(socket => socket.close())
    await shutdown?.()
    server?.stop(true)
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, original)
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)
