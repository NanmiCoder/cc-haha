import { describe, expect, test } from 'bun:test'
import { shrinkMediaToSizeBudget } from './claude.js'
import type { UserMessage, AssistantMessage } from '../../types/message.js'

/**
 * Helper: create a base64 image block with a payload of the given byte length.
 * Uses 'A' repeated to simulate base64 data.
 */
function makeBase64ImageBlock(sizeBytes: number) {
  return {
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: 'image/png' as const,
      data: 'A'.repeat(sizeBytes),
    },
  }
}

/** Helper: create a URL image block (zero payload, should never be removed). */
function makeURLImageBlock() {
  return {
    type: 'image' as const,
    source: {
      type: 'url' as const,
      url: 'https://example.com/image.png',
    },
  }
}

/** Helper: create a base64 PDF document block. */
function makeBase64DocBlock(sizeBytes: number) {
  return {
    type: 'document' as const,
    source: {
      type: 'base64' as const,
      media_type: 'application/pdf' as const,
      data: 'B'.repeat(sizeBytes),
    },
  }
}

/** Helper: wrap content blocks into a minimal UserMessage. */
function userMsg(content: any[]): UserMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    uuid: crypto.randomUUID() as any,
    timestamp: new Date().toISOString(),
  } as UserMessage
}

/** Helper: wrap tool_result content into a UserMessage. */
function toolResultMsg(toolUseId: string, content: any[]): UserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result' as const,
          tool_use_id: toolUseId,
          content,
        },
      ],
    },
    uuid: crypto.randomUUID() as any,
    timestamp: new Date().toISOString(),
  } as UserMessage
}

