import { expect, test } from 'bun:test'
import { FIXTURE_TOKEN, startFixtureServer } from './fixture-server'
import { ApiClient } from '../src/core/client'
import { groupDashboard, type MobileActivity } from '../src/core/dashboard'
import { normalizeHistory } from '../src/core/chat'
import type {
  BackgroundSnapshot,
  Checkpoint,
  ScheduledTask,
  TaskRun,
} from '../src/core/operations'
import type {
  ClientMessage,
  HistoryPage,
  ServerEvent,
  Session,
} from '../src/core/types'
import { SessionTransport, type SocketLike } from '../src/core/sessionTransport'

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 4000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await Bun.sleep(5)
  }
}
function setup() {
  const fixture = startFixtureServer({ port: 0, quiet: true, design: true })
  const host = {
    id: `host-${fixture.server.port}`,
    name: 'Design fixture',
    url: `http://127.0.0.1:${fixture.server.port}`,
    auth: 'lan' as const,
  }
  const client = new ApiClient(host, FIXTURE_TOKEN)
  const sockets: WebSocket[] = []
  return {
    client,
    host,
    async socket(id: string) {
      const events: ServerEvent[] = []
      const ws = new WebSocket(
        `${host.url.replace('http:', 'ws:')}/ws/${id}?token=${FIXTURE_TOKEN}`
      )
      sockets.push(ws)
      ws.onmessage = (value) => events.push(JSON.parse(String(value.data)))
      await until(
        () => events.some((event) => event.type === 'connected'),
        'WS connected'
      )
      return {
        events,
        send: (event: ClientMessage) => ws.send(JSON.stringify(event)),
        async next<T extends ServerEvent['type']>(type: T, from = 0) {
          await until(
            () => events.slice(from).some((event) => event.type === type),
            type
          )
          return events
            .slice(from)
            .find((event) => event.type === type) as Extract<
            ServerEvent,
            { type: T }
          >
        },
      }
    },
    async close() {
      sockets.forEach((ws) => ws.close())
      await fixture.close()
    },
  }
}

test('Android Emulator origin connects over real WebSocket without widening fixture auth or bind', async () => {
  const fixture = startFixtureServer({ port: 0, quiet: true, design: true })
  const url = `http://127.0.0.1:${fixture.server.port}`
  let socket: WebSocket | undefined
  try {
    expect(fixture.server.hostname).toBe('127.0.0.1')
    const headers = { Origin: `http://10.0.2.2:${fixture.server.port}` }
    const unauthorized = await fetch(`${url}/__fixture/status`, { headers })
    expect(unauthorized.status).toBe(401)
    const forbidden = await fetch(`${url}/__fixture/status`, {
      headers: {
        Origin: 'https://untrusted.example',
        Authorization: `Bearer ${FIXTURE_TOKEN}`,
      },
    })
    expect(forbidden.status).toBe(403)
    const events: ServerEvent[] = []
    // Bun supports request headers; the mobile tsconfig also includes DOM's
    // narrower browser constructor, so describe this test-only overload.
    const FixtureWebSocket = WebSocket as unknown as new (
      url: string,
      options: { headers: Record<string, string> }
    ) => WebSocket
    socket = new FixtureWebSocket(
      `${url.replace('http:', 'ws:')}/ws/fixture-approval?token=${FIXTURE_TOKEN}`,
      { headers }
    )
    socket.onmessage = (event) => events.push(JSON.parse(String(event.data)))
    await until(
      () => events.some((event) => event.type === 'connected'),
      'Android WS connected'
    )
    await until(
      () => events.some((event) => event.type === 'permission_request'),
      'Android approval hydrated'
    )
  } finally {
    socket?.close()
    await fixture.close()
  }
})

