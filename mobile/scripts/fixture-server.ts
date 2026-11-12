/**
 * LOCAL TEST FIXTURE ONLY. No model calls, child processes, user files or persistence.
 * Always binds 127.0.0.1. Start: bun scripts/fixture-server.ts --port=3457
 * Self-check: bun scripts/fixture-server.ts --self-test
 */
import assert from 'node:assert/strict'
import { profileFixture } from './profile-fixture'
import { validateVoiceWav } from '../../src/server/services/voice/wav'
import { encodeVoiceWav } from '../src/core/voiceWav'
import { isValidCron, type TaskSchedule } from '../../src/shared/taskSchedule'
import type { ServerWebSocket } from 'bun'
import type {
  ClientMessage,
  ServerMessage,
  PermissionMode,
} from '../../src/server/ws/events'
import type { HistoryEntry, Session } from '../src/core/types'
import type { TeamPlanRecord } from '../src/core/teamPlan'
import type {
  BackgroundTask,
  Checkpoint,
  ScheduledTask,
  TaskRun,
} from '../src/core/operations'

export const FIXTURE_TOKEN = 'mobile-fixture'
const FIXTURE_ROOT = '/fixture/cc-haha-demo'
const MODES = [
  'default',
  'acceptEdits',
  'auto',
  'plan',
  'bypassPermissions',
  'dontAsk',
]
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const MODELS = [
  {
    id: 'fixture-sonnet',
    name: 'Fixture Sonnet · No real model',
    description: 'Deterministic local fixture',
    context: '200k',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'high',
  },
  {
    id: 'fixture-opus',
    name: 'Fixture Opus · No real model',
    description: 'Second fixture model',
    context: '200k',
    supportedReasoningEfforts: EFFORTS,
    defaultReasoningEffort: 'high',
  },
]
const FILES: Record<string, string> = {
  'README.md':
    '# cc-haha mobile fixture\n\nThis directory does not exist on disk. This is an in-memory test file.\n',
  'src/index.ts': 'export const message = "Hello from the mobile fixture"\n',
  'src/session.ts': 'export const sessionStatus = "ready"\n',
}
type Socket = ServerWebSocket<{ sessionId: string }>
type Pending = Extract<ServerMessage, { type: 'permission_request' }>
type Runtime = {
  providerId: string | null
  modelId: string
  effortLevel?: string
  openAIFastMode?: boolean
}
type FixtureSession = {
  summary: Session
  messages: HistoryEntry[]
  revision: number
  running: boolean
  generation: number
  runtime: Runtime
  pending: Map<string, Pending>
  sockets: Set<Socket>
  timers: Set<ReturnType<typeof setTimeout>>
  allowedTools: Set<string>
  tasks: BackgroundTask[]
  branch: string
  startedAt: number
  lastProgressAt: number
  completedAt?: number
  terminalOutcome?: 'completed' | 'failed' | 'stopped'
  /** Only the `stalled` scenario sets this; real servers derive it from progress time. */
  stalled?: boolean
  restoredTargets: Set<string>
  streamingText?: string
}
type FixtureOptions = {
  port?: number
  quiet?: boolean
  design?: boolean
  hostName?: string
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function fixturePlan(value: unknown): TaskSchedule | undefined | null {
  if (value === undefined) return undefined
  const data = object(value)
  if (typeof data.timeZone !== 'string') return null
  let plan: TaskSchedule
  if (data.kind === 'once' && typeof data.runAt === 'string') plan = { kind: 'once', runAt: data.runAt, timeZone: data.timeZone }
  else if (data.kind === 'cron' && typeof data.expression === 'string') plan = { kind: 'cron', expression: data.expression, timeZone: data.timeZone }
  else return null
  try { new Intl.DateTimeFormat('en', { timeZone: plan.timeZone }) } catch { return null }
  if (plan.kind === 'cron') return isValidCron(plan.expression) ? plan : null
  return /(Z|[+-]\d{2}:\d{2})$/.test(plan.runAt) && Number.isFinite(Date.parse(plan.runAt)) ? plan : null
}

export function startFixtureServer({
  port = 3457,
  quiet = false,
  design = false,
  hostName = 'MacBook Pro · Fixture',
}: FixtureOptions = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Fixture port must be 0–65535')
  const sessions = new Map<string, FixtureSession>()
  let currentModel = MODELS[0]!.id
  let defaultEffort = 'high'
  let permissionMode: PermissionMode = 'default'
  let activeId = 'fixture-provider'
  let providerSequence = 0
  let settings: Record<string, unknown> = {
    language: 'Chinese',
    outputStyle: 'default',
    chatSendBehavior: 'enter',
    alwaysThinkingEnabled: true,
    workflowKeywordTriggerEnabled: true,
    autoQuestion: { enabled: true, timeoutMinutes: 5 },
    agentTeamsEnabled: true,
  }
  let computerUse = { enabled: false, authorizedApps: [], grantFlags: { clipboardRead: false, clipboardWrite: false, systemKeyCombos: false } }
  const scheduledTasks = new Map<string, ScheduledTask>()
  const scheduledRuns: TaskRun[] = []
  const scheduledSnapshot = (task: ScheduledTask): ScheduledTask => ({
    ...task,
    ...(task.schedule?.kind === 'once' && task.enabled !== false ? { nextRunAt: Date.parse(task.schedule.runAt) } : {}),
    scheduleState: task.enabled === false ? (task.scheduleState === 'completed' ? 'completed' : 'paused') : 'active',
  })
  const branches = new Set(['main', 'feat/qr-pair', 'fix/ws-replay'])
  /** Agent Team plan (at most one per session), placed by the team / team-failed / team-interrupted scenarios. */
  const teamPlans = new Map<string, TeamPlanRecord>()
  function seedTeamPlan(sessionId: string, state: TeamPlanRecord['state']) {
    const runtime = (modelId: string, effortLevel?: string) => ({ providerId: activeId, modelId, ...(effortLevel ? { effortLevel } : {}) })
    const plan: TeamPlanRecord = {
      schemaVersion: 1,
      planId: `fixture-team-${Date.now()}`,
      sessionId,
      teamName: 'taskboard-team',
      incarnationId: 'fixture-incarnation',
      revision: 2,
      state,
      workDir: FIXTURE_ROOT,
      leaderRuntime: runtime(currentModel),
      agentCatalog: {
        'general-purpose': { systemPrompt: '', description: 'General member, can read and write code and run commands' },
        reviewer: { systemPrompt: '', description: 'Read-only review, points out issues without changing code' },
      },
      members: [
        { id: 'backend', name: 'backend-dev', agentType: 'general-purpose', difficulty: 'medium', reason: 'Independently implement FastAPI + SQLite CRUD with pytest tests', prompt: 'You own the FastAPI backend. Read CONTRACT.md first, implement CRUD for /api/tasks per the contract, and write pytest covering sorting and validation. When done, send the API notes to frontend-dev.', runtime: runtime(currentModel), suggestedRuntime: runtime(currentModel) },
        { id: 'frontend', name: 'frontend-dev', agentType: 'general-purpose', difficulty: 'medium', reason: 'React + Vite Single page with list, filters and edit form', prompt: 'You own the React + Vite frontend. Wait for the API notes from backend-dev, then implement the task list, filters and edit form.', runtime: runtime(currentModel), suggestedRuntime: runtime(currentModel) },
        { id: 'qa', name: 'qa-reviewer', agentType: 'reviewer', difficulty: 'low', reason: 'Run end to end, check the contract and edge inputs', prompt: 'After both frontend and backend are done, start both services for an end-to-end check and list where they diverge from CONTRACT.md.', runtime: runtime(MODELS[1]!.id, 'high'), suggestedRuntime: runtime(currentModel) },
      ],
      tasks: [
        { id: 't1', subject: 'Implement backend API and tests', description: 'FastAPI + SQLite, covering create, update, delete and sorting.', ownerId: 'backend', dependencies: [] },
        { id: 't2', subject: 'Implement frontend page', description: 'Task list, status filter, edit form.', ownerId: 'frontend', dependencies: ['t1'] },
        { id: 't3', subject: 'End-to-end acceptance', ownerId: 'qa', dependencies: ['t1', 't2'] },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(state === 'launch_failed' ? { launch: { status: 'failed' as const, error: 'Teammate frontend-dev failed to start: CLI exited with code 1\nstderr: fixture provider rejected the model' } } : {}),
      ...(state === 'interrupted' ? { launch: { status: 'failed' as const, error: 'The worker runtime was interrupted. Started work will not be replayed.' } } : {}),
    }
    teamPlans.set(sessionId, plan)
    announceTeamPlan(plan)
  }
  function announceTeamPlan(plan: TeamPlanRecord) {
    const session = sessions.get(plan.sessionId)
    if (session)
      emit(session, { type: 'team_plan_updated', teamName: plan.teamName, sessionId: plan.sessionId, planId: plan.planId, incarnationId: plan.incarnationId, revision: plan.revision, state: plan.state })
  }
  const providers: Record<string, unknown>[] = [
    {
      id: activeId,
      presetId: 'custom',
      name: 'Fixture API · No real calls',
      apiKey: '',
      hasApiKey: true,
      baseUrl: 'https://fixture.invalid',
      apiFormat: 'anthropic',
      models: {
        main: currentModel,
        haiku: currentModel,
        sonnet: currentModel,
        opus: MODELS[1]!.id,
      },
    },
  ]

  function emit(session: FixtureSession, event: ServerMessage) {
    if (
      ['content_delta', 'tool_result', 'message_complete'].includes(event.type)
    ) {
      session.lastProgressAt = Date.now()
      delete session.stalled
    }
    const payload = JSON.stringify(event)
    for (const ws of session.sockets) if (ws.readyState === 1) ws.send(payload)
  }
  function send(ws: Socket, event: ServerMessage) {
    if (ws.readyState === 1) ws.send(JSON.stringify(event))
  }
  function append(
    session: FixtureSession,
    type: HistoryEntry['type'],
    content: unknown,
    model?: string
  ) {
    session.messages.push({
      id: crypto.randomUUID(),
      type,
      content,
      timestamp: new Date().toISOString(),
      ...(model ? { model } : {}),
    })
    session.revision++
    session.summary.messageCount = session.messages.length
    session.summary.modifiedAt = new Date().toISOString()
  }
  function create(
    id: string,
    title: string,
    input: Record<string, unknown> = {}
  ) {
    const date = new Date().toISOString()
    const runtime = {
      providerId: activeId,
      modelId: currentModel,
      effortLevel: defaultEffort,
    }
    const session: FixtureSession = {
      summary: {
        id,
        title,
        createdAt: date,
        modifiedAt: date,
        messageCount: 0,
        projectPath:
          typeof input.workDir === 'string' ? input.workDir : FIXTURE_ROOT,
        projectRoot: FIXTURE_ROOT,
        workDir:
          typeof input.workDir === 'string' ? input.workDir : FIXTURE_ROOT,
        workDirExists: true,
        workspaceState: 'available',
        permissionMode:
          typeof input.permissionMode === 'string'
            ? input.permissionMode
            : permissionMode,
        agentProfile: input.agentProfile === 'lean' ? 'lean' : 'standard',
        runtimeProviderId: activeId,
        runtimeModelId: currentModel,
        effortLevel: defaultEffort,
      },
      messages: [],
      revision: 0,
      running: false,
      generation: 0,
      runtime,
      pending: new Map(),
      sockets: new Set(),
      timers: new Set(),
      allowedTools: new Set(),
      tasks: [],
      branch:
        typeof object(input.repository).branch === 'string'
          ? String(object(input.repository).branch)
          : 'main',
      startedAt: Date.now(),
      lastProgressAt: Date.now(),
      restoredTargets: new Set(),
    }
    sessions.set(id, session)
    return session
  }
  function schedule(
    session: FixtureSession,
    delay: number,
    action: () => void
  ) {
    const generation = session.generation
    const timer = setTimeout(() => {
      session.timers.delete(timer)
      if (
        session.generation === generation &&
        sessions.get(session.summary.id) === session
      )
        action()
    }, delay)
    session.timers.add(timer)
  }
  function clearTimers(session: FixtureSession) {
    session.generation++
    for (const timer of session.timers) clearTimeout(timer)
    session.timers.clear()
  }
  function complete(session: FixtureSession) {
    session.running = false
    session.completedAt = Date.now()
    session.terminalOutcome = 'completed'
    emit(session, {
      type: 'message_complete',
      usage: { input_tokens: 128, output_tokens: 64 },
      timing: {
        duration_ms: 1000,
        duration_api_ms: 800,
        ttft_ms: 200,
        decode_ms: 600,
      },
    })
    emit(session, { type: 'status', state: 'idle' })
  }
  function stream(session: FixtureSession, text: string, interval = 100) {
    session.streamingText = ''
    const fragments = text.match(/[\s\S]{1,12}/g) ?? ['']
    emit(session, { type: 'content_start', blockType: 'text' })
    fragments.forEach((fragment, index) =>
      schedule(session, interval * (index + 1), () => {
        emit(session, { type: 'content_delta', text: fragment })
        session.streamingText += fragment
        if (index === fragments.length - 1) {
          append(
            session,
            'assistant',
            [{ type: 'text', text }],
            session.runtime.modelId
          )
          delete session.streamingText
          complete(session)
        }
      })
    )
  }
  /** `/steps`: a timeline sample with finished tools, a background agent and a running command. */
  function toolSteps(session: FixtureSession) {
    const file = (path: string) => `${FIXTURE_ROOT}/${path}`
    const steps: [string, Record<string, unknown>, string][] = [
      ['Read', { file_path: file('src/app/connect.tsx') }, 'export default function Connect() {}'],
      ['Grep', { pattern: 'pairHost' }, 'src/core/connectHost.ts:12'],
      ['Glob', { pattern: 'src/core/connect*.ts' }, 'src/core/connectHost.ts'],
      ['Read', { file_path: file('src/core/connectHost.ts') }, 'export async function connectHost() {}'],
      ['Edit', { file_path: file('src/core/connectHost.ts'), old_string: 'save(credential)\nreturn host', new_string: 'await verify(address)\nsave(credential)\nreturn { host, verified: true }' }, 'Fixture edit applied in memory'],
      ['Agent', { description: 'Build the scan page UI', run_in_background: true }, 'Fixture background agent started'],
    ]
    const text = 'Look at the existing connect flow first, then split into the scan page and connection validation. The UI goes to a subagent.'
    emit(session, { type: 'content_start', blockType: 'text' })
    emit(session, { type: 'content_delta', text })
    append(session, 'assistant', [{ type: 'text', text }], session.runtime.modelId)
    steps.forEach(([toolName, input, result], index) =>
      schedule(session, 150 * (index + 1), () => {
        const toolUseId = crypto.randomUUID()
        emit(session, { type: 'content_start', blockType: 'tool_use', toolName, toolUseId })
        emit(session, { type: 'tool_use_complete', toolName, toolUseId, input })
        append(session, 'tool_use', [{ type: 'tool_use', id: toolUseId, name: toolName, input }], session.runtime.modelId)
        emit(session, { type: 'tool_result', toolUseId, content: result, isError: false })
        append(session, 'tool_result', [{ type: 'tool_result', tool_use_id: toolUseId, content: result, is_error: false }])
        if (toolName !== 'Agent') return
        const task: BackgroundTask = {
          taskId: `fixture-steps-${toolUseId.slice(0, 8)}`,
          toolUseId,
          taskType: 'local_agent',
          description: String(input.description),
          status: 'running',
          summary: 'Edit src/app/connect.tsx',
          startedAt: new Date().toISOString(),
        }
        session.tasks.push(task)
        emit(session, {
          type: 'system_notification',
          subtype: 'task_started',
          data: { task_id: task.taskId, tool_use_id: toolUseId, task_type: task.taskType },
        })
      })
    )
    const command = 'bun test src/core/connectHost.test.ts'
    const bashId = crypto.randomUUID()
    schedule(session, 150 * (steps.length + 1), () => {
      emit(session, { type: 'content_start', blockType: 'tool_use', toolName: 'Bash', toolUseId: bashId })
      emit(session, { type: 'tool_use_complete', toolName: 'Bash', toolUseId: bashId, input: { command } })
      append(session, 'tool_use', [{ type: 'tool_use', id: bashId, name: 'Bash', input: { command } }], session.runtime.modelId)
    })
    schedule(session, 150 * (steps.length + 1) + 8000, () => {
      const output = 'bun test v1.3 (fixture)\n src/core/connectHost.test.ts:\n✓ verifies the address before saving\n\n 4 pass\n 0 fail'
      emit(session, { type: 'tool_result', toolUseId: bashId, content: output, isError: false })
      append(session, 'tool_result', [{ type: 'tool_result', tool_use_id: bashId, content: output, is_error: false }])
      stream(session, 'Connection validation now verifies the address before saving credentials; tests pass. The scan page UI is still in progress in the background.')
    })
  }
  function pendingDecision(
    session: FixtureSession,
    kind: 'approval' | 'question' | 'plan' | 'edit',
    broadcast = true,
    multiple = false
  ) {
    const toolName =
      kind === 'question'
        ? 'AskUserQuestion'
        : kind === 'plan'
          ? 'ExitPlanMode'
          : kind === 'edit'
            ? 'Edit'
            : 'Bash'
    const input =
      kind === 'question' && design
        ? {
            questions: [
              {
                question: 'How should old fields be handled?',
                header: 'Migration strategy',
                multiSelect: false,
                options: [
                  {
                    label: 'Keep on migration, stay compatible on read (recommended)',
                    description: 'Older desktop versions can still open the same config',
                  },
                  {
                    label: 'Drop after migration',
                    description: 'Cleaner config; downgrading loses these settings',
                  },
                  {
                    label: 'Keep for one version, then delete',
                    description: 'Clean up next version; needs a todo',
                  },
                ],
              },
            ],
          }
        : kind === 'question'
          ? {
              questions: [
                {
                  question: 'Fixture: which side to check first?',
                  header: 'Platform',
                  options: [
                    { label: 'iOS', description: 'Test iPhone interactions' },
                    { label: 'Android', description: 'Test Android interactions' },
                  ],
                  multiSelect: false,
                },
                {
                  question: 'Fixture: which capabilities to check?',
                  header: 'Capabilities',
                  options: [
                    { label: 'Model settings' },
                    { label: 'Approvals' },
                    { label: 'History restore' },
                  ],
                  multiSelect: true,
                },
              ],
            }
          : kind === 'plan'
            ? {
                plan: design
                  ? '# Pair by scanning the desktop QR code with the camera\n\n1. Scan page: read the address and access token from the QR code\n   `src/app/connect.tsx`\n2. Validate the address; reject addresses with a path or username/password\n   `src/core/connection.ts`\n3. Public links use native pairing, wait for computer approval, 5 minute timeout\n   `src/core/client.ts`\n4. Add tests: QR parsing, timeout and cancel\n   `src/core/connection.test.ts`'
                  : '# Fixture Implementation plan\n\n1. Check the session.\n2. Demo approval.\n3. Verify reconnect.\n\nNo real files will be modified.',
                planFilePath: '/fixture/plans/mobile.md',
                allowedPrompts: [
                  { tool: 'Bash', prompt: 'run fixture checks' },
                ],
              }
            : kind === 'edit'
              ? {
                  // Fake text for the diff preview only; the fixture never writes files.
                  file_path: 'src/core/sessionTransport.ts',
                  old_string:
                    '  const seen = this.delivered\n  for (const message of batch) {\n    const key = message.localId\n    if (seen.has(key)) continue\n    seen.add(key)\n    this.emit(message)\n  }',
                  new_string:
                    '  const seen = this.delivered\n  for (const message of batch) {\n    // replayed messages carry the same serverId\n    const key = message.serverId\n      ?? message.localId\n    if (seen.has(key)) continue\n    seen.add(key)\n    this.emit(message)\n  }',
                }
            : {
                command: design
                  ? 'bun test src/core/sessionTransport.test.ts'
                  : 'echo "FIXTURE: no command is executed"',
                description: 'Simulated command in the test service, not executed shell',
              }
    if (kind === 'question' && multiple) {
      Object.assign(input, { questions: [
        { header: 'A Platform', question: 'Which platform to verify first?', multiSelect: false, options: [{ label: 'Android' }, { label: 'iOS' }] },
        { header: 'B Scope', question: 'Which capabilities need coverage?', multiSelect: true, options: [{ label: 'Composer' }, { label: 'Directories and Git' }, { label: 'Team activity' }] },
        { header: 'C Notes', question: 'Any other requirements?', multiSelect: false, options: [{ label: 'None' }, { label: 'Add later' }] },
        { header: 'D Order', question: 'In what order to verify?', multiSelect: false, options: [{ label: 'Input first, then execution' }, { label: 'Activity first, then input' }] },
      ] })
    }
    const toolUseId = crypto.randomUUID()
    const autoQuestion = object(settings.autoQuestion)
    const request: Pending = {
      type: 'permission_request',
      requestId: crypto.randomUUID(),
      toolName,
      toolUseId,
      input,
      ...(kind === 'question' && autoQuestion.enabled === true
        ? {
            autoAnswerDeadline:
              Date.now() + Number(autoQuestion.timeoutMinutes || 5) * 60000,
          }
        : {}),
    }
    session.running = true
    delete session.completedAt
    delete session.terminalOutcome
    session.pending.set(request.requestId, request)
    if (typeof request.autoAnswerDeadline === 'number')
      schedule(session, request.autoAnswerDeadline - Date.now(), () => {
        if (
          session.pending.get(request.requestId) !== request ||
          request.autoAnswerDeadline === null
        )
          return
        session.pending.delete(request.requestId)
        emit(session, {
          type: 'permission_resolved',
          requestId: request.requestId,
          permissionType: 'tool',
          allowed: true,
        })
        const answer =
          'Fixture: countdown ended, the test service picked the first option; no AI was called.'
        append(session, 'tool_result', [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: answer,
            is_error: false,
          },
        ])
        emit(session, {
          type: 'tool_result',
          toolUseId,
          content: answer,
          isError: false,
        })
        stream(session, answer)
      })
    append(
      session,
      'tool_use',
      [
        ...(!design ? [{ type: 'text', text: 'Fixture: your response is needed.' }] : []),
        { type: 'tool_use', id: toolUseId, name: toolName, input },
      ],
      session.runtime.modelId
    )
    if (broadcast) {
      emit(session, {
        type: 'content_start',
        blockType: 'tool_use',
        toolName,
        toolUseId,
      })
      emit(session, { type: 'tool_use_complete', toolName, toolUseId, input })
      emit(session, { type: 'status', state: 'permission_pending' })
      emit(session, request)
    }
  }
  function seed() {
    if (design) return seedDesign()
    const chat = create('fixture-chat', 'Fixture · Regular chat and history')
    for (let i = 1; i <= 4; i++) {
      append(chat, 'user', `Test question ${i}`)
      append(
        chat,
        'assistant',
        [{ type: 'text', text: `Fixture History reply ${i}, no model called.` }],
        currentModel
      )
    }
    append(
      chat,
      'tool_use',
      [
        { type: 'text', text: 'This is text before the tool call and should show as assistant content.' },
        {
          type: 'tool_use',
          id: 'seed-read',
          name: 'Read',
          input: { file_path: `${FIXTURE_ROOT}/README.md` },
        },
      ],
      currentModel
    )
    append(chat, 'tool_result', [
      {
        type: 'tool_result',
        tool_use_id: 'seed-read',
        content: [{ type: 'text', text: FILES['README.md'] }],
        is_error: false,
      },
    ])
    for (const [kind, label] of [
      ['approval', 'Action approval'],
      ['question', 'Answer question'],
      ['plan', 'Confirm plan'],
    ] as const) {
      const session = create(`fixture-${kind}`, `Fixture · ${label}`, {
        permissionMode: kind === 'plan' ? 'plan' : 'default',
      })
      append(session, 'user', `Please demo ${label}`)
      pendingDecision(session, kind, false)
    }
  }
  function seedDesign() {
    const approval = create('fixture-approval', 'Fix duplicate messages after WebSocket reconnect')
    append(
      approval,
      'user',
      'After reconnecting the same reply shows up twice. Find the cause, fix it, and add a regression test.'
    )
    append(
      approval,
      'assistant',
      [
        {
          type: 'text',
          text: 'Found the cause: on reconnect the CLI replays buffered messages, the frontend dedupes by temporary id, and replayed messages get new ids so they slip through. I switched to deduping by the stable server id.\n\nNext I will run the related tests to confirm there is no regression.',
        },
      ],
      currentModel
    )
    pendingDecision(approval, 'approval', false)
    const question = create('fixture-question', 'Migrate settings storage to v3')
    append(question, 'user', 'Migrate settings storage to v3 while keeping compatibility.')
    append(
      question,
      'assistant',
      [
        {
          type: 'text',
          text: 'Migration script is written. The old settings.json has 3 fields no longer used in v3: \n\n`sidebarWidth`  `legacyTheme`  `pinnedTabs`',
        },
      ],
      currentModel
    )
    pendingDecision(question, 'question', false)
    const plan = create('fixture-plan', 'Add QR pairing to mobile', {
      repository: { branch: 'feat/qr-pair' },
    })
    append(plan, 'user', 'Add QR pairing to mobile.')
    append(
      plan,
      'assistant',
      [
        {
          type: 'text',
          text: 'Organizing the scan page and connection validation; two subagents assigned.',
        },
      ],
      currentModel
    )
    plan.running = true
    plan.startedAt = Date.now() - 724000
    plan.tasks = [
      {
        taskId: 'fixture-agent-ui',
        toolUseId: 'fixture-tool-ui',
        taskType: 'local_agent',
        description: 'Scan page UI',
        status: 'running',
        summary: 'Edit src/app/connect.tsx',
        startedAt: new Date(Date.now() - 192000).toISOString(),
      },
      {
        taskId: 'fixture-agent-test',
        toolUseId: 'fixture-tool-test',
        taskType: 'local_agent',
        description: 'Pairing timeout tests',
        status: 'running',
        summary: 'Running bun test src/core/connection…',
        startedAt: new Date(Date.now() - 100000).toISOString(),
      },
      {
        taskId: 'fixture-command',
        toolUseId: 'fixture-tool-command',
        taskType: 'local_bash',
        description: 'bun run fixture',
        status: 'running',
        result:
          'fixture listening on 127.0.0.1:3457\nGET /api/sessions 200 · 4ms\nWS /ws/s-7f2c connected',
        startedAt: new Date(Date.now() - 1102000).toISOString(),
      },
    ]
    const bench = create('fixture-bench', 'Investigate Windows sidecar memory usage')
    append(bench, 'user', 'Investigate Windows sidecar memory usage.')
    append(
      bench,
      'assistant',
      [{ type: 'text', text: 'Comparing memory curves after repeated requests.' }],
      currentModel
    )
    bench.running = true
    bench.startedAt = Date.now() - 277000
    bench.tasks = [
      {
        taskId: 'fixture-bench-task',
        taskType: 'local_bash',
        description: 'bun run bench',
        status: 'running',
        result: 'Fixture: sample 1 / 20, no process spawned',
        startedAt: new Date(bench.startedAt).toISOString(),
      },
    ]
    for (const [id, title, response] of [
      [
        'fixture-release',
        'Prepare v0.7.6 release notes',
        'Release notes are ready, covering new features, fixes and compatibility notes.',
      ],
      [
        'fixture-settings',
        'Unify desktop settings page groups',
        'Settings groups are now General, Models, Tools and Connections.',
      ],
    ]) {
      const session = create(id!, title!)
      append(session, 'user', title)
      append(
        session,
        'assistant',
        [{ type: 'text', text: response }],
        currentModel
      )
    }
    // Stable display order, all completed samples are explicitly idle and dated today.
    const midnight = new Date().setHours(0, 0, 0, 0)
    for (const [index, session] of [...sessions.values()].entries())
      session.summary.modifiedAt = new Date(
        Math.max(midnight, Date.now() - index * 180000)
      ).toISOString()
    for (const id of ['fixture-release', 'fixture-settings']) {
      const session = sessions.get(id)!
      session.completedAt = Date.parse(session.summary.modifiedAt)
      session.terminalOutcome = 'completed'
    }
    for (const [index, [name, cron, enabled]] of [
      ['Daily dependency security check', '0 9 * * *', true],
      ['Clean up merged branches', '0 10 * * 1', true],
      ['Sort yesterday’s new issue', '30 8 * * 1-5', true],
      ['Weekly report: merged this week PR', '0 18 * * 5', false],
    ].entries()) {
      const id = `fixture-schedule-${index + 1}`
      scheduledTasks.set(id, {
        id,
        name: String(name),
        cron: String(cron),
        prompt: `Fixture only: ${name}`,
        enabled: Boolean(enabled),
        recurring: true,
        permanent: true,
        folderPath: FIXTURE_ROOT,
        createdAt: Date.now() - 86400000,
      })
      if (index === 0 || index === 2)
        scheduledRuns.push({
          id: `fixture-run-${index}`,
          taskId: id,
          taskName: String(name),
          startedAt: new Date(Date.now() - 3600000).toISOString(),
          completedAt: new Date(Date.now() - 3590000).toISOString(),
          status: 'completed',
          output:
            index === 0
              ? 'Fixture: 1 high-severity dependency found (design review sample)'
              : 'Fixture: 7 new issues (design review sample)',
          durationMs: 10000,
        })
    }
  }
  seed()

  function applyRuntime(session: FixtureSession, value: Runtime): boolean {
    const provider =
      value.providerId === null ||
      providers.some((item) => item.id === value.providerId)
    const modelIds = new Set([
      ...MODELS.map((model) => model.id),
      ...providers.flatMap((item) =>
        Object.values(object(item.models)).filter(
          (id): id is string => typeof id === 'string'
        )
      ),
    ])
    if (
      !provider ||
      !modelIds.has(value.modelId) ||
      (value.effortLevel !== undefined && !EFFORTS.includes(value.effortLevel))
    )
      return false
    session.runtime = {
      providerId: value.providerId,
      modelId: value.modelId,
      ...(value.effortLevel === undefined
        ? {}
        : { effortLevel: value.effortLevel }),
      ...(value.openAIFastMode === undefined
        ? {}
        : { openAIFastMode: value.openAIFastMode }),
    }
    Object.assign(session.summary, {
      runtimeProviderId: value.providerId,
      runtimeModelId: value.modelId,
      effortLevel: value.effortLevel,
    })
    emit(session, { type: 'runtime_config_applied', ...session.runtime })
    return true
  }
  function stop(session: FixtureSession) {
    clearTimers(session)
    if (session.streamingText)
      append(
        session,
        'assistant',
        [{ type: 'text', text: session.streamingText }],
        session.runtime.modelId
      )
    delete session.streamingText
    for (const request of session.pending.values())
      emit(session, {
        type: 'permission_resolved',
        requestId: request.requestId,
        permissionType: 'tool',
        allowed: false,
      })
    session.pending.clear()
    for (const task of session.tasks)
      if (task.status === 'running') stopBackground(session, task)
    session.running = false
    delete session.completedAt
    session.terminalOutcome = 'stopped'
    append(session, 'system', { subtype: 'generation_stopped' })
    emit(session, { type: 'status', state: 'idle' })
    emit(session, {
      type: 'session_state',
      turnState: 'idle',
      activeBackgroundTaskIds: [],
    })
  }
  function stopBackground(session: FixtureSession, task: BackgroundTask) {
    task.status = 'stopped'
    task.summary = 'Test service stopped this simulated activity'
    emit(session, {
      type: 'system_notification',
      subtype: 'task_notification',
      message: task.summary,
      data: {
        task_id: task.taskId,
        tool_use_id: task.toolUseId,
        task_type: task.taskType,
        description: task.description,
        status: 'stopped',
        summary: task.summary,
      },
    })
  }
  function mobileActivity(session: FixtureSession) {
    const pending = [...session.pending.values()][0]
    const input = object(pending?.input)
    return {
      id: session.summary.id,
      activityState: pending ? 'waiting' : session.running ? 'running' : 'idle',
      startedAt: session.startedAt,
      lastProgressAt: session.lastProgressAt,
      stalled: Boolean(session.running && !pending && session.stalled),
      ...(!pending && !session.running && session.terminalOutcome
        ? { terminalOutcome: session.terminalOutcome, ...(session.completedAt !== undefined ? { completedAt: session.completedAt } : {}) }
        : {}),
      ...(pending
        ? {
            requestId: pending.requestId,
            toolName: pending.toolName,
            preview:
              pending.toolName === 'AskUserQuestion'
                ? 'Keep old fields or drop them?'
                : typeof input.command === 'string'
                  ? input.command
                  : pending.toolName === 'ExitPlanMode'
                    ? 'Plan awaiting confirmation'
                    : 'Waiting for tool permission',
            autoAnswerDeadline: pending.autoAnswerDeadline,
          }
        : {}),
    }
  }
  function checkpoints(session: FixtureSession): Checkpoint[] {
    const users = session.messages.filter((message) => message.type === 'user')
    return users.map((message, index) => ({
      target: {
        targetUserMessageId: message.id,
        userMessageIndex: index,
        userMessageCount: users.length,
      },
      conversation: {
        messagesRemoved:
          session.messages.length - session.messages.indexOf(message),
      },
      code: {
        available: true,
        filesChanged: session.restoredTargets.has(message.id)
          ? []
          : design
            ? [
                'src/server/ws/replay.ts',
                'src/core/sessionTransport.ts',
                'src/core/sessionTransport.test.ts',
              ]
            : ['src/session.ts'],
        insertions: session.restoredTargets.has(message.id)
          ? 0
          : design
            ? 46
            : 1,
        deletions: session.restoredTargets.has(message.id)
          ? 0
          : design
            ? 12
            : 1,
      },
      restoreAvailable: true,
      unverifiedChangeSources: [],
      startedAt: Date.parse(message.timestamp),
      workDir: session.summary.workDir,
    }))
  }
  function repositoryContext(workDir = FIXTURE_ROOT) {
    if (!workDir.startsWith(FIXTURE_ROOT)) return { state: 'not_git_repo', workDir, currentBranch: null, branches: [], worktrees: [] }
    return {
      state: 'ok',
      workDir,
      repoRoot: FIXTURE_ROOT,
      repoName: 'claude-code-haha',
      currentBranch: 'main',
      defaultBranch: 'main',
      headCommit: '0000000000000000000000000000000000000001',
      dirty: true,
      branches: [...branches].map((name) => ({
        name,
        current: name === 'main',
        local: true,
        remote: false,
        checkedOut: name === 'main',
      })),
      worktrees: [],
    }
  }
  const checkpointDiff = (path: string) =>
    design
      ? `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -42,7 +42,9 @@ replayBuffered\n export function replayBuffered(s, ws) {\n   const seen = s.deliveredIds\n   for (const m of s.buffer) {\n-    if (seen.has(m.tempId)) continue\n+    const key = m.serverId ?? m.tempId\n+    if (seen.has(key)) continue\n+    seen.add(key)\n     ws.send(encode(m))\n   }\n }\n`
      : '--- a/src/session.ts\n+++ b/src/session.ts\n@@ -1 +1 @@\n-export const sessionStatus = "pending"\n+export const sessionStatus = "ready"\n'
  function receive(ws: Socket, message: ClientMessage) {
    const session = sessions.get(ws.data.sessionId)
    if (!session)
      return send(ws, {
        type: 'error',
        code: 'NOT_FOUND',
        message: 'Fixture session not found',
      })
    switch (message.type) {
      case 'ping':
        return send(ws, { type: 'pong' })
      case 'sync_state':
        return send(ws, {
          type: 'session_state',
          turnState: session.running ? 'running' : 'idle',
          activeBackgroundTaskIds: session.tasks
            .filter((task) => task.status === 'running')
            .map((task) => task.taskId),
        })
      case 'prewarm_session':
        return
      case 'ask_user_question_activity': {
        const request = session.pending.get(message.requestId)
        if (
          request?.toolName === 'AskUserQuestion' &&
          request.autoAnswerDeadline !== null
        ) {
          request.autoAnswerDeadline = null
          emit(session, request)
        }
        return
      }
      case 'set_runtime_config':
        if (session.running)
          return send(ws, {
            type: 'error',
            code: 'RUNTIME_CONFIG_INVALID',
            message:
              'Stop the active turn before changing runtime configuration',
          })
        if (!applyRuntime(session, message))
          send(ws, {
            type: 'error',
            code: 'RUNTIME_CONFIG_INVALID',
            message: 'Unknown fixture model, provider or effort',
          })
        return
      case 'set_permission_mode':
        if (
          !MODES.includes(message.mode) ||
          (message.mode === 'plan' && session.summary.agentProfile === 'lean')
        )
          return send(ws, {
            type: 'error',
            code: 'PERMISSION_MODE_INVALID',
            message: 'Unsupported fixture permission mode',
          })
        session.summary.permissionMode = message.mode
        emit(session, { type: 'permission_mode_changed', mode: message.mode })
        return
      case 'stop_generation':
        return stop(session)
      case 'stop_background_task': {
        const task = session.tasks.find(
          (task) => task.taskId === message.taskId && task.status === 'running'
        )
        if (!task)
          return send(ws, {
            type: 'background_task_stop_failed',
            taskId: message.taskId,
            message: 'Fixture has no running background task with this ID',
          })
        return stopBackground(session, task)
      }
      case 'permission_response': {
        const request = session.pending.get(message.requestId)
        if (!request)
          return send(ws, {
            type: 'permission_requests_snapshot',
            toolRequestIds: [...session.pending.keys()],
            computerUseRequestIds: [],
            turnActive: session.running,
          })
        if (message.allowed && request.toolName === 'AskUserQuestion') {
          const answers = object(message.updatedInput?.answers)
          const questions = object(request.input).questions as {
            question: string
          }[]
          if (
            questions.some(
              (q) =>
                typeof answers[q.question] !== 'string' ||
                !(answers[q.question] as string).trim()
            )
          )
            return send(ws, {
              type: 'error',
              code: 'INVALID_QUESTION_ANSWER',
              message: 'Answer every fixture question',
            })
        }
        if (
          message.allowed &&
          request.toolName === 'ExitPlanMode' &&
          message.runtimeOverride &&
          !applyRuntime(session, message.runtimeOverride)
        )
          return send(ws, {
            type: 'error',
            code: 'RUNTIME_CONFIG_INVALID',
            message: 'Fixture plan remains pending: invalid execution model',
          })
        // Like the real server, session setMode updates apply to any approval
        // (plan execution mode or “auto-accept edits” on a file edit).
        if (message.allowed)
          for (const update of message.permissionUpdates ?? []) {
            const value = object(update)
            if (
              value.type === 'setMode' &&
              value.destination === 'session' &&
              typeof value.mode === 'string' &&
              MODES.includes(value.mode)
            ) {
              session.summary.permissionMode = value.mode
              emit(session, {
                type: 'permission_mode_changed',
                mode: value.mode as PermissionMode,
              })
            }
          }
        if (message.allowed && message.rule === 'always')
          session.allowedTools.add(request.toolName)
        session.pending.delete(message.requestId)
        emit(session, {
          type: 'permission_resolved',
          requestId: message.requestId,
          permissionType: 'tool',
          allowed: message.allowed,
        })
        const answer =
          request.toolName === 'AskUserQuestion'
            ? JSON.stringify(message.updatedInput?.answers ?? {})
            : message.allowed
              ? 'Fixture Action allowed; no real action was performed.'
              : `Fixture: feedback received: ${message.denyMessage || 'Deny this action'}`
        append(session, 'tool_result', [
          {
            type: 'tool_result',
            tool_use_id: request.toolUseId,
            content: answer,
            is_error: !message.allowed,
          },
        ])
        emit(session, {
          type: 'tool_result',
          toolUseId: request.toolUseId!,
          content: answer,
          isError: !message.allowed,
        })
        stream(
          session,
          request.toolName === 'ExitPlanMode' && !message.allowed
            ? 'Fixture: will keep refining the plan based on your feedback.'
            : `Fixture: response received. ${answer}`
        )
        return
      }
      case 'user_message': {
        if (typeof message.content !== 'string')
          return send(ws, {
            type: 'error',
            code: 'PARSE_ERROR',
            message: 'content must be a string',
          })
        const materials = message.attachments ?? []
        if (
          materials.some(
            (item) =>
              !['image', 'file'].includes(item.type) ||
              typeof item.data !== 'string' ||
              !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)
          )
        )
          return send(ws, {
            type: 'error',
            code: 'INVALID_ATTACHMENT',
            message:
              'Fixture requires inline base64 material; it never reads paths',
          })
        const blocks: Record<string, unknown>[] = message.content
          ? [{ type: 'text', text: message.content }]
          : []
        for (const item of materials)
          blocks.push(
            item.type === 'image'
              ? {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: item.mimeType ?? 'image/png',
                    data: item.data,
                  },
                }
              : {
                  type: 'text',
                  text: `[Files: ${item.name ?? 'Attachment'}]\n${Buffer.from(item.data!, 'base64').toString('utf8')}`,
                }
          )
        append(session, 'user', materials.length ? blocks : message.content)
        emit(session, { type: 'user_message_replay', content: message.content })
        if (session.running) {
          emit(session, {
            type: 'system_notification',
            subtype: 'fixture_followup',
            message: 'Fixture: follow-up received, the current request is still in progress.',
          })
          return
        }
        clearTimers(session)
        session.running = true
        delete session.completedAt
        delete session.terminalOutcome
        session.startedAt = Date.now()
        session.lastProgressAt = Date.now()
        delete session.stalled
        emit(session, { type: 'status', state: 'thinking', verb: 'Fixture' })
        const prompt = message.content.toLowerCase()
        if (/\/error|simulate error/.test(prompt))
          return schedule(session, 200, () => {
            session.running = false
            session.terminalOutcome = 'failed'
            emit(session, {
              type: 'error',
              code: 'FIXTURE_ERROR',
              message: 'This is a clearly labeled simulated failure; you can keep sending new messages.',
              retryable: true,
            })
            emit(session, { type: 'status', state: 'idle' })
          })
        if (/\/question|answer question|ask/.test(prompt))
          return schedule(session, 200, () =>
            pendingDecision(session, 'question')
          )
        if (/\/plan|plan/.test(prompt))
          return schedule(session, 200, () => pendingDecision(session, 'plan'))
        if (/\/edit|edit file/.test(prompt))
          return schedule(session, 200, () => pendingDecision(session, 'edit'))
        if (/\/steps/.test(prompt)) return schedule(session, 200, () => toolSteps(session))
        if (
          /\/approval|approval|approve/.test(prompt) &&
          !session.allowedTools.has('Bash')
        )
          return schedule(session, 200, () =>
            pendingDecision(session, 'approval')
          )
        if (/\/retry|simulate retry/.test(prompt))
          emit(session, {
            type: 'api_retry',
            attempt: 1,
            maxRetries: 2,
            retryDelayMs: 200,
            errorStatus: 429,
          })
        schedule(session, 180, () => {
          emit(session, {
            type: 'thinking',
            text: 'This is a visible fixture thinking block.',
            complete: true,
          })
          const toolUseId = crypto.randomUUID()
          const input = { file_path: `${FIXTURE_ROOT}/README.md` }
          emit(session, {
            type: 'content_start',
            blockType: 'tool_use',
            toolName: 'Read',
            toolUseId,
          })
          emit(session, {
            type: 'content_delta',
            toolInput: JSON.stringify(input),
          })
          emit(session, {
            type: 'tool_use_complete',
            toolName: 'Read',
            toolUseId,
            input,
          })
          append(
            session,
            'tool_use',
            [{ type: 'tool_use', id: toolUseId, name: 'Read', input }],
            session.runtime.modelId
          )
          const content = FILES['README.md']!
          emit(session, {
            type: 'tool_result',
            toolUseId,
            content,
            isError: false,
          })
          append(session, 'tool_result', [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content,
              is_error: false,
            },
          ])
          stream(
            session,
            `Fixture: received “${message.content}”. This reply was sent in parts over the real WebSocket protocol without calling a model or accessing computer files.`,
            /\/slow|slow/.test(prompt) ? 700 : 100
          )
        })
        return
      }
      default:
        return send(ws, {
          type: 'error',
          code: 'UNKNOWN_TYPE',
          message: 'Unsupported fixture message type',
        })
    }
  }

  const server = Bun.serve<{ sessionId: string }>({
    hostname: '127.0.0.1',
    port,
    maxRequestBodySize: 8 * 1024 * 1024,
    async fetch(request, server) {
      const url = new URL(request.url)
      const origin = request.headers.get('Origin')
      let allowedOrigin = false
      if (origin) {
        try {
          const candidate = new URL(origin)
          allowedOrigin =
            ['http:', 'https:'].includes(candidate.protocol) &&
            // Android Emulator reaches the host loopback through this alias.
            ['127.0.0.1', 'localhost', '[::1]', '10.0.2.2'].includes(
              candidate.hostname
            )
        } catch {
          /* rejected below */
        }
      }
      const headers: Record<string, string> = {
        'Cache-Control': 'no-store',
        'X-CC-Haha-Fixture': 'true',
      }
      if (allowedOrigin && origin)
        Object.assign(headers, {
          'Access-Control-Allow-Origin': origin,
          Vary: 'Origin',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods':
            'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        })
      const json = (value: unknown, status = 200) =>
        Response.json(value, { status, headers })
      const fail = (message: string, status = 400, code = 'BAD_REQUEST') =>
        json({ error: code, message }, status)
      if (origin && !allowedOrigin)
        return fail(
          'Fixture permits only loopback and Android Emulator host origins',
          403,
          'FORBIDDEN'
        )
      if (request.method === 'OPTIONS')
        return new Response(null, { status: 204, headers })
      if (url.pathname === '/' || url.pathname === '/health')
        return json({
          status: 'ok',
          fixture: true,
          warning: 'LOCAL FIXTURE ONLY — no models or real files',
          token: FIXTURE_TOKEN,
        })
      const token =
        request.headers.get('Authorization')?.replace(/^Bearer /, '') ??
        (url.pathname.startsWith('/ws/') ? url.searchParams.get('token') : null)
      if (token !== FIXTURE_TOKEN)
        return fail(
          'Invalid fixture token; use mobile-fixture',
          401,
          'UNAUTHORIZED'
        )
      if (url.pathname.startsWith('/ws/')) {
        const sessionId = url.pathname.split('/')[2]!
        if (!sessions.has(sessionId))
          return fail('Fixture session not found', 404, 'NOT_FOUND')
        return server.upgrade(request, { data: { sessionId } })
          ? undefined
          : fail('WebSocket upgrade failed')
      }
      // Deterministic transcription boundary for microphone UI smoke tests.
      // Validate real WAV bytes but never load a speech model or user assets.
      if (url.pathname === '/api/voice/catalog' && request.method === 'GET')
        return json({
          supported: true,
          preferences: { enabled: true, providerId: 'sensevoice-local', language: 'auto', downloadSource: 'auto' },
          providers: [{ info: { id: 'sensevoice-local', name: 'Fixture Local voice', location: 'local', languages: ['auto', 'zh', 'en'] }, preparation: { phase: 'ready' } }],
          limits: { maxAudioSeconds: 120, maxAudioBytes: 4 * 1024 * 1024 },
        })
      if (url.pathname === '/api/voice/transcribe' && request.method === 'POST') {
        try {
          const wav = new Uint8Array(await request.arrayBuffer())
          const { audioSeconds } = validateVoiceWav(wav)
          await Bun.sleep(250)
          return json({ text: 'Voice transcription test text (local fixture)', audioSeconds, inferenceSeconds: 0 })
        } catch {
          return fail('Fixture expects mono PCM16 16 kHz WAV', 400, 'voice/invalid-audio')
        }
      }
      let body: Record<string, unknown> = {}
      if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
        const raw = await request.text()
        try {
          body = raw ? object(JSON.parse(raw)) : {}
        } catch {
          return fail('Invalid JSON body')
        }
      }
      const path = url.pathname
      const method = request.method
      if (path === '/api/desktop-ui/preferences/profile' && method === 'GET')
        return json({ profile: profileFixture(hostName).profile })
      if (path === '/api/activity-stats' && method === 'GET') {
        const { profile: _profile, ...activity } = profileFixture(hostName)
        return json(activity)
      }
      if (path === '/api/h5-access/verify')
        return method === 'POST'
          ? json({ ok: true })
          : fail(
              `Method ${method} not allowed on /api/h5-access/verify`,
              405,
              'METHOD_NOT_ALLOWED'
            )
      if (path === '/api/status' && method === 'GET')
        return json({
          status: 'ok',
          version: 'mobile-fixture',
          uptime: Math.round(performance.now()),
          fixture: true,
        })
      // Computer directories are deterministic fixture values, never host filesystem reads.
      if (path === '/api/filesystem/browse' && method === 'GET') {
        const currentPath = url.searchParams.get('path') || '/fixture'
        const tree: Record<string, string[]> = {
          '/fixture': ['cc-haha-demo', 'Sample project', 'empty'],
          [FIXTURE_ROOT]: ['src', 'mobile'],
          [`${FIXTURE_ROOT}/src`]: [],
          [`${FIXTURE_ROOT}/mobile`]: [],
          '/fixture/Sample project': [],
          '/fixture/empty': [],
        }
        const children = tree[currentPath]
        if (!children) return fail('Fixture directory not found', 404, 'NOT_FOUND')
        return json({
          currentPath,
          parentPath: currentPath === '/fixture' ? '/fixture' : currentPath.slice(0, currentPath.lastIndexOf('/')),
          entries: children.map((name) => ({ name, path: `${currentPath}/${name}`, isDirectory: true })),
        })
      }
      if (path === '/api/skills/commands' && method === 'GET')
        return json({ commands: [
          { name: 'compact', kind: 'command', description: 'Compact context (fixture command)' },
          { name: 'init', kind: 'command', description: 'Initialize project notes (fixture command)' },
        ] })
      if (path === '/api/skills/mentions' && method === 'GET')
        return json({ skills: [
          { kind: 'skill', id: 'review', name: 'review', displayName: 'Code review', description: 'Check current changes (local fixture)', source: 'fixture', modelText: 'Use the Skill tool with skill: "review" for this request.' },
          { kind: 'skill', id: 'explain', name: 'explain', displayName: 'Explain code', description: 'Explain code and call relationships (local fixture)', source: 'fixture', modelText: 'Use the Skill tool with skill: "explain" for this request.' },
        ], plugins: [
          { kind: 'plugin', id: 'github@haha-connectors', name: 'github', displayName: 'GitHub', description: 'Search repository code, issues and pull requests (local fixture)', source: 'fixture', modelText: 'Use the GitHub connector for this request.', mcpServerNames: ['github'] },
        ] })
      // Same shape the desktop sends a paired phone: no auth links, error text or local paths.
      if (path === '/api/connectors' && method === 'GET')
        return json({ items: [
          { id: 'github', displayName: 'GitHub', description: 'Search repository code, issues and pull requests.', category: 'development', transport: 'mcp', collection: 'services', pluginId: 'github@haha-connectors', supported: true, installed: true, enabled: true, connection: 'connected', status: 'ready', accountLabel: 'fixture-user' },
          { id: 'feishu', displayName: 'Feishu', description: 'Messages, calendar and docs.', category: 'office', transport: 'cli', collection: 'services', pluginId: 'office-feishu@haha-connectors', supported: true, installed: true, enabled: true, connection: 'needs-auth', status: 'needs-auth' },
          { id: 'notion', displayName: 'Notion', description: 'Search workspace content and organize page and project knowledge.', category: 'office', transport: 'mcp', collection: 'services', pluginId: 'notion@haha-connectors', supported: true, installed: false, enabled: false, connection: 'disconnected', status: 'not-installed' },
          { id: 'context7', displayName: 'Context7', description: 'Look up the latest docs and usage examples for software libraries.', category: 'development', transport: 'mcp', collection: 'services', pluginId: 'context7@haha-connectors', supported: true, installed: false, enabled: false, connection: 'disconnected', status: 'not-installed' },
        ] })
      if (path === '/api/agents' && method === 'GET')
        return json({ activeAgents: [
          { agentType: 'code-reviewer', description: 'Review changes against team conventions and suggest fixes (fixture)', modelDisplay: 'Fixture Sonnet', color: 'blue', source: 'userSettings', isActive: true },
          { agentType: 'Explore', description: 'Explore the codebase read-only and answer questions (fixture)', modelDisplay: 'Fixture Sonnet', source: 'built-in', isActive: true },
        ], allAgents: [] })
      if (path === '/api/workflows' && method === 'GET')
        return json({ workflows: [
          { name: 'ship-release', description: 'Run tests, write release notes and tag (fixture)', source: 'user' },
          { name: 'triage-issues', description: 'Triage new issues and sort by priority (fixture)', source: 'project' },
        ] })
      if (path === '/api/computer-use/status' && method === 'GET')
        return json({ platform: 'darwin', supported: true, engine: 'macos-native', cuHelper: { available: true, supported: true }, permissions: { accessibility: true, screenRecording: true } })
      if (path === '/api/computer-use/authorized-apps') {
        if (method === 'PUT') {
          computerUse = { ...computerUse, ...body, grantFlags: { ...computerUse.grantFlags, ...object(body.grantFlags) } }
          return json({ ok: true })
        }
        return json(computerUse)
      }
      const taskListMatch = path.match(/^\/api\/tasks\/lists\/([^/]+)$/)
      const fixtureTasks = (id: string) => [
        { id: '1', subject: 'Task 1 · Check desktop interactions', description: 'Verify input and run state along the real API.', status: 'completed', owner: 'researcher', blocks: ['2'], blockedBy: [], taskListId: id },
        { id: '2', subject: 'Task 2 · Improve mobile Composer', description: 'Shared input area, add skill suggestions.', status: 'in_progress', owner: 'builder', blocks: ['3'], blockedBy: ['1'], taskListId: id },
        { id: '3', subject: 'Task 3 · Regression check', description: 'Verify real-device keyboard, directories, models and activity entry.', status: 'pending', owner: 'reviewer', blocks: [], blockedBy: ['2'], taskListId: id },
      ]
      if (taskListMatch && method === 'GET') {
        const id = decodeURIComponent(taskListMatch[1]!)
        if (!sessions.has(id)) return fail('Session not found', 404, 'NOT_FOUND')
        return json({ tasks: fixtureTasks(id) })
      }
      const planSession = path.match(/^\/api\/teams\/session\/([^/]+)\/plan$/)
      if (planSession && method === 'GET')
        return json({ plan: teamPlans.get(decodeURIComponent(planSession[1]!)) ?? null })
      const planAction = path.match(/^\/api\/teams\/([^/]+)\/plan(?:\/(approve|return|cancel|retry|end))?$/)
      if (planAction && (method === 'PATCH' || (method === 'POST' && planAction[2]))) {
        const plan = teamPlans.get(String(body.sessionId))
        if (!plan || plan.teamName !== decodeURIComponent(planAction[1]!) || plan.planId !== body.planId)
          return fail('Plan not found', 404, 'TEAM_PLAN_CONFLICT')
        if (plan.revision !== body.expectedRevision)
          return fail('Plan changed; refresh before continuing', 409, 'TEAM_PLAN_CONFLICT')
        const next: TeamPlanRecord = { ...plan, revision: plan.revision + 1, updatedAt: Date.now() }
        if (method === 'PATCH') {
          if (plan.state !== 'review_pending') return fail('Plan is not editable', 409, 'TEAM_PLAN_CONFLICT')
          for (const edit of (Array.isArray(body.members) ? body.members : []).map(object)) {
            next.members = next.members.map((member) => member.id !== edit.id ? member : {
              ...member,
              ...(typeof edit.agentType === 'string' ? { agentType: edit.agentType } : {}),
              ...(edit.runtime ? { runtime: object(edit.runtime) as TeamPlanRecord['leaderRuntime'], runtimeSource: 'human' } : {}),
            })
          }
          for (const edit of (Array.isArray(body.tasks) ? body.tasks : []).map(object))
            next.tasks = next.tasks.map((task) => task.id === edit.id ? { ...task, ownerId: String(edit.ownerId) } : task)
        } else {
          const action = planAction[2]!
          const allowed: Record<string, TeamPlanRecord['state'][]> = {
            approve: ['review_pending'], return: ['review_pending', 'draft'], cancel: ['review_pending', 'launch_failed', 'draft'], retry: ['launch_failed'], end: ['interrupted'],
          }
          if (!allowed[action]!.includes(plan.state)) return fail(`Cannot ${action} a ${plan.state} plan`, 409, 'TEAM_PLAN_CONFLICT')
          if (action === 'approve' && next.tasks.some((task) => !next.members.some((member) => member.id === task.ownerId)))
            return fail('Every task needs an assigned member', 400, 'TEAM_PLAN_CONFLICT')
          if (action === 'approve' && next.members.some((member) => !next.tasks.some((task) => task.ownerId === member.id)))
            return fail('Every member needs an assigned task', 400, 'TEAM_PLAN_CONFLICT')
          // Same as the real server: launching after approval, then running once members are in place.
          next.state = action === 'approve' ? 'launching' : action === 'return' ? 'draft' : action === 'retry' ? 'review_pending' : 'cancelled'
          if (action === 'retry') delete next.launch
          if (typeof body.feedback === 'string') next.feedback = body.feedback
          if (action === 'approve') {
            const launching = next
            setTimeout(() => {
              if (teamPlans.get(launching.sessionId) !== launching) return
              const running: TeamPlanRecord = { ...launching, state: 'running', revision: launching.revision + 1, updatedAt: Date.now() }
              teamPlans.set(running.sessionId, running)
              announceTeamPlan(running)
            }, 3000)
          }
        }
        teamPlans.set(plan.sessionId, next)
        announceTeamPlan(next)
        return json({ plan: next })
      }
      const teamSession = path.match(/^\/api\/teams\/session\/([^/]+)\/workbench$/)
      if (teamSession && method === 'GET') {
        const id = decodeURIComponent(teamSession[1]!)
        if (id !== 'fixture-plan') return fail('No team', 404, 'NOT_FOUND')
        return json({ sessionId: id, teamName: 'mobile-qa', incarnationId: 'fixture-team-1', source: 'live', snapshots: [{
          version: 'fixture-v1', generatedAt: new Date().toISOString(),
          team: { name: 'mobile-qa', incarnationId: 'fixture-team-1', leadSessionId: id, leadAgentId: 'lead', createdAt: 1792886400000, members: [
            { agentId: 'researcher', name: 'researcher', agentType: 'research', status: 'completed', activity: 'idle', model: 'fixture-sonnet' },
            { agentId: 'builder', name: 'builder', agentType: 'developer', status: 'running', activity: 'active', model: 'fixture-sonnet' },
            { agentId: 'reviewer', name: 'reviewer', agentType: 'reviewer', status: 'idle', activity: 'stopped', lastError: 'Test pause state', model: 'fixture-opus' },
          ] }, tasks: fixtureTasks(id), messages: [{ id: 'message-1', from: 'lead', to: 'builder', text: 'Reuse the existing directory API first, then verify mobile input.', timestamp: new Date().toISOString(), kind: 'direct' }],
        }] })
      }
      if (/^\/api\/teams\/mobile-qa\/members\/[^/]+\/transcript$/.test(path) && method === 'GET')
        return json({ messages: [{ id: 'fixture-member-message', type: 'assistant', content: 'Fixture Execution log: desktop contract checked, implementing the mobile input area.', timestamp: new Date().toISOString() }], ownerAgentIds: [], taskNotifications: [], taskAnchors: [] })
      if (path === '/api/providers/auth-status')
        return json({
          hasAuth: true,
          source: 'cc-haha-provider',
          activeProvider: 'Fixture API',
        })
      if (path === '/api/providers/presets')
        return json({ presets: [{ id: 'custom', name: 'Fixture custom' }] })
      if (path === '/api/providers' && method === 'GET')
        return json({ providers, activeId })
      if (path === '/api/providers' && method === 'POST') {
        if (!body.name || !object(body.models).main)
          return fail('Provider name and main model are required')
        const provider = {
          ...body,
          id: `fixture-provider-${++providerSequence}`,
          apiKey: '',
          hasApiKey: !!body.apiKey,
        }
        providers.push(provider)
        return json({ provider }, 201)
      }
      if (path.startsWith('/api/providers/')) {
        const [, , , id, action] = path.split('/')
        const index = providers.findIndex((provider) => provider.id === id)
        if (index < 0)
          return fail('Fixture provider not found', 404, 'NOT_FOUND')
        if (action === 'activate' && method === 'POST') {
          activeId = id!
          currentModel = String(object(providers[index]!.models).main)
          return json({ ok: true })
        }
        if (method === 'GET') return json({ provider: providers[index] })
        if (method === 'PUT') {
          providers[index] = {
            ...providers[index],
            ...body,
            apiKey: '',
            hasApiKey: !!body.apiKey || providers[index]!.hasApiKey,
          }
          if (activeId === id)
            currentModel = String(object(providers[index]!.models).main)
          return json({ provider: providers[index] })
        }
        if (method === 'DELETE') {
          if (activeId === id)
            return fail('Cannot delete active provider', 409, 'CONFLICT')
          providers.splice(index, 1)
          return json({ ok: true })
        }
      }
      if (path === '/api/models' || path === '/api/models/catalog')
        return json({
          models: MODELS,
          provider: { id: activeId, name: 'Fixture API' },
        })
      if (path === '/api/models/current') {
        if (method === 'PUT') {
          if (typeof body.modelId !== 'string')
            return fail('modelId is required')
          currentModel = body.modelId
          return json({ ok: true, model: currentModel })
        }
        return json({
          model: MODELS.find((model) => model.id === currentModel) ?? {
            id: currentModel,
            name: currentModel,
            description: 'Fixture custom model',
            context: '',
          },
        })
      }
      if (path === '/api/effort') {
        if (method === 'PUT') {
          if (typeof body.level !== 'string' || !EFFORTS.includes(body.level))
            return fail('Invalid effort')
          defaultEffort = body.level
          return json({ ok: true, level: defaultEffort })
        }
        return json({ level: defaultEffort, available: EFFORTS })
      }
      if (path === '/api/permissions/mode') {
        if (method === 'PUT') {
          if (typeof body.mode !== 'string' || !MODES.includes(body.mode))
            return fail('Invalid permission mode')
          permissionMode = body.mode as PermissionMode
          return json({ ok: true, mode: permissionMode })
        }
        return json({ mode: permissionMode })
      }
      if (path === '/api/settings/user') {
        if (method === 'PUT') settings = { ...settings, ...body }
        return json(method === 'PUT' ? { ok: true } : settings)
      }
      if (path === '/api/sessions/mobile-push' && method === 'GET')
        return json({
          platforms: { ios: false, android: false },
          status: 'notConfigured',
        })
      // The fixture never registers a real token or invokes APNs/FCM.
      if (path.startsWith('/api/sessions/mobile-push'))
        return fail(
          'Push delivery is deliberately unavailable in this local fixture',
          503,
          'PUSH_NOT_CONFIGURED'
        )
      if (path.startsWith('/api/scheduled-tasks')) {
        const [, , , taskId, action] = path.split('/')
        if (taskId === 'notification-capabilities') {
          if (method !== 'GET' || action || url.search) return fail('Notification capabilities are read-only', 405, 'METHOD_NOT_ALLOWED')
          return json({ channels: { desktop: true, feishu: false, telegram: false } })
        }
        if (taskId === 'runs' && method === 'GET') {
          if (action) {
            const run = scheduledRuns.find((run) => run.id === action)
            return run ? json({ run }) : fail('Run not found', 404, 'NOT_FOUND')
          }
          const limit = Math.max(
            1,
            Math.min(100, Number(url.searchParams.get('limit') ?? 50))
          )
          return json({
            runs: scheduledRuns
              .slice(-limit)
              .reverse()
              .map((run) =>
                url.searchParams.get('summaryOnly') === 'true'
                  ? {
                      ...run,
                      output: undefined,
                      outputPreview: run.output?.slice(0, 200),
                    }
                  : run
              ),
            nextCursor: null,
            hasMore: false,
          })
        }
        if (!taskId && method === 'GET')
          return json({ tasks: [...scheduledTasks.values()].map(scheduledSnapshot) })
        if (!taskId && method === 'POST') {
          const plan = fixturePlan(body.schedule)
          if (plan === null) return fail('Invalid schedule')
          if (plan) {
            if (plan.kind === 'once' && Date.parse(plan.runAt) <= Date.now()) return fail('One-time task must be scheduled in the future')
          }
          if (
            typeof body.prompt !== 'string' ||
            !body.prompt.trim() ||
            (!plan && (typeof body.cron !== 'string' || body.cron.trim().split(/\s+/).length !== 5))
          )
            return fail('A prompt and five-field cron are required')
          const task: ScheduledTask = {
            id: crypto.randomUUID(),
            name: typeof body.name === 'string' ? body.name : undefined,
            prompt: body.prompt,
            cron: plan?.kind === 'cron' ? plan.expression : typeof body.cron === 'string' ? body.cron : '',
            enabled: body.enabled !== false,
            recurring: plan ? plan.kind === 'cron' : body.recurring === true,
            permanent: body.permanent === true,
            folderPath:
              typeof body.folderPath === 'string' ? body.folderPath : undefined,
            createdAt: Date.now(),
            revision: 1,
            ...(plan ? { schedule: plan } : {}),
            ...(body.execution ? { execution: body.execution as ScheduledTask['execution'] } : {}),
            ...(body.notificationPolicy ? { notificationPolicy: body.notificationPolicy as ScheduledTask['notificationPolicy'] } : {}),
            ...(body.notification ? { notification: body.notification as ScheduledTask['notification'] } : {}),
            ...(typeof body.model === 'string' ? { model: body.model } : {}),
            ...(body.providerId === null || typeof body.providerId === 'string' ? { providerId: body.providerId } : {}),
            ...(typeof body.useWorktree === 'boolean' ? { useWorktree: body.useWorktree } : {}),
          }
          scheduledTasks.set(task.id, task)
          return json({ task: scheduledSnapshot(task) }, 201)
        }
        const task = taskId ? scheduledTasks.get(taskId) : undefined
        if (!task) return fail('Scheduled task not found', 404, 'NOT_FOUND')
        if (action === 'runs' && method === 'GET')
          return json({
            runs: scheduledRuns
              .filter((run) => run.taskId === taskId)
              .reverse(),
          })
        if (action === 'run' && method === 'POST') {
          const session = create(
            crypto.randomUUID(),
            task.name ?? 'Fixture Scheduled task',
            { workDir: task.folderPath }
          )
          append(session, 'user', task.prompt)
          session.running = true
          const run: TaskRun = {
            id: crypto.randomUUID(),
            taskId: task.id,
            taskName: task.name ?? task.id,
            startedAt: new Date().toISOString(),
            status: 'running',
            sessionId: session.summary.id,
          }
          scheduledRuns.push(run)
          task.lastFiredAt = run.startedAt
          schedule(session, 700, () => {
            run.status = 'completed'
            run.completedAt = new Date().toISOString()
            run.durationMs = 700
            run.output = `Fixture: in-memory demo of ${run.taskName} finished. No commands were run and no model was called.`
            append(
              session,
              'assistant',
              [{ type: 'text', text: run.output }],
              currentModel
            )
            complete(session)
          })
          return json({ ok: true })
        }
        if (!action && method === 'PUT') {
          if (body.expectedRevision !== undefined && body.expectedRevision !== (task.revision ?? 1)) return fail('Task was changed; reload before updating', 409, 'CONFLICT')
          if (body.schedule !== undefined) {
            const plan = fixturePlan(body.schedule)
            if (!plan) return fail('Invalid schedule')
            if (plan.kind === 'once' && Date.parse(plan.runAt) <= Date.now()) return fail('One-time task must be scheduled in the future')
            task.schedule = plan
            task.cron = plan.kind === 'cron' ? plan.expression : ''
            task.recurring = plan.kind === 'cron'
          }
          for (const key of ['name', 'prompt', 'cron', 'folderPath'] as const)
            if (typeof body[key] === 'string') task[key] = body[key]
          for (const key of ['enabled', 'recurring', 'permanent'] as const)
            if (typeof body[key] === 'boolean') task[key] = body[key]
          task.revision = (task.revision ?? 1) + 1
          return json({ task: scheduledSnapshot(task) })
        }
        if (!action && method === 'DELETE') {
          scheduledTasks.delete(task.id)
          return json({ ok: true })
        }
        return fail(
          'Unsupported scheduled task method',
          405,
          'METHOD_NOT_ALLOWED'
        )
      }
      if (path === '/api/sessions/recent-projects')
        return json({
          projects: [
            {
              projectPath: FIXTURE_ROOT,
              realPath: FIXTURE_ROOT,
              projectName: 'cc-haha-demo · Fixture',
              isGit: true,
              repoName: 'cc-haha-demo',
              branch: 'main',
              modifiedAt: new Date().toISOString(),
              sessionCount: sessions.size,
            },
          ],
        })
      if (path === '/api/sessions/repository-context' && method === 'GET')
        return json(
          repositoryContext(url.searchParams.get('workDir') ?? FIXTURE_ROOT)
        )
      if (path === '/api/sessions/repository-branch' && method === 'POST') {
        if (
          typeof body.workDir !== 'string' ||
          typeof body.name !== 'string' ||
          !/^[\w][\w./-]*$/.test(body.name) ||
          body.name.includes('..')
        )
          return fail('Invalid workDir or branch name')
        if (branches.has(body.name))
          return fail('Branch already exists', 409, 'CONFLICT')
        branches.add(body.name)
        return json(
          {
            branch: body.name,
            baseRef: typeof body.from === 'string' ? body.from : 'HEAD',
            context: repositoryContext(body.workDir),
          },
          201
        )
      }
      if (
        ['/api/sessions/live-status', '/api/sessions/mobile-status'].includes(
          path
        ) &&
        method === 'GET'
      )
        return json({
          sessions: [...sessions.values()]
            .filter(
              (session) => path.endsWith('mobile-status') || session.running
            )
            .map(mobileActivity),
        })
      if (path === '/api/sessions' && method === 'GET') {
        const all = [...sessions.values()]
          .map((session) => session.summary)
          .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
        const offset = Number(url.searchParams.get('offset') ?? 0)
        const limit = Number(url.searchParams.get('limit') ?? 20)
        return json({
          sessions: all.slice(offset, offset + limit),
          total: all.length,
        })
      }
      if (path === '/api/sessions' && method === 'POST') {
        if (body.agentProfile === 'lean' && body.permissionMode === 'plan')
          return fail('Plan mode is unavailable in lean sessions')
        const session = create(crypto.randomUUID(), 'Fixture · New session', body)
        return json(
          { sessionId: session.summary.id, workDir: session.summary.workDir },
          201
        )
      }
      const match = path.match(/^\/api\/sessions\/([\w-]+)(?:\/(.*))?$/)
      if (match) {
        const session = sessions.get(match[1]!)
        if (!session) return fail('Fixture session not found', 404, 'NOT_FOUND')
        const action = match[2]
        if (!action && method === 'PATCH') {
          if (typeof body.title !== 'string' || !body.title.trim())
            return fail('title is required')
          session.summary.title = body.title.trim()
          emit(session, {
            type: 'session_title_updated',
            sessionId: session.summary.id,
            title: session.summary.title,
          })
          return json({ ok: true })
        }
        if (!action && method === 'DELETE') {
          clearTimers(session)
          for (const ws of session.sockets)
            ws.close(1000, 'Fixture session deleted')
          sessions.delete(session.summary.id)
          return json({ ok: true })
        }
        if (action === 'summary' && method === 'GET')
          return json(session.summary)
        if (action === 'git-info' && method === 'GET')
          return json({
            branch: session.branch,
            repoName: 'claude-code-haha',
            workDir: session.summary.workDir,
            changedFiles: 3,
            worktree: null,
          })
        if (action === 'inspection' && method === 'GET') {
          // Live context reported by the desktop: the mobile Context sheet reads it; the fixture provides fixed fake data.
          const query = new URL(request.url).searchParams
          if (query.get('usageOnly') === '1')
            return json({
              usage: {
                totalInputTokens: 18200,
                totalOutputTokens: 5400,
                totalCacheReadInputTokens: 61000,
                totalCacheCreationInputTokens: 9000,
                totalAPIDuration: 120000,
                costDisplay: '$0.42',
              },
            })
          return json({
            context: {
              totalTokens: 76400,
              rawMaxTokens: 200000,
              model: session.runtime.modelId,
              categories: [
                { name: 'System prompt', tokens: 6200 },
                { name: 'Messages', tokens: 61300 },
                { name: 'Tools', tokens: 8900 },
              ],
            },
          })
        }
        if (action === 'slash-commands' && method === 'GET')
          return json({
            commands: [
              {
                name: 'review',
                description: 'Check current changes (fixture demo)',
                kind: 'skill',
              },
              {
                name: 'explain',
                description: 'Explain code (fixture demo)',
                kind: 'command',
              },
            ],
          })
        const backgroundOutput = action?.match(/^background-tasks\/([^/]+)\/output$/)
        if (backgroundOutput) {
          if (method !== 'GET') return fail('Method not allowed', 405, 'METHOD_NOT_ALLOWED')
          if (url.search) return fail('Task output accepts only a session and task ID')
          let taskId: string
          try { taskId = decodeURIComponent(backgroundOutput[1]!) }
          catch { return fail('Invalid task ID') }
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) return fail('Invalid task ID')
          const task = session.tasks.find((entry) => entry.taskId === taskId && entry.taskType === 'local_bash')
          if (!task) return fail('Background shell task not found in this session', 404, 'NOT_FOUND')
          // Fixture logs live in the task, so stopping does not remove them. No
          // filesystem path is accepted or read, just like the real ID-only API.
          const bytes = Buffer.from(task.result ?? '', 'utf8')
          const offset = Math.max(0, bytes.length - 64 * 1024)
          let start = offset
          while (start < bytes.length && offset > 0 && (bytes[start]! & 0xc0) === 0x80) start++
          return Response.json({
            taskId,
            state: task.result === undefined ? 'missing' : bytes.length ? 'available' : 'empty',
            text: bytes.subarray(start).toString('utf8'),
            totalBytes: bytes.length,
            truncated: offset > 0,
          }, { headers: { ...headers, 'Cache-Control': 'no-store' } })
        }
        if (action === 'background-tasks' && method === 'GET')
          return json({ tasks: session.tasks, historyComplete: true })
        if (action?.startsWith('subagents/by-tool/') && method === 'GET') {
          const toolUseId = decodeURIComponent(
            action.slice('subagents/by-tool/'.length)
          )
          const task = session.tasks.find(
            (task) =>
              task.toolUseId === toolUseId &&
              (!url.searchParams.has('taskId') ||
                task.taskId === url.searchParams.get('taskId'))
          )
          return task
            ? json({
                messages: [
                  {
                    id: `${task.taskId}-output`,
                    type: 'assistant',
                    content: [
                      {
                        type: 'text',
                        text: task.summary ?? 'Fixture task output',
                      },
                    ],
                    timestamp: task.startedAt,
                  },
                ],
                result: `Fixture: ${task.description}\n${task.summary ?? ''}\nThis is in-memory test output; no subprocess was run.`,
                status: task.status,
                truncated: false,
              })
            : fail('Subagent not found', 404, 'NOT_FOUND')
        }
        if (action === 'turn-checkpoints' && method === 'GET')
          return json({ checkpoints: checkpoints(session) })
        if (action === 'turn-checkpoints/diff' && method === 'GET') {
          const checkpoint = checkpoints(session).find(
            (item) =>
              item.target.targetUserMessageId ===
                url.searchParams.get('targetUserMessageId') ||
              (!url.searchParams.has('targetUserMessageId') &&
                item.target.userMessageIndex ===
                  Number(url.searchParams.get('userMessageIndex')))
          )
          const filePath = url.searchParams.get('path') ?? ''
          if (!checkpoint)
            return fail('Checkpoint target not found', 404, 'NOT_FOUND')
          return json({
            target: checkpoint.target,
            workDir: session.summary.workDir,
            path: filePath,
            state: checkpoint.code.filesChanged.includes(filePath)
              ? 'ok'
              : 'missing',
            ...(checkpoint.code.filesChanged.includes(filePath)
              ? { diff: checkpointDiff(filePath) }
              : {}),
          })
        }
        if (action === 'rewind' && method === 'POST') {
          if (
            !['both', 'conversation', 'code'].includes(
              String(body.mode ?? 'both')
            )
          )
            return fail('Invalid rewind mode')
          const checkpoint = checkpoints(session).find(
            (item) =>
              item.target.targetUserMessageId === body.targetUserMessageId ||
              (body.targetUserMessageId === undefined &&
                item.target.userMessageIndex === body.userMessageIndex)
          )
          if (!checkpoint)
            return fail('Checkpoint target not found', 404, 'NOT_FOUND')
          if (body.dryRun === true) return json(checkpoint)
          if (
            session.running ||
            session.tasks.some((task) => task.status === 'running')
          )
            return fail('Stop active work before rewinding', 409, 'CONFLICT')
          const mode = body.mode ?? 'both'
          const index = session.messages.findIndex(
            (message) => message.id === checkpoint.target.targetUserMessageId
          )
          const removedMessageIds =
            mode === 'code'
              ? []
              : session.messages.slice(index).map((message) => message.id)
          if (mode !== 'conversation')
            session.restoredTargets.add(checkpoint.target.targetUserMessageId)
          if (mode !== 'code') {
            session.messages.splice(index)
            session.revision++
            session.summary.messageCount = session.messages.length
            session.summary.modifiedAt = new Date().toISOString()
          }
          return json({
            ...checkpoint,
            conversation: { ...checkpoint.conversation, removedMessageIds },
            mode,
          })
        }
        if (action === 'branch' && method === 'POST') {
          if (session.summary.agentProfile === 'lean')
            return fail(
              'Forking is unavailable in lean sessions',
              409,
              'CONFLICT'
            )
          const index = session.messages.findIndex(
            (message) => message.id === body.targetMessageId
          )
          if (index < 0)
            return fail('Persisted message not found', 404, 'NOT_FOUND')
          const branch = create(
            crypto.randomUUID(),
            typeof body.title === 'string'
              ? body.title
              : `${session.summary.title} · Branch`,
            {
              workDir: session.summary.workDir,
              permissionMode: session.summary.permissionMode,
              repository: { branch: session.branch },
            }
          )
          branch.messages = structuredClone(
            session.messages.slice(0, index + 1)
          )
          branch.revision++
          branch.summary.messageCount = branch.messages.length
          return json(
            {
              sessionId: branch.summary.id,
              title: branch.summary.title,
              workDir: branch.summary.workDir,
              sourceSessionId: session.summary.id,
              targetMessageId: body.targetMessageId,
            },
            201
          )
        }
        if (action === 'messages' && method === 'GET') {
          const cursor = url.searchParams.get('cursor')
          let end = session.messages.length
          if (cursor) {
            try {
              const [revision, index] = atob(cursor).split(':').map(Number)
              if (revision !== session.revision)
                return fail(
                  'Fixture history changed',
                  409,
                  'HISTORY_PAGE_STALE'
                )
              if (!Number.isInteger(index) || index! < 0 || index! > end)
                return fail('Invalid cursor')
              end = index!
            } catch {
              return fail('Invalid cursor')
            }
          }
          const start =
            url.searchParams.get('mode') === 'full' ? 0 : Math.max(0, end - 6)
          const messages = session.messages.slice(start, end)
          return json({
            messages,
            taskNotifications: [],
            page: {
              nextCursor: start ? btoa(`${session.revision}:${start}`) : null,
              hasMore: start > 0,
              historyComplete: start === 0,
              sourceVersion: `fixture-${session.revision}`,
              scannedBytes: JSON.stringify(messages).length,
              omittedOversizedEntries: 0,
            },
          })
        }
        if (action === 'chat/status')
          return json({
            state: session.running ? 'thinking' : 'idle',
            activityState: session.pending.size
              ? 'waiting'
              : session.running
                ? 'running'
                : 'idle',
          })
        if (action === 'workspace/status')
          return json({
            state: 'ok',
            workDir: FIXTURE_ROOT,
            repoName: 'cc-haha-demo',
            branch: 'main',
            isGitRepo: true,
            changedFiles: [
              {
                path: 'src/session.ts',
                status: 'modified',
                additions: 1,
                deletions: 1,
              },
            ],
          })
        if (action === 'workspace/tree') {
          const folder = (url.searchParams.get('path') ?? '').replace(
            /^\/+|\/+$/g,
            ''
          )
          const entries =
            folder === 'src'
              ? ['index.ts', 'session.ts'].map((name) => ({
                  name,
                  path: `src/${name}`,
                  isDirectory: false,
                }))
              : folder === ''
                ? [
                    { name: 'src', path: 'src', isDirectory: true },
                    {
                      name: 'README.md',
                      path: 'README.md',
                      isDirectory: false,
                    },
                  ]
                : []
          return json({
            state: entries.length ? 'ok' : 'missing',
            path: folder,
            entries,
          })
        }
        if (action === 'workspace/file') {
          const filePath = url.searchParams.get('path') ?? ''
          const content = FILES[filePath]
          return json(
            content === undefined
              ? { state: 'missing', path: filePath, language: '', size: 0 }
              : {
                  state: 'ok',
                  path: filePath,
                  previewType: 'text',
                  content,
                  language: filePath.endsWith('.md')
                    ? 'markdown'
                    : 'typescript',
                  size: new TextEncoder().encode(content).length,
                }
          )
        }
        if (action === 'workspace/raw') {
          const content = FILES[url.searchParams.get('path') ?? '']
          return content === undefined
            ? fail('Fixture file not found', 404, 'NOT_FOUND')
            : new Response(content, {
                headers: {
                  ...headers,
                  'Content-Type': 'text/plain; charset=utf-8',
                },
              })
        }
        if (action === 'workspace/diff')
          return json({
            state: 'ok',
            path: url.searchParams.get('path') ?? 'src/session.ts',
            diff: '--- a/src/session.ts\n+++ b/src/session.ts\n@@ -1 +1 @@\n-export const sessionStatus = "pending"\n+export const sessionStatus = "ready"\n',
          })
      }
      if (path === '/__fixture/status')
        return json({
          fixture: true,
          design,
          hostName,
          sessions: sessions.size,
          connections: [...sessions.values()].reduce(
            (count, session) => count + session.sockets.size,
            0
          ),
        })
      if (path === '/__fixture/scenario' && method === 'POST') {
        const session = sessions.get(String(body.sessionId))
        if (
          !session ||
          ![
            'approval',
            'question',
            'plan',
            'idle',
            'failed',
            'stalled',
            'edit',
            'team',
            'team-failed',
            'team-interrupted',
          ].includes(String(body.kind))
        )
          return fail(
            'Specify an existing sessionId and approval/question/plan/edit/idle/failed/stalled/team/team-failed/team-interrupted kind'
          )
        stop(session)
        if (String(body.kind).startsWith('team')) {
          seedTeamPlan(session.summary.id, body.kind === 'team' ? 'review_pending' : body.kind === 'team-failed' ? 'launch_failed' : 'interrupted')
          return json({ ok: true, sessionId: session.summary.id, ...mobileActivity(session) })
        }
        delete session.stalled
        if (body.kind === 'failed') session.terminalOutcome = 'failed'
        else if (body.kind === 'stalled') {
          // Running with no CLI output for six minutes; no timer advances it.
          session.running = true
          delete session.terminalOutcome
          session.startedAt = Date.now() - 1300000
          session.lastProgressAt = Date.now() - 360000
          session.stalled = true
        } else if (body.kind !== 'idle')
          pendingDecision(
            session,
            body.kind as 'approval' | 'question' | 'plan' | 'edit',
            true,
            body.multiple === true
          )
        return json({
          ok: true,
          sessionId: session.summary.id,
          ...mobileActivity(session),
        })
      }
      if (path === '/__fixture/disconnect' && method === 'POST') {
        for (const session of sessions.values())
          for (const ws of session.sockets)
            ws.close(1012, 'Fixture reconnect test')
        return json({ ok: true })
      }
      return fail(
        `Fixture endpoint not implemented: ${method} ${path}`,
        404,
        'NOT_FOUND'
      )
    },
    websocket: {
      maxPayloadLength: 8 * 1024 * 1024,
      open(ws) {
        const session = sessions.get(ws.data.sessionId)
        if (!session) return ws.close(1008, 'Fixture session not found')
        session.sockets.add(ws)
        send(ws, { type: 'connected', sessionId: session.summary.id })
        for (const request of session.pending.values()) send(ws, request)
        send(ws, {
          type: 'permission_requests_snapshot',
          toolRequestIds: [...session.pending.keys()],
          computerUseRequestIds: [],
          turnActive: session.running,
        })
      },
      message(ws, raw) {
        try {
          receive(ws, JSON.parse(String(raw)) as ClientMessage)
        } catch {
          send(ws, {
            type: 'error',
            code: 'PARSE_ERROR',
            message: 'Invalid fixture WS JSON',
          })
        }
      },
      close(ws) {
        sessions.get(ws.data.sessionId)?.sockets.delete(ws)
      },
    },
  })
  if (!quiet)
    console.log(
      `LOCAL ${design ? 'DESIGN ' : ''}FIXTURE ONLY — no models, no real files\nHost: ${hostName}\nURL: http://127.0.0.1:${server.port}\nFake token: ${FIXTURE_TOKEN}\nCommands: /approval /edit /question /plan /slow /error /retry`
    )
  return {
    server,
    async close() {
      for (const session of sessions.values()) clearTimers(session)
      await server.stop(true)
    },
  }
}

