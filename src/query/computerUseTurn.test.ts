import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import type { Tool, ToolUseContext } from '../Tool.js'
import type { QueryParams } from '../query.js'

let root: string
let originalProcessCwd: string
let originalEnv: NodeJS.ProcessEnv
let originalPaths: { cwd: string; originalCwd: string; projectRoot: string }
let bootstrap: typeof import('../bootstrap/state.js')
let query: typeof import('../query.js')['query']
let queue: typeof import('../utils/messageQueueManager.js')
let lock: typeof import('../utils/computerUse/computerUseLock.js')
let setLifecycleListener: typeof import('../utils/commandLifecycle.js')['setCommandLifecycleListener']
let createFileStateCache: typeof import('../utils/fileStateCache.js')['createFileStateCacheWithSizeLimit']
let getDefaultAppState: typeof import('../state/AppStateStore.js')['getDefaultAppState']
let messages: typeof import('../utils/messages.js')
let asSystemPrompt: typeof import('../utils/systemPromptType.js')['asSystemPrompt']
const macros = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
const previousMacro = macros.MACRO

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'query-computer-use-turn-'))
  originalProcessCwd = process.cwd()
  originalEnv = { ...process.env }
  macros.MACRO ??= { BUILD_TIME: '' }
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, createSandboxedTestEnvironment(root, {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    ANTHROPIC_API_KEY: 'fixture-key',
    CLAUDE_CODE_SIMPLE: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
  }, originalEnv))
  bootstrap = await import('../bootstrap/state.js')
  originalPaths = {
    cwd: bootstrap.getCwdState(),
    originalCwd: bootstrap.getOriginalCwd(),
    projectRoot: bootstrap.getProjectRoot(),
  }
  bootstrap.setCwdState(root)
  bootstrap.setOriginalCwd(root)
  bootstrap.setProjectRoot(root)
  process.chdir(root)
  query = (await import('../query.js')).query
  queue = await import('../utils/messageQueueManager.js')
  lock = await import('../utils/computerUse/computerUseLock.js')
  setLifecycleListener = (await import('../utils/commandLifecycle.js')).setCommandLifecycleListener
  createFileStateCache = (await import('../utils/fileStateCache.js')).createFileStateCacheWithSizeLimit
  getDefaultAppState = (await import('../state/AppStateStore.js')).getDefaultAppState
  messages = await import('../utils/messages.js')
  asSystemPrompt = (await import('../utils/systemPromptType.js')).asSystemPrompt
})

afterEach(async () => {
  queue.clearCommandQueue()
  setLifecycleListener(null)
  await lock.releaseComputerUseLock()
})

afterAll(async () => {
  process.chdir(originalProcessCwd)
  bootstrap.setCwdState(originalPaths.cwd)
  bootstrap.setOriginalCwd(originalPaths.originalCwd)
  bootstrap.setProjectRoot(originalPaths.projectRoot)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  if (previousMacro === undefined) delete macros.MACRO
  else macros.MACRO = previousMacro
  await rm(root, { recursive: true, force: true })
})

type ModelCall = NonNullable<QueryParams['deps']>['callModel']

function startTurn(
  toolAction: (context: ToolUseContext) => void | Promise<void>,
  observeFollowup?: (messages: Parameters<ModelCall>[0]['messages']) => void,
) {
  let state = getDefaultAppState()
  const tool = {
    name: 'FixtureDesktop',
    inputSchema: z.object({}),
    maxResultSizeChars: 1000,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isEnabled: () => true,
    userFacingName: () => 'fixture desktop',
    description: async () => 'exercise a turn boundary',
    call: async (_: unknown, context: ToolUseContext) => {
      await toolAction(context)
      return { data: 'observed' }
    },
    mapToolResultToToolResultBlockParam: (data: string, id: string) => (
      { type: 'tool_result', tool_use_id: id, content: data }
    ),
  } as unknown as Tool
  let calls = 0
  const callModel: ModelCall = async function* (request) {
    const firstCall = calls++ === 0
    if (!firstCall) observeFollowup?.(request.messages)
    const message = messages.createAssistantMessage({
      content: firstCall ? [{ type: 'tool_use', id: 'fixture-tool', name: tool.name, input: {} }] : 'done',
    })
    message.message.model = 'fixture-model'
    yield message
  }
  return query({
    messages: [messages.createUserMessage({ content: 'Run the fixture tool' })],
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
    querySource: 'sdk',
    toolUseContext: {
      options: {
        commands: [], tools: [tool], debug: false, verbose: false,
        mainLoopModel: 'fixture-model', thinkingConfig: { type: 'disabled' },
        mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      abortController: new AbortController(),
      readFileState: createFileStateCache(16),
      getAppState: () => state,
      setAppState: update => { state = update(state) },
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
      messages: [],
    },
    deps: { callModel, microcompact: async messages => ({ messages }), autocompact: async () => ({}), uuid: randomUUID },
  })
}

test('a queued Computer Use request keeps its own SDK turn', async () => {
  const normal = { mode: 'prompt' as const, value: 'Keep inspecting', uuid: randomUUID() }
  const desktop = { mode: 'prompt' as const, value: 'Use Computer Use to open Calculator', uuid: randomUUID() }
  const events: string[][] = []
  setLifecycleListener((uuid, phase) => { events.push([uuid, phase]) })
  let followup: unknown[] = []
  const turn = startTurn(() => {
    queue.enqueue(normal)
    queue.enqueue(desktop)
  }, modelMessages => {
    followup = modelMessages.flatMap(message => (
      message.type === 'attachment' && message.attachment.type === 'queued_command'
        ? [message.attachment.prompt]
        : []
    ))
  })
  for await (const _message of turn) { /* drain the user turn */ }
  expect(followup).toEqual([normal.value])
  expect(queue.getCommandsByMaxPriority('next')).toMatchObject([desktop])
  expect(events).toEqual([[normal.uuid, 'started'], [normal.uuid, 'completed']])
})

test('closing the SDK iterator releases its active Computer Use lock', async () => {
  let owner = Symbol()
  let sawResult = false
  const turn = startTurn(async context => {
    owner = context.computerUseTurn ?? owner
    expect(await lock.tryAcquireComputerUseLock(owner)).toEqual({ kind: 'acquired', fresh: true })
  })
  for await (const message of turn) {
    if (message.type !== 'user' || !Array.isArray(message.message.content) ||
      !message.message.content.some(block => block.type === 'tool_result')) continue
    expect(lock.isLockHeldLocally(owner)).toBe(true)
    sawResult = true
    break
  }
  expect(sawResult).toBe(true)
  expect(await lock.checkComputerUseLock()).toEqual({ kind: 'free' })
})
