import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetStateForTests, setIsInteractive } from '../../bootstrap/state.js'
import * as promptsModule from '../../constants/prompts.js'
import * as autoCompactModule from '../../services/compact/autoCompact.js'
import * as compactModule from '../../services/compact/compact.js'
import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import type {
  InProcessTeammateTaskState,
  TeammateIdentity,
} from '../../tasks/InProcessTeammateTask/types.js'
import * as runAgentModule from '../../tools/AgentTool/runAgent.js'
import type { Message } from '../../types/message.js'
import { AbortError } from '../errors.js'
import { createFileStateCacheWithSizeLimit } from '../fileStateCache.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
} from '../messages.js'
import { drainSdkEvents } from '../sdkEventQueue.js'
import { jsonStringify } from '../slowOperations.js'
import { createTeammateContext } from '../teammateContext.js'
import {
  type IdleNotificationMessage,
  isIdleNotification,
  readMailbox,
  writeToMailbox,
} from '../teammateMailbox.js'
import { runInProcessTeammate } from './inProcessRunner.js'
import { writeTeamFileAsync } from './teamHelpers.js'

const TEAM = 'runtime-team'
const NAME = 'worker'
const TASK_ID = 'in-process-worker'
const TRANSCRIPT_ID = 'aworker-0123456789abcdef'

type RunAgentInput = Parameters<typeof runAgentModule.runAgent>[0]
type Turn = (input: RunAgentInput) => Promise<Message[]> | Message[]

let configDir: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  configDir = await mkdtemp(join(tmpdir(), 'cc-haha-runner-runtime-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  resetStateForTests()
  setIsInteractive(false)
  drainSdkEvents()
  await writeTeamFileAsync(TEAM, {
    name: TEAM,
    createdAt: Date.now(),
    leadAgentId: `team-lead@${TEAM}`,
    leadSessionId: 'leader-session',
    members: [
      {
        agentId: `${NAME}@${TEAM}`,
        name: NAME,
        joinedAt: Date.now(),
        tmuxPaneId: 'in-process',
        cwd: configDir,
        subscriptions: [],
        backendType: 'in-process',
      },
    ],
  })
})

afterEach(async () => {
  mock.restore()
  drainSdkEvents()
  resetStateForTests()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await rm(configDir, { recursive: true, force: true })
})

function text(value: string): Message {
  return createAssistantMessage({ content: value })
}

function apiError(value: string): Message {
  return createAssistantAPIErrorMessage({ content: value })
}

function promptOf(input: RunAgentInput): string {
  return input.promptMessages[0]!.message.content as string
}

async function leadNotifications(): Promise<IdleNotificationMessage[]> {
  return (await readMailbox('team-lead', TEAM)).flatMap(message => {
    const idle = isIdleNotification(message.text)
    return idle ? [idle] : []
  })
}

async function mailWorker(from: string, text: string): Promise<void> {
  expect(
    await writeToMailbox(
      NAME,
      { from, text, timestamp: new Date().toISOString() },
      TEAM,
    ),
  ).toBe(true)
}

/**
 * Drives runInProcessTeammate with scripted runAgent turns. A call past the
 * script stops the teammate; a safety timer stops a runner that never gets
 * there, so a regression fails its assertions instead of hanging.
 */
