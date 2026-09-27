import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationService } from './conversationService.js'
import { ProviderService } from './providerService.js'
import { resetTerminalShellEnvironmentCacheForTests } from '../../utils/terminalShellEnvironment.js'

let home: string
let originalEnv: NodeJS.ProcessEnv
beforeEach(async () => {
  originalEnv = { ...process.env }
  home = await mkdtemp(join(tmpdir(), 'team-workers-'))
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = home
  process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'
  resetTerminalShellEnvironmentCacheForTests()
})
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  resetTerminalShellEnvironmentCacheForTests()
  await rm(home, { recursive: true, force: true })
})

const worker = { parentSessionId: 'parent', teamName: 'approved', memberId: 'research', name: 'researcher', systemPrompt: 'Read only research', tools: ['Read'], agentDefinition: { disallowedTools: ['Bash'], maxTurns: 3 } }

test('worker CLI has its own SDK identity and applies the approved preset and model', () => {
  const service = new ConversationService() as any
  service.resolveCliArgs = (args: string[]) => args
  const args = service.buildSessionCliArgs('child', 'ws://127.0.0.1/sdk/child?token=fake', false, { model: 'vendor/precise', providerId: 'provider-b', teamWorker: worker }) as string[]
  expect(args).not.toContain('--no-session-persistence')
  expect(args[args.indexOf('--agent-id') + 1]).toBe('researcher@approved')
  expect(args[args.indexOf('--parent-session-id') + 1]).toBe('parent')
  expect(args[args.indexOf('--model') + 1]).toBe('vendor/precise')
  const agent = JSON.parse(args[args.indexOf('--agents') + 1]!).researcher
  expect(agent.prompt).toBe('Read only research')
  expect(agent.disallowedTools).toEqual(['Bash'])
  expect(args[args.indexOf('--max-turns') + 1]).toBe('3')
  expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Bash')
  expect(args[args.indexOf('--tools') + 1]).toContain('SendMessage')
})

test('worker deny flags remove tools and enforce permissions even with no allowlist', async () => {
  const service = new ConversationService() as any
  service.resolveCliArgs = (args: string[]) => args
  const args = service.buildSessionCliArgs('child', 'ws://127.0.0.1/sdk/child?token=fake', false, { teamWorker: { ...worker, tools: undefined, agentDefinition: { disallowedTools: ['Edit'], maxTurns: 2 } } }) as string[]
  expect(args).not.toContain('--tools')
  expect(args[args.indexOf('--max-turns') + 1]).toBe('2')
  const { parseToolListFromCLI } = await import('../../utils/permissions/permissionSetup.js')
  const { getEmptyToolPermissionContext } = await import('../../Tool.js')
  const { getTools } = await import('../../tools.js')
  const { FileEditTool } = await import('../../tools/FileEditTool/FileEditTool.js')
  const { checkRuleBasedPermissions } = await import('../../utils/permissions/permissions.js')
  const permission = getEmptyToolPermissionContext()
  permission.alwaysDenyRules = { cliArg: parseToolListFromCLI([args[args.indexOf('--disallowedTools') + 1]!]) }
  expect(getTools(permission).map(tool => tool.name)).not.toContain('Edit')
  expect(await checkRuleBasedPermissions(FileEditTool, {}, { getAppState: () => ({ toolPermissionContext: permission }) } as any)).toMatchObject({ behavior: 'deny' })
})

