import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promptHistoryApi, type PromptHistoryItem } from '@/api/promptHistory'
import type { ComposerMention } from '@/lib/composerMentions'
import type { UIMessage } from '@/types/chat'
import {
  clearComposerPromptHistoryCacheForTesting,
  extractSessionPromptHistory,
  mergePromptHistoryEntries,
  useComposerPromptHistory,
  type PromptHistoryEntry,
} from './useComposerPromptHistory'

vi.mock('@/api/promptHistory', () => ({
  promptHistoryApi: {
    list: vi.fn(async () => ({ entries: [] })),
    append: vi.fn(async () => ({ ok: true })),
  },
}))

const listMock = vi.mocked(promptHistoryApi.list)
const appendMock = vi.mocked(promptHistoryApi.append)

describe('extractSessionPromptHistory', () => {
  it('extracts human user_text turns newest-first and skips teammate/scheduled/collaboration/attachment-only messages', () => {
    const messages: UIMessage[] = [
      { id: '1', type: 'user_text', content: 'first prompt', timestamp: 1 },
      { id: '2', type: 'assistant_text', content: 'reply', timestamp: 2 },
      { id: '3', type: 'user_text', content: 'teammate task', teammateFrom: 'lead', timestamp: 3 },
      { id: '4', type: 'user_text', content: 'scheduled prompt', scheduledTask: { runId: 'r1', taskId: 't1', taskName: 'cron', scheduledFor: '2026-11-20T00:00:00Z' }, timestamp: 4 },
      { id: '5', type: 'user_text', content: 'collab prompt', collaboration: { sourceSessionId: 's-other' }, timestamp: 5 },
      { id: '6', type: 'user_text', content: '', modelContent: '@"/repo/a.ts" Please analyze the attached files.', timestamp: 6 },
      { id: '7', type: 'user_text', content: 'second prompt', timestamp: 7 },
      { id: '8', type: 'user_text', content: 'second prompt', timestamp: 8 },
      { id: '9', type: 'user_text', content: 'third prompt\nline two', timestamp: 9 },
    ]

    const entries = extractSessionPromptHistory(messages)
    expect(entries.map((entry) => entry.text)).toEqual([
      'third prompt\nline two',
      'second prompt',
      'first prompt',
    ])
  })

  it('preserves @file display mentions for live turns instead of leaking modelContent absolute paths', () => {
    const messages: UIMessage[] = [
      {
        id: 'm1',
        type: 'user_text',
        content: '@App.tsx explain this',
        modelContent: '@"/repo/src/App.tsx" explain this',
        timestamp: 1,
      },
      {
        id: 'm2',
        type: 'user_text',
        content: 'Explain @App.tsx please',
        modelContent: 'Explain @"/repo/src/App.tsx" please',
        timestamp: 2,
      },
    ]

    const entries = extractSessionPromptHistory(messages)
    expect(entries.map((entry) => entry.text)).toEqual([
      'Explain @App.tsx please',
      '@App.tsx explain this',
    ])
  })
})

