import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  getIsInteractive,
  getSessionId,
  setIsInteractive,
  switchSession,
} from '../bootstrap/state.js'
import { handleStopHooks } from '../query/stopHooks.js'
import { computerUseApprovalService } from '../server/services/computerUseApprovalService.js'
import { conversationService } from '../server/services/conversationService.js'
import { sessionService } from '../server/services/sessionService.js'
import * as teamPlanRuntime from '../server/services/teamPlanRuntime.js'
import {
  __resetWebSocketHandlerStateForTests,
  handleWebSocket,
} from '../server/ws/handler.js'
import { migrationMaintenance } from '../server/migrationMaintenance.js'
import type { AppState } from '../state/AppState.js'
import type { ToolUseContext } from '../Tool.js'
import type { SessionId } from '../types/ids.js'
import { execPromptHook } from '../utils/hooks/execPromptHook.js'
import { createCommandInputMessage, createUserInterruptionMessage } from '../utils/messages.js'
import { get3PModelCapabilityOverride } from '../utils/model/modelSupportOverrides.js'
import {
  clearThreadGoalHook,
  ensureThreadGoalHookFromTranscript,
  setThreadGoalHook,
} from './goalState.js'

const REPO_ROOT = resolve(import.meta.dir, '../..')
const testGlobals = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
const originalMacro = testGlobals.MACRO

type CapturedAnthropicRequest = {
  path: string
  stream: boolean
  body: {
    model?: string
    stream?: boolean
    thinking?: { type?: string; budget_tokens?: number }
    system?: unknown
    messages?: Array<{ role?: string; content?: unknown }>
    tools?: Array<{ name?: string }>
  }
}

type MockBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

type MockAnthropicResponse =
  | {
      kind: 'message'
      content: MockBlock[]
      stopReason?: string
      holdUntilAborted?: () => Promise<void>
      onStreamOpened?: () => void
    }
  | {
      kind: 'error'
      status: number
      errorType: string
      message: string
    }

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function startLoopbackAnthropicServer(
  handler: (req: CapturedAnthropicRequest) => MockAnthropicResponse,
) {
  const requests: CapturedAnthropicRequest[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 30,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method === 'GET' && path.endsWith('/v1/models')) {
        return Response.json({
          data: [{ type: 'model', id: 'mock-model', display_name: 'Mock' }],
          has_more: false,
        })
      }
      if (req.method !== 'POST') {
        return new Response('not found', { status: 404 })
      }
      const body = (await req.json().catch(() => ({}))) as CapturedAnthropicRequest['body']
      if (path.endsWith('/v1/messages/count_tokens')) {
        return Response.json({ input_tokens: 16 })
      }
      if (!path.endsWith('/v1/messages')) {
        return new Response('not found', { status: 404 })
      }
      const captured: CapturedAnthropicRequest = {
        path,
        stream: body.stream === true,
        body,
      }
      requests.push(captured)
      const decision = handler(captured)
      if (decision.kind === 'error') {
        return Response.json(
          {
            type: 'error',
            error: {
              type: decision.errorType,
              message: decision.message,
            },
          },
          { status: decision.status },
        )
      }

      const model = body.model || 'mock-model'
      const stopReason = decision.stopReason ?? 'end_turn'
      const id = `msg_repro_${Date.now().toString(36)}_${requests.length}`

      if (body.stream) {
        const encoder = new TextEncoder()
        let cancelled = false
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const push = (event: string, data: unknown) => {
              if (!cancelled) controller.enqueue(encoder.encode(sse(event, data)))
            }
            push('message_start', {
              type: 'message_start',
              message: {
                id,
                type: 'message',
                role: 'assistant',
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 1 },
              },
            })
            for (const [index, block] of decision.content.entries()) {
              if (block.type === 'text') {
                push('content_block_start', {
                  type: 'content_block_start',
                  index,
                  content_block: { type: 'text', text: '' },
                })
                push('content_block_delta', {
                  type: 'content_block_delta',
                  index,
                  delta: { type: 'text_delta', text: block.text },
                })
                if (decision.onStreamOpened) decision.onStreamOpened()
                if (decision.holdUntilAborted) {
                  await Promise.race([
                    decision.holdUntilAborted(),
                    new Promise<void>(resolveAbort => {
                      if (req.signal.aborted) {
                        cancelled = true
                        resolveAbort()
                        return
                      }
                      req.signal.addEventListener(
                        'abort',
                        () => {
                          cancelled = true
                          resolveAbort()
                        },
                        { once: true },
                      )
                    }),
                  ])
                  if (cancelled) {
                    try {
                      controller.close()
                    } catch {
                      // already closed
                    }
                    return
                  }
                }
              } else {
                push('content_block_start', {
                  type: 'content_block_start',
                  index,
                  content_block: {
                    type: 'tool_use',
                    id: block.id,
                    name: block.name,
                    input: {},
                  },
                })
                push('content_block_delta', {
                  type: 'content_block_delta',
                  index,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: JSON.stringify(block.input),
                  },
                })
              }
              push('content_block_stop', { type: 'content_block_stop', index })
            }
            push('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: { output_tokens: 8 },
            })
            push('message_stop', { type: 'message_stop' })
            if (!cancelled) controller.close()
          },
          cancel() {
            cancelled = true
          },
        })
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          },
        })
      }

      return Response.json({
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: decision.content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 8 },
      })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: async () => {
      server.stop(true)
    },
  }
}