test('independent configured providers produce disjoint child credentials and routes without changing parent environment', async () => {
  const providers = new ProviderService()
  const models = { main: 'cheap', sonnet: 'cheap', opus: 'capable', haiku: 'cheap' }
  const first = await providers.addProvider({ presetId: 'custom', name: 'A', baseUrl: 'http://127.0.0.1:32111', apiKey: 'fake-key-a', models })
  const second = await providers.addProvider({ presetId: 'custom', name: 'B', baseUrl: 'http://127.0.0.1:32112', apiKey: 'fake-key-b', models })
  process.env.ANTHROPIC_API_KEY = 'parent-key'
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:32110'
  const service = new ConversationService() as any
  const [a, b] = await Promise.all([
    service.buildChildEnv(home, 'ws://127.0.0.1/sdk/a?token=a', { providerId: first.id, model: 'cheap', teamWorker: worker }),
    service.buildChildEnv(home, 'ws://127.0.0.1/sdk/b?token=b', { providerId: second.id, model: 'capable', teamWorker: worker }),
  ])
  expect(a.ANTHROPIC_MODEL).toBe('cheap')
  expect(b.ANTHROPIC_MODEL).toBe('capable')
  expect(a.ANTHROPIC_BASE_URL).not.toBe(b.ANTHROPIC_BASE_URL)
  expect(JSON.stringify(a)).not.toContain('fake-key-b')
  expect(JSON.stringify(b)).not.toContain('fake-key-a')
  expect(a.CC_HAHA_SESSION_COLLABORATION_TOKEN).toBe('a')
  expect(b.CC_HAHA_SESSION_COLLABORATION_TOKEN).toBe('b')
  expect(a.CC_HAHA_TEAM_REVIEW_REQUIRED).toBe('1')
  expect(process.env.ANTHROPIC_API_KEY).toBe('parent-key')
})

test('parent permission responses route exclusively to the requesting worker', () => {
  const service = new ConversationService() as any
  const responses: unknown[] = []
  const parent = { pendingPermissionRequests: new Map(), outputCallbacks: [] }
  const child = { teamWorker: worker, pendingPermissionRequests: new Map([['permission-1', { toolName: 'Read', input: {} }]]), sdkSocket: { send: (message: string) => responses.push(JSON.parse(message)) } }
  service.sessions.set('parent', parent)
  service.sessions.set('child', child)
  expect(service.getPendingPermissionToolName('parent', 'permission-1')).toBe('Read')
  expect(service.getPendingPermissionRequests('parent')).toHaveLength(1)
  expect(service.respondToPermission('parent', 'permission-1', true, undefined, { file_path: '/fixture' })).toBe(true)
  expect(responses).toHaveLength(1)
  expect((responses[0] as any).response.response.updatedInput).toEqual({ file_path: '/fixture' })
  expect(child.pendingPermissionRequests.size).toBe(0)
})

test('worker permission identity remains available for replay after leader completion', () => {
  const service = new ConversationService() as any
  const output: any[] = []
  const state = () => ({ pendingPermissionRequests: new Map(), sdkMessages: [], outputCallbacks: [] })
  service.sessions.set('parent', { ...state(), outputCallbacks: [(message: any) => output.push(message)] })
  service.sessions.set('child', { ...state(), teamWorker: worker })
  service.handleSdkPayload('child', JSON.stringify({ type: 'control_request', request_id: 'pending-child', request: { subtype: 'can_use_tool', tool_name: 'Read', input: {} } }))
  service.handleSdkPayload('parent', JSON.stringify({ type: 'result', subtype: 'success', result: 'leader done' }))
  expect(service.getPendingPermissionRequests('parent')).toEqual([{ requestId: 'pending-child', toolName: 'Read', input: {}, displayName: 'researcher', agentId: 'researcher@approved' }])
  expect(output[0].request.agent_id).toBe('researcher@approved')
})

