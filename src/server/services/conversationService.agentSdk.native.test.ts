import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { startMockLlmServer } from '../../../scripts/quality-gate/mock-llm/server.js'

// Keep the host in a fresh process: SessionService and the provider/network
// services must resolve every path from the fixture HOME, before import time.
async function runNativeHostFixture(scenario: 'turns' | 'concurrent' | 'restore-failure' | 'delete-during-stage'): Promise<void> {
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), 'cc-haha-sdk-host-')))
  const root = resolve(import.meta.dir, '../../..')
  const model = startMockLlmServer(() => ({
    kind: 'message', stopReason: 'end_turn',
    content: [{ type: 'text', text: 'OFFLINE_SDK_HOST_OK' }],
  }))
  const env = createSandboxedTestEnvironment(sandbox, {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
    ALL_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
  })
  const fixture = `
    import assert from 'node:assert/strict'
    import { mkdirSync } from 'node:fs'
    import { appendFile, mkdir, readFile } from 'node:fs/promises'
    import { join } from 'node:path'
    await (async () => {
    const root = ${JSON.stringify(root)}
    const scenario = ${JSON.stringify(scenario)}
    const { ConversationService } = await import(root + '/src/server/services/conversationService.ts')
    const { sessionService } = await import(root + '/src/server/services/sessionService.ts')
    const { ProviderService } = await import(root + '/src/server/services/providerService.ts')
    const { CreateProviderSchema } = await import(root + '/src/server/types/provider.ts')
    const { readConversationRuntime } = await import(root + '/src/server/services/officialAgentSdkRuntime.ts')
    const workDir = join(process.env.HOME, 'project')
    await mkdir(workDir)
    const provider = await new ProviderService().addProvider(CreateProviderSchema.parse({
      presetId: 'custom', name: 'Offline SDK host fixture', apiKey: 'fake-offline-sdk-key',
      baseUrl: 'https://api.anthropic.com', apiFormat: 'anthropic',
      authStrategy: 'api_key', runtime: 'agent-sdk',
      models: { main: 'claude-sonnet-5-5', haiku: '', sonnet: '', opus: '' },
    }))
    const created = await sessionService.createSession(workDir, undefined, 'default')
    const { sessionId } = created
    await sessionService.renameSession(sessionId, 'SDK placeholder title')
    await sessionService.appendSessionMetadata(sessionId, {
      workDir, runtimeProviderId: provider.id, runtimeModelId: 'claude-sonnet-5-5',
      effortLevel: 'low',
    })
    const before = await sessionService.getSessionLaunchInfo(sessionId)
    await appendFile(before.filePath, JSON.stringify({ type: 'session-meta', isMeta: true, fixtureExtension: { preserved: true } }) + '\\n')
    assert.equal(before.transcriptMessageCount, 0)
    assert.equal(before.customTitle, 'SDK placeholder title')
    assert.match(await readFile(before.filePath, 'utf8'), /file-history-snapshot/)
    const service = new ConversationService()
    // Preserve the complete production launch, provider and networking path.
    // Only replace its validated official endpoint with the loopback model.
    let failInitialization = false
    const buildChildEnv = service.buildChildEnv.bind(service)
    service.buildChildEnv = async (...args) => ({
      ...await buildChildEnv(...args), ANTHROPIC_BASE_URL: ${JSON.stringify(model.url)},
      ...(failInitialization ? { CC_HAHA_AGENT_SDK_EXECUTABLE: join(workDir, 'missing-sdk-executable') } : {}),
    })
    const events = []
    const transport = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch(request, server) {
        const url = new URL(request.url)
        const id = url.pathname.split('/').pop()
        if (!service.authorizeSdkConnection(id, url.searchParams.get('token'))) return new Response('denied', { status: 401 })
        return server.upgrade(request, { data: { id } }) ? undefined : new Response('failed', { status: 400 })
      },
      websocket: {
        open(ws) {
          if (scenario === 'restore-failure') mkdirSync(before.filePath)
          service.attachSdkConnection(ws.data.id, ws)
        },
        message(ws, payload) {
          for (const line of String(payload).split('\\n').filter(Boolean)) events.push(JSON.parse(line))
          service.handleSdkPayload(ws.data.id, String(payload))
        },
        close(ws) { service.detachSdkConnection(ws.data.id, ws) },
      },
    })
    async function waitFor(predicate) {
      const deadline = Date.now() + 20_000
      while (!predicate()) {
        const running = service.sessions.get(sessionId)
        if (!running || running.proc.exitCode !== null) {
          throw new Error('Native SDK host exited before result: ' + JSON.stringify(events) + '\\n' + (running?.stderrLines ?? []).join('\\n'))
        }
        if (Date.now() > deadline) throw new Error('Native SDK host timed out: ' + JSON.stringify(events))
        await Bun.sleep(20)
      }
    }
    const url = 'ws://127.0.0.1:' + transport.port + '/sdk/' + sessionId + '?token=offline-host-fixture'
    const options = { providerId: provider.id, model: 'claude-sonnet-5-5', effort: 'low', permissionMode: 'default' }
    async function send(text, resultCount) {
      assert.equal(await service.sendMessage(sessionId, text), true)
      await waitFor(() => events.filter(event => event.type === 'result').length >= resultCount)
      const result = events.filter(event => event.type === 'result').at(-1)
      assert.equal(result.subtype, 'success')
      assert.equal(result.is_error, false)
      assert.equal(result.session_id, sessionId)
      assert.equal(result.result, 'OFFLINE_SDK_HOST_OK')
    }
    const fsp = await import('node:fs/promises')
    const { spyOn, mock } = await import('bun:test')
    const unlink = fsp.unlink
    const spawn = Bun.spawn
    const spawned = []
    spyOn(Bun, 'spawn').mockImplementation((...args) => {
      const child = spawn(...args)
      if (Array.isArray(args[0]) && args[0].some(value => String(value).endsWith('/entrypoints/officialAgentSdk.ts'))) spawned.push(child)
      return child
    })
    try {
      if (scenario === 'concurrent' || scenario === 'delete-during-stage') {
        let stagedResolve, releaseResolve
        const stagedGate = new Promise(resolve => { stagedResolve = resolve })
        const releaseGate = new Promise(resolve => { releaseResolve = resolve })
        let paused = false
        spyOn(fsp, 'unlink').mockImplementation(async file => {
          await unlink(file)
          if (file === before.filePath && !paused) { paused = true; stagedResolve(); await releaseGate }
        })
        const first = service.startSession(sessionId, workDir, url, options)
        const firstOutcome = first.then(() => ({ status: 'fulfilled' }), error => ({ status: 'rejected', error }))
        await stagedGate
        if (scenario === 'delete-during-stage') {
          service.markSessionDeleted(sessionId)
          releaseResolve()
          const outcome = await firstOutcome
          assert.equal(outcome.status, 'rejected')
          assert.match(outcome.error.message, /Session was deleted before startup completed/)
          assert.equal(spawned.length, 0)
          assert.equal(service.hasSession(sessionId), false)
          console.log('OFFICIAL_SDK_STARTUP:' + JSON.stringify({ scenario, spawned: 0, rejected: true }))
          return
        }
        const second = service.startSession(sessionId, workDir, url, options)
        const secondOutcome = second.then(() => ({ status: 'fulfilled' }), error => ({ status: 'rejected', error }))
        // Hold the first pre-spawn filesystem operation while a second request
        // enters startup. With serialization, it must wait for the same launch.
        await Bun.sleep(150)
        const spawnedWhileStaged = spawned.length
        releaseResolve()
        const outcomes = await Promise.all([firstOutcome, secondOutcome])
        assert.equal(spawnedWhileStaged, 0)
        assert.deepEqual(outcomes.map(outcome => outcome.status), ['fulfilled', 'fulfilled'])
        assert.equal(spawned.length, 1)
        await send('OFFLINE_SDK_HOST_CONCURRENT', 1)
        console.log('OFFICIAL_SDK_STARTUP:' + JSON.stringify({ scenario, spawned: spawned.length, results: 1 }))
        return
      }
      if (scenario === 'restore-failure') {
        await assert.rejects(service.startSession(sessionId, workDir, url, options), /not a regular file/)
        assert.equal(service.hasSession(sessionId), false)
        assert.equal(spawned.length, 1)
        assert.notEqual(spawned[0].exitCode, null)
        const pending = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'cc-haha-sdk-startup', sessionId + '.jsonl')
        assert.match(await readFile(pending, 'utf8'), /SDK placeholder title/)
        console.log('OFFICIAL_SDK_STARTUP:' + JSON.stringify({ scenario, stopped: true, metadataPreserved: true }))
        return
      }
      const placeholderBeforeFailure = await readFile(before.filePath, 'utf8')
      failInitialization = true
      await assert.rejects(service.startSession(sessionId, workDir, url, options))
      assert.equal(await readFile(before.filePath, 'utf8'), placeholderBeforeFailure)
      assert.equal((await sessionService.getSessionLaunchInfo(sessionId)).customTitle, 'SDK placeholder title')
      assert.equal(service.getActiveSessions().includes(sessionId), false)
      failInitialization = false
      await service.startSession(sessionId, workDir, url, options)
      await send('OFFLINE_SDK_HOST_FIRST', 1)
      await send('OFFLINE_SDK_HOST_SECOND', 2)
      // Ask the SDK to drain its input and persist the native transcript before
      // reopening, exercising the same end-session wire request as the UI.
      const firstProcess = service.sessions.get(sessionId).proc
      service.sendSdkMessage(sessionId, { type: 'control_request', request_id: 'fixture-end', request: { subtype: 'end_session' } })
      assert.equal(await firstProcess.exited, 0)
      await service.stopSessionAndWait(sessionId)
      const after = await sessionService.getSessionLaunchInfo(sessionId)
      assert.ok(after.transcriptMessageCount > 0)
      assert.equal(after.customTitle, 'SDK placeholder title')
      assert.equal(after.runtimeProviderId, provider.id)
      assert.equal(after.runtimeModelId, 'claude-sonnet-5-5')
      assert.equal(after.effortLevel, 'low')
      assert.equal(after.permissionMode, 'default')
      assert.equal(after.workDir, workDir)
      assert.match(await readFile(after.filePath, 'utf8'), /"fixtureExtension":\{"preserved":true\}/)
      assert.equal(readConversationRuntime(process.env.CLAUDE_CONFIG_DIR, sessionId), 'agent-sdk')
      await service.startSession(sessionId, workDir, url, options)
      await send('OFFLINE_SDK_HOST_RESUME', 3)
      const resumedProcess = service.sessions.get(sessionId).proc
      service.sendSdkMessage(sessionId, { type: 'control_request', request_id: 'fixture-end-resumed', request: { subtype: 'end_session' } })
      assert.equal(await resumedProcess.exited, 0)
      await service.stopSessionAndWait(sessionId)
      const messages = await sessionService.getSessionMessages(sessionId, { includeSubagents: false })
      const history = JSON.stringify(messages)
      assert.match(history, /OFFLINE_SDK_HOST_FIRST/)
      assert.match(history, /OFFLINE_SDK_HOST_SECOND/)
      assert.match(history, /OFFLINE_SDK_HOST_RESUME/)
      console.log('OFFICIAL_SDK_HOST:' + JSON.stringify({ sessionId, transcriptMessageCount: after.transcriptMessageCount, title: after.customTitle, initializationFailureRecovered: true, results: events.filter(event => event.type === 'result').length }))
    } finally {
      await service.stopAllSessionsAndWait(1_000)
      for (const child of spawned) if (child.exitCode === null) child.kill()
      await Promise.all(spawned.map(child => child.exited))
      mock.restore()
      await transport.stop(true)
    }
    })()
  `
  const child = Bun.spawn([
    process.execPath, '--no-env-file',
    `--config=${join(root, 'src/entrypoints/officialAgentSdk.bunfig.toml')}`,
    '--eval', fixture,
  ], { cwd: sandbox, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const timeout = setTimeout(() => child.kill(), 60_000)
  try {
    const code = await child.exited
    const output = await stdout
    const errors = await stderr
    if (code !== 0) throw new Error(`Desktop native SDK fixture exited ${code}\n${output}\n${errors}`)
    if (scenario !== 'turns') {
      const summary = output.split('\n').find(line => line.startsWith('OFFICIAL_SDK_STARTUP:'))
      expect(summary).toBeDefined()
      expect(JSON.parse(summary!.slice('OFFICIAL_SDK_STARTUP:'.length)).scenario).toBe(scenario)
      if (scenario === 'concurrent') expect(model.requests.length).toBeGreaterThan(0)
      else expect(model.requests.length).toBe(0)
      return
    }
    const summary = output.split('\n').find(line => line.startsWith('OFFICIAL_SDK_HOST:'))
    expect(summary).toBeDefined()
    expect(JSON.parse(summary!.slice('OFFICIAL_SDK_HOST:'.length))).toMatchObject({ title: 'SDK placeholder title', initializationFailureRecovered: true, results: 3 })
    const resumedRequest = model.requests.find(request => JSON.stringify(request.body.messages).includes('OFFLINE_SDK_HOST_RESUME'))
    expect(resumedRequest).toBeDefined()
    expect(JSON.stringify(resumedRequest!.body.messages)).toContain('OFFLINE_SDK_HOST_FIRST')
    expect(JSON.stringify(resumedRequest!.body.messages)).toContain('OFFLINE_SDK_HOST_SECOND')
    expect(errors).not.toContain('already in use')
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill()
    await child.exited
    await model.stop()
    await rm(sandbox, { recursive: true, force: true })
  }
}

test('desktop-created SDK placeholders survive first turn, second turn and a native resume without session ID collisions', () => runNativeHostFixture('turns'), 70_000)
test('concurrent SDK starts share one native process and preserve the placeholder', () => runNativeHostFixture('concurrent'), 70_000)
test('SDK restoration failures stop the initialized native process and preserve recovery metadata', () => runNativeHostFixture('restore-failure'), 70_000)
test('deleting an SDK session during staging prevents the native process from spawning', () => runNativeHostFixture('delete-during-stage'), 70_000)
