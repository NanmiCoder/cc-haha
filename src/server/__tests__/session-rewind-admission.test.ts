import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createQualityGateSandbox, type QualityGateSandbox } from '../../../scripts/quality-gate/sandbox.js'
import { createOfflineTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { conversationService } from '../services/conversationService.js'
import { ProviderService } from '../services/providerService.js'
import { sessionService } from '../services/sessionService.js'
import { resetTerminalShellEnvironmentCacheForTests } from '../../utils/terminalShellEnvironment.js'

type SessionApiFormat = 'anthropic' | 'openai_chat' | 'openai_responses'

type Event = { type: string; [key: string]: any }
type Client = {
  socket: WebSocket
  events: Event[]
  send(message: Record<string, unknown>): void
  wait(predicate: (event: Event) => boolean, after?: number): Promise<Event>
}

describe('HTTP rewind admission over WebSocket', () => {
  const originalEnv = { ...process.env }
  const sockets = new Set<WebSocket>()
  const providerService = new ProviderService()
  let sandbox: QualityGateSandbox
  let server: ReturnType<typeof Bun.serve>
  let baseUrl: string
  let workDir: string

  beforeAll(async () => {
    sandbox = createQualityGateSandbox({
      label: 'session-rewind-admission',
      seedProviders: false,
      // Do not inherit proxy/provider credentials or access the login shell.
      source: createOfflineTestEnvironment({}, originalEnv),
      sourceConfigDir: join(process.cwd(), 'artifacts', 'rewind-empty-source-config'),
      envOverrides: {
        NODE_ENV: 'test',
        CLAUDE_CLI_PATH: fileURLToPath(new URL('./fixtures/mock-sdk-cli.ts', import.meta.url)),
      },
    })
    for (const name of Object.keys(process.env)) delete process.env[name]
    Object.assign(process.env, sandbox.env)
    resetTerminalShellEnvironmentCacheForTests()
    workDir = join(sandbox.home, 'workspace')
    await mkdir(workDir, { recursive: true })
    await mkdir(join(sandbox.configDir, 'projects'), { recursive: true })
    const { startServer } = await import('../index.js')
    server = startServer(0, '127.0.0.1')
    baseUrl = `http://127.0.0.1:${server.port}`
  })

  afterEach(async () => {
    for (const socket of sockets) socket.close()
    sockets.clear()
    await conversationService.stopAllSessionsAndWait(1_000)
  })

  afterAll(async () => {
    try {
      server?.stop(true)
      const { stopServerRuntimeForShutdown } = await import('../index.js')
      await stopServerRuntimeForShutdown()
      expect(sandbox.detectUserStateMutations()).toEqual([])
    } finally {
      try {
        // A stopped Windows child can briefly retain its sandbox directory.
        // fs.rm retries only transient filesystem errors and still fails on a
        // persistent handle; never broaden cleanup beyond this test's HOME.
        if (sandbox) await rm(sandbox.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } finally {
        for (const name of Object.keys(process.env)) delete process.env[name]
        Object.assign(process.env, originalEnv)
        resetTerminalShellEnvironmentCacheForTests()
      }
    }
  })

  async function addProvider(apiFormat: SessionApiFormat) {
    return providerService.addProvider({
      presetId: 'custom',
      name: `Protocol ${apiFormat} ${crypto.randomUUID()}`,
      apiFormat,
      apiKey: 'fixture-protocol-key',
      baseUrl: 'http://127.0.0.1:1',
      // Identical model names prove that protocol selection uses provider routing.
      models: { main: 'fixture-main', haiku: 'fixture-small', sonnet: 'fixture-main', opus: 'fixture-large' },
    })
  }

  async function createSession(): Promise<string> {
    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir }),
    })
    expect(response.status).toBe(201)
    const body = await response.json() as { sessionId: string }
    return body.sessionId
  }

  async function connect(sessionId: string): Promise<Client> {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/${sessionId}`)
    sockets.add(socket)
    const events: Event[] = []
    const listeners = new Set<() => void>()
    let failed = false
    socket.onmessage = event => {
      events.push(JSON.parse(event.data as string))
      for (const listener of listeners) listener()
    }
    socket.onerror = () => {
      failed = true
      for (const listener of listeners) listener()
    }
    const client: Client = {
      socket,
      events,
      send(message) { socket.send(JSON.stringify(message)) },
      wait(predicate, after = 0) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            listeners.delete(check)
            reject(new Error(`Timed out waiting for protocol event: ${JSON.stringify(events.slice(after))}`))
          }, 8_000)
          function check() {
            const event = events.slice(after).find(predicate)
            if (!event && !failed) return
            clearTimeout(timer)
            listeners.delete(check)
            if (failed) reject(new Error('Protocol fixture WebSocket failed'))
            else resolve(event!)
          }
          listeners.add(check)
          check()
        })
      },
    }
    await client.wait(event => event.type === 'connected')
    return client
  }

  async function select(client: Client, providerId: string, modelId = 'fixture-main') {
    const after = client.events.length
    client.send({ type: 'set_runtime_config', providerId, modelId })
    const result = await client.wait(event => event.type === 'error' || (
      event.type === 'runtime_config_applied' && event.providerId === providerId && event.modelId === modelId
    ), after)
    expect(result.type).toBe('runtime_config_applied')
  }

  async function sendTurn(client: Client, content = 'hello fixture') {
    const after = client.events.length
    client.send({ type: 'user_message', content })
    const result = await client.wait(event => event.type === 'message_complete' || event.type === 'error', after)
    expect(result.type).toBe('message_complete')
    return after
  }



  async function seedSession() {
    const sessionId = await createSession()
    const launch = await sessionService.getSessionLaunchInfo(sessionId)
    const oldUser = crypto.randomUUID()
    const oldAssistant = crypto.randomUUID()
    await appendFile(launch!.filePath, [
      { type: 'user', uuid: oldUser, parentUuid: null, sessionId, cwd: workDir, timestamp: '2026-11-01T00:00:00Z', message: { role: 'user', content: 'original prompt' } },
      { type: 'assistant', uuid: oldAssistant, parentUuid: oldUser, sessionId, cwd: workDir, timestamp: '2026-11-01T00:00:01Z', message: { id: 'msg_original', role: 'assistant', content: [{ type: 'text', text: 'original reply' }] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') })
    process.env.MOCK_SDK_RESUME_TRANSCRIPT_PATH = launch!.filePath
    process.env.MOCK_SDK_RESUME_UPSTREAM_URL = `http://127.0.0.1:${upstream.port}`
    process.env.CLAUDE_CODE_EAGER_FLUSH = '1'
    const client = await connect(sessionId)
    const provider = await addProvider('anthropic')
    await select(client, provider.id)
    return { sessionId, transcriptPath: launch!.filePath, oldUser, client, upstream }
  }

  function rewind(sessionId: string, targetUserMessageId: string) {
    return fetch(`${baseUrl}/api/sessions/${sessionId}/rewind`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserMessageId, mode: 'conversation' }),
    })
  }

  function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
  }

  it('holds a new WebSocket turn until the transcript rewrite completes', async () => {
    const fixture = await seedSession()
    const { sessionId, transcriptPath, oldUser, client } = fixture
    const gate = deferred()
    const paused = deferred()
    const started = deferred()
    const originalTrim = sessionService.trimSessionMessagesFrom.bind(sessionService)
    const trimSpy = spyOn(sessionService, 'trimSessionMessagesFrom').mockImplementation(async (...args) => {
      paused.resolve()
      await gate.promise
      return originalTrim(...args)
    })
    let trimFinished = false
    let startedBeforeTrimFinished = false
    const originalStart = conversationService.startSession.bind(conversationService)
    const startSpy = spyOn(conversationService, 'startSession').mockImplementation(async (...args) => {
      if (args[0] === sessionId) {
        startedBeforeTrimFinished = !trimFinished
        started.resolve()
      }
      return originalStart(...args)
    })
    let rewinding: Promise<Response> | undefined
    try {
      rewinding = rewind(sessionId, oldUser)
      await Promise.race([paused.promise, rewinding.then(async response => { throw new Error(`Rewind ended before trim: ${response.status} ${await response.text()}`) })])
      const after = client.events.length
      client.send({ type: 'user_message', content: 'NEW_PROMPT_DURING_REWIND' })
      await client.wait(event => event.type === 'status' && event.state === 'thinking', after)
      // Give an incorrectly unguarded handler a chance to enter startup without
      // waiting for the mock subprocess to boot. The file mutation is gated.
      await Promise.race([started.promise, new Promise(resolve => setTimeout(resolve, 500))])
      expect(startedBeforeTrimFinished).toBe(false)
      expect(await readFile(transcriptPath, 'utf8')).not.toContain('NEW_PROMPT_DURING_REWIND')
      trimFinished = true
      gate.resolve()
      expect((await rewinding).status).toBe(200)
      const result = await client.wait(event => event.type === 'message_complete' || event.type === 'error', after)
      expect(result.type).toBe('message_complete')
      expect(await readFile(transcriptPath, 'utf8')).toContain('NEW_PROMPT_DURING_REWIND')
    } finally {
      gate.resolve()
      await rewinding?.catch(() => {})
      trimSpy.mockRestore()
      startSpy.mockRestore()
      fixture.upstream.stop(true)
    }
  }, 30000)

  it('serializes repeated rewinds and releases admission after a rejected target', async () => {
    const fixture = await seedSession()
    const { sessionId, oldUser, client } = fixture
    const gate = deferred()
    const paused = deferred()
    const originalTrim = sessionService.trimSessionMessagesFrom.bind(sessionService)
    const trimSpy = spyOn(sessionService, 'trimSessionMessagesFrom').mockImplementation(async (...args) => {
      paused.resolve()
      await gate.promise
      return originalTrim(...args)
    })
    let first: Promise<Response> | undefined
    let second: Promise<Response> | undefined
    try {
      first = rewind(sessionId, oldUser)
      await paused.promise
      second = rewind(sessionId, oldUser)
      gate.resolve()
      expect((await first).status).toBe(200)
      // The second request resolves the same UUID against the trimmed history,
      // instead of concurrently rewriting a snapshot captured before the first.
      expect((await second).status).toBe(400)
      expect(trimSpy).toHaveBeenCalledTimes(1)
      await sendTurn(client, 'AFTER_REJECTED_REWIND')
      expect(await readFile(fixture.transcriptPath, 'utf8')).toContain('AFTER_REJECTED_REWIND')
    } finally {
      gate.resolve()
      await Promise.allSettled([first, second].filter(Boolean))
      trimSpy.mockRestore()
      fixture.upstream.stop(true)
    }
  }, 30000)

  it('does not trim when runtime shutdown fails and permits a later retry', async () => {
    const fixture = await seedSession()
    const { sessionId, oldUser, client } = fixture
    const before = await readFile(fixture.transcriptPath, 'utf8')
    const originalStop = conversationService.stopSessionAndWait.bind(conversationService)
    const stopSpy = spyOn(conversationService, 'stopSessionAndWait').mockImplementationOnce(async (_id, _timeout, options) => {
      expect(options?.requireExit).toBe(true)
      throw new Error('CLI did not confirm exit')
    }).mockImplementation(originalStop)
    const trimSpy = spyOn(sessionService, 'trimSessionMessagesFrom')
    try {
      expect((await rewind(sessionId, oldUser)).status).toBe(500)
      expect(trimSpy).not.toHaveBeenCalled()
      expect(await readFile(fixture.transcriptPath, 'utf8')).toBe(before)
      await sendTurn(client, 'AFTER_FAILED_REWIND')
      expect(await readFile(fixture.transcriptPath, 'utf8')).toContain('AFTER_FAILED_REWIND')
    } finally {
      stopSpy.mockRestore()
      trimSpy.mockRestore()
      fixture.upstream.stop(true)
    }
  }, 30000)

  it('drains a startup that was already in flight before rewriting the transcript', async () => {
    const fixture = await seedSession()
    const { sessionId, oldUser } = fixture
    const { __registerPendingSessionStartupForTests } = await import('../ws/handler.js')
    const startup = deferred()
    const stopping = deferred()
    __registerPendingSessionStartupForTests(sessionId, startup.promise)
    const stopSpy = spyOn(conversationService, 'stopSessionAndWait').mockImplementation(async (_id, _timeout, options) => {
      expect(options?.requireExit).toBe(true)
      stopping.resolve()
    })
    const trimSpy = spyOn(sessionService, 'trimSessionMessagesFrom')
    let rewinding: Promise<Response> | undefined
    try {
      rewinding = rewind(sessionId, oldUser)
      await stopping.promise
      expect(trimSpy).not.toHaveBeenCalled()
      startup.resolve()
      expect((await rewinding).status).toBe(200)
      expect(stopSpy).toHaveBeenCalledTimes(2)
      expect(trimSpy).toHaveBeenCalledTimes(1)
    } finally {
      startup.resolve()
      await rewinding?.catch(() => {})
      stopSpy.mockRestore()
      trimSpy.mockRestore()
      fixture.upstream.stop(true)
    }
  }, 30000)

  it('preserves a queued user turn when a later rewind rejects its already removed target', async () => {
    const fixture = await seedSession()
    const { sessionId, oldUser, client } = fixture
    const gate = deferred()
    const paused = deferred()
    const originalTrim = sessionService.trimSessionMessagesFrom.bind(sessionService)
    const trimSpy = spyOn(sessionService, 'trimSessionMessagesFrom').mockImplementation(async (...args) => {
      paused.resolve()
      await gate.promise
      return originalTrim(...args)
    })
    const { runSessionRewind } = await import('../ws/handler.js')
    const { executeSessionRewind } = await import('../services/sessionRewindService.js')
    let first: Promise<Response> | undefined
    let second: Promise<unknown> | undefined
    try {
      first = rewind(sessionId, oldUser)
      await paused.promise
      const after = client.events.length
      client.send({ type: 'user_message', content: 'USER_TURN_BETWEEN_TWO_REWINDS' })
      await client.wait(event => event.type === 'status' && event.state === 'thinking', after)
      // This is exactly the callback installed by the HTTP route. Calling the
      // exported queue boundary makes the second queue reservation deterministic.
      second = runSessionRewind(sessionId, stopRuntime => executeSessionRewind(
        sessionId, { targetUserMessageId: oldUser }, 'conversation', stopRuntime,
      )).catch(error => error)
      gate.resolve()
      expect((await first).status).toBe(200)
      expect(await second).toBeInstanceOf(Error)
      const result = await client.wait(event => event.type === 'message_complete' || event.type === 'error', after)
      expect(result.type).toBe('message_complete')
      expect(await readFile(fixture.transcriptPath, 'utf8')).toContain('USER_TURN_BETWEEN_TWO_REWINDS')
    } finally {
      gate.resolve()
      await Promise.allSettled([first, second].filter(Boolean))
      trimSpy.mockRestore()
      fixture.upstream.stop(true)
    }
  }, 30000)
})