test('real independent CLI processes send their first request to the approved provider after the barrier', async () => {
  const calls: Array<{ provider: string; model: string; credential: string | null; subagentOverride?: string; omitClaudeMd?: string; presetType?: string; presetSource?: string }> = []
  const upstream = (provider: string) => Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as any
    calls.push({ provider, model: body.model, credential: request.headers.get('x-api-key') || request.headers.get('authorization'), subagentOverride: body.subagentOverride, omitClaudeMd: body.omitClaudeMd, presetType: body.presetType, presetSource: body.presetSource })
    return new Response('fixture result')
  } })
  const a = upstream('a')
  const b = upstream('b')
  const service = new ConversationService()
  const bridge = Bun.serve<{ id: string }>({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      const id = url.pathname.split('/').pop()!
      if (!service.authorizeSdkConnection(id, url.searchParams.get('token'))) return new Response('denied', { status: 401 })
      return server.upgrade(request, { data: { id } }) ? undefined : new Response('upgrade failed', { status: 400 })
    },
    websocket: { open(ws) { service.attachSdkConnection(ws.data.id, ws) }, message(ws, message) { service.handleSdkPayload(ws.data.id, String(message)) }, close(ws) { service.detachSdkConnection(ws.data.id, ws) } },
  })
  try {
    process.env.CLAUDE_CLI_PATH = join(import.meta.dir, '__fixtures__', 'team-worker-cli.ts')
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'wrong-inherited-model'
    process.env.CC_HAHA_TEAM_WORKER_OMIT_CLAUDE_MD = '1'
    const providers = new ProviderService()
    const models = { main: 'cheap', sonnet: 'cheap', opus: 'capable', haiku: 'cheap' }
    const pa = await providers.addProvider({ presetId: 'custom', name: 'A', baseUrl: a.url.toString(), apiKey: 'fake-a', models })
    const pb = await providers.addProvider({ presetId: 'custom', name: 'B', baseUrl: b.url.toString(), apiKey: 'fake-b', models })
    for (const [id, provider, model] of [['worker-a', pa.id, 'cheap'], ['worker-b', pb.id, 'capable']]) {
      await service.startSession(id!, home, `ws://127.0.0.1:${bridge.port}/sdk/${id}?token=fixture-${id}`, { providerId: provider, model, teamWorker: { ...worker, agentDefinition: { ...worker.agentDefinition, omitClaudeMd: id === 'worker-a', agentType: 'fixture:researcher', source: 'plugin' } } })
      await service.requestControl(id!, { subtype: 'set_model', model }, 5000)
    }
    expect(calls).toEqual([])
    const results = ['worker-a', 'worker-b'].map(id => new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('fixture result timeout')), 5000)
      service.onOutput(id, message => { if (message.type === 'result') { clearTimeout(timeout); resolve() } })
    }))
    await Promise.all(['worker-a', 'worker-b'].map(id => service.sendMessage(id, 'Start approved task')))
    await Promise.all(results)
    const { writeTeamFileAsync } = await import('../../utils/swarm/teamHelpers.js')
    const { TeamService } = await import('./teamService.js')
    await writeTeamFileAsync('approved', { name: 'approved', createdAt: 1, leadSessionId: 'parent', leadAgentId: 'team-lead@approved', members: [{ agentId: 'researcher@approved', name: 'researcher', joinedAt: 1, cwd: home, sessionId: 'worker-a', tmuxPaneId: '', subscriptions: [], backendType: 'process' }] })
    const transcript = await new TeamService().getMemberTranscript('approved', 'researcher@approved')
    expect(JSON.stringify(transcript)).toContain('fixture result')
    expect(calls.sort((x, y) => x.provider.localeCompare(y.provider))).toEqual([
      { provider: 'a', model: 'cheap', credential: 'fake-a', subagentOverride: undefined, omitClaudeMd: '1', presetType: 'fixture:researcher', presetSource: 'plugin' },
      { provider: 'b', model: 'capable', credential: 'fake-b', subagentOverride: undefined, omitClaudeMd: '0', presetType: 'fixture:researcher', presetSource: 'plugin' },
    ])
  } finally {
    await service.stopAllSessionsAndWait(1000)
    bridge.stop(true)
    a.stop(true)
    b.stop(true)
  }
}, 20_000)