describe('mergePromptHistoryEntries', () => {
  it('prioritizes current session ahead of other sessions without duplicating turns across sources', () => {
    const merged = mergePromptHistoryEntries({
      sessionId: 'sess-1',
      localSessionEntries: [{ text: 'latest live' }],
      transcriptEntries: [{ text: 'latest live' }, { text: 'earlier in session' }],
      localProjectEntries: [{ text: 'latest live' }, { text: 'from sibling tab' }],
      serverEntries: [
        { display: 'latest live', timestamp: 40, sessionId: 'sess-1' },
        { display: 'earlier in session', timestamp: 30, sessionId: 'sess-1' },
        { display: 'windowed older turn in sess-1', timestamp: 20, sessionId: 'sess-1' },
        { display: 'from sibling tab', timestamp: 15, sessionId: 'sess-2' },
        { display: 'from tui session', timestamp: 10, sessionId: 'tui-1' },
      ],
      includeProjectHistory: true,
    })

    expect(merged.map((entry) => entry.text)).toEqual([
      'latest live',
      'earlier in session',
      'windowed older turn in sess-1',
      'from sibling tab',
      'from tui session',
    ])
  })

  it('does not create out-of-order ghost duplicates when the user sent consecutive identical prompts', () => {
    const merged = mergePromptHistoryEntries({
      sessionId: 'sess-1',
      localSessionEntries: [{ text: 'continue' }, { text: 'fix bug' }],
      transcriptEntries: [{ text: 'continue' }, { text: 'fix bug' }],
      localProjectEntries: [],
      serverEntries: [
        { display: 'continue', timestamp: 30, sessionId: 'sess-1' },
        { display: 'continue', timestamp: 20, sessionId: 'sess-1' },
        { display: 'fix bug', timestamp: 10, sessionId: 'sess-1' },
      ],
      includeProjectHistory: true,
    })

    expect(merged.map((entry) => entry.text)).toEqual(['continue', 'fix bug'])
  })

  it('deduplicates leading whitespace and upgrades reloaded serialized/stripped @file turns from history.jsonl', () => {
    const merged = mergePromptHistoryEntries({
      sessionId: 'sess-1',
      localSessionEntries: [{ text: '  check tests' }],
      transcriptEntries: [
        { text: 'check tests' },
        { text: 'Explain @"/repo/src/App.tsx" please' },
        { text: 'explain this' },
      ],
      localProjectEntries: [],
      serverEntries: [
        { display: 'check tests', timestamp: 30, sessionId: 'sess-1' },
        { display: 'Explain @App.tsx please', timestamp: 20, sessionId: 'sess-1' },
        { display: '@App.tsx explain this', timestamp: 10, sessionId: 'sess-1' },
      ],
      includeProjectHistory: true,
    })

    expect(merged.map((entry) => entry.text)).toEqual([
      'check tests',
      'Explain @App.tsx please',
      '@App.tsx explain this',
    ])
  })

  it('excludes cross-session project entries when includeProjectHistory is false', () => {
    const merged = mergePromptHistoryEntries({
      sessionId: 'member-1',
      localSessionEntries: [],
      transcriptEntries: [{ text: 'member turn' }],
      localProjectEntries: [{ text: 'lead prompt' }],
      serverEntries: [{ display: 'lead prompt', timestamp: 10, sessionId: 'lead-1' }],
      includeProjectHistory: false,
    })

    expect(merged.map((entry) => entry.text)).toEqual(['member turn'])
  })
})