async function selfTest() {
  const fixture = startFixtureServer({ port: 0, quiet: true })
  const base = `http://127.0.0.1:${fixture.server.port}`
  const headers = {
    Authorization: `Bearer ${FIXTURE_TOKEN}`,
    'Content-Type': 'application/json',
  }
  const sockets: WebSocket[] = []
  try {
    assert.equal((await fetch(`${base}/api/sessions`)).status, 401)
    const voiceCatalog = await (await fetch(`${base}/api/voice/catalog`, { headers })).json() as { supported: boolean }
    assert.equal(voiceCatalog.supported, true)
    const voiceBytes = encodeVoiceWav(new Float32Array(8_000).fill(0.25))
    const voiceResponse = await fetch(`${base}/api/voice/transcribe`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'audio/wav' }, body: Uint8Array.from(voiceBytes).buffer,
    })
    assert.equal(voiceResponse.status, 200)
    assert.deepEqual(await voiceResponse.json(), { text: 'Voice transcription test text (local fixture)', audioSeconds: 0.5, inferenceSeconds: 0 })
    assert.equal((await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers, body: '{}' })).status, 400)
    assert.deepEqual(
      await (
        await fetch(`${base}/api/h5-access/verify`, { method: 'POST', headers })
      ).json(),
      { ok: true }
    )
    assert.equal(
      (await fetch(`${base}/api/h5-access/verify`, { headers })).status,
      405
    )
    const list = (await (
      await fetch(`${base}/api/sessions`, { headers })
    ).json()) as { sessions: Session[] }
    assert.equal(list.sessions.length, 4)
    const latest = (await (
      await fetch(`${base}/api/sessions/fixture-chat/messages`, { headers })
    ).json()) as { messages: HistoryEntry[]; page: { nextCursor: string } }
    // The three "+" catalogs (connectors, agents, workflows) in the phone's projected shape.
    const connectors = (await (await fetch(`${base}/api/connectors`, { headers })).json()) as { items: { id: string; connection: string }[] }
    assert.deepEqual(connectors.items.map((item) => [item.id, item.connection]), [
      ['github', 'connected'], ['feishu', 'needs-auth'], ['notion', 'disconnected'], ['context7', 'disconnected'],
    ])
    assert.ok(!JSON.stringify(connectors).includes('authUrl'))
    assert.equal(((await (await fetch(`${base}/api/agents`, { headers })).json()) as { activeAgents: unknown[] }).activeAgents.length, 2)
    assert.equal(((await (await fetch(`${base}/api/workflows`, { headers })).json()) as { workflows: unknown[] }).workflows.length, 2)
    assert.equal(latest.messages.length, 6)
    assert.ok(latest.page.nextCursor)
    const older = (await (
      await fetch(
        `${base}/api/sessions/fixture-chat/messages?cursor=${encodeURIComponent(latest.page.nextCursor)}`,
        { headers }
      )
    ).json()) as { messages: HistoryEntry[] }
    assert.equal(older.messages.length, 4)
    async function socket(id: string, origin = base) {
      const events: ServerMessage[] = []
      const ws = new WebSocket(
        `${origin.replace('http:', 'ws:')}/ws/${id}?token=${FIXTURE_TOKEN}`
      )
      sockets.push(ws)
      ws.onmessage = (event) => events.push(JSON.parse(String(event.data)))
      async function until(type: ServerMessage['type'], from = 0) {
        const deadline = Date.now() + 7000
        while (Date.now() < deadline) {
          const found = events.slice(from).find((event) => event.type === type)
          if (found) return found
          await Bun.sleep(10)
        }
        throw new Error(`Fixture self-test timed out waiting for ${type}`)
      }
      await until('connected')
      return {
        ws,
        events,
        until,
        send: (message: ClientMessage) => ws.send(JSON.stringify(message)),
      }
    }
    // Match the real shell-output route, including retained logs after stop.
    const designFixture = startFixtureServer({ port: 0, quiet: true, design: true })
    try {
      const designBase = `http://127.0.0.1:${designFixture.server.port}`
      const outputUrl = `${designBase}/api/sessions/fixture-plan/background-tasks/fixture-command/output`
      const beforeResponse = await fetch(outputUrl, { headers })
      assert.equal(beforeResponse.status, 200, 'Known shell task must expose the real output route')
      assert.equal(beforeResponse.headers.get('Cache-Control'), 'no-store')
      const before = await beforeResponse.json() as { taskId: string; state: string; text: string; totalBytes: number; truncated: boolean }
      assert.deepEqual(Object.keys(before).sort(), ['state', 'taskId', 'text', 'totalBytes', 'truncated'])
      assert.equal(before.taskId, 'fixture-command')
      assert.equal(before.state, 'available')
      assert.ok(before.text.includes('fixture listening'))
      assert.equal(before.totalBytes, Buffer.byteLength(before.text, 'utf8'))
      assert.equal(before.truncated, false)
      const background = await socket('fixture-plan', designBase)
      const from = background.events.length
      background.send({ type: 'stop_background_task', taskId: 'fixture-command' })
      const notification = await background.until('system_notification', from) as Extract<ServerMessage, { type: 'system_notification' }>
      assert.equal(object(notification.data).task_id, 'fixture-command')
      assert.equal(object(notification.data).status, 'stopped')
      assert.deepEqual(await (await fetch(outputUrl, { headers })).json(), before, 'Stopping keeps the command output intact')
      assert.equal((await fetch(`${outputUrl}?path=/fake`, { headers })).status, 400)
      assert.equal((await fetch(outputUrl, { method: 'POST', headers, body: '{}' })).status, 405)
      assert.equal((await fetch(outputUrl.replace('fixture-command/output', 'unknown/output'), { headers })).status, 404)
      assert.equal((await fetch(outputUrl.replace('fixture-command/output', 'fixture-agent-ui/output'), { headers })).status, 404)
      assert.equal((await fetch(outputUrl.replace('fixture-plan/', 'fixture-bench/'), { headers })).status, 404)
      assert.equal((await fetch(outputUrl.replace('fixture-command/output', '%2F/output'), { headers })).status, 400)
      background.ws.close()
    } finally {
      await designFixture.close()
    }
    const chat = await socket('fixture-chat')
    chat.send({ type: 'sync_state' })
    assert.equal(
      (
        (await chat.until('session_state')) as Extract<
          ServerMessage,
          { type: 'session_state' }
        >
      ).turnState,
      'idle'
    )
    chat.send({
      type: 'set_runtime_config',
      providerId: 'fixture-provider',
      modelId: 'fixture-opus',
      effortLevel: 'max',
    })
    assert.equal(
      (
        (await chat.until('runtime_config_applied')) as Extract<
          ServerMessage,
          { type: 'runtime_config_applied' }
        >
      ).modelId,
      'fixture-opus'
    )
    chat.send({ type: 'user_message', content: 'hello' })
    await chat.until('message_complete')
    assert.ok(chat.events.some((event) => event.type === 'tool_result'))
    assert.equal(
      (
        await fetch(
          `${base}/api/sessions/fixture-chat/messages?cursor=${encodeURIComponent(latest.page.nextCursor)}`,
          { headers }
        )
      ).status,
      409
    )
    for (const kind of ['approval', 'question', 'plan'] as const) {
      const client = await socket(`fixture-${kind}`)
      const request = (await client.until('permission_request')) as Pending
      const updatedInput =
        kind === 'question'
          ? {
              ...object(request.input),
              answers: {
                'Fixture: which side to check first?': 'iOS',
                'Fixture: which capabilities to check?': 'Model settings, approvals',
              },
            }
          : undefined
      client.send({
        type: 'permission_response',
        requestId: request.requestId,
        allowed: true,
        ...(updatedInput ? { updatedInput } : {}),
        ...(kind === 'plan'
          ? {
              runtimeOverride: {
                providerId: 'fixture-provider',
                modelId: 'fixture-opus',
              },
            }
          : {}),
      })
      await client.until('permission_resolved')
      await client.until('message_complete')
    }
    const from = chat.events.length
    chat.send({ type: 'user_message', content: '/slow' })
    await chat.until('content_start', from)
    chat.send({ type: 'stop_generation' })
    const stopped = (await chat.until('session_state', from)) as Extract<
      ServerMessage,
      { type: 'session_state' }
    >
    assert.equal(stopped.turnState, 'idle')
    const count = chat.events.length
    await Bun.sleep(800)
    assert.equal(
      chat.events.length,
      count,
      'Stop must cancel delayed streaming output'
    )
    console.log(
      'Fixture self-test passed: auth, paging/stale cursor, runtime, stream/tools, approval/question/plan, stop, retained background output'
    )
  } finally {
    for (const ws of sockets) ws.close()
    await fixture.close()
  }
}

if (import.meta.main) {
  if (process.argv.includes('--self-test')) await selfTest()
  else {
    const portArgument = process.argv
      .find((argument) => argument.startsWith('--port='))
      ?.slice('--port='.length)
    const fixture = startFixtureServer({
      port: portArgument === undefined ? 3457 : Number(portArgument),
      design: process.argv.includes('--design'),
    })
    const shutdown = () => {
      void fixture.close().then(() => process.exit(0))
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  }
}