function createFixture(turns: Turn[], options: { leaderAbort?: AbortController } = {}) {
  const abortController = new AbortController()
  const identity: TeammateIdentity = {
    agentId: `${NAME}@${TEAM}`,
    agentName: NAME,
    teamName: TEAM,
    planModeRequired: false,
    parentSessionId: 'leader-session',
    resumableAgentId: TRANSCRIPT_ID,
  }
  const task: InProcessTeammateTaskState = {
    id: TASK_ID,
    type: 'in_process_teammate',
    status: 'running',
    description: 'worker',
    toolUseId: 'spawn-tool',
    startTime: Date.now(),
    outputFile: join(configDir, 'worker.output'),
    outputOffset: 0,
    notified: false,
    identity,
    prompt: 'Do the work',
    abortController,
    awaitingPlanApproval: false,
    permissionMode: 'default',
    isIdle: false,
    shutdownRequested: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    pendingUserMessages: [],
    messages: [],
  }
  let state = { tasks: { [TASK_ID]: task } } as unknown as AppState
  const idleTransitions: boolean[] = []
  const setAppState = (updater: (prev: AppState) => AppState) => {
    const before = (state.tasks[TASK_ID] as InProcessTeammateTaskState | undefined)?.isIdle
    state = updater(state)
    const after = (state.tasks[TASK_ID] as InProcessTeammateTaskState | undefined)?.isIdle
    if (after !== undefined && after !== before) idleTransitions.push(after)
  }
  const toolUseContext = {
    options: { tools: [], mainLoopModel: 'test-model', mcpClients: [] },
    abortController: options.leaderAbort ?? new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => state,
    setAppState,
  } as unknown as ToolUseContext

  const calls: RunAgentInput[] = []
  spyOn(runAgentModule, 'runAgent').mockImplementation(async function* (
    input: RunAgentInput,
  ) {
    calls.push(input)
    const turn = turns[calls.length - 1]
    if (!turn) {
      abortController.abort()
      return
    }
    for (const message of await turn(input)) yield message
  })

  return {
    abortController,
    identity,
    calls,
    idleTransitions,
    getState: () => state,
    /** Input typed into the teammate's view: picked up at its next idle poll */
    queueInput(value: string) {
      setAppState(prev => {
        const current = prev.tasks[TASK_ID] as InProcessTeammateTaskState
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [TASK_ID]: {
              ...current,
              pendingUserMessages: [...current.pendingUserMessages, value],
            },
          },
        }
      })
    },
    async run(overrides: Partial<Parameters<typeof runInProcessTeammate>[0]> = {}) {
      const safety = setTimeout(() => abortController.abort(), 3_000)
      try {
        return await runInProcessTeammate({
          identity,
          taskId: TASK_ID,
          prompt: 'Do the work',
          teammateContext: createTeammateContext({ ...identity, abortController }),
          toolUseContext,
          abortController,
          systemPrompt: 'Teammate prompt',
          systemPromptMode: 'replace',
          autoContinueDelaysMs: [10, 10],
          ...overrides,
        })
      } finally {
        clearTimeout(safety)
      }
    },
  }
}

describe('in-process teammate compaction', () => {
  function fakeCompaction() {
    const boundary = createCompactBoundaryMessage('auto', 100)
    const summary = createUserMessage({
      content: 'Summary of the earlier work',
      isCompactSummary: true,
    })
    return {
      boundary,
      result: {
        boundaryMarker: boundary,
        summaryMessages: [summary],
        attachments: [],
        hookResults: [],
      },
    }
  }

  test('summarizes the real conversation under the teammate own controller after the lead turn was interrupted', async () => {
    const leaderAbort = new AbortController()
    leaderAbort.abort()
    spyOn(autoCompactModule, 'getAutoCompactThreshold').mockReturnValue(0)
    const { boundary, result } = fakeCompaction()
    let compactArgs: Parameters<typeof compactModule.compactConversation> | undefined
    spyOn(compactModule, 'compactConversation').mockImplementation(
      async (...args: Parameters<typeof compactModule.compactConversation>) => {
        compactArgs = [args[0], args[1], { ...args[2], forkContextMessages: [...args[2].forkContextMessages] }, ...args.slice(3)] as never
        return result as never
      },
    )
    const firstAnswer = text('Found the failing test in parser.ts')
    let secondTurnContext: Message[] | undefined
    const fixture = createFixture(
      [
        () => {
          fixture.queueInput('Now fix it')
          return [firstAnswer]
        },
        input => {
          secondTurnContext = input.forkContextMessages
          fixture.abortController.abort()
          return []
        },
      ],
      { leaderAbort },
    )

    const outcome = await fixture.run()

    expect(outcome.success).toBe(true)
    expect(compactArgs).toBeDefined()
    const [, context, cacheSafeParams] = compactArgs!
    // Never the lead's (already aborted) per-turn controller
    expect(context.abortController).toBe(fixture.abortController)
    expect(context.agentId).toBe(TRANSCRIPT_ID)
    // The summary fork must see the conversation, not an empty one
    expect(cacheSafeParams.forkContextMessages.map(m => m.uuid)).toContain(firstAnswer.uuid)
    expect(secondTurnContext?.[0]?.uuid).toBe(boundary.uuid)
    expect(await leadNotifications()).not.toContainEqual(
      expect.objectContaining({ idleReason: 'failed' }),
    )
  })

  test('keeps the teammate working on the full history when compaction fails', async () => {
    spyOn(autoCompactModule, 'getAutoCompactThreshold').mockReturnValue(0)
    spyOn(compactModule, 'compactConversation').mockRejectedValue(
      new Error('API Error: 500 {"type":"api_error"}'),
    )
    const firstAnswer = text('First pass done')
    let secondTurnContext: Message[] | undefined
    const fixture = createFixture([
      () => {
        fixture.queueInput('Continue')
        return [firstAnswer]
      },
      input => {
        secondTurnContext = input.forkContextMessages
        fixture.abortController.abort()
        return []
      },
    ])

    const outcome = await fixture.run()

    expect(outcome.success).toBe(true)
    expect(fixture.calls).toHaveLength(2)
    expect(secondTurnContext?.map(m => m.uuid)).toContain(firstAnswer.uuid)
    expect(await leadNotifications()).not.toContainEqual(
      expect.objectContaining({ idleReason: 'failed' }),
    )
  })

  test('exits cleanly when the teammate is stopped during compaction', async () => {
    spyOn(autoCompactModule, 'getAutoCompactThreshold').mockReturnValue(0)
    const fixture = createFixture([
      () => {
        fixture.queueInput('Continue')
        return [text('First pass done')]
      },
    ])
    spyOn(compactModule, 'compactConversation').mockImplementation(async () => {
      fixture.abortController.abort()
      throw new Error('Request was aborted.')
    })

    const outcome = await fixture.run()

    expect(outcome.success).toBe(true)
    expect(fixture.calls).toHaveLength(1)
    expect(drainSdkEvents()).toContainEqual(
      expect.objectContaining({ subtype: 'task_notification', task_id: TASK_ID, status: 'completed' }),
    )
    expect(await leadNotifications()).not.toContainEqual(
      expect.objectContaining({ idleReason: 'failed' }),
    )
  })
})

