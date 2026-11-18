import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import type { Tool } from '../Tool.js'
import type { QueryParams } from '../query.js'

let root: string
let originalProcessCwd: string
let originalEnv: NodeJS.ProcessEnv
let originalPaths: { cwd: string; originalCwd: string; projectRoot: string }
let originalModelOverride: string | null | undefined
let bootstrap: typeof import('../bootstrap/state.js')
let query: typeof import('../query.js')['query']
let modelModule: typeof import('../utils/model/model.js')
let createFileStateCache: typeof import('../utils/fileStateCache.js')['createFileStateCacheWithSizeLimit']
let getDefaultAppState: typeof import('../state/AppStateStore.js')['getDefaultAppState']
let messages: typeof import('../utils/messages.js')
let asSystemPrompt: typeof import('../utils/systemPromptType.js')['asSystemPrompt']
const macros = globalThis as typeof globalThis & { MACRO?: { BUILD_TIME: string } }
const previousMacro = macros.MACRO

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'query-mid-turn-model-'))
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
  originalModelOverride = bootstrap.getMainLoopModelOverride()
  bootstrap.setCwdState(root)
  bootstrap.setOriginalCwd(root)
  bootstrap.setProjectRoot(root)
  process.chdir(root)
  query = (await import('../query.js')).query
  modelModule = await import('../utils/model/model.js')
  createFileStateCache = (await import('../utils/fileStateCache.js')).createFileStateCacheWithSizeLimit
  getDefaultAppState = (await import('../state/AppStateStore.js')).getDefaultAppState
  messages = await import('../utils/messages.js')
  asSystemPrompt = (await import('../utils/systemPromptType.js')).asSystemPrompt
})

afterEach(() => {
  bootstrap.setMainLoopModelOverride(originalModelOverride)
})

afterAll(async () => {
  process.chdir(originalProcessCwd)
  bootstrap.setCwdState(originalPaths.cwd)
  bootstrap.setOriginalCwd(originalPaths.originalCwd)
  bootstrap.setProjectRoot(originalPaths.projectRoot)
  bootstrap.setMainLoopModelOverride(originalModelOverride)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  if (previousMacro === undefined) delete macros.MACRO
  else macros.MACRO = previousMacro
  await rm(root, { recursive: true, force: true })
})

type ModelCall = NonNullable<QueryParams['deps']>['callModel']

async function runPlanPermissionTurn(decision: 'allow' | 'deny'): Promise<string[]> {
  bootstrap.setMainLoopModelOverride('deepseek-v4-pro')
  const initialOverride = bootstrap.getMainLoopModelOverride()
  const initialModel = modelModule.getMainLoopModel()

  let state = getDefaultAppState()
  state = {
    ...state,
    toolPermissionContext: {
      ...state.toolPermissionContext,
      mode: 'plan',
    },
  }

  const exitPlanTool = {
    name: 'ExitPlanMode',
    inputSchema: z.object({}),
    maxResultSizeChars: 1000,
    isConcurrencySafe: () => true,
    isReadOnly: () => false,
    isEnabled: () => true,
    userFacingName: () => 'ExitPlanMode',
    description: async () => 'Exit plan mode',
    call: async () => {
      state = {
        ...state,
        toolPermissionContext: {
          ...state.toolPermissionContext,
          mode: 'default',
        },
      }
      return { data: 'Plan approved' }
    },
    mapToolResultToToolResultBlockParam: (data: string, id: string) => (
      { type: 'tool_result', tool_use_id: id, content: data }
    ),
  } as unknown as Tool

  const seenModels: string[] = []
  const callModel: ModelCall = async function* (request) {
    seenModels.push(request.options.model)
    const firstCall = seenModels.length === 1
    const message = messages.createAssistantMessage({
      content: firstCall
        ? [{ type: 'tool_use', id: 'toolu-exit-plan', name: exitPlanTool.name, input: {} }]
        : 'continued on switched model',
    })
    message.message.model = request.options.model
    yield message
  }

  const loop = query({
    messages: [messages.createUserMessage({ content: 'Draft a plan' })],
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool: async (_tool, input) => {
      // Mirrors print.ts set_model arriving before ExitPlanMode permission resolves.
      bootstrap.setMainLoopModelOverride('deepseek-v4-flash')
      if (decision === 'allow') {
        return { behavior: 'allow', updatedInput: input }
      }
      return {
        behavior: 'deny',
        message: 'The user rejected this plan and chose to stay in plan mode. Revise the plan.',
      }
    },
    querySource: 'sdk',
    toolUseContext: {
      options: {
        commands: [],
        tools: [exitPlanTool],
        debug: false,
        verbose: false,
        mainLoopModel: initialModel,
        refreshMainLoopModel: () =>
          bootstrap.getMainLoopModelOverride() !== initialOverride
            ? modelModule.getMainLoopModel()
            : initialModel,
        thinkingConfig: { type: 'disabled' },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
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
    deps: {
      callModel,
      microcompact: async msgs => ({ messages: msgs }),
      autocompact: async () => ({}),
      uuid: randomUUID,
    },
  })

  for await (const _event of loop) {
    // consume turn
  }
  return seenModels
}

test('switches the active query loop model mid-turn when ExitPlanMode is approved', async () => {
  const seenModels = await runPlanPermissionTurn('allow')
  expect(seenModels).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash'])
})

test('switches the active query loop model mid-turn when ExitPlanMode is denied to keep planning', async () => {
  const seenModels = await runPlanPermissionTurn('deny')
  expect(seenModels).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash'])
})

test('keeps the initial main-loop model when no mid-turn model switch occurs', async () => {
  bootstrap.setMainLoopModelOverride('deepseek-v4-pro')
  const initialOverride = bootstrap.getMainLoopModelOverride()
  const initialModel = modelModule.getMainLoopModel()

  let state = getDefaultAppState()
  const noopTool = {
    name: 'ReadPlanCheck',
    inputSchema: z.object({}),
    maxResultSizeChars: 1000,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isEnabled: () => true,
    userFacingName: () => 'ReadPlanCheck',
    description: async () => 'Read check',
    call: async () => ({ data: 'ok' }),
    mapToolResultToToolResultBlockParam: (data: string, id: string) => (
      { type: 'tool_result', tool_use_id: id, content: data }
    ),
  } as unknown as Tool

  const seenModels: string[] = []
  const callModel: ModelCall = async function* (request) {
    seenModels.push(request.options.model)
    const message = messages.createAssistantMessage({
      content: seenModels.length === 1
        ? [{ type: 'tool_use', id: 'toolu-read-1', name: noopTool.name, input: {} }]
        : 'done',
    })
    message.message.model = request.options.model
    yield message
  }

  for await (const _event of query({
    messages: [messages.createUserMessage({ content: 'Check' })],
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
    querySource: 'sdk',
    toolUseContext: {
      options: {
        commands: [],
        tools: [noopTool],
        debug: false,
        verbose: false,
        mainLoopModel: initialModel,
        refreshMainLoopModel: () =>
          bootstrap.getMainLoopModelOverride() !== initialOverride
            ? modelModule.getMainLoopModel()
            : initialModel,
        thinkingConfig: { type: 'disabled' },
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
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
    deps: {
      callModel,
      microcompact: async msgs => ({ messages: msgs }),
      autocompact: async () => ({}),
      uuid: randomUUID,
    },
  })) {
    // consume
  }

  expect(seenModels).toEqual(['deepseek-v4-pro', 'deepseek-v4-pro'])
})
