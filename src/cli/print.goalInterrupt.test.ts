import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'

const home = mkdtempSync(join(tmpdir(), 'goal-interrupt-'))
const originalEnv = { ...process.env }
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(
  process.env,
  createSandboxedTestEnvironment(home, { CLAUDE_CODE_SIMPLE: '1' }, originalEnv),
)

const prompts: string[] = []
let askHandler: (params: {
  prompt: unknown
  abortController?: AbortController
}) => AsyncGenerator<Record<string, unknown>> = async function* (params) {
  prompts.push(
    typeof params.prompt === 'string'
      ? params.prompt
      : JSON.stringify(params.prompt),
  )
}

const queryEngine = await import('../QueryEngine.js')
const originalQueryEngine = { ...queryEngine }
mock.module('../QueryEngine.js', () => ({
  ...queryEngine,
  ask: async function* (params: {
    prompt: unknown
    abortController?: AbortController
  }) {
    yield* askHandler(params)
  },
}))

const { __runHeadlessStreamingForTests } = await import('./print.js')
const { StructuredIO } = await import('./structuredIO.js')
const { Stream } = await import('../utils/stream.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const {
  clearCommandQueue,
  enqueuePendingNotification,
  getCommandQueue,
  recheckCommandQueue,
} = await import('../utils/messageQueueManager.js')
const {
  getIsInteractive,
  getOriginalCwd,
  getSessionId,
  setIsInteractive,
  setOriginalCwd,
} = await import('../bootstrap/state.js')
const { clearThreadGoalHook, getThreadGoal, setThreadGoalHook } = await import(
  '../goals/goalState.js'
)
const { createCommandInputMessage } = await import('../utils/messages.js')

const wasInteractive = getIsInteractive()
const prevOriginalCwd = getOriginalCwd()
setIsInteractive(false)
setOriginalCwd(home)

afterAll(() => {
  mock.module('../QueryEngine.js', () => originalQueryEngine)
  clearCommandQueue()
  setIsInteractive(wasInteractive)
  setOriginalCwd(prevOriginalCwd)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  rmSync(home, { recursive: true, force: true })
})

beforeEach(() => {
  prompts.length = 0
  clearCommandQueue()
  askHandler = async function* (params) {
    prompts.push(
      typeof params.prompt === 'string'
        ? params.prompt
        : JSON.stringify(params.prompt),
    )
  }
})

async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done() && Date.now() < deadline) await Bun.sleep(20)
  expect(done()).toBe(true)
}

function startHarness(initialMessages: unknown[] = []) {
  let state = getDefaultAppState()
  const input = new Stream<string>()
  const events: Array<Record<string, unknown>> = []
  const responses = new Set<string>()
  const output = __runHeadlessStreamingForTests(
    new StructuredIO(input),
    [],
    [],
    [],
    initialMessages as never,
    (() => undefined) as never,
    {},
    () => state,
    update => {
      state = update(state)
    },
    [],
    { outputFormat: 'stream-json' } as never,
  )
  const drained = (async () => {
    for await (const message of output) {
      const ev = message as Record<string, unknown>
      events.push(ev)
      if (
        ev.type === 'control_response' &&
        (ev.response as { request_id?: string } | undefined)?.request_id
      ) {
        responses.add((ev.response as { request_id: string }).request_id)
      }
    }
  })()
  const send = (message: unknown) => input.enqueue(`${JSON.stringify(message)}\n`)
  return {
    getState: () => state,
    setState: (updater: (prev: typeof state) => typeof state) => {
      state = updater(state)
    },
    events,
    say: (content: string) =>
      send({ type: 'user', message: { role: 'user', content } }),
    async control(subtype: string) {
      const id = `${subtype}-${Math.random()}`
      send({ type: 'control_request', request_id: id, request: { subtype } })
      await until(() => responses.has(id))
    },
    async close() {
      input.done()
      await drained
      clearCommandQueue()
    },
  }
}

