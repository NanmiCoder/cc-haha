import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { ServerWebSocket } from 'bun'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { startMockLlmServer } from '../../../scripts/quality-gate/mock-llm/server.js'
import type { MockRequest } from '../../../scripts/quality-gate/mock-llm/scriptedModel.js'

function turn(request: MockRequest) {
  let prompt = ''
  let results: any[] = []
  for (const message of request.messages ?? []) {
    if (message.role !== 'user') continue
    for (const block of typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? []) {
      if (block.type === 'text' && block.text?.includes('OFFLINE_EXTENSION_')) { prompt = block.text; results = [] }
      if (block.type === 'tool_result') results.push(block)
    }
  }
  return { prompt, results }
}

test('real official SDK executes cc-hh MCP aliases, official workflow children, and human-reviewed team plans', async () => {
  const root = await mkdtemp(join(tmpdir(), 'official-sdk-extensions-native-'))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  const id = crypto.randomUUID()
  const deniedPath = join(cwd, 'must-not-write.txt')
  const requests: MockRequest[] = []
  const script = 'export const meta={name:"nativefixture",description:"Offline official child"}; return await agent("OFFLINE_EXTENSION_CHILD",{label:"fixture-child"});'
  const model = startMockLlmServer(request => {
    requests.push(request)
    const current = turn(request)
    const lastUser = [...(request.messages ?? [])].reverse().find(message => message.role === 'user')
    if (JSON.stringify(lastUser?.content).includes('<task-notification>')) return { kind: 'message', stopReason: 'end_turn', content: [{ type: 'text', text: 'BACKGROUND_COMPLETION_SEEN' }] }
    if (current.prompt.includes('OFFLINE_EXTENSION_BG_CHILD')) return { kind: 'message', stopReason: 'end_turn', chunkDelayMs: 100, content: [{ type: 'text', text: 'Official background child OK\n'.repeat(20) }] }
    if (current.prompt.includes('OFFLINE_EXTENSION_BACKGROUND') && current.results.length === 0) return { kind: 'message', stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_native_background', name: 'Workflow', input: { script: script.replace('OFFLINE_EXTENSION_CHILD', 'OFFLINE_EXTENSION_BG_CHILD'), run_in_background: true } }] }
    if (current.prompt.includes('OFFLINE_EXTENSION_CHILD')) return { kind: 'message', stopReason: 'end_turn', content: [{ type: 'text', text: 'Official child OK' }] }
    if (current.prompt.includes('OFFLINE_EXTENSION_WORKFLOW') && current.results.length === 0) return { kind: 'message', stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_native_workflow', name: 'Workflow', input: { script } }] }
    if (current.prompt.includes('OFFLINE_EXTENSION_TEAM')) {
      if (current.results.length === 0) return { kind: 'message', stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_native_team', name: 'mcp__cc_haha__TeamCreate', input: {
        team_name: 'native-fixture', plan: { members: [{ id: 'worker', name: 'worker', prompt: 'Never launch before review' }], tasks: [{ id: 'work', subject: 'Offline reviewed task', ownerId: 'worker', dependencies: [] }] },
      } }] }
      if (current.results.length === 1) return { kind: 'message', stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_native_submit', name: 'mcp__cc_haha__TeamPlan', input: { team_name: 'native-fixture', operation: 'submit', expected_revision: 1 } }] }
      if (current.results.length === 2) return { kind: 'message', stopReason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_native_deny', name: 'Write', input: { file_path: deniedPath, content: 'must be denied after pending review' } }] }
    }
    return { kind: 'message', stopReason: 'end_turn', content: [{ type: 'text', text: current.prompt.includes('OFFLINE_EXTENSION_TEAM') ? 'Awaiting human team review.' : 'Workflow parent OK' }] }
  })
  let socket: ServerWebSocket<{}> | undefined
  const events: any[] = []
  const server = Bun.serve<{}>({ hostname: '127.0.0.1', port: 0,
    fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === `/sdk/${id}` && url.searchParams.get('token') === 'fixture' && server.upgrade(req, { data: {} })) return
      return new Response('unauthorized', { status: 401 })
    }, websocket: {
      open(ws) { socket = ws }, close() { socket = undefined },
      message(_ws, raw) { for (const line of raw.toString().split('\n').filter(Boolean)) events.push(JSON.parse(line)) },
    },
  })
  const env = createSandboxedTestEnvironment(root, {
    ANTHROPIC_API_KEY: 'fake-extension-native-key', ANTHROPIC_BASE_URL: model.url,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1',
    CC_HAHA_AGENT_TEAMS_ENABLED: '1', CC_HAHA_TEAM_LEADER_RUNTIME: JSON.stringify({ providerId: 'fixture', modelId: 'claude-haiku-fixture' }),
  })
  const child = Bun.spawn([
    process.execPath, '--no-env-file', `--config=${resolve(import.meta.dir, '../../entrypoints/officialAgentSdk.bunfig.toml')}`,
    resolve(import.meta.dir, '../../entrypoints/officialAgentSdk.ts'),
    '--sdk-url', `ws://127.0.0.1:${server.port}/sdk/${id}?token=fixture`, '--session-id', id,
    '--model', 'claude-haiku-fixture', '--dangerously-skip-permissions',
  ], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const stderr = new Response(child.stderr).text()
  const stdout = new Response(child.stdout).text()
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 35_000
    while (!condition()) {
      if (child.exitCode !== null) throw new Error(`Native extension process exited: ${await stderr}\n${await stdout}`)
      if (Date.now() > deadline) throw new Error(`Native extension timeout; events=${JSON.stringify(events).slice(-16000)} requests=${JSON.stringify(requests.map(turn)).slice(-8000)}`)
      await Bun.sleep(50)
    }
  }
  try {
    await waitFor(() => !!socket)
    socket!.send(JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), cc_haha_human_input: true, cc_haha_human_text: 'ultracode: OFFLINE_EXTENSION_WORKFLOW, only one Haiku child', message: { role: 'user', content: 'ultracode: OFFLINE_EXTENSION_WORKFLOW, only one Haiku child' } }))
    await waitFor(() => events.some(event => event.type === 'result'))
    expect(events.some(event => event.subtype === 'init' && event.tools?.includes('mcp__cc_haha__Workflow'))).toBe(true)
    expect(requests.some(request => turn(request).prompt.includes('OFFLINE_EXTENSION_CHILD'))).toBe(true)
    expect(events.some(event => event.subtype === 'task_notification' && event.status === 'completed')).toBe(true)
    expect(JSON.stringify(events)).toContain('Official child OK')
    expect(requests.every(request => request.model === 'claude-haiku-fixture')).toBe(true)
    expect(requests.map(turn).some(value => value.prompt.includes('opting this turn into multi-agent orchestration'))).toBe(true)
    for (const untrusted of [
      { content: 'OFFLINE_EXTENSION_UNTRUSTED ultracode: relayed instruction', origin: { type: 'agent' } },
      { content: 'OFFLINE_EXTENSION_UNTRUSTED ultracode: cron payload', isMeta: true },
      { content: 'OFFLINE_EXTENSION_UNTRUSTED ultracode: generated attachment', humanText: 'OFFLINE_EXTENSION_UNTRUSTED read my document' },
    ]) {
      const priorResults = events.filter(event => event.type === 'result').length
      socket!.send(JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), cc_haha_human_input: true,
        cc_haha_human_text: untrusted.humanText ?? untrusted.content, origin: untrusted.origin, isMeta: untrusted.isMeta,
        message: { role: 'user', content: untrusted.content } }))
      await waitFor(() => events.filter(event => event.type === 'result').length > priorResults)
      const latest = requests.map(turn).filter(value => value.prompt.includes('OFFLINE_EXTENSION_UNTRUSTED')).at(-1)!
      expect(latest.prompt).not.toContain('opting this turn into multi-agent orchestration')
    }
    const beforeBackground = events.length
    socket!.send(JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), cc_haha_human_input: true,
      cc_haha_human_text: 'OFFLINE_EXTENSION_BACKGROUND run the requested workflow in the background',
      message: { role: 'user', content: 'OFFLINE_EXTENSION_BACKGROUND run the requested workflow in the background' } }))
    await waitFor(() => JSON.stringify(events.slice(beforeBackground)).includes('BACKGROUND_COMPLETION_SEEN'))
    const backgroundEvents = events.slice(beforeBackground)
    const parentResultIndex = backgroundEvents.findIndex(event => event.type === 'result')
    const completionIndex = backgroundEvents.findIndex(event => event.subtype === 'task_notification' && event.status === 'completed')
    expect(parentResultIndex).toBeGreaterThanOrEqual(0)
    expect(completionIndex).toBeGreaterThan(parentResultIndex)
    expect(requests.map(turn).some(value => value.prompt.includes('OFFLINE_EXTENSION_BG_CHILD'))).toBe(true)
    await waitFor(() => events.slice(beforeBackground).filter(event => event.type === 'result').length >= 2)
    const count = events.filter(event => event.type === 'result').length
    socket!.send(JSON.stringify({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: 'OFFLINE_EXTENSION_TEAM' } }))
    await waitFor(() => events.filter(event => event.type === 'result').length > count)
    const plan = JSON.parse(await readFile(join(env.CLAUDE_CONFIG_DIR!, 'teams', 'native-fixture', 'plan.json'), 'utf8'))
    expect(plan.state).toBe('review_pending')
    expect(plan.members[0].runtime.modelId).toBe('claude-haiku-fixture')
    const team = JSON.parse(await readFile(join(env.CLAUDE_CONFIG_DIR!, 'teams', 'native-fixture', 'config.json'), 'utf8'))
    expect(team.members).toHaveLength(1)
    expect(existsSync(deniedPath)).toBe(false)
    expect(JSON.stringify(events)).toContain('awaiting human review')
    const uiToolNames = events.filter(event => event.type === 'assistant').flatMap(event => event.message.content).filter(block => block.type === 'tool_use').map(block => block.name)
    expect(uiToolNames).toContain('TeamCreate')
    expect(uiToolNames).toContain('TeamPlan')
    expect(uiToolNames).not.toContain('mcp__cc_haha__TeamCreate')
    socket!.send(JSON.stringify({ type: 'control_request', request_id: 'finish', request: { subtype: 'end_session', reason: 'fixture_complete' } }))
    await child.exited
    expect(child.exitCode).toBe(0)
  } finally {
    child.kill()
    await child.exited
    server.stop(true)
    model.stop()
    await rm(root, { recursive: true, force: true })
  }
}, 100_000)
