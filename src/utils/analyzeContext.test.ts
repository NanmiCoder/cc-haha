import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../scripts/pr/test-environment.js'
import type { Message } from '../types/message.js'

let configDir: string
const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch

describe('analyzeContextUsage', () => {
  beforeAll(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'cc-haha-analyze-context-'))
    const fixtureEnv = createSandboxedTestEnvironment(configDir, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      ANTHROPIC_API_KEY: 'sk-ant-test-fake',
      CLAUDE_CODE_SIMPLE: '1',
      CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH: '1',
    })
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, fixtureEnv)
    globalThis.fetch = (() => {
      throw new Error('Network access is blocked in the context analysis fixture')
    }) as typeof fetch
  })

  afterAll(async () => {
    globalThis.fetch = originalFetch
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, originalEnv)
    await rm(configDir, { recursive: true, force: true })
  })

  test.each([
    { name: 'a larger historical estimate', historyChars: 987_192, cacheReadTokens: 815_232, tailTokens: 0, expected: 816_404, shouldCompact: false },
    { name: 'provider usage plus a new message above the threshold', historyChars: 1_000, cacheReadTokens: 966_765, tailTokens: 600, expected: 968_537, shouldCompact: true },
  ])('matches compaction after Qwen switches to DeepSeek with $name', async fixture => {
    const { analyzeContextUsage } = await import('./analyzeContext.js')
    const { shouldAutoCompact } = await import('../services/compact/autoCompact.js')
    const messages = [
      { type: 'user', message: { role: 'user', content: '中'.repeat(fixture.historyChars) } },
      {
        type: 'assistant',
        message: {
          id: 'qwen-response', role: 'assistant', model: 'qwen3.5-plus',
          content: [{ type: 'text', text: 'Earlier response' }],
          usage: { input_tokens: 950_000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'deepseek-response', role: 'assistant', model: 'deepseek-flash',
          content: [{ type: 'text', text: 'Current response' }],
          usage: { input_tokens: 235, output_tokens: 937, cache_creation_input_tokens: 0, cache_read_input_tokens: fixture.cacheReadTokens },
        },
      },
      ...(fixture.tailTokens ? [{ type: 'user', message: { role: 'user', content: '尾'.repeat(fixture.tailTokens) } }] : []),
    ] as Message[]

    const result = await analyzeContextUsage(
      messages,
      'deepseek-flash',
      async () => ({ mode: 'default' }),
      [],
      { activeAgents: [], allAgents: [] },
      undefined, undefined, undefined, messages,
      { estimateOnly: true },
    )

    expect(result.totalTokens).toBe(fixture.expected)
    expect(result.percentage).toBe(Math.round(fixture.expected / 10_000))
    expect(result.autoCompactThreshold).toBe(967_000)
    expect(await shouldAutoCompact(messages, 'deepseek-flash', 'sdk')).toBe(fixture.shouldCompact)
    const usedCategories = result.categories.filter(category =>
      !category.isDeferred && !['Autocompact buffer', 'Compact buffer', 'Free space'].includes(category.name))
    expect(usedCategories.reduce((sum, category) => sum + category.tokens, 0)).toBe(fixture.expected)
  })

  test('uses the same capped and overridden thresholds as automatic compaction', async () => {
    const { analyzeContextUsage } = await import('./analyzeContext.js')
    const { getAutoCompactThreshold } = await import('../services/compact/autoCompact.js')
    const originalWindows = process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
    const originalOverride = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
    const run = (model: string) => analyzeContextUsage(
      [], model, async () => ({ mode: 'default' }), [], { activeAgents: [], allAgents: [] },
      undefined, undefined, undefined, undefined, { estimateOnly: true },
    )
    try {
      process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS = JSON.stringify({ 'custom-16k': 16_000 })
      expect((await run('custom-16k')).autoCompactThreshold).toBe(getAutoCompactThreshold('custom-16k'))
      process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '50'
      expect((await run('deepseek-flash')).autoCompactThreshold).toBe(getAutoCompactThreshold('deepseek-flash'))
    } finally {
      if (originalWindows === undefined) delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
      else process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS = originalWindows
      if (originalOverride === undefined) delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
      else process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = originalOverride
    }
  })

  test('keeps estimated categories within a small authoritative provider total', async () => {
    const { analyzeContextUsage } = await import('./analyzeContext.js')
    const messages = [{
      type: 'assistant',
      message: {
        id: 'small-provider-response', role: 'assistant', model: 'deepseek-flash',
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }] as Message[]
    const result = await analyzeContextUsage(
      messages, 'deepseek-flash', async () => ({ mode: 'default' }), [], { activeAgents: [], allAgents: [] },
      undefined,
      { options: { customSystemPrompt: 'system '.repeat(2_000) } } as never,
      undefined, messages, { estimateOnly: true },
    )

    expect(result.totalTokens).toBe(12)
    const usedCategories = result.categories.filter(category =>
      !category.isDeferred && !['Autocompact buffer', 'Compact buffer', 'Free space'].includes(category.name))
    expect(usedCategories.reduce((sum, category) => sum + category.tokens, 0)).toBe(12)
    expect(result.categories.reduce((sum, category) => sum + (category.isDeferred ? 0 : category.tokens), 0))
      .toBe(result.rawMaxTokens)
  })

  test.each(['missing usage', 'media usage at the limit'])('keeps the headline consistent with compaction for %s', async kind => {
    const { analyzeContextUsage } = await import('./analyzeContext.js')
    const { shouldAutoCompact } = await import('../services/compact/autoCompact.js')
    const media = kind === 'media usage at the limit'
    const content = media
      ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture' } }]
      : '中'.repeat(100_000)
    const messages = [
      { type: 'user', message: { role: 'user', content } },
      ...(media ? [{
        type: 'assistant',
        message: {
          id: 'media-provider-response', role: 'assistant', model: 'deepseek-flash',
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 1_500_000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }] : []),
    ] as Message[]
    const result = await analyzeContextUsage(
      messages, 'deepseek-flash', async () => ({ mode: 'default' }), [], { activeAgents: [], allAgents: [] },
      undefined, undefined, undefined, messages, { estimateOnly: true },
    )

    if (media) {
      expect(await shouldAutoCompact(messages, 'deepseek-flash', 'sdk')).toBe(true)
      expect(result.totalTokens).toBe(result.rawMaxTokens)
      expect(result.percentage).toBe(100)
    } else {
      expect(result.totalTokens).toBeGreaterThan(99_999)
      expect(result.totalTokens).toBeLessThan(200_000)
    }
  })

  test('analyzes attachment messages for the context status view', async () => {
    const { analyzeContextUsage } = await import('./analyzeContext.js')

    const result = await analyzeContextUsage(
      [
        {
          type: 'attachment',
          attachment: { type: 'directory', path: configDir },
          uuid: 'issue-1022',
          timestamp: '2026-07-17T00:00:00.000Z',
        },
      ],
      'claude-sonnet-4-20250514',
      async () => ({ mode: 'default' }),
      [],
      { activeAgents: [], allAgents: [] },
      undefined,
      undefined,
      undefined,
      undefined,
      { estimateOnly: true },
    )

    expect(result.messageBreakdown?.attachmentTokens).toBeGreaterThan(0)
    expect(result.messageBreakdown?.attachmentsByType).toEqual([
      { name: 'directory', tokens: expect.any(Number) },
    ])
  })

  test('keeps OpenAI encrypted reasoning aligned with canonical provider usage', async () => {
    const { analyzeContextUsage } = await import('./analyzeContext.js')
    const responseId = 'msg_openai_reasoning'
    const zeroUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
    const messages = [
      {
        type: 'assistant',
        message: {
          id: responseId,
          role: 'assistant',
          model: 'gpt-5.6-terra',
          content: [
            {
              type: 'redacted_thinking',
              data: `cc-haha:openai-reasoning:v1:${JSON.stringify({
                id: 'rs_test',
                summary: [],
                encrypted_content: 'x'.repeat(400_000),
              })}`,
            },
          ],
          usage: zeroUsage,
        },
      },
      {
        type: 'assistant',
        message: {
          id: responseId,
          role: 'assistant',
          model: 'gpt-5.6-terra',
          content: [{ type: 'text', text: 'done' }],
          usage: {
            input_tokens: 8_000,
            output_tokens: 1_000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 292_000,
          },
        },
      },
    ] as never

    const result = await analyzeContextUsage(
      messages,
      'gpt-5.6-terra',
      async () => ({ mode: 'default' }),
      [],
      { activeAgents: [], allAgents: [] },
      undefined,
      undefined,
      undefined,
      messages,
      { estimateOnly: true },
    )

    expect(result.totalTokens).toBe(301_000)
    expect(result.percentage).toBe(85)

    const usedCategories = result.categories.filter(category =>
      !category.isDeferred &&
      category.name !== 'Autocompact buffer' &&
      category.name !== 'Compact buffer' &&
      category.name !== 'Free space')
    expect(usedCategories.reduce((sum, category) => sum + category.tokens, 0))
      .toBe(result.totalTokens)

    const reserved = result.categories.find(category =>
      category.name === 'Autocompact buffer' ||
      category.name === 'Compact buffer')?.tokens ?? 0
    const free = result.categories.find(category =>
      category.name === 'Free space')?.tokens ?? 0
    expect(result.totalTokens + reserved + free).toBe(result.rawMaxTokens)
  })

  test('reports the window capped by the provider fallback window, like compaction does', async () => {
    const { analyzeContextUsage } = await import('./analyzeContext.js')
    const originalAutoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    const run = () => analyzeContextUsage(
      [],
      'deepseek-v4-flash',
      async () => ({ mode: 'default' }),
      [],
      { activeAgents: [], allAgents: [] },
      undefined,
      undefined,
      undefined,
      undefined,
      { estimateOnly: true },
    )

    try {
      delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
      expect((await run()).rawMaxTokens).toBe(1_000_000)

      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '200000'
      expect((await run()).rawMaxTokens).toBe(200_000)
    } finally {
      if (originalAutoCompactWindow === undefined) {
        delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
      } else {
        process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = originalAutoCompactWindow
      }
    }
  })
})