describe('shrinkMediaToSizeBudget', () => {
  test('returns messages unchanged when total media is under budget', () => {
    const messages = [
      userMsg([makeBase64ImageBlock(1000), { type: 'text', text: 'hello' }]),
      userMsg([makeBase64ImageBlock(2000)]),
    ]

    const result = shrinkMediaToSizeBudget(messages, 5000)
    expect(result).toBe(messages) // same reference, no copy
  })

  test('removes oldest base64 images first when over budget', () => {
    const messages = [
      userMsg([makeBase64ImageBlock(3000)]), // oldest — should be removed
      userMsg([makeBase64ImageBlock(3000)]), // second oldest — should be removed
      userMsg([makeBase64ImageBlock(3000)]), // newest — kept
    ]

    const result = shrinkMediaToSizeBudget(messages, 4000)

    // First two messages should have placeholder text
    const content0 = result[0].message.content as any[]
    expect(content0[0].type).toBe('text')
    expect(content0[0].text).toContain('media removed')

    const content1 = result[1].message.content as any[]
    expect(content1[0].type).toBe('text')
    expect(content1[0].text).toContain('media removed')

    // Third message (newest) should be preserved
    const content2 = result[2].message.content as any[]
    expect(content2[0].type).toBe('image')
    expect(content2[0].source.type).toBe('base64')
  })

  test('never removes URL-based images (zero payload)', () => {
    const messages = [
      userMsg([makeURLImageBlock()]),
      userMsg([makeBase64ImageBlock(5000)]),
      userMsg([makeURLImageBlock()]),
    ]

    // Budget is 3000 — only the base64 image exceeds it
    const result = shrinkMediaToSizeBudget(messages, 3000)

    // URL images untouched
    const content0 = result[0].message.content as any[]
    expect(content0[0].type).toBe('image')
    expect(content0[0].source.type).toBe('url')

    const content2 = result[2].message.content as any[]
    expect(content2[0].type).toBe('image')
    expect(content2[0].source.type).toBe('url')

    // Base64 image replaced
    const content1 = result[1].message.content as any[]
    expect(content1[0].type).toBe('text')
    expect(content1[0].text).toContain('media removed')
  })

  test('handles media nested inside tool_result blocks', () => {
    const messages = [
      toolResultMsg('tool-1', [
        makeBase64ImageBlock(4000), // oldest nested — removed
        { type: 'text', text: 'screenshot result' },
      ]),
      toolResultMsg('tool-2', [
        makeBase64ImageBlock(4000), // newer nested — kept
      ]),
    ]

    const result = shrinkMediaToSizeBudget(messages, 5000)

    // First tool_result: image replaced, text preserved
    const tr0 = (result[0].message.content as any[])[0]
    expect(tr0.type).toBe('tool_result')
    expect(tr0.content[0].type).toBe('text')
    expect(tr0.content[0].text).toContain('media removed')
    expect(tr0.content[1].type).toBe('text')
    expect(tr0.content[1].text).toBe('screenshot result')

    // Second tool_result: image preserved
    const tr1 = (result[1].message.content as any[])[0]
    expect(tr1.content[0].type).toBe('image')
  })

  test('handles mixed media types (images + documents)', () => {
    const messages = [
      userMsg([makeBase64DocBlock(5000)]),   // oldest PDF — removed
      userMsg([makeBase64ImageBlock(5000)]), // image — removed
      userMsg([makeBase64ImageBlock(3000)]), // newest — kept
    ]

    const result = shrinkMediaToSizeBudget(messages, 4000)

    const content0 = result[0].message.content as any[]
    expect(content0[0].type).toBe('text')
    expect(content0[0].text).toContain('media removed')

    const content1 = result[1].message.content as any[]
    expect(content1[0].type).toBe('text')
    expect(content1[0].text).toContain('media removed')

    const content2 = result[2].message.content as any[]
    expect(content2[0].type).toBe('image')
  })

  test('preserves non-media content blocks alongside removed media', () => {
    const messages = [
      userMsg([
        { type: 'text', text: 'before' },
        makeBase64ImageBlock(6000),
        { type: 'text', text: 'after' },
      ]),
    ]

    const result = shrinkMediaToSizeBudget(messages, 3000)

    const content = result[0].message.content as any[]
    expect(content[0]).toEqual({ type: 'text', text: 'before' })
    expect(content[1].type).toBe('text')
    expect(content[1].text).toContain('media removed')
    expect(content[2]).toEqual({ type: 'text', text: 'after' })
  })

  test('removes exactly enough to stay within budget', () => {
    const messages = [
      userMsg([makeBase64ImageBlock(2000)]), // removed (cumulative 2000 > remaining budget)
      userMsg([makeBase64ImageBlock(2000)]), // kept
      userMsg([makeBase64ImageBlock(2000)]), // kept
    ]

    // Total = 6000, budget = 4000, need to remove 2000 → remove first only
    const result = shrinkMediaToSizeBudget(messages, 4000)

    const content0 = result[0].message.content as any[]
    expect(content0[0].type).toBe('text')
    expect(content0[0].text).toContain('media removed')

    const content1 = result[1].message.content as any[]
    expect(content1[0].type).toBe('image')

    const content2 = result[2].message.content as any[]
    expect(content2[0].type).toBe('image')
  })

  test('handles string content messages gracefully (no array)', () => {
    const messages = [
      { type: 'user', message: { role: 'user', content: 'plain string' }, uuid: crypto.randomUUID(), timestamp: new Date().toISOString() } as unknown as UserMessage,
      userMsg([makeBase64ImageBlock(3000)]),
    ]

    const result = shrinkMediaToSizeBudget(messages, 5000)
    expect(result).toBe(messages) // under budget, no change
  })

  test('handles empty messages array', () => {
    const result = shrinkMediaToSizeBudget([], 5000)
    expect(result).toEqual([])
  })

  test('budget of 0 removes all base64 media', () => {
    const messages = [
      userMsg([makeBase64ImageBlock(100)]),
      userMsg([makeURLImageBlock()]),  // URL — never removed
      userMsg([makeBase64ImageBlock(200)]),
    ]

    const result = shrinkMediaToSizeBudget(messages, 0)

    const content0 = result[0].message.content as any[]
    expect(content0[0].type).toBe('text')
    expect(content0[0].text).toContain('media removed')

    // URL image is always preserved
    const content1 = result[1].message.content as any[]
    expect(content1[0].type).toBe('image')
    expect(content1[0].source.type).toBe('url')

    const content2 = result[2].message.content as any[]
    expect(content2[0].type).toBe('text')
    expect(content2[0].text).toContain('media removed')
  })
})
