import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createQualityGateSandbox, sandboxTranscriptEvidence } from '../sandbox'
import {
  AGENT_FLOW_SCENARIOS,
  buildMockToolPrompt,
  findOrderedTypes,
  firstOfType,
  type AgentFlowScenario,
  type ProtocolMessage,
} from './scenarios'

const MOCK_CLI = 'src/server/__tests__/fixtures/mock-sdk-cli.ts'
const FIXTURE = 'scripts/quality-gate/agent-flow/fixtures/workspace'
const DEFAULT_STEP_TIMEOUT_MS = 30_000

export type AgentFlowScenarioResult = {
  id: string
  title: string
  status: 'passed' | 'failed'
  durationMs: number
  error?: string
  covers: string[]
}

export function getPort() {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

export async function waitForHttp(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(200)
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? ` (${lastError})` : ''}`)
}

export async function pipeToFile(stream: ReadableStream<Uint8Array> | null, path: string) {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    appendFileSync(path, decoder.decode(value, { stream: true }))
  }
}

/**
 * Exported for `live.ts`, which drives the same protocol against a real provider.
 * The transport, the ordering assertions and the turn loop are identical there —
 * only the runtime behind the CLI and the assertions' tolerance differ — so the two
 * runners share this rather than growing a second, drifting copy.
 *
 * Thin client over the real session WebSocket. It records every frame so a scenario
 * can assert on ordering after the fact instead of racing the stream.
 */
export class SessionSocket {
  readonly messages: ProtocolMessage[] = []
  private ws: WebSocket | null = null

  constructor(private readonly baseUrl: string, private readonly sessionId: string) {}

  async open() {
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/ws/${this.sessionId}`
    const ws = new WebSocket(wsUrl)
    this.ws = ws
    ws.onmessage = (event) => {
      this.messages.push(JSON.parse(String(event.data)) as ProtocolMessage)
    }
    await new Promise<void>((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), DEFAULT_STEP_TIMEOUT_MS)
      ws.onopen = () => { clearTimeout(timer); resolveOpen() }
      ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket failed to open')) }
    })
    await this.waitFor((message) => message.type === 'connected')
    return this
  }

  send(message: Record<string, unknown>) {
    if (!this.ws) throw new Error('socket is not open')
    this.ws.send(JSON.stringify(message))
  }

  /**
   * @param fromIndex Scan position. Turn-scoped waits must pass the buffer length
   *   captured before the prompt was sent, otherwise the previous turn's
   *   `message_complete` satisfies the wait immediately.
   */
  async waitFor(
    predicate: (message: ProtocolMessage) => boolean,
    timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
    label = 'message',
    fromIndex = 0,
  ): Promise<ProtocolMessage> {
    const deadline = Date.now() + timeoutMs
    let cursor = fromIndex
    while (Date.now() < deadline) {
      while (cursor < this.messages.length) {
        const message = this.messages[cursor]
        cursor += 1
        if (predicate(message)) return message
      }
      await Bun.sleep(25)
    }
    throw new Error(`Timed out waiting for ${label}. Seen: ${this.messages.map((m) => m.type).join(', ')}`)
  }

  close() {
    this.ws?.close()
    this.ws = null
  }
}

type ScenarioContext = {
  baseUrl: string
  workRoot: string
  sandboxConfigDir: string
  artifactDir: string
  createSession(): Promise<string>
  openSocket(sessionId: string): Promise<SessionSocket>
}

export function assertOrder(messages: readonly ProtocolMessage[], types: readonly string[]) {
  const ordered = findOrderedTypes(messages, types)
  if (!ordered.ok) {
    throw new Error(`expected ${types.join(' -> ')} but ${ordered.missing} never arrived; saw ${ordered.seen.join(', ')}`)
  }
}

/** Drives one prompt to completion and returns the frames observed for that turn. */
export async function runTurn(socket: SessionSocket, prompt: string, timeoutMs = DEFAULT_STEP_TIMEOUT_MS) {
  const start = socket.messages.length
  socket.send({ type: 'user_message', content: prompt })
  await socket.waitFor((message) => message.type === 'message_complete', timeoutMs, 'message_complete', start)
  return socket.messages.slice(start)
}

