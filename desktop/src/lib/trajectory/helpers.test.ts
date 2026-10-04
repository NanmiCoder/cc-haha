import { describe, expect, it } from 'vitest'
import { findChatRenderIndex, findChatRenderTarget } from './chatTarget'
import { attachmentText, extractDetailContent } from './detailContent'
import { diffLines, diffToolCatalogs } from './lineDiff'
import { computeFixedRowWindow, visibleRange } from './useFixedRowWindow'
import { makeRow } from './trajectoryFixtures'

describe('diffLines', () => {
  it('keeps the shared prefix and suffix and marks only the changed middle', () => {
    const diff = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne')
    expect(diff).toEqual([
      { type: 'same', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'same', text: 'c' },
      { type: 'same', text: 'd' },
      { type: 'add', text: 'e' },
    ])
  })

  it('reports nothing changed for identical text', () => {
    expect(diffLines('x\ny', 'x\ny').every((line) => line.type === 'same')).toBe(true)
  })
})

describe('diffToolCatalogs', () => {
  it('separates added, removed and changed tools by name', () => {
    const diff = diffToolCatalogs(
      [{ name: 'Bash', description: 'run' }, { name: 'Read', description: 'read' }],
      [{ name: 'Bash', description: 'run commands' }, { name: 'WebFetch', description: 'fetch' }],
    )
    expect(diff).toEqual({ added: ['WebFetch'], removed: ['Read'], changed: ['Bash'] })
  })
})

describe('visibleRange', () => {
  it('reports the rows actually on screen, without overscan', () => {
    expect(visibleRange(3000, 600, 30, 10_000)).toEqual({ first: 100, last: 119 })
    expect(visibleRange(0, 600, 30, 5)).toEqual({ first: 0, last: 4 })
  })
})

describe('computeFixedRowWindow', () => {
  it('renders the visible rows plus overscan on both sides', () => {
    expect(computeFixedRowWindow(3000, 600, 30, 10_000, 12)).toEqual({ start: 88, end: 133 })
  })

  it('clamps to the list bounds', () => {
    expect(computeFixedRowWindow(0, 600, 30, 5, 12)).toEqual({ start: 0, end: 5 })
    expect(computeFixedRowWindow(10_000, 600, 30, 0, 12)).toEqual({ start: 0, end: 0 })
  })
})

describe('findChatRenderIndex', () => {
  const items = [
    { kind: 'message' as const, message: { id: 'u-uuid', type: 'user_text' } },
    { kind: 'tool_group' as const, id: 'g1', toolCalls: [{ toolUseId: 'toolu_1' }, { toolUseId: 'ns/toolu_x', originalToolUseId: 'toolu_2' }] },
    { kind: 'message' as const, message: { id: 'live-id', type: 'assistant_text', transcriptMessageId: 'a-uuid' } },
  ]

  it('finds a tool call inside an activity group, including by its original id', () => {
    expect(findChatRenderIndex(items, { toolUseId: 'toolu_1' })).toBe(1)
    expect(findChatRenderIndex(items, { toolUseId: 'toolu_2' })).toBe(1)
  })

  it('finds a message by entry uuid or by the transcript id a live message carries', () => {
    expect(findChatRenderIndex(items, { uuids: ['u-uuid'] })).toBe(0)
    expect(findChatRenderIndex(items, { uuids: ['nope', 'a-uuid'] })).toBe(2)
  })

  it('returns -1 when the target is not loaded', () => {
    expect(findChatRenderIndex(items, { toolUseId: 'missing', uuids: ['missing'] })).toBe(-1)
  })

  it('names the call a group renders, so the caller can open the group onto that row', () => {
    expect(findChatRenderTarget(items, { toolUseId: 'toolu_1' })).toEqual({ index: 1, toolUseId: 'toolu_1' })
    // Matched by its original id, the row is still found under the id it renders with.
    expect(findChatRenderTarget(items, { toolUseId: 'toolu_2' })).toEqual({ index: 1, toolUseId: 'ns/toolu_x' })
    expect(findChatRenderTarget(items, { toolUseId: 'missing', uuids: ['u-uuid'] })).toEqual({ index: 0 })
  })
})

describe('extractDetailContent', () => {
  it('pulls the call input and the result the model saw for a tool row', () => {
    const row = makeRow({ id: 't:toolu_1', kind: 'tool', toolUseId: 'toolu_1' })
    const content = extractDetailContent(row, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'a.txt' }], is_error: false }] }, toolUseResult: { stdout: 'a.txt' } },
    ])
    expect(content.toolInput).toEqual({ command: 'ls' })
    expect(content.toolResult).toBe('a.txt')
    expect(content.toolResultStructured).toEqual({ stdout: 'a.txt' })
  })

  it('collects text, thinking and issued tool calls for an assistant row', () => {
    const row = makeRow({ id: 'a:m1', kind: 'assistant' })
    const content = extractDetailContent(row, [
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'plan' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Running it' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_9', name: 'Read', input: {} }] } },
    ])
    expect(content.thinking).toEqual(['plan'])
    expect(content.text).toBe('Running it')
    expect(content.toolUses.map((use) => use.name)).toEqual(['Read'])
  })

  it('keeps the attachment of a context row and renders its strings for preview', () => {
    const row = makeRow({ id: 'c:1', kind: 'context' })
    const attachment = { type: 'skill_listing', content: '- pdf: read PDFs', skillCount: 1 }
    const content = extractDetailContent(row, [{ type: 'attachment', attachment }])
    expect(content.attachment).toEqual(attachment)
    expect(attachmentText(content.attachment)).toBe('- pdf: read PDFs')
  })
})