function createIsolatedSandbox(label: string) {
  const root = mkdtempSync(join(tmpdir(), `repro-1933-${label}-`))
  const home = join(root, 'home')
  const configDir = join(root, 'claude-config')
  const workDir = join(root, 'work')
  const tmp = join(root, 'tmp')
  mkdirSync(home, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  mkdirSync(workDir, { recursive: true })
  mkdirSync(tmp, { recursive: true })

  return {
    root,
    home,
    configDir,
    workDir,
    tmp,
    env: (extra: Record<string, string | undefined> = {}) => {
      const base: Record<string, string> = {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        SHELL: process.env.SHELL ?? '/bin/sh',
        HOME: home,
        CLAUDE_CONFIG_DIR: configDir,
        XDG_CONFIG_HOME: join(root, 'xdg-config'),
        XDG_DATA_HOME: join(root, 'xdg-data'),
        XDG_CACHE_HOME: join(root, 'xdg-cache'),
        TMPDIR: tmp,
        CALLER_DIR: workDir,
        CC_HAHA_SKIP_DOTENV: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
        DISABLE_AUTOUPDATER: '1',
        CI: '1',
      }
      for (const [k, v] of Object.entries(extra)) {
        if (v === undefined) delete base[k]
        else base[k] = v
      }
      return base
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

type CliEvent = Record<string, unknown>

function spawnHeadlessCli(options: {
  sandbox: ReturnType<typeof createIsolatedSandbox>
  baseUrl: string
  extraArgs?: string[]
  extraEnv?: Record<string, string | undefined>
}) {
  const proc = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      '--preload',
      join(REPO_ROOT, 'preload.ts'),
      join(REPO_ROOT, 'src/entrypoints/cli.tsx'),
      '--print',
      '--model',
      'mock-model',
      '--permission-mode',
      'bypassPermissions',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      ...(options.extraArgs ?? []),
    ],
    {
      cwd: options.sandbox.workDir,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: options.sandbox.env({
        ANTHROPIC_BASE_URL: options.baseUrl,
        ANTHROPIC_API_KEY: 'mock-api-key',
        ...(options.extraEnv ?? {}),
      }),
    },
  )

  const events: CliEvent[] = []
  const waiters: Array<{
    predicate: (ev: CliEvent) => boolean
    resolve: (ev: CliEvent) => void
  }> = []
  let stderrText = ''

  const stdoutDone = (async () => {
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) continue
        try {
          const parsed = JSON.parse(trimmed) as CliEvent
          events.push(parsed)
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i]!.predicate(parsed)) {
              const w = waiters.splice(i, 1)[0]!
              w.resolve(parsed)
            }
          }
        } catch {
          // ignore non-json lines
        }
      }
    }
  })()

  const stderrDone = new Response(proc.stderr).text().then(text => {
    stderrText = text
  })

  function send(frame: Record<string, unknown>) {
    proc.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  function waitForEvent(
    predicate: (ev: CliEvent) => boolean,
    timeoutMs = 15_000,
    label = 'event',
  ): Promise<CliEvent> {
    const existing = events.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolvePromise, reject) => {
      const waiter = {
        predicate,
        resolve: (ev: CliEvent) => {
          clearTimeout(timer)
          resolvePromise(ev)
        },
      }
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter)
        if (idx >= 0) waiters.splice(idx, 1)
        reject(
          new Error(
            `Timed out waiting for ${label} after ${timeoutMs}ms. Seen ${events.length} events. stderr=${stderrText.slice(0, 500)}`,
          ),
        )
      }, timeoutMs)
      waiters.push(waiter)
    })
  }

  async function close() {
    try {
      proc.stdin.end()
    } catch {
      // already closed
    }
    const exitTimeout = setTimeout(() => proc.kill(), 4_000)
    await proc.exited
    clearTimeout(exitTimeout)
    await Promise.allSettled([stdoutDone, stderrDone])
  }

  return {
    proc,
    events,
    send,
    waitForEvent,
    close,
    getStderr: () => stderrText,
  }
}

