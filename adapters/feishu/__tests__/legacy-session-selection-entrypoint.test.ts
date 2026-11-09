import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as Lark from '@larksuiteoapi/node-sdk'
import { ProxyAgent } from 'proxy-agent'
import { enqueue } from '../../common/chat-queue.js'
import { StreamingCard } from '../streaming-card.js'
import { FeishuMediaService } from '../media.js'
import { WechatMediaService, WechatMediaDownloadError } from '../../wechat/media.js'
import { DingTalkMediaService } from '../../dingtalk/media.js'
import { DingTalkAiCardService } from '../../dingtalk/ai-card.js'
import { WhatsAppMediaService } from '../../whatsapp/media.js'
import { currentInboundPowerLease } from '../../common/inbound-power-activity.js'
import { MessageBuffer } from '../../common/message-buffer.js'
import { AdapterHttpClient } from '../../common/http-client.js'
import * as wechatMediaUpload from '../../wechat/media-upload.js'
import * as wechatSpeech from '../../wechat/speech-synthesis.js'
import * as wechatVideo from '../../wechat/video-processing.js'
import type { AttachmentRef } from '../../common/ws-bridge.js'

type Platform = 'feishu' | 'dingtalk' | 'wechat' | 'whatsapp'
const platforms: Platform[] = ['feishu', 'dingtalk', 'wechat', 'whatsapp']
const chatFor = (platform: Platform) => platform === 'dingtalk' ? 'dingtalk:dm:fixture-user' : `${platform}-chat`
let feishu: typeof import('../index.js')
let feishuStartupWsClient: Lark.WSClient
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
let permissionDeliveryGate: Promise<void> | undefined
let permissionDeliveryStarted: (() => void) | undefined
let permissionDeliveryAttempts = 0
let failPermissionDelivery = false
let dingtalkTextFailures = 0
const notices: string[] = []
const sentPrompts: Array<{ sessionId: string; content: string; attachments?: AttachmentRef[] }> = []
const transcribedAudio: Buffer[] = []
let dingtalkDelivery: {
  cardFailure: 'create' | 'finish' | null
  failFirstMarkdown: boolean
  markdownAttempts: number
  delivered: string[]
  finishedCards: string[]
} | undefined
const activeLeases = new Set<string>()
const acceptedLeases: string[] = []
const attachmentLeases: Array<{ platform: Platform; protected: boolean }> = []
const spies: Array<{ mockRestore(): void }> = []
const originalFetch = globalThis.fetch
const environmentKeys = [
  'HOME', 'CLAUDE_CONFIG_DIR', 'ADAPTER_SERVER_URL', 'ADAPTER_ALLOWED_PROJECT_ROOTS',
  'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET',
  'WECHAT_ACCOUNT_ID', 'WECHAT_BOT_TOKEN', 'WECHAT_BASE_URL', 'WHATSAPP_AUTH_DIR',
  'CC_HAHA_LOCAL_ACCESS_TOKEN',
]
const savedEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]))

async function waitForPermissionDelivery() {
  if (permissionDeliveryGate) {
    permissionDeliveryAttempts++
    permissionDeliveryStarted?.()
    await permissionDeliveryGate
  }
  if (failPermissionDelivery) throw new Error('Fixture permission delivery failed')
}

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
      if (url.pathname === '/api/sessions/power-activity-lease') {
        const { leaseId, active } = await request.json() as { leaseId: string; active: boolean }
        if (active) activeLeases.add(leaseId)
        else activeLeases.delete(leaseId)
        return Response.json({ ok: true })
      }
      if (url.pathname === '/api/voice/transcribe') {
        expect(request.headers.get('content-type')).toBe('audio/wav')
        transcribedAudio.push(Buffer.from(await request.arrayBuffer()))
        return Response.json({ text: 'fixture video audio transcript' })
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
      if (url.pathname === '/dingtalk' && dingtalkDelivery) {
        dingtalkDelivery.markdownAttempts++
        if (dingtalkDelivery.failFirstMarkdown && dingtalkDelivery.markdownAttempts === 1) {
          return new Response('webhook unavailable', { status: 503 })
        }
        const body = await request.json() as { markdown: { text: string } }
        dingtalkDelivery.delivered.push(body.markdown.text)
        return Response.json({ errcode: 0 })
      }
      if (url.pathname === '/dingtalk' || url.pathname === '/ilink/bot/sendmessage') {
        if (url.pathname === '/dingtalk' && dingtalkTextFailures > 0) {
          dingtalkTextFailures--
          return Response.json({ errcode: 503 }, { status: 503 })
        }
        try { await waitForPermissionDelivery() } catch {
          return Response.json({ errcode: 503, ret: 503 }, { status: 503 })
        }
        notices.push(await request.text())
        return Response.json(url.pathname === '/dingtalk' ? { errcode: 0 } : { ret: 0 })
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
        if (message.type === 'user_message') {
          sentPrompts.push({ sessionId: socket.data.sessionId, content: message.content, attachments: message.attachments })
          if (typeof message.powerActivityLeaseId === 'string' && activeLeases.delete(message.powerActivityLeaseId)) {
            acceptedLeases.push(message.powerActivityLeaseId)
          }
        }
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
    if (dingtalkDelivery && url.origin === 'https://api.dingtalk.com' && url.pathname.startsWith('/v1.0/card/')) {
      if (url.pathname === '/v1.0/card/instances' && init?.method === 'POST' && dingtalkDelivery.cardFailure === 'create') {
        return new Response('card unavailable', { status: 503 })
      }
      if (url.pathname === '/v1.0/card/streaming') {
        if (dingtalkDelivery.cardFailure === 'finish') return new Response('stream unavailable', { status: 503 })
        const body = JSON.parse(String(init?.body))
        if (body.isFinalize) dingtalkDelivery.finishedCards.push(body.content)
      }
      return Response.json({})
    }
    throw new Error(`External network is forbidden in this fixture: ${url.origin}${url.pathname}`)
  }) as typeof fetch
  // Exercise the sidecar's actual startup branch, with only the external SDK
  // boundary replaced. The later test checks both clients' transport wiring.
  let started!: () => void
  const startup = new Promise<void>(resolve => { started = resolve })
  const botInfo = spyOn(Lark.Client.prototype, 'request').mockImplementation(async () => ({
    code: 0, bot: { open_id: 'fixture-bot' },
  }))
  const wsStart = spyOn(Lark.WSClient.prototype, 'start').mockImplementation(async function () {
    feishuStartupWsClient = this
    started()
  })
  const originalArgv = [...process.argv]
  const shutdownSignals = ['SIGINT', 'SIGTERM'] as const
  const signalListeners = new Map(shutdownSignals.map(signal => [signal, new Set(process.listeners(signal))]))
  process.argv.push('--feishu')
  try {
    feishu = await import('../index.js')
    await startup
  } finally {
    process.argv.splice(0, process.argv.length, ...originalArgv)
    botInfo.mockRestore()
    wsStart.mockRestore()
    for (const signal of shutdownSignals) {
      for (const listener of process.listeners(signal)) {
        if (!signalListeners.get(signal)!.has(listener)) process.removeListener(signal, listener)
      }
    }
  }
  dingtalk = await import('../../dingtalk/index.js')
  wechat = await import('../../wechat/index.js')
  whatsapp = await import('../../whatsapp/index.js')
  spies.push(spyOn(feishu.larkClient.im.message, 'create').mockImplementation(async (request: any) => {
    await waitForPermissionDelivery()
    notices.push(String(request.data.content))
    return { code: 0, data: { message_id: `fixture-${++sequence}` } }
  }))
  const attachment = { kind: 'image' as const, name: 'fixture.png', path: path.join(temporaryRoot, 'fixture.png'), buffer: Buffer.from('fixture'), size: 7, mimeType: 'image/png' }
  const protectedAttachment = async (platform: Platform) => {
    const lease = currentInboundPowerLease(platform === 'whatsapp' ? 'whatsapp-chat@s.whatsapp.net' : chatFor(platform))
    attachmentLeases.push({ platform, protected: !!lease && activeLeases.has(lease.id) })
    return attachment
  }
  spies.push(spyOn(FeishuMediaService.prototype, 'downloadResource').mockImplementation(() => protectedAttachment('feishu')))
  spies.push(spyOn(WechatMediaService.prototype, 'downloadCandidate').mockImplementation(() => protectedAttachment('wechat')))
  spies.push(spyOn(DingTalkMediaService.prototype, 'downloadCandidate').mockImplementation(() => protectedAttachment('dingtalk')))
  spies.push(spyOn(WhatsAppMediaService.prototype, 'downloadMessageMedia').mockImplementation(() => protectedAttachment('whatsapp')))
  spies.push(spyOn(StreamingCard.prototype, 'ensureCreated').mockImplementation(async () => {}))
  spies.push(spyOn(StreamingCard.prototype, 'abort').mockImplementation(async () => {}))
  spies.push(spyOn(StreamingCard.prototype, 'finalize').mockImplementation(async () => {}))
  whatsapp.useWhatsAppSocket({
    sendMessage: async (_chatId: string, message: { text: string }) => { notices.push(message.text) },
    readMessages: async () => {}, sendPresenceUpdate: async () => {},
  } as any)
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

