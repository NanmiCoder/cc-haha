import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk/core'
import { parseOfficialAgentSdkArgs } from './officialAgentSdkBridge.js'
import { createOfficialAgentSdkExtensions } from './officialAgentSdkExtensions.js'
import { readTeamPlan, approveTeamPlan } from '../../utils/swarm/teamPlanStore.js'
import { readTeamFile, writeTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import { createTask, getCanonicalTeamTaskListId } from '../../utils/tasks.js'
import { readMailbox } from '../../utils/teammateMailbox.js'
import { _resetTaskOutputDirForTest } from '../../utils/task/diskOutput.js'
import { getClaudeTempDir } from '../../utils/permissions/filesystem.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

let root: string
const saved = { ...process.env }
const cleanups: Array<() => Promise<void>> = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'official-sdk-extensions-'))
  process.env.HOME = root
  process.env.CLAUDE_CONFIG_DIR = join(root, '.claude')
  process.env.CLAUDE_CODE_TMPDIR = root
  getClaudeTempDir.cache.clear()
  _resetTaskOutputDirForTest()
  resetSettingsCache()
  delete process.env.CC_HAHA_DESKTOP_SERVER_URL
  delete process.env.CC_HAHA_SESSION_COLLABORATION_TOKEN
  await mkdir(join(root, 'project'), { recursive: true })
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  getClaudeTempDir.cache.clear()
  _resetTaskOutputDirForTest()
  resetSettingsCache()
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  await rm(root, { recursive: true, force: true })
})
const catalog = { 'general-purpose': { systemPrompt: 'Fixture worker', source: 'built-in', sourceIdentity: { kind: 'builtin' as const }, agentType: 'general-purpose' } }
async function fixture(options: { worker?: Record<string, string>; run?: (input: any) => Query; enabled?: boolean; realCatalog?: boolean; side?: boolean } = {}) {
  const id = crypto.randomUUID()
  const config = parseOfficialAgentSdkArgs(['--sdk-url', `ws://127.0.0.1:1/sdk/${id}?token=fake`, '--session-id', id, '--model', 'claude-haiku-fixture'], join(root, 'project'), {
    ...process.env, ANTHROPIC_API_KEY: 'fake-fixture', CC_HAHA_AGENT_TEAMS_ENABLED: options.enabled === false ? '0' : '1',
    CC_HAHA_TEAM_LEADER_RUNTIME: JSON.stringify({ providerId: 'fixture-provider', modelId: 'claude-haiku-fixture' }),
    ...(options.worker ? { CC_HAHA_TEAM_WORKER: JSON.stringify(options.worker) } : {}),
  })
  const calls: any[] = []
  const messages: any[] = []
  const notifications: string[] = []
  if (options.side) config.hostSessionId = `side-${id}`
  const extensions = await createOfficialAgentSdkExtensions(config, { computer: false, ...(options.realCatalog ? {} : { teamCatalog: catalog }),
    query: ((input: any) => {
      calls.push(input)
      if (options.run) return options.run(input)
      return { async *[Symbol.asyncIterator]() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: input.prompt }], usage: { output_tokens: 1 } } }
        yield { type: 'result', subtype: 'success', is_error: false, result: `Result:${input.prompt}`, usage: { input_tokens: 3, output_tokens: 2 }, total_cost_usd: 0.004, duration_api_ms: 12,
          modelUsage: { 'claude-haiku-fixture': { inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.004, contextWindow: 200000, maxOutputTokens: 32000 } } }
      }, close() {} } as unknown as Query
    }) as any, send(message) { messages.push(message) },
  })
  extensions.configure?.({ notify(text) { notifications.push(text) }, canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }), options: {
    cwd: config.cwd, env: config.env, model: config.model, settingSources: ['user', 'project', 'local'], permissionMode: 'default',
    sessionId: id, mcpServers: extensions.mcpServers,
  } as Options })
  const client = new Client({ name: 'fixture', version: '1' })
  const [left, right] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(left), (extensions.mcpServers!.cc_haha as any).instance.connect(right)])
  cleanups.push(async () => { await extensions.close?.(); await client.close() })
  return { client, config, extensions, calls, messages, notifications,
    async call(name: string, input: Record<string, unknown> = {}, toolUseId?: string) {
      const result = await client.callTool({ name, arguments: input, ...(toolUseId ? { _meta: { 'claudecode/toolUseId': toolUseId } } : {}) })
      const text = (result.content as any[]).find(item => item.type === 'text')?.text
      if (result.isError) throw new Error(text)
      return JSON.parse(text)
    },
  }
}