test('design seed has six titled sessions: two waiting, two running and two explicitly idle today', async () => {
  const a = setup(),
    b = setup()
  try {
    await a.client.verify()
    const { sessions } = await a.client.get<{ sessions: Session[] }>(
      '/api/sessions'
    )
    const { sessions: activity } = await a.client.get<{
      sessions: MobileActivity[]
    }>('/api/sessions/mobile-status')
    const dashboard = groupDashboard(sessions, activity)
    expect(sessions).toHaveLength(6)
    expect(dashboard.waiting).toHaveLength(2)
    expect(dashboard.running).toHaveLength(2)
    expect(dashboard.completedToday).toBe(2)
    expect(sessions.map((session) => session.title)).toEqual([
      '修复 WebSocket 重连后消息重复',
      '迁移设置存储到 v3',
      '给移动端加扫码配对',
      '排查 Windows sidecar 内存占用',
      '整理 v0.7.6 发版说明',
      '统一桌面设置页的分组',
    ])
    await a.client.request('/api/sessions/fixture-release', {
      method: 'PATCH',
      body: { title: 'Only A' },
    })
    expect(
      (await b.client.get<Session>('/api/sessions/fixture-release/summary'))
        .title
    ).toBe('整理 v0.7.6 发版说明')
    await a.client.request('/api/sessions/fixture-settings', {
      method: 'DELETE',
    })
    expect(
      (await b.client.get<{ sessions: Session[] }>('/api/sessions')).sessions
    ).toHaveLength(6)
    expect(await a.client.get('/api/sessions/mobile-push')).toEqual({
      platforms: { ios: false, android: false },
      status: 'notConfigured',
    })
  } finally {
    await Promise.all([a.close(), b.close()])
  }
})

test('production transport hydrates exact question, cancels real deadline and submits exact answer', async () => {
  const fixture = setup()
  const errors: Error[] = []
  const transport = new SessionTransport({
    client: fixture.client,
    credential: FIXTURE_TOKEN,
    sessionId: 'fixture-question',
    platform: 'web',
    socketFactory: (options) =>
      new WebSocket(options.url) as unknown as SocketLike,
    onState() {},
    onConnection() {},
    onError: (error) => errors.push(error),
  })
  try {
    transport.start()
    await until(() => transport.connection === 'ready', 'transport ready')
    const request = transport.state.permissions[0]!
    expect(request.toolName).toBe('AskUserQuestion')
    expect(request.autoAnswerDeadline).toBeGreaterThan(Date.now())
    expect(
      transport.send({
        type: 'ask_user_question_activity',
        requestId: request.requestId,
      })
    ).toBe(true)
    await until(
      () => transport.state.permissions[0]?.autoAnswerDeadline === null,
      'deadline canceled'
    )
    const reconnect = await fixture.socket('fixture-question')
    expect(
      (await reconnect.next('permission_request')).autoAnswerDeadline
    ).toBeNull()
    expect(
      transport.send({
        type: 'permission_response',
        requestId: request.requestId,
        allowed: true,
        updatedInput: {
          questions: [],
          answers: { '旧字段怎么处理？': '迁移时保留，读取时兼容（推荐）' },
        },
      })
    ).toBe(true)
    await until(
      () =>
        transport.state.permissions.length === 0 && !transport.state.turnActive,
      'question completed'
    )
    expect(errors).toEqual([])
  } finally {
    transport.dispose()
    await fixture.close()
  }
})

test('approval deny and plan model/mode approval acknowledge only current request', async () => {
  const fixture = setup()
  try {
    const approval = await fixture.socket('fixture-approval')
    const request = await approval.next('permission_request')
    approval.send({
      type: 'permission_response',
      requestId: 'expired-request',
      allowed: true,
    })
    const snapshot = await approval.next('permission_requests_snapshot')
    expect(snapshot.toolRequestIds).toContain(request.requestId)
    approval.send({
      type: 'permission_response',
      requestId: request.requestId,
      allowed: false,
      denyMessage: '先解释测试范围',
    })
    expect((await approval.next('permission_resolved')).allowed).toBe(false)
    await approval.next('message_complete')
    await fixture.client.post('/__fixture/scenario', {
      sessionId: 'fixture-plan',
      kind: 'plan',
    })
    const plan = await fixture.socket('fixture-plan')
    const proposal = await plan.next('permission_request')
    expect(proposal.toolName).toBe('ExitPlanMode')
    plan.send({
      type: 'permission_response',
      requestId: proposal.requestId,
      allowed: true,
      runtimeOverride: {
        providerId: 'fixture-provider',
        modelId: 'fixture-opus',
        effortLevel: 'high',
      },
      permissionUpdates: [
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      ],
    })
    expect((await plan.next('runtime_config_applied')).modelId).toBe(
      'fixture-opus'
    )
    expect((await plan.next('permission_mode_changed')).mode).toBe(
      'acceptEdits'
    )
    await plan.next('message_complete')
    expect(
      (
        await fixture.client.get<{ sessions: MobileActivity[] }>(
          '/api/sessions/mobile-status'
        )
      ).sessions.find((session) => session.id === 'fixture-plan')?.activityState
    ).toBe('idle')
  } finally {
    await fixture.close()
  }
})