for (const platform of ['feishu', 'wechat', 'dingtalk'] as const) {
  it(`${platform} retries failed permission delivery after a snapshot, then suppresses replay`, async () => {
    const adapter = adapterFor(platform)
    const chatId = chatFor(platform)
    await send(platform, '/status')
    adapter.bridge.resetSession(chatId)
    adapter.clearTransientChatState(chatId)
    const request = { type: 'permission_request', requestId: `failed-${platform}`, toolName: 'Bash', input: {} }
    failPermissionDelivery = true
    try {
      await expect(adapter.handleServerMessage(chatId, request)).rejects.toThrow()
    } finally { failPermissionDelivery = false }
    expect(adapter.getRuntimeState(chatId).pendingPermissionCount).toBe(1)
    await adapter.handleServerMessage(chatId, { type: 'permission_requests_snapshot', toolRequestIds: [request.requestId], turnActive: true })
    const before = notices.length
    await adapter.handleServerMessage(chatId, request)
    await adapter.handleServerMessage(chatId, request)
    expect(notices).toHaveLength(before + 1)
    expect(adapter.getRuntimeState(chatId).pendingPermissionCount).toBe(1)
    adapter.clearTransientChatState(chatId)
  })

  it(`${platform} claims each permission before asynchronous delivery and ignores replay`, async () => {
    const adapter = adapterFor(platform)
    const chatId = chatFor(platform)
    await send(platform, '/status')
    adapter.bridge.resetSession(chatId)
    adapter.clearTransientChatState(chatId)
    const request = { type: 'permission_request', requestId: `dedup-${platform}`, toolName: 'Bash', input: { command: 'echo fixture' } }
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { started = resolve })
    permissionDeliveryGate = gate
    permissionDeliveryStarted = started
    permissionDeliveryAttempts = 0
    const before = notices.length
    const first = adapter.handleServerMessage(chatId, request)
    const duplicate = adapter.handleServerMessage(chatId, request)
    try {
      await entered
      expect(adapter.getRuntimeState(chatId).pendingPermissionCount).toBe(1)
      await adapter.handleServerMessage(chatId, { type: 'permission_resolved', permissionType: 'tool', requestId: request.requestId })
      expect(adapter.getRuntimeState(chatId).pendingPermissionCount).toBe(0)
    } finally {
      release()
      await Promise.all([first, duplicate])
      permissionDeliveryGate = undefined
      permissionDeliveryStarted = undefined
    }
    expect(permissionDeliveryAttempts).toBe(1)
    expect(notices).toHaveLength(before + 1)
    expect(adapter.getRuntimeState(chatId).pendingPermissionCount).toBe(0)
    expect(adapter.getRuntimeState(chatId).state).toBe('thinking')

    const next = { ...request, requestId: `${request.requestId}-next` }
    await adapter.handleServerMessage(chatId, next)
    const sent = notices.length
    await adapter.handleServerMessage(chatId, next)
    expect(notices).toHaveLength(sent)
    expect(adapter.getRuntimeState(chatId).pendingPermissionCount).toBe(1)
    adapter.clearTransientChatState(chatId)
  })
}