const runners: Record<string, (ctx: ScenarioContext) => Promise<void>> = {
  async 'session-and-first-turn'(ctx) {
    const sessionId = await ctx.createSession()
    const socket = await ctx.openSocket(sessionId)
    try {
      // Pin a runtime the way the desktop first-turn selector does. The mock CLI has
      // no provider, so this proves the control frame is accepted and does not abort
      // the turn.
      socket.send({ type: 'set_runtime_config', providerId: null, modelId: 'current' })
      const turn = await runTurn(socket, 'hello from agent flow')
      assertOrder(turn, ['content_start', 'content_delta', 'message_complete'])
      const delta = turn.find((message) => message.type === 'content_delta' && typeof message.text === 'string')
      if (!delta || !String(delta.text).includes('hello from agent flow')) {
        throw new Error(`first turn did not stream the prompt back; got ${JSON.stringify(delta)}`)
      }
    } finally {
      socket.close()
    }
  },

  async 'tool-permission-allow'(ctx) {
    const sessionId = await ctx.createSession()
    const socket = await ctx.openSocket(sessionId)
    const target = join(ctx.workRoot, 'allowed.txt')
    try {
      const prompt = buildMockToolPrompt({
        tool: 'Write',
        input: { file_path: target, content: 'allowed' },
        write: { path: target, content: 'allowed-by-permission' },
        reply: 'wrote allowed.txt',
      })
      const start = socket.messages.length
      socket.send({ type: 'user_message', content: prompt })

      const request = await socket.waitFor((message) => message.type === 'permission_request', DEFAULT_STEP_TIMEOUT_MS, 'permission_request', start)
      if (request.toolName !== 'Write') {
        throw new Error(`permission request carried the wrong tool: ${JSON.stringify(request)}`)
      }
      if (existsSync(target)) {
        throw new Error('tool wrote the file before the permission request was answered')
      }

      socket.send({ type: 'permission_response', requestId: request.requestId, allowed: true, rule: 'agent-flow' })
      await socket.waitFor((message) => message.type === 'message_complete', DEFAULT_STEP_TIMEOUT_MS, 'message_complete', start)
      const turn = socket.messages.slice(start)

      assertOrder(turn, ['content_start', 'permission_request', 'tool_result', 'message_complete'])
      const result = firstOfType(turn, 'tool_result')
      if (result?.isError !== false) {
        throw new Error(`approved tool reported an error: ${JSON.stringify(result)}`)
      }
      if (!existsSync(target) || readFileSync(target, 'utf8') !== 'allowed-by-permission') {
        throw new Error('approved tool did not write the fixture file')
      }
    } finally {
      socket.close()
    }
  },

  async 'tool-permission-deny'(ctx) {
    const sessionId = await ctx.createSession()
    const socket = await ctx.openSocket(sessionId)
    const target = join(ctx.workRoot, 'denied.txt')
    try {
      const prompt = buildMockToolPrompt({
        tool: 'Write',
        input: { file_path: target, content: 'denied' },
        write: { path: target, content: 'should-never-exist' },
      })
      const start = socket.messages.length
      socket.send({ type: 'user_message', content: prompt })

      const request = await socket.waitFor((message) => message.type === 'permission_request', DEFAULT_STEP_TIMEOUT_MS, 'permission_request', start)
      socket.send({ type: 'permission_response', requestId: request.requestId, allowed: false })
      await socket.waitFor((message) => message.type === 'message_complete', DEFAULT_STEP_TIMEOUT_MS, 'message_complete', start)
      const turn = socket.messages.slice(start)

      const result = firstOfType(turn, 'tool_result')
      if (!result || result.isError !== true) {
        throw new Error(`denied tool did not produce an error tool_result: ${JSON.stringify(result)}`)
      }
      if (existsSync(target)) {
        throw new Error('denied tool still wrote the fixture file')
      }
    } finally {
      socket.close()
    }
  },

  async 'tool-failure'(ctx) {
    const sessionId = await ctx.createSession()
    const socket = await ctx.openSocket(sessionId)
    try {
      const prompt = buildMockToolPrompt({
        tool: 'Bash',
        input: { command: 'exit 1' },
        failWith: 'command exited with code 1',
      })
      const start = socket.messages.length
      socket.send({ type: 'user_message', content: prompt })
      const request = await socket.waitFor((message) => message.type === 'permission_request', DEFAULT_STEP_TIMEOUT_MS, 'permission_request', start)
      socket.send({ type: 'permission_response', requestId: request.requestId, allowed: true, rule: 'agent-flow' })
      await socket.waitFor((message) => message.type === 'message_complete', DEFAULT_STEP_TIMEOUT_MS, 'message_complete', start)

      const result = firstOfType(socket.messages.slice(start), 'tool_result')
      if (!result || result.isError !== true || !String(result.content).includes('exit')) {
        throw new Error(`failing tool was not surfaced as an error: ${JSON.stringify(result)}`)
      }
    } finally {
      socket.close()
    }
  },

  async 'api-error'(ctx) {
    const sessionId = await ctx.createSession()
    const socket = await ctx.openSocket(sessionId)
    try {
      const start = socket.messages.length
      socket.send({ type: 'user_message', content: 'please trigger api error now' })
      await socket.waitFor((message) => message.type === 'message_complete', DEFAULT_STEP_TIMEOUT_MS, 'message_complete', start)
      const turn = socket.messages.slice(start)
      const surfaced = turn.some((message) => JSON.stringify(message).includes('Prompt is too long'))
      if (!surfaced) {
        throw new Error(`provider API error never reached the client; saw ${turn.map((m) => m.type).join(', ')}`)
      }

      // The session must survive an API error: the next turn still streams.
      const recovery = await runTurn(socket, 'still alive')
      assertOrder(recovery, ['content_delta', 'message_complete'])
    } finally {
      socket.close()
    }
  },

  async interrupt(ctx) {
    const sessionId = await ctx.createSession()
    const socket = await ctx.openSocket(sessionId)
    try {
      // Park the turn on an unanswered permission request, then stop generation.
      const prompt = buildMockToolPrompt({
        tool: 'Write',
        input: { file_path: join(ctx.workRoot, 'interrupted.txt'), content: 'x' },
      })
      socket.send({ type: 'user_message', content: prompt })
      await socket.waitFor((message) => message.type === 'permission_request', DEFAULT_STEP_TIMEOUT_MS, 'permission_request')

      socket.send({ type: 'stop_generation' })
      socket.send({ type: 'sync_state' })
      const state = await socket.waitFor(
        (message) => message.type === 'session_state',
        DEFAULT_STEP_TIMEOUT_MS,
        'session_state after stop_generation',
      )
      if (state.turnState !== 'idle' && state.turnState !== 'running') {
        throw new Error(`sync_state returned an unknown turn state: ${JSON.stringify(state)}`)
      }
    } finally {
      socket.close()
    }
  },

  async 'reconnect-permission-replay'(ctx) {
    const sessionId = await ctx.createSession()
    const first = await ctx.openSocket(sessionId)
    const target = join(ctx.workRoot, 'reconnected.txt')
    try {
      const prompt = buildMockToolPrompt({
        tool: 'Write',
        input: { file_path: target, content: 'reconnect' },
        write: { path: target, content: 'written-after-reconnect' },
      })
      first.send({ type: 'user_message', content: prompt })
      const original = await first.waitFor((message) => message.type === 'permission_request', DEFAULT_STEP_TIMEOUT_MS, 'permission_request')
      first.close()

      // Reconnecting must replay the still-pending request; otherwise a dropped
      // desktop connection strands the turn behind an approval nobody can see.
      const second = await ctx.openSocket(sessionId)
      try {
        const replayed = await second.waitFor(
          (message) => message.type === 'permission_request' && message.requestId === original.requestId,
          DEFAULT_STEP_TIMEOUT_MS,
          'replayed permission_request',
        )
        second.send({ type: 'permission_response', requestId: replayed.requestId, allowed: true, rule: 'agent-flow' })
        await second.waitFor((message) => message.type === 'message_complete', DEFAULT_STEP_TIMEOUT_MS, 'message_complete')
        if (!existsSync(target)) {
          throw new Error('approving the replayed request did not complete the tool')
        }
      } finally {
        second.close()
      }
    } finally {
      first.close()
    }
  },

  async 'session-recovery'(ctx) {
    const sessionId = await ctx.createSession()
    const socket = await ctx.openSocket(sessionId)
    try {
      await runTurn(socket, 'remember this line')
    } finally {
      socket.close()
    }
    // Let the close settle so the reopen is a genuine reconnect, not a second
    // concurrent client on a still-open session.
    await Bun.sleep(300)

    const evidence = sandboxTranscriptEvidence(ctx.sandboxConfigDir)
    if (evidence.transcriptFiles === 0) {
      throw new Error(`no transcript was written under the sandbox config dir ${ctx.sandboxConfigDir}`)
    }

    const listed = await fetch(`${ctx.baseUrl}/api/sessions`)
    if (!listed.ok) throw new Error(`GET /api/sessions returned HTTP ${listed.status}`)
    if (!(await listed.text()).includes(sessionId)) {
      throw new Error('session disappeared from the session list after the client disconnected')
    }

    const messages = await fetch(`${ctx.baseUrl}/api/sessions/${sessionId}/messages`)
    if (!messages.ok) throw new Error(`GET /api/sessions/:id/messages returned HTTP ${messages.status}`)

    // Reopening the same session id must produce a live connection again. Transcript
    // *content* replay is deliberately not asserted here: the turn records are
    // written by the real Claude CLI, and the mock runtime does not author them.
    // Content-level recovery is covered by the live provider lane.
    const reopened = await ctx.openSocket(sessionId)
    try {
      reopened.send({ type: 'sync_state' })
      await reopened.waitFor((message) => message.type === 'session_state', DEFAULT_STEP_TIMEOUT_MS, 'session_state after reconnect')
      const followUp = await runTurn(reopened, 'still here after reconnect')
      assertOrder(followUp, ['content_delta', 'message_complete'])
    } finally {
      reopened.close()
    }
  },
}

