import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let configDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalSimpleMode = process.env.CLAUDE_CODE_SIMPLE

describe('analyzeContextUsage', () => {
  beforeAll(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'cc-haha-analyze-context-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.CLAUDE_CODE_SIMPLE = '1'
  })

  afterAll(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    if (originalSimpleMode === undefined) {
      delete process.env.CLAUDE_CODE_SIMPLE
    } else {
      process.env.CLAUDE_CODE_SIMPLE = originalSimpleMode
    }
    await rm(configDir, { recursive: true, force: true })
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