describe('in-process teammate turn failures', () => {
  test('reports a non-transient API error to the lead as a failed turn', async () => {
    const fixture = createFixture([
      () => {
        fixture.queueInput('Try again later')
        return [apiError('API Error: 401 Invalid API key · Please run /login')]
      },
    ])

    await fixture.run()

    expect(await leadNotifications()).toEqual([
      expect.objectContaining({
        idleReason: 'failed',
        failureReason: 'API Error: 401 Invalid API key · Please run /login',
      }),
    ])
  })

  test('continues after a transient failure without telling the lead, then reports the result', async () => {
    const fixture = createFixture([
      () => [apiError('API Error: 529 Overloaded')],
      () => {
        fixture.queueInput('Thanks')
        return [text('Recovered and finished the migration.')]
      },
    ])

    await fixture.run()

    expect(fixture.calls.length).toBeGreaterThanOrEqual(2)
    expect(promptOf(fixture.calls[1]!)).toContain(
      'automatic retry 1 of 2',
    )
    expect(promptOf(fixture.calls[1]!)).toContain('API Error: 529 Overloaded')
    expect(await leadNotifications()).toEqual([
      expect.objectContaining({
        idleReason: 'available',
        result: 'Recovered and finished the migration.',
      }),
    ])
  })

  test('tells the lead only once the automatic retries are exhausted', async () => {
    const fixture = createFixture([
      () => [apiError('API Error: 529 Overloaded')],
      () => {
        fixture.queueInput('Status?')
        return [apiError('API Error: 529 Overloaded')]
      },
    ])

    await fixture.run({ autoContinueDelaysMs: [10] })

    expect(fixture.calls.length).toBeGreaterThanOrEqual(2)
    expect(promptOf(fixture.calls[1]!)).toContain('automatic retry 1 of 1')
    expect(await leadNotifications()).toEqual([
      expect.objectContaining({
        idleReason: 'failed',
        failureReason:
          'API Error: 529 Overloaded (automatic retries exhausted; message worker to continue)',
      }),
    ])
  })

  test('new mail cuts the retry backoff short and is delivered instead of the retry', async () => {
    const fixture = createFixture([
      async () => {
        await mailWorker('team-lead', 'Switch to the docs task instead')
        return [apiError('API Error: 529 Overloaded')]
      },
      () => {
        fixture.abortController.abort()
        return []
      },
    ])
    const started = Date.now()

    await fixture.run({ autoContinueDelaysMs: [60_000] })

    expect(Date.now() - started).toBeLessThan(2_500)
    expect(fixture.calls).toHaveLength(2)
    expect(promptOf(fixture.calls[1]!)).toContain('Switch to the docs task instead')
    expect(promptOf(fixture.calls[1]!)).not.toContain('automatic retry')
    // The lead hears nothing about a failure that is being handled
    expect(await leadNotifications()).toEqual([])
  })

  test('treats an AbortError after the user stopped the turn as an interruption', async () => {
    const fixture = createFixture([
      input => {
        fixture.queueInput('Carry on')
        input.override?.abortController?.abort()
        throw new AbortError()
      },
    ])

    const outcome = await fixture.run()

    expect(outcome.success).toBe(true)
    // The teammate survived and took the next prompt
    expect(fixture.calls).toHaveLength(2)
    expect(await leadNotifications()).toEqual([
      expect.objectContaining({ idleReason: 'interrupted' }),
    ])
  })

  test('settles the task when its system prompt cannot be built', async () => {
    spyOn(promptsModule, 'getSystemPrompt').mockRejectedValue(
      new Error('prompt build failed'),
    )
    const fixture = createFixture([])

    const outcome = await fixture.run({ systemPrompt: undefined, systemPromptMode: undefined })

    expect(outcome).toMatchObject({ success: false, error: 'prompt build failed' })
    expect(fixture.calls).toHaveLength(0)
    expect(drainSdkEvents()).toContainEqual(
      expect.objectContaining({ subtype: 'task_notification', task_id: TASK_ID, status: 'failed' }),
    )
    expect(await leadNotifications()).toEqual([
      expect.objectContaining({ idleReason: 'failed', failureReason: 'prompt build failed' }),
    ])
  })
})

