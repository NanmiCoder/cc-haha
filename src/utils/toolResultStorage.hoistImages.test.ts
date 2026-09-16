import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { describe, expect, test } from 'bun:test'
import { processToolResultBlock } from './toolResultStorage.js'

function makeTool() {
  return {
    name: 'test-tool',
    maxResultSizeChars: 100_000,
    mapToolResultToToolResultBlockParam: (result: ToolResultBlockParam) => result,
  }
}

describe('tool result media preservation', () => {
  test('keeps mixed media ordering and tool ownership inside tool_result', async () => {
    const result: ToolResultBlockParam = {
      type: 'tool_result',
      tool_use_id: 'tool-a',
      content: [
        { type: 'text', text: 'before' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } },
        { type: 'text', text: 'after' },
      ],
    }

    const processed = await processToolResultBlock(makeTool(), result, 'tool-a')

    expect(processed).toEqual(result)
    expect((processed.content as Array<{ type: string }>).map(block => block.type)).toEqual([
      'text',
      'image',
      'text',
    ])
  })

  test('keeps parallel tool results as separate blocks with stable ids', async () => {
    const results: ToolResultBlockParam[] = [
      {
        type: 'tool_result',
        tool_use_id: 'tool-a',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a' } }],
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-b',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'b' } }],
      },
    ]

    const processed = await Promise.all(
      results.map(result => processToolResultBlock(makeTool(), result, result.tool_use_id)),
    )

    expect(processed.map(result => result.tool_use_id)).toEqual(['tool-a', 'tool-b'])
    expect(
      processed.map(result => (result.content as Array<{ type: string }>)[0].type),
    ).toEqual(['image', 'image'])
  })

  test('keeps error tool results in their original shape', async () => {
    const result: ToolResultBlockParam = {
      type: 'tool_result',
      tool_use_id: 'tool-error',
      is_error: true,
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'error' } }],
    }

    const processed = await processToolResultBlock(makeTool(), result, 'tool-error')

    expect(processed.is_error).toBe(true)
    expect(processed.content).toHaveLength(1)
    expect((processed.content as Array<{ type: string }>)[0].type).toBe('image')
  })

  test('keeps document blocks alongside images', async () => {
    const result: ToolResultBlockParam = {
      type: 'tool_result',
      tool_use_id: 'tool-document',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'pdf' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'image' } },
      ],
    }

    const processed = await processToolResultBlock(makeTool(), result, 'tool-document')

    expect((processed.content as Array<{ type: string }>).map(block => block.type)).toEqual([
      'document',
      'image',
    ])
  })
})
