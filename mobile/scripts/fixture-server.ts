/**
 * LOCAL TEST FIXTURE ONLY. No model calls, child processes, user files or persistence.
 * Always binds 127.0.0.1. Start: bun scripts/fixture-server.ts --port=3457
 * Self-check: bun scripts/fixture-server.ts --self-test
 */
import assert from 'node:assert/strict'
import type { ServerWebSocket } from 'bun'
import type {
  ClientMessage,
  ServerMessage,
  PermissionMode,
} from '../../src/server/ws/events'
import type { HistoryEntry, Session } from '../src/core/types'
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
    name: 'Fixture Sonnet · 无真实模型',
    description: 'Deterministic local fixture',
    context: '200k',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'high',
  },
  {
    id: 'fixture-opus',
    name: 'Fixture Opus · 无真实模型',
    description: 'Second fixture model',
    context: '200k',
    supportedReasoningEfforts: EFFORTS,
    defaultReasoningEffort: 'high',
  },
]
const FILES: Record<string, string> = {
  'README.md':
    '# cc-haha mobile fixture\n\n本目录不存在于磁盘。这是内存中的测试文件。\n',
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
  }
  const scheduledTasks = new Map<string, ScheduledTask>()
  const scheduledRuns: TaskRun[] = []
  const branches = new Set(['main', 'feat/qr-pair', 'fix/ws-replay'])
  const providers: Record<string, unknown>[] = [
    {
      id: activeId,
      presetId: 'custom',
      name: 'Fixture API · 无真实调用',
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
    )
      session.lastProgressAt = Date.now()
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
  function pendingDecision(
    session: FixtureSession,
    kind: 'approval' | 'question' | 'plan',
    broadcast = true
  ) {
    const toolName =
      kind === 'question'
        ? 'AskUserQuestion'
        : kind === 'plan'
          ? 'ExitPlanMode'
          : 'Bash'
    const input =
      kind === 'question' && design
        ? {
            questions: [
              {
                question: '旧字段怎么处理？',
                header: '迁移策略',
                multiSelect: false,
                options: [
                  {
                    label: '迁移时保留，读取时兼容（推荐）',
                    description: '旧版桌面端还能打开同一份配置',
                  },
                  {
                    label: '迁移后直接丢弃',
                    description: '配置更干净，退回旧版会丢这些设置',
                  },
                  {
                    label: '保留一个版本后再删',
                    description: '下个版本再清理，需要记一条待办',
                  },
                ],
              },
            ],
          }
        : kind === 'question'
          ? {
              questions: [
                {
                  question: 'Fixture：先检查哪一端？',
                  header: '平台',
                  options: [
                    { label: 'iOS', description: '测试 iPhone 交互' },
                    { label: 'Android', description: '测试安卓交互' },
                  ],
                  multiSelect: false,
                },
                {
                  question: 'Fixture：检查哪些能力？',
                  header: '能力',
                  options: [
                    { label: '模型设置' },
                    { label: '审批' },
                    { label: '历史恢复' },
                  ],
                  multiSelect: true,
                },
              ],
            }
          : kind === 'plan'
            ? {
                plan: design
                  ? '# 用相机扫桌面二维码完成配对\n\n1. 扫码页：识别二维码里的地址和访问令牌\n   `src/app/connect.tsx`\n2. 校验地址，拒绝带路径或账号密码的地址\n   `src/core/connection.ts`\n3. 公网链接走原生配对，等电脑批准，5 分钟超时\n   `src/core/client.ts`\n4. 补测试：二维码解析、超时与取消\n   `src/core/connection.test.ts`'
                  : '# Fixture 实施计划\n\n1. 检查会话。\n2. 演示审批。\n3. 验证重连。\n\n不会修改任何真实文件。',
                planFilePath: '/fixture/plans/mobile.md',
                allowedPrompts: [
                  { tool: 'Bash', prompt: 'run fixture checks' },
                ],
              }
            : {
                command: design
                  ? 'bun test src/core/sessionTransport.test.ts'
                  : 'echo "FIXTURE: no command is executed"',
                description: '测试服务中的模拟命令，不执行 shell',
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
          'Fixture：倒计时已结束，测试服务选择了第一项；没有调用 AI。'
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
        ...(!design ? [{ type: 'text', text: 'Fixture：需要你的回应。' }] : []),
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
    const chat = create('fixture-chat', 'Fixture · 普通聊天与历史')
    for (let i = 1; i <= 4; i++) {
      append(chat, 'user', `第 ${i} 条测试问题`)
      append(
        chat,
        'assistant',
        [{ type: 'text', text: `Fixture 历史回复 ${i}，没有调用模型。` }],
        currentModel
      )
    }
    append(
      chat,
      'tool_use',
      [
        { type: 'text', text: '这是工具调用前的文本，应显示为助手内容。' },
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
      ['approval', '操作审批'],
      ['question', '回答问题'],
      ['plan', '确认计划'],
    ] as const) {
      const session = create(`fixture-${kind}`, `Fixture · ${label}`, {
        permissionMode: kind === 'plan' ? 'plan' : 'default',
      })
      append(session, 'user', `请演示${label}`)
      pendingDecision(session, kind, false)
    }
  }
  function seedDesign() {
    const approval = create('fixture-approval', '修复 WebSocket 重连后消息重复')
    append(
      approval,
      'user',
      '重连之后同一条回复会出现两次，帮我查原因并修掉，顺便补一个回归测试。'
    )
    append(
      approval,
      'assistant',
      [
        {
          type: 'text',
          text: '原因找到了：重连时 CLI 会重放缓冲区里的消息，前端按临时 id 去重，重放的消息拿到新 id 就漏了过去。我改成按服务端的稳定 id 去重。\n\n接下来跑一遍相关测试，确认没有回归。',
        },
      ],
      currentModel
    )
    pendingDecision(approval, 'approval', false)
    const question = create('fixture-question', '迁移设置存储到 v3')
    append(question, 'user', '把设置存储迁移到 v3，保留兼容性。')
    append(
      question,
      'assistant',
      [
        {
          type: 'text',
          text: '迁移脚本写好了。旧版 settings.json 里有 3 个字段在 v3 已经不用了：\n\n`sidebarWidth`  `legacyTheme`  `pinnedTabs`',
        },
      ],
      currentModel
    )
    pendingDecision(question, 'question', false)
    const plan = create('fixture-plan', '给移动端加扫码配对', {
      repository: { branch: 'feat/qr-pair' },
    })
    append(plan, 'user', '给移动端加扫码配对。')
    append(
      plan,
      'assistant',
      [
        {
          type: 'text',
          text: '正在整理扫码页与连接校验，已分配两个子 Agent。',
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
        description: '扫码页界面',
        status: 'running',
        summary: '编辑 src/app/connect.tsx',
        startedAt: new Date(Date.now() - 192000).toISOString(),
      },
      {
        taskId: 'fixture-agent-test',
        toolUseId: 'fixture-tool-test',
        taskType: 'local_agent',
        description: '配对超时测试',
        status: 'running',
        summary: '运行 bun test src/core/connection…',
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
    const bench = create('fixture-bench', '排查 Windows sidecar 内存占用')
    append(bench, 'user', '排查 Windows sidecar 的内存占用。')
    append(
      bench,
      'assistant',
      [{ type: 'text', text: '正在比较重复请求后的内存曲线。' }],
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
        '整理 v0.7.6 发版说明',
        '发版说明已经整理好，包含新增能力、修复和兼容性说明。',
      ],
      [
        'fixture-settings',
        '统一桌面设置页的分组',
        '设置页分组已统一为通用、模型、工具和连接。',
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
      ['每日依赖安全检查', '0 9 * * *', true],
      ['清理已合并的分支', '0 10 * * 1', true],
      ['整理昨天的新 issue', '30 8 * * 1-5', true],
      ['周报：本周合并的 PR', '0 18 * * 5', false],
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
              ? 'Fixture：发现 1 个高危依赖（设计验收样本）'
              : 'Fixture：7 个新 issue（设计验收样本）',
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
    task.summary = '测试服务已停止这项模拟活动'
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
      stalled: false,
      ...(!pending && !session.running && session.terminalOutcome
        ? { terminalOutcome: session.terminalOutcome, ...(session.completedAt !== undefined ? { completedAt: session.completedAt } : {}) }
        : {}),
      ...(pending
        ? {
            requestId: pending.requestId,
            toolName: pending.toolName,
            preview:
              pending.toolName === 'AskUserQuestion'
                ? '旧字段保留还是直接丢弃？'
                : typeof input.command === 'string'
                  ? input.command
                  : '计划已就绪',
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
        if (message.allowed && request.toolName === 'ExitPlanMode')
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
              ? 'Fixture 操作已允许；没有执行真实操作。'
              : `Fixture 已收到反馈：${message.denyMessage || '拒绝此操作'}`
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
            ? 'Fixture：将根据你的意见继续完善计划。'
            : `Fixture：已收到回应。${answer}`
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
                  text: `[文件: ${item.name ?? '附件'}]\n${Buffer.from(item.data!, 'base64').toString('utf8')}`,
                }
          )
        append(session, 'user', materials.length ? blocks : message.content)
        emit(session, { type: 'user_message_replay', content: message.content })
        if (session.running) {
          emit(session, {
            type: 'system_notification',
            subtype: 'fixture_followup',
            message: 'Fixture：追加内容已接收，当前请求仍在处理中。',
          })
          return
        }
        clearTimers(session)
        session.running = true
        delete session.completedAt
        delete session.terminalOutcome
        session.startedAt = Date.now()
        session.lastProgressAt = Date.now()
        emit(session, { type: 'status', state: 'thinking', verb: 'Fixture' })
        const prompt = message.content.toLowerCase()
        if (/\/error|模拟错误/.test(prompt))
          return schedule(session, 200, () => {
            session.running = false
            session.terminalOutcome = 'failed'
            emit(session, {
              type: 'error',
              code: 'FIXTURE_ERROR',
              message: '这是明确标注的模拟失败，可继续发新消息。',
              retryable: true,
            })
            emit(session, { type: 'status', state: 'idle' })
          })
        if (/\/question|回答问题|提问/.test(prompt))
          return schedule(session, 200, () =>
            pendingDecision(session, 'question')
          )
        if (/\/plan|计划/.test(prompt))
          return schedule(session, 200, () => pendingDecision(session, 'plan'))
        if (
          /\/approval|审批|批准/.test(prompt) &&
          !session.allowedTools.has('Bash')
        )
          return schedule(session, 200, () =>
            pendingDecision(session, 'approval')
          )
        if (/\/retry|模拟重试/.test(prompt))
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
            text: '这是可见的 fixture 思考块。',
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
            `Fixture：收到了「${message.content}」。这段回复通过真实 WebSocket 协议分段发送，没有调用模型或访问电脑文件。`,
            /\/slow|慢速/.test(prompt) ? 700 : 100
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
          return json({ tasks: [...scheduledTasks.values()] })
        if (!taskId && method === 'POST') {
          if (
            typeof body.prompt !== 'string' ||
            !body.prompt.trim() ||
            typeof body.cron !== 'string' ||
            body.cron.trim().split(/\s+/).length !== 5
          )
            return fail('A prompt and five-field cron are required')
          const task: ScheduledTask = {
            id: crypto.randomUUID(),
            name: typeof body.name === 'string' ? body.name : undefined,
            prompt: body.prompt,
            cron: body.cron,
            enabled: body.enabled !== false,
            recurring: body.recurring === true,
            permanent: body.permanent === true,
            folderPath:
              typeof body.folderPath === 'string' ? body.folderPath : undefined,
            createdAt: Date.now(),
          }
          scheduledTasks.set(task.id, task)
          return json({ task }, 201)
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
            task.name ?? 'Fixture 定时任务',
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
            run.output = `Fixture：${run.taskName} 的内存演示已完成。没有运行命令或调用模型。`
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
          for (const key of ['name', 'prompt', 'cron', 'folderPath'] as const)
            if (typeof body[key] === 'string') task[key] = body[key]
          for (const key of ['enabled', 'recurring', 'permanent'] as const)
            if (typeof body[key] === 'boolean') task[key] = body[key]
          return json({ task })
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
        const session = create(crypto.randomUUID(), 'Fixture · 新会话', body)
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
        if (action === 'slash-commands' && method === 'GET')
          return json({
            commands: [
              {
                name: 'review',
                description: '检查当前改动（Fixture 演示）',
                kind: 'skill',
              },
              {
                name: 'explain',
                description: '解释代码（Fixture 演示）',
                kind: 'command',
              },
            ],
          })
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
                result: `Fixture：${task.description}\n${task.summary ?? ''}\n这是内存测试输出，没有运行子进程。`,
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
              : `${session.summary.title} · 分支`,
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
          !['approval', 'question', 'plan', 'idle'].includes(String(body.kind))
        )
          return fail(
            'Specify an existing sessionId and approval/question/plan/idle kind'
          )
        stop(session)
        if (body.kind !== 'idle')
          pendingDecision(
            session,
            body.kind as 'approval' | 'question' | 'plan'
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
      `LOCAL ${design ? 'DESIGN ' : ''}FIXTURE ONLY — no models, no real files\nHost: ${hostName}\nURL: http://127.0.0.1:${server.port}\nFake token: ${FIXTURE_TOKEN}\nCommands: /approval /question /plan /slow /error /retry`
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
    assert.equal(latest.messages.length, 6)
    assert.ok(latest.page.nextCursor)
    const older = (await (
      await fetch(
        `${base}/api/sessions/fixture-chat/messages?cursor=${encodeURIComponent(latest.page.nextCursor)}`,
        { headers }
      )
    ).json()) as { messages: HistoryEntry[] }
    assert.equal(older.messages.length, 4)
    async function socket(id: string) {
      const events: ServerMessage[] = []
      const ws = new WebSocket(
        `${base.replace('http:', 'ws:')}/ws/${id}?token=${FIXTURE_TOKEN}`
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
                'Fixture：先检查哪一端？': 'iOS',
                'Fixture：检查哪些能力？': '模型设置, 审批',
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
      'Fixture self-test passed: auth, paging/stale cursor, runtime, stream/tools, approval/question/plan, stop'
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
