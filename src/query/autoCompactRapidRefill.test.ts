import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import type { Tool, ToolUseContext } from '../Tool.js'
import type { QueryParams } from '../query.js'

let query: typeof import('../query.js')['query']
let getDefaultAppState: typeof import('../state/AppStateStore.js')['getDefaultAppState']
let messagesModule: typeof import('../utils/messages.js')
let autoCompactModule: typeof import('../services/compact/autoCompact.js')
let asSystemPrompt: typeof import('../utils/systemPromptType.js')['asSystemPrompt']
let root: string
let originalCwd: string
let originalEnv: NodeJS.ProcessEnv
let bootstrap: typeof import('../bootstrap/state.js')
let originalPaths: { cwd: string, originalCwd: string, projectRoot: string }
type MacroGlobal = typeof globalThis & { MACRO?: { BUILD_TIME: string } }
let definedMacro = false

beforeAll(async () => {
  // The real compaction path reads build-time MACRO; define it only for this
  // file when no other harness has.
  if ((globalThis as MacroGlobal).MACRO === undefined) {
    ;(globalThis as MacroGlobal).MACRO = { BUILD_TIME: '' }
    definedMacro = true
  }
  originalCwd = process.cwd()
  originalEnv = { ...process.env }
  root = await mkdtemp(join(tmpdir(), 'query-autocompact-rapid-refill-'))
  const env = createSandboxedTestEnvironment(root, {
    // A compaction that is not expected must fail locally, never reach a provider.
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    ANTHROPIC_API_KEY: 'sk-ant-test-fake',
    CLAUDE_CODE_MODEL_CONTEXT_WINDOWS: JSON.stringify({ 'custom-100k': 100_000 }),
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
  messagesModule = await import('../utils/messages.js')
  autoCompactModule = await import('../services/compact/autoCompact.js')
  asSystemPrompt = (await import('../utils/systemPromptType.js')).asSystemPrompt
})

afterAll(async () => {
  if (definedMacro) delete (globalThis as MacroGlobal).MACRO
  process.chdir(originalCwd)
  bootstrap.setCwdState(originalPaths.cwd)
  bootstrap.setOriginalCwd(originalPaths.originalCwd)
  bootstrap.setProjectRoot(originalPaths.projectRoot)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await rm(root, { recursive: true, force: true })
})

const readTool = {
  name: 'FixtureRead', inputSchema: z.object({}), maxResultSizeChars: 1000,
  isConcurrencySafe: () => true, isReadOnly: () => true, isEnabled: () => true,
  userFacingName: () => 'read', description: async () => 'fixture',
  call: async () => ({ data: 'small file' }),
  mapToolResultToToolResultBlockParam: (data: string, id: string) => ({ type: 'tool_result', tool_use_id: id, content: data }),
} as unknown as Tool

function context(): ToolUseContext {
  let state = getDefaultAppState()
  return {
    options: {
      commands: [], debug: false, mainLoopModel: 'custom-100k', tools: [readTool],
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

const THRESHOLD = 67_000 // custom-100k: 100K - 20K summary reserve - 13K buffer

// createAssistantMessage marks messages synthetic, whose usage is ignored;
// give them the provider model a real response would carry.
function providerAssistant(content: Parameters<typeof messagesModule.createAssistantMessage>[0]['content'], promptTokens: number) {
  const message = messagesModule.createAssistantMessage({ content, usage: usageFor(promptTokens) })
  message.message.model = 'custom-100k'
  return message
}

function usageFor(promptTokens: number) {
  return {
    input_tokens: promptTokens,
    output_tokens: 200,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  } as never
}

// Uses the production decision on the real loop messages; only the summary
// call itself is faked, since every turn here is over the threshold.
function realDecisionAutocompact(decisions: string[]): NonNullable<QueryParams['deps']>['autocompact'] {
  return async (messages, _ctx, _cache, _source, tracking) => {
    const decision = autoCompactModule.getRapidRefillDecision(
      tracking,
      tracking?.compacted ? autoCompactModule.getPostCompactPromptTokens(messages) : undefined,
      THRESHOLD,
    )
    if (decision.trip) {
      decisions.push('tripped')
      return { wasCompacted: false, rapidRefillBreakerTripped: true }
    }
    decisions.push('compacted')
    return {
      wasCompacted: true,
      consecutiveRapidRefills: decision.consecutiveRapidRefills,
      compactionResult: {
        boundaryMarker: messagesModule.createCompactBoundaryMessage('auto', 90_000),
        summaryMessages: [messagesModule.createUserMessage({ content: 'summary', isCompactSummary: true })],
        attachments: [],
        hookResults: [],
      },
    }
  }
}

async function runLoop(postCompactPrompt: number, maxTurns: number) {
  const decisions: string[] = []
  let modelCalls = 0
  const callModel: NonNullable<QueryParams['deps']>['callModel'] = async function* () {
    modelCalls++
    yield providerAssistant(
      [{ type: 'tool_use', id: `read-${modelCalls}`, name: readTool.name, input: {} }],
      postCompactPrompt,
    )
  }
  const output: unknown[] = []
  const run = query({
    messages: [messagesModule.createUserMessage({ content: 'read the files' })],
    systemPrompt: asSystemPrompt([]), userContext: {}, systemContext: {},
    canUseTool: async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
    toolUseContext: context(), querySource: 'sdk', maxTurns,
    deps: { callModel, microcompact: async messages => ({ messages }), autocompact: realDecisionAutocompact(decisions), uuid: randomUUID },
  })
  let terminal: unknown
  while (true) {
    const next = await run.next()
    if (next.done) { terminal = next.value; break }
    output.push(next.value)
  }
  return { terminal, decisions, modelCalls, output }
}

describe('query auto-compact rapid-refill breaker (#1544)', () => {
  test('ends the turn with an explanation when every compaction leaves the fixed context over the threshold', async () => {
    const { terminal, decisions, modelCalls, output } = await runLoop(84_000, 20)

    // Without the breaker this loop compacts before every one of the 20 turns.
    expect(terminal).toEqual({ reason: 'rapid_refill_breaker' })
    expect(decisions).toEqual(['compacted', 'compacted', 'compacted', 'tripped'])
    expect(modelCalls).toBe(3)

    const last = output.at(-1) as { type?: string, isApiErrorMessage?: boolean, businessErrorCode?: string, message?: { content?: Array<{ text?: string }> } }
    expect(last.type).toBe('assistant')
    expect(last.isApiErrorMessage).toBe(true)
    expect(last.businessErrorCode).toBe('autocompact_thrashing')
    expect(last.message?.content?.[0]?.text).toBe(autoCompactModule.AUTOCOMPACT_THRASHING_MESSAGE)
  })

  test('keeps working when each compaction frees most of the window, even if large reads refill it quickly', async () => {
    const { terminal, decisions, output } = await runLoop(26_000, 8)

    expect(terminal).toMatchObject({ reason: 'max_turns' })
    expect(decisions.every(decision => decision === 'compacted')).toBe(true)
    expect(decisions.length).toBeGreaterThanOrEqual(8)
    expect(output.some(message => (message as { businessErrorCode?: string }).businessErrorCode === 'autocompact_thrashing')).toBe(false)
  })
})

describe('autoCompactIfNeeded rapid-refill gate (#1544)', () => {
  const tracking = { compacted: true, turnId: 'turn', turnCounter: 1, consecutiveRapidRefills: 2 }
  const assistantAt = (promptTokens: number) => providerAssistant('done', promptTokens)

  function aborted(): ToolUseContext {
    const ctx = context()
    ctx.options.tools = []
    ctx.abortController.abort()
    return ctx
  }

  test('trips without a summary request when the last compaction left the context full', async () => {
    const ctx = aborted()
    const result = await autoCompactModule.autoCompactIfNeeded(
      [messagesModule.createCompactBoundaryMessage('auto', 90_000), assistantAt(84_000), assistantAt(90_000)],
      ctx,
      { systemPrompt: asSystemPrompt([]), systemContext: {}, userContext: {}, toolUseContext: ctx, forkContextMessages: [] },
      'sdk',
      tracking,
    )

    expect(result).toEqual({ wasCompacted: false, rapidRefillBreakerTripped: true })
  })

  test('still compacts when the last compaction had freed most of the window', async () => {
    const ctx = aborted()
    const result = await autoCompactModule.autoCompactIfNeeded(
      [messagesModule.createCompactBoundaryMessage('auto', 90_000), assistantAt(26_000), assistantAt(90_000)],
      ctx,
      { systemPrompt: asSystemPrompt([]), systemContext: {}, userContext: {}, toolUseContext: ctx, forkContextMessages: [] },
      'sdk',
      tracking,
    )

    // It went on to compact; the aborted signal makes that attempt fail locally.
    expect(result.rapidRefillBreakerTripped).toBeUndefined()
    expect(result.wasCompacted).toBe(false)
    expect(result.consecutiveFailures).toBe(1)
  })
})