test('MCP team proposal uses the existing GUI draft store, never approves, and gates subsequent work for human review', async () => {
  const f = await fixture()
  const proposed = { members: [{ id: 'worker', name: 'worker', prompt: 'Fixture work' }], tasks: [{ id: 't1', subject: 'Fixture task', ownerId: 'worker', dependencies: [] }] }
  const created = await f.call('TeamCreate', { team_name: 'fixture-team', plan: proposed })
  expect(created.plan.state).toBe('draft')
  expect(readTeamFile('fixture-team')?.leadSessionId).toBe(f.config.hostSessionId)
  expect(readTeamFile('fixture-team')?.members).toHaveLength(1)
  await expect(f.call('TaskCreate', { subject: 'Too soon', description: '' })).rejects.toThrow('approved')
  const submitted = await f.call('TeamPlan', { team_name: 'fixture-team', operation: 'submit', expected_revision: created.plan.revision })
  expect(submitted.state).toBe('review_pending')
  expect(f.calls).toHaveLength(0)
  const hook = f.extensions.hooks!.PreToolUse![0]!.hooks[0]!
  expect(await hook({} as any, 'tool-fixture', { signal: new AbortController().signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  await f.extensions.beforeUserMessage?.({ isHumanInput: false })
  expect(await hook({} as any, 'tool-fixture', { signal: new AbortController().signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  await f.extensions.beforeUserMessage?.({ isHumanInput: true })
  expect(await hook({} as any, 'tool-fixture', { signal: new AbortController().signal })).toEqual({})
  await expect(f.call('TeamPlan', { team_name: 'fixture-team', operation: 'submit', expected_revision: 1 })).rejects.toThrow('changed')
})

test('approved workers use shared tasks and mailboxes, with ownership and dependency checks', async () => {
  const leader = await fixture()
  const created = await leader.call('TeamCreate', { team_name: 'fixture-team', plan: { members: [{ id: 'worker', name: 'worker', prompt: 'Fixture work' }], tasks: [{ id: 't1', subject: 'Fixture', ownerId: 'worker', dependencies: [] }] } })
  await leader.call('TeamPlan', { team_name: 'fixture-team', operation: 'submit', expected_revision: created.plan.revision })
  const plan = (await readTeamPlan('fixture-team'))!
  await approveTeamPlan('fixture-team', { ...plan, expectedRevision: plan.revision }, 'fixture-approval', plan)
  const worker = await fixture({ worker: { parentSessionId: leader.config.hostSessionId, teamName: 'fixture-team', memberId: 'worker', name: 'worker' } })
  const team = readTeamFile('fixture-team')!
  await writeTeamFileAsync('fixture-team', { ...team, members: [...team.members, { agentId: 'worker@fixture-team', name: 'worker', sessionId: worker.config.hostSessionId, joinedAt: 2, tmuxPaneId: '', cwd: worker.config.cwd, subscriptions: [] }] })
  expect((await worker.client.listTools()).tools.map(tool => tool.name)).not.toContain('TeamCreate')
  const recordedTask = await worker.call('TaskCreate', { subject: 'Historical task', description: 'Preserve the task card' })
  expect(recordedTask.task).toMatchObject({ id: recordedTask.taskId, subject: 'Historical task', status: 'pending' })
  const listId = getCanonicalTeamTaskListId('fixture-team')
  const dependency = await createTask(listId, { subject: 'dependency', description: '', status: 'pending', blocks: [], blockedBy: [], owner: 'worker' })
  const task = await createTask(listId, { subject: 'dependent', description: '', status: 'pending', blocks: [], blockedBy: [dependency], owner: 'worker' })
  await expect(worker.call('TaskUpdate', { taskId: task, status: 'in_progress' })).rejects.toThrow('dependencies')
  await worker.call('TaskUpdate', { taskId: dependency, status: 'completed' })
  expect((await worker.call('TaskUpdate', { taskId: task, status: 'in_progress' })).task.status).toBe('in_progress')
  await worker.call('SendMessage', { to: 'team-lead', message: 'Fixture done', summary: 'Result' })
  expect((await readMailbox('team-lead', 'fixture-team')).at(-1)?.text).toBe('Fixture done')
  await expect(worker.call('SendMessage', { to: 'nonexistent', message: 'No orphan mail' })).rejects.toThrow('existing')
})

test('workflow runs official child queries with parent model/settings, journals results and replays without another model call', async () => {
  const f = await fixture({ enabled: false })
  const script = 'export const meta={name:"fixture",description:"Fixture workflow",phases:[{title:"Check"}]}; phase("Check"); return await agent("offline fixture", {label:"One"});'
  const first = await f.call('Workflow', { script })
  expect(first.result).toBe('Result:offline fixture')
  expect(first.status).toBe('completed')
  expect(f.calls).toHaveLength(1)
  expect(f.calls[0].options).toMatchObject({ model: 'claude-haiku-fixture', persistSession: false, settingSources: ['user', 'project', 'local'], permissionMode: 'default' })
  expect(f.calls[0].options.sessionId).not.toBe(f.config.sessionId)
  expect(f.calls[0].options.mcpServers).toEqual({})
  expect(await readFile(join(first.transcriptDir, 'journal.jsonl'), 'utf8')).toContain('Result:offline fixture')
  const repeated = await f.call('Workflow', { script, resumeFromRunId: first.runId })
  expect(repeated.result).toBe(first.result)
  expect(f.calls).toHaveLength(1)
  expect(f.messages.some(message => message.subtype === 'task_progress')).toBe(true)
  expect(f.messages.at(-1)).toMatchObject({ subtype: 'task_notification', status: 'completed' })
  const output = JSON.parse(await readFile(f.messages.at(-1).output_file, 'utf8'))
  expect(output).toMatchObject({ status: 'completed', workflowName: 'fixture', workflowRunId: first.runId })
  expect(f.extensions.usage?.()).toMatchObject({ totalCostUSD: 0.004, durationApiMs: 12, modelUsage: { 'claude-haiku-fixture': { inputTokens: 3, outputTokens: 2 } } })
})

test('workflow Stop and global interruption abort official child queries and persist stopped task results', async () => {
  const started: Options[] = []
  let closed = 0
  const f = await fixture({ enabled: false, run(input) {
    const options = input.options as Options
    return {
      async *[Symbol.asyncIterator]() {
        started.push(options)
        await new Promise<void>(resolve => {
          const signal = options.abortController!.signal
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }, close() { closed++ },
    } as unknown as Query
  } })
  const script = 'export const meta={name:"cancel",description:"Cancel fixture"}; return await agent("blocked child");'
  for (const action of ['stop', 'interrupt'] as const) {
    const count = started.length
    const pending = f.call('Workflow', { script })
    const deadline = Date.now() + 3000
    while (started.length === count) {
      if (Date.now() > deadline) throw new Error('Child query did not start')
      await Bun.sleep(5)
    }
    const taskId = f.messages.filter(message => message.subtype === 'task_started').at(-1).task_id
    if (action === 'stop') expect(await f.extensions.stopTask?.(taskId)).toBe(true)
    else await f.extensions.interrupt?.()
    const result = await pending
    expect(result.status).toBe('stopped')
    expect(started.at(-1)!.abortController!.signal.aborted).toBe(true)
    expect(f.messages.at(-1)).toMatchObject({ subtype: 'task_notification', status: 'stopped', task_id: taskId })
    expect(JSON.parse(await readFile(f.messages.at(-1).output_file, 'utf8')).status).toBe('stopped')
    expect(await f.extensions.stopTask?.(taskId)).toBe(false)
  }
  expect(closed).toBeGreaterThanOrEqual(2)
})

test('saved workflow slash commands resolve only known workflows and keep native commands untouched', async () => {
  const f = await fixture({ enabled: false })
  await mkdir(join(f.config.cwd, '.claude', 'workflows'), { recursive: true })
  await writeFile(join(f.config.cwd, '.claude', 'workflows', 'fixture.js'), 'export const meta={name:"fixture",description:"Fixture"}; return 1;')
  expect(await f.extensions.transformPrompt?.('/fixture hello', { isHumanInput: true, humanText: '/fixture hello' })).toContain('mcp__cc_haha__Workflow')
  expect(await f.extensions.transformPrompt?.('/fixture hello', { isHumanInput: false })).toBe('/fixture hello')
  expect(await f.extensions.transformPrompt?.('/compact', { isHumanInput: true })).toBe('/compact')
  expect(await f.extensions.transformPrompt?.('ordinary user text')).toBe('ordinary user text')
})

test('default project Agent presets are captured for the GUI review card without a legacy model runtime', async () => {
  const f = await fixture({ realCatalog: true })
  const created = await f.call('TeamCreate', { team_name: 'default-catalog' })
  const plan = (await readTeamPlan(created.team_name))!
  expect(plan.agentCatalog?.['general-purpose']?.sourceIdentity).toEqual({ kind: 'builtin' })
  expect(plan.agentCatalog?.['general-purpose']?.systemPrompt).toBeTruthy()
  expect(f.calls).toHaveLength(0)
})

test('side chats do not expose persistent orchestration and main conversations keep native Task aliases', async () => {
  const main = await fixture()
  expect(main.extensions.toolAliases?.TaskCreate).toBeUndefined()
  const side = await fixture({ side: true })
  expect((await side.client.listTools()).tools).toEqual([])
  expect(side.extensions.toolAliases).toEqual({})
  expect(await side.extensions.transformPrompt?.('ultracode: do work', { isHumanInput: true })).toBe('ultracode: do work')
})

test('app scheduler tools use the authenticated host bridge and exclude ephemeral and worker sessions', async () => {
  const requests: Array<{ path: string; token: string | null; session: string | null; body: any }> = []
  const host = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    requests.push({ path: new URL(req.url).pathname, token: req.headers.get('authorization'), session: req.headers.get('x-session-id'), body: await req.json() })
    return Response.json({ task: { id: 'fixture-task' }, ok: true })
  } })
  cleanups.push(async () => { host.stop(true) })
  process.env.CC_HAHA_DESKTOP_SERVER_URL = `http://127.0.0.1:${host.port}`
  process.env.CC_HAHA_SESSION_COLLABORATION_TOKEN = 'fixture-host-token'
  process.env.CC_HAHA_SESSION_ID = 'fixture-host-session'
  const main = await fixture()
  await main.call('CronCreate', { name: 'Offline schedule', prompt: 'Fixture work', cron: '0 10 * * *' })
  await main.call('CronUpdate', { taskId: 'fixture-task', enabled: false })
  await main.call('CronDelete', { taskId: 'fixture-task' })
  await main.call('TeamDelete', { teamName: 'fixture-team' })
  expect(requests.map(request => request.path)).toEqual(['cron-create', 'cron-update', 'cron-delete', 'team-delete'].map(action => `/api/session-collaboration/${action}`))
  expect(requests.every(request => request.token === 'Bearer fixture-host-token' && request.session === 'fixture-host-session')).toBe(true)
  expect(requests[0]!.body).toEqual({ name: 'Offline schedule', prompt: 'Fixture work', cron: '0 10 * * *' })
  await expect(main.call('CronCreate', { prompt: 'No model override', cron: '* * * * *', model: 'other-model' })).rejects.toThrow()
  const side = await fixture({ side: true })
  const worker = await fixture({ worker: { parentSessionId: main.config.sessionId, teamName: 'fixture-team', memberId: 'worker', name: 'worker' } })
  for (const f of [side, worker]) expect((await f.client.listTools()).tools.some(tool => tool.name.startsWith('Cron') || tool.name === 'TeamDelete' || tool.name === 'Workflow')).toBe(false)
})

test('workflow tool prompt carries the saved workflow size guideline', async () => {
  await mkdir(process.env.CLAUDE_CONFIG_DIR!, { recursive: true })
  await writeFile(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ workflowSizeGuideline: 'small' }))
  resetSettingsCache()
  const f = await fixture({ enabled: false })
  expect((await f.client.listTools()).tools.find(tool => tool.name === 'Workflow')!.description).toContain('keep workflows under 5 agents')
})


test('background workflows return before the child completes, notify the model, and retain journal/output evidence', async () => {
  let finish!: () => void
  const f = await fixture({ enabled: false, run(input) {
    return {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>(resolve => { finish = resolve })
        yield { type: 'result', subtype: 'success', is_error: false, result: 'background child done', usage: { input_tokens: 3, output_tokens: 2 } }
      }, close() {},
    } as unknown as Query
  } })
  const script = 'export const meta={name:"background",description:"Background fixture"}; return await agent("finish later");'
  const result = await f.call('Workflow', { script, run_in_background: true })
  expect(result.status).toBe('async_launched')
  const deadline = Date.now() + 3000
  while (!finish) { if (Date.now() > deadline) throw new Error('Child did not start'); await Bun.sleep(5) }
  expect(f.notifications).toEqual([])
  expect(f.calls[0].options.abortController.signal.aborted).toBe(false)
  finish()
  while (!f.notifications.length) { if (Date.now() > deadline) throw new Error('No completion notification'); await Bun.sleep(5) }
  expect(f.notifications[0]).toContain(result.taskId)
  expect(f.notifications[0]).toContain('completed')
  const output = JSON.parse(await readFile(result.outputFile, 'utf8'))
  expect(output).toMatchObject({ status: 'completed', result: 'background child done', workflowRunId: result.runId })
  expect(await f.extensions.stopTask?.(result.taskId)).toBe(false)
})

test('move-to-background targets the actual foreground tool and Stop cancels its still-running child', async () => {
  let started = false
  const f = await fixture({ enabled: false, run(input) {
    return {
      async *[Symbol.asyncIterator]() {
        started = true
        await new Promise<void>(resolve => input.options.abortController.signal.addEventListener('abort', () => resolve(), { once: true }))
      }, close() {},
    } as unknown as Query
  } })
  const script = 'export const meta={name:"movebackground",description:"Move background fixture"}; return await agent("wait for stop");'
  const pending = f.call('Workflow', { script }, 'workflow-target')
  const deadline = Date.now() + 3000
  while (!started) { if (Date.now() > deadline) throw new Error('Child did not start'); await Bun.sleep(5) }
  expect(await f.extensions.backgroundTasks?.('different-tool')).toBe(false)
  expect(await f.extensions.backgroundTasks?.('workflow-target')).toBe(true)
  const result = await pending
  expect(result.status).toBe('async_launched')
  expect(f.calls[0].options.abortController.signal.aborted).toBe(false)
  expect(await f.extensions.stopTask?.(result.taskId)).toBe(true)
  while (!f.notifications.length) { if (Date.now() > deadline) throw new Error('No cancellation notification'); await Bun.sleep(5) }
  expect(f.notifications[0]).toContain('stopped')
  expect(f.calls[0].options.abortController.signal.aborted).toBe(true)
})

test('background disablement refuses launch before starting a child or task', async () => {
  const f = await fixture({ enabled: false })
  f.config.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'
  await expect(f.call('Workflow', { script: 'export const meta={name:"disabled",description:"Disabled"}; return 1;', run_in_background: true })).rejects.toThrow('unavailable')
  expect(f.calls).toHaveLength(0)
  expect(f.messages).toHaveLength(0)
})

test('workflow children retain parent guards and dialog callbacks but get separate app read tools', async () => {
  const f = await fixture()
  const onElicitation = async () => ({ action: 'decline' as const })
  const onUserDialog = async () => ({ result: { action: 'cancel' } })
  const hook = async () => ({})
  const hooks = { PreToolUse: [{ hooks: [hook] }] }
  f.extensions.configure?.({ canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }), options: {
    env: f.config.env, model: f.config.model, mcpServers: f.extensions.mcpServers,
    onElicitation, onUserDialog, supportedDialogKinds: ['fixture'], hooks,
  } as any })
  await f.call('Workflow', { script: 'export const meta={name:"childcontext",description:"Child context"}; return await agent("read app context");' })
  const options = f.calls[0].options
  expect(options.onElicitation).toBe(onElicitation)
  expect(options.onUserDialog).toBe(onUserDialog)
  expect(options.supportedDialogKinds).toEqual(['fixture'])
  expect(options.hooks).toBe(hooks)
  expect(options.mcpServers.cc_haha).not.toBe(f.extensions.mcpServers?.cc_haha)
  expect(options.toolAliases).toBeUndefined()
})

