import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { startMockLlmServer } from '../../../scripts/quality-gate/mock-llm/server.js'

test('scheduled SDK jobs use native stdio, selected model, ephemeral automatic runs and resumable manual history', async () => {
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), 'cc-sdk-cron-')))
  const root = resolve(import.meta.dir, '../../..')
  const model = startMockLlmServer(() => ({ kind: 'message', stopReason: 'end_turn', content: [{ type: 'text', text: 'SCHEDULED_SDK_OK' }] }))
  const env = createSandboxedTestEnvironment(sandbox, {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
  })
  const fixture = `
    import assert from 'node:assert/strict'
    import { mkdir, readFile } from 'node:fs/promises'
    import { join } from 'node:path'
    const root = ${JSON.stringify(root)}
    const { CronScheduler } = await import(root + '/src/server/services/cronScheduler.ts')
    const { CronService } = await import(root + '/src/server/services/cronService.ts')
    const { ProviderService } = await import(root + '/src/server/services/providerService.ts')
    const { sessionService } = await import(root + '/src/server/services/sessionService.ts')
    const { readConversationRuntime } = await import(root + '/src/server/services/officialAgentSdkRuntime.ts')
    const { resetScheduledRunReadModelForTests } = await import(root + '/src/server/services/localIndex/scheduledRunReadModel.ts')
    const workDir = join(process.env.HOME, 'project')
    await mkdir(workDir)
    const provider = await new ProviderService().addProvider({
      presetId: 'custom', name: 'Offline SDK cron', apiKey: 'fake-key', baseUrl: 'https://api.anthropic.com',
      apiFormat: 'anthropic', authStrategy: 'api_key', runtime: 'agent-sdk',
      models: { main: 'claude-opus-5-5', haiku: 'claude-haiku-5-5', sonnet: '', opus: '' },
    })
    const cron = new CronService()
    const scheduler = new CronScheduler(cron)
    const original = scheduler.buildTaskChildEnv.bind(scheduler)
    scheduler.buildTaskChildEnv = async (...args) => ({ ...await original(...args), ANTHROPIC_BASE_URL: ${JSON.stringify(model.url)} })
    process.env.CLAUDE_CLI_PATH = join(workDir, 'legacy-cli-must-not-run.ts')
    const task = await cron.createTask({ name: 'SDK fixture', prompt: 'SCHEDULED_SDK_TEST', cron: '* * * * *', folderPath: workDir, enabled: true, recurring: true, providerId: provider.id, model: 'claude-haiku-5-5' })
    try {
      const automatic = await scheduler.executeTask(task)
      assert.equal(automatic.status, 'completed', JSON.stringify(automatic))
      assert.equal(automatic.exitCode, 0)
      assert.equal(automatic.sessionId, undefined)
      assert.match(automatic.output, /SCHEDULED_SDK_OK/)
      const manual = await scheduler.executeTask(task, { createSession: true })
      assert.equal(manual.status, 'completed', JSON.stringify(manual))
      assert.ok(manual.sessionId)
      const info = await sessionService.getSessionLaunchInfo(manual.sessionId)
      assert.equal(info.runtimeProviderId, provider.id)
      assert.equal(info.runtimeModelId, 'claude-haiku-5-5')
      assert.equal(info.permissionMode, 'bypassPermissions')
      assert.match(await readFile(info.filePath, 'utf8'), /SCHEDULED_SDK_OK/)
      assert.equal(readConversationRuntime(process.env.CLAUDE_CONFIG_DIR, manual.sessionId), 'agent-sdk')
      console.log('CRON_SDK_NATIVE_OK')
    } finally {
      await scheduler.stopAndWait()
      await resetScheduledRunReadModelForTests()
    }
  `
  const child = Bun.spawn([process.execPath, '--no-env-file', `--config=${join(root, 'src/entrypoints/officialAgentSdk.bunfig.toml')}`, '--eval', fixture], {
    cwd: sandbox, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const timeout = setTimeout(() => child.kill(), 50_000)
  try {
    const code = await child.exited
    const output = await stdout
    const errors = await stderr
    if (code !== 0) throw new Error(`SDK scheduler fixture failed: ${code}\n${output}\n${errors}`)
    expect(output).toContain('CRON_SDK_NATIVE_OK')
    expect(model.requests.length).toBeGreaterThanOrEqual(2)
    expect(model.requests.every(request => request.body.model === 'claude-haiku-5-5')).toBe(true)
    expect(errors).not.toContain('already in use')
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) { child.kill(); await child.exited }
    await model.stop()
    await rm(sandbox, { recursive: true, force: true })
  }
}, 60_000)
