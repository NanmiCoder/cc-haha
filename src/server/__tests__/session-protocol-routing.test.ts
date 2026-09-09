import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createQualityGateSandbox, type QualityGateSandbox } from '../../../scripts/quality-gate/sandbox.js'
import { createOfflineTestEnvironment } from '../../../scripts/pr/test-environment.js'
import type { SessionApiFormat } from '../../shared/sessionProtocol.js'
import { conversationService } from '../services/conversationService.js'
import { ProviderService } from '../services/providerService.js'
import { SessionService, sessionService } from '../services/sessionService.js'
import { resetTerminalShellEnvironmentCacheForTests } from '../../utils/terminalShellEnvironment.js'

type Event = { type: string; [key: string]: any }
type Client = {
  socket: WebSocket
  events: Event[]
  send(message: Record<string, unknown>): void
  wait(predicate: (event: Event) => boolean, after?: number): Promise<Event>
}

describe('session protocol routing over WebSocket', () => {
  const originalEnv = { ...process.env }
  const sockets = new Set<WebSocket>()
  const providerService = new ProviderService()
  let sandbox: QualityGateSandbox
  let server: ReturnType<typeof Bun.serve>
  let baseUrl: string
  let workDir: string

  beforeAll(async () => {
    sandbox = createQualityGateSandbox({
      label: 'session-protocol',
      seedProviders: false,
      // Do not inherit proxy/provider credentials or access the login shell.
      source: createOfflineTestEnvironment({}, originalEnv),
      sourceConfigDir: originalEnv.CLAUDE_CONFIG_DIR,
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
      sandbox?.cleanup()
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, originalEnv)
      resetTerminalShellEnvironmentCacheForTests()
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

  for (const apiFormat of ['anthropic', 'openai_chat', 'openai_responses'] as const) {
    it(`locks ${apiFormat} only on first send and rejects other protocols before restart or persistence`, async () => {
      const providers = []
      for (const format of ['anthropic', 'openai_chat', 'openai_responses'] as const) {
        providers.push(await addProvider(format))
      }
      const selected = providers.find(provider => provider.apiFormat === apiFormat)!
      const others = providers.filter(provider => provider.id !== selected.id)
      const sessionId = await createSession()
      const client = await connect(sessionId)
      // Changing choices (including protocol) before sending must remain possible.
      await select(client, others[0]!.id)
      expect(await sessionService.getSessionApiFormat(sessionId)).toBeUndefined()
      await select(client, selected.id)
      expect(await sessionService.getSessionApiFormat(sessionId)).toBeUndefined()
      const after = await sendTurn(client)
      await client.wait(event => event.type === 'session_protocol' && event.sessionApiFormat === apiFormat, after)
      expect(await new SessionService().getSessionApiFormat(sessionId)).toBe(apiFormat)
      const before = await sessionService.getSessionLaunchInfo(sessionId)
      const start = spyOn(conversationService, 'startSession')
      const stop = spyOn(conversationService, 'stopSession')
      try {
        for (const other of others) {
          const index = client.events.length
          client.send({ type: 'set_runtime_config', providerId: other.id, modelId: 'fixture-main' })
          const error = await client.wait(event => event.type === 'error', index)
          expect(error.code).toBe('SESSION_PROTOCOL_MISMATCH')
          await client.wait(event => event.type === 'runtime_config_applied' && event.providerId === selected.id, index)
          expect(await sessionService.getSessionLaunchInfo(sessionId)).toMatchObject({
            sessionApiFormat: apiFormat,
            runtimeProviderId: before!.runtimeProviderId,
            runtimeModelId: before!.runtimeModelId,
          })
        }
        expect(start).not.toHaveBeenCalled()
        expect(stop).not.toHaveBeenCalled()
        // Rejection must leave the original session usable.
        await sendTurn(client, 'continue on the original protocol')
      } finally {
        start.mockRestore()
        stop.mockRestore()
      }
    }, 25_000)
  }

  it('allows another provider and model on the locked protocol', async () => {
    const first = await addProvider('openai_chat')
    const second = await addProvider('openai_chat')
    const sessionId = await createSession()
    const client = await connect(sessionId)
    await select(client, first.id)
    await sendTurn(client)
    await select(client, second.id, 'fixture-large')
    await sendTurn(client, 'continue with a different model')
    expect(await sessionService.getSessionLaunchInfo(sessionId)).toMatchObject({
      sessionApiFormat: 'openai_chat',
      runtimeProviderId: second.id,
      runtimeModelId: 'fixture-large',
    })
  }, 20_000)

  it('restores the durable protocol in the API and on reconnect after the CLI stops', async () => {
    const provider = await addProvider('openai_responses')
    const sessionId = await createSession()
    const client = await connect(sessionId)
    await select(client, provider.id)
    await sendTurn(client)
    client.socket.close()
    await conversationService.stopAllSessionsAndWait(1_000)
    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ sessionApiFormat: 'openai_responses' })
    expect(await new SessionService().getSessionApiFormat(sessionId)).toBe('openai_responses')
    const reconnected = await connect(sessionId)
    await reconnected.wait(event => event.type === 'session_protocol' && event.sessionApiFormat === 'openai_responses')
    await sendTurn(reconnected, 'continue after CLI restart')
    expect(await sessionService.getSessionApiFormat(sessionId)).toBe('openai_responses')
  }, 20_000)

  it('rejects sending when a saved provider changes protocol under an active CLI', async () => {
    const provider = await addProvider('anthropic')
    const sessionId = await createSession()
    const client = await connect(sessionId)
    await select(client, provider.id)
    await sendTurn(client)
    await providerService.updateProvider(provider.id, { apiFormat: 'openai_responses' })
    const before = conversationService.getRecentSdkMessages(sessionId).length
    const after = client.events.length
    client.send({ type: 'user_message', content: 'must not reach the SDK' })
    const error = await client.wait(event => event.type === 'error', after)
    expect(error.code).toBe('SESSION_PROTOCOL_MISMATCH')
    await client.wait(event => event.type === 'status' && event.state === 'idle', after)
    expect(await sessionService.getSessionApiFormat(sessionId)).toBe('anthropic')
    expect(conversationService.getRecentSdkMessages(sessionId).slice(before)
      .some(event => event.type === 'assistant' || event.type === 'result')).toBe(false)
    // Restoring the provider makes the original route usable without a stuck turn.
    await providerService.updateProvider(provider.id, { apiFormat: 'anthropic' })
    await sendTurn(client, 'continue after restoring the provider')
  }, 20_000)

  for (const state of ['unknown', 'mixed'] as const) {
    it(`blocks old ${state} history without mutating it or starting a CLI`, async () => {
      const provider = await addProvider('anthropic')
      const sessionId = await createSession()
      const launch = await sessionService.getSessionLaunchInfo(sessionId)
      const oldEntries = state === 'unknown'
        ? [{ type: 'assistant', message: { role: 'assistant', model: 'legacy-model', content: 'old reply' } }]
        : [
          { type: 'session-meta', runtimeProviderId: null },
          { type: 'assistant', message: { role: 'assistant', content: 'Messages reply' } },
          { type: 'session-meta', runtimeProviderId: 'openai-official' },
          { type: 'assistant', message: { role: 'assistant', content: 'Responses reply' } },
        ]
      await appendFile(launch!.filePath, oldEntries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
      const original = await readFile(launch!.filePath, 'utf8')
      const client = await connect(sessionId)
      await client.wait(event => event.type === 'session_protocol' && event.sessionApiFormat === state)
      const after = client.events.length
      client.send({ type: 'set_runtime_config', providerId: provider.id, modelId: 'fixture-main' })
      expect(await client.wait(event => event.type === 'error', after)).toMatchObject({
        code: 'SESSION_PROTOCOL_UNRESOLVED', retryable: false,
      })
      const sendIndex = client.events.length
      client.send({ type: 'user_message', content: 'must not replay unresolved history' })
      expect(await client.wait(event => event.type === 'error', sendIndex)).toMatchObject({
        code: 'SESSION_PROTOCOL_UNRESOLVED', retryable: false,
      })
      expect(conversationService.hasSession(sessionId)).toBe(false)
      expect(await readFile(launch!.filePath, 'utf8')).toBe(original)
    }, 15_000)
  }
})
