import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import * as tasks from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { AbortError } from '../../utils/errors.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { asAgentId } from '../../types/ids.js'
import * as sessionStorage from '../../utils/sessionStorage.js'
import { SendMessageTool } from '../SendMessageTool/SendMessageTool.js'
import { getMaxConcurrentSubagentsUncached, getSettingsForSource } from '../../utils/settings/settings.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { SettingsSchema } from '../../utils/settings/types.js'
import * as worktree from '../../utils/worktree.js'
import * as prompts from '../../constants/prompts.js'
import * as teams from '../shared/spawnMultiAgent.js'
import * as swarms from '../../utils/agentSwarmsEnabled.js'
import { getTeamFilePath } from '../../utils/swarm/teamHelpers.js'
import { AgentTool } from './AgentTool.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import * as agentRunner from './runAgent.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

// 受控流，同时模拟转后台时对前台迭代器的清理。
function controlledStream() {
  const terminal = deferred<Error | undefined>()
  const started = deferred<void>()
  let emitted = false
  let returned = false
  const stream = {
    async next() {
      started.resolve()
      const error = await terminal.promise
      if (returned || emitted) return { done: true as const, value: undefined }
      if (error) throw error
      emitted = true
      return { done: false as const, value: createAssistantMessage({ content: 'Finished fixture task.' }) as Message }
    },
    async return() {
      returned = true
      terminal.resolve(undefined)
      return { done: true as const, value: undefined }
    },
    async throw(error: Error) { throw error },
    [Symbol.asyncIterator]() { return this },
  } as AsyncGenerator<Message, void>
  return { stream, started: started.promise, finish: terminal.resolve, wasReturned: () => returned }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const originalConfig = process.env.CLAUDE_CONFIG_DIR
let configDir: string
let streams: ReturnType<typeof controlledStream>[]
let pending: Promise<unknown>[]
let runnerSpy: ReturnType<typeof spyOn<typeof agentRunner, 'runAgent'>>
let prepSpy: ReturnType<typeof spyOn<typeof prompts, 'enhanceSystemPromptWithEnvDetails'>>
let context: ToolUseContext
let backgroundSignals: Map<string, () => void>

function setLimit(limit?: number | null) {
  // 刻意不清缓存：桌面设置写入来自另一个进程。
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(limit === undefined ? {} : { maxConcurrentSubagents: limit }))
}

function addStream() {
  const control = controlledStream()
  streams.push(control)
  runnerSpy.mockImplementationOnce(() => control.stream)
  return control
}

function spawn(background = false, overrides: Record<string, unknown> = {}, ctx = context) {
  const promise = AgentTool.call({
    description: 'Controlled fixture task',
    prompt: 'Complete this fixture task.',
    subagent_type: GENERAL_PURPOSE_AGENT.agentType,
    run_in_background: background,
    ...overrides,
  }, ctx, (async () => ({ behavior: 'allow' })) as never,
  createAssistantMessage({ content: 'Start a fixture worker.' }))
  pending.push(promise.catch(() => {}))
  return promise
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'cc-haha-agent-concurrency-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  resetSettingsCache()
  setLimit(1)
  streams = []
  pending = []
  backgroundSignals = new Map()
  const agent = { ...GENERAL_PURPOSE_AGENT, getSystemPrompt: () => 'Fixture system prompt' }
  let appState = {
    ...getDefaultAppState(),
    agentDefinitions: { activeAgents: [agent], allAgents: [agent] },
  }
  context = {
    options: { mainLoopModel: 'sonnet', tools: [], mcpClients: [], agentDefinitions: appState.agentDefinitions },
    getAppState: () => appState,
    setAppState: updater => { appState = updater(appState) },
    abortController: new AbortController(),
    setResponseLength: () => {},
    messages: [],
    toolUseId: 'fixture-tool-use',
  } as ToolUseContext
  prepSpy = spyOn(prompts, 'enhanceSystemPromptWithEnvDetails').mockResolvedValue(['Fixture system prompt'])
  runnerSpy = spyOn(agentRunner, 'runAgent')
  runnerSpy.mockImplementation(() => { throw new Error('Unexpected worker startup') })
  spyOn(tasks, 'registerAsyncAgent').mockImplementation(params => {
    const task = {
      type: 'local_agent', status: 'running', agentId: params.agentId,
      abortController: new AbortController(), isBackgrounded: true,
      pendingMessages: [], retain: false,
    } as unknown as tasks.LocalAgentTaskState
    appState = { ...appState, tasks: { ...appState.tasks, [params.agentId]: task } }
    return task
  })
  spyOn(tasks, 'registerAgentForeground').mockImplementation(params => {
    const signal = deferred<void>()
    backgroundSignals.set(params.agentId, () => {
      const task = appState.tasks[params.agentId]!
      appState = { ...appState, tasks: { ...appState.tasks, [params.agentId]: { ...task, isBackgrounded: true } as tasks.LocalAgentTaskState } }
      signal.resolve()
    })
    appState = { ...appState, tasks: { ...appState.tasks, [params.agentId]: {
      type: 'local_agent', status: 'running', agentId: params.agentId,
      abortController: new AbortController(), isBackgrounded: false,
      pendingMessages: [], retain: false,
    } as unknown as tasks.LocalAgentTaskState } }
    return { taskId: params.agentId, backgroundSignal: signal.promise }
  })
  spyOn(tasks, 'unregisterAgentForeground').mockImplementation(() => {})
  spyOn(tasks, 'enqueueAgentNotification').mockImplementation(() => {})
})

