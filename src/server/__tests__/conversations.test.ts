/**
 * Tests for ConversationService and WebSocket chat integration
 *
 * ConversationService 管理 CLI 子进程的生命周期。
 * WebSocket 集成测试验证消息从客户端经过服务端到达 CLI 的完整流转。
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ConversationService, ConversationStartupError, conversationService } from '../services/conversationService.js'
import { SessionService, sessionService } from '../services/sessionService.js'
import { ProviderService } from '../services/providerService.js'

async function rmWithRetry(targetPath: string): Promise<void> {
  const attempts = process.platform === 'win32' ? 5 : 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true })
      return
    } catch (error) {
      if (
        attempt === attempts - 1 ||
        !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')
      ) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}

// ============================================================================
// ConversationService unit tests
// ============================================================================

describe('ConversationService', () => {
  it('should report no session for unknown ID', () => {
    const svc = new ConversationService()
    const sid = crypto.randomUUID()
    expect(svc.hasSession(sid)).toBe(false)
  })

  it('should track active sessions as empty initially', () => {
    const svc = new ConversationService()
    expect(svc.getActiveSessions()).toEqual([])
  })

  it('should block startup after a session is deleted during prewarm', async () => {
    const svc = new ConversationService()
    const sid = crypto.randomUUID()

    svc.markSessionDeleted(sid)

    try {
      await svc.startSession(sid, process.cwd(), 'ws://127.0.0.1:1/sdk/test')
      throw new Error('expected startSession to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(ConversationStartupError)
      expect((error as ConversationStartupError).code).toBe('SESSION_DELETED')
    }
  })

  it('should return false when sending message to non-existent session', async () => {
    const svc = new ConversationService()
    const result = await svc.sendMessage('no-such-session', 'hello')
    expect(result).toBe(false)
  })

  it('should return false when responding to permission for non-existent session', () => {
    const svc = new ConversationService()
    const result = svc.respondToPermission('no-such-session', 'req-1', true)
    expect(result).toBe(false)
  })

  it('should not queue control requests before the SDK socket connects', async () => {
    const svc = new ConversationService()
    const sid = crypto.randomUUID()
    const sent: unknown[] = []
    const session: any = {
      proc: { kill() {}, exited: Promise.resolve(0) },
      outputCallbacks: [],
      workDir: process.cwd(),
      permissionMode: 'default',
      sdkToken: 'token',
      sdkSocket: null,
      pendingOutbound: [],
      startupPending: false,
      startupExitCode: null,
      stdoutLines: [],
      stderrLines: [],
      outputDrain: Promise.resolve(),
      sdkMessages: [],
      initMessage: null,
      pendingPermissionRequests: new Map(),
    }
    ;(svc as any).sessions.set(sid, session)

    const request = svc.requestControl(sid, { subtype: 'get_context_usage' }, 1_000)
    await new Promise((resolve) => setTimeout(resolve, 75))

    expect(session.pendingOutbound).toHaveLength(0)
    expect(sent).toHaveLength(0)

    session.sdkSocket = {
      send(data: string) {
        sent.push(JSON.parse(data))
      },
    }

    await new Promise((resolve) => setTimeout(resolve, 75))
    expect(session.pendingOutbound).toHaveLength(0)
    expect(sent).toHaveLength(1)

    const requestId = (sent[0] as any).request_id
    for (const callback of [...session.outputCallbacks]) {
      callback({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: { ok: true },
        },
      })
    }

    await expect(request).resolves.toEqual({ ok: true })
  })

  it('should forward suggested permission updates for allow-for-session decisions', () => {
    const svc = new ConversationService()
    const sent: unknown[] = []

    ;(svc as any).sessions.set('session-1', {
      proc: null,
      outputCallbacks: [],
      workDir: process.cwd(),
      sdkToken: 'token',
      sdkSocket: {
        send(data: string) {
          sent.push(JSON.parse(data))
        },
      },
      pendingOutbound: [],
      stderrLines: [],
      sdkMessages: [],
      pendingPermissionRequests: new Map([
        ['req-1', {
          toolName: 'Bash',
          input: { command: 'ls src' },
          permissionSuggestions: [
            {
              type: 'addRules',
              rules: [{ toolName: 'Bash', ruleContent: 'ls src' }],
              behavior: 'allow',
              destination: 'localSettings',
            },
          ],
        }],
      ]),
    })

    const result = svc.respondToPermission('session-1', 'req-1', true, 'always')

    expect(result).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'control_response',
      response: {
        response: {
          behavior: 'allow',
          updatedPermissions: [
            {
              type: 'addRules',
              rules: [{ toolName: 'Bash', ruleContent: 'ls src' }],
              behavior: 'allow',
              destination: 'session',
            },
          ],
        },
      },
    })
  })

  it('should send set_permission_mode requests to active sessions', () => {
    const svc = new ConversationService()
    const sent: unknown[] = []

    ;(svc as any).sessions.set('session-2', {
      proc: null,
      outputCallbacks: [],
      workDir: process.cwd(),
      sdkToken: 'token',
      sdkSocket: {
        send(data: string) {
          sent.push(JSON.parse(data))
        },
      },
      pendingOutbound: [],
      stderrLines: [],
      sdkMessages: [],
      pendingPermissionRequests: new Map(),
    })

    const result = svc.setPermissionMode('session-2', 'acceptEdits')

    expect(result).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'control_request',
      request: {
        subtype: 'set_permission_mode',
        mode: 'acceptEdits',
      },
    })
  })

  it('should not inject a desktop-specific ask override in default permission mode', () => {
    const svc = new ConversationService()
    expect((svc as any).getPermissionArgs('default', false)).toEqual([
      '--permission-mode',
      'default',
    ])
  })

  it('should pass disabled thinking to the CLI runtime args', () => {
    const svc = new ConversationService()
    expect((svc as any).getRuntimeArgs({
      model: 'deepseek-v4-pro',
      effort: 'medium',
      thinking: 'disabled',
    })).toEqual([
      '--model',
      'deepseek-v4-pro',
      '--effort',
      'medium',
      '--thinking',
      'disabled',
    ])
  })

  it('should return false when sending interrupt to non-existent session', () => {
    const svc = new ConversationService()
    const result = svc.sendInterrupt('no-such-session')
    expect(result).toBe(false)
  })

  it('should not throw when stopping non-existent session', () => {
    const svc = new ConversationService()
    expect(() => svc.stopSession('no-such-session')).not.toThrow()
  })

  it('should not throw when registering callback for non-existent session', () => {
    const svc = new ConversationService()
    expect(() => svc.onOutput('no-such-session', () => {})).not.toThrow()
  })

  it('should ignore stale process exits after a session restarts', async () => {
    const svc = new ConversationService()
    const oldProc = { pid: 1 } as any
    const newProc = { pid: 2 } as any

    ;(svc as any).sessions.set('session-restart', {
      proc: newProc,
      outputCallbacks: [],
      workDir: process.cwd(),
      permissionMode: 'bypassPermissions',
      sdkToken: 'token',
      sdkSocket: null,
      pendingOutbound: [],
      stderrLines: [],
      sdkMessages: [],
      pendingPermissionRequests: new Map(),
    })

    await (svc as any).handleProcessExit('session-restart', oldProc, 143)
    expect(svc.hasSession('session-restart')).toBe(true)

    await (svc as any).handleProcessExit('session-restart', newProc, 0)
    expect(svc.hasSession('session-restart')).toBe(false)
  })

  it('should retain SDK init metadata after recent message trimming', () => {
    const svc = new ConversationService()

    ;(svc as any).sessions.set('session-init-retention', {
      proc: { pid: 1 },
      outputCallbacks: [],
      workDir: process.cwd(),
      permissionMode: 'default',
      sdkToken: 'token',
      sdkSocket: null,
      pendingOutbound: [],
      stderrLines: [],
      sdkMessages: [],
      initMessage: null,
      pendingPermissionRequests: new Map(),
    })

    ;(svc as any).handleSdkPayload('session-init-retention', JSON.stringify({
      type: 'system',
      subtype: 'init',
      model: 'mock-opus',
      claude_code_version: 'test-version',
      slash_commands: ['help', 'context'],
    }))

    for (let i = 0; i < 45; i++) {
      ;(svc as any).handleSdkPayload('session-init-retention', JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_delta', index: i },
      }))
    }

    expect(svc.getRecentSdkMessages('session-init-retention').some((message) => message.subtype === 'init')).toBe(false)
    expect(svc.getSessionInitMessage('session-init-retention')).toMatchObject({
      model: 'mock-opus',
      claude_code_version: 'test-version',
      slash_commands: ['help', 'context'],
    })
  })

  it('should reconstruct usage and metadata from a persisted transcript', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    const tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-transcript-'))
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workdir-'))
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
    process.env.ANTHROPIC_API_KEY = 'test-key'

    try {
      const svc = new SessionService()
      const { sessionId } = await svc.createSession(workDir)
      const found = await svc.findSessionFile(sessionId)
      expect(found).not.toBeNull()

      await fs.appendFile(found!.filePath, JSON.stringify({
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-04-27T12:00:00.000Z',
        cwd: workDir,
        version: '999.0.0-test',
        message: {
          role: 'assistant',
          model: 'mock-model',
          content: [{ type: 'text', text: 'hello' }],
          usage: {
            input_tokens: 1234,
            output_tokens: 56,
            cache_read_input_tokens: 7,
            cache_creation_input_tokens: 8,
            server_tool_use: { web_search_requests: 1 },
          },
        },
      }) + '\n')

      const metadata = await svc.getTranscriptMetadata(sessionId)
      const usage = await svc.getTranscriptUsage(sessionId)

      expect(metadata).toMatchObject({
        cwd: workDir,
        version: '999.0.0-test',
        model: 'mock-model',
      })
      expect(usage).toMatchObject({
        source: 'transcript',
        totalInputTokens: 1234,
        totalOutputTokens: 56,
        totalCacheReadInputTokens: 7,
        totalCacheCreationInputTokens: 8,
        totalWebSearchRequests: 1,
      })
      expect(usage?.models[0]?.model).toBe('mock-model')
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      }
      if (previousAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey
      }
      await fs.rm(tmpConfigDir, { recursive: true, force: true })
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('should reconstruct Sonnet 4.6 transcript usage before CLI config is initialized', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousNodeEnv = process.env.NODE_ENV
    const tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-transcript-sonnet-'))
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workdir-sonnet-'))
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
    process.env.NODE_ENV = 'development'

    try {
      const svc = new SessionService()
      const { sessionId } = await svc.createSession(workDir)
      const found = await svc.findSessionFile(sessionId)
      expect(found).not.toBeNull()

      await fs.appendFile(found!.filePath, JSON.stringify({
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-04-27T12:00:00.000Z',
        cwd: workDir,
        version: '999.0.0-test',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'hello' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
        },
      }) + '\n')

      const usage = await svc.getTranscriptUsage(sessionId)
      const contextEstimate = await svc.getTranscriptContextEstimate(sessionId)

      expect(usage?.models[0]?.model).toBe('claude-sonnet-4-6')
      expect(usage?.models[0]?.contextWindow).toBe(200_000)
      expect(contextEstimate?.model).toBe('claude-sonnet-4-6')
      expect(contextEstimate?.totalTokens).toBe(120)
      expect(contextEstimate?.rawMaxTokens).toBe(200_000)
      expect(contextEstimate?.categories.some((category) => category.name === 'Output tokens' && category.tokens === 20)).toBe(true)
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      }
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
      await fs.rm(tmpConfigDir, { recursive: true, force: true })
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })
})

// ============================================================================
// WebSocket integration tests (with mock CLI using the SDK websocket protocol)
// ============================================================================

describe('WebSocket Chat Integration', () => {
  let server: ReturnType<typeof Bun.serve>
  let baseUrl: string
  let wsUrl: string
  let tmpDir: string

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
    })
  }

  async function createCleanGitRepo(): Promise<string> {
    const workDir = path.join(
      tmpDir,
      `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )

    await fs.mkdir(workDir, { recursive: true })
    git(workDir, 'init')
    git(workDir, 'config', 'user.email', 'conversations@example.com')
    git(workDir, 'config', 'user.name', 'Conversations Test')
    git(workDir, 'checkout', '-b', 'main')
    await fs.writeFile(path.join(workDir, 'README.md'), 'main\n')
    git(workDir, 'add', 'README.md')
    git(workDir, 'commit', '-m', 'initial')
    git(workDir, 'checkout', '-b', 'feature/rail')
    await fs.writeFile(path.join(workDir, 'feature.txt'), 'feature\n')
    git(workDir, 'add', 'feature.txt')
    git(workDir, 'commit', '-m', 'feature')
    git(workDir, 'checkout', 'main')

    return workDir
  }

  async function withMockInitMode<T>(
    mode: string | undefined,
    callback: () => Promise<T>,
  ): Promise<T> {
    const previousMode = process.env.MOCK_SDK_INIT_MODE

    if (mode) {
      process.env.MOCK_SDK_INIT_MODE = mode
    } else {
      delete process.env.MOCK_SDK_INIT_MODE
    }

    try {
      return await callback()
    } finally {
      if (previousMode === undefined) {
        delete process.env.MOCK_SDK_INIT_MODE
      } else {
        process.env.MOCK_SDK_INIT_MODE = previousMode
      }
    }
  }

  async function withMockInitDelay<T>(
    delayMs: number | undefined,
    callback: () => Promise<T>,
  ): Promise<T> {
    const previousDelay = process.env.MOCK_SDK_INIT_DELAY_MS

    if (delayMs && delayMs > 0) {
      process.env.MOCK_SDK_INIT_DELAY_MS = String(delayMs)
    } else {
      delete process.env.MOCK_SDK_INIT_DELAY_MS
    }

    try {
      return await callback()
    } finally {
      if (previousDelay === undefined) {
        delete process.env.MOCK_SDK_INIT_DELAY_MS
      } else {
        process.env.MOCK_SDK_INIT_DELAY_MS = previousDelay
      }
    }
  }

  async function withMockStreamDelay<T>(
    delayMs: number | undefined,
    callback: () => Promise<T>,
  ): Promise<T> {
    const previousDelay = process.env.MOCK_SDK_STREAM_DELAY_MS

    if (delayMs && delayMs > 0) {
      process.env.MOCK_SDK_STREAM_DELAY_MS = String(delayMs)
    } else {
      delete process.env.MOCK_SDK_STREAM_DELAY_MS
    }

    try {
      return await callback()
    } finally {
      if (previousDelay === undefined) {
        delete process.env.MOCK_SDK_STREAM_DELAY_MS
      } else {
        process.env.MOCK_SDK_STREAM_DELAY_MS = previousDelay
      }
    }
  }

  async function withMockMcpStatusDelay<T>(
    delayMs: number | undefined,
    callback: () => Promise<T>,
  ): Promise<T> {
    const previousDelay = process.env.MOCK_SDK_MCP_STATUS_DELAY_MS

    if (delayMs && delayMs > 0) {
      process.env.MOCK_SDK_MCP_STATUS_DELAY_MS = String(delayMs)
    } else {
      delete process.env.MOCK_SDK_MCP_STATUS_DELAY_MS
    }

    try {
      return await callback()
    } finally {
      if (previousDelay === undefined) {
        delete process.env.MOCK_SDK_MCP_STATUS_DELAY_MS
      } else {
        process.env.MOCK_SDK_MCP_STATUS_DELAY_MS = previousDelay
      }
    }
  }

  async function withMockExitAfterFirstUser<T>(
    delayMs: number | undefined,
    callback: () => Promise<T>,
  ): Promise<T> {
    const previousDelay = process.env.MOCK_SDK_EXIT_AFTER_FIRST_USER_MS

    if (delayMs && delayMs > 0) {
      process.env.MOCK_SDK_EXIT_AFTER_FIRST_USER_MS = String(delayMs)
    } else {
      delete process.env.MOCK_SDK_EXIT_AFTER_FIRST_USER_MS
    }

    try {
      return await callback()
    } finally {
      if (previousDelay === undefined) {
        delete process.env.MOCK_SDK_EXIT_AFTER_FIRST_USER_MS
      } else {
        process.env.MOCK_SDK_EXIT_AFTER_FIRST_USER_MS = previousDelay
      }
    }
  }

  async function withMockStartupStdoutExit<T>(
    stdout: string,
    exitDelayMs: number,
    callback: () => Promise<T>,
  ): Promise<T> {
    const previousStdout = process.env.MOCK_SDK_STARTUP_STDOUT
    const previousExitDelay = process.env.MOCK_SDK_EXIT_BEFORE_SDK_MS

    process.env.MOCK_SDK_STARTUP_STDOUT = stdout
    process.env.MOCK_SDK_EXIT_BEFORE_SDK_MS = String(exitDelayMs)

    try {
      return await callback()
    } finally {
      if (previousStdout === undefined) {
        delete process.env.MOCK_SDK_STARTUP_STDOUT
      } else {
        process.env.MOCK_SDK_STARTUP_STDOUT = previousStdout
      }

      if (previousExitDelay === undefined) {
        delete process.env.MOCK_SDK_EXIT_BEFORE_SDK_MS
      } else {
        process.env.MOCK_SDK_EXIT_BEFORE_SDK_MS = previousExitDelay
      }
    }
  }

  async function runTurn(sessionId: string, content: string, allowError = false): Promise<any[]> {
    const messages: any[] = []
    const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error(`Timed out waiting for completion for session ${sessionId}`))
      }, 30000)

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data as string)
        messages.push(msg)
        if (msg.type === 'connected') {
          ws.send(JSON.stringify({ type: 'user_message', content }))
        }
        if (msg.type === 'error') {
          clearTimeout(timeout)
          ws.close()
          if (allowError) {
            resolve()
          } else {
            reject(new Error(msg.message))
          }
        }
        if (msg.type === 'message_complete') {
          clearTimeout(timeout)
          ws.close()
          resolve()
        }
      }

      ws.onerror = () => {
        clearTimeout(timeout)
        ws.close()
        reject(new Error(`WebSocket error for session ${sessionId}`))
      }
    })

    return messages
  }

  async function runTurnUntilComplete(sessionId: string, content: string): Promise<any[]> {
    const messages: any[] = []
    const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error(`Timed out waiting for terminal event for session ${sessionId}`))
      }, 10000)

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data as string)
        messages.push(msg)
        if (msg.type === 'connected') {
          ws.send(JSON.stringify({ type: 'user_message', content }))
        }
        if (msg.type === 'message_complete') {
          clearTimeout(timeout)
          ws.close()
          resolve()
        }
      }

      ws.onerror = () => {
        clearTimeout(timeout)
        ws.close()
        reject(new Error(`WebSocket error for session ${sessionId}`))
      }
    })

    return messages
  }

  async function waitUntil(
    predicate: () => boolean | Promise<boolean>,
    label: string,
    timeoutMs = 8000,
  ): Promise<void> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Timed out waiting for ${label}`)
  }
  const originalCliPath = process.env.CLAUDE_CLI_PATH

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-conv-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CLAUDE_CLI_PATH = fileURLToPath(
      new URL('./fixtures/mock-sdk-cli.ts', import.meta.url)
    )
    await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })

    const port = 15000 + Math.floor(Math.random() * 1000)
    const { startServer } = await import('../index.js')
    server = startServer(port, '127.0.0.1')
    baseUrl = `http://127.0.0.1:${port}`
    wsUrl = `ws://127.0.0.1:${port}`
  })

  afterAll(async () => {
    server?.stop()
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
    if (originalCliPath) {
      process.env.CLAUDE_CLI_PATH = originalCliPath
    } else {
      delete process.env.CLAUDE_CLI_PATH
    }
    delete process.env.CLAUDE_CONFIG_DIR
  })

  it('should connect and receive connected event', async () => {
    const messages: any[] = []
    const ws = new WebSocket(`${wsUrl}/ws/chat-test-1`)

    await new Promise<void>((resolve) => {
      ws.onmessage = (e) => {
        messages.push(JSON.parse(e.data as string))
        if (messages.length >= 1) {
          ws.close()
          resolve()
        }
      }
      ws.onerror = () => {
        ws.close()
        resolve()
      }
      setTimeout(() => {
        ws.close()
        resolve()
      }, 3000)
    })

    expect(messages[0].type).toBe('connected')
    expect(messages[0].sessionId).toBe('chat-test-1')
  })

  it('should handle stop_generation and return idle status', async () => {
    const messages: any[] = []
    const ws = new WebSocket(`${wsUrl}/ws/chat-test-2`)

    await new Promise<void>((resolve) => {
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data as string)
        messages.push(msg)
        if (msg.type === 'connected') {
          ws.send(JSON.stringify({ type: 'stop_generation' }))
        }
        if (msg.type === 'status' && msg.state === 'idle') {
          ws.close()
          resolve()
        }
      }
      ws.onerror = () => {
        ws.close()
        resolve()
      }
      setTimeout(() => {
        ws.close()
        resolve()
      }, 3000)
    })

    expect(messages.some((m) => m.type === 'status' && m.state === 'idle')).toBe(true)
  })

  it('should send user_message and receive streamed SDK response', async () => {
    const messages: any[] = []
    const ws = new WebSocket(`${wsUrl}/ws/chat-test-3`)

    await new Promise<void>((resolve) => {
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data as string)
        messages.push(msg)
        if (msg.type === 'connected') {
          ws.send(
            JSON.stringify({ type: 'user_message', content: 'Hello from test' })
          )
        }
        // Wait until we receive completion after the streamed response
        if (
          msg.type === 'message_complete' &&
          messages.some((entry) => entry.type === 'thinking')
        ) {
          ws.close()
          resolve()
        }
      }
      ws.onerror = () => {
        ws.close()
        resolve()
      }
      setTimeout(() => {
        ws.close()
        resolve()
      }, 5000)
    })

    const types = messages.map((m) => m.type)
    expect(types).toContain('connected')
    expect(types).toContain('status')
    // Mock SDK flow produces text streaming, thinking, and completion events.
    expect(types).toContain('content_start')
    expect(types).toContain('content_delta')
    expect(types).toContain('thinking')
    expect(types).toContain('message_complete')

    // Verify thinking was first status
    const statusMsgs = messages.filter((m) => m.type === 'status')
    expect(statusMsgs[0].state).toBe('thinking')
  })

  it('emits a worktree startup status before launching a repository session', async () => {
    const repoDir = await createCleanGitRepo()
    const { sessionId } = await sessionService.createSession(repoDir, {
      branch: 'feature/rail',
      worktree: true,
    })

    const messages = await runTurn(sessionId, 'Hello from repository launch test')
    const statusVerbs = messages
      .filter((msg) => msg.type === 'status')
      .map((msg) => msg.verb)

    expect(statusVerbs).toContain('Creating worktree')
  })

  it('keeps the default startup status for current-worktree repository sessions', async () => {
    const repoDir = await createCleanGitRepo()
    const { sessionId } = await sessionService.createSession(repoDir, {
      branch: 'main',
      worktree: false,
    })

    const messages = await runTurn(sessionId, 'Hello from current worktree launch test')
    const statusVerbs = messages
      .filter((msg) => msg.type === 'status')
      .map((msg) => msg.verb)

    expect(statusVerbs).toContain('Thinking')
    expect(statusVerbs).not.toContain('Creating worktree')
  })

  it('emits the derived session title before the first response completes', async () => {
    const sessionId = `title-fast-${crypto.randomUUID()}`
    const messages: any[] = []
    const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('Timed out waiting for derived session title'))
      }, 5000)

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string)
        messages.push(msg)
        if (msg.type === 'connected') {
          ws.send(JSON.stringify({
            type: 'user_message',
            content: '开始优化UI',
          }))
          return
        }
        if (msg.type === 'message_complete') {
          clearTimeout(timeout)
          ws.close()
          resolve()
        }
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error(`WebSocket error for title session ${sessionId}`))
      }
    })

    const titleIndex = messages.findIndex((msg) => msg.type === 'session_title_updated')
    const completionIndex = messages.findIndex((msg) => msg.type === 'message_complete')
    expect(titleIndex).toBeGreaterThan(-1)
    expect(completionIndex).toBeGreaterThan(-1)
    expect(messages[titleIndex].title).toBe('开始优化UI')
    expect(titleIndex).toBeLessThan(completionIndex)
  })

  it('should start desktop sessions with disabled thinking when configured', async () => {
    const sessionId = `chat-thinking-disabled-${crypto.randomUUID()}`
    const originalStartSession = conversationService.startSession.bind(conversationService)
    const startOptions: Array<{ thinking?: string; model?: string }> = []

    conversationService.startSession = (async function patchedStartSession(
      sid: string,
      workDir: string,
      sdkUrl: string,
      options?: { permissionMode?: string; model?: string; effort?: string; thinking?: 'enabled' | 'adaptive' | 'disabled'; providerId?: string | null },
    ) {
      if (sid === sessionId) {
        startOptions.push({ thinking: options?.thinking, model: options?.model })
      }
      return originalStartSession(sid, workDir, sdkUrl, options)
    }) as typeof conversationService.startSession

    try {
      await fs.writeFile(
        path.join(tmpDir, 'settings.json'),
        JSON.stringify({ alwaysThinkingEnabled: false }, null, 2),
        'utf-8',
      )

      const messages = await runTurn(sessionId, 'Hello without thinking')

      expect(messages.some((m) => m.type === 'message_complete')).toBe(true)
      expect(startOptions).toEqual([{ thinking: 'disabled', model: undefined }])
    } finally {
      conversationService.startSession = originalStartSession as typeof conversationService.startSession
      conversationService.stopSession(sessionId)
      await fs.writeFile(path.join(tmpDir, 'settings.json'), '{}\n', 'utf-8')
    }
  })

  it('should continue chat when SDK init arrives only after the first user turn', async () => {
    const messages = await withMockInitMode('on_first_user', () =>
      runTurn('chat-test-lazy-init', 'Hello after lazy init'),
    )

    expect(messages.some((m) => m.type === 'message_complete')).toBe(true)
    expect(messages.some((m) => m.type === 'error')).toBe(false)
    expect(
      messages.some(
        (m) => m.type === 'system_notification' && m.subtype === 'init',
      ),
    ).toBe(true)
  })

  it('should display CLI /cost local command output', async () => {
    const messages = await runTurn(`chat-cost-${crypto.randomUUID()}`, '/cost')

    expect(messages.some((m) => m.type === 'error')).toBe(false)
    expect(
      messages.some(
        (m) =>
          m.type === 'content_delta' &&
          typeof m.text === 'string' &&
          m.text.includes('Total cost: $0.0000'),
      ),
    ).toBe(true)
    expect(messages.some((m) => m.type === 'message_complete')).toBe(true)
  })

  it('should display CLI /context local command output', async () => {
    const messages = await runTurn(`chat-context-${crypto.randomUUID()}`, '/context')

    expect(messages.some((m) => m.type === 'error')).toBe(false)
    expect(
      messages.some(
        (m) =>
          m.type === 'content_delta' &&
          typeof m.text === 'string' &&
          m.text.includes('## Context Usage'),
      ),
    ).toBe(true)
    expect(messages.some((m) => m.type === 'message_complete')).toBe(true)
  })

  it('should expose structured session inspection data from the active CLI', async () => {
    const sessionId = `chat-inspection-${crypto.randomUUID()}`
    await runTurn(sessionId, 'hello before inspection')

    const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/inspection`)
    expect(res.status).toBe(200)
    const body = await res.json() as any

    expect(body.active).toBe(true)
    expect(body.status.model).toBe('mock-opus')
    expect(body.status.slashCommandCount).toBe(1)
    expect(body.usage.costDisplay).toBe('$0.1234')
    expect(body.usage.source).toBe('current_process')
    expect(body.context.model).toBe('mock-opus')
    expect(body.context.estimateOnly).toBe(true)
    expect(body.status.mcpServers).toEqual([{ name: 'mock', status: 'connected' }])

    const basicRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/inspection?includeContext=0`)
    expect(basicRes.status).toBe(200)
    const basicBody = await basicRes.json() as any
    expect(basicBody.usage.source).toBe('current_process')
    expect(basicBody.context).toBeUndefined()
  })

  it('should expose context-only inspection without waiting on mcp status', async () => {
    await withMockMcpStatusDelay(2_000, async () => {
      const sessionId = `chat-context-only-${crypto.randomUUID()}`
      await runTurn(sessionId, 'hello before context-only inspection')

      const startedAt = performance.now()
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/inspection?includeContext=1&contextOnly=1`)
      const elapsedMs = performance.now() - startedAt
      expect(res.status).toBe(200)
      const body = await res.json() as any

      expect(body.context.model).toBe('mock-opus')
      expect(body.context.estimateOnly).toBe(true)
      expect(body.usage).toBeUndefined()
      expect(elapsedMs).toBeLessThan(1_500)
    })
  })

  it('should return initial context for a prewarmed empty session on the first inspection request', async () => {
    await withMockInitDelay(500, async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir: process.cwd() }),
      })
      expect(createRes.status).toBe(201)
      const { sessionId } = await createRes.json() as { sessionId: string }
      const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)

      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.close()
            reject(new Error(`Timed out waiting for prewarm connection for ${sessionId}`))
          }, 5_000)

          ws.onmessage = (event) => {
            const msg = JSON.parse(event.data as string)
            if (msg.type === 'connected') {
              clearTimeout(timeout)
              ws.send(JSON.stringify({ type: 'prewarm_session' }))
              resolve()
            }
          }

          ws.onerror = () => {
            clearTimeout(timeout)
            ws.close()
            reject(new Error(`WebSocket error for prewarm context session ${sessionId}`))
          }
        })

        await waitUntil(
          () => conversationService.hasSession(sessionId),
          `prewarmed CLI process for ${sessionId}`,
        )

        const startedAt = performance.now()
        const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/inspection?includeContext=1&contextOnly=1`)
        const elapsedMs = performance.now() - startedAt
        expect(res.status).toBe(200)
        const body = await res.json() as any

        expect(body.context.model).toBe('mock-opus')
        expect(body.context.totalTokens).toBeGreaterThan(0)
        expect(body.context.percentage).toBe(13)
        expect(body.context.categories.some((category: any) => category.name === 'System prompt')).toBe(true)
        expect(body.errors).toEqual({})
        expect(elapsedMs).toBeLessThan(2_000)
      } finally {
        ws.close()
        conversationService.stopSession(sessionId)
      }
    })
  }, 10_000)

  it('should complete the client turn when the CLI exits after startup', async () => {
    const messages = await withMockExitAfterFirstUser(50, () =>
      runTurnUntilComplete(`chat-late-exit-${crypto.randomUUID()}`, 'trigger late exit'),
    )

    expect(
      messages.some(
        (m) =>
          m.type === 'error' &&
          m.code === 'CLI_ERROR' &&
          typeof m.message === 'string' &&
          m.message.includes('CLI process exited unexpectedly'),
      ),
    ).toBe(true)
    expect(messages.some((m) => m.type === 'message_complete')).toBe(true)
    expect(messages.at(-1)?.type).toBe('message_complete')
  }, 15_000)

  it('should not duplicate SDK API errors with the final error result', async () => {
    const messages = await runTurnUntilComplete(
      `chat-api-error-${crypto.randomUUID()}`,
      'trigger api error',
    )

    const errors = messages.filter((m) => m.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      code: 'invalid_request',
      message: 'Prompt is too long',
    })
    expect(messages.some((m) => m.type === 'message_complete')).toBe(true)
    expect(messages.at(-1)?.type).toBe('message_complete')
  }, 15_000)

  it('should not add a CLI exit error after a reported SDK API error', async () => {
    const messages = await runTurnUntilComplete(
      `chat-api-error-exit-${crypto.randomUUID()}`,
      'trigger api error then exit',
    )

    const errors = messages.filter((m) => m.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      code: 'invalid_request',
      message: 'Prompt is too long',
    })
    expect(messages.some((m) => m.type === 'message_complete')).toBe(true)
    expect(messages.at(-1)?.type).toBe('message_complete')
  }, 15_000)

  it('should handle permission_response without error', async () => {
    const messages: any[] = []
    const ws = new WebSocket(`${wsUrl}/ws/chat-test-4`)

    await new Promise<void>((resolve) => {
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data as string)
        messages.push(msg)
        if (msg.type === 'connected') {
          // Send a permission response (no active session, should not crash)
          ws.send(
            JSON.stringify({
              type: 'permission_response',
              requestId: 'test-req-1',
              allowed: true,
            })
          )
          // Give a moment then close
          setTimeout(() => {
            ws.close()
            resolve()
          }, 500)
        }
      }
      ws.onerror = () => {
        ws.close()
        resolve()
      }
      setTimeout(() => {
        ws.close()
        resolve()
      }, 3000)
    })

    // Should have received connected and no error
    expect(messages[0].type).toBe('connected')
    expect(messages.some((m) => m.type === 'error')).toBe(false)
  })

  it('should handle ping/pong', async () => {
    const messages: any[] = []
    const ws = new WebSocket(`${wsUrl}/ws/chat-test-5`)

    await new Promise<void>((resolve) => {
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data as string)
        messages.push(msg)
        if (msg.type === 'connected') {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
        if (msg.type === 'pong') {
          ws.close()
          resolve()
        }
      }
      ws.onerror = () => {
        ws.close()
        resolve()
      }
      setTimeout(() => {
        ws.close()
        resolve()
      }, 3000)
    })

    expect(messages.some((m) => m.type === 'pong')).toBe(true)
  })

  it('should start a placeholder REST session and continue it on a later reconnect', async () => {
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd() }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json() as { sessionId: string }

    const firstTurn = await runTurn(sessionId, 'reply with first')
    expect(firstTurn.some((m) => m.type === 'message_complete')).toBe(true)
    expect(firstTurn.some((m) => m.type === 'error')).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 1000))

    const secondTurn = await runTurn(sessionId, 'reply with second')
    expect(secondTurn.some((m) => m.type === 'message_complete')).toBe(true)
    expect(secondTurn.some((m) => m.type === 'error')).toBe(false)
  })

  it('should keep a long desktop session alive in a /tmp project across engineering turns', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-haha-issue247-project-'))
    let sessionId: string | undefined

    try {
      await fs.writeFile(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'issue-247-repro', type: 'module' }, null, 2),
      )
      await fs.mkdir(path.join(projectDir, 'src'), { recursive: true })
      await fs.writeFile(
        path.join(projectDir, 'src', 'index.ts'),
        'export function greet(name: string) { return `hello ${name}` }\n',
      )

      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir: projectDir }),
      })
      expect(createRes.status).toBe(201)
      ;({ sessionId } = await createRes.json() as { sessionId: string })

      const prompts = [
        'Inspect this TypeScript project and summarize what you see.',
        'Plan a small change to add a farewell helper.',
        'Implement the helper in src/index.ts.',
        'Review whether the exported functions are easy to test.',
        'Suggest the next regression test for this project.',
      ]

      for (const prompt of prompts) {
        const messages = await runTurn(sessionId, prompt)
        expect(messages.some((m) => m.type === 'error')).toBe(false)
        expect(messages.some((m) => m.type === 'message_complete')).toBe(true)
      }
    } finally {
      if (sessionId) {
        await conversationService.stopSession(sessionId)
      }
      await rmWithRetry(projectDir)
    }
  }, 20_000)

  it('should clear a desktop session without sending /clear to the CLI turn loop', async () => {
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd() }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json() as { sessionId: string }

    const firstTurn = await runTurn(sessionId, 'message before clear')
    expect(firstTurn.some((m) => m.type === 'message_complete')).toBe(true)

    const clearTurn = await runTurn(sessionId, '/clear')
    expect(
      clearTurn.some(
        (m) => m.type === 'system_notification' && m.subtype === 'session_cleared',
      ),
    ).toBe(true)
    expect(clearTurn.some((m) => m.type === 'content_delta')).toBe(false)

    const messagesRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`)
    expect(messagesRes.status).toBe(200)
    const body = await messagesRes.json() as { messages: unknown[] }
    expect(body.messages).toEqual([])
  })

  it('should reject /clear arguments without clearing the desktop session', async () => {
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd() }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json() as { sessionId: string }

    await runTurn(sessionId, 'message before invalid clear')

    const clearTurn = await runTurn(sessionId, '/clear please keep this', true)
    expect(
      clearTurn.some(
        (m) => m.type === 'error' && m.code === 'INVALID_SLASH_COMMAND_ARGS',
      ),
    ).toBe(true)
    expect(
      clearTurn.some(
        (m) => m.type === 'system_notification' && m.subtype === 'session_cleared',
      ),
    ).toBe(false)

    const nextTurn = await runTurn(sessionId, 'message after invalid clear')
    expect(nextTurn.some((m) => m.type === 'message_complete')).toBe(true)
  })

  it('should include desktop service diagnostics when CLI startup fails', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-startup-missing-workdir-'))
    const canonicalWorkDir = await fs.realpath(workDir)
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json() as { sessionId: string }

    await fs.rm(workDir, { recursive: true, force: true })

    const messages = await runTurn(sessionId, 'trigger startup diagnostics', true)
    const error = messages.find((msg) => msg.type === 'error')

    expect(error).toMatchObject({
      code: 'WORKDIR_INVALID',
    })
    expect(error?.message).toContain('Desktop service diagnostics:')
    expect(error?.message).toContain(`sessionId: ${sessionId}`)
    expect(error?.message).toContain(`workDir: ${canonicalWorkDir}`)
    expect(error?.message).toContain('runtimeOverride: (none)')
    expect(error?.message).toContain('activeProviderId:')
    expect(error?.message).toContain('configuredProviders:')
  })

  it('should include CLI stdout diagnostics when startup exits before SDK messages', async () => {
    const sessionId = `chat-startup-stdout-${crypto.randomUUID()}`

    const messages = await withMockStartupStdoutExit(
      'provider rejected request: invalid model id',
      25,
      () => runTurn(sessionId, 'trigger startup stdout diagnostics', true),
    )
    const error = messages.find((msg) => msg.type === 'error')

    expect(error).toMatchObject({
      code: 'CLI_START_FAILED',
    })
    expect(error?.message).toContain(
      'CLI exited during startup (code 1): provider rejected request: invalid model id',
    )
    expect(error?.message).toContain('Desktop service diagnostics:')
  }, 10_000)

  it('should prewarm the CLI before the first user turn and reuse that process', async () => {
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd() }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json() as { sessionId: string }

    const originalStartSession = conversationService.startSession.bind(conversationService)
    const startCalls: Array<{ sessionId: string }> = []

    conversationService.startSession = (async function patchedStartSession(
      sid: string,
      workDir: string,
      sdkUrl: string,
      options?: { permissionMode?: string; model?: string; effort?: string; thinking?: 'enabled' | 'adaptive' | 'disabled'; providerId?: string | null },
    ) {
      startCalls.push({ sessionId: sid })
      return originalStartSession(sid, workDir, sdkUrl, options)
    }) as typeof conversationService.startSession

    const messages: any[] = []
    const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
    let connected = false
    let awaitingCompletion = false
    let preUserMessageCount = 0
    let resolveCompletion: (() => void) | null = null
    let rejectCompletion: ((err: Error) => void) | null = null

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for prewarm connection for session ${sessionId}`))
        }, 5000)

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string)
          messages.push(msg)

          if (msg.type === 'connected' && !connected) {
            connected = true
            clearTimeout(timeout)
            ws.send(JSON.stringify({ type: 'prewarm_session' }))
            resolve()
            return
          }

          if (msg.type === 'error') {
            const err = new Error(msg.message)
            clearTimeout(timeout)
            rejectCompletion?.(err)
            reject(err)
            return
          }

          if (awaitingCompletion && msg.type === 'message_complete') {
            resolveCompletion?.()
          }
        }

        ws.onerror = () => {
          const err = new Error(`WebSocket error for prewarm session ${sessionId}`)
          clearTimeout(timeout)
          rejectCompletion?.(err)
          reject(err)
        }
      })

      await waitUntil(
        () => startCalls.length === 1 && conversationService.hasSession(sessionId),
        `prewarmed CLI process for ${sessionId}`,
      )
      await waitUntil(async () => {
        const commandsRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/slash-commands`)
        if (!commandsRes.ok) return false
        const { commands } = await commandsRes.json() as { commands?: Array<{ name: string }> }
        if (!Array.isArray(commands)) return false
        return commands.some((command) => command.name === 'help')
      }, `prewarmed slash commands for ${sessionId}`)

      preUserMessageCount = messages.length
      expect(
        messages
          .slice(0, preUserMessageCount)
          .some((msg) => ['content_start', 'content_delta', 'thinking', 'message_complete'].includes(msg.type)),
      ).toBe(false)

      awaitingCompletion = true
      const completion = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for completion after prewarm for session ${sessionId}`))
        }, 10_000)
        resolveCompletion = () => {
          clearTimeout(timeout)
          resolve()
        }
        rejectCompletion = (err) => {
          clearTimeout(timeout)
          reject(err)
        }
      })

      ws.send(JSON.stringify({ type: 'user_message', content: 'first turn after prewarm' }))
      await completion

      expect(startCalls).toHaveLength(1)
      expect(messages.some((msg) => msg.type === 'content_delta')).toBe(true)
      expect(messages.some((msg) => msg.type === 'message_complete')).toBe(true)
      expect(messages.some((msg) => msg.type === 'error')).toBe(false)
    } finally {
      ws.close()
      conversationService.startSession = originalStartSession
      conversationService.stopSession(sessionId)
    }
  }, 20_000)

  it('should pass the active provider id into default desktop sessions', async () => {
    const providerService = new ProviderService()
    const provider = await providerService.addProvider({
      presetId: 'jiekouai',
      name: 'Active Default Provider',
      apiKey: 'key-active-default',
      baseUrl: 'https://api.jiekou.ai/anthropic',
      apiFormat: 'anthropic',
      models: {
        main: 'active-main',
        haiku: 'active-haiku',
        sonnet: 'active-sonnet',
        opus: 'active-opus',
      },
    })
    await providerService.activateProvider(provider.id)

    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd() }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json() as { sessionId: string }

    const originalStartSession = conversationService.startSession.bind(conversationService)
    const startCalls: Array<{
      sessionId: string
      options: { permissionMode?: string; model?: string; effort?: string; providerId?: string | null } | undefined
    }> = []

    conversationService.startSession = (async function patchedStartSession(
      sid: string,
      workDir: string,
      sdkUrl: string,
      options?: { permissionMode?: string; model?: string; effort?: string; thinking?: 'enabled' | 'adaptive' | 'disabled'; providerId?: string | null },
    ) {
      startCalls.push({ sessionId: sid, options })
      return originalStartSession(sid, workDir, sdkUrl, options)
    }) as typeof conversationService.startSession

    try {
      const messages = await runTurn(sessionId, 'first turn with active provider')
      expect(messages.some((msg) => msg.type === 'message_complete')).toBe(true)
      expect(startCalls).toHaveLength(1)
      expect(startCalls[0]).toMatchObject({
        sessionId,
        options: {
          providerId: provider.id,
        },
      })
    } finally {
      conversationService.startSession = originalStartSession
      conversationService.stopSession(sessionId)
      await providerService.activateOfficial()
    }
  }, 20_000)

  it('should isolate provider runtime overrides across parallel sessions', async () => {
    const providerService = new ProviderService()
    const providerA = await providerService.addProvider({
      presetId: 'custom',
      name: 'Parallel Provider A',
      apiKey: 'key-parallel-a',
      baseUrl: 'http://127.0.0.1:1/anthropic',
      apiFormat: 'anthropic',
      models: {
        main: 'parallel-a-main',
        haiku: 'parallel-a-haiku',
        sonnet: 'parallel-a-sonnet',
        opus: 'parallel-a-opus',
      },
    })
    const providerB = await providerService.addProvider({
      presetId: 'custom',
      name: 'Parallel Provider B',
      apiKey: 'key-parallel-b',
      baseUrl: 'http://127.0.0.1:1/anthropic',
      apiFormat: 'anthropic',
      models: {
        main: 'parallel-b-main',
        haiku: 'parallel-b-haiku',
        sonnet: 'parallel-b-sonnet',
        opus: 'parallel-b-opus',
      },
    })

    const createSession = async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir: process.cwd() }),
      })
      expect(createRes.status).toBe(201)
      const { sessionId } = await createRes.json() as { sessionId: string }
      return sessionId
    }
    const [sessionA, sessionB] = await Promise.all([createSession(), createSession()])

    const originalStartSession = conversationService.startSession.bind(conversationService)
    const startCalls: Array<{
      sessionId: string
      options: { permissionMode?: string; model?: string; effort?: string; providerId?: string | null } | undefined
    }> = []

    conversationService.startSession = (async function patchedStartSession(
      sid: string,
      workDir: string,
      sdkUrl: string,
      options?: { permissionMode?: string; model?: string; effort?: string; thinking?: 'enabled' | 'adaptive' | 'disabled'; providerId?: string | null },
    ) {
      startCalls.push({ sessionId: sid, options })
      return originalStartSession(sid, workDir, sdkUrl, options)
    }) as typeof conversationService.startSession

    const runRuntimeTurn = (
      sessionId: string,
      providerId: string,
      modelId: string,
      content: string,
    ) => new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error(`Timed out waiting for parallel runtime turn for ${sessionId}`))
      }, 10_000)

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string)
        if (msg.type === 'connected') {
          ws.send(JSON.stringify({
            type: 'set_runtime_config',
            providerId,
            modelId,
          }))
          ws.send(JSON.stringify({ type: 'user_message', content }))
          return
        }
        if (msg.type === 'error') {
          clearTimeout(timeout)
          ws.close()
          reject(new Error(msg.message))
          return
        }
        if (msg.type === 'message_complete') {
          clearTimeout(timeout)
          ws.close()
          resolve()
        }
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error(`WebSocket error for parallel runtime session ${sessionId}`))
      }
    })

    try {
      await Promise.all([
        runRuntimeTurn(sessionA, providerA.id, 'parallel-a-sonnet', 'turn on provider a'),
        runRuntimeTurn(sessionB, providerB.id, 'parallel-b-opus', 'turn on provider b'),
      ])

      expect(startCalls).toHaveLength(2)
      expect(startCalls.find((call) => call.sessionId === sessionA)).toMatchObject({
        options: {
          providerId: providerA.id,
          model: 'parallel-a-sonnet',
        },
      })
      expect(startCalls.find((call) => call.sessionId === sessionB)).toMatchObject({
        options: {
          providerId: providerB.id,
          model: 'parallel-b-opus',
        },
      })
    } finally {
      conversationService.startSession = originalStartSession
      conversationService.stopSession(sessionA)
      conversationService.stopSession(sessionB)
    }
  }, 20_000)

  it('should restart a prewarm that began before runtime config arrived', async () => {
    const providerService = new ProviderService()
    const provider = await providerService.addProvider({
      presetId: 'custom',
      name: 'Provider Late Runtime',
      apiKey: 'key-late-runtime',
      baseUrl: 'http://127.0.0.1:1/anthropic',
      apiFormat: 'anthropic',
      models: {
        main: 'late-main',
        haiku: 'late-haiku',
        sonnet: 'late-sonnet',
        opus: 'late-opus',
      },
    })

    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd() }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json() as { sessionId: string }

    const originalStartSession = conversationService.startSession.bind(conversationService)
    const startCalls: Array<{
      sessionId: string
      options: { permissionMode?: string; model?: string; effort?: string; providerId?: string | null } | undefined
    }> = []
    let releaseFirstStart!: () => void
    const firstStartGate = new Promise<void>((resolve) => {
      releaseFirstStart = resolve
    })
    let markFirstStart!: () => void
    const firstStartEntered = new Promise<void>((resolve) => {
      markFirstStart = resolve
    })

    conversationService.startSession = (async function patchedStartSession(
      sid: string,
      workDir: string,
      sdkUrl: string,
      options?: { permissionMode?: string; model?: string; effort?: string; thinking?: 'enabled' | 'adaptive' | 'disabled'; providerId?: string | null },
    ) {
      startCalls.push({ sessionId: sid, options })
      if (startCalls.length === 1) {
        markFirstStart()
        await firstStartGate
      }
      return originalStartSession(sid, workDir, sdkUrl, options)
    }) as typeof conversationService.startSession

    const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
    const messages: any[] = []
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for late runtime prewarm connection for session ${sessionId}`))
        }, 5000)
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string)
          messages.push(msg)
          if (msg.type === 'connected') {
            clearTimeout(timeout)
            resolve()
          }
          if (msg.type === 'error') {
            clearTimeout(timeout)
            reject(new Error(msg.message))
          }
        }
        ws.onerror = () => {
          clearTimeout(timeout)
          reject(new Error(`WebSocket error for late runtime prewarm session ${sessionId}`))
        }
      })

      ws.send(JSON.stringify({ type: 'prewarm_session' }))
      await firstStartEntered

      ws.send(JSON.stringify({
        type: 'set_runtime_config',
        providerId: provider.id,
        modelId: 'late-sonnet',
      }))
      releaseFirstStart()

      await waitUntil(async () => startCalls.length >= 2, `runtime restart for ${sessionId}`)
      await waitUntil(
        async () => messages.some((msg) => msg.type === 'status' && msg.state === 'idle'),
        `runtime restart idle status for ${sessionId}`,
      )

      expect(startCalls[0]).toMatchObject({ sessionId })
      expect(startCalls[0]?.options?.providerId).toBeNull()
      expect(startCalls[1]).toMatchObject({
        sessionId,
        options: {
          providerId: provider.id,
          model: 'late-sonnet',
        },
      })
    } finally {
      ws.close()
      conversationService.startSession = originalStartSession
      conversationService.stopSession(sessionId)
    }
  }, 20_000)

  it('should wait for a runtime restart queued during first-turn startup before sending that turn', async () => {
    const providerService = new ProviderService()
    const provider = await providerService.addProvider({
      presetId: 'custom',
      name: 'Provider First Turn Runtime',
      apiKey: 'key-first-turn-runtime',
      baseUrl: 'http://127.0.0.1:1/anthropic',
      apiFormat: 'anthropic',
      models: {
        main: 'first-turn-main',
        haiku: 'first-turn-haiku',
        sonnet: 'first-turn-sonnet',
        opus: 'first-turn-opus',
      },
    })

    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd() }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json() as { sessionId: string }

    const originalStartSession = conversationService.startSession.bind(conversationService)
    const originalSendMessage = conversationService.sendMessage.bind(conversationService)
    const startCalls: Array<{
      sessionId: string
      options: { permissionMode?: string; model?: string; effort?: string; providerId?: string | null } | undefined
    }> = []
    const sendCalls: Array<{ content: string; startCallCount: number }> = []
    let releaseFirstStart!: () => void
    const firstStartGate = new Promise<void>((resolve) => {
      releaseFirstStart = resolve
    })
    let markFirstStart!: () => void
    const firstStartEntered = new Promise<void>((resolve) => {
      markFirstStart = resolve
    })

    conversationService.startSession = (async function patchedStartSession(
      sid: string,
      workDir: string,
      sdkUrl: string,
      options?: { permissionMode?: string; model?: string; effort?: string; thinking?: 'enabled' | 'adaptive' | 'disabled'; providerId?: string | null },
    ) {
      startCalls.push({ sessionId: sid, options })
      if (startCalls.length === 1) {
        markFirstStart()
        await firstStartGate
      }
      return originalStartSession(sid, workDir, sdkUrl, options)
    }) as typeof conversationService.startSession

    conversationService.sendMessage = (function patchedSendMessage(
      sid: string,
      content: string,
      attachments?: any,
    ) {
      sendCalls.push({ content, startCallCount: startCalls.length })
      return originalSendMessage(sid, content, attachments)
    }) as typeof conversationService.sendMessage

    const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
    const messages: any[] = []
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for first-turn runtime synchronization for session ${sessionId}`))
        }, 15_000)

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string)
          messages.push(msg)

          if (msg.type === 'connected') {
            ws.send(JSON.stringify({ type: 'prewarm_session' }))
            void firstStartEntered.then(() => {
              ws.send(JSON.stringify({ type: 'user_message', content: 'first turn while runtime changes' }))
              ws.send(JSON.stringify({
                type: 'set_runtime_config',
                providerId: provider.id,
                modelId: 'first-turn-sonnet',
              }))
              releaseFirstStart()
            })
            return
          }

          if (msg.type === 'error') {
            clearTimeout(timeout)
            reject(new Error(msg.message))
            return
          }

          if (msg.type === 'message_complete') {
            clearTimeout(timeout)
            resolve()
          }
        }

        ws.onerror = () => {
          clearTimeout(timeout)
          reject(new Error(`WebSocket error for first-turn runtime synchronization session ${sessionId}`))
        }
      })

      expect(startCalls).toHaveLength(2)
      expect(startCalls[0]).toMatchObject({ sessionId })
      expect(startCalls[0]?.options?.providerId).toBeNull()
      expect(startCalls[1]).toMatchObject({
        sessionId,
        options: {
          providerId: provider.id,
          model: 'first-turn-sonnet',
        },
      })
      expect(sendCalls).toEqual([{
        content: 'first turn while runtime changes',
        startCallCount: 2,
      }])
      expect(messages.some((msg) => msg.type === 'content_delta')).toBe(true)
    } finally {
      ws.close()
      conversationService.startSession = originalStartSession
      conversationService.sendMessage = originalSendMessage
      conversationService.stopSession(sessionId)
    }
  }, 20_000)

  it('should keep the session idle in the UI while applying a runtime-only model switch', async () => {
    const providerService = new ProviderService()
    const provider = await providerService.addProvider({
      presetId: 'custom',
      name: 'Provider Idle Runtime',
      apiKey: 'key-idle-runtime',
      baseUrl: 'http://127.0.0.1:1/anthropic',
      apiFormat: 'anthropic',
      models: {
        main: 'idle-main',
        haiku: 'idle-haiku',
        sonnet: 'idle-sonnet',
        opus: 'idle-opus',
      },
    })

    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd() }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json() as { sessionId: string }

    const originalStartSession = conversationService.startSession.bind(conversationService)
    const startCalls: Array<{
      sessionId: string
      options: { permissionMode?: string; model?: string; effort?: string; providerId?: string | null } | undefined
    }> = []

    conversationService.startSession = (async function patchedStartSession(
      sid: string,
      workDir: string,
      sdkUrl: string,
      options?: { permissionMode?: string; model?: string; effort?: string; thinking?: 'enabled' | 'adaptive' | 'disabled'; providerId?: string | null },
    ) {
      startCalls.push({ sessionId: sid, options })
      return originalStartSession(sid, workDir, sdkUrl, options)
    }) as typeof conversationService.startSession

    const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
    const messages: any[] = []
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for idle runtime switch connection for session ${sessionId}`))
        }, 5000)
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string)
          messages.push(msg)
          if (msg.type === 'connected') {
            clearTimeout(timeout)
            ws.send(JSON.stringify({ type: 'prewarm_session' }))
            resolve()
          }
          if (msg.type === 'error') {
            clearTimeout(timeout)
            reject(new Error(msg.message))
          }
        }
        ws.onerror = () => {
          clearTimeout(timeout)
          reject(new Error(`WebSocket error for idle runtime switch session ${sessionId}`))
        }
      })

      await waitUntil(
        () => startCalls.length === 1 && conversationService.hasSession(sessionId),
        `prewarmed CLI process for idle runtime switch ${sessionId}`,
      )
      await waitUntil(async () => {
        const commandsRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/slash-commands`)
        if (!commandsRes.ok) return false
        const { commands } = await commandsRes.json() as { commands?: Array<{ name: string }> }
        return Array.isArray(commands) && commands.some((command) => command.name === 'help')
      }, `prewarmed slash commands for idle runtime switch ${sessionId}`)

      const switchStartIndex = messages.length
      ws.send(JSON.stringify({
        type: 'set_runtime_config',
        providerId: provider.id,
        modelId: 'idle-sonnet',
      }))

      await waitUntil(
        async () => messages.slice(switchStartIndex).some((msg) => msg.type === 'status' && msg.state === 'idle'),
        `idle runtime switch completion for ${sessionId}`,
      )

      expect(startCalls).toHaveLength(2)
      expect(startCalls[1]).toMatchObject({
        sessionId,
        options: {
          providerId: provider.id,
          model: 'idle-sonnet',
        },
      })
      expect(
        messages
          .slice(switchStartIndex)
          .filter((msg) => msg.type === 'status')
          .map((msg) => msg.state),
      ).toEqual(['idle'])
      expect(messages.slice(switchStartIndex).some((msg) => msg.type === 'error')).toBe(false)
    } finally {
      ws.close()
      conversationService.startSession = originalStartSession
      conversationService.stopSession(sessionId)
    }
  }, 20_000)

  it('should keep the session idle in the UI while restarting for a bypass permission switch', async () => {
    await fetch(`${baseUrl}/api/permissions/mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'default' }),
    })

    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd() }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json() as { sessionId: string }

    const originalStartSession = conversationService.startSession.bind(conversationService)
    const startCalls: Array<{
      sessionId: string
      options: { permissionMode?: string; model?: string; effort?: string; providerId?: string | null } | undefined
    }> = []

    conversationService.startSession = (async function patchedStartSession(
      sid: string,
      workDir: string,
      sdkUrl: string,
      options?: { permissionMode?: string; model?: string; effort?: string; thinking?: 'enabled' | 'adaptive' | 'disabled'; providerId?: string | null },
    ) {
      startCalls.push({ sessionId: sid, options })
      return originalStartSession(sid, workDir, sdkUrl, options)
    }) as typeof conversationService.startSession

    const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
    const messages: any[] = []
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for idle permission switch connection for session ${sessionId}`))
        }, 5000)
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string)
          messages.push(msg)
          if (msg.type === 'connected') {
            clearTimeout(timeout)
            ws.send(JSON.stringify({ type: 'prewarm_session' }))
            resolve()
          }
          if (msg.type === 'error') {
            clearTimeout(timeout)
            reject(new Error(msg.message))
          }
        }
        ws.onerror = () => {
          clearTimeout(timeout)
          reject(new Error(`WebSocket error for idle permission switch session ${sessionId}`))
        }
      })

      await waitUntil(
        () => startCalls.length === 1 && conversationService.hasSession(sessionId),
        `prewarmed CLI process for idle permission switch ${sessionId}`,
      )
      await waitUntil(async () => {
        const commandsRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/slash-commands`)
        if (!commandsRes.ok) return false
        const { commands } = await commandsRes.json() as { commands?: Array<{ name: string }> }
        return Array.isArray(commands) && commands.some((command) => command.name === 'help')
      }, `prewarmed slash commands for idle permission switch ${sessionId}`)

      const switchStartIndex = messages.length
      ws.send(JSON.stringify({
        type: 'set_permission_mode',
        mode: 'bypassPermissions',
      }))

      await waitUntil(
        async () => messages.slice(switchStartIndex).some((msg) => msg.type === 'status' && msg.state === 'idle'),
        `idle permission switch completion for ${sessionId}`,
      )

      expect(startCalls).toHaveLength(2)
      expect(startCalls[1]).toMatchObject({
        sessionId,
        options: {
          permissionMode: 'bypassPermissions',
        },
      })
      expect(
        messages
          .slice(switchStartIndex)
          .filter((msg) => msg.type === 'status')
          .map((msg) => msg.state),
      ).toEqual(['idle'])
      expect(messages.slice(switchStartIndex).some((msg) => msg.type === 'error')).toBe(false)
    } finally {
      ws.close()
      conversationService.startSession = originalStartSession
      conversationService.stopSession(sessionId)
      await fetch(`${baseUrl}/api/permissions/mode`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'default' }),
      })
    }
  }, 20_000)

  it('should ignore stale persisted runtime provider ids when resuming old sessions', async () => {
    const providerService = new ProviderService()
    const activeProvider = await providerService.addProvider({
      presetId: 'custom',
      name: 'Current Valid Provider',
      apiKey: 'key-current-valid',
      baseUrl: 'http://127.0.0.1:1/anthropic',
      apiFormat: 'anthropic',
      models: {
        main: 'current-main',
        haiku: 'current-haiku',
        sonnet: 'current-sonnet',
        opus: 'current-opus',
      },
    })
    await providerService.activateProvider(activeProvider.id)

    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd() }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json() as { sessionId: string }

    const staleProviderId = crypto.randomUUID()
    const originalStartSession = conversationService.startSession.bind(conversationService)
    const startCalls: Array<{
      sessionId: string
      options: { permissionMode?: string; model?: string; effort?: string; providerId?: string | null } | undefined
    }> = []

    conversationService.startSession = (async function patchedStartSession(
      sid: string,
      workDir: string,
      sdkUrl: string,
      options?: { permissionMode?: string; model?: string; effort?: string; thinking?: 'enabled' | 'adaptive' | 'disabled'; providerId?: string | null },
    ) {
      startCalls.push({ sessionId: sid, options })
      return originalStartSession(sid, workDir, sdkUrl, options)
    }) as typeof conversationService.startSession

    const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
    const messages: any[] = []
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close()
          reject(new Error(`Timed out waiting for stale runtime resume for session ${sessionId}`))
        }, 10_000)

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string)
          messages.push(msg)

          if (msg.type === 'connected') {
            ws.send(JSON.stringify({
              type: 'set_runtime_config',
              providerId: staleProviderId,
              modelId: 'stale-model',
            }))
            ws.send(JSON.stringify({ type: 'user_message', content: 'resume old session' }))
            return
          }

          if (msg.type === 'error') {
            clearTimeout(timeout)
            ws.close()
            reject(new Error(msg.message))
            return
          }

          if (msg.type === 'message_complete') {
            clearTimeout(timeout)
            ws.close()
            resolve()
          }
        }

        ws.onerror = () => {
          clearTimeout(timeout)
          reject(new Error(`WebSocket error for stale runtime resume session ${sessionId}`))
        }
      })

      expect(startCalls).toHaveLength(1)
      expect(startCalls[0]).toMatchObject({
        sessionId,
        options: {
          providerId: activeProvider.id,
        },
      })
      expect(startCalls[0]?.options?.model).not.toBe('stale-model')
      expect(messages.some((msg) => msg.type === 'message_complete')).toBe(true)
    } finally {
      ws.close()
      conversationService.startSession = originalStartSession
      conversationService.stopSession(sessionId)
      await providerService.activateOfficial()
    }
  }, 20_000)

  it('should resume streaming to a reconnected client during an active turn', async () => {
    await withMockStreamDelay(150, async () => {
      const sessionId = `chat-reconnect-${crypto.randomUUID()}`
      const firstMessages: any[] = []
      const secondMessages: any[] = []

      await new Promise<void>((resolve, reject) => {
        let reconnected = false
        let ws2: WebSocket | null = null
        const timeout = setTimeout(() => {
          ws2?.close()
          reject(new Error(`Timed out waiting for reconnect completion for session ${sessionId}`))
        }, 10_000)

        const cleanup = () => {
          clearTimeout(timeout)
          ws2?.close()
          resolve()
        }

        const handleFailure = (message: string) => {
          clearTimeout(timeout)
          ws2?.close()
          reject(new Error(message))
        }

        const ws1 = new WebSocket(`${wsUrl}/ws/${sessionId}`)
        ws1.onmessage = (event) => {
          const msg = JSON.parse(event.data as string)
          firstMessages.push(msg)

          if (msg.type === 'connected') {
            ws1.send(JSON.stringify({ type: 'user_message', content: 'resume after reconnect' }))
            return
          }

          if (msg.type === 'thinking' && !reconnected) {
            reconnected = true
            ws1.close()

            setTimeout(() => {
              ws2 = new WebSocket(`${wsUrl}/ws/${sessionId}`)
              ws2.onmessage = (reconnectEvent) => {
                const reconnectMsg = JSON.parse(reconnectEvent.data as string)
                secondMessages.push(reconnectMsg)
                if (reconnectMsg.type === 'error') {
                  handleFailure(reconnectMsg.message)
                  return
                }
                if (reconnectMsg.type === 'message_complete') {
                  cleanup()
                }
              }
              ws2.onerror = () => handleFailure(`WebSocket reconnect error for session ${sessionId}`)
            }, 50)
          }
        }

        ws1.onerror = () => handleFailure(`Initial WebSocket error for session ${sessionId}`)
      })

      expect(firstMessages.some((msg) => msg.type === 'thinking')).toBe(true)
      expect(secondMessages.some((msg) => msg.type === 'connected')).toBe(true)
      expect(secondMessages.some((msg) => msg.type === 'content_delta')).toBe(true)
      expect(secondMessages.some((msg) => msg.type === 'message_complete')).toBe(true)
    })
  })

  it('should keep using the selected runtime config across the whole session until changed', async () => {
    const providerService = new ProviderService()
    const providerA = await providerService.addProvider({
      presetId: 'custom',
      name: 'Provider A',
      apiKey: 'key-a',
      baseUrl: 'http://127.0.0.1:1/anthropic',
      apiFormat: 'anthropic',
      models: {
        main: 'model-a-main',
        haiku: 'model-a-haiku',
        sonnet: 'model-a-sonnet',
        opus: 'model-a-opus',
      },
    })
    const providerB = await providerService.addProvider({
      presetId: 'custom',
      name: 'Provider B',
      apiKey: 'key-b',
      baseUrl: 'http://127.0.0.1:1/anthropic',
      apiFormat: 'anthropic',
      models: {
        main: 'model-b-main',
        haiku: 'model-b-haiku',
        sonnet: 'model-b-sonnet',
        opus: 'model-b-opus',
      },
    })

    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd() }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json() as { sessionId: string }

    const originalStartSession = conversationService.startSession.bind(conversationService)
    const startCalls: Array<{
      sessionId: string
      options: { permissionMode?: string; model?: string; effort?: string; providerId?: string | null } | undefined
    }> = []

    conversationService.startSession = (async function patchedStartSession(
      sid: string,
      workDir: string,
      sdkUrl: string,
      options?: { permissionMode?: string; model?: string; effort?: string; thinking?: 'enabled' | 'adaptive' | 'disabled'; providerId?: string | null },
    ) {
      startCalls.push({ sessionId: sid, options })
      return originalStartSession(sid, workDir, sdkUrl, options)
    }) as typeof conversationService.startSession

    try {
      const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
      let phase: 'boot' | 'turn1' | 'switching' | 'turn2' | 'turn3' | 'done' = 'boot'
      let switchingTriggered = false

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close()
          reject(new Error(`Timed out waiting for runtime persistence flow for session ${sessionId}`))
        }, 15_000)

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string)

          if (msg.type === 'connected' && phase === 'boot') {
            ws.send(JSON.stringify({
              type: 'set_runtime_config',
              providerId: providerA.id,
              modelId: 'model-a-sonnet',
            }))
            ws.send(JSON.stringify({ type: 'user_message', content: 'first turn' }))
            phase = 'turn1'
            return
          }

          if (msg.type === 'error') {
            clearTimeout(timeout)
            ws.close()
            reject(new Error(msg.message))
            return
          }

          if (msg.type === 'message_complete' && phase === 'turn1' && !switchingTriggered) {
            switchingTriggered = true
            phase = 'switching'
            ws.send(JSON.stringify({
              type: 'set_runtime_config',
              providerId: providerB.id,
              modelId: 'model-b-opus',
            }))
            return
          }

          if (
            msg.type === 'status' &&
            msg.state === 'idle' &&
            phase === 'switching'
          ) {
            ws.send(JSON.stringify({ type: 'user_message', content: 'second turn' }))
            phase = 'turn2'
            return
          }

          if (msg.type === 'message_complete' && phase === 'turn2') {
            ws.send(JSON.stringify({ type: 'user_message', content: 'third turn' }))
            phase = 'turn3'
            return
          }

          if (msg.type === 'message_complete' && phase === 'turn3') {
            clearTimeout(timeout)
            phase = 'done'
            ws.close()
            resolve()
          }
        }

        ws.onerror = () => {
          reject(new Error(`WebSocket error for runtime persistence session ${sessionId}`))
        }
      })

      expect(startCalls).toHaveLength(2)
      expect(startCalls[0]).toMatchObject({
        sessionId,
        options: {
          providerId: providerA.id,
          model: 'model-a-sonnet',
        },
      })
      expect(startCalls[1]).toMatchObject({
        sessionId,
        options: {
          providerId: providerB.id,
          model: 'model-b-opus',
        },
      })
    } finally {
      conversationService.startSession = originalStartSession
      conversationService.stopSession(sessionId)
    }
  }, 20_000)

  it('should wait for an in-flight runtime restart before sending the next user turn', async () => {
    const providerService = new ProviderService()
    const providerA = await providerService.addProvider({
      presetId: 'custom',
      name: 'Provider Restart A',
      apiKey: 'key-a',
      baseUrl: 'http://127.0.0.1:1/anthropic',
      apiFormat: 'anthropic',
      models: {
        main: 'restart-a-main',
        haiku: 'restart-a-haiku',
        sonnet: 'restart-a-sonnet',
        opus: 'restart-a-opus',
      },
    })
    const providerB = await providerService.addProvider({
      presetId: 'custom',
      name: 'Provider Restart B',
      apiKey: 'key-b',
      baseUrl: 'http://127.0.0.1:1/anthropic',
      apiFormat: 'anthropic',
      models: {
        main: 'restart-b-main',
        haiku: 'restart-b-haiku',
        sonnet: 'restart-b-sonnet',
        opus: 'restart-b-opus',
      },
    })

    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd() }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json() as { sessionId: string }

    const originalStartSession = conversationService.startSession.bind(conversationService)
    const startCalls: Array<{
      sessionId: string
      options: { permissionMode?: string; model?: string; effort?: string; providerId?: string | null } | undefined
    }> = []

    conversationService.startSession = (async function patchedStartSession(
      sid: string,
      workDir: string,
      sdkUrl: string,
      options?: { permissionMode?: string; model?: string; effort?: string; thinking?: 'enabled' | 'adaptive' | 'disabled'; providerId?: string | null },
    ) {
      startCalls.push({ sessionId: sid, options })
      return originalStartSession(sid, workDir, sdkUrl, options)
    }) as typeof conversationService.startSession

    try {
      const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
      let phase: 'boot' | 'turn1' | 'turn2' | 'turn3' | 'done' = 'boot'

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close()
          reject(new Error(`Timed out waiting for runtime restart synchronization flow for session ${sessionId}`))
        }, 15_000)

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string)

          if (msg.type === 'connected' && phase === 'boot') {
            ws.send(JSON.stringify({
              type: 'set_runtime_config',
              providerId: providerA.id,
              modelId: 'restart-a-sonnet',
            }))
            ws.send(JSON.stringify({ type: 'user_message', content: 'first turn' }))
            phase = 'turn1'
            return
          }

          if (msg.type === 'error') {
            clearTimeout(timeout)
            ws.close()
            reject(new Error(msg.message))
            return
          }

          if (msg.type === 'message_complete' && phase === 'turn1') {
            ws.send(JSON.stringify({
              type: 'set_runtime_config',
              providerId: providerB.id,
              modelId: 'restart-b-opus',
            }))
            ws.send(JSON.stringify({ type: 'user_message', content: 'second turn immediately after switch' }))
            phase = 'turn2'
            return
          }

          if (msg.type === 'message_complete' && phase === 'turn2') {
            ws.send(JSON.stringify({ type: 'user_message', content: 'third turn should reuse restarted runtime' }))
            phase = 'turn3'
            return
          }

          if (msg.type === 'message_complete' && phase === 'turn3') {
            clearTimeout(timeout)
            phase = 'done'
            ws.close()
            resolve()
          }
        }

        ws.onerror = () => {
          reject(new Error(`WebSocket error for runtime restart synchronization session ${sessionId}`))
        }
      })

      expect(startCalls).toHaveLength(2)
      expect(startCalls[0]).toMatchObject({
        sessionId,
        options: {
          providerId: providerA.id,
          model: 'restart-a-sonnet',
        },
      })
      expect(startCalls[1]).toMatchObject({
        sessionId,
        options: {
          providerId: providerB.id,
          model: 'restart-b-opus',
        },
      })
    } finally {
      conversationService.startSession = originalStartSession
      conversationService.stopSession(sessionId)
    }
  }, 20_000)

  it('should wait for an in-flight permission restart before sending the next user turn', async () => {
    await fetch(`${baseUrl}/api/permissions/mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'default' }),
    })

    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd() }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json() as { sessionId: string }

    const originalStartSession = conversationService.startSession.bind(conversationService)
    const originalSendMessage = conversationService.sendMessage.bind(conversationService)
    const startCalls: Array<{
      sessionId: string
      options: { permissionMode?: string; model?: string; effort?: string; providerId?: string | null } | undefined
    }> = []
    const sendCalls: Array<{
      content: string
      startCallCount: number
      permissionMode: string
    }> = []

    conversationService.startSession = (async function patchedStartSession(
      sid: string,
      workDir: string,
      sdkUrl: string,
      options?: { permissionMode?: string; model?: string; effort?: string; thinking?: 'enabled' | 'adaptive' | 'disabled'; providerId?: string | null },
    ) {
      startCalls.push({ sessionId: sid, options })
      return originalStartSession(sid, workDir, sdkUrl, options)
    }) as typeof conversationService.startSession

    conversationService.sendMessage = (function patchedSendMessage(
      sid: string,
      content: string,
      attachments?: any,
    ) {
      sendCalls.push({
        content,
        startCallCount: startCalls.length,
        permissionMode: conversationService.getSessionPermissionMode(sid),
      })
      return originalSendMessage(sid, content, attachments)
    }) as typeof conversationService.sendMessage

    try {
      const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
      let phase: 'boot' | 'turn1' | 'turn2' | 'done' = 'boot'

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close()
          reject(new Error(`Timed out waiting for permission restart synchronization flow for session ${sessionId}`))
        }, 15_000)

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string)

          if (msg.type === 'connected' && phase === 'boot') {
            ws.send(JSON.stringify({ type: 'user_message', content: 'first turn before permission switch' }))
            phase = 'turn1'
            return
          }

          if (msg.type === 'error') {
            clearTimeout(timeout)
            ws.close()
            reject(new Error(msg.message))
            return
          }

          if (msg.type === 'message_complete' && phase === 'turn1') {
            ws.send(JSON.stringify({
              type: 'set_permission_mode',
              mode: 'bypassPermissions',
            }))
            ws.send(JSON.stringify({ type: 'user_message', content: 'second turn immediately after permission switch' }))
            phase = 'turn2'
            return
          }

          if (msg.type === 'message_complete' && phase === 'turn2') {
            clearTimeout(timeout)
            phase = 'done'
            ws.close()
            resolve()
          }
        }

        ws.onerror = () => {
          reject(new Error(`WebSocket error for permission restart synchronization session ${sessionId}`))
        }
      })

      expect(startCalls).toHaveLength(2)
      expect(startCalls[0]).toMatchObject({
        sessionId,
        options: {
          permissionMode: 'default',
        },
      })
      expect(startCalls[1]).toMatchObject({
        sessionId,
        options: {
          permissionMode: 'bypassPermissions',
        },
      })
      expect(sendCalls).toMatchObject([
        {
          content: 'first turn before permission switch',
          startCallCount: 1,
          permissionMode: 'default',
        },
        {
          content: 'second turn immediately after permission switch',
          startCallCount: 2,
          permissionMode: 'bypassPermissions',
        },
      ])
    } finally {
      conversationService.startSession = originalStartSession
      conversationService.sendMessage = originalSendMessage
      conversationService.stopSession(sessionId)
      await fetch(`${baseUrl}/api/permissions/mode`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'default' }),
      })
    }
  }, 20_000)
})
