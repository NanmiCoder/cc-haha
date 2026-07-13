/**
 * Tests for ConversationService and WebSocket chat integration
 *
 * ConversationService 管理 CLI 子进程的生命周期。
 * WebSocket 集成测试验证消息从客户端经过服务端到达 CLI 的完整流转。
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ConversationService, ConversationStartupError, conversationService } from '../services/conversationService.js'
import { SessionService, sessionService } from '../services/sessionService.js'
import { ProviderService } from '../services/providerService.js'
import { resetTerminalShellEnvironmentCacheForTests } from '../../utils/terminalShellEnvironment.js'

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

  it('should ignore a stale SDK disconnect after a replacement socket attaches', () => {
    const svc = new ConversationService()
    const sessionId = crypto.randomUUID()
    const firstSocket = { send() {} }
    const replacementSocket = { send() {} }
    const session = {
      sdkSocket: null,
      pendingOutbound: [],
      resolveSdkAttached: null,
    }
    ;(svc as any).sessions.set(sessionId, session)

    svc.attachSdkConnection(sessionId, firstSocket)
    svc.attachSdkConnection(sessionId, replacementSocket)
    svc.detachSdkConnection(sessionId, firstSocket)

    expect(session.sdkSocket).toBe(replacementSocket)
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

  it('should forward explicit permission updates from desktop plan approval', () => {
    const svc = new ConversationService()
    const sent: unknown[] = []
    const permissionUpdates = [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'prompt: run tests' }],
        behavior: 'allow',
        destination: 'session',
      },
    ]

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
      pendingPermissionRequests: new Map(),
    })

    const result = svc.respondToPermission(
      'session-1',
      'req-1',
      true,
      undefined,
      undefined,
      undefined,
      permissionUpdates,
    )

    expect(result).toBe(true)
    expect(sent[0]).toMatchObject({
      type: 'control_response',
      response: {
        response: {
          behavior: 'allow',
          updatedPermissions: permissionUpdates,
        },
      },
    })
  })

  it('should forward explicit denial feedback from desktop plan rejection', () => {
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
      pendingPermissionRequests: new Map(),
    })

    const result = svc.respondToPermission(
      'session-1',
      'req-1',
      false,
      undefined,
      undefined,
      'Add rollback steps before implementation.',
    )

    expect(result).toBe(true)
    expect(sent[0]).toMatchObject({
      type: 'control_response',
      response: {
        response: {
          behavior: 'deny',
          message: 'Add rollback steps before implementation.',
        },
      },
    })
  })

  it('should resolve a permission mode request only after the CLI confirms the change', async () => {
    const svc = new ConversationService()
    const sent: unknown[] = []

    const sessionId = 'session-2'
    ;(svc as any).sessions.set(sessionId, {
      proc: null,
      outputCallbacks: [],
      workDir: process.cwd(),
      permissionMode: 'default',
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

    const change = svc.setPermissionMode(sessionId, 'auto')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'control_request',
      request: {
        subtype: 'set_permission_mode',
        mode: 'auto',
      },
    })
    expect(svc.getSessionPermissionMode(sessionId)).toBe('default')

    const requestId = (sent[0] as { request_id: string }).request_id
    svc.handleSdkPayload(sessionId, `${JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: { mode: 'auto' },
      },
    })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(svc.getSessionPermissionMode(sessionId)).toBe('default')

    svc.handleSdkPayload(sessionId, `${JSON.stringify({
      type: 'system',
      subtype: 'status',
      status: null,
      permissionMode: 'auto',
    })}\n`)

    await expect(change).resolves.toBe(true)
    expect(svc.getSessionPermissionMode(sessionId)).toBe('default')
  })

  it('should preserve the previous permission mode when the CLI rejects the change', async () => {
    const svc = new ConversationService()
    const sent: Array<{ request_id: string }> = []
    const sessionId = 'session-permission-rejected'
    ;(svc as any).sessions.set(sessionId, {
      proc: null,
      outputCallbacks: [],
      workDir: process.cwd(),
      permissionMode: 'default',
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

    const change = svc.setPermissionMode(sessionId, 'auto')
    await new Promise((resolve) => setTimeout(resolve, 0))
    svc.handleSdkPayload(sessionId, `${JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: sent[0]!.request_id,
        error: 'auto mode unavailable',
      },
    })}\n`)

    await expect(change).rejects.toThrow('auto mode unavailable')
    expect(svc.getSessionPermissionMode(sessionId)).toBe('default')
  })

  it('should time out without recording a mode when control succeeds without CLI confirmation', async () => {
    const svc = new ConversationService()
    const sent: Array<{ request_id: string }> = []
    const sessionId = 'session-permission-unconfirmed'
    ;(svc as any).sessions.set(sessionId, {
      proc: null,
      outputCallbacks: [],
      workDir: process.cwd(),
      permissionMode: 'default',
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

    const change = svc.setPermissionMode(sessionId, 'auto', 25)
    await new Promise((resolve) => setTimeout(resolve, 0))
    svc.handleSdkPayload(sessionId, `${JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: sent[0]!.request_id,
        response: { mode: 'auto' },
      },
    })}\n`)

    await expect(change).rejects.toThrow('Timed out waiting for permission mode confirmation')
    expect(svc.getSessionPermissionMode(sessionId)).toBe('default')
  })

  it('should not inject a desktop-specific ask override in default permission mode', () => {
    const svc = new ConversationService()
    expect((svc as any).getPermissionArgs('default', false)).toEqual([
      '--allow-dangerously-skip-permissions',
      '--permission-mode',
      'default',
    ])
  })

  it('should keep an initially requested bypass session explicitly dangerous', () => {
    const svc = new ConversationService()
    expect((svc as any).getPermissionArgs('bypassPermissions', false)).toEqual([
      '--dangerously-skip-permissions',
    ])
    expect((svc as any).getPermissionArgs('default', true)).toEqual([
      '--dangerously-skip-permissions',
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

  it('should keep OpenAI-native reasoning controls out of Claude CLI args', () => {
    const svc = new ConversationService()
    expect((svc as any).getRuntimeArgs({
      providerId: 'openai-official',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      thinking: 'disabled',
    })).toEqual([
      '--model',
      'gpt-5.6-sol',
    ])
  })

  it('should send thinking token controls to active CLI sessions', () => {
    const svc = new ConversationService() as any
    const sent: string[] = []
    svc.sessions.set('session-thinking-control', {
      sdkSocket: { send: (data: string) => sent.push(data) },
      pendingOutbound: [],
    })

    expect(svc.setMaxThinkingTokens('session-thinking-control', 0)).toBe(true)
    expect(svc.setMaxThinkingTokens('session-thinking-control', null)).toBe(true)
    expect(svc.setMaxThinkingTokensForActiveSessions(0)).toBe(1)

    expect(sent.map((line) => JSON.parse(line).request)).toEqual([
      {
        subtype: 'set_max_thinking_tokens',
        max_thinking_tokens: 0,
      },
      {
        subtype: 'set_max_thinking_tokens',
        max_thinking_tokens: null,
      },
      {
        subtype: 'set_max_thinking_tokens',
        max_thinking_tokens: 0,
      },
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

  it('should expose live SDK permission requests for reconnecting clients', () => {
    const svc = new ConversationService()

    ;(svc as any).sessions.set('session-pending-permission', {
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

    ;(svc as any).handleSdkPayload('session-pending-permission', JSON.stringify({
      type: 'control_request',
      request_id: 'request-ask-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'tool-ask-1',
        input: {
          questions: [
            {
              header: 'Scope',
              question: 'Which scope?',
              options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }],
            },
          ],
        },
        description: 'Answer questions?',
      },
    }))

    expect(svc.getPendingPermissionRequests('session-pending-permission')).toEqual([
      {
        requestId: 'request-ask-1',
        toolName: 'AskUserQuestion',
        toolUseId: 'tool-ask-1',
        input: {
          questions: [
            {
              header: 'Scope',
              question: 'Which scope?',
              options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }],
            },
          ],
        },
        description: 'Answer questions?',
      },
    ])
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

  it('should use active provider model context windows for transcript estimates', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousNodeEnv = process.env.NODE_ENV
    const previousModelContextWindows = process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
    const tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-transcript-provider-'))
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workdir-provider-'))
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
    process.env.NODE_ENV = 'development'
    delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS

    try {
      const providerService = new ProviderService()
      const provider = await providerService.addProvider({
        presetId: 'minimax',
        name: 'MiniMax',
        apiKey: 'provider-key',
        authStrategy: 'auth_token',
        baseUrl: 'https://api.minimaxi.com/anthropic',
        apiFormat: 'anthropic',
        models: {
          main: 'MiniMax-M3',
          haiku: 'MiniMax-M3',
          sonnet: 'MiniMax-M3',
          opus: 'MiniMax-M3',
        },
        modelContextWindows: {
          'MiniMax-M3': 1_000_000,
        },
      })
      await providerService.activateProvider(provider.id)

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
          model: 'MiniMax-M3',
          content: [{ type: 'text', text: 'hello' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
        },
      }) + '\n')

      const contextEstimate = await svc.getTranscriptContextEstimate(sessionId)

      expect(contextEstimate?.model).toBe('MiniMax-M3')
      expect(contextEstimate?.rawMaxTokens).toBe(1_000_000)
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
      if (previousModelContextWindows === undefined) {
        delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
      } else {
        process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS = previousModelContextWindows
      }
      await fs.rm(tmpConfigDir, { recursive: true, force: true })
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('should prefer the persisted runtime model when provider responses use aliased model names', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousNodeEnv = process.env.NODE_ENV
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    const previousModelContextWindows = process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
    const tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-transcript-runtime-model-'))
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workdir-runtime-model-'))
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
    process.env.NODE_ENV = 'development'
    process.env.ANTHROPIC_API_KEY = 'test-api-key'
    delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS

    try {
      const providerService = new ProviderService()
      const provider = await providerService.addProvider({
        presetId: 'custom',
        name: 'Aliased Runtime Provider',
        apiKey: 'provider-key',
        authStrategy: 'auth_token',
        baseUrl: 'https://api.example.com/anthropic',
        apiFormat: 'anthropic',
        models: {
          main: 'provider-main',
          haiku: 'provider-fast',
          sonnet: 'provider-sonnet',
          opus: 'provider-opus',
        },
        modelContextWindows: {
          'provider-main': 200_000,
          'provider-fast': 64_000,
        },
      })
      await providerService.activateProvider(provider.id)

      const svc = new SessionService()
      const { sessionId } = await svc.createSession(workDir)
      await svc.appendSessionMetadata(sessionId, {
        workDir,
        runtimeProviderId: provider.id,
        runtimeModelId: 'provider-fast',
      })
      const found = await svc.findSessionFile(sessionId)
      expect(found).not.toBeNull()

      await fs.appendFile(found!.filePath, JSON.stringify({
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-06-15T12:00:00.000Z',
        cwd: workDir,
        version: '999.0.0-test',
        message: {
          role: 'assistant',
          model: 'provider-returned-fast-alias',
          content: [{ type: 'text', text: 'hello' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
        },
      }) + '\n')

      const contextEstimate = await svc.getTranscriptContextEstimate(sessionId)
      const usage = await svc.getTranscriptUsage(sessionId)

      expect(contextEstimate?.model).toBe('provider-returned-fast-alias')
      expect(contextEstimate?.rawMaxTokens).toBe(64_000)
      expect(usage?.models[0]?.contextWindow).toBe(64_000)
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
      if (previousAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey
      }
      if (previousModelContextWindows === undefined) {
        delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
      } else {
        process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS = previousModelContextWindows
      }
      await fs.rm(tmpConfigDir, { recursive: true, force: true })
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('should keep transcript usage context windows tied to runtime metadata order', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousNodeEnv = process.env.NODE_ENV
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    const previousModelContextWindows = process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
    const tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-transcript-runtime-switch-'))
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workdir-runtime-switch-'))
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
    process.env.NODE_ENV = 'development'
    process.env.ANTHROPIC_API_KEY = 'test-api-key'
    delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS

    try {
      const providerService = new ProviderService()
      const provider = await providerService.addProvider({
        presetId: 'custom',
        name: 'Runtime Switch Provider',
        apiKey: 'provider-key',
        authStrategy: 'auth_token',
        baseUrl: 'https://api.example.com/anthropic',
        apiFormat: 'anthropic',
        models: {
          main: 'provider-big',
          haiku: 'provider-fast',
          sonnet: 'provider-big',
          opus: 'provider-big',
        },
        modelContextWindows: {
          'provider-big': 1_000_000,
          'provider-fast': 64_000,
        },
      })
      await providerService.activateProvider(provider.id)

      const svc = new SessionService()
      const { sessionId, workDir: sessionWorkDir } = await svc.createSession(workDir)
      await svc.appendSessionMetadata(sessionId, {
        workDir: sessionWorkDir,
        runtimeProviderId: provider.id,
        runtimeModelId: 'provider-fast',
      })
      const found = await svc.findSessionFile(sessionId)
      expect(found).not.toBeNull()
      await fs.appendFile(found!.filePath, JSON.stringify({
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-06-15T12:00:00.000Z',
        cwd: sessionWorkDir,
        version: '999.0.0-test',
        message: {
          role: 'assistant',
          model: 'provider-returned-fast-alias',
          content: [{ type: 'text', text: 'fast' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
        },
      }) + '\n')
      await svc.appendSessionMetadata(sessionId, {
        workDir: sessionWorkDir,
        runtimeProviderId: provider.id,
        runtimeModelId: 'provider-big',
      })
      await fs.appendFile(found!.filePath, JSON.stringify({
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-06-15T12:01:00.000Z',
        cwd: sessionWorkDir,
        version: '999.0.0-test',
        message: {
          role: 'assistant',
          model: 'provider-returned-big-alias',
          content: [{ type: 'text', text: 'big' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
        },
      }) + '\n')

      const usage = await svc.getTranscriptUsage(sessionId)
      const windows = new Map(usage?.models.map((model) => [model.model, model.contextWindow]))

      expect(windows.get('provider-returned-fast-alias')).toBe(64_000)
      expect(windows.get('provider-returned-big-alias')).toBe(1_000_000)
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
      if (previousAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey
      }
      if (previousModelContextWindows === undefined) {
        delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
      } else {
        process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS = previousModelContextWindows
      }
      await fs.rm(tmpConfigDir, { recursive: true, force: true })
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('should infer a unique saved provider context window for sessions missing runtime metadata', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousNodeEnv = process.env.NODE_ENV
    const previousModelContextWindows = process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
    const tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-transcript-provider-infer-'))
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workdir-provider-infer-'))
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
    process.env.NODE_ENV = 'development'
    delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS

    try {
      const providerService = new ProviderService()
      await providerService.addProvider({
        presetId: 'custom',
        name: 'Xiaomi MiMo',
        apiKey: 'provider-key',
        authStrategy: 'auth_token',
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
        apiFormat: 'anthropic',
        models: {
          main: 'mimo-v2.5-pro[1m]',
          haiku: 'mimo-v2.5-pro[1m]',
          sonnet: 'mimo-v2.5-pro[1m]',
          opus: 'mimo-v2.5-pro[1m]',
        },
        modelContextWindows: {
          'mimo-v2.5-pro[1m]': 1_000_000,
        },
      })
      const activeProvider = await providerService.addProvider({
        presetId: 'custom',
        name: 'Active DeepSeek',
        apiKey: 'provider-key',
        authStrategy: 'auth_token',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiFormat: 'anthropic',
        models: {
          main: 'deepseek-v4-pro',
          haiku: 'deepseek-v4-flash',
          sonnet: 'deepseek-v4-pro',
          opus: 'deepseek-v4-pro',
        },
        modelContextWindows: {
          'deepseek-v4-pro': 1_000_000,
        },
      })
      await providerService.activateProvider(activeProvider.id)

      const svc = new SessionService()
      const { sessionId } = await svc.createSession(workDir)
      const found = await svc.findSessionFile(sessionId)
      expect(found).not.toBeNull()

      await fs.appendFile(found!.filePath, JSON.stringify({
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-06-15T12:00:00.000Z',
        cwd: workDir,
        version: '999.0.0-test',
        message: {
          role: 'assistant',
          model: 'mimo-v2.5-pro',
          content: [{ type: 'text', text: 'hello' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
        },
      }) + '\n')

      const contextEstimate = await svc.getTranscriptContextEstimate(sessionId)

      expect(contextEstimate?.model).toBe('mimo-v2.5-pro')
      expect(contextEstimate?.rawMaxTokens).toBe(1_000_000)
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
      if (previousModelContextWindows === undefined) {
        delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
      } else {
        process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS = previousModelContextWindows
      }
      await fs.rm(tmpConfigDir, { recursive: true, force: true })
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('should not infer saved provider context windows for unrelated response model names', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousNodeEnv = process.env.NODE_ENV
    const previousModelContextWindows = process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
    const tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-transcript-provider-unrelated-'))
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workdir-provider-unrelated-'))
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
    process.env.NODE_ENV = 'development'
    delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS

    try {
      const providerService = new ProviderService()
      await providerService.addProvider({
        presetId: 'custom',
        name: 'Only Saved Provider',
        apiKey: 'provider-key',
        authStrategy: 'auth_token',
        baseUrl: 'https://api.example.com/anthropic',
        apiFormat: 'anthropic',
        models: {
          main: 'configured-provider-main',
          haiku: 'configured-provider-main',
          sonnet: 'configured-provider-main',
          opus: 'configured-provider-main',
        },
        modelContextWindows: {
          'configured-provider-main': 1_000_000,
        },
      })

      const svc = new SessionService()
      const { sessionId } = await svc.createSession(workDir)
      const found = await svc.findSessionFile(sessionId)
      expect(found).not.toBeNull()

      await fs.appendFile(found!.filePath, JSON.stringify({
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-06-15T12:00:00.000Z',
        cwd: workDir,
        version: '999.0.0-test',
        message: {
          role: 'assistant',
          model: 'unrelated-response-model',
          content: [{ type: 'text', text: 'hello' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
        },
      }) + '\n')

      const contextEstimate = await svc.getTranscriptContextEstimate(sessionId)

      expect(contextEstimate?.model).toBe('unrelated-response-model')
      expect(contextEstimate?.rawMaxTokens).toBe(200_000)
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
      if (previousModelContextWindows === undefined) {
        delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
      } else {
        process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS = previousModelContextWindows
      }
      await fs.rm(tmpConfigDir, { recursive: true, force: true })
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('should not report transcript context as full for low-trust media usage spikes', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousNodeEnv = process.env.NODE_ENV
    const previousUseBedrock = process.env.CLAUDE_CODE_USE_BEDROCK
    const tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-transcript-media-'))
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workdir-media-'))
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
    process.env.NODE_ENV = 'development'
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'

    try {
      const svc = new SessionService()
      const { sessionId } = await svc.createSession(workDir)
      const found = await svc.findSessionFile(sessionId)
      expect(found).not.toBeNull()

      await fs.appendFile(found!.filePath, JSON.stringify({
        type: 'user',
        uuid: crypto.randomUUID(),
        timestamp: '2026-04-27T12:00:00.000Z',
        cwd: workDir,
        message: {
          role: 'user',
          content: [{
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'a'.repeat(1024),
            },
          }],
        },
      }) + '\n')
      await fs.appendFile(found!.filePath, JSON.stringify({
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-04-27T12:00:01.000Z',
        cwd: workDir,
        version: '999.0.0-test',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 10,
          },
        },
      }) + '\n')

      const contextEstimate = await svc.getTranscriptContextEstimate(sessionId)

      expect(contextEstimate?.rawMaxTokens).toBe(200_000)
      expect(contextEstimate?.totalTokens).toBeLessThan(200_000)
      expect(contextEstimate?.percentage).toBeLessThan(100)
      expect(contextEstimate?.categories[0]?.name).toBe('Estimated context')
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
      if (previousUseBedrock === undefined) {
        delete process.env.CLAUDE_CODE_USE_BEDROCK
      } else {
        process.env.CLAUDE_CODE_USE_BEDROCK = previousUseBedrock
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

  async function withMockPermissionModeBehavior<T>(
    behavior: 'confirm' | 'reject' | 'acknowledge' | 'status-before-reject' | 'unavailable',
    callback: () => Promise<T>,
  ): Promise<T> {
    const previousBehavior = process.env.MOCK_SDK_PERMISSION_MODE_BEHAVIOR
    process.env.MOCK_SDK_PERMISSION_MODE_BEHAVIOR = behavior
    resetTerminalShellEnvironmentCacheForTests()

    try {
      return await callback()
    } finally {
      if (previousBehavior === undefined) {
        delete process.env.MOCK_SDK_PERMISSION_MODE_BEHAVIOR
      } else {
        process.env.MOCK_SDK_PERMISSION_MODE_BEHAVIOR = previousBehavior
      }
      resetTerminalShellEnvironmentCacheForTests()
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
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-conv-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.CLAUDE_CLI_PATH = fileURLToPath(
      new URL('./fixtures/mock-sdk-cli.ts', import.meta.url)
    )
    await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })

    const { startServer } = await import('../index.js')
    server = startServer(0, '127.0.0.1')
    baseUrl = `http://127.0.0.1:${server.port}`
    wsUrl = `ws://127.0.0.1:${server.port}`
  })

  afterEach(async () => {
    await conversationService.stopAllSessionsAndWait(1_000)
  })

  afterAll(async () => {
    server?.stop(true)
    if (tmpDir) {
      await rmWithRetry(tmpDir)
    }
    if (originalCliPath) {
      process.env.CLAUDE_CLI_PATH = originalCliPath
    } else {
      delete process.env.CLAUDE_CLI_PATH
    }
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
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

  it('does not emit worktree startup status for an already materialized worktree session', async () => {
    const repoDir = await createCleanGitRepo()
    const { sessionId } = await sessionService.createSession(repoDir, {
      branch: 'feature/rail',
      worktree: true,
    })

    const launchInfo = await sessionService.getSessionLaunchInfo(sessionId)
    const worktreePath = launchInfo?.repository?.worktreePath
    expect(worktreePath).toBeTruthy()
    await fs.mkdir(worktreePath!, { recursive: true })
    await sessionService.appendSessionMetadata(sessionId, {
      workDir: worktreePath!,
      repository: launchInfo!.repository,
    })
    await sessionService.deletePlaceholderSessionFiles(sessionId, worktreePath!)

    const messages = await runTurn(sessionId, 'Continue in the existing worktree')
    const statusVerbs = messages
      .filter((msg) => msg.type === 'status')
      .map((msg) => msg.verb)

    expect(statusVerbs).toContain('Thinking')
    expect(statusVerbs).not.toContain('Creating worktree')
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

  it('refreshes the first-turn AI title from the completed assistant transcript', async () => {
    const providerConfigPath = path.join(tmpDir, 'cc-haha', 'providers.json')
    const originalProviderConfig = await fs.readFile(providerConfigPath, 'utf-8').catch(() => null)
    const upstreamInputs: string[] = []
    const titleModelServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const body = await req.json() as {
          messages?: Array<{ content?: unknown }>
        }
        const input = String(body.messages?.[0]?.content ?? '')
        upstreamInputs.push(input)
        const title = input.includes('Echo: 看一下这个搜索结果')
          ? 'Google 搜索企查查结果'
          : 'Premature user title'
        return Response.json({
          content: [{ type: 'text', text: JSON.stringify({ title }) }],
        })
      },
    })

    try {
      await fs.mkdir(path.dirname(providerConfigPath), { recursive: true })
      await fs.writeFile(
        providerConfigPath,
        JSON.stringify({
          activeId: 'title-transcript-provider',
          providers: [
            {
              id: 'title-transcript-provider',
              presetId: 'minimax',
              name: 'Title Transcript Provider',
              apiKey: 'test-key',
              baseUrl: `http://127.0.0.1:${titleModelServer.port}/anthropic`,
              apiFormat: 'anthropic',
              models: {
                main: 'minimax-main',
                haiku: 'minimax-haiku',
                sonnet: 'minimax-main',
                opus: 'minimax-main',
              },
            },
          ],
        }, null, 2),
        'utf-8',
      )

      const sessionId = `title-transcript-${crypto.randomUUID()}`
      const messages: any[] = []
      const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close()
          reject(new Error('Timed out waiting for transcript-backed session title'))
        }, 8000)

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string)
          messages.push(msg)
          if (msg.type === 'connected') {
            ws.send(JSON.stringify({
              type: 'user_message',
              content: '看一下这个搜索结果，请一条一条给我列出来',
            }))
            return
          }
          if (msg.type === 'session_title_updated' && msg.title === 'Google 搜索企查查结果') {
            clearTimeout(timeout)
            ws.close()
            resolve()
          }
          if (msg.type === 'error') {
            clearTimeout(timeout)
            ws.close()
            reject(new Error(msg.message))
          }
        }
        ws.onerror = () => {
          clearTimeout(timeout)
          reject(new Error(`WebSocket error for title transcript session ${sessionId}`))
        }
      })

      const titleMessages = messages.filter((msg) => msg.type === 'session_title_updated')
      expect(titleMessages[0]?.title).toBe('看一下这个搜索结果，请一条一条给我列出来')
      expect(titleMessages.map((msg) => msg.title)).toContain('Google 搜索企查查结果')
      expect(upstreamInputs.some((input) => input.includes('Echo: 看一下这个搜索结果'))).toBe(true)
      expect(upstreamInputs.some((input) => input.includes('Return the title in Chinese.'))).toBe(true)
    } finally {
      titleModelServer.stop(true)
      if (originalProviderConfig === null) {
        await fs.rm(providerConfigPath, { force: true })
      } else {
        await fs.writeFile(providerConfigPath, originalProviderConfig, 'utf-8')
      }
    }
  }, 10000)

  it('uses the /goal objective for the derived session title', async () => {
    const sessionId = `title-goal-${crypto.randomUUID()}`
    const messages: any[] = []
    const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('Timed out waiting for goal title'))
      }, 5000)

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string)
        messages.push(msg)
        if (msg.type === 'connected') {
          ws.send(JSON.stringify({
            type: 'user_message',
            content: '/goal ship the desktop goal card',
          }))
          return
        }
        if (msg.type === 'session_title_updated') {
          clearTimeout(timeout)
          ws.close()
          resolve()
        }
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error(`WebSocket error for goal title session ${sessionId}`))
      }
    })

    const title = messages.find((msg) => msg.type === 'session_title_updated')?.title
    expect(title).toBe('ship the desktop goal card')
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

  it('should let the global Thinking setting control DeepSeek desktop sessions', async () => {
    const providerService = new ProviderService()
    const provider = await providerService.addProvider({
      presetId: 'deepseek',
      name: 'DeepSeek Thinking Toggle',
      apiKey: 'key-deepseek-toggle',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiFormat: 'anthropic',
      models: {
        main: 'deepseek-v4-pro',
        haiku: 'deepseek-v4-flash',
        sonnet: 'deepseek-v4-pro',
        opus: 'deepseek-v4-pro',
      },
    })
    await providerService.activateProvider(provider.id)

    const originalStartSession = conversationService.startSession.bind(conversationService)
    const startOptions: Array<{
      sessionId: string
      thinking?: string
      providerId?: string | null
    }> = []
    const sessionIds: string[] = []

    conversationService.startSession = (async function patchedStartSession(
      sid: string,
      workDir: string,
      sdkUrl: string,
      options?: { permissionMode?: string; model?: string; effort?: string; thinking?: 'enabled' | 'adaptive' | 'disabled'; providerId?: string | null },
    ) {
      if (sessionIds.includes(sid)) {
        startOptions.push({
          sessionId: sid,
          thinking: options?.thinking,
          providerId: options?.providerId,
        })
      }
      return originalStartSession(sid, workDir, sdkUrl, options)
    }) as typeof conversationService.startSession

    try {
      const disabledSessionId = `ds-think-off-${crypto.randomUUID()}`
      sessionIds.push(disabledSessionId)
      await fs.writeFile(
        path.join(tmpDir, 'settings.json'),
        JSON.stringify({ alwaysThinkingEnabled: false }, null, 2),
        'utf-8',
      )
      const disabledMessages = await runTurn(disabledSessionId, 'DeepSeek with global thinking off')
      expect(disabledMessages.some((m) => m.type === 'message_complete')).toBe(true)

      const enabledSessionId = `ds-think-on-${crypto.randomUUID()}`
      sessionIds.push(enabledSessionId)
      await fs.writeFile(
        path.join(tmpDir, 'settings.json'),
        JSON.stringify({ alwaysThinkingEnabled: true }, null, 2),
        'utf-8',
      )
      const enabledMessages = await runTurn(enabledSessionId, 'DeepSeek with global thinking on')
      expect(enabledMessages.some((m) => m.type === 'message_complete')).toBe(true)

      expect(startOptions).toEqual([
        {
          sessionId: disabledSessionId,
          thinking: 'disabled',
          providerId: provider.id,
        },
        {
          sessionId: enabledSessionId,
          thinking: undefined,
          providerId: provider.id,
        },
      ])
    } finally {
      conversationService.startSession = originalStartSession as typeof conversationService.startSession
      for (const sessionId of sessionIds) {
        conversationService.stopSession(sessionId)
      }
      await providerService.activateOfficial()
      await providerService.deleteProvider(provider.id)
      await fs.writeFile(path.join(tmpDir, 'settings.json'), '{}\n', 'utf-8')
    }
  }, 20_000)

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

  it('should avoid transcript scans for active context-only inspection', async () => {
    const usageSpy = spyOn(sessionService, 'getTranscriptUsage')
    const estimateSpy = spyOn(sessionService, 'getTranscriptContextEstimate')
    try {
      const sessionId = `chat-context-only-fast-${crypto.randomUUID()}`
      await runTurn(sessionId, 'hello before fast context-only inspection')

      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/inspection?includeContext=1&contextOnly=1`)
      expect(res.status).toBe(200)
      const body = await res.json() as any

      expect(body.context.model).toBe('mock-opus')
      expect(body.contextEstimate).toBeUndefined()
      expect(body.usage).toBeUndefined()
      expect(usageSpy).not.toHaveBeenCalled()
      expect(estimateSpy).not.toHaveBeenCalled()
    } finally {
      usageSpy.mockRestore()
      estimateSpy.mockRestore()
    }
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
      body: JSON.stringify({ workDir: process.cwd(), permissionMode: 'acceptEdits' }),
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

    const inspectionRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/inspection?includeContext=0`)
    expect(inspectionRes.status).toBe(200)
    const inspection = await inspectionRes.json() as { status?: { permissionMode?: string } }
    expect(inspection.status?.permissionMode).toBe('acceptEdits')
  })

  it('should preserve permission mode when clearing an inactive desktop session', async () => {
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd(), permissionMode: 'acceptEdits' }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json() as { sessionId: string }
    expect(conversationService.hasSession(sessionId)).toBe(false)

    const clearTurn = await runTurn(sessionId, '/clear')
    expect(
      clearTurn.some(
        (m) => m.type === 'system_notification' && m.subtype === 'session_cleared',
      ),
    ).toBe(true)
    expect(clearTurn.some((m) => m.type === 'content_delta')).toBe(false)

    const inspectionRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/inspection?includeContext=0`)
    expect(inspectionRes.status).toBe(200)
    const inspection = await inspectionRes.json() as { status?: { permissionMode?: string } }
    expect(inspection.status?.permissionMode).toBe('acceptEdits')
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

  it('should prewarm the CLI before the first user turn and reuse that process', async () => {
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd() }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json() as { sessionId: string }

    const originalStartSession = conversationService.startSession.bind(conversationService)
    const startCalls: Array<{ sessionId: string; options?: Record<string, unknown> }> = []

    conversationService.startSession = (async function patchedStartSession(
      sid: string,
      workDir: string,
      sdkUrl: string,
      options?: { permissionMode?: string; model?: string; effort?: string; thinking?: 'enabled' | 'adaptive' | 'disabled'; providerId?: string | null },
    ) {
      startCalls.push({ sessionId: sid, options: options as Record<string, unknown> | undefined })
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
      expect(startCalls[0]!.sessionId).toBe(sessionId)
      expect(startCalls[0]!.options?.resumeInterruptedTurn).toBe(false)
      expect(messages.some((msg) => msg.type === 'content_delta')).toBe(true)
      expect(messages.some((msg) => msg.type === 'message_complete')).toBe(true)
      expect(messages.some((msg) => msg.type === 'error')).toBe(false)
    } finally {
      ws.close()
      conversationService.startSession = originalStartSession
      conversationService.stopSession(sessionId)
    }
  }, 20_000)

  it('does not strand the first MiniMax provider turn when prewarm and user message flush together (#844)', async () => {
    const providerService = new ProviderService()
    const provider = await providerService.addProvider({
      presetId: 'minimax',
      name: 'MiniMax first-turn race',
      apiKey: 'key-minimax-first-turn-race',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiFormat: 'anthropic',
      models: {
        main: 'MiniMax-M3',
        haiku: 'MiniMax-M3',
        sonnet: 'MiniMax-M3',
        opus: 'MiniMax-M3',
      },
      model1mSupport: {
        main: true,
        haiku: true,
        sonnet: true,
        opus: true,
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
      options: { providerId?: string | null } | undefined
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

    const messages: any[] = []
    const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close()
          reject(new Error(`Timed out waiting for first MiniMax provider turn for session ${sessionId}`))
        }, 10_000)

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string)
          messages.push(msg)

          if (msg.type === 'connected') {
            ws.send(JSON.stringify({ type: 'prewarm_session' }))
            ws.send(JSON.stringify({ type: 'user_message', content: 'first turn without provider test' }))
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
          ws.close()
          reject(new Error(`WebSocket error for first MiniMax provider turn ${sessionId}`))
        }
      })

      expect(startCalls).toHaveLength(1)
      expect(startCalls[0]).toMatchObject({
        sessionId,
        options: {
          providerId: provider.id,
        },
      })
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
      const launchInfo = await sessionService.getSessionLaunchInfo(sessionId)
      expect(launchInfo).toMatchObject({
        runtimeProviderId: provider.id,
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

  it('should clear active turn tracking when sending a user message fails after startup', async () => {
    const providerService = new ProviderService()
    const provider = await providerService.addProvider({
      presetId: 'custom',
      name: 'Provider Send Failure Runtime',
      apiKey: 'key-send-failure-runtime',
      baseUrl: 'http://127.0.0.1:1/anthropic',
      apiFormat: 'anthropic',
      models: {
        main: 'send-failure-main',
        haiku: 'send-failure-haiku',
        sonnet: 'send-failure-sonnet',
        opus: 'send-failure-opus',
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

    conversationService.startSession = (async function patchedStartSession(
      sid: string,
      workDir: string,
      sdkUrl: string,
      options?: { permissionMode?: string; model?: string; effort?: string; thinking?: 'enabled' | 'adaptive' | 'disabled'; providerId?: string | null },
    ) {
      startCalls.push({ sessionId: sid, options })
      return originalStartSession(sid, workDir, sdkUrl, options)
    }) as typeof conversationService.startSession
    conversationService.sendMessage = (async () => false) as typeof conversationService.sendMessage

    const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
    const messages: any[] = []
    let sendFailureIdle = false
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close()
          reject(new Error(`Timed out waiting for send-failure runtime switch for session ${sessionId}`))
        }, 10_000)

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string)
          messages.push(msg)

          if (msg.type === 'connected') {
            ws.send(JSON.stringify({ type: 'user_message', content: 'send failure active turn cleanup' }))
            return
          }

          if (msg.type === 'error' && msg.code !== 'CLI_NOT_RUNNING') {
            clearTimeout(timeout)
            ws.close()
            reject(new Error(msg.message))
            return
          }

          if (msg.type === 'status' && msg.state === 'idle' && !sendFailureIdle) {
            if (!messages.some((item) => item.type === 'error' && item.code === 'CLI_NOT_RUNNING')) {
              return
            }
            sendFailureIdle = true
            ws.send(JSON.stringify({
              type: 'set_runtime_config',
              providerId: provider.id,
              modelId: 'send-failure-sonnet',
            }))
            return
          }

          if (msg.type === 'status' && msg.state === 'idle' && sendFailureIdle && startCalls.length > 1) {
            clearTimeout(timeout)
            ws.close()
            resolve()
          }
        }

        ws.onerror = () => {
          clearTimeout(timeout)
          reject(new Error(`WebSocket error for send-failure runtime switch session ${sessionId}`))
        }
      })

      expect(startCalls).toHaveLength(2)
      expect(startCalls[1]).toMatchObject({
        sessionId,
        options: {
          providerId: provider.id,
          model: 'send-failure-sonnet',
        },
      })
    } finally {
      ws.close()
      conversationService.startSession = originalStartSession
      conversationService.sendMessage = originalSendMessage
      conversationService.stopSession(sessionId)
    }
  }, 20_000)

  it('should defer runtime model switches until the active turn completes', async () => {
    await withMockStreamDelay(350, async () => {
      const providerService = new ProviderService()
      const providerA = await providerService.addProvider({
        presetId: 'custom',
        name: 'Provider Active Runtime A',
        apiKey: 'key-active-runtime-a',
        baseUrl: 'http://127.0.0.1:1/anthropic',
        apiFormat: 'anthropic',
        models: {
          main: 'active-a-main',
          haiku: 'active-a-haiku',
          sonnet: 'active-a-sonnet',
          opus: 'active-a-opus',
        },
      })
      const providerB = await providerService.addProvider({
        presetId: 'custom',
        name: 'Provider Active Runtime B',
        apiKey: 'key-active-runtime-b',
        baseUrl: 'http://127.0.0.1:1/anthropic',
        apiFormat: 'anthropic',
        models: {
          main: 'active-b-main',
          haiku: 'active-b-haiku',
          sonnet: 'active-b-sonnet',
          opus: 'active-b-opus',
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
      let switchTriggered = false
      let turnComplete = false
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.close()
            reject(new Error(`Timed out waiting for active-turn runtime switch for session ${sessionId}`))
          }, 10_000)

          ws.onmessage = (event) => {
            const msg = JSON.parse(event.data as string)

            if (msg.type === 'connected') {
              ws.send(JSON.stringify({
                type: 'set_runtime_config',
                providerId: providerA.id,
                modelId: 'active-a-sonnet',
              }))
              ws.send(JSON.stringify({ type: 'user_message', content: 'active turn runtime switch' }))
              return
            }

            if (msg.type === 'error') {
              clearTimeout(timeout)
              ws.close()
              reject(new Error(msg.message))
              return
            }

            if (
              msg.type === 'content_delta' &&
              typeof msg.text === 'string' &&
              msg.text.includes('active turn runtime switch') &&
              !switchTriggered
            ) {
              switchTriggered = true
              ws.send(JSON.stringify({
                type: 'set_runtime_config',
                providerId: providerB.id,
                modelId: 'active-b-opus',
              }))
              return
            }

            if (
              msg.type === 'status' &&
              msg.state === 'idle' &&
              switchTriggered &&
              !turnComplete &&
              startCalls.length > 1
            ) {
              clearTimeout(timeout)
              ws.close()
              reject(new Error('Runtime restarted before the active turn completed'))
              return
            }

            if (msg.type === 'message_complete' && switchTriggered && !turnComplete) {
              turnComplete = true
              expect(startCalls).toHaveLength(1)
              return
            }

            if (msg.type === 'status' && msg.state === 'idle' && turnComplete) {
              clearTimeout(timeout)
              ws.close()
              resolve()
            }
          }

          ws.onerror = () => {
            clearTimeout(timeout)
            reject(new Error(`WebSocket error for active-turn runtime switch session ${sessionId}`))
          }
        })

        expect(startCalls).toHaveLength(2)
        expect(startCalls[0]).toMatchObject({
          sessionId,
          options: {
            providerId: providerA.id,
            model: 'active-a-sonnet',
          },
        })
        expect(startCalls[1]).toMatchObject({
          sessionId,
          options: {
            providerId: providerB.id,
            model: 'active-b-opus',
          },
        })
      } finally {
        ws.close()
        conversationService.startSession = originalStartSession
        conversationService.stopSession(sessionId)
      }
    })
  }, 20_000)

  it('should surface deferred runtime restart failures after the active turn completes', async () => {
    await withMockStreamDelay(350, async () => {
      const providerService = new ProviderService()
      const providerA = await providerService.addProvider({
        presetId: 'custom',
        name: 'Provider Deferred Failure A',
        apiKey: 'key-deferred-failure-a',
        baseUrl: 'http://127.0.0.1:1/anthropic',
        apiFormat: 'anthropic',
        models: {
          main: 'deferred-failure-a-main',
          haiku: 'deferred-failure-a-haiku',
          sonnet: 'deferred-failure-a-sonnet',
          opus: 'deferred-failure-a-opus',
        },
      })
      const providerB = await providerService.addProvider({
        presetId: 'custom',
        name: 'Provider Deferred Failure B',
        apiKey: 'key-deferred-failure-b',
        baseUrl: 'http://127.0.0.1:1/anthropic',
        apiFormat: 'anthropic',
        models: {
          main: 'deferred-failure-b-main',
          haiku: 'deferred-failure-b-haiku',
          sonnet: 'deferred-failure-b-sonnet',
          opus: 'deferred-failure-b-opus',
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
        if (startCalls.length > 1) {
          throw new Error('deferred restart failed')
        }
        return originalStartSession(sid, workDir, sdkUrl, options)
      }) as typeof conversationService.startSession

      const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
      let switchTriggered = false
      let turnComplete = false
      let restartError = false
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.close()
            reject(new Error(`Timed out waiting for deferred restart failure for session ${sessionId}`))
          }, 10_000)

          ws.onmessage = (event) => {
            const msg = JSON.parse(event.data as string)

            if (msg.type === 'connected') {
              ws.send(JSON.stringify({
                type: 'set_runtime_config',
                providerId: providerA.id,
                modelId: 'deferred-failure-a-sonnet',
              }))
              ws.send(JSON.stringify({ type: 'user_message', content: 'deferred runtime restart failure' }))
              return
            }

            if (
              msg.type === 'content_delta' &&
              typeof msg.text === 'string' &&
              msg.text.includes('deferred runtime restart failure') &&
              !switchTriggered
            ) {
              switchTriggered = true
              ws.send(JSON.stringify({
                type: 'set_runtime_config',
                providerId: providerB.id,
                modelId: 'deferred-failure-b-opus',
              }))
              return
            }

            if (msg.type === 'message_complete' && switchTriggered && !turnComplete) {
              turnComplete = true
              expect(startCalls).toHaveLength(1)
              return
            }

            if (msg.type === 'error') {
              if (!turnComplete) {
                clearTimeout(timeout)
                ws.close()
                reject(new Error(`Deferred restart failed before turn completion: ${msg.message}`))
                return
              }
              restartError = msg.code === 'CLI_RESTART_FAILED' &&
                typeof msg.message === 'string' &&
                msg.message.includes('deferred restart failed')
              return
            }

            if (msg.type === 'status' && msg.state === 'idle' && restartError) {
              clearTimeout(timeout)
              ws.close()
              resolve()
            }
          }

          ws.onerror = () => {
            clearTimeout(timeout)
            reject(new Error(`WebSocket error for deferred restart failure session ${sessionId}`))
          }
        })

        expect(switchTriggered).toBe(true)
        expect(turnComplete).toBe(true)
        expect(restartError).toBe(true)
        expect(startCalls).toHaveLength(2)
        expect(startCalls[1]).toMatchObject({
          sessionId,
          options: {
            providerId: providerB.id,
            model: 'deferred-failure-b-opus',
          },
        })
      } finally {
        ws.close()
        conversationService.startSession = originalStartSession
        conversationService.stopSession(sessionId)
      }
    })
  }, 20_000)

  it('should defer bypass permission changes until the active turn completes without restarting', async () => {
    await withMockStreamDelay(350, async () => {
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
      let switchTriggered = false
      let turnComplete = false
      let modeConfirmed = false
      let deferredInspectionChecked = false
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            ws.close()
            reject(new Error(`Timed out waiting for active-turn permission switch for session ${sessionId}`))
          }, 10_000)

          ws.onmessage = async (event) => {
            const msg = JSON.parse(event.data as string)

            if (msg.type === 'connected') {
              ws.send(JSON.stringify({ type: 'user_message', content: 'active turn permission switch' }))
              return
            }

            if (msg.type === 'error') {
              clearTimeout(timeout)
              ws.close()
              reject(new Error(msg.message))
              return
            }

            if (
              msg.type === 'content_delta' &&
              typeof msg.text === 'string' &&
              msg.text.includes('active turn permission switch') &&
              !switchTriggered
            ) {
              switchTriggered = true
              ws.send(JSON.stringify({
                type: 'set_permission_mode',
                mode: 'bypassPermissions',
              }))
              await new Promise((resolve) => setTimeout(resolve, 25))
              const inspectionRes = await fetch(`${baseUrl}/api/sessions/${sessionId}/inspection?includeContext=0`)
              if (!inspectionRes.ok) {
                clearTimeout(timeout)
                ws.close()
                reject(new Error(`Inspection failed while permission switch was deferred: ${inspectionRes.status}`))
                return
              }
              const inspectionBody = await inspectionRes.json() as { status?: { permissionMode?: string } }
              deferredInspectionChecked = true
              if (inspectionBody.status?.permissionMode !== 'default') {
                clearTimeout(timeout)
                ws.close()
                reject(new Error(`Deferred permission switch was exposed before restart: ${inspectionBody.status?.permissionMode}`))
                return
              }
              return
            }

            if (msg.type === 'permission_mode_changed' && msg.mode === 'bypassPermissions') {
              modeConfirmed = true
              if (turnComplete) {
                clearTimeout(timeout)
                resolve()
              }
              return
            }

            if (msg.type === 'message_complete' && switchTriggered && !turnComplete) {
              turnComplete = true
              expect(startCalls).toHaveLength(1)
              if (modeConfirmed) {
                clearTimeout(timeout)
                resolve()
              }
              return
            }
          }

          ws.onerror = () => {
            clearTimeout(timeout)
            reject(new Error(`WebSocket error for active-turn permission switch session ${sessionId}`))
          }
        })

        expect(switchTriggered).toBe(true)
        expect(turnComplete).toBe(true)
        expect(modeConfirmed).toBe(true)
        expect(deferredInspectionChecked).toBe(true)
        expect(startCalls).toHaveLength(1)
        expect(startCalls[0]).toMatchObject({
          sessionId,
          options: {
            permissionMode: 'default',
          },
        })
        expect(conversationService.getSessionPermissionMode(sessionId)).toBe('bypassPermissions')
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
    })
  }, 20_000)

  it('should enter bypass permissions without restarting the CLI', async () => {
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
      const switchStartedAt = performance.now()
      ws.send(JSON.stringify({
        type: 'set_permission_mode',
        mode: 'bypassPermissions',
      }))

      await waitUntil(
        () => messages.slice(switchStartIndex).some((msg) =>
          msg.type === 'permission_mode_changed' && msg.mode === 'bypassPermissions'
        ),
        `in-process bypass permission switch completion for ${sessionId}`,
      )

      expect(performance.now() - switchStartedAt).toBeLessThan(1_000)
      expect(startCalls).toHaveLength(1)
      expect(
        messages
          .slice(switchStartIndex)
          .some((msg) => msg.type === 'permission_mode_changed' && msg.mode === 'bypassPermissions'),
      ).toBe(true)
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

  it('should restart an already-running legacy session only when bypass capability is unavailable', async () => {
    await withMockPermissionModeBehavior('unavailable', async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir: process.cwd(), permissionMode: 'default' }),
      })
      expect(createRes.status).toBe(201)
      const { sessionId } = await createRes.json() as { sessionId: string }

      const originalStartSession = conversationService.startSession.bind(conversationService)
      const startModes: Array<string | undefined> = []
      conversationService.startSession = (async function patchedStartSession(
        sid: string,
        workDir: string,
        sdkUrl: string,
        options?: { permissionMode?: string; model?: string; effort?: string; thinking?: 'enabled' | 'adaptive' | 'disabled'; providerId?: string | null },
      ) {
        startModes.push(options?.permissionMode)
        return originalStartSession(sid, workDir, sdkUrl, options)
      }) as typeof conversationService.startSession

      const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
      const messages: any[] = []
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Timed out prewarming ${sessionId}`)), 5_000)
          ws.onmessage = (event) => {
            const msg = JSON.parse(event.data as string)
            messages.push(msg)
            if (msg.type === 'connected') {
              clearTimeout(timeout)
              ws.send(JSON.stringify({ type: 'prewarm_session' }))
              resolve()
            }
          }
          ws.onerror = () => {
            clearTimeout(timeout)
            reject(new Error(`WebSocket error prewarming ${sessionId}`))
          }
        })
        await waitUntil(
          () => Boolean((conversationService as any).sessions.get(sessionId)?.sdkSocket),
          `SDK control channel for legacy bypass fallback ${sessionId}`,
        )

        ws.send(JSON.stringify({ type: 'set_permission_mode', mode: 'bypassPermissions' }))
        await waitUntil(
          () => messages.some((msg) =>
            msg.type === 'permission_mode_changed' && msg.mode === 'bypassPermissions'
          ),
          `legacy bypass restart confirmation ${sessionId}`,
        )

        expect(startModes).toEqual(['default', 'bypassPermissions'])
        expect(messages.some((msg) => msg.type === 'error')).toBe(false)
        expect(conversationService.getSessionPermissionMode(sessionId)).toBe('bypassPermissions')
      } finally {
        ws.close()
        conversationService.startSession = originalStartSession
        conversationService.stopSession(sessionId)
      }
    })
  }, 20_000)

  it('should persist permission changes made before the CLI starts', async () => {
    await fetch(`${baseUrl}/api/permissions/mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'default' }),
    })

    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd(), permissionMode: 'default' }),
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
          reject(new Error(`Timed out waiting for inactive permission switch connection for session ${sessionId}`))
        }, 5000)
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string)
          messages.push(msg)
          if (msg.type === 'connected') {
            clearTimeout(timeout)
            ws.send(JSON.stringify({
              type: 'set_permission_mode',
              mode: 'acceptEdits',
            }))
            resolve()
          }
          if (msg.type === 'error') {
            clearTimeout(timeout)
            reject(new Error(msg.message))
          }
        }
        ws.onerror = () => {
          clearTimeout(timeout)
          reject(new Error(`WebSocket error for inactive permission switch session ${sessionId}`))
        }
      })

      await waitUntil(async () => {
        const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/inspection?includeContext=0`)
        if (!res.ok) return false
        const body = await res.json() as { status?: { permissionMode?: string } }
        return body.status?.permissionMode === 'acceptEdits'
      }, `persisted inactive permission switch for ${sessionId}`)
      expect(messages.some((msg) =>
        msg.type === 'permission_mode_changed' &&
        msg.mode === 'acceptEdits'
      )).toBe(true)

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for first turn after inactive permission switch for session ${sessionId}`))
        }, 10_000)
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string)
          if (msg.type === 'message_complete') {
            clearTimeout(timeout)
            resolve()
          }
          if (msg.type === 'error') {
            clearTimeout(timeout)
            reject(new Error(msg.message))
          }
        }
        ws.send(JSON.stringify({ type: 'user_message', content: 'first turn after permission switch' }))
      })

      expect(startCalls).toHaveLength(1)
      expect(startCalls[0]).toMatchObject({
        sessionId,
        options: {
          permissionMode: 'acceptEdits',
        },
      })
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

  it('should switch from bypass permissions back to default without restarting', async () => {
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd(), permissionMode: 'bypassPermissions' }),
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
          reject(new Error(`Timed out waiting for bypass-to-default permission switch connection for session ${sessionId}`))
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
          reject(new Error(`WebSocket error for bypass-to-default permission switch session ${sessionId}`))
        }
      })

      await waitUntil(
        () => startCalls.length === 1 && conversationService.hasSession(sessionId),
        `prewarmed CLI process for bypass-to-default permission switch ${sessionId}`,
      )
      expect(startCalls[0]).toMatchObject({
        sessionId,
        options: {
          permissionMode: 'bypassPermissions',
        },
      })

      const switchStartIndex = messages.length
      ws.send(JSON.stringify({
        type: 'set_permission_mode',
        mode: 'default',
      }))

      await waitUntil(async () => {
        const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/inspection?includeContext=0`)
        if (!res.ok) return false
        const body = await res.json() as { status?: { permissionMode?: string } }
        return body.status?.permissionMode === 'default'
      }, `persisted bypass-to-default permission switch for ${sessionId}`)
      expect(startCalls).toHaveLength(1)
      expect(conversationService.getSessionPermissionMode(sessionId)).toBe('default')
      expect(messages.slice(switchStartIndex).some((msg) => msg.type === 'error')).toBe(false)
    } finally {
      ws.close()
      conversationService.startSession = originalStartSession
      conversationService.stopSession(sessionId)
    }
  }, 20_000)

  it('should confirm a permission switch as soon as the SDK control channel connects', async () => {
    await withMockInitMode('on_first_user', async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir: process.cwd(), permissionMode: 'default' }),
      })
      expect(createRes.status).toBe(201)
      const { sessionId } = await createRes.json() as { sessionId: string }
      const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)

      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error(`Timed out connecting startup permission session ${sessionId}`))
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
            reject(new Error(`WebSocket error for startup permission session ${sessionId}`))
          }
        })

        await waitUntil(
          () => Boolean((conversationService as any).sessions.get(sessionId)?.sdkSocket),
          `SDK control channel for startup permission session ${sessionId}`,
        )
        expect(conversationService.getSessionInitMessage(sessionId)).toBeNull()

        const switchStartedAt = performance.now()
        const confirmation = new Promise<'confirmed'>((resolve, reject) => {
          ws.onmessage = (event) => {
            const msg = JSON.parse(event.data as string)
            if (msg.type === 'permission_mode_changed' && msg.mode === 'auto') {
              resolve('confirmed')
            }
            if (msg.type === 'error') {
              reject(new Error(msg.message))
            }
          }
        })
        ws.send(JSON.stringify({ type: 'set_permission_mode', mode: 'auto' }))

        const outcome = await Promise.race([
          confirmation,
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
        ])

        expect(outcome).toBe('confirmed')
        expect(performance.now() - switchStartedAt).toBeLessThan(1_000)
      } finally {
        ws.close()
        conversationService.stopSession(sessionId)
      }
    })
  }, 10_000)

  it('should not persist or broadcast a rejected auto permission switch', async () => {
    await withMockPermissionModeBehavior('status-before-reject', async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir: process.cwd(), permissionMode: 'default' }),
      })
      expect(createRes.status).toBe(201)
      const { sessionId } = await createRes.json() as { sessionId: string }
      const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
      const messages: any[] = []

      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error(`Timed out connecting rejected auto switch session ${sessionId}`))
          }, 5_000)
          ws.onmessage = (event) => {
            const msg = JSON.parse(event.data as string)
            messages.push(msg)
            if (msg.type === 'connected') {
              clearTimeout(timeout)
              ws.send(JSON.stringify({ type: 'prewarm_session' }))
              resolve()
            }
          }
          ws.onerror = () => {
            clearTimeout(timeout)
            reject(new Error(`WebSocket error for rejected auto switch session ${sessionId}`))
          }
        })

        ws.send(JSON.stringify({
          type: 'user_message',
          content: 'finish a turn before rejected auto switch',
        }))
        await waitUntil(
          () => messages.some((msg) => msg.type === 'message_complete'),
          `completed turn before rejected auto switch ${sessionId}`,
        )
        const switchStartIndex = messages.length
        ws.send(JSON.stringify({ type: 'set_permission_mode', mode: 'auto' }))
        await new Promise((resolve) => setTimeout(resolve, 200))

        const inspectionRes = await fetch(
          `${baseUrl}/api/sessions/${sessionId}/inspection?includeContext=0`,
        )
        expect(inspectionRes.status).toBe(200)
        const inspection = await inspectionRes.json() as {
          status?: { permissionMode?: string }
        }
        expect(inspection.status?.permissionMode).toBe('default')
        expect(
          messages.slice(switchStartIndex).some((msg) =>
            msg.type === 'permission_mode_changed' && msg.mode === 'auto'
          ),
        ).toBe(false)
        expect(
          messages.slice(switchStartIndex).some((msg) =>
            msg.type === 'error' && msg.code === 'PERMISSION_MODE_CHANGE_FAILED'
          ),
        ).toBe(true)
      } finally {
        ws.close()
        conversationService.stopSession(sessionId)
      }
    })
  }, 20_000)

  it('should explicitly persist and broadcast a confirmed mode switch while prewarmed', async () => {
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd(), permissionMode: 'default' }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json() as { sessionId: string }
    const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
    const messages: any[] = []

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out prewarming ${sessionId}`)), 5_000)
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string)
          messages.push(msg)
          if (msg.type === 'connected') {
            clearTimeout(timeout)
            ws.send(JSON.stringify({ type: 'prewarm_session' }))
            resolve()
          }
        }
        ws.onerror = () => {
          clearTimeout(timeout)
          reject(new Error(`WebSocket error prewarming ${sessionId}`))
        }
      })
      await waitUntil(
        () => conversationService.hasSession(sessionId),
        `prewarmed session ${sessionId}`,
      )

      const switchStartIndex = messages.length
      ws.send(JSON.stringify({ type: 'set_permission_mode', mode: 'auto' }))
      await waitUntil(
        () => messages.slice(switchStartIndex).some((msg) =>
          msg.type === 'permission_mode_changed' && msg.mode === 'auto'
        ),
        `confirmed prewarm permission switch ${sessionId}`,
      )

      conversationService.stopSession(sessionId)
      const inspectionRes = await fetch(
        `${baseUrl}/api/sessions/${sessionId}/inspection?includeContext=0`,
      )
      const inspection = await inspectionRes.json() as { status?: { permissionMode?: string } }
      expect(inspection.status?.permissionMode).toBe('auto')
    } finally {
      ws.close()
      conversationService.stopSession(sessionId)
    }
  }, 20_000)

  it('should preserve safe permission metadata when a bypass change is rejected', async () => {
    await withMockPermissionModeBehavior('reject', async () => {
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir: process.cwd(), permissionMode: 'default' }),
      })
      expect(createRes.status).toBe(201)
      const { sessionId } = await createRes.json() as { sessionId: string }
      const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
      const messages: any[] = []

      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Timed out prewarming ${sessionId}`)), 5_000)
          ws.onmessage = (event) => {
            const msg = JSON.parse(event.data as string)
            messages.push(msg)
            if (msg.type === 'connected') {
              clearTimeout(timeout)
              ws.send(JSON.stringify({ type: 'prewarm_session' }))
              resolve()
            }
          }
          ws.onerror = () => {
            clearTimeout(timeout)
            reject(new Error(`WebSocket error prewarming ${sessionId}`))
          }
        })
        await waitUntil(
          () => Boolean((conversationService as any).sessions.get(sessionId)?.sdkSocket),
          `SDK control channel for rejected bypass change ${sessionId}`,
        )

        ws.send(JSON.stringify({ type: 'set_permission_mode', mode: 'bypassPermissions' }))
        await waitUntil(
          () => messages.some((msg) =>
            msg.type === 'error' && msg.code === 'PERMISSION_MODE_CHANGE_FAILED'
          ),
          `rejected bypass change for ${sessionId}`,
        )

        const inspectionRes = await fetch(
          `${baseUrl}/api/sessions/${sessionId}/inspection?includeContext=0`,
        )
        const inspection = await inspectionRes.json() as { status?: { permissionMode?: string } }
        expect(inspection.status?.permissionMode).toBe('default')
        expect(messages.some((msg) =>
          msg.type === 'permission_mode_changed' && msg.mode === 'bypassPermissions'
        )).toBe(false)
      } finally {
        ws.close()
        conversationService.stopSession(sessionId)
      }
    })
  }, 20_000)

  it('should persist CLI-originated permission-mode broadcasts', async () => {
    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd(), permissionMode: 'default' }),
    })
    expect(createRes.status).toBe(201)
    const { sessionId } = await createRes.json() as { sessionId: string }

    const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
    const messages: any[] = []
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for CLI permission broadcast turn for session ${sessionId}`))
        }, 10_000)
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data as string)
          messages.push(msg)
          if (msg.type === 'connected') {
            ws.send(JSON.stringify({ type: 'user_message', content: 'turn before CLI permission broadcast' }))
            return
          }
          if (msg.type === 'message_complete') {
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
          reject(new Error(`WebSocket error for CLI permission broadcast session ${sessionId}`))
        }
      })
      expect(conversationService.hasSession(sessionId)).toBe(true)

      conversationService.handleSdkPayload(sessionId, `${JSON.stringify({
        type: 'system',
        subtype: 'status',
        status: null,
        permissionMode: 'acceptEdits',
      })}\n`)

      await waitUntil(
        () => messages.some((msg) =>
          msg.type === 'permission_mode_changed' &&
          msg.mode === 'acceptEdits'
        ),
        `forwarded CLI permission broadcast for ${sessionId}`,
      )
      expect(conversationService.getSessionPermissionMode(sessionId)).toBe('acceptEdits')
      await waitUntil(async () => {
        const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/inspection?includeContext=0`)
        if (!res.ok) return false
        const body = await res.json() as { status?: { permissionMode?: string } }
        return body.status?.permissionMode === 'acceptEdits'
      }, `persisted CLI permission broadcast for ${sessionId}`)
    } finally {
      ws.close()
      conversationService.stopSession(sessionId)
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

  it('should preserve ChatGPT Official as the active default runtime after restart', async () => {
    const providerService = new ProviderService()
    await providerService.activateProvider('openai-official')

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
      const messages = await runTurn(sessionId, 'default ChatGPT Official runtime')

      expect(startCalls).toHaveLength(1)
      expect(startCalls[0]).toMatchObject({
        sessionId,
        options: {
          providerId: 'openai-official',
          model: 'gpt-5.6-sol',
          effort: 'low',
        },
      })
      expect(startCalls[0]?.options?.thinking).toBeUndefined()
      expect(messages.some((msg) => msg.type === 'message_complete')).toBe(true)
      await expect(providerService.listProviders()).resolves.toMatchObject({
        activeId: 'openai-official',
      })
    } finally {
      conversationService.startSession = originalStartSession
      conversationService.stopSession(sessionId)
      await providerService.activateOfficial()
    }
  }, 20_000)

  it('should accept xhigh for GPT-5.6 and pass it to the OpenAI runtime', async () => {
    const providerService = new ProviderService()
    await providerService.activateProvider('openai-official')

    const createRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workDir: process.cwd() }),
    })
    const { sessionId } = await createRes.json() as { sessionId: string }
    const originalStartSession = conversationService.startSession.bind(conversationService)
    const startCalls: Array<{ options?: { model?: string; effort?: string; providerId?: string | null } }> = []
    conversationService.startSession = (async function patchedStartSession(
      sid: string,
      workDir: string,
      sdkUrl: string,
      options?: { permissionMode?: string; model?: string; effort?: string; thinking?: 'enabled' | 'adaptive' | 'disabled'; providerId?: string | null },
    ) {
      startCalls.push({ options })
      return originalStartSession(sid, workDir, sdkUrl, options)
    }) as typeof conversationService.startSession

    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
        const timeout = setTimeout(() => {
          ws.close()
          reject(new Error('Timed out waiting for GPT-5.6 xhigh runtime turn'))
        }, 10_000)

        ws.onmessage = (event) => {
          const message = JSON.parse(event.data as string)
          if (message.type === 'connected') {
            ws.send(JSON.stringify({
              type: 'set_runtime_config',
              providerId: 'openai-official',
              modelId: 'gpt-5.6-sol',
              effortLevel: 'xhigh',
            }))
            ws.send(JSON.stringify({ type: 'user_message', content: 'use xhigh' }))
          } else if (message.type === 'error') {
            clearTimeout(timeout)
            ws.close()
            reject(new Error(message.message))
          } else if (message.type === 'message_complete') {
            clearTimeout(timeout)
            ws.close()
            resolve()
          }
        }
        ws.onerror = () => reject(new Error('WebSocket failed for GPT-5.6 xhigh runtime'))
      })

      expect(startCalls[0]?.options).toMatchObject({
        providerId: 'openai-official',
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
      })
    } finally {
      conversationService.startSession = originalStartSession
      conversationService.stopSession(sessionId)
      await providerService.activateOfficial()
    }
  }, 20_000)

  it('should reject a reasoning effort that the selected ChatGPT model does not support', async () => {
    const sessionId = `chat-openai-invalid-effort-${crypto.randomUUID()}`
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${wsUrl}/ws/${sessionId}`)
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('Timed out waiting for invalid OpenAI effort rejection'))
      }, 5_000)

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data as string)
        if (message.type === 'connected') {
          ws.send(JSON.stringify({
            type: 'set_runtime_config',
            providerId: 'openai-official',
            modelId: 'gpt-5.5',
            effortLevel: 'max',
          }))
        } else if (message.type === 'error') {
          clearTimeout(timeout)
          expect(message).toMatchObject({ code: 'RUNTIME_CONFIG_INVALID' })
          ws.close()
          resolve()
        }
      }
      ws.onerror = () => reject(new Error('WebSocket failed for invalid OpenAI effort'))
    })
  }, 10_000)

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

  it('should reconcile an idle turn that completed while the client was disconnected', async () => {
    await withMockStreamDelay(75, async () => {
      const sessionId = `chat-reconnect-completed-${crypto.randomUUID()}`
      const firstMessages: any[] = []
      const reconnectMessages: any[] = []
      let firstSocket: WebSocket | null = null
      let reconnectSocket: WebSocket | null = null

      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error(`Timed out waiting for disconnected completion for session ${sessionId}`))
          }, 10_000)

          const fail = (error: unknown) => {
            clearTimeout(timeout)
            reject(error instanceof Error ? error : new Error(String(error)))
          }

          firstSocket = new WebSocket(`${wsUrl}/ws/${sessionId}`)
          firstSocket.onmessage = (event) => {
            const message = JSON.parse(event.data as string)
            firstMessages.push(message)
            if (message.type === 'connected') {
              firstSocket?.send(JSON.stringify({
                type: 'user_message',
                content: 'finish while disconnected',
              }))
              return
            }
            if (message.type !== 'thinking') return

            firstSocket?.close()
            void (async () => {
              const deadline = Date.now() + 5_000
              while (
                Date.now() < deadline &&
                !conversationService.getRecentSdkMessages(sessionId).some(
                  (entry) => entry?.type === 'result',
                )
              ) {
                await new Promise((pollResolve) => setTimeout(pollResolve, 25))
              }
              if (!conversationService.getRecentSdkMessages(sessionId).some(
                (entry) => entry?.type === 'result',
              )) {
                fail(new Error(`CLI did not finish while disconnected for session ${sessionId}`))
                return
              }

              reconnectSocket = new WebSocket(`${wsUrl}/ws/${sessionId}`)
              reconnectSocket.onmessage = (reconnectEvent) => {
                const reconnectMessage = JSON.parse(reconnectEvent.data as string)
                reconnectMessages.push(reconnectMessage)
                if (reconnectMessage.type === 'connected') {
                  reconnectSocket?.send(JSON.stringify({ type: 'sync_state' }))
                  return
                }
                if (
                  reconnectMessage.type === 'session_state' &&
                  reconnectMessage.turnState === 'idle'
                ) {
                  clearTimeout(timeout)
                  resolve()
                }
              }
              reconnectSocket.onerror = () => fail(
                new Error(`Reconnect WebSocket error for session ${sessionId}`),
              )
            })().catch(fail)
          }
          firstSocket.onerror = () => fail(
            new Error(`Initial WebSocket error for session ${sessionId}`),
          )
        })

        expect(firstMessages.some((message) => message.type === 'thinking')).toBe(true)
        expect(reconnectMessages).toContainEqual({
          type: 'session_state',
          turnState: 'idle',
        })
        expect(reconnectMessages.some((message) => message.type === 'message_complete')).toBe(false)
      } finally {
        firstSocket?.close()
        reconnectSocket?.close()
        conversationService.stopSession(sessionId)
      }
    })
  })

  it('should stream one active turn to multiple connected clients', async () => {
    await withMockStreamDelay(150, async () => {
      const sessionId = `chat-multi-client-${crypto.randomUUID()}`
      const firstMessages: any[] = []
      const secondMessages: any[] = []

      await new Promise<void>((resolve, reject) => {
        let secondConnected = false
        let firstComplete = false
        let secondComplete = false
        let ws2: WebSocket | null = null

        const timeout = setTimeout(() => {
          ws1.close()
          ws2?.close()
          reject(new Error(`Timed out waiting for both clients to complete for session ${sessionId}`))
        }, 10_000)

        const cleanup = () => {
          if (!firstComplete || !secondComplete) return
          clearTimeout(timeout)
          ws1.close()
          ws2?.close()
          resolve()
        }

        const handleFailure = (message: string) => {
          clearTimeout(timeout)
          ws1.close()
          ws2?.close()
          reject(new Error(message))
        }

        const ws1 = new WebSocket(`${wsUrl}/ws/${sessionId}`)
        ws1.onmessage = (event) => {
          const msg = JSON.parse(event.data as string)
          firstMessages.push(msg)

          if (msg.type === 'connected') {
            ws1.send(JSON.stringify({ type: 'user_message', content: 'multi client stream' }))
            return
          }

          if (msg.type === 'thinking' && !secondConnected) {
            secondConnected = true
            ws2 = new WebSocket(`${wsUrl}/ws/${sessionId}`)
            ws2.onmessage = (secondEvent) => {
              const secondMsg = JSON.parse(secondEvent.data as string)
              secondMessages.push(secondMsg)
              if (secondMsg.type === 'error') {
                handleFailure(secondMsg.message)
                return
              }
              if (secondMsg.type === 'message_complete') {
                secondComplete = true
                cleanup()
              }
            }
            ws2.onerror = () => handleFailure(`Second WebSocket error for session ${sessionId}`)
          }

          if (msg.type === 'message_complete') {
            firstComplete = true
            cleanup()
          }
        }

        ws1.onerror = () => handleFailure(`First WebSocket error for session ${sessionId}`)
      })

      expect(firstMessages.some((msg) => msg.type === 'content_delta')).toBe(true)
      expect(firstMessages.some((msg) => msg.type === 'message_complete')).toBe(true)
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
              effortLevel: 'medium',
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
              effortLevel: 'max',
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
          effort: 'medium',
        },
      })
      expect(startCalls[1]).toMatchObject({
        sessionId,
        options: {
          providerId: providerB.id,
          model: 'model-b-opus',
          effort: 'max',
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

  it('should wait for an in-flight permission change before sending the next user turn', async () => {
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

      expect(startCalls).toHaveLength(1)
      expect(startCalls[0]).toMatchObject({
        sessionId,
        options: {
          permissionMode: 'default',
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
          startCallCount: 1,
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