test('approval resolves preset snapshots and model aliases against the selected provider', async () => {
  const { validateTeamPlanRuntime } = await import('./teamPlanRuntime.js')
  const provider = await new ProviderService().addProvider({ presetId: 'custom', name: 'Selected', baseUrl: 'http://127.0.0.1:32111', apiKey: 'fake', models: { main: 'selected-main', sonnet: 'selected-sonnet', opus: 'selected-capable', haiku: 'selected-cheap' } })
  const plan = {
    workDir: home, agentCatalog: { researcher: { systemPrompt: 'Approved read-only role', tools: ['Read'], source: 'flagSettings', sourceIdentity: { kind: 'session' } } },
    members: [{ id: 'a', name: 'reader', agentType: 'researcher', prompt: 'research', runtime: { providerId: provider.id, modelId: 'opus' }, agentSnapshot: { systemPrompt: 'untrusted altered snapshot', tools: ['Bash'] } }],
  } as any
  const validated = await validateTeamPlanRuntime(plan)
  expect(validated.members[0]!.runtime.modelId).toBe('selected-capable')
  expect(validated.members[0]!.agentSnapshot?.systemPrompt).toBe('Approved read-only role')
  expect(validated.members[0]!.agentSnapshot?.tools).toEqual(['Read'])
  await expect(validateTeamPlanRuntime({ ...plan, members: [{ ...plan.members[0], runtime: { providerId: provider.id, modelId: 'opus', effortLevel: 'invalid' } }] })).rejects.toThrow('Unsupported reasoning effort')
  await expect(validateTeamPlanRuntime({ ...plan, members: [{ ...plan.members[0], agentType: 'missing' }] })).rejects.toThrow('unavailable')
  for (const setting of [{ isolation: 'worktree' }]) {
    await expect(validateTeamPlanRuntime({ ...plan, agentCatalog: { researcher: { ...plan.agentCatalog.researcher, ...setting } } })).rejects.toThrow('unsupported team worker settings')
  }
  await expect(validateTeamPlanRuntime({ ...plan, agentCatalog: { researcher: { ...plan.agentCatalog.researcher, configurationError: 'Inline MCP servers are unsupported' } } })).rejects.toThrow('Inline MCP servers are unsupported')
  for (const permissionMode of ['plan', 'bypassPermissions']) {
    await expect(validateTeamPlanRuntime({ ...plan, agentCatalog: { researcher: { ...plan.agentCatalog.researcher, permissionMode } } })).rejects.toThrow('requires permission mode')
  }
  await expect(validateTeamPlanRuntime({ ...plan, agentCatalog: { researcher: { ...plan.agentCatalog.researcher, permissionMode: 'default' } } })).resolves.toBeDefined()
  await expect(validateTeamPlanRuntime({ ...plan, members: [{ ...plan.members[0], runtime: { providerId: 'missing-provider', modelId: 'cheap' } }] })).rejects.toThrow()
  const { createHash } = await import('node:crypto')
  const { writeTeamFileAsync } = await import('../../utils/swarm/teamHelpers.js')
  const team = { name: 'conflict-check', createdAt: Date.now(), leadSessionId: 'conflict-parent', leadAgentId: 'team-lead@conflict-check', members: [{ agentId: 'reader@conflict-check', name: 'reader', agentType: 'researcher', joinedAt: Date.now(), backendType: 'process', terminated: true }] } as any
  await writeTeamFileAsync(team.name, team)
  await expect(validateTeamPlanRuntime({ ...plan, teamName: team.name, sessionId: team.leadSessionId, incarnationId: createHash('sha256').update(JSON.stringify([team.name, team.leadSessionId, team.createdAt])).digest('hex') })).rejects.toThrow('Member already exists: reader')
})

