import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { teamPlanRecordSchema, type TeamPlanRecord } from '../../../src/shared/teamPlan'
import { teamRuntimeControlRecordSchema, type TeamRuntimeControlView } from '../../../src/shared/teamRuntimeControl'
import { executeAgentFlowAgainstProvider, type LiveContext } from '../agent-flow/live'
import type { SessionSocket } from '../agent-flow/execute'
import { startMockLlmServer } from './server'
import { decideReply, type MockReply, type MockRequest } from './scriptedModel'
import { stagedPlanIdentity } from './teamReview'

const TIMEOUT_MS = 45_000
const OLD_MODEL = 'mock-runtime-original-a'
const NEW_MODEL = 'mock-runtime-resumed-b'
const COMPLETED_MODEL = 'mock-runtime-completed-a'
const HISTORY = 'TEAM_RUNTIME_READER_ORIGINAL_HISTORY'
const REPORT = 'TEAM_RUNTIME_READER_FRESH_REPORT'
const OLD_MAIL = 'TEAM_RUNTIME_OLD_MAIL_MUST_WAIT'
const CHILD = { reader: 'TEAM_RUNTIME_CHILD_READER', finished: 'TEAM_RUNTIME_CHILD_FINISHED' } as const
type MemberName = keyof typeof CHILD
type ToolBlock = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean; content?: unknown }
type Mail = { id?: string; from: string; text: string; timestamp: string; read: boolean }
type Roster = { name: string; leadSessionId: string; createdAt: number; members: Array<{
  name: string; sessionId?: string; model?: string; providerId?: string; terminated?: boolean; isActive?: boolean
}> }
type ProcessIdentity = { pid: number; ppid: number; started: string; command: string }
type ProviderRequest = {
  endpoint: 'a' | 'b'; path: string; authorization: string | null; apiKey: string | null
  model?: string; body: unknown; at: number; control?: unknown
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map(block => typeof block?.text === 'string' ? block.text : '').join('\n') : ''
}
function blocks(request: MockRequest): ToolBlock[] {
  return (request.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content as ToolBlock[] : [])
}
function workerName(request: MockRequest): MemberName | undefined {
  if (!request.tools?.some(tool => tool.name === 'TaskUpdate')) return
  const first = textContent(request.messages?.find(message => message.role === 'user')?.content)
  return (Object.keys(CHILD) as MemberName[]).find(name => first.includes(CHILD[name]))
}
const textReply = (text: string): MockReply => ({ kind: 'message', content: [{ type: 'text', text }], stopReason: 'end_turn' })
function toolReply(request: MockRequest, id: string, name: string, input: Record<string, unknown>): MockReply {
  const loaded = request.tools?.some(tool => tool.name === name)
  return { kind: 'message', stopReason: 'tool_use', content: [{ type: 'tool_use',
    id: loaded ? id : `${id}-search`, name: loaded ? name : 'ToolSearch', input: loaded ? input : { query: `select:${name}` },
  }] }
}
function toolFinished(request: MockRequest, id: string): boolean {
  const result = blocks(request).find(block => block.type === 'tool_result' && block.tool_use_id === id)
  if (!result) return false
  assert.ok(!result.is_error, `${id}: ${textContent(result.content)}`)
  return true
}
function assignedTaskId(request: MockRequest): string {
  const first = textContent(request.messages?.find(message => message.role === 'user')?.content)
  const instructions = first.split('Approved shared tasks (use TaskGet/TaskUpdate; start a task only once all of its dependencies are completed):\n')[1]
  assert.ok(instructions, 'The real worker must receive its approved shared tasks')
  const assigned = JSON.parse(instructions.split('\n')[0]!) as Array<{ id: string }>
  assert.equal(assigned.length, 1)
  assert.ok(assigned[0]?.id)
  return assigned[0]!.id
}

/**
 * Do not select a process by a broad pgrep or signal a process group. The source
 * wrapper, execution child, parent server, session flags and start time all have
 * to match this disposable run, and are rechecked immediately before signalling.
 * Windows still runs the lead-present Stop path; this optional POSIX branch is
 * explicitly reported as not run there rather than claiming equivalent evidence.
 */