function isGoalEvaluatorRequest(req: CapturedAnthropicRequest): boolean {
  const systemText = JSON.stringify(req.body.system ?? '')
  const messagesText = JSON.stringify(req.body.messages ?? '')
  return (
    systemText.includes('You are evaluating a hook') ||
    messagesText.includes('<cc-haha-goal-hook>')
  )
}

function serializedEventText(ev: CliEvent): string {
  return JSON.stringify(ev)
}

async function flushMicrotasks() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

function makeHookToolUseContext(appStateOverride?: Record<string, unknown>): ToolUseContext {
  let responseLength = 0
  let state: Record<string, unknown> = {
    toolPermissionContext: { mode: 'default' },
    sessionHooks: new Map(),
    tasks: {},
    ...appStateOverride,
  }
  return {
    abortController: new AbortController(),
    agentId: undefined,
    getAppState: () => state,
    setAppState: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => {
      state = updater(state)
    },
    options: {
      tools: [],
      mainLoopModel: 'mock-model',
    },
    setResponseLength: updater => {
      responseLength = updater(responseLength)
    },
  } as unknown as ToolUseContext
}

afterEach(() => {
  __resetWebSocketHandlerStateForTests()
  migrationMaintenance.resetForTests()
  get3PModelCapabilityOverride.cache.clear?.()
  if (originalMacro === undefined) delete testGlobals.MACRO
  else testGlobals.MACRO = originalMacro
  mock.restore()
})

