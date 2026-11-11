import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createQualityGateSandbox, type QualityGateSandbox } from '../../../scripts/quality-gate/sandbox.js'
import { createOfflineTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { conversationService } from '../services/conversationService.js'
import { resetTerminalShellEnvironmentCacheForTests } from '../../utils/terminalShellEnvironment.js'

type Event = { type: string; [key: string]: any }
type Client = {
  socket: WebSocket
  events: Event[]
  send(message: Record<string, unknown>): void
  wait(predicate: (event: Event) => boolean, after?: number): Promise<Event>
}

// The mock CLI emits its suggestion right after `result`; give a trailing frame
// time to arrive before asserting that none did.
const TRAILING_FRAME_GRACE_MS = 300

describe('next-prompt suggestions over WebSocket', () => {
  const originalEnv = { ...process.env }
  const sockets = new Set<WebSocket>()
  let sandbox: QualityGateSandbox
  let server: ReturnType<typeof Bun.serve>
  let baseUrl: string
  let workDir: string
  let controlLog: string

  beforeAll(async () => {
    sandbox = createQualityGateSandbox({
      label: 'prompt-suggestions',
      seedProviders: false,
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
    controlLog = join(sandbox.home, 'prompt-suggestion-controls.jsonl')
    process.env.MOCK_SDK_PROMPT_SUGGESTIONS_LOG = controlLog
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
    await setSuggestionsSetting(false)
    await rm(controlLog, { force: true })
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

  async function setSuggestionsSetting(enabled: boolean) {
    const response = await fetch(`${baseUrl}/api/settings/user`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nextPromptSuggestionsEnabled: enabled }),
    })
    expect(response.status).toBe(200)
  }

  async function createSession(): Promise<string> {
    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir }),
    })
    expect(response.status).toBe(201)
    return (await response.json() as { sessionId: string }).sessionId
  }

  async function connect(sessionId: string, { suggestions }: { suggestions: boolean }): Promise<Client> {
    const url = new URL(`ws://127.0.0.1:${server.port}/ws/${sessionId}`)
    if (suggestions) url.searchParams.set('suggestions', '1')
    const socket = new WebSocket(url)
    sockets.add(socket)
    const events: Event[] = []
    const listeners = new Set<() => void>()
    socket.onmessage = event => {
      events.push(JSON.parse(event.data as string))
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
            reject(new Error(`Timed out waiting for event: ${JSON.stringify(events.slice(after))}`))
          }, 8_000)
          function check() {
            const event = events.slice(after).find(predicate)
            if (!event) return
            clearTimeout(timer)
            listeners.delete(check)
            resolve(event)
          }
          listeners.add(check)
          check()
        })
      },
    }
    await client.wait(event => event.type === 'connected')
    return client
  }

  async function sendTurn(client: Client, content: string) {
    const after = client.events.length
    client.send({ type: 'user_message', content })
    const result = await client.wait(event => event.type === 'message_complete' || event.type === 'error', after)
    expect(result.type).toBe('message_complete')
    await Bun.sleep(TRAILING_FRAME_GRACE_MS)
    return client.events.slice(after)
  }

  async function logEntries(sessionId: string): Promise<Array<{ enabled?: boolean; userMessageSynthetic?: boolean }>> {
    const text = await readFile(controlLog, 'utf8').catch(() => '')
    return text.trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { sessionId: string; enabled?: boolean; userMessageSynthetic?: boolean })
      .filter(entry => entry.sessionId === sessionId)
  }

  async function controls(sessionId: string): Promise<boolean[]> {
    return (await logEntries(sessionId))
      .filter(entry => typeof entry.enabled === 'boolean')
      .map(entry => entry.enabled!)
  }

  // The settings PUT returns once the control is sent; the mock CLI records it
  // asynchronously, so wait for the log to catch up before comparing.
  async function expectControls(sessionId: string, expected: boolean[]) {
    const deadline = Date.now() + 5_000
    let actual = await controls(sessionId)
    while (actual.length < expected.length && Date.now() < deadline) {
      await Bun.sleep(25)
      actual = await controls(sessionId)
    }
    expect(actual).toEqual(expected)
  }

  it('sends server notices to the CLI as synthetic so they do not count as user turns', async () => {
    const sessionId = await createSession()
    const client = await connect(sessionId, { suggestions: true })
    await sendTurn(client, 'hello')
    expect(await conversationService.sendMessage(sessionId, '[Team runtime notice] reviewer finished', undefined, { synthetic: true })).toBe(true)
    const deadline = Date.now() + 5_000
    let flags: boolean[] = []
    while (Date.now() < deadline) {
      flags = (await logEntries(sessionId))
        .filter(entry => typeof entry.userMessageSynthetic === 'boolean')
        .map(entry => entry.userMessageSynthetic!)
      if (flags.length >= 2) break
      await Bun.sleep(25)
    }
    expect(flags).toEqual([false, true])
  }, 20_000)

  it('stays off by default even for a client that can show suggestions', async () => {
    const sessionId = await createSession()
    const client = await connect(sessionId, { suggestions: true })
    const events = await sendTurn(client, 'hello')
    expect(events.some(event => event.type === 'prompt_suggestion')).toBe(false)
    expect(await controls(sessionId)).toEqual([])
  }, 20_000)

  it('does not ask the CLI for suggestions when only clients without the capability watch the session', async () => {
    await setSuggestionsSetting(true)
    const sessionId = await createSession()
    const client = await connect(sessionId, { suggestions: false })
    const events = await sendTurn(client, 'hello')
    expect(events.some(event => event.type === 'prompt_suggestion')).toBe(false)
    expect(await controls(sessionId)).toEqual([])
  }, 20_000)

  it('forwards suggestions to the desktop composer and follows the setting and client presence at runtime', async () => {
    await setSuggestionsSetting(true)
    const sessionId = await createSession()
    const desktop = await connect(sessionId, { suggestions: true })
    const adapter = await connect(sessionId, { suggestions: false })

    const first = await sendTurn(desktop, 'hello')
    expect(first.filter(event => event.type === 'prompt_suggestion')).toEqual([
      { type: 'prompt_suggestion', suggestion: 'Next after hello' },
    ])
    await expectControls(sessionId, [true])

    // Turning the setting off reaches the already running CLI.
    await setSuggestionsSetting(false)
    const second = await sendTurn(desktop, 'again')
    expect(second.some(event => event.type === 'prompt_suggestion')).toBe(false)
    await expectControls(sessionId, [true, false])

    // Back on, then the only capable client leaves: the remaining IM-style
    // client must not keep paying for suggestions nobody sees.
    await setSuggestionsSetting(true)
    await expectControls(sessionId, [true, false, true])
    const closed = new Promise(resolve => desktop.socket.addEventListener('close', resolve))
    desktop.socket.close()
    await closed
    await Bun.sleep(TRAILING_FRAME_GRACE_MS)
    const third = await sendTurn(adapter, 'from im')
    expect(third.some(event => event.type === 'prompt_suggestion')).toBe(false)
    await expectControls(sessionId, [true, false, true, false])
  }, 30_000)
})
