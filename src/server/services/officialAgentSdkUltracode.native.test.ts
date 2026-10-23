import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk/core'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { startMockLlmServer } from '../../../scripts/quality-gate/mock-llm/server.js'
import { createOfficialUltracodeController } from './officialAgentSdkUltracode.js'
import { setCwdState, setOriginalCwd } from '../../bootstrap/state.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

// This read-only method ships in the pinned native SDK even though it is not
// exported in its .d.ts. Keep the compatibility seam narrow and prove the exact
// bundled behavior, rather than inferring availability from the effort picker.
type NativeSettingsQuery = Query & { getSettings(): Promise<unknown> }

test('native Ultracode preserves Haiku low effort, reports real state, pauses on old models, and resets after resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-ultracode-native-'))
  const project = join(root, 'project')
  await mkdir(project)
  const requests: string[] = []
  const mock = startMockLlmServer(request => {
    requests.push(JSON.stringify(request.messages))
    return { kind: 'message', stopReason: 'end_turn', content: [{ type: 'text', text: 'Offline native mode fixture complete.' }] }
  })
  const env = createSandboxedTestEnvironment(root, {
    ANTHROPIC_API_KEY: 'fake-ultracode-key', ANTHROPIC_BASE_URL: mock.url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
  })
  const previousHome = process.env.HOME
  const previousConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR
  setCwdState(project)
  setOriginalCwd(project)
  resetSettingsCache()
  const id = crypto.randomUUID()
  const runtimes: Query[] = []
  const drains: Promise<void>[] = []
  function launch(resume = false) {
    let notify: (() => void) | undefined
    let ended = false
    const pending: SDKUserMessage[] = []
    const prompt = (async function* () {
      while (!ended) {
        if (pending.length) yield pending.shift()!
        else await new Promise<void>(resolve => { notify = resolve })
      }
    })()
    const options = { cwd: project, env, model: 'claude-haiku-5-5', effort: 'low' as const, settingSources: [], persistSession: true, ...(resume ? { resume: id } : { sessionId: id }) }
    const runtime = query({ prompt, options }) as NativeSettingsQuery
    runtimes.push(runtime)
    let results = 0
    const done = (async () => { try { for await (const event of runtime) { if (event.type === 'result') results++ } } catch {} })()
    drains.push(done)
    return {
      runtime,
      controller: createOfficialUltracodeController({
        getModel: () => options.model, getEffort: () => options.effort, env, eligible: true,
        applySettings: settings => runtime.applyFlagSettings(settings), readSettings: () => runtime.getSettings(),
      }),
      async turn(text: string) {
        const expected = results + 1
        pending.push({ type: 'user', session_id: id, parent_tool_use_id: null, message: { role: 'user', content: text } })
        notify?.()
        const deadline = Date.now() + 20_000
        while (results < expected && Date.now() < deadline) await Bun.sleep(10)
        expect(results).toBe(expected)
      },
      async close() { ended = true; notify?.(); await done },
    }
  }
  try {
    const h = launch()
    const initial = await h.controller.refreshState()
    expect(initial).toMatchObject({ enabled: false, active: false, available: true, effort: 'low', model: 'claude-haiku-5-5' })
    const enabled = await h.controller.setEnabled(true)
    expect(enabled).toMatchObject({ enabled: true, active: true, effort: 'low', model: 'claude-haiku-5-5' })
    await h.turn('OFFLINE_MODE_FIRST: acknowledge this trivial fixture briefly.')
    await h.turn('OFFLINE_MODE_SECOND: acknowledge the next trivial fixture briefly.')
    expect(requests.filter(text => text.includes('Ultracode is on') || text.includes('Ultracode is still on')).length).toBeGreaterThanOrEqual(2)
    await h.runtime.applyFlagSettings({ effortLevel: 'low' })
    expect((await h.controller.refreshState()).active).toBe(true)
    await h.runtime.applyFlagSettings({ effortLevel: 'medium' })
    expect(await h.controller.refreshState()).toMatchObject({ enabled: false, effort: 'medium' })
    await h.controller.setEnabled(true)
    await h.runtime.setModel('claude-haiku-4-5')
    expect(await h.controller.refreshState()).toMatchObject({ enabled: true, active: false, available: false, model: 'claude-haiku-4-5' })
    await h.runtime.setModel('claude-haiku-5-5')
    expect((await h.controller.refreshState()).active).toBe(true)
    await h.close()
    const resumed = launch(true)
    expect(await resumed.controller.refreshState()).toMatchObject({ enabled: false, active: false, effort: 'low' })
    await resumed.close()
  } finally {
    for (const runtime of runtimes) runtime.close()
    await Promise.all(drains)
    mock.stop()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    resetSettingsCache()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
