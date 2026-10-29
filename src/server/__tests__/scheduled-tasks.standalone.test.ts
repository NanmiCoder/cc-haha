import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment, removeTestSandbox } from '../../../scripts/pr/test-environment'

test.each(['settings', 'environment'])('mobile native %s API-key schedule reaches the normal session runtime', source => {
  const home = mkdtempSync(join(tmpdir(), 'scheduled-native-runtime-'))
  const script = `
    import assert from 'node:assert/strict'
    import { mkdirSync, writeFileSync } from 'node:fs'
    import { join } from 'node:path'
    import { mock, spyOn } from 'bun:test'
    const root = ${JSON.stringify(join(import.meta.dir, '..', '..', '..'))}
    for (const [file, name] of [
      ['hahaOAuthService', 'hahaOAuthService'], ['hahaOpenAIOAuthService', 'hahaOpenAIOAuthService'],
      ['hahaGrokOAuthService', 'hahaGrokOAuthService'], ['hahaDeepSeekOAuthService', 'hahaDeepSeekOAuthService'],
    ]) {
      const service = (await import(root + '/src/server/services/' + file + '.ts'))[name]
      spyOn(service, 'loadTokens').mockResolvedValue(null)
      spyOn(service, 'ensureFreshTokens').mockResolvedValue(null)
    }
    const network = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'))
    const config = process.env.CLAUDE_CONFIG_DIR
    mkdirSync(config, { recursive: true })
    const env = { ANTHROPIC_MODEL: 'native-fixture-model', ANTHROPIC_API_KEY: 'fake-native-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' }
    if (${JSON.stringify(source)} === 'environment') Object.assign(process.env, env)
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ model: 'native-fixture-model', ...(${JSON.stringify(source)} === 'settings' ? { env } : {}) }))
    const project = join(process.env.HOME, 'project')
    mkdirSync(project)
    const { handleModelsApi } = await import(root + '/src/server/api/models.ts')
    async function modelGet(path) {
      const url = new URL('http://127.0.0.1' + path)
      const response = await handleModelsApi(new Request(url), url, url.pathname.slice(1).split('/'))
      assert.equal(response.status, 200)
      return response.json()
    }
    const current = await modelGet('/api/models/current')
    const catalog = await modelGet('/api/models')
    const { createScheduleInput, newScheduleDraft } = await import(root + '/mobile/src/core/scheduleDraft.ts')
    const payload = createScheduleInput({ name: 'Native task', prompt: 'Reply ready', execution: { kind: 'new-session' }, folderPath: project,
      runtime: { providerId: catalog.provider?.id ?? null, modelId: current.model.id }, followDefaultRuntime: catalog.runtimeSource === 'standalone',
      useWorktree: false, notificationPolicy: 'none', channels: [] }, newScheduleDraft('UTC'))
    const { handleScheduledTasksApi } = await import(root + '/src/server/api/scheduled-tasks.ts')
    const url = new URL('http://127.0.0.1/api/scheduled-tasks')
    const response = await handleScheduledTasksApi(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }), url, ['api', 'scheduled-tasks'])
    assert.equal(response.status, 201)
    const { task } = await response.json()
    const handler = await import(root + '/src/server/ws/handler.ts')
    const { emitSessionTurnEvent } = await import(root + '/src/server/services/sessionTurnEvents.ts')
    spyOn(handler, 'getSessionTurnState').mockReturnValue('idle')
    let deliveredRuntime
    spyOn(handler, 'submitScheduledTaskTurn').mockImplementation(async (id) => {
      deliveredRuntime = await handler.getRuntimeSettings(id)
      emitSessionTurnEvent({ type: 'output', sessionId: id, message: { type: 'system', subtype: 'session_message_receipt', message_id: 'occurrence', status: 'consumed' } })
      emitSessionTurnEvent({ type: 'output', sessionId: id, message: { type: 'result', is_error: false, result: 'Ready' } })
      return { status: 'queued' }
    })
    const { executeScheduledSessionTask } = await import(root + '/src/server/services/scheduledTaskHost.ts')
    const result = await executeScheduledSessionTask({ task, runId: 'run', occurrenceId: 'occurrence', scheduledFor: new Date().toISOString(), signal: new AbortController().signal, canSend: async () => true }, { serverHost: '127.0.0.1', serverPort: 1 })
    assert.equal(result.status, 'completed', JSON.stringify(result))
    assert.equal(catalog.runtimeSource, 'standalone')
    assert.ok(!('providerId' in payload))
    assert.ok(!('model' in payload))
    assert.equal(deliveredRuntime.model, 'native-fixture-model')
    const { sessionService } = await import(root + '/src/server/services/sessionService.ts')
    const saved = await sessionService.getSessionLaunchInfo(result.sessionId)
    assert.equal(saved.runtimeModelId, undefined)
    assert.equal(saved.runtimeProviderId, undefined)
    assert.equal(network.mock.calls.length, 0)
    // An explicit Claude OAuth choice must still fail without its own account.
    const explicit = await executeScheduledSessionTask({ task: { ...task, providerId: null, model: 'native-fixture-model' }, runId: 'run-explicit', occurrenceId: 'explicit', scheduledFor: new Date().toISOString(), signal: new AbortController().signal, canSend: async () => true }, { serverHost: '127.0.0.1', serverPort: 1 })
    assert.equal(explicit.status, 'failed')
    assert.match(explicit.error, /unavailable/)
    mock.restore()
  `
  try {
    expect(() => execFileSync(process.execPath, ['--no-env-file', '-e', script], {
      env: createSandboxedTestEnvironment(home),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: 20_000,
    })).not.toThrow()
  } finally { removeTestSandbox(home, 'scheduled-native-runtime') }
})