test('interrupt clears active goal, cancels queued and late task notifications, and resumes on next user turn', async () => {
  const initialMessages = [
    createCommandInputMessage('<local-command-stdout>Goal set: ship feature</local-command-stdout>'),
  ]
  const harness = startHarness(initialMessages)
  const sessionId = getSessionId()
  try {
    setThreadGoalHook({ setAppState: harness.setState as never }, sessionId, 'ship feature')
    expect(getThreadGoal(sessionId)?.objective).toBe('ship feature')

    // Queue both a task-notification and a follow-up prompt originating from a task-notification
    enqueuePendingNotification({
      mode: 'task-notification',
      value:
        '<task-notification><task-id>bg-queued</task-id><status>completed</status><summary>queued done</summary></task-notification>',
      uuid: 'notif-queued-1',
    })
    enqueuePendingNotification({
      mode: 'prompt',
      value: 'deferred agent notification follow-up',
      origin: { kind: 'task-notification' },
      uuid: 'notif-origin-1',
    })
    expect(getCommandQueue()).toHaveLength(2)

    await harness.control('interrupt')

    expect(getThreadGoal(sessionId)).toBeNull()
    expect(getCommandQueue()).toHaveLength(0)
    expect(
      harness.events.some(
        ev =>
          ev.type === 'system' &&
          ev.subtype === 'local_command_output' &&
          String(ev.content ?? '').includes('Goal cleared: ship feature'),
      ),
    ).toBe(true)
    expect(
      harness.events.some(
        ev =>
          ev.type === 'system' &&
          ev.subtype === 'task_notification' &&
          ev.task_id === 'bg-queued',
      ),
    ).toBe(true)

    // A late task notification arriving after interrupt must publish its SDK
    // lifecycle event but must NOT start a model turn while suppressed.
    enqueuePendingNotification({
      mode: 'task-notification',
      value:
        '<task-notification><task-id>bg-late</task-id><status>completed</status><summary>late done</summary></task-notification>',
      uuid: 'notif-late-1',
    })
    recheckCommandQueue()
    await until(() =>
      harness.events.some(
        ev =>
          ev.type === 'system' &&
          ev.subtype === 'task_notification' &&
          ev.task_id === 'bg-late',
      ),
    )
    await Bun.sleep(100)
    expect(prompts).toEqual([])

    // A fresh user message re-enables normal turns and clears suppression.
    harness.say('resume normally')
    await until(() => prompts.length === 1)
    expect(prompts).toEqual(['resume normally'])
  } finally {
    clearThreadGoalHook({ setAppState: harness.setState as never }, sessionId)
    await harness.close()
  }
}, 20_000)

test('in-flight interrupt defers Goal cleared transcript persistence until ask yields result', async () => {
  const initialMessages: unknown[] = []
  let enteredAsk!: () => void
  const askStarted = new Promise<void>(resolve => {
    enteredAsk = resolve
  })
  let sawAbort = false
  askHandler = async function* ({ prompt, abortController }) {
    prompts.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt))
    enteredAsk()
    await new Promise<void>(resolve => {
      if (abortController?.signal.aborted) {
        sawAbort = true
        resolve()
        return
      }
      abortController?.signal.addEventListener(
        'abort',
        () => {
          sawAbort = true
          // Simulate a background task completing right as the interrupted turn
          // winds down so drainCommandQueue dequeues it while suppressed.
          enqueuePendingNotification({
            mode: 'task-notification',
            value:
              '<task-notification><task-id>bg-mid-abort</task-id><status>completed</status><summary>mid-abort done</summary></task-notification>',
            uuid: 'notif-mid-abort-1',
          })
          resolve()
        },
        { once: true },
      )
    })
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 0,
      num_turns: 1,
      result: '',
      session_id: getSessionId(),
      total_cost_usd: 0,
      usage: {},
    }
  }

  const harness = startHarness(initialMessages)
  const sessionId = getSessionId()
  try {
    setThreadGoalHook({ setAppState: harness.setState as never }, sessionId, 'in-flight goal')
    harness.say('start working')
    await askStarted

    await harness.control('interrupt')
    await until(() => harness.events.some(ev => ev.type === 'result'))
    await until(() => getCommandQueue().length === 0)

    expect(sawAbort).toBe(true)
    expect(prompts).toEqual(['start working'])
    expect(getThreadGoal(sessionId)).toBeNull()
    expect(
      harness.events.some(
        ev =>
          ev.type === 'system' &&
          ev.subtype === 'task_notification' &&
          ev.task_id === 'bg-mid-abort',
      ),
    ).toBe(true)
    expect(
      harness.events.some(
        ev =>
          ev.type === 'system' &&
          ev.subtype === 'local_command_output' &&
          String(ev.content ?? '').includes('Goal cleared: in-flight goal'),
      ),
    ).toBe(true)
    expect(
      JSON.stringify(initialMessages).includes('Goal cleared: in-flight goal'),
    ).toBe(true)
  } finally {
    clearThreadGoalHook({ setAppState: harness.setState as never }, sessionId)
    await harness.close()
  }
}, 20_000)