function ownedCli(ctx: LiveContext, rootDir: string, sessionId: string, startedAt: number) {
  assert.ok(ctx.serverProcessId)
  assert.match(sessionId, /^[a-f0-9-]{36}$/i)
  const read = (pid: number, field: string) => {
    const result = Bun.spawnSync(['ps', '-p', String(pid), '-o', `${field}=`])
    assert.equal(result.exitCode, 0, `Owned process ${pid} disappeared during identity verification`)
    return result.stdout.toString().trim()
  }
  const inspect = (pid: number): ProcessIdentity => ({ pid, ppid: Number(read(pid, 'ppid')), started: read(pid, 'lstart'), command: read(pid, 'command') })
  const listing = Bun.spawnSync(['ps', '-ax', '-o', 'pid=,ppid=,command='])
  assert.equal(listing.exitCode, 0, 'Cannot verify disposable CLI process identities')
  const sessionFlags = new RegExp(`(?:^|\\s)--(?:session-id|resume)\\s+${sessionId}(?=\\s|$)`)
  const hasEntrypoint = (command: string, path: string) => {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|[\\s"'])${escaped}(?=[\\s"']|$)`).test(command)
  }
  const rows = listing.stdout.toString().split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    return match && sessionFlags.test(match[3]!) ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : []
  })
  const wrapper = rows.find(row => hasEntrypoint(row.command, join(rootDir, 'bin/claude-haha')) && row.ppid === ctx.serverProcessId)
  assert.ok(wrapper, `No source CLI wrapper owned by server ${ctx.serverProcessId} for ${sessionId}`)
  const child = rows.find(row => hasEntrypoint(row.command, join(rootDir, 'src/entrypoints/cli.tsx')) && row.ppid === wrapper.pid)
  assert.ok(child, `No source execution child of wrapper ${wrapper.pid}`)
  const server = inspect(ctx.serverProcessId)
  assert.ok(hasEntrypoint(server.command, 'src/server/index.ts') || hasEntrypoint(server.command, join(rootDir, 'src/server/index.ts')))
  assert.ok(new RegExp(`(?:^|\\s)--port\\s+${new URL(ctx.baseUrl).port}(?=\\s|$)`).test(server.command), 'Owned server port changed')
  const pair = { wrapper: inspect(wrapper.pid), child: inspect(child.pid) }
  for (const process of Object.values(pair)) {
    const time = Date.parse(process.started)
    assert.ok(Number.isFinite(time) && time >= startedAt - 2_000 && time <= Date.now(), 'CLI start time must belong to this run')
    assert.ok(sessionFlags.test(process.command), 'Exact session identity changed')
  }
  return { ...pair, verify() {
    assert.deepEqual(inspect(server.pid), server, 'Owned application server identity changed')
    for (const process of Object.values(pair)) assert.deepEqual(inspect(process.pid), process)
  } }
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}
function processEvidence(pair: ReturnType<typeof ownedCli>) {
  return Object.fromEntries(['wrapper', 'child'].map(key => {
    const process = pair[key as 'wrapper' | 'child']
    return [key, { pid: process.pid, ppid: process.ppid, started: process.started, commandSha256: createHash('sha256').update(process.command).digest('hex') }]
  }))
}

