import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'
import type { Message } from '../../types/message.js'

let fixtureRoot: string
const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
let contextModule: typeof import('./context-noninteractive.js')
let compactModule: typeof import('../../services/compact/autoCompact.js')

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'context-summary-'))
  const env = createSandboxedTestEnvironment(fixtureRoot, {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: 'sk-ant-test-fake',
    CLAUDE_CODE_SIMPLE: '1', CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH: '1',
  })
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  globalThis.fetch = (() => { throw new Error('Context summaries cannot access the network') }) as typeof fetch
  contextModule = await import('./context-noninteractive.js')
  compactModule = await import('../../services/compact/autoCompact.js')
})

afterAll(async () => {
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await rm(fixtureRoot, { recursive: true, force: true })
})

function assistant(input: number, cache: number, output: number): Message {
  return {
    type: 'assistant',
    message: {
      id: 'latest-response', model: 'deepseek-flash', content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: input, cache_read_input_tokens: cache, cache_creation_input_tokens: 0, output_tokens: output },
    },
  } as Message
}

function summarize(messages: Message[], extra = {}) {
  return contextModule.collectContextSummary({
    messages, mainLoopModel: 'deepseek-flash', ...extra,
  })
}

test('summarizes a long provider-switched conversation without touching old payloads', () => {
  const largePayload = '中'.repeat(987_192)
  const history = {
    type: 'assistant',
    message: {
      id: 'qwen-history', model: 'qwen4.0-max-preview',
      get content() { throw new Error(`Do not inspect ${largePayload.length} historical characters`) },
      usage: { input_tokens: 990_000, output_tokens: 100 },
    },
  } as Message
  const result = summarize([history, assistant(235, 815_232, 937)])
  expect(result?.totalTokens).toBe(816_404)
  expect(result?.percentage).toBe(82)
  expect(result?.autoCompactThreshold).toBe(967_000)
  expect(result?.model).toBe('deepseek-flash')
})

test.each([966_000, 967_000])('uses exactly the compaction counter at the threshold boundary', async total => {
  const messages = [assistant(235, total - 235 - 937, 937)]
  const result = summarize(messages)
  expect(result?.totalTokens).toBe(compactModule.getAutoCompactTokenCount(messages))
  expect(await compactModule.shouldAutoCompact(messages, 'deepseek-flash')).toBe(total >= 967_000)
})

test('includes cache, output, and only the messages appended since the usage anchor', () => {
  const messages = [assistant(235, 815_232, 937), { type: 'user', message: { content: '尾'.repeat(600) } } as Message]
  expect(summarize(messages)?.totalTokens).toBe(817_004)
})

test('returns no summary when there is no usable prompt usage or real prefix snapshot', () => {
  expect(summarize([{ type: 'user', message: { content: '中'.repeat(1_000) } } as Message])).toBeNull()
  expect(summarize([assistant(0, 0, 100)])).toBeNull()
})

test('uses a matching saved request prefix for relays without prompt usage', () => {
  const messages = [{ type: 'user', message: { content: '中'.repeat(1_000) } } as Message]
  const cacheSafeParams = {
    systemPrompt: ['system '.repeat(100)], userContext: {}, systemContext: {},
    toolUseContext: { options: { mainLoopModel: 'deepseek-flash', tools: [] } },
    forkContextMessages: messages,
  } as never
  const fixed = compactModule.estimateFallbackFixedContextTokens(cacheSafeParams)
  expect(summarize(messages, { cacheSafeParams })?.totalTokens).toBe(compactModule.getAutoCompactTokenCount(messages, 0, fixed))
})

test('does not borrow a prefix from another model or a child agent', () => {
  const messages = [{ type: 'user', message: { content: 'hello' } } as Message]
  for (const options of [
    { mainLoopModel: 'other-model', tools: [] },
    { mainLoopModel: 'deepseek-flash', tools: [] },
  ]) {
    const cacheSafeParams = {
      systemPrompt: ['system'], userContext: {}, systemContext: {},
      toolUseContext: { options, ...(options.mainLoopModel === 'deepseek-flash' ? { agentId: 'child' } : {}) },
      forkContextMessages: messages,
    } as never
    expect(summarize(messages, { cacheSafeParams })).toBeNull()
  }
})

test('uses the same header count for summary and full details with a saved prefix', async () => {
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const messages = [{ type: 'user', message: { content: '中'.repeat(1_000) } } as Message]
  const cacheSafeParams = {
    systemPrompt: ['system '.repeat(1_000)], userContext: {}, systemContext: {},
    toolUseContext: { options: { mainLoopModel: 'deepseek-flash', tools: [] } },
    forkContextMessages: messages,
  } as never
  const summary = summarize(messages, { cacheSafeParams })
  const details = await contextModule.collectContextData({
    messages, getAppState: getDefaultAppState,
    options: {
      mainLoopModel: 'deepseek-flash', tools: [], agentDefinitions: { activeAgents: [], allAgents: [] },
      estimateOnly: true, cacheSafeParams,
    },
  })
  expect(details.totalTokens).toBe(summary?.totalTokens)
  expect(details.autoCompactThreshold).toBe(summary?.autoCompactThreshold)
  expect(details.model).toBe(summary?.model)
})