test('background stop updates WS and HTTP and full stop preserves partial reply', async () => {
  const fixture = setup()
  try {
    const socket = await fixture.socket('fixture-plan')
    const tasks = await fixture.client.get<BackgroundSnapshot>(
      '/api/sessions/fixture-plan/background-tasks'
    )
    expect(
      tasks.tasks.filter((task) => task.status === 'running')
    ).toHaveLength(3)
    const agent = tasks.tasks[0]!
    expect(
      await fixture.client.get(
        `/api/sessions/fixture-plan/subagents/by-tool/${agent.toolUseId}?taskId=${agent.taskId}`
      )
    ).toHaveProperty('status', 'running')
    socket.send({ type: 'stop_background_task', taskId: agent.taskId })
    await socket.next('system_notification')
    expect(
      (
        await fixture.client.get<BackgroundSnapshot>(
          '/api/sessions/fixture-plan/background-tasks'
        )
      ).tasks[0]!.status
    ).toBe('stopped')
    socket.send({ type: 'stop_generation' })
    await socket.next('session_state')
    expect(
      (
        await fixture.client.get<BackgroundSnapshot>(
          '/api/sessions/fixture-plan/background-tasks'
        )
      ).tasks.every((task) => task.status === 'stopped')
    ).toBe(true)
    const before = socket.events.length
    socket.send({ type: 'user_message', content: '/slow' })
    await socket.next('content_delta', before)
    await until(
      () =>
        socket.events
          .slice(before)
          .some(
            (event) =>
              event.type === 'content_delta' && typeof event.text === 'string'
          ),
      'partial text'
    )
    socket.send({ type: 'stop_generation' })
    await socket.next('session_state', before)
    const history = await fixture.client.get<HistoryPage>(
      '/api/sessions/fixture-plan/messages?mode=full'
    )
    expect(
      normalizeHistory(history.messages).some(
        (item) =>
          item.type === 'assistant' && item.text.startsWith('Fixture：收到了')
      )
    ).toBe(true)
  } finally {
    await fixture.close()
  }
})

test('attachment-only image and file blocks survive canonical HTTP history without reading paths', async () => {
  const fixture = setup()
  try {
    const socket = await fixture.socket('fixture-release')
    socket.send({
      type: 'user_message',
      content: '',
      attachments: [
        {
          type: 'image',
          name: 'sample.png',
          mimeType: 'image/png',
          data: 'aW1hZ2U=',
        },
        {
          type: 'file',
          name: 'sample.txt',
          mimeType: 'text/plain',
          data: Buffer.from('fixture material content').toString('base64'),
        },
      ],
    })
    await socket.next('message_complete')
    const history = await fixture.client.get<HistoryPage>(
      '/api/sessions/fixture-release/messages?mode=full'
    )
    const messages = normalizeHistory(history.messages)
    expect(
      messages.some((item) =>
        item.attachments?.some((item) => item.data === 'aW1hZ2U=')
      )
    ).toBe(true)
    expect(
      messages.some((item) => item.text.includes('fixture material content'))
    ).toBe(true)
  } finally {
    await fixture.close()
  }
})

