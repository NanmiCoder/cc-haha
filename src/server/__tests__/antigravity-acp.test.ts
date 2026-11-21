import { expect, describe, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import type { MessageEntry, SessionListItem } from '../services/sessionService.js'
import type { ClientMessage, ServerMessage } from '../ws/events.js'

const providerId = 'antigravity-acp'
const defaultModel = 'agent-default'
const nativeId = 'native-test-id'
const discoverPath = `/api/providers/${providerId}/discover`
const authPath = `/api/providers/auth-status?providerId=${providerId}`

type Mode = 'ready' | 'fresh' | 'missing' | 'login' | 'malformed' | 'unconfirmed-model' | 'silent-cancel'
  | 'gated-cancel' | 'prompt-login' | 'background' | 'detached' | 'tool-output' | 'fixed-options' | 'prompt-options'
type WireEntry = {
  pid: number
  argv?: string[]
  hasAnthropicApiKey?: boolean
  hasSshConnection?: boolean
  nativePromptFinished?: boolean
  jsonrpc?: string
  id?: string | number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number }
}

// 真正经由 stdin/stdout 交换 ACP 帧；只有测试进程写入的沙箱文件可读。
const fakeAgy = String.raw`
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const modeFile = join(import.meta.dir, 'agy-mode')
const mode = readFileSync(modeFile, 'utf8')
let gatedUpdate
function whenReleased(run) {
  gatedUpdate = setInterval(() => {
    if (readFileSync(modeFile, 'utf8') !== 'ready') return
    clearInterval(gatedUpdate)
    run()
  }, 15)
}
const record = entry => appendFileSync(join(import.meta.dir, 'agy-wire.jsonl'), JSON.stringify({ pid: process.pid, ...entry }) + '\n')
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
const reply = (id, result) => send({ id, result })
const text = value => ({ type: 'text', text: value })
const configOptions = currentValue => [{ id: 'model', type: 'select', category: 'model', currentValue, options: [
  { value: 'model-a', name: 'Model A' }, { value: 'model-b', name: 'Model B' },
] }]
let sessionId = mode === 'fresh' ? 'native-after-clear' : 'native-test-id'
let resumed = false
let pending
const update = (sessionUpdate, data) => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate, ...data } } })
// 只记录凭据是否存在，不记录值。
record({ argv: process.argv.slice(2), hasAnthropicApiKey: process.env.ANTHROPIC_API_KEY !== undefined,
  hasSshConnection: process.env.SSH_CONNECTION === '192.0.2.1 12345 192.0.2.2 22' })

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const rpc = JSON.parse(line)
  record(rpc)
  switch (rpc.method) {
    case 'initialize':
      reply(rpc.id, {
        protocolVersion: 1, agentInfo: { version: '1.5.14' },
        agentCapabilities: { sessionCapabilities: { resume: {} }, promptCapabilities: { image: true } },
        authMethods: [{ id: 'oauth-personal' }],
      })
      break
    case 'session/new':
      if (mode === 'login') {
        process.stdout.write('Open the following link to authenticate the ACP server: https://accounts.invalid/fixture-login-link\n')
      } else {
        reply(rpc.id, { sessionId: mode === 'malformed' ? null : sessionId, configOptions: configOptions('model-a') })
      }
      break
    case 'session/resume':
      sessionId = rpc.params.sessionId
      resumed = true
      // 恢复时重放旧文本，验证应用不会把 Agent 的重放再写入自身历史。
      update('user_message_chunk', { content: text('First fixture prompt') })
      update('agent_message_chunk', { content: text('ACP reply one') })
      reply(rpc.id, { configOptions: configOptions('model-a') })
      break
    case 'session/set_config_option':
      reply(rpc.id, { configOptions: configOptions(mode === 'unconfirmed-model' ? 'model-a' : rpc.params.value) })
      break
    case 'session/prompt': {
      if (mode === 'prompt-login') {
        send({ id: rpc.id, error: { code: -32000, message: 'Sign in to continue' } })
        break
      }
      if (mode === 'background' || mode === 'detached') {
        update('tool_call', { toolCallId: 'job', title: 'run_command', kind: 'execute', status: 'in_progress', rawInput: { IsDaemon: mode === 'detached' } })
        reply(rpc.id, { stopReason: 'end_turn' })
        record({ nativePromptFinished: true })
        whenReleased(() => {
          update('tool_call_update', { toolCallId: 'job', status: 'completed', rawOutput: { combinedOutput: 'Fixture job output' } })
          update('agent_message_chunk', { content: text('Command finished after the prompt') })
          if (mode === 'detached') {
            const tool = { toolCallId: 'detached-tool', title: 'Read after the command', kind: 'read', status: 'pending' }
            send({ id: 'detached-permission', method: 'session/request_permission', params: { sessionId, toolCall: tool, options: [
              { optionId: 'allow-detached', name: 'Allow once', kind: 'allow_once' },
            ] } })
          } else {
            update('usage_update', { used: 1, size: 10 })
          }
        })
        break
      }
      if (mode === 'tool-output') {
        update('tool_call', { toolCallId: 'completed-first', title: 'read', status: 'completed', rawOutput: 'Immediate output' })
        update('tool_call_update', { toolCallId: 'completed-first', status: 'completed' })
        update('tool_call', { toolCallId: 'failed-command', title: 'run_command', kind: 'execute', status: 'in_progress' })
        update('tool_call_update', { toolCallId: 'failed-command', status: 'failed', rawOutput: { combinedOutput: 'Shell failed', exitCode: 2 } })
        reply(rpc.id, { stopReason: 'end_turn' })
        break
      }
      if (mode === 'prompt-options') {
        const answer = rpc.params.prompt[0]?.text
        if (pending) {
          const { tool, cancelled } = pending
          pending = undefined
          update('tool_call_update', { ...tool, status: 'in_progress' })
          update('tool_call_update', { ...tool, status: cancelled ? 'failed' : 'completed' })
          update('agent_message_chunk', { content: text(cancelled ? 'Independent follow-up' : answer === '2' ? 'Chosen: Desktop' : 'Wrong option') })
        } else {
          const tool = { toolCallId: 'call_native_question', name: 'ask_question', title: 'Run ask_question', kind: 'other', status: 'in_progress',
            rawInput: { questions: [{ is_multi_select: false, options: ['Web', 'Desktop'], question: 'Pick a platform' }] } }
          pending = { tool }
          update('agent_message_chunk', { content: text('I need one choice first.') })
          update('tool_call', tool)
          update('tool_call_update', { ...tool, status: 'pending' })
          update('agent_message_chunk', { content: text('\nPick a platform\n- [1] Web\n') })
          update('agent_message_chunk', { content: text('- [2] Desktop\n') })
        }
        reply(rpc.id, { stopReason: 'end_turn' })
        break
      }
      if (mode === 'fixed-options') {
        const tool = { toolCallId: 'interaction_fixture', title: 'Pick a platform', status: 'pending' }
        pending = { id: rpc.id, toolCallId: tool.toolCallId }
        update('tool_call', tool)
        send({ id: 'question-permission', method: 'session/request_permission', params: { sessionId, toolCall: tool, options: [
          { optionId: 'desktop', name: 'Desktop', kind: 'allow_once' }, { optionId: 'web', name: 'Web', kind: 'allow_once' },
        ] } })
        break
      }
      const tool = { toolCallId: resumed ? 'tool-two' : 'tool-one', title: 'Read fixture',
        kind: 'read', status: 'pending', rawInput: { path: 'fixture.txt' } }
      pending = { id: rpc.id, toolCallId: tool.toolCallId }
      update('agent_message_chunk', { content: text('ACP reply ') })
      update('agent_message_chunk', { content: text(resumed ? 'two' : 'one') })
      send({ id: 'unsupported-client-call', method: 'fs/read_text_file', params: { sessionId, path: join(import.meta.dir, 'fixture.txt') } })
      update('tool_call', tool)
      send({ id: 'tool-permission', method: 'session/request_permission', params: { sessionId, toolCall: tool, options: [
        { optionId: 'deny-this-time', name: 'Reject once', kind: 'reject_once' },
        { optionId: 'allow-this-time', name: 'Allow once', kind: 'allow_once' },
      ] } })
      break
    }
    case 'session/cancel': {
      if (mode === 'prompt-options' && pending) {
        pending.cancelled = true
        break
      }
      clearInterval(gatedUpdate)
      const cancelled = pending
      pending = undefined
      if (mode === 'background') {
        update('agent_message_chunk', { content: text('Late output after stop') })
        update('usage_update', { used: 1, size: 10 })
      }
      if (cancelled && mode === 'gated-cancel') {
        whenReleased(() => reply(cancelled.id, { stopReason: 'cancelled' }))
      } else if (cancelled && mode !== 'silent-cancel') {
        reply(cancelled.id, { stopReason: 'cancelled' })
      }
      break
    }
    default:
      if (rpc.id === 'detached-permission') {
        const allowed = rpc.result?.outcome?.optionId === 'allow-detached'
        update('tool_call_update', { toolCallId: 'detached-tool', status: allowed ? 'completed' : 'failed', rawOutput: 'Detached read' })
        update('usage_update', { used: 1, size: 10 })
      } else if (rpc.id === 'question-permission' && pending) {
        const optionId = rpc.result?.outcome?.optionId
        update('tool_call_update', { toolCallId: pending.toolCallId, status: optionId ? 'completed' : 'failed', rawOutput: optionId ?? 'Cancelled' })
        reply(pending.id, { stopReason: 'end_turn' })
        pending = undefined
      } else if (rpc.id === 'tool-permission' && pending) {
        const allowed = rpc.result?.outcome?.optionId === 'allow-this-time'
        update('tool_call_update', { toolCallId: pending.toolCallId, status: allowed ? 'completed' : 'failed',
          content: [{ type: 'content', content: text(allowed ? 'Read allowed' : 'Read denied') }] })
        reply(pending.id, { stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 3 } })
        pending = undefined
      } else if (rpc.method && rpc.id !== undefined) {
        send({ id: rpc.id, error: { code: -32601, message: 'Method not found' } })
      }
  }
}
`