it('DingTalk registers permission before waiting for stream completion and preserves resolution', async () => {
  const chatId = chatFor('dingtalk')
  await send('dingtalk', '/status')
  dingtalk.bridge.resetSession(chatId)
  dingtalk.clearTransientChatState(chatId)
  await dingtalk.handleServerMessage(chatId, { type: 'content_delta', text: 'before approval' })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const complete = spyOn(MessageBuffer.prototype, 'complete').mockImplementation(() => gate)
  const request = { type: 'permission_request', requestId: 'during-dingtalk-finalize', toolName: 'Bash', input: {} }
  const first = dingtalk.handleServerMessage(chatId, request)
  const duplicate = dingtalk.handleServerMessage(chatId, request)
  try {
    expect(complete).toHaveBeenCalledTimes(1)
    expect(dingtalk.getRuntimeState(chatId).pendingPermissionCount).toBe(1)
    await dingtalk.handleServerMessage(chatId, { type: 'permission_resolved', permissionType: 'tool', requestId: request.requestId })
  } finally {
    release()
    await Promise.all([first, duplicate])
    complete.mockRestore()
  }
  expect(dingtalk.getRuntimeState(chatId).pendingPermissionCount).toBe(0)
  expect(dingtalk.getRuntimeState(chatId).state).toBe('thinking')
  // If completion resurrected the pending set, an older snapshot would expose it.
  await dingtalk.handleServerMessage(chatId, { type: 'permission_requests_snapshot', turnActive: true })
  expect(dingtalk.getRuntimeState(chatId).pendingPermissionCount).toBe(0)
  dingtalk.clearTransientChatState(chatId)
})

it('DingTalk retries terminal text automatically and keeps exhausted replies separate from the next turn', async () => {
  const chatId = chatFor('dingtalk')
  await send('dingtalk', '/help')
  dingtalk.clearTransientChatState(chatId)
  const card = spyOn(DingTalkAiCardService.prototype, 'createForTarget').mockResolvedValue(null)
  const before = notices.length
  try {
    dingtalkTextFailures = 1
    await dingtalk.handleServerMessage(chatId, { type: 'content_delta', text: 'transient answer' })
    await dingtalk.handleServerMessage(chatId, { type: 'message_complete' })
    expect(notices.slice(before).filter(text => text.includes('transient answer'))).toHaveLength(1)

    dingtalkTextFailures = 100
    await dingtalk.handleServerMessage(chatId, { type: 'content_delta', text: 'previous turn answer' })
    await expect(dingtalk.handleServerMessage(chatId, { type: 'message_complete' })).rejects.toThrow('DingTalk text delivery failed')
    dingtalk.sessionStore.set(chatId, 'history-active', temporaryRoot)
    // Failed delivery of the old reply cannot consume a new inbound message.
    await dingtalk.routeUserMessage(chatId, 'next prompt must survive')
    const deadline = Date.now() + 2000
    while (!sentPrompts.some(prompt => prompt.content === 'next prompt must survive') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(sentPrompts.some(prompt => prompt.content === 'next prompt must survive')).toBe(true)
    await dingtalk.handleServerMessage(chatId, { type: 'content_delta', text: 'next turn answer' })
    await expect(dingtalk.handleServerMessage(chatId, { type: 'message_complete' })).rejects.toThrow('DingTalk text delivery failed')
    // A reset must not silently discard the failed terminal reply.
    dingtalk.clearTransientChatState(chatId)
    dingtalkTextFailures = 0
    await dingtalk.routeUserMessage(chatId, '/help')
    const finalTexts = notices.slice(before).flatMap(text => {
      try { return [JSON.parse(text).markdown?.text].filter(Boolean) } catch { return [] }
    })
    expect(finalTexts.filter(text => text === 'previous turn answer')).toHaveLength(1)
    expect(finalTexts.filter(text => text === 'next turn answer')).toHaveLength(1)
    expect(finalTexts.some(text => text.includes('previous turn answer') && text.includes('next turn answer'))).toBe(false)
  } finally {
    dingtalkTextFailures = 0
    card.mockRestore()
    dingtalk.clearTransientChatState(chatId)
  }
})

it('uses the CONNECT-capable HTTP transport for both clients created by Feishu startup', async () => {
  const restHttp = (feishu.larkClient as unknown as { httpInstance: Lark.HttpInstance }).httpInstance
  const wsHttp = (feishuStartupWsClient as unknown as { httpInstance: Lark.HttpInstance }).httpInstance
  const request = spyOn(Lark.defaultHttpInstance, 'request').mockResolvedValue({ code: 0 })
  try {
    for (const transport of [restHttp, wsHttp]) {
      expect(transport).not.toBe(Lark.defaultHttpInstance)
      await transport.request({ method: 'POST', url: 'https://fixture.invalid/startup', data: { fixture: true } })
    }
    expect(request).toHaveBeenCalledTimes(2)
    for (const [options] of request.mock.calls) {
      expect(options).toMatchObject({
        proxy: false,
        httpAgent: expect.any(ProxyAgent),
        httpsAgent: expect.any(ProxyAgent),
        method: 'POST', url: 'https://fixture.invalid/startup', data: { fixture: true },
      })
    }
  } finally {
    request.mockRestore()
  }
})

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
    it('transfers an acquired inbound lease with the accepted WebSocket message', async () => {
      const adapter = adapterFor(platform)
      const chatId = chatFor(platform)
      adapter.clearTransientChatState(chatId)
      adapter.sessionSelectionController.clear(chatId)
      const before = acceptedLeases.length
      await send(platform, `leased inbound ${platform}`)
      const deadline = Date.now() + 1000
      while (acceptedLeases.length === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1))
      expect(acceptedLeases.length).toBe(before + 1)
    })

    it.each(['/status', '/stop', '/clear'])('preserves the binding when %s cannot reconnect and retries the command', async (command) => {
      const adapter = adapterFor(platform)
      const chatId = chatFor(platform)
      const originalProject = path.join(temporaryRoot, `${platform}-command-project`)
      fs.mkdirSync(originalProject, { recursive: true })
      adapter.bridge.resetSession(chatId)
      adapter.clearTransientChatState(chatId)
      adapter.sessionStore.set(chatId, 'old-cmd', originalProject)
      const originalBinding = adapter.sessionStore.get(chatId)
      const creationsBefore = newSessionCount
      const noticesBefore = notices.length
      const failedOpen = spyOn(adapter.bridge, 'waitForOpen').mockImplementationOnce(async () => {
        adapter.bridge.resetSession(chatId)
        return false
      })
      const sendSpy = spyOn(adapter.bridge, 'sendUserMessage')
      const stopSpy = spyOn(adapter.bridge, 'sendStopGeneration')
      try {
        await send(platform, command)

        expect(adapter.sessionStore.get(chatId)).toEqual(originalBinding)
        expect(newSessionCount).toBe(creationsBefore)
        expect(sendSpy).not.toHaveBeenCalled()
        expect(stopSpy).not.toHaveBeenCalled()
        expect(notices).toHaveLength(noticesBefore + 1)
        expect(notices.at(-1)).toContain('已保留会话和工作目录')
        expect(notices.at(-1)).toContain('重试')
        expect(notices.at(-1)).not.toContain('当前没有活动会话')

        await send(platform, command)

        expect(adapter.bridge.getSessionId(chatId)).toBe('old-cmd')
        expect(adapter.sessionStore.get(chatId)).toEqual(originalBinding)
        expect(newSessionCount).toBe(creationsBefore)
        if (command === '/clear') {
          expect(sendSpy).toHaveBeenCalledTimes(1)
          expect(sendSpy).toHaveBeenCalledWith(chatId, '/clear')
          expect(stopSpy).not.toHaveBeenCalled()
        } else if (command === '/stop') {
          expect(stopSpy).toHaveBeenCalledTimes(1)
          expect(stopSpy).toHaveBeenCalledWith(chatId)
          expect(sendSpy).not.toHaveBeenCalled()
        } else {
          expect(notices.at(-1)).toContain('old-cmd')
          expect(sendSpy).not.toHaveBeenCalled()
          expect(stopSpy).not.toHaveBeenCalled()
        }
      } finally {
        failedOpen.mockRestore()
        sendSpy.mockRestore()
        stopSpy.mockRestore()
        adapter.bridge.resetSession(chatId)
        adapter.clearTransientChatState(chatId)
      }
    })

    it('keeps the original session and project after reconnect timeout and resumes it on retry', async () => {
      const adapter = adapterFor(platform)
      const chatId = chatFor(platform)
      const originalProject = path.join(temporaryRoot, `${platform}-original`)
      fs.mkdirSync(originalProject)
      adapter.bridge.resetSession(chatId)
      adapter.clearTransientChatState(chatId)
      adapter.sessionStore.set(chatId, 'original-session', originalProject)
      const originalBinding = adapter.sessionStore.get(chatId)
      const creationsBefore = newSessionCount
      const failedPrompt = `${platform}: Continue after reconnect`
      const failedOpen = spyOn(adapter.bridge, 'waitForOpen').mockImplementationOnce(async () => {
        adapter.bridge.resetSession(chatId)
        return false
      })
      const sendSpy = spyOn(adapter.bridge, 'sendUserMessage')
      try {
        await send(platform, failedPrompt)
        expect(adapter.sessionStore.get(chatId)).toEqual(originalBinding)
        expect(newSessionCount).toBe(creationsBefore)
        expect(sentPrompts.some((prompt) => prompt.content === failedPrompt)).toBe(false)
        expect(sendSpy).not.toHaveBeenCalled()
        expect(notices.at(-1)).toContain('已保留会话和工作目录')
        expect(notices.at(-1)).not.toContain('/new')

        await send(platform, 'Retry the original conversation')
        expect(adapter.bridge.getSessionId(chatId)).toBe('original-session')
        expect(adapter.sessionStore.get(chatId)).toEqual(originalBinding)
        expect(newSessionCount).toBe(creationsBefore)
        expect(sendSpy).toHaveBeenCalledWith(chatId, 'Retry the original conversation', undefined)
      } finally {
        failedOpen.mockRestore()
        sendSpy.mockRestore()
        adapter.bridge.resetSession(chatId)
        adapter.clearTransientChatState(chatId)
      }
    })

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
      // Binding commit/socket open can precede application of the server's
      // initial snapshot. Assert its state after that asynchronous boundary.
      const deadline = Date.now() + 1000
      while (adapter.getRuntimeState(chatId).state !== 'thinking' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1))
      }
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
        await feishu.handleCardAction({ operator: { open_id: 'fixture-user' }, context: { open_chat_id: chatId }, action: { value: { action: 'pick_project', realPath: temporaryRoot, projectName: 'Fixture' } } })
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

