import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { startMockLlmServer } from '../../../scripts/quality-gate/mock-llm/server.js'

test('official SDK replacement turns stream tools and finish in chat after Stop without a replayed user frame', async () => {
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), 'cc-haha-sdk-stop-chat-')))
  const root = resolve(import.meta.dir, '../../..')
  const outputPath = join(sandbox, 'project', 'index.html')
  const model = startMockLlmServer(request => {
    const messages = JSON.stringify(request.messages)
    if (!request.tools?.some(tool => tool.name === 'Write')) {
      return { kind: 'message', stopReason: 'end_turn', content: [{ type: 'text', text: 'Offline auxiliary reply' }] }
    }
    if (messages.includes('OFFLINE_REPLACEMENT_HTML')) {
      const hasResult = request.messages?.some(message => Array.isArray(message.content) &&
        message.content.some(block => block.type === 'tool_result' && block.tool_use_id === 'replacement-html'))
      return hasResult
        ? { kind: 'message', stopReason: 'end_turn', content: [{ type: 'text', text: 'OFFLINE_HTML_COMPLETE' }] }
        : { kind: 'message', stopReason: 'tool_use', content: [
          { type: 'text', text: 'OFFLINE_HTML_PROGRESS' },
          { type: 'tool_use', id: 'replacement-html', name: 'Write', input: { file_path: outputPath, content: '<!doctype html><h1>Offline fixture</h1>' } },
        ] }
    }
    return {
      kind: 'message', stopReason: 'end_turn', chunkDelayMs: 100,
      content: [{ type: 'text', text: 'OFFLINE_WAIT_FOR_STOP\n'.repeat(100) }],
    }
  })
  const env = createSandboxedTestEnvironment(sandbox, {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
    ALL_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
  })
  const fixture = `
    import assert from 'node:assert/strict'
    import { mkdir, readFile } from 'node:fs/promises'
    import { join } from 'node:path'
    await (async () => {
      const root = ${JSON.stringify(root)}
      const { conversationService } = await import(root + '/src/server/services/conversationService.ts')
      const { sessionService } = await import(root + '/src/server/services/sessionService.ts')
      const { ProviderService } = await import(root + '/src/server/services/providerService.ts')
      const { CreateProviderSchema } = await import(root + '/src/server/types/provider.ts')
      const { handleWebSocket, getSessionTurnState, __resetWebSocketHandlerStateForTests } = await import(root + '/src/server/ws/handler.ts')
      const workDir = join(process.env.HOME, 'project')
      await mkdir(workDir)
      const provider = await new ProviderService().addProvider(CreateProviderSchema.parse({
        presetId: 'custom', name: 'Offline SDK Stop fixture', apiKey: 'fake-offline-key',
        baseUrl: 'https://api.anthropic.com', apiFormat: 'anthropic',
        authStrategy: 'api_key', runtime: 'agent-sdk',
        models: { main: 'claude-haiku-5-5', haiku: '', sonnet: '', opus: '' },
      }))
      const { sessionId } = await sessionService.createSession(workDir, undefined, 'bypassPermissions')
      await sessionService.renameSession(sessionId, 'Offline Stop regression')
      await sessionService.appendSessionMetadata(sessionId, {
        workDir, runtimeProviderId: provider.id, runtimeModelId: 'claude-haiku-5-5', effortLevel: 'low',
      })
      // Run the production host, bridge and SDK against a loopback model. No
      // saved provider, user settings, transcript or network credential is used.
      const buildChildEnv = conversationService.buildChildEnv.bind(conversationService)
      conversationService.buildChildEnv = async (...args) => ({
        ...await buildChildEnv(...args), ANTHROPIC_BASE_URL: ${JSON.stringify(model.url)},
      })
      const native = []
      const chat = []
      const transport = Bun.serve({
        hostname: '127.0.0.1', port: 0,
        fetch(request, server) {
          const url = new URL(request.url)
          const channel = url.pathname.startsWith('/sdk/') ? 'sdk' : 'client'
          if (url.pathname !== '/' + (channel === 'sdk' ? 'sdk' : 'chat') + '/' + sessionId) return new Response('missing', { status: 404 })
          return server.upgrade(request, { data: {
            sessionId, channel, sdkToken: url.searchParams.get('token'),
            serverHost: '127.0.0.1', serverPort: server.port, connectedAt: Date.now(),
          } }) ? undefined : new Response('upgrade failed', { status: 400 })
        },
        websocket: {
          open: ws => handleWebSocket.open(ws),
          close: ws => handleWebSocket.close(ws),
          message(ws, payload) {
            if (ws.data.channel === 'sdk') {
              for (const line of String(payload).split('\\n').filter(Boolean)) native.push(JSON.parse(line))
            }
            handleWebSocket.message(ws, payload)
          },
        },
      })
      const client = new WebSocket('ws://127.0.0.1:' + transport.port + '/chat/' + sessionId)
      client.onmessage = event => chat.push(JSON.parse(String(event.data)))
      async function waitFor(predicate, label) {
        const deadline = Date.now() + 20_000
        while (!predicate()) {
          if (Date.now() > deadline) throw new Error(label + ': ' + JSON.stringify({
            chat, native: native.map(event => ({ type: event.type, subtype: event.subtype,
              event: event.event?.type, isReplay: event.isReplay, user_message_uuid: event.user_message_uuid })),
          }))
          await Bun.sleep(20)
        }
      }
      try {
        await waitFor(() => chat.some(event => event.type === 'connected'), 'connect')
        client.send(JSON.stringify({ type: 'user_message', content: 'OFFLINE_INITIAL_LONG_TURN' }))
        await waitFor(() => chat.some(event => event.type === 'content_delta' && event.text?.includes('OFFLINE_WAIT_FOR_STOP')), 'first stream')
        client.send(JSON.stringify({ type: 'stop_generation' }))
        await waitFor(() => native.some(event => event.type === 'result'), 'interrupted result')
        await waitFor(() => getSessionTurnState(sessionId) === 'idle', 'stopped turn idle')
        await waitFor(() => chat.some(event => event.type === 'message_complete'), 'stopped chat completion')
        const nativeBoundary = native.length
        const chatBoundary = chat.length
        client.send(JSON.stringify({ type: 'user_message', content: 'OFFLINE_REPLACEMENT_HTML' }))
        await waitFor(() => native.slice(nativeBoundary).some(event => event.type === 'result'), 'replacement native completion')
        // This is the reported split: the file and durable answer exist even
        // when the renderer receives no progress or completion after Stop.
        assert.match(await readFile(${JSON.stringify(outputPath)}, 'utf8'), /Offline fixture/)
        const history = await sessionService.getSessionMessages(sessionId, { includeSubagents: false })
        assert.ok(JSON.stringify(history).includes('OFFLINE_HTML_COMPLETE'))
        const replies = native.slice(nativeBoundary)
        assert.ok(replies.some(event => typeof event.user_message_uuid === 'string'))
        assert.equal(replies.filter(event => event.type === 'user' && event.isReplay).length, 0)
        // SDK and chat use separate sockets; observing the SDK's result does
        // not synchronously dispatch the renderer's completion callback.
        await waitFor(() => chat.slice(chatBoundary).some(event => event.type === 'message_complete'), 'replacement chat completion')
        const visible = chat.slice(chatBoundary)
        assert.ok(visible.some(event => event.type === 'content_delta' && event.text?.includes('OFFLINE_HTML_PROGRESS')), 'missing live progress despite successful HTML write')
        assert.ok(visible.some(event => event.type === 'tool_use_complete' && event.toolName === 'Write'), 'missing live Write')
        assert.ok(visible.some(event => event.type === 'tool_result'), 'missing tool result')
        assert.ok(visible.some(event => event.type === 'content_delta' && event.text?.includes('OFFLINE_HTML_COMPLETE')), 'missing final answer')
        assert.ok(visible.some(event => event.type === 'message_complete'), 'chat stuck thinking after native completion')
        assert.equal(getSessionTurnState(sessionId), 'idle')
        console.log('SDK_STOP_CHAT:' + JSON.stringify({ fileWritten: true, liveProgress: true,
          completed: true, replayedUsers: replies.filter(event => event.type === 'user' && event.isReplay).length }))
      } finally {
        client.close()
        await conversationService.stopAllSessionsAndWait(1_000)
        __resetWebSocketHandlerStateForTests()
        await transport.stop(true)
      }
    })()
  `
  const child = Bun.spawn([
    process.execPath, '--no-env-file',
    `--config=${join(root, 'src/entrypoints/officialAgentSdk.bunfig.toml')}`, '--eval', fixture,
  ], { cwd: sandbox, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const timeout = setTimeout(() => child.kill(), 60_000)
  try {
    const code = await child.exited
    const output = await stdout
    const errors = await stderr
    if (code !== 0) throw new Error(`SDK Stop chat fixture exited ${code}\n${output}\n${errors}`)
    expect(output).toContain('SDK_STOP_CHAT:')
    expect(model.requests.some(request => request.outcome === 'cancelled')).toBe(true)
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill()
    await child.exited
    await model.stop()
    await rm(sandbox, { recursive: true, force: true })
  }
}, 70_000)
