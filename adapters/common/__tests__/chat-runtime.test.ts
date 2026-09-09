/**
 * Shared IM chat runtime — round-trip tests.
 *
 * The runtime is the piece every new platform depends on, so these tests drive
 * the real transitions (an inbound message, a server stream, a permission
 * reply) through fake *transports* rather than asserting hand-written state.
 * Only the WebSocket bridge and the HTTP client are faked: those are the
 * process boundaries, and everything between them is the code under test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ImChatRuntime, type ChatPort, type ResponseStream } from '../chat-runtime.js'
import { loadConfig } from '../config.js'
import { MessageDedup } from '../message-dedup.js'
import { SessionStore } from '../session-store.js'
import type { AdapterHttpClient, SessionListItem } from '../http-client.js'
import type { AttachmentRef, ServerMessage, WsBridge } from '../ws-bridge.js'

const CHAT_ID = 'chat-1'
const USER_ID = 'user-1'

let tmpDir: string
let originalConfigDir: string | undefined

type SentMessage = { content: string; attachments?: unknown[] }

class FakeBridge {
  sessions = new Map<string, string>()
  handlers = new Map<string, (msg: ServerMessage) => void | Promise<void>>()
  sent: SentMessage[] = []
  permissionResponses: Array<{ requestId: string; allowed: boolean; rule?: string }> = []
  stopped: string[] = []
  resets: string[] = []
  sendResult = true

  connectSession(chatId: string, sessionId: string): boolean {
    this.sessions.set(chatId, sessionId)
    return true
  }

  onServerMessage(chatId: string, handler: (msg: ServerMessage) => void | Promise<void>): void {
    this.handlers.set(chatId, handler)
  }

  getSessionId(chatId: string): string | null {
    return this.sessions.get(chatId) ?? null
  }

  hasSession(chatId: string): boolean {
    return this.sessions.has(chatId)
  }

  isSessionOpen(chatId: string, sessionId?: string): boolean {
    const current = this.sessions.get(chatId)
    if (!current) return false
    return sessionId ? current === sessionId : true
  }

  resetSession(chatId: string): void {
    this.resets.push(chatId)
    this.sessions.delete(chatId)
    this.handlers.delete(chatId)
  }

  waitForOpen(): Promise<boolean> {
    return Promise.resolve(true)
  }

  sendUserMessage(_chatId: string, content: string, attachments?: unknown[]): boolean {
    if (!this.sendResult) return false
    this.sent.push({ content, attachments })
    return true
  }

  sendPermissionResponse(_chatId: string, requestId: string, allowed: boolean, rule?: string): boolean {
    this.permissionResponses.push({ requestId, allowed, rule })
    return true
  }

  sendStopGeneration(chatId: string): boolean {
    this.stopped.push(chatId)
    return true
  }
}

class FakeHttpClient {
  sessions: SessionListItem[] = []
  createdSessions: string[] = []
  existingSessions = new Set<string>()
  projects: Array<{ projectName: string; realPath: string; branch?: string }> = []
  nextSessionId = 'session-1'

  async createSession(workDir: string): Promise<string> {
    this.createdSessions.push(workDir)
    const id = `${this.nextSessionId}-${this.createdSessions.length}`
    this.existingSessions.add(id)
    return id
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    return this.existingSessions.has(sessionId)
  }

  async listRecentProjects() {
    return this.projects
  }

  async listSessions() {
    return { sessions: this.sessions, total: this.sessions.length }
  }

  async matchProject(query: string) {
    const project = this.projects.find((item) => item.projectName === query)
    return project ? { project } : {}
  }

  async getGitInfo() {
    return { repoName: 'demo', workDir: '/tmp/demo', branch: 'main' }
  }

  async getTasksForSession() {
    return []
  }
}

class RecordingResponse implements ResponseStream {
  appended: string[] = []
  finished = 0

  async append(delta: string): Promise<void> {
    this.appended.push(delta)
  }

  async finish(): Promise<void> {
    this.finished += 1
  }
}

function createPort() {
  const notices: string[] = []
  const responses: RecordingResponse[] = []
  const busy: boolean[] = []
  const images: Array<{ mime: string; alt?: string }> = []
  const port: ChatPort = {
    platform: 'wecom',
    logPrefix: '[Test]',
    async sendNotice(_chatId, text) {
      notices.push(text)
    },
    createResponse() {
      const response = new RecordingResponse()
      responses.push(response)
      return response
    },
    async sendImage(_chatId, image) {
      images.push({ mime: image.mime, alt: image.alt })
    },
    setBusy(_chatId, value) {
      busy.push(value)
    },
  }
  return { port, notices, responses, busy, images }
}

function writeAdapterConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(tmpDir, 'adapters.json'), JSON.stringify(config, null, 2))
}

function createRuntime(overrides: { workDir?: string } = {}) {
  const { port, notices, responses, busy, images } = createPort()
  const bridge = new FakeBridge()
  const httpClient = new FakeHttpClient()
  const sessionStore = new SessionStore(path.join(tmpDir, 'adapter-sessions.json'))
  const dedup = new MessageDedup()
  const config = loadConfig()
  const runtime = new ImChatRuntime({
    port,
    config,
    platformConfig: config.wecom,
    bridge: bridge as unknown as WsBridge,
    sessionStore,
    httpClient: httpClient as unknown as AdapterHttpClient,
    defaultWorkDir: overrides.workDir ?? tmpDir,
    dedup,
    // Flush immediately so a test does not have to wait on a timer.
    flushIntervalMs: 1,
    flushCharThreshold: 1,
  })
  return { runtime, port, notices, responses, busy, images, bridge, httpClient, sessionStore, dedup }
}

async function inbound(
  runtime: ImChatRuntime,
  text: string,
  overrides: Partial<{
    dedupKey: string
    userId: string
    loadAttachments: () => Promise<AttachmentRef[]>
    hasAttachments: boolean
  }> = {},
): Promise<void> {
  await runtime.handleInbound({
    chatId: CHAT_ID,
    userId: overrides.userId ?? USER_ID,
    displayName: 'Tester',
    dedupKey: overrides.dedupKey ?? `msg-${Math.random()}`,
    text,
    loadAttachments: overrides.loadAttachments,
    hasAttachments: overrides.hasAttachments,
  })
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-runtime-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  writeAdapterConfig({ wecom: { pairedUsers: [{ userId: USER_ID, displayName: 'Tester', pairedAt: 1 }] } })
})

afterEach(() => {
  if (originalConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  else delete process.env.CLAUDE_CONFIG_DIR
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('ImChatRuntime authorization', () => {
  it('refuses an unpaired sender and forwards nothing to the session', async () => {
    writeAdapterConfig({ wecom: { pairedUsers: [], allowedUsers: [] } })
    const { runtime, notices, bridge } = createRuntime()

    await inbound(runtime, 'hello')

    expect(bridge.sent).toHaveLength(0)
    expect(notices[0]).toContain('未授权')
  })

  it('pairs on a valid code and then forwards the next message', async () => {
    writeAdapterConfig({
      wecom: { pairedUsers: [], allowedUsers: [] },
      pairing: { code: 'ABC234', expiresAt: Date.now() + 60_000, createdAt: Date.now() },
    })
    const { runtime, notices, bridge } = createRuntime()

    await inbound(runtime, 'ABC234')
    expect(notices[0]).toContain('配对成功')

    await inbound(runtime, 'hello there')
    expect(bridge.sent.map((item) => item.content)).toEqual(['hello there'])
  })

  // Both directions of the dedup rule: a replay is dropped, a genuine repeat
  // with its own id is not.
  it('drops a replayed message id but keeps a repeated message with a new id', async () => {
    const { runtime, bridge } = createRuntime()

    await inbound(runtime, 'same text', { dedupKey: 'm1' })
    await inbound(runtime, 'same text', { dedupKey: 'm1' })
    expect(bridge.sent).toHaveLength(1)

    await inbound(runtime, 'same text', { dedupKey: 'm2' })
    expect(bridge.sent).toHaveLength(2)
  })
})

describe('ImChatRuntime session lifecycle', () => {
  it('creates a session on the first message and reuses it for the second', async () => {
    const { runtime, httpClient, bridge } = createRuntime()

    await inbound(runtime, 'first')
    await inbound(runtime, 'second')

    expect(httpClient.createdSessions).toEqual([tmpDir])
    expect(bridge.sent.map((item) => item.content)).toEqual(['first', 'second'])
  })

  it('starts a fresh session for /new and drops the previous binding', async () => {
    const { runtime, httpClient, bridge, sessionStore } = createRuntime()

    await inbound(runtime, 'first')
    const firstSessionId = sessionStore.get(CHAT_ID)?.sessionId

    await inbound(runtime, '/new')
    const secondSessionId = sessionStore.get(CHAT_ID)?.sessionId

    expect(httpClient.createdSessions).toHaveLength(2)
    expect(secondSessionId).not.toBe(firstSessionId)
    expect(bridge.resets).toContain(CHAT_ID)
  })

  it('answers /status with the no-session text before any message', async () => {
    const { runtime, notices } = createRuntime()

    await inbound(runtime, '/status')

    expect(notices[0]).toContain('当前没有活动会话')
  })

  it('sends a stop signal for /stop once a session exists', async () => {
    const { runtime, bridge } = createRuntime()

    await inbound(runtime, 'first')
    await inbound(runtime, '/stop')

    expect(bridge.stopped).toEqual([CHAT_ID])
  })

  it('forwards /clear into the live session instead of recreating it', async () => {
    const { runtime, bridge, httpClient } = createRuntime()

    await inbound(runtime, 'first')
    await inbound(runtime, '/clear')

    expect(httpClient.createdSessions).toHaveLength(1)
    expect(bridge.sent.map((item) => item.content)).toEqual(['first', '/clear'])
  })
})

describe('ImChatRuntime server stream', () => {
  it('streams deltas into one response and finishes it exactly once', async () => {
    const { runtime, responses } = createRuntime()

    await runtime.handleServerMessage(CHAT_ID, { type: 'content_start', blockType: 'text' })
    await runtime.handleServerMessage(CHAT_ID, { type: 'content_delta', text: 'Hello ' })
    await runtime.handleServerMessage(CHAT_ID, { type: 'content_delta', text: 'world' })
    await runtime.handleServerMessage(CHAT_ID, { type: 'message_complete' })

    expect(responses).toHaveLength(1)
    expect(responses[0]!.appended.join('')).toBe('Hello world')
    expect(responses[0]!.finished).toBe(1)
  })

  it('opens a new response for the next turn', async () => {
    const { runtime, responses } = createRuntime()

    await runtime.handleServerMessage(CHAT_ID, { type: 'content_delta', text: 'one' })
    await runtime.handleServerMessage(CHAT_ID, { type: 'message_complete' })
    await runtime.handleServerMessage(CHAT_ID, { type: 'content_delta', text: 'two' })
    await runtime.handleServerMessage(CHAT_ID, { type: 'message_complete' })

    expect(responses).toHaveLength(2)
    expect(responses[1]!.appended.join('')).toBe('two')
  })

  it('closes the in-flight reply before asking for permission', async () => {
    const { runtime, responses, notices } = createRuntime()

    await runtime.handleServerMessage(CHAT_ID, { type: 'content_delta', text: 'about to run' })
    await runtime.handleServerMessage(CHAT_ID, {
      type: 'permission_request',
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'ls' },
    })

    expect(responses[0]!.finished).toBe(1)
    expect(notices.join('\n')).toContain('req-1')
  })

  it('routes a numeric reply to the single pending permission request', async () => {
    const { runtime, bridge } = createRuntime()

    await inbound(runtime, 'run something')
    await runtime.handleServerMessage(CHAT_ID, {
      type: 'permission_request',
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'ls' },
    })
    await inbound(runtime, '1')

    expect(bridge.permissionResponses).toEqual([{ requestId: 'req-1', allowed: true, rule: undefined }])
  })

  it('records a permanent allow separately from a one-shot allow', async () => {
    const { runtime, bridge } = createRuntime()

    await inbound(runtime, 'run something')
    await runtime.handleServerMessage(CHAT_ID, {
      type: 'permission_request',
      requestId: 'req-2',
      toolName: 'Bash',
      input: {},
    })
    await inbound(runtime, '2')

    expect(bridge.permissionResponses).toEqual([{ requestId: 'req-2', allowed: true, rule: 'always' }])
  })

  it('rejects a decision for a request that is not pending', async () => {
    const { runtime, bridge, notices } = createRuntime()

    await inbound(runtime, 'hello')
    await inbound(runtime, '/allow req-missing')

    expect(bridge.permissionResponses).toHaveLength(0)
    expect(notices.join('\n')).toContain('req-missing')
  })

  it('rebuilds the session when the server reports a stale thinking signature', async () => {
    const { runtime, httpClient, notices } = createRuntime()

    await inbound(runtime, 'hello')
    expect(httpClient.createdSessions).toHaveLength(1)

    await runtime.handleServerMessage(CHAT_ID, {
      type: 'error',
      message: 'Invalid `signature` field for `thinking` block',
    })

    expect(httpClient.createdSessions).toHaveLength(2)
    expect(notices.join('\n')).toContain('已重建会话')
  })

  it('reports an ordinary error without recreating the session', async () => {
    const { runtime, httpClient, notices } = createRuntime()

    await inbound(runtime, 'hello')
    await runtime.handleServerMessage(CHAT_ID, { type: 'error', message: 'boom' })

    expect(httpClient.createdSessions).toHaveLength(1)
    expect(notices.join('\n')).toContain('boom')
  })

  it('drives the busy indicator in both directions', async () => {
    const { runtime, busy } = createRuntime()

    await runtime.handleServerMessage(CHAT_ID, { type: 'status', state: 'thinking' })
    await runtime.handleServerMessage(CHAT_ID, { type: 'message_complete' })

    expect(busy).toContain(true)
    expect(busy[busy.length - 1]).toBe(false)
  })

  it('uploads an image referenced in the stream and skips one outside the work dir', async () => {
    const workDir = fs.realpathSync(tmpDir)
    const insidePath = path.join(workDir, 'inside.png')
    // 1×1 transparent PNG.
    fs.writeFileSync(
      insidePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
      ),
    )
    const { runtime, images } = createRuntime({ workDir })

    await inbound(runtime, 'draw me something')
    await runtime.handleServerMessage(CHAT_ID, {
      type: 'content_delta',
      text: `![inside](${insidePath}) ![outside](/etc/hosts)`,
    })
    await runtime.handleServerMessage(CHAT_ID, { type: 'message_complete' })
    // The upload is dispatched without blocking the stream.
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(images).toEqual([{ mime: 'image/png', alt: 'inside' }])
  })
})

describe('ImChatRuntime project selection', () => {
  it('opens the picker when no default work dir is configured, then binds the reply', async () => {
    const { runtime, httpClient, notices } = createRuntime({ workDir: '' })
    httpClient.projects = [{ projectName: 'demo', realPath: tmpDir, branch: 'main' }]

    await inbound(runtime, 'hello')
    expect(notices.join('\n')).toContain('选择项目')
    expect(httpClient.createdSessions).toHaveLength(0)

    await inbound(runtime, 'demo')
    expect(httpClient.createdSessions).toEqual([tmpDir])
  })
})

describe('ImChatRuntime abandoning a live turn', () => {
  // `finish()` is the only way a platform closes its presentation: a WeCom
  // bubble stays "generating" forever without it, and a QQ StreamSession keeps
  // a live timer that can fire into a stream nobody is reading.
  it.each([
    ['/new', '/new'],
    ['/clear', '/clear'],
  ])('closes the in-flight response when %s arrives mid-stream', async (_label, command) => {
    const { runtime, responses } = createRuntime()

    await inbound(runtime, 'do something slow')
    await runtime.handleServerMessage(CHAT_ID, { type: 'content_delta', text: 'working on it' })
    expect(responses).toHaveLength(1)
    expect(responses[0]!.finished).toBe(0)

    await inbound(runtime, command)

    expect(responses[0]!.finished).toBe(1)
  })

  it('closes the in-flight response when a stale session is rebuilt', async () => {
    const { runtime, responses } = createRuntime()

    await inbound(runtime, 'hello')
    await runtime.handleServerMessage(CHAT_ID, { type: 'content_delta', text: 'partial' })
    await runtime.handleServerMessage(CHAT_ID, {
      type: 'error',
      message: 'Invalid `signature` field for `thinking` block',
    })

    expect(responses[0]!.finished).toBe(1)
  })

  it('never finishes the same response twice', async () => {
    const { runtime, responses } = createRuntime()

    await inbound(runtime, 'hello')
    await runtime.handleServerMessage(CHAT_ID, { type: 'content_delta', text: 'done' })
    await runtime.handleServerMessage(CHAT_ID, { type: 'message_complete' })
    await inbound(runtime, '/new')

    expect(responses).toHaveLength(1)
    expect(responses[0]!.finished).toBe(1)
  })
})

describe('ImChatRuntime attachment authorization', () => {
  // Downloading before the pairing gate lets a stranger make the adapter fetch
  // bytes and write them under ~/.claude/im-downloads — and on Slack that
  // fetch carries the bot token.
  it('does not download attachments for an unpaired sender', async () => {
    writeAdapterConfig({ wecom: { pairedUsers: [], allowedUsers: [] } })
    const { runtime, notices } = createRuntime()
    let loads = 0

    await inbound(runtime, 'look at this', {
      hasAttachments: true,
      loadAttachments: async () => {
        loads += 1
        return []
      },
    })

    expect(loads).toBe(0)
    expect(notices[0]).toContain('未授权')
  })

  it('does not download attachments for a replayed message', async () => {
    const { runtime } = createRuntime()
    let loads = 0
    const loadAttachments = async () => {
      loads += 1
      return []
    }

    await inbound(runtime, 'first', { dedupKey: 'm1', hasAttachments: true, loadAttachments })
    await inbound(runtime, 'first', { dedupKey: 'm1', hasAttachments: true, loadAttachments })

    expect(loads).toBe(1)
  })

  it('downloads once the sender is authorized and forwards the result', async () => {
    const { runtime, bridge } = createRuntime()

    await inbound(runtime, 'look at this', {
      hasAttachments: true,
      loadAttachments: async () => [
        { type: 'image', name: 'a.png', data: 'AAAA', mimeType: 'image/png' },
      ],
    })

    expect(bridge.sent).toHaveLength(1)
    expect(bridge.sent[0]!.attachments).toEqual([
      { type: 'image', name: 'a.png', data: 'AAAA', mimeType: 'image/png' },
    ])
  })

  // Command routing only applies to attachment-free messages. Both directions
  // matter: a bare command must not reach the agent, and text that merely
  // looks like a command must not swallow the file sent with it.
  it('routes a bare command without touching the attachment path', async () => {
    const { runtime, bridge, notices } = createRuntime()

    await inbound(runtime, '/status')

    expect(bridge.sent).toHaveLength(0)
    expect(notices[0]).toContain('当前没有活动会话')
  })

  it('forwards a command-looking caption sent with a file instead of running it', async () => {
    const { runtime, bridge, notices } = createRuntime()

    await inbound(runtime, '/status', {
      hasAttachments: true,
      loadAttachments: async () => [
        { type: 'image', name: 'a.png', data: 'AAAA', mimeType: 'image/png' },
      ],
    })

    expect(bridge.sent.map((item) => item.content)).toEqual(['/status'])
    expect(notices.join('\n')).not.toContain('当前没有活动会话')
  })

  it('runs the download inside the per-chat queue, so order is preserved', async () => {
    const { runtime, bridge } = createRuntime()

    const slow = inbound(runtime, 'with attachment', {
      dedupKey: 'slow',
      hasAttachments: true,
      loadAttachments: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return []
      },
    })
    const fast = inbound(runtime, 'plain text', { dedupKey: 'fast' })
    await Promise.all([slow, fast])

    expect(bridge.sent.map((item) => item.content)).toEqual(['with attachment', 'plain text'])
  })
})

describe('ImChatRuntime historical sessions', () => {
  function addHistory(httpClient: FakeHttpClient) {
    httpClient.existingSessions.add('desktop-history')
    httpClient.sessions = [{
      id: 'desktop-history', title: 'Continue desktop work', createdAt: '2026-08-01',
      modifiedAt: '2026-08-31', messageCount: 5, projectPath: 'encoded',
      workDir: tmpDir, workDirExists: true,
    }]
    httpClient.projects = [{ projectName: 'demo', realPath: tmpDir }]
  }

  it('continues a desktop session through the real command pipeline and forwards the next message to that ID', async () => {
    const { runtime, httpClient, bridge, sessionStore, notices } = createRuntime()
    addHistory(httpClient)
    await inbound(runtime, '/sessions demo')
    expect(notices.at(-1)).toContain('Continue desktop work')
    expect(bridge.sent).toEqual([])
    await inbound(runtime, '/resume 1')
    expect(sessionStore.get(CHAT_ID)?.sessionId).toBe('desktop-history')
    await inbound(runtime, '接着完成刚才的任务')
    expect(bridge.getSessionId(CHAT_ID)).toBe('desktop-history')
    expect(bridge.sent).toEqual([{ content: '接着完成刚才的任务', attachments: undefined }])
    expect(httpClient.createdSessions).toEqual([])
  })

  it('refuses switching between sending a prompt and the first server status, then allows it after idle', async () => {
    const { runtime, httpClient, bridge, sessionStore, notices } = createRuntime()
    addHistory(httpClient)
    await inbound(runtime, 'start')
    const original = sessionStore.get(CHAT_ID)?.sessionId
    await inbound(runtime, '/sessions')
    await inbound(runtime, '/resume 1')
    expect(notices.at(-1)).toContain('正在运行')
    expect(sessionStore.get(CHAT_ID)?.sessionId).toBe(original)
    await runtime.handleServerMessage(CHAT_ID, { type: 'status', state: 'idle' })
    await inbound(runtime, '/resume 1')
    expect(bridge.getSessionId(CHAT_ID)).toBe('desktop-history')
  })

  it('recognizes a running desktop turn from the initial connection snapshot', async () => {
    const { runtime, httpClient, sessionStore, notices } = createRuntime()
    addHistory(httpClient)
    await inbound(runtime, '/sessions demo')
    await inbound(runtime, '/resume 1')
    await runtime.handleServerMessage(CHAT_ID, { type: 'permission_requests_snapshot', turnActive: true })
    expect(runtime.getRuntimeState(CHAT_ID).state).toBe('thinking')
    await inbound(runtime, '/sessions')
    await inbound(runtime, '/resume 1')
    expect(notices.at(-1)).toContain('正在运行')
    expect(sessionStore.get(CHAT_ID)?.sessionId).toBe('desktop-history')
    await runtime.handleServerMessage(CHAT_ID, { type: 'permission_request', requestId: 'pending', toolName: 'Bash', input: {} })
    await runtime.handleServerMessage(CHAT_ID, { type: 'permission_requests_snapshot', turnActive: true })
    expect(runtime.getRuntimeState(CHAT_ID).state).toBe('permission_pending')
  })

  it('allows another history selection after a replayed permission is resolved on Desktop', async () => {
    const { runtime, httpClient, notices } = createRuntime()
    addHistory(httpClient)
    await inbound(runtime, '/sessions demo')
    await inbound(runtime, '/resume 1')
    await runtime.handleServerMessage(CHAT_ID, { type: 'permission_request', requestId: 'desktop-request', toolName: 'Bash', input: {} })
    await runtime.handleServerMessage(CHAT_ID, { type: 'permission_requests_snapshot', toolRequestIds: ['desktop-request'], turnActive: true })
    await runtime.handleServerMessage(CHAT_ID, { type: 'permission_resolved', requestId: 'desktop-request', permissionType: 'tool', allowed: true })
    await runtime.handleServerMessage(CHAT_ID, { type: 'status', state: 'idle' })
    expect(runtime.getRuntimeState(CHAT_ID).pendingPermissionCount).toBe(0)
    await inbound(runtime, '/sessions')
    await inbound(runtime, '/resume 1')
    expect(notices.at(-1)).toContain('已恢复会话')
  })

  it('keeps permission answers ahead of session numbers and cancels the picker for project switching', async () => {
    const { runtime, httpClient, bridge, sessionStore } = createRuntime()
    addHistory(httpClient)
    await inbound(runtime, '/sessions demo')
    await runtime.handleServerMessage(CHAT_ID, { type: 'permission_request', requestId: 'req-1', toolName: 'Bash', input: {} })
    await inbound(runtime, '1')
    expect(bridge.permissionResponses).toHaveLength(1)
    expect(sessionStore.get(CHAT_ID)).toBeNull()
    await inbound(runtime, '/projects')
    await inbound(runtime, '/resume 1')
    expect(sessionStore.get(CHAT_ID)).toBeNull()
  })

  it('authorizes history commands and does not interpret attachment captions as commands', async () => {
    const { runtime, httpClient, notices, bridge } = createRuntime()
    addHistory(httpClient)
    await inbound(runtime, '/sessions demo', { userId: 'stranger' })
    expect(notices.at(-1)).toContain('未授权')
    await inbound(runtime, '/sessions demo', { hasAttachments: true, loadAttachments: async () => [] })
    expect(bridge.sent.at(-1)?.content).toBe('/sessions demo')
  })
})