it('holds a lease before each legacy media download starts and refuses unpaired downloads', async () => {
  attachmentLeases.length = 0
  await send('feishu', 'protected media', { attachment: true })
  await send('wechat', 'protected media', { attachment: true })
  await dingtalk.handleRobotMessage({
    conversationType: '1', senderStaffId: 'fixture-user', msgtype: 'picture',
    content: { pictureUrl: 'https://fixture.invalid/image.png' }, sessionWebhook: `${httpOrigin}/dingtalk`,
  })
  // Use the real WhatsApp ingress; only its external media transport is mocked.
  const configFile = path.join(temporaryRoot, '.claude', 'adapters.json')
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  config.whatsapp.allowedUsers.push('whatsapp-chat@s.whatsapp.net')
  fs.writeFileSync(configFile, JSON.stringify(config))
  await whatsapp.handleIncomingMessage({
    key: { remoteJid: 'whatsapp-chat@s.whatsapp.net', id: `media-${++sequence}`, fromMe: false },
    message: { imageMessage: { caption: 'protected media' } },
  })
  expect(attachmentLeases).toEqual((['feishu', 'wechat', 'dingtalk', 'whatsapp'] as const).map(platform => ({ platform, protected: true })))
  const before = attachmentLeases.length
  await send('feishu', 'outsider media', { unauthorized: true, attachment: true })
  await send('wechat', 'outsider media', { unauthorized: true, attachment: true })
  await dingtalk.handleRobotMessage({
    conversationType: '1', senderStaffId: 'outsider', msgtype: 'picture',
    content: { pictureUrl: 'https://fixture.invalid/image.png' }, sessionWebhook: `${httpOrigin}/dingtalk`,
  })
  await whatsapp.handleIncomingMessage({
    key: { remoteJid: 'outsider@s.whatsapp.net', id: `media-${++sequence}`, fromMe: false },
    message: { imageMessage: { caption: 'outsider media' } },
  })
  expect(attachmentLeases).toHaveLength(before)
})


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
    const card = feishu.handleCardAction({ operator: { open_id: 'fixture-user' }, context: { open_chat_id: chatId }, action: { value: { action: 'pick_project', realPath: temporaryRoot, projectName: 'Fixture' } } })
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

