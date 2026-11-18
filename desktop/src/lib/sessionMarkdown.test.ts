import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionHistoryPage } from '@/api/sessions'
import type { TranslationKey } from '@/i18n'
import type { MessageEntry } from '@/types/session'
import {
  buildSessionMarkdown,
  downloadTextFile,
  isCompleteSessionHistory,
  runSessionMarkdownAction,
  sanitizeSessionFilename,
} from './sessionMarkdown'

const mocks = vi.hoisted(() => ({
  getFullHistory: vi.fn<(sessionId: string) => Promise<SessionHistoryPage>>(),
  copyTextToClipboard: vi.fn<(text: string) => Promise<boolean>>(),
}))

vi.mock('@/api/sessions', () => ({
  sessionsApi: { getFullHistory: mocks.getFullHistory },
}))

vi.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: mocks.copyTextToClipboard,
}))

const translations: Partial<Record<TranslationKey, string>> = {
  'tabs.untitled': 'Untitled',
  'sidebar.markdownCopied': 'Markdown copied.',
  'sidebar.markdownExported': 'Markdown exported.',
  'sidebar.markdownCopyFailed': 'Could not copy Markdown.',
  'sidebar.markdownExportFailed': 'Could not export Markdown.',
  'sidebar.markdownHistoryIncomplete': 'The session history is incomplete, so Markdown was not created.',
}

const t = (key: TranslationKey): string => translations[key] ?? key

