import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
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

describe('session protocol rollback over WebSocket', () => {
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

  for (const state of ['unknown', 'mixed', 'anthropic'] as const) {
    it(`opens ${state} history and allows changing protocols after the rollback`, async () => {
      const sessionId = await createSession()
      const launch = await sessionService.getSessionLaunchInfo(sessionId)
      const legacyMetadata = JSON.stringify({ type: 'session-meta', isMeta: true, sessionApiFormat: state })
      const oldReply = JSON.stringify({
        type: 'assistant', uuid: crypto.randomUUID(), sessionId,
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', model: 'legacy-model', content: [{ type: 'text', text: 'Old reply' }] },
      })
      await appendFile(launch!.filePath, legacyMetadata + '\n' + oldReply + '\n')
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}`)
      expect(response.status).toBe(200)
      expect(await response.json()).not.toHaveProperty('sessionApiFormat')
      const client = await connect(sessionId)
      for (const format of ['anthropic', 'openai_chat', 'openai_responses'] as const) {
        const provider = await addProvider(format)
        await select(client, provider.id)
        await sendTurn(client, `Continue using ${format}`)
      }
      expect(client.events.filter(event => event.type === 'error')).toEqual([])
      expect(client.events.some(event => event.type === 'session_protocol')).toBe(false)
      // Removed enforcement does not require rewriting existing user history.
      expect(await readFile(launch!.filePath, 'utf8')).toContain(legacyMetadata)
      expect(await readFile(launch!.filePath, 'utf8')).toContain(oldReply)
    }, 25_000)
  }
})