async function prepareWechatMediaSession() {
  const chatId = chatFor('wechat')
  wechat.clearTransientChatState(chatId)
  wechat.sessionSelectionController.clear(chatId)
  wechat.bridge.resetSession(chatId)
  wechat.sessionStore.set(chatId, `wechat-media-session-${++sequence}`, temporaryRoot)
  await send('wechat', '/status')
  return chatId
}

async function waitUntilMedia(check: () => boolean) {
  const deadline = Date.now() + 1500
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2))
  expect(check()).toBe(true)
}

describe('WeChat compact permission prompts', () => {
  it('hides repeated ID commands for one request while preserving all three numeric decisions', async () => {
    const chatId = await prepareWechatMediaSession()
    const approval = spyOn(wechat.bridge, 'sendPermissionResponse').mockReturnValue(true)
    try {
      for (const [digit, allowed, rule] of [['1', true, undefined], ['2', true, 'always'], ['3', false, undefined]] as const) {
        const requestId = `compact-${digit}`
        await wechat.handleServerMessage(chatId, { type: 'permission_request', requestId, toolName: 'Write', input: { file_path: 'fixture.txt' } })
        expect(notices.at(-1)).toContain('回复 1 允许一次，2 永久允许，3 拒绝。')
        expect(notices.at(-1)).not.toContain('/allow')
        expect(notices.at(-1)).not.toContain('/always')
        expect(notices.at(-1)).not.toContain('/deny')
        await send('wechat', digit)
        expect(approval).toHaveBeenLastCalledWith(chatId, requestId, allowed, rule)
        expect(wechat.getRuntimeState(chatId).pendingPermissionCount).toBe(0)
      }
    } finally { approval.mockRestore(); wechat.clearTransientChatState(chatId) }
  })

  it('keeps explicit commands for concurrent requests and refuses ambiguous numbers', async () => {
    const chatId = await prepareWechatMediaSession()
    const approval = spyOn(wechat.bridge, 'sendPermissionResponse').mockReturnValue(true)
    const model = spyOn(wechat.bridge, 'sendUserMessage')
    try {
      await wechat.handleServerMessage(chatId, { type: 'permission_requests_snapshot', toolRequestIds: ['first', 'second'], turnActive: true })
      await wechat.handleServerMessage(chatId, { type: 'permission_request', requestId: 'second', toolName: 'Write', input: {} })
      expect(notices.at(-1)).toContain('/allow second')
      expect(notices.at(-1)).toContain('/always second')
      expect(notices.at(-1)).toContain('/deny second')
      expect(notices.at(-1)).not.toContain('回复 1')
      await send('wechat', '1')
      expect(notices.at(-1)).toContain('无法确定这个数字对应哪一个')
      expect(approval).not.toHaveBeenCalled()
      expect(model).not.toHaveBeenCalled()
      await send('wechat', '/deny second')
      expect(approval).toHaveBeenLastCalledWith(chatId, 'second', false, undefined)
      await send('wechat', '1')
      expect(approval).toHaveBeenLastCalledWith(chatId, 'first', true, undefined)
    } finally { approval.mockRestore(); model.mockRestore(); wechat.clearTransientChatState(chatId) }
  })
})