describe('useComposerPromptHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearComposerPromptHistoryCacheForTesting()
    listMock.mockResolvedValue({ entries: [] })
    appendMock.mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    clearComposerPromptHistoryCacheForTesting()
  })

  it('cycles Up/Down through session history, preserves draft with mentions, and places caret at start on Up and end on Down', () => {
    const draftMention: ComposerMention = {
      label: 'App.tsx',
      path: '/repo/src/App.tsx',
      isDirectory: false,
      tokenOrdinal: 0,
    }
    let currentDraft: PromptHistoryEntry = { text: 'check @App.tsx', mentions: [draftMention] }
    const applied: Array<{ entry: PromptHistoryEntry; cursor: 'start' | 'end' }> = []

    const { result } = renderHook(() =>
      useComposerPromptHistory({
        sessionId: 'sess-1',
        projectPath: '/repo',
        sessionEntries: [
          { text: 'latest\nmultiline' },
          { text: 'older prompt' },
        ],
        getCurrentDraft: () => currentDraft,
        applyEntry: (entry, cursor) => {
          currentDraft = entry
          applied.push({ entry, cursor })
        },
      }),
    )

    expect(result.current.isNavigating()).toBe(false)
    // Pressing Down while not navigating does nothing.
    expect(result.current.onHistoryDown()).toBe(false)

    act(() => {
      expect(result.current.onHistoryUp()).toBe(true)
    })
    expect(result.current.isNavigating()).toBe(true)
    expect(applied[0]).toEqual({ entry: { text: 'latest\nmultiline' }, cursor: 'start' })

    act(() => {
      expect(result.current.onHistoryUp()).toBe(true)
    })
    expect(applied[1]).toEqual({ entry: { text: 'older prompt' }, cursor: 'start' })

    // Stepping Down places caret at end.
    act(() => {
      expect(result.current.onHistoryDown()).toBe(true)
    })
    expect(applied[2]).toEqual({ entry: { text: 'latest\nmultiline' }, cursor: 'end' })

    // Stepping Down back to 0 restores the draft with its mention pill.
    act(() => {
      expect(result.current.onHistoryDown()).toBe(true)
    })
    expect(result.current.isNavigating()).toBe(false)
    expect(applied[3]).toEqual({
      entry: { text: 'check @App.tsx', mentions: [draftMention] },
      cursor: 'end',
    })
  })

  it('loads project history lazily on first ArrowUp and handles rapid presses before fetch resolves', async () => {
    let resolveServer!: (value: { entries: PromptHistoryItem[] }) => void
    listMock.mockImplementationOnce(() => new Promise((resolve) => { resolveServer = resolve }))

    let currentDraft: PromptHistoryEntry = { text: '' }
    const applied: Array<{ entry: PromptHistoryEntry; cursor: 'start' | 'end' }> = []

    const { result } = renderHook(() =>
      useComposerPromptHistory({
        sessionId: null,
        projectPath: '/repo/app',
        getCurrentDraft: () => currentDraft,
        applyEntry: (entry, cursor) => {
          currentDraft = entry
          applied.push({ entry, cursor })
        },
      }),
    )

    // Lazy: does not fetch until ArrowUp is pressed.
    expect(listMock).not.toHaveBeenCalled()

    act(() => {
      expect(result.current.onHistoryUp()).toBe(true)
      expect(result.current.onHistoryUp()).toBe(true)
    })
    // Deduplicated to one server request despite two rapid presses.
    expect(listMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveServer({
        entries: [
          { display: 'newest from tui', timestamp: 20, sessionId: 'tui-1' },
          { display: 'older from tui', timestamp: 10, sessionId: 'tui-1' },
        ],
      })
    })

    await waitFor(() => {
      expect(currentDraft.text).toBe('older from tui')
    })
    expect(applied[applied.length - 1]).toEqual({
      entry: { text: 'older from tui' },
      cursor: 'start',
    })
  })

  it('ignores in-flight slow-path fetch if the user starts typing before it resolves', async () => {
    let resolveServer!: (value: { entries: PromptHistoryItem[] }) => void
    listMock.mockImplementationOnce(() => new Promise((resolve) => { resolveServer = resolve }))

    let currentDraft: PromptHistoryEntry = { text: '' }
    const applyEntry = vi.fn((entry: PromptHistoryEntry) => {
      currentDraft = entry
    })

    const { result } = renderHook(() =>
      useComposerPromptHistory({
        sessionId: null,
        projectPath: '/repo/app',
        getCurrentDraft: () => currentDraft,
        applyEntry,
      }),
    )

    act(() => {
      result.current.onHistoryUp()
    })

    // User begins typing before the fetch resolves -> resetHistory cancels slow apply.
    act(() => {
      currentDraft = { text: 'fresh input' }
      result.current.resetHistory()
    })

    await act(async () => {
      resolveServer({
        entries: [{ display: 'stale history item', timestamp: 10, sessionId: 'tui-1' }],
      })
    })

    expect(applyEntry).not.toHaveBeenCalled()
    expect(currentDraft.text).toBe('fresh input')
  })

  it('records submissions locally for immediate recall and persists to server API', () => {
    let currentDraft: PromptHistoryEntry = { text: '' }
    const applyEntry = vi.fn((entry: PromptHistoryEntry) => {
      currentDraft = entry
    })

    const { result } = renderHook(() =>
      useComposerPromptHistory({
        sessionId: 'sess-live',
        projectPath: '/repo/app',
        getCurrentDraft: () => currentDraft,
        applyEntry,
      }),
    )

    act(() => {
      result.current.recordSubmission({ text: 'just sent prompt' })
    })

    expect(appendMock).toHaveBeenCalledWith({
      display: 'just sent prompt',
      project: '/repo/app',
      sessionId: 'sess-live',
    })

    act(() => {
      expect(result.current.onHistoryUp()).toBe(true)
    })
    expect(currentDraft.text).toBe('just sent prompt')
  })

  it('keeps member/subagent submissions isolated from project cache and global history.jsonl', () => {
    let currentDraft: PromptHistoryEntry = { text: '' }
    const { result: memberHook } = renderHook(() =>
      useComposerPromptHistory({
        sessionId: 'member-tab-1',
        projectPath: '/repo/app',
        includeProjectHistory: false,
        getCurrentDraft: () => currentDraft,
        applyEntry: (entry) => { currentDraft = entry },
      }),
    )

    act(() => {
      memberHook.current.recordSubmission({ text: 'private teammate note' })
    })

    expect(appendMock).not.toHaveBeenCalled()

    // A regular session in the same project must not see the member's prompt.
    let projectDraft: PromptHistoryEntry = { text: '' }
    const projectApply = vi.fn((entry: PromptHistoryEntry) => { projectDraft = entry })
    const { result: projectHook } = renderHook(() =>
      useComposerPromptHistory({
        sessionId: 'lead-1',
        projectPath: '/repo/app',
        includeProjectHistory: true,
        getCurrentDraft: () => projectDraft,
        applyEntry: projectApply,
      }),
    )

    act(() => {
      projectHook.current.onHistoryUp()
    })
    expect(projectApply).not.toHaveBeenCalled()
  })

  it('does not fetch unscoped history when neither sessionId nor projectPath is set', () => {
    let currentDraft: PromptHistoryEntry = { text: '' }
    const { result } = renderHook(() =>
      useComposerPromptHistory({
        sessionId: null,
        projectPath: null,
        projectRoot: null,
        getCurrentDraft: () => currentDraft,
        applyEntry: (entry) => { currentDraft = entry },
      }),
    )

    act(() => {
      expect(result.current.onHistoryUp()).toBe(false)
    })
    expect(listMock).not.toHaveBeenCalled()
  })

  it('retries server fetch after a transient failure instead of permanently negative-caching', async () => {
    listMock
      .mockRejectedValueOnce(new Error('temporary 503'))
      .mockResolvedValueOnce({
        entries: [{ display: 'recovered prompt', timestamp: 10, sessionId: 'prev-1' }],
      })

    let currentDraft: PromptHistoryEntry = { text: '' }
    const { result } = renderHook(() =>
      useComposerPromptHistory({
        sessionId: null,
        projectPath: '/repo/app',
        getCurrentDraft: () => currentDraft,
        applyEntry: (entry) => { currentDraft = entry },
      }),
    )

    await act(async () => {
      result.current.onHistoryUp()
      await Promise.resolve()
    })
    expect(currentDraft.text).toBe('')

    await act(async () => {
      result.current.onHistoryUp()
    })
    await waitFor(() => {
      expect(currentDraft.text).toBe('recovered prompt')
    })
    expect(listMock).toHaveBeenCalledTimes(2)
  })

  it('steps down immediately without stalling after pressing ArrowUp into a pending slow fetch', () => {
    listMock.mockImplementationOnce(() => new Promise(() => {}))

    let currentDraft: PromptHistoryEntry = { text: '' }
    const { result } = renderHook(() =>
      useComposerPromptHistory({
        sessionId: 'sess-1',
        projectPath: '/repo/app',
        sessionEntries: [{ text: 'turn 2' }, { text: 'turn 1' }],
        getCurrentDraft: () => currentDraft,
        applyEntry: (entry) => { currentDraft = entry },
      }),
    )

    act(() => {
      result.current.onHistoryUp() // -> turn 2
      result.current.onHistoryUp() // -> turn 1
      result.current.onHistoryUp() // -> slow path past local entries
    })
    expect(currentDraft.text).toBe('turn 1')

    // First ArrowDown immediately steps back to 'turn 2' instead of re-applying 'turn 1'.
    act(() => {
      expect(result.current.onHistoryDown()).toBe(true)
    })
    expect(currentDraft.text).toBe('turn 2')
  })
})