afterEach(async () => {
  for (const stream of streams) stream.finish(undefined)
  await Promise.all(pending)
  await tick() // 等后台生命周期的清理结束后再恢复 spy。
  mock.restore()
  resetSettingsCache()
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  rmSync(configDir, { recursive: true, force: true })
})

describe('ordinary AgentTool process concurrency', () => {
  test.each([false, true])('counts %s background mode and rejects before preparation/worktree side effects', async background => {
    const first = addStream()
    const running = spawn(background)
    await first.started
    if (background) expect((await running).data.status).toBe('async_launched')
    const preparations = prepSpy.mock.calls.length
    const worktreeSpy = spyOn(worktree, 'createAgentWorktreeIfSupported').mockResolvedValue({ unavailableReason: 'Fixture isolation unavailable' })
    await expect(spawn(false, { isolation: 'worktree' })).rejects.toThrow('Wait for a running subagent to finish')
    expect(runnerSpy).toHaveBeenCalledTimes(1)
    expect(prepSpy).toHaveBeenCalledTimes(preparations)
    expect(worktreeSpy).not.toHaveBeenCalled()
    first.finish(undefined)
    await running
    await tick()
    const next = addStream()
    next.finish(undefined)
    expect((await spawn()).data.status).toBe('completed')
  })

  for (const background of [false, true]) {
    for (const outcome of ['complete', 'error', 'cancel'] as const) {
      test(`${background ? 'background' : 'foreground'} ${outcome} releases exactly one slot`, async () => {
        setLimit(2)
        const first = addStream()
        const running = spawn(background)
        await first.started
        const second = addStream()
        const other = spawn(background)
        await second.started
        first.finish(outcome === 'error' ? new Error('Fixture stream failed') : outcome === 'cancel' ? new AbortError() : undefined)
        if (!background && outcome !== 'complete') await expect(running).rejects.toThrow()
        else await running
        await tick()
        const replacement = addStream()
        const replacementCall = spawn()
        await replacement.started
        await expect(spawn()).rejects.toThrow('Wait for a running subagent to finish')
        expect(runnerSpy).toHaveBeenCalledTimes(3)
        replacement.finish(undefined)
        second.finish(undefined)
        await Promise.all([replacementCall, other])
      })
    }
  }

  test('reserves atomically while asynchronous initialization is pending', async () => {
    const preparation = deferred<string[]>()
    prepSpy.mockImplementationOnce(() => preparation.promise)
    const stream = addStream()
    const first = spawn()
    try {
      await tick()
      await expect(spawn()).rejects.toThrow('Wait for a running subagent to finish')
      expect(runnerSpy).not.toHaveBeenCalled()
    } finally {
      preparation.resolve(['Fixture system prompt'])
      stream.finish(undefined)
    }
    await first
  })

  test('agent selection failure before the first await disposes the reservation', async () => {
    await expect(spawn(false, { subagent_type: 'missing-fixture-agent' })).rejects.toThrow("Agent type 'missing-fixture-agent' not found")
    expect(runnerSpy).not.toHaveBeenCalled()
    expect(prepSpy).not.toHaveBeenCalled()
    const next = addStream()
    const running = spawn()
    await next.started
    await expect(spawn()).rejects.toThrow('Wait for a running subagent to finish')
    next.finish(undefined)
    expect((await running).data.status).toBe('completed')
    const afterCompletion = addStream()
    afterCompletion.finish(undefined)
    expect((await spawn()).data.status).toBe('completed')
  })

  test('initialization failure and registration failure release the reservation', async () => {
    const worktreeSpy = spyOn(worktree, 'createAgentWorktreeIfSupported').mockRejectedValueOnce(new Error('Fixture worktree failed'))
    await expect(spawn(false, { isolation: 'worktree' })).rejects.toThrow('Fixture worktree failed')
    expect(worktreeSpy).toHaveBeenCalledTimes(1)
    expect(runnerSpy).not.toHaveBeenCalled()
    spyOn(tasks, 'registerAsyncAgent').mockImplementationOnce(() => { throw new Error('Fixture registration failed') })
    await expect(spawn(true)).rejects.toThrow('Fixture registration failed')
    const next = addStream()
    next.finish(undefined)
    expect((await spawn()).data.status).toBe('completed')
  })

  test('foreground iterator initialization failure releases the reservation', async () => {
    runnerSpy.mockImplementationOnce(() => { throw new Error('Fixture iterator initialization failed') })
    await expect(spawn()).rejects.toThrow('Fixture iterator initialization failed')
    const next = addStream()
    const running = spawn()
    await next.started
    await expect(spawn()).rejects.toThrow('Wait for a running subagent to finish')
    expect(runnerSpy).toHaveBeenCalledTimes(2)
    next.finish(undefined)
    await running
  })

  test.each(['complete', 'error', 'cancel'] as const)('foreground to background transfers the pending native iterator until %s without restarting', async outcome => {
    // 使用真实任务注册和原生 generator：pending next 时 return 不会立即结束。
    spyOn(tasks, 'registerAgentForeground').mockRestore()
    spyOn(tasks, 'unregisterAgentForeground').mockRestore()
    const terminal = deferred<Error | undefined>()
    const started = deferred<void>()
    let ended = false
    let workerSignal: AbortSignal | undefined
    runnerSpy.mockImplementationOnce(params => (async function* () {
      workerSignal = params.override?.abortController?.signal ?? params.toolUseContext.abortController.signal
      const abort = () => terminal.resolve(new AbortError())
      workerSignal.addEventListener('abort', abort, { once: true })
      try {
        started.resolve()
        const error = await terminal.promise
        if (error) throw error
        yield createAssistantMessage({ content: 'Pending message survived background transfer.' })
      } finally {
        ended = true
        workerSignal.removeEventListener('abort', abort)
      }
    })())
    const running = spawn()
    try {
      await started.promise
      const taskId = Object.keys(context.getAppState().tasks)[0]!
      expect(tasks.backgroundAgentTask(taskId, context.getAppState, context.setAppState)).toBe(true)
      expect((await running).data.status).toBe('async_launched')
      // 必须跨过旧实现的 1 秒 timeout，不能仅检查刚转后台的一瞬间。
      await Bun.sleep(1100)
      expect(runnerSpy).toHaveBeenCalledTimes(1)
      context.abortController.abort()
      await tick()
      expect(workerSignal?.aborted).toBe(false)
      expect(ended).toBe(false)
      await expect(spawn()).rejects.toThrow('Wait for a running subagent to finish')
      if (outcome === 'cancel') tasks.killAsyncAgent(taskId, context.setAppState)
      else terminal.resolve(outcome === 'error' ? new Error('Fixture transferred stream failed') : undefined)
      await tick()
      expect(ended).toBe(true)
      expect(context.getAppState().tasks[taskId]?.status).toBe(
        outcome === 'complete' ? 'completed' : outcome === 'error' ? 'failed' : 'killed',
      )
      if (outcome === 'complete') {
        const task = context.getAppState().tasks[taskId] as tasks.LocalAgentTaskState
        expect(JSON.stringify(task.result?.content)).toContain('Pending message survived background transfer.')
      }
      const next = addStream()
      next.finish(undefined)
      expect((await spawn(false, {}, { ...context, abortController: new AbortController() })).data.status).toBe('completed')
    } finally {
      terminal.resolve(undefined)
      await tick()
    }
  })

  test.each(['parent', 'task'] as const)('foreground %s cancellation reaches the running worker and releases its slot', async owner => {
    spyOn(tasks, 'registerAgentForeground').mockRestore()
    spyOn(tasks, 'unregisterAgentForeground').mockRestore()
    const terminal = deferred<void>()
    const started = deferred<void>()
    runnerSpy.mockImplementationOnce(params => (async function* () {
      const signal = params.override!.abortController!.signal
      const abort = () => terminal.resolve()
      signal.addEventListener('abort', abort, { once: true })
      try {
        started.resolve()
        await terminal.promise
        expect(signal.aborted).toBe(true)
        throw new AbortError()
      } finally {
        signal.removeEventListener('abort', abort)
      }
    })())
    const running = spawn()
    try {
      await started.promise
      if (owner === 'parent') context.abortController.abort()
      else tasks.killAsyncAgent(Object.keys(context.getAppState().tasks)[0]!, context.setAppState)
      await expect(running).rejects.toBeInstanceOf(AbortError)
      const next = addStream()
      next.finish(undefined)
      expect((await spawn(false, {}, { ...context, abortController: new AbortController() })).data.status).toBe('completed')
    } finally {
      terminal.resolve()
    }
  })

  test('an unrelated schema-invalid retained setting cannot disable a valid concurrency cap', async () => {
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: '365', maxConcurrentSubagents: 1 }))
    const first = addStream()
    const running = spawn()
    await first.started
    await expect(spawn()).rejects.toThrow('Wait for a running subagent to finish')
    expect(runnerSpy).toHaveBeenCalledTimes(1)
    first.finish(undefined)
    await running
  })

  test('nested invocation rejects immediately rather than queueing behind its parent', async () => {
    const parent = addStream()
    const running = spawn()
    await parent.started
    const nestedContext = { ...context, agentId: 'fixture-parent' }
    const nestedResult = await Promise.race([
      spawn(false, {}, nestedContext).then(() => 'unexpected startup', error => error),
      tick().then(() => 'nested spawn queued behind its parent'),
    ])
    expect(nestedResult).toBeInstanceOf(Error)
    expect((nestedResult as Error).message).toContain('Wait for a running subagent to finish')
    expect(runnerSpy).toHaveBeenCalledTimes(1)
    parent.finish(undefined)
    await running
  })

  test.each([undefined, null])('unlimited %s still counts existing workers when limits change without cache invalidation', async unlimited => {
    setLimit(unlimited)
    resetSettingsCache() // 只建立初始快照，后续设置变更必须在不清缓存的情况下生效。
    expect(getSettingsForSource('userSettings')?.maxConcurrentSubagents).toBe(unlimited)
    const first = addStream()
    const one = spawn(true)
    await first.started
    const second = addStream()
    const two = spawn()
    await second.started
    setLimit(1)
    await expect(spawn()).rejects.toThrow('Wait for a running subagent to finish')
    expect(runnerSpy).toHaveBeenCalledTimes(2)
    first.finish(undefined)
    await one
    await tick()
    await expect(spawn()).rejects.toThrow('Wait for a running subagent to finish')
    setLimit(2)
    const third = addStream()
    const three = spawn(true)
    await third.started
    setLimit(null)
    const fourth = addStream()
    const four = spawn()
    await fourth.started
    for (const control of [second, third, fourth]) control.finish(undefined)
    await Promise.all([two, three, four])
    await tick()
    setLimit(1)
    const final = addStream()
    final.finish(undefined)
    expect((await spawn()).data.status).toBe('completed')
  })

  test('team spawning bypasses ordinary slots and does not consume one', async () => {
    spyOn(swarms, 'isAgentSwarmsEnabled').mockReturnValue(true)
    const teamPath = getTeamFilePath('fixture-team')
    mkdirSync(dirname(teamPath), { recursive: true })
    writeFileSync(teamPath, JSON.stringify({ name: 'fixture-team', createdAt: 1, leadAgentId: 'fixture-lead', members: [] }))
    const spawnSpy = spyOn(teams, 'spawnTeammate').mockResolvedValue({ data: { staged: false, agent_id: 'fixture-teammate' } } as never)
    const first = addStream()
    const running = spawn()
    await first.started
    await spawn(false, { team_name: 'fixture-team', name: 'fixture-member' })
    expect(spawnSpy).toHaveBeenCalledTimes(1)
    first.finish(undefined)
    await running
    const next = addStream()
    next.finish(undefined)
    expect((await spawn()).data.status).toBe('completed')
  })
})

