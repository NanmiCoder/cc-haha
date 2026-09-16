import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import type { Tool, ToolUseContext } from '../Tool.js'
import type { QueryParams } from '../query.js'
import type { OpenAICodexTurnState } from '../services/openaiAuth/turnState.js'

let query: typeof import('../query.js')['query']
let getDefaultAppState: typeof import('../state/AppStateStore.js')['getDefaultAppState']
let createAssistantMessage: typeof import('../utils/messages.js')['createAssistantMessage']
let createUserMessage: typeof import('../utils/messages.js')['createUserMessage']
let asSystemPrompt: typeof import('../utils/systemPromptType.js')['asSystemPrompt']
let root: string
let originalCwd: string
let originalEnv: NodeJS.ProcessEnv
let bootstrap: typeof import('../bootstrap/state.js')
let originalPaths: { cwd: string, originalCwd: string, projectRoot: string }

beforeAll(async () => {
  originalCwd = process.cwd()
  originalEnv = { ...process.env }
  root = await mkdtemp(join(tmpdir(), 'query-openai-turn-state-'))
  const env = createSandboxedTestEnvironment(root, {
    CLAUDE_CODE_SIMPLE: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
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
  getDefaultAppState = (await import('../state/AppStateStore.js')).getDefaultAppState
  const messages = await import('../utils/messages.js')
  createAssistantMessage = messages.createAssistantMessage
  createUserMessage = messages.createUserMessage
  asSystemPrompt = (await import('../utils/systemPromptType.js')).asSystemPrompt
})

afterAll(async () => {
  process.chdir(originalCwd)
  bootstrap.setCwdState(originalPaths.cwd)
  bootstrap.setOriginalCwd(originalPaths.originalCwd)
  bootstrap.setProjectRoot(originalPaths.projectRoot)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await rm(root, { recursive: true, force: true })
})

function context(tools: Tool[] = []): ToolUseContext {
  let state = getDefaultAppState()
  return {
    options: {
      commands: [], debug: false, mainLoopModel: 'gpt-6-astra', tools,
      verbose: false, thinkingConfig: { type: 'disabled' },
      mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController: new AbortController(),
    readFileState: new Map(),
    getAppState: () => state,
    setAppState: update => { state = update(state) },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as ToolUseContext
}

function params(
  toolUseContext: ToolUseContext,
  callModel: NonNullable<QueryParams['deps']>['callModel'],
): QueryParams {
  return {
    messages: [createUserMessage({ content: 'fixture' })],
    systemPrompt: asSystemPrompt([]), userContext: {}, systemContext: {},
    canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
    toolUseContext, querySource: 'sdk', maxTurns: 3,
    deps: {
      callModel,
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({}),
      uuid: randomUUID,
    },
  }
}

async function drain(generator: ReturnType<typeof query>) {
  while (true) {
    const next = await generator.next()
    if (next.done) return next.value
  }
}

describe('query OpenAI routing state lifetime', () => {
  test('keeps routing state through a real tool continuation and resets it for the next user turn', async () => {
    let toolCalls = 0
    const tool = {
      name: 'FixtureTool', inputSchema: z.object({}), maxResultSizeChars: 1000,
      isConcurrencySafe: () => true, isReadOnly: () => true, isEnabled: () => true,
      userFacingName: () => 'fixture', description: async () => 'fixture',
      call: async () => {
        toolCalls++
        return { data: 'fixture-result' }
      },
      mapToolResultToToolResultBlockParam: (data: string, id: string) => ({
        type: 'tool_result', tool_use_id: id, content: data,
      }),
    } as unknown as Tool
    const toolUseContext = context([tool])
    const states: OpenAICodexTurnState[] = []
    let modelCalls = 0
    const callModel: NonNullable<QueryParams['deps']>['callModel'] = async function* (request) {
      modelCalls++
      expect(request.options.openAITurnState).toBeDefined()
      const state = request.options.openAITurnState!
      states.push(state)
      if (modelCalls === 1) {
        expect(state.get()).toBeUndefined()
        state.capture('first-user-turn')
        yield createAssistantMessage({ content: [{
          type: 'tool_use', id: 'fixture-tool-call', name: 'FixtureTool', input: {},
        }] })
      } else {
        if (modelCalls === 2) {
          expect(state).toBe(states[0])
          expect(state.get()).toBe('first-user-turn')
          expect(toolCalls).toBe(1)
          expect(request.messages.some(message => message.type === 'user'
            && Array.isArray(message.message.content)
            && message.message.content.some(block => block.type === 'tool_result'
              && block.tool_use_id === 'fixture-tool-call'
              && block.content === 'fixture-result'))).toBe(true)
        } else {
          expect(state).not.toBe(states[0])
          expect(state.get()).toBeUndefined()
          state.capture('second-user-turn')
        }
        yield createAssistantMessage({ content: 'complete' })
      }
    }

    expect(await drain(query(params(toolUseContext, callModel)))).toEqual({ reason: 'completed' })
    expect(modelCalls).toBe(2)
    expect(toolUseContext.abortController.signal.aborted).toBe(false)
    expect(states[0]!.get()).toBeUndefined()
    states[0]!.capture('late-response')
    expect(states[0]!.get()).toBeUndefined()

    expect(await drain(query(params(toolUseContext, callModel)))).toEqual({ reason: 'completed' })
    expect(modelCalls).toBe(3)
    expect(states[2]!.get()).toBeUndefined()
    expect(toolCalls).toBe(1)
  })

  test.each(['abort', 'close'] as const)('clears routing state when a running query is interrupted by %s', async interruption => {
    const toolUseContext = context()
    let state: OpenAICodexTurnState | undefined
    const generator = query(params(toolUseContext, async function* (request) {
      state = request.options.openAITurnState
      expect(state).toBeDefined()
      state!.capture('in-flight-turn')
      yield createAssistantMessage({ content: 'partial response' })
    }))
    try {
      while (!state) {
        expect((await generator.next()).done).toBe(false)
      }
      expect(state.get()).toBe('in-flight-turn')
      if (interruption === 'abort') {
        toolUseContext.abortController.abort()
        expect(state.get()).toBeUndefined()
      }
      await generator.return({ reason: 'completed' })
      expect(state.get()).toBeUndefined()
      state.capture('late-response')
      expect(state.get()).toBeUndefined()
    } finally {
      await generator.return({ reason: 'completed' })
    }
  })
})
