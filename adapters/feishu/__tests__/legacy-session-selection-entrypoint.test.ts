import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { enqueue } from '../../common/chat-queue.js'
import { StreamingCard } from '../streaming-card.js'
import { FeishuMediaService } from '../media.js'
import { WechatMediaService } from '../../wechat/media.js'

type Platform = 'feishu' | 'dingtalk' | 'wechat' | 'whatsapp'
const platforms: Platform[] = ['feishu', 'dingtalk', 'wechat', 'whatsapp']
const chatFor = (platform: Platform) => platform === 'dingtalk' ? 'dingtalk:dm:fixture-user' : `${platform}-chat`
let feishu: typeof import('../index.js')
let dingtalk: typeof import('../../dingtalk/index.js')
let wechat: typeof import('../../wechat/index.js')
let whatsapp: typeof import('../../whatsapp/index.js')
let server: Bun.Server<{ sessionId: string }>
let temporaryRoot: string
let httpOrigin: string
let sequence = 0
let newSessionCount = 0
let preflightGate: Promise<void> | undefined
let preflightStarted: (() => void) | undefined
const notices: string[] = []
const sentPrompts: Array<{ sessionId: string; content: string }> = []
const spies: Array<{ mockRestore(): void }> = []
const originalFetch = globalThis.fetch
const environmentKeys = [
  'HOME', 'CLAUDE_CONFIG_DIR', 'ADAPTER_SERVER_URL', 'ADAPTER_ALLOWED_PROJECT_ROOTS',
  'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET',
  'WECHAT_ACCOUNT_ID', 'WECHAT_BOT_TOKEN', 'WECHAT_BASE_URL', 'WHATSAPP_AUTH_DIR',
  'CC_HAHA_LOCAL_ACCESS_TOKEN',
]
const savedEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]))

function entries() {
  return [{
    id: 'history-active', title: 'Existing history', workDir: temporaryRoot,
    projectRoot: temporaryRoot, projectPath: 'fixture', workDirExists: true,
    modifiedAt: '2026-09-08T00:00:00Z', createdAt: '2026-09-01T00:00:00Z', messageCount: 4,
  }]
}

