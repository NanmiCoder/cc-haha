import { describe, expect, spyOn, test } from 'bun:test'
import * as tokenEstimation from '../tokenEstimation.js'
import { processMCPResult, transformMCPResult } from './client.js'

const ONE_PX_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('transformMCPResult media handling', () => {
  test('does not duplicate structuredContent when content also carries the serialized JSON', async () => {
    const result = {
      content: [{ type: 'text', text: '{"users":[{"id":1,"name":"a"}]}' }],
      structuredContent: { users: [{ id: 1, name: 'a' }] },
    }

    const transformed = await transformMCPResult(result, 'test-tool', 'test-server')

    expect(transformed.type).toBe('contentArray')
    expect(transformed.content).toEqual([
      { type: 'text', text: '{"users":[{"id":1,"name":"a"}]}' },
    ])
    expect(JSON.stringify(transformed.content)).not.toContain('Structured content')
  })

  test('deduplicates JSON-equivalent arrays and detects unequal arrays', async () => {
    const equivalent = await transformMCPResult({
      content: [{ type: 'text', text: '[1, {"ok": true}]' }],
      structuredContent: [1, { ok: true }],
    }, 'test-tool', 'test-server')
    const unequal = await transformMCPResult({
      content: [{ type: 'text', text: '[1, {"ok": false}]' }],
      structuredContent: [1, { ok: true }],
    }, 'test-tool', 'test-server')

    expect(equivalent.content).toEqual([{ type: 'text', text: '[1, {"ok": true}]' }])
    expect(unequal.content).toEqual([
      { type: 'text', text: '[1, {"ok": false}]' },
      { type: 'text', text: 'Structured content:\n[1,{"ok":true}]' },
    ])
  })

  test('does not treat arrays and objects as JSON-equivalent', async () => {
    const transformed = await transformMCPResult({
      content: [{ type: 'text', text: '{"0":"value"}' }],
      structuredContent: ['value'],
    }, 'test-tool', 'test-server')

    expect(transformed.content).toEqual([
      { type: 'text', text: '{"0":"value"}' },
      { type: 'text', text: 'Structured content:\n["value"]' },
    ])
  })
  test('keeps images in content and appends structuredContent when not already serialized', async () => {
    const result = {
      content: [{ type: 'image', data: ONE_PX_PNG, mimeType: 'image/png' }],
      structuredContent: { pages: 2 },
    }

    const transformed = await transformMCPResult(result, 'test-tool', 'test-server')

    expect(transformed.type).toBe('contentArray')
    expect(transformed.content).toHaveLength(2)
    const imageBlock = transformed.content[0] as { type: string; source?: { type: string } }
    expect(imageBlock.type).toBe('image')
    expect(imageBlock.source?.type).toBe('base64')
    expect(transformed.content[1]).toEqual({
      type: 'text',
      text: 'Structured content:\n{"pages":2}',
    })
    expect(transformed.schema).toBe('{pages: number}')
  })

  test('deduplicates pretty-printed JSON that is semantically equal to structuredContent', async () => {
    const result = {
      content: [{
        type: 'text',
        text: '{\n  "title": "Dune",\n  "author": "Frank Herbert"\n}',
      }],
      structuredContent: { title: 'Dune', author: 'Frank Herbert' },
    }

    const transformed = await transformMCPResult(result, 'test-tool', 'test-server')

    expect(transformed.type).toBe('contentArray')
    expect(transformed.content).toEqual([
      { type: 'text', text: '{\n  "title": "Dune",\n  "author": "Frank Herbert"\n}' },
    ])
    expect(JSON.stringify(transformed.content)).not.toContain('Structured content')
  })

  test('appends structuredContent when content text is not JSON-equivalent', async () => {
    const result = {
      content: [{ type: 'text', text: 'A human-readable summary' }],
      structuredContent: { count: 5 },
    }

    const transformed = await transformMCPResult(result, 'test-tool', 'test-server')

    expect(transformed.content).toEqual([
      { type: 'text', text: 'A human-readable summary' },
      { type: 'text', text: 'Structured content:\n{"count":5}' },
    ])
  })

  test('falls back to structuredContent branch when content is absent', async () => {
    const result = { structuredContent: { count: 3 } }

    const transformed = await transformMCPResult(result, 'test-tool', 'test-server')

    expect(transformed.type).toBe('structuredContent')
    expect(transformed.content).toBe('{"count":3}')
    expect(transformed.schema).toBe('{count: number}')
  })

  test('returns contentArray for content-only results', async () => {
    const result = { content: [{ type: 'text', text: 'plain result' }] }

    const transformed = await transformMCPResult(result, 'test-tool', 'test-server')

    expect(transformed.type).toBe('contentArray')
    expect(transformed.content).toEqual([{ type: 'text', text: 'plain result' }])
  })
})

