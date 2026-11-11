import { describe, expect, it } from 'vitest'
import { mapHistoryMessagesToUiMessages } from '@/stores/chatStore'
import type { MessageEntry } from '@/types/session'

const timestamp = '2026-10-25T00:00:00.000Z'
const text = (id: string, content: string): MessageEntry => ({
  id, type: 'assistant', content: [{ type: 'text', text: content }], timestamp,
})

describe('chat history replay projection', () => {
  it('collapses replayed records across combined pages without merging distinct errors or changing the input', () => {
    const error = 'API Error: 429 quota exceeded'
    const olderPage: MessageEntry[] = [
      { id: 'user', type: 'user', content: 'Please continue', timestamp },
      text('error-a', error), text('error-b', error),
    ]
    const newerPage = [text('error-a', error), text('error-b', error), text('answer', 'Normal reply')]
    const history = [...olderPage, ...newerPage]
    const before = structuredClone(history)

    const mapped = mapHistoryMessagesToUiMessages(history)

    expect(mapped.map(message => message.id)).toEqual(['user', 'error-a-block-0', 'error-b-block-0', 'answer-block-0'])
    expect(mapped.filter(message => message.type === 'assistant_text' && message.content === error)).toHaveLength(2)
    expect(history).toEqual(before)
    expect(history).toHaveLength(6)
  })

  it('uses the latest mixed-block snapshot at its first position even when its projected type changes', () => {
    const latest: MessageEntry = {
      id: 'reply', type: 'tool_use', timestamp,
      content: [
        { type: 'thinking', thinking: 'Check the file first' },
        { type: 'text', text: 'Reading the file.' },
        { type: 'tool_use', id: 'read-file', name: 'Read', input: { file_path: '/fixture/file' } },
        { type: 'text', text: 'The request is ready.' },
      ],
    }
    const result: MessageEntry = {
      id: 'result', type: 'tool_result', timestamp,
      content: [{ type: 'tool_result', tool_use_id: 'read-file', content: 'File content', is_error: false }],
    }
    const mapped = mapHistoryMessagesToUiMessages([text('reply', 'Partial'), result, latest])

    expect(mapped).toMatchObject([
      { id: 'reply-block-0', type: 'thinking', content: 'Check the file first' },
      { id: 'reply-block-1', type: 'assistant_text', content: 'Reading the file.', transcriptMessageId: 'reply' },
      { id: 'reply-block-2', type: 'tool_use', toolUseId: 'read-file', input: { file_path: '/fixture/file' } },
      { id: 'reply-block-3', type: 'assistant_text', content: 'The request is ready.' },
      { id: 'result-block-0', type: 'tool_result', toolUseId: 'read-file', content: 'File content' },
    ])
    expect(new Set(mapped.map(message => message.id)).size).toBe(mapped.length)
  })

  it('keeps separate parent projections of the same UUID and their durable identities', () => {
    const projected = (parentToolUseId?: string): MessageEntry => ({
      id: 'shared-record', type: 'tool_use', timestamp, parentToolUseId,
      content: [
        { type: 'text', text: 'Checking' },
        { type: 'tool_use', id: `${parentToolUseId ?? 'root'}/read`, name: 'Read', input: {} },
      ],
    })
    const history = [projected(), projected('parent-a'), projected('parent-b'), projected('parent-a')]
    const mapped = mapHistoryMessagesToUiMessages(history)

    expect(mapped.filter(message => message.type === 'assistant_text')).toHaveLength(3)
    expect(mapped.filter(message => message.type === 'tool_use').map(message => message.parentToolUseId)).toEqual([undefined, 'parent-a', 'parent-b'])
    expect(mapped.filter(message => message.type === 'assistant_text').map(message => message.transcriptMessageId)).toEqual(['shared-record', 'shared-record', 'shared-record'])
    expect(mapped.filter(message => message.type === 'tool_use').map(message => message.toolUseId)).toEqual(['root/read', 'parent-a/read', 'parent-b/read'])
    expect(mapHistoryMessagesToUiMessages(history).map(message => message.id)).toEqual(mapped.map(message => message.id))
  })

  it('retains legacy records without durable IDs instead of collapsing their blocks', () => {
    const mapped = mapHistoryMessagesToUiMessages([
      { id: '', type: 'tool_use', timestamp, content: [{ type: 'tool_use', id: 'tool-a', name: 'Read', input: {} }] },
      { id: '', type: 'tool_use', timestamp, content: [{ type: 'tool_use', id: 'tool-b', name: 'Read', input: {} }] },
      text('', 'Repeated reply'), text('', 'Repeated reply'),
    ])

    expect(mapped).toHaveLength(4)
    expect(new Set(mapped.map(message => message.id)).size).toBe(4)
  })
})