/** True application server/CLI/tools, two separate fake-key provider origins. */
export async function runTeamRuntimeControlsScenario(rootDir: string, artifactDir: string) {
  mkdirSync(artifactDir, { recursive: true })
  const startedAt = Date.now()
  let finishReader = false
  let scriptError: string | undefined
  let baseUrl = '', configDir = '', workRoot = '', teamName = ''
  let providerA = '', providerB = ''
  const actions: Array<{ method: string; path: string; status: number; at: number; body: unknown }> = []
  const snapshots: Array<{ label: string; at: number; state: unknown }> = []
  const sockets: SessionSocket[] = []
  const requests: ProviderRequest[] = []
  const evidence: Record<string, unknown> = {}
  const upstream = startMockLlmServer((request): MockReply => {
    try {
      const name = workerName(request)
      if (!name) {
        if (textContent(request.messages?.at(-1)?.content).includes(REPORT)) return textReply('TEAM_RUNTIME_LEAD_CONSUMED_FRESH_REPORT')
        return decideReply(request)
      }
      if (name === 'reader' && !finishReader) return textReply(HISTORY)
      const taskId = assignedTaskId(request)
      if (!toolFinished(request, `runtime-${name}-complete`)) return toolReply(request, `runtime-${name}-complete`, 'TaskUpdate', { taskId, status: 'completed' })
      if (!toolFinished(request, `runtime-${name}-report`)) return toolReply(request, `runtime-${name}-report`, 'SendMessage', {
        to: 'team-lead', message: name === 'reader' ? REPORT : 'TEAM_RUNTIME_FINISHED_REPORT', summary: `${name} completed its original task`,
      })
      return textReply(`TEAM_RUNTIME_${name.toUpperCase()}_FINISHED`)
    } catch (error) {
      scriptError = error instanceof Error ? error.message : String(error)
      return textReply(`Fixture rejected a real tool result: ${scriptError}`)
    }
  })
  const gateway = (endpoint: 'a' | 'b') => Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = request.method === 'POST' ? await request.json() as MockRequest : undefined
      let control: unknown
      const controlPath = join(configDir, 'teams', teamName, 'runtime-control.json')
      if (configDir && teamName && existsSync(controlPath)) control = JSON.parse(readFileSync(controlPath, 'utf8'))
      const record: ProviderRequest = { endpoint, path, body, model: body?.model,
        authorization: request.headers.get('authorization'), apiKey: request.headers.get('x-api-key'), at: Date.now(), control }
      requests.push(record)
      if (record.apiKey !== `mock-runtime-key-${endpoint}` || (record.authorization !== null && record.authorization !== `Bearer mock-runtime-key-${endpoint}`)) {
        return Response.json({ error: 'This separate provider origin received the wrong fake credential' }, { status: 401 })
      }
      const forwardedHeaders = new Headers(request.headers)
      forwardedHeaders.delete('host')
      forwardedHeaders.delete('content-length')
      return fetch(`${upstream.url}${path}`, { method: request.method, headers: forwardedHeaders, signal: request.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    },
  })
  const a = gateway('a'), b = gateway('b')
  const originA = `http://127.0.0.1:${a.port}`, originB = `http://127.0.0.1:${b.port}`
  assert.notEqual(originA, originB)
  let outcomes: Awaited<ReturnType<typeof executeAgentFlowAgainstProvider>> = []
  try {
    outcomes = await executeAgentFlowAgainstProvider({
      rootDir, artifactDir, label: 'team-runtime-controls', seedProviders: false, stepTimeoutMs: TIMEOUT_MS,
      sandboxSource: { PATH: process.env.PATH, SHELL: process.env.SHELL, SYSTEMROOT: process.env.SYSTEMROOT,
        CLAUDE_CONFIG_DIR: join(artifactDir, 'unused-source-config') },
      envOverrides: { CC_HAHA_SKIP_DOTENV: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
        CC_HAHA_AGENT_TEAMS_ENABLED: '1', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
      scenarios: [{ id: 'mock-team-runtime-controls', title: 'Stop, edit and explicitly resume the same team across an application server restart (#1878)' }],
      async resolveTarget(server) {
        baseUrl = server.baseUrl
        configDir = server.configDir
        const register = async (name: string, baseUrl: string, apiKey: string) => {
          const response = await fetch(`${server.baseUrl}/api/providers`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ presetId: 'custom', name, baseUrl, apiKey, apiFormat: 'anthropic', authStrategy: 'api_key',
              models: { main: OLD_MODEL, sonnet: OLD_MODEL, haiku: OLD_MODEL, opus: OLD_MODEL } }) })
          assert.equal(response.status, 201, await response.clone().text())
          const body = await response.json() as { provider?: { id: string }; id?: string }
          const id = body.provider?.id ?? body.id
          assert.ok(id)
          return id
        }
        providerA = await register('Runtime loopback A', originA, 'mock-runtime-key-a')
        providerB = await register('Runtime loopback B', originB, 'mock-runtime-key-b')
        return { providerId: providerA, providerName: 'Runtime loopback A', modelId: OLD_MODEL, host: originA, source: 'synthetic isolated loopback providers' }
      },
      runners: { async 'mock-team-runtime-controls'(ctx) {
        workRoot = ctx.workRoot
        const sessionId = await ctx.createSession()
        teamName = `runtime-${sessionId.slice(0, 8)}`
        const teamDir = join(ctx.configDir, 'teams', teamName)
        const taskDir = join(ctx.configDir, 'tasks', teamName)
        const readRoster = () => JSON.parse(readFileSync(join(teamDir, 'config.json'), 'utf8')) as Roster
        const readControlRecord = () => teamRuntimeControlRecordSchema.parse(JSON.parse(readFileSync(join(teamDir, 'runtime-control.json'), 'utf8')))
        const taskFiles = () => Object.fromEntries(readdirSync(taskDir).filter(file => /^\d+\.json$/.test(file)).sort().map(file => [file, readFileSync(join(taskDir, file), 'utf8')]))
        const tasks = () => Object.values(taskFiles()).map(raw => JSON.parse(raw) as { id: string; owner: string; status: string; metadata?: unknown })
        const mailboxFiles = () => Object.fromEntries(readdirSync(join(teamDir, 'inboxes')).filter(file => /\.jsonl?$/.test(file)).sort().map(file => [file, readFileSync(join(teamDir, 'inboxes', file), 'utf8')]))
        const workerRequests = (name: MemberName) => requests.filter(record => record.path.endsWith('/v1/messages') && workerName(record.body as MockRequest) === name)
        const log = () => readFileSync(join(ctx.artifactDir, 'server.log'), 'utf8')
        const exits = (id: string) => log().split(`CLI process for ${id} exited with code`).length - 1
        const starts = (id: string) => log().split(`Starting CLI for ${id},`).length - 1
        const poll = async (check: () => boolean | Promise<boolean>, label: string) => {
          const deadline = Date.now() + TIMEOUT_MS
          while (Date.now() < deadline) {
            assert.equal(scriptError, undefined, scriptError)
            if (await check()) return
            await Bun.sleep(50)
          }
          throw new Error(`Timed out: ${label}`)
        }
        const action = async <T>(method: string, path: string, body?: unknown, expected = 200): Promise<T> => {
          const response = await fetch(`${ctx.baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
          const data = await response.json()
          actions.push({ method, path, status: response.status, at: Date.now(), body: data })
          assert.equal(response.status, expected, JSON.stringify({ path, data }))
          return data as T
        }
        const readPlan = async () => teamPlanRecordSchema.parse((await action<{ plan: unknown }>('GET', `/api/teams/session/${sessionId}/plan`)).plan)
        const connect = async () => { const socket = await ctx.openSocket(sessionId); sockets.push(socket); return socket }
        let socket = await connect()
        ctx.pinRuntime(socket)
        const runTool = async (tool: string, input: Record<string, unknown>) => {
          const since = upstream.requests.length
          let cursor = socket.messages.length
          let invoked = false
          socket.send({ type: 'user_message', content: `MOCK_TEAM_OWNER ${JSON.stringify({ tool, input })}` })
          while (true) {
            const message = await socket.waitFor(message => ['permission_request', 'message_complete', 'error'].includes(message.type) ||
              (message.type === 'tool_use_complete' && message.toolName === tool && !message.parentToolUseId), TIMEOUT_MS, `${tool} result`, cursor)
            cursor = socket.messages.indexOf(message) + 1
            if (message.type === 'error') throw new Error(JSON.stringify(message))
            if (message.type === 'tool_use_complete') { invoked = true; continue }
            if (message.type === 'message_complete') { if (invoked) break; continue }
            socket.send({ type: 'permission_response', requestId: message.requestId, allowed: true })
          }
          return upstream.requests.slice(since).flatMap(record => blocks(record.body).filter(block => block.type === 'tool_result'))
        }
        const approve = async (plan: TeamPlanRecord) => {
          await action('POST', `/api/teams/${teamName}/plan/approve`, { sessionId, planId: plan.planId, incarnationId: plan.incarnationId, expectedRevision: plan.revision, requestId: `human-approve-${plan.planId}` })
          await poll(async () => (await readPlan()).state === 'running', 'approved real plan running')
          return readPlan()
        }
        const submit = async (name: MemberName, revision: number) => {
          await runTool('TeamPlan', { team_name: teamName, operation: 'submit', expected_revision: revision, plan: {
            members: [{ id: name, name, agentType: 'general-purpose', prompt: `${CHILD[name]}: Keep your original shared task identity and report to the lead.`, runtime: { providerId: providerA, modelId: OLD_MODEL } }],
            tasks: [{ id: `task-${name}`, subject: `Original ${name} task`, ownerId: name, dependencies: [] }],
          } })
          await poll(async () => (await readPlan()).state === 'review_pending', `${name} human review`)
          return readPlan()
        }
        let incarnationId = ''
        const identity = () => ({ leadSessionId: sessionId, incarnationId })
        const readControl = async () => {
          const { control } = await action<{ control: TeamRuntimeControlView | null }>('GET', `/api/teams/${teamName}/runtime-control?${new URLSearchParams(identity())}`)
          assert.ok(control)
          return control
        }
        const waitIdle = async (names: MemberName[]) => poll(() => names.every(name => workerRequests(name).length > 0 && readRoster().members.find(member => member.name === name)?.isActive === false), 'real member results settled')
        const stop = async (names: MemberName[], label: string) => {
          const owned = process.platform === 'win32' ? [] : names.map(name => ({ name, process: ownedCli(ctx, rootDir, readRoster().members.find(member => member.name === name)!.sessionId!, startedAt) }))
          const before = Object.fromEntries(names.map(name => { const id = readRoster().members.find(member => member.name === name)!.sessionId!; return [id, exits(id)] }))
          socket.send({ type: 'stop_generation' })
          await poll(async () => (await readControl()).status === 'paused', `${label} server-confirmed paused`)
          await poll(() => Object.entries(before).every(([id, count]) => exits(id) > count), `${label} actual worker process exits`)
          for (const item of owned) assert.ok(!alive(item.process.wrapper.pid) && !alive(item.process.child.pid), `${item.name} survived Main Stop`)
          assert.ok(names.every(name => readRoster().members.find(member => member.name === name)?.terminated === true))
          snapshots.push({ label, at: Date.now(), state: { control: await readControl(), roster: readRoster(), processes: owned.map(item => ({ name: item.name, ...processEvidence(item.process) })) } })
        }
        const resume = async (requestId: string) => {
          const before = await readControl()
          const { control } = await action<{ control: TeamRuntimeControlView }>('POST', `/api/teams/${teamName}/runtime-control/resume`, { ...identity(), expectedRevision: before.revision, requestId })
          assert.equal(control.status, 'running', JSON.stringify(control))
          assert.ok(control.epoch > before.epoch, 'A fresh explicit human action must create a new epoch')
          const durable = readControlRecord()
          assert.equal(durable.resume?.requestId, requestId)
          assert.equal(durable.resume?.epoch, control.epoch)
          snapshots.push({ label: requestId, at: Date.now(), state: { control, durable } })
          return control
        }
        const quiet = async (since: number, label: string) => { await Bun.sleep(1_200); assert.equal(requests.length, since, `${label} sent an upstream request`) }
        const seedOldMail = (recipient: string, from: string) => {
          const path = join(teamDir, 'inboxes', `${recipient}.json`)
          const messages: Mail[] = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
          messages.push({ id: `mailbox-runtime-${recipient}`, from, text: `${OLD_MAIL}:${recipient}`, timestamp: new Date(Date.now() - 60_000).toISOString(), read: false })
          // All worker CLIs have physically exited; this is a persisted old-mail
          // fixture, not an alternate implementation of live message delivery.
          writeFileSync(path, JSON.stringify(messages))
        }
        try {
          await runTool('TeamCreate', { team_name: teamName, description: 'Disposable runtime control regression' })
          const initial = await approve(await submit('reader', (await readPlan()).revision))
          incarnationId = initial.incarnationId
          await waitIdle(['reader'])
          const readerId = readRoster().members.find(member => member.name === 'reader')!.sessionId!
          assert.ok(workerRequests('reader').every(record => record.endpoint === 'a' && record.model === OLD_MODEL))
          // Keep the normal desktop Stop path even where the additional owned
          // lead-exit probe cannot be performed safely (notably Windows).
          await stop(['reader'], 'lead-present Main Stop')
          const beforeFirstResume = workerRequests('reader').length
          await resume('human-baseline-resume')
          await poll(() => workerRequests('reader').length > beforeFirstResume, 'first explicit resume reached original provider')
          await waitIdle(['reader'])

          const stagedResults = await runTool('Agent', { team_name: teamName, name: 'finished', subagent_type: 'general-purpose', description: 'Propose an additional member', prompt: `${CHILD.finished}: Complete the one original shared task and report.` })
          const stagedResult = stagedResults.find(result => textContent(result.content).includes('plan_id:'))
          assert.ok(stagedResult, 'The real Agent must return its staged plan identity')
          const staged = stagedPlanIdentity(stagedResult)
          const addition = await submit('finished', staged.revision)
          assert.equal(addition.planId, staged.planId)
          assert.equal(addition.parentPlanId, initial.planId)
          await approve(addition)
          await waitIdle(['reader', 'finished'])
          await poll(() => tasks().some(task => task.owner === 'finished' && task.status === 'completed'), 'real TaskUpdate completed the added member task')
          await Bun.sleep(500)
          const finishedId = readRoster().members.find(member => member.name === 'finished')!.sessionId!
          const originalIds = { reader: readerId, finished: finishedId }
          const running = await readControl()
          assert.equal(running.members.find(member => member.name === 'finished')?.status, 'completed')
          await action('PATCH', `/api/teams/${teamName}/members/reader@${teamName}/runtime`, { ...identity(), expectedRevision: running.revision, sessionId: readerId, providerId: providerB, modelId: NEW_MODEL }, 409)

          if (process.platform === 'win32') evidence.leadlessStop = { status: 'not run', reason: 'No POSIX source-wrapper/start-time verification on Windows; the normal Main Stop assertions still run' }
          else {
            const lead = ownedCli(ctx, rootDir, sessionId, startedAt)
            const members = Object.fromEntries((Object.keys(originalIds) as MemberName[]).map(name => [name, ownedCli(ctx, rootDir, originalIds[name], startedAt)]))
            const leadExits = exits(sessionId)
            lead.verify()
            process.kill(lead.wrapper.pid, 'SIGTERM')
            await poll(() => exits(sessionId) > leadExits && !alive(lead.wrapper.pid) && !alive(lead.child.pid), 'verified lead CLI actually exited')
            for (const member of Object.values(members)) assert.ok(alive(member.wrapper.pid) && alive(member.child.pid), 'An independent member died with its lead')
            evidence.leadlessStop = { status: 'passed', lead: processEvidence(lead), members: Object.fromEntries(Object.entries(members).map(([name, member]) => [name, processEvidence(member)])) }
          }
          const beforeTasks = taskFiles()
          await stop(['reader', 'finished'], 'Main Stop across current and archived approved plans')
          assert.deepEqual(taskFiles(), beforeTasks, 'Stop changed original tasks')
          seedOldMail('reader', 'finished')
          seedOldMail('team-lead', 'reader')
          const beforeMail = mailboxFiles()
          const pausedRequests = requests.length
          const paused = await readControl()
          assert.equal(paused.resumeEligibleCount, 1, 'Completed/no-work members must be excluded from server resume eligibility')
          const save = async (name: MemberName, providerId: string, modelId: string, effortLevel: string) => {
            const control = await readControl()
            const saved = await action<{ control: TeamRuntimeControlView }>('PATCH', `/api/teams/${teamName}/members/${name}@${teamName}/runtime`, {
              ...identity(), sessionId: originalIds[name], expectedRevision: control.revision, providerId, modelId, effortLevel,
            })
            assert.equal(saved.control.status, 'paused')
            assert.ok(saved.control.revision > control.revision)
          }
          await save('reader', providerB, NEW_MODEL, 'high')
          await save('finished', providerA, COMPLETED_MODEL, 'medium')
          await action('PATCH', `/api/teams/${teamName}/members/reader@${teamName}/runtime`, { ...identity(), sessionId: readerId, expectedRevision: paused.revision, providerId: providerA, modelId: OLD_MODEL }, 409)
          const archivePath = join(teamDir, `plan-${initial.planId}.json`)
          const archived = teamPlanRecordSchema.parse(JSON.parse(readFileSync(archivePath, 'utf8')))
          const current = await readPlan()
          for (const [plan, name, providerId, modelId, effort] of [[archived, 'reader', providerB, NEW_MODEL, 'high'], [current, 'finished', providerA, COMPLETED_MODEL, 'medium']] as const) {
            assert.equal(plan.state, 'running')
            for (const members of [plan.members, plan.approvedSnapshot!.members]) {
              const runtime = members.find(member => member.name === name)!.runtime
              assert.deepEqual({ providerId: runtime.providerId, modelId: runtime.modelId, effortLevel: runtime.effortLevel }, { providerId, modelId, effortLevel: effort })
            }
          }
          const savedFiles = { current: readFileSync(join(teamDir, 'plan.json'), 'utf8'), archive: readFileSync(archivePath, 'utf8') }
          for (let read = 0; read < 2; read++) {
            await action('GET', `/api/teams/${teamName}`)
            await action('GET', `/api/sessions/${readerId}/messages`)
            await readPlan()
            await readControl()
          }
          socket.close()
          socket = await connect()
          await quiet(pausedRequests, 'Paused GET/reconnect/model saves/old peer and leader mail')
          assert.deepEqual(taskFiles(), beforeTasks)
          assert.deepEqual(mailboxFiles(), beforeMail, 'Paused observation or save consumed mailbox/history')
          snapshots.push({ label: 'paused-and-edited', at: Date.now(), state: { originalIds, beforeTasks, beforeMail, control: await readControl(), archived, current } })

          assert.ok(ctx.restartServer, 'A real server restart hook is required; clearing supervisor memory is insufficient')
          const oldServerPid = ctx.serverProcessId
          const oldOwner = readControlRecord()
          socket.close()
          await ctx.restartServer()
          assert.notEqual(ctx.serverProcessId, oldServerPid, 'The application server must be a different OS process')
          const recovered = await readControl()
          const newOwner = readControlRecord()
          assert.notEqual(newOwner.ownerId, oldOwner.ownerId, 'The restarted server must own a new runtime nonce')
          assert.equal(recovered.status, 'paused')
          assert.ok(recovered.epoch > oldOwner.epoch)
          assert.equal(recovered.incarnationId, incarnationId)
          assert.equal(recovered.resumeEligibleCount, 1)
          socket = await connect()
          await action('GET', `/api/teams/${teamName}`)
          await action('GET', `/api/sessions/${readerId}/messages`)
          await quiet(pausedRequests, 'Actual restarted application with old mail/reconnect/GET')
          assert.deepEqual(taskFiles(), beforeTasks)
          assert.deepEqual(mailboxFiles(), beforeMail)
          assert.equal(readFileSync(join(teamDir, 'plan.json'), 'utf8'), savedFiles.current)
          assert.equal(readFileSync(archivePath, 'utf8'), savedFiles.archive)
          for (const name of Object.keys(originalIds) as MemberName[]) assert.equal(readRoster().members.find(member => member.name === name)?.sessionId, originalIds[name])
          evidence.restart = { oldServerPid, newServerPid: ctx.serverProcessId, oldOwner, newOwner, recovered, zeroProviderRequests: requests.length === pausedRequests }

          finishReader = true
          const readerBefore = workerRequests('reader').length
          const finishedBefore = workerRequests('finished').length
          const finishedStarts = starts(finishedId)
          const resumed = await resume('human-resume-after-server-restart')
          await poll(() => workerRequests('reader').length > readerBefore, 'same worker made a real request through the new provider')
          const next = workerRequests('reader')[readerBefore]!
          assert.equal(next.endpoint, 'b')
          assert.equal(next.apiKey, 'mock-runtime-key-b')
          assert.equal(next.model, NEW_MODEL)
          assert.ok(JSON.stringify((next.body as MockRequest).messages).includes(HISTORY), 'Provider switch lost the original worker assistant history')
          const admitted = teamRuntimeControlRecordSchema.parse(next.control)
          assert.equal(admitted.epoch, resumed.epoch)
          assert.equal(admitted.resume?.requestId, 'human-resume-after-server-restart')
          assert.ok(['resuming', 'running'].includes(admitted.status))
          const durableResume = readControlRecord().resume!
          assert.deepEqual(durableResume.eligibleSessionIds, [readerId])
          assert.deepEqual(durableResume.startedSessionIds, [readerId])
          await poll(() => tasks().find(task => task.owner === 'reader')?.status === 'completed', 'resumed CLI completed the same original task')
          await poll(() => requests.some(record => record.at >= next.at && record.path.endsWith('/v1/messages') &&
            (record.body as MockRequest).tools?.some(tool => tool.name === 'TeamPlan') &&
            JSON.stringify((record.body as MockRequest).messages).includes(REPORT)), 'the re-owned real leader consumed the fresh worker report')
          await waitIdle(['reader', 'finished'])
          assert.equal(workerRequests('finished').length, finishedBefore, 'A completed/no-work member was rerun')
          assert.equal(starts(finishedId), finishedStarts, 'A completed/no-work member CLI was unnecessarily restarted')
          assert.deepEqual(tasks().map(task => task.id), Object.values(beforeTasks).map(raw => (JSON.parse(raw) as { id: string }).id))
          for (const name of Object.keys(originalIds) as MemberName[]) assert.equal(readRoster().members.find(member => member.name === name)?.sessionId, originalIds[name])
          const replayBefore = workerRequests('reader').length
          await action('POST', `/api/teams/${teamName}/runtime-control/resume`, { ...identity(), expectedRevision: recovered.revision, requestId: 'human-resume-after-server-restart' })
          await Bun.sleep(1_200)
          assert.equal(workerRequests('reader').length, replayBefore, 'Replaying the same resume request reran paid work')
          assert.equal(workerRequests('finished').length, finishedBefore)
          assert.equal(readControlRecord().epoch, resumed.epoch)
          evidence.resumed = { originalIds, readerBefore, finishedBefore, firstNewRequest: next, control: await readControl(), tasks: tasks(), reportConsumed: true }
          snapshots.push({ label: 'resumed-with-history-and-report', at: Date.now(), state: { roster: readRoster(), control: await readControl(), current: await readPlan(), archived: JSON.parse(readFileSync(archivePath, 'utf8')), tasks: taskFiles(), mail: mailboxFiles() } })

          await stop(['reader'], 'Main Stop after all shared tasks completed')
          assert.equal((await readControl()).resumeEligibleCount, 0)
          const workerStarts = { reader: starts(readerId), finished: starts(finishedId) }
          const workerCalls = { reader: workerRequests('reader').length, finished: workerRequests('finished').length }
          const emptyResume = await resume('human-zero-eligible-resume')
          await Bun.sleep(1_200)
          assert.deepEqual(readControlRecord().resume?.eligibleSessionIds, [])
          assert.deepEqual(readControlRecord().resume?.startedSessionIds, [])
          assert.deepEqual({ reader: starts(readerId), finished: starts(finishedId) }, workerStarts)
          assert.deepEqual({ reader: workerRequests('reader').length, finished: workerRequests('finished').length }, workerCalls)
          evidence.zeroEligibleResume = { control: emptyResume, workerStarts, workerCalls, membersNotRerun: true }
        } finally {
          for (const socket of sockets) socket.close()
        }
      } },
    })
  } finally {
    await Promise.all([a.stop(true), b.stop(true), upstream.stop()])
    const logPath = join(artifactDir, 'server.log')
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    const started = [...log.matchAll(/Starting CLI for ([^\s,]+), cwd:/g)].map(match => match[1]!)
    const exited = [...log.matchAll(/CLI process for ([^ ]+) exited with code /g)].map(match => match[1]!)
    const cleanup = { configRemoved: !configDir || !existsSync(configDir), workRemoved: !workRoot || !existsSync(workRoot), started, exited,
      allCliStartsExited: started.every(id => started.filter(candidate => candidate === id).length <= exited.filter(candidate => candidate === id).length),
      serverClosed: !baseUrl || await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) }).then(() => false, () => true),
      originsClosed: await Promise.all([originA, originB, upstream.url].map(origin => fetch(`${origin}/v1/models`, { signal: AbortSignal.timeout(1_000) }).then(() => false, () => true))),
    }
    writeFileSync(join(artifactDir, 'results.json'), JSON.stringify({ outcomes, evidence, actions, snapshots, scriptError, cleanup }, null, 2) + '\n')
    writeFileSync(join(artifactDir, 'provider-requests.json'), JSON.stringify(requests, null, 2) + '\n')
    writeFileSync(join(artifactDir, 'upstream-requests.json'), JSON.stringify(upstream.requests, null, 2) + '\n')
    writeFileSync(join(artifactDir, 'websocket.json'), JSON.stringify(sockets.map(socket => socket.messages), null, 2) + '\n')
    assert.ok(cleanup.configRemoved && cleanup.workRemoved && cleanup.serverClosed && cleanup.originsClosed.every(Boolean) && cleanup.allCliStartsExited, JSON.stringify(cleanup))
  }
  assert.equal(scriptError, undefined, scriptError)
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0]!.status, 'passed', outcomes[0]!.detail)
  for (const request of requests.filter(request => request.path.endsWith('/v1/messages'))) {
    assert.equal(request.apiKey, `mock-runtime-key-${request.endpoint}`)
    assert.ok(request.endpoint === 'a' ? [OLD_MODEL, COMPLETED_MODEL].includes(request.model!) : request.model === NEW_MODEL, `Unexpected actual model on provider ${request.endpoint}: ${request.model}`)
    if ((request.body as MockRequest).tools?.some(tool => tool.name === 'TeamPlan')) {
      assert.equal(request.endpoint, 'a', 'A member provider edit changed its independent leader provider')
      assert.equal(request.model, OLD_MODEL, 'A member model edit changed its independent leader model')
    }
  }
}
