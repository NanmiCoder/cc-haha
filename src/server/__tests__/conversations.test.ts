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
import { fileURLToPath } from 'node:url'
import { ConversationService } from '../services/conversationService.js'

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

  it('should ignore stale process exits after a session restarts', () => {
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

    ;(svc as any).handleProcessExit('session-restart', oldProc, 143)
    expect(svc.hasSession('session-restart')).toBe(true)

    ;(svc as any).handleProcessExit('session-restart', newProc, 0)
    expect(svc.hasSession('session-restart')).toBe(false)
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

  async function runTurn(sessionId: string, content: string): Promise<any[]> {
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
          reject(new Error(msg.message))
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
})
