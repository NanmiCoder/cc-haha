import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import { startMockLlmServer, type MockLlmServer } from '../../../scripts/quality-gate/mock-llm/server.js'
import type { MockReply, MockRequest } from '../../../scripts/quality-gate/mock-llm/scriptedModel.js'
import type { ToolUseContext } from '../../Tool.js'

let recovery: typeof import('./promptTooLongRecovery.js')
let getDefaultAppState: typeof import('../../state/AppStateStore.js')['getDefaultAppState']
let messagesModule: typeof import('../../utils/messages.js')
let asSystemPrompt: typeof import('../../utils/systemPromptType.js')['asSystemPrompt']
let bootstrap: typeof import('../../bootstrap/state.js')
let originalPaths: { cwd: string, originalCwd: string, projectRoot: string }
let originalCwd: string
let originalEnv: NodeJS.ProcessEnv
let root: string
let upstream: MockLlmServer
type MacroGlobal = typeof globalThis & { MACRO?: { BUILD_TIME: string } }
let definedMacro = false

// The summary request is what the provider sees here; each test scripts its answers.
let replies: Array<(request: MockRequest) => MockReply> = []

beforeAll(async () => {
  if ((globalThis as MacroGlobal).MACRO === undefined) {
    ;(globalThis as MacroGlobal).MACRO = { BUILD_TIME: '' }
    definedMacro = true
  }
  upstream = startMockLlmServer(request => {
    const next = replies.shift()
    if (!next) return { kind: 'error', status: 500, errorType: 'api_error', message: 'unexpected request' }
    return next(request)
  })
  originalCwd = process.cwd()
  originalEnv = { ...process.env }
  root = await mkdtemp(join(tmpdir(), 'prompt-too-long-recovery-'))
  const env = createSandboxedTestEnvironment(root, {
    ANTHROPIC_BASE_URL: upstream.url,
    ANTHROPIC_API_KEY: 'sk-ant-test-fake',
    CLAUDE_CODE_MODEL_CONTEXT_WINDOWS: JSON.stringify({ 'mock-model': 200_000 }),
    CLAUDE_CODE_SIMPLE: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // Under test, model calls go through recorded fixtures (src/services/vcr.ts) and
    // in CI a missing one fails before any request is sent. These calls are meant to
    // reach the loopback provider above; what VCR records lands in this temp root.
    VCR_RECORD: '1',
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  bootstrap = await import('../../bootstrap/state.js')
  originalPaths = {
    cwd: bootstrap.getCwdState(),
    originalCwd: bootstrap.getOriginalCwd(),
    projectRoot: bootstrap.getProjectRoot(),
  }
  bootstrap.setCwdState(root)
  bootstrap.setOriginalCwd(root)
  bootstrap.setProjectRoot(root)
  process.chdir(root)
  recovery = await import('./promptTooLongRecovery.js')
  getDefaultAppState = (await import('../../state/AppStateStore.js')).getDefaultAppState
  messagesModule = await import('../../utils/messages.js')
  asSystemPrompt = (await import('../../utils/systemPromptType.js')).asSystemPrompt
})

afterAll(async () => {
  if (definedMacro) delete (globalThis as MacroGlobal).MACRO
  process.chdir(originalCwd)
  bootstrap.setCwdState(originalPaths.cwd)
  bootstrap.setOriginalCwd(originalPaths.originalCwd)
  bootstrap.setProjectRoot(originalPaths.projectRoot)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await upstream.stop()
  await rm(root, { recursive: true, force: true })
})

function context(): ToolUseContext {
  let state = getDefaultAppState()
  return {
    options: {
      commands: [], debug: false, mainLoopModel: 'mock-model', tools: [],
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

/** A history long enough that dropping its oldest rounds still leaves something to summarize. */
function history() {
  return Array.from({ length: 6 }, (_, round) => [
    messagesModule.createUserMessage({ content: `Read part ${round} and note its marker.` }),
    messagesModule.createAssistantMessage({ content: `Part ${round} marker is CODE-${round}.` }),
  ]).flat()
}

function recover(messages: ReturnType<typeof history>, toolUseContext = context()) {
  return recovery.compactAfterPromptTooLong({
    messages,
    toolUseContext,
    cacheSafeParams: {
      systemPrompt: asSystemPrompt(['You are a test agent.']),
      userContext: {},
      systemContext: {},
      toolUseContext,
      forkContextMessages: messages,
    },
    querySource: 'sdk',
  })
}

const summary = (): MockReply => ({ kind: 'message', content: [{ type: 'text', text: '<summary>The user had six parts read; markers CODE-0 to CODE-5.</summary>' }], stopReason: 'end_turn' })

describe('compacting a history the provider rejected as too long', () => {
  test('summarizes it, dropping the oldest rounds when the summary request is itself too long', async () => {
    const sent: number[] = []
    replies = [
      request => {
        sent.push(request.messages?.length ?? 0)
        return { kind: 'error', status: 400, errorType: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' }
      },
      request => {
        sent.push(request.messages?.length ?? 0)
        return summary()
      },
    ]

    const result = await recover(history())

    expect(result).not.toBeNull()
    expect(JSON.stringify(result!.summaryMessages)).toContain('CODE-5')
    expect(result!.boundaryMarker.type).toBe('system')
    // The retry carried less of the history than the rejected summary request.
    expect(sent).toHaveLength(2)
    expect(sent[1]!).toBeLessThan(sent[0]!)
  })

  test('gives up without asking the provider when the turn was already stopped', async () => {
    replies = []
    const toolUseContext = context()
    toolUseContext.abortController.abort()
    const before = upstream.requests.length

    expect(await recover(history(), toolUseContext)).toBeNull()
    expect(upstream.requests.length).toBe(before)
  })

  test('reports no compaction when the summary cannot be produced', async () => {
    replies = []
    expect(await recover([])).toBeNull()
  })
})

describe('which rejections the query loop recovers from', () => {
  test('only agent loops, and only while automatic compaction is on', () => {
    for (const source of ['sdk', 'repl_main_thread', 'repl_main_thread:outputStyle', 'agent:custom']) {
      expect(recovery.canRecoverFromPromptTooLong(source as never)).toBe(true)
    }
    for (const source of ['prompt_suggestion', 'compact', 'session_memory', 'side_question']) {
      expect(recovery.canRecoverFromPromptTooLong(source as never)).toBe(false)
    }
    process.env.DISABLE_AUTO_COMPACT = '1'
    try {
      expect(recovery.canRecoverFromPromptTooLong('sdk' as never)).toBe(false)
    } finally {
      delete process.env.DISABLE_AUTO_COMPACT
    }
  })

  test('reads the limit an OpenAI-style or Anthropic-style rejection states', () => {
    const rejection = (details: string) => messagesModule.createAssistantAPIErrorMessage({
      content: 'Prompt is too long', error: 'invalid_request', errorDetails: details,
    })
    expect(recovery.getProviderContextLimit(rejection("This model's maximum context length is 131072 tokens. However, you requested 140000 tokens."))).toBe(131_072)
    expect(recovery.getProviderContextLimit(rejection('prompt is too long: 210000 tokens > 200000 maximum'))).toBe(200_000)
    expect(recovery.getProviderContextLimit(rejection('Request too large'))).toBeUndefined()
    expect(recovery.isPromptTooLongApiError(rejection('x'))).toBe(true)
    expect(recovery.isPromptTooLongApiError(messagesModule.createAssistantMessage({ content: 'fine' }))).toBe(false)
  })
})