beforeAll(async () => {
  temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-im-import-')))
  server = Bun.serve<{ sessionId: string }>({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request, currentServer) {
      const url = new URL(request.url)
      if (url.pathname.startsWith('/ws/')) {
        if (currentServer.upgrade(request, { data: { sessionId: url.pathname.slice(4) } })) return
        return new Response('upgrade required', { status: 400 })
      }
      if (url.pathname === '/api/sessions/recent-projects') {
        return Response.json({ projects: [{
          projectName: 'Fixture', realPath: temporaryRoot, projectPath: 'fixture', isGit: false,
          repoName: null, branch: null, modifiedAt: '2026-09-08', sessionCount: 1,
        }] })
      }
      if (url.pathname === '/api/sessions' && request.method === 'POST') {
        newSessionCount++
        return Response.json({ sessionId: `new-${newSessionCount}` })
      }
      if (url.pathname === '/api/sessions') return Response.json({ sessions: entries(), total: 1 })
      if (url.pathname.endsWith('/git-info')) return Response.json({ repoName: 'Fixture', workDir: temporaryRoot, branch: 'main' })
      if (url.pathname.startsWith('/api/tasks/lists/')) return Response.json({ tasks: [{ id: 'task', subject: 'Fixture task', status: 'pending' }] })
      if (url.pathname.startsWith('/api/sessions/')) {
        if (url.pathname.endsWith('/history-active') && preflightGate) {
          preflightStarted?.()
          await preflightGate
        }
        return Response.json({ workDir: temporaryRoot, permissionMode: 'default' })
      }
      if (url.pathname === '/dingtalk' || url.pathname === '/ilink/bot/sendmessage') {
        notices.push(await request.text())
        return Response.json({ ret: 0 })
      }
      if (url.pathname === '/ilink/bot/getconfig') return Response.json({ ret: 0 })
      if (url.pathname === '/ilink/bot/sendtyping') return Response.json({ ret: 0 })
      return new Response(`Unexpected fixture request ${url.pathname}`, { status: 500 })
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify({ type: 'connected' }))
        socket.send(JSON.stringify({
          type: 'permission_requests_snapshot', toolRequestIds: [],
          turnActive: socket.data.sessionId === 'history-active',
        }))
      },
      message(socket, raw) {
        const message = JSON.parse(String(raw))
        if (message.type === 'user_message') sentPrompts.push({ sessionId: socket.data.sessionId, content: message.content })
      },
    },
  })
  httpOrigin = `http://127.0.0.1:${server.port}`
  const env = {
    HOME: temporaryRoot,
    CLAUDE_CONFIG_DIR: path.join(temporaryRoot, '.claude'),
    ADAPTER_SERVER_URL: httpOrigin.replace('http:', 'ws:'),
    ADAPTER_ALLOWED_PROJECT_ROOTS: temporaryRoot,
    FEISHU_APP_ID: 'fixture-app', FEISHU_APP_SECRET: 'fixture-secret',
    DINGTALK_CLIENT_ID: 'fixture-client', DINGTALK_CLIENT_SECRET: 'fixture-secret',
    WECHAT_ACCOUNT_ID: 'fixture-account', WECHAT_BOT_TOKEN: 'fixture-token', WECHAT_BASE_URL: httpOrigin,
    WHATSAPP_AUTH_DIR: path.join(temporaryRoot, 'whatsapp-auth'), CC_HAHA_LOCAL_ACCESS_TOKEN: '',
  }
  Object.assign(process.env, env)
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })
  fs.mkdirSync(env.WHATSAPP_AUTH_DIR, { recursive: true })
  fs.writeFileSync(path.join(env.WHATSAPP_AUTH_DIR, 'creds.json'), JSON.stringify({ registered: true, me: { id: 'fixture' } }))
  const platformConfig = { defaultWorkDir: temporaryRoot, allowedProjectRoots: [temporaryRoot], allowedUsers: ['fixture-user', ...platforms.map(chatFor)] }
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, 'adapters.json'), JSON.stringify({
    serverUrl: env.ADAPTER_SERVER_URL, allowedProjectRoots: [temporaryRoot],
    feishu: platformConfig, dingtalk: platformConfig, wechat: platformConfig, whatsapp: platformConfig,
  }))
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin === httpOrigin) return originalFetch(input, init)
    if (url.href === 'https://api.dingtalk.com/v1.0/oauth2/accessToken') {
      return Response.json({ accessToken: 'fixture-access-token', expireIn: 7200 })
    }
    throw new Error(`External network is forbidden in this fixture: ${url.origin}${url.pathname}`)
  }) as typeof fetch
  feishu = await import('../index.js')
  dingtalk = await import('../../dingtalk/index.js')
  wechat = await import('../../wechat/index.js')
  whatsapp = await import('../../whatsapp/index.js')
  spies.push(spyOn(feishu.larkClient.im.message, 'create').mockImplementation(async (request: any) => {
    notices.push(String(request.data.content))
    return { code: 0, data: { message_id: `fixture-${++sequence}` } }
  }))
  const attachment = { kind: 'image' as const, name: 'fixture.png', path: path.join(temporaryRoot, 'fixture.png'), buffer: Buffer.from('fixture'), size: 7, mimeType: 'image/png' }
  spies.push(spyOn(FeishuMediaService.prototype, 'downloadResource').mockImplementation(async () => attachment))
  spies.push(spyOn(WechatMediaService.prototype, 'downloadCandidate').mockImplementation(async () => attachment))
  spies.push(spyOn(StreamingCard.prototype, 'ensureCreated').mockImplementation(async () => {}))
  spies.push(spyOn(StreamingCard.prototype, 'abort').mockImplementation(async () => {}))
  spies.push(spyOn(StreamingCard.prototype, 'finalize').mockImplementation(async () => {}))
  whatsapp.useWhatsAppSocket({ sendMessage: async (_chatId: string, message: { text: string }) => { notices.push(message.text) } } as any)
})

afterAll(async () => {
  for (const adapter of [feishu, dingtalk, wechat, whatsapp]) {
    adapter?.bridge.destroy()
    adapter?.dedup.destroy()
  }
  wechat?.typingController.destroy()
  for (const spy of spies.reverse()) spy.mockRestore()
  globalThis.fetch = originalFetch
  server?.stop(true)
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true })
})

function adapterFor(platform: Platform) {
  return { feishu, dingtalk, wechat, whatsapp }[platform]
}

