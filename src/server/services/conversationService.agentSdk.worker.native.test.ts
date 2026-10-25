import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { startMockLlmServer } from '../../../scripts/quality-gate/mock-llm/server.js'

// Only the remote model is replaced: desktop startup, native SDK, saved preset
// hooks, registered MCP tools and the shared mailbox all run their real paths.
test('desktop SDK team workers retain the selected preset, native tool limits, hooks and shared team tools', async () => {
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), 'cc-haha-sdk-worker-')))
  const root = resolve(import.meta.dir, '../../..')
  const workDir = join(sandbox, 'project')
  const deniedPath = join(workDir, 'must-not-write.txt')
  const model = startMockLlmServer(request => {
    const results = (request.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === 'tool_result')
    if (!request.tools?.some(tool => tool.name === 'Write') || !JSON.stringify(request.messages).includes('OFFLINE_SDK_WORKER')) return { kind: 'message', stopReason: 'end_turn', content: [{ type: 'text', text: 'Offline auxiliary response.' }] }
    if (!results.some(block => block.tool_use_id === 'worker-list')) return { kind: 'message', stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'worker-list', name: 'mcp__cc_haha__TaskList', input: {} }] }
    if (!results.some(block => block.tool_use_id === 'worker-send')) return { kind: 'message', stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'worker-send', name: 'SendMessage', input: { to: 'team-lead', message: 'OFFLINE_SHARED_MAILBOX_RESULT' } }] }
    if (!results.some(block => block.tool_use_id === 'worker-blocked')) return { kind: 'message', stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'worker-blocked', name: 'Write', input: { file_path: deniedPath, content: 'must be blocked by selected preset' } }] }
    return { kind: 'message', stopReason: 'end_turn', content: [{ type: 'text', text: 'OFFLINE_WORKER_COMPLETE' }] }
  })
  const env = createSandboxedTestEnvironment(sandbox, {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', ENABLE_TOOL_SEARCH: 'false',
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
  })
  const fixture = `
    import assert from 'node:assert/strict'
    import { existsSync } from 'node:fs'
    import { mkdir, readFile, writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    await (async () => {
      const root = ${JSON.stringify(root)}
      const { ConversationService } = await import(root + '/src/server/services/conversationService.ts')
      const { sessionService } = await import(root + '/src/server/services/sessionService.ts')
      const { ProviderService } = await import(root + '/src/server/services/providerService.ts')
      const { CreateProviderSchema } = await import(root + '/src/server/types/provider.ts')
      const { writeTeamFileAsync } = await import(root + '/src/utils/swarm/teamHelpers.ts')
      const { readMailboxHistory } = await import(root + '/src/utils/teammateMailbox.ts')
      const { beginTaskListLifecycle, createTask, getCanonicalTeamTaskListId } = await import(root + '/src/utils/tasks.ts')
      const workDir = ${JSON.stringify(workDir)}
      await mkdir(workDir)
      const workerId = crypto.randomUUID()
      const parentId = crypto.randomUUID()
      const teamName = 'native-worker-fixture'
      const now = Date.now()
      const listId = getCanonicalTeamTaskListId(teamName)
      await beginTaskListLifecycle(listId, { teamName, createdAt: now, leadSessionId: parentId })
      await writeTeamFileAsync(teamName, {
        name: teamName, createdAt: now, leadSessionId: parentId, leadAgentId: 'team-lead@' + teamName, reviewRequired: true,
        members: [
          { agentId: 'team-lead@' + teamName, name: 'team-lead', agentType: 'team-lead', joinedAt: now, cwd: workDir, tmuxPaneId: '', subscriptions: [] },
          { agentId: 'worker@' + teamName, name: 'worker', agentType: 'fixture-preset', sessionId: workerId, backendType: 'process', joinedAt: now, cwd: workDir, tmuxPaneId: '', subscriptions: [] },
        ],
      })
      await createTask(listId, { subject: 'OFFLINE_SHARED_TASK', description: 'Native shared task fixture', status: 'pending', blocks: [], blockedBy: [] })
      const provider = await new ProviderService().addProvider(CreateProviderSchema.parse({
        presetId: 'custom', name: 'Offline SDK worker fixture', apiKey: 'fake-offline-worker-key',
        baseUrl: 'https://api.anthropic.com', apiFormat: 'anthropic', authStrategy: 'api_key', runtime: 'agent-sdk',
        models: { main: 'claude-haiku-5-5', haiku: 'claude-haiku-5-5', sonnet: '', opus: '' },
      }))
      const hookFile = join(workDir, 'preset-hook-ran.txt')
      const hookScript = join(workDir, 'preset-hook.ts')
      await writeFile(hookScript, 'import { writeFileSync } from "node:fs"; writeFileSync(' + JSON.stringify(hookFile) + ', "preset hook ran"); console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"OFFLINE_PRESET_WRITE_DENIED"}}))')
      const service = new ConversationService()
      const buildChildEnv = service.buildChildEnv.bind(service)
      service.buildChildEnv = async (...args) => ({ ...await buildChildEnv(...args), ANTHROPIC_BASE_URL: ${JSON.stringify(model.url)} })
      const events = []
      const transport = Bun.serve({ hostname: '127.0.0.1', port: 0,
        fetch(request, server) {
          const url = new URL(request.url)
          const id = url.pathname.split('/').pop()
          if (!service.authorizeSdkConnection(id, url.searchParams.get('token'))) return new Response('denied', { status: 401 })
          return server.upgrade(request, { data: { id } }) ? undefined : new Response('failed', { status: 400 })
        }, websocket: {
          open(ws) { service.attachSdkConnection(ws.data.id, ws) },
          message(ws, payload) {
            for (const line of String(payload).split('\\n').filter(Boolean)) events.push(JSON.parse(line))
            service.handleSdkPayload(ws.data.id, String(payload))
          },
          close(ws) { service.detachSdkConnection(ws.data.id, ws) },
        },
      })
      try {
        await service.startSession(workerId, workDir, 'ws://127.0.0.1:' + transport.port + '/sdk/' + workerId + '?token=offline-worker-fixture', {
          providerId: provider.id, model: 'claude-haiku-5-5', effort: 'low', permissionMode: 'bypassPermissions',
          teamWorker: {
            parentSessionId: parentId, teamName, memberId: 'worker', name: 'worker',
            systemPrompt: 'OFFLINE_WORKER_PRESET_INSTRUCTIONS: selected reviewed worker instructions.', tools: ['Write'],
            agentDefinition: { disallowedTools: ['Bash'], maxTurns: 8, hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: JSON.stringify(process.execPath) + ' ' + JSON.stringify(hookScript) }] }] } },
          },
        })
        assert.equal(service.isTeamWorkerSession(workerId), true)
        assert.equal(await service.sendMessage(workerId, 'OFFLINE_SDK_WORKER'), true)
        const deadline = Date.now() + 30_000
        while (!events.some(event => event.type === 'result')) {
          const running = service.sessions.get(workerId)
          if (!running || running.proc.exitCode !== null) throw new Error('Native worker exited: ' + JSON.stringify(events) + '\\n' + (running?.stderrLines ?? []).join('\\n'))
          if (Date.now() > deadline) throw new Error('Native worker timed out: ' + JSON.stringify(events))
          await Bun.sleep(25)
        }
        const result = events.find(event => event.type === 'result')
        assert.equal(result.is_error, false)
        assert.equal(result.result, 'OFFLINE_WORKER_COMPLETE')
        assert.equal(existsSync(${JSON.stringify(deniedPath)}), false)
        assert.equal(await readFile(hookFile, 'utf8'), 'preset hook ran')
        const mailbox = await readMailboxHistory('team-lead', teamName)
        assert.ok(mailbox.some(message => message.from === 'worker' && message.text === 'OFFLINE_SHARED_MAILBOX_RESULT'))
        const calls = events.filter(event => event.type === 'assistant').flatMap(event => event.message.content).filter(block => block.type === 'tool_use')
        assert.ok(calls.some(block => block.name === 'TaskList'))
        assert.ok(calls.some(block => block.name === 'SendMessage'))
        const proc = service.sessions.get(workerId).proc
        service.sendSdkMessage(workerId, { type: 'control_request', request_id: 'finish-worker', request: { subtype: 'end_session' } })
        assert.equal(await proc.exited, 0)
        await service.stopSessionAndWait(workerId)
        const history = await sessionService.getSessionMessages(workerId, { includeSubagents: false })
        assert.ok(JSON.stringify(history).includes('OFFLINE_SHARED_TASK'))
        assert.ok(JSON.stringify(history).includes('OFFLINE_PRESET_WRITE_DENIED'))
        console.log('OFFICIAL_SDK_WORKER:' + JSON.stringify({ mailboxDelivered: true, hookDenied: true, nativeResult: result.result }))
      } finally {
        await service.stopAllSessionsAndWait(1_000)
        await transport.stop(true)
      }
    })()
  `
  const child = Bun.spawn([process.execPath, '--no-env-file', `--config=${join(root, 'src/entrypoints/officialAgentSdk.bunfig.toml')}`, '--eval', fixture], {
    cwd: sandbox, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const timeout = setTimeout(() => child.kill(), 60_000)
  try {
    const code = await child.exited
    const output = await stdout
    const errors = await stderr
    if (code !== 0) throw new Error(`Native SDK worker fixture exited ${code}\n${output}\n${errors}\n${JSON.stringify(model.requests.map(item => item.body.messages)).slice(-18000)}`)
    expect(output).toContain('OFFICIAL_SDK_WORKER:')
    const request = model.requests.find(item => item.body.tools?.some(tool => tool.name === 'Write') && JSON.stringify(item.body.messages).includes('OFFLINE_SDK_WORKER'))!.body
    expect(JSON.stringify(request.system)).toContain('OFFLINE_WORKER_PRESET_INSTRUCTIONS')
    const tools = request.tools?.map(tool => tool.name) ?? []
    expect(tools).toContain('Write')
    expect(tools).not.toContain('Bash')
    expect(tools).not.toContain('Read')
    expect(tools).toContain('mcp__cc_haha__TaskList')
    expect(tools).toContain('mcp__cc_haha__SendMessage')
    const wire = JSON.stringify(model.requests.map(item => item.body.messages))
    expect(wire).toContain('OFFLINE_SHARED_TASK')
    expect(wire).toContain('OFFLINE_PRESET_WRITE_DENIED')
    expect(model.requests.every(item => item.body.model === 'claude-haiku-5-5')).toBe(true)
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill()
    await child.exited
    await model.stop()
    await rm(sandbox, { recursive: true, force: true })
  }
}, 70_000)