describe('persistTextFromImageContent', () => {
  test('preserves the trailing image through oversized MCP result processing', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-process-media-'))
    const previous = {
      configDir: process.env.CLAUDE_CONFIG_DIR,
      maxTokens: process.env.MAX_MCP_OUTPUT_TOKENS,
      largeOutputFiles: process.env.ENABLE_MCP_LARGE_OUTPUT_FILES,
    }
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    process.env.MAX_MCP_OUTPUT_TOKENS = '25000'
    process.env.ENABLE_MCP_LARGE_OUTPUT_FILES = '1'
    const countTokens = spyOn(tokenEstimation, 'countMessagesTokensWithAPI').mockResolvedValue(50000)
    const fullText = 'log '.repeat(40000)

    try {
      const result = await processMCPResult({ content: [
        { type: 'text', text: fullText },
        { type: 'image', mimeType: 'image/png', data: ONE_PX_PNG },
        { type: 'text', text: 'Screenshot caption' },
      ] }, 'test-tool', 'test-server')
      expect(countTokens).toHaveBeenCalled()
      expect(Array.isArray(result)).toBe(true)
      if (!Array.isArray(result)) throw new Error('Expected media content blocks')
      expect(result.some(block => block.type === 'image')).toBe(true)
      expect(result).toContainEqual({ type: 'text', text: 'Screenshot caption' })
      const savedPath = result
        .filter(block => block.type === 'text')
        .map(block => block.text.match(/saved to (.+)/)?.[1])
        .find(Boolean)
      expect(savedPath).toBeDefined()
      expect(await fs.readFile(savedPath!, 'utf8')).toBe(`${fullText}\nScreenshot caption`)
    } finally {
      countTokens.mockRestore()
      for (const [key, value] of Object.entries({
        CLAUDE_CONFIG_DIR: previous.configDir,
        MAX_MCP_OUTPUT_TOKENS: previous.maxTokens,
        ENABLE_MCP_LARGE_OUTPUT_FILES: previous.largeOutputFiles,
      })) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  test('keeps media blocks in order with bounded text summaries and persists full text', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')
    const { persistTextFromImageContent } = await import('./client.js')
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-persist-test-'))
    const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir

    try {
      const result = await persistTextFromImageContent([
        { type: 'text', text: 'Screenshot A' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } },
        { type: 'text', text: 'Screenshot B' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'b' } },
      ], 'test-server', 'test-tool')

      expect(result).not.toBeNull()
      const blocks = result as Array<{ type: string }>
      expect(blocks.map(block => block.type)).toEqual(['text', 'image', 'text', 'image', 'text'])
      expect((blocks[0] as { text: string }).text).toBe('Screenshot A')
      expect((blocks[2] as { text: string }).text).toBe('Screenshot B')
      expect((blocks[4] as { text: string }).text).toContain('Binary content (text/plain')
      expect((blocks[4] as { text: string }).text).toContain('saved to')
    } finally {
      if (prevConfigDir !== undefined) {
        process.env.CLAUDE_CONFIG_DIR = prevConfigDir
      } else {
        delete process.env.CLAUDE_CONFIG_DIR
      }
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  test('bounds text summaries by a shared budget instead of per block', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')
    const { persistTextFromImageContent } = await import('./client.js')
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-persist-budget-test-'))
    const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir

    try {
      // Many small text blocks that individually stay under any per-block cap.
      const blocks = [
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'a' } },
        ...Array.from({ length: 50 }, (_, i) => ({
          type: 'text' as const,
          text: `caption ${i}: ${'x'.repeat(100)}`,
        })),
      ]

      const result = await persistTextFromImageContent(blocks, 'test-server', 'test-tool')

      expect(result).not.toBeNull()
      const kept = result as Array<{ type: string; text?: string }>
      const keptText = kept.filter(block => block.type === 'text').map(block => block.text ?? '')
      const summaryChars = keptText
        .filter(text => !text.includes('saved to'))
        .join('').length
      // Summaries share one budget instead of 50 × 100 chars, and the total
      // never exceeds the hard cap even when short blocks stack up.
      expect(summaryChars).toBeLessThan(50 * 100)
      expect(summaryChars).toBeLessThanOrEqual(2000)
      expect(summaryChars).toBeGreaterThan(0)
      expect(keptText.some(text => text.includes('saved to'))).toBe(true)
    } finally {
      if (prevConfigDir !== undefined) {
        process.env.CLAUDE_CONFIG_DIR = prevConfigDir
      } else {
        delete process.env.CLAUDE_CONFIG_DIR
      }
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  test('bounds the total even for many 199-char short blocks', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')
    const { persistTextFromImageContent } = await import('./client.js')
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-persist-hardcap-test-'))
    const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir

    try {
      const blocks = Array.from({ length: 11 }, (_, i) => ({
        type: 'text' as const,
        text: `block ${i}: ${'x'.repeat(189)}`,
      }))

      const result = await persistTextFromImageContent(blocks, 'test-server', 'test-tool')

      expect(result).not.toBeNull()
      const kept = result as Array<{ type: string; text?: string }>
      const keptText = kept.filter(block => block.type === 'text').map(block => block.text ?? '')
      const summaryChars = keptText.filter(text => !text.includes('saved to')).join('').length
      expect(summaryChars).toBeLessThanOrEqual(2000)
      expect(keptText.some(text => text.includes('saved to'))).toBe(true)
    } finally {
      if (prevConfigDir !== undefined) {
        process.env.CLAUDE_CONFIG_DIR = prevConfigDir
      } else {
        delete process.env.CLAUDE_CONFIG_DIR
      }
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  test('keeps the caption after an image even when short logs exhaust the budget', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')
    const { persistTextFromImageContent } = await import('./client.js')
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-persist-caption-priority-test-'))
    const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir

    try {
      const blocks = [
        ...Array.from({ length: 11 }, (_, i) => ({
          type: 'text' as const,
          text: `log ${i}: ${'x'.repeat(180)}`,
        })),
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'a' } },
        { type: 'text' as const, text: '这是上图的说明' },
      ]

      const result = await persistTextFromImageContent(blocks, 'test-server', 'test-tool')

      expect(result).not.toBeNull()
      const kept = result as Array<{ type: string; text?: string }>
      const keptText = kept.filter(block => block.type === 'text').map(block => block.text ?? '')
      // The caption after the image survives in full while the log lines are
      // truncated, and the total stays within the hard budget.
      expect(keptText).toContain('这是上图的说明')
      const summaryChars = keptText.filter(text => !text.includes('saved to')).join('').length
      expect(summaryChars).toBeLessThanOrEqual(2000)
    } finally {
      if (prevConfigDir !== undefined) {
        process.env.CLAUDE_CONFIG_DIR = prevConfigDir
      } else {
        delete process.env.CLAUDE_CONFIG_DIR
      }
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  test('keeps every caption when several follow media blocks', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')
    const { persistTextFromImageContent } = await import('./client.js')
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-persist-multi-caption-test-'))
    const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir

    try {
      const blocks = [
        { type: 'text' as const, text: `ordinary log ${'x'.repeat(2000)}` },
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'a' } },
        { type: 'text' as const, text: `caption one ${'y'.repeat(140)}` },
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'b' } },
        { type: 'text' as const, text: `caption two ${'z'.repeat(140)}` },
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'c' } },
        { type: 'text' as const, text: `caption three ${'w'.repeat(140)}` },
      ]

      const result = await persistTextFromImageContent(blocks, 'test-server', 'test-tool')

      expect(result).not.toBeNull()
      const kept = result as Array<{ type: string; text?: string }>
      const keptText = kept.filter(block => block.type === 'text').map(block => block.text ?? '')
      // All three captions survive; the ordinary log is truncated to what the
      // captions leave of the shared budget, and the total stays capped.
      expect(keptText).toContain(`caption one ${'y'.repeat(140)}`)
      expect(keptText).toContain(`caption two ${'z'.repeat(140)}`)
      expect(keptText).toContain(`caption three ${'w'.repeat(140)}`)
      const summaryChars = keptText.filter(text => !text.includes('saved to')).join('').length
      expect(summaryChars).toBeLessThanOrEqual(2000)
    } finally {
      if (prevConfigDir !== undefined) {
        process.env.CLAUDE_CONFIG_DIR = prevConfigDir
      } else {
        delete process.env.CLAUDE_CONFIG_DIR
      }
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  test('keeps short captions whole when a long block dominates the budget', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')
    const { persistTextFromImageContent } = await import('./client.js')
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-persist-caption-test-'))
    const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir

    try {
      const blocks = [
        { type: 'text' as const, text: `log line ${'x'.repeat(3000)}` },
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'a' } },
        { type: 'text' as const, text: '上图是登录页面' },
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: 'b' } },
        { type: 'text' as const, text: '上图是支付失败弹窗' },
      ]

      const result = await persistTextFromImageContent(blocks, 'test-server', 'test-tool')

      expect(result).not.toBeNull()
      const kept = result as Array<{ type: string; text?: string }>
      const keptText = kept.filter(block => block.type === 'text').map(block => block.text ?? '')
      // The long log block is truncated to the shared budget, but the short
      // captions after the images survive in full — they are not starved.
      expect(keptText).toContain('上图是登录页面')
      expect(keptText).toContain('上图是支付失败弹窗')
      const logSummary = keptText.find(text => text.startsWith('log line'))
      expect(logSummary?.length ?? 0).toBeLessThan(3000)
      expect(keptText.some(text => text.includes('saved to'))).toBe(true)
    } finally {
      if (prevConfigDir !== undefined) {
        process.env.CLAUDE_CONFIG_DIR = prevConfigDir
      } else {
        delete process.env.CLAUDE_CONFIG_DIR
      }
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })

  test('parallel invocations of the same server/tool persist to distinct files', async () => {
    const fs = await import('fs/promises')
    const os = await import('os')
    const path = await import('path')
    const { persistTextFromImageContent } = await import('./client.js')
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-persist-collision-test-'))
    const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tmpDir

    const originalNow = Date.now
    Date.now = () => 123456789

    try {
      // Same server, same tool, frozen clock: the persistence id must still
      // be unique per invocation — persistToolResult treats an existing file
      // ('wx') as a replay of the same invocation, so a timestamp-only id
      // would make the second call report its own preview while the file
      // holds the first call's content.
      const [resultA, resultB] = await Promise.all([
        persistTextFromImageContent([
          { type: 'text' as const, text: 'AAAA'.repeat(500) },
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'a' } },
        ], 'test-server', 'test-tool'),
        persistTextFromImageContent([
          { type: 'text' as const, text: 'BBBB'.repeat(500) },
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: 'b' } },
        ], 'test-server', 'test-tool'),
      ])

      expect(resultA).not.toBeNull()
      expect(resultB).not.toBeNull()
      const savedPathA = (resultA as Array<{ type: string; text: string }>)
        .find(block => block.type === 'text' && block.text.includes('saved to'))?.text.match(/saved to (.+)/)?.[1]
      const savedPathB = (resultB as Array<{ type: string; text: string }>)
        .find(block => block.type === 'text' && block.text.includes('saved to'))?.text.match(/saved to (.+)/)?.[1]
      expect(savedPathA).toBeDefined()
      expect(savedPathB).toBeDefined()
      expect(savedPathA).not.toBe(savedPathB)
      // Each file holds its own call's content, not the other call's.
      expect(await fs.readFile(savedPathA!, 'utf-8')).toContain('AAAA')
      expect(await fs.readFile(savedPathB!, 'utf-8')).toContain('BBBB')
      expect(await fs.readFile(savedPathA!, 'utf-8')).not.toContain('BBBB')
      expect(await fs.readFile(savedPathB!, 'utf-8')).not.toContain('AAAA')
    } finally {
      Date.now = originalNow
      if (prevConfigDir !== undefined) {
        process.env.CLAUDE_CONFIG_DIR = prevConfigDir
      } else {
        delete process.env.CLAUDE_CONFIG_DIR
      }
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})
