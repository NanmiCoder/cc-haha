import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AssistantMessage, UserMessage } from '../../types/message.js'
import type { CacheSafeParams, ForkedAgentParams } from '../../utils/forkedAgent.js'

// #1451: the helpers in compact.ts are only half the fix. This file drives
// streamCompactSummary itself, because the cache-sharing branch is where the
// blank trailing block used to hide a completed summary, and a test that only
// exercises the pure helpers cannot see that branch break.
const home = mkdtempSync(join(tmpdir(), 'compact-summary-selection-'))
const originalEnv = { ...process.env }
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(
  process.env,
  createSandboxedTestEnvironment(home, { DISABLE_TELEMETRY: '1' }, originalEnv),
)

const forkedAgent = await import('../../utils/forkedAgent.js')
const claudeApi = await import('../api/claude.js')
const growthbook = await import('../analytics/growthbook.js')
const { PROMPT_TOO_LONG_ERROR_MESSAGE } = await import('../api/errors.js')
const { getAssistantMessageText } = await import('../../utils/messages.js')
const { streamCompactSummary, createCompactApiAttemptBudget } = await import('./compact.js')

const assistant = (text: string, isApiErrorMessage?: boolean): AssistantMessage =>
  ({
    type: 'assistant',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...(isApiErrorMessage ? { isApiErrorMessage } : {}),
    message: {
      id: crypto.randomUUID(),
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text }],
    },
  }) as unknown as AssistantMessage

const summaryRequest = {
  type: 'user',
  uuid: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  message: { role: 'user', content: 'summarize the conversation' },
} as unknown as UserMessage

const cacheSafeParams = {
  systemPrompt: ['fixture'],
  userContext: {},
  systemContext: {},
  toolUseContext: {},
  forkContextMessages: [],
} as unknown as CacheSafeParams

const context = {
  abortController: new AbortController(),
  setSDKStatus: () => {},
  setStreamMode: () => {},
  setResponseLength: () => {},
  options: {
    mainLoopModel: 'claude-sonnet-4-5',
    tools: [],
    isNonInteractiveSession: true,
    appendSystemPrompt: undefined,
    agentDefinitions: { activeAgents: [] },
  },
  getAppState: () => ({ toolPermissionContext: {}, effortValue: undefined }),
} as unknown as ToolUseContext

const appState = { toolPermissionContext: {}, effortValue: undefined }

const summarize = () =>
  streamCompactSummary({
    messages: [],
    summaryRequest,
    appState: appState as never,
    context,
    preCompactTokenCount: 1234,
    cacheSafeParams,
    // #1500 gives one compaction a shared API attempt budget across the fork,
    // the streaming fallback and PTL rounds; a fresh one keeps every fallback
    // path below open, which is what these selection tests exercise.
    apiAttemptBudget: createCompactApiAttemptBudget(),
  })

let forked: AssistantMessage[] = []
let streamed: AssistantMessage[] = []
let featureFlags: Record<string, unknown>
let forkSpy: ReturnType<typeof spyOn>
let streamSpy: ReturnType<typeof spyOn>
let flagSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  forked = []
  streamed = []
  featureFlags = {}
  forkSpy = spyOn(forkedAgent, 'runForkedAgent').mockImplementation(
    async (_params: ForkedAgentParams) =>
      ({
        messages: forked,
        totalUsage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }) as never,
  )
  streamSpy = spyOn(claudeApi, 'queryModelWithStreaming').mockImplementation(
    async function* () {
      for (const message of streamed) yield message as never
    } as never,
  )
  flagSpy = spyOn(growthbook, 'getFeatureValue_CACHED_MAY_BE_STALE').mockImplementation(
    ((name: string, defaultValue: unknown) =>
      Object.hasOwn(featureFlags, name) ? featureFlags[name] : defaultValue) as never,
  )
})

afterEach(() => {
  flagSpy.mockRestore()
  streamSpy.mockRestore()
  forkSpy.mockRestore()
})

afterAll(() => {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  rmSync(home, { recursive: true, force: true })
})

describe('cache sharing returns a summary that a blank trailing block was hiding (#1451)', () => {
  test('the summary before the blank block is returned without re-requesting', async () => {
    const real = assistant('valid summary')
    forked = [real, assistant('')]
    streamed = [assistant('re-requested summary')]

    const result = await summarize()

    // The whole point of the branch: the fork already produced a usable
    // summary, so the streaming fallback must not run at all.
    expect(result).toBe(real)
    expect(getAssistantMessageText(result)).toBe('valid summary')
    expect(streamSpy).not.toHaveBeenCalled()
  })

  test('a blank-only fork falls back instead of returning an empty summary', async () => {
    forked = [assistant('')]
    streamed = [assistant('streamed summary')]

    const result = await summarize()

    expect(forkSpy).toHaveBeenCalledTimes(1)
    expect(streamSpy).toHaveBeenCalledTimes(1)
    expect(getAssistantMessageText(result)).toBe('streamed summary')
  })

  test('an API error after a valid summary is not downgraded to the summary', async () => {
    forked = [assistant('valid summary'), assistant(''), assistant('API Error: 500', true)]
    streamed = [assistant('API Error: 500', true)]

    const result = await summarize()

    expect(getAssistantMessageText(result)).toBe('API Error: 500')
    expect(result.isApiErrorMessage).toBe(true)
    expect(streamSpy).toHaveBeenCalledTimes(1)
  })

  test('prompt-too-long text is handed back so the caller can retry truncated', async () => {
    const ptl = assistant(PROMPT_TOO_LONG_ERROR_MESSAGE)
    forked = [assistant('valid summary'), assistant(''), ptl]

    const result = await summarize()

    // Returned, not logged as a success and not re-requested: the caller's
    // retry loop is what recognizes the PTL prefix and retries truncated.
    expect(result).toBe(ptl)
    expect(getAssistantMessageText(result)).toBe(PROMPT_TOO_LONG_ERROR_MESSAGE)
    expect(streamSpy).not.toHaveBeenCalled()
  })

  test('a fork that throws still degrades to the streaming path', async () => {
    forkSpy.mockImplementation(async () => {
      throw new Error('fork unavailable')
    })
    streamed = [assistant('streamed summary')]

    const result = await summarize()

    expect(getAssistantMessageText(result)).toBe('streamed summary')
  })
})

describe('the streaming path keeps the summary a blank assistant would displace (#1451)', () => {
  test('a blank assistant after a real one is ignored', async () => {
    featureFlags['tengu_compact_cache_prefix'] = false
    streamed = [assistant('valid summary'), assistant('')]

    const result = await summarize()

    expect(getAssistantMessageText(result)).toBe('valid summary')
  })

  test('a blank-only stream terminates as a response instead of retrying forever', async () => {
    featureFlags['tengu_compact_cache_prefix'] = false
    streamed = [assistant('')]

    const result = await summarize()

    expect(result).toBe(streamed[0])
    expect(streamSpy).toHaveBeenCalledTimes(1)
  })

  test('an API error after a real summary still wins the stream', async () => {
    featureFlags['tengu_compact_cache_prefix'] = false
    streamed = [assistant('valid summary'), assistant(''), assistant('API Error: 500', true)]

    const result = await summarize()

    expect(getAssistantMessageText(result)).toBe('API Error: 500')
    expect(result.isApiErrorMessage).toBe(true)
  })
})