const message = (overrides: Partial<MessageEntry> & { role?: string }): MessageEntry => ({
  id: 'message',
  type: 'user',
  content: '',
  timestamp: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const completePage: NonNullable<SessionHistoryPage['page']> = {
  nextCursor: null,
  hasMore: false,
  contentTruncated: false,
  historyComplete: true,
  sourceVersion: 'v1',
  scannedBytes: 128,
  omittedOversizedEntries: 0,
}

beforeEach(() => {
  mocks.getFullHistory.mockReset()
  mocks.copyTextToClipboard.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('sessionMarkdown', () => {
  it('renders messages in API order, formats headings, and preserves structured content', () => {
    const markdown = buildSessionMarkdown('A session', {
      messages: [
        message({ type: 'user', content: 'Please inspect this.' }),
        message({ type: 'assistant', content: [{ type: 'text', text: 'Done.' }] }),
        message({ type: 'system', content: 'System checkpoint', timestamp: '' }),
        message({ type: 'tool_use', content: { command: 'pwd' }, toolUseResult: 'ok' }),
      ],
    })
    expect(markdown).toContain('# A session')
    expect(markdown.indexOf('Please inspect this.')).toBeLessThan(markdown.indexOf('Done.'))
    expect(markdown).toContain('## System\n\nSystem checkpoint')
    expect(markdown).toContain('## Tool use · 2026-01-01T00:00:00.000Z')
    expect(markdown).toContain('```json\n{\n  "command": "pwd"\n}')
    expect(markdown).toContain('ok')
  })

  it('uses Untitled session fallback and handles primitive, null, and wrapper content cleanly', () => {
    const markdown = buildSessionMarkdown('   ', {
      messages: [
        message({ type: 'user', content: null }),
        message({ type: 'assistant', content: 42 }),
        message({ type: 'assistant', content: { content: [{ type: 'text', text: 'Unwrapped reply' }], status: 'completed' } }),
        message({ type: 'assistant', content: { file_path: '/src/a.ts', content: 'const x = 1' } }),
      ],
    })
    expect(markdown).toContain('# Untitled session')
    expect(markdown).toContain('## User · 2026-01-01T00:00:00.000Z\n\n## Assistant')
    expect(markdown).toContain('42')
    expect(markdown).toContain('Unwrapped reply')
    expect(markdown).toContain('"file_path": "/src/a.ts"')
    expect(markdown).toContain('"content": "const x = 1"')
  })

  it('formats thinking and redacted_thinking blocks without leaking signatures or binary blobs', () => {
    const markdown = buildSessionMarkdown('Reasoning session', {
      messages: [
        message({
          type: 'tool_use',
          content: [
            { type: 'thinking', thinking: '  Check working directory first.  ', signature: 'secret-signature-xyz' },
            { type: 'thinking', thinking: '   ', signature: 'blank-thinking-sig' },
            { type: 'redacted_thinking', data: 'encrypted-redacted-blob' },
            { type: 'text', text: 'Running command now.' },
            { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'pwd' } },
            { type: 'tool_use', id: 'toolu_02', name: 'Ping' },
          ],
        }),
        message({
          type: 'tool_use',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_03', name: 'Ls', input: { path: '.' } }],
        }),
      ],
    })

    expect(markdown).toContain('## Assistant · 2026-01-01T00:00:00.000Z')
    expect(markdown).toContain('<details>\n<summary>Thinking</summary>\n\nCheck working directory first.\n\n</details>')
    expect(markdown).toContain('_[Redacted thinking]_')
    expect(markdown).toContain('Running command now.')
    expect(markdown).toContain('**Tool use: `Bash`**\n\n```json\n{\n  "command": "pwd"\n}\n```')
    expect(markdown).toContain('**Tool use: `Ping`**')
    expect(markdown).toContain('**Tool use: `Ls`**')
    expect(markdown).not.toContain('secret-signature-xyz')
    expect(markdown).not.toContain('blank-thinking-sig')
    expect(markdown).not.toContain('encrypted-redacted-blob')
    expect(markdown).not.toContain('toolu_01')
  })

  it('replaces base64 media and document payloads with concise placeholders instead of raw base64', () => {
    const rawPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const rawPdfBase64 = 'JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyA+PgplbmRvYmoK'
    const markdown = buildSessionMarkdown('Media session', {
      messages: [
        message({
          type: 'user',
          content: [
            { type: 'text', text: 'Inspect these attachments:' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: rawPngBase64 } },
            { type: 'image' },
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: rawPdfBase64 } },
            { type: 'audio', media_type: 'audio/wav' },
            { type: 'video' },
            { source: { type: 'base64', media_type: 'application/octet-stream', data: 'YWJjMTIz' } },
          ],
        }),
        message({
          type: 'assistant',
          content: {
            preview: `data:image/jpeg;base64,${rawPngBase64}`,
            nested: { base64: rawPdfBase64, signature: 'sig-nested', redacted: { type: 'redacted_thinking', data: 'blob-nested' } },
          },
        }),
      ],
    })

    expect(markdown).toContain('_[Image attachment: image/png]_')
    expect(markdown).toContain('_[Image attachment]_')
    expect(markdown).toContain('_[Document attachment: application/pdf]_')
    expect(markdown).toContain('_[Audio attachment: audio/wav]_')
    expect(markdown).toContain('_[Video attachment]_')
    expect(markdown).toContain('_[Binary attachment: application/octet-stream]_')
    expect(markdown).toContain('[base64 image/jpeg omitted]')
    expect(markdown).not.toContain(rawPngBase64)
    expect(markdown).not.toContain(rawPdfBase64)
    expect(markdown).not.toContain('YWJjMTIz')
    expect(markdown).not.toContain('sig-nested')
    expect(markdown).not.toContain('blob-nested')
  })

  it('formats tool_result blocks cleanly without duplicating toolUseResult and falls back safely when content is empty', () => {
    const rawWebpBase64 = 'UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA='
    const markdown = buildSessionMarkdown('Tool results', {
      messages: [
        message({
          type: 'tool_result',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '/workspace/project' }],
          toolUseResult: { stdout: '/workspace/project', stderr: '' },
        }),
        message({
          type: 'tool_result',
          content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: 'Permission denied', is_error: true }],
          toolUseResult: 'Permission denied',
        }),
        message({
          type: 'tool_result',
          content: [{ type: 'tool_result', tool_use_id: 'tu_3', content: '', is_error: true }],
        }),
        message({
          type: 'tool_result',
          content: [{ type: 'tool_result', tool_use_id: 'tu_4', content: '' }],
          toolUseResult: { type: 'image', file: { base64: rawWebpBase64, type: 'image/webp' } },
        }),
        message({
          type: 'tool_result',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_5',
              content: [
                { type: 'text', text: 'Read screenshot' },
                { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: rawWebpBase64 } },
              ],
            },
          ],
          toolUseResult: { type: 'image', file: { base64: rawWebpBase64, type: 'image/webp' } },
        }),
      ],
    })

    expect(markdown.match(/\/workspace\/project/g)).toHaveLength(1)
    expect(markdown).not.toContain('"stdout"')
    expect(markdown).toContain('**Tool error**\n\nPermission denied')
    expect(markdown.match(/Permission denied/g)).toHaveLength(1)
    expect(markdown).toContain('## Tool result · 2026-01-01T00:00:00.000Z\n\n**Tool error**')
    expect(markdown).toContain('Read screenshot\n\n_[Image attachment: image/webp]_')
    expect(markdown).not.toContain(rawWebpBase64)
  })

  it('rejects incomplete history evidence', () => {
    expect(isCompleteSessionHistory({ messages: [], page: undefined })).toBe(true)
    expect(isCompleteSessionHistory({ messages: [], page: { historyComplete: true, contentTruncated: false, omittedOversizedEntries: 0 } })).toBe(true)
    expect(isCompleteSessionHistory({ messages: [], page: { historyComplete: false, contentTruncated: false, omittedOversizedEntries: 0 } })).toBe(false)
    expect(isCompleteSessionHistory({ messages: [], page: { historyComplete: true, hasMore: true, contentTruncated: false, omittedOversizedEntries: 0 } })).toBe(false)
    expect(isCompleteSessionHistory({ messages: [], page: { historyComplete: true, nextCursor: 'next', contentTruncated: false, omittedOversizedEntries: 0 } })).toBe(false)
    expect(isCompleteSessionHistory({ messages: [], page: { historyComplete: true, previousCursor: 'prev', contentTruncated: false, omittedOversizedEntries: 0 } })).toBe(false)
    expect(isCompleteSessionHistory({ messages: [], page: { historyComplete: true, contentTruncated: true, omittedOversizedEntries: 0 } })).toBe(false)
    expect(isCompleteSessionHistory({ messages: [], page: { historyComplete: true, contentTruncated: false, omittedOversizedEntries: 1 } })).toBe(false)
  })

  it('creates safe, bounded Markdown filenames including CJK truncation and Windows reserved names', () => {
    expect(sanitizeSessionFilename('  report: Q4 / final?.  ')).toBe('report- Q4 - final-.md')
    expect(sanitizeSessionFilename('...')).toBe('session.md')
    expect(sanitizeSessionFilename('   ')).toBe('session.md')
    expect(sanitizeSessionFilename('CON')).toBe('session-CON.md')
    expect(sanitizeSessionFilename('nul')).toBe('session-nul.md')
    expect(sanitizeSessionFilename('lpt9.log')).toBe('session-lpt9.log.md')

    const longCjkTitle = '这是一个非常长的中文会话标题用于测试文件名安全截断与多字节字符边界处理'.repeat(4)
    const cjkFilename = sanitizeSessionFilename(longCjkTitle)
    expect(cjkFilename.endsWith('.md')).toBe(true)
    const cjkStem = cjkFilename.slice(0, -3)
    expect(Array.from(cjkStem).length).toBeLessThanOrEqual(80)

    const emojiBoundary = `${'甲'.repeat(79)}😀后缀`
    const emojiFilename = sanitizeSessionFilename(emojiBoundary)
    expect(emojiFilename).toBe(`${'甲'.repeat(79)}😀.md`)
  })

  it('starts a browser download and revokes its object URL later', () => {
    const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    const createObjectURL = vi.fn(() => 'blob:session')
    const revokeObjectURL = vi.fn()
    const downloads: Array<{ href: string; download: string }> = []
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ href: this.href, download: this.download })
    })
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })

    try {
      vi.useFakeTimers()
      downloadTextFile('# Test\n', 'test.md')
      expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
      expect(downloads).toEqual([{ href: 'blob:session', download: 'test.md' }])
      vi.advanceTimersByTime(1000)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:session')
    } finally {
      clickSpy.mockRestore()
      if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL)
      else Reflect.deleteProperty(URL, 'createObjectURL')
      if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL)
      else Reflect.deleteProperty(URL, 'revokeObjectURL')
    }
  })

  it('runs copy and export actions, reports incomplete or failed runs, and deduplicates concurrent clicks per session', async () => {
    const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    const createObjectURL = vi.fn(() => 'blob:export')
    const revokeObjectURL = vi.fn()
    const downloads: Array<{ href: string; download: string }> = []
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ href: this.href, download: this.download })
    })
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    const addToast = vi.fn()

    try {
      mocks.getFullHistory.mockResolvedValueOnce({
        messages: [message({ type: 'user', content: 'Copied turn' })],
        page: completePage,
      })
      mocks.copyTextToClipboard.mockResolvedValueOnce(true)
      await expect(runSessionMarkdownAction({
        sessionId: 's-copy',
        title: 'Copy Session',
        mode: 'copy',
        addToast,
        t,
      })).resolves.toBe(true)
      expect(mocks.copyTextToClipboard).toHaveBeenCalledWith(expect.stringContaining('Copied turn'))
      expect(addToast).toHaveBeenLastCalledWith({ type: 'success', message: 'Markdown copied.' })

      mocks.getFullHistory.mockResolvedValueOnce({
        messages: [message({ type: 'assistant', content: 'Exported turn' })],
        page: completePage,
      })
      await expect(runSessionMarkdownAction({
        sessionId: 's-export',
        title: '   ',
        mode: 'export',
        addToast,
        t,
      })).resolves.toBe(true)
      expect(downloads).toEqual([{ href: 'blob:export', download: 'Untitled.md' }])
      expect(addToast).toHaveBeenLastCalledWith({ type: 'success', message: 'Markdown exported.' })

      mocks.getFullHistory.mockResolvedValueOnce({
        messages: [],
        page: { ...completePage, historyComplete: false },
      })
      await expect(runSessionMarkdownAction({
        sessionId: 's-incomplete',
        title: 'Incomplete',
        mode: 'copy',
        addToast,
        t,
      })).resolves.toBe(false)
      expect(addToast).toHaveBeenLastCalledWith({
        type: 'error',
        message: 'The session history is incomplete, so Markdown was not created.',
      })

      mocks.getFullHistory.mockResolvedValueOnce({
        messages: [message({ type: 'user', content: 'Clipboard denied' })],
        page: completePage,
      })
      mocks.copyTextToClipboard.mockResolvedValueOnce(false)
      await expect(runSessionMarkdownAction({
        sessionId: 's-copy-fail',
        title: 'Fail',
        mode: 'copy',
        addToast,
        t,
      })).resolves.toBe(false)
      expect(addToast).toHaveBeenLastCalledWith({ type: 'error', message: 'Could not copy Markdown.' })

      mocks.getFullHistory.mockRejectedValueOnce(new Error('network'))
      await expect(runSessionMarkdownAction({
        sessionId: 's-export-fail',
        title: 'Fail',
        mode: 'export',
        addToast,
        t,
      })).resolves.toBe(false)
      expect(addToast).toHaveBeenLastCalledWith({ type: 'error', message: 'Could not export Markdown.' })

      let resolvePending!: (page: SessionHistoryPage) => void
      mocks.getFullHistory.mockImplementationOnce(() => new Promise<SessionHistoryPage>((resolve) => {
        resolvePending = resolve
      }))
      mocks.copyTextToClipboard.mockResolvedValueOnce(true)

      const first = runSessionMarkdownAction({
        sessionId: 's-concurrent',
        title: 'Concurrent',
        mode: 'copy',
        addToast,
        t,
      })
      const duplicate = await runSessionMarkdownAction({
        sessionId: 's-concurrent',
        title: 'Concurrent',
        mode: 'export',
        addToast,
        t,
      })
      expect(duplicate).toBe(false)
      expect(mocks.getFullHistory).toHaveBeenCalledTimes(6)

      resolvePending({
        messages: [message({ type: 'user', content: 'Single flight' })],
        page: completePage,
      })
      await expect(first).resolves.toBe(true)

      await expect(runSessionMarkdownAction({
        sessionId: '',
        title: 'Missing id',
        mode: 'copy',
        addToast,
        t,
      })).resolves.toBe(false)
    } finally {
      clickSpy.mockRestore()
      if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL)
      else Reflect.deleteProperty(URL, 'createObjectURL')
      if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL)
      else Reflect.deleteProperty(URL, 'revokeObjectURL')
    }
  })
})