describe('WeChat actual module multimedia integration', () => {
  it.each(['command', 'emergency'])('drops buffered and late turn output after %s stop, then resumes on the next model request', async stopPath => {
    const chatId = await prepareWechatMediaSession()
    const audioPath = path.join(temporaryRoot, 'stop-reply.wav')
    fs.writeFileSync(audioPath, Buffer.from('RIFF0000WAVEfixture'))
    let cleaned = false
    const synthesis = spyOn(wechatSpeech, 'synthesizeWechatSpeech').mockResolvedValue({
      path: audioPath, fileName: 'stop-reply.wav', mimeType: 'audio/wav', cleanup: async () => { cleaned = true },
    })
    const upload = spyOn(wechatMediaUpload, 'sendWechatMedia').mockResolvedValue()
    try {
      await send('wechat', '/voice on')
      await wechat.handleServerMessage(chatId, { type: 'content_delta', text: 'cancelled buffered fixture' })
      if (stopPath === 'command') await send('wechat', '/stop')
      else wechat.cancelWechatTurn(chatId)
      const model = spyOn(wechat.bridge, 'sendUserMessage')
      try {
        await send('wechat', 'too early while prior turn is stopping')
        expect(model).not.toHaveBeenCalled()
        expect(notices.at(-1)).toContain('上一轮仍在停止中')
      } finally { model.mockRestore() }
      await wechat.handleServerMessage(chatId, { type: 'content_delta', text: 'cancelled late fixture' })
      await wechat.handleServerMessage(chatId, { type: 'message_complete' })
      expect(notices.some(notice => notice.includes('cancelled buffered fixture'))).toBe(false)
      expect(notices.some(notice => notice.includes('cancelled late fixture'))).toBe(false)
      expect(synthesis).not.toHaveBeenCalled()
      expect(upload).not.toHaveBeenCalled()
      await send('wechat', 'resume after cancelled output')
      await wechat.handleServerMessage(chatId, { type: 'content_delta', text: 'fresh resumed fixture' })
      await wechat.handleServerMessage(chatId, { type: 'message_complete' })
      await waitUntilMedia(() => cleaned)
      expect(notices.some(notice => notice.includes('fresh resumed fixture'))).toBe(true)
      expect(synthesis).toHaveBeenCalledTimes(1)
      expect(synthesis.mock.calls[0][0]).toBe('fresh resumed fixture')
    } finally {
      wechat.clearTransientChatState(chatId)
      synthesis.mockRestore()
      upload.mockRestore()
    }
  })

  it('fences remaining queued text chunks when /stop occurs during the first network send', async () => {
    const chatId = await prepareWechatMediaSession()
    let release!: () => void
    permissionDeliveryGate = new Promise<void>(resolve => { release = resolve })
    permissionDeliveryAttempts = 0
    try {
      await wechat.handleServerMessage(chatId, { type: 'content_delta', text: `${'x'.repeat(3500)}cancelled queued text chunk` })
      await waitUntilMedia(() => permissionDeliveryAttempts > 0)
      const stopping = send('wechat', '/stop')
      // The route cancels synchronously before it waits for the existing socket.
      release()
      await stopping
      await wechat.handleServerMessage(chatId, { type: 'message_complete' })
      expect(notices.some(notice => notice.includes('cancelled queued text chunk'))).toBe(false)
    } finally {
      release()
      permissionDeliveryGate = undefined
      permissionDeliveryAttempts = 0
      wechat.clearTransientChatState(chatId)
    }
  })

  it('explains a failed image transfer without starting a model request to find local photos', async () => {
    const chatId = await prepareWechatMediaSession()
    spyOn(WechatMediaService.prototype, 'downloadCandidate').mockImplementationOnce(async () => {
      throw new WechatMediaDownloadError('download', '微信媒体服务返回 HTTP 403')
    })
    const model = spyOn(wechat.bridge, 'sendUserMessage')
    try {
      await wechat.routeUserMessage({ from_user_id: chatId, message_id: ++sequence, item_list: [
        { type: 2, image_item: { media: { encrypt_query_param: 'fixture' } } },
      ] })
      await enqueue(chatId, async () => {})
      expect(notices.at(-1)).toContain('已收到附件消息')
      expect(notices.at(-1)).toContain('HTTP 403')
      expect(notices.at(-1)).toContain('授权搜索电脑图片目录不能解决')
      expect(model).not.toHaveBeenCalled()
    } finally {
      model.mockRestore()
      wechat.clearTransientChatState(chatId)
    }
  })

  it('uploads a completed bracket file reply as a WeChat attachment', async () => {
    const chatId = await prepareWechatMediaSession()
    const filePath = path.join(temporaryRoot, 'wechat extracted audio.mp3')
    const audio = Buffer.from('ID3fixture extracted audio')
    fs.writeFileSync(filePath, audio)
    const upload = spyOn(wechatMediaUpload, 'sendWechatMedia').mockResolvedValue()
    try {
      await wechat.handleServerMessage(chatId, { type: 'content_delta', text: '[fi' })
      await wechat.handleServerMessage(chatId, { type: 'content_delta', text: `le:${filePath}]` })
      expect(upload).not.toHaveBeenCalled()
      await wechat.handleServerMessage(chatId, { type: 'message_complete' })
      await waitUntilMedia(() => upload.mock.calls.length > 0)
      expect(upload).toHaveBeenCalledTimes(1)
      expect(upload.mock.calls[0][0]).toMatchObject({ to: chatId, kind: 'file', fileName: 'wechat extracted audio.mp3', buffer: audio })
    } finally {
      wechat.clearTransientChatState(chatId)
      upload.mockRestore()
    }
  })

  it('advertises media commands and sends a project file without a model request', async () => {
    const chatId = await prepareWechatMediaSession()
    const filePath = path.join(temporaryRoot, 'deliverable.txt')
    fs.writeFileSync(filePath, 'fixture deliverable')
    const model = spyOn(wechat.bridge, 'sendUserMessage')
    const upload = spyOn(wechatMediaUpload, 'sendWechatMedia').mockResolvedValue()
    try {
      await send('wechat', '/help')
      expect(notices.at(-1)).toContain('/send')
      expect(notices.at(-1)).toContain('/voice')
      expect(notices.at(-1)).toContain('/speak')
      await send('wechat', '/send deliverable.txt')
      expect(upload).toHaveBeenCalledTimes(1)
      expect(upload.mock.calls[0][0]).toMatchObject({
        to: chatId, kind: 'file', fileName: 'deliverable.txt', buffer: Buffer.from('fixture deliverable'),
        token: 'fixture-token', baseUrl: httpOrigin,
      })
      expect(model).not.toHaveBeenCalled()
    } finally {
      upload.mockRestore()
      model.mockRestore()
      wechat.clearTransientChatState(chatId)
    }
  })

  it('turns a completed answer into an audio attachment after /voice on', async () => {
    const chatId = await prepareWechatMediaSession()
    // The first /voice command must survive creation of its initial session.
    wechat.bridge.resetSession(chatId)
    wechat.sessionStore.delete(chatId)
    const audioPath = path.join(temporaryRoot, 'reply.wav')
    const audio = Buffer.from('RIFF0000WAVEfixture')
    fs.writeFileSync(audioPath, audio)
    let cleaned = false
    const synthesis = spyOn(wechatSpeech, 'synthesizeWechatSpeech').mockResolvedValue({
      path: audioPath, fileName: 'reply.wav', mimeType: 'audio/wav', cleanup: async () => { cleaned = true },
    })
    const upload = spyOn(wechatMediaUpload, 'sendWechatMedia').mockResolvedValue()
    try {
      await send('wechat', '/voice on')
      expect(wechat.sessionStore.get(chatId)?.sessionId).toStartWith('new-')
      await wechat.handleServerMessage(chatId, { type: 'content_delta', text: '这是完整回答。' })
      await wechat.handleServerMessage(chatId, { type: 'message_complete' })
      await waitUntilMedia(() => cleaned)
      expect(synthesis).toHaveBeenCalledTimes(1)
      expect(synthesis.mock.calls[0][0]).toBe('这是完整回答。')
      expect(upload).toHaveBeenCalledTimes(1)
      expect(upload.mock.calls[0][0]).toMatchObject({ to: chatId, kind: 'file', fileName: 'reply.wav', mimeType: 'audio/wav', buffer: audio })
      expect(notices.some(notice => notice.includes('这是完整回答。'))).toBe(true)
      await send('wechat', '/voice off')
    } finally {
      wechat.clearTransientChatState(chatId)
      synthesis.mockRestore()
      upload.mockRestore()
    }
  })

  it('passes downloaded video frames and audio transcript through the real WebSocket ingress', async () => {
    const chatId = await prepareWechatMediaSession()
    const videoPath = path.join(temporaryRoot, 'input.mp4')
    const framePath = path.join(temporaryRoot, 'frame.jpg')
    const audioPath = path.join(temporaryRoot, 'track.wav')
    const frame = Buffer.from([0xff, 0xd8, 0xff, 1])
    const audio = Buffer.from('RIFF0000WAVEfixture track')
    fs.writeFileSync(framePath, frame)
    fs.writeFileSync(audioPath, audio)
    spyOn(WechatMediaService.prototype, 'downloadCandidate').mockImplementationOnce(async () => ({
      kind: 'file', name: 'input.mp4', path: videoPath, buffer: Buffer.from('video'), size: 5, mimeType: 'video/mp4',
    }))
    let cleaned = false
    const processor = spyOn(wechatVideo, 'processWechatVideo').mockResolvedValue({
      frames: [{ path: framePath, timestampMs: 250 }], audioPath, durationMs: 1000,
      coverageNote: 'fixture coverage: sampled one frame', cleanup: async () => { cleaned = true },
    })
    const before = sentPrompts.length
    const audioBefore = transcribedAudio.length
    try {
      await wechat.routeUserMessage({ from_user_id: chatId, message_id: ++sequence, item_list: [
        { type: 1, text_item: { text: 'explain fixture video' } },
        { type: 5, video_item: { media: { full_url: 'https://fixture.invalid/video' } } },
      ] })
      await enqueue(chatId, async () => {})
      await waitUntilMedia(() => sentPrompts.length > before)
      expect(processor).toHaveBeenCalledTimes(1)
      expect(processor.mock.calls[0][0]).toBe(videoPath)
      expect(cleaned).toBe(true)
      expect(transcribedAudio.slice(audioBefore)).toEqual([audio])
      const delivered = sentPrompts.at(-1)!
      expect(delivered.content).toContain('explain fixture video')
      expect(delivered.content).toContain('fixture coverage: sampled one frame')
      expect(delivered.content).toContain('0.25s')
      expect(delivered.content).toContain('fixture video audio transcript')
      expect(delivered.attachments).toEqual([
        { type: 'file', name: 'input.mp4', path: videoPath, mimeType: 'video/mp4' },
        { type: 'image', name: 'video-250ms.jpg', data: frame.toString('base64'), mimeType: 'image/jpeg' },
      ])
    } finally {
      wechat.clearTransientChatState(chatId)
      processor.mockRestore()
    }
  })

  it('cancels an in-flight video on /stop without forwarding cancelled input to the model', async () => {
    const chatId = await prepareWechatMediaSession()
    spyOn(WechatMediaService.prototype, 'downloadCandidate').mockImplementationOnce(async () => ({
      kind: 'file', name: 'cancel.mp4', path: path.join(temporaryRoot, 'cancel.mp4'), buffer: Buffer.from('video'), size: 5, mimeType: 'video/mp4',
    }))
    let started = false
    let cancelled = false
    const processor = spyOn(wechatVideo, 'processWechatVideo').mockImplementation(async (_filePath, options) => {
      started = true
      return new Promise((_resolve, reject) => {
        const cancel = () => { cancelled = true; reject(new DOMException('Cancelled fixture video', 'AbortError')) }
        options?.signal?.addEventListener('abort', cancel, { once: true })
        if (options?.signal?.aborted) cancel()
      })
    })
    const model = spyOn(wechat.bridge, 'sendUserMessage')
    const stop = spyOn(wechat.bridge, 'sendStopGeneration')
    try {
      await wechat.routeUserMessage({ from_user_id: chatId, message_id: ++sequence, item_list: [
        { type: 1, text_item: { text: 'cancelled video must not be sent' } },
        { type: 5, video_item: { media: { full_url: 'https://fixture.invalid/video' } } },
      ] })
      await waitUntilMedia(() => started)
      await send('wechat', '/stop')
      expect(cancelled).toBe(true)
      expect(stop).toHaveBeenCalledTimes(1)
      expect(model).not.toHaveBeenCalled()
      expect(sentPrompts.some(prompt => prompt.content.includes('cancelled video must not be sent'))).toBe(false)
    } finally {
      wechat.clearTransientChatState(chatId)
      await enqueue(chatId, async () => {})
      processor.mockRestore()
      model.mockRestore()
      stop.mockRestore()
    }
  })

  it('cancels media still queued before /stop and accepts later input', async () => {
    const chatId = await prepareWechatMediaSession()
    fs.writeFileSync(path.join(temporaryRoot, 'queued.txt'), 'queued deliverable')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const blocked = enqueue(chatId, () => gate)
    const upload = spyOn(wechatMediaUpload, 'sendWechatMedia').mockResolvedValue()
    const model = spyOn(wechat.bridge, 'sendUserMessage')
    const attachmentCount = attachmentLeases.length
    try {
      await wechat.routeUserMessage({ from_user_id: chatId, message_id: ++sequence, item_list: [
        { type: 1, text_item: { text: '/send queued.txt' } },
      ] })
      await wechat.routeUserMessage({ from_user_id: chatId, message_id: ++sequence, item_list: [
        { type: 1, text_item: { text: 'cancel this queued video' } },
        { type: 5, video_item: { media: { full_url: 'https://fixture.invalid/queued-video' } } },
      ] })
      await wechat.routeUserMessage({ from_user_id: chatId, message_id: ++sequence, item_list: [
        { type: 1, text_item: { text: '/stop' } },
      ] })
      release()
      await blocked
      await enqueue(chatId, async () => {})
      expect(upload).not.toHaveBeenCalled()
      expect(model).not.toHaveBeenCalled()
      expect(attachmentLeases.length).toBe(attachmentCount)
      await send('wechat', '/send queued.txt')
      expect(upload).toHaveBeenCalledTimes(1)
    } finally {
      release()
      await enqueue(chatId, async () => {})
      upload.mockRestore()
      model.mockRestore()
      wechat.clearTransientChatState(chatId)
    }
  })

  it.each(['file', 'video'])('cancels a %s request awaiting session recovery before /stop', async kind => {
    const chatId = await prepareWechatMediaSession()
    wechat.bridge.resetSession(chatId)
    fs.writeFileSync(path.join(temporaryRoot, 'recovering.txt'), 'recovering deliverable')
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let recovering = false
    const preflight = spyOn(AdapterHttpClient.prototype, 'sessionExists').mockImplementationOnce(async () => {
      recovering = true
      await gate
      return true
    })
    const upload = spyOn(wechatMediaUpload, 'sendWechatMedia').mockResolvedValue()
    const model = spyOn(wechat.bridge, 'sendUserMessage')
    const attachmentCount = attachmentLeases.length
    try {
      await wechat.routeUserMessage({ from_user_id: chatId, message_id: ++sequence, item_list: [
        { type: 1, text_item: { text: kind === 'file' ? '/send recovering.txt' : 'cancel this recovering video' } },
        ...(kind === 'video' ? [{ type: 5, video_item: { media: { full_url: 'https://fixture.invalid/recovering-video' } } }] : []),
      ] })
      await waitUntilMedia(() => recovering)
      await wechat.routeUserMessage({ from_user_id: chatId, message_id: ++sequence, item_list: [
        { type: 1, text_item: { text: '/stop' } },
      ] })
      release()
      await enqueue(chatId, async () => {})
      expect(upload).not.toHaveBeenCalled()
      expect(model).not.toHaveBeenCalled()
      expect(attachmentLeases.length).toBe(attachmentCount)
    } finally {
      release()
      await enqueue(chatId, async () => {})
      preflight.mockRestore()
      upload.mockRestore()
      model.mockRestore()
      wechat.clearTransientChatState(chatId)
      await waitUntilMedia(() => activeLeases.size === 0)
    }
  })
})