test('stopping a parent stops its workers and cancels relayed pending approvals', () => {
  const service = new ConversationService() as any
  const killed: string[] = []
  const events: any[] = []
  service.killProcess = (id: string) => killed.push(id)
  service.sessions.set('parent', { outputCallbacks: [(message: any) => events.push(message)], pendingPermissionRequests: new Map() })
  service.sessions.set('child', { teamWorker: worker, pendingPermissionRequests: new Map([['approval', { toolName: 'Bash', input: {} }]]) })
  service.stopSession('parent')
  expect(killed).toEqual(['child', 'parent'])
  expect(service.hasSession('child')).toBe(false)
  expect(events).toContainEqual({ type: 'control_cancel_request', request_id: 'approval' })
})

test('approved roster launches, materializes canonical tasks, wakes an idle member, and cleans up', async () => {
  const { createHash } = await import('node:crypto')
  const { conversationService: runtimeService } = await import('./conversationService.js')
  const { launchTeamPlanRuntime, stopTeamPlanRuntime, stopTeamPlanRuntimesForParent } = await import('./teamPlanRuntime.js')
  const { writeTeamFileAsync, readTeamFile } = await import('../../utils/swarm/teamHelpers.js')
  const { beginTaskListLifecycle, withTaskListLifecycleLock, getCanonicalTeamTaskListId, listTasks } = await import('../../utils/tasks.js')
  const { writeToMailbox } = await import('../../utils/teammateMailbox.js')
  let requests = 0
  const definitions: any[] = []
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) { requests++; definitions.push(await request.json()); return new Response('done') } })
  const bridge = Bun.serve<{ id: string }>({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      const id = url.pathname.split('/').pop()!
      if (!runtimeService.authorizeSdkConnection(id, url.searchParams.get('token'))) return new Response('denied', { status: 401 })
      return server.upgrade(request, { data: { id } }) ? undefined : new Response('bad', { status: 400 })
    },
    websocket: { open(ws) { runtimeService.attachSdkConnection(ws.data.id, ws) }, message(ws, msg) { runtimeService.handleSdkPayload(ws.data.id, String(msg)) }, close(ws) { runtimeService.detachSdkConnection(ws.data.id, ws) } },
  })
  const oldPort = ProviderService.getServerPort()
  ProviderService.setServerPort(bridge.port!)
  const planId = 'integration-plan'
  try {
    process.env.CLAUDE_CLI_PATH = join(import.meta.dir, '__fixtures__', 'team-worker-cli.ts')
    const provider = await new ProviderService().addProvider({ presetId: 'custom', name: 'local', baseUrl: upstream.url.toString(), apiKey: 'fake', models: { main: 'cheap', sonnet: 'cheap', opus: 'capable', haiku: 'cheap' } })
    const teamName = 'Approval.Team'
    const createdAt = Date.now()
    const team = { name: teamName, createdAt, leadAgentId: `team-lead@${teamName}`, leadSessionId: 'runtime-parent', members: [] }
    await writeTeamFileAsync(teamName, team)
    const taskListId = getCanonicalTeamTaskListId(teamName)
    await withTaskListLifecycleLock(taskListId, () => beginTaskListLifecycle(taskListId, { teamName, createdAt, leadSessionId: 'runtime-parent' }))
    await runtimeService.startSession('runtime-parent', home, `ws://127.0.0.1:${bridge.port}/sdk/runtime-parent?token=parent`, { providerId: provider.id, model: 'cheap', teamWorker: { ...worker, parentSessionId: 'external', name: 'leader' } })
    const member = { id: 'm1', name: 'reader', agentType: 'research', prompt: 'Do research', runtime: { providerId: provider.id, modelId: 'cheap' }, agentSnapshot: { systemPrompt: 'Read only', tools: ['Read'], effortLevel: 'high' } }
    const tasks = [{ id: 'proposal-task', subject: 'Inspect', ownerId: 'm1', dependencies: [] }]
    const plan = { schemaVersion: 1, planId, sessionId: 'runtime-parent', teamName, incarnationId: createHash('sha256').update(JSON.stringify([teamName, 'runtime-parent', createdAt])).digest('hex'), revision: 2, state: 'launching', workDir: home, members: [member], tasks, leaderRuntime: member.runtime, createdAt, updatedAt: createdAt, approvedSnapshot: { revision: 1, members: [member], tasks, leaderRuntime: member.runtime, approvedAt: Date.now(), requestId: 'approve' } } as any
    const { writeFile } = await import('node:fs/promises')
    const { getTeamDir } = await import('../../utils/swarm/teamHelpers.js')
    await writeFile(join(getTeamDir(teamName), 'plan.json'), JSON.stringify(plan))
    const cancelledLaunch = launchTeamPlanRuntime(plan).then(() => { throw new Error('Stopped launch unexpectedly succeeded') }, error => error)
    const admissionDeadline = Date.now() + 5000
    while (runtimeService.getActiveSessions().length < 2 && Date.now() < admissionDeadline) await new Promise(resolve => setTimeout(resolve, 1))
    runtimeService.sendInterrupt('runtime-parent')
    await runtimeService.waitForTeamWorkersStopped('runtime-parent')
    expect(await cancelledLaunch).toBeInstanceOf(Error)
    expect(requests).toBe(0)
    expect(runtimeService.getActiveSessions()).toEqual(['runtime-parent'])
    // A new explicit approval can retry a batch which never released any work.
    plan.revision = 4
    plan.approvedSnapshot.revision = 3
    plan.approvedSnapshot.requestId = 'new-approval'
    await writeFile(join(getTeamDir(teamName), 'plan.json'), JSON.stringify(plan))
    const externallyCancelled = launchTeamPlanRuntime(plan).then(() => { throw new Error('Revoked launch unexpectedly succeeded') }, error => error)
    const readyDeadline = Date.now() + 5000
    while (runtimeService.getActiveSessions().length < 2 && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 1))
    const { mutateTeamPlan } = await import('../../utils/swarm/teamPlanStore.js')
    await mutateTeamPlan(teamName, { ...plan, expectedRevision: plan.revision }, current => ({ ...current, state: 'cancelled' }))
    expect(await externallyCancelled).toBeInstanceOf(Error)
    expect(requests).toBe(0)
    expect(readTeamFile(teamName)?.members).toHaveLength(0)
    plan.revision = 6
    plan.approvedSnapshot.revision = 5
    plan.approvedSnapshot.requestId = 'final-approval'
    await writeFile(join(getTeamDir(teamName), 'plan.json'), JSON.stringify(plan))
    const result = await launchTeamPlanRuntime(plan)
    expect(result.memberIds.m1).toBeTruthy()
    expect((await listTasks(taskListId))[0]?.owner).toBe('reader')
    expect(readTeamFile(teamName)?.members[0]?.model).toBe('cheap')
    const waitFor = async (condition: () => boolean) => {
      const end = Date.now() + 5000
      while (!condition() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20))
      expect(condition()).toBe(true)
    }
    await waitFor(() => requests >= 2)
    expect(definitions.find(body => body.preset.reader)?.preset.reader.effort).toBeUndefined()
    const previous = requests
    await writeToMailbox('reader', { from: 'team-lead', timestamp: new Date().toISOString(), text: 'Continue with another check' }, teamName)
    await waitFor(() => requests > previous)
    await runtimeService.sendMessage(result.memberIds.m1!, 'FIXTURE_SHUTDOWN')
    await waitFor(() => readTeamFile(teamName)?.members[0]?.terminated === true)
    await stopTeamPlanRuntime(planId)
    expect(runtimeService.hasSession(result.memberIds.m1!)).toBe(false)
    expect(readTeamFile(teamName)?.members[0]?.isActive).toBe(false)
  } finally {
    await stopTeamPlanRuntime(planId)
    await runtimeService.stopAllSessionsAndWait(1000)
    ProviderService.setServerPort(oldPort)
    bridge.stop(true)
    upstream.stop(true)
  }
}, 20_000)