async function send(platform: Platform, text: string, options: { unauthorized?: boolean; attachment?: boolean } = {}) {
  const userId = options.unauthorized ? 'outsider' : 'fixture-user'
  const chatId = options.unauthorized && platform === 'wechat' ? 'outsider' : chatFor(platform)
  sequence++
  if (platform === 'feishu') {
    await feishu.handleMessage({
      sender: { sender_id: { open_id: userId } },
      message: { message_id: `message-${sequence}`, chat_id: chatId, chat_type: 'p2p', message_type: options.attachment ? 'post' : 'text', content: JSON.stringify(options.attachment ? { zh_cn: { content: [[{ tag: 'text', text }, { tag: 'img', image_key: 'fixture-image' }]] } } : { text }) },
    })
  } else if (platform === 'dingtalk') {
    if (options.attachment) {
      await dingtalk.routeUserMessage(chatId, text, [{ type: 'image', data: 'Zml4dHVyZQ==', mimeType: 'image/png' }])
    } else await dingtalk.handleRobotMessage({
      conversationType: '1', senderStaffId: userId, senderId: chatId,
      conversationId: chatId, msgtype: 'text',
      text: { content: text }, sessionWebhook: `${httpOrigin}/dingtalk`,
    })
  } else if (platform === 'wechat') {
    await wechat.routeUserMessage({ from_user_id: chatId, message_id: sequence, item_list: [{ type: 1, text_item: { text } }, ...(options.attachment ? [{ type: 2, image_item: { media: { full_url: 'https://fixture.invalid/image.png' } } }] : [])] })
  } else {
    await whatsapp.routeUserMessage(chatId, userId, 'Fixture User', text, options.attachment ? [{ type: 'image', data: 'Zml4dHVyZQ==', mimeType: 'image/png' }] : [])
  }
  // Flush the actual adapter's per-chat queue without assuming its handler awaits it.
  await enqueue(platform === 'dingtalk' && options.unauthorized ? 'dingtalk:dm:outsider' : chatId, async () => {})
}