test('new workflow children use acknowledged live parent model, permissions, effort and network settings', async () => {
  const f = await fixture({ enabled: false })
  const current: Options = { env: { ...f.config.env, HTTPS_PROXY: 'http://127.0.0.1:1000' }, model: f.config.model, permissionMode: 'default', effort: 'low' }
  f.extensions.configure?.({ canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }), options: current })
  current.model = 'claude-haiku-updated'
  current.permissionMode = 'plan'
  current.effort = 'medium'
  current.env!.HTTPS_PROXY = 'http://127.0.0.1:2000'
  await f.call('Workflow', { script: 'export const meta={name:"liveconfig",description:"Live config"}; return await agent("use current configuration");' })
  expect(f.calls[0].options).toMatchObject({ model: 'claude-haiku-updated', permissionMode: 'plan', effort: 'medium', env: { HTTPS_PROXY: 'http://127.0.0.1:2000' } })
  const progress = f.messages.flatMap(message => message.workflow_progress ?? []).find(event => event.type === 'workflow_agent')
  expect(progress.model).toBe('claude-haiku-updated')
})

test('workflow launch observes a Settings opt-out saved after the session started', async () => {
  const f = await fixture({ enabled: false })
  await mkdir(process.env.CLAUDE_CONFIG_DIR!, { recursive: true })
  await writeFile(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ enableWorkflows: false }))
  await expect(f.call('Workflow', { script: 'export const meta={name:"disabledlater",description:"Disabled later"}; return 1;' })).rejects.toThrow('disabled')
  expect(f.calls).toHaveLength(0)
  expect(f.messages).toHaveLength(0)
})