describe('Issue #1933 reproduction: /goal stop_generation, cross-process resume, and evaluator 400 loop', () => {
  describe('Chain 1: stop_generation does not clear /goal and allows background task-notification revival', () => {
    it('1A: WS handleStopGeneration forwards CLI Goal cleared during stop while suppressing stale Goal continuing', async () => {
      const sessionId = `repro-1933-ws-${crypto.randomUUID()}`
      const sent: Array<Record<string, unknown>> = []
      const ws: any = {
        data: {
          sessionId,
          channel: 'client',
          clientKind: 'full',
          connectedAt: Date.now(),
          sdkToken: null,
          serverPort: 0,
          serverHost: '127.0.0.1',
        },
        send: mock((payload: string) => sent.push(JSON.parse(payload))),
        close: mock(() => {}),
      }

      const callbacks = new Set<(message: any) => void>()
      spyOn(conversationService, 'hasSession').mockReturnValue(true)
      spyOn(conversationService, 'stopSession').mockImplementation(() => {})
      spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
      spyOn(computerUseApprovalService, 'getPendingRequests').mockReturnValue([])
      spyOn(conversationService, 'onOutput').mockImplementation((_id, cb) => {
        callbacks.add(cb)
      })
      spyOn(conversationService, 'removeOutputCallback').mockImplementation((_id, cb) => {
        callbacks.delete(cb)
      })
      const sendInterruptSpy = spyOn(conversationService, 'sendInterrupt').mockReturnValue(true)
      spyOn(conversationService, 'sendMessage').mockResolvedValue(true)
      spyOn(conversationService, 'requestControl').mockResolvedValue({})
      spyOn(sessionService, 'appendSessionTaskNotification').mockResolvedValue()
      spyOn(sessionService, 'getCustomTitle').mockResolvedValue('Existing title')
      spyOn(teamPlanRuntime, 'hasActiveTeamWorkForParent').mockReturnValue(false)

      const dispatch = (msg: any) => {
        for (const cb of [...callbacks]) cb(msg)
      }

      handleWebSocket.open(ws)
      handleWebSocket.message(ws, JSON.stringify({ type: 'user_message', content: 'run work' }))
      await flushMicrotasks()

      // Active CLI turn with a background shell task
      dispatch({ type: 'system', subtype: 'session_state_changed', state: 'running' })
      dispatch({
        type: 'system',
        subtype: 'task_started',
        task_id: 'bg-shell-1',
        tool_use_id: 'toolu_bg_1',
        task_type: 'local_bash',
      })

      // User clicks Stop Generation
      handleWebSocket.message(ws, JSON.stringify({ type: 'stop_generation' }))
      await flushMicrotasks()
      expect(sendInterruptSpy).toHaveBeenCalledWith(sessionId)

      // During the stop boundary, CLI emits Goal cleared (from interrupt handler)
      // and a stale Goal continuing from the interrupted turn must remain suppressed.
      dispatch({
        type: 'system',
        subtype: 'local_command_output',
        content: '<local-command-stdout>Goal cleared: complete task X</local-command-stdout>',
      })
      dispatch({
        type: 'system',
        subtype: 'local_command_output',
        content: '<local-command-stdout>Goal continuing: task still incomplete</local-command-stdout>',
      })
      dispatch({ type: 'result', subtype: 'success', is_error: false, result: '' })
      await flushMicrotasks()

      const goalClearedEvents = sent.filter(
        msg =>
          msg.type === 'system_notification' &&
          msg.subtype === 'goal_event' &&
          (msg.data as { action?: string } | undefined)?.action === 'cleared',
      )
      const goalContinuingEvents = sent.filter(
        msg =>
          msg.type === 'system_notification' &&
          msg.subtype === 'goal_event' &&
          (msg.data as { status?: string } | undefined)?.status === 'continuing',
      )

      expect({
        goalClearedCount: goalClearedEvents.length,
        goalContinuingCount: goalContinuingEvents.length,
      }).toEqual({
        goalClearedCount: 1,
        goalContinuingCount: 0,
      })
    })

    it(
      '1B (Experiment A): real headless CLI with /goal + background bash task wakes with ZERO human input after interrupt and loops via Goal continuing',
      async () => {
        const sandbox = createIsolatedSandbox('chain1-trigger')
        let releaseMidTurnStream: (() => void) | null = null
        let midTurnStreamOpened!: () => void
        const midTurnStreamReady = new Promise<void>(resolveReady => {
          midTurnStreamOpened = resolveReady
        })

        let interruptSent = false
        let mainCallsBeforeInterrupt = 0
        let mainCallsAfterInterrupt = 0
        let evalCallsAfterInterrupt = 0

        const server = startLoopbackAnthropicServer(req => {
          if (isGoalEvaluatorRequest(req)) {
            if (interruptSent) {
              evalCallsAfterInterrupt++
              // Return ok:false for the first 2 evaluations to prove continuation,
              // then ok:true on the 3rd so the test terminates deterministically.
              if (evalCallsAfterInterrupt <= 2) {
                return {
                  kind: 'message',
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        ok: false,
                        reason: 'task X still incomplete',
                      }),
                    },
                  ],
                }
              }
            }
            return {
              kind: 'message',
              content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
            }
          }

          if (interruptSent) {
            mainCallsAfterInterrupt++
            return {
              kind: 'message',
              content: [{ type: 'text', text: '已暂停，等你指示。' }],
            }
          }

          mainCallsBeforeInterrupt++
          if (mainCallsBeforeInterrupt === 1) {
            return {
              kind: 'message',
              stopReason: 'tool_use',
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_bg_bash_1933',
                  name: 'Bash',
                  input: {
                    command: 'sleep 1 && echo bg-finished-1933',
                    description: 'Run background test suite',
                    run_in_background: true,
                  },
                },
              ],
            }
          }

          // Second main call (after Bash tool_result): hold stream open until interrupted
          return {
            kind: 'message',
            content: [{ type: 'text', text: 'Working on task X...' }],
            onStreamOpened: () => midTurnStreamOpened(),
            holdUntilAborted: () =>
              new Promise<void>(resolveHold => {
                releaseMidTurnStream = resolveHold
                setTimeout(resolveHold, 10_000)
              }),
          }
        })

        const cli = spawnHeadlessCli({ sandbox, baseUrl: server.url })
        try {
          // Step 1: /goal sets shouldQuery: true, so this single user message sets
          // the goal AND starts Turn 1 (which spawns a background bash task and streams).
          cli.send({
            type: 'user',
            message: { role: 'user', content: '/goal complete task X' },
          })
          await cli.waitForEvent(
            ev => serializedEventText(ev).includes('Goal set: complete task X'),
            15_000,
            'Goal set output',
          )
          await midTurnStreamReady

          // Step 2: Send SDK interrupt control_request (exact payload sent by stop_generation)
          interruptSent = true
          cli.send({
            type: 'control_request',
            request_id: 'req-interrupt-1933',
            request: { subtype: 'interrupt' },
          })
          await cli.waitForEvent(
            ev =>
              ev.type === 'control_response' &&
              (ev.response as { request_id?: string } | undefined)?.request_id ===
                'req-interrupt-1933',
            10_000,
            'interrupt control_response',
          )
          await cli.waitForEvent(ev => ev.type === 'result', 10_000, 'interrupted turn result')
          releaseMidTurnStream?.()

          // Step 3: Send ZERO human input. Wait for background bash command to complete (~1s)
          // and observe whether CLI wakes up and emits Goal continuing.
          await Bun.sleep(2_500)

          const goalContinuingEvents = cli.events.filter(ev =>
            serializedEventText(ev).includes('Goal continuing:'),
          )

          // Expected fixed behavior: After user interrupt with zero further user input,
          // neither the main model nor Goal continuing should autonomously run.
          expect({
            mainCallsAfterInterrupt,
            evalCallsAfterInterrupt,
            goalContinuingCount: goalContinuingEvents.length,
          }).toEqual({
            mainCallsAfterInterrupt: 0,
            evalCallsAfterInterrupt: 0,
            goalContinuingCount: 0,
          })
        } finally {
          releaseMidTurnStream?.()
          await cli.close()
          await server.stop()
          sandbox.cleanup()
        }
      },
      30_000,
    )

    it(
      '1B (Experiment B control): real headless CLI with /goal and NO background task stays idle after interrupt',
      async () => {
        const sandbox = createIsolatedSandbox('chain1-control')
        let releaseMidTurnStream: (() => void) | null = null
        let midTurnStreamOpened!: () => void
        const midTurnStreamReady = new Promise<void>(resolveReady => {
          midTurnStreamOpened = resolveReady
        })

        let interruptSent = false
        let mainCallsAfterInterrupt = 0
        let evalCallsAfterInterrupt = 0

        const server = startLoopbackAnthropicServer(req => {
          if (isGoalEvaluatorRequest(req)) {
            if (interruptSent) {
              evalCallsAfterInterrupt++
              if (evalCallsAfterInterrupt >= 3) {
                return {
                  kind: 'message',
                  content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
                }
              }
            }
            return {
              kind: 'message',
              content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'incomplete' }) }],
            }
          }
          if (interruptSent) {
            mainCallsAfterInterrupt++
            return { kind: 'message', content: [{ type: 'text', text: 'unexpected' }] }
          }
          return {
            kind: 'message',
            content: [{ type: 'text', text: 'Working without background tasks...' }],
            onStreamOpened: () => midTurnStreamOpened(),
            holdUntilAborted: () =>
              new Promise<void>(resolveHold => {
                releaseMidTurnStream = resolveHold
                setTimeout(resolveHold, 10_000)
              }),
          }
        })

        const cli = spawnHeadlessCli({ sandbox, baseUrl: server.url })
        try {
          // /goal sets shouldQuery: true, so this single message starts Turn 1 directly.
          cli.send({
            type: 'user',
            message: { role: 'user', content: '/goal complete task X' },
          })
          await cli.waitForEvent(
            ev => serializedEventText(ev).includes('Goal set: complete task X'),
            15_000,
            'Goal set output',
          )
          await midTurnStreamReady

          interruptSent = true
          cli.send({
            type: 'control_request',
            request_id: 'req-interrupt-control',
            request: { subtype: 'interrupt' },
          })
          await cli.waitForEvent(
            ev =>
              ev.type === 'control_response' &&
              (ev.response as { request_id?: string } | undefined)?.request_id ===
                'req-interrupt-control',
            10_000,
            'interrupt control_response',
          )
          await cli.waitForEvent(ev => ev.type === 'result', 10_000, 'interrupted turn result')
          releaseMidTurnStream?.()

          await Bun.sleep(1_500)

          const goalContinuingEvents = cli.events.filter(ev =>
            serializedEventText(ev).includes('Goal continuing:'),
          )

          // Control confirmation: without a trigger (task-notification or user message),
          // /goal does NOT self-wake on a timer.
          expect({
            mainCallsAfterInterrupt,
            evalCallsAfterInterrupt,
            goalContinuingCount: goalContinuingEvents.length,
          }).toEqual({
            mainCallsAfterInterrupt: 0,
            evalCallsAfterInterrupt: 0,
            goalContinuingCount: 0,
          })
        } finally {
          releaseMidTurnStream?.()
          await cli.close()
          await server.stop()
          sandbox.cleanup()
        }
      },
      30_000,
    )
  })

  describe('Chain 2: cross-process --resume reactivates an interrupted /goal via ensureThreadGoalHookFromTranscript', () => {
    it('2A: ensureThreadGoalHookFromTranscript restores a goal from a transcript whose turn was interrupted by user', () => {
      const appState = { sessionHooks: new Map() } as AppState
      const context = {
        setAppState(updater: (prev: AppState) => AppState) {
          updater(appState)
        },
      }
      const threadId = `repro-1933-resume-unit-${crypto.randomUUID()}`

      const transcript = [
        createCommandInputMessage(
          '<command-name>/goal</command-name>\n<command-args>ship feature Y</command-args>',
        ),
        createCommandInputMessage('<local-command-stdout>Goal set: ship feature Y</local-command-stdout>'),
        createUserInterruptionMessage({ toolUse: false }),
      ]

      const restored = ensureThreadGoalHookFromTranscript(context, threadId, transcript)
      clearThreadGoalHook(context, threadId)

      // Expected fixed behavior: An interrupted goal without explicit resume should NOT
      // automatically reactivate from transcript on a fresh process.
      expect(restored).toBeNull()
    })

    it(
      '2B: brand-new CLI process using --resume after interrupt resurrects the stopped /goal on a normal chat message',
      async () => {
        const sandbox = createIsolatedSandbox('chain2-resume')
        let releaseMidTurnStream: (() => void) | null = null
        let midTurnStreamOpened!: () => void
        const midTurnStreamReady = new Promise<void>(resolveReady => {
          midTurnStreamOpened = resolveReady
        })

        let phase: 'process1' | 'process2' = 'process1'
        let process2EvalCalls = 0
        let process2MainCalls = 0

        const server = startLoopbackAnthropicServer(req => {
          if (isGoalEvaluatorRequest(req)) {
            if (phase === 'process2') {
              process2EvalCalls++
              if (process2EvalCalls === 1) {
                return {
                  kind: 'message',
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        ok: false,
                        reason: 'feature Y not done',
                      }),
                    },
                  ],
                }
              }
            }
            return {
              kind: 'message',
              content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
            }
          }

          if (phase === 'process1') {
            return {
              kind: 'message',
              content: [{ type: 'text', text: 'Starting feature Y...' }],
              onStreamOpened: () => midTurnStreamOpened(),
              holdUntilAborted: () =>
                new Promise<void>(resolveHold => {
                  releaseMidTurnStream = resolveHold
                  setTimeout(resolveHold, 10_000)
                }),
            }
          }

          process2MainCalls++
          return {
            kind: 'message',
            content: [{ type: 'text', text: '好的，先暂停随便聊聊。' }],
          }
        })

        let sessionId = ''
        const cli1 = spawnHeadlessCli({ sandbox, baseUrl: server.url })
        try {
          cli1.send({
            type: 'user',
            message: { role: 'user', content: '/goal ship feature Y' },
          })
          const goalEvent = await cli1.waitForEvent(
            ev => serializedEventText(ev).includes('Goal set: ship feature Y'),
            15_000,
            'process 1 Goal set',
          )
          sessionId = String(goalEvent.session_id ?? '')
          expect(sessionId.length).toBeGreaterThan(0)
          await midTurnStreamReady

          cli1.send({
            type: 'control_request',
            request_id: 'req-interrupt-p1',
            request: { subtype: 'interrupt' },
          })
          await cli1.waitForEvent(
            ev =>
              ev.type === 'control_response' &&
              (ev.response as { request_id?: string } | undefined)?.request_id ===
                'req-interrupt-p1',
            10_000,
            'process 1 interrupt response',
          )
          await cli1.waitForEvent(ev => ev.type === 'result', 10_000, 'process 1 interrupted result')
          releaseMidTurnStream?.()
        } finally {
          releaseMidTurnStream?.()
          await cli1.close()
        }

        // Process 2: brand new CLI process with --resume <sessionId>
        phase = 'process2'
        const cli2 = spawnHeadlessCli({
          sandbox,
          baseUrl: server.url,
          extraArgs: ['--resume', sessionId],
        })
        try {
          cli2.send({
            type: 'user',
            message: { role: 'user', content: '你好，随便聊一句' },
          })
          await cli2.waitForEvent(ev => ev.type === 'result', 15_000, 'process 2 result')

          const goalContinuingInProcess2 = cli2.events.filter(ev =>
            serializedEventText(ev).includes('Goal continuing:'),
          )

          // Expected fixed behavior: Resuming an interrupted session and sending a normal
          // message must NOT reactivate the stopped goal or fire Goal continuing.
          expect({
            process2MainCalls,
            process2EvalCalls,
            goalContinuingCount: goalContinuingInProcess2.length,
          }).toEqual({
            process2MainCalls: 1,
            process2EvalCalls: 0,
            goalContinuingCount: 0,
          })
        } finally {
          await cli2.close()
          await server.stop()
          sandbox.cleanup()
        }
      },
      30_000,
    )
  })

  describe('Chain 3: evaluator hardcoded thinking:disabled + HTTP 400 swallowed as invalid JSON + infinite continuation loop', () => {
    it('3A: execPromptHook sends thinking:disabled, swallows upstream HTTP 400 as invalid JSON, and returns blocking continuation', async () => {
      const savedEnv = {
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        ANTHROPIC_SMALL_FAST_MODEL: process.env.ANTHROPIC_SMALL_FAST_MODEL,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
        ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES:
          process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      }
      const sandbox = createIsolatedSandbox('chain3-unit')
      const upstream400Message =
        'reasoning effort "disabled" is not supported by the selected DSH model'

      const server = startLoopbackAnthropicServer(req => {
        if (req.body.thinking?.type === 'disabled') {
          return {
            kind: 'error',
            status: 400,
            errorType: 'invalid_request_error',
            message: upstream400Message,
          }
        }
        return {
          kind: 'message',
          content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
        }
      })

      const context = makeHookToolUseContext()
      const evalThreadId = `repro-1933-eval-${crypto.randomUUID()}`
      try {
        testGlobals.MACRO = { BUILD_TIME: '' }
        process.env.CLAUDE_CONFIG_DIR = sandbox.configDir
        process.env.ANTHROPIC_BASE_URL = server.url
        process.env.ANTHROPIC_API_KEY = 'mock-api-key'
        delete process.env.ANTHROPIC_SMALL_FAST_MODEL
        process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'loomy/DeepSeek-V4.1-Flash[1M]'
        process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES = 'thinking,effort'
        get3PModelCapabilityOverride.cache.clear?.()

        const goal = setThreadGoalHook(context, evalThreadId, 'finish task Z')

        const result = await execPromptHook(
          goal.hook,
          'Stop',
          'Stop',
          '{}',
          new AbortController().signal,
          context,
        )

        // Confirm the wire request actually sent hardcoded thinking: { type: 'disabled' }
        expect(server.requests.length).toBeGreaterThanOrEqual(1)
        expect(server.requests[0]?.body.thinking).toEqual({ type: 'disabled' })

        // Expected fixed behavior:
        // 1. Upstream HTTP 400 must NOT be turned into blocking continuation ("treat as incomplete and continue").
        // 2. Original upstream error must be preserved rather than swallowed as "response was not valid JSON".
        const attachmentStderr =
          result.message?.type === 'attachment' &&
          result.message.attachment.type === 'hook_non_blocking_error'
            ? result.message.attachment.stderr
            : ''
        expect({
          outcome: result.outcome,
          blockingError: result.blockingError?.blockingError ?? null,
          preservesUpstreamError: attachmentStderr.includes(upstream400Message),
        }).toEqual({
          outcome: 'non_blocking_error',
          blockingError: null,
          preservesUpstreamError: true,
        })
      } finally {
        clearThreadGoalHook(context, evalThreadId)
        for (const [key, value] of Object.entries(savedEnv)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        get3PModelCapabilityOverride.cache.clear?.()
        await server.stop()
        sandbox.cleanup()
      }
    })

    it('3B: handleStopHooks turns evaluator HTTP 400 into blockingErrors + Goal continuing instead of pausing/stopping', async () => {
      const savedEnv = {
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        ANTHROPIC_SMALL_FAST_MODEL: process.env.ANTHROPIC_SMALL_FAST_MODEL,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
        ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES:
          process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      }
      const prevInteractive = getIsInteractive()
      const prevSessionId = getSessionId()
      const sandbox = createIsolatedSandbox('chain3-stophooks')
      const server = startLoopbackAnthropicServer(req => {
        if (req.body.thinking?.type === 'disabled') {
          return {
            kind: 'error',
            status: 400,
            errorType: 'invalid_request_error',
            message: 'reasoning effort "disabled" is not supported by the selected DSH model',
          }
        }
        return {
          kind: 'message',
          content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
        }
      })

      const threadId = `repro-1933-stophook-${crypto.randomUUID()}` as SessionId
      const context = makeHookToolUseContext()
      try {
        testGlobals.MACRO = { BUILD_TIME: '' }
        setIsInteractive(false)
        switchSession(threadId)
        process.env.CLAUDE_CONFIG_DIR = sandbox.configDir
        process.env.ANTHROPIC_BASE_URL = server.url
        process.env.ANTHROPIC_API_KEY = 'mock-api-key'
        delete process.env.ANTHROPIC_SMALL_FAST_MODEL
        process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'loomy/DeepSeek-V4.1-Flash[1M]'
        process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES = 'thinking,effort'
        get3PModelCapabilityOverride.cache.clear?.()

        setThreadGoalHook(context, threadId, 'finish task Z')

        const yielded: unknown[] = []
        const gen = handleStopHooks([], [], [] as never, {}, {}, context, 'sdk')
        let step = await gen.next()
        while (!step.done) {
          yielded.push(step.value)
          step = await gen.next()
        }

        // Expected fixed behavior: Evaluator API 400 failure must NOT return blockingErrors
        // with preventContinuation=false (which drives query.ts's infinite continue loop),
        // and must NOT emit "Goal continuing: Goal evaluator failed: response was not valid JSON".
        expect({
          blockingErrorsCount: step.value.blockingErrors.length,
          preventContinuation: step.value.preventContinuation,
          emittedGoalContinuing: JSON.stringify(yielded).includes(
            'Goal continuing: Goal evaluator failed:',
          ),
        }).toEqual({
          blockingErrorsCount: 0,
          preventContinuation: expect.any(Boolean),
          emittedGoalContinuing: false,
        })
      } finally {
        clearThreadGoalHook(context, threadId)
        switchSession(prevSessionId)
        setIsInteractive(prevInteractive)
        for (const [key, value] of Object.entries(savedEnv)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        get3PModelCapabilityOverride.cache.clear?.()
        await server.stop()
        sandbox.cleanup()
      }
    })

    it(
      '3C: real headless CLI loops repeatedly with Goal continuing when evaluator hits HTTP 400 on thinking:disabled',
      async () => {
        const sandbox = createIsolatedSandbox('chain3-cli-loop')
        let mainCalls = 0
        let eval400Count = 0

        const server = startLoopbackAnthropicServer(req => {
          if (isGoalEvaluatorRequest(req)) {
            if (req.body.thinking?.type === 'disabled' && eval400Count < 3) {
              eval400Count++
              return {
                kind: 'error',
                status: 400,
                errorType: 'invalid_request_error',
                message: 'reasoning effort "disabled" is not supported by the selected DSH model',
              }
            }
            return {
              kind: 'message',
              content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
            }
          }
          mainCalls++
          return {
            kind: 'message',
            content: [{ type: 'text', text: `Main reply #${mainCalls}` }],
          }
        })

        const cli = spawnHeadlessCli({
          sandbox,
          baseUrl: server.url,
          extraEnv: {
            ANTHROPIC_SMALL_FAST_MODEL: undefined,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'loomy/DeepSeek-V4.1-Flash[1M]',
            ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES: 'thinking,effort',
          },
        })
        try {
          cli.send({
            type: 'user',
            message: { role: 'user', content: '/goal finish task Z' },
          })
          await cli.waitForEvent(
            ev => serializedEventText(ev).includes('Goal set: finish task Z'),
            15_000,
            'Goal set output',
          )
          await cli.waitForEvent(ev => ev.type === 'result', 20_000, 'turn result')

          const goalContinuingJsonErrors = cli.events.filter(ev =>
            serializedEventText(ev).includes('Goal continuing: Goal evaluator failed: response was not valid JSON'),
          )

          // Expected fixed behavior: evaluator must not hit repeated 400s and loop
          // main model calls via "Goal continuing: Goal evaluator failed: response was not valid JSON".
          expect({
            eval400Count,
            mainCalls,
            goalContinuingJsonErrorCount: goalContinuingJsonErrors.length,
          }).toEqual({
            eval400Count: 0,
            mainCalls: 1,
            goalContinuingJsonErrorCount: 0,
          })
        } finally {
          await cli.close()
          await server.stop()
          sandbox.cleanup()
        }
      },
      30_000,
    )
  })
})