describe('DingTalk reply delivery through the adapter entrypoint', () => {
  const chatId = chatFor('dingtalk')

  beforeEach(async () => {
    dingtalk.clearTransientChatState(chatId)
    dingtalk.sessionSelectionController.clear(chatId)
    dingtalkDelivery = { cardFailure: null, failFirstMarkdown: false, markdownAttempts: 0, delivered: [], finishedCards: [] }
    await send('dingtalk', '/help')
    dingtalkDelivery.markdownAttempts = 0
    dingtalkDelivery.delivered.length = 0
  })

  afterEach(() => {
    dingtalk.clearTransientChatState(chatId)
    dingtalk.clearTransientChatState('dingtalk:dm:without-webhook')
    dingtalkDelivery = undefined
  })

  for (const failure of ['create', 'finish'] as const) {
    for (const firstSendFails of [false, true]) {
      it(`${failure} fallback ${firstSendFails ? 'retries a rejected webhook' : 'sends markdown once'}`, async () => {
        dingtalkDelivery!.cardFailure = failure
        dingtalkDelivery!.failFirstMarkdown = firstSendFails
        await dingtalk.handleServerMessage(chatId, { type: 'content_delta', text: 'complete short answer' })
        await dingtalk.handleServerMessage(chatId, { type: 'message_complete' })
        await dingtalk.handleServerMessage(chatId, { type: 'message_complete' })

        expect(dingtalkDelivery!.delivered).toEqual(['complete short answer'])
        expect(dingtalkDelivery!.markdownAttempts).toBe(firstSendFails ? 2 : 1)
      })
    }
  }

  it('finishes a working card without also sending markdown', async () => {
    await dingtalk.handleServerMessage(chatId, { type: 'content_delta', text: 'card answer' })
    await dingtalk.handleServerMessage(chatId, { type: 'message_complete' })

    expect(dingtalkDelivery!.finishedCards).toEqual(['card answer'])
    expect(dingtalkDelivery!.delivered).toEqual([])
    expect(dingtalkDelivery!.markdownAttempts).toBe(0)
  })

  it('reports a missing webhook as a delivery failure', async () => {
    const missingChat = 'dingtalk:dm:without-webhook'
    await dingtalk.handleServerMessage(missingChat, { type: 'content_delta', text: 'undelivered answer' })
    await expect(dingtalk.handleServerMessage(missingChat, { type: 'message_complete' }))
      .rejects.toThrow('Missing sessionWebhook')
    expect(dingtalkDelivery!.delivered).toEqual([])
  })

  it('keeps an unpaired notice without a webhook best effort', async () => {
    const warning = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await dingtalk.handleRobotMessage({
        conversationType: '1', senderStaffId: 'unpaired-without-webhook', msgtype: 'text', text: { content: 'hello' },
      })
      expect(dingtalkDelivery!.markdownAttempts).toBe(0)
      expect(warning.mock.calls.some(([message]) => String(message).includes('Missing sessionWebhook'))).toBe(true)
    } finally {
      warning.mockRestore()
    }
  })

  for (const permissionState of ['unknown', 'disconnected', 'accepted', 'unpaired'] as const) {
    it(`contains a failed ${permissionState} notice`, async () => {
      if (permissionState !== 'unknown' && permissionState !== 'unpaired') {
        await dingtalk.handleServerMessage(chatId, {
          type: 'permission_request', requestId: 'permission-1', toolName: 'Bash', input: { command: 'pwd' },
        })
      }
      dingtalkDelivery!.markdownAttempts = 0
      dingtalkDelivery!.delivered.length = 0
      dingtalkDelivery!.failFirstMarkdown = true
      const response = spyOn(dingtalk.bridge, 'sendPermissionResponse').mockReturnValue(permissionState === 'accepted')
      const warning = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await send('dingtalk', '/allow permission-1', { unauthorized: permissionState === 'unpaired' })
        const deadline = Date.now() + 1000
        while (!warning.mock.calls.some(args => args.join(' ').includes('sendText failed')) && Date.now() < deadline) {
          await Bun.sleep(1)
        }

        expect(dingtalkDelivery!.markdownAttempts).toBe(1)
        expect(dingtalkDelivery!.delivered).toEqual([])
        expect(warning.mock.calls.some(args => args.join(' ').includes('sendText failed'))).toBe(true)
      } finally {
        warning.mockRestore()
        response.mockRestore()
      }
    })
  }
})

  it('preserves a short partial reply when the server connection fails', async () => {
    const chatId = chatFor('wechat')
    wechat.clearTransientChatState(chatId)
    wechat.bridge.resetSession(chatId)
    wechat.sessionStore.set(chatId, `short-reply-${++sequence}`, temporaryRoot)
    await send('wechat', '/status')
    const before = notices.length
    try {
      await wechat.handleServerMessage(chatId, { type: 'content_delta', text: 'Important partial answer' })
      await wechat.handleServerMessage(chatId, { type: 'error', message: 'ADAPTER_CONNECTION_LOST' })
      const textReplies = () => notices.slice(before).map(text => JSON.parse(text).msg?.item_list?.[0]?.text_item?.text)
      expect(textReplies()).toContain('Important partial answer')
      expect(textReplies()).toContain('错误: ADAPTER_CONNECTION_LOST')
      await wechat.handleServerMessage(chatId, { type: 'message_complete' })
      expect(textReplies().filter(text => text === 'Important partial answer')).toHaveLength(1)
    } finally { wechat.clearTransientChatState(chatId) }
  })