export async function executeAgentFlow(options: {
  rootDir: string
  artifactDir: string
  scenarios: AgentFlowScenario[]
}): Promise<AgentFlowScenarioResult[]> {
  const { rootDir, artifactDir, scenarios } = options
  mkdirSync(artifactDir, { recursive: true })
  const serverLogPath = join(artifactDir, 'server.log')

  const port = await getPort()
  const baseUrl = `http://127.0.0.1:${port}`
  const workRoot = await mkdtemp(join(tmpdir(), 'cc-haha-agent-flow-'))
  cpSync(join(rootDir, FIXTURE), workRoot, { recursive: true })

  // No provider, no credentials, no network: the runtime is the repository's own
  // mock SDK CLI, and all user state lives in a throwaway config dir.
  const sandbox = createQualityGateSandbox({
    label: 'agent-flow',
    seedProviders: false,
    envOverrides: {
      CLAUDE_CLI_PATH: resolve(rootDir, MOCK_CLI),
      CC_HAHA_DISABLE_TERMINAL_SHELL_ENV: '1',
    },
  })

  const server = Bun.spawn(['bun', 'run', 'src/server/index.ts', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: rootDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...sandbox.env, SERVER_PORT: String(port) },
  })
  const pumps = [pipeToFile(server.stdout, serverLogPath), pipeToFile(server.stderr, serverLogPath)]

  const results: AgentFlowScenarioResult[] = []
  try {
    await waitForHttp(`${baseUrl}/health`, 60_000)

    const ctx: ScenarioContext = {
      baseUrl,
      workRoot,
      sandboxConfigDir: sandbox.configDir,
      artifactDir,
      async createSession() {
        const response = await fetch(`${baseUrl}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workDir: workRoot }),
        })
        if (!response.ok) {
          throw new Error(`POST /api/sessions failed with HTTP ${response.status}: ${await response.text()}`)
        }
        const session = await response.json() as { sessionId?: string }
        if (!session.sessionId) throw new Error('session response did not include sessionId')
        return session.sessionId
      },
      async openSocket(sessionId) {
        return new SessionSocket(baseUrl, sessionId).open()
      },
    }

    for (const scenario of scenarios) {
      const started = Date.now()
      const runner = runners[scenario.id]
      if (!runner) {
        results.push({
          id: scenario.id,
          title: scenario.title,
          status: 'failed',
          durationMs: 0,
          error: `no runner implemented for scenario "${scenario.id}"`,
          covers: scenario.covers,
        })
        continue
      }

      try {
        await runner(ctx)
        results.push({ id: scenario.id, title: scenario.title, status: 'passed', durationMs: Date.now() - started, covers: scenario.covers })
      } catch (error) {
        results.push({
          id: scenario.id,
          title: scenario.title,
          status: 'failed',
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
          covers: scenario.covers,
        })
      }
    }
  } finally {
    const mutations = sandbox.detectUserStateMutations()
    writeFileSync(join(artifactDir, 'agent-flow-results.json'), JSON.stringify({
      sandboxConfigDir: sandbox.configDir,
      realConfigMutations: mutations,
      sandboxTranscripts: sandboxTranscriptEvidence(sandbox.configDir),
      results,
    }, null, 2) + '\n')
    if (mutations.length > 0) {
      results.push({
        id: 'user-state-guard',
        title: 'Agent flow left the developer config untouched',
        status: 'failed',
        durationMs: 0,
        error: `wrote to the developer's real config: ${mutations.join(', ')}`,
        covers: [],
      })
    }

    server.kill()
    await server.exited.catch(() => undefined)
    await Promise.all(pumps).catch(() => undefined)
    rmSync(workRoot, { recursive: true, force: true })
    sandbox.cleanup()
  }

  return results
}

export { AGENT_FLOW_SCENARIOS }