test('checkpoint exact-target diff, dry-run, code-only and conversation rewind and fork are mutable', async () => {
  const fixture = setup()
  try {
    const path = '/api/sessions/fixture-release'
    const list = await fixture.client.get<{ checkpoints: Checkpoint[] }>(
      `${path}/turn-checkpoints`
    )
    const checkpoint = list.checkpoints[0]!
    const target = {
      targetUserMessageId: checkpoint.target.targetUserMessageId,
    }
    expect(checkpoint.code.filesChanged).toHaveLength(3)
    expect(
      await fixture.client.get(
        `${path}/turn-checkpoints/diff?${new URLSearchParams({ ...target, path: checkpoint.code.filesChanged[0]! })}`
      )
    ).toHaveProperty('state', 'ok')
    await expect(
      fixture.client.post(`${path}/rewind`, {
        targetUserMessageId: 'expired-id',
        mode: 'both',
      })
    ).rejects.toHaveProperty('status', 404)
    const original = await fixture.client.get<HistoryPage>(
      `${path}/messages?mode=full`
    )
    await fixture.client.post(`${path}/rewind`, {
      ...target,
      dryRun: true,
      mode: 'both',
    })
    expect(
      (await fixture.client.get<HistoryPage>(`${path}/messages?mode=full`))
        .messages
    ).toEqual(original.messages)
    const branch = await fixture.client.post<{ sessionId: string }>(
      `${path}/branch`,
      { targetMessageId: original.messages[0]!.id }
    )
    expect(
      (
        await fixture.client.get<HistoryPage>(
          `/api/sessions/${branch.sessionId}/messages`
        )
      ).messages
    ).toHaveLength(1)
    await fixture.client.post(`${path}/rewind`, { ...target, mode: 'code' })
    expect(
      (
        await fixture.client.get<{ checkpoints: Checkpoint[] }>(
          `${path}/turn-checkpoints`
        )
      ).checkpoints[0]!.code.filesChanged
    ).toEqual([])
    expect(
      (await fixture.client.get<HistoryPage>(`${path}/messages?mode=full`))
        .messages
    ).toEqual(original.messages)
    await fixture.client.post(`${path}/rewind`, {
      ...target,
      mode: 'conversation',
    })
    expect(
      (await fixture.client.get<HistoryPage>(`${path}/messages`)).messages
    ).toHaveLength(0)
    expect(
      (
        await fixture.client.get<HistoryPage>(
          `/api/sessions/${branch.sessionId}/messages`
        )
      ).messages
    ).toHaveLength(1)
  } finally {
    await fixture.close()
  }
})

test('schedule create/pause/run/results/delete and repository branches remain host isolated', async () => {
  const a = setup(),
    b = setup()
  try {
    expect(
      (await a.client.get<{ tasks: ScheduledTask[] }>('/api/scheduled-tasks'))
        .tasks
    ).toHaveLength(4)
    const { task } = await a.client.post<{ task: ScheduledTask }>(
      '/api/scheduled-tasks',
      {
        name: 'Smoke task',
        cron: '0 9 * * *',
        prompt: 'No actual model',
        enabled: true,
        recurring: true,
        permanent: true,
      }
    )
    await a.client.request(`/api/scheduled-tasks/${task.id}`, {
      method: 'PUT',
      body: { enabled: false },
    })
    expect(
      (
        await a.client.get<{ tasks: ScheduledTask[] }>('/api/scheduled-tasks')
      ).tasks.find((item) => item.id === task.id)?.enabled
    ).toBe(false)
    await expect(
      b.client.post(`/api/scheduled-tasks/${task.id}/run`, {})
    ).rejects.toHaveProperty('status', 404)
    await a.client.post(`/api/scheduled-tasks/${task.id}/run`, {})
    const { runs } = await a.client.get<{ runs: TaskRun[] }>(
      `/api/scheduled-tasks/${task.id}/runs`
    )
    expect(runs[0]!.status).toBe('running')
    await Bun.sleep(750)
    const { run } = await a.client.get<{ run: TaskRun }>(
      `/api/scheduled-tasks/runs/${runs[0]!.id}`
    )
    expect(run.status).toBe('completed')
    expect(run.output).toContain('没有运行命令或调用模型')
    await a.client.request(`/api/scheduled-tasks/${task.id}`, {
      method: 'DELETE',
    })
    expect(
      (await a.client.get<{ tasks: ScheduledTask[] }>('/api/scheduled-tasks'))
        .tasks
    ).toHaveLength(4)
    expect(
      (await b.client.get<{ tasks: ScheduledTask[] }>('/api/scheduled-tasks'))
        .tasks
    ).toHaveLength(4)
    await a.client.post('/api/sessions/repository-branch', {
      name: 'feat/design-test',
      workDir: '/fixture/cc-haha-demo',
      from: 'main',
    })
    const branchNames = async (client: ApiClient) =>
      (
        await client.get<{ branches: { name: string }[] }>(
          '/api/sessions/repository-context'
        )
      ).branches.map((branch) => branch.name)
    expect(await branchNames(a.client)).toContain('feat/design-test')
    expect(await branchNames(b.client)).not.toContain('feat/design-test')
  } finally {
    await Promise.all([a.close(), b.close()])
  }
})