for (const platform of platforms) {
  describe(`${platform} actual module session selection`, () => {
    it('restores original history and honors the real initial active-turn snapshot', async () => {
      const adapter = adapterFor(platform)
      const chatId = chatFor(platform)
      adapter.sessionStore.set(chatId, 'current', temporaryRoot)
      const creationsBefore = newSessionCount
      const sendSpy = spyOn(adapter.bridge, 'sendUserMessage')
      spies.push(sendSpy)
      await send(platform, '/sessions')
      expect(adapter.sessionStore.get(chatId)?.sessionId).toBe('current')
      await send(platform, '/resume 1')
      await enqueue(chatId, async () => {})
      expect(adapter.sessionStore.get(chatId)?.sessionId).toBe('history-active')
      expect(adapter.getRuntimeState(chatId).state).toBe('thinking')
      expect(newSessionCount).toBe(creationsBefore)
      expect(sendSpy).not.toHaveBeenCalled()
      await send(platform, '/sessions')
      await send(platform, '/resume 1')
      expect(notices.at(-1)).toContain('正在运行')
      await adapter.handleServerMessage(chatId, { type: 'status', state: 'idle' })
      sendSpy.mockRestore()
    })

    it('invalidates history selection through project picking, new sessions and project cards', async () => {
      const adapter = adapterFor(platform)
      const chatId = chatFor(platform)
      await send(platform, '/sessions')
      await send(platform, '/projects')
      expect(await adapter.sessionSelectionController.handleInput(chatId, '1')).toBe(false)
      await send(platform, '/new Fixture')
      expect(adapter.sessionStore.get(chatId)?.sessionId).toStartWith('new-')
      await send(platform, '/sessions')
      if (platform === 'feishu') {
        await feishu.handleCardAction({ context: { open_chat_id: chatId }, action: { value: { action: 'pick_project', realPath: temporaryRoot, projectName: 'Fixture' } } })
      } else {
        expect(await adapter.createSessionForChat(chatId, temporaryRoot)).toBe(true)
      }
      expect(await adapter.sessionSelectionController.handleInput(chatId, '1')).toBe(false)
    })

    it('rejects unpaired users and leaves attachment text on the normal send path', async () => {
      const adapter = adapterFor(platform)
      const chatId = chatFor(platform)
      const binding = adapter.sessionStore.get(chatId)?.sessionId
      await send(platform, '/sessions', { unauthorized: true })
      expect(notices.at(-1)).toContain('未授权')
      expect(adapter.sessionStore.get(chatId)?.sessionId).toBe(binding)
      adapter.clearTransientChatState(chatId)
      await send(platform, '/sessions')
      const sendSpy = spyOn(adapter.bridge, 'sendUserMessage')
      try {
        await send(platform, '/sessions', { attachment: true })
        expect(sendSpy).toHaveBeenCalledTimes(1)
        expect(sendSpy.mock.calls[0]?.[1]).toBe('/sessions')
        expect(sendSpy.mock.calls[0]?.[2]?.[0]?.type).toBe('image')
      } finally { sendSpy.mockRestore() }
      adapter.clearTransientChatState(chatId)
    })

    it('keeps numeric approval ahead of history and accepts desktop permission resolution', async () => {
      const adapter = adapterFor(platform)
      const chatId = chatFor(platform)
      await send(platform, '/sessions')
      await adapter.handleServerMessage(chatId, { type: 'permission_requests_snapshot', toolRequestIds: ['approval'], turnActive: true })
      const binding = adapter.sessionStore.get(chatId)?.sessionId
      await send(platform, '1')
      expect(adapter.sessionStore.get(chatId)?.sessionId).toBe(binding)
      expect(adapter.getRuntimeState(chatId).pendingPermissionCount).toBe(0)
      await adapter.handleServerMessage(chatId, { type: 'permission_requests_snapshot', toolRequestIds: ['desktop-approval'], turnActive: true })
      await adapter.handleServerMessage(chatId, { type: 'permission_resolved', permissionType: 'tool', requestId: 'desktop-approval' })
      await adapter.handleServerMessage(chatId, { type: 'status', state: 'idle' })
      expect(adapter.getRuntimeState(chatId).pendingPermissionCount).toBe(0)
      await send(platform, '/resume 1')
      expect(adapter.sessionStore.get(chatId)?.sessionId).toBe('history-active')
      adapter.clearTransientChatState(chatId)
    })

    it('keeps help, status and stop commands usable while history selection is open', async () => {
      const adapter = adapterFor(platform)
      const chatId = chatFor(platform)
      await send(platform, '/sessions')
      await send(platform, '/help')
      expect(notices.at(-1)).toContain('/sessions')
      await send(platform, '/status')
      expect(notices.at(-1)).toContain('Fixture')
      const stopSpy = spyOn(adapter.bridge, 'sendStopGeneration')
      try {
        await send(platform, '/stop')
        expect(stopSpy).toHaveBeenCalledWith(chatId)
      } finally { stopSpy.mockRestore() }
      await send(platform, '/cancel')
      expect(await adapter.sessionSelectionController.handleInput(chatId, '1')).toBe(false)
    })

    it('sets busy synchronously on successful normal and clear sends, while failed sends stay idle', async () => {
      const adapter = adapterFor(platform)
      const chatId = chatFor(platform)
      for (const command of ['continue the previous task', '/clear']) {
        adapter.clearTransientChatState(chatId)
        await send(platform, command)
        expect(adapter.getRuntimeState(chatId).state).toBe('thinking')
        adapter.clearTransientChatState(chatId)
        const sendSpy = spyOn(adapter.bridge, 'sendUserMessage').mockReturnValue(false)
        try {
          await send(platform, command)
          expect(adapter.getRuntimeState(chatId).state).toBe('idle')
        } finally { sendSpy.mockRestore() }
      }
    })
  })
}


it('serializes Feishu project cards after an in-flight history selection', async () => {
  const chatId = chatFor('feishu')
  feishu.clearTransientChatState(chatId)
  await send('feishu', '/sessions')
  let release!: () => void
  const started = new Promise<void>((resolve) => { preflightStarted = resolve })
  preflightGate = new Promise<void>((resolve) => { release = resolve })
  try {
    const resume = send('feishu', '/resume 1')
    await started
    const card = feishu.handleCardAction({ context: { open_chat_id: chatId }, action: { value: { action: 'pick_project', realPath: temporaryRoot, projectName: 'Fixture' } } })
    release()
    await Promise.all([resume, card])
    expect(feishu.sessionStore.get(chatId)?.sessionId).toStartWith('new-')
    expect(await feishu.sessionSelectionController.handleInput(chatId, '1')).toBe(false)
  } finally {
    release()
    preflightGate = undefined
    preflightStarted = undefined
  }
})