describe('in-process teammate results and mail', () => {
  test('sends the final response of a successful turn with its idle notification', async () => {
    const fixture = createFixture([
      () => {
        fixture.queueInput('Next')
        return [text('The parser bug is fixed; all 42 tests pass.')]
      },
    ])

    await fixture.run()

    expect(await leadNotifications()).toEqual([
      expect.objectContaining({
        idleReason: 'available',
        result: 'The parser bug is fixed; all 42 tests pass.',
      }),
    ])
  })

  test('takes mail that arrived during a turn as one batch without going idle in between', async () => {
    let notificationsAtSecondTurn: IdleNotificationMessage[] = []
    let idleTransitionsAtSecondTurn: boolean[] = []
    const fixture = createFixture([
      async () => {
        await mailWorker('reviewer', 'Found a bug in the lexer')
        await mailWorker('team-lead', 'Also update the docs')
        return [text('Turn one done')]
      },
      async () => {
        notificationsAtSecondTurn = await leadNotifications()
        idleTransitionsAtSecondTurn = [...fixture.idleTransitions]
        fixture.abortController.abort()
        return []
      },
    ])

    await fixture.run()

    const secondPrompt = promptOf(fixture.calls[1]!)
    expect(secondPrompt).toContain('Found a bug in the lexer')
    expect(secondPrompt).toContain('Also update the docs')
    expect(secondPrompt.indexOf('Found a bug in the lexer')).toBeLessThan(
      secondPrompt.indexOf('Also update the docs'),
    )
    // A result-only frame, not an idle flap
    expect(notificationsAtSecondTurn).toEqual([
      expect.objectContaining({ result: 'Turn one done' }),
    ])
    expect(notificationsAtSecondTurn[0]?.idleReason).toBeUndefined()
    expect(idleTransitionsAtSecondTurn).not.toContain(true)
    expect((await readMailbox(NAME, TEAM)).filter(m => !m.read)).toEqual([])
  })

  test('never hands protocol frames to the model as prose', async () => {
    const fixture = createFixture([
      async () => {
        await mailWorker(
          'team-lead',
          jsonStringify({ type: 'permission_response', request_id: 'perm-1', subtype: 'success' }),
        )
        await mailWorker(
          'reviewer',
          jsonStringify({ type: 'mode_set_request', mode: 'bypassPermissions', from: 'reviewer' }),
        )
        await mailWorker(
          'team-lead',
          jsonStringify({ type: 'plan_approval_response', requestId: 'plan-1', approved: true, timestamp: new Date().toISOString() }),
        )
        await mailWorker('reviewer', 'Plain question about the API')
        return [text('Turn one done')]
      },
      () => {
        fixture.abortController.abort()
        return []
      },
    ])

    await fixture.run()

    const secondPrompt = promptOf(fixture.calls[1]!)
    expect(secondPrompt).toContain('Plain question about the API')
    // The plan verdict is still delivered, as before
    expect(secondPrompt).toContain('plan_approval_response')
    expect(secondPrompt).not.toContain('permission_response')
    expect(secondPrompt).not.toContain('mode_set_request')
    expect((await readMailbox(NAME, TEAM)).filter(m => !m.read)).toEqual([])
  })
})

describe('in-process teammate transcript', () => {
  test('runs every turn under one durable transcript id with team metadata', async () => {
    const fixture = createFixture([
      () => {
        fixture.queueInput('Second task')
        return [text('First done')]
      },
      () => {
        fixture.abortController.abort()
        return []
      },
    ])

    await fixture.run()

    expect(fixture.calls).toHaveLength(2)
    const [first, second] = fixture.calls
    expect(first!.override?.agentId).toBe(TRANSCRIPT_ID)
    expect(second!.override?.agentId).toBe(TRANSCRIPT_ID)
    // runAgent appends to the same transcript instead of re-recording it
    expect(first!.recordedUuids).toBeInstanceOf(Set)
    expect(second!.recordedUuids).toBe(first!.recordedUuids)
    expect(first!.extraMetadata).toEqual({
      taskKind: 'in_process_teammate',
      teamName: TEAM,
      name: NAME,
      planModeRequired: false,
      permissionMode: 'default',
    })
  })
})