describe('SendMessageTool ordinary worker resume concurrency', () => {
  const restoredAgentId = asAgentId('fixture-restored-worker')

  function prepareResumeFixture() {
    // 只替换历史输入和模型流，保留 SendMessage → resume → lifecycle 的真实调用链。
    const history = [
      createUserMessage({ content: 'Complete the original fixture task.' }),
      createAssistantMessage({ content: 'Original fixture task completed.' }),
    ]
    const transcriptSpy = spyOn(sessionStorage, 'getAgentTranscript').mockResolvedValue({
      messages: history,
      contentReplacements: [],
    })
    const metadataSpy = spyOn(sessionStorage, 'readAgentMetadata').mockResolvedValue({
      agentType: GENERAL_PURPOSE_AGENT.agentType,
      description: 'Original fixture task',
      toolUseId: 'fixture-original-agent-call',
    })
    context.setAppState(prev => ({
      ...prev,
      agentNameRegistry: new Map([...prev.agentNameRegistry, ['old-worker', restoredAgentId]]),
      tasks: {
        ...prev.tasks,
        [restoredAgentId]: {
          type: 'local_agent', status: 'completed', agentId: restoredAgentId,
          agentType: GENERAL_PURPOSE_AGENT.agentType,
          toolUseId: 'fixture-original-agent-call',
          abortController: new AbortController(), isBackgrounded: true,
          pendingMessages: [], retain: false,
        } as unknown as tasks.LocalAgentTaskState,
      },
    }))
    return { history, transcriptSpy, metadataSpy }
  }

  function resumeWorker() {
    const promise = SendMessageTool.call(
      { to: 'old-worker', message: 'Continue the fixture task.' },
      context,
      (async () => ({ behavior: 'allow' })) as never,
      createAssistantMessage({ content: 'Resume the stopped fixture worker.' }),
    )
    pending.push(promise.catch(() => {}))
    return promise
  }

  test('full AgentTool slot rejects SendMessage resume before reading history, then allows resume after completion', async () => {
    const { history, transcriptSpy, metadataSpy } = prepareResumeFixture()
    const ordinary = addStream()
    const running = spawn()
    await ordinary.started
    const refused = await resumeWorker()
    expect(refused.data).toMatchObject({ success: false })
    expect(refused.data.message).toContain('Wait for a running subagent to finish')
    expect(transcriptSpy).not.toHaveBeenCalled()
    expect(metadataSpy).not.toHaveBeenCalled()
    expect(runnerSpy).toHaveBeenCalledTimes(1)
    ordinary.finish(undefined)
    await running
    const resumed = addStream()
    expect((await resumeWorker()).data).toMatchObject({ success: true })
    await resumed.started
    expect(transcriptSpy).toHaveBeenCalledWith(restoredAgentId)
    expect(runnerSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      streamTargetAgentId: restoredAgentId,
      promptMessages: [...history, expect.objectContaining({ type: 'user' })],
    }))
    resumed.finish(undefined)
    await tick()
  })

  test('SendMessage resume reserves the shared slot while history loading is pending', async () => {
    const { history, transcriptSpy } = prepareResumeFixture()
    const transcript = deferred<Awaited<ReturnType<typeof sessionStorage.getAgentTranscript>>>()
    transcriptSpy.mockImplementationOnce(() => transcript.promise)
    const resumed = addStream()
    const resuming = resumeWorker()
    try {
      await tick()
      expect(transcriptSpy).toHaveBeenCalledWith(restoredAgentId)
      await expect(spawn()).rejects.toThrow('Wait for a running subagent to finish')
      expect(runnerSpy).not.toHaveBeenCalled()
    } finally {
      transcript.resolve({ messages: history, contentReplacements: [] })
      resumed.finish(undefined)
    }
    expect((await resuming).data).toMatchObject({ success: true })
    await tick()
    const replacement = addStream()
    replacement.finish(undefined)
    expect((await spawn()).data.status).toBe('completed')
  })

  test.each(['complete', 'error', 'cancel'] as const)('SendMessage resume occupies the shared slot until %s and then releases it', async outcome => {
    prepareResumeFixture()
    const resumed = addStream()
    expect((await resumeWorker()).data).toMatchObject({ success: true })
    await resumed.started
    await expect(spawn()).rejects.toThrow('Wait for a running subagent to finish')
    expect(runnerSpy).toHaveBeenCalledTimes(1)
    resumed.finish(outcome === 'error' ? new Error('Fixture resumed stream failed') : outcome === 'cancel' ? new AbortError() : undefined)
    await tick()
    expect(context.getAppState().tasks[restoredAgentId]?.status).toBe(
      outcome === 'complete' ? 'completed' : outcome === 'error' ? 'failed' : 'killed',
    )
    const replacement = addStream()
    const running = spawn()
    await replacement.started
    await expect(spawn()).rejects.toThrow('Wait for a running subagent to finish')
    expect(runnerSpy).toHaveBeenCalledTimes(2)
    replacement.finish(undefined)
    expect((await running).data.status).toBe('completed')
  })

  test.each(['missing-history', 'history-read-error', 'metadata-read-error', 'registration-error'] as const)('SendMessage resume %s does not leak a reservation', async failure => {
    const { transcriptSpy, metadataSpy } = prepareResumeFixture()
    if (failure === 'missing-history') transcriptSpy.mockResolvedValueOnce(null)
    if (failure === 'history-read-error') transcriptSpy.mockRejectedValueOnce(new Error('Fixture history read failed'))
    if (failure === 'metadata-read-error') metadataSpy.mockRejectedValueOnce(new Error('Fixture metadata read failed'))
    if (failure === 'registration-error') {
      spyOn(tasks, 'registerAsyncAgent').mockImplementationOnce(() => { throw new Error('Fixture resumed registration failed') })
    }
    const failed = await resumeWorker()
    expect(failed.data).toMatchObject({ success: false })
    expect(failed.data.message).toContain({
      'missing-history': 'No transcript found for agent ID',
      'history-read-error': 'Fixture history read failed',
      'metadata-read-error': 'Fixture metadata read failed',
      'registration-error': 'Fixture resumed registration failed',
    }[failure])
    expect(tasks.registerAsyncAgent).toHaveBeenCalledTimes(failure === 'registration-error' ? 1 : 0)
    expect(runnerSpy).not.toHaveBeenCalled()
    const replacement = addStream()
    const running = spawn()
    await replacement.started
    await expect(spawn()).rejects.toThrow('Wait for a running subagent to finish')
    expect(runnerSpy).toHaveBeenCalledTimes(1)
    replacement.finish(undefined)
    expect((await running).data.status).toBe('completed')
  })
})

describe('maxConcurrentSubagents settings contract', () => {
  test.each([undefined, null, 1, Number.MAX_SAFE_INTEGER, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2', false])('uncached field reading validates %s independently without rewriting retained data', value => {
    const content = JSON.stringify({ cleanupPeriodDays: '365', unknownFuturePreference: { keep: true }, maxConcurrentSubagents: value })
    const path = join(configDir, 'settings.json')
    writeFileSync(path, content)
    const expected = typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
    expect(getMaxConcurrentSubagentsUncached()).toBe(expected)
    expect(readFileSync(path, 'utf8')).toBe(content)
  })
  test.each([undefined, null, 1, Number.MAX_SAFE_INTEGER])('accepts %s', value => {
    expect(SettingsSchema().safeParse({ maxConcurrentSubagents: value }).success).toBe(true)
  })
  test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '2'])('rejects %s', value => {
    expect(SettingsSchema().safeParse({ maxConcurrentSubagents: value }).success).toBe(false)
  })
})
