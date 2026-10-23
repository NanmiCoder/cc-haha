import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { startMockLlmServer } from '../../../scripts/quality-gate/mock-llm/server.js'
import type { MockRequest } from '../../../scripts/quality-gate/mock-llm/scriptedModel.js'

function lastPrompt(request: MockRequest): { text: string; toolResults: unknown[] } {
  let text = ''
  let toolResults: unknown[] = []
  for (const message of request.messages ?? []) {
    if (message.role !== 'user') continue
    for (const block of typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? []) {
      if (block.type === 'text' && block.text?.includes('OFFLINE_SDK_')) {
        text = block.text
        toolResults = []
      }
      if (block.type === 'tool_result') toolResults.push(block)
    }
  }
  return { text, toolResults }
}

test('official SDK native runtime executes approved tools, denies unapproved tools, streams and resumes through the desktop bridge', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'cc-haha-official-sdk-'))
  const workDir = join(sandbox, 'project')
  await mkdir(workDir)
  const deniedPath = join(workDir, 'denied.txt')
  const approvedPath = join(workDir, 'approved.txt')
  const sessionId = crypto.randomUUID()
  const noHistorySessionId = crypto.randomUUID()
  const events: Record<string, any>[] = []
  const model = startMockLlmServer(request => {
    const turn = lastPrompt(request)
    if (turn.text.includes('OFFLINE_SDK_DENY') && turn.toolResults.length === 0) {
      return { kind: 'message', stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_offline_deny', name: 'Write', input: { file_path: deniedPath, content: 'must not be written' } }] }
    }
    if (turn.text.includes('OFFLINE_SDK_ALLOW') && turn.toolResults.length === 0) {
      return { kind: 'message', stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_offline_allow', name: 'Write', input: { file_path: approvedPath, content: 'approved fixture\n' } }] }
    }
    return { kind: 'message', stopReason: 'end_turn', content: [{ type: 'text', text: turn.text.includes('OFFLINE_SDK_BTW') ? 'Side question fixture answer.' : turn.text.includes('OFFLINE_SDK_RESUME') ? 'Resumed fixture history.' : 'Fixture turn complete.' }] }
  })
  let socket: ServerWebSocket<{}> | undefined
  let changed: (() => void) | undefined
  const server = Bun.serve<{}>({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      if ([`/sdk/${sessionId}`, `/sdk/${noHistorySessionId}`].includes(url.pathname) && url.searchParams.get('token') === 'offline-fixture' && server.upgrade(request, { data: {} })) return
      return new Response('unauthorized', { status: 401 })
    },
    websocket: {
      open(ws) { socket = ws; changed?.() },
      close(ws) { if (socket === ws) socket = undefined; changed?.() },
      message(ws, data) {
        for (const line of data.toString().split('\n').filter(Boolean)) {
          const event = JSON.parse(line)
          events.push(event)
          if (event.type === 'control_request' && event.request?.subtype === 'can_use_tool') {
            const allow = event.request.input?.file_path === approvedPath
            ws.send(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: allow ? { behavior: 'allow', updatedInput: event.request.input } : { behavior: 'deny', message: 'Fixture user declined' } } }))
          }
          changed?.()
        }
      },
    },
  })
  const env = createSandboxedTestEnvironment(sandbox, {
    ANTHROPIC_API_KEY: 'fake-offline-sdk-key',
    ANTHROPIC_BASE_URL: model.url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: 'http://127.0.0.1:1',
    HTTPS_PROXY: 'http://127.0.0.1:1',
    ALL_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  })
  const children: ReturnType<typeof Bun.spawn>[] = []
  const outputs: Promise<string>[] = []
  const launch = (resume: boolean, persist = true) => {
    const id = persist ? sessionId : noHistorySessionId
    const child = Bun.spawn([
      process.execPath, '--no-env-file', 'run', resolve(import.meta.dir, '../../entrypoints/officialAgentSdk.ts'),
      '--sdk-url', `ws://127.0.0.1:${server.port}/sdk/${id}?token=offline-fixture`,
      resume ? '--resume' : '--session-id', id,
      '--model', 'claude-sonnet-5-5', '--permission-mode', 'default',
      ...(!persist ? ['--no-session-persistence'] : []),
    ], { cwd: workDir, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    children.push(child)
    outputs.push(new Response(child.stderr).text())
    outputs.push(new Response(child.stdout).text())
    void child.exited.then(() => changed?.())
    return child
  }
  async function waitFor(predicate: () => boolean, child: ReturnType<typeof Bun.spawn>): Promise<void> {
    const deadline = Date.now() + 20_000
    while (!predicate()) {
      if (child.exitCode !== null) throw new Error(`Offline official SDK exited: ${(await Promise.all(outputs)).join('\n')}`)
      if (Date.now() > deadline) throw new Error(`Offline official SDK timed out; events: ${events.map(event => `${event.type}:${event.subtype ?? ''}`).join(', ')}`)
      await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, 100)
        changed = () => { clearTimeout(timeout); resolve() }
      })
      changed = undefined
    }
  }
  function sendPrompt(text: string): void {
    socket!.send(JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: text } }))
  }
  try {
    const first = launch(false)
    await waitFor(() => Boolean(socket), first)
    sendPrompt('OFFLINE_SDK_DENY')
    await waitFor(() => events.filter(event => event.type === 'result').length >= 1, first)
    expect(existsSync(deniedPath)).toBe(false)
    expect(events.some(event => event.type === 'control_request' && event.request?.input?.file_path === deniedPath)).toBe(true)
    sendPrompt('OFFLINE_SDK_ALLOW')
    await waitFor(() => events.filter(event => event.type === 'result').length >= 2, first)
    expect(await readFile(approvedPath, 'utf8')).toBe('approved fixture\n')
    expect(events.some(event => event.type === 'stream_event')).toBe(true)
    expect(events.some(event => event.type === 'system' && event.subtype === 'init' && event.session_id === sessionId)).toBe(true)
    await waitFor(() => events.some(event => event.type === 'system' && event.subtype === 'session_state_changed' && event.state === 'idle'), first)
    expect(events.some(event => event.type === 'system' && event.subtype === 'session_state_changed' && event.state === 'running')).toBe(true)
    socket!.send(JSON.stringify({ type: 'control_request', request_id: 'usage-fixture', request: { subtype: 'get_session_usage' } }))
    await waitFor(() => events.some(event => event.response?.request_id === 'usage-fixture'), first)
    const usage = events.find(event => event.response?.request_id === 'usage-fixture')!.response
    expect(usage.subtype).toBe('success')
    expect(usage.response.totalInputTokens).toBeGreaterThan(0)
    socket!.send(JSON.stringify({ type: 'control_request', request_id: 'btw-fixture', request: { subtype: 'side_question', question_id: crypto.randomUUID(), question: 'OFFLINE_SDK_BTW', history: [] } }))
    await waitFor(() => events.some(event => event.response?.request_id === 'btw-fixture'), first)
    const btw = events.find(event => event.response?.request_id === 'btw-fixture')!.response
    expect(btw).toMatchObject({ subtype: 'success', response: { response: 'Side question fixture answer.' } })
    expect(events.filter(event => event.type === 'result')).toHaveLength(2)
    const sideRequest = model.requests.find(request => lastPrompt(request.body).text.includes('OFFLINE_SDK_BTW'))
    expect(JSON.stringify(sideRequest!.body.messages)).toContain('OFFLINE_SDK_ALLOW')
    expect(JSON.stringify(sideRequest!.body.messages)).toContain('OFFLINE_SDK_DENY')
    socket!.send(JSON.stringify({ type: 'control_request', request_id: 'end-first', request: { subtype: 'end_session', reason: 'data_migration' } }))
    await first.exited
    expect(first.exitCode).toBe(0)
    expect(events.some(event => event.type === 'control_response' && event.response?.request_id === 'end-first' && event.response?.subtype === 'success')).toBe(true)

    const requestCount = model.requests.length
    const resumed = launch(true)
    await waitFor(() => Boolean(socket), resumed)
    sendPrompt('OFFLINE_SDK_RESUME')
    await waitFor(() => events.filter(event => event.type === 'result').length >= 3, resumed)
    const resumeRequest = model.requests.slice(requestCount).find(request => lastPrompt(request.body).text.includes('OFFLINE_SDK_RESUME'))
    expect(resumeRequest).toBeDefined()
    expect(JSON.stringify(resumeRequest!.body.messages)).toContain('OFFLINE_SDK_DENY')
    expect(JSON.stringify(resumeRequest!.body.messages)).toContain('OFFLINE_SDK_ALLOW')
    expect(events.filter(event => event.type === 'result').every(event => event.session_id === sessionId && event.is_error === false)).toBe(true)
    socket!.close()
    await resumed.exited
    expect(resumed.exitCode).toBe(0)

    const noHistory = launch(false, false)
    await waitFor(() => Boolean(socket), noHistory)
    sendPrompt('OFFLINE_SDK_NO_HISTORY')
    await waitFor(() => events.some(event => event.type === 'result' && event.session_id === noHistorySessionId), noHistory)
    socket!.send(JSON.stringify({ type: 'control_request', request_id: 'end-private', request: { subtype: 'end_session' } }))
    await noHistory.exited
    expect(noHistory.exitCode).toBe(0)

    // The desktop's own history reader must understand the native transcript,
    // not just the official SDK that wrote it. Run it in a separate sandboxed
    // process so its configuration caches cannot read this test runner's home.
    const reader = Bun.spawn([
      process.execPath, '--no-env-file', '--eval',
      `import { SessionService } from ${JSON.stringify(resolve(import.meta.dir, 'sessionService.ts'))}
       const service = new SessionService()
       const launch = await service.getSessionLaunchInfo(${JSON.stringify(sessionId)})
       const privateLaunch = await service.getSessionLaunchInfo(${JSON.stringify(noHistorySessionId)})
       const messages = await service.getSessionMessages(${JSON.stringify(sessionId)}, { includeSubagents: false })
       console.log('OFFICIAL_SDK_HISTORY:' + JSON.stringify({ launch, privateLaunch, messages }))`,
    ], { cwd: resolve(import.meta.dir, '../../..'), env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    children.push(reader)
    const readerOut = new Response(reader.stdout).text()
    const readerError = new Response(reader.stderr).text()
    outputs.push(readerOut, readerError)
    const readerTimeout = setTimeout(() => reader.kill(), 10_000)
    try {
      expect(await reader.exited).toBe(0)
      const historyLine = (await readerOut).split('\n').find(line => line.startsWith('OFFICIAL_SDK_HISTORY:'))
      if (!historyLine) throw new Error(`Desktop history reader failed: ${await readerError}`)
      const history = JSON.parse(historyLine.slice('OFFICIAL_SDK_HISTORY:'.length))
      expect(history.launch.transcriptMessageCount).toBeGreaterThan(0)
      expect(history.launch.workDir).toBeTruthy()
      expect(history.privateLaunch).toBeNull()
      expect(JSON.stringify(history.messages)).toContain('OFFLINE_SDK_DENY')
      expect(JSON.stringify(history.messages)).toContain('OFFLINE_SDK_ALLOW')
      expect(JSON.stringify(history.messages)).toContain('OFFLINE_SDK_RESUME')
      expect(JSON.stringify(history.messages)).not.toContain('OFFLINE_SDK_BTW')
    } finally {
      clearTimeout(readerTimeout)
    }
  } finally {
    socket?.close()
    for (const child of children) if (child.exitCode === null) child.kill()
    await Promise.all(children.map(child => child.exited))
    await model.stop()
    await server.stop(true)
    await rm(sandbox, { recursive: true, force: true })
  }
}, 60_000)
