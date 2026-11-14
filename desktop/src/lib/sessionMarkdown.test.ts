import { describe, expect, it, vi } from 'vitest'
import type { MessageEntry } from '@/types/session'
import { buildSessionMarkdown, downloadTextFile, isCompleteSessionHistory, sanitizeSessionFilename } from './sessionMarkdown'

const message = (overrides: Partial<MessageEntry>): MessageEntry => ({
  id: 'message', type: 'user', content: '', timestamp: '2026-01-01T00:00:00.000Z', ...overrides,
})

describe('sessionMarkdown', () => {
  it('renders messages in API order and preserves structured content', () => {
    const markdown = buildSessionMarkdown('A session', {
      messages: [
        message({ type: 'user', content: 'Please inspect this.' }),
        message({ type: 'assistant', content: [{ type: 'text', text: 'Done.' }] }),
        message({ type: 'tool_use', content: { command: 'pwd' }, toolUseResult: 'ok' }),
      ],
    })
    expect(markdown).toContain('# A session')
    expect(markdown.indexOf('Please inspect this.')).toBeLessThan(markdown.indexOf('Done.'))
    expect(markdown).toContain('```json\n{\n  "command": "pwd"\n}')
    expect(markdown).toContain('ok')
  })

  it('rejects incomplete history evidence', () => {
    expect(isCompleteSessionHistory({ messages: [], page: undefined })).toBe(true)
    expect(isCompleteSessionHistory({ messages: [], page: { historyComplete: false, contentTruncated: false, omittedOversizedEntries: 0 } })).toBe(false)
    expect(isCompleteSessionHistory({ messages: [], page: { historyComplete: true, contentTruncated: true, omittedOversizedEntries: 0 } })).toBe(false)
    expect(isCompleteSessionHistory({ messages: [], page: { historyComplete: true, contentTruncated: false, omittedOversizedEntries: 1 } })).toBe(false)
  })

  it('creates a safe Markdown filename', () => {
    expect(sanitizeSessionFilename('  report: Q4 / final?.  ')).toBe('report- Q4 - final-.md')
    expect(sanitizeSessionFilename('...')).toBe('session.md')
  })

  it('starts a browser download and revokes its object URL later', () => {
    const originalDocument = globalThis.document
    const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    const createObjectURL = vi.fn(() => 'blob:session')
    const revokeObjectURL = vi.fn()
    const click = vi.fn()
    const anchor = { href: '', download: '', click, remove: vi.fn() }
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: vi.fn(() => anchor), body: { appendChild: vi.fn() }, querySelector: vi.fn(() => null) },
    })
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    vi.useFakeTimers()
    downloadTextFile('# Test\n', 'test.md')
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(click).toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:session')
    vi.useRealTimers()
    if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL)
    else Reflect.deleteProperty(URL, 'createObjectURL')
    if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL)
    else Reflect.deleteProperty(URL, 'revokeObjectURL')
    if (originalDocument) Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
    else Reflect.deleteProperty(globalThis, 'document')
  })
})