async function until<T>(label: string, read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5_000
  do {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(15)
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${label}`)
}

function jsonLines<T>(text: string): T[] {
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function methods(wire: WireEntry[]): string[] {
  return wire.flatMap(entry => entry.method ? [entry.method] : [])
}

async function connectClient(port: number, sessionId: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/${sessionId}`)
  const events: ServerMessage[] = []
  socket.onmessage = event => events.push(JSON.parse(String(event.data)))
  async function wait<K extends ServerMessage['type']>(type: K, after = 0) {
    return until(`WebSocket ${type}`, () => {
      const event = events.slice(after).find(event => event.type === type || event.type === 'error')
      if (event?.type === 'error' && type !== 'error') throw new Error(`Unexpected WebSocket error: ${JSON.stringify(event)}`)
      if (!event && socket.readyState === WebSocket.CLOSED) throw new Error(`WebSocket closed before ${type}`)
      return event as Extract<ServerMessage, { type: K }> | undefined
    })
  }
  try {
    await wait('connected')
  } catch (error) {
    socket.close()
    throw error
  }
  return { socket, events, wait, send: (message: ClientMessage) => socket.send(JSON.stringify(message)) }
}

type Client = Awaited<ReturnType<typeof connectClient>>

async function withFixture(mode: Mode, exercise: (fixture: {
  agy: string
  workDir: string
  restart(): Promise<void>
  setMode(mode: Mode): Promise<void>
  wire(): Promise<WireEntry[]>
  api<T>(path: string, body?: unknown): Promise<T>
  createSession(): Promise<{ sessionId: string; transcript: string }>
  connect(sessionId: string): Promise<Client>
}) => Promise<void>, { coldServerRestart = false } = {}) {
  // Bun 会缓存进程启动时的 homedir；直接运行本文件时不能让服务端退回真实用户目录。
  const inProcess = !coldServerRestart && homedir() === process.env.CC_HAHA_TEST_HOME
  const home = await realpath(await mkdtemp(join(tmpdir(), 'cc-haha-agy-test-')))
  const bin = join(home, 'bin')
  const workDir = join(home, 'workspace')
  const agy = join(bin, 'agy')
  const fallback = join(bin, 'fixture-claude')
  const fallbackLog = join(home, 'unexpected-claude-launch')
  const ready = join(home, 'server-port')
  const modePath = join(home, 'agy-mode')
  const wirePath = join(home, 'agy-wire.jsonl')
  const program = join(home, 'fake-agy.ts')
  const sockets = new Set<WebSocket>()
  let port: number
  let stop: (() => Promise<void>) | undefined

  try {
    const env = createSandboxedTestEnvironment(home, {
      PATH: bin, CLAUDE_CLI_PATH: fallback, CC_HAHA_LOCAL_INDEX: 'off',
      ANTHROPIC_API_KEY: 'fixture-fallback-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
      SSH_CONNECTION: '192.0.2.1 12345 192.0.2.2 22',
      CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CC_HAHA_SKIP_DOTENV: '1',
    })
    await mkdir(bin)
    await mkdir(workDir)
    await writeFile(modePath, mode)
    await writeFile(wirePath, '')
    await writeFile(program, fakeAgy)
    if (mode !== 'missing') {
      await writeFile(agy, `#!/bin/sh\nexec ${shellQuote(process.execPath)} --no-env-file ${shellQuote(program)} "$0" "$@"\n`, { mode: 0o700 })
    }
    // 就算错误回退到 Claude，也只能执行此拦截器并留下证据。
    await writeFile(fallback, `#!/bin/sh\nprintf '%s\n' "$@" > ${shellQuote(fallbackLog)}\nexit 1\n`, { mode: 0o700 })

    async function stopServer() {
      for (const socket of sockets) socket.close()
      sockets.clear()
      const stopCurrent = stop
      stop = undefined
      return stopCurrent?.()
    }

    async function startInstrumentedServer() {
      const savedEnv = { ...process.env }
      const fetchBefore = globalThis.fetch
      const signals = ['SIGINT', 'SIGTERM', 'exit'] as const
      const listeners = signals.map(signal => process.listeners(signal))
      const replaceEnv = (next: NodeJS.ProcessEnv) => {
        for (const key of Object.keys(process.env)) delete process.env[key]
        Object.assign(process.env, next)
      }
      replaceEnv(env)
      globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.hostname !== '127.0.0.1') throw new Error('Network outside loopback is disabled in the AGY fixture')
        return fetchBefore(input, init)
      }, fetchBefore)
      let shutdown: (() => Promise<void>) | undefined
      stop = async () => {
        try {
          await shutdown?.()
        } finally {
          for (const [index, signal] of signals.entries()) {
            for (const listener of process.listeners(signal)) {
              if (!listeners[index]?.includes(listener)) process.off(signal, listener)
            }
          }
          globalThis.fetch = fetchBefore
          replaceEnv(savedEnv)
        }
      }
      const { startServer, stopServerRuntimeForShutdown } = await import('../index.js')
      const { apiPerformanceMonitor } = await import('../services/apiPerformanceMonitor.js')
      let server: ReturnType<typeof startServer> | undefined
      shutdown = async () => {
        try {
          await server?.stop(true)
          await stopServerRuntimeForShutdown()
        } finally {
          apiPerformanceMonitor.stop()
        }
      }
      server = startServer(0, '127.0.0.1')
      port = server.port!
    }

    async function restart() {
      await stopServer()
      // 普通用例由 Bun 采集实际服务端代码；冷重启用例仍检查真实进程和信号。
      if (inProcess) return startInstrumentedServer()
      await rm(ready, { force: true })
      const proc = Bun.spawn([
        process.execPath, '--no-env-file', '--no-install', '--preload', join(import.meta.dir, '../../../preload.ts'), '-e', `
          const localFetch = globalThis.fetch
          globalThis.fetch = (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input))
            if (url.hostname !== '127.0.0.1') throw new Error('Network outside loopback is disabled in the AGY fixture')
            return localFetch(input, init)
          }
          const { startServer } = await import(${JSON.stringify(join(import.meta.dir, '../index.ts'))})
          const server = startServer(0, '127.0.0.1')
          if (!process.env.ANTHROPIC_API_KEY) throw new Error('Missing fake server API key')
          await Bun.write(${JSON.stringify(ready)}, String(server.port))
        `,
      ], { cwd: home, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
      const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      stop = async () => {
        proc.kill('SIGTERM')
        const timer = setTimeout(() => proc.kill('SIGKILL'), 4_000)
        try { expect(await proc.exited).toBe(0) } finally { clearTimeout(timer) }
      }
      port = await until('real server ready', async () => {
        if (proc.exitCode !== null || proc.signalCode !== null) throw new Error((await output).join('\n'))
        const file = Bun.file(ready)
        return await file.exists() ? (Number(await file.text()) || undefined) : undefined
      })
    }

    async function api<T>(path: string, body?: unknown): Promise<T> {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5_000),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`)
      return JSON.parse(text)
    }

    try {
      await restart()
      await exercise({
        agy, workDir, restart, api,
        setMode: next => writeFile(modePath, next),
        wire: async () => jsonLines<WireEntry>(await readFile(wirePath, 'utf8')),
        async createSession() {
          const { sessionId } = await api<{ sessionId: string }>('/api/sessions', { workDir })
          const [transcript] = new Bun.Glob(`*/${sessionId}.jsonl`).scanSync({ cwd: join(env.CLAUDE_CONFIG_DIR, 'projects'), absolute: true })
          if (!transcript) throw new Error(`Missing sandbox transcript for ${sessionId}`)
          return { sessionId, transcript }
        },
        async connect(sessionId) {
          const client = await connectClient(port, sessionId)
          sockets.add(client.socket)
          return client
        },
      })
      await stopServer()
      expect(await Bun.file(fallbackLog).exists()).toBe(false)
    } finally {
      await stopServer()
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

async function selectRuntime(client: Client, modelId = defaultModel) {
  const after = client.events.length
  client.send({ type: 'set_runtime_config', providerId, modelId })
  expect(await client.wait('runtime_config_applied', after)).toMatchObject({ providerId, modelId })
}

const textBlock = (text: string) => ({ type: 'text', text })
const toolName = 'Antigravity: Read fixture'
const toolInput = { path: 'fixture.txt' }

async function prompt(client: Client, content: string, suffix: 'one' | 'two') {
  const after = client.events.length
  client.send({ type: 'user_message', content })
  const permission = await client.wait('permission_request', after)
  expect(permission).toMatchObject({ toolName, toolUseId: `tool-${suffix}`, input: toolInput })
  expect(client.events.slice(after).filter(event => event.type === 'content_delta').map(event => event.text)).toEqual(['ACP reply ', suffix])
  expect(client.events.slice(after).some(event => event.type === 'message_complete')).toBe(false)
  return permission.requestId
}

async function answerPermission(client: Client, requestId: string, suffix: 'one' | 'two', allowed: boolean) {
  const after = client.events.length
  client.send({ type: 'permission_response', requestId, allowed, rule: 'once' })
  expect(await client.wait('message_complete', after)).toMatchObject({ usage: { input_tokens: 7, output_tokens: 3 } })
  expect(client.events.slice(after)).toContainEqual({ type: 'permission_resolved', permissionType: 'tool', requestId, allowed })
  expect(client.events.slice(after).find(event => event.type === 'tool_result')).toMatchObject({ toolUseId: `tool-${suffix}`, isError: !allowed })
}

async function finishTurn(client: Client, content: string, suffix: 'one' | 'two', allowed: boolean) {
  await answerPermission(client, await prompt(client, content, suffix), suffix, allowed)
}

function expectTurnWire(wire: WireEntry[], content: string, allowed: boolean) {
  expect(wire.find(entry => entry.method === 'session/prompt')?.params).toEqual({ sessionId: nativeId, prompt: [textBlock(content)] })
  expect(wire.filter(entry => entry.id === 'unsupported-client-call')).toMatchObject([{ jsonrpc: '2.0', error: { code: -32601 } }])
  expect(wire.filter(entry => entry.id === 'tool-permission')).toMatchObject([
    { jsonrpc: '2.0', result: { outcome: { outcome: 'selected', optionId: allowed ? 'allow-this-time' : 'deny-this-time' } } },
  ])
}

function expectHistoryTurn(messages: MessageEntry[], input: string, suffix: 'one' | 'two', allowed: boolean) {
  expect(messages).toMatchObject([
    { type: 'user', content: [textBlock(input)] },
    { type: 'assistant', model: 'model-a', content: [textBlock(`ACP reply ${suffix}`)] },
    { type: 'tool_use', content: [{ type: 'tool_use', id: `tool-${suffix}`, name: toolName, input: toolInput }] },
    { type: 'tool_result', content: [{ type: 'tool_result', tool_use_id: `tool-${suffix}`, content: allowed ? 'Read allowed' : 'Read denied', is_error: !allowed }] },
  ])
}

// 临时可执行文件使用 POSIX shebang，Windows 不走这个夹具。
describe.skipIf(process.platform === 'win32')('Antigravity ACP integration', () => {
  test('discovers on demand, streams and persists turns, resumes by native ID, then clears the binding', async () => {
    await withFixture('ready', async ({ agy, workDir, api, wire, connect, createSession, restart, setMode }) => {
      expect(await api('/api/providers')).toMatchObject({ localAgent: { id: providerId, kind: 'acp', status: 'unchecked', models: [] } })
      expect(await api(authPath)).toMatchObject({ localAgentStatus: 'unchecked' })
      expect(await wire()).toEqual([])
      const discovery = await api(discoverPath, {})
      expect(discovery).toMatchObject({ id: providerId, kind: 'acp', status: 'ready', version: '1.5.14', currentModelId: 'model-a',
        models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }] })
      expect(await api('/api/providers')).toMatchObject({ localAgent: discovery })
      expect(await api(authPath)).toMatchObject({ hasAuth: true, localAgentStatus: 'ready' })
      const discovered = await wire()
      expect(methods(discovered)).toEqual(['initialize', 'session/new'])
      expect(discovered[0]).toMatchObject({ argv: [agy, 'acp'], hasAnthropicApiKey: false })
      expect(discovered[1]).toMatchObject({ jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })

      const { sessionId, transcript } = await createSession()
      const summary = () => api<SessionListItem>(`/api/sessions/${sessionId}/summary`)
      const history = async (stage: string) => {
        try {
          return (await api<{ messages: MessageEntry[] }>(`/api/sessions/${sessionId}/messages`)).messages
        } catch (error) {
          throw new Error(`${stage}: ${error}`)
        }
      }
      const metadata = async () => jsonLines<Record<string, unknown>>(await readFile(transcript, 'utf8')).filter(entry => entry.type === 'session-meta')
      const legacyExtension = { from: 'old-release' }
      const legacyFields = { workDir, agentProfile: 'standard', permissionMode: 'acceptEdits', runtimeProviderId: null, runtimeModelId: 'legacy-model' }
      const legacyLine = JSON.stringify({ type: 'session-meta', isMeta: true, ...legacyFields, legacyExtension }) + '\n'
      await writeFile(transcript, legacyLine)
      expect(await summary()).toMatchObject(legacyFields)
      expect(await readFile(transcript, 'utf8')).toBe(legacyLine)

      const selection = { runtimeProviderId: providerId, runtimeModelId: defaultModel }
      const client = await connect(sessionId)
      await selectRuntime(client)
      client.send({ type: 'prewarm_session' })
      await until('new native session on disk', async () => (await metadata()).find(entry => entry.antigravitySessionId === nativeId))
      expect(methods((await wire()).slice(discovered.length))).toEqual(['initialize', 'session/new'])
      const firstPrompt = 'First fixture prompt'
      await finishTurn(client, firstPrompt, 'one', true)
      const first = await history('first turn')
      expectHistoryTurn(first, firstPrompt, 'one', true)
      const firstWire = (await wire()).slice(discovered.length)
      expect(firstWire[0]).toMatchObject({ argv: [agy, 'acp'], hasAnthropicApiKey: false })
      expect(methods(firstWire)).toEqual(['initialize', 'session/new', 'session/prompt'])
      expect(firstWire.find(entry => entry.method === 'session/new')?.params).toEqual({ cwd: workDir, mcpServers: [] })
      expectTurnWire(firstWire, firstPrompt, true)
      expect(await readFile(transcript, 'utf8')).toStartWith(legacyLine)
      expect(await summary()).toMatchObject(selection)

      // 关掉服务端和外部 Agent 后重开，不重发 runtime 选择。
      await restart()
      expect(await summary()).toMatchObject(selection)
      expect(await history('reopen')).toEqual(first)
      const resumed = await connect(sessionId)
      resumed.send({ type: 'prewarm_session' })
      const resumeOffset = discovered.length + firstWire.length
      await until('prewarm resume request', async () => (await wire()).slice(resumeOffset).find(entry => entry.method === 'session/resume'))
      const secondPrompt = 'Second fixture prompt'
      await finishTurn(resumed, secondPrompt, 'two', false)
      const resumedWire = (await wire()).slice(resumeOffset)
      expect(resumedWire[0]).toMatchObject({ argv: [agy, 'acp'], hasAnthropicApiKey: false })
      expect(resumedWire[0]?.pid).not.toBe(firstWire[0]?.pid)
      expect(methods(resumedWire)).toEqual(['initialize', 'session/resume', 'session/prompt'])
      expect(resumedWire.find(entry => entry.method === 'session/resume')?.params).toEqual({ sessionId: nativeId, cwd: workDir, mcpServers: [] })
      expectTurnWire(resumedWire, secondPrompt, false)
      const appended = await history('resumed turn')
      expect(appended.slice(0, first.length)).toEqual(first)
      expectHistoryTurn(appended.slice(first.length), secondPrompt, 'two', false)
      expect((await metadata()).findLast(entry => 'antigravitySessionId' in entry)?.antigravitySessionId).toBe(nativeId)

      const clearOffset = resumed.events.length
      resumed.send({ type: 'user_message', content: '/clear' })
      await resumed.wait('message_complete', clearOffset)
      expect(resumed.events.slice(clearOffset).some(event => event.type === 'system_notification' && event.subtype === 'session_cleared')).toBe(true)
      expect(await summary()).toMatchObject({ ...selection, messageCount: 0 })
      expect(await history('after /clear')).toEqual([])
      const cleared = await metadata()
      expect(cleared).toMatchObject([{ ...selection, legacyExtension }])
      expect(cleared[0]).not.toHaveProperty('antigravitySessionId')
      expect(await wire()).toHaveLength(resumeOffset + resumedWire.length)

      await setMode('fresh')
      await selectRuntime(resumed, 'model-b')
      const freshOffset = (await wire()).length
      resumed.send({ type: 'prewarm_session' })
      await until('fresh native ID and selected model on disk', async () => (await metadata()).find(entry =>
        entry.antigravitySessionId === 'native-after-clear' && entry.runtimeModelId === 'model-b'))
      const fresh = (await wire()).slice(freshOffset)
      expect(methods(fresh)).toEqual(['initialize', 'session/new', 'session/set_config_option'])
      expect(fresh.find(entry => entry.method === 'session/set_config_option')?.params).toEqual({ sessionId: 'native-after-clear', configId: 'model', value: 'model-b' })

      const requestId = await prompt(resumed, 'Cancel this fixture prompt', 'one')
      const stopOffset = resumed.events.length
      resumed.send({ type: 'stop_generation' })
      expect(await resumed.wait('permission_resolved', stopOffset)).toMatchObject({ requestId, permissionType: 'tool' })
      const cancelled = await until('cancelled ACP permission', async () => {
        const turn = (await wire()).slice(freshOffset + fresh.length)
        return turn.some(entry => entry.id === 'tool-permission') ? turn : undefined
      })
      expect(methods(cancelled)).toEqual(['session/prompt', 'session/cancel'])
      const cancel = cancelled.find(entry => entry.method === 'session/cancel')
      expect(cancel?.params).toEqual({ sessionId: 'native-after-clear' })
      expect(cancel).not.toHaveProperty('id')
      expect(cancelled.find(entry => entry.id === 'tool-permission')?.result).toEqual({ outcome: { outcome: 'cancelled' } })
    })
  }, 25_000)

  test('rejects a nonboolean approval without consuming the pending permission', async () => {
    await withFixture('ready', async ({ wire, connect, createSession }) => {
      const { sessionId } = await createSession()
      const client = await connect(sessionId)
      await selectRuntime(client)
      const content = 'Permission validation fixture'
      const requestId = await prompt(client, content, 'one')
      const offset = client.events.length
      // 绕过客户端的 TypeScript 类型，验证服务端实际收到的 JSON。
      client.socket.send(JSON.stringify({ type: 'permission_response', requestId, allowed: 'false', rule: 'once' }))
      const decision = await until('nonboolean permission rejection', () => client.events.slice(offset).find(event =>
        event.type === 'error' || (event.type === 'permission_resolved' && event.requestId === requestId)))
      expect(decision).toMatchObject({ type: 'error', code: 'PERMISSION_RESPONSE_INVALID' })
      expect((await wire()).filter(entry => entry.id === 'tool-permission')).toEqual([])

      await answerPermission(client, requestId, 'one', false)
      expectTurnWire(await wire(), content, false)
    })
  }, 15_000)

  test('preserves the first client’s completion when another client sends during its permission wait', async () => {
    await withFixture('ready', async ({ api, wire, connect, createSession }) => {
      const { sessionId } = await createSession()
      const first = await connect(sessionId)
      await selectRuntime(first)
      const content = 'Original client fixture prompt'
      const requestId = await prompt(first, content, 'one')

      const second = await connect(sessionId)
      expect(await second.wait('permission_requests_snapshot')).toMatchObject({ toolRequestIds: [requestId], turnActive: true })
      const offset = second.events.length
      second.send({ type: 'user_message', content: 'Competing client fixture prompt' })
      // 等第二次输入明确被拒，再放行第一轮，避免定时等待掩盖竞争。
      const rejection = await second.wait('error', offset)
      await answerPermission(first, requestId, 'one', true)
      expect(rejection.code).toBe('ANTIGRAVITY_TURN_BUSY')

      const calls = await wire()
      expect(methods(calls)).toEqual(['initialize', 'session/new', 'session/prompt'])
      expectTurnWire(calls, content, true)
      const { messages } = await api<{ messages: MessageEntry[] }>(`/api/sessions/${sessionId}/messages`)
      expectHistoryTurn(messages, content, 'one', true)
    })
  }, 15_000)

  test('resumes the native session for a follow-up after an unresponsive cancellation', async () => {
    await withFixture('silent-cancel', async ({ wire, connect, createSession }) => {
      const { sessionId } = await createSession()
      const client = await connect(sessionId)
      await selectRuntime(client)
      const requestId = await prompt(client, 'Cancelled fixture prompt', 'one')
      const offset = client.events.length
      client.send({ type: 'stop_generation' })
      expect(await client.wait('permission_resolved', offset)).toMatchObject({ requestId, permissionType: 'tool' })

      // 不等旧进程退出就发下一条。旧 ACP 故意不响应取消，应用必须自行恢复。
      const followup = 'Follow-up after silent cancellation'
      await finishTurn(client, followup, 'two', true)
      const calls = await wire()
      expect(methods(calls)).toEqual([
        'initialize', 'session/new', 'session/prompt', 'session/cancel',
        'initialize', 'session/resume', 'session/prompt',
      ])
      const cancel = calls.find(entry => entry.method === 'session/cancel')!
      expect(cancel.params).toEqual({ sessionId: nativeId })
      expect(cancel).not.toHaveProperty('id')
      expect(calls.find(entry => entry.pid === cancel.pid && entry.id === 'tool-permission')?.result)
        .toEqual({ outcome: { outcome: 'cancelled' } })
      const resume = calls.find(entry => entry.method === 'session/resume')!
      expect(resume.pid).not.toBe(cancel.pid)
      expect(resume.params?.sessionId).toBe(nativeId)
      expectTurnWire(calls.filter(entry => entry.pid === resume.pid), followup, true)
    })
  }, 15_000)

  test('keeps already streamed output across a normal restart during an approval', async () => {
    await withFixture('ready', async ({ api, wire, connect, createSession, restart }) => {
      const { sessionId } = await createSession()
      const client = await connect(sessionId)
      await selectRuntime(client)
      await prompt(client, 'Prompt before shutdown', 'one')
      client.send({ type: 'set_runtime_config', providerId, modelId: 'model-b' })
      await until('deferred model persisted', async () => {
        const { runtimeModelId } = await api<SessionListItem>(`/api/sessions/${sessionId}/summary`)
        return runtimeModelId === 'model-b' ? runtimeModelId : undefined
      })
      await restart()
      expect(methods(await wire())).not.toContain('session/resume')
      const { messages } = await api<{ messages: MessageEntry[] }>(`/api/sessions/${sessionId}/messages`)
      expect(messages).toMatchObject([
        { type: 'user', content: [textBlock('Prompt before shutdown')] },
        { type: 'assistant', content: [textBlock('ACP reply one')] },
        { type: 'tool_use', content: [{ type: 'tool_use', id: 'tool-one' }] },
      ])
      await finishTurn(await connect(sessionId), 'Continue after shutdown', 'two', true)
      const after = await api<{ messages: MessageEntry[] }>(`/api/sessions/${sessionId}/messages`)
      expect(after.messages.slice(0, messages.length)).toEqual(messages)
      expect((await wire()).find(entry => entry.method === 'session/resume')?.params?.sessionId).toBe(nativeId)
    }, { coldServerRestart: true })
  }, 15_000)

  for (const mode of ['background', 'detached'] as const) {
    test(`forwards and saves ${mode} output after the native prompt has settled`, async () => {
      await withFixture(mode, async ({ api, wire, connect, createSession, setMode }) => {
        const { sessionId } = await createSession()
        const client = await connect(sessionId)
        await selectRuntime(client)
        const offset = client.events.length
        client.send({ type: 'user_message', content: 'Start a command' })
        await until('native prompt response', async () => (await wire()).find(entry => entry.nativePromptFinished))
        if (mode === 'detached') await client.wait('message_complete', offset)
        const after = client.events.length
        await setMode('ready')
        expect(await client.wait('tool_result', after)).toMatchObject({ toolUseId: 'job', content: 'Fixture job output' })
        expect(await client.wait('content_delta', after)).toMatchObject({ text: 'Command finished after the prompt' })
        if (mode === 'detached') {
          const request = await client.wait('permission_request', after)
          expect(request.toolUseId).toBe('detached-tool')
          client.send({ type: 'set_runtime_config', providerId, modelId: 'model-b' })
          await until('model choice saved during detached approval', async () => {
            const { runtimeModelId } = await api<SessionListItem>(`/api/sessions/${sessionId}/summary`)
            return runtimeModelId === 'model-b' ? runtimeModelId : undefined
          })
          client.send({ type: 'permission_response', requestId: request.requestId, allowed: true, rule: 'once' })
          await until('detached read result', () => client.events.slice(after).find(event =>
            event.type === 'tool_result' && event.toolUseId === 'detached-tool' && event.isError === false))
          expect(await client.wait('runtime_config_applied', after)).toMatchObject({ modelId: 'model-b' })
        }
        await client.wait('message_complete', after)
        const { messages } = await api<{ messages: MessageEntry[] }>(`/api/sessions/${sessionId}/messages`)
        const types = ['user', 'tool_use', 'tool_result', 'assistant']
        if (mode === 'detached') types.push('tool_use', 'tool_result')
        expect(messages.map(message => message.type)).toEqual(types)
        expect(messages[3]?.content).toEqual([textBlock('Command finished after the prompt')])
      })
    }, 15_000)
  }

  test('cancels a background command even after the native prompt has settled', async () => {
    await withFixture('background', async ({ api, wire, connect, createSession }) => {
      const { sessionId } = await createSession()
      const client = await connect(sessionId)
      await selectRuntime(client)
      const offset = client.events.length
      client.send({ type: 'user_message', content: 'Start a stoppable command' })
      await until('native prompt response', async () => (await wire()).find(entry => entry.nativePromptFinished))
      const reconnect = await connect(sessionId)
      expect(await reconnect.wait('permission_requests_snapshot')).toMatchObject({ turnActive: true })
      client.send({ type: 'stop_generation' })
      expect(await until('cancel for background command', async () => (await wire()).find(entry => entry.method === 'session/cancel')))
        .toMatchObject({ params: { sessionId: nativeId } })
      await client.wait('message_complete', offset)
      expect(client.events.slice(offset).filter(event => event.type === 'content_delta')).toEqual([])
      const { messages } = await api<{ messages: MessageEntry[] }>(`/api/sessions/${sessionId}/messages`)
      expect(messages.map(message => message.type)).toEqual(['user', 'tool_use'])
    })
  }, 15_000)

  for (const sendBeforeSelection of [false, true]) {
    test(`applies a model selected during Stop without losing output (send first: ${sendBeforeSelection})`, async () => {
      await withFixture('gated-cancel', async ({ api, wire, connect, createSession, setMode }) => {
        const { sessionId } = await createSession()
        const client = await connect(sessionId)
        await selectRuntime(client, 'model-a')
        await prompt(client, 'Stop on model A', 'one')
        const offset = client.events.length
        client.send({ type: 'stop_generation' })
        await client.wait('permission_resolved', offset)
        const after = client.events.length
        const sendReplacement = async () => {
          client.send({ type: 'user_message', content: 'Run on model B' })
          await until('replacement admitted', () => client.events.slice(after).find(event => event.type === 'status' && event.state === 'thinking'))
        }
        if (sendBeforeSelection) await sendReplacement()
        client.send({ type: 'set_runtime_config', providerId, modelId: 'model-b' })
        await until('new model saved while cancellation is pending', async () => {
          const { runtimeModelId } = await api<SessionListItem>(`/api/sessions/${sessionId}/summary`)
          return runtimeModelId === 'model-b' ? runtimeModelId : undefined
        })
        if (!sendBeforeSelection) await sendReplacement()
        await setMode('ready')
        const permission = await client.wait('permission_request', after)
        const calls = await wire()
        const first = calls.find(entry => entry.method === 'session/prompt')!
        const second = calls.findLast(entry => entry.method === 'session/prompt')!
        const model = calls.find(entry => entry.method === 'session/set_config_option' && entry.params?.value === 'model-b')!
        expect(second.pid).not.toBe(first.pid)
        expect(model.pid).toBe(second.pid)
        expect(calls.indexOf(model)).toBeLessThan(calls.indexOf(second))
        await answerPermission(client, permission.requestId, 'two', true)
        const { messages } = await api<{ messages: MessageEntry[] }>(`/api/sessions/${sessionId}/messages`)
        expect(messages[1]).toMatchObject({ type: 'assistant', model: 'model-a', content: [textBlock('ACP reply one')] })
      })
    }, 15_000)
  }

  test('requires re-login and replaces the stale runtime for a manual retry', async () => {
    await withFixture('prompt-login', async ({ api, wire, connect, createSession, setMode }) => {
      const { sessionId } = await createSession()
      const client = await connect(sessionId)
      await selectRuntime(client)
      const offset = client.events.length
      client.send({ type: 'user_message', content: 'Prompt with expired credentials' })
      expect(await client.wait('error', offset)).toMatchObject({ code: 'ANTIGRAVITY_LOGIN_REQUIRED' })
      expect(await api(authPath)).toMatchObject({ hasAuth: false, localAgentStatus: 'login_required' })
      await setMode('ready')
      expect(await api(discoverPath, {})).toMatchObject({ status: 'ready' })
      await finishTurn(client, 'Manually retry after re-login', 'two', true)
      const calls = await wire()
      const prompts = calls.filter(entry => entry.method === 'session/prompt')
      expect(prompts).toHaveLength(2)
      expect(prompts[1]?.pid).not.toBe(prompts[0]?.pid)
      expect(calls.find(entry => entry.pid === prompts[1]?.pid && entry.method === 'session/resume')?.params?.sessionId).toBe(nativeId)
    })
  }, 15_000)

  test('emits and persists tool results for terminal calls and structured command output', async () => {
    await withFixture('tool-output', async ({ api, connect, createSession }) => {
      const { sessionId } = await createSession()
      const client = await connect(sessionId)
      await selectRuntime(client)
      const offset = client.events.length
      client.send({ type: 'user_message', content: 'Use the fixture tools' })
      await client.wait('message_complete', offset)
      const expected = [
        { toolUseId: 'completed-first', content: 'Immediate output', isError: false },
        { toolUseId: 'failed-command', content: 'Shell failed', isError: true },
      ]
      expect(client.events.slice(offset).filter(event => event.type === 'tool_result')).toMatchObject(expected)
      const { messages } = await api<{ messages: MessageEntry[] }>(`/api/sessions/${sessionId}/messages`)
      expect(messages.filter(message => message.type === 'tool_result')).toMatchObject(expected.map(result => ({
        content: [{ type: 'tool_result', tool_use_id: result.toolUseId, content: result.content, is_error: result.isError }],
      })))
    })
  }, 15_000)

  test('keeps a fixed-choice question pending when given a non-option answer', async () => {
    await withFixture('fixed-options', async ({ wire, connect, createSession }) => {
      const { sessionId } = await createSession()
      const client = await connect(sessionId)
      await selectRuntime(client)
      const offset = client.events.length
      client.send({ type: 'user_message', content: 'Ask a fixed-choice question' })
      const request = await client.wait('permission_request', offset)
      expect(request.input).toMatchObject({ allowFreeText: false })
      const invalid = client.events.length
      const answer = (text: string) => client.send({ type: 'permission_response', requestId: request.requestId, allowed: true,
        rule: 'once', updatedInput: { answers: { 'Pick a platform': text } } })
      answer('Both')
      expect(await client.wait('error', invalid)).toMatchObject({ code: 'PERMISSION_RESPONSE_INVALID', permissionRequestId: request.requestId })
      expect((await wire()).filter(entry => entry.id === 'question-permission')).toEqual([])
      const after = client.events.length
      answer('Web')
      await client.wait('message_complete', after)
      expect((await wire()).filter(entry => entry.id === 'question-permission')).toMatchObject([
        { result: { outcome: { outcome: 'selected', optionId: 'web' } } },
      ])
    })
  }, 15_000)

  test('turns the native pending ask_question into a card whose selection resumes the same tool', async () => {
    await withFixture('prompt-options', async ({ api, wire, connect, createSession }) => {
      const { sessionId } = await createSession()
      const client = await connect(sessionId)
      await selectRuntime(client)
      const offset = client.events.length
      client.send({ type: 'user_message', content: 'Ask a native question' })
      const request = await client.wait('permission_request', offset)
      expect(request).toMatchObject({ toolName: 'AskUserQuestion', toolUseId: 'call_native_question', input: {
        allowFreeText: false, questions: [{ question: 'Pick a platform', multiSelect: false, options: [{ label: 'Web' }, { label: 'Desktop' }] }],
      } })
      expect(client.events.slice(offset).filter(event => event.type === 'content_delta').map(event => event.text)).toEqual(['I need one choice first.'])
      expect(client.events.slice(offset).some(event => event.type === 'message_complete')).toBe(false)

      // 重连仍能选答；卡片待回复时，普通消息不能误当作答案。
      const second = await connect(sessionId)
      expect(await second.wait('permission_request')).toMatchObject({ requestId: request.requestId })
      const afterConnect = second.events.length
      second.send({ type: 'user_message', content: 'An unrelated prompt' })
      expect(await second.wait('error', afterConnect)).toMatchObject({ code: 'ANTIGRAVITY_TURN_BUSY' })
      const answer = (value: string) => second.send({ type: 'permission_response', requestId: request.requestId,
        allowed: true, rule: 'once', updatedInput: { answers: { 'Pick a platform': value } } })
      const beforeAnswer = second.events.length
      answer('Both')
      expect(await second.wait('error', beforeAnswer)).toMatchObject({ code: 'PERMISSION_RESPONSE_INVALID' })
      const firstPrompt = (await wire()).filter(entry => entry.method === 'session/prompt')
      expect(firstPrompt).toHaveLength(1)
      const after = second.events.length
      answer('Desktop')
      await second.wait('message_complete', after)
      expect(second.events.slice(after)).toContainEqual(expect.objectContaining({
        type: 'tool_result', toolUseId: 'call_native_question', content: { answers: { 'Pick a platform': 'Desktop' } }, isError: false,
      }))
      const calls = (await wire()).filter(entry => entry.method === 'session/prompt')
      expect(calls.map(entry => ({ pid: entry.pid, params: entry.params }))).toEqual([
        { pid: firstPrompt[0]!.pid, params: { sessionId: nativeId, prompt: [textBlock('Ask a native question')] } },
        { pid: firstPrompt[0]!.pid, params: { sessionId: nativeId, prompt: [textBlock('2')] } },
      ])
      const { messages } = await api<{ messages: MessageEntry[] }>(`/api/sessions/${sessionId}/messages`)
      expect(messages.map(message => message.type)).toEqual(['user', 'assistant', 'tool_use', 'tool_result', 'assistant'])
      expect(messages[3]?.content).toMatchObject([{ content: { answers: { 'Pick a platform': 'Desktop' } } }])
      expect(messages.at(-1)?.content).toEqual([textBlock('Chosen: Desktop')])
    })
  }, 15_000)

  test('Stop cancels the pending native question without selecting an option', async () => {
    await withFixture('prompt-options', async ({ wire, connect, createSession }) => {
      const { sessionId } = await createSession()
      const client = await connect(sessionId)
      await selectRuntime(client)
      client.send({ type: 'user_message', content: 'Ask before stopping' })
      const request = await client.wait('permission_request')
      const offset = client.events.length
      client.send({ type: 'stop_generation' })
      expect(await client.wait('permission_resolved', offset)).toMatchObject({ requestId: request.requestId, permissionType: 'tool' })
      await client.wait('message_complete', offset)
      const after = client.events.length
      client.send({ type: 'user_message', content: 'Continue separately' })
      await client.wait('message_complete', after)
      expect(client.events.slice(after)).toContainEqual(expect.objectContaining({ type: 'content_delta', text: 'Independent follow-up' }))
      expect((await wire()).filter(entry => entry.method?.startsWith('session/') && entry.method !== 'session/new').map(entry => [entry.method, entry.params])).toEqual([
        ['session/prompt', { sessionId: nativeId, prompt: [textBlock('Ask before stopping')] }],
        ['session/cancel', { sessionId: nativeId }],
        ['session/prompt', { sessionId: nativeId, prompt: [textBlock('Continue separately')] }],
      ])
    })
  }, 15_000)

  test('preserves the existing SSH login environment in discovery and chat', async () => {
    await withFixture('ready', async ({ api, wire, connect, createSession }) => {
      expect(await api(discoverPath, {})).toMatchObject({ status: 'ready' })
      const { sessionId } = await createSession()
      const client = await connect(sessionId)
      await selectRuntime(client)
      await finishTurn(client, 'Prompt from an SSH server', 'one', true)
      expect((await wire()).filter(entry => entry.argv !== undefined)).toMatchObject([
        { hasSshConnection: true, hasAnthropicApiKey: false },
        { hasSshConnection: true, hasAnthropicApiKey: false },
      ])
    })
  }, 15_000)

  for (const { mode, code, status, calls } of [
    { mode: 'missing', code: 'ANTIGRAVITY_NOT_INSTALLED', status: 'not_installed', calls: [] },
    { mode: 'login', code: 'ANTIGRAVITY_LOGIN_REQUIRED', status: 'login_required', calls: ['initialize', 'session/new'] },
    { mode: 'malformed', code: 'ANTIGRAVITY_CONNECTION_FAILED', status: 'error', calls: ['initialize', 'session/new'] },
    { mode: 'unconfirmed-model', code: 'ANTIGRAVITY_MODEL_UNAVAILABLE', status: 'ready', calls: ['initialize', 'session/new', 'session/set_config_option'] },
  ] as const) {
    test(`${mode}: reports an ACP startup error without prompting or falling back`, async () => {
      await withFixture(mode, async ({ api, wire, connect, createSession }) => {
        expect(await api(discoverPath, {})).toMatchObject({ status })
        if (mode === 'login' || mode === 'missing') {
          expect(await api(authPath)).toMatchObject({ hasAuth: false, localAgentStatus: status })
        }
        expect(methods(await wire())).toEqual(calls.filter(method => method !== 'session/set_config_option'))
        const offset = (await wire()).length
        const { sessionId, transcript } = await createSession()
        const client = await connect(sessionId)
        await selectRuntime(client, mode === 'unconfirmed-model' ? 'model-b' : defaultModel)
        const after = client.events.length
        client.send({ type: 'user_message', content: 'This must never reach an agent' })
        const error = await client.wait('error', after)
        expect(error.code).toBe(code)
        if (mode === 'login') {
          expect(error.message).toContain('agy acp --login')
          expect(error.message).not.toContain('fixture-login-link')
        }
        expect(methods((await wire()).slice(offset))).toEqual(calls)
        expect(await api(`/api/sessions/${sessionId}/messages`)).toMatchObject({ messages: [] })
        expect(await readFile(transcript, 'utf8')).not.toContain('antigravitySessionId')
      })
    }, 15_000)
  }
})
