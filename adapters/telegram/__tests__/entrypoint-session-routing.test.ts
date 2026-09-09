import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { SessionStore } from '../../common/session-store.js'
import { AttachmentStore } from '../../common/attachment/attachment-store.js'

// Import the actual entrypoint with isolated configuration. Telegram API calls
// terminate in grammY's documented transformer; HTTP and WS use loopback only.
describe('Telegram entrypoint session routing', () => {
  const envKeys = ['CLAUDE_CONFIG_DIR', 'TELEGRAM_BOT_TOKEN', 'ADAPTER_SERVER_URL', 'ADAPTER_ALLOWED_PROJECT_ROOTS', 'ADAPTER_DEFAULT_PROJECT_DIR', 'CLAUDE_ADAPTER_DEFAULT_WORK_DIR', 'CC_HAHA_LOCAL_ACCESS_TOKEN']
  const previousEnv = new Map<string, string | undefined>()
  let directory: string
  let project: string
  let worktree: string
  let entry: typeof import('../index.js')
  let server: ReturnType<typeof Bun.serve<{ sessionId: string }>>
  let store: SessionStore
  let nextId = 100
  const apiCalls: Array<{ method: string; payload: any }> = []
  const requests: string[] = []
  const messages: Array<{ sessionId: string; message: any }> = []
  const sockets = new Map<string, Set<ServerWebSocket<{ sessionId: string }>>>()
  const sessionPaths = new Map<string, string>()

  async function eventually(assertion: () => void): Promise<void> {
    const deadline = Date.now() + 2500
    while (true) {
      try { assertion(); return } catch (error) {
        if (Date.now() >= deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
  }

  function texts(chatId: number): string[] {
    return apiCalls.filter((call) => call.payload.chat_id === chatId && call.payload.text).map((call) => call.payload.text)
  }

  async function text(chatId: number, value: string, options: { userId?: number; messageId?: number; photo?: boolean } = {}): Promise<void> {
    const messageId = options.messageId ?? nextId++
    const message = {
      message_id: messageId,
      date: 1,
      chat: { id: chatId, type: 'private' },
      from: { id: options.userId ?? 7, is_bot: false, first_name: 'Fixture' },
      ...(options.photo ? {
        photo: [{ file_id: 'fixture-photo', file_unique_id: 'unique', width: 1, height: 1 }],
        caption: value,
      } : {
        text: value,
        ...(value.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: value.split(' ')[0].length }] } : {}),
      }),
    }
    await entry.bot.handleUpdate({ update_id: messageId, message } as any)
  }

  async function callback(chatId: number, data: string, id = `callback-${nextId++}`): Promise<void> {
    await entry.bot.handleUpdate({
      update_id: nextId++,
      callback_query: {
        id, data, chat_instance: 'fixture',
        from: { id: 7, is_bot: false, first_name: 'Fixture' },
        message: { message_id: 1, date: 1, chat: { id: chatId, type: 'private' }, text: 'fixture menu' },
      },
    } as any)
  }

  function broadcast(sessionId: string, message: unknown): void {
    for (const socket of sockets.get(sessionId) ?? []) socket.send(JSON.stringify(message))
  }

  beforeAll(async () => {
    for (const key of envKeys) previousEnv.set(key, process.env[key])
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'telegram-entry-')))
    project = join(directory, 'repo')
    worktree = join(directory, 'repo-feature')
    mkdirSync(project)
    mkdirSync(worktree)
    for (const id of ['old', 'history', 'running', 'stream']) sessionPaths.set(id, id === 'history' ? worktree : project)
    server = Bun.serve<{ sessionId: string }>({
      hostname: '127.0.0.1', port: 0,
      async fetch(request, server) {
        const url = new URL(request.url)
        requests.push(`${request.method} ${url.pathname}`)
        if (url.pathname.startsWith('/ws/')) {
          if (server.upgrade(request, { data: { sessionId: url.pathname.split('/')[2] } })) return
          return new Response('upgrade failed', { status: 400 })
        }
        if (url.pathname === '/api/sessions/recent-projects') return Response.json({ projects: [{ projectName: 'repo', realPath: project, projectPath: '-fixture-repo', branch: 'main', sessionCount: 3 }] })
        if (url.pathname === '/api/sessions' && request.method === 'POST') {
          const body = await request.json() as { workDir: string }
          const sessionId = `created-${nextId++}`
          sessionPaths.set(sessionId, body.workDir)
          return Response.json({ sessionId })
        }
        if (url.pathname === '/api/sessions') return Response.json({
          sessions: ['history', 'running', 'old'].map((id, index) => ({ id, title: `${id} title`, createdAt: '2026-01-01', modifiedAt: `2026-06-0${3 - index}`, workDir: sessionPaths.get(id), projectRoot: project, projectPath: '-fixture-repo', workDirExists: true, messageCount: 4 })), total: 3,
        })
        const sessionId = url.pathname.split('/')[3]
        if (sessionPaths.has(sessionId)) return Response.json({ workDir: sessionPaths.get(sessionId), repoName: 'repo', branch: 'main' })
        if (url.pathname === '/api/skills') return Response.json({ skills: [{ name: 'fixture', displayName: 'Fixture', description: 'Fixture skill', source: 'plugin', userInvocable: true }] })
        if (url.pathname === '/api/models/current') return Response.json({ model: { id: 'fixture-model' } })
        if (url.pathname === '/api/tasks') return Response.json({ tasks: [] })
        return new Response('Unexpected fixture endpoint', { status: 404 })
      },
      websocket: {
        open(socket) {
          const peers = sockets.get(socket.data.sessionId) ?? new Set()
          peers.add(socket)
          sockets.set(socket.data.sessionId, peers)
          socket.send(JSON.stringify({ type: 'connected' }))
          socket.send(JSON.stringify({ type: 'permission_requests_snapshot', turnActive: socket.data.sessionId === 'running', toolRequestIds: [], computerUseRequestIds: [] }))
        },
        message(socket, raw) {
          const message = JSON.parse(String(raw))
          messages.push({ sessionId: socket.data.sessionId, message })
          if (message.content === '/clear') socket.send(JSON.stringify({ type: 'message_complete' }))
        },
        close(socket) { sockets.get(socket.data.sessionId)?.delete(socket) },
      },
    })
    process.env.CLAUDE_CONFIG_DIR = directory
    process.env.TELEGRAM_BOT_TOKEN = '12345:fixture-token'
    process.env.ADAPTER_SERVER_URL = `ws://127.0.0.1:${server.port}`
    process.env.ADAPTER_ALLOWED_PROJECT_ROOTS = directory
    process.env.ADAPTER_DEFAULT_PROJECT_DIR = project
    process.env.CLAUDE_ADAPTER_DEFAULT_WORK_DIR = project
    process.env.CC_HAHA_LOCAL_ACCESS_TOKEN = 'fixture-local-token'
    writeFileSync(join(directory, 'adapters.json'), JSON.stringify({ telegram: { allowedUsers: [7], defaultWorkDir: project, allowedProjectRoots: [directory] } }))
    store = new SessionStore(join(directory, 'adapter-sessions.json'))
    entry = await import('../index.js')
    entry.bot.botInfo = { id: 12345, is_bot: true, first_name: 'Fixture', username: 'fixture_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_manage_bots: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false }
    entry.bot.api.config.use(async (_previous, method, payload) => {
      apiCalls.push({ method, payload })
      if (method === 'getFile') throw new Error('Fixture download rejected before network')
      return { ok: true, result: ['answerCallbackQuery', 'deleteMessage'].includes(method) ? true : { message_id: nextId++, date: 1, chat: { id: (payload as any).chat_id, type: 'private' }, text: (payload as any).text } } as any
    })
  })

  afterAll(async () => {
    entry?.stopTelegramAdapter()
    await server?.stop(true)
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  it('runs registered history commands after authorization and deduplication', async () => {
    const before = requests.length
    await text(701, '/sessions', { userId: 99 })
    expect(texts(701).at(-1)).toContain('未授权')
    expect(requests.length).toBe(before)
    store.set('702', 'old', project)
    await text(702, '/sessions', { messageId: 10001 })
    const afterFirst = requests.length
    await text(702, '/sessions', { messageId: 10001 })
    expect(requests.length).toBe(afterFirst)
    await text(702, '/resume 1')
    expect(store.get('702')?.sessionId).toBe('history')
    expect(store.get('702')?.workDir).toBe(worktree)
    await text(702, 'Continue this history')
    await eventually(() => expect(messages.some((item) => item.sessionId === 'history' && item.message.content === 'Continue this history')).toBe(true))
    await text(702, '/sessions')
    await text(702, '/resume 3')
    expect(store.get('702')?.sessionId).toBe('history')
    expect(texts(702).at(-1)).toContain('/stop')
    broadcast('history', { type: 'message_complete' })
  })

  it('reads active-turn snapshots when resuming history before any status event', async () => {
    store.set('703', 'old', project)
    await text(703, '/sessions')
    await text(703, '/resume 2')
    expect(store.get('703')?.sessionId).toBe('running')
    await text(703, '/sessions')
    await text(703, '1')
    expect(store.get('703')?.sessionId).toBe('running')
    expect(texts(703).at(-1)).toContain('/stop')
  })

  it('serializes menu and text input and clears conflicting selection states', async () => {
    store.set('704', 'old', project)
    await Promise.all([text(704, '/sessions'), text(704, '/resume')])
    expect(texts(704).at(-1)).toContain('选择要恢复的项目')
    await text(704, '/resume 1')
    expect(texts(704).at(-1)).toContain('已过期')
    await callback(704, 'tgsel:resume_project:pick:0', 'dedup-callback')
    const afterFirst = requests.length
    await callback(704, 'tgsel:resume_project:pick:0', 'dedup-callback')
    expect(requests.length).toBe(afterFirst)
    await callback(704, 'tgsel:resume_session:pick:0')
    expect(store.get('704')?.sessionId).toBe('history')
    await text(704, '/sessions')
    await text(704, '/projects')
    await text(704, 'repo')
    expect(store.get('704')?.sessionId).toStartWith('created-')
    expect(store.get('704')?.workDir).toBe(project)
    await text(704, '/projects')
    await text(704, worktree)
    expect(store.get('704')?.workDir).toBe(worktree)
    await text(704, '/new')
    expect(store.get('704')?.workDir).toBe(project)
  })

  it('keeps failed-download captions as conversation content and routes permission callbacks', async () => {
    store.set('705', 'old', project)
    await text(705, '/sessions')
    const logError = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await text(705, '/resume 1', { photo: true })
      expect(logError).toHaveBeenCalled()
    } finally {
      logError.mockRestore()
    }
    expect(store.get('705')?.sessionId).toBe('old')
    await eventually(() => expect(messages.some((item) => item.sessionId === 'old' && item.message.content === '/resume 1')).toBe(true))
    broadcast('old', { type: 'permission_request', requestId: 'fixture-request', toolName: 'Bash', input: { command: 'echo fixture' } })
    await eventually(() => expect(texts(705).some((value) => value.includes('fixture-request'))).toBe(true))
    await callback(705, 'permit:fixture-request:yes')
    await eventually(() => expect(messages.some((item) => item.message.type === 'permission_response' && item.message.requestId === 'fixture-request')).toBe(true))
    broadcast('old', { type: 'message_complete' })
    await text(705, '/clear')
    await eventually(() => expect(messages.some((item) => item.message.content === '/clear')).toBe(true))
  })

  it('updates model and busy state through existing Skill and model menu wiring', async () => {
    store.set('706', 'old', project)
    await text(706, '/model fixture-model')
    await eventually(() => expect(texts(706).some((value) => value.includes('已切换模型'))).toBe(true))
    await text(706, '/skills')
    await eventually(() => expect(texts(706).some((value) => value.includes('当前项目可用 Skills'))).toBe(true))
    await callback(706, 'tgsel:skill:pick:0')
    await text(706, '/sessions')
    await text(706, '/resume 1')
    expect(store.get('706')?.sessionId).toBe('old')
    expect(texts(706).at(-1)).toContain('/stop')
  })

  it('accepts desktop permission resolution and restores history after completion', async () => {
    store.set('707', 'old', project)
    await text(707, 'Need approval')
    broadcast('old', { type: 'permission_request', requestId: 'desktop-request', toolName: 'Bash', input: { command: 'echo fixture' } })
    await eventually(() => expect(texts(707).some((value) => value.includes('desktop-request'))).toBe(true))
    broadcast('old', { type: 'permission_resolved', permissionType: 'tool', requestId: 'desktop-request' })
    broadcast('old', { type: 'message_complete' })
    await text(707, '/status')
    await eventually(() => expect(texts(707).some((value) => value.includes('old'))).toBe(true))
    await text(707, '/stop')
    await eventually(() => expect(messages.some((item) => item.sessionId === 'old' && item.message.type === 'stop_generation')).toBe(true))
    await text(707, '/sessions')
    await text(707, '/resume 1')
    expect(store.get('707')?.sessionId).toBe('history')
    expect(texts(707).at(-1)).toContain('已恢复会话')
  })

  it('delivers a resumed answer and accepts text approval through the same entrypoint', async () => {
    store.set('708', 'stream', project)
    await text(708, 'Show the result')
    await eventually(() => expect(messages.some((item) => item.sessionId === 'stream' && item.message.content === 'Show the result')).toBe(true))
    broadcast('stream', { type: 'status', state: 'thinking', verb: 'Thinking' })
    broadcast('stream', { type: 'thinking', text: 'Checking the previous context' })
    broadcast('stream', { type: 'content_start', blockType: 'text' })
    broadcast('stream', { type: 'content_delta', text: 'Result from the restored session.' })
    broadcast('stream', { type: 'content_start', blockType: 'tool_use' })
    broadcast('stream', { type: 'tool_use_complete' })
    broadcast('stream', { type: 'tool_result' })
    broadcast('stream', { type: 'system_notification', subtype: 'init', data: { model: 'fixture-model' } })
    broadcast('stream', { type: 'permission_request', requestId: 'text-request', toolName: 'Bash', input: { command: 'echo fixture' } })
    await eventually(() => expect(texts(708).some((value) => value.includes('text-request'))).toBe(true))
    await text(708, '/allow text-request')
    await eventually(() => expect(messages.some((item) => item.sessionId === 'stream' && item.message.type === 'permission_response' && item.message.requestId === 'text-request')).toBe(true))
    broadcast('stream', { type: 'message_complete' })
    broadcast('stream', { type: 'error', message: 'Fixture turn failed' })
    await eventually(() => expect(texts(708).some((value) => value.includes('Fixture turn failed'))).toBe(true))
    expect(texts(708).some((value) => value.includes('Result from the restored session.'))).toBe(true)
    expect(texts(708).some((value) => value.includes('Checking the previous context'))).toBe(true)
  })

  it('starts the registered bot and publishes its menu without external access', async () => {
    const gc = spyOn(AttachmentStore.prototype, 'gc').mockResolvedValue({ removed: 0, bytes: 0 })
    const start = spyOn(entry.bot, 'start').mockImplementation(async (options) => { await options?.onStart?.(entry.bot.botInfo) })
    const previousListeners = process.listeners('SIGINT')
    try {
      entry.startTelegramAdapter()
      await eventually(() => expect(apiCalls.some((call) => call.method === 'setMyCommands')).toBe(true))
      expect(gc).toHaveBeenCalledTimes(1)
      expect(start).toHaveBeenCalledTimes(1)
      const commands = apiCalls.find((call) => call.method === 'setMyCommands')!.payload.commands
      expect(commands.some((command: { command: string }) => command.command === 'sessions')).toBe(true)
    } finally {
      for (const listener of process.listeners('SIGINT')) {
        if (!previousListeners.includes(listener)) process.removeListener('SIGINT', listener)
      }
      start.mockRestore()
      gc.mockRestore()
    }
  })
})
